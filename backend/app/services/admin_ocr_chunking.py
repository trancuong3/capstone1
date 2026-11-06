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
    max_chars: int = 5000
    max_chunks: int = 64
    context_chars: int = 320

    @classmethod
    def from_environment(cls) -> "ChunkingConfig":
        max_chars = _read_int("GEMINI_OCR_CHUNK_MAX_CHARS", 5000, 100, 50_000)
        max_chunks = _read_int("GEMINI_OCR_MAX_CHUNKS", 64, 1, 500)
        context_chars = _read_int("GEMINI_OCR_CONTEXT_MAX_CHARS", 320, 0, 4000)
        return cls(max_chars=max_chars, max_chunks=max_chunks, context_chars=context_chars)


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
    excerpt = text[max(0, start - limit):start]
    return excerpt.lstrip()


def _context_after(text: str, end: int, limit: int) -> str:
    if limit <= 0 or end >= len(text):
        return ""
    excerpt = text[end:min(len(text), end + limit)]
    return excerpt.rstrip()


def chunk_ocr_text(
    value: str,
    config: ChunkingConfig | None = None,
) -> OcrChunkPlan:
    """Split NFC text at whitespace token boundaries and retain source offsets."""
    config = config or ChunkingConfig.from_environment()
    text = unicodedata.normalize("NFC", value)
    tokens = _tokens(text)
    if not tokens:
        raise ChunkingError("OCR text must contain at least one token")
    if config.max_chars < 1 or config.max_chunks < 1 or config.context_chars < 0:
        raise ChunkingError("Chunking limits are invalid")

    ranges: list[tuple[int, int]] = []
    start_index = 0
    while start_index < len(tokens):
        possible_end = start_index
        while possible_end < len(tokens):
            candidate_length = tokens[possible_end].end - tokens[start_index].start
            if candidate_length > config.max_chars:
                break
            possible_end += 1

        if possible_end == start_index:
            raise ChunkingError(
                f"Token {start_index} exceeds GEMINI_OCR_CHUNK_MAX_CHARS"
            )
        if possible_end == len(tokens):
            end_index = possible_end
        else:
            # Prefer the furthest natural boundary that fits; fall back from
            # paragraph to line, sentence, then the last safe whitespace.
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
            raise ChunkingError("OCR text exceeds GEMINI_OCR_MAX_CHUNKS")
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
                previous_context=_context_before(
                    text, start_char, config.context_chars
                ),
                next_context=_context_after(text, end_char, config.context_chars),
                tokens=chunk_tokens,
            )
        )

    return OcrChunkPlan(text=text, tokens=tokens, chunks=tuple(chunks))


def reconstruct_ocr_text(
    plan: OcrChunkPlan,
    corrected_tokens_by_chunk: dict[int, tuple[str, ...] | list[str]],
) -> str:
    """Replace token spans only; all original whitespace and line breaks survive."""
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
            if punctuation_signature(token.text) != punctuation_signature(normalized):
                raise ChunkingError("Gemini correction must preserve source punctuation")
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
