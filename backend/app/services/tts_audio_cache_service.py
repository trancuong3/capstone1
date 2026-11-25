"""Precomputed & LRU-bounded TTS audio cache service (isolation, 64kbps MP3 compression, egress cap)."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
from io import BytesIO
import json
import logging
import os
import threading
import unicodedata
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.diagnostic_logging import log_diagnostic
from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository
from app.services.storage_service import delete_object, download_object, upload_object

logger = logging.getLogger(__name__)

DEFAULT_TTS_CACHE_MAX_BYTES = 150 * 1024 * 1024  # 150 MiB
DEFAULT_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES = 300 * 1024 * 1024  # 300 MiB/day
DEFAULT_TTS_CACHE_BUCKET = "viread-tts-cache"

_EXTENSION_BY_MIME = {
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
}

_METRICS_LOCK = threading.Lock()
_RUNTIME_METRICS: dict[str, Any] = {
    "usage_date": None,
    "hits": 0,
    "misses": 0,
    "bytes_served": 0,
    "quota_exhausted": False,
}


def _reset_day_if_needed_locked(today: date) -> None:
    if _RUNTIME_METRICS["usage_date"] != today:
        _RUNTIME_METRICS["usage_date"] = today
        _RUNTIME_METRICS["hits"] = 0
        _RUNTIME_METRICS["misses"] = 0
        _RUNTIME_METRICS["bytes_served"] = 0
        _RUNTIME_METRICS["quota_exhausted"] = False


def clear_tts_cache_runtime_metrics() -> None:
    with _METRICS_LOCK:
        _RUNTIME_METRICS["usage_date"] = None
        _RUNTIME_METRICS["hits"] = 0
        _RUNTIME_METRICS["misses"] = 0
        _RUNTIME_METRICS["bytes_served"] = 0
        _RUNTIME_METRICS["quota_exhausted"] = False


def is_tts_cache_enabled() -> bool:
    return os.getenv("VIREAD_TTS_CACHE_ENABLED", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def get_tts_cache_max_bytes() -> int:
    raw = (os.getenv("VIREAD_TTS_CACHE_MAX_BYTES") or "").strip()
    if not raw:
        return DEFAULT_TTS_CACHE_MAX_BYTES
    try:
        return max(1024, int(raw))
    except ValueError:
        return DEFAULT_TTS_CACHE_MAX_BYTES


def get_tts_cache_daily_egress_limit_bytes() -> int:
    raw = (os.getenv("VIREAD_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES") or "").strip()
    if not raw:
        return DEFAULT_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES


def get_tts_cache_bucket() -> str:
    return (os.getenv("SUPABASE_TTS_CACHE_BUCKET") or DEFAULT_TTS_CACHE_BUCKET).strip() or DEFAULT_TTS_CACHE_BUCKET


def canonical_tts_text(text: str) -> str:
    return unicodedata.normalize("NFC", " ".join(str(text).split())).strip()


ALLOWED_COACHING_PHRASES_RAW: tuple[str, ...] = (
    "Tuyệt vời!",
    "Con đọc rất tốt!",
    "Chính xác rồi!",
    "Cố gắng lên nhé!",
    "Hãy đọc chậm và rõ từng chữ nhé.",
    "Hãy đọc lại từ này nhé.",
    "Mình cùng đọc tiếp trang tiếp theo nào.",
)
ALLOWED_COACHING_PHRASES: frozenset[str] = frozenset(
    canonical_tts_text(phrase) for phrase in ALLOWED_COACHING_PHRASES_RAW
)


def canonical_tts_sha256(normalized_text: str) -> str:
    return hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()


def canonical_phonics_key(steps: list[dict[str, Any]]) -> tuple[str, str]:
    payload = [
        {
            "id": str(s.get("id") or "").strip(),
            "spoken_text": canonical_tts_text(str(s.get("spoken_text") or "")),
            "pause_after_ms": int(s.get("pause_after_ms") or 420),
        }
        for s in steps
    ]
    serialized = "phonics:" + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return serialized, canonical_tts_sha256(serialized)


def detect_audio_content_type(
    audio_bytes: bytes, declared_content_type: str | None = None
) -> str:
    """Detect canonical MIME type from header magic bytes before falling back to header."""
    if len(audio_bytes) >= 12 and audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
        return "audio/wav"
    if len(audio_bytes) >= 4 and audio_bytes[:4] == b"OggS":
        return "audio/ogg"
    if len(audio_bytes) >= 3 and audio_bytes[:3] == b"ID3":
        return "audio/mpeg"
    if len(audio_bytes) >= 2 and audio_bytes[0] == 0xFF and (audio_bytes[1] & 0xE0) == 0xE0:
        return "audio/mpeg"

    declared = (declared_content_type or "").split(";")[0].strip().lower()
    if declared in {"audio/mpeg", "audio/mp3"}:
        return "audio/mpeg"
    if declared in {"audio/ogg", "audio/opus"}:
        return "audio/ogg"
    if declared in {"audio/wav", "audio/x-wav", "audio/wave"}:
        return "audio/wav"
    return "audio/wav"


def transcode_to_mp3_64k(
    audio_bytes: bytes,
    source_content_type: str | None = None,
) -> tuple[bytes, str]:
    """Compress WAV/Ogg audio to 64 kbps MP3 when PyAV (`av`) is available locally.

    Render Free omits PyAV (`requirements-web.txt`); in that environment we return
    the detected bytes unchanged without raising.
    """
    detected = detect_audio_content_type(audio_bytes, source_content_type)
    if not audio_bytes or detected == "audio/mpeg":
        return audio_bytes, detected

    try:
        import av  # type: ignore[import-not-found]
    except ImportError:
        return audio_bytes, detected

    try:
        in_buf = BytesIO(audio_bytes)
        out_buf = BytesIO()
        with av.open(in_buf, mode="r") as in_container:
            in_stream = next((s for s in in_container.streams if s.type == "audio"), None)
            if in_stream is None:
                return audio_bytes, detected
            rate = int(getattr(in_stream, "sample_rate", None) or 22050)
            with av.open(out_buf, mode="w", format="mp3") as out_container:
                out_stream = out_container.add_stream("libmp3lame", rate=rate)
                out_stream.layout = "mono"
                out_stream.bit_rate = 64_000
                resampler = av.audio.resampler.AudioResampler(
                    format="s16p",
                    layout="mono",
                    rate=rate,
                )
                for frame in in_container.decode(in_stream):
                    for resampled in resampler.resample(frame):
                        for packet in out_stream.encode(resampled):
                            out_container.mux(packet)
                for packet in out_stream.encode(None):
                    out_container.mux(packet)
        encoded = out_buf.getvalue()
        if encoded:
            return encoded, "audio/mpeg"
    except Exception as exc:
        log_diagnostic(
            logger,
            logging.WARNING,
            event="tts_cache_mp3_transcode_fallback",
            stage="tts_cache",
            exception=exc,
        )
    return audio_bytes, detected


def preferred_cache_formats(
    accept: str | None = None, audio_format: str | None = None
) -> list[str]:
    if audio_format:
        norm = audio_format.strip().lower()
        if norm == "mp3":
            return ["audio/mpeg", "audio/wav", "audio/ogg"]
        if norm == "ogg":
            return ["audio/ogg", "audio/mpeg", "audio/wav"]
        if norm == "wav":
            return ["audio/wav", "audio/mpeg", "audio/ogg"]
    lower = (accept or "").lower()
    if "audio/ogg" in lower or "audio/opus" in lower:
        return ["audio/ogg", "audio/mpeg", "audio/wav"]
    return ["audio/mpeg", "audio/ogg", "audio/wav"]


@dataclass(frozen=True, slots=True)
class ResolvedCacheTarget:
    scope: str  # CATALOG | PRIVATE | COACHING
    owner_parent_id: UUID | None
    book_id: UUID | None
    page_id: UUID | None
    page_revision_id: UUID | None
    can_store_on_miss: bool


@dataclass(frozen=True, slots=True)
class CachedTtsHit:
    content: bytes
    content_type: str
    resolved_voice_id: str
    model_version: str
    duration_seconds: float | None
    word_timings_json: list[dict[str, Any]] | dict[str, Any] | None
    scope: str
    storage_bucket: str
    storage_path: str


class TtsAudioCacheService:
    """High-level TTS audio cache lookup, bounded LRU storage, and invalidation."""

    def __init__(self, db: AsyncSession | None) -> None:
        self.db = db if isinstance(db, AsyncSession) else None
        self.repo = TtsAudioCacheRepository(self.db) if self.db is not None else None

    @staticmethod
    def _record_runtime_hit(byte_size: int) -> None:
        today = datetime.now(timezone.utc).date()
        with _METRICS_LOCK:
            _reset_day_if_needed_locked(today)
            _RUNTIME_METRICS["hits"] += 1
            _RUNTIME_METRICS["bytes_served"] += max(0, int(byte_size))

    @staticmethod
    def _record_runtime_miss() -> None:
        today = datetime.now(timezone.utc).date()
        with _METRICS_LOCK:
            _reset_day_if_needed_locked(today)
            _RUNTIME_METRICS["misses"] += 1

    @staticmethod
    def _set_quota_exhausted(exhausted: bool) -> None:
        today = datetime.now(timezone.utc).date()
        with _METRICS_LOCK:
            _reset_day_if_needed_locked(today)
            _RUNTIME_METRICS["quota_exhausted"] = bool(exhausted)

    async def _end_read_tx(self) -> None:
        """Close/commit read-only DB transaction early so pool permits never span HTTP/TTS I/O."""
        if self.db is not None:
            try:
                await self.db.commit()
            except Exception:
                await self._safe_rollback()

    async def _is_catalog_text_allowlisted(
        self,
        *,
        book_id: UUID,
        page_id: UUID | None,
        page_revision_id: UUID | None,
        normalized_text: str | None,
    ) -> bool:
        if not normalized_text or self.repo is None:
            return False
        candidate = canonical_tts_text(normalized_text)
        if not candidate:
            return False
        rows = await self.repo.get_verified_catalog_texts(
            book_id=book_id,
            page_id=page_id,
            page_revision_id=page_revision_id,
        )
        if not rows:
            return False

        punct = ".,!?;:\"'()[]{}«»…-–—"
        allowed: set[str] = set()
        for verified_text, word_pairs in rows:
            if verified_text:
                norm_page = canonical_tts_text(verified_text)
                if norm_page:
                    allowed.add(norm_page)
                    for piece in norm_page.split():
                        allowed.add(piece)
                        stripped = piece.strip(punct)
                        if stripped:
                            allowed.add(stripped)
            tokens: list[str] = []
            for norm_word, raw_word in word_pairs:
                token = canonical_tts_text(str(norm_word or raw_word or ""))
                if not token:
                    continue
                tokens.append(token)
                allowed.add(token)
                stripped_tok = token.strip(punct)
                if stripped_tok:
                    allowed.add(stripped_tok)
            if tokens:
                allowed.add(canonical_tts_text(" ".join(tokens)))
        return candidate in allowed

    async def resolve_target(
        self,
        *,
        actor_id: UUID | None,
        book_id: UUID | None = None,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
        cache_scope: str | None = None,
        normalized_text: str | None = None,
        allow_cache_write: bool = False,
    ) -> ResolvedCacheTarget | None:
        canonical_query = canonical_tts_text(normalized_text) if normalized_text else ""
        if self.repo is not None and (
            page_revision_id is not None or page_id is not None or book_id is not None
        ):
            if page_revision_id is not None:
                info = await self.repo.get_page_revision_scope_info(
                    page_revision_id=page_revision_id,
                    page_id=page_id,
                    book_id=book_id,
                )
                if (
                    info is None
                    or info["is_deleted"]
                    or info["lifecycle_status"] == "RETIRED"
                    or info["page_lifecycle_status"] == "RETIRED"
                ):
                    await self._end_read_tx()
                    raise HTTPException(status_code=404, detail="Resource not found")
                resolved_book_id = info["book_id"]
                resolved_page_id = info["page_id"]
            elif page_id is not None:
                info = await self.repo.get_page_book_scope_info(page_id)
                if (
                    info is None
                    or info["is_deleted"]
                    or info["lifecycle_status"] == "RETIRED"
                    or info["page_lifecycle_status"] == "RETIRED"
                ):
                    await self._end_read_tx()
                    raise HTTPException(status_code=404, detail="Resource not found")
                if book_id is not None and info["book_id"] != book_id:
                    await self._end_read_tx()
                    raise HTTPException(status_code=404, detail="Resource not found")
                resolved_book_id = info["book_id"]
                resolved_page_id = page_id
            else:
                assert book_id is not None
                info = await self.repo.get_book_scope_info(book_id)
                if info is None or info["is_deleted"] or info["lifecycle_status"] == "RETIRED":
                    await self._end_read_tx()
                    raise HTTPException(status_code=404, detail="Resource not found")
                resolved_book_id = info["book_id"]
                resolved_page_id = None

            if info["visibility_scope"] == "PARENT_PRIVATE":
                if (
                    actor_id is None
                    or info["owner_parent_id"] != actor_id
                    or info["moderation_status"] != "ACTIVE"
                ):
                    await self._end_read_tx()
                    raise HTTPException(status_code=404, detail="Resource not found")
                await self._end_read_tx()
                return ResolvedCacheTarget(
                    scope="PRIVATE",
                    owner_parent_id=actor_id,
                    book_id=resolved_book_id,
                    page_id=resolved_page_id,
                    page_revision_id=page_revision_id,
                    can_store_on_miss=True,
                )

            can_store_catalog = (
                True
                if allow_cache_write
                else await self._is_catalog_text_allowlisted(
                    book_id=resolved_book_id,
                    page_id=resolved_page_id,
                    page_revision_id=page_revision_id,
                    normalized_text=canonical_query,
                )
            )
            await self._end_read_tx()
            return ResolvedCacheTarget(
                scope="CATALOG",
                owner_parent_id=None,
                book_id=resolved_book_id,
                page_id=resolved_page_id,
                page_revision_id=page_revision_id,
                can_store_on_miss=can_store_catalog,
            )

        norm_scope = (cache_scope or "").strip().upper() or None
        if norm_scope == "COACHING":
            can_store_coaching = True if allow_cache_write else (
                bool(canonical_query) and canonical_query in ALLOWED_COACHING_PHRASES
            )
            return ResolvedCacheTarget(
                scope="COACHING",
                owner_parent_id=None,
                book_id=None,
                page_id=None,
                page_revision_id=None,
                can_store_on_miss=can_store_coaching,
            )
        if norm_scope == "PRIVATE":
            if actor_id is None:
                return None
            return ResolvedCacheTarget(
                scope="PRIVATE",
                owner_parent_id=actor_id,
                book_id=book_id,
                page_id=page_id,
                page_revision_id=page_revision_id,
                can_store_on_miss=True,
            )
        if norm_scope == "CATALOG":
            # Read-only lookup for precomputed catalog vocabulary/pages when no DB book_id is given;
            # never populate global CATALOG cache from arbitrary ad-hoc HTTP text.
            return ResolvedCacheTarget(
                scope="CATALOG",
                owner_parent_id=None,
                book_id=book_id,
                page_id=page_id,
                page_revision_id=page_revision_id,
                can_store_on_miss=bool(allow_cache_write),
            )
        return None

    @staticmethod
    def build_storage_location(
        *,
        target: ResolvedCacheTarget,
        content_sha256: str,
        voice_id: str,
        speed: float,
        audio_format: str,
    ) -> tuple[str, str]:
        ext = _EXTENSION_BY_MIME.get(audio_format, "mp3")
        safe_voice = "".join(
            ch if (ch.isalnum() or ch in {"-", "_"}) else "_" for ch in voice_id
        )[:64] or "voice"
        speed_tag = f"{float(speed):.2f}".replace(".", "p")
        filename = f"{safe_voice}_{speed_tag}.{ext}"
        if target.scope == "PRIVATE":
            if target.owner_parent_id is None:
                raise ValueError("PRIVATE cache location requires owner_parent_id")
            book_seg = str(target.book_id) if target.book_id is not None else "user"
            path = f"private-books/{target.owner_parent_id}/{book_seg}/tts-cache/{content_sha256}/{filename}"
            return SUPABASE_PRIVATE_BOOKS_BUCKET, path
        if target.scope == "COACHING":
            path = f"coaching/{content_sha256}/{filename}"
            return get_tts_cache_bucket(), path
        book_seg = str(target.book_id) if target.book_id is not None else "shared"
        page_seg = str(target.page_id) if target.page_id is not None else "common"
        path = f"catalog/{book_seg}/{page_seg}/{content_sha256}/{filename}"
        return get_tts_cache_bucket(), path

    async def lookup_cached_audio(
        self,
        *,
        target: ResolvedCacheTarget,
        normalized_text: str,
        voice_id: str,
        model_version: str | None = None,
        speed: float = 1.0,
        accept: str | None = None,
        audio_format: str | None = None,
    ) -> CachedTtsHit | None:
        if not is_tts_cache_enabled() or self.repo is None or self.db is None:
            return None
        content_sha256 = canonical_tts_sha256(normalized_text)
        formats = preferred_cache_formats(accept=accept, audio_format=audio_format)
        try:
            daily_limit = get_tts_cache_daily_egress_limit_bytes()
            daily_usage = await self.repo.get_daily_usage()
            if daily_limit > 0 and daily_usage["bytes_served"] >= daily_limit:
                await self._end_read_tx()
                self._set_quota_exhausted(True)
                return None
            self._set_quota_exhausted(False)

            entry = await self.repo.get_active_entry(
                scope=target.scope,
                owner_parent_id=target.owner_parent_id,
                content_sha256=content_sha256,
                voice_id=voice_id,
                model_version=model_version,
                speed=speed,
                audio_formats=formats,
            )
            if entry is None:
                await self.repo.record_miss()
                await self.db.commit()
                self._record_runtime_miss()
                return None

            entry_id = entry.Id
            entry_byte_size = int(entry.ByteSize or 0)
            entry_bucket = entry.StorageBucket
            entry_path = entry.StoragePath
            entry_format = entry.AudioFormat
            entry_voice = entry.VoiceId
            entry_model = entry.ModelVersion
            entry_duration = entry.DurationSeconds
            entry_timings = entry.WordTimingsJson
            entry_scope = entry.Scope

            if daily_limit > 0 and (daily_usage["bytes_served"] + entry_byte_size) > daily_limit:
                await self._end_read_tx()
                self._set_quota_exhausted(True)
                return None

            # Release read transaction & pool permit before external Storage HTTP download.
            await self._end_read_tx()

            try:
                audio_bytes = await asyncio.to_thread(
                    download_object,
                    entry_path,
                    bucket_name=entry_bucket,
                )
            except Exception:
                await self.repo.mark_entries_status([entry_id], status="STALE")
                await self.repo.record_miss()
                await self.db.commit()
                self._record_runtime_miss()
                return None

            actual_type = detect_audio_content_type(audio_bytes, entry_format)
            await self.repo.record_hit(entry_id, byte_size=len(audio_bytes))
            await self.db.commit()
            self._record_runtime_hit(len(audio_bytes))
            return CachedTtsHit(
                content=audio_bytes,
                content_type=actual_type,
                resolved_voice_id=entry_voice,
                model_version=entry_model,
                duration_seconds=entry_duration,
                word_timings_json=entry_timings,
                scope=entry_scope,
                storage_bucket=entry_bucket,
                storage_path=entry_path,
            )
        except SQLAlchemyError as exc:
            await self._safe_rollback()
            log_diagnostic(
                logger,
                logging.WARNING,
                event="tts_cache_lookup_failed",
                stage="tts_cache",
                exception=exc,
            )
            return None

    async def store_cached_audio(
        self,
        *,
        target: ResolvedCacheTarget,
        normalized_text: str,
        voice_id: str,
        model_version: str,
        speed: float,
        audio_bytes: bytes,
        source_content_type: str | None = None,
        duration_seconds: float | None = None,
        word_timings_json: list[dict[str, Any]] | dict[str, Any] | None = None,
    ) -> bool:
        if (
            not is_tts_cache_enabled()
            or not target.can_store_on_miss
            or not audio_bytes
            or self.repo is None
            or self.db is None
        ):
            return False

        compressed_bytes, stored_format = await asyncio.to_thread(
            transcode_to_mp3_64k,
            audio_bytes,
            source_content_type,
        )
        max_bytes = get_tts_cache_max_bytes()
        if len(compressed_bytes) > max_bytes:
            return False

        content_sha256 = canonical_tts_sha256(normalized_text)
        bucket, storage_path = self.build_storage_location(
            target=target,
            content_sha256=content_sha256,
            voice_id=voice_id,
            speed=speed,
            audio_format=stored_format,
        )

        try:
            await asyncio.to_thread(
                upload_object,
                storage_path,
                compressed_bytes,
                stored_format,
                bucket_name=bucket,
                upsert=True,
            )
            entry, replaced = await self.repo.upsert_active_entry(
                scope=target.scope,
                owner_parent_id=target.owner_parent_id,
                book_id=target.book_id,
                page_id=target.page_id,
                page_revision_id=target.page_revision_id,
                content_sha256=content_sha256,
                normalized_text=normalized_text,
                voice_id=voice_id,
                model_version=model_version,
                speed=speed,
                audio_format=stored_format,
                storage_bucket=bucket,
                storage_path=storage_path,
                byte_size=len(compressed_bytes),
                duration_seconds=duration_seconds,
                word_timings_json=word_timings_json,
            )
            evicted_objects = await self._enforce_lru_quota(
                max_bytes=max_bytes,
                keep_entry_id=entry.Id,
            )
            await self.db.commit()
        except Exception as exc:
            await self._safe_rollback()
            await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
            log_diagnostic(
                logger,
                logging.WARNING,
                event="tts_cache_store_failed",
                stage="tts_cache",
                exception=exc,
            )
            return False

        for old_bucket, old_path in [*replaced, *evicted_objects]:
            await asyncio.to_thread(delete_object, old_path, bucket_name=old_bucket)
        return True

    async def _enforce_lru_quota(
        self,
        *,
        max_bytes: int,
        keep_entry_id: UUID | None = None,
    ) -> list[tuple[str, str]]:
        assert self.repo is not None
        total = await self.repo.total_active_bytes()
        if total <= max_bytes:
            return []

        exclude = (keep_entry_id,) if keep_entry_id is not None else ()
        candidates = await self.repo.list_lru_eviction_candidates(
            exclude_ids=exclude, limit=200
        )
        evict_ids: list[UUID] = []
        evict_objects: list[tuple[str, str]] = []
        for item in candidates:
            if total <= max_bytes:
                break
            evict_ids.append(item.Id)
            evict_objects.append((str(item.StorageBucket), str(item.StoragePath)))
            total -= int(item.ByteSize or 0)
        if evict_ids:
            await self.repo.mark_entries_status(evict_ids, status="DELETED")
        return evict_objects

    async def invalidate_target(
        self,
        *,
        book_id: UUID | None = None,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
        commit: bool = False,
    ) -> int:
        if self.repo is None or self.db is None:
            return 0
        try:
            if hasattr(self.db, "begin_nested"):
                async with self.db.begin_nested():
                    stale_objects = await self.repo.mark_stale_for_target(
                        book_id=book_id,
                        page_id=page_id,
                        page_revision_id=page_revision_id,
                    )
            else:
                stale_objects = await self.repo.mark_stale_for_target(
                    book_id=book_id,
                    page_id=page_id,
                    page_revision_id=page_revision_id,
                )
            if commit and stale_objects:
                await self.db.commit()
        except SQLAlchemyError as exc:
            if commit and not hasattr(self.db, "begin_nested"):
                await self._safe_rollback()
            log_diagnostic(
                logger,
                logging.WARNING,
                event="tts_cache_invalidation_failed",
                stage="tts_cache",
                exception=exc,
            )
            return 0

        for bucket, path in stale_objects:
            await asyncio.to_thread(delete_object, path, bucket_name=bucket)
        return len(stale_objects)

    async def get_summary(self) -> dict[str, Any]:
        max_bytes = get_tts_cache_max_bytes()
        daily_limit = get_tts_cache_daily_egress_limit_bytes()
        if self.repo is not None:
            try:
                summary = await self.repo.get_summary()
                hits = int(summary["hit_count"])
                misses = int(summary["miss_count"])
                total_reqs = hits + misses
                daily_egress = int(summary["daily_egress_bytes"])
                today = datetime.now(timezone.utc).date()
                with _METRICS_LOCK:
                    _reset_day_if_needed_locked(today)
                    runtime_quota = bool(_RUNTIME_METRICS["quota_exhausted"])
                quota_exhausted = runtime_quota or (
                    daily_limit > 0 and daily_egress >= daily_limit
                )
                return {
                    "entry_count": int(summary["entry_count"]),
                    "storage_used_bytes": int(summary["storage_used_bytes"]),
                    "storage_quota_bytes": max_bytes,
                    "daily_egress_bytes": daily_egress,
                    "daily_egress_limit_bytes": daily_limit,
                    "cache_hit_ratio": round(hits / total_reqs, 4) if total_reqs > 0 else None,
                    "quota_exhausted": quota_exhausted,
                }
            except SQLAlchemyError:
                await self._safe_rollback()

        with _METRICS_LOCK:
            _reset_day_if_needed_locked(datetime.now(timezone.utc).date())
            hits = int(_RUNTIME_METRICS["hits"])
            misses = int(_RUNTIME_METRICS["misses"])
            total_reqs = hits + misses
            daily_egress = int(_RUNTIME_METRICS["bytes_served"])
            quota_exhausted = bool(_RUNTIME_METRICS["quota_exhausted"]) or (
                daily_limit > 0 and daily_egress >= daily_limit
            )
        return {
            "entry_count": 0,
            "storage_used_bytes": 0,
            "storage_quota_bytes": max_bytes,
            "daily_egress_bytes": daily_egress,
            "daily_egress_limit_bytes": daily_limit,
            "cache_hit_ratio": round(hits / total_reqs, 4) if total_reqs > 0 else None,
            "quota_exhausted": quota_exhausted,
        }

    async def _safe_rollback(self) -> None:
        if self.db is not None:
            try:
                await self.db.rollback()
            except Exception:
                pass


async def invalidate_tts_cache_best_effort(
    db: AsyncSession | None,
    *,
    book_id: UUID | None = None,
    page_id: UUID | None = None,
    page_revision_id: UUID | None = None,
    commit: bool = False,
) -> int:
    """Safely mark affected TTS cache rows STALE without breaking legacy/minimal DB schemas."""
    if db is None or not isinstance(db, AsyncSession):
        return 0
    service = TtsAudioCacheService(db)
    if not commit and hasattr(db, "begin_nested"):
        try:
            async with db.begin_nested():
                return await service.invalidate_target(
                    book_id=book_id,
                    page_id=page_id,
                    page_revision_id=page_revision_id,
                    commit=False,
                )
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="tts_cache_invalidation_skipped",
                stage="tts_cache",
                exception=exc,
            )
            return 0
    return await service.invalidate_target(
        book_id=book_id,
        page_id=page_id,
        page_revision_id=page_revision_id,
        commit=commit,
    )
