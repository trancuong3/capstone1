"""Repository for BookPresentationAsset, BookStyleBible, and SmartStudioJob (with graceful V2 fallback)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import desc, func, select, update
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    BookPresentationAsset,
    BookStyleBible,
    PageRevision,
    PageRevisionWord,
    Profile,
    SmartStudioJob,
)

logger = logging.getLogger(__name__)

INFLIGHT_JOB_STATUSES = (
    "QUEUED",
    "RUNNING",
    "WAITING_FOR_WORKER",
    "WAITING_FOR_QUOTA",
    "RETRY_SCHEDULED",
)

COVER_PRIORITY_RANK = {
    "USER_UPLOAD": 0,
    "AI_GENERATED": 1,
    "METADATA_RENDER": 2,
}


def is_missing_v2_table_error(exc: BaseException) -> bool:
    """Detect missing Smart Book Studio V2 tables cleanly on unmigrated databases."""
    message = str(exc).lower()
    if any(
        table in message
        for table in (
            "book_presentation_assets",
            "book_style_bibles",
            "smart_studio_jobs",
            "page_ocr_extractions",
        )
    ):
        if any(
            marker in message
            for marker in (
                "does not exist",
                "undefinedtable",
                "undefined_table",
                "no such table",
                "relation",
            )
        ):
            return True
    orig = getattr(exc, "orig", None)
    if orig is not None and orig is not exc:
        return is_missing_v2_table_error(orig)
    return False


class BookAssetsRepository:
    """Data-access layer strictly isolated from Flow 1 / Flow 2 OCR tables."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_actor_role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id, Profile.Active == 1)
        )

    async def get_book(self, book_id: UUID) -> Book | None:
        result = await self.db.execute(
            select(Book).where(Book.Id == book_id, Book.IsDeleted.is_(False))
        )
        return result.scalar_one_or_none()

    async def get_page(self, book_id: UUID, page_id: UUID) -> BookPage | None:
        result = await self.db.execute(
            select(BookPage).where(
                BookPage.Id == page_id,
                BookPage.BookId == book_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_page_revision_context(
        self, page: BookPage
    ) -> tuple[UUID | None, str, list[list[float]]]:
        """Read-only lookup of latest/verified revision text and normalized word bboxes."""
        revision: PageRevision | None = None
        if page.CurrentVerifiedRevisionId is not None:
            revision = await self.db.scalar(
                select(PageRevision).where(
                    PageRevision.Id == page.CurrentVerifiedRevisionId
                )
            )
        if revision is None:
            revision = await self.db.scalar(
                select(PageRevision)
                .where(PageRevision.PageId == page.Id)
                .order_by(desc(PageRevision.CreatedAt))
                .limit(1)
            )
        if revision is None:
            return None, "", []

        canonical_text = (
            revision.VerifiedText
            or revision.DraftText
            or revision.OriginalOcrText
            or ""
        ).strip()
        words_result = await self.db.execute(
            select(PageRevisionWord.BoundingBox)
            .where(PageRevisionWord.PageRevisionId == revision.Id)
            .order_by(PageRevisionWord.WordIndex)
        )
        bboxes: list[list[float]] = []
        for raw_bbox in words_result.scalars().all():
            coerced = _coerce_bbox(raw_bbox)
            if coerced is not None:
                bboxes.append(coerced)
        return revision.Id, canonical_text, bboxes

    async def list_book_sample_texts(self, book_id: UUID, *, limit: int = 6) -> list[str]:
        """Read-only text samples from a book's pages to ground the Style Bible."""
        stmt = (
            select(
                PageRevision.VerifiedText,
                PageRevision.DraftText,
                PageRevision.OriginalOcrText,
            )
            .join(BookPage, BookPage.Id == PageRevision.PageId)
            .where(BookPage.BookId == book_id, BookPage.LifecycleStatus == "ACTIVE")
            .order_by(BookPage.PageNumber.asc(), PageRevision.CreatedAt.desc())
            .limit(limit * 2)
        )
        rows = (await self.db.execute(stmt)).all()
        samples: list[str] = []
        seen: set[str] = set()
        for verified, draft, original in rows:
            candidate = (verified or draft or original or "").strip()
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            samples.append(candidate[:800])
            if len(samples) >= limit:
                break
        return samples

    async def get_asset_by_id(
        self, asset_id: UUID
    ) -> tuple[BookPresentationAsset | None, bool]:
        try:
            async with self.db.begin_nested():
                asset = await self.db.scalar(
                    select(BookPresentationAsset).where(
                        BookPresentationAsset.Id == asset_id
                    )
                )
                return asset, False
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                logger.warning("V2 book_presentation_assets table not migrated yet")
                return None, True
            raise

    async def list_active_covers(
        self, book_id: UUID
    ) -> tuple[list[BookPresentationAsset], bool]:
        try:
            async with self.db.begin_nested():
                rows = (
                    (
                        await self.db.execute(
                            select(BookPresentationAsset)
                            .where(
                                BookPresentationAsset.BookId == book_id,
                                BookPresentationAsset.AssetRole == "COVER",
                                BookPresentationAsset.BookPageId.is_(None),
                                BookPresentationAsset.IsActive.is_(True),
                            )
                            .order_by(
                                desc(BookPresentationAsset.AssetVersion),
                                desc(BookPresentationAsset.UpdatedAt),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                return list(rows), False
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                return [], True
            raise

    async def get_effective_cover(
        self, book_id: UUID
    ) -> tuple[BookPresentationAsset | None, bool]:
        """Enforce strict cover priority: USER_UPLOAD > AI_GENERATED (APPROVED) > None (METADATA_RENDER)."""
        covers, degraded = await self.list_active_covers(book_id)
        if degraded or not covers:
            return None, degraded
        approved = [c for c in covers if c.ModerationStatus == "APPROVED"]
        if not approved:
            return None, False
        approved.sort(
            key=lambda item: (
                COVER_PRIORITY_RANK.get(item.SourceType, 99),
                -(item.AssetVersion or 0),
                -(item.UpdatedAt.timestamp() if item.UpdatedAt else 0.0),
            )
        )
        top = approved[0]
        if top.SourceType in ("USER_UPLOAD", "AI_GENERATED"):
            return top, False
        return None, False

    async def has_active_user_uploaded_cover(self, book_id: UUID) -> bool:
        covers, degraded = await self.list_active_covers(book_id)
        if degraded:
            return False
        return any(
            c.SourceType == "USER_UPLOAD"
            and c.ModerationStatus == "APPROVED"
            and c.IsActive
            for c in covers
        )

    async def next_asset_version(
        self, book_id: UUID, asset_role: str, book_page_id: UUID | None = None
    ) -> int:
        stmt = select(func.coalesce(func.max(BookPresentationAsset.AssetVersion), 0)).where(
            BookPresentationAsset.BookId == book_id,
            BookPresentationAsset.AssetRole == asset_role,
        )
        if book_page_id is None:
            stmt = stmt.where(BookPresentationAsset.BookPageId.is_(None))
        else:
            stmt = stmt.where(BookPresentationAsset.BookPageId == book_page_id)
        current = await self.db.scalar(stmt)
        return int(current or 0) + 1

    async def create_cover_asset(
        self,
        *,
        book_id: UUID,
        owner_id: UUID | None,
        source_type: str,
        storage_path: str,
        mime_type: str,
        width: int,
        height: int,
        size_bytes: int,
        asset_hash: str,
        is_active: bool = True,
        moderation_status: str = "APPROVED",
        provider_name: str | None = None,
        model_id: str | None = None,
        job_id: UUID | None = None,
        metadata_json: dict[str, Any] | None = None,
        deactivate_existing: bool = True,
    ) -> BookPresentationAsset:
        """Persist a book cover strictly in book_presentation_assets (book_page_id=NULL)."""
        now = datetime.now(timezone.utc)
        version = await self.next_asset_version(book_id, "COVER", None)

        if deactivate_existing and is_active:
            await self.db.execute(
                update(BookPresentationAsset)
                .where(
                    BookPresentationAsset.BookId == book_id,
                    BookPresentationAsset.AssetRole == "COVER",
                    BookPresentationAsset.BookPageId.is_(None),
                    BookPresentationAsset.IsActive.is_(True),
                )
                .values(IsActive=False, UpdatedAt=now)
            )

        asset = BookPresentationAsset(
            BookId=book_id,
            BookPageId=None,
            SourceRevisionId=None,
            OwnerId=owner_id,
            AssetRole="COVER",
            SourceType=source_type,
            StoragePath=storage_path,
            MimeType=mime_type,
            Width=width,
            Height=height,
            SizeBytes=size_bytes,
            AssetHash=asset_hash,
            AssetVersion=version,
            IsActive=is_active,
            TextFreeVerified=True,
            ModerationStatus=moderation_status,
            ProviderName=provider_name,
            ModelId=model_id,
            JobId=job_id,
            MetadataJson=dict(metadata_json or {}),
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.db.add(asset)
        await self.db.flush()
        return asset

    async def deactivate_book_covers(self, book_id: UUID) -> list[BookPresentationAsset]:
        covers, degraded = await self.list_active_covers(book_id)
        if degraded or not covers:
            return []
        now = datetime.now(timezone.utc)
        for cover in covers:
            cover.IsActive = False
            cover.UpdatedAt = now
        await self.db.flush()
        return covers

    async def mark_inflight_cover_jobs_stale(
        self,
        book_id: UUID,
        *,
        actor_role: str | None = None,
        actor_id: UUID | None = None,
    ) -> int:
        """Mark pending/running COVER_GENERATE jobs STALE scoped to portal/actor so roles never clobber each other."""
        now = datetime.now(timezone.utc)
        try:
            async with self.db.begin_nested():
                criteria = [
                    SmartStudioJob.BookId == book_id,
                    SmartStudioJob.JobType == "COVER_GENERATE",
                    SmartStudioJob.Status.in_(INFLIGHT_JOB_STATUSES),
                ]
                if actor_role is not None:
                    criteria.append(SmartStudioJob.ActorRole == actor_role)
                if actor_id is not None:
                    criteria.append(SmartStudioJob.ActorId == actor_id)
                result = await self.db.execute(
                    update(SmartStudioJob)
                    .where(*criteria)
                    .values(
                        Status="STALE",
                        Stage="SUPERSEDED_BY_USER_UPLOAD",
                        ErrorCode="SUPERSEDED_BY_USER_UPLOAD",
                        ErrorMessageVi="Ảnh bìa do người dùng tải lên đã thay thế tác vụ tạo bìa AI.",
                        UpdatedAt=now,
                        CompletedAt=now,
                    )
                )
                return int(result.rowcount or 0)
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                return 0
            raise

    async def list_page_illustrations(
        self, book_id: UUID, *, page_id: UUID | None = None
    ) -> tuple[list[BookPresentationAsset], bool]:
        try:
            async with self.db.begin_nested():
                stmt = select(BookPresentationAsset).where(
                    BookPresentationAsset.BookId == book_id,
                    BookPresentationAsset.AssetRole == "PAGE_ILLUSTRATION",
                    BookPresentationAsset.BookPageId.is_not(None),
                )
                if page_id is not None:
                    stmt = stmt.where(BookPresentationAsset.BookPageId == page_id)
                stmt = stmt.order_by(
                    desc(BookPresentationAsset.IsActive),
                    desc(BookPresentationAsset.AssetVersion),
                    desc(BookPresentationAsset.UpdatedAt),
                )
                rows = (await self.db.execute(stmt)).scalars().all()
                return list(rows), False
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                return [], True
            raise

    async def create_page_illustration_asset(
        self,
        *,
        book_id: UUID,
        book_page_id: UUID,
        source_revision_id: UUID | None,
        owner_id: UUID | None,
        source_type: str,
        storage_path: str,
        mime_type: str,
        width: int,
        height: int,
        size_bytes: int,
        asset_hash: str,
        text_free_verified: bool,
        moderation_status: str,
        is_active: bool,
        provider_name: str | None = None,
        model_id: str | None = None,
        job_id: UUID | None = None,
        metadata_json: dict[str, Any] | None = None,
    ) -> BookPresentationAsset:
        now = datetime.now(timezone.utc)
        version = await self.next_asset_version(
            book_id, "PAGE_ILLUSTRATION", book_page_id
        )
        if is_active and moderation_status == "APPROVED" and text_free_verified:
            await self.db.execute(
                update(BookPresentationAsset)
                .where(
                    BookPresentationAsset.BookId == book_id,
                    BookPresentationAsset.BookPageId == book_page_id,
                    BookPresentationAsset.AssetRole == "PAGE_ILLUSTRATION",
                    BookPresentationAsset.IsActive.is_(True),
                )
                .values(IsActive=False, UpdatedAt=now)
            )

        asset = BookPresentationAsset(
            BookId=book_id,
            BookPageId=book_page_id,
            SourceRevisionId=source_revision_id,
            OwnerId=owner_id,
            AssetRole="PAGE_ILLUSTRATION",
            SourceType=source_type,
            StoragePath=storage_path,
            MimeType=mime_type,
            Width=width,
            Height=height,
            SizeBytes=size_bytes,
            AssetHash=asset_hash,
            AssetVersion=version,
            IsActive=is_active,
            TextFreeVerified=text_free_verified,
            ModerationStatus=moderation_status,
            ProviderName=provider_name,
            ModelId=model_id,
            JobId=job_id,
            MetadataJson=dict(metadata_json or {}),
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.db.add(asset)
        await self.db.flush()
        return asset

    async def moderate_page_illustration(
        self,
        asset: BookPresentationAsset,
        *,
        action: str,
        reason: str | None = None,
    ) -> BookPresentationAsset:
        now = datetime.now(timezone.utc)
        meta = dict(asset.MetadataJson or {})
        if reason:
            meta["moderation_reason"] = reason.strip()
        meta["last_moderation_action"] = action

        if action in ("APPROVE", "RESTORE"):
            await self.db.execute(
                update(BookPresentationAsset)
                .where(
                    BookPresentationAsset.BookId == asset.BookId,
                    BookPresentationAsset.BookPageId == asset.BookPageId,
                    BookPresentationAsset.AssetRole == "PAGE_ILLUSTRATION",
                    BookPresentationAsset.Id != asset.Id,
                    BookPresentationAsset.IsActive.is_(True),
                )
                .values(IsActive=False, UpdatedAt=now)
            )
            asset.ModerationStatus = "APPROVED"
            asset.IsActive = True
        elif action == "REJECT":
            asset.ModerationStatus = "REJECTED"
            asset.IsActive = False
        asset.MetadataJson = meta
        asset.UpdatedAt = now
        await self.db.flush()
        return asset

    async def get_style_bible(
        self, book_id: UUID
    ) -> tuple[BookStyleBible | None, bool]:
        try:
            async with self.db.begin_nested():
                bible = await self.db.scalar(
                    select(BookStyleBible).where(BookStyleBible.BookId == book_id)
                )
                return bible, False
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                return None, True
            raise

    async def upsert_style_bible(
        self,
        *,
        book_id: UUID,
        owner_id: UUID | None,
        context_hash: str,
        bible_json: dict[str, Any],
        provider_name: str | None,
        model_id: str | None,
    ) -> tuple[BookStyleBible | None, bool]:
        now = datetime.now(timezone.utc)
        try:
            async with self.db.begin_nested():
                existing = await self.db.scalar(
                    select(BookStyleBible).where(BookStyleBible.BookId == book_id)
                )
                if existing is None:
                    existing = BookStyleBible(
                        BookId=book_id,
                        OwnerId=owner_id,
                        ContextHash=context_hash,
                        BibleJson=dict(bible_json),
                        ProviderName=provider_name,
                        ModelId=model_id,
                        UpdatedAt=now,
                    )
                    self.db.add(existing)
                else:
                    existing.OwnerId = owner_id
                    existing.ContextHash = context_hash
                    existing.BibleJson = dict(bible_json)
                    existing.ProviderName = provider_name
                    existing.ModelId = model_id
                    existing.UpdatedAt = now
                await self.db.flush()
                return existing, False
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                return None, True
            raise

    async def get_studio_job(self, job_id: UUID) -> SmartStudioJob | None:
        try:
            async with self.db.begin_nested():
                return await self.db.scalar(
                    select(SmartStudioJob).where(SmartStudioJob.Id == job_id)
                )
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                return None
            raise

    async def record_studio_job(
        self,
        *,
        job_type: str,
        actor_id: UUID,
        actor_role: str,
        book_id: UUID,
        book_page_id: UUID | None,
        source_revision_id: UUID | None,
        input_hash: str,
        idempotency_key: str,
        stage: str,
        status_value: str,
        priority: int = 40,
        result_ref_json: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message_vi: str | None = None,
    ) -> SmartStudioJob | None:
        """Idempotently record or update a durable SmartStudioJob with graceful unmigrated fallback."""
        now = datetime.now(timezone.utc)
        try:
            async with self.db.begin_nested():
                existing = await self.db.scalar(
                    select(SmartStudioJob).where(
                        SmartStudioJob.ActorId == actor_id,
                        SmartStudioJob.IdempotencyKey == idempotency_key,
                    )
                )
                if existing is not None:
                    return existing
                completed_at = (
                    now
                    if status_value in ("SUCCEEDED", "FAILED", "CANCELLED", "STALE")
                    else None
                )
                job = SmartStudioJob(
                    JobType=job_type,
                    ActorId=actor_id,
                    ActorRole=actor_role,
                    BookId=book_id,
                    BookPageId=book_page_id,
                    SourceRevisionId=source_revision_id,
                    InputHash=input_hash,
                    IdempotencyKey=idempotency_key,
                    Stage=stage,
                    Status=status_value,
                    Priority=priority,
                    AttemptCount=1 if status_value != "QUEUED" else 0,
                    MaxAttempts=3,
                    ResultRefJson=dict(result_ref_json or {}),
                    ErrorCode=error_code,
                    ErrorMessageVi=error_message_vi,
                    CreatedAt=now,
                    UpdatedAt=now,
                    StartedAt=now if status_value != "QUEUED" else None,
                    CompletedAt=completed_at,
                )
                self.db.add(job)
                await self.db.flush()
                return job
        except IntegrityError:
            async with self.db.begin_nested():
                return await self.db.scalar(
                    select(SmartStudioJob).where(
                        SmartStudioJob.ActorId == actor_id,
                        SmartStudioJob.IdempotencyKey == idempotency_key,
                    )
                )
        except (ProgrammingError, OperationalError) as exc:
            if is_missing_v2_table_error(exc):
                return None
            raise


def _coerce_bbox(raw: Any) -> list[float] | None:
    vals: list[float] | None = None
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        try:
            vals = [float(v) for v in raw]
        except (TypeError, ValueError):
            return None
    elif isinstance(raw, dict):
        try:
            if all(k in raw for k in ("x", "y", "w", "h")):
                vals = [
                    float(raw["x"]),
                    float(raw["y"]),
                    float(raw["w"]),
                    float(raw["h"]),
                ]
            elif all(k in raw for k in ("left", "top", "width", "height")):
                vals = [
                    float(raw["left"]),
                    float(raw["top"]),
                    float(raw["width"]),
                    float(raw["height"]),
                ]
        except (TypeError, ValueError):
            return None
    if vals is None:
        return None
    x, y, w, h = vals
    if w <= 0 or h <= 0:
        return None
    x = max(0.0, min(1.0, x))
    y = max(0.0, min(1.0, y))
    w = max(0.0, min(1.0 - x, w))
    h = max(0.0, min(1.0 - y, h))
    if w <= 0 or h <= 0:
        return None
    return [x, y, w, h]
