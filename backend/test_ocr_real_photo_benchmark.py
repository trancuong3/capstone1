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

    def test_quality_by_condition_is_aggregate_only(self):
        import sys
        import types
        from unittest import mock

        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            pages = [
                ("clean.png", "Bé đọc sách.", "clean"),
                ("shadow.png", "Trời hôm nay đẹp.", "shadow"),
            ]
            for name, _, _ in pages:
                (root / name).write_bytes(b"test-only-image-data")
            cases = [
                module.Case(root / name, truth, condition)
                for name, truth, condition in pages
            ]
            predictions = iter(["Bé đọc sách.", "Trời hôm nay dep."])
            fake_engine = types.ModuleType("app.services.ocr_engine")
            fake_engine.extract_text_and_boxes = lambda _data: {
                "text": next(predictions),
                "metadata": {
                    "engine_statuses": {
                        "paddleocr": "success",
                        "vietocr": "success",
                        "tesseract": "success",
                    },
                    "vietocr_runtime_provenance": {
                        "model_load_status": "loaded",
                        "model_inference_status": "success",
                        "fallback_reason": None,
                        "model_profile": "FLOW1_EXTERNAL_TRDG",
                        "checkpoint_sha256": "a" * 64,
                    },
                },
            }
            fake_torch = types.ModuleType("torch")
            fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)
            with mock.patch.dict(sys.modules, {
                "torch": fake_torch,
                "app.services.ocr_engine": fake_engine,
            }):
                report = module.evaluate(
                    cases, expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                )
            self.assertEqual(report["successful_cases"], 2)
            self.assertEqual(report["failed_cases"], 0)
            clean = report["quality_by_condition"]["clean"]
            shadow = report["quality_by_condition"]["shadow"]
            self.assertEqual(clean["micro_cer"], 0)
            self.assertEqual(clean["micro_wer"], 0)
            self.assertEqual(clean["exact_page_match_rate"], 1)
            self.assertGreater(shadow["micro_cer"], 0)
            self.assertGreater(shadow["micro_wer"], 0)
            self.assertEqual(shadow["exact_page_match_rate"], 0)
            self.assertEqual(
                sum(item["character_edits"] for item in report["quality_by_condition"].values()),
                report["recognition"]["character_edits"],
            )
            encoded = json.dumps(report, ensure_ascii=False)
            self.assertNotIn("Trời hôm nay", encoded)
            self.assertNotIn(str(root), encoded)

    def test_private_word_diagnostics_do_not_leak_into_aggregate(self):
        import sys
        import types
        from unittest import mock

        with tempfile.TemporaryDirectory() as dirname:
            image = Path(dirname) / "page.png"
            image.write_bytes(b"fixture")
            fake_engine = types.ModuleType("app.services.ocr_engine")
            fake_engine.extract_text_and_boxes = lambda _data: {
                "text": "Bé doc sách.",
                "metadata": {
                    "engine_statuses": {
                        "paddleocr": "success", "vietocr": "success", "tesseract": "success",
                    },
                    "vietocr_runtime_provenance": {
                        "model_load_status": "loaded",
                        "model_inference_status": "success",
                        "fallback_reason": None,
                        "model_profile": "FLOW1_EXTERNAL_TRDG",
                        "checkpoint_sha256": "a" * 64,
                    },
                },
            }
            fake_torch = types.ModuleType("torch")
            fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)
            sensitive_rows = []
            with mock.patch.dict(sys.modules, {
                "torch": fake_torch,
                "app.services.ocr_engine": fake_engine,
            }):
                report = module.evaluate(
                    [module.Case(image, "Bé đọc sách.", "childrens_font")],
                    expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                    private_error_records=sensitive_rows,
                )
            self.assertEqual(report["successful_cases"], 1)
            self.assertEqual(report["recognition"]["word_edits"], 1)
            self.assertEqual(
                report["recognition"]["edge_punctuation_neutral_word_edits"], 1,
            )
            self.assertEqual(
                report["recognition"]["edge_punctuation_neutral_wer"], 0.333333,
            )
            self.assertEqual(
                report["private_diagnostic_summary"]["word_error_kind_counts"],
                {"diacritic_or_d_stroke": 1},
            )
            self.assertEqual(report["private_diagnostic_summary"]["analyzed_cases"], 1)
            self.assertEqual(len(sensitive_rows), 1)
            self.assertEqual(sensitive_rows[0]["status"], "complete")
            self.assertEqual(sensitive_rows[0]["error_count"], 1)
            self.assertEqual(
                sensitive_rows[0]["errors"][0]["kind"], "diacritic_or_d_stroke"
            )
            self.assertEqual(sensitive_rows[0]["errors"][0]["expected"], "đọc")
            self.assertEqual(sensitive_rows[0]["errors"][0]["observed"], "doc")
            encoded = json.dumps(report, ensure_ascii=False)
            self.assertNotIn("đọc", encoded)
            self.assertNotIn("doc", encoded)
            self.assertNotIn(str(image), encoded)

    def test_punctuation_neutral_metric_is_separate_from_strict_wer(self):
        import sys
        import types
        from unittest import mock

        with tempfile.TemporaryDirectory() as dirname:
            image = Path(dirname) / "page.png"
            image.write_bytes(b"fixture")
            fake_engine = types.ModuleType("app.services.ocr_engine")
            fake_engine.extract_text_and_boxes = lambda _data: {
                "text": "Bé đọc sách",
                "metadata": {
                    "engine_statuses": {
                        "paddleocr": "success", "vietocr": "success", "tesseract": "success",
                    },
                    "vietocr_runtime_provenance": {
                        "model_load_status": "loaded", "model_inference_status": "success",
                        "fallback_reason": None, "model_profile": "FLOW1_EXTERNAL_TRDG",
                        "checkpoint_sha256": "a" * 64,
                    },
                },
            }
            fake_torch = types.ModuleType("torch")
            fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)
            with mock.patch.dict(sys.modules, {
                "torch": fake_torch, "app.services.ocr_engine": fake_engine,
            }):
                report = module.evaluate(
                    [module.Case(image, "Bé đọc sách.", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                )
            self.assertEqual(report["recognition"]["word_edits"], 1)
            self.assertEqual(report["recognition"]["micro_wer"], 0.333333)
            self.assertEqual(report["recognition"]["edge_punctuation_neutral_word_edits"], 0)
            self.assertEqual(report["recognition"]["edge_punctuation_neutral_wer"], 0)
            self.assertEqual(
                report["quality_by_condition"]["clean"]["edge_punctuation_neutral_wer"], 0,
            )

    def test_private_error_output_is_opt_in_and_not_printed(self):
        import contextlib
        import io
        from unittest import mock

        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "page.png").write_bytes(b"fixture")
            manifest = root / "pages.jsonl"
            manifest.write_text(
                json.dumps({"image": "page.png", "ground_truth": "đọc"}, ensure_ascii=False),
                encoding="utf-8",
            )
            private_path = root / "private-word-errors.jsonl"

            def fake_evaluate(cases, *, expected_profile, expected_sha, private_error_records):
                self.assertEqual(len(cases), 1)
                private_error_records.append({
                    "case_number": 1, "condition": "clean", "status": "complete",
                    "errors": [{"expected": "đọc", "observed": "doc"}],
                })
                return {"failed_cases": 0, "recognition": {"micro_cer": 0.0, "micro_wer": 0.0}}

            stdout = io.StringIO()
            with mock.patch.object(module, "evaluate", side_effect=fake_evaluate):
                with contextlib.redirect_stdout(stdout):
                    code = module.main([
                        str(manifest), "--min-pages", "1",
                        "--private-error-output", str(private_path),
                    ])
            self.assertEqual(code, 0)
            self.assertTrue(private_path.is_file())
            self.assertIn('"expected": "đọc"', private_path.read_text(encoding="utf-8"))
            self.assertNotIn("đọc", stdout.getvalue())
            self.assertNotIn("doc", stdout.getvalue())

            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    module.main([
                        str(manifest), "--min-pages", "1",
                        "--private-error-output", str(manifest),
                    ])
            self.assertEqual(caught.exception.code, 2)
            self.assertIn("ground_truth", manifest.read_text(encoding="utf-8"))
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    module.main([
                        str(manifest), "--min-pages", "1",
                        "--private-error-output", str(private_path),
                    ])
            self.assertEqual(caught.exception.code, 2)

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
