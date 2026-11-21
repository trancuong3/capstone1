"""Headless local runner tests for blind OCR tone policy research."""
from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from scripts import ocr_tone_blind_policy_runner as runner
from scripts.ocr_real_photo_benchmark import Case


def fake_output(sha="a" * 64):
    return {
        "text": "mìm",
        "words": [{
            "text": "mìm", "bbox": [0.2, 0.2, 0.2, 0.1],
            "ocr_evidence": {
                "engine_outputs": {
                    "paddleocr": "mỉm", "vietocr": "mỉm", "tesseract": "mìm"
                },
                "engine_statuses": {
                    "paddleocr": "success", "vietocr": "success",
                    "tesseract": "success",
                },
            },
        }],
        "metadata": {
            "engine_statuses": {
                "paddleocr": "success", "vietocr": "success",
                "tesseract": "success",
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


class BlindToneRunnerTests(unittest.TestCase):
    def test_frozen_provenance_and_strict_ab_aggregate(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "page.png"
            image.write_bytes(b"fake image bytes; mocked engine")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: fake_output()
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                output = runner.evaluate(
                    [Case(image, "mỉm", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                )
            self.assertTrue(output["runtime_all_cases_verified"])
            self.assertEqual(output["successful_cases"], 1)
            self.assertEqual(output["quality"]["baseline_strict"]["word_edits"], 1)
            self.assertEqual(
                output["quality"]["ground_truth_blind_rules"]["line_majority_2"]["quality"]["word_edits"],
                0,
            )
            self.assertFalse(output["production_inference_modified"])
            self.assertNotIn("mỉm", json.dumps(output, ensure_ascii=False))
            self.assertNotIn(str(image), json.dumps(output))

    def test_wrong_checkpoint_fails_closed_without_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "page.png"
            image.write_bytes(b"fake")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: fake_output("b" * 64)
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                output = runner.evaluate(
                    [Case(image, "mỉm", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG",
                    expected_sha="a" * 64,
                )
            self.assertFalse(output["runtime_all_cases_verified"])
            self.assertEqual(output["failure_stage_counts"], {
                "verify_engine_and_checkpoint": 1
            })
            self.assertEqual(output["contract_failure_codes"], {"checkpoint_mismatch": 1})
            self.assertIsNone(output["quality"])
            self.assertNotIn("b" * 64, json.dumps(output))

    def test_blind_analysis_failure_is_reported_by_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "page.png"
            image.write_bytes(b"fake")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: fake_output()
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                with mock.patch.object(
                    runner, "evaluate_case",
                    side_effect=ValueError("SECRET REFERENCE WORD"),
                ):
                    output = runner.evaluate(
                        [Case(image, "mỉm", "clean")],
                        expected_profile="FLOW1_EXTERNAL_TRDG",
                        expected_sha="a" * 64,
                    )
            self.assertEqual(output["failure_stage_counts"], {
                "blind_policy_analysis": 1
            })
            self.assertEqual(output["failure_exception_types"], {"ValueError": 1})
            self.assertNotIn("SECRET", json.dumps(output))


if __name__ == "__main__":
    unittest.main()
