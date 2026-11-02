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
AUDIO_MIME_BY_EXTENSION = {
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
}
AUDIO_MIME_ALIASES = {"audio/x-wav": "audio/wav"}


def provider_http_exception(error: VoiceProviderError) -> HTTPException:
    """Never expose vendor responses, quota details, or server configuration."""

    return HTTPException(
        status_code=error.status_code,
        detail={
            "code": "INVALID_AUDIO" if error.status_code == 422 else "SPEECH_UNAVAILABLE"
        },
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
    extension = "." + filename.rsplit(".", 1)[-1] if "." in filename else ""
    inferred_mime_type = AUDIO_MIME_BY_EXTENSION.get(extension)
    declared_mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    declared_mime_type = AUDIO_MIME_ALIASES.get(
        declared_mime_type, declared_mime_type
    )

    if declared_mime_type in ("", "application/octet-stream"):
        # Infer only from a recognized filename extension. Never guess WebM.
        resolved_mime_type = inferred_mime_type
    else:
        resolved_mime_type = declared_mime_type
        if resolved_mime_type not in AUDIO_MIME_BY_EXTENSION.values():
            resolved_mime_type = None
        elif inferred_mime_type and inferred_mime_type != resolved_mime_type:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail={"code": "AUDIO_FORMAT_MISMATCH"},
            )

    if resolved_mime_type is None:
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

    # Preserve a recognized provider-compatible MIME type. Only use the
    # extension-derived value when the browser supplied no useful type.
    content_type = file.content_type
    if not content_type or content_type.split(";", 1)[0].strip().lower() in (
        "application/octet-stream",
        "",
    ):
        content_type = resolved_mime_type

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
        words=transcription.words,
    )
