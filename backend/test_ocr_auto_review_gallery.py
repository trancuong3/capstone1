"""Tests for the automated LOCAL OCR review gallery (no real photos/GPU)."""
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
from scripts.ocr_word_box_iou import load_manual_annotations
from scripts import ocr_auto_review_gallery as gallery


def fake_output(*, text: str = "Bé đọc.", words: list[dict] | None = None, sha: str = "a" * 64):
    return {
        "text": text,
        "words": words if words is not None else [
            {"text": "Bé", "bbox": [0.1, 0.2, 0.2, 0.1]},
            {"text": "đọc.", "bbox": [0.35, 0.2, 0.2, 0.1]},
        ],
        "metadata": {
            "engine_statuses": {
                "paddleocr": "success", "vietocr": "success",
                "tesseract": "success",
            },
            "vietocr_runtime_provenance": {
                "model_load_status": "loaded",
                "model_inference_status": "success",
                "fallback_reason": None,
                "model_profile": "FLOW1_EXTERNAL_TRDG",
                "checkpoint_sha256": sha,
            },
        },
    }


class OcrAutoReviewGalleryTests(unittest.TestCase):
    def test_accuracy_is_measured_against_manifest_text_not_self_prediction(self):
        case = Case(Path("/private/page.png"), "Bé đọc.", "clean")
        inspected = gallery.inspect_case(
            case, fake_output(text="Bé doc."),
            "FLOW1_EXTERNAL_TRDG", "a" * 64,
        )
        self.assertEqual(inspected["word_edits"], 1)
        self.assertGreater(inspected["char_edits"], 0)
        self.assertIn("Nội dung OCR khác bản tham chiếu", inspected["flags"])
        self.assertEqual(len(inspected["machine_words"]), 2)
        self.assertEqual(inspected["status"], "machine_proposed_unverified")
        self.assertEqual(inspected["errors"]["status"], "complete")

    def test_invalid_ocr_box_is_not_silently_accepted_as_ground_truth(self):
        case = Case(Path("/private/page.png"), "Bé đọc.", "clean")
        inspected = gallery.inspect_case(
            case,
            fake_output(words=[
                {"text": "Bé", "bbox": [0.2, 0.2, 0.2, 0.1]},
                {"text": "đọc.", "bbox": [-1, 0, 0.2, 0.1]},
                {"text": "hai token", "bbox": [0.5, 0.4, 0.2, 0.2]},
            ]),
            "FLOW1_EXTERNAL_TRDG", "a" * 64,
        )
        self.assertEqual(inspected["invalid_word_boxes"], 2)
        self.assertEqual(len(inspected["machine_words"]), 1)
        self.assertTrue(inspected["flags"])

    def test_positive_overlap_is_flagged_and_touching_edges_not_overlap(self):
        a = {"bbox": [0.1, 0.1, 0.3, 0.2]}
        b = {"bbox": [0.3, 0.1, 0.2, 0.2]}
        c = {"bbox": [0.5, 0.1, 0.2, 0.2]}
        self.assertEqual(gallery._overlap_count([a, b, c]), 1)
        self.assertEqual(gallery._overlap_count([a, c]), 0)

    def test_untrusted_ocr_text_is_escaped_in_html(self):
        case = Case(Path("/private/page.png"), "<script>alert(1)</script>", "clean")
        inspected = gallery.inspect_case(
            case,
            fake_output(text="<img src=x onerror=alert(1)>"),
            "FLOW1_EXTERNAL_TRDG", "a" * 64,
        )
        card = gallery._html_card(1, case, inspected, "previews/page_0001.png", 250, 100)
        self.assertNotIn("<script>", card)
        self.assertNotIn("<img src=x onerror", card)
        self.assertIn("&lt;script&gt;", card)
        self.assertIn("&lt;img src=x", card)
        self.assertIn("stroke=", card)

    def test_rejects_unexpected_checkpoint(self):
        case = Case(Path("/private/page.png"), "Bé", "clean")
        with self.assertRaises(ValueError):
            gallery.inspect_case(
                case, fake_output(sha="b" * 64),
                "FLOW1_EXTERNAL_TRDG", "a" * 64,
            )

    def test_actual_mocked_ocr_writes_private_gallery_but_no_independent_labels(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            picture = root / "p.png"
            Image.new("RGB", (400, 200), color="white").save(picture)
            destination = root / "auto-review-test"
            destination.mkdir()
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _data: fake_output()
            torch = types.ModuleType("torch")
            with mock.patch.dict(sys.modules, {
                "app.services.ocr_engine": engine, "torch": torch,
            }):
                report = gallery.run_review(
                    [Case(picture, "Bé đọc.", "clean")], destination,
                    "FLOW1_EXTERNAL_TRDG", "a" * 64,
                )
            self.assertTrue(report["all_runtime_checks_passed"])
            self.assertEqual(report["aggregate"]["successful_cases"], 1)
            self.assertEqual(report["aggregate"]["proposed_word_boxes"], 2)
            self.assertFalse(report["human_annotated"])
            self.assertFalse(report["real_photo_iou_acceptance"])
            self.assertTrue((destination / "index.html").is_file())
            self.assertTrue((destination / "previews" / "page_0001.png").is_file())
            records = [
                json.loads(x) for x in (destination / "machine-proposals.jsonl")
                .read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(records[0]["image"], "p.png")
            self.assertEqual(records[0]["annotation_source"], "machine_proposed")
            self.assertFalse(records[0]["reviewer_confirmed"])
            with self.assertRaises(ValueError):
                load_manual_annotations(destination / "machine-proposals.jsonl", {"p.png"})
            summary = (destination / "aggregate.json").read_text(encoding="utf-8")
            self.assertNotIn("Bé đọc.", summary)
            self.assertNotIn(str(root), summary)

    def test_failures_are_sanitized_and_no_unsafe_success_claim(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            picture = root / "p.png"
            Image.new("RGB", (400, 200), color="white").save(picture)
            dest = root / "auto-review-test"
            dest.mkdir()
            engine = types.ModuleType("app.services.ocr_engine")
            engine.extract_text_and_boxes = lambda _: (_ for _ in ()).throw(
                RuntimeError("Private OCR text and path " + str(root))
            )
            with mock.patch.dict(sys.modules, {
                "app.services.ocr_engine": engine, "torch": types.ModuleType("torch"),
            }):
                report = gallery.run_review(
                    [Case(picture, "Bé", "clean")], dest,
                    "FLOW1_EXTERNAL_TRDG", "a" * 64,
                )
            self.assertFalse(report["all_runtime_checks_passed"])
            self.assertEqual(report["aggregate"]["failed_cases"], 1)
            self.assertEqual(report["aggregate"]["failure_exception_types"], {"RuntimeError": 1})
            self.assertNotIn(str(root), json.dumps(report))
            self.assertFalse((dest / "previews" / "page_0001.png").exists())

    def test_cli_rejects_output_inside_repo_or_existing_directory(self):
        from scripts import ocr_auto_review_gallery as source

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = root / ".env"
            env.write_text("", encoding="utf-8")
            manifest = root / "pages.jsonl"
            manifest.write_text("invalid", encoding="utf-8")
            target = root / "existing"
            target.mkdir()
            argv = [
                str(manifest), "--env-file", str(env),
                "--expected-profile", "FLOW1_EXTERNAL_TRDG",
                "--expected-sha", "a" * 64,
                "--output-dir", str(target),
            ]
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    source.main(argv)
            self.assertEqual(raised.exception.code, 2)
            self.assertEqual(list(target.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
