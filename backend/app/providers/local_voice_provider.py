"""Loopback HTTP adapter for the isolated Windows Local Voice Worker (`127.0.0.1:8010`)."""

from __future__ import annotations

import asyncio
import base64
import math
import os
from dataclasses import dataclass
from typing import Any

import httpx

from app.providers.elevenlabs_voice_provider import VoiceProviderError

DEFAULT_LOCAL_VOICE_WORKER_URL = "http://127.0.0.1:8010"
DEFAULT_LOCAL_VOICE_ID = "local_north_truc_ly"
LOCAL_TTS_MODEL_VERSION = "vieneu-v3-turbo-onnx-fp32-3.8.5"
LOCAL_STT_MODEL_VERSION = "sherpa-onnx-zipformer-vi-30m-int8-2026-02-09"

# Static non-secret metadata catalog of the 8 curated regional presets so UI can
# display Bắc · Trung · Nam options deterministically even before worker warmup.
STATIC_LOCAL_VOICES: tuple[dict[str, Any], ...] = (
    {
        "voice_id": "local_north_truc_ly",
        "name": "Cô Trúc Ly",
        "provider": "local",
        "region": "north",
        "region_label": "Miền Bắc",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "female",
        "accent": "Miền Bắc",
        "use_case": "reading_coach",
        "description": "Miền Bắc · Nữ · Tự nhiên, ấm áp",
        "preview_url": None,
        "is_default": True,
    },
    {
        "voice_id": "local_north_ngoc_linh",
        "name": "Cô Ngọc Linh",
        "provider": "local",
        "region": "north",
        "region_label": "Miền Bắc",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "female",
        "accent": "Miền Bắc",
        "use_case": "storytelling",
        "description": "Miền Bắc · Nữ · Kể chuyện dịu dàng",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "local_north_thien_minh",
        "name": "Thầy Thiện Minh",
        "provider": "local",
        "region": "north",
        "region_label": "Miền Bắc",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "male",
        "accent": "Miền Bắc",
        "use_case": "storytelling",
        "description": "Miền Bắc · Nam · Kể chuyện truyền cảm",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "local_central_ngoc_tran",
        "name": "Cô Ngọc Trân",
        "provider": "local",
        "region": "central",
        "region_label": "Miền Trung",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "female",
        "accent": "Miền Trung",
        "use_case": "reading_coach",
        "description": "Miền Trung · Nữ · Tự nhiên, dịu dàng",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "local_central_quang_son",
        "name": "Thầy Quang Sơn",
        "provider": "local",
        "region": "central",
        "region_label": "Miền Trung",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "male",
        "accent": "Miền Trung",
        "use_case": "reading_coach",
        "description": "Miền Trung · Nam · Tự nhiên, rõ chữ",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "local_south_thuc_doan",
        "name": "Cô Thục Đoan",
        "provider": "local",
        "region": "south",
        "region_label": "Miền Nam",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "female",
        "accent": "Miền Nam",
        "use_case": "storytelling",
        "description": "Miền Nam · Nữ · Kể chuyện ấm áp",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "local_south_my_duyen",
        "name": "Cô Mỹ Duyên",
        "provider": "local",
        "region": "south",
        "region_label": "Miền Nam",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "female",
        "accent": "Miền Nam",
        "use_case": "storytelling",
        "description": "Miền Nam · Nữ · Đọc truyện thiếu nhi",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "local_south_thai_son",
        "name": "Thầy Thái Sơn",
        "provider": "local",
        "region": "south",
        "region_label": "Miền Nam",
        "model_version": LOCAL_TTS_MODEL_VERSION,
        "category": "local_neural",
        "gender": "male",
        "accent": "Miền Nam",
        "use_case": "storytelling",
        "description": "Miền Nam · Nam · Kể chuyện rõ ràng",
        "preview_url": None,
        "is_default": False,
    },
)

KNOWN_LOCAL_VOICE_IDS = {v["voice_id"] for v in STATIC_LOCAL_VOICES}


@dataclass(frozen=True, slots=True)
class LocalSynthesizedAudio:
    content: bytes
    content_type: str
    resolved_voice_id: str
    region: str
    model_version: str
    provider: str = "local"
    used_fallback_voice: bool = False


@dataclass(frozen=True, slots=True)
class LocalTimedWord:
    index: int
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class LocalTimedSpeech:
    audio: bytes
    content_type: str
    duration_seconds: float
    words: list[LocalTimedWord]
    resolved_voice_id: str
    region: str
    model_version: str
    provider: str = "local"
    used_fallback_voice: bool = False


@dataclass(frozen=True, slots=True)
class LocalPhonicsStepTiming:
    id: str
    index: int
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class LocalPhonicsSpeech:
    audio: bytes
    content_type: str
    duration_seconds: float
    step_timings: list[LocalPhonicsStepTiming]
    resolved_voice_id: str
    region: str
    model_version: str
    provider: str = "local"


@dataclass(frozen=True, slots=True)
class LocalTranscription:
    text: str
    language_code: str | None
    language_probability: float | None
    words: list[dict[str, Any]] | None
    provider: str = "local"
    model_version: str = LOCAL_STT_MODEL_VERSION
    fallback_used: bool = False
    fallback_reason: str | None = None


class LocalVoiceTechnicalError(VoiceProviderError):
    """Raised when the local voice worker is unreachable, times out, or crashes."""


class LocalVoiceProvider:
    def __init__(self, base_url: str | None = None) -> None:
        raw_url = (
            base_url
            if base_url is not None
            else os.getenv(
                "VIREAD_LOCAL_VOICE_WORKER_URL", DEFAULT_LOCAL_VOICE_WORKER_URL
            )
        )
        self.base_url = raw_url.strip().rstrip("/") or DEFAULT_LOCAL_VOICE_WORKER_URL
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                trust_env=False,
                limits=httpx.Limits(
                    max_connections=24,
                    max_keepalive_connections=12,
                    keepalive_expiry=30.0,
                ),
            )
        return self._client

    async def _post_with_retry(
        self,
        path: str,
        *,
        timeout: float,
        json: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
    ) -> httpx.Response:
        url = f"{self.base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(2):
            client = self._get_client()
            try:
                resp = await client.post(
                    url,
                    timeout=timeout,
                    json=json,
                    data=data,
                    files=files,
                )
                if resp.status_code == 503 and attempt == 0:
                    await asyncio.sleep(0.35)
                    continue
                return resp
            except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError) as exc:
                last_exc = exc
                if attempt == 0:
                    await asyncio.sleep(0.35)
                    continue
                raise
        assert last_exc is not None
        raise last_exc

    async def get_health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
                resp = await client.get(f"{self.base_url}/health")
            if resp.status_code != 200:
                return {"available": False, "stt_ready": False, "tts_ready": False}
            data = resp.json()
            stt = data.get("stt") or {}
            tts = data.get("tts") or {}
            return {
                "available": data.get("status") == "ok",
                "stt_ready": bool(stt.get("ready")),
                "tts_ready": bool(tts.get("ready")),
                "stt_model_version": stt.get("model_version", LOCAL_STT_MODEL_VERSION),
                "tts_model_version": tts.get("model_version", LOCAL_TTS_MODEL_VERSION),
            }
        except Exception:
            return {"available": False, "stt_ready": False, "tts_ready": False}

    async def list_voices(self) -> tuple[list[dict[str, Any]], bool]:
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                resp = await client.get(f"{self.base_url}/voices")
            if resp.status_code == 200:
                payload = resp.json()
                model_ver = str(
                    payload.get("model_version") or LOCAL_TTS_MODEL_VERSION
                )
                raw_voices = payload.get("voices") or []
                mapped: list[dict[str, Any]] = []
                for item in raw_voices:
                    vid = str(item.get("voice_id") or "")
                    if not vid:
                        continue
                    region_label = str(item.get("region_label") or "Miền Bắc")
                    style_label = str(item.get("style_label") or "Tự nhiên")
                    gender = str(item.get("gender") or "female")
                    gender_vi = "Nữ" if gender == "female" else "Nam"
                    mapped.append(
                        {
                            "voice_id": vid,
                            "name": str(item.get("name") or vid),
                            "provider": "local",
                            "region": str(item.get("region") or "north"),
                            "region_label": region_label,
                            "model_version": model_ver,
                            "category": "local_neural",
                            "gender": gender,
                            "accent": region_label,
                            "use_case": "reading_coach",
                            "description": f"{region_label} · {gender_vi} · {style_label}",
                            "preview_url": None,
                            "is_default": bool(item.get("is_default")),
                        }
                    )
                if mapped:
                    return mapped, True
        except Exception:
            pass
        return [dict(v) for v in STATIC_LOCAL_VOICES], False

    @staticmethod
    def _resolve_target_voice_id(voice_id: str | None) -> tuple[str, bool]:
        """Resolve requested voice ID, gracefully migrating stale legacy (e.g. ElevenLabs) IDs."""
        known_ids = {str(item["voice_id"]) for item in STATIC_LOCAL_VOICES}
        cleaned = (voice_id or "").strip()
        if not cleaned:
            return DEFAULT_LOCAL_VOICE_ID, False
        if cleaned in known_ids:
            return cleaned, False
        if not cleaned.startswith("local_") and not cleaned.startswith("google_"):
            return DEFAULT_LOCAL_VOICE_ID, True
        return cleaned, False

    async def synthesize(
        self,
        *,
        text: str,
        voice_id: str | None = None,
        speed: float = 1.0,
        word_sample: bool = False,
    ) -> LocalSynthesizedAudio:
        target_voice, migrated_legacy = self._resolve_target_voice_id(voice_id)
        try:
            resp = await self._post_with_retry(
                "/tts",
                timeout=45.0,
                json={
                    "text": text,
                    "voice_id": target_voice,
                    "speed": speed,
                    "word_sample": word_sample,
                },
            )
        except httpx.TimeoutException as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_TIMEOUT"
            ) from exc
        except httpx.HTTPError as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            ) from exc

        if resp.status_code == 404:
            raise VoiceProviderError(status_code=404, code="VOICE_NOT_FOUND")
        if resp.status_code == 422:
            raise VoiceProviderError(status_code=422, code="TTS_INVALID_TEXT")
        if resp.status_code == 503:
            raise LocalVoiceTechnicalError(status_code=503, code="LOCAL_TTS_BUSY")
        if resp.status_code >= 400 or not resp.content:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )

        return LocalSynthesizedAudio(
            content=resp.content,
            content_type=resp.headers.get("content-type", "audio/wav").split(";")[0],
            resolved_voice_id=resp.headers.get("x-resolved-voice-id", target_voice),
            region=resp.headers.get("x-voice-region", "north"),
            model_version=resp.headers.get(
                "x-voice-model-version", LOCAL_TTS_MODEL_VERSION
            ),
            used_fallback_voice=migrated_legacy,
        )

    async def synthesize_timed(
        self,
        *,
        words: list[str],
        voice_id: str | None = None,
        speed: float = 1.0,
    ) -> LocalTimedSpeech:
        target_voice, _ = self._resolve_target_voice_id(voice_id)
        passage_text = " ".join(words)
        try:
            resp = await self._post_with_retry(
                "/tts/timed",
                timeout=60.0,
                json={
                    "text": passage_text,
                    "voice_id": target_voice,
                    "speed": speed,
                    "word_sample": False,
                },
            )
        except httpx.TimeoutException as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_TIMEOUT"
            ) from exc
        except httpx.HTTPError as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            ) from exc

        if resp.status_code == 404:
            raise VoiceProviderError(status_code=404, code="VOICE_NOT_FOUND")
        if resp.status_code >= 400:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )

        payload = resp.json()
        audio = base64.b64decode(payload.get("audio_base64") or "")
        duration = float(payload.get("duration_seconds") or 0.0)
        raw_words = payload.get("words") or []
        if not audio or duration <= 0 or len(raw_words) != len(words):
            raise LocalVoiceTechnicalError(
                status_code=502, code="LOCAL_TTS_ALIGNMENT_INVALID"
            )

        timed_words: list[LocalTimedWord] = []
        prev_end = 0.0
        for idx, item in enumerate(raw_words):
            start = float(item.get("start", 0.0))
            end = float(item.get("end", start))
            if (
                not (math.isfinite(start) and math.isfinite(end))
                or start < 0
                or end < start
            ):
                raise LocalVoiceTechnicalError(
                    status_code=502, code="LOCAL_TTS_ALIGNMENT_INVALID"
                )
            start_r = round(max(prev_end, min(duration, start)), 3)
            end_r = round(max(start_r, min(duration, end)), 3)
            timed_words.append(
                LocalTimedWord(index=idx, start=start_r, end=end_r)
            )
            prev_end = end_r

        return LocalTimedSpeech(
            audio=audio,
            content_type=str(payload.get("media_type") or "audio/wav"),
            duration_seconds=round(duration, 3),
            words=timed_words,
            resolved_voice_id=str(payload.get("voice_id") or target_voice),
            region=str(payload.get("region") or "north"),
            model_version=str(
                payload.get("model_version") or LOCAL_TTS_MODEL_VERSION
            ),
        )

    async def synthesize_phonics(
        self,
        *,
        steps: list[dict[str, Any]],
        voice_id: str | None = None,
        speed: float = 1.0,
    ) -> LocalPhonicsSpeech:
        target_voice, _ = self._resolve_target_voice_id(voice_id)
        try:
            resp = await self._post_with_retry(
                "/tts/phonics",
                timeout=45.0,
                json={
                    "steps": steps,
                    "voice_id": target_voice,
                    "speed": speed,
                },
            )
        except httpx.TimeoutException as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_TIMEOUT"
            ) from exc
        except httpx.HTTPError as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            ) from exc

        if resp.status_code == 404:
            raise VoiceProviderError(status_code=404, code="VOICE_NOT_FOUND")
        if resp.status_code >= 400:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )

        payload = resp.json()
        audio = base64.b64decode(payload.get("audio_base64") or "")
        duration = float(payload.get("duration_seconds") or 0.0)
        raw_timings = payload.get("step_timings") or []
        if not audio or duration <= 0 or len(raw_timings) != len(steps):
            raise LocalVoiceTechnicalError(
                status_code=502, code="LOCAL_PHONICS_ALIGNMENT_INVALID"
            )

        timings: list[LocalPhonicsStepTiming] = []
        prev_start = 0.0
        for idx, item in enumerate(raw_timings):
            start = max(prev_start, min(duration, float(item.get("start", 0.0))))
            end = max(start, min(duration, float(item.get("end", start))))
            timings.append(
                LocalPhonicsStepTiming(
                    id=str(item.get("id") or steps[idx]["id"]),
                    index=idx,
                    start=round(start, 3),
                    end=round(end, 3),
                )
            )
            prev_start = start

        return LocalPhonicsSpeech(
            audio=audio,
            content_type=str(payload.get("media_type") or "audio/wav"),
            duration_seconds=round(duration, 3),
            step_timings=timings,
            resolved_voice_id=str(payload.get("voice_id") or target_voice),
            region=str(payload.get("region") or "north"),
            model_version=str(
                payload.get("model_version") or LOCAL_TTS_MODEL_VERSION
            ),
        )

    async def transcribe(
        self,
        *,
        audio: bytes,
        filename: str,
        content_type: str,
        language_code: str | None = "vi",
    ) -> LocalTranscription:
        try:
            resp = await self._post_with_retry(
                "/stt",
                timeout=20.0,
                data={"language": (language_code or "vi").strip() or "vi"},
                files={"audio_file": (filename, audio, content_type)},
            )
        except httpx.TimeoutException as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_STT_TIMEOUT"
            ) from exc
        except httpx.HTTPError as exc:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_STT_UNAVAILABLE"
            ) from exc

        if resp.status_code == 413:
            raise VoiceProviderError(status_code=413, code="AUDIO_TOO_LARGE")
        if resp.status_code == 422:
            raise VoiceProviderError(status_code=422, code="INVALID_AUDIO")
        if resp.status_code == 503:
            raise LocalVoiceTechnicalError(status_code=503, code="LOCAL_STT_BUSY")
        if resp.status_code >= 400:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_STT_UNAVAILABLE"
            )

        payload = resp.json()
        raw_words = payload.get("words") or []
        safe_words: list[dict[str, Any]] = []
        for item in raw_words:
            if not isinstance(item, dict):
                continue
            txt = str(item.get("text") or "").strip()
            start = item.get("start")
            end = item.get("end")
            if (
                txt
                and isinstance(start, (int, float))
                and isinstance(end, (int, float))
                and start >= 0
                and end >= start
            ):
                safe_words.append(
                    {
                        "text": txt,
                        "start": float(start),
                        "end": float(end),
                        "logprob": None,
                    }
                )

        return LocalTranscription(
            text=str(payload.get("text") or "").strip(),
            language_code=str(payload.get("language_code") or "vi"),
            language_probability=None,
            words=safe_words or None,
            provider="local",
            model_version=str(
                payload.get("model_version") or LOCAL_STT_MODEL_VERSION
            ),
            fallback_used=False,
        )
