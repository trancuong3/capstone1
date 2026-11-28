"""Repository for precomputed and cached TTS audio metadata & daily egress tracking."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Sequence
from uuid import UUID, uuid4

from sqlalchemy import and_, case, delete, func, literal_column, or_, select, text, true, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    PageRevision,
    PageRevisionWord,
    TtsAudioCacheDailyUsage,
    TtsAudioCacheEntry,
)

_ZERO_UUID_LITERAL = literal_column("'00000000-0000-0000-0000-000000000000'::uuid")


class TtsAudioCacheRepository:
    """Data-access layer for `tts_audio_cache_entries` and daily egress counters."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    @staticmethod
    def _quantize_speed(speed: float) -> Decimal:
        return Decimal(f"{float(speed):.2f}")

    def _get_dialect_name(self) -> str:
        bind = getattr(self.db, "bind", None)
        if bind is None:
            try:
                bind = self.db.get_bind()
            except Exception:
                bind = None
        dialect_name = getattr(getattr(bind, "dialect", None), "name", "") if bind is not None else ""
        return dialect_name if isinstance(dialect_name, str) else ""

    def _owner_filter_predicates(
        self, scope: str, owner_parent_id: UUID | None
    ) -> list[Any]:
        """Match OwnerParentId AND align with `uq_tts_cache_active_key`'s COALESCE expression on Postgres."""
        if scope == "PRIVATE":
            preds: list[Any] = [TtsAudioCacheEntry.OwnerParentId == owner_parent_id]
            if self._get_dialect_name() == "postgresql":
                preds.append(
                    func.coalesce(TtsAudioCacheEntry.OwnerParentId, _ZERO_UUID_LITERAL)
                    == owner_parent_id
                )
            return preds
        preds = [TtsAudioCacheEntry.OwnerParentId.is_(None)]
        if self._get_dialect_name() == "postgresql":
            preds.append(
                func.coalesce(TtsAudioCacheEntry.OwnerParentId, _ZERO_UUID_LITERAL)
                == _ZERO_UUID_LITERAL
            )
        return preds

    def _require_word_timings_filters(self) -> list[Any]:
        """Exclude both SQL NULL and legacy JSONB literal `'null'::jsonb` when timings are required."""
        filters: list[Any] = [TtsAudioCacheEntry.WordTimingsJson.is_not(None)]
        if self._get_dialect_name() == "postgresql":
            filters.append(func.jsonb_typeof(TtsAudioCacheEntry.WordTimingsJson) != "null")
        return filters

    @staticmethod
    def _format_priority_expr(audio_formats: Sequence[str]):
        order_map = {fmt: idx for idx, fmt in enumerate(audio_formats)}
        return case(
            order_map,
            value=TtsAudioCacheEntry.AudioFormat,
            else_=len(order_map),
        )

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
            *self._owner_filter_predicates(scope, owner_parent_id),
            TtsAudioCacheEntry.ContentSha256 == content_sha256,
            TtsAudioCacheEntry.VoiceId == voice_id,
            TtsAudioCacheEntry.Speed == self._quantize_speed(speed),
            TtsAudioCacheEntry.AudioFormat.in_(list(audio_formats)),
        ]
        if model_version:
            filters.append(TtsAudioCacheEntry.ModelVersion == model_version)
        if require_word_timings:
            filters.extend(self._require_word_timings_filters())

        stmt = (
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(
                self._format_priority_expr(audio_formats).asc(),
                TtsAudioCacheEntry.CreatedAt.desc(),
            )
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
            *self._owner_filter_predicates(scope, owner_parent_id),
            TtsAudioCacheEntry.ContentSha256 == content_sha256,
            TtsAudioCacheEntry.VoiceId == voice_id,
            TtsAudioCacheEntry.AudioFormat.in_(list(audio_formats)),
        ]
        if model_version:
            filters.append(TtsAudioCacheEntry.ModelVersion == model_version)
        if require_word_timings:
            filters.extend(self._require_word_timings_filters())

        stmt = (
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(
                func.abs(TtsAudioCacheEntry.Speed - q_speed).asc(),
                self._format_priority_expr(audio_formats).asc(),
                TtsAudioCacheEntry.CreatedAt.desc(),
            )
            .limit(1)
        )
        return await self.db.scalar(stmt)

    async def get_active_timed_entries_for_page(
        self,
        *,
        scope: str,
        page_id: UUID,
        voice_id: str,
        model_version: str | None,
        speed: float,
        audio_formats: Sequence[str],
        allow_speed_fallback: bool = False,
        limit: int = 8,
    ) -> list[TtsAudioCacheEntry]:
        if scope != "CATALOG":
            return []
        q_speed = self._quantize_speed(speed)
        filters = [
            TtsAudioCacheEntry.Status == "ACTIVE",
            TtsAudioCacheEntry.Scope == "CATALOG",
            TtsAudioCacheEntry.OwnerParentId.is_(None),
            TtsAudioCacheEntry.PageId == page_id,
            TtsAudioCacheEntry.VoiceId == voice_id,
            TtsAudioCacheEntry.AudioFormat.in_(list(audio_formats)),
            *self._require_word_timings_filters(),
        ]
        if not allow_speed_fallback:
            filters.append(TtsAudioCacheEntry.Speed == q_speed)
        if model_version:
            filters.append(TtsAudioCacheEntry.ModelVersion == model_version)

        order_by = (
            [
                func.abs(TtsAudioCacheEntry.Speed - q_speed).asc(),
                self._format_priority_expr(audio_formats).asc(),
                TtsAudioCacheEntry.CreatedAt.desc(),
            ]
            if allow_speed_fallback
            else [
                self._format_priority_expr(audio_formats).asc(),
                TtsAudioCacheEntry.CreatedAt.desc(),
            ]
        )
        stmt = (
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(*order_by)
            .limit(max(1, min(int(limit), 16)))
        )
        return list((await self.db.scalars(stmt)).all())

    async def get_best_active_entries(
        self,
        *,
        scope: str,
        owner_parent_id: UUID | None,
        content_sha256: str,
        voice_id: str,
        model_version: str | None,
        preferred_model_version: str | None = None,
        speed: float,
        audio_formats: Sequence[str],
        folded_sha256: str | None = None,
        page_id: UUID | None = None,
        allow_page_timed_fallback: bool = False,
        allow_speed_fallback: bool = True,
        require_word_timings: bool = False,
        include_coaching_fallback: bool = False,
        limit: int = 8,
    ) -> list[TtsAudioCacheEntry]:
        """Single-query prioritized TTS cache lookup across exact, folded, page-timed, nearest-speed, and COACHING fallback."""
        if scope == "PRIVATE" and owner_parent_id is None:
            return []
        q_speed = self._quantize_speed(speed)
        format_list = list(audio_formats)
        if not format_list:
            return []

        primary_scope_pred = and_(
            TtsAudioCacheEntry.Scope == scope,
            *self._owner_filter_predicates(scope, owner_parent_id),
        )

        sha_candidates = [content_sha256]
        if folded_sha256 and folded_sha256 != content_sha256 and scope == "CATALOG":
            sha_candidates.append(folded_sha256)

        match_predicates: list[Any] = [
            and_(
                primary_scope_pred,
                TtsAudioCacheEntry.ContentSha256.in_(sha_candidates),
            )
        ]

        can_page_fallback = (
            allow_page_timed_fallback
            and scope == "CATALOG"
            and page_id is not None
        )
        if can_page_fallback:
            match_predicates.append(
                and_(
                    primary_scope_pred,
                    TtsAudioCacheEntry.PageId == page_id,
                    ~TtsAudioCacheEntry.NormalizedText.like("phonics:%"),
                    *self._require_word_timings_filters(),
                )
            )

        can_coaching_fallback = (
            include_coaching_fallback
            and scope == "CATALOG"
        )
        if can_coaching_fallback:
            match_predicates.append(
                and_(
                    TtsAudioCacheEntry.Scope == "COACHING",
                    *self._owner_filter_predicates("COACHING", None),
                    TtsAudioCacheEntry.ContentSha256 == content_sha256,
                )
            )

        filters: list[Any] = [
            TtsAudioCacheEntry.Status == "ACTIVE",
            TtsAudioCacheEntry.VoiceId == voice_id,
            TtsAudioCacheEntry.AudioFormat.in_(format_list),
            or_(*match_predicates),
        ]
        if not allow_speed_fallback:
            filters.append(TtsAudioCacheEntry.Speed == q_speed)
        if model_version:
            filters.append(TtsAudioCacheEntry.ModelVersion == model_version)
        if require_word_timings:
            filters.extend(self._require_word_timings_filters())

        is_exact_speed = TtsAudioCacheEntry.Speed == q_speed
        is_exact_sha = TtsAudioCacheEntry.ContentSha256 == content_sha256
        rank_whens: list[tuple[Any, int]] = [
            (and_(TtsAudioCacheEntry.Scope == scope, is_exact_sha, is_exact_speed), 0),
        ]
        if folded_sha256 and folded_sha256 != content_sha256 and scope == "CATALOG":
            is_folded_sha = TtsAudioCacheEntry.ContentSha256 == folded_sha256
            rank_whens.append(
                (and_(TtsAudioCacheEntry.Scope == scope, is_folded_sha, is_exact_speed), 1)
            )
        if can_page_fallback:
            rank_whens.append(
                (and_(TtsAudioCacheEntry.Scope == scope, TtsAudioCacheEntry.PageId == page_id, is_exact_speed), 2)
            )
        rank_whens.append((and_(TtsAudioCacheEntry.Scope == scope, is_exact_sha), 3))
        if folded_sha256 and folded_sha256 != content_sha256 and scope == "CATALOG":
            is_folded_sha = TtsAudioCacheEntry.ContentSha256 == folded_sha256
            rank_whens.append((and_(TtsAudioCacheEntry.Scope == scope, is_folded_sha), 4))
        if can_page_fallback:
            rank_whens.append(
                (and_(TtsAudioCacheEntry.Scope == scope, TtsAudioCacheEntry.PageId == page_id), 5)
            )
        if can_coaching_fallback:
            rank_whens.append((and_(TtsAudioCacheEntry.Scope == "COACHING", is_exact_speed), 6))
            rank_whens.append((TtsAudioCacheEntry.Scope == "COACHING", 7))

        priority_expr = case(*rank_whens, else_=9)
        order_clauses: list[Any] = [
            priority_expr.asc(),
            func.abs(TtsAudioCacheEntry.Speed - q_speed).asc(),
        ]
        if preferred_model_version and not model_version:
            order_clauses.append(
                case(
                    (TtsAudioCacheEntry.ModelVersion == preferred_model_version, 0),
                    else_=1,
                ).asc()
            )
        order_clauses.extend(
            [
                self._format_priority_expr(format_list).asc(),
                TtsAudioCacheEntry.CreatedAt.desc(),
            ]
        )
        stmt = (
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(*order_clauses)
            .limit(max(1, min(int(limit), 16)))
        )
        return list((await self.db.scalars(stmt)).all())

    async def get_page_precomputed_timed_metadata(
        self,
        *,
        page_id: UUID,
        page_revision_id: UUID | None = None,
        voice_id: str | None = None,
        content_sha256: str | None = None,
        folded_sha256: str | None = None,
        target_speed: float | None = None,
    ) -> tuple[list[dict[str, Any]], str, float | None] | None:
        """Fetch precomputed word timings metadata for a verified public catalog page."""
        filters: list[Any] = [
            TtsAudioCacheEntry.Status == "ACTIVE",
            TtsAudioCacheEntry.Scope == "CATALOG",
            *self._owner_filter_predicates("CATALOG", None),
            TtsAudioCacheEntry.PageId == page_id,
            ~TtsAudioCacheEntry.NormalizedText.like("phonics:%"),
            *self._require_word_timings_filters(),
        ]
        if voice_id:
            filters.append(TtsAudioCacheEntry.VoiceId == voice_id)
        if target_speed is not None:
            filters.append(TtsAudioCacheEntry.Speed == self._quantize_speed(target_speed))
        order_by: list[Any] = []
        if content_sha256 or folded_sha256:
            sha_whens: list[tuple[Any, int]] = []
            if content_sha256:
                sha_whens.append((TtsAudioCacheEntry.ContentSha256 == content_sha256, 0))
            if folded_sha256 and folded_sha256 != content_sha256:
                sha_whens.append((TtsAudioCacheEntry.ContentSha256 == folded_sha256, 1))
            if sha_whens:
                order_by.append(case(*sha_whens, else_=2).asc())
        if page_revision_id is not None:
            order_by.append(
                case((TtsAudioCacheEntry.PageRevisionId == page_revision_id, 0), else_=1).asc()
            )
        desired_speed = (
            self._quantize_speed(target_speed)
            if target_speed is not None
            else Decimal("1.00")
        )
        order_by.extend(
            [
                func.abs(TtsAudioCacheEntry.Speed - desired_speed).asc(),
                TtsAudioCacheEntry.CreatedAt.desc(),
            ]
        )
        row = (
            await self.db.execute(
                select(
                    TtsAudioCacheEntry.WordTimingsJson,
                    TtsAudioCacheEntry.VoiceId,
                    TtsAudioCacheEntry.Speed,
                )
                .where(*filters)
                .order_by(*order_by)
                .limit(1)
            )
        ).first()
        if row is None or not isinstance(row.WordTimingsJson, list) or not row.WordTimingsJson:
            return None
        speed_val = float(row.Speed) if row.Speed is not None else None
        return row.WordTimingsJson, str(row.VoiceId), speed_val

    async def has_active_entry_for_storage_path(
        self,
        storage_bucket: str,
        storage_path: str,
        *,
        exclude_ids: Sequence[UUID] = (),
    ) -> bool:
        filters = [
            TtsAudioCacheEntry.Status == "ACTIVE",
            TtsAudioCacheEntry.StorageBucket == storage_bucket,
            TtsAudioCacheEntry.StoragePath == storage_path,
        ]
        if exclude_ids:
            filters.append(TtsAudioCacheEntry.Id.not_in(list(exclude_ids)))
        found = await self.db.scalar(
            select(TtsAudioCacheEntry.Id).where(*filters).limit(1)
        )
        return found is not None

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
        existing_stmt = (
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
        existing = await self.db.scalar(existing_stmt)
        replaced: list[tuple[str, str]] = []
        if existing is not None and (
            existing.StorageBucket,
            existing.StoragePath,
        ) != (storage_bucket, storage_path):
            replaced.append((str(existing.StorageBucket), str(existing.StoragePath)))

        dialect_name = self._get_dialect_name()
        if dialect_name == "postgresql":
            new_id = uuid4()
            pg_stmt = pg_insert(TtsAudioCacheEntry).values(
                Id=new_id,
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
            pg_stmt = pg_stmt.on_conflict_do_update(
                index_elements=[
                    TtsAudioCacheEntry.Scope,
                    func.coalesce(
                        TtsAudioCacheEntry.OwnerParentId,
                        literal_column("'00000000-0000-0000-0000-000000000000'::uuid"),
                    ),
                    TtsAudioCacheEntry.ContentSha256,
                    TtsAudioCacheEntry.VoiceId,
                    TtsAudioCacheEntry.ModelVersion,
                    TtsAudioCacheEntry.Speed,
                    TtsAudioCacheEntry.AudioFormat,
                ],
                index_where=TtsAudioCacheEntry.Status == "ACTIVE",
                set_={
                    "book_id": func.coalesce(pg_stmt.excluded.book_id, TtsAudioCacheEntry.BookId),
                    "page_id": func.coalesce(pg_stmt.excluded.page_id, TtsAudioCacheEntry.PageId),
                    "page_revision_id": func.coalesce(
                        pg_stmt.excluded.page_revision_id,
                        TtsAudioCacheEntry.PageRevisionId,
                    ),
                    "normalized_text": pg_stmt.excluded.normalized_text,
                    "storage_bucket": pg_stmt.excluded.storage_bucket,
                    "storage_path": pg_stmt.excluded.storage_path,
                    "byte_size": pg_stmt.excluded.byte_size,
                    "duration_seconds": func.coalesce(
                        pg_stmt.excluded.duration_seconds,
                        TtsAudioCacheEntry.DurationSeconds,
                    ),
                    "word_timings_json": func.coalesce(
                        func.nullif(
                            pg_stmt.excluded.word_timings_json,
                            literal_column("'null'::jsonb"),
                        ),
                        func.nullif(
                            TtsAudioCacheEntry.WordTimingsJson,
                            literal_column("'null'::jsonb"),
                        ),
                    ),
                    "last_accessed_at": ts,
                    "updated_at": ts,
                },
            ).returning(TtsAudioCacheEntry.Id)
            persisted_id = await self.db.scalar(pg_stmt)
            entry = await self.db.get(TtsAudioCacheEntry, persisted_id)
            if entry is None:
                entry = await self.db.scalar(existing_stmt)
            assert entry is not None
            return entry, replaced

        def _apply_update(target_row: TtsAudioCacheEntry) -> None:
            if (target_row.StorageBucket, target_row.StoragePath) != (
                storage_bucket,
                storage_path,
            ) and (str(target_row.StorageBucket), str(target_row.StoragePath)) not in replaced:
                replaced.append((str(target_row.StorageBucket), str(target_row.StoragePath)))
            target_row.BookId = book_id if book_id is not None else target_row.BookId
            target_row.PageId = page_id if page_id is not None else target_row.PageId
            target_row.PageRevisionId = (
                page_revision_id if page_revision_id is not None else target_row.PageRevisionId
            )
            target_row.NormalizedText = normalized_text
            target_row.StorageBucket = storage_bucket
            target_row.StoragePath = storage_path
            target_row.ByteSize = int(byte_size)
            if duration_seconds is not None:
                target_row.DurationSeconds = duration_seconds
            if word_timings_json is not None:
                target_row.WordTimingsJson = word_timings_json
            target_row.LastAccessedAt = ts
            target_row.UpdatedAt = ts

        if existing is not None:
            _apply_update(existing)
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
        try:
            if hasattr(self.db, "begin_nested"):
                async with self.db.begin_nested():
                    self.db.add(entry)
                    await self.db.flush()
            else:
                self.db.add(entry)
                await self.db.flush()
            return entry, replaced
        except IntegrityError:
            raced = await self.db.scalar(existing_stmt)
            if raced is None:
                raise
            _apply_update(raced)
            await self.db.flush()
            return raced, replaced

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

    async def total_active_bytes(
        self,
        *,
        scopes: Sequence[str] | None = None,
        owner_parent_id: UUID | None = None,
    ) -> int:
        filters = [TtsAudioCacheEntry.Status == "ACTIVE"]
        if scopes:
            filters.append(TtsAudioCacheEntry.Scope.in_(list(scopes)))
        if owner_parent_id is not None:
            filters.append(TtsAudioCacheEntry.OwnerParentId == owner_parent_id)
        total = await self.db.scalar(
            select(func.coalesce(func.sum(TtsAudioCacheEntry.ByteSize), 0)).where(
                *filters
            )
        )
        return int(total or 0)

    async def list_lru_eviction_candidates(
        self,
        *,
        exclude_ids: Sequence[UUID] = (),
        scopes: Sequence[str] | None = None,
        owner_parent_id: UUID | None = None,
        limit: int = 100,
    ) -> list[TtsAudioCacheEntry]:
        filters = [TtsAudioCacheEntry.Status == "ACTIVE"]
        if scopes:
            filters.append(TtsAudioCacheEntry.Scope.in_(list(scopes)))
        if owner_parent_id is not None:
            filters.append(TtsAudioCacheEntry.OwnerParentId == owner_parent_id)
        if exclude_ids:
            filters.append(TtsAudioCacheEntry.Id.not_in(list(exclude_ids)))
        stmt = (
            select(TtsAudioCacheEntry)
            .where(*filters)
            .order_by(TtsAudioCacheEntry.LastAccessedAt.asc(), TtsAudioCacheEntry.CreatedAt.asc())
            .limit(limit)
        )
        if self._get_dialect_name() == "postgresql":
            stmt = stmt.with_for_update(skip_locked=True)
        result = await self.db.execute(stmt)
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

    async def list_active_public_voice_ids(self) -> list[str]:
        rows = (
            await self.db.execute(
                select(TtsAudioCacheEntry.VoiceId)
                .distinct()
                .where(
                    TtsAudioCacheEntry.Status == "ACTIVE",
                    TtsAudioCacheEntry.Scope.in_(("CATALOG", "COACHING")),
                )
            )
        ).scalars().all()
        return sorted({str(v).strip() for v in rows if v and str(v).strip()})

    async def get_summary(self, *, now: datetime | None = None) -> dict[str, Any]:
        ts = now or datetime.now(timezone.utc)
        usage_day = ts.date()
        entry_subq = (
            select(
                func.count(TtsAudioCacheEntry.Id).label("entry_count"),
                func.coalesce(func.sum(TtsAudioCacheEntry.ByteSize), 0).label("storage_used_bytes"),
            )
            .where(TtsAudioCacheEntry.Status == "ACTIVE")
            .subquery()
        )
        daily_subq = (
            select(
                TtsAudioCacheDailyUsage.BytesServed.label("bytes_served"),
                TtsAudioCacheDailyUsage.HitCount.label("hit_count"),
                TtsAudioCacheDailyUsage.MissCount.label("miss_count"),
            )
            .where(TtsAudioCacheDailyUsage.UsageDate == usage_day)
            .limit(1)
            .subquery()
        )
        stmt = select(
            entry_subq.c.entry_count,
            entry_subq.c.storage_used_bytes,
            func.coalesce(daily_subq.c.bytes_served, 0).label("daily_egress_bytes"),
            func.coalesce(daily_subq.c.hit_count, 0).label("hit_count"),
            func.coalesce(daily_subq.c.miss_count, 0).label("miss_count"),
        ).select_from(entry_subq.outerjoin(daily_subq, true()))
        row = (await self.db.execute(stmt)).one()
        return {
            "entry_count": int(row.entry_count or 0),
            "storage_used_bytes": int(row.storage_used_bytes or 0),
            "daily_egress_bytes": int(row.daily_egress_bytes or 0),
            "hit_count": int(row.hit_count or 0),
            "miss_count": int(row.miss_count or 0),
        }

    async def is_storage_ready(self) -> bool:
        """Check whether TTS cache tables exist without mutating or aborting transactions."""
        try:
            dialect = self._get_dialect_name()
            if dialect == "sqlite":
                rows = (
                    await self.db.execute(
                        text(
                            "SELECT name FROM sqlite_master "
                            "WHERE type = 'table' "
                            "AND name IN ('tts_audio_cache_entries', 'tts_audio_cache_daily_usage')"
                        )
                    )
                ).scalars().all()
                return {str(r) for r in rows} == {
                    "tts_audio_cache_entries",
                    "tts_audio_cache_daily_usage",
                }
            entries_tbl = await self.db.scalar(
                select(text("to_regclass('public.tts_audio_cache_entries')"))
            )
            daily_tbl = await self.db.scalar(
                select(text("to_regclass('public.tts_audio_cache_daily_usage')"))
            )
            return entries_tbl is not None and daily_tbl is not None
        except Exception:
            return False

    async def prune_inactive_entries(
        self,
        *,
        older_than_days: int = 14,
        limit: int = 200,
        now: datetime | None = None,
    ) -> tuple[int, list[tuple[str, str]]]:
        """Delete aged DELETED/STALE TTS metadata rows and return unreferenced STALE objects."""
        ts = now or datetime.now(timezone.utc)
        cutoff = ts - timedelta(days=max(1, int(older_than_days)))
        effective_limit = max(1, min(1000, int(limit)))
        stmt = (
            select(
                TtsAudioCacheEntry.Id,
                TtsAudioCacheEntry.Status,
                TtsAudioCacheEntry.StorageBucket,
                TtsAudioCacheEntry.StoragePath,
            )
            .where(
                TtsAudioCacheEntry.Status.in_(("DELETED", "STALE")),
                TtsAudioCacheEntry.UpdatedAt < cutoff,
            )
            .order_by(TtsAudioCacheEntry.UpdatedAt.asc(), TtsAudioCacheEntry.Id.asc())
            .limit(effective_limit)
        )
        if self._get_dialect_name() == "postgresql":
            stmt = stmt.with_for_update(skip_locked=True)

        rows = (await self.db.execute(stmt)).all()
        if not rows:
            return 0, []

        stale_candidates: list[tuple[str, str]] = []
        seen_stale: set[tuple[str, str]] = set()
        for row in rows:
            if row.Status == "STALE" and row.StorageBucket and row.StoragePath:
                pair = (str(row.StorageBucket), str(row.StoragePath))
                if pair not in seen_stale:
                    seen_stale.add(pair)
                    stale_candidates.append(pair)

        active_pairs: set[tuple[str, str]] = set()
        if stale_candidates:
            active_rows = (
                await self.db.execute(
                    select(
                        TtsAudioCacheEntry.StorageBucket,
                        TtsAudioCacheEntry.StoragePath,
                    ).where(
                        TtsAudioCacheEntry.Status == "ACTIVE",
                        TtsAudioCacheEntry.StoragePath.in_(
                            [path for _, path in stale_candidates]
                        ),
                    )
                )
            ).all()
            active_pairs = {
                (str(bucket), str(path))
                for bucket, path in active_rows
                if bucket and path
            }

        unreferenced_stale_objects = [
            pair for pair in stale_candidates if pair not in active_pairs
        ]
        ids = [row.Id for row in rows]
        await self.db.execute(
            delete(TtsAudioCacheEntry).where(TtsAudioCacheEntry.Id.in_(ids))
        )
        return len(ids), unreferenced_stale_objects

    async def prune_daily_usage(
        self,
        *,
        retain_days: int = 90,
        limit: int = 500,
        now: datetime | None = None,
    ) -> int:
        """Delete aged daily TTS egress counters older than retain_days."""
        ts = now or datetime.now(timezone.utc)
        cutoff_date = ts.date() - timedelta(days=max(7, int(retain_days)))
        effective_limit = max(1, min(2000, int(limit)))
        stmt = (
            select(TtsAudioCacheDailyUsage.UsageDate)
            .where(TtsAudioCacheDailyUsage.UsageDate < cutoff_date)
            .order_by(TtsAudioCacheDailyUsage.UsageDate.asc())
            .limit(effective_limit)
        )
        if self._get_dialect_name() == "postgresql":
            stmt = stmt.with_for_update(skip_locked=True)

        dates = list((await self.db.execute(stmt)).scalars().all())
        if not dates:
            return 0
        res = await self.db.execute(
            delete(TtsAudioCacheDailyUsage).where(
                TtsAudioCacheDailyUsage.UsageDate.in_(dates)
            )
        )
        return int(res.rowcount or len(dates))
