"""Admin health exposes local OCR readiness without a cloud probe."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.api.routes.system import AdminSystemService
from app.services.admin_ocr_local import LocalOcrConfig


class LocalOcrHealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_reports_local_provider_and_does_not_call_gemini(self):
        repository = AsyncMock()
        repository.probe_database.return_value = True
        voice = AsyncMock()
        voice.probe_tts.return_value = ("HEALTHY", "TTS ready")
        voice.probe_stt.return_value = ("HEALTHY", "STT ready")

        with (
            patch(
                "app.api.routes.system.LocalOcrConfig.from_environment",
                return_value=LocalOcrConfig(),
            ),
            patch(
                "app.api.routes.system.LocalOcrCorrector.probe",
                new=AsyncMock(
                    return_value=("HEALTHY", "Ollama and local model ready")
                ),
            ) as local_probe,
        ):
            result = await AdminSystemService(repository, voice).health()

        local_probe.assert_awaited_once()
        local_item = next(item for item in result.services if item.id == "local_ocr")
        self.assertEqual(local_item.status, "HEALTHY")
        self.assertEqual(local_item.label, "AI OCR cục bộ")

    async def test_health_is_inconclusive_if_ocr_probe_times_out(self):
        repository = AsyncMock()
        repository.probe_database.return_value = True
        voice = AsyncMock()
        voice.probe_tts.return_value = ("HEALTHY", "TTS ready")
        voice.probe_stt.return_value = ("HEALTHY", "STT ready")
        with (
            patch("app.api.routes.system.LocalOcrConfig.from_environment",
                  return_value=LocalOcrConfig()),
            patch("app.api.routes.system.LocalOcrCorrector.probe",
                  new=AsyncMock(return_value=("HEALTHY", "Local OCR ready"))),
            patch("app.api.routes.system.collect_ocr_health",
                  side_effect=RuntimeError("private check failure")),
        ):
            result = await AdminSystemService(repository, voice).health(workers={})
        items = {item.id: item for item in result.services}
        self.assertEqual(items["paddleocr"].detail_status, "unknown")
        self.assertEqual(items["tesseract_vie"].status, "DEGRADED")
        self.assertEqual(items["book_quality"].detail_status, "disabled")
        self.assertEqual(result.overall_status, "DEGRADED")
        self.assertNotIn("private check failure", str(result))

    async def test_runtime_is_not_loaded_by_admin_health_and_workers_are_visible(self):
        repository = AsyncMock()
        repository.probe_database.return_value = True
        voice = AsyncMock()
        voice.probe_tts.return_value = ("HEALTHY", "TTS ready")
        voice.probe_stt.return_value = ("HEALTHY", "STT ready")
        cheap = [
            {"id": "paddleocr", "label": "PaddleOCR", "status": "DEGRADED",
             "detail_status": "installed", "safe_message": "Đã cài, chưa nạp."},
            {"id": "vietocr", "label": "VietOCR", "status": "DEGRADED",
             "detail_status": "installed", "safe_message": "Đã cài, chưa nạp."},
        ]
        with (
            patch("app.api.routes.system.LocalOcrConfig.from_environment",
                  return_value=LocalOcrConfig()),
            patch("app.api.routes.system.LocalOcrCorrector.probe",
                  new=AsyncMock(return_value=("HEALTHY", "Local OCR ready"))),
            patch("app.api.routes.system.collect_ocr_health", return_value=cheap) as diag,
        ):
            result = await AdminSystemService(repository, voice).health(
                workers={"book_quality": object()}
            )
        diag.assert_called_once()
        items = {item.id: item for item in result.services}
        self.assertEqual(items["paddleocr"].detail_status, "installed")
        self.assertEqual(items["vietocr"].status, "DEGRADED")
        self.assertEqual(items["book_quality"].detail_status, "unknown")
        self.assertEqual(result.overall_status, "DEGRADED")


if __name__ == "__main__":
    unittest.main()
