"""Safe failure contracts for local Admin OCR Storage setup; no live Supabase calls."""
import os
import unittest
from unittest.mock import Mock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException

from app.services import storage_service


class StorageServiceConfigurationTests(unittest.TestCase):
    def test_missing_bucket_name_returns_safe_actionable_error(self):
        with patch.dict(os.environ, {"SUPABASE_STORAGE_BUCKET": ""}):
            with self.assertRaises(HTTPException) as raised:
                storage_service._bucket_name()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, "Supabase Storage is not configured")

    def test_missing_server_side_key_returns_safe_actionable_error(self):
        with (
            patch.dict(os.environ, {"SUPABASE_STORAGE_BUCKET": "book-pages"}),
            patch.object(storage_service, "get_supabase_admin_client", return_value=None),
        ):
            with self.assertRaises(HTTPException) as raised:
                storage_service._storage_bucket()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(
            raised.exception.detail,
            "Server-side Supabase Storage credentials are not configured",
        )

    def test_storage_api_exception_does_not_leak_exception_message(self):
        bucket = Mock()
        bucket.upload.side_effect = RuntimeError("secret-token-or-private-response")
        with patch.object(storage_service, "_storage_bucket", return_value=bucket):
            with self.assertRaises(HTTPException) as raised:
                storage_service.upload_object("books/test/page.png", b"image", "image/png")

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(
            raised.exception.detail,
            "Could not save the image to Supabase Storage",
        )
        self.assertNotIn("secret-token-or-private-response", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
