from __future__ import annotations

import math
import random
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Literal

MetricName = Literal["cer", "wer"]


def edit_distance(reference: Iterable[str], hypothesis: Iterable[str]) -> int:
    left = reference if isinstance(reference, (str, list, tuple)) else list(reference)
    right = hypothesis if isinstance(hypothesis, (str, list, tuple)) else list(hypothesis)
    if left == right:
        return 0
    n, m = len(left), len(right)
    start = 0
    limit = n if n < m else m
    while start < limit and left[start] == right[start]:
        start += 1
    end_n, end_m = n, m
    while end_n > start and end_m > start and left[end_n - 1] == right[end_m - 1]:
        end_n -= 1
        end_m -= 1
    left = left[start:end_n]
    right = right[start:end_m]
    n, m = len(left), len(right)
    if n == 0:
        return m
    if m == 0:
        return n
    if n < m:
        left, right = right, left
        n, m = m, n
    # Exact Myers bit-parallel Levenshtein in O(m) bitwise steps using Python bigints.
    peq: dict[str, int] = {}
    for i, item in enumerate(left):
        peq[item] = peq.get(item, 0) | (1 << i)
    mask = (1 << n) - 1
    pv = mask
    mv = 0
    score = n
    high_bit = 1 << (n - 1)
    for item in right:
        eq = peq.get(item, 0)
        xv = eq | mv
        xh = ((((eq & pv) + pv) ^ pv) | eq) & mask
        ph = mv | (mask ^ (xh | pv))
        mh = pv & xh
        if ph & high_bit:
            score += 1
        elif mh & high_bit:
            score -= 1
        ph = ((ph << 1) | 1) & mask
        mh = (mh << 1) & mask
        pv = mh | (mask ^ (xv | ph))
        mv = ph & xv
    return score


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


def _build_bootstrap_result(
    *,
    metric: MetricName,
    baseline: Literal["original", "parent", "active"],
    base_errors: int,
    candidate_errors: int,
    total_units: int,
    deltas: list[float],
    cluster_count: int,
    seed: int,
) -> dict[str, object]:
    base_score = base_errors / total_units
    candidate_score = candidate_errors / total_units
    deltas.sort()
    low_index = max(0, math.floor(0.025 * (len(deltas) - 1)))
    high_index = min(len(deltas) - 1, math.ceil(0.975 * (len(deltas) - 1)))
    label = "original" if baseline == "original" else baseline
    result: dict[str, object] = {
        "metric": metric,
        f"{label}_error_count": base_errors,
        "candidate_error_count": candidate_errors,
        "reference_unit_count": total_units,
        f"{label}_rate": base_score,
        "candidate_rate": candidate_score,
        f"delta_candidate_minus_{label}": candidate_score - base_score,
        f"paired_cluster_bootstrap_95ci_candidate_minus_{label}": [deltas[low_index], deltas[high_index]],
        "bootstrap_replicates": len(deltas),
        "cluster_count": cluster_count,
        "seed": seed,
    }
    if baseline == "original":
        # Preserve the legacy quality-gate/report keys for old clients.
        result["paired_cluster_bootstrap_95ci"] = result["paired_cluster_bootstrap_95ci_candidate_minus_original"]
        result["delta_candidate_minus_original"] = candidate_score - base_score
    return result


def _paired_group_bootstrap_multi(
    groups: dict[str, list[PairedLine]],
    names: list[str],
    *,
    metric: MetricName,
    baselines: tuple[Literal["original", "parent", "active"], ...],
    replicates: int,
    seed: int,
) -> dict[Literal["original", "parent", "active"], dict[str, object]]:
    # Precompute exact additive per-group errors once per metric (candidate + units once,
    # each baseline once) and bit-pack all lanes into one integer per group so all baselines
    # sharing (metric, seed) execute in a single C-level sum() per replicate with identical RNG draws.
    group_count = len(names)
    num_baselines = len(baselines)
    base_totals = [0] * num_baselines
    candidate_errors = total_units = 0
    per_group_rows: list[tuple[int, int, tuple[int, ...]]] = []
    max_val = 0
    for name in names:
        group_lines = groups[name]
        g_cand, g_units = aggregate_error(group_lines, "candidate", metric)
        g_bases = tuple(aggregate_error(group_lines, baseline, metric)[0] for baseline in baselines)
        per_group_rows.append((g_units, g_cand, g_bases))
        candidate_errors += g_cand
        total_units += g_units
        row_max = max(g_units, g_cand, max(g_bases))
        if row_max > max_val:
            max_val = row_max
        for idx, g_base in enumerate(g_bases):
            base_totals[idx] += g_base
    if total_units == 0:
        raise ValueError("paired benchmark has no reference units")

    shift = max(1, max_val * group_count).bit_length() + 1
    lane_mask = (1 << shift) - 1
    packed: list[int] = []
    for g_units, g_cand, g_bases in per_group_rows:
        value = g_units | (g_cand << shift)
        for idx, g_base in enumerate(g_bases):
            value |= g_base << (shift * (idx + 2))
        packed.append(value)
    packed_get = packed.__getitem__
    repeat_g = (group_count,) * group_count
    rng = random.Random(seed)
    randrange = rng.randrange
    baseline_shifts = tuple(shift * (idx + 2) for idx in range(num_baselines))
    deltas_by_baseline: list[list[float]] = [[] for _ in range(num_baselines)]

    if num_baselines == 1:
        shift2 = baseline_shifts[0]
        deltas0 = deltas_by_baseline[0]
        append0 = deltas0.append
        for _ in range(replicates):
            total = sum(map(packed_get, map(randrange, repeat_g)))
            units = total & lane_mask
            if units:
                candidate_n = (total >> shift) & lane_mask
                original_n = total >> shift2
                append0(candidate_n / units - original_n / units)
    else:
        for _ in range(replicates):
            total = sum(map(packed_get, map(randrange, repeat_g)))
            units = total & lane_mask
            if units:
                cand_rate = ((total >> shift) & lane_mask) / units
                for idx, b_shift in enumerate(baseline_shifts):
                    base_n = (total >> b_shift) & lane_mask
                    deltas_by_baseline[idx].append(cand_rate - base_n / units)

    return {
        baseline: _build_bootstrap_result(
            metric=metric,
            baseline=baseline,
            base_errors=base_totals[idx],
            candidate_errors=candidate_errors,
            total_units=total_units,
            deltas=deltas_by_baseline[idx],
            cluster_count=group_count,
            seed=seed,
        )
        for idx, baseline in enumerate(baselines)
    }


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
    names = sorted(groups)
    return _paired_group_bootstrap_multi(
        groups, names, metric=metric, baselines=(baseline,), replicates=replicates, seed=seed,
    )[baseline]


def benchmark_metrics(lines: list[PairedLine], *, replicates: int = 5_000, seed: int = 20261112) -> dict[str, object]:
    groups: dict[str, list[PairedLine]] = {}
    for line in lines:
        groups.setdefault(line.group_id, []).append(line)
    if not lines or not groups:
        raise ValueError("paired benchmark has no samples")
    names = sorted(groups)
    baselines: list[Literal["original", "parent", "active"]] = ["original"]
    for baseline in ("parent", "active"):
        if all(getattr(line, baseline) is not None for line in lines):
            baselines.append(baseline)
    baseline_tuple = tuple(baselines)
    cer_results = _paired_group_bootstrap_multi(
        groups, names, metric="cer", baselines=baseline_tuple, replicates=replicates, seed=seed,
    )
    wer_results = _paired_group_bootstrap_multi(
        groups, names, metric="wer", baselines=baseline_tuple, replicates=replicates, seed=seed + 1,
    )
    metrics: dict[str, object] = {
        "sample_count": len(lines),
        "group_count": len(groups),
        "cer": cer_results["original"],
        "wer": wer_results["original"],
    }
    for baseline in ("parent", "active"):
        if baseline in cer_results:
            metrics[f"{baseline}_cer"] = cer_results[baseline]
            metrics[f"{baseline}_wer"] = wer_results[baseline]
    return metrics
