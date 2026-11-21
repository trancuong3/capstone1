"""Headless tests for reference-blind Vietnamese OCR tone selection."""
from __future__ import annotations

import copy
import json
import unittest

from scripts.ocr_tone_blind_policy import (
    audit_engine_attribution, audit_evidence_sources, audit_tone_error_sources,
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

    def test_diagnose_crop_only_alternative_despite_zero_policy_flips(self):
        target = word("mìm", {
            "paddleocr": "mìm", "vietocr": "mìm", "tesseract": "mìm",
        })
        target["ocr_evidence"]["crop_evidence"] = {
            "vietocr_candidate": "mỉm",
        }
        output = {"text": "mìm", "words": [target]}
        source = audit_evidence_sources(output)
        self.assertEqual(source["word_positions"], 1)
        self.assertEqual(source["positions_with_any_alternative"], 1)
        self.assertEqual(source["positions_with_crop_alternative"], 1)
        self.assertEqual(source["positions_with_crop_only_alternative"], 1)
        self.assertEqual(source["positions_with_raw_line_alternative"], 0)
        self.assertEqual(source["positions_with_vietocr_line_alternative"], 0)
        errors = audit_tone_error_sources("mỉm", output)
        self.assertEqual(errors["audited_tone_errors"], 1)
        self.assertEqual(errors["errors_with_correct_crop_only_reading"], 1)
        self.assertEqual(errors["errors_with_correct_raw_line_reading"], 0)
        self.assertEqual(propose_text(output, "line_majority_2")["flip_indices"], [])
        self.assertEqual(propose_text(output, "vietocr_line_priority")["flip_indices"], [])

    def test_diagnose_raw_line_alternative_with_unverified_status(self):
        target = word("mìm", {
            "paddleocr": "mỉm", "vietocr": "mìm", "tesseract": "mìm",
        }, statuses={
            "paddleocr": "error", "vietocr": "success", "tesseract": "success",
        })
        output = {"text": "mìm", "words": [target]}
        source = audit_evidence_sources(output)
        self.assertEqual(source["positions_with_raw_line_alternative"], 1)
        self.assertEqual(source["positions_with_verified_line_alternative"], 0)
        self.assertEqual(
            source["positions_with_raw_line_but_no_verified_line_alternative"], 1,
        )
        errors = audit_tone_error_sources("mỉm", output)
        self.assertEqual(errors["errors_with_correct_raw_line_reading"], 1)
        self.assertEqual(errors["errors_with_correct_verified_line_reading"], 0)
        self.assertEqual(errors["errors_with_correct_crop_reading"], 0)

    def test_diagnose_verified_line_alternative_without_policy_proposal(self):
        target = word("mìm", {
            "paddleocr": "mỉm", "vietocr": "mìm", "tesseract": "mìm",
        })
        output = {"text": "mìm", "words": [target]}
        source = audit_evidence_sources(output)
        self.assertEqual(source["positions_with_raw_line_alternative"], 1)
        self.assertEqual(source["positions_with_verified_line_alternative"], 1)
        self.assertEqual(
            audit_tone_error_sources("mỉm", output)[
                "errors_with_correct_verified_line_reading"
            ], 1,
        )
        # A single alternative is not a majority; VietOCR backs the
        # current value. No candidate is ever switched just for an oracle gain.
        self.assertEqual(propose_text(output, "line_majority_2")["flip_indices"], [])
        self.assertEqual(propose_text(output, "vietocr_line_priority")["flip_indices"], [])

    def test_diagnostic_totals_are_numeric_private_and_nonselective(self):
        targets = [
            word("mìm", {"paddleocr": "mìm", "vietocr": "mìm", "tesseract": "mìm"}),
            word("mìm", {"paddleocr": "mỉm", "vietocr": "mìm", "tesseract": "mìm"}),
        ]
        targets[0]["ocr_evidence"]["crop_evidence"] = {"vietocr_candidate": "mỉm"}
        rows = [
            evaluate_case("mỉm", {"text": "mìm", "words": [targets[0]]}),
            evaluate_case("mỉm", {"text": "mìm", "words": [targets[1]]}),
        ]
        summary = summarize_cases(rows)
        self.assertEqual(summary["evidence_source_audit"]["positions_with_any_alternative"], 2)
        self.assertEqual(summary["tone_error_source_audit"]["audited_tone_errors"], 2)
        self.assertEqual(summary["tone_error_source_audit"]["errors_with_correct_crop_only_reading"], 1)
        self.assertEqual(summary["tone_error_source_audit"]["errors_with_correct_verified_line_reading"], 1)
        self.assertEqual(summary["ground_truth_blind_rules"]["line_majority_2"]["flipped_words"], 0)
        for private in ("mìm", "mỉm", "vietocr_candidate"):
            self.assertNotIn(private, json.dumps(summary, ensure_ascii=False))

    def test_unaligned_source_audit_has_no_unverified_oracle_claim(self):
        output = {
            "text": "mìm ...",
            "words": [word("mìm")],
        }
        self.assertEqual(audit_evidence_sources(output)["unaligned_pages"], 1)
        errors = audit_tone_error_sources("mỉm", output)
        self.assertEqual(errors["uncertain_alignment_pages"], 1)
        self.assertEqual(errors["audited_tone_errors"], 0)

    def test_paddle_line_control_can_correct_or_regress_without_reference_leak(self):
        output = {
            "text": "mìm",
            "words": [word("mìm", {
                "paddleocr": "mỉm",
                "vietocr": "mìm",
                "tesseract": "mìm",
            })],
        }
        before = copy.deepcopy(output)
        proposal = propose_text(output, "paddleocr_line_priority")
        self.assertEqual(proposal["candidate_text"], "mỉm")
        self.assertEqual(proposal["flip_indices"], [0])
        good = evaluate_case("mỉm", output)["rules"]["paddleocr_line_priority"]
        bad = evaluate_case("mìm", output)["rules"]["paddleocr_line_priority"]
        self.assertEqual(good["corrected_words"], 1)
        self.assertEqual(good["regressed_words"], 0)
        self.assertEqual(bad["corrected_words"], 0)
        self.assertEqual(bad["regressed_words"], 1)
        self.assertEqual(output, before)

    def test_independent_paddle_line_and_vietocr_crop_agreement(self):
        target = word("mìm", {
            "paddleocr": "mỉm",
            "vietocr": "mìm",
            "tesseract": "mìm",
        })
        target["ocr_evidence"]["crop_evidence"] = {
            "status": "completed", "vietocr_candidate": "mỉm",
        }
        self.assertEqual(
            choose_word(target, "paddle_line_vietocr_crop_agreement"),
            "mỉm",
        )
        self.assertEqual(
            propose_text(
                {"text": "mìm", "words": [target]},
                "paddle_line_vietocr_crop_agreement",
            )["flip_indices"], [0],
        )
        target["ocr_evidence"]["crop_evidence"]["vietocr_candidate"] = "mìm"
        self.assertIsNone(
            choose_word(target, "paddle_line_vietocr_crop_agreement")
        )

    def test_crop_agreement_requires_success_and_no_error(self):
        target = word("mìm", {
            "paddleocr": "mỉm", "vietocr": "mìm", "tesseract": "mìm",
        })
        crop = {"status": "completed", "vietocr_candidate": "mỉm"}
        target["ocr_evidence"]["crop_evidence"] = crop
        for wrong_status in ("partial", "skipped", "not_needed", "pending"):
            crop["status"] = wrong_status
            self.assertIsNone(
                choose_word(target, "paddle_line_vietocr_crop_agreement")
            )
        crop["status"] = "completed"
        crop["vietocr_error"] = "ValueError"
        self.assertIsNone(
            choose_word(target, "paddle_line_vietocr_crop_agreement")
        )
        del crop["vietocr_error"]
        target["ocr_evidence"]["engine_statuses"]["paddleocr"] = "error"
        self.assertIsNone(
            choose_word(target, "paddle_line_vietocr_crop_agreement")
        )
        target["ocr_evidence"]["engine_statuses"]["paddleocr"] = "success"
        target["ocr_evidence"]["engine_statuses"]["vietocr"] = "error"
        self.assertIsNone(
            choose_word(target, "paddle_line_vietocr_crop_agreement")
        )

    def test_same_engine_paddle_crop_does_not_count_as_two_votes(self):
        target = word("mìm", {
            "paddleocr": "mỉm", "vietocr": "mìm", "tesseract": "mìm",
        })
        target["ocr_evidence"]["crop_evidence"] = {
            "status": "completed",
            "paddleocr_candidate": "mỉm",
            "vietocr_candidate": None,
        }
        self.assertIsNone(
            choose_word(target, "paddle_line_vietocr_crop_agreement")
        )

    def test_paddle_policy_preserves_punctuation_and_blocks_unrelated_words(self):
        target = word("“MÌM!”", {
            "paddleocr": "MỈM", "vietocr": "MÌM", "tesseract": "MÌM",
        })
        self.assertEqual(choose_word(target, "paddleocr_line_priority"), "“MỈM!”")
        target["ocr_evidence"]["engine_outputs"]["paddleocr"] = "MÌNH"
        self.assertIsNone(choose_word(target, "paddleocr_line_priority"))

    def test_tesseract_blind_priority_counts_both_correction_and_regression(self):
        target = word("mìm", {
            "paddleocr": "mìm", "vietocr": "mìm", "tesseract": "mỉm",
        })
        output = {"text": "mìm", "words": [target]}
        before = copy.deepcopy(output)
        proposal = propose_text(output, "tesseract_line_priority")
        self.assertEqual(proposal["flip_indices"], [0])
        self.assertEqual(proposal["candidate_text"], "mỉm")
        good = evaluate_case("mỉm", output)["rules"]["tesseract_line_priority"]
        bad = evaluate_case("mìm", output)["rules"]["tesseract_line_priority"]
        self.assertEqual(good["corrected_words"], 1)
        self.assertEqual(bad["regressed_words"], 1)
        self.assertEqual(output, before)

    def test_tesseract_line_and_vietocr_crop_are_distinct_engine_confirmation(self):
        target = word("mìm", {
            "paddleocr": "mìm", "vietocr": "mìm", "tesseract": "mỉm",
        })
        crop = {"status": "completed", "vietocr_candidate": "mỉm"}
        target["ocr_evidence"]["crop_evidence"] = crop
        self.assertEqual(
            choose_word(target, "tesseract_line_vietocr_crop_agreement"), "mỉm"
        )
        crop["vietocr_candidate"] = "mìm"
        self.assertIsNone(
            choose_word(target, "tesseract_line_vietocr_crop_agreement")
        )
        crop["vietocr_candidate"] = "mỉm"
        for status in ("partial", "skipped", "pending", "not_needed"):
            crop["status"] = status
            self.assertIsNone(
                choose_word(target, "tesseract_line_vietocr_crop_agreement")
            )
        crop["status"] = "completed"
        crop["vietocr_error"] = "OSError"
        self.assertIsNone(
            choose_word(target, "tesseract_line_vietocr_crop_agreement")
        )
        del crop["vietocr_error"]
        target["ocr_evidence"]["engine_statuses"]["tesseract"] = "error"
        self.assertIsNone(
            choose_word(target, "tesseract_line_vietocr_crop_agreement")
        )
        target["ocr_evidence"]["engine_statuses"]["tesseract"] = "success"
        target["ocr_evidence"]["engine_statuses"]["vietocr"] = "no_result"
        self.assertIsNone(
            choose_word(target, "tesseract_line_vietocr_crop_agreement")
        )

    def test_same_tesseract_crop_is_not_independent_vietocr_confirmation(self):
        target = word("mìm", {
            "paddleocr": "mìm", "vietocr": "mìm", "tesseract": "mỉm",
        })
        target["ocr_evidence"]["crop_evidence"] = {
            "status": "completed", "tesseract_candidate": "mỉm"
        }
        self.assertIsNone(
            choose_word(target, "tesseract_line_vietocr_crop_agreement")
        )

    def test_engine_specific_correct_tone_attribution_does_not_choose_correct_answer(self):
        target = word("mìm", {
            "paddleocr": "mím", "vietocr": "mìm", "tesseract": "mỉm",
        })
        target["ocr_evidence"]["crop_evidence"] = {
            "status": "completed",
            "paddleocr_candidate": "mỉm",
            "vietocr_candidate": "mỉm",
        }
        output = {"text": "mìm", "words": [target]}
        stats = audit_engine_attribution("mỉm", output)
        self.assertEqual(stats["audited_tone_errors"], 1)
        self.assertEqual(stats["correct_tone_tesseract_verified_line_errors"], 1)
        self.assertEqual(stats["correct_tone_paddleocr_verified_line_errors"], 0)
        self.assertEqual(stats["correct_tone_paddleocr_crop_errors"], 1)
        self.assertEqual(stats["correct_tone_vietocr_crop_errors"], 1)
        self.assertEqual(stats["alternative_vietocr_verified_line_positions"], 0)
        self.assertEqual(
            propose_text(output, "tesseract_line_vietocr_crop_agreement")["flip_indices"], [0]
        )
        self.assertEqual(output["words"][0]["text"], "mìm")
        summary = summarize_cases([evaluate_case("mỉm", output)])
        self.assertEqual(
            summary["engine_attribution_audit"][
                "correct_tone_tesseract_verified_line_errors"
            ], 1
        )
        for private in ("mìm", "mỉm"):
            self.assertNotIn(private, json.dumps(summary, ensure_ascii=False))

    def test_engine_audit_rejects_weak_page_alignment(self):
        output = {"text": "mìm ...", "words": [word("mìm", {
            "paddleocr": "mỉm",
        })]}
        stats = audit_engine_attribution("mỉm", output)
        self.assertEqual(stats["unaligned_pages"], 1)
        self.assertEqual(stats["audited_tone_errors"], 0)
        self.assertEqual(stats["correct_tone_paddleocr_verified_line_errors"], 0)

    def test_unknown_rule_is_rejected(self):
        with self.assertRaises(ValueError):
            propose_text({"text": "mìm", "words": [word("mìm")]}, "oracle_choose_gt")


if __name__ == "__main__":
    unittest.main()
