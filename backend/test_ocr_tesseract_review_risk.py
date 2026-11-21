"""Pure count-only risk and production abstention checks for TASK 13."""
from __future__ import annotations

import json
import unittest

from scripts.ocr_tesseract_review_risk import assess_review_risk


def report(broad=None, confirmed=None):
    return {
        "dataset_pages": 10,
        "successful_pages": 10,
        "failed_pages": 0,
        "policy_flip_review_counts": {
            "tesseract_line_priority": broad or {
                "flips": 18, "corrected": 12, "regressed": 3,
                "changed_other": 2, "ambiguous": 1,
            },
            "tesseract_line_vietocr_crop_agreement": confirmed or {
                "flips": 5, "corrected": 3, "regressed": 1,
                "changed_other": 0, "ambiguous": 1,
            },
        },
    }


class TesseractRiskTests(unittest.TestCase):
    def test_real_task12_counts_are_blocked_and_correctly_derived(self):
        scored = assess_review_risk(report())
        self.assertFalse(scored["production_deployment_allowed"])
        self.assertIn("not_independent_held_out", scored["reason_codes"])
        self.assertIn("correct_to_wrong_regressions", scored["reason_codes"])
        self.assertIn("unresolved_token_alignment", scored["reason_codes"])
        broad = scored["per_policy"]["tesseract_line_priority"]
        self.assertEqual(broad["review_required"], 6)
        self.assertEqual(broad["confirmed_corrected_by_position"], 12)
        self.assertEqual(broad["confirmed_regressed_by_position"], 3)
        self.assertEqual(broad["regression_fraction_of_flips"], round(3/18, 6))
        self.assertEqual(
            scored["per_policy"]["tesseract_line_vietocr_crop_agreement"][
                "review_required"
            ], 2,
        )
        self.assertNotIn("mỉm", json.dumps(scored, ensure_ascii=False))

    def test_latest_uniquely_aligned_gallery_counts_still_block_production(self):
        """Counts-only 10-page fixture: private glyphs and references stay local."""
        broad = {
            "flips": 18, "corrected": 13, "regressed": 3,
            "changed_other": 2, "ambiguous": 0,
        }
        confirmed = {
            "flips": 5, "corrected": 4, "regressed": 1,
            "changed_other": 0, "ambiguous": 0,
        }
        latest = report(broad, confirmed)
        scored = assess_review_risk(latest)
        self.assertFalse(scored["production_deployment_allowed"])
        self.assertIn("correct_to_wrong_regressions", scored["reason_codes"])
        self.assertNotIn("unresolved_token_alignment", scored["reason_codes"])
        self.assertIn("not_independent_held_out", scored["reason_codes"])
        self.assertIn("word_boxes_not_verified", scored["reason_codes"])
        primary = scored["per_policy"]["tesseract_line_priority"]
        strict = scored["per_policy"]["tesseract_line_vietocr_crop_agreement"]
        self.assertEqual(primary["confirmed_corrected_by_position"], 13)
        self.assertEqual(primary["confirmed_regressed_by_position"], 3)
        self.assertEqual(primary["ambiguous_position"], 0)
        self.assertEqual(primary["review_required"], 5)
        self.assertEqual(strict["confirmed_corrected_by_position"], 4)
        self.assertEqual(strict["confirmed_regressed_by_position"], 1)
        self.assertEqual(strict["review_required"], 1)
        self.assertEqual(primary["correction_fraction_of_flips"], round(13/18, 6))
        self.assertEqual(strict["correction_fraction_of_flips"], 0.8)
        serialized = json.dumps(scored, ensure_ascii=False)
        for private_text in ("pages.jsonl", "crops/", "index.html"):
            self.assertNotIn(private_text, serialized)

    def test_no_flips_is_not_production_approval(self):
        no_changes = {"flips": 0, "corrected": 0, "regressed": 0,
                      "changed_other": 0, "ambiguous": 0}
        scored = assess_review_risk(report(no_changes, no_changes))
        self.assertFalse(scored["production_deployment_allowed"])
        self.assertIsNone(
            scored["per_policy"]["tesseract_line_priority"][
                "correction_fraction_of_flips"
            ]
        )

    def test_invalid_flip_totals_are_rejected(self):
        data = report()
        data["policy_flip_review_counts"]["tesseract_line_priority"]["flips"] = 17
        with self.assertRaises(ValueError):
            assess_review_risk(data)

    def test_bools_negatives_floats_and_missing_fields_are_rejected(self):
        for bad in (True, -1, 1.0, "3", None):
            with self.subTest(bad=bad):
                data = report()
                data["policy_flip_review_counts"]["tesseract_line_priority"][
                    "regressed"
                ] = bad
                with self.assertRaises(ValueError):
                    assess_review_risk(data)

    def test_incomplete_page_count_is_rejected(self):
        data = report()
        data["successful_pages"] = 9
        with self.assertRaises(ValueError):
            assess_review_risk(data)

    def test_failed_page_does_not_disappear_from_qualifications(self):
        data = report()
        data["successful_pages"] = 9
        data["failed_pages"] = 1
        scored = assess_review_risk(data)
        self.assertIn("incomplete_benchmark", scored["reason_codes"])
        self.assertFalse(scored["production_deployment_allowed"])


if __name__ == "__main__":
    unittest.main()
