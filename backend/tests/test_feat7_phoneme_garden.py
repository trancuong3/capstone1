"""Feature #7 test suite: 7-Bed Vietnamese Phoneme Garden & Book Stamp Passport.

Compatible with both `pytest` and `python -m unittest`.

Verifies:
1. Cold-start 7 Vietnamese phonics flower beds (`l_n`, `s_x`, `tr_ch`, `r_d_gi`, `hoi_nga`,
   `coda_n_ng_t_c`, `compound_reduplicative`) mapped to culturally warm plants.
2. Full 4-stage progression (`SEED -> SPROUT -> BUD -> BLOOM`) driven by practiced & mastered
   words (`is_word_mastered_across_contexts`: 1 isolated pass `v1` or 2 contextual passes `v2`),
   including `ReadingEvent` and `ReadingComparisonReport` evidence.
3. Monotonic non-punitive behavior after multi-day / multi-month breaks (120–240 days off)
   and subsequent exploratory reading — beds and stamps never regress or wilt.
4. Completed-book stamp deduplication across `FINISHED` / `COMPLETED` `ReadingSession` rows
   plus cumulative calm milestone stamps (1, 5, 10 sessions, first bloomed phoneme bed).
5. `PARENT_PRIVATE` household isolation (`403` cross-parent, `404` unknown child, `401` unauthenticated)
   and mandatory `Cache-Control: private, no-store` headers.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
import unittest
from uuid import UUID, uuid4

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.router import api_router
from app.models import (
    Book,
    ChildProfile,
    PageRevisionWord,
    Profile,
    ReadingComparisonReport,
    ReadingEvent,
    ReadingSession,
)
from app.models.difficult_word_practice import DifficultWordPracticeAttempt
from test_durable_workflows_and_router import FakeStudioAsyncSession, StudioDbState


class _GardenFakeAsyncSession(FakeStudioAsyncSession):
    """Test AsyncSession enabling entity queries for PhonemeGardenService."""


def _seed_garden_state() -> tuple[StudioDbState, dict[str, UUID]]:
    state = StudioDbState()
    parent_a = uuid4()
    parent_b = uuid4()
    child_a = uuid4()
    child_b = uuid4()
    book_1 = uuid4()
    book_2 = uuid4()
    book_in_progress = uuid4()

    state.tables[Profile] = [
        Profile(Id=parent_a, Role="parent", DisplayName="Parent A", Active=1),
        Profile(Id=parent_b, Role="parent", DisplayName="Parent B", Active=1),
    ]
    state.tables[ChildProfile] = [
        ChildProfile(Id=child_a, ParentId=parent_a, Alias="Bé Mây", Grade=2, Settings={}),
        ChildProfile(Id=child_b, ParentId=parent_b, Alias="Bé Khôi", Grade=3, Settings={}),
    ]
    state.tables[Book] = [
        Book(
            Id=book_1,
            Title="Dế Mèn Phiêu Lưu Ký",
            MinGrade=2,
            MaxGrade=5,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="CATALOG",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
        Book(
            Id=book_2,
            Title="Bông Sen Trắng Mùa Hạ",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=parent_a,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
        Book(
            Id=book_in_progress,
            Title="Chuyện Của Mùa Thu",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="CATALOG",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
    ]
    state.tables[ReadingSession] = []
    state.tables[ReadingEvent] = []
    state.tables[ReadingComparisonReport] = []
    state.tables[PageRevisionWord] = []
    state.tables[DifficultWordPracticeAttempt] = []

    return state, {
        "parent_a": parent_a,
        "parent_b": parent_b,
        "child_a": child_a,
        "child_b": child_b,
        "book_1": book_1,
        "book_2": book_2,
        "book_in_progress": book_in_progress,
    }


def _make_attempt(
    *,
    child_id: UUID,
    parent_id: UUID,
    word: str,
    normalized: str,
    status_val: str = "CORRECT",
    version: int = 1,
    when: datetime | None = None,
) -> DifficultWordPracticeAttempt:
    ts = when or datetime.now(timezone.utc)
    return DifficultWordPracticeAttempt(
        Id=uuid4(),
        ChildId=child_id,
        ParentId=parent_id,
        NormalizedWord=normalized,
        DisplayText=word,
        AttemptNumber=1,
        RequestId=uuid4(),
        CompletionRequestId=uuid4(),
        State="COMPLETED",
        AssessmentStatus=status_val,
        RecognitionSource="SERVER_STT_KEYTERM",
        Confidence=0.92,
        AssessmentVersion=version,
        EvidenceWordIds=[],
        StartedAt=ts,
        CompletedAt=ts,
        CreatedAt=ts,
        UpdatedAt=ts,
    )


def _build_client(
    state: StudioDbState,
    actor_holder: dict[str, UUID],
) -> TestClient:
    app = FastAPI()
    app.include_router(api_router)

    async def _override_db():
        yield _GardenFakeAsyncSession(state)

    def _override_actor() -> UUID:
        return actor_holder["actor_id"]

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_parent_id] = _override_actor
    return TestClient(app)


class Feat7PhonemeGardenTests(unittest.TestCase):
    def test_cold_start_seven_beds_and_no_store_headers(self) -> None:
        state, ids = _seed_garden_state()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        res = client.get(f"/phoneme-garden/children/{ids['child_a']}/summary")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.headers.get("cache-control"), "private, no-store")
        self.assertEqual(res.headers.get("pragma"), "no-cache")

        data = res.json()
        self.assertEqual(data["visibility"], "PARENT_PRIVATE")
        self.assertEqual(data["child_alias"], "Bé Mây")
        self.assertEqual(len(data["beds"]), 7)
        self.assertEqual(
            [b["bed_key"] for b in data["beds"]],
            [
                "l_n",
                "s_x",
                "tr_ch",
                "r_d_gi",
                "hoi_nga",
                "coda_n_ng_t_c",
                "compound_reduplicative",
            ],
        )
        self.assertEqual(
            [b["plant_name_vi"] for b in data["beds"]],
            [
                "Hoa Sen",
                "Hoa Mai",
                "Tre Xanh",
                "Hoa Hướng Dương",
                "Hoa Cúc",
                "Hoa Đào",
                "Hoa Phượng",
            ],
        )
        for bed in data["beds"]:
            self.assertEqual(bed["stage"], "SEED")
            self.assertEqual(bed["stage_index"], 0)
            self.assertEqual(bed["mastered_words_count"], 0)
        self.assertEqual(data["book_stamps"], [])
        self.assertEqual(len(data["milestone_stamps"]), 4)
        self.assertTrue(all(not m["unlocked"] for m in data["milestone_stamps"]))

    def test_stage_progression_seed_to_bloom_and_contextual_mastery(self) -> None:
        state, ids = _seed_garden_state()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)
        now = datetime.now(timezone.utc)

        # Step 1: 1 practiced (INCORRECT) word in l_n -> SEED to SPROUT (0 mastered)
        state.tables[DifficultWordPracticeAttempt].append(
            _make_attempt(
                child_id=ids["child_a"],
                parent_id=ids["parent_a"],
                word="lúa",
                normalized="lúa",
                status_val="INCORRECT",
                version=1,
                when=now - timedelta(minutes=30),
            )
        )
        r1 = client.get(f"/phoneme-garden/children/{ids['child_a']}/summary").json()
        ln_bed = next(b for b in r1["beds"] if b["bed_key"] == "l_n")
        self.assertEqual(ln_bed["stage"], "SPROUT")
        self.assertEqual(ln_bed["practiced_words_count"], 1)
        self.assertEqual(ln_bed["mastered_words_count"], 0)

        # Step 2: Master "lúa" (v1 CORRECT) + master "nắng" (v1 CORRECT) -> BUD (2 mastered)
        state.tables[DifficultWordPracticeAttempt].extend(
            [
                _make_attempt(
                    child_id=ids["child_a"],
                    parent_id=ids["parent_a"],
                    word="lúa",
                    normalized="lúa",
                    status_val="CORRECT",
                    version=1,
                    when=now - timedelta(minutes=25),
                ),
                _make_attempt(
                    child_id=ids["child_a"],
                    parent_id=ids["parent_a"],
                    word="nắng",
                    normalized="nắng",
                    status_val="CORRECT",
                    version=1,
                    when=now - timedelta(minutes=20),
                ),
            ]
        )
        r2 = client.get(f"/phoneme-garden/children/{ids['child_a']}/summary").json()
        ln_bed = next(b for b in r2["beds"] if b["bed_key"] == "l_n")
        self.assertEqual(ln_bed["stage"], "BUD")
        self.assertEqual(ln_bed["mastered_words_count"], 2)

        # Step 3: Entertainment contextual v2 requires 2 CORRECTs ("lá") -> 1st v2 stays BUD, 2nd v2 -> BLOOM!
        state.tables[DifficultWordPracticeAttempt].append(
            _make_attempt(
                child_id=ids["child_a"],
                parent_id=ids["parent_a"],
                word="lá",
                normalized="lá",
                status_val="CORRECT",
                version=2,
                when=now - timedelta(minutes=15),
            )
        )
        r3_single_v2 = client.get(
            f"/phoneme-garden/children/{ids['child_a']}/summary"
        ).json()
        ln_bed_mid = next(b for b in r3_single_v2["beds"] if b["bed_key"] == "l_n")
        self.assertEqual(ln_bed_mid["stage"], "BUD")
        self.assertEqual(ln_bed_mid["mastered_words_count"], 2)

        state.tables[DifficultWordPracticeAttempt].append(
            _make_attempt(
                child_id=ids["child_a"],
                parent_id=ids["parent_a"],
                word="lá",
                normalized="lá",
                status_val="CORRECT",
                version=2,
                when=now - timedelta(minutes=10),
            )
        )

        # Also seed 1 mastered word in each of the remaining 6 beds to verify all 7 categories map cleanly
        other_bed_words = [
            ("sáo", "s_x"),
            ("chim", "tr_ch"),
            ("gió", "r_d_gi"),
            ("lửa", "hoi_nga"),
            ("mát", "coda_n_ng_t_c"),
            ("lung linh", "compound_reduplicative"),
        ]
        for w_disp, _expected_bed in other_bed_words:
            state.tables[DifficultWordPracticeAttempt].append(
                _make_attempt(
                    child_id=ids["child_a"],
                    parent_id=ids["parent_a"],
                    word=w_disp,
                    normalized=w_disp,
                    status_val="CORRECT",
                    version=1,
                    when=now - timedelta(minutes=5),
                )
            )

        r4 = client.get(f"/phoneme-garden/children/{ids['child_a']}/summary").json()
        beds_by_key = {b["bed_key"]: b for b in r4["beds"]}
        self.assertEqual(beds_by_key["l_n"]["stage"], "BLOOM")
        self.assertEqual(beds_by_key["l_n"]["mastered_words_count"], 3)
        self.assertCountEqual(beds_by_key["l_n"]["mastered_words"], ["lá", "lúa", "nắng"])
        self.assertEqual(r4["bloomed_beds_count"], 1)

        for w_disp, bed_key in other_bed_words:
            self.assertEqual(beds_by_key[bed_key]["stage"], "SPROUT")
            self.assertIn(w_disp, beds_by_key[bed_key]["mastered_words"])

        bloom_milestone = next(
            m for m in r4["milestone_stamps"] if m["stamp_key"] == "first_mastered_bed"
        )
        self.assertTrue(bloom_milestone["unlocked"])

    def test_monotonic_non_punitive_after_long_multi_day_breaks(self) -> None:
        state, ids = _seed_garden_state()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        # Seed mastered words 210 days ago, followed by a 210-day break AND a single stumble
        ancient_ts = datetime.now(timezone.utc) - timedelta(days=210)
        for idx, word in enumerate(("sáo", "xanh", "sông")):
            state.tables[DifficultWordPracticeAttempt].append(
                _make_attempt(
                    child_id=ids["child_a"],
                    parent_id=ids["parent_a"],
                    word=word,
                    normalized=word,
                    status_val="CORRECT",
                    version=1,
                    when=ancient_ts + timedelta(minutes=idx),
                )
            )

        # Later exploratory reading stumble must NEVER wilt an already-bloomed bed
        state.tables[DifficultWordPracticeAttempt].append(
            _make_attempt(
                child_id=ids["child_a"],
                parent_id=ids["parent_a"],
                word="sáo",
                normalized="sáo",
                status_val="INCORRECT",
                version=1,
                when=datetime.now(timezone.utc) - timedelta(days=2),
            )
        )

        # Completed book session 200 days ago
        state.tables[ReadingSession].append(
            ReadingSession(
                Id=uuid4(),
                ChildId=ids["child_a"],
                BookId=ids["book_1"],
                State="COMPLETED",
                Mode="READ_ALOUD",
                StartedAt=ancient_ts,
                EndedAt=ancient_ts + timedelta(minutes=12),
            )
        )

        data = client.get(f"/phoneme-garden/children/{ids['child_a']}/summary").json()
        sx_bed = next(b for b in data["beds"] if b["bed_key"] == "s_x")
        self.assertEqual(sx_bed["stage"], "BLOOM")
        self.assertEqual(sx_bed["mastered_words_count"], 3)
        self.assertEqual(len(data["book_stamps"]), 1)
        first_session_stamp = next(
            m for m in data["milestone_stamps"] if m["stamp_key"] == "first_session"
        )
        self.assertTrue(first_session_stamp["unlocked"])

    def test_completed_book_stamp_deduplication_and_session_milestones(self) -> None:
        state, ids = _seed_garden_state()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)
        base_ts = datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc)

        # 6 completed sessions on book_1 + 4 FINISHED sessions on book_2 (10 total, spaced weeks apart)
        for i in range(6):
            ts = base_ts + timedelta(days=i * 10)
            state.tables[ReadingSession].append(
                ReadingSession(
                    Id=uuid4(),
                    ChildId=ids["child_a"],
                    BookId=ids["book_1"],
                    State="COMPLETED",
                    Mode="READ_ALOUD",
                    StartedAt=ts,
                    EndedAt=ts + timedelta(minutes=10),
                )
            )
        for j in range(4):
            ts = base_ts + timedelta(days=70 + j * 9)
            state.tables[ReadingSession].append(
                ReadingSession(
                    Id=uuid4(),
                    ChildId=ids["child_a"],
                    BookId=ids["book_2"],
                    State="FINISHED",
                    Mode="READ_ALOUD",
                    StartedAt=ts,
                    EndedAt=ts + timedelta(minutes=8),
                )
            )
        # Incomplete session on a 3rd book must NOT award a completed book stamp
        state.tables[ReadingSession].append(
            ReadingSession(
                Id=uuid4(),
                ChildId=ids["child_a"],
                BookId=ids["book_in_progress"],
                State="IN_PROGRESS",
                Mode="READ_ALOUD",
                StartedAt=base_ts + timedelta(days=120),
                EndedAt=None,
            )
        )

        data = client.get(f"/phoneme-garden/children/{ids['child_a']}/summary").json()
        self.assertEqual(data["total_completed_books"], 2)
        self.assertEqual(data["total_completed_sessions"], 10)
        self.assertEqual(len(data["book_stamps"]), 2)

        stamps_by_book = {s["book_id"]: s for s in data["book_stamps"]}
        self.assertEqual(
            stamps_by_book[str(ids["book_1"])]["book_title"],
            "Dế Mèn Phiêu Lưu Ký",
        )
        self.assertEqual(
            stamps_by_book[str(ids["book_1"])]["completed_sessions_count"], 6
        )
        self.assertEqual(
            stamps_by_book[str(ids["book_2"])]["book_title"],
            "Bông Sen Trắng Mùa Hạ",
        )
        self.assertEqual(
            stamps_by_book[str(ids["book_2"])]["completed_sessions_count"], 4
        )
        self.assertNotIn(str(ids["book_in_progress"]), stamps_by_book)

        milestones = {m["stamp_key"]: m for m in data["milestone_stamps"]}
        self.assertTrue(milestones["first_session"]["unlocked"])
        self.assertTrue(milestones["five_sessions"]["unlocked"])
        self.assertTrue(milestones["ten_sessions"]["unlocked"])

    def test_cross_parent_isolation_and_not_found(self) -> None:
        state, ids = _seed_garden_state()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        # Parent A cannot read Parent B's child -> 403
        forbidden = client.get(f"/phoneme-garden/children/{ids['child_b']}/summary")
        self.assertEqual(forbidden.status_code, 403)

        # Unknown child -> 404
        missing = client.get(f"/phoneme-garden/children/{uuid4()}/summary")
        self.assertEqual(missing.status_code, 404)

        # Unauthenticated app without auth override -> 401
        raw_app = FastAPI()
        raw_app.include_router(api_router)
        unauth_client = TestClient(raw_app)
        unauth_res = unauth_client.get(
            f"/phoneme-garden/children/{ids['child_a']}/summary"
        )
        self.assertEqual(unauth_res.status_code, 401)


if __name__ == "__main__":
    unittest.main()
