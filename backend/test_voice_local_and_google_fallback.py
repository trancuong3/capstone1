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

    def test_fix_wav_header_sizes_repairs_streaming_placeholder_0x7ffff000(self) -> None:
        import struct
        from app.providers.local_voice_provider import fix_wav_header_sizes

        pcm_payload = b"\x00\x00" * 4800  # 0.1s @ 48kHz PCM_16 mono
        bad_header = struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",
            36 + 0x7FFFF000,
            b"WAVE",
            b"fmt ",
            16,
            1,
            1,
            48000,
            96000,
            2,
            16,
            b"data",
            0x7FFFF000,
        )
        fixed = fix_wav_header_sizes(bad_header + pcm_payload)
        self.assertEqual(len(fixed), 44 + len(pcm_payload))
        self.assertEqual(struct.unpack_from("<I", fixed, 4)[0], 36 + len(pcm_payload))
        self.assertEqual(struct.unpack_from("<I", fixed, 40)[0], len(pcm_payload))

    def test_p0_3_difficult_words_and_admin_system_use_voice_orchestrator_not_elevenlabs(self) -> None:
        import asyncio
        from unittest.mock import MagicMock
        from app.api.routes.system import AdminSystemService
        from app.services.difficult_words_service import DifficultWordsService

        dw_service = DifficultWordsService(MagicMock(), MagicMock())
        self.assertIsInstance(dw_service.voice_provider, VoiceOrchestrator)

        admin_service = AdminSystemService(MagicMock())
        self.assertIsInstance(admin_service.voice_provider, VoiceOrchestrator)

        # Verify probe_tts / probe_stt on VoiceOrchestrator report local-first status cleanly
        local = LocalVoiceProvider()
        local.get_health = AsyncMock(  # type: ignore[method-assign]
            return_value={
                "available": True,
                "stt_ready": True,
                "tts_ready": True,
                "stt_mode": "ws",
                "tts_precision": "hybrid",
                "active_voices": ["local_north_truc_ly", "local_south_thai_son"],
            }
        )
        google = GoogleCloudVoiceProvider(stt_api_key="", tts_api_key="")
        orch = VoiceOrchestrator(local_provider=local, google_provider=google)
        tts_status, tts_msg = asyncio.run(orch.probe_tts())
        stt_status, stt_msg = asyncio.run(orch.probe_stt())
        self.assertEqual(tts_status, "HEALTHY")
        self.assertIn("Local TTS", tts_msg)
        self.assertEqual(stt_status, "HEALTHY")
        self.assertIn("Local STT", stt_msg)

        # Local down + Google configured => DEGRADED
        local.get_health = AsyncMock(  # type: ignore[method-assign]
            return_value={"available": False, "stt_ready": False, "tts_ready": False}
        )
        orch_deg = VoiceOrchestrator(
            local_provider=local,
            google_provider=GoogleCloudVoiceProvider(
                stt_api_key="k1", tts_api_key="k2"
            ),
        )
        self.assertEqual(asyncio.run(orch_deg.probe_tts())[0], "DEGRADED")
        self.assertEqual(asyncio.run(orch_deg.probe_stt())[0], "DEGRADED")

    def test_p0_4_rolling_interim_never_falls_back_to_google_cloud_stt(self) -> None:
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
            resp = client.post(
                "/voice/speech-to-text",
                data={
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_stt": "true",
                    "source": "local_live_interim",
                },
                files={"file": ("interim.wav", b"RIFF-audio", "audio/wav")},
            )

        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp.json(), {"detail": {"code": "LOCAL_STT_UNAVAILABLE"}})
        google.transcribe.assert_not_called()

    def test_p1_7_keyterms_forwarded_and_logprob_populates_high_confidence_gate(self) -> None:
        import asyncio
        from app.services.difficult_words_service import has_high_confidence_keyterm_result

        captured_local_data: list[dict] = []

        class FakeLocalClient:
            is_closed = False

            async def post(self, _url, **kwargs):
                captured_local_data.append(dict(kwargs.get("data") or {}))
                return httpx.Response(
                    200,
                    json={
                        "text": "mặt trời",
                        "language_code": "vi",
                        "language_probability": 0.94,
                        "words": [
                            {"text": "mặt", "start": 0.0, "end": 0.2, "logprob": -0.05},
                            {"text": "trời", "start": 0.2, "end": 0.5, "logprob": -0.08},
                        ],
                    },
                )

        local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        local._client = FakeLocalClient()  # type: ignore[assignment]
        orch = VoiceOrchestrator(local_provider=local)
        local_res = asyncio.run(
            orch.transcribe(
                audio=b"RIFF-wav",
                filename="seg.wav",
                content_type="audio/wav",
                keyterms=["mặt trời", "cầu vồng"],
            )
        )
        self.assertEqual(captured_local_data[0].get("keyterms"), ["mặt trời", "cầu vồng"])
        self.assertIsNotNone(local_res.words)
        self.assertAlmostEqual(local_res.words[0]["logprob"], -0.05)  # type: ignore[index]
        self.assertTrue(has_high_confidence_keyterm_result(local_res))

        # Google STT sends boost=12.0 and populates word logprob from confidence
        captured_google_json: list[dict] = []

        class FakeGoogleSttClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, _url, **kwargs):
                captured_google_json.append(kwargs.get("json") or {})
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {
                                "alternatives": [
                                    {
                                        "transcript": "cầu vồng",
                                        "confidence": 0.92,
                                        "words": [
                                            {"word": "cầu", "startTime": "0s", "endTime": "0.2s", "confidence": 0.95},
                                            {"word": "vồng", "startTime": "0.2s", "endTime": "0.5s"},
                                        ],
                                    }
                                ]
                            }
                        ]
                    },
                )

        google = GoogleCloudVoiceProvider(stt_api_key="test-key")
        with patch("app.providers.google_voice_provider.httpx.AsyncClient", FakeGoogleSttClient):
            google_res = asyncio.run(
                google.transcribe(
                    audio=b"webm-audio",
                    filename="seg.webm",
                    content_type="audio/webm",
                    keyterms=["cầu vồng"],
                )
            )
        speech_ctx = captured_google_json[0]["config"]["speechContexts"][0]
        self.assertEqual(speech_ctx["phrases"], ["cầu vồng"])
        self.assertGreaterEqual(speech_ctx["boost"], 10.0)
        self.assertTrue(captured_google_json[0]["config"]["enableWordConfidence"])
        self.assertIsNotNone(google_res.words)
        self.assertIsNotNone(google_res.words[0]["logprob"])  # type: ignore[index]
        self.assertTrue(has_high_confidence_keyterm_result(google_res))

    def test_p1_8_tts_normalizer_and_google_phonics_parity(self) -> None:
        import asyncio
        from app.services.vietnamese_tts_normalizer import normalize_vietnamese_tts_text

        self.assertEqual(
            normalize_vietnamese_tts_text("Đáp án C: Quả táo."),
            "Đáp án xê, Quả táo.",
        )
        self.assertEqual(
            normalize_vietnamese_tts_text("Bạn nhỏ cầm … đi học."),
            "Bạn nhỏ cầm, chỗ trống, đi học.",
        )
        self.assertEqual(
            normalize_vietnamese_tts_text("đ", for_phonics_step=True),
            "đờ",
        )
        self.assertEqual(
            normalize_vietnamese_tts_text("ă", for_phonics_step=True),
            "á",
        )

        # Google synthesize_phonics passes for_phonics_step=True so "đ" becomes "đờ"
        sent_texts: list[str] = []
        sample_wav = _make_pcm_wav(duration_ms=200, sr=24000)

        class FakeGoogleTtsClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, _url, **kwargs):
                sent_texts.append(kwargs["json"]["input"]["text"])
                return httpx.Response(
                    200,
                    json={"audioContent": base64.b64encode(sample_wav).decode("ascii")},
                )

        google = GoogleCloudVoiceProvider(tts_api_key="test-key")
        with patch("app.providers.google_voice_provider.httpx.AsyncClient", FakeGoogleTtsClient):
            asyncio.run(
                google.synthesize_phonics(
                    steps=[
                        {"id": "onset", "spoken_text": "đ", "pause_after_ms": 200},
                        {"id": "rhyme", "spoken_text": "ă", "pause_after_ms": 200},
                    ],
                    voice_id="google_vi_vn_neural2_a",
                    speed=0.9,
                )
            )
        self.assertEqual(sent_texts, ["đờ", "á"])

    def test_p1_15_google_stt_does_not_misclassify_mp4_m4a_as_webm_opus(self) -> None:
        import asyncio
        from app.providers.google_voice_provider import _detect_google_encoding

        mp4_ftyp = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"
        with self.assertRaises(VoiceProviderError) as ctx:
            _detect_google_encoding("recording.m4a", "audio/mp4", mp4_ftyp)
        self.assertEqual(ctx.exception.status_code, 415)
        self.assertEqual(ctx.exception.code, "GOOGLE_STT_UNSUPPORTED_AUDIO_FORMAT")

        # When transcoder succeeds, transcribe sends LINEAR16 WAV instead of WEBM_OPUS
        wav_16k = _make_pcm_wav(duration_ms=200, sr=16000)
        captured_config: list[dict] = []

        class FakeGoogleClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, _url, **kwargs):
                captured_config.append(kwargs["json"]["config"])
                return httpx.Response(200, json={"results": []})

        google = GoogleCloudVoiceProvider(stt_api_key="test-key")
        with (
            patch(
                "app.providers.google_voice_provider._transcode_container_to_wav_16k_sync",
                return_value=wav_16k,
            ),
            patch("app.providers.google_voice_provider.httpx.AsyncClient", FakeGoogleClient),
        ):
            asyncio.run(
                google.transcribe(
                    audio=mp4_ftyp,
                    filename="ios.m4a",
                    content_type="audio/mp4",
                )
            )
        self.assertEqual(captured_config[0]["encoding"], "LINEAR16")
        self.assertEqual(captured_config[0]["sampleRateHertz"], 16000)

    def test_p1_9_slow_autostart_fails_fast_and_runs_in_background(self) -> None:
        import asyncio
        import time
        from app.services import local_voice_worker_bootstrap as bootstrap

        bootstrap.arm_local_voice_worker_autostart(True)
        self.addCleanup(bootstrap.reset_local_voice_worker_bootstrap_state)
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_ensure(**_kwargs):
            started.set()
            await release.wait()
            return True

        class AlwaysRefuseClient:
            is_closed = False

            async def post(self, url, **_kwargs):
                raise httpx.ConnectError(
                    "Connection refused", request=httpx.Request("POST", url)
                )

        async def _run():
            provider = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
            provider._client = AlwaysRefuseClient()  # type: ignore[assignment]
            t0 = time.perf_counter()
            with (
                patch.dict(
                    os.environ,
                    {"VIREAD_LOCAL_VOICE_INLINE_RECOVERY_WAIT_SECONDS": "0.08"},
                    clear=False,
                ),
                patch(
                    "app.providers.local_voice_provider.ensure_local_voice_worker_running",
                    side_effect=slow_ensure,
                ),
            ):
                with self.assertRaises(LocalVoiceTechnicalError):
                    await provider.transcribe(
                        audio=b"RIFF....",
                        filename="seg.wav",
                        content_type="audio/wav",
                    )
                elapsed = time.perf_counter() - t0
                self.assertLess(elapsed, 1.0)
                self.assertTrue(started.is_set())
                self.assertIsNotNone(provider._recovery_task)
                self.assertFalse(provider._recovery_task.done())  # type: ignore[union-attr]
                release.set()
                await provider._recovery_task  # type: ignore[misc]

        asyncio.run(_run())

    def test_p2_4_timed_phonics_repair_wav_headers_and_mark_phonics_fallback(self) -> None:
        import asyncio
        import struct

        pcm_payload = b"\x00\x00" * 2400
        bad_header = struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",
            36 + 0x7FFFF000,
            b"WAVE",
            b"fmt ",
            16,
            1,
            1,
            24000,
            48000,
            2,
            16,
            b"data",
            0x7FFFF000,
        )
        bad_b64 = base64.b64encode(bad_header + pcm_payload).decode("ascii")

        class FakeWorkerClient:
            is_closed = False

            async def post(self, url, **_kwargs):
                if url.endswith("/tts/timed"):
                    return httpx.Response(
                        200,
                        json={
                            "audio_base64": bad_b64,
                            "media_type": "audio/wav",
                            "duration_seconds": 0.1,
                            "words": [{"word": "mèo", "start": 0.0, "end": 0.1}],
                            "voice_id": "local_north_truc_ly",
                            "region": "north",
                        },
                    )
                return httpx.Response(
                    200,
                    json={
                        "audio_base64": bad_b64,
                        "media_type": "audio/wav",
                        "duration_seconds": 0.1,
                        "step_timings": [{"id": "s1", "start": 0.0, "end": 0.1}],
                        "voice_id": "local_north_truc_ly",
                        "region": "north",
                    },
                )

        local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        local._client = FakeWorkerClient()  # type: ignore[assignment]
        timed = asyncio.run(local.synthesize_timed(words=["mèo"]))
        phonics = asyncio.run(
            local.synthesize_phonics(
                steps=[{"id": "s1", "spoken_text": "mờ", "pause_after_ms": 200}]
            )
        )
        self.assertEqual(struct.unpack_from("<I", timed.audio, 40)[0], len(pcm_payload))
        self.assertEqual(struct.unpack_from("<I", phonics.audio, 40)[0], len(pcm_payload))

        # VoiceOrchestrator.synthesize_phonics sets used_fallback_voice=True on Google fallback
        down_local = LocalVoiceProvider()
        down_local.synthesize_phonics = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE")
        )
        google = GoogleCloudVoiceProvider(tts_api_key="test-key")
        google.synthesize_phonics = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalPhonicsSpeech(
                audio=_make_pcm_wav(),
                content_type="audio/wav",
                duration_seconds=0.4,
                step_timings=[LocalPhonicsStepTiming(id="s1", index=0, start=0.0, end=0.4)],
                resolved_voice_id="google_vi_vn_neural2_a",
                region="north",
                model_version="google-cloud-tts-v1",
                provider="google",
            )
        )
        orch = VoiceOrchestrator(local_provider=down_local, google_provider=google)
        fb = asyncio.run(
            orch.synthesize_phonics(
                steps=[{"id": "s1", "spoken_text": "mờ", "pause_after_ms": 200}],
                policy=VoicePolicyContext(
                    provider_mode="local_with_google_fallback",
                    allow_google_tts=True,
                ),
            )
        )
        self.assertTrue(fb.used_fallback_voice)


if __name__ == "__main__":
    unittest.main()
