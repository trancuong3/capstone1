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

    def test_cli_loads_private_env_without_printing_credentials(self):
        import contextlib
        import io
        import os
        from unittest import mock

        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "page.png").write_bytes(b"placeholder")
            manifest = root / "pages.jsonl"
            manifest.write_text(
                json.dumps({"image": "page.png", "ground_truth": "Xin chào"}, ensure_ascii=False),
                encoding="utf-8",
            )
            env_file = root / "local.env"
            env_file.write_text(
                "DATABASE_URL=postgresql+asyncpg://testing:testing@127.0.0.1:1/test\n"
                "SUPABASE_URL=https://example.invalid\n"
                "SUPABASE_KEY=private-test-key-not-for-output\n",
                encoding="utf-8",
            )

            def fake_evaluate(cases, *, expected_profile, expected_sha):
                self.assertEqual(len(cases), 1)
                self.assertEqual(os.environ["SUPABASE_KEY"], "private-test-key-not-for-output")
                self.assertEqual(os.environ["DATABASE_URL"].split("@")[0], "postgresql+asyncpg://testing:testing")
                return {"failed_cases": 0, "recognition": {"micro_cer": 0.0, "micro_wer": 0.0}}

            stdout = io.StringIO()
            with mock.patch.dict(os.environ, {"DATABASE_URL": "", "SUPABASE_URL": "", "SUPABASE_KEY": ""}):
                with mock.patch.object(module, "evaluate", side_effect=fake_evaluate):
                    with contextlib.redirect_stdout(stdout):
                        exit_code = module.main([
                            str(manifest), "--min-pages", "1", "--env-file", str(env_file),
                        ])
            self.assertEqual(exit_code, 0)
            self.assertNotIn("private-test-key-not-for-output", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
