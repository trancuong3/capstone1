"""Authenticated local-first text-to-speech, phonics, status, and speech-to-text endpoints."""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
import os
import time
import unicodedata
from typing import Annotated, Any
from uuid import UUID

import websockets
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    WebSocketException,
    status,
)
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db, require_active_profile_id
from app.database.config import CORS_ALLOWED_ORIGINS
from app.database.role_cache import get_cached_profile_role
from app.database.session import AsyncSessionLocal
from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.google_voice_provider import GOOGLE_VOICE_BY_ID
from app.providers.local_voice_provider import (
    STATIC_LOCAL_VOICES,
    resolve_local_stt_mode,
)
from app.schemas.voice import (
    PhonicsSpeechRead,
    PhonicsSpeechRequest,
    PhonicsStepTimingRead,
    SpeechToTextResponse,
    TextToSpeechRequest,
    VoiceProviderMode,
)
from app.services.rate_limiter import rate_limit
from app.services.voice_orchestrator import VoiceOrchestrator, VoicePolicyContext

logger = logging.getLogger("viread.voice_routes")

router = APIRouter()

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_STT_KEYTERMS = 50
MAX_STT_KEYTERM_CHARS = 80
ALLOWED_AUDIO_PREFIXES = ("audio/", "video/", "application/octet-stream")
ALLOWED_AUDIO_EXTENSIONS = (
    ".webm",
    ".ogg",
    ".oga",
    ".mp3",
    ".wav",
    ".mp4",
    ".m4a",
    ".aac",
    ".flac",
)

_EXTENSION_CONTENT_TYPES = {
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "audio/mp4",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
}


def _resolve_audio_content_type(raw_content_type: str | None, filename: str) -> str:
    if raw_content_type and raw_content_type != "application/octet-stream":
        return raw_content_type
    lower_name = (filename or "").lower()
    for ext, mime in _EXTENSION_CONTENT_TYPES.items():
        if lower_name.endswith(ext):
            return mime
    return "audio/webm"


def _has_valid_audio_magic(audio: bytes) -> bool:
    """Inspect magic bytes for supported audio containers when Content-Type is absent."""
    if not audio or len(audio) < 4:
        return False
    # WAV (RIFF....WAVE)
    if len(audio) >= 12 and audio[:4] == b"RIFF" and audio[8:12] == b"WAVE":
        return True
    # WebM / Matroska EBML header
    if audio[:4] == b"\x1a\x45\xdf\xa3":
        return True
    # Ogg / Opus / Vorbis
    if audio[:4] == b"OggS":
        return True
    # FLAC
    if audio[:4] == b"fLaC":
        return True
    # MP3 with ID3 tag or MPEG / ADTS frame sync (0xFFE0 mask)
    if audio[:3] == b"ID3":
        return True
    if audio[0] == 0xFF and (audio[1] & 0xE0) == 0xE0:
        return True
    # MP4 / M4A ISO Base Media (`....ftyp`)
    if len(audio) >= 12 and audio[4:8] == b"ftyp":
        return True
    return False


_DEFAULT_ORCHESTRATORS: dict[tuple[str, str, str, str], VoiceOrchestrator] = {}


def clear_default_voice_orchestrators() -> None:
    """Reset pooled VoiceOrchestrator instances (used by tests)."""
    _DEFAULT_ORCHESTRATORS.clear()


async def close_default_voice_orchestrators() -> None:
    """Close and clear all cached VoiceOrchestrator HTTP pools on lifespan shutdown."""
    cached = list(_DEFAULT_ORCHESTRATORS.values())
    _DEFAULT_ORCHESTRATORS.clear()
    for orch in cached:
        aclose = getattr(orch, "aclose", None)
        if callable(aclose):
            try:
                await aclose()
            except Exception:
                pass


def get_voice_orchestrator() -> VoiceOrchestrator:
    worker_url = (
        os.getenv("VIREAD_LOCAL_VOICE_WORKER_URL") or "http://127.0.0.1:8010"
    ).strip().rstrip("/") or "http://127.0.0.1:8010"
    worker_token = (
        os.getenv("VIREAD_VOICE_WORKER_TOKEN")
        or os.getenv("VIREAD_LOCAL_VOICE_WORKER_TOKEN")
        or ""
    ).strip()
    render_flag = (os.getenv("RENDER") or "").strip()
    app_env = (os.getenv("APP_ENVIRONMENT") or "").strip().lower()
    key = (worker_url, worker_token, render_flag, app_env)
    cached = _DEFAULT_ORCHESTRATORS.get(key)
    if cached is None:
        cached = VoiceOrchestrator()
        _DEFAULT_ORCHESTRATORS[key] = cached
    return cached


def provider_http_exception(error: VoiceProviderError) -> HTTPException:
    """Never expose vendor responses, quota details, or server configuration."""

    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code},
    )


def _parse_provider_mode(raw: str | None) -> VoiceProviderMode:
    if raw and raw.strip() == "local_with_google_fallback":
        return "local_with_google_fallback"
    return "local_only"


def _parse_bool_form(raw: str | bool | None) -> bool:
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _validate_stt_keyterms(keyterms: list[str] | None) -> list[str] | None:
    """Validate bounded NFC-normalized STT keyterms."""
    if keyterms is None:
        return None
    if len(keyterms) > MAX_STT_KEYTERMS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "TOO_MANY_KEYTERMS"},
        )
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in keyterms:
        term = unicodedata.normalize("NFC", raw).strip()
        if not term:
            continue
        if len(term) > MAX_STT_KEYTERM_CHARS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "KEYTERM_TOO_LONG"},
            )
        if term not in seen:
            seen.add(term)
            normalized.append(term)
    return normalized or None


def _extract_audio_accept(request: Request) -> str | None:
    raw = (request.headers.get("accept") or "").strip()
    if not raw or raw == "*/*":
        return None
    lower = raw.lower()
    if any(token in lower for token in ("audio/mpeg", "audio/mp3", "audio/ogg", "audio/opus", "audio/wav")):
        return raw[:120]
    return None


def _accepts_db_kwarg(fn: Any) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return "db" in params or any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
    )


def _tts_cache_headers(speech_or_audio: Any) -> dict[str, str]:
    cache_hit = bool(getattr(speech_or_audio, "cache_hit", False))
    cache_scope = getattr(speech_or_audio, "cache_scope", None)
    cached_speed = getattr(speech_or_audio, "cached_speed", None)
    if cache_hit:
        cache_control = "private, no-store" if cache_scope == "PRIVATE" else "private, max-age=86400"
    else:
        cache_control = "no-store"
    headers = {
        "Cache-Control": cache_control,
        "X-TTS-Cache": "HIT" if cache_hit else "MISS",
        "X-TTS-Provider": str(getattr(speech_or_audio, "provider", "local")),
    }
    if cache_scope:
        headers["X-TTS-Scope"] = str(cache_scope)
    if cached_speed is not None:
        headers["X-TTS-Cached-Speed"] = f"{float(cached_speed):.2f}"
    return headers


@router.get("/status")
async def voice_status(
    response: Response,
    _actor_id: UUID = Depends(require_active_profile_id),
    _rate_limited: None = Depends(rate_limit("voice_status", default_max=120, default_window=60.0, actor_dependency=require_active_profile_id)),
) -> dict[str, Any]:
    """Report safe local worker & Google backup readiness without secrets."""

    response.headers["Cache-Control"] = "no-store"
    return await get_voice_orchestrator().get_status()


@router.post("/text-to-speech", response_class=Response)
async def text_to_speech(
    payload: TextToSpeechRequest,
    request: Request,
    actor_id: UUID = Depends(require_active_profile_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("voice_tts", default_max=60, default_window=60.0, actor_dependency=require_active_profile_id)
    ),
) -> Response:
    """Synthesize a short utterance strictly using the requested locked voice."""

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
    synth_kwargs: dict[str, Any] = {
        "text": payload.text,
        "requested_voice_id": payload.voice_id,
        "speed": payload.speed,
        "word_sample": payload.word_sample,
        "policy": policy,
    }
    if _accepts_db_kwarg(orchestrator.synthesize):
        synth_kwargs["db"] = db
    try:
        audio = await orchestrator.synthesize(**synth_kwargs)
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    voice_gender = "female"
    for item in STATIC_LOCAL_VOICES:
        if item.get("voice_id") == audio.resolved_voice_id:
            voice_gender = str(item.get("gender") or "female")
            break
    else:
        g_meta = GOOGLE_VOICE_BY_ID.get(audio.resolved_voice_id)
        if g_meta is not None:
            voice_gender = str(g_meta.get("gender") or "female")

    cache_headers = _tts_cache_headers(audio)
    headers = {
        **cache_headers,
        "X-Voice-Provider": audio.provider,
        "X-Resolved-Voice-Id": audio.resolved_voice_id,
        "X-Voice-Region": audio.region,
        "X-Voice-Gender": voice_gender,
        "X-Voice-Model-Version": audio.model_version,
        "X-Voice-Fallback": "1" if audio.used_fallback_voice else "0",
    }
    fallback_reason = getattr(audio, "fallback_reason", None)
    if audio.used_fallback_voice and fallback_reason:
        headers["X-Voice-Fallback-Reason"] = str(fallback_reason)
    return Response(
        content=audio.content,
        media_type=audio.content_type,
        headers=headers,
    )


@router.post("/text-to-speech/phonics", response_model=PhonicsSpeechRead)
async def phonics_text_to_speech(
    payload: PhonicsSpeechRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(require_active_profile_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("voice_tts", default_max=60, default_window=60.0, actor_dependency=require_active_profile_id)
    ),
) -> PhonicsSpeechRead:
    """Synthesize step-by-step Vietnamese phonics with sample-accurate step timings."""

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
    phonics_kwargs: dict[str, Any] = {
        "steps": [
            {
                "id": s.id,
                "spoken_text": s.spoken_text,
                "pause_after_ms": s.pause_after_ms,
            }
            for s in payload.steps
        ],
        "requested_voice_id": payload.voice_id,
        "speed": payload.speed,
        "policy": policy,
    }
    if _accepts_db_kwarg(orchestrator.synthesize_phonics):
        phonics_kwargs["db"] = db
    try:
        speech = await orchestrator.synthesize_phonics(**phonics_kwargs)
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    for h_name, h_val in _tts_cache_headers(speech).items():
        response.headers[h_name] = h_val
    fallback_reason = getattr(speech, "fallback_reason", None)
    if getattr(speech, "used_fallback_voice", False) and fallback_reason:
        response.headers["X-Voice-Fallback-Reason"] = str(fallback_reason)

    return PhonicsSpeechRead(
        audio_base64=base64.b64encode(speech.audio).decode("ascii"),
        content_type=speech.content_type,
        duration_seconds=speech.duration_seconds,
        step_timings=[
            PhonicsStepTimingRead(
                id=item.id,
                index=item.index,
                start=item.start,
                end=item.end,
            )
            for item in speech.step_timings
        ],
        provider=speech.provider,
        resolved_voice_id=speech.resolved_voice_id,
        region=speech.region,
        model_version=speech.model_version,
        cached_speed=getattr(speech, "cached_speed", None),
    )


@router.post("/speech-to-text", response_model=SpeechToTextResponse)
async def speech_to_text(
    response: Response,
    file: Annotated[UploadFile, File(description="Audio recording to transcribe")],
    language_code: Annotated[str | None, Form(max_length=8)] = None,
    keyterms: Annotated[list[str] | None, Form()] = None,
    provider_mode: Annotated[str | None, Form(max_length=40)] = None,
    allow_google_stt: Annotated[str | None, Form(max_length=16)] = None,
    session_id: Annotated[str | None, Form(max_length=80)] = None,
    page_id: Annotated[str | None, Form(max_length=80)] = None,
    turn_id: Annotated[str | None, Form(max_length=80)] = None,
    source: Annotated[str | None, Form(max_length=40)] = None,
    actor_id: UUID = Depends(require_active_profile_id),
    _rate_limited: None = Depends(
        rate_limit("voice_stt", default_max=60, default_window=60.0, actor_dependency=require_active_profile_id)
    ),
) -> SpeechToTextResponse:
    """Transcribe an uploaded recording local-first without persisting child audio."""

    validated_keyterms = _validate_stt_keyterms(keyterms)

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
    if not file.content_type and not _has_valid_audio_magic(audio):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail={"code": "UNSUPPORTED_AUDIO"},
        )

    content_type = _resolve_audio_content_type(file.content_type, filename)

    policy = VoicePolicyContext(
        provider_mode=_parse_provider_mode(provider_mode),
        allow_google_stt=_parse_bool_form(allow_google_stt),
        session_id=session_id,
        page_id=page_id,
        turn_id=turn_id,
        source=source,
    )

    try:
        transcription = await get_voice_orchestrator().transcribe(
            audio=audio,
            filename=file.filename or "recording.webm",
            content_type=content_type,
            language_code=language_code,
            keyterms=validated_keyterms,
            actor_id=actor_id,
            policy=policy,
        )
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

    response.headers["X-Voice-Provider"] = transcription.provider
    response.headers["X-Voice-Model-Version"] = transcription.model_version
    response.headers["X-Voice-Fallback"] = (
        "1" if transcription.fallback_used else "0"
    )
    if transcription.fallback_reason:
        response.headers["X-Voice-Fallback-Reason"] = transcription.fallback_reason

    return SpeechToTextResponse(
        text=transcription.text,
        language_code=transcription.language_code,
        language_probability=transcription.language_probability,
        words=transcription.words,
    )


def _extract_ws_handshake_auth(websocket: WebSocket) -> tuple[str | None, str | None]:
    """Extract Bearer token and accepted subprotocol from WebSocket handshake headers."""
    auth_header = (websocket.headers.get("authorization") or "").strip()
    token: str | None = None
    if auth_header.lower().startswith("bearer "):
        candidate = auth_header[7:].strip()
        if candidate:
            token = candidate

    accepted_subprotocol: str | None = None
    raw_protocols = websocket.headers.get("sec-websocket-protocol") or ""
    for item in raw_protocols.split(","):
        proto = item.strip()
        if not proto:
            continue
        if proto == "viread-stt-v1":
            accepted_subprotocol = "viread-stt-v1"

    return token, accepted_subprotocol


async def _verify_ws_active_profile(actor_id: UUID) -> UUID:
    """Verify the authenticated WebSocket user maps to an active profile."""
    async with AsyncSessionLocal() as db:
        role = await get_cached_profile_role(db, actor_id)
    if role not in ("parent", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )
    return actor_id


async def _verify_ws_parent_id(
    websocket: WebSocket,
    *,
    token: str | None,
) -> UUID:
    override = websocket.app.dependency_overrides.get(
        require_active_profile_id
    ) or websocket.app.dependency_overrides.get(get_current_parent_id)
    if override is not None:
        result = override()
        if inspect.isawaitable(result):
            result = await result
        return result

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    actor_id = await asyncio.to_thread(get_current_parent_id, credentials)
    return await _verify_ws_active_profile(actor_id)


def open_local_stt_ws(url: str, headers: dict[str, str]):
    """Open an upstream WebSocket connection to the local voice worker."""
    return websockets.connect(
        url,
        additional_headers=headers or None,
        open_timeout=3.0,
        ping_interval=20.0,
        ping_timeout=20.0,
        close_timeout=2.0,
        max_size=4 * 1024 * 1024,
    )


_WS_MAX_TEXT_BYTES = 64 * 1024
_WS_MAX_BINARY_BYTES = 1 * 1024 * 1024
_WS_DEFAULT_MAX_SESSION_SECONDS = 300.0
_WS_DEFAULT_IDLE_TIMEOUT_SECONDS = 60.0


def _ws_max_session_seconds() -> float:
    raw = (os.getenv("VIREAD_STT_WS_MAX_SESSION_SECONDS") or "").strip()
    if raw:
        try:
            return max(1.0, float(raw))
        except ValueError:
            pass
    return _WS_DEFAULT_MAX_SESSION_SECONDS


def _ws_idle_timeout_seconds() -> float:
    raw = (os.getenv("VIREAD_STT_WS_IDLE_TIMEOUT_SECONDS") or "").strip()
    if raw:
        try:
            return max(0.5, float(raw))
        except ValueError:
            pass
    return _WS_DEFAULT_IDLE_TIMEOUT_SECONDS


def _is_ws_origin_allowed(websocket: WebSocket) -> bool:
    """Validate browser Origin header against CORS_ALLOWED_ORIGINS when present."""
    origin = (websocket.headers.get("origin") or "").strip()
    if not origin:
        return True
    return origin in CORS_ALLOWED_ORIGINS


@router.websocket("/stt-stream")
async def speech_to_text_stream(websocket: WebSocket) -> None:
    """Authenticated WebSocket proxy to the local streaming STT worker (zero audio/text logs)."""
    if not _is_ws_origin_allowed(websocket):
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    handshake_token, accepted_subprotocol = _extract_ws_handshake_auth(websocket)
    has_override = (
        require_active_profile_id in websocket.app.dependency_overrides
        or get_current_parent_id in websocket.app.dependency_overrides
    )

    pending_start_payload: dict[str, Any] | None = None
    if has_override or handshake_token is not None:
        try:
            await _verify_ws_parent_id(websocket, token=handshake_token)
        except HTTPException:
            raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION) from None
        await websocket.accept(subprotocol=accepted_subprotocol)
    else:
        await websocket.accept(subprotocol=accepted_subprotocol)
        try:
            raw_first = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
            if len(raw_first.encode("utf-8")) > _WS_MAX_TEXT_BYTES:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "MESSAGE_TOO_LARGE",
                        "message": "WebSocket control message exceeds maximum allowed size.",
                        "retryable": False,
                    }
                )
                await websocket.close(code=1009)
                return
            first_msg = json.loads(raw_first)
        except WebSocketDisconnect:
            return
        except Exception:
            try:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "UNAUTHORIZED",
                        "message": "Authentication required",
                        "retryable": False,
                    }
                )
                await websocket.close(code=4401)
            except Exception:
                pass
            return

        if not isinstance(first_msg, dict):
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "UNAUTHORIZED",
                    "message": "Authentication required",
                    "retryable": False,
                }
            )
            await websocket.close(code=4401)
            return

        raw_tok = first_msg.get("token")
        first_token = raw_tok.strip() if isinstance(raw_tok, str) and raw_tok.strip() else None
        try:
            await _verify_ws_parent_id(websocket, token=first_token)
        except HTTPException:
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "UNAUTHORIZED",
                    "message": "Invalid authentication credentials",
                    "retryable": False,
                }
            )
            await websocket.close(code=4401)
            return

        msg_type = str(first_msg.get("type") or "").strip().lower()
        if msg_type == "start":
            sanitized = {k: v for k, v in first_msg.items() if k != "token"}
            pending_start_payload = sanitized

    if resolve_local_stt_mode() == "http":
        await websocket.send_json(
            {
                "type": "error",
                "code": "STT_WS_DISABLED",
                "message": "Streaming WebSocket STT is disabled by configuration.",
                "retryable": True,
            }
        )
        await websocket.close(code=4503)
        return

    orchestrator = get_voice_orchestrator()
    worker_ws_url = orchestrator.local.get_ws_stt_url()
    worker_headers = orchestrator.local.get_ws_auth_headers()
    max_session_s = _ws_max_session_seconds()
    idle_timeout_s = _ws_idle_timeout_seconds()
    session_deadline = time.monotonic() + max_session_s
    close_code = 1000

    try:
        async with open_local_stt_ws(worker_ws_url, worker_headers) as worker_ws:
            if pending_start_payload is not None:
                await worker_ws.send(json.dumps(pending_start_payload, ensure_ascii=False))

            async def _pump_client_to_worker() -> None:
                nonlocal close_code
                while True:
                    remaining_session = session_deadline - time.monotonic()
                    if remaining_session <= 0:
                        close_code = 4408
                        try:
                            await websocket.send_json(
                                {
                                    "type": "error",
                                    "code": "SESSION_TIMEOUT",
                                    "message": "Streaming session reached maximum allowed duration.",
                                    "retryable": True,
                                }
                            )
                        except Exception:
                            pass
                        try:
                            await worker_ws.send(json.dumps({"type": "stop"}))
                        except Exception:
                            pass
                        break

                    wait_budget = min(idle_timeout_s, remaining_session)
                    try:
                        message = await asyncio.wait_for(
                            websocket.receive(), timeout=wait_budget
                        )
                    except asyncio.TimeoutError:
                        timed_out_session = (session_deadline - time.monotonic()) <= 0
                        close_code = 4408
                        try:
                            await websocket.send_json(
                                {
                                    "type": "error",
                                    "code": "SESSION_TIMEOUT" if timed_out_session else "IDLE_TIMEOUT",
                                    "message": (
                                        "Streaming session reached maximum allowed duration."
                                        if timed_out_session
                                        else "Streaming session closed due to inactivity."
                                    ),
                                    "retryable": True,
                                }
                            )
                        except Exception:
                            pass
                        try:
                            await worker_ws.send(json.dumps({"type": "stop"}))
                        except Exception:
                            pass
                        break

                    msg_type = message.get("type")
                    if msg_type == "websocket.disconnect":
                        try:
                            await worker_ws.send(json.dumps({"type": "stop"}))
                        except Exception:
                            pass
                        break
                    raw_bytes = message.get("bytes")
                    if raw_bytes is not None:
                        if len(raw_bytes) > _WS_MAX_BINARY_BYTES:
                            close_code = 1009
                            try:
                                await websocket.send_json(
                                    {
                                        "type": "error",
                                        "code": "MESSAGE_TOO_LARGE",
                                        "message": "Audio frame exceeds maximum allowed size.",
                                        "retryable": False,
                                    }
                                )
                            except Exception:
                                pass
                            try:
                                await worker_ws.send(json.dumps({"type": "stop"}))
                            except Exception:
                                pass
                            break
                        await worker_ws.send(raw_bytes)
                        continue
                    raw_text = message.get("text")
                    if raw_text is not None:
                        if len(raw_text.encode("utf-8")) > _WS_MAX_TEXT_BYTES:
                            close_code = 1009
                            try:
                                await websocket.send_json(
                                    {
                                        "type": "error",
                                        "code": "MESSAGE_TOO_LARGE",
                                        "message": "Control message exceeds maximum allowed size.",
                                        "retryable": False,
                                    }
                                )
                            except Exception:
                                pass
                            try:
                                await worker_ws.send(json.dumps({"type": "stop"}))
                            except Exception:
                                pass
                            break
                        # Strip any accidental token field before forwarding to local worker.
                        is_stop = False
                        try:
                            parsed = json.loads(raw_text)
                            if isinstance(parsed, dict):
                                if str(parsed.get("type") or "").strip().lower() == "stop":
                                    is_stop = True
                                if "token" in parsed:
                                    parsed = {k: v for k, v in parsed.items() if k != "token"}
                                    raw_text = json.dumps(parsed, ensure_ascii=False)
                        except Exception:
                            pass
                        await worker_ws.send(raw_text)
                        if is_stop:
                            # Stop reading further client messages so worker_task can drain final frames.
                            break

            async def _pump_worker_to_client() -> None:
                async for worker_msg in worker_ws:
                    if isinstance(worker_msg, (bytes, bytearray)):
                        await websocket.send_bytes(bytes(worker_msg))
                    else:
                        await websocket.send_text(str(worker_msg))

            client_task = asyncio.create_task(_pump_client_to_worker())
            worker_task = asyncio.create_task(_pump_worker_to_client())
            try:
                _done, pending = await asyncio.wait(
                    {client_task, worker_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                # Do NOT prematurely cancel worker_task when client finishes sending ("stop"):
                # let worker_task drain the final "final" JSON frame cleanly before closing!
                if client_task in _done and worker_task in pending and close_code == 1000:
                    try:
                        await asyncio.wait_for(worker_task, timeout=4.0)
                    except (asyncio.TimeoutError, WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
                        pass
                    except Exception:
                        pass
                for task in (client_task, worker_task):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(client_task, worker_task, return_exceptions=True)
                for task in (client_task, worker_task):
                    if task.cancelled():
                        continue
                    exc = task.exception()
                    if exc is not None and not isinstance(
                        exc, (WebSocketDisconnect, websockets.exceptions.ConnectionClosed)
                    ):
                        logger.warning(
                            "stt_stream_proxy_error type=%s", type(exc).__name__
                        )
            finally:
                for task in (client_task, worker_task):
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.warning("stt_stream_worker_unavailable type=%s", type(exc).__name__)
        orchestrator.local._schedule_background_recovery()
        try:
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "LOCAL_STT_UNAVAILABLE",
                    "message": "Local voice worker unavailable.",
                    "retryable": True,
                }
            )
            await websocket.close(code=4503)
        except Exception:
            pass
    else:
        try:
            await websocket.close(code=close_code)
        except Exception:
            pass
