"""One-file Admin Karaoke Simple Mode import and safe compliance publish pipeline."""
import logging
import math
import os
import re
from typing import Awaitable, Callable
from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException, UploadFile
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from app.models.entertainment_v4 import KaraokeMusicalProfile
from app.models.karaoke import utcnow
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
from app.schemas.karaoke_simple_import import (
    AudioType,
    FlaggedLyricLine,
    LyricsSource,
    SimpleImportResult,
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
from app.services.karaoke_service import KaraokeService, content_issues
from app.services.karaoke_storage_service import KaraokeStorage

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


class KaraokeSimpleImportService:
    """Coordinates one-file MP3 ingestion, ID3/LRC/Whisper lyrics resolution, and compliant publish."""

    def __init__(
        self,
        repository: KaraokeRepository,
        storage=None,
        *,
        transcriber: TranscriberFn | None = None,
    ):
        self.repository = repository
        self.storage = storage or KaraokeStorage()
        self.karaoke = KaraokeService(repository, self.storage)
        self.transcriber = transcriber or transcribe_with_groq_whisper

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
    ) -> None:
        db = getattr(self.repository, "db", None)
        if db is None:
            return
        source_method_map: dict[LyricsSource, str] = {
            "EMBEDDED_SYNCED": "ID3_LRC",
            "GROQ_WHISPER": "WHISPER_DRAFT",
            "EMBEDDED_UNSYNCED": "LYRICS_TIMING",
            "ADMIN_TEXT": "LYRICS_TIMING",
            "NONE": "AUDIO_DSP" if bpm is not None else "LYRICS_TIMING",
        }
        source_method = source_method_map[lyrics_source]
        safe_bpm = round(float(bpm), 2) if bpm is not None and 30.0 <= bpm <= 240.0 else None
        profile_json = {
            "lyrics_source": lyrics_source,
            "duration_ms": duration_ms,
            "has_cover": has_cover,
            "flagged_line_count": flagged_count,
            "requires_lyrics_input": requires_lyrics_input,
            "beat_interval_ms": round(60_000.0 / safe_bpm) if safe_bpm else None,
        }
        try:
            stmt = (
                pg_insert(KaraokeMusicalProfile)
                .values(
                    SongVersionId=version_id,
                    Bpm=safe_bpm,
                    AudioType=audio_type,
                    HasPitchContour=False,
                    HasBeatGrid=safe_bpm is not None,
                    SourceMethod=source_method,
                    ProfileJson=profile_json,
                    UpdatedAt=utcnow(),
                )
                .on_conflict_do_update(
                    index_elements=[KaraokeMusicalProfile.SongVersionId],
                    set_={
                        "bpm": safe_bpm,
                        "audio_type": audio_type,
                        "has_beat_grid": safe_bpm is not None,
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
        )

        # Compute transparent publish readiness & missing checks.
        missing_checks: list[str] = []
        for issue in content_issues(draft_snapshot):
            if issue.code not in missing_checks:
                missing_checks.append(issue.code)
        if not rights_confirmed:
            missing_checks.append("RIGHTS_CONFIRMATION_REQUIRED")
        if not child_safe_confirmed:
            missing_checks.append("CHILD_SAFE_CONFIRMATION_REQUIRED")

        return SimpleImportResult(
            song_id=song_id,
            version_id=draft_version_id,
            revision=detail.revision,
            title=resolved_title,
            author=resolved_author,
            duration_ms=duration_ms,
            has_cover=bool(cover_path),
            audio_type=audio_type,
            bpm=round(float(bpm), 2) if bpm is not None else None,
            lyrics_source=lyrics_source,
            lyrics_line_count=len(resolved_lyrics.get("lines") or []),
            flagged_lines=flagged_lines,
            requires_lyrics_input=requires_lyrics_input,
            guidance_vi=guidance_vi,
            ready_to_publish=len(missing_checks) == 0,
            missing_checks=missing_checks,
            song=detail,
        )

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

        # Always delegate final publish to KaraokeService.publish (preserves content_issues & locks).
        return await self.karaoke.publish(
            actor_id,
            song_id,
            DraftRequest(
                expected_revision=current_revision,
                draft_version_id=payload.draft_version_id,
            ),
        )
