from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.jobs import viread_ocr_outbox_worker as outbox_worker
from app.jobs import viread_ocr_training_auto_worker as auto_worker
from app.services.training_storage.google_drive_desktop_store import GoogleDriveDesktopStore
from app.services.training_storage.router import TrainingArtifactStoreRouter
from app.services.training_storage.base import StorageProvider
from app.services.viread_ocr_training_service import VireadOcrTrainingService
from scripts import flow2_clean_ingest as clean_ingest


def _make_sharp_line_png(text_seed: str, width: int = 240, height: int = 44) -> bytes:
    """Create a deterministic high-contrast synthetic line image with sharp edges."""
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    digest = hashlib.sha256(text_seed.encode("utf-8")).digest()
    for i in range(10, width - 10, 12):
        h = 10 + (digest[i % len(digest)] % (height - 16))
        draw.rectangle([i, 6, i + 4, h], fill=(15, 15, 15))
    draw.line([(8, height - 8), (width - 8, height - 8)], fill=(30, 30, 30), width=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_blank_png(width: int = 240, height: int = 44) -> bytes:
    img = Image.new("RGB", (width, height), color=(250, 250, 250))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class _InMemoryFlow2Repo:
    """Minimal isolated fake repo exercising real SQL-level filtering contracts."""

    def __init__(self) -> None:
        self.samples: list[dict] = []
        self.datasets: list[dict] = []
        self.active_model = {
            "profile": "FLOW1_EXTERNAL_TRDG",
            "checkpoint_sha256": "2" * 64,
            "storage_path": "ocr-training/checkpoints/flow1-manual/abc/checkpoint.manifest.json",
        }
        self.runs = [
            {
                "id": "86fd0cde-54f9-4fac-9146-80351ed05ec2",
                "status": "BENCHMARKED",
                "step": 5000,
                "checkpoint_sha256": "0" * 64,
            }
        ]

    async def execute(self, sql: str, params=None):
        sql_norm = " ".join(sql.split())
        if "INSERT INTO public.viread_ocr_dataset_versions" in sql_norm:
            self.datasets.append(
                {
                    "id": params["id"],
                    "source_flow": "FLOW1_VERIFIED",
                    "version_sha256": params["version_sha"],
                    "manifest_storage_path": params["path"],
                    "sample_count": params["count"],
                    "dataset_status": "ACTIVE",
                }
            )
        elif "INSERT INTO public.viread_ocr_samples" in sql_norm and isinstance(params, list):
            for row in params:
                self.samples.append(
                    {
                        "id": str(uuid4()),
                        "dataset_version_id": row.get("dataset_version_id") or row.get("dataset_id"),
                        "source_flow": "FLOW1_VERIFIED",
                        "source_group_id": row.get("source_group_id") or row.get("group_id"),
                        "split": row["split"],
                        "image_storage_path": row.get("image_storage_path") or row.get("path"),
                        "image_sha256": row.get("image_sha256") or row.get("image_sha"),
                        "label": row["label"],
                        "source_page_id": row.get("source_page_id") or row.get("page_id"),
                        "source_revision_id": row.get("source_revision_id") or row.get("revision_id"),
                        "provenance": json.loads(row["provenance"]) if isinstance(row.get("provenance"), str) else row.get("provenance", {}),
                        "training_eligibility": "ELIGIBLE",
                    }
                )
        return MagicMock(rowcount=1)

    async def all(self, sql: str, params=None):
        sql_norm = " ".join(sql.split())
        if "FROM public.viread_ocr_samples sample" in sql_norm and "dataset_version_id IS NULL" in sql_norm:
            # Verify the SQL actually filters by training_eligibility = 'ELIGIBLE'
            assert "training_eligibility" in sql_norm, "Query must filter training_eligibility"
            return [
                {
                    "sample_id": s["id"],
                    "group_id": s["source_group_id"],
                    "split": s["split"],
                    "image_storage_path": s["image_storage_path"],
                    "image_sha256": s["image_sha256"],
                    "label": s["label"],
                    "source_page_id": s.get("source_page_id"),
                    "source_revision_id": s.get("source_revision_id"),
                    "provenance": s["provenance"],
                }
                for s in self.samples
                if s["source_flow"] == "FLOW1_VERIFIED"
                and s["dataset_version_id"] is None
                and s.get("training_eligibility", "ELIGIBLE") == "ELIGIBLE"
                and s["provenance"].get("verified_by_admin") is True
                and not s["provenance"].get("ai_review_required")
                and s["provenance"].get("verification_source", "admin") == "admin"
            ]
        if "FROM public.viread_ocr_samples" in sql_norm and "dataset_version_id=:dataset_id" in sql_norm:
            did = params["dataset_id"]
            return [s for s in self.samples if s["dataset_version_id"] == did]
        return []

    async def one(self, sql: str, params=None):
        sql_norm = " ".join(sql.split())
        if "INSERT INTO public.viread_ocr_dataset_versions" in sql_norm:
            rec = {
                "id": params.get("id", uuid4()),
                "source_flow": "FLOW1_VERIFIED",
                "version_sha256": params["version_sha"],
                "manifest_storage_path": params["manifest_path"],
                "sample_count": params["sample_count"],
                "dataset_status": "ACTIVE",
            }
            self.datasets.append(rec)
            return rec
        if "FROM public.viread_ocr_dataset_versions dv" in sql_norm and "ORDER BY dv.created_at DESC LIMIT 1" in sql_norm:
            assert "dataset_status" in sql_norm, "Fallback query must filter dataset_status='ACTIVE'"
            active = [d for d in self.datasets if d.get("dataset_status", "ACTIVE") == "ACTIVE"]
            return active[-1] if active else None
        if "FROM public.viread_ocr_dataset_versions" in sql_norm and "version_sha256=:version_sha" in sql_norm:
            for d in self.datasets:
                if d["version_sha256"] == params["version_sha"]:
                    return d
            return None
        if "SELECT count(*)::integer AS total" in sql_norm:
            did = params["dataset_id"]
            return {"total": sum(1 for s in self.samples if s["dataset_version_id"] == did)}
        return None

    async def commit(self):
        return None

    async def rollback(self):
        return None


class Flow2CleanupAndCleanIngestTests(unittest.IsolatedAsyncioTestCase):
    async def test_1_archived_pool_and_datasets_excluded_while_flow1_and_old_run_preserved(self):
        repo = _InMemoryFlow2Repo()
        # Seed old archived Flow 2 pool sample + archived historical dataset
        repo.samples.append(
            {
                "id": str(uuid4()),
                "dataset_version_id": None,
                "source_flow": "FLOW1_VERIFIED",
                "source_group_id": "old-noisy-book",
                "split": "train",
                "image_storage_path": "gdrive://gdesk_old_1",
                "image_sha256": "a" * 64,
                "label": "nhãn cũ sai",
                "provenance": {"verified_by_admin": True, "ai_review_required": False, "verification_source": "admin"},
                "training_eligibility": "ARCHIVED",
            }
        )
        repo.datasets.append(
            {
                "id": uuid4(),
                "source_flow": "FLOW1_VERIFIED",
                "version_sha256": "b" * 64,
                "manifest_storage_path": "gdrive://gdesk_old_manifest",
                "sample_count": 146,
                "dataset_status": "ARCHIVED",
            }
        )

        svc = VireadOcrTrainingService(MagicMock())
        svc.repo = repo
        svc._admin = AsyncMock()

        res = await svc.admin_verified_manifest(uuid4(), limit=10, offset=0)
        self.assertIsNone(res["dataset_version_id"])
        self.assertEqual(res["total"], 0)
        self.assertEqual(res["items"], [])
        # Flow 1 active model & historical run 86fd0cde untouched
        self.assertEqual(repo.active_model["profile"], "FLOW1_EXTERNAL_TRDG")
        self.assertEqual(repo.runs[0]["id"], "86fd0cde-54f9-4fac-9146-80351ed05ec2")
        self.assertEqual(repo.runs[0]["step"], 5000)

    async def test_2_workers_respect_pause_and_never_resurrect_archived_samples(self):
        with patch.dict(os.environ, {"VIREAD_FLOW2_INGESTION_PAUSED": "true"}):
            self.assertTrue(outbox_worker.is_flow2_ingestion_paused())
            scheduled = await auto_worker._schedule_ready_flow2()
            self.assertEqual(scheduled, 0)

        # Outbox conflict check SQL must exclude archived/quarantined rows
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.mappings.return_value.all.return_value = []
        mock_db.execute.return_value = mock_res
        conflicts = await outbox_worker._find_conflicting_labels(mock_db, {"a" * 64: "nhãn mới đúng"})
        self.assertEqual(conflicts, [])
        executed_sql = str(mock_db.execute.call_args[0][0])
        self.assertIn("training_eligibility", executed_sql)

    def test_3_quality_verification_rights_and_leakage_gates(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            sharp_bytes = _make_sharp_line_png("line-clean-1")
            sharp_path = base / "clean1.png"
            sharp_path.write_bytes(sharp_bytes)
            sharp_sha = hashlib.sha256(sharp_bytes).hexdigest()

            sharp2_bytes = _make_sharp_line_png("line-clean-2")
            sharp2_path = base / "clean2.png"
            sharp2_path.write_bytes(sharp2_bytes)

            blank_path = base / "blank.png"
            blank_path.write_bytes(_make_blank_png())

            records = [
                # Valid NFC-normalizable Vietnamese sample (decomposed NFD input -> NFC output)
                {
                    "image_path": "clean1.png",
                    "label": "Tie\u0302\u0301ng Vie\u0323\u0302t đe\u0323p.",
                    "source_group_id": "clean-book-A",
                    "source_name": "Authorized Reader A",
                    "rights_basis": "owner_supplied",
                    "verification_status": "VERIFIED",
                    "verification_source": "admin",
                    "verified_by": "admin-1",
                    "verified_at": "2026-11-22T02:00:00Z",
                },
                # Unverified / AI-only -> MUST route to pending_review
                {
                    "image_path": "clean2.png",
                    "label": "Nhãn AI chưa duyệt",
                    "source_group_id": "clean-book-B",
                    "source_name": "Authorized Reader B",
                    "rights_basis": "owner_supplied",
                    "verification_status": "NEEDS_REVIEW",
                    "verification_source": "ai_auto",
                    "verified_by": "",
                },
                # Blank / blurry image -> rejected
                {
                    "image_path": "blank.png",
                    "label": "Ảnh trắng mờ",
                    "source_group_id": "clean-book-C",
                    "source_name": "Authorized Reader C",
                    "rights_basis": "owner_supplied",
                    "verification_status": "VERIFIED",
                    "verification_source": "admin",
                    "verified_by": "admin-1",
                },
                # Duplicate in batch -> rejected
                {
                    "image_path": "clean1.png",
                    "label": "Tiếng Việt đẹp.",
                    "source_group_id": "clean-book-A",
                    "source_name": "Authorized Reader A",
                    "rights_basis": "owner_supplied",
                    "verification_status": "VERIFIED",
                    "verification_source": "admin",
                    "verified_by": "admin-1",
                },
                # Locked Test group leakage -> rejected
                {
                    "image_path": "clean2.png",
                    "label": "Mẫu trùng nhóm Locked Test",
                    "source_group_id": "locked-group-01",
                    "source_name": "Locked Test Book",
                    "rights_basis": "owner_supplied",
                    "verification_status": "VERIFIED",
                    "verification_source": "admin",
                    "verified_by": "admin-1",
                },
            ]

            accepted, rejected = clean_ingest.validate_batch(
                records,
                base_dir=base,
                locked_test_hashes={"f" * 64},
                locked_test_groups={"locked-group-01"},
            )
            self.assertEqual(len(accepted), 1)
            self.assertEqual(accepted[0].label, "Tiếng Việt đẹp.")
            self.assertEqual(
                accepted[0].image_sha256,
                hashlib.sha256(accepted[0].image_bytes).hexdigest(),
            )
            reasons = {r.reason_code for r in rejected}
            self.assertIn("NOT_ADMIN_VERIFIED", reasons)
            self.assertIn("BLANK_OR_LOW_CONTRAST", reasons)
            self.assertIn("DUPLICATE_IN_BATCH", reasons)
            self.assertIn("LOCKED_TEST_GROUP_LEAKAGE", reasons)
            pending = [r for r in rejected if r.route_to_pending_review]
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0].reason_code, "NOT_ADMIN_VERIFIED")

    async def test_4_e2e_idempotent_ingest_to_drive_and_clean_manifest_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            drive_root = base / "mock_drive"
            drive_root.mkdir()
            store = GoogleDriveDesktopStore(root_dir=drive_root)
            router = TrainingArtifactStoreRouter(
                write_provider=StorageProvider.GOOGLE_DRIVE,
                drive_store_factory=lambda: store,
            )

            # Create 2 clean groups so Train & Validation splits have zero group overlap
            records = []
            for idx, (grp, lbl) in enumerate([
                ("clean-group-alpha", "Con mèo trèo cây cau."),
                ("clean-group-beta", "Đàn vịt bơi dưới ao."),
            ]):
                img_file = base / f"line_{idx}.png"
                img_file.write_bytes(_make_sharp_line_png(f"{grp}-{lbl}"))
                records.append(
                    {
                        "image_path": img_file.name,
                        "label": lbl,
                        "source_group_id": grp,
                        "source_name": f"Clean Book {idx}",
                        "rights_basis": "owner_supplied",
                        "verification_status": "VERIFIED",
                        "verification_source": "admin",
                        "verified_by": "admin-1",
                        "verified_at": "2026-11-22T02:00:00Z",
                        "line_index": idx,
                    }
                )

            accepted, rejected = clean_ingest.validate_batch(records, base_dir=base)
            self.assertEqual(len(accepted), 2)
            self.assertEqual(len(rejected), 0)

            # Fake DB enforcing idempotency by sample_id
            inserted_ids: set[str] = set()
            repo = _InMemoryFlow2Repo()

            class _IdempotentDb:
                async def execute(self, stmt, params):
                    sid = params["sample_id"]
                    if sid in inserted_ids:
                        return MagicMock(rowcount=0)
                    inserted_ids.add(sid)
                    repo.samples.append(
                        {
                            "id": sid,
                            "dataset_version_id": None,
                            "source_flow": "FLOW1_VERIFIED",
                            "source_group_id": params["group_id"],
                            "split": params["split"],
                            "image_storage_path": params["image_ref"],
                            "image_sha256": params["image_sha"],
                            "label": params["label"],
                            "source_page_id": None,
                            "source_revision_id": None,
                            "provenance": json.loads(params["provenance"]),
                            "training_eligibility": "ELIGIBLE",
                        }
                    )
                    return MagicMock(rowcount=1)

                async def commit(self):
                    return None

            db = _IdempotentDb()
            first = await clean_ingest.ingest_validated_samples(accepted, db=db, router=router)
            second = await clean_ingest.ingest_validated_samples(accepted, db=db, router=router)
            self.assertEqual(first, {"inserted": 2, "skipped_existing": 0})
            self.assertEqual(second, {"inserted": 0, "skipped_existing": 2})

            # Verify Drive files actually exist and match SHA-256 + labels
            for row in repo.samples:
                self.assertTrue(row["image_storage_path"].startswith("gdrive://"))
                got_bytes = router.get(row["image_storage_path"], expected_sha256=row["image_sha256"])
                self.assertEqual(hashlib.sha256(got_bytes).hexdigest(), row["image_sha256"])
                lbl_bytes = router.get(row["provenance"]["label_reference"])
                lbl_obj = json.loads(lbl_bytes.decode("utf-8"))
                self.assertEqual(lbl_obj["label"], row["label"])

            # Verify immutable manifest creation contains ONLY the 2 clean samples (no archived old ones)
            repo.samples.append(
                {
                    "id": str(uuid4()),
                    "dataset_version_id": None,
                    "source_flow": "FLOW1_VERIFIED",
                    "source_group_id": "archived-old-book",
                    "split": "train",
                    "image_storage_path": "gdrive://gdesk_archived",
                    "image_sha256": "c" * 64,
                    "label": "mẫu cũ đã loại",
                    "provenance": {"verified_by_admin": True, "ai_review_required": False, "verification_source": "admin"},
                    "training_eligibility": "ARCHIVED",
                }
            )
            svc = VireadOcrTrainingService(MagicMock())
            svc.repo = repo
            svc._admin = AsyncMock()
            svc._artifact_router = AsyncMock(return_value=router)
            with patch("app.services.viread_ocr_training_service.ensure_database_capacity", new=AsyncMock()):
                manifest_res = await svc.admin_verified_manifest(uuid4(), limit=10, offset=0)

            self.assertIsNotNone(manifest_res["dataset_version_id"])
            self.assertEqual(manifest_res["total"], 2)
            self.assertEqual(manifest_res["storage_provider"], "google_drive")
            self.assertTrue(manifest_res["manifest_storage_path"].startswith("gdrive://"))
            # Verify no group appears in both train and validation
            snap_rows = [s for s in repo.samples if s["dataset_version_id"] is not None]
            train_groups = {s["source_group_id"] for s in snap_rows if s["split"] == "train"}
            val_groups = {s["source_group_id"] for s in snap_rows if s["split"] == "validation"}
            self.assertEqual(train_groups & val_groups, set())
            self.assertNotIn("archived-old-book", train_groups | val_groups)


if __name__ == "__main__":
    unittest.main()
