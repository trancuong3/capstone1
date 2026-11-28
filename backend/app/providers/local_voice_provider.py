"""HTTP adapter for the isolated Windows Local Voice Worker (loopback or HTTPS tunnel)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import re
import struct
import sys
import time
import unicodedata
import weakref
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.request_context import get_request_id
from app.services.local_voice_worker_bootstrap import (
    ensure_local_voice_worker_running,
    is_local_voice_worker_autostart_armed,
)

logger = logging.getLogger(__name__)

DEFAULT_LOCAL_VOICE_WORKER_URL = "http://127.0.0.1:8010"
DEFAULT_LOCAL_VOICE_ID = "local_north_truc_ly"
DEFAULT_LOCAL_TTS_PRECISION = "hybrid"
DEFAULT_LOCAL_STT_MODE = "ws"
LOCAL_STT_MODEL_VERSION = "sherpa-onnx-zipformer-vi-30m-int8-2026-02-09"
CONNECT_TIMEOUT_SECONDS = 5.0
LOOPBACK_CONNECT_TIMEOUT_SECONDS = 0.5
LOOPBACK_CIRCUIT_COOLDOWN_SECONDS = 10.0
REMOTE_CIRCUIT_COOLDOWN_SECONDS = 15.0
AUTOSTART_INLINE_WAIT_SECONDS = 1.5
DEFAULT_LOOPBACK_STT_TIMEOUT_SECONDS = 5.0
DEFAULT_REMOTE_STT_TIMEOUT_SECONDS = 9.0
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")

# Shared per-(event_loop, base_url) AsyncClient pool so persistent TLS connections
# to the Cloudflare tunnel are reused across requests without leaking closed test loops.
_LOOP_CLIENTS: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[str, httpx.AsyncClient]
] = weakref.WeakKeyDictionary()


def resolve_local_tts_precision() -> str:
    raw = (os.getenv("VIREAD_VOICE_TTS_PRECISION") or DEFAULT_LOCAL_TTS_PRECISION).strip().lower()
    return raw if raw in ("hybrid", "fp32", "int8") else DEFAULT_LOCAL_TTS_PRECISION


def resolve_local_stt_mode() -> str:
    raw = (os.getenv("VIREAD_STT_MODE") or DEFAULT_LOCAL_STT_MODE).strip().lower()
    return raw if raw in ("ws", "http") else DEFAULT_LOCAL_STT_MODE


def resolve_timed_tts_timeout_seconds(word_count: int) -> float:
    """Compute adaptive read timeout for `/tts/timed` so ultra-long catalog pages (>180 words) do not time out at 45s."""
    raw = (os.getenv("VIREAD_LOCAL_TTS_TIMED_TIMEOUT_SECONDS") or "").strip()
    if raw:
        try:
            return max(15.0, min(300.0, float(raw)))
        except ValueError:
            pass
    safe_words = max(0, int(word_count))
    return round(max(45.0, min(180.0, 30.0 + safe_words * 0.35)), 2)


def build_local_tts_model_version(precision: str | None = None) -> str:
    prec = (precision or resolve_local_tts_precision()).strip().lower()
    if prec not in ("hybrid", "fp32", "int8"):
        prec = DEFAULT_LOCAL_TTS_PRECISION
    return f"vieneu-v3-turbo-onnx-{prec}-3.8.5"


LOCAL_TTS_MODEL_VERSION = build_local_tts_model_version()

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
    fallback_reason: str | None = None
    cache_hit: bool = False
    cache_scope: str | None = None
    cached_speed: float | None = None


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
    fallback_reason: str | None = None
    cache_hit: bool = False
    cache_scope: str | None = None
    cached_speed: float | None = None


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
    fallback_reason: str | None = None
    cache_hit: bool = False
    cache_scope: str | None = None
    cached_speed: float | None = None


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
    superseded: bool = False


_REMOTE_GATEWAY_DOWN_STATUSES = frozenset({502, 504, 520, 521, 522, 523, 524, 530})


class LocalVoiceTechnicalError(VoiceProviderError):
    """Raised when the local voice worker is unconfigured, unreachable, busy, or times out."""


def _is_production_or_render() -> bool:
    return bool((os.getenv("RENDER") or "").strip()) or (
        (os.getenv("APP_ENVIRONMENT") or "").strip().lower() == "production"
    )


def _is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    cleaned = host.strip().lower()
    if cleaned == "localhost":
        return True
    try:
        return ipaddress.ip_address(cleaned).is_loopback
    except ValueError:
        return False


def _resolve_worker_url(raw_url: str | None) -> tuple[str | None, bool]:
    """Validate and resolve the Voice Worker base URL.

    - In Render/production, an unset or loopback URL resolves to `(None, False)`
      so requests fail fast with `LOCAL_VOICE_UNCONFIGURED` instead of dialing loopback.
    - Non-loopback endpoints require `https://` so worker tokens and child audio
      never traverse plaintext HTTP over the Internet.
    """
    is_prod = _is_production_or_render()
    if raw_url is None:
        env_raw = os.getenv("VIREAD_LOCAL_VOICE_WORKER_URL")
        if env_raw is None or not env_raw.strip():
            if is_prod:
                return None, False
            candidate = DEFAULT_LOCAL_VOICE_WORKER_URL
        else:
            candidate = env_raw.strip()
    else:
        candidate = raw_url.strip()

    if not candidate or candidate.lower() in {"none", "disabled", "off", "unset"}:
        return None, False

    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError:
        return None, False

    scheme = parsed.scheme.lower()
    host = parsed.hostname
    if (
        not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or scheme not in {"http", "https"}
    ):
        return None, False

    is_loopback = _is_loopback_host(host)
    if scheme == "http" and not is_loopback:
        return None, False
    if is_prod and is_loopback:
        return None, False
    if port is not None and not (1 <= port <= 65535):
        return None, False

    path = parsed.path.rstrip("/")
    normalized = f"{scheme}://{parsed.netloc}{path}"
    return normalized, is_loopback


def _extract_worker_error_code(resp: httpx.Response) -> str | None:
    try:
        body = resp.json()
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    detail = body.get("detail")
    if isinstance(detail, dict):
        code = detail.get("code")
        return str(code).strip() if isinstance(code, str) and code.strip() else None
    code = body.get("code")
    return str(code).strip() if isinstance(code, str) and code.strip() else None


class LocalVoiceProvider:
    def __init__(
        self,
        base_url: str | None = None,
        *,
        worker_token: str | None = None,
    ) -> None:
        resolved_url, is_loopback = _resolve_worker_url(base_url)
        self.base_url: str | None = resolved_url
        self.is_loopback: bool = is_loopback
        self._explicit_token: str | None = (
            worker_token.strip() if worker_token is not None else None
        )
        self.autostart_enabled: bool = bool(
            self.base_url
            and self.is_loopback
            and not _is_production_or_render()
            and os.getenv("VIREAD_DISABLE_VOICE_AUTOSTART", "").strip().lower()
            not in {"1", "true", "yes", "on"}
        )
        self._client: httpx.AsyncClient | None = None
        self._recovery_task: asyncio.Task[bool] | None = None
        self._remote_unavailable_until: float = 0.0
        self._remote_unavailable_error_code: str = "LOCAL_VOICE_UNAVAILABLE"
        self._remote_unavailable_client_id: int | None = None
        self._remote_unavailable_override: Any = None
        self._inflight_client_counts: dict[int, int] = {}
        self._deferred_close_clients: dict[int, Any] = {}

    def _trip_remote_circuit(
        self,
        client: Any,
        error_code: str = "LOCAL_VOICE_UNAVAILABLE",
        *,
        allow_loopback: bool = False,
    ) -> None:
        if self.is_loopback and not allow_loopback:
            return
        ttl = (
            LOOPBACK_CIRCUIT_COOLDOWN_SECONDS
            if self.is_loopback
            else REMOTE_CIRCUIT_COOLDOWN_SECONDS
        )
        self._remote_unavailable_until = time.monotonic() + ttl
        self._remote_unavailable_error_code = error_code
        # In production `_get_client` is unbound on the instance; if a unit test patches
        # `provider._get_client` to swap fake clients mid-test, scope the breaker to that mock.
        override = self.__dict__.get("_get_client")
        self._remote_unavailable_override = override
        self._remote_unavailable_client_id = (
            id(client) if override is not None else None
        )

    def _clear_remote_circuit(self) -> None:
        self._remote_unavailable_until = 0.0
        self._remote_unavailable_client_id = None
        self._remote_unavailable_override = None

    def _is_remote_circuit_open(self, client: Any | None = None) -> bool:
        if time.monotonic() >= self._remote_unavailable_until:
            return False
        recorded_override = getattr(self, "_remote_unavailable_override", None)
        current_override = self.__dict__.get("_get_client")
        if recorded_override is not None and current_override is not recorded_override:
            return False
        if (
            self._remote_unavailable_client_id is not None
            and client is not None
            and id(client) != self._remote_unavailable_client_id
        ):
            return False
        return True

    def is_circuit_open(self) -> bool:
        """Return True when the loopback or remote worker circuit breaker is currently tripped."""
        probe_client = self._get_client() if "_get_client" in self.__dict__ else None
        return self._is_remote_circuit_open(probe_client)

    def circuit_error_code(self) -> str:
        """Return the last error code that tripped the circuit breaker."""
        return self._remote_unavailable_error_code

    def trip_connect_circuit(self, error_code: str = "LOCAL_VOICE_UNAVAILABLE") -> None:
        """Trip the circuit breaker after a confirmed transport/WebSocket dial failure."""
        probe_client = self._get_client() if "_get_client" in self.__dict__ else None
        self._trip_remote_circuit(probe_client, error_code, allow_loopback=True)

    def _start_or_get_recovery_task(self) -> asyncio.Task[bool] | None:
        if not self.is_loopback or not is_local_voice_worker_autostart_armed():
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
                    if done_task.result():
                        self._clear_remote_circuit()
                except Exception:
                    pass

        task.add_done_callback(_on_done)
        return task

    def _schedule_background_recovery(self) -> None:
        self._start_or_get_recovery_task()

    async def _await_bounded_recovery(
        self, *, timeout: float | None = None
    ) -> bool:
        """Wait briefly for loopback worker autostart, letting slow startups finish in background."""
        task = self._start_or_get_recovery_task()
        if task is None:
            return False
        wait_timeout = (
            AUTOSTART_INLINE_WAIT_SECONDS if timeout is None else max(0.01, float(timeout))
        )
        try:
            recovered = await asyncio.wait_for(asyncio.shield(task), timeout=wait_timeout)
        except (asyncio.TimeoutError, TimeoutError):
            logger.warning(
                "local_voice_autostart_backgrounded timeout_s=%.2f base_url=%s",
                wait_timeout,
                self.base_url,
            )
            return False
        except Exception:
            return False
        if recovered:
            self._clear_remote_circuit()
        return bool(recovered)

    async def _is_incompatible_auth_worker(self) -> bool:
        if not self.base_url or not self.is_loopback or self._get_token():
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

    def get_ws_stt_url(self) -> str:
        """Build the loopback worker WebSocket URL for streaming STT."""
        if (self.base_url or "").startswith("https://"):
            ws_base = "wss://" + self.base_url[len("https://") :]
        elif (self.base_url or "").startswith("http://"):
            ws_base = "ws://" + self.base_url[len("http://") :]
        else:
            ws_base = self.base_url or ""
        return f"{ws_base.rstrip('/')}/stt/stream"

    def get_ws_auth_headers(self) -> dict[str, str]:
        """Return loopback worker authentication headers for WebSocket handshake."""
        return self._request_headers(include_auth=True)

    def is_configured(self) -> bool:
        return bool(self.base_url)

    def can_autostart_loopback(self) -> bool:
        return self.autostart_enabled

    def _get_token(self) -> str:
        if self._explicit_token is not None:
            return self._explicit_token
        token = (
            os.getenv("VIREAD_VOICE_WORKER_TOKEN")
            or os.getenv("VIREAD_LOCAL_VOICE_WORKER_TOKEN")
            or ""
        ).strip()
        if token:
            return token
        is_test_runtime = (
            (os.getenv("APP_ENVIRONMENT") or "").strip().lower() == "test"
            or "unittest" in sys.modules
            or "pytest" in sys.modules
        )
        if not is_test_runtime:
            workspace_root = Path(__file__).resolve().parents[4]
            workers_env = workspace_root / "tools" / "viread-workers.env"
            if workers_env.is_file():
                try:
                    from dotenv import dotenv_values

                    vals = dotenv_values(workers_env)
                    fallback_tok = (
                        vals.get("VIREAD_VOICE_WORKER_TOKEN")
                        or vals.get("VIREAD_LOCAL_VOICE_WORKER_TOKEN")
                        or ""
                    ).strip()
                    if fallback_tok:
                        os.environ.setdefault("VIREAD_VOICE_WORKER_TOKEN", fallback_tok)
                        return fallback_tok
                except Exception:
                    pass
        return ""

    def _request_headers(self, *, include_auth: bool = True) -> dict[str, str]:
        headers: dict[str, str] = {}
        req_id = (get_request_id() or "").strip()
        if req_id and req_id != "-" and _REQUEST_ID_RE.fullmatch(req_id):
            headers["X-Request-ID"] = req_id
        if include_auth:
            token = self._get_token()
            if token:
                headers["Authorization"] = f"Bearer {token}"
                headers["X-ViRead-Voice-Token"] = token
        return headers

    def _make_timeout(
        self,
        read_timeout: float,
        connect_timeout: float | None = None,
    ) -> httpx.Timeout:
        default_connect = (
            LOOPBACK_CONNECT_TIMEOUT_SECONDS
            if self.is_loopback
            else CONNECT_TIMEOUT_SECONDS
        )
        raw_connect = default_connect if connect_timeout is None else float(connect_timeout)
        connect = min(CONNECT_TIMEOUT_SECONDS, max(0.25, raw_connect))
        read = max(0.5, float(read_timeout))
        return httpx.Timeout(read, connect=connect, write=min(15.0, read), pool=5.0)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is not None and not getattr(self._client, "is_closed", False):
            return self._client
        if self.base_url:
            try:
                loop = asyncio.get_running_loop()
                by_url = _LOOP_CLIENTS.get(loop)
                if by_url is None:
                    by_url = {}
                    _LOOP_CLIENTS[loop] = by_url
                shared = by_url.get(self.base_url)
                if shared is not None and not getattr(shared, "is_closed", False):
                    return shared
                shared = httpx.AsyncClient(
                    trust_env=False,
                    limits=httpx.Limits(
                        max_connections=24,
                        max_keepalive_connections=12,
                        keepalive_expiry=30.0,
                    ),
                )
                by_url[self.base_url] = shared
                return shared
            except RuntimeError:
                pass
        self._client = httpx.AsyncClient(
            trust_env=False,
            limits=httpx.Limits(
                max_connections=24,
                max_keepalive_connections=12,
                keepalive_expiry=30.0,
            ),
        )
        return self._client

    def _acquire_client(self) -> httpx.AsyncClient:
        client = self._get_client()
        cid = id(client)
        self._inflight_client_counts[cid] = self._inflight_client_counts.get(cid, 0) + 1
        return client

    async def _release_client(self, client: Any) -> None:
        cid = id(client)
        remaining = self._inflight_client_counts.get(cid, 0) - 1
        if remaining > 0:
            self._inflight_client_counts[cid] = remaining
            return
        self._inflight_client_counts.pop(cid, None)
        deferred = self._deferred_close_clients.pop(cid, None)
        if deferred is not None:
            await self._close_single_client(deferred)

    @staticmethod
    async def _close_single_client(client: Any) -> None:
        aclose = getattr(client, "aclose", None)
        if callable(aclose) and not getattr(client, "is_closed", False):
            try:
                await aclose()
            except Exception:
                pass

    async def _reset_client(self, *, force_close: bool = False) -> None:
        clients_to_close: list[Any] = []
        if self._client is not None and callable(getattr(self._client, "aclose", None)):
            clients_to_close.append(self._client)
            self._client = None
        if self.base_url:
            try:
                loop = asyncio.get_running_loop()
                by_url = _LOOP_CLIENTS.get(loop)
                if by_url is not None:
                    shared = by_url.pop(self.base_url, None)
                    if shared is not None and shared not in clients_to_close:
                        clients_to_close.append(shared)
            except RuntimeError:
                pass
        if force_close:
            for deferred in list(self._deferred_close_clients.values()):
                if deferred not in clients_to_close:
                    clients_to_close.append(deferred)
            self._deferred_close_clients.clear()
        for client in clients_to_close:
            cid = id(client)
            if not force_close and self._inflight_client_counts.get(cid, 0) > 0:
                self._deferred_close_clients[cid] = client
                continue
            await self._close_single_client(client)

    async def aclose(self) -> None:
        task = self._recovery_task
        self._recovery_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        await self._reset_client(force_close=True)

    async def _post_with_retry(
        self,
        path: str,
        *,
        timeout: float,
        json: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
        max_retries: int = 1,
        retry_on_timeout: bool = False,
    ) -> httpx.Response:
        if not self.base_url:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_VOICE_UNCONFIGURED"
            )
        probe_client = self._get_client() if "_get_client" in self.__dict__ else None
        if self._is_remote_circuit_open(probe_client):
            raise LocalVoiceTechnicalError(
                status_code=503, code=self._remote_unavailable_error_code
            )
        url = f"{self.base_url}{path}"
        headers = self._request_headers(include_auth=True)
        if extra_headers:
            headers.update(extra_headers)
        http_timeout = self._make_timeout(
            timeout,
            connect_timeout=(
                LOOPBACK_CONNECT_TIMEOUT_SECONDS
                if self.is_loopback
                else CONNECT_TIMEOUT_SECONDS
            ),
        )
        retry_limit = max(0, int(max_retries))
        busy_retry_limit = 1
        retries_used = 0
        busy_retries_used = 0
        protocol_resets_used = 0
        backoffs = (0.25, 0.6)
        busy_backoffs = (0.20,)
        busy_codes = {
            "VOICE_WORKER_BUSY",
            "LOCAL_VOICE_BUSY",
            "LOCAL_TTS_BUSY",
            "LOCAL_STT_BUSY",
        }
        last_exc: Exception | None = None
        for attempt in range(retry_limit + busy_retry_limit + 3):
            backoff_s = backoffs[min(retries_used, len(backoffs) - 1)]
            client = self._acquire_client()
            try:
                resp = await client.post(
                    url,
                    headers=headers,
                    timeout=http_timeout,
                    json=json,
                    data=data,
                    files=files,
                )
            except httpx.ConnectTimeout as exc:
                await self._release_client(client)
                self._trip_remote_circuit(
                    client, "LOCAL_VOICE_TIMEOUT", allow_loopback=True
                )
                # Fail fast within the connect budget instead of hanging on a dead worker/tunnel.
                raise exc
            except httpx.ConnectError as exc:
                await self._release_client(client)
                last_exc = exc
                await self._reset_client()
                if not self.is_loopback or retries_used >= retry_limit:
                    self._trip_remote_circuit(
                        client, "LOCAL_VOICE_UNAVAILABLE", allow_loopback=True
                    )
                    raise
                retries_used += 1
                if is_local_voice_worker_autostart_armed():
                    recovered = await self._await_bounded_recovery()
                    if recovered:
                        continue
                self._trip_remote_circuit(
                    client, "LOCAL_VOICE_UNAVAILABLE", allow_loopback=True
                )
                raise
            except (httpx.RemoteProtocolError, httpx.ReadError) as exc:
                await self._release_client(client)
                last_exc = exc
                await self._reset_client()
                # Allow 1 instant keepalive-socket reconnect without consuming the timeout/busy retry budget.
                if protocol_resets_used < 1:
                    protocol_resets_used += 1
                    continue
                if retries_used < retry_limit:
                    retries_used += 1
                    await asyncio.sleep(backoff_s)
                    continue
                self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE")
                raise
            except httpx.TimeoutException as exc:
                await self._release_client(client)
                last_exc = exc
                self._trip_remote_circuit(client, "LOCAL_VOICE_TIMEOUT")
                if retry_on_timeout and self.is_loopback and retries_used < retry_limit:
                    retries_used += 1
                    await asyncio.sleep(backoff_s)
                    continue
                raise
            except BaseException:
                await self._release_client(client)
                raise
            else:
                await self._release_client(client)

            worker_code = _extract_worker_error_code(resp) if resp.status_code in (429, 503) else None
            if resp.status_code in (429, 503) and worker_code in busy_codes:
                if busy_retries_used < busy_retry_limit:
                    busy_wait = busy_backoffs[min(busy_retries_used, len(busy_backoffs) - 1)]
                    busy_retries_used += 1
                    await asyncio.sleep(busy_wait)
                    continue
                return resp

            if resp.status_code == 200:
                self._clear_remote_circuit()
            elif not self.is_loopback and resp.status_code in _REMOTE_GATEWAY_DOWN_STATUSES:
                self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE")

            if resp.status_code == 503 and retries_used < retry_limit:
                if worker_code not in {"LOCAL_TTS_UNAVAILABLE", "LOCAL_STT_UNAVAILABLE"}:
                    retries_used += 1
                    await asyncio.sleep(backoff_s)
                    continue
            if (
                resp.status_code in (400, 401, 403)
                and attempt == 0
                and self.is_loopback
                and not self._get_token()
                and is_local_voice_worker_autostart_armed()
                and await self._is_incompatible_auth_worker()
            ):
                await self._reset_client()
                recovered = await self._await_bounded_recovery()
                if recovered:
                    continue
            return resp
        assert last_exc is not None
        raise last_exc

    async def get_health(self) -> dict[str, Any]:
        if not self.base_url:
            return {
                "configured": False,
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "error_code": "LOCAL_VOICE_UNCONFIGURED",
                "stt_error_code": "LOCAL_VOICE_UNCONFIGURED",
                "tts_error_code": "LOCAL_VOICE_UNCONFIGURED",
                "stt_model_version": LOCAL_STT_MODEL_VERSION,
                "tts_model_version": LOCAL_TTS_MODEL_VERSION,
                "latency_ms": 0,
            }
        probe_client = self._get_client() if "_get_client" in self.__dict__ else None
        if self._is_remote_circuit_open(probe_client):
            err = self._remote_unavailable_error_code
            return {
                "configured": True,
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "error_code": err,
                "stt_error_code": err if err == "LOCAL_VOICE_TIMEOUT" else "LOCAL_STT_UNAVAILABLE",
                "tts_error_code": err if err == "LOCAL_VOICE_TIMEOUT" else "LOCAL_TTS_UNAVAILABLE",
                "stt_model_version": LOCAL_STT_MODEL_VERSION,
                "tts_model_version": LOCAL_TTS_MODEL_VERSION,
                "latency_ms": 0,
            }
        started = time.perf_counter()
        client = self._acquire_client()
        try:
            resp = await asyncio.wait_for(
                client.get(
                    f"{self.base_url}/health",
                    headers=self._request_headers(include_auth=self.is_loopback),
                    timeout=self._make_timeout(
                        2.0,
                        LOOPBACK_CONNECT_TIMEOUT_SECONDS if self.is_loopback else 2.0,
                    ),
                ),
                timeout=2.5,
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            if resp.status_code == 200:
                self._clear_remote_circuit()
            if resp.status_code == 503:
                return {
                    "configured": True,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_BUSY",
                    "stt_error_code": "LOCAL_VOICE_BUSY",
                    "tts_error_code": "LOCAL_VOICE_BUSY",
                    "latency_ms": latency_ms,
                }
            if resp.status_code != 200:
                if not self.is_loopback and (
                    resp.status_code >= 500 or resp.status_code in _REMOTE_GATEWAY_DOWN_STATUSES
                ):
                    self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE")
                if resp.status_code in (401, 403) and not self._get_token():
                    self._schedule_background_recovery()
                return {
                    "configured": True,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_UNAVAILABLE",
                    "stt_error_code": "LOCAL_STT_UNAVAILABLE",
                    "tts_error_code": "LOCAL_TTS_UNAVAILABLE",
                    "latency_ms": latency_ms,
                }
            data = resp.json()
            if bool(data.get("auth_required")) and not self._get_token():
                self._schedule_background_recovery()
                return {
                    "configured": True,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_UNAVAILABLE",
                    "stt_error_code": "LOCAL_STT_UNAVAILABLE",
                    "tts_error_code": "LOCAL_TTS_UNAVAILABLE",
                    "stt_model_version": None,
                    "tts_model_version": None,
                    "latency_ms": latency_ms,
                }
            stt = data.get("stt") or {}
            tts = data.get("tts") or {}
            stt_ready = bool(stt.get("ready"))
            tts_ready = bool(tts.get("ready"))
            available = data.get("status") == "ok" and stt_ready and tts_ready
            if available:
                err_code = None
            elif stt_ready and not tts_ready:
                err_code = "LOCAL_TTS_UNAVAILABLE"
            elif tts_ready and not stt_ready:
                err_code = "LOCAL_STT_UNAVAILABLE"
            else:
                err_code = "LOCAL_VOICE_UNAVAILABLE"
            return {
                "configured": True,
                "available": data.get("status") == "ok",
                "stt_ready": stt_ready,
                "tts_ready": tts_ready,
                "error_code": err_code,
                "stt_error_code": None if stt_ready else "LOCAL_STT_UNAVAILABLE",
                "tts_error_code": None if tts_ready else "LOCAL_TTS_UNAVAILABLE",
                "stt_model_version": stt.get("model_version", LOCAL_STT_MODEL_VERSION),
                "tts_model_version": tts.get("model_version", LOCAL_TTS_MODEL_VERSION),
                "stt_mode": stt.get("mode") or resolve_local_stt_mode(),
                "tts_precision": tts.get("precision") or resolve_local_tts_precision(),
                "active_voices": tts.get("active_voices"),
                "worker_version": data.get("version"),
                "latency_ms": latency_ms,
            }
        except httpx.ConnectTimeout:
            self._trip_remote_circuit(client, "LOCAL_VOICE_TIMEOUT", allow_loopback=True)
            return {
                "configured": True,
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "error_code": "LOCAL_VOICE_TIMEOUT",
                "stt_error_code": "LOCAL_VOICE_TIMEOUT",
                "tts_error_code": "LOCAL_VOICE_TIMEOUT",
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
        except (httpx.TimeoutException, asyncio.TimeoutError):
            self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE")
            return {
                "configured": True,
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "error_code": "LOCAL_VOICE_TIMEOUT",
                "stt_error_code": "LOCAL_VOICE_TIMEOUT",
                "tts_error_code": "LOCAL_VOICE_TIMEOUT",
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
        except httpx.ConnectError:
            self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE", allow_loopback=True)
            self._schedule_background_recovery()
            return {
                "configured": True,
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "error_code": "LOCAL_VOICE_UNAVAILABLE",
                "stt_error_code": "LOCAL_STT_UNAVAILABLE",
                "tts_error_code": "LOCAL_TTS_UNAVAILABLE",
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
        except Exception:
            self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE")
            return {
                "configured": True,
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "error_code": "LOCAL_VOICE_UNAVAILABLE",
                "stt_error_code": "LOCAL_STT_UNAVAILABLE",
                "tts_error_code": "LOCAL_TTS_UNAVAILABLE",
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
        finally:
            await self._release_client(client)

    async def list_voices(self) -> tuple[list[dict[str, Any]], bool]:
        if not self.base_url:
            return [dict(v) for v in STATIC_LOCAL_VOICES], False
        probe_client = self._get_client() if "_get_client" in self.__dict__ else None
        if self._is_remote_circuit_open(probe_client):
            return [dict(v) for v in STATIC_LOCAL_VOICES], False
        client = self._acquire_client()
        try:
            resp = await asyncio.wait_for(
                client.get(
                    f"{self.base_url}/voices",
                    headers=self._request_headers(include_auth=True),
                    timeout=self._make_timeout(1.5, 1.5),
                ),
                timeout=2.0,
            )
            if resp.status_code == 200:
                self._clear_remote_circuit()
                payload = resp.json()
                if not isinstance(payload, dict):
                    raise ValueError("expected JSON object")
                model_ver = str(
                    payload.get("model_version") or LOCAL_TTS_MODEL_VERSION
                )
                raw_voices = payload.get("voices") or []
                mapped: list[dict[str, Any]] = []
                for item in raw_voices:
                    if not isinstance(item, dict):
                        continue
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
            elif not self.is_loopback and resp.status_code in _REMOTE_GATEWAY_DOWN_STATUSES:
                self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE")
        except Exception:
            self._trip_remote_circuit(client, "LOCAL_VOICE_UNAVAILABLE")
        finally:
            await self._release_client(client)
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
        accept: str | None = None,
        audio_format: str | None = None,
    ) -> LocalSynthesizedAudio:
        target_voice, migrated_legacy = self._resolve_target_voice_id(voice_id)
        body: dict[str, Any] = {
            "text": text,
            "voice_id": target_voice,
            "speed": speed,
            "word_sample": word_sample,
        }
        if audio_format:
            body["audio_format"] = audio_format
        extra_headers = {"Accept": accept} if accept else None
        try:
            resp = await self._post_with_retry(
                "/tts",
                timeout=25.0,
                json=body,
                extra_headers=extra_headers,
            )
        except LocalVoiceTechnicalError:
            raise
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
            worker_code = _extract_worker_error_code(resp)
            if worker_code == "LOCAL_TTS_UNAVAILABLE":
                raise LocalVoiceTechnicalError(
                    status_code=503, code="LOCAL_TTS_UNAVAILABLE"
                )
            raise LocalVoiceTechnicalError(status_code=503, code="LOCAL_TTS_BUSY")
        if resp.status_code >= 400 or not resp.content:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )

        content_type = resp.headers.get("content-type", "audio/wav").split(";")[0]
        audio_bytes = (
            fix_wav_header_sizes(resp.content)
            if "wav" in content_type.lower()
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
        accept: str | None = None,
        audio_format: str | None = None,
    ) -> LocalTimedSpeech:
        target_voice, _ = self._resolve_target_voice_id(voice_id)
        passage_text = " ".join(words)
        body: dict[str, Any] = {
            "text": passage_text,
            "voice_id": target_voice,
            "speed": speed,
            "word_sample": False,
        }
        if audio_format:
            body["audio_format"] = audio_format
        extra_headers = {"Accept": accept} if accept else None
        timed_timeout = resolve_timed_tts_timeout_seconds(len(words))
        try:
            resp = await self._post_with_retry(
                "/tts/timed",
                timeout=timed_timeout,
                json=body,
                extra_headers=extra_headers,
            )
        except LocalVoiceTechnicalError:
            raise
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
            worker_code = _extract_worker_error_code(resp)
            if worker_code == "LOCAL_TTS_UNAVAILABLE":
                raise LocalVoiceTechnicalError(
                    status_code=503, code="LOCAL_TTS_UNAVAILABLE"
                )
            raise LocalVoiceTechnicalError(status_code=503, code="LOCAL_TTS_BUSY")
        if resp.status_code >= 400:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )

        try:
            payload = resp.json()
            if not isinstance(payload, dict):
                raise ValueError("expected JSON object")
            raw_b64 = payload.get("audio_base64")
            if not isinstance(raw_b64, str) or not raw_b64:
                raise ValueError("missing audio_base64")
            media_type = str(payload.get("media_type") or "audio/wav")
            raw_audio = base64.b64decode(raw_b64, validate=True)
            audio = fix_wav_header_sizes(raw_audio) if "wav" in media_type.lower() else raw_audio
            duration = float(payload.get("duration_seconds") or 0.0)
            raw_words = payload.get("words") or []
        except (ValueError, TypeError, binascii.Error) as exc:
            raise LocalVoiceTechnicalError(
                status_code=502, code="LOCAL_TTS_ALIGNMENT_INVALID"
            ) from exc
        if (
            not audio
            or not math.isfinite(duration)
            or duration <= 0
            or not isinstance(raw_words, list)
            or len(raw_words) != len(words)
        ):
            raise LocalVoiceTechnicalError(
                status_code=502, code="LOCAL_TTS_ALIGNMENT_INVALID"
            )

        timed_words: list[LocalTimedWord] = []
        prev_end = 0.0
        for idx, item in enumerate(raw_words):
            if not isinstance(item, dict):
                raise LocalVoiceTechnicalError(
                    status_code=502, code="LOCAL_TTS_ALIGNMENT_INVALID"
                )
            try:
                start = float(item.get("start", 0.0))
                end = float(item.get("end", start))
            except (ValueError, TypeError) as exc:
                raise LocalVoiceTechnicalError(
                    status_code=502, code="LOCAL_TTS_ALIGNMENT_INVALID"
                ) from exc
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
        accept: str | None = None,
        audio_format: str | None = None,
    ) -> LocalPhonicsSpeech:
        target_voice, _ = self._resolve_target_voice_id(voice_id)
        body: dict[str, Any] = {
            "steps": steps,
            "voice_id": target_voice,
            "speed": speed,
        }
        if audio_format:
            body["audio_format"] = audio_format
        extra_headers = {"Accept": accept} if accept else None
        try:
            resp = await self._post_with_retry(
                "/tts/phonics",
                timeout=25.0,
                json=body,
                extra_headers=extra_headers,
            )
        except LocalVoiceTechnicalError:
            raise
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
            worker_code = _extract_worker_error_code(resp)
            if worker_code == "LOCAL_TTS_UNAVAILABLE":
                raise LocalVoiceTechnicalError(
                    status_code=503, code="LOCAL_TTS_UNAVAILABLE"
                )
            raise LocalVoiceTechnicalError(status_code=503, code="LOCAL_TTS_BUSY")
        if resp.status_code >= 400:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )

        try:
            payload = resp.json()
            if not isinstance(payload, dict):
                raise ValueError("expected JSON object")
            raw_b64 = payload.get("audio_base64")
            if not isinstance(raw_b64, str) or not raw_b64:
                raise ValueError("missing audio_base64")
            media_type = str(payload.get("media_type") or "audio/wav")
            raw_audio = base64.b64decode(raw_b64, validate=True)
            audio = fix_wav_header_sizes(raw_audio) if "wav" in media_type.lower() else raw_audio
            duration = float(payload.get("duration_seconds") or 0.0)
            raw_timings = payload.get("step_timings") or []
        except (ValueError, TypeError, binascii.Error) as exc:
            raise LocalVoiceTechnicalError(
                status_code=502, code="LOCAL_PHONICS_ALIGNMENT_INVALID"
            ) from exc
        if (
            not audio
            or not math.isfinite(duration)
            or duration <= 0
            or not isinstance(raw_timings, list)
            or len(raw_timings) != len(steps)
        ):
            raise LocalVoiceTechnicalError(
                status_code=502, code="LOCAL_PHONICS_ALIGNMENT_INVALID"
            )

        timings: list[LocalPhonicsStepTiming] = []
        prev_end = 0.0
        for idx, item in enumerate(raw_timings):
            if not isinstance(item, dict):
                raise LocalVoiceTechnicalError(
                    status_code=502, code="LOCAL_PHONICS_ALIGNMENT_INVALID"
                )
            try:
                raw_start = float(item.get("start", 0.0))
                raw_end = float(item.get("end", raw_start))
            except (ValueError, TypeError) as exc:
                raise LocalVoiceTechnicalError(
                    status_code=502, code="LOCAL_PHONICS_ALIGNMENT_INVALID"
                ) from exc
            if (
                not (math.isfinite(raw_start) and math.isfinite(raw_end))
                or raw_start < 0
                or raw_end < raw_start
            ):
                raise LocalVoiceTechnicalError(
                    status_code=502, code="LOCAL_PHONICS_ALIGNMENT_INVALID"
                )
            start = round(max(prev_end, min(duration, raw_start)), 3)
            end = round(max(start, min(duration, raw_end)), 3)
            timings.append(
                LocalPhonicsStepTiming(
                    id=str(item.get("id") or steps[idx]["id"]),
                    index=idx,
                    start=start,
                    end=end,
                )
            )
            prev_end = end

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
        timeout: float | None = None,
        retry_on_timeout: bool | None = None,
    ) -> LocalTranscription:
        form_data: dict[str, Any] = {
            "language": (language_code or "vi").strip() or "vi",
        }
        if keyterms:
            clean_keyterms: list[str] = []
            seen_terms: set[str] = set()
            for raw_term in keyterms[:30]:
                if not isinstance(raw_term, str):
                    continue
                term = unicodedata.normalize("NFC", raw_term).strip()[:80]
                if term and term.lower() not in seen_terms:
                    seen_terms.add(term.lower())
                    clean_keyterms.append(term)
            if clean_keyterms:
                form_data["keyterms"] = json.dumps(clean_keyterms, ensure_ascii=False)
        if source:
            form_data["source"] = source.strip()[:40]
        if session_id:
            form_data["session_id"] = session_id.strip()[:80]
        if turn_id:
            form_data["turn_id"] = turn_id.strip()[:80]
        effective_timeout = (
            max(0.5, float(timeout))
            if timeout is not None
            else (
                DEFAULT_LOOPBACK_STT_TIMEOUT_SECONDS
                if self.is_loopback
                else DEFAULT_REMOTE_STT_TIMEOUT_SECONDS
            )
        )
        should_retry_timeout = (
            (True if retry_on_timeout is None else bool(retry_on_timeout))
            and effective_timeout >= 3.0
        )
        try:
            resp = await self._post_with_retry(
                "/stt",
                timeout=effective_timeout,
                max_retries=1,
                retry_on_timeout=should_retry_timeout,
                data=form_data,
                files={"audio_file": (filename, audio, content_type)},
            )
        except LocalVoiceTechnicalError:
            raise
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
            worker_code = _extract_worker_error_code(resp)
            if worker_code == "LOCAL_STT_UNAVAILABLE":
                raise LocalVoiceTechnicalError(
                    status_code=503, code="LOCAL_STT_UNAVAILABLE"
                )
            raise LocalVoiceTechnicalError(status_code=503, code="LOCAL_STT_BUSY")
        if resp.status_code >= 400:
            raise LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_STT_UNAVAILABLE"
            )

        try:
            payload = resp.json()
            if not isinstance(payload, dict):
                raise ValueError("expected JSON object")
        except (ValueError, TypeError) as exc:
            raise LocalVoiceTechnicalError(
                status_code=502, code="LOCAL_STT_INVALID_RESPONSE"
            ) from exc
        raw_words = payload.get("words") or []
        if not isinstance(raw_words, list):
            raw_words = []
        safe_words: list[dict[str, Any]] = []
        for item in raw_words:
            if not isinstance(item, dict):
                continue
            txt = unicodedata.normalize("NFC", str(item.get("text") or "")).strip()
            start = item.get("start")
            end = item.get("end")
            if (
                txt
                and isinstance(start, (int, float))
                and not isinstance(start, bool)
                and isinstance(end, (int, float))
                and not isinstance(end, bool)
                and math.isfinite(float(start))
                and math.isfinite(float(end))
                and start >= 0
                and end >= start
            ):
                raw_logprob = item.get("logprob")
                safe_logprob = (
                    float(raw_logprob)
                    if isinstance(raw_logprob, (int, float))
                    and not isinstance(raw_logprob, bool)
                    and math.isfinite(float(raw_logprob))
                    else None
                )
                safe_words.append(
                    {
                        "text": txt,
                        "start": float(start),
                        "end": float(end),
                        "logprob": safe_logprob,
                    }
                )

        return LocalTranscription(
            text=unicodedata.normalize("NFC", str(payload.get("text") or "")).strip(),
            language_code=str(payload.get("language_code") or "vi"),
            language_probability=None,
            words=safe_words or None,
            provider="local",
            model_version=str(
                payload.get("model_version") or LOCAL_STT_MODEL_VERSION
            ),
            fallback_used=False,
            superseded=bool(payload.get("superseded")),
        )
