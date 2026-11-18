"""Authenticated endpoints for voice selection and word-timed sample reading."""

import base64
import os
from uuid import UUID

from fastapi import APIRouter, Depends

from app.api.deps import get_current_parent_id
from app.api.routes.voice import provider_http_exception
from app.providers.elevenlabs_studio_provider import ElevenLabsStudioProvider
from app.providers.elevenlabs_voice_provider import (
    DEFAULT_VOICE_ID,
    VoiceProviderError,
    is_voice_marked_unavailable,
)
from app.schemas.voice_studio import (
    TimedSpeechRead,
    TimedSpeechRequest,
    TimedWordRead,
    VoiceInfoRead,
    VoiceListRead,
)

router = APIRouter()


@router.get("/voices", response_model=VoiceListRead)
async def list_voices(
    _actor_id: UUID = Depends(get_current_parent_id),
) -> VoiceListRead:
    """List the voices the ElevenLabs account can use (cached for ten minutes)."""

    provider = ElevenLabsStudioProvider()
    try:
        voices = await provider.list_voices()
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None
    configured_default = os.getenv("ELEVENLABS_VOICE_ID", "").strip() or DEFAULT_VOICE_ID
    available_ids = {voice["voice_id"] for voice in voices}
    if (
        is_voice_marked_unavailable(provider._key_fingerprint, configured_default)
        or (voices and configured_default not in available_ids and DEFAULT_VOICE_ID in available_ids)
    ):
        resolved_default = DEFAULT_VOICE_ID
    else:
        resolved_default = configured_default
    return VoiceListRead(
        voices=[VoiceInfoRead(**voice) for voice in voices],
        default_voice_id=resolved_default,
    )


@router.post("/text-to-speech/timed", response_model=TimedSpeechRead)
async def timed_text_to_speech(
    payload: TimedSpeechRequest,
    _actor_id: UUID = Depends(get_current_parent_id),
) -> TimedSpeechRead:
    """Synthesize a page and return exact per-word start/end times in the audio."""

    try:
        speech = await ElevenLabsStudioProvider().synthesize_timed(
            words=payload.words,
            requested_voice_id=payload.voice_id,
            speed=payload.speed,
        )
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None
    return TimedSpeechRead(
        audio_base64=base64.b64encode(speech.audio).decode("ascii"),
        content_type=speech.content_type,
        duration_seconds=speech.duration_seconds,
        words=[
            TimedWordRead(index=word.index, start=word.start, end=word.end)
            for word in speech.words
        ],
        resolved_voice_id=speech.resolved_voice_id,
        used_fallback_voice=speech.used_fallback_voice,
    )
