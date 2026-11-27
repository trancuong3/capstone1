"""Protected HTTP surface for automatic karaoke; never starts an in-process worker."""
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.api.deps import get_current_parent_id, get_db
from app.core.karaoke_processing_config import KaraokeConfigurationError
from app.diagnostic_logging import log_diagnostic
from app.repositories.karaoke_repository import ConcurrentKaraokeUpdate
from app.repositories.karaoke_processing_repository import KaraokeProcessingRepository
from app.schemas.karaoke import AdminDetail, DraftRequest
from app.schemas.karaoke_processing import (
    DraftReferencePreview, JobList, JobRead, ProcessingCancel, ProcessingCapabilities,
    ProcessingPreview, ProcessingReview, ProcessingRetry, ProcessingStart,
)
from app.services.karaoke_processing_service import KaraokeProcessingService

logger = logging.getLogger(__name__)
router = APIRouter()


async def get_processing_service(db=Depends(get_db)):
    try:
        yield KaraokeProcessingService(KaraokeProcessingRepository(db))
    except KaraokeConfigurationError:
        raise HTTPException(503, {"code": "PROVIDER_NOT_CONFIGURED",
                                  "message_key": "PROVIDER_NOT_CONFIGURED"}) from None
    except (IntegrityError, ConcurrentKaraokeUpdate):
        await db.rollback()
        raise HTTPException(409, {"code": "REVISION_CONFLICT",
                                  "message_key": "REVISION_CONFLICT"}) from None
    except (ValidationError, ValueError) as exc:
        log_diagnostic(
            logger,
            logging.ERROR,
            event="karaoke_processing_validation_or_value_error",
            stage="service_response",
            exception=exc,
        )
        await db.rollback()
        raise HTTPException(503, {"code": "PROCESSING_UNAVAILABLE",
                                  "message_key": "PROCESSING_UNAVAILABLE"}) from None
    except SQLAlchemyError as exc:
        log_diagnostic(
            logger,
            logging.ERROR,
            event="karaoke_processing_database_error",
            stage="database",
            exception=exc,
        )
        await db.rollback()
        raise HTTPException(503, {"code": "PROCESSING_UNAVAILABLE",
                                  "message_key": "PROCESSING_UNAVAILABLE"}) from None


@router.get("/admin/processing-capabilities", response_model=ProcessingCapabilities)
async def capabilities(actor: UUID = Depends(get_current_parent_id), service=Depends(get_processing_service)):
    return await service.capabilities(actor)


@router.post("/admin/songs/{song_id}/processing-jobs", response_model=JobRead, status_code=202)
async def start(song_id: UUID, request: ProcessingStart, response: Response,
                actor: UUID = Depends(get_current_parent_id), service=Depends(get_processing_service)):
    result = await service.start(actor, song_id, request)
    if service.replayed:
        response.status_code = 200
    return result


@router.get("/admin/songs/{song_id}/processing-jobs", response_model=JobList)
async def list_jobs(song_id: UUID, limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0),
                    actor: UUID = Depends(get_current_parent_id), service=Depends(get_processing_service)):
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 10
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    return await service.list(actor, song_id, limit=limit, offset=offset)


@router.get("/admin/songs/{song_id}/processing-jobs/{job_id}", response_model=JobRead)
async def get_job(song_id: UUID, job_id: UUID, actor: UUID = Depends(get_current_parent_id),
                  service=Depends(get_processing_service)):
    return await service.get(actor, song_id, job_id)


@router.get("/admin/songs/{song_id}/processing-jobs/{job_id}/preview", response_model=ProcessingPreview)
async def preview(song_id: UUID, job_id: UUID, actor: UUID = Depends(get_current_parent_id),
                  service=Depends(get_processing_service)):
    return await service.preview_result(actor, song_id, job_id)


@router.post("/admin/songs/{song_id}/processing-jobs/{job_id}/cancel", response_model=JobRead)
async def cancel(song_id: UUID, job_id: UUID, request: ProcessingCancel,
                 actor: UUID = Depends(get_current_parent_id), service=Depends(get_processing_service)):
    return await service.cancel(actor, song_id, job_id, request)


@router.post("/admin/songs/{song_id}/processing-jobs/{job_id}/retry", response_model=JobRead, status_code=202)
async def retry(song_id: UUID, job_id: UUID, request: ProcessingRetry, response: Response,
                actor: UUID = Depends(get_current_parent_id), service=Depends(get_processing_service)):
    result = await service.retry(actor, song_id, job_id, request)
    if service.replayed:
        response.status_code = 200
    return result


@router.post("/admin/songs/{song_id}/processing-jobs/{job_id}/apply", response_model=AdminDetail)
async def apply(song_id: UUID, job_id: UUID, request: DraftRequest,
                actor: UUID = Depends(get_current_parent_id), service=Depends(get_processing_service)):
    return await service.apply_result(actor, song_id, job_id, request)


@router.get("/admin/songs/{song_id}/draft/reference-preview", response_model=DraftReferencePreview)
async def reference(song_id: UUID, actor: UUID = Depends(get_current_parent_id),
                    service=Depends(get_processing_service)):
    return await service.preview_reference(actor, song_id)


@router.post("/admin/songs/{song_id}/draft/review", response_model=AdminDetail)
async def review(song_id: UUID, request: ProcessingReview, actor: UUID = Depends(get_current_parent_id),
                 service=Depends(get_processing_service)):
    return await service.confirm_review(actor, song_id, request)
