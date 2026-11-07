from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, PageRevision, Profile
from app.models.book_content_quality import (
    BookContentReport,
    BookContentReportHistory,
    BookQualityFinding,
    BookQualityPageScan,
    BookQualityReportFinding,
    BookQualityScanRun,
)


class BookContentQualityRepository:
    """Persistence-only queries and writes for book content quality management."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))

    async def profile_for_update(self, actor_id: UUID) -> Profile | None:
        return await self.db.scalar(
            select(Profile).where(Profile.Id == actor_id).with_for_update()
        )

    async def profile_name(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.DisplayName).where(Profile.Id == actor_id))

    async def book(self, book_id: UUID, *, lock: bool = False) -> Book | None:
        query = select(Book).where(Book.Id == book_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def page(self, page_id: UUID, *, lock: bool = False) -> BookPage | None:
        query = select(BookPage).where(BookPage.Id == page_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def revision(self, page_id: UUID, revision_id: UUID) -> PageRevision | None:
        return await self.db.scalar(
            select(PageRevision).where(
                PageRevision.Id == revision_id,
                PageRevision.PageId == page_id,
            )
        )

    async def report(self, report_id: UUID, *, lock: bool = False) -> BookContentReport | None:
        query = select(BookContentReport).where(BookContentReport.Id == report_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def report_by_idempotency_key(
        self, reporter_id: UUID, idempotency_key: UUID
    ) -> BookContentReport | None:
        return await self.db.scalar(
            select(BookContentReport).where(
                BookContentReport.ReporterId == reporter_id,
                BookContentReport.IdempotencyKey == idempotency_key,
            )
        )

    async def count_recent_reports(self, reporter_id: UUID, since: datetime) -> int:
        value = await self.db.scalar(
            select(func.count(BookContentReport.Id)).where(
                BookContentReport.ReporterId == reporter_id,
                BookContentReport.CreatedAt >= since,
            )
        )
        return int(value or 0)

    async def active_scan_for_book(
        self,
        book_id: UUID,
        *,
        scope: str = "BOOK",
        target_page_id: UUID | None = None,
    ) -> BookQualityScanRun | None:
        filters = [
            BookQualityScanRun.BookId == book_id,
            BookQualityScanRun.Status.in_(("QUEUED", "RUNNING")),
            BookQualityScanRun.Scope == scope,
        ]
        if scope == "PAGE":
            filters.append(BookQualityScanRun.TargetPageId == target_page_id)
        return await self.db.scalar(
            select(BookQualityScanRun)
            .where(*filters)
            .order_by(BookQualityScanRun.CreatedAt.desc(), BookQualityScanRun.Id)
            .with_for_update()
            .limit(1)
        )

    async def reports_for_parent(
        self, reporter_id: UUID, *, limit: int, offset: int
    ) -> tuple[list[BookContentReport], int]:
        items = list(
            (
                await self.db.scalars(
                    select(BookContentReport)
                    .where(BookContentReport.ReporterId == reporter_id)
                    .order_by(BookContentReport.CreatedAt.desc(), BookContentReport.Id.desc())
                    .offset(offset)
                    .limit(limit)
                )
            ).all()
        )
        total = await self.db.scalar(
            select(func.count(BookContentReport.Id)).where(
                BookContentReport.ReporterId == reporter_id
            )
        )
        return items, int(total or 0)

    async def reports_for_book(
        self, book_id: UUID, *, limit: int = 50
    ) -> tuple[list[BookContentReport], int]:
        items = list(
            (
                await self.db.scalars(
                    select(BookContentReport)
                    .where(BookContentReport.BookId == book_id)
                    .order_by(BookContentReport.CreatedAt.desc(), BookContentReport.Id.desc())
                    .limit(limit)
                )
            ).all()
        )
        total = await self.db.scalar(
            select(func.count(BookContentReport.Id)).where(
                BookContentReport.BookId == book_id
            )
        )
        return items, int(total or 0)

    async def link_existing_findings_to_report(
        self, *, report_id: UUID, scan_id: UUID
    ) -> None:
        report = await self.report(report_id)
        if report is None:
            return
        statement = (
            select(BookQualityFinding.Id)
            .join(
                BookQualityPageScan,
                BookQualityPageScan.Id == BookQualityFinding.PageScanId,
            )
            .where(BookQualityPageScan.ScanRunId == scan_id)
        )
        if report.PageId is not None:
            statement = statement.where(
                BookQualityFinding.PageId == report.PageId,
                BookQualityFinding.PageRevisionId == report.PageRevisionId,
            )
        finding_ids = list((await self.db.scalars(statement)).all())
        if not finding_ids:
            return
        values = [
            {"ReportId": report_id, "FindingId": finding_id}
            for finding_id in finding_ids
        ]
        await self.db.execute(
            pg_insert(BookQualityReportFinding)
            .values(values)
            .on_conflict_do_nothing(
                index_elements=[
                    BookQualityReportFinding.ReportId,
                    BookQualityReportFinding.FindingId,
                ]
            )
        )

    async def findings_for_report(
        self, report_id: UUID
    ) -> list[tuple[BookQualityFinding, int]]:
        result = await self.db.execute(
            select(BookQualityFinding, BookQualityPageScan.PageNumberSnapshot)
            .join(
                BookQualityReportFinding,
                BookQualityReportFinding.FindingId == BookQualityFinding.Id,
            )
            .join(
                BookQualityPageScan,
                BookQualityPageScan.Id == BookQualityFinding.PageScanId,
            )
            .where(BookQualityReportFinding.ReportId == report_id)
            .order_by(
                BookQualityPageScan.PageNumberSnapshot,
                BookQualityFinding.ExcerptStart,
                BookQualityFinding.CreatedAt,
            )
        )
        return [(row[0], row[1]) for row in result.all()]

    async def admin_reports(
        self,
        *,
        status: str | None,
        issue_type: str | None,
        book_id: UUID | None,
        search: str | None,
        created_after: datetime | None,
        created_before: datetime | None,
        limit: int,
        offset: int,
    ) -> tuple[list[tuple[BookContentReport, str | None]], int, dict[str, int]]:
        filters = []
        if status:
            filters.append(BookContentReport.Status == status)
        if issue_type:
            filters.append(BookContentReport.IssueType == issue_type)
        if book_id:
            filters.append(BookContentReport.BookId == book_id)
        if created_after is not None:
            filters.append(BookContentReport.CreatedAt >= created_after)
        if created_before is not None:
            filters.append(BookContentReport.CreatedAt <= created_before)
        if search and search.strip():
            pattern = "%" + search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            filters.append(
                or_(
                    BookContentReport.BookTitleSnapshot.ilike(pattern, escape="\\"),
                    BookContentReport.Description.ilike(pattern, escape="\\"),
                    BookContentReport.ReportedText.ilike(pattern, escape="\\"),
                    BookContentReport.ReporterNameSnapshot.ilike(pattern, escape="\\"),
                )
            )
        rows = (
            await self.db.execute(
                select(BookContentReport, Profile.DisplayName)
                .outerjoin(Profile, Profile.Id == BookContentReport.ReporterId)
                .where(*filters)
                .order_by(BookContentReport.CreatedAt.desc(), BookContentReport.Id.desc())
                .offset(offset)
                .limit(limit)
            )
        ).all()
        total = await self.db.scalar(
            select(func.count(BookContentReport.Id)).where(*filters)
        )
        summary_rows = await self.db.execute(
            select(BookContentReport.Status, func.count(BookContentReport.Id))
            .group_by(BookContentReport.Status)
        )
        summary = {
            key: 0 for key in (
                "OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED",
                "REPORTED_BOOKS", "REPORTED_PAGES",
            )
        }
        for key, count in summary_rows.all():
            summary[str(key)] = int(count or 0)
        reported_books = await self.db.scalar(
            select(func.count(func.distinct(BookContentReport.BookId))).where(
                BookContentReport.BookId.is_not(None)
            )
        )
        reported_pages = await self.db.scalar(
            select(func.count(func.distinct(BookContentReport.PageId))).where(
                BookContentReport.PageId.is_not(None)
            )
        )
        summary["REPORTED_BOOKS"] = int(reported_books or 0)
        summary["REPORTED_PAGES"] = int(reported_pages or 0)
        return [(row[0], row[1]) for row in rows], int(total or 0), summary

    async def report_detail(
        self, report_id: UUID
    ) -> tuple[BookContentReport, str | None] | None:
        result = (
            await self.db.execute(
                select(BookContentReport, Profile.DisplayName)
                .outerjoin(Profile, Profile.Id == BookContentReport.ReporterId)
                .where(BookContentReport.Id == report_id)
            )
        ).first()
        return (result[0], result[1]) if result else None

    async def report_history(self, report_id: UUID) -> list[BookContentReportHistory]:
        result = await self.db.execute(
            select(BookContentReportHistory)
            .where(BookContentReportHistory.ReportId == report_id)
            .order_by(BookContentReportHistory.CreatedAt, BookContentReportHistory.Id)
        )
        return list(result.scalars().all())

    async def scan_runs_for_book(
        self, book_id: UUID, *, limit: int = 20
    ) -> list[BookQualityScanRun]:
        result = await self.db.execute(
            select(BookQualityScanRun)
            .where(BookQualityScanRun.BookId == book_id)
            .order_by(BookQualityScanRun.CreatedAt.desc(), BookQualityScanRun.Id.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def latest_scan(self, book_id: UUID) -> BookQualityScanRun | None:
        return await self.db.scalar(
            select(BookQualityScanRun)
            .where(BookQualityScanRun.BookId == book_id)
            .order_by(BookQualityScanRun.CreatedAt.desc(), BookQualityScanRun.Id.desc())
            .limit(1)
        )

    async def scan_run(
        self, scan_id: UUID, *, lock: bool = False
    ) -> BookQualityScanRun | None:
        query = select(BookQualityScanRun).where(BookQualityScanRun.Id == scan_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def page_scans(self, scan_id: UUID) -> list[BookQualityPageScan]:
        result = await self.db.execute(
            select(BookQualityPageScan)
            .where(BookQualityPageScan.ScanRunId == scan_id)
            .order_by(BookQualityPageScan.PageNumberSnapshot, BookQualityPageScan.Id)
        )
        return list(result.scalars().all())

    async def page_scan(self, page_scan_id: UUID) -> BookQualityPageScan | None:
        return await self.db.scalar(
            select(BookQualityPageScan).where(BookQualityPageScan.Id == page_scan_id)
        )

    async def findings_for_page_scan(
        self, page_scan_id: UUID
    ) -> list[BookQualityFinding]:
        result = await self.db.execute(
            select(BookQualityFinding)
            .where(BookQualityFinding.PageScanId == page_scan_id)
            .order_by(BookQualityFinding.ExcerptStart, BookQualityFinding.CreatedAt, BookQualityFinding.Id)
        )
        return list(result.scalars().all())

    async def finding(
        self, finding_id: UUID, *, lock: bool = False
    ) -> BookQualityFinding | None:
        query = select(BookQualityFinding).where(BookQualityFinding.Id == finding_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def finding_reports(self, finding_id: UUID) -> list[BookContentReport]:
        result = await self.db.execute(
            select(BookContentReport)
            .join(
                BookQualityReportFinding,
                BookQualityReportFinding.ReportId == BookContentReport.Id,
            )
            .where(BookQualityReportFinding.FindingId == finding_id)
        )
        return list(result.scalars().all())

    async def create_book_page_snapshots(
        self, run: BookQualityScanRun
    ) -> list[BookQualityPageScan]:
        page_query = select(BookPage).where(BookPage.BookId == run.BookId)
        if run.Scope == "PAGE":
            if run.TargetPageId is None:
                # The target was deleted after the retry was queued. Never
                # reinterpret a page-scoped run as a full-book scan.
                page_rows = []
            else:
                page_query = page_query.where(BookPage.Id == run.TargetPageId)
                page_rows = list(
                    (
                        await self.db.scalars(
                            page_query.order_by(BookPage.PageNumber, BookPage.Id)
                            .with_for_update()
                        )
                    ).all()
                )
        else:
            page_rows = list(
                (
                    await self.db.scalars(
                        page_query.order_by(BookPage.PageNumber, BookPage.Id)
                        .with_for_update()
                    )
                ).all()
            )
        existing_rows = list(
            (
                await self.db.scalars(
                    select(BookQualityPageScan).where(
                        BookQualityPageScan.ScanRunId == run.Id
                    )
                )
            ).all()
        )
        existing_ids = {row.PageId for row in existing_rows if row.PageId is not None}
        for page in page_rows:
            if page.Id in existing_ids:
                continue
            revision = (
                await self.revision(page.Id, page.CurrentVerifiedRevisionId)
                if page.CurrentVerifiedRevisionId is not None
                else None
            )
            is_valid_verified = (
                revision is not None
                and revision.Id == page.CurrentVerifiedRevisionId
                and revision.PageId == page.Id
                and revision.VerificationStatus == "VERIFIED"
            )
            self.db.add(
                BookQualityPageScan(
                    Id=uuid4(),
                    ScanRunId=run.Id,
                    BookId=page.BookId,
                    PageId=page.Id,
                    PageNumberSnapshot=page.PageNumber,
                    PageLifecycleSnapshot=page.LifecycleStatus,
                    PageRevisionId=page.CurrentVerifiedRevisionId,
                    ContentHash=(
                        revision.ContentHash
                        if is_valid_verified and revision.ContentHash
                        else (
                            hashlib.sha256(
                                (revision.VerifiedText or "").encode("utf-8")
                            ).hexdigest()
                            if is_valid_verified
                            else None
                        )
                    ),
                    VerifiedTextSnapshot=(
                        (revision.VerifiedText or "") if is_valid_verified else None
                    ),
                )
            )
        await self.db.flush()
        run.TotalPages = len(
            (
                await self.db.scalars(
                    select(BookQualityPageScan.Id).where(
                        BookQualityPageScan.ScanRunId == run.Id
                    )
                )
            ).all()
        )
        return await self.page_scans(run.Id)

    async def scan_page_context(
        self, page_scan_id: UUID
    ) -> tuple[BookQualityPageScan, BookPage | None, PageRevision | None] | None:
        page_scan = await self.page_scan(page_scan_id)
        if page_scan is None:
            return None
        page = (
            await self.page(page_scan.PageId, lock=True)
            if page_scan.PageId is not None
            else None
        )
        revision = (
            await self.revision(page.Id, page_scan.PageRevisionId)
            if page is not None and page_scan.PageRevisionId is not None
            else None
        )
        return page_scan, page, revision

    async def create_findings(self, rows: list[BookQualityFinding]) -> list[UUID]:
        if not rows:
            return []
        values = []
        for row in rows:
            if row.Id is None:
                row.Id = uuid4()
            values.append(
                {
                    "Id": row.Id,
                    "PageScanId": row.PageScanId,
                    "BookId": row.BookId,
                    "PageId": row.PageId,
                    "PageRevisionId": row.PageRevisionId,
                    "IssueType": row.IssueType,
                    "Severity": row.Severity,
                    "OriginalExcerpt": row.OriginalExcerpt,
                    "ExcerptStart": row.ExcerptStart,
                    "ExcerptEnd": row.ExcerptEnd,
                    "SuggestedCorrection": row.SuggestedCorrection,
                    "Explanation": row.Explanation,
                    "DetectionSource": row.DetectionSource,
                    "ModelName": row.ModelName,
                    "Confidence": row.Confidence,
                    "Status": row.Status,
                }
            )
        statement = (
            pg_insert(BookQualityFinding)
            .values(values)
            .on_conflict_do_nothing(
                index_elements=[
                    BookQualityFinding.PageScanId,
                    BookQualityFinding.IssueType,
                    BookQualityFinding.ExcerptStart,
                    BookQualityFinding.ExcerptEnd,
                    BookQualityFinding.DetectionSource,
                ]
            )
            .returning(BookQualityFinding.Id)
        )
        return list((await self.db.scalars(statement)).all())

    async def link_findings_to_reports(
        self,
        *,
        book_id: UUID,
        page_id: UUID,
        finding_ids: list[UUID],
    ) -> None:
        if not finding_ids:
            return
        reports = list(
            (
                await self.db.scalars(
                    select(BookContentReport).where(
                        BookContentReport.BookId == book_id,
                        or_(
                            BookContentReport.PageId == page_id,
                            BookContentReport.PageId.is_(None),
                        ),
                        BookContentReport.Status.in_(("OPEN", "UNDER_REVIEW")),
                    )
                )
            ).all()
        )
        if not reports:
            return
        findings = list(
            (
                await self.db.scalars(
                    select(BookQualityFinding).where(
                        BookQualityFinding.Id.in_(finding_ids),
                        BookQualityFinding.PageId == page_id,
                    )
                )
            ).all()
        )
        values = [
            {"ReportId": report.Id, "FindingId": finding.Id}
            for report in reports
            for finding in findings
            if report.PageId is None
            or report.PageRevisionId == finding.PageRevisionId
        ]
        if not values:
            return
        statement = (
            pg_insert(BookQualityReportFinding)
            .values(values)
            .on_conflict_do_nothing(
                index_elements=[
                    BookQualityReportFinding.ReportId,
                    BookQualityReportFinding.FindingId,
                ]
            )
        )
        await self.db.execute(statement)

    async def books_with_quality(
        self, *, search: str | None, limit: int, offset: int
    ):
        report_count = (
            select(func.count(BookContentReport.Id))
            .where(BookContentReport.BookId == Book.Id)
            .correlate(Book)
            .scalar_subquery()
        )
        open_report_count = (
            select(func.count(BookContentReport.Id))
            .where(
                BookContentReport.BookId == Book.Id,
                BookContentReport.Status.in_(("OPEN", "UNDER_REVIEW")),
            )
            .correlate(Book)
            .scalar_subquery()
        )
        finding_count = (
            select(func.count(BookQualityFinding.Id))
            .where(BookQualityFinding.BookId == Book.Id)
            .correlate(Book)
            .scalar_subquery()
        )
        needs_review_count = (
            select(func.count(BookQualityFinding.Id))
            .where(
                BookQualityFinding.BookId == Book.Id,
                BookQualityFinding.Status == "NEEDS_REVIEW",
            )
            .correlate(Book)
            .scalar_subquery()
        )
        query = select(
            Book,
            report_count,
            open_report_count,
            finding_count,
            needs_review_count,
        )
        count_query = select(func.count(Book.Id))
        if search and search.strip():
            pattern = "%" + search.strip().replace("%", "\\%").replace("_", "\\_") + "%"
            condition = or_(
                Book.Title.ilike(pattern, escape="\\"),
                Book.Name.ilike(pattern, escape="\\"),
            )
            query = query.where(condition)
            count_query = count_query.where(condition)
        rows = (
            await self.db.execute(
                query.order_by(Book.Title, Book.Id).offset(offset).limit(limit)
            )
        ).all()
        total = await self.db.scalar(count_query)
        return rows, int(total or 0)

    async def claim_next_scan(
        self, worker_id: str, *, lease_seconds: int = 1800
    ) -> BookQualityScanRun | None:
        now = datetime.now(timezone.utc)
        other_run = aliased(BookQualityScanRun)
        another_run_for_same_book = exists(
            select(1)
            .select_from(other_run)
            .where(
                other_run.BookId == BookQualityScanRun.BookId,
                other_run.Status == "RUNNING",
                other_run.LeaseExpiresAt.is_not(None),
                other_run.LeaseExpiresAt > now,
                other_run.Id != BookQualityScanRun.Id,
            )
        )
        expired_running = (
            (BookQualityScanRun.Status == "RUNNING")
            & or_(
                BookQualityScanRun.LeaseExpiresAt.is_(None),
                BookQualityScanRun.LeaseExpiresAt < now,
            )
        )
        statement = (
            select(BookQualityScanRun)
            .where(
                or_(
                    BookQualityScanRun.Status == "QUEUED",
                    expired_running,
                ),
                ~another_run_for_same_book,
            )
            .order_by(BookQualityScanRun.CreatedAt, BookQualityScanRun.Id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        run = await self.db.scalar(statement)
        if run is None:
            return None
        if run.BookId is not None:
            # Serialize all active scans for one book, even when one is a
            # page-scoped retry and another is a full-book scan. SKIP LOCKED
            # avoids workers waiting on the same book row.
            locked_book_id = await self.db.scalar(
                select(Book.Id)
                .where(Book.Id == run.BookId)
                .with_for_update(skip_locked=True)
            )
            if locked_book_id is None:
                await self.db.rollback()
                return None
        run.Status = "RUNNING"
        run.WorkerId = worker_id
        run.LeaseExpiresAt = now + timedelta(seconds=lease_seconds)
        run.AttemptCount = int(run.AttemptCount or 0) + 1
        run.StartedAt = run.StartedAt or now
        run.UpdatedAt = now
        await self.db.commit()
        await self.db.refresh(run)
        return run

    async def renew_scan_lease(
        self, scan_id: UUID, worker_id: str, *, lease_seconds: int = 1800
    ) -> bool:
        now = datetime.now(timezone.utc)
        result = await self.db.execute(
            update(BookQualityScanRun)
            .where(
                BookQualityScanRun.Id == scan_id,
                BookQualityScanRun.Status == "RUNNING",
                BookQualityScanRun.WorkerId == worker_id,
            )
            .values(
                LeaseExpiresAt=now + timedelta(seconds=lease_seconds),
                UpdatedAt=now,
            )
        )
        await self.db.commit()
        return bool(result.rowcount)
