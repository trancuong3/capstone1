"""Loopback HTTP adapter for the isolated Windows Local Voice Worker (`127.0.0.1:8010`)."""

from __future__ import annotations

import asyncio
import base64
import math
import os
import struct
from dataclasses import dataclass
from typing import Any

import httpx

from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.services.local_voice_worker_bootstrap import (
    ensure_local_voice_worker_running,
    is_local_voice_worker_autostart_armed,
)

DEFAULT_LOCAL_VOICE_WORKER_URL = "http://127.0.0.1:8010"
DEFAULT_LOCAL_VOICE_ID = "local_north_truc_ly"
DEFAULT_LOCAL_TTS_PRECISION = "hybrid"
DEFAULT_LOCAL_STT_MODE = "ws"
LOCAL_STT_MODEL_VERSION = "sherpa-onnx-zipformer-vi-30m-int8-2026-02-09"


def resolve_local_tts_precision() -> str:
    raw = (os.getenv("VIREAD_VOICE_TTS_PRECISION") or DEFAULT_LOCAL_TTS_PRECISION).strip().lower()
    return raw if raw in ("hybrid", "fp32", "int8") else DEFAULT_LOCAL_TTS_PRECISION


def resolve_local_stt_mode() -> str:
    raw = (os.getenv("VIREAD_STT_MODE") or DEFAULT_LOCAL_STT_MODE).strip().lower()
    return raw if raw in ("ws", "http") else DEFAULT_LOCAL_STT_MODE


def build_local_tts_model_version(precision: str | None = None) -> str:
    prec = (precision or resolve_local_tts_precision()).strip().lower()
    if prec not in ("hybrid", "fp32", "int8"):
        prec = DEFAULT_LOCAL_TTS_PRECISION
    return f"vieneu-v3-turbo-onnx-{prec}-3.8.5"


LOCAL_TTS_PRECISION = resolve_local_tts_precision()
LOCAL_STT_MODE = resolve_local_stt_mode()
LOCAL_TTS_MODEL_VERSION = build_local_tts_model_version(LOCAL_TTS_PRECISION)

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
    used_fallback_voice: bool = False


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


def fix_wav_header_sizes(content: bytes) -> bytes:
    """Rewrite streaming/placeholder RIFF & data chunk sizes to exact byte counts."""
    if (
        len(content) < 44
        or content[:4] != b"RIFF"
        or content[8:12] != b"WAVE"
        or content[36:40] != b"data"
    ):
        return content
    actual_riff = len(content) - 8
    actual_data = len(content) - 44
    cur_riff = struct.unpack_from("<I", content, 4)[0]
    cur_data = struct.unpack_from("<I", content, 40)[0]
    if cur_riff == actual_riff and cur_data == actual_data:
        return content
    patched = bytearray(content)
    struct.pack_into("<I", patched, 4, actual_riff)
    struct.pack_into("<I", patched, 40, actual_data)
    return bytes(patched)


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
        self._worker_token = (
            os.getenv("VIREAD_LOCAL_VOICE_WORKER_TOKEN") or ""
        ).strip()
        self._client: httpx.AsyncClient | None = None
        self._client_loop: asyncio.AbstractEventLoop | None = None
        self._recovery_task: asyncio.Task[bool] | None = None

    def _schedule_background_recovery(self) -> asyncio.Task[bool] | None:
        if not is_local_voice_worker_autostart_armed():
            return None
        if self._recovery_task is not None and not self._recovery_task.done():
            return self._recovery_task
        try:
            task = asyncio.create_task(
                ensure_local_voice_worker_running(base_url=self.base_url)
            )
        except RuntimeError:
            return None
        self._recovery_task = task

        def _on_done(done_task: asyncio.Task[bool]) -> None:
            if self._recovery_task is done_task:
                self._recovery_task = None
            if not done_task.cancelled():
                try:
                    done_task.exception()
                except Exception:
                    pass

        task.add_done_callback(_on_done)
        return task

    async def _trigger_bounded_recovery(self) -> bool:
        """Kick off background worker autostart and fail fast if boot takes longer than a brief grace window."""
        task = self._schedule_background_recovery()
        if task is None:
            return False
        raw_wait = os.getenv("VIREAD_LOCAL_VOICE_INLINE_RECOVERY_WAIT_SECONDS", "0.5")
        try:
            wait_seconds = max(0.05, min(2.5, float(raw_wait)))
        except ValueError:
            wait_seconds = 0.5
        try:
            return bool(await asyncio.wait_for(asyncio.shield(task), timeout=wait_seconds))
        except (TimeoutError, asyncio.TimeoutError):
            # Keep background recovery running without blocking this HTTP request for 30-95s.
            return False
        except Exception:
            return False

    async def _is_incompatible_auth_worker(self) -> bool:
        if self._worker_token:
            return False
        try:
            async with httpx.AsyncClient(timeout=1.5, trust_env=False) as client:
                resp = await client.get(f"{self.base_url}/health")
            if resp.status_code in (401, 403):
                return True
            if resp.status_code == 200:
                payload = resp.json()
                if isinstance(payload, dict) and bool(payload.get("auth_required")):
                    return True
        except Exception:
            pass
        return False

    def _auth_headers(self) -> dict[str, str]:
        if not self._worker_token:
            return {}
        return {
            "Authorization": f"Bearer {self._worker_token}",
            "X-ViRead-Worker-Token": self._worker_token,
        }

    def get_ws_stt_url(self) -> str:
        """Build the loopback worker WebSocket URL for streaming STT."""
        if self.base_url.startswith("https://"):
            ws_base = "wss://" + self.base_url[len("https://") :]
        elif self.base_url.startswith("http://"):
            ws_base = "ws://" + self.base_url[len("http://") :]
        else:
            ws_base = self.base_url
        return f"{ws_base.rstrip('/')}/stt/stream"

    def get_ws_auth_headers(self) -> dict[str, str]:
        """Return loopback worker authentication headers for WebSocket handshake."""
        return self._auth_headers()

    def _get_client(self) -> httpx.AsyncClient:
        running_loop: asyncio.AbstractEventLoop | None = None
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None

        stale_loop = (
            isinstance(self._client, httpx.AsyncClient)
            and self._client_loop is not None
            and (
                self._client_loop.is_closed()
                or (running_loop is not None and self._client_loop is not running_loop)
            )
        )
        if self._client is None or self._client.is_closed or stale_loop:
            self._client = httpx.AsyncClient(
                trust_env=False,
                limits=httpx.Limits(
                    max_connections=24,
                    max_keepalive_connections=12,
                    keepalive_expiry=30.0,
                ),
            )
            self._client_loop = running_loop
        return self._client

    async def _reset_client(self) -> None:
        client = self._client
        client_loop = self._client_loop
        if client is None:
            return
        aclose = getattr(client, "aclose", None)
        if callable(aclose):
            self._client = None
            self._client_loop = None
            if not getattr(client, "is_closed", False):
                same_open_loop = True
                if client_loop is not None:
                    try:
                        same_open_loop = (
                            not client_loop.is_closed()
                            and client_loop is asyncio.get_running_loop()
                        )
                    except RuntimeError:
                        same_open_loop = False
                if same_open_loop:
                    try:
                        await aclose()
                    except Exception:
                        pass

    async def aclose(self) -> None:
        """Close the pooled HTTP client and cancel any in-flight recovery task."""
        task = self._recovery_task
        self._recovery_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                if task.get_loop() is asyncio.get_running_loop():
                    await asyncio.gather(task, return_exceptions=True)
            except Exception:
                pass
        await self._reset_client()

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
        headers = self._auth_headers() or None
        backoffs = (0.25, 0.6)
        last_exc: Exception | None = None
        for attempt in range(3):
            client = self._get_client()
            try:
                resp = await client.post(
                    url,
                    timeout=timeout,
                    headers=headers,
                    json=json,
                    data=data,
                    files=files,
                )
                if resp.status_code == 503 and attempt < 2:
                    await asyncio.sleep(backoffs[attempt])
                    continue
                if (
                    resp.status_code in (400, 401, 403)
                    and attempt == 0
                    and not self._worker_token
                    and is_local_voice_worker_autostart_armed()
                    and await self._is_incompatible_auth_worker()
                ):
                    await self._reset_client()
                    recovered = await self._trigger_bounded_recovery()
                    if recovered:
                        continue
                return resp
            except (
                httpx.ConnectError,
                httpx.RemoteProtocolError,
                httpx.ReadError,
            ) as exc:
                last_exc = exc
                await self._reset_client()
                if attempt < 2:
                    if (
                        isinstance(exc, httpx.ConnectError)
                        and is_local_voice_worker_autostart_armed()
                    ):
                        recovered = await self._trigger_bounded_recovery()
                        if recovered:
                            continue
                        # Worker recovery is running in background — fail fast so caller/fallback can proceed.
                        raise
                    await asyncio.sleep(backoffs[attempt])
                    continue
                raise
            except httpx.TimeoutException as exc:
                last_exc = exc
                if attempt < 2:
                    await asyncio.sleep(backoffs[attempt])
                    continue
                raise
        assert last_exc is not None
        raise last_exc

    async def get_health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
                resp = await client.get(
                    f"{self.base_url}/health",
                    headers=self._auth_headers() or None,
                )
            if resp.status_code != 200:
                if resp.status_code in (401, 403) and not self._worker_token:
                    self._schedule_background_recovery()
                return {"available": False, "stt_ready": False, "tts_ready": False}
            data = resp.json()
            if bool(data.get("auth_required")) and not self._worker_token:
                self._schedule_background_recovery()
                return {
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "stt_model_version": None,
                    "tts_model_version": None,
                }
            stt = data.get("stt") or {}
            tts = data.get("tts") or {}
            active_precision = tts.get("precision") or resolve_local_tts_precision()
            active_stt_mode = stt.get("mode") or resolve_local_stt_mode()
            return {
                "available": data.get("status") == "ok",
                "stt_ready": bool(stt.get("ready")),
                "tts_ready": bool(tts.get("ready")),
                "stt_model_version": stt.get("model_version", LOCAL_STT_MODEL_VERSION),
                "stt_mode": active_stt_mode,
                "tts_model_version": tts.get(
                    "model_version", build_local_tts_model_version(active_precision)
                ),
                "tts_precision": active_precision,
                "voices_count": tts.get("voices_count", len(STATIC_LOCAL_VOICES)),
                "active_voices": tts.get(
                    "active_voices", [v["voice_id"] for v in STATIC_LOCAL_VOICES]
                ),
            }
        except httpx.ConnectError:
            self._schedule_background_recovery()
            return {"available": False, "stt_ready": False, "tts_ready": False}
        except Exception:
            return {"available": False, "stt_ready": False, "tts_ready": False}

    async def list_voices(self) -> tuple[list[dict[str, Any]], bool]:
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                resp = await client.get(
                    f"{self.base_url}/voices",
                    headers=self._auth_headers() or None,
                )
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

        content_type = resp.headers.get("content-type", "audio/wav").split(";")[0]
        audio_bytes = (
            fix_wav_header_sizes(resp.content)
            if "wav" in content_type.lower() or resp.content[:4] == b"RIFF"
            else resp.content
        )

        return LocalSynthesizedAudio(
            content=audio_bytes,
            content_type=content_type,
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
        raw_audio = base64.b64decode(payload.get("audio_base64") or "")
        media_type = str(payload.get("media_type") or "audio/wav")
        audio = (
            fix_wav_header_sizes(raw_audio)
            if "wav" in media_type.lower() or raw_audio[:4] == b"RIFF"
            else raw_audio
        )
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
        raw_audio = base64.b64decode(payload.get("audio_base64") or "")
        media_type = str(payload.get("media_type") or "audio/wav")
        audio = (
            fix_wav_header_sizes(raw_audio)
            if "wav" in media_type.lower() or raw_audio[:4] == b"RIFF"
            else raw_audio
        )
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
        keyterms: list[str] | None = None,
        source: str | None = None,
        session_id: str | None = None,
        turn_id: str | None = None,
    ) -> LocalTranscription:
        form_data: dict[str, Any] = {
            "language": (language_code or "vi").strip() or "vi",
        }
        if keyterms:
            clean_keyterms = [k.strip()[:64] for k in keyterms[:30] if k and k.strip()]
            if clean_keyterms:
                form_data["keyterms"] = clean_keyterms
        if source:
            form_data["source"] = source.strip()[:40]
        if session_id:
            form_data["session_id"] = session_id.strip()[:80]
        if turn_id:
            form_data["turn_id"] = turn_id.strip()[:80]
        try:
            resp = await self._post_with_retry(
                "/stt",
                timeout=20.0,
                data=form_data,
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
                raw_lp = item.get("logprob")
                word_logprob = (
                    float(raw_lp)
                    if isinstance(raw_lp, (int, float)) and math.isfinite(float(raw_lp))
                    else None
                )
                safe_words.append(
                    {
                        "text": txt,
                        "start": float(start),
                        "end": float(end),
                        "logprob": word_logprob,
                    }
                )

        raw_lang_prob = payload.get("language_probability")
        lang_prob = (
            float(raw_lang_prob)
            if isinstance(raw_lang_prob, (int, float))
            and math.isfinite(float(raw_lang_prob))
            else None
        )
        return LocalTranscription(
            text=str(payload.get("text") or "").strip(),
            language_code=str(payload.get("language_code") or "vi"),
            language_probability=lang_prob,
            words=safe_words or None,
            provider="local",
            model_version=str(
                payload.get("model_version") or LOCAL_STT_MODEL_VERSION
            ),
            fallback_used=False,
        )
