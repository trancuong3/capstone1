"""Unit tests for viread_ocr_outbox_worker cancellation, lease release, fencing, and retry safety."""

from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

from app.jobs import viread_ocr_outbox_worker as outbox_worker


class VireadOcrOutboxWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_processes_event_once_and_stops_cleanly(self):
        stop = asyncio.Event()
        event_id = uuid4()
        event = {
            "id": event_id,
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "actor_id": uuid4(),
            "attempts": 1,
        }
        claim_calls = 0

        async def fake_claim():
            nonlocal claim_calls
            claim_calls += 1
            if claim_calls == 1:
                return event
            stop.set()
            return None

        with (
            patch.object(outbox_worker, "_claim_one", side_effect=fake_claim),
            patch.object(
                outbox_worker, "_process", new_callable=AsyncMock
            ) as mock_process,
            patch.object(
                outbox_worker, "_finish", new_callable=AsyncMock, return_value=True
            ) as mock_finish,
        ):
            await asyncio.wait_for(
                outbox_worker.run_worker(stop, poll_seconds=5), timeout=2.0
            )

        mock_process.assert_awaited_once_with(event)
        mock_finish.assert_awaited_once_with(
            event_id, status="DONE", expected_attempts=1
        )

    async def test_cancelled_in_flight_process_releases_claim_and_reraises_cancelled_error(self):
        """Python 3.12 standard: release PROCESSING claim without losing event, then re-raise CancelledError."""
        stop = asyncio.Event()
        processing_started = asyncio.Event()
        event_id = uuid4()
        event = {
            "id": event_id,
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "actor_id": uuid4(),
            "attempts": 1,
        }

        async def slow_process(_event):
            processing_started.set()
            await asyncio.Future()

        with (
            patch.object(
                outbox_worker, "_claim_one", new=AsyncMock(return_value=event)
            ),
            patch.object(outbox_worker, "_process", side_effect=slow_process),
            patch.object(
                outbox_worker,
                "_release_claim_on_cancel",
                new_callable=AsyncMock,
            ) as mock_release,
            patch.object(
                outbox_worker, "_finish", new_callable=AsyncMock
            ) as mock_finish,
        ):
            task = asyncio.create_task(
                outbox_worker.run_worker(stop, poll_seconds=5)
            )
            await asyncio.wait_for(processing_started.wait(), timeout=2.0)

            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(task.cancelled())

        mock_release.assert_awaited_once_with(event_id, expected_attempts=1)
        mock_finish.assert_not_awaited()

    async def test_cancellation_during_done_finish_is_shielded_against_duplicate_reprocessing(self):
        """Once _process succeeds, shielded _finish(DONE) completes before CancelledError propagates."""
        stop = asyncio.Event()
        finish_entered = asyncio.Event()
        allow_finish_return = asyncio.Event()
        finish_completed = False
        event_id = uuid4()
        event = {
            "id": event_id,
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "actor_id": uuid4(),
            "attempts": 2,
        }

        async def slow_finish(*_args, **_kwargs):
            nonlocal finish_completed
            finish_entered.set()
            await allow_finish_return.wait()
            finish_completed = True
            return True

        with (
            patch.object(
                outbox_worker, "_claim_one", new=AsyncMock(return_value=event)
            ),
            patch.object(outbox_worker, "_process", new=AsyncMock()),
            patch.object(outbox_worker, "_finish", side_effect=slow_finish),
            patch.object(
                outbox_worker,
                "_release_claim_on_cancel",
                new_callable=AsyncMock,
            ) as mock_release,
        ):
            task = asyncio.create_task(
                outbox_worker.run_worker(stop, poll_seconds=5)
            )
            await asyncio.wait_for(finish_entered.wait(), timeout=2.0)

            task.cancel()
            allow_finish_return.set()

            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertTrue(finish_completed)
        mock_release.assert_not_awaited()

    async def test_claim_error_wakes_immediately_when_stop_is_signaled(self):
        stop = asyncio.Event()
        claim_failed = asyncio.Event()

        async def failing_claim():
            claim_failed.set()
            raise RuntimeError("transient db error")

        with patch.object(outbox_worker, "_claim_one", side_effect=failing_claim):
            task = asyncio.create_task(
                outbox_worker.run_worker(stop, poll_seconds=30)
            )
            await asyncio.wait_for(claim_failed.wait(), timeout=2.0)
            await asyncio.sleep(0.02)
            stop.set()
            await asyncio.wait_for(task, timeout=0.5)

    async def test_finish_fences_update_by_processing_status_and_expected_attempts(self):
        fake_db = MagicMock()
        fake_result = MagicMock()
        fake_result.rowcount = 0
        fake_db.execute = AsyncMock(return_value=fake_result)
        fake_db.commit = AsyncMock()

        class FakeSessionCtx:
            async def __aenter__(self):
                return fake_db

            async def __aexit__(self, *_args):
                return False

        event_id = uuid4()
        with patch.object(
            outbox_worker, "AsyncSessionLocal", return_value=FakeSessionCtx()
        ):
            updated = await outbox_worker._finish(
                event_id, status="DONE", expected_attempts=3
            )

        self.assertFalse(updated)
        sql_stmt, params = fake_db.execute.await_args.args
        self.assertIn("status = 'PROCESSING'", str(sql_stmt))
        self.assertIn("attempts = :expected_attempts", str(sql_stmt))
        self.assertEqual(params["expected_attempts"], 3)


if __name__ == "__main__":
    unittest.main()
