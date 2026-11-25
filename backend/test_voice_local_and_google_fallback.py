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
    LocalTimedSpeech,
    LocalTimedWord,
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

    def test_unlocked_tts_falls_back_to_matching_google_voice_when_local_worker_down(
        self,
    ) -> None:
        wav_bytes = _make_pcm_wav(duration_ms=600)
        local = LocalVoiceProvider()
        local.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )
        )
        local.synthesize_timed = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )
        )
        local.synthesize_phonics = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(
                status_code=503, code="LOCAL_TTS_UNAVAILABLE"
            )
        )
        google = GoogleCloudVoiceProvider(tts_api_key="google-tts-key")
        google.synthesize = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalSynthesizedAudio(
                content=wav_bytes,
                content_type="audio/wav",
                resolved_voice_id="google_vi_vn_wavenet_b",
                region="south",
                model_version="google-cloud-tts-v1",
                provider="google",
                used_fallback_voice=False,
            )
        )
        google.synthesize_timed = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalTimedSpeech(
                audio=wav_bytes,
                content_type="audio/wav",
                duration_seconds=0.6,
                words=[LocalTimedWord(index=0, start=0.0, end=0.6)],
                resolved_voice_id="google_vi_vn_neural2_a",
                region="north",
                model_version="google-cloud-tts-v1",
                provider="google",
                used_fallback_voice=False,
            )
        )
        google.synthesize_phonics = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalPhonicsSpeech(
                audio=wav_bytes,
                content_type="audio/wav",
                duration_seconds=0.6,
                step_timings=[
                    LocalPhonicsStepTiming(id="whole", index=0, start=0.0, end=0.6)
                ],
                resolved_voice_id="google_vi_vn_neural2_d",
                region="north",
                model_version="google-cloud-tts-v1",
                provider="google",
            )
        )
        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)

        with _make_app(orchestrator) as client:
            # 1. Unlocked preview (no session_id) with Southern male local voice -> maps to google_vi_vn_wavenet_b
            preview_resp = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Chào con, hôm nay mình đọc bài nhé.",
                    "voice_id": "local_south_thai_son",
                    "speed": 0.9,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                },
            )
            # 2. Unlocked timed TTS with Northern female local voice -> maps to google_vi_vn_neural2_a
            timed_resp = client.post(
                "/voice/text-to-speech/timed",
                json={
                    "words": ["Chào"],
                    "voice_id": "local_north_truc_ly",
                    "speed": 1.0,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                },
            )
            # 3. Unlocked phonics TTS with Northern male local voice -> maps to google_vi_vn_neural2_d
            phonics_resp = client.post(
                "/voice/text-to-speech/phonics",
                json={
                    "voice_id": "local_north_thien_minh",
                    "speed": 0.85,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                    "steps": [
                        {"id": "whole", "spoken_text": "mốt.", "pause_after_ms": 200}
                    ],
                },
            )

        self.assertEqual(preview_resp.status_code, 200)
        self.assertEqual(preview_resp.headers["x-voice-provider"], "google")
        self.assertEqual(
            preview_resp.headers["x-resolved-voice-id"], "google_vi_vn_wavenet_b"
        )
        self.assertEqual(preview_resp.headers["x-voice-fallback"], "1")
        google.synthesize.assert_awaited_once_with(
            text="Chào con, hôm nay mình đọc bài nhé.",
            voice_id="google_vi_vn_wavenet_b",
            speed=0.9,
        )

        self.assertEqual(timed_resp.status_code, 200)
        timed_body = timed_resp.json()
        self.assertEqual(timed_body["provider"], "google")
        self.assertEqual(timed_body["resolved_voice_id"], "google_vi_vn_neural2_a")
        self.assertTrue(timed_body["used_fallback_voice"])
        google.synthesize_timed.assert_awaited_once_with(
            words=["Chào"],
            voice_id="google_vi_vn_neural2_a",
            speed=1.0,
        )

        self.assertEqual(phonics_resp.status_code, 200)
        phonics_body = phonics_resp.json()
        self.assertEqual(phonics_body["provider"], "google")
        self.assertEqual(phonics_body["resolved_voice_id"], "google_vi_vn_neural2_d")
        google.synthesize_phonics.assert_awaited_once()

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

    def test_get_health_marks_auth_required_worker_unavailable_without_token(
        self,
    ) -> None:
        import asyncio

        recorded_headers: list[dict[str, str] | None] = []

        class AuthGatedHealthClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, url, **kwargs):
                recorded_headers.append(kwargs.get("headers"))
                if url.endswith("/voices"):
                    if not kwargs.get("headers"):
                        return httpx.Response(401, json={"detail": "unauthorized"})
                    return httpx.Response(
                        200,
                        json={
                            "model_version": "vieneu-v3-turbo-onnx-fp32-3.8.5",
                            "voices": [
                                {
                                    "voice_id": "local_north_truc_ly",
                                    "name": "Cô Trúc Ly",
                                    "region": "north",
                                    "region_label": "Miền Bắc",
                                    "gender": "female",
                                    "is_default": True,
                                }
                            ],
                        },
                    )
                return httpx.Response(
                    200,
                    json={
                        "status": "ok",
                        "auth_required": True,
                        "stt": {"ready": True},
                        "tts": {"ready": True},
                    },
                )

        with patch(
            "app.providers.local_voice_provider.httpx.AsyncClient",
            AuthGatedHealthClient,
        ):
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("VIREAD_LOCAL_VOICE_WORKER_TOKEN", None)
                provider_no_token = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
                health_no_token = asyncio.run(provider_no_token.get_health())
                voices_no_token, live_no_token = asyncio.run(
                    provider_no_token.list_voices()
                )

            with patch.dict(
                os.environ,
                {"VIREAD_LOCAL_VOICE_WORKER_TOKEN": "secret-worker-tok"},
                clear=False,
            ):
                provider_with_token = LocalVoiceProvider(
                    base_url="http://127.0.0.1:8010"
                )
                health_with_token = asyncio.run(provider_with_token.get_health())
                voices_with_token, live_with_token = asyncio.run(
                    provider_with_token.list_voices()
                )

        self.assertEqual(
            health_no_token,
            {
                "available": False,
                "stt_ready": False,
                "tts_ready": False,
                "stt_model_version": None,
                "tts_model_version": None,
            },
        )
        self.assertFalse(live_no_token)
        self.assertGreater(len(voices_no_token), 0)

        self.assertTrue(health_with_token["available"])
        self.assertTrue(health_with_token["stt_ready"])
        self.assertTrue(health_with_token["tts_ready"])
        self.assertIn("stt_mode", health_with_token)
        self.assertIn("tts_precision", health_with_token)
        self.assertTrue(live_with_token)
        self.assertEqual(voices_with_token[0]["voice_id"], "local_north_truc_ly")
        self.assertEqual(
            recorded_headers[-1],
            {
                "Authorization": "Bearer secret-worker-tok",
                "X-ViRead-Worker-Token": "secret-worker-tok",
            },
        )

    def test_transient_remote_protocol_error_resets_client_and_recovers_with_zero_google_calls(
        self,
    ) -> None:
        import asyncio

        created_clients: list[object] = []
        closed_count = 0
        post_attempts = 0

        class FlakyKeepaliveClient:
            def __init__(self, **_kwargs):
                self.is_closed = False
                created_clients.append(self)

            async def post(self, url, **_kwargs):
                nonlocal post_attempts
                post_attempts += 1
                if post_attempts == 1:
                    raise httpx.RemoteProtocolError(
                        "Server disconnected without sending a response.",
                        request=httpx.Request("POST", url),
                    )
                if post_attempts == 2:
                    return httpx.Response(503, json={"detail": "busy"})
                return httpx.Response(
                    200,
                    json={
                        "text": "hai mươi mốt",
                        "language_code": "vi",
                        "words": [
                            {"text": "hai", "start": 0.0, "end": 0.2},
                            {"text": "mươi", "start": 0.2, "end": 0.4},
                            {"text": "mốt", "start": 0.4, "end": 0.7},
                        ],
                    },
                )

            async def aclose(self):
                nonlocal closed_count
                self.is_closed = True
                closed_count += 1

        local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        google = GoogleCloudVoiceProvider(stt_api_key="test-google-stt-key")
        google.transcribe = AsyncMock()  # type: ignore[method-assign]
        orchestrator = VoiceOrchestrator(local_provider=local, google_provider=google)

        with (
            patch(
                "app.providers.local_voice_provider.httpx.AsyncClient",
                FlakyKeepaliveClient,
            ),
            patch(
                "app.providers.local_voice_provider.asyncio.sleep",
                new=AsyncMock(),
            ),
        ):
            result = asyncio.run(
                orchestrator.transcribe(
                    audio=b"RIFF-fake-wav",
                    filename="seg.wav",
                    content_type="audio/wav",
                    language_code="vi",
                    policy=VoicePolicyContext(
                        provider_mode="local_with_google_fallback",
                        allow_google_stt=True,
                        session_id="sess-recover",
                        page_id="page-1",
                        turn_id="turn-1",
                    ),
                )
            )

        self.assertEqual(result.text, "hai mươi mốt")
        self.assertEqual(result.provider, "local")
        self.assertFalse(result.fallback_used)
        self.assertEqual(post_attempts, 3)
        # Stale keepalive client was closed and replaced with a brand-new client!
        self.assertEqual(closed_count, 1)
        self.assertEqual(len(created_clients), 2)
        google.transcribe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
