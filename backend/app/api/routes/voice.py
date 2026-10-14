"""Authenticated text-to-speech and file-based speech-to-text endpoints."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response

from app.api.deps import get_current_parent_id
from app.providers.elevenlabs_voice_provider import (
    ElevenLabsVoiceProvider,
    VoiceProviderError,
)
from app.schemas.voice import SpeechToTextResponse, TextToSpeechRequest


router = APIRouter()

MAX_AUDIO_BYTES = 25 * 1024 * 1024
ALLOWED_AUDIO_PREFIXES = ("audio/", "video/", "application/octet-stream")
ALLOWED_AUDIO_EXTENSIONS = (".webm", ".ogg", ".mp3", ".wav", ".m4a", ".aac", ".flac")


def provider_http_exception(error: VoiceProviderError) -> HTTPException:
    """Never expose vendor responses, quota details, or server configuration."""

    return HTTPException(
        status_code=error.status_code,
        detail={"code": "SPEECH_UNAVAILABLE"},
    )


@router.post("/text-to-speech", response_class=Response)
async def text_to_speech(
    payload: TextToSpeechRequest,
    _actor_id: UUID = Depends(get_current_parent_id),
) -> Response:
    """Synthesize a short prompt while keeping the ElevenLabs key server-side."""

    try:
        audio = await ElevenLabsVoiceProvider().synthesize(
            text=payload.text,
            requested_voice_id=payload.voice_id,
        )
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    return Response(
        content=audio.content,
        media_type=audio.content_type,
        headers={"Cache-Control": "no-store"},
    )


@router.post("/speech-to-text", response_model=SpeechToTextResponse)
async def speech_to_text(
    file: Annotated[UploadFile, File(description="Audio recording to transcribe")],
    language_code: Annotated[str | None, Form(max_length=8)] = None,
    _actor_id: UUID = Depends(get_current_parent_id),
) -> SpeechToTextResponse:
    """Transcribe an uploaded recording without persisting the child's audio."""

    filename = (file.filename or "").lower()
    is_valid_prefix = bool(
        file.content_type and file.content_type.startswith(ALLOWED_AUDIO_PREFIXES)
    )
    is_valid_ext = any(filename.endswith(ext) for ext in ALLOWED_AUDIO_EXTENSIONS)

    if file.content_type and not (is_valid_prefix or is_valid_ext):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail={"code": "UNSUPPORTED_AUDIO"},
        )

    try:
        audio = await file.read(MAX_AUDIO_BYTES + 1)
    finally:
        await file.close()

    if not audio:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "EMPTY_AUDIO"},
        )
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "AUDIO_TOO_LARGE"},
        )

    content_type = file.content_type
    if not content_type or content_type == "application/octet-stream":
        content_type = "audio/webm"

    try:
        transcription = await ElevenLabsVoiceProvider().transcribe(
            audio=audio,
            filename=file.filename or "recording.webm",
            content_type=content_type,
            language_code=language_code,
        )
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    return SpeechToTextResponse(
        text=transcription.text,
        language_code=transcription.language_code,
        language_probability=transcription.language_probability,
    )
