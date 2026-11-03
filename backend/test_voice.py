"""Focused contract tests for the isolated ElevenLabs voice routes."""

import asyncio
import hashlib
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import httpx

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id
from app.api.routes import voice as voice_routes
from app.providers.elevenlabs_voice_provider import (
    SynthesizedAudio,
    Transcription,
    VoiceProviderError,
    ElevenLabsVoiceProvider,
)


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")


def make_client(authenticated: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(voice_routes.router, prefix="/voice")
    if authenticated:
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
    return TestClient(app)





def run_mocked_transcription(responses, api_key="unit-test-secret"):
    class MockAsyncClient:
        request_count = 0

        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            type(self).request_count += 1
            return responses.pop(0)

    provider = ElevenLabsVoiceProvider(api_key=api_key)
    with patch(
        "app.providers.elevenlabs_voice_provider.httpx.AsyncClient",
        MockAsyncClient,
    ):
        try:
            result = asyncio.run(
                provider.transcribe(
                    audio=b"audio-bytes",
                    filename="reading.webm",
                    content_type="audio/webm",
                    language_code="vi",
                )
            )
        except VoiceProviderError as error:
            return error, MockAsyncClient.request_count
    return result, MockAsyncClient.request_count


class VoiceRouteTests(unittest.TestCase):
    def test_text_to_speech_returns_provider_audio_without_provider_details(self):
        provider = MagicMock()
        provider.synthesize = AsyncMock(
            return_value=SynthesizedAudio(content=b"mp3-bytes", content_type="audio/mpeg")
        )

        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/text-to-speech",
                    json={"text": "  Bé đọc cùng mình nhé.  ", "voice_id": "voice_123"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"mp3-bytes")
        self.assertEqual(response.headers["content-type"], "audio/mpeg")
        self.assertEqual(response.headers["cache-control"], "no-store")
        provider.synthesize.assert_awaited_once_with(
            text="Bé đọc cùng mình nhé.", requested_voice_id="voice_123"
        )

    def test_text_to_speech_requires_authenticated_request(self):
        with make_client(authenticated=False) as client:
            response = client.post("/voice/text-to-speech", json={"text": "Xin chào"})
        self.assertEqual(response.status_code, 401)

    def test_text_to_speech_rejects_blank_or_oversized_content_before_provider(self):
        provider = MagicMock()
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                blank = client.post("/voice/text-to-speech", json={"text": "   "})
                oversized = client.post(
                    "/voice/text-to-speech", json={"text": "a" * 2_501}
                )
        self.assertEqual(blank.status_code, 422)
        self.assertEqual(oversized.status_code, 422)
        provider.synthesize.assert_not_called()

    def test_text_to_speech_hides_provider_failure_details(self):
        provider = MagicMock()
        provider.synthesize = AsyncMock(side_effect=VoiceProviderError())
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post("/voice/text-to-speech", json={"text": "Xin chào"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": {"code": "SPEECH_UNAVAILABLE"}})
        self.assertNotIn("ElevenLabs", response.text)

    def test_speech_to_text_passes_audio_in_memory_and_returns_safe_transcript(self):
        provider = MagicMock()
        provider.transcribe = AsyncMock(
            return_value=Transcription(
                text="Con mèo đang ngủ.",
                language_code="vi",
                language_probability=0.99,
            )
        )
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    data={"language_code": "vi"},
                    files={"file": ("reading.webm", b"audio-bytes", "audio/webm")},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "text": "Con mèo đang ngủ.",
                "language_code": "vi",
                "language_probability": 0.99,
                "words": None,
            },
        )
        provider.transcribe.assert_awaited_once_with(
            audio=b"audio-bytes",
            filename="reading.webm",
            content_type="audio/webm",
            language_code="vi",
        )

    def test_speech_to_text_rejects_non_audio_and_never_forwards_it(self):
        provider = MagicMock()
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("notes.txt", b"not audio", "text/plain")},
                )
        self.assertEqual(response.status_code, 415)
        self.assertEqual(response.json(), {"detail": {"code": "UNSUPPORTED_AUDIO"}})
        provider.transcribe.assert_not_called()

    def test_speech_to_text_returns_safe_specific_quota_code(self):
        provider = MagicMock()
        provider.transcribe = AsyncMock(
            side_effect=VoiceProviderError(
                status_code=503,
                code="STT_QUOTA_EXCEEDED",
            )
        )
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("reading.webm", b"audio-bytes", "audio/webm")},
                )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {"detail": {"code": "STT_QUOTA_EXCEEDED"}},
        )
        self.assertNotIn("credits", response.text.lower())
        self.assertNotIn("ElevenLabs", response.text)

    def test_provider_classifies_nested_quota_exceeded_without_exposing_body(self):
        class MockAsyncClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, *_args, **_kwargs):
                return httpx.Response(
                    401,
                    json={
                        "detail": {
                            "type": "invalid_request",
                            "code": "quota_exceeded",
                            "message": "0 credits remaining; 22 credits required",
                        }
                    },
                )

        provider = ElevenLabsVoiceProvider(api_key="isolated-test-key")
        with patch(
            "app.providers.elevenlabs_voice_provider.httpx.AsyncClient",
            MockAsyncClient,
        ):
            with self.assertRaises(VoiceProviderError) as caught:
                asyncio.run(
                    provider.transcribe(
                        audio=b"audio-bytes",
                        filename="reading.webm",
                        content_type="audio/webm",
                        language_code="vi",
                    )
                )

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.code, "STT_QUOTA_EXCEEDED")
        self.assertNotIn("credits", str(caught.exception).lower())

    def test_provider_reads_new_environment_key_and_logs_only_fingerprint(self):
        secret = "new-elevenlabs-key-for-this-test"
        expected = hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12]
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": secret}, clear=False):
            with self.assertLogs(
                "app.providers.elevenlabs_voice_provider", level="INFO"
            ) as captured:
                provider = ElevenLabsVoiceProvider()

        self.assertEqual(provider._key_fingerprint, expected)
        diagnostic = "\n".join(captured.output)
        self.assertIn(expected, diagnostic)
        self.assertNotIn(secret, diagnostic)

    def test_provider_distinguishes_auth_permission_terms_and_limit_errors(self):
        cases = [
            (
                401,
                {"detail": {"code": "invalid_api_key", "message": "Invalid API key"}},
                "STT_AUTH_FAILED",
            ),
            (
                403,
                {"detail": {"code": "unaccepted_terms", "message": "Accept terms"}},
                "STT_TERMS_NOT_ACCEPTED",
            ),
            (
                403,
                {"detail": {"code": "permission_denied", "message": "No Scribe access"}},
                "STT_PERMISSION_DENIED",
            ),
            (
                429,
                {"detail": {"code": "concurrent_limit_exceeded", "message": "Too many active"}},
                "STT_CONCURRENCY_LIMITED",
            ),
            (
                429,
                {"detail": {"code": "rate_limit_exceeded", "message": "Rate limited"}},
                "STT_RATE_LIMITED",
            ),
            (
                422,
                {"detail": {"code": "invalid_audio", "message": "Audio rejected"}},
                "STT_INVALID_AUDIO",
            ),
        ]

        for status_code, payload, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                error, calls = run_mocked_transcription(
                    [httpx.Response(status_code, json=payload)]
                )
                self.assertIsInstance(error, VoiceProviderError)
                self.assertEqual(error.code, expected_code)
                self.assertEqual(calls, 1)

    def test_provider_logs_body_request_id_and_redacts_key_from_provider_message(self):
        secret = "unit-test-secret-provider-key"

        class MockAsyncClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, *_args, **_kwargs):
                return httpx.Response(
                    403,
                    json={
                        "detail": {
                            "type": "authorization_error",
                            "code": "model_access_denied",
                            "message": f"Request rejected for key {secret}",
                            "request_id": "elevenlabs-request-123",
                        }
                    },
                )

        provider = ElevenLabsVoiceProvider(api_key=secret)
        with (
            patch(
                "app.providers.elevenlabs_voice_provider.httpx.AsyncClient",
                MockAsyncClient,
            ),
            self.assertLogs(
                "app.providers.elevenlabs_voice_provider", level="WARNING"
            ) as captured,
        ):
            with self.assertRaises(VoiceProviderError) as caught:
                asyncio.run(
                    provider.transcribe(
                        audio=b"audio-bytes",
                        filename="reading.webm",
                        content_type="audio/webm",
                        language_code="vi",
                    )
                )

        diagnostic = "\n".join(captured.output)
        self.assertEqual(caught.exception.code, "STT_PERMISSION_DENIED")
        self.assertIn("elevenlabs-request-123", diagnostic)
        self.assertIn("provider_code=model_access_denied", diagnostic)
        self.assertIn("[REDACTED]", diagnostic)
        self.assertNotIn(secret, diagnostic)

    def test_provider_retries_one_temporary_server_failure_with_a_bound(self):
        result, calls = run_mocked_transcription(
            [
                httpx.Response(503, json={"detail": {"code": "server_error"}}),
                httpx.Response(
                    200,
                    json={
                        "text": "Con mèo",
                        "language_code": "vi",
                        "language_probability": 0.99,
                    },
                ),
            ]
        )
        self.assertIsInstance(result, Transcription)
        self.assertEqual(result.text, "Con mèo")
        self.assertEqual(calls, 2)

    def test_provider_does_not_retry_quota_or_authentication_failures(self):
        error, calls = run_mocked_transcription(
            [
                httpx.Response(
                    503,
                    json={
                        "detail": {
                            "code": "quota_exceeded",
                            "message": "0 credits remaining",
                        }
                    },
                ),
                httpx.Response(200, json={"text": "should not be used"}),
            ]
        )
        self.assertIsInstance(error, VoiceProviderError)
        self.assertEqual(error.code, "STT_QUOTA_EXCEEDED")
        self.assertEqual(calls, 1)

    def test_speech_to_text_hides_provider_failure_details(self):
        provider = MagicMock()
        provider.transcribe = AsyncMock(side_effect=VoiceProviderError(status_code=503))
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("reading.webm", b"audio-bytes", "audio/webm")},
                )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": {"code": "SPEECH_UNAVAILABLE"}})


if __name__ == "__main__":
    unittest.main()
