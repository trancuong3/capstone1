"""Focused contract tests for the isolated ElevenLabs voice routes."""

import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

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
)


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")


def make_client(authenticated: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(voice_routes.router, prefix="/voice")
    if authenticated:
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
    return TestClient(app)


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
