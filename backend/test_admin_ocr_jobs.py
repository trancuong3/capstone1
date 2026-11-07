"""In-memory OCR job tests; these never connect to or write to a database."""

import asyncio
import unittest
from uuid import UUID

from app.services.admin_ocr_jobs import (
    AdminOcrCorrectionJobManager,
    OcrCorrectionQueueFull,
)


ACTOR = UUID("11111111-1111-4111-8111-111111111111")
OTHER_ACTOR = UUID("22222222-2222-4222-8222-222222222222")
PAGE = UUID("33333333-3333-4333-8333-333333333333")
REQUEST = UUID("44444444-4444-4444-8444-444444444444")


class AdminOcrJobTests(unittest.IsolatedAsyncioTestCase):
    async def test_job_reports_progress_and_only_returns_result_to_owner(self):
        manager = AdminOcrCorrectionJobManager()

        async def operation(progress):
            progress(1, 2)
            await asyncio.sleep(0)
            progress(2, 2)
            return "Ngày xưa."

        job = manager.submit(
            page_id=PAGE,
            actor_id=ACTOR,
            total_chunks=2,
            operation=operation,
        )
        self.assertIsNone(manager.get(job.job_id, OTHER_ACTOR, PAGE))
        await job.task

        result = manager.get(job.job_id, ACTOR, PAGE)
        self.assertIsNotNone(result)
        self.assertEqual(result.status, "SUCCEEDED")
        self.assertEqual(result.result, "Ngày xưa.")
        self.assertEqual(result.completed_chunks, 2)

    async def test_cancelling_job_clears_result_and_prevents_stale_success(self):
        manager = AdminOcrCorrectionJobManager()
        started = asyncio.Event()

        async def operation(_progress):
            started.set()
            await asyncio.Future()

        job = manager.submit(
            page_id=PAGE,
            actor_id=ACTOR,
            total_chunks=1,
            operation=operation,
        )
        await started.wait()
        cancelled = manager.cancel(job.job_id, ACTOR, PAGE)
        await job.task

        self.assertIsNotNone(cancelled)
        self.assertEqual(cancelled.status, "CANCELLED")
        self.assertIsNone(cancelled.result)

    async def test_queue_is_bounded(self):
        manager = AdminOcrCorrectionJobManager()
        release = asyncio.Event()

        async def wait_for_release(_progress):
            await release.wait()
            return "ok"

        jobs = [
            manager.submit(
                page_id=PAGE,
                actor_id=ACTOR,
                total_chunks=1,
                operation=wait_for_release,
            )
            for _ in range(4)
        ]
        with self.assertRaises(OcrCorrectionQueueFull):
            manager.submit(
                page_id=PAGE,
                actor_id=ACTOR,
                total_chunks=1,
                operation=wait_for_release,
            )

        for job in jobs:
            manager.cancel(job.job_id, ACTOR, PAGE)
        await asyncio.gather(*(job.task for job in jobs), return_exceptions=True)

    async def test_same_idempotency_key_does_not_start_duplicate_model_work(self):
        manager = AdminOcrCorrectionJobManager()
        started = asyncio.Event()

        async def operation(_progress):
            started.set()
            await asyncio.Future()

        first = manager.submit(
            page_id=PAGE,
            actor_id=ACTOR,
            total_chunks=1,
            operation=operation,
            idempotency_key=REQUEST,
        )
        retry = manager.submit(
            page_id=PAGE,
            actor_id=ACTOR,
            total_chunks=1,
            operation=operation,
            idempotency_key=REQUEST,
        )
        self.assertIs(first, retry)

        await started.wait()
        manager.cancel(first.job_id, ACTOR, PAGE)
        await asyncio.gather(first.task, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
