"""Regression tests for all backend defects uncovered during the hosted system audit."""
from __future__ import annotations

import asyncio
import hashlib
import io
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI, Request, UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import internal_cron as internal_cron_route
from app.models.book import PageRevisionWord
from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository
from app.services.local_ocr_scan_service import LocalOcrScanService
from app.services.tts_audio_cache_service import (
    ResolvedCacheTarget,
    TtsAudioCacheService,
    canonical_tts_sha256,
    folded_catalog_tts_text,
)


class HostedAuditBackendRegressionTests(unittest.TestCase):
    def test_tts_cache_repository_orders_words_by_word_index_not_word_order(self):
        """DEF-H02: PageRevisionWord uses WordIndex (never non-existent WordOrder)."""
        self.assertTrue(hasattr(PageRevisionWord, "WordIndex"))
        self.assertFalse(hasattr(PageRevisionWord, "WordOrder"))

        rev_id = uuid4()
        rev_result = MagicMock()
        rev_result.all.return_value = [SimpleNamespace(Id=rev_id, VerifiedText="Con mèo nhỏ.")]
        word_result = MagicMock()
        word_result.all.return_value = [
            SimpleNamespace(PageRevisionId=rev_id, NormalizedText="con", Text="Con"),
            SimpleNamespace(PageRevisionId=rev_id, NormalizedText="mèo", Text="mèo"),
        ]
        db = MagicMock()
        db.execute = AsyncMock(side_effect=[rev_result, word_result])

        repo = TtsAudioCacheRepository(db)
        rows = asyncio.run(repo.get_verified_catalog_texts(book_id=uuid4(), page_id=uuid4()))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "Con mèo nhỏ.")
        self.assertEqual(rows[0][1], [("con", "Con"), ("mèo", "mèo")])

    def test_tts_cache_service_catalog_lookup_falls_back_to_folded_key(self):
        """DEF-H03: Catalog timed text with punctuation/casing hits folded legacy cache entries."""
        raw_text = "Buổi sáng của An."
        folded = folded_catalog_tts_text(raw_text)
        self.assertEqual(folded, "buổi sáng của an")
        folded_sha = canonical_tts_sha256(folded)

        fake_entry = SimpleNamespace(
            Id=uuid4(),
            ByteSize=128,
            StorageBucket="viread-tts-cache",
            StoragePath="catalog/test.mp3",
            AudioFormat="audio/mpeg",
            VoiceId="local_north_truc_ly",
            ModelVersion="vieneu-v3",
            DurationSeconds=1.5,
            WordTimingsJson=[{"index": 0, "start": 0.0, "end": 0.4}],
            Scope="CATALOG",
        )

        async def _fake_get_active_entry(**kwargs):
            if kwargs.get("content_sha256") == folded_sha:
                return fake_entry
            return None

        svc = TtsAudioCacheService(None)
        fake_db = MagicMock()
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()
        fake_repo = MagicMock()
        fake_repo.get_daily_usage = AsyncMock(return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0})
        fake_repo.get_active_entry = AsyncMock(side_effect=_fake_get_active_entry)
        fake_repo.record_hit = AsyncMock()
        fake_repo.record_miss = AsyncMock()
        svc.db = fake_db
        svc.repo = fake_repo

        target = ResolvedCacheTarget(
            scope="CATALOG",
            owner_parent_id=None,
            book_id=uuid4(),
            page_id=uuid4(),
            page_revision_id=None,
            can_store_on_miss=True,
        )
        mp3_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00" + (b"\x00" * 32)
        with patch("app.services.tts_audio_cache_service.download_object", return_value=mp3_bytes):
            hit = asyncio.run(
                svc.lookup_cached_audio(
                    target=target,
                    normalized_text=raw_text,
                    voice_id="local_north_truc_ly",
                    speed=0.9,
                )
            )
        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit.content, mp3_bytes)
        self.assertEqual(fake_repo.get_active_entry.await_count, 2)

    def test_local_ocr_scan_hashes_reencoded_clean_bytes_not_raw_jpeg(self):
        """DEF-H05: image_sha256 must match stored clean PNG bytes so remote OCR workers verify cleanly."""
        img = Image.new("RGB", (64, 48), color=(240, 240, 240))
        jpeg_buf = io.BytesIO()
        img.save(jpeg_buf, format="JPEG", quality=85)
        raw_jpeg = jpeg_buf.getvalue()
        raw_sha = hashlib.sha256(raw_jpeg).hexdigest()

        upload = UploadFile(filename="photo.jpg", file=io.BytesIO(raw_jpeg))
        svc = LocalOcrScanService(MagicMock())
        clean_bytes, returned_sha = asyncio.run(svc._validate_and_normalize_image(upload))

        self.assertEqual(returned_sha, hashlib.sha256(clean_bytes).hexdigest())
        self.assertNotEqual(returned_sha, raw_sha)

    def test_unhandled_500_includes_cors_headers_for_allowed_origin_only(self):
        """DEF-H02: HTTP 500 JSON responses must include CORS headers for allowed origins."""
        import app.sever as sever_mod

        allowed_origin = "https://viread-frontend.vercel.app"
        blocked_origin = "https://evil.example.com"

        req_ok = MagicMock(spec=Request)
        req_ok.headers = {"origin": allowed_origin}
        req_ok.method = "POST"
        req_ok.url = SimpleNamespace(path="/voice/text-to-speech")
        req_ok.scope = {}
        req_ok.state = SimpleNamespace(request_id="req-cors-ok")

        req_bad = MagicMock(spec=Request)
        req_bad.headers = {"origin": blocked_origin}
        req_bad.method = "POST"
        req_bad.url = SimpleNamespace(path="/voice/text-to-speech")
        req_bad.scope = {}
        req_bad.state = SimpleNamespace(request_id="req-cors-bad")

        with patch.object(sever_mod, "CORS_ALLOWED_ORIGINS", [allowed_origin]):
            res_ok = asyncio.run(sever_mod.unhandled_exception_handler(req_ok, RuntimeError("boom")))
            res_bad = asyncio.run(sever_mod.unhandled_exception_handler(req_bad, RuntimeError("boom")))

        self.assertEqual(res_ok.status_code, 500)
        self.assertEqual(res_ok.headers.get("access-control-allow-origin"), allowed_origin)
        self.assertEqual(res_ok.headers.get("access-control-allow-credentials"), "true")
        self.assertIn("X-Request-ID", res_ok.headers.get("access-control-expose-headers", ""))
        self.assertIsNone(res_bad.headers.get("access-control-allow-origin"))

    def test_timed_cache_hit_aligns_punctuation_only_tokens_and_rejects_word_mismatch(self):
        """Production catalog pages (#3, #10) with standalone '?' or '-' hit cache and align timings."""
        from app.services.voice_orchestrator import VoiceOrchestrator

        # Page #10 pattern: frontend sends standalone '?', cached entry omitted it (3 vs 4 tokens).
        words_p10 = ["1.", "Nghe", "?", "viết:"]
        raw_timings_p10 = [
            {"index": 0, "start": 0.0, "end": 0.3},
            {"index": 1, "start": 0.3, "end": 0.7},
            {"index": 2, "start": 0.7, "end": 1.1},
        ]
        aligned_p10 = VoiceOrchestrator._align_cached_word_timings(
            words=words_p10,
            raw_timings=raw_timings_p10,
            cached_text="1. nghe viết",
        )
        self.assertIsNotNone(aligned_p10)
        assert aligned_p10 is not None
        self.assertEqual(len(aligned_p10), 4)
        self.assertEqual([w.index for w in aligned_p10], [0, 1, 2, 3])
        self.assertEqual((aligned_p10[2].start, aligned_p10[2].end), (0.7, 0.7))
        self.assertEqual((aligned_p10[3].start, aligned_p10[3].end), (0.7, 1.1))

        # Page #3 pattern: frontend sends '?', cached NormalizedText had '-'.
        words_p3 = ["phi", "Mác", "?", "xít", "đã"]
        raw_timings_p3 = [
            {"index": 0, "start": 0.0, "end": 0.2},
            {"index": 1, "start": 0.2, "end": 0.5},
            {"index": 2, "start": 0.5, "end": 0.55},
            {"index": 3, "start": 0.55, "end": 0.9},
            {"index": 4, "start": 0.9, "end": 1.2},
        ]
        aligned_p3 = VoiceOrchestrator._align_cached_word_timings(
            words=words_p3,
            raw_timings=raw_timings_p3,
            cached_text="phi mác - xít đã",
        )
        self.assertIsNotNone(aligned_p3)
        assert aligned_p3 is not None
        self.assertEqual(len(aligned_p3), 5)

        # Page #3 folded page-level lookup when cached NormalizedText kept standalone '-'.
        page_id = uuid4()
        cached_entry = SimpleNamespace(
            Id=uuid4(),
            ByteSize=256,
            StorageBucket="viread-tts-cache",
            StoragePath="catalog/p3.mp3",
            AudioFormat="audio/mpeg",
            VoiceId="local_north_truc_ly",
            ModelVersion="vieneu-v3",
            DurationSeconds=1.2,
            WordTimingsJson=raw_timings_p3,
            Scope="CATALOG",
            NormalizedText="phi mác - xít đã",
        )
        svc = TtsAudioCacheService(None)
        fake_db = MagicMock()
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()
        fake_repo = MagicMock()
        fake_repo.get_daily_usage = AsyncMock(return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0})
        fake_repo.get_active_entry = AsyncMock(return_value=None)
        fake_repo.get_active_timed_entries_for_page = AsyncMock(return_value=[cached_entry])
        fake_repo.record_hit = AsyncMock()
        fake_repo.record_miss = AsyncMock()
        svc.db = fake_db
        svc.repo = fake_repo
        target = ResolvedCacheTarget(
            scope="CATALOG",
            owner_parent_id=None,
            book_id=uuid4(),
            page_id=page_id,
            page_revision_id=None,
            can_store_on_miss=True,
        )
        mp3_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00" + (b"\x00" * 32)
        with patch("app.services.tts_audio_cache_service.download_object", return_value=mp3_bytes):
            hit = asyncio.run(
                svc.lookup_cached_audio(
                    target=target,
                    normalized_text="phi Mác ? xít đã",
                    voice_id="local_north_truc_ly",
                    speed=1.0,
                )
            )
        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit.normalized_text, "phi mác - xít đã")

        # Genuinely different spoken words MUST be rejected.
        rejected = VoiceOrchestrator._align_cached_word_timings(
            words=["xin", "?", "chào", "khác"],
            raw_timings=raw_timings_p10,
            cached_text="xin chào bé",
        )
        self.assertIsNone(rejected)

    def test_health_runs_db_and_remote_ocr_probes_concurrently(self):
        """Render /health must run DB & remote OCR probes concurrently with >2.5s budget."""
        import time
        import app.sever as sever_mod

        async def _slow_db_probe(*, timeout: float = 6.0):
            self.assertGreaterEqual(timeout, 5.0)
            await asyncio.sleep(0.15)
            return {
                "ok": True,
                "dns_resolved": True,
                "ssl_enabled": True,
                "pool_class": "NullPool",
                "pooler_mode": "transaction",
                "latency_ms": 150,
            }

        async def _slow_remote_ocr():
            await asyncio.sleep(0.15)
            return {
                "ready": True,
                "engines": {"paddleocr": {"status": "OK", "detail_status": "loaded"}},
                "workers": [{"worker_id": "w1", "online": True}],
                "queue": {"pending": 0},
                "heartbeat_ttl_seconds": 45,
            }

        req = MagicMock(spec=Request)
        req.app = SimpleNamespace(state=SimpleNamespace(background_workers={}))

        t0 = time.perf_counter()
        with (
            patch.object(sever_mod, "is_remote_ocr_mode", return_value=True),
            patch.object(sever_mod, "probe_database_connection", side_effect=_slow_db_probe),
            patch.object(sever_mod, "collect_remote_ocr_health", side_effect=_slow_remote_ocr),
        ):
            payload = asyncio.run(sever_mod.get_health(req))
        elapsed = time.perf_counter() - t0
        self.assertLess(elapsed, 0.28)  # Concurrent (~0.15s), not sequential (~0.30s+)
        self.assertTrue(payload["ocr"]["ready"])
        self.assertEqual(payload["ocr"]["heartbeat_ttl_seconds"], 45)

    def test_voice_worker_skips_trailing_pad_for_short_isolated_words(self):
        """DEF-H07: voice_worker decode_stt_window_sync omits trailing pad on <1.2s clips."""
        import numpy as np
        from test_voice_internet_resilience import _load_voice_worker_module

        vw = _load_voice_worker_module()

        captured_lengths: list[int] = []

        class _FakeStream:
            def __init__(self):
                self.result = SimpleNamespace(text="trường", tokens=["trường"], timestamps=[0.1])

            def accept_waveform(self, _sr, arr):
                captured_lengths.append(len(arr))

        class _FakeRecognizer:
            def create_stream(self):
                return _FakeStream()

            def decode_stream(self, _stream):
                return None

        short_clip = np.full(int(16000 * 0.6), 0.05, dtype=np.float32)
        long_clip = np.full(int(16000 * 1.5), 0.05, dtype=np.float32)

        with (
            patch.object(vw.runtime, "stt_recognizer", _FakeRecognizer()),
            patch.object(vw, "preprocess_audio_for_stt", side_effect=lambda x: x),
        ):
            vw.decode_stt_window_sync(short_clip, lead_pad_s=0.1, trail_pad_s=0.35)
            vw.decode_stt_window_sync(long_clip, lead_pad_s=0.1, trail_pad_s=0.35)

        # Short clip: lead_pad only (0.1s + 0.6s = 11200); Long clip: lead + trail (0.1s + 1.5s + 0.35s = 31200)
        self.assertEqual(captured_lengths[0], int(16000 * 0.1) + len(short_clip))
        self.assertEqual(captured_lengths[1], int(16000 * 0.1) + len(long_clip) + int(16000 * 0.35))

    def test_internal_cron_dispatch_runs_remote_temp_cleanup_and_post_ocr_sweep(self):
        """DEF-H06: Cron dispatch sweeps expired temp submissions & post-OCR rows in remote mode."""
        app = FastAPI()
        app.include_router(internal_cron_route.router, prefix="/internal/cron")
        client = TestClient(app)
        valid_token = "viread-cron-secret-" + ("z" * 24)

        with (
            patch.dict(os.environ, {"VIREAD_CRON_DISPATCH_TOKEN": valid_token}, clear=False),
            patch.object(internal_cron_route, "process_due_reminders_once", new=AsyncMock(return_value=1)),
            patch.object(internal_cron_route, "process_due_alerts_once", new=AsyncMock(return_value=0)),
            patch.object(internal_cron_route, "is_remote_ocr_mode", return_value=True),
            patch.object(
                internal_cron_route.parent_book_submission_worker,
                "cleanup_expired_temp_submissions",
                new=AsyncMock(return_value=2),
            ) as cleanup_mock,
            patch.object(
                internal_cron_route.parent_book_submission_worker,
                "run_once",
                new=AsyncMock(side_effect=[True, False]),
            ) as sweep_mock,
        ):
            resp = client.post(
                "/internal/cron/dispatch",
                headers={"X-ViRead-Cron-Token": valid_token},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["temp_submissions_cleaned"], 2)
        self.assertEqual(body["post_ocr_swept"], 1)
        cleanup_mock.assert_awaited_once()
        self.assertEqual(sweep_mock.await_count, 2)

    def test_offline_tts_speed_fallback_serves_cached_1_0_when_worker_unconfigured(self):
        """Wi-Fi-only standalone mode: speed=0.9 falls back to cached speed=1.0 (incl. folded catalog word) when local worker is offline."""
        from app.api.routes import voice as voice_route
        from app.providers.local_voice_provider import LocalVoiceProvider, LocalVoiceTechnicalError
        from app.services.voice_orchestrator import VoiceOrchestrator, VoicePolicyContext

        mp3_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00" + (b"\x00" * 64)
        book_id = uuid4()
        page_id = uuid4()

        target = ResolvedCacheTarget(
            scope="CATALOG",
            owner_parent_id=None,
            book_id=book_id,
            page_id=page_id,
            page_revision_id=None,
            can_store_on_miss=True,
        )
        folded_sha = canonical_tts_sha256("con mèo")
        cached_row_1_0 = SimpleNamespace(
            Id=uuid4(),
            ByteSize=len(mp3_bytes),
            StorageBucket="viread-tts-cache",
            StoragePath="catalog/test_1p00.mp3",
            AudioFormat="audio/mpeg",
            VoiceId="local_north_truc_ly",
            ModelVersion="vieneu-v3",
            DurationSeconds=1.6,
            WordTimingsJson=[
                {"index": 0, "start": 0.0, "end": 0.8},
                {"index": 1, "start": 0.8, "end": 1.6},
            ],
            Scope="CATALOG",
            Speed=1.0,
            NormalizedText="con mèo",
        )

        async def _fake_get_nearest(**kwargs):
            if kwargs.get("content_sha256") == folded_sha:
                return cached_row_1_0
            return None

        cache_svc = TtsAudioCacheService(None)
        fake_db = MagicMock()
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()
        fake_repo = MagicMock()
        fake_repo.get_daily_usage = AsyncMock(
            return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}
        )
        fake_repo.get_active_entry = AsyncMock(return_value=None)
        fake_repo.get_nearest_active_entry = AsyncMock(side_effect=_fake_get_nearest)
        fake_repo.get_active_timed_entries_for_page = AsyncMock(return_value=[])
        fake_repo.record_hit = AsyncMock()
        fake_repo.record_miss = AsyncMock()
        cache_svc.db = fake_db
        cache_svc.repo = fake_repo

        fake_local = MagicMock(spec=LocalVoiceProvider)
        fake_local.synthesize = AsyncMock(
            side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNCONFIGURED")
        )
        fake_local.synthesize_timed = AsyncMock(
            side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNCONFIGURED")
        )
        orch = VoiceOrchestrator(local_provider=fake_local)
        policy = VoicePolicyContext(book_id=book_id, page_id=str(page_id), cache_scope="CATALOG")

        with (
            patch.object(
                orch,
                "_resolve_cache_target",
                new=AsyncMock(return_value=(cache_svc, target)),
            ),
            patch(
                "app.services.tts_audio_cache_service.download_object",
                return_value=mp3_bytes,
            ),
        ):
            audio = asyncio.run(
                orch.synthesize(
                    text="Con mèo,",
                    requested_voice_id="local_north_truc_ly",
                    speed=0.9,
                    policy=policy,
                    db=object(),
                )
            )
            timed = asyncio.run(
                orch.synthesize_timed(
                    words=["Con", "mèo,"],
                    requested_voice_id="local_north_truc_ly",
                    speed=0.9,
                    policy=policy,
                    db=object(),
                )
            )

        self.assertTrue(audio.cache_hit)
        self.assertEqual(audio.provider, "precomputed_cache")
        self.assertFalse(audio.used_fallback_voice)
        self.assertEqual(audio.cached_speed, 1.0)
        self.assertEqual(voice_route._tts_cache_headers(audio)["X-TTS-Cache"], "HIT")
        self.assertEqual(voice_route._tts_cache_headers(audio)["X-TTS-Cached-Speed"], "1.00")

        self.assertTrue(timed.cache_hit)
        self.assertEqual(timed.provider, "precomputed_cache")
        self.assertEqual(timed.cached_speed, 1.0)
        self.assertEqual(timed.duration_seconds, 1.6)
        self.assertEqual(len(timed.words), 2)
        self.assertEqual(voice_route._tts_cache_headers(timed)["X-TTS-Cached-Speed"], "1.00")
        fake_local.synthesize.assert_not_awaited()
        fake_local.synthesize_timed.assert_not_awaited()

    def test_voice_voices_endpoint_fast_when_unconfigured_or_remote_worker_hangs(self):
        """GET /voice/voices must never hang when local worker is unconfigured or remote tunnel stalls."""
        import time
        from app.api.deps import require_active_profile_id
        from app.api.routes import voice as voice_route
        from app.api.routes import voice_studio as voice_studio_route
        from app.providers.local_voice_provider import LocalVoiceProvider, STATIC_LOCAL_VOICES

        app = FastAPI()
        app.include_router(voice_studio_route.router, prefix="/voice")
        actor_id = uuid4()
        app.dependency_overrides[require_active_profile_id] = lambda: actor_id
        client = TestClient(app)

        # Case 1: Standalone Render (unconfigured local worker) -> instant 200 with static voices
        voice_route.clear_default_voice_orchestrators()
        with patch.dict(
            os.environ,
            {"RENDER": "true", "VIREAD_LOCAL_VOICE_WORKER_URL": ""},
            clear=False,
        ):
            t0 = time.perf_counter()
            resp = client.get("/voice/voices")
            elapsed = time.perf_counter() - t0
        self.assertEqual(resp.status_code, 200)
        self.assertLess(elapsed, 0.5)
        body = resp.json()
        self.assertFalse(body["local_worker_ready"])
        self.assertEqual(len(body["voices"]), len(STATIC_LOCAL_VOICES))

        # Case 2: Remote worker hangs forever -> provider times out cleanly & negative-caches next call
        provider = LocalVoiceProvider(base_url="https://dead-worker.example.com")
        mock_client = MagicMock()

        async def _hang(*_args, **_kwargs):
            await asyncio.sleep(30.0)

        async def _timeout_wait_for(coro, *_args, **_kwargs):
            if hasattr(coro, "close"):
                coro.close()
            raise asyncio.TimeoutError

        mock_client.get = AsyncMock(side_effect=_hang)
        with (
            patch.object(provider, "_get_client", return_value=mock_client),
            patch("app.providers.local_voice_provider.asyncio.wait_for", side_effect=_timeout_wait_for),
        ):
            voices1, ready1 = asyncio.run(provider.list_voices())
            self.assertFalse(ready1)
            self.assertEqual(len(voices1), len(STATIC_LOCAL_VOICES))
            self.assertGreater(provider._remote_unavailable_until, time.monotonic())

            # Second call hits negative cache immediately without calling HTTP client again
            mock_client.get.reset_mock()
            t1 = time.perf_counter()
            voices2, ready2 = asyncio.run(provider.list_voices())
            elapsed2 = time.perf_counter() - t1
            self.assertFalse(ready2)
            self.assertEqual(len(voices2), len(STATIC_LOCAL_VOICES))
            self.assertLess(elapsed2, 0.05)
            mock_client.get.assert_not_called()

        # Case 3: Route-level hard timeout guard if orchestrator.list_voices itself hangs
        hanging_orch = MagicMock()
        hanging_orch.google = MagicMock()
        hanging_orch.google.is_tts_configured.return_value = False
        hanging_orch.list_voices = AsyncMock(side_effect=_hang)
        with (
            patch.object(voice_studio_route, "get_voice_orchestrator", return_value=hanging_orch),
            patch("app.api.routes.voice_studio.asyncio.wait_for", side_effect=_timeout_wait_for),
        ):
            resp_timeout = client.get("/voice/voices")
        self.assertEqual(resp_timeout.status_code, 200)
        self.assertFalse(resp_timeout.json()["local_worker_ready"])
        self.assertEqual(len(resp_timeout.json()["voices"]), len(STATIC_LOCAL_VOICES))
        voice_route.clear_default_voice_orchestrators()


if __name__ == "__main__":
    unittest.main()
