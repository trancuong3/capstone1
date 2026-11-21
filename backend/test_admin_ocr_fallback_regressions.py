"""Regression tests reproducing OCR AI fallback, timeout budget, and error-telemetry bugs."""
from __future__ import annotations

import asyncio
import json
import os
import unittest
from io import BytesIO

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from PIL import Image

from app.services.admin_ocr_chunking import ChunkingConfig, chunk_ocr_text
from app.services.admin_ocr_local import LocalOcrConfig
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrOrchestrationError, OcrProviderError
from app.services.ocr_ai.ollama_provider import OllamaOcrProvider
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services.ocr_ai.schemas import ChunkCorrectionResult


def _image() -> bytes:
    output = BytesIO()
    Image.new("RGB", (500, 300), "white").save(output, format="PNG")
    return output.getvalue()


def _boxes(count: int) -> list[tuple[float, float, float, float]]:
    return [(0.05 + idx * 0.15, 0.2, 0.1, 0.1) for idx in range(count)]


class _FakeProvider:
    def __init__(self, name: str, calls: list, *, result=None, error=None, delay: float = 0.0, result_by_chunk=None):
        self.name = name
        self.model = f"model-{name}"
        self.family = "google" if name.startswith("gemini") else ("ollama" if name.startswith("ollama") else name)
        self._calls = calls
        self._result = result
        self._error = error
        self._delay = delay
        self._result_by_chunk = result_by_chunk

    async def correct_chunk(self, *, chunk, image_bytes, image_mime_type):
        self._calls.append((self.name, chunk.chunk_id, tuple(t.text for t in chunk.tokens)))
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._error is not None:
            raise self._error
        if self._result_by_chunk is not None:
            return self._result_by_chunk(chunk)
        return self._result or ChunkCorrectionResult(
            chunk.chunk_id, tuple(t.text for t in chunk.tokens), ()
        )


class OcrFallbackBugReproductionTests(unittest.IsolatedAsyncioTestCase):
    async def test_cloud_uncertain_tokens_fallback_to_ollama_keeping_accepted_words(self):
        """Bug repro #1: cloud resolves token 0 and leaves token 1 uncertain; Ollama must resolve ONLY token 1."""
        calls: list = []
        uncertain_seen: list = []
        providers = [
            _FakeProvider(
                "gemini_3_5",
                calls,
                result=ChunkCorrectionResult(0, ("Ngày", "xua"), (1,)),
            ),
            _FakeProvider(
                "ollama_qwen3_vl",
                calls,
                # Even if Ollama proposes altering already-accepted token 0, orchestrator MUST hold token 0 fixed.
                result=ChunkCorrectionResult(0, ("Ngầy", "xưa"), ()),
            ),
        ]
        cfg = OcrCorrectionConfig(
            local=LocalOcrConfig(
                timeout_seconds=2,
                total_timeout_seconds=10,
                chunking=ChunkingConfig(max_bytes=200, max_words=10, max_chunks=5, context_bytes=20, max_document_bytes=1000),
            ),
            total_timeout_seconds=10,
        )
        result = await OcrCorrectionOrchestrator(cfg, providers=providers).correct(
            "Ngay xua",
            _image(),
            _boxes(2),
            on_uncertain_tokens=lambda cid, idxs: uncertain_seen.append((cid, idxs)),
        )
        self.assertEqual([entry[0] for entry in calls], ["gemini_3_5", "ollama_qwen3_vl"])
        self.assertEqual(result, "Ngày xưa")
        self.assertEqual(uncertain_seen, [])

    async def test_cloud_slow_calls_cannot_starve_ollama_reserved_budget(self):
        """Bug repro #2: slow cloud providers must not consume the entire document deadline before Ollama runs."""
        calls: list = []
        providers = [
            _FakeProvider("gemini_3_5", calls, delay=1.0),
            _FakeProvider("gemini_3_1", calls, delay=1.0),
            _FakeProvider("groq_qwen", calls, delay=1.0),
            _FakeProvider(
                "ollama_qwen3_vl",
                calls,
                delay=0.05,
                result=ChunkCorrectionResult(0, ("Ngày", "xưa"), ()),
            ),
        ]
        cfg = OcrCorrectionConfig(
            cloud_timeout_seconds=5,
            total_timeout_seconds=1,
            local=LocalOcrConfig(
                timeout_seconds=1,
                total_timeout_seconds=1,
                chunking=ChunkingConfig(max_bytes=200, max_words=10, max_chunks=5, context_bytes=20, max_document_bytes=1000),
            ),
        )
        result = await OcrCorrectionOrchestrator(cfg, providers=providers).correct(
            "Ngay xua",
            _image(),
            _boxes(2),
        )
        self.assertIn("ollama_qwen3_vl", [entry[0] for entry in calls])
        self.assertEqual(result, "Ngày xưa")

    async def test_ollama_400_schema_rejection_retries_once_in_json_mode_and_404_preserves_http_status(self):
        """Bug repro #3: Ollama must retry format='json' on HTTP 400/422 and preserve upstream_status_code on 404."""
        plan = chunk_ocr_text(
            "Ngay xua",
            ChunkingConfig(max_bytes=200, max_words=10, max_chunks=5, context_bytes=20, max_document_bytes=1000),
        )
        formats_seen = []

        async def schema_fallback_handler(request: httpx.Request):
            payload = json.loads(request.content)
            formats_seen.append(payload["format"])
            if isinstance(payload["format"], dict):
                return httpx.Response(400, json={"error": "schema unsupported"})
            return httpx.Response(
                200,
                json={
                    "message": {
                        "content": json.dumps(
                            {
                                "chunk_id": 0,
                                "corrected_words": ["Ngày", "xưa"],
                                "uncertain_word_indices": [],
                            },
                            ensure_ascii=False,
                        )
                    }
                },
            )

        provider = OllamaOcrProvider(
            LocalOcrConfig(timeout_seconds=2),
            transport=httpx.MockTransport(schema_fallback_handler),
        )
        res = await provider.correct_chunk(
            chunk=plan.chunks[0], image_bytes=_image(), image_mime_type="image/jpeg"
        )
        self.assertEqual(res.corrected_words, ("Ngày", "xưa"))
        self.assertEqual(len(formats_seen), 2)
        self.assertEqual(formats_seen[1], "json")

        async def missing_model_handler(_request: httpx.Request):
            return httpx.Response(404, json={"error": "model not found"})

        missing_provider = OllamaOcrProvider(
            LocalOcrConfig(timeout_seconds=2),
            transport=httpx.MockTransport(missing_model_handler),
        )
        with self.assertRaises(OcrProviderError) as caught:
            await missing_provider.correct_chunk(
                chunk=plan.chunks[0], image_bytes=_image(), image_mime_type="image/jpeg"
            )
        self.assertEqual(caught.exception.code, "MODEL_UNAVAILABLE")
        self.assertEqual(caught.exception.upstream_status_code, 404)

    async def test_orchestrator_preserves_specific_last_provider_error_code_and_chunk_on_failure(self):
        """Bug repro #4: when Ollama fails with MODEL_UNAVAILABLE on last chunk, orchestration error exposes it."""
        calls: list = []

        def last_chunk_fail(chunk):
            if chunk.chunk_id == 0:
                return ChunkCorrectionResult(0, ("Ngày",), ())
            raise OcrProviderError(
                provider="ollama_qwen3_vl",
                code="MODEL_UNAVAILABLE",
                status_code=503,
                upstream_status_code=404,
            )

        providers = [
            _FakeProvider("ollama_qwen3_vl", calls, result_by_chunk=last_chunk_fail),
        ]
        cfg = OcrCorrectionConfig(
            local=LocalOcrConfig(
                timeout_seconds=2,
                total_timeout_seconds=10,
                chunking=ChunkingConfig(max_bytes=200, max_words=1, max_chunks=5, context_bytes=20, max_document_bytes=1000),
            ),
            total_timeout_seconds=10,
        )
        with self.assertRaises(OcrOrchestrationError) as caught:
            await OcrCorrectionOrchestrator(cfg, providers=providers).correct(
                "Ngay xua",
                _image(),
                _boxes(2),
            )
        self.assertEqual(caught.exception.last_error_code, "MODEL_UNAVAILABLE")
        self.assertEqual(caught.exception.provider, "ollama_qwen3_vl")
        self.assertEqual(caught.exception.chunk_id, 1)


if __name__ == "__main__":
    unittest.main()
