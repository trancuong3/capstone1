"""Tests for the AI progress assessment of a child."""

import asyncio
import json
import os
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import child_progress as progress_routes
from app.services import child_progress_service as service_module
from app.services.child_progress.ai import (
    AssessmentAIError,
    ChildProgressAI,
    ChildProgressConfig,
    parse_assessment,
)
from app.services.child_progress.assessor import (
    AssessmentFacts,
    facts_payload,
    rule_based_assessment,
)
from app.services.child_progress.metrics import (
    VIETNAM_TZ,
    AnswerRow,
    ReportRow,
    RetryEventRow,
    SessionRow,
    analyze_alignment,
    compute_window,
    top_difficult_words,
)
from app.services.child_progress.scoring import (
    component_scores,
    grade_for,
    overall_score,
)
from app.services.child_progress_service import ChildProgressService

PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
OTHER_PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
CHILD_ID = UUID("33333333-3333-4333-8333-333333333333")
NOW = datetime(2026, 11, 9, 12, 0, tzinfo=VIETNAM_TZ)
BOOK = uuid4()


def run(coro):
    return asyncio.run(coro)


def entry(status, index, book_word=None, spoken_word=None):
    item = {"status": status}
    if index is not None:
        item["book_index"] = index
    if book_word is not None:
        item["book_word"] = book_word
    if spoken_word is not None:
        item["spoken_word"] = spoken_word
    return item


def alignment(correct=10, substituted=0, skipped=0, trailing=0, inserted=0):
    """MATCH words, then SUBSTITUTE, DELETE (skipped), then unread tail."""
    result, index = [], 0
    for _ in range(correct):
        result.append(entry("MATCH", index, f"w{index}", f"w{index}"))
        index += 1
    for _ in range(substituted):
        result.append(entry("SUBSTITUTE", index, "dây", "dậy"))
        index += 1
    for _ in range(skipped):
        result.append(entry("DELETE", index, "sáng"))
        index += 1
    # one more match so the skips are *before* the last attempted word
    result.append(entry("MATCH", index, "cuối", "cuối"))
    index += 1
    for _ in range(trailing):
        result.append(entry("DELETE", index, "chưa"))
        index += 1
    for _ in range(inserted):
        result.append(entry("INSERT", None, None, "thừa"))
    return result


def session(day_offset=0, minutes=10, state="COMPLETED", sid=None, book=BOOK, hour=9):
    started = (NOW - timedelta(days=day_offset)).replace(hour=hour)
    return SessionRow(
        id=sid or uuid4(),
        book_id=book,
        state=state,
        started_at=started,
        ended_at=started + timedelta(minutes=minutes) if minutes is not None else None,
    )


def report(sess, align, hesitations=0, repeated=0, offset_hours=0):
    return ReportRow(
        session_id=sess.id,
        created_at=sess.started_at + timedelta(hours=offset_hours, minutes=1),
        alignment=align,
        summary={"hesitations": [{}] * hesitations, "repeated_count": repeated},
    )


WINDOW = dict(start=date(2026, 10, 11), end=date(2026, 11, 9))


class AlignmentTests(unittest.TestCase):
    def test_unread_tail_is_not_counted_against_accuracy(self):
        analysis = analyze_alignment(alignment(correct=10, trailing=50))
        self.assertEqual(
            (analysis["reached"], analysis["correct"], analysis["skipped"]), (11, 11, 0)
        )
        self.assertEqual(analysis["book_total"], 61)

    def test_skips_before_the_last_read_word_are_omissions(self):
        analysis = analyze_alignment(alignment(correct=5, substituted=2, skipped=3))
        self.assertEqual(analysis["correct"], 6)
        self.assertEqual(analysis["substituted"], 2)
        self.assertEqual(analysis["skipped"], 3)
        self.assertEqual(analysis["reached"], 11)
        self.assertEqual(analysis["errors"]["dây"], 2)
        self.assertEqual(analysis["errors"]["sáng"], 3)
        self.assertEqual(analysis["heard"]["dây"]["dậy"], 2)

    def test_nothing_attempted_or_garbage_gives_none(self):
        self.assertIsNone(analyze_alignment([entry("DELETE", 0, "a"), entry("DELETE", 1, "b")]))
        self.assertIsNone(analyze_alignment("nope"))
        self.assertIsNone(analyze_alignment([]))
        self.assertIsNone(analyze_alignment([1, None, "x"]))


class WindowTests(unittest.TestCase):
    def test_sessions_minutes_days_and_books(self):
        other_book = uuid4()
        sessions = [
            session(0, 10),
            session(0, 20, hour=15),  # same day
            session(3, 5, book=other_book),
            session(2, 10, state="ACTIVE"),  # not finished
            session(1, None),  # finished but never ended: zero minutes
            session(1, 5000),  # forgotten open session is capped at 90 minutes
            session(40, 10),  # outside the window
        ]
        metrics = compute_window(**WINDOW, sessions=sessions, reports=[], retries=[], answers=[])
        self.assertEqual(metrics.sessions, 5)
        self.assertEqual(metrics.active_days, 3)
        self.assertEqual(metrics.books, 2)
        self.assertEqual(metrics.reading_minutes, 10 + 20 + 5 + 90)

    def test_uses_vietnam_calendar_days(self):
        # 23:30 on 10 Oct in UTC is already 11 Oct in Vietnam -> inside the window.
        started = datetime(2026, 10, 10, 23, 30, tzinfo=timezone.utc)
        sess = SessionRow(uuid4(), BOOK, "COMPLETED", started, started + timedelta(minutes=5))
        metrics = compute_window(**WINDOW, sessions=[sess], reports=[], retries=[], answers=[])
        self.assertEqual(metrics.sessions, 1)

    def test_reading_accuracy_pauses_and_difficult_words(self):
        a, b = session(1), session(2)
        reports = [
            report(a, alignment(correct=15, substituted=3, skipped=2, trailing=40), hesitations=2, repeated=1),
            report(b, alignment(correct=20, substituted=1), hesitations=1),
        ]
        metrics = compute_window(**WINDOW, sessions=[a, b], reports=reports, retries=[], answers=[])
        self.assertEqual(metrics.pages_compared, 2)
        self.assertEqual(metrics.words_read, 21 + 22)
        self.assertEqual(metrics.correct_words, 16 + 21)
        self.assertEqual(metrics.hesitations, 3)
        self.assertEqual(metrics.repeated_words, 1)
        self.assertAlmostEqual(metrics.accuracy_pct, round(37 * 100 / 43, 1))
        words = top_difficult_words(metrics)
        self.assertEqual(words[0], {"word": "dây", "times": 4, "heard_as": "dậy"})
        self.assertEqual(words[1]["word"], "sáng")

    def test_reports_of_other_windows_are_ignored(self):
        old = session(60)
        metrics = compute_window(
            **WINDOW, sessions=[old], reports=[report(old, alignment())], retries=[], answers=[]
        )
        self.assertEqual(metrics.pages_compared, 0)

    def test_comprehension_counts_only_the_first_try_per_question(self):
        q1, q2, q3 = uuid4(), uuid4(), uuid4()
        base = NOW - timedelta(days=1)
        answers = [
            AnswerRow(q1, "FACTUAL", False, base),
            AnswerRow(q1, "FACTUAL", True, base + timedelta(seconds=5)),  # retry: ignored
            AnswerRow(q2, "CLOZE", True, base),
            AnswerRow(q3, "FACTUAL", True, base),
            AnswerRow(q3, "FACTUAL", None, base + timedelta(seconds=1)),
        ]
        metrics = compute_window(**WINDOW, sessions=[], reports=[], retries=[], answers=answers)
        self.assertEqual(metrics.comprehension_answered, 3)
        self.assertEqual(metrics.comprehension_first_try_correct, 2)
        self.assertEqual(metrics.comprehension_by_type, {"FACTUAL": [2, 1], "CLOZE": [1, 1]})

    def test_word_retries(self):
        sess = session(1)
        when = sess.started_at
        retries = [
            RetryEventRow(sess.id, "CONFIRMED", when),
            RetryEventRow(sess.id, "FAILED", when),
            RetryEventRow(sess.id, "FAILED", when),
            RetryEventRow(sess.id, "DISMISSED", when),
        ]
        metrics = compute_window(**WINDOW, sessions=[sess], reports=[], retries=retries, answers=[])
        self.assertEqual((metrics.retry_confirmed, metrics.retry_failed), (1, 2))

    def test_weekly_buckets_cover_the_window(self):
        sess = session(0)
        metrics = compute_window(**WINDOW, sessions=[sess], reports=[report(sess, alignment())], retries=[], answers=[])
        self.assertEqual(len(metrics.weekly), 5)  # 30 days -> 5 buckets
        self.assertEqual(metrics.weekly[0]["week_start"], date(2026, 10, 11))
        self.assertEqual(metrics.weekly[-1]["sessions"], 1)
        self.assertIsNotNone(metrics.weekly[-1]["accuracy_pct"])
        self.assertIsNone(metrics.weekly[0]["accuracy_pct"])


def window_with(accuracy_words=(30, 0, 0), hesitations=0, repeated=0, days_active=10, answers=None):
    sessions = [session(offset) for offset in range(days_active)]
    correct, substituted, skipped = accuracy_words
    reports = []
    if sum(accuracy_words):
        # An unfinished session still owns the report but is not an attended day.
        owner = sessions[0] if sessions else session(0, state="ACTIVE")
        if not sessions:
            sessions.append(owner)
        reports = [report(owner, alignment(correct, substituted, skipped), hesitations, repeated)]
    return compute_window(**WINDOW, sessions=sessions, reports=reports, retries=[], answers=answers or [])


class ScoringTests(unittest.TestCase):
    def test_components_and_overall(self):
        metrics = window_with(accuracy_words=(39, 0, 0), hesitations=0, days_active=13)
        scores = {c.key: c.score for c in component_scores(metrics, 30)}
        self.assertEqual(scores["ACCURACY"], 100)
        self.assertEqual(scores["FLUENCY"], 100)
        self.assertIsNone(scores["COMPREHENSION"])
        self.assertEqual(scores["CONSISTENCY"], 100)
        self.assertEqual(overall_score(component_scores(metrics, 30)), 100)

    def test_disfluency_lowers_fluency(self):
        metrics = window_with(accuracy_words=(39, 0, 0), hesitations=4)
        fluency = next(c for c in component_scores(metrics, 30) if c.key == "FLUENCY")
        self.assertEqual(fluency.score, 100 - round(5 * 4 * 100 / 40))

    def test_needs_reading_or_comprehension_evidence(self):
        attendance_only = window_with(accuracy_words=(0, 0, 0))
        comps = component_scores(attendance_only, 30)
        self.assertIsNotNone(next(c for c in comps if c.key == "CONSISTENCY").score)
        self.assertIsNone(overall_score(comps))

    def test_too_few_words_or_answers_are_not_scored(self):
        metrics = window_with(accuracy_words=(5, 0, 0))
        self.assertIsNone(next(c for c in component_scores(metrics, 30) if c.key == "ACCURACY").score)
        few = [AnswerRow(uuid4(), "FACTUAL", True, NOW - timedelta(days=1)) for _ in range(2)]
        metrics = window_with(accuracy_words=(0, 0, 0), answers=few)
        self.assertIsNone(next(c for c in component_scores(metrics, 30) if c.key == "COMPREHENSION").score)

    def test_weights_renormalize_over_available_components(self):
        answers = [AnswerRow(uuid4(), "FACTUAL", i < 3, NOW - timedelta(days=1)) for i in range(4)]
        metrics = window_with(accuracy_words=(19, 0, 0), days_active=0, answers=answers)
        comps = component_scores(metrics, 30)
        scores = {c.key: c.score for c in comps if c.score is not None}
        expected = round((0.40 * scores["ACCURACY"] + 0.25 * scores["COMPREHENSION"] + 0.20 * scores["FLUENCY"]) / 0.85)
        self.assertEqual(overall_score(comps), expected)

    def test_grades(self):
        self.assertIsNone(grade_for(None))
        self.assertEqual(grade_for(90)[0], "EXCELLENT")
        self.assertEqual(grade_for(70)[0], "GOOD")
        self.assertEqual(grade_for(55)[0], "FAIR")
        self.assertEqual(grade_for(10)[0], "NEEDS_SUPPORT")


def facts_for(metrics, previous=None, days=30):
    previous = previous or window_with(accuracy_words=(0, 0, 0), days_active=0)
    comps = component_scores(metrics, days)
    prev_comps = component_scores(previous, days)
    return AssessmentFacts(
        days=days,
        metrics=metrics,
        previous=previous,
        components=comps,
        previous_components=prev_comps,
        overall=overall_score(comps),
        previous_overall=overall_score(prev_comps),
        difficult_words=top_difficult_words(metrics),
    )


class RuleBasedTests(unittest.TestCase):
    def test_strong_reader_gets_strengths_and_default_actions(self):
        facts = facts_for(window_with(accuracy_words=(60, 1, 0), days_active=13))
        text = rule_based_assessment(facts)
        self.assertEqual(text.source, "RULE_BASED")
        self.assertTrue(text.strengths)
        self.assertEqual(text.weaknesses, [])
        self.assertGreaterEqual(len(text.actions), 2)
        self.assertIn("/100", text.summary)

    def test_skipping_is_called_out_with_a_matching_action(self):
        facts = facts_for(window_with(accuracy_words=(10, 2, 14), days_active=13))
        text = rule_based_assessment(facts)
        self.assertTrue(any("bỏ sót" in w.area for w in text.weaknesses))
        self.assertTrue(any("chỉ" in a.title for a in text.actions))

    def test_misreading_points_to_the_difficult_words(self):
        facts = facts_for(window_with(accuracy_words=(10, 14, 1), days_active=13))
        text = rule_based_assessment(facts)
        self.assertTrue(any("đọc nhầm" in w.area.lower() for w in text.weaknesses))
        self.assertIn("dây", " ".join(a.detail for a in text.actions))
        self.assertIn("dây", text.practice_words)

    def test_trend_is_described_from_the_data(self):
        before = window_with(accuracy_words=(10, 14, 1), days_active=13)
        now = window_with(accuracy_words=(60, 1, 0), days_active=13)
        facts = facts_for(now, previous=before)
        self.assertGreaterEqual(facts.delta, 3)
        self.assertIn("tăng", rule_based_assessment(facts).summary)

    def test_insufficient_data_is_honest(self):
        facts = facts_for(window_with(accuracy_words=(0, 0, 0), days_active=0))
        text = rule_based_assessment(facts)
        self.assertIsNone(facts.overall)
        self.assertIn("chưa có đủ dữ liệu", text.summary)

    def test_ai_payload_has_no_identifiers_or_name(self):
        facts = facts_for(window_with(accuracy_words=(10, 14, 1), days_active=13))
        raw = json.dumps(facts_payload(facts), ensure_ascii=False)
        self.assertNotIn(str(CHILD_ID), raw)
        self.assertNotIn("words_per_minute", raw)
        self.assertIn("difficult_words", raw)


GOOD_AI = {
    "headline": "Bé đang tiến bộ",
    "summary": "Trong 30 ngày bé đọc đều đặn.",
    "strengths": ["Đọc đúng nhiều từ"],
    "weaknesses": [{"area": "Hay bỏ sót từ", "detail": "Bỏ sót 12,8% số từ."}],
    "actions": [
        {"title": "Chỉ từng từ", "detail": "Dùng ngón tay chỉ.", "audience": "parent"},
        {"title": "Đọc lại", "detail": "Đọc lại 3 lần.", "audience": "CHILD"},
        {"title": "Sai đối tượng", "detail": "x", "audience": "TEACHER"},
    ],
    "practice_words": ["Dây", "không có trong danh sách", "dây", "sáng"],
    "encouragement": "Bé giỏi lắm!",
}


class AIParsingTests(unittest.TestCase):
    def test_cleans_and_filters_model_output(self):
        parsed = parse_assessment(GOOD_AI, allowed_words=["dây", "sáng"], model="m")
        self.assertEqual(parsed.source, "AI")
        self.assertEqual(parsed.model, "m")
        self.assertEqual([a.audience for a in parsed.actions], ["PARENT", "CHILD"])
        self.assertEqual(parsed.practice_words, ["dây", "sáng"])

    def test_unusable_output_is_rejected(self):
        for bad in (
            None,
            "text",
            {**GOOD_AI, "headline": ""},
            {**GOOD_AI, "summary": None},
            {**GOOD_AI, "encouragement": "  "},
            {**GOOD_AI, "actions": []},
            {**GOOD_AI, "actions": [{"title": "t", "detail": "d", "audience": "X"}]},
        ):
            self.assertIsNone(parse_assessment(bad, allowed_words=[], model="m"), bad)

    def test_long_text_is_trimmed(self):
        parsed = parse_assessment({**GOOD_AI, "summary": "a " * 2000}, allowed_words=[], model="m")
        self.assertLessEqual(len(parsed.summary), 900)


def gemini_body(payload):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]}


def groq_body(payload):
    return {"choices": [{"message": {"content": json.dumps(payload)}}]}


class AIProviderTests(unittest.TestCase):
    def cfg(self, **kw):
        values = dict(gemini_api_key="g", groq_api_key="q")
        values.update(kw)
        return ChildProgressConfig(**values)

    def test_gemini_success_keeps_key_in_header_and_sends_only_the_facts(self):
        seen = {}

        def handler(request):
            seen["key"] = request.headers.get("x-goog-api-key")
            seen["body"] = request.content.decode()
            return httpx.Response(200, json=gemini_body(GOOD_AI))

        ai = ChildProgressAI(self.cfg(), transport=httpx.MockTransport(handler))
        result = run(ai.assess({"overall_score": 63}, allowed_words=["dây"]))
        self.assertEqual(result.source, "AI")
        self.assertEqual(seen["key"], "g")
        self.assertNotIn('"g"', seen["body"])
        self.assertIn("overall_score", seen["body"])

    def test_quota_skips_the_other_gemini_model_and_uses_groq(self):
        calls = []

        def handler(request):
            calls.append(request.url.host)
            if "googleapis" in request.url.host:
                return httpx.Response(429)
            return httpx.Response(200, json=groq_body(GOOD_AI))

        ai = ChildProgressAI(self.cfg(), transport=httpx.MockTransport(handler))
        result = run(ai.assess({}, allowed_words=[]))
        self.assertEqual(result.source, "AI")
        self.assertEqual(calls.count("generativelanguage.googleapis.com"), 1)

    def test_overloaded_primary_model_still_tries_the_fallback_model(self):
        models = []

        def handler(request):
            models.append(request.url.path.split("/")[-1])
            if len(models) == 1:
                return httpx.Response(503)
            return httpx.Response(200, json=gemini_body(GOOD_AI))

        ai = ChildProgressAI(self.cfg(groq_api_key=None), transport=httpx.MockTransport(handler))
        result = run(ai.assess({}, allowed_words=[]))
        self.assertEqual(result.source, "AI")
        self.assertEqual(len(models), 2)
        self.assertNotEqual(models[0], models[1])

    def test_everything_failing_raises(self):
        ai = ChildProgressAI(
            self.cfg(),
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=gemini_body({"x": 1}) if "google" in r.url.host else groq_body({"x": 1}))),
        )
        with self.assertRaises(AssessmentAIError) as raised:
            run(ai.assess({}, allowed_words=[]))
        self.assertIn("gemini-primary:INVALID_CONTENT", raised.exception.attempts)

    def test_without_keys_or_when_disabled_nothing_is_called(self):
        def forbidden(request):
            raise AssertionError("network must not be used")

        for cfg in (ChildProgressConfig(), self.cfg(enabled=False)):
            ai = ChildProgressAI(cfg, transport=httpx.MockTransport(forbidden))
            self.assertFalse(ai.available)
            with self.assertRaises(AssessmentAIError):
                run(ai.assess({}, allowed_words=[]))


class FakeRepository:
    def __init__(self, owner=PARENT_ID):
        self.owner = owner
        sess = [session(offset) for offset in (1, 2, 3, 4, 5, 8, 9)]
        self.session_rows = sess
        self.report_rows = [
            report(sess[0], alignment(15, 5, 4, 20), hesitations=3, repeated=1),
            report(sess[1], alignment(20, 3, 2), hesitations=2),
        ]
        self.releases = 0

    async def owned_child(self, child_id, parent_id):
        return object() if child_id == CHILD_ID and parent_id == self.owner else None

    async def sessions(self, child_id, since):
        return self.session_rows

    async def reports(self, child_id, since):
        return self.report_rows

    async def word_retries(self, child_id, since):
        return []

    async def answers(self, child_id, since):
        return []

    async def release(self):
        self.releases += 1


class CountingAI:
    def __init__(self, fail=False):
        self.calls = 0
        self.fail = fail
        self.available = True

    async def assess(self, facts, *, allowed_words):
        self.calls += 1
        if self.fail:
            raise AssessmentAIError(["gemini-primary:PROVIDER_QUOTA"])
        return parse_assessment(GOOD_AI, allowed_words=allowed_words, model="fake-model")


def make_service(repo=None, ai=None, **cfg):
    repo = repo or FakeRepository()
    config = ChildProgressConfig(gemini_api_key="g", **cfg)
    return ChildProgressService(repo, ai or CountingAI(), config, now=lambda: NOW), repo


class ServiceTests(unittest.TestCase):
    def setUp(self):
        service_module.assessment_cache.clear()

    def test_other_parents_get_not_found_and_days_are_validated(self):
        service, _ = make_service()
        with self.assertRaises(HTTPException) as raised:
            run(service.assess(CHILD_ID, OTHER_PARENT_ID))
        self.assertEqual(raised.exception.status_code, 404)
        with self.assertRaises(HTTPException) as raised:
            run(service.assess(CHILD_ID, PARENT_ID, days=3))
        self.assertEqual(raised.exception.status_code, 422)

    def test_get_returns_scores_and_offline_comments_without_calling_ai(self):
        ai = CountingAI()
        service, repo = make_service(ai=ai)
        result = run(service.assess(CHILD_ID, PARENT_ID, days=30, use_ai=False))
        self.assertEqual(ai.calls, 0)
        self.assertEqual(result.data_status, "OK")
        self.assertEqual(result.assessment.source, "RULE_BASED")
        self.assertIsNotNone(result.score.overall)
        self.assertEqual(len(result.score.components), 4)
        self.assertEqual(len(result.weekly), 5)
        self.assertEqual((result.period_start, result.period_end), (date(2026, 10, 11), date(2026, 11, 9)))
        self.assertGreaterEqual(repo.releases, 1)  # DB released before any slow call

    def test_ai_comment_is_generated_once_then_served_from_cache(self):
        ai = CountingAI()
        service, _ = make_service(ai=ai)
        first = run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        second = run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        third_get = run(service.assess(CHILD_ID, PARENT_ID, use_ai=False))
        self.assertEqual(ai.calls, 1)
        self.assertEqual((first.assessment.source, first.ai_cached), ("AI", False))
        self.assertTrue(second.ai_cached and third_get.ai_cached)
        self.assertEqual(third_get.assessment.source, "AI")

    def test_changed_data_gets_a_new_comment(self):
        ai = CountingAI()
        service, repo = make_service(ai=ai)
        run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        repo.report_rows.append(report(repo.session_rows[2], alignment(30, 0, 0)))
        run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        self.assertEqual(ai.calls, 2)

    def test_refresh_respects_the_cooldown(self):
        ai = CountingAI()
        service, _ = make_service(ai=ai, refresh_cooldown_seconds=3600)
        run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        run(service.assess(CHILD_ID, PARENT_ID, use_ai=True, refresh=True))
        self.assertEqual(ai.calls, 1)

        service_module.assessment_cache.clear()
        ai = CountingAI()
        service, _ = make_service(ai=ai, refresh_cooldown_seconds=0)
        run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        run(service.assess(CHILD_ID, PARENT_ID, use_ai=True, refresh=True))
        self.assertEqual(ai.calls, 2)

    def test_ai_failure_falls_back_to_offline_comments_and_is_not_cached(self):
        ai = CountingAI(fail=True)
        service, _ = make_service(ai=ai)
        result = run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        self.assertEqual((result.assessment.source, result.ai_cached), ("RULE_BASED", False))
        run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        self.assertEqual(ai.calls, 2)  # a failure must not block a later retry

    def test_insufficient_data_never_calls_the_ai(self):
        ai = CountingAI()
        repo = FakeRepository()
        repo.report_rows = []
        repo.session_rows = []
        service, _ = make_service(repo=repo, ai=ai)
        result = run(service.assess(CHILD_ID, PARENT_ID, use_ai=True))
        self.assertEqual(ai.calls, 0)
        self.assertEqual(result.data_status, "INSUFFICIENT")
        self.assertIsNone(result.score.overall)
        self.assertEqual(result.assessment.source, "RULE_BASED")

    def test_previous_period_gives_a_trend(self):
        repo = FakeRepository()
        older = session(40)
        repo.session_rows.append(older)
        repo.report_rows.append(report(older, alignment(5, 20, 10)))
        service, _ = make_service(repo=repo)
        result = run(service.assess(CHILD_ID, PARENT_ID, days=30))
        self.assertIsNotNone(result.score.previous_overall)
        self.assertEqual(result.score.delta, result.score.overall - result.score.previous_overall)


class RouteTests(unittest.TestCase):
    def client(self, authenticated=True):
        app = FastAPI()
        app.include_router(progress_routes.router, prefix="/tutor")
        app.dependency_overrides[get_db] = lambda: None
        if authenticated:
            app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ID
        return TestClient(app)

    def test_authentication_is_required(self):
        client = self.client(authenticated=False)
        url = f"/tutor/children/{CHILD_ID}/progress-assessment"
        self.assertEqual(client.get(url).status_code, 401)
        self.assertEqual(client.post(url, json={"days": 30}).status_code, 401)

    def test_input_validation(self):
        client = self.client()
        url = f"/tutor/children/{CHILD_ID}/progress-assessment"
        self.assertEqual(client.get(url, params={"days": 3}).status_code, 422)
        self.assertEqual(client.get(url, params={"days": 365}).status_code, 422)
        self.assertEqual(client.post(url, json={"days": 100}).status_code, 422)
        self.assertEqual(client.post(url, json={"days": 30, "child_id": "x"}).status_code, 422)

    def test_get_and_post_delegate_to_the_service(self):
        service_module.assessment_cache.clear()
        service, _ = make_service()
        with patch.object(progress_routes, "_service", lambda db: service):
            client = self.client()
            url = f"/tutor/children/{CHILD_ID}/progress-assessment"
            got = client.get(url, params={"days": 30})
            self.assertEqual(got.status_code, 200)
            self.assertEqual(got.json()["assessment"]["source"], "RULE_BASED")
            posted = client.post(url, json={"days": 30})
            self.assertEqual(posted.status_code, 200)
            self.assertEqual(posted.json()["assessment"]["source"], "AI")
            self.assertEqual(
                client.get(f"/tutor/children/{uuid4()}/progress-assessment").status_code, 404
            )


if __name__ == "__main__":
    unittest.main()
