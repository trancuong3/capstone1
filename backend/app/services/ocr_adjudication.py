"""Evidence adjudication for one OCR word.

The module is pure: it only inspects the readings stored in one word's
evidence. It never looks at neighbouring words, page status, raw scores,
dictionaries or sentence context, and it never treats accent-folded text as
equal. A word is resolved only when independent engines read the same NFC
token from the image; otherwise it stays unresolved (YELLOW).

Engine roles (measured in ``docs/ocr-color-benchmark.md``):
  * VietOCR and Tesseract (``vie``) are Vietnamese recognizers.
  * PaddleOCR 2.7 ``lang="vi"`` uses a generic Latin recognition model that
    cannot output most Vietnamese letters ("Hôm" -> "Höm", "ngồi" -> "ngi").
    Its token therefore may *support* a candidate it happens to equal, but a
    different PaddleOCR token is not evidence against a Vietnamese reading.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

OCR_ADJUDICATION_RULE = "independent_engine_agreement_v2"

# Reading keys, in a stable order used for auditable support lists.
LINE_READINGS = ("paddleocr_line", "vietocr_line", "tesseract_line")
CROP_READINGS = ("paddleocr_crop", "vietocr_crop", "tesseract_crop")
ALL_READINGS = (*LINE_READINGS, *CROP_READINGS)
READING_ENGINE = {
    "paddleocr_line": "paddleocr",
    "vietocr_line": "vietocr",
    "tesseract_line": "tesseract",
    "paddleocr_crop": "paddleocr",
    "vietocr_crop": "vietocr",
    "tesseract_crop": "tesseract",
}
# Engines whose differing token counts as evidence against a candidate.
VIETNAMESE_CAPABLE_ENGINES = frozenset({"vietocr", "tesseract"})

MIN_SUPPORTING_ENGINES = 2
MAX_OPPOSING_READINGS_PER_TOKEN = 1


def adjudication_token(value: object) -> str | None:
    """NFC + lowercase + outer punctuation trim; diacritics are preserved.

    Mirrors ``ocr_engine.normalize_word`` without importing the heavy engine
    module. Returns ``None`` for non-strings and for values that are not a
    single token, so an empty or multi-word result never counts as a reading.
    """
    if not isinstance(value, str):
        return None
    token = unicodedata.normalize("NFC", value).strip().lower()
    while token and (
        unicodedata.category(token[0]).startswith(("P", "S"))
        and token[0] not in {"'", "-"}
    ):
        token = token[1:]
    while token and (
        unicodedata.category(token[-1]).startswith(("P", "S"))
        and token[-1] not in {"'", "-"}
    ):
        token = token[:-1]
    token = re.sub(r"\s+", " ", token).strip()
    if not token or " " in token:
        return None
    return token


def _base_letters(token: str) -> str:
    """Letters without marks; used only to detect a diacritic-only conflict."""
    decomposed = unicodedata.normalize("NFD", token)
    return "".join(
        character for character in decomposed
        if unicodedata.category(character) != "Mn"
    ).replace("đ", "d")


def _mark_count(token: str) -> int:
    decomposed = unicodedata.normalize("NFD", token)
    return sum(
        1 for character in decomposed if unicodedata.category(character) == "Mn"
    ) + token.count("đ")


def collect_word_readings(evidence: object) -> dict[str, str]:
    """Return every usable normalized reading stored for one word."""
    if not isinstance(evidence, dict):
        return {}
    readings: dict[str, str] = {}
    outputs = evidence.get("engine_outputs")
    statuses = evidence.get("engine_statuses")
    if isinstance(outputs, dict):
        for key, engine in (
            ("paddleocr_line", "paddleocr"),
            ("vietocr_line", "vietocr"),
            ("tesseract_line", "tesseract"),
        ):
            # A line reading counts only when that engine demonstrably ran.
            if not isinstance(statuses, dict) or statuses.get(engine) != "success":
                continue
            token = adjudication_token(outputs.get(engine))
            if token is not None:
                readings[key] = token
    crop = evidence.get("crop_evidence")
    if isinstance(crop, dict) and crop.get("status") == "completed":
        for key, field, error_field in (
            ("paddleocr_crop", "paddleocr_candidate", "paddle_error"),
            ("vietocr_crop", "vietocr_candidate", "vietocr_error"),
            ("tesseract_crop", "tesseract_candidate", "tesseract_error"),
        ):
            if isinstance(crop.get(error_field), str):
                continue
            token = adjudication_token(crop.get(field))
            if token is not None:
                readings[key] = token
    return readings


def adjudicate_word(evidence: object) -> dict[str, Any]:
    """Decide whether the stored image readings identify one candidate.

    ``status == "resolved"`` (the token may be shown GREEN) requires, for the
    same NFC token:
      * both Vietnamese engines (VietOCR and Tesseract) read it; evidence
        recorded without a Tesseract reading keeps the earlier standard of
        two agreeing engines (PaddleOCR + VietOCR),
      * no Vietnamese engine read the same base letters with different marks,
      * no other token is read more than
        ``MAX_OPPOSING_READINGS_PER_TOKEN`` time by Vietnamese engines, and
        supporting readings outnumber those opposing readings.

    ``preferred_text`` is the weaker "best reading to display" decision. It
    never implies correctness and must not be used to color a word.

    The result is deterministic for a given evidence snapshot.
    """
    unresolved: dict[str, Any] = {
        "status": "unresolved",
        "text": None,
        "support": [],
        "opposition": [],
        "rule": OCR_ADJUDICATION_RULE,
    }
    if not isinstance(evidence, dict):
        return {**unresolved, "status": "not_applicable", "reason": "no_evidence"}
    if evidence.get("bbox_quality") != "valid" or evidence.get("crop_quality") != "usable":
        return {**unresolved, "status": "not_applicable", "reason": "word_region_not_usable"}

    readings = collect_word_readings(evidence)
    by_token: dict[str, list[str]] = {}
    for key in ALL_READINGS:
        token = readings.get(key)
        if token is not None:
            by_token.setdefault(token, []).append(key)
    statuses = evidence.get("engine_statuses")
    tesseract_ran = isinstance(statuses, dict) and statuses.get("tesseract") == "success"

    confirmed: list[tuple[str, list[str], list[str]]] = []
    preferred: list[tuple[str, list[str]]] = []
    for token, supporters in by_token.items():
        engines = {READING_ENGINE[key] for key in supporters}
        capable_engines = engines & VIETNAMESE_CAPABLE_ENGINES
        opposing: list[str] = []
        strongest_opponent = 0
        richer_reading = False
        diacritic_conflict = False
        for other_token, other_supporters in by_token.items():
            if other_token == token:
                continue
            capable = [
                key for key in other_supporters
                if READING_ENGINE[key] in VIETNAMESE_CAPABLE_ENGINES
            ]
            if not capable:
                continue
            opposing.extend(capable)
            strongest_opponent = max(strongest_opponent, len(capable))
            if _base_letters(other_token) == _base_letters(token):
                diacritic_conflict = True
                if _mark_count(other_token) > _mark_count(token):
                    richer_reading = True
        outvotes_opposition = (
            strongest_opponent <= MAX_OPPOSING_READINGS_PER_TOKEN
            and len(supporters) > len(opposing)
        )
        # Which text to *display*: the best supported reading, never one that
        # a Vietnamese engine contradicts with more marks on the same letters.
        if (
            len(capable_engines) >= MIN_SUPPORTING_ENGINES
            and outvotes_opposition
            and not richer_reading
        ):
            preferred.append((token, supporters))
        # Whether that text is *confirmed*: when Tesseract ran, both
        # Vietnamese engines must agree; a PaddleOCR + VietOCR agreement is
        # accepted only for evidence recorded without a Tesseract reading.
        # Vietnamese engines differing only in marks is never confirmation:
        # such errors are correlated, so a majority proves nothing.
        enough_engines = (
            len(capable_engines) >= MIN_SUPPORTING_ENGINES
            if tesseract_ran
            else len(engines) >= MIN_SUPPORTING_ENGINES
        )
        if enough_engines and outvotes_opposition and not diacritic_conflict:
            confirmed.append((token, supporters, opposing))

    preferred_text = preferred[0][0] if len(preferred) == 1 else None
    if len(confirmed) != 1:
        return {
            **unresolved,
            "reason": "no_candidate_with_independent_agreement",
            "preferred_text": preferred_text,
            "preferred_support": preferred[0][1] if preferred_text else [],
            "readings": readings,
        }
    token, supporters, opposing = confirmed[0]
    return {
        "status": "resolved",
        "text": token,
        "support": supporters,
        "opposition": opposing,
        "preferred_text": token,
        "preferred_support": supporters,
        "rule": OCR_ADJUDICATION_RULE,
        "readings": readings,
    }


def replace_token_core(raw_token: str, candidate: str) -> str:
    """Swap the word inside ``raw_token`` while keeping its outer punctuation."""

    def core_bounds(value: str) -> tuple[int, int]:
        start = 0
        while start < len(value) and (
            unicodedata.category(value[start]).startswith(("P", "S"))
            and value[start] not in {"'", "-"}
        ):
            start += 1
        end = len(value)
        while end > start and (
            unicodedata.category(value[end - 1]).startswith(("P", "S"))
            and value[end - 1] not in {"'", "-"}
        ):
            end -= 1
        return start, end

    raw = unicodedata.normalize("NFC", raw_token)
    new_core = unicodedata.normalize("NFC", candidate).strip()
    start, end = core_bounds(raw)
    core_start, core_end = core_bounds(new_core)
    return raw[:start] + new_core[core_start:core_end] + raw[end:]
