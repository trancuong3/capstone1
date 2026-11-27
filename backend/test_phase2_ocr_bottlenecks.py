from __future__ import annotations

import asyncio
import os
import sys
from types import SimpleNamespace
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx

from app.services.admin_ocr_chunking import ChunkingConfig, OcrTextChunk, OcrToken
from app.services.admin_ocr_local import LocalOcrConfig
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.schemas import ChunkCorrectionResult
from app.services.ocr_ai.gemini_provider import GeminiOcrProvider
from app.services.ocr_ai.groq_provider import GroqOcrProvider
from app.services.ocr_ai.ollama_provider import OllamaOcrProvider
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services.ocr_executor import get_ocr_executor
from app.services.ocr_inference_job_service import OcrInferenceJobService
import app.services.ocr_engine as ocr_engine
from test_ocr_engine import sample_png_bytes


def _sample_chunk() -> OcrTextChunk:
    tokens = (
        OcrToken(index=0, start=0, end=3, text="Mèo"),
        OcrToken(index=1, start=4, end=7, text="con"),
    )
    return OcrTextChunk(
        chunk_id=0,
        start_token_index=0,
        end_token_index=2,
        expected_word_count=2,
        target_text="Mèo con",
        previous_context="",
        next_context="",
        tokens=tokens,
    )


class _DummyRepo:
    def __init__(self, rows: list[object]):
        self._rows = rows

    async def list_worker_heartbeats(self, limit: int = 20):
        return self._rows


class Phase2OcrBottleneckTests(unittest.IsolatedAsyncioTestCase):
    async def test_has_online_worker_requires_idle_or_busy_status(self):
        now = datetime.now(timezone.utc)
        for bad_status in ("OFFLINE", "STARTING", "ERROR", "DEGRADED", ""):
            db = MagicMock(in_transaction=MagicMock(return_value=False), rollback=AsyncMock())
            svc = OcrInferenceJobService(db)
            svc.repo = _DummyRepo([SimpleNamespace(Status=bad_status, LastHeartbeatAt=now)])
            self.assertFalse(await svc.has_online_worker(), f"Expected False for {bad_status!r}")

        for good_status in ("IDLE", "busy"):
            db = MagicMock(in_transaction=MagicMock(return_value=False), rollback=AsyncMock())
            svc = OcrInferenceJobService(db)
            svc.repo = _DummyRepo([SimpleNamespace(Status=good_status, LastHeartbeatAt=now)])
            self.assertTrue(await svc.has_online_worker(), f"Expected True for {good_status!r}")

    def test_get_ocr_executor_is_single_worker_and_lightweight(self):
        executor = get_ocr_executor()
        self.assertEqual(getattr(executor, "_max_workers", None), 1)
        self.assertIn("app.services.ocr_executor", sys.modules)

    def test_config_defaults_and_local_only_copy_preserve_flags(self):
        self.assertEqual(LocalOcrConfig().total_timeout_seconds, 300)
        cfg = OcrCorrectionConfig(
            local=LocalOcrConfig(),
            gemini_api_key="g-key",
            groq_api_key="q-key",
            local_enabled=False,
        )
        self.assertEqual(cfg.total_timeout_seconds, 300)
        local_copy = cfg.local_only_copy()
        self.assertFalse(local_copy.local_enabled)

    async def test_provider_timeouts_and_network_errors_disable_family_and_close_client(self):
        chunk = _sample_chunk()
        img = sample_png_bytes(120, 60)

        def timeout_handler(_req: httpx.Request):
            raise httpx.ReadTimeout("timed out")

        def network_handler(_req: httpx.Request):
            raise httpx.ConnectError("connection refused")

        gemini = GeminiOcrProvider(
            name="gemini_3_5",
            model="gemini-3.5-flash",
            api_key="g-key",
            timeout_seconds=2,
            transport=httpx.MockTransport(timeout_handler),
        )
        with self.assertRaises(OcrProviderError) as ctx1:
            await gemini.correct_chunk(chunk=chunk, image_bytes=img, image_mime_type="image/jpeg")
        self.assertTrue(ctx1.exception.disables_family)
        self.assertEqual(ctx1.exception.status_code, 504)
        await gemini.aclose()

        groq = GroqOcrProvider(
            model="qwen",
            api_key="q-key",
            timeout_seconds=2,
            transport=httpx.MockTransport(network_handler),
        )
        with self.assertRaises(OcrProviderError) as ctx2:
            await groq.correct_chunk(chunk=chunk, image_bytes=img, image_mime_type="image/jpeg")
        self.assertTrue(ctx2.exception.disables_family)
        self.assertEqual(ctx2.exception.status_code, 503)
        await groq.aclose()

        ollama = OllamaOcrProvider(
            LocalOcrConfig(chunking=ChunkingConfig()),
            transport=httpx.MockTransport(timeout_handler),
        )
        with self.assertRaises(OcrProviderError) as ctx3:
            await ollama.correct_chunk(chunk=chunk, image_bytes=img, image_mime_type="image/jpeg")
        self.assertTrue(ctx3.exception.disables_family)
        self.assertEqual(ctx3.exception.status_code, 504)
        await ollama.aclose()

    async def test_orchestrator_closes_owned_providers_in_finally(self):
        closed_calls = 0

        class _ClosableMockProvider:
            name = "gemini_3_5"
            family = "google"

            def __init__(self, **_kwargs):
                pass

            async def correct_chunk(self, chunk, **_kwargs):
                return ChunkCorrectionResult(
                    chunk_id=chunk.chunk_id,
                    corrected_words=("Mèo", "con"),
                    uncertain_word_indices=(),
                )

            async def aclose(self):
                nonlocal closed_calls
                closed_calls += 1

        cfg = OcrCorrectionConfig(
            cloud_enabled=True,
            local=LocalOcrConfig(chunking=ChunkingConfig()),
            gemini_api_key="g-key",
            groq_api_key=None,
            local_enabled=False,
        )
        with patch("app.services.ocr_ai.orchestrator.GeminiOcrProvider", _ClosableMockProvider):
            orch = OcrCorrectionOrchestrator(cfg)
            res = await orch.correct(
                "Mèo con",
                sample_png_bytes(200, 100),
                [(0.1, 0.2, 0.2, 0.2), (0.4, 0.2, 0.2, 0.2)],
            )
        self.assertEqual(res, "Mèo con")
        self.assertGreaterEqual(closed_calls, 1)

    def test_vietocr_batch_path_on_non_mock_predictor_with_single_fallback(self):
        class _FakeBatchPredictor:
            config = {"predictor": {"beamsearch": False}}

            def __init__(self):
                self.batch_calls = 0
                self.single_calls = 0

            def predict_batch(self, imgs):
                self.batch_calls += 1
                if self.batch_calls == 1:
                    return ["Xin chào" for _ in imgs]
                raise RuntimeError("oom")

            def predict(self, _img):
                self.single_calls += 1
                return "Xin chào"

        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[
            [[[20.0, 20.0], [180.0, 20.0], [180.0, 60.0], [20.0, 60.0]], ("Xin chao", 0.95)],
            [[[20.0, 80.0], [180.0, 80.0], [180.0, 120.0], [20.0, 120.0]], ("Xin chao", 0.95)],
        ]]
        fake_viet = _FakeBatchPredictor()
        img = sample_png_bytes(400, 200)
        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite"),
            patch.object(ocr_engine, "is_vietocr_reliable", return_value=True),
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, fake_viet)),
        ):
            out = ocr_engine.extract_text_and_boxes(img)
        self.assertEqual(fake_viet.batch_calls, 1)
        self.assertEqual(fake_viet.single_calls, 0)
        self.assertIn("Xin chào", out["text"])


if __name__ == "__main__":
    unittest.main()
