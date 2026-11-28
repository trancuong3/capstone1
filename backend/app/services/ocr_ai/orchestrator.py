from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import replace

from app.diagnostic_logging import log_diagnostic
from app.services.ai_capability_router import (
    CircuitBreakerRegistry,
    CircuitState,
    get_shared_ai_circuit_breaker,
)
from app.services.admin_ocr_chunking import ChunkingError, chunk_ocr_text, reconstruct_ocr_text
from app.services.admin_ocr_local import (
    LocalCorrectionError,
    _crop_chunk_image,
    _prepare_source_image,
)
from app.services.ocr_ai.base import OcrCorrectionProvider
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import (
    OcrConfigurationError,
    OcrOrchestrationError,
    OcrProviderError,
)
from app.services.ocr_ai.gemini_provider import GeminiOcrProvider
from app.services.ocr_ai.groq_provider import GroqOcrProvider
from app.services.ocr_ai.ollama_provider import OllamaOcrProvider
from app.services.ocr_ai.runtime import (
    classify_ocr_provider_error,
    is_cloud_family,
    provider_circuit_key,
    quota_circuit_key,
)


logger = logging.getLogger(__name__)


class OcrCorrectionOrchestrator:
    """Correct chunks in strict provider order, without persistence or fan-out.

    The product policy is fail-closed: if no provider yields a valid response for
    any chunk, the whole job fails and no partial suggestion is returned.  The
    source draft is therefore untouched.
    """

    def __init__(
        self,
        config: OcrCorrectionConfig,
        *,
        providers: Sequence[OcrCorrectionProvider] | None = None,
        circuit_breaker: CircuitBreakerRegistry | None = None,
    ) -> None:
        self.config = config
        self._owns_providers = providers is None
        self._circuit_breaker: CircuitBreakerRegistry | None = (
            circuit_breaker
            if circuit_breaker is not None
            else (get_shared_ai_circuit_breaker() if providers is None else None)
        )
        self.providers = tuple(providers) if providers is not None else self._providers()
        if config.cloud_enabled:
            for provider, configured in (
                ("gemini", config.gemini_api_key is not None),
                ("groq", config.groq_api_key is not None),
            ):
                if not configured:
                    log_diagnostic(
                        logger,
                        logging.WARNING,
                        event="ocr_provider_unconfigured",
                        stage="provider_configuration",
                        provider=provider,
                        reason_code="MISSING_CREDENTIAL",
                    )

    def _providers(self) -> tuple[OcrCorrectionProvider, ...]:
        providers: list[OcrCorrectionProvider] = []
        if self.config.gemini_enabled:
            assert self.config.gemini_api_key is not None
            providers.append(
                GeminiOcrProvider(
                    name="gemini_3_5",
                    model=self.config.gemini_primary_model,
                    api_key=self.config.gemini_api_key,
                    timeout_seconds=self.config.cloud_timeout_seconds,
                )
            )
        if self.config.gemini_enabled:
            assert self.config.gemini_api_key is not None
            providers.append(
                GeminiOcrProvider(
                    name="gemini_3_1",
                    model=self.config.gemini_fallback_model,
                    api_key=self.config.gemini_api_key,
                    timeout_seconds=self.config.cloud_timeout_seconds,
                )
            )
        if self.config.groq_enabled:
            assert self.config.groq_api_key is not None
            providers.append(
                GroqOcrProvider(
                    model=self.config.groq_model,
                    api_key=self.config.groq_api_key,
                    timeout_seconds=self.config.cloud_timeout_seconds,
                )
            )
        if self.config.local_enabled:
            providers.append(OllamaOcrProvider(self.config.local))
        return tuple(providers)

    async def correct(
        self,
        text: str,
        image_bytes: bytes,
        word_boxes: list[tuple[float, float, float, float]],
        *,
        on_progress: Callable[[int, int], None] | None = None,
        on_provider_event: Callable[[dict[str, object]], None] | None = None,
        on_uncertain_tokens: Callable[[int, tuple[int, ...]], None] | None = None,
        word_normalizer: Callable[[str], str] | None = None,
    ) -> str:
        if not self.providers:
            raise OcrConfigurationError("NO_AI_PROVIDER_CONFIGURED")
        try:
            plan = chunk_ocr_text(
                text,
                self.config.local.chunking,
                word_normalizer=word_normalizer,
            )
        except ChunkingError as exc:
            raise OcrOrchestrationError("INVALID_CHUNK_PLAN") from exc
        if len(word_boxes) != len(plan.tokens):
            raise OcrOrchestrationError("WORD_BOX_MISMATCH")
        try:
            prepared_image = await asyncio.to_thread(_prepare_source_image, image_bytes)
        except LocalCorrectionError as exc:
            raise OcrOrchestrationError("SOURCE_IMAGE_UNAVAILABLE") from exc

        deadline = time.monotonic() + float(self.config.total_timeout_seconds)

        async def run() -> str:
            corrected_by_chunk: dict[int, tuple[str, ...]] = {}
            disabled_families: set[str] = set()
            disabled_providers: set[str] = set()
            healthy_providers: set[str] = set()
            for chunk in plan.chunks:
                try:
                    crop = await asyncio.to_thread(
                        _crop_chunk_image,
                        prepared_image,
                        word_boxes[chunk.start_token_index : chunk.end_token_index],
                    )
                except LocalCorrectionError as exc:
                    raise OcrOrchestrationError("CHUNK_IMAGE_UNAVAILABLE") from exc
                result = await self._correct_chunk(
                    chunk_id=chunk.chunk_id,
                    chunk=chunk,
                    crop=crop,
                    disabled_families=disabled_families,
                    disabled_providers=disabled_providers,
                    healthy_providers=healthy_providers,
                    deadline=deadline,
                    on_provider_event=on_provider_event,
                    on_uncertain_tokens=on_uncertain_tokens,
                )
                corrected_by_chunk[chunk.chunk_id] = result.corrected_words
                if on_progress is not None:
                    on_progress(len(corrected_by_chunk), len(plan.chunks))
            try:
                return reconstruct_ocr_text(plan, corrected_by_chunk)
            except ChunkingError as exc:
                raise OcrOrchestrationError("RECONSTRUCTION_REJECTED") from exc

        try:
            return await asyncio.wait_for(run(), timeout=self.config.total_timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise OcrOrchestrationError("DOCUMENT_TIMEOUT") from exc
        finally:
            if self._owns_providers:
                for provider in self.providers:
                    close_fn = getattr(provider, "aclose", None)
                    if callable(close_fn):
                        try:
                            await close_fn()
                        except Exception:
                            pass

    @staticmethod
    def _is_local_provider(provider: OcrCorrectionProvider) -> bool:
        return provider.family == "ollama" or provider.name.lower().startswith("ollama")

    def _cloud_attempt_timeout(
        self,
        *,
        provider: OcrCorrectionProvider,
        disabled_families: set[str],
        disabled_providers: set[str] | None = None,
        deadline: float | None,
    ) -> float | None:
        if deadline is None or self._is_local_provider(provider):
            return None
        skipped_providers = disabled_providers or set()
        current_index = self.providers.index(provider)
        remaining_after = [
            candidate
            for candidate in self.providers[current_index:]
            if candidate.family not in disabled_families
            and candidate.name not in skipped_providers
        ]
        has_local_fallback = any(
            self._is_local_provider(candidate) for candidate in remaining_after
        )
        if not has_local_fallback:
            return float(self.config.cloud_timeout_seconds)
        remaining_cloud = [
            candidate
            for candidate in remaining_after
            if not self._is_local_provider(candidate)
        ]
        local_reserve = (
            float(self.config.local.timeout_seconds)
            if float(self.config.total_timeout_seconds)
            > float(self.config.local.timeout_seconds)
            else float(self.config.total_timeout_seconds) * 0.5
        )
        cloud_remaining = (deadline - local_reserve) - time.monotonic()
        if cloud_remaining <= 0:
            return 0.0
        per_provider_share = cloud_remaining / max(1, len(remaining_cloud))
        return min(float(self.config.cloud_timeout_seconds), per_provider_share)

    async def _correct_chunk(
        self, *, chunk_id, chunk, crop, disabled_families, deadline=None,
        disabled_providers=None, healthy_providers=None,
        on_provider_event=None, on_uncertain_tokens=None,
    ):
        if disabled_providers is None:
            disabled_providers = set()
        if healthy_providers is None:
            healthy_providers = set()
        attempted = False
        has_valid_response = False
        has_valid_cloud_response = False
        working_words = [token.text for token in chunk.tokens]
        unresolved_indices = set(range(chunk.expected_word_count))
        request_chunk = chunk
        for provider in self.providers:
            if provider.name in disabled_providers or provider.family in disabled_families:
                continue
            is_local = self._is_local_provider(provider)
            # Uncertainty is not provider unavailability. Once a cloud model
            # has returned a schema-valid answer, unresolved words stay for
            # Admin review after the remaining cloud providers are tried.
            if is_local and has_valid_cloud_response:
                continue
            cb = self._circuit_breaker
            provider_key: str | None = None
            quota_key: str | None = None
            prov_probe_acquired = False
            quota_probe_acquired = False
            if cb is not None and not is_local and is_cloud_family(provider.family):
                provider_key = provider_circuit_key(provider.name)
                quota_key = quota_circuit_key(provider.family)
                if quota_key is not None:
                    quota_allowed, quota_state = cb.allow_request(quota_key)
                    if not quota_allowed:
                        log_diagnostic(
                            logger,
                            logging.INFO,
                            event="ocr_provider_circuit_skipped",
                            stage="chunk_correction",
                            provider=provider.name,
                            quota_group=quota_key,
                            circuit_state=quota_state.value,
                            chunk_id=chunk_id,
                        )
                        continue
                    quota_probe_acquired = quota_state == CircuitState.HALF_OPEN
                prov_allowed, prov_state = cb.allow_request(provider_key)
                if not prov_allowed:
                    if quota_probe_acquired and quota_key is not None:
                        cb.release_half_open_probe(quota_key)
                    log_diagnostic(
                        logger,
                        logging.INFO,
                        event="ocr_provider_circuit_skipped",
                        stage="chunk_correction",
                        provider=provider.name,
                        circuit_state=prov_state.value,
                        chunk_id=chunk_id,
                    )
                    continue
                prov_probe_acquired = prov_state == CircuitState.HALF_OPEN
            attempted = True
            started = time.perf_counter()
            attempt_number = sum(
                1 for prior in self.providers[: self.providers.index(provider)]
                if prior.family not in disabled_families and prior.name not in disabled_providers
            )
            log_diagnostic(
                logger,
                logging.INFO,
                event="ocr_provider_started",
                stage="chunk_correction",
                provider=provider.name,
                model=getattr(provider, "model", None),
                chunk_id=chunk_id,
            )
            self._emit_provider_event(
                on_provider_event,
                provider=provider,
                chunk_id=chunk_id,
                status="started",
                availability=None,
                error_code=None,
                http_status=None,
                duration_ms=0,
                retry_count=max(0, attempt_number),
            )
            try:
                cloud_timeout = self._cloud_attempt_timeout(
                    provider=provider,
                    disabled_families=disabled_families,
                    disabled_providers=disabled_providers,
                    deadline=deadline,
                )
                if cloud_timeout is not None and cloud_timeout <= 0:
                    raise OcrProviderError(
                        provider=provider.name,
                        code="BUDGET_EXHAUSTED",
                        status_code=504,
                        disables_family=False,
                    )
                coro = provider.correct_chunk(
                    chunk=request_chunk,
                    image_bytes=crop,
                    image_mime_type="image/jpeg",
                )
                if cloud_timeout is not None:
                    try:
                        result = await asyncio.wait_for(coro, timeout=cloud_timeout)
                    except asyncio.TimeoutError as exc:
                        raise OcrProviderError(
                            provider=provider.name,
                            code="PROVIDER_TIMEOUT",
                            status_code=504,
                            disables_family=True,
                        ) from exc
                else:
                    result = await coro
            except OcrProviderError as exc:
                if cb is not None and provider_key is not None and exc.code != "BUDGET_EXHAUSTED":
                    kind, trips_quota = classify_ocr_provider_error(
                        exc.code, exc.upstream_status_code
                    )
                    if kind is not None:
                        cb.record_failure(
                            provider_key,
                            kind=kind,
                            http_status=exc.upstream_status_code,
                            limit_zero=exc.limit_zero,
                            retry_after_seconds=exc.retry_after_seconds,
                        )
                        prov_probe_acquired = False
                        # Isolate per-model daily `limit: 0` caps to `provider:*` so healthy
                        # sibling models in the same family are never locked out for 6 hours.
                        if trips_quota and quota_key is not None and not exc.limit_zero:
                            cb.record_failure(
                                quota_key,
                                kind=kind,
                                http_status=exc.upstream_status_code,
                                limit_zero=False,
                                retry_after_seconds=exc.retry_after_seconds,
                            )
                            quota_probe_acquired = False
                if exc.disables_family:
                    is_family_wide_error = (
                        not exc.limit_zero
                        and (
                            exc.code in {"PROVIDER_AUTHENTICATION", "PROVIDER_QUOTA"}
                            or exc.upstream_status_code in {401, 403, 429}
                        )
                    )
                    if is_family_wide_error:
                        disabled_families.add(provider.family)
                    else:
                        disabled_providers.add(provider.name)
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                self._emit_provider_event(
                    on_provider_event,
                    provider=provider,
                    chunk_id=chunk_id,
                    status="failed",
                    availability=False,
                    error_code=exc.code,
                    http_status=exc.upstream_status_code,
                    duration_ms=elapsed_ms,
                    retry_count=max(0, attempt_number),
                )
                next_provider = self._next_provider_name(
                    provider, disabled_families,
                    disabled_providers=disabled_providers,
                    skip_local=has_valid_cloud_response,
                )
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="ocr_provider_fallback",
                    stage="chunk_correction",
                    exception=exc,
                    provider=provider.name,
                    model=getattr(provider, "model", None),
                    next_provider=next_provider,
                    reason_code=exc.code,
                    provider_http_status=exc.upstream_status_code,
                    provider_error_type=exc.upstream_error_type,
                    provider_error_code=exc.upstream_error_code,
                    provider_request_id=exc.upstream_request_id,
                    chunk_id=chunk_id,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                )
                continue
            except Exception as exc:
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                self._emit_provider_event(
                    on_provider_event,
                    provider=provider,
                    chunk_id=chunk_id,
                    status="failed",
                    availability=False,
                    error_code="PROVIDER_INTERNAL_ERROR",
                    http_status=None,
                    duration_ms=elapsed_ms,
                    retry_count=max(0, attempt_number),
                )
                next_provider = self._next_provider_name(
                    provider, disabled_families,
                    disabled_providers=disabled_providers,
                    skip_local=has_valid_cloud_response,
                )
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="ocr_provider_fallback",
                    stage="chunk_correction",
                    exception=exc,
                    provider=provider.name,
                    model=getattr(provider, "model", None),
                    next_provider=next_provider,
                    reason_code="PROVIDER_INTERNAL_ERROR",
                    chunk_id=chunk_id,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                )
                continue
            finally:
                if cb is not None:
                    if prov_probe_acquired and provider_key is not None:
                        cb.release_half_open_probe(provider_key)
                    if quota_probe_acquired and quota_key is not None:
                        cb.release_half_open_probe(quota_key)
            if cb is not None and provider_key is not None:
                cb.record_success(provider_key)
                if quota_key is not None:
                    cb.record_success(quota_key)
            has_valid_response = True
            healthy_providers.add(provider.name)
            if not is_local:
                has_valid_cloud_response = True
            uncertain = set(result.uncertain_word_indices)
            for index in unresolved_indices - uncertain:
                working_words[index] = result.corrected_words[index]
            unresolved_indices.intersection_update(uncertain)
            if unresolved_indices:
                self._emit_provider_event(
                    on_provider_event,
                    provider=provider,
                    chunk_id=chunk_id,
                    status="uncertain",
                    availability=True,
                    error_code="UNCERTAIN_TOKENS",
                    http_status=200,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    retry_count=max(0, attempt_number),
                )
                request_chunk = self._chunk_with_words(chunk, working_words)
                next_provider = self._next_provider_name(
                    provider, disabled_families,
                    disabled_providers=disabled_providers,
                    skip_local=has_valid_cloud_response,
                )
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="ocr_provider_fallback",
                    stage="chunk_correction",
                    provider=provider.name,
                    model=getattr(provider, "model", None),
                    next_provider=next_provider,
                    reason_code="UNCERTAIN_TOKENS",
                    uncertain_count=len(unresolved_indices),
                    chunk_id=chunk_id,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                )
                continue
            log_diagnostic(
                logger,
                logging.INFO,
                event="ocr_provider_succeeded",
                stage="chunk_correction",
                provider=provider.name,
                model=getattr(provider, "model", None),
                chunk_id=chunk_id,
                elapsed_ms=int((time.perf_counter() - started) * 1000),
            )
            self._emit_provider_event(
                on_provider_event,
                provider=provider,
                chunk_id=chunk_id,
                status="succeeded",
                availability=True,
                error_code=None,
                http_status=200,
                duration_ms=int((time.perf_counter() - started) * 1000),
                retry_count=max(0, attempt_number),
            )
            return replace(
                result,
                corrected_words=tuple(working_words),
                uncertain_word_indices=(),
            )
        if has_valid_response:
            if on_uncertain_tokens is not None and unresolved_indices:
                uncertain_global_indices = tuple(
                    chunk.tokens[index].index for index in sorted(unresolved_indices)
                )
                try:
                    on_uncertain_tokens(chunk_id, uncertain_global_indices)
                except Exception:
                    logger.warning("OCR uncertain-token callback failed")
            log_diagnostic(
                logger,
                logging.WARNING,
                event="ocr_uncertain_tokens_preserved",
                stage="chunk_correction",
                chunk_id=chunk_id,
                uncertain_count=len(unresolved_indices),
            )
            return replace(
                result,
                corrected_words=tuple(working_words),
                uncertain_word_indices=tuple(sorted(unresolved_indices)),
            )
        code = "ALL_PROVIDERS_SKIPPED" if not attempted else "ALL_PROVIDERS_FAILED"
        raise OcrOrchestrationError(code)

    @staticmethod
    def _emit_provider_event(
        callback, *, provider, chunk_id, status, availability,
        error_code, http_status, duration_ms, retry_count,
    ) -> None:
        if callback is None:
            return
        event = {
            "provider": provider.name,
            "model": getattr(provider, "model", None),
            "chunk_id": chunk_id,
            "status": status,
            "availability": availability,
            "error_code": error_code,
            "http_status": http_status,
            "duration_ms": duration_ms,
            "retry_count": retry_count,
            "successful_chunks": int(status in {"succeeded", "uncertain"}),
            "failed_chunks": int(status == "failed"),
        }
        try:
            callback(event)
        except Exception:
            # Monitoring hooks must not change correction outcome.
            logger.warning("OCR provider monitoring callback failed")

    @staticmethod
    def _chunk_with_words(chunk, words):
        """Build the next provider's input with resolved words held fixed."""
        first_start = chunk.tokens[0].start
        cursor = 0
        pieces: list[str] = []
        updated_tokens = []
        for token, word in zip(chunk.tokens, words, strict=True):
            relative_start = token.start - first_start
            relative_end = token.end - first_start
            pieces.append(chunk.target_text[cursor:relative_start])
            pieces.append(word)
            cursor = relative_end
            updated_tokens.append(replace(token, text=word))
        pieces.append(chunk.target_text[cursor:])
        return replace(
            chunk,
            target_text="".join(pieces),
            tokens=tuple(updated_tokens),
        )

    def _next_provider_name(
        self, current: OcrCorrectionProvider, disabled_families: set[str],
        *, disabled_providers: set[str] | None = None, skip_local: bool = False,
    ) -> str:
        skipped_providers = disabled_providers or set()
        current_index = self.providers.index(current)
        for provider in self.providers[current_index + 1 :]:
            if provider.family not in disabled_families and provider.name not in skipped_providers:
                if skip_local and (
                    provider.family == "ollama"
                    or provider.name.lower().startswith("ollama")
                ):
                    continue
                return provider.name
        return "none"
