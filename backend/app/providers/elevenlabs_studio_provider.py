"""ElevenLabs voice catalog and word-timed text-to-speech.

Extends the existing provider (same server-side key handling and safe error
mapping) without modifying it.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import math
import os
import re
import time
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.providers.elevenlabs_voice_provider import (
    DEFAULT_MODEL_ID,
    ELEVENLABS_API_BASE_URL,
    ElevenLabsVoiceProvider,
    VoiceProviderError,
    VoiceProviderUnavailable,
)

logger = logging.getLogger(__name__)

# The voice catalog lives under /v2, the base URL constant is /v1.
ELEVENLABS_VOICES_URL = ELEVENLABS_API_BASE_URL.removesuffix("/v1") + "/v2/voices"
VOICE_CACHE_TTL_SECONDS = 600
MAX_VOICE_PAGES = 5  # bounded pagination: never loop on a misbehaving provider
AUDIO_CACHE_MAX_ENTRIES = 24
AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024


@dataclass(frozen=True)
class TimedWord:
    index: int
    start: float
    end: float


@dataclass(frozen=True)
class TimedSpeech:
    audio: bytes
    content_type: str
    duration_seconds: float
    words: tuple[TimedWord, ...]


class _TimedSpeechCache:
    """Small in-memory LRU: replaying a page is instant and costs no credits."""

    def __init__(self) -> None:
        self._items: OrderedDict[str, TimedSpeech] = OrderedDict()
        self._bytes = 0

    def get(self, key: str) -> TimedSpeech | None:
        item = self._items.get(key)
        if item is not None:
            self._items.move_to_end(key)
        return item

    def put(self, key: str, value: TimedSpeech) -> None:
        if len(value.audio) > AUDIO_CACHE_MAX_BYTES // 2:
            return
        previous = self._items.pop(key, None)
        if previous is not None:
            self._bytes -= len(previous.audio)
        self._items[key] = value
        self._bytes += len(value.audio)
        while self._items and (
            len(self._items) > AUDIO_CACHE_MAX_ENTRIES
            or self._bytes > AUDIO_CACHE_MAX_BYTES
        ):
            _, evicted = self._items.popitem(last=False)
            self._bytes -= len(evicted.audio)

    def clear(self) -> None:
        self._items.clear()
        self._bytes = 0


_audio_cache = _TimedSpeechCache()
_voice_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def clear_caches() -> None:
    """Used by tests."""
    _audio_cache.clear()
    _voice_cache.clear()


def _text_field(value: Any, limit: int = 200) -> str | None:
    if isinstance(value, str) and value.strip():
        return " ".join(value.split())[:limit]
    return None


def voice_from_payload(item: Any) -> dict[str, Any] | None:
    """Keep only the safe, display-relevant fields of a provider voice."""

    if not isinstance(item, dict):
        return None
    voice_id = item.get("voice_id")
    name = _text_field(item.get("name"), 120)
    if (
        not isinstance(voice_id, str)
        or not voice_id.replace("-", "").replace("_", "").isalnum()
        or len(voice_id) > 100
        or name is None
    ):
        return None
    labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
    preview = item.get("preview_url")
    return {
        "voice_id": voice_id,
        "name": name,
        "category": _text_field(item.get("category"), 40),
        "gender": _text_field(labels.get("gender"), 40),
        "accent": _text_field(labels.get("accent"), 40),
        "age": _text_field(labels.get("age"), 40),
        "use_case": _text_field(labels.get("use_case"), 60),
        "description": _text_field(item.get("description"), 200)
        or _text_field(labels.get("descriptive"), 60),
        "preview_url": preview
        if isinstance(preview, str) and preview.startswith("https://")
        else None,
    }


def word_timings(
    words: list[str], alignment: Any
) -> tuple[list[TimedWord], float]:
    """Map ElevenLabs per-character times to per-word times.

    The text sent to the provider is ``" ".join(words)``, so every word owns a
    known character range and the alignment (one entry per input character)
    gives its exact start and end in the generated audio.
    """

    if not isinstance(alignment, dict):
        raise VoiceProviderError()
    characters = alignment.get("characters")
    starts = alignment.get("character_start_times_seconds")
    ends = alignment.get("character_end_times_seconds")
    text = " ".join(words)
    if (
        not isinstance(characters, list)
        or not isinstance(starts, list)
        or not isinstance(ends, list)
        or not words
        or not len(characters) == len(starts) == len(ends)
        or any(not isinstance(character, str) or not character for character in characters)
    ):
        raise VoiceProviderError()

    def number(value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise VoiceProviderError()
        if value < 0:
            raise VoiceProviderError()
        return float(value)

    raw_text = "".join(characters)
    if unicodedata.normalize("NFC", raw_text) != unicodedata.normalize("NFC", text):
        raise VoiceProviderError()
    previous_end = 0.0
    for start_value, end_value in zip(starts, ends):
        start, end = number(start_value), number(end_value)
        if start < previous_end or end < start:
            raise VoiceProviderError()
        previous_end = end

    # Provider entries can be code points or combining sequences. Whitespace
    # boundaries preserve word identity even when Vietnamese NFC/NFD lengths
    # differ; never infer ranges by equal character duration or array length.
    owners = [index for index, character in enumerate(characters) for _ in character]
    ranges = list(re.finditer(r"\S+", raw_text))
    if len(ranges) != len(words):
        raise VoiceProviderError()

    result: list[TimedWord] = []
    for index, (word, span) in enumerate(zip(words, ranges)):
        if unicodedata.normalize("NFC", span.group()) != unicodedata.normalize("NFC", word):
            raise VoiceProviderError()
        first, last = owners[span.start()], owners[span.end() - 1]
        start = number(starts[first])
        end = number(ends[last])
        result.append(TimedWord(index=index, start=round(start, 3), end=round(end, 3)))
    return result, round(max(number(value) for value in ends), 3)


class ElevenLabsStudioProvider(ElevenLabsVoiceProvider):
    """Voice catalog and word-timed synthesis on top of the base provider."""

    async def list_voices(self) -> list[dict[str, Any]]:
        headers = self._headers()  # raises VoiceProviderUnavailable without a key
        cache_key = self._key_fingerprint or "none"
        cached = _voice_cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < VOICE_CACHE_TTL_SECONDS:
            return cached[1]

        voices: list[dict[str, Any]] = []
        seen: set[str] = set()
        page_token: str | None = None
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(15.0, connect=5.0)
            ) as client:
                for _ in range(MAX_VOICE_PAGES):
                    params: dict[str, Any] = {"page_size": 100}
                    if page_token:
                        params["next_page_token"] = page_token
                    response = await client.get(
                        ELEVENLABS_VOICES_URL,
                        headers=headers,
                        params=params,
                    )
                    if response.status_code == 429 or response.status_code >= 500:
                        raise VoiceProviderUnavailable()
                    if response.is_error:
                        logger.warning(
                            "ElevenLabs voices HTTP error: status=%s", response.status_code
                        )
                        raise VoiceProviderError()
                    payload = response.json()
                    if not isinstance(payload, dict):
                        raise VoiceProviderError()
                    entries = payload.get("voices", [])
                    if not isinstance(entries, list):
                        raise VoiceProviderError()
                    for item in entries:
                        voice = voice_from_payload(item)
                        if voice and voice["voice_id"] not in seen:
                            seen.add(voice["voice_id"])
                            voices.append(voice)
                    token = payload.get("next_page_token")
                    if not payload.get("has_more") or not isinstance(token, str) or token == page_token:
                        break
                    page_token = token
        except httpx.TimeoutException as error:
            raise VoiceProviderUnavailable() from error
        except httpx.HTTPError as error:
            raise VoiceProviderError() from error
        except ValueError as error:
            raise VoiceProviderError() from error

        _voice_cache[cache_key] = (time.monotonic(), voices)
        return voices

    async def synthesize_timed(
        self,
        *,
        words: list[str],
        requested_voice_id: str | None = None,
        speed: float = 1.0,
    ) -> TimedSpeech:
        headers = self._headers()
        voice_id = self._voice_id(requested_voice_id)
        model_id = os.getenv("ELEVENLABS_MODEL_ID", "").strip() or DEFAULT_MODEL_ID
        text = " ".join(words)
        settings = self._tts_voice_settings(model_id, speed)
        speed = settings["speed"]

        cache_key = hashlib.sha256(
            "\x1f".join(
                (self._key_fingerprint or "", voice_id, model_id, f"{speed:.2f}", text)
            ).encode("utf-8")
        ).hexdigest()
        cached = _audio_cache.get(cache_key)
        if cached is not None:
            return cached

        payload: dict[str, Any] = {
            "text": text,
            "model_id": model_id,
            "voice_settings": settings,
        }
        if "flash" in model_id or "turbo" in model_id:
            payload["language_code"] = "vi"

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0)
            ) as client:
                response = await client.post(
                    f"{ELEVENLABS_API_BASE_URL}/text-to-speech/{quote(voice_id, safe='')}/with-timestamps",
                    headers={**headers, "Accept": "application/json"},
                    params={"output_format": "mp3_44100_128"},
                    json=payload,
                )
        except httpx.TimeoutException as error:
            raise VoiceProviderUnavailable() from error
        except httpx.HTTPError as error:
            raise VoiceProviderError() from error

        if response.status_code == 429 or response.status_code >= 500:
            logger.warning("ElevenLabs timed TTS HTTP error: status=%s", response.status_code)
            raise VoiceProviderUnavailable()
        if response.is_error:
            logger.error("ElevenLabs timed TTS HTTP error: status=%s", response.status_code)
            raise VoiceProviderError()

        try:
            data = response.json()
            audio = base64.b64decode(data["audio_base64"], validate=True)
            timings, duration = word_timings(words, data.get("alignment"))
        except VoiceProviderError:
            raise
        except (ValueError, KeyError, TypeError) as error:
            raise VoiceProviderError() from error
        if not audio:
            raise VoiceProviderError()

        result = TimedSpeech(
            audio=audio,
            content_type="audio/mpeg",
            duration_seconds=duration,
            words=tuple(timings),
        )
        _audio_cache.put(cache_key, result)
        return result
