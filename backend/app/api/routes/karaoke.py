"""HTTP karaoke endpoints; SQL and publication rules live in lower layers."""
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.api.deps import get_current_parent_id, get_db
from app.diagnostic_logging import log_diagnostic
from app.repositories.karaoke_repository import ConcurrentKaraokeUpdate, KaraokeRepository
from app.schemas.karaoke import (
    AdminDetail, AdminList, DraftPreview, DraftRequest, DraftWrite, MelodyExtractResponse,
    Playback, RevisionRequest, SongCreate, SongList, ValidationRead, VisibilityRequest,
)
from app.services.karaoke_service import KaraokeService

logger = logging.getLogger(__name__)
router = APIRouter()


async def get_karaoke_service(db=Depends(get_db)):
    try:
        yield KaraokeService(KaraokeRepository(db))
    except (IntegrityError, ConcurrentKaraokeUpdate):
        await db.rollback()
        raise HTTPException(409, "Karaoke data changed; reload and try again") from None
    except (ValidationError, ValueError) as exc:
        log_diagnostic(
            logger,
            logging.ERROR,
            event="karaoke_validation_or_value_error",
            stage="service_response",
            exception=exc,
        )
        await db.rollback()
        raise HTTPException(503, "Karaoke data is temporarily unavailable") from None
    except SQLAlchemyError as exc:
        log_diagnostic(
            logger,
            logging.ERROR,
            event="karaoke_database_error",
            stage="database",
            exception=exc,
        )
        await db.rollback()
        raise HTTPException(503, "Karaoke data is temporarily unavailable") from None


@router.get("/admin/songs", response_model=AdminList)
async def admin_songs(
    search: str = Query(default="", max_length=120),
    status: Literal["DRAFT", "PUBLISHED", "HIDDEN"] | None = None,
    limit: int = Query(default=12, ge=1, le=50), offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id), service=Depends(get_karaoke_service),
):
    return await service.admin_list(actor_id, search=search, status=status, limit=limit, offset=offset)


@router.post("/admin/songs", response_model=AdminDetail, status_code=201)
async def create_song(
    payload: SongCreate, response: Response, actor_id: UUID = Depends(get_current_parent_id),
    service=Depends(get_karaoke_service),
):
    result = await service.create(actor_id, payload)
    if getattr(service, "creation_replayed", False):
        response.status_code = 200
    return result


@router.get("/admin/songs/{song_id}", response_model=AdminDetail)
async def admin_song(song_id: UUID, actor_id: UUID = Depends(get_current_parent_id),
                     service=Depends(get_karaoke_service)):
    return await service.detail(actor_id, song_id)


@router.post("/admin/songs/{song_id}/draft", response_model=AdminDetail)
async def create_draft(song_id: UUID, payload: RevisionRequest,
                       actor_id: UUID = Depends(get_current_parent_id), service=Depends(get_karaoke_service)):
    return await service.draft(actor_id, song_id, payload)


@router.put("/admin/songs/{song_id}/draft", response_model=AdminDetail)
async def save_draft(song_id: UUID, payload: DraftWrite,
                     actor_id: UUID = Depends(get_current_parent_id), service=Depends(get_karaoke_service)):
    return await service.save(actor_id, song_id, payload)


@router.post("/admin/songs/{song_id}/draft/audio", response_model=AdminDetail)
async def upload_audio(
    song_id: UUID, file: UploadFile = File(...), expected_revision: int = Form(..., ge=1),
    draft_version_id: UUID = Form(...), actor_id: UUID = Depends(get_current_parent_id),
    service=Depends(get_karaoke_service),
):
    return await service.upload(actor_id, song_id, DraftRequest(
        expected_revision=expected_revision, draft_version_id=draft_version_id,
    ), file)


@router.post("/admin/songs/{song_id}/draft/cover", response_model=AdminDetail)
async def upload_cover(
    song_id: UUID, file: UploadFile = File(...), expected_revision: int = Form(..., ge=1),
    draft_version_id: UUID = Form(...), actor_id: UUID = Depends(get_current_parent_id),
    service=Depends(get_karaoke_service),
):
    return await service.upload(actor_id, song_id, DraftRequest(
        expected_revision=expected_revision, draft_version_id=draft_version_id,
    ), file, cover=True)


@router.get("/admin/songs/{song_id}/draft/validation", response_model=ValidationRead)
async def validate_draft(song_id: UUID, actor_id: UUID = Depends(get_current_parent_id),
                         service=Depends(get_karaoke_service)):
    return await service.validation(actor_id, song_id)


@router.post("/admin/songs/{song_id}/draft/reference-audio", response_model=AdminDetail)
async def upload_reference(
    song_id: UUID, file: UploadFile = File(...), expected_revision: int = Form(..., ge=1),
    draft_version_id: UUID = Form(...), actor_id: UUID = Depends(get_current_parent_id),
    service=Depends(get_karaoke_service),
):
    return await service.upload(actor_id, song_id, DraftRequest(
        expected_revision=expected_revision, draft_version_id=draft_version_id,
    ), file, reference=True)


@router.delete("/admin/songs/{song_id}/draft/reference-audio", response_model=AdminDetail)
async def delete_reference(song_id: UUID, payload: DraftRequest,
                           actor_id: UUID = Depends(get_current_parent_id),
                           service=Depends(get_karaoke_service)):
    return await service.delete_reference(actor_id, song_id, payload)


@router.get("/admin/songs/{song_id}/draft/preview", response_model=DraftPreview)
async def preview_draft(song_id: UUID, actor_id: UUID = Depends(get_current_parent_id),
                        service=Depends(get_karaoke_service)):
    return await service.preview(actor_id, song_id)


@router.post("/admin/songs/{song_id}/publish", response_model=AdminDetail)
async def publish_song(song_id: UUID, payload: DraftRequest,
                       actor_id: UUID = Depends(get_current_parent_id), service=Depends(get_karaoke_service)):
    return await service.publish(actor_id, song_id, payload)


@router.patch("/admin/songs/{song_id}/visibility", response_model=AdminDetail)
async def set_visibility(song_id: UUID, payload: VisibilityRequest,
                         actor_id: UUID = Depends(get_current_parent_id), service=Depends(get_karaoke_service)):
    return await service.visibility(actor_id, song_id, payload)


@router.post("/admin/songs/{song_id}/extract-melody", response_model=MelodyExtractResponse)
async def extract_song_melody(
    song_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    service=Depends(get_karaoke_service),
):
    return await service.extract_melody(actor_id, song_id)


@router.get("/songs", response_model=SongList)
async def songs(
    child_id: UUID, search: str = Query(default="", max_length=120),
    limit: int = Query(default=12, ge=1, le=50), offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id), service=Depends(get_karaoke_service),
):
    resolved_search = search if isinstance(search, str) else ""
    resolved_limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 12
    resolved_offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    return await service.catalog(
        actor_id,
        child_id,
        search=resolved_search,
        limit=resolved_limit,
        offset=resolved_offset,
    )


@router.get("/songs/{song_id}/playback", response_model=Playback)
async def playback(song_id: UUID, child_id: UUID, expected_version_id: UUID | None = None,
                    actor_id: UUID = Depends(get_current_parent_id), service=Depends(get_karaoke_service)):
    return await service.playback(actor_id, song_id, child_id, expected_version_id)
