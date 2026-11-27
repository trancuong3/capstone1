"""Wave 1 security regression tests for training/Drive Desktop, storage, OCR, and document rasterizer."""

from __future__ import annotations

import hashlib
import json
import os
import struct
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

import docx
from fastapi import HTTPException
from PIL import Image

from app.api.routes import admin_viread_training
from app.schemas.viread_ocr_training import (
    GoogleDriveConnectDesktopRequest,
    TrainingWorkerFinish,
)
from app.services import document_rasterizer_service as rasterizer
from app.services import ocr_engine, storage_service
from app.services.admin_ocr_service import AdminOcrService
from app.services.training_storage.base import DrivePermissionError, TrainingStorageError
from app.services.training_storage.google_drive_desktop_store import (
    DRIVE_DESKTOP_SYNC_SCOPE,
    GoogleDriveDesktopStore,
    drive_desktop_config_readiness,
    resolve_flow2_sync_root,
    validate_flow2_sync_root_allowed,
)
from app.services.training_storage.references import DRIVE_ROOT_DISPLAY_PATH
from app.services.viread_drive_connection_service import (
    VireadDriveConnectionService,
    _serialize_connection_status,
    build_google_drive_store_from_row,
    invalidate_sync_google_drive_store_cache,
)
from app.services.viread_ocr_training_service import VireadOcrTrainingService

ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
BOOK_ID = UUID("22222222-2222-4222-8222-222222222222")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")


def _make_base_docx() -> bytes:
    document = docx.Document()
    document.add_paragraph("Bé tập đọc tiếng Việt.")
    buf = BytesIO()
    document.save(buf)
    return buf.getvalue()


def _rewrite_docx(base_docx: bytes, *, replace: dict[str, bytes] | None = None, add: dict[str, bytes] | None = None) -> bytes:
    out = BytesIO()
    with zipfile.ZipFile(BytesIO(base_docx), "r") as src:
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as dst:
            for item in src.infolist():
                payload = replace[item.filename] if (replace and item.filename in replace) else src.read(item.filename)
                dst.writestr(item.filename, payload)
            for name, payload in (add or {}).items():
                dst.writestr(name, payload)
    return out.getvalue()


def _spoof_zip_entry_uncompressed_size(zip_bytes: bytes, target_name: str, fake_size: int) -> bytes:
    """Patch both local file header and central directory uncompressed size fields for target_name."""
    data = bytearray(zip_bytes)
    name_bytes = target_name.encode("utf-8")

    # Patch Local File Header (PK\x03\x04): uncompressed size is at offset +22 (4 bytes LE)
    pos = 0
    while True:
        idx = data.find(b"PK\x03\x04", pos)
        if idx < 0:
            break
        fname_len = struct.unpack_from("<H", data, idx + 26)[0]
        if data[idx + 30 : idx + 30 + fname_len] == name_bytes:
            struct.pack_into("<I", data, idx + 22, fake_size)
        pos = idx + 4

    # Patch Central Directory Header (PK\x01\x02): uncompressed size is at offset +24 (4 bytes LE)
    pos = 0
    while True:
        idx = data.find(b"PK\x01\x02", pos)
        if idx < 0:
            break
        fname_len = struct.unpack_from("<H", data, idx + 28)[0]
        if data[idx + 46 : idx + 46 + fname_len] == name_bytes:
            struct.pack_into("<I", data, idx + 24, fake_size)
        pos = idx + 4

    return bytes(data)


class DriveDesktopAndTrainingSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        invalidate_sync_google_drive_store_cache()

    def test_rejects_unc_relative_traversal_and_symlink_sync_root_paths_before_fs_probe(self):
        bad_inputs = [
            r"\\attacker.example\share\My Drive",
            r"\\127.0.0.1\c$\Windows",
            "//attacker.example/share/My Drive",
            r"\\?\C:\Windows\System32",
            r"\\.\pipe\viread",
            "relative/My Drive",
            "./My Drive",
            "../My Drive",
            r"\root-relative\My Drive",
            "G:drive-relative",
            r"C:\allowed\..\Windows",
            "file:///C:/My Drive",
            "C:\\My Drive\x00evil",
        ]
        with patch.object(Path, "exists", side_effect=AssertionError("Must not probe FS on rejected path")), \
             patch.object(Path, "is_dir", side_effect=AssertionError("Must not probe FS on rejected path")):
            for raw in bad_inputs:
                with self.subTest(raw=raw):
                    with self.assertRaises(TrainingStorageError):
                        resolve_flow2_sync_root(raw)
                    with self.assertRaises(TrainingStorageError):
                        GoogleDriveDesktopStore(root_dir=raw)

    async def test_route_rejects_unc_and_symlink_before_service_call(self):
        with patch.object(admin_viread_training.VireadOcrTrainingService, "_admin", new=AsyncMock()), \
             patch.object(admin_viread_training, "VireadDriveConnectionService") as mock_svc_cls:
            with self.assertRaises(HTTPException) as ctx:
                await admin_viread_training.connect_viread_training_drive_desktop(
                    payload=GoogleDriveConnectDesktopRequest(sync_root_path=r"\\attacker\share\My Drive"),
                    actor_id=ACTOR_ID,
                    db=MagicMock(),
                )
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("DRIVE_DESKTOP_UNC_FORBIDDEN", str(ctx.exception.detail))
            mock_svc_cls.assert_not_called()

    def test_rejects_symlink_component_in_sync_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            my_drive = Path(tmpdir) / "My Drive"
            my_drive.mkdir()
            with patch.object(Path, "is_symlink", autospec=True, side_effect=lambda self: self == my_drive):
                with self.assertRaises(TrainingStorageError) as ctx:
                    resolve_flow2_sync_root(my_drive)
            self.assertEqual(ctx.exception.code, "DRIVE_DESKTOP_SYMLINK_FORBIDDEN")

    async def test_requires_detected_mount_or_env_allowlist_and_strips_host_paths_and_oserror(self):
        with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
            unallowed = Path(tmp1) / "My Drive"
            unallowed.mkdir()
            allowed_mount = Path(tmp2) / "My Drive"
            allowed_mount.mkdir()

            base_env = {
                "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "e" * 48,
                "VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL": "owner@example.com",
                "VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS": "",
                "VIREAD_GDRIVE_DESKTOP_ROOT": "",
            }
            with patch.dict(os.environ, base_env, clear=False), \
                 patch(
                     "app.services.viread_drive_connection_service.detect_google_drive_desktop_mounts",
                     return_value=[],
                 ), \
                 patch(
                     "app.services.training_storage.google_drive_desktop_store.detect_google_drive_desktop_mounts",
                     return_value=[],
                 ):
                # 1. Unallowlisted path rejected with 403 and no local host path in detail
                svc = VireadDriveConnectionService(MagicMock())
                svc.repo = MagicMock()
                svc.repo.get_primary = AsyncMock(return_value=(None, True))
                svc.repo.upsert_connected = AsyncMock()
                with self.assertRaises(HTTPException) as denied:
                    await svc.connect_drive_desktop(
                        actor_id=ACTOR_ID,
                        sync_root_path=str(unallowed),
                        account_email="owner@example.com",
                    )
                self.assertEqual(denied.exception.status_code, 403)
                self.assertIn("DRIVE_DESKTOP_PATH_NOT_ALLOWED", str(denied.exception.detail))
                self.assertNotIn(str(tmp1), str(denied.exception.detail))
                svc.repo.upsert_connected.assert_not_called()

            # 2. Pathsep-separated allowlist allows tmp2 but still rejects tmp1
            allow_env = {
                **base_env,
                "VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS": f"{Path(tmp2) / 'nonexistent'}{os.pathsep}{tmp2}",
            }
            saved_rows: list[dict] = []

            async def _fake_upsert(**kwargs):
                row = {"status": "CONNECTED", **kwargs}
                saved_rows.append(row)
                return row

            with patch.dict(os.environ, allow_env, clear=False), \
                 patch(
                     "app.services.viread_drive_connection_service.detect_google_drive_desktop_mounts",
                     return_value=[],
                 ), \
                 patch(
                     "app.services.training_storage.google_drive_desktop_store.detect_google_drive_desktop_mounts",
                     return_value=[],
                 ):
                svc_ok = VireadDriveConnectionService(MagicMock())
                svc_ok.repo = MagicMock()
                svc_ok.repo.get_primary = AsyncMock(return_value=(None, True))
                svc_ok.repo.upsert_connected = AsyncMock(side_effect=_fake_upsert)

                resp = await svc_ok.connect_drive_desktop(
                    actor_id=ACTOR_ID,
                    sync_root_path=str(allowed_mount),
                    account_email="owner@example.com",
                )
                self.assertTrue(resp["connected"])
                self.assertEqual(resp["root_folder_path"], DRIVE_ROOT_DISPLAY_PATH)
                self.assertEqual(saved_rows[0]["root_folder_path"], DRIVE_ROOT_DISPLAY_PATH)
                # Ensure no local host filesystem paths appear anywhere in serialized response
                serialized = json.dumps(resp)
                self.assertNotIn(str(tmp2), serialized)
                self.assertNotIn(str(allowed_mount), serialized)

                # Legacy DB row with embedded host path is also sanitized
                legacy_row = {
                    **saved_rows[0],
                    "root_folder_path": f"{DRIVE_ROOT_DISPLAY_PATH} ({allowed_mount})",
                }
                legacy_serialized = _serialize_connection_status(legacy_row, migration_applied=True)
                self.assertEqual(legacy_serialized["root_folder_path"], DRIVE_ROOT_DISPLAY_PATH)
                self.assertNotIn(str(allowed_mount), json.dumps(legacy_serialized))

                # Hydrating store from DB row works when allowlisted, fails when removed from allowlist
                store = build_google_drive_store_from_row(saved_rows[0], use_warm_cache=False)
                health = store.health_check()
                self.assertTrue(health.healthy)
                self.assertNotIn(str(tmp2), str(health.detail))
                selftest = store.self_test()
                self.assertTrue(selftest.ok)
                self.assertNotIn(str(tmp2), str(selftest.detail))

                # Raw OSError text and local host path must NOT leak in health_check / ensure_directory_tree / quota_check
                secret_os_msg = f"[WinError 5] Access is denied: '{tmp2}\\secret_internal_file'"
                with patch.object(Path, "write_bytes", side_effect=PermissionError(secret_os_msg)):
                    bad_health = store.health_check()
                self.assertFalse(bad_health.healthy)
                self.assertEqual(bad_health.error_code, "DRIVE_DESKTOP_IO_ERROR")
                self.assertNotIn(str(tmp2), str(bad_health.detail))
                self.assertNotIn("secret_internal_file", str(bad_health.detail))
                self.assertNotIn("WinError", str(bad_health.detail))

                with patch.object(Path, "mkdir", side_effect=PermissionError(secret_os_msg)):
                    with self.assertRaises(DrivePermissionError) as dir_err:
                        store.ensure_directory_tree()
                self.assertNotIn(str(tmp2), str(dir_err.exception))
                self.assertNotIn("secret_internal_file", str(dir_err.exception))

                with patch("app.services.training_storage.google_drive_desktop_store.shutil.disk_usage", side_effect=OSError(secret_os_msg)):
                    with self.assertRaises(TrainingStorageError) as q_err:
                        store.quota_check()
                self.assertNotIn(str(tmp2), str(q_err.exception))
                self.assertNotIn("secret_internal_file", str(q_err.exception))

            # Removing allowlist makes build_google_drive_store_from_row reject stored path too
            with patch.dict(os.environ, base_env, clear=False), \
                 patch(
                     "app.services.training_storage.google_drive_desktop_store.detect_google_drive_desktop_mounts",
                     return_value=[],
                 ):
                with self.assertRaises(DrivePermissionError) as rev_err:
                    build_google_drive_store_from_row(saved_rows[0], use_warm_cache=False)
                self.assertEqual(rev_err.exception.code, "DRIVE_DESKTOP_PATH_NOT_ALLOWED")

    def test_drive_desktop_readiness_hides_host_paths_and_detected_mount_passes_allowlist(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            my_drive = Path(tmpdir) / "My Drive"
            my_drive.mkdir()
            fake_mounts = [
                {
                    "drive_root": str(my_drive),
                    "flow2_root": str(resolve_flow2_sync_root(my_drive)),
                    "account_email": "owner@example.com",
                    "source": "windows_mount",
                }
            ]
            with patch(
                "app.services.training_storage.google_drive_desktop_store.detect_google_drive_desktop_mounts",
                return_value=fake_mounts,
            ):
                readiness = drive_desktop_config_readiness()
                self.assertIsNone(readiness["default_mount_path"])
                self.assertNotIn(str(tmpdir), json.dumps(readiness))
                validated = validate_flow2_sync_root_allowed(
                    resolve_flow2_sync_root(my_drive),
                    detected_mounts=fake_mounts,
                )
                self.assertEqual(validated, resolve_flow2_sync_root(my_drive).resolve())

    async def test_finish_colab_job_validates_run_id_even_on_failed_status(self):
        job_id = uuid4()
        real_run_id = uuid4()
        victim_run_id = uuid4()

        class _FakeRepo:
            def __init__(self, job_row):
                self.job_row = job_row
                self.executed: list[tuple[str, dict]] = []
                self.committed = False
                self.rolled_back = False

            async def one(self, sql, params=None):
                if "FROM public.viread_ocr_training_jobs" in sql:
                    return dict(self.job_row)
                return None

            async def execute(self, sql, params=None):
                self.executed.append((sql, dict(params or {})))

            async def commit(self):
                self.committed = True

            async def rollback(self):
                self.rolled_back = True

        def _make_job(run_id_val):
            return {
                "id": job_id,
                "profile": "FLOW2_ADMIN_VERIFIED",
                "status": "COLAB_RUNNING",
                "target": "COLAB",
                "worker_id": "colab-worker-1",
                "dataset_version_id": uuid4(),
                "manifest_sha256": "a" * 64,
                "config_sha256": "b" * 64,
                "parent_checkpoint_sha256": "c" * 64,
                "run_id": run_id_val,
                "created_by": ACTOR_ID,
                "attempts": 1,
                "colab_execution_id": None,
                "colab_execution_resource_name": None,
                "colab_operation_name": None,
                "locked_test_version_id": None,
                "locked_test_manifest_sha256": None,
                "metadata": {},
                "lease_active": True,
            }

        # Case 1: FAILED with mismatched payload.run_id when job has real_run_id -> 422, zero updates
        repo1 = _FakeRepo(_make_job(real_run_id))
        db1 = MagicMock(rollback=AsyncMock())
        with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=SimpleNamespace(repo=repo1)):
            with self.assertRaises(HTTPException) as err1:
                await admin_viread_training.finish_viread_colab_training_job(
                    job_id=job_id,
                    payload=TrainingWorkerFinish(
                        worker_id="colab-worker-1",
                        run_id=victim_run_id,
                        status="FAILED",
                        error_code="OOM",
                        runtime={"device": "T4"},
                    ),
                    _worker=None,
                    db=db1,
                )
        self.assertEqual(err1.exception.status_code, 422)
        db1.rollback.assert_awaited_once()
        self.assertEqual(repo1.executed, [])
        self.assertFalse(repo1.committed)

        # Case 2: FAILED with forged payload.run_id when job.run_id is None -> 422, zero updates
        repo2 = _FakeRepo(_make_job(None))
        db2 = MagicMock(rollback=AsyncMock())
        with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=SimpleNamespace(repo=repo2)):
            with self.assertRaises(HTTPException) as err2:
                await admin_viread_training.finish_viread_colab_training_job(
                    job_id=job_id,
                    payload=TrainingWorkerFinish(
                        worker_id="colab-worker-1",
                        run_id=victim_run_id,
                        status="FAILED",
                        error_code="CRASH",
                        runtime={"device": "T4"},
                    ),
                    _worker=None,
                    db=db2,
                )
        self.assertEqual(err2.exception.status_code, 422)
        db2.rollback.assert_awaited_once()
        self.assertEqual(repo2.executed, [])

        # Case 3: FAILED with payload.run_id=None when job.run_id=real_run_id -> updates ONLY job["run_id"]
        repo3 = _FakeRepo(_make_job(real_run_id))
        db3 = MagicMock(rollback=AsyncMock())
        with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=SimpleNamespace(repo=repo3)):
            res3 = await admin_viread_training.finish_viread_colab_training_job(
                job_id=job_id,
                payload=TrainingWorkerFinish(
                    worker_id="colab-worker-1",
                    run_id=None,
                    status="FAILED",
                    error_code="OOM",
                    runtime={"device": "T4"},
                ),
                _worker=None,
                db=db3,
            )
        self.assertEqual(res3["status"], "BLOCKED")
        self.assertEqual(res3["run_id"], real_run_id)
        self.assertTrue(repo3.committed)
        run_updates = [params for sql, params in repo3.executed if "viread_ocr_training_runs" in sql]
        self.assertEqual(len(run_updates), 1)
        self.assertEqual(run_updates[0]["run_id"], real_run_id)


class Flow1CheckpointPathTraversalTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_traversal_and_malformed_chunk_paths_without_deleting_them(self):
        upload_id = uuid4()
        other_upload_id = uuid4()
        valid_sha = "a" * 64
        comparison = json.dumps({
            "models": {"baseline": "orig", "finetuned": "v2"},
            "sgk": {
                "cer_pct": {"baseline": 10.0, "finetuned": 4.0},
                "wer_pct": {"baseline": 20.0, "finetuned": 8.0},
            },
        }).encode("utf-8")

        malicious_paths = [
            f"ocr-training/checkpoints/flow1-manual/{upload_id}/../../../books/victim/page.png",
            f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000.part",
            f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{'z' * 64}.part",
            f"ocr-training/checkpoints/flow1-manual/{other_upload_id}/0000-{valid_sha}.part",
            f"ocr-training/checkpoints/flow1-manual/{upload_id}/sub/0000-{valid_sha}.part",
            f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{valid_sha}.part?x=1",
            f"ocr-training/checkpoints/flow1-manual/{upload_id}\\0000-{valid_sha}.part",
            f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{valid_sha}.part\x00",
        ]

        for bad_path in malicious_paths:
            with self.subTest(bad_path=bad_path):
                deleted_paths: list[str] = []
                repo = SimpleNamespace(rollback=AsyncMock(), commit=AsyncMock())
                svc = VireadOcrTrainingService(repo)
                svc.repo = repo
                svc._admin = AsyncMock()
                chunks_json = json.dumps([
                    {"index": 0, "path": bad_path, "sha256": valid_sha, "bytes": 100},
                ])
                with patch("app.services.viread_ocr_training_service.delete_object", side_effect=deleted_paths.append), \
                     patch("app.services.viread_ocr_training_service.hash_storage_object") as mock_hash:
                    with self.assertRaises(HTTPException) as ctx:
                        await svc.activate_flow1_model(
                            actor_id=ACTOR_ID,
                            upload_id=upload_id,
                            weights_filename="model.pth",
                            chunks_json=chunks_json,
                            comparison_bytes=comparison,
                        )
                self.assertEqual(ctx.exception.status_code, 422)
                self.assertEqual(deleted_paths, [], f"Must never attempt to delete unvalidated path {bad_path!r}")
                mock_hash.assert_not_called()

        # Mixed valid chunk 0 + malicious chunk 1: neither hash nor delete touches malicious chunk 1
        deleted_paths_mixed: list[str] = []
        valid_path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{valid_sha}.part"
        evil_path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/../../../../books/secret/p.png"
        repo_m = SimpleNamespace(rollback=AsyncMock(), commit=AsyncMock())
        svc_m = VireadOcrTrainingService(repo_m)
        svc_m.repo = repo_m
        svc_m._admin = AsyncMock()
        with patch("app.services.viread_ocr_training_service.delete_object", side_effect=deleted_paths_mixed.append), \
             patch("app.services.viread_ocr_training_service.hash_storage_object") as mock_hash:
            with self.assertRaises(HTTPException) as ctx:
                await svc_m.activate_flow1_model(
                    actor_id=ACTOR_ID,
                    upload_id=upload_id,
                    weights_filename="model.pth",
                    chunks_json=json.dumps([
                        {"index": 0, "path": valid_path, "sha256": valid_sha, "bytes": 100},
                        {"index": 1, "path": evil_path, "sha256": valid_sha, "bytes": 100},
                    ]),
                    comparison_bytes=comparison,
                )
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertNotIn(evil_path, deleted_paths_mixed)
        mock_hash.assert_not_called()


class StorageOcrAnd503SecurityTests(unittest.IsolatedAsyncioTestCase):
    def test_storage_service_rejects_unsafe_object_paths_across_all_local_and_remote_ops(self):
        bad_paths = [
            "",
            "   ",
            None,
            "/leading/slash.png",
            "\\leading\\backslash.png",
            "../escape.png",
            "books/../secret.png",
            "books/./a.png",
            "books//double.png",
            "books\\windows.png",
            "books/page.png?download=1",
            "books/page.png#frag",
            "books/page\x00.png",
            "books/page\n.png",
            "books/%2e%2e/secret.png",
            "books/%252e%252e/secret.png",
            "http://evil.example/a.png",
            "https://evil.example/a.png",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "C:/Windows/win.ini",
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            for local_dir in ("", tmpdir):
                with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": local_dir}), \
                     patch.object(storage_service, "_storage_bucket") as mock_bucket, \
                     patch.object(storage_service.requests, "get") as mock_get:
                    for bad in bad_paths:
                        with self.subTest(local=bool(local_dir), bad=bad):
                            with self.assertRaises(HTTPException) as e_up:
                                storage_service.upload_object(bad, b"x", "image/png")  # type: ignore[arg-type]
                            self.assertEqual(e_up.exception.status_code, 503)

                            with self.assertRaises(HTTPException) as e_dl:
                                storage_service.download_object(bad)  # type: ignore[arg-type]
                            self.assertEqual(e_dl.exception.status_code, 503)

                            with self.assertRaises(HTTPException) as e_del:
                                storage_service.delete_object(bad)  # type: ignore[arg-type]
                            self.assertEqual(e_del.exception.status_code, 503)

                            with self.assertRaises(HTTPException) as e_hash:
                                storage_service.hash_storage_object(bad)  # type: ignore[arg-type]
                            self.assertEqual(e_hash.exception.status_code, 503)

                            # create_signed_image_url(s) keep legacy clean http(s) URLs readable, reject all other bad paths
                            if not (isinstance(bad, str) and bad.startswith(("http://", "https://"))):
                                with self.assertRaises(HTTPException) as e_sign:
                                    storage_service.create_signed_image_url(bad)
                                self.assertEqual(e_sign.exception.status_code, 503)

                                with self.assertRaises(HTTPException) as e_signs:
                                    storage_service.create_signed_image_urls([bad])
                                self.assertEqual(e_signs.exception.status_code, 503)

                    mock_bucket.assert_not_called()
                    mock_get.assert_not_called()

        # Legacy clean https URL still passes create_signed_image_url(s), while control-char URL is rejected
        self.assertEqual(
            storage_service.create_signed_image_url("https://example.test/page.png"),
            "https://example.test/page.png",
        )
        with self.assertRaises(HTTPException) as ctrl_url:
            storage_service.create_signed_image_url("https://example.test/page.png\r\nX-Injected: 1")
        self.assertEqual(ctrl_url.exception.status_code, 503)

    def test_ocr_engine_rejects_non_hex_sha256_before_join_or_unlink(self):
        traversal_64 = ("../" * 21) + "a"
        self.assertEqual(len(traversal_64), 64)
        bad_shas = [
            traversal_64,
            "g" * 64,
            "a" * 63,
            "a" * 62 + "/x",
            "a" * 62 + "\\x",
            "",
        ]
        for bad_sha in bad_shas:
            with self.subTest(bad_sha=bad_sha):
                with patch("app.services.ocr_engine.os.unlink", side_effect=AssertionError("Must not unlink")):
                    self.assertFalse(ocr_engine.evict_cached_viread_checkpoint(bad_sha))
                with self.assertRaises(ValueError):
                    ocr_engine._v2_artifact_from_storage(
                        {"checkpoint_sha256": bad_sha, "storage_path": "ocr-training/m.json"}
                    )

        # Valid 64-char hex SHA still evicts cleanly
        valid_sha = "f" * 64
        cached = Path(tempfile.gettempdir()) / f"viread-vietocr-v2-{valid_sha}.pth"
        cached.write_bytes(b"test")
        try:
            self.assertTrue(ocr_engine.evict_cached_viread_checkpoint(valid_sha))
            self.assertFalse(cached.exists())
        finally:
            cached.unlink(missing_ok=True)

    async def test_admin_ocr_service_503_hides_raw_engine_errors(self):
        raw_secret = "PaddleOCR C:\\internal\\models\\det.pdmodel OpenCV assertion failed 0xdeadbeef"
        safe_expected = "OCR engine is currently unavailable; please try again later"

        class ForeignOcrEngineUnavailable(RuntimeError):
            pass
        ForeignOcrEngineUnavailable.__name__ = "OcrEngineUnavailable"

        from app.services.admin_ocr_service import OcrEngineUnavailable as LocalOcrUnavailable

        for exc_factory in (
            lambda: LocalOcrUnavailable(raw_secret),
            lambda: ForeignOcrEngineUnavailable(raw_secret),
        ):
            # 1. upload_page
            db = MagicMock(commit=AsyncMock(), rollback=AsyncMock(), flush=AsyncMock(), refresh=AsyncMock())
            svc = AdminOcrService(db)
            svc.repo = MagicMock(
                role=AsyncMock(return_value="admin"),
                book=AsyncMock(return_value=SimpleNamespace(Id=BOOK_ID, LifecycleStatus="ACTIVE")),
                active_pages_for_renumber=AsyncMock(return_value=[]),
                next_active_page_number=AsyncMock(return_value=1),
                flush=AsyncMock(),
                stage_page_reservation=MagicMock(),
                page=AsyncMock(return_value=None),
            )
            svc._read_validate_image = AsyncMock(return_value=(b"img", "image/png", "png", 100, 100))
            svc._abort_page_upload = AsyncMock()
            with patch("app.services.admin_ocr_service.upload_object"), \
                 patch("app.services.admin_ocr_service.is_remote_ocr_mode", return_value=False), \
                 patch("app.services.admin_ocr_service.extract_text_and_boxes", side_effect=exc_factory()), \
                 self.assertLogs("app.services.admin_ocr_service", level="ERROR") as logs:
                with self.assertRaises(HTTPException) as e_up:
                    await svc.upload_page(ACTOR_ID, BOOK_ID, MagicMock())
            self.assertEqual(e_up.exception.status_code, 503)
            self.assertEqual(e_up.exception.detail, safe_expected)
            self.assertNotIn("det.pdmodel", e_up.exception.detail)
            self.assertTrue(any("admin_ocr_engine_unavailable" in line for line in logs.output))

            # 2. replace_page_image
            page_obj = SimpleNamespace(
                Id=PAGE_ID, BookId=BOOK_ID, PageNumber=1, LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=None, ImagePath="books/b/p.png", Width=100, Height=100,
            )
            db2 = MagicMock(commit=AsyncMock(), rollback=AsyncMock(), flush=AsyncMock(), refresh=AsyncMock())
            svc2 = AdminOcrService(db2)
            svc2.repo = MagicMock(
                role=AsyncMock(return_value="admin"),
                page=AsyncMock(return_value=page_obj),
                book=AsyncMock(return_value=SimpleNamespace(Id=BOOK_ID, LifecycleStatus="ACTIVE")),
                revisions=AsyncMock(return_value=[]),
            )
            svc2._read_validate_image = AsyncMock(return_value=(b"img", "image/png", "png", 100, 100))
            svc2._cleanup_uploaded_object = AsyncMock()
            with patch("app.services.admin_ocr_service.upload_object"), \
                 patch("app.services.admin_ocr_service.is_remote_ocr_mode", return_value=False), \
                 patch("app.services.admin_ocr_service.extract_text_and_boxes", side_effect=exc_factory()), \
                 self.assertLogs("app.services.admin_ocr_service", level="ERROR") as logs2:
                with self.assertRaises(HTTPException) as e_rep:
                    await svc2.replace_page_image(ACTOR_ID, PAGE_ID, MagicMock())
            self.assertEqual(e_rep.exception.status_code, 503)
            self.assertEqual(e_rep.exception.detail, safe_expected)
            self.assertNotIn("0xdeadbeef", e_rep.exception.detail)
            self.assertTrue(any("admin_ocr_reupload_engine_unavailable" in line for line in logs2.output))

            # 3. reprocess
            db3 = MagicMock(commit=AsyncMock(), rollback=AsyncMock(), flush=AsyncMock(), refresh=AsyncMock())
            svc3 = AdminOcrService(db3)
            svc3.repo = MagicMock(
                role=AsyncMock(return_value="admin"),
                page=AsyncMock(return_value=page_obj),
                revisions=AsyncMock(return_value=[]),
            )
            with patch("app.services.admin_ocr_service.download_object", return_value=b"img"), \
                 patch("app.services.admin_ocr_service.is_remote_ocr_mode", return_value=False), \
                 patch("app.services.admin_ocr_service.extract_text_and_boxes", side_effect=exc_factory()), \
                 self.assertLogs("app.services.admin_ocr_service", level="ERROR") as logs3:
                with self.assertRaises(HTTPException) as e_reproc:
                    await svc3.reprocess(ACTOR_ID, PAGE_ID)
            self.assertEqual(e_reproc.exception.status_code, 503)
            self.assertEqual(e_reproc.exception.detail, safe_expected)
            self.assertNotIn("PaddleOCR", e_reproc.exception.detail)
            self.assertTrue(any("admin_ocr_reprocess_engine_unavailable" in line for line in logs3.output))


class DocumentRasterizerHardeningTests(unittest.TestCase):
    def test_pdf_scale_has_no_025_floor_and_rejects_invalid_or_degenerate_pages(self):
        # 100,000 x 100,000 pt -> scale = 6000 / 100000 = 0.06 (NOT clamped to 0.25!)
        scale = rasterizer._compute_safe_pdf_render_scale(100_000.0, 100_000.0)
        self.assertAlmostEqual(scale, 0.06, places=6)
        self.assertLess(scale, 0.25)

        # Invalid/zero/negative/non-finite/degenerate dimensions -> 422
        for w, h in (
            (0.0, 500.0),
            (-10.0, 500.0),
            (float("nan"), 500.0),
            (float("inf"), 500.0),
            (10_000_000.0, 10.0),  # shorter side collapses to < 1 px
        ):
            with self.subTest(w=w, h=h):
                with self.assertRaises(HTTPException) as ctx:
                    rasterizer._compute_safe_pdf_render_scale(w, h)
                self.assertEqual(ctx.exception.status_code, 422)

        # Verify both pypdfium2 and pymupdf paths do NOT clamp scale to 0.25
        rendered_scales: list[float] = []

        class _FakeBitmap:
            def to_pil(self):
                return Image.new("RGB", (60, 60), (255, 255, 255))

            def close(self):
                pass

        class _FakePdfiumPage:
            def get_size(self):
                return (100_000.0, 100_000.0)

            def render(self, *, scale):
                rendered_scales.append(scale)
                return _FakeBitmap()

            def close(self):
                pass

        class _FakePdfiumDoc:
            def __init__(self, _data):
                pass

            def __len__(self):
                return 1

            def __getitem__(self, _idx):
                return _FakePdfiumPage()

            def close(self):
                pass

        fake_pdfium = SimpleNamespace(PdfDocument=_FakePdfiumDoc)
        with patch.dict("sys.modules", {"pypdfium2": fake_pdfium}):
            pages = rasterizer._rasterize_pdf_with_pypdfium2(b"%PDF-1.4")
        self.assertEqual(len(pages), 1)
        self.assertAlmostEqual(rendered_scales[0], 0.06, places=6)

        mupdf_scales: list[float] = []

        class _FakeMuPage:
            rect = SimpleNamespace(width=100_000.0, height=100_000.0)

            def get_pixmap(self, *, matrix, alpha=False):
                mupdf_scales.append(matrix[0])
                return SimpleNamespace(width=60, height=60, samples=b"\xff" * (60 * 60 * 3))

        class _FakeMuDoc:
            needs_pass = False
            page_count = 1

            def __getitem__(self, _idx):
                return _FakeMuPage()

            def close(self):
                pass

        fake_pymupdf = SimpleNamespace(
            open=lambda **_kw: _FakeMuDoc(),
            Matrix=lambda sx, sy: (sx, sy),
        )
        with patch.dict("sys.modules", {"pymupdf": fake_pymupdf}):
            pages2 = rasterizer._rasterize_pdf_with_pymupdf(b"%PDF-1.4")
        self.assertEqual(len(pages2), 1)
        self.assertAlmostEqual(mupdf_scales[0], 0.06, places=6)

    def test_docx_stream_verifies_all_zip_entries_against_spoofed_file_size(self):
        base = _make_base_docx()
        # Add a 12 MiB zero-filled binary entry (non-XML!) and spoof info.file_size to 16 bytes
        raw_with_bin = _rewrite_docx(base, add={"word/media/payload.bin": b"\x00" * (12 * 1024 * 1024)})
        spoofed = _spoof_zip_entry_uncompressed_size(raw_with_bin, "word/media/payload.bin", 16)

        # Sanity-check the zip header actually reports 16 bytes
        with zipfile.ZipFile(BytesIO(spoofed), "r") as zf:
            info = zf.getinfo("word/media/payload.bin")
            self.assertEqual(info.file_size, 16)

        with self.assertRaises(HTTPException) as ctx:
            rasterizer._validate_docx_archive(spoofed)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_docx_rejects_utf16_doctype_and_entity_declarations(self):
        base = _make_base_docx()
        xml_payload = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE foo [<!ENTITY xxe "boom">]><w:document/>'
        for enc_name, encoded in (
            ("utf-16-bom", xml_payload.encode("utf-16")),
            ("utf-16-le-nobom", xml_payload.encode("utf-16-le")),
            ("utf-16-be-nobom", xml_payload.encode("utf-16-be")),
        ):
            with self.subTest(encoding=enc_name):
                malicious = _rewrite_docx(base, replace={"word/document.xml": encoded})
                with self.assertRaises(HTTPException) as ctx:
                    rasterizer._validate_docx_archive(malicious)
                self.assertEqual(ctx.exception.status_code, 422)

    def test_docx_rejects_external_relationships_and_network_field_targets(self):
        base = _make_base_docx()
        evil_rels_cases = [
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" '
            'Target="https://evil.example/tpl.dotm" TargetMode="External"/></Relationships>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
            'Target="http://169.254.169.254/latest/meta-data/"/></Relationships>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
            'Target="file:///etc/passwd"/></Relationships>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
            'Target="\\\\attacker\\share\\logo.png"/></Relationships>',
        ]
        for rels_xml in evil_rels_cases:
            with self.subTest(rels=rels_xml[:90]):
                malicious = _rewrite_docx(base, add={"word/_rels/evil.xml.rels": rels_xml.encode("utf-8")})
                with self.assertRaises(HTTPException) as ctx:
                    rasterizer._validate_docx_archive(malicious)
                self.assertEqual(ctx.exception.status_code, 422)

        # Field injection in word/document.xml (INCLUDETEXT with UNC / http)
        for field_instr in (
            'INCLUDETEXT "\\\\attacker\\share\\secret.txt"',
            'INCLUDEPICTURE "http://169.254.169.254/latest/meta-data/"',
            'HYPERLINK "file:///etc/passwd"',
        ):
            with self.subTest(field_instr=field_instr):
                doc_xml = (
                    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                    f'<w:body><w:p><w:r><w:instrText>{field_instr}</w:instrText></w:r></w:p></w:body>'
                    '</w:document>'
                ).encode("utf-8")
                malicious = _rewrite_docx(base, replace={"word/document.xml": doc_xml})
                with self.assertRaises(HTTPException) as ctx:
                    rasterizer._validate_docx_archive(malicious)
                self.assertEqual(ctx.exception.status_code, 422)

    def test_libreoffice_receives_isolated_user_installation_uri(self):
        captured_cmd: list[str] = []

        def _fake_run(cmd, **_kwargs):
            captured_cmd.extend(cmd)
            return SimpleNamespace(returncode=1, stdout=b"", stderr=b"")

        with patch("app.services.document_rasterizer_service.shutil.which", return_value="/usr/bin/soffice"), \
             patch("app.services.document_rasterizer_service.subprocess.run", side_effect=_fake_run):
            result = rasterizer._try_libreoffice_docx_to_pdf(b"PK\x03\x04dummy")

        self.assertIsNone(result)
        user_inst_args = [arg for arg in captured_cmd if arg.startswith("-env:UserInstallation=")]
        self.assertEqual(len(user_inst_args), 1)
        uri = user_inst_args[0].split("=", 1)[1]
        self.assertTrue(uri.startswith("file:///"), f"Expected file:/// URI, got {uri!r}")
        self.assertTrue(uri.endswith("/lo_profile"), f"Expected isolated lo_profile dir, got {uri!r}")
        self.assertIn("viread_docx_", uri)

    def test_image_pixel_budget_checked_before_load_and_without_mutating_global_max_pixels(self):
        original_max_pixels = Image.MAX_IMAGE_PIXELS
        # 6500 x 6500 = 42,250,000 pixels (> 36,000,000 budget, BELOW Pillow default 89,478,485!)
        buf = BytesIO()
        Image.new("1", (6500, 6500), 1).save(buf, format="PNG")
        oversized_png = buf.getvalue()

        with patch.object(rasterizer, "_flatten_to_rgb", side_effect=AssertionError("Must reject before flatten")), \
             patch.object(Image.Image, "load", side_effect=AssertionError("Must reject before load()")):
            with self.assertRaises(HTTPException) as ctx:
                rasterizer.rasterize_uploaded_document(
                    filename="bomb.png",
                    content_type="image/png",
                    data=oversized_png,
                )
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertEqual(Image.MAX_IMAGE_PIXELS, original_max_pixels)

        # Multi-frame TIFF with oversized frame rejected BEFORE frame.copy() / _flatten_to_rgb
        tbuf = BytesIO()
        Image.new("1", (6500, 6500), 1).save(tbuf, format="TIFF")
        oversized_tiff = tbuf.getvalue()
        with patch.object(rasterizer, "_flatten_to_rgb", side_effect=AssertionError("Must reject before flatten")), \
             patch.object(Image.Image, "copy", side_effect=AssertionError("Must reject before frame.copy()")):
            with self.assertRaises(HTTPException) as ctx_tif:
                rasterizer.rasterize_uploaded_document(
                    filename="bomb.tiff",
                    content_type="image/tiff",
                    data=oversized_tiff,
                )
        self.assertEqual(ctx_tif.exception.status_code, 413)
        self.assertEqual(Image.MAX_IMAGE_PIXELS, original_max_pixels)


if __name__ == "__main__":
    unittest.main()
