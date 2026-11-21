"""Privacy and correct-review tests for TASK 13 Tesseract change gallery."""
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

from PIL import Image

from scripts.ocr_real_photo_benchmark import Case
from scripts import ocr_tesseract_flip_review as review


def fake_output():
    return {
        "text": "mìm",
        "words": [{
            "text": "mìm",
            "bbox": [0.20, 0.20, 0.2, 0.12],
            "ocr_evidence": {
                "engine_statuses": {
                    "paddleocr": "success",
                    "vietocr": "success",
                    "tesseract": "success",
                },
                "engine_outputs": {
                    "paddleocr": "mìm",
                    "vietocr": "mìm",
                    "tesseract": "mỉm",
                },
                "crop_evidence": {
                    "status": "completed",
                    "vietocr_candidate": "mỉm",
                    "vietocr_error": None,
                },
            },
        }],
        "metadata": {
            "engine_statuses": {
                "paddleocr": "success",
                "vietocr": "success",
                "tesseract": "success",
            },
            "vietocr_runtime_provenance": {
                "model_profile": "FLOW1_EXTERNAL_TRDG",
                "checkpoint_sha256": "a" * 64,
                "model_load_status": "loaded",
                "model_inference_status": "success",
                "fallback_reason": None,
            },
        },
    }


class PrivateFlipReviewTests(unittest.TestCase):
    def test_local_gallery_contains_only_distinct_proposed_word_crops(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            Image.new("RGB", (400, 200), (250, 250, 250)).save(image)
            destination = root / "private-review"
            destination.mkdir()
            engine = types.ModuleType("app.services.ocr_engine")
            output = fake_output()
            engine.extract_text_and_boxes = lambda _: output
            before = json.dumps(output, ensure_ascii=False, sort_keys=True)
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                result = review.make_report(
                    [Case(image, "mỉm", "clean")], destination,
                    "FLOW1_EXTERNAL_TRDG", "a" * 64,
                )
            self.assertTrue(result["complete"])
            self.assertEqual(result["distinct_positions"], 1)
            self.assertTrue(result["crop_artifacts_consistent"])
            self.assertEqual(result["crop_artifact_count"], 1)
            self.assertFalse(result["risk_assessment"]["production_deployment_allowed"])
            self.assertEqual(
                result["risk_assessment"]["per_policy"]["tesseract_line_priority"][
                    "review_required"
                ], 0,
            )
            for rule in review.REVIEW_RULES:
                self.assertEqual(
                    result["policy_flip_review_counts"][rule]["corrected"], 1
                )
                self.assertEqual(
                    result["policy_flip_review_counts"][rule]["regressed"], 0
                )
            self.assertEqual(len(list((destination / "crops").glob("*.png"))), 1)
            html_text = (destination / "index.html").read_text(encoding="utf-8")
            self.assertIn("mìm", html_text)
            self.assertIn("mỉm", html_text)
            self.assertIn('Content-Security-Policy', html_text)
            aggregate = (destination / "aggregate.json").read_text(encoding="utf-8")
            for secret in ("mìm", "mỉm", str(image), "p.png", "F:\\c1"):
                self.assertNotIn(secret, aggregate)
            self.assertEqual(json.dumps(output, ensure_ascii=False, sort_keys=True), before)

    def test_ref_misalignment_remains_ambiguous_and_does_not_invent_gt_word(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            Image.new("RGB", (400, 200)).save(image)
            crops = root / "crops"
            crops.mkdir()
            section, row = review._render_page(
                Case(image, "Bé mỉm", "low_light"), 1,
                fake_output(), crops,
            )
            self.assertEqual(row["tesseract_line_priority_ambiguous"], 1)
            self.assertEqual(
                row["tesseract_line_vietocr_crop_agreement_ambiguous"], 1
            )
            self.assertIn("Không tự suy luận", section)

    def test_trailing_extra_ocr_tokens_do_not_hide_unique_tone_correction(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            Image.new("RGB", (400, 200)).save(image)
            crops = root / "crops"
            crops.mkdir()
            output = fake_output()
            corrected_word = output["words"][0]
            output["text"] = "Bé mìm hôm nay I I V"
            output["words"] = [
                {"text": "Bé", "bbox": [0.02, 0.20, 0.10, 0.12]},
                corrected_word,
                {"text": "hôm", "bbox": [0.43, 0.20, 0.10, 0.12]},
                {"text": "nay", "bbox": [0.56, 0.20, 0.10, 0.12]},
                {"text": "I", "bbox": [0.70, 0.20, 0.05, 0.12]},
                {"text": "I", "bbox": [0.77, 0.20, 0.05, 0.12]},
                {"text": "V", "bbox": [0.84, 0.20, 0.05, 0.12]},
            ]
            section, stats = review._render_page(
                Case(image, "Bé mỉm hôm nay", "low_light"),
                1, output, crops,
            )
            self.assertEqual(stats["tesseract_line_priority_corrected"], 1)
            self.assertEqual(stats.get("tesseract_line_priority_ambiguous", 0), 0)
            self.assertEqual(
                stats["tesseract_line_vietocr_crop_agreement_corrected"], 1
            )
            self.assertIn("Đối chứng theo vị trí: mỉm", section)
            self.assertEqual(len(list(crops.glob("*.png"))), 1)

    def test_preserves_xss_safety_in_private_html(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            Image.new("RGB", (400, 200)).save(image)
            crops = root / "crops"
            crops.mkdir()
            section, _ = review._render_page(
                Case(image, '<script>alert(1)</script>', "clean"),
                1, fake_output(), crops,
            )
            self.assertNotIn("<script>", section)
            self.assertIn("&lt;script&gt;", section)

    def test_failure_exceptions_are_sanitized(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            image.write_bytes(b"fake")
            destination = root / "private-review"
            destination.mkdir()
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: (_ for _ in ()).throw(
                ValueError("private word from " + str(image))
            )
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                report = review.make_report(
                    [Case(image, "mỉm", "clean")], destination,
                    "FLOW1_EXTERNAL_TRDG", "a" * 64,
                )
            self.assertFalse(report["complete"])
            self.assertEqual(report["failure_exception_types"], {"ValueError": 1})
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertNotIn(str(image), serialized)
            self.assertNotIn("private word", serialized)

    def test_cli_refuses_existing_private_output_to_prevent_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "already-there"
            output.mkdir()
            env = root / "private.env"
            env.write_text("", encoding="utf-8")
            manifest = root / "pages.jsonl"
            manifest.write_text("[]", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as cm:
                    review.main([
                        str(manifest), "--env-file", str(env),
                        "--expected-profile", "FLOW1_EXTERNAL_TRDG",
                        "--expected-sha", "a" * 64,
                        "--output-dir", str(output),
                    ])
            self.assertEqual(cm.exception.code, 2)

    def test_dangerous_correct_to_wrong_flips_sort_ahead_of_corrections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            Image.new("RGB", (400, 200), (240, 240, 240)).save(image)
            crops = root / "crops"
            crops.mkdir()
            output = fake_output()
            first = output["words"][0]
            second = {
                "text": "nằm",
                "bbox": [0.55, 0.20, 0.2, 0.12],
                "ocr_evidence": {
                    "engine_statuses": {
                        "paddleocr": "success", "vietocr": "success",
                        "tesseract": "success",
                    },
                    "engine_outputs": {
                        "paddleocr": "nằm", "vietocr": "nằm", "tesseract": "năm",
                    },
                    "crop_evidence": {
                        "status": "completed", "vietocr_candidate": "năm",
                        "vietocr_error": None,
                    },
                },
            }
            output["words"] = [first, second]
            output["text"] = "mìm nằm"
            body, stats = review._render_page(
                Case(image, "mỉm nằm", "childrens_font"),
                1, output, crops,
            )
            self.assertEqual(stats["distinct_positions"], 2)
            self.assertEqual(stats["positions_to_check_first"], 1)
            self.assertEqual(stats["tesseract_line_priority_corrected"], 1)
            self.assertEqual(stats["tesseract_line_priority_regressed"], 1)
            self.assertLess(body.index("Từ #2"), body.index("Từ #1"))

    def test_report_detects_missing_cropped_image_before_claiming_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            Image.new("RGB", (400, 200)).save(image)
            destination = root / "private-review"
            destination.mkdir()
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: fake_output()
            with mock.patch.dict(sys.modules, {
                "torch": types.ModuleType("torch"),
                "app.services.ocr_engine": engine,
            }):
                with mock.patch.object(review, "_bbox_crop"):
                    result = review.make_report(
                        [Case(image, "mỉm", "clean")], destination,
                        "FLOW1_EXTERNAL_TRDG", "a" * 64,
                    )
            self.assertEqual(result["successful_pages"], 1)
            self.assertFalse(result["crop_artifacts_consistent"])
            self.assertFalse(result["complete"])
            self.assertFalse(result["risk_assessment"]["production_deployment_allowed"])

    def test_invalid_word_box_cannot_create_misaligned_crop(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "p.png"
            Image.new("RGB", (400, 200)).save(image)
            for invalid in ([-1, 0, .2, .2], [0, 0, 2, .2], [0, 0, 0, .2]):
                with self.assertRaises(ValueError):
                    review._bbox_crop(image, invalid, root / "crop.png")


if __name__ == "__main__":
    unittest.main()
