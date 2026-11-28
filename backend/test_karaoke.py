"""Isolated karaoke contracts, authorization, publication and media tests.

All repositories, Storage and users in this file are test-local doubles.
MPEG frames below are synthetic parser fixtures, not a playable song catalog.
"""
import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from contextlib import asynccontextmanager
from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.karaoke import get_karaoke_service, router
from app.models.karaoke import KaraokeSong, KaraokeSongVersion, utcnow
from app.repositories.karaoke_repository import KaraokeRepository, SongState
from app.schemas.karaoke import (
    DraftRequest, DraftWrite, Lyrics, RevisionRequest, SongCreate, VisibilityRequest,
    MAX_AUDIO_BYTES,
)
from app.services.karaoke_media_service import inspect_audio, normalize_cover, read_upload
from app.services.karaoke_service import KaraokeService, content_issues
from app.services.karaoke_storage_service import KaraokeStorage

ADMIN, PARENT, CHILD, FOREIGN_CHILD, INACTIVE = (uuid4() for _ in range(5))


def mp3_fixture(*, frames=100, vbr=False):
    normal = b"\xff\xfb\x90\x64" + bytes(413)
    if not vbr:
        return normal * frames
    high = b"\xff\xfb\xa0\x64" + bytes(518)
    data = bytearray(normal * (frames // 2) + high * (frames - frames // 2))
    data[36:52] = b"Xing" + (3).to_bytes(4, "big") + frames.to_bytes(4, "big") + len(data).to_bytes(4, "big")
    return bytes(data)


def lyrics(start=0, end=1000):
    return {"format_version": 1, "lines": [{
        "id": str(uuid4()), "text": "Dòng kiểm thử", "start_ms": start, "end_ms": end,
    }]}


class MemoryRepository:
    """Transactional service double; SQL behavior is covered separately."""
    def __init__(self):
        self.songs, self.versions = {}, {}
        self.actors = {ADMIN: ("admin", 1), PARENT: ("parent", 1), INACTIVE: ("admin", 0)}
        self.children = {(PARENT, CHILD): 2}
        self.in_transaction = False
        self.fail_commit = False

    @asynccontextmanager
    async def read(self):
        self.in_transaction = True
        try:
            yield
        finally:
            self.in_transaction = False

    @asynccontextmanager
    async def write(self):
        old_songs, old_versions = deepcopy(self.songs), deepcopy(self.versions)
        self.in_transaction = True
        try:
            yield
            if self.fail_commit:
                raise SQLAlchemyError("isolated commit failure")
        except BaseException:
            self.songs, self.versions = old_songs, old_versions
            raise
        finally:
            self.in_transaction = False

    async def actor(self, actor_id):
        return self.actors.get(actor_id)

    async def child_grade(self, actor_id, child_id):
        return self.children.get((actor_id, child_id))

    async def state(self, song_id, *, lock=False):
        song = self.songs.get(song_id)
        if not song:
            return None
        draft = next((v for v in self.versions.values() if v.song_id == song_id and v.state == "DRAFT"), None)
        return SongState(song, draft, self.versions.get(song.published_version_id))

    async def create(self, actor_id, values):
        now = utcnow()
        song = KaraokeSong(id=uuid4(), status="DRAFT", revision=1, published_version_id=None,
                           created_by=actor_id, created_at=now, updated_at=now)
        self.songs[song.id] = song
        draft = await self.add_draft(song.id, actor_id, 1, values)
        return SongState(song, draft, None)

    async def add_draft(self, song_id, actor_id, version_no, values):
        now = utcnow()
        defaults = dict(audio_path=None, cover_path=None, audio_sha256=None,
                        timed_audio_sha256=None, audio_size_bytes=None, duration_ms=None,
                        lyrics={"format_version": 1, "lines": []})
        version = KaraokeSongVersion(id=uuid4(), song_id=song_id, version_no=version_no,
                                     state="DRAFT", created_by=actor_id, created_at=now,
                                     updated_at=now, published_at=None, **{**defaults, **values})
        self.versions[version.id] = version
        return version

    async def next_version(self, song_id):
        return max(v.version_no for v in self.versions.values() if v.song_id == song_id) + 1

    async def bump(self, song, expected_revision):
        if song.revision != expected_revision:
            raise AssertionError("Service must guard the revision")
        song.revision += 1
        song.updated_at = utcnow()

    async def referenced(self, path):
        return any(path in (v.audio_path, v.cover_path) for v in self.versions.values())


class MemoryStorage:
    def __init__(self, repository):
        self.repository, self.objects = repository, {}
        self.on_upload = None

    def assert_no_db_lock(self):
        assert not self.repository.in_transaction, "Storage work must not hold a DB transaction"

    def upload(self, path, song_id, data, content_type):
        self.assert_no_db_lock()
        self.objects[path] = data
        if self.on_upload:
            self.on_upload()

    def verify(self, path, song_id, expected_size=None):
        self.assert_no_db_lock()
        if path not in self.objects:
            raise HTTPException(503, "Isolated missing media")
        if expected_size is not None:
            assert len(self.objects[path]) == expected_size

    def sign(self, path, song_id):
        self.verify(path, song_id)
        return "https://example.supabase.co/storage/v1/object/sign/viread-karaoke/" + path + "?token=test"

    def remove(self, path, song_id):
        self.assert_no_db_lock()
        self.objects.pop(path, None)


class KaraokeSchemaTests(unittest.TestCase):
    def test_draft_accepts_incomplete_timing_but_rejects_extra_server_fields(self):
        self.assertIsNone(Lyrics.model_validate(lyrics(None, None)).lines[0].start_ms)
        for field in ("audio_path", "duration_ms", "timed_audio_sha256", "state"):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                DraftWrite(expected_revision=1, draft_version_id=uuid4(), **{field: "injected"})

    def test_strict_times_unique_ids_and_bounds(self):
        for start in (True, 0.5, "1", -1, 300001):
            with self.subTest(start=start), self.assertRaises(ValidationError):
                Lyrics.model_validate(lyrics(start, 1000))
        data = lyrics()
        data["lines"].append(dict(data["lines"][0]))
        with self.assertRaises(ValidationError):
            Lyrics.model_validate(data)
        with self.assertRaises(ValidationError):
            SongCreate(min_grade=4, max_grade=2)
        with self.assertRaises(ValidationError):
            Lyrics(format_version=True)

    def test_text_normalization_and_control_rejection(self):
        self.assertEqual(SongCreate(title="  Ha\u0301t  ").title, "Hát")
        with self.assertRaises(ValidationError):
            Lyrics.model_validate({**lyrics(), "lines": [{"id": str(uuid4()), "text": "\x00"}]})


class KaraokeMediaTests(unittest.TestCase):
    def test_actual_parser_accepts_cbr_and_xing_vbr_metadata(self):
        for vbr in (False, True):
            data = mp3_fixture(vbr=vbr)
            metadata = inspect_audio(data)
            self.assertTrue(2000 < metadata.duration_ms < 3000)
            self.assertEqual(metadata.size_bytes, len(data))
            self.assertEqual(len(metadata.sha256), 64)

    def test_fake_mp3_empty_and_long_audio_are_rejected(self):
        for data, status in ((b"", 415), (b"ID3 not an MP3", 415),
                             (mp3_fixture(frames=12000), 422), (bytes(MAX_AUDIO_BYTES + 1), 413)):
            with self.subTest(status=status), self.assertRaises(HTTPException) as caught:
                inspect_audio(data)
            self.assertEqual(caught.exception.status_code, status)

    def test_cover_is_decoded_reencoded_and_bounded(self):
        source = BytesIO()
        Image.new("RGB", (16, 16), "red").save(source, "PNG")
        result = normalize_cover(source.getvalue())
        with Image.open(BytesIO(result)) as image:
            self.assertEqual(image.format, "WEBP")
            self.assertNotIn("exif", image.info)
        for size, fmt in (((4097, 1), "PNG"), ((2, 2), "GIF")):
            source = BytesIO()
            Image.new("RGB", size).save(source, fmt)
            with self.assertRaises(HTTPException):
                normalize_cover(source.getvalue())


class KaraokeServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repository = MemoryRepository()
        self.storage = MemoryStorage(self.repository)
        self.service = KaraokeService(self.repository, self.storage)
        self.detail = await self.service.create(ADMIN, SongCreate(title="Bài thử"))
        self.song_id = self.detail.song_id

    def request(self, detail=None):
        detail = detail or self.detail
        return DraftRequest(expected_revision=detail.revision, draft_version_id=detail.draft.id)

    async def upload(self, detail=None):
        detail = detail or self.detail
        return await self.service.upload(ADMIN, self.song_id, self.request(detail),
                                         UploadFile(file=BytesIO(mp3_fixture()), filename="test.mp3"))

    async def ready(self):
        uploaded = await self.upload()
        return await self.service.save(ADMIN, self.song_id, DraftWrite(
            **self.request(uploaded).model_dump(), title="Bài thử", source_note="Synthetic test fixture",
            usage_note="Tests only", lyrics=lyrics(),
        ))

    async def published(self):
        ready = await self.ready()
        return await self.service.publish(ADMIN, self.song_id, self.request(ready))

    async def test_role_active_and_child_ownership_checks(self):
        for actor in (PARENT, INACTIVE, uuid4()):
            with self.subTest(actor=actor), self.assertRaises(HTTPException) as caught:
                await self.service.detail(actor, self.song_id)
            self.assertEqual(caught.exception.status_code, 403)
        with self.assertRaises(HTTPException) as caught:
            await self.service.playback(PARENT, self.song_id, FOREIGN_CHILD)
        self.assertEqual(caught.exception.status_code, 404)

    async def test_oversized_stream_is_bounded_and_closed(self):
        file = UploadFile(file=BytesIO(bytes(101)))
        with self.assertRaises(HTTPException) as caught:
            await read_upload(file, 100)
        self.assertEqual(caught.exception.status_code, 413)
        self.assertTrue(file.file.closed)

    async def test_draft_is_invisible_and_incomplete_publish_rejected(self):
        result = await self.service.validation(ADMIN, self.song_id)
        self.assertFalse(result.valid)
        self.assertIn("AUDIO_REQUIRED", {i.code for i in result.issues})
        with self.assertRaises(HTTPException) as caught:
            await self.service.publish(ADMIN, self.song_id, self.request())
        self.assertEqual(caught.exception.status_code, 422)
        with self.assertRaises(HTTPException) as caught:
            await self.service.playback(PARENT, self.song_id, CHILD)
        self.assertEqual(caught.exception.status_code, 404)

    async def test_upload_preview_can_hear_before_timing_is_complete(self):
        uploaded = await self.upload()
        self.assertTrue(uploaded.draft.has_audio)
        preview = await self.service.preview(ADMIN, self.song_id)
        self.assertIn("?token=", preview.audio_url)
        self.assertEqual(preview.lyrics.lines, [])
        self.assertFalse((await self.service.validation(ADMIN, self.song_id)).valid)

    async def test_complete_flow_public_dto_and_version_isolation(self):
        published = await self.published()
        playback = await self.service.playback(PARENT, self.song_id, CHILD)
        self.assertEqual(playback.version_id, published.published.id)
        self.assertNotIn("source_note", playback.model_dump())
        self.assertNotIn("audio_path", playback.model_dump())
        draft = await self.service.draft(ADMIN, self.song_id, RevisionRequest(expected_revision=published.revision))
        replaced = await self.upload(draft)
        state = await self.repository.state(self.song_id)
        self.assertEqual(state.published.id, published.published.id)
        self.assertIsNotNone(state.published.lyrics["lines"][0]["start_ms"])
        self.assertIsNone(replaced.draft.lyrics.lines[0].start_ms)
        self.assertIn(state.published.audio_path, self.storage.objects)
        self.assertNotEqual(state.draft.audio_path, state.published.audio_path)
        self.assertEqual((await self.service.playback(PARENT, self.song_id, CHILD)).version_id, playback.version_id)

    async def test_stale_revision_and_draft_id_cannot_overwrite(self):
        await self.upload()
        for payload in (self.request(), DraftRequest(expected_revision=2, draft_version_id=uuid4())):
            with self.assertRaises(HTTPException) as caught:
                await self.service.save(ADMIN, self.song_id, DraftWrite(**payload.model_dump()))
            self.assertEqual(caught.exception.status_code, 409)

    async def test_visibility_grade_and_expected_playback_version(self):
        published = await self.published()
        self.repository.children[(PARENT, CHILD)] = 5
        state = await self.repository.state(self.song_id)
        state.published.max_grade = 3
        with self.assertRaises(HTTPException) as caught:
            await self.service.playback(PARENT, self.song_id, CHILD)
        self.assertEqual(caught.exception.status_code, 404)
        self.repository.children[(PARENT, CHILD)] = 2
        with self.assertRaises(HTTPException) as caught:
            await self.service.playback(PARENT, self.song_id, CHILD, uuid4())
        self.assertEqual(caught.exception.status_code, 409)
        hidden = await self.service.visibility(ADMIN, self.song_id, VisibilityRequest(
            expected_revision=published.revision, visible=False))
        with self.assertRaises(HTTPException) as caught:
            await self.service.playback(PARENT, self.song_id, CHILD)
        self.assertEqual(caught.exception.status_code, 404)
        await self.service.visibility(ADMIN, self.song_id, VisibilityRequest(
            expected_revision=hidden.revision, visible=True))
        self.assertEqual((await self.service.playback(PARENT, self.song_id, CHILD)).title, "Bài thử")

    async def test_upload_race_cleans_only_unreferenced_new_asset(self):
        self.storage.on_upload = lambda: setattr(self.repository.songs[self.song_id], "revision", 2)
        with self.assertRaises(HTTPException) as caught:
            await self.upload()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.storage.objects, {})

    async def test_commit_failure_rolls_back_and_cleans_new_upload(self):
        self.repository.fail_commit = True
        with self.assertRaises(SQLAlchemyError):
            await self.upload()
        self.assertEqual(self.storage.objects, {})
        self.assertIsNone((await self.repository.state(self.song_id)).draft.audio_path)

    async def test_ambiguous_commit_never_deletes_possibly_referenced_asset(self):
        self.repository.fail_commit = True
        self.repository.referenced = AsyncMock(side_effect=SQLAlchemyError("unavailable"))
        with self.assertRaises(SQLAlchemyError):
            await self.upload()
        self.assertEqual(len(self.storage.objects), 1)

    async def test_missing_media_rejects_publish_and_reports_safe_issue(self):
        ready = await self.ready()
        self.storage.objects.clear()
        result = await self.service.validation(ADMIN, self.song_id)
        self.assertIn("MEDIA_UNAVAILABLE", {i.code for i in result.issues})
        with self.assertRaises(HTTPException) as caught:
            await self.service.publish(ADMIN, self.song_id, self.request(ready))
        self.assertEqual(caught.exception.status_code, 503)

    async def test_timing_validation_detects_overlap_order_range_and_binding(self):
        await self.ready()
        version = (await self.repository.state(self.song_id)).draft
        version.lyrics = lyrics(900, 500)
        self.assertIn("TIMING_INVALID", {i.code for i in content_issues(version)})
        version.lyrics = lyrics(0, 1000)
        version.lyrics["lines"].append({**lyrics(500, 900)["lines"][0]})
        self.assertIn("TIMING_OVERLAP", {i.code for i in content_issues(version)})
        version.lyrics = lyrics(0, 10000)
        self.assertIn("TIMING_OUT_OF_RANGE", {i.code for i in content_issues(version)})
        version.timed_audio_sha256 = "wrong"
        self.assertIn("TIMING_AUDIO_MISMATCH", {i.code for i in content_issues(version)})


class KaraokeStorageTests(unittest.TestCase):
    def test_current_and_legacy_info_sizes_are_verified(self):
        storage, bucket, song_id = KaraokeStorage(), MagicMock(), uuid4()
        path = f"songs/{song_id}/versions/{uuid4()}/audio/{uuid4()}.mp3"
        with patch.object(storage, "_bucket", return_value=bucket):
            for info in ({"size": 10, "content_type": "audio/mpeg"},
                         {"metadata": {"size": 10, "mimetype": "audio/mpeg"}}):
                bucket.info.return_value = info
                storage.verify(path, song_id, 10)
            for info in ({"size": 9}, {"name": "missing size"},
                         {"size": 10, "content_type": "text/plain"}):
                bucket.info.return_value = info
                with self.assertRaises(HTTPException) as caught:
                    storage.verify(path, song_id, 10)
                self.assertEqual(caught.exception.status_code, 503)

    def test_signed_url_must_identify_the_same_object(self):
        storage, bucket, song_id = KaraokeStorage(), MagicMock(), uuid4()
        path = f"songs/{song_id}/versions/{uuid4()}/audio/{uuid4()}.mp3"
        signed_path = "/storage/v1/object/sign/viread-karaoke/" + path
        with patch.object(storage, "_bucket", return_value=bucket), patch(
            "app.services.karaoke_storage_service.SUPABASE_URL", "https://example.supabase.co"
        ):
            bucket.create_signed_url.return_value = {"signedURL": signed_path + "?token=test"}
            self.assertEqual(storage.sign(path, song_id), "https://example.supabase.co" + signed_path + "?token=test")
            bucket.create_signed_url.return_value = {"signedURL": signed_path.replace(".mp3", "wrong.mp3") + "?token=test"}
            with self.assertRaises(HTTPException):
                storage.sign(path, song_id)

    def test_path_scope_and_external_urls_are_rejected(self):
        storage = KaraokeStorage()
        for path in ("https://example.test/audio.mp3", "../audio.mp3", "songs/x/audio.mp3"):
            with self.assertRaises(HTTPException):
                storage.validate_path(path, uuid4())
        song_id = uuid4()
        path = f"songs/{song_id}/versions/{uuid4()}/audio/{uuid4()}.mp3"
        storage.validate_path(path, song_id)
        with self.assertRaises(HTTPException):
            storage.validate_path(path, uuid4())

    def test_provider_exception_is_redacted_and_signed_url_origin_is_checked(self):
        storage, bucket, song_id = KaraokeStorage(), MagicMock(), uuid4()
        path = f"songs/{song_id}/versions/{uuid4()}/audio/{uuid4()}.mp3"
        with patch.object(storage, "_bucket", return_value=bucket):
            bucket.upload.side_effect = RuntimeError("private credential")
            with self.assertRaises(HTTPException) as caught:
                storage.upload(path, song_id, b"data", "audio/mpeg")
            self.assertNotIn("private credential", caught.exception.detail)
            bucket.create_signed_url.return_value = {"signedURL": "https://evil.test/secret"}
            with self.assertRaises(HTTPException):
                storage.sign(path, song_id)


class KaraokeApiTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router, prefix="/karaoke")
        self.client = TestClient(self.app)

    def test_all_thirteen_operations_require_authentication(self):
        for route in router.routes:
            method = next(iter(route.methods))
            path = "/karaoke" + route.path.replace("{song_id}", str(uuid4()))
            response = self.client.request(method, path, json={})
            self.assertEqual(response.status_code, 401, (method, path, response.text))

    def test_schema_and_service_response_contract(self):
        repository = MemoryRepository()
        self.app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        self.app.dependency_overrides[get_karaoke_service] = lambda: KaraokeService(repository, MemoryStorage(repository))
        created = self.client.post("/karaoke/admin/songs", json={"title": "Nhạc thử"})
        self.assertEqual(created.status_code, 201, created.text)
        data = created.json()
        self.assertEqual(data["revision"], 1)
        self.assertNotIn("audio_path", data["draft"])
        invalid = self.client.put(f"/karaoke/admin/songs/{data['song_id']}/draft", json={
            "expected_revision": 1, "draft_version_id": data["draft"]["id"], "audio_path": "injected",
        })
        self.assertEqual(invalid.status_code, 422)
        self.app.dependency_overrides[get_current_parent_id] = lambda: PARENT
        self.assertEqual(self.client.get(f"/karaoke/admin/songs/{data['song_id']}").status_code, 403)

    def test_database_errors_are_safe_503(self):
        db = MagicMock()
        db.rollback = AsyncMock()
        self.app.dependency_overrides[get_db] = lambda: db
        self.app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        with patch.object(KaraokeService, "create", new=AsyncMock(side_effect=SQLAlchemyError("private connection string"))):
            response = self.client.post("/karaoke/admin/songs", json={})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private connection string", response.text)

    def test_all_admin_routes_reject_parent_and_inactive_accounts(self):
        repository = MemoryRepository()
        self.app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        self.app.dependency_overrides[get_karaoke_service] = lambda: KaraokeService(repository, MemoryStorage(repository))
        detail = self.client.post("/karaoke/admin/songs", json={}).json()
        for actor in (PARENT, INACTIVE):
            self.app.dependency_overrides[get_current_parent_id] = lambda: actor
            for route in (route for route in router.routes if route.path.startswith("/admin/")):
                method = next(iter(route.methods))
                path = "/karaoke" + route.path.replace("{song_id}", detail["song_id"])
                payload = {"expected_revision": 1, "draft_version_id": detail["draft"]["id"]}
                if path.endswith("/visibility"):
                    payload = {"expected_revision": 1, "visible": False}
                if path == "/karaoke/admin/songs" or (path.endswith("/draft") and method == "POST"):
                    payload = {} if path.endswith("/songs") else {"expected_revision": 1}
                if method == "POST" and path.endswith(("/audio", "/cover", "/reference-audio")):
                    response = self.client.post(path, data={k: str(v) for k, v in payload.items()},
                                                files={"file": ("test.mp3", mp3_fixture(), "audio/mpeg")})
                else:
                    response = self.client.request(method, path, json=payload)
                self.assertEqual(response.status_code, 403, (actor, method, path, response.text))

    def test_http_multipart_draft_publish_playback_and_hide(self):
        repository = MemoryRepository()
        storage = MemoryStorage(repository)
        self.app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        self.app.dependency_overrides[get_karaoke_service] = lambda: KaraokeService(repository, storage)
        detail = self.client.post("/karaoke/admin/songs", json={}).json()
        base = f"/karaoke/admin/songs/{detail['song_id']}"
        response = self.client.post(base + "/draft/audio", data={
            "expected_revision": "1", "draft_version_id": detail["draft"]["id"],
        }, files={"file": ("fixture.mp3", mp3_fixture(), "audio/mpeg")})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["revision"], 2)
        self.assertEqual(self.client.get(base + "/draft/preview").status_code, 200)
        request = {"expected_revision": 2, "draft_version_id": detail["draft"]["id"]}
        response = self.client.put(base + "/draft", json={
            **request, "title": "Bài kiểm thử", "source_note": "Synthetic", "usage_note": "Tests only",
            "lyrics": lyrics(),
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.client.get(base + "/draft/validation").json()["valid"])
        response = self.client.post(base + "/publish", json={**request, "expected_revision": 3})
        self.assertEqual(response.status_code, 200, response.text)
        self.app.dependency_overrides[get_current_parent_id] = lambda: PARENT
        playback = f"/karaoke/songs/{detail['song_id']}/playback?child_id={CHILD}"
        self.assertEqual(self.client.get(playback).status_code, 200)
        self.app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        self.assertEqual(self.client.patch(base + "/visibility", json={
            "expected_revision": 4, "visible": False,
        }).status_code, 200)
        self.app.dependency_overrides[get_current_parent_id] = lambda: PARENT
        self.assertEqual(self.client.get(playback).status_code, 404)


class KaraokeRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_row_lock_and_cas_are_real_sql_and_rollback_on_failure(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        db.rollback = AsyncMock()
        db.flush = AsyncMock()
        db.execute = AsyncMock(return_value=MagicMock())
        db.commit = AsyncMock(side_effect=SQLAlchemyError("failure"))
        repository = KaraokeRepository(db)
        await repository.state(uuid4(), lock=True)
        self.assertIn("FOR UPDATE", str(db.scalar.await_args.args[0].compile(dialect=postgresql.dialect())))
        song = KaraokeSong(id=uuid4(), revision=4, created_at=utcnow(), updated_at=utcnow())
        await repository.bump(song, 4)
        statement = db.execute.await_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn("revision", str(statement))
        self.assertIn(4, statement.params.values())
        with self.assertRaises(SQLAlchemyError):
            async with repository.write():
                pass
        db.rollback.assert_awaited()


class KaraokeDifficultWordCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_catalog_matches_authentic_lyrics_sorts_first_and_never_mutates_lyrics(self):
        class CatalogMemoryRepository(MemoryRepository):
            def __init__(self, target_words):
                super().__init__()
                self._target_words = list(target_words)

            async def difficult_words(self, _child_id, _actor_id, *, limit=12):
                return self._target_words[:limit]

            async def list_states(self, *, search="", status=None, grade=None, limit=12, offset=0):
                del search, status
                published = []
                for song in self.songs.values():
                    if song.status != "PUBLISHED":
                        continue
                    version = self.versions.get(song.published_version_id)
                    if version is None or version.state != "PUBLISHED":
                        continue
                    if grade is not None and not (version.min_grade <= grade <= version.max_grade):
                        continue
                    published.append(SongState(song, None, version))
                return published[offset : offset + limit], len(published)

        repository = CatalogMemoryRepository(["ánh trăng", "sao sáng"])
        storage = MemoryStorage(repository)
        service = KaraokeService(repository, storage)

        # Song 1: no difficult word match
        s1 = await service.create(ADMIN, SongCreate(title="Chú mèo nhỏ"))
        s1 = await service.upload(
            ADMIN,
            s1.song_id,
            DraftRequest(expected_revision=s1.revision, draft_version_id=s1.draft.id),
            UploadFile(file=BytesIO(mp3_fixture()), filename="a.mp3"),
        )
        s1_lyrics = {
            "format_version": 1,
            "lines": [
                {
                    "id": str(uuid4()),
                    "text": "Chú mèo nhỏ đi dạo",
                    "start_ms": 0,
                    "end_ms": 2000,
                }
            ],
        }
        s1 = await service.save(
            ADMIN,
            s1.song_id,
            DraftWrite(
                expected_revision=s1.revision,
                draft_version_id=s1.draft.id,
                title="Chú mèo nhỏ",
                source_note="Public",
                usage_note="Tests",
                lyrics=s1_lyrics,
            ),
        )
        await service.publish(
            ADMIN,
            s1.song_id,
            DraftRequest(expected_revision=s1.revision, draft_version_id=s1.draft.id),
        )

        # Song 2: authentic lyrics match child's difficult words
        s2 = await service.create(ADMIN, SongCreate(title="Đêm trăng"))
        s2 = await service.upload(
            ADMIN,
            s2.song_id,
            DraftRequest(expected_revision=s2.revision, draft_version_id=s2.draft.id),
            UploadFile(file=BytesIO(mp3_fixture()), filename="b.mp3"),
        )
        s2_lyrics = {
            "format_version": 1,
            "lines": [
                {
                    "id": str(uuid4()),
                    "text": "Ánh trăng vàng bên sao sáng đêm rằm",
                    "start_ms": 0,
                    "end_ms": 2500,
                }
            ],
        }
        s2 = await service.save(
            ADMIN,
            s2.song_id,
            DraftWrite(
                expected_revision=s2.revision,
                draft_version_id=s2.draft.id,
                title="Đêm trăng",
                source_note="Public",
                usage_note="Tests",
                lyrics=s2_lyrics,
            ),
        )
        await service.publish(
            ADMIN,
            s2.song_id,
            DraftRequest(expected_revision=s2.revision, draft_version_id=s2.draft.id),
        )

        snapshot_1 = deepcopy(repository.versions[repository.songs[s1.song_id].published_version_id].lyrics)
        snapshot_2 = deepcopy(repository.versions[repository.songs[s2.song_id].published_version_id].lyrics)

        result = await service.list_songs(PARENT, CHILD)
        self.assertEqual(result.total, 2)
        self.assertEqual([item.song_id for item in result.items], [s2.song_id, s1.song_id])
        self.assertEqual(result.items[0].matched_difficult_words, ["ánh trăng", "sao sáng"])
        self.assertEqual(result.items[1].matched_difficult_words, [])

        # Authentic lyrics MUST remain byte-for-byte identical.
        self.assertEqual(
            repository.versions[repository.songs[s1.song_id].published_version_id].lyrics,
            snapshot_1,
        )
        self.assertEqual(
            repository.versions[repository.songs[s2.song_id].published_version_id].lyrics,
            snapshot_2,
        )


if __name__ == "__main__":
    unittest.main()
