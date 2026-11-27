"""Bounded media validation; metadata comes from bytes, not browser claims."""
import hashlib
import math
import os
import re
import unicodedata
from dataclasses import dataclass
from io import BytesIO
from uuid import uuid4
import warnings

from fastapi import HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from app.schemas.karaoke import (
    Lyrics,
    MAX_AUDIO_BYTES,
    MAX_COVER_BYTES,
    MAX_DURATION_MS,
    canonical_lyric_text,
)


@dataclass(frozen=True)
class AudioMetadata:
    duration_ms: int
    size_bytes: int
    sha256: str


_LRC_META_RE = re.compile(r"^\[(ar|al|ti|au|by|re|ve|length):[^\]]*\]$", re.IGNORECASE)
_LRC_OFFSET_RE = re.compile(r"^\[offset:([+-]?\d+)\]$", re.IGNORECASE)
_LRC_STAMP_RE = re.compile(r"\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]")
_INLINE_WORD_STAMP_RE = re.compile(r"<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>")
_LEADING_TRACK_RE = re.compile(r"^\s*\d{1,3}\s*[-._)]\s*")
_NOISE_TAG_RE = re.compile(
    r"\s*(?:\[[^\]]*(?:official|mv|video|audio|lyric|karaoke|kbps|mp3|hd|hq|remaster|beat|full)[^\]]*\]|"
    r"\([^)]*(?:official|mv|video|audio|lyric|karaoke|kbps|mp3|hd|hq|remaster|beat|full)[^)]*\))\s*",
    re.IGNORECASE,
)


def _strip_control_chars(value: str, *, preserve_newlines: bool = False) -> str:
    text = unicodedata.normalize("NFC", value).replace("\ufeff", "")
    if preserve_newlines:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        cleaned = "".join(
            ch for ch in text if ch == "\n" or unicodedata.category(ch) != "Cc"
        )
        return cleaned.strip()
    cleaned = "".join(
        " " if ch in ("\t", "\r", "\n") else ch
        for ch in text
        if ch in ("\t", "\r", "\n") or unicodedata.category(ch) != "Cc"
    )
    return " ".join(cleaned.split()).strip()


def clean_filename_title(filename: str) -> str:
    """Turn an uploaded MP3 filename into a clean, bounded Vietnamese song title."""
    if not filename:
        return ""
    base = os.path.basename(filename.replace("\\", "/"))
    stem, _ = os.path.splitext(base)
    without_track = _LEADING_TRACK_RE.sub("", stem)
    candidate = (without_track if without_track.strip() else stem).replace("_", " ")
    without_noise = _NOISE_TAG_RE.sub(" ", candidate)
    if without_noise.strip():
        candidate = without_noise
    return _strip_control_chars(candidate)[:200]


def has_lrc_timestamps(text: str | None) -> bool:
    """Return True when text contains at least one timestamped [mm:ss(.xx)] lyric line."""
    if not text:
        return False
    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line or _LRC_META_RE.match(line) or _LRC_OFFSET_RE.match(line):
            continue
        if _LRC_STAMP_RE.search(line):
            lyric_body = _LRC_STAMP_RE.sub("", line)
            lyric_body = _INLINE_WORD_STAMP_RE.sub("", lyric_body).strip()
            if lyric_body:
                return True
    return False


def distribute_syllables_for_line(
    text: str, start_ms: int, end_ms: int
) -> list[dict] | None:
    """Distribute integer syllable timings strictly monotonically within [start_ms, end_ms]."""
    normalized = canonical_lyric_text(text)
    if not normalized:
        return None
    tokens = normalized.split(" ")
    count = len(tokens)
    span = end_ms - start_ms
    if count == 0 or count > 150 or span < count:
        return None
    weights = [max(1, len(tok)) for tok in tokens]
    total_weight = sum(weights)
    extra = span - count
    durations = [1 + (extra * weight) // total_weight for weight in weights]
    remainder = span - sum(durations)
    for idx in range(remainder):
        durations[idx % count] += 1
    cursor = start_ms
    syllables: list[dict] = []
    for token, dur in zip(tokens, durations):
        syllables.append(
            {
                "id": str(uuid4()),
                "text": token,
                "start_ms": cursor,
                "end_ms": cursor + dur,
            }
        )
        cursor += dur
    return syllables


def _build_monotonic_timed_lines(
    raw_entries: list[tuple[str, int, int | None]],
    duration_ms: int,
    *,
    include_syllables: bool,
) -> tuple[dict, int]:
    """Normalize (text, start_ms, optional_end_ms) tuples into valid ViRead Lyrics JSON."""
    if duration_ms < 1 or not raw_entries:
        return {"format_version": 1, "lines": []}, 1

    cleaned_entries: list[tuple[str, int, int | None]] = []
    total_chars = 0
    for text, start_ms, explicit_end_ms in raw_entries:
        clean = _strip_control_chars(text)[:300]
        if not clean:
            continue
        if len(cleaned_entries) >= 300 or total_chars + len(clean) > 50_000:
            break
        clamped_start = max(0, min(duration_ms - 1, int(start_ms)))
        clamped_end = (
            max(0, min(duration_ms, int(explicit_end_ms)))
            if explicit_end_ms is not None
            else None
        )
        cleaned_entries.append((clean, clamped_start, clamped_end))
        total_chars += len(clean)

    if not cleaned_entries:
        return {"format_version": 1, "lines": []}, 1

    cleaned_entries.sort(key=lambda item: item[1])
    line_count = len(cleaned_entries)
    if duration_ms < line_count:
        # Audio too short for strictly distinct 1ms line windows; emit untimed v1 cleanly.
        untimed = {
            "format_version": 1,
            "lines": [
                {"id": str(uuid4()), "text": text, "start_ms": None, "end_ms": None}
                for text, _, _ in cleaned_entries
            ],
        }
        return Lyrics.model_validate(untimed).model_dump(mode="json"), 1

    # Compute strictly non-overlapping [start_ms, end_ms] for every line inside [0, duration_ms].
    starts = [entry[1] for entry in cleaned_entries]
    for i in range(1, line_count):
        if starts[i] <= starts[i - 1]:
            starts[i] = starts[i - 1] + 1
    # If pushing starts forward exceeded duration_ms - 1, compact from the right.
    if starts[-1] >= duration_ms:
        starts[-1] = duration_ms - 1
        for i in range(line_count - 2, -1, -1):
            if starts[i] >= starts[i + 1]:
                starts[i] = max(0, starts[i + 1] - 1)

    line_bounds: list[tuple[str, int, int]] = []
    for i, (text, _, explicit_end) in enumerate(cleaned_entries):
        start_ms = starts[i]
        next_start = starts[i + 1] if i + 1 < line_count else duration_ms
        if explicit_end is not None and start_ms < explicit_end <= next_start:
            end_ms = explicit_end
        else:
            end_ms = next_start
        if end_ms <= start_ms:
            end_ms = min(duration_ms, start_ms + 1)
        line_bounds.append((text, start_ms, end_ms))

    if include_syllables:
        v2_lines: list[dict] = []
        total_syllables = 0
        all_fit = True
        for text, start_ms, end_ms in line_bounds:
            syllables = distribute_syllables_for_line(text, start_ms, end_ms)
            if syllables is None or total_syllables + len(syllables) > 10_000:
                all_fit = False
                break
            total_syllables += len(syllables)
            v2_lines.append(
                {
                    "id": str(uuid4()),
                    "text": text,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "syllables": syllables,
                }
            )
        if all_fit and v2_lines:
            validated = Lyrics.model_validate({"format_version": 2, "lines": v2_lines})
            return validated.model_dump(mode="json"), 2

    v1_lines = [
        {
            "id": str(uuid4()),
            "text": text,
            "start_ms": start_ms,
            "end_ms": end_ms,
        }
        for text, start_ms, end_ms in line_bounds
    ]
    validated = Lyrics.model_validate({"format_version": 1, "lines": v1_lines})
    return validated.model_dump(mode="json"), 1


def parse_lrc_text(
    lrc: str, duration_ms: int, *, include_syllables: bool = True
) -> dict:
    """Parse [mm:ss.xx] LRC lines into syllable-timed ViRead lyrics with honest confidence metadata."""
    if not lrc or duration_ms < 1:
        return {
            "lyrics": {"format_version": 1, "lines": []},
            "format_version": 1,
            "line_count": 0,
            "confidence": {
                "overall": "NONE",
                "line_starts": "NONE",
                "line_ends": "NONE",
                "syllables": "NONE",
                "needs_manual_timing": True,
            },
            "flagged_lines": [],
        }

    normalized = _strip_control_chars(lrc, preserve_newlines=True)
    raw_lines = [line.strip() for line in normalized.split("\n") if line.strip()]
    offset_ms = 0
    for entry in raw_lines:
        offset_match = _LRC_OFFSET_RE.match(entry)
        if offset_match:
            try:
                offset_ms = int(offset_match.group(1))
            except ValueError:
                offset_ms = 0

    parsed_entries: list[tuple[str, int, int | None]] = []
    for entry in raw_lines:
        if _LRC_META_RE.match(entry) or _LRC_OFFSET_RE.match(entry):
            continue
        stamps = list(_LRC_STAMP_RE.finditer(entry))
        if not stamps:
            continue
        lyric_body = _LRC_STAMP_RE.sub("", entry)
        lyric_body = _INLINE_WORD_STAMP_RE.sub("", lyric_body)
        lyric_body = _strip_control_chars(lyric_body)
        if not lyric_body:
            continue
        for stamp in stamps:
            minutes = int(stamp.group(1))
            seconds = int(stamp.group(2))
            frac = stamp.group(3) or "0"
            millis = int(frac.ljust(3, "0")[:3])
            timestamp_ms = minutes * 60_000 + seconds * 1000 + millis + offset_ms
            if timestamp_ms < 0:
                timestamp_ms = 0
            if timestamp_ms <= MAX_DURATION_MS:
                parsed_entries.append((lyric_body, timestamp_ms, None))

    if not parsed_entries:
        return {
            "lyrics": {"format_version": 1, "lines": []},
            "format_version": 1,
            "line_count": 0,
            "confidence": {
                "overall": "NONE",
                "line_starts": "NONE",
                "line_ends": "NONE",
                "syllables": "NONE",
                "needs_manual_timing": True,
            },
            "flagged_lines": [],
        }

    lyrics_dict, fmt_version = _build_monotonic_timed_lines(
        parsed_entries, duration_ms, include_syllables=include_syllables
    )
    lines = lyrics_dict["lines"]
    timed_ok = bool(lines) and all(
        line.get("start_ms") is not None and line.get("end_ms") is not None
        for line in lines
    )
    return {
        "lyrics": lyrics_dict,
        "format_version": fmt_version,
        "line_count": len(lines),
        "confidence": {
            "overall": "HIGH" if timed_ok else "LOW",
            "line_starts": "EXACT_LRC" if timed_ok else "UNAVAILABLE",
            "line_ends": "NEXT_LINE_OR_DURATION_ESTIMATE" if timed_ok else "UNAVAILABLE",
            "syllables": (
                "PROPORTIONAL_ESTIMATE"
                if fmt_version == 2
                else ("LINE_LEVEL_ONLY" if timed_ok else "UNAVAILABLE")
            ),
            "needs_manual_timing": not timed_ok,
        },
        "flagged_lines": [],
    }


def _parse_sylt_frame(frame, duration_ms: int, sample_rate: int) -> dict | None:
    """Convert an ID3v2 SYLT frame into standard ViRead v1 lyrics JSON."""
    entries = getattr(frame, "text", None) or []
    if not entries:
        return None
    time_format = getattr(frame, "format", 2)

    def to_ms(raw_ts: int) -> int:
        ts = int(raw_ts)
        if time_format == 1:
            rate = sample_rate if sample_rate and sample_rate > 0 else 44100
            return round(ts * 1152 * 1000 / rate)
        return ts

    has_newline_tokens = any(
        isinstance(item, (tuple, list))
        and len(item) >= 2
        and isinstance(item[0], str)
        and ("\n" in item[0] or "\r" in item[0])
        for item in entries
    )

    line_entries: list[tuple[str, int, int | None]] = []
    if has_newline_tokens:
        current_parts: list[str] = []
        current_start: int | None = None
        for item in entries:
            if not isinstance(item, (tuple, list)) or len(item) < 2:
                continue
            raw_text, raw_ts = str(item[0]), item[1]
            ms = to_ms(raw_ts)
            chunks = raw_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
            for idx, chunk in enumerate(chunks):
                if idx > 0:
                    joined = _strip_control_chars("".join(current_parts))
                    if joined and current_start is not None:
                        line_entries.append((joined, current_start, None))
                    current_parts = []
                    current_start = None
                if chunk:
                    if current_start is None:
                        current_start = ms
                    current_parts.append(chunk)
        joined = _strip_control_chars("".join(current_parts))
        if joined and current_start is not None:
            line_entries.append((joined, current_start, None))
    else:
        for item in entries:
            if not isinstance(item, (tuple, list)) or len(item) < 2:
                continue
            text = _strip_control_chars(str(item[0]))
            if text:
                line_entries.append((text, to_ms(item[1]), None))

    if not line_entries:
        return None
    lyrics_dict, _ = _build_monotonic_timed_lines(
        line_entries, duration_ms, include_syllables=False
    )
    if not lyrics_dict["lines"]:
        return None
    return lyrics_dict


def _pick_preferred_lang_frame(frames: list) -> object | None:
    if not frames:
        return None
    preferred = ("vie", "vi", "und", "")
    for lang in preferred:
        for frame in frames:
            frame_lang = str(getattr(frame, "lang", "") or "").strip().lower()
            if frame_lang == lang:
                return frame
    return frames[0]


def _extract_text_frame(tags, frame_id: str) -> str:
    if not tags:
        return ""
    frame = tags.get(frame_id)
    if frame is None:
        return ""
    values = getattr(frame, "text", None)
    if isinstance(values, (list, tuple)):
        joined = " ".join(str(v) for v in values if v is not None)
    elif values is not None:
        joined = str(values)
    else:
        joined = str(frame)
    return _strip_control_chars(joined)[:200]


def extract_mp3_metadata(data: bytes, filename: str = "") -> dict:
    """Validate MP3 bytes and safely extract ID3v2 title, author, cover, and lyrics."""
    audio = inspect_audio(data)
    fallback_title = clean_filename_title(filename)

    title = ""
    author = ""
    cover_bytes: bytes | None = None
    cover_mime: str | None = None
    unsynced_lyrics: str | None = None
    synced_lyrics: dict | None = None
    synced_lyrics_source: str | None = None

    try:
        from mutagen.mp3 import MP3

        mp3 = MP3(BytesIO(data))
        tags = mp3.tags
        sample_rate = int(getattr(mp3.info, "sample_rate", 44100) or 44100)
    except Exception:
        tags = None
        sample_rate = 44100

    if tags is not None:
        title = _extract_text_frame(tags, "TIT2")
        author = _extract_text_frame(tags, "TPE1") or _extract_text_frame(tags, "TCOM")

        # Safely extract and normalize embedded APIC cover art (capped & EXIF-stripped).
        apic_frames = tags.getall("APIC") if hasattr(tags, "getall") else []
        for frame in apic_frames:
            raw_cover = getattr(frame, "data", None)
            if not isinstance(raw_cover, (bytes, bytearray)) or not raw_cover:
                continue
            if len(raw_cover) > MAX_COVER_BYTES:
                continue
            try:
                cover_bytes = normalize_cover(bytes(raw_cover))
                cover_mime = "image/webp"
                break
            except HTTPException:
                continue

        # Extract USLT unsynced lyrics (may also contain embedded LRC timestamps).
        uslt_frames = tags.getall("USLT") if hasattr(tags, "getall") else []
        uslt_frame = _pick_preferred_lang_frame(
            [f for f in uslt_frames if getattr(f, "text", None)]
        )
        if uslt_frame is not None:
            raw_uslt = _strip_control_chars(
                str(getattr(uslt_frame, "text", "")), preserve_newlines=True
            )
            if raw_uslt:
                unsynced_lyrics = raw_uslt[:50_000]

        # Priority 1: SYLT synced lyrics -> standard ViRead v1 lyrics JSON.
        sylt_frames = tags.getall("SYLT") if hasattr(tags, "getall") else []
        sylt_frame = _pick_preferred_lang_frame(
            [f for f in sylt_frames if getattr(f, "text", None)]
        )
        if sylt_frame is not None:
            parsed_sylt = _parse_sylt_frame(sylt_frame, audio.duration_ms, sample_rate)
            if parsed_sylt is not None:
                synced_lyrics = parsed_sylt
                synced_lyrics_source = "SYLT"

        # Priority 2: LRC timestamps embedded inside USLT -> standard ViRead v1 lyrics JSON.
        if synced_lyrics is None and unsynced_lyrics and has_lrc_timestamps(unsynced_lyrics):
            lrc_parsed = parse_lrc_text(
                unsynced_lyrics, audio.duration_ms, include_syllables=False
            )
            if lrc_parsed["line_count"] > 0:
                synced_lyrics = lrc_parsed["lyrics"]
                synced_lyrics_source = "USLT_LRC"

    return {
        "title": title or fallback_title,
        "author": author,
        "duration_ms": audio.duration_ms,
        "size_bytes": audio.size_bytes,
        "sha256": audio.sha256,
        "cover_bytes": cover_bytes,
        "cover_mime": cover_mime,
        "unsynced_lyrics": unsynced_lyrics,
        "synced_lyrics": synced_lyrics,
        "synced_lyrics_source": synced_lyrics_source,
    }


async def read_upload(file: UploadFile, maximum: int) -> bytes:
    chunks, size = [], 0
    try:
        while block := await file.read(min(64 * 1024, maximum + 1 - size)):
            size += len(block)
            if size > maximum:
                raise HTTPException(413, "Karaoke upload is too large")
            chunks.append(block)
        if not size:
            raise HTTPException(415, "Karaoke media is empty")
        return b"".join(chunks)
    finally:
        await file.close()


def inspect_audio(data: bytes) -> AudioMetadata:
    if not data:
        raise HTTPException(415, "Karaoke media is empty")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Karaoke upload is too large")
    try:
        # Lazy import keeps unrelated APIs importable in lean installations.
        from mutagen.mp3 import MP3
    except ImportError:
        raise HTTPException(503, "Karaoke audio validation is unavailable") from None
    try:
        info = MP3(BytesIO(data)).info
        length = info.length
        if info.layer != 3 or info.sketchy or not math.isfinite(length) or length <= 0:
            raise ValueError("Invalid MPEG Layer III metadata")
        duration_ms = round(length * 1000)
        if not 1 <= duration_ms <= MAX_DURATION_MS:
            raise HTTPException(422, "Karaoke audio duration is out of range")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(415, "Karaoke audio must be a valid MP3") from None
    return AudioMetadata(duration_ms, len(data), hashlib.sha256(data).hexdigest())


def normalize_cover(data: bytes) -> bytes:
    if not data:
        raise HTTPException(415, "Karaoke media is empty")
    if len(data) > MAX_COVER_BYTES:
        raise HTTPException(413, "Karaoke upload is too large")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("Unsupported image")
                if max(source.size) > 4096 or min(source.size) < 1:
                    raise ValueError("Image dimensions are out of range")
                if getattr(source, "is_animated", False):
                    raise ValueError("Animated covers are unsupported")
                source.load()
                image = source.convert("RGBA" if "A" in source.getbands() else "RGB")
                # A fresh image prevents propagating EXIF/ICC or source metadata.
                clean = Image.new(image.mode, image.size)
                clean.paste(image)
                output = BytesIO()
                clean.save(output, "WEBP", quality=85)
                result = output.getvalue()
                if len(result) > MAX_COVER_BYTES:
                    raise HTTPException(413, "Karaoke cover is too large")
                return result
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise HTTPException(415, "Karaoke cover must be a valid supported image") from None
