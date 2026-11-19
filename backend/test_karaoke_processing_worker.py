"""Two-connection PostgreSQL lease/ledger checks, not a simulated SQL engine."""
import asyncio
from datetime import timedelta
from types import SimpleNamespace
import unittest
from uuid import uuid4

from sqlalchemy import select

import test_karaoke_postgres_integration as pg
import test_karaoke_processing_service_postgres as api
from app.models.karaoke import utcnow
from app.models.karaoke_processing import KaraokeProcessingJob as Job
from app.repositories.karaoke_processing_repository import KaraokeProcessingRepository
from app.schemas.karaoke_processing import ProcessingCancel


@unittest.skipUnless(pg.TEST_URL, "Requires the dedicated disposable PostgreSQL container")
class ProcessingLeasePostgresTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = api.ProcessingServicePostgresTests.asyncSetUp

    async def running(self):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        token = uuid4()
        async with self.processing.write():
            row = await self.processing.get(job.id, self.song_id, lock=True)
            row.status, row.stage, row.attempt_count = "RUNNING", "VALIDATING_INPUT", 1
            row.lease_token, row.lease_expires_at = token, utcnow() + timedelta(minutes=2)
        return job, token

    async def test_two_workers_claim_exactly_once_with_skip_locked(self):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        async with self.sessions() as blocker, blocker.begin():
            # Isolate this case from jobs belonging to other test fixtures without
            # deleting/mutating any of them. SKIP LOCKED must skip their rows.
            await blocker.scalars(select(Job).where(Job.id != job.id).with_for_update())
            async def claim():
                async with self.sessions() as db:
                    repo = KaraokeProcessingRepository(db)
                    async with repo.write():
                        return await repo.claim(self.config)
            claims = await asyncio.gather(claim(), claim())
        self.assertEqual(sum(result is not None for result in claims), 1)
        winner = next(result for result in claims if result is not None)
        self.assertEqual(winner.id, job.id)
        self.assertEqual(winner.attempt_count, 1)
        async with self.processing.write():
            self.assertFalse(await self.processing.heartbeat(job.id, uuid4(), 120))
            self.assertTrue(await self.processing.heartbeat(job.id, winner.lease_token, 120))

    async def test_cancel_revokes_all_late_worker_writes(self):
        job, token = await self.running()
        async with self.processing.write():
            operation = await self.processing.prepare_operation(
                job.id, token, stage="PREPARING_AUDIO", step_key="SEPARATE_STEMS",
                step_input_fingerprint="a" * 64, provider="fixture", model_version="fixture-v1")
        await self.proc.cancel(self.admin, self.song_id, job.id,
                               ProcessingCancel(draft_version_id=self.detail.draft.id))
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                self.assertFalse(await repo.heartbeat(job.id, token, 120))
                self.assertFalse(await repo.progress(job.id, token, stage="ALIGNING_LYRICS"))
                self.assertFalse(await repo.operation_transition(job.id, token, operation.id, state="SUBMITTED"))
                self.assertFalse(await repo.finish(job.id, token, status="FAILED", error="PROVIDER_TIMEOUT"))
                self.assertIsNone(await repo.prepare_operation(
                    job.id, token, stage="ALIGNING_LYRICS", step_key="ALIGN",
                    step_input_fingerprint="b" * 64, provider="fixture", model_version="fixture-v1"))
        current = await self.proc.get(self.admin, self.song_id, job.id)
        self.assertEqual(current.status, "CANCELLED")
        self.assertEqual(current.retry_policy, "EXPLICIT_COST_ACK")

    async def test_expired_submitted_operation_requires_cost_ack_and_keeps_artifacts(self):
        job, token = await self.running()
        path = f"songs/{self.song_id}/versions/{self.detail.draft.id}/audio/{uuid4()}.mp3"
        async with self.processing.write():
            operation = await self.processing.prepare_operation(
                job.id, token, stage="PREPARING_AUDIO", step_key="SEPARATE_STEMS",
                step_input_fingerprint="a" * 64, provider="paid-fixture", model_version="fixture-v1")
        async with self.processing.write():
            self.assertTrue(await self.processing.operation_transition(
                job.id, token, operation.id, state="SUBMITTED", artifact_paths=[path]))
        async with self.processing.write():
            row = await self.processing.get(job.id, self.song_id, lock=True)
            row.lease_expires_at = utcnow() - timedelta(seconds=1)
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                self.assertGreaterEqual(await repo.recover_expired(self.config), 1)
        async with self.processing.read():
            row = await self.processing.get(job.id, self.song_id)
            self.assertEqual(row.status, "FAILED")
            self.assertEqual(row.safe_error_code, "PROVIDER_OUTCOME_UNKNOWN")
            self.assertEqual(row.retry_policy, "EXPLICIT_COST_ACK")
            self.assertIsNone(row.quota_released_at)
            self.assertTrue(await self.repository.referenced(path))
        async with self.processing.write():
            self.assertFalse(await self.processing.heartbeat(job.id, token, 120))

    async def test_expiry_before_any_call_can_requeue_without_erasing_reservation(self):
        job, token = await self.running()
        async with self.processing.write():
            row = await self.processing.get(job.id, self.song_id, lock=True)
            row.lease_expires_at = utcnow() - timedelta(seconds=1)
        async with self.processing.write():
            await self.processing.recover_expired(self.config)
        current = await self.proc.get(self.admin, self.song_id, job.id)
        self.assertEqual(current.status, "QUEUED")
        self.assertEqual(current.retry_policy, "SAFE_RETRY")
        async with self.processing.write():
            row = await self.processing.get(job.id, self.song_id)
            self.assertIsNone(row.lease_token)
            self.assertIsNone(row.quota_released_at)
            self.assertFalse(await self.processing.heartbeat(job.id, token, 120))

    async def test_revoked_creator_cannot_heartbeat_stage_or_finish(self):
        job, token = await self.running()
        async with self.processing.write():
            actor = await self.db.get(pg.Profile, self.admin)
            actor.Active = 0
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                self.assertFalse(await repo.heartbeat(job.id, token, 120))
                self.assertFalse(await repo.progress(job.id, token, stage="PREPARING_AUDIO"))
                self.assertFalse(await repo.finish(job.id, token, status="FAILED", error="PROVIDER_TIMEOUT"))
                self.assertIsNone(await repo.prepare_operation(
                    job.id, token, stage="PREPARING_AUDIO", step_key="SEPARATE_STEMS",
                    step_input_fingerprint="a" * 64, provider="fixture", model_version="fixture"))
        async with self.processing.write():
            row = await self.processing.get(job.id, self.song_id, lock=True)
            row.lease_expires_at = utcnow() - timedelta(seconds=1)
        async with self.processing.write():
            await self.processing.recover_expired(self.config)
        async with self.processing.read():
            row = await self.processing.get(job.id, self.song_id)
            self.assertEqual(row.safe_error_code, "ACTOR_UNAVAILABLE")
            self.assertEqual(row.status, "FAILED")


    async def test_worker_leaves_foreign_pipeline_job_queued_for_compatible_worker(self):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        original = self.config.pipeline_version
        foreign = SimpleNamespace(**{**vars(self.config), "pipeline_version": f"other-{uuid4()}"})
        async with self.sessions() as blocker, blocker.begin():
            await blocker.scalars(select(Job).where(Job.id != job.id).with_for_update())
            async with self.sessions() as db:
                repo = KaraokeProcessingRepository(db)
                async with repo.write():
                    self.assertIsNone(await repo.claim(foreign))
            async with self.processing.read():
                untouched = await self.processing.get(job.id, self.song_id)
                self.assertEqual(untouched.status, "QUEUED")
                self.assertEqual(untouched.attempt_count, 0)
                self.assertIsNone(untouched.lease_token)
                self.assertEqual(untouched.pipeline_version, original)
            async with self.sessions() as db:
                repo = KaraokeProcessingRepository(db)
                async with repo.write():
                    claimed = await repo.claim(self.config)
            self.assertEqual(claimed.id, job.id)
            self.assertEqual(claimed.attempt_count, 1)

    async def test_worker_does_not_recover_another_pipeline_expired_lease(self):
        job, token = await self.running()
        async with self.processing.write():
            row = await self.processing.get(job.id, self.song_id, lock=True)
            row.lease_expires_at = utcnow() - timedelta(seconds=1)
        foreign = SimpleNamespace(**{**vars(self.config), "pipeline_version": f"other-{uuid4()}"})
        async with self.processing.write():
            self.assertEqual(await self.processing.recover_expired(foreign), 0)
        async with self.processing.read():
            untouched = await self.processing.get(job.id, self.song_id)
            self.assertEqual(untouched.status, "RUNNING")
            self.assertEqual(untouched.lease_token, token)
            self.assertEqual(untouched.attempt_count, 1)
        async with self.processing.write():
            await self.processing.recover_expired(self.config)
        current = await self.proc.get(self.admin, self.song_id, job.id)
        self.assertEqual(current.status, "QUEUED")
        self.assertEqual(current.retry_policy, "SAFE_RETRY")


if __name__ == "__main__":
    unittest.main()
