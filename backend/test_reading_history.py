"""History contracts: isolated repositories/HTTP dependencies, never a live DB."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.schemas.reading import SessionSummaryRead
from test_parent_reports import (
    ACTOR, BOOK, CHILD, QUESTION, SESSION, START,
    HistoryService, HistoryRepository, reading_router,
    get_current_parent_id, get_db, history_repo, session_row,
)


def event_row(**overrides):
    fields = dict(Id=QUESTION, SessionId=SESSION, PageId=BOOK, PageRevisionId=CHILD,
                  WordId=None, Type="MISPRONUNCIATION", Status="DETECTED",
                  StartMs=1000, EndMs=None, Confidence=None, Metadata={"token": "private"})
    fields.update(overrides)
    return SimpleNamespace(**fields)


def question_row(**overrides):
    fields = dict(Id=QUESTION, Type="FACTUAL", Prompt="Saved question",
                  PageRevisionId=BOOK, SourceSpan=[], Difficulty="EASY",
                  ExpectedAnswer="private answer", AcceptedAnswers=["private answer"])
    fields.update(overrides)
    return SimpleNamespace(**fields)


class HistoryCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_persisted_states_and_missing_completed_end(self):
        for stored, public in (("COMPLETED", "FINISHED"), ("IN_PROGRESS", "IN_PROGRESS"),
                               ("PAUSED", "PAUSED"), ("ABORTED", "ABORTED")):
            with self.subTest(state=stored):
                repo = history_repo()
                repo.sessions.return_value = [session_row(State=stored, EndedAt=None)]
                response = await HistoryService(repo).list(CHILD, ACTOR, None, 2)
                self.assertEqual(response.sessions[0].state, public)
                self.assertIsNone(response.sessions[0].duration_ms)
                self.assertIsNone(response.sessions[0].ended_at)

    def test_live_contract_is_not_broadened(self):
        summary = HistoryService.summary(session_row(State="IN_PROGRESS"))
        with self.assertRaises(ValidationError):
            SessionSummaryRead.model_validate(summary.model_dump())

    def test_zero_duration_and_naive_start(self):
        self.assertEqual(HistoryService.summary(session_row(EndedAt=START)).duration_ms, 0)
        with self.assertRaises(HTTPException) as caught:
            HistoryService.summary(session_row(StartedAt=START.replace(tzinfo=None), EndedAt=None))
        self.assertEqual(caught.exception.status_code, 501)

    async def test_section_absence_is_explicit(self):
        detail = await HistoryService(history_repo()).get(SESSION, ACTOR)
        self.assertEqual(detail.availability.model_dump(), dict(events="absent", fluency="absent", comprehension="absent"))

    async def test_selected_range_and_completed_page_counts_are_distinct(self):
        repo = history_repo()
        repo.session_page_rows.return_value = [
            SimpleNamespace(
                PageRevisionId=BOOK,
                Status="COMPLETED",
            ),
            SimpleNamespace(
                PageRevisionId=CHILD,
                Status="PENDING",
            ),
            SimpleNamespace(
                PageRevisionId=QUESTION,
                Status="IN_PROGRESS",
            ),
        ]

        detail = await HistoryService(repo).get(SESSION, ACTOR)

        self.assertEqual(detail.selected_range_pages, 3)
        self.assertEqual(detail.pages_completed, 1)
        self.assertEqual(
            detail.selected_page_revision_ids,
            [BOOK, CHILD, QUESTION],
        )

    async def test_real_event_statuses_are_not_confirmed_or_reclassified(self):
        for status in ("DETECTED", "FEEDBACK_GIVEN", "IGNORED_BY_GATE"):
            repo = history_repo()
            repo.events.return_value = [event_row(Status=status)]
            detail = await HistoryService(repo).get(SESSION, ACTOR)
            self.assertEqual(detail.events[0].type, "MISPRONUNCIATION")
            self.assertEqual(detail.events[0].status, status)
            self.assertEqual(detail.events[0].metadata, {})

    async def test_unknown_and_invalid_events_do_not_hide_the_session(self):
        for event in (event_row(Type="UNKNOWN"), event_row(Status="UNKNOWN"),
                      event_row(EndMs=0), event_row(StartMs=-1), event_row(SessionId=BOOK)):
            repo = history_repo()
            repo.events.return_value = [event]
            detail = await HistoryService(repo).get(SESSION, ACTOR)
            self.assertEqual(detail.id, SESSION)
            self.assertEqual(detail.events, [])
            self.assertEqual(detail.availability.events, "unsupported")

    async def test_mixed_events_are_explicitly_partial(self):
        repo = history_repo()
        repo.events.return_value = [event_row(), event_row(Type="UNKNOWN")]
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(len(detail.events), 1)
        self.assertEqual(detail.availability.events, "partial")

    async def test_legacy_metrics_are_not_invented(self):
        repo = history_repo()
        repo.fluency.return_value = SimpleNamespace(Metrics={"Accuracy": 80, "WCPM": 20},
            Score=80, Uncertainty=None, ModelVersion="legacy")
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertIsNone(detail.fluency_assessment.metrics)
        self.assertEqual(detail.fluency_assessment.score, 80)
        self.assertEqual(detail.availability.fluency, "partial")

    async def test_supported_metrics_and_real_zero_score_are_preserved(self):
        repo = history_repo()
        metrics = dict(active_reading_ms=60000, reference_words_attempted=10, confirmed_error_words=0,
                       accuracy_percent=100, reading_wpm=10, repetition_rate=None, long_pause_rate=None,
                       mean_pause_ms=None, median_pause_ms=None)
        repo.fluency.return_value = SimpleNamespace(Metrics=metrics, Score=0, Uncertainty=None, ModelVersion="stored")
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(detail.fluency_assessment.metrics.model_dump(), metrics)
        self.assertEqual(detail.fluency_assessment.score, 0)
        self.assertEqual(detail.availability.fluency, "available")

    async def test_nonfinite_optional_numbers_do_not_break_json_or_hide_questions(self):
        repo = history_repo()
        repo.questions.return_value = [question_row(Difficulty=float("nan"))]
        repo.fluency.return_value = SimpleNamespace(Metrics={}, Score=float("inf"), Uncertainty=None, ModelVersion="stored")
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertIsNone(detail.comprehension[0].question.difficulty)
        self.assertIsNone(detail.fluency_assessment)
        self.assertEqual(detail.availability.fluency, "unsupported")
        self.assertNotIn("NaN", detail.model_dump_json())

    async def test_stored_text_difficulty_and_answer_survive_bad_source_span(self):
        repo = history_repo()
        repo.questions.return_value = [question_row()]
        repo.answer.return_value = SimpleNamespace(Id=CHILD, Answer="Saved answer", IsCorrect=None, Score=None)
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        item = detail.comprehension[0]
        self.assertEqual(item.question.difficulty, "EASY")
        self.assertIsNone(item.question.source_span)
        self.assertEqual(item.answer.submitted_answer, "Saved answer")
        self.assertIsNone(item.answer.is_correct)
        self.assertEqual(detail.availability.comprehension, "partial")
        payload = detail.model_dump_json()
        self.assertNotIn("private answer", payload)
        self.assertNotIn("expected", payload.lower())

    async def test_malformed_optional_question_and_answer_are_not_missing(self):
        repo = history_repo()
        repo.questions.return_value = [question_row(Type="UNKNOWN")]
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(detail.availability.comprehension, "unsupported")
        repo.questions.return_value = [question_row(Difficulty={"unknown": 1})]
        repo.answer.return_value = SimpleNamespace(Id=CHILD, Answer=None, IsCorrect=None, Score=None)
        detail = await HistoryService(repo).get(SESSION, ACTOR)
        self.assertEqual(detail.availability.comprehension, "partial")
        self.assertTrue(detail.comprehension[0].question.answered)
        self.assertIsNone(detail.comprehension[0].answer)

    async def test_last_supported_page_never_emits_unusable_cursor(self):
        repo = history_repo()
        repo.sessions.return_value = [session_row(), session_row()]
        response = await HistoryService(repo).list(CHILD, ACTOR, "page-100000", 1)
        self.assertIsNone(response.next_cursor)

    async def test_sort_and_paging_are_stable(self):
        from unittest.mock import MagicMock, AsyncMock
        from sqlalchemy.dialects import postgresql
        db = MagicMock()
        db.execute = AsyncMock(return_value=MagicMock())
        await HistoryRepository(db).sessions(CHILD, ACTOR, 2, 2)
        query = db.execute.await_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn("ORDER BY readingsessions.startedat DESC, readingsessions.id DESC", str(query))
        self.assertEqual(query.params["param_1"], 3)
        self.assertEqual(query.params["param_2"], 2)


class HistoryHttpContractTests(unittest.TestCase):
    def setUp(self):
        self.repo = history_repo()
        self.repo.session.return_value = session_row(State="COMPLETED", EndedAt=None)
        self.repo.sessions.return_value = [session_row(State="IN_PROGRESS", EndedAt=None)]
        app = FastAPI()
        app.include_router(reading_router, prefix="/reading")
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        app.dependency_overrides[get_db] = lambda: None
        self.client = TestClient(app)
        self.patch = patch("app.api.routes.reading.HistoryRepository", return_value=self.repo)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.client.close)

    def test_wire_contract_maps_completed_and_exposes_availability(self):
        response = self.client.get(f"/reading/history/{SESSION}")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["state"], "FINISHED")
        self.assertIsNone(data["duration_ms"])
        self.assertEqual(data["availability"]["events"], "absent")
        response = self.client.get(f"/reading/history?child_id={CHILD}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sessions"][0]["state"], "IN_PROGRESS")

    def test_foreign_detail_is_not_found_before_optional_queries(self):
        self.repo.session.return_value = None
        self.assertEqual(self.client.get(f"/reading/history/{SESSION}").status_code, 404)
        self.repo.events.assert_not_awaited()

    def test_input_validation_rejects_unbounded_or_malformed_queries(self):
        for query in ("limit=0", "limit=101", "cursor=page-100001", "cursor=page-1garbage"):
            self.assertEqual(self.client.get(f"/reading/history?child_id={CHILD}&{query}").status_code, 422)
        self.assertEqual(self.client.get("/reading/history/not-a-uuid").status_code, 422)


if __name__ == "__main__":
    unittest.main()
