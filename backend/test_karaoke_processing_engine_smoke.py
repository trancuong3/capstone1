"""Opt-in real local model + real SQL smoke. Never uses production Storage.

This is a short licensed research composite, NOT a held-out song benchmark.
Run only with the dedicated karaoke test DB and KARAOKE_REAL_ENGINE_SMOKE=1.
"""
from io import BytesIO
import os
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from fastapi import HTTPException, UploadFile

import test_karaoke_postgres_integration as pg
import test_karaoke_processing_service_postgres as api
import test_karaoke_processing_pipeline_postgres as pipeline_tests
from app.jobs.karaoke_processing_worker import KaraokeProcessingWorker
from app.providers.karaoke_local_aligner_client import ALIGNMENT_BOUNDARIES, ALIGNMENT_ENGINE
from app.schemas.karaoke import DraftWrite
from app.schemas.karaoke_processing import ProcessingReview, ProcessingStart
from app.services.karaoke_lyrics import timing_issues

OPT_IN = os.getenv("KARAOKE_REAL_ENGINE_SMOKE") == "1"
REQUIRED = ("KARAOKE_SMOKE_AUDIO", "KARAOKE_LOCAL_PYTHON", "KARAOKE_LOCAL_MODEL_PATH",
            "KARAOKE_LOCAL_STEM_MODEL_PATH")


@unittest.skipUnless(OPT_IN and pg.TEST_URL and all(os.getenv(name) for name in REQUIRED),
                     "Opt-in real local engine research smoke; not run in normal CI")
class RealLocalEngineSmoke(unittest.IsolatedAsyncioTestCase):
    asyncSetUp_base = api.ProcessingServicePostgresTests.asyncSetUp
    draft_request = api.ProcessingServicePostgresTests.draft_request
    start_running = pipeline_tests.ProcessingPipelinePostgresTests.start_running

    async def asyncSetUp(self):
        await self.asyncSetUp_base()
        self.temp = tempfile.TemporaryDirectory(prefix="karaoke-real-engine-test-")
        self.addCleanup(self.temp.cleanup)
        self.config.temp_dir = self.temp.name
        self.config.worker_enabled = True
        self.config.pipeline_version = "local-ctc-demucs-research-v2"
        self.config.python_path = os.environ["KARAOKE_LOCAL_PYTHON"]
        self.config.engine_script = str(Path(__file__).resolve().parents[1] / "ai/karaoke_processing/runner.py")
        self.config.model_path = os.environ["KARAOKE_LOCAL_MODEL_PATH"]
        self.config.stem_model_path = os.environ["KARAOKE_LOCAL_STEM_MODEL_PATH"]
        self.config.provider_timeout_seconds = 180
        for file in (Path(self.config.python_path), Path(self.config.engine_script),
                     Path(self.config.model_path) / "pytorch_model.bin",
                     Path(self.config.stem_model_path) / "955717e8-8726e21a.th"):
            self.assertTrue(file.is_file())
        source = Path(os.environ["KARAOKE_SMOKE_AUDIO"]).resolve(strict=True)
        self.assertLessEqual(source.stat().st_size, 20971520)
        uploaded = await self.service.upload(self.admin, self.song_id, self.draft_request(),
            UploadFile(file=BytesIO(source.read_bytes()), filename="private-research-composite.mp3"))
        lyrics = {"format_version": 2, "lines": [{
            "id": str(uuid4()), "text": "la la", "start_ms": None, "end_ms": None,
            "syllables": [{"id": str(uuid4()), "text": "la", "start_ms": None, "end_ms": None}
                          for _ in range(2)],
        }]}
        self.detail = await self.service.save(self.admin, self.song_id, DraftWrite(
            expected_revision=uploaded.revision, draft_version_id=uploaded.draft.id,
            title="Private research smoke - not a song benchmark",
            source_note="ViCa aple + Alexander Blu piano, see SOURCES-AND-PREFLIGHT.md",
            usage_note="Local noncommercial research only. Do not publish.", lyrics=lyrics,
        ))
        self.request = ProcessingStart(**self.draft_request().model_dump(), idempotency_key=uuid4())

    async def test_real_engine_stages_measured_v2_with_explicit_review_gate(self):
        job = await self.start_running()
        worker = KaraokeProcessingWorker(self.sessions, self.config, storage_factory=lambda: self.storage)
        await worker.process(job)
        result = await self.proc.get(self.admin, self.song_id, job.id)
        self.assertEqual(result.status, "NEEDS_REVIEW", result.model_dump())
        self.assertTrue(result.can_apply)
        async with self.processing.read():
            row = await self.processing.get(job.id, self.song_id)
            self.assertFalse(row.provenance["quality_calibrated"])
            self.assertTrue(row.provenance["local_offline"])
            self.assertEqual(row.provenance["alignment_boundaries"], ALIGNMENT_BOUNDARIES)
            self.assertEqual(row.result_lyrics["format_version"], 2)
            self.assertEqual([s["text"] for line in row.result_lyrics["lines"] for s in line["syllables"]],
                             ["la", "la"])
            units = [s for line in row.result_lyrics["lines"] for s in line["syllables"]]
            complete = [s for s in units if s["start_ms"] is not None and s["end_ms"] is not None]
            self.assertTrue(complete, "No usable timing must not produce a candidate")
            self.assertTrue(all(0 <= s["start_ms"] < s["end_ms"] <= row.result_duration_ms
                                for s in complete))
            ledger = await self.processing.operations(job.id)
            self.assertEqual({op.state for op in ledger}, {"COMPLETED"})
            alignment = next(op for op in ledger if op.step_key == "ALIGN_PROVIDED_LYRICS")
            self.assertEqual(alignment.model_version, ALIGNMENT_ENGINE)
        applied = await self.proc.apply_result(self.admin, self.song_id, job.id, self.draft_request())
        self.assertTrue(applied.processing_review.required)
        self.assertFalse(applied.processing_review.reviewed)
        self.assertIsNone(applied.published)
        with self.assertRaises(HTTPException) as blocked:
            await self.service.publish(self.admin, self.song_id, self.draft_request(applied))
        self.assertEqual(blocked.exception.status_code, 422)
        review = ProcessingReview(
            **self.draft_request(applied).model_dump(),
            content_fingerprint=applied.processing_review.current_content_fingerprint,
            confirmed_listened=True, acknowledged_flag_ids=[flag.id for flag in result.quality_flags],
        )
        if timing_issues(applied.draft.lyrics, applied.draft.duration_ms):
            with self.assertRaises(HTTPException) as refused:
                await self.proc.confirm_review(self.admin, self.song_id, review)
            self.assertEqual(refused.exception.status_code, 422,
                             "Acknowledgment cannot override missing timings")
        else:
            # Structural completeness still must not bypass explicit attestation.
            reviewed = await self.proc.confirm_review(self.admin, self.song_id, review)
            self.assertTrue(reviewed.processing_review.reviewed)
            self.assertIsNone(reviewed.published, "Review must not auto-publish")
        print("real_engine_smoke:", dict(
            valid_units=len(complete), reference_units=len(units), status=result.status,
            boundary_version=ALIGNMENT_BOUNDARIES, quality_calibrated=False,
            published=False, storage="in_memory", full_song_benchmark=False,
        ))


if __name__ == "__main__":
    unittest.main()
