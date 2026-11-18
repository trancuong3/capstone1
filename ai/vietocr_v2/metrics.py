from __future__ import annotations

import math
import random
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Literal

MetricName = Literal["cer", "wer"]


def edit_distance(reference: Iterable[str], hypothesis: Iterable[str]) -> int:
    left, right = list(reference), list(hypothesis)
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, left_item in enumerate(left, start=1):
        current = [i]
        for j, right_item in enumerate(right, start=1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (left_item != right_item)))
        previous = current
    return previous[-1]


def _units(text: str, metric: MetricName) -> list[str]:
    value = unicodedata.normalize("NFC", text)
    return list(value) if metric == "cer" else value.split()


@dataclass(frozen=True)
class PairedLine:
    group_id: str
    reference: str
    original: str
    candidate: str
    sample_id: str
    parent: str | None = None
    active: str | None = None


def aggregate_error(lines: Iterable[PairedLine], hypothesis: Literal["original", "candidate", "parent", "active"], metric: MetricName) -> tuple[int, int]:
    errors = units = 0
    for line in lines:
        reference_units = _units(line.reference, metric)
        output_units = _units(getattr(line, hypothesis), metric)
        errors += edit_distance(reference_units, output_units)
        units += len(reference_units)
    return errors, units


def paired_group_bootstrap(
    lines: list[PairedLine], *, metric: MetricName, replicates: int = 5_000,
    seed: int = 20261112, baseline: Literal["original", "parent", "active"] = "original",
) -> dict[str, object]:
    """Paired cluster bootstrap; groups (documents/pages) are the resampling unit."""
    groups: dict[str, list[PairedLine]] = {}
    for line in lines:
        groups.setdefault(line.group_id, []).append(line)
    if not lines or not groups:
        raise ValueError("paired benchmark has no samples")
    base_errors, total_units = aggregate_error(lines, baseline, metric)
    candidate_errors, _ = aggregate_error(lines, "candidate", metric)
    if total_units == 0:
        raise ValueError("paired benchmark has no reference units")
    base_score = base_errors / total_units
    candidate_score = candidate_errors / total_units
    names = sorted(groups)
    rng = random.Random(seed)
    deltas: list[float] = []
    for _ in range(replicates):
        sampled_names = [names[rng.randrange(len(names))] for _ in names]
        sampled = [line for name in sampled_names for line in groups[name]]
        original_n, units = aggregate_error(sampled, baseline, metric)
        candidate_n, _ = aggregate_error(sampled, "candidate", metric)
        if units:
            deltas.append(candidate_n / units - original_n / units)
    deltas.sort()
    low_index = max(0, math.floor(0.025 * (len(deltas) - 1)))
    high_index = min(len(deltas) - 1, math.ceil(0.975 * (len(deltas) - 1)))
    label = "original" if baseline == "original" else baseline
    result = {
        "metric": metric,
        f"{label}_error_count": base_errors,
        "candidate_error_count": candidate_errors,
        "reference_unit_count": total_units,
        f"{label}_rate": base_score,
        "candidate_rate": candidate_score,
        f"delta_candidate_minus_{label}": candidate_score - base_score,
        f"paired_cluster_bootstrap_95ci_candidate_minus_{label}": [deltas[low_index], deltas[high_index]],
        "bootstrap_replicates": len(deltas),
        "cluster_count": len(groups),
        "seed": seed,
    }
    if baseline == "original":
        # Preserve the legacy quality-gate/report keys for old clients.
        result["paired_cluster_bootstrap_95ci"] = result["paired_cluster_bootstrap_95ci_candidate_minus_original"]
        result["delta_candidate_minus_original"] = candidate_score - base_score
    return result


def benchmark_metrics(lines: list[PairedLine], *, replicates: int = 5_000, seed: int = 20261112) -> dict[str, object]:
    metrics: dict[str, object] = {
        "sample_count": len(lines),
        "group_count": len({line.group_id for line in lines}),
        "cer": paired_group_bootstrap(lines, metric="cer", replicates=replicates, seed=seed),
        "wer": paired_group_bootstrap(lines, metric="wer", replicates=replicates, seed=seed + 1),
    }
    for baseline in ("parent", "active"):
        if lines and all(getattr(line, baseline) is not None for line in lines):
            metrics[f"{baseline}_cer"] = paired_group_bootstrap(
                lines, metric="cer", replicates=replicates, seed=seed, baseline=baseline
            )
            metrics[f"{baseline}_wer"] = paired_group_bootstrap(
                lines, metric="wer", replicates=replicates, seed=seed + 1, baseline=baseline
            )
    return metrics
