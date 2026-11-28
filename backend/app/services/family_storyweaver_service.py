"""Family Personal Storyweaver — Co-Created Decodable Vietnamese Mini-Books.

Creates a real, immediately readable 3–4 page `PARENT_PRIVATE` book for a
parent's family shelf (`/my-books`), weaving due difficult words and child
grade readability constraints while keeping all AI, child-safety, and image
storage calls strictly outside PostgreSQL transactions.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import unicodedata
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Callable, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException, status
from PIL import Image, ImageDraw
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.models import Book, BookPage, ChildProfile, PageRevision, PageRevisionWord, Profile
from app.repositories.parent_private_book_repository import ParentPrivateBookRepository
from app.schemas.parent_private_book import (
    ParentPrivateBookDetailRead,
    ParentStoryweaverRequest,
    ParentStoryweaverResponse,
    VietnameseReadabilityRead,
)
from app.services.book_quality_analyzer import analyse_verified_text
from app.services.book_style_bible import analyze_book_style_deterministic
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.parent_private_book_service import (
    MODERATION_ACTIVE,
    VISIBILITY_PARENT_PRIVATE,
    ParentPrivateBookService,
    _coerce_word_bounding_box,
)
from app.services.storage_service import delete_object, upload_object
from app.services.vietnamese_readability import analyse_vietnamese_readability
from app.services.warmup_micro_story_service import WarmupMicroStoryService

logger = logging.getLogger(__name__)

StoryStyleMode = Literal["PROSE", "DUET_DIALOGUE", "POEM"]

_UNSAFE_PROMPT_RE = re.compile(
    r"(?:https?://|www\.|@|\b(?:giết|máu|ma quỷ|kinh dị|chết chóc|đánh đập|vũ khí|"
    r"súng|dao|rượu|bia|thuốc lá|ma túy|cờ bạc|sex|khiêu dâm|tự tử|bạo lực)\b)",
    re.IGNORECASE,
)

_PAGE_WIDTH = 1200
_PAGE_HEIGHT = 1600


def _contains_unsafe_terms(text: str) -> bool:
    return bool(_UNSAFE_PROMPT_RE.search(unicodedata.normalize("NFC", text or "")))


def _render_storyweaver_page_webp(page_number: int, total_pages: int) -> bytes:
    """Render a lightweight warm cream storybook page card (~6-10 KB WebP)."""
    img = Image.new("RGB", (_PAGE_WIDTH, _PAGE_HEIGHT), (253, 250, 243))
    draw = ImageDraw.Draw(img)
    # Double ornamental teal & amber border
    draw.rectangle((36, 36, _PAGE_WIDTH - 36, _PAGE_HEIGHT - 36), outline=(15, 118, 110), width=4)
    draw.rectangle((52, 52, _PAGE_WIDTH - 52, _PAGE_HEIGHT - 52), outline=(217, 119, 6), width=2)
    # Soft header banner bar
    draw.rectangle((80, 84, _PAGE_WIDTH - 80, 148), fill=(236, 253, 245))
    # Subtle ruled reading guide lines
    for y in range(260, _PAGE_HEIGHT - 160, 110):
        draw.line((100, y, _PAGE_WIDTH - 100, y), fill=(231, 226, 214), width=2)
    # Progress dots at bottom
    dot_spacing = 28
    start_x = (_PAGE_WIDTH - (total_pages - 1) * dot_spacing) // 2
    for idx in range(total_pages):
        cx = start_x + idx * dot_spacing
        cy = _PAGE_HEIGHT - 92
        fill = (15, 118, 110) if (idx + 1) == page_number else (209, 213, 219)
        draw.ellipse((cx - 8, cy - 8, cx + 8, cy + 8), fill=fill)

    buf = BytesIO()
    img.save(buf, format="WEBP", quality=80)
    return buf.getvalue()


def _build_deterministic_story_pages(
    *,
    theme: str,
    grade: int,
    page_count: int,
    style_mode: StoryStyleMode,
    target_words: list[str],
) -> tuple[str, list[str]]:
    """Build a cheerful, child-safe, grade-calibrated 3-4 page Vietnamese mini-book."""
    clean_theme = unicodedata.normalize("NFC", theme.strip()) or "khu vườn nhỏ"
    words = [unicodedata.normalize("NFC", w.strip()) for w in target_words if w.strip()]
    w0 = words[0] if len(words) > 0 else "nắng sớm"
    w1 = words[1] if len(words) > 1 else "bông hoa"
    w2 = words[2] if len(words) > 2 else "vui vẻ"
    w3 = words[3] if len(words) > 3 else "chăm chỉ"

    title = f"Chuyến khám phá {clean_theme[:40]}"

    if style_mode == "POEM":
        base_pages = [
            f"Sáng nay mở cửa đón {w0}.\nGió thơm nhẹ ghé {clean_theme}.\nEm cười trong trẻo bên hiên nhỏ.\nBước chân rộn rã nhịp bình yên.",
            f"Kìa bên lối cỏ có {w1}.\nLung linh sắc biếc dưới trời xa.\nChim chuyền cành lá ngân câu hát.\nCả nhà ngắm cảnh thật chan hòa.",
            f"Ba mẹ dắt tay em {w2}.\nĐọc từng trang sách nhỏ thân thương.\nMỗi ngày em rèn thêm {w3}.\nLớn khôn vững bước vạn nẻo đường.",
            f"Chiều buông êm ả nơi {clean_theme}.\nÁnh đèn ấm áp tỏa bên thềm.\nGiữ bao kỷ niệm cùng câu chữ.\nGiấc mơ đẹp đẽ đến dịu êm.",
        ]
    elif style_mode == "DUET_DIALOGUE":
        if grade <= 2:
            base_pages = [
                f"Buổi sáng ở {clean_theme} có {w0} thật ấm.\n— Hôm nay nhà mình cùng dạo bước nhé! Ba mẹ dịu dàng nói.\n— Dạ vâng ạ, con thích lắm!",
                f"Đi qua lối nhỏ, hai mẹ con nhìn thấy {w1} xinh xắn.\n— Con thử nhìn xem {w1} có đẹp không nào?\n— Ôi đẹp quá, nhìn thật {w2} mẹ ơi!",
                f"Hai mẹ con ngồi bên ghế gỗ đọc sách rất {w3}.\n— Con đọc rõ từng tiếng giỏi lắm!\n— Ngày mai mình lại cùng đọc nữa nhé ạ!",
                f"Nắng chiều dịu nhẹ phủ xuống {clean_theme}.\n— Hôm nay con nhớ nhất điều gì nào?\n— Con nhớ {w0}, {w1} và giờ đọc sách ấm áp bên gia đình!",
            ]
        else:
            base_pages = [
                f"Sáng cuối tuần, cả gia đình cùng ghé thăm {clean_theme} khi {w0} vừa lên rực rỡ.\n— Hôm nay chúng mình sẽ cùng quan sát thật kỹ mọi điều kỳ diệu quanh đây nhé!\n— Con sẵn sàng rồi ạ, khung cảnh buổi sớm mới trong lành làm sao!",
                f"Dọc theo con đường rợp bóng mát, cả nhà bắt gặp {w1} đang khoe sắc.\n— Con hãy lắng nghe tiếng gió và miêu tả vẻ đẹp của {w1} theo cách riêng nhé.\n— Con thấy mọi thứ đều tràn đầy sức sống và mang lại cảm giác {w2} lạ thường!",
                f"Sau chuyến dạo chơi, cả nhà mở cuốn sổ nhỏ để ghi lại câu chuyện một cách {w3}.\n— Nhờ đọc sách đều đặn, vốn từ của con ngày càng phong phú hơn rồi đấy.\n— Con muốn tự viết thêm nhiều trang sách kỷ niệm cho gia đình mình!",
                f"Hoàng hôn buông nhẹ trên {clean_theme}, khép lại một ngày khám phá trọn vẹn.\n— Mỗi trang sách con đọc hôm nay đều là một hạt mầm tri thức quý giá.\n— Con cảm ơn ba mẹ đã luôn đồng hành cùng con qua từng câu chữ!",
            ]
    else:
        if grade <= 2:
            base_pages = [
                f"Sáng sớm ở {clean_theme} có {w0} dịu êm. Bé và ba mẹ cùng ra sân ngắm bầu trời xanh trong.",
                f"Bên hàng cây nhỏ có {w1} nở tươi. Chú chim sẻ nhảy nhót trông thật {w2} và đáng yêu.",
                f"Bé ngồi ngay ngắn đọc từng câu chữ thật {w3}. Ba mẹ mỉm cười khen bé đọc rõ ràng.",
                f"Buổi chiều khép lại thật ấm áp nơi {clean_theme}. Bé cất cuốn sách nhỏ lên kệ và hẹn ngày mai đọc tiếp.",
            ]
        else:
            base_pages = [
                f"Buổi sáng cuối tuần tại {clean_theme} bắt đầu bằng ánh {w0} trong trẻo chiếu qua tán lá xanh mát. Cả gia đình hào hứng chuẩn bị cho giờ khám phá thiên nhiên.",
                f"Trên lối đi lát đá, bé phát hiện {w1} tuyệt đẹp đang đung đưa trong làn gió nhẹ. Khung cảnh bình dị ấy khiến ai nấy đều cảm thấy {w2} và thư thái.",
                f"Trở về góc học tập quen thuộc, bé {w3} luyện đọc lại những từ ngữ thú vị vừa bắt gặp. Từng câu văn vang lên mạch lạc và giàu cảm xúc.",
                f"Cuốn sách nhỏ về {clean_theme} trở thành món quà tinh thần đáng nhớ của cả nhà. Mỗi trang sách mở ra thêm bao niềm vui học tập mới.",
            ]

    return title, base_pages[:page_count]


class FamilyStoryweaverService:
    """Orchestrates child-safe grade-matched mini-book creation for `/my-books`."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        upload_fn: Callable[..., Any] = upload_object,
        delete_fn: Callable[..., Any] = delete_object,
        http_post_fn: Callable[..., Any] | None = None,
    ) -> None:
        self.db = db
        self._upload_fn = upload_fn
        self._delete_fn = delete_fn
        self._http_post_fn = http_post_fn

    async def _try_generate_cloud_story(
        self,
        *,
        theme: str,
        grade: int,
        page_count: int,
        style_mode: StoryStyleMode,
        target_words: list[str],
    ) -> tuple[str, list[str]] | None:
        if not OcrCorrectionConfig.private_book_allow_cloud_ai():
            return None
        api_key = (os.getenv("GEMINI_API_KEY") or "").strip()
        if not api_key and self._http_post_fn is None:
            return None

        style_instruction = {
            "POEM": "Mỗi trang là một khổ thơ 4 dòng ngắn gọn, giàu vần điệu tiếng Việt.",
            "DUET_DIALOGUE": (
                "Mỗi trang gồm 1 câu dẫn chuyện cho ba mẹ và 1–2 câu lời thoại bắt đầu bằng dấu gạch ngang '— ' để ba mẹ và bé đọc phân vai."
            ),
            "PROSE": "Mỗi trang gồm 2–3 câu văn xuôi ngắn gọn, trong sáng.",
        }[style_mode]
        sentence_budget = "tối đa 8 tiếng mỗi câu" if grade == 1 else "tối đa 12 tiếng mỗi câu" if grade == 2 else "tối đa 16 tiếng mỗi câu"
        words_str = ", ".join(f'"{w}"' for w in target_words) if target_words else "không bắt buộc"

        prompt = (
            f"Bạn là tác giả sách thiếu nhi tiếng Việt chuẩn sư phạm Tiểu học (Lớp {grade}).\n"
            f"Hãy sáng tác một cuốn sách mỏng gồm đúng {page_count} trang về chủ đề: \"{theme}\".\n"
            f"Yêu cầu bắt buộc:\n"
            f"1. Hình thức: {style_instruction}\n"
            f"2. Độ khó phù hợp Lớp {grade} ({sentence_budget}), ngôn từ ấm áp, an toàn tuyệt đối cho trẻ em, không tên riêng nhạy cảm.\n"
            f"3. Khéo léo lồng ghép các từ luyện đọc sau vào nội dung cuốn sách: {words_str}.\n"
            f"4. Trả về DUY NHẤT JSON hợp lệ theo mẫu: {{\"title\": \"...\", \"pages\": [\"trang 1\", \"trang 2\", ...]}}."
        )
        model = (os.getenv("TUTOR_GEMINI_MODEL") or "gemini-2.5-flash").strip()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.45,
                "maxOutputTokens": 900,
                "responseMimeType": "application/json",
            },
        }
        try:
            if self._http_post_fn is not None:
                data = await self._http_post_fn(url, payload)
            else:
                async with httpx.AsyncClient(timeout=12.0) as client:
                    resp = await client.post(
                        url,
                        headers={"x-goog-api-key": api_key},
                        json=payload,
                    )
                    if resp.status_code >= 400:
                        return None
                    data = resp.json()
            candidates = data.get("candidates") or []
            parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
            raw_json = str(parts[0].get("text") or "").strip() if parts else ""
            if not raw_json:
                return None
            parsed = json.loads(raw_json)
            raw_title = unicodedata.normalize("NFC", str(parsed.get("title") or "").strip())
            raw_pages = parsed.get("pages")
            if not isinstance(raw_pages, list) or len(raw_pages) != page_count:
                return None
            cleaned_pages = [
                unicodedata.normalize("NFC", str(p or "").strip()) for p in raw_pages
            ]
            if any(not p or len(p) > 650 or _contains_unsafe_terms(p) for p in cleaned_pages):
                return None
            if any(analyse_verified_text(p) for p in cleaned_pages):
                return None
            combined = "\n".join(cleaned_pages)
            combined_fold = combined.casefold()
            for target in target_words[:3]:
                if target.casefold() not in combined_fold:
                    return None
            readability = analyse_vietnamese_readability(
                combined, min_grade=grade, max_grade=grade
            )
            if grade <= 2 and readability.estimated_min_grade > grade + 1:
                return None
            return (raw_title or f"Truyện nhỏ về {theme[:40]}"), cleaned_pages
        except Exception as exc:
            logger.info("Storyweaver cloud generation fell back to deterministic template: %s", exc)
            return None

    async def create_storyweaver_book(
        self,
        actor_id: UUID,
        payload: ParentStoryweaverRequest,
        *,
        base_url: str | None = None,
    ) -> ParentStoryweaverResponse:
        # ------------------------------------------------------------------
        # Phase 1: Short DB read for RBAC, child ownership, and due words
        # ------------------------------------------------------------------
        role = await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))
        if role != "parent":
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Chỉ tài khoản phụ huynh mới được tạo sách mỏng gia đình.",
            )

        if _contains_unsafe_terms(payload.theme) or _contains_unsafe_terms(payload.title or ""):
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="UNSAFE_STORY_PROMPT",
            )
        for word in payload.custom_words:
            if _contains_unsafe_terms(word):
                await self.db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="UNSAFE_STORY_PROMPT",
                )

        resolved_grade = payload.target_grade or 1
        due_words: list[str] = []
        if payload.child_id is not None:
            child = await self.db.scalar(
                select(ChildProfile).where(
                    ChildProfile.Id == payload.child_id,
                    ChildProfile.ParentId == actor_id,
                )
            )
            if child is None:
                await self.db.rollback()
                raise HTTPException(status_code=404, detail="Resource not found")
            resolved_grade = payload.target_grade or max(1, min(5, int(child.Grade or 1)))
            try:
                due_tuples = await WarmupMicroStoryService(self.db)._collect_due_words(payload.child_id)
                due_words = [w for w, _ in due_tuples if w]
            except Exception:
                due_words = []

        # Immediately release Supavisor transaction slot before AI/PIL/Storage!
        await self.db.rollback()

        merged_words: list[str] = []
        seen_words: set[str] = set()
        for candidate in [*payload.custom_words, *due_words]:
            clean = " ".join(unicodedata.normalize("NFC", str(candidate or "")).strip().split())[:40]
            if not clean:
                continue
            key = clean.casefold()
            if key not in seen_words:
                seen_words.add(key)
                merged_words.append(clean)
            if len(merged_words) >= 6:
                break

        # ------------------------------------------------------------------
        # Phase 2: Generate story, validate child safety, render & upload images
        # ------------------------------------------------------------------
        generation_source: Literal["AI", "DETERMINISTIC_TEMPLATE"] = "DETERMINISTIC_TEMPLATE"
        cloud_result = await self._try_generate_cloud_story(
            theme=payload.theme,
            grade=resolved_grade,
            page_count=payload.page_count,
            style_mode=payload.style_mode,
            target_words=merged_words,
        )
        if cloud_result is not None:
            generated_title, story_pages = cloud_result
            generation_source = "AI"
        else:
            generated_title, story_pages = _build_deterministic_story_pages(
                theme=payload.theme,
                grade=resolved_grade,
                page_count=payload.page_count,
                style_mode=payload.style_mode,
                target_words=merged_words,
            )

        final_title = (
            unicodedata.normalize("NFC", payload.title.strip())
            if payload.title and payload.title.strip()
            else generated_title
        )[:180]

        book_id = uuid4()
        page_specs: list[tuple[UUID, int, str, str]] = []
        uploaded_paths: list[str] = []

        try:
            for idx, page_text in enumerate(story_pages, start=1):
                page_id = uuid4()
                permanent_path = f"private-books/{actor_id}/{book_id}/pages/{page_id}/rev-1.webp"
                img_bytes = await asyncio.to_thread(
                    _render_storyweaver_page_webp, idx, len(story_pages)
                )
                await asyncio.to_thread(
                    self._upload_fn,
                    permanent_path,
                    img_bytes,
                    "image/webp",
                    bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                    upsert=False,
                )
                uploaded_paths.append(permanent_path)
                page_specs.append((page_id, idx, page_text, permanent_path))

            # ------------------------------------------------------------------
            # Phase 3: Atomic PostgreSQL commit (Book + BookPage + PageRevision + Words)
            # ------------------------------------------------------------------
            repo = ParentPrivateBookRepository(self.db)
            now = datetime.now(timezone.utc)
            book = Book(
                Id=book_id,
                Name=final_title[:250],
                Title=final_title,
                Author="Gia đình & Trạm Sáng Tạo ViRead",
                MinGrade=resolved_grade,
                MaxGrade=resolved_grade,
                ExpectedPageCount=len(page_specs),
                LifecycleStatus="ACTIVE",
                CreatedBy=actor_id,
                VisibilityScope=VISIBILITY_PARENT_PRIVATE,
                OwnerParentId=actor_id,
                ModerationStatus=MODERATION_ACTIVE,
                SourceDeclaration=f"[SELF_AUTHORED] Trạm Sáng Tạo Sách Mỏng Gia Đình ({payload.style_mode})",
                CreatedAt=now,
            )
            await repo.create_private_book(book)

            from app.services.ocr_inference_job_service import (
                align_edited_text_to_words,
                normalize_word,
            )
            from app.services.parent_private_book_pipeline import compute_candidate_hash

            committed_revisions: list[tuple[UUID, UUID, int, str, list[dict[str, Any]]]] = []
            for page_id, page_num, page_text, permanent_path in page_specs:
                raw_words = align_edited_text_to_words(page_text, [])
                cand_hash = compute_candidate_hash(page_text)
                page_row = BookPage(
                    Id=page_id,
                    BookId=book_id,
                    PageNumber=page_num,
                    ImagePath=permanent_path,
                    Width=_PAGE_WIDTH,
                    Height=_PAGE_HEIGHT,
                    ProcessingMeta={
                        "parent_private_book": True,
                        "storyweaver": True,
                        "style_mode": payload.style_mode,
                        "approval_mode": "STORYWEAVER_VERIFIED",
                        "snapshot_hash": cand_hash,
                    },
                    LifecycleStatus="ACTIVE",
                    CreatedAt=now,
                )
                revision_id = uuid4()
                revision_row = PageRevision(
                    Id=revision_id,
                    RevisionNo="1",
                    VerificationStatus="VERIFIED",
                    OriginalOcrText=page_text,
                    VerifiedText=page_text,
                    DraftText=page_text,
                    ContentHash=cand_hash,
                    ProcessingMeta={
                        "source_image_path": permanent_path,
                        "source_image_width": _PAGE_WIDTH,
                        "source_image_height": _PAGE_HEIGHT,
                        "storyweaver": True,
                        "style_mode": payload.style_mode,
                        "approval_mode": "STORYWEAVER_VERIFIED",
                    },
                    VerifiedBy=actor_id,
                    VerifiedAt=now,
                    CreatedAt=now,
                )
                word_rows = [
                    PageRevisionWord(
                        Id=uuid4(),
                        WordIndex=int(w_idx),
                        LineIndex=max(0, int(item.get("line_index", 0) or 0)),
                        Text=str(item["text"]),
                        NormalizedText=str(
                            item.get("normalized_text")
                            or normalize_word(str(item["text"]))
                            or str(item["text"]).lower()
                        ),
                        BoundingBox=_coerce_word_bounding_box(item, w_idx, len(raw_words)),
                        OCRConfidence=1.0,
                    )
                    for w_idx, item in enumerate(raw_words)
                ]
                await repo.create_committed_page(
                    page=page_row,
                    revision=revision_row,
                    words=word_rows,
                )
                committed_revisions.append((page_id, revision_id, page_num, page_text, raw_words))

            await repo.add_audit_log(
                actor_id=actor_id,
                action="parent_private_book.storyweaver_created",
                resource_type="book",
                resource_id=book_id,
                metadata={
                    "visibility_scope": VISIBILITY_PARENT_PRIVATE,
                    "style_mode": payload.style_mode,
                    "page_count": len(page_specs),
                    "generation_source": generation_source,
                    "target_grade": resolved_grade,
                },
            )
            await repo.commit()
        except Exception:
            await self.db.rollback()
            for uploaded in uploaded_paths:
                try:
                    await asyncio.to_thread(
                        self._delete_fn,
                        uploaded,
                        bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                    )
                except Exception:
                    pass
            raise

        # Best-effort Studio V2 enrichment (BookStyleBible + PageOcrExtraction for Duet/Tutor)
        await self._persist_optional_v2_metadata(
            actor_id=actor_id,
            book_id=book_id,
            title=final_title,
            grade=resolved_grade,
            style_mode=payload.style_mode,
            committed_revisions=committed_revisions,
        )

        detail: ParentPrivateBookDetailRead = await ParentPrivateBookService(self.db).get_book(
            actor_id, book_id, base_url=base_url
        )
        combined_text = "\n".join(story_pages)
        readability_report = analyse_vietnamese_readability(
            combined_text, min_grade=resolved_grade, max_grade=resolved_grade
        )
        used_words = [
            w for w in merged_words if w.casefold() in combined_text.casefold()
        ]
        return ParentStoryweaverResponse(
            book_detail=detail,
            target_words_used=used_words,
            generation_source=generation_source,
            readability=VietnameseReadabilityRead(**readability_report.to_dict()),
        )

    async def _persist_optional_v2_metadata(
        self,
        *,
        actor_id: UUID,
        book_id: UUID,
        title: str,
        grade: int,
        style_mode: StoryStyleMode,
        committed_revisions: list[tuple[UUID, UUID, int, str, list[dict[str, Any]]]],
    ) -> None:
        if not callable(getattr(self.db, "begin_nested", None)):
            return
        try:
            from app.models.smart_book_studio import BookStyleBible, PageOcrExtraction

            page_kind = (
                "POEM"
                if style_mode == "POEM"
                else "COMIC"
                if style_mode == "DUET_DIALOGUE"
                else "TEXT_ONLY"
            )
            sample_texts = [p[3] for p in committed_revisions]
            bible = analyze_book_style_deterministic(
                title=title,
                author="Gia đình & Trạm Sáng Tạo ViRead",
                min_grade=grade,
                max_grade=grade,
                sample_texts=sample_texts,
            )
            now = datetime.now(timezone.utc)
            async with self.db.begin_nested():
                self.db.add(
                    BookStyleBible(
                        BookId=book_id,
                        OwnerId=actor_id,
                        ContextHash=compute_candidate_hash("\n".join(sample_texts))[:64],
                        BibleJson=bible.model_dump(mode="json"),
                        ProviderName="deterministic",
                        ModelId="storyweaver-v1",
                        UpdatedAt=now,
                    )
                )
                for page_id, revision_id, _, page_text, raw_words in committed_revisions:
                    lines_by_idx: dict[int, list[int]] = {}
                    for w_idx, item in enumerate(raw_words):
                        li = max(0, int(item.get("line_index", 0) or 0))
                        lines_by_idx.setdefault(li, []).append(w_idx)
                    blocks: list[dict[str, Any]] = []
                    for order_idx, (li, w_idxs) in enumerate(sorted(lines_by_idx.items())):
                        line_txt = " ".join(str(raw_words[i]["text"]) for i in w_idxs).strip()
                        btype = (
                            "POEM_BODY"
                            if style_mode == "POEM"
                            else "DIALOGUE"
                            if line_txt.startswith("—") or line_txt.startswith("-")
                            else "STORY_BODY"
                        )
                        blocks.append(
                            {
                                "block_id": f"b-{order_idx}",
                                "raw_text": line_txt,
                                "display_text": line_txt,
                                "bbox": [0.08, 0.12 + order_idx * 0.15, 0.84, 0.1],
                                "reading_order": order_idx,
                                "column_index": 0,
                                "line_indices": [li],
                                "word_ids": [],
                                "source_word_indices": w_idxs,
                                "block_type": btype,
                                "decision": "KEEP",
                                "in_canonical": True,
                            }
                        )
                    self.db.add(
                        PageOcrExtraction(
                            Id=uuid4(),
                            BookId=book_id,
                            BookPageId=page_id,
                            PageRevisionId=revision_id,
                            OwnerId=actor_id,
                            SourceHash=compute_candidate_hash(page_text)[:64],
                            AlgorithmVersion="storyweaver-v1",
                            FilterMode="active",
                            PageKind=page_kind,
                            GeometryTransformJson={},
                            BlocksJson=blocks,
                            CanonicalText=page_text,
                            StatsJson={"kept_blocks": len(blocks)},
                            RequiresReview=False,
                            CreatedAt=now,
                            UpdatedAt=now,
                        )
                    )
            await self.db.commit()
        except Exception as exc:
            await self.db.rollback()
            logger.debug("Optional Studio V2 metadata skipped for Storyweaver book %s: %s", book_id, exc)
