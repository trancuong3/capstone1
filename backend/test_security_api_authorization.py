"""Security regression tests for legacy FastAPI routes.

All database queries are mocked; no production credentials or Supabase writes.
The SQL assertions ensure the endpoint owner predicates cannot silently vanish.
"""

import os
import unittest
from datetime import date, datetime, timedelta, timezone
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
        started = datetime(2026, 1, 3, 2, 0, tzinfo=timezone.utc)
        self.sessions = [(started, started + timedelta(minutes=3))]
        self.trusted_snapshot = None
        self.question = SimpleNamespace(
            Id=QUESTION, SessionId=SESSION, PageId=PAGE,
            PageRevisionId=REVISION, Type="FACTUAL",
            Prompt="Con gi?", Difficulty="EASY",
            CreatedAt=started, SourceSpan={"choices": ["mèo", "chó"]},
            ExpectedAnswer="mèo", AcceptedAnswers=["con mèo"],
        )
        self.answer_row = SimpleNamespace(
            Id=UUID("99999999-9999-4999-8999-999999999999"),
            QuestionId=QUESTION, Answer="con mèo", IsCorrect=True,
            Score=1.0, CreatedAt=started,
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
        if "progressreports" in sql and "summary" in sql:
            return self.trusted_snapshot
        if "comprehensionanswers" in sql and "comprehensionquestions" not in sql:
            return self.answer_row if self.owned else None
        if "comprehensionquestions" in sql and "readingsessions" in sql:
            return self.question if self.owned else None
        if "readingsessionpages" in sql:
            return SESSION if self.owned else None
        if "childprofiles" in sql:
            return CHILD if self.owned else None
        return None

    async def _execute(self, statement):
        sql = str(statement).lower()
        self.statements.append(sql)
        if "readingsessions.startedat" in sql and "readingsessions.endedat" in sql:
            return SimpleNamespace(all=lambda: self.sessions if self.owned else [])
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

    def test_other_parent_question_cannot_be_answered(self):
        self.db.owned = False
        self.assertEqual(
            self.request("POST", "/comprehension/answers", ANSWER).status_code,
            404,
        )
        self.db.add.assert_not_called()
        self.db.assert_owner_filter("comprehensionquestions")

    def test_owner_can_read_scoped_reports_consents_and_questions(self):
        for path in ("/system/reports", "/system/consents", "/comprehension/questions"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path).status_code, 200)
        self.db.assert_owner_filter("progressreports")
        self.db.assert_owner_filter("consentrecords")
        self.db.assert_owner_filter("comprehensionquestions")

    def test_owner_can_create_server_derived_report_and_consent_only(self):
        response = self.request("POST", "/system/reports", REPORT)
        self.assertEqual(response.status_code, 200)
        summary = response.json()["Summary"]
        self.assertEqual(summary["completed_sessions"], 1)
        self.assertEqual(summary["reading_duration_ms"], 180000)
        self.assertEqual(summary["source"], "server_completed_sessions_v1")
        self.assertEqual(self.request("POST", "/system/consents", CONSENT).status_code, 200)
        self.assertEqual(
            self.request("POST", "/comprehension/questions", QUESTION_BODY).status_code,
            403,
        )
        self.assertEqual(self.db.add.call_count, 2)
        self.assertTrue(any("for update" in sql for sql in self.db.statements))
        sql = self.db.assert_owner_filter("readingsessions")
        self.assertIn("readingsessions.state", sql)

    def test_legacy_answer_routes_through_tutor_grader_and_ignores_spoofed_score(self):
        with patch("app.api.routes.comprehension.TutorQuestionService.submit_answer",
                   new_callable=AsyncMock) as grader:
            grader.return_value = SimpleNamespace(answer_id=self.db.answer_row.Id)
            response = self.request("POST", "/comprehension/answers", ANSWER)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["IsCorrect"])
        self.assertEqual(response.json()["Score"], 1.0)
        self.assertEqual(grader.await_count, 1)
        self.assertEqual(grader.await_args.args, (SESSION, QUESTION, PARENT, "con mèo"))
        self.db.assert_owner_filter("comprehensionquestions")
        self.db.add.assert_not_called()

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


    def test_legacy_question_read_never_exposes_answer_or_generation_metadata(self):
        self.db.rows = [self.db.question]
        response = self.request("GET", "/comprehension/questions")
        self.assertEqual(response.status_code, 200)
        question = response.json()[0]
        self.assertEqual(question["Id"], str(QUESTION))
        for forbidden in ("ExpectedAnswer", "AcceptedAnswers", "SourceSpan"):
            self.assertNotIn(forbidden, question)

    def test_legacy_question_creation_is_disabled_for_owner(self):
        response = self.request("POST", "/comprehension/questions", QUESTION_BODY)
        self.assertEqual(response.status_code, 403)
        self.db.add.assert_not_called()

    def test_forged_report_metric_is_rejected_without_db_writes(self):
        payload = {**REPORT, "Summary": {"completed_sessions": 9999}}
        response = self.request("POST", "/system/reports", payload)
        self.assertEqual(response.status_code, 422)
        self.db.add.assert_not_called()
        self.db.scalar.assert_not_awaited()

    def test_report_period_validation_precedes_db_access(self):
        for start, end in (("2026-01-08", "2026-01-07"),
                           ("2026-12-01", "2026-12-07"),
                           ("2024-01-01", "2026-01-07")):
            with self.subTest(start=start, end=end):
                payload = {**REPORT, "PeriodStart": start, "PeriodEnd": end}
                self.assertEqual(self.request("POST", "/system/reports", payload).status_code, 422)
        self.db.add.assert_not_called()
        self.db.scalar.assert_not_awaited()

    def test_report_without_finished_sessions_is_409_not_fabricated_zero(self):
        self.db.sessions = []
        response = self.request("POST", "/system/reports", REPORT)
        self.assertEqual(response.status_code, 409)
        self.db.add.assert_not_called()

    def test_repeating_trusted_report_period_is_idempotent(self):
        self.db.trusted_snapshot = SimpleNamespace(
            Id=UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            ChildId=CHILD, PeriodStart=date(2026, 1, 1),
            PeriodEnd=date(2026, 1, 7),
            Summary={"source": "server_completed_sessions_v1",
                     "completed_sessions": 1, "reading_duration_ms": 180000},
            GeneratedAt=datetime(2026, 1, 8, tzinfo=timezone.utc),
        )
        response = self.request("POST", "/system/reports", REPORT)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["Id"], str(self.db.trusted_snapshot.Id))
        self.db.add.assert_not_called()
        self.assertFalse(any("readingsessions.startedat" in sql for sql in self.db.statements))

    def test_blank_or_oversized_answer_rejected_before_db(self):
        for answer in (" ", "x" * 201):
            with self.subTest(size=len(answer)):
                body = {**ANSWER, "Answer": answer}
                self.assertEqual(self.request("POST", "/comprehension/answers", body).status_code, 422)
        self.db.scalar.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
