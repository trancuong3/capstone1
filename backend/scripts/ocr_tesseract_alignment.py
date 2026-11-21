"""Reference-to-OCR token alignment used ONLY for private diagnostic scoring.

All optimal Levenshtein edit paths are considered. An observed OCR token
is assigned to a reference token ONLY when the same unique reference index
is paired with it in every optimal edit path. Otherwise it is ambiguous.
This does not change OCR predictions, proposals, boxes, or production data.
"""
from __future__ import annotations

from scripts.ocr_word_error_diagnostics import MAX_ALIGNMENT_TOKENS


def unambiguous_optimal_token_alignment(
    reference_tokens: list[str], ocr_tokens: list[str],
) -> dict[int, int]:
    """Map zero-based OCR token indices to independently unambiguous GT indices.

    An OCR insert/extra-token possibility always disqualifies an index.
    Uses forward and backward edit-distance tables, not an arbitrary
    tie-breaking backtrace. Complexity O(n*m), bounded to 512 tokens.
    """
    n, m = len(reference_tokens), len(ocr_tokens)
    if max(n, m) > MAX_ALIGNMENT_TOKENS or not n or not m:
        return {}

    forward = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        forward[i][0] = i
    for j in range(1, m + 1):
        forward[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            forward[i][j] = min(
                forward[i - 1][j] + 1,
                forward[i][j - 1] + 1,
                forward[i - 1][j - 1] + (
                    reference_tokens[i - 1] != ocr_tokens[j - 1]
                ),
            )

    backward = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        backward[i][m] = n - i
    for j in range(m - 1, -1, -1):
        backward[n][j] = m - j
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            backward[i][j] = min(
                backward[i + 1][j] + 1,
                backward[i][j + 1] + 1,
                backward[i + 1][j + 1] + (
                    reference_tokens[i] != ocr_tokens[j]
                ),
            )

    minimum_edits = forward[n][m]
    unambiguous: dict[int, int] = {}
    for j in range(m):
        valid_reference_positions: set[int] = set()
        extra_token_possible = False
        for i in range(n + 1):
            if forward[i][j] + 1 + backward[i][j + 1] == minimum_edits:
                extra_token_possible = True
                break
            if (
                i < n
                and forward[i][j]
                + (reference_tokens[i] != ocr_tokens[j])
                + backward[i + 1][j + 1]
                == minimum_edits
            ):
                valid_reference_positions.add(i)
                if len(valid_reference_positions) > 1:
                    break
        if not extra_token_possible and len(valid_reference_positions) == 1:
            unambiguous[j] = next(iter(valid_reference_positions))
    return unambiguous
