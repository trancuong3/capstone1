"""Comprehensive unit & API tests for ViRead mobile overhaul backend OCR, voice, catalog TTS, and perf changes."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import subprocess
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "isolated-service-role-key")

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _make_sample_jpeg(width: int = 400, height: int = 500, seed: int = 1) -> bytes:
    img = Image.new("RGB", (width, height), (250, 248, 240))
    draw = ImageDraw.Draw(img)
    rng = np.random.default_rng(seed)
    for _ in range(45):
        x1 = int(rng.integers(20, width - 60))
        y1 = int(rng.integers(20, height - 60))
        x2 = x1 + int(rng.integers(15, 50))
        y2 = y1 + int(rng.integers(15, 50))
        color = tuple(int(c) for c in rng.integers(10, 140, size=3))
        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
        draw.line([x1, y1, x2, y2], fill=color, width=2)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


class TestOcrRemoteHardeningAndLazyImports(unittest.TestCase):
    def test_get_ocr_mode_fails_closed_for_production_render_and_light_web(self):
        from app.services import ocr_inference_job_service as svc_mod

        base_clean = {
            "VIREAD_OCR_MODE": "",
            "APP_ENVIRONMENT": "development",
            "RENDER": "",
            "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "",
        }
        with (
            patch.dict(os.environ, base_clean, clear=False),
            patch.object(svc_mod, "APP_ENVIRONMENT", "development"),
        ):
            self.assertEqual(svc_mod.get_ocr_mode(), "local_inprocess")

        for override in (
            {"APP_ENVIRONMENT": "production"},
            {"RENDER": "true"},
            {"VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true"},
        ):
            env = {**base_clean, **override}
            with (
                patch.dict(os.environ, env, clear=False),
                patch.object(svc_mod, "APP_ENVIRONMENT", env["APP_ENVIRONMENT"]),
            ):
                self.assertEqual(svc_mod.get_ocr_mode(), "remote_worker")

        # Explicit local_inprocess still honored for local dev/tests.
        with patch.dict(
            os.environ,
            {**base_clean, "RENDER": "true", "VIREAD_OCR_MODE": "local_inprocess"},
            clear=False,
        ):
            self.assertEqual(svc_mod.get_ocr_mode(), "local_inprocess")

    def test_extract_text_and_boxes_hard_refuses_in_remote_mode(self):
        from app.services import ocr_engine

        with patch.dict(
            os.environ,
            {"VIREAD_OCR_MODE": "remote_worker", "VIREAD_OCR_WORKER_PROCESS": ""},
            clear=False,
        ):
            with self.assertRaises(ocr_engine.OcrEngineUnavailable):
                ocr_engine.extract_text_and_boxes(b"fake-bytes")

        # Worker process flag explicitly bypasses the web fail-closed guard.
        with patch.dict(
            os.environ,
            {"VIREAD_OCR_MODE": "remote_worker", "VIREAD_OCR_WORKER_PROCESS": "1"},
            clear=False,
        ):
            self.assertFalse(ocr_engine._is_remote_ocr_mode_guard())

    def test_ocr_engine_imports_cleanly_without_jiwer_or_pytesseract(self):
        script = """
import importlib.abc, json, os, sys
sys.path.insert(0, %r)
os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:y@127.0.0.1:5432/z")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-key")

class _BlockOptionalOcrDeps(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname.split(".")[0] in {"jiwer", "pytesseract"}:
            raise ModuleNotFoundError(f"Blocked optional dep: {fullname}")
        return None

sys.meta_path.insert(0, _BlockOptionalOcrDeps())
from app.services import ocr_engine
sim, status = ocr_engine._word_engine_evidence("thơm", "thôm")
tess_ok = ocr_engine._configure_tesseract()
print(json.dumps({"sim": sim, "status": status, "tess_ok": tess_ok}))
""" % (str(BACKEND_DIR),)
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        data = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(data["status"], "engine_disagreement")
        self.assertIsNotNone(data["sim"])
        self.assertFalse(data["tess_ok"])

    def test_training_service_remote_mode_reads_worker_heartbeats_without_importing_ocr_engine(self):
        script = """
import asyncio, json, os, sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

sys.path.insert(0, %r)
os.environ["APP_ENVIRONMENT"] = "test"
os.environ["VIREAD_OCR_MODE"] = "remote_worker"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:y@127.0.0.1:5432/z")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-key")

from app.services.viread_ocr_training_service import VireadOcrTrainingService

async def _run():
    db = MagicMock()
    db.execute = AsyncMock()
    svc = VireadOcrTrainingService(db)
    svc._admin = AsyncMock()
    svc._locked_test_readiness = AsyncMock(return_value={"ready": False})
    svc.repo.one = AsyncMock(side_effect=[
        {"profile": "FLOW1_EXTERNAL_TRDG", "checkpoint_sha256": "a" * 64, "storage_path": None, "updated_at": datetime.now(timezone.utc)},
        {"cnt": 0},
        {"cnt": 0},
        {"cnt": 0},
        {"cnt": 0},
    ])
    svc.repo.all = AsyncMock(return_value=[])
    hb = SimpleNamespace(
        WorkerId="win-ocr-gpu-1",
        Status="IDLE",
        LastHeartbeatAt=datetime.now(timezone.utc),
        ModelProfile="FLOW1_EXTERNAL_TRDG",
        ModelSha256="a" * 64,
        Engines={"vietocr": {"loaded": True, "inference_verified": True}},
        LastError=None,
    )
    with (
        patch("app.repositories.ocr_inference_job_repository.OcrInferenceJobRepository.list_worker_heartbeats", AsyncMock(return_value=[hb])),
        patch("app.services.viread_ocr_training_service.VireadDriveConnectionService.get_status", AsyncMock(return_value=None)),
    ):
        # Verify overview uses heartbeat without importing app.services.ocr_engine
        from app.repositories.ocr_inference_job_repository import OcrInferenceJobRepository
        workers = await OcrInferenceJobRepository(db).list_worker_heartbeats(limit=20)
        assert workers[0].WorkerId == "win-ocr-gpu-1"

asyncio.run(_run())
print(json.dumps({"ocr_engine_loaded": "app.services.ocr_engine" in sys.modules}))
""" % (str(BACKEND_DIR),)
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        data = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertFalse(data["ocr_engine_loaded"])

    def test_active_model_shard_download_supports_path_key_and_router_import(self):
        from app.services.ocr_inference_job_service import OcrInferenceJobService

        shard_bytes = b"vietocr-shard-0-bytes"
        shard_sha = hashlib.sha256(shard_bytes).hexdigest()
        manifest_bytes = json.dumps(
            {
                "checkpoint_sha256": "f" * 64,
                "chunks": [{"index": 0, "path": "gdrive://file-shard-0", "sha256": shard_sha, "bytes": len(shard_bytes)}],
            }
        ).encode("utf-8")

        fake_router = MagicMock()
        fake_router.get.side_effect = [manifest_bytes, shard_bytes]

        async def _scenario():
            svc = OcrInferenceJobService(MagicMock())
            svc.repo.get_active_model_pointer = AsyncMock(
                return_value={"storage_path": "gdrive://manifest-1"}
            )
            with patch(
                "app.services.training_storage.router.get_runtime_artifact_router",
                return_value=fake_router,
            ):
                payload, actual_sha = await svc.get_active_model_artifact_bytes(
                    kind="shard", shard_index=0
                )
            self.assertEqual(payload, shard_bytes)
            self.assertEqual(actual_sha, shard_sha)

        asyncio.run(_scenario())


class TestAsyncScanPageOcrJobsAndMatchPageCache(unittest.TestCase):
    def test_async_scan_page_ocr_queue_lifecycle_jpeg85_owner_scope_and_cleanup(self):
        from app.api.deps import get_current_parent_id, get_db
        from app.api.routes import reading as reading_routes
        from app.models import OcrInferenceJob
        from app.services import ocr_inference_job_service as job_svc_mod

        parent_a = uuid4()
        parent_b = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        word_id = uuid4()
        now = datetime.now(timezone.utc)

        jobs_store: dict[UUID, OcrInferenceJob] = {}
        uploaded_objects: dict[str, tuple[bytes, str]] = {}
        deleted_objects: list[str] = []

        class _FakeJobRepo:
            def __init__(self, _db):
                self.db = _db

            async def get(self, job_id, *, lock=False):
                return jobs_store.get(job_id)

            async def get_by_idempotency(self, job_kind, owner_user_id, idem_key, *, lock=False):
                for j in jobs_store.values():
                    if (
                        j.JobKind == job_kind
                        and j.OwnerUserId == owner_user_id
                        and j.IdempotencyKey == idem_key
                        and j.Status != "CANCELLED"
                    ):
                        return j
                return None

            async def get_active_model_pointer(self):
                return {"profile": "ORIGINAL", "checkpoint_sha256": job_svc_mod.ORIGINAL_VIETOCR_SHA256}

            async def find_completed_cached_job(self, **_kwargs):
                return None

            async def create_job(self, job):
                jobs_store[job.Id] = job
                return job

            async def list_worker_heartbeats(self, *, limit=20):
                return []

            async def get_queue_positions(self, job_ids):
                if not job_ids:
                    return {}
                target_set = set(job_ids)
                claimable = [
                    j
                    for j in jobs_store.values()
                    if j.Status in ("QUEUED", "FAILED_RETRYABLE")
                ]
                claimable.sort(
                    key=lambda j: (
                        int(j.Priority or 0),
                        j.CreatedAt or now,
                        str(j.Id),
                    )
                )
                return {
                    j.Id: idx
                    for idx, j in enumerate(claimable, start=1)
                    if j.Id in target_set
                }

        class _FakeScanRepo:
            def __init__(self, db):
                self.db = db

            async def profile_role(self, actor_id):
                return "parent"

            async def child_belongs_to_parent(self, child_id, actor_id):
                return True

            async def eligible_verified_pages(self, book_id=None, *, ocr_tokens=None, limit=None):
                fake_book = SimpleNamespace(Id=book_id or uuid4(), Title="Chú mèo đi hia")
                fake_page = SimpleNamespace(Id=page_id, PageNumber=3, Width=800, Height=1000)
                fake_rev = SimpleNamespace(Id=rev_id, VerifiedText="Con mèo trèo cây cau", OriginalOcrText="Con mèo trèo cây cau")
                return [(fake_book, fake_page, fake_rev)]

            async def revision_words(self, revision_id):
                return [
                    SimpleNamespace(Id=word_id, WordIndex=0, Text="Con", BoundingBox=[0.1, 0.1, 0.1, 0.05]),
                ]

        fake_db = MagicMock()
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()
        fake_db.scalar = AsyncMock(return_value=None)

        current_actor = {"id": parent_a}
        app = FastAPI()
        app.include_router(reading_routes.router, prefix="/reading")
        app.dependency_overrides[get_db] = lambda: fake_db
        app.dependency_overrides[get_current_parent_id] = lambda: current_actor["id"]

        def _fake_upload(path, data, content_type, bucket_name=None, **_kwargs):
            uploaded_objects[path] = (data, content_type)

        def _fake_delete(path, bucket_name=None):
            deleted_objects.append(path)

        png_img = Image.new("RGB", (320, 420), (255, 255, 255))
        png_buf = io.BytesIO()
        png_img.save(png_buf, format="PNG")
        png_bytes = png_buf.getvalue()

        with (
            patch.dict(os.environ, {"VIREAD_OCR_MODE": "remote_worker"}, clear=False),
            patch.object(reading_routes, "LocalOcrScanRepository", _FakeScanRepo),
            patch.object(job_svc_mod, "OcrInferenceJobRepository", _FakeJobRepo),
            patch("app.services.storage_service.upload_object", side_effect=_fake_upload),
            patch("app.services.storage_service.delete_object", side_effect=_fake_delete),
        ):
            with TestClient(app) as client:
                idem = str(uuid4())
                resp = client.post(
                    "/reading/scan-page-ocr/jobs",
                    files={"file": ("page.png", png_bytes, "image/png")},
                    headers={"Idempotency-Key": idem},
                )
                self.assertEqual(resp.status_code, 202)
                body = resp.json()
                self.assertEqual(body["status"], "QUEUED")
                self.assertFalse(body["worker_online"])
                self.assertIsNone(body["result"])
                job_id = UUID(body["job_id"])

                # Stored image MUST be JPEG q85 (not PNG!) and job SHA must match stored bytes.
                self.assertEqual(len(uploaded_objects), 1)
                stored_path, (stored_bytes, stored_mime) = next(iter(uploaded_objects.items()))
                self.assertTrue(stored_path.endswith(".jpg"))
                self.assertEqual(stored_mime, "image/jpeg")
                with Image.open(io.BytesIO(stored_bytes)) as check_img:
                    self.assertEqual(check_img.format, "JPEG")
                self.assertEqual(
                    jobs_store[job_id].ImageSha256,
                    hashlib.sha256(stored_bytes).hexdigest(),
                )

                # Idempotency replay returns same job_id without creating a second job
                resp_dup = client.post(
                    "/reading/scan-page-ocr/jobs",
                    files={"file": ("page.png", png_bytes, "image/png")},
                    headers={"Idempotency-Key": idem},
                )
                self.assertEqual(resp_dup.status_code, 202)
                self.assertEqual(resp_dup.json()["job_id"], str(job_id))

                # Cross-parent isolation: parent_b receives 404
                current_actor["id"] = parent_b
                resp_other = client.get(f"/reading/scan-page-ocr/jobs/{job_id}")
                self.assertEqual(resp_other.status_code, 404)

                # Simulate worker completing the job
                current_actor["id"] = parent_a
                jobs_store[job_id].Status = "SUCCEEDED"
                jobs_store[job_id].DurationMs = 340
                jobs_store[job_id].UpdatedAt = now + timedelta(seconds=2)
                jobs_store[job_id].ResultPayload = {
                    "full_text": "Con mèo trèo cây cau",
                    "words": [
                        {"word_index": 0, "line_index": 0, "text": "Con", "bbox": [0.1, 0.1, 0.1, 0.05]},
                        {"word_index": 1, "line_index": 0, "text": "mèo", "bbox": [0.22, 0.1, 0.1, 0.05]},
                        {"word_index": 2, "line_index": 0, "text": "trèo", "bbox": [0.34, 0.1, 0.1, 0.05]},
                        {"word_index": 3, "line_index": 0, "text": "cây", "bbox": [0.46, 0.1, 0.1, 0.05]},
                        {"word_index": 4, "line_index": 0, "text": "cau", "bbox": [0.58, 0.1, 0.1, 0.05]},
                    ],
                    "ocr_meta": {"engine": "hybrid_ocr_v2", "runtime_device": "cuda", "engine_statuses": {"paddleocr": "success", "vietocr": "success"}},
                    "no_text_detected": False,
                }

                resp_done = client.get(f"/reading/scan-page-ocr/jobs/{job_id}")
                self.assertEqual(resp_done.status_code, 200)
                done_body = resp_done.json()
                self.assertEqual(done_body["status"], "SUCCEEDED")
                self.assertIsNotNone(done_body["result"])
                self.assertEqual(done_body["result"]["ocr_text"], "Con mèo trèo cây cau")
                self.assertTrue(done_body["result"]["matched"])
                self.assertEqual(done_body["result"]["matched_book_title"], "Chú mèo đi hia")
                self.assertIn(stored_path, deleted_objects)

    def test_match_page_uses_bounded_lru_descriptor_cache_and_avoids_repeat_downloads(self):
        from app.api.routes import reading as reading_routes
        from app.services.vision_page_matcher import ViReadPageMatcher

        matcher = ViReadPageMatcher(max_cache_entries=2)
        img1 = _make_sample_jpeg(seed=11)
        img2 = _make_sample_jpeg(seed=22)
        img3 = _make_sample_jpeg(seed=33)

        page1 = SimpleNamespace(Id=uuid4(), ImagePath="books/b/p1.jpg")
        page2 = SimpleNamespace(Id=uuid4(), ImagePath="books/b/p2.jpg")
        page3 = SimpleNamespace(Id=uuid4(), ImagePath="books/b/p3.jpg")
        book = SimpleNamespace(VisibilityScope="CATALOG")

        downloads: list[str] = []

        async def _fake_fetch(path, bucket_name=None):
            downloads.append(path)
            return {
                "books/b/p1.jpg": img1,
                "books/b/p2.jpg": img2,
                "books/b/p3.jpg": img3,
            }[path]

        async def _scenario():
            with (
                patch.object(reading_routes, "vision_page_matcher", matcher),
                patch.object(reading_routes, "_fetch_stored_page_bytes", side_effect=_fake_fetch),
            ):
                # Frame 1: cold cache downloads p1 and p2
                cands1 = await reading_routes._build_match_candidates([(page1, book), (page2, book)])
                self.assertEqual(len(cands1), 2)
                self.assertEqual(len(downloads), 2)

                # Frame 2: warm cache hits LRU -> ZERO downloads!
                cands2 = await reading_routes._build_match_candidates([(page1, book), (page2, book)])
                self.assertEqual(len(cands2), 2)
                self.assertEqual(len(downloads), 2)
                self.assertIn("features", cands2[0])

                # Matching works directly from cached features
                res = matcher.match_page(img1, cands2)
                self.assertTrue(res["matched"])
                self.assertEqual(res["page"]["page_orm"].Id, page1.Id)

                # Adding p3 evicts oldest beyond max_cache_entries=2
                await reading_routes._build_match_candidates([(page3, book)])
                self.assertEqual(matcher.cache_stats()["size"], 2)

        asyncio.run(_scenario())


class TestParentPrivateBookRemoteFixesAndAdminDocJobs(unittest.TestCase):
    def test_parent_post_ocr_uses_private_book_config_and_canonical_shapes(self):
        from app.models import ParentBookPageSubmission
        from app.services.ocr_ai.config import OcrCorrectionConfig
        from app.services.ocr_inference_job_service import (
            compute_candidate_hash,
            run_parent_submission_post_ocr,
        )

        img_bytes = b"private-book-page-image"
        img_sha = hashlib.sha256(img_bytes).hexdigest()
        sub_id = uuid4()
        book_id = uuid4()
        now = datetime.now(timezone.utc)
        sub = ParentBookPageSubmission(
            Id=sub_id,
            BookId=book_id,
            OwnerParentId=uuid4(),
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            TargetPageNumber=1,
            IdempotencyKey="k1",
            SourceFileName="p1.jpg",
            SourceFormat="IMAGE",
            SourceStoragePath="private/p1.jpg",
            SourceSha256=img_sha,
            ImageWidth=800,
            ImageHeight=1000,
            SourceType="OTHER",
            SourceNote="short",
            SubmissionVersion=1,
            OptimisticLockVersion=1,
            WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED",
            OcrText="Con meo nhỏ",
            OcrWordsJson=[
                {"word_index": 0, "line_index": 0, "text": "Con", "bounding_box": [0.1, 0.1, 0.1, 0.05]},
                {"word_index": 1, "line_index": 0, "text": "meo", "bounding_box": [0.22, 0.1, 0.1, 0.05]},
                {"word_index": 2, "line_index": 0, "text": "nhỏ", "bounding_box": [0.34, 0.1, 0.1, 0.05]},
            ],
            CandidateText="Con meo nhỏ",
            CandidateWordsJson=[],
            CandidateHash=compute_candidate_hash("Con meo nhỏ", source_sha256=img_sha),
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            WorkerId="old-worker",
            LeaseExpiresAt=now + timedelta(minutes=5),
            TempExpiresAt=now + timedelta(days=3),
            CreatedAt=now,
            UpdatedAt=now,
        )

        class _FakeSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

            async def scalar(self, _q):
                return sub

            async def execute(self, _q):
                return SimpleNamespace(all=lambda: [], scalars=lambda: SimpleNamespace(all=lambda: []))

            async def commit(self):
                return None

            async def rollback(self):
                return None

        class _Proofread:
            async def correct(self, text, _img, _boxes, **_kw):
                return "Con mèo nhỏ"

        class _Safety:
            async def analyze(self, text):
                return {
                    "suitability": "SUITABLE",
                    "findings": [],
                    "provider_events": [{"provider": "ollama", "chunk_id": 0, "availability": True}],
                }

        async def _scenario():
            # Verify privacy-safe config helper refuses cloud AI by default
            with patch.dict(
                os.environ,
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "GEMINI_API_KEY": "secret-key",
                    "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false",
                },
                clear=False,
            ):
                cfg = OcrCorrectionConfig.from_environment_for_private_book()
                self.assertFalse(cfg.cloud_enabled)
                self.assertIsNone(cfg.gemini_api_key)

            with (
                patch("app.services.ocr_inference_job_service.AsyncSessionLocal", side_effect=lambda: _FakeSession()),
                patch(
                    "app.repositories.parent_private_book_repository.ParentPrivateBookRepository.list_committed_page_texts",
                    AsyncMock(return_value=[(1, "Con mèo nhỏ")]),
                ),
            ):
                res = await run_parent_submission_post_ocr(
                    sub_id,
                    proofread_orchestrator=_Proofread(),
                    safety_orchestrator=_Safety(),
                    download_bytes=lambda _p: img_bytes,
                )

            self.assertEqual(res["status"], "NEEDS_ADMIN_REVIEW")
            # ProofreadSuggestionsJson matches {word_index, original, suggested, uncertain}
            self.assertEqual(
                sub.ProofreadSuggestionsJson,
                [{"word_index": 1, "original": "meo", "suggested": "mèo", "uncertain": False}],
            )
            # Has suggestions -> SpellingAcceptedAt MUST remain None
            self.assertIsNone(sub.SpellingAcceptedAt)
            # Full ToolCheckScopeJson fields present
            self.assertEqual(sub.ToolCheckScopeJson["modality"], "TEXT_ONLY_WITH_OCR_IMAGE_PROOFREAD")
            self.assertTrue(sub.ToolCheckScopeJson["covers_all_chunks"])
            self.assertEqual(sub.ToolCheckScopeJson["copyright_scanner_status"], "NOT_CONFIGURED")
            # Duplicate page & OTHER rights declaration findings present
            categories = {f["category"] for f in sub.ToolCheckFindingsJson}
            self.assertIn("POSSIBLE_DUPLICATE_PAGE", categories)
            self.assertIn("RIGHTS_BASIS_UNSPECIFIED", categories)
            # Worker lease cleared!
            self.assertIsNone(sub.WorkerId)
            self.assertIsNone(sub.LeaseExpiresAt)

        asyncio.run(_scenario())

    def test_claim_next_job_sets_parent_submission_ocr_status_running(self):
        from app.models import OcrInferenceJob, ParentBookPageSubmission
        from app.services.ocr_inference_job_service import (
            JOB_KIND_PARENT_SUBMISSION,
            OcrInferenceJobService,
        )

        sub_id = uuid4()
        now = datetime.now(timezone.utc)
        sub = ParentBookPageSubmission(
            Id=sub_id,
            BookId=uuid4(),
            OwnerParentId=uuid4(),
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            IdempotencyKey="k",
            SourceFileName="a.jpg",
            SourceFormat="IMAGE",
            SourceStoragePath="private/a.jpg",
            SourceSha256="a" * 64,
            ImageWidth=400,
            ImageHeight=500,
            SourceType="OWNED_COPY",
            SubmissionVersion=1,
            OptimisticLockVersion=1,
            WorkflowStatus="CHECKING",
            OcrStatus="PENDING",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            TempExpiresAt=now + timedelta(days=1),
            CreatedAt=now,
            UpdatedAt=now,
        )
        job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_PARENT_SUBMISSION,
            Status="CLAIMED",
            Priority=50,
            SubmissionId=sub_id,
            ImagePath="private/a.jpg",
            ImageSha256="a" * 64,
            ExpectedVersion=1,
            FencingToken=1,
            WorkerId="win-gpu-1",
            AttemptCount=1,
            MaxAttempts=3,
            LeaseExpiresAt=now + timedelta(seconds=120),
        )

        async def _scenario():
            db = MagicMock()
            db.scalar = AsyncMock(return_value=sub)
            db.commit = AsyncMock()
            db.rollback = AsyncMock()
            svc = OcrInferenceJobService(db)
            svc.repo.dead_letter_exhausted_expired_leases = AsyncMock(return_value=[])
            svc.repo.claim_next_job = AsyncMock(return_value=job)
            claimed = await svc.claim_next_job(worker_id="win-gpu-1", lease_seconds=120)
            self.assertIsNotNone(claimed)
            self.assertEqual(sub.OcrStatus, "RUNNING")

        asyncio.run(_scenario())

    def test_admin_async_documents_jobs_endpoint_returns_202_with_all_pages(self):
        from app.api.deps import get_current_parent_id, get_db
        from app.api.routes import admin_ocr as admin_ocr_routes
        from app.services.admin_ocr_service import AdminOcrService

        admin_id = uuid4()
        book_id = uuid4()
        j1, j2 = str(uuid4()), str(uuid4())
        app = FastAPI()
        app.include_router(admin_ocr_routes.router, prefix="/books")
        app.dependency_overrides[get_db] = lambda: MagicMock()
        app.dependency_overrides[get_current_parent_id] = lambda: admin_id

        expected = {
            "book_id": str(book_id),
            "source_format": "PDF",
            "total_source_pages": 2,
            "job_ids": [j1, j2],
            "queued_count": 2,
            "worker_online": False,
            "jobs": [{"id": j1, "status": "QUEUED"}, {"id": j2, "status": "QUEUED"}],
        }
        with patch.object(
            AdminOcrService,
            "enqueue_upload_document_jobs",
            AsyncMock(return_value=expected),
        ):
            with TestClient(app) as client:
                resp = client.post(
                    f"/books/admin/catalog/{book_id}/documents/jobs",
                    files={"document": ("book.pdf", b"%PDF-1.4 sample", "application/pdf")},
                )
        self.assertEqual(resp.status_code, 202)
        body = resp.json()
        self.assertEqual(body["queued_count"], 2)
        self.assertEqual(body["job_ids"], [j1, j2])
        self.assertFalse(body["worker_online"])


class TestOcrWorkerFixes(unittest.TestCase):
    def test_ocr_worker_handles_none_warmup_provenance_keys_and_resync(self):
        from ocr_worker.service import OcrRuntimeManager

        mgr = OcrRuntimeManager(worker_id="test-worker")
        fake_ocr_engine = MagicMock()
        fake_ocr_engine._paddle_engine = object()
        fake_ocr_engine._vietocr_engine = object()
        fake_ocr_engine.warmup_ocr_engines.return_value = None  # real ocr_engine returns None!
        fake_ocr_engine.get_loaded_vietocr_runtime_status.return_value = {
            "initialized": True,
            "loaded_profile": "FLOW1_EXTERNAL_TRDG",
            "loaded_checkpoint_sha256": "1" * 64,
        }
        fake_ocr_engine.extract_text_and_boxes.return_value = {
            "text": "Xin chào",
            "words": [{"word_index": 0, "line_index": 0, "text": "Xin", "bbox": [0.1, 0.1, 0.2, 0.1]}],
            "metadata": {
                "engine_statuses": {"paddleocr": "success", "vietocr": "success"},
                "model_profile": "FLOW1_EXTERNAL_TRDG",
                "checkpoint_sha256": "1" * 64,
            },
        }
        fake_torch = MagicMock()
        fake_torch.__version__ = "2.14.1"
        fake_paddle = MagicMock()
        fake_paddle.__version__ = "2.6.2"

        import app.services as app_services_pkg

        with (
            patch.dict(os.environ, {}, clear=False),
            patch("ocr_worker.service.import_ml_modules_safe_order", return_value=(fake_torch, fake_paddle)),
            patch("ocr_worker.service.install_zero_db_config_shim"),
            patch.dict(sys.modules, {"app.services.ocr_engine": fake_ocr_engine}),
            patch.object(app_services_pkg, "ocr_engine", fake_ocr_engine, create=True),
            patch.object(mgr, "sync_active_model", return_value={"profile": "FLOW1_EXTERNAL_TRDG", "checkpoint_sha256": "1" * 64}),
        ):
            health = mgr.initialize_and_verify_engines(run_smoke_inference=False)
            self.assertEqual(health["model"]["profile"], "FLOW1_EXTERNAL_TRDG")
            self.assertEqual(health["model"]["checkpoint_sha256"], "1" * 64)
            self.assertTrue(health["ready"])

            out = mgr.run_ocr_for_job("job-1", b"img")
            self.assertEqual(out["model_profile"], "FLOW1_EXTERNAL_TRDG")
            self.assertEqual(out["model_sha256"], "1" * 64)

            # Periodic resync detects new promoted SHA
            fake_ocr_engine.get_loaded_vietocr_runtime_status.return_value = {
                "initialized": True,
                "loaded_profile": "FLOW2_ADMIN_VERIFIED",
                "loaded_checkpoint_sha256": "2" * 64,
            }
            with patch.object(
                mgr,
                "sync_active_model",
                return_value={"profile": "FLOW2_ADMIN_VERIFIED", "checkpoint_sha256": "2" * 64},
            ):
                changed = mgr.maybe_resync_active_model(
                    manifest_fetcher=lambda: {"profile": "FLOW2_ADMIN_VERIFIED", "checkpoint_sha256": "2" * 64},
                    artifact_fetcher=lambda _k, _i: b"",
                )
            self.assertTrue(changed)
            self.assertEqual(mgr.health_payload()["model"]["checkpoint_sha256"], "2" * 64)

        dockerfile = (REPO_ROOT / "ocr_worker" / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY ai/vietocr_v2/original_artifact.json /app/ai/vietocr_v2/original_artifact.json", dockerfile)


class TestDifficultWordsVoiceAndCatalogTts(unittest.TestCase):
    def test_difficult_words_defaults_to_voice_orchestrator_and_handles_503_with_browser_transcript(self):
        from app.api.routes.voice import clear_default_voice_orchestrators
        from app.providers.elevenlabs_voice_provider import VoiceProviderError
        from app.services.difficult_words_service import DifficultWordsService
        from app.services.voice_orchestrator import VoiceOrchestrator

        clear_default_voice_orchestrators()
        svc_default = DifficultWordsService(MagicMock(), MagicMock())
        self.assertIsInstance(svc_default.voice_provider, VoiceOrchestrator)

        # Simulate local voice worker returning 503 while Android native/browser transcript succeeds
        failing_orch = MagicMock()
        failing_orch.transcribe = AsyncMock(
            side_effect=VoiceProviderError(status_code=503, code="LOCAL_VOICE_UNCONFIGURED")
        )
        svc = DifficultWordsService(MagicMock(), MagicMock(), voice_provider=failing_orch)

        async def _scenario():
            # Case A: audio uploaded + worker 503 -> clean fallback to browser_transcript
            status_val, source_val, transcript, conf = await svc._evaluate_audio_payload(
                display_text="thơm",
                audio_bytes=b"RIFF1234",
                filename="practice.wav",
                content_type="audio/wav",
                browser_transcript="thơm",
                browser_confidence=0.82,
            )
            self.assertEqual(status_val, "CORRECT")
            self.assertEqual(source_val, "BROWSER_SPEECH")
            self.assertEqual(transcript, "thơm")

            # Case B: Android native STT without MediaRecorder audio blob -> tone mismatch rejected
            status_wrong, source_wrong, transcript_wrong, _ = await svc._evaluate_audio_payload(
                display_text="thơm",
                audio_bytes=None,
                filename="practice.webm",
                content_type=None,
                browser_transcript="thôm",
                browser_confidence=0.88,
            )
            self.assertEqual(status_wrong, "INCORRECT")
            self.assertEqual(source_wrong, "BROWSER_SPEECH")
            self.assertEqual(transcript_wrong, "thôm")

        asyncio.run(_scenario())

    def test_catalog_tts_url_strictly_restricted_to_verified_public_catalog_never_private(self):
        from app.services.catalog_tts_cache import (
            compute_catalog_tts_text_hash,
            resolve_verified_catalog_tts_url,
        )

        text = "Hoa   thơm ngát"
        expected_hash = compute_catalog_tts_text_hash("Hoa thơm ngát")

        with patch.dict(
            os.environ,
            {
                "VIREAD_CATALOG_TTS_PUBLIC_ENABLED": "true",
                "SUPABASE_URL": "https://proj.supabase.co",
            },
            clear=False,
        ):
            pub_url = resolve_verified_catalog_tts_url(
                is_public_catalog=True,
                is_verified=True,
                text=text,
            )
            self.assertIsNotNone(pub_url)
            self.assertIn("/storage/v1/object/public/viread-catalog-tts/", pub_url)
            self.assertIn(f"{expected_hash}.mp3", pub_url)
            self.assertNotIn("token=", pub_url)

            # NEVER private parent books!
            self.assertIsNone(
                resolve_verified_catalog_tts_url(
                    is_public_catalog=False,
                    is_verified=True,
                    text=text,
                    processing_meta={"catalog_tts": {"object_path": f"local_north_truc_ly/1.0/{expected_hash}.mp3"}},
                )
            )
            # NEVER unverified pages!
            self.assertIsNone(
                resolve_verified_catalog_tts_url(
                    is_public_catalog=True,
                    is_verified=False,
                    text=text,
                )
            )


class TestDashboardSummarySignedUrlCacheAndLightStartup(unittest.TestCase):
    def test_dashboard_summary_skips_auth_admin_and_batches_cached_signed_urls(self):
        from app.api.deps import get_current_parent_id, get_db
        from app.api.routes import profile as profile_routes
        from app.services.storage_service import clear_signed_url_cache

        clear_signed_url_cache()
        parent_id = uuid4()
        child1_id = uuid4()
        child2_id = uuid4()
        session1_id = uuid4()
        book1_id = uuid4()
        now = datetime(2026, 11, 25, 10, 0, tzinfo=timezone.utc)

        c1 = SimpleNamespace(
            Id=child1_id,
            ParentId=parent_id,
            Alias="Bé An",
            Grade=1,
            Settings={},
            CreatedAt=now,
            AvatarPath=f"children/{child1_id}/avatar/a.png",
        )
        c2 = SimpleNamespace(
            Id=child2_id,
            ParentId=parent_id,
            Alias="Bé Bình",
            Grade=2,
            Settings={},
            CreatedAt=now - timedelta(days=1),
            AvatarPath=f"children/{child2_id}/avatar/b.png",
        )
        prof = SimpleNamespace(
            Id=parent_id,
            DisplayName="Mẹ An",
            Role="parent",
            CreatedAt=now,
            ContactPhone=None,
            AvatarPath=f"profiles/{parent_id}/avatar/p.png",
            children=[c1, c2],
        )
        sess1 = SimpleNamespace(
            Id=session1_id,
            ChildId=child1_id,
            BookId=book1_id,
            State="IN_PROGRESS",
            StartedAt=now,
            EndedAt=None,
        )

        repo = MagicMock()
        repo.db = MagicMock()
        repo.db.rollback = AsyncMock()
        repo.get_by_id = AsyncMock(return_value=prof)
        repo.get_latest_sessions_by_child_ids = AsyncMock(
            return_value=[(sess1, "Truyện cổ tích")]
        )

        auth_provider = MagicMock()
        auth_provider.get_contact_info = AsyncMock(
            side_effect=AssertionError("dashboard-summary must NOT call Supabase Auth Admin")
        )

        sign_batch_calls: list[list[str]] = []

        def _fake_batch_sign(paths, **_kwargs):
            sign_batch_calls.append(list(paths))
            return [f"https://signed.example/{p}" for p in paths]

        app = FastAPI()
        app.include_router(profile_routes.router, prefix="/profiles")
        app.dependency_overrides[get_db] = lambda: object()
        app.dependency_overrides[get_current_parent_id] = lambda: parent_id

        with (
            patch.object(profile_routes, "ProfileRepository", return_value=repo),
            patch("app.services.profile_service.SupabaseAuthContactProvider", return_value=auth_provider),
            patch("app.services.storage_service.create_signed_image_urls", side_effect=_fake_batch_sign),
        ):
            with TestClient(app) as client:
                r1 = client.get("/profiles/dashboard-summary")
                self.assertEqual(r1.status_code, 200)
                body = r1.json()
                self.assertEqual(body["profile"]["id"], str(parent_id))
                self.assertEqual(
                    body["profile"]["avatar_url"],
                    f"https://signed.example/profiles/{parent_id}/avatar/p.png",
                )
                self.assertEqual(len(body["children"]), 2)
                self.assertIn(str(child1_id), body["latest_sessions_by_child"])
                self.assertEqual(
                    body["latest_sessions_by_child"][str(child1_id)]["book_title"],
                    "Truyện cổ tích",
                )
                self.assertTrue(
                    body["latest_sessions_by_child"][str(child1_id)]["resumable"]
                )
                # All 3 avatars signed in ONE single batched call!
                self.assertEqual(len(sign_batch_calls), 1)
                self.assertEqual(len(sign_batch_calls[0]), 3)

                # Second call hits 20-minute TTL cache -> ZERO Storage calls!
                r2 = client.get("/profiles/dashboard-summary")
                self.assertEqual(r2.status_code, 200)
                self.assertEqual(len(sign_batch_calls), 1)
                auth_provider.get_contact_info.assert_not_awaited()

    def test_voice_bootstrap_checks_should_autostart_before_health_probe(self):
        from app.services import local_voice_worker_bootstrap as bootstrap

        bootstrap.reset_local_voice_worker_bootstrap_state()
        mock_health = AsyncMock(return_value=True)
        with (
            patch.object(
                bootstrap,
                "should_autostart_local_voice_worker",
                return_value=(False, "render_environment"),
            ),
            patch.object(bootstrap, "_is_worker_healthy", mock_health),
        ):
            ok = asyncio.run(
                bootstrap.ensure_local_voice_worker_running(base_url="http://127.0.0.1:8010")
            )
        self.assertFalse(ok)
        mock_health.assert_not_awaited()

    def test_lifespan_startup_does_not_block_on_slow_database_probe(self):
        import app.sever as sever_mod

        async def _slow_db_probe(**_kwargs):
            await asyncio.sleep(3.0)
            return {
                "ok": True,
                "dns_resolved": True,
                "ssl_enabled": True,
                "pool_class": "NullPool",
                "pooler_mode": "transaction",
                "latency_ms": 3000.0,
                "error_type": None,
            }

        async def _scenario():
            fake_engine = SimpleNamespace(dispose=AsyncMock())
            with (
                patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_MODE": "remote_worker",
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    },
                    clear=False,
                ),
                patch.object(sever_mod, "APP_ENVIRONMENT", "production"),
                patch.object(sever_mod, "probe_database_connection", side_effect=_slow_db_probe),
                patch.object(sever_mod, "admin_ocr_correction_jobs", SimpleNamespace(shutdown=AsyncMock())),
                patch.object(sever_mod, "engine", fake_engine),
            ):
                t0 = time.perf_counter()
                async with sever_mod.lifespan(FastAPI()):
                    startup_elapsed = time.perf_counter() - t0
                # Must bind immediately (< 0.5s) instead of waiting 3.0s for DB probe!
                self.assertLess(startup_elapsed, 0.5)

        asyncio.run(_scenario())

    def test_health_remote_ocr_runs_concurrently_and_uses_safe_timeout(self):
        import app.sever as sever_mod

        self.assertGreaterEqual(sever_mod._remote_ocr_health_timeout_seconds(), 8.0)

        async def _slow_db_probe(**_kwargs):
            await asyncio.sleep(0.25)
            return {
                "ok": True,
                "dns_resolved": True,
                "ssl_enabled": True,
                "pool_class": "NullPool",
                "pooler_mode": "transaction",
                "latency_ms": 250,
                "error_type": None,
            }

        async def _slow_remote_ocr():
            await asyncio.sleep(0.25)
            return {
                "mode": "remote_worker",
                "ready": True,
                "engines": {"vietocr": {"status": "HEALTHY", "detail_status": "inference_verified"}},
                "workers": [{"worker_id": "win-ocr-test", "online": True, "status": "IDLE"}],
                "queue": {"queued": 0, "succeeded": 5},
                "heartbeat_ttl_seconds": 45,
            }

        with (
            patch.dict(os.environ, {"VIREAD_OCR_MODE": "remote_worker"}, clear=False),
            patch.object(sever_mod, "probe_database_connection", side_effect=_slow_db_probe),
            patch.object(sever_mod, "collect_remote_ocr_health", side_effect=_slow_remote_ocr),
        ):
            client = TestClient(sever_mod.app)
            t0 = time.perf_counter()
            resp = client.get("/health")
            elapsed = time.perf_counter() - t0

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["ocr"]["ready"])
        self.assertEqual(body["ocr"]["workers"][0]["worker_id"], "win-ocr-test")
        # Both 0.25s probes ran concurrently (< 0.45s instead of >= 0.50s sequential).
        self.assertLess(elapsed, 0.45)

    def test_profile_repository_dashboard_summary_runs_single_sql_query(self):
        from app.repositories.profile_repository import ProfileRepository
        from app.services.profile_service import ProfileAccessDeniedError, ProfileNotFoundError, ProfileService

        parent_id = uuid4()
        child1_id = uuid4()
        child2_id = uuid4()
        sess1_id = uuid4()
        book1_id = uuid4()
        now = datetime(2026, 11, 25, 10, 0, tzinfo=timezone.utc)

        prof = SimpleNamespace(
            Id=parent_id,
            DisplayName="Mẹ An",
            Role="parent",
            Active=1,
            CreatedAt=now,
            ContactPhone=None,
            AvatarPath=None,
        )
        c1 = SimpleNamespace(
            Id=child1_id,
            ParentId=parent_id,
            Alias="Bé An",
            Grade=1,
            Settings={},
            CreatedAt=now,
            AvatarPath=None,
        )
        c2 = SimpleNamespace(
            Id=child2_id,
            ParentId=parent_id,
            Alias="Bé Bình",
            Grade=2,
            Settings={},
            CreatedAt=now - timedelta(days=1),
            AvatarPath=None,
        )
        sess1 = SimpleNamespace(
            Id=sess1_id,
            ChildId=child1_id,
            BookId=book1_id,
            State="LISTENING",
            StartedAt=now,
            EndedAt=None,
        )

        executed_statements: list[object] = []

        async def _fake_execute(stmt):
            executed_statements.append(stmt)
            res = MagicMock()
            res.all.return_value = [
                (prof, c1, sess1, "Truyện hay"),
                (prof, c2, None, None),
            ]
            return res

        fake_db = MagicMock()
        fake_db.execute = AsyncMock(side_effect=_fake_execute)
        fake_db.rollback = AsyncMock()

        repo = ProfileRepository(fake_db)
        service = ProfileService(repo)
        summary = asyncio.run(service.get_dashboard_summary(parent_id))

        self.assertEqual(fake_db.execute.await_count, 1)
        # No avatars to sign -> must NOT waste a cross-region ROLLBACK round-trip.
        fake_db.rollback.assert_not_awaited()
        compiled_sql = str(executed_statements[0])
        self.assertIn("LEFT OUTER JOIN", compiled_sql)
        self.assertIn("row_number", compiled_sql.lower())
        self.assertEqual(len(summary["children"]), 2)
        self.assertEqual(summary["latest_sessions_by_child"][str(child1_id)]["book_title"], "Truyện hay")
        self.assertNotIn(str(child2_id), summary["latest_sessions_by_child"])

        # Missing profile -> ProfileNotFoundError
        empty_res = MagicMock()
        empty_res.all.return_value = []
        fake_db.execute = AsyncMock(return_value=empty_res)
        with self.assertRaises(ProfileNotFoundError):
            asyncio.run(service.get_dashboard_summary(parent_id))

        # Inactive profile -> ProfileAccessDeniedError
        inactive_prof = SimpleNamespace(**{**prof.__dict__, "Active": 0})
        inactive_res = MagicMock()
        inactive_res.all.return_value = [(inactive_prof, None, None, None)]
        fake_db.execute = AsyncMock(return_value=inactive_res)
        with self.assertRaises(ProfileAccessDeniedError):
            asyncio.run(service.get_dashboard_summary(parent_id))

    def test_queue_depth_counts_executes_single_sql_query(self):
        from app.repositories.ocr_inference_job_repository import OcrInferenceJobRepository

        now = datetime(2026, 11, 25, 16, 0, tzinfo=timezone.utc)
        agg_row = SimpleNamespace(
            queued=2,
            claimed=1,
            running=1,
            failed_retryable=1,
            dead_letter=0,
            succeeded=10,
            cancelled=0,
            expired_leases=1,
            oldest_pending_created=now - timedelta(seconds=12),
            latest_succeeded_at=now - timedelta(seconds=3),
        )
        res = MagicMock()
        res.one.return_value = agg_row
        fake_db = MagicMock()
        fake_db.execute = AsyncMock(return_value=res)

        repo = OcrInferenceJobRepository(fake_db)
        counts = asyncio.run(repo.queue_depth_counts(now=now))

        self.assertEqual(fake_db.execute.await_count, 1)
        self.assertEqual(counts["queued"], 2)
        self.assertEqual(counts["pending_total"], 3)
        self.assertEqual(counts["active_total"], 2)
        self.assertEqual(counts["expired_leases"], 1)
        self.assertEqual(counts["oldest_pending_job_age_seconds"], 12.0)
        self.assertEqual(counts["latest_succeeded_at"], (now - timedelta(seconds=3)).isoformat())

    def test_ocr_engine_and_worker_report_cuda_runtime_device_accurately(self):
        from app.services import ocr_engine

        fake_predictor = SimpleNamespace(config={"device": "cuda:0"})
        with patch.object(ocr_engine, "_vietocr_engine", fake_predictor):
            attached = ocr_engine._attach_vietocr_provenance(
                {"text": "Xin chào", "words": [], "metadata": {"engine": "paddleocr_vietocr_dual", "engine_statuses": {"vietocr": "success"}}},
                {"model_profile": "FLOW1_EXTERNAL_TRDG", "checkpoint_sha256": "abc", "model_load_status": "loaded"},
            )
            self.assertEqual(attached["metadata"]["runtime_device"], "cuda")

            fallback = ocr_engine._attach_vietocr_provenance(
                {"text": "Xin chào", "words": [], "metadata": {"engine": "tesseract", "engine_statuses": {"vietocr": "not_run"}}},
                None,
                skipped_reason="paddle_unavailable",
            )
            self.assertEqual(fallback["metadata"]["runtime_device"], "cpu")


if __name__ == "__main__":
    unittest.main()
