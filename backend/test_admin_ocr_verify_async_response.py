"""Regression coverage for the post-verify workflow rollback and response read."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy.exc import MissingGreenlet

from app.schemas.admin_ocr import AdminOcrProofreadAuditInput, AdminOcrVerifyRequest
from app.services.admin_ocr_service import AdminOcrService, safety_content_hash
from fastapi import HTTPException


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
PAGE_ID = UUID("22222222-2222-4222-8222-222222222222")
REVISION_ID = UUID("33333333-3333-4333-8333-333333333333")
WORKFLOW_ID = UUID("44444444-4444-4444-8444-444444444444")


class AdminOcrVerifyAsyncResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_verify_reloads_page_and_revision_after_helper_rollback(self):
        issued_rows = []
        persisted_page = {
            "Id": PAGE_ID,
            "BookId": UUID("55555555-5555-4555-8555-555555555555"),
            "LifecycleStatus": "ACTIVE",
            "CurrentVerifiedRevisionId": None,
        }
        persisted_revision = {
            "Id": REVISION_ID,
            "VerificationStatus": "NEEDS_REVIEW",
            "ProcessingMeta": {},
            "VerifiedText": None,
            "VerifiedBy": None,
            "VerifiedAt": None,
            "ContentHash": None,
        }

        class ExpiringRow:
            def __init__(self, values):
                object.__setattr__(self, "_values", dict(values))
                object.__setattr__(self, "_expired", False)
                issued_rows.append(self)

            def __getattr__(self, name):
                if object.__getattribute__(self, "_expired"):
                    raise MissingGreenlet(f"{name} was expired by workflow rollback")
                values = object.__getattribute__(self, "_values")
                if name not in values:
                    raise AttributeError(name)
                return values[name]

            def __setattr__(self, name, value):
                if name.startswith("_"):
                    object.__setattr__(self, name, value)
                else:
                    object.__getattribute__(self, "_values")[name] = value

        async def expire_loaded_rows():
            for row in issued_rows:
                object.__setattr__(row, "_expired", True)

        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock(side_effect=expire_loaded_rows)
        db.execute = AsyncMock()
        db.scalar = AsyncMock()

        service = AdminOcrService(db)
        service.require_admin = AsyncMock()

        async def load_page(_page_id, *, lock=False):
            return ExpiringRow(persisted_page)

        async def load_revision(_page_id, _revision_id, *, lock=False):
            return ExpiringRow(persisted_revision)

        service.repo.page = AsyncMock(side_effect=load_page)
        service.repo.revision = AsyncMock(side_effect=load_revision)
        service.repo.words = AsyncMock(return_value=[])
        service.repo.sync_words = AsyncMock()

        def persist_verification(revision, **values):
            revision.VerificationStatus = "VERIFIED"
            revision.VerifiedText = values["corrected_text"]
            revision.DraftText = values["corrected_text"]
            revision.VerifiedBy = values["verified_by"]
            revision.VerifiedAt = values["verified_at"]
            revision.ContentHash = values["content_hash"]
            persisted_revision["VerificationStatus"] = "VERIFIED"
            persisted_revision["VerifiedText"] = values["corrected_text"]
            persisted_revision["DraftText"] = values["corrected_text"]
            persisted_revision["VerifiedBy"] = values["verified_by"]
            persisted_revision["VerifiedAt"] = values["verified_at"]
            persisted_revision["ContentHash"] = values["content_hash"]
            persisted_revision["ProcessingMeta"] = dict(
                revision.ProcessingMeta or {}
            )

        service.repo.update_revision_verification = MagicMock(
            side_effect=persist_verification
        )

        def set_current_revision(page, revision_id):
            page.CurrentVerifiedRevisionId = revision_id
            persisted_page["CurrentVerifiedRevisionId"] = revision_id

        service.repo.set_current_verified_revision = MagicMock(
            side_effect=set_current_revision
        )
        service._preserve_trusted_word_scores = MagicMock()
        service._set_word_review_statuses = MagicMock()
        service._validate_ai_workflow_for_verification = MagicMock()

        workflow = SimpleNamespace(
            Id=WORKFLOW_ID,
            PageId=PAGE_ID,
            PageRevisionId=REVISION_ID,
            ImagePath="books/test/page.png",
            ImageHash="a" * 64,
            ProofreadText="Bé",
            CandidateText="Bé",
            CandidateHash=safety_content_hash("Bé"),
            UncertainWordIndices=[],
            ProofreadMetadata={"status": "SUCCEEDED"},
            Status="READY_FOR_ADMIN_REVIEW",
            Suitability="SUITABLE",
            Findings=[],
            SafetyStatus="CONFIRMED",
            SafetyConfirmedBy=ACTOR_ID,
            SafetyInputHash=safety_content_hash("Bé"),
            SafetyMetadata={"scope": "TEXT", "total_chunks": 1, "scanned_chunks": 1, "coverage_complete": True},
            ImageSafetyStatus="NOT_REVIEWED",
            RightsProfileId=None,
            RightsProfileVersion=None,
            RightsProfileHash=None,
            OcrApprovedAt=None,
            OcrApprovedBy=None,
            FinalApprovedTextHash=None,
            ReviewEvents=[],
            UpdatedAt=None,
        )
        rights_profile = SimpleNamespace(
            Id=uuid4(),
            Scope="BOOK",
            Status="REVIEWED",
            SourceName="Tự biên soạn ViRead",
            RightsHolder="ViRead",
            UsageBasis="OWN_ORIGINAL",
            EvidenceUrl="https://example.org/rights/1",
            EvidenceReference="HD-1",
            Notes="Bản quyền nội bộ.",
            SourceFingerprint="f" * 64,
            ProfileVersion=1,
            ReferenceCheckStatus="NO_MATCH_IN_ALLOWED_CORPUS",
            ReviewedBy=ACTOR_ID,
            ReviewedAt=datetime.now(timezone.utc),
        )
        db.scalar.return_value = workflow

        async def serialize(page, revision, *, word_rows=None):
            rows = await service.repo.words(revision.Id)
            return page.Id, revision.Id, revision.VerificationStatus, rows

        service.revision_detail = AsyncMock(side_effect=serialize)

        payload = AdminOcrVerifyRequest(
            page_revision_id=REVISION_ID,
            workflow_id=WORKFLOW_ID,
            corrected_text="Bé",
            words=[{
                "word_index": 0,
                "line_index": 0,
                "text": "Bé",
                "normalized_text": "bé",
                "bbox": [0.1, 0.1, 0.2, 0.1],
                "ocr_confidence": 0.9,
            }],
            proofread_audit={
                "mode": "AI_CHECKED",
                "checked_text": "Bé",
                "suggestions": [],
            },
        )

        auto_publish_spy = AsyncMock(return_value=False)
        with (
            patch(
                "app.services.admin_ocr_service.BookContentQualityRepository.effective_rights_profile",
                new=AsyncMock(return_value=rights_profile),
            ),
            patch(
                "app.services.admin_ocr_service.BookContentQualityRepository.open_image_or_safety_reports_for_page",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "app.services.book_content_quality_service.BookContentQualityService.auto_publish_if_eligible",
                new=auto_publish_spy,
            ),
        ):
            result = await service.verify(ACTOR_ID, PAGE_ID, payload)
            retry_result = await service.verify(ACTOR_ID, PAGE_ID, payload)
            changed_payload = payload.model_copy(update={"corrected_text": "Khác"})
            with self.assertRaises(HTTPException) as conflict:
                await service.verify(ACTOR_ID, PAGE_ID, changed_payload)

            # Direct verify without workflow_id or with MANUAL_FALLBACK / AI_AUTO_VERIFIED must be blocked.
            persisted_revision["VerificationStatus"] = "NEEDS_REVIEW"
            with self.assertRaises(HTTPException) as missing_wf:
                await service.verify(
                    ACTOR_ID, PAGE_ID, payload.model_copy(update={"workflow_id": None})
                )
            self.assertEqual(missing_wf.exception.status_code, 409)
            self.assertEqual(missing_wf.exception.detail["code"], "AI_WORKFLOW_REQUIRED")

            with self.assertRaises(HTTPException) as manual_bypass:
                await service.verify(
                    ACTOR_ID,
                    PAGE_ID,
                    payload.model_copy(
                        update={
                            "proofread_audit": AdminOcrProofreadAuditInput(
                                mode="MANUAL_FALLBACK",
                                checked_text="Bé",
                                suggestions=[],
                                reason_code="AI_CHECK_UNAVAILABLE",
                            )
                        }
                    ),
                )
            self.assertEqual(manual_bypass.exception.status_code, 422)
            self.assertEqual(manual_bypass.exception.detail["code"], "MANUAL_BYPASS_DISABLED")

            with self.assertRaises(HTTPException) as auto_verify:
                await service.verify(
                    ACTOR_ID,
                    PAGE_ID,
                    payload.model_copy(
                        update={
                            "proofread_audit": AdminOcrProofreadAuditInput(
                                mode="AI_AUTO_VERIFIED",
                                checked_text="Bé",
                                suggestions=[],
                            )
                        }
                    ),
                )
            self.assertEqual(auto_verify.exception.status_code, 422)
            self.assertEqual(auto_verify.exception.detail["code"], "AUTO_VERIFICATION_DISABLED")

        self.assertEqual(result, (PAGE_ID, REVISION_ID, "VERIFIED", []))
        self.assertEqual(retry_result, result)
        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(
            conflict.exception.detail,
            "Only a revision awaiting review can be verified",
        )
        auto_publish_spy.assert_not_awaited()
        service.repo.sync_words.assert_awaited_once()
        service.repo.update_revision_verification.assert_called_once()
        db.add.assert_called_once()
        db.execute.assert_awaited_once()
        db.commit.assert_awaited_once()

