"""HTTP routes for Book Cover Studio, Book Style Bible, Text-Free Illustrations & Authenticated Media Proxy.

Mounted by Coordinator at prefix="/studio".
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.book_assets import (
    BookAssetsSummaryResponse,
    BookCoverDeleteResponse,
    BookCoverFromPageRequest,
    BookCoverGenerateRequest,
    BookCoverGenerateResponse,
    BookPresentationAssetRead,
    BookStyleBibleRead,
    BookStyleBibleRequest,
    PageIllustrationExtractRequest,
    PageIllustrationExtractResponse,
    PageIllustrationGenerateRequest,
    PageIllustrationGenerateResponse,
    PageIllustrationModerationRequest,
)
from app.services.book_cover_service import BookCoverService, MAX_COVER_UPLOAD_BYTES
from app.services.book_illustration_service import (
    BookIllustrationService,
    _build_default_ocr_check_fn,
)
from app.services.book_style_bible import BookStyleBibleService
from app.services.rate_limiter import rate_limit

router = APIRouter()

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Vary": "Authorization",
    "X-Content-Type-Options": "nosniff",
}

_CATALOG_MEDIA_HEADERS = {
    "Cache-Control": "private, max-age=300",
    "Vary": "Authorization",
    "X-Content-Type-Options": "nosniff",
}


def _apply_headers(response: Response, headers: dict[str, str]) -> None:
    for key, value in headers.items():
        response.headers[key] = value


@router.get("/books/{book_id}/assets", response_model=BookAssetsSummaryResponse)
async def get_book_assets(
    book_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_assets_read", default_max=180, default_window=60.0)),
) -> BookAssetsSummaryResponse:
    summary = await BookCoverService(db).get_book_assets_summary(actor_id, book_id)
    if summary.visibility_scope == "PARENT_PRIVATE":
        _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    else:
        response.headers["Vary"] = "Authorization"
    return summary


@router.post(
    "/books/{book_id}/cover/upload",
    response_model=BookPresentationAssetRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_book_cover(
    book_id: UUID,
    response: Response,
    file: UploadFile = File(...),
    crop_x: float | None = Form(default=None),
    crop_y: float | None = Form(default=None),
    crop_w: float | None = Form(default=None),
    crop_h: float | None = Form(default=None),
    rotation: int = Form(default=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_assets_write", default_max=60, default_window=60.0)),
) -> BookPresentationAssetRead:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    try:
        raw_bytes = await file.read(MAX_COVER_UPLOAD_BYTES + 1)
    finally:
        await file.close()
    return await BookCoverService(db).upload_user_cover(
        actor_id,
        book_id,
        raw_bytes,
        file.content_type,
        crop_x=crop_x,
        crop_y=crop_y,
        crop_w=crop_w,
        crop_h=crop_h,
        rotation=rotation,
    )


@router.delete("/books/{book_id}/cover", response_model=BookCoverDeleteResponse)
async def delete_book_cover(
    book_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_assets_write", default_max=60, default_window=60.0)),
) -> BookCoverDeleteResponse:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    return await BookCoverService(db).delete_book_cover(actor_id, book_id)


@router.post("/books/{book_id}/cover/generate", response_model=BookCoverGenerateResponse)
async def generate_book_cover(
    book_id: UUID,
    response: Response,
    payload: BookCoverGenerateRequest | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_ai_generate", default_max=30, default_window=60.0)),
) -> BookCoverGenerateResponse:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    return await BookCoverService(
        db,
        ocr_check_fn=_build_default_ocr_check_fn(),
    ).generate_ai_cover(
        actor_id,
        book_id,
        payload or BookCoverGenerateRequest(),
    )


@router.post(
    "/books/{book_id}/cover/from-page",
    response_model=BookPresentationAssetRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_book_cover_from_page(
    book_id: UUID,
    payload: BookCoverFromPageRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_assets_write", default_max=60, default_window=60.0)),
) -> BookPresentationAssetRead:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    return await BookCoverService(db).extract_cover_from_page(
        book_id,
        payload.page_id,
        actor_id,
        crop_x=payload.crop_x,
        crop_y=payload.crop_y,
        crop_w=payload.crop_w,
        crop_h=payload.crop_h,
        rotation=payload.rotation,
        apply_clahe_restore=payload.apply_clahe_restore,
        force_replace_user_upload=payload.force_replace_user_upload,
    )


@router.post("/books/{book_id}/style-bible", response_model=BookStyleBibleRead)
async def build_book_style_bible(
    book_id: UUID,
    response: Response,
    payload: BookStyleBibleRequest | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_ai_generate", default_max=30, default_window=60.0)),
) -> BookStyleBibleRead:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    req = payload or BookStyleBibleRequest()
    return await BookStyleBibleService(db).build_for_actor(
        actor_id,
        book_id,
        extra_sample_texts=req.sample_texts,
        force_refresh=req.force_refresh,
    )


@router.post(
    "/books/{book_id}/pages/{page_id}/illustration/extract",
    response_model=PageIllustrationExtractResponse,
)
async def extract_page_illustration(
    book_id: UUID,
    page_id: UUID,
    response: Response,
    payload: PageIllustrationExtractRequest | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_assets_write", default_max=60, default_window=60.0)),
) -> PageIllustrationExtractResponse:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    return await BookIllustrationService(
        db,
        ocr_check_fn=_build_default_ocr_check_fn(),
    ).extract_page_illustration(
        actor_id,
        book_id,
        page_id,
        payload or PageIllustrationExtractRequest(),
    )


@router.post(
    "/books/{book_id}/pages/{page_id}/illustration/generate",
    response_model=PageIllustrationGenerateResponse,
)
async def generate_page_illustration(
    book_id: UUID,
    page_id: UUID,
    response: Response,
    payload: PageIllustrationGenerateRequest | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_ai_generate", default_max=30, default_window=60.0)),
) -> PageIllustrationGenerateResponse:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    return await BookIllustrationService(
        db,
        ocr_check_fn=_build_default_ocr_check_fn(),
    ).generate_page_illustration(
        actor_id,
        book_id,
        page_id,
        payload or PageIllustrationGenerateRequest(),
    )


@router.patch(
    "/books/{book_id}/pages/{page_id}/illustration/{asset_id}",
    response_model=BookPresentationAssetRead,
)
async def moderate_page_illustration(
    book_id: UUID,
    page_id: UUID,
    asset_id: UUID,
    payload: PageIllustrationModerationRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_assets_write", default_max=60, default_window=60.0)),
) -> BookPresentationAssetRead:
    _apply_headers(response, _PRIVATE_NO_STORE_HEADERS)
    return await BookIllustrationService(db).moderate_page_illustration(
        actor_id,
        book_id,
        page_id,
        asset_id,
        payload,
    )


@router.get("/assets/{asset_id}/media")
async def stream_studio_asset_media(
    asset_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_assets_read", default_max=180, default_window=60.0)),
) -> Response:
    content, mime_type, is_private = await BookCoverService(
        db
    ).get_authorized_asset_media(actor_id, asset_id)
    headers = _PRIVATE_NO_STORE_HEADERS if is_private else _CATALOG_MEDIA_HEADERS
    return Response(content=content, media_type=mime_type, headers=dict(headers))
