"""Unit tests for Workstream A infrastructure & runtime hardening (INF-01..INF-05, OCR-04, OCR-11)."""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

BACKEND_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_ROOT.parent


def _fake_db_cm(session_obj: object) -> MagicMock:
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=session_obj)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


class DatabaseTransactionPoolerConfigTests(unittest.TestCase):
    def test_transaction_pooler_uses_tiny_bounded_pool_and_nullpool_escape_hatch(self) -> None:
        import certifi

        base_env = os.environ.copy()
        base_env.update(
            {
                "APP_ENVIRONMENT": "production",
                "DATABASE_POOLER_MODE": "transaction",
                "DATABASE_SSL_REQUIRED": "true",
                "DATABASE_SSL_ROOT_CERT": certifi.where(),
                "DATABASE_URL": "postgresql+asyncpg://u:p@db.example.com:6543/postgres",
                "SUPABASE_URL": "https://x.supabase.co",
                "SUPABASE_KEY": "test-key",
            }
        )
        base_env.pop("DATABASE_FORCE_NULL_POOL", None)
        base_env.pop("DATABASE_POOL_PRE_PING", None)

        check_bounded = (
            f"import sys; sys.path.insert(0, {str(BACKEND_ROOT)!r});"
            "from sqlalchemy.pool import AsyncAdaptedQueuePool;"
            "from app.database import session;"
            "pool = session.engine.pool;"
            "assert isinstance(pool, AsyncAdaptedQueuePool), type(pool);"
            "assert pool.size() == 2, pool.size();"
            "assert pool._max_overflow == 2, pool._max_overflow;"
            "assert pool._recycle == 180, pool._recycle;"
            "assert pool._pre_ping is False, pool._pre_ping;"
            "assert getattr(pool._pool, 'use_lifo', False) is True;"
            "assert session.asyncpg_connect_args['statement_cache_size'] == 0;"
            "assert session.sqlalchemy_database_url.query['prepared_statement_cache_size'] == '0';"
            "print('BOUNDED_TRANSACTION_POOL_OK')"
        )
        proc_bounded = subprocess.run(
            [sys.executable, "-c", check_bounded],
            env=base_env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(proc_bounded.returncode, 0, msg=proc_bounded.stderr or proc_bounded.stdout)
        self.assertIn("BOUNDED_TRANSACTION_POOL_OK", proc_bounded.stdout)

        pre_ping_env = {**base_env, "DATABASE_POOL_PRE_PING": "true"}
        check_pre_ping = (
            f"import sys; sys.path.insert(0, {str(BACKEND_ROOT)!r});"
            "from app.database import session;"
            "assert session.engine.pool._pre_ping is True, session.engine.pool._pre_ping;"
            "print('PRE_PING_OVERRIDE_OK')"
        )
        proc_pre_ping = subprocess.run(
            [sys.executable, "-c", check_pre_ping],
            env=pre_ping_env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(proc_pre_ping.returncode, 0, msg=proc_pre_ping.stderr or proc_pre_ping.stdout)
        self.assertIn("PRE_PING_OVERRIDE_OK", proc_pre_ping.stdout)

        forced_env = {**base_env, "DATABASE_FORCE_NULL_POOL": "true"}
        check_null = (
            f"import sys; sys.path.insert(0, {str(BACKEND_ROOT)!r});"
            "from sqlalchemy.pool import NullPool;"
            "from app.database import session;"
            "assert isinstance(session.engine.pool, NullPool), type(session.engine.pool);"
            "assert session.asyncpg_connect_args['statement_cache_size'] == 0;"
            "assert session.sqlalchemy_database_url.query['prepared_statement_cache_size'] == '0';"
            "print('FORCED_NULLPOOL_OK')"
        )
        proc_null = subprocess.run(
            [sys.executable, "-c", check_null],
            env=forced_env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(proc_null.returncode, 0, msg=proc_null.stderr or proc_null.stdout)
        self.assertIn("FORCED_NULLPOOL_OK", proc_null.stdout)


class ServerWorkerGatingAndHealthTests(unittest.TestCase):
    def _base_lifespan_patches(self, sever_mod, fake_worker):
        fake_db = {
            "ok": True,
            "dns_resolved": True,
            "ssl_enabled": True,
            "pool_class": "AsyncAdaptedQueuePool",
            "pooler_mode": "transaction",
            "latency_ms": 12,
            "error_type": None,
        }
        return (
            patch.object(sever_mod, "APP_ENVIRONMENT", "production"),
            patch.object(sever_mod, "warmup_ocr_engines", side_effect=AssertionError("warmup must stay off")),
            patch.object(sever_mod, "run_active_viread_model_worker", side_effect=AssertionError("model worker off")),
            patch.object(sever_mod, "run_viread_ocr_outbox_worker", new=fake_worker),
            patch.object(sever_mod, "run_viread_ocr_training_auto_worker", new=fake_worker),
            patch.object(sever_mod, "run_parent_book_submission_worker", new=fake_worker),
            patch.object(sever_mod, "run_book_quality_worker", new=fake_worker),
            patch.object(sever_mod, "run_admin_ai_workflow_worker", new=fake_worker),
            patch.object(sever_mod, "ensure_local_voice_worker_running", new=AsyncMock(return_value=False)),
            patch.object(sever_mod, "probe_database_connection", new=AsyncMock(return_value=fake_db)),
            patch.object(sever_mod, "_prewarm_tts_public_voice_ids_nonfatal", new=AsyncMock(return_value=None)),
            patch.object(
                sever_mod,
                "collect_remote_ocr_health",
                new=AsyncMock(return_value={"ready": True, "engines": {}, "workers": [], "queue": {}}),
            ),
            patch(
                "app.services.global_tasks_service.run_smart_studio_worker_loop",
                new=fake_worker,
            ),
        )

    def test_smart_studio_worker_gated_off_by_default_and_exposed_in_health(self) -> None:
        import app.sever as sever_mod

        async def _idle_worker(stop_event: asyncio.Event) -> None:
            await stop_event.wait()

        env_default = {
            "VIREAD_OCR_MODE": "remote_worker",
            "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
            "VIREAD_ENABLE_SMART_STUDIO_WORKER": "",
            "VIREAD_ENABLE_LIGHTWEIGHT_WORKERS": "",
            "BACKGROUND_WORKER_STARTUP_DELAY_SECONDS": "0",
        }
        patches = self._base_lifespan_patches(sever_mod, _idle_worker)
        with patch.dict(os.environ, env_default, clear=False):
            with (
                patches[0], patches[1], patches[2], patches[3], patches[4],
                patches[5], patches[6], patches[7], patches[8], patches[9],
                patches[10], patches[11], patches[12],
            ):
                with TestClient(sever_mod.app) as client:
                    self.assertIsNone(client.app.state.background_workers["smart_studio"])
                    resp = client.get("/health")
                    self.assertEqual(resp.status_code, 200)
                    workers = resp.json()["workers"]
                    self.assertIn("smart_studio", workers)
                    self.assertEqual(workers["smart_studio"], "disabled")
                    self.assertEqual(workers["parent_book_submission"], "disabled")

        # Explicit opt-in enables smart_studio while keeping heavy ML workers disabled.
        env_optin = {
            **env_default,
            "VIREAD_ENABLE_SMART_STUDIO_WORKER": "true",
        }
        patches2 = self._base_lifespan_patches(sever_mod, _idle_worker)
        with patch.dict(os.environ, env_optin, clear=False):
            with (
                patches2[0], patches2[1], patches2[2], patches2[3], patches2[4],
                patches2[5], patches2[6], patches2[7], patches2[8], patches2[9],
                patches2[10], patches2[11], patches2[12],
            ):
                with TestClient(sever_mod.app) as client:
                    self.assertIsNotNone(client.app.state.background_workers["smart_studio"])
                    resp = client.get("/health")
                    self.assertEqual(resp.status_code, 200)
                    workers = resp.json()["workers"]
                    self.assertEqual(workers["smart_studio"], "running")
                    self.assertEqual(workers["viread_ocr_training"], "disabled")
                    self.assertEqual(workers["active_model_registry"], "disabled")

    def test_lightweight_workers_flag_enables_db_sweepers_without_heavy_ml(self) -> None:
        import app.sever as sever_mod

        async def _idle_worker(stop_event: asyncio.Event) -> None:
            await stop_event.wait()

        env_lw = {
            "VIREAD_OCR_MODE": "remote_worker",
            "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
            "VIREAD_ENABLE_LIGHTWEIGHT_WORKERS": "true",
            "VIREAD_ENABLE_SMART_STUDIO_WORKER": "",
            "BACKGROUND_WORKER_STARTUP_DELAY_SECONDS": "0",
        }
        patches = self._base_lifespan_patches(sever_mod, _idle_worker)
        with patch.dict(os.environ, env_lw, clear=False):
            with (
                patches[0], patches[1], patches[2], patches[3], patches[4],
                patches[5], patches[6], patches[7], patches[8], patches[9],
                patches[10], patches[11], patches[12],
            ):
                with TestClient(sever_mod.app) as client:
                    state = client.app.state.background_workers
                    self.assertIsNotNone(state["book_quality"])
                    self.assertIsNotNone(state["admin_ai_workflow"])
                    self.assertIsNotNone(state["parent_book_submission"])
                    self.assertIsNotNone(state["viread_ocr_outbox"])
                    # Heavy/training/local-voice/smart-studio remain disabled
                    self.assertIsNone(state["viread_ocr_training"])
                    self.assertIsNone(state["active_model_registry"])
                    self.assertIsNone(state["local_trainer_process"])
                    self.assertIsNone(state["local_voice_bootstrap"])
                    self.assertIsNone(state["smart_studio"])

    def test_prewarm_tts_public_voice_ids_hook_is_nonfatal_and_fallback_safe(self) -> None:
        import app.sever as sever_mod
        from app.api.routes import voice_studio as voice_studio_route
        from app.services.tts_audio_cache_service import TtsAudioCacheService

        # 1. When prewarm_cached_public_voice_ids exists on TtsAudioCacheService, call it directly.
        prewarm_mock = AsyncMock(return_value=["local_north_truc_ly"])
        refresh_mock = AsyncMock(return_value=[])
        with (
            patch.object(TtsAudioCacheService, "prewarm_cached_public_voice_ids", prewarm_mock, create=True),
            patch.object(voice_studio_route, "refresh_cached_public_voice_ids", refresh_mock),
        ):
            asyncio.run(sever_mod._prewarm_tts_public_voice_ids_nonfatal(timeout=3.0))
        prewarm_mock.assert_awaited_once()
        refresh_mock.assert_not_awaited()

        # 2. When prewarm_cached_public_voice_ids raises, hook stays non-fatal and falls back.
        failing_mock = AsyncMock(side_effect=RuntimeError("db timeout"))
        refresh_mock2 = AsyncMock(return_value=["local_north_truc_ly"])
        with (
            patch.object(TtsAudioCacheService, "prewarm_cached_public_voice_ids", failing_mock, create=True),
            patch.object(voice_studio_route, "refresh_cached_public_voice_ids", refresh_mock2),
        ):
            asyncio.run(sever_mod._prewarm_tts_public_voice_ids_nonfatal(timeout=3.0))
        failing_mock.assert_awaited_once()
        refresh_mock2.assert_awaited_once_with(timeout=3.0)


class ExpandedInternalCronDispatchTests(unittest.TestCase):
    def test_cron_dispatch_runs_all_bounded_sweeps_and_respects_caps(self) -> None:
        from app.api.routes import internal_cron as internal_cron_route
        from app.services import cron_dispatch_service as cron_svc

        app = FastAPI()
        app.include_router(internal_cron_route.router, prefix="/internal/cron")
        client = TestClient(app)
        valid_token = "viread-cron-secret-" + ("a" * 24)

        fake_db = MagicMock()
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()

        fake_ocr_svc = MagicMock()
        fake_ocr_svc.reap_expired_leases = AsyncMock(
            return_value={"requeued": 3, "dead_lettered": 1}
        )
        fake_ocr_svc.prune_stale_worker_heartbeats = AsyncMock(return_value=4)

        fake_admin_repo = MagicMock()
        fake_admin_repo.claim_next = AsyncMock(side_effect=[uuid4(), uuid4(), None])
        fake_bq_repo = MagicMock()
        fake_bq_repo.claim_next_scan = AsyncMock(
            side_effect=[SimpleNamespace(Id=uuid4()), None]
        )

        with (
            patch.dict(os.environ, {"VIREAD_CRON_DISPATCH_TOKEN": valid_token}, clear=False),
            patch.object(internal_cron_route, "is_remote_ocr_mode", return_value=True),
            patch.object(internal_cron_route, "process_due_reminders_once", new=AsyncMock(return_value=2)),
            patch.object(internal_cron_route, "process_due_alerts_once", new=AsyncMock(return_value=1)),
            patch.object(
                internal_cron_route.parent_book_submission_worker,
                "cleanup_expired_temp_submissions",
                new=AsyncMock(return_value=5),
            ),
            patch.object(
                internal_cron_route.parent_book_submission_worker,
                "run_once",
                new=AsyncMock(return_value=True),  # Always True -> must stop at cap 5!
            ) as parent_run_mock,
            patch.object(cron_svc, "AsyncSessionLocal", side_effect=lambda: _fake_db_cm(fake_db)),
            patch.object(cron_svc, "OcrInferenceJobService", return_value=fake_ocr_svc),
            patch.object(
                cron_svc,
                "reconcile_orphaned_parent_submissions",
                new=AsyncMock(return_value={"reclaimed_count": 7, "failed_count": 2}),
            ) as reconcile_mock,
            patch.object(cron_svc, "AdminAiWorkflowRepository", return_value=fake_admin_repo),
            patch.object(cron_svc.admin_ai_workflow_worker, "_process", new=AsyncMock()) as admin_proc,
            patch.object(cron_svc, "BookContentQualityRepository", return_value=fake_bq_repo),
            patch.object(cron_svc.book_quality_worker, "_process_claimed_scan", new=AsyncMock()) as bq_proc,
            patch.object(
                cron_svc.viread_ocr_outbox_worker,
                "run_once",
                new=AsyncMock(return_value=True),  # Always True -> must stop at cap 5!
            ) as outbox_mock,
            patch.object(
                cron_svc.local_ocr_scan_service,
                "cleanup_expired_local_scan_objects",
                new=AsyncMock(return_value=6),
                create=True,
            ) as local_cleanup_mock,
        ):
            resp = client.post(
                "/internal/cron/dispatch",
                headers={"X-ViRead-Cron-Token": valid_token},
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["reminders_delivered"], 2)
        self.assertEqual(body["presence_alerts_delivered"], 1)
        self.assertEqual(body["temp_submissions_cleaned"], 5)
        self.assertEqual(body["post_ocr_swept"], 5)
        self.assertEqual(parent_run_mock.await_count, 5)
        self.assertEqual(body["ocr_leases_requeued"], 3)
        self.assertEqual(body["ocr_leases_dead_lettered"], 1)
        self.assertEqual(body["stale_worker_heartbeats_pruned"], 4)
        self.assertEqual(body["orphaned_parent_submissions_reclaimed"], 7)
        self.assertEqual(body["orphaned_parent_submissions_failed"], 2)
        self.assertEqual(reconcile_mock.await_args.kwargs["limit"], 20)
        self.assertEqual(body["admin_ai_workflows_swept"], 2)
        self.assertEqual(admin_proc.await_count, 2)
        self.assertEqual(body["book_quality_scans_swept"], 1)
        self.assertEqual(bq_proc.await_count, 1)
        self.assertEqual(body["ocr_outbox_swept"], 5)
        self.assertEqual(outbox_mock.await_count, 5)
        self.assertEqual(body["local_scan_objects_cleaned"], 6)
        local_cleanup_mock.assert_awaited_once_with(max_age_hours=24)
        self.assertEqual(body["sweep_errors"], [])

    def test_cron_dispatch_isolates_subsystem_failures_and_premerge_missing_helpers(self) -> None:
        from app.api.routes import internal_cron as internal_cron_route
        from app.services import cron_dispatch_service as cron_svc

        app = FastAPI()
        app.include_router(internal_cron_route.router, prefix="/internal/cron")
        client = TestClient(app)
        valid_token = "viread-cron-secret-" + ("b" * 24)

        # Bare service without reap_expired_leases / prune_stale_worker_heartbeats (pre-merge safe)
        bare_ocr_svc = SimpleNamespace()
        fake_db = MagicMock()
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()

        with (
            patch.dict(os.environ, {"VIREAD_CRON_DISPATCH_TOKEN": valid_token}, clear=False),
            patch.object(internal_cron_route, "is_remote_ocr_mode", return_value=True),
            patch.object(internal_cron_route, "process_due_reminders_once", new=AsyncMock(return_value=0)),
            patch.object(internal_cron_route, "process_due_alerts_once", new=AsyncMock(return_value=0)),
            patch.object(
                internal_cron_route.parent_book_submission_worker,
                "cleanup_expired_temp_submissions",
                new=AsyncMock(return_value=1),
            ),
            patch.object(
                internal_cron_route.parent_book_submission_worker,
                "run_once",
                new=AsyncMock(return_value=False),
            ),
            patch.object(cron_svc, "AsyncSessionLocal", side_effect=lambda: _fake_db_cm(fake_db)),
            patch.object(cron_svc, "OcrInferenceJobService", return_value=bare_ocr_svc),
            patch.object(
                cron_svc,
                "reconcile_orphaned_parent_submissions",
                new=AsyncMock(side_effect=RuntimeError("simulated db error")),
            ),
            patch.object(
                cron_svc,
                "AdminAiWorkflowRepository",
                return_value=MagicMock(claim_next=AsyncMock(return_value=None)),
            ),
            patch.object(
                cron_svc,
                "BookContentQualityRepository",
                return_value=MagicMock(claim_next_scan=AsyncMock(return_value=None)),
            ),
            patch.object(
                cron_svc.viread_ocr_outbox_worker,
                "run_once",
                new=AsyncMock(side_effect=[True, False]),
            ),
        ):
            resp = client.post(
                "/internal/cron/dispatch",
                headers={"X-ViRead-Cron-Token": valid_token},
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["temp_submissions_cleaned"], 1)
        self.assertEqual(body["ocr_outbox_swept"], 1)
        self.assertEqual(body["ocr_leases_requeued"], 0)
        self.assertEqual(body["stale_worker_heartbeats_pruned"], 0)
        self.assertIn("orphaned_parent_submissions", body["sweep_errors"])
        self.assertNotIn("simulated db error", str(body))


class StaticInfraContractsTests(unittest.TestCase):
    def test_render_yaml_blueprint_is_valid_and_contains_zero_secrets(self) -> None:
        render_path = REPO_ROOT / "render.yaml"
        self.assertTrue(render_path.is_file(), "render.yaml must exist at repo root")
        raw = render_path.read_text(encoding="utf-8")

        for secret_pattern in (r"AIza[0-9A-Za-z_-]+", r"gsk_[0-9A-Za-z]+", r"sb_secret_", r"eyJhbGci"):
            self.assertIsNone(re.search(secret_pattern, raw), f"Secret leaked in render.yaml: {secret_pattern}")

        parsed = yaml.safe_load(raw)
        services = parsed.get("services") or []
        self.assertEqual(len(services), 1)
        svc = services[0]
        self.assertIn("backend/requirements-web.txt", svc["buildCommand"])
        self.assertIn("uvicorn app.sever:app", svc["startCommand"])
        self.assertEqual(svc["healthCheckPath"], "/health")
        env_map = {item["key"]: item for item in svc["envVars"]}
        for secret_key in (
            "DATABASE_URL",
            "SUPABASE_SECRET_KEY",
            "VIREAD_OCR_WORKER_TOKEN",
            "VIREAD_VOICE_WORKER_TOKEN",
            "VIREAD_CRON_DISPATCH_TOKEN",
        ):
            self.assertIn(secret_key, env_map)
            self.assertIs(env_map[secret_key].get("sync"), False)
            self.assertNotIn("value", env_map[secret_key])

    def test_fk_index_migration_contains_all_11_partial_indexes(self) -> None:
        mig_path = REPO_ROOT / "supabase" / "migrations" / "20261126010000_hot_fk_indexes_and_cleanup.sql"
        self.assertTrue(mig_path.is_file())
        sql = mig_path.read_text(encoding="utf-8")
        expected_indexes = (
            ("ix_ocr_inference_jobs_revision_id", "revision_id"),
            ("ix_ocr_worker_heartbeats_active_job_id", "active_job_id"),
            ("ix_tts_audio_cache_entries_page_id", "page_id"),
            ("ix_tts_audio_cache_entries_page_revision_id", "page_revision_id"),
            ("ix_book_presentation_assets_source_revision_id", "source_revision_id"),
            ("ix_book_style_bibles_owner_id", "owner_id"),
            ("ix_page_ocr_extractions_page_revision_id", "page_revision_id"),
            ("ix_page_ocr_extractions_owner_id", "owner_id"),
            ("ix_smart_studio_jobs_book_id", "book_id"),
            ("ix_smart_studio_jobs_book_page_id", "book_page_id"),
            ("ix_smart_studio_jobs_source_revision_id", "source_revision_id"),
        )
        for idx_name, col_name in expected_indexes:
            self.assertIn(f"CREATE INDEX IF NOT EXISTS {idx_name}", sql)
            self.assertIn(f"WHERE {col_name} IS NOT NULL", sql)

    def test_next_config_disables_powered_by_header(self) -> None:
        cfg = (REPO_ROOT / "frontend" / "next.config.ts").read_text(encoding="utf-8")
        self.assertIn("poweredByHeader: false", cfg)


if __name__ == "__main__":
    unittest.main()
