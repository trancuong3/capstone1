"""Synthetic-only tests: held-out photo disjointness and numeric gate.

No user-private OCR image, labeled page, path, token or secret is required.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.ocr_real_photo_benchmark import Case
from scripts.ocr_tesseract_holdout_audit import (
    audit_exact_independence,
    summarize_holdout_report,
)


def _case(root: Path, filename: str, payload: bytes, truth: str) -> Case:
    img = root / filename
    img.write_bytes(payload)
    return Case(img, truth, "clean")


def _report() -> dict[str, object]:
    def quality(chars: int, words: int):
        return {
            "character_edits": chars, "reference_characters": 1500,
            "micro_cer": round(chars / 1500, 6),
            "word_edits": words, "reference_words": 320,
            "micro_wer": round(words / 320, 6),
        }
    def policy(chars: int, words: int, flips: int, corrected: int, regressed: int):
        return {
            "quality": quality(chars, words),
            "flipped_words": flips,
            "corrected_words": corrected,
            "regressed_words": regressed,
            "other_changed_words": 0,
            "flips_without_positional_truth": 0,
            "wer_page_directions": {"improved": 4, "unchanged": 16},
        }
    return {
        "dataset_case_count": 20,
        "successful_cases": 20,
        "failed_cases": 0,
        "runtime_all_cases_verified": True,
        "quality": {
            "baseline_strict": quality(50, 31),
            "ground_truth_blind_rules": {
                "tesseract_line_priority": policy(42, 23, 12, 10, 2),
                "tesseract_line_vietocr_crop_agreement":
                    policy(49, 30, 3, 2, 1),
            },
        },
    }


def _audit(pages: int = 20) -> dict[str, object]:
    return {
        "holdout_pages": pages,
        "exact_overlap_checks_passed": True,
        "independent_photo_provenance_verified": False,
        "reference_manual_audit_verified": False,
        "near_duplicate_images_verified": False,
    }


class HeldoutDisjointTests(unittest.TestCase):
    def test_private_sets_with_distinct_bytes_and_text_pass_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dev = [_case(root, "d.png", b"dev image", "Old text")]
            new = [_case(root, "h.png", b"new image", "Different text")]
            stat = audit_exact_independence(dev, new)
            self.assertTrue(stat["exact_overlap_checks_passed"])
            self.assertFalse(stat["independent_photo_provenance_verified"])
            self.assertEqual(stat["exact_image_content_overlap"], 0)
            self.assertEqual(stat["exact_full_reference_overlap"], 0)
            for private in ("Old text", "Different text", str(root)):
                self.assertNotIn(private, json.dumps(stat))

    def test_reject_copy_with_different_filename_even_if_text_differs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dev = [_case(root, "d.png", b"same bytes", "Old text")]
            new = [_case(root, "h.png", b"same bytes", "Fresh text")]
            with self.assertRaises(ValueError):
                audit_exact_independence(dev, new)

    def test_reject_same_reference_if_photo_bytes_are_different(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dev = [_case(root, "d.png", b"dev image", "Bé mỉm")]
            new = [_case(root, "h.png", b"new image", "Bé   mỉm")]
            with self.assertRaises(ValueError):
                audit_exact_independence(dev, new)

    def test_reject_internal_duplicate_photos_and_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dev = [_case(root, "d.png", b"dev image", "Old text")]
            a = _case(root, "h1.png", b"same new", "New one")
            b = _case(root, "h2.png", b"same new", "New two")
            with self.assertRaises(ValueError):
                audit_exact_independence(dev, [a, b])
            b.image.write_bytes(b"different new")
            c = Case(b.image, "New one", "clean")
            with self.assertRaises(ValueError):
                audit_exact_independence(dev, [a, c])

    def test_empty_sets_are_never_accepted(self):
        with self.assertRaises(ValueError):
            audit_exact_independence([], [])
        with tempfile.TemporaryDirectory() as tmp:
            dev = [_case(Path(tmp), "d.png", b"x", "text")]
            with self.assertRaises(ValueError):
                audit_exact_independence(dev, [])


class HeldoutAggregateTests(unittest.TestCase):
    def test_only_numeric_report_and_never_approve_production(self):
        result = summarize_holdout_report(_report(), _audit(), 20)
        self.assertTrue(result["heldout_exact_disjoint_verified"])
        self.assertFalse(result["production_deployment_allowed"])
        self.assertFalse(result["independent_heldout_acceptance_verified"])
        self.assertIn("observed_correct_to_wrong_regressions", result["reason_codes"])
        primary = result["ground_truth_blind_policies"]["tesseract_line_priority"]
        self.assertEqual(primary["regressed_words"], 2)
        self.assertEqual(primary["quality"]["word_edits"], 23)
        encoded = json.dumps(result, ensure_ascii=False)
        for secret in ("Bé mỉm", ".png", "pages.jsonl", "checkpoint_sha256"):
            self.assertNotIn(secret, encoded)

    def test_missing_one_photo_fails_runtime_gate(self):
        report = _report()
        report["successful_cases"] = 19
        report["failed_cases"] = 1
        report["runtime_all_cases_verified"] = False
        result = summarize_holdout_report(report, _audit(), 20)
        self.assertFalse(result["runtime_all_cases_verified"])
        self.assertIn("incomplete_heldout_evaluation", result["reason_codes"])

    def test_fail_closed_for_missing_audit_or_too_few_photos(self):
        with self.assertRaises(ValueError):
            summarize_holdout_report(_report(), {"holdout_pages": 20}, 20)
        with self.assertRaises(ValueError):
            summarize_holdout_report(_report(), _audit(), 21)
        with self.assertRaises(ValueError):
            summarize_holdout_report(_report(), _audit(10), 20)

    def test_zero_regressions_still_cannot_approve(self):
        report = _report()
        for policy in (
            "tesseract_line_priority",
            "tesseract_line_vietocr_crop_agreement",
        ):
            row = report["quality"]["ground_truth_blind_rules"][policy]
            row["corrected_words"] += row["regressed_words"]
            row["regressed_words"] = 0
        result = summarize_holdout_report(report, _audit(), 20)
        self.assertFalse(result["production_deployment_allowed"])
        self.assertNotIn("observed_correct_to_wrong_regressions", result["reason_codes"])

    def test_count_only_report_rejects_inconsistent_flips_and_pages(self):
        for key, value in (("flipped_words", 13), ("corrected_words", -1)):
            with self.subTest(key=key):
                report = _report()
                report["quality"]["ground_truth_blind_rules"][
                    "tesseract_line_priority"
                ][key] = value
                with self.assertRaises(ValueError):
                    summarize_holdout_report(report, _audit(), 20)
        report = _report()
        report["quality"]["ground_truth_blind_rules"][
            "tesseract_line_priority"
        ]["wer_page_directions"]["improved"] = 5
        with self.assertRaises(ValueError):
            summarize_holdout_report(report, _audit(), 20)

    def test_invalid_quality_types_do_not_leak_into_aggregate(self):
        for bad in ("private label", True, None, float("nan"), float("inf")):
            with self.subTest(bad=bad):
                report = _report()
                report["quality"]["baseline_strict"]["micro_cer"] = bad
                with self.assertRaises(ValueError):
                    summarize_holdout_report(report, _audit(), 20)

    def test_rejects_inconsistent_micro_rates_even_if_numeric(self):
        for field, wrong in (("micro_cer", 0.5), ("micro_wer", 0.25)):
            with self.subTest(field=field):
                report = _report()
                report["quality"]["baseline_strict"][field] = wrong
                with self.assertRaises(ValueError):
                    summarize_holdout_report(report, _audit(), 20)

    def test_rejects_candidate_using_another_reference_denominator(self):
        for denominator in ("reference_characters", "reference_words"):
            with self.subTest(denominator=denominator):
                report = _report()
                candidate = report["quality"]["ground_truth_blind_rules"][
                    "tesseract_line_priority"
                ]["quality"]
                candidate[denominator] += 1
                if denominator == "reference_characters":
                    candidate["micro_cer"] = round(
                        candidate["character_edits"] / candidate[denominator], 6
                    )
                else:
                    candidate["micro_wer"] = round(
                        candidate["word_edits"] / candidate[denominator], 6
                    )
                with self.assertRaises(ValueError):
                    summarize_holdout_report(report, _audit(), 20)

    def test_unscorable_flips_propagate_as_risk(self):
        report = _report()
        report["quality"]["ground_truth_blind_rules"][
            "tesseract_line_priority"
        ]["flips_without_positional_truth"] = 1
        report["quality"]["ground_truth_blind_rules"][
            "tesseract_line_priority"
        ]["corrected_words"] -= 1
        result = summarize_holdout_report(report, _audit(), 20)
        self.assertIn("unresolved_positional_scoring", result["reason_codes"])


if __name__ == "__main__":
    unittest.main()
