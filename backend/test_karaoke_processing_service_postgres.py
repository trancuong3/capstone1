"""Real SQL admission/apply/review checks; audio is a synthetic parser fixture.

No provider, production Storage or application DATABASE_URL is contacted.
"""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
import unittest
from uuid import UUID, uuid4
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import func, select

import test_karaoke_postgres_integration as pg
from test_karaoke import mp3_fixture
from test_karaoke_syllables import lyrics_v2
from app.core.karaoke_processing_config import KaraokeProcessingConfig
from app.models.karaoke import utcnow
from app.models.karaoke_processing import KaraokeProcessingJob as Job, KaraokeProcessingOperation as Operation, OUTSTANDING
from app.repositories.karaoke_processing_repository import KaraokeProcessingRepository
from app.repositories.karaoke_repository import KaraokeRepository
from app.schemas.karaoke import DraftRequest, DraftWrite, SongCreate, RevisionRequest
from app.schemas.karaoke_processing import ProcessingCancel, ProcessingReview, ProcessingRetry, ProcessingStart
from app.services.karaoke_media_service import inspect_audio
from app.services.karaoke_processing_service import KaraokeProcessingService
from app.services.karaoke_service import KaraokeService


@unittest.skipUnless(pg.TEST_URL, "Requires the dedicated disposable PostgreSQL container")
class ProcessingServicePostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await pg.KaraokePostgresTests.asyncSetUp(self)
        self.config = SimpleNamespace(**{
            **KaraokeProcessingConfig().__dict__, "enabled": True, "configured": True,
            "pipeline_version": "fixture-v1", "max_global": 1000,
            "reserved_minutes_admin_day": 10000, "reserved_minutes_global_day": 100000,
        })
        self.processing = KaraokeProcessingRepository(self.db)
        self.proc = KaraokeProcessingService(self.processing, self.storage, self.config)

        def download(path, song_id, size):
            self.storage.verify(path, song_id, size)
            return self.storage.objects[path]
        self.storage.download = download
        base = await pg.KaraokePostgresTests.ready(self)
        self.detail = await self.service.save(self.admin, self.song_id, DraftWrite(
            expected_revision=base.revision, draft_version_id=base.draft.id,
            title=self.title, source_note="Synthetic fixture", usage_note="Tests only",
            lyrics=lyrics_v2(),
        ))
        self.request = ProcessingStart(expected_revision=self.detail.revision,
                                       draft_version_id=self.detail.draft.id, idempotency_key=uuid4())

    async def assert_http(self, status, awaitable):
        with self.assertRaises(HTTPException) as caught:
            await awaitable
        self.assertEqual(caught.exception.status_code, status, caught.exception.detail)
        return caught.exception

    async def candidate(self, flags=None, lyrics=None):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        data = mp3_fixture(frames=120)
        info = inspect_audio(data)
        path = f"songs/{self.song_id}/versions/{self.detail.draft.id}/audio/{uuid4()}.mp3"
        self.storage.objects[path] = data
        async with self.processing.write():
            row = await self.processing.get(job.id, self.song_id, lock=True)
            row.status, row.stage = "NEEDS_REVIEW", "COMPLETE"
            row.result_lyrics = deepcopy(lyrics or self.detail.draft.lyrics.model_dump(mode="json"))
            row.result_audio_path, row.result_audio_sha256 = path, info.sha256
            row.result_audio_size_bytes, row.result_duration_ms = info.size_bytes, info.duration_ms
            row.quality_report = {"flags": flags or []}
            row.provenance = {"fixture": True}
            row.finished_at = row.updated_at = utcnow()
        return job, path

    def draft_request(self, detail=None):
        detail = detail or self.detail
        return DraftRequest(expected_revision=detail.revision, draft_version_id=detail.draft.id)

    def edit(self, detail, **updates):
        values = {key: getattr(detail.draft, key) for key in
                  ("title", "author", "min_grade", "max_grade", "source_note", "usage_note", "lyrics")}
        values.update(updates)
        return DraftWrite(expected_revision=detail.revision, draft_version_id=detail.draft.id, **values)

    async def test_start_replay_before_revision_and_conflicting_intent(self):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        self.assertEqual(job.status, "QUEUED")
        self.assertFalse(job.can_apply)
        self.assertNotIn("input_audio_path", job.model_dump())
        detail = await self.service.detail(self.admin, self.song_id)
        self.assertEqual(detail.revision, self.detail.revision)
        self.assertEqual(detail.processing_summary.job_id, job.id)
        changed = await self.service.save(self.admin, self.song_id, self.edit(detail, title="Changed"))
        self.assertEqual(changed.processing_summary.status, "STALE")
        replay = await self.proc.start(self.admin, self.song_id, self.request)
        self.assertEqual(replay.id, job.id)
        self.assertTrue(self.proc.replayed)
        conflict = self.request.model_copy(update={"mode": "INSTRUMENTAL_WITH_REFERENCE"})
        await self.assert_http(409, self.proc.start(self.admin, self.song_id, conflict))
        current = await self.service.detail(self.admin, self.song_id)
        self.assertEqual(current.revision, changed.revision)

    async def test_noop_keeps_queued_job_and_get_is_read_only(self):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        same = await self.service.save(self.admin, self.song_id, self.edit(self.detail))
        self.assertEqual(same.revision, self.detail.revision)
        self.assertEqual((await self.proc.get(self.admin, self.song_id, job.id)).status, "QUEUED")
        for _ in range(2):
            rows = await self.proc.list(self.admin, self.song_id)
            self.assertEqual(rows.total, 1)
            self.assertEqual(rows.items[0].status, "QUEUED")
        await self.assert_http(409, self.proc.start(self.admin, self.song_id,
            self.request.model_copy(update={"idempotency_key": uuid4()})))

    async def test_cancel_retains_ambiguous_ledger_and_retry_needs_ack(self):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        async with self.processing.write():
            self.db.add(Operation(
                id=uuid4(), job_id=job.id, stage="PREPARING_AUDIO", step_key="SEPARATE_STEMS",
                step_input_fingerprint="a" * 64, attempt=1, operation_key=uuid4(),
                provider="test-paid", model_version="fixture", pipeline_version="fixture-v1",
                state="SUBMITTED", lease_token=uuid4(),
            ))
        result = await self.proc.cancel(self.admin, self.song_id, job.id,
                                       ProcessingCancel(draft_version_id=self.detail.draft.id))
        self.assertEqual(result.status, "CANCELLED")
        self.assertEqual(result.retry_policy, "EXPLICIT_COST_ACK")
        retry = ProcessingRetry(**self.request.model_dump(exclude={"mode", "source_kind"}),
                                acknowledge_possible_charge=False)
        retry.idempotency_key = uuid4()
        await self.assert_http(422, self.proc.retry(self.admin, self.song_id, job.id, retry))
        retry.acknowledge_possible_charge = True
        fresh = await self.proc.retry(self.admin, self.song_id, job.id, retry)
        self.assertNotEqual(fresh.id, job.id)
        replay = await self.proc.retry(self.admin, self.song_id, job.id, retry)
        self.assertEqual(replay.id, fresh.id)
        async with self.processing.read():
            self.assertEqual(len(await self.processing.operations(job.id)), 1)
            previous = await self.processing.get(job.id, self.song_id)
            self.assertIsNone(previous.quota_released_at)

    async def test_atomic_apply_replay_review_publish_and_clone_lineage(self):
        flag = dict(id=str(uuid4()), codes=["BACKGROUND_ARTIFACT"],
                    line_id=None, syllable_ids=[], affected_syllable_count=0,
                    message_key="BACKGROUND_ARTIFACT")
        job, output = await self.candidate([flag])
        async with self.processing.read():
            source = (await self.processing.get(job.id, self.song_id)).input_audio_path
        preview = await self.proc.preview_result(self.admin, self.song_id, job.id)
        self.assertIn(str(job.id), str(preview.job_id))
        self.assertNotEqual(preview.audio_url, preview.reference_audio_url)
        applied = await self.proc.apply_result(self.admin, self.song_id, job.id, self.draft_request())
        self.assertEqual(applied.revision, self.detail.revision + 1)
        self.assertTrue(applied.processing_review.required)
        self.assertFalse(applied.processing_review.reviewed)
        async with self.processing.read():
            state = await self.repository.state(self.song_id)
            self.assertEqual(state.draft.audio_path, output)
            self.assertEqual(state.draft.audio_sha256, state.draft.timed_audio_sha256)
            self.assertTrue(await self.repository.referenced(source))
        repeated = await self.proc.apply_result(self.admin, self.song_id, job.id, self.draft_request())
        self.assertEqual(repeated.revision, applied.revision)
        await self.assert_http(409, self.proc.preview_result(self.admin, self.song_id, job.id))
        reference = await self.proc.preview_reference(self.admin, self.song_id)
        self.assertIn(source, reference.reference_audio_url)
        await self.assert_http(422, self.service.publish(self.admin, self.song_id, self.draft_request(applied)))
        review = ProcessingReview(
            **self.draft_request(applied).model_dump(),
            content_fingerprint=applied.processing_review.current_content_fingerprint,
            confirmed_listened=True, acknowledged_flag_ids=[],
        )
        await self.assert_http(422, self.proc.confirm_review(self.admin, self.song_id, review))
        review.acknowledged_flag_ids = [UUID(flag["id"])]
        reviewed = await self.proc.confirm_review(self.admin, self.song_id, review)
        self.assertTrue(reviewed.processing_review.reviewed)
        replay = await self.proc.confirm_review(self.admin, self.song_id, review)
        self.assertEqual(replay.revision, reviewed.revision)
        same = await self.service.save(self.admin, self.song_id, self.edit(reviewed))
        self.assertEqual(same.revision, reviewed.revision)
        self.assertTrue(same.processing_review.reviewed)
        published = await self.service.publish(self.admin, self.song_id, self.draft_request(reviewed))
        cloned = await self.service.draft(self.admin, self.song_id,
                                         RevisionRequest(expected_revision=published.revision))
        self.assertTrue(cloned.processing_review.required)
        self.assertFalse(cloned.processing_review.reviewed)
        cloned_ref = await self.proc.preview_reference(self.admin, self.song_id)
        self.assertIn(source, cloned_ref.reference_audio_url)
        playback = await self.service.playback(self.parent, self.song_id, self.child)
        self.assertNotIn("reference_audio_url", playback.model_dump())
        self.assertNotIn("processing_review", playback.model_dump())

    async def test_mutation_invalidates_attestation_and_old_apply_cannot_overwrite(self):
        job, _ = await self.candidate()
        applied = await self.proc.apply_result(self.admin, self.song_id, job.id, self.draft_request())
        review = ProcessingReview(**self.draft_request(applied).model_dump(),
            content_fingerprint=applied.processing_review.current_content_fingerprint,
            confirmed_listened=True)
        reviewed = await self.proc.confirm_review(self.admin, self.song_id, review)
        changed = await self.service.save(self.admin, self.song_id, self.edit(reviewed, title="Edited"))
        self.assertTrue(changed.processing_review.required)
        self.assertFalse(changed.processing_review.reviewed)
        await self.assert_http(409, self.proc.confirm_review(self.admin, self.song_id, review))
        await self.assert_http(409, self.proc.apply_result(self.admin, self.song_id, job.id, self.draft_request()))
        restored = await self.service.save(self.admin, self.song_id, self.edit(changed, title=reviewed.draft.title))
        self.assertEqual(restored.processing_review.current_content_fingerprint, review.content_fingerprint)
        self.assertFalse(restored.processing_review.reviewed)

    async def test_apply_missing_timing_keeps_review_blocked(self):
        raw = self.detail.draft.lyrics.model_dump(mode="json")
        raw["lines"][0]["syllables"][0]["start_ms"] = None
        job, _ = await self.candidate(lyrics=raw)
        applied = await self.proc.apply_result(self.admin, self.song_id, job.id, self.draft_request())
        self.assertTrue(applied.processing_review.required)
        async with self.processing.read():
            state = await self.repository.state(self.song_id)
            self.assertIsNone(state.draft.timed_audio_sha256)
        await self.assert_http(422, self.proc.confirm_review(self.admin, self.song_id, ProcessingReview(
            **self.draft_request(applied).model_dump(),
            content_fingerprint=applied.processing_review.current_content_fingerprint,
            confirmed_listened=True,
        )))

    async def test_reference_preview_after_explicit_upload_and_delete(self):
        from io import BytesIO
        from fastapi import UploadFile
        self.assertEqual(self.detail.draft.has_reference_audio, False)
        await self.assert_http(422, self.proc.preview_reference(self.admin, self.song_id))
        uploaded = await self.service.upload(
            self.admin, self.song_id, self.draft_request(),
            UploadFile(file=BytesIO(mp3_fixture(frames=110)), filename="reference.mp3"),
            reference=True,
        )
        self.assertTrue(uploaded.draft.has_reference_audio)
        self.assertNotEqual(uploaded.draft.audio_sha256, uploaded.draft.reference_audio_sha256)
        ref = await self.proc.preview_reference(self.admin, self.song_id)
        self.assertEqual(ref.revision, uploaded.revision)
        removed = await self.service.delete_reference(self.admin, self.song_id, self.draft_request(uploaded))
        self.assertFalse(removed.draft.has_reference_audio)
        await self.assert_http(422, self.proc.preview_reference(self.admin, self.song_id))

    async def test_apply_detects_stale_snapshot_and_commits_stale_status(self):
        job, _ = await self.candidate()
        # Model an external writer which changed timing without the service's
        # invalidation helper. GET must not repair this as a hidden write.
        async with self.processing.write():
            state = await self.repository.state(self.song_id, lock=True)
            raw = deepcopy(state.draft.lyrics)
            raw["lines"][0]["syllables"][0]["end_ms"] += 1
            state.draft.lyrics = raw
            original_audio = state.draft.audio_sha256
        read = await self.proc.get(self.admin, self.song_id, job.id)
        self.assertFalse(read.can_apply)
        self.assertEqual(read.status, "NEEDS_REVIEW")
        await self.assert_http(409, self.proc.apply_result(
            self.admin, self.song_id, job.id, self.draft_request()))
        async with self.processing.read():
            current = await self.processing.get(job.id, self.song_id)
            state = await self.repository.state(self.song_id)
            self.assertEqual(current.status, "STALE")
            self.assertEqual(state.draft.audio_sha256, original_audio)
            self.assertEqual(state.draft.lyrics, raw)

    async def test_apply_commit_failure_rolls_back_audio_lyrics_and_job_together(self):
        from sqlalchemy.exc import SQLAlchemyError
        job, output = await self.candidate()
        async with self.processing.read():
            state = await self.repository.state(self.song_id)
            original_audio, original_lyrics = state.draft.audio_path, deepcopy(state.draft.lyrics)
        original_commit = self.db.commit
        commits = 0
        async def fail_commit():
            nonlocal commits
            commits += 1
            # First boundary only snapshots the candidate. Fail the second,
            # after audio/lyrics/CAS/job updates have actually been flushed.
            if commits == 2:
                raise SQLAlchemyError("Synthetic commit failure")
            await original_commit()
        with patch.object(self.db, "commit", side_effect=fail_commit):
            with self.assertRaises(SQLAlchemyError):
                await self.proc.apply_result(self.admin, self.song_id, job.id, self.draft_request())
        self.assertEqual(commits, 2)
        async with self.sessions() as fresh:
            repo = KaraokeProcessingRepository(fresh)
            async with repo.read():
                state = await repo.songs.state(self.song_id)
                current = await repo.get(job.id, self.song_id)
                self.assertEqual(state.draft.audio_path, original_audio)
                self.assertEqual(state.draft.lyrics, original_lyrics)
                self.assertEqual(current.status, "NEEDS_REVIEW")
                self.assertEqual(state.song.revision, self.detail.revision)
        self.assertIn(output, self.storage.objects)

    async def test_permissions_and_song_job_pair_are_enforced(self):
        job = await self.proc.start(self.admin, self.song_id, self.request)
        other = await self.service.create(self.admin, SongCreate(title="Other"))
        for action in (
            self.proc.capabilities(self.parent),
            self.proc.get(self.parent, self.song_id, job.id),
            self.proc.list(self.parent, self.song_id),
            self.proc.start(self.parent, self.song_id, self.request),
        ):
            await self.assert_http(403, action)
        await self.assert_http(404, self.proc.get(self.admin, other.song_id, job.id))
        async with self.processing.write():
            actor = await self.db.get(pg.Profile, self.admin)
            actor.Active = 0
        await self.assert_http(403, self.proc.get(self.admin, self.song_id, job.id))

    async def test_cross_song_global_admission_race_respects_cap(self):
        other = await self.service.create(self.admin, SongCreate(title="Other ready"))
        # Reuse immutable source data in this second same-admin draft.
        async with self.processing.write():
            state = await self.repository.state(self.song_id)
            target = await self.repository.state(other.song_id, lock=True)
            for field in ("audio_path", "audio_sha256", "audio_size_bytes", "duration_ms", "lyrics"):
                setattr(target.draft, field, deepcopy(getattr(state.draft, field)))
            # Different song needs its own trusted path.
            path = f"songs/{other.song_id}/versions/{other.draft.id}/audio/{uuid4()}.mp3"
            self.storage.objects[path] = mp3_fixture()
            target.draft.audio_path = path
        async with self.processing.read():
            existing = await self.db.scalar(select(func.count()).select_from(Job).where(Job.status.in_(OUTSTANDING)))
        self.config.max_global = existing + 1
        async def enqueue(song_id, request):
            async with self.sessions() as db:
                storage = pg.TestStorage(db)
                storage.objects = self.storage.objects
                def download(path, song_id, size):
                    storage.verify(path, song_id, size)
                    return storage.objects[path]
                storage.download = download
                proc = KaraokeProcessingService(KaraokeProcessingRepository(db), storage, self.config)
                try:
                    return await proc.start(self.admin, song_id, request)
                except HTTPException as error:
                    return error.status_code
        second = ProcessingStart(expected_revision=other.revision, draft_version_id=other.draft.id,
                                 idempotency_key=uuid4())
        results = await asyncio.gather(enqueue(self.song_id, self.request), enqueue(other.song_id, second))
        self.assertEqual(sum(not isinstance(value, int) for value in results), 1)
        self.assertEqual(sum(value == 429 for value in results), 1)

    async def test_create_intent_race_is_exactly_one_song(self):
        key = uuid4()
        async def create():
            async with self.sessions() as db:
                return await KaraokeService(KaraokeRepository(db), pg.TestStorage(db)).create(
                    self.admin, SongCreate(title="Idempotent", creation_request_id=key))
        first, second = await asyncio.gather(create(), create())
        self.assertEqual(first.song_id, second.song_id)
        self.assertEqual(first.revision, second.revision)
        await self.assert_http(409, self.service.create(self.admin, SongCreate(
            title="Conflicting", creation_request_id=key)))


if __name__ == "__main__":
    unittest.main()
