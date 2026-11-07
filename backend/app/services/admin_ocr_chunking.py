from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass


_TOKEN_PATTERN = re.compile(r"\S+", re.UNICODE)
_SENTENCE_END = re.compile(r"""[.!?…][\]\)}"'’”]*$""", re.UNICODE)


def punctuation_signature(value: str) -> tuple[str, ...]:
    return tuple(
        character
        for character in value
        if unicodedata.category(character).startswith("P")
    )


class ChunkingError(ValueError):
    """The OCR text or chunking configuration cannot be processed safely."""


@dataclass(frozen=True)
class OcrToken:
    index: int
    start: int
    end: int
    text: str


@dataclass(frozen=True)
class OcrTextChunk:
    chunk_id: int
    start_token_index: int
    end_token_index: int
    expected_word_count: int
    target_text: str
    previous_context: str
    next_context: str
    tokens: tuple[OcrToken, ...]


@dataclass(frozen=True)
class OcrChunkPlan:
    text: str
    tokens: tuple[OcrToken, ...]
    chunks: tuple[OcrTextChunk, ...]


@dataclass(frozen=True)
class ChunkingConfig:
    max_bytes: int = 3072
    max_words: int = 48
    max_chunks: int = 128
    context_bytes: int = 160
    max_document_bytes: int = 196608

    @classmethod
    def from_environment(cls) -> "ChunkingConfig":
        return cls(
            max_bytes=_read_int("LOCAL_OCR_MAX_CHUNK_BYTES", 3072, 256, 8192),
            max_words=_read_int("LOCAL_OCR_MAX_CHUNK_WORDS", 48, 8, 512),
            max_chunks=_read_int("LOCAL_OCR_MAX_CHUNKS", 128, 1, 256),
            context_bytes=_read_int("LOCAL_OCR_CONTEXT_BYTES", 160, 0, 4096),
            max_document_bytes=_read_int(
                "LOCAL_OCR_MAX_DOCUMENT_BYTES", 196608, 1024, 500000
            ),
        )


def _read_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ChunkingError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ChunkingError(f"{name} must be between {minimum} and {maximum}")
    return value


def _tokens(text: str) -> tuple[OcrToken, ...]:
    return tuple(
        OcrToken(index=index, start=match.start(), end=match.end(), text=match.group(0))
        for index, match in enumerate(_TOKEN_PATTERN.finditer(text))
    )


def _boundary_kind(text: str, tokens: tuple[OcrToken, ...], left_index: int) -> int:
    """Return priority: paragraph, line, sentence, or whitespace."""
    left = tokens[left_index]
    right = tokens[left_index + 1]
    separator = text[left.end:right.start]
    if separator.count("\n") >= 2:
        return 4
    if "\n" in separator or "\r" in separator:
        return 3
    if _SENTENCE_END.search(left.text):
        return 2
    return 1


def _context_before(text: str, start: int, limit: int) -> str:
    if limit <= 0 or start <= 0:
        return ""
    raw = text[:start].encode("utf-8")
    return raw[-limit:].decode("utf-8", errors="ignore").lstrip()


def _context_after(text: str, end: int, limit: int) -> str:
    if limit <= 0 or end >= len(text):
        return ""
    raw = text[end:].encode("utf-8")
    return raw[:limit].decode("utf-8", errors="ignore").rstrip()


def chunk_ocr_text(
    value: str,
    config: ChunkingConfig | None = None,
) -> OcrChunkPlan:
    """Split NFC text under strict UTF-8 byte and token budgets."""
    config = config or ChunkingConfig.from_environment()
    text = unicodedata.normalize("NFC", value)
    if len(text.encode("utf-8")) > config.max_document_bytes:
        raise ChunkingError("OCR text exceeds LOCAL_OCR_MAX_DOCUMENT_BYTES")
    tokens = _tokens(text)
    if not tokens:
        raise ChunkingError("OCR text must contain at least one token")
    if min(config.max_bytes, config.max_words, config.max_chunks, config.max_document_bytes) < 1 or config.context_bytes < 0:
        raise ChunkingError("Chunking limits are invalid")

    ranges: list[tuple[int, int]] = []
    start_index = 0
    while start_index < len(tokens):
        possible_end = start_index
        while possible_end < len(tokens) and possible_end - start_index < config.max_words:
            candidate_bytes = len(
                text[tokens[start_index].start : tokens[possible_end].end].encode("utf-8")
            )
            if candidate_bytes > config.max_bytes:
                break
            possible_end += 1

        if possible_end == start_index:
            raise ChunkingError("A source word exceeds LOCAL_OCR_MAX_CHUNK_BYTES")
        if possible_end == len(tokens):
            end_index = possible_end
        else:
            chosen = None
            for priority in (4, 3, 2):
                for boundary in range(possible_end, start_index, -1):
                    if _boundary_kind(text, tokens, boundary - 1) == priority:
                        chosen = boundary
                        break
                if chosen is not None:
                    break
            end_index = chosen if chosen is not None else possible_end

        ranges.append((start_index, end_index))
        if len(ranges) > config.max_chunks:
            raise ChunkingError("OCR text exceeds LOCAL_OCR_MAX_CHUNKS")
        start_index = end_index

    chunks: list[OcrTextChunk] = []
    for chunk_id, (start_index, end_index) in enumerate(ranges):
        chunk_tokens = tokens[start_index:end_index]
        start_char = chunk_tokens[0].start
        end_char = chunk_tokens[-1].end
        chunks.append(
            OcrTextChunk(
                chunk_id=chunk_id,
                start_token_index=start_index,
                end_token_index=end_index,
                expected_word_count=end_index - start_index,
                target_text=text[start_char:end_char],
                previous_context=_context_before(text, start_char, config.context_bytes),
                next_context=_context_after(text, end_char, config.context_bytes),
                tokens=chunk_tokens,
            )
        )
    return OcrChunkPlan(text=text, tokens=tokens, chunks=tuple(chunks))


def reconstruct_ocr_text(
    plan: OcrChunkPlan,
    corrected_tokens_by_chunk: dict[int, tuple[str, ...] | list[str]],
) -> str:
    """Replace spelling only; retain every source punctuation and whitespace span."""
    expected_ids = {chunk.chunk_id for chunk in plan.chunks}
    if set(corrected_tokens_by_chunk) != expected_ids:
        raise ChunkingError("Corrected chunks are missing or duplicated")

    replacements: dict[int, str] = {}
    for chunk in plan.chunks:
        corrected = corrected_tokens_by_chunk[chunk.chunk_id]
        if len(corrected) != chunk.expected_word_count:
            raise ChunkingError("Corrected chunk token count does not match its source")
        for token, value in zip(chunk.tokens, corrected, strict=True):
            normalized = unicodedata.normalize("NFC", value)
            if not normalized or any(character.isspace() for character in normalized):
                raise ChunkingError("Each corrected token must contain one non-empty token")
            prefix_end = 0
            while (
                prefix_end < len(token.text)
                and unicodedata.category(token.text[prefix_end]).startswith("P")
            ):
                prefix_end += 1
            suffix_start = len(token.text)
            while (
                suffix_start > prefix_end
                and unicodedata.category(token.text[suffix_start - 1]).startswith("P")
            ):
                suffix_start -= 1
            source_core = token.text[prefix_end:suffix_start]
            if punctuation_signature(source_core):
                # Leave tokens with internal punctuation untouched; its position
                # cannot be safely inferred after a spelling change.
                normalized = token.text
            elif source_core:
                corrected_core = "".join(
                    character
                    for character in normalized
                    if not unicodedata.category(character).startswith("P")
                )
                if not corrected_core:
                    raise ChunkingError("Correction removed the source word")
                normalized = (
                    token.text[:prefix_end]
                    + corrected_core
                    + token.text[suffix_start:]
                )
            else:
                # Punctuation-only tokens are retained verbatim.
                normalized = token.text
            if token.index in replacements:
                raise ChunkingError("A source token was corrected more than once")
            replacements[token.index] = normalized

    if set(replacements) != set(range(len(plan.tokens))):
        raise ChunkingError("Corrected text is missing one or more source tokens")

    pieces: list[str] = []
    cursor = 0
    for token in plan.tokens:
        pieces.append(plan.text[cursor:token.start])
        pieces.append(replacements[token.index])
        cursor = token.end
    pieces.append(plan.text[cursor:])
    result = unicodedata.normalize("NFC", "".join(pieces))
    if len(_tokens(result)) != len(plan.tokens):
        raise ChunkingError("Reconstructed text changed the original token count")
    return result
