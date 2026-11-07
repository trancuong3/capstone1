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


if __name__ == "__main__":
    unittest.main()
