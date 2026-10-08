"""Read-only history/report tests; no live credentials or database writes."""
import os
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql
from app.api.deps import get_current_parent_id, get_db
from app.api.routes.reading import HistoryRepository, HistoryService, router as reading_router
from app.api.routes.system import ProgressRepository, ProgressService, router as system_router

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
CHILD = UUID("22222222-2222-4222-8222-222222222222")
BOOK = UUID("33333333-3333-4333-8333-333333333333")
SESSION = UUID("44444444-4444-4444-8444-444444444444")
QUESTION = UUID("55555555-5555-4555-8555-555555555555")
START = datetime(2026, 10, 8, 1, 0, tzinfo=timezone.utc)


def session_row(**overrides):
    fields = dict(Id=SESSION, ChildId=CHILD, BookId=BOOK, State="ABORTED",
                  StartedAt=START, EndedAt=START + timedelta(minutes=2),
                  SelectedPageRevisionId=BOOK)
    fields.update(overrides)
    return SimpleNamespace(**fields)


def history_repo():
    repo = MagicMock()
    repo.role = AsyncMock(return_value="parent")
    repo.owned_child = AsyncMock(return_value=CHILD)
    repo.sessions = AsyncMock(return_value=[session_row()])
    repo.session = AsyncMock(return_value=session_row())
    repo.session_book = AsyncMock(return_value=SimpleNamespace(
        Id=BOOK, Title="Historical retired book", Author=None,
        MinGrade=1, MaxGrade=3, LifecycleStatus="RETIRED"))
    repo.events = AsyncMock(return_value=[])
    repo.fluency = AsyncMock(return_value=None)
    repo.questions = AsyncMock(return_value=[])
    repo.answer = AsyncMock(return_value=None)
    return repo


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_check_precedes_history_query(self):
        repo = history_repo()
        repo.owned_child.return_value = None
        with self.assertRaises(HTTPException) as caught:
            await HistoryService(repo).list(CHILD, ACTOR, None, 2)
        self.assertEqual(caught.exception.status_code, 404)
        repo.sessions.assert_not_awaited()

    async def test_role_check_precedes_child_and_session_queries(self):
        repo = history_repo()
        repo.role.return_value = "admin"
        with self.assertRaises(HTTPException) as caught:
            await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(caught.exception.status_code, 403)
        repo.session.assert_not_awaited()

    async def test_pagination_uses_limit_plus_one_without_fake_rows(self):
        repo = history_repo()
        repo.sessions.return_value = [session_row(), session_row(), session_row()]
        response = await HistoryService(repo).list(CHILD, ACTOR, "page-2", 2)
        self.assertEqual(len(response.sessions), 2)
        self.assertEqual(response.next_cursor, "page-3")
        repo.sessions.assert_awaited_once_with(CHILD, ACTOR, 2, 2)

    async def test_actual_empty_history_is_an_empty_list(self):
        repo = history_repo()
        repo.sessions.return_value = []
        response = await HistoryService(repo).list(CHILD, ACTOR, None, 2)
        self.assertEqual(response.sessions, [])
        self.assertIsNone(response.next_cursor)

    async def test_cursor_validation_is_bounded_and_ascii(self):
        for cursor in ("page-0", "page-100001", "page-" + "9" * 5000, "page-²", "page-01", "page-1garbage"):
            with self.subTest(cursor=cursor[:30]):
                repo = history_repo()
                with self.assertRaises(HTTPException) as caught:
                    await HistoryService(repo).list(CHILD, ACTOR, cursor, 2)
                self.assertEqual(caught.exception.status_code, 422)
                repo.sessions.assert_not_awaited()

    async def test_unknown_session_is_404_before_loading_details(self):
        repo = history_repo()
        repo.session.return_value = None
        with self.assertRaises(HTTPException) as caught:
            await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(caught.exception.status_code, 404)
        repo.events.assert_not_awaited()

    async def test_duration_is_actual_or_null_not_active_reading_estimate(self):
        self.assertEqual(HistoryService.summary(session_row()).duration_ms, 120000)
        self.assertIsNone(HistoryService.summary(session_row(EndedAt=None)).duration_ms)

    async def test_unknown_state_and_invalid_duration_are_not_guessed(self):
        for row in (session_row(State="COMPLETED"), session_row(State="IN_PROGRESS"),
                    session_row(EndedAt=START - timedelta(seconds=1)),
                    session_row(EndedAt=datetime(2026, 10, 8, 1, 1))):
            with self.assertRaises(HTTPException) as caught:
                HistoryService.summary(row)
            self.assertEqual(caught.exception.status_code, 501)

    async def test_retired_book_metadata_is_scoped_to_owned_session(self):
        repo = history_repo()
        book = await HistoryService(repo).book(SESSION, ACTOR)
        self.assertEqual(book.lifecycle_status, "RETIRED")
        repo.session_book.assert_awaited_once_with(SESSION, ACTOR)

    async def test_foreign_session_book_is_safe_not_found(self):
        repo = history_repo()
        repo.session_book.return_value = None
        with self.assertRaises(HTTPException) as caught:
            await HistoryService(repo).book(SESSION, ACTOR)
        self.assertEqual(caught.exception.status_code, 404)

    async def test_optional_legacy_assessment_is_unknown_not_fake_zero(self):
        repo = history_repo()
        repo.fluency.return_value = SimpleNamespace(Metrics={"Accuracy": 80, "WCPM": 20},
                                                    Score=80, Uncertainty=None, ModelVersion="legacy")
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertIsNone(detail.fluency_assessment)
        self.assertIsNone(detail.report_id)
        self.assertEqual(detail.reference_page_revision_ids, [])

    async def test_event_reference_is_historical_and_private_metadata_is_removed(self):
        repo = history_repo()
        repo.events.return_value = [SimpleNamespace(Id=QUESTION, SessionId=SESSION, PageId=BOOK,
            PageRevisionId=CHILD, WordId=None, Type="LONG_PAUSE", Status="CONFIRMED",
            StartMs=1000, EndMs=1500, Confidence=None,
            Metadata={"token": "private", "reason_code": "private"})]
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(detail.reference_page_revision_ids, [CHILD])
        self.assertEqual(detail.selected_page_revision_ids, [BOOK])
        self.assertEqual(detail.events[0].metadata, {})

    async def test_unknown_event_enum_is_unavailable_not_remapped(self):
        repo = history_repo()
        repo.events.return_value = [SimpleNamespace(Id=QUESTION, SessionId=SESSION, PageId=BOOK,
            PageRevisionId=CHILD, WordId=None, Type="MISPRONUNCIATION", Status="DETECTED",
            StartMs=1000, EndMs=None, Confidence=None, Metadata={})]
        with self.assertRaises(HTTPException) as caught:
            await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(caught.exception.status_code, 501)

    async def test_expected_answers_are_never_returned(self):
        repo = history_repo()
        repo.questions.return_value = [SimpleNamespace(Id=QUESTION, Type="FACTUAL", Prompt="Question",
            PageRevisionId=BOOK, SourceSpan={"start_word_index": 0, "end_word_index_exclusive": 2,
            "sentence_index": None}, Difficulty="0.5", ExpectedAnswer="private expected answer")]
        repo.answer.return_value = SimpleNamespace(Id=CHILD, Answer="Actual answer", IsCorrect=None, Score=None)
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        payload = detail.model_dump_json()
        self.assertIn("Actual answer", payload)
        self.assertNotIn("private expected answer", payload)
        self.assertIsNone(detail.comprehension[0].answer.is_correct)

    async def test_queries_join_owner_for_history_detail_and_book(self):
        db = MagicMock()
        db.execute = AsyncMock(return_value=MagicMock())
        db.scalar = AsyncMock(return_value=None)
        repo = HistoryRepository(db)
        await repo.sessions(CHILD, ACTOR, 0, 2)
        queries = [db.execute.await_args.args[0]]
        await repo.session(SESSION, ACTOR)
        queries.append(db.scalar.await_args.args[0])
        await repo.session_book(SESSION, ACTOR)
        queries.append(db.scalar.await_args.args[0])
        for query in queries:
            compiled = query.compile(dialect=postgresql.dialect())
            self.assertIn("childprofiles.parentid", str(compiled))
            self.assertIn(ACTOR, compiled.params.values())


def report_payload():
    return dict(completed_sessions=2, reading_duration_ms=120000, omission_count=1,
        repetition_count=0, long_pause_count=0, omission_rate=None, repetition_rate=None,
        long_pause_rate=None, comprehension_accuracy=None, difficult_words=[], previous_period=None,
        trend_deltas={key: None for key in ("completed_sessions", "reading_duration_ms", "omission_rate",
            "repetition_rate", "long_pause_rate", "comprehension_accuracy")})


class ProgressTests(unittest.IsolatedAsyncioTestCase):
    def setup_service(self, summary):
        self.repo = MagicMock()
        self.access = MagicMock()
        self.access.require_child = AsyncMock()
        self.repo.report = AsyncMock(return_value=SimpleNamespace(Summary=summary, ChildId=CHILD,
            PeriodStart=date(2026, 9, 9), PeriodEnd=date(2026, 10, 8)))
        return ProgressService(self.repo, self.access)

    async def test_complete_stored_report_preserves_actual_values(self):
        service = self.setup_service(report_payload())
        report = await service.read(CHILD, ACTOR, date(2026, 9, 9), date(2026, 10, 8))
        self.assertEqual(report.completed_sessions, 2)
        self.assertIsNone(report.omission_rate)
        self.assertIsNone(report.previous_period)
        self.assertEqual(report.child_id, CHILD)

    async def test_legacy_summary_is_not_converted_into_invented_metrics(self):
        service = self.setup_service({"avg_fluency": 80, "total_books": 2})
        with self.assertRaises(HTTPException) as caught:
            await service.read(CHILD, ACTOR, date(2026, 9, 9), date(2026, 10, 8))
        self.assertEqual(caught.exception.status_code, 501)

    async def test_missing_report_is_unavailable_not_zero_report(self):
        service = self.setup_service({})
        self.repo.report.return_value = None
        with self.assertRaises(HTTPException) as caught:
            await service.read(CHILD, ACTOR, None, None)
        self.assertEqual(caught.exception.status_code, 501)

    async def test_missing_word_key_is_not_an_empty_result(self):
        service = self.setup_service({"avg_fluency": 80})
        with self.assertRaises(HTTPException) as caught:
            await service.read(CHILD, ACTOR, None, None, words_only=True)
        self.assertEqual(caught.exception.status_code, 501)

    async def test_real_empty_word_array_is_empty(self):
        service = self.setup_service({"difficult_words": []})
        self.assertEqual(await service.read(CHILD, ACTOR, None, None, words_only=True), [])

    async def test_foreign_child_does_not_query_reports(self):
        service = self.setup_service(report_payload())
        self.access.require_child.side_effect = HTTPException(status_code=404)
        with self.assertRaises(HTTPException) as caught:
            await service.read(CHILD, ACTOR, None, None)
        self.assertEqual(caught.exception.status_code, 404)
        self.repo.report.assert_not_awaited()

    async def test_inverted_period_is_422_before_query(self):
        service = self.setup_service(report_payload())
        with self.assertRaises(HTTPException) as caught:
            await service.read(CHILD, ACTOR, date(2026, 10, 9), date(2026, 10, 8))
        self.assertEqual(caught.exception.status_code, 422)
        self.repo.report.assert_not_awaited()

    async def test_report_query_filters_parent_child_and_exact_dates(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        await ProgressRepository(db).report(CHILD, date(2026, 9, 9), date(2026, 10, 8), ACTOR)
        compiled = db.scalar.await_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn("childprofiles.parentid", str(compiled))
        self.assertIn(ACTOR, compiled.params.values())
        self.assertIn(CHILD, compiled.params.values())
        self.assertIn(date(2026, 9, 9), compiled.params.values())


class ParentReadHttpTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.db.scalar = AsyncMock(return_value="admin")
        self.db.execute = AsyncMock()
        self.app = FastAPI()
        self.app.include_router(reading_router, prefix="/reading")
        self.app.include_router(system_router, prefix="/system")
        self.app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)
        self.paths = [f"/reading/history?child_id={CHILD}", f"/reading/history/{SESSION}",
            f"/reading/history/{SESSION}/book", f"/system/progress/{CHILD}",
            f"/system/difficult-words/{CHILD}"]

    def test_all_scoped_endpoints_check_parent_role(self):
        for path in self.paths:
            self.assertEqual(self.client.get(path).status_code, 403)
        self.db.execute.assert_not_awaited()

    def test_all_scoped_endpoints_require_token(self):
        del self.app.dependency_overrides[get_current_parent_id]
        for path in self.paths:
            self.assertEqual(self.client.get(path).status_code, 401)
        self.db.scalar.assert_not_awaited()

    def test_limit_and_dates_are_validated_by_fastapi(self):
        self.assertEqual(self.client.get(f"/reading/history?child_id={CHILD}&limit=101").status_code, 422)
        self.assertEqual(self.client.get(f"/system/progress/{CHILD}?period_start=not-a-date").status_code, 422)


if __name__ == "__main__":
    unittest.main()
