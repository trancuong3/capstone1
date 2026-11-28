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

    def test_phonics_ai_overall_deadline_and_timeout_quota_cooldown(self) -> None:
        from app.services.cloud_ai_defaults import (
            is_model_in_cooldown,
            record_cloud_ai_outcome,
            reset_cloud_ai_telemetry,
        )

        reset_cloud_ai_telemetry()
        try:
            record_cloud_ai_outcome(
                "phonics_ai", "gemini", "gemini-timeout-test", ok=False, error_code="PROVIDER_TIMEOUT", http_status=504
            )
            record_cloud_ai_outcome(
                "phonics_ai", "gemini", "gemini-quota-test", ok=False, error_code="PROVIDER_QUOTA", http_status=429
            )
            self.assertTrue(is_model_in_cooldown("gemini", "gemini-timeout-test"))
            self.assertTrue(is_model_in_cooldown("gemini", "gemini-quota-test"))
        finally:
            reset_cloud_ai_telemetry()

        calls = 0

        async def _slow_handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.25)
            raise httpx.ReadTimeout("simulated timeout")

        env = {"GEMINI_API_KEY": "test-gemini", "GROQ_API_KEY": "test-groq"}
        with patch.dict(os.environ, env):
            result = asyncio.run(
                analyze_phonics_with_ai(
                    "khúc khuỷu",
                    timeout_seconds=0.5,
                    overall_timeout_seconds=0.5,
                    transport=httpx.MockTransport(_slow_handler),
                )
            )
        self.assertFalse(result.supported)
        # Overall 0.5s deadline stops before exhausting all 5+ Gemini/Groq candidates
        self.assertLessEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
