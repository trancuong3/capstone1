"""Unit tests for reproducible OCR quality benchmarking."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import benchmark_ocr


class BenchmarkOcrTests(unittest.TestCase):
    @staticmethod
    def _result(text: str, candidate: str = "candidate") -> dict[str, object]:
        return {
            "text": text,
            "metadata": {
                "selected_candidate": candidate,
                "candidate_count": 1 if candidate == "baseline_clahe_psm3" else 4,
            },
        }

    def test_normalization_preserves_vietnamese_diacritics_and_nfc(self):
        self.assertEqual(
            benchmark_ocr.normalize_for_metric("Tie\u0302\u0301ng   Vie\u0323\u0302t"),
            "Tiếng Việt",
        )

    def test_cer_and_wer_are_zero_for_identical_text(self):
        reference = "Chú mèo nhỏ"
        self.assertEqual(benchmark_ocr.error_rate(reference, reference, words=False), 0)
        self.assertEqual(benchmark_ocr.error_rate(reference, reference, words=True), 0)

    def test_run_benchmark_reports_quality_and_elapsed_time(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            (base / "page.png").write_bytes(b"test image bytes")
            manifest_path = base / "manifest.json"
            manifest_path.write_text(
                json.dumps([{"image": "page.png", "ground_truth": "chú mèo"}], ensure_ascii=False),
                encoding="utf-8",
            )
            outputs = [
                self._result("chu meo", "baseline_clahe_psm3"),
                self._result("chú mèo", "grayscale_psm3"),
            ]
            with patch.object(benchmark_ocr, "extract_text_and_boxes", side_effect=outputs) as extract, patch.object(
                benchmark_ocr.time, "perf_counter", side_effect=[10.0, 10.0125, 20.0, 20.025]
            ):
                report = benchmark_ocr.run_benchmark(manifest_path)

        self.assertEqual(extract.call_count, 2)
        self.assertEqual(report["total_images"], 1)
        self.assertEqual(report["successful_images"], 1)
        self.assertEqual(report["failed_images"], 0)
        result = report["results"][0]
        self.assertGreater(result["baseline_cer"], result["best_cer"])
        self.assertEqual(result["best_cer"], 0)
        self.assertAlmostEqual(result["baseline_elapsed_ms"], 12.5)
        self.assertAlmostEqual(result["best_elapsed_ms"], 25.0)
        self.assertAlmostEqual(report["mean_baseline_elapsed_ms"], 12.5)
        self.assertAlmostEqual(report["mean_best_elapsed_ms"], 25.0)

    def test_empty_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest_path = Path(temp_dir) / "manifest.json"
            manifest_path.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "non-empty JSON array"):
                benchmark_ocr.run_benchmark(manifest_path)

    def test_blank_ground_truth_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            manifest_path = base / "manifest.json"
            manifest_path.write_text(
                json.dumps([{"image": "page.png", "ground_truth": "  "}]),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "verified ground_truth"):
                benchmark_ocr.run_benchmark(manifest_path)

    def test_missing_image_is_reported_instead_of_aborting_report(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            manifest_path = base / "manifest.json"
            manifest_path.write_text(
                json.dumps([{"image": "missing.png", "ground_truth": "Nội dung đã kiểm tra"}], ensure_ascii=False),
                encoding="utf-8",
            )
            with patch.object(benchmark_ocr, "extract_text_and_boxes") as extract:
                report = benchmark_ocr.run_benchmark(manifest_path)

        self.assertEqual(report["failed_images"], 1)
        self.assertEqual(report["successful_images"], 0)
        self.assertEqual(report["results"][0]["error"], "FileNotFoundError")
        extract.assert_not_called()


if __name__ == "__main__":
    unittest.main()
