from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import replace

from app.diagnostic_logging import log_diagnostic
from app.services.admin_ocr_chunking import ChunkingError, chunk_ocr_text, reconstruct_ocr_text
from app.services.admin_ocr_local import (
    LocalCorrectionError,
    _crop_chunk_image,
    _prepare_source_image,
)
from app.services.ocr_ai.base import OcrCorrectionProvider
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrOrchestrationError, OcrProviderError
from app.services.ocr_ai.gemini_provider import GeminiOcrProvider
from app.services.ocr_ai.groq_provider import GroqOcrProvider
from app.services.ocr_ai.ollama_provider import OllamaOcrProvider


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
    ) -> None:
        self.config = config
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

    @staticmethod
    def _is_local_provider(provider: OcrCorrectionProvider) -> bool:
        return provider.family == "ollama" or provider.name.lower().startswith("ollama")

    def _cloud_attempt_timeout(
        self,
        *,
        provider: OcrCorrectionProvider,
        disabled_families: set[str],
        deadline: float | None,
    ) -> float | None:
        if deadline is None or self._is_local_provider(provider):
            return None
        current_index = self.providers.index(provider)
        remaining_after = [
            candidate
            for candidate in self.providers[current_index:]
            if candidate.family not in disabled_families
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
        on_provider_event=None, on_uncertain_tokens=None,
    ):
        attempted = False
        has_valid_response = False
        has_valid_cloud_response = False
        working_words = [token.text for token in chunk.tokens]
        unresolved_indices = set(range(chunk.expected_word_count))
        request_chunk = chunk
        for provider in self.providers:
            if provider.family in disabled_families:
                continue
            is_local = self._is_local_provider(provider)
            # Uncertainty is not provider unavailability. Once a cloud model
            # has returned a schema-valid answer, unresolved words stay for
            # Admin review after the remaining cloud providers are tried.
            if is_local and has_valid_cloud_response:
                continue
            attempted = True
            started = time.perf_counter()
            attempt_number = sum(
                1 for prior in self.providers[: self.providers.index(provider)]
                if prior.family not in disabled_families
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
                    deadline=deadline,
                )
                if cloud_timeout is not None and cloud_timeout <= 0:
                    raise OcrProviderError(
                        provider=provider.name,
                        code="PROVIDER_TIMEOUT",
                        status_code=504,
                        disables_family=True,
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
                if exc.disables_family:
                    disabled_families.add(provider.family)
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
            has_valid_response = True
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
        *, skip_local: bool = False,
    ) -> str:
        current_index = self.providers.index(current)
        for provider in self.providers[current_index + 1 :]:
            if provider.family not in disabled_families:
                if skip_local and (
                    provider.family == "ollama"
                    or provider.name.lower().startswith("ollama")
                ):
                    continue
                return provider.name
        return "none"
