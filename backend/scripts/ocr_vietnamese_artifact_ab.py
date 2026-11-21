"""Offline OCR A/B diagnostics for Vietnamese tone errors and isolated tail tokens.

NO production inference changes. Human reference text is used only to score
results and compute an oracle upper bound, NEVER to select a proposal.
All returned report fields are aggregate numeric counts (no texts or paths).
"""
from __future__ import annotations

import math
import statistics
import unicodedata
from collections import Counter

from scripts.ocr_real_photo_benchmark import edit_distance, normalize
from scripts.ocr_word_box_iou import valid_box
from scripts.ocr_word_error_diagnostics import (
    analyze_word_errors, edge_punctuation_neutral_tokens,
)

MAX_WORDS = 512
ALTERNATIVE_LIMIT = 12


def _core(token: object) -> str:
    if not isinstance(token, str) or len(token) > 160:
        return ""
    tokens = edge_punctuation_neutral_tokens(token)
    return unicodedata.normalize("NFC", tokens[0]) if len(tokens) == 1 else ""


def _base_letters(token: str) -> str:
    decomposed = unicodedata.normalize("NFD", token.casefold().replace("đ", "d"))
    return "".join(
        char for char in decomposed if unicodedata.category(char) != "Mn"
    )


def tone_alternatives(word: object) -> set[str]:
    """Find other *existing engine readings* differing only in tone/đ.

    Candidates are NOT a correction recommendation or proof of word accuracy.
    The dataset's ground truth is deliberately absent from this function.
    """
    if not isinstance(word, dict):
        return set()
    selected = _core(word.get("text"))
    if not selected:
        return set()
    evidence = word.get("ocr_evidence")
    if not isinstance(evidence, dict):
        return set()

    readings: list[object] = []
    outputs = evidence.get("engine_outputs")
    if isinstance(outputs, dict):
        readings.extend(outputs.get(name) for name in (
            "paddleocr", "vietocr", "tesseract"
        ))
    crop = evidence.get("crop_evidence")
    if isinstance(crop, dict):
        readings.extend(crop.get(name) for name in (
            "paddleocr_candidate", "vietocr_candidate", "tesseract_candidate"
        ))
    candidates: set[str] = set()
    for reading in readings[:ALTERNATIVE_LIMIT]:
        alternative = _core(reading)
        if (
            alternative
            and alternative != selected
            and alternative.casefold() != selected.casefold()
            and _base_letters(alternative) == _base_letters(selected)
        ):
            candidates.add(alternative)
    return candidates


def _word_surface_sequence(output: object) -> tuple[list[dict[str, object]], list[str]] | None:
    """Require exact alignment of output.text tokens and output.words.

    Do not remove anything if punctuation-only tokens or split/merge operations
    invalidate the positional mapping.
    """
    if not isinstance(output, dict) or not isinstance(output.get("text"), str):
        return None
    words = output.get("words")
    tokens = normalize(output["text"]).split()
    if (
        not isinstance(words, list) or not words
        or len(words) != len(tokens) or len(words) > MAX_WORDS
        or any(
            not isinstance(word, dict)
            or word.get("text") != token
            or not valid_box(word.get("bbox"))
            for word, token in zip(words, tokens)
        )
    ):
        return None
    return words, tokens


def propose_isolated_tail_trim(output: object) -> dict[str, object]:
    """Propose removing 1..3 distant, unusually tall uppercase glyph tokens.

    Geometry+surface only; never read reference text. Possible real footnotes
    or Roman numerals are NOT guaranteed noise; no automatic suppression.
    """
    aligned = _word_surface_sequence(output)
    if aligned is None:
        return {"status": "not_evaluable", "removed_tokens": 0, "candidate_text": None}
    words, tokens = aligned
    for count in (3, 2, 1):
        if len(words) - count < 12:
            continue
        tail = words[-count:]
        if any(
            not isinstance(word["text"], str)
            or len(_core(word["text"])) != 1
            or not _core(word["text"]).isalpha()
            or not _core(word["text"]).isupper()
            for word in tail
        ):
            continue
        body = words[:-count]
        heights = [float(word["bbox"][3]) for word in body]
        median_height = statistics.median(heights)
        if not median_height or not math.isfinite(median_height):
            continue
        body_bottom = max(float(w["bbox"][1]) + float(w["bbox"][3]) for w in body)
        tail_top = min(float(w["bbox"][1]) for w in tail)
        if tail_top - body_bottom < 3.0 * median_height:
            continue
        if any(float(word["bbox"][3]) < 1.6 * median_height for word in tail):
            continue
        return {
            "status": "proposed_review_only",
            "removed_tokens": count,
            "candidate_text": " ".join(tokens[:-count]),
        }
    return {"status": "no_proposal", "removed_tokens": 0, "candidate_text": None}


def score_pair(expected: str, observed: str) -> dict[str, int]:
    """Use original strict NFC CER/WER, not punctuation-neutral replacements."""
    gt = normalize(expected)
    selected = normalize(observed)
    return {
        "character_edits": edit_distance(list(gt), list(selected)),
        "reference_characters": len(gt),
        "word_edits": edit_distance(gt.split(), selected.split()),
        "reference_words": len(gt.split()),
        "exact_pages": int(gt == selected),
        "pages": 1,
    }


def evaluate_case(expected: str, output: dict[str, object]) -> dict[str, object]:
    """Score strict baseline and one fixed geometry-only tail proposal.

    An oracle diagnostic counts true alternatives in engine evidence, but
    neither evaluates 'corrected' text nor changes OCR based on the reference.
    """
    observed = output.get("text")
    if not isinstance(observed, str):
        raise ValueError("Missing OCR page text")
    baseline = score_pair(expected, observed)
    suggestion = propose_isolated_tail_trim(output)
    proposed_text = suggestion["candidate_text"]
    candidate = score_pair(expected, proposed_text) if isinstance(proposed_text, str) else baseline

    if candidate["word_edits"] < baseline["word_edits"]:
        direction = "improved_wer"
    elif candidate["word_edits"] > baseline["word_edits"]:
        direction = "worsened_wer"
    else:
        direction = "unchanged_wer"
    if candidate["character_edits"] < baseline["character_edits"]:
        char_direction = "improved_cer"
    elif candidate["character_edits"] > baseline["character_edits"]:
        char_direction = "worsened_cer"
    else:
        char_direction = "unchanged_cer"

    words = output.get("words")
    errors = analyze_word_errors(normalize(expected), normalize(observed))
    detected = unresolved = candidate_correct = 0
    cases_unaligned = 0
    observed_tokens = normalize(observed).split()
    if (
        not isinstance(words, list)
        or len(words) != len(observed_tokens)
        or any(
            not isinstance(w, dict) or w.get("text") != observed_tokens[i]
            for i, w in enumerate(words)
        )
        or errors["status"] != "complete"
    ):
        cases_unaligned = 1
    else:
        detected = sum(bool(tone_alternatives(word)) for word in words)
        for error in errors["errors"]:
            if error["kind"] != "diacritic_or_d_stroke":
                continue
            pos = error["observed_position"]
            if not isinstance(pos, int) or pos < 1 or pos > len(words):
                continue
            unresolved += 1
            expected_core = _core(error.get("expected"))
            if expected_core and expected_core in tone_alternatives(words[pos - 1]):
                candidate_correct += 1

    return {
        "baseline": baseline, "candidate": candidate,
        "tail_status": suggestion["status"],
        "tail_removed": suggestion["removed_tokens"],
        "wer_direction": direction, "cer_direction": char_direction,
        "evidence_words_with_tone_alternative": detected,
        "observed_tone_errors": unresolved,
        "tone_errors_with_correct_engine_alternative": candidate_correct,
        "tone_oracle_unaligned_cases": cases_unaligned,
    }


def _summary(scores: list[dict[str, object]], field: str) -> dict[str, object]:
    sums: Counter[str] = Counter()
    for score in scores:
        sums.update(score[field])
    chars = sums["reference_characters"]
    words = sums["reference_words"]
    return {
        "character_edits": sums["character_edits"],
        "reference_characters": chars,
        "micro_cer": round(sums["character_edits"] / chars, 6) if chars else None,
        "word_edits": sums["word_edits"],
        "reference_words": words,
        "micro_wer": round(sums["word_edits"] / words, 6) if words else None,
        "exact_pages": sums["exact_pages"],
        "pages": sums["pages"],
    }


def summarize_cases(scores: list[dict[str, object]]) -> dict[str, object]:
    if not scores:
        raise ValueError("No successful OCR results")
    statuses = Counter(str(row["tail_status"]) for row in scores)
    directions = Counter(str(row["wer_direction"]) for row in scores)
    char_directions = Counter(str(row["cer_direction"]) for row in scores)
    return {
        "baseline_strict": _summary(scores, "baseline"),
        "isolated_tail_hypothesis_strict": _summary(scores, "candidate"),
        "tail_proposal_statuses": dict(sorted(statuses.items())),
        "wer_page_directions": dict(sorted(directions.items())),
        "cer_page_directions": dict(sorted(char_directions.items())),
        "proposed_tokens_removed_total": sum(int(row["tail_removed"]) for row in scores),
        "diacritic_evidence": {
            "words_with_tone_alternative": sum(int(row["evidence_words_with_tone_alternative"]) for row in scores),
            "observed_tone_errors": sum(int(row["observed_tone_errors"]) for row in scores),
            "tone_errors_with_correct_engine_alternative": sum(
                int(row["tone_errors_with_correct_engine_alternative"]) for row in scores
            ),
            "unaligned_cases": sum(int(row["tone_oracle_unaligned_cases"]) for row in scores),
            "note": (
                "Engine-alternative coverage is an ORACLE diagnostic using "
                "reference text for scoring ONLY. It does not select a reading "
                "or demonstrate an deployable automatic accent corrector."
            ),
        },
        "hypothesis_scope": (
            "Fixed geometry/surface-only isolated suffix removal, scored offline; "
            "may remove genuine footnotes or standalone characters; never applied "
            "to production OCR, word boxes, or reading feedback."
        ),
        "production_inference_modified": False,
    }
