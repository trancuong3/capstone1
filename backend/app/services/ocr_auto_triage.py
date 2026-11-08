from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import replace
from typing import TypedDict

from app.services.admin_ocr_chunking import ChunkingError, chunk_ocr_text
from app.services.admin_ocr_local import (
    LocalCorrectionError,
    LocalOcrConfig,
    _crop_chunk_image,
    _prepare_source_image,
)
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.ollama_provider import OllamaOcrProvider
from app.services.ocr_engine import normalize_word


logger = logging.getLogger(__name__)
MAX_AUTO_TRIAGE_CHUNKS = 24
MAX_AUTO_TRIAGE_CHUNK_SECONDS = 20
MAX_AUTO_TRIAGE_TOTAL_SECONDS = 120


class LocalVisionDecision(TypedDict):
    result: str
    suggestion: str | None


async def triage_ocr_words_locally(
    image_bytes: bytes,
    text: str,
    words: list[dict[str, object]],
) -> dict[int, LocalVisionDecision]:
    """Use the configured loopback vision model to check OCR tokens against the image.

    This is best-effort and local-only. Model unavailability never fails OCR;
    untriaged tokens keep their existing evidence-based status.
    """
    uncertain_statuses = {"engine_disagreement", "needs_review"}

    try:
        config = LocalOcrConfig.from_environment()
        plan = chunk_ocr_text(text, config.chunking)
    except (LocalCorrectionError, ChunkingError, ValueError):
        return {}
    if len(plan.tokens) != len(words):
        return {}
    if any(
        normalize_word(token.text)
        != normalize_word(str(words[index].get("text", "")))
        for index, token in enumerate(plan.tokens)
    ):
        return {}

    try:
        prepared_image = await asyncio.to_thread(_prepare_source_image, image_bytes)
    except Exception as exc:
        logger.info(
            "Local OCR visual triage skipped during image preparation (%s)",
            type(exc).__name__,
        )
        return {}

    model_config = replace(
        config,
        timeout_seconds=min(config.timeout_seconds, MAX_AUTO_TRIAGE_CHUNK_SECONDS),
    )
    provider = OllamaOcrProvider(model_config)
    decisions: dict[int, LocalVisionDecision] = {}
    deadline = time.monotonic() + MAX_AUTO_TRIAGE_TOTAL_SECONDS

    prioritized_chunks = sorted(
        plan.chunks,
        key=lambda chunk: (
            -sum(
                words[index].get("ocr_review_status") in uncertain_statuses
                for index in range(chunk.start_token_index, chunk.end_token_index)
            ),
            chunk.start_token_index,
        ),
    )
    attempted_chunks = 0
    for chunk in prioritized_chunks:
        remaining_seconds = deadline - time.monotonic()
        if (
            remaining_seconds <= 0
            or attempted_chunks >= MAX_AUTO_TRIAGE_CHUNKS
        ):
            break
        attempted_chunks += 1
        try:
            crop = await asyncio.to_thread(
                _crop_chunk_image,
                prepared_image,
                [
                    tuple(words[index]["bbox"])
                    for index in range(chunk.start_token_index, chunk.end_token_index)
                ],
            )
            result = await asyncio.wait_for(
                provider.correct_chunk(
                    chunk=chunk,
                    image_bytes=crop,
                    image_mime_type="image/jpeg",
                ),
                timeout=min(MAX_AUTO_TRIAGE_CHUNK_SECONDS + 1, remaining_seconds),
            )
        except Exception as exc:
            logger.info(
                "Local OCR visual triage skipped for one chunk (%s)",
                type(exc).__name__,
            )
            if isinstance(exc, (asyncio.TimeoutError, OcrProviderError)):
                break
            continue

        uncertain_indices = set(result.uncertain_word_indices)
        for local_index, candidate in enumerate(result.corrected_words):
            word_index = chunk.start_token_index + local_index
            if local_index in uncertain_indices:
                decisions[word_index] = {"result": "uncertain", "suggestion": None}
            elif normalize_word(candidate) == normalize_word(str(words[word_index]["text"])):
                decisions[word_index] = {"result": "match", "suggestion": None}
            else:
                decisions[word_index] = {
                    "result": "mismatch",
                    "suggestion": candidate,
                }

    return decisions
