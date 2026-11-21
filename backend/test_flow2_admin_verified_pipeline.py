"""Flow 2 end-to-end, data-integrity, outbox, dataset, activation, and runtime-loading tests.

Covers Test Groups B (Admin Verification), D (Transactional Outbox), E (Dataset Integrity),
F (Training & GPU Guard), G (Model Activation & Runtime Drive Loading), and K (Isolated E2E).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException
from PIL import Image

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

from app.jobs import viread_ocr_outbox_worker as outbox_worker
from app.jobs import viread_ocr_training_auto_worker as auto_worker
from app.schemas.viread_ocr_training import (
    ModelDecisionRequest,
    TrainingRunComplete,
)
from app.services import ocr_engine
from app.services import viread_ocr_training_service as training_svc
from app.services.training_storage import (
    DriveIntegrityError,
    DriveQuotaExceededError,
    GoogleDriveTrainingStore,
    StorageProvider,
    TrainingArtifactStoreRouter,
    is_gdrive_ref,
    register_runtime_drive_store_factory,
)
from test_flow2_google_drive_storage import InMemoryGoogleDriveServer


def _make_sample_page_png(width: int = 400, height: int = 200, color=(255, 255, 255)) -> bytes:
    img = Image.new("RGB", (width, height), color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_drive_router(
    server: InMemoryGoogleDriveServer,
    *,
    min_free_bytes: int = 512 * 1024 * 1024,
) -> tuple[GoogleDriveTrainingStore, TrainingArtifactStoreRouter]:
    store = GoogleDriveTrainingStore(
        client_id="cid",
        client_secret="csec",
        refresh_token=server.valid_refresh_token,
        access_token=server.valid_access_token,
        access_token_expires_at=9e12,
        session=server.make_session(),
        min_free_buffer_bytes=min_free_bytes,
        base_backoff_seconds=0.0,
        sleep_fn=lambda _s: None,
    )
    router = TrainingArtifactStoreRouter(
        drive_store_factory=lambda: store,
        write_provider=StorageProvider.GOOGLE_DRIVE,
    )
    return store, router


class _FakeResult:
    def __init__(self, rows: list[dict] | None = None, *, rowcount: int = 1):
        self._rows = list(rows or [])
        self.rowcount = rowcount

    class _Mappings:
        def __init__(self, rows: list[dict]):
            self._rows = rows

        def first(self):
            return self._rows[0] if self._rows else None

        def all(self):
            return list(self._rows)

    def mappings(self):
        return self._Mappings(self._rows)


class Flow2OutboxAndVerificationTests(unittest.IsolatedAsyncioTestCase):
    def test_line_crops_preserves_vietnamese_nfc_punctuation_reading_order_and_rejects_bad_inputs(self):
        png = _make_sample_page_png(500, 300)
        # Decomposed NFD Vietnamese + punctuation + out-of-order wordindex/lineindex
        words = [
            {"lineindex": 1, "wordindex": 1, "text": "ràng!", "boundingbox": [0.3, 0.5, 0.2, 0.1]},
            {"lineindex": 0, "wordindex": 2, "text": "Việt,", "boundingbox": [0.4, 0.1, 0.2, 0.1]},
            {"lineindex": 0, "wordindex": 0, "text": "Tie\u0302\u0301ng", "boundingbox": [0.1, 0.1, 0.2, 0.1]},
            {"lineindex": 1, "wordindex": 0, "text": "Đọc rõ", "boundingbox": [0.1, 0.5, 0.18, 0.1]},
        ]
        crops = outbox_worker._line_crops(png, words)
        self.assertEqual(len(crops), 2)
        self.assertEqual(crops[0][0], 0)
        self.assertEqual(crops[0][2], "Tiếng Việt,")
        self.assertEqual(crops[1][0], 1)
        self.assertEqual(crops[1][2], "Đọc rõ ràng!")

        # Corrupted image rejected
        with self.assertRaises(ValueError):
            outbox_worker._line_crops(b"not-a-png", words)

        # Invalid out-of-bounds box rejected
        with self.assertRaises(ValueError):
            outbox_worker._line_crops(
                png,
                [{"lineindex": 0, "wordindex": 0, "text": "Bé", "boundingbox": [0.9, 0.1, 0.5, 0.1]}],
            )

        # Control character rejected
        with self.assertRaises(ValueError):
            outbox_worker._line_crops(
                png,
                [{"lineindex": 0, "wordindex": 0, "text": "bad\x07char", "boundingbox": [0.1, 0.1, 0.2, 0.1]}],
            )

    async def test_ai_auto_verified_is_skipped_and_never_uploads_or_inserts_samples(self):
        event = {
            "id": uuid4(),
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "actor_id": uuid4(),
            "attempts": 1,
        }
        header_row = {
            "imagepath": "books/book-1/page-1.png",
            "bookid": uuid4(),
            "visibility_scope": "CATALOG",
            "verificationstatus": "VERIFIED",
            "contenthash": "a" * 64,
            "verifiedby": event["actor_id"],
            "verifiedat": datetime.now(timezone.utc),
            "ai_proofread_mode": "AI_AUTO_VERIFIED",
            "ai_reviewed_by": None,
            "ai_automated_by": str(event["actor_id"]),
        }

        fake_db = MagicMock()
        fake_db.execute = AsyncMock(return_value=_FakeResult([header_row]))
        fake_db.commit = AsyncMock()

        class _Ctx:
            async def __aenter__(self):
                return fake_db

            async def __aexit__(self, *_a):
                return False

        with (
            patch.object(outbox_worker, "AsyncSessionLocal", return_value=_Ctx()),
            patch.object(outbox_worker, "download_object") as download_mock,
        ):
            with self.assertRaises(outbox_worker.OutboxEventSkipped) as skipped:
                await outbox_worker._process(event)
        self.assertEqual(skipped.exception.code, "AI_AUTO_VERIFIED_NOT_ELIGIBLE")
        download_mock.assert_not_called()

    async def test_duplicate_image_hash_with_conflicting_label_is_blocked(self):
        png = _make_sample_page_png(300, 200)
        event = {
            "id": uuid4(),
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "actor_id": uuid4(),
            "attempts": 1,
        }
        header_row = {
            "imagepath": "books/b1/p1.png",
            "bookid": uuid4(),
            "visibility_scope": "CATALOG",
            "verificationstatus": "VERIFIED",
            "contenthash": "b" * 64,
            "verifiedby": event["actor_id"],
            "verifiedat": datetime.now(timezone.utc),
            "ai_proofread_mode": "AI_CHECKED",
            "ai_reviewed_by": str(event["actor_id"]),
            "ai_automated_by": None,
        }
        words = [
            {"lineindex": 0, "wordindex": 0, "text": "Mèo", "boundingbox": [0.1, 0.1, 0.2, 0.1]},
            {"lineindex": 1, "wordindex": 0, "text": "Chó", "boundingbox": [0.1, 0.1, 0.2, 0.1]},
        ]
        # Both lines crop the exact same white pixels -> identical image_sha256, different labels!
        fake_db = MagicMock()
        fake_db.execute = AsyncMock(side_effect=[_FakeResult([header_row]), _FakeResult(words)])
        fake_db.commit = AsyncMock()

        class _Ctx:
            async def __aenter__(self):
                return fake_db

            async def __aexit__(self, *_a):
                return False

        with (
            patch.object(outbox_worker, "AsyncSessionLocal", return_value=_Ctx()),
            patch.object(outbox_worker, "download_object", return_value=png),
        ):
            with self.assertRaises(outbox_worker.OutboxEventBlocked) as blocked:
                await outbox_worker._process(event)
        self.assertEqual(blocked.exception.code, "CONFLICTING_LABEL_FOR_IMAGE_HASH")

    async def test_explicit_admin_verified_uploads_crops_and_labels_to_drive_only_not_supabase(self):
        server = InMemoryGoogleDriveServer()
        _, router = _make_drive_router(server)
        png = _make_sample_page_png(400, 200)
        book_id = uuid4()
        event = {
            "id": uuid4(),
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "actor_id": uuid4(),
            "attempts": 1,
        }
        header_row = {
            "imagepath": "books/b1/p1.png",
            "bookid": book_id,
            "visibility_scope": "CATALOG",
            "verificationstatus": "VERIFIED",
            "contenthash": "c" * 64,
            "verifiedby": event["actor_id"],
            "verifiedat": datetime.now(timezone.utc),
            "ai_proofread_mode": "ADMIN_EDITED",
            "ai_reviewed_by": str(event["actor_id"]),
            "ai_automated_by": None,
        }
        words = [
            {"lineindex": 0, "wordindex": 0, "text": "Bé", "boundingbox": [0.1, 0.1, 0.15, 0.1]},
            {"lineindex": 0, "wordindex": 1, "text": "đọc", "boundingbox": [0.28, 0.1, 0.18, 0.1]},
            {"lineindex": 0, "wordindex": 2, "text": "sách.", "boundingbox": [0.5, 0.1, 0.22, 0.1]},
        ]
        inserted_batches: list[list[dict]] = []

        async def fake_execute(stmt, params=None):
            sql = str(stmt)
            if "FROM public.bookpages" in sql:
                return _FakeResult([header_row])
            if "FROM public.pagerevisionwords" in sql:
                return _FakeResult(words)
            if "FROM public.viread_ocr_samples" in sql:
                return _FakeResult([])
            if "INSERT INTO public.viread_ocr_samples" in sql:
                inserted_batches.append(list(params))
                return _FakeResult([])
            return _FakeResult([])

        fake_db = MagicMock()
        fake_db.execute = AsyncMock(side_effect=fake_execute)
        fake_db.commit = AsyncMock()

        class _Ctx:
            async def __aenter__(self):
                return fake_db

            async def __aexit__(self, *_a):
                return False

        with (
            patch.object(outbox_worker, "AsyncSessionLocal", return_value=_Ctx()),
            patch.object(outbox_worker, "download_object", return_value=png),
            patch.object(outbox_worker, "_build_artifact_router", new=AsyncMock(return_value=router)),
            patch.object(outbox_worker, "ensure_database_capacity", new=AsyncMock(return_value={})),
            patch("app.services.storage_service.upload_object") as supabase_upload,
        ):
            await outbox_worker._process(event)

        # Zero blobs written to Supabase Storage!
        supabase_upload.assert_not_called()
        self.assertEqual(len(inserted_batches), 1)
        row = inserted_batches[0][0]
        self.assertEqual(row["label"], "Bé đọc sách.")
        self.assertEqual(row["storage_provider"], "google_drive")
        self.assertTrue(is_gdrive_ref(row["path"]))
        self.assertTrue(is_gdrive_ref(row["label_storage_path"]))
        self.assertIsNotNone(row["drive_file_id"])
        self.assertIsNotNone(row["label_drive_file_id"])

        # Verify label JSON artifact on Drive matches DB provenance
        label_doc = json.loads(router.get(row["label_storage_path"]).decode("utf-8"))
        self.assertEqual(label_doc["label"], "Bé đọc sách.")
        self.assertEqual(label_doc["revision_id"], str(event["revision_id"]))
        self.assertEqual(label_doc["image_reference"], row["path"])
        self.assertEqual(label_doc["image_sha256"], row["image_sha"])
        self.assertEqual(label_doc["label_sha256"], row["label_sha256"])

    async def test_outbox_worker_retries_on_drive_quota_full_and_never_marks_done(self):
        stop = asyncio.Event()
        event_id = uuid4()
        event = {"id": event_id, "page_id": uuid4(), "revision_id": uuid4(), "actor_id": uuid4(), "attempts": 1}
        calls = 0

        async def fake_claim():
            nonlocal calls
            calls += 1
            if calls == 1:
                return event
            stop.set()
            return None

        with (
            patch.object(outbox_worker, "_claim_one", side_effect=fake_claim),
            patch.object(
                outbox_worker,
                "_process_with_lease",
                new=AsyncMock(side_effect=DriveQuotaExceededError("Drive free quota full")),
            ),
            patch.object(outbox_worker, "_finish", new=AsyncMock(return_value=True)) as finish_mock,
            patch.object(outbox_worker, "_wait_for_stop_or_timeout", new=AsyncMock()),
        ):
            await outbox_worker.run_worker(stop, poll_seconds=0)

        finish_mock.assert_awaited_once()
        kwargs = finish_mock.await_args.kwargs
        self.assertEqual(kwargs["status"], "RETRY")
        self.assertEqual(kwargs["error_code"], "DRIVE_QUOTA_EXCEEDED")
        self.assertGreater(kwargs["delay_seconds"], 0)


class Flow2DatasetCheckpointRuntimeAndE2ETests(unittest.IsolatedAsyncioTestCase):
    def test_gtx1650_4gib_vram_is_safely_rejected_for_local_training(self):
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(
                is_available=lambda: True,
                mem_get_info=lambda _idx: (3400 * 1024**2, 4096 * 1024**2),
                get_device_name=lambda _idx: "NVIDIA GeForce GTX 1650",
                get_device_capability=lambda _idx: (7, 5),
            ),
            version=types.SimpleNamespace(cuda="12.6"),
            __version__="2.14.1+cu126",
        )
        with (
            patch.dict(os.environ, {"VIREAD_LOCAL_TRAINING_ENABLED": "true"}),
            patch.dict("sys.modules", {"torch": fake_torch}),
        ):
            ready, info = auto_worker.local_training_capacity()
        self.assertFalse(ready)
        self.assertEqual(info["reason"], "INSUFFICIENT_VRAM")
        self.assertEqual(info["device"], "NVIDIA GeForce GTX 1650")

    async def test_isolated_e2e_drive_first_dataset_checkpoint_benchmark_approval_runtime_and_rollback(self):
        """Test Group K: Isolated end-to-end Flow 2 pipeline on simulated private Google Drive."""
        server = InMemoryGoogleDriveServer()
        store, router = _make_drive_router(server)
        actor_id = uuid4()
        dataset_id = uuid4()
        run_id = uuid4()

        # 1. Seed 2 verified groups (1 train group, 1 validation group) + 1 AI-only row that MUST be excluded
        img_train = _make_sample_page_png(220, 60, (250, 250, 250))
        img_val = _make_sample_page_png(220, 60, (240, 240, 240))
        img_ai = _make_sample_page_png(220, 60, (230, 230, 230))
        stored_train = router.put("verified-samples/rev-t/line-0000.png", img_train, content_type="image/png")
        stored_val = router.put("verified-samples/rev-v/line-0000.png", img_val, content_type="image/png")

        # Find two group IDs that deterministically land in train vs validation
        train_group = next(g for i in range(100) if training_svc._verified_training_split(g := f"book-train-{i}") == "train")
        val_group = next(g for i in range(100) if training_svc._verified_training_split(g := f"book-val-{i}") == "validation")

        source_samples = [
            {
                "sample_id": str(uuid4()),
                "group_id": train_group,
                "split": "train",
                "image_storage_path": stored_train.reference,
                "image_sha256": stored_train.sha256,
                "label": "Con mèo trèo cây cau",
                "source_page_id": uuid4(),
                "source_revision_id": uuid4(),
                "provenance": {"verified_by_admin": True, "ai_review_required": False, "verification_source": "admin"},
            },
            {
                "sample_id": str(uuid4()),
                "group_id": val_group,
                "split": "validation",
                "image_storage_path": stored_val.reference,
                "image_sha256": stored_val.sha256,
                "label": "Hỏi thăm chú chuột đi đâu vắng nhà",
                "source_page_id": uuid4(),
                "source_revision_id": uuid4(),
                "provenance": {"verified_by_admin": True, "ai_review_required": False, "verification_source": "admin"},
            },
            {
                "sample_id": str(uuid4()),
                "group_id": "book-ai-only",
                "split": "train",
                "image_storage_path": "gdrive://fake_ai_only_00001",
                "image_sha256": hashlib.sha256(img_ai).hexdigest(),
                "label": "Nhãn AI tự duyệt cấm dùng",
                "source_page_id": uuid4(),
                "source_revision_id": uuid4(),
                "provenance": {"verified_by_admin": False, "ai_review_required": True, "verification_source": "ai_auto"},
            },
        ]

        stored_datasets: dict[str, dict] = {}
        stored_snapshot_rows: list[dict] = []
        stored_chunks: list[dict] = []
        run_state: dict = {
            "id": run_id,
            "profile": "FLOW2_ADMIN_VERIFIED",
            "status": "CREATED",
            "dataset_version_id": dataset_id,
            "parent_checkpoint_sha256": training_svc.ORIGINAL_SHA256,
            "manifest_sha256": "",
            "config_sha256": "c" * 64,
            "architecture_sha256": training_svc.ORIGINAL_ARCHITECTURE_SHA256,
            "vocabulary_sha256": training_svc.ORIGINAL_VOCAB_SHA256,
            "checkpoint_sha256": None,
            "checkpoint_bytes": None,
            "checkpoint_storage_path": None,
            "step": 0,
        }
        active_state = {
            "model_family": "vgg_transformer",
            "checkpoint_sha256": training_svc.ORIGINAL_SHA256,
            "storage_path": None,
            "profile": "ORIGINAL",
            "decision_id": None,
        }
        decisions: dict[UUID, dict] = {}
        benchmarks_db: dict[UUID, dict] = {}

        class _InMemoryTrainingRepo:
            async def one(self, sql: str, params=None):
                params = params or {}
                if "FROM public.viread_ocr_dataset_versions" in sql and "WHERE source_flow='FLOW1_VERIFIED'" in sql:
                    return stored_datasets.get(params.get("version_sha"))
                if "INSERT INTO public.viread_ocr_dataset_versions" in sql:
                    rec = {
                        "id": dataset_id,
                        "version_sha256": params["version_sha"],
                        "manifest_storage_path": params["manifest_path"],
                        "sample_count": params["sample_count"],
                    }
                    stored_datasets[params["version_sha"]] = rec
                    return rec
                if "SELECT count(*)::integer AS total" in sql:
                    return {"total": len(stored_snapshot_rows)}
                if "FROM public.viread_ocr_training_runs WHERE id=" in sql:
                    return dict(run_state)
                if "FROM public.viread_ocr_checkpoint_chunks WHERE run_id=" in sql:
                    return next((c for c in stored_chunks if c["chunk_index"] == params["chunk_index"]), None)
                if "FROM public.viread_ocr_active_model" in sql:
                    return dict(active_state)
                if "FROM public.viread_ocr_benchmarks WHERE id=" in sql:
                    return benchmarks_db.get(params["id"])
                if "FROM public.viread_ocr_model_decisions WHERE id=" in sql:
                    return decisions.get(params["id"])
                return None

            async def all(self, sql: str, params=None):
                if "FROM public.viread_ocr_samples sample" in sql and "dataset_version_id IS NULL" in sql:
                    return [dict(r) for r in source_samples]
                if "FROM public.viread_ocr_samples" in sql and "WHERE dataset_version_id=" in sql:
                    return [
                        {
                            "sample_id": r["source_annotation_id"],
                            "group_id": r["group_id"],
                            "split": r["split"],
                            "image_storage_path": r["path"],
                            "image_sha256": r["image_sha"],
                            "label": r["label"],
                            "source_revision_id": str(r["source_revision_id"]),
                        }
                        for r in stored_snapshot_rows
                    ]
                if "FROM public.viread_ocr_checkpoint_chunks" in sql:
                    return list(stored_chunks)
                return []

            async def execute(self, sql: str, params=None):
                if "INSERT INTO public.viread_ocr_samples" in sql and isinstance(params, list):
                    stored_snapshot_rows.extend(params)
                elif "INSERT INTO public.viread_ocr_checkpoint_chunks" in sql:
                    stored_chunks.append({
                        "chunk_index": params["chunk_index"],
                        "chunk_sha256": params["digest"],
                        "storage_path": params["path"],
                        "byte_count": params["byte_count"],
                    })
                elif "UPDATE public.viread_ocr_training_runs SET status='RUNNING'" in sql:
                    run_state["status"] = "RUNNING"
                elif "UPDATE public.viread_ocr_training_runs SET status='CANDIDATE'" in sql:
                    run_state.update({
                        "status": "CANDIDATE",
                        "checkpoint_sha256": params["sha"],
                        "checkpoint_bytes": params["bytes"],
                        "checkpoint_storage_path": params["path"],
                        "step": params["step"],
                    })
                elif "INSERT INTO public.viread_ocr_model_decisions" in sql:
                    decisions[params["id"]] = {
                        "action": params["action"],
                        "candidate_checkpoint_sha256": params["candidate_sha"],
                        "previous_checkpoint_sha256": params["previous_sha"],
                        "candidate_storage_path": params["candidate_path"],
                        "previous_storage_path": params["previous_path"],
                        "candidate_profile": params["candidate_profile"],
                        "previous_profile": params["previous_profile"],
                    }
                elif "UPDATE public.viread_ocr_active_model" in sql and "SET checkpoint_sha256=" in sql:
                    active_state.update({
                        "checkpoint_sha256": params["sha"],
                        "storage_path": params["path"],
                        "profile": params["profile"],
                        "decision_id": params["decision_id"],
                    })

            async def commit(self):
                return None

            async def rollback(self):
                return None

        service = training_svc.VireadOcrTrainingService(MagicMock())
        service.repo = _InMemoryTrainingRepo()
        service._admin = AsyncMock()
        service._artifact_router = AsyncMock(return_value=router)

        # 2. Snapshot Flow 2 dataset onto Google Drive (verify AI-only row excluded & zero Supabase writes!)
        with (
            patch.object(training_svc, "ensure_database_capacity", new=AsyncMock(return_value={})),
            patch.object(training_svc, "upload_object") as supabase_upload,
        ):
            manifest_resp = await service.admin_verified_manifest(actor_id, limit=50, offset=0)
            supabase_upload.assert_not_called()

        self.assertEqual(manifest_resp["total"], 2)
        self.assertEqual(manifest_resp["storage_provider"], "google_drive")
        self.assertTrue(is_gdrive_ref(manifest_resp["manifest_storage_path"]))
        self.assertNotIn("Nhãn AI tự duyệt cấm dùng", [item["label"] for item in manifest_resp["items"]])
        run_state["manifest_sha256"] = manifest_resp["manifest_sha256"]

        # Verify manifest.json on Drive matches version_sha256
        drive_manifest_bytes = router.get(manifest_resp["manifest_storage_path"])
        self.assertEqual(hashlib.sha256(drive_manifest_bytes).hexdigest(), manifest_resp["manifest_sha256"])

        # 3. Upload candidate checkpoint shards & finalize onto Google Drive
        shard0 = b"PK\x03\x04" + b"flow2-checkpoint-shard-0" * 500
        shard1 = b"flow2-checkpoint-shard-1" * 500
        full_ckpt = shard0 + shard1
        full_sha = hashlib.sha256(full_ckpt).hexdigest()

        with patch.object(training_svc, "upload_object") as supabase_upload:
            up0 = await service.upload_checkpoint_chunk(actor_id, run_id, 0, shard0)
            up1 = await service.upload_checkpoint_chunk(actor_id, run_id, 1, shard1)
            self.assertEqual(up0["storage_provider"], "google_drive")
            self.assertEqual(up1["storage_provider"], "google_drive")

            completed = await service.complete_run(
                actor_id,
                run_id,
                TrainingRunComplete(
                    profile="FLOW2_ADMIN_VERIFIED",
                    parent_checkpoint_sha256=training_svc.ORIGINAL_SHA256,
                    manifest_sha256=run_state["manifest_sha256"],
                    config_sha256=run_state["config_sha256"],
                    architecture_sha256=training_svc.ORIGINAL_ARCHITECTURE_SHA256,
                    vocabulary_sha256=training_svc.ORIGINAL_VOCAB_SHA256,
                    checkpoint_sha256=full_sha,
                    checkpoint_bytes=len(full_ckpt),
                    step=5000,
                ),
            )
            supabase_upload.assert_not_called()

        self.assertEqual(completed["status"], "CANDIDATE")
        self.assertTrue(is_gdrive_ref(completed["manifest_storage_path"]))
        # Candidate is NOT active yet!
        self.assertEqual(active_state["profile"], "ORIGINAL")

        # 4. Pilot / failed gate cannot be approved; only Production V2_WIN + Admin approval activates!
        pilot_bench_id = uuid4()
        benchmarks_db[pilot_bench_id] = {
            "id": pilot_bench_id,
            "run_id": run_id,
            "candidate_checkpoint_sha256": full_sha,
            "gate_status": "V2_WIN",
            "evaluation_type": "PILOT",
            "parent_checkpoint_sha256": training_svc.ORIGINAL_SHA256,
            "active_checkpoint_sha256": training_svc.ORIGINAL_SHA256,
        }
        run_state["status"] = "BENCHMARKED"
        with self.assertRaises(HTTPException) as pilot_err:
            await service.decide(
                actor_id,
                ModelDecisionRequest(
                    action="APPROVE",
                    run_id=run_id,
                    benchmark_id=pilot_bench_id,
                    reason="Trying to approve a pilot evaluation must fail",
                ),
            )
        self.assertEqual(pilot_err.exception.status_code, 409)

        prod_bench_id = uuid4()
        benchmarks_db[prod_bench_id] = {
            **benchmarks_db[pilot_bench_id],
            "id": prod_bench_id,
            "evaluation_type": "PRODUCTION",
        }
        approved = await service.decide(
            actor_id,
            ModelDecisionRequest(
                action="APPROVE",
                run_id=run_id,
                benchmark_id=prod_bench_id,
                reason="Production Locked Test passed V2_WIN across all baselines",
            ),
        )
        self.assertEqual(approved["active_model"]["storage_provider"], "google_drive")
        self.assertEqual(approved["active_model"]["checkpoint_sha256"], full_sha)
        self.assertTrue(is_gdrive_ref(approved["active_model"]["storage_path"]))

        # 5. Runtime loading via ocr_engine._v2_artifact_from_storage streams from Google Drive & verifies SHA!
        register_runtime_drive_store_factory(lambda: store)
        try:
            ocr_engine.evict_cached_viread_checkpoint(full_sha)
            local_path, cfg, cfg_sha = ocr_engine._v2_artifact_from_storage(approved["active_model"])
            self.assertEqual(Path(local_path).read_bytes(), full_ckpt)
            self.assertIsNone(cfg)
            self.assertIsNone(cfg_sha)

            # Corrupt Drive shard -> evict local cache -> runtime MUST reject tampered checkpoint & leave no corrupt cache
            ocr_engine.evict_cached_viread_checkpoint(full_sha)
            first_shard_id = stored_chunks[0]["storage_path"].removeprefix("gdrive://")
            original_shard_bytes = server.contents[first_shard_id]
            server.contents[first_shard_id] = b"TAMPERED" * 10
            with self.assertRaises((DriveIntegrityError, ValueError)):
                ocr_engine._v2_artifact_from_storage(approved["active_model"])
            self.assertFalse(Path(local_path).exists())
            server.contents[first_shard_id] = original_shard_bytes

            # Runtime read-only status reflects uninitialized/loaded model honestly
            rt_status = ocr_engine.get_loaded_vietocr_runtime_status()
            self.assertIn("initialized", rt_status)
            self.assertIn("loaded_checkpoint_sha256", rt_status)
        finally:
            ocr_engine.evict_cached_viread_checkpoint(full_sha)
            register_runtime_drive_store_factory(None)

        # 6. Admin rollback returns active pointer cleanly to ORIGINAL without deleting Drive checkpoint!
        rolled_back = await service.decide(
            actor_id,
            ModelDecisionRequest(
                action="ROLLBACK",
                reason="Rollback test verification keeping candidate checkpoint on Drive",
            ),
        )
        self.assertEqual(rolled_back["active_model"]["profile"], "ORIGINAL")
        self.assertEqual(rolled_back["active_model"]["checkpoint_sha256"], training_svc.ORIGINAL_SHA256)
        self.assertTrue(router.exists(completed["manifest_storage_path"]))

    def test_warm_loaded_v2_model_skips_drive_refetch_and_survives_drive_outage(self):
        """CRIT-03 regression: already-loaded verified V2 model must not hit Drive or evict on blip."""
        ckpt_sha = "7" * 64
        drive_ref = "gdrive://drv_active_warm_001"
        fake_predictor = MagicMock()
        fake_paddle = MagicMock()
        orig_state = (
            ocr_engine._paddle_engine,
            ocr_engine._vietocr_engine,
            ocr_engine._vietocr_active_checkpoint_sha,
            ocr_engine._vietocr_active_profile,
            ocr_engine._vietocr_active_config_sha,
            ocr_engine._vietocr_active_storage_path,
            ocr_engine._ocr_dependencies_loaded,
        )
        try:
            ocr_engine._paddle_engine = fake_paddle
            ocr_engine._vietocr_engine = fake_predictor
            ocr_engine._vietocr_active_checkpoint_sha = ckpt_sha
            ocr_engine._vietocr_active_profile = "FLOW2_ADMIN_VERIFIED"
            ocr_engine._vietocr_active_config_sha = None
            ocr_engine._vietocr_active_storage_path = drive_ref
            ocr_engine._ocr_dependencies_loaded = True
            ocr_engine._verified_vietocr_instance(
                fake_predictor,
                model_profile="FLOW2_ADMIN_VERIFIED",
                checkpoint_sha256=ckpt_sha,
                config_sha256=None,
            )
            with (
                patch.object(
                    ocr_engine,
                    "_active_viread_model",
                    return_value={
                        "checkpoint_sha256": ckpt_sha,
                        "profile": "FLOW2_ADMIN_VERIFIED",
                        "storage_path": drive_ref,
                    },
                ),
                patch.object(
                    ocr_engine,
                    "_v2_artifact_from_storage",
                    side_effect=AssertionError("Must not hit Google Drive when exact V2 model is already loaded"),
                ),
            ):
                paddle_out, viet_out = ocr_engine._get_ocr_engines()
            self.assertIs(paddle_out, fake_paddle)
            self.assertIs(viet_out, fake_predictor)
        finally:
            (
                ocr_engine._paddle_engine,
                ocr_engine._vietocr_engine,
                ocr_engine._vietocr_active_checkpoint_sha,
                ocr_engine._vietocr_active_profile,
                ocr_engine._vietocr_active_config_sha,
                ocr_engine._vietocr_active_storage_path,
                ocr_engine._ocr_dependencies_loaded,
            ) = orig_state

    def test_outbox_visibility_scope_supports_main_schema_and_blocks_parent_private(self) -> None:
        """Outbox allows main schema (visibility_scope=None) and skips PARENT_PRIVATE books."""
        event = {
            "id": uuid4(),
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "actor_id": uuid4(),
            "attempts": 1,
        }
        private_header = {
            "imagepath": "pages/private.png",
            "bookid": uuid4(),
            "verificationstatus": "VERIFIED",
            "contenthash": "a" * 64,
            "verifiedby": uuid4(),
            "verifiedat": "2026-11-21T00:00:00+00:00",
            "ai_proofread_mode": None,
            "visibility_scope": "PARENT_PRIVATE",
            "ai_reviewed_by": None,
            "ai_automated_by": None,
        }

        def _make_ctx(results: list[_FakeResult]):
            db = MagicMock()
            db.execute = AsyncMock(side_effect=results)
            db.commit = AsyncMock()

            class _Ctx:
                async def __aenter__(self):
                    return db

                async def __aexit__(self, *_a):
                    return False

            return _Ctx()

        with patch.object(
            outbox_worker,
            "AsyncSessionLocal",
            return_value=_make_ctx([_FakeResult([private_header])]),
        ):
            with self.assertRaises(outbox_worker.OutboxEventSkipped) as ctx:
                asyncio.run(outbox_worker._process(event))
        self.assertEqual(ctx.exception.code, "PARENT_PRIVATE_BOOK_EXCLUDED")

        # Main schema without visibility_scope column returns NULL -> proceeds past scope check.
        main_header = dict(private_header)
        main_header["visibility_scope"] = None
        with patch.object(
            outbox_worker,
            "AsyncSessionLocal",
            return_value=_make_ctx([_FakeResult([main_header]), _FakeResult([])]),
        ):
            with self.assertRaises(ValueError) as ctx_main:
                asyncio.run(outbox_worker._process(event))
        self.assertIn("no words", str(ctx_main.exception))


if __name__ == "__main__":
    unittest.main()
