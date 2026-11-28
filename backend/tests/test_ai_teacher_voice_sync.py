"""Tests for AI Teacher Voice Selection & 100% System-Wide Synchronization."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from pydantic import ValidationError

from app.api.routes.profile import (
    ChildProfileNotFoundError,
    ChildProfileService,
)
from app.providers.local_voice_provider import STATIC_LOCAL_VOICES
from app.schemas.picture_description import PictureGuideRead, PictureVocabItem
from app.schemas.profile import ChildVoicePreferencesUpdate, DashboardSummaryResponse
from app.services.games.memory_game_evaluator import (
    MemoryGameEvaluator,
    evaluate_memory_attempt_deterministic,
)
from app.services.games.memory_scene_generator import generate_scene_spec
from app.services.picture_description_ai import (
    evaluate_description_with_guide_fallback,
)
from app.services.profile_service import ProfileService
from app.services.tts_audio_cache_service import (
    ResolvedCacheTarget,
    TtsAudioCacheService,
)
from app.services.voice_orchestrator import (
    _map_local_voice_to_google_backup,
    _resolve_local_voice_region_gender,
)


class AiTeacherVoiceSyncTests(unittest.IsolatedAsyncioTestCase):
    def test_child_voice_preferences_schema_validation(self) -> None:
        valid = ChildVoicePreferencesUpdate(
            voice_id="local_south_thai_son",
            gender="male",
            region="south",
            speed=0.95,
            updated_at=1700000000000,
        )
        self.assertEqual(valid.voice_id, "local_south_thai_son")
        self.assertEqual(valid.gender, "male")
        self.assertEqual(valid.region, "south")
        self.assertEqual(valid.speed, 0.95)

        # Reject extra fields (extra="forbid")
        with self.assertRaises(ValidationError):
            ChildVoicePreferencesUpdate(
                voice_id="local_north_truc_ly",
                gender="female",
                region="north",
                speed=0.9,
                unexpected_field="nope",  # type: ignore[call-arg]
            )

        # Reject invalid gender
        with self.assertRaises(ValidationError):
            ChildVoicePreferencesUpdate(
                voice_id="local_north_truc_ly",
                gender="robot",  # type: ignore[arg-type]
                region="north",
                speed=0.9,
            )

        # Reject invalid region
        with self.assertRaises(ValidationError):
            ChildVoicePreferencesUpdate(
                voice_id="local_north_truc_ly",
                gender="female",
                region="west",  # type: ignore[arg-type]
                speed=0.9,
            )

        # Reject out-of-range speed
        with self.assertRaises(ValidationError):
            ChildVoicePreferencesUpdate(
                voice_id="local_north_truc_ly",
                gender="female",
                region="north",
                speed=2.5,
            )

        # Reject gender/voice_id mismatch (female voice with male gender)
        with self.assertRaises(ValidationError):
            ChildVoicePreferencesUpdate(
                voice_id="local_north_truc_ly",
                gender="male",
                region="north",
                speed=0.9,
            )

    async def test_update_child_voice_preferences_ownership_and_dashboard_summary(self) -> None:
        parent_a = uuid4()
        parent_b = uuid4()
        child_id = uuid4()
        now = datetime.now(timezone.utc)

        stored_child = SimpleNamespace(
            Id=child_id,
            ParentId=parent_a,
            Alias="Bé Dơ",
            Grade=2,
            Settings={"existing_flag": True},
            AvatarPath=None,
            CreatedAt=now,
        )

        class FakeChildRepo:
            async def update_voice_preferences(self, cid, pid, voice_prefs):
                if cid != stored_child.Id or pid != stored_child.ParentId:
                    return None
                next_settings = dict(stored_child.Settings or {})
                next_settings["voice_preferences"] = dict(voice_prefs)
                stored_child.Settings = next_settings
                return stored_child

        service = ChildProfileService(FakeChildRepo())  # type: ignore[arg-type]
        payload = ChildVoicePreferencesUpdate(
            voice_id="local_north_thien_minh",
            gender="male",
            region="north",
            speed=1.0,
            updated_at=1700000001234,
        )

        # Parent A succeeds and preserves existing settings keys
        updated = await service.update_child_voice_preferences(child_id, parent_a, payload)
        self.assertIs(updated["settings"]["existing_flag"], True)
        self.assertEqual(updated["settings"]["voice_preferences"]["voice_id"], "local_north_thien_minh")
        self.assertEqual(updated["settings"]["voice_preferences"]["gender"], "male")

        # Parent B gets ChildProfileNotFoundError (404 on route)
        with self.assertRaises(ChildProfileNotFoundError):
            await service.update_child_voice_preferences(child_id, parent_b, payload)

        # Verify voice_preferences flows into DashboardSummaryResponse
        parent_profile = SimpleNamespace(
            Id=parent_a,
            DisplayName="Ba mẹ",
            Role="parent",
            CreatedAt=now,
            ContactPhone=None,
            AvatarPath=None,
            Active=1,
            children=[stored_child],
        )

        class FakeProfileRepo:
            async def get_by_id(self, pid):
                return parent_profile if pid == parent_a else None

            async def get_latest_sessions_by_child_ids(self, pid, cids):
                return []

        summary_raw = await ProfileService(FakeProfileRepo()).get_dashboard_summary(parent_a)  # type: ignore[arg-type]
        summary = DashboardSummaryResponse.model_validate(summary_raw)
        self.assertEqual(len(summary.children), 1)
        self.assertEqual(
            summary.children[0].settings["voice_preferences"]["voice_id"],
            "local_north_thien_minh",
        )
        self.assertEqual(summary.children[0].settings["voice_preferences"]["gender"], "male")

    def test_google_backup_mapping_preserves_gender_for_all_8_static_voices(self) -> None:
        for voice in STATIC_LOCAL_VOICES:
            vid = voice["voice_id"]
            expected_gender = voice["gender"]
            _region, resolved_gender = _resolve_local_voice_region_gender(vid)
            self.assertEqual(resolved_gender, expected_gender)

            backup = _map_local_voice_to_google_backup(vid)
            if expected_gender == "male":
                self.assertIn(backup, ("google_vi_vn_neural2_d", "google_vi_vn_wavenet_b"))
            else:
                self.assertIn(backup, ("google_vi_vn_neural2_a", "google_vi_vn_wavenet_c"))

    async def test_tts_cache_rejects_mismatched_voice_or_gender(self) -> None:
        wrong_gender_entry = SimpleNamespace(
            Id=uuid4(),
            ByteSize=1024,
            StorageBucket="viread-tts-cache",
            StoragePath="catalog/shared/common/abc/local_north_truc_ly_0p90.mp3",
            AudioFormat="audio/mpeg",
            VoiceId="local_north_truc_ly",  # Female!
            ModelVersion="vieneu-v3-turbo-onnx-fp32-3.8.5",
            DurationSeconds=1.2,
            WordTimingsJson=None,
            Scope="CATALOG",
            Speed=0.9,
            NormalizedText="con mèo",
        )

        fake_repo = SimpleNamespace(
            get_daily_usage=AsyncMock(return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}),
            get_active_entry=AsyncMock(return_value=wrong_gender_entry),
            record_miss=AsyncMock(),
        )
        fake_db = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock())

        svc = TtsAudioCacheService(None)
        svc.db = fake_db  # type: ignore[assignment]
        svc.repo = fake_repo  # type: ignore[assignment]
        target = ResolvedCacheTarget(
            scope="CATALOG",
            owner_parent_id=None,
            book_id=None,
            page_id=None,
            page_revision_id=None,
            can_store_on_miss=False,
        )

        with patch("app.services.tts_audio_cache_service.is_tts_cache_enabled", return_value=True):
            hit = await svc.lookup_cached_audio(
                target=target,
                normalized_text="con mèo",
                voice_id="local_north_thien_minh",  # Requested Male!
                speed=0.9,
            )
        self.assertIsNone(hit)
        fake_repo.record_miss.assert_awaited_once()

    def test_ai_prompts_and_deterministic_evaluators_respect_teacher_gender(self) -> None:
        guide = PictureGuideRead(
            is_child_safe=True,
            scene_title="Khu vườn nắng",
            scene_summary="Một chú mèo vàng đang chơi trong khu vườn hoa.",
            guiding_questions=["Trong tranh có ai?"],
            suggested_vocabulary=[
                PictureVocabItem(word="chú mèo", hint="con vật dễ thương"),
                PictureVocabItem(word="khu vườn", hint="nơi có nhiều hoa"),
            ],
            model_sample_sentences=["Chú mèo vàng đang chơi trong khu vườn."],
        )
        male_fb, _ = evaluate_description_with_guide_fallback(
            guide=guide,
            child_grade=2,
            child_transcript="Trong khu vườn có một chú mèo đang chơi rất vui.",
            teacher_gender="male",
        )
        female_fb, _ = evaluate_description_with_guide_fallback(
            guide=guide,
            child_grade=2,
            child_transcript="Trong khu vườn có một chú mèo đang chơi rất vui.",
            teacher_gender="female",
        )
        self.assertIn("Thầy khen bé", male_fb.praise_message)
        self.assertNotIn("Cô khen bé", male_fb.praise_message)
        self.assertIn("Cô khen bé", female_fb.praise_message)

        scene = generate_scene_spec(
            theme_key="sunny_garden",
            child_grade=2,
            difficulty_level=2,
            scene_seed=123,
        )
        mem_male = evaluate_memory_attempt_deterministic(
            scene_spec=scene,
            stage="CREATIVE",
            response_text="Chú mèo bỗng nhiên rủ các bạn đi phiêu lưu và cười rất vui vẻ!",
            teacher_gender="male",
        )
        mem_female = evaluate_memory_attempt_deterministic(
            scene_spec=scene,
            stage="CREATIVE",
            response_text="Chú mèo bỗng nhiên rủ các bạn đi phiêu lưu và cười rất vui vẻ!",
            teacher_gender="female",
        )
        self.assertNotIn("Cô ", mem_male.story_praise_vi)
        self.assertTrue(
            "Thầy" in mem_male.story_praise_vi
            or "thầy" in mem_male.story_praise_vi
            or "dễ thương" in mem_male.story_praise_vi
        )

        evaluator = MemoryGameEvaluator()
        male_prompt = evaluator._build_coaching_prompt(
            scene_spec=scene,
            stage="RECALL",
            response_text="Có chú mèo vàng",
            base=mem_male,
            teacher_gender="male",
        )
        female_prompt = evaluator._build_coaching_prompt(
            scene_spec=scene,
            stage="RECALL",
            response_text="Có chú mèo vàng",
            base=mem_female,
            teacher_gender="female",
        )
        self.assertIn("thầy giáo", male_prompt)
        self.assertIn("xưng 'thầy'", male_prompt)
        self.assertIn("cô giáo", female_prompt)
        self.assertIn("xưng 'cô'", female_prompt)

    async def test_picture_and_memory_repositories_expose_child_settings_for_gender_fallback(self) -> None:
        from app.repositories.memory_game_repository import (
            ChildProjection as MemoryChildProjection,
            MemoryGameRepository,
        )
        from app.repositories.picture_description_repository import (
            ChildProjection as PictureChildProjection,
            PictureDescriptionRepository,
        )
        from app.services.picture_description_service import PictureDescriptionService

        child_id = uuid4()
        parent_id = uuid4()
        fake_row = SimpleNamespace(
            Id=child_id,
            ParentId=parent_id,
            Grade=2,
            Settings={
                "voice_preferences": {
                    "voice_id": "local_south_thai_son",
                    "gender": "male",
                    "region": "south",
                    "speed": 0.95,
                }
            },
        )

        class FakeExecuteResult:
            def one_or_none(self):
                return fake_row

        fake_db = SimpleNamespace(execute=AsyncMock(return_value=FakeExecuteResult()))

        pic_child = await PictureDescriptionRepository(fake_db).child_owned_by(child_id, parent_id)  # type: ignore[arg-type]
        self.assertIsInstance(pic_child, PictureChildProjection)
        self.assertEqual(PictureDescriptionService._extract_child_teacher_gender(pic_child), "male")

        mem_child = await MemoryGameRepository(fake_db).child_owned_by(child_id, parent_id)  # type: ignore[arg-type]
        self.assertIsInstance(mem_child, MemoryChildProjection)
        self.assertEqual(mem_child.Settings["voice_preferences"]["gender"], "male")
