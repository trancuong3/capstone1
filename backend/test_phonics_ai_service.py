from __future__ import annotations

import asyncio
import json
import os
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_active_profile_id
from app.api.routes import voice as voice_routes
from app.services.phonics_ai_service import (
    analyze_phonics_with_ai,
    clear_phonics_ai_cache,
)


@pytest.fixture(autouse=True)
def _clean_cache() -> None:
    clear_phonics_ai_cache()


def test_analyze_phonics_with_ai_gemini_validates_and_sanitizes_steps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert "generateContent" in str(request.url)
        assert request.headers.get("x-goog-api-key") == "test-gemini-key"
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
                    {"content": {"parts": [{"text": json.dumps(ai_json, ensure_ascii=False)}]}}
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    first = asyncio.run(analyze_phonics_with_ai("TRƯỜNG", transport=transport))
    assert first.supported is True
    assert first.source == "ai"
    assert first.focus_syllable == "trường"
    assert len(first.steps) == 4
    # Unsafe TTS symbols (+ / →) are stripped cleanly from spoken_text
    assert "+" not in first.steps[0].spoken_text
    assert "→" not in first.steps[0].spoken_text
    assert calls == 1

    # Second call hits bounded in-memory LRU cache (zero extra AI calls)
    second = asyncio.run(analyze_phonics_with_ai("trường", transport=transport))
    assert second.supported is True
    assert calls == 1


def test_analyze_phonics_with_ai_rejects_numbers_without_calling_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")

    def fail_handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("Should not invoke AI for numeric input")

    res = asyncio.run(
        analyze_phonics_with_ai("2026", transport=httpx.MockTransport(fail_handler))
    )
    assert res.supported is False
    assert res.can_play_whole_word is True


def test_voice_phonics_analyze_route_requires_auth_and_returns_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor_id = uuid4()
    test_app = FastAPI()
    test_app.include_router(voice_routes.router, prefix="/voice")
    test_app.dependency_overrides[require_active_profile_id] = lambda: actor_id
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    client = TestClient(test_app)
    resp = client.post("/voice/phonics/analyze", json={"text": "pizza"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["supported"] is False
    assert data["clean_phrase"] == "pizza"
    assert data["can_play_whole_word"] is True
