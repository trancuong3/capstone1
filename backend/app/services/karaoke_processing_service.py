"""Admin-only job admission, immutable preview, atomic apply and attestation.

Only repositories own transactions; media I/O always happens between boundaries.
No provider call is made by an HTTP request.
"""
from copy import deepcopy
from datetime import timedelta, timezone

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app.core.karaoke_processing_config import KaraokeProcessingConfig
from app.models.karaoke import utcnow
from app.models.karaoke_processing import OUTSTANDING
from app.repositories.karaoke_processing_repository import freeze
from app.schemas.karaoke import Lyrics, MAX_AUDIO_BYTES, MAX_DURATION_MS, canonical_lyric_text
from app.schemas.karaoke_processing import (
    DraftReferencePreview, JobList, JobRead, ProcessingCapabilities,
    ProcessingLimits, ProcessingPreview,
)
from app.services.karaoke_media_service import inspect_audio
from app.services.karaoke_processing_review import (
    ambiguous_operations, clear_review, content_fingerprint, fingerprint,
    lyrics_hashes, quality_flags, reviewed_current, snapshot_matches,
)
from app.services.karaoke_service import KaraokeService, content_issues
from app.services.karaoke_storage_service import URL_TTL


def fail(status, code):
    raise HTTPException(status, {"code": code, "message_key": code})


class KaraokeProcessingService:
    def __init__(self, repository, storage=None, config=None):
        self.repository = repository
        self.songs = KaraokeService(repository.songs, storage)
        self.storage = self.songs.storage
        self.config = config if config is not None else KaraokeProcessingConfig.from_env()
        self.replayed = False

    async def _state(self, actor, song_id, *, lock=False):
        await self.songs._actor(actor, "admin")
        return await self.songs._state(song_id, lock=lock)

    async def _job(self, song_id, job_id, *, lock=False):
        job = await self.repository.get(job_id, song_id, lock=lock)
        if job is None:
            fail(404, "SONG_OR_JOB_NOT_FOUND")
        return job

    @staticmethod
    def _draft(state, request, *, revision=True):
        if (state.draft is None or state.draft.state != "DRAFT"
                or state.draft.id != request.draft_version_id):
            fail(409, "STALE_INPUT")
        if revision and state.song.revision != request.expected_revision:
            fail(409, "REVISION_CONFLICT")

    @staticmethod
    def _dto(state, job):
        return JobRead(
            **{key: getattr(job, key) for key in (
                "id", "song_id", "draft_version_id", "base_revision", "mode",
                "source_kind", "status", "stage", "input_fingerprint",
                "created_at", "updated_at", "finished_at", "applied_at",
                "applied_revision", "safe_error_code", "retry_policy",
            )},
            can_apply=job.status in {"READY", "NEEDS_REVIEW"} and snapshot_matches(state, job),
            quality_flags=quality_flags(job),
        )

    async def capabilities(self, actor):
        async with self.repository.read():
            await self.songs._actor(actor, "admin")
        config = self.config
        return ProcessingCapabilities(
            enabled=config.enabled, configured=config.configured,
            supported_modes=["VOCAL_TRACK", "INSTRUMENTAL_WITH_REFERENCE"] if config.configured else [],
            unavailable_reason=("DISABLED" if not config.enabled else
                                None if config.configured else "PROVIDER_NOT_CONFIGURED"),
            limits=ProcessingLimits(max_audio_bytes=MAX_AUDIO_BYTES, max_duration_ms=MAX_DURATION_MS),
            queue_warning_after_seconds=config.queue_warning_seconds,
        )

    def _enabled(self):
        if not self.config.enabled:
            fail(503, "PROCESSING_DISABLED")
        if not self.config.configured:
            fail(503, "PROVIDER_NOT_CONFIGURED")

    async def _verified(self, song_id, path, expected_hash, size, duration):
        data = await run_in_threadpool(self.storage.download, path, song_id, size)
        info = await run_in_threadpool(inspect_audio, data)
        if (info.sha256, info.size_bytes, info.duration_ms) != (expected_hash, size, duration):
            fail(503, "MEDIA_UNAVAILABLE")
        return info

    async def _source(self, state, mode, source_kind):
        draft = state.draft
        lyrics = Lyrics.model_validate(draft.lyrics)
        if (lyrics.format_version != 2 or not lyrics.lines
                or any(not line.syllables or
                       canonical_lyric_text(" ".join(unit.text for unit in line.syllables)) != canonical_lyric_text(line.text)
                       for line in lyrics.lines)):
            fail(422, "INVALID_LYRICS")
        source = dict(path=draft.audio_path, sha256=draft.audio_sha256,
                      size_bytes=draft.audio_size_bytes, duration_ms=draft.duration_ms)
        if source_kind == "ORIGINAL_RECORDING":
            origin = (await self.repository.get(draft.origin_job_id, state.song.id)
                      if draft.origin_job_id else None)
            if (origin is None or origin.mode != "VOCAL_TRACK" or origin.status != "APPLIED"
                    or draft.audio_sha256 != origin.result_audio_sha256):
                fail(422, "ORIGINAL_RECORDING_NOT_AVAILABLE")
            source = dict(path=origin.input_audio_path, sha256=origin.input_audio_sha256,
                          size_bytes=origin.input_audio_size_bytes, duration_ms=origin.input_duration_ms)
        if not all(source.values()):
            fail(422, "AUDIO_REQUIRED")
        reference = None
        if mode == "INSTRUMENTAL_WITH_REFERENCE":
            if not draft.reference_audio_path:
                fail(422, "REFERENCE_REQUIRED")
            reference = dict(path=draft.reference_audio_path, sha256=draft.reference_audio_sha256,
                             size_bytes=draft.reference_audio_size_bytes,
                             duration_ms=draft.reference_duration_ms)
        return lyrics.model_dump(mode="json"), source, reference

    async def start(self, actor, song_id, request):
        return await self._enqueue(actor, song_id, request)

    async def retry(self, actor, song_id, job_id, request):
        return await self._enqueue(actor, song_id, request, retry_id=job_id)

    async def _replay(self, actor, state, request, request_hash):
        previous = await self.repository.intent(
            actor, state.song.id, request.draft_version_id, request.idempotency_key)
        if previous is not None:
            if previous.request_fingerprint != request_hash:
                fail(409, "IDEMPOTENCY_CONFLICT")
            self.replayed = True
            return self._dto(state, previous)
        return None

    async def _retry_source(self, state, retry_id, request, *, lock=False):
        previous = await self._job(state.song.id, retry_id, lock=lock)
        if previous.draft_version_id != request.draft_version_id:
            fail(409, "STALE_INPUT")
        if previous.status not in {"FAILED", "CANCELLED", "STALE"}:
            fail(409, "PROCESSING_ALREADY_ACTIVE")
        if not snapshot_matches(state, previous):
            fail(409, "STALE_INPUT")
        ledger = await self.repository.operations(previous.id, lock=lock)
        if (previous.retry_policy == "EXPLICIT_COST_ACK" or ambiguous_operations(ledger)):
            if not request.acknowledge_possible_charge:
                fail(422, "POSSIBLE_CHARGE_ACK_REQUIRED")
        elif previous.retry_policy in {"NONE", "NEEDS_INPUT_CHANGE"}:
            fail(422, "INPUT_CHANGE_REQUIRED")
        return previous.mode, previous.source_kind

    async def _enqueue(self, actor, song_id, request, retry_id=None):
        self.replayed = False
        request_hash = fingerprint({
            "request": request.model_dump(mode="json", exclude={"idempotency_key"}),
            "retry_of_job_id": retry_id,
        })
        async with self.repository.read():
            state = await self._state(actor, song_id)
            replay = await self._replay(actor, state, request, request_hash)
            if replay:
                return replay
            self._draft(state, request)
            self._enabled()
            mode, source_kind = ((request.mode, request.source_kind) if retry_id is None
                                else await self._retry_source(state, retry_id, request))
            lyrics, source, reference = await self._source(state, mode, source_kind)
            initial = state.snapshot()
        await self._verified(song_id, source["path"], source["sha256"],
                             source["size_bytes"], source["duration_ms"])
        if reference:
            await self._verified(song_id, reference["path"], reference["sha256"],
                                 reference["size_bytes"], reference["duration_ms"])
        async with self.repository.write():
            await self.repository.quota_lock()
            state = await self._state(actor, song_id, lock=True)
            replay = await self._replay(actor, state, request, request_hash)
            if replay:
                return replay
            self._draft(state, request)
            # Complete fingerprint, not just text: catches edits racing media I/O.
            if content_fingerprint(state.draft) != content_fingerprint(initial.draft):
                fail(409, "STALE_INPUT")
            active = await self.repository.outstanding(state.draft.id, lock=True)
            if active:
                if snapshot_matches(state, active):
                    fail(409, "PROCESSING_ALREADY_ACTIVE")
                self.repository.stale(active)
                await self.repository.db.flush()
            if retry_id:
                await self._retry_source(state, retry_id, request, lock=True)
            day = utcnow().astimezone(timezone.utc).date()
            if not await self.repository.quota_available(actor, source["duration_ms"], self.config, day):
                fail(429, "PROCESSING_LIMIT_REACHED")
            text_hash, snapshot_hash = lyrics_hashes(lyrics)
            values = dict(
                song_id=song_id, draft_version_id=state.draft.id, created_by=actor,
                idempotency_key=request.idempotency_key, request_fingerprint=request_hash,
                retry_of_job_id=retry_id, mode=mode, source_kind=source_kind,
                pipeline_version=self.config.pipeline_version, base_revision=state.song.revision,
                base_audio_sha256=state.draft.audio_sha256,
                base_reference_sha256=state.draft.reference_audio_sha256,
                input_lyrics=lyrics, lyrics_text_sha256=text_hash, lyrics_snapshot_sha256=snapshot_hash,
                quota_day=day, reserved_audio_ms=source["duration_ms"],
            )
            values.update({f"input_audio_{key}" if key != "duration_ms" else "input_duration_ms": value
                           for key, value in source.items()})
            for key in ("path", "sha256", "size_bytes", "duration_ms"):
                values[f"input_reference_{key}"] = reference[key] if reference else None
            values["input_fingerprint"] = fingerprint({
                "policy": "karaoke-input-v1", "pipeline": self.config.pipeline_version,
                "draft_id": state.draft.id, "base_revision": state.song.revision,
                "base_audio_sha256": state.draft.audio_sha256,
                "base_reference_sha256": state.draft.reference_audio_sha256,
                "lyrics_snapshot_sha256": snapshot_hash, "source": source, "reference": reference,
                "mode": mode, "source_kind": source_kind,
            })
            job = await self.repository.enqueue(values)
            result = self._dto(state, job)
        return result

    async def get(self, actor, song_id, job_id):
        async with self.repository.read():
            state = await self._state(actor, song_id)
            return self._dto(state, await self._job(song_id, job_id))

    async def list(self, actor, song_id, *, limit=10, offset=0):
        async with self.repository.read():
            state = await self._state(actor, song_id)
            rows, total = await self.repository.list(song_id, limit, offset)
            return JobList(items=[self._dto(state, row) for row in rows], total=total,
                           limit=limit, offset=offset)

    async def cancel(self, actor, song_id, job_id, request):
        async with self.repository.write():
            state = await self._state(actor, song_id, lock=True)
            job = await self._job(song_id, job_id, lock=True)
            if job.draft_version_id != request.draft_version_id:
                fail(409, "STALE_INPUT")
            if job.status == "APPLIED":
                fail(409, "ALREADY_APPLIED")
            if job.status in OUTSTANDING:
                ledger = await self.repository.operations(job.id, lock=True)
                job.retry_policy = ("EXPLICIT_COST_ACK" if ambiguous_operations(ledger)
                                    else "SAFE_RETRY")
                job.status = "CANCELLED"
                job.cancel_requested_at = job.finished_at = job.updated_at = utcnow()
                job.lease_token = job.lease_expires_at = None
            result = self._dto(state, job)
        return result

    @staticmethod
    def _apply_replay(state, job, request):
        if job.status != "APPLIED":
            return False
        if (request.draft_version_id != job.draft_version_id
                or request.expected_revision != job.base_revision or state.draft is None
                or state.draft.id != job.draft_version_id or state.draft.state != "DRAFT"
                or state.song.revision != job.applied_revision):
            fail(409, "STALE_INPUT")
        return True

    async def _candidate(self, actor, song_id, job_id):
        async with self.repository.read():
            state = await self._state(actor, song_id)
            job = await self._job(song_id, job_id)
            if not self._dto(state, job).can_apply:
                fail(409, "STALE_INPUT")
            return state.snapshot(), freeze(job)

    async def preview_result(self, actor, song_id, job_id):
        state, job = await self._candidate(actor, song_id, job_id)
        await self._verified(song_id, job.result_audio_path, job.result_audio_sha256,
                             job.result_audio_size_bytes, job.result_duration_ms)
        reference = job.input_audio_path if job.mode == "VOCAL_TRACK" else job.input_reference_path
        expires = utcnow() + timedelta(seconds=URL_TTL)
        audio_url = await run_in_threadpool(self.storage.sign, job.result_audio_path, song_id)
        ref_url = await run_in_threadpool(self.storage.sign, reference, song_id) if reference else None
        cover_url = (await run_in_threadpool(self.storage.sign, state.draft.cover_path, song_id)
                     if state.draft.cover_path else None)
        # Refuse a stale URL after I/O, without turning GET into a write.
        current, current_job = await self._candidate(actor, song_id, job_id)
        if (current.song.revision != state.song.revision
                or current_job.input_fingerprint != job.input_fingerprint):
            fail(409, "STALE_INPUT")
        return ProcessingPreview(
            job_id=job.id, song_id=song_id, draft_version_id=job.draft_version_id,
            base_revision=job.base_revision, input_fingerprint=job.input_fingerprint,
            title=state.draft.title, author=state.draft.author, duration_ms=job.result_duration_ms,
            audio_url=audio_url, audio_url_expires_at=expires, cover_url=cover_url,
            reference_audio_url=ref_url, reference_audio_url_expires_at=expires if ref_url else None,
            lyrics=job.result_lyrics, quality_flags=quality_flags(job),
        )

    async def apply_result(self, actor, song_id, job_id, request):
        async with self.repository.write():
            state = await self._state(actor, song_id, lock=True)
            job = await self._job(song_id, job_id, lock=True)
            if self._apply_replay(state, job, request):
                return await self.songs._detail(state)
            self._draft(state, request, revision=False)
            if job.draft_version_id != request.draft_version_id:
                fail(409, "STALE_INPUT")
            candidate = freeze(job)
        if candidate.status not in {"READY", "NEEDS_REVIEW"}:
            fail(409, "PROCESSING_NOT_READY")
        await self._verified(song_id, candidate.result_audio_path, candidate.result_audio_sha256,
                             candidate.result_audio_size_bytes, candidate.result_duration_ms)
        lyrics = Lyrics.model_validate(candidate.result_lyrics)
        if lyrics.format_version != 2 or lyrics_hashes(lyrics.model_dump(mode="json"))[0] != candidate.lyrics_text_sha256:
            fail(422, "INVALID_PROVIDER_RESULT")
        stale = False
        async with self.repository.write():
            state = await self._state(actor, song_id, lock=True)
            job = await self._job(song_id, job_id, lock=True)
            if self._apply_replay(state, job, request):
                return await self.songs._detail(state)
            if job.status not in {"READY", "NEEDS_REVIEW"}:
                fail(409, "PROCESSING_NOT_READY")
            if request.expected_revision != job.base_revision or not snapshot_matches(state, job):
                self.repository.stale(job)
                stale = True
            else:
                draft = state.draft
                draft.audio_path, draft.audio_sha256 = job.result_audio_path, job.result_audio_sha256
                draft.audio_size_bytes, draft.duration_ms = job.result_audio_size_bytes, job.result_duration_ms
                draft.lyrics = deepcopy(job.result_lyrics)
                errors = [i for i in content_issues(draft, require_binding=False) if i.field in {"audio", "lyrics"}]
                draft.timed_audio_sha256 = None if errors else draft.audio_sha256
                draft.requires_processing_review, draft.origin_job_id = True, job.id
                clear_review(draft)
                draft.updated_at = utcnow()
                await self.repository.songs.bump(state.song, request.expected_revision)
                job.status, job.applied_revision = "APPLIED", state.song.revision
                job.applied_at = job.updated_at = utcnow()
                result = await self.songs._detail(state)
        if stale:
            fail(409, "STALE_INPUT")
        return result

    async def _reference(self, state):
        draft = state.draft
        if draft is None:
            fail(409, "STALE_INPUT")
        if draft.reference_audio_path:
            return (draft.reference_audio_path, draft.reference_audio_sha256,
                    draft.reference_audio_size_bytes, draft.reference_duration_ms)
        origin = (await self.repository.get(draft.origin_job_id, state.song.id)
                  if draft.origin_job_id else None)
        if origin and origin.mode == "VOCAL_TRACK" and origin.status == "APPLIED":
            return (origin.input_audio_path, origin.input_audio_sha256,
                    origin.input_audio_size_bytes, origin.input_duration_ms)
        fail(422, "REFERENCE_NOT_AVAILABLE")

    async def preview_reference(self, actor, song_id):
        async with self.repository.read():
            state = await self._state(actor, song_id)
            source = await self._reference(state)
            snapshot = state.snapshot()
            content_hash = content_fingerprint(state.draft)
        await self._verified(song_id, *source)
        expires = utcnow() + timedelta(seconds=URL_TTL)
        url = await run_in_threadpool(self.storage.sign, source[0], song_id)
        async with self.repository.read():
            current = await self._state(actor, song_id)
            if (current.draft is None or current.song.revision != snapshot.song.revision
                    or content_fingerprint(current.draft) != content_hash):
                fail(409, "STALE_INPUT")
        return DraftReferencePreview(
            song_id=song_id, draft_version_id=snapshot.draft.id, revision=snapshot.song.revision,
            content_fingerprint=content_hash, reference_audio_url=url,
            reference_audio_url_expires_at=expires,
        )

    @staticmethod
    def _review_replay(state, request):
        draft = state.draft
        return bool(draft and draft.id == request.draft_version_id and draft.state == "DRAFT"
                    and request.confirmed_listened and reviewed_current(draft)
                    and draft.reviewed_content_sha256 == request.content_fingerprint
                    and set(draft.review_acknowledged_flag_ids) ==
                        {str(key) for key in request.acknowledged_flag_ids})

    async def _review_guard(self, state, request):
        self._draft(state, request)
        draft = state.draft
        if not draft.requires_processing_review:
            fail(422, "REVIEW_NOT_REQUIRED")
        if content_fingerprint(draft) != request.content_fingerprint:
            fail(409, "STALE_INPUT")
        if await self.repository.outstanding(draft.id):
            fail(409, "PROCESSING_ALREADY_ACTIVE")
        origin = await self._job(state.song.id, draft.origin_job_id)
        expected = {flag.id for flag in quality_flags(origin)}
        provided = set(request.acknowledged_flag_ids)
        if not provided <= expected:
            fail(422, "INVALID_FLAG_ACKNOWLEDGMENT")
        if not request.confirmed_listened or provided != expected or content_issues(draft):
            fail(422, "REVIEW_REQUIRED")

    async def confirm_review(self, actor, song_id, request):
        async with self.repository.read():
            state = await self._state(actor, song_id)
            if self._review_replay(state, request):
                return await self.songs._detail(state)
            await self._review_guard(state, request)
            initial = state.snapshot()
        await self._verified(song_id, initial.draft.audio_path, initial.draft.audio_sha256,
                             initial.draft.audio_size_bytes, initial.draft.duration_ms)
        await self.songs._media_available(song_id, initial.draft)
        async with self.repository.write():
            state = await self._state(actor, song_id, lock=True)
            if self._review_replay(state, request):
                return await self.songs._detail(state)
            await self._review_guard(state, request)
            draft = state.draft
            draft.reviewed_content_sha256 = request.content_fingerprint
            draft.reviewed_by = actor
            draft.reviewed_at = draft.updated_at = utcnow()
            draft.review_acknowledged_flag_ids = sorted(str(key) for key in request.acknowledged_flag_ids)
            await self.repository.songs.bump(state.song, request.expected_revision)
            result = await self.songs._detail(state)
        return result
