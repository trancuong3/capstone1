"""Final assessment and retry regressions; all I/O uses isolated repositories."""
import unittest
from copy import deepcopy
from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException

from app.schemas.reading import CompareReadingRequest
from app.services.reading_assessment import aggregate_assessment, aggregate_period_assessment
from test_reading_comparison_service import (
    ACTOR_ID, PAGE_ID, REVISION_ID, SESSION_ID, saved_report, service_with_mocks,
)

WORD_ID = UUID("60000000-0000-4000-8000-000000000001")
OTHER_WORD_ID = UUID("60000000-0000-4000-8000-000000000002")


def final_report():
    row = saved_report()
    row.Summary = {**row.Summary, "assessment_version": 1, "initial_assessment": [
        {"word_id": str(WORD_ID), "word_index": 0, "text": "đỏ", "status": "MISPRONUNCIATION"},
        {"word_id": str(OTHER_WORD_ID), "word_index": 1, "text": "đỏ", "status": "CORRECT"},
    ]}
    return row


def retry(status="CONFIRMED", attempt=1, **overrides):
    values = dict(SessionId=SESSION_ID, PageId=PAGE_ID, PageRevisionId=REVISION_ID,
                  WordId=WORD_ID, Type="WORD_RETRY", Status=status,
                  Metadata={"retry_attempt": attempt, "incorrect_retry_count": 999})
    values.update(overrides)
    return SimpleNamespace(**values)


class AssessmentAggregationTests(unittest.TestCase):
    def test_partial_snapshot_keeps_known_errors_and_reports_uncertainty_separately(self):
        report = final_report()
        report.Summary["initial_assessment"].append({
            "word_id": "unknown-word", "word_index": 2, "text": "đọc", "status": "UNCERTAIN",
        })
        result = aggregate_assessment(SESSION_ID, [report], [])
        self.assertEqual(result["assessment"].first_pass_correct, 1)
        self.assertEqual(result["assessment"].first_pass_incorrect, 1)
        self.assertEqual(result["assessment"].recognition_uncertain, 1)
        self.assertEqual(result["assessment"].unresolved_words, 1)
        self.assertEqual(result["score"], 50)
        self.assertEqual(result["skipped_words"], [])

    def test_finalized_dashboard_preserves_insertions_from_saved_alignment(self):
        from app.services.child_progress.metrics import ReportRow, analyze_first_pass
        from app.services.text_alignment import align_text, summarize_alignment
        report = final_report()
        aligned = align_text("Bé mèo đọc", "Bé mèo đọc thêm")
        summary = summarize_alignment(aligned["alignment"], words=None, threshold=1.0)
        summary.update(assessment_version=1, initial_assessment=[
            {"word_id": str(index), "word_index": index, "text": word, "status": "CORRECT"}
            for index, word in enumerate("Bé mèo đọc".split())
        ])
        row = ReportRow(SESSION_ID, report.CreatedAt, aligned["alignment"], summary,
                        PAGE_ID, REVISION_ID, "Bé mèo đọc thêm")
        result = analyze_first_pass(row)
        self.assertEqual(summary["extra_words"], ["thêm"])
        self.assertEqual(result["inserted"], 1)
        self.assertEqual(result["correct"], 3)
        self.assertEqual(result["substituted"], 0)
        self.assertEqual(result["skipped"], 0)

    def test_percent_rounding_matches_the_browser_for_half_points(self):
        report = final_report()
        report.Summary["initial_assessment"] = [
            {"word_id": str(index), "word_index": index, "text": "đọc",
             "status": "CORRECT" if index == 0 else "MISPRONUNCIATION"}
            for index in range(8)
        ]
        self.assertEqual(aggregate_assessment(SESSION_ID, [report], [])["score"], 13)
    def test_dashboard_and_session_reports_share_the_immutable_first_pass(self):
        from dataclasses import replace
        from datetime import timedelta
        from app.services.child_progress.metrics import ReportRow, RetryEventRow, SessionRow, compute_window
        report = final_report()
        snapshot = ReportRow(SESSION_ID, report.CreatedAt, report.Alignment, report.Summary,
                             PAGE_ID, REVISION_ID, report.Transcript)
        later_correct_comparison = replace(snapshot, created_at=report.CreatedAt + timedelta(seconds=1),
            alignment=[{"status": "MATCH", "book_index": 0, "book_word": "đỏ"},
                       {"status": "MATCH", "book_index": 1, "book_word": "đỏ"}], summary={})
        recorded_retry = RetryEventRow(SESSION_ID, "CONFIRMED", report.CreatedAt,
            PAGE_ID, REVISION_ID, WORD_ID, {"retry_attempt": 1})
        window = compute_window(start=report.CreatedAt.date(), end=report.CreatedAt.date(),
            sessions=[SessionRow(SESSION_ID, OTHER_WORD_ID, "COMPLETED", report.CreatedAt,
                                 report.CreatedAt + timedelta(minutes=2))],
            reports=[later_correct_comparison, snapshot], retries=[recorded_retry], answers=[])
        canonical = aggregate_assessment(SESSION_ID, [report], [retry()])["assessment"]
        self.assertEqual(window.reading_assessment, canonical)
        self.assertEqual(window.pages_compared, 1)
        self.assertEqual(window.accuracy_pct, 50)
        self.assertEqual(window.substituted_words, 1)
        self.assertEqual(window.correct_words, 1)

    def test_corrupted_final_evidence_is_unknown_instead_of_fabricated_zeroes(self):
        for snapshot in ([], [{}], [{"word_id": "word", "status": "CORRECT"}]):
            report = final_report()
            report.Summary["initial_assessment"] = snapshot
            self.assertEqual(aggregate_assessment(SESSION_ID, [report], [retry()]), {"assessment": None})
    def test_self_correction_keeps_initial_error_and_duplicate_words_distinct(self):
        report = final_report()
        before = deepcopy(report.Summary)
        result = aggregate_assessment(SESSION_ID, [report], [retry(), retry()])
        self.assertEqual(result["assessment"].model_dump(), {
            "first_pass_correct": 1, "first_pass_incorrect": 1,
            "self_corrected_words": 1, "unresolved_words": 0, "retry_attempts": 1,
            "skipped_after_retry_limit": 0, "recognition_uncertain": 0,
        })
        self.assertEqual(result["score"], 50)
        self.assertEqual(result["correct_words"], ["đỏ"])
        self.assertEqual(result["mispronounced_words"], ["đỏ"])
        self.assertEqual(report.Summary, before)

    def test_uncertain_skip_is_durable_but_not_a_scored_incorrect_attempt(self):
        metrics = aggregate_assessment(SESSION_ID, [final_report()], [retry("UNCERTAIN")])["assessment"]
        self.assertEqual(metrics.first_pass_incorrect, 1)
        self.assertEqual(metrics.unresolved_words, 1)
        self.assertEqual(metrics.retry_attempts, 0)
        self.assertEqual(metrics.recognition_uncertain, 1)
        self.assertEqual(metrics.skipped_after_retry_limit, 0)

    def test_three_failed_attempts_count_once_and_cannot_leak_across_identity(self):
        metrics = aggregate_assessment(SESSION_ID, [final_report()], [
            retry("FAILED", 1), retry("FAILED", 1), retry("FAILED", 2), retry("FAILED", 3),
            retry(PageRevisionId=OTHER_WORD_ID), retry(SessionId=OTHER_WORD_ID),
            retry(WordId=OTHER_WORD_ID),
        ])["assessment"]
        self.assertEqual(metrics.retry_attempts, 3)
        self.assertEqual(metrics.skipped_after_retry_limit, 1)
        self.assertEqual(metrics.unresolved_words, 1)
        self.assertEqual(metrics.self_corrected_words, 0)

    def test_legacy_and_missing_evidence_are_unknown_not_perfect_or_zero(self):
        self.assertEqual(aggregate_assessment(SESSION_ID, [saved_report()], [retry()]), {"assessment": None})

    def test_uncertain_word_never_becomes_error_from_a_retry_event(self):
        report = final_report()
        report.Summary["initial_assessment"][0]["status"] = "UNCERTAIN"
        result = aggregate_assessment(SESSION_ID, [report], [retry("FAILED")])
        self.assertEqual(result["assessment"].first_pass_incorrect, 0)
        self.assertEqual(result["assessment"].retry_attempts, 0)
        self.assertEqual(result["assessment"].recognition_uncertain, 1)

    def test_parent_period_uses_identical_metrics_and_explicit_missing_coverage(self):
        result = aggregate_period_assessment([
            (SESSION_ID, [final_report()], [retry()]),
            (OTHER_WORD_ID, [], []),
        ])
        self.assertEqual(result["assessment"].first_pass_correct, 1)
        self.assertEqual(result["assessment"].first_pass_incorrect, 1)
        self.assertEqual(result["assessment"].self_corrected_words, 1)
        self.assertEqual(result["assessment_coverage"], {"assessed_sessions": 1, "total_sessions": 2})


class FinalAssessmentTests(unittest.IsolatedAsyncioTestCase):
    def service(self):
        service = service_with_mocks()
        service.content.get_page.return_value.words = [
            SimpleNamespace(word_id=WORD_ID, word_index=0, text="đỏ"),
            SimpleNamespace(word_id=OTHER_WORD_ID, word_index=1, text="đỏ"),
        ]
        return service

    def payload(self, **changes):
        data = dict(transcript="Con mèo đang ngủ.", page_id=PAGE_ID, page_revision_id=REVISION_ID,
                    finalize=True, initial_assessment=[
                        {"word_id": WORD_ID, "status": "MISPRONUNCIATION"},
                        {"word_id": OTHER_WORD_ID, "status": "CORRECT"},
                    ])
        return CompareReadingRequest(**{**data, **changes})

    async def test_lost_response_replay_returns_same_final_report_even_after_finish(self):
        service = self.service()
        service.repository.lock_session.return_value.State = "COMPLETED"
        service.repository.finalized_for_page.return_value = final_report()
        result = await service.compare(SESSION_ID, ACTOR_ID, self.payload())
        self.assertEqual(result.report_id, saved_report().Id)
        service.repository.create.assert_not_awaited()

    async def test_corrected_transcript_cannot_replace_initial_assessment(self):
        service = self.service()
        service.repository.finalized_for_page.return_value = final_report()
        for payload in (self.payload(transcript="đỏ đỏ"), self.payload(initial_assessment=[
            {"word_id": WORD_ID, "status": "CORRECT"},
            {"word_id": OTHER_WORD_ID, "status": "CORRECT"},
        ])):
            with self.assertRaises(HTTPException) as caught:
                await service.compare(SESSION_ID, ACTOR_ID, payload)
            self.assertEqual(caught.exception.status_code, 409)
        service.repository.create.assert_not_awaited()

    async def test_unknown_or_duplicate_word_identity_is_rejected(self):
        service = self.service()
        for words in ([], [{"word_id": WORD_ID, "status": "CORRECT"}] * 2):
            with self.assertRaises(HTTPException) as caught:
                await service.compare(SESSION_ID, ACTOR_ID, self.payload(initial_assessment=words))
            self.assertEqual(caught.exception.status_code, 422)
        service.repository.create.assert_not_awaited()

    async def test_final_report_cannot_be_deleted(self):
        service = self.service()
        service.repository.get.return_value = final_report()
        with self.assertRaises(HTTPException) as caught:
            await service.delete(saved_report().Id, ACTOR_ID)
        self.assertEqual(caught.exception.status_code, 409)
        service.repository.delete.assert_not_awaited()

    async def test_new_final_report_keeps_word_identity_and_unknown_evidence(self):
        service = self.service()
        async def persist(row):
            row.Id = saved_report().Id
            row.CreatedAt = saved_report().CreatedAt
            return row
        service.repository.create.side_effect = persist
        result = await service.compare(SESSION_ID, ACTOR_ID, self.payload())
        self.assertEqual(result.summary["initial_assessment"], final_report().Summary["initial_assessment"])
        service.repository.lock_session.assert_awaited_once_with(SESSION_ID)
