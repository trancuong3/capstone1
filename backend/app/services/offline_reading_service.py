"""Offline Reading Pack builder & Supavisor-safe idempotent deferred session sync (#3)."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
import inspect
import logging
import math
import unicodedata
from typing import Any
from uuid import UUID, uuid5

from fastapi import HTTPException, status
from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    ChildProfile,
    PageRevision,
    PageRevisionWord,
    Profile,
    ReadingEvent,
    ReadingSession,
    ReadingSessionPage,
)
from app.models.reading_comparison_report import ReadingComparisonReport
from app.policies.book_access import (
    is_book_private,
    is_private_book,
    is_private_page_readable,
    private_page_image_url,
)
from app.repositories.book_repository import CatalogRepository
from app.repositories.reading_comparison_repository import ReadingComparisonRepository
from app.repositories.reading_content_repository import ReadingContentRepository
from app.schemas.reading import (
    OfflineReadingPackBookRead,
    OfflineReadingPackResponse,
    OfflineReadingSyncRequest,
    OfflineReadingSyncResponse,
    ReadingPageDTO,
    ReadingPageWordDTO,
    ReadingPageWordTimingDTO,
)
from app.services.catalog_tts_cache import (
    get_catalog_tts_default_voice_id,
    resolve_verified_catalog_tts_url,
)
from app.services.duet_reading import build_duet_segments_for_page
from app.services.reading_content_service import (
    ReadingContentService,
    _ORIGINAL_CREATE_SIGNED_IMAGE_URL,
)
import app.services.reading_content_service as _rcs_module
from app.services.storage_service import (
    create_cached_signed_image_urls,
    is_local_storage_enabled,
)
from app.services.text_alignment import align_text, summarize_alignment
from app.services.word_box_geometry import has_verified_geometry

logger = logging.getLogger(__name__)

OFFLINE_SYNC_NAMESPACE = UUID("b4e70942-8a3f-4c9d-9e51-2f6d0a18c403")
MAX_OFFLINE_PACK_PAGES = 120


def derive_offline_sync_session_id(
    actor_id: UUID, child_id: UUID, client_sync_id: str
) -> UUID:
    """Deterministic session PK for zero-migration Supavisor-safe idempotency."""
    canonical = f"{actor_id}:{child_id}:{client_sync_id.strip()}"
    return uuid5(OFFLINE_SYNC_NAMESPACE, canonical)


class OfflineReadingService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.content_repo = ReadingContentRepository(db)
        self.content_service = ReadingContentService(self.content_repo)

    async def _release_db(self) -> None:
        rollback = getattr(self.db, "rollback", None)
        if callable(rollback):
            res = rollback()
            if inspect.isawaitable(res):
                await res

    async def _require_parent_role(self, actor_id: UUID) -> None:
        role = await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id, Profile.Active == 1)
        )
        if role != "parent":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Parent access required",
            )

    async def build_offline_pack(
        self,
        actor_id: UUID,
        book_id: UUID,
        *,
        base_url: str | None = None,
    ) -> OfflineReadingPackResponse:
        await self._require_parent_role(actor_id)

        book_row = await self.db.scalar(
            select(Book).where(
                Book.Id == book_id,
                CatalogRepository.readable_book(actor_id),
            )
        )
        if book_row is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        book_is_priv = is_book_private(book_row)
        owner_parent_id = getattr(book_row, "OwnerParentId", None)
        book_title = str(book_row.Title or book_row.Name or "Sách ViRead").strip()
        book_author = book_row.Author
        min_grade = max(1, min(5, int(book_row.MinGrade or 1)))
        max_grade = max(min_grade, min(5, int(book_row.MaxGrade or min_grade)))
        visibility_scope = (
            "PARENT_PRIVATE" if book_is_priv else "CATALOG"
        )

        pages_res = await self.db.execute(
            select(BookPage, PageRevision)
            .join(Book, Book.Id == BookPage.BookId)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.CurrentVerifiedRevisionId.is_not(None),
                CatalogRepository.readable_book(actor_id),
                or_(
                    ~is_private_book(),
                    is_private_page_readable(),
                ),
            )
            .order_by(BookPage.PageNumber)
            .limit(MAX_OFFLINE_PACK_PAGES)
        )
        page_pairs = pages_res.all()
        if not page_pairs:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "Sách chưa có trang đã xác minh để tải gói đọc ngoại tuyến.",
                },
            )

        page_ids = [p.Id for p, _ in page_pairs]
        revision_ids = [rev.Id for _, rev in page_pairs]

        words_res = await self.db.execute(
            select(PageRevisionWord)
            .where(PageRevisionWord.PageRevisionId.in_(revision_ids))
            .order_by(PageRevisionWord.PageRevisionId, PageRevisionWord.WordIndex)
        )
        words_by_rev: dict[UUID, list[ReadingPageWordDTO]] = defaultdict(list)
        for row in words_res.scalars().all():
            box = ReadingContentService._valid_bbox(row.BoundingBox)
            if box is None or not str(row.Text or "").strip():
                continue
            words_by_rev[row.PageRevisionId].append(
                ReadingPageWordDTO(
                    word_id=row.Id,
                    word_index=int(row.WordIndex),
                    text=row.Text,
                    bbox=box,
                    line_index=max(0, int(getattr(row, "LineIndex", 0) or 0)),
                )
            )

        illustrations_by_page: dict[UUID, tuple[UUID, str | None]] = {}
        try:
            from app.models.smart_book_studio import BookPresentationAsset

            if callable(getattr(self.db, "begin_nested", None)):
                async with self.db.begin_nested():
                    ill_rows = (
                        await self.db.execute(
                            select(BookPresentationAsset)
                            .where(
                                BookPresentationAsset.BookPageId.in_(page_ids),
                                BookPresentationAsset.AssetRole == "PAGE_ILLUSTRATION",
                                BookPresentationAsset.IsActive.is_(True),
                                BookPresentationAsset.ModerationStatus == "APPROVED",
                                BookPresentationAsset.TextFreeVerified.is_(True),
                            )
                            .order_by(
                                BookPresentationAsset.BookPageId,
                                desc(BookPresentationAsset.AssetVersion),
                                desc(BookPresentationAsset.UpdatedAt),
                            )
                        )
                    ).scalars().all()
                    for asset in ill_rows:
                        if asset.BookPageId not in illustrations_by_page:
                            raw_path = getattr(asset, "StoragePath", None)
                            illustrations_by_page[asset.BookPageId] = (
                                asset.Id,
                                raw_path.strip()
                                if isinstance(raw_path, str) and raw_path.strip()
                                else None,
                            )
        except Exception:
            illustrations_by_page = {}

        extractions_by_page: dict[UUID, tuple[str | None, list[dict] | None]] = {}
        try:
            from app.models.smart_book_studio import PageOcrExtraction

            if callable(getattr(self.db, "begin_nested", None)):
                async with self.db.begin_nested():
                    ext_rows = (
                        await self.db.execute(
                            select(PageOcrExtraction)
                            .where(PageOcrExtraction.BookPageId.in_(page_ids))
                            .order_by(
                                PageOcrExtraction.BookPageId,
                                desc(PageOcrExtraction.UpdatedAt),
                                desc(PageOcrExtraction.Id),
                            )
                        )
                    ).scalars().all()
                    for ext in ext_rows:
                        if ext.BookPageId not in extractions_by_page:
                            raw_pk = getattr(ext, "PageKind", None)
                            raw_blocks = getattr(ext, "BlocksJson", None)
                            extractions_by_page[ext.BookPageId] = (
                                raw_pk.strip()
                                if isinstance(raw_pk, str) and raw_pk.strip()
                                else None,
                                raw_blocks if isinstance(raw_blocks, list) else None,
                            )
        except Exception:
            extractions_by_page = {}

        snapshots: list[dict[str, Any]] = []
        paths_to_sign: list[str] = []
        for page_orm, rev_orm in page_pairs:
            text_content = (rev_orm.VerifiedText or "").strip()
            rev_words = words_by_rev.get(rev_orm.Id, [])
            if not text_content or not rev_words:
                continue

            processing_meta = (
                dict(rev_orm.ProcessingMeta)
                if isinstance(rev_orm.ProcessingMeta, dict)
                else {}
            )
            page_width = max(1, int(page_orm.Width or 1000))
            page_height = max(1, int(page_orm.Height or 1400))

            source_path = processing_meta.get("source_image_path")
            source_w = processing_meta.get("source_image_width")
            source_h = processing_meta.get("source_image_height")
            has_source_snapshot = any(
                k in processing_meta
                for k in ("source_image_path", "source_image_width", "source_image_height")
            )
            image_path: str | None = None
            if (
                isinstance(source_path, str)
                and source_path.strip()
                and type(source_w) is int
                and type(source_h) is int
                and source_w > 0
                and source_h > 0
            ):
                image_path = source_path.strip()
                page_width = source_w
                page_height = source_h
            elif (
                not has_source_snapshot
                and page_orm.CurrentVerifiedRevisionId == rev_orm.Id
                and isinstance(page_orm.ImagePath, str)
                and page_orm.ImagePath.strip()
            ):
                image_path = page_orm.ImagePath.strip()

            ill_id, ill_storage_path = illustrations_by_page.get(
                page_orm.Id, (None, None)
            )
            ext_kind, ext_blocks = extractions_by_page.get(
                page_orm.Id, (None, None)
            )

            tts_audio_url = resolve_verified_catalog_tts_url(
                is_public_catalog=not book_is_priv,
                is_verified=True,
                text=text_content,
                processing_meta=processing_meta,
            )
            tts_word_timings: list[ReadingPageWordTimingDTO] | None = None
            tts_voice_id: str | None = None
            tts_cached_speed: float | None = None
            if tts_audio_url and not book_is_priv:
                catalog_tts_meta = processing_meta.get("catalog_tts")
                raw_timings = None
                expected_speed = 1.0
                if isinstance(catalog_tts_meta, dict):
                    mv = catalog_tts_meta.get("voice_id")
                    if isinstance(mv, str) and mv.strip():
                        tts_voice_id = mv.strip()
                    ms = catalog_tts_meta.get("speed")
                    if isinstance(ms, (int, float)) and math.isfinite(float(ms)) and float(ms) > 0:
                        tts_cached_speed = round(float(ms), 2)
                        expected_speed = tts_cached_speed
                    if isinstance(catalog_tts_meta.get("word_timings"), list):
                        raw_timings = catalog_tts_meta.get("word_timings")

                if isinstance(raw_timings, list) and len(raw_timings) == len(rev_words):
                    parsed_timings: list[ReadingPageWordTimingDTO] = []
                    valid_timings = True
                    for idx, item in enumerate(raw_timings):
                        if not isinstance(item, dict) or "id" in item:
                            valid_timings = False
                            break
                        try:
                            s_val = float(item.get("start", -1.0))
                            e_val = float(item.get("end", -1.0))
                        except (TypeError, ValueError):
                            valid_timings = False
                            break
                        if not (math.isfinite(s_val) and math.isfinite(e_val)) or s_val < 0 or e_val < s_val:
                            valid_timings = False
                            break
                        parsed_timings.append(
                            ReadingPageWordTimingDTO(
                                index=idx,
                                start=round(s_val, 3),
                                end=round(e_val, 3),
                            )
                        )
                    if valid_timings and parsed_timings:
                        tts_word_timings = parsed_timings
                        tts_voice_id = tts_voice_id or get_catalog_tts_default_voice_id()
                        tts_cached_speed = tts_cached_speed or expected_speed

            if not book_is_priv:
                if image_path:
                    paths_to_sign.append(image_path)
                if ill_id is not None and ill_storage_path and not is_local_storage_enabled():
                    paths_to_sign.append(ill_storage_path)

            snapshots.append(
                {
                    "page_id": page_orm.Id,
                    "page_revision_id": rev_orm.Id,
                    "page_number": int(page_orm.PageNumber),
                    "width": page_width,
                    "height": page_height,
                    "image_path": image_path,
                    "ill_id": ill_id,
                    "ill_storage_path": ill_storage_path,
                    "illustration_text_free": ill_id is not None,
                    "page_kind": ext_kind,
                    "blocks_json": ext_blocks,
                    "processing_meta": processing_meta,
                    "text": text_content,
                    "words": rev_words,
                    "tts_audio_url": tts_audio_url,
                    "tts_word_timings": tts_word_timings,
                    "tts_voice_id": tts_voice_id,
                    "tts_cached_speed": tts_cached_speed,
                }
            )

        await self._release_db()

        if not snapshots:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "Sách chưa có dữ liệu từ vựng đã xác minh để đọc ngoại tuyến.",
                },
            )

        signed_map: dict[str, str | None] = {}
        if not book_is_priv and paths_to_sign:
            unique_paths = list(dict.fromkeys(paths_to_sign))
            try:
                if _rcs_module.create_signed_image_url is not _ORIGINAL_CREATE_SIGNED_IMAGE_URL:
                    def _sign_patched() -> dict[str, str | None]:
                        return {
                            p: _rcs_module.create_signed_image_url(p)
                            for p in unique_paths
                        }

                    signed_map = await asyncio.to_thread(_sign_patched)
                else:
                    signed_list = await asyncio.to_thread(
                        create_cached_signed_image_urls, unique_paths
                    )
                    signed_map = dict(zip(unique_paths, signed_list))
            except Exception:
                signed_map = {}

        pages_dto: list[ReadingPageDTO] = []
        for snap in snapshots:
            image_url: str | None = None
            ill_id = snap["ill_id"]
            illustration_url = (
                f"/studio/assets/{ill_id}/media" if ill_id is not None else None
            )
            if book_is_priv:
                image_url = await asyncio.to_thread(
                    private_page_image_url,
                    book_id,
                    snap["page_id"],
                    revision_id=snap["page_revision_id"],
                    base_url=base_url,
                    storage_path=snap["image_path"],
                    owner_id=owner_parent_id,
                )
            else:
                if snap["image_path"]:
                    image_url = signed_map.get(snap["image_path"])
                ill_sp = snap["ill_storage_path"]
                if ill_id is not None and ill_sp and signed_map.get(ill_sp):
                    illustration_url = signed_map[ill_sp]

            pmeta = snap["processing_meta"]

            def _safe_lines(key: str) -> list[int]:
                raw_val = pmeta.get(key, [])
                if not isinstance(raw_val, (list, tuple)):
                    return []
                return sorted(
                    {
                        v
                        for v in raw_val
                        if isinstance(v, int) and not isinstance(v, bool) and v >= 0
                    }
                )

            para_lines = _safe_lines("paragraph_start_line_indices")
            indented_lines = _safe_lines("indented_line_indices")
            words = snap["words"]
            duet_segments = build_duet_segments_for_page(
                words,
                page_kind=snap["page_kind"],
                blocks_json=snap["blocks_json"],
                paragraph_start_line_indices=para_lines,
            )

            pages_dto.append(
                ReadingPageDTO(
                    page_id=snap["page_id"],
                    page_revision_id=snap["page_revision_id"],
                    page_number=snap["page_number"],
                    confidence=None,
                    width=snap["width"],
                    height=snap["height"],
                    image_url=image_url,
                    tts_audio_url=snap["tts_audio_url"],
                    tts_word_timings=snap["tts_word_timings"],
                    tts_voice_id=snap["tts_voice_id"],
                    tts_cached_speed=snap["tts_cached_speed"],
                    image_overlay_safe=has_verified_geometry(
                        pmeta.get("word_box_geometry"),
                        [w.model_dump() for w in words],
                        snap["width"],
                        snap["height"],
                    ),
                    illustration_url=illustration_url,
                    illustration_text_free=snap["illustration_text_free"],
                    page_kind=snap["page_kind"],
                    duet_segments=duet_segments,
                    text=snap["text"],
                    words=words,
                    paragraph_start_line_indices=para_lines,
                    indented_line_indices=indented_lines,
                )
            )

        return OfflineReadingPackResponse(
            pack_version=1,
            generated_at=datetime.now(timezone.utc),
            book=OfflineReadingPackBookRead(
                book_id=book_id,
                title=book_title,
                author=book_author,
                min_grade=min_grade,
                max_grade=max_grade,
                visibility_scope=visibility_scope,
                page_count=len(pages_dto),
            ),
            pages=pages_dto,
        )

    async def _build_replay_response(
        self, existing: ReadingSession, payload: OfflineReadingSyncRequest
    ) -> OfflineReadingSyncResponse:
        if existing.ChildId != payload.child_id or existing.BookId != payload.book_id:
            raise HTTPException(
                status_code=409,
                detail="client_sync_id already bound to a different child or book.",
            )
        pages_count = int(
            (
                await self.db.scalar(
                    select(func.count(ReadingSessionPage.Id)).where(
                        ReadingSessionPage.SessionId == existing.Id
                    )
                )
            )
            or 0
        )
        reports_count = int(
            (
                await self.db.scalar(
                    select(func.count(ReadingComparisonReport.Id)).where(
                        ReadingComparisonReport.SessionId == existing.Id
                    )
                )
            )
            or 0
        )
        events_count = int(
            (
                await self.db.scalar(
                    select(func.count(ReadingEvent.Id)).where(
                        ReadingEvent.SessionId == existing.Id
                    )
                )
            )
            or 0
        )
        skipped_raw = (
            existing.ClientMeta.get("skipped_page_ids", [])
            if isinstance(existing.ClientMeta, dict)
            else []
        )
        skipped_ids: list[UUID] = []
        if isinstance(skipped_raw, list):
            for raw_id in skipped_raw:
                try:
                    skipped_ids.append(UUID(str(raw_id)))
                except (TypeError, ValueError):
                    continue
        return OfflineReadingSyncResponse(
            session_id=existing.Id,
            idempotent_replay=True,
            synced_pages_count=pages_count,
            synced_reports_count=reports_count,
            synced_events_count=events_count,
            skipped_page_ids=skipped_ids,
        )

    async def sync_offline_session(
        self, actor_id: UUID, payload: OfflineReadingSyncRequest
    ) -> OfflineReadingSyncResponse:
        await self._require_parent_role(actor_id)

        owned_child = await self.db.scalar(
            select(ChildProfile.Id).where(
                ChildProfile.Id == payload.child_id,
                ChildProfile.ParentId == actor_id,
            )
        )
        if owned_child is None:
            raise HTTPException(status_code=404, detail="Child profile not found")

        deterministic_session_id = derive_offline_sync_session_id(
            actor_id, payload.child_id, payload.client_sync_id
        )

        existing = await self.db.scalar(
            select(ReadingSession).where(ReadingSession.Id == deterministic_session_id)
        )
        if existing is not None:
            return await self._build_replay_response(existing, payload)

        accessible_book = await self.db.scalar(
            select(Book.Id).where(
                Book.Id == payload.book_id,
                Book.IsDeleted.is_(False),
                or_(
                    Book.VisibilityScope == "CATALOG",
                    and_(
                        Book.VisibilityScope == "PARENT_PRIVATE",
                        Book.OwnerParentId == actor_id,
                    ),
                ),
            )
        )
        if accessible_book is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        deduped_pages = []
        seen_page_ids: set[UUID] = set()
        for item in payload.pages:
            if item.page_id in seen_page_ids:
                continue
            seen_page_ids.add(item.page_id)
            deduped_pages.append(item)

        supplied_page_ids = [item.page_id for item in deduped_pages]
        db_page_rows = (
            await self.db.execute(
                select(
                    BookPage.Id,
                    BookPage.PageNumber,
                    PageRevision.Id,
                    PageRevision.VerifiedText,
                )
                .join(PageRevision, PageRevision.PageId == BookPage.Id)
                .where(
                    BookPage.BookId == payload.book_id,
                    BookPage.Id.in_(supplied_page_ids),
                )
            )
        ).all()
        valid_revisions: dict[tuple[UUID, UUID], tuple[int, str]] = {
            (p_id, r_id): (int(p_num), str(v_text or ""))
            for p_id, p_num, r_id, v_text in db_page_rows
        }

        valid_page_inputs = []
        skipped_page_ids: list[UUID] = []
        for item in deduped_pages:
            key = (item.page_id, item.page_revision_id)
            if key not in valid_revisions:
                skipped_page_ids.append(item.page_id)
                continue
            valid_page_inputs.append(item)

        if not valid_page_inputs:
            raise HTTPException(
                status_code=409,
                detail="Không còn trang sách hợp lệ để đồng bộ phiên đọc ngoại tuyến.",
            )

        valid_rev_ids = list({item.page_revision_id for item in valid_page_inputs})
        word_rows = (
            await self.db.execute(
                select(
                    PageRevisionWord.PageRevisionId,
                    PageRevisionWord.Id,
                    PageRevisionWord.Text,
                )
                .where(PageRevisionWord.PageRevisionId.in_(valid_rev_ids))
                .order_by(PageRevisionWord.PageRevisionId, PageRevisionWord.WordIndex)
            )
        ).all()
        words_by_rev_id: dict[UUID, list[tuple[UUID, str]]] = defaultdict(list)
        valid_word_ids_by_rev: dict[UUID, set[UUID]] = defaultdict(set)
        for rev_id, w_id, w_text in word_rows:
            words_by_rev_id[rev_id].append((w_id, str(w_text or "")))
            valid_word_ids_by_rev[rev_id].add(w_id)

        # Release DB read transaction before CPU text alignment
        await self._release_db()

        prepared_reports: list[dict[str, Any]] = []
        for item in valid_page_inputs:
            raw_transcript = unicodedata.normalize(
                "NFC", str(item.transcript or "")
            ).strip()
            if not raw_transcript:
                continue
            _, verified_text = valid_revisions[(item.page_id, item.page_revision_id)]
            ref_text = unicodedata.normalize(
                "NFC",
                verified_text.strip()
                or " ".join(t for _, t in words_by_rev_id.get(item.page_revision_id, [])),
            ).strip()
            if not ref_text:
                continue
            aligned = await asyncio.to_thread(align_text, ref_text, raw_transcript)
            summary = await asyncio.to_thread(
                summarize_alignment,
                aligned["alignment"],
                words=None,
                threshold=1.0,
            )
            prepared_reports.append(
                {
                    "id": uuid5(
                        deterministic_session_id,
                        f"report:{item.page_id}:{item.page_revision_id}",
                    ),
                    "page_id": item.page_id,
                    "page_revision_id": item.page_revision_id,
                    "transcript": raw_transcript,
                    "distance": int(aligned["distance"]),
                    "alignment": aligned["alignment"],
                    "summary": summary,
                }
            )

        now_utc = datetime.now(timezone.utc)
        started_at = (
            payload.started_at
            if payload.started_at.tzinfo is not None
            else payload.started_at.replace(tzinfo=timezone.utc)
        )
        ended_at_raw = payload.ended_at or now_utc
        ended_at = (
            ended_at_raw
            if ended_at_raw.tzinfo is not None
            else ended_at_raw.replace(tzinfo=timezone.utc)
        )
        if ended_at < started_at:
            ended_at = started_at

        first_item = valid_page_inputs[0]
        last_item = valid_page_inputs[-1]

        session_row = ReadingSession(
            Id=deterministic_session_id,
            ChildId=payload.child_id,
            BookId=payload.book_id,
            SelectedPageId=first_item.page_id,
            SelectedPageRevisionId=first_item.page_revision_id,
            StartPageId=first_item.page_id,
            EndPageId=last_item.page_id,
            CurrentPageId=last_item.page_id,
            State="FINISHED",
            Mode="offline_pack",
            ClientMeta={
                "offline_sync": True,
                "client_sync_id": payload.client_sync_id,
                "skipped_page_ids": [str(pid) for pid in skipped_page_ids],
            },
            StartedAt=started_at,
            EndedAt=ended_at,
        )

        valid_keys = {(i.page_id, i.page_revision_id) for i in valid_page_inputs}
        session_page_rows: list[ReadingSessionPage] = []
        for order_idx, item in enumerate(valid_page_inputs):
            page_num, _ = valid_revisions[(item.page_id, item.page_revision_id)]
            p_start = item.started_at or started_at
            if p_start.tzinfo is None:
                p_start = p_start.replace(tzinfo=timezone.utc)
            p_end = (item.completed_at or ended_at) if item.completed else None
            if p_end is not None and p_end.tzinfo is None:
                p_end = p_end.replace(tzinfo=timezone.utc)
            session_page_rows.append(
                ReadingSessionPage(
                    Id=uuid5(deterministic_session_id, f"sp:{order_idx}:{item.page_id}"),
                    SessionId=deterministic_session_id,
                    PageId=item.page_id,
                    PageRevisionId=item.page_revision_id,
                    PageNumber=max(1, page_num),
                    PageOrder=order_idx,
                    Status="COMPLETED" if item.completed else "IN_PROGRESS",
                    StartedAt=p_start,
                    CompletedAt=p_end,
                )
            )

        event_rows: list[ReadingEvent] = []
        for ev_idx, ev in enumerate(payload.events):
            if (ev.page_id, ev.page_revision_id) not in valid_keys:
                continue
            word_id = (
                ev.word_id
                if ev.word_id is not None
                and ev.word_id in valid_word_ids_by_rev.get(ev.page_revision_id, set())
                else None
            )
            event_rows.append(
                ReadingEvent(
                    Id=uuid5(deterministic_session_id, f"ev:{ev_idx}"),
                    SessionId=deterministic_session_id,
                    PageId=ev.page_id,
                    PageRevisionId=ev.page_revision_id,
                    WordId=word_id,
                    Type=ev.type,
                    StartMs=ev.start_ms,
                    EndMs=ev.end_ms,
                    Confidence=ev.confidence,
                    Status=ev.status,
                    Metadata=dict(ev.metadata or {}),
                )
            )

        report_rows = [
            ReadingComparisonReport(
                Id=rep["id"],
                SessionId=deterministic_session_id,
                PageId=rep["page_id"],
                PageRevisionId=rep["page_revision_id"],
                Transcript=rep["transcript"],
                Distance=rep["distance"],
                Alignment=rep["alignment"],
                Summary=rep["summary"],
            )
            for rep in prepared_reports
        ]

        try:
            self.db.add(session_row)
            await self.db.flush()
            for sp_row in session_page_rows:
                self.db.add(sp_row)
            for rep_row in report_rows:
                self.db.add(rep_row)
            for ev_row in event_rows:
                self.db.add(ev_row)
            await self.db.flush()

            if prepared_reports and callable(getattr(self.db, "begin_nested", None)):
                try:
                    from app.services.reading_skill_evidence import (
                        emit_reading_comparison_skill_evidence,
                    )

                    comp_repo = ReadingComparisonRepository(self.db)
                    for rep in prepared_reports:
                        async with self.db.begin_nested():
                            await emit_reading_comparison_skill_evidence(
                                comp_repo,
                                child_id=payload.child_id,
                                parent_id=actor_id,
                                report_id=rep["id"],
                                alignment=rep["alignment"],
                                summary=rep["summary"],
                            )
                except Exception as exc:
                    logger.debug("offline_sync_skill_evidence_skipped: %s", type(exc).__name__)

            await self.db.commit()
        except IntegrityError:
            await self._release_db()
            raced = await self.db.scalar(
                select(ReadingSession).where(
                    ReadingSession.Id == deterministic_session_id
                )
            )
            if raced is not None:
                return await self._build_replay_response(raced, payload)
            raise

        return OfflineReadingSyncResponse(
            session_id=deterministic_session_id,
            idempotent_replay=False,
            synced_pages_count=len(session_page_rows),
            synced_reports_count=len(report_rows),
            synced_events_count=len(event_rows),
            skipped_page_ids=skipped_page_ids,
        )
