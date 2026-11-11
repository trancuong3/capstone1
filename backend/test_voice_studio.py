"""Tests for voice selection and word-timed sample reading."""

import asyncio
import base64
import os
import unittest
from unittest.mock import patch
from uuid import UUID

import httpx

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id
from app.api.routes import voice_studio as studio_routes
from app.providers import elevenlabs_studio_provider as studio
from app.providers.elevenlabs_studio_provider import (
    ElevenLabsStudioProvider,
    voice_from_payload,
    word_timings,
)
from app.providers.elevenlabs_voice_provider import VoiceProviderError

ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
WORDS = ["Bé", "Na", "có", "mèo."]
TEXT = " ".join(WORDS)


def alignment_for(text: str, step: float = 0.1) -> dict:
    return {
        "characters": list(text),
        "character_start_times_seconds": [round(i * step, 3) for i in range(len(text))],
        "character_end_times_seconds": [round((i + 1) * step, 3) for i in range(len(text))],
    }


def run(coro):
    return asyncio.run(coro)


class WordTimingTests(unittest.TestCase):
    def test_rejects_equal_length_alignment_for_different_text(self):
        value = alignment_for(TEXT)
        value["characters"][0] = "X"
        with self.assertRaises(VoiceProviderError):
            word_timings(WORDS, value)

    def test_maps_decomposed_vietnamese_without_losing_word_identity(self):
        import unicodedata
        text = unicodedata.normalize("NFD", TEXT)
        timings, duration = word_timings(WORDS, alignment_for(text))
        self.assertEqual([word.index for word in timings], [0, 1, 2, 3])
        self.assertEqual(timings[-1].end, duration)
        self.assertGreater(timings[0].end, 0.2)

    def test_rejects_negative_reversed_or_overlapping_character_times(self):
        for field, index, value in (
            ("character_start_times_seconds", 0, -1),
            ("character_end_times_seconds", 1, 0),
            ("character_start_times_seconds", 3, 0),
            ("character_end_times_seconds", 0, float("inf")),
        ):
            with self.subTest(field=field, index=index):
                alignment = alignment_for(TEXT)
                alignment[field][index] = value
                with self.assertRaises(VoiceProviderError):
                    word_timings(WORDS, alignment)

    def test_maps_character_times_to_exact_word_ranges(self):
        timings, duration = word_timings(WORDS, alignment_for(TEXT))
        # "Bé Na có mèo." -> Bé=0..1, space, Na=3..4, space, có=6..7, space, mèo.=9..12
        self.assertEqual(
            [(t.index, t.start, t.end) for t in timings],
            [(0, 0.0, 0.2), (1, 0.3, 0.5), (2, 0.6, 0.8), (3, 0.9, 1.3)],
        )
        self.assertEqual(duration, 1.3)

    def test_timings_never_go_backwards(self):
        alignment = alignment_for(TEXT)
        timings, _ = word_timings(WORDS, alignment)
        starts = [t.start for t in timings]
        self.assertEqual(starts, sorted(starts))
        self.assertTrue(all(t.end >= t.start for t in timings))
        alignment["character_start_times_seconds"][3] = 0.0
        with self.assertRaises(VoiceProviderError):
            word_timings(WORDS, alignment)

    def test_rejects_misaligned_or_invalid_alignment(self):
        bad = alignment_for(TEXT)
        bad["characters"] = bad["characters"][:-1]
        for value in (None, {}, bad, "x"):
            with self.assertRaises(VoiceProviderError):
                word_timings(WORDS, value)
        invalid = alignment_for(TEXT)
        invalid["character_start_times_seconds"][0] = float("nan")
        with self.assertRaises(VoiceProviderError):
            word_timings(WORDS, invalid)


class VoiceMappingTests(unittest.TestCase):
    def test_keeps_only_safe_fields(self):
        voice = voice_from_payload(
            {
                "voice_id": "abc_123",
                "name": "  Sarah   - Mature ",
                "category": "premade",
                "labels": {"gender": "female", "accent": "american", "use_case": "narration"},
                "preview_url": "https://cdn.example.com/p.mp3",
                "sharing": {"secret": "x"},
                "settings": {"api": "y"},
            }
        )
        self.assertEqual(voice["name"], "Sarah - Mature")
        self.assertEqual(voice["gender"], "female")
        self.assertNotIn("sharing", voice)
        self.assertNotIn("settings", voice)

    def test_rejects_malformed_voices_and_unsafe_preview_urls(self):
        self.assertIsNone(voice_from_payload({"voice_id": "../x", "name": "Bad"}))
        self.assertIsNone(voice_from_payload({"voice_id": "ok", "name": ""}))
        self.assertIsNone(voice_from_payload("nope"))
        voice = voice_from_payload({"voice_id": "ok", "name": "N", "preview_url": "javascript:alert(1)"})
        self.assertIsNone(voice["preview_url"])


def fake_client(responses, calls):
    class FakeAsyncClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **kwargs):
            calls.append(("GET", url, kwargs))
            return responses.pop(0)

        async def post(self, url, **kwargs):
            calls.append(("POST", url, kwargs))
            return responses.pop(0)

    return FakeAsyncClient


def json_response(body, status=200):
    return httpx.Response(status, json=body, request=httpx.Request("GET", "https://x"))


class ProviderTests(unittest.TestCase):
    def setUp(self):
        studio.clear_caches()

    def test_voice_list_is_paginated_deduplicated_cached_and_bounded(self):
        calls = []
        page1 = {"voices": [{"voice_id": "a1", "name": "A"}], "has_more": True, "next_page_token": "t1"}
        page2 = {"voices": [{"voice_id": "a1", "name": "A"}, {"voice_id": "b2", "name": "B"}], "has_more": False}
        with patch.object(studio.httpx, "AsyncClient", fake_client([json_response(page1), json_response(page2)], calls)):
            provider = ElevenLabsStudioProvider(api_key="secret-key")
            voices = run(provider.list_voices())
            again = run(provider.list_voices())
        self.assertEqual([v["voice_id"] for v in voices], ["a1", "b2"])
        self.assertEqual(again, voices)
        self.assertEqual(len(calls), 2)  # second list_voices call hit the cache
        self.assertEqual(calls[1][2]["params"]["next_page_token"], "t1")
        self.assertEqual(calls[0][1], "https://api.elevenlabs.io/v2/voices")
        self.assertEqual(calls[0][2]["headers"], {"xi-api-key": "secret-key"})

    def test_endless_pagination_is_capped(self):
        studio.clear_caches()
        calls = []
        pages = [
            json_response({"voices": [], "has_more": True, "next_page_token": f"t{n}"})
            for n in range(20)
        ]
        with patch.object(studio.httpx, "AsyncClient", fake_client(pages, calls)):
            run(ElevenLabsStudioProvider(api_key="cap-key").list_voices())
        self.assertEqual(len(calls), studio.MAX_VOICE_PAGES)

    def test_missing_key_is_unavailable(self):
        with self.assertRaises(VoiceProviderError) as raised:
            run(ElevenLabsStudioProvider(api_key="").list_voices())
        self.assertEqual(raised.exception.code, "SPEECH_UNAVAILABLE")

    def test_all_supported_speeds_reach_both_provider_paths(self):
        from app.providers.elevenlabs_voice_provider import ElevenLabsVoiceProvider
        for speed in (0.7, 0.75, 0.8, 0.9, 1.0, 1.1, 1.2):
            with self.subTest(speed=speed):
                studio.clear_caches()
                calls = []
                body = {"audio_base64": base64.b64encode(b"mp3").decode(), "alignment": alignment_for(TEXT)}
                responses = [json_response(body), httpx.Response(200, content=b"mp3", headers={"content-type": "audio/mpeg"})]
                with patch.object(studio.httpx, "AsyncClient", fake_client(responses, calls)):
                    run(ElevenLabsStudioProvider(api_key="speed-test").synthesize_timed(words=WORDS, speed=speed))
                    run(ElevenLabsVoiceProvider(api_key="speed-test").synthesize(text=TEXT, speed=speed))
                self.assertEqual([call[2]["json"]["voice_settings"]["speed"] for call in calls], [speed, speed])

    def test_unsupported_model_does_not_silently_ignore_speed(self):
        calls = []
        with patch.dict(os.environ, {"ELEVENLABS_MODEL_ID": "eleven_v3"}), patch.object(studio.httpx, "AsyncClient", fake_client([], calls)):
            with self.assertRaises(VoiceProviderError):
                run(ElevenLabsStudioProvider(api_key="model-test").synthesize_timed(words=WORDS, speed=0.7))
        self.assertEqual(calls, [])

    def test_timed_speech_sends_speed_and_caches_identical_requests(self):
        calls = []
        body = {
            "audio_base64": base64.b64encode(b"mp3-bytes").decode(),
            "alignment": alignment_for(TEXT),
        }
        with patch.object(studio.httpx, "AsyncClient", fake_client([json_response(body)], calls)):
            provider = ElevenLabsStudioProvider(api_key="speed-key")
            first = run(provider.synthesize_timed(words=WORDS, requested_voice_id="voice_1", speed=0.85))
            second = run(provider.synthesize_timed(words=WORDS, requested_voice_id="voice_1", speed=0.85))
        self.assertIs(first, second)
        self.assertEqual(len(calls), 1)
        _, url, kwargs = calls[0]
        self.assertTrue(url.endswith("/text-to-speech/voice_1/with-timestamps"))
        self.assertEqual(kwargs["json"]["text"], TEXT)
        self.assertEqual(kwargs["json"]["voice_settings"]["speed"], 0.85)
        self.assertEqual(first.audio, b"mp3-bytes")
        self.assertEqual(len(first.words), 4)

    def test_different_voice_or_speed_is_not_served_from_cache(self):
        calls = []
        body = {"audio_base64": base64.b64encode(b"x").decode(), "alignment": alignment_for(TEXT)}
        with patch.object(studio.httpx, "AsyncClient", fake_client([json_response(body), json_response(body)], calls)):
            provider = ElevenLabsStudioProvider(api_key="k2")
            run(provider.synthesize_timed(words=WORDS, requested_voice_id="v1", speed=1.0))
            run(provider.synthesize_timed(words=WORDS, requested_voice_id="v1", speed=0.8))
        self.assertEqual(len(calls), 2)

    def test_provider_failures_are_mapped_to_safe_errors(self):
        for status_code, expected in ((429, 503), (500, 503), (400, 502)):
            studio.clear_caches()
            with patch.object(
                studio.httpx, "AsyncClient",
                fake_client([json_response({"detail": "vendor secret"}, status_code)], []),
            ):
                with self.assertRaises(VoiceProviderError) as raised:
                    run(ElevenLabsStudioProvider(api_key="k3").synthesize_timed(words=WORDS))
            self.assertEqual(raised.exception.status_code, expected)
            self.assertNotIn("vendor", str(raised.exception))

    def test_bad_alignment_from_provider_is_rejected(self):
        body = {"audio_base64": base64.b64encode(b"x").decode(), "alignment": {"characters": []}}
        with patch.object(studio.httpx, "AsyncClient", fake_client([json_response(body)], [])):
            with self.assertRaises(VoiceProviderError):
                run(ElevenLabsStudioProvider(api_key="k4").synthesize_timed(words=WORDS))


class RouteTests(unittest.TestCase):
    def client(self, authenticated=True):
        app = FastAPI()
        app.include_router(studio_routes.router, prefix="/voice")
        if authenticated:
            app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
        return TestClient(app)

    def test_endpoints_require_authentication(self):
        client = self.client(authenticated=False)
        self.assertEqual(client.get("/voice/voices").status_code, 401)
        self.assertEqual(client.post("/voice/text-to-speech/timed", json={"words": ["a"]}).status_code, 401)

    def test_request_validation(self):
        client = self.client()
        url = "/voice/text-to-speech/timed"
        for body in (
            {"words": []},
            {"words": ["hai từ"]},  # whitespace inside a token
            {"words": [""]},
            {"words": ["a"], "speed": 0.5},
            {"words": ["a"], "speed": 1.5},
            {"words": ["a"], "voice_id": "../etc"},
            {"words": ["a" * 81]},
            {"words": ["abcdefghij" * 8] * 70},  # beyond the total size limit
        ):
            self.assertEqual(client.post(url, json=body).status_code, 422, body)

    def test_returns_audio_and_word_times(self):
        studio.clear_caches()
        body = {"audio_base64": base64.b64encode(b"mp3").decode(), "alignment": alignment_for(TEXT)}
        with patch.object(studio.httpx, "AsyncClient", fake_client([json_response(body)], [])):
            with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "route-key"}):
                response = self.client().post(
                    "/voice/text-to-speech/timed", json={"words": WORDS, "speed": 0.9}
                )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(base64.b64decode(data["audio_base64"]), b"mp3")
        self.assertEqual(data["content_type"], "audio/mpeg")
        self.assertEqual(len(data["words"]), 4)
        self.assertEqual(data["words"][0], {"index": 0, "start": 0.0, "end": 0.2})

    def test_provider_error_does_not_leak_details(self):
        studio.clear_caches()
        with patch.object(studio.httpx, "AsyncClient", fake_client([json_response({"detail": "quota secret"}, 429)], [])):
            with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "route-key-2"}):
                response = self.client().post("/voice/text-to-speech/timed", json={"words": WORDS})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": {"code": "SPEECH_UNAVAILABLE"}})

    def test_voice_list_response(self):
        studio.clear_caches()
        body = {"voices": [{"voice_id": "v1", "name": "Sarah", "labels": {"gender": "female"}}], "has_more": False}
        with patch.object(studio.httpx, "AsyncClient", fake_client([json_response(body)], [])):
            with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "list-key", "ELEVENLABS_VOICE_ID": "v1"}):
                response = self.client().get("/voice/voices")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["default_voice_id"], "v1")
        self.assertEqual(data["voices"][0]["gender"], "female")


if __name__ == "__main__":
    unittest.main()
