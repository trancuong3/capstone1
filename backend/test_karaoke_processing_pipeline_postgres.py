"""Worker/pipeline/ledger on real PostgreSQL; model and Storage are test doubles."""
import asyncio
from datetime import timedelta
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

import test_karaoke_postgres_integration as pg
import test_karaoke_processing_service_postgres as api
from test_karaoke import mp3_fixture
from test_karaoke_alignment import evidence
from app.jobs.karaoke_processing_worker import KaraokeProcessingWorker
from app.models.karaoke import utcnow
from app.providers.karaoke_alignment_provider import AlignmentEvidence
from app.providers.karaoke_local_aligner_client import (
    ALIGNMENT_MODEL, ALIGNMENT_BOUNDARIES, ALIGNMENT_ENGINE, STEM_MODEL, KaraokeEngineError, KaraokeLeaseLost,
)
from app.providers.karaoke_stem_provider import StemArtifacts
from app.repositories.karaoke_processing_repository import freeze
from app.schemas.karaoke_processing import ProcessingCancel, ProcessingRetry


class FixtureEngine:
    def __init__(self, lyrics, duration):
        self.lyrics, self.duration = lyrics, duration
        self.separations = self.alignments = 0
        self.fail_once = False
        self.wait_for_cancel = False
        self.started = asyncio.Event()

    async def separate(self, audio, workspace, cancel):
        self.separations += 1
        self.assert_scoped(audio, workspace)
        vocal, backing = workspace / "fixture-vocal.mp3", workspace / "fixture-instrumental.mp3"
        vocal.write_bytes(mp3_fixture())
        backing.write_bytes(mp3_fixture(vbr=True))
        return StemArtifacts(vocal, backing, "fixture", 0, self.duration, {"fixture": True})

    @staticmethod
    def assert_scoped(audio, workspace):
        assert audio.is_file() and audio.is_relative_to(workspace)

    async def align(self, audio, texts, workspace, cancel):
        self.alignments += 1
        self.assert_scoped(audio, workspace)
        self.started.set()
        if self.wait_for_cancel:
            await cancel.wait()
            raise KaraokeLeaseLost()
        if self.fail_once:
            self.fail_once = False
            raise KaraokeEngineError("PROVIDER_TIMEOUT")
        raw = evidence(self.lyrics)
        raw.update(model_revision=ALIGNMENT_MODEL, boundary_version=ALIGNMENT_BOUNDARIES,
                   duration_ms=self.duration, frames=150)
        raw["units"][0]["acoustic_support"] = 0.4  # explicit review warning
        return AlignmentEvidence.model_validate(raw)


@unittest.skipUnless(pg.TEST_URL, "Requires the dedicated disposable PostgreSQL container")
class ProcessingPipelinePostgresTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp_base = api.ProcessingServicePostgresTests.asyncSetUp
    draft_request = api.ProcessingServicePostgresTests.draft_request

    async def asyncSetUp(self):
        await self.asyncSetUp_base()
        self.temp = tempfile.TemporaryDirectory(prefix="karaoke-worker-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.config.temp_dir = self.temp.name
        self.config.heartbeat_seconds = 1
        self.config.worker_enabled = True
        from app.services.karaoke_media_service import inspect_audio
        self.fixture = FixtureEngine(self.detail.draft.lyrics.model_dump(mode="json"),
                                     inspect_audio(mp3_fixture(vbr=True)).duration_ms)
        self.worker = KaraokeProcessingWorker(
            self.sessions, self.config, storage_factory=lambda: self.storage,
            client_factory=lambda config: self.fixture,
        )

    async def start_running(self, dto=None):
        dto = dto or await self.proc.start(self.admin, self.song_id, self.request)
        async with self.processing.write():
            job = await self.processing.get(dto.id, self.song_id, lock=True)
            job.status, job.stage, job.attempt_count = "RUNNING", "VALIDATING_INPUT", 1
            job.lease_token, job.lease_expires_at = uuid4(), utcnow() + timedelta(minutes=2)
            await self.db.flush()
            return freeze(job)

    async def process(self, dto=None):
        job = await self.start_running(dto)
        await self.worker.process(job)
        return await self.proc.get(self.admin, self.song_id, job.id)

    async def retry(self, dto):
        return await self.proc.retry(self.admin, self.song_id, dto.id, ProcessingRetry(
            **self.draft_request().model_dump(), idempotency_key=uuid4()))

    async def test_worker_stages_both_steps_without_mutating_draft_or_publishing(self):
        result = await self.process()
        self.assertEqual(result.status, "NEEDS_REVIEW")
        self.assertTrue(result.can_apply)
        self.assertTrue(result.quality_flags)
        detail = await self.service.detail(self.admin, self.song_id)
        self.assertEqual(detail.revision, self.detail.revision)
        self.assertEqual(detail.draft.audio_sha256, self.detail.draft.audio_sha256)
        self.assertIsNone(detail.published)
        async with self.processing.read():
            job = await self.processing.get(result.id, self.song_id)
            self.assertNotEqual(job.result_audio_sha256, job.input_audio_sha256)
            ledger = await self.processing.operations(result.id)
            self.assertEqual({op.step_key for op in ledger}, {"SEPARATE_STEMS", "ALIGN_PROVIDED_LYRICS"})
            self.assertTrue(all(op.state == "COMPLETED" for op in ledger))
            alignment = next(op for op in ledger if op.step_key == "ALIGN_PROVIDED_LYRICS")
            self.assertEqual(alignment.model_version, ALIGNMENT_ENGINE)
            self.assertEqual(alignment.usage["result"]["boundary_version"], ALIGNMENT_BOUNDARIES)
            self.assertEqual(job.provenance["alignment_boundaries"], ALIGNMENT_BOUNDARIES)
        self.assertFalse(list(Path(self.temp.name).iterdir()), "Only the scoped job temp directory is cleaned")
        applied = await self.proc.apply_result(self.admin, self.song_id, result.id, self.draft_request())
        self.assertTrue(applied.processing_review.required)
        self.assertFalse(applied.processing_review.reviewed)

    async def test_cancel_retry_reuses_completed_artifacts_and_remaps_warning_ids(self):
        first = await self.process()
        await self.proc.cancel(self.admin, self.song_id, first.id,
                               ProcessingCancel(draft_version_id=self.detail.draft.id))
        second = await self.process(await self.retry(first))
        self.assertEqual(second.status, "NEEDS_REVIEW")
        self.assertEqual(self.fixture.separations, 1)
        self.assertEqual(self.fixture.alignments, 1)
        self.assertNotEqual(first.quality_flags[0].id, second.quality_flags[0].id)
        async with self.processing.read():
            ledger = await self.processing.operations(second.id)
            self.assertTrue(all(op.usage["reused"] for op in ledger))
            references = []
            for op in ledger:
                for path in op.artifact_paths:
                    references.append(await self.repository.referenced(path))
            self.assertTrue(all(references))

    async def test_old_boundary_engine_cache_is_not_reused_even_with_matching_fingerprint(self):
        first = await self.process()
        # Simulate a legacy completed alignment with otherwise current immutable
        # inputs/digest. Model+boundary identity must independently fence reuse.
        async with self.processing.write():
            ledger = await self.processing.operations(first.id)
            alignment = next(op for op in ledger if op.step_key == "ALIGN_PROVIDED_LYRICS")
            alignment.model_version = f"{ALIGNMENT_MODEL}:ctc-delimiter-envelope-v2"
        await self.proc.cancel(self.admin, self.song_id, first.id,
                               ProcessingCancel(draft_version_id=self.detail.draft.id))
        second = await self.process(await self.retry(first))
        self.assertEqual(second.status, "NEEDS_REVIEW")
        self.assertEqual(self.fixture.separations, 1, "Unchanged measured stems remain reusable")
        self.assertEqual(self.fixture.alignments, 2, "Old boundaries require fresh alignment")
        async with self.processing.read():
            ledger = await self.processing.operations(second.id)
            steps = {op.step_key: op for op in ledger}
            self.assertTrue(steps["SEPARATE_STEMS"].usage["reused"])
            self.assertFalse(steps["ALIGN_PROVIDED_LYRICS"].usage["reused"])
            self.assertEqual(steps["ALIGN_PROVIDED_LYRICS"].model_version, ALIGNMENT_ENGINE)

    async def test_old_stem_clock_cache_is_not_reused_even_with_matching_fingerprint(self):
        first = await self.process()
        async with self.processing.write():
            ledger = await self.processing.operations(first.id)
            separation = next(op for op in ledger if op.step_key == "SEPARATE_STEMS")
            separation.model_version = "demucs-4.0.1:955717e8"
        await self.proc.cancel(self.admin, self.song_id, first.id,
                               ProcessingCancel(draft_version_id=self.detail.draft.id))
        second = await self.process(await self.retry(first))
        self.assertEqual(second.status, "NEEDS_REVIEW")
        self.assertEqual(self.fixture.separations, 2, "Legacy clock validation must not prove new stems")
        # The fixture emits identical immutable bytes. An alignment whose audio
        # and algorithm fingerprints still match can safely remain reusable.
        self.assertEqual(self.fixture.alignments, 1)
        async with self.processing.read():
            ledger = await self.processing.operations(second.id)
            steps = {op.step_key: op for op in ledger}
            self.assertFalse(steps["SEPARATE_STEMS"].usage["reused"])
            self.assertEqual(steps["SEPARATE_STEMS"].model_version, STEM_MODEL)
            self.assertTrue(steps["ALIGN_PROVIDED_LYRICS"].usage["reused"])

    async def test_local_timeout_is_retryable_without_false_paid_charge_ack(self):
        self.fixture.fail_once = True
        failed = await self.process()
        self.assertEqual(failed.status, "FAILED")
        self.assertEqual(failed.safe_error_code, "PROVIDER_TIMEOUT")
        self.assertEqual(failed.retry_policy, "SAFE_RETRY")
        recovered = await self.process(await self.retry(failed))
        self.assertEqual(recovered.status, "NEEDS_REVIEW")
        self.assertEqual(self.fixture.separations, 1)
        self.assertEqual(self.fixture.alignments, 2)

    async def test_cancel_while_engine_running_revokes_finish(self):
        self.fixture.wait_for_cancel = True
        job = await self.start_running()
        task = asyncio.create_task(self.worker.process(job))
        try:
            await asyncio.wait_for(self.fixture.started.wait(), timeout=10)
            cancelled = await self.proc.cancel(self.admin, self.song_id, job.id,
                ProcessingCancel(draft_version_id=self.detail.draft.id))
            self.assertEqual(cancelled.status, "CANCELLED")
            self.assertEqual(cancelled.retry_policy, "SAFE_RETRY")
            await asyncio.wait_for(task, timeout=10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        current = await self.proc.get(self.admin, self.song_id, job.id)
        self.assertEqual(current.status, "CANCELLED")
        detail = await self.service.detail(self.admin, self.song_id)
        self.assertEqual(detail.revision, self.detail.revision)
        self.assertFalse(detail.processing_review.required)

    async def test_disabled_worker_never_opens_database_transaction(self):
        self.config.worker_enabled = False
        def no_session():
            raise AssertionError("Disabled worker touched SQL")
        worker = KaraokeProcessingWorker(no_session, self.config)
        self.assertFalse(await worker.run_once())


if __name__ == "__main__":
    unittest.main()
