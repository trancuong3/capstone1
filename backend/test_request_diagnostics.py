"""HTTP request IDs are consistent between API response headers and logs."""
import logging
import os
import re
import unittest

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi.testclient import TestClient

from app.sever import app


class RequestIdDiagnosticsTests(unittest.TestCase):
    def test_request_id_is_returned_and_logged_for_a_successful_request(self):
        with self.assertLogs("app.sever", level=logging.INFO) as captured:
            response = TestClient(app).get("/openapi.json")

        self.assertEqual(response.status_code, 200)
        request_id = response.headers.get("X-Request-ID")
        self.assertIsNotNone(request_id)
        self.assertRegex(request_id or "", re.compile(r"^[0-9a-f]{32}$"))
        self.assertTrue(
            any(
                '"event":"http_request_received"' in line
                and f'"request_id":"{request_id}"' in line
                for line in captured.output
            )
        )
        self.assertTrue(
            any(
                '"event":"http_request_completed"' in line
                and f'"request_id":"{request_id}"' in line
                for line in captured.output
            )
        )


if __name__ == "__main__":
    unittest.main()
