from __future__ import annotations

import unittest

from fastapi import HTTPException

from app.services.viread_ocr_training_service import (
    TRAINING_PROFILES,
    _deduplicate_verified_samples,
)


class VireadDualTrainingContracts(unittest.TestCase):
    def test_public_profiles_keep_the_two_training_flows_disjoint(self):
        flow1 = TRAINING_PROFILES["FLOW1_EXTERNAL_TRDG"]
        flow2 = TRAINING_PROFILES["FLOW2_ADMIN_VERIFIED"]

        self.assertEqual(flow1["dataset_flows"], {"FLOW2_EXTERNAL_TRDG"})
        self.assertEqual(flow2["dataset_flows"], {"FLOW1_VERIFIED"})
        self.assertTrue(flow1["dataset_flows"].isdisjoint(flow2["dataset_flows"]))
        self.assertEqual(flow1["minimum_counts"], {"FLOW2_EXTERNAL": 500, "FLOW2_TRDG": 20_000})
        self.assertEqual(flow1["maximum_counts"], {"FLOW2_EXTERNAL": 1_000, "FLOW2_TRDG": 50_000})

    def test_verified_snapshot_deduplicates_identical_crop_and_label(self):
        first = {"sample_id": "first", "image_sha256": "a" * 64, "label": "Tiếng Việt"}
        duplicate = {"sample_id": "second", "image_sha256": "a" * 64, "label": "Tiếng Việt"}

        self.assertEqual(_deduplicate_verified_samples([first, duplicate]), [first])

    def test_verified_snapshot_rejects_same_image_with_conflicting_labels(self):
        first = {"sample_id": "first", "image_sha256": "a" * 64, "label": "Mỹ"}
        conflict = {"sample_id": "second", "image_sha256": "a" * 64, "label": "Mẹ"}

        with self.assertRaises(HTTPException) as raised:
            _deduplicate_verified_samples([first, conflict])

        self.assertEqual(raised.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
