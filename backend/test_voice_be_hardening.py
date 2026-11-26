"""Comprehensive regression tests for Workstream D (Backend TTS/Cache/Normalizer/Worker + Backend STT)."""
from __future__ import annotations

import asyncio
import importlib.util
import os
from pathlib import Path
import struct
import sys
import tempfile
import unicodedata
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

BACKEND_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/viread_test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret-placeholder")

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import numpy as np
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_active_profile_id
from app.api.routes import voice as voice_route
from app.api.routes import voice_studio as voice_studio_route
from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.local_voice_provider import (
    DEFAULT_LOCAL_VOICE_ID,
    LOCAL_TTS_MODEL_VERSION,
    LocalPhonicsSpeech,
    LocalPhonicsStepTiming,
    LocalSynthesizedAudio,
    LocalTimedSpeech,
    LocalTimedWord,
    LocalTranscription,
    LocalVoiceProvider,
    LocalVoiceTechnicalError,
    fix_wav_header_sizes,
)
from app.services.difficult_words_service import DifficultWordsService
from app.services.reading_comparison_service import ReadingComparisonService
from app.services.text_alignment import align_text
from app.services.tts_audio_cache_service import (
    ALLOWED_COACHING_PHRASES,
    ALLOWED_COACHING_PHRASES_ALL_RAW,
    ALLOWED_COACHING_PHRASES_MALE_RAW,
    ResolvedCacheTarget,
    TtsAudioCacheService,
    adapt_coaching_phrase_for_male_persona,
    canonical_phonics_key,
    canonical_tts_sha256,
    is_coaching_text_allowlisted,
    preferred_cache_formats,
)
from app.services.vietnamese_tts_normalizer import (
    ensure_tts_terminal_punctuation,
    normalize_tokens_with_mapping,
    normalize_vietnamese_tts_text,
    project_chunk_spans_to_surface_words,
)
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    VoicePolicyContext,
    clear_voice_orchestrator_caches,
)


def _load_voice_worker_module():
    worker_path = Path(__file__).resolve().parents[1] / "scripts" / "windows" / "voice_worker.py"
    spec = importlib.util.spec_from_file_location("viread_voice_worker_testmod", worker_path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _make_fake_mp3(seed: bytes = b"abc") -> bytes:
    return b"ID3\x03\x00\x00\x00\x00\x00\x00" + seed * 32


def _make_fake_wav(pcm_len: int = 160, placeholder_header: bool = False) -> bytes:
    riff_size = 0x7FFFF000 + 36 if placeholder_header else 36 + pcm_len
    data_size = 0x7FFFF000 if placeholder_header else pcm_len
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        16000,
        32000,
        2,
        16,
        b"data",
        data_size,
    )
    return header + (b"\x01\x00" * (pcm_len // 2))


class TestTtsCacheConcurrencyFormatAndPrivacy(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_write_race_keeps_winner_storage_object_and_preserves_timings(self) -> None:
        fake_db = MagicMock(spec=AsyncSession)
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()
        svc = TtsAudioCacheService(fake_db)

        repo = MagicMock()
        repo.upsert_active_entry = AsyncMock(
            side_effect=IntegrityError("INSERT", {}, Exception("duplicate key uq_tts_cache_active_key"))
        )
        repo.has_active_entry_for_storage_path = AsyncMock(return_value=True)
        svc.repo = repo  # type: ignore[assignment]

        target = ResolvedCacheTarget(
            scope="CATALOG",
            owner_parent_id=None,
            book_id=uuid4(),
            page_id=uuid4(),
            page_revision_id=uuid4(),
            can_store_on_miss=True,
        )
        deleted_paths: list[str] = []
        with (
            patch("app.services.tts_audio_cache_service.upload_object") as mock_upload,
            patch(
                "app.services.tts_audio_cache_service.delete_object",
                side_effect=lambda path, bucket_name=None: deleted_paths.append(path),
            ),
        ):
            stored = await svc.store_cached_audio(
                target=target,
                normalized_text="Xin chào",
                voice_id=DEFAULT_LOCAL_VOICE_ID,
                model_version=LOCAL_TTS_MODEL_VERSION,
                speed=1.0,
                audio_bytes=_make_fake_mp3(),
                source_content_type="audio/mpeg",
            )

        self.assertTrue(stored)
        mock_upload.assert_called_once()
        # Winner's committed storage object must NOT be deleted on concurrent IntegrityError!
        self.assertEqual(deleted_paths, [])

    async def test_storage_location_isolates_model_versions_and_strict_wav_format(self) -> None:
        target = ResolvedCacheTarget(
            scope="CATALOG",
            owner_parent_id=None,
            book_id=uuid4(),
            page_id=uuid4(),
            page_revision_id=uuid4(),
            can_store_on_miss=True,
        )
        sha = canonical_tts_sha256("Con mèo")
        _, path_fp32 = TtsAudioCacheService.build_storage_location(
            target=target,
            content_sha256=sha,
            voice_id=DEFAULT_LOCAL_VOICE_ID,
            speed=1.0,
            audio_format="audio/mpeg",
            model_version="vieneu-v3-turbo-onnx-fp32-3.8.5",
        )
        _, path_hybrid = TtsAudioCacheService.build_storage_location(
            target=target,
            content_sha256=sha,
            voice_id=DEFAULT_LOCAL_VOICE_ID,
            speed=1.0,
            audio_format="audio/mpeg",
            model_version="vieneu-v3-turbo-onnx-hybrid-3.8.5",
        )
        self.assertNotEqual(path_fp32, path_hybrid)

        # Strict WAV request must NEVER fall back to audio/mpeg or audio/ogg!
        self.assertEqual(preferred_cache_formats(audio_format="wav"), ["audio/wav"])
        self.assertEqual(
            preferred_cache_formats(accept="audio/mpeg", audio_format="wav"),
            ["audio/wav"],
        )

    async def test_male_coaching_phrases_phonics_and_curved_quotes_allowlisted(self) -> None:
        self.assertGreater(len(ALLOWED_COACHING_PHRASES_MALE_RAW), 5)
        self.assertEqual(
            adapt_coaching_phrase_for_male_persona("Cô đọc mẫu cho con nhé."),
            "Thầy đọc mẫu cho con nhé.",
        )
        self.assertEqual(
            adapt_coaching_phrase_for_male_persona("Để cô đánh vần chậm giúp con nhé!"),
            "Để thầy đánh vần chậm giúp con nhé!",
        )
        # Must NOT corrupt unrelated words like "con"
        self.assertIn("Thầy đọc mẫu cho con nhé.", ALLOWED_COACHING_PHRASES)
        self.assertTrue(is_coaching_text_allowlisted("Thầy đọc mẫu cho con nhé."))
        self.assertTrue(is_coaching_text_allowlisted("Cô đọc mẫu cho con nhé."))
        self.assertFalse(is_coaching_text_allowlisted("Văn bản spam tùy ý không nằm trong danh sách"))

        # Phonics payload allowlisted for verified catalog book word and bounded coaching phonics
        steps = [
            {"id": "onset", "spoken_text": "mờ", "pause_after_ms": 380},
            {"id": "rime", "spoken_text": "èo", "pause_after_ms": 420},
            {"id": "blend", "spoken_text": "mèo", "pause_after_ms": 480},
        ]
        phonics_key, _ = canonical_phonics_key(steps)
        self.assertTrue(is_coaching_text_allowlisted(phonics_key))

        fake_db = MagicMock(spec=AsyncSession)
        svc = TtsAudioCacheService(fake_db)
        repo = MagicMock()
        repo.get_verified_catalog_texts = AsyncMock(
            return_value=[("“Mèo” ngủ ngoan.", [("mèo", "“Mèo”"), ("ngủ", "ngủ"), ("ngoan", "ngoan.")])]
        )
        svc.repo = repo  # type: ignore[assignment]
        book_id = uuid4()
        self.assertTrue(
            await svc._is_catalog_text_allowlisted(
                book_id=book_id,
                page_id=None,
                page_revision_id=None,
                normalized_text="mèo",
            )
        )
        self.assertTrue(
            await svc._is_catalog_text_allowlisted(
                book_id=book_id,
                page_id=None,
                page_revision_id=None,
                normalized_text=phonics_key,
            )
        )
        # Unverified book word phonics must still be rejected in CATALOG scope
        other_phonics, _ = canonical_phonics_key(
            [{"id": "blend", "spoken_text": "khủng long", "pause_after_ms": 400}]
        )
        self.assertFalse(
            await svc._is_catalog_text_allowlisted(
                book_id=book_id,
                page_id=None,
                page_revision_id=None,
                normalized_text=other_phonics,
            )
        )

    async def test_invariant_48_private_isolation_across_tts_timed_phonics_and_no_store_headers(self) -> None:
        from test_zero_cost_phase2_backend import _InMemoryTtsRepo

        clear_voice_orchestrator_caches()
        parent_a, parent_b = uuid4(), uuid4()
        priv_book, priv_page, priv_rev = uuid4(), uuid4(), uuid4()

        repo = _InMemoryTtsRepo(
            books={
                priv_book: {
                    "book_id": priv_book,
                    "visibility_scope": "PARENT_PRIVATE",
                    "owner_parent_id": parent_a,
                    "lifecycle_status": "ACTIVE",
                    "moderation_status": "ACTIVE",
                    "is_deleted": False,
                }
            },
            pages={
                priv_page: {
                    "page_id": priv_page,
                    "book_id": priv_book,
                    "page_lifecycle_status": "ACTIVE",
                    "visibility_scope": "PARENT_PRIVATE",
                    "owner_parent_id": parent_a,
                    "lifecycle_status": "ACTIVE",
                    "moderation_status": "ACTIVE",
                    "is_deleted": False,
                }
            },
            revisions={
                priv_rev: {
                    "revision_id": priv_rev,
                    "page_id": priv_page,
                    "book_id": priv_book,
                    "page_lifecycle_status": "ACTIVE",
                    "visibility_scope": "PARENT_PRIVATE",
                    "owner_parent_id": parent_a,
                    "lifecycle_status": "ACTIVE",
                    "moderation_status": "ACTIVE",
                    "is_deleted": False,
                }
            },
        )
        blobs: dict[tuple[str, str], bytes] = {}
        fake_db = MagicMock(spec=AsyncSession)
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()

        def _upload(path: str, data: bytes, content_type: str, bucket_name: str | None = None, upsert: bool = True) -> None:
            blobs[(bucket_name or "", path)] = data

        def _download(path: str, bucket_name: str | None = None) -> bytes:
            key = (bucket_name or "", path)
            if key not in blobs:
                raise FileNotFoundError(path)
            return blobs[key]

        svc_seed = TtsAudioCacheService(fake_db)
        svc_seed.repo = repo  # type: ignore[assignment]
        priv_target = ResolvedCacheTarget(
            scope="PRIVATE",
            owner_parent_id=parent_a,
            book_id=priv_book,
            page_id=priv_page,
            page_revision_id=priv_rev,
            can_store_on_miss=True,
        )
        phonics_steps = [
            {"id": "onset", "spoken_text": "mờ", "pause_after_ms": 380},
            {"id": "blend", "spoken_text": "mèo", "pause_after_ms": 480},
        ]
        phonics_key, _ = canonical_phonics_key(phonics_steps)
        with (
            patch("app.services.tts_audio_cache_service.upload_object", side_effect=_upload),
            patch("app.services.tts_audio_cache_service.download_object", side_effect=_download),
            patch("app.services.tts_audio_cache_service.delete_object"),
        ):
            await svc_seed.store_cached_audio(
                target=priv_target,
                normalized_text="Con mèo nhỏ",
                voice_id=DEFAULT_LOCAL_VOICE_ID,
                model_version=LOCAL_TTS_MODEL_VERSION,
                speed=1.0,
                audio_bytes=_make_fake_mp3(b"priv"),
                source_content_type="audio/mpeg",
                duration_seconds=1.5,
                word_timings_json=[
                    {"index": 0, "start": 0.0, "end": 0.5},
                    {"index": 1, "start": 0.5, "end": 1.0},
                    {"index": 2, "start": 1.0, "end": 1.5},
                ],
            )
            await svc_seed.store_cached_audio(
                target=priv_target,
                normalized_text=phonics_key,
                voice_id=DEFAULT_LOCAL_VOICE_ID,
                model_version=LOCAL_TTS_MODEL_VERSION,
                speed=1.0,
                audio_bytes=_make_fake_mp3(b"pph"),
                source_content_type="audio/mpeg",
                duration_seconds=1.2,
                word_timings_json=[
                    {"id": "onset", "index": 0, "start": 0.0, "end": 0.4},
                    {"id": "blend", "index": 1, "start": 0.78, "end": 1.2},
                ],
            )

            # Verify storage paths live strictly under viread-private-books/private-books/{parent_a}/...
            for bkt, path in blobs:
                self.assertEqual(bkt, "viread-private-books")
                self.assertTrue(path.startswith(f"private-books/{parent_a}/{priv_book}/tts-cache/"))

            offline_local = MagicMock(spec=LocalVoiceProvider)
            offline_local._resolve_target_voice_id = LocalVoiceProvider._resolve_target_voice_id
            offline_local.synthesize = AsyncMock(side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE"))
            offline_local.synthesize_timed = AsyncMock(side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE"))
            offline_local.synthesize_phonics = AsyncMock(side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE"))
            orch = VoiceOrchestrator(local_provider=offline_local)

            def _make_svc(db_arg):
                s = TtsAudioCacheService(db_arg)
                s.repo = repo  # type: ignore[assignment]
                return s

            app = FastAPI()
            app.include_router(voice_route.router, prefix="/voice")
            app.include_router(voice_studio_route.router, prefix="/voice")
            current_actor = {"id": parent_a}
            app.dependency_overrides[require_active_profile_id] = lambda: current_actor["id"]
            app.dependency_overrides[get_db] = lambda: fake_db

            with (
                patch("app.api.routes.voice.get_voice_orchestrator", return_value=orch),
                patch("app.api.routes.voice_studio.get_voice_orchestrator", return_value=orch),
                patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc),
            ):
                client = TestClient(app)

                # Family A hits across /tts, /timed, /phonics with private, no-store
                r_tts_a = client.post(
                    "/voice/text-to-speech",
                    json={"text": "Con mèo nhỏ", "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(priv_book), "page_id": str(priv_page)},
                )
                self.assertEqual(r_tts_a.status_code, 200)
                self.assertEqual(r_tts_a.headers.get("Cache-Control"), "private, no-store")
                self.assertEqual(r_tts_a.headers.get("X-TTS-Scope"), "PRIVATE")

                r_timed_a = client.post(
                    "/voice/text-to-speech/timed",
                    json={"words": ["Con", "mèo", "nhỏ"], "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(priv_book), "page_id": str(priv_page)},
                )
                self.assertEqual(r_timed_a.status_code, 200)
                self.assertEqual(r_timed_a.headers.get("Cache-Control"), "private, no-store")

                r_phon_a = client.post(
                    "/voice/text-to-speech/phonics",
                    json={"steps": phonics_steps, "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(priv_book), "page_id": str(priv_page)},
                )
                self.assertEqual(r_phon_a.status_code, 200)
                self.assertEqual(r_phon_a.headers.get("Cache-Control"), "private, no-store")

                # Family B MUST receive 404 on ALL 3 endpoints for Family A's private book
                current_actor["id"] = parent_b
                for ep, body in (
                    ("/voice/text-to-speech", {"text": "Con mèo nhỏ", "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(priv_book), "page_id": str(priv_page)}),
                    ("/voice/text-to-speech/timed", {"words": ["Con", "mèo", "nhỏ"], "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(priv_book), "page_id": str(priv_page)}),
                    ("/voice/text-to-speech/phonics", {"steps": phonics_steps, "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(priv_book), "page_id": str(priv_page)}),
                ):
                    r_b = client.post(ep, json=body)
                    self.assertEqual(r_b.status_code, 404, f"Expected 404 on {ep} for cross-family access")

    async def test_voice_studio_layering_and_precompute_male_coaching_and_phonics(self) -> None:
        # BACKEND_FLOW_STANDARD: voice_studio.py must NOT import TtsAudioCacheRepository directly
        src = (
            Path(__file__).resolve().parent / "app" / "api" / "routes" / "voice_studio.py"
        ).read_text(encoding="utf-8")
        self.assertNotIn("TtsAudioCacheRepository", src)

        from scripts import precompute_book_tts_cache as precompute

        self.assertIn("Thầy đọc mẫu cho con nhé.", precompute.COACHING_PHRASES)
        self.assertIn("Cô đọc mẫu cho con nhé.", precompute.COACHING_PHRASES)
        self.assertGreater(len(precompute.COACHING_PHRASES), len(ALLOWED_COACHING_PHRASES_ALL_RAW) - 1)

        book_id, page_id, rev_id = uuid4(), uuid4(), uuid4()
        sample_pages = [
            {
                "scope": "CATALOG",
                "owner_parent_id": None,
                "book_id": book_id,
                "page_id": page_id,
                "page_revision_id": rev_id,
                "verified_text": "Con mèo",
                "text": "Con mèo",
                "tokens": ["con", "mèo"],
            }
        ]
        with (
            patch.object(precompute, "_current_cache_bytes", new=AsyncMock(return_value=0)),
            patch.object(precompute, "_collect_page_targets", new=AsyncMock(return_value=sample_pages)),
            patch.object(precompute, "_load_existing_cache_keys", new=AsyncMock(return_value={})),
        ):
            stats = await precompute.run_precompute(
                scope="catalog",
                dry_run=True,
                include_words=True,
                include_coaching=False,
                include_phonics=True,
            )
            # 1 page + 2 words + 2 phonics lessons = 5
            self.assertEqual(stats["planned"], 5)


class TestVietnameseNormalizerAndTimingProjection(unittest.TestCase):
    def test_normalizer_edge_case_corpus(self) -> None:
        # Dates, percents, fractions, thousands, decimals, ordinals
        self.assertIn(
            "ngày mười hai tháng năm năm hai nghìn không trăm hai mươi sáu",
            normalize_vietnamese_tts_text("Hôm nay là 12/5/2026."),
        )
        self.assertIn("hai mươi lăm phần trăm", normalize_vietnamese_tts_text("Giảm 25% hôm nay."))
        self.assertIn("một phần hai", normalize_vietnamese_tts_text("Ăn 1/2 quả táo."))
        self.assertIn("một nghìn năm trăm", normalize_vietnamese_tts_text("Có 1.500 học sinh."))
        self.assertIn("ba phẩy năm", normalize_vietnamese_tts_text("Điểm 3,5 là thấp."))
        self.assertIn("thứ nhất", normalize_vietnamese_tts_text("Bạn đứng thứ 1 và thứ 4."))
        self.assertIn("thứ tư", normalize_vietnamese_tts_text("Bạn đứng thứ 1 và thứ 4."))

        # Hyphenated words, heavy punctuation, markdown/OCR markup, quiz labels
        self.assertEqual(normalize_vietnamese_tts_text("ba-lô Hà-Nội"), "ba lô Hà Nội")
        self.assertEqual(
            normalize_vietnamese_tts_text("Đáp án B: Quyển sách."),
            "Đáp án bê, Quyển sách.",
        )
        self.assertIn("chỗ trống", normalize_vietnamese_tts_text('Con điền "…" vào ô nhé.'))
        cleaned_markup = normalize_vietnamese_tts_text("— **Xin chào!!!** [A] → B nam/nữ")
        for forbidden in ("*", "[", "]", "→", "!!!", "—"):
            self.assertNotIn(forbidden, cleaned_markup)
        self.assertIn("sang", cleaned_markup)
        self.assertIn("hoặc", cleaned_markup)

        # Phonics single-char fixes
        self.assertEqual(normalize_vietnamese_tts_text("ă", for_phonics_step=True), "á")
        self.assertEqual(normalize_vietnamese_tts_text("â", for_phonics_step=True), "ớ")
        self.assertEqual(normalize_vietnamese_tts_text("đ", for_phonics_step=True), "đờ")
        self.assertEqual(normalize_vietnamese_tts_text("b", for_phonics_step=True), "bờ")

        # Curly quotes stripped cleanly in normalized speech; trailing-quote period guard preserved
        self.assertEqual(normalize_vietnamese_tts_text("“Xin chào!”"), "Xin chào!")
        self.assertEqual(normalize_vietnamese_tts_text("‘Tạm biệt!’"), "Tạm biệt!")
        self.assertEqual(ensure_tts_terminal_punctuation("“Xin chào!”"), "“Xin chào!”")
        self.assertEqual(ensure_tts_terminal_punctuation("Xin chào"), "Xin chào.")

    def test_project_chunk_spans_preserves_inter_chunk_pauses_under_token_expansion(self) -> None:
        surface = ["Ngày", "12/5/2026,", "ba-lô", "giảm", "25%."]
        mapping = normalize_tokens_with_mapping(surface)
        self.assertGreater(len(mapping.normalized_tokens), len(surface))

        # Two synthesized chunks with an explicit 0.60s inter-chunk silence pause [1.20 .. 1.80]
        c1_text = normalize_vietnamese_tts_text("Ngày 12/5/2026,")
        c2_text = normalize_vietnamese_tts_text("ba-lô giảm 25%.")
        projected = project_chunk_spans_to_surface_words(
            surface,
            [(c1_text, 0.10, 1.20), (c2_text, 1.80, 3.10)],
            duration_seconds=3.30,
        )
        self.assertEqual(len(projected), len(surface))
        prev_end = 0.0
        for item in projected:
            self.assertGreaterEqual(item["start"], prev_end)
            self.assertGreaterEqual(item["end"], item["start"])
            self.assertLessEqual(item["end"], 3.30)
            prev_end = item["end"]
        # Inter-chunk silence gap (1.20 -> 1.80) MUST be preserved between word 1 ("12/5/2026,") and word 2 ("ba-lô")!
        self.assertLessEqual(projected[1]["end"], 1.21)
        self.assertGreaterEqual(projected[2]["start"], 1.79)


class TestVoiceWorkerHardeningAndClientVad(unittest.IsolatedAsyncioTestCase):
    def test_runtime_engine_init_hybrid_routing_and_monotonic_speed(self) -> None:
        vw = _load_voice_worker_module()
        rt = vw.VoiceRuntimeEngine()
        # No AttributeError for word_fp32_tts_engine
        self.assertIsNone(rt.word_fp32_tts_engine)

        fp32_mock = MagicMock(name="fp32")
        int8_mock = MagicMock(name="int8")
        rt.tts_engine_fp32 = fp32_mock
        rt.tts_engine_int8 = int8_mock
        rt.tts_engine = fp32_mock

        with patch.object(vw, "TTS_PRECISION", "hybrid"):
            eng_word, prec_word = rt.select_tts_engine(word_sample=True, word_count=1)
            self.assertIs(eng_word, fp32_mock)
            self.assertEqual(prec_word, "fp32")

            eng_phon, prec_phon = rt.select_tts_engine(is_phonics=True, word_count=3)
            self.assertIs(eng_phon, fp32_mock)
            self.assertEqual(prec_phon, "fp32")

            eng_sent, prec_sent = rt.select_tts_engine(word_sample=False, word_count=12)
            self.assertIs(eng_sent, int8_mock)
            self.assertEqual(prec_sent, "int8")

        # Monotonic speed durations across 0.70, 0.85, 1.00, 1.20 even with stochastic TTS engine
        rng = np.random.default_rng(42)

        class _StochasticEngine:
            sample_rate = 24000

            def infer(self, *args, **kwargs):
                # Deliberately vary length if called multiple times — deterministic base cache must avoid drift!
                length = int(24000 * float(rng.uniform(0.6, 1.4)))
                t = np.linspace(0, 1, length, dtype=np.float32)
                return 0.25 * np.sin(2 * np.pi * 220 * t).astype(np.float32)

        preset = vw.VOICE_BY_ID[vw.DEFAULT_VOICE_ID]
        vw.clear_base_wav_cache()
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.object(vw, "TTS_CACHE_DIR", Path(tmpdir)), patch.object(vw.runtime, "stt_recognizer", None):
                eng = _StochasticEngine()
                durs = []
                for spd in (0.70, 0.85, 1.00, 1.20):
                    wav_bytes, dur = vw.synthesize_single_utterance_sync(
                        eng, "Con mèo nhỏ ngồi trên thảm.", preset, spd, False
                    )
                    self.assertTrue(wav_bytes.startswith(b"RIFF"))
                    durs.append(dur)
        self.assertGreater(durs[0], durs[1])
        self.assertGreater(durs[1], durs[2])
        self.assertGreater(durs[2], durs[3])

    def test_voiced_duration_pad_gate_and_sustained_clipping(self) -> None:
        vw = _load_voice_worker_module()

        # 0.45s silence pre-roll + 0.60s speech + 0.20s silence tail = 1.25s total, only 0.60s voiced
        sr = 16000
        pre = np.zeros(int(sr * 0.45), dtype=np.float32)
        t = np.linspace(0, 0.60, int(sr * 0.60), dtype=np.float32)
        speech = (0.15 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
        tail = np.zeros(int(sr * 0.20), dtype=np.float32)
        clip = np.concatenate([pre, speech, tail])
        voiced_s = vw.estimate_voiced_duration_s(clip, sample_rate=sr)
        self.assertLess(voiced_s, 0.8)

        captured_lengths: list[int] = []

        class _FakeStream:
            def accept_waveform(self, rate: int, samples: np.ndarray) -> None:
                captured_lengths.append(int(samples.size))

            @property
            def result(self):
                return MagicMock(text="trường", tokens=["trường"], timestamps=[0.45])

        fake_rec = MagicMock()
        fake_rec.create_stream.side_effect = _FakeStream
        with patch.object(vw.runtime, "stt_recognizer", fake_rec):
            vw.decode_stt_window_sync(clip, lead_pad_s=0.20, trail_pad_s=0.35)
        # No trailing pad applied for 0.60s voiced word despite 1.25s total length!
        expected_no_trail = int(sr * 0.20) + clip.size
        self.assertEqual(captured_lengths[-1], expected_no_trail)

        # Single-sample plosive pop (2 samples at 0.999) must NOT flag CLIPPING!
        sess = vw._WsSttSession()
        sess.vad_mode = "client"
        chunk = (0.08 * np.sin(2 * np.pi * 250 * np.linspace(0, 0.2, 3200, dtype=np.float32))).astype(np.float32)
        chunk[500] = 0.999
        chunk[501] = -0.999
        sess.push_pcm16k(chunk)
        self.assertEqual(sess._build_quality()["status"], "OK")

        # Sustained clipping (>= 5% samples at 1.0) MUST flag CLIPPING
        sess2 = vw._WsSttSession()
        sess2.vad_mode = "client"
        bad_chunk = np.full(3200, 0.995, dtype=np.float32)
        sess2.push_pcm16k(bad_chunk)
        sess2.push_pcm16k(bad_chunk)
        self.assertEqual(sess2._build_quality()["status"], "CLIPPING")

    def test_ws_client_vad_mode_disables_420ms_autoflush_and_acks_empty_flush(self) -> None:
        vw = _load_voice_worker_module()
        sess = vw._WsSttSession()
        sess.vad_mode = "client"
        sess.session_id = "s1"
        sess.turn_id = "t1"

        # 200ms voiced + 600ms silence (> 420ms server threshold) -> must NOT auto-flush in client VAD mode!
        t = np.linspace(0, 0.2, 3200, dtype=np.float32)
        voiced = (0.12 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
        silence = np.zeros(1600, dtype=np.float32)
        sess.push_pcm16k(voiced)
        for _ in range(6):
            sess.push_pcm16k(silence)
        self.assertEqual(len(sess.pending_flushes), 0)
        self.assertTrue(sess.in_speech)

        # Explicit flush with emit_empty_ack even when NOT in_speech MUST enqueue an empty ack job!
        sess.reset_segment()
        self.assertFalse(sess.in_speech)
        sess.enqueue_flush(carry_tail=False, turn_id_override="turn-ack-99", emit_empty_ack=True)
        self.assertEqual(len(sess.pending_flushes), 1)
        self.assertEqual(sess.pending_flushes[0].turn_id, "turn-ack-99")
        self.assertEqual(sess.pending_flushes[0].audio_window.size, 0)

        # Full WebSocket /stt/stream test: client sends start(vad_mode="client") then flush without audio -> gets final ack with words=[]
        with (
            patch.object(vw.runtime, "ensure_loaded", new=AsyncMock()),
            patch.object(vw, "_expected_voice_token", return_value=""),
        ):
            client = TestClient(vw.app)
            with client.websocket_connect("/stt/stream") as ws:
                ws.send_json({"type": "start", "session_id": "s1", "page_id": "p1", "turn_id": "t1", "vad_mode": "client"})
                ready = ws.receive_json()
                self.assertEqual(ready["type"], "ready")
                self.assertEqual(ready["vad_mode"], "client")

                ws.send_json({"type": "flush", "turn_id": "t1", "next_turn_id": "t2"})
                final_ack = ws.receive_json()
                self.assertEqual(final_ack["type"], "final")
                self.assertEqual(final_ack["turn_id"], "t1")
                self.assertEqual(final_ack["words"], [])
                ws.send_json({"type": "stop"})


class TestSessionVoiceLockAndBackendSttParity(unittest.IsolatedAsyncioTestCase):
    async def test_session_voice_lock_rejects_mid_session_google_override_and_tracks_central_backup(self) -> None:
        clear_voice_orchestrator_caches()
        local = MagicMock(spec=LocalVoiceProvider)
        local._resolve_target_voice_id = LocalVoiceProvider._resolve_target_voice_id
        local.synthesize = AsyncMock(
            return_value=LocalSynthesizedAudio(
                content=_make_fake_wav(),
                content_type="audio/wav",
                resolved_voice_id="local_north_truc_ly",
                region="north",
                model_version=LOCAL_TTS_MODEL_VERSION,
            )
        )
        google = MagicMock()
        google.is_tts_configured.return_value = True
        google.is_tts_in_cooldown.return_value = False
        google.synthesize = AsyncMock(
            return_value=LocalSynthesizedAudio(
                content=_make_fake_wav(),
                content_type="audio/wav",
                resolved_voice_id="google_vi_vn_neural2_a",
                region="north",
                model_version="google-neural2",
                provider="google",
            )
        )
        orch = VoiceOrchestrator(local_provider=local, google_provider=google)
        sid = str(uuid4())
        actor = uuid4()

        # First turn locks session to local_north_truc_ly
        first = await orch.synthesize(
            text="Xin chào",
            requested_voice_id="local_north_truc_ly",
            policy=VoicePolicyContext(
                provider_mode="local_with_google_fallback",
                allow_google_tts=True,
                session_id=sid,
                actor_id=actor,
            ),
        )
        self.assertEqual(first.resolved_voice_id, "local_north_truc_ly")

        # Mid-session explicit retry with google_vi_vn_neural2_a MUST be rejected (409 SESSION_VOICE_LOCKED)
        with self.assertRaises(VoiceProviderError) as err:
            await orch.synthesize(
                text="Xin chào",
                requested_voice_id="google_vi_vn_neural2_a",
                policy=VoicePolicyContext(
                    provider_mode="local_with_google_fallback",
                    allow_google_tts=True,
                    session_id=sid,
                    actor_id=actor,
                ),
            )
        self.assertEqual(err.exception.status_code, 409)
        self.assertEqual(err.exception.code, "SESSION_VOICE_LOCKED")
        google.synthesize.assert_not_awaited()

        # Unlocked Central fallback (session_id=None) transparently tags central_mapped_to_north_google
        local.synthesize = AsyncMock(
            side_effect=LocalVoiceTechnicalError(503, "LOCAL_TTS_UNAVAILABLE")
        )
        fallback = await orch.synthesize(
            text="Xin chào",
            requested_voice_id="local_central_ngoc_tran",
            policy=VoicePolicyContext(
                provider_mode="local_with_google_fallback",
                allow_google_tts=True,
                session_id=None,
            ),
        )
        self.assertTrue(fallback.used_fallback_voice)
        self.assertEqual(fallback.fallback_reason, "central_mapped_to_north_google")

    async def test_cached_word_timings_clamped_and_superseded_stt_not_cached(self) -> None:
        clear_voice_orchestrator_caches()
        # Out-of-bounds timings & zero duration must be safely clamped / rejected without 500
        clamped = VoiceOrchestrator._align_cached_word_timings(
            words=["Xin", "chào"],
            raw_timings=[
                {"index": 0, "start": 0.0, "end": 0.8},
                {"index": 1, "start": 0.7, "end": 1.45},
            ],
            duration_seconds=1.20,
        )
        self.assertIsNotNone(clamped)
        assert clamped is not None
        self.assertLessEqual(clamped[1].end, 1.20)
        self.assertGreaterEqual(clamped[1].start, clamped[0].end)

        zero_bad = VoiceOrchestrator._align_cached_word_timings(
            words=["Xin"],
            raw_timings=[{"index": 0, "start": 0.0, "end": 0.0}],
            duration_seconds=0.0,
        )
        self.assertIsNone(zero_bad)

        # Superseded empty STT result must NOT be cached in _turn_results
        local = MagicMock(spec=LocalVoiceProvider)
        local.transcribe = AsyncMock(
            side_effect=[
                LocalTranscription(
                    text="",
                    language_code="vi",
                    language_probability=None,
                    words=None,
                    superseded=True,
                ),
                LocalTranscription(
                    text="con mèo",
                    language_code="vi",
                    language_probability=None,
                    words=None,
                    superseded=False,
                ),
            ]
        )
        orch = VoiceOrchestrator(local_provider=local)
        policy = VoicePolicyContext(session_id="s-sup", page_id="p1", turn_id="t-sup")
        r1 = await orch.transcribe(audio=b"abc", filename="a.wav", content_type="audio/wav", policy=policy)
        self.assertTrue(r1.superseded)
        r2 = await orch.transcribe(audio=b"abc", filename="a.wav", content_type="audio/wav", policy=policy)
        self.assertEqual(r2.text, "con mèo")
        self.assertEqual(local.transcribe.await_count, 2)

    async def test_local_provider_retry_cap_wav_header_fix_and_nfc_output(self) -> None:
        broken_wav = _make_fake_wav(pcm_len=160, placeholder_header=True)
        fixed = fix_wav_header_sizes(broken_wav)
        self.assertEqual(struct.unpack_from("<I", fixed, 4)[0], len(fixed) - 8)
        self.assertEqual(struct.unpack_from("<I", fixed, 40)[0], len(fixed) - 44)

        provider = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        nfd_word = unicodedata.normalize("NFD", "tiếng Việt")
        call_count = 0

        async def _post_timeout(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            raise httpx.ReadTimeout("slow")

        fake_client = MagicMock()
        fake_client.post = AsyncMock(side_effect=_post_timeout)
        with patch.object(provider, "_get_client", return_value=fake_client):
            with self.assertRaises(LocalVoiceTechnicalError):
                await provider.transcribe(audio=b"wav", filename="a.wav", content_type="audio/wav")
        # Max 1 retry => 2 total attempts!
        self.assertEqual(call_count, 2)

        ok_resp = MagicMock()
        ok_resp.status_code = 200
        ok_resp.json.return_value = {
            "text": nfd_word,
            "language_code": "vi",
            "words": [{"text": nfd_word, "start": 0.0, "end": 0.5}],
            "superseded": False,
        }
        fake_client.post = AsyncMock(return_value=ok_resp)
        with patch.object(provider, "_get_client", return_value=fake_client):
            tx = await provider.transcribe(audio=b"wav", filename="a.wav", content_type="audio/wav")
        self.assertTrue(unicodedata.is_normalized("NFC", tx.text))
        assert tx.words is not None
        self.assertTrue(unicodedata.is_normalized("NFC", tx.words[0]["text"]))

    async def test_text_alignment_numerals_nfc_comparison_and_wasm_difficult_word(self) -> None:
        # 0..10 numeral <-> Vietnamese word parity
        res = align_text("Tôi có 0 quả cam, 2 con mèo và 10 bông hoa.", "tôi có không quả cam hai con mèo và mười bông hoa")
        self.assertEqual(res["distance"], 0)
        self.assertTrue(all(item["status"] == "MATCH" for item in res["alignment"]))

        # ReadingComparisonService NFD vs NFC idempotency
        from types import SimpleNamespace
        from app.schemas.reading import CompareReadingRequest

        fake_db = MagicMock(spec=AsyncSession)
        svc = ReadingComparisonService(fake_db)
        session_id, actor_id, page_id, rev_id = uuid4(), uuid4(), uuid4(), uuid4()
        nfc_text = unicodedata.normalize("NFC", "Tiếng Việt")
        nfd_text = unicodedata.normalize("NFD", "Tiếng Việt")
        existing_row = SimpleNamespace(
            Id=uuid4(),
            SessionId=session_id,
            PageId=page_id,
            PageRevisionId=rev_id,
            Transcript=nfd_text,
            Distance=0,
            Alignment=[],
            Summary={"assessment_version": 1, "initial_assessment": None},
            CreatedAt="2026-11-26T00:00:00Z",
        )
        svc.content.get_page = AsyncMock(
            return_value=SimpleNamespace(page_id=page_id, page_revision_id=rev_id, text=nfc_text, words=[])
        )
        svc.repository.lock_session = AsyncMock(return_value=SimpleNamespace(State="IN_PROGRESS"))
        svc.repository.finalized_for_page = AsyncMock(return_value=existing_row)
        out = await svc.compare(
            session_id,
            actor_id,
            CompareReadingRequest(transcript=nfc_text, page_id=page_id, page_revision_id=rev_id),
        )
        self.assertEqual(out.report_id, existing_row.Id)

        # DifficultWordsService: offline voice worker + Browser WASM exact read (confidence=0) -> CORRECT!
        from test_difficult_words import ACTOR, CHILD_A, InMemoryPracticeRepo, make_access

        offline_voice = MagicMock()
        offline_voice.transcribe = AsyncMock(side_effect=VoiceProviderError(503, "LOCAL_STT_UNAVAILABLE"))
        dw_svc = DifficultWordsService(InMemoryPracticeRepo(), make_access(), voice_provider=offline_voice)
        res_wasm = await dw_svc.evaluate_word_direct(
            CHILD_A,
            ACTOR,
            request_id=uuid4(),
            normalized_word="mèo",
            audio_bytes=b"audio",
            filename="p.webm",
            content_type="audio/webm",
            audio_quality_status="AUDIO_TOO_SHORT",
            browser_transcript="mèo",
            browser_confidence=0.0,
        )
        self.assertEqual(res_wasm.assessment_status, "CORRECT")
        self.assertEqual(res_wasm.recognition_source, "BROWSER_SPEECH")

    async def test_synthesize_phonics_rejects_malformed_cached_timings_and_falls_through(self) -> None:
        from types import SimpleNamespace

        from app.services.voice_orchestrator import VoiceOrchestrator, VoicePolicyContext

        steps = [{"id": "step_1", "spokenText": "mèo", "pauseAfterMs": 200}]
        malformed_rows = [
            ["bad"],
            [{"start": None, "end": 0.4}],
            [{"start": float("nan"), "end": 0.4}],
            [{"end": 0.4}],
        ]

        for bad_timings in malformed_rows:
            self.assertIsNone(
                VoiceOrchestrator._parse_cached_phonics_timings(
                    steps=steps,
                    raw_timings=bad_timings,
                    duration_seconds=1.0,
                )
            )
            fake_hit = SimpleNamespace(
                scope="COACHING",
                resolved_voice_id=DEFAULT_LOCAL_VOICE_ID,
                model_version=LOCAL_TTS_MODEL_VERSION,
                content=b"cached-audio",
                content_type="audio/mpeg",
                duration_seconds=1.0,
                word_timings_json=bad_timings,
                cached_speed=1.0,
            )
            local = MagicMock()
            local.synthesize_phonics = AsyncMock(
                return_value=LocalPhonicsSpeech(
                    audio=b"fresh-wav",
                    content_type="audio/wav",
                    duration_seconds=0.8,
                    step_timings=[LocalPhonicsStepTiming(id="step_1", index=0, start=0.0, end=0.8)],
                    resolved_voice_id=DEFAULT_LOCAL_VOICE_ID,
                    region="north",
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    provider="local",
                )
            )
            orch = VoiceOrchestrator(local_provider=local)
            orch._resolve_and_lookup_cache = AsyncMock(return_value=(None, None, fake_hit))  # type: ignore[method-assign]
            res = await orch.synthesize_phonics(
                db=MagicMock(),
                steps=steps,
                requested_voice_id=DEFAULT_LOCAL_VOICE_ID,
                speed=1.0,
                policy=VoicePolicyContext(provider_mode="local_only"),
            )
            self.assertEqual(res.provider, "local")
            local.synthesize_phonics.assert_awaited_once()

    def test_align_cached_word_timings_handles_punctuation_mismatch(self) -> None:
        from app.services.voice_orchestrator import VoiceOrchestrator

        trailing_punct = VoiceOrchestrator._align_cached_word_timings(
            words=["Xin", "chào", "!"],
            raw_timings=[{"start": 0.0, "end": 0.4}, {"start": 0.4, "end": 0.9}],
            cached_text="Xin chào",
            duration_seconds=1.0,
        )
        self.assertEqual(
            trailing_punct,
            [
                LocalTimedWord(index=0, start=0.0, end=0.4),
                LocalTimedWord(index=1, start=0.4, end=0.9),
                LocalTimedWord(index=2, start=0.9, end=0.9),
            ],
        )

        medial_punct = VoiceOrchestrator._align_cached_word_timings(
            words=["mèo", ",", "chó"],
            raw_timings=[{"start": 0.1, "end": 0.4}, {"start": 0.5, "end": 0.8}],
            cached_text="mèo chó",
            duration_seconds=1.0,
        )
        self.assertEqual(
            medial_punct,
            [
                LocalTimedWord(index=0, start=0.1, end=0.4),
                LocalTimedWord(index=1, start=0.4, end=0.4),
                LocalTimedWord(index=2, start=0.5, end=0.8),
            ],
        )


if __name__ == "__main__":
    unittest.main()
