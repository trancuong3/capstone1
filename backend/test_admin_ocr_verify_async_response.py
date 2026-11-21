"""Regression coverage for the post-verify workflow rollback and response read."""
from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy.exc import MissingGreenlet

from app.schemas.admin_ocr import AdminOcrVerifyRequest
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
            PageRevisionId=REVISION_ID,
            SafetyStatus="CONFIRMED",
            SafetyInputHash=safety_content_hash("Bé"),
            ImageSafetyStatus="ADMIN_CONFIRMED_SAFE",
            SourceImageSha256=None,
            OcrApprovedAt=None,
            OcrApprovedBy=None,
            FinalApprovedTextHash=None,
            ReviewEvents=[],
            UpdatedAt=None,
        )
        rights = SimpleNamespace(
            Id=UUID("66666666-6666-4666-8666-666666666666"),
            Scope="BOOK",
            Status="RIGHTS_REVIEWED",
            SourceDescription="Nguồn mở mẫu",
            UsageBasis="OPEN_LICENSE",
            EvidenceUrlOrRef="https://example.org/license",
            Version=1,
        )

        async def scalar_side_effect(query):
            sql = str(query).lower()
            if "adminaiworkflows" in sql:
                return workflow
            if "bookrightsevidences" in sql and "pageid is null" in sql:
                return rights
            return None

        db.scalar.side_effect = scalar_side_effect

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

        db.commit = AsyncMock(side_effect=expire_loaded_rows)
        result = await service.verify(ACTOR_ID, PAGE_ID, payload)

        self.assertEqual(result, (PAGE_ID, REVISION_ID, "VERIFIED", []))
        retry_result = await service.verify(ACTOR_ID, PAGE_ID, payload)
        self.assertEqual(retry_result, result)
        changed_payload = payload.model_copy(update={"corrected_text": "Khác"})
        with self.assertRaises(HTTPException) as conflict:
            await service.verify(ACTOR_ID, PAGE_ID, changed_payload)
        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(
            conflict.exception.detail,
            "Only a revision awaiting review can be verified",
        )
        self.assertEqual(service.repo.page.await_count, 4)
        self.assertEqual(service.repo.revision.await_count, 4)
        service.repo.sync_words.assert_awaited_once()
        service.repo.update_revision_verification.assert_called_once()
        db.execute.assert_awaited_once()
        db.commit.assert_awaited_once()

