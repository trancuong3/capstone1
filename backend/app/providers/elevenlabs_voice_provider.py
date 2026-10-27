"""Small server-side adapter for the ElevenLabs speech APIs.

The API key is deliberately read only on the server. Provider diagnostics and
response bodies are never passed back to application clients.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib import response
from urllib.parse import quote

import httpx
import logging

logger = logging.getLogger(__name__)

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
    words: list[dict[str, Any]] | None = None


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
        if not isinstance(language_code, str):
            language_code = None

        language_probability = payload.get("language_probability")
        if isinstance(language_probability, bool) or not isinstance(
            language_probability, (int, float)
        ):
            language_probability = None

        raw_words = payload.get("words")
        words = None

        if isinstance(raw_words, list):
            words = [
                {
                    "text": item["text"],
                    "start": item["start"],
                    "end": item["end"],
                }
                for item in raw_words
                if isinstance(item, dict)
                and item.get("type", "word") == "word"
                and isinstance(item.get("text"), str)
                and isinstance(item.get("start"), (int, float))
                and not isinstance(item.get("start"), bool)
                and isinstance(item.get("end"), (int, float))
                and not isinstance(item.get("end"), bool)
            ]

        return Transcription(
            text=payload["text"],
            language_code=language_code,
            language_probability=language_probability,
            words=words,
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
            logger.error(
                "ElevenLabs STT HTTP error: status=%s, body=%s",
                response.status_code,
                response.text[:1000],
            )
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
        form: dict[str, str] = {
            "model_id": "scribe_v2",
            "timestamps_granularity": "word",
        }
        if language_code:
            lang = "vie" if language_code.lower() in ("vi", "vie", "vi-vn") else language_code
            form["language_code"] = lang

        try:
            transport = httpx.AsyncHTTPTransport(
                local_address="0.0.0.0"
            )

            async with httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(90.0, connect=10.0)) as client:
                response = await client.post(
                    f"{ELEVENLABS_API_BASE_URL}/speech-to-text",
                    headers={**self._headers(), "Accept": "application/json"},
                    data=form,
                    files={"file": (filename, audio, content_type)},
                )
        except httpx.TimeoutException as error:
            logger.exception("ElevenLabs STT request timed out")
            raise VoiceProviderUnavailable() from error
        except httpx.HTTPError as error:
            raise VoiceProviderError() from error

        if response.status_code >= 400:
            logger.warning(
                "ElevenLabs STT HTTP error: status=%s, request_id=%s",
                response.status_code,
                response.headers.get("request-id"),
            )
        if response.status_code == 429 or response.status_code >= 500:
            raise VoiceProviderUnavailable()
        if response.is_error:
            logger.error(
                "ElevenLabs STT HTTP error: status=%s, body=%s",
                response.status_code,
                response.text[:1000],
            )
            raise VoiceProviderError()
        try:
            return self._transcription_from_payload(response.json())
        except ValueError as error:
            raise VoiceProviderError() from error

    async def probe_tts(self) -> tuple[str, str]:
        """
        Probe ElevenLabs TTS service health without spending character quota.
        Returns (status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE", safe_message: str).
        """
        if not self._api_key:
            logger.error("ElevenLabs API key is missing")
            logger.info(
                "ElevenLabs key loaded: %s, length=%d",
                bool(self._api_key),
                len(self._api_key),
            )
            return "UNAVAILABLE", "Chưa cấu hình ELEVENLABS_API_KEY trong hệ thống."
        voice_id = quote(self._voice_id(None), safe="")
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(4.0, connect=3.0)) as client:
                response = await client.get(
                    f"{ELEVENLABS_API_BASE_URL}/voices/{voice_id}",
                    headers=self._headers(),
                )
            if response.status_code == 200:
                voice_name = response.json().get("name", "Giọng đọc")
                return "HEALTHY", f"ElevenLabs TTS sẵn sàng (Giọng: {voice_name})."
            elif response.status_code in (401, 403):
                return "UNAVAILABLE", "Khóa API ElevenLabs không hợp lệ hoặc không có quyền truy cập."
            elif response.status_code == 429:
                return "DEGRADED", "ElevenLabs TTS bị giới hạn tần suất yêu cầu (Rate limit)."
            else:
                return "UNAVAILABLE", f"Máy chủ ElevenLabs TTS phản hồi mã lỗi {response.status_code}."
        except (httpx.TimeoutException, TimeoutError):
            return "UNAVAILABLE", "Hết thời gian chờ phản hồi từ máy chủ ElevenLabs TTS."
        except Exception:
            return "UNAVAILABLE", "Không thể kết nối tới dịch vụ ElevenLabs TTS."

    async def probe_stt(self) -> tuple[str, str]:
        """
        Probe ElevenLabs STT service health without spending quota.
        Returns (status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE", safe_message: str).
        """
        if not self._api_key:
            return "UNAVAILABLE", "Chưa cấu hình ELEVENLABS_API_KEY trong hệ thống."
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(4.0, connect=3.0)) as client:
                response = await client.get(
                    f"{ELEVENLABS_API_BASE_URL}/models",
                    headers=self._headers(),
                )
            if response.status_code == 200:
                models = response.json()
                has_scribe = any(m.get("model_id") == "scribe_v2" for m in models) if isinstance(models, list) else True
                model_label = "Scribe v2" if has_scribe else "Mặc định"
                return "HEALTHY", f"ElevenLabs STT sẵn sàng (Model: {model_label} tiếng Việt)."
            elif response.status_code in (401, 403):
                return "UNAVAILABLE", "Khóa API ElevenLabs không hợp lệ hoặc không có quyền truy cập."
            elif response.status_code == 429:
                return "DEGRADED", "ElevenLabs STT bị giới hạn tần suất yêu cầu (Rate limit)."
            else:
                return "UNAVAILABLE", f"Máy chủ ElevenLabs STT phản hồi mã lỗi {response.status_code}."
        except (httpx.TimeoutException, TimeoutError):
            return "UNAVAILABLE", "Hết thời gian chờ phản hồi từ máy chủ ElevenLabs STT."
        except Exception:
            return "UNAVAILABLE", "Không thể kết nối tới dịch vụ ElevenLabs STT."

