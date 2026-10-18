"""Saved progress contract: isolated fixtures, never seed or write a real database."""
import os
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql
from app.api.deps import get_current_parent_id, get_db
from app.api.routes.system import ProgressService, ProgressRepository, router
from test_parent_reports import report_payload

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
CHILD = UUID("22222222-2222-4222-8222-222222222222")
REPORT = UUID("44444444-4444-4444-8444-444444444444")
START, END = date(2026, 9, 9), date(2026, 10, 8)
GENERATED = datetime(2026, 10, 8, tzinfo=timezone.utc)


def row(summary):
    return SimpleNamespace(Id=REPORT, ChildId=CHILD, PeriodStart=START,
        PeriodEnd=END, GeneratedAt=GENERATED, Summary=summary)


def option():
    return dict(id=REPORT, child_id=CHILD, period_start=START, period_end=END, generated_at=GENERATED)


class SavedProgressTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.repo = MagicMock()
        self.repo.latest = AsyncMock(return_value=row(report_payload()))
        self.repo.report = AsyncMock(return_value=row(report_payload()))
        self.repo.periods = AsyncMock(return_value=[])
        self.access = MagicMock()
        self.access.require_child = AsyncMock()
        self.service = ProgressService(self.repo, self.access)

    async def test_default_reads_latest_without_a_current_calendar_window(self):
        result = await self.service.read(CHILD, ACTOR, None, None)
        self.repo.latest.assert_awaited_once_with(CHILD, ACTOR)
        self.repo.report.assert_not_awaited()
        self.assertEqual((result.period_start, result.period_end), (START, END))
        self.assertEqual(result.id, REPORT)
        self.assertEqual(result.data_status, "complete")

    async def test_exact_period_is_preserved(self):
        await self.service.read(CHILD, ACTOR, START, END)
        self.repo.report.assert_awaited_once_with(CHILD, START, END, ACTOR)
        self.repo.latest.assert_not_awaited()

    async def test_missing_report_is_404_not_a_zero_snapshot(self):
        self.repo.latest.return_value = None
        with self.assertRaises(HTTPException) as error:
            await self.service.read(CHILD, ACTOR, None, None)
        self.assertEqual(error.exception.status_code, 404)

    async def test_one_sided_or_inverted_period_never_queries(self):
        for start, end in [(None, END), (START, None), (END, START)]:
            with self.assertRaises(HTTPException) as error:
                await self.service.read(CHILD, ACTOR, start, end)
            self.assertEqual(error.exception.status_code, 422)
        self.repo.latest.assert_not_awaited()
        self.repo.report.assert_not_awaited()

    async def test_ownership_is_checked_for_latest_exact_and_periods(self):
        self.access.require_child.side_effect = HTTPException(404)
        for action in [self.service.read(CHILD, ACTOR, None, None),
                       self.service.read(CHILD, ACTOR, START, END),
                       self.service.periods(CHILD, ACTOR, None, 20)]:
            with self.assertRaises(HTTPException):
                await action
        self.repo.latest.assert_not_awaited()
        self.repo.report.assert_not_awaited()
        self.repo.periods.assert_not_awaited()

    async def test_periods_paging_requests_limit_plus_one(self):
        self.repo.periods.return_value = [option(), option(), option()]
        page = await self.service.periods(CHILD, ACTOR, "page-2", 2)
        self.repo.periods.assert_awaited_once_with(CHILD, ACTOR, 2, 3)
        self.assertEqual(len(page.items), 2)
        self.assertEqual(page.next_cursor, "page-3")

    async def test_empty_periods_are_a_real_empty_page(self):
        page = await self.service.periods(CHILD, ACTOR, None, 20)
        self.assertEqual(page.items, [])
        self.assertIsNone(page.next_cursor)

    async def test_bad_cursor_and_limit_are_rejected(self):
        for cursor, limit in [("page-0", 20), ("page-100001", 20), ("page-２", 20),
                              ("arbitrary", 20), (None, 0), (None, 101)]:
            with self.assertRaises(HTTPException) as error:
                await self.service.periods(CHILD, ACTOR, cursor, limit)
            self.assertEqual(error.exception.status_code, 422)
        self.repo.periods.assert_not_awaited()

    async def test_database_failure_is_not_an_empty_page(self):
        self.repo.periods.side_effect = RuntimeError("isolated database unavailable")
        with self.assertRaises(RuntimeError):
            await self.service.periods(CHILD, ACTOR, None, 20)

    async def test_words_only_still_uses_90_day_exact_window(self):
        self.repo.report.return_value = row({"difficult_words": []})
        result = await self.service.read(CHILD, ACTOR, None, END, words_only=True)
        self.assertEqual(result, [])
        self.assertEqual((self.repo.report.await_args.args[2] - self.repo.report.await_args.args[1]).days, 89)
        self.repo.latest.assert_not_awaited()


class SavedProgressMappingTests(unittest.TestCase):
    def test_partial_values_and_real_zero_are_preserved(self):
        result = ProgressService.saved_report(row({"completed_sessions": 0, "reading_duration_ms": 2000}))
        self.assertEqual(result.completed_sessions, 0)
        self.assertEqual(result.reading_duration_ms, 2000)
        self.assertIsNone(result.omission_count)
        self.assertIsNone(result.difficult_words)
        self.assertEqual(result.data_status, "partial")

    def test_invalid_fields_never_hide_other_valid_metrics(self):
        for bad in [-1, True, "3", float("nan"), float("inf"), {}, None]:
            result = ProgressService.saved_report(row({"completed_sessions": bad, "omission_count": 2}))
            self.assertIsNone(result.completed_sessions)
            self.assertEqual(result.omission_count, 2)

    def test_out_of_range_rates_are_not_percentages(self):
        result = ProgressService.saved_report(row({"omission_rate": 101, "comprehension_accuracy": -1}))
        self.assertIsNone(result.omission_rate)
        self.assertIsNone(result.comprehension_accuracy)

    def test_legacy_is_explicit_without_remapping_or_private_json(self):
        result = ProgressService.saved_report(row({"avg_fluency": 80, "total_books": 2, "secret_token": "not public"}))
        self.assertEqual(result.legacy.avg_fluency, 80)
        self.assertEqual(result.legacy.total_books, 2)
        self.assertIsNone(result.completed_sessions)
        self.assertIsNone(result.comprehension_accuracy)
        self.assertNotIn("secret_token", result.model_dump_json())

    def test_unknown_non_object_summary_does_not_fall_back_to_older_report(self):
        for summary in [None, [], "bad", {"private": 1}]:
            result = ProgressService.saved_report(row(summary))
            self.assertEqual(result.data_status, "unsupported")
            self.assertIsNone(result.completed_sessions)

    def test_empty_words_and_invalid_words_are_distinct(self):
        empty = ProgressService.saved_report(row({"difficult_words": []}))
        invalid = ProgressService.saved_report(row({"difficult_words": [{}]}))
        self.assertEqual(empty.difficult_words, [])
        self.assertEqual(empty.availability["difficult_words"], "available")
        self.assertIsNone(invalid.difficult_words)
        self.assertEqual(invalid.availability["difficult_words"], "unsupported")

    def test_mixed_word_evidence_preserves_valid_items_and_marks_partial(self):
        word = dict(normalized_word="sach", display_text="sách", difficulty_score=2,
            omission_count=1, repetition_count=0, long_pause_count=0, read_example_count=0,
            session_count=1, last_seen_at=GENERATED.isoformat(), evidence_word_ids=[])
        result = ProgressService.saved_report(row({"difficult_words": [word, {}, {**word, "difficulty_score": float("inf") }]}))
        self.assertEqual(len(result.difficult_words), 1)
        self.assertEqual(result.availability["difficult_words"], "partial")

    def test_incomplete_comparison_is_not_invented(self):
        summary = report_payload()
        summary["previous_period"] = {"total_books": 3}
        result = ProgressService.saved_report(row(summary))
        self.assertIsNone(result.previous_period)
        self.assertIsNone(result.trend_deltas)
        self.assertEqual(result.availability["comparison"], "unsupported")

    def test_saved_comparison_is_preserved_not_recomputed(self):
        summary = report_payload()
        summary["previous_period"] = {k: summary[k] for k in (
            "completed_sessions", "reading_duration_ms", "omission_count", "repetition_count", "long_pause_count",
            "omission_rate", "repetition_rate", "long_pause_rate", "comprehension_accuracy")}
        summary["trend_deltas"]["completed_sessions"] = 1
        result = ProgressService.saved_report(row(summary))
        self.assertEqual(result.trend_deltas.completed_sessions, 1)
        self.assertEqual(result.availability["comparison"], "available")


class SavedProgressQueryTests(unittest.IsolatedAsyncioTestCase):
    async def test_latest_is_owned_and_ordered_by_period_then_generation(self):
        db = MagicMock(scalar=AsyncMock(return_value=None))
        await ProgressRepository(db).latest(CHILD, ACTOR)
        query = db.scalar.await_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn(ACTOR, query.params.values())
        self.assertIn(CHILD, query.params.values())
        self.assertIn("ORDER BY progressreports.periodend DESC, progressreports.periodstart DESC, progressreports.generatedat DESC, progressreports.id DESC", str(query))

    async def test_period_query_deduplicates_before_paging_and_never_selects_summary(self):
        db = MagicMock()
        result = MagicMock()
        result.mappings.return_value.all.return_value = []
        db.execute = AsyncMock(return_value=result)
        await ProgressRepository(db).periods(CHILD, ACTOR, 20, 21)
        query = db.execute.await_args.args[0].compile(dialect=postgresql.dialect())
        sql = str(query)
        self.assertIn("row_number() OVER (PARTITION BY", sql)
        self.assertIn("rank =", sql)
        self.assertNotIn(".summary", sql)
        self.assertIn(ACTOR, query.params.values())
        self.assertIn(21, query.params.values())


class SavedProgressHttpTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock(scalar=AsyncMock(return_value="admin"))
        self.app = FastAPI()
        self.app.include_router(router, prefix="/system")
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        self.client = TestClient(self.app)

    def test_both_routes_require_authentication_and_parent_role(self):
        paths = [f"/system/progress/{CHILD}", f"/system/progress/{CHILD}/periods"]
        for path in paths:
            self.assertEqual(self.client.get(path).status_code, 403)
        del self.app.dependency_overrides[get_current_parent_id]
        for path in paths:
            self.assertEqual(self.client.get(path).status_code, 401)

    def test_real_router_serializes_latest_and_periods_public_contract(self):
        with patch("app.api.routes.reading.HistoryService.require_child", new=AsyncMock()), \
             patch.object(ProgressRepository, "latest", new=AsyncMock(return_value=row(report_payload()))), \
             patch.object(ProgressRepository, "periods", new=AsyncMock(return_value=[option()])):
            report = self.client.get(f"/system/progress/{CHILD}")
            periods = self.client.get(f"/system/progress/{CHILD}/periods")
        self.assertEqual(report.status_code, 200)
        self.assertEqual(report.json()["id"], str(REPORT))
        self.assertEqual(report.json()["data_status"], "complete")
        self.assertEqual(periods.status_code, 200)
        self.assertEqual(periods.json()["items"][0]["period_start"], START.isoformat())

    def test_foreign_child_is_denied_by_the_actual_ownership_guard(self):
        for path in [f"/system/progress/{CHILD}", f"/system/progress/{CHILD}/periods"]:
            self.db.scalar.reset_mock()
            self.db.scalar.side_effect = ["parent", None]
            self.assertEqual(self.client.get(path).status_code, 404)
            self.assertEqual(self.db.scalar.await_count, 2)

    def test_bad_dates_are_validated_at_http_boundary(self):
        self.assertEqual(self.client.get(f"/system/progress/{CHILD}?period_start=2026-02-30").status_code, 422)
