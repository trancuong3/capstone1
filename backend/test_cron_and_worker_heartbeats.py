"""Unit tests for durable worker heartbeats, cron isolation, and event-driven background workers."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import unittest
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

BACKEND_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from app.api.deps import get_db, require_parent_id  # noqa: E402
from app.api.routes import reading_presence as reading_presence_route  # noqa: E402
from app.jobs import (  # noqa: E402
    admin_ai_workflow_worker,
    book_quality_worker,
    parent_email_dispatcher_worker,
    reading_presence_alert_worker,
    reading_reminder_worker,
    viread_ocr_outbox_worker,
    viread_ocr_training_auto_worker,
)
from app.services import cron_dispatch_service as cron_svc  # noqa: E402
from app.services import global_tasks_service  # noqa: E402
from app.services.book_content_quality_service import BookContentQualityService  # noqa: E402
from app.services.worker_telemetry import (  # noqa: E402
    clear_worker_telemetry,
    get_worker_telemetry,
    persist_worker_heartbeat,
    persist_worker_heartbeats_batch,
    read_persisted_worker_heartbeats,
)


HEARTBEATS_DDL_SQLITE = """
CREATE TABLE system_worker_heartbeats (
    worker_key TEXT PRIMARY KEY,
    execution_mode TEXT NOT NULL,
    last_run_at TEXT,
    last_success_at TEXT,
    last_error_at TEXT,
    last_error_code TEXT,
    last_items_processed INTEGER NOT NULL DEFAULT 0,
    last_source TEXT,
    updated_at TEXT NOT NULL
)
"""

BOOK_QUALITY_SCAN_RUNS_DDL_SQLITE = """
CREATE TABLE bookqualityscanruns (
    id TEXT PRIMARY KEY,
    bookid TEXT,
    booktitlesnapshot TEXT NOT NULL DEFAULT 'Test Book',
    triggertype TEXT NOT NULL DEFAULT 'ADMIN_MANUAL',
    scope TEXT NOT NULL DEFAULT 'BOOK',
    targetpageid TEXT,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    workerid TEXT,
    leaseexpiresat TIMESTAMP,
    attemptcount INTEGER NOT NULL DEFAULT 0,
    totalpages INTEGER NOT NULL DEFAULT 0,
    completedpages INTEGER NOT NULL DEFAULT 0,
    skippedpages INTEGER NOT NULL DEFAULT 0,
    failedpages INTEGER NOT NULL DEFAULT 0,
    aicompletedpages INTEGER NOT NULL DEFAULT 0,
    aiunavailablepages INTEGER NOT NULL DEFAULT 0,
    errorsummary TEXT,
    startedat TIMESTAMP,
    completedat TIMESTAMP,
    createdat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

ADMIN_AI_WORKFLOWS_DDL_SQLITE = """
CREATE TABLE adminaiworkflows (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    stage TEXT NOT NULL DEFAULT 'PROOFREADING',
    retryafter TIMESTAMP,
    leaseexpiresat TIMESTAMP
)
"""


class _AsyncSqliteSession:
    """Real SQLite-backed AsyncSession adapter using Python stdlib sqlite3 + SQLAlchemy."""

    def __init__(self, sync_session) -> None:
        self._sync = sync_session
        self.bind = sync_session.get_bind()

    async def execute(self, statement, params=None):
        if params is not None:
            return self._sync.execute(statement, params)
        return self._sync.execute(statement)

    async def scalar(self, statement, params=None):
        if params is not None:
            return self._sync.scalar(statement, params)
        return self._sync.scalar(statement)

    async def commit(self) -> None:
        self._sync.commit()

    async def rollback(self) -> None:
        self._sync.rollback()

    async def close(self) -> None:
        self._sync.close()

    async def __aenter__(self) -> "_AsyncSqliteSession":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        if exc_type is not None:
            self._sync.rollback()
        self._sync.close()
        return False


def _make_sqlite_session_factory(*ddl_statements: str):
    engine = create_engine("sqlite:///:memory:", future=True)
    with engine.begin() as conn:
        for ddl in ddl_statements:
            conn.execute(text(ddl))
    sync_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def _factory() -> _AsyncSqliteSession:
        return _AsyncSqliteSession(sync_factory())

    return engine, _factory


class WorkerHeartbeatPersistenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_worker_telemetry()

    def tearDown(self) -> None:
        clear_worker_telemetry()

    def test_migration_file_defines_heartbeats_table_with_rls_and_service_role_grants(self) -> None:
        migrations = sorted(
            (REPO_ROOT / "supabase" / "migrations").glob("*_system_worker_heartbeats.sql")
        )
        self.assertTrue(migrations, "Expected system_worker_heartbeats migration file")
        mig_path = migrations[-1]
        self.assertGreater(
            mig_path.name,
            "20261126090000_full_audit_security_rls_fk_and_indexes.sql",
        )
        sql = mig_path.read_text(encoding="utf-8")
        for expected in (
            "CREATE TABLE IF NOT EXISTS public.system_worker_heartbeats",
            "worker_key TEXT PRIMARY KEY",
            "execution_mode TEXT NOT NULL",
            "last_run_at TIMESTAMPTZ",
            "last_success_at TIMESTAMPTZ",
            "last_error_at TIMESTAMPTZ",
            "last_error_code TEXT",
            "last_items_processed INT NOT NULL DEFAULT 0",
            "last_source TEXT",
            "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
            "ENABLE ROW LEVEL SECURITY",
            "REVOKE ALL ON TABLE public.system_worker_heartbeats FROM PUBLIC, anon, authenticated",
            "GRANT ALL ON TABLE public.system_worker_heartbeats TO service_role",
        ):
            self.assertIn(expected, sql)

    async def test_persisted_heartbeat_survives_cold_restart_and_records_zero_items(self) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            # 1. Persist idle success (0 items processed)
            async with session_factory() as db:
                await persist_worker_heartbeat(
                    db,
                    "reading_reminder",
                    execution_mode="cron_scheduled",
                    ok=True,
                    items_processed=0,
                    source="cron",
                )

            # 2. Persist error then recovery to verify last_success_at retention & error clearing
            async with session_factory() as db:
                await persist_worker_heartbeat(
                    db,
                    "viread_ocr_outbox",
                    execution_mode="cron_scheduled",
                    ok=True,
                    items_processed=3,
                    source="cron",
                )
            async with session_factory() as db:
                await persist_worker_heartbeat(
                    db,
                    "viread_ocr_outbox",
                    execution_mode="cron_scheduled",
                    ok=False,
                    items_processed=0,
                    source="cron",
                    error_code="DRIVE_QUOTA_EXCEEDED",
                )

            # Simulate Render Free 15m spin-down / cold restart wiping process memory
            clear_worker_telemetry()
            self.assertIsNone(get_worker_telemetry("reading_reminder")["last_success_at"])

            # Read back in a fresh session
            async with session_factory() as db:
                heartbeats = await read_persisted_worker_heartbeats(db)

            self.assertIn("reading_reminder", heartbeats)
            rem = heartbeats["reading_reminder"]
            self.assertEqual(rem["execution_mode"], "cron_scheduled")
            self.assertEqual(rem["last_items_processed"], 0)
            self.assertEqual(rem["last_source"], "cron")
            self.assertIsNotNone(rem["last_run_at"])
            self.assertIsNotNone(rem["last_success_at"])
            self.assertIsNone(rem["last_error_at"])
            self.assertIsNone(rem["last_error_code"])
            self.assertIsNotNone(rem["updated_at"])
            # ISO-8601 UTC parseable strings
            parsed_run = datetime.fromisoformat(rem["last_run_at"])
            self.assertIsNotNone(parsed_run.tzinfo)

            outbox = heartbeats["viread_ocr_outbox"]
            self.assertIsNotNone(outbox["last_success_at"])  # Preserved from earlier success
            self.assertIsNotNone(outbox["last_error_at"])
            self.assertEqual(outbox["last_error_code"], "DRIVE_QUOTA_EXCEEDED")
            self.assertEqual(outbox["last_items_processed"], 0)

            # Recovery clears active last_error_code while updating last_success_at
            async with session_factory() as db:
                await persist_worker_heartbeat(
                    db,
                    "viread_ocr_outbox",
                    execution_mode="on_demand",
                    ok=True,
                    items_processed=1,
                    source="event",
                )
            async with session_factory() as db:
                recovered = (await read_persisted_worker_heartbeats(db))["viread_ocr_outbox"]
            self.assertIsNone(recovered["last_error_code"])
            self.assertEqual(recovered["execution_mode"], "on_demand")
            self.assertEqual(recovered["last_source"], "event")
            self.assertEqual(recovered["last_items_processed"], 1)
        finally:
            engine.dispose()

    async def test_heartbeat_helpers_are_failsafe_when_table_missing(self) -> None:
        engine, session_factory = _make_sqlite_session_factory()  # No tables created
        try:
            async with session_factory() as db:
                await persist_worker_heartbeat(
                    db,
                    "reading_reminder",
                    execution_mode="cron_scheduled",
                    ok=True,
                    items_processed=0,
                    source="cron",
                )
            async with session_factory() as db:
                rows = await read_persisted_worker_heartbeats(db)
            self.assertEqual(rows, {})
        finally:
            engine.dispose()

    async def test_batch_heartbeat_upsert_persists_all_workers_in_single_sql_rtt_and_deduplicates(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            async with session_factory() as db:
                original_execute = db.execute
                execute_calls = 0

                async def _counting_execute(stmt, params=None):
                    nonlocal execute_calls
                    execute_calls += 1
                    return await original_execute(stmt, params)

                db.execute = _counting_execute  # type: ignore[method-assign]
                await persist_worker_heartbeats_batch(
                    db,
                    [
                        {
                            "worker_id": "viread_ocr_outbox",
                            "execution_mode": "cron_scheduled",
                            "ok": False,
                            "items_processed": 0,
                            "error_code": "INITIAL_ERR",
                            "source": "cron",
                        },
                        # Duplicate key in same batch must deduplicate (keeping latest)
                        {
                            "worker_id": "viread_ocr_outbox",
                            "execution_mode": "cron_scheduled",
                            "ok": True,
                            "items_processed": 2,
                            "source": "cron",
                        },
                        {
                            "worker_id": "parent_email_dispatcher",
                            "execution_mode": "cron_scheduled",
                            "ok": True,
                            "items_processed": 4,
                            "source": "cron",
                        },
                        {
                            "worker_id": "reading_reminder",
                            "execution_mode": "cron_scheduled",
                            "ok": True,
                            "items_processed": 1,
                            "source": "cron",
                        },
                    ],
                )
                self.assertEqual(execute_calls, 1, "Batch upsert must execute strictly 1 SQL statement")

            async with session_factory() as db:
                hb = await read_persisted_worker_heartbeats(db)
            self.assertEqual(
                set(hb.keys()),
                {"viread_ocr_outbox", "parent_email_dispatcher", "reading_reminder"},
            )
            self.assertIsNone(hb["viread_ocr_outbox"]["last_error_code"])
            self.assertEqual(hb["viread_ocr_outbox"]["last_items_processed"], 2)
            self.assertEqual(hb["parent_email_dispatcher"]["last_items_processed"], 4)
        finally:
            engine.dispose()


class CronIsolationAndHeartbeatSweepTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_worker_telemetry()

    def tearDown(self) -> None:
        clear_worker_telemetry()

    async def test_cron_isolates_reminders_failure_and_persists_all_worker_heartbeats(self) -> None:
        engine, session_factory = _make_sqlite_session_factory(
            HEARTBEATS_DDL_SQLITE,
            BOOK_QUALITY_SCAN_RUNS_DDL_SQLITE,
            ADMIN_AI_WORKFLOWS_DDL_SQLITE,
        )
        try:
            fake_ocr_svc = MagicMock()
            fake_ocr_svc.reap_expired_leases = AsyncMock(
                return_value={"requeued": 0, "dead_lettered": 0}
            )
            fake_ocr_svc.prune_stale_worker_heartbeats = AsyncMock(return_value=0)

            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    },
                    clear=False,
                ),
                patch.object(cron_svc, "AsyncSessionLocal", side_effect=session_factory),
                patch.object(cron_svc, "OcrInferenceJobService", return_value=fake_ocr_svc),
                patch.object(
                    cron_svc,
                    "reconcile_orphaned_parent_submissions",
                    new=AsyncMock(return_value={"reclaimed_count": 0, "failed_count": 0}),
                ),
                patch.object(
                    cron_svc.viread_ocr_outbox_worker,
                    "run_once",
                    new=AsyncMock(return_value=False),
                ),
                patch.object(
                    cron_svc.viread_ocr_training_auto_worker,
                    "run_maintenance_once",
                    new=AsyncMock(return_value={"ok": True, "colab_activity": False}),
                ) as training_maint_mock,
            ):
                result = await cron_svc.run_scheduled_cron_dispatch(
                    run_remote_sweeps=True,
                    reminders_runner=AsyncMock(side_effect=RuntimeError("smtp_down")),
                    alerts_runner=AsyncMock(return_value=2),
                    temp_cleanup_runner=AsyncMock(return_value=0),
                    parent_post_ocr_runner=AsyncMock(return_value=False),
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["reminders_delivered"], 0)
            self.assertEqual(result["presence_alerts_delivered"], 2)
            self.assertTrue(result["ocr_training_maintenance_ran"])
            self.assertIn("reading_reminder", result["sweep_errors"])
            self.assertNotIn("reading_presence", result["sweep_errors"])
            training_maint_mock.assert_awaited_once()

            # Verify in-memory error telemetry recorded for reminders
            self.assertEqual(
                get_worker_telemetry("reading_reminder")["last_error"],
                "RuntimeError",
            )

            # Verify persisted heartbeats exist for all 7 workers (even with 0 items processed!)
            async with session_factory() as db:
                hb = await read_persisted_worker_heartbeats(db)

            for worker_key in (
                "reading_reminder",
                "reading_presence",
                "parent_book_submission",
                "admin_ai_workflow",
                "book_quality",
                "viread_ocr_outbox",
                "viread_ocr_training",
            ):
                self.assertIn(worker_key, hb, f"Missing persisted heartbeat for {worker_key}")
                self.assertEqual(hb[worker_key]["execution_mode"], "cron_scheduled")
                self.assertEqual(hb[worker_key]["last_source"], "cron")

            self.assertEqual(hb["reading_reminder"]["last_error_code"], "RuntimeError")
            self.assertIsNone(hb["reading_presence"]["last_error_code"])
            self.assertEqual(hb["reading_presence"]["last_items_processed"], 2)
            self.assertIsNone(hb["parent_book_submission"]["last_error_code"])
            self.assertEqual(hb["parent_book_submission"]["last_items_processed"], 0)
            self.assertIsNone(hb["viread_ocr_training"]["last_error_code"])
        finally:
            engine.dispose()

    async def test_reading_reminder_process_due_records_error_telemetry_on_failure(self) -> None:
        broken_repo = MagicMock()
        broken_repo.create_due_occurrences_for_worker = AsyncMock(
            side_effect=ConnectionError("db lost")
        )
        fake_session = AsyncMock()
        session_entries = 0

        @asynccontextmanager
        async def _single_session():
            nonlocal session_entries
            session_entries += 1
            yield fake_session

        with (
            patch.object(
                reading_reminder_worker, "AsyncSessionLocal", side_effect=_single_session
            ),
            patch.object(
                reading_reminder_worker,
                "ReadingManagementRepository",
                return_value=broken_repo,
            ),
        ):
            with self.assertRaises(ConnectionError):
                await reading_reminder_worker.process_due_reminders_once()

        self.assertEqual(session_entries, 1)
        self.assertEqual(
            get_worker_telemetry("reading_reminder")["last_error"],
            "ConnectionError",
        )

    async def test_cron_runs_fast_db_sweeps_before_outbound_email_and_persists_all_8_workers(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(
            HEARTBEATS_DDL_SQLITE,
            BOOK_QUALITY_SCAN_RUNS_DDL_SQLITE,
            ADMIN_AI_WORKFLOWS_DDL_SQLITE,
        )
        try:
            call_order: list[str] = []

            async def _fake_reap():
                call_order.append("ocr_leases")
                return {"requeued": 0, "dead_lettered": 0}

            fake_ocr_svc = MagicMock()
            fake_ocr_svc.reap_expired_leases = AsyncMock(side_effect=_fake_reap)
            fake_ocr_svc.prune_stale_worker_heartbeats = AsyncMock(return_value=0)

            async def _fake_reconcile(**_kw):
                call_order.append("parent_book_submission")
                return {"reclaimed_count": 0, "failed_count": 0}

            async def _fake_outbox():
                call_order.append("viread_ocr_outbox")
                return False

            async def _fake_training():
                call_order.append("viread_ocr_training")
                return {"ok": True, "colab_activity": False}

            async def _fake_local_cleanup(*, max_age_hours=24):
                call_order.append("local_scan_cleanup")
                return 0

            async def _fake_reminders(*, now=None):
                call_order.append("reading_reminder")
                return 3

            async def _fake_alerts(*, now=None):
                call_order.append("reading_presence")
                return 1

            async def _fake_engagement(*, now=None):
                call_order.append("parent_email_dispatcher")
                return 2

            async def _fake_keepwarm():
                call_order.append("hf_space_keepwarm")
                return False

            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    },
                    clear=False,
                ),
                patch.object(cron_svc, "AsyncSessionLocal", side_effect=session_factory),
                patch.object(cron_svc, "OcrInferenceJobService", return_value=fake_ocr_svc),
                patch.object(
                    cron_svc,
                    "reconcile_orphaned_parent_submissions",
                    new=AsyncMock(side_effect=_fake_reconcile),
                ),
                patch.object(
                    cron_svc.viread_ocr_outbox_worker,
                    "run_once",
                    new=AsyncMock(side_effect=_fake_outbox),
                ),
                patch.object(
                    cron_svc.viread_ocr_training_auto_worker,
                    "run_maintenance_once",
                    new=AsyncMock(side_effect=_fake_training),
                ),
                patch.object(
                    cron_svc,
                    "_cleanup_expired_local_scans",
                    new=AsyncMock(side_effect=_fake_local_cleanup),
                ),
                patch.object(
                    cron_svc,
                    "maybe_keep_warm_hf_space_from_cron",
                    new=AsyncMock(side_effect=_fake_keepwarm),
                ),
            ):
                result = await cron_svc.run_scheduled_cron_dispatch(
                    run_remote_sweeps=True,
                    reminders_runner=_fake_reminders,
                    alerts_runner=_fake_alerts,
                    engagement_runner=_fake_engagement,
                    temp_cleanup_runner=AsyncMock(return_value=0),
                    parent_post_ocr_runner=AsyncMock(return_value=False),
                )

            self.assertEqual(result["sweep_errors"], [])
            self.assertEqual(result["engagement_emails_delivered"], 2)
            # Verify fast DB sweeps ran BEFORE outbound HTTP/email runners
            self.assertLess(
                call_order.index("viread_ocr_training"),
                call_order.index("reading_reminder"),
            )
            self.assertLess(
                call_order.index("viread_ocr_outbox"),
                call_order.index("reading_reminder"),
            )
            self.assertLess(
                call_order.index("reading_reminder"),
                call_order.index("parent_email_dispatcher"),
            )
            self.assertLess(
                call_order.index("parent_email_dispatcher"),
                call_order.index("hf_space_keepwarm"),
            )

            async with session_factory() as db:
                hb = await read_persisted_worker_heartbeats(db)

            expected_8 = (
                "parent_book_submission",
                "admin_ai_workflow",
                "book_quality",
                "viread_ocr_outbox",
                "viread_ocr_training",
                "reading_reminder",
                "reading_presence",
                "parent_email_dispatcher",
            )
            for key in expected_8:
                self.assertIn(key, hb, f"Missing persisted heartbeat for {key}")
                self.assertIsNone(hb[key]["last_error_code"], f"Unexpected error for {key}")
            self.assertEqual(hb["parent_email_dispatcher"]["last_items_processed"], 2)
            self.assertIsNotNone(
                get_worker_telemetry("parent_email_dispatcher")["last_success_at"]
            )
        finally:
            engine.dispose()

    async def test_parent_book_submission_heartbeat_not_marked_ok_when_budget_exhausted_before_running(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            async def _slow_ocr_reap(**_kw):
                await asyncio.sleep(0.05)
                return (0, 0, 0)

            with (
                patch.object(cron_svc, "AsyncSessionLocal", side_effect=session_factory),
                patch.object(
                    cron_svc, "_sweep_ocr_leases_and_heartbeats", side_effect=_slow_ocr_reap
                ),
                patch.object(cron_svc, "_remaining_budget", side_effect=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            ):
                await cron_svc.run_scheduled_cron_dispatch(
                    run_remote_sweeps=True,
                    reminders_runner=AsyncMock(return_value=0),
                    alerts_runner=AsyncMock(return_value=0),
                    engagement_runner=AsyncMock(return_value=0),
                )

            async with session_factory() as db:
                hb = await read_persisted_worker_heartbeats(db)
            self.assertNotIn("parent_book_submission", hb)
        finally:
            engine.dispose()

    async def test_parent_email_dispatcher_dispatch_all_once_persists_all_3_email_heartbeats(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            with (
                patch.object(
                    parent_email_dispatcher_worker,
                    "AsyncSessionLocal",
                    side_effect=session_factory,
                ),
                patch.object(
                    parent_email_dispatcher_worker,
                    "_worker_ready",
                    return_value=(True, "resend"),
                ),
                patch.object(
                    parent_email_dispatcher_worker,
                    "active_email_provider",
                    return_value="resend",
                ),
                patch.object(
                    parent_email_dispatcher_worker,
                    "process_due_alerts_once",
                    new=AsyncMock(return_value=1),
                ),
                patch.object(
                    parent_email_dispatcher_worker,
                    "process_due_reminders_once",
                    new=AsyncMock(return_value=3),
                ),
                patch.object(
                    parent_email_dispatcher_worker,
                    "process_engagement_emails_once",
                    new=AsyncMock(return_value=2),
                ),
            ):
                summary = await parent_email_dispatcher_worker.dispatch_all_once(scope="all")

            self.assertEqual(summary["presence_sent"], 1)
            self.assertEqual(summary["reminders_sent"], 3)
            self.assertEqual(summary["engagement_sent"], 2)
            async with session_factory() as db:
                hb = await read_persisted_worker_heartbeats(db)
            for key, expected_items in (
                ("reading_presence", 1),
                ("reading_reminder", 3),
                ("parent_email_dispatcher", 6),
            ):
                self.assertIn(key, hb)
                self.assertIsNone(hb[key]["last_error_code"])
                self.assertEqual(hb[key]["last_items_processed"], expected_items)
        finally:
            engine.dispose()

    async def test_engagement_dispatch_uses_batch_prefetch_and_respects_max_emails_cap(
        self,
    ) -> None:
        from app.providers import parent_email_transport as transport
        from app.repositories.parent_email_notification_repository import (
            ActiveParentBundle,
            ChildActivitySnapshot,
            ParentDeliverySummary,
        )
        from app.services.parent_email_notification_service import (
            ParentEmailNotificationService,
        )

        # Monday 2026-11-30 09:00 Asia/Ho_Chi_Minh == 02:00 UTC (non-digest day; default digest is Sunday)
        now = datetime(2026, 11, 30, 2, 0, tzinfo=timezone.utc)
        bundles = []
        snapshots = {}
        for idx in range(4):
            pid = uuid4()
            cid = uuid4()
            child = SimpleNamespace(
                Id=cid,
                ParentId=pid,
                Alias=f"Bé {idx}",
                CreatedAt=now - timedelta(days=10),
            )
            bundles.append(
                ActiveParentBundle(
                    parent_id=pid,
                    display_name=f"Parent {idx}",
                    children=(child,),
                    preferences=None,
                    created_at=now - timedelta(days=20 - idx),
                )
            )
            snapshots[cid] = ChildActivitySnapshot(
                child=child,
                sessions_last_7d=(),
                sessions_prev_7d_count=0,
                sessions_last_35d=(),
                total_completed_sessions=0,
                last_session_at=None,
                avg_fluency_last_7d=None,
                top_difficult_words_last_7d=(),
                active_goals=(),
                first_completed_session_at=None,
            )

        class _BatchRepo:
            def __init__(self) -> None:
                self.batch_summary_calls = 0
                self.batch_retry_calls = 0
                self.batch_snapshot_calls = 0
                self.single_snapshot_calls = 0
                self.captured_digest_child_ids: list[set[UUID]] = []
                self.claimed: set[str] = set()

            async def is_storage_ready(self) -> bool:
                return True

            async def recover_stale_sending(self, *_a, **_kw) -> int:
                return 0

            async def list_active_parents_with_children(self, **_kw):
                return bundles

            async def get_parent_delivery_summaries_batch(self, parent_ids, _now):
                self.batch_summary_calls += 1
                return {pid: ParentDeliverySummary(automated_sent_last_7d=0) for pid in parent_ids}

            async def list_retry_deliveries_batch(self, _parent_ids):
                self.batch_retry_calls += 1
                return {}

            async def get_children_activity_snapshots_batch(
                self, children, _now, *, digest_child_ids=None
            ):
                self.batch_snapshot_calls += 1
                self.captured_digest_child_ids.append(set(digest_child_ids or set()))
                return {c.Id: snapshots[c.Id] for c in children}

            async def get_child_activity_snapshot(self, child, _now):
                self.single_snapshot_calls += 1
                return snapshots[child.Id]

            async def get_delivery_by_dedupe_key(self, _key):
                return None

            async def claim_or_retry_delivery(self, **kw):
                key = kw["dedupe_key"]
                if key in self.claimed:
                    return None
                self.claimed.add(key)
                return SimpleNamespace(Id=uuid4(), Attempts=1)

            async def finish_delivery(self, *_a, **_kw) -> None:
                return None

        repo = _BatchRepo()
        svc = ParentEmailNotificationService(repo)  # type: ignore[arg-type]
        sent = []

        async def _resolve(_pid):
            return "parent@example.test"

        with (
            patch.object(transport.settings, "RESEND_API_KEY", "re_test_key"),
            patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"),
        ):
            delivered = await svc.dispatch_engagement_emails(
                now,
                recipient_resolver=_resolve,
                message_sender=lambda m: sent.append(m) or "resend",
                max_emails=2,
                max_seconds=10.0,
            )

        self.assertEqual(delivered, 2, "Must respect max_emails=2 cap per cron tick")
        self.assertEqual(len(sent), 2)
        self.assertEqual(repo.batch_summary_calls, 1)
        self.assertEqual(repo.batch_retry_calls, 1)
        self.assertEqual(repo.batch_snapshot_calls, 1)
        self.assertEqual(repo.single_snapshot_calls, 0, "Must use batch snapshot query instead of N+1")
        self.assertEqual(
            repo.captured_digest_child_ids,
            [set()],
            "On non-digest day with no digest retries, digest_child_ids must be empty",
        )

    async def test_cron_route_handlers_unwrap_optional_header_and_query_on_direct_call(
        self,
    ) -> None:
        from fastapi import HTTPException
        from app.api.routes import internal_cron, parent_notifications

        with patch.dict(
            os.environ,
            {"VIREAD_CRON_DISPATCH_TOKEN": "a" * 40},
            clear=False,
        ):
            with self.assertRaises(HTTPException) as ctx_internal:
                internal_cron.require_cron_dispatch_token()
            self.assertEqual(ctx_internal.exception.status_code, 401)

        with patch.object(
            parent_notifications.settings, "PARENT_EMAIL_CRON_SECRET", "s" * 24
        ):
            with self.assertRaises(HTTPException) as ctx_parent:
                await parent_notifications.trigger_cron_dispatch()
            self.assertEqual(ctx_parent.exception.status_code, 401)

    async def test_parent_email_repository_batch_queries_compile_cleanly_for_postgres(
        self,
    ) -> None:
        from sqlalchemy.dialects import postgresql
        from app.repositories.parent_email_notification_repository import (
            ParentEmailNotificationRepository,
        )

        compiled_sqls: list[str] = []

        class _CompilingSession:
            async def execute(self, stmt, *_a, **_kw):
                compiled_sqls.append(
                    str(stmt.compile(dialect=postgresql.dialect()))
                )
                return SimpleNamespace(
                    all=lambda: [],
                    scalars=lambda: SimpleNamespace(all=lambda: []),
                )

        repo = ParentEmailNotificationRepository(_CompilingSession())  # type: ignore[arg-type]
        now = datetime(2026, 11, 27, 15, 0, tzinfo=timezone.utc)
        pid = uuid4()
        cid = uuid4()
        child = SimpleNamespace(Id=cid, ParentId=pid, Alias="Bé An", CreatedAt=now)

        summaries = await repo.get_parent_delivery_summaries_batch([pid], now)
        self.assertEqual(summaries[pid].automated_sent_last_7d, 0)

        retries = await repo.list_retry_deliveries_batch([pid])
        self.assertEqual(retries, {})

        # Non-digest batch: strictly 3 queries (sessions, aggregates, goals)
        before_non_digest = len(compiled_sqls)
        snaps_non_digest = await repo.get_children_activity_snapshots_batch(
            [child], now, digest_child_ids=set()
        )
        self.assertIn(cid, snaps_non_digest)
        self.assertEqual(len(compiled_sqls) - before_non_digest, 3)

        # Digest batch: 6 queries (adds fluency, comparison reports, difficult words)
        before_digest = len(compiled_sqls)
        snaps_digest = await repo.get_children_activity_snapshots_batch(
            [child], now, digest_child_ids={cid}
        )
        self.assertIn(cid, snaps_digest)
        self.assertEqual(len(compiled_sqls) - before_digest, 6)
        joined = "\n".join(compiled_sqls)
        self.assertIn("FROM readingcomparisonreports JOIN readingsessions", joined)
        self.assertIn("FROM pagerevisionwords JOIN readingevents", joined)


class BookQualityAndAdminWorkflowEventTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_worker_telemetry()

    async def asyncTearDown(self) -> None:
        await book_quality_worker.shutdown_scheduled_book_quality_scans(timeout_seconds=1.0)
        await admin_ai_workflow_worker.shutdown_scheduled_admin_ai_workflows(timeout_seconds=1.0)
        clear_worker_telemetry()

    async def test_book_quality_event_scheduling_and_cron_no_5s_cancellation_requeue_loop(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(
            HEARTBEATS_DDL_SQLITE,
            BOOK_QUALITY_SCAN_RUNS_DDL_SQLITE,
            ADMIN_AI_WORKFLOWS_DDL_SQLITE,
        )
        try:
            scan_id = uuid4()
            async with session_factory() as db:
                await db.execute(
                    text(
                        "INSERT INTO bookqualityscanruns (id, status) VALUES (:id, 'QUEUED')"
                    ),
                    {"id": str(scan_id)},
                )
                await db.commit()

            cancelled_detected = False
            completed_scans: list[UUID] = []
            scan_finished = asyncio.Event()

            async def _slow_multi_page_scan(claimed_scan_id: UUID, _worker_id: str) -> None:
                nonlocal cancelled_detected
                try:
                    # Exceeds our shortened cron subsystem timeout (0.35s) to prove
                    # Cron sweep #6 does NOT cancel the multi-page scan!
                    await asyncio.sleep(0.45)
                    completed_scans.append(claimed_scan_id)
                    scan_finished.set()
                except asyncio.CancelledError:
                    cancelled_detected = True
                    raise

            fake_bq_repo = MagicMock()
            fake_bq_repo.claim_next_scan = AsyncMock(
                side_effect=[SimpleNamespace(Id=scan_id), None]
            )

            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    },
                    clear=False,
                ),
                patch.object(cron_svc, "AsyncSessionLocal", side_effect=session_factory),
                patch.object(book_quality_worker, "AsyncSessionLocal", side_effect=session_factory),
                patch.object(
                    book_quality_worker,
                    "BookContentQualityRepository",
                    return_value=fake_bq_repo,
                ),
                patch.object(
                    book_quality_worker,
                    "_process_claimed_scan",
                    side_effect=_slow_multi_page_scan,
                ),
                patch.object(cron_svc, "DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS", 0.35),
            ):
                t0 = time.monotonic()
                swept = await cron_svc._sweep_book_quality_scans(
                    max_items=5,
                    deadline=time.monotonic() + 10.0,
                )
                elapsed_cron = time.monotonic() - t0
                self.assertEqual(swept, 1)
                self.assertLess(
                    elapsed_cron,
                    0.25,
                    "Cron sweep #6 must kick background task and return without blocking",
                )
                # Background task continues without being cancelled after cron returns!
                await asyncio.wait_for(scan_finished.wait(), timeout=2.0)
                # Let trailing telemetry/heartbeat finish
                await asyncio.sleep(0.05)

            self.assertFalse(cancelled_detected, "Multi-page scan must NOT be cancelled by cron!")
            self.assertEqual(completed_scans, [scan_id])
            self.assertIsNotNone(get_worker_telemetry("book_quality")["last_success_at"])
            async with session_factory() as db:
                hb = await read_persisted_worker_heartbeats(db)
            self.assertIn("book_quality", hb)
            self.assertIsNone(hb["book_quality"]["last_error_code"])
            self.assertEqual(hb["book_quality"]["last_items_processed"], 1)

            # Expired-lease RUNNING scan must also be detected and kicked by Cron sweep #6
            expired_id = uuid4()
            expired_at = datetime.now(timezone.utc) - timedelta(minutes=10)
            async with session_factory() as db:
                await db.execute(
                    text("DELETE FROM bookqualityscanruns")
                )
                await db.execute(
                    text(
                        "INSERT INTO bookqualityscanruns (id, status, leaseexpiresat) "
                        "VALUES (:id, 'RUNNING', :exp)"
                    ),
                    {"id": str(expired_id), "exp": expired_at},
                )
                await db.commit()

            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    },
                    clear=False,
                ),
                patch.object(cron_svc, "AsyncSessionLocal", side_effect=session_factory),
                patch.object(
                    book_quality_worker, "schedule_book_quality_scan"
                ) as kick_expired_mock,
            ):
                kicked_expired = await cron_svc._sweep_book_quality_scans(
                    max_items=5,
                    deadline=time.monotonic() + 10.0,
                )
            self.assertEqual(kicked_expired, 1)
            kick_expired_mock.assert_called_once_with(source="cron")
        finally:
            engine.dispose()

    async def test_enqueue_scan_triggers_schedule_book_quality_scan(self) -> None:
        book_id = uuid4()
        actor_id = uuid4()
        fake_book = SimpleNamespace(Id=book_id, Title="Truyện Thiếu Nhi")
        fake_repo = MagicMock()
        fake_repo.role = AsyncMock(return_value="admin")
        fake_repo.book = AsyncMock(return_value=fake_book)
        fake_repo.active_scan_for_book = AsyncMock(return_value=None)
        fake_repo.latest_scan = AsyncMock(return_value=None)
        fake_repo.db = MagicMock()
        fake_repo.db.add = MagicMock()
        fake_repo.db.commit = AsyncMock()

        async def _fill_defaults(run_obj) -> None:
            now = datetime.now(timezone.utc)
            run_obj.TotalPages = 0
            run_obj.CompletedPages = 0
            run_obj.SkippedPages = 0
            run_obj.FailedPages = 0
            run_obj.AICompletedPages = 0
            run_obj.AIUnavailablePages = 0
            run_obj.CreatedAt = now
            run_obj.UpdatedAt = now

        fake_repo.db.refresh = AsyncMock(side_effect=_fill_defaults)
        svc = BookContentQualityService(fake_repo)
        svc._cleanup_abandoned_and_retired_book_artifacts = AsyncMock()  # type: ignore[method-assign]
        svc._ensure_page_ai_workflows = AsyncMock()  # type: ignore[method-assign]

        with patch.object(
            book_quality_worker, "schedule_book_quality_scan"
        ) as schedule_mock:
            res = await svc.enqueue_scan(actor_id, book_id)

        self.assertEqual(res.status, "QUEUED")
        schedule_mock.assert_called_once()

    async def test_admin_ai_workflow_public_run_once_and_non_cancelling_cron_kick(self) -> None:
        engine, session_factory = _make_sqlite_session_factory(
            HEARTBEATS_DDL_SQLITE,
            ADMIN_AI_WORKFLOWS_DDL_SQLITE,
        )
        try:
            wf_id = uuid4()
            fake_repo = MagicMock()
            fake_repo.claim_next = AsyncMock(side_effect=[wf_id, None])

            with (
                patch.object(
                    admin_ai_workflow_worker, "AsyncSessionLocal", side_effect=session_factory
                ),
                patch.object(
                    admin_ai_workflow_worker,
                    "AdminAiWorkflowRepository",
                    return_value=fake_repo,
                ),
                patch.object(
                    admin_ai_workflow_worker, "_process", new=AsyncMock()
                ) as proc_mock,
            ):
                did_work_1 = await admin_ai_workflow_worker.run_once(source="event")
                did_work_2 = await admin_ai_workflow_worker.run_once(source="event")

            self.assertTrue(did_work_1)
            self.assertFalse(did_work_2)
            proc_mock.assert_awaited_once()
            self.assertIsNotNone(get_worker_telemetry("admin_ai_workflow")["last_success_at"])

            # Now test Cron sweep #5 kicks schedule_admin_ai_workflow instead of 5s cancelling
            async with session_factory() as db:
                await db.execute(
                    text(
                        "INSERT INTO adminaiworkflows (id, status, stage) "
                        "VALUES (:id, 'QUEUED', 'PROOFREADING')"
                    ),
                    {"id": str(uuid4())},
                )
                await db.commit()

            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    },
                    clear=False,
                ),
                patch.object(cron_svc, "AsyncSessionLocal", side_effect=session_factory),
                patch.object(
                    admin_ai_workflow_worker, "schedule_admin_ai_workflow"
                ) as kick_mock,
            ):
                kicked = await cron_svc._sweep_admin_ai_workflows(
                    max_items=5,
                    deadline=time.monotonic() + 10.0,
                )
            self.assertEqual(kicked, 1)
            kick_mock.assert_called_once_with(source="cron")
        finally:
            engine.dispose()


class ReadingPresenceConfirmTriggerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_worker_telemetry()

    async def asyncTearDown(self) -> None:
        await reading_presence_alert_worker.shutdown_scheduled_presence_tasks(
            timeout_seconds=1.0
        )
        clear_worker_telemetry()

    def test_confirm_alert_triggers_delivery_only_when_now_gte_due_at(self) -> None:
        app = FastAPI()
        app.include_router(reading_presence_route.router, prefix="/reading-presence")
        parent_id = uuid4()
        alert_id = uuid4()
        session_id = uuid4()
        episode_id = uuid4()
        now = datetime(2026, 11, 26, 12, 0, 0, tzinfo=timezone.utc)

        app.dependency_overrides[require_parent_id] = lambda: parent_id
        app.dependency_overrides[get_db] = lambda: MagicMock()
        client = TestClient(app)

        # Case 1: now < DueAt -> must NOT trigger delivery
        future_alert = SimpleNamespace(
            Id=alert_id,
            SessionId=session_id,
            EpisodeId=episode_id,
            Status="PENDING",
            DueAt=now + timedelta(seconds=45),
            ExpiresAt=now + timedelta(minutes=10),
            CancelReason=None,
        )
        with (
            patch.object(reading_presence_route, "utcnow", return_value=now),
            patch.object(
                reading_presence_route,
                "build_service",
                return_value=MagicMock(confirm=AsyncMock(return_value=future_alert)),
            ),
            patch.object(
                reading_presence_route, "schedule_reading_presence_delivery"
            ) as sched_mock,
        ):
            r1 = client.post(f"/reading-presence/alerts/{alert_id}/confirm")
        self.assertEqual(r1.status_code, 200)
        sched_mock.assert_not_called()

        # Case 2: now >= DueAt -> MUST trigger non-blocking delivery
        due_alert = SimpleNamespace(
            Id=alert_id,
            SessionId=session_id,
            EpisodeId=episode_id,
            Status="PENDING",
            DueAt=now - timedelta(seconds=1),
            ExpiresAt=now + timedelta(minutes=10),
            CancelReason=None,
        )
        with (
            patch.object(reading_presence_route, "utcnow", return_value=now),
            patch.object(
                reading_presence_route,
                "build_service",
                return_value=MagicMock(confirm=AsyncMock(return_value=due_alert)),
            ),
            patch.object(
                reading_presence_route, "schedule_reading_presence_delivery"
            ) as sched_mock,
        ):
            r2 = client.post(f"/reading-presence/alerts/{alert_id}/confirm")
        self.assertEqual(r2.status_code, 200)
        sched_mock.assert_called_once_with(now=now)

    async def test_schedule_reading_presence_delivery_is_single_flight_and_persists_heartbeat(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            gate = asyncio.Event()
            calls = 0

            async def _fake_deliver(*, now=None) -> int:
                nonlocal calls
                calls += 1
                await gate.wait()
                return 1

            with (
                patch.object(
                    reading_presence_alert_worker,
                    "AsyncSessionLocal",
                    side_effect=session_factory,
                ),
                patch.object(
                    reading_presence_alert_worker,
                    "process_due_alerts_once",
                    side_effect=_fake_deliver,
                ),
            ):
                t1 = reading_presence_alert_worker.schedule_reading_presence_delivery(
                    force=True
                )
                t2 = reading_presence_alert_worker.schedule_reading_presence_delivery(
                    force=True
                )
                self.assertIsNotNone(t1)
                self.assertIs(t1, t2, "Single-flight must reuse the active delivery task")
                gate.set()
                assert t1 is not None
                delivered = await asyncio.wait_for(t1, timeout=2.0)

            self.assertEqual(delivered, 1)
            self.assertEqual(calls, 1)
            async with session_factory() as db:
                hb = await read_persisted_worker_heartbeats(db)
            self.assertIn("reading_presence", hb)
            self.assertEqual(hb["reading_presence"]["execution_mode"], "on_demand")
            self.assertEqual(hb["reading_presence"]["last_source"], "presence_confirm")
            self.assertEqual(hb["reading_presence"]["last_items_processed"], 1)
        finally:
            engine.dispose()


class OcrOutboxAndTrainingMaintenanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_worker_telemetry()

    async def asyncTearDown(self) -> None:
        await viread_ocr_outbox_worker.shutdown_scheduled_outbox_tasks(timeout_seconds=1.0)
        clear_worker_telemetry()

    async def test_viread_ocr_outbox_run_once_records_telemetry_and_heartbeats(self) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            # 1. Idle (0 events) -> records success & persists heartbeat
            with (
                patch.object(
                    viread_ocr_outbox_worker, "AsyncSessionLocal", side_effect=session_factory
                ),
                patch.object(
                    viread_ocr_outbox_worker, "_claim_one", new=AsyncMock(return_value=None)
                ),
            ):
                ran = await viread_ocr_outbox_worker.run_once()
            self.assertFalse(ran)
            self.assertIsNotNone(get_worker_telemetry("viread_ocr_outbox")["last_success_at"])

            # 2. Failure during processing -> records error & persists error heartbeat
            fake_event = {"id": uuid4(), "attempts": 1}
            with (
                patch.object(
                    viread_ocr_outbox_worker, "AsyncSessionLocal", side_effect=session_factory
                ),
                patch.object(
                    viread_ocr_outbox_worker,
                    "_claim_one",
                    new=AsyncMock(return_value=fake_event),
                ),
                patch.object(
                    viread_ocr_outbox_worker,
                    "_process_with_lease",
                    new=AsyncMock(side_effect=RuntimeError("upload_failed")),
                ),
                patch.object(
                    viread_ocr_outbox_worker, "_finish", new=AsyncMock(return_value=True)
                ),
            ):
                ran_err = await viread_ocr_outbox_worker.run_once()
            self.assertTrue(ran_err)
            self.assertEqual(
                get_worker_telemetry("viread_ocr_outbox")["last_error"],
                "RuntimeError",
            )
            async with session_factory() as db:
                hb = (await read_persisted_worker_heartbeats(db))["viread_ocr_outbox"]
            self.assertEqual(hb["last_error_code"], "RuntimeError")

            # 3. Event-driven schedule_viread_ocr_outbox drains & persists healthy heartbeat
            with (
                patch.object(
                    viread_ocr_outbox_worker, "AsyncSessionLocal", side_effect=session_factory
                ),
                patch.object(
                    viread_ocr_outbox_worker,
                    "_claim_one",
                    new=AsyncMock(side_effect=[fake_event, None]),
                ),
                patch.object(
                    viread_ocr_outbox_worker, "_process_with_lease", new=AsyncMock()
                ),
                patch.object(
                    viread_ocr_outbox_worker, "_finish", new=AsyncMock(return_value=True)
                ),
            ):
                task = viread_ocr_outbox_worker.schedule_viread_ocr_outbox(force=True)
                self.assertIsNotNone(task)
                assert task is not None
                processed = await asyncio.wait_for(task, timeout=2.0)

            self.assertEqual(processed, 1)
            async with session_factory() as db:
                hb_ok = (await read_persisted_worker_heartbeats(db))["viread_ocr_outbox"]
            self.assertIsNone(hb_ok["last_error_code"])
            self.assertEqual(hb_ok["last_source"], "event")
            self.assertEqual(hb_ok["execution_mode"], "on_demand")
        finally:
            engine.dispose()

    async def test_viread_ocr_training_run_maintenance_once_zero_torch_and_heartbeats(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            with (
                patch.object(
                    viread_ocr_training_auto_worker,
                    "AsyncSessionLocal",
                    side_effect=session_factory,
                ),
                patch.object(
                    viread_ocr_training_auto_worker,
                    "_expire_exhausted_jobs",
                    new=AsyncMock(),
                ) as expire_mock,
                patch.object(
                    viread_ocr_training_auto_worker,
                    "_dispatch_or_poll_colab_once",
                    new=AsyncMock(return_value=False),
                ) as colab_mock,
            ):
                res = await viread_ocr_training_auto_worker.run_maintenance_once()

            self.assertEqual(res, {"ok": True, "colab_activity": False})
            expire_mock.assert_awaited_once()
            colab_mock.assert_awaited_once()
            self.assertIsNotNone(
                get_worker_telemetry("viread_ocr_training")["last_success_at"]
            )
            async with session_factory() as db:
                hb = (await read_persisted_worker_heartbeats(db))["viread_ocr_training"]
            self.assertEqual(hb["execution_mode"], "cron_scheduled")
            self.assertEqual(hb["last_items_processed"], 0)
            self.assertIsNone(hb["last_error_code"])
        finally:
            engine.dispose()

        # Verify in a clean Python subprocess that run_maintenance_once imports ZERO torch/ML modules
        script = f"""
import asyncio, json, os, sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, {str(BACKEND_ROOT)!r})
os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:y@127.0.0.1:1/z")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-key")

from app.jobs import viread_ocr_training_auto_worker as w

async def _run():
    with (
        patch.object(w, "_expire_exhausted_jobs", new=AsyncMock()),
        patch.object(w, "_dispatch_or_poll_colab_once", new=AsyncMock(return_value=False)),
        patch.object(w, "persist_worker_heartbeat_with_factory", new=AsyncMock()),
    ):
        return await w.run_maintenance_once()

res = asyncio.run(_run())
forbidden = [
    m for m in ("torch", "torchvision", "paddle", "paddleocr", "vietocr", "ai.vietocr_v2")
    if m in sys.modules
]
print(json.dumps({{"res": res, "forbidden": forbidden}}))
"""
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["forbidden"], [])
        self.assertTrue(payload["res"]["ok"])


class SmartStudioEventDrainAndServerShutdownTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_worker_telemetry()

    async def asyncTearDown(self) -> None:
        await global_tasks_service.shutdown_scheduled_smart_studio_tasks(
            timeout_seconds=1.0
        )
        clear_worker_telemetry()

    async def test_smart_studio_event_drain_triggers_when_worker_disabled(self) -> None:
        engine, session_factory = _make_sqlite_session_factory(HEARTBEATS_DDL_SQLITE)
        try:
            processed_jobs = 0
            drained = asyncio.Event()

            async def _fake_process_one(_db, *, worker_id: str = "") -> bool:
                nonlocal processed_jobs
                if processed_jobs < 2:
                    processed_jobs += 1
                    await asyncio.sleep(0.01)
                    return True
                drained.set()
                return False

            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                        "VIREAD_ENABLE_SMART_STUDIO_WORKER": "false",
                    },
                    clear=False,
                ),
                patch("app.database.session.AsyncSessionLocal", side_effect=session_factory),
                patch.object(
                    global_tasks_service,
                    "process_one_smart_studio_job",
                    side_effect=_fake_process_one,
                ),
            ):
                # Multiple notify calls coalesce cleanly via single-flight task & Semaphore(1)
                global_tasks_service.notify_smart_studio_worker()
                global_tasks_service.notify_smart_studio_worker()
                await asyncio.wait_for(drained.wait(), timeout=2.0)
                await asyncio.sleep(0.05)

            self.assertEqual(processed_jobs, 2)
            self.assertIsNotNone(get_worker_telemetry("smart_studio")["last_success_at"])
            async with session_factory() as db:
                hb = (await read_persisted_worker_heartbeats(db))["smart_studio"]
            self.assertEqual(hb["execution_mode"], "on_demand")
            self.assertEqual(hb["last_source"], "event")
            self.assertEqual(hb["last_items_processed"], 2)
            self.assertIsNone(hb["last_error_code"])

            # When continuous worker IS enabled, schedule_smart_studio_drain must NOT spawn duplicate task
            with patch.dict(
                os.environ,
                {
                    "APP_ENVIRONMENT": "production",
                    "VIREAD_ENABLE_SMART_STUDIO_WORKER": "true",
                },
                clear=False,
            ):
                self.assertIsNone(global_tasks_service.schedule_smart_studio_drain())
        finally:
            engine.dispose()

    def test_sever_registers_all_scheduled_shutdown_hooks(self) -> None:
        import inspect
        import app.sever as sever_mod

        lifespan_src = inspect.getsource(sever_mod.lifespan)
        for hook_name in (
            "shutdown_scheduled_admin_ai_workflows",
            "shutdown_scheduled_book_quality_scans",
            "shutdown_scheduled_outbox_tasks",
            "shutdown_scheduled_presence_tasks",
            "shutdown_scheduled_smart_studio_tasks",
        ):
            self.assertTrue(
                callable(getattr(sever_mod, hook_name, None)),
                f"{hook_name} must be imported on app.sever",
            )
            self.assertIn(f"{hook_name}()", lifespan_src)


if __name__ == "__main__":
    unittest.main()
