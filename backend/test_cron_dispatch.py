"""Unit tests for cron background post-OCR drain, DEAD_LETTER page cleanup, workflow retry backoff, and /health singleflight."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import Request
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app import sever as sever_mod
from app.jobs import admin_ai_workflow_worker, parent_book_submission_worker
from app.services import cron_dispatch_service as cron_svc
from app.services.ai_capability_router import AiErrorKind, get_shared_ai_circuit_breaker, reset_shared_ai_circuit_breaker
from app.services.worker_telemetry import clear_worker_telemetry


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

PARENT_SUBMISSIONS_DDL_SQLITE = """
CREATE TABLE parent_book_page_submissions (
    id TEXT PRIMARY KEY,
    workflow_status TEXT NOT NULL,
    ocr_status TEXT NOT NULL,
    proofread_status TEXT NOT NULL,
    tool_check_status TEXT NOT NULL,
    retry_after TIMESTAMP,
    lease_expires_at TIMESTAMP
)
"""

BOOKPAGES_DDL_SQLITE = """
CREATE TABLE bookpages (
    id TEXT PRIMARY KEY,
    bookid TEXT NOT NULL,
    pagenumber INTEGER NOT NULL,
    imagepath TEXT NOT NULL,
    width INTEGER NOT NULL DEFAULT 100,
    height INTEGER NOT NULL DEFAULT 100,
    featurepath TEXT,
    contenttype TEXT NOT NULL DEFAULT 'CONTENT',
    processingmeta TEXT,
    currentverifiedrevisionid TEXT,
    lifecyclestatus TEXT NOT NULL,
    createdat TIMESTAMP NOT NULL
)
"""

OCR_INFERENCE_JOBS_DDL_SQLITE = """
CREATE TABLE ocr_inference_jobs (
    id TEXT PRIMARY KEY,
    page_id TEXT,
    status TEXT NOT NULL
)
"""


class _AsyncSqliteSession:
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

    async def scalars(self, statement, params=None):
        if params is not None:
            return self._sync.scalars(statement, params)
        return self._sync.scalars(statement)

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


class CronDispatchResilienceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_worker_telemetry()
        reset_shared_ai_circuit_breaker()
        sever_mod.clear_health_probe_cache()

    async def asyncTearDown(self) -> None:
        await cron_svc.shutdown_cron_post_ocr_drain_tasks(timeout_seconds=1.0)
        await admin_ai_workflow_worker.shutdown_scheduled_admin_ai_workflows(timeout_seconds=1.0)
        clear_worker_telemetry()
        reset_shared_ai_circuit_breaker()
        sever_mod.clear_health_probe_cache()

    async def test_parent_post_ocr_background_drain_does_not_cancel_long_runner_at_6s(self) -> None:
        engine, session_factory = _make_sqlite_session_factory(
            HEARTBEATS_DDL_SQLITE,
            PARENT_SUBMISSIONS_DDL_SQLITE,
        )
        try:
            async with session_factory() as db:
                await db.execute(
                    text(
                        "INSERT INTO parent_book_page_submissions "
                        "(id, workflow_status, ocr_status, proofread_status, tool_check_status, retry_after, lease_expires_at) "
                        "VALUES (:id, 'CHECKING', 'COMPLETED', 'PENDING', 'PENDING', NULL, NULL)"
                    ),
                    {"id": str(uuid4())},
                )
                await db.commit()

            cancelled_detected = False
            completed_runs = 0
            drain_done = asyncio.Event()

            async def _slow_post_ocr_run_once(*, worker_id: str | None = None) -> bool:
                nonlocal cancelled_detected, completed_runs
                if completed_runs >= 1:
                    return False
                try:
                    await asyncio.sleep(0.45)
                    completed_runs += 1
                    drain_done.set()
                    return True
                except asyncio.CancelledError:
                    cancelled_detected = True
                    raise

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
                patch.object(cron_svc, "DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS", 0.35),
                patch.object(
                    cron_svc.parent_book_submission_worker,
                    "run_once",
                    side_effect=_slow_post_ocr_run_once,
                ),
            ):
                t0 = time.monotonic()
                swept, executed = await cron_svc._sweep_parent_post_ocr(
                    max_items=5,
                    deadline=time.monotonic() + 10.0,
                    now=datetime.now(timezone.utc),
                    parent_post_ocr_runner=None,
                )
                elapsed = time.monotonic() - t0
                self.assertTrue(executed)
                self.assertEqual(swept, 1)
                self.assertLess(elapsed, 0.22, "Cron step 4 must return immediately after kicking background drain")

                await asyncio.wait_for(drain_done.wait(), timeout=2.0)
                await asyncio.sleep(0.05)

            self.assertFalse(cancelled_detected, "Long post-OCR task must NOT be cancelled at 6s cron cap")
            self.assertEqual(completed_runs, 1)
        finally:
            engine.dispose()

    async def test_custom_parent_post_ocr_runner_preserves_inline_compat(self) -> None:
        calls = 0

        async def _custom_runner(*, worker_id: str | None = None) -> bool:
            nonlocal calls
            calls += 1
            return calls <= 2

        with patch.dict(
            os.environ,
            {
                "APP_ENVIRONMENT": "production",
                "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
            },
            clear=False,
        ):
            swept, executed = await cron_svc._sweep_parent_post_ocr(
                max_items=5,
                deadline=time.monotonic() + 10.0,
                now=datetime.now(timezone.utc),
                parent_post_ocr_runner=_custom_runner,
            )
        self.assertTrue(executed)
        self.assertEqual(swept, 2)
        self.assertEqual(calls, 3)

    async def test_abandoned_dead_letter_book_page_cleanup_retires_stale_failed_placeholders_only(
        self,
    ) -> None:
        engine, session_factory = _make_sqlite_session_factory(
            BOOKPAGES_DDL_SQLITE,
            OCR_INFERENCE_JOBS_DDL_SQLITE,
        )
        try:
            now = datetime(2026, 11, 28, 12, 0, tzinfo=timezone.utc)
            stale_ts = (now - timedelta(hours=36)).replace(tzinfo=None)
            fresh_ts = (now - timedelta(hours=2)).replace(tzinfo=None)

            p_abandoned = uuid4()
            p_fresh = uuid4()
            p_has_active_job = uuid4()
            p_not_failed = uuid4()
            p_active_page = uuid4()
            book_id = uuid4().hex

            rows = [
                (p_abandoned.hex, book_id, 1, "b/p1.png", json.dumps({"ocr_failed": True}), None, "PROCESSING", stale_ts),
                (p_fresh.hex, book_id, 2, "b/p2.png", json.dumps({"ocr_failed": True}), None, "PROCESSING", fresh_ts),
                (p_has_active_job.hex, book_id, 3, "b/p3.png", json.dumps({"ocr_failed": True}), None, "PROCESSING", stale_ts),
                (p_not_failed.hex, book_id, 4, "b/p4.png", json.dumps({"ocr_failed": False}), None, "PROCESSING", stale_ts),
                (p_active_page.hex, book_id, 5, "b/p5.png", json.dumps({"ocr_failed": True}), None, "ACTIVE", stale_ts),
            ]
            async with session_factory() as db:
                for row in rows:
                    await db.execute(
                        text(
                            "INSERT INTO bookpages "
                            "(id, bookid, pagenumber, imagepath, processingmeta, currentverifiedrevisionid, lifecyclestatus, createdat) "
                            "VALUES (:id, :bookid, :pagenumber, :imagepath, :meta, :rev, :status, :createdat)"
                        ),
                        {
                            "id": row[0],
                            "bookid": row[1],
                            "pagenumber": row[2],
                            "imagepath": row[3],
                            "meta": row[4],
                            "rev": row[5],
                            "status": row[6],
                            "createdat": row[7],
                        },
                    )
                await db.execute(
                    text("INSERT INTO ocr_inference_jobs (id, page_id, status) VALUES (:id, :pid, 'QUEUED')"),
                    {"id": uuid4().hex, "pid": p_has_active_job.hex},
                )
                await db.execute(
                    text("INSERT INTO ocr_inference_jobs (id, page_id, status) VALUES (:id, :pid, 'DEAD_LETTER')"),
                    {"id": uuid4().hex, "pid": p_abandoned.hex},
                )
                await db.commit()

            with patch.object(cron_svc, "AsyncSessionLocal", side_effect=session_factory):
                retired = await cron_svc._sweep_abandoned_dead_letter_ocr_pages(
                    now=now.replace(tzinfo=None),
                    deadline=time.monotonic() + 10.0,
                )

            self.assertEqual(retired, 1)
            async with session_factory() as db:
                statuses = dict(
                    (
                        await db.execute(text("SELECT id, lifecyclestatus FROM bookpages"))
                    ).all()
                )
            self.assertEqual(statuses[p_abandoned.hex], "RETIRED")
            self.assertEqual(statuses[p_fresh.hex], "PROCESSING")
            self.assertEqual(statuses[p_has_active_job.hex], "PROCESSING")
            self.assertEqual(statuses[p_not_failed.hex], "PROCESSING")
            self.assertEqual(statuses[p_active_page.hex], "ACTIVE")
        finally:
            engine.dispose()

        # Gracefully degrades when schema/tables are absent
        empty_engine, empty_factory = _make_sqlite_session_factory()
        try:
            with patch.object(cron_svc, "AsyncSessionLocal", side_effect=empty_factory):
                retired_empty = await cron_svc._sweep_abandoned_dead_letter_ocr_pages(
                    now=datetime.now(timezone.utc),
                    deadline=time.monotonic() + 10.0,
                )
            self.assertEqual(retired_empty, 0)
        finally:
            empty_engine.dispose()

    async def test_admin_ai_workflow_retry_backoff_delayed_wakeup_and_64_step_drain(self) -> None:
        self.assertEqual(admin_ai_workflow_worker.MAX_ATTEMPTS, 5)
        self.assertEqual(admin_ai_workflow_worker.MAX_QUOTA_CIRCUIT_ATTEMPTS, 6)

        cb = get_shared_ai_circuit_breaker()
        cb.record_failure(
            "quota_group:gemini_free_shared",
            kind=AiErrorKind.RATE_LIMIT,
            retry_after_seconds=50.0,
        )

        wf_id = uuid4()
        now = datetime.now(timezone.utc)
        row = SimpleNamespace(
            Id=wf_id,
            WorkerId="w1",
            LeaseExpiresAt=now + timedelta(minutes=10),
            Attempts=1,
            ProviderEvents=[],
            ReviewEvents=[],
            ErrorCode=None,
            Status="PROOFREADING",
            Stage="PROOFREADING",
            SafetyStatus="PENDING",
            RetryAfter=None,
            UpdatedAt=now,
        )

        class _FakeSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

            async def commit(self):
                return None

            async def rollback(self):
                return None

        class _FakeRepo:
            def __init__(self, _s):
                pass

            async def get(self, _wid, lock=False):
                return row

        scheduled_delays: list[float] = []
        with (
            patch.object(admin_ai_workflow_worker, "AsyncSessionLocal", _FakeSession),
            patch.object(admin_ai_workflow_worker, "AdminAiWorkflowRepository", _FakeRepo),
            patch.object(
                admin_ai_workflow_worker,
                "_schedule_delayed_admin_ai_wakeup",
                side_effect=lambda delay, **_kw: scheduled_delays.append(delay),
            ),
        ):
            await admin_ai_workflow_worker._fail(wf_id, "w1", "PROOFREADING", "ALL_PROVIDERS_SKIPPED")

        self.assertEqual(row.Status, "QUEUED")
        self.assertIsNotNone(row.RetryAfter)
        self.assertEqual(len(scheduled_delays), 1)
        self.assertGreaterEqual(scheduled_delays[0], 54.0, "RetryAfter must exceed active CB cooldown + 5s")

        # Verify 6th attempt allowance for ALL_PROVIDERS_SKIPPED vs 5th for generic error
        self.assertEqual(admin_ai_workflow_worker._effective_max_attempts("ALL_PROVIDERS_SKIPPED"), 6)
        self.assertEqual(admin_ai_workflow_worker._effective_max_attempts("PROVIDER_TIMEOUT"), 5)

        # Verify delayed wakeup coalesces to a single timer handle per loop
        h1 = admin_ai_workflow_worker._schedule_delayed_admin_ai_wakeup(60.0, force=True)
        h2 = admin_ai_workflow_worker._schedule_delayed_admin_ai_wakeup(120.0, force=True)
        self.assertIs(h1, h2)
        h3 = admin_ai_workflow_worker._schedule_delayed_admin_ai_wakeup(10.0, force=True)
        self.assertIsNot(h3, h1)
        self.assertTrue(h1.cancelled())
        admin_ai_workflow_worker._cancel_delayed_admin_ai_wakeup()

        # Verify _drain_scheduled_admin_ai_workflows re-schedules when hitting max_steps cap
        reschedule_mock = MagicMock()
        with (
            patch.object(admin_ai_workflow_worker, "run_once", new=AsyncMock(return_value=True)),
            patch.object(
                admin_ai_workflow_worker,
                "persist_worker_heartbeat_with_factory",
                new=AsyncMock(),
            ),
            patch.object(
                admin_ai_workflow_worker,
                "schedule_admin_ai_workflow",
                reschedule_mock,
            ),
        ):
            await admin_ai_workflow_worker._drain_scheduled_admin_ai_workflows(max_steps=3, source="event")
        reschedule_mock.assert_called_once_with(source="event")

    async def test_parent_book_submission_worker_skips_rows_with_live_post_ocr_task(self) -> None:
        sub_id = uuid4()
        fake_session = AsyncMock()
        fake_cm = MagicMock()
        fake_cm.__aenter__ = AsyncMock(return_value=fake_session)
        fake_cm.__aexit__ = AsyncMock(return_value=False)

        fake_repo = MagicMock()
        fake_repo.claim_next_checking_submission = AsyncMock(return_value=SimpleNamespace(Id=sub_id))

        release_mock = AsyncMock()
        run_post_ocr_mock = AsyncMock()
        with (
            patch.object(parent_book_submission_worker, "is_remote_ocr_mode", return_value=True),
            patch.object(parent_book_submission_worker, "AsyncSessionLocal", return_value=fake_cm),
            patch.object(parent_book_submission_worker, "ParentPrivateBookRepository", return_value=fake_repo),
            patch.object(parent_book_submission_worker, "_release_submission_lease", release_mock),
            patch.object(parent_book_submission_worker, "run_parent_submission_post_ocr", run_post_ocr_mock),
            patch("app.services.ocr_inference_job_service._has_live_post_ocr_task", return_value=True),
        ):
            did_work = await parent_book_submission_worker.run_once(worker_id="cron-sweeper")

        self.assertFalse(did_work)
        release_mock.assert_awaited_once_with(sub_id, "cron-sweeper")
        run_post_ocr_mock.assert_not_awaited()

    async def test_health_singleflight_and_5s_degraded_negative_cache(self) -> None:
        db_calls = 0
        ocr_calls = 0

        async def _slow_ok_db(*, timeout: float = 6.0):
            nonlocal db_calls
            db_calls += 1
            await asyncio.sleep(0.08)
            return {
                "ok": True,
                "dns_resolved": True,
                "ssl_enabled": True,
                "pool_class": "NullPool",
                "pooler_mode": "transaction",
                "latency_ms": 15,
            }

        async def _degraded_ocr():
            nonlocal ocr_calls
            ocr_calls += 1
            await asyncio.sleep(0.08)
            return {
                "ready": False,
                "engines": {},
                "workers": [],
                "queue": {},
                "heartbeat_ttl_seconds": 75,
                "probe_degraded": True,
            }

        req = MagicMock(spec=Request)
        req.app = SimpleNamespace(state=SimpleNamespace(background_workers={}))

        with (
            patch.object(sever_mod, "is_remote_ocr_mode", return_value=True),
            patch.object(sever_mod, "get_ocr_mode", return_value="remote_worker"),
            patch.object(sever_mod, "probe_database_connection", side_effect=_slow_ok_db),
            patch.object(sever_mod, "collect_remote_ocr_health", side_effect=_degraded_ocr),
        ):
            # Burst of 6 concurrent /health calls must collapse into strictly 1 DB+OCR probe!
            results = await asyncio.gather(*(sever_mod.get_health(req) for _ in range(6)))
            self.assertEqual(db_calls, 1)
            self.assertEqual(ocr_calls, 1)
            for payload in results:
                self.assertEqual(payload["status"], "ok")
                self.assertTrue(payload["ocr"].get("probe_degraded"))

            # Immediate follow-up within 5s negative cache TTL must still hit cache (0 new probes)
            follow_up = await sever_mod.get_health(req)
            self.assertEqual(db_calls, 1)
            self.assertEqual(ocr_calls, 1)
            self.assertTrue(follow_up["ocr"].get("probe_degraded"))


if __name__ == "__main__":
    unittest.main()
