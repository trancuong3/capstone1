"""HTTP routes for Parent Private Books ("Sách của tôi") and Admin User-Books moderation."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Query, Request, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.parent_private_book import (
    AdminSuspendPrivateBookRequest,
    AdminUserBookDecisionRequest,
    AdminUserBookDecisionResponse,
    AdminUserBookQueueFilter,
    AdminUserBookQueuePageRead,
    AdminUserBookSubmissionDetailRead,
    ParentAcceptSpellingRequest,
    ParentAddPageRequest,
    ParentAddPageResponse,
    ParentDeletePrivateBookResponse,
    ParentDeletePrivatePageResponse,
    ParentPageSubmissionRead,
    ParentPrivateBookCreate,
    ParentPrivateBookDetailRead,
    ParentPrivateBookSummaryRead,
    ParentPrivateBookUpdate,
    ParentPrivatePageEditRequest,
    ParentRequestAdminReviewRequest,
    ParentRetrySubmissionRequest,
    ParentSubmissionEditRequest,
    ParentSubmitPagesResponse,
)
from app.services.parent_private_book_service import ParentPrivateBookService

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
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).list_books(actor_id, ready_only=ready_only)


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
    source_note: str | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).replace_committed_page_file(
        actor_id,
        book_id,
        page_id,
        file,
        source_type=source_type,
        source_note=source_note,
        base_url=str(request.base_url),
    )


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
    source_note: str | None = Form(default=None),
    target_page_number: int | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
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
    source_note: str | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    _apply_no_store(response)
    return await ParentPrivateBookService(db).replace_submission_file(
        actor_id,
        book_id,
        submission_id,
        file,
        source_type=source_type,
        source_note=source_note,
        base_url=str(request.base_url),
    )


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


@router.delete("/my-books/{book_id}/submissions/{submission_id}")
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


@router.post("/admin/quality/user-books/{book_id}/suspend")
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
