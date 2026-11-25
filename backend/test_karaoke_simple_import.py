"""Tests for Admin Karaoke One-File Simple Mode (ID3v2, LRC, Groq Whisper, Safe Publish)."""
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from io import BytesIO
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from mutagen.id3 import APIC, ID3, SYLT, TCOM, TIT2, TPE1, USLT
from PIL import Image

from app.api.deps import require_admin_id
from app.api.routes.karaoke_simple_import import (
    get_karaoke_simple_import_service,
    router as simple_import_router,
)
from app.schemas.karaoke import Lyrics
from app.services.karaoke_lyrics import timing_issues
from app.services.karaoke_media_service import (
    clean_filename_title,
    extract_mp3_metadata,
    parse_lrc_text,
)
from app.services.karaoke_simple_import_service import (
    KaraokeSimpleImportService,
    map_whisper_verbose_json,
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


class SimpleImportAndPublishApiTests(unittest.TestCase):
    def _build_client(self, *, actor_id=ADMIN, transcriber=None):
        repo = MemoryRepository()
        storage = MemoryStorage(repo)
        service = KaraokeSimpleImportService(repo, storage, transcriber=transcriber)
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


if __name__ == "__main__":
    unittest.main()
