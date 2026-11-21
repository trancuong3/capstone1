"""Opt-in private, word-level OCR diagnostics (no OCR inference or network).

All returned records may contain source text. Never include them in the
aggregate benchmark report, terminal output, CI logs, or version control.
"""
from __future__ import annotations

import unicodedata

MAX_ALIGNMENT_TOKENS = 512  # Bounds O(n*m) memory for malformed/unexpected text.


def edge_punctuation_neutral_tokens(text: str) -> list[str]:
    """Ignore only boundary punctuation/symbols; preserve Vietnamese letters.

    This is an additional, diagnostic scoring view, NOT an OCR correction.
    Embedded punctuation (for example hyphens inside words) is preserved.
    """
    tokens: list[str] = []
    for raw in text.split():
        start, end = 0, len(raw)
        while start < end and unicodedata.category(raw[start]).startswith(("P", "S")):
            start += 1
        while end > start and unicodedata.category(raw[end - 1]).startswith(("P", "S")):
            end -= 1
        if token := raw[start:end]:
            tokens.append(token)
    return tokens


def _without_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text.casefold().replace("đ", "d"))
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def _without_punctuation(text: str) -> str:
    return "".join(
        ch for ch in text
        if not unicodedata.category(ch).startswith(("P", "S"))
    )


def classify_substitution(expected: str, observed: str) -> str:
    """Simple diagnostic categories, not proof of an OCR root cause."""
    if expected.casefold() == observed.casefold():
        return "case_only"
    if _without_diacritics(expected) == _without_diacritics(observed):
        return "diacritic_or_d_stroke"
    if _without_punctuation(expected) == _without_punctuation(observed):
        return "punctuation_only"
    return "other_substitution"


def analyze_word_errors(expected: str, observed: str) -> dict[str, object]:
    """Deterministic minimal-edit token alignment; outputs only mismatched tokens.

    Expected and observed should already have the same NFC/whitespace
    normalization as the CER/WER benchmark. Positions are 1-based.
    Multiple optimal alignments can exist; categories are diagnostic only.
    """
    a, b = expected.split(), observed.split()
    if max(len(a), len(b)) > MAX_ALIGNMENT_TOKENS:
        return {"status": "skipped_token_limit", "errors": [], "error_count": None}

    # Levenshtein dynamic program, substitution preferred over insert/delete
    # on equal-cost alternatives. The number of output edits equals word ED.
    dp = [list(range(len(b) + 1))]
    for i, word_a in enumerate(a, start=1):
        row = [i]
        for j, word_b in enumerate(b, start=1):
            row.append(min(
                dp[i - 1][j] + 1,
                row[j - 1] + 1,
                dp[i - 1][j - 1] + (word_a != word_b),
            ))
        dp.append(row)

    i, j = len(a), len(b)
    errors: list[dict[str, object]] = []
    while i or j:
        if i and j and a[i - 1] == b[j - 1]:
            i -= 1
            j -= 1
        elif i and j and dp[i][j] == dp[i - 1][j - 1] + 1:
            errors.append({
                "kind": classify_substitution(a[i - 1], b[j - 1]),
                "expected_position": i,
                "observed_position": j,
                "expected": a[i - 1],
                "observed": b[j - 1],
            })
            i -= 1
            j -= 1
        elif i and dp[i][j] == dp[i - 1][j] + 1:
            errors.append({
                "kind": "missing_token",
                "expected_position": i,
                "observed_position": None,
                "expected": a[i - 1],
                "observed": None,
            })
            i -= 1
        else:
            assert j and dp[i][j] == dp[i][j - 1] + 1
            errors.append({
                "kind": "extra_token",
                "expected_position": None,
                "observed_position": j,
                "expected": None,
                "observed": b[j - 1],
            })
            j -= 1
    errors.reverse()
    return {"status": "complete", "errors": errors, "error_count": len(errors)}
