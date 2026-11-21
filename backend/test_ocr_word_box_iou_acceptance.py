"""Tests for private real-photo IoU runner without loading OCR runtimes."""
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
from scripts import ocr_word_box_iou_acceptance as runner


def sample_output(word: str, bbox: list[float], *, sha: str = "a" * 64):
    return {
        "text": word,
        "words": [{"text": word, "bbox": bbox}],
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


class WordBoxIoURunnerTests(unittest.TestCase):
    def test_mocked_ocr_geometry_and_word_metrics_are_private(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "a.png").write_bytes(b"synthetic")
            (root / "b.png").write_bytes(b"synthetic")
            cases = [
                Case(root / "a.png", "Bé", "clean"),
                Case(root / "b.png", "đọc", "shadow"),
            ]
            labels = {
                "a.png": [{"text": "Bé", "bbox": [0, 0, 0.2, 0.2]}],
                "b.png": [{"text": "đọc", "bbox": [0, 0, 0.2, 0.2]}],
            }
            predictions = iter([
                sample_output("Bé", [0, 0, 0.2, 0.2]),
                sample_output("doc", [0, 0, 0.2, 0.2]),
            ])
            fake_engine = types.ModuleType("app.services.ocr_engine")
            fake_engine.extract_text_and_boxes = lambda _: next(predictions)
            fake_torch = types.ModuleType("torch")
            with mock.patch.dict(sys.modules, {
                "torch": fake_torch, "app.services.ocr_engine": fake_engine,
            }):
                report = runner.evaluate_iou(
                    cases, labels, root, expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                )
            self.assertEqual(report["successful_cases"], 2)
            threshold = report["word_box_iou"]["0.50"]
            self.assertEqual(threshold["geometry"]["tp"], 2)
            self.assertEqual(threshold["strict_word_and_geometry"]["tp"], 1)
            self.assertEqual(threshold["strict_word_and_geometry"]["recall"], 0.5)
            self.assertFalse(report["annotation_source_independently_audited"])
            self.assertTrue(report["color_scoring_not_measured"])
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertNotIn("đọc", serialized)
            self.assertNotIn("doc", serialized)
            self.assertNotIn(str(root), serialized)

    def test_provenance_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            image = root / "page.png"
            image.write_bytes(b"fixture")
            fake_engine = types.ModuleType("app.services.ocr_engine")
            fake_engine.extract_text_and_boxes = lambda _: sample_output(
                "Bé", [0, 0, 0.2, 0.2], sha="b" * 64
            )
            fake_torch = types.ModuleType("torch")
            with mock.patch.dict(sys.modules, {
                "torch": fake_torch, "app.services.ocr_engine": fake_engine,
            }):
                report = runner.evaluate_iou(
                    [Case(image, "Bé", "clean")],
                    {"page.png": [{"text": "Bé", "bbox": [0, 0, 0.2, 0.2]}]},
                    root, expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                )
            self.assertEqual(report["failed_cases"], 1)
            self.assertFalse(report["all_runtime_checks_passed"])
            self.assertIsNone(report["word_box_iou"])

    def test_cli_outputs_only_new_aggregate_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "a.png").write_bytes(b"fixture")
            manifest = root / "pages.jsonl"
            manifest.write_text(
                json.dumps({"image": "a.png", "ground_truth": "Bé"}, ensure_ascii=False),
                encoding="utf-8",
            )
            labels_path = root / "labels.jsonl"
            labels_path.write_text(
                json.dumps({
                    "image": "a.png", "annotation_source": "manual_independent",
                    "reviewer_confirmed": True,
                    "coordinate_space": "normalized_original_dimensions",
                    "words": [{"text": "Bé", "bbox": [0.1, 0.1, 0.2, 0.1]}],
                }, ensure_ascii=False),
                encoding="utf-8",
            )
            output = root / "summary.json"
            mock_report = {
                "all_runtime_checks_passed": True, "successful_cases": 1,
                "bbox_iou_measured": True,
            }
            argv = [
                str(manifest), "--bbox-annotations", str(labels_path),
                "--min-pages", "1", "--expected-profile", "FLOW1_EXTERNAL_TRDG",
                "--expected-sha", "a" * 64, "--output", str(output),
            ]
            output_text = io.StringIO()
            with mock.patch.object(runner, "evaluate_iou", return_value=mock_report):
                with contextlib.redirect_stdout(output_text):
                    code = runner.main(argv)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), mock_report)
            self.assertNotIn("Bé", output_text.getvalue())
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    runner.main(argv)
            self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
