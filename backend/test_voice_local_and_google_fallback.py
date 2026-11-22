"""Contract & policy tests for Local-First Voice, Controlled Google Fallback, and SessionVoiceLock."""

from __future__ import annotations

import base64
import io
import os
import unittest
import wave
from unittest.mock import AsyncMock, patch
from uuid import UUID

import httpx

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id
from app.api.routes import voice as voice_routes
from app.api.routes import voice_studio as studio_routes
from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.google_voice_provider import (
    GoogleCloudVoiceProvider,
    reset_google_cooldowns,
)
from app.providers.local_voice_provider import (
    LocalPhonicsSpeech,
    LocalPhonicsStepTiming,
    LocalSynthesizedAudio,
    LocalTranscription,
    LocalVoiceProvider,
    LocalVoiceTechnicalError,
)
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    VoicePolicyContext,
    clear_voice_orchestrator_caches,
)

ACTOR_ID = UUID("22222222-2222-4222-8222-222222222222")


def _make_pcm_wav(duration_ms: int = 400, sr: int = 24000) -> bytes:
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
    app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
    voice_routes.get_voice_orchestrator = lambda: orchestrator  # type: ignore[assignment]
    studio_routes.get_voice_orchestrator = lambda: orchestrator  # type: ignore[assignment]
    return TestClient(app)


class LocalFirstAndFallbackPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_google_cooldowns()
        clear_voice_orchestrator_caches()
        self._orig_voice_factory = voice_routes.get_voice_orchestrator
        self._orig_studio_factory = studio_routes.get_voice_orchestrator

    def tearDown(self) -> None:
        voice_routes.get_voice_orchestrator = self._orig_voice_factory
        studio_routes.get_voice_orchestrator = self._orig_studio_factory

    def test_healthy_local_stt_and_tts_make_zero_google_calls(self) -> None:
        local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        local.transcribe = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalTranscription(
                text="hai mươi mốt",
                language_code="vi",
                language_probability=None,
                words=[{"text": "hai", "start": 0.0, "end": 0.2, "logprob": None}],
                provider="local",
            )
        )
        local.synthesize = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalSynthesizedAudio(
                content=_make_pcm_wav(),
                content_type="audio/wav",
                resolved_voice_id="local_central_ngoc_tran",
                region="central",
                model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
            )
        )
        google = GoogleCloudVoiceProvider(
            stt_api_key="test-google-stt-key", tts_api_key="test-google-tts-key"
        )
        google.transcribe = AsyncMock()  # type: ignore[method-assign]
        google.synthesize = AsyncMock()  # type: ignore[method-assign]

        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)
        with _make_app(orchestrator) as client:
            stt_resp = client.post(
                "/voice/speech-to-text",
                data={
                    "language_code": "vi",
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_stt": "true",
                    "session_id": "sess_1",
                    "page_id": "page_1",
                    "turn_id": "turn_1",
                },
                files={"file": ("clip.webm", b"webm-bytes", "audio/webm")},
            )
            tts_resp = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Chào con, hôm nay mình đọc bài mới nhé.",
                    "voice_id": "local_central_ngoc_tran",
                    "speed": 0.85,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                },
            )

        self.assertEqual(stt_resp.status_code, 200)
        self.assertEqual(stt_resp.headers["x-voice-provider"], "local")
        self.assertEqual(stt_resp.headers["x-voice-fallback"], "0")
        self.assertEqual(stt_resp.json()["text"], "hai mươi mốt")

        self.assertEqual(tts_resp.status_code, 200)
        self.assertEqual(tts_resp.headers["x-voice-provider"], "local")
        self.assertEqual(tts_resp.headers["x-resolved-voice-id"], "local_central_ngoc_tran")
        self.assertEqual(tts_resp.headers["x-voice-region"], "central")
        self.assertEqual(tts_resp.headers["x-voice-fallback"], "0")

        google.transcribe.assert_not_called()
        google.synthesize.assert_not_called()

    def test_quiet_or_mispronounced_local_stt_never_triggers_google_fallback(self) -> None:
        local = LocalVoiceProvider()
        local.transcribe = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalTranscription(
                text="",
                language_code="vi",
                language_probability=None,
                words=None,
                provider="local",
            )
        )
        google = GoogleCloudVoiceProvider(stt_api_key="test-google-stt-key")
        google.transcribe = AsyncMock()  # type: ignore[method-assign]

        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)
        with _make_app(orchestrator) as client:
            resp = client.post(
                "/voice/speech-to-text",
                data={
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_stt": "true",
                },
                files={"file": ("silence.webm", b"quiet-audio", "audio/webm")},
            )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["text"], "")
        self.assertEqual(resp.headers["x-voice-provider"], "local")
        google.transcribe.assert_not_called()

    def test_local_failure_with_local_only_or_stt_toggle_off_makes_zero_google_calls(
        self,
    ) -> None:
        local = LocalVoiceProvider()
        local.transcribe = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_STT_UNAVAILABLE"
            )
        )
        google = GoogleCloudVoiceProvider(stt_api_key="test-google-stt-key")
        google.transcribe = AsyncMock()  # type: ignore[method-assign]
        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)

        with _make_app(orchestrator) as client:
            r_local_only = client.post(
                "/voice/speech-to-text",
                data={"provider_mode": "local_only", "allow_google_stt": "true"},
                files={"file": ("a.webm", b"audio", "audio/webm")},
            )
            r_toggle_off = client.post(
                "/voice/speech-to-text",
                data={
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_stt": "false",
                },
                files={"file": ("a.webm", b"audio", "audio/webm")},
            )

        self.assertEqual(r_local_only.status_code, 503)
        self.assertEqual(r_local_only.json(), {"detail": {"code": "LOCAL_STT_UNAVAILABLE"}})
        self.assertEqual(r_toggle_off.status_code, 503)
        google.transcribe.assert_not_called()

    def test_local_technical_failure_with_google_stt_enabled_falls_back_once_and_deduplicates_turn(
        self,
    ) -> None:
        local = LocalVoiceProvider()
        local.transcribe = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_STT_TIMEOUT"
            )
        )

        google_http_calls: list[dict] = []

        class FakeGoogleClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, url, **kwargs):
                google_http_calls.append({"url": url, "headers": kwargs.get("headers")})
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {
                                "alternatives": [
                                    {
                                        "transcript": "hai mươi mốt",
                                        "confidence": 0.96,
                                        "words": [
                                            {"word": "hai", "startTime": "0.1s", "endTime": "0.3s"},
                                            {"word": "mươi", "startTime": "0.3s", "endTime": "0.6s"},
                                            {"word": "mốt", "startTime": "0.6s", "endTime": "0.95s"},
                                        ],
                                    }
                                ]
                            }
                        ]
                    },
                )

        google = GoogleCloudVoiceProvider(stt_api_key="server-only-google-key")
        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)

        with patch(
            "app.providers.google_voice_provider.httpx.AsyncClient", FakeGoogleClient
        ):
            with _make_app(orchestrator) as client:
                form_data = {
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_stt": "true",
                    "session_id": "sess_dup",
                    "page_id": "page_2",
                    "turn_id": "turn_7",
                }
                first = client.post(
                    "/voice/speech-to-text",
                    data=form_data,
                    files={"file": ("seg.webm", b"webm-audio", "audio/webm")},
                )
                # Duplicate submission of the exact same `(session_id, page_id, turn_id)`
                second = client.post(
                    "/voice/speech-to-text",
                    data=form_data,
                    files={"file": ("seg.webm", b"webm-audio", "audio/webm")},
                )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.headers["x-voice-provider"], "google")
        self.assertEqual(first.headers["x-voice-fallback"], "1")
        self.assertEqual(first.headers["x-voice-fallback-reason"], "LOCAL_STT_TIMEOUT")
        self.assertEqual(first.json()["text"], "hai mươi mốt")
        self.assertEqual(second.json()["text"], "hai mươi mốt")
        # Dedup guarantees Google was called ONLY ONCE across both requests!
        self.assertEqual(len(google_http_calls), 1)
        self.assertEqual(
            google_http_calls[0]["headers"],
            {"X-Goog-Api-Key": "server-only-google-key"},
        )

    def test_google_429_quota_trips_cooldown_preventing_retry_storm(self) -> None:
        local = LocalVoiceProvider()
        local.transcribe = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_STT_UNAVAILABLE"
            )
        )
        call_count = 0

        class QuotaClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, *_args, **_kwargs):
                nonlocal call_count
                call_count += 1
                return httpx.Response(429, json={"error": {"message": "Quota exceeded"}})

        google = GoogleCloudVoiceProvider(stt_api_key="quota-key")
        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)

        with patch(
            "app.providers.google_voice_provider.httpx.AsyncClient", QuotaClient
        ):
            with _make_app(orchestrator) as client:
                r1 = client.post(
                    "/voice/speech-to-text",
                    data={
                        "provider_mode": "local_with_google_fallback",
                        "allow_google_stt": "true",
                        "session_id": "s1",
                        "turn_id": "t1",
                    },
                    files={"file": ("a.webm", b"audio", "audio/webm")},
                )
                r2 = client.post(
                    "/voice/speech-to-text",
                    data={
                        "provider_mode": "local_with_google_fallback",
                        "allow_google_stt": "true",
                        "session_id": "s1",
                        "turn_id": "t2",
                    },
                    files={"file": ("a.webm", b"audio", "audio/webm")},
                )

        self.assertEqual(r1.status_code, 503)
        self.assertEqual(r1.json(), {"detail": {"code": "STT_QUOTA_EXCEEDED"}})
        # Second segment immediately sees cooldown and does NOT hit Google network again
        self.assertEqual(r2.status_code, 503)
        self.assertEqual(call_count, 1)

    def test_tts_session_voice_lock_never_switches_local_voice_to_google_on_local_failure(
        self,
    ) -> None:
        local = LocalVoiceProvider()
        local.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )
        )
        google = GoogleCloudVoiceProvider(tts_api_key="google-tts-key")
        google.synthesize = AsyncMock()  # type: ignore[method-assign]
        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)

        with _make_app(orchestrator) as client:
            resp = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Con đọc lại tiếng mốt nhé.",
                    "voice_id": "local_south_thuc_doan",
                    "speed": 1.0,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                    "session_id": "sess_locked_south",
                },
            )

        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp.json(), {"detail": {"code": "LOCAL_TTS_UNAVAILABLE"}})
        # Zero silent voice switching to Google!
        google.synthesize.assert_not_called()

    def test_phonics_endpoint_returns_sample_accurate_steps_for_mot_in_locked_voice(
        self,
    ) -> None:
        local = LocalVoiceProvider()
        wav_bytes = _make_pcm_wav(duration_ms=2800)
        local.synthesize_phonics = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalPhonicsSpeech(
                audio=wav_bytes,
                content_type="audio/wav",
                duration_seconds=2.8,
                step_timings=[
                    LocalPhonicsStepTiming(id="rhyme_build", index=0, start=0.08, end=0.72),
                    LocalPhonicsStepTiming(id="onset_blend", index=1, start=1.14, end=1.62),
                    LocalPhonicsStepTiming(id="tone_blend", index=2, start=2.04, end=2.48),
                    LocalPhonicsStepTiming(id="whole_syllable", index=3, start=2.55, end=2.8),
                ],
                resolved_voice_id="local_north_truc_ly",
                region="north",
                model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
                provider="local",
            )
        )
        orchestrator = VoiceOrchestrator(local_provider=local)

        with _make_app(orchestrator) as client:
            resp = client.post(
                "/voice/text-to-speech/phonics",
                json={
                    "voice_id": "local_north_truc_ly",
                    "speed": 0.85,
                    "steps": [
                        {"id": "rhyme_build", "spoken_text": "ô, tờ, ốt.", "pause_after_ms": 420},
                        {"id": "onset_blend", "spoken_text": "mờ, ốt.", "pause_after_ms": 420},
                        {"id": "tone_blend", "spoken_text": "sắc, mốt.", "pause_after_ms": 450},
                        {"id": "whole_syllable", "spoken_text": "mốt.", "pause_after_ms": 320},
                    ],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["provider"], "local")
        self.assertEqual(body["resolved_voice_id"], "local_north_truc_ly")
        self.assertEqual(body["region"], "north")
        self.assertEqual(len(body["step_timings"]), 4)
        self.assertEqual(base64.b64decode(body["audio_base64"]), wav_bytes)


if __name__ == "__main__":
    unittest.main()
