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
    BookQualityFinding,
    BookQualityScanRun,
    BookRightsEvidence,
    BookRightsEvidenceHistory,
)
from app.models.admin_ai_workflow import AdminAiWorkflow
from app.policies.book_approval import (
    BOOK_APPROVAL_POLICY_VERSION,
    COPYRIGHT_BLOCKS_BOOK_APPROVAL,
    LEGACY_BOOK_APPROVAL_POLICY_VERSION,
)
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.repositories.admin_ai_workflow_repository import AdminAiWorkflowRepository
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.services.admin_ai_workflow_service import AdminAiWorkflowService
from app.schemas.admin_ai_workflow import AdminAiWorkflowCreate
from app.schemas.admin_ocr import AdminOcrWordInput
from app.schemas.book_content_quality import (
    BookContentReportCreate,
    BookContentReportDetail,
    BookContentReportHistoryRead,
    BookContentReportPage,
    BookContentReportRead,
    BookContentReportStatusUpdate,
    BookPageDiagnosticRead,
    BookQualityBookDetail,
    BookQualityBookPage,
    BookQualityBookSummary,
    BookApprovalAssessment,
    BookQualityBookDecisionRequest,
    BookQualityBookDecisionRead,
    BookQualityFindingRead,
    BookQualityFindingUpdate,
    BookQualityPageScanRead,
    BookQualityReportAdminPage,
    BookQualityScanDetail,
    BookQualityScanRead,
    BookRightsEvidenceHistoryRead,
    BookRightsEvidenceRead,
    BookRightsEvidenceUpsert,
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
    def _rights_content_fingerprint(book, rows: list[tuple]) -> str:
        pages_meta: list[dict[str, object]] = []
        for row in rows:
            if len(row) == 7:
                _, page, revision = row[:3]
            else:
                page, revision = row[:2]
            if page.LifecycleStatus not in {"ACTIVE", "PROCESSING"}:
                continue
            rev_meta = (
                revision.ProcessingMeta
                if revision is not None and isinstance(revision.ProcessingMeta, dict)
                else {}
            )
            pages_meta.append(
                {
                    "page_id": str(page.Id),
                    "page_number": int(page.PageNumber),
                    "image_path": getattr(page, "ImagePath", None),
                    "revision_id": str(revision.Id) if revision is not None else None,
                    "content_hash": getattr(revision, "ContentHash", None) if revision is not None else None,
                    "source_image_sha256": rev_meta.get("source_image_sha256"),
                }
            )
        payload = {
            "title": getattr(book, "Title", None),
            "author": getattr(book, "Author", None),
            "pages": pages_meta,
        }
        return hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _evaluate_rights_status(
        rights_evidence: BookRightsEvidence | None,
        current_fingerprint: str | None = None,
    ) -> tuple[str, bool, bool]:
        """Return (effective_status, is_stale, is_valid_reviewed)."""
        if rights_evidence is None:
            return "UNASSESSED", False, False
        raw_status = str(getattr(rights_evidence, "Status", "UNASSESSED") or "UNASSESSED")
        has_required_fields = bool(
            getattr(rights_evidence, "SourceDescription", None)
            and getattr(rights_evidence, "UsageBasis", None)
            and getattr(rights_evidence, "EvidenceUrlOrRef", None)
        )
        stored_fp = getattr(rights_evidence, "ContentFingerprint", None)
        is_stale = bool(
            raw_status == "RIGHTS_REVIEWED"
            and current_fingerprint
            and stored_fp
            and stored_fp != current_fingerprint
        )
        if raw_status == "RIGHTS_REVIEWED" and not has_required_fields:
            return "INSUFFICIENT_EVIDENCE", False, False
        if is_stale:
            return "STALE_RIGHTS_REVIEW", True, False
        return raw_status, False, (raw_status == "RIGHTS_REVIEWED" and has_required_fields)

    @classmethod
    def _rights_read(
        cls,
        book_id: UUID,
        row: BookRightsEvidence | None,
        history: list[BookRightsEvidenceHistory],
        *,
        page_id: UUID | None = None,
        current_fingerprint: str | None = None,
    ) -> BookRightsEvidenceRead:
        effective_status, is_stale, _ = cls._evaluate_rights_status(
            row, current_fingerprint
        )
        scope = "PAGE" if page_id is not None else "BOOK"
        if row is None:
            return BookRightsEvidenceRead(
                book_id=book_id,
                page_id=page_id,
                scope=scope,
                status="UNASSESSED",
                effective_status=effective_status,
                is_stale=False,
                version=0,
                current_content_fingerprint=current_fingerprint,
                history=[],
            )
        return BookRightsEvidenceRead(
            id=row.Id,
            book_id=row.BookId,
            page_id=row.PageId,
            scope=row.Scope,
            status=row.Status,
            effective_status=effective_status,
            is_stale=is_stale,
            source_description=row.SourceDescription,
            author_or_rights_holder=row.AuthorOrRightsHolder,
            usage_basis=row.UsageBasis,
            evidence_url_or_ref=row.EvidenceUrlOrRef,
            notes=row.Notes,
            version=int(row.Version or 1),
            content_fingerprint=row.ContentFingerprint,
            current_content_fingerprint=current_fingerprint,
            reviewed_by=row.ReviewedBy,
            reviewed_by_name=row.ReviewedByNameSnapshot,
            reviewed_at=row.ReviewedAt,
            updated_at=row.UpdatedAt,
            history=[
                BookRightsEvidenceHistoryRead(
                    id=item.Id,
                    version=int(item.Version or 1),
                    from_status=item.FromStatus,
                    to_status=item.ToStatus,
                    source_description=item.SourceDescription,
                    author_or_rights_holder=item.AuthorOrRightsHolder,
                    usage_basis=item.UsageBasis,
                    evidence_url_or_ref=item.EvidenceUrlOrRef,
                    notes=item.Notes,
                    content_fingerprint=item.ContentFingerprint,
                    actor_id=item.ActorId,
                    actor_name=item.ActorNameSnapshot,
                    created_at=item.CreatedAt,
                )
                for item in history
            ],
        )

    @staticmethod
    def _build_page_diagnostics(rows: list[tuple]) -> list[BookPageDiagnosticRead]:
        active_entries: list[tuple[object, object | None, object | None]] = []
        for row in rows:
            if len(row) == 7:
                _, page, revision, workflow = row[:4]
            else:
                page, revision, workflow = row[:3]
            if page.LifecycleStatus not in {"ACTIVE", "PROCESSING"}:
                continue
            active_entries.append((page, revision, workflow))

        page_number_counts: dict[int, int] = {}
        content_hash_counts: dict[str, int] = {}
        for page, revision, _ in active_entries:
            num = int(page.PageNumber)
            page_number_counts[num] = page_number_counts.get(num, 0) + 1
            text_val = (
                getattr(revision, "VerifiedText", None)
                or getattr(revision, "DraftText", None)
                or getattr(revision, "OriginalOcrText", None)
                or ""
            ).strip()
            if text_val and getattr(revision, "ContentHash", None):
                digest = str(revision.ContentHash)
                content_hash_counts[digest] = content_hash_counts.get(digest, 0) + 1

        diagnostics: list[BookPageDiagnosticRead] = []
        seen_numbers: set[int] = set()
        for page, revision, workflow in active_entries:
            page_num = int(page.PageNumber)
            seen_numbers.add(page_num)
            codes: list[str] = []
            image_path = getattr(page, "ImagePath", None)
            has_image = isinstance(image_path, str) and bool(image_path.strip())
            if not has_image:
                codes.append("MISSING_IMAGE")

            rev_meta = (
                revision.ProcessingMeta
                if revision is not None and isinstance(revision.ProcessingMeta, dict)
                else {}
            )
            ocr_text = (
                (
                    getattr(revision, "VerifiedText", None)
                    or getattr(revision, "DraftText", None)
                    or getattr(revision, "OriginalOcrText", None)
                    or ""
                ).strip()
                if revision is not None
                else ""
            )
            ocr_error = bool(
                rev_meta.get("ocr_error")
                or rev_meta.get("error_code")
                or (workflow is not None and workflow.Status == "FAILED" and workflow.Stage == "PROOFREADING")
            )
            if ocr_error:
                codes.append("OCR_ERROR")
            if revision is None or not ocr_text:
                if has_image and rev_meta.get("image_only") is True:
                    codes.append("IMAGE_ONLY_PAGE")
                else:
                    codes.append("EMPTY_OCR")
                    if has_image and revision is not None and not ocr_error:
                        codes.append("IMAGE_ONLY_PAGE")

            if page_number_counts.get(page_num, 0) > 1 or (
                revision is not None
                and getattr(revision, "ContentHash", None)
                and content_hash_counts.get(str(revision.ContentHash), 0) > 1
            ):
                codes.append("DUPLICATE_PAGE")

            if revision is None or revision.VerificationStatus != "VERIFIED":
                codes.append("UNVERIFIED_PAGE")

            if not codes:
                codes.append("OK")

            labels = {
                "OK": "Trang đã xác minh và có đầy đủ ảnh + OCR.",
                "MISSING_IMAGE": "Thiếu ảnh nguồn của trang.",
                "EMPTY_OCR": "Chưa có văn bản OCR.",
                "OCR_ERROR": "OCR hoặc Proofreading gặp lỗi.",
                "DUPLICATE_PAGE": "Nghi ngờ trùng số trang hoặc trùng nội dung trang.",
                "SUSPECTED_MISSING_PAGE": "Nghi ngờ thiếu số trang trong dãy đánh số.",
                "UNVERIFIED_PAGE": "Trang chưa được Admin xác minh.",
                "IMAGE_ONLY_PAGE": "Trang chỉ có ảnh (không có chữ hoặc OCR rỗng).",
            }
            diagnostics.append(
                BookPageDiagnosticRead(
                    page_id=page.Id,
                    page_number=page_num,
                    lifecycle_status=page.LifecycleStatus,
                    verification_status=revision.VerificationStatus if revision is not None else None,
                    codes=codes,
                    image_safety_status=(
                        getattr(workflow, "ImageSafetyStatus", "UNASSESSED_NO_VISION_MODEL")
                        if workflow is not None
                        else "UNASSESSED_NO_VISION_MODEL"
                    ),
                    text_safety_status=workflow.SafetyStatus if workflow is not None else "PENDING",
                    summary=" ".join(labels[code] for code in codes),
                )
            )

        if seen_numbers:
            max_num = max(seen_numbers)
            if max_num <= 2000:
                for missing_num in range(1, max_num + 1):
                    if missing_num not in seen_numbers:
                        diagnostics.append(
                            BookPageDiagnosticRead(
                                page_id=None,
                                page_number=missing_num,
                                lifecycle_status=None,
                                verification_status=None,
                                codes=["SUSPECTED_MISSING_PAGE"],
                                summary=(
                                    f"Nghi ngờ thiếu trang số {missing_num} trong dãy trang đã tải lên "
                                    "(không khẳng định tổng số trang bản in gốc)."
                                ),
                            )
                        )
        diagnostics.sort(key=lambda item: (item.page_number, str(item.page_id or "")))
        return diagnostics

    @classmethod
    def _assessment(
        cls,
        rows: list[tuple],
        decisions: list,
        *,
        rights_evidence: BookRightsEvidence | None = None,
        current_rights_fingerprint: str | None = None,
    ) -> BookApprovalAssessment:
        now = datetime.now(timezone.utc)
        active_rows = []
        for row in rows:
            page = row[1] if len(row) == 7 else row[0]
            if page.LifecycleStatus in {"ACTIVE", "PROCESSING"}:
                active_rows.append(row)
        snapshot = cls._page_snapshot(active_rows)
        legacy_snapshot_payload = {
            "policy": LEGACY_BOOK_APPROVAL_POLICY_VERSION,
            "copyright_scanner": "not-configured",
            "pages": snapshot,
        }
        legacy_assessment_hash = hashlib.sha256(
            json.dumps(
                legacy_snapshot_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()

        rights_effective_status, rights_is_stale, rights_valid = (
            cls._evaluate_rights_status(rights_evidence, current_rights_fingerprint)
        )
        rights_version = int(getattr(rights_evidence, "Version", 0) or 0) if rights_evidence else 0
        snapshot_payload = {
            "policy": BOOK_APPROVAL_POLICY_VERSION,
            "rights_status": rights_effective_status,
            "rights_version": rights_version,
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

        for row in active_rows:
            if len(row) == 7:
                _, page, revision, workflow, *_fingerprints = row
            else:
                page, revision, workflow, *_fingerprints = row
            if page.LifecycleStatus != "ACTIVE":
                page_blockers.append(
                    f"Trang {page.PageNumber}: trang chưa hoàn tất xử lý."
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
                        f"Trang {page.PageNumber}: chưa có Proofreading và Child Safety cho revision hiện tại."
                    )
                elif workflow.Status in {"QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                    active_workflows += 1
                    page_blockers.append(
                        f"Trang {page.PageNumber}: workflow đang xử lý revision khác."
                    )
                else:
                    stale_pages += 1
                    page_blockers.append(
                        f"Trang {page.PageNumber}: kết quả AI thuộc revision cũ."
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
                page_blockers.append(f"Trang {page.PageNumber}: Proofreading thất bại.")
            else:
                page_blockers.append(f"Trang {page.PageNumber}: Proofreading chưa hoàn tất.")
            suggestions += len(workflow.CorrectionSuggestions or [])
            if (
                workflow.SafetyStatus in {"PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED"}
                and workflow.CandidateHash
                and candidate_is_consistent
                and workflow.SafetyInputHash == workflow.CandidateHash
                and workflow.Status == "READY_FOR_ADMIN_REVIEW"
            ):
                safety_completed += 1
            elif workflow.SafetyStatus == "STALE" or (
                workflow.SafetyInputHash
                and workflow.CandidateHash
                and workflow.SafetyInputHash != workflow.CandidateHash
            ):
                stale_pages += 1
                page_blockers.append(f"Trang {page.PageNumber}: Child Safety đã stale.")
            elif workflow.Status not in {"FAILED", "QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                pending_pages += 1
                page_blockers.append(f"Trang {page.PageNumber}: Child Safety chưa hoàn tất.")
            elif workflow.SafetyStatus == "FAILED" or workflow.Status == "FAILED":
                page_blockers.append(f"Trang {page.PageNumber}: Child Safety thất bại.")
            elif workflow.Status in {"QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
                page_blockers.append(f"Trang {page.PageNumber}: Child Safety đang xử lý.")

            if revision.VerificationStatus != "VERIFIED":
                page_blockers.append(f"Trang {page.PageNumber}: OCR revision chưa VERIFIED.")
            elif not candidate_is_consistent:
                page_blockers.append(f"Trang {page.PageNumber}: Candidate text/hash không nhất quán.")
            elif AdminAiWorkflowService._hash(revision.VerifiedText or "") != workflow.CandidateHash:
                page_blockers.append(
                    f"Trang {page.PageNumber}: Candidate khác OCR VERIFIED; cần lưu revision Candidate trước khi duyệt."
                )

            if workflow.Suitability == "NOT_RECOMMENDED":
                unsuitable = True
            if workflow.Suitability == "REVIEW_REQUIRED":
                review_required = True
            image_safety_status = getattr(workflow, "ImageSafetyStatus", None)
            if image_safety_status == "ADMIN_FLAGGED_UNSAFE":
                unsuitable = True
                page_blockers.append(
                    f"Trang {page.PageNumber}: Ảnh trang đã bị đánh dấu không an toàn cho trẻ em."
                )
            elif (
                image_safety_status is not None
                and image_safety_status != "ADMIN_CONFIRMED_SAFE"
                and saved_workflow.get("image_safety_status") != "ADMIN_CONFIRMED_SAFE"
            ):
                page_blockers.append(
                    f"Trang {page.PageNumber}: Ảnh trang chưa được Admin xác nhận an toàn."
                )
            if not (
                workflow.SafetyStatus in {"PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED"}
                and workflow.SafetyInputHash == workflow.CandidateHash
                and workflow.Status == "READY_FOR_ADMIN_REVIEW"
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
                group["pages"].add(int(page.PageNumber))
                examples = group["examples"]
                if len(examples) < 3:
                    examples.append(
                        {
                            "page_number": int(page.PageNumber),
                            "evidence_text": str(finding.get("evidence_text") or ""),
                            "explanation": str(finding.get("explanation") or ""),
                            "recommendation": str(finding.get("recommendation") or ""),
                        }
                    )

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
        copyright_status = rights_effective_status
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
        blockers.extend(page_blockers)
        if COPYRIGHT_BLOCKS_BOOK_APPROVAL and not rights_valid:
            if copyright_status == "CONCERN_FLAGGED":
                blockers.append("RIGHTS_CONCERN_FLAGGED")
            elif copyright_status == "INSUFFICIENT_EVIDENCE":
                blockers.append("RIGHTS_INSUFFICIENT_EVIDENCE")
            elif copyright_status == "STALE_RIGHTS_REVIEW":
                blockers.append("RIGHTS_EVIDENCE_STALE")
            else:
                blockers.append("RIGHTS_UNASSESSED")

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
        decision_matches_hash = bool(
            latest_decision
            and (
                metadata.get("assessment_hash") == assessment_hash
                or (
                    metadata.get("policy") in {None, LEGACY_BOOK_APPROVAL_POLICY_VERSION}
                    and metadata.get("assessment_hash") == legacy_assessment_hash
                )
            )
        )
        current_decision = decision_matches_hash
        approved = bool(
            current_decision
            and latest_decision.Action == "book.children.approved"
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
            and row.Metadata.get("assessment_hash") not in {assessment_hash, legacy_assessment_hash}
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
            and (not COPYRIGHT_BLOCKS_BOOK_APPROVAL or rights_valid)
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
        metadata = metadata if current_decision else {}
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
            copyright_finding_count=1 if copyright_status == "CONCERN_FLAGGED" else 0,
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
            rights_confirmed=bool(rights_valid or (approved and metadata.get("rights_confirmed") is True)),
            blockers=blockers,
        )

    async def auto_publish_if_eligible(self, book_id: UUID) -> bool:
        """Disabled by policy: books require explicit Admin approval after rights & safety review.

        Historical AUTO_APPROVAL records remain readable without mass re-approval.
        """
        if callable(getattr(self.repository, "rollback", None)):
            await self.repository.rollback()
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
        include_internal_findings: bool = False,
    ) -> BookContentReportDetail:
        related_rows = (
            await self.repository.findings_for_report(report.Id)
            if include_internal_findings
            else []
        )
        report_data = self._report_read(report).model_dump()
        report_data["reporter_name"] = (
            reporter_name or report.ReporterNameSnapshot
        )
        return BookContentReportDetail(
            **report_data,
            reporter_id=report.ReporterId,
            verified_text_snapshot=report.VerifiedTextSnapshot,
            content_hash_snapshot=report.ContentHashSnapshot,
            admin_resolution_note=report.AdminResolutionNote,
            reviewed_by=report.ReviewedBy,
            reviewed_by_name=report.ReviewedByNameSnapshot,
            resolved_at=report.ResolvedAt,
            history=[
                BookContentReportHistoryRead(
                    actor_name=row.ActorNameSnapshot,
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
                detail[0], detail[1], history, include_internal_findings=False
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
        if getattr(book, "VisibilityScope", "CATALOG") == "PARENT_PRIVATE":
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
                include_internal_findings=False,
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
                        detail[0], detail[1], history, include_internal_findings=False
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
            row[0], row[1], history, include_internal_findings=False
        )

    async def list_admin_reports(
        self,
        actor_id: UUID,
        *,
        status: str | None,
        issue_type: str | None,
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
        return await self._report_detail_response(
            row[0], row[1], history, include_internal_findings=True
        )

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
            return await self._report_detail_response(
                row[0], row[1], history, include_internal_findings=True
            )
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
        return await self._report_detail_response(
            row[0], row[1], history, include_internal_findings=True
        )

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
            await self._cleanup_abandoned_and_retired_book_artifacts(book_id)
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

    async def _cleanup_abandoned_and_retired_book_artifacts(self, book_id: UUID) -> None:
        """Retire orphaned PROCESSING reservations (>15m, 0 revisions) and stale retired-page findings."""
        db = getattr(self.repository, "db", None)
        if db is None or not hasattr(db, "execute"):
            return
        from sqlalchemy import text as sa_text

        for cleanup_sql in (
            """
            UPDATE public.bookqualityfindings AS f
            SET status = 'STALE'
            FROM public.bookpages AS p
            WHERE f.pageid = p.id
              AND f.bookid = :book_id
              AND p.lifecyclestatus = 'RETIRED'
              AND f.status != 'STALE'
            """,
            """
            UPDATE public.bookpages AS p
            SET lifecyclestatus = 'RETIRED'
            WHERE p.bookid = :book_id
              AND p.lifecyclestatus = 'PROCESSING'
              AND p.createdat < now() - interval '15 minutes'
              AND NOT EXISTS (
                  SELECT 1 FROM public.pagerevisions AS r WHERE r.pageid = p.id
              )
            """,
        ):
            try:
                if hasattr(db, "begin_nested"):
                    async with db.begin_nested():
                        await db.execute(sa_text(cleanup_sql), {"book_id": book_id})
                else:
                    await db.execute(sa_text(cleanup_sql), {"book_id": book_id})
            except Exception:
                # Best-effort hygiene; never break scan enqueue on mock/minimal DB fixtures.
                pass

    async def _ensure_page_ai_workflows(self, actor_id: UUID, book_id: UUID) -> None:
        """Queue missing/stale page Proofreading and Safety on the existing durable worker."""
        rows = await self.repository.book_assessment_rows(book_id, lock=True)
        ocr_repository = AdminOcrRepository(self.repository.db)
        workflow_repository = AdminAiWorkflowRepository(self.repository.db)
        workflow_service = AdminAiWorkflowService(self.repository.db)
        now = datetime.now(timezone.utc)
        pending_starts: list[tuple[UUID, AdminAiWorkflowCreate]] = []
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
                continue
            pending_starts.append((page.Id, payload))

        if callable(getattr(self.repository.db, "commit", None)) and callable(
            getattr(self.repository, "book", None)
        ):
            await self.repository.db.commit()

        for target_page_id, start_payload in pending_starts:
            await workflow_service.start(actor_id, target_page_id, start_payload)

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

    async def _build_scan_detail(self, run: BookQualityScanRun) -> BookQualityScanDetail:
        page_scans = await self.repository.page_scans(run.Id)
        findings_by_page_scan: dict[UUID, list[BookQualityFinding]] = {}
        if page_scans and callable(getattr(self.repository, "findings_for_scan", None)):
            findings_by_page_scan = await self.repository.findings_for_scan(run.Id)
        else:
            for page_scan in page_scans:
                findings_by_page_scan[page_scan.Id] = (
                    await self.repository.findings_for_page_scan(page_scan.Id)
                )

        pages = [
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
                    for finding in findings_by_page_scan.get(page_scan.Id, [])
                ],
            )
            for page_scan in page_scans
        ]
        return BookQualityScanDetail(
            **self._scan_read(run).model_dump(),
            pages=pages,
        )

    async def get_scan_detail(
        self, actor_id: UUID, scan_id: UUID
    ) -> BookQualityScanDetail:
        await self._require_role(actor_id, "admin")
        run = await self.repository.scan_run(scan_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        return await self._build_scan_detail(run)

    async def list_books(
        self,
        actor_id: UUID,
        *,
        search: str | None,
        limit: int,
        offset: int,
        status_filter: str | None = None,
        alert_filter: str | None = None,
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
        rights_by_book: dict[UUID, BookRightsEvidence] = {}
        if callable(getattr(self.repository, "list_rights_evidences_for_books", None)):
            for rights in await self.repository.list_rights_evidences_for_books(book_ids):
                rights_by_book[rights.BookId] = rights
        assessed_rows = []
        status_counts: dict[str, int] = {}
        alert_counts = {"CHILD_SAFETY": 0, "COPYRIGHT": 0, "BOTH": 0}
        for row in rows:
            book = row[0]
            book_rows = page_rows_by_book.get(book.Id, [])
            rights_fp = self._rights_content_fingerprint(book, book_rows)
            assessment = self._assessment(
                book_rows,
                decisions_by_book.get(book.Id, []),
                rights_evidence=rights_by_book.get(book.Id),
                current_rights_fingerprint=rights_fp,
            )
            status_counts[assessment.status] = status_counts.get(assessment.status, 0) + 1
            has_safety = assessment.finding_count > 0
            has_copyright = bool(
                assessment.copyright_finding_count is not None
                and assessment.copyright_finding_count > 0
            )
            if has_safety:
                alert_counts["CHILD_SAFETY"] += 1
            if has_copyright:
                alert_counts["COPYRIGHT"] += 1
            if has_safety and has_copyright:
                alert_counts["BOTH"] += 1
            assessed_rows.append((row, assessment))
        if status_filter:
            assessed_rows = [
                item for item in assessed_rows if item[1].status == status_filter
            ]
        if alert_filter == "CHILD_SAFETY":
            assessed_rows = [item for item in assessed_rows if item[1].finding_count > 0]
        elif alert_filter == "COPYRIGHT":
            assessed_rows = [
                item
                for item in assessed_rows
                if item[1].copyright_finding_count is not None
                and item[1].copyright_finding_count > 0
            ]
        elif alert_filter == "BOTH":
            assessed_rows = [
                item
                for item in assessed_rows
                if item[1].finding_count > 0
                and item[1].copyright_finding_count is not None
                and item[1].copyright_finding_count > 0
            ]
        total = len(assessed_rows)
        page = assessed_rows[offset : offset + limit]
        page_book_ids = [row[0].Id for row, _ in page]
        latest_scans_by_book: dict[UUID, BookQualityScanRun | None] = {}
        if page_book_ids:
            if callable(getattr(self.repository, "latest_scans_for_books", None)):
                batched_scans = await self.repository.latest_scans_for_books(page_book_ids)
                if isinstance(batched_scans, dict):
                    latest_scans_by_book = batched_scans
                else:
                    for scan in batched_scans:
                        if scan.BookId is not None and scan.BookId not in latest_scans_by_book:
                            latest_scans_by_book[scan.BookId] = scan
            else:
                for page_book_id in page_book_ids:
                    latest_scans_by_book[page_book_id] = await self.repository.latest_scan(
                        page_book_id
                    )

        items = []
        for (book, report_count, open_report_count, finding_count, review_count), assessment in page:
            latest = latest_scans_by_book.get(book.Id)
            items.append(
                BookQualityBookSummary(
                    book_id=book.Id,
                    book_title=book.Title,
                    report_count=int(report_count or 0),
                    open_report_count=int(open_report_count or 0),
                    finding_count=int(finding_count or 0),
                    needs_review_finding_count=int(review_count or 0),
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
        )

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
            await self._build_scan_detail(scans[0]) if scans else None
        )
        workflows = await self.repository.ai_workflows_for_book(book_id)
        workflow_summary = await self.repository.ai_workflow_summary_for_book(book_id)
        assessment_rows = await self.repository.book_assessment_rows(book_id)
        decisions = await self.repository.book_decisions(book_id)
        rights_row = (
            await self.repository.get_rights_evidence(book_id)
            if callable(getattr(self.repository, "get_rights_evidence", None))
            else None
        )
        rights_history = (
            await self.repository.list_rights_history(book_id)
            if callable(getattr(self.repository, "list_rights_history", None))
            else []
        )
        current_rights_fp = self._rights_content_fingerprint(book, assessment_rows)
        return BookQualityBookDetail(
            book_id=book.Id,
            book_title=str(book.Title),
            reports=[self._report_read(report) for report in reports],
            scans=[self._scan_read(run) for run in scans],
            latest_scan_detail=latest_detail,
            ai_workflows=[AdminAiWorkflowService._read(row) for row in workflows],
            ai_workflow_summary=workflow_summary,
            assessment=self._assessment(
                assessment_rows,
                decisions,
                rights_evidence=rights_row,
                current_rights_fingerprint=current_rights_fp,
            ),
            rights_evidence=self._rights_read(
                book_id,
                rights_row,
                rights_history,
                current_fingerprint=current_rights_fp,
            ),
            page_diagnostics=self._build_page_diagnostics(assessment_rows),
            decision_history=[self._decision_read(row) for row in decisions],
        )

    async def get_book_rights(
        self,
        actor_id: UUID,
        book_id: UUID,
        *,
        page_id: UUID | None = None,
    ) -> BookRightsEvidenceRead:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if page_id is not None:
            page = await self.repository.page(page_id)
            if page is None or page.BookId != book_id:
                raise HTTPException(status_code=404, detail="Resource not found")
        rows = await self.repository.book_assessment_rows(book_id)
        current_fp = self._rights_content_fingerprint(book, rows)
        row = await self.repository.get_rights_evidence(book_id, page_id=page_id)
        history = await self.repository.list_rights_history(book_id, page_id=page_id)
        return self._rights_read(
            book_id,
            row,
            history,
            page_id=page_id,
            current_fingerprint=current_fp,
        )

    async def upsert_book_rights(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: BookRightsEvidenceUpsert,
    ) -> BookRightsEvidenceRead:
        await self._require_role(actor_id, "admin")
        book = await self.repository.book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if payload.scope == "PAGE":
            if payload.page_id is None:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "RIGHTS_PAGE_ID_REQUIRED",
                        "message": "Cần chỉ định trang khi lưu bằng chứng quyền ở phạm vi trang.",
                    },
                )
            page = await self.repository.page(payload.page_id)
            if page is None or page.BookId != book_id:
                raise HTTPException(status_code=404, detail="Resource not found")
        elif payload.page_id is not None:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "RIGHTS_BOOK_SCOPE_PAGE_FORBIDDEN",
                    "message": "Hồ sơ quyền phạm vi sách không được gắn page_id.",
                },
            )

        if payload.status == "RIGHTS_REVIEWED":
            if not (
                payload.source_description
                and payload.usage_basis
                and payload.evidence_url_or_ref
            ):
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "RIGHTS_EVIDENCE_INCOMPLETE",
                        "message": "Cần nhập đầy đủ nguồn tài liệu, cơ sở sử dụng và đường dẫn/mã bằng chứng trước khi đánh dấu Đã rà soát quyền sử dụng.",
                    },
                )
        if payload.status == "CONCERN_FLAGGED" and not payload.notes:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "RIGHTS_CONCERN_NOTE_REQUIRED",
                    "message": "Cần ghi rõ lý do/mô tả nghi ngại bản quyền khi gắn cờ CONCERN_FLAGGED.",
                },
            )

        rows = await self.repository.book_assessment_rows(book_id)
        current_fp = self._rights_content_fingerprint(book, rows)
        actor_name = (await self.repository.profile_name(actor_id) or "Admin")[:160]
        now = datetime.now(timezone.utc)
        existing = await self.repository.get_rights_evidence(
            book_id, page_id=payload.page_id, lock=True
        )
        from_status = existing.Status if existing is not None else None
        if existing is None:
            row = BookRightsEvidence(
                Id=uuid4(),
                BookId=book_id,
                PageId=payload.page_id,
                Scope=payload.scope,
                Status=payload.status,
                SourceDescription=payload.source_description,
                AuthorOrRightsHolder=payload.author_or_rights_holder,
                UsageBasis=payload.usage_basis,
                EvidenceUrlOrRef=payload.evidence_url_or_ref,
                Notes=payload.notes,
                Version=1,
                ContentFingerprint=current_fp,
                ReviewedBy=actor_id,
                ReviewedByNameSnapshot=actor_name,
                ReviewedAt=now,
                CreatedAt=now,
                UpdatedAt=now,
            )
            await self.repository.add_rights_evidence(row)
        else:
            row = existing
            row.Status = payload.status
            row.SourceDescription = payload.source_description
            row.AuthorOrRightsHolder = payload.author_or_rights_holder
            row.UsageBasis = payload.usage_basis
            row.EvidenceUrlOrRef = payload.evidence_url_or_ref
            row.Notes = payload.notes
            row.Version = int(row.Version or 0) + 1
            row.ContentFingerprint = current_fp
            row.ReviewedBy = actor_id
            row.ReviewedByNameSnapshot = actor_name
            row.ReviewedAt = now
            row.UpdatedAt = now

        history_row = BookRightsEvidenceHistory(
            Id=uuid4(),
            EvidenceId=row.Id,
            BookId=book_id,
            PageId=payload.page_id,
            Scope=payload.scope,
            Version=int(row.Version),
            FromStatus=from_status,
            ToStatus=payload.status,
            SourceDescription=payload.source_description,
            AuthorOrRightsHolder=payload.author_or_rights_holder,
            UsageBasis=payload.usage_basis,
            EvidenceUrlOrRef=payload.evidence_url_or_ref,
            Notes=payload.notes,
            ContentFingerprint=current_fp,
            ActorId=actor_id,
            ActorNameSnapshot=actor_name,
            CreatedAt=now,
        )
        await self.repository.add_rights_history(history_row)
        try:
            await self.repository.commit()
            await self.repository.refresh(row)
        except Exception:
            await self.repository.rollback()
            raise
        history = await self.repository.list_rights_history(
            book_id, page_id=payload.page_id
        )
        return self._rights_read(
            book_id,
            row,
            history,
            page_id=payload.page_id,
            current_fingerprint=current_fp,
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
        rights_row = (
            await self.repository.get_rights_evidence(book_id, lock=True)
            if callable(getattr(self.repository, "get_rights_evidence", None))
            else None
        )
        current_rights_fp = self._rights_content_fingerprint(book, rows)
        current = self._assessment(
            rows,
            decisions,
            rights_evidence=rights_row,
            current_rights_fingerprint=current_rights_fp,
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
        effective_rights_confirmed = bool(
            payload.rights_confirmed
            or (rights_row is not None and rights_row.Status == "RIGHTS_REVIEWED")
        )
        if (
            latest_decision is not None
            and latest_decision.Action == action_by_decision[payload.decision]
            and latest_metadata.get("assessment_hash") == current.assessment_hash
            and latest_metadata.get("reason") == payload.reason
            and latest_metadata.get("category") == payload.category
            and latest_metadata.get("rights_confirmed", False) == effective_rights_confirmed
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
                image_safety_status = getattr(workflow, "ImageSafetyStatus", None)
                saved_rev_meta = revision.ProcessingMeta if isinstance(revision.ProcessingMeta, dict) else {}
                saved_wf_meta = saved_rev_meta.get("admin_ai_workflow")
                saved_image_safety = (
                    saved_wf_meta.get("image_safety_status")
                    if isinstance(saved_wf_meta, dict)
                    else None
                )
                if image_safety_status == "ADMIN_FLAGGED_UNSAFE":
                    page_blockers.append(
                        f"{page_label}: Ảnh trang đã bị đánh dấu không an toàn cho trẻ em"
                    )
                elif (
                    image_safety_status is not None
                    and image_safety_status != "ADMIN_CONFIRMED_SAFE"
                    and saved_image_safety != "ADMIN_CONFIRMED_SAFE"
                ):
                    page_blockers.append(
                        f"{page_label}: Ảnh trang chưa được Admin xác nhận an toàn"
                    )
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
            rights_status, rights_stale, rights_valid = self._evaluate_rights_status(
                rights_row, current_rights_fp
            )
            if COPYRIGHT_BLOCKS_BOOK_APPROVAL and not rights_valid:
                code = (
                    "RIGHTS_CONCERN_BLOCKED"
                    if rights_status == "CONCERN_FLAGGED"
                    else "RIGHTS_EVIDENCE_STALE"
                    if rights_stale
                    else "RIGHTS_EVIDENCE_REQUIRED"
                )
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": code,
                        "message": (
                            "Sách đang có cờ nghi ngại quyền sử dụng; không thể phê duyệt."
                            if code == "RIGHTS_CONCERN_BLOCKED"
                            else "Nội dung sách đã thay đổi sau lần rà soát quyền sử dụng trước đó; cần cập nhật hồ sơ quyền."
                            if code == "RIGHTS_EVIDENCE_STALE"
                            else "Cần hoàn tất hồ sơ bằng chứng quyền sử dụng (RIGHTS_REVIEWED) trước khi phê duyệt sách."
                        ),
                    },
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
                existing_wf_meta = revision_meta.get("admin_ai_workflow")
                merged_wf_meta = (
                    dict(existing_wf_meta) if isinstance(existing_wf_meta, dict) else {}
                )
                merged_wf_meta.update(
                    {
                        "workflow_id": str(workflow.Id),
                        "candidate_hash": workflow.CandidateHash,
                        "safety_status": "CONFIRMED",
                        "safety_input_hash": workflow.SafetyInputHash,
                        "approval_scope": "BOOK_LEVEL_EXISTING_VERIFIED_REVISION",
                        "assessment_policy": BOOK_APPROVAL_POLICY_VERSION,
                    }
                )
                wf_image_safety = getattr(workflow, "ImageSafetyStatus", None)
                if wf_image_safety is not None and "image_safety_status" not in merged_wf_meta:
                    merged_wf_meta["image_safety_status"] = wf_image_safety
                wf_image_sha = getattr(workflow, "SourceImageSha256", None)
                if wf_image_sha and "source_image_sha256" not in merged_wf_meta:
                    merged_wf_meta["source_image_sha256"] = wf_image_sha
                revision_meta["admin_ai_workflow"] = merged_wf_meta
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
            rows,
            decisions,
            rights_evidence=rights_row,
            current_rights_fingerprint=current_rights_fp,
        )
        await self.repository.add_book_decision(
            actor_id=actor_id,
            book_id=book_id,
            action=action,
            metadata={
                "decision": payload.decision,
                "reason": payload.reason,
                "category": payload.category,
                "rights_confirmed": bool(
                    payload.rights_confirmed or (rights_row is not None and rights_row.Status == "RIGHTS_REVIEWED")
                ),
                "rights_evidence_id": str(rights_row.Id) if rights_row is not None else None,
                "rights_evidence_version": int(rights_row.Version) if rights_row is not None else None,
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
        refreshed_rights = (
            await self.repository.get_rights_evidence(book_id)
            if callable(getattr(self.repository, "get_rights_evidence", None))
            else rights_row
        )
        refreshed_fp = self._rights_content_fingerprint(book, refreshed_rows)
        return BookQualityBookDecisionRead(
            book_id=book_id,
            assessment=self._assessment(
                refreshed_rows,
                refreshed_decisions,
                rights_evidence=refreshed_rights,
                current_rights_fingerprint=refreshed_fp,
            ),
            decision_history=[self._decision_read(row) for row in refreshed_decisions],
        )

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
