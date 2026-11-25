"""Repository for precomputed and cached TTS audio metadata & daily egress tracking."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Sequence
from uuid import UUID, uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    PageRevision,
    PageRevisionWord,
    TtsAudioCacheDailyUsage,
    TtsAudioCacheEntry,
)


class TtsAudioCacheRepository:
    """Data-access layer for `tts_audio_cache_entries` and daily egress counters."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    @staticmethod
    def _quantize_speed(speed: float) -> Decimal:
        return Decimal(f"{float(speed):.2f}")

    async def get_book_scope_info(self, book_id: UUID) -> dict[str, Any] | None:
        row = (
            await self.db.execute(
                select(
                    Book.Id,
                    Book.VisibilityScope,
                    Book.OwnerParentId,
                    Book.LifecycleStatus,
                    Book.ModerationStatus,
                    Book.IsDeleted,
                ).where(Book.Id == book_id)
            )
        ).first()
        if row is None:
            return None
        return {
            "book_id": row.Id,
            "visibility_scope": str(row.VisibilityScope or "CATALOG"),
            "owner_parent_id": row.OwnerParentId,
            "lifecycle_status": str(row.LifecycleStatus or "ACTIVE"),
            "moderation_status": str(row.ModerationStatus or "ACTIVE"),
            "is_deleted": bool(row.IsDeleted),
        }

    async def get_page_book_scope_info(self, page_id: UUID) -> dict[str, Any] | None:
        row = (
            await self.db.execute(
                select(
                    BookPage.Id.label("page_id"),
                    BookPage.BookId.label("book_id"),
                    BookPage.LifecycleStatus.label("page_lifecycle_status"),
                    Book.VisibilityScope,
                    Book.OwnerParentId,
                    Book.LifecycleStatus.label("book_lifecycle_status"),
                    Book.ModerationStatus,
                    Book.IsDeleted,
                )
                .join(Book, Book.Id == BookPage.BookId)
                .where(BookPage.Id == page_id)
            )
        ).first()
        if row is None:
            return None
        return {
            "page_id": row.page_id,
            "book_id": row.book_id,
            "page_lifecycle_status": str(row.page_lifecycle_status or "ACTIVE"),
            "visibility_scope": str(row.VisibilityScope or "CATALOG"),
            "owner_parent_id": row.OwnerParentId,
            "lifecycle_status": str(row.book_lifecycle_status or "ACTIVE"),
            "moderation_status": str(row.ModerationStatus or "ACTIVE"),
            "is_deleted": bool(row.IsDeleted),
        }

    async def get_page_revision_scope_info(
        self,
        *,
        page_revision_id: UUID,
        page_id: UUID | None = None,
        book_id: UUID | None = None,
    ) -> dict[str, Any] | None:
        query = (
            select(
                PageRevision.Id.label("revision_id"),
                PageRevision.PageId.label("page_id"),
                BookPage.BookId.label("book_id"),
                BookPage.LifecycleStatus.label("page_lifecycle_status"),
                Book.VisibilityScope,
                Book.OwnerParentId,
                Book.LifecycleStatus.label("book_lifecycle_status"),
                Book.ModerationStatus,
                Book.IsDeleted,
            )
            .join(BookPage, BookPage.Id == PageRevision.PageId)
            .join(Book, Book.Id == BookPage.BookId)
            .where(PageRevision.Id == page_revision_id)
        )
        if page_id is not None:
            query = query.where(PageRevision.PageId == page_id)
        if book_id is not None:
            query = query.where(BookPage.BookId == book_id)
        row = (await self.db.execute(query)).first()
        if row is None:
            return None
        return {
            "revision_id": row.revision_id,
            "page_id": row.page_id,
            "book_id": row.book_id,
            "page_lifecycle_status": str(row.page_lifecycle_status or "ACTIVE"),
            "visibility_scope": str(row.VisibilityScope or "CATALOG"),
            "owner_parent_id": row.OwnerParentId,
            "lifecycle_status": str(row.book_lifecycle_status or "ACTIVE"),
            "moderation_status": str(row.ModerationStatus or "ACTIVE"),
            "is_deleted": bool(row.IsDeleted),
        }

    async def get_verified_catalog_texts(
        self,
        *,
        book_id: UUID,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
    ) -> list[tuple[str | None, list[tuple[str | None, str | None]]]]:
        if page_revision_id is not None:
            rev_query = (
                select(PageRevision.Id, PageRevision.VerifiedText)
                .join(BookPage, BookPage.Id == PageRevision.PageId)
                .where(
                    PageRevision.Id == page_revision_id,
                    BookPage.BookId == book_id,
                    PageRevision.VerificationStatus == "VERIFIED",
                )
            )
            if page_id is not None:
                rev_query = rev_query.where(PageRevision.PageId == page_id)
        elif page_id is not None:
            rev_query = (
                select(PageRevision.Id, PageRevision.VerifiedText)
                .join(BookPage, BookPage.CurrentVerifiedRevisionId == PageRevision.Id)
                .where(
                    BookPage.Id == page_id,
                    BookPage.BookId == book_id,
                    BookPage.LifecycleStatus == "ACTIVE",
                    PageRevision.VerificationStatus == "VERIFIED",
                )
            )
        else:
            rev_query = (
                select(PageRevision.Id, PageRevision.VerifiedText)
                .join(BookPage, BookPage.CurrentVerifiedRevisionId == PageRevision.Id)
                .where(
                    BookPage.BookId == book_id,
                    BookPage.LifecycleStatus == "ACTIVE",
                    PageRevision.VerificationStatus == "VERIFIED",
                )
            )

        rev_rows = (await self.db.execute(rev_query)).all()
        if not rev_rows:
            return []

        rev_ids = [row.Id for row in rev_rows]
        word_rows = (
            await self.db.execute(
                select(
                    PageRevisionWord.PageRevisionId,
                    PageRevisionWord.NormalizedText,
                    PageRevisionWord.Text,
                )
                .where(PageRevisionWord.PageRevisionId.in_(rev_ids))
                .order_by(PageRevisionWord.WordIndex.asc())
            )
        ).all()
        words_by_rev: dict[UUID, list[tuple[str | None, str | None]]] = {}
        for word_row in word_rows:
            words_by_rev.setdefault(word_row.PageRevisionId, []).append(
                (word_row.NormalizedText, word_row.Text)
            )
        return [
            (row.VerifiedText, words_by_rev.get(row.Id, []))
            for row in rev_rows
        ]

    async def get_active_entry(
        self,
        *,
        scope: str,
        owner_parent_id: UUID | None,
        content_sha256: str,
        voice_id: str,
        model_version: str | None,
        speed: float,
        audio_formats: Sequence[str],
        allow_speed_fallback: bool = False,
        require_word_timings: bool = False,
    ) -> TtsAudioCacheEntry | None:
        if scope == "PRIVATE" and owner_parent_id is None:
            return None
        filters = [
            TtsAudioCacheEntry.Status == "ACTIVE",
            TtsAudioCacheEntry.Scope == scope,
            TtsAudioCacheEntry.ContentSha256 == content_sha256,
            TtsAudioCacheEntry.VoiceId == voice_id,
            TtsAudioCacheEntry.Speed == self._quantize_speed(speed),
            TtsAudioCacheEntry.AudioFormat.in_(list(audio_formats)),
        ]
        if scope == "PRIVATE":
            filters.append(TtsAudioCacheEntry.OwnerParentId == owner_parent_id)
        else:
            filters.append(TtsAudioCacheEntry.OwnerParentId.is_(None))
        if model_version:
            filters.append(TtsAudioCacheEntry.ModelVersion == model_version)
        if require_word_timings:
            filters.append(TtsAudioCacheEntry.WordTimingsJson.is_not(None))

        stmt = (
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(TtsAudioCacheEntry.CreatedAt.desc())
            .limit(1)
        )
        exact = await self.db.scalar(stmt)
        if exact is not None or not allow_speed_fallback:
            return exact
        return await self.get_nearest_active_entry(
            scope=scope,
            owner_parent_id=owner_parent_id,
            content_sha256=content_sha256,
            voice_id=voice_id,
            model_version=model_version,
            speed=speed,
            audio_formats=audio_formats,
            require_word_timings=require_word_timings,
        )

    async def get_nearest_active_entry(
        self,
        *,
        scope: str,
        owner_parent_id: UUID | None,
        content_sha256: str,
        voice_id: str,
        model_version: str | None,
        speed: float,
        audio_formats: Sequence[str],
        require_word_timings: bool = False,
    ) -> TtsAudioCacheEntry | None:
        if scope == "PRIVATE" and owner_parent_id is None:
            return None
        q_speed = self._quantize_speed(speed)
        filters = [
            TtsAudioCacheEntry.Status == "ACTIVE",
            TtsAudioCacheEntry.Scope == scope,
            TtsAudioCacheEntry.ContentSha256 == content_sha256,
            TtsAudioCacheEntry.VoiceId == voice_id,
            TtsAudioCacheEntry.AudioFormat.in_(list(audio_formats)),
        ]
        if scope == "PRIVATE":
            filters.append(TtsAudioCacheEntry.OwnerParentId == owner_parent_id)
        else:
            filters.append(TtsAudioCacheEntry.OwnerParentId.is_(None))
        if model_version:
            filters.append(TtsAudioCacheEntry.ModelVersion == model_version)
        if require_word_timings:
            filters.append(TtsAudioCacheEntry.WordTimingsJson.is_not(None))

        stmt = (
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(
                func.abs(TtsAudioCacheEntry.Speed - q_speed).asc(),
                TtsAudioCacheEntry.CreatedAt.desc(),
            )
            .limit(1)
        )
        return await self.db.scalar(stmt)

    async def upsert_active_entry(
        self,
        *,
        scope: str,
        owner_parent_id: UUID | None,
        book_id: UUID | None,
        page_id: UUID | None,
        page_revision_id: UUID | None,
        content_sha256: str,
        normalized_text: str,
        voice_id: str,
        model_version: str,
        speed: float,
        audio_format: str,
        storage_bucket: str,
        storage_path: str,
        byte_size: int,
        duration_seconds: float | None,
        word_timings_json: list[dict[str, Any]] | dict[str, Any] | None,
        now: datetime | None = None,
    ) -> tuple[TtsAudioCacheEntry, list[tuple[str, str]]]:
        if scope == "PRIVATE" and owner_parent_id is None:
            raise ValueError("PRIVATE cache entry requires owner_parent_id")
        if scope != "PRIVATE" and owner_parent_id is not None:
            raise ValueError(f"{scope} cache entry must not carry owner_parent_id")

        ts = now or datetime.now(timezone.utc)
        q_speed = self._quantize_speed(speed)
        owner_filter = (
            TtsAudioCacheEntry.OwnerParentId == owner_parent_id
            if scope == "PRIVATE"
            else TtsAudioCacheEntry.OwnerParentId.is_(None)
        )
        existing = await self.db.scalar(
            select(TtsAudioCacheEntry)
            .where(
                TtsAudioCacheEntry.Status == "ACTIVE",
                TtsAudioCacheEntry.Scope == scope,
                owner_filter,
                TtsAudioCacheEntry.ContentSha256 == content_sha256,
                TtsAudioCacheEntry.VoiceId == voice_id,
                TtsAudioCacheEntry.ModelVersion == model_version,
                TtsAudioCacheEntry.Speed == q_speed,
                TtsAudioCacheEntry.AudioFormat == audio_format,
            )
            .limit(1)
        )
        replaced: list[tuple[str, str]] = []
        if existing is not None:
            if (existing.StorageBucket, existing.StoragePath) != (storage_bucket, storage_path):
                replaced.append((str(existing.StorageBucket), str(existing.StoragePath)))
            existing.BookId = book_id if book_id is not None else existing.BookId
            existing.PageId = page_id if page_id is not None else existing.PageId
            existing.PageRevisionId = (
                page_revision_id if page_revision_id is not None else existing.PageRevisionId
            )
            existing.NormalizedText = normalized_text
            existing.StorageBucket = storage_bucket
            existing.StoragePath = storage_path
            existing.ByteSize = int(byte_size)
            existing.DurationSeconds = duration_seconds
            existing.WordTimingsJson = word_timings_json
            existing.LastAccessedAt = ts
            existing.UpdatedAt = ts
            await self.db.flush()
            return existing, replaced

        entry = TtsAudioCacheEntry(
            Id=uuid4(),
            Scope=scope,
            OwnerParentId=owner_parent_id,
            BookId=book_id,
            PageId=page_id,
            PageRevisionId=page_revision_id,
            ContentSha256=content_sha256,
            NormalizedText=normalized_text,
            VoiceId=voice_id,
            ModelVersion=model_version,
            Speed=q_speed,
            AudioFormat=audio_format,
            StorageBucket=storage_bucket,
            StoragePath=storage_path,
            ByteSize=int(byte_size),
            DurationSeconds=duration_seconds,
            WordTimingsJson=word_timings_json,
            Status="ACTIVE",
            LastAccessedAt=ts,
            HitCount=0,
            CreatedAt=ts,
            UpdatedAt=ts,
        )
        self.db.add(entry)
        await self.db.flush()
        return entry, replaced

    async def _increment_daily_usage(
        self,
        *,
        usage_day: date,
        now: datetime,
        bytes_delta: int = 0,
        hit_delta: int = 0,
        miss_delta: int = 0,
    ) -> None:
        safe_bytes = max(0, int(bytes_delta))
        safe_hits = max(0, int(hit_delta))
        safe_misses = max(0, int(miss_delta))
        bind = getattr(self.db, "bind", None)
        if bind is None:
            try:
                bind = self.db.get_bind()
            except Exception:
                bind = None
        dialect_name = getattr(getattr(bind, "dialect", None), "name", "") if bind is not None else ""
        if not isinstance(dialect_name, str):
            dialect_name = ""

        values = {
            "UsageDate": usage_day,
            "BytesServed": safe_bytes,
            "HitCount": safe_hits,
            "MissCount": safe_misses,
            "UpdatedAt": now,
        }
        if dialect_name == "postgresql":
            pg_stmt = pg_insert(TtsAudioCacheDailyUsage).values(**values)
            pg_stmt = pg_stmt.on_conflict_do_update(
                index_elements=[TtsAudioCacheDailyUsage.UsageDate],
                set_={
                    TtsAudioCacheDailyUsage.BytesServed: TtsAudioCacheDailyUsage.BytesServed + safe_bytes,
                    TtsAudioCacheDailyUsage.HitCount: TtsAudioCacheDailyUsage.HitCount + safe_hits,
                    TtsAudioCacheDailyUsage.MissCount: TtsAudioCacheDailyUsage.MissCount + safe_misses,
                    TtsAudioCacheDailyUsage.UpdatedAt: now,
                },
            )
            await self.db.execute(pg_stmt)
            return
        if dialect_name == "sqlite":
            sq_stmt = sqlite_insert(TtsAudioCacheDailyUsage).values(**values)
            sq_stmt = sq_stmt.on_conflict_do_update(
                index_elements=[TtsAudioCacheDailyUsage.UsageDate],
                set_={
                    TtsAudioCacheDailyUsage.BytesServed: TtsAudioCacheDailyUsage.BytesServed + safe_bytes,
                    TtsAudioCacheDailyUsage.HitCount: TtsAudioCacheDailyUsage.HitCount + safe_hits,
                    TtsAudioCacheDailyUsage.MissCount: TtsAudioCacheDailyUsage.MissCount + safe_misses,
                    TtsAudioCacheDailyUsage.UpdatedAt: now,
                },
            )
            await self.db.execute(sq_stmt)
            return

        row = await self.db.get(TtsAudioCacheDailyUsage, usage_day)
        if row is None:
            row = TtsAudioCacheDailyUsage(
                UsageDate=usage_day,
                BytesServed=safe_bytes,
                HitCount=safe_hits,
                MissCount=safe_misses,
                UpdatedAt=now,
            )
            self.db.add(row)
            await self.db.flush()
            return
        row.BytesServed = int(row.BytesServed or 0) + safe_bytes
        row.HitCount = int(row.HitCount or 0) + safe_hits
        row.MissCount = int(row.MissCount or 0) + safe_misses
        row.UpdatedAt = now

    async def get_daily_usage(self, usage_day: date | None = None) -> dict[str, int]:
        day = usage_day or datetime.now(timezone.utc).date()
        row = await self.db.get(TtsAudioCacheDailyUsage, day)
        if row is None:
            return {"bytes_served": 0, "hit_count": 0, "miss_count": 0}
        return {
            "bytes_served": int(row.BytesServed or 0),
            "hit_count": int(row.HitCount or 0),
            "miss_count": int(row.MissCount or 0),
        }

    async def record_hit(
        self,
        entry_id: UUID,
        *,
        byte_size: int,
        now: datetime | None = None,
    ) -> None:
        ts = now or datetime.now(timezone.utc)
        await self.db.execute(
            update(TtsAudioCacheEntry)
            .where(TtsAudioCacheEntry.Id == entry_id, TtsAudioCacheEntry.Status == "ACTIVE")
            .values(
                HitCount=TtsAudioCacheEntry.HitCount + 1,
                LastAccessedAt=ts,
                UpdatedAt=ts,
            )
        )
        await self._increment_daily_usage(
            usage_day=ts.date(),
            now=ts,
            bytes_delta=max(0, int(byte_size)),
            hit_delta=1,
        )

    async def record_miss(self, *, now: datetime | None = None) -> None:
        ts = now or datetime.now(timezone.utc)
        await self._increment_daily_usage(
            usage_day=ts.date(),
            now=ts,
            miss_delta=1,
        )

    async def total_active_bytes(self) -> int:
        total = await self.db.scalar(
            select(func.coalesce(func.sum(TtsAudioCacheEntry.ByteSize), 0)).where(
                TtsAudioCacheEntry.Status == "ACTIVE"
            )
        )
        return int(total or 0)

    async def list_lru_eviction_candidates(
        self,
        *,
        exclude_ids: Sequence[UUID] = (),
        limit: int = 100,
    ) -> list[TtsAudioCacheEntry]:
        filters = [TtsAudioCacheEntry.Status == "ACTIVE"]
        if exclude_ids:
            filters.append(TtsAudioCacheEntry.Id.not_in(list(exclude_ids)))
        result = await self.db.execute(
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(TtsAudioCacheEntry.LastAccessedAt.asc(), TtsAudioCacheEntry.CreatedAt.asc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def mark_entries_status(
        self,
        entry_ids: Sequence[UUID],
        *,
        status: str,
        now: datetime | None = None,
    ) -> int:
        if not entry_ids:
            return 0
        ts = now or datetime.now(timezone.utc)
        res = await self.db.execute(
            update(TtsAudioCacheEntry)
            .where(TtsAudioCacheEntry.Id.in_(list(entry_ids)))
            .values(Status=status, UpdatedAt=ts)
        )
        return int(res.rowcount or 0)

    async def mark_stale_for_target(
        self,
        *,
        book_id: UUID | None = None,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
        now: datetime | None = None,
    ) -> list[tuple[str, str]]:
        predicates = []
        if book_id is not None:
            predicates.append(TtsAudioCacheEntry.BookId == book_id)
        if page_id is not None:
            predicates.append(TtsAudioCacheEntry.PageId == page_id)
        if page_revision_id is not None:
            predicates.append(TtsAudioCacheEntry.PageRevisionId == page_revision_id)
        if not predicates:
            return []

        rows = (
            await self.db.execute(
                select(TtsAudioCacheEntry.Id, TtsAudioCacheEntry.StorageBucket, TtsAudioCacheEntry.StoragePath)
                .where(
                    TtsAudioCacheEntry.Status == "ACTIVE",
                    or_(*predicates),
                )
            )
        ).all()
        if not rows:
            return []

        ts = now or datetime.now(timezone.utc)
        ids = [row.Id for row in rows]
        await self.db.execute(
            update(TtsAudioCacheEntry)
            .where(TtsAudioCacheEntry.Id.in_(ids))
            .values(Status="STALE", UpdatedAt=ts)
        )
        return [(str(row.StorageBucket), str(row.StoragePath)) for row in rows]

    async def get_summary(self, *, now: datetime | None = None) -> dict[str, Any]:
        ts = now or datetime.now(timezone.utc)
        agg = (
            await self.db.execute(
                select(
                    func.count(TtsAudioCacheEntry.Id).label("entry_count"),
                    func.coalesce(func.sum(TtsAudioCacheEntry.ByteSize), 0).label("storage_used_bytes"),
                ).where(TtsAudioCacheEntry.Status == "ACTIVE")
            )
        ).one()
        daily = await self.get_daily_usage(ts.date())
        return {
            "entry_count": int(agg.entry_count or 0),
            "storage_used_bytes": int(agg.storage_used_bytes or 0),
            "daily_egress_bytes": int(daily["bytes_served"]),
            "hit_count": int(daily["hit_count"]),
            "miss_count": int(daily["miss_count"]),
        }
