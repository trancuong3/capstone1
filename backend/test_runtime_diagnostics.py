"""Runtime diagnostics must expose status flags only, not config values."""
from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services import runtime_diagnostics


class RuntimeConfigurationDiagnosticsTests(unittest.TestCase):
    def test_diagnostics_return_boolean_flags_and_never_return_secret_values(self):
        with (
            patch.object(runtime_diagnostics, "SUPABASE_URL", "https://private.example"),
            patch.object(runtime_diagnostics, "SUPABASE_STORAGE_BUCKET", "private-bucket-name"),
            patch.object(runtime_diagnostics, "SUPABASE_ADMIN_KEY", "sb_secret_do_not_log"),
            patch.dict(os.environ, {"TESSERACT_CMD": "C:\\private\\tesseract.exe"}),
            patch("importlib.util.find_spec", return_value=MagicMock()),
        ):
            result = runtime_diagnostics.runtime_configuration_diagnostics()

        self.assertTrue(result["supabase_url_configured"])
        self.assertTrue(result["supabase_storage_bucket_configured"])
        self.assertTrue(result["server_side_key_configured"])
        self.assertTrue(result["ocr_engine_available"])
        self.assertTrue(result["vietnamese_language_available"])
        # Kiểm tra tính tương thích ngược của các shim keys cũ
        self.assertTrue(result["tesseract_command_configured"])
        self.assertTrue(result["tesseract_executable_available"])
        self.assertTrue(all(value is None or isinstance(value, bool) for value in result.values()))

        serialized = repr(result)
        self.assertNotIn("private.example", serialized)
        self.assertNotIn("private-bucket-name", serialized)
        self.assertNotIn("sb_secret_do_not_log", serialized)
        self.assertNotIn("C:\\private\\tesseract.exe", serialized)

    def test_diagnostics_without_ocr_skips_ocr_flags(self):
        """Khi truyền include_ocr=False, các trường OCR phải là None."""
        result = runtime_diagnostics.runtime_configuration_diagnostics(include_ocr=False)
        self.assertIsNone(result["ocr_engine_available"])
        self.assertIsNone(result["vietnamese_language_available"])
        self.assertIsNone(result["tesseract_executable_available"])


if __name__ == "__main__":
    unittest.main()