"""Authenticated local-first text-to-speech, phonics, status, and speech-to-text endpoints."""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
from typing import Annotated, Any
from uuid import UUID

import websockets
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    WebSocketException,
    status,
)
from fastapi.security import HTTPAuthorizationCredentials

from app.api.deps import get_current_parent_id
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
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    VoicePolicyContext,
    _DEFAULT_ORCHESTRATORS,
    clear_default_voice_orchestrators,
    close_default_voice_orchestrators,
    get_voice_orchestrator,
)

logger = logging.getLogger("viread.voice_routes")

router = APIRouter()

MAX_AUDIO_BYTES = 25 * 1024 * 1024
ALLOWED_AUDIO_PREFIXES = ("audio/", "video/", "application/octet-stream")
ALLOWED_AUDIO_EXTENSIONS = (
    ".webm",
    ".ogg",
    ".mp3",
    ".mp4",
    ".wav",
    ".m4a",
    ".aac",
    ".flac",
)


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


@router.get("/status")
async def voice_status(
    _actor_id: UUID = Depends(get_current_parent_id),
) -> dict[str, Any]:
    """Report safe local worker & Google backup readiness without secrets."""

    return await get_voice_orchestrator().get_status()


@router.post("/text-to-speech", response_class=Response)
async def text_to_speech(
    payload: TextToSpeechRequest,
    _actor_id: UUID = Depends(get_current_parent_id),
) -> Response:
    """Synthesize a short utterance strictly using the requested locked voice."""

    policy = VoicePolicyContext(
        provider_mode=payload.provider_mode,
        allow_google_tts=payload.allow_google_tts,
        session_id=payload.session_id,
    )
    try:
        audio = await get_voice_orchestrator().synthesize(
            text=payload.text,
            requested_voice_id=payload.voice_id,
            speed=payload.speed,
            word_sample=payload.word_sample,
            policy=policy,
        )
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

    headers = {
        "Cache-Control": "no-store",
        "X-Voice-Provider": audio.provider,
        "X-Resolved-Voice-Id": audio.resolved_voice_id,
        "X-Voice-Region": audio.region,
        "X-Voice-Gender": voice_gender,
        "X-Voice-Model-Version": audio.model_version,
        "X-Voice-Fallback": "1" if audio.used_fallback_voice else "0",
    }
    return Response(
        content=audio.content,
        media_type=audio.content_type,
        headers=headers,
    )


@router.post("/text-to-speech/phonics", response_model=PhonicsSpeechRead)
async def phonics_text_to_speech(
    payload: PhonicsSpeechRequest,
    _actor_id: UUID = Depends(get_current_parent_id),
) -> PhonicsSpeechRead:
    """Synthesize step-by-step Vietnamese phonics with sample-accurate step timings."""

    policy = VoicePolicyContext(
        provider_mode=payload.provider_mode,
        allow_google_tts=payload.allow_google_tts,
        session_id=payload.session_id,
    )
    try:
        speech = await get_voice_orchestrator().synthesize_phonics(
            steps=[
                {
                    "id": s.id,
                    "spoken_text": s.spoken_text,
                    "pause_after_ms": s.pause_after_ms,
                }
                for s in payload.steps
            ],
            requested_voice_id=payload.voice_id,
            speed=payload.speed,
            policy=policy,
        )
    except VoiceProviderError as error:
        raise provider_http_exception(error) from None

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
    actor_id: UUID = Depends(get_current_parent_id),
) -> SpeechToTextResponse:
    """Transcribe an uploaded recording local-first without persisting child audio."""

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
            keyterms=keyterms,
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
        elif proto.startswith("bearer.") and token is None:
            candidate = proto[len("bearer.") :].strip()
            if candidate:
                token = candidate

    return token, accepted_subprotocol


async def _verify_ws_parent_id(
    websocket: WebSocket,
    *,
    token: str | None,
) -> UUID:
    override = websocket.app.dependency_overrides.get(get_current_parent_id)
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
    return await asyncio.to_thread(get_current_parent_id, credentials)


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


@router.websocket("/stt-stream")
async def speech_to_text_stream(websocket: WebSocket) -> None:
    """Authenticated WebSocket proxy to the local streaming STT worker (zero audio/text logs)."""
    handshake_token, accepted_subprotocol = _extract_ws_handshake_auth(websocket)
    has_override = get_current_parent_id in websocket.app.dependency_overrides

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
            first_msg = json.loads(raw_first)
        except Exception:
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

    try:
        async with open_local_stt_ws(worker_ws_url, worker_headers) as worker_ws:
            if pending_start_payload is not None:
                await worker_ws.send(json.dumps(pending_start_payload, ensure_ascii=False))

            async def _pump_client_to_worker() -> None:
                while True:
                    message = await websocket.receive()
                    msg_type = message.get("type")
                    if msg_type == "websocket.disconnect":
                        try:
                            await worker_ws.send(json.dumps({"type": "stop"}))
                        except Exception:
                            pass
                        break
                    raw_bytes = message.get("bytes")
                    if raw_bytes is not None:
                        await worker_ws.send(raw_bytes)
                        continue
                    raw_text = message.get("text")
                    if raw_text is not None:
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
                if client_task in _done and worker_task in pending:
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
            await websocket.close()
        except Exception:
            pass
