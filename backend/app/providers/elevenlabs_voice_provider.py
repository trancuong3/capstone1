"""Small server-side adapter for the ElevenLabs speech APIs.

The API key is deliberately read only on the server. Provider diagnostics and
response bodies are never passed back to application clients.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1"
# Public voice used in the current ElevenLabs API reference. Deployments should
# set ELEVENLABS_VOICE_ID to choose the product's intended voice.
DEFAULT_VOICE_ID = "cgSgspJ2msm6clMCkdW9"
DEFAULT_MODEL_ID = "eleven_flash_v2_5"


class VoiceProviderError(Exception):
    """A provider failure represented by a safe application code and HTTP status."""

    def __init__(
        self,
        status_code: int = 502,
        code: str = "SPEECH_UNAVAILABLE",
    ):
        self.status_code = status_code
        self.code = code
        super().__init__("Voice provider request failed")


class VoiceProviderUnavailable(VoiceProviderError):
    def __init__(self):
        super().__init__(status_code=503, code="SPEECH_UNAVAILABLE")


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
        configured_key = (
            api_key if api_key is not None else os.getenv("ELEVENLABS_API_KEY", "")
        )
        self._api_key = configured_key.strip()
        self._key_fingerprint = (
            hashlib.sha256(self._api_key.encode("utf-8")).hexdigest()[:12]
            if self._api_key
            else None
        )
        # A one-way fingerprint lets operators compare which key the running
        # process loaded without ever logging or exposing the key itself.
        logger.info(
            "ElevenLabs configuration loaded: key_configured=%s key_fingerprint=%s",
            bool(self._api_key),
            self._key_fingerprint or "unavailable",
        )

    @staticmethod
    def _safe_provider_message(value: Any, api_key: str) -> str | None:
        if not isinstance(value, str) or not value.strip():
            return None
        message = value
        if api_key:
            message = message.replace(api_key, "[REDACTED]")
        message = re.sub(
            r"(?i)(xi-api-key|authorization|api[_ -]?key)\s*[:=]\s*[^,;\s]+",
            r"\1=[REDACTED]",
            message,
        )
        message = re.sub(
            r"(?i)bearer\s+[A-Za-z0-9._~+/-]+",
            "Bearer [REDACTED]",
            message,
        )
        return " ".join(message.split())[:400]

    @staticmethod
    def _provider_error_fields(
        payload: Any,
    ) -> tuple[str | None, str | None, str | None]:
        if not isinstance(payload, dict):
            return None, None, None

        detail = payload.get("detail", payload.get("error", payload))
        if isinstance(detail, list):
            first = detail[0] if detail else None
            detail = first if isinstance(first, dict) else None
        if isinstance(detail, dict):
            code = detail.get("code") or detail.get("type")
            status = detail.get("status")
            message = detail.get("message") or detail.get("msg")
        else:
            code = payload.get("code")
            status = payload.get("status")
            message = detail if isinstance(detail, str) else payload.get("message")

        return (
            code.strip() if isinstance(code, str) and code.strip() else None,
            status.strip() if isinstance(status, str) and status.strip() else None,
            message if isinstance(message, str) else None,
        )

    @staticmethod
    def _provider_request_id(payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return None
        detail = payload.get("detail", payload.get("error", payload))
        if isinstance(detail, list):
            detail = detail[0] if detail and isinstance(detail[0], dict) else None
        candidate = (
            detail.get("request_id")
            if isinstance(detail, dict)
            else payload.get("request_id")
        )
        if isinstance(candidate, str) and re.fullmatch(
            r"[A-Za-z0-9_.:-]{1,128}", candidate
        ):
            return candidate
        return None

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
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0)
            ) as client:
                response = await client.post(
                    f"{ELEVENLABS_API_BASE_URL}/text-to-speech/{voice_id}",
                    headers={**self._headers(), "Accept": "audio/mpeg"},
                    params={"output_format": "mp3_44100_128"},
                    json=payload,
                )
        except httpx.TimeoutException as error:
            raise VoiceProviderUnavailable() from error
        except httpx.HTTPError as error:
            logger.exception("ElevenLabs TTS network/HTTP client error")
            raise VoiceProviderError() from error

        if response.status_code == 429 or response.status_code >= 500:
            logger.warning(
                "ElevenLabs TTS HTTP error: status=%s, request_id=%s, body=%s",
                response.status_code,
                response.headers.get("request-id", "unavailable"),
                response.text[:1000] if response.status_code >= 400 else "",
            )
            raise VoiceProviderUnavailable()
        if response.is_error:
            logger.error(
                "ElevenLabs TTS HTTP error: status=%s, request_id=%s, body=%s",
                response.status_code,
                response.headers.get("request-id", "unavailable"),
                response.text[:1000],
            )
            raise VoiceProviderError()

        content_type = response.headers.get("content-type", "audio/mpeg").split(";", 1)[0]
        if not content_type.startswith("audio/") or not response.content:
            logger.warning(
                "ElevenLabs TTS returned unexpected response: content_type=%s, bytes=%d",
                content_type,
                len(response.content),
            )
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
            lang = (
                "vie"
                if language_code.lower() in ("vi", "vie", "vi-vn")
                else language_code
            )
            form["language_code"] = lang

        if not audio:
            logger.warning("STT request rejected: audio is empty")
            raise VoiceProviderError(status_code=422, code="STT_INVALID_AUDIO")
        if not self._api_key:
            logger.warning("STT request rejected: ElevenLabs API key is not configured")
            raise VoiceProviderError(status_code=503, code="STT_AUTH_FAILED")

        logger.info(
            "STT request started: filename=%s, content_type=%s, audio_bytes=%d, "
            "language=%s, model=%s",
            filename,
            content_type,
            len(audio),
            form.get("language_code", "auto"),
            form["model_id"],
        )

        try:
            timeout = httpx.Timeout(90.0, connect=10.0)
            # Use HTTPX's default network configuration to avoid forcing a local address.
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = None
                # Retry only explicit provider 5xx responses once. Do not retry
                # quota, authentication, permission, rate-limit or ambiguous
                # timeout failures because a completed STT request may consume usage.
                for attempt in range(2):
                    response = await client.post(
                        f"{ELEVENLABS_API_BASE_URL}/speech-to-text",
                        headers={**self._headers(), "Accept": "application/json"},
                        data=form,
                        files={"file": (filename, audio, content_type)},
                    )
                    if response.status_code < 500 or attempt == 1:
                        break

                    try:
                        retry_payload = response.json()
                    except ValueError:
                        retry_payload = None
                    retry_code, retry_status, retry_message = (
                        self._provider_error_fields(retry_payload)
                    )
                    retry_classification = " ".join(
                        value or ""
                        for value in (retry_code, retry_status, retry_message)
                    ).lower()
                    definitive_failure = any(
                        marker in retry_classification
                        for marker in (
                            "quota",
                            "credit",
                            "subscription_limit",
                            "usage_limit",
                            "invalid_api_key",
                            "authentication",
                            "permission",
                            "authoriz",
                            "model_access_denied",
                            "feature_not_available",
                            "forbidden",
                            "terms",
                            "rate_limit",
                            "concurr",
                            "invalid_audio",
                            "unsupported_audio",
                        )
                    )
                    if definitive_failure:
                        break
                    await asyncio.sleep(0.25 * (2**attempt))
        except httpx.TimeoutException as error:
            logger.warning(
                "ElevenLabs STT request timed out: error_type=%s request_id=unavailable",
                type(error).__name__,
            )
            raise VoiceProviderError(
                status_code=503,
                code="STT_TIMEOUT",
            ) from None
        except httpx.HTTPError as error:
            logger.warning(
                "ElevenLabs STT network failure: error_type=%s request_id=unavailable",
                type(error).__name__,
            )
            raise VoiceProviderError(
                status_code=503,
                code="STT_NETWORK_ERROR",
            ) from None

        if response.is_error:
            try:
                error_payload = response.json()
            except ValueError:
                error_payload = None

            provider_code, provider_status, raw_message = (
                self._provider_error_fields(error_payload)
            )

            provider_message = self._safe_provider_message(
                raw_message,
                self._api_key,
            )

            provider_request_id = self._provider_request_id(error_payload)

            request_id = (
                response.headers.get("request-id")
                or response.headers.get("x-request-id")
                or provider_request_id
                or "unavailable"
            )

            classification = " ".join(
                value or ""
                for value in (
                    provider_code,
                    provider_status,
                    provider_message,
                )
            ).lower()

            logger.warning(
                "ElevenLabs STT provider error: operation=speech_to_text "
                "endpoint=/v1/speech-to-text http_status=%s provider_code=%s "
                "provider_status=%s request_id=%s message=%s key_configured=%s "
                "key_fingerprint=%s",
                response.status_code,
                provider_code or "unavailable",
                provider_status or "unavailable",
                request_id,
                provider_message or "unavailable",
                bool(self._api_key),
                self._key_fingerprint or "unavailable",
            )

            # 1. Quota / credit exhausted
            if response.status_code == 402 or any(
                marker in classification
                for marker in (
                    "quota_exceeded",
                    "insufficient_credits",
                    "credit_limit",
                    "usage_limit",
                )
            ):
                raise VoiceProviderError(
                    status_code=503,
                    code="STT_QUOTA_EXCEEDED",
                )

            # 2. Terms not accepted
            if any(
                marker in classification
                for marker in (
                    "unaccepted_terms",
                    "terms_not_accepted",
                    "terms_of_service",
                    "accept_terms",
                )
            ):
                raise VoiceProviderError(
                    status_code=503,
                    code="STT_TERMS_NOT_ACCEPTED",
                )

            # 3. Concurrent request limit
            if any(
                marker in classification
                for marker in (
                    "concurrent_limit",
                    "concurrency",
                    "simultaneous_request",
                    "too_many_active",
                )
            ):
                raise VoiceProviderError(
                    status_code=503,
                    code="STT_CONCURRENCY_LIMITED",
                )

            # 4. Permission / model access denied
            if any(
                marker in classification
                for marker in (
                    "permission_denied",
                    "insufficient_permissions",
                    "authorization_error",
                    "model_access_denied",
                    "feature_not_available",
                    "forbidden",
                )
            ):
                raise VoiceProviderError(
                    status_code=503,
                    code="STT_PERMISSION_DENIED",
                )

            # 5. Authentication failure
            if response.status_code == 401 or any(
                marker in classification
                for marker in (
                    "invalid_api_key",
                    "authentication_failed",
                    "authentication_error",
                    "invalid_credentials",
                    "unauthorized",
                )
            ):
                raise VoiceProviderError(
                    status_code=503,
                    code="STT_AUTH_FAILED",
                )

            # 6. Invalid audio
            if response.status_code in (400, 422) or any(
                marker in classification
                for marker in (
                    "invalid_audio",
                    "unsupported_audio",
                    "audio_too_short",
                    "input_error",
                    "invalid_parameters",
                    "validation_error",
                )
            ):
                raise VoiceProviderError(
                    status_code=422,
                    code="STT_INVALID_AUDIO",
                )

            # 7. Rate limit
            if response.status_code == 429 or "rate_limit" in classification:
                raise VoiceProviderError(
                    status_code=503,
                    code="STT_RATE_LIMITED",
                )

            # 8. Temporary provider failure
            if response.status_code >= 500 or any(
                marker in classification
                for marker in (
                    "system_busy",
                    "resource_exhausted",
                    "queue_overflow",
                    "internal_error",
                    "service_unavailable",
                    "maintenance",
                )
            ):
                raise VoiceProviderError(
                    status_code=503,
                    code="STT_TEMPORARILY_UNAVAILABLE",
                )

            raise VoiceProviderError(
                status_code=502,
                code="STT_PROVIDER_REJECTED",
            )
        try:
            payload = response.json()
        except ValueError as error:
            logger.warning(
                "ElevenLabs STT returned invalid JSON: status=%s, content_type=%s",
                response.status_code,
                response.headers.get("content-type", "unknown"),
            )
            raise VoiceProviderError() from error

        try:
            result = self._transcription_from_payload(payload)
        except VoiceProviderError:
            logger.warning(
                "ElevenLabs STT response has an invalid payload: status=%s",
                response.status_code,
            )
            raise

        logger.info(
            "STT request succeeded: status=%s, text_chars=%d, word_timestamps=%d",
            response.status_code,
            len(result.text),
            len(result.words or []),
        )
        return result

    async def probe_tts(self) -> tuple[str, str]:
        """Probe ElevenLabs TTS health without spending character quota."""
        if not self._api_key:
            logger.error("ElevenLabs API key is missing")
            return "UNAVAILABLE", "Chưa cấu hình ELEVENLABS_API_KEY trong hệ thống."

        voice_id = quote(self._voice_id(None), safe="")
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(4.0, connect=3.0)
            ) as client:
                response = await client.get(
                    f"{ELEVENLABS_API_BASE_URL}/voices/{voice_id}",
                    headers=self._headers(),
                )
            if response.status_code == 200:
                voice_name = response.json().get("name", "Giọng đọc")
                return "HEALTHY", f"ElevenLabs TTS sẵn sàng (Giọng: {voice_name})."
            if response.status_code in (401, 403):
                return "UNAVAILABLE", "Khóa API ElevenLabs không hợp lệ hoặc không có quyền truy cập."
            if response.status_code == 429:
                return "DEGRADED", "ElevenLabs TTS bị giới hạn tần suất yêu cầu (Rate limit)."
            return "UNAVAILABLE", f"Máy chủ ElevenLabs TTS phản hồi mã lỗi {response.status_code}."
        except (httpx.TimeoutException, TimeoutError):
            return "UNAVAILABLE", "Hết thời gian chờ phản hồi từ máy chủ ElevenLabs TTS."
        except Exception:
            logger.exception("ElevenLabs TTS health probe failed")
            return "UNAVAILABLE", "Không thể kết nối tới dịch vụ ElevenLabs TTS."

    async def probe_stt(self) -> tuple[str, str]:
        """Probe ElevenLabs STT health without spending quota."""
        if not self._api_key:
            return "UNAVAILABLE", "Chưa cấu hình ELEVENLABS_API_KEY trong hệ thống."
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(4.0, connect=3.0)
            ) as client:
                response = await client.get(
                    f"{ELEVENLABS_API_BASE_URL}/models",
                    headers=self._headers(),
                )
            if response.status_code == 200:
                models = response.json()
                has_scribe = (
                    any(m.get("model_id") == "scribe_v2" for m in models)
                    if isinstance(models, list)
                    else True
                )
                model_label = "Scribe v2" if has_scribe else "Mặc định"
                return "HEALTHY", f"ElevenLabs STT sẵn sàng (Model: {model_label} tiếng Việt)."
            if response.status_code in (401, 403):
                return "UNAVAILABLE", "Khóa API ElevenLabs không hợp lệ hoặc không có quyền truy cập."
            if response.status_code == 429:
                return "DEGRADED", "ElevenLabs STT bị giới hạn tần suất yêu cầu (Rate limit)."
            return "UNAVAILABLE", f"Máy chủ ElevenLabs STT phản hồi mã lỗi {response.status_code}."
        except (httpx.TimeoutException, TimeoutError):
            return "UNAVAILABLE", "Hết thời gian chờ phản hồi từ máy chủ ElevenLabs STT."
        except Exception:
            logger.exception("ElevenLabs STT health probe failed")
            return "UNAVAILABLE", "Không thể kết nối tới dịch vụ ElevenLabs STT."
