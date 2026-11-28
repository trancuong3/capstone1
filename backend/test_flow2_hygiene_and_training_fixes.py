"""Regression tests for Flow 2 hygiene gates, headers, schema, splits, and worker recovery."""

from __future__ import annotations

from io import BytesIO
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unicodedata
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from PIL import Image, ImageFilter

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.api.routes.admin_viread_training import (  # noqa: E402
    retry_failed_viread_colab_training_job,
)
from app.database.config import is_supabase_jwt_key, supabase_admin_headers  # noqa: E402
from app.schemas.viread_ocr_training import BenchmarkCreate  # noqa: E402
from app.services.training_storage.base import DriveNotConnectedError  # noqa: E402
from app.services.training_storage.google_drive_desktop_store import (  # noqa: E402
    GoogleDriveDesktopStore,
)
from app.services.viread_flow2_hygiene import (  # noqa: E402
    LOCKED_VIETOCR_VOCAB,
    detect_vietnamese_pii_strict,
    open_image_exif_safe,
    sanitize_and_validate_vietocr_label,
    validate_flow2_line_crop,
    validate_line_word_geometry,
)
from app.services.viread_ocr_training_service import (  # noqa: E402
    ORIGINAL_VOCAB_SHA256,
    _assign_leak_safe_splits,
)


def _crisp_line_image(width: int = 240, height: int = 48) -> Image.Image:
    img = Image.new("RGB", (width, height), (255, 255, 255))
    for x in range(6, width - 4, 9):
        img.paste((20, 20, 20), (x, 8, min(x + 2, width - 1), height - 8))
    return img


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _MappingsResult:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class _RowResult:
    def __init__(self, row):
        self._row = row

    def mappings(self):
        return _MappingsResult(self._row)


class _EmptyResult:
    rowcount = 1


class _FakeDb:
    def __init__(self, results):
        self._results = list(results)
        self.calls: list[str] = []
        self.committed = False
        self.rolled_back = False

    async def execute(self, statement, params=None):
        self.calls.append(str(statement))
        if not self._results:
            return _EmptyResult()
        return self._results.pop(0)

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


class Flow2HygieneAndTrainingFixesTests(unittest.TestCase):
    def test_locked_vocab_matches_original_sha256_and_label_sanitization(self):
        import hashlib
        import json

        vocab_sha = hashlib.sha256(
            json.dumps(LOCKED_VIETOCR_VOCAB, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        self.assertEqual(vocab_sha, ORIGINAL_VOCAB_SHA256)

        nfd = unicodedata.normalize("NFD", "Chào\u200b “bé” — lớp\u00a0Bốn…")
        cleaned, reason = sanitize_and_validate_vietocr_label(nfd)
        self.assertIsNone(reason)
        self.assertEqual(cleaned, 'Chào "bé" - lớp Bốn...')

        oov_label, oov_reason = sanitize_and_validate_vietocr_label("Xin chào 😀")
        self.assertIsNone(oov_label)
        self.assertEqual(oov_reason, "UNSUPPORTED_VIETOCR_VOCAB_CHAR")

    def test_crop_quality_and_exif_orientation_gates(self):
        crisp = _crisp_line_image(260, 48)
        ok, _, reason = validate_flow2_line_crop(crisp, label="Con mèo trèo cây cau")
        self.assertTrue(ok)
        self.assertIsNone(reason)

        blank = Image.new("RGB", (260, 48), (255, 255, 255))
        ok_blank, _, blank_reason = validate_flow2_line_crop(blank, label="Con mèo")
        self.assertFalse(ok_blank)
        self.assertEqual(blank_reason, "LOW_CONTRAST_OR_BLANK")

        blurry = crisp.filter(ImageFilter.GaussianBlur(radius=6))
        ok_blur, _, blur_reason = validate_flow2_line_crop(blurry, label="Con mèo trèo cây cau")
        self.assertFalse(ok_blur)
        self.assertEqual(blur_reason, "BLURRY_OR_LOW_EDGE_DETAIL")

        tiny = _crisp_line_image(12, 10)
        ok_tiny, _, tiny_reason = validate_flow2_line_crop(tiny, label="ab")
        self.assertFalse(ok_tiny)
        self.assertEqual(tiny_reason, "IMAGE_TOO_SMALL")

        ok_dense, _, dense_reason = validate_flow2_line_crop(
            _crisp_line_image(48, 36), label="một dòng chữ quá dài so với crop"
        )
        self.assertFalse(ok_dense)
        self.assertEqual(dense_reason, "LABEL_TOO_DENSE_FOR_CROP_WIDTH")

        # EXIF orientation=6 swaps width & height on open_image_exif_safe
        tall = Image.new("RGB", (48, 220), (255, 255, 255))
        exif = tall.getexif()
        exif[274] = 6
        buf = BytesIO()
        tall.save(buf, format="PNG", exif=exif)
        transposed = open_image_exif_safe(buf.getvalue())
        self.assertEqual(transposed.size, (220, 48))

    def test_line_geometry_and_pii_gates(self):
        ok_syn, syn_reason = validate_line_word_geometry(
            [{"text": "Xin", "bbox": [0.1, 0.2, 0.2, 0.05], "bbox_source": "synthetic_grid"}]
        )
        self.assertFalse(ok_syn)
        self.assertEqual(syn_reason, "SYNTHETIC_OR_PLACEHOLDER_BBOX")

        ok_spread, spread_reason = validate_line_word_geometry(
            [
                {"text": "Dòng 1", "bbox": [0.1, 0.1, 0.2, 0.04]},
                {"text": "Dòng 2", "bbox": [0.1, 0.5, 0.2, 0.04]},
            ]
        )
        self.assertFalse(ok_spread)
        self.assertEqual(spread_reason, "MULTILINE_VERTICAL_SPREAD")

        self.assertIn("EMAIL", detect_vietnamese_pii_strict("Liên hệ admin@viread.vn"))
        self.assertIn("PHONE_NUMBER", detect_vietnamese_pii_strict("Số ĐT 0912345678"))
        self.assertIn("ACCOUNT_OR_ID_NUMBER", detect_vietnamese_pii_strict("CCCD: 001203012345"))

    def test_supabase_admin_headers_handles_sb_secret_and_jwt(self):
        self.assertFalse(is_supabase_jwt_key("sb_secret_example_opaque_key"))
        secret_headers = supabase_admin_headers("sb_secret_example_opaque_key")
        self.assertEqual(secret_headers, {"apikey": "sb_secret_example_opaque_key"})
        self.assertNotIn("Authorization", secret_headers)

        jwt_key = "eyJhbGciOi.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"
        self.assertTrue(is_supabase_jwt_key(jwt_key))
        jwt_headers = supabase_admin_headers(jwt_key, extra={"Content-Type": "application/json"})
        self.assertEqual(jwt_headers["Authorization"], f"Bearer {jwt_key}")
        self.assertEqual(jwt_headers["Content-Type"], "application/json")

    def test_benchmark_create_allows_optional_none_hashes_for_pilot(self):
        model = BenchmarkCreate(
            run_id=uuid4(),
            locked_test_version_id=uuid4(),
            locked_test_manifest_sha256="a" * 64,
            parent_checkpoint_sha256=None,
            active_checkpoint_sha256=None,
            outputs=[
                {
                    "sample_id": "s1",
                    "group_id": "g1",
                    "original": "abc",
                    "candidate": "abc",
                    "parent": None,
                    "active": None,
                }
            ],
        )
        self.assertIsNone(model.parent_checkpoint_sha256)
        self.assertIsNone(model.active_checkpoint_sha256)

    def test_assign_leak_safe_splits_avoids_boilerplate_megacluster_and_balances(self):
        # 5 distinct groups that happen to share a long chapter heading (>=24 chars)
        # must not collapse into 1 mega-cluster and must always populate train & validation.
        shared_heading = "Hướng dẫn đọc hiểu văn bản lớp bốn"
        rows = []
        for idx in range(5):
            gid = f"book-chapter-{idx}"
            rows.append(
                {
                    "group_id": gid,
                    "image_sha256": f"{idx:064x}",
                    "label": shared_heading,
                }
            )
            rows.append(
                {
                    "group_id": gid,
                    "image_sha256": f"{(100 + idx):064x}",
                    "label": f"Nội dung riêng trang số {idx}",
                }
            )
        _assign_leak_safe_splits(rows)
        splits_by_group: dict[str, set[str]] = {}
        for row in rows:
            splits_by_group.setdefault(row["group_id"], set()).add(row["split"])
        # No single group splits across train and validation
        for sp_set in splits_by_group.values():
            self.assertEqual(len(sp_set), 1)
        all_splits = {row["split"] for row in rows}
        self.assertEqual(all_splits, {"train", "validation"})

    def test_drive_desktop_store_blocks_production_and_cleans_resume_index(self):
        fake_disk_usage = SimpleNamespace(
            total=20 * 1024 * 1024 * 1024,
            used=5 * 1024 * 1024 * 1024,
            free=15 * 1024 * 1024 * 1024,
        )
        with tempfile.TemporaryDirectory() as tmp, patch(
            "app.services.training_storage.google_drive_desktop_store.shutil.disk_usage",
            return_value=fake_disk_usage,
        ):
            store = GoogleDriveDesktopStore(root_dir=tmp)
            with patch.dict(os.environ, {"RENDER": "true"}):
                with self.assertRaises(DriveNotConnectedError):
                    store._assert_root_available()
            with patch.dict(os.environ, {"RENDER": "", "APP_ENVIRONMENT": "development"}, clear=False):
                job_id = str(uuid4())
                store.put_resume_file(job_id, "resume-manifest.json", b'{"step":1}')
                store.put_resume_file(job_id, "resume-manifest.json", b'{"step":2}')
                idx_files = list(store._index_dir().glob("*.json"))
                self.assertEqual(len(idx_files), 1)
                self.assertTrue(store.delete_resume_file(job_id, "resume-manifest.json"))
                self.assertEqual(list(store._index_dir().glob("*.json")), [])


class Flow2RetryRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_partial_upload_accepts_created_and_running_run_statuses(self):
        job_id = uuid4()
        actor_id = uuid4()
        run_id = uuid4()
        parent_sha = "c" * 64
        for run_status in ("CREATED", "RUNNING"):
            job_row = {
                "target": "COLAB",
                "status": "BLOCKED",
                "run_id": run_id,
                "attempts": 1,
                "profile": "FLOW2_ADMIN_VERIFIED",
                "dataset_version_id": uuid4(),
                "manifest_sha256": "a" * 64,
                "config_sha256": "b" * 64,
                "parent_checkpoint_sha256": parent_sha,
                "created_by": actor_id,
                "colab_execution_id": None,
                "colab_execution_resource_name": None,
                "colab_operation_name": None,
                "last_error_code": "COLAB_RETRY_REQUIRES_RUN_RECOVERY",
                "locked_test_version_id": None,
                "locked_test_manifest_sha256": None,
            }
            run_row = {
                "id": run_id,
                "status": run_status,
                "profile": job_row["profile"],
                "dataset_version_id": job_row["dataset_version_id"],
                "manifest_sha256": job_row["manifest_sha256"],
                "config_sha256": job_row["config_sha256"],
                "parent_checkpoint_sha256": parent_sha,
                "created_by": actor_id,
            }
            db = _FakeDb(
                [
                    _RowResult(job_row),
                    _RowResult(run_row),
                    _ScalarResult(parent_sha),
                    _ScalarResult(None),
                    _EmptyResult(),
                ]
            )
            with patch(
                "app.api.routes.admin_viread_training.VireadOcrTrainingService._admin",
                new_callable=AsyncMock,
            ):
                res = await retry_failed_viread_colab_training_job(
                    job_id=job_id,
                    actor_id=actor_id,
                    db=db,
                )
            self.assertEqual(res["status"], "WAITING_FOR_COLAB_WORKER")
            self.assertEqual(res["recovery_mode"], "partial_checkpoint_upload")
            self.assertTrue(db.committed)


class Flow2LockedTestCleanIngestAndNonTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_ensure_locked_test_accepts_clean_ingest_releases_txn_before_io_and_skips_third_pass(self):
        from app.services import viread_ocr_training_service as training_svc
        from app.services.training_storage.base import StorageProvider
        from app.services.training_storage.router import TrainingArtifactStoreRouter

        fake_disk_usage = SimpleNamespace(
            total=20 * 1024 * 1024 * 1024,
            used=5 * 1024 * 1024 * 1024,
            free=15 * 1024 * 1024 * 1024,
        )
        with tempfile.TemporaryDirectory() as tmp, patch(
            "app.services.training_storage.google_drive_desktop_store.shutil.disk_usage",
            return_value=fake_disk_usage,
        ):
            store = GoogleDriveDesktopStore(root_dir=tmp)
            router = TrainingArtifactStoreRouter(
                drive_store_factory=lambda: store,
                write_provider=StorageProvider.GOOGLE_DRIVE,
            )

            events: list[str] = []
            get_calls = 0
            orig_get = router.get
            orig_put = router.put

            def spied_get(ref, **kwargs):
                nonlocal get_calls
                get_calls += 1
                events.append("router.get")
                return orig_get(ref, **kwargs)

            def spied_put(logical_path, data, **kwargs):
                events.append(f"router.put:{logical_path.split('/', 1)[0]}")
                return orig_put(logical_path, data, **kwargs)

            router.get = spied_get
            router.put = spied_put

            samples_src = []
            for idx, (gid, label) in enumerate([
                ("kntt-tv4-t1-p019", "Tiếng đàn bầu ngân vang"),
                ("ctst-tv4-t1-p053", "Cô giáo em hiền hậu"),
            ]):
                img = _crisp_line_image(260, 48)
                for off in range(10, 240, 18):
                    img.paste((idx * 40, 10, 10), (off, 6, off + 3, 40))
                buf = BytesIO()
                img.save(buf, format="PNG")
                raw = buf.getvalue()
                sha = hashlib.sha256(raw).hexdigest()
                stored = orig_put(f"verified-samples/{gid}/line-{idx:04d}-{sha[:12]}.png", raw, content_type="image/png", expected_sha256=sha)
                samples_src.append({
                    "sample_id": str(uuid4()),
                    "source_flow": "FLOW1_VERIFIED",
                    "group_id": gid,
                    "image_storage_path": stored.reference,
                    "image_sha256": sha,
                    "label": label,
                    "source_page_id": None,
                    "source_revision_id": None,
                    "provenance": {
                        "verified_by_admin": True,
                        "verification_source": "admin",
                        "ingest_pipeline": "flow2_clean_ingest_v1",
                        "rights_basis": "owner_supplied",
                        "verified_by": "admin:test",
                    },
                })

            captured_sql: list[str] = []
            dataset_id = uuid4()
            cohort_id = uuid4()
            locked_version_sha: str | None = None

            class _Repo:
                async def execute(self, sql, params=None):
                    sql_norm = " ".join(str(sql).split())
                    captured_sql.append(sql_norm)
                    if "pg_advisory_xact_lock" in sql_norm:
                        events.append("lock")
                    return _EmptyResult()

                async def one(self, sql, params=None):
                    nonlocal locked_version_sha
                    sql_norm = " ".join(str(sql).split())
                    captured_sql.append(sql_norm)
                    if "WITH locked_versions AS" in sql_norm:
                        if locked_version_sha is not None and "router.put:locked-tests" in events:
                            return {
                                "version_id": dataset_id,
                                "manifest_sha256": locked_version_sha,
                                "sample_count": 2,
                                "group_count": 2,
                            }
                        return None
                    if "WITH verified_holdout AS" in sql_norm and "FROM safe_holdout" in sql_norm:
                        return {"sample_count": 2, "group_count": 2}
                    if "FROM public.viread_ocr_dataset_versions WHERE source_flow=:source_flow" in sql_norm:
                        return None
                    if "INSERT INTO public.viread_ocr_dataset_versions" in sql_norm:
                        locked_version_sha = params["version_sha"]
                        return {
                            "id": dataset_id,
                            "source_flow": "LOCKED_TEST",
                            "version_sha256": params["version_sha"],
                            "manifest_storage_path": params["storage_path"],
                            "sample_count": params["sample_count"],
                            "is_locked_test": True,
                        }
                    if "FROM public.viread_ocr_evaluation_cohorts WHERE dataset_version_id=" in sql_norm:
                        return None
                    if "INSERT INTO public.viread_ocr_evaluation_cohorts" in sql_norm:
                        return {"id": cohort_id, "evaluation_type": "PRODUCTION", "manifest_sha256": params["manifest_sha"], "sample_count": 2, "group_count": 2}
                    return None

                async def all(self, sql, params=None):
                    captured_sql.append(" ".join(str(sql).split()))
                    return list(samples_src)

                async def commit(self):
                    events.append("commit")

                async def rollback(self):
                    events.append("rollback")

            svc = training_svc.VireadOcrTrainingService(MagicMock())
            svc.repo = _Repo()
            svc._admin = AsyncMock()
            svc._artifact_router = AsyncMock(return_value=router)

            with (
                patch.object(training_svc, "MIN_LOCKED_PAIRS", 2),
                patch.object(training_svc, "MIN_LOCKED_GROUPS", 2),
                patch.object(training_svc, "ensure_database_capacity", new=AsyncMock(return_value={})),
            ):
                res = await svc.ensure_locked_test(uuid4())

            self.assertEqual(res["status"], "READY")
            self.assertEqual(res["sample_count"], 2)
            self.assertEqual(res["group_count"], 2)
            # Clean-ingest holdout predicate & anti-leakage checks present in readiness + creation queries
            holdout_queries = [q for q in captured_sql if "WITH verified_holdout AS" in q]
            self.assertGreaterEqual(len(holdout_queries), 2)
            for q in holdout_queries:
                self.assertIn("flow2_clean_ingest_v1", q)
                self.assertIn("rights_basis", q)
                self.assertIn("verified_by", q)
                self.assertIn("viread_ocr_outbox", q)
            # Read txn MUST be released before Drive I/O, and advisory lock ONLY acquired afterward
            self.assertIn("rollback", events)
            self.assertLess(events.index("rollback"), events.index("router.get"))
            self.assertLess(events.index("router.put:locked-tests"), events.index("lock"))
            # Each source image downloaded ONLY ONCE (register_dataset skipped 3rd-pass re-read)
            self.assertEqual(get_calls, 2)


if __name__ == "__main__":
    unittest.main()
