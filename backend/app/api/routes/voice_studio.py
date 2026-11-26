"""Authenticated endpoints for 3-region voice selection and word-timed sample reading."""

from __future__ import annotations

import asyncio
import base64
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_active_profile_id
from app.api.routes.voice import (
    _accepts_db_kwarg,
    _extract_audio_accept,
    _tts_cache_headers,
    get_voice_orchestrator,
    provider_http_exception,
)
from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.local_voice_provider import (
    DEFAULT_LOCAL_VOICE_ID,
    STATIC_LOCAL_VOICES,
)
from app.schemas.voice_studio import (
    TimedSpeechRead,
    TimedSpeechRequest,
    TimedWordRead,
    VoiceInfoRead,
    VoiceListRead,
    VoiceProviderMode,
)
from app.services.rate_limiter import rate_limit
from app.services.tts_audio_cache_service import TtsAudioCacheService
from app.services.voice_orchestrator import VoicePolicyContext

router = APIRouter()


def clear_cached_public_voice_ids_cache() -> None:
    """Clear the in-memory cache of precomputed public TTS voice IDs."""
    TtsAudioCacheService.clear_cached_public_voice_ids_cache()


async def refresh_cached_public_voice_ids(*, timeout: float = 6.0) -> list[str]:
    """Query active CATALOG/COACHING voice IDs via TtsAudioCacheService."""
    return await TtsAudioCacheService.refresh_cached_public_voice_ids(timeout=timeout)


async def _get_cached_public_voice_ids() -> list[str]:
    """Return cached public TTS voice IDs via TtsAudioCacheService."""
    return await TtsAudioCacheService.get_cached_public_voice_ids()


@router.get("/voices", response_model=VoiceListRead)
async def list_voices(
    response: Response,
    provider_mode: VoiceProviderMode = Query(default="local_only"),
    allow_google_tts: bool = Query(default=False),
    _actor_id: UUID = Depends(require_active_profile_id),
    _rate_limited: None = Depends(
        rate_limit("voice_status", default_max=120, default_window=60.0, actor_dependency=require_active_profile_id)
    ),
) -> VoiceListRead:
    """List curated Bắc · Trung · Nam local voices (plus Google backup voices when enabled)."""

    response.headers["Cache-Control"] = "no-store"

    policy = VoicePolicyContext(
        provider_mode=provider_mode,
        allow_google_tts=allow_google_tts,
    )
    orchestrator = get_voice_orchestrator()
    try:
        listing = await asyncio.wait_for(
            orchestrator.list_voices(policy=policy),
            timeout=2.5,
        )
    except asyncio.TimeoutError:
        voices: list[dict[str, Any]] = [dict(v) for v in STATIC_LOCAL_VOICES]
        google_tts_available = bool(
            getattr(
                getattr(orchestrator, "google", None),
                "is_tts_configured",
                lambda: False,
            )()
        )
        if (
            policy.provider_mode == "local_with_google_fallback"
            and policy.allow_google_tts
            and google_tts_available
        ):
            voices.extend(orchestrator.google.list_backup_voices())
        listing = {
            "voices": voices,
            "default_voice_id": DEFAULT_LOCAL_VOICE_ID,
            "local_worker_ready": False,
            "google_tts_available": google_tts_available,
        }
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    local_worker_ready = bool(listing["local_worker_ready"])
    cached_voice_ids = (
        list(listing["cached_voice_ids"])
        if "cached_voice_ids" in listing and listing["cached_voice_ids"] is not None
        else ([] if local_worker_ready else await _get_cached_public_voice_ids())
    )

    return VoiceListRead(
        voices=[VoiceInfoRead(**voice) for voice in listing["voices"]],
        default_voice_id=listing["default_voice_id"],
        local_worker_ready=local_worker_ready,
        google_tts_available=bool(listing["google_tts_available"]),
        cached_voice_ids=cached_voice_ids,
    )


@router.post("/text-to-speech/timed", response_model=TimedSpeechRead)
async def timed_text_to_speech(
    payload: TimedSpeechRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(require_active_profile_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("voice_tts", default_max=60, default_window=60.0, actor_dependency=require_active_profile_id)
    ),
) -> TimedSpeechRead:
    """Synthesize a page in the locked voice and return per-word start/end times."""

    policy = VoicePolicyContext(
        provider_mode=payload.provider_mode,
        allow_google_tts=payload.allow_google_tts,
        session_id=payload.session_id,
        page_id=str(payload.page_id) if payload.page_id is not None else None,
        accept=_extract_audio_accept(request),
        audio_format=payload.audio_format,
        actor_id=actor_id,
        book_id=payload.book_id,
        page_revision_id=payload.page_revision_id,
        cache_scope=payload.cache_scope,
    )
    orchestrator = get_voice_orchestrator()
    timed_kwargs: dict[str, Any] = {
        "words": payload.words,
        "requested_voice_id": payload.voice_id,
        "speed": payload.speed,
        "policy": policy,
    }
    if _accepts_db_kwarg(orchestrator.synthesize_timed):
        timed_kwargs["db"] = db
    try:
        speech = await orchestrator.synthesize_timed(**timed_kwargs)
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    for h_name, h_val in _tts_cache_headers(speech).items():
        response.headers[h_name] = h_val

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
        cached_speed=getattr(speech, "cached_speed", None),
    )
