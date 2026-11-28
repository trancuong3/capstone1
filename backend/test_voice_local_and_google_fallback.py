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

from app.api.deps import require_active_profile_id
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
    build_contrastive_vietnamese_keyterms,
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
    app.dependency_overrides[require_active_profile_id] = lambda: ACTOR_ID
    voice_routes.get_voice_orchestrator = lambda: orchestrator  # type: ignore[assignment]
    studio_routes.get_voice_orchestrator = lambda: orchestrator  # type: ignore[assignment]
    return TestClient(app)


class LocalFirstAndFallbackPolicyTests(unittest.TestCase):
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
            {key: health_no_token[key] for key in ("available", "stt_ready", "tts_ready", "stt_model_version", "tts_model_version")},
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
                "X-ViRead-Voice-Token": "secret-worker-tok",
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

    def test_p2_4_timed_phonics_repair_wav_headers_and_mark_phonics_fallback(self) -> None:
        import asyncio
        import struct
        from app.providers.local_voice_provider import (
            LocalPhonicsSpeech,
            LocalPhonicsStepTiming,
        )

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
        bad_wav = bad_header + pcm_payload
        bad_b64 = base64.b64encode(bad_wav).decode("ascii")

        class FakeWorkerClient:
            is_closed = False

            async def post(self, url, **_kwargs):
                if url.endswith("/tts"):
                    return httpx.Response(
                        200,
                        content=bad_wav,
                        headers={"content-type": "audio/wav"},
                    )
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
        single = asyncio.run(local.synthesize(text="mèo"))
        timed = asyncio.run(local.synthesize_timed(words=["mèo"]))
        phonics = asyncio.run(
            local.synthesize_phonics(
                steps=[{"id": "s1", "spoken_text": "mờ", "pause_after_ms": 200}]
            )
        )
        self.assertEqual(struct.unpack_from("<I", single.content, 40)[0], len(pcm_payload))
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

    def test_contrastive_keyterms_and_local_google_logprob_propagation(self) -> None:
        import asyncio
        import json
        import math

        co_terms = build_contrastive_vietnamese_keyterms(["có"])
        self.assertLessEqual(len(co_terms), 14)
        for tone_pair in ("có", "co", "cò", "cỏ", "cõ", "cọ"):
            self.assertIn(tone_pair, co_terms)

        mot_terms = build_contrastive_vietnamese_keyterms(["một"])
        self.assertIn("một", mot_terms)
        self.assertIn("mốt", mot_terms)
        self.assertIn("mộc", mot_terms)
        self.assertIn("mộp", mot_terms)
        self.assertLessEqual(len(mot_terms), 14)

        hom_terms = build_contrastive_vietnamese_keyterms(["hôm"])
        self.assertIn("hôn", hom_terms)
        self.assertIn("hông", hom_terms)

        dua_terms = build_contrastive_vietnamese_keyterms(["đứa"])
        self.assertIn("dứa", dua_terms)

        # VoiceOrchestrator passes contrastive keyterms into both local and google transcribe,
        # and keeps keyterms=None when none are supplied.
        captured_local: list[dict] = []
        captured_google: list[dict] = []

        local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")

        async def _fake_local_transcribe(**kwargs):
            captured_local.append(kwargs)
            return LocalTranscription(
                text="có",
                language_code="vi",
                language_probability=None,
                words=[{"text": "có", "start": 0.0, "end": 0.25, "logprob": -0.35}],
            )

        local.transcribe = _fake_local_transcribe  # type: ignore[method-assign]
        google = GoogleCloudVoiceProvider(stt_api_key="test-google-key")

        async def _fake_google_transcribe(**kwargs):
            captured_google.append(kwargs)
            return LocalTranscription(
                text="có",
                language_code="vi",
                language_probability=0.92,
                words=[{"text": "có", "start": 0.0, "end": 0.25, "logprob": math.log(0.92)}],
                provider="google",
                fallback_used=True,
            )

        google.transcribe = _fake_google_transcribe  # type: ignore[method-assign]
        orch = VoiceOrchestrator(local_provider=local, google_provider=google)

        asyncio.run(
            orch.transcribe(
                audio=b"wav",
                filename="a.wav",
                content_type="audio/wav",
                keyterms=["có"],
            )
        )
        self.assertEqual(captured_local[-1]["keyterms"], co_terms)

        # Fallback path forwards contrastive keyterms to Google
        local.transcribe = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_STT_UNAVAILABLE")
        )
        asyncio.run(
            orch.transcribe(
                audio=b"wav",
                filename="b.wav",
                content_type="audio/wav",
                keyterms=["có"],
                policy=VoicePolicyContext(
                    provider_mode="local_with_google_fallback",
                    allow_google_stt=True,
                ),
            )
        )
        self.assertEqual(captured_google[-1]["keyterms"], co_terms)

        # LocalVoiceProvider forwards keyterms in multipart form & maps logprob
        posted_data: list[dict] = []

        class _LocalWorkerClient:
            is_closed = False

            async def post(self, _url, **kwargs):
                posted_data.append(kwargs.get("data") or {})
                return httpx.Response(
                    200,
                    json={
                        "text": "có",
                        "language_code": "vi",
                        "words": [
                            {"text": "có", "start": 0.05, "end": 0.30, "logprob": -0.42},
                            {"text": "nhé", "start": 0.31, "end": 0.50},
                        ],
                    },
                )

        real_local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        real_local._client = _LocalWorkerClient()  # type: ignore[assignment]
        local_tx = asyncio.run(
            real_local.transcribe(
                audio=b"RIFF-wav",
                filename="c.wav",
                content_type="audio/wav",
                keyterms=co_terms,
            )
        )
        self.assertEqual(json.loads(posted_data[-1]["keyterms"]), co_terms)
        self.assertEqual(local_tx.words[0]["logprob"], -0.42)
        self.assertIsNone(local_tx.words[1]["logprob"])

        # GoogleCloudVoiceProvider sets boost=8.0, maxAlternatives=3, and maps positive confidence to logprob
        google_payloads: list[dict] = []

        class _GoogleHttpClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, _url, **kwargs):
                google_payloads.append(kwargs.get("json") or {})
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {
                                "alternatives": [
                                    {
                                        "transcript": "có",
                                        "confidence": 0.9,
                                        "words": [
                                            {"word": "có", "startTime": "0.1s", "endTime": "0.3s"}
                                        ],
                                    }
                                ]
                            },
                            {
                                "alternatives": [
                                    {
                                        "transcript": "nhé",
                                        "confidence": 0.0,
                                        "words": [
                                            {"word": "nhé", "startTime": "0.3s", "endTime": "0.5s"}
                                        ],
                                    }
                                ]
                            },
                        ]
                    },
                )

        real_google = GoogleCloudVoiceProvider(stt_api_key="test-key")
        with patch(
            "app.providers.google_voice_provider.httpx.AsyncClient", _GoogleHttpClient
        ):
            g_tx = asyncio.run(
                real_google.transcribe(
                    audio=b"webm",
                    filename="c.webm",
                    content_type="audio/webm",
                    keyterms=co_terms,
                )
            )
        cfg = google_payloads[-1]["config"]
        self.assertEqual(cfg["maxAlternatives"], 3)
        self.assertEqual(cfg["speechContexts"], [{"phrases": co_terms, "boost": 8.0}])
        self.assertAlmostEqual(g_tx.words[0]["logprob"], math.log(0.9), places=6)
        self.assertIsNone(g_tx.words[1]["logprob"])

    def test_elevenlabs_serves_tts_timed_phonics_and_stt_when_local_offline(self) -> None:
        from app.providers.elevenlabs_voice_provider import (
            ElevenLabsVoiceProvider,
            SynthesizedAudio,
            Transcription,
        )

        down_local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        down_local.get_health = AsyncMock(  # type: ignore[method-assign]
            return_value={"configured": False, "available": False, "stt_ready": False, "tts_ready": False}
        )
        down_local.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE")
        )
        down_local.synthesize_timed = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE")
        )
        down_local.synthesize_phonics = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE")
        )
        down_local.transcribe = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_STT_UNAVAILABLE")
        )

        fake_mp3 = b"\xff\xfb\x90\x00" + (b"\x00" * 3996)  # 4000 bytes => 0.25s at 128kbps
        el = ElevenLabsVoiceProvider(api_key="sk_test_elevenlabs_key")
        el.synthesize = AsyncMock(  # type: ignore[method-assign]
            return_value=SynthesizedAudio(
                content=fake_mp3,
                content_type="audio/mpeg",
                resolved_voice_id="xeRzNgA5BGMAmllSnOuF",
                used_fallback_voice=False,
            )
        )
        el.transcribe = AsyncMock(  # type: ignore[method-assign]
            return_value=Transcription(
                text="bộ lông của miu",
                language_code="vie",
                language_probability=0.98,
                words=[{"text": "bộ", "start": 0.0, "end": 0.2}],
            )
        )
        google = GoogleCloudVoiceProvider(stt_api_key="", tts_api_key="")
        orch = VoiceOrchestrator(
            local_provider=down_local,
            google_provider=google,
            elevenlabs_provider=el,
        )

        with _make_app(orch) as client:
            status_resp = client.get("/voice/status")
            self.assertEqual(status_resp.status_code, 200)
            status_json = status_resp.json()
            self.assertTrue(status_json["elevenlabs"]["configured"])
            self.assertTrue(status_json["elevenlabs"]["tts_configured"])
            self.assertTrue(status_json["elevenlabs"]["stt_configured"])

            # TTS works with session_id when parent opted into cloud fallback & gender matches
            tts_resp = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Chị Dua đang bận ôn thi vào lớp mấy?",
                    "session_id": "sess_el_1",
                    "speed": 0.9,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                },
            )
            self.assertEqual(tts_resp.status_code, 200)
            self.assertEqual(tts_resp.headers["x-voice-provider"], "elevenlabs")
            self.assertEqual(tts_resp.headers["x-voice-fallback"], "0")

            # Strict gender consistency: requesting a MALE voice must NEVER silently switch to FEMALE ElevenLabs!
            male_resp = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Thầy đọc mẫu cho con nghe nhé.",
                    "voice_id": "local_north_thien_minh",
                    "speed": 0.9,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                },
            )
            self.assertEqual(male_resp.status_code, 503)

            # Strict offline-first: local_only mode must NEVER call ElevenLabs Online
            local_only_resp = client.post(
                "/voice/text-to-speech",
                json={
                    "text": "Chào con.",
                    "speed": 0.9,
                    "provider_mode": "local_only",
                    "allow_google_tts": False,
                },
            )
            self.assertEqual(local_only_resp.status_code, 503)

            # Timed TTS works
            timed_resp = client.post(
                "/voice/text-to-speech/timed",
                json={
                    "words": ["Bộ", "lông", "của", "Miu"],
                    "session_id": "sess_el_1",
                    "speed": 0.9,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                },
            )
            self.assertEqual(timed_resp.status_code, 200)
            timed_json = timed_resp.json()
            self.assertEqual(timed_json["provider"], "elevenlabs")
            self.assertEqual(len(timed_json["words"]), 4)

            # Phonics synthesizes EVERY spelling step (not just the whole word!)
            phonics_resp = client.post(
                "/voice/text-to-speech/phonics",
                json={
                    "steps": [
                        {"id": "rhyme", "spoken_text": "ô, tờ, ốt.", "pause_after_ms": 250},
                        {"id": "onset", "spoken_text": "mờ, ốt.", "pause_after_ms": 250},
                        {"id": "tone", "spoken_text": "sắc, mốt.", "pause_after_ms": 250},
                        {"id": "whole", "spoken_text": "mốt.", "pause_after_ms": 250},
                    ],
                    "session_id": "sess_el_1",
                    "speed": 0.85,
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_tts": True,
                },
            )
            self.assertEqual(phonics_resp.status_code, 200)
            phonics_json = phonics_resp.json()
            self.assertEqual(phonics_json["provider"], "elevenlabs")
            self.assertEqual(len(phonics_json["step_timings"]), 4)
            self.assertGreater(phonics_json["duration_seconds"], 0.5)

            # STT works via ElevenLabs Scribe v2 when opted-in
            stt_resp = client.post(
                "/voice/speech-to-text",
                data={
                    "language_code": "vi",
                    "session_id": "sess_el_1",
                    "turn_id": "t1",
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_stt": "true",
                },
                files={"file": ("clip.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 64, "audio/webm")},
            )
            self.assertEqual(stt_resp.status_code, 200)
            self.assertEqual(stt_resp.headers["x-voice-provider"], "elevenlabs")
            self.assertEqual(stt_resp.json()["text"], "bộ lông của miu")

    def test_transient_local_busy_retries_offline_without_switching_to_online(self) -> None:
        from app.providers.elevenlabs_voice_provider import ElevenLabsVoiceProvider

        flaky_local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        flaky_local.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=[
                LocalVoiceTechnicalError(503, "VOICE_WORKER_BUSY"),
                LocalSynthesizedAudio(
                    content=_make_pcm_wav(),
                    content_type="audio/wav",
                    resolved_voice_id="local_north_truc_ly",
                    region="north",
                    model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
                ),
            ]
        )
        flaky_local.transcribe = AsyncMock(  # type: ignore[method-assign]
            side_effect=[
                LocalVoiceTechnicalError(503, "LOCAL_STT_BUSY"),
                LocalTranscription(
                    text="con mèo",
                    language_code="vi",
                    language_probability=0.95,
                    words=[{"text": "con", "start": 0.0, "end": 0.2}],
                    provider="local",
                ),
            ]
        )
        el = ElevenLabsVoiceProvider(api_key="sk_test_elevenlabs_key")
        el.synthesize = AsyncMock()  # type: ignore[method-assign]
        el.transcribe = AsyncMock()  # type: ignore[method-assign]
        google = GoogleCloudVoiceProvider(stt_api_key="k", tts_api_key="k")
        google.synthesize = AsyncMock()  # type: ignore[method-assign]
        google.transcribe = AsyncMock()  # type: ignore[method-assign]

        orch = VoiceOrchestrator(
            local_provider=flaky_local,
            google_provider=google,
            elevenlabs_provider=el,
        )
        with _make_app(orch) as client:
            tts_resp = client.post(
                "/voice/text-to-speech",
                json={"text": "con mèo", "voice_id": "local_north_truc_ly", "speed": 1.0},
            )
            stt_resp = client.post(
                "/voice/speech-to-text",
                data={"language_code": "vi"},
                files={"file": ("clip.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 64, "audio/webm")},
            )

        self.assertEqual(tts_resp.status_code, 200)
        self.assertEqual(tts_resp.headers["x-voice-provider"], "local")
        self.assertEqual(stt_resp.status_code, 200)
        self.assertEqual(stt_resp.headers["x-voice-provider"], "local")
        el.synthesize.assert_not_called()
        el.transcribe.assert_not_called()
        google.synthesize.assert_not_called()
        google.transcribe.assert_not_called()

    def test_get_status_reports_elevenlabs_configuration_and_cooldown(self) -> None:
        import asyncio
        from unittest.mock import MagicMock
        from app.providers.elevenlabs_voice_provider import (
            ElevenLabsVoiceProvider,
            VoiceProviderError,
        )

        async def _scenario() -> None:
            el = ElevenLabsVoiceProvider(api_key="sk_test_elevenlabs_key")
            el.synthesize = AsyncMock(  # type: ignore[method-assign]
                side_effect=VoiceProviderError(
                    status_code=429,
                    code="ELEVENLABS_QUOTA_EXCEEDED",
                )
            )
            local = MagicMock(spec=LocalVoiceProvider)
            local.is_configured = False
            local.base_url = ""
            local.get_health = AsyncMock(
                return_value={
                    "configured": False,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_UNCONFIGURED",
                }
            )
            local.synthesize = AsyncMock(
                side_effect=LocalVoiceTechnicalError(503, "LOCAL_VOICE_UNCONFIGURED")
            )
            google = GoogleCloudVoiceProvider(stt_api_key="", tts_api_key="")
            orch = VoiceOrchestrator(
                local_provider=local,
                google_provider=google,
                elevenlabs_provider=el,
            )
            status_before = await orch.get_status()
            self.assertTrue(status_before["elevenlabs"]["configured"])
            self.assertFalse(status_before["elevenlabs"]["tts_cooldown"])
            self.assertFalse(status_before["elevenlabs"]["stt_cooldown"])

            with self.assertRaises(VoiceProviderError):
                await orch.synthesize(
                    text="xin chào",
                    speed=1.0,
                    policy=VoicePolicyContext(
                        provider_mode="local_with_google_fallback",
                        allow_google_tts=True,
                    ),
                )

            status_after = await orch.get_status()
            self.assertTrue(status_after["elevenlabs"]["configured"])
            self.assertTrue(status_after["elevenlabs"]["tts_cooldown"])

        asyncio.run(_scenario())


if __name__ == "__main__":
    unittest.main()
