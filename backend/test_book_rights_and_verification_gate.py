"""Unit and integration-style tests for Rights Evidence, Page Diagnostics, and Verification Gate."""
from __future__ import annotations

import hashlib
import json
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException

from app.policies.book_approval import LEGACY_BOOK_APPROVAL_POLICY_VERSION
from app.schemas.admin_ocr import AdminOcrDraftRequest, AdminOcrVerifyRequest
from app.schemas.book_content_quality import (
    BookQualityBookDecisionRequest,
    BookRightsEvidenceUpsert,
)
from app.services.admin_ai_workflow_service import AdminAiWorkflowService
from app.services.admin_ocr_service import AdminOcrService, safety_content_hash
from app.services.book_content_quality_service import BookContentQualityService


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
BOOK_ID = UUID("55555555-5555-4555-8555-555555555555")
PAGE_ID = UUID("22222222-2222-4222-8222-222222222222")
REVISION_ID = UUID("33333333-3333-4333-8333-333333333333")
WORKFLOW_ID = UUID("44444444-4444-4444-8444-444444444444")
IMAGE_SHA = "e" * 64


def _verify_payload(
    *,
    text: str = "Bé học bài.",
    workflow_id: UUID | None = WORKFLOW_ID,
    mode: str = "AI_CHECKED",
    expected_image_sha256: str | None = IMAGE_SHA,
    expected_rights_version: int | None = None,
) -> AdminOcrVerifyRequest:
    tokens = text.split()
    words = [
        {
            "word_index": idx,
            "line_index": 0,
            "text": tok,
            "normalized_text": tok.strip(".,!?;:").casefold(),
            "bbox": [0.05 + idx * 0.2, 0.1, 0.15, 0.1],
            "ocr_confidence": 0.92,
        }
        for idx, tok in enumerate(tokens)
    ]
    return AdminOcrVerifyRequest(
        page_revision_id=REVISION_ID,
        workflow_id=workflow_id,
        expected_image_sha256=expected_image_sha256,
        expected_rights_version=expected_rights_version,
        corrected_text=text,
        words=words,
        proofread_audit={
            "mode": mode,
            "checked_text": text,
            "suggestions": [],
            "reason_code": "AI_CHECK_UNAVAILABLE" if mode == "MANUAL_FALLBACK" else None,
        },
    )


def _valid_workflow(text: str = "Bé học bài.", **overrides):
    digest = safety_content_hash(text)
    fields = {
        "Id": WORKFLOW_ID,
        "PageId": PAGE_ID,
        "BookId": BOOK_ID,
        "PageRevisionId": REVISION_ID,
        "ImagePath": "books/test/page1.png",
        "SourceImageSha256": IMAGE_SHA,
        "ProofreadText": text,
        "CorrectionSuggestions": [],
        "CandidateText": text,
        "CandidateHash": digest,
        "SafetyInputHash": digest,
        "SafetyStatus": "CONFIRMED",
        "SafetyConfirmedBy": ACTOR_ID,
        "SafetyConfirmedAt": datetime.now(timezone.utc),
        "Status": "READY_FOR_ADMIN_REVIEW",
        "Stage": "READY_FOR_ADMIN_REVIEW",
        "Suitability": "SUITABLE",
        "Findings": [],
        "SafetyMetadata": {
            "chunks_total": 1,
            "chunks_completed": 1,
            "all_chunks_completed": True,
            "text_safety_status": "CONFIRMED",
            "image_safety_status": "UNASSESSED_NO_VISION_MODEL",
        },
        "ImageSafetyStatus": "ADMIN_CONFIRMED_SAFE",
        "ImageSafetyImageSha256": IMAGE_SHA,
        "ImageSafetyReviewedBy": ACTOR_ID,
        "ImageSafetyReviewedAt": datetime.now(timezone.utc),
        "OcrApprovedAt": None,
        "OcrApprovedBy": None,
        "FinalApprovedTextHash": None,
        "ReviewEvents": [],
        "SafetyHistory": [],
        "UpdatedAt": datetime.now(timezone.utc),
    }
    return SimpleNamespace(**(fields | overrides))


def _valid_rights(**overrides):
    fields = {
        "Id": uuid4(),
        "BookId": BOOK_ID,
        "PageId": None,
        "Scope": "BOOK",
        "Status": "RIGHTS_REVIEWED",
        "SourceDescription": "Sách giáo dục công cộng - nguồn thư viện mở",
        "AuthorOrRightsHolder": "Tác giả tổng hợp",
        "UsageBasis": "OPEN_LICENSE",
        "EvidenceUrlOrRef": "https://library.example.org/license/cc-by-4.0",
        "Notes": "Đã đối chiếu giấy phép CC-BY 4.0.",
        "Version": 1,
        "ContentFingerprint": "f" * 64,
        "ReviewedBy": ACTOR_ID,
        "ReviewedByNameSnapshot": "Admin QA",
        "ReviewedAt": datetime.now(timezone.utc),
        "CreatedAt": datetime.now(timezone.utc),
        "UpdatedAt": datetime.now(timezone.utc),
    }
    return SimpleNamespace(**(fields | overrides))


class _RightsRepoFake:
    def __init__(self, *, role: str = "admin"):
        self._role = role
        self.book_row = SimpleNamespace(
            Id=BOOK_ID,
            Title="Truyện Thiếu Nhi Mẫu",
            Author="Tác giả Mẫu",
            LifecycleStatus="DRAFT",
        )
        self.page_row = SimpleNamespace(
            Id=PAGE_ID,
            BookId=BOOK_ID,
            PageNumber=1,
            ImagePath="books/test/p1.png",
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=REVISION_ID,
        )
        self.revision_row = SimpleNamespace(
            Id=REVISION_ID,
            PageId=PAGE_ID,
            VerificationStatus="VERIFIED",
            ContentHash="rev-hash-1",
            VerifiedText="Bé học bài.",
            DraftText="Bé học bài.",
            OriginalOcrText="Bé học bài.",
            VerifiedBy=ACTOR_ID,
            VerifiedAt=datetime.now(timezone.utc),
            ProcessingMeta={"source_image_sha256": IMAGE_SHA},
        )
        self.workflow_row = _valid_workflow()
        self.rights_by_scope: dict[tuple[str, UUID | None], object] = {}
        self.history: list[object] = []
        self.decisions: list[object] = []

    async def role(self, _actor_id):
        return self._role

    async def profile_name(self, _actor_id):
        return "Admin QA"

    async def book(self, book_id, *, lock=False):
        return self.book_row if book_id == BOOK_ID else None

    async def page(self, page_id, *, lock=False):
        return self.page_row if page_id == PAGE_ID else None

    async def book_assessment_rows(self, _book_id, *, lock=False):
        return [
            (
                self.page_row,
                self.revision_row,
                self.workflow_row,
                "fh-1",
                "sm-1",
                "pm-1",
            )
        ]

    async def book_decisions(self, _book_id):
        return list(self.decisions)

    async def add_book_decision(self, *, actor_id, book_id, action, metadata, request_id):
        row = SimpleNamespace(
            Id=uuid4(),
            ActorId=actor_id,
            ResourceId=book_id,
            Action=action,
            Metadata=metadata,
            RequestId=request_id,
            CreatedAt=datetime.now(timezone.utc),
        )
        self.decisions.append(row)
        return row

    async def get_rights_evidence(self, book_id, *, page_id=None, lock=False):
        scope = "PAGE" if page_id is not None else "BOOK"
        return self.rights_by_scope.get((scope, page_id))

    async def list_rights_history(self, book_id, *, page_id=None):
        scope = "PAGE" if page_id is not None else "BOOK"
        return [
            item
            for item in reversed(self.history)
            if item.Scope == scope and item.PageId == page_id
        ]

    async def add_rights_evidence(self, row):
        self.rights_by_scope[(row.Scope, row.PageId)] = row

    async def add_rights_history(self, row):
        self.history.append(row)

    async def commit(self):
        return None

    async def rollback(self):
        return None

    async def refresh(self, _entity):
        return None


class RightsEvidenceServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_rights_evidence_requires_fields_versions_history_and_detects_content_staleness(self):
        repo = _RightsRepoFake()
        service = BookContentQualityService(repo)

        # Default is UNASSESSED (never NOT_CONFIGURED)
        initial = await service.get_book_rights(ACTOR_ID, BOOK_ID)
        self.assertEqual(initial.status, "UNASSESSED")
        self.assertEqual(initial.effective_status, "UNASSESSED")
        self.assertEqual(initial.version, 0)

        # Cannot mark RIGHTS_REVIEWED without source, usage_basis, and evidence_url_or_ref
        with self.assertRaises(HTTPException) as incomplete:
            await service.upsert_book_rights(
                ACTOR_ID,
                BOOK_ID,
                BookRightsEvidenceUpsert(
                    scope="BOOK",
                    status="RIGHTS_REVIEWED",
                    source_description="Nguồn mẫu",
                    usage_basis="OPEN_LICENSE",
                    evidence_url_or_ref=None,
                ),
            )
        self.assertEqual(incomplete.exception.status_code, 422)
        self.assertEqual(incomplete.exception.detail["code"], "RIGHTS_EVIDENCE_INCOMPLETE")

        # Cannot mark CONCERN_FLAGGED without notes
        with self.assertRaises(HTTPException) as no_note:
            await service.upsert_book_rights(
                ACTOR_ID,
                BOOK_ID,
                BookRightsEvidenceUpsert(scope="BOOK", status="CONCERN_FLAGGED"),
            )
        self.assertEqual(no_note.exception.status_code, 422)
        self.assertEqual(no_note.exception.detail["code"], "RIGHTS_CONCERN_NOTE_REQUIRED")

        # Valid RIGHTS_REVIEWED saves version 1 and history
        v1 = await service.upsert_book_rights(
            ACTOR_ID,
            BOOK_ID,
            BookRightsEvidenceUpsert(
                scope="BOOK",
                status="RIGHTS_REVIEWED",
                source_description="Thư viện mở thiếu nhi",
                author_or_rights_holder="Tác giả Mẫu",
                usage_basis="OPEN_LICENSE",
                evidence_url_or_ref="https://open-license.example.org/doc-1",
                notes="Đã kiểm tra nguồn phát hành.",
            ),
        )
        self.assertEqual(v1.status, "RIGHTS_REVIEWED")
        self.assertEqual(v1.effective_status, "RIGHTS_REVIEWED")
        self.assertFalse(v1.is_stale)
        self.assertEqual(v1.version, 1)
        self.assertEqual(len(v1.history), 1)
        self.assertIsNone(v1.history[0].from_status)
        self.assertEqual(v1.history[0].to_status, "RIGHTS_REVIEWED")

        # Updating increments version to 2 and preserves history
        v2 = await service.upsert_book_rights(
            ACTOR_ID,
            BOOK_ID,
            BookRightsEvidenceUpsert(
                scope="BOOK",
                status="RIGHTS_REVIEWED",
                source_description="Thư viện mở thiếu nhi (bản cập nhật)",
                author_or_rights_holder="Tác giả Mẫu",
                usage_basis="OPEN_LICENSE",
                evidence_url_or_ref="https://open-license.example.org/doc-2",
            ),
        )
        self.assertEqual(v2.version, 2)
        self.assertEqual(len(v2.history), 2)

        # Changing book content invalidates rights automatically (STALE_RIGHTS_REVIEW)
        repo.revision_row.ContentHash = "rev-hash-changed"
        stale_read = await service.get_book_rights(ACTOR_ID, BOOK_ID)
        self.assertTrue(stale_read.is_stale)
        self.assertEqual(stale_read.effective_status, "STALE_RIGHTS_REVIEW")

        # Rights evidence is currently optional/advisory: stale rights does not block approval
        # once OCR + Proofreading + Text/Image Child Safety are complete.
        approved_res = await service.decide_book(
            ACTOR_ID,
            BOOK_ID,
            BookQualityBookDecisionRequest(
                decision="APPROVE",
                reason="Duyệt sau khi hoàn tất OCR, chính tả và an toàn nội dung/hình ảnh",
                rights_confirmed=False,
            ),
        )
        self.assertEqual(approved_res.assessment.status, "APPROVED_BY_ADMIN")

    async def test_parent_cannot_read_or_write_rights_evidence(self):
        repo = _RightsRepoFake(role="parent")
        service = BookContentQualityService(repo)
        with self.assertRaises(HTTPException) as get_err:
            await service.get_book_rights(ACTOR_ID, BOOK_ID)
        self.assertEqual(get_err.exception.status_code, 403)
        with self.assertRaises(HTTPException) as put_err:
            await service.upsert_book_rights(
                ACTOR_ID,
                BOOK_ID,
                BookRightsEvidenceUpsert(scope="BOOK", status="UNASSESSED"),
            )
        self.assertEqual(put_err.exception.status_code, 403)

    async def test_auto_publish_is_disabled_and_legacy_auto_approved_books_remain_readable(self):
        repo = _RightsRepoFake()
        service = BookContentQualityService(repo)

        # Auto-publish MUST NEVER mutate book status or insert AUTO_APPROVAL
        published = await service.auto_publish_if_eligible(BOOK_ID)
        self.assertFalse(published)
        self.assertEqual(repo.book_row.LifecycleStatus, "DRAFT")
        self.assertEqual(repo.decisions, [])

        # Legacy v2 AUTO_APPROVAL decision remains PUBLISHED without mass re-approval
        rows = await repo.book_assessment_rows(BOOK_ID)
        snapshot = BookContentQualityService._page_snapshot(rows)
        legacy_hash = hashlib.sha256(
            json.dumps(
                {
                    "policy": LEGACY_BOOK_APPROVAL_POLICY_VERSION,
                    "copyright_scanner": "not-configured",
                    "pages": snapshot,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        legacy_decision = SimpleNamespace(
            Id=uuid4(),
            ActorId=None,
            ResourceId=BOOK_ID,
            Action="book.children.approved",
            Metadata={
                "decision": "AUTO_APPROVE",
                "decision_source": "AUTO_APPROVAL",
                "assessment_hash": legacy_hash,
                "policy": LEGACY_BOOK_APPROVAL_POLICY_VERSION,
            },
            CreatedAt=datetime.now(timezone.utc),
        )
        assessment = BookContentQualityService._assessment(rows, [legacy_decision])
        self.assertEqual(assessment.status, "PUBLISHED")
        self.assertEqual(assessment.publication_source, "AUTO_APPROVAL")


class VerificationGateHardeningTests(unittest.IsolatedAsyncioTestCase):
    def _service(self, *, workflow=None, rights=None, revision_meta=None):
        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.execute = AsyncMock()

        async def scalar_side_effect(query):
            sql = str(query)
            if "adminaiworkflows" in sql.lower():
                return workflow
            if "bookrightsevidences" in sql.lower():
                if "page" in sql.lower() and rights is not None and rights.Scope == "PAGE":
                    return rights
                if "pageid IS NULL" in sql and rights is not None and rights.Scope == "BOOK":
                    return rights
                return None
            return None

        db.scalar = AsyncMock(side_effect=scalar_side_effect)
        service = AdminOcrService(db)
        service.require_admin = AsyncMock()

        page = SimpleNamespace(
            Id=PAGE_ID,
            BookId=BOOK_ID,
            PageNumber=1,
            ImagePath="books/test/page1.png",
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=None,
        )
        revision = SimpleNamespace(
            Id=REVISION_ID,
            PageId=PAGE_ID,
            VerificationStatus="NEEDS_REVIEW",
            ProcessingMeta=revision_meta
            if revision_meta is not None
            else {
                "source_image_sha256": IMAGE_SHA,
                "source_image_path": "books/test/page1.png",
            },
            VerifiedText=None,
            DraftText="Bé học bài.",
            VerifiedBy=None,
            VerifiedAt=None,
            ContentHash=None,
        )
        service.repo.page = AsyncMock(return_value=page)
        service.repo.revision = AsyncMock(return_value=revision)
        service.repo.words = AsyncMock(return_value=[])
        service.repo.sync_words = AsyncMock()
        service.repo.update_revision_verification = MagicMock()
        service.repo.set_current_verified_revision = MagicMock()
        service._preserve_trusted_word_scores = MagicMock()
        service._set_word_review_statuses = MagicMock()
        service.revision_detail = AsyncMock(return_value="VERIFIED_OK")
        return service, db, page, revision

    async def test_verify_rejects_ai_auto_verified_and_missing_workflow_bypass(self):
        service, _, _, _ = self._service(workflow=_valid_workflow(), rights=_valid_rights())

        with self.assertRaises(HTTPException) as auto_err:
            await service.verify(ACTOR_ID, PAGE_ID, _verify_payload(mode="AI_AUTO_VERIFIED"))
        self.assertEqual(auto_err.exception.status_code, 409)
        self.assertEqual(auto_err.exception.detail["code"], "AI_AUTO_VERIFY_DISABLED")

        with self.assertRaises(HTTPException) as no_wf_err:
            await service.verify(ACTOR_ID, PAGE_ID, _verify_payload(workflow_id=None))
        self.assertEqual(no_wf_err.exception.status_code, 409)
        self.assertEqual(no_wf_err.exception.detail["code"], "WORKFLOW_REQUIRED")

    async def test_verify_enforces_image_sha_chunks_image_safety_and_rights_evidence(self):
        # 1. Image SHA mismatch
        s1, _, _, _ = self._service(
            workflow=_valid_workflow(SourceImageSha256="1" * 64),
            rights=_valid_rights(),
        )
        with self.assertRaises(HTTPException) as e1:
            await s1.verify(ACTOR_ID, PAGE_ID, _verify_payload())
        self.assertEqual(e1.exception.detail["code"], "IMAGE_REVISION_MISMATCH")

        # 2. Incomplete safety chunks
        s2, _, _, _ = self._service(
            workflow=_valid_workflow(
                SafetyMetadata={
                    "chunks_total": 3,
                    "chunks_completed": 2,
                    "all_chunks_completed": False,
                }
            ),
            rights=_valid_rights(),
        )
        with self.assertRaises(HTTPException) as e2:
            await s2.verify(ACTOR_ID, PAGE_ID, _verify_payload())
        self.assertEqual(e2.exception.detail["code"], "TEXT_SAFETY_INCOMPLETE_CHUNKS")

        # 3. Unassessed image safety
        s3, _, _, _ = self._service(
            workflow=_valid_workflow(ImageSafetyStatus="UNASSESSED_NO_VISION_MODEL"),
            rights=_valid_rights(),
        )
        with self.assertRaises(HTTPException) as e3:
            await s3.verify(ACTOR_ID, PAGE_ID, _verify_payload())
        self.assertEqual(e3.exception.detail["code"], "IMAGE_SAFETY_UNASSESSED")

        # 4. Flagged unsafe image
        s4, _, _, _ = self._service(
            workflow=_valid_workflow(ImageSafetyStatus="ADMIN_FLAGGED_UNSAFE"),
            rights=_valid_rights(),
        )
        with self.assertRaises(HTTPException) as e4:
            await s4.verify(ACTOR_ID, PAGE_ID, _verify_payload())
        self.assertEqual(e4.exception.detail["code"], "IMAGE_SAFETY_FLAGGED_UNSAFE")

        # 5. Stale image safety review (different image SHA)
        s5, _, _, _ = self._service(
            workflow=_valid_workflow(ImageSafetyImageSha256="2" * 64),
            rights=_valid_rights(),
        )
        with self.assertRaises(HTTPException) as e5:
            await s5.verify(ACTOR_ID, PAGE_ID, _verify_payload())
        self.assertEqual(e5.exception.detail["code"], "IMAGE_SAFETY_STALE")

        # 6. Missing rights evidence is allowed (optional) when OCR + Proofreading + Text/Image Safety are complete
        s6, _, _, _ = self._service(workflow=_valid_workflow(), rights=None)
        with patch.object(
            BookContentQualityService,
            "auto_publish_if_eligible",
            new=AsyncMock(),
        ):
            verified_without_rights = await s6.verify(ACTOR_ID, PAGE_ID, _verify_payload())
        self.assertEqual(verified_without_rights, "VERIFIED_OK")

        # 7. Explicitly flagged copyright concern still blocks verification
        s7, _, _, _ = self._service(
            workflow=_valid_workflow(),
            rights=_valid_rights(Status="CONCERN_FLAGGED"),
        )
        with self.assertRaises(HTTPException) as e7:
            await s7.verify(ACTOR_ID, PAGE_ID, _verify_payload())
        self.assertEqual(e7.exception.detail["code"], "RIGHTS_CONCERN_BLOCKED")

        # 8. Rights version mismatch
        s8, _, _, _ = self._service(
            workflow=_valid_workflow(),
            rights=_valid_rights(Version=2),
        )
        with self.assertRaises(HTTPException) as e8:
            await s8.verify(
                ACTOR_ID, PAGE_ID, _verify_payload(expected_rights_version=1)
            )
        self.assertEqual(e8.exception.detail["code"], "RIGHTS_VERSION_MISMATCH")

    async def test_verify_succeeds_with_complete_gate_and_does_not_auto_publish(self):
        wf = _valid_workflow(SafetyStatus="PROVISIONAL", SafetyConfirmedBy=None)
        rights = _valid_rights(Version=3)
        service, db, _, revision = self._service(workflow=wf, rights=rights)

        with patch.object(
            BookContentQualityService,
            "auto_publish_if_eligible",
            new=AsyncMock(),
        ) as auto_pub:
            res = await service.verify(
                ACTOR_ID,
                PAGE_ID,
                _verify_payload(expected_rights_version=3),
            )

        self.assertEqual(res, "VERIFIED_OK")
        auto_pub.assert_not_called()
        self.assertEqual(wf.SafetyStatus, "CONFIRMED")
        self.assertEqual(wf.SafetyConfirmedBy, ACTOR_ID)
        meta_wf = revision.ProcessingMeta["admin_ai_workflow"]
        self.assertEqual(meta_wf["rights_evidence_version"], 3)
        self.assertEqual(meta_wf["image_safety_status"], "ADMIN_CONFIRMED_SAFE")
        self.assertEqual(meta_wf["source_image_sha256"], IMAGE_SHA)
        db.commit.assert_awaited_once()

    async def test_save_draft_invalidates_existing_workflow_safety_to_stale(self):
        wf = _valid_workflow(text="Văn bản cũ trước khi sửa.")
        service, db, _, revision = self._service(workflow=wf, rights=_valid_rights())
        db.scalars = AsyncMock(return_value=SimpleNamespace(all=lambda: [wf]))
        service.repo.update_revision_draft = MagicMock()

        payload = AdminOcrDraftRequest(
            draft_text="Văn bản mới đã sửa.",
            words=[
                {
                    "word_index": idx,
                    "line_index": 0,
                    "text": tok,
                    "normalized_text": tok.strip(".").casefold(),
                    "bbox": [0.05 + idx * 0.15, 0.1, 0.12, 0.1],
                    "ocr_confidence": 0.9,
                }
                for idx, tok in enumerate("Văn bản mới đã sửa.".split())
            ],
        )
        await service.save_draft(ACTOR_ID, PAGE_ID, REVISION_ID, payload)

        self.assertEqual(wf.SafetyStatus, "STALE")
        self.assertIsNone(wf.SafetyInputHash)
        self.assertIsNone(wf.Suitability)
        self.assertEqual(wf.Findings, [])
        self.assertEqual(len(wf.SafetyHistory), 1)
        self.assertEqual(wf.SafetyHistory[0]["reason"], "DRAFT_EDITED_OUTSIDE_WORKFLOW")


class BookPageDiagnosticsTests(unittest.TestCase):
    def test_detects_missing_image_empty_ocr_error_duplicate_gap_unverified_and_image_only(self):
        def mk_row(page_no, *, img="img.png", status="VERIFIED", text="Xin chào", meta=None, wf_status="READY_FOR_ADMIN_REVIEW", wf_stage="READY_FOR_ADMIN_REVIEW", content_hash=None):
            page = SimpleNamespace(Id=uuid4(), PageNumber=page_no, ImagePath=img, LifecycleStatus="ACTIVE")
            rev = (
                SimpleNamespace(
                    Id=uuid4(),
                    VerificationStatus=status,
                    VerifiedText=text if status == "VERIFIED" else None,
                    DraftText=text,
                    OriginalOcrText=text,
                    ContentHash=content_hash or f"h-{page_no}",
                    ProcessingMeta=meta or {},
                )
                if text is not None or meta is not None
                else None
            )
            wf = SimpleNamespace(
                Status=wf_status,
                Stage=wf_stage,
                SafetyStatus="CONFIRMED",
                ImageSafetyStatus="ADMIN_CONFIRMED_SAFE",
            )
            return page, rev, wf, None, None

        rows = [
            mk_row(1, img="", text="", status="NEEDS_REVIEW"),  # MISSING_IMAGE, EMPTY_OCR, UNVERIFIED_PAGE
            mk_row(2, img="p2.png", text="", meta={"image_only": True}, status="NEEDS_REVIEW"),  # IMAGE_ONLY_PAGE, UNVERIFIED_PAGE
            mk_row(4, img="p4.png", text="Lỗi OCR", meta={"ocr_error": "TESSERACT_FAIL"}, wf_status="FAILED", wf_stage="PROOFREADING", status="NEEDS_REVIEW"),  # OCR_ERROR, UNVERIFIED_PAGE + gap at page 3!
            mk_row(5, img="p5a.png", text="Nội dung trùng", content_hash="same-hash"),
            mk_row(5, img="p5b.png", text="Nội dung trùng", content_hash="same-hash"),  # DUPLICATE_PAGE
        ]
        diagnostics = BookContentQualityService._build_page_diagnostics(rows)
        by_page = {}
        for item in diagnostics:
            by_page.setdefault(item.page_number, []).append(item)

        self.assertIn("MISSING_IMAGE", by_page[1][0].codes)
        self.assertIn("EMPTY_OCR", by_page[1][0].codes)
        self.assertIn("UNVERIFIED_PAGE", by_page[1][0].codes)
        self.assertIn("IMAGE_ONLY_PAGE", by_page[2][0].codes)
        self.assertEqual(by_page[3][0].codes, ["SUSPECTED_MISSING_PAGE"])
        self.assertIn("không khẳng định tổng số trang bản in gốc", by_page[3][0].summary)
        self.assertIn("OCR_ERROR", by_page[4][0].codes)
        self.assertIn("DUPLICATE_PAGE", by_page[5][0].codes)


if __name__ == "__main__":
    unittest.main()
