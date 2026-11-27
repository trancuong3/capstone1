"""Tests for Admin Karaoke One-File Simple Mode (ID3v2, LRC, Groq Whisper, Safe Publish)."""
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from contextlib import asynccontextmanager
from io import BytesIO
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from mutagen.id3 import APIC, ID3, SYLT, TCOM, TIT2, TPE1, USLT
from PIL import Image

from app.api.deps import require_admin_id
from app.api.routes.karaoke_simple_import import (
    get_karaoke_simple_import_service,
    router as simple_import_router,
)
from app.core.karaoke_processing_config import KaraokeProcessingConfig
from app.models.karaoke import utcnow
from app.schemas.karaoke import Lyrics
from app.schemas.karaoke_processing import JobRead
from app.services.karaoke_lyrics import timing_issues
from app.services.karaoke_media_service import (
    clean_filename_title,
    extract_mp3_metadata,
    parse_lrc_text,
)
from app.services.karaoke_simple_import_service import (
    KaraokeSimpleImportService,
    map_whisper_verbose_json,
    resolve_simple_lifecycle_state,
    transcribe_with_groq_whisper,
)
from test_karaoke import ADMIN, MemoryRepository, MemoryStorage, PARENT, mp3_fixture


def _png_bytes(width: int = 32, height: int = 32) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (width, height), (40, 140, 220)).save(buf, format="PNG")
    return buf.getvalue()


def _mp3_with_id3(
    *,
    frames: int = 200,
    title: str | None = None,
    artist: str | None = None,
    composer: str | None = None,
    cover_bytes: bytes | None = None,
    cover_mime: str = "image/png",
    uslt_text: str | None = None,
    sylt_entries: list[tuple[str, int]] | None = None,
) -> bytes:
    raw_mp3 = mp3_fixture(frames=frames)
    tags = ID3()
    if title is not None:
        tags.add(TIT2(encoding=3, text=[title]))
    if artist is not None:
        tags.add(TPE1(encoding=3, text=[artist]))
    if composer is not None:
        tags.add(TCOM(encoding=3, text=[composer]))
    if cover_bytes is not None:
        tags.add(
            APIC(
                encoding=3,
                mime=cover_mime,
                type=3,
                desc="Cover",
                data=cover_bytes,
            )
        )
    if uslt_text is not None:
        tags.add(USLT(encoding=3, lang="vie", desc="", text=uslt_text))
    if sylt_entries is not None:
        tags.add(
            SYLT(
                encoding=3,
                lang="vie",
                format=2,
                type=1,
                desc="Synced",
                text=sylt_entries,
            )
        )
    header = BytesIO()
    tags.save(header, v2_version=3)
    return header.getvalue() + raw_mp3


class Mp3MetadataAndLrcTests(unittest.TestCase):
    def test_clean_filename_strips_extension_track_prefix_and_noise(self):
        self.assertEqual(
            clean_filename_title("01_Chau_Len_Ba_(Official_Audio)_[320kbps].mp3"),
            "Chau Len Ba",
        )
        self.assertEqual(
            clean_filename_title("C:\\music\\02 - Con Cò Bé Bé (Karaoke).mp3"),
            "Con Cò Bé Bé",
        )

    def test_extract_mp3_metadata_reads_tit2_tpe1_apic_uslt_sylt(self):
        data = _mp3_with_id3(
            frames=240,
            title="Cháu lên ba",
            artist="Phạm Tuyên",
            cover_bytes=_png_bytes(),
            uslt_text="Cháu lên ba\nCháu đi mẫu giáo",
            sylt_entries=[
                ("Cháu lên ba", 400),
                ("Cháu đi mẫu giáo", 2800),
            ],
        )
        meta = extract_mp3_metadata(data, "fallback_name.mp3")
        self.assertEqual(meta["title"], "Cháu lên ba")
        self.assertEqual(meta["author"], "Phạm Tuyên")
        self.assertGreater(meta["duration_ms"], 5000)
        self.assertEqual(meta["cover_mime"], "image/webp")
        self.assertIsNotNone(meta["cover_bytes"])
        with Image.open(BytesIO(meta["cover_bytes"])) as img:
            self.assertEqual(img.format, "WEBP")
        self.assertIn("Cháu lên ba", meta["unsynced_lyrics"])

        synced = meta["synced_lyrics"]
        self.assertIsNotNone(synced)
        self.assertEqual(synced["format_version"], 1)
        self.assertEqual(len(synced["lines"]), 2)
        self.assertEqual(synced["lines"][0]["text"], "Cháu lên ba")
        self.assertEqual(synced["lines"][0]["start_ms"], 400)
        self.assertEqual(synced["lines"][0]["end_ms"], 2800)
        validated = Lyrics.model_validate(synced)
        self.assertEqual(timing_issues(validated, meta["duration_ms"]), [])

    def test_extract_mp3_metadata_parses_lrc_inside_uslt_and_tcom_fallback(self):
        lrc = (
            "[ti:Bắc Kim Thang]\n"
            "[00:00.50]Bắc kim thang cà lang bí rợ\n"
            "[00:03.20]Cột qua kèo là kèo qua cột\n"
        )
        data = _mp3_with_id3(
            frames=240,
            composer="Dân ca Nam Bộ",
            cover_bytes=b"not-a-valid-image",
            uslt_text=lrc,
        )
        meta = extract_mp3_metadata(data, "03_Bac_Kim_Thang_[HQ].mp3")
        self.assertEqual(meta["title"], "Bac Kim Thang")
        self.assertEqual(meta["author"], "Dân ca Nam Bộ")
        # Corrupt APIC must be ignored safely without failing MP3 import.
        self.assertIsNone(meta["cover_bytes"])
        self.assertIsNone(meta["cover_mime"])
        self.assertEqual(meta["synced_lyrics_source"], "USLT_LRC")
        synced = meta["synced_lyrics"]
        self.assertIsNotNone(synced)
        self.assertEqual(synced["format_version"], 1)
        self.assertEqual(len(synced["lines"]), 2)
        self.assertEqual(synced["lines"][0]["start_ms"], 500)
        self.assertEqual(synced["lines"][1]["start_ms"], 3200)

    def test_parse_lrc_text_returns_syllable_timed_lyrics_with_honest_confidence(self):
        lrc = (
            "[ar:Phạm Tuyên]\n"
            "[offset:100]\n"
            "[00:01.00]Em yêu trường em\n"
            "[00:04.50]Với bao bạn thân\n"
        )
        parsed = parse_lrc_text(lrc, duration_ms=9000)
        self.assertEqual(parsed["format_version"], 2)
        self.assertEqual(parsed["line_count"], 2)
        self.assertEqual(parsed["confidence"]["overall"], "HIGH")
        self.assertEqual(parsed["confidence"]["line_starts"], "EXACT_LRC")
        self.assertEqual(parsed["confidence"]["syllables"], "PROPORTIONAL_ESTIMATE")
        validated = Lyrics.model_validate(parsed["lyrics"])
        self.assertEqual(timing_issues(validated, 9000), [])
        self.assertEqual(validated.lines[0].start_ms, 1100)
        self.assertEqual(validated.lines[0].end_ms, 4600)
        self.assertEqual(
            [s.text for s in validated.lines[0].syllables],
            ["Em", "yêu", "trường", "em"],
        )


class WhisperMappingTests(unittest.IsolatedAsyncioTestCase):
    async def test_groq_whisper_maps_words_and_flags_low_confidence_segments(self):
        mock_payload = {
            "text": "Cháu lên ba\nĐoạn hát hơi nhỏ\nTiếng ồn nền",
            "segments": [
                {
                    "id": 0,
                    "start": 0.2,
                    "end": 2.4,
                    "text": " Cháu lên ba",
                    "avg_logprob": -0.18,
                    "no_speech_prob": 0.04,
                },
                {
                    "id": 1,
                    "start": 2.4,
                    "end": 4.6,
                    "text": " Đoạn hát hơi nhỏ",
                    "avg_logprob": -0.82,
                    "no_speech_prob": 0.12,
                },
                {
                    "id": 2,
                    "start": 4.7,
                    "end": 6.0,
                    "text": " Tiếng ồn nền",
                    "avg_logprob": -0.35,
                    "no_speech_prob": 0.68,
                },
            ],
            "words": [
                {"word": "Cháu", "start": 0.2, "end": 0.8},
                {"word": "lên", "start": 0.85, "end": 1.4},
                {"word": "ba", "start": 1.45, "end": 2.3},
            ],
        }

        class FakeResponse:
            status_code = 200

            def json(self):
                return mock_payload

        fake_client = AsyncMock()
        fake_client.post = AsyncMock(return_value=FakeResponse())

        with patch.dict(
            os.environ,
            {
                "GROQ_API_KEY": "test-groq-key-never-logged",
                "KARAOKE_ADMIN_GROQ_LYRICS_ENABLED": "true",
            },
            clear=False,
        ):
            result = await transcribe_with_groq_whisper(
                mp3_fixture(frames=240),
                "song.mp3",
                6200,
                http_client=fake_client,
            )

        self.assertIsNotNone(result)
        lyrics_dict, flagged = result
        self.assertEqual(lyrics_dict["format_version"], 2)
        self.assertEqual(len(lyrics_dict["lines"]), 3)
        validated = Lyrics.model_validate(lyrics_dict)
        self.assertEqual(timing_issues(validated, 6200), [])

        # High-confidence line 0 must NOT be flagged; lines 1 and 2 MUST be flagged NEEDS_REVIEW.
        self.assertEqual(len(flagged), 2)
        self.assertEqual([f.line_index for f in flagged], [1, 2])
        self.assertTrue(all(f.flag == "NEEDS_REVIEW" for f in flagged))
        self.assertAlmostEqual(flagged[0].avg_logprob, -0.82)
        self.assertAlmostEqual(flagged[1].no_speech_prob, 0.68)

        # Verify request hit Groq OpenAI-compatible transcriptions endpoint.
        call_args = fake_client.post.call_args
        self.assertIn("api.groq.com/openai/v1/audio/transcriptions", call_args.args[0])

    def test_map_whisper_handles_overlapping_segments_without_timing_errors(self):
        payload = {
            "segments": [
                {"start": 0.0, "end": 2.0, "text": "Câu một", "avg_logprob": -0.2, "no_speech_prob": 0.01},
                {"start": 1.5, "end": 4.0, "text": "Câu hai", "avg_logprob": -0.2, "no_speech_prob": 0.01},
            ]
        }
        lyrics_dict, flagged = map_whisper_verbose_json(payload, 3500)
        self.assertEqual(flagged, [])
        validated = Lyrics.model_validate(lyrics_dict)
        self.assertEqual(timing_issues(validated, 3500), [])


class FakeProcessingRepo:
    """In-memory stand-in for KaraokeProcessingRepository (status, ledger, stale)."""

    def __init__(self):
        self.jobs = {}
        self.ops = {}

    @asynccontextmanager
    async def read(self):
        yield

    async def latest_summaries(self, song_ids):
        out = {}
        for sid in song_ids:
            matching = [j for j in self.jobs.values() if j.song_id == sid]
            if matching:
                matching.sort(key=lambda j: j.created_at, reverse=True)
                out[sid] = matching[0]
        return out

    async def get(self, job_id, song_id):
        job = self.jobs.get(job_id)
        if job is not None and job.song_id == song_id:
            return job
        return None

    async def operations(self, job_id):
        return list(self.ops.get(job_id, []))

    async def outstanding(self, draft_version_id, *, lock=False):
        for job in self.jobs.values():
            if job.draft_version_id == draft_version_id and job.status in {"QUEUED", "RUNNING"}:
                return job
        return None

    @staticmethod
    def stale(job):
        job.status = "STALE"


class FakeProcessingService:
    """Non-blocking pipeline stand-in mirroring KaraokeProcessingService contracts."""

    def __init__(self, karaoke_repo, karaoke_service):
        self.karaoke_repo = karaoke_repo
        self.karaoke = karaoke_service
        self.repository = FakeProcessingRepo()
        self.replayed = False
        self._intents = {}
        self.started_requests = []

    @staticmethod
    def _dto(job):
        return JobRead(
            id=job.id,
            song_id=job.song_id,
            draft_version_id=job.draft_version_id,
            base_revision=job.base_revision,
            mode=job.mode,
            source_kind=job.source_kind,
            status=job.status,
            stage=job.stage,
            input_fingerprint=job.input_fingerprint,
            created_at=job.created_at,
            updated_at=job.updated_at,
            finished_at=job.finished_at,
            applied_at=job.applied_at,
            applied_revision=job.applied_revision,
            safe_error_code=job.safe_error_code,
            retry_policy=job.retry_policy,
            can_apply=job.status in {"READY", "NEEDS_REVIEW"},
            quality_flags=[],
        )

    async def start(self, actor_id, song_id, req):
        intent_key = (song_id, req.draft_version_id, req.idempotency_key)
        if intent_key in self._intents:
            self.replayed = True
            return self._dto(self.repository.jobs[self._intents[intent_key]])
        state = await self.karaoke_repo.state(song_id)
        if not state or not state.draft or state.draft.id != req.draft_version_id:
            raise HTTPException(409, "STALE_INPUT")
        if state.song.revision != req.expected_revision:
            raise HTTPException(409, "REVISION_CONFLICT")
        lyrics = Lyrics.model_validate(state.draft.lyrics)
        if lyrics.format_version != 2 or not lyrics.lines or any(not line.syllables for line in lyrics.lines):
            raise HTTPException(422, "INVALID_LYRICS")

        now = utcnow()
        job = SimpleNamespace(
            id=uuid4(),
            song_id=song_id,
            draft_version_id=req.draft_version_id,
            base_revision=req.expected_revision,
            mode=req.mode,
            source_kind=req.source_kind,
            status="QUEUED",
            stage="QUEUED",
            input_fingerprint="a" * 64,
            created_at=now,
            updated_at=now,
            finished_at=None,
            applied_at=None,
            applied_revision=None,
            safe_error_code=None,
            retry_policy="SAFE_RETRY",
            provenance={"pitch_contour": [{"t_ms": 500, "midi": 64.0}]},
            lyrics_result=state.draft.lyrics,
            result_audio_duration_ms=state.draft.duration_ms,
            input_duration_ms=state.draft.duration_ms,
            error_code=None,
        )
        self.repository.jobs[job.id] = job
        self._intents[intent_key] = job.id
        self.replayed = False
        self.started_requests.append(req)
        return self._dto(job)

    async def get(self, actor_id, song_id, job_id):
        job = await self.repository.get(job_id, song_id)
        if job is None:
            raise HTTPException(404, "JOB_NOT_FOUND")
        return self._dto(job)

    async def apply_result(self, actor_id, song_id, job_id, req):
        async with self.karaoke_repo.write():
            state = await self.karaoke_repo.state(song_id, lock=True)
            if not state or not state.draft or state.draft.id != req.draft_version_id:
                raise HTTPException(409, "STALE_INPUT")
            if state.song.revision != req.expected_revision:
                raise HTTPException(409, "REVISION_CONFLICT")
            job = await self.repository.get(job_id, song_id)
            if job is None:
                raise HTTPException(404, "JOB_NOT_FOUND")
            state.draft.requires_processing_review = True
            state.draft.reviewed_at = None
            state.draft.origin_job_id = job_id
            await self.karaoke_repo.bump(state.song, req.expected_revision)
            now = utcnow()
            job.status = "APPLIED"
            job.stage = "COMPLETE"
            job.updated_at = now
            job.finished_at = now
            job.applied_at = now
            job.applied_revision = state.song.revision
        return await self.karaoke.detail(actor_id, song_id)


class SimpleImportAndPublishApiTests(unittest.TestCase):
    def _build_client(
        self,
        *,
        actor_id=ADMIN,
        transcriber=None,
        processing_service=None,
        processing_config=None,
        worker_online_probe=None,
    ):
        repo = MemoryRepository()
        storage = MemoryStorage(repo)
        service = KaraokeSimpleImportService(
            repo,
            storage,
            transcriber=transcriber,
            processing_service=processing_service,
            processing_config=processing_config,
            worker_online_probe=worker_online_probe,
        )
        if processing_service is not None:
            service.karaoke.processing = processing_service.repository
        app = FastAPI()
        app.include_router(simple_import_router, prefix="/api/v1/karaoke")
        app.dependency_overrides[require_admin_id] = lambda: actor_id

        async def _override_service():
            yield service

        app.dependency_overrides[get_karaoke_simple_import_service] = _override_service
        return TestClient(app), repo, storage, service

    def test_simple_import_embedded_id3_cover_and_sylt_then_safe_publish(self):
        client, _, storage, _ = self._build_client()
        mp3_bytes = _mp3_with_id3(
            frames=240,
            title="Con cò bé bé",
            artist="Xuân Mai",
            cover_bytes=_png_bytes(),
            sylt_entries=[
                ("Con cò bé bé", 300),
                ("Nó đậu cành tre", 2600),
            ],
        )

        resp = client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("con_co.mp3", mp3_bytes, "audio/mpeg")},
            data={"audio_type": "VOCAL_FULL", "bpm": "116"},
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        body = resp.json()
        self.assertEqual(body["title"], "Con cò bé bé")
        self.assertEqual(body["author"], "Xuân Mai")
        self.assertTrue(body["has_cover"])
        self.assertEqual(body["lyrics_source"], "EMBEDDED_SYNCED")
        self.assertEqual(body["lyrics_line_count"], 2)
        self.assertEqual(body["flagged_lines"], [])
        self.assertFalse(body["requires_lyrics_input"])
        self.assertFalse(body["ready_to_publish"])
        self.assertIn("RIGHTS_CONFIRMATION_REQUIRED", body["missing_checks"])
        self.assertIn("CHILD_SAFE_CONFIRMATION_REQUIRED", body["missing_checks"])
        self.assertEqual(len(storage.objects), 2)  # MP3 + WebP cover

        song_id = body["song_id"]
        version_id = body["version_id"]
        revision = body["revision"]

        # Publish MUST be blocked if checkboxes are unchecked!
        blocked_rights = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-publish",
            json={
                "expected_revision": revision,
                "draft_version_id": version_id,
                "rights_confirmed": False,
                "child_safe_confirmed": True,
                "source_note": "Nhạc thiếu nhi dân gian",
                "usage_note": "Giáo dục lớp 1-5",
            },
        )
        self.assertEqual(blocked_rights.status_code, 422)

        blocked_safe = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-publish",
            json={
                "expected_revision": revision,
                "draft_version_id": version_id,
                "rights_confirmed": True,
                "child_safe_confirmed": False,
                "source_note": "Nhạc thiếu nhi dân gian",
                "usage_note": "Giáo dục lớp 1-5",
            },
        )
        self.assertEqual(blocked_safe.status_code, 422)

        # Publish MUST be blocked if source_note or usage_note is empty!
        blocked_notes = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-publish",
            json={
                "expected_revision": revision,
                "draft_version_id": version_id,
                "rights_confirmed": True,
                "child_safe_confirmed": True,
                "source_note": "",
                "usage_note": "Giáo dục lớp 1-5",
            },
        )
        self.assertEqual(blocked_notes.status_code, 422)

        # Publish MUST succeed when both confirmations + notes are provided!
        ok_pub = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-publish",
            json={
                "expected_revision": revision,
                "draft_version_id": version_id,
                "rights_confirmed": True,
                "child_safe_confirmed": True,
                "source_note": "Nhạc thiếu nhi dân gian",
                "usage_note": "Giáo dục lớp 1-5",
            },
        )
        self.assertEqual(ok_pub.status_code, 200, ok_pub.text)
        published = ok_pub.json()
        self.assertEqual(published["status"], "PUBLISHED")
        self.assertIsNone(published["draft"])
        self.assertEqual(published["published"]["title"], "Con cò bé bé")
        self.assertEqual(published["published"]["source_note"], "Nhạc thiếu nhi dân gian")

    def test_simple_import_instrumental_never_calls_whisper_and_guides_admin(self):
        transcriber = AsyncMock()
        client, _, _, _ = self._build_client(transcriber=transcriber)
        mp3_bytes = mp3_fixture(frames=200)

        resp = client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("nhac_nen_beat.mp3", mp3_bytes, "audio/mpeg")},
            data={
                "audio_type": "INSTRUMENTAL_ONLY",
                "auto_transcribe": "true",
            },
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        body = resp.json()
        transcriber.assert_not_called()
        self.assertEqual(body["audio_type"], "INSTRUMENTAL_ONLY")
        self.assertEqual(body["lyrics_source"], "NONE")
        self.assertTrue(body["requires_lyrics_input"])
        self.assertFalse(body["ready_to_publish"])
        self.assertIn("LYRICS_REQUIRED", body["missing_checks"])

        # Attempting to publish instrumental draft with empty lyrics MUST be blocked by KaraokeService.publish!
        blocked = client.post(
            f"/api/v1/karaoke/admin/songs/{body['song_id']}/simple-publish",
            json={
                "expected_revision": body["revision"],
                "draft_version_id": body["version_id"],
                "rights_confirmed": True,
                "child_safe_confirmed": True,
                "source_note": "Beat nội bộ",
                "usage_note": "Giáo dục lớp 1-5",
            },
        )
        self.assertEqual(blocked.status_code, 422)

    def test_simple_import_groq_whisper_flags_low_confidence_for_review(self):
        async def fake_transcriber(audio_bytes, filename, duration_ms):
            return map_whisper_verbose_json(
                {
                    "segments": [
                        {
                            "start": 0.2,
                            "end": 2.0,
                            "text": "Một con vịt xòe ra hai cái cánh",
                            "avg_logprob": -0.2,
                            "no_speech_prob": 0.05,
                        },
                        {
                            "start": 2.1,
                            "end": 4.2,
                            "text": "Nó kêu rằng quác quác",
                            "avg_logprob": -0.95,
                            "no_speech_prob": 0.1,
                        },
                    ]
                },
                duration_ms,
            )

        client, _, _, _ = self._build_client(transcriber=fake_transcriber)
        mp3_bytes = mp3_fixture(frames=200)
        resp = client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("mot_con_vit.mp3", mp3_bytes, "audio/mpeg")},
            data={"audio_type": "VOCAL_FULL", "auto_transcribe": "true"},
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        body = resp.json()
        self.assertEqual(body["lyrics_source"], "GROQ_WHISPER")
        self.assertEqual(body["lyrics_line_count"], 2)
        self.assertEqual(len(body["flagged_lines"]), 1)
        self.assertEqual(body["flagged_lines"][0]["flag"], "NEEDS_REVIEW")
        self.assertEqual(body["flagged_lines"][0]["line_index"], 1)

    def test_simple_import_plain_lyrics_flags_timing_check_and_rejects_non_admin(self):
        # Non-admin actor is rejected with 403.
        non_admin_client, _, _, _ = self._build_client(actor_id=PARENT)
        forbidden = non_admin_client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("song.mp3", mp3_fixture(frames=200), "audio/mpeg")},
        )
        self.assertEqual(forbidden.status_code, 403)

        # Admin plain text lyrics get evenly distributed timings + NEEDS_TIMING_CHECK flags.
        admin_client, _, _, _ = self._build_client(actor_id=ADMIN)
        resp = admin_client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("song.mp3", mp3_fixture(frames=200), "audio/mpeg")},
            data={"lyrics_text": "Ba thương con vì con giống mẹ\nMẹ thương con vì con giống ba"},
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        body = resp.json()
        self.assertEqual(body["lyrics_source"], "ADMIN_TEXT")
        self.assertEqual(body["lyrics_line_count"], 2)
        self.assertEqual(len(body["flagged_lines"]), 2)
        self.assertTrue(
            all(f["flag"] == "NEEDS_TIMING_CHECK" for f in body["flagged_lines"])
        )

    def test_simple_import_auto_queues_background_job_when_worker_online(self):
        client, repo, _, service = self._build_client(
            worker_online_probe=lambda: True,
        )
        proc = FakeProcessingService(repo, service.karaoke)
        service._explicit_processing_service = proc
        service.karaoke.processing = proc.repository

        mp3_bytes = _mp3_with_id3(
            frames=240,
            title="Cháu lên ba",
            artist="Xuân Mai",
            sylt_entries=[("Cháu lên ba", 300), ("Cháu đi mẫu giáo", 2600)],
        )
        resp = client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("chau_len_ba.mp3", mp3_bytes, "audio/mpeg")},
            data={"audio_type": "VOCAL_FULL", "bpm": "112"},
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        body = resp.json()
        self.assertTrue(body["worker_online"])
        self.assertTrue(body["processing_queued"])
        self.assertIsNotNone(body["processing_job_id"])
        self.assertEqual(body["bpm"], 112.0)
        self.assertEqual(body["lifecycle_state"], "QUEUED")
        self.assertIn("PROCESSING_IN_PROGRESS", body["missing_checks"])
        self.assertFalse(body["ready_to_publish"])

        song_id = body["song_id"]
        version_id = body["version_id"]
        job_id = body["processing_job_id"]
        from uuid import UUID as _UUID

        job_obj = proc.repository.jobs[_UUID(job_id)]

        # Initial poll -> QUEUED + beat grid/BPM derived from lyrics
        status_queued = client.get(f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing")
        self.assertEqual(status_queued.status_code, 200, status_queued.text)
        q_data = status_queued.json()
        self.assertEqual(q_data["lifecycle_state"], "QUEUED")
        self.assertTrue(q_data["has_beat_grid"])
        self.assertIsNotNone(q_data["bpm"])
        self.assertGreater(q_data["bpm"], 0)

        # Simulate worker progress: SEPARATING_AUDIO -> ALIGNING_LYRICS -> ANALYZING_MELODY -> READY
        job_obj.status = "RUNNING"
        job_obj.stage = "PREPARING_AUDIO"
        proc.repository.ops[job_obj.id] = [SimpleNamespace(step_key="SEPARATE_STEMS", state="SUBMITTED")]
        self.assertEqual(
            client.get(f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing").json()["lifecycle_state"],
            "SEPARATING_AUDIO",
        )

        job_obj.stage = "ALIGNING_LYRICS"
        proc.repository.ops[job_obj.id] = [SimpleNamespace(step_key="ALIGN_PROVIDED_LYRICS", state="SUBMITTED")]
        self.assertEqual(
            client.get(f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing").json()["lifecycle_state"],
            "ALIGNING_LYRICS",
        )

        job_obj.stage = "VALIDATING_RESULT"
        job_obj.provenance = {"analysis_phase": "MELODY", "pitch_contour": [{"t_ms": 500, "midi": 65.0}]}
        proc.repository.ops[job_obj.id] = [SimpleNamespace(step_key="ANALYZE_MELODY", state="PREPARED")]
        self.assertEqual(
            client.get(f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing").json()["lifecycle_state"],
            "ANALYZING_MELODY",
        )

        job_obj.status = "READY"
        job_obj.stage = "COMPLETE"
        ready_data = client.get(f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing").json()
        self.assertEqual(ready_data["lifecycle_state"], "READY_FOR_REVIEW")
        self.assertTrue(ready_data["can_apply"])

        # Apply processing result to draft -> review stays required (no publish bypass)
        applied = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing/apply",
            json={
                "expected_revision": ready_data["revision"],
                "draft_version_id": version_id,
                "job_id": job_id,
                "audio_type": "VOCAL_FULL",
                "bpm": 112.0,
            },
        )
        self.assertEqual(applied.status_code, 200, applied.text)
        applied_data = applied.json()
        self.assertTrue(applied_data["review_required"])
        self.assertFalse(applied_data["reviewed"])
        self.assertTrue(applied_data["has_pitch_contour"])
        self.assertEqual(applied_data["lifecycle_state"], "NEEDS_REVIEW")

    def test_simple_import_opt_out_and_instrumental_skip_background_queue(self):
        client, repo, _, service = self._build_client(worker_online_probe=lambda: True)
        proc = FakeProcessingService(repo, service.karaoke)
        service._explicit_processing_service = proc
        service.karaoke.processing = proc.repository

        mp3_bytes = _mp3_with_id3(
            frames=240,
            title="Opt-out song",
            sylt_entries=[("Dòng một", 200), ("Dòng hai", 2200)],
        )
        resp_opt_out = client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("opt_out.mp3", mp3_bytes, "audio/mpeg")},
            data={"enable_background_processing": "false", "audio_type": "VOCAL_FULL"},
        )
        self.assertEqual(resp_opt_out.status_code, 201, resp_opt_out.text)
        d1 = resp_opt_out.json()
        self.assertFalse(d1["processing_queued"])
        self.assertIsNone(d1["processing_job_id"])
        self.assertEqual(d1["lifecycle_state"], "READY_FOR_REVIEW")

        resp_inst = client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("inst.mp3", mp3_fixture(frames=200), "audio/mpeg")},
            data={"audio_type": "INSTRUMENTAL_ONLY", "auto_transcribe": "false"},
        )
        self.assertEqual(resp_inst.status_code, 201, resp_inst.text)
        d2 = resp_inst.json()
        self.assertFalse(d2["processing_queued"])
        self.assertEqual(d2["lifecycle_state"], "UPLOADED")

    def test_manual_simple_processing_auth_offline_503_and_v1_to_v2_replay(self):
        online_flag = {"online": False}
        client, repo, _, service = self._build_client(
            worker_online_probe=lambda: online_flag["online"],
        )
        proc = FakeProcessingService(repo, service.karaoke)
        service._explicit_processing_service = proc
        service.karaoke.processing = proc.repository

        async def _no_whisper(*_args, **_kwargs):
            return None

        service.transcriber = _no_whisper
        imp = client.post(
            "/api/v1/karaoke/admin/songs/simple-import",
            files={"audio": ("plain.mp3", mp3_fixture(frames=240), "audio/mpeg")},
            data={
                "audio_type": "VOCAL_FULL",
                "lyrics_text": "Dòng một\nDòng hai",
            },
        )
        self.assertEqual(imp.status_code, 201, imp.text)
        imp_data = imp.json()
        song_id = imp_data["song_id"]
        version_id = imp_data["version_id"]
        revision = imp_data["revision"]
        self.assertFalse(imp_data["worker_online"])
        self.assertFalse(imp_data["processing_queued"])

        # Offline manual trigger fails honestly with 503 WORKER_OFFLINE.
        idem = str(uuid4())
        offline_start = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing",
            json={
                "expected_revision": revision,
                "draft_version_id": version_id,
                "idempotency_key": idem,
            },
        )
        self.assertEqual(offline_start.status_code, 503)

        # Non-admin must be denied with 403.
        non_admin_client, _, _, _ = self._build_client(
            actor_id=PARENT,
            worker_online_probe=lambda: True,
        )
        self.assertEqual(
            non_admin_client.get(f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing").status_code,
            403,
        )
        self.assertEqual(
            non_admin_client.post(
                f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing",
                json={"expected_revision": revision, "draft_version_id": version_id},
            ).status_code,
            403,
        )

        # Turn worker online and trigger with untimed format_version=1 lyrics -> upgrades to v2 and returns 202.
        online_flag["online"] = True
        start_resp = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing",
            json={
                "expected_revision": revision,
                "draft_version_id": version_id,
                "idempotency_key": idem,
                "audio_type": "VOCAL_FULL",
                "bpm": 108,
                "lyrics": {
                    "format_version": 1,
                    "lines": [
                        {"id": str(uuid4()), "text": "Câu thứ nhất", "start_ms": None, "end_ms": None},
                        {"id": str(uuid4()), "text": "Câu thứ hai", "start_ms": None, "end_ms": None},
                    ],
                },
            },
        )
        self.assertEqual(start_resp.status_code, 202, start_resp.text)
        started = start_resp.json()
        self.assertEqual(started["lifecycle_state"], "QUEUED")
        self.assertEqual(started["song"]["draft"]["lyrics"]["format_version"], 2)

        # Idempotent replay with updated revision returns 200 without duplicating jobs.
        replay_resp = client.post(
            f"/api/v1/karaoke/admin/songs/{song_id}/simple-processing",
            json={
                "expected_revision": started["revision"],
                "draft_version_id": version_id,
                "idempotency_key": idem,
            },
        )
        self.assertEqual(replay_resp.status_code, 200, replay_resp.text)
        self.assertEqual(len(proc.repository.jobs), 1)


class SimplePipelineLifecycleUnitTests(unittest.TestCase):
    def test_resolve_simple_lifecycle_state_covers_all_10_states(self):
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True, lyrics_line_count=0, requires_lyrics_input=True
            ),
            "UPLOADED",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                job=SimpleNamespace(status="QUEUED", stage="QUEUED"),
            ),
            "QUEUED",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                job=SimpleNamespace(status="RUNNING", stage="PREPARING_AUDIO"),
                operations=[SimpleNamespace(step_key="SEPARATE_STEMS", state="SUBMITTED")],
            ),
            "SEPARATING_AUDIO",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True, lyrics_line_count=0, transcribing_active=True
            ),
            "TRANSCRIBING_LYRICS",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                job=SimpleNamespace(status="RUNNING", stage="ALIGNING_LYRICS"),
                operations=[SimpleNamespace(step_key="ALIGN_PROVIDED_LYRICS", state="SUBMITTED")],
            ),
            "ALIGNING_LYRICS",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                job=SimpleNamespace(status="RUNNING", stage="VALIDATING_RESULT", provenance={}),
                operations=[SimpleNamespace(step_key="ANALYZE_RHYTHM", state="PREPARED")],
            ),
            "ANALYZING_RHYTHM",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                job=SimpleNamespace(
                    status="RUNNING",
                    stage="VALIDATING_RESULT",
                    provenance={"analysis_phase": "MELODY"},
                ),
            ),
            "ANALYZING_MELODY",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                flagged_count=0,
                job=SimpleNamespace(
                    status="READY",
                    stage="COMPLETE",
                    lyrics_result={"format_version": 2, "lines": []},
                    result_audio_duration_ms=4000,
                    input_duration_ms=4000,
                    error_code=None,
                ),
            ),
            "READY_FOR_REVIEW",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                job=SimpleNamespace(status="NEEDS_REVIEW", stage="COMPLETE"),
            ),
            "NEEDS_REVIEW",
        )
        self.assertEqual(
            resolve_simple_lifecycle_state(
                has_audio=True,
                lyrics_line_count=2,
                job=SimpleNamespace(status="FAILED", stage="FAILED"),
            ),
            "FAILED",
        )

    def test_is_worker_online_respects_config_and_env(self):
        from pathlib import Path
        import tempfile

        repo = MemoryRepository()
        storage = MemoryStorage(repo)
        svc_off = KaraokeSimpleImportService(
            repo, storage, processing_config=KaraokeProcessingConfig(enabled=False)
        )
        self.assertFalse(svc_off.is_worker_online())

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            py_exe = root / "python.exe"
            py_exe.write_text("", encoding="utf-8")
            eng = root / "engine.py"
            eng.write_text("", encoding="utf-8")
            model_dir = root / "model"
            model_dir.mkdir()
            (model_dir / "pytorch_model.bin").write_bytes(b"ok")
            (model_dir / "config.json").write_text("{}", encoding="utf-8")
            stem_dir = root / "stem"
            stem_dir.mkdir()
            (stem_dir / "955717e8-8726e21a.th").write_bytes(b"ok")

            cfg_on = KaraokeProcessingConfig(
                enabled=True,
                worker_enabled=True,
                pipeline_version="v1",
                alignment_provider="local_ctc",
                stem_provider="demucs",
                python_path=str(py_exe),
                engine_script=str(eng),
                model_path=str(model_dir),
                stem_model_path=str(stem_dir),
                temp_dir=str(root),
                reserved_minutes_admin_day=10,
                reserved_minutes_global_day=60,
            )
            self.assertTrue(cfg_on.configured)
            svc_on = KaraokeSimpleImportService(repo, storage, processing_config=cfg_on)
            with patch.dict("os.environ", {"KARAOKE_PROCESSING_WORKER_ONLINE": "false"}):
                self.assertFalse(svc_on.is_worker_online())
            with patch.dict("os.environ", {"KARAOKE_PROCESSING_WORKER_ONLINE": "true"}):
                self.assertTrue(svc_on.is_worker_online())


if __name__ == "__main__":
    unittest.main()
