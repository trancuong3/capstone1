"""Focused contract tests for the isolated ElevenLabs voice routes."""

import asyncio
import os
import struct
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
    ElevenLabsVoiceProvider,
    SynthesizedAudio,
    Transcription,
    VoiceProviderError,
    VoiceProviderUnavailable,
)


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")


def make_wav_bytes() -> bytes:
    """Return a small valid mono PCM WAV fixture."""
    sample_rate = 16_000
    pcm_data = b"\x00\x00" * 1_600
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm_data),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(pcm_data),
    )
    return header + pcm_data


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
                words=[
                    {"text": "Con", "start": 0.1, "end": 0.2, "logprob": -0.08},
                    {"text": "mèo", "start": 0.21, "end": 0.4, "logprob": -0.12},
                ],
            )
        )
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    data={"language_code": "vi"},
                    files={"file": ("reading.wav", make_wav_bytes(), "audio/wav")},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "text": "Con mèo đang ngủ.",
                "language_code": "vi",
                "language_probability": 0.99,
                "words": [
                    {"text": "Con", "start": 0.1, "end": 0.2, "logprob": -0.08},
                    {"text": "mèo", "start": 0.21, "end": 0.4, "logprob": -0.12},
                ],
            },
        )
        provider.transcribe.assert_awaited_once_with(
            audio=make_wav_bytes(),
            filename="reading.wav",
            content_type="audio/wav",
            language_code="vi",
        )

    def test_speech_to_text_infers_octet_stream_only_from_known_extension(self):
        provider = MagicMock()
        provider.transcribe = AsyncMock(
            return_value=Transcription(
                text="Xin chào",
                language_code="vi",
                language_probability=0.99,
            )
        )
        audio = make_wav_bytes()
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("reading.wav", audio, "application/octet-stream")},
                )

        self.assertEqual(response.status_code, 200)
        provider.transcribe.assert_awaited_once_with(
            audio=audio,
            filename="reading.wav",
            content_type="audio/wav",
            language_code=None,
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

    def test_speech_to_text_maps_invalid_provider_audio_to_safe_422(self):
        provider = MagicMock()
        provider.transcribe = AsyncMock(side_effect=VoiceProviderError(status_code=422))
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("reading.wav", make_wav_bytes(), "audio/wav")},
                )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json(), {"detail": {"code": "INVALID_AUDIO"}})
        self.assertNotIn("ElevenLabs", response.text)

    def test_speech_to_text_rejects_mime_and_extension_mismatch(self):
        provider = MagicMock()
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("reading.webm", make_wav_bytes(), "audio/wav")},
                )
        self.assertEqual(response.status_code, 415)
        self.assertEqual(response.json(), {"detail": {"code": "AUDIO_FORMAT_MISMATCH"}})
        provider.transcribe.assert_not_called()

    def test_speech_to_text_hides_provider_failure_details(self):
        provider = MagicMock()
        provider.transcribe = AsyncMock(side_effect=VoiceProviderError(status_code=503))
        with patch.object(voice_routes, "ElevenLabsVoiceProvider", return_value=provider):
            with make_client() as client:
                response = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("reading.wav", make_wav_bytes(), "audio/wav")},
                )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": {"code": "SPEECH_UNAVAILABLE"}})


class ElevenLabsProviderErrorTests(unittest.TestCase):
    def test_invalid_audio_is_a_non_retryable_client_error(self):
        response = MagicMock()
        response.is_error = True
        response.status_code = 400
        response.headers = {
            "request-id": "safe-request-id",
            "content-type": "application/json",
        }
        response.json.return_value = {
            "detail": {"type": "validation_error", "code": "invalid_audio"}
        }

        class FakeAsyncClient:
            request: dict[str, object] | None = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, url, *, headers, data, files):
                self.request = {
                    "url": url,
                    "headers": headers,
                    "data": data,
                    "files": files,
                }
                return response

        audio = make_wav_bytes()
        client = FakeAsyncClient()
        provider = ElevenLabsVoiceProvider(api_key="isolated-test-key")
        with patch(
            "app.providers.elevenlabs_voice_provider.httpx.AsyncClient",
            return_value=client,
        ):
            with self.assertRaises(VoiceProviderError) as raised:
                asyncio.run(
                    provider.transcribe(
                        audio=audio,
                        filename="recording.wav",
                        content_type="audio/wav",
                        language_code="vi",
                    )
                )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertIsNotNone(client.request)
        self.assertEqual(
            client.request["files"]["file"],
            ("recording.wav", audio, "audio/wav"),
        )
        self.assertEqual(client.request["data"]["model_id"], "scribe_v2")
        self.assertEqual(client.request["data"]["language_code"], "vie")

    def test_provider_rate_limit_remains_unavailable(self):
        response = MagicMock()
        response.is_error = True
        response.status_code = 429
        response.headers = {
            "request-id": "safe-rate-limit-id",
            "content-type": "application/json",
        }
        response.text = '{"detail":"rate limited"}'

        class FakeAsyncClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, *_args, **_kwargs):
                return response

        provider = ElevenLabsVoiceProvider(api_key="isolated-test-key")
        with patch(
            "app.providers.elevenlabs_voice_provider.httpx.AsyncClient",
            return_value=FakeAsyncClient(),
        ):
            with self.assertRaises(VoiceProviderUnavailable):
                asyncio.run(
                    provider.transcribe(
                        audio=make_wav_bytes(),
                        filename="recording.wav",
                        content_type="audio/wav",
                    )
                )


if __name__ == "__main__":
    unittest.main()
