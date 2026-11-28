"""Unit & service tests for Wave 1 Pedagogy & Family Companion features (#1, #2, #4)."""

from __future__ import annotations

import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/viread_test",
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.test-signature",
)

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from uuid import uuid4

from fastapi import HTTPException

from app.schemas.family_pedagogy import ParentPinUpsertRequest
from app.services.child_progress.metrics import (
    AnswerRow,
    ReportRow,
    RetryEventRow,
    SessionRow,
    VIETNAM_TZ,
    compute_window,
)
from app.services.child_progress.phonology_profiler import (
    PracticeAttemptEvidenceRow,
    classify_syllable_confusion,
    compute_phonological_patterns,
)
from app.services.family_pedagogy_service import (
    FamilyPedagogyService,
    clear_fallback_memory_pins,
    hash_parent_pin,
    sniff_verified_audio_mime,
    verify_parent_pin_constant_time,
)


class PhonologyProfilerTests(unittest.TestCase):
    def test_classifies_tone_onset_and_coda_minimal_pairs_only(self) -> None:
        # 1. Exact tone confusion (hoi <-> nga)
        tone_hit = classify_syllable_confusion("mả", "mã", recurrence_bucket="s1")
        self.assertIsNotNone(tone_hit)
        assert tone_hit is not None
        self.assertEqual(tone_hit.pattern_key, "TONE:hoi<->nga")
        self.assertEqual(tone_hit.category, "TONE")

        # 2. Minimal onset confusion (l <-> n)
        onset_hit = classify_syllable_confusion("lúa", "núa", recurrence_bucket="s1")
        self.assertIsNotNone(onset_hit)
        assert onset_hit is not None
        self.assertEqual(onset_hit.pattern_key, "ONSET:l<->n")

        # 3. Minimal coda confusion (-n <-> -ng)
        coda_hit = classify_syllable_confusion("bàn", "bàng", recurrence_bucket="s1")
        self.assertIsNotNone(coda_hit)
        assert coda_hit is not None
        self.assertEqual(coda_hit.pattern_key, "CODA:n<->ng")

        # 4. Rejects unrelated boundary-shift words
        self.assertIsNone(
            classify_syllable_confusion("bầu", "trời", recurrence_bucket="s1")
        )

        # 5. Rejects pure Vietnamese orthographic c/k equivalence on identical phoneme
        self.assertIsNone(
            classify_syllable_confusion("cá", "cá", recurrence_bucket="s1")
        )

    def test_requires_three_distinct_sessions_before_surfacing_pattern(self) -> None:
        now = datetime(2026, 11, 28, 9, 0, tzinfo=VIETNAM_TZ)
        s1, s2, s3 = uuid4(), uuid4(), uuid4()
        b1 = uuid4()

        sessions = [
            SessionRow(s1, b1, "COMPLETED", now - timedelta(days=3), now - timedelta(days=3, minutes=-5)),
            SessionRow(s2, b1, "COMPLETED", now - timedelta(days=2), now - timedelta(days=2, minutes=-5)),
            SessionRow(s3, b1, "COMPLETED", now - timedelta(days=1), now - timedelta(days=1, minutes=-5)),
        ]
        reports = [
            ReportRow(
                session_id=s1,
                created_at=now - timedelta(days=3),
                alignment=[
                    {"book_word": "mả", "spoken_word": "mã", "book_index": 0, "status": "SUBSTITUTE"},
                    {"book_word": "cỏ", "spoken_word": "cỏ", "book_index": 1, "status": "MATCH"},
                ],
                summary={"assessment_version": 1, "initial_assessment": []},
            ),
            ReportRow(
                session_id=s2,
                created_at=now - timedelta(days=2),
                alignment=[
                    {"book_word": "vẻ", "spoken_word": "vẽ", "book_index": 0, "status": "SUBSTITUTE"},
                ],
                summary={},
            ),
        ]
        # Only 2 sessions so far -> below min_distinct_sessions=3!
        two_sess_window = compute_window(
            start=date(2026, 11, 1),
            end=date(2026, 11, 28),
            sessions=sessions,
            reports=reports,
            retries=[],
            answers=[],
            practice_attempts=[],
        )
        self.assertEqual(two_sess_window.phonological_patterns, [])

        # 3rd distinct session arrives via DifficultWordPracticeAttempt -> surfaces TONE:hoi<->nga!
        practice = [
            PracticeAttemptEvidenceRow(
                attempt_id=uuid4(),
                session_id=s3,
                normalized_word="cổ",
                display_text="cổ",
                assessment_status="INCORRECT",
                spoken_transcript="cỗ",
                created_at=now - timedelta(days=1),
            )
        ]
        three_sess_window = compute_window(
            start=date(2026, 11, 1),
            end=date(2026, 11, 28),
            sessions=sessions,
            reports=reports,
            retries=[
                RetryEventRow(
                    session_id=s2,
                    status="FAILED",
                    created_at=now - timedelta(days=2),
                    metadata={"target_word": "lúa", "recognized_text": "núa"},
                )
            ],
            answers=[],
            practice_attempts=practice,
        )
        self.assertEqual(len(three_sess_window.phonological_patterns), 1)
        pat = three_sess_window.phonological_patterns[0]
        self.assertEqual(pat["pattern_key"], "TONE:hoi<->nga")
        self.assertEqual(pat["distinct_sessions"], 3)
        self.assertGreaterEqual(len(pat["minimal_pairs"]), 2)


class FamilyPedagogySecurityAndPassportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_fallback_memory_pins()

    def tearDown(self) -> None:
        clear_fallback_memory_pins()

    def test_pin_pbkdf2_and_audio_magic_byte_validation(self) -> None:
        salt = "00112233445566778899aabbccddeeff"
        digest = hash_parent_pin("2580", salt)
        self.assertTrue(verify_parent_pin_constant_time("2580", salt, digest))
        self.assertFalse(verify_parent_pin_constant_time("2581", salt, digest))

        # Valid WebM EBML header passes
        mime, ext = sniff_verified_audio_mime(
            b"\x1a\x45\xdf\xa3\x01\x02\x03\x04", "audio/webm;codecs=opus"
        )
        self.assertEqual((mime, ext), ("audio/webm", "webm"))

        # Disguised HTML/script payload is rejected with 415
        with self.assertRaises(HTTPException) as ctx:
            sniff_verified_audio_mime(b"<script>alert(1)</script>", "audio/webm")
        self.assertEqual(ctx.exception.status_code, 415)

        # Oversized >256 KB payload is rejected with 413
        with self.assertRaises(HTTPException) as ctx2:
            sniff_verified_audio_mime(b"OggS" + b"\x00" * 262_200, "audio/ogg")
        self.assertEqual(ctx2.exception.status_code, 413)

    async def test_pin_lockout_and_reading_passport_stamps(self) -> None:
        parent_id = uuid4()
        child_id = uuid4()
        now = datetime(2026, 11, 28, 10, 0, tzinfo=timezone.utc)

        class _FakeFamilyRepo:
            async def is_pin_storage_ready(self) -> bool:
                return False

            async def release(self) -> None:
                return None

            async def owned_child(self, cid, pid):
                if cid == child_id and pid == parent_id:
                    return SimpleNamespace(Id=child_id, ParentId=parent_id, Alias="Bé Minh")
                return None

            async def load_passport_facts(self, cid):
                b1, b2, b3 = uuid4(), uuid4(), uuid4()
                return {
                    "sessions": [
                        (uuid4(), b1, "COMPLETED", now - timedelta(days=2), now - timedelta(days=2, minutes=-8)),
                        (uuid4(), b2, "COMPLETED", now - timedelta(days=1), now - timedelta(days=1, minutes=-10)),
                        (uuid4(), b3, "COMPLETED", now, now + timedelta(minutes=7)),
                    ],
                    "goals": [],
                    "mastered_words": 5,
                    "comprehension_correct": 2,
                    "has_parent_encouragement": True,
                }

        svc = FamilyPedagogyService(_FakeFamilyRepo(), now_fn=lambda: now)  # type: ignore[arg-type]

        status_saved = await svc.upsert_pin(
            parent_id,
            ParentPinUpsertRequest(pin="1357", child_mode_default=True),
        )
        self.assertTrue(status_saved.has_pin)
        self.assertTrue(status_saved.child_mode_default)

        ok_res = await svc.verify_pin(parent_id, "1357")
        self.assertTrue(ok_res.verified)

        for attempt_idx in range(5):
            bad_res = await svc.verify_pin(parent_id, "0000")
            self.assertFalse(bad_res.verified)
            if attempt_idx == 4:
                self.assertEqual(bad_res.remaining_attempts, 0)
                self.assertIsNotNone(bad_res.locked_until)

        with self.assertRaises(HTTPException) as lock_exc:
            await svc.verify_pin(parent_id, "1357")
        self.assertEqual(lock_exc.exception.status_code, 429)

        passport = await svc.get_reading_passport(child_id, parent_id)
        self.assertEqual(passport.streak_days, 3)
        self.assertEqual(passport.books_explored, 3)
        self.assertTrue(passport.has_parent_encouragement)
        unlocked_keys = {s.stamp_key for s in passport.stamps if s.unlocked}
        self.assertIn("first_story_step", unlocked_keys)
        self.assertIn("warm_streak_3", unlocked_keys)
        self.assertIn("book_explorer_3", unlocked_keys)
        self.assertIn("word_courage_5", unlocked_keys)


if __name__ == "__main__":
    unittest.main()
