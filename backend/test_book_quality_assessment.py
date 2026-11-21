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


def _row(
    page_number: int,
    *,
    finding: dict | None = None,
    suitability: str = "SUITABLE",
    content_type: str = "CONTENT",
    image_path: str = "books/test/page.png",
    verified_text: str | None = None,
    image_safety_status: str = "NOT_REVIEWED",
):
    page_id = uuid4()
    revision_id = uuid4()
    text_value = (
        verified_text
        if verified_text is not None
        else f"Câu chuyện tiếng Việt trang số {page_number} dành cho các bạn nhỏ đọc mỗi ngày."
    )
    workflow = SimpleNamespace(
        Id=uuid4(),
        PageId=page_id,
        PageRevisionId=revision_id,
        Status="READY_FOR_ADMIN_REVIEW",
        SafetyStatus="PROVISIONAL",
        CandidateHash=AdminAiWorkflowService._hash(text_value),
        CandidateText=text_value,
        SafetyInputHash=AdminAiWorkflowService._hash(text_value),
        SafetyMetadata={"scope": "TEXT", "total_chunks": 1, "scanned_chunks": 1, "coverage_complete": True},
        ImageSafetyStatus=image_safety_status,
        Suitability=suitability,
        Findings=[finding] if finding else [],
        ProofreadText=text_value,
        CorrectionSuggestions=[],
        UncertainWordIndices=[],
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
        ImagePath=image_path,
        ContentType=content_type,
        LifecycleStatus="ACTIVE",
        CurrentVerifiedRevisionId=revision_id,
    )
    revision = SimpleNamespace(
        Id=revision_id,
        VerificationStatus="VERIFIED",
        ContentHash=f"revision-{page_number}",
        VerifiedText=text_value,
        DraftText=text_value,
        VerifiedBy=uuid4(),
        VerifiedAt=datetime.now(timezone.utc),
        ProcessingMeta={},
    )
    return page, revision, workflow, f"findings-{page_number}", f"metadata-{page_number}"


def _reviewed_rights_profile(book_id=None, *, page_id=None, status="REVIEWED", version=1, fingerprint="f" * 64):
    return SimpleNamespace(
        Id=uuid4(),
        BookId=book_id or uuid4(),
        PageId=page_id,
        Scope="PAGE_OVERRIDE" if page_id else "BOOK",
        Status=status,
        SourceName="Nhà xuất bản Giáo dục / Tự biên soạn ViRead",
        RightsHolder="ViRead Editorial",
        UsageBasis="OWN_ORIGINAL" if status == "REVIEWED" else "UNKNOWN",
        EvidenceUrl="https://example.org/license/viread-book-1" if status == "REVIEWED" else None,
        EvidenceReference="HD-2026-01" if status == "REVIEWED" else None,
        Notes="Bản quyền đã xác minh." if status == "REVIEWED" else None,
        SourceFingerprint=fingerprint,
        ProfileVersion=version,
        ReferenceCheckStatus="NO_MATCH_IN_ALLOWED_CORPUS",
        ReferenceCheckEvidence=[],
        ReviewedBy=uuid4(),
        ReviewedByNameSnapshot="Admin test",
        ReviewedAt=datetime.now(timezone.utc),
        History=[],
        UpdatedAt=datetime.now(timezone.utc),
    )


class _DecisionRepository:
    def __init__(self, row, *, rights_profiles=None, expected_page_count=None):
        self.row = row
        self.rows = [row] if not isinstance(row, list) else list(row)
        self.decisions = []
        self.book_row = SimpleNamespace(
            Id=uuid4(), LifecycleStatus="DRAFT", ExpectedPageCount=expected_page_count
        )
        self.rights_profiles = (
            [_reviewed_rights_profile(self.book_row.Id)]
            if rights_profiles is None
            else list(rights_profiles)
        )
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

    async def rights_profiles_for_book(self, _book_id):
        return list(self.rights_profiles)

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
        reviewed_rights = [_reviewed_rights_profile()]

        assessment = BookContentQualityService._assessment(
            rows, [], rights_profiles=reviewed_rights
        )

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
        self.assertEqual(assessment.copyright_status, "REVIEWED")
        self.assertEqual(assessment.expected_page_count_status, "UNKNOWN_SOURCE_PAGE_COUNT")
        self.assertTrue(assessment.rights_confirmed)

        # Without a rights profile, the system NEVER claims no copyright issue.
        unassessed = BookContentQualityService._assessment(rows, [], rights_profiles=[])
        self.assertEqual(unassessed.copyright_status, "NOT_ASSESSED")
        self.assertEqual(unassessed.status, "PENDING_ADMIN_REVIEW")
        self.assertIn("RIGHTS_NOT_ASSESSED", unassessed.blockers)
        self.assertFalse(unassessed.rights_confirmed)

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

    def test_auto_publication_is_disabled_for_new_content_and_revisions(self):
        row = _row(1)
        repository = _DecisionRepository(row)
        service = BookContentQualityService(repository)

        published = _run_async(
            service.auto_publish_if_eligible(repository.book_row.Id)
        )

        self.assertFalse(published)
        self.assertFalse(repository.committed)
        self.assertEqual(repository.book_row.LifecycleStatus, "DRAFT")
        self.assertEqual(repository.decisions, [])
        self.assertEqual(row[2].SafetyStatus, "PROVISIONAL")

    def test_content_diagnostics_cover_empty_image_only_duplicate_gaps_and_expected_count(self):
        reviewed = [_reviewed_rights_profile()]
        dup_text = "Đoạn văn trùng hệt nhau trên hai trang khác nhau để kiểm tra phát hiện trùng trang."
        rows = [
            _row(1, verified_text=dup_text),
            _row(2, verified_text=dup_text),
            # Page 3 intentionally missing -> sequence gap
            _row(4, content_type="COVER_OR_IMAGE_ONLY", verified_text="", image_safety_status="MANUAL_REVIEWED_SAFE"),
            _row(5, verified_text="   "),
        ]
        book = SimpleNamespace(Id=uuid4(), ExpectedPageCount=6)
        assessment = BookContentQualityService._assessment(
            rows, [], book=book, rights_profiles=reviewed
        )
        self.assertEqual(assessment.duplicate_page_numbers, [1, 2])
        self.assertEqual(assessment.missing_page_numbers, [3])
        self.assertEqual(assessment.image_only_page_numbers, [4])
        self.assertEqual(assessment.empty_ocr_page_numbers, [5])
        self.assertEqual(assessment.expected_page_count_status, "UNDER_EXPECTED")
        self.assertIn("DUPLICATE_PAGES_DETECTED", assessment.blockers)
        self.assertIn("SUSPECTED_MISSING_PAGES", assessment.blockers)
        self.assertIn("EMPTY_OCR_PAGES", assessment.blockers)
        self.assertIn("MISSING_EXPECTED_PAGES", assessment.blockers)
        self.assertNotIn("IMAGE_ONLY_PAGES_UNREVIEWED", assessment.blockers)

        # Book with missing/duplicate pages cannot be approved by Admin.
        repo = _DecisionRepository(rows, rights_profiles=reviewed, expected_page_count=6)
        with self.assertRaises(HTTPException) as caught:
            _run_async(
                BookContentQualityService(repo).decide_book(
                    uuid4(),
                    repo.book_row.Id,
                    BookQualityBookDecisionRequest(decision="APPROVE", reason="Thử duyệt sách thiếu trang."),
                )
            )
        self.assertEqual(caught.exception.status_code, 409)

    def test_rights_profile_change_invalidates_prior_book_approval(self):
        row = _row(1)
        profile_v1 = _reviewed_rights_profile(version=1, fingerprint="1" * 64)
        prior = BookContentQualityService._assessment([row], [], rights_profiles=[profile_v1])
        decision = SimpleNamespace(
            Id=uuid4(),
            Action="book.children.approved",
            Metadata={"assessment_hash": prior.assessment_hash, "rights_confirmed": True},
            CreatedAt=datetime.now(timezone.utc),
            ActorId=uuid4(),
        )
        profile_v2 = _reviewed_rights_profile(version=2, fingerprint="2" * 64, status="CONCERNS_FOUND")
        updated = BookContentQualityService._assessment(
            [row], [decision], rights_profiles=[profile_v2]
        )
        self.assertNotEqual(prior.assessment_hash, updated.assessment_hash)
        self.assertEqual(updated.status, "STALE")
        self.assertIn("BOOK_APPROVAL_STALE", updated.blockers)
        self.assertIn("RIGHTS_CONCERNS_UNRESOLVED", updated.blockers)

    def test_legacy_published_book_stays_readable_and_flags_rights_recheck_without_bulk_pass(self):
        row = _row(1)
        legacy_snapshot = BookContentQualityService._page_snapshot([row])
        legacy_decision = SimpleNamespace(
            Id=uuid4(),
            Action="book.children.approved",
            Metadata={
                "policy": "book-children-assessment-v2",
                "decision_source": "ADMIN_APPROVAL",
                "page_snapshot": legacy_snapshot,
                "assessment_hash": "legacy-hash",
                "reason": "Legacy approval",
            },
            CreatedAt=datetime.now(timezone.utc),
            ActorId=uuid4(),
        )
        assessment = BookContentQualityService._assessment(
            [row], [legacy_decision], rights_profiles=[]
        )
        self.assertEqual(assessment.status, "APPROVED_BY_ADMIN")
        self.assertTrue(assessment.legacy_published_needs_rights_review)
        self.assertEqual(assessment.rights_profile_status, "NOT_ASSESSED")
        self.assertFalse(assessment.rights_confirmed)

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
        self.assertTrue(result.assessment.rights_confirmed)
        self.assertTrue(repository.decisions[0].Metadata["rights_confirmed"])
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
