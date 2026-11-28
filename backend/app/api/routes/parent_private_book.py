"""HTTP routes for Parent Private Books ("Sách của tôi") and Admin User-Books moderation."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Query, Request, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.parent_private_book import (
    AdminFlow2CandidateDecisionRequest,
    AdminFlow2CandidateDecisionResponse,
    AdminFlow2CandidatePageRead,
    AdminSuspendPrivateBookRequest,
    AdminSuspendPrivateBookResponse,
    AdminUserBookDecisionRequest,
    AdminUserBookDecisionResponse,
    AdminUserBookQueueFilter,
    AdminUserBookQueuePageRead,
    AdminUserBookSubmissionDetailRead,
    Flow2CandidateStatus,
    ParentAcceptSpellingRequest,
    ParentAddPageRequest,
    ParentAddPageResponse,
    ParentCancelSubmissionResponse,
    ParentDeletePrivateBookResponse,
    ParentDeletePrivatePageResponse,
    ParentOcrContributionStateRead,
    ParentOcrContributionUpdateRequest,
    ParentPageSubmissionRead,
    ParentPrivateBookCreate,
    ParentPrivateBookDetailRead,
    ParentPrivateBookPageRead,
    ParentPrivateBookSummaryRead,
    ParentPrivateBookUpdate,
    ParentPrivatePageEditRequest,
    ParentRequestAdminReviewRequest,
    ParentRetrySubmissionRequest,
    ParentStoryweaverRequest,
    ParentStoryweaverResponse,
    ParentSubmissionEditRequest,
    ParentSubmitPagesResponse,
)
from app.services.parent_flow2_contribution_service import ParentFlow2ContributionService
from app.services.parent_private_book_service import ParentPrivateBookService
from app.services.rate_limiter import rate_limit

router = APIRouter()

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


# ---------------------------------------------------------------------------
# Parent Private Books ("Sách của tôi")
# ---------------------------------------------------------------------------
@router.post(
    "/my-books",
    response_model=ParentPrivateBookSummaryRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_my_private_book(
    payload: ParentPrivateBookCreate,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).create_book(actor_id, payload)


@router.get("/my-books", response_model=list[ParentPrivateBookSummaryRead])
async def list_my_private_books(
    response: Response,
    ready_only: bool = Query(default=False),
    limit: int | None = Query(default=None, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    ready_only = ready_only if isinstance(ready_only, bool) else False
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else None
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    items = await ParentPrivateBookService(db).list_books(actor_id, ready_only=ready_only)
    safe_offset = offset if offset > 0 else 0
    safe_limit = limit if limit is not None and limit > 0 else None
    if safe_offset == 0 and safe_limit is None:
        return items
    return items[safe_offset : (safe_offset + safe_limit if safe_limit is not None else None)]


@router.get("/my-books/paged", response_model=ParentPrivateBookPageRead)
async def list_my_private_books_paged(
    response: Response,
    ready_only: bool = Query(default=False),
    search: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=9, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    ready_only = ready_only if isinstance(ready_only, bool) else False
    search = search if isinstance(search, str) else None
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 9
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    return await ParentPrivateBookService(db).list_books_paged(
        actor_id,
        ready_only=ready_only,
        search=search,
        limit=limit,
        offset=offset,
    )


@router.post(
    "/my-books/storyweaver",
    response_model=ParentStoryweaverResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("parent_storyweaver", default_max=15, default_window=60.0))],
)
async def create_storyweaver_private_book(
    payload: ParentStoryweaverRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    from app.services.family_storyweaver_service import FamilyStoryweaverService

    base_url = str(request.base_url) if hasattr(request, "base_url") else None
    return await FamilyStoryweaverService(db).create_storyweaver_book(
        actor_id, payload, base_url=base_url
    )


@router.get("/my-books/{book_id}", response_model=ParentPrivateBookDetailRead)
async def get_my_private_book(
    book_id: UUID,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).get_book(
        actor_id, book_id, base_url=str(request.base_url)
    )


@router.patch("/my-books/{book_id}", response_model=ParentPrivateBookSummaryRead)
async def update_my_private_book(
    book_id: UUID,
    payload: ParentPrivateBookUpdate,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).update_book(actor_id, book_id, payload)


@router.delete("/my-books/{book_id}", response_model=ParentDeletePrivateBookResponse)
async def delete_my_private_book(
    book_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).delete_book(actor_id, book_id)


@router.patch(
    "/my-books/{book_id}/pages/{page_id}",
    response_model=ParentPageSubmissionRead,
)
async def edit_my_private_book_page(
    book_id: UUID,
    page_id: UUID,
    payload: ParentPrivatePageEditRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).edit_committed_page(
        actor_id, book_id, page_id, payload, base_url=str(request.base_url)
    )


@router.put(
    "/my-books/{book_id}/pages/{page_id}/file",
    response_model=ParentPageSubmissionRead,
)
async def replace_my_private_book_page_file(
    book_id: UUID,
    page_id: UUID,
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    source_type: str | None = Form(default=None),
    source_note: str | None = Form(default=None, max_length=1000),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("private_book_upload", default_max=60, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    source_type = source_type if isinstance(source_type, str) else None
    source_note = source_note if isinstance(source_note, str) else None
    try:
        return await ParentPrivateBookService(db).replace_committed_page_file(
            actor_id,
            book_id,
            page_id,
            file,
            source_type=source_type,
            source_note=source_note,
            base_url=str(request.base_url),
        )
    finally:
        await file.close()


@router.delete(
    "/my-books/{book_id}/pages/{page_id}",
    response_model=ParentDeletePrivatePageResponse,
)
async def delete_my_private_book_page(
    book_id: UUID,
    page_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).delete_committed_page(
        actor_id, book_id, page_id
    )


@router.post(
    "/my-books/{book_id}/submissions",
    response_model=ParentSubmitPagesResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_my_private_book_pages(
    book_id: UUID,
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    idempotency_key: str = Form(..., min_length=1, max_length=128),
    source_type: str = Form(default="OWNED_PHYSICAL_BOOK"),
    source_note: str | None = Form(default=None, max_length=1000),
    target_page_number: int | None = Form(default=None, ge=1, le=32767),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("private_book_upload", default_max=60, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    source_type = (
        source_type if isinstance(source_type, str) else "OWNED_PHYSICAL_BOOK"
    )
    source_note = source_note if isinstance(source_note, str) else None
    target_page_number = (
        target_page_number
        if isinstance(target_page_number, int) and not isinstance(target_page_number, bool)
        else None
    )
    try:
        return await ParentPrivateBookService(db).submit_pages(
            actor_id,
            book_id,
            file,
            idempotency_key=idempotency_key,
            source_type=source_type,
            source_note=source_note,
            target_page_number=target_page_number,
            base_url=str(request.base_url),
        )
    finally:
        await file.close()


@router.get(
    "/my-books/{book_id}/submissions/{submission_id}",
    response_model=ParentPageSubmissionRead,
)
async def get_my_private_book_submission(
    book_id: UUID,
    submission_id: UUID,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).get_submission(
        actor_id, book_id, submission_id, base_url=str(request.base_url)
    )


@router.post(
    "/my-books/{book_id}/submissions/{submission_id}/accept-spelling",
    response_model=ParentPageSubmissionRead,
)
async def accept_my_submission_spelling(
    book_id: UUID,
    submission_id: UUID,
    payload: ParentAcceptSpellingRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).accept_spelling(
        actor_id, book_id, submission_id, payload, base_url=str(request.base_url)
    )


@router.patch(
    "/my-books/{book_id}/submissions/{submission_id}",
    response_model=ParentPageSubmissionRead,
)
async def edit_my_submission(
    book_id: UUID,
    submission_id: UUID,
    payload: ParentSubmissionEditRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).edit_submission(
        actor_id, book_id, submission_id, payload, base_url=str(request.base_url)
    )


@router.put(
    "/my-books/{book_id}/submissions/{submission_id}/file",
    response_model=ParentPageSubmissionRead,
)
async def replace_my_submission_file(
    book_id: UUID,
    submission_id: UUID,
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    source_type: str | None = Form(default=None),
    source_note: str | None = Form(default=None, max_length=1000),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("private_book_upload", default_max=60, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    source_type = source_type if isinstance(source_type, str) else None
    source_note = source_note if isinstance(source_note, str) else None
    try:
        return await ParentPrivateBookService(db).replace_submission_file(
            actor_id,
            book_id,
            submission_id,
            file,
            source_type=source_type,
            source_note=source_note,
            base_url=str(request.base_url),
        )
    finally:
        await file.close()


@router.post(
    "/my-books/{book_id}/submissions/{submission_id}/retry",
    response_model=ParentPageSubmissionRead,
)
async def retry_my_submission(
    book_id: UUID,
    submission_id: UUID,
    payload: ParentRetrySubmissionRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).retry_submission(
        actor_id, book_id, submission_id, payload, base_url=str(request.base_url)
    )


@router.delete(
    "/my-books/{book_id}/submissions/{submission_id}",
    response_model=ParentCancelSubmissionResponse,
)
async def cancel_my_submission(
    book_id: UUID,
    submission_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).cancel_submission(
        actor_id, book_id, submission_id
    )


@router.get("/my-books/{book_id}/submissions/{submission_id}/ocr-job")
async def get_my_submission_ocr_job(
    book_id: UUID,
    submission_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).get_submission_ocr_job_status(
        actor_id, book_id, submission_id
    )


@router.post(
    "/my-books/{book_id}/submissions/{submission_id}/request-admin-review",
    response_model=ParentPageSubmissionRead,
)
async def request_admin_review_for_submission(
    book_id: UUID,
    submission_id: UUID,
    payload: ParentRequestAdminReviewRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).request_admin_review(
        actor_id, book_id, submission_id, payload, base_url=str(request.base_url)
    )


@router.post(
    "/my-books/{book_id}/submissions/{submission_id}/add-page",
    response_model=ParentAddPageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_submission_page_to_my_book(
    book_id: UUID,
    submission_id: UUID,
    payload: ParentAddPageRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).add_page_to_book(
        actor_id, book_id, submission_id, payload, base_url=str(request.base_url)
    )


# ---------------------------------------------------------------------------
# Authenticated Private Image Proxies (NEVER cached, verified on EVERY request)
# ---------------------------------------------------------------------------
@router.get("/my-books/{book_id}/pages/{page_id}/image")
async def get_my_private_page_image(
    book_id: UUID,
    page_id: UUID,
    revision_id: UUID | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    revision_id = revision_id if isinstance(revision_id, (UUID, str)) else None
    data, media_type = await ParentPrivateBookService(db).read_owner_page_image(
        actor_id, book_id, page_id, revision_id=revision_id
    )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            **_PRIVATE_NO_STORE_HEADERS,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/my-books/{book_id}/submissions/{submission_id}/image")
async def get_my_private_submission_image(
    book_id: UUID,
    submission_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    data, media_type = await ParentPrivateBookService(db).read_owner_submission_image(
        actor_id, book_id, submission_id
    )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            **_PRIVATE_NO_STORE_HEADERS,
            "X-Content-Type-Options": "nosniff",
        },
    )


# ---------------------------------------------------------------------------
# Admin "Sách người dùng" Moderation Routes (inside Quality domain)
# ---------------------------------------------------------------------------
@router.get("/admin/quality/user-books", response_model=AdminUserBookQueuePageRead)
async def list_admin_user_books_queue(
    response: Response,
    queue_status: AdminUserBookQueueFilter | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    queue_status = queue_status if isinstance(queue_status, str) else None
    search = search if isinstance(search, str) else None
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 20
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    return await ParentPrivateBookService(db).admin_list_user_books(
        actor_id,
        status_filter=queue_status,
        search=search,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/admin/quality/user-books/submissions/{submission_id}",
    response_model=AdminUserBookSubmissionDetailRead,
)
async def get_admin_user_book_submission_detail(
    submission_id: UUID,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).admin_get_submission_detail(
        actor_id, submission_id, base_url=str(request.base_url)
    )


@router.get("/admin/quality/user-books/submissions/{submission_id}/image")
async def get_admin_user_book_submission_image(
    submission_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    data, media_type = await ParentPrivateBookService(db).admin_read_submission_image(
        actor_id, submission_id
    )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            **_PRIVATE_NO_STORE_HEADERS,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/admin/quality/user-books/submissions/{submission_id}/decision",
    response_model=AdminUserBookDecisionResponse,
)
async def decide_admin_user_book_submission(
    submission_id: UUID,
    payload: AdminUserBookDecisionRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).admin_decide_submission(
        actor_id, submission_id, payload
    )


@router.post(
    "/admin/quality/user-books/{book_id}/suspend",
    response_model=AdminSuspendPrivateBookResponse,
)
async def suspend_admin_user_book(
    book_id: UUID,
    payload: AdminSuspendPrivateBookRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).admin_suspend_book(
        actor_id, book_id, payload
    )


# ---------------------------------------------------------------------------
# Parent Private Book -> Flow 2 (Admin Verified) OCR Contribution
# ---------------------------------------------------------------------------
@router.get(
    "/my-books/{book_id}/ocr-contribution",
    response_model=ParentOcrContributionStateRead,
)
async def get_my_private_book_ocr_contribution(
    book_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentFlow2ContributionService(db).get_book_contribution_state(
        actor_id, book_id
    )


@router.put(
    "/my-books/{book_id}/ocr-contribution",
    response_model=ParentOcrContributionStateRead,
)
async def update_my_private_book_ocr_contribution(
    book_id: UUID,
    payload: ParentOcrContributionUpdateRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentFlow2ContributionService(db).update_book_contribution_consent(
        actor_id, book_id, payload
    )


@router.get(
    "/admin/quality/user-books/flow2-candidates",
    response_model=AdminFlow2CandidatePageRead,
)
async def list_admin_flow2_candidates(
    request: Request,
    response: Response,
    candidate_status: Flow2CandidateStatus | None = Query(default=None, alias="status"),
    book_id: UUID | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    candidate_status = candidate_status if isinstance(candidate_status, str) else None
    book_id = book_id if isinstance(book_id, (UUID, str)) else None
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 25
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    return await ParentFlow2ContributionService(db).admin_list_candidates(
        actor_id,
        status_filter=candidate_status,
        book_id=book_id,
        limit=limit,
        offset=offset,
        base_url=str(request.base_url),
    )


@router.get("/admin/quality/user-books/flow2-candidates/{candidate_id}/crop")
async def get_admin_flow2_candidate_crop(
    candidate_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    data, media_type = await ParentFlow2ContributionService(db).admin_read_candidate_crop_image(
        actor_id, candidate_id
    )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            **_PRIVATE_NO_STORE_HEADERS,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/admin/quality/user-books/flow2-candidates/{candidate_id}/decision",
    response_model=AdminFlow2CandidateDecisionResponse,
)
async def decide_admin_flow2_candidate(
    candidate_id: UUID,
    payload: AdminFlow2CandidateDecisionRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentFlow2ContributionService(db).admin_decide_candidate(
        actor_id, candidate_id, payload
    )
