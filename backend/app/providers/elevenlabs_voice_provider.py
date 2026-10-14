"""Small server-side adapter for the ElevenLabs speech APIs.

The API key is deliberately read only on the server. Provider diagnostics and
response bodies are never passed back to application clients.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx


ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1"
# Public voice used in the current ElevenLabs API reference. Deployments should
# set ELEVENLABS_VOICE_ID to choose the product's intended voice.
DEFAULT_VOICE_ID = "cgSgspJ2msm6clMCkdW9"
DEFAULT_MODEL_ID = "eleven_flash_v2_5"


class VoiceProviderError(Exception):
    """A provider failure that can be exposed only as a safe HTTP status."""

    def __init__(self, status_code: int = 502):
        self.status_code = status_code
        super().__init__("Voice provider request failed")


class VoiceProviderUnavailable(VoiceProviderError):
    def __init__(self):
        super().__init__(status_code=503)


@dataclass(frozen=True)
class SynthesizedAudio:
    content: bytes
    content_type: str


@dataclass(frozen=True)
class Transcription:
    text: str
    language_code: str | None
    language_probability: float | None


class ElevenLabsVoiceProvider:
    """HTTPX implementation for TTS and file-based STT.

    Audio is retained only in request memory long enough to send it to the
    provider; this adapter neither writes recordings nor responses to disk.
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or os.getenv("ELEVENLABS_API_KEY", "").strip()

    def _headers(self) -> dict[str, str]:
        if not self._api_key:
            raise VoiceProviderUnavailable()
        return {"xi-api-key": self._api_key}

    @staticmethod
    def _voice_id(requested_voice_id: str | None) -> str:
        return (
            requested_voice_id
            or os.getenv("ELEVENLABS_VOICE_ID", "").strip()
            or DEFAULT_VOICE_ID
        )

    @staticmethod
    def _transcription_from_payload(payload: Any) -> Transcription:
        if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
            raise VoiceProviderError()

        language_code = payload.get("language_code")
        if language_code is not None and not isinstance(language_code, str):
            language_code = None

        language_probability = payload.get("language_probability")
        if isinstance(language_probability, bool) or not isinstance(
            language_probability, (int, float)
        ):
            language_probability = None

        return Transcription(
            text=payload["text"],
            language_code=language_code,
            language_probability=language_probability,
        )

    async def synthesize(
        self,
        *,
        text: str,
        requested_voice_id: str | None = None,
    ) -> SynthesizedAudio:
        voice_id = quote(self._voice_id(requested_voice_id), safe="")
        model_id = os.getenv("ELEVENLABS_MODEL_ID", "").strip() or DEFAULT_MODEL_ID
        payload: dict[str, Any] = {
            "text": text,
            "model_id": model_id,
        }
        if "flash" in model_id or "turbo" in model_id:
            payload["language_code"] = "vi"
        payload["voice_settings"] = {
            "stability": 0.6,
            "similarity_boost": 0.8,
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
                response = await client.post(
                    f"{ELEVENLABS_API_BASE_URL}/text-to-speech/{voice_id}",
                    headers={**self._headers(), "Accept": "audio/mpeg"},
                    params={"output_format": "mp3_44100_128"},
                    json=payload,
                )
        except httpx.TimeoutException as error:
            raise VoiceProviderUnavailable() from error
        except httpx.HTTPError as error:
            raise VoiceProviderError() from error

        if response.status_code == 429 or response.status_code >= 500:
            raise VoiceProviderUnavailable()
        if response.is_error:
            raise VoiceProviderError()

        content_type = response.headers.get("content-type", "audio/mpeg").split(";", 1)[0]
        if not content_type.startswith("audio/") or not response.content:
            raise VoiceProviderError()
        return SynthesizedAudio(content=response.content, content_type=content_type)

    async def transcribe(
        self,
        *,
        audio: bytes,
        filename: str,
        content_type: str,
        language_code: str | None = None,
    ) -> Transcription:
        form: dict[str, str] = {"model_id": "scribe_v2"}
        if language_code:
            lang = "vie" if language_code.lower() in ("vi", "vie", "vi-vn") else language_code
            form["language_code"] = lang

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0)) as client:
                response = await client.post(
                    f"{ELEVENLABS_API_BASE_URL}/speech-to-text",
                    headers={**self._headers(), "Accept": "application/json"},
                    data=form,
                    files={"file": (filename, audio, content_type)},
                )
        except httpx.TimeoutException as error:
            raise VoiceProviderUnavailable() from error
        except httpx.HTTPError as error:
            raise VoiceProviderError() from error

        if response.status_code == 429 or response.status_code >= 500:
            raise VoiceProviderUnavailable()
        if response.is_error:
            raise VoiceProviderError()
        try:
            return self._transcription_from_payload(response.json())
        except ValueError as error:
            raise VoiceProviderError() from error
