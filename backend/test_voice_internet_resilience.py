from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import logging
import os
import sys
import types
import unittest
import uuid
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, require_active_profile_id
from app.api.routes.voice import (
    _resolve_audio_content_type,
    router as voice_router,
)
from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.local_voice_provider import (
    LocalTimedSpeech,
    LocalTranscription,
    LocalVoiceProvider,
    LocalVoiceTechnicalError,
)
from app.request_context import request_id_context
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    VoicePolicyContext,
    clear_voice_orchestrator_caches,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
VOICE_WORKER_PATH = REPO_ROOT / "scripts" / "windows" / "voice_worker.py"


class _PermissiveStubModule(types.ModuleType):
    """Lightweight fallback module used only when optional GPU/audio runtime packages are absent."""

    def __getattr__(self, name: str):  # noqa: ANN001, ANN204
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)

        class _Dummy:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __call__(self, *args, **kwargs):
                return self

            def __getattr__(self, _attr: str):
                return _Dummy()

        _Dummy.__name__ = name
        return _Dummy


def _load_voice_worker_module():
    optional_deps = (
        "av",
        "sherpa_onnx",
        "vieneu",
        "vieneu_utils",
        "vieneu_utils.core_utils",
        "vieneu_utils.phonemize_text",
        "soundfile",
        "librosa",
        "scipy",
        "scipy.signal",
        "torch",
        "torchaudio",
        "onnxruntime",
    )
    injected: dict[str, types.ModuleType | None] = {}
    for mod_name in optional_deps:
        if importlib.util.find_spec(mod_name) is None:
            parent_name = mod_name.split(".")[0]
            if parent_name not in injected:
                stub_parent = _PermissiveStubModule(parent_name)
                stub_parent.__spec__ = importlib.machinery.ModuleSpec(
                    parent_name, None, is_package=True
                )
                stub_parent.__path__ = []
                injected[parent_name] = sys.modules.get(parent_name)
                sys.modules[parent_name] = stub_parent
            if mod_name not in injected:
                stub = _PermissiveStubModule(mod_name)
                stub.__spec__ = importlib.machinery.ModuleSpec(mod_name, None)
                injected[mod_name] = sys.modules.get(mod_name)
                sys.modules[mod_name] = stub

    module_name = "_test_voice_worker_module"
    sys.modules.pop(module_name, None)
    spec = importlib.util.spec_from_file_location(module_name, VOICE_WORKER_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    try:
        spec.loader.exec_module(mod)
        return mod
    finally:
        sys.modules.pop(module_name, None)
        for mod_name, previous in injected.items():
            if previous is None:
                sys.modules.pop(mod_name, None)
            else:
                sys.modules[mod_name] = previous


def _build_wav_bytes(duration_ms: int = 200, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    n_frames = int(sample_rate * (duration_ms / 1000.0))
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_frames)
    return buf.getvalue()


class _CaptureHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(self.format(record))


class LocalVoiceProviderInternetResilienceTests(unittest.IsolatedAsyncioTestCase):
    def test_render_and_production_require_explicit_non_loopback_https_url(self) -> None:
        with patch.dict(
            os.environ,
            {
                "RENDER": "true",
                "VIREAD_LOCAL_VOICE_WORKER_URL": "",
                "VIREAD_DISABLE_VOICE_AUTOSTART": "",
            },
            clear=False,
        ):
            provider = LocalVoiceProvider()
            self.assertFalse(provider.is_configured())
            self.assertFalse(provider.can_autostart_loopback())

        with patch.dict(
            os.environ,
            {
                "APP_ENVIRONMENT": "production",
                "VIREAD_LOCAL_VOICE_WORKER_URL": "http://127.0.0.1:8010",
                "VIREAD_DISABLE_VOICE_AUTOSTART": "",
            },
            clear=False,
        ):
            provider = LocalVoiceProvider()
            self.assertFalse(provider.is_configured())
            self.assertFalse(provider.can_autostart_loopback())

    def test_rejects_plaintext_non_loopback_and_credentialed_urls(self) -> None:
        with patch.dict(os.environ, {"RENDER": "", "APP_ENVIRONMENT": "development"}, clear=False):
            p_http = LocalVoiceProvider(base_url="http://voice.example.com:8010")
            self.assertFalse(p_http.is_configured())

            p_cred = LocalVoiceProvider(base_url="https://user:secret@voice.example.com")
            self.assertFalse(p_cred.is_configured())

            p_https = LocalVoiceProvider(base_url="https://voice-staging.trycloudflare.com/")
            self.assertTrue(p_https.is_configured())
            self.assertFalse(p_https.is_loopback)
            self.assertFalse(p_https.can_autostart_loopback())
            self.assertEqual(p_https.base_url, "https://voice-staging.trycloudflare.com")

            p_local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
            self.assertTrue(p_local.is_configured())
            self.assertTrue(p_local.is_loopback)

    async def test_unconfigured_fails_immediately_without_network_calls(self) -> None:
        provider = LocalVoiceProvider(base_url="")
        with patch.object(provider, "_get_client") as mock_client_factory:
            health = await provider.get_health()
            self.assertFalse(health["configured"])
            self.assertFalse(health["available"])
            self.assertEqual(health["error_code"], "LOCAL_VOICE_UNCONFIGURED")
            self.assertEqual(health["stt_error_code"], "LOCAL_VOICE_UNCONFIGURED")
            self.assertEqual(health["tts_error_code"], "LOCAL_VOICE_UNCONFIGURED")

            with self.assertRaises(LocalVoiceTechnicalError) as tts_ctx:
                await provider.synthesize(text="Xin chào", voice_id="local_north_truc_ly")
            self.assertEqual(tts_ctx.exception.status_code, 503)
            self.assertEqual(tts_ctx.exception.code, "LOCAL_VOICE_UNCONFIGURED")

            with self.assertRaises(LocalVoiceTechnicalError) as stt_ctx:
                await provider.transcribe(
                    audio=_build_wav_bytes(),
                    filename="sample.wav",
                    content_type="audio/wav",
                )
            self.assertEqual(stt_ctx.exception.status_code, 503)
            self.assertEqual(stt_ctx.exception.code, "LOCAL_VOICE_UNCONFIGURED")

            mock_client_factory.assert_not_called()

    async def test_https_forwards_token_request_id_and_uses_5s_connect_timeout(self) -> None:
        seen_requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_requests.append(request)
            if request.url.path == "/health":
                return httpx.Response(
                    200,
                    json={
                        "status": "ok",
                        "version": "1.1.0",
                        "auth_required": True,
                        "stt": {"ready": True, "model_version": "sherpa-test"},
                        "tts": {"ready": True, "model_version": "vieneu-test"},
                    },
                )
            if request.url.path == "/tts":
                body = json.loads(request.content.decode("utf-8"))
                self.assertEqual(body["text"], "Tiếng Việt có dấu: ă, â, đ, ê, ô, ơ, ư.")
                self.assertEqual(body["speed"], 0.85)
                return httpx.Response(
                    200,
                    content=b"RIFFWAVE",
                    headers={"content-type": "audio/wav"},
                )
            return httpx.Response(404)

        provider = LocalVoiceProvider(
            base_url="https://voice-tunnel.trycloudflare.com",
            worker_token="super-secret-voice-token",
        )
        timeout_cfg = provider._make_timeout(20.0)
        self.assertEqual(timeout_cfg.connect, 5.0)
        self.assertEqual(timeout_cfg.read, 20.0)

        transport = httpx.MockTransport(handler)
        token_ctx = request_id_context.set("req-voice-abc-123")
        try:
            async with httpx.AsyncClient(
                base_url=provider.base_url,
                transport=transport,
            ) as client:
                with patch.object(provider, "_get_client", return_value=client):
                    health = await provider.get_health()
                    audio = await provider.synthesize(
                        text="Tiếng Việt có dấu: ă, â, đ, ê, ô, ơ, ư.",
                        voice_id="Binh",
                        speed=0.85,
                    )
        finally:
            request_id_context.reset(token_ctx)

        self.assertTrue(health["available"])
        self.assertEqual(health["worker_version"], "1.1.0")
        self.assertEqual(audio.content_type, "audio/wav")
        self.assertEqual(audio.content, b"RIFFWAVE")

        self.assertEqual(len(seen_requests), 2)
        health_req, tts_req = seen_requests
        self.assertEqual(health_req.headers.get("x-request-id"), "req-voice-abc-123")
        self.assertIsNone(health_req.headers.get("x-viread-voice-token"))
        self.assertEqual(tts_req.headers.get("x-request-id"), "req-voice-abc-123")
        self.assertEqual(tts_req.headers.get("x-viread-voice-token"), "super-secret-voice-token")

    async def test_health_probe_uses_extended_timeouts_for_remote_tunnel_and_fast_for_loopback(self) -> None:
        captured: list[tuple[str, float, float, float]] = []

        async def _capture_probe(base_url: str) -> None:
            provider = LocalVoiceProvider(base_url=base_url, worker_token="tok")
            seen_http_timeout: list[httpx.Timeout] = []
            seen_outer_timeout: list[float] = []

            class _SpyClient:
                async def get(self, url: str, **kwargs):
                    seen_http_timeout.append(kwargs["timeout"])
                    return httpx.Response(
                        200,
                        json={"status": "ok", "stt": {"ready": True}, "tts": {"ready": True}},
                    )

            real_wait_for = __import__("asyncio").wait_for

            async def _spy_wait_for(coro, timeout=None):
                seen_outer_timeout.append(float(timeout))
                return await real_wait_for(coro, timeout=timeout)

            with (
                patch.object(provider, "_get_client", return_value=_SpyClient()),
                patch("app.providers.local_voice_provider.asyncio.wait_for", side_effect=_spy_wait_for),
            ):
                health = await provider.get_health()
            self.assertTrue(health["available"])
            captured.append(
                (
                    base_url,
                    float(seen_http_timeout[0].connect),
                    float(seen_http_timeout[0].read),
                    seen_outer_timeout[0],
                )
            )

        with patch.dict(os.environ, {"RENDER": "", "APP_ENVIRONMENT": "development"}, clear=False):
            await _capture_probe("https://voice-tunnel.trycloudflare.com")
            await _capture_probe("http://127.0.0.1:8010")

        self.assertEqual(captured[0], ("https://voice-tunnel.trycloudflare.com", 4.0, 4.0, 4.5))
        self.assertEqual(captured[1], ("http://127.0.0.1:8010", 2.0, 2.0, 2.5))

    async def test_fail_fast_on_connect_timeout_and_error_classification(self) -> None:
        provider = LocalVoiceProvider(
            base_url="https://voice-tunnel.trycloudflare.com",
            worker_token="tok",
        )

        class _ConnectTimeoutClient:
            def __init__(self) -> None:
                self.calls = 0

            async def post(self, *args, **kwargs):
                self.calls += 1
                raise httpx.ConnectTimeout("timed out connecting")

            async def get(self, *args, **kwargs):
                self.calls += 1
                raise httpx.ConnectTimeout("timed out connecting")

        timeout_client = _ConnectTimeoutClient()
        with patch.object(provider, "_get_client", return_value=timeout_client):
            with self.assertRaises(LocalVoiceTechnicalError) as ctx:
                await provider.synthesize(text="Xin chào", voice_id="Binh")
            self.assertEqual(ctx.exception.code, "LOCAL_TTS_TIMEOUT")
            self.assertEqual(timeout_client.calls, 1)

            health = await provider.get_health()
            self.assertFalse(health["available"])
            self.assertEqual(health["error_code"], "LOCAL_VOICE_TIMEOUT")

        def busy_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"code": "LOCAL_STT_BUSY", "message": "busy"})

        async with httpx.AsyncClient(
            base_url=provider.base_url,
            transport=httpx.MockTransport(busy_handler),
        ) as busy_client:
            with patch.object(provider, "_get_client", return_value=busy_client), patch(
                "app.providers.local_voice_provider.asyncio.sleep", AsyncMock()
            ):
                with self.assertRaises(LocalVoiceTechnicalError) as stt_busy:
                    await provider.transcribe(
                        audio=_build_wav_bytes(),
                        filename="sample.wav",
                        content_type="audio/wav",
                    )
                self.assertEqual(stt_busy.exception.code, "LOCAL_STT_BUSY")

        def partial_health_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "degraded",
                    "version": "1.1.0",
                    "stt": {"ready": True},
                    "tts": {"ready": False, "error": "LOCAL_TTS_UNAVAILABLE"},
                },
            )

        async with httpx.AsyncClient(
            base_url=provider.base_url,
            transport=httpx.MockTransport(partial_health_handler),
        ) as partial_client:
            with patch.object(provider, "_get_client", return_value=partial_client):
                health = await provider.get_health()
                self.assertFalse(health["available"])
                self.assertTrue(health["stt_ready"])
                self.assertFalse(health["tts_ready"])
                self.assertEqual(health["tts_error_code"], "LOCAL_TTS_UNAVAILABLE")
                self.assertEqual(health["error_code"], "LOCAL_TTS_UNAVAILABLE")


class VoiceOrchestratorAndRouteResilienceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_voice_orchestrator_caches()

    def tearDown(self) -> None:
        clear_voice_orchestrator_caches()

    async def test_orchestrator_preserves_session_lock_diacritics_and_strict_google_policy(self) -> None:
        local = MagicMock()
        local.synthesize_timed = AsyncMock(
            return_value=LocalTimedSpeech(
                audio=b"RIFF",
                content_type="audio/wav",
                duration_seconds=1.2,
                words=[],
                resolved_voice_id="local_north_truc_ly",
                region="north",
                model_version="vieneu-test",
                provider="local",
            )
        )
        local.transcribe = AsyncMock(
            side_effect=LocalVoiceTechnicalError(
                status_code=503,
                code="LOCAL_STT_UNAVAILABLE",
            )
        )

        google = MagicMock()
        google.is_stt_configured.return_value = True
        google.is_stt_in_cooldown.return_value = False
        google.transcribe = AsyncMock(
            return_value=LocalTranscription(
                text="con mèo",
                language_code="vi",
                language_probability=0.9,
                words=[],
                provider="google",
                model_version="chirp",
                fallback_used=True,
                fallback_reason="LOCAL_STT_UNAVAILABLE",
            )
        )

        session_id = str(uuid.uuid4())
        page_id = str(uuid.uuid4())
        orch = VoiceOrchestrator(local_provider=local, google_provider=google)

        # Strict SessionVoiceLock: even if allow_google_tts=True, TTS preserves exact requested voice,
        # speed, and Vietnamese diacritics and NEVER falls back/switches providers mid-session.
        timed = await orch.synthesize_timed(
            words=["Tiếng", "Việt", "đầy", "đủ", "dấu", "câu!"],
            requested_voice_id="local_north_truc_ly",
            speed=0.9,
            policy=VoicePolicyContext(
                provider_mode="local_with_google_fallback",
                allow_google_tts=True,
                session_id=session_id,
                page_id=page_id,
            ),
        )
        self.assertEqual(timed.resolved_voice_id, "local_north_truc_ly")
        first_call = local.synthesize_timed.await_args_list[0].kwargs
        self.assertEqual(first_call["words"], ["Tiếng", "Việt", "đầy", "đủ", "dấu", "câu!"])
        self.assertEqual(first_call["voice_id"], "local_north_truc_ly")
        self.assertEqual(first_call["speed"], 0.9)

        local.synthesize = AsyncMock(
            side_effect=LocalVoiceTechnicalError(
                status_code=503,
                code="LOCAL_TTS_UNAVAILABLE",
            )
        )
        with self.assertRaises(LocalVoiceTechnicalError) as tts_err:
            await orch.synthesize(
                text="Tiếng Việt",
                requested_voice_id="local_north_truc_ly",
                policy=VoicePolicyContext(
                    provider_mode="local_only",
                    allow_google_tts=True,
                    session_id=session_id,
                ),
            )
        self.assertEqual(tts_err.exception.code, "LOCAL_TTS_UNAVAILABLE")
        google.synthesize.assert_not_called()

        # Strict Google policy: local_only NEVER falls back even when allow_google_stt=True.
        with self.assertRaises(VoiceProviderError):
            await orch.transcribe(
                audio=_build_wav_bytes(),
                filename="turn.wav",
                content_type="audio/wav",
                policy=VoicePolicyContext(
                    provider_mode="local_only",
                    allow_google_stt=True,
                    session_id=str(uuid.uuid4()),
                    turn_id="t0",
                ),
            )
        google.transcribe.assert_not_called()

        # When local_with_google_fallback + allow_google_stt=True, fallback succeeds cleanly.
        res1 = await orch.transcribe(
            audio=_build_wav_bytes(),
            filename="turn1.wav",
            content_type="audio/wav",
            policy=VoicePolicyContext(
                provider_mode="local_with_google_fallback",
                allow_google_stt=True,
                session_id=session_id,
                page_id=page_id,
                turn_id="t1",
            ),
        )
        self.assertEqual(res1.provider, "google")
        self.assertTrue(res1.fallback_used)
        self.assertEqual(res1.fallback_reason, "LOCAL_STT_UNAVAILABLE")

    def test_audio_mime_resolution_and_no_store_cache_headers(self) -> None:
        self.assertEqual(_resolve_audio_content_type("application/octet-stream", "recording.mp4"), "audio/mp4")
        self.assertEqual(_resolve_audio_content_type("", "recording.m4a"), "audio/mp4")
        self.assertEqual(_resolve_audio_content_type("application/octet-stream", "recording.oga"), "audio/ogg")
        self.assertEqual(_resolve_audio_content_type(None, "recording.webm"), "audio/webm")
        self.assertEqual(_resolve_audio_content_type("audio/wav;codecs=pcm", "recording.wav"), "audio/wav;codecs=pcm")

        app = FastAPI()
        app.include_router(voice_router, prefix="/voice")
        app.dependency_overrides[get_current_parent_id] = lambda: uuid.uuid4()
        app.dependency_overrides[require_active_profile_id] = lambda: uuid.uuid4()

        fake_status = {
            "default_mode": "local_only",
            "default_voice_id": "local_north_truc_ly",
            "local": {
                "configured": False,
                "mode": "unconfigured",
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "error_code": "LOCAL_VOICE_UNCONFIGURED",
                "stt_error_code": "LOCAL_VOICE_UNCONFIGURED",
                "tts_error_code": "LOCAL_VOICE_UNCONFIGURED",
                "worker_version": None,
                "latency_ms": None,
                "stt_model_version": None,
                "tts_model_version": None,
            },
            "google": {"stt_configured": False, "tts_configured": False},
        }
        with patch("app.api.routes.voice.VoiceOrchestrator") as mock_orch_cls:
            mock_orch_cls.return_value.get_status = AsyncMock(return_value=fake_status)
            client = TestClient(app)
            resp = client.get("/voice/status")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers.get("cache-control"), "no-store")


class VoiceWorkerContractTests(unittest.TestCase):
    def test_worker_auth_request_id_logging_and_format_hints(self) -> None:
        root_logger = logging.getLogger()
        saved_handlers = list(root_logger.handlers)
        saved_filters = list(root_logger.filters)
        try:
            worker = _load_voice_worker_module()
            self.assertEqual(worker.WORKER_VERSION, "1.1.0")

            self.assertEqual(
                worker._guess_av_format_hints(b"\x1a\x45\xdf\xa3rest", filename="a.bin", content_type=""),
                [None, "webm", "matroska"],
            )
            self.assertEqual(
                worker._guess_av_format_hints(b"OggS\x00\x02", filename="a.bin", content_type=""),
                [None, "ogg"],
            )
            self.assertEqual(
                worker._guess_av_format_hints(b"\x00\x00\x00\x18ftypmp42", filename="a.bin", content_type=""),
                [None, "mp4", "mov"],
            )
            self.assertEqual(
                worker._guess_av_format_hints(b"RIFF\x00\x00\x00\x00WAVE", filename="a.bin", content_type=""),
                [None, "wav"],
            )

            handler = _CaptureHandler()
            handler.addFilter(worker._RequestIdLogFilter())
            handler.setFormatter(logging.Formatter("[%(request_id)s] %(message)s"))
            worker_logger = worker.logger
            old_level = worker_logger.level
            worker_logger.setLevel(logging.INFO)
            worker_logger.addHandler(handler)

            try:
                with patch.dict(os.environ, {"VIREAD_VOICE_WORKER_TOKEN": "top-secret-token"}, clear=False):
                    client = TestClient(worker.app)

                    health = client.get("/health", headers={"X-Request-ID": "req-health-1"})
                    self.assertEqual(health.status_code, 200)
                    self.assertEqual(health.headers.get("x-request-id"), "req-health-1")
                    payload = health.json()
                    self.assertEqual(payload["version"], "1.1.0")
                    self.assertTrue(payload["auth_required"])

                    for method, path, body in (
                        ("GET", "/voices", None),
                        ("POST", "/tts", {"text": "Xin chào"}),
                        ("POST", "/tts/timed", {"words": ["Xin", "chào"]}),
                        ("POST", "/tts/phonics", {"steps": [{"id": "s1", "text": "ba"}]}),
                        ("POST", "/stt", None),
                    ):
                        unauth = client.request(method, path, json=body)
                        self.assertEqual(unauth.status_code, 401, f"{method} {path} should return 401 without token")
                        self.assertEqual(unauth.json()["detail"]["code"], "VOICE_WORKER_UNAUTHORIZED")

                        wrong = client.request(
                            method,
                            path,
                            json=body,
                            headers={"X-ViRead-Voice-Token": "wrong-token"},
                        )
                        self.assertEqual(wrong.status_code, 401)

                    ok = client.get(
                        "/voices",
                        headers={
                            "X-ViRead-Voice-Token": "top-secret-token",
                            "X-Request-ID": "req-voices-99",
                        },
                    )
                    self.assertEqual(ok.status_code, 200)
                    self.assertEqual(ok.headers.get("x-request-id"), "req-voices-99")
                    self.assertEqual(ok.json()["provider"], "local")
                    self.assertTrue(len(ok.json()["voices"]) > 0)

                joined_logs = "\n".join(handler.messages)
                self.assertIn("[req-voices-99]", joined_logs)
                self.assertNotIn("top-secret-token", joined_logs)
                self.assertNotIn("Xin chào", joined_logs)
            finally:
                worker_logger.removeHandler(handler)
                worker_logger.setLevel(old_level)
        finally:
            root_logger.handlers[:] = saved_handlers
            root_logger.filters[:] = saved_filters

    def test_worker_tts_timed_uses_in_memory_lru_cache_without_blocking_semaphore(self) -> None:
        import asyncio

        root_logger = logging.getLogger()
        saved_handlers = list(root_logger.handlers)
        saved_filters = list(root_logger.filters)
        try:
            worker = _load_voice_worker_module()
            worker._TTS_TIMED_MEM_CACHE.clear()
            synth_calls: list[tuple[str, str, float, str]] = []

            def _fake_timed_sync(_engine, text_nfc, preset, speed, *, preferred_media_type="audio/wav"):
                synth_calls.append((preset.voice_id, text_nfc, speed, preferred_media_type))
                return {
                    "audio_base64": "UklGRg==",
                    "media_type": preferred_media_type,
                    "provider": "local",
                    "voice_id": preset.voice_id,
                    "region": preset.region,
                    "model_version": worker.TTS_MODEL_VERSION,
                    "speed": speed,
                    "duration_seconds": 1.25,
                    "words": [{"word": w, "start": 0.0, "end": 0.5} for w in text_nfc.split()],
                }

            with (
                patch.dict(os.environ, {"VIREAD_VOICE_WORKER_TOKEN": ""}, clear=False),
                patch.object(worker, "_ensure_capability_loaded", AsyncMock()),
                patch.object(worker, "synthesize_timed_passage_sync", side_effect=_fake_timed_sync),
                patch.object(worker.runtime, "tts_engine", object()),
            ):
                client = TestClient(worker.app)
                payload = {
                    "text": "Con mèo nhỏ",
                    "voice_id": "local_north_truc_ly",
                    "speed": 1.0,
                    "audio_format": "mp3",
                }
                r1 = client.post("/tts/timed", json=payload)
                self.assertEqual(r1.status_code, 200)
                self.assertEqual(len(synth_calls), 1)
                self.assertEqual(r1.json()["media_type"], "audio/mpeg")

                # Even if tts_semaphore is locked (busy), repeat request hits RAM cache immediately!
                locked_sem = asyncio.Semaphore(0)
                with (
                    patch.object(worker.runtime, "tts_semaphore", locked_sem),
                    patch.object(worker, "QUEUE_WAIT_SECONDS", 0.05),
                ):
                    r2 = client.post("/tts/timed", json=payload)
                self.assertEqual(r2.status_code, 200)
                self.assertEqual(r2.json(), r1.json())
                self.assertEqual(len(synth_calls), 1)

                # Changing format, speed, voice, text, or precision must miss cache
                r_wav = client.post("/tts/timed", json={**payload, "audio_format": "wav"})
                self.assertEqual(r_wav.status_code, 200)
                self.assertEqual(len(synth_calls), 2)

                r_spd = client.post("/tts/timed", json={**payload, "speed": 0.85})
                self.assertEqual(r_spd.status_code, 200)
                self.assertEqual(len(synth_calls), 3)

                r_voice = client.post("/tts/timed", json={**payload, "voice_id": "local_south_thuc_doan"})
                self.assertEqual(r_voice.status_code, 200)
                self.assertEqual(len(synth_calls), 4)

                with patch.object(worker, "TTS_PRECISION", "fp32"):
                    r_prec = client.post("/tts/timed", json=payload)
                self.assertEqual(r_prec.status_code, 200)
                self.assertEqual(len(synth_calls), 5)

            # Bounded LRU eviction
            worker._TTS_TIMED_MEM_CACHE.clear()
            with patch.object(worker, "TTS_TIMED_MEM_CACHE_MAX_ENTRIES", 2):
                worker._timed_mem_cache_put("k1", {"v": 1})
                worker._timed_mem_cache_put("k2", {"v": 2})
                _ = worker._timed_mem_cache_get("k1")  # refresh k1
                worker._timed_mem_cache_put("k3", {"v": 3})  # evicts k2
                self.assertIsNotNone(worker._timed_mem_cache_get("k1"))
                self.assertIsNone(worker._timed_mem_cache_get("k2"))
                self.assertIsNotNone(worker._timed_mem_cache_get("k3"))
        finally:
            root_logger.handlers[:] = saved_handlers
            root_logger.filters[:] = saved_filters


if __name__ == "__main__":
    unittest.main()
