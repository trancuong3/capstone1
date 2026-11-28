"""HTTP routes for Feature #2: Co-Reading Role-Play & Parent Storyteller Voice (`/co-reading`).

Privacy & Security Guardrails:
  - Strictly `PARENT_PRIVATE` household isolation via `require_parent_id`.
  - Mandatory `Cache-Control: private, no-store` on every JSON and audio response.
  - Zero public URLs or external share links.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.schemas.co_reading import (
    NarrationDeleteResponse,
    NarrationMetaResponse,
    NarrationUploadResponse,
    ParseScriptRequest,
    ParseScriptResponse,
    PostcardCreateRequest,
    PostcardDeleteResponse,
    PostcardListResponse,
    PostcardRead,
)
from app.services.parent_narration_service import (
    MAX_NARRATION_BYTES,
    MAX_POSTCARD_CLIP_BYTES,
    ParentNarrationService,
)
from app.services.rate_limiter import rate_limit

router = APIRouter(
    dependencies=[Depends(rate_limit("co_reading", default_max=120, default_window=60.0))]
)

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Pragma": "no-cache",
    "Vary": "Authorization",
    "X-Content-Type-Options": "nosniff",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


def _parse_optional_uuid(raw: str | None, field_name: str) -> UUID | None:
    if raw is None or not str(raw).strip():
        return None
    try:
        return UUID(str(raw).strip())
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid UUID for {field_name}",
        ) from exc


# ---------------------------------------------------------------------------
# 1. Dialogue Role-Play & Turn-Taking Script Parser
# ---------------------------------------------------------------------------


@router.post(
    "/children/{child_id}/parse-script",
    response_model=ParseScriptResponse,
    status_code=status.HTTP_200_OK,
)
async def parse_child_co_reading_script(
    child_id: UUID,
    payload: ParseScriptRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ParseScriptResponse:
    _apply_no_store(response)
    return await ParentNarrationService(db).parse_child_page_script(
        parent_id=parent_id,
        child_id=child_id,
        payload=payload,
    )


# ---------------------------------------------------------------------------
# 2. Parent Storyteller Voice Narration (PARENT_PRIVATE)
# ---------------------------------------------------------------------------


@router.post(
    "/my-books/{book_id}/pages/{page_id}/narration",
    response_model=NarrationUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_parent_page_narration(
    book_id: UUID,
    page_id: UUID,
    response: Response,
    audio_file: UploadFile = File(...),
    page_text: str = Form(default="", max_length=8000),
    duration_ms: int = Form(default=0, ge=0, le=300_000),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> NarrationUploadResponse:
    _apply_no_store(response)
    resolved_page_text = page_text if isinstance(page_text, str) else ""
    resolved_duration_ms = (
        duration_ms
        if isinstance(duration_ms, int) and not isinstance(duration_ms, bool)
        else 0
    )
    audio_bytes = await audio_file.read(MAX_NARRATION_BYTES + 1)
    return await ParentNarrationService(db).upsert_narration(
        parent_id=parent_id,
        book_id=book_id,
        page_id=page_id,
        audio_bytes=audio_bytes,
        page_text=resolved_page_text,
        duration_ms=resolved_duration_ms if resolved_duration_ms > 0 else None,
    )


@router.get(
    "/my-books/{book_id}/pages/{page_id}/narration",
    response_model=NarrationMetaResponse,
    status_code=status.HTTP_200_OK,
)
async def get_parent_page_narration(
    book_id: UUID,
    page_id: UUID,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> NarrationMetaResponse:
    _apply_no_store(response)
    return await ParentNarrationService(db).get_narration_meta(
        parent_id=parent_id,
        book_id=book_id,
        page_id=page_id,
    )


@router.get(
    "/my-books/{book_id}/pages/{page_id}/narration/audio",
    status_code=status.HTTP_200_OK,
)
async def stream_parent_page_narration_audio(
    book_id: UUID,
    page_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> Response:
    audio_bytes, content_type = await ParentNarrationService(db).get_narration_audio_bytes(
        parent_id=parent_id,
        book_id=book_id,
        page_id=page_id,
    )
    return Response(
        content=audio_bytes,
        media_type=content_type,
        headers=dict(_PRIVATE_NO_STORE_HEADERS),
    )


@router.delete(
    "/my-books/{book_id}/pages/{page_id}/narration",
    response_model=NarrationDeleteResponse,
    status_code=status.HTTP_200_OK,
)
async def delete_parent_page_narration(
    book_id: UUID,
    page_id: UUID,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> NarrationDeleteResponse:
    _apply_no_store(response)
    return await ParentNarrationService(db).delete_narration(
        parent_id=parent_id,
        book_id=book_id,
        page_id=page_id,
    )


# ---------------------------------------------------------------------------
# 3. Family Reading Postcards ("Bưu Thiếp Tiến Bộ Gia Đình" — PARENT_PRIVATE)
#    Accepts BOTH `application/json` (no audio clip) and `multipart/form-data`
#    (with optional short `audio_clip` <= 256 KiB).
# ---------------------------------------------------------------------------


@router.post(
    "/children/{child_id}/postcards",
    response_model=PostcardRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_family_reading_postcard(
    child_id: UUID,
    request: Request,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PostcardRead:
    _apply_no_store(response)
    content_type = (request.headers.get("content-type") or "").lower()
    audio_bytes: bytes | None = None

    if "application/json" in content_type:
        try:
            body = await request.json()
            payload = PostcardCreateRequest.model_validate(body)
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=exc.errors(),
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Invalid JSON body",
            ) from exc
    else:
        form = await request.form()
        raw_title = str(form.get("title") or "")
        raw_passage = str(form.get("passage_text") or "")
        raw_emoji = str(form.get("emoji_badge") or "🌟")
        raw_book_id = form.get("source_book_id")
        raw_page_id = form.get("source_page_id")
        upload = form.get("audio_clip")
        if upload is not None and hasattr(upload, "read"):
            audio_bytes = await upload.read(MAX_POSTCARD_CLIP_BYTES + 1)  # type: ignore[misc]

        try:
            payload = PostcardCreateRequest(
                title=raw_title,
                passage_text=raw_passage,
                emoji_badge=raw_emoji,
                source_book_id=_parse_optional_uuid(
                    str(raw_book_id) if raw_book_id is not None else None,
                    "source_book_id",
                ),
                source_page_id=_parse_optional_uuid(
                    str(raw_page_id) if raw_page_id is not None else None,
                    "source_page_id",
                ),
            )
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=exc.errors(),
            ) from exc

    return await ParentNarrationService(db).create_postcard(
        parent_id=parent_id,
        child_id=child_id,
        payload=payload,
        audio_bytes=audio_bytes,
    )


@router.get(
    "/children/{child_id}/postcards",
    response_model=PostcardListResponse,
    status_code=status.HTTP_200_OK,
)
async def list_family_reading_postcards(
    child_id: UUID,
    response: Response,
    limit: int = Query(default=50, ge=1, le=200),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PostcardListResponse:
    _apply_no_store(response)
    safe_limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 50
    return await ParentNarrationService(db).list_postcards(
        parent_id=parent_id,
        child_id=child_id,
        limit=safe_limit,
    )


@router.get(
    "/children/{child_id}/postcards/{postcard_id}/audio",
    status_code=status.HTTP_200_OK,
)
async def stream_family_reading_postcard_audio(
    child_id: UUID,
    postcard_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> Response:
    audio_bytes, content_type = await ParentNarrationService(db).get_postcard_audio_bytes(
        parent_id=parent_id,
        child_id=child_id,
        postcard_id=postcard_id,
    )
    return Response(
        content=audio_bytes,
        media_type=content_type,
        headers=dict(_PRIVATE_NO_STORE_HEADERS),
    )


@router.delete(
    "/children/{child_id}/postcards/{postcard_id}",
    response_model=PostcardDeleteResponse,
    status_code=status.HTTP_200_OK,
)
async def delete_family_reading_postcard(
    child_id: UUID,
    postcard_id: UUID,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PostcardDeleteResponse:
    _apply_no_store(response)
    return await ParentNarrationService(db).delete_postcard(
        parent_id=parent_id,
        child_id=child_id,
        postcard_id=postcard_id,
    )
