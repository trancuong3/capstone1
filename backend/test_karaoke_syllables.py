"""Karaoke v2 contracts and publication; all media/accounts are isolated fixtures."""
from copy import deepcopy
from io import BytesIO
import unittest
from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from pydantic import ValidationError

from test_karaoke import ADMIN, PARENT, CHILD, MemoryRepository, MemoryStorage, lyrics, mp3_fixture
from app.schemas.karaoke import DraftRequest, DraftWrite, Lyrics, RevisionRequest, SongCreate
from app.services.karaoke_lyrics import timing_issues
from app.services.karaoke_service import KaraokeService
from app.api.deps import get_current_parent_id
from app.api.routes.karaoke import router, get_karaoke_service


def lyrics_v2():
    return {"format_version": 2, "lines": [{
        "id": str(uuid4()), "text": "Bé hát, vui!", "start_ms": 0, "end_ms": 1200,
        "syllables": [
            {"id": str(uuid4()), "text": "Bé", "start_ms": 0, "end_ms": 200},
            {"id": str(uuid4()), "text": "hát,", "start_ms": 350, "end_ms": 600},
            {"id": str(uuid4()), "text": "vui!", "start_ms": 650, "end_ms": 1200},
        ],
    }]}


class SyllableContractTests(unittest.TestCase):
    def test_roundtrip_v1_keeps_original_shape_and_v2_keeps_nested_ids(self):
        for data in (lyrics(), lyrics_v2()):
            parsed = Lyrics.model_validate(data)
            self.assertEqual(parsed.model_dump(mode="json"), data)
            nested = DraftWrite(expected_revision=1, draft_version_id=uuid4(), lyrics=parsed)
            self.assertEqual(nested.model_dump(mode="json")["lyrics"], data)

    def test_versions_are_strict_and_fields_match_version(self):
        for version in (True, "2", 2.0, 3):
            with self.subTest(version=version), self.assertRaises(ValidationError):
                Lyrics.model_validate({**lyrics_v2(), "format_version": version})
        for data in ({**lyrics_v2(), "format_version": 1}, {**lyrics(), "format_version": 2}):
            with self.assertRaises(ValidationError):
                Lyrics.model_validate(data)

    def test_nested_ids_times_and_size_are_bounded(self):
        for value in (True, "5", 1.2, -1, 300001):
            data = lyrics_v2()
            data["lines"][0]["syllables"][0]["start_ms"] = value
            with self.subTest(value=value), self.assertRaises(ValidationError):
                Lyrics.model_validate(data)
        data = lyrics_v2()
        data["lines"][0]["syllables"][1]["id"] = data["lines"][0]["id"]
        with self.assertRaises(ValidationError):
            Lyrics.model_validate(data)
        data = lyrics_v2()
        data["lines"][0]["syllables"] *= 51
        with self.assertRaises(ValidationError):
            Lyrics.model_validate(data)

    def test_normalization_gap_and_long_syllable_are_valid(self):
        data = lyrics_v2()
        data["lines"][0]["text"] = "Be\u0301  hát,\u00a0vui!"
        self.assertEqual(timing_issues(Lyrics.model_validate(data), 1200), [])

    def test_total_syllable_count_and_text_limits(self):
        def unit(text):
            return {"id": str(uuid4()), "text": text, "start_ms": None, "end_ms": None}
        for lines in (
            [{"id": str(uuid4()), "text": "a", "syllables": [unit("a") for _ in range(150)]} for _ in range(67)],
            [{"id": str(uuid4()), "text": "a", "syllables": [unit("a" * 300) for _ in range(150)]} for _ in range(2)],
        ):
            with self.assertRaises(ValidationError):
                Lyrics.model_validate({"format_version": 2, "lines": lines})

    def test_semantic_errors_point_to_syllable_and_incomplete_draft_is_accepted(self):
        for patch, code in (({"start_ms": None}, "TIMING_REQUIRED"),
                            ({"start_ms": 150}, "TIMING_OVERLAP"),
                            ({"end_ms": 1300}, "TIMING_OUT_OF_RANGE"),
                            ({"start_ms": 600}, "TIMING_INVALID")):
            data = lyrics_v2()
            unit = data["lines"][0]["syllables"][1]
            unit.update(patch)
            found = timing_issues(Lyrics.model_validate(data), 1200)
            match = next(issue for issue in found if issue.code == code)
            self.assertEqual(str(match.syllable_id), unit["id"])
            self.assertEqual(str(match.line_id), data["lines"][0]["id"])
        data = lyrics_v2()
        data["lines"][0]["syllables"][0]["text"] = "Sai"
        self.assertIn("SYLLABLE_TEXT_MISMATCH", {i.code for i in timing_issues(Lyrics.model_validate(data), 1200)})
        data["lines"][0]["syllables"] = []
        self.assertIn("SYLLABLES_REQUIRED", {i.code for i in timing_issues(Lyrics.model_validate(data), 1200)})


class SyllableServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repo = MemoryRepository()
        self.storage = MemoryStorage(self.repo)
        self.service = KaraokeService(self.repo, self.storage)
        detail = await self.service.create(ADMIN, SongCreate(title="Syllable test only"))
        self.song = detail.song_id
        self.detail = await self.service.upload(ADMIN, self.song, self.request(detail),
            UploadFile(file=BytesIO(mp3_fixture()), filename="fixture.mp3"))

    def request(self, detail):
        return DraftRequest(expected_revision=detail.revision, draft_version_id=detail.draft.id)

    async def save(self, data, detail=None):
        detail = detail or self.detail
        return await self.service.save(ADMIN, self.song, DraftWrite(
            **self.request(detail).model_dump(), title="Syllable test only", source_note="Fixture",
            usage_note="Test only", lyrics=data))

    async def test_incomplete_v2_can_be_saved_and_previewed_but_not_published(self):
        data = lyrics_v2()
        data["lines"][0]["syllables"][1]["start_ms"] = None
        saved = await self.save(data)
        self.assertEqual((await self.service.preview(ADMIN, self.song)).lyrics.format_version, 2)
        validation = await self.service.validation(ADMIN, self.song)
        self.assertFalse(validation.valid)
        self.assertEqual(str(next(i for i in validation.issues if i.syllable_id).syllable_id), data["lines"][0]["syllables"][1]["id"])
        with self.assertRaises(HTTPException) as caught:
            await self.service.publish(ADMIN, self.song, self.request(saved))
        self.assertEqual(caught.exception.status_code, 422)

    async def test_publish_roundtrip_snapshot_expected_version_and_stale_writes(self):
        data = lyrics_v2()
        ready = await self.save(data)
        published = await self.service.publish(ADMIN, self.song, self.request(ready))
        playback = await self.service.playback(PARENT, self.song, CHILD, published.published.id)
        self.assertEqual(playback.model_dump(mode="json")["lyrics"], data)
        self.assertNotIn("source_note", playback.model_dump())
        draft = await self.service.draft(ADMIN, self.song, RevisionRequest(expected_revision=published.revision))
        changed = deepcopy(data)
        changed["lines"][0]["syllables"][0]["end_ms"] = 100
        await self.save(changed, draft)
        self.assertEqual((await self.service.playback(PARENT, self.song, CHILD)).model_dump(mode="json")["lyrics"], data)
        with self.assertRaises(HTTPException) as caught:
            await self.save(changed, draft)
        self.assertEqual(caught.exception.status_code, 409)

    async def test_replace_audio_clears_all_marks_preserving_v2_and_published_copy(self):
        data = lyrics_v2()
        saved = await self.save(data)
        pub = await self.service.publish(ADMIN, self.song, self.request(saved))
        draft = await self.service.draft(ADMIN, self.song, RevisionRequest(expected_revision=pub.revision))
        replaced = await self.service.upload(ADMIN, self.song, self.request(draft),
            UploadFile(file=BytesIO(mp3_fixture()), filename="replacement.mp3"))
        result = replaced.draft.lyrics.model_dump(mode="json")
        self.assertEqual(result["format_version"], 2)
        line = result["lines"][0]
        self.assertIsNone(line["start_ms"])
        self.assertIsNone(line["end_ms"])
        self.assertEqual([s["id"] for s in line["syllables"]], [s["id"] for s in data["lines"][0]["syllables"]])
        self.assertTrue(all(s["start_ms"] is None and s["end_ms"] is None for s in line["syllables"]))
        self.assertIsNone((await self.repo.state(self.song)).draft.timed_audio_sha256)
        self.assertEqual((await self.service.playback(PARENT, self.song, CHILD)).model_dump(mode="json")["lyrics"], data)

    async def test_cover_upload_keeps_v2_timings(self):
        from PIL import Image
        ready = await self.save(lyrics_v2())
        image = BytesIO()
        Image.new("RGB", (8, 8), "red").save(image, "PNG")
        result = await self.service.upload(ADMIN, self.song, self.request(ready),
            UploadFile(file=BytesIO(image.getvalue()), filename="cover.png"), cover=True)
        self.assertEqual(result.draft.lyrics, ready.draft.lyrics)
        self.assertTrue((await self.service.validation(ADMIN, self.song)).valid)


class SyllableApiTests(unittest.TestCase):
    def test_http_v2_save_validate_publish_and_playback(self):
        repo = MemoryRepository()
        service = KaraokeService(repo, MemoryStorage(repo))
        app = FastAPI()
        app.include_router(router, prefix="/karaoke")
        app.dependency_overrides[get_karaoke_service] = lambda: service
        app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        with TestClient(app) as client:
            detail = client.post("/karaoke/admin/songs", json={}).json()
            base = f"/karaoke/admin/songs/{detail['song_id']}"
            req = {"expected_revision": 1, "draft_version_id": detail["draft"]["id"]}
            upload = client.post(base + "/draft/audio", data=req,
                files={"file": ("synthetic.mp3", mp3_fixture(), "audio/mpeg")})
            self.assertEqual(upload.status_code, 200, upload.text)
            data = lyrics_v2()
            save = client.put(base + "/draft", json={**req, "expected_revision": 2,
                "title": "V2 API fixture", "source_note": "Test", "usage_note": "Tests only", "lyrics": data})
            self.assertEqual(save.status_code, 200, save.text)
            self.assertEqual(save.json()["draft"]["lyrics"], data)
            self.assertEqual(client.get(base + "/draft/preview").json()["lyrics"], data)
            self.assertTrue(client.get(base + "/draft/validation").json()["valid"])
            pub = client.post(base + "/publish", json={**req, "expected_revision": 3})
            self.assertEqual(pub.status_code, 200, pub.text)
            app.dependency_overrides[get_current_parent_id] = lambda: PARENT
            result = client.get(f"/karaoke/songs/{detail['song_id']}/playback?child_id={CHILD}")
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["lyrics"], data)
