"""Regression coverage for RC security guards, cron dispatch, signed private URLs, and voice enhancements."""

from __future__ import annotations

import asyncio
import base64
import io
import os
import sys
import tempfile
import time
import unittest
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import (
    internal_cron as internal_cron_route,
    picture_description as picture_description_route,
    reading as reading_route,
    sentence_shooter as sentence_shooter_route,
    support as support_route,
    voice as voice_route,
    voice_studio as voice_studio_route,
)
from app.database.role_cache import invalidate_cached_role
from app.jobs import parent_book_submission_worker, reading_presence_alert_worker
from app.policies import book_access
from app.services.rate_limiter import clear_rate_limits, rate_limiter
from test_voice_internet_resilience import _load_voice_worker_module

ACTOR_ID = UUID("10000000-0000-4000-8000-000000000001")
OTHER_ACTOR_ID = UUID("20000000-0000-4000-8000-000000000002")
BOOK_ID = UUID("30000000-0000-4000-8000-000000000003")


class InternalCronDispatchAndWorkersTests(unittest.TestCase):
    def test_cron_dispatch_auth_and_execution(self):
        app = FastAPI()
        app.include_router(internal_cron_route.router, prefix="/internal/cron")
        client = TestClient(app)

        with patch.dict(os.environ, {"VIREAD_CRON_DISPATCH_TOKEN": "too-short"}, clear=False):
            res_unconfigured = client.post("/internal/cron/dispatch")
            self.assertEqual(res_unconfigured.status_code, 503)

        valid_token = "viread-cron-secret-" + ("x" * 24)
        with patch.dict(os.environ, {"VIREAD_CRON_DISPATCH_TOKEN": valid_token}, clear=False):
            missing = client.post("/internal/cron/dispatch")
            self.assertEqual(missing.status_code, 401)

            wrong = client.post(
                "/internal/cron/dispatch",
                headers={"X-ViRead-Cron-Token": "wrong-" + ("y" * 32)},
            )
            self.assertEqual(wrong.status_code, 401)

            with (
                patch.object(
                    internal_cron_route,
                    "process_due_reminders_once",
                    new=AsyncMock(return_value=3),
                ) as rem_mock,
                patch.object(
                    internal_cron_route,
                    "process_due_alerts_once",
                    new=AsyncMock(return_value=2),
                ) as alert_mock,
            ):
                ok = client.post(
                    "/internal/cron/dispatch",
                    headers={"X-ViRead-Cron-Token": valid_token},
                )
        self.assertEqual(ok.status_code, 200)
        body = ok.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["reminders_delivered"], 3)
        self.assertEqual(body["presence_alerts_delivered"], 2)
        rem_mock.assert_awaited_once()
        alert_mock.assert_awaited_once()

    def test_presence_alert_worker_once_uses_single_session_and_bounded_batch(self):
        from contextlib import asynccontextmanager

        session_entries = 0

        @asynccontextmanager
        async def _single_session():
            nonlocal session_entries
            session_entries += 1
            yield MagicMock()

        deliver_mock = AsyncMock(return_value=2)
        fake_service = MagicMock(deliver_due=deliver_mock)

        with (
            patch.object(
                reading_presence_alert_worker,
                "AsyncSessionLocal",
                side_effect=_single_session,
            ),
            patch.object(
                reading_presence_alert_worker,
                "ReadingPresenceRepository",
                return_value=MagicMock(),
            ),
            patch.object(
                reading_presence_alert_worker,
                "ReadingPresenceService",
                return_value=fake_service,
            ),
        ):
            delivered = asyncio.run(
                reading_presence_alert_worker.process_due_alerts_once()
            )
        self.assertEqual(delivered, 2)
        self.assertEqual(session_entries, 1, "Must open strictly 1 DB session (no advisory lock session)")
        self.assertEqual(deliver_mock.await_args.kwargs.get("batch"), 5)

        with (
            patch.object(reading_presence_alert_worker, "validate_worker_configuration"),
            patch.object(
                reading_presence_alert_worker,
                "process_due_alerts_once",
                new=AsyncMock(return_value=4),
            ) as run_once,
        ):
            result = asyncio.run(reading_presence_alert_worker.run_worker(once=True))
        self.assertEqual(result, 4)
        run_once.assert_awaited_once()

    def test_parent_book_submission_remote_mode_runs_stage2_sweeper_only(self):
        fake_sub = SimpleNamespace(
            Id=uuid4(),
            BookId=BOOK_ID,
            WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED",
        )
        fake_repo = MagicMock()
        fake_repo.claim_next_checking_submission = AsyncMock(return_value=fake_sub)
        fake_repo.commit = AsyncMock()
        fake_repo.rollback = AsyncMock()
        fake_session = MagicMock()
        fake_ctx = MagicMock()
        fake_ctx.__aenter__ = AsyncMock(return_value=fake_session)
        fake_ctx.__aexit__ = AsyncMock(return_value=False)

        before_modules = set(sys.modules)
        with (
            patch.object(parent_book_submission_worker, "is_remote_ocr_mode", return_value=True),
            patch.object(parent_book_submission_worker, "AsyncSessionLocal", return_value=fake_ctx),
            patch.object(
                parent_book_submission_worker,
                "ParentPrivateBookRepository",
                return_value=fake_repo,
            ),
            patch.object(
                parent_book_submission_worker,
                "run_parent_submission_post_ocr",
                new=AsyncMock(return_value=None),
            ) as post_ocr,
        ):
            processed = asyncio.run(
                parent_book_submission_worker.run_once(worker_id="w-1")
            )

        self.assertTrue(processed)
        fake_repo.claim_next_checking_submission.assert_awaited_once()
        self.assertTrue(
            fake_repo.claim_next_checking_submission.await_args.kwargs.get("only_post_ocr")
        )
        post_ocr.assert_awaited_once_with(fake_sub.Id)
        newly_loaded = set(sys.modules) - before_modules
        self.assertNotIn("torch", newly_loaded)
        self.assertNotIn("paddleocr", newly_loaded)

        # Also assert in a fresh Python interpreter that importing the worker
        # in remote_worker mode never loads heavy OCR/ML modules.
        import subprocess

        backend_dir = str(Path(__file__).resolve().parent)
        check_code = (
            "import os, sys; "
            f"sys.path.insert(0, {backend_dir!r}); "
            "os.environ['APP_ENVIRONMENT'] = 'test'; "
            "os.environ['VIREAD_OCR_MODE'] = 'remote_worker'; "
            "os.environ.setdefault('DATABASE_URL', 'postgresql+asyncpg://test:test@127.0.0.1:1/test'); "
            "os.environ.setdefault('SUPABASE_URL', 'https://example.supabase.co'); "
            "os.environ.setdefault('SUPABASE_KEY', 'isolated-test-key'); "
            "from app.jobs import parent_book_submission_worker; "
            "assert 'torch' not in sys.modules and 'paddleocr' not in sys.modules"
        )
        proc = subprocess.run(
            [sys.executable, "-c", check_code],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)


def _valid_camera_jpeg() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (20, 20), "white").save(buffer, format="JPEG")
    return buffer.getvalue()


class RateLimiterActiveAccountAndOpenApiTests(unittest.TestCase):
    def setUp(self):
        clear_rate_limits()
        invalidate_cached_role()

    def tearDown(self):
        clear_rate_limits()
        invalidate_cached_role()

    def test_openapi_has_zero_duplicate_operation_warnings(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            from app.sever import app

            schema = app.openapi()
        duplicates = [str(w.message) for w in caught if "Duplicate" in str(w.message)]
        self.assertEqual(duplicates, [])
        self.assertIn("/books/admin/catalog", schema["paths"])
        self.assertIn("/internal/cron/dispatch", schema["paths"])

    def test_voice_and_support_enforce_active_profile_db_check(self):
        inactive_db = MagicMock()
        inactive_db.scalar = AsyncMock(return_value=None)

        app = FastAPI()
        app.include_router(support_route.router, prefix="/support")
        app.include_router(voice_route.router, prefix="/voice")
        app.include_router(voice_studio_route.router, prefix="/voice")
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
        app.dependency_overrides[get_db] = lambda: inactive_db
        client = TestClient(app)

        res_support = client.post(
            "/support/feedback",
            json={
                "category": "technical_issue",
                "subject": "App crash",
                "message": "Crashed opening page 2",
                "contact_email": "parent@example.com",
            },
        )
        self.assertEqual(res_support.status_code, 403)

        res_voice_status = client.get("/voice/status")
        self.assertEqual(res_voice_status.status_code, 403)

        res_voices = client.get("/voice/voices")
        self.assertEqual(res_voices.status_code, 403)

        inactive_db.scalar = AsyncMock(return_value="parent")
        fake_orch = MagicMock(
            get_status=AsyncMock(return_value={"default_mode": "local_only", "local": {}, "google": {}})
        )
        with patch.object(voice_route, "get_voice_orchestrator", return_value=fake_orch):
            res_ok = client.get("/voice/status")
        self.assertEqual(res_ok.status_code, 200)

    def test_sliding_window_rate_limiter_enforced_across_target_routes(self):
        rate_limiter.set_override("support_feedback", 1, 60.0)
        rate_limiter.set_override("voice_status", 1, 60.0)
        rate_limiter.set_override("voice_tts", 1, 60.0)
        rate_limiter.set_override("reading_ocr", 1, 60.0)
        rate_limiter.set_override("reading_match", 1, 60.0)
        rate_limiter.set_override("games", 1, 60.0)

        active_db = MagicMock()
        active_db.scalar = AsyncMock(return_value="parent")
        active_db.execute = AsyncMock()
        app = FastAPI()
        app.include_router(support_route.router, prefix="/support")
        app.include_router(voice_route.router, prefix="/voice")
        app.include_router(reading_route.router, prefix="/reading")
        app.include_router(sentence_shooter_route.router, prefix="/games/sentence-shooter")
        app.include_router(picture_description_route.router, prefix="/games/picture-description")

        current_actor = {"id": ACTOR_ID}
        app.dependency_overrides[get_current_parent_id] = lambda: current_actor["id"]
        app.dependency_overrides[get_db] = lambda: active_db
        client = TestClient(app)

        fake_orch = MagicMock(
            get_status=AsyncMock(return_value={"default_mode": "local_only"}),
            synthesize=AsyncMock(
                return_value=SimpleNamespace(
                    content=b"RIFF0000WAVE",
                    content_type="audio/wav",
                    provider="local",
                    resolved_voice_id="local_north_truc_ly",
                    region="north",
                    model_version="v1",
                    used_fallback_voice=False,
                )
            ),
        )
        with (
            patch.object(voice_route, "get_voice_orchestrator", return_value=fake_orch),
            patch.object(
                support_route,
                "SupportService",
                return_value=MagicMock(submit_feedback=AsyncMock(return_value=None)),
            ),
            patch.object(
                reading_route,
                "LocalOcrScanService",
                return_value=MagicMock(scan_page=AsyncMock(return_value={
                    "scan_job_id": str(uuid4()),
                    "request_id": "req-1",
                    "idempotency_key": None,
                    "status": "SUCCEEDED",
                    "ocr_text": "a",
                    "word_count": 1,
                    "words": [],
                    "provenance": {
                        "engine": "local",
                        "device": "cpu",
                        "engine_statuses": {"paddleocr": "success"},
                        "cloud_ocr_used": False,
                        "elapsed_ms": 1,
                    },
                    "matched": False,
                    "matched_book_id": None,
                    "matched_book_title": None,
                    "match_confidence": 0.0,
                    "matched_page": None,
                    "message": "ok",
                })),
            ),
            patch.object(
                reading_route.HistoryService,
                "require_parent",
                new=AsyncMock(return_value=None),
            ),
            patch.object(
                reading_route.vision_page_matcher,
                "check_framing",
                return_value={"framing_valid": False, "status_code": "OUT_OF_FRAME", "message": "No book"},
            ),
            patch.object(
                sentence_shooter_route,
                "build_service",
                return_value=MagicMock(list_books=AsyncMock(return_value=[])),
            ),
            patch.object(
                picture_description_route,
                "_service",
                return_value=MagicMock(get_catalog=AsyncMock(return_value={"items": []})),
            ),
        ):
            payload = {
                "category": "technical_issue",
                "subject": "Lag",
                "message": "Slow audio",
                "contact_email": "p@example.com",
            }
            self.assertEqual(client.post("/support/feedback", json=payload).status_code, 202)
            r429 = client.post("/support/feedback", json=payload)
            self.assertEqual(r429.status_code, 429)
            self.assertEqual(r429.json()["detail"]["code"], "RATE_LIMIT_EXCEEDED")
            self.assertIn("retry-after", {k.lower() for k in r429.headers})

            # Different actor is isolated
            current_actor["id"] = OTHER_ACTOR_ID
            self.assertEqual(client.post("/support/feedback", json=payload).status_code, 202)
            current_actor["id"] = ACTOR_ID

            self.assertEqual(client.get("/voice/status").status_code, 200)
            self.assertEqual(client.get("/voice/status").status_code, 429)

            self.assertEqual(
                client.post("/voice/text-to-speech", json={"text": "Xin chào"}).status_code,
                200,
            )
            self.assertEqual(
                client.post("/voice/text-to-speech", json={"text": "Xin chào"}).status_code,
                429,
            )

            self.assertEqual(
                client.post(
                    "/reading/scan-page-ocr",
                    files={"file": ("p.png", b"\x89PNG\r\n\x1a\n", "image/png")},
                ).status_code,
                200,
            )
            self.assertEqual(
                client.post(
                    "/reading/scan-page-ocr",
                    files={"file": ("p.png", b"\x89PNG\r\n\x1a\n", "image/png")},
                ).status_code,
                429,
            )

            self.assertEqual(
                client.post(
                    "/reading/match-page",
                    files={"file": ("p.jpg", _valid_camera_jpeg(), "image/jpeg")},
                ).status_code,
                200,
            )
            self.assertEqual(
                client.post(
                    f"/reading/books/{BOOK_ID}/match-page",
                    files={"file": ("p.jpg", _valid_camera_jpeg(), "image/jpeg")},
                ).status_code,
                429,
            )

            self.assertEqual(
                client.get(f"/games/sentence-shooter/books?child_id={uuid4()}").status_code,
                200,
            )
            self.assertEqual(
                client.get(f"/games/picture-description/catalog?child_id={uuid4()}").status_code,
                429,
            )

    def test_reading_match_page_enforces_camera_limit_and_bounded_candidates(self):
        active_db = MagicMock()
        active_db.scalar = AsyncMock(return_value="parent")
        fake_res = MagicMock()
        fake_res.all.return_value = []
        active_db.execute = AsyncMock(return_value=fake_res)

        app = FastAPI()
        app.include_router(reading_route.router, prefix="/reading")
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
        app.dependency_overrides[get_db] = lambda: active_db
        client = TestClient(app)

        oversized = b"\xff\xd8\xff" + b"\x00" * reading_route.MAX_CAMERA_FRAME_BYTES
        with patch.object(
            reading_route.HistoryService, "require_parent", new=AsyncMock(return_value=None)
        ):
            r_book = client.post(
                f"/reading/books/{BOOK_ID}/match-page",
                files={"file": ("big.jpg", oversized, "image/jpeg")},
            )
            r_global = client.post(
                "/reading/match-page",
                files={"file": ("big.jpg", oversized, "image/jpeg")},
            )
        self.assertEqual(r_book.status_code, 413)
        self.assertEqual(r_global.status_code, 413)

        with (
            patch.object(
                reading_route.HistoryService, "require_parent", new=AsyncMock(return_value=None)
            ),
            patch.object(
                reading_route.vision_page_matcher,
                "check_framing",
                return_value={"framing_valid": True},
            ),
        ):
            r_empty_candidates = client.post(
                "/reading/match-page",
                files={"file": ("small.jpg", _valid_camera_jpeg(), "image/jpeg")},
            )
        self.assertEqual(r_empty_candidates.status_code, 404)
        stmt = active_db.execute.await_args.args[0]
        self.assertEqual(stmt._limit_clause.value, reading_route.MAX_MATCH_PAGE_GLOBAL_CANDIDATES)


class ProxylessPrivateSignedUrlTests(unittest.TestCase):
    def test_owner_scoped_signed_url_used_when_non_local_and_blocks_cross_owner(self):
        owner_id = ACTOR_ID
        other_id = OTHER_ACTOR_ID
        page_id = uuid4()
        valid_path = f"private-books/{owner_id}/{BOOK_ID}/pages/{page_id}/rev-1.png"

        self.assertTrue(
            book_access.is_private_storage_path_owned_by(valid_path, owner_id, book_id=BOOK_ID)
        )
        self.assertFalse(
            book_access.is_private_storage_path_owned_by(valid_path, other_id, book_id=BOOK_ID)
        )
        self.assertFalse(
            book_access.is_private_storage_path_owned_by("../escape.png", owner_id)
        )

        with (
            patch.object(book_access, "is_local_storage_enabled", return_value=False),
            patch.object(
                book_access,
                "create_signed_image_url",
                return_value="https://example.supabase.co/storage/v1/object/sign/viread-private-books/tok",
            ) as sign_mock,
        ):
            signed = book_access.private_page_image_url(
                BOOK_ID,
                page_id,
                storage_path=valid_path,
                owner_id=owner_id,
            )
            self.assertTrue(signed.startswith("https://example.supabase.co/storage/v1/object/sign/"))
            sign_mock.assert_called_once()
            self.assertEqual(
                sign_mock.call_args.kwargs["ttl_seconds"],
                book_access.PRIVATE_SIGNED_URL_TTL_SECONDS,
            )

            # Cross-owner path must fall back / refuse signing the foreign object path
            sign_mock.reset_mock()
            cross = book_access.private_page_image_url(
                BOOK_ID,
                page_id,
                storage_path=valid_path,
                owner_id=other_id,
            )
            self.assertIn(f"/books/my-books/{BOOK_ID}/pages/{page_id}/image", cross)
            sign_mock.assert_not_called()

        # When local storage is active, proxy URL is returned without signing
        with (
            patch.object(book_access, "is_local_storage_enabled", return_value=True),
            patch.object(book_access, "create_signed_image_url") as sign_mock,
        ):
            local_url = book_access.private_page_image_url(
                BOOK_ID,
                page_id,
                storage_path=valid_path,
                owner_id=owner_id,
            )
            self.assertIn(f"/books/my-books/{BOOK_ID}/pages/{page_id}/image", local_url)
            sign_mock.assert_not_called()

    def test_serialize_submission_uses_source_storage_path_attribute(self):
        from datetime import datetime, timezone
        from app.models import Book, ParentBookPageSubmission
        from app.services.parent_private_book_service import ParentPrivateBookService

        sub_id = uuid4()
        now = datetime.now(timezone.utc)
        book = Book(
            Id=BOOK_ID,
            Title="Private Book",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="ACTIVE",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=ACTOR_ID,
            ModerationStatus="ACTIVE",
            CreatedAt=now,
        )
        sub = ParentBookPageSubmission(
            Id=sub_id,
            BookId=BOOK_ID,
            OwnerParentId=ACTOR_ID,
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            SourceFileName="page.png",
            SourceFormat="PNG",
            SourceStoragePath=f"private-books/{ACTOR_ID}/{BOOK_ID}/staging/{sub_id}/p.jpg",
            SourceSha256="a" * 64,
            ImageWidth=800,
            ImageHeight=1000,
            SourceType="SELF_AUTHORED",
            SubmissionVersion=1,
            OptimisticLockVersion=1,
            WorkflowStatus="CHECKING",
            OcrStatus="PENDING",
            IsImageOnly=False,
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            ToolCheckPolicyBlocked=False,
            TempExpiresAt=now,
            CreatedAt=now,
            UpdatedAt=now,
        )
        dto = ParentPrivateBookService(MagicMock())._serialize_submission(book, sub)
        self.assertIn(f"/books/my-books/{BOOK_ID}/submissions/{sub_id}/image", dto.image_url)


class VoiceWorkerEnhancementsTests(unittest.TestCase):
    def test_tts_cache_lru_cleanup_evicts_oldest_pairs_down_to_budget(self):
        worker = _load_voice_worker_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir)
            for idx, age_offset in enumerate((30.0, 20.0, 10.0)):
                wav_p = cache_dir / f"entry_{idx}.wav"
                meta_p = cache_dir / f"entry_{idx}.json"
                wav_p.write_bytes(b"x" * 1000)
                meta_p.write_text('{"duration_seconds": 1.0}', encoding="utf-8")
                ts = time.time() - age_offset
                os.utime(wav_p, (ts, ts))
                os.utime(meta_p, (ts, ts))

            # Budget of 2100 bytes should evict entry_0 (oldest ~1025B), leaving entry_1 + entry_2
            reclaimed = worker.prune_tts_cache_dir(cache_dir=cache_dir, max_bytes=2100)
            self.assertGreater(reclaimed, 0)
            remaining_stems = {p.stem for p in cache_dir.iterdir()}
            self.assertNotIn("entry_0", remaining_stems)
            self.assertIn("entry_1", remaining_stems)
            self.assertIn("entry_2", remaining_stems)

    def test_audio_negotiation_and_wav_fallback_plus_hybrid_fp32(self):
        worker = _load_voice_worker_module()
        self.assertEqual(
            worker.resolve_preferred_audio_media_type("audio/mpeg, audio/wav;q=0.8", "ogg"),
            "audio/mpeg",
        )
        self.assertEqual(
            worker.resolve_preferred_audio_media_type("*/*", "ogg"),
            "audio/ogg",
        )
        self.assertEqual(
            worker.resolve_preferred_audio_media_type(None, None),
            "audio/wav",
        )

        # In environments without real PyAV/soundfile binary codecs, transcoding safely falls back to WAV
        sample_wav = b"RIFF\x24\x00\x00\x00WAVEfmt "
        out_bytes, out_mime = worker.encode_audio_bytes_for_media_type(sample_wav, "audio/mpeg")
        self.assertIn(out_mime, ("audio/mpeg", "audio/wav"))
        self.assertTrue(len(out_bytes) > 0)

        # Hybrid fp32 key differs from int8 key
        key_int8 = worker.make_cache_key(
            voice_id="local_north_truc_ly",
            speed=1.0,
            mode="word",
            payload="mèo",
            precision="int8",
        )
        key_fp32 = worker.make_cache_key(
            voice_id="local_north_truc_ly",
            speed=1.0,
            mode="word",
            payload="mèo",
            precision="fp32",
        )
        self.assertNotEqual(key_int8, key_fp32)

        rt = worker.VoiceRuntimeEngine()
        rt.tts_engine = "int8-engine"
        rt.word_fp32_tts_engine = "fp32-engine"
        with patch.object(worker, "TTS_HYBRID_WORD_FP32", True):
            eng_word, prec_word = rt.get_tts_engine_for_mode(crisp=True)
            eng_sent, prec_sent = rt.get_tts_engine_for_mode(crisp=False)
        self.assertEqual((eng_word, prec_word), ("fp32-engine", "fp32"))
        self.assertEqual((eng_sent, prec_sent), ("int8-engine", worker.TTS_PRECISION))


if __name__ == "__main__":
    unittest.main()
