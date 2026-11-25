"""Admin Karaoke One-File Simple Mode HTTP endpoints (mounted under /karaoke)."""
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.api.deps import get_db, require_admin_id
from app.repositories.karaoke_repository import ConcurrentKaraokeUpdate, KaraokeRepository
from app.schemas.karaoke import AdminDetail
from app.schemas.karaoke_simple_import import (
    AudioType,
    SimpleImportResult,
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
    source_note: str | None = Form(default=None),
    usage_note: str | None = Form(default=None),
    rights_confirmed: bool = Form(default=False),
    child_safe_confirmed: bool = Form(default=False),
    actor_id: UUID = Depends(require_admin_id),
    service: KaraokeSimpleImportService = Depends(get_karaoke_simple_import_service),
):
    return await service.simple_import(
        actor_id,
        audio=audio,
        title=title,
        author=author,
        min_grade=min_grade,
        max_grade=max_grade,
        lyrics_text=lyrics_text,
        audio_type=audio_type,
        bpm=bpm,
        auto_transcribe=auto_transcribe,
        source_note=source_note,
        usage_note=usage_note,
        rights_confirmed=rights_confirmed,
        child_safe_confirmed=child_safe_confirmed,
    )


@router.post("/admin/songs/{song_id}/simple-publish", response_model=AdminDetail)
async def simple_publish_song(
    song_id: UUID,
    payload: SimplePublishRequest,
    actor_id: UUID = Depends(require_admin_id),
    service: KaraokeSimpleImportService = Depends(get_karaoke_simple_import_service),
):
    return await service.simple_publish(actor_id, song_id, payload)
