"""Mocked A/B runner tests: private counts, provenance, and write safety."""
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

from scripts import ocr_vietnamese_artifact_ab_runner as runner
from scripts.ocr_real_photo_benchmark import Case


def fake_output(*, checkpoint: str = "a" * 64, text: str = "Bé") -> dict:
    return {
        "text": text,
        "words": [{"text": token, "bbox": [0.1, 0.1, 0.2, 0.1]} for token in text.split()],
        "metadata": {
            "engine_statuses": {
                "paddleocr": "success", "vietocr": "success", "tesseract": "success",
            },
            "vietocr_runtime_provenance": {
                "model_profile": "FLOW1_EXTERNAL_TRDG",
                "checkpoint_sha256": checkpoint,
                "model_load_status": "loaded",
                "model_inference_status": "success",
                "fallback_reason": None,
            },
        },
    }


class ArtifactABRunnerTests(unittest.TestCase):
    def test_verified_runtime_and_private_aggregate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "private-photo.png"
            image.write_bytes(b"synthetic test")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _data: fake_output(text="Bé")
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                report = runner.evaluate(
                    [Case(image, "Bé", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
                )
            self.assertTrue(report["runtime_all_cases_verified"])
            self.assertEqual(report["successful_cases"], 1)
            self.assertEqual(report["quality"]["baseline_strict"]["word_edits"], 0)
            self.assertEqual(report["quality_by_condition"]["clean"]["successful_cases"], 1)
            self.assertFalse(report["model_or_inference_changed"])
            self.assertFalse(report["actual_photo_provenance_independently_verified"])
            self.assertNotIn(str(root), json.dumps(report))
            self.assertNotIn("Bé", json.dumps(report, ensure_ascii=False))

    def test_failure_stage_identifies_engine_contract_not_analysis(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "p.png"
            image.write_bytes(b"fixture")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: fake_output(checkpoint="b" * 64)
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                report = runner.evaluate(
                    [Case(image, "Bé", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
                )
            self.assertEqual(report["failure_stage_counts"], {
                "verify_engine_and_checkpoint": 1,
            })
            self.assertEqual(report["contract_failure_codes"], {
                "checkpoint_mismatch": 1,
            })
            self.assertNotIn("b" * 64, json.dumps(report))
            self.assertNotIn(str(root), json.dumps(report))

    def test_failure_stage_identifies_new_ab_analysis_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "p.png"
            image.write_bytes(b"fixture")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: fake_output()
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                with mock.patch.object(
                    runner, "evaluate_case",
                    side_effect=ValueError("private text from new analysis"),
                ):
                    report = runner.evaluate(
                        [Case(image, "Bé", "clean")],
                        expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
                    )
            self.assertEqual(report["failure_stage_counts"], {"ab_analysis": 1})
            self.assertEqual(report["failure_exception_types"], {"ValueError": 1})
            self.assertEqual(report["contract_failure_codes"], {})
            self.assertNotIn("private text", json.dumps(report))

    def test_failure_stage_identifies_image_or_engine_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "p.png"
            image.write_bytes(b"fixture")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: (_ for _ in ()).throw(
                ValueError("private image path " + str(image))
            )
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                report = runner.evaluate(
                    [Case(image, "Bé", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
                )
            self.assertEqual(report["failure_stage_counts"], {"ocr_inference": 1})
            self.assertEqual(report["contract_failure_codes"], {})
            self.assertNotIn(str(image), json.dumps(report))

    def test_unexpected_checkpoint_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "p.png"
            image.write_bytes(b"mock")
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: fake_output(checkpoint="b" * 64)
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                report = runner.evaluate(
                    [Case(image, "Bé", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
                )
            self.assertFalse(report["runtime_all_cases_verified"])
            self.assertEqual(report["failed_cases"], 1)
            self.assertIsNone(report["quality"])

    def test_ocr_failure_message_is_not_exposed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "p.png"
            image.write_bytes(b"mock")
            engine = types.ModuleType("app.services.ocr_engine")
            def failing(_):
                raise RuntimeError("PRIVATE IMAGE AND TEXT " + str(image))
            engine.extract_text_and_boxes = failing
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                report = runner.evaluate(
                    [Case(image, "SECRET", "clean")],
                    expected_profile="FLOW1_EXTERNAL_TRDG", expected_sha="a" * 64,
                )
            serialized = json.dumps(report)
            self.assertNotIn("PRIVATE", serialized)
            self.assertNotIn(str(image), serialized)
            self.assertEqual(report["failure_exception_types"], {"RuntimeError": 1})

    def test_cli_does_not_overwrite_existing_private_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            picture = root / "p.png"
            picture.write_bytes(b"mock")
            manifest = root / "pages.jsonl"
            manifest.write_text(
                json.dumps({"image": "p.png", "ground_truth": "Bé", "condition": "clean"}),
                encoding="utf-8",
            )
            env = root / ".env"
            env.write_text("", encoding="utf-8")
            destination = root / "summary.json"
            args = [
                str(manifest), "--env-file", str(env), "--min-pages", "1",
                "--expected-profile", "FLOW1_EXTERNAL_TRDG",
                "--expected-sha", "a" * 64, "--output", str(destination),
            ]
            result = {"runtime_all_cases_verified": True, "quality": {}}
            with mock.patch.object(runner, "evaluate", return_value=result):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(runner.main(args), 0)
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8")), result)
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as exc:
                    runner.main(args)
            self.assertEqual(exc.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
