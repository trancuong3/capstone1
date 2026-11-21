"""Mocked private bbox probe integration tests (no real OCR/GPU needed)."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from scripts.ocr_real_photo_benchmark import Case
from scripts import ocr_box_tightness_probe as runner


def ocr_output(text: str, bbox: list[float], sha: str = "a" * 64):
    return {
        "words": [{"text": text, "bbox": bbox}],
        "metadata": {
            "engine_statuses": {
                "paddleocr": "success", "vietocr": "success", "tesseract": "success",
            },
            "vietocr_runtime_provenance": {
                "model_profile": "FLOW1_EXTERNAL_TRDG",
                "checkpoint_sha256": sha,
                "model_load_status": "loaded",
                "model_inference_status": "success",
                "fallback_reason": None,
            },
        },
    }


class BboxProbeTests(unittest.TestCase):
    def test_synthetic_labels_have_strict_source_declaration(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            path = root / "labels.jsonl"
            good = {
                "image": "images/a.png",
                "annotation_source": "synthetic_renderer",
                "reviewer_confirmed": False,
                "coordinate_space": "normalized_original_dimensions",
                "words": [{"text": "đọc", "bbox": [0.1, 0.1, 0.2, 0.2]}],
            }
            path.write_text(json.dumps(good, ensure_ascii=False) + "\n", encoding="utf-8")
            self.assertEqual(
                runner.load_renderer_labels(path, {"images/a.png"})["images/a.png"][0]["text"],
                "đọc",
            )
            with self.assertRaises(ValueError):
                runner.load_renderer_labels(path, {"images/a.png", "images/b.png"})
            path.write_text(json.dumps({**good, "reviewer_confirmed": True}), encoding="utf-8")
            with self.assertRaises(ValueError):
                runner.load_renderer_labels(path, {"images/a.png"})
            path.write_text(json.dumps({**good, "words": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                runner.load_renderer_labels(path, {"images/a.png"})

    def test_verified_engine_output_fails_closed(self):
        self.assertEqual(len(runner.verify_ocr_output(
            ocr_output("Bé", [0.1, 0.1, 0.2, 0.2]),
            expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
        )), 1)
        with self.assertRaises(ValueError):
            runner.verify_ocr_output(
                ocr_output("Bé", [0.1, 0.1, 0.2, 0.2], sha="b" * 64),
                expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
            )

    def test_mocked_pipeline_reports_no_private_words_or_paths(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            image = root / "p.png"
            image.write_bytes(b"fixture")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: ocr_output(
                "đọc", [0.1, 0.1, 0.2, 0.2],
            )
            torch = types.ModuleType("torch")
            with mock.patch.dict(sys.modules, {
                "torch": torch, "app.services.ocr_engine": engine,
            }):
                report = runner.evaluate(
                    [Case(image, "đọc", "clean")],
                    {"p.png": [{"text": "đọc", "bbox": [0.1, 0.1, 0.2, 0.2]}]},
                    root,
                    expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                )
            self.assertTrue(report["all_runtime_checks_passed"])
            self.assertEqual(report["results"]["baseline"]["0.75"]["geometry"]["tp"], 1)
            self.assertTrue(report["reading_color_acceptance_not_measured"])
            encoded = json.dumps(report, ensure_ascii=False)
            self.assertNotIn("đọc", encoded)
            self.assertNotIn(str(root), encoded)

    def test_failures_do_not_log_private_ocr_errors(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            image = root / "p.png"
            image.write_bytes(b"fixture")
            engine = types.ModuleType("app.services.ocr_engine")
            def failing(_bytes):
                raise RuntimeError("sensitive text and image path " + str(image))
            engine.extract_text_and_boxes = failing
            torch = types.ModuleType("torch")
            with mock.patch.dict(sys.modules, {
                "torch": torch, "app.services.ocr_engine": engine,
            }):
                report = runner.evaluate(
                    [Case(image, "đọc", "clean")],
                    {"p.png": [{"text": "đọc", "bbox": [0.1, 0.1, 0.2, 0.2]}]},
                    root,
                    expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
                )
            self.assertFalse(report["all_runtime_checks_passed"])
            self.assertEqual(report["failure_exception_types"]["RuntimeError"], 1)
            self.assertNotIn(str(image), json.dumps(report))
            self.assertIsNone(report["results"])

    def test_overlay_is_private_and_contains_both_box_colors(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            image = root / "original.png"
            target = root / "overlay.png"
            Image.new("RGB", (200, 100), color="white").save(image)
            runner.write_overlay(
                image,
                [{"text": "secret OCR", "bbox": [0.5, 0.1, 0.2, 0.2]}],
                [{"text": "secret reference", "bbox": [0.1, 0.1, 0.2, 0.2]}],
                target,
            )
            self.assertTrue(target.is_file())
            with Image.open(target) as overlay:
                self.assertEqual(overlay.getpixel((20, 20)), (220, 50, 50))
                self.assertEqual(overlay.getpixel((100, 20)), (0, 160, 245))
            self.assertEqual(list(root.iterdir()).__len__(), 2)

    def test_cli_requires_private_aggregate_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "a.png").write_bytes(b"fixture")
            manifest = root / "pages.jsonl"
            manifest.write_text(json.dumps({
                "image": "a.png", "ground_truth": "Bé",
            }, ensure_ascii=False), encoding="utf-8")
            labels = root / "labels.jsonl"
            labels.write_text(json.dumps({
                "image": "a.png", "annotation_source": "synthetic_renderer",
                "reviewer_confirmed": False,
                "coordinate_space": "normalized_original_dimensions",
                "words": [{"text": "Bé", "bbox": [0.1, 0.1, 0.2, 0.2]}],
            }, ensure_ascii=False), encoding="utf-8")
            output = root / "aggregate.json"
            args = [str(manifest), "--reference-labels", str(labels),
                    "--reference-kind", "synthetic_renderer", "--min-pages", "1",
                    "--expected-profile", "FLOW1_EXTERNAL_TRDG",
                    "--expected-sha", "a" * 64, "--output", str(output)]
            fake_report = {"all_runtime_checks_passed": True, "results": {}}
            with mock.patch.object(runner, "evaluate", return_value=fake_report):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(runner.main(args), 0)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["reference_kind"], "synthetic_renderer")
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as exception:
                    runner.main(args)
            self.assertEqual(exception.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
