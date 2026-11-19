"""Deterministic owned-task shutdown checks; no SQL, model or provider calls."""
import asyncio
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from app.jobs.karaoke_processing_worker import KaraokeProcessingWorker, _settle_heartbeat
from app.providers.karaoke_local_aligner_client import KaraokeLeaseLost


class KaraokeWorkerShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def assert_process_cleanup(self, cancel_during_close=False):
        started, release = asyncio.Event(), asyncio.Event()
        state = {"closed": False, "cancelled": False}
        with tempfile.TemporaryDirectory(prefix="karaoke-shutdown-fixture-") as root:
            def no_session():
                raise AssertionError("This unit test must not touch a database")
            worker = KaraokeProcessingWorker(
                no_session, SimpleNamespace(temp_dir=root, pipeline_version="fixture"),
                storage_factory=object, client_factory=lambda config: object(),
            )
            async def heartbeat(job, cancel, finished):
                state["finished"] = finished
                started.set()
                try:
                    await release.wait()
                    self.assertTrue(finished.is_set())
                    state["closed"] = True
                except asyncio.CancelledError:
                    state["cancelled"] = True
                    raise
            async def fenced(job, context):
                await started.wait()
                raise KaraokeLeaseLost()
            with patch.object(worker, "_heartbeat", side_effect=heartbeat), patch(
                "app.jobs.karaoke_processing_worker.KaraokeProcessingPipeline",
                return_value=SimpleNamespace(process=fenced),
            ):
                task = asyncio.create_task(worker.process(SimpleNamespace(
                    id=uuid4(), pipeline_version="fixture")))
                try:
                    await asyncio.wait_for(started.wait(), timeout=1)
                    await asyncio.wait_for(state["finished"].wait(), timeout=1)
                    await asyncio.sleep(0)
                    self.assertFalse(task.done(), "Worker must drain its live connection close")
                    self.assertFalse(state["cancelled"])
                    if cancel_during_close:
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await asyncio.wait_for(task, timeout=1)
                        self.assertTrue(state["cancelled"])
                    else:
                        release.set()
                        await asyncio.wait_for(task, timeout=1)
                        self.assertTrue(state["closed"])
                        self.assertFalse(state["cancelled"])
                    self.assertFalse(list(Path(root).iterdir()))
                finally:
                    release.set()
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_process_signals_finished_then_allows_connection_close(self):
        await self.assert_process_cleanup()

    async def test_cancel_during_shutdown_still_reaps_heartbeat_and_cleans_job_temp(self):
        await self.assert_process_cleanup(cancel_during_close=True)

    async def test_timeout_cancels_and_reaps_only_the_owned_heartbeat(self):
        closed = asyncio.Event()
        async def stuck():
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        task = asyncio.create_task(stuck())
        await asyncio.sleep(0)
        with self.assertLogs("app.jobs.karaoke_processing_worker", level="WARNING") as logs:
            await _settle_heartbeat(task, timeout=.01)
        self.assertTrue(task.cancelled())
        self.assertTrue(closed.is_set())
        self.assertTrue(any("karaoke_heartbeat_shutdown_timeout" in line for line in logs.output))

    async def test_external_cancellation_is_preserved_and_owned_task_is_reaped(self):
        started, closed = asyncio.Event(), asyncio.Event()
        async def heartbeat():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        task = asyncio.create_task(heartbeat())
        await asyncio.wait_for(started.wait(), timeout=1)
        settling = asyncio.create_task(_settle_heartbeat(task))
        await asyncio.sleep(0)
        settling.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await settling
        self.assertTrue(task.cancelled())
        self.assertTrue(closed.is_set())

    async def test_already_failed_or_cancelled_heartbeat_does_not_mask_job_outcome(self):
        async def failed():
            raise RuntimeError("isolated fixture failure")
        failure = asyncio.create_task(failed())
        await asyncio.sleep(0)
        await _settle_heartbeat(failure)
        cancelled = asyncio.create_task(asyncio.sleep(10))
        cancelled.cancel()
        await _settle_heartbeat(cancelled)
        self.assertTrue(failure.done())
        self.assertTrue(cancelled.cancelled())


if __name__ == "__main__":
    unittest.main()
