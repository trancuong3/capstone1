"""Conservative vocal-envelope boundaries, not uniform timing interpolation.

CTC spikes locate characters, but their last frame is not the end of a sung
vowel. Only extend to a measured quiet boundary or a clear local energy valley.
Ambiguous legato/bleed stays unaligned for human review.
"""
from copy import deepcopy
import numpy as np

FRAME_MS = 20


def refine_held_notes(samples, units, *, sample_rate=16000, ctc_boundaries=None):
    width = sample_rate * FRAME_MS // 1000
    complete = len(samples) // width
    if complete < 5:
        return [dict(deepcopy(unit), ctc_end_ms=unit["end_ms"],
                     end_ms=None, end_evidence="unsupported") for unit in units]
    rms = np.sqrt(np.mean(np.asarray(samples[:complete * width], dtype=np.float64)
                          .reshape(-1, width) ** 2, axis=1))
    energy = np.convolve(np.pad(rms, (1, 1), mode="edge"), np.ones(3) / 3, mode="valid")
    output = []
    for index, unit in enumerate(units):
        item = deepcopy(unit)
        item["ctc_end_ms"] = unit["end_ms"]
        item["end_ms"], item["end_evidence"] = None, "unsupported"
        first = max(0, unit["start_ms"] // FRAME_MS)
        after = max(first + 1, (unit["end_ms"] + FRAME_MS - 1) // FRAME_MS)
        limit_ms = units[index + 1]["start_ms"] if index + 1 < len(units) else len(samples) * 1000 // sample_rate
        limit = min(complete, limit_ms // FRAME_MS, first + 15000 // FRAME_MS)
        if after >= limit or first >= len(energy):
            output.append(item)
            continue
        peak = float(np.percentile(energy[first:limit], 90))
        if peak < 0.003:
            output.append(item)
            continue
        quiet = max(0.001, peak * 0.07)
        # At least 60ms of measured quiet, rather than one zero crossing.
        boundary = next((frame for frame in range(after, limit - 2)
                         if np.max(energy[frame:frame + 3]) <= quiet), None)
        evidence = "silence_boundary" if boundary is not None else "unsupported"
        if boundary is None and index + 1 < len(units):
            candidates = []
            # A consonant transition can be a valley before the next CTC spike.
            # Both adjacent 80ms windows must have substantially more energy.
            for frame in range(max(after, limit - 18, 4), min(limit - 4, len(energy) - 4)):
                left = float(np.max(energy[frame - 4:frame]))
                right = float(np.max(energy[frame + 1:frame + 5]))
                if (energy[frame] <= 0.67 * min(left, right)
                        and energy[frame] == np.min(energy[frame - 2:frame + 3])):
                    candidates.append(frame)
            if candidates:
                boundary, evidence = candidates[-1], "energy_valley"
        if boundary is None and ctc_boundaries and index in ctc_boundaries:
            event = ctc_boundaries[index]
            measured = event.get("time_ms")
            support = event.get("support")
            if (type(measured) is int and type(support) in (int, float)
                    and np.isfinite(support) and 0.85 <= support <= 1
                    and unit["end_ms"] <= measured < min(limit_ms, first * FRAME_MS + 15000)
                    and measured > unit["start_ms"]):
                item["end_ms"], item["end_evidence"] = measured, "ctc_delimiter"
        if boundary is None and item["end_ms"] is None and index + 1 < len(units):
            # The valley must precede the next onset, but its right-hand 80ms
            # evidence window may include that next vowel. The original search
            # cut this context off 80ms early. Only fill still-unknown ends;
            # existing silence/valley/delimiter measurements remain unchanged.
            candidates = []
            for frame in range(max(after, limit - 4, 4), min(limit, len(energy) - 4)):
                left = float(np.max(energy[frame - 4:frame]))
                right = float(np.max(energy[frame + 1:frame + 5]))
                if (energy[frame] <= 0.67 * min(left, right)
                        and energy[frame] == np.min(energy[frame - 2:frame + 3])):
                    candidates.append(frame)
            if candidates:
                boundary, evidence = candidates[-1], "energy_valley"
        if boundary is not None and boundary * FRAME_MS > unit["start_ms"]:
            item["end_ms"], item["end_evidence"] = int(boundary * FRAME_MS), evidence
        output.append(item)
    return output
