"""Reference melody & beat map extraction for ViRead Pro Karaoke.

Pure NumPy/SciPy acoustic pitch (F0/MIDI) extraction from isolated vocal stems
or reference recordings:
- Zero new third-party dependencies (honors locked numpy==1.26.4 / scipy ABI).
- Vectorized YIN fundamental frequency detector (80–1100 Hz) with parabolic
  interpolation, Butterworth 100 Hz high-pass filtering, voicing clarity gate,
  median smoothing, and octave-jump suppression.
- Aligns compact target melody notes directly onto lyrics v2 syllable timings
  when available, and estimates vocal range (min/max/median MIDI) + BPM.
"""
from __future__ import annotations

from io import BytesIO
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any
import wave

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, medfilt, resample_poly, sosfiltfilt

from app.services.karaoke_practice_service import derive_musical_profile_from_lyrics

logger = logging.getLogger(__name__)

MELODY_PROFILE_VERSION = 1
DEFAULT_ANALYSIS_SR = 22_050
DEFAULT_HOP_MS = 40
MIN_F0_HZ = 80.0
MAX_F0_HZ = 1_100.0
YIN_FRAME_SAMPLES = 1024  # ~46.4 ms @ 22,050 Hz (covers down to ~43 Hz lag)
MAX_CONTOUR_POINTS = 2_400
MAX_NOTES = 1_200
MAX_MELODY_DURATION_MS = 300_000


def hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def _resample_to_target(samples: np.ndarray, src_sr: int, target_sr: int) -> tuple[np.ndarray, int]:
    if src_sr <= 0:
        raise ValueError("Invalid sample rate")
    if src_sr == target_sr or samples.size == 0:
        return samples.astype(np.float32, copy=False), src_sr
    g = math.gcd(src_sr, target_sr)
    up = target_sr // g
    down = src_sr // g
    # Keep polyphase factors bounded for unusual sample rates.
    if up > 256 or down > 256:
        new_len = max(1, int(round(samples.size * (target_sr / float(src_sr)))))
        x_old = np.linspace(0.0, 1.0, num=samples.size, dtype=np.float64)
        x_new = np.linspace(0.0, 1.0, num=new_len, dtype=np.float64)
        return np.interp(x_new, x_old, samples).astype(np.float32), target_sr
    resampled = resample_poly(samples.astype(np.float64), up, down)
    return resampled.astype(np.float32), target_sr


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


def _decode_wav_bytes(raw: bytes) -> tuple[np.ndarray, int] | None:
    if len(raw) < 44 or raw[:4] != b"RIFF":
        return None
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


def _find_ffmpeg() -> str | None:
    configured = (os.environ.get("FFMPEG_PATH") or "").strip()
    if configured and Path(configured).is_file():
        return configured
    return shutil.which("ffmpeg")


def _decode_via_ffmpeg(
    source_path: Path | None,
    raw_bytes: bytes | None,
    target_sr: int,
) -> tuple[np.ndarray, int] | None:
    ffmpeg_bin = _find_ffmpeg()
    if not ffmpeg_bin:
        return None
    cmd = [
        ffmpeg_bin,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path) if source_path is not None else "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(target_sr),
        "-f",
        "f32le",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(
            cmd,
            input=None if source_path is not None else raw_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=45,
            check=False,
        )
        if proc.returncode != 0 or len(proc.stdout) < 4:
            return None
        usable = len(proc.stdout) - (len(proc.stdout) % 4)
        samples = np.frombuffer(proc.stdout[:usable], dtype=np.float32).copy()
        return np.clip(samples, -1.0, 1.0), target_sr
    except Exception:
        return None


def decode_audio_to_mono_pcm(
    audio: str | Path | bytes | np.ndarray,
    *,
    sample_rate: int | None = None,
    target_sr: int = DEFAULT_ANALYSIS_SR,
) -> tuple[np.ndarray, int] | None:
    """Decode WAV/MP3 path, bytes, or float PCM into mono float32 at `target_sr`."""
    if isinstance(audio, np.ndarray):
        sr = int(sample_rate or target_sr)
        return _resample_to_target(_normalize_pcm_array(audio), sr, target_sr)

    source_path: Path | None = None
    raw_bytes: bytes | None = None
    if isinstance(audio, (str, Path)):
        path = Path(audio)
        if not path.is_file():
            return None
        source_path = path
        try:
            raw_bytes = path.read_bytes()
        except OSError:
            return None
    elif isinstance(audio, (bytes, bytearray, memoryview)):
        raw_bytes = bytes(audio)
    else:
        return None

    if not raw_bytes:
        return None

    wav_decoded = _decode_wav_bytes(raw_bytes)
    if wav_decoded is not None:
        return _resample_to_target(wav_decoded[0], wav_decoded[1], target_sr)

    return _decode_via_ffmpeg(source_path, raw_bytes, target_sr)


def _highpass_vocal(samples: np.ndarray, sr: int) -> np.ndarray:
    if samples.size < 32 or sr <= 400:
        return samples
    try:
        sos = butter(2, 95.0 / (0.5 * sr), btype="highpass", output="sos")
        return sosfiltfilt(sos, samples.astype(np.float64)).astype(np.float32)
    except Exception:
        return samples


def _yin_frame_f0(
    frame: np.ndarray,
    sr: int,
    *,
    min_f0_hz: float = MIN_F0_HZ,
    max_f0_hz: float = MAX_F0_HZ,
    threshold: float = 0.16,
    fallback_threshold: float = 0.28,
) -> tuple[float | None, float]:
    """Vectorized YIN fundamental frequency estimator with parabolic refinement."""
    n = frame.size
    min_lag = max(2, int(math.floor(sr / max_f0_hz)))
    max_lag = min(n // 2 - 2, int(math.ceil(sr / min_f0_hz)))
    if max_lag <= min_lag + 2:
        return None, 0.0

    x = frame.astype(np.float64, copy=False)
    x = x - float(np.mean(x))
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < 0.008:
        return None, 0.0

    # FFT-accelerated difference function d(tau) for lags [0..max_lag]:
    # d(tau) = sum_{j=0}^{W-1} (x[j] - x[j+tau])^2
    #        = E0 + E_tau - 2 * corr(tau)
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

    # Cumulative mean normalized difference (CMND).
    cmnd = np.ones(max_lag + 1, dtype=np.float64)
    running = np.cumsum(diff[1:])
    valid_den = running > 1e-12
    idx = np.arange(1, max_lag + 1, dtype=np.float64)
    cmnd[1:] = np.where(valid_den, diff[1:] * idx / np.where(valid_den, running, 1.0), 1.0)

    # First local minimum below threshold, else global minimum below fallback_threshold.
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

    # Parabolic interpolation around tau for sub-sample cent precision.
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
    if clarity < 0.58:
        return None, clarity
    return hz, clarity


def _suppress_octave_jumps(midis: np.ndarray, voiced: np.ndarray) -> np.ndarray:
    """Correct isolated ±12 semitone glitches and apply 5-frame median smoothing."""
    out = midis.copy()
    voiced_indices = np.flatnonzero(voiced)
    if voiced_indices.size < 3:
        return out

    # Step 1: median filter across voiced samples only (kernel=5 or 3).
    voiced_vals = out[voiced_indices]
    global_med = float(np.median(voiced_vals))

    # Guard isolated octave jumps relative to local neighborhood median.
    corrected = voiced_vals.copy()
    for i in range(corrected.size):
        lo = max(0, i - 3)
        hi = min(corrected.size, i + 4)
        local_ref = float(np.median(voiced_vals[lo:hi]))
        diff = corrected[i] - local_ref
        if abs(abs(diff) - 12.0) <= 2.2:
            corrected[i] -= 12.0 * math.copysign(1.0, diff)
        elif abs(corrected[i] - global_med) > 16.0:
            # Extreme outlier more than 1.3 octaves away from song median.
            if abs((corrected[i] - 12.0) - local_ref) < abs(diff):
                corrected[i] -= 12.0
            elif abs((corrected[i] + 12.0) - local_ref) < abs(diff):
                corrected[i] += 12.0

    k = 5 if corrected.size >= 5 else 3
    smoothed = medfilt(corrected, kernel_size=k)
    out[voiced_indices] = smoothed
    return out


def _estimate_bpm_from_frames(
    rms_env: np.ndarray, hop_ms: int, lyrics: dict[str, Any] | None
) -> float | None:
    _, lyrics_bpm, _ = derive_musical_profile_from_lyrics(lyrics)
    if lyrics_bpm is not None:
        return float(lyrics_bpm)
    if rms_env.size < 25:
        return None
    onset = np.maximum(0.0, np.diff(rms_env, prepend=rms_env[0]))
    if float(np.max(onset)) <= 1e-6:
        return None
    onset = onset - float(np.mean(onset))
    ac = np.correlate(onset, onset, mode="full")[onset.size - 1 :]
    min_lag = max(1, int(round((60_000.0 / 160.0) / hop_ms)))
    max_lag = min(ac.size - 1, int(round((60_000.0 / 65.0) / hop_ms)))
    if max_lag <= min_lag:
        return None
    best_lag = min_lag + int(np.argmax(ac[min_lag : max_lag + 1]))
    if ac[best_lag] <= 0:
        return None
    bpm = 60_000.0 / (best_lag * hop_ms)
    return round(max(40.0, min(220.0, bpm)), 1)


def _build_notes_from_lyrics(
    times_ms: np.ndarray,
    midis: np.ndarray,
    confs: np.ndarray,
    voiced: np.ndarray,
    lyrics: dict[str, Any],
) -> list[dict[str, Any]]:
    lines = lyrics.get("lines")
    if not isinstance(lines, list) or not lines:
        return []
    notes: list[dict[str, Any]] = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        line_id = str(line.get("id") or "")
        syllables = line.get("syllables")
        units: list[dict[str, Any]] = []
        if isinstance(syllables, list) and syllables:
            for syl in syllables:
                if (
                    isinstance(syl, dict)
                    and isinstance(syl.get("start_ms"), int)
                    and isinstance(syl.get("end_ms"), int)
                    and syl["end_ms"] > syl["start_ms"]
                ):
                    units.append(
                        {
                            "start_ms": syl["start_ms"],
                            "end_ms": syl["end_ms"],
                            "syllable_id": str(syl.get("id") or ""),
                            "line_id": line_id,
                            "text": str(syl.get("text") or "").strip(),
                        }
                    )
        elif (
            isinstance(line.get("start_ms"), int)
            and isinstance(line.get("end_ms"), int)
            and line["end_ms"] > line["start_ms"]
        ):
            units.append(
                {
                    "start_ms": line["start_ms"],
                    "end_ms": line["end_ms"],
                    "syllable_id": None,
                    "line_id": line_id,
                    "text": str(line.get("text") or "").strip(),
                }
            )

        for unit in units:
            start_ms = max(0, min(MAX_MELODY_DURATION_MS - 1, int(unit["start_ms"])))
            end_ms = max(start_ms + 1, min(MAX_MELODY_DURATION_MS, int(unit["end_ms"])))
            mask = (
                voiced
                & (times_ms >= start_ms - 25)
                & (times_ms <= end_ms + 25)
            )
            if not np.any(mask):
                continue
            unit_midis = midis[mask]
            unit_confs = confs[mask]
            med_midi = float(np.median(unit_midis))
            mean_conf = float(np.mean(unit_confs))
            note: dict[str, Any] = {
                "start_ms": start_ms,
                "end_ms": end_ms,
                "midi": round(med_midi, 2),
                "hz": round(midi_to_hz(med_midi), 2),
                "confidence": round(mean_conf, 3),
                "voiced": True,
            }
            if unit["syllable_id"]:
                note["syllable_id"] = unit["syllable_id"]
            if unit["line_id"]:
                note["line_id"] = unit["line_id"]
            if unit["text"]:
                note["text"] = unit["text"]
            notes.append(note)
            if len(notes) >= MAX_NOTES:
                return notes
    return notes


def _build_notes_from_segments(
    times_ms: np.ndarray,
    midis: np.ndarray,
    confs: np.ndarray,
    voiced: np.ndarray,
    hop_ms: int,
    max_end_ms: int = MAX_MELODY_DURATION_MS,
) -> list[dict[str, Any]]:
    notes: list[dict[str, Any]] = []
    n = times_ms.size
    end_cap = max(1, min(MAX_MELODY_DURATION_MS, int(max_end_ms)))
    i = 0
    while i < n and len(notes) < MAX_NOTES:
        if not voiced[i]:
            i += 1
            continue
        seg_start = max(0, min(end_cap - 1, int(times_ms[i])))
        seg_midis = [float(midis[i])]
        seg_confs = [float(confs[i])]
        j = i + 1
        while j < n and voiced[j]:
            ref_med = float(np.median(seg_midis))
            if abs(float(midis[j]) - ref_med) > 0.85:
                break
            seg_midis.append(float(midis[j]))
            seg_confs.append(float(confs[j]))
            j += 1
        seg_end = min(end_cap, int(times_ms[j - 1]) + hop_ms)
        if seg_end > seg_start and seg_end - seg_start >= max(80, hop_ms * 2):
            med_midi = float(np.median(seg_midis))
            notes.append(
                {
                    "start_ms": seg_start,
                    "end_ms": seg_end,
                    "midi": round(med_midi, 2),
                    "hz": round(midi_to_hz(med_midi), 2),
                    "confidence": round(float(np.mean(seg_confs)), 3),
                    "voiced": True,
                }
            )
        i = j
    return notes


def extract_melody_profile(
    audio: str | Path | bytes | np.ndarray,
    *,
    sample_rate: int | None = None,
    lyrics: dict[str, Any] | None = None,
    offset_ms: int = 0,
    duration_ms: int | None = None,
    hop_ms: int = DEFAULT_HOP_MS,
) -> dict[str, Any] | None:
    """Extract a compact, smoothed reference `melody_profile` from vocal audio.

    Returns `None` when audio cannot be decoded or contains no reliable pitched vocals.
    """
    decoded = decode_audio_to_mono_pcm(
        audio, sample_rate=sample_rate, target_sr=DEFAULT_ANALYSIS_SR
    )
    if decoded is None:
        return None
    samples, sr = decoded
    if samples.size < YIN_FRAME_SAMPLES:
        return None

    filtered = _highpass_vocal(samples, sr)
    hop_ms = max(25, min(50, int(hop_ms)))
    hop_samples = max(1, int(round(sr * (hop_ms / 1000.0))))
    actual_duration_ms = int(round((samples.size / float(sr)) * 1000.0))
    total_duration_ms = min(
        MAX_MELODY_DURATION_MS,
        int(duration_ms) if duration_ms and duration_ms > 0 else actual_duration_ms,
    )

    # Adaptive RMS threshold based on active vocal energy.
    frame_starts = range(0, samples.size - YIN_FRAME_SAMPLES + 1, hop_samples)
    times_list: list[int] = []
    midis_list: list[float] = []
    confs_list: list[float] = []
    voiced_list: list[bool] = []
    rms_list: list[float] = []

    for start in frame_starts:
        frame = filtered[start : start + YIN_FRAME_SAMPLES]
        t_ms = int(round((start / float(sr)) * 1000.0)) + int(offset_ms)
        if t_ms < 0:
            continue
        if total_duration_ms > 0 and t_ms > total_duration_ms:
            break
        rms = float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))
        rms_list.append(rms)
        hz, conf = _yin_frame_f0(frame, sr)
        times_list.append(t_ms)
        if hz is not None:
            midis_list.append(hz_to_midi(hz))
            confs_list.append(conf)
            voiced_list.append(True)
        else:
            midis_list.append(0.0)
            confs_list.append(conf)
            voiced_list.append(False)

    if not times_list:
        return None

    times_ms = np.array(times_list, dtype=np.int32)
    midis = np.array(midis_list, dtype=np.float64)
    confs = np.array(confs_list, dtype=np.float64)
    voiced = np.array(voiced_list, dtype=bool)
    rms_env = np.array(rms_list, dtype=np.float64)

    voiced_count = int(np.count_nonzero(voiced))
    if voiced_count < 3:
        return None

    midis = _suppress_octave_jumps(midis, voiced)
    voiced_midis = midis[voiced]
    min_midi = round(float(np.percentile(voiced_midis, 5)), 2)
    max_midi = round(float(np.percentile(voiced_midis, 95)), 2)
    median_midi = round(float(np.median(voiced_midis)), 2)
    bpm = _estimate_bpm_from_frames(rms_env, hop_ms, lyrics)

    notes = (
        _build_notes_from_lyrics(times_ms, midis, confs, voiced, lyrics)
        if isinstance(lyrics, dict) and lyrics.get("lines")
        else []
    )
    if not notes:
        notes = _build_notes_from_segments(
            times_ms, midis, confs, voiced, hop_ms, max_end_ms=total_duration_ms
        )

    # Compact downsampled contour points for frontend scoring & overview graph.
    voiced_idxs = np.flatnonzero(voiced)
    stride = max(1, int(math.ceil(voiced_idxs.size / float(MAX_CONTOUR_POINTS))))
    pitch_contour = [
        {
            "time_ms": min(MAX_MELODY_DURATION_MS, max(0, int(times_ms[idx]))),
            "hz": round(midi_to_hz(float(midis[idx])), 2),
            "midi": round(float(midis[idx]), 2),
            "confidence": round(float(confs[idx]), 3),
        }
        for idx in voiced_idxs[::stride]
    ]

    return {
        "melody_version": MELODY_PROFILE_VERSION,
        "hop_ms": hop_ms,
        "duration_ms": total_duration_ms,
        "min_midi": min_midi,
        "max_midi": max_midi,
        "median_midi": median_midi,
        "bpm": bpm,
        "notes": notes,
        "pitch_contour": pitch_contour,
    }


def build_musical_profile_payload(
    melody_profile: dict[str, Any],
    lyrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Convert an extracted `melody_profile` into `karaoke_musical_profiles.profile_json`."""
    beat_grid_ms, derived_bpm, phrase_windows = derive_musical_profile_from_lyrics(lyrics)
    contour = melody_profile.get("pitch_contour") or []
    return {
        "beat_grid_ms": beat_grid_ms,
        "phrase_windows": phrase_windows,
        "pitch_contour": contour,
        "melody_profile": melody_profile,
        "bpm": melody_profile.get("bpm") or derived_bpm,
    }
