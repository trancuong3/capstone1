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
        if self.config.groq_enabled:
            assert self.config.groq_api_key is not None
            providers.append(
                GroqOcrProvider(
                    model=self.config.groq_model,
                    api_key=self.config.groq_api_key,
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
        providers.append(OllamaOcrProvider(self.config.local))
        return tuple(providers)

    async def correct(
        self,
        text: str,
        image_bytes: bytes,
        word_boxes: list[tuple[float, float, float, float]],
        *,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> str:
        try:
            plan = chunk_ocr_text(text, self.config.local.chunking)
        except ChunkingError as exc:
            raise OcrOrchestrationError("INVALID_CHUNK_PLAN") from exc
        if len(word_boxes) != len(plan.tokens):
            raise OcrOrchestrationError("WORD_BOX_MISMATCH")
        try:
            prepared_image = await asyncio.to_thread(_prepare_source_image, image_bytes)
        except LocalCorrectionError as exc:
            raise OcrOrchestrationError("SOURCE_IMAGE_UNAVAILABLE") from exc

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

    async def _correct_chunk(self, *, chunk_id, chunk, crop, disabled_families):
        attempted = False
        has_valid_response = False
        working_words = [token.text for token in chunk.tokens]
        unresolved_indices = set(range(chunk.expected_word_count))
        request_chunk = chunk
        for provider in self.providers:
            if provider.family in disabled_families:
                continue
            attempted = True
            started = time.perf_counter()
            log_diagnostic(
                logger,
                logging.INFO,
                event="ocr_provider_started",
                stage="chunk_correction",
                provider=provider.name,
                model=getattr(provider, "model", None),
                chunk_id=chunk_id,
            )
            try:
                result = await provider.correct_chunk(
                    chunk=request_chunk,
                    image_bytes=crop,
                    image_mime_type="image/jpeg",
                )
            except OcrProviderError as exc:
                if exc.disables_family:
                    disabled_families.add(provider.family)
                next_provider = self._next_provider_name(provider, disabled_families)
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
                    chunk_id=chunk_id,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                )
                continue
            except Exception as exc:
                next_provider = self._next_provider_name(provider, disabled_families)
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
            uncertain = set(result.uncertain_word_indices)
            for index in unresolved_indices - uncertain:
                working_words[index] = result.corrected_words[index]
            unresolved_indices.intersection_update(uncertain)
            if unresolved_indices:
                request_chunk = self._chunk_with_words(chunk, working_words)
                next_provider = self._next_provider_name(provider, disabled_families)
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
            return replace(
                result,
                corrected_words=tuple(working_words),
                uncertain_word_indices=(),
            )
        if has_valid_response:
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
        self, current: OcrCorrectionProvider, disabled_families: set[str]
    ) -> str:
        current_index = self.providers.index(current)
        for provider in self.providers[current_index + 1 :]:
            if provider.family not in disabled_families:
                return provider.name
        return "none"
