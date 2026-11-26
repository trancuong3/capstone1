"""Hypothesis property-based tests & V2 OCR pipeline integration wiring tests (G-01, G-02, G-03, G-08).

Runs 100% on CPU (zero GPU / CUDA inference; VIREAD_OCR_MODE=remote_worker or mocked OCR engines).
"""

from __future__ import annotations

import functools
import json
import math
import os
import random
import sys
import unicodedata
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import cv2
import numpy as np
from sqlalchemy.exc import OperationalError

try:
    from hypothesis import given as _hp_given, settings as _hp_settings, strategies as st

    HAS_HYPOTHESIS = True
except ModuleNotFoundError:  # pragma: no cover
    _hp_given = None
    _hp_settings = None
    st = None
    HAS_HYPOTHESIS = False

from app.models.book import Book, BookPage, PageRevision, PageRevisionWord
from app.models.ocr_inference_job import OcrInferenceJob
from app.models.parent_private_book import ParentBookPageSubmission
from app.models.smart_book_studio import PageOcrExtraction
from app.schemas.ocr_extraction import (
    CrossPageContextInput,
    OcrWordInput,
)
from app.services.admin_ocr_service import AdminOcrService
from app.services.ai_capability_router import (
    ALL_TEXT_VISION_CAPABILITIES,
    AiCapability,
    AiCapabilityRouter,
    ProviderSpec,
)
from app.services.ocr_content_extraction import (
    build_semantic_ai_prompt,
    extract_ocr_content,
    persist_committed_parent_page_v2,
    run_stage3_semantic_filter_if_needed,
    validate_semantic_ai_decisions,
)
from app.services.ocr_document_boundary import (
    _compute_perspective_transform,
    map_point_to_rectified,
    map_point_to_source,
)
from app.services.ocr_inference_job_service import (
    JOB_KIND_ADMIN_UPLOAD,
    JOB_KIND_PARENT_SUBMISSION,
    OcrInferenceJobService,
    compute_candidate_hash,
)
from app.services.parent_private_book_pipeline import PipelineHooks, process_submission_stages
from app.services.smart_studio_flags import SmartStudioFlags


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_words(specs: list[dict]) -> list[OcrWordInput]:
    out: list[OcrWordInput] = []
    idx = 0
    for line_idx, spec in enumerate(specs):
        tokens = spec["text"].split()
        x = float(spec.get("x", 0.12))
        y = float(spec.get("y", 0.20 + line_idx * 0.06))
        w_tot = float(spec.get("w", 0.72))
        h = float(spec.get("h", 0.028))
        step = w_tot / max(1, len(tokens))
        for j, tok in enumerate(tokens):
            wx = min(0.96, x + j * step)
            ww = max(0.012, min(step * 0.88, 0.995 - wx))
            out.append(
                OcrWordInput(
                    word_id=f"w-{idx}",
                    source_word_index=idx,
                    line_index=spec.get("line_index", line_idx),
                    text=tok,
                    bbox=[round(wx, 6), round(y, 6), round(ww, 6), round(h, 6)],
                    confidence=spec.get("confidence", 0.95),
                )
            )
            idx += 1
    return out


def _make_png_bytes(width: int = 400, height: int = 520) -> bytes:
    img = np.full((height, width, 3), (40, 50, 65), dtype=np.uint8)
    quad = np.array(
        [[48, 52], [width - 48, 56], [width - 44, height - 52], [44, height - 56]],
        dtype=np.int32,
    )
    cv2.fillConvexPoly(img, quad, (242, 240, 236))
    for y in range(110, height - 110, 42):
        cv2.line(img, (80, y), (width - 80, y), (35, 35, 35), 3)
    ok, encoded = cv2.imencode(".png", img)
    assert ok
    return encoded.tobytes()


class _FakeNestedTx:
    def __init__(self, exc: Exception | None = None):
        self._exc = exc

    async def __aenter__(self):
        if self._exc is not None:
            raise self._exc
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


# ---------------------------------------------------------------------------
# 1. Hypothesis Property-Based Tests
# ---------------------------------------------------------------------------
_PROTECTED_PHRASES = [
    "Bài 1",
    "Chương 2",
    "Bài 3 Mèo con đi học",
    "1 + 2 = 3",
    "10 : 2 = 5",
    "— Chào bạn thỏ nhé!",
    "Câu 1: Vì sao bạn sóc rất vui?",
    "Bài tập 2: Điền số thích hợp vào ô trống.",
    "Ghi nhớ: Luôn giúp đỡ bạn bè xung quanh.",
    "Hình 1: Cây đa đầu làng tỏa bóng mát.",
]
_BODY_WORDS = [
    "Mèo", "con", "đi", "học", "buổi", "sáng", "trời", "nắng", "đẹp",
    "hoa", "nở", "rực", "rỡ", "khắp", "khu", "vườn", "xanh", "mướt",
]


class V2OcrHypothesisPropertyTests(unittest.TestCase):
    if HAS_HYPOTHESIS and st is not None:

        @_hp_settings(max_examples=40, deadline=None)
        @_hp_given(
            tl_x=st.floats(min_value=20.0, max_value=140.0, allow_nan=False, allow_infinity=False),
            tl_y=st.floats(min_value=20.0, max_value=140.0, allow_nan=False, allow_infinity=False),
            tr_dx=st.floats(min_value=320.0, max_value=620.0, allow_nan=False, allow_infinity=False),
            tr_y=st.floats(min_value=20.0, max_value=140.0, allow_nan=False, allow_infinity=False),
            br_dx=st.floats(min_value=320.0, max_value=620.0, allow_nan=False, allow_infinity=False),
            br_dy=st.floats(min_value=420.0, max_value=820.0, allow_nan=False, allow_infinity=False),
            bl_x=st.floats(min_value=20.0, max_value=140.0, allow_nan=False, allow_infinity=False),
            bl_dy=st.floats(min_value=420.0, max_value=820.0, allow_nan=False, allow_infinity=False),
            u=st.floats(min_value=0.05, max_value=0.95, allow_nan=False, allow_infinity=False),
            v=st.floats(min_value=0.05, max_value=0.95, allow_nan=False, allow_infinity=False),
        )
        def test_property_homography_invertibility_le_2px(
            self, tl_x, tl_y, tr_dx, tr_y, br_dx, br_dy, bl_x, bl_dy, u, v
        ):
            quad = np.array(
                [
                    [tl_x, tl_y],
                    [tl_x + tr_dx, tr_y],
                    [bl_x + br_dx, tr_y + br_dy],
                    [bl_x, tl_y + bl_dy],
                ],
                dtype=np.float32,
            )
            mat, inv_mat, _, _ = _compute_perspective_transform(quad)
            # Bilinear interior point of the convex quad
            top_pt = (1.0 - u) * quad[0] + u * quad[1]
            bot_pt = (1.0 - u) * quad[3] + u * quad[2]
            pt = (1.0 - v) * top_pt + v * bot_pt
            sx, sy = float(pt[0]), float(pt[1])

            rx, ry = map_point_to_rectified(sx, sy, mat)
            bx, by = map_point_to_source(rx, ry, inv_mat, already_inverse=True)
            err = math.hypot(bx - sx, by - sy)
            self.assertLessEqual(err, 2.0, f"Homography round-trip exceeded 2px: {err}")

        @_hp_settings(max_examples=35, deadline=None)
        @_hp_given(
            body_lines=st.lists(
                st.lists(st.sampled_from(_BODY_WORDS), min_size=4, max_size=9),
                min_size=2,
                max_size=5,
            ),
            include_page_num=st.booleans(),
            page_num=st.integers(min_value=1, max_value=250),
        )
        def test_property_canonical_extraction_idempotency(
            self, body_lines, include_page_num, page_num
        ):
            specs = [
                {"text": " ".join(line), "x": 0.12, "y": 0.22 + i * 0.08, "w": 0.74}
                for i, line in enumerate(body_lines)
            ]
            if include_page_num:
                specs.append({"text": str(page_num), "x": 0.48, "y": 0.94, "w": 0.05})
            words = _make_words(specs)
            first = extract_ocr_content(words, filter_mode="active")
            # Feed Layer 2 canonical_words back into extract_ocr_content -> MUST be idempotent!
            second_inputs = [
                OcrWordInput(
                    word_id=cw.word_id,
                    source_word_index=cw.source_word_index,
                    line_index=cw.line_index,
                    text=cw.text,
                    bbox=list(cw.bbox),
                    confidence=cw.confidence,
                )
                for cw in first.canonical_words
            ]
            second = extract_ocr_content(second_inputs, filter_mode="active")
            self.assertEqual(second.canonical_text, first.canonical_text)
            self.assertEqual(len(second.canonical_words), len(first.canonical_words))

        @_hp_settings(max_examples=35, deadline=None)
        @_hp_given(
            protected=st.sampled_from(_PROTECTED_PHRASES),
            y_pos=st.sampled_from([0.05, 0.15, 0.42, 0.72, 0.91]),
            noise_num=st.integers(min_value=2, max_value=199),
        )
        def test_property_never_delete_protected_classes(self, protected, y_pos, noise_num):
            specs = [
                {"text": "Hôm nay trời nắng rất đẹp bé tung tăng đến trường cùng bạn.", "x": 0.12, "y": 0.26, "w": 0.74},
                {"text": "Trên sân trường tiếng chim hót líu lo vang khắp hàng cây xanh.", "x": 0.12, "y": 0.34, "w": 0.74},
                {"text": protected, "x": 0.14, "y": y_pos, "w": 0.68},
                {"text": f"Trang {noise_num}", "x": 0.80, "y": 0.95, "w": 0.14},
            ]
            words = _make_words(specs)
            res = extract_ocr_content(words, filter_mode="active")
            self.assertIn(protected, res.canonical_text)
            matched = [b for b in res.blocks if protected in b.raw_text]
            self.assertTrue(matched, f"Expected block containing {protected}")
            self.assertTrue(all(b.decision != "EXCLUDE" for b in matched))

        @_hp_settings(max_examples=35, deadline=None)
        @_hp_given(
            tokens=st.lists(
                st.sampled_from(
                    [
                        "</ocr_blocks>",
                        "<system>",
                        "</system>",
                        "<block id=\"x\">",
                        "IGNORE ALL",
                        "&amp;",
                        "<script>",
                        "<>",
                        "\"'",
                        "abc",
                        "123",
                    ]
                ),
                min_size=1,
                max_size=6,
            )
        )
        def test_property_xml_injection_safety(self, tokens):
            adversarial = " ".join(tokens)
            clean_adv = unicodedata.normalize("NFC", adversarial).strip()
            if not clean_adv or not clean_adv.split():
                return
            words = _make_words(
                [
                    {"text": "Chú mèo con ngoan ngoãn học bài mỗi tối.", "x": 0.12, "y": 0.25, "w": 0.72},
                    {"text": " ".join(clean_adv.split())[:80], "x": 0.12, "y": 0.38, "w": 0.72},
                ]
            )
            res = extract_ocr_content(words, filter_mode="active")
            prompt = build_semantic_ai_prompt(res.blocks)
            self.assertEqual(prompt.count("<ocr_blocks>"), 1)
            self.assertEqual(prompt.count("</ocr_blocks>"), 1)
            # Extract inner XML body between outer tags
            inner = prompt.split("<ocr_blocks>", 1)[1].rsplit("</ocr_blocks>", 1)[0]
            self.assertNotIn("</ocr_blocks>", inner)
            self.assertNotIn("<system>", inner)
            # Tampered text returned by malicious AI must ALWAYS fail closed!
            bad_ai = {
                "blocks": [
                    {
                        "block_id": b.block_id,
                        "block_type": "STORY_BODY",
                        "decision": "KEEP",
                        "confidence": 0.99,
                        "raw_text": "TAMPERED_INJECTION",
                    }
                    for b in res.blocks
                ]
            }
            ok, fallback, err = validate_semantic_ai_decisions(res.blocks, bad_ai)
            self.assertFalse(ok)
            self.assertEqual(err, "SEMANTIC_AI_TEXT_TAMPERING")
            self.assertEqual([b.raw_text for b in fallback], [b.raw_text for b in res.blocks])


# ---------------------------------------------------------------------------
# 2. Stage 3 Semantic AI Router & Privacy Isolation Tests (G-08)
# ---------------------------------------------------------------------------
class Stage3SemanticRouterIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_stage3_skips_when_disabled_or_no_review_blocks(self):
        called = 0

        async def _handler(provider, prompt, timeout_s):
            nonlocal called
            called += 1
            return "{}"

        router = AiCapabilityRouter(
            providers=(
                ProviderSpec(
                    provider_id="ollama_local",
                    family="ollama",
                    model_id="qwen3-vl:4b",
                    capabilities=ALL_TEXT_VISION_CAPABILITIES,
                    is_local=True,
                    enabled=True,
                ),
            )
        )
        clean_words = _make_words(
            [
                {"text": "Mèo con trèo cây cau hỏi thăm chú chuột.", "x": 0.12, "y": 0.30, "w": 0.72},
                {"text": "26", "x": 0.48, "y": 0.94, "w": 0.05},
            ]
        )
        base_clean = extract_ocr_content(clean_words, filter_mode="active")
        self.assertFalse(any(b.decision == "REVIEW" for b in base_clean.blocks))
        out1 = await run_stage3_semantic_filter_if_needed(
            base_clean, router=router, provider_handler=_handler
        )
        self.assertEqual(called, 0)
        self.assertFalse(out1.stats.semantic_ai_invoked)

        # Page WITH a REVIEW block ("I" at top margin), but SMART_SEMANTIC_LAYOUT_ENABLED=false
        review_words = _make_words(
            [
                {"text": "I", "x": 0.48, "y": 0.04, "w": 0.03},
                {"text": "Buổi sáng mùa thu nắng rất dịu dàng trên sân trường.", "x": 0.12, "y": 0.28, "w": 0.74},
                {"text": "Các bạn nhỏ tung tăng vui vẻ vào lớp học mới.", "x": 0.12, "y": 0.35, "w": 0.74},
            ]
        )
        base_review = extract_ocr_content(review_words, filter_mode="active")
        self.assertTrue(any(b.decision == "REVIEW" for b in base_review.blocks))
        disabled_flags = SmartStudioFlags(
            ocr_filter_mode="active",
            semantic_layout_enabled=False,
            cover_studio_enabled=True,
            illustration_extract_enabled=True,
            ai_image_gen_enabled=True,
            global_task_center_enabled=True,
            local_image_worker_url=None,
        )
        out2 = await run_stage3_semantic_filter_if_needed(
            base_review, flags=disabled_flags, router=router, provider_handler=_handler
        )
        self.assertEqual(called, 0)
        self.assertFalse(out2.stats.semantic_ai_invoked)

    async def test_stage3_triggers_on_review_and_enforces_private_book_local_only_privacy(self):
        seen_providers: list[str] = []

        async def _handler(provider, prompt, timeout_s):
            seen_providers.append(provider.provider_id)
            self.assertIn("<ocr_blocks>", prompt)
            # Resolve ambiguous single Roman "I" as PAGE_NUMBER -> EXCLUDE with conf 0.94
            items = []
            for blk in base_review.blocks:
                if blk.raw_text == "I":
                    items.append(
                        {
                            "block_id": blk.block_id,
                            "block_type": "PAGE_NUMBER",
                            "decision": "EXCLUDE",
                            "confidence": 0.94,
                            "reason_vi": "Số trang La Mã đầu trang.",
                        }
                    )
                else:
                    items.append(
                        {
                            "block_id": blk.block_id,
                            "block_type": blk.block_type,
                            "decision": "KEEP",
                            "confidence": 0.97,
                            "reason_vi": blk.reason_vi,
                        }
                    )
            return json.dumps({"blocks": items}, ensure_ascii=False)

        router = AiCapabilityRouter(
            providers=(
                ProviderSpec(
                    provider_id="gemini_primary",
                    family="google",
                    model_id="gemini-2.5-flash-lite",
                    capabilities=ALL_TEXT_VISION_CAPABILITIES,
                    is_local=False,
                    enabled=True,
                    priority_order=10,
                ),
                ProviderSpec(
                    provider_id="ollama_local",
                    family="ollama",
                    model_id="qwen3-vl:4b",
                    capabilities=ALL_TEXT_VISION_CAPABILITIES,
                    is_local=True,
                    enabled=True,
                    priority_order=40,
                ),
            )
        )
        review_words = _make_words(
            [
                {"text": "I", "x": 0.48, "y": 0.04, "w": 0.03},
                {"text": "Buổi sáng mùa thu nắng rất dịu dàng trên sân trường.", "x": 0.12, "y": 0.28, "w": 0.74},
                {"text": "Các bạn nhỏ tung tăng vui vẻ vào lớp học mới.", "x": 0.12, "y": 0.35, "w": 0.74},
            ]
        )
        base_review = extract_ocr_content(review_words, filter_mode="active")
        enabled_flags = SmartStudioFlags(
            ocr_filter_mode="active",
            semantic_layout_enabled=True,
            cover_studio_enabled=True,
            illustration_extract_enabled=True,
            ai_image_gen_enabled=True,
            global_task_center_enabled=True,
            local_image_worker_url=None,
        )

        # Private book MUST skip gemini_primary even if caller passes allow_cloud=True
        # when PRIVATE_BOOK_ALLOW_CLOUD_AI is unset/false!
        with patch.dict(os.environ, {"PRIVATE_BOOK_ALLOW_CLOUD_AI": "false"}, clear=False):
            resolved = await run_stage3_semantic_filter_if_needed(
                base_review,
                source_words=review_words,
                allow_cloud=True,
                is_private_book=True,
                flags=enabled_flags,
                router=router,
                provider_handler=_handler,
            )
        self.assertEqual(seen_providers, ["ollama_local"])
        self.assertTrue(resolved.stats.semantic_ai_invoked)
        self.assertFalse(resolved.stats.semantic_ai_fallback_used)
        self.assertNotIn("I", resolved.canonical_text.split())
        self.assertFalse(resolved.requires_review)


# ---------------------------------------------------------------------------
# 3. Admin OCR Service Wiring Tests (G-01: shadow / active / unmigrated / batch)
# ---------------------------------------------------------------------------
class AdminOcrV2WiringTests(unittest.IsolatedAsyncioTestCase):
    def _make_admin_service(self, *, unmigrated_table: bool = False):
        actor_id = UUID("11111111-1111-4111-8111-111111111111")
        book_id = UUID("22222222-2222-4222-8222-222222222222")
        saved_extractions: list[PageOcrExtraction] = []
        reserved_pages: list[Any] = []

        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.flush = AsyncMock()
        db.scalar = AsyncMock(return_value=None)
        scalars_res = MagicMock()
        scalars_res.all.return_value = []
        db.scalars = AsyncMock(return_value=scalars_res)
        db.begin_nested = MagicMock(
            side_effect=lambda: _FakeNestedTx(
                OperationalError("INSERT page_ocr_extractions", {}, Exception('relation "page_ocr_extractions" does not exist'))
                if unmigrated_table
                else None
            )
        )

        def _add(obj):
            if isinstance(obj, PageOcrExtraction):
                if obj.Id is None:
                    obj.Id = uuid4()
                saved_extractions.append(obj)

        db.add = MagicMock(side_effect=_add)

        service = AdminOcrService(db)
        service.repo = MagicMock()
        service.repo.role = AsyncMock(return_value="admin")
        service.repo.book = AsyncMock(
            return_value=SimpleNamespace(
                Id=book_id,
                Title="Truyện cổ tích",
                Author="Dân gian",
                LifecycleStatus="ACTIVE",
            )
        )
        service.repo.active_pages_for_renumber = AsyncMock(return_value=[])
        service.repo.next_active_page_number = AsyncMock(return_value=1)
        service.repo.flush = AsyncMock()
        service.repo.stage_page_reservation = MagicMock(side_effect=reserved_pages.append)
        service.repo.stage_page_revision_bundle = MagicMock()
        service.repo.set_page_lifecycle_status = MagicMock(
            side_effect=lambda pg, st_val: setattr(pg, "LifecycleStatus", st_val)
        )
        service.repo.page = AsyncMock(
            side_effect=lambda pid, *, lock=False: next(
                (pg for pg in reserved_pages if pg.Id == pid), None
            )
        )
        service._read_validate_image = AsyncMock(
            return_value=(_make_png_bytes(), "image/png", "png", 400, 520)
        )
        service.revision_detail = AsyncMock(return_value=SimpleNamespace(page_id=uuid4()))
        return service, actor_id, book_id, saved_extractions

    def _noisy_ocr_payload(self):
        words = _make_words(
            [
                {"text": "Buổi sáng mùa thu nắng rất dịu dàng trên sân trường.", "x": 0.12, "y": 0.25, "w": 0.74},
                {"text": "Bé An tung tăng mang cặp sách mới vào lớp học.", "x": 0.12, "y": 0.34, "w": 0.74},
                {"text": "26", "x": 0.48, "y": 0.94, "w": 0.05},
            ]
        )
        return {
            "text": "Buổi sáng mùa thu nắng rất dịu dàng trên sân trường.\nBé An tung tăng mang cặp sách mới vào lớp học.\n26",
            "words": [
                {
                    "word_index": idx,
                    "line_index": w.line_index,
                    "text": w.text,
                    "normalized_text": w.text.lower().strip("."),
                    "bbox": list(w.bbox),
                    "ocr_confidence": 0.95,
                }
                for idx, w in enumerate(words)
            ],
            "metadata": {"engine": "hybrid"},
        }

    async def test_admin_ingest_active_vs_shadow_mode_and_unmigrated_savepoint_fallback(self):
        ocr_payload = self._noisy_ocr_payload()

        # 1. ACTIVE mode filters out page number "26" from DraftText & words while keeping Layer 1 OriginalOcrText!
        svc_active, actor_id, book_id, saved_active = self._make_admin_service()
        with (
            patch.dict(os.environ, {"SMART_OCR_FILTER_MODE": "active", "VIREAD_OCR_MODE": "local_inprocess"}, clear=False),
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_payload),
        ):
            await svc_active.upload_page(actor_id, book_id, MagicMock())

        _, rev_active, words_active = svc_active.repo.stage_page_revision_bundle.call_args.args
        self.assertIn("26", rev_active.OriginalOcrText)
        self.assertNotIn("26", rev_active.DraftText)
        self.assertEqual(len(words_active), len(ocr_payload["words"]) - 1)
        self.assertEqual(len(saved_active), 1)
        self.assertEqual(saved_active[0].FilterMode, "active")
        self.assertEqual(len(saved_active[0].StatsJson["source_words"]), len(ocr_payload["words"]))
        self.assertTrue(saved_active[0].GeometryTransformJson)

        # 2. SHADOW mode persists full analysis & stats while keeping DraftText & words 100% raw!
        svc_shadow, actor_id, book_id, saved_shadow = self._make_admin_service()
        with (
            patch.dict(os.environ, {"SMART_OCR_FILTER_MODE": "shadow", "VIREAD_OCR_MODE": "local_inprocess"}, clear=False),
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_payload),
        ):
            await svc_shadow.upload_page(actor_id, book_id, MagicMock())

        _, rev_shadow, words_shadow = svc_shadow.repo.stage_page_revision_bundle.call_args.args
        self.assertEqual(rev_shadow.DraftText, rev_shadow.OriginalOcrText)
        self.assertIn("26", rev_shadow.DraftText)
        self.assertEqual(len(words_shadow), len(ocr_payload["words"]))
        self.assertEqual(len(saved_shadow), 1)
        self.assertEqual(saved_shadow[0].FilterMode, "shadow")
        self.assertEqual(saved_shadow[0].StatsJson["metrics"]["exclude_blocks"], 1)

        # 3. Unmigrated DB degrades gracefully with ZERO HTTP 500!
        svc_unmig, actor_id, book_id, saved_unmig = self._make_admin_service(unmigrated_table=True)
        with (
            patch.dict(os.environ, {"SMART_OCR_FILTER_MODE": "active", "VIREAD_OCR_MODE": "local_inprocess"}, clear=False),
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_payload),
        ):
            await svc_unmig.upload_page(actor_id, book_id, MagicMock())
        self.assertEqual(saved_unmig, [])
        svc_unmig.repo.stage_page_revision_bundle.assert_called_once()

    async def test_upload_document_dispatch_batch_job_option(self):
        svc, actor_id, book_id, _ = self._make_admin_service()
        fake_enqueued = {
            "book_id": str(book_id),
            "source_format": "pdf",
            "total_source_pages": 3,
            "job_ids": ["j1", "j2", "j3"],
            "queued_count": 3,
            "worker_online": True,
            "jobs": [],
        }
        fake_studio_job = SimpleNamespace(Id=uuid4(), JobType="BATCH_BOOK_IMPORT", Status="QUEUED")
        with (
            patch.object(svc, "enqueue_upload_document_jobs", AsyncMock(return_value=fake_enqueued)),
            patch(
                "app.repositories.global_tasks_repository.GlobalTasksRepository.create_or_get_idempotent",
                AsyncMock(return_value=(fake_studio_job, True)),
            ) as mock_create,
            patch("app.services.global_tasks_service.notify_smart_studio_worker") as mock_notify,
        ):
            res = await svc.upload_document(
                actor_id, book_id, MagicMock(filename="story.pdf"), dispatch_batch_job=True
            )
        self.assertIsInstance(res, dict)
        self.assertEqual(res["queued_count"], 3)
        self.assertEqual(res["batch_import_job"]["job_type"], "BATCH_BOOK_IMPORT")
        self.assertEqual(res["batch_import_job"]["status"], "QUEUED")
        mock_create.assert_awaited_once()
        mock_notify.assert_called_once()


# ---------------------------------------------------------------------------
# 4. Parent Private Book Pipeline & Remote OCR Job Wiring Tests (G-02 & G-03)
# ---------------------------------------------------------------------------
class ParentAndRemoteOcrWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_parent_pipeline_wires_boundary_extraction_and_local_privacy(self):
        sub_id = uuid4()
        book_id = uuid4()
        png_bytes = _make_png_bytes()
        sha = __import__("hashlib").sha256(png_bytes).hexdigest()

        sub = SimpleNamespace(
            Id=sub_id,
            BookId=book_id,
            WorkflowStatus="CHECKING",
            SubmissionVersion=1,
            SourceSha256=sha,
            SourceStoragePath="private-books/staging/p1.png",
            SourceType="SELF_AUTHORED",
            SourceNote="Tự viết cho bé.",
            OcrStatus="PENDING",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            IsImageOnly=False,
            OcrText=None,
            OcrWordsJson=[],
            OcrMetaJson={},
            CandidateText=None,
            CandidateWordsJson=[],
            CandidateHash=None,
            TargetPageNumber=2,
            SourcePageNumber=2,
            WorkerId=None,
            LeaseExpiresAt=None,
            UpdatedAt=datetime.now(timezone.utc),
        )

        words = _make_words(
            [
                {"text": "Mèo con đi học buổi sáng rất vui vẻ.", "x": 0.12, "y": 0.28, "w": 0.72},
                {"text": "Cô giáo khen bé đọc bài to và rõ ràng.", "x": 0.12, "y": 0.36, "w": 0.72},
                {"text": "26", "x": 0.48, "y": 0.94, "w": 0.05},
            ]
        )

        def _fake_ocr(_bytes: bytes):
            return (
                "Mèo con đi học buổi sáng rất vui vẻ.\nCô giáo khen bé đọc bài to và rõ ràng.\n26",
                [
                    {
                        "text": w.text,
                        "line_index": w.line_index,
                        "bounding_box": list(w.bbox),
                        "ocr_confidence": 0.95,
                    }
                    for w in words
                ],
                {"engine": "hybrid"},
            )

        proofread_seen: list[str] = []

        class _FakeProofreader:
            async def correct(self, text, _img, _boxes, **_kwargs):
                proofread_seen.append(text)
                return text

        class _FakeSafety:
            async def analyze(self, _text):
                return {
                    "suitability": "SUITABLE",
                    "findings": [],
                    "provider_events": [{"provider": "ollama_local", "chunk_id": 0, "availability": True}],
                }

        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.refresh = AsyncMock()

        fake_repo = MagicMock()
        fake_repo.get_submission = AsyncMock(return_value=sub)
        fake_repo.list_committed_page_texts = AsyncMock(return_value=[])

        with (
            patch.dict(
                os.environ,
                {"SMART_OCR_FILTER_MODE": "active", "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false"},
                clear=False,
            ),
            patch(
                "app.services.parent_private_book_pipeline.ParentPrivateBookRepository",
                return_value=fake_repo,
            ),
        ):
            result = await process_submission_stages(
                db,
                sub_id,
                hooks=PipelineHooks(
                    ocr_fn=_fake_ocr,
                    proofread_orchestrator_factory=_FakeProofreader,
                    safety_orchestrator_factory=_FakeSafety,
                    download_fn=lambda _path: png_bytes,
                ),
            )

        assert result is not None
        self.assertEqual(result.WorkflowStatus, "PASSED_READY_TO_ADD")
        # Layer 1 OcrText retains raw OCR, Layer 2 CandidateText excludes noise "26"
        self.assertIn("26", result.OcrText)
        self.assertNotIn("26", result.CandidateText)
        self.assertEqual(len(proofread_seen), 1)
        self.assertNotIn("26", proofread_seen[0])
        smart_meta = result.OcrMetaJson["smart_ocr_extraction"]
        self.assertFalse(smart_meta["allow_cloud_ai"])
        self.assertTrue(smart_meta["local_ai_enforced"])
        self.assertIsNotNone(smart_meta["geometry_transform"])
        self.assertEqual(smart_meta["stats"]["exclude_blocks"], 1)

    async def test_commit_post_hook_persists_extraction_and_triggers_nonfatal_illustration_extract(self):
        actor_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        png_bytes = _make_png_bytes()

        saved_rows: list[PageOcrExtraction] = []
        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.flush = AsyncMock()
        db.scalar = AsyncMock(return_value=None)
        db.begin_nested = MagicMock(side_effect=lambda: _FakeNestedTx())
        db.add = MagicMock(side_effect=lambda obj: saved_rows.append(obj))

        # Image-only submission must NOT pass synthetic "Trang minh họa" tokens to artwork extractor!
        submission = SimpleNamespace(
            IsImageOnly=True,
            OcrWordsJson=[],
            OcrMetaJson={},
            TargetPageNumber=1,
            SourcePageNumber=1,
        )
        captured_extract_req = []

        class _FakeIllService:
            def __init__(self, _db):
                pass

            async def extract_page_illustration(self, _actor, _book, _page, req, *, page_image_bytes_override=None):
                captured_extract_req.append((req, page_image_bytes_override))
                return SimpleNamespace(status="EXTRACTED_VERIFIED")

        with patch(
            "app.services.book_illustration_service.BookIllustrationService",
            _FakeIllService,
        ):
            outcome = await persist_committed_parent_page_v2(
                db,
                actor_id=actor_id,
                book_id=book_id,
                page_id=page_id,
                revision_id=rev_id,
                submission=submission,
                image_bytes=png_bytes,
                trigger_illustration_extract=True,
            )

        self.assertTrue(outcome["extraction_persisted"])
        self.assertEqual(outcome["illustration_status"], "EXTRACTED_VERIFIED")
        self.assertEqual(len(saved_rows), 1)
        self.assertEqual(saved_rows[0].PageKind, "IMAGE_PRIMARY")
        self.assertEqual(len(captured_extract_req), 1)
        req_arg, bytes_arg = captured_extract_req[0]
        self.assertEqual(req_arg.word_bboxes, [])
        self.assertEqual(req_arg.canonical_text, "")
        self.assertEqual(bytes_arg, png_bytes)

    async def test_remote_complete_job_parent_submission_runs_cpu_extraction_zero_ml(self):
        sub_id = uuid4()
        book_id = uuid4()
        sha = "a" * 64
        cand_hash = compute_candidate_hash("", source_sha256=sha, is_image_only=False)
        now = datetime.now(timezone.utc)

        sub = SimpleNamespace(
            Id=sub_id,
            BookId=book_id,
            OwnerParentId=uuid4(),
            WorkflowStatus="CHECKING",
            SourceSha256=sha,
            SubmissionVersion=1,
            CandidateHash=cand_hash,
            TargetPageNumber=4,
            SourcePageNumber=4,
            CommittedPageId=None,
            CommittedRevisionId=None,
            OptimisticLockVersion=1,
            OcrMetaJson={},
        )
        job = SimpleNamespace(
            Id=uuid4(),
            JobKind=JOB_KIND_PARENT_SUBMISSION,
            Status="RUNNING",
            WorkerId="remote-win-1",
            FencingToken=1,
            BookId=book_id,
            PageId=None,
            RevisionId=None,
            SubmissionId=sub_id,
            ImageSha256=sha,
            ExpectedVersion=1,
            ExpectedCandidateHash=cand_hash,
            ProcessingMeta={},
            ResultPayload=None,
            ModelProfile=None,
            ModelSha256=None,
            EngineDiagnostics=None,
            DurationMs=None,
            LeaseExpiresAt=None,
            CompletedAt=None,
            UpdatedAt=now,
        )

        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.scalar = AsyncMock(side_effect=[None, sub])  # _is_book_deleted=False, then sub

        svc = OcrInferenceJobService(db)
        svc.repo = MagicMock()
        svc.repo.get = AsyncMock(return_value=job)
        svc.repo.touch_worker_heartbeat = AsyncMock()

        raw_words = [
            {
                "word_index": idx,
                "line_index": w.line_index,
                "text": w.text,
                "normalized_text": w.text.lower().strip("."),
                "bbox": list(w.bbox),
                "ocr_confidence": 0.96,
            }
            for idx, w in enumerate(
                _make_words(
                    [
                        {"text": "Chú gấu con đi hái mật ong trong khu rừng xanh.", "x": 0.12, "y": 0.28, "w": 0.74},
                        {"text": "Mật ong thơm ngọt làm cả gia đình gấu rất vui.", "x": 0.12, "y": 0.36, "w": 0.74},
                        {"text": "Trang 4", "x": 0.44, "y": 0.94, "w": 0.12},
                    ]
                )
            )
        ]

        with patch.dict(os.environ, {"SMART_OCR_FILTER_MODE": "active"}, clear=False):
            res = await svc.complete_job(
                job_id=job.Id,
                worker_id="remote-win-1",
                fencing_token=1,
                source_sha256=sha,
                full_text="Chú gấu con đi hái mật ong trong khu rừng xanh.\nMật ong thơm ngọt làm cả gia đình gấu rất vui.\nTrang 4",
                words=raw_words,
                ocr_meta={"engine": "hybrid"},
                no_text_detected=False,
                model_profile="ORIGINAL",
                model_sha256="b" * 64,
                engine_diagnostics={},
                duration_ms=420,
                schedule_post_ocr=False,
            )

        self.assertEqual(res["status"], "SUCCEEDED")
        self.assertIn("Trang 4", sub.OcrText)
        self.assertNotIn("Trang 4", sub.CandidateText)
        self.assertIn("smart_ocr_extraction", sub.OcrMetaJson)
        self.assertEqual(sub.OcrMetaJson["smart_ocr_extraction"]["stats"]["exclude_blocks"], 1)

    def test_apply_to_draft_route_registered_without_duplicate_openapi_paths(self):
        from app.api.router import api_router

        paths = [
            (getattr(route, "path", ""), tuple(sorted(getattr(route, "methods", set()))))
            for route in api_router.routes
            if getattr(route, "path", None)
        ]
        self.assertTrue(
            any(
                path == "/studio/pages/{page_id}/ocr-extraction/apply-to-draft"
                and "POST" in methods
                for path, methods in paths
            ),
            "Expected POST /studio/pages/{page_id}/ocr-extraction/apply-to-draft on api_router",
        )
        # Ensure zero duplicate (path, method) registrations across studio OCR routes
        studio_ocr_pairs = [
            (path, method)
            for path, methods in paths
            if path.startswith("/studio/")
            for method in methods
            if method != "HEAD"
        ]
        self.assertEqual(len(studio_ocr_pairs), len(set(studio_ocr_pairs)))

    def test_outside_page_never_auto_excludes_when_auto_crop_is_false_or_clips_margin_text(self):
        """Regression for #111/#112: ctst_tieng_viet_4_tap_1_page_091.png top-left 'Tuần'."""
        from app.schemas.ocr_extraction import DocumentBoundaryResult, GutterDetectionResult

        clipped_boundary = DocumentBoundaryResult(
            image_width=2481,
            image_height=3508,
            boundary_quad_norm=[[0.0, 0.12], [0.998, 0.094], [0.936, 0.998], [0.014, 0.978]],
            boundary_quad_px=[[0.0, 421.0], [2476.0, 330.0], [2323.0, 3500.0], [35.0, 3430.0]],
            boundary_bbox_norm=[0.0, 0.094, 0.998, 0.904],
            area_ratio=0.8462,
            confidence=0.9353,
            deskew_angle_deg=0.0,
            auto_crop=False,
            requires_crop_review=True,
            clips_margin_text=True,
            transform_matrix=[[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            inverse_transform_matrix=[[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            output_width=2481,
            output_height=3508,
            gutter=GutterDetectionResult(),
            lighting_profile="NORMAL",
            processing_ms=42.0,
            reason_vi="Phát hiện chữ sát mép trang — không tự động cắt để tránh mất chữ.",
        )
        words = _make_words(
            [
                {"text": "Tuần 9", "x": 0.05, "y": 0.04, "w": 0.12, "h": 0.03},
                {"text": "Bầu trời hôm nay xanh trong và mát mẻ.", "x": 0.12, "y": 0.25, "w": 0.72},
                {"text": "Các bạn nhỏ háo hức đọc bài tập đọc mới.", "x": 0.12, "y": 0.34, "w": 0.72},
                {"text": "89", "x": 0.88, "y": 0.94, "w": 0.05, "h": 0.025},
            ]
        )
        res = extract_ocr_content(words, boundary=clipped_boundary, filter_mode="active")
        self.assertIn("Tuần 9", res.canonical_text)
        tuan_blk = [b for b in res.blocks if "Tuần" in b.raw_text][0]
        self.assertNotEqual(tuan_blk.block_type, "OUTSIDE_PAGE")
        self.assertEqual(tuan_blk.decision, "KEEP")
        # Genuine bottom-right page number "89" is STILL cleanly excluded!
        self.assertNotIn("89", res.canonical_text)

    def test_wide_single_page_fixtures_do_not_false_trigger_double_page_gutter(self):
        """Regression for #111/#112: wide landscape single-page strips incl. rotated/vi_rotated_01.png."""
        from app.services.ocr_document_boundary import detect_document_boundary

        fixtures_root = BACKEND_DIR / "tests" / "fixtures" / "ocr"
        if not fixtures_root.exists():
            self.skipTest("OCR fixtures directory not present")

        false_triggers: list[str] = []
        for png_path in sorted(fixtures_root.rglob("*.png")):
            res = detect_document_boundary(png_path.read_bytes())
            if res.gutter.is_double_page:
                false_triggers.append(str(png_path.relative_to(fixtures_root)))
        self.assertEqual(
            false_triggers,
            [],
            f"Single-page fixtures falsely triggered double-page gutter: {false_triggers}",
        )

        # Verify rotated/vi_rotated_01.png keeps exact reading order (0% V2 CER regression)
        rotated_path = fixtures_root / "rotated" / "vi_rotated_01.png"
        if rotated_path.exists():
            rot_boundary = detect_document_boundary(rotated_path.read_bytes())
            self.assertFalse(rot_boundary.gutter.is_double_page)
            self.assertFalse(rot_boundary.gutter.split_recommended)
            rot_words = _make_words(
                [
                    {"text": "Mèo con đi học buổi sáng cùng bạn thỏ trắng.", "x": 0.08, "y": 0.24, "w": 0.84},
                    {"text": "Trên đường đi hai bạn hát vang bài ca vui vẻ.", "x": 0.08, "y": 0.48, "w": 0.84},
                ]
            )
            ext = extract_ocr_content(rot_words, boundary=rot_boundary, filter_mode="active")
            self.assertEqual(
                ext.canonical_text,
                "Mèo con đi học buổi sáng cùng bạn thỏ trắng. Trên đường đi hai bạn hát vang bài ca vui vẻ.",
            )


if __name__ == "__main__":
    unittest.main()
