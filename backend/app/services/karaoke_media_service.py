"""Bounded media validation; metadata comes from bytes, not browser claims."""
import hashlib
import math
from dataclasses import dataclass
from io import BytesIO
import warnings

from fastapi import HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from app.schemas.karaoke import MAX_AUDIO_BYTES, MAX_COVER_BYTES, MAX_DURATION_MS


@dataclass(frozen=True)
class AudioMetadata:
    duration_ms: int
    size_bytes: int
    sha256: str


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
