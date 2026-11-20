"""Offline metric regression tests. No network, DB, model downloads or AI claims."""
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
from contextlib import redirect_stdout
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "karaoke_alignment_benchmark", ROOT / "scripts/benchmark_karaoke_alignment.py"
)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def reference():
    def unit(text, start, end):
        return {"id": str(uuid4()), "text": text, "start_ms": start, "end_ms": end}
    lines = []
    for offset in (0, 2000):
        lines.append({
            "id": str(uuid4()), "text": "Bé hát", "start_ms": offset, "end_ms": offset + 1500,
            "syllables": [unit("Bé", offset, offset + 500), unit("hát", offset + 700, offset + 1500)],
        })
    return {"format_version": 2, "lines": lines}


class KaraokeAlignmentBenchmarkTests(unittest.TestCase):
    def test_perfect_marks_do_not_approve_an_engine(self):
        data = reference()
        result = benchmark.evaluate(data, data, 4000)
        self.assertEqual(result["coverage"], 1)
        self.assertEqual(result["onset_hit_rate_all_reference"], 1)
        self.assertEqual(result["end_p95_ms_matched_only"], 0)
        self.assertEqual(result["lines_needing_correction"], 0)
        self.assertEqual(result["quality_gate_status"], "NOT_EVALUATED")

    def test_missing_marks_stay_in_denominator(self):
        data = reference()
        pred = deepcopy(data)
        pred["lines"][0]["syllables"][0].update(start_ms=None, end_ms=None)
        result = benchmark.evaluate(data, pred, 4000)
        self.assertEqual(result["reference_syllables"], 4)
        self.assertEqual(result["valid_predicted_syllables"], 3)
        self.assertEqual(result["onset_hit_rate_all_reference"], 0.75)
        self.assertEqual(result["lines_needing_correction"], 1)
        self.assertFalse(result["onset_target_met_this_case"])

    def test_no_coverage_has_null_errors_and_zero_hit_rate(self):
        data = reference()
        pred = deepcopy(data)
        for line in pred["lines"]:
            for unit in line["syllables"]:
                unit.update(start_ms=None, end_ms=None)
        result = benchmark.evaluate(data, pred, 4000)
        self.assertEqual(result["coverage"], 0)
        self.assertEqual(result["onset_hit_rate_all_reference"], 0)
        self.assertIsNone(result["onset_median_ms_matched_only"])
        self.assertIsNone(result["end_p95_ms_matched_only"])

    def test_cannot_drop_or_reorder_repeated_lyrics_or_change_text(self):
        data = reference()
        for mutate in (
            lambda p: p["lines"].pop(),
            lambda p: p["lines"].reverse(),
            lambda p: p["lines"][0]["syllables"].pop(),
            lambda p: p["lines"][0].update(text="Sai hát"),
        ):
            pred = deepcopy(data)
            mutate(pred)
            with self.assertRaises(ValueError):
                benchmark.evaluate(data, pred, 4000)

    def test_boundary_is_inclusive_and_end_errors_are_independent(self):
        data = reference()
        pred = deepcopy(data)
        pred["lines"][0]["syllables"][0].update(start_ms=250, end_ms=800)
        pred["lines"][0]["syllables"][1]["start_ms"] = 900
        result = benchmark.evaluate(data, pred, 4000)
        self.assertEqual(result["onset_hits"], 4)
        self.assertEqual(result["end_hits"], 3)
        self.assertEqual(result["end_p95_ms_matched_only"], 300)
        pred["lines"][0]["syllables"][0]["start_ms"] = 251
        self.assertEqual(benchmark.evaluate(data, pred, 4000)["onset_hits"], 3)

    def test_invalid_spans_do_not_count_as_success(self):
        data = reference()
        pred = deepcopy(data)
        pred["lines"][0]["syllables"][0]["end_ms"] = 0
        result = benchmark.evaluate(data, pred, 4000)
        self.assertEqual(result["valid_predicted_syllables"], 3)
        self.assertEqual(result["onset_hits"], 3)
        self.assertGreater(result["structural_issue_count"], 0)

    def test_invalid_reference_and_non_integer_times_rejected(self):
        data = reference()
        invalid = deepcopy(data)
        invalid["lines"][0]["start_ms"] = None
        with self.assertRaises(ValueError):
            benchmark.evaluate(invalid, data, 4000)
        for value in (True, "4000", 4000.0, 0, 300001):
            with self.subTest(value=value), self.assertRaises(ValueError):
                benchmark.evaluate(data, data, value)
        invalid = deepcopy(data)
        invalid["lines"][0]["syllables"][0]["start_ms"] = True
        with self.assertRaises(ValueError):
            benchmark.evaluate(data, invalid, 4000)

    def test_json_duplicate_keys_and_non_finite_values_rejected(self):
        for content in (b'{"lines":[],"lines":[]}', b'{"x":NaN}', b'{"x":Infinity}'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                benchmark._load_json(content)
        self.assertEqual(benchmark._p95(list(range(1, 21))), 19)

    def test_cli_manual_demo_is_explicitly_not_engine_evidence(self):
        bundle = ROOT / "docs/karaoke-demo"
        with redirect_stdout(io.StringIO()) as output:
            result = benchmark.main([
                "--audio", str(bundle / "ngoi-sao-nho.mp3"),
                "--reference", str(bundle / "ngoi-sao-nho-v2.json"),
                "--prediction", str(bundle / "ngoi-sao-nho-v2.json"),
                "--evidence-kind", "manual",
            ])
        report = json.loads(output.getvalue())
        self.assertEqual(result, 0)
        self.assertEqual(report["reference_syllables"], 126)
        self.assertEqual(report["evidence_kind"], "manual")
        self.assertFalse(report["provenance_verified"])
        self.assertEqual(report["quality_gate_status"], "NOT_EVALUATED")

    def test_cli_rejects_missing_engine_identity_without_file_access(self):
        with redirect_stdout(io.StringIO()) as output:
            result = benchmark.main([
                "--audio", "unread.mp3", "--reference", "unread.json",
                "--prediction", "unread.json", "--evidence-kind", "engine",
            ])
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output.getvalue())["status"], "INVALID_INPUT")
        self.assertNotIn("unread", output.getvalue())

    def test_cli_corrupt_mp3_returns_safe_error(self):
        with patch.object(benchmark, "_read_bounded", return_value=b"invalid"), \
                patch.object(benchmark, "inspect_audio", side_effect=HTTPException(415, "private detail")), \
                redirect_stdout(io.StringIO()) as output:
            result = benchmark.main([
                "--audio", "bad.mp3", "--reference", "unread.json",
                "--prediction", "unread.json", "--evidence-kind", "synthetic",
            ])
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output.getvalue())["status"], "INVALID_INPUT")
        self.assertNotIn("private", output.getvalue())


if __name__ == "__main__":
    unittest.main()
