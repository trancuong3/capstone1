"""Central Local-First Voice Orchestrator & SessionVoiceLock Policy Engine.

Enforces:
  1. Local-by-default (`local_only`) for both STT and TTS on Windows loopback (`127.0.0.1:8010`).
  2. Controlled Google Cloud fallback (`local_with_google_fallback`) with independent parent
     toggles (`allow_google_stt`, `allow_google_tts`).
  3. STT fallback ONLY on technical local failure (`UNAVAILABLE`, `TIMEOUT`, `BUSY`) at segment
     boundaries — NEVER on quiet audio, child hesitation, or mispronunciation.
  4. Strict "Một buổi, một giọng" (`SessionVoiceLock`): TTS NEVER switches voice, gender,
     region, or provider mid-session.
  5. Safe redacted diagnostics (zero audio bytes, transcripts, or secrets in logs).
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import math
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Literal
from uuid import UUID

from app.providers.elevenlabs_voice_provider import (
    ElevenLabsVoiceProvider,
    VoiceProviderError,
)
from app.providers.google_voice_provider import (
    GOOGLE_TTS_MODEL_VERSION,
    GOOGLE_VOICE_BY_ID,
    GoogleCloudVoiceProvider,
)
from app.providers.local_voice_provider import (
    DEFAULT_LOCAL_VOICE_ID,
    LOCAL_TTS_MODEL_VERSION,
    STATIC_LOCAL_VOICES,
    LocalPhonicsSpeech,
    LocalPhonicsStepTiming,
    LocalSynthesizedAudio,
    LocalTimedSpeech,
    LocalTimedWord,
    LocalTranscription,
    LocalVoiceProvider,
    LocalVoiceTechnicalError,
)
from app.request_context import get_request_id
from app.services.tts_audio_cache_service import (
    ResolvedCacheTarget,
    TtsAudioCacheService,
    canonical_phonics_key,
    canonical_tts_text,
    folded_catalog_tts_text,
    is_tts_cache_enabled,
)

logger = logging.getLogger("viread.voice_orchestrator")

VoiceProviderMode = Literal["local_only", "local_with_google_fallback"]


@dataclass(frozen=True, slots=True)
class VoicePolicyContext:
    provider_mode: VoiceProviderMode = "local_only"
    allow_google_stt: bool = False
    allow_google_tts: bool = False
    session_id: str | None = None
    page_id: str | None = None
    turn_id: str | None = None
    source: str | None = None
    accept: str | None = None
    audio_format: str | None = None
    actor_id: UUID | None = None
    book_id: UUID | None = None
    page_revision_id: UUID | None = None
    cache_scope: str | None = None
    allow_voice_switch: bool = False


_TURN_CACHE_MAX = 512
_TURN_CACHE_TTL_SECONDS = 120.0
_turn_results: "OrderedDict[tuple[str, str, str, str], tuple[float, LocalTranscription]]" = (
    OrderedDict()
)
_turn_inflight: dict[tuple[str, str, str, str], asyncio.Future[LocalTranscription]] = {}

_SESSION_LOCK_MAX = 1024
_SESSION_LOCK_TTL_SECONDS = 4 * 3600.0
_session_voice_locks: "OrderedDict[tuple[str, str], tuple[float, str, str]]" = OrderedDict()
_tts_inflight: dict[tuple[Any, ...], asyncio.Future[Any]] = {}


def clear_voice_orchestrator_caches() -> None:
    _turn_results.clear()
    _turn_inflight.clear()
    _session_voice_locks.clear()
    _tts_inflight.clear()


def _prune_session_voice_locks(now: float) -> None:
    expired = [
        key
        for key, (ts, _, _) in _session_voice_locks.items()
        if now - ts > _SESSION_LOCK_TTL_SECONDS
    ]
    for key in expired:
        _session_voice_locks.pop(key, None)
    while len(_session_voice_locks) > _SESSION_LOCK_MAX:
        _session_voice_locks.popitem(last=False)


def _prune_turn_cache(now: float) -> None:
    expired = [
        key
        for key, (ts, _) in _turn_results.items()
        if now - ts > _TURN_CACHE_TTL_SECONDS
    ]
    for key in expired:
        _turn_results.pop(key, None)
    while len(_turn_results) > _TURN_CACHE_MAX:
        _turn_results.popitem(last=False)


_TRANSIENT_BUSY_CODES = frozenset(
    {
        "VOICE_WORKER_BUSY",
        "LOCAL_VOICE_BUSY",
        "LOCAL_TTS_BUSY",
        "LOCAL_STT_BUSY",
    }
)


async def _call_local_with_busy_retry(call_fn: Any) -> Any:
    """Keep offline fixed voices primary by retrying once on transient BUSY before any online failover."""
    try:
        return await call_fn()
    except LocalVoiceTechnicalError as err:
        if err.code not in _TRANSIENT_BUSY_CODES:
            raise
        await asyncio.sleep(0.45)
        return await call_fn()


def _resolve_local_voice_region_gender(voice_id: str) -> tuple[str, str]:
    region = "north"
    gender = "female"
    for item in STATIC_LOCAL_VOICES:
        if item.get("voice_id") == voice_id:
            region = str(item.get("region") or "north")
            gender = str(item.get("gender") or "female")
            return region, gender
    lower = voice_id.lower()
    if "south" in lower or "nam" in lower:
        region = "south"
    elif "central" in lower or "trung" in lower:
        region = "central"
    if any(
        marker in lower
        for marker in ("thien_minh", "quang_son", "thai_son", "_male")
    ):
        gender = "male"
    return region, gender


def _map_local_voice_to_google_backup(voice_id: str) -> str:
    region, gender = _resolve_local_voice_region_gender(voice_id)
    if region == "south":
        return (
            "google_vi_vn_wavenet_b"
            if gender == "male"
            else "google_vi_vn_wavenet_c"
        )
    return (
        "google_vi_vn_neural2_d"
        if gender == "male"
        else "google_vi_vn_neural2_a"
    )


def _map_local_voice_to_google_backup_with_reason(voice_id: str) -> tuple[str, str]:
    region, _gender = _resolve_local_voice_region_gender(voice_id)
    backup_id = _map_local_voice_to_google_backup(voice_id)
    reason = (
        "central_mapped_to_north_google"
        if region == "central"
        else "local_tts_unavailable"
    )
    return backup_id, reason


class VoiceOrchestrator:
    def __init__(
        self,
        *,
        local_provider: LocalVoiceProvider | None = None,
        google_provider: GoogleCloudVoiceProvider | None = None,
        elevenlabs_provider: ElevenLabsVoiceProvider | None = None,
    ) -> None:
        self.local = local_provider or LocalVoiceProvider()
        self.google = google_provider or GoogleCloudVoiceProvider()
        self.elevenlabs = (
            elevenlabs_provider
            if elevenlabs_provider is not None
            else ElevenLabsVoiceProvider()
        )

    async def aclose(self) -> None:
        aclose_local = getattr(self.local, "aclose", None)
        if callable(aclose_local):
            await aclose_local()
        aclose_google = getattr(self.google, "aclose", None)
        if callable(aclose_google):
            await aclose_google()

    async def get_status(self) -> dict[str, Any]:
        local_health = await self.local.get_health()
        is_configured = (
            bool(local_health["configured"])
            if "configured" in local_health
            else (
                self.local.is_configured()
                if callable(getattr(self.local, "is_configured", None))
                else True
            )
        )
        is_loopback = bool(getattr(self.local, "is_loopback", True))
        mode = (
            "unconfigured"
            if not is_configured
            else ("loopback" if is_loopback else "remote_https")
        )
        return {
            "default_mode": "local_only",
            "default_voice_id": DEFAULT_LOCAL_VOICE_ID,
            "local": {
                "configured": is_configured,
                "mode": mode,
                "available": bool(local_health.get("available")),
                "stt_ready": bool(local_health.get("stt_ready")),
                "tts_ready": bool(local_health.get("tts_ready")),
                "error_code": local_health.get("error_code"),
                "stt_error_code": local_health.get("stt_error_code"),
                "tts_error_code": local_health.get("tts_error_code"),
                "worker_version": local_health.get("worker_version"),
                "latency_ms": local_health.get("latency_ms"),
                "stt_model_version": local_health.get("stt_model_version"),
                "stt_mode": local_health.get("stt_mode"),
                "tts_precision": local_health.get("tts_precision"),
                "active_voices": local_health.get("active_voices") or [v["voice_id"] for v in STATIC_LOCAL_VOICES],
                "tts_model_version": local_health.get("tts_model_version"),
            },
            "google": {
                "stt_configured": self.google.is_stt_configured(),
                "tts_configured": self.google.is_tts_configured(),
                "stt_cooldown": self.google.is_stt_in_cooldown(),
                "tts_cooldown": self.google.is_tts_in_cooldown(),
            },
            "elevenlabs": {
                "configured": self.elevenlabs.is_configured(),
                "stt_configured": self.elevenlabs.is_configured(),
                "tts_configured": self.elevenlabs.is_configured(),
                "model_id": self.elevenlabs.get_configured_model_id(),
                "voice_id": self.elevenlabs.get_configured_voice_id(),
            },
        }

    async def list_voices(
        self,
        *,
        policy: VoicePolicyContext | None = None,
    ) -> dict[str, Any]:
        ctx = policy or VoicePolicyContext()
        local_voices, local_live = await self.local.list_voices()
        voices = list(local_voices)
        if (
            ctx.provider_mode == "local_with_google_fallback"
            and ctx.allow_google_tts
            and self.google.is_tts_configured()
        ):
            voices.extend(self.google.list_backup_voices())
        return {
            "voices": voices,
            "default_voice_id": DEFAULT_LOCAL_VOICE_ID,
            "local_worker_ready": local_live,
            "google_tts_available": self.google.is_tts_configured(),
        }

    def _validate_google_tts_allowed(self, policy: VoicePolicyContext) -> None:
        if (
            policy.provider_mode != "local_with_google_fallback"
            or not policy.allow_google_tts
        ):
            raise VoiceProviderError(status_code=403, code="GOOGLE_TTS_DISABLED")
        if not self.google.is_tts_configured():
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_TTS_UNCONFIGURED"
            )

    @staticmethod
    def _audio_negotiation_kwargs(ctx: VoicePolicyContext) -> dict[str, str]:
        extra: dict[str, str] = {}
        if ctx.accept:
            extra["accept"] = ctx.accept
        if ctx.audio_format:
            extra["audio_format"] = ctx.audio_format
        return extra

    @staticmethod
    def _parse_optional_uuid(raw: UUID | str | None) -> UUID | None:
        if raw is None or isinstance(raw, UUID):
            return raw
        try:
            return UUID(str(raw).strip())
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _voice_region(voice_id: str) -> str:
        for item in STATIC_LOCAL_VOICES:
            if item.get("voice_id") == voice_id:
                return str(item.get("region") or "north")
        google_meta = GOOGLE_VOICE_BY_ID.get(voice_id)
        if google_meta is not None:
            return str(google_meta.get("region") or "north")
        return "north"

    @staticmethod
    def _fn_accepts_kwarg(fn: Any, name: str) -> bool:
        try:
            params = inspect.signature(fn).parameters
        except (TypeError, ValueError):
            return False
        return name in params or any(
            p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
        )

    async def _run_tts_single_flight(
        self,
        key: tuple[Any, ...],
        coro_factory: Callable[[], Awaitable[Any]],
    ) -> Any:
        existing = _tts_inflight.get(key)
        if existing is not None:
            return await asyncio.shield(existing)
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        _tts_inflight[key] = fut
        try:
            result = await coro_factory()
            if not fut.done():
                fut.set_result(result)
            return result
        except BaseException as exc:
            if not fut.done():
                if isinstance(exc, asyncio.CancelledError):
                    fut.cancel()
                else:
                    fut.set_exception(exc)
                    _ = fut.exception()
            raise
        finally:
            if _tts_inflight.get(key) is fut:
                _tts_inflight.pop(key, None)

    def update_session_voice_lock(
        self,
        ctx: VoicePolicyContext,
        voice_id: str,
    ) -> dict[str, Any]:
        """Explicitly update a session's locked voice (called when parent changes voice while paused)."""
        raw_sid = (ctx.session_id or "").strip()[:80]
        if not raw_sid:
            raise VoiceProviderError(status_code=422, code="SESSION_ID_REQUIRED")
        cleaned_voice = (voice_id or "").strip() or DEFAULT_LOCAL_VOICE_ID
        if cleaned_voice.startswith("google_"):
            self._validate_google_tts_allowed(ctx)
            if cleaned_voice not in GOOGLE_VOICE_BY_ID:
                raise VoiceProviderError(status_code=404, code="VOICE_NOT_FOUND")
            canonical_voice = cleaned_voice
            provider = "google"
        else:
            canonical_voice, _ = LocalVoiceProvider._resolve_target_voice_id(cleaned_voice)
            provider = "local"

        now = time.monotonic()
        _prune_session_voice_locks(now)
        lock_key = (str(ctx.actor_id or "-"), raw_sid)
        _session_voice_locks[lock_key] = (now, canonical_voice, provider)
        _session_voice_locks.move_to_end(lock_key)
        return {
            "session_id": raw_sid,
            "voice_id": canonical_voice,
            "provider": provider,
            "locked": True,
        }

    async def _resolve_cache_target(
        self,
        db: Any,
        ctx: VoicePolicyContext,
        *,
        normalized_text: str | None = None,
    ) -> tuple[TtsAudioCacheService | None, ResolvedCacheTarget | None]:
        if db is None or not is_tts_cache_enabled():
            return None, None
        page_uuid = self._parse_optional_uuid(ctx.page_id)
        if not (ctx.book_id or page_uuid or ctx.page_revision_id or ctx.cache_scope):
            return None, None
        svc = TtsAudioCacheService(db)
        target = await svc.resolve_target(
            actor_id=ctx.actor_id,
            book_id=ctx.book_id,
            page_id=page_uuid,
            page_revision_id=ctx.page_revision_id,
            cache_scope=ctx.cache_scope,
            normalized_text=normalized_text,
            allow_cache_write=False,
            defer_allowlist_check=True,
        )
        return svc, target

    def _resolve_elevenlabs_tts_voice(
        self, policy: VoicePolicyContext, requested_voice_id: str
    ) -> str | None:
        """Allow ElevenLabs TTS ONLY when parent opted into cloud fallback AND gender matches."""
        if not self.elevenlabs.is_configured():
            return None
        if (
            policy.provider_mode != "local_with_google_fallback"
            or not policy.allow_google_tts
        ):
            return None
        _region, gender = _resolve_local_voice_region_gender(requested_voice_id)
        return self.elevenlabs.get_voice_id_for_gender(gender)

    def _can_use_elevenlabs_stt(self, policy: VoicePolicyContext) -> bool:
        return (
            self.elevenlabs.is_configured()
            and policy.provider_mode == "local_with_google_fallback"
            and policy.allow_google_stt
        )

    def _can_fallback_unlocked_tts(
        self,
        policy: VoicePolicyContext,
        *,
        local_error_code: str | None = None,
    ) -> bool:
        return (
            (
                not policy.session_id
                or local_error_code == "LOCAL_VOICE_UNCONFIGURED"
            )
            and policy.provider_mode == "local_with_google_fallback"
            and policy.allow_google_tts
            and self.google.is_tts_configured()
            and not self.google.is_tts_in_cooldown()
        )

    def _validate_session_voice_lock(
        self,
        ctx: VoicePolicyContext,
        voice_id: str,
    ) -> tuple[tuple[str, str], str, str] | None:
        """Validate against any existing session voice lock without poisoning on a failed first turn."""
        raw_sid = (ctx.session_id or "").strip()[:80]
        if not raw_sid:
            return None
        if voice_id.startswith("google_"):
            canonical_voice = voice_id
            requested_provider = "google"
        else:
            canonical_voice, _ = LocalVoiceProvider._resolve_target_voice_id(voice_id)
            requested_provider = "local"

        now = time.monotonic()
        _prune_session_voice_locks(now)
        lock_key = (str(ctx.actor_id or "-"), raw_sid)
        existing = _session_voice_locks.get(lock_key)
        if existing is not None:
            _ts, locked_voice_id, locked_provider = existing
            if locked_provider != requested_provider or locked_voice_id != canonical_voice:
                if ctx.allow_voice_switch:
                    _session_voice_locks[lock_key] = (
                        now,
                        canonical_voice,
                        requested_provider,
                    )
                    _session_voice_locks.move_to_end(lock_key)
                    logger.info(
                        "tts_session_voice_lock_updated session=%s from=%s(%s) to=%s(%s) request_id=%s",
                        raw_sid,
                        locked_voice_id,
                        locked_provider,
                        canonical_voice,
                        requested_provider,
                        get_request_id(),
                    )
                    return
                logger.warning(
                    "tts_session_voice_lock_rejected session=%s locked=%s(%s) requested=%s(%s) request_id=%s",
                    raw_sid,
                    locked_voice_id,
                    locked_provider,
                    canonical_voice,
                    requested_provider,
                    get_request_id(),
                )
                raise VoiceProviderError(
                    status_code=409,
                    code="SESSION_VOICE_LOCKED",
                )
            _session_voice_locks.move_to_end(lock_key)
            _session_voice_locks[lock_key] = (now, locked_voice_id, locked_provider)
            return None

        return (lock_key, canonical_voice, requested_provider)

    def _commit_session_voice_lock(
        self,
        pending: tuple[tuple[str, str], str, str] | None,
    ) -> None:
        """Commit a newly established session voice lock only once audio synthesis or cache lookup succeeds."""
        if pending is None:
            return
        lock_key, canonical_voice, requested_provider = pending
        now = time.monotonic()
        _prune_session_voice_locks(now)
        existing = _session_voice_locks.get(lock_key)
        if existing is not None:
            _ts, locked_voice_id, locked_provider = existing
            if locked_provider != requested_provider or locked_voice_id != canonical_voice:
                raise VoiceProviderError(
                    status_code=409,
                    code="SESSION_VOICE_LOCKED",
                )
            _session_voice_locks.move_to_end(lock_key)
            _session_voice_locks[lock_key] = (now, locked_voice_id, locked_provider)
            return
        _session_voice_locks[lock_key] = (now, canonical_voice, requested_provider)
        _session_voice_locks.move_to_end(lock_key)

    def _enforce_session_voice_lock(
        self,
        ctx: VoicePolicyContext,
        voice_id: str,
    ) -> None:
        """Validate and immediately commit a session voice lock (backward-compatible helper)."""
        pending = self._validate_session_voice_lock(ctx, voice_id)
        self._commit_session_voice_lock(pending)

    async def synthesize(
        self,
        *,
        text: str,
        requested_voice_id: str | None = None,
        speed: float = 1.0,
        word_sample: bool = False,
        policy: VoicePolicyContext | None = None,
        db: Any = None,
        background_tasks: Any = None,
    ) -> LocalSynthesizedAudio:
        ctx = policy or VoicePolicyContext()
        voice_id = (requested_voice_id or "").strip() or DEFAULT_LOCAL_VOICE_ID
        t0 = time.perf_counter()

        pending_lock = self._validate_session_voice_lock(ctx, voice_id)
        is_google_voice = voice_id.startswith("google_")
        if is_google_voice:
            self._validate_google_tts_allowed(ctx)

        normalized_text = canonical_tts_text(text)
        cache_svc, cache_target = await self._resolve_cache_target(
            db, ctx, normalized_text=normalized_text
        )

        scope_key = (
            (cache_target.scope, str(cache_target.owner_parent_id or "-"), str(cache_target.page_id or "-"))
            if cache_target is not None
            else ("none", str(ctx.actor_id or "-"), str(ctx.page_id or "-"))
        )
        sf_key = (
            "tts",
            id(self.local),
            id(self.google),
            voice_id,
            round(float(speed), 2),
            bool(word_sample),
            normalized_text,
            scope_key,
            ctx.audio_format or ctx.accept or "",
            ctx.provider_mode,
            bool(ctx.allow_google_tts),
            bool(ctx.session_id),
        )

        async def _execute() -> LocalSynthesizedAudio:
            if cache_svc is not None and cache_target is not None and normalized_text:
                hit = await cache_svc.lookup_cached_audio(
                    target=cache_target,
                    normalized_text=normalized_text,
                    voice_id=voice_id,
                    model_version=GOOGLE_TTS_MODEL_VERSION if is_google_voice else None,
                    preferred_model_version=None if is_google_voice else LOCAL_TTS_MODEL_VERSION,
                    speed=speed,
                    accept=ctx.accept,
                    audio_format=ctx.audio_format,
                    background_tasks=background_tasks,
                )
                if hit is not None:
                    logger.info(
                        "tts_ok provider=precomputed_cache scope=%s voice=%s ms=%.1f session=%s request_id=%s",
                        hit.scope,
                        hit.resolved_voice_id,
                        (time.perf_counter() - t0) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    return LocalSynthesizedAudio(
                        content=hit.content,
                        content_type=hit.content_type,
                        resolved_voice_id=hit.resolved_voice_id,
                        region=self._voice_region(hit.resolved_voice_id),
                        model_version=hit.model_version,
                        provider="precomputed_cache",
                        used_fallback_voice=False,
                        cache_hit=True,
                        cache_scope=hit.scope,
                        cached_speed=hit.cached_speed,
                    )

            if is_google_voice:
                google_kwargs: dict[str, Any] = {
                    "text": text,
                    "voice_id": voice_id,
                    "speed": speed,
                }
                if ctx.accept and self._fn_accepts_kwarg(self.google.synthesize, "accept"):
                    google_kwargs["accept"] = ctx.accept
                if ctx.audio_format and self._fn_accepts_kwarg(self.google.synthesize, "audio_format"):
                    google_kwargs["audio_format"] = ctx.audio_format
                audio = await self.google.synthesize(**google_kwargs)
                if (
                    cache_svc is not None
                    and cache_target is not None
                    and cache_target.can_store_on_miss
                    and normalized_text
                ):
                    await cache_svc.schedule_store_cached_audio(
                        background_tasks=background_tasks,
                        target=cache_target,
                        normalized_text=normalized_text,
                        voice_id=audio.resolved_voice_id,
                        model_version=audio.model_version or GOOGLE_TTS_MODEL_VERSION,
                        speed=speed,
                        audio_bytes=audio.content,
                        source_content_type=audio.content_type,
                    )
                logger.info(
                    "tts_ok provider=google voice=%s ms=%.1f session=%s request_id=%s",
                    audio.resolved_voice_id,
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                return audio

            # Local voice locked: NEVER switch to Google or to another local voice!
            try:
                audio = await _call_local_with_busy_retry(
                    lambda: self.local.synthesize(
                        text=text,
                        voice_id=voice_id,
                        speed=speed,
                        word_sample=word_sample,
                        **self._audio_negotiation_kwargs(ctx),
                    )
                )
                if (
                    cache_svc is not None
                    and cache_target is not None
                    and cache_target.can_store_on_miss
                    and normalized_text
                ):
                    await cache_svc.schedule_store_cached_audio(
                        background_tasks=background_tasks,
                        target=cache_target,
                        normalized_text=normalized_text,
                        voice_id=audio.resolved_voice_id,
                        model_version=audio.model_version or LOCAL_TTS_MODEL_VERSION,
                        speed=speed,
                        audio_bytes=audio.content,
                        source_content_type=audio.content_type,
                    )
                logger.info(
                    "tts_ok provider=local voice=%s ms=%.1f session=%s request_id=%s",
                    audio.resolved_voice_id,
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                return audio
            except LocalVoiceTechnicalError as local_err:
                el_voice_id = self._resolve_elevenlabs_tts_voice(ctx, voice_id)
                if el_voice_id:
                    t_el = time.perf_counter()
                    el_audio = await self.elevenlabs.synthesize(
                        text=text,
                        requested_voice_id=el_voice_id,
                        speed=speed,
                    )
                    el_resolved_voice = (
                        el_audio.resolved_voice_id
                        or self.elevenlabs.get_configured_voice_id()
                    )
                    el_model = self.elevenlabs.get_configured_model_id()
                    if (
                        cache_svc is not None
                        and cache_target is not None
                        and cache_target.can_store_on_miss
                        and normalized_text
                    ):
                        await cache_svc.schedule_store_cached_audio(
                            background_tasks=background_tasks,
                            target=cache_target,
                            normalized_text=normalized_text,
                            voice_id=voice_id,
                            model_version=el_model,
                            speed=speed,
                            audio_bytes=el_audio.content,
                            source_content_type=el_audio.content_type or "audio/mpeg",
                        )
                    logger.info(
                        "tts_ok provider=elevenlabs reason=%s voice=%s ms=%.1f session=%s request_id=%s",
                        local_err.code,
                        el_resolved_voice,
                        (time.perf_counter() - t_el) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    return LocalSynthesizedAudio(
                        content=el_audio.content,
                        content_type=el_audio.content_type or "audio/mpeg",
                        resolved_voice_id=el_resolved_voice,
                        region=self._voice_region(voice_id),
                        model_version=el_model,
                        provider="elevenlabs",
                        used_fallback_voice=False,
                    )
                if not self._can_fallback_unlocked_tts(ctx, local_error_code=local_err.code):
                    logger.warning(
                        "tts_fail provider=local reason=%s voice=%s ms=%.1f session=%s request_id=%s",
                        local_err.code,
                        voice_id,
                        (time.perf_counter() - t0) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    raise
                backup_voice_id, backup_reason = _map_local_voice_to_google_backup_with_reason(voice_id)
                t_google = time.perf_counter()
                google_kwargs = {
                    "text": text,
                    "voice_id": backup_voice_id,
                    "speed": speed,
                }
                if ctx.accept and self._fn_accepts_kwarg(self.google.synthesize, "accept"):
                    google_kwargs["accept"] = ctx.accept
                if ctx.audio_format and self._fn_accepts_kwarg(self.google.synthesize, "audio_format"):
                    google_kwargs["audio_format"] = ctx.audio_format
                audio = await self.google.synthesize(**google_kwargs)
                fallback_audio = replace(
                    audio,
                    used_fallback_voice=True,
                    fallback_reason=backup_reason or local_err.code,
                )
                logger.info(
                    "tts_ok provider=google fallback=1 reason=%s backup_reason=%s voice=%s ms=%.1f session=- request_id=%s",
                    local_err.code,
                    backup_reason,
                    fallback_audio.resolved_voice_id,
                    (time.perf_counter() - t_google) * 1000,
                    get_request_id(),
                )
                return fallback_audio

        result = await self._run_tts_single_flight(sf_key, _execute)
        self._commit_session_voice_lock(pending_lock)
        return result

    @staticmethod
    def _align_cached_word_timings(
        *,
        words: list[str],
        raw_timings: list[dict[str, Any]],
        cached_text: str | None = None,
        duration_seconds: float | None = None,
    ) -> list[LocalTimedWord] | None:
        if not words or not raw_timings:
            return None

        parsed_raw: list[tuple[float, float]] = []
        max_end = 0.0
        for item in raw_timings:
            if not isinstance(item, dict):
                return None
            try:
                s_val = float(item["start"])
                e_val = float(item["end"])
            except (KeyError, TypeError, ValueError):
                return None
            if not (math.isfinite(s_val) and math.isfinite(e_val)) or s_val < 0 or e_val < 0:
                return None
            max_end = max(max_end, s_val, e_val)
            parsed_raw.append((s_val, max(s_val, e_val)))

        if duration_seconds is not None:
            if not math.isfinite(float(duration_seconds)) or float(duration_seconds) <= 0.0:
                if max_end <= 0.0:
                    return None
                effective_duration = max_end
            else:
                effective_duration = float(duration_seconds)
        else:
            effective_duration = max_end
            if effective_duration <= 0.0:
                return None

        if len(raw_timings) == len(words):
            clamped: list[LocalTimedWord] = []
            prev_end = 0.0
            for idx, (s_val, e_val) in enumerate(parsed_raw):
                start = round(max(prev_end, min(effective_duration, s_val)), 3)
                end = round(max(start, min(effective_duration, e_val)), 3)
                clamped.append(LocalTimedWord(index=idx, start=start, end=end))
                prev_end = end
            return clamped

        req_spoken: list[tuple[int, str]] = []
        for idx, token in enumerate(words):
            folded_tok = folded_catalog_tts_text(token)
            if folded_tok:
                req_spoken.append((idx, folded_tok))
        if not req_spoken:
            return None

        matched_by_req_idx: dict[int, tuple[float, float]] = {}
        cached_tokens = canonical_tts_text(cached_text).split() if cached_text else []
        if cached_tokens and len(cached_tokens) == len(parsed_raw):
            cached_spoken: list[tuple[str, tuple[float, float]]] = []
            for tok, timing in zip(cached_tokens, parsed_raw):
                folded_tok = folded_catalog_tts_text(tok)
                if folded_tok:
                    cached_spoken.append((folded_tok, timing))
            if len(cached_spoken) != len(req_spoken) or any(
                r_tok != c_tok
                for (_, r_tok), (c_tok, _) in zip(req_spoken, cached_spoken)
            ):
                return None
            for (req_idx, _), (_, timing) in zip(req_spoken, cached_spoken):
                matched_by_req_idx[req_idx] = timing
        elif len(parsed_raw) == len(req_spoken):
            for (req_idx, _), timing in zip(req_spoken, parsed_raw):
                matched_by_req_idx[req_idx] = timing
        else:
            return None

        aligned: list[LocalTimedWord] = []
        prev_end = 0.0
        for idx in range(len(words)):
            pair = matched_by_req_idx.get(idx)
            if pair is not None:
                start = round(max(prev_end, min(effective_duration, pair[0])), 3)
                end = round(max(start, min(effective_duration, pair[1])), 3)
                aligned.append(LocalTimedWord(index=idx, start=start, end=end))
                prev_end = end
            else:
                zero = round(min(effective_duration, prev_end), 3)
                aligned.append(LocalTimedWord(index=idx, start=zero, end=zero))
        return aligned

    async def synthesize_timed(
        self,
        *,
        words: list[str],
        requested_voice_id: str | None = None,
        speed: float = 1.0,
        policy: VoicePolicyContext | None = None,
        db: Any = None,
        background_tasks: Any = None,
    ) -> LocalTimedSpeech:
        ctx = policy or VoicePolicyContext()
        voice_id = (requested_voice_id or "").strip() or DEFAULT_LOCAL_VOICE_ID
        t0 = time.perf_counter()

        pending_lock = self._validate_session_voice_lock(ctx, voice_id)
        is_google_voice = voice_id.startswith("google_")
        if is_google_voice:
            self._validate_google_tts_allowed(ctx)

        normalized_text = canonical_tts_text(" ".join(words))
        cache_svc, cache_target = await self._resolve_cache_target(
            db, ctx, normalized_text=normalized_text
        )

        scope_key = (
            (cache_target.scope, str(cache_target.owner_parent_id or "-"), str(cache_target.page_id or "-"))
            if cache_target is not None
            else ("none", str(ctx.actor_id or "-"), str(ctx.page_id or "-"))
        )
        sf_key = (
            "tts_timed",
            id(self.local),
            id(self.google),
            voice_id,
            round(float(speed), 2),
            tuple(words),
            scope_key,
            ctx.audio_format or ctx.accept or "",
            ctx.provider_mode,
            bool(ctx.allow_google_tts),
            bool(ctx.session_id),
        )

        async def _execute() -> LocalTimedSpeech:
            if cache_svc is not None and cache_target is not None and normalized_text:
                hit = await cache_svc.lookup_cached_audio(
                    target=cache_target,
                    normalized_text=normalized_text,
                    voice_id=voice_id,
                    model_version=GOOGLE_TTS_MODEL_VERSION if is_google_voice else None,
                    preferred_model_version=None if is_google_voice else LOCAL_TTS_MODEL_VERSION,
                    speed=speed,
                    accept=ctx.accept,
                    audio_format=ctx.audio_format,
                    require_word_timings=True,
                    background_tasks=background_tasks,
                )
                if hit is not None and isinstance(hit.word_timings_json, list):
                    timings = self._align_cached_word_timings(
                        words=words,
                        raw_timings=hit.word_timings_json,
                        cached_text=getattr(hit, "normalized_text", None),
                        duration_seconds=hit.duration_seconds,
                    )
                else:
                    timings = None
                safe_duration = 0.0
                if hit is not None and timings is not None:
                    raw_dur = hit.duration_seconds
                    if raw_dur is not None and math.isfinite(float(raw_dur)) and float(raw_dur) > 0.0:
                        safe_duration = round(float(raw_dur), 3)
                    else:
                        safe_duration = round(max((t.end for t in timings), default=0.0), 3)
                if hit is not None and timings is not None and safe_duration > 0.0:
                    logger.info(
                        "tts_timed_ok provider=precomputed_cache scope=%s voice=%s words=%d ms=%.1f session=%s request_id=%s",
                        hit.scope,
                        hit.resolved_voice_id,
                        len(words),
                        (time.perf_counter() - t0) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    return LocalTimedSpeech(
                        audio=hit.content,
                        content_type=hit.content_type,
                        duration_seconds=safe_duration,
                        words=timings,
                        resolved_voice_id=hit.resolved_voice_id,
                        region=self._voice_region(hit.resolved_voice_id),
                        model_version=hit.model_version,
                        provider="precomputed_cache",
                        used_fallback_voice=False,
                        cache_hit=True,
                        cache_scope=hit.scope,
                        cached_speed=hit.cached_speed,
                    )

            if is_google_voice:
                google_timed_kwargs: dict[str, Any] = {
                    "words": words,
                    "voice_id": voice_id,
                    "speed": speed,
                }
                if ctx.accept and self._fn_accepts_kwarg(self.google.synthesize_timed, "accept"):
                    google_timed_kwargs["accept"] = ctx.accept
                if ctx.audio_format and self._fn_accepts_kwarg(self.google.synthesize_timed, "audio_format"):
                    google_timed_kwargs["audio_format"] = ctx.audio_format
                speech = await self.google.synthesize_timed(**google_timed_kwargs)
                if (
                    cache_svc is not None
                    and cache_target is not None
                    and cache_target.can_store_on_miss
                    and normalized_text
                ):
                    await cache_svc.schedule_store_cached_audio(
                        background_tasks=background_tasks,
                        target=cache_target,
                        normalized_text=normalized_text,
                        voice_id=speech.resolved_voice_id,
                        model_version=speech.model_version or GOOGLE_TTS_MODEL_VERSION,
                        speed=speed,
                        audio_bytes=speech.audio,
                        source_content_type=speech.content_type,
                        duration_seconds=speech.duration_seconds,
                        word_timings_json=[
                            {"index": w.index, "start": w.start, "end": w.end}
                            for w in speech.words
                        ],
                    )
                logger.info(
                    "tts_timed_ok provider=google voice=%s words=%d ms=%.1f session=%s request_id=%s",
                    speech.resolved_voice_id,
                    len(words),
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                return speech

            try:
                speech = await _call_local_with_busy_retry(
                    lambda: self.local.synthesize_timed(
                        words=words,
                        voice_id=voice_id,
                        speed=speed,
                        **self._audio_negotiation_kwargs(ctx),
                    )
                )
                if (
                    cache_svc is not None
                    and cache_target is not None
                    and cache_target.can_store_on_miss
                    and normalized_text
                ):
                    await cache_svc.schedule_store_cached_audio(
                        background_tasks=background_tasks,
                        target=cache_target,
                        normalized_text=normalized_text,
                        voice_id=speech.resolved_voice_id,
                        model_version=speech.model_version or LOCAL_TTS_MODEL_VERSION,
                        speed=speed,
                        audio_bytes=speech.audio,
                        source_content_type=speech.content_type,
                        duration_seconds=speech.duration_seconds,
                        word_timings_json=[
                            {"index": w.index, "start": w.start, "end": w.end}
                            for w in speech.words
                        ],
                    )
                logger.info(
                    "tts_timed_ok provider=local voice=%s words=%d ms=%.1f session=%s request_id=%s",
                    speech.resolved_voice_id,
                    len(words),
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                return speech
            except LocalVoiceTechnicalError as local_err:
                el_voice_id = self._resolve_elevenlabs_tts_voice(ctx, voice_id)
                if el_voice_id:
                    t_el = time.perf_counter()
                    el_timed = await self.elevenlabs.synthesize_timed(
                        words=words,
                        requested_voice_id=el_voice_id,
                        speed=speed,
                    )
                    if (
                        cache_svc is not None
                        and cache_target is not None
                        and cache_target.can_store_on_miss
                        and normalized_text
                    ):
                        await cache_svc.schedule_store_cached_audio(
                            background_tasks=background_tasks,
                            target=cache_target,
                            normalized_text=normalized_text,
                            voice_id=voice_id,
                            model_version=el_timed.model_version
                            or self.elevenlabs.get_configured_model_id(),
                            speed=speed,
                            audio_bytes=el_timed.audio,
                            source_content_type=el_timed.content_type or "audio/mpeg",
                            duration_seconds=el_timed.duration_seconds,
                            word_timings_json=[
                                {"index": w.index, "start": w.start, "end": w.end}
                                for w in el_timed.words
                            ],
                        )
                    logger.info(
                        "tts_timed_ok provider=elevenlabs reason=%s voice=%s words=%d ms=%.1f session=%s request_id=%s",
                        local_err.code,
                        el_timed.resolved_voice_id,
                        len(words),
                        (time.perf_counter() - t_el) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    return el_timed
                if not self._can_fallback_unlocked_tts(ctx, local_error_code=local_err.code):
                    logger.warning(
                        "tts_timed_fail provider=local reason=%s voice=%s ms=%.1f session=%s request_id=%s",
                        local_err.code,
                        voice_id,
                        (time.perf_counter() - t0) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    raise
                backup_voice_id, backup_reason = _map_local_voice_to_google_backup_with_reason(voice_id)
                google_timed_kwargs = {
                    "words": words,
                    "voice_id": backup_voice_id,
                    "speed": speed,
                }
                if ctx.accept and self._fn_accepts_kwarg(self.google.synthesize_timed, "accept"):
                    google_timed_kwargs["accept"] = ctx.accept
                if ctx.audio_format and self._fn_accepts_kwarg(self.google.synthesize_timed, "audio_format"):
                    google_timed_kwargs["audio_format"] = ctx.audio_format
                timed = await self.google.synthesize_timed(**google_timed_kwargs)
                logger.info(
                    "tts_timed_ok provider=google fallback=1 reason=%s backup_reason=%s voice=%s session=- request_id=%s",
                    local_err.code,
                    backup_reason,
                    timed.resolved_voice_id,
                    get_request_id(),
                )
                return replace(
                    timed,
                    used_fallback_voice=True,
                    fallback_reason=backup_reason or local_err.code,
                )

        result = await self._run_tts_single_flight(sf_key, _execute)
        self._commit_session_voice_lock(pending_lock)
        return result

    async def synthesize_phonics(
        self,
        *,
        steps: list[dict[str, Any]],
        requested_voice_id: str | None = None,
        speed: float = 1.0,
        policy: VoicePolicyContext | None = None,
        db: Any = None,
        background_tasks: Any = None,
    ) -> LocalPhonicsSpeech:
        ctx = policy or VoicePolicyContext()
        voice_id = (requested_voice_id or "").strip() or DEFAULT_LOCAL_VOICE_ID
        t0 = time.perf_counter()

        pending_lock = self._validate_session_voice_lock(ctx, voice_id)
        is_google_voice = voice_id.startswith("google_")
        if is_google_voice:
            self._validate_google_tts_allowed(ctx)

        phonics_key, _ = canonical_phonics_key(steps)
        cache_svc, cache_target = await self._resolve_cache_target(
            db, ctx, normalized_text=phonics_key
        )

        scope_key = (
            (cache_target.scope, str(cache_target.owner_parent_id or "-"), str(cache_target.page_id or "-"))
            if cache_target is not None
            else ("none", str(ctx.actor_id or "-"), str(ctx.page_id or "-"))
        )
        sf_key = (
            "tts_phonics",
            id(self.local),
            id(self.google),
            voice_id,
            round(float(speed), 2),
            phonics_key,
            scope_key,
            ctx.audio_format or ctx.accept or "",
            ctx.provider_mode,
            bool(ctx.allow_google_tts),
            bool(ctx.session_id),
        )

        async def _execute() -> LocalPhonicsSpeech:
            if cache_svc is not None and cache_target is not None:
                hit = await cache_svc.lookup_cached_audio(
                    target=cache_target,
                    normalized_text=phonics_key,
                    voice_id=voice_id,
                    model_version=GOOGLE_TTS_MODEL_VERSION if is_google_voice else None,
                    preferred_model_version=None if is_google_voice else LOCAL_TTS_MODEL_VERSION,
                    speed=speed,
                    accept=ctx.accept,
                    audio_format=ctx.audio_format,
                    require_word_timings=True,
                    background_tasks=background_tasks,
                )
                if (
                    hit is not None
                    and isinstance(hit.word_timings_json, list)
                    and len(hit.word_timings_json) == len(steps)
                ):
                    raw_dur = hit.duration_seconds
                    max_step_end = max(
                        (
                            float(item.get("end", 0.0))
                            for item in hit.word_timings_json
                            if isinstance(item, dict)
                        ),
                        default=0.0,
                    )
                    safe_dur = (
                        round(float(raw_dur), 3)
                        if raw_dur is not None and math.isfinite(float(raw_dur)) and float(raw_dur) > 0.0
                        else round(max_step_end, 3)
                    )
                    if safe_dur > 0.0:
                        timings: list[LocalPhonicsStepTiming] = []
                        prev_end = 0.0
                        for idx, item in enumerate(hit.word_timings_json):
                            start = round(
                                max(prev_end, min(safe_dur, float(item.get("start", 0.0)))),
                                3,
                            )
                            end = round(
                                max(start, min(safe_dur, float(item.get("end", start)))),
                                3,
                            )
                            timings.append(
                                LocalPhonicsStepTiming(
                                    id=str(item.get("id") or steps[idx]["id"]),
                                    index=int(item.get("index", idx)),
                                    start=start,
                                    end=end,
                                )
                            )
                            prev_end = end
                        logger.info(
                            "tts_phonics_ok provider=precomputed_cache scope=%s voice=%s steps=%d ms=%.1f session=%s request_id=%s",
                            hit.scope,
                            hit.resolved_voice_id,
                            len(steps),
                            (time.perf_counter() - t0) * 1000,
                            ctx.session_id or "-",
                            get_request_id(),
                        )
                        return LocalPhonicsSpeech(
                            audio=hit.content,
                            content_type=hit.content_type,
                            duration_seconds=safe_dur,
                            step_timings=timings,
                            resolved_voice_id=hit.resolved_voice_id,
                            region=self._voice_region(hit.resolved_voice_id),
                            model_version=hit.model_version,
                            provider="precomputed_cache",
                            cache_hit=True,
                            cache_scope=hit.scope,
                            cached_speed=hit.cached_speed,
                        )

            if is_google_voice:
                speech = await self.google.synthesize_phonics(
                    steps=steps, voice_id=voice_id, speed=speed
                )
                if (
                    cache_svc is not None
                    and cache_target is not None
                    and cache_target.can_store_on_miss
                ):
                    await cache_svc.schedule_store_cached_audio(
                        background_tasks=background_tasks,
                        target=cache_target,
                        normalized_text=phonics_key,
                        voice_id=speech.resolved_voice_id,
                        model_version=speech.model_version or GOOGLE_TTS_MODEL_VERSION,
                        speed=speed,
                        audio_bytes=speech.audio,
                        source_content_type=speech.content_type,
                        duration_seconds=speech.duration_seconds,
                        word_timings_json=[
                            {
                                "id": s.id,
                                "index": s.index,
                                "start": s.start,
                                "end": s.end,
                            }
                            for s in speech.step_timings
                        ],
                    )
                logger.info(
                    "tts_phonics_ok provider=google voice=%s steps=%d ms=%.1f session=%s request_id=%s",
                    speech.resolved_voice_id,
                    len(steps),
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                return speech

            try:
                speech = await _call_local_with_busy_retry(
                    lambda: self.local.synthesize_phonics(
                        steps=steps,
                        voice_id=voice_id,
                        speed=speed,
                        **self._audio_negotiation_kwargs(ctx),
                    )
                )
                if (
                    cache_svc is not None
                    and cache_target is not None
                    and cache_target.can_store_on_miss
                ):
                    await cache_svc.schedule_store_cached_audio(
                        background_tasks=background_tasks,
                        target=cache_target,
                        normalized_text=phonics_key,
                        voice_id=speech.resolved_voice_id,
                        model_version=speech.model_version or LOCAL_TTS_MODEL_VERSION,
                        speed=speed,
                        audio_bytes=speech.audio,
                        source_content_type=speech.content_type,
                        duration_seconds=speech.duration_seconds,
                        word_timings_json=[
                            {
                                "id": s.id,
                                "index": s.index,
                                "start": s.start,
                                "end": s.end,
                            }
                            for s in speech.step_timings
                        ],
                    )
                logger.info(
                    "tts_phonics_ok provider=local voice=%s steps=%d ms=%.1f session=%s request_id=%s",
                    speech.resolved_voice_id,
                    len(steps),
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                return speech
            except LocalVoiceTechnicalError as local_err:
                el_voice_id = self._resolve_elevenlabs_tts_voice(ctx, voice_id)
                if el_voice_id:
                    t_el = time.perf_counter()
                    el_phonics = await self.elevenlabs.synthesize_phonics(
                        steps=steps,
                        requested_voice_id=el_voice_id,
                        speed=speed,
                    )
                    if (
                        cache_svc is not None
                        and cache_target is not None
                        and cache_target.can_store_on_miss
                    ):
                        await cache_svc.schedule_store_cached_audio(
                            background_tasks=background_tasks,
                            target=cache_target,
                            normalized_text=phonics_key,
                            voice_id=voice_id,
                            model_version=el_phonics.model_version
                            or self.elevenlabs.get_configured_model_id(),
                            speed=speed,
                            audio_bytes=el_phonics.audio,
                            source_content_type=el_phonics.content_type or "audio/mpeg",
                            duration_seconds=el_phonics.duration_seconds,
                            word_timings_json=[
                                {
                                    "id": s.id,
                                    "index": s.index,
                                    "start": s.start,
                                    "end": s.end,
                                }
                                for s in el_phonics.step_timings
                            ],
                        )
                    logger.info(
                        "tts_phonics_ok provider=elevenlabs reason=%s voice=%s steps=%d ms=%.1f session=%s request_id=%s",
                        local_err.code,
                        el_phonics.resolved_voice_id,
                        len(steps),
                        (time.perf_counter() - t_el) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    return el_phonics
                if not self._can_fallback_unlocked_tts(ctx, local_error_code=local_err.code):
                    logger.warning(
                        "tts_phonics_fail provider=local reason=%s voice=%s ms=%.1f session=%s request_id=%s",
                        local_err.code,
                        voice_id,
                        (time.perf_counter() - t0) * 1000,
                        ctx.session_id or "-",
                        get_request_id(),
                    )
                    raise
                backup_voice_id, backup_reason = _map_local_voice_to_google_backup_with_reason(voice_id)
                phonics = await self.google.synthesize_phonics(
                    steps=steps, voice_id=backup_voice_id, speed=speed
                )
                logger.info(
                    "tts_phonics_ok provider=google fallback=1 reason=%s backup_reason=%s voice=%s session=- request_id=%s",
                    local_err.code,
                    backup_reason,
                    phonics.resolved_voice_id,
                    get_request_id(),
                )
                return replace(
                    phonics,
                    used_fallback_voice=True,
                    fallback_reason=backup_reason or local_err.code,
                )

        result = await self._run_tts_single_flight(sf_key, _execute)
        self._commit_session_voice_lock(pending_lock)
        return result

    async def transcribe(
        self,
        *,
        audio: bytes,
        filename: str,
        content_type: str,
        language_code: str | None = "vi",
        keyterms: list[str] | None = None,
        actor_id: UUID | None = None,
        policy: VoicePolicyContext | None = None,
    ) -> LocalTranscription:
        ctx = policy or VoicePolicyContext()
        now = time.monotonic()
        _prune_turn_cache(now)

        dedup_key: tuple[str, str, str, str] | None = None
        if ctx.session_id and ctx.turn_id:
            dedup_key = (
                str(actor_id or "-"),
                ctx.session_id.strip()[:80],
                (ctx.page_id or "-").strip()[:80],
                ctx.turn_id.strip()[:80],
            )
            cached = _turn_results.get(dedup_key)
            if cached is not None:
                _turn_results.move_to_end(dedup_key)
                return cached[1]
            existing_fut = _turn_inflight.get(dedup_key)
            if existing_fut is not None:
                return await asyncio.shield(existing_fut)

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[LocalTranscription] | None = None
        if dedup_key is not None:
            fut = loop.create_future()
            _turn_inflight[dedup_key] = fut

        try:
            result = await self._transcribe_once(
                audio=audio,
                filename=filename,
                content_type=content_type,
                language_code=language_code,
                keyterms=keyterms,
                ctx=ctx,
            )
            if dedup_key is not None and not getattr(result, "superseded", False):
                _turn_results[dedup_key] = (time.monotonic(), result)
            if fut is not None and not fut.done():
                fut.set_result(result)
            return result
        except BaseException as exc:
            if fut is not None and not fut.done():
                if isinstance(exc, asyncio.CancelledError):
                    fut.cancel()
                else:
                    fut.set_exception(exc)
                    _ = fut.exception()
            raise
        finally:
            if dedup_key is not None and _turn_inflight.get(dedup_key) is fut:
                _turn_inflight.pop(dedup_key, None)

    async def _transcribe_once(
        self,
        *,
        audio: bytes,
        filename: str,
        content_type: str,
        language_code: str | None,
        keyterms: list[str] | None,
        ctx: VoicePolicyContext,
    ) -> LocalTranscription:
        t0 = time.perf_counter()
        try:
            res = await _call_local_with_busy_retry(
                lambda: self.local.transcribe(
                    audio=audio,
                    filename=filename,
                    content_type=content_type,
                    language_code=language_code,
                    source=ctx.source,
                    session_id=ctx.session_id,
                    turn_id=ctx.turn_id,
                )
            )
            logger.info(
                "stt_ok provider=local fallback=0 ms=%.1f session=%s page=%s turn=%s request_id=%s",
                (time.perf_counter() - t0) * 1000,
                ctx.session_id or "-",
                ctx.page_id or "-",
                ctx.turn_id or "-",
                get_request_id(),
            )
            return res
        except LocalVoiceTechnicalError as local_err:
            if self._can_use_elevenlabs_stt(ctx):
                t_el = time.perf_counter()
                el_res = await self.elevenlabs.transcribe(
                    audio=audio,
                    filename=filename,
                    content_type=content_type,
                    language_code=language_code or "vi",
                    keyterms=keyterms,
                )
                logger.info(
                    "stt_ok provider=elevenlabs fallback=1 reason=%s ms=%.1f session=%s page=%s turn=%s request_id=%s",
                    local_err.code,
                    (time.perf_counter() - t_el) * 1000,
                    ctx.session_id or "-",
                    ctx.page_id or "-",
                    ctx.turn_id or "-",
                    get_request_id(),
                )
                return LocalTranscription(
                    text=el_res.text,
                    language_code=el_res.language_code or "vi",
                    language_probability=el_res.language_probability,
                    words=el_res.words,
                    provider="elevenlabs",
                    model_version="scribe_v2",
                    fallback_used=True,
                    fallback_reason=local_err.code,
                )
            can_fallback = (
                ctx.provider_mode == "local_with_google_fallback"
                and ctx.allow_google_stt
                and self.google.is_stt_configured()
                and not self.google.is_stt_in_cooldown()
            )
            if not can_fallback:
                logger.warning(
                    "stt_fail provider=local fallback=0 reason=%s mode=%s allow_google=%s request_id=%s",
                    local_err.code,
                    ctx.provider_mode,
                    ctx.allow_google_stt,
                    get_request_id(),
                )
                raise VoiceProviderError(
                    status_code=503, code=local_err.code
                ) from None

            t_google = time.perf_counter()
            google_res = await self.google.transcribe(
                audio=audio,
                filename=filename,
                content_type=content_type,
                language_code=language_code,
                keyterms=keyterms,
                fallback_reason=local_err.code,
            )
            logger.info(
                "stt_ok provider=google fallback=1 reason=%s ms=%.1f session=%s page=%s turn=%s request_id=%s",
                local_err.code,
                (time.perf_counter() - t_google) * 1000,
                ctx.session_id or "-",
                ctx.page_id or "-",
                ctx.turn_id or "-",
                get_request_id(),
            )
            return google_res
