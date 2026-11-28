"""Karaoke business rules, authorization and media/transaction coordination."""
from copy import deepcopy
from datetime import timedelta
import logging
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.models.karaoke import utcnow
from app.repositories.karaoke_repository import KaraokeRepository
from app.schemas.karaoke import (
    AdminDetail, AdminList, AdminSongSummary, DraftPreview, Lyrics, MelodyExtractResponse,
    MelodyProfileRead, Playback, SongCard, SongList,
    ValidationIssue, ValidationRead, VersionRead, MAX_AUDIO_BYTES, MAX_COVER_BYTES,
)
from app.services.karaoke_media_service import inspect_audio, normalize_cover, read_upload
from app.services.karaoke_storage_service import KaraokeStorage, URL_TTL
from app.services.karaoke_lyrics import clear_timings, timing_issues
from app.services.karaoke_processing_review import (
    clear_review, content_fingerprint, fingerprint, quality_flags, reviewed_current,
)
from app.schemas.karaoke_processing_types import ProcessingReviewRead, ProcessingSummary

logger = logging.getLogger(__name__)
META = ("title", "author", "min_grade", "max_grade", "source_note", "usage_note")
ASSETS = ("audio_path", "cover_path", "audio_sha256", "timed_audio_sha256",
          "audio_size_bytes", "duration_ms", "lyrics", "reference_audio_path",
          "reference_audio_sha256", "reference_audio_size_bytes", "reference_duration_ms",
          "requires_processing_review", "origin_job_id")


def content_issues(version, *, require_binding=True):
    issues = []
    def issue(code, field, line_id=None):
        issues.append(ValidationIssue(code=code, field=field, line_id=line_id))
    for field, code in (("title", "TITLE_REQUIRED"), ("source_note", "SOURCE_REQUIRED"),
                        ("usage_note", "USAGE_REQUIRED")):
        if not getattr(version, field).strip():
            issue(code, field)
    if not version.audio_path or not version.audio_sha256 or not version.duration_ms:
        issue("AUDIO_REQUIRED", "audio")
    try:
        lyrics = Lyrics.model_validate(version.lyrics)
    except ValidationError:
        issue("CONTENT_INVALID", "lyrics")
        return issues
    if not lyrics.lines:
        issue("LYRICS_REQUIRED", "lyrics")
    issues.extend(timing_issues(lyrics, version.duration_ms))
    if require_binding and version.audio_sha256 != version.timed_audio_sha256:
        issue("TIMING_AUDIO_MISMATCH", "lyrics")
    return issues


class KaraokeService:
    def __init__(self, repository: KaraokeRepository, storage=None):
        self.repository = repository
        self.storage = storage or KaraokeStorage()
        # Existing pure service doubles remain usable for manual-content tests.
        # Production always supplies the SQL repository on the shared session.
        from app.repositories.karaoke_processing_repository import KaraokeProcessingRepository
        self.processing = (KaraokeProcessingRepository(repository.db)
                           if hasattr(repository, "db") else None)

    async def _actor(self, actor_id, role):
        actor = await self.repository.actor(actor_id)
        if actor != (role, 1):
            raise HTTPException(403, "Karaoke access denied")

    async def _grade(self, actor_id, child_id):
        await self._actor(actor_id, "parent")
        grade = await self.repository.child_grade(actor_id, child_id)
        if grade is None:
            raise HTTPException(404, "Karaoke child profile not found")
        return grade

    async def _state(self, song_id, request=None, *, lock=False):
        state = await self.repository.state(song_id, lock=lock)
        if state is None:
            raise HTTPException(404, "Karaoke song not found")
        if request is not None:
            if state.song.revision != request.expected_revision:
                raise HTTPException(409, "Karaoke revision changed")
            if hasattr(request, "draft_version_id") and (
                state.draft is None or state.draft.id != request.draft_version_id
            ):
                raise HTTPException(409, "Karaoke draft changed")
        return state

    @staticmethod
    def _version(version):
        if version is None:
            return None
        return VersionRead(
            **{key: getattr(version, key) for key in META},
            id=version.id, version_no=version.version_no, state=version.state,
            has_audio=bool(version.audio_path), has_cover=bool(version.cover_path),
            audio_sha256=version.audio_sha256,
            has_reference_audio=bool(getattr(version, "reference_audio_path", None)),
            reference_audio_sha256=getattr(version, "reference_audio_sha256", None),
            duration_ms=version.duration_ms, audio_size_bytes=version.audio_size_bytes,
            lyrics=version.lyrics, created_at=version.created_at,
            updated_at=version.updated_at, published_at=version.published_at,
        )

    async def _detail(self, state):
        summary = None
        review = ProcessingReviewRead()
        if self.processing:
            latest = (await self.processing.latest_summaries([state.song.id])).get(state.song.id)
            summary = self._processing_summary(latest)
        if state.draft:
            draft = state.draft
            origin = (await self.processing.get(draft.origin_job_id, state.song.id)
                      if self.processing and draft.origin_job_id else None)
            review = ProcessingReviewRead(
                required=bool(draft.requires_processing_review),
                current_content_fingerprint=content_fingerprint(draft),
                reviewed=reviewed_current(draft), reviewed_at=draft.reviewed_at,
                quality_flags=quality_flags(origin),
            )
        return AdminDetail(
            song_id=state.song.id, status=state.song.status, revision=state.song.revision,
            draft=self._version(state.draft), published=self._version(state.published),
            created_at=state.song.created_at, updated_at=state.song.updated_at,
            processing_summary=summary, processing_review=review,
        )

    @staticmethod
    def _processing_summary(job):
        if job is None:
            return None
        return ProcessingSummary(
            job_id=job.id, **{key: getattr(job, key) for key in (
                "draft_version_id", "status", "stage", "safe_error_code",
                "retry_policy", "updated_at",
            )},
        )

    async def _invalidate(self, state):
        clear_review(state.draft)
        if self.processing:
            active = await self.processing.outstanding(state.draft.id, lock=True)
            if active:
                self.processing.stale(active)

    async def _publication_issues(self, state):
        issues = []
        if self.processing and await self.processing.outstanding(state.draft.id):
            issues.append(ValidationIssue(code="PROCESSING_IN_PROGRESS", field="processing"))
        if state.draft.requires_processing_review and not reviewed_current(state.draft):
            issues.append(ValidationIssue(code="PROCESSING_REVIEW_REQUIRED", field="processing"))
        return issues

    @staticmethod
    def _summary(state):
        version = state.draft or state.published
        title = version.title or (state.published.title if state.published else "")
        return AdminSongSummary(
            song_id=state.song.id, status=state.song.status, revision=state.song.revision,
            title=title, author=version.author, min_grade=version.min_grade,
            max_grade=version.max_grade, duration_ms=version.duration_ms,
            draft_version_id=state.draft.id if state.draft else None,
            published_version_id=state.song.published_version_id,
            has_audio=bool(version.audio_path), has_cover=bool(version.cover_path),
            created_at=state.song.created_at, updated_at=state.song.updated_at,
        )

    async def create(self, actor_id, payload):
        self.creation_replayed = False
        async with self.repository.write():
            await self._actor(actor_id, "admin")
            key = payload.creation_request_id
            values = {field: getattr(payload, field) for field in META}
            request_hash = fingerprint(values)
            if key is not None:
                await self.repository.creation_lock()
                previous = await self.repository.creation_state(actor_id, key)
                if previous:
                    if previous.song.creation_request_fingerprint != request_hash:
                        raise HTTPException(409, "Karaoke create intent changed")
                    self.creation_replayed = True
                    return await self._detail(previous)
            state = await self.repository.create(actor_id, {
                **values, "lyrics": Lyrics().model_dump(mode="json"),
            })
            if key is not None:
                state.song.creation_request_id = key
                state.song.creation_request_fingerprint = request_hash
            result = await self._detail(state)
        return result

    async def detail(self, actor_id, song_id):
        async with self.repository.read():
            await self._actor(actor_id, "admin")
            return await self._detail(await self._state(song_id))

    async def admin_list(self, actor_id, *, search="", status=None, limit=12, offset=0):
        async with self.repository.read():
            await self._actor(actor_id, "admin")
            states, total = await self.repository.list_states(
                search=search, status=status, grade=None, limit=limit, offset=offset,
            )
            summaries = (await self.processing.latest_summaries([s.song.id for s in states])
                         if self.processing else {})
            items = []
            for state in states:
                item = self._summary(state)
                item.processing_summary = self._processing_summary(summaries.get(state.song.id))
                items.append(item)
            return AdminList(items=items,
                             total=total, limit=limit, offset=offset)

    async def draft(self, actor_id, song_id, payload):
        async with self.repository.write():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id, payload, lock=True)
            if state.draft is None:
                if state.published is None:
                    raise HTTPException(409, "Karaoke published version is missing")
                values = {key: deepcopy(getattr(state.published, key)) for key in (*META, *ASSETS)}
                values["requires_processing_review"] = bool(values["requires_processing_review"])
                state.draft = await self.repository.add_draft(
                    song_id, actor_id, await self.repository.next_version(song_id), values,
                )
                clear_review(state.draft)
                await self.repository.bump(state.song, payload.expected_revision)
            result = await self._detail(state)
        return result

    async def save(self, actor_id, song_id, payload):
        async with self.repository.write():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id, payload, lock=True)
            new_lyrics = payload.lyrics.model_dump(mode="json")
            if (all(getattr(state.draft, key) == getattr(payload, key) for key in META)
                    and state.draft.lyrics == new_lyrics):
                return await self._detail(state)
            await self._invalidate(state)
            for key in META:
                setattr(state.draft, key, getattr(payload, key))
            state.draft.lyrics = new_lyrics
            # Missing metadata need not prevent binding complete timing to audio.
            timing_errors = [issue for issue in content_issues(state.draft, require_binding=False)
                             if issue.field in {"audio", "lyrics"}]
            state.draft.timed_audio_sha256 = None if timing_errors else state.draft.audio_sha256
            state.draft.updated_at = utcnow()
            await self.repository.bump(state.song, payload.expected_revision)
            result = await self._detail(state)
        return result

    async def _admin_snapshot(self, actor_id, song_id, payload=None):
        async with self.repository.read():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id, payload)
            return state.snapshot()

    async def _media_available(self, song_id, version):
        await run_in_threadpool(self.storage.verify, version.audio_path, song_id, version.audio_size_bytes)
        if version.cover_path:
            await run_in_threadpool(self.storage.verify, version.cover_path, song_id)

    async def validation(self, actor_id, song_id):
        state = await self._admin_snapshot(actor_id, song_id)
        if state.draft is None:
            raise HTTPException(409, "Karaoke draft is missing")
        issues = content_issues(state.draft)
        async with self.repository.read():
            await self._actor(actor_id, "admin")
            current = await self._state(song_id)
            if current.song.revision != state.song.revision:
                raise HTTPException(409, "Karaoke revision changed")
            issues.extend(await self._publication_issues(current))
        if state.draft.audio_path:
            try:
                await self._media_available(song_id, state.draft)
            except HTTPException:
                issues.append(ValidationIssue(code="MEDIA_UNAVAILABLE", field="media"))
        return ValidationRead(valid=not issues, revision=state.song.revision,
                              draft_version_id=state.draft.id, issues=issues)

    async def publish(self, actor_id, song_id, payload):
        initial = await self._admin_snapshot(actor_id, song_id, payload)
        async with self.repository.read():
            await self._actor(actor_id, "admin")
            current = await self._state(song_id, payload)
            if await self._publication_issues(current):
                raise HTTPException(422, "Karaoke processing review is required")
        if content_issues(initial.draft):
            raise HTTPException(422, "Karaoke draft is not ready to publish")
        await self._media_available(song_id, initial.draft)
        async with self.repository.write():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id, payload, lock=True)
            if content_issues(state.draft) or await self._publication_issues(state):
                raise HTTPException(422, "Karaoke draft is not ready to publish")
            if state.published:
                state.published.state = "SUPERSEDED"
            state.draft.state = "PUBLISHED"
            state.draft.published_at = state.draft.updated_at = utcnow()
            state.song.status = "PUBLISHED"
            state.song.published_version_id = state.draft.id
            state.published, state.draft = state.draft, None
            await self.repository.bump(state.song, payload.expected_revision)
            result = await self._detail(state)
        return result

    async def visibility(self, actor_id, song_id, payload):
        initial = await self._admin_snapshot(actor_id, song_id, payload)
        if initial.published is None:
            raise HTTPException(409, "Karaoke published version is missing")
        if payload.visible:
            if content_issues(initial.published):
                raise HTTPException(422, "Karaoke published content is invalid")
            await self._media_available(song_id, initial.published)
        async with self.repository.write():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id, payload, lock=True)
            state.song.status = "PUBLISHED" if payload.visible else "HIDDEN"
            await self.repository.bump(state.song, payload.expected_revision)
            result = await self._detail(state)
        return result

    async def _cleanup(self, path, song_id):
        try:
            async with self.repository.read():
                referenced = await self.repository.referenced(path)
            if not referenced:
                await run_in_threadpool(self.storage.remove, path, song_id)
        except BaseException:
            # A commit/network failure is ambiguous: retain the object if the DB
            # cannot prove it unreferenced. Never delete somebody's published audio.
            logger.warning("karaoke_orphan_reference_check_failed")

    async def upload(self, actor_id, song_id, payload, file, *, cover=False, reference=False):
        try:
            await self._admin_snapshot(actor_id, song_id, payload)
            data = await read_upload(file, MAX_COVER_BYTES if cover else MAX_AUDIO_BYTES)
        finally:
            await file.close()
        if cover:
            data = await run_in_threadpool(normalize_cover, data)
            suffix, kind, content_type = "webp", "covers", "image/webp"
            audio = None
        else:
            audio = await run_in_threadpool(inspect_audio, data)
            suffix, kind, content_type = "mp3", "audio", "audio/mpeg"
        path = f"songs/{song_id}/versions/{payload.draft_version_id}/{kind}/{uuid4()}.{suffix}"
        try:
            await run_in_threadpool(self.storage.upload, path, song_id, data, content_type)
            async with self.repository.write():
                await self._actor(actor_id, "admin")
                state = await self._state(song_id, payload, lock=True)
                await self._invalidate(state)
                if cover:
                    state.draft.cover_path = path
                elif reference:
                    state.draft.reference_audio_path = path
                    state.draft.reference_audio_sha256 = audio.sha256
                    state.draft.reference_audio_size_bytes = audio.size_bytes
                    state.draft.reference_duration_ms = audio.duration_ms
                else:
                    state.draft.audio_path = path
                    state.draft.audio_sha256 = audio.sha256
                    state.draft.audio_size_bytes = audio.size_bytes
                    state.draft.duration_ms = audio.duration_ms
                    state.draft.timed_audio_sha256 = None
                    state.draft.lyrics = clear_timings(state.draft.lyrics)
                state.draft.updated_at = utcnow()
                await self.repository.bump(state.song, payload.expected_revision)
                result = await self._detail(state)
            return result
        except BaseException:
            await self._cleanup(path, song_id)
            raise

    async def delete_reference(self, actor_id, song_id, payload):
        async with self.repository.write():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id, payload, lock=True)
            if state.draft.reference_audio_path:
                await self._invalidate(state)
                for field in ("reference_audio_path", "reference_audio_sha256",
                              "reference_audio_size_bytes", "reference_duration_ms"):
                    setattr(state.draft, field, None)
                state.draft.updated_at = utcnow()
                await self.repository.bump(state.song, payload.expected_revision)
            result = await self._detail(state)
        return result

    async def _resolve_melody_profile(self, version):
        raw = getattr(version, "melody_profile", None)
        if not isinstance(raw, dict) and hasattr(self.repository, "db"):
            from app.repositories.karaoke_practice_repository import KaraokePracticeRepository

            practice_repo = KaraokePracticeRepository(self.repository.db)
            stored = await practice_repo.get_musical_profile(version.id)
            if stored is not None and isinstance(stored.ProfileJson, dict):
                candidate = stored.ProfileJson.get("melody_profile")
                if isinstance(candidate, dict):
                    raw = candidate
            if not isinstance(raw, dict):
                raw = await practice_repo.get_version_melody_profile(version.id)
        if not isinstance(raw, dict):
            return None
        try:
            return MelodyProfileRead.model_validate(raw)
        except ValidationError:
            return None

    async def _media_dto(self, song_id, version, *, melody_profile=None):
        await self._media_available(song_id, version)
        # Expiry is conservative: start the clock before asking Storage to sign.
        expires = utcnow() + timedelta(seconds=URL_TTL)
        audio_url = await run_in_threadpool(self.storage.sign, version.audio_path, song_id)
        cover_url = (await run_in_threadpool(self.storage.sign, version.cover_path, song_id)
                     if version.cover_path else None)
        return dict(song_id=song_id, version_id=version.id, title=version.title,
                    author=version.author, duration_ms=version.duration_ms,
                    audio_url=audio_url, audio_url_expires_at=expires,
                    cover_url=cover_url, lyrics=version.lyrics,
                    melody_profile=melody_profile)

    async def preview(self, actor_id, song_id):
        async with self.repository.read():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id)
            if state.draft is None:
                raise HTTPException(409, "Karaoke draft is missing")
            if not state.draft.audio_path:
                raise HTTPException(422, "Karaoke audio is required")
            melody = await self._resolve_melody_profile(state.draft)
            snapshot = state.snapshot()
        # Timing editor must hear audio before all lyric timings are completed.
        return DraftPreview(revision=snapshot.song.revision,
                            **await self._media_dto(song_id, snapshot.draft, melody_profile=melody))

    async def catalog(self, actor_id, child_id, *, search="", limit=12, offset=0):
        async with self.repository.read():
            grade = await self._grade(actor_id, child_id)
            states, total = await self.repository.list_states(
                search=search, status=None, grade=grade, limit=limit, offset=offset,
            )
        items = []
        for state in states:
            version = state.published
            cover_url = (await run_in_threadpool(self.storage.sign, version.cover_path, state.song.id)
                         if version.cover_path else None)
            items.append(SongCard(song_id=state.song.id, version_id=version.id,
                                  title=version.title, author=version.author,
                                  min_grade=version.min_grade, max_grade=version.max_grade,
                                  duration_ms=version.duration_ms, cover_url=cover_url))
        return SongList(items=items, total=total, limit=limit, offset=offset)

    async def playback(self, actor_id, song_id, child_id, expected_version_id=None):
        async with self.repository.read():
            grade = await self._grade(actor_id, child_id)
            state = await self._state(song_id)
            version = state.published
            if (state.song.status != "PUBLISHED" or version is None
                    or version.state != "PUBLISHED" or not version.min_grade <= grade <= version.max_grade):
                raise HTTPException(404, "Karaoke song not found")
            if expected_version_id is not None and version.id != expected_version_id:
                raise HTTPException(409, "Karaoke published version changed")
            melody = await self._resolve_melody_profile(version)
            snapshot = state.snapshot()
        if content_issues(snapshot.published):
            raise HTTPException(503, "Karaoke content is unavailable")
        return Playback(**await self._media_dto(song_id, snapshot.published, melody_profile=melody))

    async def extract_melody(self, actor_id, song_id):
        """Admin backfill/re-extract reference `melody_profile` from reference or song audio."""
        from app.services.karaoke_melody_extractor import (
            build_musical_profile_payload,
            extract_melody_profile,
        )

        async with self.repository.read():
            await self._actor(actor_id, "admin")
            state = await self._state(song_id)
            target_version = state.published or state.draft
            if target_version is None:
                raise HTTPException(404, "Karaoke song version not found")
            version_id = target_version.id
            ref_path = getattr(target_version, "reference_audio_path", None)
            ref_size = getattr(target_version, "reference_audio_size_bytes", None)
            audio_path = getattr(target_version, "audio_path", None)
            audio_size = getattr(target_version, "audio_size_bytes", None)
            duration_ms = getattr(target_version, "duration_ms", None)
            lyrics_json = deepcopy(target_version.lyrics)
            origin_job_id = getattr(target_version, "origin_job_id", None)
            if not ref_path and origin_job_id and hasattr(self.repository, "db"):
                from sqlalchemy import select
                from app.models.karaoke_processing import KaraokeProcessingJob

                origin = await self.repository.db.scalar(
                    select(KaraokeProcessingJob).where(
                        KaraokeProcessingJob.id == origin_job_id,
                        KaraokeProcessingJob.song_id == song_id,
                    )
                )
                if (
                    origin is not None
                    and origin.mode == "VOCAL_TRACK"
                    and origin.status == "APPLIED"
                    and origin.input_audio_path
                ):
                    ref_path = origin.input_audio_path
                    ref_size = origin.input_audio_size_bytes

        if ref_path:
            source_kind = "reference_audio"
            download_path, download_size = ref_path, ref_size
        elif audio_path:
            source_kind = "audio"
            download_path, download_size = audio_path, audio_size
        else:
            raise HTTPException(422, "Karaoke audio is required for melody extraction")

        audio_bytes = await run_in_threadpool(
            self.storage.download, download_path, song_id, download_size
        )
        raw_profile = await run_in_threadpool(
            extract_melody_profile,
            audio_bytes,
            lyrics=lyrics_json if isinstance(lyrics_json, dict) else None,
            duration_ms=duration_ms,
        )
        validated = None
        if raw_profile is not None:
            try:
                validated = MelodyProfileRead.model_validate(raw_profile)
            except ValidationError:
                raw_profile = None
                validated = None

        persisted = False
        storage_ready = True
        if raw_profile is not None:
            if hasattr(self.repository, "db"):
                from app.repositories.karaoke_practice_repository import KaraokePracticeRepository

                async with self.repository.write():
                    await self._actor(actor_id, "admin")
                    practice_repo = KaraokePracticeRepository(self.repository.db)
                    storage_ready = await practice_repo.is_storage_ready()
                    payload_json = build_musical_profile_payload(
                        raw_profile, lyrics_json if isinstance(lyrics_json, dict) else None
                    )
                    if storage_ready:
                        persisted = await practice_repo.upsert_musical_profile(
                            version_id,
                            bpm=payload_json.get("bpm"),
                            audio_type="DUAL_TRACK" if source_kind == "reference_audio" else "VOCAL_FULL",
                            has_pitch_contour=bool(payload_json.get("pitch_contour")),
                            has_beat_grid=bool(payload_json.get("beat_grid_ms")),
                            source_method="AUDIO_DSP",
                            profile_json=payload_json,
                        )
                    col_saved = await practice_repo.save_version_melody_profile(version_id, raw_profile)
                    persisted = persisted or col_saved
            else:
                # In-memory test double path
                async with self.repository.write():
                    await self._actor(actor_id, "admin")
                    state = await self._state(song_id, lock=True)
                    target = state.published or state.draft
                    if target is not None:
                        setattr(target, "melody_profile", raw_profile)
                        persisted = True

        return MelodyExtractResponse(
            song_id=song_id,
            version_id=version_id,
            source_audio=source_kind,
            melody_profile=validated,
            persisted=persisted,
            storage_ready=storage_ready,
        )
