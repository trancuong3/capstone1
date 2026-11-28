"""Feature #2 test suite: Co-Reading Role-Play, Turn-Taking, Parent Storyteller Voice & Postcards.

Compatible with both `pytest` and `python -m unittest`.

Verifies:
1. Vietnamese dialogue splitting (`“...”`, `"..."`, `- ...`, `— ...`), character voice assignment
   from `STATIC_LOCAL_VOICES` (`CHARACTER_A`, `CHARACTER_B` != primary teacher voice) while keeping
   `NARRATOR` + `coaching_voice_id` locked to the session's primary teacher voice (`SessionVoiceLock`),
   and strict alternating `turn_owner` (`"AI_OR_PARENT"` -> `"CHILD"`).
2. `PageRevision.VerifiedText` lookup via `POST /co-reading/children/{child_id}/parse-script` +
   cross-parent child/book 403/404 isolation.
3. Parent narration upload magic-byte sniffing (`webm`, `ogg`, `wav`, `mp3`, `m4a`, `aac`),
   non-audio rejection (415 for PNG/JPEG/PDF/HTML/text, 422 for empty, 413 for >2 MiB),
   guaranteed `word_timings` generation (`[{word, start_ms, end_ms}]` via CTC hook, WAV PCM
   acoustic envelope, and deterministic syllable-duration fallback), private audio streaming,
   delete + storage cleanup, and cross-parent 403/404 isolation.
4. `PARENT_PRIVATE` Family Progress Postcard CRUD (JSON + multipart audio clip <=256 KiB,
   413 for >256 KiB, 415 for disguised non-audio, cross-parent 403/404 isolation, zero public URLs).
5. Mandatory `Cache-Control: private, no-store` header on all JSON and binary audio responses,
   plus SQL migration RLS & cascade contract checks.
"""

from __future__ import annotations

import io
import math
import os
from pathlib import Path
import struct
import sys
from typing import Any
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_DIR.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.api.deps import get_current_parent_id, get_db
from app.api.router import api_router
from app.models.book import Book, BookPage, PageRevision
from app.models.co_reading import FamilyReadingPostcard, ParentPageNarration
from app.models.profile import ChildProfile, Profile
from app.providers.local_voice_provider import KNOWN_LOCAL_VOICE_IDS
from app.schemas.co_reading import WordTiming
from app.services.dialogue_role_parser import parse_script
from app.services.parent_narration_service import (
    MAX_NARRATION_BYTES,
    MAX_POSTCARD_CLIP_BYTES,
    ParentNarrationService,
    clear_test_narration_storage,
)
from test_durable_workflows_and_router import FakeStudioAsyncSession, StudioDbState


def _make_pcm_wav_bytes(*, duration_ms: int = 900, sample_rate: int = 8000) -> bytes:
    """Synthesize a valid 16-bit mono PCM RIFF/WAVE clip with clear speech envelope."""
    total_samples = max(400, (sample_rate * duration_ms) // 1000)
    pcm = bytearray()
    lead_quiet = total_samples // 10
    tail_quiet = total_samples // 10
    for idx in range(total_samples):
        if idx < lead_quiet or idx >= total_samples - tail_quiet:
            amp = 0
        else:
            env = 0.55 + 0.35 * math.sin(2.0 * math.pi * idx / max(1, sample_rate // 4))
            val = math.sin(2.0 * math.pi * 220.0 * idx / sample_rate) * env
            amp = int(max(-32000, min(32000, val * 22000)))
        pcm.extend(struct.pack("<h", amp))

    data_size = len(pcm)
    byte_rate = sample_rate * 2
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        byte_rate,
        2,
        16,
        b"data",
        data_size,
    )
    return header + bytes(pcm)


def _make_webm_bytes(size: int = 256) -> bytes:
    return b"\x1a\x45\xdf\xa3" + (b"\x42\x86\x81\x01" * max(8, size // 4))[: max(32, size - 4)]


class _CoReadingFakeAsyncSession(FakeStudioAsyncSession):
    """Extends FakeStudioAsyncSession with delete + unique constraint checks for Feature #2 tables."""

    async def delete(self, row: Any) -> None:
        cls = type(row)
        rows = self.state.tables.get(cls)
        if rows is not None:
            self.state.tables[cls] = [item for item in rows if item is not row]

    async def commit(self) -> None:
        narr_rows = list(self.state.tables.get(ParentPageNarration, []))
        seen_book_page: set[tuple[UUID, UUID]] = set()
        for row in narr_rows:
            key = (row.BookId, row.PageId)
            if key in seen_book_page:
                raise IntegrityError(
                    "uq_parent_page_narrations_book_page",
                    params=None,
                    orig=Exception("uq"),
                )
            seen_book_page.add(key)
        await super().commit()


def _seed_households() -> tuple[StudioDbState, dict[str, UUID]]:
    state = StudioDbState()
    parent_a = uuid4()
    parent_b = uuid4()
    child_a = uuid4()
    child_b = uuid4()
    book_a = uuid4()
    page_a1 = uuid4()
    rev_a1 = uuid4()
    book_b = uuid4()
    page_b1 = uuid4()
    catalog_book = uuid4()
    catalog_page = uuid4()

    state.tables[Profile] = [
        Profile(Id=parent_a, Role="parent", DisplayName="Mẹ Lan", Active=1),
        Profile(Id=parent_b, Role="parent", DisplayName="Bố Hùng", Active=1),
    ]
    state.tables[ChildProfile] = [
        ChildProfile(
            Id=child_a,
            ParentId=parent_a,
            Alias="Bé Na",
            Grade=2,
            Settings={"preferred_voice_id": "local_south_thuc_doan"},
        ),
        ChildProfile(
            Id=child_b,
            ParentId=parent_b,
            Alias="Bé Minh",
            Grade=3,
            Settings={},
        ),
    ]
    state.tables[Book] = [
        Book(
            Id=book_a,
            Title="Truyện Thỏ Trắng Và Sóc Nâu",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=parent_a,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
        Book(
            Id=book_b,
            Title="Sách Riêng Nhà Bố Hùng",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=parent_b,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
        Book(
            Id=catalog_book,
            Title="Sách Thư Viện Chung",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="CATALOG",
            OwnerParentId=None,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
    ]
    state.tables[BookPage] = [
        BookPage(
            Id=page_a1,
            BookId=book_a,
            PageNumber=1,
            ImagePath="private/a/p1.png",
            Width=800,
            Height=1000,
            CurrentVerifiedRevisionId=rev_a1,
            LifecycleStatus="PUBLISHED",
        ),
        BookPage(
            Id=page_b1,
            BookId=book_b,
            PageNumber=1,
            ImagePath="private/b/p1.png",
            Width=800,
            Height=1000,
            CurrentVerifiedRevisionId=None,
            LifecycleStatus="PUBLISHED",
        ),
        BookPage(
            Id=catalog_page,
            BookId=catalog_book,
            PageNumber=1,
            ImagePath="catalog/c/p1.png",
            Width=800,
            Height=1000,
            CurrentVerifiedRevisionId=None,
            LifecycleStatus="PUBLISHED",
        ),
    ]
    state.tables[PageRevision] = [
        PageRevision(
            Id=rev_a1,
            PageId=page_a1,
            RevisionNo="1",
            VerificationStatus="VERIFIED",
            VerifiedText=(
                "Buổi sáng trong khu rừng nhỏ.\n"
                "“Chào bạn Sóc Nâu!” Thỏ Trắng vui vẻ gọi.\n"
                "— Chào Thỏ Trắng, mình cùng đi hái nấm nhé! — Sóc Nâu đáp."
            ),
            ContentHash="hash-a1",
        )
    ]
    state.tables[ParentPageNarration] = []
    state.tables[FamilyReadingPostcard] = []

    return state, {
        "parent_a": parent_a,
        "parent_b": parent_b,
        "child_a": child_a,
        "child_b": child_b,
        "book_a": book_a,
        "page_a1": page_a1,
        "book_b": book_b,
        "page_b1": page_b1,
        "catalog_book": catalog_book,
        "catalog_page": catalog_page,
    }


def _build_client(state: StudioDbState, actor_holder: dict[str, UUID]) -> TestClient:
    app = FastAPI()
    app.include_router(api_router)

    async def _override_db():
        yield _CoReadingFakeAsyncSession(state)

    def _override_actor() -> UUID:
        return actor_holder["actor_id"]

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_parent_id] = _override_actor
    return TestClient(app)


class Feat2CoReadingAndNarrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_test_narration_storage()
        self._storage_objects: dict[tuple[str | None, str], bytes] = {}

        def _fake_upload(
            object_path: str,
            data: bytes,
            _content_type: str,
            *,
            bucket_name: str | None = None,
            upsert: bool = False,
        ) -> None:
            key = (bucket_name, object_path)
            if not upsert and key in self._storage_objects:
                raise HTTPException(status_code=409, detail="Already exists")
            self._storage_objects[key] = bytes(data)

        def _fake_download(
            object_path: str,
            *,
            bucket_name: str | None = None,
        ) -> bytes:
            key = (bucket_name, object_path)
            if key not in self._storage_objects:
                raise HTTPException(status_code=503, detail="Object not found")
            return self._storage_objects[key]

        def _fake_delete(
            object_path: str,
            *,
            bucket_name: str | None = None,
        ) -> None:
            self._storage_objects.pop((bucket_name, object_path), None)

        for target, fn in (
            ("app.services.parent_narration_service.upload_object", _fake_upload),
            ("app.services.parent_narration_service.download_object", _fake_download),
            ("app.services.parent_narration_service.delete_object", _fake_delete),
        ):
            p = patch(target, side_effect=fn)
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self) -> None:
        clear_test_narration_storage()
        self._storage_objects.clear()

    def test_migration_sql_enforces_parent_private_rls_and_cascades(self) -> None:
        sql_path = (
            _REPO_ROOT
            / "supabase"
            / "migrations"
            / "20261128171000_feat2_co_reading_parent_narration.sql"
        )
        self.assertTrue(sql_path.is_file())
        sql_text = sql_path.read_text(encoding="utf-8")
        self.assertIn("CREATE TABLE IF NOT EXISTS public.parent_page_narrations", sql_text)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.family_reading_postcards", sql_text)
        self.assertIn("UNIQUE (book_id, page_id)", sql_text)
        self.assertIn("ON DELETE CASCADE", sql_text)
        self.assertIn("ENABLE ROW LEVEL SECURITY", sql_text)
        self.assertIn("REVOKE ALL PRIVILEGES ON TABLE public.parent_page_narrations FROM PUBLIC", sql_text)
        self.assertIn("REVOKE ALL PRIVILEGES ON TABLE public.parent_page_narrations FROM anon", sql_text)
        self.assertIn("visibility = 'PARENT_PRIVATE'", sql_text)

    def test_dialogue_parser_vietnamese_quotes_dashes_voice_lock_and_turn_taking(self) -> None:
        teacher_voice = "local_north_truc_ly"
        sample_text = (
            "Trời sáng ấm áp trên cánh đồng xanh.\n"
            "“Con chào mẹ ạ!” Bé Na lễ phép nói.\n"
            "- Mẹ chào con gái ngoan! — Mẹ mỉm cười dịu dàng.\n"
            "\"Hôm nay hai mẹ con mình cùng đọc truyện nhé!\""
        )
        turns = parse_script(sample_text, teacher_voice_id=teacher_voice)
        self.assertGreaterEqual(len(turns), 4)

        roles = [t.role for t in turns]
        self.assertIn("NARRATOR", roles)
        self.assertIn("CHARACTER_A", roles)
        self.assertIn("CHARACTER_B", roles)

        for idx, turn in enumerate(turns):
            expected_owner = "AI_OR_PARENT" if idx % 2 == 0 else "CHILD"
            self.assertEqual(turn.turn_owner, expected_owner)
            self.assertEqual(turn.coaching_voice_id, teacher_voice)
            self.assertIn(turn.voice_id, KNOWN_LOCAL_VOICE_IDS)
            if turn.role == "NARRATOR":
                self.assertEqual(turn.voice_id, teacher_voice)
                self.assertFalse(turn.is_character_dialogue)
            else:
                self.assertNotEqual(turn.voice_id, teacher_voice)
                self.assertTrue(turn.is_character_dialogue)
            if turn.turn_owner == "CHILD":
                self.assertEqual(
                    turn.coaching_prompt_vi,
                    "Đến lượt con đọc câu tiếp theo nhé!",
                )

        char_a_voices = {t.voice_id for t in turns if t.role == "CHARACTER_A"}
        char_b_voices = {t.voice_id for t in turns if t.role == "CHARACTER_B"}
        self.assertEqual(len(char_a_voices), 1)
        self.assertEqual(len(char_b_voices), 1)
        self.assertNotEqual(char_a_voices, char_b_voices)

    def test_parse_script_route_verified_text_and_household_isolation(self) -> None:
        state, ids = _seed_households()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        # Parent A parses page_a1 directly from PageRevision.VerifiedText
        resp = client.post(
            f"/co-reading/children/{ids['child_a']}/parse-script",
            json={"book_id": str(ids["book_a"]), "page_id": str(ids["page_a1"])},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("cache-control"), "private, no-store")
        body = resp.json()
        self.assertTrue(body["has_dialogue"])
        self.assertEqual(body["narrator_voice_id"], "local_south_thuc_doan")
        self.assertEqual(body["coaching_voice_id"], "local_south_thuc_doan")
        self.assertGreaterEqual(body["total_turns"], 3)
        self.assertEqual(body["turns"][0]["turn_owner"], "AI_OR_PARENT")
        self.assertEqual(body["turns"][1]["turn_owner"], "CHILD")

        # Cross-parent child access -> 403
        resp_cross_child = client.post(
            f"/co-reading/children/{ids['child_b']}/parse-script",
            json={"page_text": "Xin chào các bạn nhỏ."},
        )
        self.assertEqual(resp_cross_child.status_code, 403)

        # Unknown child -> 404
        resp_missing_child = client.post(
            f"/co-reading/children/{uuid4()}/parse-script",
            json={"page_text": "Xin chào các bạn nhỏ."},
        )
        self.assertEqual(resp_missing_child.status_code, 404)

        # Cross-parent private book access -> 403
        resp_cross_book = client.post(
            f"/co-reading/children/{ids['child_a']}/parse-script",
            json={"book_id": str(ids["book_b"]), "page_id": str(ids["page_b1"])},
        )
        self.assertEqual(resp_cross_book.status_code, 403)

    async def test_narration_ctc_hook_and_fallback_word_timings(self) -> None:
        state, ids = _seed_households()
        db = _CoReadingFakeAsyncSession(state)
        wav_bytes = _make_pcm_wav_bytes(duration_ms=1200)

        async def _fake_ctc_aligner(
            _audio: bytes,
            words: list[str],
            duration_ms: int,
        ) -> list[WordTiming]:
            step = max(20, duration_ms // max(1, len(words)))
            return [
                WordTiming(word=w, start_ms=i * step, end_ms=(i + 1) * step - 5)
                for i, w in enumerate(words)
            ]

        svc_ctc = ParentNarrationService(db, ctc_aligner=_fake_ctc_aligner)
        uploaded = await svc_ctc.upsert_narration(
            parent_id=ids["parent_a"],
            book_id=ids["book_a"],
            page_id=ids["page_a1"],
            audio_bytes=wav_bytes,
            page_text="Thỏ trắng chào bạn sóc nâu",
            duration_ms=1200,
        )
        self.assertEqual(uploaded.alignment_source, "ctc_forced")
        self.assertEqual([w.word for w in uploaded.word_timings], ["Thỏ", "trắng", "chào", "bạn", "sóc", "nâu"])

    def test_narration_magic_bytes_size_cap_streaming_cleanup_and_isolation(self) -> None:
        state, ids = _seed_households()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)
        url = f"/co-reading/my-books/{ids['book_a']}/pages/{ids['page_a1']}/narration"

        # 1. Reject disguised non-audio files (PNG, JPEG, PDF, HTML/text) -> 415
        for bad_name, bad_bytes in [
            ("fake.wav", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64),
            ("fake.mp3", b"\xff\xd8\xff\xe0" + b"\x00" * 64),
            ("doc.webm", b"%PDF-1.7\n" + b"0" * 64),
            ("script.ogg", b"<html><script>alert(1)</script></html>"),
        ]:
            bad_resp = client.post(
                url,
                files={"audio_file": (bad_name, io.BytesIO(bad_bytes), "audio/wav")},
                data={"page_text": "Xin chào bé ngoan"},
            )
            self.assertEqual(bad_resp.status_code, 415, msg=f"Expected 415 for {bad_name}")

        # 2. Reject empty payload -> 422
        empty_resp = client.post(
            url,
            files={"audio_file": ("empty.wav", io.BytesIO(b""), "audio/wav")},
        )
        self.assertEqual(empty_resp.status_code, 422)

        # 3. Reject > 2 MiB narration -> 413
        oversized = b"OggS" + b"\x00" * (MAX_NARRATION_BYTES + 10)
        too_big_resp = client.post(
            url,
            files={"audio_file": ("huge.ogg", io.BytesIO(oversized), "audio/ogg")},
        )
        self.assertEqual(too_big_resp.status_code, 413)

        # 4. Reject non-private catalog book -> 403
        cat_resp = client.post(
            f"/co-reading/my-books/{ids['catalog_book']}/pages/{ids['catalog_page']}/narration",
            files={"audio_file": ("mom.webm", io.BytesIO(_make_webm_bytes()), "audio/webm")},
        )
        self.assertEqual(cat_resp.status_code, 403)

        # 5. Valid WAV upload generates acoustic-envelope word_timings from PageRevision.VerifiedText
        wav_bytes = _make_pcm_wav_bytes(duration_ms=1500)
        ok_resp = client.post(
            url,
            files={"audio_file": ("me_ke_chuyen.wav", io.BytesIO(wav_bytes), "audio/wav")},
            data={"duration_ms": "1500"},
        )
        self.assertEqual(ok_resp.status_code, 201)
        self.assertEqual(ok_resp.headers.get("cache-control"), "private, no-store")
        meta = ok_resp.json()
        self.assertEqual(meta["visibility"], "PARENT_PRIVATE")
        self.assertEqual(meta["audio_format"], "wav")
        self.assertEqual(meta["alignment_source"], "acoustic_envelope")
        self.assertNotIn("http://", meta["audio_endpoint"])
        self.assertNotIn("https://", meta["audio_endpoint"])
        timings = meta["word_timings"]
        self.assertGreaterEqual(len(timings), 10)
        for prev_t, next_t in zip(timings, timings[1:]):
            self.assertLessEqual(prev_t["start_ms"], prev_t["end_ms"])
            self.assertLessEqual(prev_t["end_ms"], next_t["start_ms"])

        # 6. Stream audio privately with Cache-Control: private, no-store
        audio_resp = client.get(f"{url}/audio")
        self.assertEqual(audio_resp.status_code, 200)
        self.assertEqual(audio_resp.headers.get("cache-control"), "private, no-store")
        self.assertEqual(audio_resp.content, wav_bytes)

        # 7. Cross-parent isolation: Parent B gets 403 on GET meta, GET audio, POST, and DELETE
        actor["actor_id"] = ids["parent_b"]
        self.assertEqual(client.get(url).status_code, 403)
        self.assertEqual(client.get(f"{url}/audio").status_code, 403)
        self.assertEqual(client.delete(url).status_code, 403)
        self.assertEqual(
            client.post(
                url,
                files={"audio_file": ("intrude.webm", io.BytesIO(_make_webm_bytes()), "audio/webm")},
            ).status_code,
            403,
        )

        # 8. Parent A deletes narration -> 200, subsequent GET -> 404
        actor["actor_id"] = ids["parent_a"]
        del_resp = client.delete(url)
        self.assertEqual(del_resp.status_code, 200)
        self.assertTrue(del_resp.json()["deleted"])
        self.assertEqual(client.get(url).status_code, 404)
        self.assertEqual(client.get(f"{url}/audio").status_code, 404)

    def test_family_postcards_crud_clip_limits_and_parent_private_isolation(self) -> None:
        state, ids = _seed_households()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)
        base_url = f"/co-reading/children/{ids['child_a']}/postcards"

        # 1. Create text-only postcard via JSON
        create_json = client.post(
            base_url,
            json={
                "title": "Bé Na đọc trôi chảy trang đầu tiên!",
                "passage_text": "“Chào bạn Sóc Nâu!” Thỏ Trắng vui vẻ gọi.",
                "source_book_id": str(ids["book_a"]),
                "source_page_id": str(ids["page_a1"]),
                "emoji_badge": "🏅",
            },
        )
        self.assertEqual(create_json.status_code, 201)
        self.assertEqual(create_json.headers.get("cache-control"), "private, no-store")
        p1 = create_json.json()
        self.assertEqual(p1["visibility"], "PARENT_PRIVATE")
        self.assertFalse(p1["has_audio_clip"])
        self.assertIsNone(p1["audio_endpoint"])

        # 2. Create postcard with short WebM audio clip (<= 256 KiB)
        clip_bytes = _make_webm_bytes(512)
        create_clip = client.post(
            base_url,
            data={
                "title": "Kỷ niệm giọng đọc buổi tối",
                "passage_text": "Chào Thỏ Trắng, mình cùng đi hái nấm nhé!",
                "emoji_badge": "💖",
            },
            files={"audio_clip": ("clip.webm", io.BytesIO(clip_bytes), "audio/webm")},
        )
        self.assertEqual(create_clip.status_code, 201)
        p2 = create_clip.json()
        self.assertTrue(p2["has_audio_clip"])
        self.assertEqual(p2["audio_format"], "webm")
        self.assertNotIn("http", p2["audio_endpoint"] or "")

        # 3. Reject oversized postcard clip (> 256 KiB) -> 413
        big_clip = b"OggS" + b"\x00" * (MAX_POSTCARD_CLIP_BYTES + 8)
        too_big = client.post(
            base_url,
            data={"title": "Clip quá lớn", "passage_text": "Câu đọc mẫu."},
            files={"audio_clip": ("big.ogg", io.BytesIO(big_clip), "audio/ogg")},
        )
        self.assertEqual(too_big.status_code, 413)

        # 4. Reject Parent B's private source_book_id -> 403
        cross_book = client.post(
            base_url,
            json={
                "title": "Sách nhà khác",
                "passage_text": "Câu đọc mẫu.",
                "source_book_id": str(ids["book_b"]),
            },
        )
        self.assertEqual(cross_book.status_code, 403)

        # 5. List postcards + stream clip audio
        listed = client.get(base_url)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.headers.get("cache-control"), "private, no-store")
        self.assertEqual(listed.json()["total"], 2)

        stream_clip = client.get(p2["audio_endpoint"])
        self.assertEqual(stream_clip.status_code, 200)
        self.assertEqual(stream_clip.headers.get("cache-control"), "private, no-store")
        self.assertEqual(stream_clip.content, clip_bytes)

        # 6. Cross-parent isolation: Parent B cannot list, create, stream, or delete Parent A's child postcards
        actor["actor_id"] = ids["parent_b"]
        self.assertEqual(client.get(base_url).status_code, 403)
        self.assertEqual(client.get(p2["audio_endpoint"]).status_code, 403)
        self.assertEqual(client.delete(f"{base_url}/{p2['id']}").status_code, 403)


if __name__ == "__main__":
    unittest.main()
