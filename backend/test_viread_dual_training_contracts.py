from __future__ import annotations

import unittest

from fastapi import HTTPException

from app.services.viread_ocr_training_service import (
    TRAINING_PROFILES,
    _deduplicate_verified_samples,
    _canonicalize_legacy_verified_snapshot,
    _verified_snapshot,
    _verified_snapshot_db_rows,
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

    def test_verified_snapshot_prefers_validation_copy_to_prevent_split_leakage(self):
        common = {
            "image_storage_path": "ocr-training/flow2/admin-verified/sample.png",
            "label": "Tiếng Việt", "source_revision_id": "revision-1", "provenance": {},
        }
        train = {
            **common, "sample_id": "train-copy", "group_id": "page-train", "split": "train",
            "image_sha256": "a" * 64, "source_page_id": "page-train",
        }
        validation = {
            **common, "sample_id": "validation-copy", "group_id": "page-validation",
            "split": "validation", "image_sha256": "a" * 64,
            "source_page_id": "page-validation",
        }
        unique_train = {
            **common, "sample_id": "unique-train", "group_id": "page-train", "split": "train",
            "image_sha256": "b" * 64, "source_page_id": "page-train",
        }

        manifest, selected = _verified_snapshot([train, validation, unique_train])

        self.assertEqual({item["sample_id"] for item in selected}, {"validation-copy", "unique-train"})
        self.assertEqual({item["split"] for item in manifest["samples"]}, {"train", "validation"})
        self.assertEqual(len({item["image_sha256"] for item in manifest["samples"]}), 2)
        reversed_manifest, reversed_selected = _verified_snapshot([unique_train, validation, train])
        self.assertEqual(reversed_selected, selected)
        self.assertEqual(reversed_manifest, manifest)

    def test_verified_snapshot_preserves_holdout_copy_over_train_and_validation(self):
        base = {
            "image_storage_path": "ocr-training/flow2/admin-verified/sample.png",
            "label": "Tiếng Việt", "image_sha256": "c" * 64,
        }
        rows = [
            {**base, "sample_id": "train-copy", "group_id": "train-page", "split": "train"},
            {**base, "sample_id": "validation-copy", "group_id": "validation-page", "split": "validation"},
            {**base, "sample_id": "holdout-copy", "group_id": "holdout-page", "split": "holdout"},
        ]

        _, selected = _verified_snapshot(rows)

        self.assertEqual([item["sample_id"] for item in selected], ["holdout-copy"])

    def test_verified_snapshot_rejects_same_image_with_conflicting_labels(self):
        first = {"sample_id": "first", "image_sha256": "a" * 64, "label": "Mỹ"}
        conflict = {"sample_id": "second", "image_sha256": "a" * 64, "label": "Mẹ"}

        with self.assertRaises(HTTPException) as raised:
            _deduplicate_verified_samples([first, conflict])

        self.assertEqual(raised.exception.status_code, 409)

    def test_verified_snapshot_manifest_and_rows_use_the_same_deduplicated_sources(self):
        first = {
            "sample_id": "source-1", "group_id": "page-1", "split": "train",
            "image_storage_path": "ocr-training/flow2/admin-verified/one.png",
            "image_sha256": "a" * 64, "label": "Tiếng Việt", "source_page_id": "page-1",
            "source_revision_id": "revision-1", "provenance": {"verified_by_admin": True},
        }
        duplicate = {**first, "sample_id": "source-2"}

        manifest, unique_sources = _verified_snapshot([first, duplicate])
        rows = _verified_snapshot_db_rows("dataset-1", unique_sources)

        self.assertEqual(manifest["schema"], "viread-dataset-v1")
        self.assertEqual(manifest["snapshot_strategy"], "cumulative-deduplicated-v3-split-safe")
        self.assertEqual(len(manifest["samples"]), 1)
        self.assertEqual(len(rows), len(manifest["samples"]))
        self.assertEqual(rows[0]["source_annotation_id"], "source-1")
        self.assertEqual(rows[0]["dataset_id"], "dataset-1")
        self.assertEqual(rows[0]["source_revision_id"], "revision-1")

    def test_legacy_snapshot_is_rebuilt_only_when_duplicate_hashes_exist(self):
        first = {
            "sample_id": "source-1", "group_id": "page-1", "split": "train",
            "image_storage_path": "ocr-training/flow2/admin-verified/one.png",
            "image_sha256": "a" * 64, "label": "Tiếng Việt", "source_page_id": "page-1",
            "source_revision_id": "revision-1", "provenance": {},
        }
        duplicate = {**first, "sample_id": "source-2"}

        needs_rebuild, manifest, canonical = _canonicalize_legacy_verified_snapshot([first, duplicate])

        self.assertTrue(needs_rebuild)
        self.assertEqual(len(canonical), 1)
        self.assertEqual(manifest["samples"][0]["sample_id"], "source-1")

    def test_legacy_snapshot_refuses_duplicate_rows_that_leak_page_across_splits(self):
        first = {
            "sample_id": "source-1", "group_id": "page-1", "split": "train",
            "image_storage_path": "ocr-training/flow2/admin-verified/one.png",
            "image_sha256": "a" * 64, "label": "Tiếng Việt", "source_page_id": "page-1",
            "source_revision_id": "revision-1", "provenance": {},
        }
        conflicting_split = {**first, "sample_id": "source-2", "split": "validation"}

        with self.assertRaises(HTTPException) as raised:
            _canonicalize_legacy_verified_snapshot([first, conflicting_split])

        self.assertEqual(raised.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
