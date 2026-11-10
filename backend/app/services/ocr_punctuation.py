"""Punctuation-aware view of one OCR token.

A stored token keeps its full surface ("“An", "giường."). This module splits
that surface into leading punctuation, lexical core and trailing punctuation
without changing or dropping anything, so words can be compared by their
lexical core while punctuation is assessed separately.

Apostrophes and hyphens inside a word ("d'accord", "xì-gà") belong to the
lexical core, matching ``ocr_engine.normalize_word``.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass

# Characters OCR engines commonly swap for one another although the mark on
# the page is the same. Used only to compare punctuation, never to rewrite it.
_PUNCTUATION_EQUIVALENTS = {
    "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
    "‘": "'", "’": "'", "‚": "'", "`": "'", "´": "'",
    "–": "-", "—": "-", "―": "-", "‐": "-", "‑": "-", "−": "-",
}


def _is_outer_punctuation(character: str) -> bool:
    return unicodedata.category(character).startswith(("P", "S"))


@dataclass(frozen=True)
class SurfaceToken:
    surface: str
    leading: str
    core: str
    trailing: str

    @property
    def has_punctuation(self) -> bool:
        return bool(self.leading or self.trailing)


def split_surface_token(value: str) -> SurfaceToken:
    """Split ``value`` into (leading punctuation, lexical core, trailing punctuation).

    ``leading + core + trailing`` always equals the NFC surface. A token made
    only of punctuation has an empty core and all of it as trailing.
    """
    surface = unicodedata.normalize("NFC", str(value)).strip()
    start = 0
    while start < len(surface) and _is_outer_punctuation(surface[start]):
        start += 1
    if start == len(surface):
        return SurfaceToken(surface, "", "", surface)
    end = len(surface)
    while end > start and _is_outer_punctuation(surface[end - 1]):
        end -= 1
    # A hyphen or apostrophe is kept in the core only when letters surround
    # it; at the very edge of a token it is punctuation ("-An", "An-").
    return SurfaceToken(surface, surface[:start], surface[start:end], surface[end:])


def canonical_punctuation(value: str) -> str:
    """Comparison form: curly quotes/dashes unified, "..." equals "…"."""
    text = unicodedata.normalize("NFC", value).replace("…", "...")
    return "".join(_PUNCTUATION_EQUIVALENTS.get(character, character) for character in text)


def punctuation_marks(value: str) -> list[str]:
    """Leading and trailing marks of one token, in comparison form."""
    token = split_surface_token(value)
    return list(canonical_punctuation(token.leading)) + list(canonical_punctuation(token.trailing))


def compare_punctuation(ocr_token: str, reference_token: str) -> str:
    """``correct`` / ``incorrect`` for a token paired one-to-one with a reference."""
    ocr = split_surface_token(ocr_token)
    reference = split_surface_token(reference_token)
    same = (
        canonical_punctuation(ocr.leading) == canonical_punctuation(reference.leading)
        and canonical_punctuation(ocr.trailing) == canonical_punctuation(reference.trailing)
    )
    return "correct" if same else "incorrect"


def punctuation_status(
    word_text: str,
    evidence: dict[str, object] | None,
) -> str:
    """Punctuation verdict for one stored word, independent of its text color.

    * ``correct`` / ``incorrect``: a verified reference is paired one-to-one
      with this word, so its punctuation can be compared.
    * ``uncertain``: no reference, and the two Vietnamese engines read
      different punctuation around the same word (or only one of them read
      the word).
    * ``consistent``: no reference, both Vietnamese engines read the same
      punctuation. This is agreement, not verification.
    * ``not_assessed``: nothing to compare against.
    """
    if not isinstance(evidence, dict):
        return "not_assessed"
    reference = evidence.get("reference_text")
    if (
        evidence.get("verification_source") in {"admin", "verified_revision"}
        and isinstance(reference, str)
        and reference.strip()
        and evidence.get("reference_alignment") in {"match", "substitute"}
    ):
        return compare_punctuation(word_text, reference)

    outputs = evidence.get("engine_outputs")
    statuses = evidence.get("engine_statuses")
    if not isinstance(outputs, dict) or not isinstance(statuses, dict):
        return "not_assessed"
    readings = [
        outputs.get(engine)
        for engine in ("vietocr", "tesseract")
        if statuses.get(engine) == "success" and isinstance(outputs.get(engine), str)
    ]
    readings = [reading for reading in readings if split_surface_token(reading).core]
    if len(readings) < 2:
        return "not_assessed" if not readings else "uncertain"
    stored = punctuation_marks(word_text)
    return (
        "consistent"
        if all(punctuation_marks(reading) == stored for reading in readings)
        else "uncertain"
    )
