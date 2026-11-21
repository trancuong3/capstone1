"""Tests for private human word-box annotation drafts and export guards."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.ocr_manual_annotation_store import (
    add_word, annotation_key, confirm_page, edit_word, export_reviewed,
    load_or_create_draft, move_word, normalized_drag_box, persist_draft,
    remove_word, validate_draft_path,
)
from scripts.ocr_word_box_iou import load_manual_annotations


class ManualAnnotationStoreTests(unittest.TestCase):
    def test_pixel_drag_normalization_preserves_original_coordinates(self):
        self.assertEqual(
            normalized_drag_box(20, 10, 60, 30, 200, 100),
            [0.1, 0.1, 0.2, 0.2],
        )
        self.assertEqual(
            normalized_drag_box(60, 30, 20, 10, 200, 100),
            [0.1, 0.1, 0.2, 0.2],
        )
        self.assertEqual(
            normalized_drag_box(-20, -10, 210, 110, 200, 100),
            [0, 0, 1, 1],
        )
        for values in ((10, 10, 10, 30), (2, 2, 10, 10)):
            if values == (2, 2, 10, 10):
                with self.assertRaises(ValueError):
                    normalized_drag_box(*values, 0, 100)
            else:
                with self.assertRaises(ValueError):
                    normalized_drag_box(*values, 200, 100)
        with self.assertRaises(ValueError):
            normalized_drag_box(float("nan"), 0, 10, 10, 200, 100)

    def test_state_changes_reset_review_and_keep_diacritics(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bbox-annotations-ui-draft.jsonl"
            records = load_or_create_draft(path, ["page.png"])
            record = records["page.png"]
            self.assertEqual(record["annotation_source"], "unverified")
            self.assertEqual(record["words"], [])
            box = [0.1, 0.2, 0.3, 0.1]
            with self.assertRaises(ValueError):
                add_word(record, "Bé đang", box)
            add_word(record, "đọc", box)
            add_word(record, "sách.", [0.5, 0.2, 0.3, 0.1])
            confirm_page(record)
            self.assertTrue(record["reviewer_confirmed"])
            edit_word(record, 0, "ĐỌC")
            self.assertFalse(record["reviewer_confirmed"])
            self.assertEqual(record["words"][0]["text"], "ĐỌC")
            confirm_page(record)
            move_word(record, 0, 1)
            self.assertFalse(record["reviewer_confirmed"])
            self.assertEqual(record["words"][0]["text"], "sách.")
            confirm_page(record)
            remove_word(record, 1)
            self.assertFalse(record["reviewer_confirmed"])
            self.assertEqual(len(record["words"]), 1)

    def test_private_draft_resume_and_atomic_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bbox-annotations-ui-draft.jsonl"
            keys = ["images/a.png", "images/b.jpg"]
            records = load_or_create_draft(path, keys)
            add_word(records[keys[0]], "Bé", [0.1, 0.1, 0.2, 0.1])
            persist_draft(path, keys, records)
            second = load_or_create_draft(path, keys)
            self.assertEqual(second[keys[0]]["words"][0]["text"], "Bé")
            self.assertEqual(second[keys[1]]["words"], [])
            self.assertFalse(second[keys[0]]["reviewer_confirmed"])
            self.assertNotIn(str(Path(tmp)), path.read_text(encoding="utf-8"))
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), [path.name])
            with self.assertRaises(ValueError):
                load_or_create_draft(path, ["images/a.png"])
            self.assertEqual(annotation_key(Path(tmp) / "images" / "a.png", Path(tmp)), "images/a.png")

    def test_rejects_manually_undeclared_or_corrupt_draft(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bbox-annotations-ui-draft.jsonl"
            load_or_create_draft(path, ["a.png"])
            path.write_text(
                json.dumps({
                    "image": "a.png", "annotation_source": "synthetic_renderer",
                    "reviewer_confirmed": True,
                    "coordinate_space": "normalized_original_dimensions",
                    "words": [{"text": "Bé", "bbox": [0.1, 0.2, 0.2, 0.1]}],
                }), encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                load_or_create_draft(path, ["a.png"])
            path.write_text("{invalid json", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_or_create_draft(path, ["a.png"])

    def test_export_requires_all_pages_confirmed_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            draft = root / "bbox-annotations-ui-draft.jsonl"
            keys = ["a.png", "b.png"]
            records = load_or_create_draft(draft, keys)
            add_word(records["a.png"], "Bé", [0.1, 0.1, 0.1, 0.1])
            confirm_page(records["a.png"])
            target = root / "bbox-annotations-manual.jsonl"
            with self.assertRaises(ValueError):
                export_reviewed(target, draft, keys, records, Path(__file__).resolve().parent)
            self.assertFalse(target.exists())
            add_word(records["b.png"], "đọc", [0.2, 0.2, 0.1, 0.1])
            confirm_page(records["b.png"])
            export_reviewed(target, draft, keys, records, Path(__file__).resolve().parent)
            accepted = load_manual_annotations(target, set(keys))
            self.assertEqual(len(accepted), 2)
            self.assertEqual(accepted["b.png"][0]["text"], "đọc")
            with self.assertRaises(FileExistsError):
                export_reviewed(target, draft, keys, records, Path(__file__).resolve().parent)
            self.assertTrue(draft.is_file())

    def test_rejects_unsafe_draft_paths_or_repo_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = root / "pages.jsonl"
            repo = root / "repository"
            repo.mkdir()
            with self.assertRaises(ValueError):
                validate_draft_path(
                    repo / "pages.jsonl",
                    repo / "bbox-annotations-ui-draft.jsonl",
                    repo,
                )
            with self.assertRaises(ValueError):
                validate_draft_path(
                    manifest, manifest, repo,
                )
            with self.assertRaises(ValueError):
                validate_draft_path(
                    manifest, root / "bbox-annotations-manual.jsonl", repo,
                )
            with self.assertRaises(ValueError):
                validate_draft_path(
                    manifest, root / "other" / "bbox-annotations-draft.jsonl", repo,
                )


if __name__ == "__main__":
    unittest.main()
