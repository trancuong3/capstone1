from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable
from uuid import UUID


_TERMINAL_PUNCTUATION = frozenset(".!?")
_CLOSING_PUNCTUATION = frozenset("\"'’”»)]}")


@dataclass(frozen=True)
class SentenceToken:
    token_id: UUID
    text: str


@dataclass(frozen=True)
class ExtractedSentence:
    text: str
    tokens: tuple[SentenceToken, ...]


def normalize_token(value: str) -> str:
    """Normalize comparison text while preserving Vietnamese tone marks."""
    value = unicodedata.normalize("NFC", value).strip().casefold()
    while value and unicodedata.category(value[0]).startswith(("P", "S")) and value[0] not in {"'", "-"}:
        value = value[1:]
    while value and unicodedata.category(value[-1]).startswith(("P", "S")) and value[-1] not in {"'", "-"}:
        value = value[:-1]
    edge_trimmed = value.strip("'-")
    if edge_trimmed:
        value = edge_trimmed
    return re.sub(r"\s+", " ", value).strip()


def _sentence_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    start = 0
    index = 0
    saw_terminal = False

    while index < len(text):
        character = text[index]
        if character not in _TERMINAL_PUNCTUATION:
            index += 1
            continue
        if (
            character == "."
            and index > 0
            and index + 1 < len(text)
            and text[index - 1].isdigit()
            and text[index + 1].isdigit()
        ):
            index += 1
            continue

        end = index + 1
        while end < len(text) and text[end] in _TERMINAL_PUNCTUATION:
            end += 1
        while end < len(text) and text[end] in _CLOSING_PUNCTUATION:
            end += 1
        if end < len(text) and not text[end].isspace():
            index = end
            continue

        saw_terminal = True
        if text[start:end].strip():
            spans.append((start, end))
        while end < len(text) and text[end].isspace():
            end += 1
        start = end
        index = end

    if start < len(text) and text[start:].strip():
        spans.append((start, len(text)))

    if not saw_terminal and "\n" in text:
        spans = []
        line_start = 0
        for line in text.splitlines(keepends=True):
            line_end = line_start + len(line)
            if line.strip():
                spans.append((line_start, line_end))
            line_start = line_end
    if not spans and text.strip():
        spans = [(0, len(text))]
    return spans


def _looks_like_sentence(text: str, tokens: list[str]) -> bool:
    if not tokens or "\ufffd" in text or any(ord(char) < 32 and char not in "\r\n\t" for char in text):
        return False
    if all(not any(char.isalpha() for char in token) for token in tokens):
        return False
    letters = sum(char.isalpha() for char in text)
    visible = sum(not char.isspace() for char in text)
    if visible and letters / visible < 0.45:
        return False
    normalized = " ".join(normalize_token(token) for token in tokens)
    if text.rstrip().endswith(":") and normalized.startswith(("chương ", "bài ", "phần ", "mục ")):
        return False
    return True


def extract_verified_sentences(
    verified_text: str | None,
    words: Iterable[object],
    *,
    min_tokens: int = 3,
    max_tokens: int = 14,
) -> list[ExtractedSentence]:
    """Extract only sentences whose verified text aligns with their OCR word rows.

    VerifiedText supplies sentence boundaries and punctuation. Each whitespace
    token must match the corresponding PageRevisionWord row, so unverified,
    incomplete, or out-of-order OCR data cannot become a game question.
    """
    if not isinstance(verified_text, str):
        return []
    canonical_text = unicodedata.normalize("NFC", verified_text).strip()
    if not canonical_text or min_tokens < 1 or max_tokens < min_tokens:
        return []

    ordered_words = sorted(
        list(words),
        key=lambda word: (
            int(getattr(word, "LineIndex", 0)),
            int(getattr(word, "WordIndex", 0)),
            str(getattr(word, "Id", "")),
        ),
    )
    text_matches = list(re.finditer(r"\S+", canonical_text))
    if not text_matches or len(text_matches) != len(ordered_words):
        return []

    token_ids: list[UUID] = []
    for match, word in zip(text_matches, ordered_words, strict=True):
        source_text = match.group(0)
        row_text = getattr(word, "Text", None)
        row_id = getattr(word, "Id", None)
        if not isinstance(row_text, str) or not isinstance(row_id, UUID):
            return []
        normalized_source = normalize_token(source_text)
        normalized_row = normalize_token(row_text)
        if not normalized_source or normalized_source != normalized_row:
            return []
        token_ids.append(row_id)

    sentences: list[ExtractedSentence] = []
    seen_token_ids: set[UUID] = set()
    for start, end in _sentence_spans(canonical_text):
        matched = [match for match in text_matches if match.start() >= start and match.end() <= end]
        if not min_tokens <= len(matched) <= max_tokens:
            continue
        display_tokens = [match.group(0) for match in matched]
        if not _looks_like_sentence(" ".join(display_tokens), display_tokens):
            continue
        first_index = text_matches.index(matched[0])
        sentence_token_ids = token_ids[first_index : first_index + len(matched)]
        if len(sentence_token_ids) != len(matched) or any(token_id in seen_token_ids for token_id in sentence_token_ids):
            continue
        seen_token_ids.update(sentence_token_ids)
        tokens = tuple(
            SentenceToken(token_id=token_id, text=display)
            for token_id, display in zip(sentence_token_ids, display_tokens, strict=True)
        )
        sentences.append(ExtractedSentence(text=" ".join(display_tokens), tokens=tokens))
    return sentences
