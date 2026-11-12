"""Export backend color decisions so the frontend classifier can be checked
against them case by case.

Each case is one word exactly as the API serves it (text, review status,
sanitized evidence) plus the color the backend classifier assigned. The
frontend test strips ``review_color_group`` and must reach the same color
with its own fallback classifier.

Usage (from ``backend/``):
    python scripts/export_ocr_color_parity.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from ocr_color_testkit import (  # noqa: E402
    GREEN_WORDS,
    RED_PAIRS,
    classify_page,
    completed_crop,
    corrupt,
    engine_word,
)

from app.services.admin_ocr_service import (  # noqa: E402
    AdminOcrService,
    classify_word_evidence,
)

OUTPUT = BACKEND_ROOT.parent / "frontend" / "tests" / "admin" / "fixtures" / "ocr-color-parity.json"
STATUSES = ["needs_review", "engine_agreement", "engine_disagreement", "verified",
            "reference_match", "confirmed_mismatch"]


def _case(case_id: str, word: dict[str, object], status: str | None = None) -> dict[str, object]:
    evidence = AdminOcrService._normalize_word_evidence(word.get("ocr_evidence"))
    review_status = status or str(word.get("ocr_review_status", "needs_review"))
    return {
        "id": case_id,
        "text": str(word["text"]),
        "ocr_review_status": review_status,
        "ocr_evidence": evidence,
        "expected_color": classify_word_evidence(review_status, evidence, str(word["text"])),
    }


def build_cases() -> list[dict[str, object]]:
    rng = random.Random(20261110)
    cases: list[dict[str, object]] = []

    # Reference-decided words: exact matches and one-to-one mismatches.
    for index, (truth, wrong, category) in enumerate(RED_PAIRS):
        for stored, label in ((truth, "match"), (wrong, "mismatch")):
            words = [engine_word("một"), engine_word(
                stored, paddle=rng.choice([stored, truth, wrong, None]), token_index=1),
                engine_word("hai", token_index=2)]
            classify_page(words, f"một {truth} hai")
            cases.append(_case(f"reference-{label}-{index:03d}-{category}", words[1],
                               rng.choice(STATUSES)))

    # Ambiguous reference mappings.
    for index in range(20):
        truth = GREEN_WORDS[index]
        wrong = corrupt(truth, "all_marks_dropped") or truth + "x"
        words = [engine_word("một"), engine_word(wrong, token_index=1),
                 engine_word("zzq", token_index=2)]
        classify_page(words, f"một {truth}")
        cases.append(_case(f"reference-ambiguous-{index:03d}", words[1]))
        cases.append(_case(f"reference-unpaired-{index:03d}", words[2]))

    # Engine-only evidence (no reference): agreement, disagreement, crops,
    # Tesseract confirmation and contradiction, missing engines.
    for index in range(260):
        text = rng.choice(GREEN_WORDS)
        stripped = corrupt(text, "all_marks_dropped") or text + "q"
        other_tone = corrupt(text, "grave_to_hook") or corrupt(text, "acute_to_dot") or stripped
        variants = [text, stripped, other_tone, None, ""]
        tesseract = rng.choice(variants + [text, text])
        statuses = {
            "paddleocr": rng.choice(["success", "success", "success", "error"]),
            "vietocr": rng.choice(["success", "success", "success", "not_run"]),
            "tesseract": rng.choice(["success", "success", "not_run", "not_installed"]),
        }
        crop = rng.choice([
            None,
            {"status": "not_needed"},
            {"status": "skipped"},
            {"status": "partial", "vietocr_error": "RuntimeError"},
            completed_crop(rng.choice(variants), rng.choice(variants), rng.choice(variants)),
            completed_crop(text, text, text),
        ])
        word = engine_word(
            text,
            paddle=rng.choice(variants),
            vietocr=rng.choice([text, text, text, stripped, None]),
            selected=rng.choice(["vietocr", "vietocr", "paddleocr"]),
            statuses=statuses,
            alignment=rng.choice([None, None, "match", "substitute", "unmatched", "insert", "split"]),
            bbox_quality=rng.choice(["valid", "valid", "valid", "rejected"]),
            crop_quality=rng.choice(["usable", "usable", "usable", "weak"]),
            crop_evidence=crop,
            token_index=index % 7,
        )
        if isinstance(tesseract, str):
            word["ocr_evidence"]["engine_outputs"]["tesseract"] = tesseract
        cases.append(_case(f"engines-{index:03d}", word, rng.choice(STATUSES)))

    # A truncated PaddleOCR token must keep a two-engine Vietnamese agreement
    # unresolved; this is a regression for correlated mistakes on display fonts.
    truncated_detector_word = engine_word(
        "Mỹ", paddle="M", vietocr="Mỹ", tesseract="Mỹ",
        statuses={"paddleocr": "success", "vietocr": "success", "tesseract": "success"},
    )
    cases.append(_case("paddle-incomplete-prefix-multiengine", truncated_detector_word))

    # Missing evidence.
    for status in STATUSES:
        cases.append({"id": f"no-evidence-{status}", "text": "SÁNG", "ocr_review_status": status,
                      "ocr_evidence": None,
                      "expected_color": classify_word_evidence(status, None, "SÁNG")})
    return cases


def render() -> str:
    return json.dumps(build_cases(), ensure_ascii=False, indent=2) + "\n"


if __name__ == "__main__":
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(render(), encoding="utf-8", newline="\n")
    cases = json.loads(OUTPUT.read_text(encoding="utf-8"))
    summary: dict[str, int] = {}
    for case in cases:
        summary[case["expected_color"]] = summary.get(case["expected_color"], 0) + 1
    print(f"wrote {len(cases)} cases to {OUTPUT}: {summary}")
