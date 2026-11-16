"""Child-safety provider ordering and evidence validation without live APIs."""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx

from app.services.ocr_ai.child_safety import ChildSafetyOrchestrator
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.admin_ocr_local import LocalOcrConfig


def _valid(findings=None, suitability="SUITABLE"):
    return {"suitability": suitability, "findings": findings or []}


def _gemini(content: str) -> httpx.Response:
    return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": content}]}}]})


def _groq(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def _ollama(content: str) -> httpx.Response:
    return httpx.Response(200, json={"message": {"content": content}})


class ChildSafetyOrchestrationTests(unittest.IsolatedAsyncioTestCase):
    def config(self):
        return OcrCorrectionConfig(
            cloud_enabled=True,
            gemini_api_key="test-gemini-key",
            groq_api_key="test-groq-key",
            gemini_primary_model="gemini-primary-test",
            gemini_fallback_model="gemini-fallback-test",
            groq_model="qwen/test-model",
            cloud_timeout_seconds=2,
            local=LocalOcrConfig(timeout_seconds=2),
        )

    async def test_valid_gemini_result_stops_chain_and_maps_exact_evidence_offsets(self):
        calls = []
        source = "Câu chuyện phản đối hành vi đánh bạn trong lớp."
        output = _valid([
            {
                "category": "BULLYING",
                "content_type": "CRITICISM",
                "severity": "LOW",
                "evidence": "đánh bạn",
                "explanation": "The text criticizes the act.",
                "recommendation": "Discuss respectful behavior.",
            }
        ], "SUITABLE_WITH_GUIDANCE")

        def handler(request):
            calls.append(request.url.path)
            payload = json.loads(request.content)
            self.assertIn("untrusted_ocr_text", payload["contents"][0]["parts"][0]["text"])
            self.assertNotIn(source, payload["systemInstruction"]["parts"][0]["text"])
            return _gemini(json.dumps(output, ensure_ascii=False))

        orchestrator = ChildSafetyOrchestrator(
            self.config(), transport=httpx.MockTransport(handler)
        )
        result = await orchestrator.analyze(source)
        finding = result["findings"][0]
        self.assertEqual(result["suitability"], "SUITABLE_WITH_GUIDANCE")
        self.assertEqual(finding["evidence_start"], source.index("đánh bạn"))
        self.assertEqual(finding["evidence_end"], source.index("đánh bạn") + len("đánh bạn"))
        self.assertEqual(finding["target"], "GRADE_1_TO_5")
        self.assertEqual(finding["review_status"], "NEEDS_REVIEW")
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["status"], "PROVISIONAL")

    async def test_invalid_evidence_tries_gemini_fallback_without_calling_groq(self):
        calls = []

        def handler(request):
            calls.append(request.url.path)
            if "gemini-primary-test" in request.url.path:
                invalid = _valid([{
                    "category": "VIOLENCE",
                    "content_type": "DESCRIPTION",
                    "severity": "MEDIUM",
                    "evidence": "missing evidence",
                    "explanation": "Invalid citation.",
                    "recommendation": "Review the source.",
                }])
                return _gemini(json.dumps(invalid))
            if "gemini-fallback-test" in request.url.path:
                return _gemini(json.dumps(_valid()))
            self.fail("Groq or Ollama must not run after a valid Gemini fallback response")

        result = await ChildSafetyOrchestrator(
            self.config(), transport=httpx.MockTransport(handler)
        ).analyze("Một đoạn văn bản.")
        self.assertEqual(result["findings"], [])
        self.assertEqual(len(calls), 2)

    async def test_ollama_runs_only_after_all_cloud_providers_fail(self):
        calls = []

        def handler(request):
            path = request.url.path
            calls.append(path)
            if "/models/" in path or "chat/completions" in path:
                return httpx.Response(503, json={"error": "unavailable"})
            return _ollama(json.dumps(_valid()))

        result = await ChildSafetyOrchestrator(
            self.config(), transport=httpx.MockTransport(handler)
        ).analyze("Văn bản tiếng Việt.")
        self.assertEqual(result["suitability"], "SUITABLE")
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[-1].endswith("/api/chat"))
        self.assertEqual(
            [event["provider"] for event in result["provider_events"]],
            ["gemini_primary", "groq_qwen", "ollama_local"],
        )


if __name__ == "__main__":
    unittest.main()
