from __future__ import annotations

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
        for result in (cer, wer):
            if not 0 <= float(result["original_rate"]) <= 1 or not 0 <= float(result["candidate_rate"]) <= 1:
                raise ValueError("rate outside [0, 1]")
            if len(result["paired_cluster_bootstrap_95ci"]) != 2:
                raise ValueError("missing confidence interval")
        if count < policy.min_pairs or groups < policy.min_groups:
            return {"status": "INSUFFICIENT_EVIDENCE", "reason": "minimum_locked_test_size_not_met", "promotion_allowed": False,
                    "sample_count": count, "group_count": groups}
    except (KeyError, TypeError, ValueError, OverflowError):
        return {"status": "EVALUATION_FAILED", "reason": "malformed_metrics", "promotion_allowed": False}

    results = [cer, wer]
    deltas = [float(item["delta_candidate_minus_original"]) for item in results]
    upper = [float(item["paired_cluster_bootstrap_95ci"][1]) for item in results]
    lower = [float(item["paired_cluster_bootstrap_95ci"][0]) for item in results]
    if any(delta > policy.max_absolute_regression for delta in deltas):
        return {"status": "ORIGINAL_WIN", "reason": "non_regression_limit_exceeded", "promotion_allowed": False}
    v2_win = all(bound < 0 for bound in upper) if policy.require_both_cer_and_wer_win else any(bound < 0 for bound in upper)
    original_win = any(bound > 0 for bound in lower)
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
