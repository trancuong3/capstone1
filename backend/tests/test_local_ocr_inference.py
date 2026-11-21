"""Real local Vietnamese OCR inference gate (runs ONLY local engines, cloud OCR disabled).

Run dedicated gate:
    $env:VIREAD_LOCAL_OCR_INFERENCE = "1"
    F:\\c1\\capstone1\\.venv\\Scripts\\python.exe -m pytest tests/test_local_ocr_inference.py -v -s

Always runs manifest integrity tests even without VIREAD_LOCAL_OCR_INFERENCE=1.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import unicodedata
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
MANIFEST_PATH = REPO_ROOT / "tests" / "fixtures" / "ocr" / "manifest.json"
REPORT_OUT = REPO_ROOT / "docs" / "android" / "LOCAL_OCR_INFERENCE_REPORT.json"

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

RUN_REAL_INFERENCE = os.getenv("VIREAD_LOCAL_OCR_INFERENCE", "").strip().lower() in {
    "1", "true", "yes", "on",
}


def normalize_vi_nfc(text: str) -> str:
    """Unicode NFC + collapse whitespace; preserves all Vietnamese diacritics and case."""
    return unicodedata.normalize("NFC", " ".join(text.split()))


def levenshtein_chars(ref: str, hyp: str) -> int:
    if len(hyp) > len(ref):
        ref, hyp = hyp, ref
    prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        curr = [i]
        for j, hc in enumerate(hyp, 1):
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + (rc != hc)))
        prev = curr
    return prev[-1]


def redacted_diff_summary(ref: str, hyp: str) -> dict[str, int]:
    """Return numeric diff summary without exposing raw personal text in reports."""
    ref_tokens = normalize_vi_nfc(ref).split()
    hyp_tokens = normalize_vi_nfc(hyp).split()
    dist = levenshtein_chars(normalize_vi_nfc(ref), normalize_vi_nfc(hyp))
    return {
        "ref_chars": len(normalize_vi_nfc(ref)),
        "hyp_chars": len(normalize_vi_nfc(hyp)),
        "ref_words": len(ref_tokens),
        "hyp_words": len(hyp_tokens),
        "char_edit_distance": dist,
    }


class OcrManifestIntegrityTests(unittest.TestCase):
    """Fast, always-on validation of fixture manifest, checksums, and locked thresholds."""

    def test_manifest_schema_checksums_and_locked_thresholds(self):
        self.assertTrue(MANIFEST_PATH.is_file(), f"Missing manifest at {MANIFEST_PATH}")
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        thresholds = manifest["thresholds"]
        self.assertTrue(thresholds["locked"], "Thresholds must be locked before holdout evaluation")
        self.assertGreater(thresholds["clean_max_cer"], 0)
        self.assertGreater(thresholds["photo_perturbed_max_cer"], 0)
        self.assertGreater(thresholds["overall_readable_max_cer"], 0)
        self.assertTrue(thresholds["blank_must_reject"])

        cases = manifest["cases"]
        splits = {c["split"] for c in cases}
        self.assertEqual(splits, {"dev", "holdout"})
        required_groups = {"clean", "tilted", "low_light", "diacritics", "edge_crop", "blurry", "blank"}
        for split in ("dev", "holdout"):
            split_groups = {c["group"] for c in cases if c["split"] == split}
            self.assertEqual(split_groups, required_groups, f"Split {split} missing required groups")

        for case in cases:
            img_path = MANIFEST_PATH.parent / case["image"]
            self.assertTrue(img_path.is_file(), f"Missing fixture image: {img_path}")
            actual_sha = hashlib.sha256(img_path.read_bytes()).hexdigest()
            self.assertEqual(actual_sha, case["image_sha256"], f"Checksum mismatch for {case['id']}")
            if case["expected_outcome"] == "readable":
                self.assertTrue(normalize_vi_nfc(case["ground_truth"]), f"Empty ground truth: {case['id']}")
            else:
                self.assertEqual(case["ground_truth"], "")


@unittest.skipUnless(
    RUN_REAL_INFERENCE,
    "Set VIREAD_LOCAL_OCR_INFERENCE=1 to execute the real local OCR inference gate.",
)
class RealLocalOcrInferenceGateTests(unittest.TestCase):
    """Executes the REAL local OCR pipeline (cloud OCR disabled) on dev + locked holdout splits."""

    def test_local_ocr_inference_dev_and_holdout_meet_locked_thresholds(self):
        # Strictly disable cloud OCR env vars inside this test process
        os.environ["OCR_CLOUD_CORRECTION_ENABLED"] = "false"
        os.environ["GEMINI_API_KEY"] = ""
        os.environ["GROQ_API_KEY"] = ""
        # Load local Supabase env only if not already set (for active VietOCR model check)
        os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:5432/test")
        os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
        os.environ.setdefault("SUPABASE_KEY", "test-key")

        # Import torch FIRST per Windows shm.dll ABI rule
        import torch
        from app.services import ocr_engine

        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        thresholds = manifest["thresholds"]
        all_cases = manifest["cases"]

        cuda_available = bool(torch.cuda.is_available())
        device_label = f"cuda ({torch.cuda.get_device_name(0)})" if cuda_available else "cpu"
        if cuda_available:
            torch.cuda.reset_peak_memory_stats()

        per_case_reports: list[dict[str, object]] = []
        split_stats: dict[str, dict[str, object]] = {}

        global_idx = 0
        for split in ("dev", "holdout"):
            split_cases = [c for c in all_cases if c["split"] == split]
            ref_chars_sum = 0
            edit_dist_sum = 0
            readable_ok = 0
            readable_total = 0
            blank_ok = 0
            blank_total = 0
            group_cer: dict[str, list[float]] = {}
            warm_latencies: list[float] = []
            cold_latency: float | None = None

            for case in split_cases:
                img_bytes = (MANIFEST_PATH.parent / case["image"]).read_bytes()
                t0 = time.perf_counter()
                is_cold = global_idx == 0
                global_idx += 1

                entry: dict[str, object] = {
                    "id": case["id"],
                    "split": split,
                    "group": case["group"],
                    "expected_outcome": case["expected_outcome"],
                    "is_cold": is_cold,
                }
                if case["expected_outcome"] == "readable":
                    readable_total += 1
                    output = ocr_engine.extract_text_and_boxes(img_bytes)
                    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
                    meta = output.get("metadata", {})
                    pred = normalize_vi_nfc(str(output.get("text", "")))
                    ref = normalize_vi_nfc(case["ground_truth"])
                    diff = redacted_diff_summary(ref, pred)
                    cer = round(diff["char_edit_distance"] / max(1, diff["ref_chars"]), 5)

                    ref_chars_sum += diff["ref_chars"]
                    edit_dist_sum += diff["char_edit_distance"]
                    group_cer.setdefault(case["group"], []).append(cer)
                    if is_cold:
                        cold_latency = elapsed_ms
                    else:
                        warm_latencies.append(elapsed_ms)

                    entry.update(
                        {
                            "status": "text_detected",
                            "elapsed_ms": elapsed_ms,
                            "engine": meta.get("engine"),
                            "engine_statuses": meta.get("engine_statuses"),
                            "model_profile": meta.get("model_profile"),
                            "checkpoint_sha256": meta.get("checkpoint_sha256"),
                            "cer": cer,
                            "diff_summary": diff,
                        }
                    )
                    self.assertTrue(pred, f"{case['id']} returned empty OCR text")
                    limit = (
                        thresholds["clean_max_cer"]
                        if case["group"] == "clean"
                        else thresholds["photo_perturbed_max_cer"]
                    )
                    self.assertLessEqual(
                        cer,
                        limit,
                        f"{case['id']} ({case['group']}) CER={cer} exceeded locked limit {limit}",
                    )
                    if is_cold:
                        self.assertLessEqual(elapsed_ms, thresholds["cold_latency_max_ms"])
                    else:
                        self.assertLessEqual(elapsed_ms, thresholds["warm_latency_max_ms"])
                    readable_ok += 1
                else:
                    blank_total += 1
                    with self.assertRaises(
                        ocr_engine.OcrNoTextDetected,
                        msg=f"Blank fixture {case['id']} MUST NOT report readable text!",
                    ):
                        ocr_engine.extract_text_and_boxes(img_bytes)
                    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
                    entry.update({"status": "no_text", "elapsed_ms": elapsed_ms})
                    blank_ok += 1
                per_case_reports.append(entry)

            micro_cer = round(edit_dist_sum / max(1, ref_chars_sum), 5)
            self.assertLessEqual(
                micro_cer,
                thresholds["overall_readable_max_cer"],
                f"Split {split} overall micro CER={micro_cer} exceeded {thresholds['overall_readable_max_cer']}",
            )
            split_stats[split] = {
                "readable_success": f"{readable_ok}/{readable_total}",
                "blank_rejected": f"{blank_ok}/{blank_total}",
                "micro_cer": micro_cer,
                "group_cer": {k: round(sum(v) / len(v), 5) for k, v in group_cer.items()},
                "cold_ms": cold_latency,
                "warm_mean_ms": round(sum(warm_latencies) / len(warm_latencies), 1) if warm_latencies else None,
                "warm_max_ms": max(warm_latencies) if warm_latencies else None,
            }

        # Concurrency isolation test: run 2 distinct holdout images back-to-back in 2 threads
        # and verify each receives its OWN Vietnamese text with zero cross-contamination.
        c1 = next(c for c in all_cases if c["id"] == "holdout_clean_01")
        c2 = next(c for c in all_cases if c["id"] == "holdout_diacritics_01")
        b1 = (MANIFEST_PATH.parent / c1["image"]).read_bytes()
        b2 = (MANIFEST_PATH.parent / c2["image"]).read_bytes()

        with ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(ocr_engine.extract_text_and_boxes, b1)
            f2 = pool.submit(ocr_engine.extract_text_and_boxes, b2)
            out1, out2 = f1.result(), f2.result()

        t1 = normalize_vi_nfc(str(out1.get("text", "")))
        t2 = normalize_vi_nfc(str(out2.get("text", "")))
        cer1 = levenshtein_chars(normalize_vi_nfc(c1["ground_truth"]), t1) / len(normalize_vi_nfc(c1["ground_truth"]))
        cer2 = levenshtein_chars(normalize_vi_nfc(c2["ground_truth"]), t2) / len(normalize_vi_nfc(c2["ground_truth"]))
        self.assertLessEqual(cer1, 0.05, "Concurrent job 1 cross-contaminated or degraded")
        self.assertLessEqual(cer2, 0.08, "Concurrent job 2 cross-contaminated or degraded")
        self.assertNotEqual(t1, t2)

        report = {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "cloud_ocr_enabled": False,
            "device": device_label,
            "peak_vram_mib": round(torch.cuda.max_memory_allocated() / (1024 * 1024), 2) if cuda_available else 0.0,
            "normalization": manifest["normalization"],
            "thresholds": thresholds,
            "splits": split_stats,
            "concurrent_isolation_check": {
                "passed": True,
                "job1_id": c1["id"],
                "job1_cer": round(cer1, 5),
                "job2_id": c2["id"],
                "job2_cer": round(cer2, 5),
            },
            "cases": per_case_reports,
        }
        REPORT_OUT.parent.mkdir(parents=True, exist_ok=True)
        REPORT_OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps(report["splits"], indent=2, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
