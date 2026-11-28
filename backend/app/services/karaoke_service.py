"""Karaoke business rules, authorization and media/transaction coordination."""
from copy import deepcopy
from datetime import timedelta
import inspect
import logging
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.models.karaoke import utcnow
from app.repositories.karaoke_repository import KaraokeRepository
from app.schemas.karaoke import (
    AdminDetail, AdminList, AdminSongSummary, DraftPreview, Lyrics, Playback, SongCard, SongList,
    ValidationIssue, ValidationRead, VersionRead, MAX_AUDIO_BYTES, MAX_COVER_BYTES,
)
from app.services.karaoke_media_service import inspect_audio, normalize_cover, read_upload
from app.services.karaoke_storage_service import KaraokeStorage, URL_TTL
from app.services.karaoke_lyrics import clear_timings, timing_issues
from app.services.difficult_words_service import (
    normalize_vietnamese_practice_word,
    tokenize_vietnamese_practice_text,
)
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


def _extract_lyrics_search_text(lyrics) -> str:
    """Read-only lyric text extraction for matching difficult words without altering lyrics."""
    if not isinstance(lyrics, dict):
        return ""
    lines = lyrics.get("lines")
    if not isinstance(lines, list):
        return ""
    parts: list[str] = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        line_text = line.get("text")
        if isinstance(line_text, str) and line_text.strip():
            parts.append(line_text)
            continue
        tokens = line.get("tokens")
        if isinstance(tokens, list):
            token_texts = [
                str(tok.get("text")).strip()
                for tok in tokens
                if isinstance(tok, dict)
                and isinstance(tok.get("text"), str)
                and str(tok.get("text")).strip()
            ]
            if token_texts:
                parts.append(" ".join(token_texts))
    return " ".join(parts)


def _match_song_difficult_words(lyrics, difficult_words: list[str]) -> list[str]:
    if not difficult_words:
        return []
    raw_text = _extract_lyrics_search_text(lyrics)
    if not raw_text:
        return []
    tokens = [
        normalize_vietnamese_practice_word(token)
        for token in tokenize_vietnamese_practice_text(raw_text)
    ]
    cleaned_tokens = [token for token in tokens if token]
    if not cleaned_tokens:
        return []
    token_set = set(cleaned_tokens)
    padded = f" {' '.join(cleaned_tokens)} "

    matched: list[str] = []
    seen: set[str] = set()
    for word in difficult_words:
        norm = normalize_vietnamese_practice_word(word)
        if not norm or norm in seen:
            continue
        hit = norm in token_set if " " not in norm else f" {norm} " in padded
        if hit:
            seen.add(norm)
            matched.append(word)
    return matched


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

    async def _media_dto(self, song_id, version):
        await self._media_available(song_id, version)
        # Expiry is conservative: start the clock before asking Storage to sign.
        expires = utcnow() + timedelta(seconds=URL_TTL)
        audio_url = await run_in_threadpool(self.storage.sign, version.audio_path, song_id)
        cover_url = (await run_in_threadpool(self.storage.sign, version.cover_path, song_id)
                     if version.cover_path else None)
        return dict(song_id=song_id, version_id=version.id, title=version.title,
                    author=version.author, duration_ms=version.duration_ms,
                    audio_url=audio_url, audio_url_expires_at=expires,
                    cover_url=cover_url, lyrics=version.lyrics)

    async def preview(self, actor_id, song_id):
        state = await self._admin_snapshot(actor_id, song_id)
        if state.draft is None:
            raise HTTPException(409, "Karaoke draft is missing")
        if not state.draft.audio_path:
            raise HTTPException(422, "Karaoke audio is required")
        # Timing editor must hear audio before all lyric timings are completed.
        return DraftPreview(revision=state.song.revision,
                            **await self._media_dto(song_id, state.draft))

    async def _load_child_difficult_words(self, actor_id, child_id, *, limit: int = 12) -> list[str]:
        custom_fn = getattr(self.repository, "difficult_words", None)
        if custom_fn is not None:
            try:
                maybe_words = custom_fn(child_id, actor_id, limit=limit)
                if inspect.isawaitable(maybe_words):
                    maybe_words = await maybe_words
                if isinstance(maybe_words, (list, tuple)):
                    return [str(word) for word in maybe_words if str(word).strip()]
            except Exception:
                return []
        db = getattr(self.repository, "db", None)
        if db is None:
            return []
        try:
            from app.services.child_difficult_word_feed import ChildDifficultWordFeed

            return await ChildDifficultWordFeed(db).list_words(child_id, actor_id, limit=limit)
        except Exception:
            return []

    async def catalog(self, actor_id, child_id, *, search="", limit=12, offset=0):
        async with self.repository.read():
            grade = await self._grade(actor_id, child_id)
            difficult_words = await self._load_child_difficult_words(actor_id, child_id)
            if difficult_words:
                candidate_limit = max(int(limit) + int(offset), 200)
                all_states, total = await self.repository.list_states(
                    search=search, status=None, grade=grade, limit=candidate_limit, offset=0,
                )
                scored = [
                    (
                        state,
                        _match_song_difficult_words(
                            getattr(state.published, "lyrics", None),
                            difficult_words,
                        )
                        if state.published is not None
                        else [],
                    )
                    for state in all_states
                ]
                scored.sort(key=lambda pair: -len(pair[1]))
                sliced = scored[offset : offset + limit]
            else:
                states, total = await self.repository.list_states(
                    search=search, status=None, grade=grade, limit=limit, offset=offset,
                )
                sliced = [(state, []) for state in states]
        items = []
        for state, matched_words in sliced:
            version = state.published
            cover_url = (await run_in_threadpool(self.storage.sign, version.cover_path, state.song.id)
                         if version.cover_path else None)
            items.append(SongCard(song_id=state.song.id, version_id=version.id,
                                  title=version.title, author=version.author,
                                  min_grade=version.min_grade, max_grade=version.max_grade,
                                  duration_ms=version.duration_ms, cover_url=cover_url,
                                  matched_difficult_words=matched_words))
        return SongList(items=items, total=total, limit=limit, offset=offset)

    async def list_songs(self, actor_id, child_id, *, search="", limit=12, offset=0):
        return await self.catalog(
            actor_id,
            child_id,
            search=search,
            limit=limit,
            offset=offset,
        )

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
            snapshot = state.snapshot()
        if content_issues(snapshot.published):
            raise HTTPException(503, "Karaoke content is unavailable")
        return Playback(**await self._media_dto(song_id, snapshot.published))
