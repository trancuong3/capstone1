"""Admin Karaoke One-File Simple Mode & Background Pipeline Bridge HTTP endpoints (mounted under /karaoke)."""
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.api.deps import get_db, require_admin_id
from app.repositories.karaoke_repository import ConcurrentKaraokeUpdate, KaraokeRepository
from app.schemas.karaoke import AdminDetail
from app.schemas.karaoke_simple_import import (
    AudioType,
    SimpleImportResult,
    SimpleProcessingApplyRequest,
    SimpleProcessingStartRequest,
    SimpleProcessingStatusRead,
    SimplePublishRequest,
)
from app.services.karaoke_simple_import_service import KaraokeSimpleImportService

router = APIRouter()


async def get_karaoke_simple_import_service(db=Depends(get_db)):
    try:
        yield KaraokeSimpleImportService(KaraokeRepository(db))
    except (IntegrityError, ConcurrentKaraokeUpdate):
        await db.rollback()
        raise HTTPException(409, "Karaoke data changed; reload and try again") from None
    except (SQLAlchemyError, ValidationError, ValueError):
        await db.rollback()
        raise HTTPException(503, "Karaoke data is temporarily unavailable") from None


@router.post("/admin/songs/simple-import", response_model=SimpleImportResult, status_code=201)
async def simple_import_song(
    audio: UploadFile = File(...),
    title: str | None = Form(default=None),
    author: str | None = Form(default=None),
    min_grade: int = Form(default=1, ge=1, le=5),
    max_grade: int = Form(default=5, ge=1, le=5),
    lyrics_text: str | None = Form(default=None),
    audio_type: AudioType = Form(default="UNKNOWN"),
    bpm: float | None = Form(default=None),
    auto_transcribe: bool = Form(default=True),
    enable_background_processing: bool = Form(default=True),
    source_note: str | None = Form(default=None),
    usage_note: str | None = Form(default=None),
    rights_confirmed: bool = Form(default=False),
    child_safe_confirmed: bool = Form(default=False),
    actor_id: UUID = Depends(require_admin_id),
    service: KaraokeSimpleImportService = Depends(get_karaoke_simple_import_service),
):
    resolved_title = title if isinstance(title, str) else None
    resolved_author = author if isinstance(author, str) else None
    resolved_min_grade = (
        min_grade if isinstance(min_grade, int) and not isinstance(min_grade, bool) else 1
    )
    resolved_max_grade = (
        max_grade if isinstance(max_grade, int) and not isinstance(max_grade, bool) else 5
    )
    resolved_lyrics_text = lyrics_text if isinstance(lyrics_text, str) else None
    resolved_audio_type: AudioType = (
        audio_type
        if isinstance(audio_type, str)
        and audio_type in ("VOCAL_FULL", "INSTRUMENTAL_ONLY", "DUAL_TRACK", "UNKNOWN")
        else "UNKNOWN"
    )
    resolved_bpm = (
        float(bpm) if isinstance(bpm, (int, float)) and not isinstance(bpm, bool) else None
    )
    resolved_auto_transcribe = auto_transcribe if isinstance(auto_transcribe, bool) else True
    resolved_enable_bg = (
        enable_background_processing
        if isinstance(enable_background_processing, bool)
        else True
    )
    resolved_source_note = source_note if isinstance(source_note, str) else None
    resolved_usage_note = usage_note if isinstance(usage_note, str) else None
    resolved_rights_confirmed = rights_confirmed if isinstance(rights_confirmed, bool) else False
    resolved_child_safe_confirmed = (
        child_safe_confirmed if isinstance(child_safe_confirmed, bool) else False
    )
    return await service.simple_import(
        actor_id,
        audio=audio,
        title=resolved_title,
        author=resolved_author,
        min_grade=resolved_min_grade,
        max_grade=resolved_max_grade,
        lyrics_text=resolved_lyrics_text,
        audio_type=resolved_audio_type,
        bpm=resolved_bpm,
        auto_transcribe=resolved_auto_transcribe,
        enable_background_processing=resolved_enable_bg,
        source_note=resolved_source_note,
        usage_note=resolved_usage_note,
        rights_confirmed=resolved_rights_confirmed,
        child_safe_confirmed=resolved_child_safe_confirmed,
    )


@router.post(
    "/admin/songs/{song_id}/simple-processing",
    response_model=SimpleProcessingStatusRead,
    status_code=202,
)
async def start_simple_processing(
    song_id: UUID,
    payload: SimpleProcessingStartRequest,
    response: Response,
    actor_id: UUID = Depends(require_admin_id),
    service: KaraokeSimpleImportService = Depends(get_karaoke_simple_import_service),
):
    result = await service.start_simple_processing(actor_id, song_id, payload)
    if getattr(service, "processing_replayed", False):
        response.status_code = 200
    return result


@router.get(
    "/admin/songs/{song_id}/simple-processing",
    response_model=SimpleProcessingStatusRead,
)
async def get_simple_processing_status(
    song_id: UUID,
    actor_id: UUID = Depends(require_admin_id),
    service: KaraokeSimpleImportService = Depends(get_karaoke_simple_import_service),
):
    return await service.get_simple_processing_status(actor_id, song_id)


@router.post(
    "/admin/songs/{song_id}/simple-processing/apply",
    response_model=SimpleProcessingStatusRead,
)
async def apply_simple_processing(
    song_id: UUID,
    payload: SimpleProcessingApplyRequest,
    actor_id: UUID = Depends(require_admin_id),
    service: KaraokeSimpleImportService = Depends(get_karaoke_simple_import_service),
):
    return await service.apply_simple_processing(actor_id, song_id, payload)


@router.post("/admin/songs/{song_id}/simple-publish", response_model=AdminDetail)
async def simple_publish_song(
    song_id: UUID,
    payload: SimplePublishRequest,
    actor_id: UUID = Depends(require_admin_id),
    service: KaraokeSimpleImportService = Depends(get_karaoke_simple_import_service),
):
    return await service.simple_publish(actor_id, song_id, payload)
