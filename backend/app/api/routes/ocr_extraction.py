"""Authenticated FastAPI routes for Intelligent OCR Content Extraction (mounted at /studio/ocr)."""

from __future__ import annotations

import asyncio
import base64
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.models.book import Book, BookPage
from app.policies.book_access import is_book_private
from app.repositories.ocr_extraction_repository import OcrExtractionRepository
from app.schemas.ocr_extraction import (
    AnalyzeBlocksRequest,
    DocumentBoundaryResult,
    PageExtractRequest,
    PageOcrExtractionResponse,
    PatchPageBlocksRequest,
)
from app.services.ocr_content_extraction import apply_block_actions, extract_ocr_content
from app.services.ocr_document_boundary import detect_document_boundary
from app.services.rate_limiter import rate_limit

router = APIRouter()

_MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MiB safety limit
_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_private_headers(response: Response, book: Book | None) -> None:
    if book is not None and is_book_private(book):
        for key, value in _PRIVATE_NO_STORE_HEADERS.items():
            response.headers[key] = value


def _decode_inline_image(image_base64: str) -> bytes:
    raw_str = image_base64.strip()
    if "," in raw_str and raw_str.lower().startswith("data:image/"):
        raw_str = raw_str.split(",", 1)[1]
    try:
        decoded = base64.b64decode(raw_str, validate=True)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="INVALID_IMAGE_BASE64",
        ) from None
    if not decoded or len(decoded) > _MAX_INLINE_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="IMAGE_SIZE_OUT_OF_RANGE",
        )
    return decoded


async def _authorize_actor_role(
    repo: OcrExtractionRepository,
    actor_id: UUID,
) -> str:
    role = await repo.get_active_actor_role(actor_id)
    if role not in ("admin", "parent"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )
    return role


def _enforce_book_ownership(role: str, actor_id: UUID, book: Book) -> None:
    """Admin accesses all books; Parent accesses ONLY owned active private books (strict IDOR guard)."""
    if role == "admin":
        return
    if is_book_private(book):
        if (
            book.OwnerParentId != actor_id
            or bool(getattr(book, "IsDeleted", False))
            or str(getattr(book, "LifecycleStatus", "ACTIVE")).upper() != "ACTIVE"
            or str(getattr(book, "ModerationStatus", "ACTIVE") or "ACTIVE").upper()
            == "SUSPENDED"
        ):
            # Return 404 to prevent leaking existence of another parent's private book
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Book not found",
            )
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Access denied",
    )


async def _load_authorized_page(
    repo: OcrExtractionRepository,
    actor_id: UUID,
    page_id: UUID,
) -> tuple[str, BookPage, Book]:
    role = await _authorize_actor_role(repo, actor_id)
    pair = await repo.get_page_with_book(page_id)
    if pair is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Page not found",
        )
    page, book = pair
    _enforce_book_ownership(role, actor_id, book)
    return role, page, book


@router.post("/analyze-blocks", response_model=PageOcrExtractionResponse)
async def analyze_ocr_blocks(
    payload: AnalyzeBlocksRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_ocr_extract", default_max=60, default_window=60.0)),
) -> PageOcrExtractionResponse:
    repo = OcrExtractionRepository(db)
    role = await _authorize_actor_role(repo, actor_id)

    book: Book | None = None
    if payload.page_id is not None:
        pair = await repo.get_page_with_book(payload.page_id)
        if pair is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")
        _, book = pair
        _enforce_book_ownership(role, actor_id, book)
    elif payload.book_id is not None:
        book = await repo.get_book(payload.book_id)
        if book is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
        _enforce_book_ownership(role, actor_id, book)

    _apply_private_headers(response, book)
    resolved_book_id = book.Id if book is not None else payload.book_id
    resolved_book_title = payload.book_title or (book.Title if book is not None else None)
    resolved_book_author = payload.book_author or (book.Author if book is not None else None)

    if callable(getattr(db, "rollback", None)):
        await db.rollback()

    boundary: DocumentBoundaryResult | None = payload.boundary
    if boundary is None and payload.image_base64:
        img_bytes = await asyncio.to_thread(_decode_inline_image, payload.image_base64)
        word_boxes = [w.bbox for w in payload.words] if payload.words else None
        try:
            boundary = await asyncio.to_thread(
                detect_document_boundary, img_bytes, word_bboxes_norm=word_boxes
            )
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="INVALID_IMAGE",
            ) from None

    return await asyncio.to_thread(
        extract_ocr_content,
        payload.words,
        page_number=payload.page_number,
        book_title=resolved_book_title,
        book_author=resolved_book_author,
        cross_pages=payload.cross_pages,
        boundary=boundary,
        target_spread_side=payload.target_spread_side,
        filter_mode=payload.filter_mode,
        semantic_ai_json=payload.semantic_ai_json,
        book_id=resolved_book_id,
        book_page_id=payload.page_id,
    )


@router.post("/pages/{page_id}/extract", response_model=PageOcrExtractionResponse)
async def extract_page_ocr(
    page_id: UUID,
    payload: PageExtractRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_ocr_extract", default_max=60, default_window=60.0)),
) -> PageOcrExtractionResponse:
    repo = OcrExtractionRepository(db)
    _, page, book = await _load_authorized_page(repo, actor_id, page_id)
    _apply_private_headers(response, book)

    resolved_book_id = book.Id
    resolved_page_id = page.Id
    resolved_page_number = max(1, int(page.PageNumber or 1))
    resolved_book_title = book.Title
    resolved_book_author = book.Author
    owner_id = book.OwnerParentId if is_book_private(book) else None

    revision = await repo.resolve_revision_for_page(page, payload.page_revision_id)
    if payload.page_revision_id is not None and revision is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Page revision not found",
        )
    resolved_revision_id = revision.Id if revision is not None else None

    words = payload.words
    if words is None:
        words = await repo.load_revision_words(resolved_revision_id) if resolved_revision_id is not None else []

    cross_pages = payload.cross_pages
    if cross_pages is None and payload.include_cross_page:
        cross_pages = await repo.load_sibling_cross_pages(resolved_book_id, resolved_page_id)

    if callable(getattr(db, "rollback", None)):
        await db.rollback()

    boundary: DocumentBoundaryResult | None = payload.boundary
    if boundary is None and payload.image_base64:
        img_bytes = await asyncio.to_thread(_decode_inline_image, payload.image_base64)
        word_boxes = [w.bbox for w in words] if words else None
        try:
            boundary = await asyncio.to_thread(
                detect_document_boundary, img_bytes, word_bboxes_norm=word_boxes
            )
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="INVALID_IMAGE",
            ) from None

    result = await asyncio.to_thread(
        extract_ocr_content,
        words,
        page_number=resolved_page_number,
        book_title=resolved_book_title,
        book_author=resolved_book_author,
        cross_pages=cross_pages or [],
        boundary=boundary,
        filter_mode=payload.filter_mode,
        semantic_ai_json=payload.semantic_ai_json,
        book_id=resolved_book_id,
        book_page_id=resolved_page_id,
        page_revision_id=resolved_revision_id,
    )

    existing_row, load_degraded = await repo.get_latest_extraction(resolved_page_id)
    if load_degraded:
        return result.model_copy(update={"persisted": False, "storage_degraded": True})

    saved_row, save_degraded = await repo.save_extraction(
        book_id=resolved_book_id,
        page_id=resolved_page_id,
        page_revision_id=resolved_revision_id,
        owner_id=owner_id,
        extraction=result,
        source_words=list(words),
        undo_stack=[],
        existing_row=existing_row,
    )
    if save_degraded or saved_row is None:
        return result.model_copy(update={"persisted": False, "storage_degraded": True})

    await db.commit()
    return result.model_copy(
        update={
            "extraction_id": saved_row.Id,
            "persisted": True,
            "storage_degraded": False,
            "created_at": saved_row.CreatedAt,
            "updated_at": saved_row.UpdatedAt,
        }
    )


@router.get("/pages/{page_id}/extraction", response_model=PageOcrExtractionResponse)
async def get_page_extraction(
    page_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_ocr_read", default_max=180, default_window=60.0)),
) -> PageOcrExtractionResponse:
    repo = OcrExtractionRepository(db)
    _, page, book = await _load_authorized_page(repo, actor_id, page_id)
    _apply_private_headers(response, book)

    row, degraded = await repo.get_latest_extraction(page.Id)
    if degraded:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="EXTRACTION_STORAGE_UNMIGRATED",
        )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="EXTRACTION_NOT_FOUND",
        )
    hydrated, _, _ = repo.row_to_response(row)
    return hydrated


@router.patch("/pages/{page_id}/blocks", response_model=PageOcrExtractionResponse)
async def patch_page_blocks(
    page_id: UUID,
    payload: PatchPageBlocksRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_ocr_extract", default_max=120, default_window=60.0)),
) -> PageOcrExtractionResponse:
    repo = OcrExtractionRepository(db)
    _, page, book = await _load_authorized_page(repo, actor_id, page_id)
    _apply_private_headers(response, book)

    row, degraded = await repo.get_latest_extraction(page.Id)
    if degraded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="EXTRACTION_STORAGE_UNMIGRATED",
        )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="EXTRACTION_NOT_FOUND",
        )

    current_extraction, source_words, undo_stack = repo.row_to_response(row)
    try:
        updated_extraction, next_stack = apply_block_actions(
            current_extraction,
            payload,
            actor_id=str(actor_id),
            source_words=source_words if source_words else None,
            undo_stack=undo_stack,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc).strip("'"),
        ) from None
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from None

    owner_id = book.OwnerParentId if is_book_private(book) else None
    saved_row, save_degraded = await repo.save_extraction(
        book_id=book.Id,
        page_id=page.Id,
        page_revision_id=current_extraction.page_revision_id,
        owner_id=owner_id,
        extraction=updated_extraction,
        source_words=source_words,
        undo_stack=next_stack,
        existing_row=row,
    )
    if save_degraded or saved_row is None:
        return updated_extraction.model_copy(
            update={"persisted": False, "storage_degraded": True}
        )

    await db.commit()
    return updated_extraction.model_copy(
        update={
            "extraction_id": saved_row.Id,
            "persisted": True,
            "storage_degraded": False,
            "created_at": saved_row.CreatedAt,
            "updated_at": saved_row.UpdatedAt,
        }
    )
