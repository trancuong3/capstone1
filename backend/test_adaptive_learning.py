"""Unit tests for ViRead V4.0 Adaptive Learning Engine (G03) & Parent Analytics (G11)."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi import HTTPException

from app.services.adaptive_learning_service import (
    SKILL_TAXONOMY,
    AdaptiveLearningService,
    compute_adaptive_difficulty,
    compute_spaced_difficult_words,
)


class _FakeAdaptiveRepo:
    def __init__(
        self,
        *,
        child=None,
        evidence=None,
        word_attempts=None,
        picture_sessions=None,
        shooter_sessions=None,
        karaoke_sessions=None,
        memory_sessions=None,
    ) -> None:
        self.child = child
        self.evidence = evidence or []
        self.word_attempts = word_attempts or []
        self.picture_sessions = picture_sessions or []
        self.shooter_sessions = shooter_sessions or []
        self.karaoke_sessions = karaoke_sessions or []
        self.memory_sessions = memory_sessions or []
        self.db = SimpleNamespace(commit=AsyncMock())

    async def get_owned_child(self, child_id, parent_id):
        if self.child and self.child.Id == child_id and self.child.ParentId == parent_id:
            return self.child
        return None

    async def list_skill_evidence(self, child_id, *, window_days=90, limit=400):
        return self.evidence

    async def list_difficult_word_attempts(self, child_id, *, window_days=90, limit=200):
        return self.word_attempts

    async def list_picture_sessions(self, child_id, *, window_days=30, limit=50):
        return self.picture_sessions

    async def list_shooter_sessions(self, child_id, *, window_days=30, limit=50):
        return self.shooter_sessions

    async def list_karaoke_sessions(self, child_id, *, window_days=30, limit=50):
        return self.karaoke_sessions

    async def list_memory_sessions(self, child_id, *, window_days=30, limit=50):
        return self.memory_sessions


class AdaptiveLearningEngineTests(unittest.IsolatedAsyncioTestCase):
    def test_taxonomy_has_16_unique_skills(self) -> None:
        self.assertEqual(len(SKILL_TAXONOMY), 16)
        keys = {item.skill_key for item in SKILL_TAXONOMY}
        self.assertEqual(len(keys), 16)

    def test_adaptive_difficulty_requires_three_high_confidence_attempts(self) -> None:
        # 2 strong attempts -> must HOLD
        plan_two = compute_adaptive_difficulty(
            2, [(0.95, 0.9), (0.95, 0.9)], "SENTENCE_SHOOTER"
        )
        self.assertEqual(plan_two.direction, "HOLD")
        self.assertEqual(plan_two.recommended_difficulty, 2)
        self.assertTrue(plan_two.requires_more_evidence)

        # 4 noisy low-confidence attempts -> must HOLD (ignored)
        plan_noisy = compute_adaptive_difficulty(
            2, [(0.1, 0.2), (0.1, 0.3), (0.1, 0.4), (0.1, 0.5)], "KARAOKE"
        )
        self.assertEqual(plan_noisy.direction, "HOLD")
        self.assertEqual(plan_noisy.high_confidence_attempts, 0)

        # 3 strong high-confidence attempts -> INCREASE by 1
        plan_up = compute_adaptive_difficulty(
            2, [(0.92, 0.85), (0.88, 0.80), (0.90, 0.75)], "SENTENCE_SHOOTER"
        )
        self.assertEqual(plan_up.direction, "INCREASE")
        self.assertEqual(plan_up.recommended_difficulty, 3)
        self.assertFalse(plan_up.requires_more_evidence)

        # 3 struggling high-confidence attempts -> DECREASE by 1
        plan_down = compute_adaptive_difficulty(
            3, [(0.30, 0.85), (0.35, 0.80), (0.40, 0.75)], "MEMORY_GAME"
        )
        self.assertEqual(plan_down.direction, "DECREASE")
        self.assertEqual(plan_down.recommended_difficulty, 2)

        # Grade 1 floor never goes below 1; Grade 5 cap never exceeds 5
        plan_floor = compute_adaptive_difficulty(
            1, [(0.2, 0.9), (0.2, 0.9), (0.2, 0.9)], "MEMORY_GAME"
        )
        self.assertEqual(plan_floor.recommended_difficulty, 1)
        plan_cap = compute_adaptive_difficulty(
            5, [(0.98, 0.9), (0.95, 0.9), (0.96, 0.9)], "MEMORY_GAME"
        )
        self.assertEqual(plan_cap.recommended_difficulty, 5)

    def test_spaced_difficult_words_prioritizes_errors_and_overdue(self) -> None:
        now = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)
        attempts = [
            SimpleNamespace(
                NormalizedWord="khung long",
                DisplayText="khủng long",
                AssessmentStatus="INCORRECT",
                CompletedAt=now - timedelta(days=4),
                CreatedAt=now - timedelta(days=4),
            ),
            SimpleNamespace(
                NormalizedWord="bong hoa",
                DisplayText="bông hoa",
                AssessmentStatus="CORRECT",
                CompletedAt=now - timedelta(hours=3),
                CreatedAt=now - timedelta(hours=3),
            ),
            SimpleNamespace(
                NormalizedWord="bong hoa",
                DisplayText="bông hoa",
                AssessmentStatus="CORRECT",
                CompletedAt=now - timedelta(hours=2),
                CreatedAt=now - timedelta(hours=2),
            ),
        ]
        ranked = compute_spaced_difficult_words(attempts, now=now)
        self.assertEqual(len(ranked), 2)
        self.assertEqual(ranked[0].display_text, "khủng long")
        self.assertGreater(ranked[0].priority_score, ranked[1].priority_score)

    async def test_unknown_skills_never_fabricated_and_ownership_enforced(self) -> None:
        parent_id = uuid4()
        other_parent_id = uuid4()
        child_id = uuid4()
        child = SimpleNamespace(Id=child_id, ParentId=parent_id, Alias="Bé An", Grade=2)
        service = AdaptiveLearningService(_FakeAdaptiveRepo(child=child))

        # IDOR protection: different parent gets 404
        with self.assertRaises(HTTPException) as ctx:
            await service.get_adaptive_profile(child_id, other_parent_id)
        self.assertEqual(ctx.exception.status_code, 404)

        profile = await service.get_adaptive_profile(child_id, parent_id)
        self.assertFalse(profile.is_diagnostic)
        self.assertEqual(profile.unknown_skills_count, 16)
        self.assertEqual(profile.observed_skills_count, 0)
        self.assertTrue(all(s.mastery_pct is None for s in profile.skills))
        self.assertIn("IQ", profile.disclaimer_vi)
        self.assertEqual(len(profile.recommendations), 4)

    async def test_parent_analytics_aggregates_real_evidence_and_ignores_insufficient_karaoke(
        self,
    ) -> None:
        parent_id = uuid4()
        child_id = uuid4()
        song_id = uuid4()
        now = datetime.now(timezone.utc)
        child = SimpleNamespace(Id=child_id, ParentId=parent_id, Alias="Bé Minh", Grade=3)

        karaoke_sessions = [
            SimpleNamespace(
                Id=uuid4(),
                SongId=song_id,
                ScoringMode="INSUFFICIENT_EVIDENCE",
                OverallScore=None,
                RhythmScore=None,
                PitchScore=None,
                LyricsScore=None,
                ReportPayload={},
                CreatedAt=now,
            ),
            SimpleNamespace(
                Id=uuid4(),
                SongId=song_id,
                ScoringMode="FULL_MUSICAL",
                OverallScore=84,
                RhythmScore=88,
                PitchScore=79,
                LyricsScore=85,
                ReportPayload={
                    "weakest_segment": {
                        "text": "Con cò bay lả bay la",
                        "start_ms": 12000,
                        "end_ms": 16500,
                        "tip_vi": "Thử hát chậm 0.85x câu này để vào nhịp nhẹ hơn nhé.",
                    }
                },
                CreatedAt=now,
            ),
        ]
        memory_sessions = [
            SimpleNamespace(
                Id=uuid4(),
                AttemptsCount=2,
                BestFactualScore=90,
                BestCreativeScore=85,
                CreatedAt=now,
                UpdatedAt=now,
            ),
            SimpleNamespace(
                Id=uuid4(),
                AttemptsCount=1,
                BestFactualScore=80,
                BestCreativeScore=75,
                CreatedAt=now - timedelta(days=1),
                UpdatedAt=now - timedelta(days=1),
            ),
        ]

        repo = _FakeAdaptiveRepo(
            child=child,
            karaoke_sessions=karaoke_sessions,
            memory_sessions=memory_sessions,
        )
        service = AdaptiveLearningService(repo)
        analytics = await service.get_parent_analytics(child_id, parent_id, window_days=30)

        self.assertFalse(analytics.is_diagnostic)
        self.assertEqual(len(analytics.karaoke_weak_segments), 1)
        self.assertEqual(analytics.karaoke_weak_segments[0].line_text, "Con cò bay lả bay la")

        skill_map = {s.skill_key: s for s in analytics.skills}
        # 2 high-confidence memory sessions -> OBSERVED
        self.assertEqual(skill_map["visual_memory_recall"].status, "OBSERVED")
        self.assertIsNotNone(skill_map["visual_memory_recall"].mastery_pct)
        # Only 1 valid karaoke session (INSUFFICIENT_EVIDENCE ignored) -> ESTIMATED
        self.assertEqual(skill_map["rhythm_timing"].status, "ESTIMATED")
        self.assertEqual(skill_map["rhythm_timing"].evidence_count, 1)

    async def test_real_orm_game_session_synthesizes_shooter_mastery_without_attribute_error(
        self,
    ) -> None:
        from app.models.game_session import GameSession

        parent_id = uuid4()
        child_id = uuid4()
        now = datetime.now(timezone.utc)
        child = SimpleNamespace(Id=child_id, ParentId=parent_id, Alias="Bé Lan", Grade=2)
        real_shooter = GameSession(
            Id=uuid4(),
            ChildProfileId=child_id,
            BookId=uuid4(),
            Difficulty="easy",
            TotalRounds=3,
            CompletedRounds=3,
            CorrectCount=11,
            MistakeCount=1,
            HintCount=0,
            TotalStars=8,
            Status="COMPLETED",
            CreatedAt=now,
            CompletedAt=now,
        )
        self.assertFalse(hasattr(real_shooter, "Score"))

        repo = _FakeAdaptiveRepo(child=child, shooter_sessions=[real_shooter])
        service = AdaptiveLearningService(repo)
        analytics = await service.get_parent_analytics(child_id, parent_id, window_days=30)

        shooter_mod = next(
            m for m in analytics.module_activities if m.game_key == "SENTENCE_SHOOTER"
        )
        self.assertEqual(shooter_mod.sessions_count, 1)
        self.assertIsNotNone(shooter_mod.recent_average_pct)
        self.assertGreaterEqual(shooter_mod.recent_average_pct or 0, 80)

        skill_map = {s.skill_key: s for s in analytics.skills}
        self.assertEqual(skill_map["sentence_ordering"].evidence_count, 1)
        self.assertGreaterEqual(skill_map["sentence_ordering"].mastery_pct or 0, 80)


class AdaptiveLearningV41FeedIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_feed_targets_populate_focus_words_quick_play_href_and_reinforced_metric(
        self,
    ) -> None:
        from app.services.child_difficult_word_feed import DifficultWordTarget

        parent_id = uuid4()
        child_id = uuid4()
        now = datetime.now(timezone.utc)
        child = SimpleNamespace(Id=child_id, ParentId=parent_id, Alias="Bé Na", Grade=2)
        feed_targets = [
            DifficultWordTarget(
                word="chăm chỉ",
                normalized_word="chăm chỉ",
                error_count=3,
                heard_as="chậm chạp",
                source_book_ids=[uuid4()],
                source_page_ids=[uuid4()],
                priority_score=8.5,
                last_seen_at=now - timedelta(hours=2),
                reinforced_count=0,
            )
        ]
        evidence = [
            SimpleNamespace(
                Id=uuid4(),
                ChildId=child_id,
                ParentId=parent_id,
                SkillKey="difficult_word_mastery",
                SourceModule="SENTENCE_SHOOTER",
                SourceRecordId=str(uuid4()),
                EvidenceType="OBSERVED",
                ScoreNormalized=0.9,
                Confidence=0.85,
                DifficultyLevel=2,
                PracticeWords=["chăm chỉ", "gọn gàng"],
                CreatedAt=now - timedelta(days=1),
            )
        ]

        repo = _FakeAdaptiveRepo(child=child, evidence=evidence)
        repo.list_difficult_word_targets = AsyncMock(return_value=feed_targets)
        service = AdaptiveLearningService(repo)

        profile = await service.get_adaptive_profile(child_id, parent_id, window_days=30)
        self.assertEqual(
            [item.display_text for item in profile.spaced_difficult_words],
            ["chăm chỉ"],
        )
        hub = await service.get_entertainment_recommendations(child_id, parent_id)
        self.assertEqual(hub.focus_difficult_words, ["chăm chỉ"])
        self.assertTrue(profile.recommendations)
        self.assertTrue(
            all(
                card.quick_play_href and "autoplay=1" in card.quick_play_href
                for card in profile.recommendations
            )
        )

        analytics = await service.get_parent_analytics(child_id, parent_id, window_days=30)
        self.assertEqual(analytics.reading_misread_words_reinforced, 2)

    async def test_m3_no_double_count_practice_only_and_m5_reinforced_threshold(self) -> None:
        from app.services.child_difficult_word_feed import DifficultWordTarget

        parent_id = uuid4()
        child_id = uuid4()
        now = datetime.now(timezone.utc)
        child = SimpleNamespace(Id=child_id, ParentId=parent_id, Alias="Bé Na", Grade=2)
        word_attempts = [
            SimpleNamespace(
                Id=uuid4(),
                NormalizedWord="kỳ diệu",
                DisplayText="kỳ diệu",
                AssessmentStatus="INCORRECT",
                CompletedAt=now - timedelta(hours=2),
                CreatedAt=now - timedelta(hours=2),
            ),
        ]
        # Practice-only target from ChildDifficultWordFeed (reading_error_count=0, practice_error_count=1)
        practice_only_target = DifficultWordTarget(
            word="kỳ diệu",
            normalized_word="kỳ diệu",
            error_count=1,
            heard_as=None,
            priority_score=4.0,
            last_seen_at=now - timedelta(hours=2),
            reinforced_count=0,
            reading_error_count=0,
            practice_error_count=1,
        )
        spaced = compute_spaced_difficult_words(
            word_attempts,
            feed_targets=[practice_only_target],
            now=now,
        )
        self.assertEqual(len(spaced), 1)
        # Must NOT claim "khi đọc sách" for a practice-only word with 0 reading errors
        self.assertNotIn("khi đọc sách", spaced[0].reason_vi)
        # Must NOT double-count incorrect=2 (1*0.8 + 1 + 4*0.3 = 3.0; if double-counted would be 3.8 -> 5.7)
        self.assertAlmostEqual(spaced[0].priority_score, round((1.0 + 1 * 0.8 + 4.0 * 0.3) * 0.5, 2), places=2)

        # M5: difficult_word_mastery rows below 0.75 must NOT count into reading_misread_words_reinforced
        evidence = [
            SimpleNamespace(
                Id=uuid4(),
                ChildId=child_id,
                ParentId=parent_id,
                SkillKey="difficult_word_mastery",
                SourceModule="MEMORY_GAME",
                SourceRecordId=str(uuid4()),
                EvidenceType="OBSERVED",
                ScoreNormalized=0.40,
                Confidence=0.8,
                DifficultyLevel=2,
                PracticeWords=["từ yếu"],
                CreatedAt=now - timedelta(hours=1),
            ),
            SimpleNamespace(
                Id=uuid4(),
                ChildId=child_id,
                ParentId=parent_id,
                SkillKey="difficult_word_mastery",
                SourceModule="KARAOKE",
                SourceRecordId=str(uuid4()),
                EvidenceType="OBSERVED",
                ScoreNormalized=0.85,
                Confidence=0.8,
                DifficultyLevel=2,
                PracticeWords=["từ vững"],
                CreatedAt=now - timedelta(hours=1),
            ),
        ]
        repo = _FakeAdaptiveRepo(child=child, evidence=evidence)
        repo.list_difficult_word_targets = AsyncMock(return_value=[])
        service = AdaptiveLearningService(repo)
        analytics = await service.get_parent_analytics(child_id, parent_id, window_days=30)
        self.assertEqual(analytics.reading_misread_words_reinforced, 1)


if __name__ == "__main__":
    unittest.main()
