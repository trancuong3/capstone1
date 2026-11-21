from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException

from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.models import Book
from app.repositories.book_repository import CatalogRepository
from app.services.admin_ai_workflow_service import AdminAiWorkflowService
from app.schemas.book_content_quality import BookQualityBookDecisionRequest
from app.services.book_content_quality_service import BookContentQualityService


def _run_async(coroutine):
    # The decision fake awaits only immediately-completing coroutines. Driving
    # it directly avoids a Windows Proactor socketpair dependency in unit tests.
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("Decision fake unexpectedly yielded to an event loop")


def _row(page_number: int, *, finding: dict | None = None, suitability: str = "SUITABLE"):
    page_id = uuid4()
    revision_id = uuid4()
    workflow = SimpleNamespace(
        Id=uuid4(),
        PageId=page_id,
        PageRevisionId=revision_id,
        Status="READY_FOR_ADMIN_REVIEW",
        SafetyStatus="PROVISIONAL",
        CandidateHash=AdminAiWorkflowService._hash(f"candidate-{page_number}"),
        CandidateText=f"candidate-{page_number}",
        SafetyInputHash=AdminAiWorkflowService._hash(f"candidate-{page_number}"),
        Suitability=suitability,
        Findings=[finding] if finding else [],
        ProofreadText=f"candidate-{page_number}",
        CorrectionSuggestions=[],
        OcrApprovedAt=None,
        OcrApprovedBy=None,
        FinalApprovedTextHash=None,
        SafetyConfirmedAt=None,
        SafetyConfirmedBy=None,
        ReviewEvents=[],
    )
    page = SimpleNamespace(
        Id=page_id,
        PageNumber=page_number,
        LifecycleStatus="ACTIVE",
        CurrentVerifiedRevisionId=revision_id,
    )
    revision = SimpleNamespace(
        Id=revision_id,
        VerificationStatus="VERIFIED",
        ContentHash=f"revision-{page_number}",
        VerifiedText=f"candidate-{page_number}",
        VerifiedBy=uuid4(),
        VerifiedAt=datetime.now(timezone.utc),
        ProcessingMeta={},
    )
    return page, revision, workflow, f"findings-{page_number}", f"metadata-{page_number}"


class _DecisionRepository:
    def __init__(self, row):
        self.row = row
        self.rows = [row]
        self.decisions = []
        self.book_row = SimpleNamespace(Id=uuid4(), LifecycleStatus="DRAFT")
        self.committed = False
        self.commit_count = 0

    async def role(self, _actor_id):
        return "admin"

    async def book(self, _book_id, *, lock=False):
        return self.book_row

    async def book_assessment_rows(self, _book_id, *, lock=False):
        return self.rows

    async def book_decisions(self, _book_id):
        return list(self.decisions)

    async def profile_name(self, _actor_id):
        return "Admin test"

    async def add_book_decision(self, *, actor_id, book_id, action, metadata, request_id):
        event = SimpleNamespace(
            Id=uuid4(),
            ActorId=actor_id,
            ResourceId=book_id,
            Action=action,
            Metadata=metadata,
            RequestId=request_id,
            CreatedAt=datetime.now(timezone.utc),
        )
        self.decisions.append(event)
        return event

    async def commit(self):
        self.committed = True
        self.commit_count += 1

    async def rollback(self):
        return None


class BookQualityAssessmentTests(unittest.TestCase):
    def test_book_scan_queues_existing_durable_ai_workflow_for_verified_page(self):
        page_id = uuid4()
        revision_id = uuid4()
        book_id = uuid4()
        page = SimpleNamespace(
            Id=page_id,
            PageNumber=3,
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=revision_id,
        )
        revision = SimpleNamespace(
            Id=revision_id,
            VerificationStatus="VERIFIED",
            VerifiedText="bé",
        )
        repository = SimpleNamespace(
            db=object(),
            book_assessment_rows=lambda *_args, **_kwargs: None,
        )

        async def assessment_rows(*_args, **_kwargs):
            return [(page, revision, None, None, None, None)]

        repository.book_assessment_rows = assessment_rows
        words = [
            SimpleNamespace(
                WordIndex=0,
                LineIndex=0,
                Text="bé",
                NormalizedText="bé",
                BoundingBox=[0.1, 0.1, 0.2, 0.2],
                OCRConfidence=0.9,
            )
        ]
        created = []

        class FakeOcrRepository:
            def __init__(self, _db):
                pass

            async def words(self, _revision_id):
                return words

        class FakeWorkflowRepository:
            def __init__(self, _db):
                pass

            async def by_input_snapshot(self, *_args):
                return None

        async def fake_start(_service, actor_id, target_page_id, payload):
            created.append((actor_id, target_page_id, payload))

        with (
            patch(
                "app.services.book_content_quality_service.AdminOcrRepository",
                FakeOcrRepository,
            ),
            patch(
                "app.services.book_content_quality_service.AdminAiWorkflowRepository",
                FakeWorkflowRepository,
            ),
            patch.object(AdminAiWorkflowService, "__init__", return_value=None),
            patch.object(AdminAiWorkflowService, "start", fake_start),
        ):
            _run_async(
                BookContentQualityService(repository)._ensure_page_ai_workflows(
                    uuid4(), book_id
                )
            )

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0][1], page_id)
        self.assertEqual(created[0][2].draft_text, "bé")
        self.assertEqual(created[0][2].page_revision_id, revision_id)

    def test_assessment_aggregates_all_pages_without_history_page_limit(self):
        rows = [_row(number) for number in range(1, 251)]

        assessment = BookContentQualityService._assessment(rows, [])

        self.assertEqual(assessment.page_count, 250)
        self.assertEqual(assessment.ocr_completed_pages, 250)
        self.assertEqual(assessment.proofreading_completed_pages, 250)
        self.assertEqual(assessment.child_safety_completed_pages, 250)
        self.assertEqual(assessment.processing_pages, 0)
        self.assertEqual(assessment.failed_pages, 0)
        self.assertEqual(assessment.stale_pages, 0)
        self.assertEqual(assessment.proofreading_status, "COMPLETED")
        self.assertEqual(assessment.child_safety_status, "COMPLETED")
        self.assertEqual(assessment.status, "READY_FOR_CHILDREN")
        self.assertEqual(assessment.copyright_status, "NOT_CONFIGURED")
        self.assertNotIn("COPYRIGHT_SCANNER_NOT_CONFIGURED", assessment.blockers)

    def test_safety_findings_are_grouped_and_high_blocks_child_approval(self):
        evidence = {
            "category": "VIOLENCE",
            "severity": "HIGH",
            "evidence_text": "câu trích dẫn thật",
            "explanation": "Mô tả bạo lực.",
            "recommendation": "Admin kiểm tra.",
        }
        rows = [_row(1, finding=evidence), _row(2, finding=evidence)]

        assessment = BookContentQualityService._assessment(rows, [])

        self.assertEqual(assessment.status, "REJECTED_FOR_CHILDREN")
        self.assertEqual(assessment.finding_count, 2)
        self.assertEqual(assessment.high_finding_count, 2)
        self.assertEqual(len(assessment.finding_groups), 1)
        self.assertEqual(assessment.finding_groups[0]["page_count"], 2)
        self.assertEqual(len(assessment.finding_groups[0]["examples"]), 2)

    def test_auto_publication_confirms_clean_pages_and_records_current_snapshot(self):
        row = _row(1)
        repository = _DecisionRepository(row)
        retired_row = _row(2)
        retired_row[0].LifecycleStatus = "RETIRED"
        repository.rows.append(retired_row)
        service = BookContentQualityService(repository)

        published = _run_async(
            service.auto_publish_if_eligible(repository.book_row.Id)
        )

        self.assertTrue(published)
        self.assertTrue(repository.committed)
        self.assertEqual(repository.book_row.LifecycleStatus, "ACTIVE")
        self.assertEqual(row[2].SafetyStatus, "AUTO_CONFIRMED")
        self.assertIsNotNone(row[2].SafetyConfirmedAt)
        self.assertIsNone(row[2].SafetyConfirmedBy)
        self.assertEqual(row[2].OcrApprovedBy, row[1].VerifiedBy)
        self.assertEqual(row[1].ProcessingMeta["admin_ai_workflow"]["safety_status"], "AUTO_CONFIRMED")
        decision = repository.decisions[0]
        self.assertIsNone(decision.ActorId)
        self.assertEqual(decision.Action, "book.children.approved")
        self.assertEqual(decision.Metadata["decision_source"], "AUTO_APPROVAL")
        self.assertEqual(
            decision.Metadata["page_snapshot"],
            BookContentQualityService._page_snapshot(repository.rows),
        )
        assessment = BookContentQualityService._assessment(repository.rows, repository.decisions)
        self.assertEqual(assessment.status, "PUBLISHED")
        self.assertEqual(assessment.publication_source, "AUTO_APPROVAL")

    def test_auto_publication_accepts_proofread_corrections_after_verified_revision(self):
        row = _row(1)
        row[2].CorrectionSuggestions = [
            {"original": "ocr", "proposed": "candidate", "decision": "PENDING_ADMIN"}
        ]
        repository = _DecisionRepository(row)

        published = _run_async(
            BookContentQualityService(repository).auto_publish_if_eligible(
                repository.book_row.Id
            )
        )

        self.assertTrue(published)
        self.assertEqual(row[2].CandidateText, row[1].VerifiedText)
        self.assertEqual(row[2].ProofreadText, row[1].VerifiedText)

    def test_auto_publication_fails_closed_for_findings_review_and_pending_proofread(self):
        finding = {"category": "VIOLENCE", "severity": "LOW", "evidence_text": "evidence"}
        for row in (
            _row(1, finding=finding),
            _row(1, suitability="REVIEW_REQUIRED"),
        ):
            repository = _DecisionRepository(row)
            published = _run_async(
                BookContentQualityService(repository).auto_publish_if_eligible(
                    repository.book_row.Id
                )
            )
            self.assertFalse(published)
            self.assertFalse(repository.committed)
            self.assertEqual(row[2].SafetyStatus, "PROVISIONAL")

        changed = _row(1)
        changed[2].ProofreadText = "unverified proofread text"
        repository = _DecisionRepository(changed)
        published = _run_async(
            BookContentQualityService(repository).auto_publish_if_eligible(
                repository.book_row.Id
            )
        )
        self.assertFalse(published)
        self.assertFalse(repository.committed)

        unverified = _row(1)
        unverified[1].VerifiedBy = None
        repository = _DecisionRepository(unverified)
        published = _run_async(
            BookContentQualityService(repository).auto_publish_if_eligible(
                repository.book_row.Id
            )
        )
        self.assertFalse(published)
        self.assertFalse(repository.committed)

    def test_admin_cannot_approve_a_book_with_unresolved_safety_findings(self):
        row = _row(
            1,
            finding={
                "category": "VIOLENCE",
                "severity": "MEDIUM",
                "evidence_text": "câu trích dẫn thật",
            },
        )
        repository = _DecisionRepository(row)
        service = BookContentQualityService(repository)

        with self.assertRaises(HTTPException) as raised:
            _run_async(
                service.decide_book(
                    uuid4(),
                    repository.book_row.Id,
                    BookQualityBookDecisionRequest(
                        decision="APPROVE",
                        reason="Đã xem nội dung.",
                    ),
                )
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("Resolve Child Safety findings", raised.exception.detail)
        self.assertFalse(repository.committed)

    def test_missing_workflow_is_processing_not_declared_safe_or_failed(self):
        page, revision, *_ = _row(1)
        rows = [(page, revision, None, None, None)]

        assessment = BookContentQualityService._assessment(rows, [])

        self.assertEqual(assessment.status, "PROCESSING")
        self.assertEqual(assessment.child_safety_status, "PROCESSING")
        self.assertEqual(assessment.proofreading_completed_pages, 0)
        self.assertEqual(assessment.child_safety_completed_pages, 0)
        self.assertEqual(assessment.processing_pages, 0)
        self.assertEqual(assessment.failed_pages, 0)
        self.assertEqual(assessment.finding_count, 0)
        self.assertFalse(assessment.rights_confirmed)

    def test_assessment_hash_changes_when_page_or_scan_fingerprint_changes(self):
        row = _row(1)
        original = BookContentQualityService._assessment([row], []).assessment_hash
        changed_fingerprint = (*row[:3], "new-findings-fingerprint", row[4])
        changed_content = (
            row[0],
            SimpleNamespace(**{**row[1].__dict__, "ContentHash": "changed"}),
            *row[2:],
        )

        self.assertNotEqual(
            original,
            BookContentQualityService._assessment([changed_fingerprint], []).assessment_hash,
        )
        self.assertNotEqual(
            original,
            BookContentQualityService._assessment([changed_content], []).assessment_hash,
        )

    def test_prior_book_approval_becomes_stale_when_assessment_hash_changes(self):
        row = _row(1)
        prior = BookContentQualityService._assessment([row], [])
        decision = SimpleNamespace(
            Id=uuid4(),
            Action="book.children.approved",
            Metadata={"assessment_hash": prior.assessment_hash, "rights_confirmed": True},
            CreatedAt=datetime.now(timezone.utc),
            ActorId=uuid4(),
        )
        new_revision_id = uuid4()
        changed_page = SimpleNamespace(
            **{**row[0].__dict__, "CurrentVerifiedRevisionId": new_revision_id}
        )
        changed = (
            changed_page,
            SimpleNamespace(
                **{
                    **row[1].__dict__,
                    "Id": new_revision_id,
                    "ContentHash": "new-content-hash",
                }
            ),
            *row[2:],
        )

        assessment = BookContentQualityService._assessment([changed], [decision])

        self.assertEqual(assessment.status, "STALE")
        self.assertIn("BOOK_APPROVAL_STALE", assessment.blockers)

    def test_public_book_gate_requires_current_audited_book_approval(self):
        statement = select(Book.Id).where(CatalogRepository.eligible_book())
        compiled_query = statement.compile(dialect=postgresql.dialect())
        compiled = str(compiled_query)
        parameters = compiled_query.params

        self.assertIn("auditlogs", compiled)
        self.assertIn("book.children.approved", parameters.values())
        self.assertIn("jsonb_agg", compiled)
        self.assertIn("page_snapshot", parameters.values())
        self.assertIn("proofread_metadata_hash", compiled)
        self.assertIn("final_approved_text_hash", compiled)
        self.assertNotIn("rights_confirmed", parameters.values())

    def test_book_approval_uses_current_verified_revision_without_per_page_reapproval(self):
        row = _row(1)
        _, revision, workflow, *_ = row
        repository = _DecisionRepository(row)
        actor_id = uuid4()
        service = BookContentQualityService(repository)

        result = _run_async(
            service.decide_book(
                actor_id,
                repository.book_row.Id,
                BookQualityBookDecisionRequest(
                    decision="APPROVE",
                    reason="Kết quả AI đã được xem ở cấp sách.",
                ),
            )
        )

        self.assertEqual(result.assessment.status, "APPROVED_BY_ADMIN")
        self.assertTrue(repository.committed)
        self.assertIsNotNone(workflow.OcrApprovedAt)
        self.assertEqual(revision.ProcessingMeta["admin_ai_workflow"]["candidate_hash"], workflow.CandidateHash)

    def test_book_approval_reports_page_when_proofread_candidate_is_not_saved_as_verified_revision(self):
        row = _row(7)
        row[1].VerifiedText = "old verified text"
        repository = _DecisionRepository(row)
        service = BookContentQualityService(repository)

        with self.assertRaises(HTTPException) as raised:
            _run_async(
                service.decide_book(
                    uuid4(),
                    repository.book_row.Id,
                    BookQualityBookDecisionRequest(
                        decision="APPROVE",
                        reason="Đã xem.",
                    ),
                )
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("trang 7", raised.exception.detail)
        self.assertIn("Candidate khác OCR VERIFIED", raised.exception.detail)

    def test_book_approval_confirms_safety_and_writes_audited_decision(self):
        row = _row(1)
        page, revision, workflow, *_ = row
        actor_id = uuid4()
        repository = _DecisionRepository(row)
        service = BookContentQualityService(repository)

        result = _run_async(
            service.decide_book(
                actor_id,
                repository.book_row.Id,
                BookQualityBookDecisionRequest(
                    decision="APPROVE",
                    reason="Đã xem kết quả Child Safety ở cấp sách.",
                ),
            )
        )

        self.assertTrue(repository.committed)
        self.assertEqual(repository.book_row.LifecycleStatus, "ACTIVE")
        self.assertEqual(workflow.SafetyStatus, "CONFIRMED")
        self.assertEqual(result.assessment.status, "APPROVED_BY_ADMIN")
        self.assertFalse(result.assessment.rights_confirmed)
        self.assertFalse(repository.decisions[0].Metadata["rights_confirmed"])
        self.assertEqual(repository.decisions[0].Action, "book.children.approved")
        self.assertTrue(repository.decisions[0].Metadata["page_snapshot"])
        self.assertEqual(result.assessment.admin_approved_by_name, "Admin test")

    def test_repeating_the_same_book_approval_is_idempotent(self):
        row = _row(1)
        _, revision, workflow, *_ = row
        actor_id = uuid4()
        repository = _DecisionRepository(row)
        service = BookContentQualityService(repository)
        payload = BookQualityBookDecisionRequest(
            decision="APPROVE",
            reason="Đã xem kết quả Child Safety.",
        )

        first = _run_async(
            service.decide_book(actor_id, repository.book_row.Id, payload)
        )
        second = _run_async(
            service.decide_book(actor_id, repository.book_row.Id, payload)
        )

        self.assertEqual(first.assessment.status, "APPROVED_BY_ADMIN")
        self.assertEqual(second.assessment.status, "APPROVED_BY_ADMIN")
        self.assertEqual(repository.commit_count, 1)
        self.assertEqual(len(repository.decisions), 1)


if __name__ == "__main__":
    unittest.main()
