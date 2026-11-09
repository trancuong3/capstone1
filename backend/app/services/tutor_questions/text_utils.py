from __future__ import annotations

import re
import unicodedata

_PUNCTUATION = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def normalize_text(value: str) -> str:
    """Lower-case NFC text without punctuation. Vietnamese tone marks are kept."""

    value = unicodedata.normalize("NFC", value or "").lower()
    value = _PUNCTUATION.sub(" ", value.replace("_", " "))
    return _SPACES.sub(" ", value).strip()


def tokenize(value: str) -> list[str]:
    normalized = normalize_text(value)
    return normalized.split(" ") if normalized else []


def find_subsequence(haystack: list[str], needle: list[str]) -> int | None:
    """Return the first index where needle occurs contiguously in haystack."""

    if not needle or len(needle) > len(haystack):
        return None
    first = needle[0]
    for index in range(len(haystack) - len(needle) + 1):
        if haystack[index] == first and haystack[index : index + len(needle)] == needle:
            return index
    return None
