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
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any, Literal
from uuid import UUID

from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.google_voice_provider import GoogleCloudVoiceProvider
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
    CachedTtsHit,
    ResolvedCacheTarget,
    TtsAudioCacheService,
    canonical_phonics_key,
    canonical_tts_text,
    folded_catalog_tts_text,
    get_tts_cache_lookup_timeout_seconds,
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


_TURN_CACHE_MAX = 512
_TURN_CACHE_TTL_SECONDS = 120.0
_turn_results: "OrderedDict[tuple[str, str, str, str], tuple[float, LocalTranscription]]" = (
    OrderedDict()
)
_turn_inflight: dict[tuple[str, str, str, str], asyncio.Future[LocalTranscription]] = {}


def clear_voice_orchestrator_caches() -> None:
    _turn_results.clear()
    _turn_inflight.clear()


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


def _map_local_voice_to_google_backup(voice_id: str) -> str:
    region = "north"
    gender = "female"
    for item in STATIC_LOCAL_VOICES:
        if item.get("voice_id") == voice_id:
            region = str(item.get("region") or "north")
            gender = str(item.get("gender") or "female")
            break
    else:
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


class VoiceOrchestrator:
    def __init__(
        self,
        *,
        local_provider: LocalVoiceProvider | None = None,
        google_provider: GoogleCloudVoiceProvider | None = None,
    ) -> None:
        self.local = local_provider or LocalVoiceProvider()
        self.google = google_provider or GoogleCloudVoiceProvider()

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
        return "north"

    @staticmethod
    def _accepts_kwarg(fn: Any, kwarg: str) -> bool:
        try:
            params = inspect.signature(fn).parameters
        except (TypeError, ValueError):
            return False
        return kwarg in params or any(
            p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
        )

    async def _resolve_cache_target(
        self,
        db: Any,
        ctx: VoicePolicyContext,
        *,
        normalized_text: str | None = None,
        end_read_tx: bool = True,
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
            end_read_tx=end_read_tx,
        )
        return svc, target

    async def _resolve_and_lookup_cache(
        self,
        db: Any,
        ctx: VoicePolicyContext,
        *,
        normalized_text: str,
        voice_id: str,
        speed: float,
        require_word_timings: bool = False,
    ) -> tuple[TtsAudioCacheService | None, ResolvedCacheTarget | None, CachedTtsHit | None]:
        if db is None or not is_tts_cache_enabled():
            return None, None, None
        page_uuid = self._parse_optional_uuid(ctx.page_id)
        if not (ctx.book_id or page_uuid or ctx.page_revision_id or ctx.cache_scope):
            return None, None, None

        budget = get_tts_cache_lookup_timeout_seconds()
        svc_holder: list[TtsAudioCacheService] = []

        async def _run() -> tuple[TtsAudioCacheService | None, ResolvedCacheTarget | None, CachedTtsHit | None]:
            if self._accepts_kwarg(self._resolve_cache_target, "end_read_tx"):
                cache_svc, cache_target = await self._resolve_cache_target(
                    db, ctx, normalized_text=normalized_text, end_read_tx=False
                )
            else:
                cache_svc, cache_target = await self._resolve_cache_target(
                    db, ctx, normalized_text=normalized_text
                )
            if cache_svc is not None:
                svc_holder.append(cache_svc)
            if cache_svc is None or cache_target is None or not normalized_text:
                if cache_svc is not None:
                    await cache_svc._end_read_tx()
                return cache_svc, cache_target, None
            hit = await cache_svc.lookup_cached_audio(
                target=cache_target,
                normalized_text=normalized_text,
                voice_id=voice_id,
                speed=speed,
                accept=ctx.accept,
                audio_format=ctx.audio_format,
                require_word_timings=require_word_timings,
                background_metrics=True,
            )
            return cache_svc, cache_target, hit

        try:
            return await asyncio.wait_for(_run(), timeout=budget)
        except TimeoutError:
            if svc_holder:
                await svc_holder[0]._safe_rollback()
            elif db is not None and callable(getattr(db, "rollback", None)):
                try:
                    await db.rollback()
                except Exception:
                    pass
            logger.warning(
                "tts_cache_lookup_timeout timeout_s=%.2f voice=%s request_id=%s",
                budget,
                voice_id,
                get_request_id(),
            )
            return None, None, None

    def _can_fallback_unlocked_tts(self, policy: VoicePolicyContext) -> bool:
        return (
            not policy.session_id
            and policy.provider_mode == "local_with_google_fallback"
            and policy.allow_google_tts
            and self.google.is_tts_configured()
            and not self.google.is_tts_in_cooldown()
        )

    async def synthesize(
        self,
        *,
        text: str,
        requested_voice_id: str | None = None,
        speed: float = 1.0,
        word_sample: bool = False,
        policy: VoicePolicyContext | None = None,
        db: Any = None,
    ) -> LocalSynthesizedAudio:
        ctx = policy or VoicePolicyContext()
        voice_id = (requested_voice_id or "").strip() or DEFAULT_LOCAL_VOICE_ID
        t0 = time.perf_counter()

        if voice_id.startswith("google_"):
            self._validate_google_tts_allowed(ctx)
            audio = await self.google.synthesize(
                text=text, voice_id=voice_id, speed=speed
            )
            logger.info(
                "tts_ok provider=google voice=%s ms=%.1f session=%s request_id=%s",
                audio.resolved_voice_id,
                (time.perf_counter() - t0) * 1000,
                ctx.session_id or "-",
                get_request_id(),
            )
            return audio

        normalized_text = canonical_tts_text(text)
        cache_svc, cache_target, hit = await self._resolve_and_lookup_cache(
            db,
            ctx,
            normalized_text=normalized_text,
            voice_id=voice_id,
            speed=speed,
            require_word_timings=False,
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

        # Local voice locked: NEVER switch to Google or to another local voice!
        try:
            audio = await self.local.synthesize(
                text=text,
                voice_id=voice_id,
                speed=speed,
                word_sample=word_sample,
                **self._audio_negotiation_kwargs(ctx),
            )
            if (
                cache_svc is not None
                and cache_target is not None
                and cache_target.can_store_on_miss
                and normalized_text
            ):
                cache_svc.schedule_store_cached_audio(
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
            if not self._can_fallback_unlocked_tts(ctx):
                logger.warning(
                    "tts_fail provider=local reason=%s voice=%s ms=%.1f session=%s request_id=%s",
                    local_err.code,
                    voice_id,
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                raise
            backup_voice_id = _map_local_voice_to_google_backup(voice_id)
            t_google = time.perf_counter()
            audio = await self.google.synthesize(
                text=text, voice_id=backup_voice_id, speed=speed
            )
            fallback_audio = replace(audio, used_fallback_voice=True)
            logger.info(
                "tts_ok provider=google fallback=1 reason=%s voice=%s ms=%.1f session=- request_id=%s",
                local_err.code,
                fallback_audio.resolved_voice_id,
                (time.perf_counter() - t_google) * 1000,
                get_request_id(),
            )
            return fallback_audio

    @staticmethod
    def _align_cached_word_timings(
        *,
        words: list[str],
        raw_timings: list[dict[str, Any]],
        cached_text: str | None = None,
    ) -> list[LocalTimedWord] | None:
        if len(raw_timings) == len(words):
            return [
                LocalTimedWord(
                    index=int(item["index"]),
                    start=float(item["start"]),
                    end=float(item["end"]),
                )
                for item in raw_timings
            ]

        req_spoken: list[tuple[int, str]] = []
        for idx, token in enumerate(words):
            folded_tok = folded_catalog_tts_text(token)
            if folded_tok:
                req_spoken.append((idx, folded_tok))
        if not req_spoken:
            return None

        matched_by_req_idx: dict[int, dict[str, Any]] = {}
        cached_tokens = canonical_tts_text(cached_text).split() if cached_text else []
        if cached_tokens and len(cached_tokens) == len(raw_timings):
            cached_spoken: list[tuple[str, dict[str, Any]]] = []
            for tok, timing in zip(cached_tokens, raw_timings):
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
        elif len(raw_timings) == len(req_spoken):
            for (req_idx, _), timing in zip(req_spoken, raw_timings):
                matched_by_req_idx[req_idx] = timing
        else:
            return None

        aligned: list[LocalTimedWord] = []
        prev_end = 0.0
        for idx in range(len(words)):
            item = matched_by_req_idx.get(idx)
            if item is not None:
                start = max(prev_end, float(item["start"]))
                end = max(start, float(item["end"]))
                aligned.append(LocalTimedWord(index=idx, start=start, end=end))
                prev_end = end
            else:
                aligned.append(LocalTimedWord(index=idx, start=prev_end, end=prev_end))
        return aligned

    async def synthesize_timed(
        self,
        *,
        words: list[str],
        requested_voice_id: str | None = None,
        speed: float = 1.0,
        policy: VoicePolicyContext | None = None,
        db: Any = None,
    ) -> LocalTimedSpeech:
        ctx = policy or VoicePolicyContext()
        voice_id = (requested_voice_id or "").strip() or DEFAULT_LOCAL_VOICE_ID
        t0 = time.perf_counter()

        if voice_id.startswith("google_"):
            self._validate_google_tts_allowed(ctx)
            speech = await self.google.synthesize_timed(
                words=words, voice_id=voice_id, speed=speed
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

        normalized_text = canonical_tts_text(" ".join(words))
        cache_svc, cache_target, hit = await self._resolve_and_lookup_cache(
            db,
            ctx,
            normalized_text=normalized_text,
            voice_id=voice_id,
            speed=speed,
            require_word_timings=True,
        )
        if hit is not None and isinstance(hit.word_timings_json, list):
            timings = self._align_cached_word_timings(
                words=words,
                raw_timings=hit.word_timings_json,
                cached_text=getattr(hit, "normalized_text", None),
            )
        else:
            timings = None
        if hit is not None and timings is not None:
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
                duration_seconds=float(hit.duration_seconds or 0.0),
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

        try:
            speech = await self.local.synthesize_timed(
                words=words,
                voice_id=voice_id,
                speed=speed,
                **self._audio_negotiation_kwargs(ctx),
            )
            if (
                cache_svc is not None
                and cache_target is not None
                and cache_target.can_store_on_miss
                and normalized_text
            ):
                cache_svc.schedule_store_cached_audio(
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
            if not self._can_fallback_unlocked_tts(ctx):
                logger.warning(
                    "tts_timed_fail provider=local reason=%s voice=%s ms=%.1f session=%s request_id=%s",
                    local_err.code,
                    voice_id,
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                raise
            backup_voice_id = _map_local_voice_to_google_backup(voice_id)
            timed = await self.google.synthesize_timed(
                words=words, voice_id=backup_voice_id, speed=speed
            )
            logger.info(
                "tts_timed_ok provider=google fallback=1 reason=%s voice=%s session=- request_id=%s",
                local_err.code,
                timed.resolved_voice_id,
                get_request_id(),
            )
            return replace(timed, used_fallback_voice=True)

    async def synthesize_phonics(
        self,
        *,
        steps: list[dict[str, Any]],
        requested_voice_id: str | None = None,
        speed: float = 1.0,
        policy: VoicePolicyContext | None = None,
        db: Any = None,
    ) -> LocalPhonicsSpeech:
        ctx = policy or VoicePolicyContext()
        voice_id = (requested_voice_id or "").strip() or DEFAULT_LOCAL_VOICE_ID
        t0 = time.perf_counter()

        if voice_id.startswith("google_"):
            self._validate_google_tts_allowed(ctx)
            speech = await self.google.synthesize_phonics(
                steps=steps, voice_id=voice_id, speed=speed
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

        phonics_key, _ = canonical_phonics_key(steps)
        cache_svc, cache_target, hit = await self._resolve_and_lookup_cache(
            db,
            ctx,
            normalized_text=phonics_key,
            voice_id=voice_id,
            speed=speed,
            require_word_timings=True,
        )
        if (
            hit is not None
            and isinstance(hit.word_timings_json, list)
            and len(hit.word_timings_json) == len(steps)
        ):
            timings = [
                LocalPhonicsStepTiming(
                    id=str(item["id"]),
                    index=int(item["index"]),
                    start=float(item["start"]),
                    end=float(item["end"]),
                )
                for item in hit.word_timings_json
            ]
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
                duration_seconds=float(hit.duration_seconds or 0.0),
                step_timings=timings,
                resolved_voice_id=hit.resolved_voice_id,
                region=self._voice_region(hit.resolved_voice_id),
                model_version=hit.model_version,
                provider="precomputed_cache",
                cache_hit=True,
                cache_scope=hit.scope,
                cached_speed=hit.cached_speed,
            )

        try:
            speech = await self.local.synthesize_phonics(
                steps=steps,
                voice_id=voice_id,
                speed=speed,
                **self._audio_negotiation_kwargs(ctx),
            )
            if (
                cache_svc is not None
                and cache_target is not None
                and cache_target.can_store_on_miss
            ):
                cache_svc.schedule_store_cached_audio(
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
            if not self._can_fallback_unlocked_tts(ctx):
                logger.warning(
                    "tts_phonics_fail provider=local reason=%s voice=%s ms=%.1f session=%s request_id=%s",
                    local_err.code,
                    voice_id,
                    (time.perf_counter() - t0) * 1000,
                    ctx.session_id or "-",
                    get_request_id(),
                )
                raise
            backup_voice_id = _map_local_voice_to_google_backup(voice_id)
            phonics = await self.google.synthesize_phonics(
                steps=steps, voice_id=backup_voice_id, speed=speed
            )
            logger.info(
                "tts_phonics_ok provider=google fallback=1 reason=%s voice=%s session=- request_id=%s",
                local_err.code,
                phonics.resolved_voice_id,
                get_request_id(),
            )
            return phonics

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
            if dedup_key is not None:
                _turn_results[dedup_key] = (time.monotonic(), result)
            if fut is not None and not fut.done():
                fut.set_result(result)
            return result
        except Exception as exc:
            if fut is not None and not fut.done():
                fut.set_exception(exc)
                _ = fut.exception()
            raise
        finally:
            if dedup_key is not None:
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
            res = await self.local.transcribe(
                audio=audio,
                filename=filename,
                content_type=content_type,
                language_code=language_code,
                source=ctx.source,
                session_id=ctx.session_id,
                turn_id=ctx.turn_id,
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
