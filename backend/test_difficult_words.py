"""Comprehensive unit & HTTP tests for ViRead difficult words & word practice."""
from __future__ import annotations

import os
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.system import router as system_router
from app.models.difficult_word_practice import DifficultWordPracticeAttempt
from app.providers.elevenlabs_voice_provider import Transcription, VoiceProviderError
from app.repositories.difficult_words_repository import DifficultWordsRepository
from app.schemas.difficult_words import (
    DifficultWordPracticeCompleteRequest,
    DifficultWordPracticeStartRequest,
)
from app.services.difficult_words_service import (
    DifficultWordsService,
    classify_practice_transcript,
    compute_word_practice_progress,
    normalize_vietnamese_practice_word,
)
from app.services.reading_assessment import aggregate_assessment

BOOK_1 = UUID("33333333-3333-4333-8333-333333333331")
ACTOR = UUID("11111111-1111-4111-8111-111111111111")
OTHER_PARENT = UUID("99999999-9999-4999-8999-999999999999")
CHILD_A = UUID("22222222-2222-4222-8222-222222222222")
CHILD_B = UUID("22222222-2222-4222-8222-333333333333")
SESSION_1 = UUID("44444444-4444-4444-8444-444444444444")
PAGE_1 = UUID("55555555-5555-4555-8555-555555555555")
REV_1 = UUID("66666666-6666-4666-8666-666666666666")
WORD_1 = UUID("77777777-7777-4777-8777-777777777771")
WORD_2 = UUID("77777777-7777-4777-8777-777777777772")
WORD_3 = UUID("77777777-7777-4777-8777-777777777773")
NOW = datetime(2026, 11, 18, 2, 0, tzinfo=timezone.utc)


def make_access(role: str = "parent", owned_children: set[UUID] | None = None):
    owned = owned_children if owned_children is not None else {CHILD_A}
    access = MagicMock()

    async def require_child(child_id: UUID, actor_id: UUID):
        if role != "parent":
            raise HTTPException(status_code=403, detail="Access denied")
        if actor_id != ACTOR or child_id not in owned:
            raise HTTPException(status_code=404, detail="Resource not found")

    access.require_child = AsyncMock(side_effect=require_child)
    return access


class InMemoryPracticeRepo:
    async def lock_practice_request(self, child_id, request_id):
        pass

    def __init__(self, storage_ready: bool = True):
        self.storage_ready = storage_ready
        self.sessions_rows = []
        self.reports_rows = []
        self.event_rows = []
        self.books_map = {}
        self.pages_map = {}
        self.rev_words_map = {}
        self.saved_report_row = None
        self.attempts: list[DifficultWordPracticeAttempt] = []
        self.retry_events = []

    async def is_practice_storage_ready(self) -> bool:
        return self.storage_ready

    async def saved_progress_report(self, child_id, period_start, period_end, actor_id):
        return self.saved_report_row

    async def reading_sessions(self, child_id, actor_id, since, until_exclusive):
        return [r for r in self.sessions_rows if r.ChildId == child_id]

    async def comparison_reports(self, child_id, actor_id, since, until_exclusive):
        return list(self.reports_rows)

    async def reading_events_with_words(self, child_id, actor_id, since, until_exclusive):
        return list(self.event_rows)

    async def books_by_ids(self, book_ids):
        return {bid: self.books_map[bid] for bid in book_ids if bid in self.books_map}

    async def pages_and_revision_words(self, page_ids, revision_ids):
        pages = {pid: self.pages_map[pid] for pid in page_ids if pid in self.pages_map}
        words = {rid: self.rev_words_map[rid] for rid in revision_ids if rid in self.rev_words_map}
        return pages, words

    async def list_retry_events_for_child(self, child_id, actor_id, *, limit=2000):
        return list(reversed(self.retry_events))[:limit]

    async def find_retry_event_by_request(self, child_id, actor_id, normalized_word, completion_request_id):
        req_str = str(completion_request_id)
        for ev in self.retry_events:
            meta = ev.Metadata if isinstance(ev.Metadata, dict) else {}
            if meta.get("completion_request_id") == req_str:
                return ev
        return None

    async def resolve_retry_target(
        self,
        child_id,
        actor_id,
        *,
        session_id=None,
        page_id=None,
        page_revision_id=None,
        word_id=None,
    ):
        sess = next(
            (s for s in self.sessions_rows if s.ChildId == child_id and (session_id is None or s.Id == session_id)),
            None,
        )
        if sess is None:
            return None
        pid = page_id or (self.reports_rows[0].PageId if self.reports_rows else None)
        rid = page_revision_id or (self.reports_rows[0].PageRevisionId if self.reports_rows else None)
        if pid is None or rid is None:
            return None
        return (sess.Id, pid, rid, word_id)

    async def existing_word_retry_stats(self, session_id, page_id, page_revision_id, word_id):
        matching = [
            ev
            for ev in self.retry_events
            if ev.SessionId == session_id
            and ev.PageId == page_id
            and ev.PageRevisionId == page_revision_id
            and (word_id is None or ev.WordId == word_id)
        ]
        max_att = max(
            (
                ev.Metadata.get("retry_attempt", 0)
                for ev in matching
                if isinstance(ev.Metadata, dict) and isinstance(ev.Metadata.get("retry_attempt"), int)
            ),
            default=0,
        )
        inc = sum(1 for ev in matching if ev.Status == "FAILED")
        return max_att + 1, inc

    async def create_retry_event(self, event):
        if event.Id is None:
            event.Id = uuid4()
        self.retry_events.append(event)
        return event

    async def list_practice_attempts(
        self, child_id, actor_id, *, normalized_word=None, limit=1000
    ):
        rows = [
            a
            for a in self.attempts
            if a.ChildId == child_id
            and a.ParentId == actor_id
            and (normalized_word is None or a.NormalizedWord == normalized_word)
        ]
        rows.sort(key=lambda a: (a.StartedAt, a.AttemptNumber), reverse=True)
        return rows[:limit]

    async def find_practice_attempt_by_request(
        self, child_id, actor_id, normalized_word, request_id
    ):
        for a in self.attempts:
            if (
                a.ChildId == child_id
                and a.ParentId == actor_id
                and a.NormalizedWord == normalized_word
                and a.RequestId == request_id
            ):
                return a
        return None

    async def get_practice_attempt(self, child_id, attempt_id, actor_id):
        for a in self.attempts:
            if a.Id == attempt_id and a.ChildId == child_id and a.ParentId == actor_id:
                return a
        return None

    async def next_attempt_number(self, child_id, normalized_word) -> int:
        nums = [
            a.AttemptNumber
            for a in self.attempts
            if a.ChildId == child_id and a.NormalizedWord == normalized_word
        ]
        return max(nums, default=0) + 1

    async def create_practice_attempt(self, attempt: DifficultWordPracticeAttempt):
        if attempt.Id is None:
            attempt.Id = uuid4()
        self.attempts.append(attempt)
        return attempt

    async def save_practice_attempt(self, attempt: DifficultWordPracticeAttempt):
        return attempt


class VietnameseNormalizationTests(unittest.TestCase):
    def test_preserves_tones_and_d_and_compound_words(self):
        self.assertEqual(normalize_vietnamese_practice_word("Mèo!"), "mèo")
        self.assertNotEqual(
            normalize_vietnamese_practice_word("mèo"),
            normalize_vietnamese_practice_word("meo"),
        )
        self.assertNotEqual(
            normalize_vietnamese_practice_word("đường"),
            normalize_vietnamese_practice_word("dường"),
        )
        self.assertEqual(
            normalize_vietnamese_practice_word("  Khu Vườn, "),
            "khu vườn",
        )

    def test_classify_transcript_cases(self):
        self.assertEqual(classify_practice_transcript("mèo", "con mèo"), "CORRECT")
        self.assertEqual(classify_practice_transcript("khu vườn", "khu vườn nhỏ"), "CORRECT")
        self.assertEqual(classify_practice_transcript("mèo", "mẹo"), "INCORRECT")
        self.assertEqual(classify_practice_transcript("đường", "dường"), "INCORRECT")
        self.assertEqual(classify_practice_transcript("có", "cò"), "INCORRECT")
        self.assertEqual(classify_practice_transcript("có", "Có."), "CORRECT")
        self.assertEqual(classify_practice_transcript("có", "[tiếng đập]"), "NO_CLEAR_AUDIO")
        self.assertEqual(classify_practice_transcript("có", "có [tiếng đập]"), "CORRECT")
        self.assertEqual(classify_practice_transcript("dạy", "Dạy. Dạy. Dạy. Dạy. Dạy."), "CORRECT")
        self.assertEqual(classify_practice_transcript("mèo", "   "), "NO_CLEAR_AUDIO")
        self.assertEqual(
            classify_practice_transcript("mèo", "một hai ba bốn năm sáu"),
            "UNCERTAIN",
        )


class DifficultWordsAggregationAndPracticeTests(unittest.IsolatedAsyncioTestCase):
    def _sample_evidence(self):
        final_summary = {
            "assessment_version": 1,
            "initial_assessment": [
                {
                    "word_id": str(WORD_1),
                    "word_index": 0,
                    "text": "Mèo",
                    "status": "MISPRONUNCIATION",
                },
                {
                    "word_id": str(WORD_2),
                    "word_index": 1,
                    "text": "ngập",
                    "status": "OMISSION",
                },
                {
                    "word_id": str(WORD_3),
                    "word_index": 2,
                    "text": "xanh",
                    "status": "CORRECT",
                },
            ],
        }
        report = SimpleNamespace(
            SessionId=SESSION_1,
            PageId=PAGE_1,
            PageRevisionId=REV_1,
            CreatedAt=NOW - timedelta(hours=2),
            Transcript="xanh",
            Alignment=[],
            Summary=final_summary,
        )
        # Duplicate OMISSION event for WORD_2 should deduplicate against initial_assessment,
        # while REPETITION on WORD_1 adds distinct repetition difficulty signal.
        events = [
            (
                SimpleNamespace(
                    Id=uuid4(),
                    SessionId=SESSION_1,
                    PageId=PAGE_1,
                    PageRevisionId=REV_1,
                    WordId=WORD_2,
                    Type="OMISSION",
                    Status="CONFIRMED",
                    Metadata={},
                    CreatedAt=NOW - timedelta(hours=1),
                ),
                "ngập",
            ),
            (
                SimpleNamespace(
                    Id=uuid4(),
                    SessionId=SESSION_1,
                    PageId=PAGE_1,
                    PageRevisionId=REV_1,
                    WordId=WORD_1,
                    Type="REPETITION",
                    Status="DETECTED",
                    Metadata={},
                    CreatedAt=NOW - timedelta(hours=1),
                ),
                "Mèo",
            ),
            (
                SimpleNamespace(
                    Id=uuid4(),
                    SessionId=SESSION_1,
                    PageId=PAGE_1,
                    PageRevisionId=REV_1,
                    WordId=WORD_3,
                    Type="LONG_PAUSE",
                    Status="IGNORED_BY_GATE",
                    Metadata={},
                    CreatedAt=NOW - timedelta(hours=1),
                ),
                "xanh",
            ),
        ]
        session = SimpleNamespace(
            Id=SESSION_1,
            ChildId=CHILD_A,
            BookId=BOOK_1,
            StartedAt=NOW - timedelta(hours=3),
        )
        return session, report, events

    async def test_aggregates_real_words_provenance_and_context_without_mock_data(self):
        repo = InMemoryPracticeRepo()
        session, report, events = self._sample_evidence()
        repo.sessions_rows = [session]
        repo.reports_rows = [report]
        repo.event_rows = events
        repo.books_map = {
            BOOK_1: SimpleNamespace(
                Id=BOOK_1, Title="Chào ngày mới", Author="Minh Anh", MinGrade=1, MaxGrade=1
            )
        }
        repo.pages_map = {
            PAGE_1: SimpleNamespace(Id=PAGE_1, BookId=BOOK_1, PageNumber=2)
        }
        repo.rev_words_map = {
            REV_1: [
                SimpleNamespace(Id=WORD_1, WordIndex=0, Text="Mèo"),
                SimpleNamespace(Id=WORD_2, WordIndex=1, Text="ngập"),
                SimpleNamespace(Id=WORD_3, WordIndex=2, Text="xanh"),
            ]
        }

        service = DifficultWordsService(repo, make_access(), voice_provider=MagicMock())
        words = await service.list_difficult_words(CHILD_A, ACTOR)

        by_norm = {w.normalized_word: w for w in words}
        self.assertEqual(set(by_norm.keys()), {"mèo", "ngập"})
        self.assertEqual(by_norm["mèo"].mispronunciation_count, 1)
        self.assertEqual(by_norm["mèo"].repetition_count, 1)
        self.assertEqual(by_norm["mèo"].difficulty_score, 3.5)
        self.assertEqual(by_norm["ngập"].omission_count, 1)  # deduplicated
        self.assertEqual(by_norm["ngập"].difficulty_score, 2.0)
        self.assertEqual(words[0].normalized_word, "mèo")  # highest difficulty first
        self.assertTrue(len(by_norm["mèo"].sources) >= 1)
        self.assertEqual(by_norm["mèo"].sources[0].book_title, "Chào ngày mới")
        self.assertEqual(by_norm["mèo"].sources[0].page_number, 2)
        self.assertEqual(by_norm["mèo"].sources[0].context_phrase, "Mèo ngập xanh")

    async def test_ownership_prevents_cross_child_and_non_parent_access(self):
        repo = InMemoryPracticeRepo()
        session, report, events = self._sample_evidence()
        repo.sessions_rows = [session]
        repo.reports_rows = [report]
        repo.event_rows = events

        service = DifficultWordsService(repo, make_access("parent", {CHILD_A}), voice_provider=MagicMock())
        with self.assertRaises(HTTPException) as foreign_exc:
            await service.list_difficult_words(CHILD_B, ACTOR)
        self.assertEqual(foreign_exc.exception.status_code, 404)

        admin_service = DifficultWordsService(repo, make_access("admin", {CHILD_A}), voice_provider=MagicMock())
        with self.assertRaises(HTTPException) as role_exc:
            await admin_service.list_difficult_words(CHILD_A, ACTOR)
        self.assertEqual(role_exc.exception.status_code, 403)

    async def test_practice_mastery_succeeds_on_one_clear_read_and_never_penalizes_uncertain(self):
        repo = InMemoryPracticeRepo()
        session, report, events = self._sample_evidence()
        repo.sessions_rows = [session]
        repo.reports_rows = [report]
        repo.event_rows = events

        voice = MagicMock()
        voice.transcribe = AsyncMock(
            side_effect=[
                # Attempt 1: clear CORRECT read -> immediate COMPLETED!
                Transcription(text="mèo", language_code="vie", language_probability=0.95, words=[{"text": "mèo", "start": 0.0, "end": 0.4, "logprob": -0.1}]),
                # Attempt 2 on "ngập": INCORRECT -> NEEDS_MORE_PRACTICE (streak 0)
                Transcription(text="ngáp", language_code="vie", language_probability=0.95, words=[{"text": "ngáp", "start": 0.0, "end": 0.4, "logprob": -0.1}]),
                # Attempt 3 (ambient non-speech tag "[tiếng đập]") -> NO_CLEAR_AUDIO
                Transcription(text="[tiếng đập]", language_code="vie", language_probability=0.9, words=[]),
                # Attempt 4 on "ngập": clear CORRECT -> COMPLETED!
                Transcription(text="ngập", language_code="vie", language_probability=0.95, words=[{"text": "ngập", "start": 0.0, "end": 0.4, "logprob": -0.1}]),
            ]
        )

        service = DifficultWordsService(repo, make_access(), voice_provider=voice)

        # Snapshot initial first-pass assessment BEFORE any practice
        before_assessment = aggregate_assessment(SESSION_1, [report], [])["assessment"]

        # 1. Start + single clear read completes word immediately (required_consecutive_correct == 1)
        req1 = uuid4()
        a1 = await service.start_attempt(
            CHILD_A, ACTOR, DifficultWordPracticeStartRequest(request_id=req1, normalized_word="mèo", display_text="Mèo", evidence_word_ids=[WORD_1])
        )
        a1_dup = await service.start_attempt(
            CHILD_A, ACTOR, DifficultWordPracticeStartRequest(request_id=req1, normalized_word="mèo", display_text="Mèo")
        )
        self.assertEqual(a1.attempt_id, a1_dup.attempt_id)

        comp1 = uuid4()
        r1 = await service.evaluate_audio_attempt(
            CHILD_A, a1.attempt_id, ACTOR,
            completion_request_id=comp1, audio_bytes=b"webm-audio-1", filename="p.webm", content_type="audio/webm", audio_duration_ms=900,
        )
        self.assertEqual(r1.assessment_status, "CORRECT")
        self.assertEqual(r1.word_progress.practice_status, "COMPLETED")
        self.assertEqual(r1.word_progress.consecutive_correct_count, 1)
        self.assertEqual(r1.word_progress.required_consecutive_correct, 1)
        self.assertEqual(r1.next_recommended_word, "ngập")

        # Duplicate completion idempotency returns same result; conflicting completion raises 409
        r1_dup = await service.evaluate_audio_attempt(
            CHILD_A, a1.attempt_id, ACTOR,
            completion_request_id=comp1, audio_bytes=b"webm-audio-1", filename="p.webm", content_type="audio/webm",
        )
        self.assertEqual(r1_dup.attempt_id, r1.attempt_id)
        with self.assertRaises(HTTPException) as conflict:
            await service.complete_attempt(
                CHILD_A, a1.attempt_id, ACTOR,
                DifficultWordPracticeCompleteRequest(
                    completion_request_id=uuid4(),
                    assessment_status="INCORRECT",
                    recognition_source="SERVER_STT",
                ),
            )
        self.assertEqual(conflict.exception.status_code, 409)

        # 2. Incorrect -> NEEDS_MORE_PRACTICE
        r2 = await service.evaluate_word_direct(
            CHILD_A, ACTOR,
            request_id=uuid4(),
            normalized_word="ngập",
            display_text="ngập",
            audio_bytes=b"webm-audio-2",
            filename="p.webm",
            content_type="audio/webm",
            session_id=SESSION_1,
            page_id=PAGE_1,
            page_revision_id=REV_1,
            word_id=WORD_2,
        )
        self.assertEqual(r2.assessment_status, "INCORRECT")
        self.assertEqual(r2.word_progress.consecutive_correct_count, 0)
        self.assertEqual(r2.word_progress.practice_status, "NEEDS_MORE_PRACTICE")

        # 3. Ambient non-speech tag "[tiếng đập]" -> NO_CLEAR_AUDIO (never INCORRECT!)
        r3 = await service.evaluate_word_direct(
            CHILD_A, ACTOR,
            request_id=uuid4(),
            normalized_word="ngập",
            display_text="ngập",
            audio_bytes=b"webm-noise",
            filename="p.webm",
            content_type="audio/webm",
        )
        self.assertEqual(r3.assessment_status, "NO_CLEAR_AUDIO")
        self.assertEqual(r3.word_progress.practice_incorrect_count, 1)

        # 4. Silence gate -> NO_CLEAR_AUDIO preserves existing attempts without penalty
        a4 = await service.start_attempt(
            CHILD_A, ACTOR, DifficultWordPracticeStartRequest(request_id=uuid4(), normalized_word="mèo", display_text="Mèo")
        )
        r4 = await service.evaluate_audio_attempt(
            CHILD_A, a4.attempt_id, ACTOR,
            completion_request_id=uuid4(), audio_bytes=b"webm-silence", filename="p.webm", content_type="audio/webm",
            audio_quality_status="SILENCE",
        )
        self.assertEqual(r4.assessment_status, "NO_CLEAR_AUDIO")
        self.assertEqual(r4.recognition_source, "AUDIO_QUALITY_GATE")
        self.assertEqual(r4.word_progress.consecutive_correct_count, 1)

        # 5. Clear read of "ngập" -> COMPLETED!
        r5 = await service.evaluate_word_direct(
            CHILD_A, ACTOR,
            request_id=uuid4(),
            normalized_word="ngập",
            display_text="ngập",
            audio_bytes=b"webm-audio-5",
            filename="p.webm",
            content_type="audio/webm",
            session_id=SESSION_1,
            page_id=PAGE_1,
            page_revision_id=REV_1,
            word_id=WORD_2,
        )
        self.assertEqual(r5.assessment_status, "CORRECT")
        self.assertEqual(r5.word_progress.consecutive_correct_count, 1)
        self.assertEqual(r5.word_progress.practice_status, "COMPLETED")
        self.assertTrue(r5.resolved_in_session)

        # Historical first-pass assessment must remain 100% immutable!
        after_assessment = aggregate_assessment(SESSION_1, [report], [])["assessment"]
        self.assertEqual(before_assessment, after_assessment)

    async def test_engine_failure_uses_browser_fallback_or_safe_engine_error(self):
        repo = InMemoryPracticeRepo()
        voice = MagicMock()
        voice.transcribe = AsyncMock(side_effect=VoiceProviderError(503, "STT_QUOTA_EXCEEDED"))
        service = DifficultWordsService(repo, make_access(), voice_provider=voice)

        a1 = await service.start_attempt(
            CHILD_A, ACTOR, DifficultWordPracticeStartRequest(request_id=uuid4(), normalized_word="mèo", display_text="Mèo")
        )
        r1 = await service.evaluate_audio_attempt(
            CHILD_A, a1.attempt_id, ACTOR,
            completion_request_id=uuid4(), audio_bytes=b"audio", filename="p.webm", content_type="audio/webm",
            browser_transcript="mèo", browser_confidence=0.91,
        )
        self.assertEqual(r1.assessment_status, "CORRECT")
        self.assertEqual(r1.recognition_source, "BROWSER_SPEECH")
        voice.transcribe.assert_not_awaited()

        a2 = await service.start_attempt(
            CHILD_A, ACTOR, DifficultWordPracticeStartRequest(request_id=uuid4(), normalized_word="mèo", display_text="Mèo")
        )
        r2 = await service.evaluate_audio_attempt(
            CHILD_A, a2.attempt_id, ACTOR,
            completion_request_id=uuid4(), audio_bytes=b"audio", filename="p.webm", content_type="audio/webm",
        )
        self.assertEqual(r2.assessment_status, "ENGINE_ERROR")
        self.assertEqual(r2.recognition_source, "ENGINE_ERROR")
        self.assertEqual(r2.word_progress.consecutive_correct_count, 1)

    async def test_help_is_neutral_and_hints_cannot_manufacture_a_tonal_match(self):
        repo = InMemoryPracticeRepo()
        voice = MagicMock()
        service = DifficultWordsService(repo, make_access(), voice_provider=voice)
        for target, spoken, browser, expected in [
            ("đọc", "Con không biết đọc.", None, "UNCERTAIN"),
            ("một", "Cô ơi, con chưa biết đọc từ này ạ.", None, "UNCERTAIN"),
            ("một", "mốt", "một", "UNCERTAIN"),
            ("một", "một", "mốt", "UNCERTAIN"),
            ("một", "", None, "UNCERTAIN"),
            ("một", "mọt", None, "INCORRECT"),
            ("hôm", "hôn", None, "UNCERTAIN"),
            ("hôm", "hôn", "hôn", "INCORRECT"),
            ("hôm", "hôn", "hôm", "UNCERTAIN"),
            ("hôm", "hôm nay", None, "CORRECT"),
            ("có", "cỏ", None, "INCORRECT"),
            ("có", "Có.", None, "CORRECT"),
            ("một", "1.", None, "CORRECT"),
            ("một", "2.", None, "INCORRECT"),
            ("một", "mốt", None, "INCORRECT"),
            ("một", "01", None, "INCORRECT"),
            ("một", "MỘT".lower(), None, "CORRECT"),
            ("con không biết", "Con không biết!", None, "CORRECT"),
        ]:
            with self.subTest(target=target, spoken=spoken, browser=browser):
                voice.transcribe = AsyncMock(return_value=Transcription(
                    text=spoken, language_code="vi", language_probability=0.99, words=[]
                ))
                request = dict(
                    request_id=uuid4(), normalized_word=target, audio_bytes=b"audio",
                    filename="test.webm", content_type="audio/webm",
                    browser_transcript=browser, browser_confidence=0.80 if browser else None,
                )
                result = await service.evaluate_word_direct(CHILD_A, ACTOR, **request)
                self.assertEqual(result.assessment_status, expected)
                retry = await service.evaluate_word_direct(CHILD_A, ACTOR, **request)
                self.assertEqual(result.attempt_id, retry.attempt_id)
                voice.transcribe.assert_awaited_once()

    async def test_two_unprompted_exact_matches_confirm_even_with_weak_confidence(self):
        voice = MagicMock()
        voice.transcribe = AsyncMock(side_effect=[
            Transcription(text="Hôm.", language_code="vi", language_probability=0.95,
                          words=[{"text": "Hôm", "start": 0.1, "end": 0.4, "logprob": -1.8}]),
            VoiceProviderError("keyterms unavailable"),
        ])
        service = DifficultWordsService(InMemoryPracticeRepo(), make_access(), voice_provider=voice)
        result = await service.evaluate_word_direct(
            CHILD_A, ACTOR, request_id=uuid4(), normalized_word="hôm",
            audio_bytes=b"audio", filename="test.webm", content_type="audio/webm",
            audio_quality_status="SPEECH_DETECTED", browser_transcript="hôm",
            browser_confidence=0,
        )
        self.assertEqual(result.assessment_status, "CORRECT")
        self.assertEqual(result.word_progress.practice_status, "COMPLETED")
        voice.transcribe.assert_awaited_once()

    async def test_audio_validation_rejects_empty_oversized_and_bad_mime(self):
        repo = InMemoryPracticeRepo()
        service = DifficultWordsService(repo, make_access(), voice_provider=MagicMock())
        a1 = await service.start_attempt(
            CHILD_A, ACTOR, DifficultWordPracticeStartRequest(request_id=uuid4(), normalized_word="mèo", display_text="Mèo")
        )
        with self.assertRaises(HTTPException) as empty_exc:
            await service.evaluate_audio_attempt(
                CHILD_A, a1.attempt_id, ACTOR,
                completion_request_id=uuid4(), audio_bytes=b"", filename="p.webm", content_type="audio/webm",
            )
        self.assertEqual(empty_exc.exception.status_code, 422)

        with self.assertRaises(HTTPException) as large_exc:
            await service.evaluate_audio_attempt(
                CHILD_A, a1.attempt_id, ACTOR,
                completion_request_id=uuid4(), audio_bytes=b"x" * (5 * 1024 * 1024 + 1), filename="p.webm", content_type="audio/webm",
            )
        self.assertEqual(large_exc.exception.status_code, 413)

        with self.assertRaises(HTTPException) as mime_exc:
            await service.evaluate_audio_attempt(
                CHILD_A, a1.attempt_id, ACTOR,
                completion_request_id=uuid4(), audio_bytes=b"bad", filename="p.txt", content_type="text/plain",
            )
        self.assertEqual(mime_exc.exception.status_code, 415)

    async def test_unmigrated_storage_falls_back_to_reading_events_without_503(self):
        repo = InMemoryPracticeRepo(storage_ready=False)
        session, report, events = self._sample_evidence()
        repo.sessions_rows = [session]
        repo.reports_rows = [report]
        repo.event_rows = events

        voice = MagicMock()
        voice.transcribe = AsyncMock(
            return_value=Transcription(
                text="có",
                language_code="vie",
                language_probability=0.98,
                words=[{"text": "có", "start": 0.0, "end": 0.3, "logprob": -0.05}],
            )
        )

        service = DifficultWordsService(repo, make_access(), voice_provider=voice)
        words = await service.list_difficult_words(CHILD_A, ACTOR)
        self.assertEqual(len(words), 2)

        # Even without difficult_word_practice_attempts table, direct practice persists via WORD_RETRY!
        direct_req = uuid4()
        result = await service.evaluate_word_direct(
            CHILD_A,
            ACTOR,
            request_id=direct_req,
            normalized_word="có",
            display_text="có",
            audio_bytes=b"webm-co",
            filename="p.webm",
            content_type="audio/webm",
            audio_duration_ms=700,
            session_id=SESSION_1,
            page_id=PAGE_1,
            page_revision_id=REV_1,
            word_id=WORD_1,
        )
        self.assertEqual(result.assessment_status, "CORRECT")
        self.assertEqual(result.persistence_backend, "READING_EVENT")
        self.assertEqual(result.word_progress.practice_status, "COMPLETED")
        self.assertEqual(len(repo.retry_events), 1)
        self.assertEqual(repo.retry_events[0].Type, "WORD_RETRY")
        self.assertEqual(repo.retry_events[0].Status, "CONFIRMED")

        # Duplicate request_id returns exact idempotent attempt without duplicating events.
        dup_result = await service.evaluate_word_direct(
            CHILD_A,
            ACTOR,
            request_id=direct_req,
            normalized_word="có",
            display_text="có",
            audio_bytes=b"webm-co",
            filename="p.webm",
            content_type="audio/webm",
        )
        self.assertEqual(dup_result.attempt_id, result.attempt_id)
        self.assertEqual(len(repo.retry_events), 1)

        history = await service.practice_history(CHILD_A, ACTOR, normalized_word="có")
        self.assertTrue(history.storage_ready)
        self.assertEqual(len(history.items), 1)
        self.assertEqual(history.items[0].assessment_status, "CORRECT")

        # If neither table nor any ReadingSession provenance exists, fail explicitly with 503.
        empty_repo = InMemoryPracticeRepo(storage_ready=False)
        empty_service = DifficultWordsService(empty_repo, make_access(), voice_provider=voice)
        with self.assertRaises(HTTPException) as exc:
            await empty_service.evaluate_word_direct(
                CHILD_A,
                ACTOR,
                request_id=uuid4(),
                normalized_word="mèo",
                audio_bytes=b"webm-co",
            )
        self.assertEqual(exc.exception.status_code, 503)

    async def test_word_mot_sensitivity_context_phrase_and_false_positive_matrix(self):
        ctx = "Bé có một bông hoa."
        # Accepted inputs (single word, punctuation, ambient tag, echo, short/full context span)
        self.assertEqual(classify_practice_transcript("một", "một"), "CORRECT")
        self.assertEqual(classify_practice_transcript("một", "Một."), "CORRECT")
        self.assertEqual(classify_practice_transcript("một", "[tiếng đập] một"), "CORRECT")
        self.assertEqual(classify_practice_transcript("một", "một một"), "CORRECT")
        self.assertEqual(classify_practice_transcript("một", "một bông hoa"), "CORRECT")
        self.assertEqual(
            classify_practice_transcript("một", "bé có một bông hoa", context_phrase=ctx),
            "CORRECT",
        )

        # Rejected wrong tone/rime/consonant (zero false positives)
        for wrong in ("mốt", "mọt", "bột", "tốt", "hột"):
            with self.subTest(wrong=wrong):
                self.assertEqual(
                    classify_practice_transcript("một", wrong, context_phrase=ctx),
                    "INCORRECT",
                )

        # Unrelated long/counting speech must remain UNCERTAIN even with target word inside
        self.assertEqual(
            classify_practice_transcript("một", "một hai ba bốn năm", context_phrase=ctx),
            "UNCERTAIN",
        )
        self.assertEqual(classify_practice_transcript("một", "[tiếng đập]"), "NO_CLEAR_AUDIO")
        self.assertEqual(classify_practice_transcript("một", ""), "NO_CLEAR_AUDIO")
        self.assertEqual(
            classify_practice_transcript("một", "bé hãy đọc lại từ một nhé"),
            "UNCERTAIN",
        )

        # Soft voice (LOW_VOLUME) must pass through Pass 1 STT; SILENCE is rejected safely
        repo = InMemoryPracticeRepo(storage_ready=False)
        repo.sessions_rows = [
            SimpleNamespace(
                Id=SESSION_1,
                ChildId=CHILD_A,
                BookId=BOOK_1,
                StartedAt=NOW - timedelta(hours=1),
            )
        ]
        repo.reports_rows = [
            SimpleNamespace(
                Id=uuid4(),
                SessionId=SESSION_1,
                PageId=PAGE_1,
                PageRevisionId=REV_1,
                Transcript="bé có một bông hoa",
                Distance=0,
                Alignment=[],
                Summary={},
                CreatedAt=NOW - timedelta(minutes=2),
            )
        ]
        voice = MagicMock()
        voice.transcribe = AsyncMock(
            return_value=Transcription(
                text="bé có một bông hoa",
                language_code="vie",
                language_probability=0.98,
                words=[],
            )
        )
        service = DifficultWordsService(repo, make_access(), voice_provider=voice)

        res_soft = await service.evaluate_word_direct(
            CHILD_A,
            ACTOR,
            request_id=uuid4(),
            normalized_word="một",
            display_text="một",
            context_phrase=ctx,
            audio_bytes=b"webm-soft-mot",
            filename="mot.webm",
            content_type="audio/webm",
            audio_duration_ms=260,
            audio_quality_status="LOW_VOLUME",
            session_id=SESSION_1,
            page_id=PAGE_1,
            page_revision_id=REV_1,
            word_id=WORD_3,
        )
        self.assertEqual(res_soft.assessment_status, "CORRECT")
        self.assertEqual(res_soft.word_progress.practice_status, "COMPLETED")
        self.assertEqual(res_soft.word_progress.consecutive_correct_count, 1)

        res_silence = await service.evaluate_word_direct(
            CHILD_A,
            ACTOR,
            request_id=uuid4(),
            normalized_word="một",
            display_text="một",
            context_phrase=ctx,
            audio_bytes=b"webm-silence",
            filename="silence.webm",
            content_type="audio/webm",
            audio_duration_ms=900,
            audio_quality_status="SILENCE",
            session_id=SESSION_1,
            page_id=PAGE_1,
            page_revision_id=REV_1,
            word_id=WORD_3,
        )
        self.assertEqual(res_silence.assessment_status, "NO_CLEAR_AUDIO")
        self.assertEqual(res_silence.word_progress.practice_status, "COMPLETED")

    async def test_repository_sql_enforces_parent_ownership(self):
        db = MagicMock()
        empty_result = MagicMock()
        empty_result.scalars.return_value.all.return_value = []
        empty_result.all.return_value = []
        db.execute = AsyncMock(return_value=empty_result)
        db.scalar = AsyncMock(return_value=None)

        repo = DifficultWordsRepository(db)
        since = NOW - timedelta(days=90)
        await repo.reading_sessions(CHILD_A, ACTOR, since, NOW)
        await repo.comparison_reports(CHILD_A, ACTOR, since, NOW)
        await repo.reading_events_with_words(CHILD_A, ACTOR, since, NOW)
        await repo.list_practice_attempts(CHILD_A, ACTOR)
        await repo.get_practice_attempt(CHILD_A, uuid4(), ACTOR)

        executed_queries = [call.args[0] for call in db.execute.await_args_list] + [
            call.args[0] for call in db.scalar.await_args_list
        ]
        self.assertEqual(len(executed_queries), 5)
        for query in executed_queries:
            compiled = query.compile(dialect=postgresql.dialect())
            self.assertIn("childprofiles.parentid", str(compiled))
            self.assertIn(ACTOR, compiled.params.values())


class DifficultWordsHttpTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.db.scalar = AsyncMock(return_value="admin")
        self.db.execute = AsyncMock()
        self.app = FastAPI()
        self.app.include_router(system_router, prefix="/system")
        self.app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)

    def test_requires_parent_role_and_validates_payloads(self):
        self.assertEqual(
            self.client.get(f"/system/difficult-words/{CHILD_A}").status_code, 403
        )
        self.assertEqual(
            self.client.get(f"/system/difficult-words/{CHILD_A}/practice/history").status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                f"/system/difficult-words/{CHILD_A}/practice/start",
                json={"request_id": str(uuid4()), "normalized_word": "mèo"},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                f"/system/difficult-words/{CHILD_A}/practice/evaluate",
                data={"request_id": str(uuid4()), "normalized_word": "có"},
                files={"file": ("co.webm", b"audio", "audio/webm")},
            ).status_code,
            403,
        )

    def test_requires_auth_token(self):
        del self.app.dependency_overrides[get_current_parent_id]
        self.assertEqual(
            self.client.get(f"/system/difficult-words/{CHILD_A}").status_code, 401
        )
        self.assertEqual(
            self.client.post(
                f"/system/difficult-words/{CHILD_A}/practice/start",
                json={"request_id": str(uuid4()), "normalized_word": "mèo"},
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.post(
                f"/system/difficult-words/{CHILD_A}/practice/evaluate",
                data={"request_id": str(uuid4()), "normalized_word": "có"},
                files={"file": ("co.webm", b"audio", "audio/webm")},
            ).status_code,
            401,
        )


class ReadingComparisonSelfCorrectedTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_for_session_returns_self_corrected_word_ids_from_word_retry(self):
        from app.services.reading_comparison_service import ReadingComparisonService

        service = ReadingComparisonService(MagicMock())
        report = SimpleNamespace(
            Id=uuid4(),
            SessionId=SESSION_1,
            PageId=PAGE_1,
            PageRevisionId=REV_1,
            Transcript="xanh",
            Distance=1,
            Alignment=[],
            Summary={
                "assessment_version": 1,
                "initial_assessment": [
                    {"word_id": str(WORD_1), "word_index": 0, "text": "có", "status": "OMISSION"},
                    {"word_id": str(WORD_2), "word_index": 1, "text": "ngập", "status": "MISPRONUNCIATION"},
                    {"word_id": str(WORD_3), "word_index": 2, "text": "xanh", "status": "CORRECT"},
                ],
            },
            CreatedAt=NOW - timedelta(minutes=5),
        )
        events = [
            SimpleNamespace(
                Id=uuid4(),
                SessionId=SESSION_1,
                PageId=PAGE_1,
                PageRevisionId=REV_1,
                WordId=WORD_1,
                Type="WORD_RETRY",
                Status="CONFIRMED",
                Metadata={"retry_attempt": 1},
            ),
            SimpleNamespace(
                Id=uuid4(),
                SessionId=SESSION_1,
                PageId=PAGE_1,
                PageRevisionId=REV_1,
                WordId=WORD_2,
                Type="WORD_RETRY",
                Status="FAILED",
                Metadata={"retry_attempt": 1},
            ),
        ]
        service.content.get_session_summary = AsyncMock(return_value=SimpleNamespace(id=SESSION_1))
        service.repository.list_for_session = AsyncMock(return_value=[report])
        service.content.repository.events_for_session = AsyncMock(return_value=events)

        res = await service.list_for_session(SESSION_1, ACTOR)
        self.assertEqual(res.total, 1)
        self.assertEqual(res.reports[0].self_corrected_word_ids, [WORD_1])
        self.assertIsNotNone(res.assessment)
        self.assertEqual(res.assessment.self_corrected_words, 1)

    async def test_word_mot_post_reading_retry_preserves_first_pass_error_and_syncs_green(
        self,
    ):
        from app.services.reading_comparison_service import ReadingComparisonService

        sentence_words = [
            SimpleNamespace(Id=uuid4(), WordIndex=0, Text="Bé", LineIndex=0),
            SimpleNamespace(Id=WORD_1, WordIndex=1, Text="có", LineIndex=0),
            SimpleNamespace(Id=WORD_2, WordIndex=2, Text="một", LineIndex=0),
            SimpleNamespace(Id=WORD_3, WordIndex=3, Text="bông", LineIndex=0),
            SimpleNamespace(Id=uuid4(), WordIndex=4, Text="hoa.", LineIndex=0),
        ]
        initial_assessment = [
            {"word_id": str(w.Id), "word_index": w.WordIndex, "text": w.Text, "status": "MISPRONUNCIATION" if w.Id == WORD_2 else "CORRECT"}
            for w in sentence_words
        ]
        report = SimpleNamespace(
            Id=uuid4(),
            SessionId=SESSION_1,
            PageId=PAGE_1,
            PageRevisionId=REV_1,
            Transcript="Bé có mốt bông hoa.",
            Distance=1,
            Alignment=[
                {"book_word": "Bé", "spoken_word": "Bé", "book_index": 0, "spoken_index": 0, "status": "MATCH"},
                {"book_word": "có", "spoken_word": "có", "book_index": 1, "spoken_index": 1, "status": "MATCH"},
                {"book_word": "một", "spoken_word": "mốt", "book_index": 2, "spoken_index": 2, "status": "SUBSTITUTE"},
                {"book_word": "bông", "spoken_word": "bông", "book_index": 3, "spoken_index": 3, "status": "MATCH"},
                {"book_word": "hoa", "spoken_word": "hoa", "book_index": 4, "spoken_index": 4, "status": "MATCH"},
            ],
            Summary={
                "assessment_version": 1,
                "initial_assessment": initial_assessment,
                "substitutions": [{"book_word": "một", "spoken_word": "mốt", "book_index": 2}],
                "missing_words": [],
                "extra_words": [],
                "repeated_words": [],
                "hesitations": [],
            },
            CreatedAt=NOW - timedelta(minutes=3),
        )
        retry_confirmed_event = SimpleNamespace(
            Id=uuid4(),
            SessionId=SESSION_1,
            PageId=PAGE_1,
            PageRevisionId=REV_1,
            WordId=WORD_2,
            Type="WORD_RETRY",
            Status="CONFIRMED",
            Confidence=0.98,
            EndMs=420,
            Metadata={
                "retry_attempt": 1,
                "resolution_status": "SELF_CORRECTED",
                "target_word": "một",
                "recognized_text": "một",
            },
            CreatedAt=NOW - timedelta(minutes=1),
        )

        # 1) Comparison report highlights 'một' green via self_corrected_word_ids,
        # while first-pass accuracy & mispronounced count remain immutable (4/5 = 80%, 1 error).
        comp_service = ReadingComparisonService(MagicMock())
        comp_service.content.get_session_summary = AsyncMock(return_value=SimpleNamespace(id=SESSION_1))
        comp_service.repository.list_for_session = AsyncMock(return_value=[report])
        comp_service.content.repository.events_for_session = AsyncMock(
            return_value=[retry_confirmed_event]
        )

        comp_res = await comp_service.list_for_session(SESSION_1, ACTOR)
        self.assertEqual(comp_res.reports[0].self_corrected_word_ids, [WORD_2])
        self.assertIsNotNone(comp_res.assessment)
        self.assertEqual(comp_res.assessment.first_pass_correct, 4)
        self.assertEqual(comp_res.assessment.first_pass_incorrect, 1)
        self.assertEqual(comp_res.assessment.self_corrected_words, 1)
        self.assertEqual(comp_res.assessment.unresolved_words, 0)
        self.assertEqual(comp_res.assessment.retry_attempts, 1)
        first_pass_pct = (
            comp_res.assessment.first_pass_correct
            / (
                comp_res.assessment.first_pass_correct
                + comp_res.assessment.first_pass_incorrect
            )
            * 100
        )
        self.assertAlmostEqual(first_pass_pct, 80.0, places=1)

        # 2) DifficultWordsService retains mispronunciation_count == 1 AND syncs COMPLETED green status.
        repo = InMemoryPracticeRepo(storage_ready=False)
        repo.sessions_rows = [
            SimpleNamespace(
                Id=SESSION_1,
                ChildId=CHILD_A,
                BookId=BOOK_1,
                StartedAt=NOW - timedelta(minutes=10),
            )
        ]
        repo.books_map[BOOK_1] = SimpleNamespace(
            Id=BOOK_1,
            Title="Chào ngày mới",
            Author="Minh Anh",
            MinGrade=1,
            MaxGrade=1,
        )
        repo.pages_map[PAGE_1] = SimpleNamespace(Id=PAGE_1, PageNumber=1)
        repo.rev_words_map[REV_1] = sentence_words
        repo.reports_rows = [report]
        repo.retry_events = [retry_confirmed_event]

        dw_service = DifficultWordsService(repo, make_access())
        difficult_words = await dw_service.list_difficult_words(
            CHILD_A,
            ACTOR,
            period_start=date(2026, 11, 1),
            period_end=date(2026, 11, 18),
        )
        mot_entry = next((item for item in difficult_words if item.normalized_word == "một"), None)
        self.assertIsNotNone(mot_entry)
        self.assertEqual(mot_entry.mispronunciation_count, 1)
        self.assertEqual(mot_entry.practice_status, "COMPLETED")
        self.assertEqual(mot_entry.consecutive_correct_count, 1)
        self.assertEqual(mot_entry.sources[0].context_phrase, "Bé có một bông hoa.")

    def test_display_text_strips_edge_punctuation_preserving_vietnamese_tones_and_d(self):
        from app.services.difficult_words_service import (
            _WordAccumulator,
            clean_difficult_word_display_text,
        )

        self.assertEqual(clean_difficult_word_display_text('“mưa.”'), "mưa")
        self.assertEqual(clean_difficult_word_display_text("Đường!"), "Đường")
        self.assertEqual(clean_difficult_word_display_text("?đồng,"), "đồng")
        self.assertEqual(clean_difficult_word_display_text("  'trời;'  "), "trời")

        acc = _WordAccumulator(normalized_word="đường")
        acc.observe(display_text="“Đường!”", seen_at=NOW)
        self.assertEqual(acc.display_counter.most_common(1)[0][0], "Đường")

    async def test_start_practice_attempt_and_history_sanitize_display_text(self):
        repo = InMemoryPracticeRepo()
        service = DifficultWordsService(repo, make_access())
        attempt = await service.start_attempt(
            CHILD_A,
            ACTOR,
            DifficultWordPracticeStartRequest(
                normalized_word="đường",
                display_text="“Đường,”",
                request_id=uuid4(),
            ),
        )
        self.assertEqual(attempt.display_text, "Đường")

        repo.attempts.append(
            DifficultWordPracticeAttempt(
                Id=uuid4(),
                ChildId=CHILD_A,
                ParentId=ACTOR,
                NormalizedWord="mèo",
                DisplayText="“Mèo.”",
                AttemptNumber=1,
                State="COMPLETED",
                AssessmentStatus="CORRECT",
                RecognitionSource="BROWSER_SPEECH",
                AssessmentVersion=1,
                StartedAt=NOW,
                CompletedAt=NOW,
            )
        )
        history = await service.practice_history(CHILD_A, ACTOR)
        display_by_norm = {item.normalized_word: item.display_text for item in history.items}
        self.assertEqual(display_by_norm["đường"], "Đường")
        self.assertEqual(display_by_norm["mèo"], "Mèo")


if __name__ == "__main__":
    unittest.main()
