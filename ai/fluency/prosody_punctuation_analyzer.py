"""Local zero-cost DSP prosody, punctuation-pause & intonation analyzer for ViRead.

Reuses the NumPy/SciPy acoustic pitch (vectorized FFT YIN F0, 80–1100 Hz, Butterworth
high-pass filtering, parabolic interpolation, octave-jump suppression) and short-time
RMS energy envelope techniques from `backend/app/services/karaoke_melody_extractor.py`
with zero cloud API cost.

Supports seamlessly:
  1. Full-audio mode: 16 kHz mono WAV/PCM (`bytes`, `Path`, or `np.ndarray`) + timings.
  2. Pre-extracted frame-array mode: `f0_frames` + `rms_frames` + timings.
  3. Timing-only mode: punctuated Vietnamese `reference_text` + `word_timings`.

Pedagogical & acoustic fairness guardrails (Grade 2–5 focus):
  - Pause ratios are normalized against the child's own speaking tempo
    (median within-clause inter-word gap) and adaptive mic noise floor
    (15th-percentile RMS vs 85th-percentile voiced RMS) so household background
    noise never unfairly penalizes a child.
  - Feedback is warm, specific, and encouraging for elementary learners.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from io import BytesIO
import logging
import math
from pathlib import Path
import re
from typing import Any, Sequence
import unicodedata
import wave

import numpy as np

try:
    from scipy.io import wavfile
except ImportError:  # pragma: no cover - lightweight web runtime without scipy
    wavfile = None  # type: ignore[assignment]

try:
    from scipy.signal import butter, medfilt, resample_poly, sosfiltfilt
except ImportError:  # pragma: no cover - lightweight web runtime without scipy
    butter = None  # type: ignore[assignment]
    medfilt = None  # type: ignore[assignment]
    resample_poly = None  # type: ignore[assignment]
    sosfiltfilt = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

ANALYSIS_SR = 16_000
YIN_FRAME_SAMPLES = 640  # 40 ms @ 16 kHz (covers down to 80 Hz lag=200 with 440-sample window)
DEFAULT_HOP_MS = 20
MIN_F0_HZ = 80.0
MAX_F0_HZ = 1_100.0
PROSODY_ANALYZER_VERSION = "feat5-dsp-v1"

COMMA_PUNCT_SET = frozenset({",", ";", "،", "؛"})
PERIOD_PUNCT_SET = frozenset({".", "!", "?", "…", "。", "！", "？"})
QUESTION_PUNCT_SET = frozenset({"?", "？"})
EXCLAIM_PUNCT_SET = frozenset({"!", "！"})
STATEMENT_PERIOD_SET = PERIOD_PUNCT_SET - QUESTION_PUNCT_SET - EXCLAIM_PUNCT_SET
ALL_PAUSE_PUNCTS = COMMA_PUNCT_SET | PERIOD_PUNCT_SET

CUE_SINGLE_BREATH = "•"
CUE_DOUBLE_BREATH = "••"
CUE_RISING_PITCH = "↗"
CUE_EXPRESSIVE = "✦"

DEFAULT_CUE_LEGEND: dict[str, str] = {
    CUE_SINGLE_BREATH: "Nghỉ hơi ngắn (dấu phẩy / chấm phẩy)",
    CUE_DOUBLE_BREATH: "Nghỉ hơi dài (dấu chấm / ba chấm)",
    CUE_RISING_PITCH: "Lên giọng nhẹ cuối câu (dấu chấm hỏi)",
    CUE_EXPRESSIVE: "Đọc vui tươi, nhấn giọng diễn cảm (dấu chấm than)",
}

_STRIP_NON_WORD_RE = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)
_MULTI_DOT_RE = re.compile(r"\.{2,}")


@dataclass
class BreathingCueToken:
    """Single word/segment with optional trailing punctuation & visual rhythm cue."""

    text: str
    punctuation: str | None = None
    cue_symbol: str | None = None
    cue_type: str | None = None  # "COMMA_PAUSE" | "PERIOD_PAUSE" | "QUESTION_RISE" | "EXCLAMATION_ENERGY"
    pause_beats: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class BreathingCueAnnotation:
    """Deterministic breathing & intonation annotation for a Vietnamese reading passage."""

    original_text: str
    annotated_text: str
    tokens: list[BreathingCueToken] = field(default_factory=list)
    cue_counts: dict[str, int] = field(default_factory=dict)
    cue_legend: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_CUE_LEGEND))

    def to_dict(self) -> dict[str, Any]:
        return {
            "original_text": self.original_text,
            "annotated_text": self.annotated_text,
            "tokens": [t.to_dict() for t in self.tokens],
            "cue_counts": dict(self.cue_counts),
            "cue_legend": dict(self.cue_legend),
        }

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]


@dataclass
class ClauseBreakdown:
    """Per-clause prosody & punctuation-pause diagnostic."""

    clause_index: int
    clause_text: str
    start_word_idx: int
    end_word_idx: int
    start_ms: int
    end_ms: int
    terminal_punct: str | None
    punctuation_kind: str  # "COMMA" | "PERIOD" | "QUESTION" | "EXCLAMATION" | "NONE"
    observed_pause_ms: float | None
    relative_pause_ratio: float | None
    expected_pause_ratio: float
    pause_score: float
    terminal_f0_delta_semitones: float | None = None
    intonation_score: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ProsodyAnalysisResult:
    """Complete local DSP prosody assessment output."""

    comma_pause_score: float
    period_pause_score: float
    intonation_contour_score: float
    overall_prosody_score: float
    grade_band_verdict: str  # "EXCELLENT" | "GOOD" | "DEVELOPING" | "NEEDS_PRACTICE"
    coaching_tip_vi: str
    clauses: list[ClauseBreakdown]
    model_version: str = PROSODY_ANALYZER_VERSION
    median_inter_word_gap_ms: float = 0.0
    noise_floor_rms: float = 0.0
    audio_analyzed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "comma_pause_score": self.comma_pause_score,
            "period_pause_score": self.period_pause_score,
            "intonation_contour_score": self.intonation_contour_score,
            "overall_prosody_score": self.overall_prosody_score,
            "grade_band_verdict": self.grade_band_verdict,
            "coaching_tip_vi": self.coaching_tip_vi,
            "clauses": [c.to_dict() for c in self.clauses],
            "model_version": self.model_version,
            "median_inter_word_gap_ms": self.median_inter_word_gap_ms,
            "noise_floor_rms": self.noise_floor_rms,
            "audio_analyzed": self.audio_analyzed,
        }


# ---------------------------------------------------------------------------
# Acoustic DSP helpers (adapted from karaoke_melody_extractor.py)
# ---------------------------------------------------------------------------
def _hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def _midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def _normalize_pcm_array(data: np.ndarray) -> np.ndarray:
    if data.ndim > 1:
        data = data.astype(np.float32).mean(axis=1)
    if np.issubdtype(data.dtype, np.integer):
        info = np.iinfo(data.dtype)
        scale = float(max(abs(info.min), info.max))
        if data.dtype == np.uint8:
            samples = (data.astype(np.float32) - 128.0) / 128.0
        else:
            samples = data.astype(np.float32) / scale
    else:
        samples = data.astype(np.float32, copy=False)
    return np.clip(samples, -1.0, 1.0)


def _resample_to_target(samples: np.ndarray, src_sr: int, target_sr: int) -> tuple[np.ndarray, int]:
    if src_sr <= 0:
        raise ValueError("Invalid sample rate")
    if src_sr == target_sr or samples.size == 0:
        return samples.astype(np.float32, copy=False), src_sr
    g = math.gcd(src_sr, target_sr)
    up = target_sr // g
    down = src_sr // g
    if resample_poly is None or up > 256 or down > 256:
        new_len = max(1, int(round(samples.size * (target_sr / float(src_sr)))))
        x_old = np.linspace(0.0, 1.0, num=samples.size, dtype=np.float64)
        x_new = np.linspace(0.0, 1.0, num=new_len, dtype=np.float64)
        return np.interp(x_new, x_old, samples).astype(np.float32), target_sr
    resampled = resample_poly(samples.astype(np.float64), up, down)
    return resampled.astype(np.float32), target_sr


def _decode_wav_bytes(raw: bytes) -> tuple[np.ndarray, int] | None:
    if len(raw) < 44 or raw[:4] != b"RIFF":
        return None
    if wavfile is not None:
        try:
            sr, data = wavfile.read(BytesIO(raw))
            return _normalize_pcm_array(data), int(sr)
        except Exception:
            pass
    try:
        with wave.open(BytesIO(raw), "rb") as wf:
            sr = wf.getframerate()
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            raw_frames = wf.readframes(wf.getnframes())
        if width == 2:
            arr = np.frombuffer(raw_frames, dtype=np.int16)
        elif width == 1:
            arr = np.frombuffer(raw_frames, dtype=np.uint8)
        elif width == 4:
            arr = np.frombuffer(raw_frames, dtype=np.int32)
        else:
            return None
        if channels > 1:
            arr = arr.reshape(-1, channels)
        return _normalize_pcm_array(arr), int(sr)
    except Exception:
        return None


def decode_speech_audio(
    audio: str | Path | bytes | bytearray | memoryview | np.ndarray,
    *,
    sample_rate: int | None = None,
    target_sr: int = ANALYSIS_SR,
) -> tuple[np.ndarray, int] | None:
    """Decode mono/stereo WAV bytes, file path, or raw PCM ndarray to float32 at `target_sr`."""
    if isinstance(audio, np.ndarray):
        sr = int(sample_rate or target_sr)
        return _resample_to_target(_normalize_pcm_array(audio), sr, target_sr)

    raw_bytes: bytes | None = None
    if isinstance(audio, (str, Path)):
        path = Path(audio)
        if not path.is_file():
            return None
        try:
            raw_bytes = path.read_bytes()
        except OSError:
            return None
    elif isinstance(audio, (bytes, bytearray, memoryview)):
        raw_bytes = bytes(audio)

    if not raw_bytes:
        return None

    wav_decoded = _decode_wav_bytes(raw_bytes)
    if wav_decoded is not None:
        return _resample_to_target(wav_decoded[0], wav_decoded[1], target_sr)

    # Raw 16-bit signed little-endian PCM fallback when caller passes headerless 16kHz PCM
    if len(raw_bytes) >= 640 and len(raw_bytes) % 2 == 0 and sample_rate:
        arr = np.frombuffer(raw_bytes, dtype=np.int16)
        return _resample_to_target(_normalize_pcm_array(arr), int(sample_rate), target_sr)

    return None


def _highpass_vocal(samples: np.ndarray, sr: int) -> np.ndarray:
    if samples.size < 32 or sr <= 400 or butter is None or sosfiltfilt is None:
        return samples
    try:
        sos = butter(2, 75.0 / (0.5 * sr), btype="highpass", output="sos")
        return sosfiltfilt(sos, samples.astype(np.float64)).astype(np.float32)
    except Exception:
        return samples


def _yin_frame_f0(
    frame: np.ndarray,
    sr: int,
    *,
    min_f0_hz: float = MIN_F0_HZ,
    max_f0_hz: float = MAX_F0_HZ,
    rms_gate: float = 0.006,
    threshold: float = 0.18,
    fallback_threshold: float = 0.30,
) -> tuple[float | None, float]:
    """Vectorized FFT YIN fundamental frequency estimator with parabolic refinement."""
    n = frame.size
    min_lag = max(2, int(math.floor(sr / max_f0_hz)))
    max_lag = min(n // 2 - 2, int(math.ceil(sr / min_f0_hz)))
    if max_lag <= min_lag + 2:
        return None, 0.0

    x = frame.astype(np.float64, copy=False)
    x = x - float(np.mean(x))
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < rms_gate:
        return None, 0.0

    win = n - max_lag
    if win < 64:
        return None, 0.0
    fft_len = 1 << int(math.ceil(math.log2(n + win)))
    prefix = x[:win]
    f_prefix = np.fft.rfft(prefix, n=fft_len)
    f_full = np.fft.rfft(x, n=fft_len)
    corr = np.fft.irfft(np.conj(f_prefix) * f_full, n=fft_len)[: max_lag + 1]

    sq = x * x
    csum = np.empty(n + 1, dtype=np.float64)
    csum[0] = 0.0
    np.cumsum(sq, out=csum[1:])
    e0 = csum[win]
    lags = np.arange(max_lag + 1)
    e_tau = csum[lags + win] - csum[lags]
    diff = np.maximum(0.0, e0 + e_tau - 2.0 * corr)
    diff[0] = 0.0

    cmnd = np.ones(max_lag + 1, dtype=np.float64)
    running = np.cumsum(diff[1:])
    valid_den = running > 1e-12
    idx = np.arange(1, max_lag + 1, dtype=np.float64)
    cmnd[1:] = np.where(valid_den, diff[1:] * idx / np.where(valid_den, running, 1.0), 1.0)

    tau = -1
    for lag in range(min_lag, max_lag):
        if cmnd[lag] < threshold:
            while lag + 1 <= max_lag and cmnd[lag + 1] < cmnd[lag]:
                lag += 1
            tau = lag
            break

    if tau < 0:
        sub = cmnd[min_lag : max_lag + 1]
        best_rel = int(np.argmin(sub))
        if sub[best_rel] <= fallback_threshold:
            tau = min_lag + best_rel
        else:
            return None, float(max(0.0, min(1.0, 1.0 - float(sub[best_rel]))))

    better_tau = float(tau)
    if 1 <= tau < max_lag:
        s0, s1, s2 = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
        denom = 2.0 * (2.0 * s1 - s2 - s0)
        if abs(denom) > 1e-12:
            shift = (s2 - s0) / denom
            if abs(shift) <= 1.0:
                better_tau = tau + shift

    if better_tau <= 0.0:
        return None, 0.0
    hz = sr / better_tau
    if hz < min_f0_hz or hz > max_f0_hz:
        return None, 0.0
    clarity = float(max(0.0, min(1.0, 1.0 - cmnd[tau])))
    if clarity < 0.55:
        return None, clarity
    return hz, clarity


def _suppress_octave_jumps(f0_hz: np.ndarray) -> np.ndarray:
    """Suppress isolated ±12-semitone octave glitches and apply light median smoothing."""
    voiced_mask = np.isfinite(f0_hz) & (f0_hz > 0.0)
    voiced_indices = np.flatnonzero(voiced_mask)
    if voiced_indices.size < 3:
        return f0_hz

    midis = np.zeros_like(f0_hz, dtype=np.float64)
    midis[voiced_indices] = np.array([_hz_to_midi(float(f0_hz[i])) for i in voiced_indices])
    voiced_vals = midis[voiced_indices].copy()
    global_med = float(np.median(voiced_vals))

    for i in range(voiced_vals.size):
        lo = max(0, i - 3)
        hi = min(voiced_vals.size, i + 4)
        local_ref = float(np.median(voiced_vals[lo:hi]))
        diff = voiced_vals[i] - local_ref
        if abs(abs(diff) - 12.0) <= 2.2:
            voiced_vals[i] -= 12.0 * math.copysign(1.0, diff)
        elif abs(voiced_vals[i] - global_med) > 16.0:
            if abs((voiced_vals[i] - 12.0) - local_ref) < abs(diff):
                voiced_vals[i] -= 12.0
            elif abs((voiced_vals[i] + 12.0) - local_ref) < abs(diff):
                voiced_vals[i] += 12.0

    if medfilt is not None:
        smoothed = medfilt(voiced_vals, kernel_size=3)
    elif voiced_vals.size >= 3:
        padded = np.pad(voiced_vals, (1, 1), mode="edge")
        smoothed = np.median(
            np.stack([padded[:-2], padded[1:-1], padded[2:]], axis=0),
            axis=0,
        )
    else:
        smoothed = voiced_vals
    out = f0_hz.copy()
    out[voiced_indices] = np.array([_midi_to_hz(float(m)) for m in smoothed], dtype=np.float64)
    return out


def extract_f0_and_rms_frames(
    samples: np.ndarray,
    sr: int = ANALYSIS_SR,
    *,
    hop_ms: int = DEFAULT_HOP_MS,
) -> tuple[np.ndarray, np.ndarray]:
    """Extract per-frame `(f0_hz_frames, rms_frames)` using YIN F0 & short-time RMS.

    Unvoiced frames have `NaN` in `f0_hz_frames`.
    """
    if samples.size < YIN_FRAME_SAMPLES:
        rms_single = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) if samples.size else 0.0
        return np.array([float("nan")], dtype=np.float64), np.array([rms_single], dtype=np.float64)

    filtered = _highpass_vocal(samples, sr)
    hop_samples = max(1, int(round(sr * (hop_ms / 1000.0))))
    frame_starts = range(0, filtered.size - YIN_FRAME_SAMPLES + 1, hop_samples)

    raw_rms_list: list[float] = []
    frames: list[np.ndarray] = []
    for start in frame_starts:
        frame = filtered[start : start + YIN_FRAME_SAMPLES]
        frames.append(frame)
        raw_rms_list.append(float(np.sqrt(np.mean(frame.astype(np.float64) ** 2))))

    if not frames:
        return np.array([float("nan")], dtype=np.float64), np.zeros(1, dtype=np.float64)

    rms_arr = np.array(raw_rms_list, dtype=np.float64)
    noise_floor = float(np.percentile(rms_arr, 15))
    speech_peak = float(np.percentile(rms_arr, 85))
    adaptive_rms_gate = max(0.005, noise_floor + 0.18 * max(0.0, speech_peak - noise_floor))

    f0_list: list[float] = []
    for frame, frame_rms in zip(frames, raw_rms_list):
        if frame_rms < adaptive_rms_gate:
            f0_list.append(float("nan"))
            continue
        hz, _ = _yin_frame_f0(frame, sr, rms_gate=max(0.004, adaptive_rms_gate * 0.8))
        f0_list.append(hz if hz is not None else float("nan"))

    f0_arr = _suppress_octave_jumps(np.array(f0_list, dtype=np.float64))
    return f0_arr, rms_arr


# ---------------------------------------------------------------------------
# Reference text alignment & clause segmentation
# ---------------------------------------------------------------------------
def _normalize_word_token(raw: str) -> str:
    nfc = unicodedata.normalize("NFC", raw or "")
    stripped = _STRIP_NON_WORD_RE.sub("", nfc.strip())
    return stripped.casefold()


def _extract_trailing_punct(surface: str) -> str | None:
    s = unicodedata.normalize("NFC", surface or "").strip()
    if not s:
        return None
    # Strip closing quotes/brackets at end to inspect underlying punctuation
    s = s.rstrip("\"'”’)]}»")
    if not s:
        return None
    if s.endswith("..."):
        return "…"
    last = s[-1]
    if last in ALL_PAUSE_PUNCTS:
        return last
    return None


def _parse_reference_tokens(reference_text: str) -> list[tuple[str, str, str | None]]:
    """Return list of `(display_token, normalized_word, trailing_punct)` from `reference_text`."""
    nfc = unicodedata.normalize("NFC", reference_text or "")
    nfc = _MULTI_DOT_RE.sub("…", nfc)
    # Attach stray space-separated punctuation back onto the preceding word
    nfc = re.sub(r"\s+([,;.!?…،؛。！？])", r"\1", nfc)
    out: list[tuple[str, str, str | None]] = []
    for raw_tok in nfc.split():
        punct = _extract_trailing_punct(raw_tok)
        norm = _normalize_word_token(raw_tok)
        if norm:
            out.append((raw_tok, norm, punct))
        elif punct and out:
            prev_disp, prev_norm, _ = out[-1]
            out[-1] = (f"{prev_disp}{punct}", prev_norm, punct)
    return out


def _resolve_word_punctuations(
    reference_text: str,
    word_timings: list[dict[str, Any]],
) -> list[str | None]:
    """Transfer punctuation from `reference_text` onto `word_timings` when STT tokens omit punctuation."""
    n = len(word_timings)
    if n == 0:
        return []

    direct_puncts = [
        _extract_trailing_punct(str(wt.get("word") or wt.get("text") or ""))
        for wt in word_timings
    ]
    ref_tokens = _parse_reference_tokens(reference_text)
    if not ref_tokens:
        return direct_puncts

    resolved = list(direct_puncts)
    if len(ref_tokens) == n:
        for i, (_, _, ref_p) in enumerate(ref_tokens):
            if resolved[i] is None and ref_p is not None:
                resolved[i] = ref_p
        return resolved

    # Greedy bounded lookahead alignment between timing words and reference words
    ref_idx = 0
    for i, wt in enumerate(word_timings):
        if resolved[i] is not None:
            if ref_idx < len(ref_tokens):
                ref_idx += 1
            continue
        wt_norm = _normalize_word_token(str(wt.get("word") or wt.get("text") or ""))
        if not wt_norm:
            continue
        matched_j: int | None = None
        hi = min(len(ref_tokens), ref_idx + 4)
        for j in range(ref_idx, hi):
            if ref_tokens[j][1] == wt_norm:
                matched_j = j
                break
        if matched_j is not None:
            resolved[i] = ref_tokens[matched_j][2]
            ref_idx = matched_j + 1

    # Ensure final word inherits terminal passage punctuation if still unset
    if resolved[-1] is None and ref_tokens[-1][2] is not None:
        resolved[-1] = ref_tokens[-1][2]
    return resolved


def _punct_kind(punct: str | None) -> str:
    if punct in COMMA_PUNCT_SET:
        return "COMMA"
    if punct in QUESTION_PUNCT_SET:
        return "QUESTION"
    if punct in EXCLAIM_PUNCT_SET:
        return "EXCLAMATION"
    if punct in PERIOD_PUNCT_SET:
        return "PERIOD"
    return "NONE"


# ---------------------------------------------------------------------------
# Scoring helpers (relative to child's tempo & noise floor)
# ---------------------------------------------------------------------------
def _score_relative_pause(ratio: float, *, is_period_boundary: bool) -> float:
    """Map relative pause ratio (`observed_pause_ms / baseline_gap_ms`) to 0–100."""
    if is_period_boundary:
        # Period / ? / ! / … expects a noticeable double breath (~2.3x–10x baseline gap)
        if ratio <= 1.12:
            return round(max(18.0, 18.0 + (ratio / 1.12) * 14.0), 1)
        if ratio < 2.3:
            frac = (ratio - 1.12) / (2.3 - 1.12)
            return round(32.0 + frac * 56.0, 1)
        if ratio <= 10.5:
            peak_bonus = 12.0 * (1.0 - min(1.0, abs(ratio - 4.5) / 6.0))
            return round(min(100.0, 88.0 + peak_bonus), 1)
        # Gentle taper for extra-long breath/decoding pauses so kids aren't harshly failed
        over = min(1.0, (ratio - 10.5) / 10.0)
        return round(88.0 - over * 20.0, 1)

    # Comma / semicolon expects a light single breath (~1.55x–6.8x baseline gap)
    if ratio <= 1.08:
        return round(max(22.0, 22.0 + (ratio / 1.08) * 13.0), 1)
    if ratio < 1.55:
        frac = (ratio - 1.08) / (1.55 - 1.08)
        return round(35.0 + frac * 53.0, 1)
    if ratio <= 7.0:
        peak_bonus = 12.0 * (1.0 - min(1.0, abs(ratio - 3.0) / 4.0))
        return round(min(100.0, 88.0 + peak_bonus), 1)
    over = min(1.0, (ratio - 7.0) / 8.0)
    return round(88.0 - over * 20.0, 1)


def _measure_acoustic_silence_ms(
    rms_frames: np.ndarray | None,
    window_start_ms: float,
    window_end_ms: float,
    *,
    silence_threshold_rms: float,
    hop_ms: int,
) -> float:
    """Measure low-energy pause duration (ms) relative to adaptive household noise floor."""
    if rms_frames is None or rms_frames.size == 0 or window_end_ms <= window_start_ms:
        return 0.0
    lo = max(0, int(math.floor(window_start_ms / hop_ms)))
    hi = min(rms_frames.size, int(math.ceil(window_end_ms / hop_ms)))
    if hi <= lo:
        return 0.0
    quiet_frames = int(np.count_nonzero(rms_frames[lo:hi] <= silence_threshold_rms))
    return float(quiet_frames * hop_ms)


def _score_clause_intonation(
    f0_slice: np.ndarray,
    rms_slice: np.ndarray | None,
    punct: str | None,
    *,
    global_speech_rms: float,
) -> tuple[float | None, float | None]:
    """Return `(intonation_score, terminal_f0_delta_semitones)` for a clause."""
    voiced = f0_slice[np.isfinite(f0_slice) & (f0_slice > 0.0)]
    if voiced.size < 3:
        return None, None

    midis = np.array([_hz_to_midi(float(hz)) for hz in voiced], dtype=np.float64)
    split = max(1, int(round(midis.size * 0.62)))
    tail_start = min(midis.size - 1, max(split, int(round(midis.size * 0.68))))
    body_med = float(np.median(midis[:split]))
    tail_med = float(np.median(midis[tail_start:]))
    delta_st = round(tail_med - body_med, 2)
    span_st = float(np.percentile(midis, 90) - np.percentile(midis, 10))
    std_st = float(np.std(midis))

    if punct in QUESTION_PUNCT_SET:
        # Vietnamese yes/no & wh-questions carry a gentle rising terminal F0 contour
        if delta_st >= 1.8:
            score = min(100.0, 88.0 + min(12.0, (delta_st - 1.8) * 3.0))
        elif delta_st >= 0.6:
            score = 60.0 + ((delta_st - 0.6) / 1.2) * 28.0
        elif abs(delta_st) < 0.6 and std_st < 0.35:
            score = 32.0
        else:
            score = max(28.0, 52.0 + delta_st * 10.0)
        return round(score, 1), delta_st

    if punct in EXCLAIM_PUNCT_SET:
        energy_boost = 0.0
        if rms_slice is not None and rms_slice.size > 0 and global_speech_rms > 1e-5:
            clause_peak_rms = float(np.percentile(rms_slice, 85))
            if clause_peak_rms >= global_speech_rms * 0.95:
                energy_boost = 12.0
        if span_st >= 2.2:
            score = min(100.0, 82.0 + min(18.0, (span_st - 2.2) * 4.5) + energy_boost * 0.4)
        elif std_st < 0.35:
            score = 34.0
        else:
            score = min(85.0, 52.0 + span_st * 13.0 + energy_boost)
        return round(score, 1), delta_st

    # Statement period / comma / plain clause: natural settled cadence vs dead-flat robotic monotone
    if std_st < 0.30 and abs(delta_st) < 0.30:
        return 35.0, delta_st
    if -5.5 <= delta_st <= -0.5:
        score = min(98.0, 84.0 + min(14.0, abs(delta_st) * 3.5))
    elif -0.5 < delta_st <= 1.2:
        score = 76.0 + min(12.0, std_st * 5.0)
    else:
        score = max(55.0, 76.0 - (delta_st - 1.2) * 5.0)
    return round(score, 1), delta_st


def _build_coaching_tip_vi(
    verdict: str,
    *,
    comma_score: float,
    period_score: float,
    intonation_score: float,
    has_question: bool,
    audio_analyzed: bool,
) -> str:
    if verdict == "EXCELLENT":
        return (
            "Tuyệt vời lắm! Con biết nghỉ hơi nhẹ ở dấu phẩy (•), dừng rõ ở dấu chấm (••) "
            "và đọc rất truyền cảm như người kể chuyện thực thụ! 🌟"
        )
    lowest = min(
        ("comma", comma_score),
        ("period", period_score),
        ("intonation", intonation_score if audio_analyzed else 100.0),
        key=lambda item: item[1],
    )[0]
    if lowest == "period" and period_score < 72.0:
        return (
            "Con đọc trôi chảy lắm! Khi gặp dấu chấm (••), con thử dừng lại hít nhẹ hai nhịp "
            "rồi mới đọc câu tiếp theo để câu chuyện rõ ràng hơn nhé! 😊"
        )
    if lowest == "comma" and comma_score < 72.0:
        return (
            "Con đang làm rất tốt! Khi thấy dấu phẩy (•), con nghỉ hơi ngắn một nhịp "
            "để không bị hụt hơi giữa câu dài nhé! 💪"
        )
    if lowest == "intonation" and audio_analyzed:
        if has_question:
            return (
                "Con nhớ ngắt nhịp tốt rồi! Ở cuối câu hỏi có dấu chấm hỏi (↗), "
                "con thử nâng nhẹ giọng lên một chút để câu đọc thật tự nhiên nhé! 🎵"
            )
        return (
            "Giọng đọc của con rất rõ! Con thử nhấn nhá thêm cảm xúc vui tươi ở từ quan trọng "
            "để bài đọc sinh động hơn nữa nhé! ✨"
        )
    if verdict == "GOOD":
        return (
            "Con đọc diễn cảm và ngắt nhịp khá đều rồi! Chỉ cần giữ nhịp thở thật bình tĩnh "
            "ở cuối mỗi câu là xuất sắc luôn nhé! 😊"
        )
    return (
        "Con cứ đọc thong thả theo sức mình nhé! Hãy nhìn ký hiệu • (nghỉ ngắn) và •• (nghỉ dài) "
        "để lấy hơi nhẹ nhàng sau mỗi dấu câu nha! ❤️"
    )


def _coerce_frame_array(frames: Sequence[float | None] | np.ndarray | None) -> np.ndarray | None:
    if frames is None:
        return None
    if isinstance(frames, np.ndarray):
        arr = frames.astype(np.float64, copy=True)
        arr[arr <= 0.0] = float("nan")
        return arr
    vals = [
        float("nan") if (v is None or (isinstance(v, (int, float)) and (math.isnan(v) or v <= 0.0))) else float(v)
        for v in frames
    ]
    return np.array(vals, dtype=np.float64) if vals else None


def _coerce_rms_array(frames: Sequence[float] | np.ndarray | None) -> np.ndarray | None:
    if frames is None:
        return None
    if isinstance(frames, np.ndarray):
        return np.maximum(0.0, frames.astype(np.float64, copy=False))
    vals = [max(0.0, float(v)) for v in frames]
    return np.array(vals, dtype=np.float64) if vals else None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def analyze_prosody(
    reference_text: str,
    word_timings: list[dict[str, Any]],
    *,
    audio: str | Path | bytes | bytearray | memoryview | np.ndarray | None = None,
    sample_rate: int | None = None,
    f0_frames: Sequence[float | None] | np.ndarray | None = None,
    rms_frames: Sequence[float] | np.ndarray | None = None,
    hop_ms: int = DEFAULT_HOP_MS,
) -> ProsodyAnalysisResult:
    """Analyze Vietnamese reading prosody from reference text, word timings, and optional audio/frames."""
    hop_ms = max(10, min(100, int(hop_ms)))
    _f0 = _coerce_frame_array(f0_frames)
    _rms = _coerce_rms_array(rms_frames)

    if audio is not None and _f0 is None:
        decoded = decode_speech_audio(audio, sample_rate=sample_rate, target_sr=ANALYSIS_SR)
        if decoded is not None:
            samples, sr = decoded
            _f0, extracted_rms = extract_f0_and_rms_frames(samples, sr, hop_ms=hop_ms)
            if _rms is None:
                _rms = extracted_rms

    audio_analyzed = bool(_f0 is not None and np.any(np.isfinite(_f0)))

    # Synthesize fallback timings if empty word_timings passed
    effective_timings: list[dict[str, Any]] = list(word_timings)
    if not effective_timings:
        parsed_ref = _parse_reference_tokens(reference_text)
        cursor_ms = 0
        for disp, _, punct in parsed_ref:
            effective_timings.append({"word": disp, "start_ms": cursor_ms, "end_ms": cursor_ms + 240})
            extra_gap = 260 if punct in PERIOD_PUNCT_SET else (150 if punct in COMMA_PUNCT_SET else 60)
            cursor_ms += 240 + extra_gap

    word_puncts = _resolve_word_punctuations(reference_text, effective_timings)

    # Adaptive noise floor & speech RMS
    noise_floor = 0.0
    speech_rms = 0.05
    silence_gate_rms = 0.012
    if _rms is not None and _rms.size > 0:
        noise_floor = float(np.percentile(_rms, 15))
        speech_rms = max(noise_floor + 0.005, float(np.percentile(_rms, 85)))
        silence_gate_rms = noise_floor + 0.25 * (speech_rms - noise_floor)

    # Baseline tempo: median inter-word gap across NON-punctuated boundaries
    within_clause_gaps: list[float] = []
    all_gaps: list[float] = []
    word_durations: list[float] = []
    for idx, wt in enumerate(effective_timings):
        s_ms = float(wt.get("start_ms", 0))
        e_ms = max(s_ms, float(wt.get("end_ms", s_ms)))
        if e_ms > s_ms:
            word_durations.append(e_ms - s_ms)
        if idx + 1 < len(effective_timings):
            next_s = float(effective_timings[idx + 1].get("start_ms", e_ms))
            gap = max(0.0, next_s - e_ms)
            all_gaps.append(gap)
            if word_puncts[idx] is None:
                within_clause_gaps.append(gap)

    median_word_dur = float(np.median(word_durations)) if word_durations else 220.0
    if within_clause_gaps:
        raw_baseline_gap = float(np.median(within_clause_gaps))
    elif all_gaps:
        raw_baseline_gap = float(np.percentile(all_gaps, 25))
    else:
        raw_baseline_gap = 60.0

    # Floor baseline gap so connected speech (0–25ms gaps) still yields stable ratios
    baseline_gap_ms = max(40.0, min(600.0, raw_baseline_gap if raw_baseline_gap >= 25.0 else 0.22 * median_word_dur))

    # Segment into clauses at punctuated words
    clauses: list[ClauseBreakdown] = []
    comma_scores: list[float] = []
    period_scores: list[float] = []
    intonation_scores: list[float] = []
    has_question = False

    clause_start_idx = 0
    total_words = len(effective_timings)
    total_audio_ms = float((_rms.size if _rms is not None else (_f0.size if _f0 is not None else 0)) * hop_ms)

    for i in range(total_words):
        punct = word_puncts[i]
        is_last_word = i == total_words - 1
        if punct is None and not is_last_word:
            continue

        clause_slice = effective_timings[clause_start_idx : i + 1]
        clause_text = " ".join(str(w.get("word") or w.get("text") or "").strip() for w in clause_slice).strip()
        if punct and clause_text and _extract_trailing_punct(clause_text) is None:
            clause_text = f"{clause_text}{punct}"

        c_start_ms = int(round(float(clause_slice[0].get("start_ms", 0))))
        c_end_ms = int(round(max(float(c_start_ms), float(clause_slice[-1].get("end_ms", c_start_ms)))))
        p_kind = _punct_kind(punct)
        if p_kind == "QUESTION":
            has_question = True

        expected_ratio = 2.5 if punct in PERIOD_PUNCT_SET else (1.6 if punct in COMMA_PUNCT_SET else 1.0)
        observed_pause_ms: float | None = None
        rel_ratio: float | None = None

        if not is_last_word:
            next_start_ms = float(effective_timings[i + 1].get("start_ms", c_end_ms))
            timing_gap = max(0.0, next_start_ms - float(c_end_ms))
            acoustic_gap = _measure_acoustic_silence_ms(
                _rms,
                max(0.0, float(c_end_ms) - 20.0),
                next_start_ms + 20.0,
                silence_threshold_rms=silence_gate_rms,
                hop_ms=hop_ms,
            )
            observed_pause_ms = round(max(timing_gap, min(timing_gap + 40.0, acoustic_gap)), 1)
        elif total_audio_ms > float(c_end_ms) + 60.0:
            trailing_quiet = _measure_acoustic_silence_ms(
                _rms,
                float(c_end_ms),
                min(total_audio_ms, float(c_end_ms) + 900.0),
                silence_threshold_rms=silence_gate_rms,
                hop_ms=hop_ms,
            )
            if trailing_quiet > 0.0:
                observed_pause_ms = round(trailing_quiet, 1)

        if observed_pause_ms is not None and punct in ALL_PAUSE_PUNCTS:
            rel_ratio = round(observed_pause_ms / baseline_gap_ms, 2)
            p_score = _score_relative_pause(
                rel_ratio,
                is_period_boundary=(punct in PERIOD_PUNCT_SET),
            )
            if punct in COMMA_PUNCT_SET:
                comma_scores.append(p_score)
            else:
                period_scores.append(p_score)
        else:
            # Final clause with no post-utterance trailing audio or unpunctuated end
            p_score = round(float(np.mean(period_scores)) if period_scores else 78.0, 1)

        intonation_s: float | None = None
        delta_st: float | None = None
        if _f0 is not None and _f0.size > 0 and c_end_ms > c_start_ms:
            lo_f = max(0, int(math.floor(c_start_ms / hop_ms)))
            hi_f = min(_f0.size, int(math.ceil(c_end_ms / hop_ms)) + 1)
            rms_sub = _rms[lo_f : min(_rms.size, hi_f)] if _rms is not None else None
            if hi_f > lo_f:
                intonation_s, delta_st = _score_clause_intonation(
                    _f0[lo_f:hi_f],
                    rms_sub,
                    punct,
                    global_speech_rms=speech_rms,
                )
                if intonation_s is not None:
                    intonation_scores.append(intonation_s)

        clauses.append(
            ClauseBreakdown(
                clause_index=len(clauses),
                clause_text=clause_text,
                start_word_idx=clause_start_idx,
                end_word_idx=i + 1,
                start_ms=c_start_ms,
                end_ms=c_end_ms,
                terminal_punct=punct,
                punctuation_kind=p_kind,
                observed_pause_ms=observed_pause_ms,
                relative_pause_ratio=rel_ratio,
                expected_pause_ratio=expected_ratio,
                pause_score=p_score,
                terminal_f0_delta_semitones=delta_st,
                intonation_score=intonation_s,
            )
        )
        clause_start_idx = i + 1

    has_comma_punct = any(p in COMMA_PUNCT_SET for p in word_puncts)
    has_period_punct = any(p in PERIOD_PUNCT_SET for p in word_puncts)

    comma_pause_score = (
        round(float(np.mean(comma_scores)), 1)
        if comma_scores
        else (round(float(np.mean(period_scores)), 1) if period_scores and not has_comma_punct else 75.0)
    )
    period_pause_score = (
        round(float(np.mean(period_scores)), 1)
        if period_scores
        else (round(float(np.mean(comma_scores)), 1) if comma_scores and not has_period_punct else 75.0)
    )
    intonation_contour_score = (
        round(float(np.mean(intonation_scores)), 1)
        if intonation_scores
        else 68.0
    )

    if audio_analyzed and intonation_scores:
        overall = (
            comma_pause_score * 0.30
            + period_pause_score * 0.35
            + intonation_contour_score * 0.35
        )
    else:
        overall = (
            comma_pause_score * 0.42
            + period_pause_score * 0.43
            + intonation_contour_score * 0.15
        )
    overall = round(max(0.0, min(100.0, overall)), 1)

    if overall >= 84.0:
        verdict = "EXCELLENT"
    elif overall >= 68.0:
        verdict = "GOOD"
    elif overall >= 50.0:
        verdict = "DEVELOPING"
    else:
        verdict = "NEEDS_PRACTICE"

    tip_vi = _build_coaching_tip_vi(
        verdict,
        comma_score=comma_pause_score,
        period_score=period_pause_score,
        intonation_score=intonation_contour_score,
        has_question=has_question,
        audio_analyzed=audio_analyzed,
    )

    return ProsodyAnalysisResult(
        comma_pause_score=comma_pause_score,
        period_pause_score=period_pause_score,
        intonation_contour_score=intonation_contour_score,
        overall_prosody_score=overall,
        grade_band_verdict=verdict,
        coaching_tip_vi=tip_vi,
        clauses=clauses,
        model_version=PROSODY_ANALYZER_VERSION,
        median_inter_word_gap_ms=round(baseline_gap_ms, 1),
        noise_floor_rms=round(noise_floor, 5),
        audio_analyzed=audio_analyzed,
    )


def annotate_punctuation_breathing_cues(text: str) -> BreathingCueAnnotation:
    """Deterministically annotate Vietnamese reading text with visual rhythm & intonation cues.

    Cue mapping:
      `,` / `;`   -> `•`   (single breath pause)
      `.` / `…`   -> `••`  (double breath pause)
      `?`         -> `↗`   (gentle rising pitch cue)
      `!`         -> `✦`   (expressive cue)
    """
    original = unicodedata.normalize("NFC", text or "").strip()
    if not original:
        return BreathingCueAnnotation(
            original_text="",
            annotated_text="",
            tokens=[],
            cue_counts={
                CUE_SINGLE_BREATH: 0,
                CUE_DOUBLE_BREATH: 0,
                CUE_RISING_PITCH: 0,
                CUE_EXPRESSIVE: 0,
            },
        )

    normalized = _MULTI_DOT_RE.sub("…", original)
    normalized = re.sub(r"\s+([,;.!?…،؛。！？])", r"\1", normalized)

    tokens: list[BreathingCueToken] = []
    annotated_parts: list[str] = []
    cue_counts: dict[str, int] = {
        CUE_SINGLE_BREATH: 0,
        CUE_DOUBLE_BREATH: 0,
        CUE_RISING_PITCH: 0,
        CUE_EXPRESSIVE: 0,
    }

    for raw_tok in normalized.split():
        punct = _extract_trailing_punct(raw_tok)
        cue_symbol: str | None = None
        cue_type: str | None = None
        beats = 0

        if punct in COMMA_PUNCT_SET:
            cue_symbol = CUE_SINGLE_BREATH
            cue_type = "COMMA_PAUSE"
            beats = 1
        elif punct in QUESTION_PUNCT_SET:
            cue_symbol = CUE_RISING_PITCH
            cue_type = "QUESTION_RISE"
            beats = 2
        elif punct in EXCLAIM_PUNCT_SET:
            cue_symbol = CUE_EXPRESSIVE
            cue_type = "EXCLAMATION_ENERGY"
            beats = 2
        elif punct in STATEMENT_PERIOD_SET:
            cue_symbol = CUE_DOUBLE_BREATH
            cue_type = "PERIOD_PAUSE"
            beats = 2

        tokens.append(
            BreathingCueToken(
                text=raw_tok,
                punctuation=punct,
                cue_symbol=cue_symbol,
                cue_type=cue_type,
                pause_beats=beats,
            )
        )
        if cue_symbol is not None:
            cue_counts[cue_symbol] = cue_counts.get(cue_symbol, 0) + 1
            annotated_parts.append(f"{raw_tok} {cue_symbol}")
        else:
            annotated_parts.append(raw_tok)

    return BreathingCueAnnotation(
        original_text=original,
        annotated_text=" ".join(annotated_parts),
        tokens=tokens,
        cue_counts=cue_counts,
    )
