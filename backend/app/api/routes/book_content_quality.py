"""Parent book-content reports and Admin book-quality inspection APIs."""
from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.schemas.book_content_quality import (
    BookContentIssueType,
    BookContentReportCreate,
    BookContentReportDetail,
    BookContentReportPage,
    BookContentReportStatusUpdate,
    BookContentRightsProfileRead,
    BookContentRightsProfileUpsert,
    BookExpectedPageCountUpdate,
    BookQualityBookDecisionRead,
    BookQualityBookDecisionRequest,
    BookQualityBookDetail,
    BookQualityBookPage,
    BookQualityFindingRead,
    BookQualityFindingUpdate,
    BookQualityIssueFilter,
    BookQualityScanDetail,
    BookQualityScanRead,
)
from app.services.book_content_quality_service import BookContentQualityService

router = APIRouter()


def _service(db: AsyncSession) -> BookContentQualityService:
    return BookContentQualityService(BookContentQualityRepository(db))


@router.post(
    "/catalog/{book_id}/reports",
    response_model=BookContentReportDetail,
    status_code=status.HTTP_201_CREATED,
)
async def create_parent_book_report(
    book_id: UUID,
    payload: BookContentReportCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Create a Parent report and its durable full-book scan request atomically."""
    return await _service(db).create_parent_report(actor_id, book_id, payload)


@router.get("/reports/mine", response_model=BookContentReportPage)
async def list_my_book_reports(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).list_parent_reports(
        actor_id, limit=limit, offset=offset
    )


@router.get("/reports/mine/{report_id}", response_model=BookContentReportDetail)
async def get_my_book_report(
    report_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).get_parent_report(actor_id, report_id)


@router.get("/admin/quality/reports")
async def list_admin_book_reports(
    report_status: Literal["OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED"] | None = Query(default=None, alias="status"),
    issue_type: BookContentIssueType | None = Query(default=None),
    scope: Literal["BOOK", "PAGE"] | None = Query(default=None),
    book_id: UUID | None = Query(default=None),
    search: str | None = Query(default=None, max_length=120),
    created_after: datetime | None = Query(default=None),
    created_before: datetime | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).list_admin_reports(
        actor_id,
        status=report_status,
        issue_type=issue_type,
        scope=scope,
        book_id=book_id,
        search=search,
        created_after=created_after,
        created_before=created_before,
        limit=limit,
        offset=offset,
    )


@router.get("/admin/quality/reports/{report_id}", response_model=BookContentReportDetail)
async def get_admin_book_report(
    report_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).get_admin_report(actor_id, report_id)


@router.patch(
    "/admin/quality/reports/{report_id}/status",
    response_model=BookContentReportDetail,
)
async def update_admin_book_report_status(
    report_id: UUID,
    payload: BookContentReportStatusUpdate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).update_report_status(actor_id, report_id, payload)


@router.get("/admin/quality/books", response_model=BookQualityBookPage)
async def list_admin_quality_books(
    search: str | None = Query(default=None, max_length=120),
    approval_status: Literal[
        "PROCESSING", "SCAN_FAILED", "PENDING_ADMIN_REVIEW", "READY_FOR_CHILDREN",
        "PUBLISHED", "APPROVED_BY_ADMIN", "REJECTED_FOR_CHILDREN", "STALE",
    ] | None = Query(default=None),
    alert_filter: Literal["CHILD_SAFETY", "COPYRIGHT", "BOTH"] | None = Query(default=None),
    issue_filter: BookQualityIssueFilter | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).list_books(
        actor_id,
        search=search,
        limit=limit,
        offset=offset,
        status_filter=approval_status,
        alert_filter=alert_filter,
        issue_filter=issue_filter,
    )


@router.get("/admin/quality/books/{book_id}", response_model=BookQualityBookDetail)
async def get_admin_quality_book(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).get_book_detail(actor_id, book_id)


@router.get(
    "/admin/quality/books/{book_id}/rights-profile",
    response_model=BookContentRightsProfileRead,
)
async def get_admin_book_rights_profile(
    book_id: UUID,
    page_id: UUID | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).get_rights_profile(actor_id, book_id, page_id=page_id)


@router.put(
    "/admin/quality/books/{book_id}/rights-profile",
    response_model=BookContentRightsProfileRead,
)
async def upsert_admin_book_rights_profile(
    book_id: UUID,
    payload: BookContentRightsProfileUpsert,
    page_id: UUID | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).upsert_rights_profile(
        actor_id, book_id, payload, page_id=page_id
    )


@router.post(
    "/admin/quality/books/{book_id}/rights-profile/overlap-check",
    response_model=BookContentRightsProfileRead,
)
async def run_admin_book_rights_overlap_check(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).run_rights_corpus_overlap_check(actor_id, book_id)


@router.patch("/admin/quality/books/{book_id}/expected-page-count")
async def update_admin_book_expected_page_count(
    book_id: UUID,
    payload: BookExpectedPageCountUpdate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).update_expected_page_count(actor_id, book_id, payload)


@router.post(
    "/admin/quality/books/{book_id}/decision",
    response_model=BookQualityBookDecisionRead,
)
async def decide_admin_quality_book(
    book_id: UUID,
    payload: BookQualityBookDecisionRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).decide_book(actor_id, book_id, payload)


@router.post(
    "/admin/quality/books/{book_id}/scan",
    response_model=BookQualityScanRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def enqueue_admin_book_scan(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).enqueue_scan(actor_id, book_id)


@router.get(
    "/admin/quality/books/{book_id}/scans",
    response_model=list[BookQualityScanRead],
)
async def list_admin_book_scans(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).list_book_scans(actor_id, book_id)


@router.get(
    "/admin/quality/scans/{scan_id}",
    response_model=BookQualityScanDetail,
)
async def get_admin_book_scan(
    scan_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).get_scan_detail(actor_id, scan_id)


@router.post(
    "/admin/quality/scans/{scan_id}/pages/{page_scan_id}/retry",
    response_model=BookQualityScanRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_admin_book_scan_page(
    scan_id: UUID,
    page_scan_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).retry_scan_page(actor_id, scan_id, page_scan_id)


@router.patch(
    "/admin/quality/findings/{finding_id}",
    response_model=BookQualityFindingRead,
)
async def update_admin_book_finding(
    finding_id: UUID,
    payload: BookQualityFindingUpdate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).update_finding(actor_id, finding_id, payload)
