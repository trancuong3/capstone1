"""HTTP routes for Feature #6: Contextual Kids Glossary & PARENT_PRIVATE Vocabulary Notebook."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.schemas.vocabulary_notebook import (
    FavoriteWordCreateRequest,
    FavoriteWordDeleteResponse,
    FavoriteWordRead,
    VocabularyNotebookListResponse,
    WordExplainRequest,
    WordExplainResponse,
)
from app.services.kid_glossary_service import KidGlossaryService
from app.services.rate_limiter import rate_limit

router = APIRouter(
    dependencies=[Depends(rate_limit("vocabulary", default_max=120, default_window=60.0))]
)

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


@router.post(
    "/children/{child_id}/explain",
    response_model=WordExplainResponse,
    status_code=status.HTTP_200_OK,
)
async def explain_child_word(
    child_id: UUID,
    payload: WordExplainRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> WordExplainResponse:
    _apply_no_store(response)
    return await KidGlossaryService(db).explain_word(parent_id, child_id, payload)


@router.get(
    "/children/{child_id}/notebook",
    response_model=VocabularyNotebookListResponse,
    status_code=status.HTTP_200_OK,
)
async def list_child_vocabulary_notebook(
    child_id: UUID,
    response: Response,
    limit: int = Query(default=50, ge=1, le=200),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> VocabularyNotebookListResponse:
    _apply_no_store(response)
    safe_limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 50
    return await KidGlossaryService(db).list_notebook(parent_id, child_id, limit=safe_limit)


@router.post(
    "/children/{child_id}/notebook",
    response_model=FavoriteWordRead,
    status_code=status.HTTP_201_CREATED,
)
async def save_word_to_child_notebook(
    child_id: UUID,
    payload: FavoriteWordCreateRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> FavoriteWordRead:
    _apply_no_store(response)
    item, created = await KidGlossaryService(db).save_to_notebook(parent_id, child_id, payload)
    if not created:
        response.status_code = status.HTTP_200_OK
    return item


@router.delete(
    "/children/{child_id}/notebook/{item_id}",
    response_model=FavoriteWordDeleteResponse,
    status_code=status.HTTP_200_OK,
)
async def delete_word_from_child_notebook(
    child_id: UUID,
    item_id: UUID,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> FavoriteWordDeleteResponse:
    _apply_no_store(response)
    return await KidGlossaryService(db).delete_from_notebook(parent_id, child_id, item_id)
