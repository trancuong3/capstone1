"""One-file Admin Karaoke Simple Mode import, background pipeline bridge & safe publish."""
import logging
import math
import os
import re
from typing import Awaitable, Callable
from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from app.core.karaoke_processing_config import (
    KaraokeConfigurationError,
    KaraokeProcessingConfig,
)
from app.models.entertainment_v4 import KaraokeMusicalProfile
from app.models.karaoke import utcnow
from app.repositories.karaoke_processing_repository import KaraokeProcessingRepository
from app.repositories.karaoke_repository import KaraokeRepository
from app.schemas.karaoke import (
    AdminDetail,
    DraftRequest,
    DraftWrite,
    Lyrics,
    MAX_AUDIO_BYTES,
    canonical_lyric_text,
    clean_text,
)
from app.schemas.karaoke_processing import ProcessingStart
from app.schemas.karaoke_simple_import import (
    AudioType,
    FlaggedLyricLine,
    LyricsSource,
    SimpleImportResult,
    SimplePipelineLifecycleState,
    SimpleProcessingApplyRequest,
    SimpleProcessingStartRequest,
    SimpleProcessingStatusRead,
    SimplePublishRequest,
)
from app.services.karaoke_media_service import (
    _strip_control_chars,
    distribute_syllables_for_line,
    extract_mp3_metadata,
    has_lrc_timestamps,
    parse_lrc_text,
    read_upload,
)
from app.services.karaoke_practice_service import derive_musical_profile_from_lyrics
from app.services.karaoke_processing_review import quality_flags
from app.services.karaoke_processing_service import KaraokeProcessingService
from app.services.karaoke_service import KaraokeService, content_issues
from app.services.karaoke_storage_service import KaraokeStorage
from app.services.worker_telemetry import get_worker_telemetry

logger = logging.getLogger(__name__)

GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
DEFAULT_GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
LOW_CONFIDENCE_LOGPROB_THRESHOLD = -0.5
HIGH_NO_SPEECH_PROB_THRESHOLD = 0.5
_TOKEN_NORM_RE = re.compile(r"[^\w]", re.UNICODE)

TranscriberFn = Callable[
    [bytes, str, int],
    Awaitable[tuple[dict, list[FlaggedLyricLine]] | None],
]


def _normalize_match_token(token: str) -> str:
    return _TOKEN_NORM_RE.sub("", canonical_lyric_text(token).lower())


def _safe_clean_optional(value: str | None, max_length: int) -> str:
    if value is None:
        return ""
    cleaned = _strip_control_chars(value)
    return cleaned[:max_length]


def _upgrade_synced_lyrics_to_syllables(lyrics_dict: dict, duration_ms: int) -> dict:
    """Attach proportional syllable timings to synced lines when every line fits cleanly."""
    lines = lyrics_dict.get("lines") or []
    if not lines:
        return {"format_version": 1, "lines": []}
    v2_lines: list[dict] = []
    total_syllables = 0
    for line in lines:
        start_ms = line.get("start_ms")
        end_ms = line.get("end_ms")
        if start_ms is None or end_ms is None or start_ms >= end_ms or end_ms > duration_ms:
            return Lyrics.model_validate(lyrics_dict).model_dump(mode="json")
        syllables = distribute_syllables_for_line(line["text"], start_ms, end_ms)
        if syllables is None or total_syllables + len(syllables) > 10_000:
            return Lyrics.model_validate(lyrics_dict).model_dump(mode="json")
        total_syllables += len(syllables)
        v2_lines.append(
            {
                "id": line["id"],
                "text": line["text"],
                "start_ms": start_ms,
                "end_ms": end_ms,
                "syllables": syllables,
            }
        )
    return Lyrics.model_validate({"format_version": 2, "lines": v2_lines}).model_dump(mode="json")


def distribute_plain_lyrics(
    text: str, duration_ms: int
) -> tuple[dict, list[FlaggedLyricLine]]:
    """Distribute plain lyrics evenly across duration_ms and flag every line for timing check."""
    normalized = _strip_control_chars(text, preserve_newlines=True)
    raw_lines: list[str] = []
    total_chars = 0
    for raw in normalized.split("\n"):
        cleaned = _strip_control_chars(raw)[:300]
        if not cleaned:
            continue
        if len(raw_lines) >= 300 or total_chars + len(cleaned) > 50_000:
            break
        raw_lines.append(cleaned)
        total_chars += len(cleaned)

    if not raw_lines:
        return {"format_version": 1, "lines": []}, []

    line_count = len(raw_lines)
    if duration_ms < line_count:
        v1_untimed = Lyrics.model_validate(
            {
                "format_version": 1,
                "lines": [
                    {"id": str(uuid4()), "text": line_text, "start_ms": None, "end_ms": None}
                    for line_text in raw_lines
                ],
            }
        ).model_dump(mode="json")
        flagged = [
            FlaggedLyricLine(
                line_id=UUID(line["id"]),
                line_index=idx,
                text=line["text"],
                flag="NEEDS_TIMING_CHECK",
                reason="Thời lượng nhạc quá ngắn để tự chia mốc — vui lòng căn thời gian thủ công.",
            )
            for idx, line in enumerate(v1_untimed["lines"])
        ]
        return v1_untimed, flagged

    token_counts = [max(1, len(canonical_lyric_text(line).split(" "))) for line in raw_lines]
    total_tokens = sum(token_counts)
    can_use_v2 = duration_ms >= total_tokens and total_tokens <= 10_000 and all(
        c <= 150 for c in token_counts
    )
    min_spans = token_counts if can_use_v2 else [1] * line_count
    extra = duration_ms - sum(min_spans)
    weights = [max(1, len(line)) for line in raw_lines]
    total_weight = sum(weights)
    spans = [
        base + (extra * weight) // total_weight
        for base, weight in zip(min_spans, weights)
    ]
    remainder = duration_ms - sum(spans)
    for idx in range(remainder):
        spans[idx % line_count] += 1

    cursor = 0
    lines_payload: list[dict] = []
    flagged: list[FlaggedLyricLine] = []
    for idx, (line_text, span) in enumerate(zip(raw_lines, spans)):
        start_ms = cursor
        end_ms = cursor + span
        cursor = end_ms
        line_id = str(uuid4())
        entry: dict = {
            "id": line_id,
            "text": line_text,
            "start_ms": start_ms,
            "end_ms": end_ms,
        }
        if can_use_v2:
            syllables = distribute_syllables_for_line(line_text, start_ms, end_ms)
            if syllables is None:
                can_use_v2 = False
            else:
                entry["syllables"] = syllables
        lines_payload.append(entry)
        flagged.append(
            FlaggedLyricLine(
                line_id=UUID(line_id),
                line_index=idx,
                text=line_text,
                flag="NEEDS_TIMING_CHECK",
                reason="Mốc thời gian được ước lượng đều theo thời lượng nhạc — nên nghe thử hoặc căn nhanh 1 lượt bằng phím Space.",
            )
        )

    if not can_use_v2:
        for entry in lines_payload:
            entry.pop("syllables", None)
        validated = Lyrics.model_validate(
            {"format_version": 1, "lines": lines_payload}
        ).model_dump(mode="json")
    else:
        validated = Lyrics.model_validate(
            {"format_version": 2, "lines": lines_payload}
        ).model_dump(mode="json")
    return validated, flagged


def _align_whisper_words_to_syllables(
    line_text: str,
    line_start_ms: int,
    line_end_ms: int,
    segment_words: list[dict],
) -> list[dict] | None:
    """Align Whisper word timestamps to line tokens while enforcing strict ViRead timing invariants."""
    normalized = canonical_lyric_text(line_text)
    if not normalized:
        return None
    tokens = normalized.split(" ")
    count = len(tokens)
    span = line_end_ms - line_start_ms
    if count == 0 or count > 150 or span < count:
        return None
    if not segment_words:
        return distribute_syllables_for_line(line_text, line_start_ms, line_end_ms)

    # Greedily match tokens to Whisper words in chronological order.
    matched: list[tuple[int, int] | None] = [None] * count
    word_idx = 0
    for tok_idx, token in enumerate(tokens):
        norm_tok = _normalize_match_token(token)
        if not norm_tok:
            continue
        search_limit = min(len(segment_words), word_idx + 4)
        for candidate_idx in range(word_idx, search_limit):
            word_obj = segment_words[candidate_idx]
            norm_word = _normalize_match_token(str(word_obj.get("word", "")))
            if norm_word and (norm_word == norm_tok or norm_tok in norm_word or norm_word in norm_tok):
                w_start = round(float(word_obj.get("start", 0.0)) * 1000)
                w_end = round(float(word_obj.get("end", 0.0)) * 1000)
                w_start = max(line_start_ms, min(line_end_ms - 1, w_start))
                w_end = max(w_start + 1, min(line_end_ms, w_end))
                matched[tok_idx] = (w_start, w_end)
                word_idx = candidate_idx + 1
                break

    if not any(matched):
        return distribute_syllables_for_line(line_text, line_start_ms, line_end_ms)

    # Build monotonic start/end timestamps filling any unmatched tokens cleanly.
    starts: list[int] = [0] * count
    ends: list[int] = [0] * count
    for i in range(count):
        if matched[i] is not None:
            starts[i], ends[i] = matched[i]  # type: ignore[misc]
        else:
            prev_bound = ends[i - 1] if i > 0 else line_start_ms
            next_idx = next((j for j in range(i + 1, count) if matched[j] is not None), None)
            next_bound = matched[next_idx][0] if next_idx is not None else line_end_ms  # type: ignore[index]
            gap_tokens = (next_idx - i) if next_idx is not None else (count - i)
            available = max(gap_tokens, next_bound - prev_bound)
            step = max(1, available // gap_tokens)
            starts[i] = prev_bound
            ends[i] = min(line_end_ms, prev_bound + step)

    # Strictly enforce non-overlapping monotonic bounds inside [line_start_ms, line_end_ms].
    starts[0] = max(line_start_ms, min(starts[0], line_end_ms - count))
    for i in range(count):
        if i > 0:
            starts[i] = max(starts[i], ends[i - 1])
        max_start = line_end_ms - (count - i)
        if starts[i] > max_start:
            # Fall back to exact proportional distribution if timestamps collided near line end.
            return distribute_syllables_for_line(line_text, line_start_ms, line_end_ms)
        min_end = starts[i] + 1
        max_end = line_end_ms - (count - 1 - i)
        ends[i] = max(min_end, min(ends[i], max_end))

    return [
        {
            "id": str(uuid4()),
            "text": token,
            "start_ms": starts[i],
            "end_ms": ends[i],
        }
        for i, token in enumerate(tokens)
    ]


def map_whisper_verbose_json(
    payload: dict, duration_ms: int
) -> tuple[dict, list[FlaggedLyricLine]]:
    """Map Groq Whisper verbose_json response into valid ViRead lyrics + low-confidence flags."""
    if not isinstance(payload, dict) or duration_ms < 1:
        return {"format_version": 1, "lines": []}, []

    raw_segments = payload.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        return {"format_version": 1, "lines": []}, []

    all_words = payload.get("words") if isinstance(payload.get("words"), list) else []

    cleaned_segments: list[dict] = []
    total_chars = 0
    for seg in raw_segments:
        if not isinstance(seg, dict):
            continue
        text = _strip_control_chars(str(seg.get("text", "")))[:300]
        if not text:
            continue
        if len(cleaned_segments) >= 300 or total_chars + len(text) > 50_000:
            break
        try:
            raw_start_s = float(seg.get("start", 0.0))
            raw_end_s = float(seg.get("end", raw_start_s))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(raw_start_s) or not math.isfinite(raw_end_s):
            continue
        avg_logprob = seg.get("avg_logprob")
        no_speech_prob = seg.get("no_speech_prob")
        try:
            avg_logprob_f = float(avg_logprob) if avg_logprob is not None else None
        except (TypeError, ValueError):
            avg_logprob_f = None
        try:
            no_speech_f = float(no_speech_prob) if no_speech_prob is not None else None
        except (TypeError, ValueError):
            no_speech_f = None
        cleaned_segments.append(
            {
                "text": text,
                "raw_start_ms": max(0, min(duration_ms - 1, round(raw_start_s * 1000))),
                "raw_end_ms": max(1, min(duration_ms, round(raw_end_s * 1000))),
                "avg_logprob": avg_logprob_f,
                "no_speech_prob": no_speech_f,
                "words": seg.get("words") if isinstance(seg.get("words"), list) else None,
            }
        )
        total_chars += len(text)

    if not cleaned_segments:
        return {"format_version": 1, "lines": []}, []

    cleaned_segments.sort(key=lambda s: s["raw_start_ms"])
    line_count = len(cleaned_segments)
    if duration_ms < line_count:
        return {"format_version": 1, "lines": []}, []

    # Enforce strictly monotonic non-overlapping [start_ms, end_ms] within [0, duration_ms].
    starts: list[int] = []
    ends: list[int] = []
    prev_end = 0
    for idx, seg in enumerate(cleaned_segments):
        remaining = line_count - idx
        max_start = duration_ms - remaining
        start_ms = max(prev_end, min(seg["raw_start_ms"], max_start))
        next_raw_start = (
            cleaned_segments[idx + 1]["raw_start_ms"]
            if idx + 1 < line_count
            else duration_ms
        )
        max_end = duration_ms - (remaining - 1)
        desired_end = max(start_ms + 1, min(seg["raw_end_ms"], max_end))
        if idx + 1 < line_count and next_raw_start > start_ms:
            desired_end = min(desired_end, max(start_ms + 1, next_raw_start))
        end_ms = max(start_ms + 1, min(desired_end, max_end))
        starts.append(start_ms)
        ends.append(end_ms)
        prev_end = end_ms

    v2_possible = True
    total_syllables = 0
    built_lines: list[dict] = []
    flagged_lines: list[FlaggedLyricLine] = []

    for idx, seg in enumerate(cleaned_segments):
        start_ms = starts[idx]
        end_ms = ends[idx]
        line_id = str(uuid4())

        seg_words = seg["words"]
        if seg_words is None and all_words:
            seg_start_s = seg["raw_start_ms"] / 1000.0 - 0.15
            seg_end_s = seg["raw_end_ms"] / 1000.0 + 0.15
            seg_words = [
                w
                for w in all_words
                if isinstance(w, dict)
                and isinstance(w.get("start"), (int, float))
                and seg_start_s <= float(w["start"]) <= seg_end_s
            ]

        entry: dict = {
            "id": line_id,
            "text": seg["text"],
            "start_ms": start_ms,
            "end_ms": end_ms,
        }
        if v2_possible:
            syllables = _align_whisper_words_to_syllables(
                seg["text"], start_ms, end_ms, seg_words or []
            )
            if syllables is None or total_syllables + len(syllables) > 10_000:
                v2_possible = False
            else:
                total_syllables += len(syllables)
                entry["syllables"] = syllables

        built_lines.append(entry)

        avg_lp = seg["avg_logprob"]
        no_speech = seg["no_speech_prob"]
        low_logprob = avg_lp is not None and avg_lp < LOW_CONFIDENCE_LOGPROB_THRESHOLD
        high_no_speech = (
            no_speech is not None and no_speech > HIGH_NO_SPEECH_PROB_THRESHOLD
        )
        if low_logprob or high_no_speech:
            reasons: list[str] = []
            if low_logprob:
                reasons.append(f"độ tin cậy nhận diện thấp (avg_logprob={avg_lp:.2f})")
            if high_no_speech:
                reasons.append(f"nghi ngờ không có giọng hát (no_speech_prob={no_speech:.2f})")
            flagged_lines.append(
                FlaggedLyricLine(
                    line_id=UUID(line_id),
                    line_index=idx,
                    text=seg["text"],
                    flag="NEEDS_REVIEW",
                    reason="Cần nghe và kiểm tra lại chính tả/nhịp: " + ", ".join(reasons) + ".",
                    avg_logprob=avg_lp,
                    no_speech_prob=no_speech,
                )
            )

    if not v2_possible:
        for entry in built_lines:
            entry.pop("syllables", None)
        validated = Lyrics.model_validate(
            {"format_version": 1, "lines": built_lines}
        ).model_dump(mode="json")
    else:
        validated = Lyrics.model_validate(
            {"format_version": 2, "lines": built_lines}
        ).model_dump(mode="json")
    return validated, flagged_lines


def _groq_transcribe_enabled() -> bool:
    flag = (os.getenv("KARAOKE_ADMIN_GROQ_LYRICS_ENABLED") or "true").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    return bool((os.getenv("GROQ_API_KEY") or "").strip())


async def transcribe_with_groq_whisper(
    audio_bytes: bytes,
    filename: str,
    duration_ms: int,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> tuple[dict, list[FlaggedLyricLine]] | None:
    """Optional zero-cost Groq Free whisper-large-v3-turbo transcription (never fabricates lyrics)."""
    api_key = (os.getenv("GROQ_API_KEY") or "").strip()
    if not api_key or not _groq_transcribe_enabled():
        return None
    model = (os.getenv("KARAOKE_GROQ_WHISPER_MODEL") or DEFAULT_GROQ_WHISPER_MODEL).strip()
    safe_name = os.path.basename((filename or "audio.mp3").replace("\\", "/")) or "audio.mp3"
    if not safe_name.lower().endswith(".mp3"):
        safe_name = f"{safe_name}.mp3"

    headers = {"Authorization": f"Bearer {api_key}"}
    files = {"file": (safe_name, audio_bytes, "audio/mpeg")}
    data = [
        ("model", model),
        ("language", "vi"),
        ("response_format", "verbose_json"),
        ("timestamp_granularities[]", "segment"),
        ("timestamp_granularities[]", "word"),
    ]

    try:
        if http_client is not None:
            response = await http_client.post(
                GROQ_TRANSCRIPTION_URL, headers=headers, files=files, data=data
            )
        else:
            async with httpx.AsyncClient(timeout=45.0, trust_env=False) as client:
                response = await client.post(
                    GROQ_TRANSCRIPTION_URL, headers=headers, files=files, data=data
                )
        if response.status_code != 200:
            logger.warning(
                "karaoke_simple_import_groq_whisper_http_error",
                extra={"status_code": response.status_code},
            )
            return None
        payload = response.json()
    except Exception:
        logger.warning("karaoke_simple_import_groq_whisper_request_failed")
        return None

    lyrics_dict, flagged = map_whisper_verbose_json(payload, duration_ms)
    if not lyrics_dict.get("lines"):
        return None
    return lyrics_dict, flagged


def _load_processing_config(
    explicit: KaraokeProcessingConfig | None = None,
) -> KaraokeProcessingConfig:
    if explicit is not None:
        return explicit
    try:
        return KaraokeProcessingConfig.from_env()
    except KaraokeConfigurationError:
        return KaraokeProcessingConfig()


def _ensure_v2_lyrics_for_processing(
    lyrics_dict: dict | None, duration_ms: int | None
) -> dict | None:
    """Convert valid timed/untimed lyrics to format_version=2 when possible for KaraokeProcessingJob."""
    if not isinstance(lyrics_dict, dict):
        return None
    try:
        validated = Lyrics.model_validate(lyrics_dict)
    except Exception:
        return None
    if not validated.lines:
        return None
    if validated.format_version == 2 and all(
        line.syllables
        and canonical_lyric_text(" ".join(u.text for u in line.syllables))
        == canonical_lyric_text(line.text)
        for line in validated.lines
    ):
        return validated.model_dump(mode="json")
    if duration_ms is None or duration_ms < len(validated.lines):
        return None
    raw_dump = validated.model_dump(mode="json")
    all_lines_timed = all(
        line.start_ms is not None
        and line.end_ms is not None
        and line.start_ms < line.end_ms
        and line.end_ms <= duration_ms
        for line in validated.lines
    )
    if all_lines_timed:
        upgraded = _upgrade_synced_lyrics_to_syllables(raw_dump, duration_ms)
    else:
        joined = "\n".join(line.text for line in validated.lines)
        upgraded, _ = distribute_plain_lyrics(joined, duration_ms)
    try:
        revalidated = Lyrics.model_validate(upgraded)
    except Exception:
        return None
    if revalidated.format_version != 2 or not revalidated.lines:
        return None
    if any(
        not line.syllables
        or canonical_lyric_text(" ".join(u.text for u in line.syllables))
        != canonical_lyric_text(line.text)
        for line in revalidated.lines
    ):
        return None
    return revalidated.model_dump(mode="json")


def resolve_simple_lifecycle_state(
    *,
    has_audio: bool,
    lyrics_line_count: int,
    requires_lyrics_input: bool = False,
    flagged_count: int = 0,
    transcribing_active: bool = False,
    job: object | None = None,
    operations: list[object] | tuple[object, ...] = (),
    review_required: bool = False,
    reviewed: bool = False,
) -> SimplePipelineLifecycleState:
    """Map real job, operation-ledger, and draft state into honest Simple Mode lifecycle states."""
    if job is not None:
        status = getattr(job, "status", None)
        stage = getattr(job, "stage", None)
        provenance = getattr(job, "provenance", None)
        provenance = provenance if isinstance(provenance, dict) else {}
        op_states = {
            str(getattr(op, "step_key", "")): str(getattr(op, "state", ""))
            for op in operations
        }
        active_states = {"PREPARED", "SUBMITTED"}

        if status in {"FAILED", "CANCELLED", "STALE"}:
            return "FAILED"
        if status == "QUEUED":
            return "QUEUED"
        if status == "RUNNING":
            if op_states.get("TRANSCRIBE_LYRICS") in active_states:
                return "TRANSCRIBING_LYRICS"
            if op_states.get("ANALYZE_MELODY") in active_states:
                return "ANALYZING_MELODY"
            if op_states.get("ANALYZE_RHYTHM") in active_states:
                return "ANALYZING_RHYTHM"
            if stage == "ALIGNING_LYRICS" or op_states.get("ALIGN_PROVIDED_LYRICS") in active_states:
                return "ALIGNING_LYRICS"
            if stage == "VALIDATING_RESULT":
                phase = str(provenance.get("analysis_phase") or "").upper()
                if phase == "MELODY" or (
                    op_states.get("ANALYZE_RHYTHM") == "COMPLETED"
                    and op_states.get("ANALYZE_MELODY") != "COMPLETED"
                ):
                    return "ANALYZING_MELODY"
                return "ANALYZING_RHYTHM"
            if stage in {"VALIDATING_INPUT", "PREPARING_AUDIO"} or (
                op_states.get("SEPARATE_STEMS") in active_states
                or op_states.get("VERIFY_REFERENCE_TIMELINE") in active_states
            ):
                return "SEPARATING_AUDIO"
            if stage == "QUEUED":
                return "QUEUED"
            return "SEPARATING_AUDIO"
        if status == "NEEDS_REVIEW":
            return "NEEDS_REVIEW"
        if status == "READY":
            try:
                flags = quality_flags(job)
            except ValueError:
                flags = []
            return "NEEDS_REVIEW" if flags else "READY_FOR_REVIEW"
        if status == "APPLIED":
            if (review_required and not reviewed) or flagged_count > 0:
                return "NEEDS_REVIEW"
            return "READY_FOR_REVIEW"

    if transcribing_active:
        return "TRANSCRIBING_LYRICS"
    if not has_audio or requires_lyrics_input or lyrics_line_count <= 0:
        return "UPLOADED"
    if flagged_count > 0 or (review_required and not reviewed):
        return "NEEDS_REVIEW"
    return "READY_FOR_REVIEW"


def _guidance_for_lifecycle_state(
    state: SimplePipelineLifecycleState,
    *,
    worker_online: bool,
    safe_error_code: str | None = None,
    can_apply: bool = False,
) -> str:
    if state == "UPLOADED":
        if worker_online:
            return (
                "Đã tải file MP3 lên. Hãy dán lời bài hát hoặc tải file .lrc để bắt đầu "
                "tách nhạc nền, căn nhịp và xuất bản."
            )
        return (
            "Đã tải file MP3 ở chế độ 0 VND (worker nền đang tắt). "
            "Hãy dán lời bài hát hoặc tải file .lrc để tạo bản nháp ngay."
        )
    if state == "QUEUED":
        return "Bài hát đã vào hàng đợi xử lý nền (tách giọng, căn lời từng âm tiết và phân tích nhịp/giai điệu)."
    if state == "SEPARATING_AUDIO":
        return "Worker đang tách nhạc nền và giọng hát mẫu để phục vụ karaoke."
    if state == "TRANSCRIBING_LYRICS":
        return "Đang nhận diện lời bài hát tiếng Việt từ âm thanh."
    if state == "ALIGNING_LYRICS":
        return "Worker đang căn khớp mốc thời gian từng âm tiết theo giọng hát."
    if state == "ANALYZING_RHYTHM":
        return "Đang phân tích nhịp điệu (beat grid & BPM) cho bài hát."
    if state == "ANALYZING_MELODY":
        return "Đang phân tích đường giai điệu tham chiếu cho bài hát."
    if state == "NEEDS_REVIEW":
        if can_apply:
            return (
                "Xử lý nền hoàn tất nhưng có điểm cần kiểm tra. "
                "Hãy áp dụng kết quả vào bản nháp và nghe thử trước khi xuất bản."
            )
        return "Bản nháp có một số dòng hoặc mốc thời gian cần nghe kiểm tra nhanh trước khi xuất bản."
    if state == "READY_FOR_REVIEW":
        if can_apply:
            return "Xử lý nền hoàn tất. Hãy áp dụng kết quả vào bản nháp, kiểm tra an toàn và xuất bản."
        return "Bản nháp đã sẵn sàng để nghe kiểm tra nhanh, tích xác nhận an toàn và xuất bản."
    suffix = f" ({safe_error_code})" if safe_error_code else ""
    return (
        f"Tác vụ xử lý nền chưa hoàn tất{suffix}. Bạn có thể thử lại hoặc chuyển sang chỉnh sửa/gõ nhịp thủ công."
    )


class KaraokeSimpleImportService:
    """Coordinates one-file MP3 ingestion, background pipeline handoff, and safe publish."""

    def __init__(
        self,
        repository: KaraokeRepository,
        storage=None,
        *,
        transcriber: TranscriberFn | None = None,
        processing_service: KaraokeProcessingService | None = None,
        processing_config: KaraokeProcessingConfig | None = None,
        worker_online_probe: Callable[[], bool] | None = None,
    ):
        self.repository = repository
        self.storage = storage or KaraokeStorage()
        self.karaoke = KaraokeService(repository, self.storage)
        self.transcriber = transcriber or transcribe_with_groq_whisper
        self._explicit_processing_service = processing_service
        self.processing_config = _load_processing_config(processing_config)
        self._worker_online_probe = worker_online_probe
        self.processing_replayed = False

    def is_worker_online(self) -> bool:
        """Report honestly whether the offline/background karaoke worker pipeline is available."""
        if self._worker_online_probe is not None:
            return bool(self._worker_online_probe())
        cfg = self.processing_config
        if not (cfg.enabled and cfg.configured):
            return False
        explicit = os.getenv("KARAOKE_PROCESSING_WORKER_ONLINE")
        if explicit is not None and explicit.strip() != "":
            return explicit.strip().lower() in {"1", "true", "yes", "on"}
        telemetry = get_worker_telemetry("karaoke_processing")
        if telemetry.get("last_error") is not None and telemetry.get("last_success_at") is None:
            return False
        return True

    def _processing_service(self) -> KaraokeProcessingService | None:
        if self._explicit_processing_service is not None:
            return self._explicit_processing_service
        if hasattr(self.repository, "db"):
            return KaraokeProcessingService(
                KaraokeProcessingRepository(self.repository.db),
                self.storage,
                config=self.processing_config,
            )
        return None

    async def _load_musical_profile_best_effort(self, version_id: UUID | None) -> dict | None:
        if version_id is None:
            return None
        db = getattr(self.repository, "db", None)
        if db is None:
            return None
        try:
            async with self.repository.read():
                row = await db.scalar(
                    select(KaraokeMusicalProfile).where(
                        KaraokeMusicalProfile.SongVersionId == version_id
                    )
                )
            if row is None:
                return None
            return {
                "bpm": float(row.Bpm) if row.Bpm is not None else None,
                "audio_type": row.AudioType,
                "has_pitch_contour": bool(row.HasPitchContour),
                "has_beat_grid": bool(row.HasBeatGrid),
                "source_method": row.SourceMethod,
                "profile_json": dict(row.ProfileJson)
                if isinstance(row.ProfileJson, dict)
                else {},
            }
        except Exception:
            return None

    async def _save_musical_profile_best_effort(
        self,
        *,
        version_id: UUID,
        audio_type: AudioType,
        bpm: float | None,
        lyrics_source: LyricsSource,
        duration_ms: int,
        has_cover: bool,
        flagged_count: int,
        requires_lyrics_input: bool,
        lyrics_dict: dict | None = None,
        source_method_override: str | None = None,
        pitch_contour: list[dict] | None = None,
        processing_job_id: UUID | None = None,
    ) -> None:
        db = getattr(self.repository, "db", None)
        if db is None:
            return
        beat_grid_ms, derived_bpm, phrase_windows = derive_musical_profile_from_lyrics(
            lyrics_dict if isinstance(lyrics_dict, dict) else None
        )
        effective_bpm = bpm if bpm is not None else derived_bpm
        safe_bpm = (
            round(float(effective_bpm), 2)
            if effective_bpm is not None and 30.0 <= float(effective_bpm) <= 240.0
            else None
        )
        source_method_map: dict[LyricsSource, str] = {
            "EMBEDDED_SYNCED": "ID3_LRC",
            "GROQ_WHISPER": "WHISPER_DRAFT",
            "EMBEDDED_UNSYNCED": "LYRICS_TIMING",
            "ADMIN_TEXT": "LYRICS_TIMING",
            "NONE": "AUDIO_DSP" if safe_bpm is not None else "LYRICS_TIMING",
        }
        allowed_methods = {
            "ID3_LRC",
            "AUDIO_DSP",
            "WHISPER_DRAFT",
            "MANUAL_TAP",
            "LYRICS_TIMING",
        }
        source_method = (
            source_method_override
            if source_method_override in allowed_methods
            else source_method_map[lyrics_source]
        )
        has_beat_grid = bool(beat_grid_ms) or safe_bpm is not None
        cleaned_contour = [pt for pt in (pitch_contour or [])[:2000] if isinstance(pt, dict)]
        has_pitch_contour = bool(cleaned_contour)
        profile_json = {
            "lyrics_source": lyrics_source,
            "duration_ms": duration_ms,
            "has_cover": has_cover,
            "flagged_line_count": flagged_count,
            "requires_lyrics_input": requires_lyrics_input,
            "beat_interval_ms": round(60_000.0 / safe_bpm) if safe_bpm else None,
            "beat_grid_ms": beat_grid_ms[:2000],
            "phrase_windows": phrase_windows[:300],
        }
        if cleaned_contour:
            profile_json["pitch_contour"] = cleaned_contour
        if processing_job_id is not None:
            profile_json["processing_job_id"] = str(processing_job_id)

        try:
            stmt = (
                pg_insert(KaraokeMusicalProfile)
                .values(
                    SongVersionId=version_id,
                    Bpm=safe_bpm,
                    AudioType=audio_type,
                    HasPitchContour=has_pitch_contour,
                    HasBeatGrid=has_beat_grid,
                    SourceMethod=source_method,
                    ProfileJson=profile_json,
                    UpdatedAt=utcnow(),
                )
                .on_conflict_do_update(
                    index_elements=[KaraokeMusicalProfile.SongVersionId],
                    set_={
                        "bpm": safe_bpm,
                        "audio_type": audio_type,
                        "has_pitch_contour": has_pitch_contour,
                        "has_beat_grid": has_beat_grid,
                        "source_method": source_method,
                        "profile_json": profile_json,
                        "updated_at": utcnow(),
                    },
                )
            )
            await db.execute(stmt)
            await db.commit()
        except (SQLAlchemyError, Exception):
            try:
                await db.rollback()
            except Exception:
                pass
            logger.warning("karaoke_musical_profile_save_skipped")

    async def simple_import(
        self,
        actor_id: UUID,
        *,
        audio: UploadFile,
        title: str | None = None,
        author: str | None = None,
        min_grade: int = 1,
        max_grade: int = 5,
        lyrics_text: str | None = None,
        audio_type: AudioType = "UNKNOWN",
        bpm: float | None = None,
        auto_transcribe: bool = True,
        enable_background_processing: bool = True,
        source_note: str | None = None,
        usage_note: str | None = None,
        rights_confirmed: bool = False,
        child_safe_confirmed: bool = False,
    ) -> SimpleImportResult:
        if min_grade < 1 or max_grade > 5 or min_grade > max_grade:
            raise HTTPException(422, "Invalid grade range")
        if bpm is not None and (not math.isfinite(bpm) or bpm < 30.0 or bpm > 240.0):
            raise HTTPException(422, "BPM must be between 30 and 240")

        # Enforce active admin role before doing heavy I/O or external transcription.
        async with self.repository.read():
            await self.karaoke._actor(actor_id, "admin")

        filename = getattr(audio, "filename", None) or "song.mp3"
        audio_bytes = await read_upload(audio, MAX_AUDIO_BYTES)
        meta = await run_in_threadpool(extract_mp3_metadata, audio_bytes, filename)
        duration_ms: int = meta["duration_ms"]
        audio_sha256: str = meta["sha256"]
        audio_size_bytes: int = meta["size_bytes"]
        cover_bytes: bytes | None = meta["cover_bytes"]

        resolved_title = _safe_clean_optional(title, 200) or meta["title"] or "Bài hát mới"
        resolved_author = _safe_clean_optional(author, 200) or meta["author"]
        resolved_source_note = _safe_clean_optional(source_note, 1000)
        resolved_usage_note = _safe_clean_optional(usage_note, 1000)

        # Resolve lyrics strictly in priority order (NEVER fabricate song lyrics via LLM!).
        resolved_lyrics: dict = {"format_version": 1, "lines": []}
        lyrics_source: LyricsSource = "NONE"
        flagged_lines: list[FlaggedLyricLine] = []
        requires_lyrics_input = False
        guidance_vi = ""

        cleaned_admin_lyrics = (
            _strip_control_chars(lyrics_text, preserve_newlines=True)
            if lyrics_text
            else ""
        )

        if meta["synced_lyrics"] is not None:
            resolved_lyrics = _upgrade_synced_lyrics_to_syllables(
                meta["synced_lyrics"], duration_ms
            )
            lyrics_source = "EMBEDDED_SYNCED"
            guidance_vi = (
                "Đã tự động tách lời có sẵn mốc thời gian từ file MP3. "
                "Bạn chỉ cần nghe kiểm tra nhanh và xác nhận xuất bản."
            )
        elif cleaned_admin_lyrics:
            if has_lrc_timestamps(cleaned_admin_lyrics):
                parsed = parse_lrc_text(
                    cleaned_admin_lyrics, duration_ms, include_syllables=True
                )
                resolved_lyrics = parsed["lyrics"]
                lyrics_source = "ADMIN_TEXT"
                guidance_vi = (
                    "Đã nhập mốc thời gian từ lời .lrc. "
                    "Hãy nghe thử 1 lượt trước khi xác nhận xuất bản."
                )
            else:
                resolved_lyrics, flagged_lines = distribute_plain_lyrics(
                    cleaned_admin_lyrics, duration_ms
                )
                lyrics_source = "ADMIN_TEXT"
                guidance_vi = (
                    "Đã chia mốc thời gian tạm thời theo thời lượng nhạc. "
                    "Bạn có thể căn nhịp nhanh 1 lượt bằng phím Space hoặc xuất bản sau khi kiểm tra."
                )
        elif meta["unsynced_lyrics"]:
            resolved_lyrics, flagged_lines = distribute_plain_lyrics(
                meta["unsynced_lyrics"], duration_ms
            )
            lyrics_source = "EMBEDDED_UNSYNCED"
            guidance_vi = (
                "Đã tự tách lời nhúng (USLT) từ MP3 và chia mốc tạm thời. "
                "Nên nghe thử hoặc căn nhịp nhanh bằng phím Space."
            )
        elif auto_transcribe and audio_type != "INSTRUMENTAL_ONLY":
            transcribed = await self.transcriber(audio_bytes, filename, duration_ms)
            if transcribed is not None:
                resolved_lyrics, flagged_lines = transcribed
                lyrics_source = "GROQ_WHISPER"
                if flagged_lines:
                    guidance_vi = (
                        f"Đã tự nhận diện {len(resolved_lyrics['lines'])} dòng lời bằng Groq Whisper. "
                        f"Có {len(flagged_lines)} dòng độ tin cậy thấp được đánh dấu cần kiểm tra lại."
                    )
                else:
                    guidance_vi = (
                        f"Đã tự nhận diện {len(resolved_lyrics['lines'])} dòng lời bằng Groq Whisper. "
                        "Hãy nghe kiểm tra nhanh chính tả tiếng Việt trước khi xuất bản."
                    )
            else:
                requires_lyrics_input = True
                guidance_vi = (
                    "Chưa có lời nhúng trong file MP3 (hoặc dịch vụ nhận diện giọng hát chưa bật). "
                    "Hãy dán lời bài hát hoặc tải file .lrc ngay bên dưới trong 1 bước."
                )
        else:
            requires_lyrics_input = True
            if audio_type == "INSTRUMENTAL_ONLY":
                guidance_vi = (
                    "File được nhận diện là nhạc nền không lời (Instrumental). "
                    "Hãy dán lời bài hát hoặc chọn file .lrc ngay bên dưới để tự tạo mốc nhanh."
                )
            else:
                guidance_vi = (
                    "File chưa có lời nhúng. Hãy dán lời bài hát hoặc chọn file .lrc "
                    "ngay bên dưới để tiếp tục."
                )

        worker_online = self.is_worker_online()
        if (
            worker_online
            and enable_background_processing
            and audio_type != "INSTRUMENTAL_ONLY"
            and resolved_lyrics.get("format_version") != 2
        ):
            upgraded_v2 = _ensure_v2_lyrics_for_processing(resolved_lyrics, duration_ms)
            if upgraded_v2 is not None:
                resolved_lyrics = upgraded_v2

        # Step A: Short DB transaction 1 — create KaraokeSong + initial DRAFT version.
        async with self.repository.write():
            await self.karaoke._actor(actor_id, "admin")
            state = await self.repository.create(
                actor_id,
                {
                    "title": resolved_title,
                    "author": resolved_author,
                    "min_grade": min_grade,
                    "max_grade": max_grade,
                    "source_note": resolved_source_note,
                    "usage_note": resolved_usage_note,
                    "lyrics": Lyrics().model_dump(mode="json"),
                },
            )
            song_id = state.song.id
            draft_version_id = state.draft.id

        # Step B: Upload audio & optional extracted cover OUTSIDE any DB transaction.
        audio_path = f"songs/{song_id}/versions/{draft_version_id}/audio/{uuid4()}.mp3"
        cover_path = (
            f"songs/{song_id}/versions/{draft_version_id}/covers/{uuid4()}.webp"
            if cover_bytes
            else None
        )
        uploaded_paths: list[str] = []
        try:
            await run_in_threadpool(
                self.storage.upload, audio_path, song_id, audio_bytes, "audio/mpeg"
            )
            uploaded_paths.append(audio_path)
            if cover_bytes and cover_path:
                await run_in_threadpool(
                    self.storage.upload, cover_path, song_id, cover_bytes, "image/webp"
                )
                uploaded_paths.append(cover_path)

            # Step C: Short DB transaction 2 — attach uploaded assets, lyrics, sha256 binding, bump revision.
            async with self.repository.write():
                await self.karaoke._actor(actor_id, "admin")
                state = await self.karaoke._state(
                    song_id,
                    DraftRequest(expected_revision=1, draft_version_id=draft_version_id),
                    lock=True,
                )
                state.draft.audio_path = audio_path
                state.draft.audio_sha256 = audio_sha256
                state.draft.audio_size_bytes = audio_size_bytes
                state.draft.duration_ms = duration_ms
                if cover_path:
                    state.draft.cover_path = cover_path
                state.draft.lyrics = resolved_lyrics
                timing_errors = [
                    issue
                    for issue in content_issues(state.draft, require_binding=False)
                    if issue.field in {"audio", "lyrics"}
                ]
                state.draft.timed_audio_sha256 = None if timing_errors else audio_sha256
                state.draft.updated_at = utcnow()
                await self.repository.bump(state.song, 1)
                draft_snapshot = state.snapshot().draft
                detail = await self.karaoke._detail(state)
        except BaseException:
            for path in uploaded_paths:
                await self.karaoke._cleanup(path, song_id)
            raise

        # Step D: Best-effort save musical profile (gracefully skipped if table unmigrated).
        await self._save_musical_profile_best_effort(
            version_id=draft_version_id,
            audio_type=audio_type,
            bpm=bpm,
            lyrics_source=lyrics_source,
            duration_ms=duration_ms,
            has_cover=bool(cover_path),
            flagged_count=len(flagged_lines),
            requires_lyrics_input=requires_lyrics_input,
            lyrics_dict=resolved_lyrics,
        )

        # Step E: Non-blocking handoff to background KaraokeProcessingJob when worker is online.
        processing_queued = False
        processing_job_id: UUID | None = None
        processing_notice: str | None = None

        if worker_online and enable_background_processing:
            proc_service = self._processing_service()
            v2_lyrics = _ensure_v2_lyrics_for_processing(resolved_lyrics, duration_ms)
            if audio_type == "INSTRUMENTAL_ONLY":
                processing_notice = (
                    "File nhạc nền không lời không cần tách giọng nền — sẵn sàng dùng ngay."
                )
            elif v2_lyrics is None:
                processing_notice = (
                    "Chưa có đủ lời bài hát để xếp hàng tách giọng/căn nhịp tự động. "
                    "Hãy thêm lời và kích hoạt xử lý nền bất cứ lúc nào."
                )
            elif proc_service is not None:
                try:
                    job = await proc_service.start(
                        actor_id,
                        song_id,
                        ProcessingStart(
                            expected_revision=detail.revision,
                            draft_version_id=draft_version_id,
                            idempotency_key=uuid4(),
                            mode="VOCAL_TRACK",
                            source_kind="DRAFT_AUDIO",
                        ),
                    )
                    processing_queued = True
                    processing_job_id = job.id
                    processing_notice = (
                        "Đã xếp hàng worker nền tách giọng, căn âm tiết và phân tích nhịp/giai điệu."
                    )
                    guidance_vi = (
                        f"{guidance_vi} Worker nền đang online nên bài hát đã được đưa vào hàng đợi tự động."
                    )
                    detail = await self.karaoke.detail(actor_id, song_id)
                except (HTTPException, SQLAlchemyError) as exc:
                    processing_notice = (
                        f"Bản nháp tức thì đã sẵn sàng; chưa xếp hàng worker nền ({getattr(exc, 'detail', 'UNAVAILABLE')})."
                    )
        elif not worker_online:
            processing_notice = (
                "Worker nền đang offline — bản nháp tức thì 0 VND đã sẵn sàng để kiểm tra và xuất bản ngay."
            )

        # Compute transparent publish readiness & missing checks.
        missing_checks: list[str] = []
        for issue in content_issues(draft_snapshot):
            if issue.code not in missing_checks:
                missing_checks.append(issue.code)
        if processing_queued and "PROCESSING_IN_PROGRESS" not in missing_checks:
            missing_checks.append("PROCESSING_IN_PROGRESS")
        if not rights_confirmed:
            missing_checks.append("RIGHTS_CONFIRMATION_REQUIRED")
        if not child_safe_confirmed:
            missing_checks.append("CHILD_SAFE_CONFIRMATION_REQUIRED")

        _, derived_bpm, _ = derive_musical_profile_from_lyrics(resolved_lyrics)
        effective_bpm = bpm if bpm is not None else derived_bpm

        lifecycle_state = (
            "QUEUED"
            if processing_queued
            else resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=len(resolved_lyrics.get("lines") or []),
                requires_lyrics_input=requires_lyrics_input,
                flagged_count=len(flagged_lines),
            )
        )

        return SimpleImportResult(
            song_id=song_id,
            version_id=draft_version_id,
            revision=detail.revision,
            title=resolved_title,
            author=resolved_author,
            duration_ms=duration_ms,
            has_cover=bool(cover_path),
            audio_type=audio_type,
            bpm=round(float(effective_bpm), 2) if effective_bpm is not None else None,
            lyrics_source=lyrics_source,
            lyrics_line_count=len(resolved_lyrics.get("lines") or []),
            flagged_lines=flagged_lines,
            requires_lyrics_input=requires_lyrics_input,
            guidance_vi=guidance_vi,
            ready_to_publish=len(missing_checks) == 0,
            missing_checks=missing_checks,
            lifecycle_state=lifecycle_state,
            worker_online=worker_online,
            processing_queued=processing_queued,
            processing_job_id=processing_job_id,
            processing_notice=processing_notice,
            song=detail,
        )

    async def start_simple_processing(
        self,
        actor_id: UUID,
        song_id: UUID,
        payload: SimpleProcessingStartRequest,
    ) -> SimpleProcessingStatusRead:
        """Opt-in non-blocking handoff from a Simple Mode draft to KaraokeProcessingJob."""
        self.processing_replayed = False
        async with self.repository.read():
            await self.karaoke._actor(actor_id, "admin")

        if not self.is_worker_online():
            raise HTTPException(
                503,
                {"code": "PROCESSING_UNAVAILABLE", "message_key": "WORKER_OFFLINE"},
            )
        proc_service = self._processing_service()
        if proc_service is None:
            raise HTTPException(
                503,
                {"code": "PROCESSING_UNAVAILABLE", "message_key": "WORKER_OFFLINE"},
            )

        snapshot = await self.karaoke._admin_snapshot(
            actor_id,
            song_id,
            DraftRequest(
                expected_revision=payload.expected_revision,
                draft_version_id=payload.draft_version_id,
            ),
        )
        draft = snapshot.draft
        if draft is None:
            raise HTTPException(409, "Karaoke draft is missing")

        raw_lyrics = (
            payload.lyrics.model_dump(mode="json")
            if payload.lyrics is not None
            else draft.lyrics
        )
        v2_lyrics = _ensure_v2_lyrics_for_processing(raw_lyrics, draft.duration_ms)
        if v2_lyrics is None:
            raise HTTPException(
                422,
                {"code": "LYRICS_REQUIRED", "message_key": "LYRICS_REQUIRED"},
            )

        current_revision = payload.expected_revision
        if payload.lyrics is not None or v2_lyrics != draft.lyrics:
            saved = await self.karaoke.save(
                actor_id,
                song_id,
                DraftWrite(
                    expected_revision=current_revision,
                    draft_version_id=payload.draft_version_id,
                    title=draft.title,
                    author=draft.author,
                    min_grade=draft.min_grade,
                    max_grade=draft.max_grade,
                    source_note=draft.source_note,
                    usage_note=draft.usage_note,
                    lyrics=Lyrics.model_validate(v2_lyrics),
                ),
            )
            current_revision = saved.revision

        if draft.duration_ms:
            await self._save_musical_profile_best_effort(
                version_id=payload.draft_version_id,
                audio_type=payload.audio_type or "UNKNOWN",
                bpm=payload.bpm,
                lyrics_source="ADMIN_TEXT" if payload.lyrics is not None else "NONE",
                duration_ms=draft.duration_ms,
                has_cover=bool(draft.cover_path),
                flagged_count=0,
                requires_lyrics_input=False,
                lyrics_dict=v2_lyrics,
            )

        await proc_service.start(
            actor_id,
            song_id,
            ProcessingStart(
                expected_revision=current_revision,
                draft_version_id=payload.draft_version_id,
                idempotency_key=payload.idempotency_key or uuid4(),
                mode=payload.mode,
                source_kind=payload.source_kind,
            ),
        )
        self.processing_replayed = bool(getattr(proc_service, "replayed", False))
        return await self.get_simple_processing_status(actor_id, song_id)

    async def get_simple_processing_status(
        self,
        actor_id: UUID,
        song_id: UUID,
    ) -> SimpleProcessingStatusRead:
        """Non-blocking read of honest Simple Mode lifecycle state, job progress, and musical profile."""
        detail = await self.karaoke.detail(actor_id, song_id)
        draft = detail.draft
        active_version = draft or detail.published
        worker_online = self.is_worker_online()

        summary = detail.processing_summary
        if draft is not None and summary is not None and summary.draft_version_id != draft.id:
            summary = None

        job_obj = None
        job_dto = None
        operations: list = []
        proc_service = self._processing_service()

        if summary is not None and proc_service is not None:
            try:
                job_dto = await proc_service.get(actor_id, song_id, summary.job_id)
            except Exception:
                job_dto = None
            proc_repo = getattr(proc_service, "repository", None)
            if proc_repo is not None and hasattr(proc_repo, "get"):
                try:
                    async with proc_repo.read():
                        job_obj = await proc_repo.get(summary.job_id, song_id)
                        if job_obj is not None and hasattr(proc_repo, "operations"):
                            operations = list(await proc_repo.operations(summary.job_id))
                except Exception:
                    job_obj = None
                    operations = []

        profile = await self._load_musical_profile_best_effort(
            active_version.id if active_version is not None else None
        )
        lyrics_dict = (
            active_version.lyrics.model_dump(mode="json")
            if active_version is not None
            else None
        )
        lyrics_line_count = len((lyrics_dict or {}).get("lines") or [])
        derived_beats, derived_bpm, _ = derive_musical_profile_from_lyrics(lyrics_dict)

        job_for_state = job_obj or job_dto or summary
        lifecycle_state = resolve_simple_lifecycle_state(
            has_audio=bool(active_version and active_version.has_audio),
            lyrics_line_count=lyrics_line_count,
            requires_lyrics_input=lyrics_line_count == 0,
            flagged_count=0,
            job=job_for_state,
            operations=operations,
            review_required=bool(detail.processing_review.required),
            reviewed=bool(detail.processing_review.reviewed),
        )

        q_flags = list(job_dto.quality_flags) if job_dto is not None else list(detail.processing_review.quality_flags)
        can_apply = bool(job_dto.can_apply) if job_dto is not None else False
        safe_error = (
            job_dto.safe_error_code
            if job_dto is not None
            else (summary.safe_error_code if summary is not None else None)
        )
        retry_policy = (
            job_dto.retry_policy
            if job_dto is not None
            else (summary.retry_policy if summary is not None else None)
        )

        has_beat_grid = bool(
            (profile and profile.get("has_beat_grid")) or derived_beats or derived_bpm
        )
        job_provenance = (
            job_obj.provenance
            if job_obj is not None and isinstance(getattr(job_obj, "provenance", None), dict)
            else {}
        )
        has_pitch_contour = bool(
            (profile and profile.get("has_pitch_contour"))
            or (
                isinstance(job_provenance.get("pitch_contour"), list)
                and len(job_provenance.get("pitch_contour") or []) > 0
            )
        )
        effective_bpm = (
            profile.get("bpm") if profile and profile.get("bpm") is not None else derived_bpm
        )

        from app.services.ai_task_progress import compute_karaoke_job_progress

        return SimpleProcessingStatusRead(
            song_id=detail.song_id,
            draft_version_id=draft.id if draft is not None else None,
            revision=detail.revision,
            lifecycle_state=lifecycle_state,
            worker_online=worker_online,
            processing_enabled=bool(self.processing_config.enabled),
            processing_configured=bool(self.processing_config.configured),
            job_id=summary.job_id if summary is not None else None,
            job_status=summary.status if summary is not None else None,
            job_stage=summary.stage if summary is not None else None,
            progress_pct=compute_karaoke_job_progress(
                status=summary.status if summary is not None else None,
                stage=summary.stage if summary is not None else None,
                lifecycle_state=lifecycle_state,
            ),
            can_apply=can_apply,
            review_required=bool(detail.processing_review.required),
            reviewed=bool(detail.processing_review.reviewed),
            has_beat_grid=has_beat_grid,
            has_pitch_contour=has_pitch_contour,
            bpm=round(float(effective_bpm), 2) if effective_bpm is not None else None,
            safe_error_code=safe_error,
            retry_policy=retry_policy,
            quality_flags=q_flags,
            guidance_vi=_guidance_for_lifecycle_state(
                lifecycle_state,
                worker_online=worker_online,
                safe_error_code=safe_error,
                can_apply=can_apply,
            ),
            song=detail,
        )

    async def apply_simple_processing(
        self,
        actor_id: UUID,
        song_id: UUID,
        payload: SimpleProcessingApplyRequest,
    ) -> SimpleProcessingStatusRead:
        """Apply completed KaraokeProcessingJob artifacts & enrich KaraokeMusicalProfile."""
        proc_service = self._processing_service()
        if proc_service is None:
            raise HTTPException(
                503,
                {"code": "PROCESSING_UNAVAILABLE", "message_key": "WORKER_OFFLINE"},
            )

        job_provenance: dict = {}
        proc_repo = getattr(proc_service, "repository", None)
        if proc_repo is not None and hasattr(proc_repo, "get"):
            try:
                async with proc_repo.read():
                    raw_job = await proc_repo.get(payload.job_id, song_id)
                    if raw_job is not None and isinstance(getattr(raw_job, "provenance", None), dict):
                        job_provenance = dict(raw_job.provenance)
            except Exception:
                job_provenance = {}

        updated = await proc_service.apply_result(
            actor_id,
            song_id,
            payload.job_id,
            DraftRequest(
                expected_revision=payload.expected_revision,
                draft_version_id=payload.draft_version_id,
            ),
        )
        if updated.draft is not None and updated.draft.duration_ms:
            pitch_contour = (
                job_provenance.get("pitch_contour")
                if isinstance(job_provenance.get("pitch_contour"), list)
                else None
            )
            await self._save_musical_profile_best_effort(
                version_id=updated.draft.id,
                audio_type=payload.audio_type or "VOCAL_FULL",
                bpm=payload.bpm,
                lyrics_source="ADMIN_TEXT",
                duration_ms=updated.draft.duration_ms,
                has_cover=updated.draft.has_cover,
                flagged_count=len(updated.processing_review.quality_flags),
                requires_lyrics_input=False,
                lyrics_dict=updated.draft.lyrics.model_dump(mode="json"),
                source_method_override="AUDIO_DSP",
                pitch_contour=pitch_contour,
                processing_job_id=payload.job_id,
            )

        return await self.get_simple_processing_status(actor_id, song_id)

    async def simple_publish(
        self,
        actor_id: UUID,
        song_id: UUID,
        payload: SimplePublishRequest,
    ) -> AdminDetail:
        """Enforce explicit compliance confirmations, optionally save inline notes/lyrics, and publish."""
        if not payload.rights_confirmed:
            raise HTTPException(
                422,
                "Admin must confirm content rights before publishing",
            )
        if not payload.child_safe_confirmed:
            raise HTTPException(
                422,
                "Admin must confirm child-safety suitability (grades 1-5) before publishing",
            )

        snapshot = await self.karaoke._admin_snapshot(actor_id, song_id, payload)
        draft = snapshot.draft
        if draft is None:
            raise HTTPException(409, "Karaoke draft is missing")

        next_title = payload.title if payload.title is not None else draft.title
        next_author = payload.author if payload.author is not None else draft.author
        next_min_grade = (
            payload.min_grade if payload.min_grade is not None else draft.min_grade
        )
        next_max_grade = (
            payload.max_grade if payload.max_grade is not None else draft.max_grade
        )
        next_source_note = (
            payload.source_note if payload.source_note is not None else draft.source_note
        )
        next_usage_note = (
            payload.usage_note if payload.usage_note is not None else draft.usage_note
        )
        next_lyrics = (
            payload.lyrics
            if payload.lyrics is not None
            else Lyrics.model_validate(draft.lyrics)
        )

        if next_min_grade > next_max_grade:
            raise HTTPException(422, "Invalid grade range")
        if not clean_text(next_source_note):
            raise HTTPException(422, "Source note is required before publishing")
        if not clean_text(next_usage_note):
            raise HTTPException(422, "Usage note is required before publishing")

        current_revision = payload.expected_revision
        needs_save = any(
            field is not None
            for field in (
                payload.title,
                payload.author,
                payload.min_grade,
                payload.max_grade,
                payload.source_note,
                payload.usage_note,
                payload.lyrics,
            )
        )
        if needs_save:
            saved = await self.karaoke.save(
                actor_id,
                song_id,
                DraftWrite(
                    expected_revision=current_revision,
                    draft_version_id=payload.draft_version_id,
                    title=next_title,
                    author=next_author,
                    min_grade=next_min_grade,
                    max_grade=next_max_grade,
                    source_note=next_source_note,
                    usage_note=next_usage_note,
                    lyrics=next_lyrics,
                ),
            )
            current_revision = saved.revision
            if payload.lyrics is not None and draft.duration_ms:
                await self._save_musical_profile_best_effort(
                    version_id=payload.draft_version_id,
                    audio_type="UNKNOWN",
                    bpm=None,
                    lyrics_source="ADMIN_TEXT",
                    duration_ms=draft.duration_ms,
                    has_cover=bool(draft.cover_path),
                    flagged_count=0,
                    requires_lyrics_input=False,
                    lyrics_dict=next_lyrics.model_dump(mode="json"),
                    source_method_override="MANUAL_TAP",
                )

        # Always delegate final publish to KaraokeService.publish (preserves content_issues & locks).
        return await self.karaoke.publish(
            actor_id,
            song_id,
            DraftRequest(
                expected_revision=current_revision,
                draft_version_id=payload.draft_version_id,
            ),
        )
