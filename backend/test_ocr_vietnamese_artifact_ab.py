"""Tests for offline OCR diacritic alternatives and false-tail hypotheses."""
from __future__ import annotations

import json
import unittest

from scripts.ocr_vietnamese_artifact_ab import (
    evaluate_case, propose_isolated_tail_trim, score_pair,
    summarize_cases, tone_alternatives,
)


def word(token: str, y: float = 0.12, height: float = 0.02, *, evidence=None) -> dict:
    row = {"text": token, "bbox": [0.15, y, 0.04, height]}
    if evidence is not None:
        row["ocr_evidence"] = evidence
    return row


def page_with_distant_tail() -> tuple[str, dict]:
    body = [word("Bé", 0.10 + (i // 5) * 0.035) for i in range(15)]
    tail = [word("I", 0.62, 0.06), word("I", 0.69, 0.06), word("V", 0.76, 0.06)]
    all_words = body + tail
    expected = " ".join(w["text"] for w in body)
    return expected, {"text": " ".join(w["text"] for w in all_words), "words": all_words}


class ArtifactABTests(unittest.TestCase):
    def test_tone_alternatives_require_same_base_and_are_not_corrected(self):
        reading = word("mìm", evidence={
            "engine_outputs": {
                "paddleocr": "mỉm", "vietocr": "mìm", "tesseract": "mùa",
            },
            "crop_evidence": {"vietocr_candidate": "mím", "tesseract_candidate": "đọc"},
        })
        self.assertEqual(tone_alternatives(reading), {"mỉm", "mím"})
        self.assertEqual(reading["text"], "mìm")
        self.assertEqual(
            tone_alternatives(word("doc", evidence={
                "engine_outputs": {"vietocr": "đọc", "paddleocr": "doc"}
            })), {"đọc"}
        )
        self.assertEqual(tone_alternatives(word("mìm")), set())
        self.assertEqual(tone_alternatives({"text": "<", "ocr_evidence": {}}), set())

    def test_tail_proposal_is_reference_independent_and_preserves_original(self):
        expected, output = page_with_distant_tail()
        before = json.dumps(output, ensure_ascii=False)
        result = propose_isolated_tail_trim(output)
        self.assertEqual(result["status"], "proposed_review_only")
        self.assertEqual(result["removed_tokens"], 3)
        self.assertEqual(result["candidate_text"], expected)
        self.assertEqual(json.dumps(output, ensure_ascii=False), before)
        scored = evaluate_case(expected, output)
        self.assertEqual(scored["baseline"]["word_edits"], 3)
        self.assertEqual(scored["candidate"]["word_edits"], 0)
        self.assertEqual(scored["wer_direction"], "improved_wer")
        self.assertEqual(scored["tail_removed"], 3)

    def test_guard_does_not_strip_legitimate_nearby_roman_character(self):
        expected, output = page_with_distant_tail()
        output["words"][-3:] = [word("I", 0.20, 0.02)]
        output["text"] = " ".join(w["text"] for w in output["words"])
        result = propose_isolated_tail_trim(output)
        self.assertEqual(result["status"], "no_proposal")
        self.assertEqual(result["removed_tokens"], 0)

    def test_no_trim_on_weak_alignment_or_invalid_boxes(self):
        _, output = page_with_distant_tail()
        output["text"] += " ..."
        self.assertEqual(propose_isolated_tail_trim(output)["status"], "not_evaluable")
        _, output = page_with_distant_tail()
        output["words"][-1]["bbox"] = [-1, 0, 0.2, 0.2]
        self.assertEqual(propose_isolated_tail_trim(output)["status"], "not_evaluable")
        self.assertEqual(propose_isolated_tail_trim({"text": "", "words": []})["status"], "not_evaluable")

    def test_tone_oracle_finds_supported_alternative_without_editing_text(self):
        prediction = word("mìm", evidence={
            "engine_outputs": {"vietocr": "mìm", "paddleocr": "mỉm"},
        })
        output = {"text": "mìm", "words": [prediction]}
        scored = evaluate_case("mỉm", output)
        self.assertEqual(scored["observed_tone_errors"], 1)
        self.assertEqual(scored["tone_errors_with_correct_engine_alternative"], 1)
        self.assertEqual(scored["evidence_words_with_tone_alternative"], 1)
        self.assertEqual(scored["candidate"]["word_edits"], 1)
        self.assertEqual(prediction["text"], "mìm")
        self.assertEqual(scored["tail_status"], "no_proposal")

    def test_unaligned_words_never_get_oracle_credit(self):
        output = {"text": "mìm", "words": [word("mỉm", evidence={
            "engine_outputs": {"paddleocr": "mỉm"}
        })]}
        result = evaluate_case("mỉm", output)
        self.assertEqual(result["tone_oracle_unaligned_cases"], 1)
        self.assertEqual(result["tone_errors_with_correct_engine_alternative"], 0)

    def test_aggregate_is_numeric_and_keeps_strict_baseline(self):
        expected, output = page_with_distant_tail()
        entries = [evaluate_case(expected, output),
                   evaluate_case("mỉm", {"text": "mìm", "words": [word("mìm")]})]
        summary = summarize_cases(entries)
        self.assertEqual(summary["baseline_strict"]["word_edits"], 4)
        self.assertEqual(summary["isolated_tail_hypothesis_strict"]["word_edits"], 1)
        self.assertEqual(summary["proposed_tokens_removed_total"], 3)
        self.assertFalse(summary["production_inference_modified"])
        text = json.dumps(summary, ensure_ascii=False)
        for secret in ("Bé", "mìm", "mỉm", "I I V"):
            self.assertNotIn(secret, text)
        self.assertEqual(summary["wer_page_directions"]["improved_wer"], 1)

    def test_possible_false_positive_is_not_automatically_accepted(self):
        _, output = page_with_distant_tail()
        # These could be genuine bottom-of-page Roman numerals. Scoring
        # against that hypothetical truth must demonstrate a regression.
        real_reference = output["text"]
        case = evaluate_case(real_reference, output)
        self.assertEqual(case["wer_direction"], "worsened_wer")
        self.assertEqual(case["baseline"]["word_edits"], 0)
        self.assertEqual(case["candidate"]["word_edits"], 3)


if __name__ == "__main__":
    unittest.main()
