"""Phase 1 regression tests for STT WebSocket unconfigured fast-fail, X-Voice-Lock-Update, and opted-in LOCAL_VOICE_UNCONFIGURED fallback."""

from __future__ import annotations

import base64
import io
import os
import unittest
import wave
from unittest.mock import AsyncMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.deps import require_active_profile_id
from app.api.routes import voice as voice_routes
from app.api.routes import voice_studio as studio_routes
from app.providers.elevenlabs_voice_provider import ElevenLabsVoiceProvider
from app.providers.google_voice_provider import (
    GoogleCloudVoiceProvider,
    reset_google_cooldowns,
)
from app.providers.local_voice_provider import (
    LocalPhonicsSpeech,
    LocalPhonicsStepTiming,
    LocalSynthesizedAudio,
    LocalTimedSpeech,
    LocalTimedWord,
    LocalVoiceProvider,
    LocalVoiceTechnicalError,
)
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    clear_voice_orchestrator_caches,
)

ACTOR_ID = UUID("44444444-4444-4444-8444-444444444444")


def _make_pcm_wav(duration_ms: int = 300, sr: int = 24000) -> bytes:
    buf = io.BytesIO()
    n_samples = int(sr * (duration_ms / 1000.0))
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(b"\x00\x00" * n_samples)
    return buf.getvalue()


def _make_app(orchestrator: VoiceOrchestrator) -> TestClient:
    app = FastAPI()
    app.include_router(voice_routes.router, prefix="/voice")
    app.include_router(studio_routes.router, prefix="/voice")
    app.dependency_overrides[require_active_profile_id] = lambda: ACTOR_ID
    voice_routes.get_voice_orchestrator = lambda: orchestrator  # type: ignore[assignment]
    studio_routes.get_voice_orchestrator = lambda: orchestrator  # type: ignore[assignment]
    return TestClient(app)


class Phase1ReadingVoiceRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._env_patch = patch.dict(os.environ, {"ELEVENLABS_API_KEY": ""}, clear=False)
        self._env_patch.start()
        reset_google_cooldowns()
        clear_voice_orchestrator_caches()
        self._orig_voice_factory = voice_routes.get_voice_orchestrator
        self._orig_studio_factory = studio_routes.get_voice_orchestrator

    def tearDown(self) -> None:
        voice_routes.get_voice_orchestrator = self._orig_voice_factory
        studio_routes.get_voice_orchestrator = self._orig_studio_factory
        self._env_patch.stop()

    def test_ws_stt_stream_fast_fails_when_local_worker_unconfigured(self) -> None:
        local = LocalVoiceProvider(base_url="")
        self.assertFalse(local.is_configured())
        orchestrator = VoiceOrchestrator(local_provider=local)

        with patch("app.api.routes.voice.open_local_stt_ws") as mock_dial:
            with _make_app(orchestrator) as client:
                with client.websocket_connect("/voice/stt-stream") as ws:
                    err = ws.receive_json()
                    self.assertEqual(err["type"], "error")
                    self.assertEqual(err["code"], "LOCAL_VOICE_UNCONFIGURED")
                    self.assertFalse(err["retryable"])
                    with self.assertRaises(WebSocketDisconnect) as ctx:
                        ws.receive_text()
                    self.assertEqual(ctx.exception.code, 1013)

        mock_dial.assert_not_called()

    def test_session_voice_lock_blocks_silent_switch_but_allows_explicit_update_header(self) -> None:
        wav_bytes = _make_pcm_wav()
        local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        local.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=[
                LocalSynthesizedAudio(
                    content=wav_bytes,
                    content_type="audio/wav",
                    resolved_voice_id="local_north_truc_ly",
                    region="north",
                    model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
                ),
                LocalSynthesizedAudio(
                    content=wav_bytes,
                    content_type="audio/wav",
                    resolved_voice_id="local_south_thuc_doan",
                    region="south",
                    model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
                ),
            ]
        )
        local.synthesize_phonics = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalPhonicsSpeech(
                audio=wav_bytes,
                content_type="audio/wav",
                duration_seconds=0.3,
                step_timings=[LocalPhonicsStepTiming(id="whole", index=0, start=0.0, end=0.3)],
                resolved_voice_id="local_central_ngoc_tran",
                region="central",
                model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
            )
        )
        local.synthesize_timed = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalTimedSpeech(
                audio=wav_bytes,
                content_type="audio/wav",
                duration_seconds=0.3,
                words=[LocalTimedWord(index=0, start=0.0, end=0.3)],
                resolved_voice_id="local_north_thien_minh",
                region="north",
                model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
            )
        )
        orchestrator = VoiceOrchestrator(local_provider=local)

        with _make_app(orchestrator) as client:
            r1 = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Chào con.",
                    "voice_id": "local_north_truc_ly",
                    "session_id": "sess-switch-1",
                },
            )
            r_blocked = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Đọc lại nhé.",
                    "voice_id": "local_south_thuc_doan",
                    "session_id": "sess-switch-1",
                },
            )
            r_explicit = client.post(
                "/voice/text-to-speech",
                headers={"X-Voice-Lock-Update": "1"},
                json={
                    "text": "Đọc lại nhé.",
                    "voice_id": "local_south_thuc_doan",
                    "session_id": "sess-switch-1",
                },
            )
            r_phonics = client.post(
                "/voice/text-to-speech/phonics",
                headers={"X-Voice-Lock-Update": "1"},
                json={
                    "voice_id": "local_central_ngoc_tran",
                    "session_id": "sess-switch-1",
                    "steps": [{"id": "whole", "spoken_text": "mốt.", "pause_after_ms": 200}],
                },
            )
            r_timed = client.post(
                "/voice/text-to-speech/timed",
                headers={"X-Voice-Lock-Update": "1"},
                json={
                    "words": ["Chào"],
                    "voice_id": "local_north_thien_minh",
                    "session_id": "sess-switch-1",
                },
            )

        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r_blocked.status_code, 409)
        self.assertEqual(r_blocked.json(), {"detail": {"code": "SESSION_VOICE_LOCKED"}})
        self.assertEqual(r_explicit.status_code, 200)
        self.assertEqual(r_explicit.headers["x-resolved-voice-id"], "local_south_thuc_doan")
        self.assertEqual(r_phonics.status_code, 200)
        self.assertEqual(r_phonics.json()["resolved_voice_id"], "local_central_ngoc_tran")
        self.assertEqual(r_timed.status_code, 200)
        self.assertEqual(r_timed.json()["resolved_voice_id"], "local_north_thien_minh")

    def test_locked_session_fallback_requires_opted_in_policy_and_unconfigured_local(self) -> None:
        wav_bytes = _make_pcm_wav()
        local_unconfigured = LocalVoiceProvider(base_url="")
        google = GoogleCloudVoiceProvider(tts_api_key="google-tts-key")
        google.synthesize = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalSynthesizedAudio(
                content=wav_bytes,
                content_type="audio/wav",
                resolved_voice_id="google_vi_vn_wavenet_c",
                region="south",
                model_version="google-cloud-tts-v1",
                provider="google",
                used_fallback_voice=False,
            )
        )
        orchestrator = VoiceOrchestrator(
            local_provider=local_unconfigured,
            google_provider=google,
            elevenlabs_provider=ElevenLabsVoiceProvider(api_key=""),
        )

        with _make_app(orchestrator) as client:
            r_local_only = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Mèo",
                    "voice_id": "local_south_thuc_doan",
                    "provider_mode": "local_only",
                    "allow_google_tts": True,
                    "session_id": "sess-private-lock",
                },
            )
            r_turn1 = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Mèo",
                    "voice_id": "local_south_thuc_doan",
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                    "session_id": "sess-opted-in-lock",
                },
            )
            r_turn2 = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Chú mèo.",
                    "voice_id": "local_south_thuc_doan",
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                    "session_id": "sess-opted-in-lock",
                },
            )

        self.assertEqual(r_local_only.status_code, 503)
        self.assertEqual(r_local_only.json(), {"detail": {"code": "LOCAL_VOICE_UNCONFIGURED"}})
        self.assertEqual(r_turn1.status_code, 200)
        self.assertEqual(r_turn1.headers["x-voice-provider"], "google")
        self.assertEqual(r_turn1.headers["x-voice-fallback"], "1")
        self.assertEqual(r_turn2.status_code, 200)
        self.assertEqual(r_turn2.headers["x-voice-provider"], "google")
        self.assertEqual(google.synthesize.await_count, 2)

        # Transient outage on a configured worker stays locked (no Google cascade mid-session)
        local_down = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        local_down.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_TTS_UNAVAILABLE")
        )
        google.synthesize.reset_mock()
        orch_down = VoiceOrchestrator(
            local_provider=local_down,
            google_provider=google,
            elevenlabs_provider=ElevenLabsVoiceProvider(api_key=""),
        )
        with _make_app(orch_down) as client:
            r_outage = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Mèo",
                    "voice_id": "local_south_thuc_doan",
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                    "session_id": "sess-outage-lock",
                },
            )
        self.assertEqual(r_outage.status_code, 503)
        self.assertEqual(r_outage.json(), {"detail": {"code": "LOCAL_TTS_UNAVAILABLE"}})
        google.synthesize.assert_not_called()


if __name__ == "__main__":
    unittest.main()
