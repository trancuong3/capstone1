"""Lightweight pure-Python Vietnamese OCR token normalization and alignment helpers.

Kept free of heavy native ML/vision dependencies (`torch`, `paddle`, `cv2`,
`numpy`, `pytesseract`, `jiwer`) so lightweight web API routes can normalize and
align OCR/proofread tokens identically to `app.services.ocr_engine` without
loading ML runtimes.
"""
from __future__ import annotations

import re
import unicodedata

MAX_ALIGNMENT_CELLS = 100_000


def normalize_word(value: str) -> str:
    value = unicodedata.normalize("NFC", value).strip().lower()
    while value and (
        unicodedata.category(value[0]).startswith(("P", "S"))
        and value[0] not in {"'", "-"}
    ):
        value = value[1:]
    while value and (
        unicodedata.category(value[-1]).startswith(("P", "S"))
        and value[-1] not in {"'", "-"}
    ):
        value = value[:-1]
    # An apostrophe or hyphen belongs to the word only between letters
    # ("d'accord", "xì-gà"). At the edge it is a quote or a dash: 'An' is the
    # word "an". A token made only of them is left as it was, so no token
    # changes between being a word and not being one.
    edge_trimmed = value.strip("'-")
    if edge_trimmed:
        value = edge_trimmed
    return re.sub(r"\s+", " ", value).strip()


def normalize_text_tokens(value: str) -> list[str]:
    return [
        token
        for raw in re.split(r"\s+", unicodedata.normalize("NFC", value).strip())
        if (token := normalize_word(raw))
    ]


def _tokens_with_source_indices(value: str) -> list[tuple[int, str]]:
    """Return valid tokens with their original whitespace-token indexes."""
    return [
        (index, token)
        for index, token in enumerate(unicodedata.normalize("NFC", value).split())
        if normalize_word(token)
    ]


def normalize_alignment_token(value: str) -> str:
    """NFC/case normalization that deliberately preserves Vietnamese diacritics."""
    token = unicodedata.normalize("NFC", str(value)).casefold().strip()
    while token and unicodedata.category(token[0]).startswith(("P", "S")):
        token = token[1:]
    while token and unicodedata.category(token[-1]).startswith(("P", "S")):
        token = token[:-1]
    return " ".join(token.split())


def _strip_diacritics_for_alignment(value: str) -> str:
    """Base-letter hint for token pairing only; never an exact-match normalizer."""
    decomposed = unicodedata.normalize("NFD", value)
    without_combining = "".join(
        character
        for character in decomposed
        if unicodedata.category(character) != "Mn"
    )
    return (
        unicodedata.normalize("NFC", without_combining)
        .replace("đ", "d")
        .replace("Đ", "D")
    )


def _char_edit_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, start=1):
        current = [row]
        for column, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[column - 1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def _edit_distance_ratio(left: str, right: str) -> float:
    if left == right:
        return 0.0
    if not left or not right:
        return 1.0
    return _char_edit_distance(left, right) / max(len(left), len(right))


def _cer_distance(reference: str, hypothesis: str) -> float:
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return _char_edit_distance(reference, hypothesis) / len(reference)


def token_alignment_cost(left: str, right: str) -> float:
    """Alignment cost using NFC text; accent-folded equality is never accepted."""
    left_token = normalize_alignment_token(left)
    right_token = normalize_alignment_token(right)
    if left_token == right_token:
        return 0.0
    if (
        not left_token
        or not right_token
        or max(len(left_token), len(right_token)) > 128
    ):
        return 1.1

    if _strip_diacritics_for_alignment(left_token) == _strip_diacritics_for_alignment(
        right_token
    ):
        return 0.3
    return min(1.5, _edit_distance_ratio(left_token, right_token) * 1.1)


def _token_surface(value: str) -> str:
    return unicodedata.normalize("NFC", str(value)).strip()


def align_ocr_tokens(
    primary_tokens: list[str],
    secondary_tokens: list[str],
    *,
    max_cells: int = MAX_ALIGNMENT_CELLS,
) -> list[dict[str, object]]:
    """Globally align tokens in order, with explicit gaps and one-to-one pairs."""
    left_count = len(primary_tokens)
    right_count = len(secondary_tokens)
    if left_count * right_count > max_cells:
        return (
            [
                {
                    "operation": "delete",
                    "primary_index": i,
                    "secondary_index": None,
                    "similarity": None,
                }
                for i in range(left_count)
            ]
            + [
                {
                    "operation": "insert",
                    "primary_index": None,
                    "secondary_index": j,
                    "similarity": None,
                }
                for j in range(right_count)
            ]
        )

    gap_cost = 0.45
    costs = [[0.0] * (right_count + 1) for _ in range(left_count + 1)]
    steps: list[list[str | None]] = [
        [None] * (right_count + 1) for _ in range(left_count + 1)
    ]
    for i in range(1, left_count + 1):
        costs[i][0] = i * gap_cost
        steps[i][0] = "delete"
    for j in range(1, right_count + 1):
        costs[0][j] = j * gap_cost
        steps[0][j] = "insert"

    for i in range(1, left_count + 1):
        for j in range(1, right_count + 1):
            substitution_cost = token_alignment_cost(
                primary_tokens[i - 1], secondary_tokens[j - 1]
            )
            options = (
                (costs[i - 1][j - 1] + substitution_cost, "pair"),
                (costs[i - 1][j] + gap_cost, "delete"),
                (costs[i][j - 1] + gap_cost, "insert"),
            )
            best_cost, best_step = options[0]
            for candidate_cost, candidate_step in options[1:]:
                if candidate_cost < best_cost - 1e-12:
                    best_cost, best_step = candidate_cost, candidate_step
            costs[i][j] = best_cost
            steps[i][j] = best_step

    aligned: list[dict[str, object]] = []
    i, j = left_count, right_count
    while i or j:
        step = steps[i][j]
        if step == "pair":
            primary_index, secondary_index = i - 1, j - 1
            exact = _token_surface(primary_tokens[primary_index]) == _token_surface(
                secondary_tokens[secondary_index]
            )
            similarity = max(
                0.0,
                min(
                    1.0,
                    1.0
                    - _cer_distance(
                        _token_surface(primary_tokens[primary_index]).casefold(),
                        _token_surface(secondary_tokens[secondary_index]).casefold(),
                    ),
                ),
            )
            aligned.append(
                {
                    "operation": "match" if exact else "substitute",
                    "primary_index": primary_index,
                    "secondary_index": secondary_index,
                    "similarity": round(similarity, 4),
                }
            )
            i -= 1
            j -= 1
        elif step == "delete":
            aligned.append(
                {
                    "operation": "delete",
                    "primary_index": i - 1,
                    "secondary_index": None,
                    "similarity": None,
                }
            )
            i -= 1
        elif step == "insert":
            aligned.append(
                {
                    "operation": "insert",
                    "primary_index": None,
                    "secondary_index": j - 1,
                    "similarity": None,
                }
            )
            j -= 1
        else:
            raise RuntimeError("OCR token alignment has an invalid backtrace")
    aligned.reverse()
    return aligned
