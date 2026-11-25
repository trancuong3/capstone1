"""Authenticated endpoints for 3-region voice selection and word-timed sample reading."""

from __future__ import annotations

import base64
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.deps import require_active_profile_id
from app.api.routes.voice import _extract_audio_accept, get_voice_orchestrator, provider_http_exception
from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.schemas.voice_studio import (
    TimedSpeechRead,
    TimedSpeechRequest,
    TimedWordRead,
    VoiceInfoRead,
    VoiceListRead,
    VoiceProviderMode,
)
from app.services.rate_limiter import rate_limit
from app.services.voice_orchestrator import VoicePolicyContext

router = APIRouter()


@router.get("/voices", response_model=VoiceListRead)
async def list_voices(
    response: Response,
    provider_mode: VoiceProviderMode = Query(default="local_only"),
    allow_google_tts: bool = Query(default=False),
    _actor_id: UUID = Depends(require_active_profile_id),
    _rate_limited: None = Depends(
        rate_limit("voice_status", default_max=120, default_window=60.0)
    ),
) -> VoiceListRead:
    """List curated Bắc · Trung · Nam local voices (plus Google backup voices when enabled)."""

    response.headers["Cache-Control"] = "no-store"

    policy = VoicePolicyContext(
        provider_mode=provider_mode,
        allow_google_tts=allow_google_tts,
    )
    try:
        listing = await get_voice_orchestrator().list_voices(policy=policy)
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    return VoiceListRead(
        voices=[VoiceInfoRead(**voice) for voice in listing["voices"]],
        default_voice_id=listing["default_voice_id"],
        local_worker_ready=bool(listing["local_worker_ready"]),
        google_tts_available=bool(listing["google_tts_available"]),
    )


@router.post("/text-to-speech/timed", response_model=TimedSpeechRead)
async def timed_text_to_speech(
    payload: TimedSpeechRequest,
    request: Request,
    response: Response,
    _actor_id: UUID = Depends(require_active_profile_id),
    _rate_limited: None = Depends(
        rate_limit("voice_tts", default_max=60, default_window=60.0)
    ),
) -> TimedSpeechRead:
    """Synthesize a page in the locked voice and return per-word start/end times."""

    response.headers["Cache-Control"] = "no-store"

    policy = VoicePolicyContext(
        provider_mode=payload.provider_mode,
        allow_google_tts=payload.allow_google_tts,
        session_id=payload.session_id,
        accept=_extract_audio_accept(request),
        audio_format=payload.audio_format,
    )
    try:
        speech = await get_voice_orchestrator().synthesize_timed(
            words=payload.words,
            requested_voice_id=payload.voice_id,
            speed=payload.speed,
            policy=policy,
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
        provider=speech.provider,
        resolved_voice_id=speech.resolved_voice_id,
        region=speech.region,
        model_version=speech.model_version,
        used_fallback_voice=speech.used_fallback_voice,
    )
