"""Feature #9 test suite: Personalized 5-Minute Daily Reading Train ("Chuyến Tàu Luyện Đọc 5 Phút").

Covers:
1. 3-car generation with spaced difficult words & phonics syllable hints + Toa 2 exact seeding + Toa 3 passage / 0.85x slow Karaoke
2. Cold-start child fallback with grade-appropriate Vietnamese words (Grades 1..5)
3. Completion skill evidence recording (VOICE -> OBSERVED, NO_MIC_TOUCH -> ESTIMATED, idempotent replay)
4. Cross-parent 403/404 household isolation & unauthenticated rejection
5. Mandatory `Cache-Control: private, no-store` headers on GET and POST
"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/viread_test",
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.test-signature",
)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from app.api.deps import require_parent_id  # noqa: E402
from app.api.routes import adaptive_learning as adaptive_routes  # noqa: E402
from app.database.session import get_db  # noqa: E402


class _InMemoryAdaptiveRepo:
    """Deterministic repository stub emulating `learning_skill_evidence` unique constraints."""

    def __init__(
        self,
        *,
        children: list[SimpleNamespace],
        word_attempts: dict[UUID, list[SimpleNamespace]] | None = None,
        picture_sessions: dict[UUID, list[SimpleNamespace]] | None = None,
        shooter_sessions: dict[UUID, list[SimpleNamespace]] | None = None,
        karaoke_sessions: dict[UUID, list[SimpleNamespace]] | None = None,
        memory_sessions: dict[UUID, list[SimpleNamespace]] | None = None,
    ) -> None:
        self.children = {c.Id: c for c in children}
        self.word_attempts = word_attempts or {}
        self.picture_sessions = picture_sessions or {}
        self.shooter_sessions = shooter_sessions or {}
        self.karaoke_sessions = karaoke_sessions or {}
        self.memory_sessions = memory_sessions or {}
        self.evidence_by_child: dict[UUID, list[SimpleNamespace]] = {}
        self._unique_source_keys: set[tuple[UUID, str, str, str]] = set()
        self.db = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock())

    async def get_owned_child(self, child_id: UUID, parent_id: UUID):
        child = self.children.get(child_id)
        if child is not None and child.ParentId == parent_id:
            return child
        return None

    async def list_skill_evidence(self, child_id: UUID, *, window_days: int = 90, limit: int = 400):
        rows = list(self.evidence_by_child.get(child_id, []))
        rows.sort(key=lambda r: r.CreatedAt, reverse=True)
        return rows[:limit]

    async def list_difficult_word_attempts(self, child_id: UUID, *, window_days: int = 90, limit: int = 200):
        return list(self.word_attempts.get(child_id, []))[:limit]

    async def list_picture_sessions(self, child_id: UUID, *, window_days: int = 30, limit: int = 50):
        return list(self.picture_sessions.get(child_id, []))[:limit]

    async def list_shooter_sessions(self, child_id: UUID, *, window_days: int = 30, limit: int = 50):
        return list(self.shooter_sessions.get(child_id, []))[:limit]

    async def list_karaoke_sessions(self, child_id: UUID, *, window_days: int = 30, limit: int = 50):
        return list(self.karaoke_sessions.get(child_id, []))[:limit]

    async def list_memory_sessions(self, child_id: UUID, *, window_days: int = 30, limit: int = 50):
        return list(self.memory_sessions.get(child_id, []))[:limit]

    async def create_evidence(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        skill_key: str,
        source_module: str,
        source_record_id: str | None,
        evidence_type: str,
        score_normalized: float,
        confidence: float,
        difficulty_level: int,
        practice_words: list[str],
        metadata_json: dict,
    ) -> SimpleNamespace:
        if source_record_id is not None:
            uniq = (child_id, source_module, source_record_id, skill_key)
            if uniq in self._unique_source_keys:
                raise IntegrityError("duplicate source_record_id", params=None, orig=Exception("dup"))
            self._unique_source_keys.add(uniq)

        row = SimpleNamespace(
            Id=uuid4(),
            ChildId=child_id,
            ParentId=parent_id,
            SkillKey=skill_key,
            SourceModule=source_module,
            SourceRecordId=source_record_id,
            EvidenceType=evidence_type,
            ScoreNormalized=score_normalized,
            Confidence=confidence,
            DifficultyLevel=difficulty_level,
            PracticeWords=list(practice_words),
            MetadataJson=dict(metadata_json),
            CreatedAt=datetime.now(timezone.utc),
        )
        self.evidence_by_child.setdefault(child_id, []).append(row)
        return row


class FiveMinuteReadingTrainTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original_service_factory = adaptive_routes._service

    def tearDown(self) -> None:
        adaptive_routes._service = self._original_service_factory

    def _build_test_client(
        self,
        repo: _InMemoryAdaptiveRepo,
        active_parent_holder: dict[str, UUID] | None = None,
    ) -> TestClient:
        app = FastAPI()
        app.include_router(adaptive_routes.router, prefix="/learning")

        async def _fake_db():
            yield repo.db

        app.dependency_overrides[get_db] = _fake_db
        if active_parent_holder is not None:

            async def _fake_parent_id() -> UUID:
                return active_parent_holder["parent_id"]

            app.dependency_overrides[require_parent_id] = _fake_parent_id

        adaptive_routes._service = lambda _db: adaptive_routes.AdaptiveLearningService(repo)  # type: ignore[assignment]
        return TestClient(app)

    def test_daily_train_3_car_synthesis_with_spaced_difficult_words_and_karaoke(self) -> None:
        parent_id = uuid4()
        child_id = uuid4()
        now = datetime.now(timezone.utc)
        child = SimpleNamespace(
            Id=child_id,
            ParentId=parent_id,
            Alias="Bé An",
            Grade=2,
            Settings={"voice_preferences": {"gender": "female"}},
        )

        attempts = [
            SimpleNamespace(
                Id=uuid4(),
                NormalizedWord="truyen thong",
                DisplayText="truyền thống",
                AssessmentStatus="INCORRECT",
                Confidence=0.82,
                AssessmentVersion=1,
                CompletedAt=now - timedelta(days=2),
                CreatedAt=now - timedelta(days=2),
            ),
            SimpleNamespace(
                Id=uuid4(),
                NormalizedWord="chim se",
                DisplayText="chim sẻ",
                AssessmentStatus="INCORRECT",
                Confidence=0.79,
                AssessmentVersion=1,
                CompletedAt=now - timedelta(days=3),
                CreatedAt=now - timedelta(days=3),
            ),
            SimpleNamespace(
                Id=uuid4(),
                NormalizedWord="khung long",
                DisplayText="khủng long",
                AssessmentStatus="INCORRECT",
                Confidence=0.85,
                AssessmentVersion=1,
                CompletedAt=now - timedelta(days=1),
                CreatedAt=now - timedelta(days=1),
            ),
        ]
        karaoke_sessions = [
            SimpleNamespace(
                Id=uuid4(),
                SongId=uuid4(),
                ScoringMode="FULL_MUSICAL",
                OverallScore=80,
                RhythmScore=82,
                PitchScore=76,
                LyricsScore=78,
                ReportPayload={
                    "weakest_segment": {
                        "text": "Con cò bay lả bay la",
                        "start_ms": 8000,
                        "end_ms": 12000,
                        "tip_vi": "Nghe chậm 0.85x câu hát này rồi ngân nhẹ theo nhịp nhé.",
                    }
                },
                CreatedAt=now - timedelta(days=1),
            )
        ]

        repo = _InMemoryAdaptiveRepo(
            children=[child],
            word_attempts={child_id: attempts},
            karaoke_sessions={child_id: karaoke_sessions},
        )
        client = self._build_test_client(repo, {"parent_id": parent_id})

        res = client.get(f"/learning/children/{child_id}/daily-five-minute-train")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers.get("cache-control"), "private, no-store")

        body = res.json()
        self.assertEqual(body["visibility"], "PARENT_PRIVATE")
        self.assertFalse(body["is_cold_start"])
        self.assertFalse(body["completed_today"])
        self.assertEqual(body["total_estimated_seconds"], 300)
        self.assertIn("cô", body["greeting_vi"].lower())

        # Toa 1: ~90s warm-up with 2-3 spaced difficult words, phonics categories & syllable hints
        car1 = body["car_1_warmup"]
        self.assertEqual(car1["car_number"], 1)
        self.assertEqual(car1["estimated_seconds"], 90)
        self.assertTrue(2 <= len(car1["target_words"]) <= 3)
        car1_words = [w["display_text"] for w in car1["target_words"]]
        self.assertEqual(set(car1_words), {"truyền thống", "chim sẻ", "khủng long"})
        for item in car1["target_words"]:
            self.assertEqual(item["source"], "SPACED_DIFFICULT_WORD")
            self.assertTrue(bool(item["phonics_category"]))
            self.assertIn("Tách tiếng:", item["syllable_hint_vi"])

        # Toa 2: ~120s game round seeded with Toa 1's exact target words
        car2 = body["car_2_game"]
        self.assertEqual(car2["car_number"], 2)
        self.assertEqual(car2["estimated_seconds"], 120)
        self.assertIn(car2["game_key"], ("SENTENCE_SHOOTER", "PICTURE_DESCRIPTION"))
        self.assertEqual(car2["seeded_words"], car1_words)
        self.assertGreaterEqual(len(car2["sentence_tokens"]), 3)

        # Toa 3: ~90s fluency finish using 0.85x slow Karaoke lyric line when weak segment present
        car3 = body["car_3_fluency"]
        self.assertEqual(car3["car_number"], 3)
        self.assertEqual(car3["estimated_seconds"], 90)
        self.assertEqual(car3["finish_mode"], "SLOW_KARAOKE_085X")
        self.assertEqual(car3["playback_speed"], 0.85)
        self.assertIn("Con cò bay lả bay la", car3["text_vi"])

    def test_cold_start_child_receives_grade_appropriate_vietnamese_words_and_short_passage(
        self,
    ) -> None:
        parent_id = uuid4()
        grade1_child = SimpleNamespace(
            Id=uuid4(), ParentId=parent_id, Alias="Bé Bo", Grade=1, Settings={}
        )
        grade5_child = SimpleNamespace(
            Id=uuid4(), ParentId=parent_id, Alias="Bé Hà", Grade=5, Settings={}
        )

        repo = _InMemoryAdaptiveRepo(children=[grade1_child, grade5_child])
        client = self._build_test_client(repo, {"parent_id": parent_id})

        res_g1 = client.get(f"/learning/children/{grade1_child.Id}/daily-five-minute-train")
        self.assertEqual(res_g1.status_code, 200)
        self.assertEqual(res_g1.headers.get("cache-control"), "private, no-store")
        plan_g1 = res_g1.json()
        self.assertTrue(plan_g1["is_cold_start"])
        g1_words = [w["display_text"] for w in plan_g1["car_1_warmup"]["target_words"]]
        self.assertEqual(g1_words, ["con trâu", "bông sen", "cây tre"])
        self.assertTrue(
            all(w["source"] == "COLD_START_GRADE" for w in plan_g1["car_1_warmup"]["target_words"])
        )
        self.assertEqual(plan_g1["car_2_game"]["seeded_words"], g1_words)
        self.assertEqual(plan_g1["car_3_fluency"]["finish_mode"], "SHORT_PASSAGE")
        self.assertEqual(plan_g1["car_3_fluency"]["playback_speed"], 0.85)

        res_g5 = client.get(f"/learning/children/{grade5_child.Id}/daily-five-minute-train")
        self.assertEqual(res_g5.status_code, 200)
        plan_g5 = res_g5.json()
        self.assertTrue(plan_g5["is_cold_start"])
        g5_words = [w["display_text"] for w in plan_g5["car_1_warmup"]["target_words"]]
        self.assertEqual(g5_words, ["nghiêng nghiêng", "sáng suốt", "trưởng thành"])
        self.assertNotEqual(g5_words, g1_words)

    def test_completion_records_evidence_supports_no_mic_touch_and_idempotent_replay(self) -> None:
        parent_id = uuid4()
        child_id = uuid4()
        child = SimpleNamespace(
            Id=child_id, ParentId=parent_id, Alias="Bé Minh", Grade=3, Settings={}
        )
        repo = _InMemoryAdaptiveRepo(children=[child])
        client = self._build_test_client(repo, {"parent_id": parent_id})

        # 1. Complete in NO_MIC_TOUCH mode -> records ESTIMATED evidence cleanly without blocking
        payload_no_mic = {
            "train_id": f"train-{child_id}-2026-11-28",
            "client_completion_id": "comp-nomic-001",
            "interaction_mode": "NO_MIC_TOUCH",
            "duration_seconds": 295,
            "practiced_words": ["trong trẻo", "rực rỡ", "cánh đồng"],
            "car_2_game_key": "SENTENCE_SHOOTER",
            "car_3_finish_mode": "SHORT_PASSAGE",
            "car_1_completed": True,
            "car_2_completed": True,
            "car_3_completed": True,
        }
        res_complete = client.post(
            f"/learning/children/{child_id}/daily-five-minute-train/complete",
            json=payload_no_mic,
        )
        self.assertEqual(res_complete.status_code, 200)
        self.assertEqual(res_complete.headers.get("cache-control"), "private, no-store")
        done_body = res_complete.json()
        self.assertEqual(done_body["visibility"], "PARENT_PRIVATE")
        self.assertEqual(done_body["interaction_mode"], "NO_MIC_TOUCH")
        self.assertEqual(done_body["recorded_evidence_count"], 3)
        self.assertEqual(done_body["today_completed_trains_count"], 1)
        self.assertIn("nghỉ", done_body["natural_break_cue_vi"].lower())

        stored_rows = repo.evidence_by_child[child_id]
        self.assertEqual(len(stored_rows), 3)
        self.assertEqual(
            {r.SkillKey for r in stored_rows},
            {"difficult_word_mastery", "sentence_ordering", "reading_fluency"},
        )
        self.assertTrue(
            all(r.EvidenceType == "ESTIMATED" and r.Confidence < 0.60 for r in stored_rows)
        )

        # 2. Idempotent replay of identical client_completion_id does not duplicate rows or 409
        replay = client.post(
            f"/learning/children/{child_id}/daily-five-minute-train/complete",
            json=payload_no_mic,
        )
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(len(repo.evidence_by_child[child_id]), 3)
        self.assertEqual(replay.json()["today_completed_trains_count"], 1)

        # 3. Subsequent GET marks completed_today = True
        refreshed = client.get(f"/learning/children/{child_id}/daily-five-minute-train")
        self.assertEqual(refreshed.status_code, 200)
        self.assertTrue(refreshed.json()["completed_today"])
        self.assertEqual(refreshed.json()["today_completed_count"], 1)

        # 4. VOICE mode records high-confidence OBSERVED evidence
        res_voice = client.post(
            f"/learning/children/{child_id}/daily-five-minute-train/complete",
            json={
                **payload_no_mic,
                "client_completion_id": "comp-voice-002",
                "interaction_mode": "VOICE",
                "car_2_game_key": "PICTURE_DESCRIPTION",
                "car_3_finish_mode": "SLOW_KARAOKE_085X",
            },
        )
        self.assertEqual(res_voice.status_code, 200)
        self.assertEqual(res_voice.json()["recorded_evidence_count"], 3)
        self.assertEqual(res_voice.json()["today_completed_trains_count"], 2)
        newest = [r for r in repo.evidence_by_child[child_id] if r.EvidenceType == "OBSERVED"]
        self.assertEqual(len(newest), 3)
        self.assertTrue(all(r.Confidence >= 0.75 for r in newest))

    def test_cross_parent_isolation_and_unauthenticated_access_blocked(self) -> None:
        owner_parent_id = uuid4()
        intruder_parent_id = uuid4()
        child_id = uuid4()
        child = SimpleNamespace(
            Id=child_id, ParentId=owner_parent_id, Alias="Bé Na", Grade=2, Settings={}
        )

        repo = _InMemoryAdaptiveRepo(children=[child])
        client = self._build_test_client(repo, {"parent_id": intruder_parent_id})

        res_get = client.get(f"/learning/children/{child_id}/daily-five-minute-train")
        self.assertIn(res_get.status_code, (403, 404))
        self.assertEqual(res_get.headers.get("cache-control"), "private, no-store")

        res_post = client.post(
            f"/learning/children/{child_id}/daily-five-minute-train/complete",
            json={
                "train_id": f"train-{child_id}-2026-11-28",
                "interaction_mode": "VOICE",
                "duration_seconds": 300,
                "practiced_words": ["chim sẻ"],
            },
        )
        self.assertIn(res_post.status_code, (403, 404))
        self.assertEqual(res_post.headers.get("cache-control"), "private, no-store")
        self.assertEqual(repo.evidence_by_child.get(child_id, []), [])

        # Unauthenticated request (real require_parent_id dependency) -> 401/403
        unauth_client = self._build_test_client(repo, None)
        unauth_res = unauth_client.get(f"/learning/children/{child_id}/daily-five-minute-train")
        self.assertIn(unauth_res.status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
