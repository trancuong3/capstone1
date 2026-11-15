from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

GateStatus = Literal["V2_WIN", "ORIGINAL_WIN", "NO_SIGNIFICANT_DIFFERENCE", "INSUFFICIENT_EVIDENCE", "EVALUATION_FAILED"]


@dataclass(frozen=True)
class GatePolicy:
    min_pairs: int = 200
    min_groups: int = 30
    max_absolute_regression: float = 0.005
    require_both_cer_and_wer_win: bool = True


def evaluate_gate(metrics: dict[str, Any], *, paired_manifest_hash: str, expected_locked_manifest_hash: str,
                  policy: GatePolicy = GatePolicy()) -> dict[str, Any]:
    if paired_manifest_hash != expected_locked_manifest_hash:
        return {"status": "EVALUATION_FAILED", "reason": "locked_test_manifest_hash_mismatch", "promotion_allowed": False}
    if not isinstance(metrics, dict) or not isinstance(metrics.get("sample_count"), int) or not isinstance(metrics.get("group_count"), int):
        return {"status": "EVALUATION_FAILED", "reason": "malformed_metrics", "promotion_allowed": False}
    try:
        count, groups = int(metrics["sample_count"]), int(metrics["group_count"])
        cer, wer = metrics["cer"], metrics["wer"]
        comparisons = {"original": [cer, wer]}
        for baseline in ("parent", "active"):
            cer_key, wer_key = f"{baseline}_cer", f"{baseline}_wer"
            if cer_key in metrics or wer_key in metrics:
                if cer_key not in metrics or wer_key not in metrics:
                    raise ValueError("incomplete baseline comparison")
                comparisons[baseline] = [metrics[cer_key], metrics[wer_key]]
        intervals: dict[str, list[list[float]]] = {}
        for baseline, results in comparisons.items():
            intervals[baseline] = []
            for result in results:
                if not 0 <= float(result[f"{baseline}_rate"]) <= 1 or not 0 <= float(result["candidate_rate"]) <= 1:
                    raise ValueError("rate outside [0, 1]")
                interval_key = f"paired_cluster_bootstrap_95ci_candidate_minus_{baseline}"
                interval = result.get(interval_key, result.get("paired_cluster_bootstrap_95ci"))
                if (not isinstance(interval, list) or len(interval) != 2
                        or any(not math.isfinite(float(value)) or not -1 <= float(value) <= 1 for value in interval)
                        or not math.isfinite(float(result[f"delta_candidate_minus_{baseline}"]))):
                    raise ValueError("missing confidence interval")
                intervals[baseline].append([float(interval[0]), float(interval[1])])
        if count < policy.min_pairs or groups < policy.min_groups:
            return {"status": "INSUFFICIENT_EVIDENCE", "reason": "minimum_locked_test_size_not_met", "promotion_allowed": False,
                    "sample_count": count, "group_count": groups}
        deltas = {
            baseline: [float(item[f"delta_candidate_minus_{baseline}"]) for item in results]
            for baseline, results in comparisons.items()
        }
        upper = {
            baseline: [interval[1] for interval in values]
            for baseline, values in intervals.items()
        }
        lower = {
            baseline: [interval[0] for interval in values]
            for baseline, values in intervals.items()
        }
    except (KeyError, TypeError, ValueError, OverflowError):
        return {"status": "EVALUATION_FAILED", "reason": "malformed_metrics", "promotion_allowed": False}
    if any(not math.isfinite(delta) for baseline_deltas in deltas.values() for delta in baseline_deltas):
        return {"status": "EVALUATION_FAILED", "reason": "non_finite_metric", "promotion_allowed": False}
    if any(delta > policy.max_absolute_regression for baseline_deltas in deltas.values() for delta in baseline_deltas):
        return {"status": "ORIGINAL_WIN", "reason": "non_regression_limit_exceeded", "promotion_allowed": False}
    v2_win = all(bound < 0 for baseline_bounds in upper.values() for bound in baseline_bounds) if policy.require_both_cer_and_wer_win else all(any(bound < 0 for bound in baseline_bounds) for baseline_bounds in upper.values())
    original_win = any(bound > 0 for baseline_bounds in lower.values() for bound in baseline_bounds)
    if v2_win:
        status: GateStatus = "V2_WIN"
        reason = "paired_cluster_confidence_intervals_favor_v2"
    elif original_win:
        status = "ORIGINAL_WIN"
        reason = "paired_cluster_confidence_interval_favors_original"
    else:
        status = "NO_SIGNIFICANT_DIFFERENCE"
        reason = "paired_cluster_confidence_intervals_include_zero"
    return {"status": status, "reason": reason, "promotion_allowed": status == "V2_WIN",
            "sample_count": count, "group_count": groups,
            "requires_human_approval": status == "V2_WIN"}
