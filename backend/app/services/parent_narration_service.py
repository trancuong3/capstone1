"""Parent Narration & Family Postcard Service for Feature #2 (PARENT_PRIVATE).

Implements:
  - Strict PARENT_PRIVATE household isolation (`ChildProfile.ParentId == parent_id` and
    `Book.VisibilityScope == 'PARENT_PRIVATE' and Book.OwnerParentId == parent_id`).
  - Strict audio magic-byte sniffing (`webm`, `ogg`, `wav`, `mp3`, `m4a`, `aac`) + size caps
    (`<= 2 MiB` for page narration, `<= 256 KiB` for postcard clip).
  - Synchronized word-timing generation (`[{word, start_ms, end_ms}]`):
      1. Optional CTC forced alignment (`ai/karaoke_processing/`) when configured/available,
      2. Real 20ms RMS acoustic-envelope boundary alignment for PCM WAV recordings,
      3. Fast deterministic Vietnamese syllable/tone/coda duration aligner fallback so
         `word_timings` is ALWAYS generated.
  - Private binary storage via `storage_service` (`SUPABASE_PRIVATE_BOOKS_BUCKET`) with zero
    public URLs, automatic storage cleanup on replace/delete/book cleanup, and isolated
    in-memory test fallback when `APP_ENVIRONMENT == 'test'` without external Storage.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
import logging
import math
import re
import struct
from typing import Any
import unicodedata
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import APP_ENVIRONMENT, SUPABASE_PRIVATE_BOOKS_BUCKET
from app.models.book import Book, BookPage, PageRevision
from app.models.co_reading import FamilyReadingPostcard, ParentPageNarration
from app.models.profile import ChildProfile
from app.schemas.co_reading import (
    AlignmentSource,
    AudioFormat,
    NarrationDeleteResponse,
    NarrationMetaResponse,
    NarrationUploadResponse,
    ParseScriptRequest,
    ParseScriptResponse,
    PostcardCreateRequest,
    PostcardDeleteResponse,
    PostcardListResponse,
    PostcardRead,
    WordTiming,
)
from app.services.dialogue_role_parser import (
    parse_script,
    resolve_teacher_voice_id,
    summarize_character_voices,
)
from app.services.storage_service import delete_object, download_object, upload_object

logger = logging.getLogger("viread.co_reading")

MAX_NARRATION_BYTES = 2 * 1024 * 1024       # 2 MiB
MAX_POSTCARD_CLIP_BYTES = 256 * 1024        # 256 KiB
MIN_AUDIO_HEADER_BYTES = 12

_FORMAT_TO_CONTENT_TYPE: dict[AudioFormat, str] = {
    "webm": "audio/webm",
    "ogg": "audio/ogg",
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
}

_FTYP_AUDIO_BRANDS = frozenset(
    {b"M4A ", b"M4B ", b"mp42", b"mp41", b"isom", b"iso2", b"3gp4", b"dash"}
)

# Isolated ephemeral fallback map used strictly when APP_ENVIRONMENT == "test"
# and no external Supabase Storage / local storage dir is configured.
_TEST_MEMORY_AUDIO_OBJECTS: dict[tuple[str, str], bytes] = {}


def clear_test_narration_storage() -> None:
    """Clear in-memory test audio store between unit tests."""
    _TEST_MEMORY_AUDIO_OBJECTS.clear()


# ---------------------------------------------------------------------------
# Strict Audio Magic-Byte Sniffing & Size Validation
# ---------------------------------------------------------------------------


def detect_audio_format(data: bytes) -> AudioFormat | None:
    """Sniff magic bytes for `webm`, `ogg`, `wav`, `mp3`, `m4a`, or `aac`."""
    if not data or len(data) < MIN_AUDIO_HEADER_BYTES:
        return None

    head = data[:16]

    # Reject common disguised non-audio headers immediately
    if (
        head.startswith(b"\x89PNG\r\n\x1a\n")
        or head.startswith(b"\xff\xd8\xff")  # JPEG
        or head.startswith(b"%PDF-")
        or head.startswith(b"GIF87a")
        or head.startswith(b"GIF89a")
        or head.startswith(b"PK\x03\x04")
        or head.startswith(b"MZ")
        or head.lstrip().startswith((b"<", b"{", b"["))
    ):
        return None

    # 1. WebM / Matroska EBML
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"

    # 2. Ogg Opus / Vorbis
    if head[:4] == b"OggS":
        return "ogg"

    # 3. RIFF WAVE
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"

    # 4. ISO BMFF M4A / MP4 audio container (`....ftyp`)
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in _FTYP_AUDIO_BRANDS or brand.isalnum():
            return "m4a"

    # 5. ID3v2-tagged MP3
    if head[:3] == b"ID3":
        return "mp3"

    # 6. ADTS AAC frame sync: 0xFFF (12 bits = 1) and layer bits (b1 & 0x06) == 0x00
    b0, b1 = head[0], head[1]
    if b0 == 0xFF and (b1 & 0xF6) == 0xF0:
        return "aac"

    # 7. MPEG-1/2/2.5 Layer I/II/III frame sync:
    #    11-bit sync (b0 == 0xFF and (b1 & 0xE0) == 0xE0),
    #    version bits != 01, layer bits != 00, bitrate index != 0xF
    if b0 == 0xFF and (b1 & 0xE0) == 0xE0:
        version_bits = (b1 >> 3) & 0x03
        layer_bits = (b1 >> 1) & 0x03
        bitrate_idx = (head[2] >> 4) & 0x0F
        sample_idx = (head[2] >> 2) & 0x03
        if version_bits != 0x01 and layer_bits != 0x00 and bitrate_idx != 0x0F and sample_idx != 0x03:
            return "mp3"

    return None


def validate_audio_payload(data: bytes, *, max_bytes: int) -> AudioFormat:
    """Validate audio payload size and magic bytes, raising HTTPException (422/413/415)."""
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="AUDIO_EMPTY",
        )
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="AUDIO_TOO_LARGE",
        )
    detected = detect_audio_format(data)
    if detected is None:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="UNSUPPORTED_AUDIO_MAGIC_BYTES",
        )
    return detected


def content_type_for_format(fmt: AudioFormat | str) -> str:
    return _FORMAT_TO_CONTENT_TYPE.get(fmt, "application/octet-stream")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Word-Timing Aligner (CTC -> Acoustic Envelope -> Syllable Duration Fallback)
# ---------------------------------------------------------------------------

_AVG_SYLLABLE_MS = 240
_INTER_WORD_GAP_MS = 35
_TONE_CHARS = frozenset(
    "àáảãạăắặằẳẵâấậầẩẫèéẹẻẽêếệềểễìíịỉĩòóọỏõôốộồổỗơớợờởỡùúụủũưứựừửữỳýỵỷỹ"
    "ÀÁẢÃẠĂẮẶẰẲẴÂẤẬẦẨẪÈÉẸẺẼÊẾỆỀỂỄÌÍỊỈĨÒÓỌỎÕÔỐỘỒỔỖƠỚỢỜỞỠÙÚỤỦŨƯỨỰỪỬỮỲÝỴỶỸ"
)
_LONG_CODAS = ("ng", "nh", "ch", "m", "n", "o", "u", "i", "y")


def tokenize_alignment_words(page_text: str) -> list[str]:
    """Tokenize Vietnamese page text into ordered clean words for karaoke-style highlighting."""
    nfc = unicodedata.normalize("NFC", page_text or "")
    raw_tokens = re.findall(r"[\w\u00C0-\u024F\u1E00-\u1EFF]+", nfc, flags=re.UNICODE)
    return [tok for tok in raw_tokens if any(ch.isalpha() for ch in tok)]


def _word_duration_weight(word: str) -> float:
    low = word.casefold()
    weight = 1.0 + min(0.45, max(0, len(low) - 2) * 0.08)
    if any(ch in _TONE_CHARS for ch in word):
        weight += 0.07
    if low.endswith(_LONG_CODAS):
        weight += 0.08
    return weight


def _try_parse_wav_pcm_envelope(audio_bytes: bytes) -> tuple[int, list[float]] | None:
    """Extract `(duration_ms, rms_20ms_frames)` from uncompressed PCM WAV if valid."""
    if len(audio_bytes) < 44 or audio_bytes[:4] != b"RIFF" or audio_bytes[8:12] != b"WAVE":
        return None
    try:
        offset = 12
        audio_fmt = 0
        channels = 1
        sample_rate = 16000
        bits_per_sample = 16
        pcm_data: bytes | None = None

        while offset + 8 <= len(audio_bytes):
            chunk_id = audio_bytes[offset : offset + 4]
            chunk_size = struct.unpack_from("<I", audio_bytes, offset + 4)[0]
            body_start = offset + 8
            body_end = min(len(audio_bytes), body_start + chunk_size)
            if chunk_id == b"fmt " and body_end - body_start >= 16:
                audio_fmt, channels, sample_rate, _byte_rate, _block_align, bits_per_sample = (
                    struct.unpack_from("<HHIIHH", audio_bytes, body_start)
                )
            elif chunk_id == b"data":
                pcm_data = audio_bytes[body_start:body_end]
                break
            offset = body_start + chunk_size + (chunk_size % 2)

        if audio_fmt != 1 or pcm_data is None or sample_rate < 4000 or channels < 1:
            return None
        if bits_per_sample != 16:
            return None

        bytes_per_sample_frame = 2 * channels
        total_sample_frames = len(pcm_data) // bytes_per_sample_frame
        if total_sample_frames < sample_rate // 10:
            return None

        duration_ms = max(120, int(round(total_sample_frames * 1000.0 / sample_rate)))
        samples_per_20ms = max(1, (sample_rate * 20) // 1000)
        bytes_per_window = samples_per_20ms * bytes_per_sample_frame
        n_windows = len(pcm_data) // bytes_per_window
        if n_windows < 5:
            return duration_ms, []

        rms_frames: list[float] = []
        for w in range(n_windows):
            win = pcm_data[w * bytes_per_window : (w + 1) * bytes_per_window]
            # Sample every channel-0 int16 (step by bytes_per_sample_frame)
            acc = 0.0
            count = 0
            for pos in range(0, len(win) - 1, bytes_per_sample_frame):
                sample_val = struct.unpack_from("<h", win, pos)[0] / 32768.0
                acc += sample_val * sample_val
                count += 1
            rms_frames.append(math.sqrt(acc / max(1, count)))
        return duration_ms, rms_frames
    except Exception:
        return None


def align_words_with_acoustic_or_syllable_fallback(
    words: list[str],
    duration_ms: int,
    *,
    rms_frames_20ms: list[float] | None = None,
) -> tuple[list[WordTiming], AlignmentSource]:
    """Deterministically align `words` across `[0, duration_ms]` using acoustic envelope if present."""
    safe_duration = max(120, int(duration_ms))
    if not words:
        return [WordTiming(word="...", start_ms=0, end_ms=safe_duration)], "syllable_duration"

    speech_start_ms = 0
    speech_end_ms = safe_duration
    source: AlignmentSource = "syllable_duration"

    if rms_frames_20ms and len(rms_frames_20ms) >= 6:
        peak = max(rms_frames_20ms)
        if peak >= 0.004:
            threshold = max(0.0015, peak * 0.10)
            active_indices = [i for i, val in enumerate(rms_frames_20ms) if val >= threshold]
            if active_indices:
                speech_start_ms = max(0, min(safe_duration // 3, active_indices[0] * 20))
                speech_end_ms = min(
                    safe_duration,
                    max(speech_start_ms + 80, (active_indices[-1] + 1) * 20),
                )
                source = "acoustic_envelope"

    usable_span_ms = max(len(words) * 20, speech_end_ms - speech_start_ms)
    weights = [_word_duration_weight(w) for w in words]
    total_weight = sum(weights) or float(len(words))
    gap_ms = min(
        _INTER_WORD_GAP_MS,
        max(0, usable_span_ms // max(4, len(words) * 6)),
    )
    total_gaps = gap_ms * max(0, len(words) - 1)
    net_word_span = max(len(words) * 15, usable_span_ms - total_gaps)

    timings: list[WordTiming] = []
    cursor_ms = speech_start_ms
    for idx, (word, weight) in enumerate(zip(words, weights)):
        if idx == len(words) - 1:
            end_ms = max(cursor_ms + 10, speech_end_ms)
        else:
            alloc = max(15, int(round(net_word_span * (weight / total_weight))))
            end_ms = min(speech_end_ms - (len(words) - 1 - idx) * 10, cursor_ms + alloc)
            end_ms = max(cursor_ms + 10, end_ms)
        timings.append(WordTiming(word=word, start_ms=cursor_ms, end_ms=end_ms))
        cursor_ms = min(speech_end_ms, end_ms + gap_ms)

    return timings, source


CtcAlignerCallable = Callable[[bytes, list[str], int], Awaitable[list[WordTiming] | None]]


async def generate_word_timings(
    audio_bytes: bytes,
    page_text: str,
    duration_ms: int | None = None,
    *,
    ctc_aligner: CtcAlignerCallable | None = None,
) -> tuple[int, list[WordTiming], AlignmentSource]:
    """Generate `(resolved_duration_ms, word_timings, alignment_source)` for parent narration."""
    words = tokenize_alignment_words(page_text)
    wav_info = _try_parse_wav_pcm_envelope(audio_bytes)

    resolved_duration = int(duration_ms) if duration_ms and duration_ms > 0 else 0
    rms_frames: list[float] | None = None
    if wav_info is not None:
        wav_duration_ms, rms_frames = wav_info
        if resolved_duration <= 0:
            resolved_duration = wav_duration_ms

    if resolved_duration <= 0:
        estimated_from_words = max(600, len(words) * _AVG_SYLLABLE_MS)
        estimated_from_bytes = max(600, int(len(audio_bytes) / 16))
        resolved_duration = min(180_000, max(estimated_from_words, min(estimated_from_bytes, 60_000)))

    if ctc_aligner is not None and words:
        try:
            ctc_timings = await ctc_aligner(audio_bytes, words, resolved_duration)
            if ctc_timings:
                return resolved_duration, ctc_timings, "ctc_forced"
        except Exception:
            logger.debug("Optional CTC aligner unavailable; falling back to envelope/syllable aligner")

    timings, source = align_words_with_acoustic_or_syllable_fallback(
        words,
        resolved_duration,
        rms_frames_20ms=rms_frames,
    )
    return resolved_duration, timings, source


# ---------------------------------------------------------------------------
# Private Storage Helpers (Supabase Storage + isolated test memory fallback)
# ---------------------------------------------------------------------------


async def _store_private_audio_bytes(
    storage_path: str,
    audio_bytes: bytes,
    content_type: str,
) -> None:
    bucket = SUPABASE_PRIVATE_BOOKS_BUCKET
    try:
        await asyncio.to_thread(
            upload_object,
            storage_path,
            audio_bytes,
            content_type,
            bucket_name=bucket,
            upsert=True,
        )
    except HTTPException:
        if APP_ENVIRONMENT == "test":
            _TEST_MEMORY_AUDIO_OBJECTS[(bucket, storage_path)] = bytes(audio_bytes)
            return
        raise


async def _load_private_audio_bytes(storage_path: str) -> bytes:
    bucket = SUPABASE_PRIVATE_BOOKS_BUCKET
    try:
        return await asyncio.to_thread(
            download_object,
            storage_path,
            bucket_name=bucket,
        )
    except HTTPException:
        if APP_ENVIRONMENT == "test":
            cached = _TEST_MEMORY_AUDIO_OBJECTS.get((bucket, storage_path))
            if cached is not None:
                return cached
        raise


async def _delete_private_audio_bytes(storage_path: str | None) -> None:
    if not storage_path:
        return
    bucket = SUPABASE_PRIVATE_BOOKS_BUCKET
    _TEST_MEMORY_AUDIO_OBJECTS.pop((bucket, storage_path), None)
    try:
        await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
    except Exception:
        pass


def _build_narration_storage_path(
    parent_id: UUID,
    book_id: UUID,
    page_id: UUID,
    fmt: AudioFormat,
) -> str:
    return f"parent-narrations/{parent_id}/{book_id}/{page_id}.{fmt}"


def _build_postcard_clip_path(
    parent_id: UUID,
    child_id: UUID,
    postcard_id: UUID,
    fmt: AudioFormat,
) -> str:
    return f"family-postcards/{parent_id}/{child_id}/{postcard_id}.{fmt}"


def _narration_audio_endpoint(book_id: UUID, page_id: UUID) -> str:
    return f"/co-reading/my-books/{book_id}/pages/{page_id}/narration/audio"


def _postcard_audio_endpoint(child_id: UUID, postcard_id: UUID) -> str:
    return f"/co-reading/children/{child_id}/postcards/{postcard_id}/audio"


# ---------------------------------------------------------------------------
# Service Layer
# ---------------------------------------------------------------------------


class ParentNarrationService:
    """Service enforcing PARENT_PRIVATE household isolation for Co-Reading, Narrations & Postcards."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        ctc_aligner: CtcAlignerCallable | None = None,
    ) -> None:
        self._db = db
        self._ctc_aligner = ctc_aligner

    # ------------------------------------------------------------------
    # Ownership & Canonical Text Helpers
    # ------------------------------------------------------------------

    async def _require_owned_child(self, parent_id: UUID, child_id: UUID) -> ChildProfile:
        child = (
            await self._db.execute(
                select(ChildProfile).where(ChildProfile.Id == child_id)
            )
        ).scalar_one_or_none()
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        if child.ParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied to child profile",
            )
        return child

    async def _require_owned_private_book_page(
        self,
        parent_id: UUID,
        book_id: UUID,
        page_id: UUID,
    ) -> tuple[Book, BookPage]:
        book = (
            await self._db.execute(select(Book).where(Book.Id == book_id))
        ).scalar_one_or_none()
        if (
            book is None
            or bool(getattr(book, "IsDeleted", False))
            or getattr(book, "LifecycleStatus", "") == "RETIRED"
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Book not found",
            )
        if getattr(book, "VisibilityScope", "") != "PARENT_PRIVATE" or book.OwnerParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: narration requires an owned PARENT_PRIVATE book",
            )

        page = (
            await self._db.execute(
                select(BookPage).where(
                    BookPage.Id == page_id,
                    BookPage.BookId == book_id,
                )
            )
        ).scalar_one_or_none()
        if page is None or getattr(page, "LifecycleStatus", "") == "RETIRED":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Book page not found",
            )
        return book, page

    async def _resolve_page_text_for_reader(
        self,
        parent_id: UUID,
        book_id: UUID | None,
        page_id: UUID,
    ) -> tuple[UUID, str]:
        page_query = select(BookPage).where(BookPage.Id == page_id)
        if book_id is not None:
            page_query = page_query.where(BookPage.BookId == book_id)
        page = (await self._db.execute(page_query)).scalar_one_or_none()
        if page is None or getattr(page, "LifecycleStatus", "") == "RETIRED":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Book page not found",
            )

        book = (
            await self._db.execute(select(Book).where(Book.Id == page.BookId))
        ).scalar_one_or_none()
        if (
            book is None
            or bool(getattr(book, "IsDeleted", False))
            or getattr(book, "LifecycleStatus", "") == "RETIRED"
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Book not found",
            )
        if getattr(book, "VisibilityScope", "") == "PARENT_PRIVATE" and book.OwnerParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied to private book",
            )

        resolved_text = await self._load_verified_page_text(page)
        return book.Id, resolved_text

    async def _load_verified_page_text(self, page: BookPage) -> str:
        if page.CurrentVerifiedRevisionId is not None:
            rev = (
                await self._db.execute(
                    select(PageRevision).where(
                        PageRevision.Id == page.CurrentVerifiedRevisionId
                    )
                )
            ).scalar_one_or_none()
            if rev is not None:
                text_val = rev.VerifiedText or rev.DraftText or rev.OriginalOcrText or ""
                if text_val.strip():
                    return text_val.strip()

        revs = (
            await self._db.execute(
                select(PageRevision)
                .where(PageRevision.PageId == page.Id)
                .order_by(PageRevision.CreatedAt.desc())
            )
        ).scalars().all()
        for rev in revs:
            text_val = rev.VerifiedText or rev.DraftText or rev.OriginalOcrText or ""
            if text_val.strip():
                return text_val.strip()
        return ""

    # ------------------------------------------------------------------
    # Co-Reading Role-Play Script Endpoint Logic
    # ------------------------------------------------------------------

    async def parse_child_page_script(
        self,
        parent_id: UUID,
        child_id: UUID,
        payload: ParseScriptRequest,
    ) -> ParseScriptResponse:
        child = await self._require_owned_child(parent_id, child_id)

        resolved_book_id = payload.book_id
        resolved_text = payload.page_text or ""

        if payload.page_id is not None and not resolved_text:
            resolved_book_id, resolved_text = await self._resolve_page_text_for_reader(
                parent_id=parent_id,
                book_id=payload.book_id,
                page_id=payload.page_id,
            )
        elif payload.book_id is not None:
            # Verify private book visibility if book_id is explicitly supplied
            book = (
                await self._db.execute(select(Book).where(Book.Id == payload.book_id))
            ).scalar_one_or_none()
            if (
                book is not None
                and getattr(book, "VisibilityScope", "") == "PARENT_PRIVATE"
                and book.OwnerParentId != parent_id
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied to private book",
                )

        if not resolved_text.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Page has no readable text to parse",
            )

        # Prefer explicit teacher_voice_id, else child profile voice preference, else default
        preferred_voice = payload.teacher_voice_id
        if not preferred_voice and isinstance(child.Settings, dict):
            preferred_voice = (
                child.Settings.get("preferred_voice_id")
                or child.Settings.get("voice_id")
            )
        locked_teacher_voice = resolve_teacher_voice_id(preferred_voice)

        turns = parse_script(resolved_text, teacher_voice_id=locked_teacher_voice)
        char_voices = summarize_character_voices(turns)

        has_parent_narration = False
        if resolved_book_id is not None and payload.page_id is not None:
            existing_narr = (
                await self._db.execute(
                    select(ParentPageNarration).where(
                        ParentPageNarration.ParentId == parent_id,
                        ParentPageNarration.BookId == resolved_book_id,
                        ParentPageNarration.PageId == payload.page_id,
                    )
                )
            ).scalar_one_or_none()
            has_parent_narration = existing_narr is not None

        return ParseScriptResponse(
            child_id=child_id,
            book_id=resolved_book_id,
            page_id=payload.page_id,
            total_turns=len(turns),
            turns=turns,
            has_dialogue=any(t.is_character_dialogue for t in turns),
            narrator_voice_id=locked_teacher_voice,
            coaching_voice_id=locked_teacher_voice,
            character_voices=char_voices,
            has_parent_narration=has_parent_narration,
        )

    # ------------------------------------------------------------------
    # Parent Narration CRUD & Audio Streaming
    # ------------------------------------------------------------------

    async def upsert_narration(
        self,
        parent_id: UUID,
        book_id: UUID,
        page_id: UUID,
        audio_bytes: bytes,
        *,
        page_text: str | None = None,
        duration_ms: int | None = None,
    ) -> NarrationUploadResponse:
        fmt = validate_audio_payload(audio_bytes, max_bytes=MAX_NARRATION_BYTES)
        _book, page = await self._require_owned_private_book_page(parent_id, book_id, page_id)

        canonical_text = (page_text or "").strip()
        if not canonical_text:
            canonical_text = await self._load_verified_page_text(page)

        resolved_duration, word_timings, alignment_source = await generate_word_timings(
            audio_bytes,
            canonical_text,
            duration_ms,
            ctc_aligner=self._ctc_aligner,
        )

        existing_row = (
            await self._db.execute(
                select(ParentPageNarration).where(
                    ParentPageNarration.BookId == book_id,
                    ParentPageNarration.PageId == page_id,
                )
            )
        ).scalar_one_or_none()

        if existing_row is not None and existing_row.ParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied",
            )

        old_storage_path = existing_row.StoragePath if existing_row is not None else None
        new_storage_path = _build_narration_storage_path(parent_id, book_id, page_id, fmt)
        content_type = content_type_for_format(fmt)

        # Release any read transaction state before external I/O if safe, then store bytes
        await _store_private_audio_bytes(new_storage_path, audio_bytes, content_type)

        now = datetime.now(timezone.utc)
        timings_json = [item.model_dump() for item in word_timings]

        try:
            if existing_row is not None:
                existing_row.StoragePath = new_storage_path
                existing_row.AudioFormat = fmt
                existing_row.FileSizeBytes = len(audio_bytes)
                existing_row.DurationMs = resolved_duration
                existing_row.WordTimings = timings_json
                existing_row.Visibility = "PARENT_PRIVATE"
                existing_row.UpdatedAt = now
                row = existing_row
            else:
                row = ParentPageNarration(
                    Id=uuid4(),
                    ParentId=parent_id,
                    BookId=book_id,
                    PageId=page_id,
                    StoragePath=new_storage_path,
                    AudioFormat=fmt,
                    FileSizeBytes=len(audio_bytes),
                    DurationMs=resolved_duration,
                    WordTimings=timings_json,
                    Visibility="PARENT_PRIVATE",
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                self._db.add(row)

            await self._db.commit()
        except Exception:
            await self._db.rollback()
            if new_storage_path != old_storage_path:
                await _delete_private_audio_bytes(new_storage_path)
            raise

        if old_storage_path and old_storage_path != new_storage_path:
            await _delete_private_audio_bytes(old_storage_path)

        return NarrationUploadResponse(
            id=row.Id,
            parent_id=row.ParentId,
            book_id=row.BookId,
            page_id=row.PageId,
            audio_format=fmt,
            content_type=content_type,
            file_size_bytes=row.FileSizeBytes,
            duration_ms=row.DurationMs,
            alignment_source=alignment_source,
            word_timings=word_timings,
            audio_endpoint=_narration_audio_endpoint(book_id, page_id),
            visibility="PARENT_PRIVATE",
            created_at=row.CreatedAt,
            updated_at=row.UpdatedAt,
        )

    async def get_narration_meta(
        self,
        parent_id: UUID,
        book_id: UUID,
        page_id: UUID,
    ) -> NarrationMetaResponse:
        await self._require_owned_private_book_page(parent_id, book_id, page_id)
        row = (
            await self._db.execute(
                select(ParentPageNarration).where(
                    ParentPageNarration.ParentId == parent_id,
                    ParentPageNarration.BookId == book_id,
                    ParentPageNarration.PageId == page_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent narration not found for this page",
            )
        fmt: AudioFormat = row.AudioFormat  # type: ignore[assignment]
        return NarrationMetaResponse(
            id=row.Id,
            parent_id=row.ParentId,
            book_id=row.BookId,
            page_id=row.PageId,
            audio_format=fmt,
            content_type=content_type_for_format(fmt),
            file_size_bytes=row.FileSizeBytes,
            duration_ms=row.DurationMs,
            word_timings=[WordTiming(**t) for t in (row.WordTimings or [])],
            audio_endpoint=_narration_audio_endpoint(book_id, page_id),
            visibility="PARENT_PRIVATE",
            created_at=row.CreatedAt,
            updated_at=row.UpdatedAt,
        )

    async def get_narration_audio_bytes(
        self,
        parent_id: UUID,
        book_id: UUID,
        page_id: UUID,
    ) -> tuple[bytes, str]:
        await self._require_owned_private_book_page(parent_id, book_id, page_id)
        row = (
            await self._db.execute(
                select(ParentPageNarration).where(
                    ParentPageNarration.ParentId == parent_id,
                    ParentPageNarration.BookId == book_id,
                    ParentPageNarration.PageId == page_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent narration not found for this page",
            )
        storage_path = str(row.StoragePath)
        content_type = content_type_for_format(str(row.AudioFormat))
        await self._db.rollback()
        audio_bytes = await _load_private_audio_bytes(storage_path)
        return audio_bytes, content_type

    async def delete_narration(
        self,
        parent_id: UUID,
        book_id: UUID,
        page_id: UUID,
    ) -> NarrationDeleteResponse:
        await self._require_owned_private_book_page(parent_id, book_id, page_id)
        row = (
            await self._db.execute(
                select(ParentPageNarration).where(
                    ParentPageNarration.ParentId == parent_id,
                    ParentPageNarration.BookId == book_id,
                    ParentPageNarration.PageId == page_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent narration not found for this page",
            )
        narration_id = row.Id
        storage_path = str(row.StoragePath)
        await self._db.delete(row)
        await self._db.commit()
        await _delete_private_audio_bytes(storage_path)
        return NarrationDeleteResponse(deleted=True, narration_id=narration_id)

    async def cleanup_book_narration_storage(
        self,
        parent_id: UUID,
        book_id: UUID,
    ) -> int:
        """Delete all stored narration audio objects + rows for a book on book/account cleanup."""
        rows = (
            await self._db.execute(
                select(ParentPageNarration).where(
                    ParentPageNarration.ParentId == parent_id,
                    ParentPageNarration.BookId == book_id,
                )
            )
        ).scalars().all()
        paths = [str(r.StoragePath) for r in rows if r.StoragePath]
        for row in rows:
            await self._db.delete(row)
        if rows:
            await self._db.commit()
        for path in paths:
            await _delete_private_audio_bytes(path)
        return len(paths)

    # ------------------------------------------------------------------
    # Family Progress Postcards CRUD (PARENT_PRIVATE)
    # ------------------------------------------------------------------

    async def create_postcard(
        self,
        parent_id: UUID,
        child_id: UUID,
        payload: PostcardCreateRequest,
        *,
        audio_bytes: bytes | None = None,
    ) -> PostcardRead:
        await self._require_owned_child(parent_id, child_id)

        if payload.source_book_id is not None:
            book = (
                await self._db.execute(
                    select(Book).where(Book.Id == payload.source_book_id)
                )
            ).scalar_one_or_none()
            if book is None or bool(getattr(book, "IsDeleted", False)):
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Source book not found",
                )
            if getattr(book, "VisibilityScope", "") == "PARENT_PRIVATE" and book.OwnerParentId != parent_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied to private source book",
                )

        postcard_id = uuid4()
        audio_fmt: AudioFormat | None = None
        audio_path: str | None = None
        audio_size: int | None = None

        if audio_bytes is not None:
            audio_fmt = validate_audio_payload(audio_bytes, max_bytes=MAX_POSTCARD_CLIP_BYTES)
            audio_path = _build_postcard_clip_path(parent_id, child_id, postcard_id, audio_fmt)
            audio_size = len(audio_bytes)
            await _store_private_audio_bytes(
                audio_path,
                audio_bytes,
                content_type_for_format(audio_fmt),
            )

        now = datetime.now(timezone.utc)
        row = FamilyReadingPostcard(
            Id=postcard_id,
            ParentId=parent_id,
            ChildId=child_id,
            Title=payload.title,
            PassageText=payload.passage_text,
            SourceBookId=payload.source_book_id,
            SourcePageId=payload.source_page_id,
            AudioClipPath=audio_path,
            AudioFormat=audio_fmt,
            AudioSizeBytes=audio_size,
            EmojiBadge=payload.emoji_badge or "🌟",
            Visibility="PARENT_PRIVATE",
            CreatedAt=now,
            UpdatedAt=now,
        )
        try:
            self._db.add(row)
            await self._db.commit()
        except Exception:
            await self._db.rollback()
            if audio_path:
                await _delete_private_audio_bytes(audio_path)
            raise

        return self._postcard_to_read(row)

    async def list_postcards(
        self,
        parent_id: UUID,
        child_id: UUID,
        *,
        limit: int = 50,
    ) -> PostcardListResponse:
        await self._require_owned_child(parent_id, child_id)

        all_rows = (
            await self._db.execute(
                select(FamilyReadingPostcard)
                .where(
                    FamilyReadingPostcard.ParentId == parent_id,
                    FamilyReadingPostcard.ChildId == child_id,
                )
                .order_by(FamilyReadingPostcard.CreatedAt.desc())
            )
        ).scalars().all()

        safe_limit = max(1, min(200, int(limit)))
        sliced = all_rows[:safe_limit]
        return PostcardListResponse(
            child_id=child_id,
            total=len(all_rows),
            items=[self._postcard_to_read(row) for row in sliced],
        )

    async def get_postcard_audio_bytes(
        self,
        parent_id: UUID,
        child_id: UUID,
        postcard_id: UUID,
    ) -> tuple[bytes, str]:
        await self._require_owned_child(parent_id, child_id)
        row = (
            await self._db.execute(
                select(FamilyReadingPostcard).where(
                    FamilyReadingPostcard.Id == postcard_id,
                    FamilyReadingPostcard.ParentId == parent_id,
                    FamilyReadingPostcard.ChildId == child_id,
                )
            )
        ).scalar_one_or_none()
        if row is None or not row.AudioClipPath or not row.AudioFormat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Postcard audio clip not found",
            )
        clip_path = str(row.AudioClipPath)
        content_type = content_type_for_format(str(row.AudioFormat))
        await self._db.rollback()
        data = await _load_private_audio_bytes(clip_path)
        return data, content_type

    async def delete_postcard(
        self,
        parent_id: UUID,
        child_id: UUID,
        postcard_id: UUID,
    ) -> PostcardDeleteResponse:
        await self._require_owned_child(parent_id, child_id)
        row = (
            await self._db.execute(
                select(FamilyReadingPostcard).where(
                    FamilyReadingPostcard.Id == postcard_id,
                    FamilyReadingPostcard.ParentId == parent_id,
                    FamilyReadingPostcard.ChildId == child_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Postcard not found",
            )
        clip_path = str(row.AudioClipPath) if row.AudioClipPath else None
        await self._db.delete(row)
        await self._db.commit()
        if clip_path:
            await _delete_private_audio_bytes(clip_path)
        return PostcardDeleteResponse(deleted=True, postcard_id=postcard_id)

    @staticmethod
    def _postcard_to_read(row: FamilyReadingPostcard) -> PostcardRead:
        has_clip = bool(row.AudioClipPath and row.AudioFormat)
        return PostcardRead(
            id=row.Id,
            parent_id=row.ParentId,
            child_id=row.ChildId,
            title=row.Title,
            passage_text=row.PassageText,
            source_book_id=row.SourceBookId,
            source_page_id=row.SourcePageId,
            has_audio_clip=has_clip,
            audio_format=row.AudioFormat,  # type: ignore[arg-type]
            audio_size_bytes=row.AudioSizeBytes,
            audio_endpoint=(
                _postcard_audio_endpoint(row.ChildId, row.Id) if has_clip else None
            ),
            emoji_badge=row.EmojiBadge or "🌟",
            visibility="PARENT_PRIVATE",
            created_at=row.CreatedAt,
            updated_at=row.UpdatedAt,
        )
