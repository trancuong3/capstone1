"""Unit tests for Wave 2 Backend (#5 Studio V2 Multimodal & Duet Reading + #7 Readability & Storyweaver)."""
from __future__ import annotations

import os
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/postgres"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "dummy-service-role-key")
os.environ.setdefault("VIREAD_WEB_DISABLE_HEAVY_WORKERS", "true")

import pytest
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


def test_vietnamese_readability_grade_bands_and_match_status() -> None:
    g1_text = "Bé đi học vui quá. Mẹ thương bé rất nhiều."
    assert analyse_verified_text(g1_text) == []

    rep_match = analyse_vietnamese_readability(g1_text, min_grade=1, max_grade=1)
    assert rep_match.estimated_grade_band == "GRADE_1"
    assert rep_match.grade_match_status == "MATCHED"
    assert rep_match.phonics_readiness_score >= 80.0

    rep_easy = analyse_vietnamese_readability(g1_text, min_grade=4, max_grade=5)
    assert rep_easy.grade_match_status == "TOO_EASY"

    hard_text = (
        "Những chiếc thuyền buồm nghiêng mình vượt sóng ngoài khơi xa dưới ánh bình minh "
        "huyền diệu của quê hương tươi đẹp và thanh bình."
    )
    rep_hard = analyse_vietnamese_readability(hard_text, min_grade=1, max_grade=1)
    assert rep_hard.estimated_min_grade >= 3
    assert rep_hard.grade_match_status == "TOO_HARD"
    assert len(rep_hard.sample_complex_syllables) >= 1


def test_duet_reading_segments_studio_v2_blocks_and_poem_fallback() -> None:
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
    assert len(v2_segments) == 2
    assert v2_segments[0].role == "PARENT"
    assert v2_segments[1].role == "CHILD"
    assert v2_segments[1].block_type == "DIALOGUE"

    # Fallback without Studio V2 blocks still alternates Parent and Child turns cleanly
    fallback_segments = build_duet_segments_for_page(words, page_kind="POEM")
    assert len(fallback_segments) == 2
    assert [s.role for s in fallback_segments] == ["PARENT", "CHILD"]


def test_tutor_questions_poem_and_studio_v2_style_bible() -> None:
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
    assert "Loại trang: POEM" in prompt_str
    assert "Bé Mai" in prompt_str
    assert "hiên nhà" in prompt_str

    drafts = generate_rule_based([page], count=2, seed="wave2-poem-seed")
    assert len(drafts) >= 1
    assert drafts[0].type == "CLOZE"


def test_sentence_shooter_accepts_book_page_id_and_prioritizes_page() -> None:
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
    assert payload.book_page_id == page_2_id

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
    import random

    chosen = SentenceShooterService._select_prioritized_candidates(
        candidates,
        1,
        set(),
        random.SystemRandom(),
        preferred_page_id=page_2_id,
    )
    assert len(chosen) == 1
    assert chosen[0][0].page.Id == page_2_id


@pytest.mark.asyncio
async def test_storyweaver_templates_webp_and_unsafe_prompt_guard() -> None:
    webp_bytes = _render_storyweaver_page_webp(1, 3)
    with Image.open(BytesIO(webp_bytes)) as img:
        assert img.format == "WEBP"
        assert img.size == (1200, 1600)

    title, pages = _build_deterministic_story_pages(
        theme="cánh đồng lúa",
        grade=1,
        page_count=3,
        style_mode="DUET_DIALOGUE",
        target_words=["hương lúa", "rộn ràng"],
    )
    assert "cánh đồng lúa" in title
    assert len(pages) == 3
    assert any("hương lúa" in p for p in pages)
    assert all(analyse_verified_text(p) == [] for p in pages)

    fake_db = AsyncMock()
    fake_db.scalar = AsyncMock(return_value="parent")
    fake_db.rollback = AsyncMock()
    svc = FamilyStoryweaverService(fake_db)
    bad_req = ParentStoryweaverRequest(
        theme="truyện ma quỷ kinh dị",
        page_count=3,
        style_mode="PROSE",
    )
    with pytest.raises(HTTPException) as exc_info:
        await svc.create_storyweaver_book(uuid4(), bad_req)
    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == "UNSAFE_STORY_PROMPT"


@pytest.mark.asyncio
async def test_direct_call_picture_catalog_unwraps_query_defaults() -> None:
    actor_id = uuid4()
    child_id = uuid4()
    fake_db = AsyncMock()
    with patch("app.api.routes.picture_description._service") as mock_svc_factory:
        mock_svc = AsyncMock()
        mock_svc.get_catalog = AsyncMock(return_value={"samples": [], "book_pages": []})
        mock_svc_factory.return_value = mock_svc

        # Call directly without FastAPI DI so `book_id` and `book_page_id` remain Query FieldInfo objects
        await get_picture_catalog(child_id=child_id, actor_id=actor_id, db=fake_db)
        mock_svc.get_catalog.assert_awaited_once_with(
            actor_id,
            child_id,
            book_id=None,
            book_page_id=None,
        )
