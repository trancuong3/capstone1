"""Tests for AI Teacher Voice Selection & 100% System-Wide Synchronization."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

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

    async def test_elevenlabs_male_never_falls_back_to_female_and_falls_through_to_google_without_cache_poisoning(
        self,
    ) -> None:
        import os
        from unittest.mock import patch
        import httpx
        from app.providers.elevenlabs_voice_provider import (
            DEFAULT_VOICE_ID,
            ElevenLabsVoiceProvider,
            SynthesizedAudio,
            VoiceProviderError,
            clear_caches,
        )
        from app.providers.google_voice_provider import GoogleCloudVoiceProvider
        from app.providers.local_voice_provider import (
            LocalSynthesizedAudio,
            LocalVoiceProvider,
            LocalVoiceTechnicalError,
        )
        from app.services.voice_orchestrator import VoiceOrchestrator, VoicePolicyContext

        clear_caches()
        calls: list[str] = []

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, url: str, **kwargs):
                calls.append(url)
                return httpx.Response(402, json={"detail": {"status": "paid_plan_required"}})

        provider = ElevenLabsVoiceProvider(api_key="sk_test_male_guard")
        with patch("app.providers.elevenlabs_voice_provider.httpx.AsyncClient", FakeAsyncClient):
            with self.assertRaises(VoiceProviderError):
                await provider.synthesize(
                    text="Thầy chào con nhé.",
                    requested_voice_id="custom_male_voice_123",
                    speed=0.9,
                    expected_gender="male",
                )
        # Must NOT retry with female DEFAULT_VOICE_ID!
        self.assertEqual(len(calls), 1)
        self.assertNotIn(DEFAULT_VOICE_ID, calls[0])

        # Orchestrator: when ElevenLabs male fails, fall through to Google Male TTS backup
        down_local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        down_local.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_VOICE_UNCONFIGURED")
        )
        el = ElevenLabsVoiceProvider(api_key="sk_test_key")
        el.synthesize = AsyncMock(  # type: ignore[method-assign]
            side_effect=VoiceProviderError(status_code=503, code="SPEECH_UNAVAILABLE")
        )
        google = GoogleCloudVoiceProvider(stt_api_key="g", tts_api_key="g")
        google.synthesize = AsyncMock(  # type: ignore[method-assign]
            return_value=LocalSynthesizedAudio(
                content=b"google-male-mp3",
                content_type="audio/mpeg",
                resolved_voice_id="google_vi_vn_neural2_d",
                region="north",
                model_version="google-cloud-tts-v1",
                provider="google",
            )
        )
        orch = VoiceOrchestrator(
            local_provider=down_local,
            google_provider=google,
            elevenlabs_provider=el,
        )
        with patch.dict(os.environ, {"ELEVENLABS_MALE_VOICE_ID": "JBFqnCBsd6RMkjVDRZzb"}, clear=False):
            res = await orch.synthesize(
                text="Thầy chào con",
                requested_voice_id="local_north_thien_minh",
                speed=0.9,
                policy=VoicePolicyContext(
                    provider_mode="local_with_google_fallback",
                    allow_google_tts=True,
                ),
            )
        self.assertEqual(res.provider, "google")
        self.assertEqual(res.resolved_voice_id, "google_vi_vn_neural2_d")
        self.assertTrue(res.used_fallback_voice)

    async def test_adaptive_learning_and_child_progress_adapt_to_male_teacher_persona(
        self,
    ) -> None:
        from app.services.adaptive_learning_service import AdaptiveLearningService
        from app.services.child_progress.ai import build_system_prompt
        from app.services.child_progress_service import ChildProgressService

        self.assertIn("Bạn là thầy giáo tiểu học", build_system_prompt("male"))
        self.assertNotIn("Bạn là cô giáo tiểu học", build_system_prompt("male"))
        self.assertIn("Bạn là cô giáo tiểu học", build_system_prompt("female"))

        parent_id = uuid4()
        child_id = uuid4()
        male_child = SimpleNamespace(
            Id=child_id,
            ParentId=parent_id,
            Alias="Bé Khôi",
            Grade=2,
            Settings={
                "voice_preferences": {
                    "voice_id": "local_north_thien_minh",
                    "gender": "male",
                    "region": "north",
                    "speed": 0.9,
                }
            },
        )
        self.assertEqual(
            ChildProgressService._extract_child_teacher_gender(male_child),
            "male",
        )

        fake_repo = SimpleNamespace(
            get_owned_child=AsyncMock(return_value=male_child),
            list_skill_evidence=AsyncMock(return_value=[]),
            list_difficult_word_attempts=AsyncMock(return_value=[]),
            list_picture_sessions=AsyncMock(return_value=[]),
            list_shooter_sessions=AsyncMock(return_value=[]),
            list_karaoke_sessions=AsyncMock(return_value=[]),
            list_memory_sessions=AsyncMock(return_value=[]),
        )
        adaptive_svc = AdaptiveLearningService(fake_repo)  # type: ignore[arg-type]
        recs = await adaptive_svc.get_entertainment_recommendations(child_id, parent_id)
        pic_rec = next(
            r for r in recs.recommendations if r.game_key == "PICTURE_DESCRIPTION"
        )
        self.assertIn("Thầy giáo AI", pic_rec.game_title_vi)
        self.assertNotIn("Cô giáo AI", pic_rec.game_title_vi)
        self.assertIn("Thầy giáo AI", pic_rec.reason_vi)

        analytics = await adaptive_svc.get_parent_analytics(child_id, parent_id)
        pic_mod = next(
            m for m in analytics.module_activities if m.game_key == "PICTURE_DESCRIPTION"
        )
        self.assertIn("Thầy giáo AI", pic_mod.title_vi)
        self.assertNotIn("Cô giáo AI", pic_mod.title_vi)

    async def test_out_of_order_voice_preferences_patch_does_not_overwrite_newer_timestamp(
        self,
    ) -> None:
        from app.api.routes.profile import ChildProfileRepository

        parent_id = uuid4()
        child_id = uuid4()
        fake_child = SimpleNamespace(
            Id=child_id,
            ParentId=parent_id,
            Settings={},
        )
        fake_db = SimpleNamespace(
            commit=AsyncMock(),
            refresh=AsyncMock(),
            rollback=AsyncMock(),
        )
        repo = ChildProfileRepository(fake_db)  # type: ignore[arg-type]
        repo.get_by_id_and_parent = AsyncMock(return_value=fake_child)  # type: ignore[method-assign]

        await repo.update_voice_preferences(
            child_id,
            parent_id,
            {
                "voice_id": "local_north_thien_minh",
                "gender": "male",
                "region": "north",
                "speed": 0.9,
                "updated_at": 2000,
            },
        )
        # Stale out-of-order request from an earlier click arrives late:
        await repo.update_voice_preferences(
            child_id,
            parent_id,
            {
                "voice_id": "local_north_truc_ly",
                "gender": "female",
                "region": "north",
                "speed": 0.9,
                "updated_at": 1000,
            },
        )
        self.assertEqual(
            fake_child.Settings["voice_preferences"]["voice_id"],
            "local_north_thien_minh",
        )
        self.assertEqual(fake_child.Settings["voice_preferences"]["gender"], "male")
        self.assertEqual(fake_child.Settings["voice_preferences"]["updated_at"], 2000)

    def test_google_male_voice_markers_and_extended_coaching_phrases(self) -> None:
        from app.services.adaptive_learning_service import AdaptiveLearningService
        from app.services.child_progress_service import ChildProgressService
        from app.services.tts_audio_cache_service import is_coaching_text_allowlisted

        for google_male_vid, expected_region in (
            ("google_vi_vn_neural2_d", "north"),
            ("google_vi_vn_wavenet_b", "south"),
        ):
            region, gender = _resolve_local_voice_region_gender(google_male_vid)
            self.assertEqual(region, expected_region)
            self.assertEqual(gender, "male")

            child_no_explicit_gender = SimpleNamespace(
                Settings={"voice_preferences": {"voice_id": google_male_vid}}
            )
            self.assertEqual(
                ChildProgressService._extract_child_teacher_gender(child_no_explicit_gender),
                "male",
            )
            self.assertEqual(
                AdaptiveLearningService._resolve_teacher_gender(child_no_explicit_gender),
                "male",
            )

        for phrase in (
            "Cô chưa nghe rõ tiếng vừa rồi, con đọc lại rõ hơn một chút nhé.",
            "Thầy chưa nghe rõ tiếng vừa rồi, con đọc lại rõ hơn một chút nhé.",
            "Không sao đâu, từ này mình luyện thêm sau. Mình sang từ tiếp theo nhé!",
        ):
            self.assertTrue(is_coaching_text_allowlisted(phrase), phrase)

    async def test_catalog_allowlist_permits_extracted_sentences_from_multi_sentence_page(self) -> None:
        book_id = uuid4()
        fake_repo = SimpleNamespace(
            get_verified_catalog_texts=AsyncMock(
                return_value=[
                    (
                        "Hai mươi mốt bông hoa. Hôm nay trời nắng đẹp!",
                        [
                            ("hai", "Hai"),
                            ("mươi", "mươi"),
                            ("mốt", "mốt"),
                            ("bông", "bông"),
                            ("hoa", "hoa."),
                            ("hôm", "Hôm"),
                            ("nay", "nay"),
                            ("trời", "trời"),
                            ("nắng", "nắng"),
                            ("đẹp", "đẹp!"),
                        ],
                    )
                ]
            )
        )
        svc = TtsAudioCacheService(None)
        svc.repo = fake_repo  # type: ignore[assignment]

        # Multi-word extracted Sentence Shooter sentences from a multi-sentence verified page MUST pass
        self.assertTrue(
            await svc._is_catalog_text_allowlisted(
                book_id=book_id,
                page_id=None,
                page_revision_id=None,
                normalized_text="Hai mươi mốt bông hoa.",
            )
        )
        self.assertTrue(
            await svc._is_catalog_text_allowlisted(
                book_id=book_id,
                page_id=None,
                page_revision_id=None,
                normalized_text="Hôm nay trời nắng đẹp!",
            )
        )
        # Arbitrary unverified text MUST still be rejected to prevent global CATALOG cache poisoning
        self.assertFalse(
            await svc._is_catalog_text_allowlisted(
                book_id=book_id,
                page_id=None,
                page_revision_id=None,
                normalized_text="Con tên là Minh ở Hà Nội.",
            )
        )


def test_resolve_local_voice_region_gender_does_not_misclassify_nam_names():
    from app.services.voice_orchestrator import _resolve_local_voice_region_gender

    assert _resolve_local_voice_region_gender("local_north_hoang_nam") == (
        "north",
        "female",
    )
    assert _resolve_local_voice_region_gender("local_north_thien_minh") == (
        "north",
        "male",
    )
    assert _resolve_local_voice_region_gender("local_south_thai_son") == (
        "south",
        "male",
    )
    assert _resolve_local_voice_region_gender("custom_mien_nam_voice") == (
        "south",
        "female",
    )


@pytest.mark.asyncio
async def test_elevenlabs_male_voice_never_silently_falls_back_to_female_default(monkeypatch):
    import httpx
    from app.providers.elevenlabs_voice_provider import (
        DEFAULT_VOICE_ID,
        ElevenLabsVoiceProvider,
        VoiceProviderError,
    )

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-el-key")
    monkeypatch.setenv("ELEVENLABS_MALE_VOICE_ID", "male-voice-id-123")
    called_urls: list[str] = []

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url: str, **kwargs):
            called_urls.append(url)
            return httpx.Response(status_code=404, json={"detail": {"status": "voice_not_found"}})

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    provider = ElevenLabsVoiceProvider()
    with pytest.raises(VoiceProviderError):
        await provider.synthesize(
            text="Thầy chào con",
            requested_voice_id="male-voice-id-123",
            speed=1.0,
            allow_default_fallback=False,
        )

    assert len(called_urls) == 1
    assert "male-voice-id-123" in called_urls[0]
    assert DEFAULT_VOICE_ID not in "".join(called_urls)


def test_voice_routes_lookup_voice_gender_recognizes_elevenlabs_male_env(monkeypatch):
    from app.api.routes.voice import lookup_voice_gender

    monkeypatch.setenv("ELEVENLABS_MALE_VOICE_ID", "male-env-voice")
    monkeypatch.setenv("ELEVENLABS_FEMALE_VOICE_ID", "female-env-voice")
    assert lookup_voice_gender("local_north_thien_minh") == "male"
    assert lookup_voice_gender("google_vi_vn_wavenet_b") == "male"
    assert lookup_voice_gender("male-env-voice") == "male"
    assert lookup_voice_gender("female-env-voice") == "female"
