"""Headless tests for reference-blind Vietnamese OCR tone selection."""
from __future__ import annotations

import copy
import json
import unittest

from scripts.ocr_tone_blind_policy import (
    choose_word, evaluate_case, propose_text, summarize_cases,
)


def word(text, readings=None, statuses=None, bbox=None):
    return {
        "text": text,
        "bbox": bbox or [0.2, 0.2, 0.1, 0.05],
        "ocr_evidence": {
            "engine_outputs": readings or {},
            "engine_statuses": statuses or {
                "paddleocr": "success",
                "vietocr": "success",
                "tesseract": "success",
            },
        },
    }


class ToneBlindPolicyTests(unittest.TestCase):
    def test_majority_requires_two_different_engines_with_same_tone(self):
        target = word("mìm", {
            "paddleocr": "mỉm", "vietocr": "mỉm", "tesseract": "mìm"
        })
        self.assertEqual(choose_word(target, "line_majority_2"), "mỉm")
        self.assertEqual(choose_word(target, "vietocr_line_priority"), "mỉm")
        target["ocr_evidence"]["engine_outputs"]["vietocr"] = "mìm"
        self.assertIsNone(choose_word(target, "line_majority_2"))
        self.assertEqual(choose_word(target, "vietocr_line_priority"), None)

    def test_ignores_unverified_engine_status_and_different_base(self):
        target = word("mìm", {
            "paddleocr": "mỉm", "vietocr": "mỉm", "tesseract": "mìm"
        }, statuses={
            "paddleocr": "error", "vietocr": "success", "tesseract": "success"
        })
        self.assertIsNone(choose_word(target, "line_majority_2"))
        target["ocr_evidence"]["engine_outputs"]["vietocr"] = "mùa"
        self.assertIsNone(choose_word(target, "vietocr_line_priority"))

    def test_same_base_diacritic_and_vietnamese_d_stroke_supported(self):
        target = word("doc", {
            "paddleocr": "đọc", "vietocr": "đọc", "tesseract": "doc",
        })
        self.assertEqual(choose_word(target, "line_majority_2"), "đọc")
        target["text"] = "DOC"
        self.assertEqual(choose_word(target, "line_majority_2"), "ĐỌC")
        target["text"] = "Doc"
        self.assertEqual(choose_word(target, "line_majority_2"), "Đọc")

    def test_preserves_existing_quotes_case_and_punctuation(self):
        target = word("“MÈO!”", {
            "paddleocr": "MÈO", "vietocr": "MẺO", "tesseract": "MẺO"
        })
        self.assertEqual(choose_word(target, "line_majority_2"), "“MẺO!”")
        self.assertEqual(choose_word(target, "vietocr_line_priority"), "“MẺO!”")
        self.assertEqual(target["text"], "“MÈO!”")

    def test_proposals_do_not_access_reference_and_do_not_mutate(self):
        proposed = {
            "text": "mìm đẹp",
            "words": [
                word("mìm", {
                    "paddleocr": "mỉm", "vietocr": "mỉm", "tesseract": "mìm"
                }),
                word("đẹp", {
                    "paddleocr": "đẹp", "vietocr": "đẹp", "tesseract": "đẹp"
                }),
            ],
        }
        before = copy.deepcopy(proposed)
        result = propose_text(proposed, "line_majority_2")
        self.assertEqual(result["candidate_text"], "mỉm đẹp")
        self.assertEqual(result["flip_indices"], [0])
        self.assertEqual(proposed, before)
        a = evaluate_case("mỉm đẹp", proposed)
        b = evaluate_case("mìm đẹp", proposed)
        self.assertEqual(a["rules"]["line_majority_2"]["quality"]["word_edits"], 0)
        self.assertEqual(b["rules"]["line_majority_2"]["quality"]["word_edits"], 1)
        self.assertEqual(a["rules"]["line_majority_2"]["corrected_words"], 1)
        self.assertEqual(b["rules"]["line_majority_2"]["regressed_words"], 1)

    def test_reference_mismatch_and_word_count_mismatch_abstain(self):
        output = {
            "text": "mìm ...",
            "words": [word("mìm", {
                "paddleocr": "mỉm", "vietocr": "mỉm", "tesseract": "mìm"
            })],
        }
        self.assertEqual(propose_text(output, "line_majority_2")["status"], "not_evaluable")
        output["words"][0]["bbox"] = [-1, 0, 0.4, 0.1]
        self.assertEqual(propose_text(output, "vietocr_line_priority")["status"], "not_evaluable")

    def test_ambiguous_3_way_tie_abstains(self):
        original = word("mìm", {
            "paddleocr": "mím", "vietocr": "mỉm", "tesseract": "mìm",
        })
        self.assertIsNone(choose_word(original, "line_majority_2"))
        self.assertEqual(choose_word(original, "vietocr_line_priority"), "mỉm")

    def test_guard_against_choosing_engine_that_changes_base_letters(self):
        original = word("quá", {
            "paddleocr": "quái", "vietocr": "quái", "tesseract": "quá",
        })
        self.assertIsNone(choose_word(original, "line_majority_2"))
        self.assertIsNone(choose_word(original, "vietocr_line_priority"))

    def test_detect_false_correction_and_private_aggregate_only(self):
        output = {
            "text": "mìm",
            "words": [word("mìm", {
                "paddleocr": "mỉm", "vietocr": "mỉm", "tesseract": "mìm"
            })],
        }
        rows = [evaluate_case("mìm", output), evaluate_case("mỉm", output)]
        summary = summarize_cases(rows)
        rule = summary["ground_truth_blind_rules"]["line_majority_2"]
        self.assertEqual(rule["flipped_words"], 2)
        self.assertEqual(rule["regressed_words"], 1)
        self.assertEqual(rule["corrected_words"], 1)
        self.assertEqual(rule["quality"]["word_edits"], 1)
        self.assertFalse(summary["production_inference_modified"])
        sanitized = json.dumps(summary, ensure_ascii=False)
        for private in ("mìm", "mỉm", "I I V"):
            self.assertNotIn(private, sanitized)

    def test_unequal_reference_token_count_has_no_positional_claims(self):
        output = {
            "text": "mìm",
            "words": [word("mìm", {
                "paddleocr": "mỉm", "vietocr": "mỉm", "tesseract": "mìm",
            })],
        }
        result = evaluate_case("Bé mỉm", output)
        values = result["rules"]["line_majority_2"]
        self.assertEqual(values["flips_without_positional_truth"], 1)
        self.assertEqual(values["corrected_words"], 0)
        self.assertEqual(values["regressed_words"], 0)

    def test_unknown_rule_is_rejected(self):
        with self.assertRaises(ValueError):
            propose_text({"text": "mìm", "words": [word("mìm")]}, "oracle_choose_gt")


if __name__ == "__main__":
    unittest.main()
