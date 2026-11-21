"""Headless CLI contract tests for the local original-photo annotation UI."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import ocr_photo_manual_annotator as annotator


class PhotoAnnotatorCliTests(unittest.TestCase):
    def test_draft_created_resumed_and_locked_without_gui(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "photo.jpg").write_bytes(b"fake bytes for CLI-only test")
            manifest = root / "pages.jsonl"
            manifest.write_text(json.dumps({
                "image": "photo.jpg", "ground_truth": "Bé đọc",
                "condition": "clean",
            }, ensure_ascii=False) + "\n", encoding="utf-8")
            draft = root / "bbox-annotations-ui-draft.jsonl"
            args = [str(manifest), "--draft", str(draft)]
            with mock.patch.object(annotator, "run_gui") as stub:
                self.assertEqual(annotator.main(args), 0)
                self.assertEqual(stub.call_count, 1)
                self.assertEqual(len(stub.call_args.args[0]), 1)
                self.assertFalse(stub.call_args.args[3]["photo.jpg"]["reviewer_confirmed"])
            self.assertTrue(draft.is_file())
            self.assertFalse(Path(str(draft) + ".lock").exists())
            with mock.patch.object(annotator, "run_gui") as stub:
                self.assertEqual(annotator.main(args), 0)
                self.assertEqual(stub.call_count, 1)
            Path(str(draft) + ".lock").write_text("busy", encoding="utf-8")
            with mock.patch.object(annotator, "run_gui") as stub:
                self.assertEqual(annotator.main(args), 2)
                stub.assert_not_called()

    def test_failure_clears_lock_for_next_run(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "p.png").write_bytes(b"fake bytes")
            manifest = root / "pages.jsonl"
            manifest.write_text(json.dumps({
                "image": "p.png", "ground_truth": "đẹp",
            }), encoding="utf-8")
            draft = root / "bbox-annotations-ui-draft.jsonl"
            with mock.patch.object(annotator, "run_gui", side_effect=OSError("private path")):
                self.assertEqual(annotator.main([str(manifest), "--draft", str(draft)]), 2)
            self.assertFalse(Path(str(draft) + ".lock").exists())
            with mock.patch.object(annotator, "run_gui"):
                self.assertEqual(annotator.main([str(manifest), "--draft", str(draft)]), 0)

    def test_rejects_dataset_in_repository(self):
        with mock.patch.object(annotator, "run_gui") as stub:
            # A known backend file is inside the repo, and cannot be treated
            # as the private pages dataset, regardless of its JSONL format.
            self.assertEqual(annotator.main([
                str(annotator.BACKEND_ROOT / "app" / "services" / "ocr_engine.py")
            ]), 2)
            stub.assert_not_called()


if __name__ == "__main__":
    unittest.main()
