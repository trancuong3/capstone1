"""Unit tests for Wave 2 Backend (#5 Studio V2 Multimodal & Duet Reading + #7 Readability & Storyweaver)."""
from __future__ import annotations

import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/viread_test",
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.test-signature",
)

from io import BytesIO
import random
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException
from PIL import Image

from app.api.routes.picture_description import get_picture_catalog
from app.schemas.parent_private_book import ParentStoryweaverRequest
from app.schemas.reading import ReadingPageWordDTO
from app.schemas.sentence_shooter import SentenceShooterSessionCreate
from app.services.book_quality_analyzer import (
    analyse_verified_text,
    analyse_vietnamese_readability,
)
from app.services.duet_reading import build_duet_segments_for_page
from app.services.family_storyweaver_service import (
    FamilyStoryweaverService,
    _build_deterministic_story_pages,
    _render_storyweaver_page_webp,
)
from app.services.games.sentence_extraction import extract_verified_sentences
from app.services.games.sentence_shooter_service import SentenceShooterService
from app.services.tutor_questions.prompts import user_prompt
from app.services.tutor_questions.rule_based import generate_rule_based
from app.services.tutor_questions.types import SourcePage


class Wave2StudioMultimodalReadabilityTests(unittest.IsolatedAsyncioTestCase):
    def test_vietnamese_readability_grade_bands_and_match_status(self) -> None:
        g1_text = "Bé đi học vui quá. Mẹ thương bé rất nhiều."
        self.assertEqual(analyse_verified_text(g1_text), [])

        rep_match = analyse_vietnamese_readability(g1_text, min_grade=1, max_grade=1)
        self.assertEqual(rep_match.estimated_grade_band, "GRADE_1")
        self.assertEqual(rep_match.grade_match_status, "MATCHED")
        self.assertGreaterEqual(rep_match.phonics_readiness_score, 80.0)

        rep_easy = analyse_vietnamese_readability(g1_text, min_grade=4, max_grade=5)
        self.assertEqual(rep_easy.grade_match_status, "TOO_EASY")

        hard_text = (
            "Những chiếc thuyền buồm nghiêng mình vượt sóng ngoài khơi xa dưới ánh bình minh "
            "lấp lánh huyền diệu giữa khung cảnh thiên nhiên ngoạn mục trên vùng biển rộng mênh mông."
        )
        rep_hard = analyse_vietnamese_readability(hard_text, min_grade=1, max_grade=1)
        self.assertEqual(rep_hard.grade_match_status, "TOO_HARD")
        self.assertGreater(rep_hard.complex_phonics_ratio, 0.0)

    def test_duet_reading_segments_studio_v2_blocks_and_poem_fallback(self) -> None:
        raw_tokens = [
            ("Sáng", 0),
            ("sớm", 0),
            ("vườn", 0),
            ("hoa", 0),
            ("nở.", 0),
            ("—", 1),
            ("Mẹ", 1),
            ("ơi", 1),
            ("đẹp", 1),
            ("quá!", 1),
        ]
        words = [
            ReadingPageWordDTO(
                word_id=uuid4(),
                word_index=idx,
                line_index=li,
                text=txt,
                bbox=(0.1, 0.1, 0.1, 0.05),
            )
            for idx, (txt, li) in enumerate(raw_tokens)
        ]

        blocks = [
            {
                "block_id": "b0",
                "block_type": "STORY_BODY",
                "reading_order": 0,
                "source_word_indices": [0, 1, 2, 3, 4],
                "decision": "KEEP",
                "in_canonical": True,
            },
            {
                "block_id": "b1",
                "block_type": "DIALOGUE",
                "reading_order": 1,
                "source_word_indices": [5, 6, 7, 8, 9],
                "decision": "KEEP",
                "in_canonical": True,
            },
        ]
        v2_segments = build_duet_segments_for_page(
            words, page_kind="COMIC", blocks_json=blocks
        )
        self.assertEqual(len(v2_segments), 2)
        self.assertEqual(v2_segments[0].role, "PARENT")
        self.assertEqual(v2_segments[1].role, "CHILD")
        self.assertEqual(v2_segments[1].block_type, "DIALOGUE")

        fallback_segments = build_duet_segments_for_page(words, page_kind="POEM")
        self.assertEqual(len(fallback_segments), 2)
        self.assertEqual([s.role for s in fallback_segments], ["PARENT", "CHILD"])

    def test_tutor_questions_poem_and_studio_v2_style_bible(self) -> None:
        poem_text = (
            "Sáng nay nắng ấm hiên nhà\n"
            "Bông hồng khoe sắc bên hàng cây xanh\n"
            "Chim ca rộn rã trên cành\n"
            "Em vui đọc sách học hành chăm ngoan"
        )
        tokens = tuple(poem_text.split())
        page = SourcePage(
            page_id=uuid4(),
            revision_id=uuid4(),
            page_number=1,
            text=poem_text,
            tokens=tokens,
            page_kind="POEM",
            style_bible={
                "characters": [{"name": "Bé Mai", "description": "học sinh lớp 1"}],
                "settings": ["hiên nhà", "hàng cây xanh"],
            },
        )
        prompt_str = user_prompt([page], count=2, max_chars=1200)
        self.assertIn("Loại trang: POEM", prompt_str)
        self.assertIn("Bé Mai", prompt_str)
        self.assertIn("hiên nhà", prompt_str)

        drafts = generate_rule_based([page], count=2, seed="wave2-poem-seed")
        self.assertGreaterEqual(len(drafts), 1)
        self.assertEqual(drafts[0].type, "CLOZE")

    def test_sentence_shooter_accepts_book_page_id_and_prioritizes_page(self) -> None:
        child_id = uuid4()
        book_id = uuid4()
        page_1_id = uuid4()
        page_2_id = uuid4()

        payload = SentenceShooterSessionCreate(
            child_id=child_id,
            book_id=book_id,
            book_page_id=page_2_id,
            difficulty="easy",
            total_rounds=1,
        )
        self.assertEqual(payload.book_page_id, page_2_id)

        def _make_source(page_id, page_num, sentence_text):
            word_objs = [
                SimpleNamespace(
                    Id=uuid4(),
                    LineIndex=0,
                    WordIndex=i,
                    Text=tok,
                )
                for i, tok in enumerate(sentence_text.split())
            ]
            src = SimpleNamespace(
                book=SimpleNamespace(Id=book_id),
                page=SimpleNamespace(Id=page_id, PageNumber=page_num),
                revision=SimpleNamespace(Id=uuid4(), VerifiedText=sentence_text),
                words=word_objs,
            )
            extracted = extract_verified_sentences(
                sentence_text, word_objs, min_tokens=4, max_tokens=10
            )
            return [(src, s) for s in extracted]

        candidates = [
            *_make_source(page_1_id, 1, "Chú mèo vàng nằm ngủ bên sân."),
            *_make_source(page_2_id, 2, "Đàn vịt trắng bơi trên mặt hồ."),
        ]
        chosen = SentenceShooterService._select_prioritized_candidates(
            candidates,
            1,
            set(),
            random.SystemRandom(),
            preferred_page_id=page_2_id,
        )
        self.assertEqual(len(chosen), 1)
        self.assertEqual(chosen[0][0].page.Id, page_2_id)

    async def test_storyweaver_templates_webp_and_unsafe_prompt_guard(self) -> None:
        webp_bytes = _render_storyweaver_page_webp(1, 3)
        with Image.open(BytesIO(webp_bytes)) as img:
            self.assertEqual(img.format, "WEBP")
            self.assertEqual(img.size, (1200, 1600))

        title, pages = _build_deterministic_story_pages(
            theme="cánh đồng lúa",
            grade=1,
            page_count=3,
            style_mode="DUET_DIALOGUE",
            target_words=["hương lúa", "rộn ràng"],
        )
        self.assertIn("cánh đồng lúa", title)
        self.assertEqual(len(pages), 3)
        self.assertTrue(any("hương lúa" in p for p in pages))
        self.assertTrue(all(analyse_verified_text(p) == [] for p in pages))

        fake_db = AsyncMock()
        fake_db.scalar = AsyncMock(return_value="parent")
        fake_db.rollback = AsyncMock()
        svc = FamilyStoryweaverService(fake_db)
        bad_req = ParentStoryweaverRequest(
            theme="truyện ma quỷ kinh dị",
            page_count=3,
            style_mode="PROSE",
        )
        with self.assertRaises(HTTPException) as exc_info:
            await svc.create_storyweaver_book(uuid4(), bad_req)
        self.assertEqual(exc_info.exception.status_code, 422)
        self.assertEqual(exc_info.exception.detail, "UNSAFE_STORY_PROMPT")

    async def test_storyweaver_create_full_flow_persists_book_pages_and_v2_metadata(self) -> None:
        from contextlib import asynccontextmanager

        from app.models import Book, BookPage, PageRevision, PageRevisionWord
        from app.models.smart_book_studio import BookStyleBible, PageOcrExtraction

        actor_id = uuid4()
        child_id = uuid4()
        added_rows: list[Any] = []
        uploaded: list[tuple[str, bytes, str, str | None]] = []

        class _FakeDb:
            def __init__(self) -> None:
                self.commits = 0
                self.rollbacks = 0

            async def scalar(self, query: Any) -> Any:
                sql_str = str(query)
                if "profiles" in sql_str.lower():
                    return "parent"
                if "childprofiles" in sql_str.lower():
                    return SimpleNamespace(Id=child_id, ParentId=actor_id, Grade=2)
                return None

            def add(self, obj: Any) -> None:
                if getattr(obj, "Id", None) is None:
                    obj.Id = uuid4()
                added_rows.append(obj)

            def add_all(self, objs: list[Any]) -> None:
                for obj in objs:
                    self.add(obj)

            async def flush(self, objs: Any = None) -> None:
                _ = objs

            async def commit(self) -> None:
                self.commits += 1

            async def rollback(self) -> None:
                self.rollbacks += 1

            @asynccontextmanager
            async def begin_nested(self):
                yield self

        def _fake_upload(path: str, data: bytes, mime: str, *, bucket_name: str | None = None, upsert: bool = False) -> None:
            _ = upsert
            uploaded.append((path, data, mime, bucket_name))

        fake_db = _FakeDb()
        fake_detail = {
            "book": {
                "id": str(uuid4()),
                "title": "Chuyến khám phá khu vườn nắng sớm",
                "author": "Gia đình & Trạm Sáng Tạo ViRead",
                "min_grade": 2,
                "max_grade": 2,
                "lifecycle_status": "ACTIVE",
                "visibility_scope": "PARENT_PRIVATE",
                "moderation_status": "ACTIVE",
                "suspended_reason": None,
                "source_declaration": "[SELF_AUTHORED] Trạm Sáng Tạo Sách Mỏng Gia Đình (DUET_DIALOGUE)",
                "committed_page_count": 3,
                "pending_submission_count": 0,
                "flagged_submission_count": 0,
                "failed_submission_count": 0,
                "ready_to_add_count": 0,
                "readable_for_children": True,
                "has_held_multipage_batch": False,
                "privacy_notice": "Riêng tư",
                "created_at": "2026-11-28T00:00:00Z",
            },
            "pages": [],
            "submissions": [],
        }

        with (
            patch(
                "app.services.family_storyweaver_service.FamilyStoryweaverService._collect_due_words",
                new=AsyncMock(return_value=["nắng sớm"]),
            ),
            patch(
                "app.services.family_storyweaver_service.FamilyStoryweaverService._try_generate_cloud_story",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "app.services.family_storyweaver_service.ParentPrivateBookService.get_book",
                new=AsyncMock(return_value=fake_detail),
            ),
        ):
            svc = FamilyStoryweaverService(fake_db, upload_fn=_fake_upload)
            req = ParentStoryweaverRequest(
                child_id=child_id,
                theme="khu vườn nắng sớm",
                page_count=3,
                target_grade=2,
                style_mode="DUET_DIALOGUE",
                custom_words=["bông hoa"],
            )
            res = await svc.create_storyweaver_book(actor_id, req, base_url="http://testserver")

        self.assertEqual(len(uploaded), 3)
        self.assertTrue(all(mime == "image/webp" for _, _, mime, _ in uploaded))
        self.assertEqual(fake_db.commits, 2)  # main book commit + optional V2 metadata commit
        self.assertEqual(len([r for r in added_rows if isinstance(r, Book)]), 1)
        self.assertEqual(len([r for r in added_rows if isinstance(r, BookPage)]), 3)
        self.assertEqual(len([r for r in added_rows if isinstance(r, PageRevision)]), 3)
        self.assertGreater(len([r for r in added_rows if isinstance(r, PageRevisionWord)]), 10)
        self.assertEqual(len([r for r in added_rows if isinstance(r, BookStyleBible)]), 1)
        self.assertEqual(len([r for r in added_rows if isinstance(r, PageOcrExtraction)]), 3)
        self.assertEqual(res.generation_source, "DETERMINISTIC_TEMPLATE")
        self.assertIn("bông hoa", res.target_words_used)

    async def test_direct_call_picture_catalog_unwraps_query_defaults(self) -> None:
        actor_id = uuid4()
        child_id = uuid4()
        fake_db = AsyncMock()
        with patch("app.api.routes.picture_description._service") as mock_svc_factory:
            mock_svc = AsyncMock()
            mock_svc.get_catalog = AsyncMock(return_value={"samples": [], "book_pages": []})
            mock_svc_factory.return_value = mock_svc

            await get_picture_catalog(child_id=child_id, actor_id=actor_id, db=fake_db)
            mock_svc.get_catalog.assert_awaited_once_with(
                actor_id,
                child_id,
                book_id=None,
                book_page_id=None,
            )


if __name__ == "__main__":
    unittest.main()
