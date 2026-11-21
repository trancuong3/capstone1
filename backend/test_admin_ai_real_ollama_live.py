"""Real local Ollama integration tests (NO paid cloud calls, synthetic data only).

Run explicitly when local Ollama is running at http://127.0.0.1:11434:
    RUN_REAL_OLLAMA_TESTS=1 python -m unittest test_admin_ai_real_ollama_live
"""
from __future__ import annotations

import os
import unittest
from io import BytesIO

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from PIL import Image, ImageDraw

from app.services.admin_ocr_chunking import ChunkingConfig
from app.services.admin_ocr_local import LocalOcrConfig
from app.services.book_quality_ollama import analyse_with_ollama
from app.services.ocr_ai.child_safety import ChildSafetyOrchestrator
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.gemini_provider import GeminiOcrProvider
from app.services.ocr_ai.groq_provider import GroqOcrProvider
from app.services.ocr_ai.ollama_provider import OllamaOcrProvider
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator


def _synthetic_page_image(text: str) -> bytes:
    img = Image.new("RGB", (640, 180), "white")
    draw = ImageDraw.Draw(img)
    draw.text((24, 64), text, fill="black")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@unittest.skipUnless(
    os.getenv("RUN_REAL_OLLAMA_TESTS") == "1",
    "Set RUN_REAL_OLLAMA_TESTS=1 to execute live local Ollama tests.",
)
class RealLocalOllamaFallbackTests(unittest.IsolatedAsyncioTestCase):
    def _local_config(self) -> LocalOcrConfig:
        model = os.getenv("LOCAL_OCR_MODEL", "qwen3-vl:4b-instruct-q4_K_M")
        return LocalOcrConfig(
            base_url=os.getenv("LOCAL_OCR_BASE_URL", "http://127.0.0.1:11434"),
            model=model,
            timeout_seconds=180,
            total_timeout_seconds=240,
            num_ctx=4096,
            num_predict=512,
            chunking=ChunkingConfig(
                max_bytes=512,
                max_words=16,
                max_chunks=4,
                context_bytes=64,
                max_document_bytes=2048,
            ),
        )

    async def test_cloud_errors_fall_back_to_real_local_ollama_ocr(self):
        events: list[dict[str, object]] = []
        local_cfg = self._local_config()
        cfg = OcrCorrectionConfig(
            cloud_enabled=True,
            cloud_timeout_seconds=15,
            total_timeout_seconds=240,
            local=local_cfg,
        )
        gemini_429 = GeminiOcrProvider(
            name="gemini_3_5",
            model="gemini-simulated",
            api_key="synthetic-key",
            timeout_seconds=5,
            transport=httpx.MockTransport(
                lambda _req: httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED"}})
            ),
        )
        groq_503 = GroqOcrProvider(
            model="groq-simulated",
            api_key="synthetic-key",
            timeout_seconds=5,
            transport=httpx.MockTransport(
                lambda _req: httpx.Response(503, json={"error": {"type": "server_error"}})
            ),
        )
        real_ollama = OllamaOcrProvider(local_cfg)

        text = "Ngay xua co be cham hoc."
        boxes = [(0.05 + idx * 0.14, 0.30, 0.12, 0.25) for idx in range(6)]
        corrected = await OcrCorrectionOrchestrator(
            cfg,
            providers=[gemini_429, groq_503, real_ollama],
        ).correct(
            text,
            _synthetic_page_image("Ngay xua co be cham hoc."),
            boxes,
            on_provider_event=events.append,
        )

        self.assertEqual(len(corrected.split()), len(text.split()))
        self.assertTrue(
            any(
                e["provider"] == "gemini_3_5"
                and e["status"] == "failed"
                and e["error_code"] == "PROVIDER_QUOTA"
                and e["http_status"] == 429
                for e in events
            ),
            f"Expected Gemini 429 failure event, got: {events}",
        )
        self.assertTrue(
            any(
                e["provider"] == "groq_qwen"
                and e["status"] == "failed"
                and e["http_status"] == 503
                for e in events
            ),
            f"Expected Groq 503 failure event, got: {events}",
        )
        self.assertTrue(
            any(
                e["provider"] == "ollama_qwen3_vl"
                and e["status"] in {"succeeded", "uncertain"}
                and e["http_status"] == 200
                for e in events
            ),
            f"Expected real local Ollama success event, got: {events}",
        )

    async def test_real_local_ollama_child_safety_and_book_quality(self):
        local_cfg = self._local_config()
        cfg = OcrCorrectionConfig(
            cloud_enabled=False,
            local=local_cfg,
        )
        safe_result = await ChildSafetyOrchestrator(cfg).analyze(
            "Bé Lan tưới hoa trong vườn cùng bà ngoại mỗi buổi sáng."
        )
        self.assertIn(
            safe_result["suitability"],
            {"SUITABLE", "SUITABLE_WITH_GUIDANCE", "REVIEW_REQUIRED", "NOT_RECOMMENDED"},
        )
        self.assertTrue(
            any(
                e["provider"] == "ollama_local" and e["availability"] is True
                for e in safe_result["provider_events"]
            ),
            f"Expected ollama_local success event, got: {safe_result['provider_events']}",
        )

        quality_result = await analyse_with_ollama(
            "Hôm nay bé đi học rất vui.\nCô giáo khen bé viết chữ đẹp.",
            page_number=1,
        )
        self.assertEqual(quality_result.model_name, local_cfg.model)


if __name__ == "__main__":
    unittest.main()
