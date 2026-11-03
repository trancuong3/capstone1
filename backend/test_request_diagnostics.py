"""HTTP request IDs are consistent between API response headers and logs."""
import logging
import os
import re
import unittest
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.sever import app


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")


class RolelessDatabase:
    async def scalar(self, _statement):
        return None


async def override_roleless_database():
    yield RolelessDatabase()


class RequestIdDiagnosticsTests(unittest.TestCase):
    def tearDown(self):
        app.dependency_overrides.pop(get_current_parent_id, None)
        app.dependency_overrides.pop(get_db, None)

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

    def test_forbidden_reading_access_is_logged_without_exception_details(self):
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
        app.dependency_overrides[get_db] = override_roleless_database

        session_id = "22222222-2222-4222-8222-222222222222"
        with self.assertLogs("app.sever", level=logging.WARNING) as captured:
            response = TestClient(app).get(
                f"/reading/sessions/{session_id}/reports"
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": "Parent access required"})
        request_id = response.headers.get("X-Request-ID")
        self.assertIsNotNone(request_id)
        diagnostic = "\\n".join(captured.output)
        self.assertIn('"event":"http_request_rejected"', diagnostic)
        self.assertIn('"stage":"authorization"', diagnostic)
        self.assertIn('"route":"/reading/sessions/{session_id}/reports"', diagnostic)
        self.assertIn('"http_status":403', diagnostic)
        self.assertNotIn(session_id, diagnostic)
        self.assertNotIn("Parent access required", diagnostic)

    def test_invalid_session_uuid_returns_original_422_and_safe_field_diagnostics(self):
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID

        with self.assertLogs("app.sever", level=logging.WARNING) as captured:
            response = TestClient(app).get(
                "/reading/sessions/not-a-valid-uuid/reports"
            )

        self.assertEqual(response.status_code, 422)
        self.assertTrue(response.json().get("detail"))
        request_id = response.headers.get("X-Request-ID")
        self.assertIsNotNone(request_id)
        diagnostic = "\\n".join(captured.output)
        self.assertIn('"event":"http_request_validation_failed"', diagnostic)
        self.assertIn('"route":"/reading/sessions/{session_id}/reports"', diagnostic)
        self.assertIn('"validation_fields":"path.session_id"', diagnostic)
        self.assertNotIn("not-a-valid-uuid", diagnostic)
        self.assertNotIn('"input"', diagnostic)


if __name__ == "__main__":
    unittest.main()
