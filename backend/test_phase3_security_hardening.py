from __future__ import annotations

import os
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import deps
from app.api.routes import admin_viread_training, book as book_routes
from app.api.routes import reading as reading_routes, reading_management
from app.api.routes import parent_private_book as private_book_routes
from app.database.role_cache import invalidate_cached_role, peek_cached_profile_role, put_cached_profile_role
from app.services.admin_parent_service import AdminParentService
from app.services.book_service import BookService
from app.services.profile_service import ProfileService
from app.services.training_storage import (
    ArtifactMetadata,
    DriveTransientError,
    StorageProvider,
    format_gdrive_ref,
    sign_worker_artifact_token,
)


class TestPhase3SecurityHardening(unittest.IsolatedAsyncioTestCase):
    def tearDown(self) -> None:
        deps.clear_auth_token_cache()
        invalidate_cached_role(None)

    def test_invalidate_auth_cache_for_actor_evicts_only_target_tokens(self) -> None:
        actor_a = uuid4()
        actor_b = uuid4()
        deps.clear_auth_token_cache()
        try:
            deps._put_cached_actor_id("tok_a1", actor_a, 30.0, None)
            deps._put_cached_actor_id("tok_a2", actor_a, 30.0, None)
            deps._put_cached_actor_id("tok_b1", actor_b, 30.0, None)

            evicted = deps.invalidate_auth_cache_for_actor(actor_a)
            self.assertEqual(evicted, 2)
            self.assertIsNone(deps._get_cached_actor_id("tok_a1"))
            self.assertIsNone(deps._get_cached_actor_id("tok_a2"))
            self.assertEqual(deps._get_cached_actor_id("tok_b1"), actor_b)
        finally:
            deps.clear_auth_token_cache()

    async def test_deactivate_parent_and_delete_profile_evict_role_and_auth_caches(self) -> None:
        admin_id = uuid4()
        target_id = uuid4()

        with patch("app.database.role_cache.APP_ENVIRONMENT", "production"):
            put_cached_profile_role(target_id, "parent")
            deps._put_cached_actor_id("tok_parent", target_id, 30.0, None)

            repo = SimpleNamespace(
                get_actor_role=AsyncMock(return_value="admin"),
                get_parent_record=AsyncMock(return_value=SimpleNamespace(Id=target_id, Active=1)),
                soft_delete_parent=AsyncMock(return_value=True),
            )
            svc = AdminParentService(repo)
            svc._ensure_admin = AsyncMock()
            result = await svc.deactivate_parent(admin_id, target_id)
            self.assertEqual(result["active"], 0)
            self.assertIsNone(deps._get_cached_actor_id("tok_parent"))
            self.assertIsNot(peek_cached_profile_role(target_id), "parent")

            put_cached_profile_role(target_id, "parent")
            deps._put_cached_actor_id("tok_profile", target_id, 30.0, None)
            profile_repo = SimpleNamespace(delete_by_id=AsyncMock(return_value=True))
            profile_svc = ProfileService(profile_repo)
            profile_svc.require_admin = AsyncMock()
            await profile_svc.delete_profile_for_admin(admin_id, target_id)
            self.assertIsNone(deps._get_cached_actor_id("tok_profile"))
            self.assertIsNot(peek_cached_profile_role(target_id), "parent")

    def test_production_runtime_hardens_headers_docs_and_health(self) -> None:
        import app.sever as sever_mod

        fake_db = {
            "ok": True,
            "dns_resolved": True,
            "ssl_enabled": True,
            "pool_class": "NullPool",
            "pooler_mode": "transaction",
            "latency_ms": 1.2,
        }
        remote_snapshot = {
            "mode": "remote_worker",
            "ready": True,
            "heartbeat_ttl_seconds": 45,
            "engines": {"paddleocr": {"status": "HEALTHY", "detail_status": "inference_verified"}},
            "workers": [{"worker_id": "secret-win-host", "status": "IDLE", "online": True}],
            "queue": {"queued": 3},
        }
        with (
            patch.dict(
                os.environ,
                {"APP_ENVIRONMENT": "production", "VIREAD_OCR_MODE": "remote_worker"},
                clear=False,
            ),
            patch.object(sever_mod, "probe_database_connection", AsyncMock(return_value=fake_db)),
            patch.object(sever_mod, "collect_remote_ocr_health", AsyncMock(return_value=remote_snapshot)),
        ):
            self.assertTrue(sever_mod._is_production_runtime())
            client = TestClient(sever_mod.app)
            resp = client.get("/health", headers={"Authorization": "Bearer secret-token"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(resp.headers.get("x-frame-options"), "DENY")
            self.assertEqual(resp.headers.get("referrer-policy"), "no-referrer")
            self.assertIn("max-age=31536000", resp.headers.get("strict-transport-security", ""))
            self.assertEqual(resp.headers.get("cache-control"), "no-store")
            body = resp.json()
            self.assertNotIn("workers", body)
            self.assertNotIn("workers", body["ocr"])
            self.assertNotIn("pool_class", body["database"])
            self.assertEqual(body["database"], {"status": "healthy"})
            self.assertEqual(body["ocr"], {"mode": "remote_worker", "ready": True})

    async def test_unauthenticated_book_pages_hide_child_safety_409_as_404(self) -> None:
        book_id = uuid4()
        db = MagicMock()
        with (
            patch("app.services.book_service.CatalogRepository") as cat_cls,
            patch("app.services.book_service.is_book_private", return_value=False),
        ):
            cat_repo = MagicMock()
            cat_repo.get = AsyncMock(return_value=SimpleNamespace(Id=book_id))
            cat_repo.is_eligible = AsyncMock(return_value=False)
            cat_cls.return_value = cat_repo

            svc = BookService(db)
            with self.assertRaises(HTTPException) as unauth_err:
                await svc.list_pages(book_id, is_authenticated=False)
            self.assertEqual(unauth_err.exception.status_code, 404)

            with self.assertRaises(HTTPException) as auth_err:
                await svc.list_pages(book_id, is_authenticated=True)
            self.assertEqual(auth_err.exception.status_code, 409)

    async def test_optional_pagination_slices_when_supplied_and_preserves_direct_calls(self) -> None:
        sample_books = [SimpleNamespace(Id=uuid4()) for _ in range(5)]
        db = MagicMock()
        with patch("app.api.routes.book.BookService") as bs_cls:
            bs_cls.return_value.list_books = AsyncMock(return_value=sample_books)
            full_default = await book_routes.get_books(db=db)
            self.assertEqual(len(full_default), 5)
            sliced = await book_routes.get_books(limit=2, offset=1, db=db)
            self.assertEqual(sliced, sample_books[1:3])

        parent_id = uuid4()
        sample_private = [SimpleNamespace(id=uuid4()) for _ in range(4)]
        mock_response = MagicMock()
        mock_response.headers = {}
        with patch("app.api.routes.parent_private_book.ParentPrivateBookService") as pb_cls:
            pb_cls.return_value.list_books = AsyncMock(return_value=sample_private)
            self.assertEqual(len(await private_book_routes.list_my_private_books(mock_response, actor_id=parent_id, db=db)), 4)
            self.assertEqual(len(await private_book_routes.list_my_private_books(mock_response, limit=2, offset=2, actor_id=parent_id, db=db)), 2)

        sample_sessions = [SimpleNamespace(Id=uuid4()) for _ in range(3)]
        with patch("app.api.routes.reading.ReadingContentService") as rc_cls:
            rc_cls.return_value.list_sessions = AsyncMock(return_value=sample_sessions)
            self.assertEqual(len(await reading_routes.get_sessions(actor_id=parent_id, db=db)), 3)
            self.assertEqual(await reading_routes.get_sessions(limit=1, offset=1, actor_id=parent_id, db=db), sample_sessions[1:2])

    async def test_artifact_stream_header_token_and_sanitized_errors(self) -> None:
        job_id = uuid4()
        worker_id = "colab-sec-worker"
        ref = format_gdrive_ref("drv_phase3_stream_001")
        with patch.dict(
            os.environ,
            {
                "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "k" * 48,
                "VIREAD_ARTIFACT_STREAM_SIGNING_SECRET": "s" * 48,
            },
        ):
            tok = sign_worker_artifact_token(job_id=str(job_id), worker_id=worker_id, reference=ref)

            # Missing token both in query and header -> 401
            with self.assertRaises(HTTPException) as missing_err:
                await admin_viread_training.stream_viread_colab_job_artifact(
                    job_id=job_id, worker_id=worker_id, token=None, header_token=None, _worker=None, db=MagicMock()
                )
            self.assertEqual(missing_err.exception.status_code, 401)

            # Tampered token -> sanitized 403 detail
            with self.assertRaises(HTTPException) as invalid_err:
                await admin_viread_training.stream_viread_colab_job_artifact(
                    job_id=job_id, worker_id=worker_id, token=None, header_token="bad.token", _worker=None, db=MagicMock()
                )
            self.assertEqual(invalid_err.exception.status_code, 403)
            self.assertEqual(invalid_err.exception.detail, "Invalid or expired artifact token")

            # Valid X-ViRead-Artifact-Token header succeeds and storage error only leaks code
            class _Repo:
                async def one(self, sql, _params=None):
                    if "FROM public.viread_ocr_training_jobs" in sql:
                        return {
                            "id": job_id,
                            "target": "COLAB",
                            "status": "COLAB_RUNNING",
                            "worker_id": worker_id,
                            "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
                            "dataset_version_id": uuid4(),
                            "locked_test_version_id": None,
                            "parent_checkpoint_sha256": "a" * 64,
                            "run_id": None,
                        }
                    return {"is_authorized": True}

            fake_svc = MagicMock(repo=_Repo())
            failing_router = MagicMock()
            failing_router.open_stream_with_metadata.side_effect = DriveTransientError(
                "internal secret host path /mnt/secret",
                http_status=503,
            )
            failing_drive_svc = MagicMock()
            failing_drive_svc.build_artifact_router = AsyncMock(return_value=failing_router)
            fake_db = MagicMock(rollback=AsyncMock())
            with (
                patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=fake_svc),
                patch.object(admin_viread_training, "VireadDriveConnectionService", return_value=failing_drive_svc),
            ):
                with self.assertRaises(HTTPException) as err_503:
                    await admin_viread_training.stream_viread_colab_job_artifact(
                        job_id=job_id, worker_id=worker_id, token=None, header_token=tok, _worker=None, db=fake_db
                    )
                self.assertEqual(err_503.exception.status_code, 503)
                self.assertNotIn("/mnt/secret", str(err_503.exception.detail))

    async def test_reading_management_missing_item_returns_404_not_stop_iteration(self) -> None:
        svc = MagicMock()
        svc.create_goal = AsyncMock(return_value=SimpleNamespace(Id=uuid4(), ChildId=uuid4()))
        svc.list_goals = AsyncMock(return_value=[])
        svc.add_collection = AsyncMock(return_value=None)
        svc.list_collections = AsyncMock(return_value=[])
        with patch.object(reading_management, "build_service", return_value=svc):
            with self.assertRaises(HTTPException) as goal_err:
                await reading_management.create_goal(MagicMock(), actor_id=uuid4(), db=MagicMock())
            self.assertEqual(goal_err.exception.status_code, 404)

            with self.assertRaises(HTTPException) as col_err:
                await reading_management.add_collection(
                    uuid4(), SimpleNamespace(child_id=uuid4(), collection_type="FAVORITE"), actor_id=uuid4(), db=MagicMock()
                )
            self.assertEqual(col_err.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
