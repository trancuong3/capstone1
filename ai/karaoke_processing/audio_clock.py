"""Measured audio-clock checks; never equate duration with matching timeline."""
import numpy as np
from scipy.signal import correlate, correlation_lags

ENCODED_CLOCK_VERSION = "active-anchors-v2"
MIN_ANCHOR_RMS = 0.0001


def _encoder_anchor_starts(original, count, sample_rate):
    """Choose using source energy only, never by how well decoded audio matches.

    Preserve informative beginning/middle/end windows. A silent/DC-only fixed
    window may be replaced by the strongest informative window in its third.
    A bad correlation at a chosen anchor still rejects; do not search for a
    different anchor after seeing decoded data.
    """
    window = min(count, sample_rate * 3)
    starts = []
    for index, fraction in enumerate((0.0, 0.5, 1.0)):
        start = round((count - window) * fraction)
        def energy(position):
            return float(np.std(original[position:position + window], dtype=np.float64))
        if energy(start) < MIN_ANCHOR_RMS:
            low = min(round(count * index / 3), count - window)
            high = min(max(low, round(count * (index + 1) / 3) - window), count - window)
            candidates = list(range(low, high + 1, sample_rate))
            if candidates[-1] != high:
                candidates.append(high)
            start = max(candidates, key=energy)
            if energy(start) < MIN_ANCHOR_RMS:
                continue
        if start not in starts:
            starts.append(start)
    return window, starts


def _offset(a, b, sample_rate, maximum_ms, minimum_correlation):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    a, b = a - np.mean(a), b - np.mean(b)
    norm = float(np.linalg.norm(a) * np.linalg.norm(b))
    if norm < 1e-9:
        raise ValueError("REFERENCE_TIMELINE_MISMATCH")
    values = correlate(b, a, mode="full", method="fft") / norm
    lags = correlation_lags(len(b), len(a))
    allowed = abs(lags) <= sample_rate * maximum_ms / 1000
    values, lags = values[allowed], lags[allowed]
    best = int(np.argmax(values))
    if float(values[best]) < minimum_correlation:
        raise ValueError("REFERENCE_TIMELINE_MISMATCH")
    return round(int(lags[best]) * 1000 / sample_rate), float(values[best])


def verify_encoded_clock(original, decoded, sample_rate):
    """MP3 decoder must preserve PCM clock at beginning, middle and end."""
    original, decoded = np.asarray(original), np.asarray(decoded)
    if (isinstance(sample_rate, (bool, np.bool_))
            or not isinstance(sample_rate, (int, np.integer)) or sample_rate <= 0
            or original.ndim != 1 or decoded.ndim != 1
            or not len(original) or not len(decoded)
            or original.dtype.kind not in "fiu" or decoded.dtype.kind not in "fiu"
            or not np.isfinite(original).all() or not np.isfinite(decoded).all()):
        raise ValueError("INVALID_PROVIDER_RESULT")
    if abs(len(original) - len(decoded)) * 1000 / sample_rate > 40:
        raise ValueError("INVALID_PROVIDER_RESULT")
    count = min(len(original), len(decoded))
    window, starts = _encoder_anchor_starts(original, count, sample_rate)
    offsets = []
    for start in starts:
        before, after = original[start:start + window], decoded[start:start + window]
        lag, support = _offset(before, after, sample_rate, 100, 0.85)
        if abs(lag) > 20:
            raise ValueError("INVALID_PROVIDER_RESULT")
        offsets.append((lag, support))
    if not offsets:
        raise ValueError("INVALID_PROVIDER_RESULT")
    return dict(offset_ms=round(float(np.median([x[0] for x in offsets]))),
                max_absolute_offset_ms=max(abs(x[0]) for x in offsets),
                minimum_correlation=round(min(x[1] for x in offsets), 4),
                anchors=len(offsets), algorithm_version=ENCODED_CLOCK_VERSION,
                anchor_starts_ms=[round(start * 1000 / sample_rate) for start in starts])


def verify_reference_clock(instrumental, reference_instrumental, sample_rate):
    """Compare local music envelopes at multiple anchors, not just durations.

    A vocal-only reference without a common backing cannot establish this proof;
    fail closed and require the original same-timeline recording/manual workflow.
    """
    a, b = np.asarray(instrumental), np.asarray(reference_instrumental)
    if abs(len(a) - len(b)) * 1000 / sample_rate > 50:
        raise ValueError("REFERENCE_TIMELINE_MISMATCH")
    hop = max(1, sample_rate // 100)  # 10 ms RMS envelopes
    def envelope(x):
        frames = len(x) // hop
        return np.sqrt(np.mean(x[:frames * hop].reshape(frames, hop) ** 2, axis=1))
    a, b = envelope(a), envelope(b)
    count, window = min(len(a), len(b)), min(len(a), len(b), 500)
    if window < 100:
        raise ValueError("REFERENCE_TIMELINE_MISMATCH")
    anchors = []
    for fraction in (0.0, 0.5, 1.0):
        start = round((count - window) * fraction)
        left, right = a[start:start + window], b[start:start + window]
        if np.std(left) < 0.0001 or np.std(right) < 0.0001:
            continue
        lag, score = _offset(left, right, 100, 1000, 0.7)
        if abs(lag) > 40:
            raise ValueError("REFERENCE_TIMELINE_MISMATCH")
        anchors.append((lag, score))
    if len(anchors) < (1 if count < 500 else 3):
        raise ValueError("REFERENCE_TIMELINE_MISMATCH")
    return dict(verified=True, anchors=len(anchors),
                max_absolute_offset_ms=max(abs(x[0]) for x in anchors),
                minimum_correlation=round(min(x[1] for x in anchors), 4))
