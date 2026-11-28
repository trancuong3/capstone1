from __future__ import annotations

import asyncio
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_active_profile_id
from app.api.routes import voice as voice_routes
from app.services.phonics_ai_service import (
    analyze_phonics_with_ai,
    clear_phonics_ai_cache,
)


class PhonicsAiServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_phonics_ai_cache()

    def tearDown(self) -> None:
        clear_phonics_ai_cache()

    def test_gemini_response_is_validated_sanitized_and_cached(self) -> None:
        env = {"GEMINI_API_KEY": "test-gemini-key", "GROQ_API_KEY": ""}
        with patch.dict(os.environ, env):
            calls = 0

            def handler(request: httpx.Request) -> httpx.Response:
                nonlocal calls
                calls += 1
                self.assertIn("generateContent", str(request.url))
                self.assertEqual(
                    request.headers.get("x-goog-api-key"), "test-gemini-key"
                )
                ai_json = {
                    "supported": True,
                    "focus_syllable": "trường",
                    "onset_written": "tr",
                    "onset_spoken": "trờ",
                    "rhyme_written": "ường",
                    "rhyme_untoned": "ương",
                    "rhyme_nucleus": "ươ",
                    "rhyme_coda": "ng",
                    "rhyme_spoken": "ương",
                    "tone_key": "huyen",
                    "steps": [
                        {
                            "id": "rhyme_build",
                            "kind": "rhyme_build",
                            "display_text": "ư · ơ · ngờ → ương",
                            "spoken_text": "ư + ơ + ngờ → ương",
                            "highlight_part": "rhyme",
                            "pause_after_ms": 420,
                        },
                        {
                            "id": "onset_blend",
                            "kind": "onset_blend",
                            "display_text": "trờ + ương",
                            "spoken_text": "trờ, ương.",
                            "highlight_part": "onset_and_rhyme",
                            "pause_after_ms": 420,
                        },
                        {
                            "id": "tone_blend",
                            "kind": "tone_blend",
                            "display_text": "huyền → trường",
                            "spoken_text": "huyền, trường.",
                            "highlight_part": "tone_and_syllable",
                            "pause_after_ms": 450,
                        },
                        {
                            "id": "whole_syllable",
                            "kind": "whole_syllable",
                            "display_text": "trường",
                            "spoken_text": "trường.",
                            "highlight_part": "whole_syllable",
                            "pause_after_ms": 500,
                        },
                    ],
                }
                return httpx.Response(
                    200,
                    json={
                        "candidates": [
                            {
                                "content": {
                                    "parts": [
                                        {"text": json.dumps(ai_json, ensure_ascii=False)}
                                    ]
                                }
                            }
                        ]
                    },
                )

            transport = httpx.MockTransport(handler)
            first = asyncio.run(
                analyze_phonics_with_ai("TRƯỜNG", transport=transport)
            )
            self.assertTrue(first.supported)
            self.assertEqual(first.source, "ai")
            self.assertEqual(first.focus_syllable, "trường")
            self.assertEqual(len(first.steps), 4)
            self.assertNotIn("+", first.steps[0].spoken_text)
            self.assertNotIn("→", first.steps[0].spoken_text)
            self.assertEqual(calls, 1)

            second = asyncio.run(
                analyze_phonics_with_ai("trường", transport=transport)
            )
            self.assertTrue(second.supported)
            self.assertEqual(calls, 1)

    def test_numeric_input_does_not_call_provider(self) -> None:
        with patch.dict(os.environ, {"GEMINI_API_KEY": "", "GROQ_API_KEY": ""}):
            def fail_handler(_request: httpx.Request) -> httpx.Response:
                self.fail("Numeric input must not invoke the AI provider")

            result = asyncio.run(
                analyze_phonics_with_ai(
                    "2026", transport=httpx.MockTransport(fail_handler)
                )
            )
        self.assertFalse(result.supported)
        self.assertTrue(result.can_play_whole_word)

    def test_analyze_route_returns_schema_for_authenticated_actor(self) -> None:
        actor_id = uuid4()
        test_app = FastAPI()
        test_app.include_router(voice_routes.router, prefix="/voice")
        test_app.dependency_overrides[require_active_profile_id] = lambda: actor_id
        with patch.dict(os.environ, {"GEMINI_API_KEY": "", "GROQ_API_KEY": ""}):
            client = TestClient(test_app)
            response = client.post("/voice/phonics/analyze", json={"text": "pizza"})

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data["supported"])
        self.assertEqual(data["clean_phrase"], "pizza")
        self.assertTrue(data["can_play_whole_word"])

    def test_all_20_synced_rhymes_present_in_backend_phonics_set(self) -> None:
        from app.services.vietnamese_phonics import VALID_VIETNAMESE_UNTONED_RHYMES

        expected_20 = {
            "oam",
            "oăm",
            "uâm",
            "uêm",
            "uym",
            "uyn",
            "oong",
            "oeng",
            "êc",
            "oec",
            "ooc",
            "uâc",
            "uêc",
            "yêc",
            "ưp",
            "oăp",
            "oep",
            "uôp",
            "uyp",
            "uêt",
        }
        missing = sorted(r for r in expected_20 if r not in VALID_VIETNAMESE_UNTONED_RHYMES)
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
