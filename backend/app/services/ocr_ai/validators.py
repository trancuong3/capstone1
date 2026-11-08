from __future__ import annotations

import json
import unicodedata

from app.services.admin_ocr_chunking import OcrTextChunk, punctuation_signature
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.schemas import ChunkCorrectionResult


def _punctuation_boundary(value: str) -> tuple[str, str, str]:
    prefix_end = 0
    while (
        prefix_end < len(value)
        and unicodedata.category(value[prefix_end]).startswith("P")
    ):
        prefix_end += 1
    suffix_start = len(value)
    while (
        suffix_start > prefix_end
        and unicodedata.category(value[suffix_start - 1]).startswith("P")
    ):
        suffix_start -= 1
    return value[:prefix_end], value[prefix_end:suffix_start], value[suffix_start:]


def _invalid(provider: str, code: str = "INVALID_RESPONSE") -> OcrProviderError:
    return OcrProviderError(provider=provider, code=code, status_code=502)


def validate_chunk_result(
    payload: object, *, chunk: OcrTextChunk, provider: str
) -> ChunkCorrectionResult:
    if not isinstance(payload, dict) or set(payload) != {
        "chunk_id", "corrected_words", "uncertain_word_indices"
    }:
        raise _invalid(provider, "INVALID_OUTPUT_FIELDS")
    chunk_id = payload.get("chunk_id")
    words = payload.get("corrected_words")
    uncertain = payload.get("uncertain_word_indices")
    if (
        isinstance(chunk_id, bool)
        or not isinstance(chunk_id, int)
        or chunk_id != chunk.chunk_id
    ):
        raise _invalid(provider, "INVALID_OUTPUT_CHUNK_ID")
    if not isinstance(words, list) or len(words) != chunk.expected_word_count:
        raise _invalid(provider, "INVALID_OUTPUT_WORD_COUNT")
    if not isinstance(uncertain, list):
        raise _invalid(provider, "INVALID_OUTPUT_UNCERTAIN_INDICES")

    uncertain_indices: list[int] = []
    for index in uncertain:
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= chunk.expected_word_count
            or index in uncertain_indices
        ):
            raise _invalid(provider, "INVALID_OUTPUT_UNCERTAIN_INDICES")
        uncertain_indices.append(index)

    uncertain_set = set(uncertain_indices)
    source_cores = [_punctuation_boundary(token.text)[1] for token in chunk.tokens]
    corrected: list[str] = []
    for index, (source, candidate) in enumerate(zip(chunk.tokens, words, strict=True)):
        if (
            not isinstance(candidate, str)
            or not candidate
            or len(candidate) > 500
            or any(character.isspace() for character in candidate)
        ):
            raise _invalid(provider, "INVALID_OUTPUT_WORD")
        normalized = unicodedata.normalize("NFC", candidate)
        source_prefix, source_core, source_suffix = _punctuation_boundary(source.text)
        _, candidate_core, _ = _punctuation_boundary(normalized)
        if (
            not candidate_core
            or punctuation_signature(candidate_core)
            != punctuation_signature(source_core)
            or (punctuation_signature(source_core) and candidate_core != source_core)
        ):
            # When the model moves or changes punctuation inside a token, keep
            # the original token and surface it as uncertain. This avoids
            # failing the whole chunk or guessing punctuation alignment.
            corrected.append(source.text)
            uncertain_set.add(index)
            continue
        # Boundary punctuation is not an OCR correction target. Canonicalize it
        # from the source token so provider punctuation drift cannot reject a
        # valid spelling correction or leak into reconstructed text.
        normalized = source_prefix + candidate_core + source_suffix
        if punctuation_signature(source_core):
            normalized = source.text
        if index in uncertain_indices and normalized != source.text:
            corrected.append(source.text)
            uncertain_set.add(index)
            continue
        # A word copied from another source position may indicate model
        # reordering, but can also be a legitimate spelling correction. Keep
        # this source token unchanged instead of failing the whole chunk.
        if (
            normalized != source.text
            and candidate_core in source_cores
            and source_cores.index(candidate_core) != index
        ):
            corrected.append(source.text)
            uncertain_set.add(index)
            continue
        corrected.append(normalized)
    return ChunkCorrectionResult(
        chunk_id=chunk.chunk_id,
        corrected_words=tuple(corrected),
        uncertain_word_indices=tuple(sorted(uncertain_set)),
    )


def decode_and_validate_content(
    content: str, *, chunk: OcrTextChunk, provider: str
) -> ChunkCorrectionResult:
    if not isinstance(content, str) or not content.strip():
        raise _invalid(provider, "EMPTY_CONTENT")
    try:
        payload = json.loads(content)
    except (TypeError, ValueError) as exc:
        raise _invalid(provider, "INVALID_JSON") from exc
    return validate_chunk_result(payload, chunk=chunk, provider=provider)
