from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.database.integrity import is_book_report_idempotency_violation

from app.models.book_content_quality import (
    BookContentReport,
    BookContentReportHistory,
    BookQualityFinding,
    BookQualityScanRun,
)
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.schemas.book_content_quality import (
    BookContentReportCreate,
    BookContentReportDetail,
    BookContentReportHistoryRead,
    BookContentReportPage,
    BookContentReportRead,
    BookContentReportStatusUpdate,
    BookQualityBookDetail,
    BookQualityBookPage,
    BookQualityBookSummary,
    BookQualityFindingRead,
    BookQualityFindingUpdate,
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
    ) -> BookContentReportDetail:
        related_rows = await self.repository.findings_for_report(report.Id)
        return BookContentReportDetail(
            **self._report_read(report).model_dump(),
            reporter_id=report.ReporterId,
            reporter_name=reporter_name or report.ReporterNameSnapshot,
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
            return await self._report_detail_response(detail[0], detail[1], history)

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
                        detail[0], detail[1], history
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
        return await self._report_detail_response(row[0], row[1], history)

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
            return self._scan_read(existing)
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
        return self._scan_read(run)

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
        self, actor_id: UUID, *, search: str | None, limit: int, offset: int
    ) -> BookQualityBookPage:
        await self._require_role(actor_id, "admin")
        rows, total = await self.repository.books_with_quality(
            search=search, limit=limit, offset=offset
        )
        items = []
        for book, report_count, open_report_count, finding_count, review_count in rows:
            latest = await self.repository.latest_scan(book.Id)
            items.append(
                BookQualityBookSummary(
                    book_id=book.Id,
                    book_title=book.Title,
                    report_count=int(report_count or 0),
                    open_report_count=int(open_report_count or 0),
                    finding_count=int(finding_count or 0),
                    needs_review_finding_count=int(review_count or 0),
                    latest_scan=self._scan_read(latest) if latest else None,
                )
            )
        return BookQualityBookPage(
            items=items,
            total=total,
            limit=limit,
            offset=offset,
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
            await self.get_scan_detail(actor_id, scans[0].Id) if scans else None
        )
        return BookQualityBookDetail(
            book_id=book.Id,
            book_title=str(book.Title),
            reports=[self._report_read(report) for report in reports],
            scans=[self._scan_read(run) for run in scans],
            latest_scan_detail=latest_detail,
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
