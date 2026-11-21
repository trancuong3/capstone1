"""Dependency-free tests for the private photographic OCR evaluation runner."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "scripts" / "ocr_real_photo_benchmark.py"
spec = importlib.util.spec_from_file_location("ocr_real_photo_benchmark", SCRIPT)
assert spec and spec.loader
import sys
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class PhotoBenchmarkTests(unittest.TestCase):
    def test_marks_and_whitespace(self):
        self.assertEqual(module.normalize("A\u0301  \n đẹp"), "Á đẹp")
        self.assertEqual(module.edit_distance(list("sách"), list("sach")), 1)
        self.assertEqual(module.edit_distance("a b".split(), "a c".split()), 1)
        self.assertEqual(module.edit_distance([], list("abc")), 3)
        self.assertEqual(module.edit_distance(list("abc"), []), 3)

    def test_dataset_only_accepts_distinct_local_images_and_reference(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "page.png").write_bytes(b"fixture")
            manifest = root / "pages.jsonl"
            manifest.write_text(json.dumps({"image": "page.png", "ground_truth": "Bé An đẹp."}, ensure_ascii=False), encoding="utf-8")
            result = module.load_cases(manifest)
            self.assertEqual(result[0].truth, "Bé An đẹp.")
            self.assertEqual(result[0].condition, "unspecified")
            with manifest.open("a", encoding="utf-8") as f:
                f.write("\n" + json.dumps({"image": "page.png", "ground_truth": "Bé An đẹp."}))
            with self.assertRaisesRegex(ValueError, "duplicate"):
                module.load_cases(manifest)

    def test_rejects_path_traversal_and_missing_truth(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "pages.jsonl").write_text(json.dumps({"image": "../outside.png", "ground_truth": "đúng"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid image path"):
                module.load_cases(root / "pages.jsonl")
            (root / "pages.jsonl").write_text(json.dumps({"image": "page.png", "ground_truth": ""}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ground_truth"):
                module.load_cases(root / "pages.jsonl")

    def test_percentiles(self):
        self.assertEqual(module.percentile([10, 20, 30, 40], 0.95), 40)
        self.assertIsNone(module.percentile([], 0.50))


if __name__ == "__main__":
    unittest.main()
