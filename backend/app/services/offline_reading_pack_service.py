"""Service for Feature #8 Offline Reading Pack Manifest & Idempotent Outbox Sync."""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import inspect
import json
import math
import unicodedata
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import and_, desc, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    ChildProfile,
    FluencyAssessment,
    PageRevision,
    PageRevisionWord,
    Profile,
    ReadingEvent,
    ReadingSession,
    TtsAudioCacheEntry,
)
from app.models.offline_sync import OfflineSyncEvent
from app.policies.book_access import (
    MODERATION_SUSPENDED,
    VISIBILITY_CATALOG,
    VISIBILITY_PARENT_PRIVATE,
    is_book_private,
    is_private_page_readable,
    private_page_image_url,
)
from app.repositories.book_repository import CatalogRepository
from app.schemas.offline_reading_pack import (
    OfflinePackPageManifestDTO,
    OfflinePackPageTtsDTO,
    OfflinePackWordDTO,
    OfflineReadingPackManifestResponse,
    OfflineSyncEventItem,
    OfflineSyncEventResultDTO,
    OfflineSyncOutboxRequest,
    OfflineSyncOutboxResponse,
)
from app.schemas.reading import ReadingPageWordTimingDTO
from app.services.book_service import _resolve_cover_map
from app.services.catalog_tts_cache import (
    get_catalog_tts_default_voice_id,
    resolve_verified_catalog_tts_url,
)
from app.services.reading_content_service import ReadingContentService
from app.services.storage_service import (
    create_cached_signed_image_urls,
    create_signed_image_url,
    is_local_storage_enabled,
)
from app.services.tts_audio_cache_service import (
    ResolvedCacheTarget,
    TtsAudioCacheService,
    canonical_tts_sha256,
    canonical_tts_text,
    folded_catalog_tts_text,
    is_tts_cache_enabled,
)
from app.services.vietnamese_phonics import normalize_vietnamese_word

_ORIGINAL_CREATE_SIGNED_IMAGE_URL = create_signed_image_url

MAX_OFFLINE_PACK_PAGES = 40
MAX_PAGE_PHONICS_KEYTERMS = 48
MAX_OFFLINE_PACK_TTS_BYTES = 8 * 1024 * 1024  # 8 MiB bounded TTS budget per pack
MAX_INLINE_TTS_CLIP_BYTES = 256 * 1024  # 256 KiB single clip inline limit
MAX_INLINE_TTS_TOTAL_BYTES = 1024 * 1024  # 1 MiB total inline base64 ceiling
ESTIMATED_PAGE_IMAGE_BYTES = 110 * 1024

_VALID_READING_EVENT_TYPES = frozenset(
    {
        "OMISSION",
        "REPETITION",
        "LONG_PAUSE",
        "MISPRONUNCIATION",
        "SUBSTITUTION",
        "SELF_CORRECTION",
        "READ_EXAMPLE",
        "WORD_RETRY",
    }
)
_VALID_READING_EVENT_STATUSES = frozenset(
    {
        "DETECTED",
        "IGNORED_BY_GATE",
        "FEEDBACK_GIVEN",
        "CANDIDATE",
        "CONFIRMED",
        "FAILED",
        "UNCERTAIN",
        "DISMISSED",
    }
)


async def _release_db(db: AsyncSession | None) -> None:
    """Release open read transaction before external Storage/HTTP calls."""
    rollback = getattr(db, "rollback", None)
    if callable(rollback):
        res = rollback()
        if inspect.isawaitable(res):
            await res


@dataclass(frozen=True, slots=True)
class _PageSnapshot:
    page_id: UUID
    page_number: int
    page_revision_id: UUID
    width: int
    height: int
    image_path: str | None
    verified_text: str
    processing_meta: dict[str, Any]
    words: list[OfflinePackWordDTO]
    phonics_keyterms: list[str]


@dataclass(frozen=True, slots=True)
class _CachedTtsMetaSnapshot:
    voice_id: str
    model_version: str | None
    speed: float
    audio_format: str
    byte_size: int
    duration_seconds: float | None
    word_timings: list[ReadingPageWordTimingDTO] | None


def _extract_child_voice_preferences(settings: Any) -> tuple[str, float]:
    default_voice = get_catalog_tts_default_voice_id()
    if not isinstance(settings, dict):
        return default_voice, 1.0
    voice_prefs = settings.get("voice_preferences")
    if not isinstance(voice_prefs, dict):
        return default_voice, 1.0
    raw_voice = voice_prefs.get("voice_id")
    voice_id = (
        raw_voice.strip()
        if isinstance(raw_voice, str) and raw_voice.strip()
        else default_voice
    )
    raw_speed = voice_prefs.get("speed")
    try:
        speed = float(raw_speed) if raw_speed is not None else 1.0
    except (TypeError, ValueError):
        speed = 1.0
    if not math.isfinite(speed) or speed <= 0:
        speed = 1.0
    speed = round(max(0.7, min(1.3, speed)), 2)
    return voice_id, speed


def _extract_phonics_keyterms(words: list[OfflinePackWordDTO]) -> list[str]:
    seen: set[str] = set()
    prioritized: list[str] = []
    secondary: list[str] = []
    for item in words:
        norm = normalize_vietnamese_word(item.normalized_text or item.text)
        if not norm or len(norm) > 48 or norm in seen:
            continue
        seen.add(norm)
        # Prioritize words with Vietnamese diacritics or complex digraph onsets/codas
        has_diacritic = any(ord(ch) > 127 for ch in norm)
        has_digraph = norm.startswith(
            ("ngh", "ng", "nh", "ch", "gh", "gi", "kh", "ph", "qu", "th", "tr")
        ) or norm.endswith(("ch", "ng", "nh"))
        if has_diacritic or has_digraph or len(norm) >= 4:
            prioritized.append(norm)
        else:
            secondary.append(norm)
    combined = prioritized + secondary
    return combined[:MAX_PAGE_PHONICS_KEYTERMS]


def _parse_word_timings(
    raw_timings: Any, expected_word_count: int
) -> list[ReadingPageWordTimingDTO] | None:
    if not isinstance(raw_timings, list) or not raw_timings:
        return None
    if expected_word_count > 0 and len(raw_timings) != expected_word_count:
        return None
    parsed: list[ReadingPageWordTimingDTO] = []
    for idx, entry in enumerate(raw_timings):
        if not isinstance(entry, dict) or "id" in entry:
            return None
        try:
            start_val = float(entry.get("start", -1.0))
            end_val = float(entry.get("end", -1.0))
        except (TypeError, ValueError):
            return None
        if (
            not (math.isfinite(start_val) and math.isfinite(end_val))
            or start_val < 0.0
            or end_val < start_val
        ):
            return None
        parsed.append(
            ReadingPageWordTimingDTO(
                index=idx,
                start=round(start_val, 3),
                end=round(end_val, 3),
            )
        )
    return parsed or None


def _compute_event_payload_hash(item: OfflineSyncEventItem) -> str:
    canonical = {
        "client_event_id": str(item.client_event_id),
        "client_session_id": str(item.client_session_id),
        "book_id": str(item.book_id),
        "page_id": str(item.page_id),
        "page_revision_id": str(item.page_revision_id),
        "event_kind": item.event_kind,
        "word_id": str(item.word_id) if item.word_id else None,
        "word_text": item.word_text,
        "transcript": item.transcript,
        "is_correct": item.is_correct,
        "score": item.score,
    }
    serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


class OfflineReadingPackService:
    """Builds strictly scoped offline reading pack manifests & reconciles outbox batches."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        tts_cache_service: TtsAudioCacheService | None = None,
    ) -> None:
        self.db = db
        self.tts_cache = tts_cache_service or TtsAudioCacheService(db)

    async def _require_active_parent(self, actor_id: UUID) -> None:
        role = await self.db.scalar(
            select(Profile.Role).where(
                Profile.Id == actor_id,
                Profile.Active == 1,
            )
        )
        if role != "parent":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Parent access required",
            )

    async def _require_owned_child(
        self, child_id: UUID, actor_id: UUID
    ) -> tuple[UUID, int, dict[str, Any]]:
        await self._require_active_parent(actor_id)
        row = (
            await self.db.execute(
                select(
                    ChildProfile.Id,
                    ChildProfile.Grade,
                    ChildProfile.Settings,
                ).where(
                    ChildProfile.Id == child_id,
                    ChildProfile.ParentId == actor_id,
                )
            )
        ).first()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        settings = dict(row.Settings) if isinstance(row.Settings, dict) else {}
        return row.Id, int(row.Grade), settings

    async def _require_pack_readable_book(
        self, book_id: UUID, actor_id: UUID
    ) -> tuple[UUID, str, str | None, int, int, str, UUID | None]:
        book = await self.db.scalar(
            select(Book).where(
                Book.Id == book_id,
                Book.IsDeleted.is_(False),
            )
        )
        if book is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource not found",
            )

        private = is_book_private(book)
        if private:
            if getattr(book, "OwnerParentId", None) != actor_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Resource not found",
                )
            if getattr(book, "ModerationStatus", "ACTIVE") == MODERATION_SUSPENDED:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "CONTENT_INACTIVE",
                        "message": "Sách riêng này đang bị tạm ngừng đọc.",
                    },
                )
            if book.LifecycleStatus != "ACTIVE":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"code": "CONTENT_INACTIVE"},
                )
            scope: str = VISIBILITY_PARENT_PRIVATE
        else:
            if book.LifecycleStatus != "ACTIVE":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"code": "CONTENT_INACTIVE"},
                )
            catalog_repo = CatalogRepository(self.db)
            if not await catalog_repo.is_eligible(book_id):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "BOOK_BLOCKED_BY_CHILD_SAFETY",
                        "message": "Sách chưa hoàn tất OCR và Child Safety cho toàn bộ trang.",
                    },
                )
            scope = VISIBILITY_CATALOG

        return (
            book.Id,
            str(book.Title),
            str(book.Author) if book.Author is not None else None,
            int(book.MinGrade),
            int(book.MaxGrade),
            scope,
            getattr(book, "OwnerParentId", None),
        )

    async def _query_cached_tts_by_page(
        self,
        *,
        pages: list[_PageSnapshot],
        is_private: bool,
        actor_id: UUID,
        voice_id: str,
        speed: float,
    ) -> dict[UUID, _CachedTtsMetaSnapshot]:
        if not pages or not is_tts_cache_enabled():
            return {}

        scope = "PRIVATE" if is_private else "CATALOG"
        sha_to_pages: dict[str, list[_PageSnapshot]] = {}
        for snap in pages:
            norm = canonical_tts_text(snap.verified_text)
            if not norm:
                continue
            sha = canonical_tts_sha256(norm)
            sha_to_pages.setdefault(sha, []).append(snap)
            if not is_private:
                folded = folded_catalog_tts_text(norm)
                if folded and folded != norm:
                    folded_sha = canonical_tts_sha256(folded)
                    sha_to_pages.setdefault(folded_sha, []).append(snap)

        if not sha_to_pages:
            return {}

        filters = [
            TtsAudioCacheEntry.Status == "ACTIVE",
            TtsAudioCacheEntry.Scope == scope,
            TtsAudioCacheEntry.ContentSha256.in_(list(sha_to_pages.keys())),
            TtsAudioCacheEntry.VoiceId == voice_id,
        ]
        if is_private:
            filters.append(TtsAudioCacheEntry.OwnerParentId == actor_id)
        else:
            filters.append(TtsAudioCacheEntry.OwnerParentId.is_(None))

        rows = (
            await self.db.scalars(
                select(TtsAudioCacheEntry)
                .where(*filters)
                .order_by(desc(TtsAudioCacheEntry.CreatedAt))
            )
        ).all()

        matched: dict[UUID, _CachedTtsMetaSnapshot] = {}
        for entry in rows:
            cand_sha = str(getattr(entry, "ContentSha256", "") or "")
            for page_snap in sha_to_pages.get(cand_sha, []):
                if page_snap.page_id in matched:
                    continue
                entry_speed = (
                    round(float(entry.Speed), 2)
                    if getattr(entry, "Speed", None) is not None
                    else speed
                )
                timings = _parse_word_timings(
                    getattr(entry, "WordTimingsJson", None),
                    len(page_snap.words),
                )
                matched[page_snap.page_id] = _CachedTtsMetaSnapshot(
                    voice_id=str(entry.VoiceId),
                    model_version=(
                        str(entry.ModelVersion)
                        if getattr(entry, "ModelVersion", None)
                        else None
                    ),
                    speed=entry_speed,
                    audio_format=str(entry.AudioFormat or "audio/mpeg"),
                    byte_size=max(0, int(entry.ByteSize or 0)),
                    duration_seconds=(
                        float(entry.DurationSeconds)
                        if getattr(entry, "DurationSeconds", None) is not None
                        else None
                    ),
                    word_timings=timings,
                )
        return matched

    async def build_pack_manifest(
        self,
        *,
        actor_id: UUID,
        child_id: UUID,
        book_id: UUID,
        base_url: str | None = None,
        include_inline_tts: bool = False,
        max_tts_bytes: int = MAX_OFFLINE_PACK_TTS_BYTES,
    ) -> OfflineReadingPackManifestResponse:
        _, child_grade, child_settings = await self._require_owned_child(
            child_id, actor_id
        )
        voice_id, preferred_speed = _extract_child_voice_preferences(child_settings)
        (
            resolved_book_id,
            book_title,
            book_author,
            min_grade,
            max_grade,
            visibility_scope,
            owner_parent_id,
        ) = await self._require_pack_readable_book(book_id, actor_id)
        is_private = visibility_scope == VISIBILITY_PARENT_PRIVATE

        page_criteria = [
            BookPage.BookId == resolved_book_id,
            BookPage.LifecycleStatus == "ACTIVE",
            PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
            PageRevision.PageId == BookPage.Id,
            PageRevision.VerificationStatus == "VERIFIED",
        ]
        if is_private:
            page_criteria.append(is_private_page_readable())

        page_rows = (
            await self.db.execute(
                select(BookPage, PageRevision)
                .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                .where(*page_criteria)
                .order_by(BookPage.PageNumber.asc())
                .limit(MAX_OFFLINE_PACK_PAGES)
            )
        ).all()

        if not page_rows:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "Sách chưa có trang đã xác minh sẵn sàng để tải ngoại tuyến.",
                },
            )

        rev_ids = [rev.Id for _, rev in page_rows]
        word_rows = (
            await self.db.scalars(
                select(PageRevisionWord)
                .where(PageRevisionWord.PageRevisionId.in_(rev_ids))
                .order_by(
                    PageRevisionWord.PageRevisionId,
                    PageRevisionWord.WordIndex.asc(),
                    PageRevisionWord.Id.asc(),
                )
            )
        ).all()

        words_by_rev: dict[UUID, list[OfflinePackWordDTO]] = {}
        for w_row in word_rows:
            box = ReadingContentService._valid_bbox(w_row.BoundingBox)
            raw_text = unicodedata.normalize("NFC", str(w_row.Text or "")).strip()
            if box is None or not raw_text:
                continue
            norm_text = unicodedata.normalize(
                "NFC", str(w_row.NormalizedText or "")
            ).strip() or normalize_vietnamese_word(raw_text)
            words_by_rev.setdefault(w_row.PageRevisionId, []).append(
                OfflinePackWordDTO(
                    word_id=w_row.Id,
                    word_index=max(0, int(w_row.WordIndex or 0)),
                    line_index=max(0, int(getattr(w_row, "LineIndex", 0) or 0)),
                    text=raw_text,
                    normalized_text=norm_text,
                    bbox=box,
                )
            )

        page_snapshots: list[_PageSnapshot] = []
        for page_orm, rev_orm in page_rows:
            verified_text = unicodedata.normalize(
                "NFC", str(rev_orm.VerifiedText or "")
            ).strip()
            words_for_page = words_by_rev.get(rev_orm.Id, [])
            if not verified_text or not words_for_page:
                continue

            proc_meta = (
                dict(rev_orm.ProcessingMeta)
                if isinstance(rev_orm.ProcessingMeta, dict)
                else {}
            )
            source_path = proc_meta.get("source_image_path")
            source_w = proc_meta.get("source_image_width")
            source_h = proc_meta.get("source_image_height")
            if (
                isinstance(source_path, str)
                and source_path.strip()
                and type(source_w) is int
                and type(source_h) is int
                and source_w > 0
                and source_h > 0
            ):
                img_path: str | None = source_path.strip()
                width = source_w
                height = source_h
            else:
                img_path = (
                    page_orm.ImagePath.strip()
                    if isinstance(page_orm.ImagePath, str) and page_orm.ImagePath.strip()
                    else None
                )
                width = max(1, int(page_orm.Width or 1000))
                height = max(1, int(page_orm.Height or 1000))

            page_snapshots.append(
                _PageSnapshot(
                    page_id=page_orm.Id,
                    page_number=int(page_orm.PageNumber),
                    page_revision_id=rev_orm.Id,
                    width=width,
                    height=height,
                    image_path=img_path,
                    verified_text=verified_text,
                    processing_meta=proc_meta,
                    words=words_for_page,
                    phonics_keyterms=_extract_phonics_keyterms(words_for_page),
                )
            )

        if not page_snapshots:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "Trang sách chưa có dữ liệu từ hợp lệ để đọc ngoại tuyến.",
                },
            )

        cached_tts_map = await self._query_cached_tts_by_page(
            pages=page_snapshots,
            is_private=is_private,
            actor_id=actor_id,
            voice_id=voice_id,
            speed=preferred_speed,
        )

        cover_map = await _resolve_cover_map(
            self.db,
            [resolved_book_id],
            private_book_ids={resolved_book_id} if is_private else set(),
            require_begin_nested=False,
        )
        cover_url = cover_map.get(resolved_book_id, (None, ""))[0]

        # Snapshot complete -> release DB transaction BEFORE Storage URL signing or TTS lookup I/O.
        await _release_db(self.db)

        image_urls_by_page: dict[UUID, str | None] = {}
        if is_private:
            for snap in page_snapshots:
                image_urls_by_page[snap.page_id] = await asyncio.to_thread(
                    private_page_image_url,
                    resolved_book_id,
                    snap.page_id,
                    revision_id=snap.page_revision_id,
                    base_url=base_url,
                    storage_path=snap.image_path,
                    owner_id=owner_parent_id,
                )
        else:
            paths_with_ids = [
                (snap.page_id, snap.image_path)
                for snap in page_snapshots
                if snap.image_path
            ]
            if paths_with_ids:
                try:
                    if create_signed_image_url is not _ORIGINAL_CREATE_SIGNED_IMAGE_URL:
                        signed = [
                            await asyncio.to_thread(create_signed_image_url, p)
                            for _, p in paths_with_ids
                        ]
                    else:
                        signed = await asyncio.to_thread(
                            create_cached_signed_image_urls,
                            [p for _, p in paths_with_ids],
                        )
                    for (pid, _), url in zip(paths_with_ids, signed):
                        image_urls_by_page[pid] = url
                except Exception:
                    for pid, _ in paths_with_ids:
                        image_urls_by_page[pid] = None

        bounded_tts_cap = max(64 * 1024, min(MAX_OFFLINE_PACK_TTS_BYTES, int(max_tts_bytes)))
        used_tts_bytes = 0
        used_inline_bytes = 0
        estimated_total_bytes = 0
        manifest_pages: list[OfflinePackPageManifestDTO] = []
        clean_base = (base_url or "").rstrip("/")

        for snap in page_snapshots:
            text_bytes = len(snap.verified_text.encode("utf-8")) + (len(snap.words) * 48)
            img_url = image_urls_by_page.get(snap.page_id)
            img_est = ESTIMATED_PAGE_IMAGE_BYTES if img_url else 0

            cache_scope_literal = "PRIVATE" if is_private else "CATALOG"
            cached_meta = cached_tts_map.get(snap.page_id)
            public_catalog_audio_url = (
                None
                if is_private
                else resolve_verified_catalog_tts_url(
                    is_public_catalog=True,
                    is_verified=True,
                    text=snap.verified_text,
                    processing_meta=snap.processing_meta,
                    voice_id=voice_id,
                    speed=preferred_speed,
                )
            )

            tts_dto: OfflinePackPageTtsDTO | None = None
            authenticated_clip_path = (
                f"{clean_base}/offline/children/{child_id}/books/{resolved_book_id}"
                f"/pages/{snap.page_id}/tts-audio?voice_id={voice_id}&speed={preferred_speed:.2f}"
            )

            if cached_meta is not None and (used_tts_bytes + cached_meta.byte_size) <= bounded_tts_cap:
                used_tts_bytes += cached_meta.byte_size
                inline_b64: str | None = None
                if (
                    include_inline_tts
                    and 0 < cached_meta.byte_size <= MAX_INLINE_TTS_CLIP_BYTES
                    and (used_inline_bytes + cached_meta.byte_size) <= MAX_INLINE_TTS_TOTAL_BYTES
                ):
                    target = ResolvedCacheTarget(
                        scope=cache_scope_literal,
                        owner_parent_id=actor_id if is_private else None,
                        book_id=resolved_book_id,
                        page_id=snap.page_id,
                        page_revision_id=snap.page_revision_id,
                        can_store_on_miss=False,
                    )
                    hit = await self.tts_cache.lookup_cached_audio(
                        target=target,
                        normalized_text=canonical_tts_text(snap.verified_text),
                        voice_id=voice_id,
                        speed=preferred_speed,
                        accept="audio/mpeg",
                    )
                    if hit is not None and len(hit.content) <= MAX_INLINE_TTS_CLIP_BYTES:
                        inline_b64 = base64.b64encode(hit.content).decode("ascii")
                        used_inline_bytes += len(hit.content)

                # Private books NEVER expose public storage URLs; always use owner-authenticated route.
                resolved_audio_url = (
                    authenticated_clip_path
                    if is_private
                    else (public_catalog_audio_url or authenticated_clip_path)
                )
                tts_dto = OfflinePackPageTtsDTO(
                    cached=True,
                    cache_scope=cache_scope_literal,
                    voice_id=cached_meta.voice_id,
                    model_version=cached_meta.model_version,
                    speed=cached_meta.speed,
                    audio_format=cached_meta.audio_format,
                    byte_size=cached_meta.byte_size,
                    duration_seconds=cached_meta.duration_seconds,
                    audio_url=resolved_audio_url,
                    inline_audio_base64=inline_b64,
                    word_timings=cached_meta.word_timings,
                )
            elif public_catalog_audio_url and not is_private:
                est_clip_bytes = max(12 * 1024, min(96 * 1024, len(snap.words) * 900))
                if (used_tts_bytes + est_clip_bytes) <= bounded_tts_cap:
                    used_tts_bytes += est_clip_bytes
                    tts_dto = OfflinePackPageTtsDTO(
                        cached=True,
                        cache_scope="CATALOG",
                        voice_id=voice_id,
                        model_version=None,
                        speed=preferred_speed,
                        audio_format="audio/mpeg",
                        byte_size=est_clip_bytes,
                        duration_seconds=None,
                        audio_url=public_catalog_audio_url,
                        inline_audio_base64=None,
                        word_timings=None,
                    )
            else:
                tts_dto = OfflinePackPageTtsDTO(
                    cached=False,
                    cache_scope=cache_scope_literal,
                    voice_id=voice_id,
                    model_version=None,
                    speed=preferred_speed,
                    audio_format="audio/mpeg",
                    byte_size=0,
                    duration_seconds=None,
                    audio_url=None,
                    inline_audio_base64=None,
                    word_timings=None,
                )

            estimated_total_bytes += text_bytes + img_est + (tts_dto.byte_size if tts_dto else 0)
            manifest_pages.append(
                OfflinePackPageManifestDTO(
                    page_id=snap.page_id,
                    page_number=snap.page_number,
                    page_revision_id=snap.page_revision_id,
                    width=snap.width,
                    height=snap.height,
                    verified_text=snap.verified_text,
                    words=snap.words,
                    phonics_keyterms=snap.phonics_keyterms,
                    image_url=img_url,
                    tts_audio=tts_dto,
                )
            )

        effective_grade = max(min_grade, min(max_grade, child_grade))
        return OfflineReadingPackManifestResponse(
            manifest_version=1,
            parent_account_id=actor_id,
            child_profile_id=child_id,
            book_id=resolved_book_id,
            title=book_title,
            author=book_author,
            grade=effective_grade,
            min_grade=min_grade,
            max_grade=max_grade,
            visibility_scope=visibility_scope,  # type: ignore[arg-type]
            cover_url=cover_url,
            voice_id=voice_id,
            estimated_bytes=estimated_total_bytes,
            tts_budget_bytes=bounded_tts_cap,
            generated_at=datetime.now(timezone.utc),
            pages=manifest_pages,
        )

    async def get_pack_page_cached_tts(
        self,
        *,
        actor_id: UUID,
        child_id: UUID,
        book_id: UUID,
        page_id: UUID,
        voice_id: str | None = None,
        speed: float = 1.0,
    ) -> tuple[bytes, str]:
        _, _, child_settings = await self._require_owned_child(child_id, actor_id)
        default_voice, default_speed = _extract_child_voice_preferences(child_settings)
        resolved_voice = (voice_id or default_voice).strip() or default_voice
        resolved_speed = round(max(0.7, min(1.3, float(speed or default_speed))), 2)

        _, _, _, _, _, visibility_scope, _ = await self._require_pack_readable_book(
            book_id, actor_id
        )
        is_private = visibility_scope == VISIBILITY_PARENT_PRIVATE

        row = (
            await self.db.execute(
                select(
                    BookPage.Id,
                    BookPage.CurrentVerifiedRevisionId,
                    PageRevision.VerifiedText,
                )
                .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                .where(
                    BookPage.Id == page_id,
                    BookPage.BookId == book_id,
                    BookPage.LifecycleStatus == "ACTIVE",
                    PageRevision.VerificationStatus == "VERIFIED",
                )
            )
        ).first()
        if row is None or not (row.VerifiedText or "").strip():
            await _release_db(self.db)
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Page audio not found",
            )

        norm_text = canonical_tts_text(str(row.VerifiedText))
        rev_id = row.CurrentVerifiedRevisionId
        target = ResolvedCacheTarget(
            scope="PRIVATE" if is_private else "CATALOG",
            owner_parent_id=actor_id if is_private else None,
            book_id=book_id,
            page_id=page_id,
            page_revision_id=rev_id,
            can_store_on_miss=False,
        )
        hit = await self.tts_cache.lookup_cached_audio(
            target=target,
            normalized_text=norm_text,
            voice_id=resolved_voice,
            speed=resolved_speed,
            accept="audio/mpeg",
        )
        if hit is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Cached TTS audio unavailable for this page",
            )
        return hit.content, hit.content_type

    async def sync_outbox_batch(
        self,
        *,
        actor_id: UUID,
        child_id: UUID,
        payload: OfflineSyncOutboxRequest,
        idempotency_key: str | None = None,
    ) -> OfflineSyncOutboxResponse:
        clean_idem_key: str | None = None
        if idempotency_key is not None:
            stripped = idempotency_key.strip()
            if len(stripped) > 160:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Idempotency-Key must not exceed 160 characters",
                )
            clean_idem_key = stripped or None

        await self._require_owned_child(child_id, actor_id)

        # 1. Batch-verify book & page ownership/existence across all incoming events.
        unique_book_ids = list(dict.fromkeys(ev.book_id for ev in payload.events))
        book_rows = (
            await self.db.scalars(
                select(Book).where(
                    Book.Id.in_(unique_book_ids),
                    Book.IsDeleted.is_(False),
                )
            )
        ).all()
        books_by_id = {b.Id: b for b in book_rows}
        for bid in unique_book_ids:
            book_row = books_by_id.get(bid)
            if book_row is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Book not found",
                )
            if is_book_private(book_row) and getattr(book_row, "OwnerParentId", None) != actor_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Resource not found",
                )

        unique_page_ids = list(dict.fromkeys(ev.page_id for ev in payload.events))
        page_rows = (
            await self.db.scalars(
                select(BookPage).where(BookPage.Id.in_(unique_page_ids))
            )
        ).all()
        pages_by_id = {p.Id: p for p in page_rows}
        for ev in payload.events:
            page_row = pages_by_id.get(ev.page_id)
            if page_row is None or page_row.BookId != ev.book_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Page not found for book",
                )

        # 2. Batch-load revisions & words for revision reconciliation.
        candidate_rev_ids: set[UUID] = set()
        for ev in payload.events:
            candidate_rev_ids.add(ev.page_revision_id)
            cur_rev = pages_by_id[ev.page_id].CurrentVerifiedRevisionId
            if cur_rev is not None:
                candidate_rev_ids.add(cur_rev)

        rev_rows = (
            await self.db.scalars(
                select(PageRevision).where(PageRevision.Id.in_(list(candidate_rev_ids)))
            )
        ).all() if candidate_rev_ids else []
        revs_by_id = {r.Id: r for r in rev_rows}

        # Fallback latest revision per page if CurrentVerifiedRevisionId was cleared
        fallback_rev_by_page: dict[UUID, UUID] = {}
        missing_cur_pages = [
            pid for pid, p in pages_by_id.items() if p.CurrentVerifiedRevisionId is None
        ]
        if missing_cur_pages:
            extra_revs = (
                await self.db.scalars(
                    select(PageRevision)
                    .where(PageRevision.PageId.in_(missing_cur_pages))
                    .order_by(desc(PageRevision.CreatedAt))
                )
            ).all()
            for r in extra_revs:
                revs_by_id.setdefault(r.Id, r)
                fallback_rev_by_page.setdefault(r.PageId, r.Id)

        word_rev_ids = list(revs_by_id.keys())
        word_rows = (
            await self.db.scalars(
                select(PageRevisionWord).where(
                    PageRevisionWord.PageRevisionId.in_(word_rev_ids)
                )
            )
        ).all() if word_rev_ids else []
        words_by_rev_and_id: dict[tuple[UUID, UUID], PageRevisionWord] = {}
        words_by_rev_and_norm: dict[tuple[UUID, str], UUID] = {}
        for w in word_rows:
            words_by_rev_and_id[(w.PageRevisionId, w.Id)] = w
            norm_w = normalize_vietnamese_word(w.NormalizedText or w.Text)
            if norm_w:
                words_by_rev_and_norm.setdefault((w.PageRevisionId, norm_w), w.Id)

        # 3. Load existing ledger rows for strict (parent_id, client_event_id) idempotency.
        incoming_event_ids = list(dict.fromkeys(ev.client_event_id for ev in payload.events))
        existing_ledger_rows = (
            await self.db.scalars(
                select(OfflineSyncEvent).where(
                    OfflineSyncEvent.ParentId == actor_id,
                    OfflineSyncEvent.ClientEventId.in_(incoming_event_ids),
                )
            )
        ).all()
        existing_by_event_id = {row.ClientEventId: row for row in existing_ledger_rows}

        # 4. Preload existing client_session_id -> server_session_id mappings so multi-batch
        # offline sessions attach to the exact same ReadingSession without duplicating.
        incoming_client_sessions = list(
            dict.fromkeys(ev.client_session_id for ev in payload.events)
        )
        prior_session_ledger = (
            await self.db.execute(
                select(
                    OfflineSyncEvent.ClientSessionId,
                    OfflineSyncEvent.ServerSessionId,
                ).where(
                    OfflineSyncEvent.ParentId == actor_id,
                    OfflineSyncEvent.ChildId == child_id,
                    OfflineSyncEvent.ClientSessionId.in_(incoming_client_sessions),
                    OfflineSyncEvent.ServerSessionId.is_not(None),
                )
            )
        ).all()
        server_session_by_client_id: dict[UUID, ReadingSession] = {}
        known_server_session_ids = list(
            dict.fromkeys(
                row.ServerSessionId
                for row in prior_session_ledger
                if row.ServerSessionId is not None
            )
        )
        if known_server_session_ids:
            loaded_sessions = (
                await self.db.scalars(
                    select(ReadingSession).where(
                        ReadingSession.Id.in_(known_server_session_ids),
                        ReadingSession.ChildId == child_id,
                    )
                )
            ).all()
            loaded_by_id = {s.Id: s for s in loaded_sessions}
            for row in prior_session_ledger:
                if row.ServerSessionId in loaded_by_id:
                    server_session_by_client_id.setdefault(
                        row.ClientSessionId, loaded_by_id[row.ServerSessionId]
                    )

        results: list[OfflineSyncEventResultDTO] = []
        seen_in_request: dict[UUID, OfflineSyncEventResultDTO] = {}
        applied_count = 0
        deduplicated_count = 0
        reconciled_stale_count = 0
        now_utc = datetime.now(timezone.utc)

        for item in payload.events:
            # In-request duplicate guard
            in_req_prev = seen_in_request.get(item.client_event_id)
            if in_req_prev is not None:
                deduplicated_count += 1
                dup_dto = in_req_prev.model_copy(
                    update={"applied": False, "deduplicated": True}
                )
                results.append(dup_dto)
                continue

            # Persistent ledger duplicate guard
            existing = existing_by_event_id.get(item.client_event_id)
            if existing is not None and existing.ServerSessionId is not None:
                deduplicated_count += 1
                meta = existing.ResultMeta if isinstance(existing.ResultMeta, dict) else {}
                reading_ev_raw = meta.get("reading_event_id")
                fluency_raw = meta.get("fluency_assessment_id")
                dup_dto = OfflineSyncEventResultDTO(
                    client_event_id=item.client_event_id,
                    client_session_id=item.client_session_id,
                    server_session_id=existing.ServerSessionId,
                    applied=False,
                    deduplicated=True,
                    stale_revision_reconciled=bool(existing.StaleRevisionReconciled),
                    original_page_revision_id=item.page_revision_id,
                    effective_page_revision_id=(
                        existing.ReconciledRevisionId or existing.PageRevisionId
                    ),
                    reading_event_id=UUID(reading_ev_raw) if isinstance(reading_ev_raw, str) else None,
                    fluency_assessment_id=UUID(fluency_raw) if isinstance(fluency_raw, str) else None,
                )
                seen_in_request[item.client_event_id] = dup_dto
                results.append(dup_dto)
                continue

            page_orm = pages_by_id[item.page_id]
            current_verified_rev_id = page_orm.CurrentVerifiedRevisionId
            supplied_rev = revs_by_id.get(item.page_revision_id)
            supplied_belongs_to_page = (
                supplied_rev is not None and supplied_rev.PageId == item.page_id
            )

            # Determine whether `page_revision_id` is current or stale:
            if (
                current_verified_rev_id is not None
                and item.page_revision_id == current_verified_rev_id
                and supplied_belongs_to_page
            ):
                stale_reconciled = False
                effective_rev_id: UUID | None = current_verified_rev_id
            else:
                stale_reconciled = True
                if current_verified_rev_id is not None:
                    effective_rev_id = current_verified_rev_id
                elif supplied_belongs_to_page:
                    effective_rev_id = item.page_revision_id
                else:
                    effective_rev_id = fallback_rev_by_page.get(item.page_id)

            occurred_ts = item.occurred_at or now_utc
            if occurred_ts.tzinfo is None:
                occurred_ts = occurred_ts.replace(tzinfo=timezone.utc)

            # Resolve or create the single canonical ReadingSession for client_session_id
            reading_session = server_session_by_client_id.get(item.client_session_id)
            if reading_session is None:
                initial_state = (
                    "COMPLETED" if item.event_kind == "SESSION_FINISH" else "IN_PROGRESS"
                )
                reading_session = ReadingSession(
                    Id=uuid4(),
                    ChildId=child_id,
                    BookId=item.book_id,
                    SelectedPageId=item.page_id,
                    SelectedPageRevisionId=effective_rev_id,
                    StartPageId=item.page_id,
                    EndPageId=item.page_id,
                    CurrentPageId=item.page_id,
                    State=initial_state,
                    Mode="offline_pack",
                    StartedAt=occurred_ts,
                    EndedAt=occurred_ts if initial_state == "COMPLETED" else None,
                    ClientMeta={
                        "offline_sync": True,
                        "offline_client_session_id": str(item.client_session_id),
                        "stale_revision_reconciled": stale_reconciled,
                    },
                )
                self.db.add(reading_session)
                await self.db.flush()
                server_session_by_client_id[item.client_session_id] = reading_session
            else:
                reading_session.CurrentPageId = item.page_id
                if item.event_kind == "SESSION_FINISH" and reading_session.State not in (
                    "COMPLETED",
                    "FINISHED",
                ):
                    reading_session.State = "COMPLETED"
                    reading_session.EndedAt = occurred_ts

            # Resolve WordId safely against effective_rev_id
            resolved_word_id: UUID | None = None
            if effective_rev_id is not None:
                if (
                    item.word_id is not None
                    and (effective_rev_id, item.word_id) in words_by_rev_and_id
                ):
                    resolved_word_id = item.word_id
                else:
                    candidate_word_text = item.word_text
                    if (
                        not candidate_word_text
                        and item.word_id is not None
                        and (item.page_revision_id, item.word_id) in words_by_rev_and_id
                    ):
                        candidate_word_text = words_by_rev_and_id[
                            (item.page_revision_id, item.word_id)
                        ].Text
                    if candidate_word_text:
                        norm_target = normalize_vietnamese_word(candidate_word_text)
                        if norm_target:
                            resolved_word_id = words_by_rev_and_norm.get(
                                (effective_rev_id, norm_target)
                            )

            reading_event_id: UUID | None = None
            if (
                effective_rev_id is not None
                and item.event_kind in ("WORD_ATTEMPT", "PAGE_READ")
            ):
                ev_type = item.reading_event_type
                if ev_type not in _VALID_READING_EVENT_TYPES:
                    if item.event_kind == "WORD_ATTEMPT":
                        ev_type = (
                            "WORD_RETRY"
                            if "retry_attempt" in item.metadata
                            else (
                                "SELF_CORRECTION"
                                if item.is_correct is True
                                else "MISPRONUNCIATION"
                            )
                        )
                    else:
                        ev_type = "SELF_CORRECTION"

                ev_status = item.reading_event_status
                if ev_status not in _VALID_READING_EVENT_STATUSES:
                    if item.is_correct is True:
                        ev_status = "CONFIRMED"
                    elif item.is_correct is False:
                        ev_status = "FAILED"
                    else:
                        ev_status = "DETECTED"

                event_meta: dict[str, Any] = {
                    **item.metadata,
                    "offline_sync": True,
                    "client_event_id": str(item.client_event_id),
                    "client_session_id": str(item.client_session_id),
                    "original_page_revision_id": str(item.page_revision_id),
                    "stale_revision_reconciled": stale_reconciled,
                }
                if item.word_text:
                    event_meta["target_word"] = unicodedata.normalize(
                        "NFC", item.word_text
                    )[:120]
                if item.transcript:
                    event_meta["recognized_text"] = unicodedata.normalize(
                        "NFC", item.transcript
                    )[:500]
                if item.word_id is not None and resolved_word_id != item.word_id:
                    event_meta["original_word_id"] = str(item.word_id)

                reading_event = ReadingEvent(
                    Id=uuid4(),
                    SessionId=reading_session.Id,
                    PageId=item.page_id,
                    PageRevisionId=effective_rev_id,
                    WordId=resolved_word_id,
                    Type=ev_type,
                    StartMs=item.start_ms,
                    EndMs=item.end_ms,
                    Confidence=item.confidence,
                    Status=ev_status,
                    Metadata=event_meta,
                    CreatedAt=now_utc,
                )
                self.db.add(reading_event)
                await self.db.flush()
                reading_event_id = reading_event.Id

            fluency_assessment_id: UUID | None = None
            if item.score is not None and item.event_kind in (
                "PAGE_READ",
                "SESSION_FINISH",
            ):
                fluency = FluencyAssessment(
                    Id=uuid4(),
                    SessionId=reading_session.Id,
                    Metrics={
                        "active_reading_ms": int(item.duration_ms or 0),
                        "offline_sync": True,
                        "client_event_id": str(item.client_event_id),
                        "stale_revision_reconciled": stale_reconciled,
                        "original_page_revision_id": str(item.page_revision_id),
                    },
                    Score=round(float(item.score), 2),
                    Uncertainty=None,
                    ModelVersion="sherpa-onnx-offline-v1",
                    CreatedAt=now_utc,
                )
                self.db.add(fluency)
                await self.db.flush()
                fluency_assessment_id = fluency.Id

            stored_orig_rev_id = (
                item.page_revision_id if supplied_rev is not None else None
            )
            result_meta: dict[str, Any] = {
                "event_kind": item.event_kind,
                "original_page_revision_id": str(item.page_revision_id),
                "stale_revision_reconciled": stale_reconciled,
            }
            if reading_event_id is not None:
                result_meta["reading_event_id"] = str(reading_event_id)
            if fluency_assessment_id is not None:
                result_meta["fluency_assessment_id"] = str(fluency_assessment_id)

            ledger_row = OfflineSyncEvent(
                Id=uuid4(),
                ParentId=actor_id,
                ChildId=child_id,
                ClientEventId=item.client_event_id,
                ClientSessionId=item.client_session_id,
                ServerSessionId=reading_session.Id,
                BookId=item.book_id,
                PageId=item.page_id,
                PageRevisionId=stored_orig_rev_id,
                ReconciledRevisionId=effective_rev_id,
                EventKind=item.event_kind,
                IdempotencyKey=clean_idem_key,
                StaleRevisionReconciled=stale_reconciled,
                Status="RECONCILED" if stale_reconciled else "APPLIED",
                PayloadHash=_compute_event_payload_hash(item),
                ResultMeta=result_meta,
                OccurredAt=occurred_ts,
                CreatedAt=now_utc,
            )

            begin_nested = getattr(self.db, "begin_nested", None)
            try:
                if callable(begin_nested):
                    async with begin_nested():
                        self.db.add(ledger_row)
                        await self.db.flush()
                else:
                    self.db.add(ledger_row)
                    await self.db.flush()
            except IntegrityError:
                # Concurrent duplicate request raced us; treat cleanly as deduplicated.
                winner = await self.db.scalar(
                    select(OfflineSyncEvent).where(
                        OfflineSyncEvent.ParentId == actor_id,
                        OfflineSyncEvent.ClientEventId == item.client_event_id,
                    )
                )
                deduplicated_count += 1
                winner_session_id = (
                    winner.ServerSessionId
                    if winner is not None and winner.ServerSessionId is not None
                    else reading_session.Id
                )
                dup_dto = OfflineSyncEventResultDTO(
                    client_event_id=item.client_event_id,
                    client_session_id=item.client_session_id,
                    server_session_id=winner_session_id,
                    applied=False,
                    deduplicated=True,
                    stale_revision_reconciled=bool(
                        winner.StaleRevisionReconciled if winner else stale_reconciled
                    ),
                    original_page_revision_id=item.page_revision_id,
                    effective_page_revision_id=(
                        (winner.ReconciledRevisionId or winner.PageRevisionId)
                        if winner
                        else effective_rev_id
                    ),
                )
                seen_in_request[item.client_event_id] = dup_dto
                results.append(dup_dto)
                continue

            existing_by_event_id[item.client_event_id] = ledger_row
            applied_count += 1
            if stale_reconciled:
                reconciled_stale_count += 1

            applied_dto = OfflineSyncEventResultDTO(
                client_event_id=item.client_event_id,
                client_session_id=item.client_session_id,
                server_session_id=reading_session.Id,
                applied=True,
                deduplicated=False,
                stale_revision_reconciled=stale_reconciled,
                original_page_revision_id=item.page_revision_id,
                effective_page_revision_id=effective_rev_id,
                reading_event_id=reading_event_id,
                fluency_assessment_id=fluency_assessment_id,
            )
            seen_in_request[item.client_event_id] = applied_dto
            results.append(applied_dto)

        await self.db.commit()

        session_ids = list(dict.fromkeys(r.server_session_id for r in results))
        return OfflineSyncOutboxResponse(
            child_id=child_id,
            batch_idempotency_key=clean_idem_key,
            total_received=len(payload.events),
            applied_count=applied_count,
            deduplicated_count=deduplicated_count,
            reconciled_stale_count=reconciled_stale_count,
            session_ids=session_ids,
            results=results,
        )
