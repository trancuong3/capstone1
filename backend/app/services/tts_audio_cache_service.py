"""Precomputed & LRU-bounded TTS audio cache service (isolation, 64kbps MP3 compression, egress cap)."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
from io import BytesIO
import json
import logging
import os
import re
import threading
import time
import unicodedata
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository
from app.services.storage_service import (
    delete_object,
    download_object,
    download_object_async,
    is_local_storage_enabled,
    upload_object,
)

logger = logging.getLogger(__name__)

_ORIGINAL_DOWNLOAD_OBJECT = download_object
_SCOPE_CACHE_CATALOG_TTL_SECONDS = 60.0
_SCOPE_CACHE_PRIVATE_TTL_SECONDS = 15.0
_SCOPE_CACHE_MAX_ENTRIES = 1024
_DAILY_USAGE_CACHE_TTL_SECONDS = 15.0
_SUMMARY_CACHE_TTL_SECONDS = 15.0
_MISS_LOOKUP_CACHE_TTL_SECONDS = 15.0
_MISS_LOOKUP_CACHE_MAX_ENTRIES = 512
_AUDIO_RAM_LRU_MAX_BYTES = 32 * 1024 * 1024  # 32 MiB bounded server RAM LRU
_AUDIO_RAM_LRU_MAX_ITEM_BYTES = 4 * 1024 * 1024  # Never pin >4 MiB single clip
_CONSTRAINED_AUDIO_RAM_LRU_MAX_BYTES = 16 * 1024 * 1024  # 16 MiB on 512 MiB Render Free
_CONSTRAINED_AUDIO_RAM_LRU_MAX_ITEM_BYTES = 2 * 1024 * 1024  # 2 MiB max single clip

_CACHE_STATE_LOCK = threading.Lock()
_SCOPE_TARGET_CACHE: "OrderedDict[tuple[Any, ...], tuple[float, Any]]" = OrderedDict()
_DAILY_USAGE_CACHE: dict[tuple[int, date], tuple[float, dict[str, int]]] = {}
_SUMMARY_CACHE: dict[tuple[int, int, int, date], tuple[float, dict[str, Any]]] = {}
_MISS_LOOKUP_CACHE: "OrderedDict[tuple[Any, ...], float]" = OrderedDict()
_AUDIO_RAM_LRU: "OrderedDict[tuple[str, str], tuple[bytes, str]]" = OrderedDict()
_AUDIO_RAM_LRU_BYTES = 0

DEFAULT_TTS_CACHE_MAX_BYTES = 150 * 1024 * 1024  # 150 MiB (CATALOG + COACHING partition)
DEFAULT_TTS_PRIVATE_OWNER_MAX_BYTES = 12 * 1024 * 1024  # 12 MiB per-parent PRIVATE cap
DEFAULT_TTS_PRIVATE_GLOBAL_MAX_BYTES = 50 * 1024 * 1024  # 50 MiB global PRIVATE cap
DEFAULT_TTS_GLOBAL_ACTIVE_MAX_BYTES = 200 * 1024 * 1024  # 200 MiB cross-scope ceiling
DEFAULT_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES = 300 * 1024 * 1024  # 300 MiB/day
DEFAULT_TTS_CACHE_BUCKET = "viread-tts-cache"


def _is_constrained_web_runtime() -> bool:
    render = (os.getenv("RENDER") or "").strip().lower() in {"1", "true", "yes", "on"}
    disable_heavy = (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    remote_ocr = (os.getenv("VIREAD_OCR_MODE") or "").strip().lower() == "remote_worker"
    return render or disable_heavy or remote_ocr


def _get_audio_ram_lru_max_bytes() -> int:
    raw = (os.getenv("VIREAD_TTS_RAM_CACHE_MAX_BYTES") or "").strip()
    if raw:
        try:
            return max(0, min(64 * 1024 * 1024, int(raw)))
        except ValueError:
            pass
    return (
        _CONSTRAINED_AUDIO_RAM_LRU_MAX_BYTES
        if _is_constrained_web_runtime()
        else _AUDIO_RAM_LRU_MAX_BYTES
    )


def _get_audio_ram_lru_max_item_bytes() -> int:
    return (
        _CONSTRAINED_AUDIO_RAM_LRU_MAX_ITEM_BYTES
        if _is_constrained_web_runtime()
        else _AUDIO_RAM_LRU_MAX_ITEM_BYTES
    )

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


_MALE_VOICE_MARKERS = (
    "thien_minh",
    "quang_son",
    "thai_son",
    "neural2_d",
    "wavenet_b",
    "_male",
)


def _infer_voice_gender(voice_id: str | None) -> str:
    lower = (voice_id or "").strip().lower()
    if any(marker in lower for marker in _MALE_VOICE_MARKERS):
        return "male"
    return "female"


def _entry_matches_requested_voice(entry: Any, requested_voice_id: str) -> bool:
    entry_voice_id = getattr(entry, "VoiceId", None)
    if not isinstance(entry_voice_id, str) or not entry_voice_id.strip():
        return False
    clean_entry = entry_voice_id.strip()
    clean_req = (requested_voice_id or "").strip()
    if not clean_req or clean_entry != clean_req:
        return False
    return _infer_voice_gender(clean_entry) == _infer_voice_gender(clean_req)


def _reset_day_if_needed_locked(today: date) -> None:
    if _RUNTIME_METRICS["usage_date"] != today:
        _RUNTIME_METRICS["usage_date"] = today
        _RUNTIME_METRICS["hits"] = 0
        _RUNTIME_METRICS["misses"] = 0
        _RUNTIME_METRICS["bytes_served"] = 0
        _RUNTIME_METRICS["quota_exhausted"] = False


def invalidate_tts_cache_summary_cache() -> None:
    """Clear the 15s RAM TTL summary cache when cache entries change."""
    with _CACHE_STATE_LOCK:
        _SUMMARY_CACHE.clear()


def is_tts_cache_runtime_quota_exhausted() -> bool:
    today = datetime.now(timezone.utc).date()
    with _METRICS_LOCK:
        _reset_day_if_needed_locked(today)
        return bool(_RUNTIME_METRICS["quota_exhausted"])


def get_cached_tts_audio_cache_summary(
    db: AsyncSession | None,
    *,
    max_bytes: int | None = None,
    daily_limit: int | None = None,
    bypass_cache: bool = False,
) -> dict[str, Any] | None:
    if bypass_cache:
        return None
    bind_id = _db_bind_cache_key(db)
    if bind_id == 0:
        return None
    resolved_max = get_tts_cache_max_bytes() if max_bytes is None else int(max_bytes)
    resolved_daily = (
        get_tts_cache_daily_egress_limit_bytes()
        if daily_limit is None
        else int(daily_limit)
    )
    today = datetime.now(timezone.utc).date()
    key = (bind_id, resolved_max, resolved_daily, today)
    now_mono = time.monotonic()
    with _CACHE_STATE_LOCK:
        entry = _SUMMARY_CACHE.get(key)
        if entry is None or entry[0] <= now_mono:
            if entry is not None:
                _SUMMARY_CACHE.pop(key, None)
            return None
        payload = dict(entry[1])
    if is_tts_cache_runtime_quota_exhausted():
        payload["quota_exhausted"] = True
    return payload


def set_cached_tts_audio_cache_summary(
    db: AsyncSession | None,
    summary: dict[str, Any],
    *,
    max_bytes: int | None = None,
    daily_limit: int | None = None,
) -> None:
    bind_id = _db_bind_cache_key(db)
    if bind_id == 0:
        return
    resolved_max = get_tts_cache_max_bytes() if max_bytes is None else int(max_bytes)
    resolved_daily = (
        get_tts_cache_daily_egress_limit_bytes()
        if daily_limit is None
        else int(daily_limit)
    )
    today = datetime.now(timezone.utc).date()
    key = (bind_id, resolved_max, resolved_daily, today)
    now_mono = time.monotonic()
    with _CACHE_STATE_LOCK:
        expired = [k for k, (exp, _) in _SUMMARY_CACHE.items() if exp <= now_mono]
        for k in expired:
            _SUMMARY_CACHE.pop(k, None)
        _SUMMARY_CACHE[key] = (now_mono + _SUMMARY_CACHE_TTL_SECONDS, dict(summary))


def clear_tts_cache_runtime_metrics() -> None:
    global _AUDIO_RAM_LRU_BYTES
    with _METRICS_LOCK:
        _RUNTIME_METRICS["usage_date"] = None
        _RUNTIME_METRICS["hits"] = 0
        _RUNTIME_METRICS["misses"] = 0
        _RUNTIME_METRICS["bytes_served"] = 0
        _RUNTIME_METRICS["quota_exhausted"] = False
    with _CACHE_STATE_LOCK:
        _SCOPE_TARGET_CACHE.clear()
        _DAILY_USAGE_CACHE.clear()
        _SUMMARY_CACHE.clear()
        _MISS_LOOKUP_CACHE.clear()
        _AUDIO_RAM_LRU.clear()
        _AUDIO_RAM_LRU_BYTES = 0


def _audio_ram_lru_get(bucket: str, path: str) -> tuple[bytes, str] | None:
    key = (bucket, path)
    with _CACHE_STATE_LOCK:
        entry = _AUDIO_RAM_LRU.get(key)
        if entry is None:
            return None
        _AUDIO_RAM_LRU.move_to_end(key)
        return entry


def _audio_ram_lru_put(bucket: str, path: str, data: bytes, content_type: str) -> None:
    global _AUDIO_RAM_LRU_BYTES
    max_bytes = _get_audio_ram_lru_max_bytes()
    max_item_bytes = _get_audio_ram_lru_max_item_bytes()
    size = len(data)
    if max_bytes <= 0 or size <= 0 or size > max_item_bytes or size > max_bytes:
        return
    key = (bucket, path)
    with _CACHE_STATE_LOCK:
        existing = _AUDIO_RAM_LRU.pop(key, None)
        if existing is not None:
            _AUDIO_RAM_LRU_BYTES = max(0, _AUDIO_RAM_LRU_BYTES - len(existing[0]))
        while _AUDIO_RAM_LRU and (_AUDIO_RAM_LRU_BYTES + size) > max_bytes:
            _, evicted = _AUDIO_RAM_LRU.popitem(last=False)
            _AUDIO_RAM_LRU_BYTES = max(0, _AUDIO_RAM_LRU_BYTES - len(evicted[0]))
        _AUDIO_RAM_LRU[key] = (data, content_type)
        _AUDIO_RAM_LRU_BYTES += size


def _audio_ram_lru_evict(objects: list[tuple[str, str]]) -> None:
    global _AUDIO_RAM_LRU_BYTES
    if not objects:
        return
    with _CACHE_STATE_LOCK:
        for bucket, path in objects:
            existing = _AUDIO_RAM_LRU.pop((str(bucket), str(path)), None)
            if existing is not None:
                _AUDIO_RAM_LRU_BYTES = max(0, _AUDIO_RAM_LRU_BYTES - len(existing[0]))


def _scope_cache_invalidate(
    *,
    book_id: UUID | None = None,
    page_id: UUID | None = None,
    page_revision_id: UUID | None = None,
) -> None:
    if book_id is None and page_id is None and page_revision_id is None:
        return
    with _CACHE_STATE_LOCK:
        to_remove = [
            key
            for key, (_, target) in _SCOPE_TARGET_CACHE.items()
            if (book_id is not None and target.book_id == book_id)
            or (page_id is not None and target.page_id == page_id)
            or (page_revision_id is not None and target.page_revision_id == page_revision_id)
        ]
        for key in to_remove:
            _SCOPE_TARGET_CACHE.pop(key, None)


def _db_bind_cache_key(db: AsyncSession | None) -> int:
    if db is None:
        return 0
    bind = getattr(db, "bind", None)
    if bind is None:
        try:
            bind = db.get_bind()
        except Exception:
            bind = None
    return id(bind) if bind is not None else 0


async def _bg_record_hit(entry_id: UUID, byte_size: int) -> None:
    try:
        async with AsyncSessionLocal() as session:
            await TtsAudioCacheRepository(session).record_hit(
                entry_id, byte_size=max(0, int(byte_size))
            )
            await session.commit()
    except Exception as exc:
        log_diagnostic(
            logger,
            logging.WARNING,
            event="tts_cache_bg_record_hit_failed",
            stage="tts_cache",
            exception=exc,
        )


async def _bg_record_miss(stale_entry_id: UUID | None = None) -> None:
    try:
        async with AsyncSessionLocal() as session:
            repo = TtsAudioCacheRepository(session)
            if stale_entry_id is not None:
                await repo.mark_entries_status([stale_entry_id], status="STALE")
            await repo.record_miss()
            await session.commit()
    except Exception as exc:
        log_diagnostic(
            logger,
            logging.WARNING,
            event="tts_cache_bg_record_miss_failed",
            stage="tts_cache",
            exception=exc,
        )


async def _bg_store_cached_audio(
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
) -> None:
    try:
        async with AsyncSessionLocal() as session:
            svc = TtsAudioCacheService(session)
            await svc.store_cached_audio(
                target=target,
                normalized_text=normalized_text,
                voice_id=voice_id,
                model_version=model_version,
                speed=speed,
                audio_bytes=audio_bytes,
                source_content_type=source_content_type,
                duration_seconds=duration_seconds,
                word_timings_json=word_timings_json,
            )
    except Exception as exc:
        log_diagnostic(
            logger,
            logging.WARNING,
            event="tts_cache_bg_store_failed",
            stage="tts_cache",
            exception=exc,
        )


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


def get_tts_private_owner_max_bytes() -> int:
    raw = (os.getenv("VIREAD_TTS_CACHE_PRIVATE_OWNER_MAX_BYTES") or "").strip()
    if not raw:
        return DEFAULT_TTS_PRIVATE_OWNER_MAX_BYTES
    try:
        return max(1024, int(raw))
    except ValueError:
        return DEFAULT_TTS_PRIVATE_OWNER_MAX_BYTES


def get_tts_private_global_max_bytes() -> int:
    raw = (os.getenv("VIREAD_TTS_CACHE_PRIVATE_GLOBAL_MAX_BYTES") or "").strip()
    if not raw:
        return DEFAULT_TTS_PRIVATE_GLOBAL_MAX_BYTES
    try:
        return max(1024, int(raw))
    except ValueError:
        return DEFAULT_TTS_PRIVATE_GLOBAL_MAX_BYTES


def get_tts_cache_global_max_bytes() -> int:
    raw = (os.getenv("VIREAD_TTS_CACHE_GLOBAL_MAX_BYTES") or "").strip()
    if not raw:
        return DEFAULT_TTS_GLOBAL_ACTIVE_MAX_BYTES
    try:
        return max(1024, int(raw))
    except ValueError:
        return DEFAULT_TTS_GLOBAL_ACTIVE_MAX_BYTES


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


_FOLD_PUNCT_CHARS = ".,!?;:\"'()[]{}«»…-–—“”‘’"


def folded_catalog_tts_text(text: str) -> str:
    """Lowercase & strip surrounding punctuation per token for catalog cache compatibility."""
    parts: list[str] = []
    for raw in canonical_tts_text(text).split():
        cleaned = raw.strip(_FOLD_PUNCT_CHARS).lower()
        if cleaned:
            parts.append(cleaned)
    return " ".join(parts)


ALLOWED_COACHING_PHRASES_RAW: tuple[str, ...] = (
    "Tuyệt vời!",
    "Con đọc rất tốt!",
    "Chính xác rồi!",
    "Cố gắng lên nhé!",
    "Hãy đọc chậm và rõ từng chữ nhé.",
    "Hãy đọc lại từ này nhé.",
    "Mình cùng đọc tiếp trang tiếp theo nào.",
    # Real fixed coaching cues spoken by reading-screen.tsx & interactive-prompts.ts
    "Cô đọc mẫu cho con nhé.",
    "Thầy đọc mẫu cho con nhé.",
    "Đến lượt con đọc nhé.",
    "Con nghe từ này nhé.",
    "Con nghe cô đọc từ này nhé.",
    "Con nghe thầy đọc từ này nhé.",
    "Mình cùng nghe từ này nào.",
    "Mình đọc chậm hơn chút nhé.",
    "Con nghe cô đọc thật chậm nha.",
    "Con nghe thầy đọc thật chậm nha.",
    "Mình đọc chậm từng tiếng nhé.",
    "Không sao đâu. Con nghe cô đọc nhé.",
    "Không sao đâu. Con nghe thầy đọc nhé.",
    "Đến lượt con. Con đọc lại nhé.",
    "Để cô đánh vần chậm giúp con nhé!",
    "Để thầy đánh vần chậm giúp con nhé!",
    "Mình đánh vần từng bước chữ này nha!",
    "Cô tách từng âm giúp con dễ đọc nhé!",
    "Thầy tách từng âm giúp con dễ đọc nhé!",
    "Con nghe cô đánh vần chậm từng âm nào!",
    "Con nghe thầy đánh vần chậm từng âm nào!",
    "Mình ghép từng tiếng cho dễ đọc nha con!",
    "Cô đánh vần dẫn đường giúp con nhé!",
    "Thầy đánh vần dẫn đường giúp con nhé!",
    "Con đã cố gắng rất tốt rồi. Mình đọc tiếp nhé!",
    "Không sao đâu, từ này mình luyện thêm sau. Đọc tiếp nào!",
    "Con làm tốt lắm rồi. Mình sang từ tiếp theo nhé!",
    "Con đọc xong trang này trôi chảy quá! Cô khen nhé!",
    "Con đọc xong trang này trôi chảy quá! Thầy khen nhé!",
    "Giỏi quá, mình lật sang trang tiếp theo nhé!",
    "Tuyệt vời, con đọc rõ lắm! Mình sang trang mới nào!",
    "Hoan hô con, trang này con đọc mượt mà quá!",
    "Con đọc cả câu mượt mà quá! Mình đọc tiếp nào!",
    "Giỏi lắm, cả câu trôi chảy rồi! Đọc tiếp nhé.",
    "Tuyệt vời! Con đọc liền câu rõ ràng lắm.",
    "Bé chọn đáp án nào?",
    "Con chọn đáp án nào nhé?",
    "Đúng rồi! Bé nhớ bài rất tốt.",
    "Giỏi quá! Con trả lời chính xác rồi.",
    "Tuyệt vời! Con hiểu câu chuyện rất rõ.",
    "Gần đúng rồi, con nghe kỹ và thử chọn lại nhé.",
    "Chưa chính xác lắm, bé nghĩ thêm chút rồi chọn lại nha.",
    "Suýt đúng rồi! Con thử đáp án khác xem sao nhé.",
    # Additional fixed cues from interactive-prompts.ts, word-practice-engine.ts,
    # difficult-word-practice-panel.tsx, difficult_words_service.py, and reading-voice-settings.tsx
    "Chào con, hôm nay cô trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
    "Mình ghép vào cả cụm cho dễ đọc nhé.",
    "Con nghe cô đọc cả cụm này nhé.",
    "Đọc liền cả cụm sẽ dễ hơn đó con.",
    "Hay lắm, con đánh vần đúng cách rồi đó!",
    "Hoan hô, con đánh vần và đọc trơn mượt quá!",
    "Con đọc đều và trôi chảy quá!",
    "Nhịp đọc của con rất tự tin!",
    "Giỏi quá, con đọc rõ từng chữ một luôn!",
    "Con đọc xong bài rồi! Con có muốn cùng cô đọc lại vài từ khó không? Nói có hoặc không nhé!",
    "Chúc mừng con hoàn thành bài! Con muốn ôn lại vài từ khó hay qua phần câu hỏi nhé?",
    "Hoan hô con đã đọc hết bài! Con có muốn đọc lại mấy từ vừa vấp không?",
    "Tuyệt vời, con xong cả bài rồi! Con có muốn luyện lại các từ khó một chút không?",
    "Tuyệt vời! Mình cùng đọc lại từng từ khó cho chuẩn nhé!",
    "Cô khen con chăm chỉ! Mình ôn lại từng từ một nào!",
    "Hay lắm! Mình cùng chinh phục lại các từ khó nhé!",
    "Được luôn con ơi! Giờ mình sang phần câu hỏi vui nhé!",
    "Nhất trí nha! Mình chuyển sang trả lời câu hỏi cùng cô nào!",
    "Không sao đâu con! Giờ mình trả lời câu hỏi thú vị nhé!",
    "Theo con, đáp án nào đúng nào?",
    "Bé nói A, B, C hoặc bấm vào đáp án bé chọn nhé.",
    "Con có thể đọc tên đáp án hoặc chạm trực tiếp trên màn hình nhé.",
    "Chính xác rồi! Con giỏi lắm!",
    "Máy đang bận một chút, con thử lại nhé!",
    "Con đọc từ trên màn hình nhé.",
    "Con thử đọc lại nhé.",
    "Cô đang nghe. Con thử đọc nhé.",
    "Cô chưa nghe rõ. Con đọc lại nhé.",
    "Con thử nghe lại phát âm mẫu và đọc chậm rãi một lần nữa nhé!",
    "Máy chưa nghe rõ giọng của con. Con lại gần micro và thử lại nhé!",
    "Phần nhận diện giọng nói đang bận một chút. Con không bị tính sai đâu, mình thử lại sau nhé!",
    "Máy chưa nghe thật chắc chắn. Con không bị tính sai đâu, mình thử đọc lại nhé!",
    "Buổi đọc xong rồi! Con có muốn luyện lại mấy từ khó vừa rồi cùng cô không? Con bấm nút Luyện ngay các từ khó nhé!",
    "Cô chưa nghe rõ tiếng vừa rồi, con đọc lại nhé.",
    "Cô chưa nghe rõ tiếng vừa rồi, con đọc lại rõ hơn một chút nhé.",
    "Không sao đâu, từ này mình luyện thêm sau. Mình sang từ tiếp theo nhé!",
    "Cô chưa lưu được câu trả lời. Con chọn hoặc nói lại giúp cô nhé!",
    "Không sao đâu con! Mình cùng sang câu tiếp theo nhé!",
)
TIMED_COACHING_PHRASES_RAW: tuple[str, ...] = (
    # Spoken via `/voice/text-to-speech/timed` with `cache_scope="COACHING"` (ReadingVoiceSettings "Nghe thử")
    "Chào con, hôm nay cô trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
)
_CO_GIAO_UPPER_RE = re.compile(r"(?<![^\W\d_])Cô giáo(?![^\W\d_])", re.UNICODE)
_CO_GIAO_LOWER_RE = re.compile(r"(?<![^\W\d_])cô giáo(?![^\W\d_])", re.UNICODE)
_CO_UPPER_RE = re.compile(r"(?<![^\W\d_])Cô(?![^\W\d_])", re.UNICODE)
_CO_LOWER_RE = re.compile(r"(?<![^\W\d_])cô(?![^\W\d_])", re.UNICODE)
_PHONICS_SAFE_STEP_RE = re.compile(r"^[\w\s.,!?…'\"\-–—]+$", re.UNICODE)


def adapt_coaching_phrase_for_male_persona(phrase: str) -> str:
    """Mirror frontend `adaptTextToTeacherPersona(text, 'male')` for 'Cô' -> 'Thầy' cues."""
    out = unicodedata.normalize("NFC", str(phrase or ""))
    if not out:
        return ""
    out = _CO_GIAO_UPPER_RE.sub("Thầy giáo", out)
    out = _CO_GIAO_LOWER_RE.sub("thầy giáo", out)
    out = _CO_UPPER_RE.sub("Thầy", out)
    out = _CO_LOWER_RE.sub("thầy", out)
    return out


ALLOWED_COACHING_PHRASES_MALE_RAW: tuple[str, ...] = tuple(
    dict.fromkeys(
        adapted
        for phrase in ALLOWED_COACHING_PHRASES_RAW
        for adapted in (adapt_coaching_phrase_for_male_persona(phrase),)
        if adapted and canonical_tts_text(adapted) != canonical_tts_text(phrase)
    )
)
ALLOWED_COACHING_PHRASES_ALL_RAW: tuple[str, ...] = (
    *ALLOWED_COACHING_PHRASES_RAW,
    *ALLOWED_COACHING_PHRASES_MALE_RAW,
)
ALLOWED_COACHING_PHRASES: frozenset[str] = frozenset(
    canonical_tts_text(phrase) for phrase in ALLOWED_COACHING_PHRASES_ALL_RAW
)
TIMED_COACHING_PHRASES_ALL_RAW: tuple[str, ...] = tuple(
    dict.fromkeys(
        adapted
        for phrase in TIMED_COACHING_PHRASES_RAW
        for adapted in (phrase, adapt_coaching_phrase_for_male_persona(phrase))
        if adapted
    )
)
TIMED_COACHING_PHRASES: frozenset[str] = frozenset(
    canonical_tts_text(phrase) for phrase in TIMED_COACHING_PHRASES_ALL_RAW
)


def extract_phonics_step_texts(normalized_text: str) -> list[str] | None:
    """Parse canonical `phonics:[...]` payload and validate bounded child-safe step texts."""
    if not normalized_text or not normalized_text.startswith("phonics:"):
        return None
    raw_json = normalized_text[len("phonics:") :]
    try:
        parsed = json.loads(raw_json)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, list) or not (1 <= len(parsed) <= 12):
        return None
    texts: list[str] = []
    for item in parsed:
        if not isinstance(item, dict):
            return None
        spoken = canonical_tts_text(str(item.get("spoken_text") or ""))
        if not spoken or len(spoken) > 48:
            return None
        lowered = spoken.lower()
        if "http://" in lowered or "https://" in lowered or "<" in spoken or ">" in spoken:
            return None
        if not _PHONICS_SAFE_STEP_RE.fullmatch(spoken):
            return None
        texts.append(spoken)
    return texts


def is_coaching_text_allowlisted(normalized_text: str | None) -> bool:
    """Allow fixed female/male coaching cues and strictly bounded short phonics prompts."""
    if not normalized_text:
        return False
    canonical = canonical_tts_text(normalized_text)
    if not canonical:
        return False
    if canonical in ALLOWED_COACHING_PHRASES:
        return True
    phonics_texts = extract_phonics_step_texts(canonical)
    if phonics_texts is not None:
        # Accommodates Vietnamese compound rhymes (e.g. "u, y, ê, tờ, uyết." = 5 tokens, 18 chars).
        return len(phonics_texts) <= 8 and all(
            len(step) <= 36 and len(step.split()) <= 6 for step in phonics_texts
        )
    return False


_STORAGE_NOT_FOUND_CODES = frozenset(
    {
        "404",
        "not_found",
        "notfound",
        "object_not_found",
        "nosuchkey",
        "no_such_key",
        "no_such_object",
        "bucketnotfound",
        "no_such_bucket",
    }
)


def _extract_numeric_http_status(exc: BaseException) -> int | None:
    for attr in ("status_code", "status", "statusCode"):
        val = getattr(exc, attr, None)
        if val is not None:
            try:
                parsed = int(val)
                if 100 <= parsed <= 599:
                    return parsed
            except (TypeError, ValueError):
                pass
    resp = getattr(exc, "response", None)
    if resp is not None:
        val = getattr(resp, "status_code", None)
        if val is not None:
            try:
                parsed = int(val)
                if 100 <= parsed <= 599:
                    return parsed
            except (TypeError, ValueError):
                pass
    for arg in getattr(exc, "args", ()):
        if isinstance(arg, dict):
            for key in ("statusCode", "status_code", "status"):
                val = arg.get(key)
                if val is not None:
                    try:
                        parsed = int(val)
                        if 100 <= parsed <= 599:
                            return parsed
                    except (TypeError, ValueError):
                        pass
    return None


def _is_storage_not_found_error(exc: BaseException) -> bool:
    """Return True only for definite 404/not-found Storage errors, never transient 5xx/network errors."""
    seen: set[int] = set()
    cur: BaseException | None = exc
    for _ in range(6):
        if cur is None or id(cur) in seen:
            break
        seen.add(id(cur))
        if isinstance(cur, FileNotFoundError):
            return True
        if _extract_numeric_http_status(cur) == 404:
            return True
        for attr in ("code", "error", "name"):
            raw = getattr(cur, attr, None)
            if raw is not None and str(raw).strip().lower() in _STORAGE_NOT_FOUND_CODES:
                return True
        for arg in getattr(cur, "args", ()):
            if isinstance(arg, dict):
                err_val = str(arg.get("error") or arg.get("code") or "").strip().lower()
                if err_val in _STORAGE_NOT_FOUND_CODES:
                    return True
                msg_val = str(arg.get("message") or "").lower()
                if "object not found" in msg_val or "not_found" in msg_val or "nosuchkey" in msg_val:
                    return True
        if not isinstance(cur, HTTPException):
            msg = str(cur).lower()
            if "object not found" in msg or "not_found" in msg or "nosuchkey" in msg:
                return True
        cur = cur.__cause__ or cur.__context__
    return False


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
            # Explicit WAV requests (e.g. client decode fallback after corrupt/unsupported MP3)
            # must NEVER be satisfied by a compressed MP3/OGG cache row.
            return ["audio/wav"]
    lower = (accept or "").lower()
    if "audio/ogg" in lower or "audio/opus" in lower:
        return ["audio/ogg", "audio/mpeg", "audio/wav"]
    return ["audio/mpeg", "audio/ogg", "audio/wav"]


_CACHED_PUBLIC_VOICE_IDS_TTL_SECONDS = 300.0
_CACHED_PUBLIC_VOICE_IDS_ERROR_BACKOFF_SECONDS = 30.0
_cached_public_voice_ids: tuple[float, list[str]] | None = None
_cached_public_voice_ids_backoff_until: float = 0.0
_cached_public_voice_ids_task: asyncio.Task[list[str]] | None = None


def clear_cached_public_voice_ids_cache() -> None:
    """Clear the in-memory cache of precomputed public TTS voice IDs."""
    global _cached_public_voice_ids, _cached_public_voice_ids_backoff_until, _cached_public_voice_ids_task
    _cached_public_voice_ids = None
    _cached_public_voice_ids_backoff_until = 0.0
    if _cached_public_voice_ids_task is not None and not _cached_public_voice_ids_task.done():
        _cached_public_voice_ids_task.cancel()
    _cached_public_voice_ids_task = None


async def shutdown_cached_public_voice_ids_task() -> None:
    """Cancel and await any pending background voice-ID refresh task on shutdown."""
    global _cached_public_voice_ids_task
    task = _cached_public_voice_ids_task
    _cached_public_voice_ids_task = None
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def refresh_cached_public_voice_ids(*, timeout: float = 6.0) -> list[str]:
    """Query active CATALOG/COACHING voice IDs in `tts_audio_cache_entries` and update cache."""
    global _cached_public_voice_ids, _cached_public_voice_ids_backoff_until
    if not is_tts_cache_enabled():
        return []

    async def _query() -> list[str]:
        async with AsyncSessionLocal() as session:
            return await TtsAudioCacheRepository(session).list_active_public_voice_ids()

    try:
        voice_ids = await asyncio.wait_for(_query(), timeout=timeout)
    except Exception:
        _cached_public_voice_ids_backoff_until = (
            time.monotonic() + _CACHED_PUBLIC_VOICE_IDS_ERROR_BACKOFF_SECONDS
        )
        return list(_cached_public_voice_ids[1]) if _cached_public_voice_ids is not None else []

    _cached_public_voice_ids_backoff_until = 0.0
    _cached_public_voice_ids = (time.monotonic(), list(voice_ids))
    return voice_ids


async def prewarm_cached_public_voice_ids(*, timeout: float = 6.0) -> list[str]:
    """Startup prewarm hook so first `/voice/voices` call already has `cached_voice_ids`."""
    return await refresh_cached_public_voice_ids(timeout=timeout)


async def get_cached_public_voice_ids(*, inline_timeout: float | None = None) -> list[str]:
    """Return cached public TTS voice IDs, waiting briefly on cold start and refreshing in background."""
    global _cached_public_voice_ids_task
    if not is_tts_cache_enabled():
        return []

    now = time.monotonic()
    if (
        _cached_public_voice_ids is not None
        and (now - _cached_public_voice_ids[0]) < _CACHED_PUBLIC_VOICE_IDS_TTL_SECONDS
    ):
        return list(_cached_public_voice_ids[1])

    if now < _cached_public_voice_ids_backoff_until:
        return list(_cached_public_voice_ids[1]) if _cached_public_voice_ids is not None else []

    if _cached_public_voice_ids_task is None or _cached_public_voice_ids_task.done():
        _cached_public_voice_ids_task = asyncio.create_task(refresh_cached_public_voice_ids())

    # On cold start (no cached value yet), wait briefly (250ms) so fast pooled DBs resolve inline
    # without delaying /voice/voices >500ms; startup prewarm_cached_public_voice_ids() populates it at boot.
    wait_budget = (
        float(inline_timeout)
        if inline_timeout is not None
        else (0.25 if _cached_public_voice_ids is None else 0.15)
    )
    try:
        return list(
            await asyncio.wait_for(
                asyncio.shield(_cached_public_voice_ids_task),
                timeout=max(0.05, wait_budget),
            )
        )
    except Exception:
        return list(_cached_public_voice_ids[1]) if _cached_public_voice_ids is not None else []


@dataclass(frozen=True, slots=True)
class ResolvedCacheTarget:
    scope: str  # CATALOG | PRIVATE | COACHING
    owner_parent_id: UUID | None
    book_id: UUID | None
    page_id: UUID | None
    page_revision_id: UUID | None
    can_store_on_miss: bool
    defer_allowlist_check: bool = False


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
    cached_speed: float | None = None
    normalized_text: str | None = None


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

    @staticmethod
    def clear_cached_public_voice_ids_cache() -> None:
        clear_cached_public_voice_ids_cache()

    @staticmethod
    async def shutdown_cached_public_voice_ids_task() -> None:
        await shutdown_cached_public_voice_ids_task()

    @staticmethod
    async def refresh_cached_public_voice_ids(*, timeout: float = 6.0) -> list[str]:
        return await refresh_cached_public_voice_ids(timeout=timeout)

    @staticmethod
    async def prewarm_cached_public_voice_ids(*, timeout: float = 6.0) -> list[str]:
        return await prewarm_cached_public_voice_ids(timeout=timeout)

    @staticmethod
    async def get_cached_public_voice_ids(*, inline_timeout: float | None = None) -> list[str]:
        return await get_cached_public_voice_ids(inline_timeout=inline_timeout)

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

        from app.services.games.sentence_extraction import _sentence_spans

        punct = _FOLD_PUNCT_CHARS
        allowed: set[str] = set()
        for verified_text, word_pairs in rows:
            if verified_text:
                norm_page = canonical_tts_text(verified_text)
                if norm_page:
                    allowed.add(norm_page)
                    for span_start, span_end in _sentence_spans(verified_text):
                        norm_sentence = canonical_tts_text(
                            verified_text[span_start:span_end]
                        )
                        if norm_sentence:
                            allowed.add(norm_sentence)
                    for piece in norm_page.split():
                        allowed.add(piece)
                        stripped = piece.strip(punct)
                        if stripped:
                            allowed.add(stripped)
                            allowed.add(stripped.lower())
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
                    allowed.add(stripped_tok.lower())
            if tokens:
                allowed.add(canonical_tts_text(" ".join(tokens)))
        if candidate in allowed:
            return True
        if candidate.startswith("phonics:"):
            phonics_steps = extract_phonics_step_texts(candidate)
            if not phonics_steps:
                return False
            # Last step (or any multi-letter blended word step) must match a verified book word.
            final_word = phonics_steps[-1].strip(punct).lower()
            if final_word and final_word in allowed:
                return True
            if any(step.strip(punct).lower() in allowed for step in reversed(phonics_steps)):
                return True
        return False

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
        defer_allowlist_check: bool = False,
    ) -> ResolvedCacheTarget | None:
        canonical_query = canonical_tts_text(normalized_text) if normalized_text else ""
        if self.repo is not None and (
            page_revision_id is not None or page_id is not None or book_id is not None
        ):
            use_scope_cache = isinstance(self.repo, TtsAudioCacheRepository) and (
                defer_allowlist_check or allow_cache_write
            )
            scope_cache_key: tuple[Any, ...] | None = None
            if use_scope_cache:
                scope_cache_key = (
                    _db_bind_cache_key(self.db),
                    str(actor_id or "-"),
                    str(book_id or "-"),
                    str(page_id or "-"),
                    str(page_revision_id or "-"),
                    bool(allow_cache_write),
                    bool(defer_allowlist_check),
                )
                now_mono = time.monotonic()
                with _CACHE_STATE_LOCK:
                    cached_scope = _SCOPE_TARGET_CACHE.get(scope_cache_key)
                    if cached_scope is not None:
                        if cached_scope[0] > now_mono:
                            _SCOPE_TARGET_CACHE.move_to_end(scope_cache_key)
                            return cached_scope[1]
                        _SCOPE_TARGET_CACHE.pop(scope_cache_key, None)

            def _cache_resolved_target(resolved: ResolvedCacheTarget) -> ResolvedCacheTarget:
                if scope_cache_key is not None:
                    ttl = (
                        _SCOPE_CACHE_PRIVATE_TTL_SECONDS
                        if resolved.scope == "PRIVATE"
                        else _SCOPE_CACHE_CATALOG_TTL_SECONDS
                    )
                    with _CACHE_STATE_LOCK:
                        _SCOPE_TARGET_CACHE[scope_cache_key] = (time.monotonic() + ttl, resolved)
                        _SCOPE_TARGET_CACHE.move_to_end(scope_cache_key)
                        while len(_SCOPE_TARGET_CACHE) > _SCOPE_CACHE_MAX_ENTRIES:
                            _SCOPE_TARGET_CACHE.popitem(last=False)
                return resolved

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
                return _cache_resolved_target(
                    ResolvedCacheTarget(
                        scope="PRIVATE",
                        owner_parent_id=actor_id,
                        book_id=resolved_book_id,
                        page_id=resolved_page_id,
                        page_revision_id=page_revision_id,
                        can_store_on_miss=True,
                    )
                )

            if defer_allowlist_check and not allow_cache_write:
                await self._end_read_tx()
                return _cache_resolved_target(
                    ResolvedCacheTarget(
                        scope="CATALOG",
                        owner_parent_id=None,
                        book_id=resolved_book_id,
                        page_id=resolved_page_id,
                        page_revision_id=page_revision_id,
                        can_store_on_miss=True,
                        defer_allowlist_check=True,
                    )
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
            return _cache_resolved_target(
                ResolvedCacheTarget(
                    scope="CATALOG",
                    owner_parent_id=None,
                    book_id=resolved_book_id,
                    page_id=resolved_page_id,
                    page_revision_id=page_revision_id,
                    can_store_on_miss=can_store_catalog,
                )
            )

        norm_scope = (cache_scope or "").strip().upper() or None
        if norm_scope == "COACHING":
            can_store_coaching = True if allow_cache_write else (
                is_coaching_text_allowlisted(canonical_query)
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
            # Require explicit book_id/page_id before permitting PRIVATE cache writes.
            return ResolvedCacheTarget(
                scope="PRIVATE",
                owner_parent_id=actor_id,
                book_id=book_id,
                page_id=page_id,
                page_revision_id=page_revision_id,
                can_store_on_miss=bool(
                    allow_cache_write and (book_id is not None or page_id is not None)
                ),
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
        model_version: str | None = None,
    ) -> tuple[str, str]:
        ext = _EXTENSION_BY_MIME.get(audio_format, "mp3")
        safe_voice = "".join(
            ch if (ch.isalnum() or ch in {"-", "_"}) else "_" for ch in voice_id
        )[:64] or "voice"
        speed_tag = f"{float(speed):.2f}".replace(".", "p")
        mv_clean = (model_version or "").strip()
        if mv_clean:
            mv_slug = hashlib.sha256(mv_clean.encode("utf-8")).hexdigest()[:8]
            filename = f"{safe_voice}_{mv_slug}_{speed_tag}.{ext}"
        else:
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
        preferred_model_version: str | None = None,
        speed: float = 1.0,
        accept: str | None = None,
        audio_format: str | None = None,
        allow_speed_fallback: bool = True,
        require_word_timings: bool = False,
        background_tasks: Any = None,
    ) -> CachedTtsHit | None:
        if not is_tts_cache_enabled() or self.repo is None or self.db is None:
            return None
        content_sha256 = canonical_tts_sha256(normalized_text)
        formats = preferred_cache_formats(accept=accept, audio_format=audio_format)
        is_real_repo = isinstance(self.repo, TtsAudioCacheRepository)
        use_bg_writes = background_tasks is not None and is_real_repo
        bind_key = _db_bind_cache_key(self.db) if is_real_repo else 0
        today = datetime.now(timezone.utc).date()
        usage_cache_key = (bind_key, today)
        miss_cache_key: tuple[Any, ...] | None = None
        if is_real_repo and bind_key and use_bg_writes:
            miss_cache_key = (
                bind_key,
                target.scope,
                str(target.owner_parent_id or "-"),
                str(target.page_id or "-"),
                content_sha256,
                voice_id,
                model_version or "",
                preferred_model_version or "",
                round(float(speed), 2),
                tuple(formats),
                bool(allow_speed_fallback),
                bool(require_word_timings),
            )
            now_miss_check = time.monotonic()
            with _CACHE_STATE_LOCK:
                miss_exp = _MISS_LOOKUP_CACHE.get(miss_cache_key)
                if miss_exp is not None:
                    if miss_exp > now_miss_check:
                        _MISS_LOOKUP_CACHE.move_to_end(miss_cache_key)
                        background_tasks.add_task(_bg_record_miss)
                        self._record_runtime_miss()
                        return None
                    _MISS_LOOKUP_CACHE.pop(miss_cache_key, None)
        try:
            daily_limit = get_tts_cache_daily_egress_limit_bytes()
            daily_usage: dict[str, int]
            if is_real_repo and daily_limit <= 0:
                daily_usage = {"bytes_served": 0, "hit_count": 0, "miss_count": 0}
            elif is_real_repo:
                now_mono = time.monotonic()
                cached_usage: dict[str, int] | None = None
                with _CACHE_STATE_LOCK:
                    entry_usage = _DAILY_USAGE_CACHE.get(usage_cache_key)
                    if entry_usage is not None and entry_usage[0] > now_mono:
                        cached_usage = dict(entry_usage[1])
                if cached_usage is not None:
                    daily_usage = cached_usage
                else:
                    daily_usage = await self.repo.get_daily_usage()
                    now_put = time.monotonic()
                    with _CACHE_STATE_LOCK:
                        expired_keys = [
                            k for k, (exp, _) in _DAILY_USAGE_CACHE.items() if exp <= now_put
                        ]
                        for k in expired_keys:
                            _DAILY_USAGE_CACHE.pop(k, None)
                        _DAILY_USAGE_CACHE[usage_cache_key] = (
                            now_put + _DAILY_USAGE_CACHE_TTL_SECONDS,
                            dict(daily_usage),
                        )
            else:
                daily_usage = await self.repo.get_daily_usage()

            if daily_limit > 0 and daily_usage["bytes_served"] >= daily_limit:
                await self._end_read_tx()
                self._set_quota_exhausted(True)
                return None
            self._set_quota_exhausted(False)

            entry = None
            folded: str | None = None
            folded_sha256: str | None = None
            if is_real_repo:
                is_phonics = normalized_text.startswith("phonics:")
                if target.scope == "CATALOG" and not is_phonics:
                    folded = folded_catalog_tts_text(normalized_text)
                    if folded and folded != canonical_tts_text(normalized_text):
                        folded_sha256 = canonical_tts_sha256(folded)
                can_search_page_timed = (
                    target.scope == "CATALOG"
                    and bool(folded)
                    and target.page_id is not None
                    and not is_phonics
                    and (require_word_timings or " " in (folded or ""))
                )
                candidates = await self.repo.get_best_active_entries(
                    scope=target.scope,
                    owner_parent_id=target.owner_parent_id,
                    content_sha256=content_sha256,
                    voice_id=voice_id,
                    model_version=model_version,
                    preferred_model_version=preferred_model_version,
                    speed=speed,
                    audio_formats=formats,
                    folded_sha256=folded_sha256,
                    page_id=target.page_id if can_search_page_timed else None,
                    allow_page_timed_fallback=can_search_page_timed,
                    allow_speed_fallback=allow_speed_fallback,
                    require_word_timings=require_word_timings,
                    include_coaching_fallback=(target.scope == "CATALOG" and is_phonics),
                )
                for candidate in candidates:
                    cand_sha = getattr(candidate, "ContentSha256", None)
                    if cand_sha == content_sha256 or (
                        folded_sha256 is not None and cand_sha == folded_sha256
                    ):
                        entry = candidate
                        break
                    cand_text = getattr(candidate, "NormalizedText", None)
                    if (
                        folded
                        and isinstance(cand_text, str)
                        and folded_catalog_tts_text(cand_text) == folded
                    ):
                        entry = candidate
                        break
            else:
                lookup_kwargs: dict[str, Any] = {
                    "scope": target.scope,
                    "owner_parent_id": target.owner_parent_id,
                    "content_sha256": content_sha256,
                    "voice_id": voice_id,
                    "model_version": model_version,
                    "speed": speed,
                    "audio_formats": formats,
                }
                if require_word_timings:
                    lookup_kwargs["require_word_timings"] = True

                entry = await self.repo.get_active_entry(**lookup_kwargs)
                page_fallback_entry = None
                if (
                    entry is None
                    and target.scope == "CATALOG"
                    and not normalized_text.startswith("phonics:")
                ):
                    folded = folded_catalog_tts_text(normalized_text)
                    if folded and folded != canonical_tts_text(normalized_text):
                        folded_sha256 = canonical_tts_sha256(folded)
                        entry = await self.repo.get_active_entry(
                            **{**lookup_kwargs, "content_sha256": folded_sha256}
                        )
                    can_search_page_timed = (
                        bool(folded)
                        and target.page_id is not None
                        and not normalized_text.startswith("phonics:")
                        and (require_word_timings or " " in folded)
                        and callable(
                            getattr(self.repo, "get_active_timed_entries_for_page", None)
                        )
                    )
                    if entry is None and can_search_page_timed:
                        try:
                            candidates = await self.repo.get_active_timed_entries_for_page(
                                scope=target.scope,
                                page_id=target.page_id,
                                voice_id=voice_id,
                                model_version=model_version,
                                speed=speed,
                                audio_formats=formats,
                                allow_speed_fallback=allow_speed_fallback,
                            )
                        except TypeError:
                            candidates = await self.repo.get_active_timed_entries_for_page(
                                scope=target.scope,
                                page_id=target.page_id,
                                voice_id=voice_id,
                                model_version=model_version,
                                speed=speed,
                                audio_formats=formats,
                            )
                        for candidate in candidates or []:
                            cand_text = getattr(candidate, "NormalizedText", None)
                            if (
                                isinstance(cand_text, str)
                                and folded_catalog_tts_text(cand_text) == folded
                            ):
                                cand_speed = getattr(candidate, "Speed", None)
                                if (
                                    cand_speed is None
                                    or abs(float(cand_speed) - float(speed)) < 1e-6
                                    or not allow_speed_fallback
                                ):
                                    entry = candidate
                                    break
                                if page_fallback_entry is None:
                                    page_fallback_entry = candidate
                if entry is None and allow_speed_fallback:
                    nearest_fn = getattr(self.repo, "get_nearest_active_entry", None)
                    if callable(nearest_fn):
                        entry = await nearest_fn(**lookup_kwargs)
                        if entry is None and folded_sha256 is not None:
                            entry = await nearest_fn(
                                **{**lookup_kwargs, "content_sha256": folded_sha256}
                            )
                    if entry is None and page_fallback_entry is not None:
                        entry = page_fallback_entry
                if (
                    entry is None
                    and target.scope == "CATALOG"
                    and normalized_text.startswith("phonics:")
                ):
                    # Shared public phonics clips are deduplicated in COACHING scope
                    # (used by ReadingScreen and DifficultWordPracticePanel); allow
                    # CATALOG-scoped phonics requests to read them too (never PRIVATE).
                    coaching_phonics_kwargs = {
                        **lookup_kwargs,
                        "scope": "COACHING",
                        "owner_parent_id": None,
                    }
                    entry = await self.repo.get_active_entry(**coaching_phonics_kwargs)
                    if entry is None and allow_speed_fallback:
                        nearest_fn = getattr(self.repo, "get_nearest_active_entry", None)
                        if callable(nearest_fn):
                            entry = await nearest_fn(**coaching_phonics_kwargs)

            if entry is not None and not _entry_matches_requested_voice(entry, voice_id):
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="tts_cache_voice_mismatch_rejected",
                    stage="tts_cache",
                    requested_voice_id=voice_id,
                    cached_voice_id=getattr(entry, "VoiceId", None),
                )
                entry = None

            if entry is None:
                if miss_cache_key is not None:
                    with _CACHE_STATE_LOCK:
                        _MISS_LOOKUP_CACHE[miss_cache_key] = (
                            time.monotonic() + _MISS_LOOKUP_CACHE_TTL_SECONDS
                        )
                        _MISS_LOOKUP_CACHE.move_to_end(miss_cache_key)
                        while len(_MISS_LOOKUP_CACHE) > _MISS_LOOKUP_CACHE_MAX_ENTRIES:
                            _MISS_LOOKUP_CACHE.popitem(last=False)
                if use_bg_writes:
                    await self._end_read_tx()
                    background_tasks.add_task(_bg_record_miss)
                else:
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
            raw_entry_speed = getattr(entry, "Speed", None)
            entry_speed = float(raw_entry_speed) if raw_entry_speed is not None else float(speed)
            entry_normalized_text = getattr(entry, "NormalizedText", None)

            if daily_limit > 0 and (daily_usage["bytes_served"] + entry_byte_size) > daily_limit:
                await self._end_read_tx()
                self._set_quota_exhausted(True)
                return None

            # Release read transaction & pool permit before external Storage HTTP download.
            await self._end_read_tx()

            ram_cache_eligible = (
                entry_scope in ("CATALOG", "COACHING")
                and download_object is _ORIGINAL_DOWNLOAD_OBJECT
            )
            cached_ram = (
                _audio_ram_lru_get(entry_bucket, entry_path)
                if ram_cache_eligible
                else None
            )
            if cached_ram is not None:
                audio_bytes, actual_type = cached_ram
            else:
                try:
                    if (
                        download_object is _ORIGINAL_DOWNLOAD_OBJECT
                        and not is_local_storage_enabled()
                    ):
                        audio_bytes = await download_object_async(
                            entry_path,
                            bucket_name=entry_bucket,
                        )
                    else:
                        audio_bytes = await asyncio.to_thread(
                            download_object,
                            entry_path,
                            bucket_name=entry_bucket,
                        )
                except Exception as exc:
                    is_not_found = _is_storage_not_found_error(exc)
                    if not is_not_found:
                        log_diagnostic(
                            logger,
                            logging.WARNING,
                            event="tts_cache_download_transient_error",
                            stage="tts_cache",
                            exception=exc,
                        )
                    if use_bg_writes:
                        background_tasks.add_task(
                            _bg_record_miss,
                            entry_id if is_not_found else None,
                        )
                    else:
                        if is_not_found:
                            await self.repo.mark_entries_status([entry_id], status="STALE")
                        await self.repo.record_miss()
                        await self.db.commit()
                    self._record_runtime_miss()
                    return None
                actual_type = detect_audio_content_type(audio_bytes, entry_format)
                if ram_cache_eligible:
                    _audio_ram_lru_put(entry_bucket, entry_path, audio_bytes, actual_type)

            if is_real_repo:
                with _CACHE_STATE_LOCK:
                    existing_usage = _DAILY_USAGE_CACHE.get(usage_cache_key)
                    if existing_usage is not None:
                        updated_usage = dict(existing_usage[1])
                        updated_usage["bytes_served"] = (
                            int(updated_usage.get("bytes_served", 0)) + len(audio_bytes)
                        )
                        updated_usage["hit_count"] = int(updated_usage.get("hit_count", 0)) + 1
                        _DAILY_USAGE_CACHE[usage_cache_key] = (existing_usage[0], updated_usage)

            if use_bg_writes:
                background_tasks.add_task(_bg_record_hit, entry_id, len(audio_bytes))
            else:
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
                cached_speed=entry_speed,
                normalized_text=entry_normalized_text if isinstance(entry_normalized_text, str) else None,
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

    async def schedule_store_cached_audio(
        self,
        *,
        background_tasks: Any = None,
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
        """Schedule cache persistence off the response hot path when FastAPI BackgroundTasks is available."""
        if (
            not is_tts_cache_enabled()
            or not target.can_store_on_miss
            or not audio_bytes
        ):
            return False
        if background_tasks is not None and isinstance(self.repo, TtsAudioCacheRepository):
            background_tasks.add_task(
                _bg_store_cached_audio,
                target=target,
                normalized_text=normalized_text,
                voice_id=voice_id,
                model_version=model_version,
                speed=speed,
                audio_bytes=audio_bytes,
                source_content_type=source_content_type,
                duration_seconds=duration_seconds,
                word_timings_json=word_timings_json,
            )
            return True
        return await self.store_cached_audio(
            target=target,
            normalized_text=normalized_text,
            voice_id=voice_id,
            model_version=model_version,
            speed=speed,
            audio_bytes=audio_bytes,
            source_content_type=source_content_type,
            duration_seconds=duration_seconds,
            word_timings_json=word_timings_json,
        )

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

        if target.defer_allowlist_check:
            if target.scope == "CATALOG":
                if target.book_id is None:
                    return False
                try:
                    allowed = await self._is_catalog_text_allowlisted(
                        book_id=target.book_id,
                        page_id=target.page_id,
                        page_revision_id=target.page_revision_id,
                        normalized_text=normalized_text,
                    )
                    await self._end_read_tx()
                except SQLAlchemyError as exc:
                    await self._safe_rollback()
                    log_diagnostic(
                        logger,
                        logging.WARNING,
                        event="tts_cache_allowlist_check_failed",
                        stage="tts_cache",
                        exception=exc,
                    )
                    return False
                if not allowed:
                    return False
            elif target.scope == "COACHING":
                if not is_coaching_text_allowlisted(normalized_text):
                    return False

        if (
            target.scope == "PRIVATE"
            and (
                target.owner_parent_id is None
                or (target.book_id is None and target.page_id is None)
            )
        ):
            return False

        compressed_bytes, stored_format = await asyncio.to_thread(
            transcode_to_mp3_64k,
            audio_bytes,
            source_content_type,
        )
        max_bytes = get_tts_cache_max_bytes()
        global_cap = get_tts_cache_global_max_bytes()
        if target.scope == "PRIVATE":
            effective_item_cap = min(
                max_bytes,
                get_tts_private_owner_max_bytes(),
                get_tts_private_global_max_bytes(),
                global_cap,
            )
        else:
            effective_item_cap = min(max_bytes, global_cap)
        if len(compressed_bytes) > effective_item_cap:
            return False

        content_sha256 = canonical_tts_sha256(normalized_text)
        bucket, storage_path = self.build_storage_location(
            target=target,
            content_sha256=content_sha256,
            voice_id=voice_id,
            speed=speed,
            audio_format=stored_format,
            model_version=model_version,
        )

        # Check if an ACTIVE entry already owns this exact Storage object so a DB error
        # never deletes a pre-existing live object!
        preexisting_live_object = False
        try:
            existing_entry = await self.repo.get_active_entry(
                scope=target.scope,
                owner_parent_id=target.owner_parent_id,
                content_sha256=content_sha256,
                voice_id=voice_id,
                model_version=model_version,
                speed=speed,
                audio_formats=[stored_format],
            )
            if existing_entry is not None and (
                str(existing_entry.StorageBucket) == bucket
                and str(existing_entry.StoragePath) == storage_path
            ):
                preexisting_live_object = True
        except Exception:
            preexisting_live_object = False

        uploaded_new_object = False

        async def _storage_path_owned_by_active_row(
            target_bucket: str, target_path: str
        ) -> bool:
            check_fn = getattr(self.repo, "has_active_entry_for_storage_path", None)
            if not callable(check_fn):
                return False
            try:
                owned = bool(await check_fn(target_bucket, target_path))
                await self._end_read_tx()
                return owned
            except Exception:
                await self._safe_rollback()
                # Fail-safe on check error during rollback: avoid deleting a possibly live object.
                return True

        try:
            await asyncio.to_thread(
                upload_object,
                storage_path,
                compressed_bytes,
                stored_format,
                bucket_name=bucket,
                upsert=True,
            )
            uploaded_new_object = True
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
                scope=target.scope,
                owner_parent_id=target.owner_parent_id,
            )
            await self.db.commit()
            invalidate_tts_cache_summary_cache()
            with _CACHE_STATE_LOCK:
                _MISS_LOOKUP_CACHE.clear()
        except Exception as exc:
            await self._safe_rollback()
            still_owned = await _storage_path_owned_by_active_row(bucket, storage_path)
            if uploaded_new_object and not preexisting_live_object and not still_owned:
                try:
                    await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
                except Exception:
                    pass
            elif still_owned and isinstance(exc, IntegrityError):
                # A concurrent writer committed the exact same active entry; keep its blob intact.
                return True
            log_diagnostic(
                logger,
                logging.WARNING,
                event="tts_cache_store_failed",
                stage="tts_cache",
                exception=exc,
            )
            return False

        _audio_ram_lru_evict([(bucket, storage_path), *replaced, *evicted_objects])
        to_delete: list[tuple[str, str]] = []
        for old_bucket, old_path in [*replaced, *evicted_objects]:
            if (old_bucket, old_path) == (bucket, storage_path):
                continue
            if await _storage_path_owned_by_active_row(old_bucket, old_path):
                continue
            to_delete.append((old_bucket, old_path))
        if to_delete:
            sem = asyncio.Semaphore(4)

            async def _delete_one(old_bucket: str, old_path: str) -> None:
                async with sem:
                    await asyncio.to_thread(delete_object, old_path, bucket_name=old_bucket)

            await asyncio.gather(*(_delete_one(b, p) for b, p in to_delete))
        return True

    async def _get_partition_active_bytes(
        self,
        *,
        partition_scopes: tuple[str, ...] | None,
        partition_owner: UUID | None,
    ) -> tuple[int, bool]:
        assert self.repo is not None
        scoped_repo = True
        try:
            total = await self.repo.total_active_bytes(
                scopes=partition_scopes,
                owner_parent_id=partition_owner,
            )
        except TypeError:
            scoped_repo = False
            total = await self.repo.total_active_bytes()

        if not scoped_repo and partition_scopes is not None:
            entries_map = getattr(self.repo, "entries", None)
            if isinstance(entries_map, dict):
                total = sum(
                    int(getattr(e, "ByteSize", 0) or 0)
                    for e in entries_map.values()
                    if getattr(e, "Status", None) == "ACTIVE"
                    and getattr(e, "Scope", None) in partition_scopes
                    and (
                        partition_owner is None
                        or getattr(e, "OwnerParentId", None) == partition_owner
                    )
                )
        return int(total or 0), scoped_repo

    async def _evict_excess_from_partition(
        self,
        *,
        excess_bytes: int,
        partition_scopes: tuple[str, ...] | None,
        partition_owner: UUID | None,
        exclude_ids: list[UUID],
    ) -> list[tuple[str, str]]:
        assert self.repo is not None
        if excess_bytes <= 0:
            return []
        remaining_to_shed = int(excess_bytes)
        evict_ids: list[UUID] = []
        evict_objects: list[tuple[str, str]] = []
        batch_size = 200
        for _ in range(10):
            if remaining_to_shed <= 0:
                break
            batch_scoped = True
            try:
                candidates = await self.repo.list_lru_eviction_candidates(
                    exclude_ids=tuple(exclude_ids),
                    scopes=partition_scopes,
                    owner_parent_id=partition_owner,
                    limit=batch_size,
                )
            except TypeError:
                batch_scoped = False
                candidates = await self.repo.list_lru_eviction_candidates(
                    exclude_ids=tuple(exclude_ids), limit=batch_size
                )
            if not candidates:
                break
            raw_count = len(candidates)
            if not batch_scoped and partition_scopes is not None:
                candidates = [
                    item
                    for item in candidates
                    if getattr(item, "Scope", None) in partition_scopes
                    and (
                        partition_owner is None
                        or getattr(item, "OwnerParentId", None) == partition_owner
                    )
                ]
            progressed = False
            for item in candidates:
                if remaining_to_shed <= 0:
                    break
                if item.Id in exclude_ids:
                    continue
                exclude_ids.append(item.Id)
                evict_ids.append(item.Id)
                evict_objects.append((str(item.StorageBucket), str(item.StoragePath)))
                remaining_to_shed -= int(item.ByteSize or 0)
                progressed = True
            if not progressed or raw_count < batch_size:
                break
        if evict_ids:
            await self.repo.mark_entries_status(evict_ids, status="DELETED")
        return evict_objects

    async def _enforce_lru_quota(
        self,
        *,
        max_bytes: int,
        keep_entry_id: UUID | None = None,
        scope: str | None = None,
        owner_parent_id: UUID | None = None,
    ) -> list[tuple[str, str]]:
        assert self.repo is not None
        exclude_ids: list[UUID] = [keep_entry_id] if keep_entry_id is not None else []
        evicted_objects: list[tuple[str, str]] = []
        global_cap = get_tts_cache_global_max_bytes()

        if scope == "PRIVATE":
            # Tier 1: Per-parent PRIVATE cap
            owner_cap = min(int(max_bytes), get_tts_private_owner_max_bytes())
            owner_total, _ = await self._get_partition_active_bytes(
                partition_scopes=("PRIVATE",),
                partition_owner=owner_parent_id,
            )
            if owner_total > owner_cap:
                evicted_objects.extend(
                    await self._evict_excess_from_partition(
                        excess_bytes=owner_total - owner_cap,
                        partition_scopes=("PRIVATE",),
                        partition_owner=owner_parent_id,
                        exclude_ids=exclude_ids,
                    )
                )

            # Tier 2: Global PRIVATE cap across all parents
            private_global_cap = get_tts_private_global_max_bytes()
            priv_total, _ = await self._get_partition_active_bytes(
                partition_scopes=("PRIVATE",),
                partition_owner=None,
            )
            if priv_total > private_global_cap:
                evicted_objects.extend(
                    await self._evict_excess_from_partition(
                        excess_bytes=priv_total - private_global_cap,
                        partition_scopes=("PRIVATE",),
                        partition_owner=None,
                        exclude_ids=exclude_ids,
                    )
                )

            # Tier 3: Cross-scope global safety ceiling (PRIVATE writes never evict CATALOG/COACHING)
            global_total, _ = await self._get_partition_active_bytes(
                partition_scopes=None,
                partition_owner=None,
            )
            if global_total > global_cap:
                evicted_objects.extend(
                    await self._evict_excess_from_partition(
                        excess_bytes=global_total - global_cap,
                        partition_scopes=("PRIVATE",),
                        partition_owner=None,
                        exclude_ids=exclude_ids,
                    )
                )
            return evicted_objects

        if scope in ("CATALOG", "COACHING"):
            # Tier 1: Public CATALOG + COACHING partition cap
            pub_total, _ = await self._get_partition_active_bytes(
                partition_scopes=("CATALOG", "COACHING"),
                partition_owner=None,
            )
            if pub_total > max_bytes:
                evicted_objects.extend(
                    await self._evict_excess_from_partition(
                        excess_bytes=pub_total - max_bytes,
                        partition_scopes=("CATALOG", "COACHING"),
                        partition_owner=None,
                        exclude_ids=exclude_ids,
                    )
                )

            # Tier 2: Cross-scope global safety ceiling (evict PRIVATE first, then CATALOG/COACHING)
            global_total, _ = await self._get_partition_active_bytes(
                partition_scopes=None,
                partition_owner=None,
            )
            if global_total > global_cap:
                evicted_objects.extend(
                    await self._evict_excess_from_partition(
                        excess_bytes=global_total - global_cap,
                        partition_scopes=("PRIVATE",),
                        partition_owner=None,
                        exclude_ids=exclude_ids,
                    )
                )
                global_total, _ = await self._get_partition_active_bytes(
                    partition_scopes=None,
                    partition_owner=None,
                )
                if global_total > global_cap:
                    evicted_objects.extend(
                        await self._evict_excess_from_partition(
                            excess_bytes=global_total - global_cap,
                            partition_scopes=("CATALOG", "COACHING"),
                            partition_owner=None,
                            exclude_ids=exclude_ids,
                        )
                    )
            return evicted_objects

        total, _ = await self._get_partition_active_bytes(
            partition_scopes=None,
            partition_owner=None,
        )
        effective_cap = min(int(max_bytes), global_cap)
        if total > effective_cap:
            evicted_objects.extend(
                await self._evict_excess_from_partition(
                    excess_bytes=total - effective_cap,
                    partition_scopes=None,
                    partition_owner=None,
                    exclude_ids=exclude_ids,
                )
            )
        return evicted_objects

    async def invalidate_target(
        self,
        *,
        book_id: UUID | None = None,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
        commit: bool = False,
    ) -> int | list[tuple[str, str]]:
        """Mark matching TTS cache rows STALE.

        When `commit=True`, commits and deletes stale Storage objects post-commit, returning the count.
        When `commit=False`, does NOT touch Storage yet and returns `list[(bucket, path)]` so the
        caller can call `delete_stale_tts_objects(stale_paths)` AFTER committing its transaction.
        """
        if self.repo is None or self.db is None:
            return 0 if commit else []
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
            return 0 if commit else []

        if stale_objects:
            invalidate_tts_cache_summary_cache()
        _scope_cache_invalidate(
            book_id=book_id,
            page_id=page_id,
            page_revision_id=page_revision_id,
        )
        _audio_ram_lru_evict(list(stale_objects))
        if not commit:
            return list(stale_objects)

        await delete_stale_tts_objects(stale_objects)
        return len(stale_objects)

    async def get_summary(self, *, bypass_cache: bool = False) -> dict[str, Any]:
        max_bytes = get_tts_cache_max_bytes()
        daily_limit = get_tts_cache_daily_egress_limit_bytes()
        if self.repo is not None:
            use_summary_cache = isinstance(self.repo, TtsAudioCacheRepository) and self.db is not None
            if use_summary_cache:
                cached = get_cached_tts_audio_cache_summary(
                    self.db,
                    max_bytes=max_bytes,
                    daily_limit=daily_limit,
                    bypass_cache=bypass_cache,
                )
                if cached is not None:
                    return cached
            try:
                summary = await self.repo.get_summary()
                hits = int(summary["hit_count"])
                misses = int(summary["miss_count"])
                total_reqs = hits + misses
                daily_egress = int(summary["daily_egress_bytes"])
                runtime_quota = is_tts_cache_runtime_quota_exhausted()
                quota_exhausted = runtime_quota or (
                    daily_limit > 0 and daily_egress >= daily_limit
                )
                result = {
                    "entry_count": int(summary["entry_count"]),
                    "storage_used_bytes": int(summary["storage_used_bytes"]),
                    "storage_quota_bytes": max_bytes,
                    "daily_egress_bytes": daily_egress,
                    "daily_egress_limit_bytes": daily_limit,
                    "cache_hit_ratio": round(hits / total_reqs, 4) if total_reqs > 0 else None,
                    "quota_exhausted": quota_exhausted,
                }
                if use_summary_cache:
                    set_cached_tts_audio_cache_summary(
                        self.db,
                        result,
                        max_bytes=max_bytes,
                        daily_limit=daily_limit,
                    )
                return result
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


async def delete_stale_tts_objects(stale_objects: list[tuple[str, str]]) -> None:
    """Delete invalidated TTS cache objects from Storage AFTER the caller commits DB."""
    if not stale_objects:
        return
    invalidate_tts_cache_summary_cache()
    _audio_ram_lru_evict(stale_objects)
    sem = asyncio.Semaphore(4)

    async def _delete_one(bucket: str, path: str) -> None:
        async with sem:
            try:
                await asyncio.to_thread(delete_object, path, bucket_name=bucket)
            except Exception as exc:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="tts_cache_post_commit_delete_failed",
                    stage="tts_cache",
                    exception=exc,
                )

    await asyncio.gather(*(_delete_one(bucket, path) for bucket, path in stale_objects))


async def invalidate_tts_cache_best_effort(
    db: AsyncSession | None,
    *,
    book_id: UUID | None = None,
    page_id: UUID | None = None,
    page_revision_id: UUID | None = None,
    commit: bool = False,
) -> int | list[tuple[str, str]]:
    """Safely mark affected TTS cache rows STALE without breaking legacy/minimal DB schemas."""
    if db is None or not isinstance(db, AsyncSession):
        return 0 if commit else []
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
            return []
    return await service.invalidate_target(
        book_id=book_id,
        page_id=page_id,
        page_revision_id=page_revision_id,
        commit=commit,
    )
