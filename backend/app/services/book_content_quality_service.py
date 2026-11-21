from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from uuid import UUID, uuid4, uuid5, NAMESPACE_URL

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.database.integrity import is_book_report_idempotency_violation

from app.models.book_content_quality import (
    BookContentReport,
    BookContentReportHistory,
    BookContentRightsProfile,
    BookQualityFinding,
    BookQualityScanRun,
)
from app.models.admin_ai_workflow import AdminAiWorkflow
from app.policies.book_approval import (
    AUTO_APPROVAL_ENABLED,
    BOOK_APPROVAL_POLICY_VERSION,
    COPYRIGHT_BLOCKS_BOOK_APPROVAL,
    LEGACY_BOOK_APPROVAL_POLICY_VERSIONS,
)
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.repositories.admin_ai_workflow_repository import AdminAiWorkflowRepository
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.services.admin_ai_workflow_service import AdminAiWorkflowService
from app.services.admin_ocr_service import AdminOcrService
from app.schemas.admin_ai_workflow import AdminAiWorkflowCreate
from app.schemas.admin_ocr import AdminOcrWordInput
from app.schemas.book_content_quality import (
    BookContentReportCreate,
    BookContentReportDetail,
    BookContentReportHistoryRead,
    BookContentReportPage,
    BookContentReportRead,
    BookContentReportStatusUpdate,
    BookContentRightsProfileRead,
    BookContentRightsProfileUpsert,
    BookExpectedPageCountUpdate,
    BookQualityBookDetail,
    BookQualityBookPage,
    BookQualityBookSummary,
    BookApprovalAssessment,
    BookQualityBookDecisionRequest,
    BookQualityBookDecisionRead,
    BookQualityFindingRead,
    BookQualityFindingUpdate,
    BookQualityPageItemRead,
    BookQualityPageScanRead,
    BookQualityReportAdminPage,
    BookQualityScanDetail,
    BookQualityScanRead,
)


class BookContentQualityService:
    """Business rules for Parent reports, Admin review and durable full-book scans."""

    def __init__(self, repository: BookContentQualityRepository):
        self.repository = repository

    async def _require_role(self, actor_id: UUID, expected: str) -> None:
        actual = await self.repository.role(actor_id)
        normalized = actual.strip().casefold() if isinstance(actual, str) else ""
        if normalized != expected.casefold():
            raise HTTPException(status_code=403, detail="Access denied")

    @staticmethod
    def _report_read(report: BookContentReport) -> BookContentReportRead:
        return BookContentReportRead(
            id=report.Id,
            book_id=report.BookId,
            book_title=report.BookTitleSnapshot,
            reporter_name=report.ReporterNameSnapshot,
            page_id=report.PageId,
            page_number=report.PageNumberSnapshot,
            page_revision_id=report.PageRevisionId,
            issue_type=report.IssueType,
            description=report.Description,
            reported_text=report.ReportedText,
            suggested_correction=report.SuggestedCorrection,
            status=report.Status,
            scan_run_id=report.ScanRunId,
            created_at=report.CreatedAt,
            updated_at=report.UpdatedAt,
        )

    @staticmethod
    def _scan_read(run: BookQualityScanRun) -> BookQualityScanRead:
        return BookQualityScanRead(
            id=run.Id,
            book_id=run.BookId,
            book_title=run.BookTitleSnapshot,
            trigger_type=run.TriggerType,
            scope=run.Scope,
            target_page_id=run.TargetPageId,
            status=run.Status,
            total_pages=run.TotalPages,
            completed_pages=run.CompletedPages,
            skipped_pages=run.SkippedPages,
            failed_pages=run.FailedPages,
            ai_completed_pages=run.AICompletedPages,
            ai_unavailable_pages=run.AIUnavailablePages,
            error_summary=run.ErrorSummary,
            started_at=run.StartedAt,
            completed_at=run.CompletedAt,
            created_at=run.CreatedAt,
        )

    @staticmethod
    def _page_snapshot(rows: list[tuple]) -> list[dict[str, object]]:
        snapshot: list[dict[str, object]] = []
        for row in rows:
            if len(row) == 7:
                _, page, revision, workflow, findings_hash, safety_metadata_hash, proofread_metadata_hash = row
            else:
                page, revision, workflow, findings_hash, safety_metadata_hash = row[:5]
                proofread_metadata_hash = row[5] if len(row) > 5 else None
            if page.LifecycleStatus not in {"ACTIVE", "PROCESSING"}:
                continue
            revision_workflow = {}
            if revision is not None and isinstance(revision.ProcessingMeta, dict):
                saved = revision.ProcessingMeta.get("admin_ai_workflow")
                if isinstance(saved, dict):
                    revision_workflow = saved
            snapshot.append(
                {
                    "page_id": str(page.Id),
                    "page_number": int(page.PageNumber),
                    "lifecycle_status": page.LifecycleStatus,
                    "revision_id": str(revision.Id) if revision else None,
                    "revision_content_hash": revision.ContentHash if revision else None,
                    "revision_status": revision.VerificationStatus if revision else None,
                    "revision_workflow_id": revision_workflow.get("workflow_id"),
                    "revision_candidate_hash": revision_workflow.get("candidate_hash"),
                    "revision_safety_input_hash": revision_workflow.get("safety_input_hash"),
                    "workflow_id": str(workflow.Id) if workflow else None,
                    "candidate_hash": workflow.CandidateHash if workflow else None,
                    "safety_input_hash": workflow.SafetyInputHash if workflow else None,
                    "suitability": workflow.Suitability if workflow else None,
                    "workflow_status": workflow.Status if workflow else None,
                    "safety_status": workflow.SafetyStatus if workflow else None,
                    "final_approved_text_hash": workflow.FinalApprovedTextHash if workflow else None,
                    # Keep this aligned with CatalogRepository's SQL snapshot:
                    # auto-confirmed scans have a timestamp and no human actor.
                    "safety_confirmed": bool(workflow and workflow.SafetyConfirmedAt),
                    "safety_confirmed_by": bool(workflow and workflow.SafetyConfirmedBy),
                    "ocr_approved": bool(workflow and workflow.OcrApprovedAt and workflow.OcrApprovedBy),
                    "findings_hash": findings_hash,
                    "safety_metadata_hash": safety_metadata_hash,
                    "proofread_metadata_hash": proofread_metadata_hash,
                }
            )
        return snapshot

    @staticmethod
    def _rights_profile_fingerprint(payload: BookContentRightsProfileUpsert, scope: str) -> str:
        canonical = {
            "scope": scope,
            "source_name": payload.source_name,
            "rights_holder": payload.rights_holder,
            "usage_basis": payload.usage_basis,
            "evidence_url": payload.evidence_url,
            "evidence_reference": payload.evidence_reference,
            "notes": payload.notes,
        }
        return hashlib.sha256(
            json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _rights_profile_read(
        profile: BookContentRightsProfile | None, book_id: UUID
    ) -> BookContentRightsProfileRead:
        if profile is None:
            return BookContentRightsProfileRead(book_id=book_id, scope="BOOK", status="NOT_ASSESSED")
        return BookContentRightsProfileRead(
            id=profile.Id,
            book_id=profile.BookId,
            page_id=profile.PageId,
            scope=profile.Scope,  # type: ignore[arg-type]
            status=profile.Status,  # type: ignore[arg-type]
            source_name=profile.SourceName,
            rights_holder=profile.RightsHolder,
            usage_basis=profile.UsageBasis,
            evidence_url=profile.EvidenceUrl,
            evidence_reference=profile.EvidenceReference,
            notes=profile.Notes,
            source_fingerprint=profile.SourceFingerprint,
            profile_version=int(profile.ProfileVersion or 1),
            reference_check_status=profile.ReferenceCheckStatus or "NOT_RUN",  # type: ignore[arg-type]
            reference_check_evidence=list(profile.ReferenceCheckEvidence or []),
            reviewed_by=profile.ReviewedBy,
            reviewed_by_name=profile.ReviewedByNameSnapshot,
            reviewed_at=profile.ReviewedAt,
            history=list(profile.History or []),
            updated_at=profile.UpdatedAt,
        )

    @classmethod
    def _effective_rights_summary(
        cls,
        active_rows: list[tuple],
        rights_profiles: list[BookContentRightsProfile] | None,
    ) -> tuple[str, int | None, str | None, int | None, dict[UUID, BookContentRightsProfile], BookContentRightsProfile | None]:
        book_profile: BookContentRightsProfile | None = None
        page_overrides: dict[UUID, BookContentRightsProfile] = {}
        for profile in rights_profiles or []:
            if getattr(profile, "PageId", None) is None:
                book_profile = profile
            else:
                page_overrides[profile.PageId] = profile

        severity_order = {
            "REVIEWED": 0,
            "NOT_ASSESSED": 1,
            "MISSING_EVIDENCE": 2,
            "CONCERNS_FOUND": 3,
        }
        effective_statuses: list[str] = []
        concern_count = 0
        if book_profile is not None:
            _blockers, resolved_book_status = AdminOcrService._rights_profile_blockers(book_profile)
            effective_statuses.append(resolved_book_status)
            if resolved_book_status == "CONCERNS_FOUND":
                concern_count += 1
        elif not active_rows:
            effective_statuses.append("NOT_ASSESSED")

        for row in active_rows:
            page = row[1] if len(row) == 7 else row[0]
            effective = page_overrides.get(page.Id) or book_profile
            _blockers, page_rights_status = AdminOcrService._rights_profile_blockers(effective)
            effective_statuses.append(page_rights_status)
            if page_rights_status == "CONCERNS_FOUND":
                concern_count += 1

        if not effective_statuses:
            worst_status = "NOT_ASSESSED"
        else:
            worst_status = max(effective_statuses, key=lambda item: severity_order.get(item, 1))

        hash_input = [
            {
                "scope": p.Scope,
                "page_id": str(p.PageId) if p.PageId else None,
                "status": p.Status,
                "version": int(p.ProfileVersion or 1),
                "fingerprint": p.SourceFingerprint,
                "reference_check_status": p.ReferenceCheckStatus,
            }
            for p in sorted(
                rights_profiles or [],
                key=lambda item: (str(item.PageId or ""), str(item.Id or "")),
            )
        ]
        rights_hash = (
            hashlib.sha256(
                json.dumps(hash_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            if hash_input
            else None
        )
        version = int(book_profile.ProfileVersion) if book_profile is not None else None
        overlap_count = sum(
            len(p.ReferenceCheckEvidence or [])
            for p in (rights_profiles or [])
            if p.ReferenceCheckStatus == "OVERLAP_CONCERN"
        )
        finding_count = (overlap_count or concern_count) if (overlap_count or concern_count) else (0 if rights_profiles else None)
        return worst_status, version, rights_hash, finding_count, page_overrides, book_profile

    @classmethod
    def _assessment(
        cls,
        rows: list[tuple],
        decisions: list,
        *,
        book: object | None = None,
        rights_profiles: list[BookContentRightsProfile] | None = None,
        latest_revisions: dict[UUID, object] | None = None,
    ) -> BookApprovalAssessment:
        now = datetime.now(timezone.utc)
        active_rows = []
        for row in rows:
            page = row[1] if len(row) == 7 else row[0]
            if page.LifecycleStatus in {"ACTIVE", "PROCESSING"}:
                active_rows.append(row)
        (
            rights_status,
            rights_version,
            rights_hash,
            rights_finding_count,
            page_overrides,
            book_rights_profile,
        ) = cls._effective_rights_summary(active_rows, rights_profiles)
        snapshot = cls._page_snapshot(active_rows)
        snapshot_payload = {
            "policy": BOOK_APPROVAL_POLICY_VERSION,
            "rights_status": rights_status,
            "rights_profile_version": rights_version,
            "rights_profile_hash": rights_hash,
            "pages": snapshot,
        }
        assessment_hash = hashlib.sha256(
            json.dumps(snapshot_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        page_count = len(active_rows)
        ocr_completed = 0
        ocr_approval_valid = 0
        proofreading_completed = 0
        safety_completed = 0
        failed_pages = 0
        pending_pages = 0
        stale_pages = 0
        active_workflows = 0
        suggestions = 0
        finding_count = 0
        high_count = 0
        medium_count = 0
        warning_pages: set[str] = set()
        grouped: dict[tuple[str, str], dict[str, object]] = {}
        unsuitable = False
        review_required = False
        page_blockers: list[str] = []

        missing_image_pages: list[int] = []
        empty_ocr_pages: list[int] = []
        image_only_pages: list[int] = []
        unreviewed_image_only_pages: list[int] = []
        text_fingerprints: dict[str, list[int]] = {}
        page_numbers: list[int] = []

        for row in active_rows:
            if len(row) == 7:
                _, page, revision, workflow, *_fingerprints = row
            else:
                page, revision, workflow, *_fingerprints = row
            page_no = int(page.PageNumber)
            page_numbers.append(page_no)
            page_content_type = str(getattr(page, "ContentType", None) or "CONTENT")
            if not str(getattr(page, "ImagePath", "") or "").strip():
                missing_image_pages.append(page_no)
                page_blockers.append(f"Trang {page_no}: thiếu ảnh gốc.")
            if page_content_type == "COVER_OR_IMAGE_ONLY":
                image_only_pages.append(page_no)
                if workflow is None or getattr(workflow, "ImageSafetyStatus", "NOT_REVIEWED") != "MANUAL_REVIEWED_SAFE":
                    unreviewed_image_only_pages.append(page_no)
                    page_blockers.append(
                        f"Trang {page_no}: trang bìa/hình ảnh chưa được Admin ghi nhận rà soát an toàn bằng tay."
                    )
            else:
                latest_rev = (latest_revisions or {}).get(page.Id) or revision
                sample_text = (
                    (getattr(revision, "VerifiedText", None) if revision is not None else None)
                    or (getattr(latest_rev, "DraftText", None) if latest_rev is not None else None)
                    or (getattr(latest_rev, "VerifiedText", None) if latest_rev is not None else None)
                    or ""
                )
                normalized_sample = " ".join(str(sample_text).casefold().split())
                if not normalized_sample:
                    empty_ocr_pages.append(page_no)
                    page_blockers.append(f"Trang {page_no}: OCR trống, cần kiểm tra hoặc gắn loại trang bìa/chỉ có hình.")
                elif len(normalized_sample) >= 20:
                    fp = hashlib.sha256(normalized_sample.encode("utf-8")).hexdigest()
                    text_fingerprints.setdefault(fp, []).append(page_no)

            if page.LifecycleStatus != "ACTIVE":
                page_blockers.append(
                    f"Trang {page_no}: trang chưa hoàn tất xử lý."
                )
            if revision is not None and revision.VerificationStatus == "VERIFIED":
                ocr_completed += 1
            matches_revision = bool(
                workflow is not None
                and revision is not None
                and workflow.PageRevisionId == revision.Id
            )
            if workflow is None or not matches_revision:
                if workflow is None:
                    pending_pages += 1
                    page_blockers.append(
                        f"Trang {page_no}: chưa có Proofreading và Child Safety cho revision hiện tại."
                    )
                elif workflow.Status in {"QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                    active_workflows += 1
                    page_blockers.append(
                        f"Trang {page_no}: workflow đang xử lý revision khác."
                    )
                else:
                    stale_pages += 1
                    page_blockers.append(
                        f"Trang {page_no}: kết quả AI thuộc revision cũ."
                    )
                continue
            candidate_is_consistent = bool(
                isinstance(workflow.CandidateText, str)
                and workflow.CandidateHash
                and AdminAiWorkflowService._hash(workflow.CandidateText)
                == workflow.CandidateHash
            )
            revision_meta = revision.ProcessingMeta if isinstance(revision.ProcessingMeta, dict) else {}
            saved_workflow = revision_meta.get("admin_ai_workflow")
            if not isinstance(saved_workflow, dict):
                saved_workflow = {}
            if (
                workflow.OcrApprovedAt is not None
                and workflow.OcrApprovedBy is not None
                and workflow.FinalApprovedTextHash == workflow.CandidateHash
                and saved_workflow.get("workflow_id") == str(workflow.Id)
                and saved_workflow.get("candidate_hash") == workflow.CandidateHash
                and saved_workflow.get("safety_input_hash") == workflow.CandidateHash
            ) or (
                revision.VerificationStatus == "VERIFIED"
                and bool(revision.VerifiedText)
                and candidate_is_consistent
                and AdminAiWorkflowService._hash(revision.VerifiedText)
                == workflow.CandidateHash
            ):
                ocr_approval_valid += 1
            if workflow.Status in {"QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                active_workflows += 1
            if workflow.Status == "FAILED" or workflow.SafetyStatus == "FAILED":
                failed_pages += 1
            if workflow.ProofreadText is not None and workflow.Status in {
                "CHILD_SAFETY_SCANNING", "READY_FOR_ADMIN_REVIEW"
            }:
                proofreading_completed += 1
            elif workflow.Status == "FAILED":
                page_blockers.append(f"Trang {page_no}: Proofreading thất bại.")
            else:
                page_blockers.append(f"Trang {page_no}: Proofreading chưa hoàn tất.")
            suggestions += len(workflow.CorrectionSuggestions or [])
            safety_meta = workflow.SafetyMetadata if isinstance(getattr(workflow, "SafetyMetadata", None), dict) else {}
            coverage_incomplete = (
                safety_meta.get("coverage_complete") is False
                or (
                    isinstance(safety_meta.get("total_chunks"), int)
                    and isinstance(safety_meta.get("scanned_chunks"), int)
                    and safety_meta["scanned_chunks"] < safety_meta["total_chunks"]
                )
            )
            if (
                workflow.SafetyStatus in {"PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED"}
                and workflow.CandidateHash
                and candidate_is_consistent
                and workflow.SafetyInputHash == workflow.CandidateHash
                and workflow.Status == "READY_FOR_ADMIN_REVIEW"
                and not coverage_incomplete
            ):
                safety_completed += 1
            elif coverage_incomplete:
                failed_pages += 1
                page_blockers.append(f"Trang {page_no}: Child Safety chưa quét đủ mọi đoạn văn bản.")
            elif workflow.SafetyStatus == "STALE" or (
                workflow.SafetyInputHash
                and workflow.CandidateHash
                and workflow.SafetyInputHash != workflow.CandidateHash
            ):
                stale_pages += 1
                page_blockers.append(f"Trang {page_no}: Child Safety đã stale.")
            elif workflow.Status not in {"FAILED", "QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                pending_pages += 1
                page_blockers.append(f"Trang {page_no}: Child Safety chưa hoàn tất.")
            elif workflow.SafetyStatus == "FAILED" or workflow.Status == "FAILED":
                page_blockers.append(f"Trang {page_no}: Child Safety thất bại.")
            elif workflow.Status in {"QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                page_blockers.append(f"Trang {page_no}: Child Safety đang xử lý.")

            if revision.VerificationStatus != "VERIFIED":
                page_blockers.append(f"Trang {page_no}: OCR revision chưa VERIFIED.")
            elif not candidate_is_consistent:
                page_blockers.append(f"Trang {page_no}: Candidate text/hash không nhất quán.")
            elif AdminAiWorkflowService._hash(revision.VerifiedText or "") != workflow.CandidateHash:
                page_blockers.append(
                    f"Trang {page_no}: Candidate khác OCR VERIFIED; cần lưu revision Candidate trước khi duyệt."
                )

            if workflow.Suitability == "NOT_RECOMMENDED":
                unsuitable = True
            if workflow.Suitability == "REVIEW_REQUIRED":
                review_required = True
            if not (
                workflow.SafetyStatus in {"PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED"}
                and workflow.SafetyInputHash == workflow.CandidateHash
                and workflow.Status == "READY_FOR_ADMIN_REVIEW"
                and not coverage_incomplete
            ):
                continue
            page_findings = workflow.Findings if isinstance(workflow.Findings, list) else []
            if page_findings:
                warning_pages.add(str(page.Id))
            for finding in page_findings:
                if not isinstance(finding, dict):
                    continue
                category = str(finding.get("category") or "OTHER_SENSITIVE").upper()
                severity = str(finding.get("severity") or "LOW").upper()
                finding_count += 1
                if severity in {"HIGH", "CRITICAL"}:
                    high_count += 1
                elif severity == "MEDIUM":
                    medium_count += 1
                group_key = (category, severity)
                group = grouped.setdefault(
                    group_key,
                    {
                        "category": category,
                        "severity": severity,
                        "finding_count": 0,
                        "pages": set(),
                        "examples": [],
                    },
                )
                group["finding_count"] = int(group["finding_count"]) + 1
                group["pages"].add(page_no)
                examples = group["examples"]
                if len(examples) < 3:
                    examples.append(
                        {
                            "page_number": page_no,
                            "evidence_text": str(finding.get("evidence_text") or ""),
                            "explanation": str(finding.get("explanation") or ""),
                            "recommendation": str(finding.get("recommendation") or ""),
                        }
                    )

        duplicate_pages = sorted({
            num
            for nums in text_fingerprints.values()
            if len(nums) > 1
            for num in nums
        })
        if duplicate_pages:
            page_blockers.append(
                f"Phát hiện trang trùng nội dung: {', '.join(f'trang {n}' for n in duplicate_pages)}."
            )

        missing_page_numbers: list[int] = []
        if page_numbers:
            present = set(page_numbers)
            missing_page_numbers = [
                n for n in range(1, max(present) + 1) if n not in present
            ]
            if missing_page_numbers:
                page_blockers.append(
                    f"Nghi thiếu trang (khoảng trống số thứ tự): {', '.join(f'trang {n}' for n in missing_page_numbers)}."
                )

        expected_page_count = getattr(book, "ExpectedPageCount", None) if book is not None else None
        if expected_page_count is None:
            expected_page_count_status = "UNKNOWN_SOURCE_PAGE_COUNT"
        elif page_count < expected_page_count:
            expected_page_count_status = "UNDER_EXPECTED"
            page_blockers.append(
                f"Thiếu trang so với số trang nguồn dự kiến ({page_count}/{expected_page_count})."
            )
        elif page_count > expected_page_count:
            expected_page_count_status = "OVER_EXPECTED"
        else:
            expected_page_count_status = "MATCHED"

        group_reads = []
        for group in sorted(grouped.values(), key=lambda item: (str(item["category"]), str(item["severity"]))):
            group_reads.append(
                {
                    "category": group["category"],
                    "severity": group["severity"],
                    "finding_count": group["finding_count"],
                    "page_count": len(group["pages"]),
                    "page_numbers": sorted(group["pages"]),
                    "examples": group["examples"],
                }
            )

        proof_status = (
            "FAILED"
            if failed_pages and proofreading_completed < page_count
            else "COMPLETED_WITH_SUGGESTIONS"
            if proofreading_completed == page_count and suggestions
            else "COMPLETED"
            if page_count and proofreading_completed == page_count
            else "INCOMPLETE"
        )
        safety_status = (
            "FAILED"
            if failed_pages and safety_completed < page_count
            else "STALE"
            if stale_pages
            else "COMPLETED"
            if page_count and safety_completed == page_count
            else "PROCESSING"
            if active_workflows or pending_pages
            else "INCOMPLETE"
        )
        copyright_status = rights_status
        blockers: list[str] = []
        if not page_count:
            blockers.append("NO_ACTIVE_PAGES")
        if ocr_completed < page_count:
            blockers.append("OCR_INCOMPLETE")
        if proofreading_completed < page_count:
            blockers.append("PROOFREADING_INCOMPLETE")
        if safety_completed < page_count:
            blockers.append("CHILD_SAFETY_INCOMPLETE")
        if finding_count:
            blockers.append("CHILD_SAFETY_FINDINGS")
        if review_required:
            blockers.append("SUITABILITY_REVIEW_REQUIRED")
        if duplicate_pages:
            blockers.append("DUPLICATE_PAGES_DETECTED")
        if missing_page_numbers:
            blockers.append("SUSPECTED_MISSING_PAGES")
        if expected_page_count_status == "UNDER_EXPECTED":
            blockers.append("MISSING_EXPECTED_PAGES")
        if empty_ocr_pages:
            blockers.append("EMPTY_OCR_PAGES")
        if missing_image_pages:
            blockers.append("MISSING_PAGE_IMAGES")
        if unreviewed_image_only_pages:
            blockers.append("IMAGE_ONLY_PAGES_UNREVIEWED")
        if COPYRIGHT_BLOCKS_BOOK_APPROVAL and rights_status != "REVIEWED":
            if rights_status == "CONCERNS_FOUND":
                blockers.append("RIGHTS_CONCERNS_UNRESOLVED")
            elif rights_status == "MISSING_EVIDENCE":
                blockers.append("RIGHTS_MISSING_EVIDENCE")
            else:
                blockers.append("RIGHTS_NOT_ASSESSED")
        blockers.extend(page_blockers)

        ordered_decisions = sorted(
            decisions,
            key=lambda item: (item.CreatedAt or datetime.min.replace(tzinfo=timezone.utc), str(item.Id)),
        )
        latest_decision = ordered_decisions[-1] if ordered_decisions else None
        metadata = (
            latest_decision.Metadata
            if latest_decision is not None and isinstance(latest_decision.Metadata, dict)
            else {}
        )
        legacy_approved = bool(
            latest_decision
            and latest_decision.Action == "book.children.approved"
            and metadata.get("policy") in LEGACY_BOOK_APPROVAL_POLICY_VERSIONS
            and metadata.get("page_snapshot") == snapshot
        )
        current_decision = bool(
            latest_decision and metadata.get("assessment_hash") == assessment_hash
        )
        approved = bool(
            (current_decision and latest_decision.Action == "book.children.approved")
            or legacy_approved
        )
        legacy_published_needs_rights_review = bool(
            legacy_approved and rights_status != "REVIEWED"
        )
        auto_published = bool(
            approved and metadata.get("decision_source") == "AUTO_APPROVAL"
        )
        rejected = bool(
            current_decision and latest_decision.Action == "book.children.rejected"
        )
        rescan_requested = bool(
            current_decision and latest_decision.Action == "book.children.rescan_requested"
        )
        prior_book_approval_stale = any(
            row.Action in {"book.children.approved", "book.children.rejected"}
            and isinstance(row.Metadata, dict)
            and row.Metadata.get("assessment_hash") != assessment_hash
            and not (
                row.Action == "book.children.approved"
                and row.Metadata.get("policy") in LEGACY_BOOK_APPROVAL_POLICY_VERSIONS
                and row.Metadata.get("page_snapshot") == snapshot
            )
            and not (
                row.Action == "book.children.approved"
                and row.Metadata.get("decision_source") == "AUTO_APPROVAL"
            )
            for row in ordered_decisions
        )
        if prior_book_approval_stale and not approved:
            blockers.append("BOOK_APPROVAL_STALE")
        if rescan_requested:
            blockers.append("BOOK_RESCAN_REQUESTED")
        ready_for_children = bool(
            page_count
            and ocr_completed == page_count
            and ocr_approval_valid == page_count
            and proofreading_completed == page_count
            and safety_completed == page_count
            and not finding_count
            and not review_required
            and not page_blockers
            and not duplicate_pages
            and not missing_page_numbers
            and not empty_ocr_pages
            and not missing_image_pages
            and not unreviewed_image_only_pages
            and expected_page_count_status != "UNDER_EXPECTED"
            and (not COPYRIGHT_BLOCKS_BOOK_APPROVAL or rights_status == "REVIEWED")
        )
        if auto_published:
            status_value = "PUBLISHED"
        elif approved:
            status_value = "APPROVED_BY_ADMIN"
        elif rejected:
            status_value = "REJECTED_FOR_CHILDREN"
        elif failed_pages:
            status_value = "SCAN_FAILED"
        elif active_workflows or pending_pages:
            status_value = "PROCESSING"
        elif rescan_requested or stale_pages or (prior_book_approval_stale and not ready_for_children):
            status_value = "STALE"
        elif unsuitable or high_count:
            status_value = "REJECTED_FOR_CHILDREN"
        elif ready_for_children:
            status_value = "READY_FOR_CHILDREN"
        else:
            status_value = "PENDING_ADMIN_REVIEW"
        metadata = metadata if (current_decision or legacy_approved) else {}
        return BookApprovalAssessment(
            status=status_value,
            page_count=page_count,
            ocr_completed_pages=ocr_completed,
            ocr_approval_valid_pages=ocr_approval_valid,
            proofreading_status=proof_status,
            proofreading_completed_pages=proofreading_completed,
            proofreading_suggestion_count=suggestions,
            child_safety_status=safety_status,
            child_safety_completed_pages=safety_completed,
            processing_pages=active_workflows,
            failed_pages=failed_pages,
            stale_pages=stale_pages,
            copyright_status=copyright_status,
            copyright_finding_count=rights_finding_count,
            rights_profile_status=rights_status,  # type: ignore[arg-type]
            rights_profile_version=rights_version,
            rights_profile_hash=rights_hash,
            legacy_published_needs_rights_review=legacy_published_needs_rights_review,
            expected_page_count=expected_page_count,
            expected_page_count_status=expected_page_count_status,  # type: ignore[arg-type]
            missing_page_numbers=missing_page_numbers,
            duplicate_page_numbers=duplicate_pages,
            empty_ocr_page_numbers=empty_ocr_pages,
            missing_image_page_numbers=missing_image_pages,
            image_only_page_numbers=image_only_pages,
            finding_count=finding_count,
            high_finding_count=high_count,
            medium_finding_count=medium_count,
            warning_page_count=len(warning_pages),
            failed_or_unscanned_page_count=max(0, page_count - min(ocr_completed, proofreading_completed, safety_completed)),
            finding_groups=group_reads,
            assessment_hash=assessment_hash,
            assessed_at=now,
            admin_approved_at=latest_decision.CreatedAt if approved else None,
            admin_approved_by=latest_decision.ActorId if approved and not auto_published else None,
            admin_approved_by_name=(
                str(metadata.get("actor_name"))
                if approved and not auto_published and metadata.get("actor_name")
                else None
            ),
            admin_reason=(
                str(metadata.get("reason"))
                if approved and not auto_published and metadata.get("reason")
                else None
            ),
            publication_source=(
                "AUTO_APPROVAL"
                if auto_published
                else "ADMIN_APPROVAL"
                if approved
                else None
            ),
            rights_confirmed=bool(rights_status == "REVIEWED"),
            blockers=blockers,
        )

    async def auto_publish_if_eligible(self, book_id: UUID) -> bool:
        """Silent auto-publication is disabled; books require explicit Admin approval."""
        del book_id
        if not AUTO_APPROVAL_ENABLED:
            return False
        return False

    @staticmethod
    def _finding_read(
        finding: BookQualityFinding, page_number: int
    ) -> BookQualityFindingRead:
        return BookQualityFindingRead(
            id=finding.Id,
            page_scan_id=finding.PageScanId,
            book_id=finding.BookId,
            page_id=finding.PageId,
            page_number=page_number,
            page_revision_id=finding.PageRevisionId,
            issue_type=finding.IssueType,
            severity=finding.Severity,
            original_excerpt=finding.OriginalExcerpt,
            excerpt_start=finding.ExcerptStart,
            excerpt_end=finding.ExcerptEnd,
            suggested_correction=finding.SuggestedCorrection,
            explanation=finding.Explanation,
            detection_source=finding.DetectionSource,
            model_name=finding.ModelName,
            confidence=finding.Confidence,
            status=finding.Status,
            review_note=finding.ReviewNote,
            created_at=finding.CreatedAt,
        )

    async def _report_detail_response(
        self,
        report: BookContentReport,
        reporter_name: str | None,
        history: list[BookContentReportHistory],
        *,
        for_parent: bool = False,
    ) -> BookContentReportDetail:
        related_rows = (
            [] if for_parent else await self.repository.findings_for_report(report.Id)
        )
        current_page_revision_id: UUID | None = None
        page_revision_changed = False
        if not for_parent and report.PageId is not None and hasattr(self.repository, "page"):
            page = await self.repository.page(report.PageId)
            if page is not None:
                current_page_revision_id = page.CurrentVerifiedRevisionId
                if (
                    report.PageRevisionId is not None
                    and current_page_revision_id != report.PageRevisionId
                ):
                    page_revision_changed = True
        report_data = self._report_read(report).model_dump()
        report_data["reporter_name"] = (
            reporter_name or report.ReporterNameSnapshot
        )
        return BookContentReportDetail(
            **report_data,
            reporter_id=report.ReporterId,
            verified_text_snapshot=report.VerifiedTextSnapshot,
            content_hash_snapshot=report.ContentHashSnapshot,
            current_page_revision_id=None if for_parent else current_page_revision_id,
            page_revision_changed=False if for_parent else page_revision_changed,
            admin_resolution_note=report.AdminResolutionNote,
            reviewed_by=None if for_parent else report.ReviewedBy,
            reviewed_by_name=None if for_parent else report.ReviewedByNameSnapshot,
            resolved_at=report.ResolvedAt,
            history=[
                BookContentReportHistoryRead(
                    actor_name=(
                        ("Phụ huynh" if row.ActorId == report.ReporterId else "Admin ViRead")
                        if for_parent
                        else row.ActorNameSnapshot
                    ),
                    from_status=row.FromStatus,
                    to_status=row.ToStatus,
                    note=row.Note,
                    created_at=row.CreatedAt,
                )
                for row in history
            ],
            related_findings=[
                self._finding_read(finding, page_number)
                for finding, page_number in related_rows
            ],
        )

    async def create_parent_report(
        self, actor_id: UUID, book_id: UUID, payload: BookContentReportCreate
    ) -> BookContentReportDetail:
        # Lock the authenticated profile row to serialize per-parent idempotency
        # checks and rate-limit evaluation. Client identity is never accepted.
        profile = await self.repository.profile_for_update(actor_id)
        if (
            profile is None
            or not isinstance(profile.Role, str)
            or profile.Role.strip().casefold() != "parent"
            or profile.Active != 1
        ):
            raise HTTPException(status_code=403, detail="Access denied")

        previous = await self.repository.report_by_idempotency_key(
            actor_id, payload.idempotency_key
        )
        if previous is not None:
            detail = await self.repository.report_detail(previous.Id)
            if detail is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            history = await self.repository.report_history(previous.Id)
            return await self._report_detail_response(
                detail[0], detail[1], history, for_parent=True
            )

        now = datetime.now(timezone.utc)
        if await self.repository.count_recent_reports(
            actor_id, now - timedelta(hours=1)
        ) >= 10:
            raise HTTPException(
                status_code=429,
                detail="Bạn đã gửi nhiều báo cáo trong thời gian ngắn. Vui lòng thử lại sau.",
                headers={"Retry-After": "3600"},
            )

        # Lock the book row so every Parent/Admin scan enqueue for this book is
        # serialized and a single active full-book run can be reused.
        book = await self.repository.book(book_id, lock=True)
        if book is None or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=404, detail="Resource not found")

        page = None
        revision = None
        if payload.page_id is not None:
            page = await self.repository.page(payload.page_id, lock=True)
            if page is None or page.BookId != book_id or page.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=404, detail="Resource not found")
            if page.CurrentVerifiedRevisionId is None:
                raise HTTPException(
                    status_code=409,
                    detail="Trang chưa có nội dung VERIFIED để lưu snapshot báo cáo.",
                )
            revision = await self.repository.revision(
                page.Id, page.CurrentVerifiedRevisionId
            )
            if (
                revision is None
                or revision.PageId != page.Id
                or revision.VerificationStatus != "VERIFIED"
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Revision hiện hành không hợp lệ; vui lòng tải lại trang.",
                )

        run = await self.repository.active_scan_for_book(book_id)
        is_new_scan_run = run is None
        if run is None:
            run = BookQualityScanRun(
                Id=uuid4(),
                BookId=book.Id,
                BookTitleSnapshot=str(book.Title)[:500],
                TriggerType="PARENT_REPORT",
                Status="QUEUED",
            )

        actor_name = (profile.DisplayName or "Phụ huynh")[:160]
        report = BookContentReport(
            Id=uuid4(),
            ReporterId=actor_id,
            ReporterNameSnapshot=actor_name,
            BookId=book.Id,
            BookTitleSnapshot=str(book.Title)[:500],
            PageId=page.Id if page else None,
            PageNumberSnapshot=page.PageNumber if page else None,
            PageRevisionId=revision.Id if revision else None,
            VerifiedTextSnapshot=(
                revision.VerifiedText if revision is not None else None
            ),
            ContentHashSnapshot=revision.ContentHash if revision is not None else None,
            IssueType=payload.issue_type,
            Description=payload.description,
            ReportedText=payload.reported_text,
            SuggestedCorrection=payload.suggested_correction,
            IdempotencyKey=payload.idempotency_key,
            ScanRunId=run.Id,
            Status="OPEN",
        )
        history_entry = BookContentReportHistory(
            Id=uuid4(),
            ReportId=report.Id,
            ActorId=actor_id,
            ActorNameSnapshot=actor_name,
            FromStatus=None,
            ToStatus="OPEN",
            Note="Báo cáo được tạo.",
        )

        try:
            # Keep all writes and response reads in one transaction. Explicit
            # flushes establish FK dependencies before dependent rows are added.
            if is_new_scan_run:
                await self.repository.add_scan_run(run)
            await self.repository.add_report(report)
            await self.repository.add_report_history(history_entry)

            if run.Id is not None:
                # Link existing findings only after the report row exists. These
                # links remain atomic with the report and initial history.
                await self.repository.link_existing_findings_to_report(
                    report_id=report.Id,
                    scan_id=run.Id,
                )

            # Load server defaults and construct the complete response before
            # committing. A failure in history/detail/finding reads must still
            # roll back the report, scan run, history and links together.
            await self.repository.refresh(report)
            history = await self.repository.report_history(report.Id)
            row = await self.repository.report_detail(report.Id)
            response = await self._report_detail_response(
                report,
                row[1] if row else report.ReporterNameSnapshot,
                history,
                for_parent=True,
            )

            await self.repository.commit()
            return response
        except IntegrityError as exc:
            # Flush can fail before commit. Always reset the failed transaction.
            duplicate_idempotency_conflict = (
                is_book_report_idempotency_violation(exc)
            )
            await self.repository.rollback()

            # Only the named reporter/idempotency unique constraint is an
            # idempotent retry. Never hide an unrelated FK/CHECK/UNIQUE error.
            if duplicate_idempotency_conflict:
                duplicate = await self.repository.report_by_idempotency_key(
                    actor_id, payload.idempotency_key
                )
                if duplicate is not None:
                    detail = await self.repository.report_detail(duplicate.Id)
                    if detail is None:
                        raise HTTPException(
                            status_code=404, detail="Resource not found"
                        )
                    history = await self.repository.report_history(duplicate.Id)
                    return await self._report_detail_response(
                        detail[0], detail[1], history, for_parent=True
                    )
            raise
        except BaseException:
            # Includes failures from every flush, finding-link insert, response
            # read/build and commit.
            await self.repository.rollback()
            raise

    async def list_parent_reports(
        self, actor_id: UUID, *, limit: int, offset: int
    ) -> BookContentReportPage:
        await self._require_role(actor_id, "parent")
        items, total = await self.repository.reports_for_parent(
            actor_id, limit=limit, offset=offset
        )
        return BookContentReportPage(
            items=[self._report_read(item) for item in items],
            total=total,
            limit=limit,
            offset=offset,
        )

    async def get_parent_report(
        self, actor_id: UUID, report_id: UUID
    ) -> BookContentReportDetail:
        await self._require_role(actor_id, "parent")
        row = await self.repository.report_detail(report_id)
        if row is None or row[0].ReporterId != actor_id:
            raise HTTPException(status_code=404, detail="Resource not found")
        history = await self.repository.report_history(report_id)
        return await self._report_detail_response(
            row[0], row[1], history, for_parent=True
        )

    async def list_admin_reports(
        self,
        actor_id: UUID,
        *,
        status: str | None,
        issue_type: str | None,
        scope: str | None = None,
        book_id: UUID | None,
        search: str | None,
        created_after: datetime | None,
        created_before: datetime | None,
        limit: int,
        offset: int,
    ) -> BookQualityReportAdminPage:
        await self._require_role(actor_id, "admin")
        if created_after is not None and created_after.tzinfo is None:
            raise HTTPException(status_code=422, detail="created_after must include a timezone")
        if created_before is not None and created_before.tzinfo is None:
            raise HTTPException(status_code=422, detail="created_before must include a timezone")
        if created_after is not None and created_before is not None and created_after > created_before:
            raise HTTPException(status_code=422, detail="created_after must not be later than created_before")
        rows, total, summary = await self.repository.admin_reports(
            status=status,
            issue_type=issue_type,
            scope=scope,
            book_id=book_id,
            search=search,
            created_after=created_after,
            created_before=created_before,
            limit=limit,
            offset=offset,
        )
        return BookQualityReportAdminPage(
            items=[self._report_read(row) for row, _ in rows],
            total=total,
            summary=summary,
            limit=limit,
            offset=offset,
        )

    async def get_admin_report(
        self, actor_id: UUID, report_id: UUID
    ) -> BookContentReportDetail:
        await self._require_role(actor_id, "admin")
        row = await self.repository.report_detail(report_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        history = await self.repository.report_history(report_id)
        return await self._report_detail_response(row[0], row[1], history)

    async def update_report_status(
        self, actor_id: UUID, report_id: UUID, payload: BookContentReportStatusUpdate
    ) -> BookContentReportDetail:
        await self._require_role(actor_id, "admin")
        report = await self.repository.report(report_id, lock=True)
        if report is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        old_status = report.Status
        new_status = payload.status
        allowed = {
            "OPEN": {"UNDER_REVIEW", "RESOLVED", "REJECTED"},
            "UNDER_REVIEW": {"OPEN", "RESOLVED", "REJECTED"},
            "RESOLVED": {"OPEN", "UNDER_REVIEW"},
            "REJECTED": {"OPEN", "UNDER_REVIEW"},
        }
        if new_status == old_status:
            row = await self.repository.report_detail(report_id)
            history = await self.repository.report_history(report_id)
            return await self._report_detail_response(row[0], row[1], history)
        if new_status not in allowed.get(old_status, set()):
            raise HTTPException(
                status_code=409, detail="Invalid report status transition"
            )
        if new_status in ("RESOLVED", "REJECTED") and not payload.resolution_note:
            raise HTTPException(
                status_code=422,
                detail="Cần ghi chú xử lý khi giải quyết hoặc từ chối báo cáo.",
            )
        if (
            new_status == "RESOLVED"
            and report.PageId is not None
            and report.IssueType
            in ("SPELLING_ERROR", "MISSING_CONTENT", "OCR_MISMATCH")
        ):
            page = await self.repository.page(report.PageId, lock=True)
            if (
                page is None
                or page.BookId != report.BookId
                or page.CurrentVerifiedRevisionId is None
                or page.CurrentVerifiedRevisionId == report.PageRevisionId
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Cần tạo và xác minh revision mới cho trang được báo lỗi trước khi giải quyết báo cáo.",
                )
            current_revision = await self.repository.revision(
                page.Id, page.CurrentVerifiedRevisionId
            )
            if (
                current_revision is None
                or current_revision.PageId != page.Id
                or current_revision.VerificationStatus != "VERIFIED"
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Revision hiện tại chưa được xác minh; chưa thể giải quyết báo cáo.",
                )
        if (
            new_status in ("OPEN", "UNDER_REVIEW")
            and old_status in ("RESOLVED", "REJECTED")
            and not payload.resolution_note
        ):
            raise HTTPException(
                status_code=422,
                detail="Cần ghi chú khi mở lại báo cáo đã đóng.",
            )

        actor_name = (await self.repository.profile_name(actor_id) or "Admin")[:160]
        now = datetime.now(timezone.utc)
        report.Status = new_status
        report.AdminResolutionNote = payload.resolution_note
        report.ReviewedBy = actor_id
        report.ReviewedByNameSnapshot = actor_name
        report.ResolvedAt = now if new_status == "RESOLVED" else None
        report.UpdatedAt = now
        self.repository.db.add(
            BookContentReportHistory(
                Id=uuid4(),
                ReportId=report.Id,
                ActorId=actor_id,
                ActorNameSnapshot=actor_name,
                FromStatus=old_status,
                ToStatus=new_status,
                Note=payload.resolution_note,
            )
        )
        try:
            await self.repository.db.commit()
            await self.repository.db.refresh(report)
        except Exception:
            await self.repository.db.rollback()
            raise

        row = await self.repository.report_detail(report_id)
        history = await self.repository.report_history(report_id)
        return await self._report_detail_response(row[0], row[1], history)

    async def enqueue_scan(
        self,
        actor_id: UUID,
        book_id: UUID,
        *,
        trigger_type: str = "ADMIN_MANUAL",
        scope: str = "BOOK",
        target_page_id: UUID | None = None,
    ) -> BookQualityScanRead:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if scope not in ("BOOK", "PAGE"):
            raise HTTPException(status_code=422, detail="Invalid scan scope")
        if scope == "PAGE":
            if target_page_id is None:
                raise HTTPException(status_code=422, detail="Page scan requires a page ID")
            target_page = await self.repository.page(target_page_id, lock=True)
            if target_page is None or target_page.BookId != book_id:
                raise HTTPException(status_code=404, detail="Resource not found")
        elif target_page_id is not None:
            raise HTTPException(status_code=422, detail="Book scan cannot target a page")
        existing = await self.repository.active_scan_for_book(
            book_id,
            scope=scope,
            target_page_id=target_page_id,
        )
        if existing is not None:
            response = self._scan_read(existing)
            await self._ensure_page_ai_workflows(actor_id, book_id)
            return response
        if scope == "BOOK":
            latest = await self.repository.latest_scan(book_id)
            if latest is not None and latest.Scope == "BOOK" and latest.Status == "COMPLETED":
                rows = await self.repository.book_assessment_rows(book_id)
                current_pages = [
                    (page, revision)
                    for page, revision, *_ in rows
                    if page.LifecycleStatus == "ACTIVE"
                ]
                completed_pages = await self.repository.page_scans(latest.Id)
                completed_by_page = {str(item.PageId): item for item in completed_pages}
                reusable = len(current_pages) == len(completed_pages) and all(
                    revision is not None
                    and revision.VerificationStatus == "VERIFIED"
                    and (scan := completed_by_page.get(str(page.Id))) is not None
                    and scan.Status == "COMPLETED"
                    and scan.PageRevisionId == revision.Id
                    and scan.ContentHash == revision.ContentHash
                    for page, revision in current_pages
                )
                if reusable:
                    response = self._scan_read(latest)
                    await self._ensure_page_ai_workflows(actor_id, book_id)
                    return response
        run = BookQualityScanRun(
            Id=uuid4(),
            BookId=book.Id,
            BookTitleSnapshot=str(book.Title)[:500],
            TriggerType=trigger_type,
            Scope=scope,
            TargetPageId=target_page_id,
            Status="QUEUED",
        )
        self.repository.db.add(run)
        try:
            await self.repository.db.commit()
            await self.repository.db.refresh(run)
        except Exception:
            await self.repository.db.rollback()
            raise
        response = self._scan_read(run)
        await self._ensure_page_ai_workflows(actor_id, book_id)
        return response

    async def _ensure_page_ai_workflows(self, actor_id: UUID, book_id: UUID) -> None:
        """Queue missing/stale page Proofreading and Safety on the existing durable worker."""
        rows = await self.repository.book_assessment_rows(book_id, lock=True)
        ocr_repository = AdminOcrRepository(self.repository.db)
        workflow_repository = AdminAiWorkflowRepository(self.repository.db)
        workflow_service = AdminAiWorkflowService(self.repository.db)
        now = datetime.now(timezone.utc)
        for page, revision, workflow, *_ in rows:
            if (
                page.LifecycleStatus != "ACTIVE"
                or revision is None
                or revision.VerificationStatus != "VERIFIED"
                or page.CurrentVerifiedRevisionId != revision.Id
            ):
                continue
            if workflow is not None and workflow.PageRevisionId == revision.Id:
                if workflow.Status in {"QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                    continue
                if workflow.Status == "FAILED":
                    AdminAiWorkflowService.prepare_retry(workflow, actor_id, now)
                    await self.repository.db.commit()
                    continue
                if (
                    workflow.Status == "READY_FOR_ADMIN_REVIEW"
                    and workflow.CandidateHash
                    and workflow.SafetyStatus in {"PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED"}
                    and workflow.SafetyInputHash == workflow.CandidateHash
                ):
                    continue
                if workflow.CandidateText and workflow.CandidateHash:
                    AdminAiWorkflowService.prepare_safety_rescan(
                        workflow, actor_id, now, "Book Quality scan requested"
                    )
                    await self.repository.db.commit()
                    continue

            words = await ocr_repository.words(revision.Id)
            if not words or not (revision.VerifiedText or "").strip():
                continue
            try:
                word_inputs = [
                    AdminOcrWordInput(
                        word_index=int(word.WordIndex),
                        line_index=int(word.LineIndex),
                        text=str(word.Text),
                        normalized_text=str(word.NormalizedText),
                        bbox=tuple(word.BoundingBox),
                        ocr_confidence=word.OCRConfidence,
                    )
                    for word in words
                ]
            except (TypeError, ValueError):
                # Preserve the page and report the missing workflow in the
                # aggregate; approval will identify this page as incomplete.
                continue
            input_hash = AdminAiWorkflowService._hash(revision.VerifiedText)
            payload = AdminAiWorkflowCreate(
                page_revision_id=revision.Id,
                idempotency_key=uuid5(
                    NAMESPACE_URL,
                    f"viread-book-quality:{book_id}:{page.Id}:{revision.Id}:{input_hash}",
                ),
                draft_text=revision.VerifiedText,
                words=word_inputs,
            )
            existing_for_input = await workflow_repository.by_input_snapshot(
                page.Id, revision.Id, input_hash
            )
            if existing_for_input is not None and existing_for_input.Status == "FAILED":
                AdminAiWorkflowService.prepare_retry(existing_for_input, actor_id, now)
                await self.repository.db.commit()
                continue
            await workflow_service.start(actor_id, page.Id, payload)

        if callable(getattr(self.repository.db, "commit", None)) and callable(
            getattr(self.repository, "book", None)
        ):
            await self.repository.db.commit()

    async def list_book_scans(
        self, actor_id: UUID, book_id: UUID
    ) -> list[BookQualityScanRead]:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        return [
            self._scan_read(run)
            for run in await self.repository.scan_runs_for_book(book_id)
        ]

    async def get_scan_detail(
        self, actor_id: UUID, scan_id: UUID
    ) -> BookQualityScanDetail:
        await self._require_role(actor_id, "admin")
        run = await self.repository.scan_run(scan_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        pages = []
        for page_scan in await self.repository.page_scans(scan_id):
            findings = await self.repository.findings_for_page_scan(page_scan.Id)
            pages.append(
                BookQualityPageScanRead(
                    id=page_scan.Id,
                    page_id=page_scan.PageId,
                    page_number=page_scan.PageNumberSnapshot,
                    page_lifecycle_status=page_scan.PageLifecycleSnapshot,
                    page_revision_id=page_scan.PageRevisionId,
                    content_hash=page_scan.ContentHash,
                    status=page_scan.Status,
                    rule_check_status=page_scan.RuleCheckStatus,
                    ai_analysis_status=page_scan.AIAnalysisStatus,
                    rejected_ai_finding_count=page_scan.RejectedAIFindingCount,
                    error_code=page_scan.ErrorCode,
                    error_summary=page_scan.ErrorSummary,
                    findings=[
                        self._finding_read(finding, page_scan.PageNumberSnapshot)
                        for finding in findings
                    ],
                )
            )
        return BookQualityScanDetail(
            **self._scan_read(run).model_dump(),
            pages=pages,
        )

    async def list_books(
        self,
        actor_id: UUID,
        *,
        search: str | None,
        limit: int,
        offset: int,
        status_filter: str | None = None,
        alert_filter: str | None = None,
        issue_filter: str | None = None,
    ) -> BookQualityBookPage:
        await self._require_role(actor_id, "admin")
        rows = await self.repository.all_books_for_assessment(search=search)
        book_ids = [book.Id for book, *_ in rows]
        page_rows = await self.repository.all_book_assessment_rows(book_ids)
        page_rows_by_book: dict[UUID, list[tuple]] = {book_id: [] for book_id in book_ids}
        for book_id, page, revision, workflow, findings_hash, metadata_hash, proofread_metadata_hash in page_rows:
            page_rows_by_book.setdefault(book_id, []).append(
                (
                    book_id,
                    page,
                    revision,
                    workflow,
                    findings_hash,
                    metadata_hash,
                    proofread_metadata_hash,
                )
            )
        decisions_by_book: dict[UUID, list] = {book_id: [] for book_id in book_ids}
        for decision in await self.repository.book_decisions_for_books(book_ids):
            if decision.ResourceId is not None:
                decisions_by_book.setdefault(decision.ResourceId, []).append(decision)
        rights_by_book: dict[UUID, list[BookContentRightsProfile]] = {book_id: [] for book_id in book_ids}
        if hasattr(self.repository, "rights_profiles_for_books"):
            for profile in await self.repository.rights_profiles_for_books(book_ids):
                rights_by_book.setdefault(profile.BookId, []).append(profile)
        open_safety_reports_by_book = (
            await self.repository.open_safety_report_counts_for_books(book_ids)
            if hasattr(self.repository, "open_safety_report_counts_for_books")
            else {}
        )
        assessed_rows = []
        status_counts: dict[str, int] = {}
        alert_counts = {"CHILD_SAFETY": 0, "COPYRIGHT": 0, "BOTH": 0}
        issue_filter_counts = {
            "MISSING_CONTENT": 0,
            "SAFETY_ALERTS": 0,
            "MISSING_RIGHTS": 0,
            "OPEN_REPORTS": 0,
            "READY_FOR_APPROVAL": 0,
        }
        for row in rows:
            book = row[0]
            open_report_count = int(row[2] or 0)
            open_safety_report_count = int(open_safety_reports_by_book.get(book.Id, 0))
            assessment = self._assessment(
                page_rows_by_book.get(book.Id, []),
                decisions_by_book.get(book.Id, []),
                book=book,
                rights_profiles=rights_by_book.get(book.Id, []),
            )
            status_counts[assessment.status] = status_counts.get(assessment.status, 0) + 1
            has_safety = bool(
                assessment.finding_count > 0
                or assessment.high_finding_count > 0
                or "SUITABILITY_REVIEW_REQUIRED" in assessment.blockers
                or open_safety_report_count > 0
            )
            has_copyright = bool(
                assessment.rights_profile_status != "REVIEWED"
                or (
                    assessment.copyright_finding_count is not None
                    and assessment.copyright_finding_count > 0
                )
            )
            has_missing_content = bool(
                assessment.page_count == 0
                or assessment.ocr_completed_pages < assessment.page_count
                or bool(assessment.missing_page_numbers)
                or bool(assessment.duplicate_page_numbers)
                or bool(assessment.empty_ocr_page_numbers)
                or bool(assessment.missing_image_page_numbers)
                or assessment.expected_page_count_status == "UNDER_EXPECTED"
            )
            has_missing_rights = assessment.rights_profile_status != "REVIEWED"
            ready_for_approval = assessment.status == "READY_FOR_CHILDREN"
            issue_page_count = max(
                assessment.failed_or_unscanned_page_count,
                assessment.warning_page_count,
                len(assessment.empty_ocr_page_numbers),
                len(assessment.missing_image_page_numbers),
                len(assessment.duplicate_page_numbers),
            )
            if has_safety:
                alert_counts["CHILD_SAFETY"] += 1
                issue_filter_counts["SAFETY_ALERTS"] += 1
            if has_copyright:
                alert_counts["COPYRIGHT"] += 1
            if has_safety and has_copyright:
                alert_counts["BOTH"] += 1
            if has_missing_content:
                issue_filter_counts["MISSING_CONTENT"] += 1
            if has_missing_rights:
                issue_filter_counts["MISSING_RIGHTS"] += 1
            if open_report_count > 0:
                issue_filter_counts["OPEN_REPORTS"] += 1
            if ready_for_approval:
                issue_filter_counts["READY_FOR_APPROVAL"] += 1
            assessed_rows.append((
                row,
                assessment,
                {
                    "open_safety_report_count": open_safety_report_count,
                    "verified_page_count": assessment.ocr_completed_pages,
                    "issue_page_count": issue_page_count,
                    "has_missing_content": has_missing_content,
                    "has_safety_alerts": has_safety,
                    "has_missing_rights": has_missing_rights,
                    "ready_for_approval": ready_for_approval,
                },
            ))
        if status_filter:
            assessed_rows = [
                item for item in assessed_rows if item[1].status == status_filter
            ]
        if alert_filter == "CHILD_SAFETY":
            assessed_rows = [item for item in assessed_rows if item[2]["has_safety_alerts"]]
        elif alert_filter == "COPYRIGHT":
            assessed_rows = [item for item in assessed_rows if item[2]["has_missing_rights"]]
        elif alert_filter == "BOTH":
            assessed_rows = [
                item
                for item in assessed_rows
                if item[2]["has_safety_alerts"] and item[2]["has_missing_rights"]
            ]
        if issue_filter == "MISSING_CONTENT":
            assessed_rows = [item for item in assessed_rows if item[2]["has_missing_content"]]
        elif issue_filter == "SAFETY_ALERTS":
            assessed_rows = [item for item in assessed_rows if item[2]["has_safety_alerts"]]
        elif issue_filter == "MISSING_RIGHTS":
            assessed_rows = [item for item in assessed_rows if item[2]["has_missing_rights"]]
        elif issue_filter == "OPEN_REPORTS":
            assessed_rows = [item for item in assessed_rows if int(item[0][2] or 0) > 0]
        elif issue_filter == "READY_FOR_APPROVAL":
            assessed_rows = [item for item in assessed_rows if item[2]["ready_for_approval"]]
        total = len(assessed_rows)
        page = assessed_rows[offset : offset + limit]
        items = []
        for (book, report_count, open_report_count, finding_count, review_count), assessment, flags in page:
            latest = await self.repository.latest_scan(book.Id)
            items.append(
                BookQualityBookSummary(
                    book_id=book.Id,
                    book_title=book.Title,
                    report_count=int(report_count or 0),
                    open_report_count=int(open_report_count or 0),
                    open_safety_report_count=int(flags["open_safety_report_count"]),
                    finding_count=int(finding_count or 0),
                    needs_review_finding_count=int(review_count or 0),
                    verified_page_count=int(flags["verified_page_count"]),
                    issue_page_count=int(flags["issue_page_count"]),
                    has_missing_content=bool(flags["has_missing_content"]),
                    has_safety_alerts=bool(flags["has_safety_alerts"]),
                    has_missing_rights=bool(flags["has_missing_rights"]),
                    ready_for_approval=bool(flags["ready_for_approval"]),
                    latest_scan=self._scan_read(latest) if latest else None,
                    assessment=assessment,
                )
            )
        return BookQualityBookPage(
            items=items,
            total=total,
            limit=limit,
            offset=offset,
            summary=status_counts,
            alert_summary=alert_counts,
            issue_filter_summary=issue_filter_counts,
        )

    @classmethod
    def _build_page_items(
        cls,
        assessment_rows: list[tuple],
        assessment: BookApprovalAssessment,
        *,
        rights_profiles: list[BookContentRightsProfile],
        latest_revisions: dict[UUID, object],
        open_reports_by_page: dict[UUID, int],
    ) -> list[BookQualityPageItemRead]:
        book_profile = next((p for p in rights_profiles if p.PageId is None), None)
        overrides = {p.PageId: p for p in rights_profiles if p.PageId is not None}
        duplicate_set = set(assessment.duplicate_page_numbers)
        empty_ocr_set = set(assessment.empty_ocr_page_numbers)
        missing_img_set = set(assessment.missing_image_page_numbers)
        items: list[BookQualityPageItemRead] = []
        for row in assessment_rows:
            if len(row) == 7:
                _, page, revision, workflow, *_ = row
            else:
                page, revision, workflow, *_ = row
            if page.LifecycleStatus not in {"ACTIVE", "PROCESSING"}:
                continue
            page_no = int(page.PageNumber)
            latest_rev = latest_revisions.get(page.Id) or revision
            content_type = str(getattr(page, "ContentType", None) or "CONTENT")
            issues: list[str] = []
            if page_no in missing_img_set:
                issues.append("MISSING_IMAGE")
            if page.LifecycleStatus == "PROCESSING":
                issues.append("OCR_PROCESSING")
            if page_no in empty_ocr_set:
                issues.append("EMPTY_OCR")
            if page_no in duplicate_set:
                issues.append("DUPLICATE_PAGE")
            if revision is None or revision.VerificationStatus != "VERIFIED":
                issues.append("NOT_VERIFIED")
            if workflow is None:
                issues.append("NOT_CHECKED_BY_AI")
            elif workflow.Status == "FAILED":
                issues.append("AI_FAILED")
            elif workflow.SafetyStatus == "STALE":
                issues.append("NEEDS_RECHECK")

            findings = list(workflow.Findings or []) if workflow is not None else []
            high_findings = sum(
                1
                for item in findings
                if isinstance(item, dict)
                and str(item.get("severity") or "").upper() in {"HIGH", "CRITICAL"}
            )
            if high_findings or (workflow is not None and workflow.Suitability == "NOT_RECOMMENDED"):
                issues.append("SAFETY_BLOCKING")
            elif findings or (workflow is not None and workflow.Suitability == "REVIEW_REQUIRED"):
                issues.append("SAFETY_WARNING")

            img_safety = (
                str(getattr(workflow, "ImageSafetyStatus", None) or "NOT_REVIEWED")
                if workflow is not None
                else "NOT_REVIEWED"
            )
            if content_type == "COVER_OR_IMAGE_ONLY" and img_safety != "MANUAL_REVIEWED_SAFE":
                issues.append("IMAGE_REVIEW_REQUIRED")
            elif img_safety == "MANUAL_REVIEWED_CONCERN":
                issues.append("IMAGE_SAFETY_CONCERN")

            override = overrides.get(page.Id)
            effective_rights = override or book_profile
            _r_blockers, effective_rights_status = AdminOcrService._rights_profile_blockers(
                effective_rights
            )
            if effective_rights_status != "REVIEWED":
                issues.append(f"RIGHTS_{effective_rights_status}")

            open_reports = int(open_reports_by_page.get(page.Id, 0))
            if open_reports > 0:
                issues.append("OPEN_PARENT_REPORT")

            items.append(
                BookQualityPageItemRead(
                    page_id=page.Id,
                    page_number=page_no,
                    lifecycle_status=page.LifecycleStatus,
                    content_type=content_type,  # type: ignore[arg-type]
                    current_verified_revision_id=page.CurrentVerifiedRevisionId,
                    latest_revision_id=getattr(latest_rev, "Id", None),
                    verification_status=(
                        str(getattr(revision, "VerificationStatus", None))
                        if revision is not None
                        else (
                            str(getattr(latest_rev, "VerificationStatus", "MISSING"))
                            if latest_rev is not None
                            else "MISSING"
                        )
                    ),
                    content_issues=issues,
                    proofreading_status=(
                        "COMPLETED"
                        if workflow is not None and workflow.ProofreadText is not None
                        else (str(workflow.Status) if workflow is not None else "NOT_STARTED")
                    ),
                    uncertain_word_count=len(workflow.UncertainWordIndices or []) if workflow is not None else 0,
                    safety_status=str(workflow.SafetyStatus) if workflow is not None else "NOT_STARTED",
                    safety_suitability=workflow.Suitability if workflow is not None else None,
                    safety_finding_count=len(findings),
                    high_finding_count=high_findings,
                    image_safety_status=img_safety,
                    rights_status=effective_rights_status,  # type: ignore[arg-type]
                    has_rights_override=override is not None,
                    open_report_count=open_reports,
                    latest_workflow_id=workflow.Id if workflow is not None else None,
                    has_issues=len(issues) > 0,
                )
            )
        return items

    async def get_book_detail(
        self, actor_id: UUID, book_id: UUID
    ) -> BookQualityBookDetail:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        reports, _ = await self.repository.reports_for_book(book_id, limit=50)
        scans = await self.repository.scan_runs_for_book(book_id)
        latest_detail = (
            await self.get_scan_detail(actor_id, scans[0].Id) if scans else None
        )
        workflows = await self.repository.ai_workflows_for_book(book_id)
        workflow_summary = await self.repository.ai_workflow_summary_for_book(book_id)
        assessment_rows = await self.repository.book_assessment_rows(book_id)
        decisions = await self.repository.book_decisions(book_id)
        rights_profiles = (
            await self.repository.rights_profiles_for_book(book_id)
            if hasattr(self.repository, "rights_profiles_for_book")
            else []
        )
        latest_revisions = (
            await self.repository.latest_revisions_by_page_for_book(book_id)
            if hasattr(self.repository, "latest_revisions_by_page_for_book")
            else {}
        )
        open_reports_by_page = (
            await self.repository.open_reports_by_page_for_book(book_id)
            if hasattr(self.repository, "open_reports_by_page_for_book")
            else {}
        )
        assessment = self._assessment(
            assessment_rows,
            decisions,
            book=book,
            rights_profiles=rights_profiles,
            latest_revisions=latest_revisions,
        )
        book_rights = next((p for p in rights_profiles if p.PageId is None), None)
        page_rights_overrides = [p for p in rights_profiles if p.PageId is not None]
        pages = self._build_page_items(
            assessment_rows,
            assessment,
            rights_profiles=rights_profiles,
            latest_revisions=latest_revisions,
            open_reports_by_page=open_reports_by_page,
        )
        return BookQualityBookDetail(
            book_id=book.Id,
            book_title=str(book.Title),
            expected_page_count=getattr(book, "ExpectedPageCount", None),
            reports=[self._report_read(report) for report in reports],
            scans=[self._scan_read(run) for run in scans],
            latest_scan_detail=latest_detail,
            ai_workflows=[AdminAiWorkflowService._read(row) for row in workflows],
            ai_workflow_summary=workflow_summary,
            rights_profile=self._rights_profile_read(book_rights, book.Id),
            page_rights_overrides=[
                self._rights_profile_read(item, book.Id) for item in page_rights_overrides
            ],
            pages=pages,
            assessment=assessment,
            decision_history=[self._decision_read(row) for row in decisions],
        )

    @staticmethod
    def _decision_read(row) -> dict[str, object]:
        metadata = row.Metadata if isinstance(row.Metadata, dict) else {}
        return {
            "action": row.Action,
            "actor_id": str(row.ActorId) if row.ActorId else None,
            "actor_name": metadata.get("actor_name"),
            "created_at": row.CreatedAt.isoformat() if row.CreatedAt else None,
            "reason": metadata.get("reason"),
            "assessment_hash": metadata.get("assessment_hash"),
            "category": metadata.get("category"),
            "rights_confirmed": metadata.get("rights_confirmed", False),
        }

    async def decide_book(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: BookQualityBookDecisionRequest,
    ) -> BookQualityBookDecisionRead:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        rows = await self.repository.book_assessment_rows(book_id, lock=True)
        decisions = await self.repository.book_decisions(book_id)
        rights_profiles = (
            await self.repository.rights_profiles_for_book(book_id)
            if hasattr(self.repository, "rights_profiles_for_book")
            else []
        )
        current = self._assessment(
            rows, decisions, book=book, rights_profiles=rights_profiles
        )
        now = datetime.now(timezone.utc)
        actor_name = (await self.repository.profile_name(actor_id) or "Admin")[:160]
        action_by_decision = {
            "APPROVE": "book.children.approved",
            "REJECT": "book.children.rejected",
            "REQUEST_RESCAN": "book.children.rescan_requested",
            "FALSE_POSITIVE": "book.children.false_positive_reviewed",
        }
        latest_decision = max(
            decisions,
            key=lambda item: (
                item.CreatedAt or datetime.min.replace(tzinfo=timezone.utc),
                str(item.Id),
            ),
            default=None,
        )
        latest_metadata = (
            latest_decision.Metadata
            if latest_decision is not None and isinstance(latest_decision.Metadata, dict)
            else {}
        )
        if (
            latest_decision is not None
            and latest_decision.Action == action_by_decision[payload.decision]
            and latest_metadata.get("assessment_hash") == current.assessment_hash
            and latest_metadata.get("reason") == payload.reason
            and latest_metadata.get("category") == payload.category
            and latest_metadata.get("rights_confirmed", False)
            == (current.rights_profile_status == "REVIEWED")
        ):
            return BookQualityBookDecisionRead(
                book_id=book_id,
                assessment=current,
                decision_history=[self._decision_read(row) for row in decisions],
            )
        current_workflows = []
        for row in rows:
            page, revision, workflow = row[:3]
            if (
                page.LifecycleStatus in {"ACTIVE", "PROCESSING"}
                and workflow is not None
                and revision is not None
                and workflow.PageRevisionId == revision.Id
            ):
                current_workflows.append(workflow)

        if payload.decision == "APPROVE":
            page_blockers: list[str] = []
            for row in rows:
                page, revision, workflow = row[:3]
                if page.LifecycleStatus not in {"ACTIVE", "PROCESSING"}:
                    continue
                page_label = f"trang {page.PageNumber}"
                if (
                    page.LifecycleStatus != "ACTIVE"
                    or revision is None
                    or revision.VerificationStatus != "VERIFIED"
                ):
                    page_blockers.append(f"{page_label}: thiếu OCR VERIFIED hiện hành")
                    continue
                if (
                    workflow is None
                    or workflow.PageRevisionId != revision.Id
                    or workflow.Status != "READY_FOR_ADMIN_REVIEW"
                    or workflow.ProofreadText is None
                ):
                    page_blockers.append(
                        f"{page_label}: Proofreading chưa hoàn tất trên revision hiện tại"
                    )
                    continue
                if (
                    not isinstance(workflow.CandidateText, str)
                    or not workflow.CandidateHash
                    or AdminAiWorkflowService._hash(workflow.CandidateText)
                    != workflow.CandidateHash
                ):
                    page_blockers.append(f"{page_label}: Candidate text/hash không nhất quán")
                    continue
                if (
                    not revision.VerifiedText
                    or AdminAiWorkflowService._hash(revision.VerifiedText) != workflow.CandidateHash
                ):
                    page_blockers.append(
                        f"{page_label}: Candidate khác OCR VERIFIED; cần lưu revision Candidate trước khi duyệt"
                    )
                    continue
                if (
                    workflow.SafetyStatus not in {"PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED"}
                    or workflow.SafetyInputHash != workflow.CandidateHash
                ):
                    page_blockers.append(f"{page_label}: Child Safety thiếu hoặc stale")
            if COPYRIGHT_BLOCKS_BOOK_APPROVAL and current.rights_profile_status != "REVIEWED":
                raise HTTPException(
                    status_code=409,
                    detail="Cần hoàn tất hồ sơ quyền sử dụng ở trạng thái Đã rà soát quyền sử dụng trước khi phê duyệt sách.",
                )
            if (
                current.missing_page_numbers
                or current.duplicate_page_numbers
                or current.empty_ocr_page_numbers
                or current.missing_image_page_numbers
                or current.expected_page_count_status == "UNDER_EXPECTED"
                or "IMAGE_ONLY_PAGES_UNREVIEWED" in current.blockers
            ):
                if current.missing_page_numbers:
                    page_blockers.append(
                        f"Nghi thiếu trang: {', '.join(f'trang {n}' for n in current.missing_page_numbers)}"
                    )
                if current.duplicate_page_numbers:
                    page_blockers.append(
                        f"Trang trùng nội dung: {', '.join(f'trang {n}' for n in current.duplicate_page_numbers)}"
                    )
                if current.empty_ocr_page_numbers:
                    page_blockers.append(
                        f"OCR trống: {', '.join(f'trang {n}' for n in current.empty_ocr_page_numbers)}"
                    )
                if current.missing_image_page_numbers:
                    page_blockers.append(
                        f"Thiếu ảnh gốc: {', '.join(f'trang {n}' for n in current.missing_image_page_numbers)}"
                    )
                if current.expected_page_count_status == "UNDER_EXPECTED":
                    page_blockers.append(
                        f"Thiếu trang so với số trang nguồn dự kiến ({current.page_count}/{current.expected_page_count})"
                    )
                if "IMAGE_ONLY_PAGES_UNREVIEWED" in current.blockers:
                    page_blockers.append("Còn trang bìa/hình ảnh chưa rà soát an toàn bằng tay")
            if (
                current.page_count == 0
                or current.ocr_completed_pages != current.page_count
                or current.ocr_approval_valid_pages != current.page_count
                or current.proofreading_status not in {"COMPLETED", "COMPLETED_WITH_SUGGESTIONS"}
                or current.child_safety_status != "COMPLETED"
                or current.failed_or_unscanned_page_count != 0
                or page_blockers
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "; ".join(page_blockers)
                        if page_blockers
                        else "Phê duyệt cần OCR, Proofreading và Child Safety hiện hành trên mọi trang đang hoạt động."
                    ),
                )
            if current.high_finding_count or any(
                workflow.Suitability == "NOT_RECOMMENDED"
                for workflow in current_workflows
            ):
                raise HTTPException(
                    status_code=409,
                    detail="High severity or NOT_RECOMMENDED content is blocked by the current child access policy.",
                )
            if current.finding_count or any(
                workflow.Suitability == "REVIEW_REQUIRED"
                for workflow in current_workflows
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Resolve Child Safety findings and REVIEW_REQUIRED pages before approving this book.",
                )
            # A book-level decision confirms current Safety results in one
            # auditable transaction. OCR verification and word alignment remain
            # governed by the existing per-page verification path.
            for row in rows:
                page, revision, workflow = row[:3]
                if page.LifecycleStatus not in {"ACTIVE", "PROCESSING"}:
                    continue
                if (
                    workflow is None
                    or revision is None
                    or workflow.PageRevisionId != revision.Id
                    or workflow.SafetyStatus not in {"PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED"}
                    or workflow.SafetyInputHash != workflow.CandidateHash
                ):
                    raise HTTPException(status_code=409, detail="A page Safety result is stale or incomplete.")
                workflow.SafetyStatus = "CONFIRMED"
                workflow.SafetyConfirmedAt = now
                workflow.SafetyConfirmedBy = actor_id
                workflow.OcrApprovedAt = workflow.OcrApprovedAt or now
                workflow.OcrApprovedBy = workflow.OcrApprovedBy or actor_id
                workflow.FinalApprovedTextHash = workflow.CandidateHash
                revision_meta = dict(revision.ProcessingMeta or {})
                revision_meta["admin_ai_workflow"] = {
                    "workflow_id": str(workflow.Id),
                    "candidate_hash": workflow.CandidateHash,
                    "safety_status": "CONFIRMED",
                    "safety_input_hash": workflow.SafetyInputHash,
                    "approval_scope": "BOOK_LEVEL_EXISTING_VERIFIED_REVISION",
                    "assessment_policy": BOOK_APPROVAL_POLICY_VERSION,
                }
                revision.ProcessingMeta = revision_meta
                workflow.ReviewEvents = list(workflow.ReviewEvents or []) + [{
                    "event": "BOOK_LEVEL_SAFETY_CONFIRMED",
                    "actor_id": str(actor_id),
                    "assessment_hash": current.assessment_hash,
                    "reason": payload.reason,
                    "created_at": now.isoformat(),
                }]
                workflow.UpdatedAt = now
            action = "book.children.approved"
            book.LifecycleStatus = "ACTIVE"
        elif payload.decision == "REJECT":
            action = "book.children.rejected"
            book.LifecycleStatus = "RETIRED"
        elif payload.decision == "REQUEST_RESCAN":
            action = "book.children.rescan_requested"
            for row in rows:
                page, revision, workflow = row[:3]
                if page.LifecycleStatus not in {"ACTIVE", "PROCESSING"} or workflow is None:
                    continue
                if workflow.Status == "FAILED":
                    AdminAiWorkflowService.prepare_retry(workflow, actor_id, now)
                elif (
                    workflow.CandidateText
                    and workflow.CandidateHash
                    and workflow.Status == "READY_FOR_ADMIN_REVIEW"
                ):
                    AdminAiWorkflowService.prepare_safety_rescan(
                        workflow, actor_id, now, payload.reason
                    )
        else:
            if not payload.category:
                raise HTTPException(status_code=422, detail="A category is required for a false-positive decision.")
            action = "book.children.false_positive_reviewed"

        # Compute the snapshot after bulk Safety confirmation (its stable fields
        # now record the confirmed state), and persist both the decision and the
        # page-level work in the same PostgreSQL transaction.
        decision_snapshot = self._page_snapshot(rows)
        decision_assessment = self._assessment(
            rows, decisions, book=book, rights_profiles=rights_profiles
        )
        await self.repository.add_book_decision(
            actor_id=actor_id,
            book_id=book_id,
            action=action,
            metadata={
                "decision": payload.decision,
                "decision_source": "ADMIN_APPROVAL" if payload.decision == "APPROVE" else "ADMIN_REVIEW",
                "reason": payload.reason,
                "category": payload.category,
                "rights_confirmed": decision_assessment.rights_profile_status == "REVIEWED",
                "rights_profile_version": decision_assessment.rights_profile_version,
                "rights_profile_hash": decision_assessment.rights_profile_hash,
                "assessment_hash": decision_assessment.assessment_hash,
                "page_snapshot": decision_snapshot,
                "page_count": decision_assessment.page_count,
                "policy": BOOK_APPROVAL_POLICY_VERSION,
                "actor_name": actor_name,
            },
            request_id=str(uuid4()),
        )
        await self.repository.commit()
        refreshed_rows = await self.repository.book_assessment_rows(book_id)
        refreshed_decisions = await self.repository.book_decisions(book_id)
        return BookQualityBookDecisionRead(
            book_id=book_id,
            assessment=self._assessment(
                refreshed_rows,
                refreshed_decisions,
                book=book,
                rights_profiles=rights_profiles,
            ),
            decision_history=[self._decision_read(row) for row in refreshed_decisions],
        )

    async def get_rights_profile(
        self, actor_id: UUID, book_id: UUID, *, page_id: UUID | None = None
    ) -> BookContentRightsProfileRead:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if page_id is not None:
            page = await self.repository.page(page_id)
            if page is None or page.BookId != book_id:
                raise HTTPException(status_code=404, detail="Resource not found")
            profile = await self.repository.effective_rights_profile(book_id, page_id)
            return self._rights_profile_read(profile, book_id)
        profile = await self.repository.rights_profile(book_id, page_id=None)
        return self._rights_profile_read(profile, book_id)

    async def upsert_rights_profile(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: BookContentRightsProfileUpsert,
        *,
        page_id: UUID | None = None,
    ) -> BookContentRightsProfileRead:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        scope = "PAGE_OVERRIDE" if page_id is not None else "BOOK"
        if page_id is not None:
            page = await self.repository.page(page_id, lock=True)
            if page is None or page.BookId != book_id:
                raise HTTPException(status_code=404, detail="Resource not found")

        existing = await self.repository.rights_profile(
            book_id, page_id=page_id, lock=True
        )
        if payload.status == "REVIEWED":
            has_evidence = bool(
                payload.evidence_url
                or payload.evidence_reference
                or (payload.usage_basis == "OWN_ORIGINAL" and payload.notes)
            )
            if (
                not payload.source_name
                or not payload.usage_basis
                or payload.usage_basis == "UNKNOWN"
                or not has_evidence
            ):
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "RIGHTS_EVIDENCE_REQUIRED",
                        "message": "Để đánh dấu Đã rà soát quyền sử dụng, cần ghi rõ nguồn nội dung, căn cứ sử dụng hợp lệ và liên kết hoặc tài liệu chứng minh.",
                    },
                )
            if (
                existing is not None
                and existing.ReferenceCheckStatus == "OVERLAP_CONCERN"
                and not payload.notes
            ):
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "RIGHTS_OVERLAP_EXPLANATION_REQUIRED",
                        "message": "Đang có nghi vấn trùng khớp trong dữ liệu đối chiếu; cần ghi rõ lý do và căn cứ xử lý trước khi chuyển sang Đã rà soát.",
                    },
                )

        now = datetime.now(timezone.utc)
        actor_name = (await self.repository.profile_name(actor_id) or "Admin")[:160]
        fingerprint = self._rights_profile_fingerprint(payload, scope)
        history_entry = {
            "status": payload.status,
            "source_name": payload.source_name,
            "rights_holder": payload.rights_holder,
            "usage_basis": payload.usage_basis,
            "source_fingerprint": fingerprint,
            "actor_id": str(actor_id),
            "actor_name": actor_name,
            "notes": payload.notes,
            "reviewed_at": now.isoformat(),
        }
        if existing is None:
            profile = BookContentRightsProfile(
                Id=uuid4(),
                BookId=book_id,
                PageId=page_id,
                Scope=scope,
                Status=payload.status,
                SourceName=payload.source_name,
                RightsHolder=payload.rights_holder,
                UsageBasis=payload.usage_basis,
                EvidenceUrl=payload.evidence_url,
                EvidenceReference=payload.evidence_reference,
                Notes=payload.notes,
                SourceFingerprint=fingerprint,
                ProfileVersion=1,
                ReferenceCheckStatus="NOT_RUN",
                ReferenceCheckEvidence=[],
                ReviewedBy=actor_id,
                ReviewedByNameSnapshot=actor_name,
                ReviewedAt=now,
                History=[history_entry],
                CreatedAt=now,
                UpdatedAt=now,
            )
            await self.repository.add_rights_profile(profile)
        else:
            profile = existing
            changed = (
                profile.SourceFingerprint != fingerprint
                or profile.Status != payload.status
            )
            if changed:
                profile.ProfileVersion = int(profile.ProfileVersion or 1) + 1
            profile.Status = payload.status
            profile.SourceName = payload.source_name
            profile.RightsHolder = payload.rights_holder
            profile.UsageBasis = payload.usage_basis
            profile.EvidenceUrl = payload.evidence_url
            profile.EvidenceReference = payload.evidence_reference
            profile.Notes = payload.notes
            profile.SourceFingerprint = fingerprint
            profile.ReviewedBy = actor_id
            profile.ReviewedByNameSnapshot = actor_name
            profile.ReviewedAt = now
            profile.History = list(profile.History or []) + [history_entry]
            profile.UpdatedAt = now
        await self.repository.commit()
        await self.repository.refresh(profile)
        return self._rights_profile_read(profile, book_id)

    async def run_rights_corpus_overlap_check(
        self, actor_id: UUID, book_id: UUID
    ) -> BookContentRightsProfileRead:
        """Compare active book text ONLY against allowed local catalog rows (no external search)."""
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        rows = await self.repository.book_assessment_rows(book_id)
        latest_revisions = await self.repository.latest_revisions_by_page_for_book(book_id)
        other_pages = await self.repository.other_books_verified_pages(book_id)

        def _shingles(text_value: str, size: int = 8) -> dict[str, str]:
            tokens = text_value.split()
            if len(tokens) < size:
                return {}
            out: dict[str, str] = {}
            for idx in range(0, len(tokens) - size + 1):
                raw_slice = " ".join(tokens[idx : idx + size])
                key = " ".join(raw_slice.casefold().split())
                out.setdefault(key, raw_slice)
            return out

        reference_index: dict[str, tuple[UUID, str, int]] = {}
        for other_book_id, other_title, other_page_no, other_text in other_pages:
            for key in _shingles(other_text):
                reference_index.setdefault(key, (other_book_id, other_title, other_page_no))

        matches: list[dict[str, object]] = []
        seen_pairs: set[tuple[str, int, int]] = set()
        for row in rows:
            page, revision = row[0], row[1]
            if page.LifecycleStatus != "ACTIVE":
                continue
            rev = revision or latest_revisions.get(page.Id)
            text_value = (
                (getattr(rev, "VerifiedText", None) if rev else None)
                or (getattr(rev, "DraftText", None) if rev else None)
                or ""
            )
            for key, raw_slice in _shingles(str(text_value)).items():
                hit = reference_index.get(key)
                if hit is None:
                    continue
                source_book_id, source_title, source_page_no = hit
                pair_key = (str(source_book_id), source_page_no, int(page.PageNumber))
                if pair_key in seen_pairs:
                    continue
                seen_pairs.add(pair_key)
                matches.append({
                    "source_book_id": str(source_book_id),
                    "source_book_title": source_title,
                    "source_page_number": source_page_no,
                    "target_page_number": int(page.PageNumber),
                    "matched_excerpt": raw_slice[:240],
                    "scan_scope": "INTERNAL_CATALOG_CORPUS",
                })
                if len(matches) >= 20:
                    break
            if len(matches) >= 20:
                break

        now = datetime.now(timezone.utc)
        actor_name = (await self.repository.profile_name(actor_id) or "Admin")[:160]
        profile = await self.repository.rights_profile(book_id, page_id=None, lock=True)
        if profile is None:
            profile = BookContentRightsProfile(
                Id=uuid4(),
                BookId=book_id,
                PageId=None,
                Scope="BOOK",
                Status="CONCERNS_FOUND" if matches else "NOT_ASSESSED",
                ProfileVersion=1,
                ReferenceCheckStatus=(
                    "OVERLAP_CONCERN" if matches else "NO_MATCH_IN_ALLOWED_CORPUS"
                ),
                ReferenceCheckEvidence=matches,
                ReviewedBy=actor_id,
                ReviewedByNameSnapshot=actor_name,
                ReviewedAt=now,
                History=[{
                    "event": "ALLOWED_CORPUS_OVERLAP_CHECK",
                    "scan_scope": "INTERNAL_CATALOG_CORPUS",
                    "match_count": len(matches),
                    "actor_id": str(actor_id),
                    "actor_name": actor_name,
                    "checked_at": now.isoformat(),
                }],
                CreatedAt=now,
                UpdatedAt=now,
            )
            await self.repository.add_rights_profile(profile)
        else:
            profile.ReferenceCheckStatus = (
                "OVERLAP_CONCERN" if matches else "NO_MATCH_IN_ALLOWED_CORPUS"
            )
            profile.ReferenceCheckEvidence = matches
            if matches:
                profile.Status = "CONCERNS_FOUND"
                profile.ProfileVersion = int(profile.ProfileVersion or 1) + 1
            profile.History = list(profile.History or []) + [{
                "event": "ALLOWED_CORPUS_OVERLAP_CHECK",
                "scan_scope": "INTERNAL_CATALOG_CORPUS",
                "match_count": len(matches),
                "actor_id": str(actor_id),
                "actor_name": actor_name,
                "checked_at": now.isoformat(),
            }]
            profile.UpdatedAt = now
        await self.repository.commit()
        await self.repository.refresh(profile)
        return self._rights_profile_read(profile, book_id)

    async def update_expected_page_count(
        self, actor_id: UUID, book_id: UUID, payload: BookExpectedPageCountUpdate
    ) -> dict[str, object]:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        book.ExpectedPageCount = payload.expected_page_count
        await self.repository.commit()
        return {"book_id": str(book.Id), "expected_page_count": book.ExpectedPageCount}

    async def update_finding(
        self, actor_id: UUID, finding_id: UUID, payload: BookQualityFindingUpdate
    ) -> BookQualityFindingRead:
        await self._require_role(actor_id, "admin")
        finding = await self.repository.finding(finding_id, lock=True)
        if finding is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if finding.Status == "STALE":
            raise HTTPException(status_code=409, detail="Stale findings cannot be changed.")

        transitions = {
            "NEEDS_REVIEW": {"CONFIRMED", "DISMISSED"},
            "CONFIRMED": {"DISMISSED"},
            "DISMISSED": {"NEEDS_REVIEW"},
            "RESOLVED": set(),
        }
        if payload.status not in transitions.get(finding.Status, set()) and payload.status != "RESOLVED":
            raise HTTPException(status_code=409, detail="Invalid finding status transition.")
        if payload.status == "DISMISSED" and not payload.review_note:
            raise HTTPException(
                status_code=422, detail="Cần ghi lý do khi bỏ qua cảnh báo."
            )
        page = (
            await self.repository.page(finding.PageId)
            if finding.PageId is not None
            else None
        )
        if payload.status == "CONFIRMED":
            if (
                page is None
                or page.CurrentVerifiedRevisionId != finding.PageRevisionId
            ):
                # Preserve the evidence, but do not let an old finding be confirmed
                # against content that has already been replaced.
                finding.Status = "STALE"
                finding.ReviewNote = "Current verified revision has changed."
                finding.ReviewedBy = actor_id
                finding.ReviewedAt = datetime.now(timezone.utc)
                await self.repository.db.commit()
                raise HTTPException(
                    status_code=409,
                    detail="Revision nguồn đã thay đổi; finding đã được chuyển sang STALE.",
                )
        if payload.status == "RESOLVED":
            if (
                page is None
                or page.CurrentVerifiedRevisionId is None
                or page.CurrentVerifiedRevisionId == finding.PageRevisionId
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Chỉ đánh dấu đã sửa sau khi một revision VERIFIED mới được xuất bản.",
                )
            current = await self.repository.revision(
                page.Id, page.CurrentVerifiedRevisionId
            )
            if current is None or current.VerificationStatus != "VERIFIED":
                raise HTTPException(
                    status_code=409, detail="Revision mới chưa VERIFIED."
                )
        finding.Status = payload.status
        finding.ReviewNote = payload.review_note
        finding.ReviewedBy = actor_id
        finding.ReviewedAt = datetime.now(timezone.utc)
        try:
            await self.repository.db.commit()
            await self.repository.db.refresh(finding)
        except Exception:
            await self.repository.db.rollback()
            raise
        page_scan = await self.repository.page_scan(finding.PageScanId)
        page_number = page_scan.PageNumberSnapshot if page_scan else 0
        return self._finding_read(finding, page_number)

    async def retry_scan_page(
        self, actor_id: UUID, scan_id: UUID, page_scan_id: UUID
    ) -> BookQualityScanRead:
        await self._require_role(actor_id, "admin")
        scan = await self.repository.scan_run(scan_id)
        page_scan = await self.repository.page_scan(page_scan_id)
        if (
            scan is None
            or page_scan is None
            or page_scan.ScanRunId != scan_id
            or scan.BookId is None
        ):
            raise HTTPException(status_code=404, detail="Resource not found")
        if (
            page_scan.Status not in ("FAILED", "NOT_SCANNABLE", "STALE")
            and page_scan.AIAnalysisStatus not in ("UNAVAILABLE", "FAILED")
        ):
            raise HTTPException(
                status_code=409,
                detail="Trang này không ở trạng thái có thể kiểm tra lại.",
            )
        if page_scan.PageId is None:
            raise HTTPException(status_code=409, detail="Trang nguồn không còn tồn tại.")
        # A retry snapshots only this page's current verified revision. Its
        # findings remain attached to the new page-scoped run.
        return await self.enqueue_scan(
            actor_id,
            scan.BookId,
            trigger_type="STALE_RESCAN",
            scope="PAGE",
            target_page_id=page_scan.PageId,
        )
