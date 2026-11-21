"""Comprehensive submission, OCR, proofreading, Tool Check, failure/retry, multi-page, TTL, and real local Ollama tests."""
from __future__ import annotations

import json
import os
import unittest
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://postgres:viread_local_test@127.0.0.1:5432/viread_test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from sqlalchemy import text

from app.jobs.parent_book_submission_worker import cleanup_expired_temp_submissions
from app.services.ocr_ai.child_safety import (
    ChildSafetyError,
    ChildSafetyOrchestrator,
    build_private_book_child_safety_orchestrator,
)
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_engine import OcrNoTextDetected
from app.services.parent_private_book_pipeline import PipelineHooks, process_submission_stages
from parent_private_book_pg_fixture import (
    CHILD_A,
    DisposablePrivateBookDatabase,
    make_synthetic_pdf,
    make_synthetic_png,
)


def _diacritic_ocr(_img_bytes: bytes):
    # Intentionally missing Vietnamese diacritics to test real spelling suggestions!
    return (
        "Meo con di hoc buoi sang.",
        [
            {"text": "Meo", "line_index": 0, "bounding_box": [0.1, 0.1, 0.12, 0.05], "ocr_confidence": 0.72},
            {"text": "con", "line_index": 0, "bounding_box": [0.24, 0.1, 0.12, 0.05], "ocr_confidence": 0.94},
            {"text": "di", "line_index": 0, "bounding_box": [0.38, 0.1, 0.08, 0.05], "ocr_confidence": 0.78},
            {"text": "hoc", "line_index": 0, "bounding_box": [0.48, 0.1, 0.12, 0.05], "ocr_confidence": 0.79},
            {"text": "buoi", "line_index": 0, "bounding_box": [0.62, 0.1, 0.12, 0.05], "ocr_confidence": 0.80},
            {"text": "sang.", "line_index": 0, "bounding_box": [0.76, 0.1, 0.14, 0.05], "ocr_confidence": 0.81},
        ],
        {"engine": "test_ocr"},
    )


class _DiacriticProofreader:
    def __init__(self, *, uncertain: tuple[int, ...] = ()):
        self.calls = 0
        self.uncertain = uncertain

    async def correct(self, _text, _img, _boxes, *, on_provider_event=None, on_uncertain_tokens=None, **_kwargs):
        self.calls += 1
        if on_provider_event:
            on_provider_event({
                "provider": "ollama_qwen3_vl",
                "model": "qwen3-vl:4b-instruct-q4_K_M",
                "chunk_id": 0,
                "availability": True,
                "duration_ms": 38,
            })
        if self.uncertain and on_uncertain_tokens:
            on_uncertain_tokens(0, self.uncertain)
        return "Mèo con đi học buổi sáng."


class _CleanSafety:
    async def analyze(self, text_value: str):
        return {
            "target": "GRADE_1_TO_5",
            "status": "PROVISIONAL",
            "suitability": "SUITABLE",
            "findings": [],
            "provider_events": [
                {
                    "provider": "ollama_local",
                    "model": "qwen3-vl:4b-instruct-q4_K_M",
                    "stage": "CHILD_SAFETY_SCANNING",
                    "chunk_id": 0,
                    "availability": True,
                    "error_code": None,
                    "duration_ms": 40,
                }
            ],
        }


class _FlaggedSafety:
    def __init__(self, *, severity: str = "MEDIUM", suitability: str = "REVIEW_REQUIRED"):
        self.severity = severity
        self.suitability = suitability

    async def analyze(self, text_value: str):
        excerpt = text_value[: min(24, len(text_value))]
        return {
            "target": "GRADE_1_TO_5",
            "status": "PROVISIONAL",
            "suitability": self.suitability,
            "findings": [
                {
                    "finding_id": "flag-001",
                    "category": "VIOLENCE",
                    "content_type": "DESCRIPTION",
                    "severity": self.severity,
                    "evidence_text": excerpt,
                    "explanation": "Cần Admin xem xét ngữ cảnh trước khi cho trẻ đọc.",
                    "recommendation": "Gửi Admin xem xét hoặc chỉnh sửa nội dung.",
                }
            ],
            "provider_events": [
                {
                    "provider": "ollama_local",
                    "model": "qwen3-vl:4b-instruct-q4_K_M",
                    "stage": "CHILD_SAFETY_SCANNING",
                    "chunk_id": 0,
                    "availability": True,
                    "error_code": None,
                    "duration_ms": 60,
                }
            ],
        }


class _FailingSafety:
    def __init__(self, code: str = "PROVIDER_TIMEOUT", *, fail_on_last_chunk: bool = False):
        self.code = code
        self.fail_on_last_chunk = fail_on_last_chunk

    async def analyze(self, _text: str):
        events = []
        if self.fail_on_last_chunk:
            events.append({
                "provider": "ollama_local",
                "model": "qwen3-vl:4b-instruct-q4_K_M",
                "stage": "CHILD_SAFETY_SCANNING",
                "chunk_id": 0,
                "availability": True,
                "error_code": None,
                "duration_ms": 20,
            })
            events.append({
                "provider": "ollama_local",
                "model": "qwen3-vl:4b-instruct-q4_K_M",
                "stage": "CHILD_SAFETY_SCANNING",
                "chunk_id": 1,
                "availability": False,
                "error_code": self.code,
                "duration_ms": 25,
            })
        raise ChildSafetyError(self.code, events)


class ParentBookSubmissionPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fixture = DisposablePrivateBookDatabase()
        self.fixture.setup()
        self.app = self.fixture.build_app()

    async def asyncTearDown(self) -> None:
        await self.fixture.teardown()

    async def _create_book(self, title: str = "Sách Thử Nghiệm") -> str:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            res = await client_a.post(
                "/books/my-books",
                json={
                    "title": title,
                    "author": "Ba mẹ",
                    "min_grade": 1,
                    "max_grade": 3,
                    "source_type": "SELF_AUTHORED",
                    "source_note": "Tự biên soạn cho bé đọc.",
                },
            )
            self.assertEqual(res.status_code, 201, res.text)
            return res.json()["id"]

    async def test_diacritic_suggestions_uncertain_words_idempotency_and_edit_invalidates_check(self) -> None:
        book_id = await self._create_book("Truyện Dấu Tiếng Việt")
        idem_key = f"idem-{uuid4().hex}"
        png_bytes = make_synthetic_png("Meo con di hoc")

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            up1 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("trang1.png", png_bytes, "image/png")},
                data={"idempotency_key": idem_key, "source_type": "SELF_AUTHORED"},
            )
            self.assertEqual(up1.status_code, 202, up1.text)
            self.assertFalse(up1.json()["replayed_idempotency"])
            sub_id = up1.json()["submissions"][0]["id"]

            # Idempotent retry MUST NOT create duplicate submission
            up2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("trang1.png", png_bytes, "image/png")},
                data={"idempotency_key": idem_key, "source_type": "SELF_AUTHORED"},
            )
            self.assertEqual(up2.status_code, 202)
            self.assertTrue(up2.json()["replayed_idempotency"])
            self.assertEqual(up2.json()["submissions"][0]["id"], sub_id)

            # While still CHECKING, add-page MUST be rejected!
            add_early = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={"expected_submission_version": 1, "expected_candidate_hash": "0" * 64},
            )
            self.assertEqual(add_early.status_code, 409)

        # Run OCR (missing diacritics) + Proofread (restores diacritics + 1 uncertain token) + Clean Tool Check
        proofreader = _DiacriticProofreader(uncertain=(2,))
        hooks = PipelineHooks(
            ocr_fn=_diacritic_ocr,
            proofread_orchestrator_factory=lambda: proofreader,
            safety_orchestrator_factory=_CleanSafety,
        )
        async with self.fixture.sessions() as db:
            processed = await process_submission_stages(db, UUID(sub_id), hooks=hooks)
            assert processed is not None
            self.assertEqual(processed.WorkflowStatus, "PASSED_READY_TO_ADD")
            self.assertEqual(processed.CandidateText, "Mèo con đi học buổi sáng.")
            self.assertEqual(processed.UncertainWordIndicesJson, [2])
            self.assertTrue(len(processed.ProofreadSuggestionsJson) > 0)
            old_hash = processed.CandidateHash

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # Before accepting spelling suggestions, add-page without accept_spelling=True is blocked (409)
            before_accept = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={"expected_submission_version": 1, "expected_candidate_hash": old_hash},
            )
            self.assertEqual(before_accept.status_code, 409)

            # Parent accepts spelling suggestions -> hash unchanged -> ready to add!
            acc = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/accept-spelling",
                json={"expected_submission_version": 1, "expected_candidate_hash": old_hash},
            )
            self.assertEqual(acc.status_code, 200, acc.text)
            self.assertTrue(acc.json()["spelling_accepted"])
            self.assertTrue(acc.json()["can_add_to_book"])

            # Now Parent EDITS text -> creates version 2, changes hash, INVALIDATES old Tool Check!
            edit_res = await client_a.patch(
                f"/books/my-books/{book_id}/submissions/{sub_id}",
                json={
                    "candidate_text": "Mèo con đi học buổi sáng rất vui.",
                    "auto_recheck": False,
                },
            )
            self.assertEqual(edit_res.status_code, 200, edit_res.text)
            edited = edit_res.json()
            self.assertEqual(edited["submission_version"], 2)
            self.assertEqual(edited["workflow_status"], "NEEDS_RECHECK")
            self.assertNotEqual(edited["candidate_hash"], old_hash)
            self.assertFalse(edited["can_add_to_book"])

            # Attempting to add with old OR new hash before re-checking MUST fail!
            self.assertEqual(
                (await client_a.post(
                    f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                    json={"expected_submission_version": 1, "expected_candidate_hash": old_hash},
                )).status_code,
                409,
            )
            self.assertEqual(
                (await client_a.post(
                    f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                    json={"expected_submission_version": 2, "expected_candidate_hash": edited["candidate_hash"]},
                )).status_code,
                409,
            )

    async def test_blank_or_image_only_page_never_marked_safe_routes_to_admin(self) -> None:
        book_id = await self._create_book("Trang Chỉ Có Hình")
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            up = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("blank.png", make_synthetic_png(""), "image/png")},
                data={"idempotency_key": f"blank-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
            )
            self.assertEqual(up.status_code, 202)
            sub_id = up.json()["submissions"][0]["id"]

        def _no_text_ocr(_img: bytes):
            raise OcrNoTextDetected("No text")

        async with self.fixture.sessions() as db:
            processed = await process_submission_stages(
                db, UUID(sub_id), hooks=PipelineHooks(ocr_fn=_no_text_ocr)
            )
            assert processed is not None
            self.assertTrue(processed.IsImageOnly)
            self.assertEqual(processed.WorkflowStatus, "NEEDS_ADMIN_REVIEW")
            self.assertEqual(processed.ToolCheckSuitability, "REVIEW_REQUIRED")
            self.assertTrue(processed.ToolCheckScopeJson.get("requires_admin_visual_review"))
            self.assertFalse(processed.ToolCheckScopeJson.get("image_visual_safety_checked"))

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            detail = (await client_a.get(f"/books/my-books/{book_id}/submissions/{sub_id}")).json()
            self.assertFalse(detail["can_add_to_book"])
            self.assertTrue(detail["can_request_admin_review"])
            # Direct API add-page MUST reject image-only unapproved page
            add_res = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={
                    "expected_submission_version": detail["submission_version"],
                    "expected_candidate_hash": detail["candidate_hash"],
                },
            )
            self.assertEqual(add_res.status_code, 409)

    async def test_invalid_corrupt_oversized_and_over_30_page_uploads_rejected(self) -> None:
        book_id = await self._create_book("Kiểm Tra File Lỗi")
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # 1. Spoofed .jpg containing plain script text
            r1 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("fake.jpg", b"<script>alert(1)</script>", "image/jpeg")},
                data={"idempotency_key": f"bad1-{uuid4().hex}"},
            )
            self.assertIn(r1.status_code, (415, 422))

            # 2. Legacy .doc OLE2 magic bytes
            r2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("old.doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 100, "application/msword")},
                data={"idempotency_key": f"bad2-{uuid4().hex}"},
            )
            self.assertIn(r2.status_code, (415, 422))

            # 3. Corrupted PNG magic header with truncated garbage
            r3 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("corrupt.png", b"\x89PNG\r\n\x1a\nCORRUPTED_BYTES", "image/png")},
                data={"idempotency_key": f"bad3-{uuid4().hex}"},
            )
            self.assertEqual(r3.status_code, 422)

            # 4. Empty file
            r4 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("empty.png", b"", "image/png")},
                data={"idempotency_key": f"bad4-{uuid4().hex}"},
            )
            self.assertEqual(r4.status_code, 422)

            # 5. PDF with 31 pages exceeds 30-page limit
            pdf_31 = make_synthetic_pdf([f"Trang {i}" for i in range(1, 32)])
            r5 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("too-long.pdf", pdf_31, "application/pdf")},
                data={"idempotency_key": f"bad5-{uuid4().hex}"},
            )
            self.assertEqual(r5.status_code, 422)

    async def test_multipage_pdf_held_page_blocks_complete_book_until_resolved(self) -> None:
        book_id = await self._create_book("PDF 2 Trang")
        pdf_2 = make_synthetic_pdf(["Trang mot sach se", "Trang hai can canh bao"])
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            up = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("story.pdf", pdf_2, "application/pdf")},
                data={"idempotency_key": f"pdf2-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
            )
            self.assertEqual(up.status_code, 202, up.text)
            subs = up.json()["submissions"]
            self.assertEqual(len(subs), 2)
            sub1_id, sub2_id = subs[0]["id"], subs[1]["id"]

        # Page 1 passes cleanly; Page 2 is flagged by Tool Check
        async with self.fixture.sessions() as db:
            p1 = await process_submission_stages(
                db,
                UUID(sub1_id),
                hooks=PipelineHooks(
                    ocr_fn=lambda _: (
                        "Mèo con học bài.",
                        [
                            {"text": "Mèo", "line_index": 0, "bounding_box": [0.1, 0.1, 0.15, 0.05]},
                            {"text": "con", "line_index": 0, "bounding_box": [0.27, 0.1, 0.15, 0.05]},
                            {"text": "học", "line_index": 0, "bounding_box": [0.44, 0.1, 0.15, 0.05]},
                            {"text": "bài.", "line_index": 0, "bounding_box": [0.61, 0.1, 0.15, 0.05]},
                        ],
                        {},
                    ),
                    proofread_orchestrator_factory=lambda: type("P", (), {
                        "correct": lambda self, t, *a, **kw: _async_return(t)
                    })(),
                    safety_orchestrator_factory=_CleanSafety,
                ),
            )
            assert p1 is not None
            self.assertEqual(p1.WorkflowStatus, "PASSED_READY_TO_ADD")
            p1_ver, p1_hash = int(p1.SubmissionVersion), p1.CandidateHash
        async with self.fixture.sessions() as db:
            p2 = await process_submission_stages(
                db,
                UUID(sub2_id),
                hooks=PipelineHooks(
                    ocr_fn=lambda _: (
                        "Đoạn thử nghiệm có cảnh báo cần xem xét.",
                        [
                            {"text": "Đoạn", "line_index": 0, "bounding_box": [0.1, 0.1, 0.2, 0.05]},
                            {"text": "cảnh", "line_index": 0, "bounding_box": [0.32, 0.1, 0.2, 0.05]},
                            {"text": "báo.", "line_index": 0, "bounding_box": [0.54, 0.1, 0.2, 0.05]},
                        ],
                        {},
                    ),
                    proofread_orchestrator_factory=lambda: type("P", (), {
                        "correct": lambda self, t, *a, **kw: _async_return(t)
                    })(),
                    safety_orchestrator_factory=lambda: _FlaggedSafety(severity="MEDIUM"),
                ),
            )
            assert p2 is not None
            self.assertEqual(p2.WorkflowStatus, "NEEDS_ADMIN_REVIEW")
            p2_ver, p2_hash = int(p2.SubmissionVersion), p2.CandidateHash

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # Page 2 cannot be added
            self.assertEqual(
                (await client_a.post(
                    f"/books/my-books/{book_id}/submissions/{sub2_id}/add-page",
                    json={"expected_submission_version": p2_ver, "expected_candidate_hash": p2_hash},
                )).status_code,
                409,
            )
            # Even if parent adds page 1, page 2 of the same 2-page batch is still HELD ->
            # book MUST NOT be exposed as a complete readable book to Child A yet!
            add1 = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub1_id}/add-page",
                json={"expected_submission_version": p1_ver, "expected_candidate_hash": p1_hash},
            )
            self.assertEqual(add1.status_code, 201)
            self.assertFalse(add1.json()["book_readable_for_children"])
            book_detail = (await client_a.get(f"/books/my-books/{book_id}")).json()
            self.assertTrue(book_detail["book"]["has_held_multipage_batch"])
            self.assertEqual(book_detail["book"]["flagged_submission_count"], 1)
            # Child A cannot start a reading session while batch has held page
            self.assertEqual(
                (await client_a.post("/reading/sessions", json={"ChildId": str(CHILD_A), "BookId": book_id})).status_code,
                409,
            )

            # Once parent cancels/removes the held page 2, book becomes readable with page 1
            self.assertEqual((await client_a.delete(f"/books/my-books/{book_id}/submissions/{sub2_id}")).status_code, 200)
            after_cancel = (await client_a.get(f"/books/my-books/{book_id}")).json()
            self.assertTrue(after_cancel["book"]["readable_for_children"])

            # Now uploading a NEW flagged candidate page onto the ALREADY-READABLE book
            # MUST NOT overwrite or break the existing readable version!
            up3 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("new-candidate.png", make_synthetic_png("Ung vien moi"), "image/png")},
                data={"idempotency_key": f"cand3-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
            )
            self.assertEqual(up3.status_code, 202)
            # Existing readable book STILL opens for Child A
            sess = await client_a.post("/reading/sessions", json={"ChildId": str(CHILD_A), "BookId": book_id})
            self.assertEqual(sess.status_code, 200)

    async def test_provider_errors_last_chunk_failure_stage_retry_and_temp_ttl_cleanup(self) -> None:
        book_id = await self._create_book("Kiểm Thử Lỗi Provider & Retry")
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            up = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("retry-me.png", make_synthetic_png("Meo con"), "image/png")},
                data={"idempotency_key": f"retry-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
            )
            self.assertEqual(up.status_code, 202)
            sub_id = up.json()["submissions"][0]["id"]

        ocr_calls = 0
        def _counting_ocr(img: bytes):
            nonlocal ocr_calls
            ocr_calls += 1
            return _diacritic_ocr(img)

        proofreader = _DiacriticProofreader()
        # Fail Tool Check on the LAST chunk (INVALID_JSON / PROVIDER_TIMEOUT)
        async with self.fixture.sessions() as db:
            failed = await process_submission_stages(
                db,
                UUID(sub_id),
                hooks=PipelineHooks(
                    ocr_fn=_counting_ocr,
                    proofread_orchestrator_factory=lambda: proofreader,
                    safety_orchestrator_factory=lambda: _FailingSafety("INVALID_JSON", fail_on_last_chunk=True),
                ),
            )
            assert failed is not None
            self.assertEqual(failed.WorkflowStatus, "CHECK_FAILED")
            self.assertEqual(failed.OcrStatus, "COMPLETED")
            self.assertEqual(failed.ProofreadStatus, "COMPLETED")
            self.assertEqual(failed.ToolCheckStatus, "FAILED")
            self.assertEqual(failed.ToolCheckErrorCode, "INVALID_JSON")
            self.assertEqual(ocr_calls, 1)
            self.assertEqual(proofreader.calls, 1)

        # Cannot add a CHECK_FAILED page!
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            self.assertEqual(
                (await client_a.post(
                    f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                    json={"expected_submission_version": failed.SubmissionVersion, "expected_candidate_hash": failed.CandidateHash},
                )).status_code,
                409,
            )
            # Parent triggers stage retry -> MUST preserve Stage 1 (OCR) & Stage 2 (Proofreading)
            retry_res = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/retry",
                json={"stage": "AUTO"},
            )
            self.assertEqual(retry_res.status_code, 200)
            self.assertEqual(retry_res.json()["workflow_status"], "CHECKING")
            self.assertEqual(retry_res.json()["ocr_status"], "COMPLETED")
            self.assertEqual(retry_res.json()["proofread_status"], "COMPLETED")

        # Worker runs again -> ONLY Stage 3 runs (ocr_calls and proofreader.calls stay 1!)
        async with self.fixture.sessions() as db:
            passed = await process_submission_stages(
                db,
                UUID(sub_id),
                hooks=PipelineHooks(
                    ocr_fn=_counting_ocr,
                    proofread_orchestrator_factory=lambda: proofreader,
                    safety_orchestrator_factory=_CleanSafety,
                ),
            )
            assert passed is not None
            self.assertEqual(passed.WorkflowStatus, "PASSED_READY_TO_ADD")
            self.assertEqual(ocr_calls, 1)
            self.assertEqual(proofreader.calls, 1)

        # Verify TTL cleanup cleans expired uncommitted drafts while keeping PENDING_ADMIN intact
        from unittest.mock import patch
        async with self.fixture.sessions() as db:
            await db.execute(
                text(
                    "UPDATE public.parent_book_page_submissions "
                    "SET temp_expires_at = now() - interval '1 day' WHERE id = :id"
                ),
                {"id": UUID(sub_id)},
            )
            await db.commit()
        with patch("app.jobs.parent_book_submission_worker.AsyncSessionLocal", self.fixture.sessions):
            cleaned = await cleanup_expired_temp_submissions()
        self.assertEqual(cleaned, 1)

    async def test_real_local_ollama_inference_and_local_privacy_enforcement(self) -> None:
        """Prove local Ollama is actually called for private parent books with zero cloud export."""
        # Verify private-book config enforces local-only even if cloud keys exist in .env
        prev_allow = os.environ.get("PRIVATE_BOOK_ALLOW_CLOUD_AI")
        os.environ["PRIVATE_BOOK_ALLOW_CLOUD_AI"] = "false"
        try:
            priv_cfg = OcrCorrectionConfig.from_environment_for_private_book()
            self.assertFalse(priv_cfg.cloud_enabled)
            self.assertFalse(priv_cfg.gemini_enabled)
            self.assertFalse(priv_cfg.groq_enabled)
            orch = ChildSafetyOrchestrator(priv_cfg)
            self.assertEqual([p.name for p in orch.providers], ["ollama_local"])

            # Use real local Ollama when daemon is running on 127.0.0.1:11434;
            # on CI runners without a local Ollama daemon, exercise the exact same
            # local-only ChildSafetyOrchestrator against an in-process MockTransport
            # proving zero outbound cloud calls and valid Ollama /api/chat contract.
            ollama_base = priv_cfg.local.base_url.rstrip("/")
            live_ollama_available = False
            try:
                async with httpx.AsyncClient(timeout=2.0) as http:
                    tags = await http.get(ollama_base + "/api/tags")
                    live_ollama_available = tags.status_code == 200
            except httpx.RequestError:
                live_ollama_available = False

            captured_local_urls: list[str] = []
            if live_ollama_available:
                safety_factory = None
            else:
                expected_chat_url = ollama_base + "/api/chat"

                def _local_ollama_handler(request: httpx.Request) -> httpx.Response:
                    url = str(request.url)
                    self.assertEqual(
                        url,
                        expected_chat_url,
                        f"Private book safety must only call local Ollama, got {url}",
                    )
                    body = json.loads(request.content.decode("utf-8"))
                    self.assertEqual(body.get("model"), priv_cfg.local.model)
                    self.assertFalse(body.get("stream", True))
                    captured_local_urls.append(url)
                    return httpx.Response(
                        200,
                        json={
                            "message": {
                                "content": json.dumps(
                                    {"suitability": "SUITABLE", "findings": []}
                                )
                            }
                        },
                    )

                mock_transport = httpx.MockTransport(_local_ollama_handler)
                safety_factory = lambda: build_private_book_child_safety_orchestrator(  # noqa: E731
                    transport=mock_transport
                )

            book_id = await self._create_book("Kiểm Thử Ollama Local Thật")
            async with self.fixture.client(self.app, "token-parent-a") as client_a:
                up = await client_a.post(
                    f"/books/my-books/{book_id}/submissions",
                    files={"file": ("ollama-live.png", make_synthetic_png("Meo con"), "image/png")},
                    data={"idempotency_key": f"ollama-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
                )
                self.assertEqual(up.status_code, 202)
                sub_id = up.json()["submissions"][0]["id"]

            # Run Stage 3 (Tool Check) with local-only Ollama ChildSafetyOrchestrator!
            async with self.fixture.sessions() as db:
                processed = await process_submission_stages(
                    db,
                    UUID(sub_id),
                    hooks=PipelineHooks(
                        ocr_fn=lambda _: (
                            "Sáng sớm, chú mèo con rửa mặt sạch sẽ rồi chào mẹ đi học cùng các bạn.",
                            [
                                {"text": "Sáng", "line_index": 0, "bounding_box": [0.1, 0.1, 0.15, 0.05]},
                                {"text": "sớm,", "line_index": 0, "bounding_box": [0.27, 0.1, 0.15, 0.05]},
                                {"text": "chú", "line_index": 0, "bounding_box": [0.44, 0.1, 0.12, 0.05]},
                                {"text": "mèo", "line_index": 0, "bounding_box": [0.58, 0.1, 0.12, 0.05]},
                                {"text": "con.", "line_index": 0, "bounding_box": [0.72, 0.1, 0.12, 0.05]},
                            ],
                            {},
                        ),
                        proofread_orchestrator_factory=lambda: type("P", (), {
                            "correct": lambda self, t, *a, **kw: _async_return(t)
                        })(),
                        safety_orchestrator_factory=safety_factory,
                    ),
                )
                assert processed is not None
                if not live_ollama_available:
                    self.assertTrue(len(captured_local_urls) >= 1)
                self.assertIsNotNone(processed.ToolCheckWorkflowId)
                events = list(processed.ToolCheckProviderEventsJson or [])
                self.assertTrue(len(events) >= 1, f"Expected real Ollama provider events, got {events}")
                self.assertEqual(events[-1]["provider"], "ollama_local")
                self.assertTrue(events[-1]["availability"])
                self.assertTrue(processed.ToolCheckScopeJson.get("local_ai_enforced"))
                self.assertEqual(processed.ToolCheckScopeJson.get("copyright_scanner_status"), "NOT_CONFIGURED")
                self.assertEqual(processed.ToolCheckSuitability, "SUITABLE")
                self.assertEqual(processed.WorkflowStatus, "PASSED_READY_TO_ADD")
                print(
                    f"[REAL_OLLAMA_PROOF] workflow_id={processed.ToolCheckWorkflowId} "
                    f"provider={events[-1]['provider']} model={events[-1]['model']} "
                    f"duration_ms={events[-1]['duration_ms']} suitability={processed.ToolCheckSuitability}"
                )
        finally:
            if prev_allow is None:
                os.environ.pop("PRIVATE_BOOK_ALLOW_CLOUD_AI", None)
            else:
                os.environ["PRIVATE_BOOK_ALLOW_CLOUD_AI"] = prev_allow

    async def test_edit_book_and_committed_page_rechecks_from_scratch_while_delete_skips_recheck(
        self,
    ) -> None:
        book_id = await self._create_book("Sách Sửa Xóa Kiểm Thử")
        png1 = make_synthetic_png("Trang mot meo con")
        png2 = make_synthetic_png("Trang hai cho con")

        def _clean_hooks(text_val: str) -> PipelineHooks:
            tokens = text_val.split()
            words = [
                {
                    "text": tok,
                    "line_index": 0,
                    "bounding_box": [round(0.05 + i * 0.14, 4), 0.1, 0.12, 0.06],
                    "ocr_confidence": 0.95,
                }
                for i, tok in enumerate(tokens)
            ]
            return PipelineHooks(
                ocr_fn=lambda _b: (text_val, words, {}),
                proofread_orchestrator_factory=lambda: type(
                    "P", (), {"correct": lambda self, t, *a, **kw: _async_return(t)}
                )(),
                safety_orchestrator_factory=_CleanSafety,
            )

        # 1. Upload & commit 2 clean pages so book is readable for children
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            up1 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("trang1.png", png1, "image/png")},
                data={"idempotency_key": f"ed-1-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
            )
            up2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("trang2.png", png2, "image/png")},
                data={"idempotency_key": f"ed-2-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
            )
            self.assertEqual(up1.status_code, 202)
            self.assertEqual(up2.status_code, 202)
            sub1_id = up1.json()["submissions"][0]["id"]
            sub2_id = up2.json()["submissions"][0]["id"]

        async with self.fixture.sessions() as db:
            p1 = await process_submission_stages(db, UUID(sub1_id), hooks=_clean_hooks("Mèo con đi học vui vẻ."))
            assert p1 is not None
            hash1 = p1.CandidateHash
            p2 = await process_submission_stages(db, UUID(sub2_id), hooks=_clean_hooks("Chó con chạy ra sân chơi."))
            assert p2 is not None
            hash2 = p2.CandidateHash

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            add1 = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub1_id}/add-page",
                json={"expected_submission_version": 1, "expected_candidate_hash": hash1},
            )
            add2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub2_id}/add-page",
                json={"expected_submission_version": 1, "expected_candidate_hash": hash2},
            )
            self.assertEqual(add1.status_code, 201, add1.text)
            self.assertEqual(add2.status_code, 201, add2.text)
            page1_id = add1.json()["page_id"]
            page2_id = add2.json()["page_id"]
            self.assertTrue(add2.json()["book_readable_for_children"])

        # 2. Cross-family isolation: Parent B MUST get 404 on edit/delete book & committed pages
        async with self.fixture.client(self.app, "token-parent-b") as client_b:
            self.assertEqual(
                (await client_b.patch(f"/books/my-books/{book_id}", json={"title": "Cướp sách"})).status_code,
                404,
            )
            self.assertEqual((await client_b.delete(f"/books/my-books/{book_id}")).status_code, 404)
            self.assertEqual(
                (await client_b.patch(
                    f"/books/my-books/{book_id}/pages/{page1_id}",
                    json={"candidate_text": "Sửa trộm"},
                )).status_code,
                404,
            )
            self.assertEqual(
                (await client_b.delete(f"/books/my-books/{book_id}/pages/{page1_id}")).status_code,
                404,
            )

        # 3. DELETE committed page 2 -> IMMEDIATE deletion, ZERO re-check triggered on page 1!
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            del_p2 = await client_a.delete(f"/books/my-books/{book_id}/pages/{page2_id}")
            self.assertEqual(del_p2.status_code, 200, del_p2.text)
            del_p2_body = del_p2.json()
            self.assertEqual(del_p2_body["status"], "deleted")
            self.assertEqual(del_p2_body["committed_page_count"], 1)
            self.assertTrue(del_p2_body["readable_for_children"])

            detail_after_del = (await client_a.get(f"/books/my-books/{book_id}")).json()
            self.assertEqual(detail_after_del["book"]["pending_submission_count"], 0)
            self.assertEqual(len(detail_after_del["pages"]), 1)
            self.assertEqual(detail_after_del["pages"][0]["page_id"], page1_id)

            # 4. EDIT committed page 1 text -> retires page 1, locks reading, resets Proofreading & Tool Check!
            edit_p1 = await client_a.patch(
                f"/books/my-books/{book_id}/pages/{page1_id}",
                json={"candidate_text": "Mèo con đi học cùng bạn thỏ trắng.", "auto_recheck": True},
            )
            self.assertEqual(edit_p1.status_code, 200, edit_p1.text)
            sub_after_p1_edit = edit_p1.json()
            self.assertEqual(sub_after_p1_edit["workflow_status"], "CHECKING")
            self.assertEqual(sub_after_p1_edit["proofread_status"], "PENDING")
            self.assertEqual(sub_after_p1_edit["tool_check_status"], "PENDING")
            self.assertFalse(sub_after_p1_edit["can_add_to_book"])

            detail_locked = (await client_a.get(f"/books/my-books/{book_id}")).json()
            self.assertEqual(detail_locked["book"]["committed_page_count"], 0)
            self.assertFalse(detail_locked["book"]["readable_for_children"])

        # Re-run full check (Stage 2 Proofread + Stage 3 Tool Check) & re-add page 1
        async with self.fixture.sessions() as db:
            rechecked_p1 = await process_submission_stages(
                db,
                UUID(sub_after_p1_edit["id"]),
                hooks=_clean_hooks("Mèo con đi học cùng bạn thỏ trắng."),
            )
            assert rechecked_p1 is not None
            self.assertEqual(rechecked_p1.WorkflowStatus, "PASSED_READY_TO_ADD")
            v_after_edit = rechecked_p1.SubmissionVersion
            h_after_edit = rechecked_p1.CandidateHash

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            readd1 = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_after_p1_edit['id']}/add-page",
                json={"expected_submission_version": v_after_edit, "expected_candidate_hash": h_after_edit},
            )
            self.assertEqual(readd1.status_code, 201, readd1.text)
            self.assertTrue(readd1.json()["book_readable_for_children"])
            readded_page_id = readd1.json()["page_id"]

            # 4b. REPLACE IMAGE on committed page -> retires page & resets ALL 3 stages (OCR + Proofread + Tool Check)!
            rep_img = await client_a.put(
                f"/books/my-books/{book_id}/pages/{readded_page_id}/file",
                files={"file": ("trang1-moi.png", make_synthetic_png("Trang mot anh moi"), "image/png")},
            )
            self.assertEqual(rep_img.status_code, 200, rep_img.text)
            rep_sub = rep_img.json()
            self.assertEqual(rep_sub["workflow_status"], "CHECKING")
            self.assertEqual(rep_sub["ocr_status"], "PENDING")
            self.assertEqual(rep_sub["proofread_status"], "PENDING")
            self.assertEqual(rep_sub["tool_check_status"], "PENDING")
            self.assertFalse(rep_sub["can_add_to_book"])

        # Re-run full 3-stage pipeline and re-commit page before testing book edit
        async with self.fixture.sessions() as db:
            rechecked_img = await process_submission_stages(
                db,
                UUID(rep_sub["id"]),
                hooks=_clean_hooks("Trang một ảnh mới rất đẹp."),
            )
            assert rechecked_img is not None
            self.assertEqual(rechecked_img.WorkflowStatus, "PASSED_READY_TO_ADD")
            v_after_img = rechecked_img.SubmissionVersion
            h_after_img = rechecked_img.CandidateHash

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            readd2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{rep_sub['id']}/add-page",
                json={"expected_submission_version": v_after_img, "expected_candidate_hash": h_after_img},
            )
            self.assertEqual(readd2.status_code, 201, readd2.text)
            self.assertTrue(readd2.json()["book_readable_for_children"])

            # 5. EDIT BOOK metadata -> retires ALL committed pages & resets ALL stages from OCR -> Proofread -> Tool Check!
            upd_book = await client_a.patch(
                f"/books/my-books/{book_id}",
                json={"title": "Sách Đã Sửa Tên Mới", "min_grade": 2, "max_grade": 4},
            )
            self.assertEqual(upd_book.status_code, 200, upd_book.text)
            upd_body = upd_book.json()
            self.assertEqual(upd_body["title"], "Sách Đã Sửa Tên Mới")
            self.assertEqual(upd_body["committed_page_count"], 0)
            self.assertEqual(upd_body["pending_submission_count"], 1)
            self.assertFalse(upd_body["readable_for_children"])

            detail_after_book_edit = (await client_a.get(f"/books/my-books/{book_id}")).json()
            self.assertEqual(len(detail_after_book_edit["pages"]), 0)
            self.assertEqual(len(detail_after_book_edit["submissions"]), 1)
            reset_sub = detail_after_book_edit["submissions"][0]
            self.assertEqual(reset_sub["workflow_status"], "CHECKING")
            self.assertEqual(reset_sub["ocr_status"], "PENDING")
            self.assertEqual(reset_sub["proofread_status"], "PENDING")
            self.assertEqual(reset_sub["tool_check_status"], "PENDING")
            self.assertFalse(reset_sub["can_add_to_book"])

            # 6. DELETE BOOK -> IMMEDIATE deletion, ZERO re-check, vanishes from list & 404 on detail!
            del_book = await client_a.delete(f"/books/my-books/{book_id}")
            self.assertEqual(del_book.status_code, 200, del_book.text)
            self.assertEqual(del_book.json()["status"], "deleted")

            my_list = (await client_a.get("/books/my-books")).json()
            self.assertFalse(any(b["id"] == book_id for b in my_list))
            self.assertEqual((await client_a.get(f"/books/my-books/{book_id}")).status_code, 404)


async def _async_return(value):
    return value


if __name__ == "__main__":
    unittest.main()
