"""Unit tests for shared ChildDifficultWordFeed single-source-of-truth service."""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy.exc import ProgrammingError

from app.services.child_difficult_word_feed import (
    ChildDifficultWordFeed,
    DifficultWordTarget,
)


class _Result:
    def __init__(self, rows: list):
        self._rows = rows

    def all(self):
        return list(self._rows)


class _NestedTx:
    def __init__(self, db: "_FakeFeedDB"):
        self._db = db

    async def __aenter__(self):
        self._db.nested_entries += 1
        return self

    async def __aexit__(self, exc_type, _exc, _tb):
        if exc_type is not None:
            self._db.nested_rollbacks += 1
        return False


class _FakeFeedDB:
    """Routes the 4 feed queries by SQL table marker without needing live PG."""

    def __init__(
        self,
        *,
        reports: list | None = None,
        events: list | None = None,
        attempts: list | None = None,
        evidence: list | None = None,
        raise_on: set[str] | None = None,
    ) -> None:
        self.reports = reports or []
        self.events = events or []
        self.attempts = attempts or []
        self.evidence = evidence or []
        self.raise_on = raise_on or set()
        self.nested_entries = 0
        self.nested_rollbacks = 0
        self.outer_rollbacks = 0
        self.queries_seen: list[str] = []

    def begin_nested(self):
        return _NestedTx(self)

    async def rollback(self):
        self.outer_rollbacks += 1

    async def execute(self, statement):
        sql = str(statement).lower()
        self.queries_seen.append(sql)
        if "from readingcomparisonreports" in sql:
            if "readingcomparisonreports" in self.raise_on:
                raise ProgrammingError("stmt", {}, Exception('relation "readingcomparisonreports" does not exist'))
            return _Result(self.reports)
        if "from readingevents" in sql:
            if "readingevents" in self.raise_on:
                raise ProgrammingError("stmt", {}, Exception('relation "readingevents" does not exist'))
            return _Result(self.events)
        if "from difficult_word_practice_attempts" in sql:
            if "difficult_word_practice_attempts" in self.raise_on:
                raise ProgrammingError("stmt", {}, Exception('relation "difficult_word_practice_attempts" does not exist'))
            return _Result(self.attempts)
        if "from learning_skill_evidence" in sql:
            if "learning_skill_evidence" in self.raise_on:
                raise ProgrammingError("stmt", {}, Exception('relation "learning_skill_evidence" does not exist'))
            return _Result(self.evidence)
        return _Result([])


class ChildDifficultWordFeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_populates_from_comparison_report_and_word_retry_when_practice_attempts_empty(self):
        now = datetime(2026, 11, 27, 10, 0, tzinfo=timezone.utc)
        child_id = uuid4()
        parent_id = uuid4()
        book_1 = uuid4()
        page_1 = uuid4()
        rev_1 = uuid4()
        sess_1 = uuid4()
        book_2 = uuid4()
        page_2 = uuid4()

        reports = [
            (
                sess_1,
                now - timedelta(hours=3),
                [
                    {"status": "MATCH", "book_index": 0, "book_word": "Bé", "spoken_word": "Bé"},
                    {"status": "SUBSTITUTE", "book_index": 1, "book_word": "nghiêng", "spoken_word": "nghiên"},
                    {"status": "DELETE", "book_index": 2, "book_word": "chuyền", "spoken_word": None},
                    {"status": "MATCH", "book_index": 3, "book_word": "cành", "spoken_word": "cành"},
                ],
                {},
                page_1,
                rev_1,
                "Bé nghiên cành",
                book_1,
            )
        ]
        events = [
            (
                "WORD_RETRY",
                "FAILED",
                {"target_word": "khủng long", "recognized_text": "khung long"},
                now - timedelta(hours=2),
                page_2,
                book_2,
                None,
            ),
            (
                "WORD_RETRY",
                "UNCERTAIN",
                {"target_word": "truyện"},
                now - timedelta(hours=1),
                page_2,
                book_2,
                "truyện",
            ),
            # CONFIRMED retry should not be returned as an error event
            (
                "WORD_RETRY",
                "CONFIRMED",
                {"target_word": "mèo"},
                now - timedelta(minutes=30),
                page_2,
                book_2,
                "mèo",
            ),
            # Legacy event joined to PageRevisionWord.Text
            (
                "MISPRONUNCIATION",
                "DETECTED",
                {},
                now - timedelta(days=1),
                page_1,
                book_1,
                "rực rỡ",
            ),
        ]

        db = _FakeFeedDB(reports=reports, events=events, attempts=[], evidence=[])
        targets = await ChildDifficultWordFeed(db).list_targets(child_id, parent_id, limit=10, now=now)

        by_norm = {t.normalized_word: t for t in targets}
        self.assertIn("nghiêng", by_norm)
        self.assertIn("chuyền", by_norm)
        self.assertIn("khủng long", by_norm)
        self.assertIn("truyện", by_norm)
        self.assertIn("rực rỡ", by_norm)

        self.assertEqual(by_norm["nghiêng"].heard_as, "nghiên")
        self.assertEqual(by_norm["nghiêng"].source_book_ids, [book_1])
        self.assertEqual(by_norm["nghiêng"].source_page_ids, [page_1])
        self.assertEqual(by_norm["khủng long"].heard_as, "khung long")
        self.assertEqual(by_norm["khủng long"].source_book_ids, [book_2])
        self.assertGreater(by_norm["khủng long"].priority_score, 0)

        words = await ChildDifficultWordFeed(db).list_words(child_id, parent_id, limit=10, now=now)
        self.assertEqual(words, [t.word for t in targets])

    async def test_excludes_mastered_words_with_two_recent_correct_attempts_and_rotates_today_reinforced(self):
        now = datetime(2026, 11, 27, 10, 0, tzinfo=timezone.utc)
        child_id = uuid4()
        parent_id = uuid4()
        book_1 = uuid4()
        page_1 = uuid4()
        rev_1 = uuid4()
        sess_1 = uuid4()

        reports = [
            (
                sess_1,
                now - timedelta(days=2),
                [
                    {"status": "SUBSTITUTE", "book_index": 0, "book_word": "nghiêng", "spoken_word": "nghiên"},
                    {"status": "SUBSTITUTE", "book_index": 1, "book_word": "bướm", "spoken_word": "bươm"},
                    {"status": "DELETE", "book_index": 2, "book_word": "đồng", "spoken_word": None},
                    {"status": "MATCH", "book_index": 3, "book_word": "xanh", "spoken_word": "xanh"},
                ],
                {},
                page_1,
                rev_1,
                "xanh",
                book_1,
            )
        ]
        attempts = [
            # "bướm" has 2 most recent valid attempts == CORRECT -> mastered (excluded!)
            ("bướm", "bướm", "CORRECT", "COMPLETED", 3, book_1, page_1, now - timedelta(hours=1), now - timedelta(hours=1), now - timedelta(hours=1)),
            ("bướm", "bướm", "CORRECT", "COMPLETED", 2, book_1, page_1, now - timedelta(hours=3), now - timedelta(hours=3), now - timedelta(hours=3)),
            ("bướm", "bướm", "INCORRECT", "COMPLETED", 1, book_1, page_1, now - timedelta(days=1), now - timedelta(days=1), now - timedelta(days=1)),
            # "khủng long" only exists in practice attempts as INCORRECT -> prioritized!
            ("khủng long", "khủng long", "INCORRECT", "COMPLETED", 1, book_1, page_1, now - timedelta(hours=2), now - timedelta(hours=2), now - timedelta(hours=2)),
        ]
        # "nghiêng" was already strongly reinforced today (>= 0.75) -> down-ranked relative to "đồng"
        evidence = [
            (["nghiêng"], 0.90, now - timedelta(minutes=20)),
        ]

        db = _FakeFeedDB(reports=reports, attempts=attempts, evidence=evidence)
        targets = await ChildDifficultWordFeed(db).list_targets(child_id, parent_id, limit=10, now=now)
        norms = [t.normalized_word for t in targets]

        self.assertNotIn("bướm", norms)
        self.assertIn("khủng long", norms)
        self.assertIn("nghiêng", norms)
        self.assertIn("đồng", norms)
        # Spaced rotation: "đồng" (not reinforced today) ranks above "nghiêng" (already reinforced today)
        self.assertLess(norms.index("đồng"), norms.index("nghiêng"))
        nghieng = next(t for t in targets if t.normalized_word == "nghiêng")
        self.assertEqual(nghieng.reinforced_count, 1)

    async def test_missing_optional_tables_degrade_safely_in_nested_transactions(self):
        now = datetime(2026, 11, 27, 10, 0, tzinfo=timezone.utc)
        child_id = uuid4()
        parent_id = uuid4()
        events = [
            (
                "WORD_RETRY",
                "FAILED",
                {"target_word": "hướng dương"},
                now - timedelta(hours=1),
                uuid4(),
                uuid4(),
                None,
            )
        ]
        db = _FakeFeedDB(
            events=events,
            raise_on={"difficult_word_practice_attempts", "learning_skill_evidence"},
        )
        targets = await ChildDifficultWordFeed(db).list_targets(child_id, parent_id, now=now)
        self.assertEqual(len(targets), 1)
        self.assertIsInstance(targets[0], DifficultWordTarget)
        self.assertEqual(targets[0].word, "hướng dương")
        self.assertEqual(db.nested_entries, 4)
        self.assertEqual(db.nested_rollbacks, 2)
        self.assertEqual(db.outer_rollbacks, 0)
        # Verify ReadingEvent query uses valid `readingevents.type` column
        self.assertTrue(any("readingevents.type" in q for q in db.queries_seen))


if __name__ == "__main__":
    unittest.main()
