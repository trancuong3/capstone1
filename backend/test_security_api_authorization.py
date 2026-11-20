"""Security regression tests for legacy FastAPI routes.

All database queries are mocked; no production credentials or Supabase writes.
The SQL assertions ensure the endpoint owner predicates cannot silently vanish.
"""

import os
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import UUID

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api.deps import get_current_parent_id, get_db
from app.api.routes import book, comprehension, system


PARENT = UUID("11111111-1111-4111-8111-111111111111")
OTHER = UUID("33333333-3333-4333-8333-333333333333")
CHILD = UUID("22222222-2222-4222-8222-222222222222")
SESSION = UUID("44444444-4444-4444-8444-444444444444")
PAGE = UUID("55555555-5555-4555-8555-555555555555")
REVISION = UUID("66666666-6666-4666-8666-666666666666")
QUESTION = UUID("77777777-7777-4777-8777-777777777777")


class FakeDb:
    def __init__(self):
        self.role = "parent"
        self.owned = True
        self.statements = []
        self.rows = []
        self.question = SimpleNamespace(
            Id=QUESTION,
            ExpectedAnswer="mèo",
            AcceptedAnswers=["con mèo"],
        )
        self.scalar = AsyncMock(side_effect=self._scalar)
        self.execute = AsyncMock(side_effect=self._execute)
        self.add = Mock()
        self.commit = AsyncMock()
        self.refresh = AsyncMock(side_effect=self._refresh)

    async def _scalar(self, statement):
        sql = str(statement).lower()
        self.statements.append(sql)
        if "profiles.role" in sql:
            return self.role
        if "comprehensionquestions" in sql and "readingsessions" in sql:
            return self.question if self.owned else None
        if "readingsessionpages" in sql:
            return SESSION if self.owned else None
        if "childprofiles" in sql:
            return CHILD if self.owned else None
        return None

    async def _execute(self, statement):
        self.statements.append(str(statement).lower())
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: self.rows))

    async def _refresh(self, record):
        record.Id = UUID("88888888-8888-4888-8888-888888888888")
        if hasattr(record, "CreatedAt"):
            record.CreatedAt = datetime(2026, 1, 1, tzinfo=timezone.utc)
        if hasattr(record, "GeneratedAt"):
            record.GeneratedAt = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def assert_owner_filter(self, model_name):
        found = [
            sql for sql in self.statements
            if model_name in sql and "childprofiles.parentid" in sql
        ]
        if not found:
            raise AssertionError(f"No child owner predicate in query for {model_name}")
        return found[-1]


class ProviderError(Exception):
    status = 401


REPORT = {
    "ChildId": str(CHILD),
    "PeriodStart": "2026-01-01",
    "PeriodEnd": "2026-01-07",
    "Summary": {},
}
CONSENT = {
    "ParentId": str(PARENT),
    "ChildId": str(CHILD),
    "Scope": "reading",
    "Granted": True,
}
QUESTION_BODY = {
    "SessionId": str(SESSION),
    "PageId": str(PAGE),
    "PageRevisionId": str(REVISION),
    "Type": "FACTUAL",
    "Prompt": "Con gi?",
    "ExpectedAnswer": "mèo",
    "Difficulty": "EASY",
}
ANSWER = {"QuestionId": str(QUESTION), "Answer": "con mèo", "IsCorrect": False, "Score": 99.0}
LOG = {
    "ActorId": str(PARENT),
    "Action": "READ",
    "ResourceType": "BOOK",
    "ResourceId": str(CHILD),
    "RequestId": "security-test",
}


class ApiAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDb()
        self.app = FastAPI()
        self.app.include_router(system.router, prefix="/system")
        self.app.include_router(comprehension.router, prefix="/comprehension")
        self.app.include_router(book.router, prefix="/books")
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_current_parent_id] = lambda: PARENT
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.app.dependency_overrides.clear()

    def request(self, method, path, payload=None):
        return self.client.request(method, path, json=payload)

    def test_missing_token_is_401_for_all_nine_legacy_endpoints(self):
        self.app.dependency_overrides.pop(get_current_parent_id)
        routes = (
            ("GET", "/system/reports", None),
            ("POST", "/system/reports", REPORT),
            ("GET", "/system/consents", None),
            ("POST", "/system/consents", CONSENT),
            ("GET", "/system/logs", None),
            ("POST", "/system/logs", LOG),
            ("GET", "/comprehension/questions", None),
            ("POST", "/comprehension/questions", QUESTION_BODY),
            ("POST", "/comprehension/answers", ANSWER),
        )
        for method, url, payload in routes:
            with self.subTest(path=url, method=method):
                self.assertEqual(self.request(method, url, payload).status_code, 401)
        self.db.add.assert_not_called()

    def test_invalid_supabase_token_is_401(self):
        self.app.dependency_overrides.pop(get_current_parent_id)
        supabase = SimpleNamespace(
            auth=SimpleNamespace(get_user=Mock(side_effect=ProviderError("bad JWT")))
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            for path in ("/system/reports", "/comprehension/questions", "/system/logs"):
                with self.subTest(path=path):
                    response = self.client.get(path, headers={"Authorization": "Bearer invalid"})
                    self.assertEqual(response.status_code, 401)
        self.db.add.assert_not_called()

    def test_parent_cannot_read_or_write_raw_audit_logs(self):
        self.assertEqual(self.request("GET", "/system/logs").status_code, 403)
        self.assertEqual(self.request("POST", "/system/logs", LOG).status_code, 403)
        self.db.add.assert_not_called()

    def test_admin_cannot_use_parent_scoped_endpoints(self):
        self.db.role = "admin"
        self.assertEqual(self.request("GET", "/system/reports").status_code, 403)
        self.assertEqual(self.request("GET", "/comprehension/questions").status_code, 403)
        self.db.add.assert_not_called()

    def test_absent_or_inactive_profile_is_forbidden(self):
        self.db.role = None
        self.assertEqual(self.request("GET", "/system/consents").status_code, 403)
        self.assertTrue(any("profiles.active" in sql for sql in self.db.statements))

    def test_other_parent_child_cannot_receive_report_or_consent(self):
        self.db.owned = False
        self.assertEqual(self.request("POST", "/system/reports", REPORT).status_code, 404)
        self.assertEqual(self.request("POST", "/system/consents", CONSENT).status_code, 404)
        self.db.add.assert_not_called()
        self.db.assert_owner_filter("childprofiles")

    def test_spoofed_consent_parent_is_forbidden_even_for_owned_child(self):
        payload = {**CONSENT, "ParentId": str(OTHER)}
        self.assertEqual(self.request("POST", "/system/consents", payload).status_code, 403)
        self.db.add.assert_not_called()

    def test_other_parent_session_or_question_is_not_accessible(self):
        self.db.owned = False
        self.assertEqual(
            self.request("POST", "/comprehension/questions", QUESTION_BODY).status_code,
            404,
        )
        self.assertEqual(
            self.request("POST", "/comprehension/answers", ANSWER).status_code,
            404,
        )
        self.db.add.assert_not_called()
        session_sql = self.db.assert_owner_filter("readingsessionpages")
        self.assertIn("readingsessionpages.pageid", session_sql)
        self.assertIn("readingsessionpages.pagerevisionid", session_sql)
        self.db.assert_owner_filter("comprehensionquestions")

    def test_owner_can_read_scoped_reports_consents_and_questions(self):
        for path in ("/system/reports", "/system/consents", "/comprehension/questions"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path).status_code, 200)
        self.db.assert_owner_filter("progressreports")
        self.db.assert_owner_filter("consentrecords")
        self.db.assert_owner_filter("comprehensionquestions")

    def test_owner_can_write_report_consent_and_question(self):
        self.assertEqual(self.request("POST", "/system/reports", REPORT).status_code, 200)
        self.assertEqual(self.request("POST", "/system/consents", CONSENT).status_code, 200)
        self.assertEqual(
            self.request("POST", "/comprehension/questions", QUESTION_BODY).status_code,
            200,
        )
        self.assertEqual(self.db.add.call_count, 3)
        self.db.assert_owner_filter("readingsessionpages")

    def test_server_grades_answer_instead_of_trusting_client_score(self):
        response = self.request("POST", "/comprehension/answers", ANSWER)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["IsCorrect"])
        self.assertEqual(response.json()["Score"], 1.0)
        self.db.assert_owner_filter("comprehensionquestions")

    def test_admin_can_read_logs_but_cannot_impersonate_actor(self):
        self.db.role = "admin"
        self.assertEqual(self.request("GET", "/system/logs").status_code, 200)
        spoofed = {**LOG, "ActorId": str(OTHER)}
        self.assertEqual(self.request("POST", "/system/logs", spoofed).status_code, 403)
        self.db.add.assert_not_called()
        self.assertEqual(self.request("POST", "/system/logs", LOG).status_code, 200)

    def test_intended_public_book_catalog_remains_available(self):
        self.app.dependency_overrides.pop(get_current_parent_id)
        with patch(
            "app.api.routes.book.BookService.list_books",
            new_callable=AsyncMock,
            return_value=[],
        ):
            response = self.client.get("/books/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])


if __name__ == "__main__":
    unittest.main()
