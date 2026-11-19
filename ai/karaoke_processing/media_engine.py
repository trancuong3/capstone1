"""Offline bounded FFmpeg/Demucs operations in the isolated AI environment."""
import hashlib
from fractions import Fraction
from pathlib import Path
import subprocess

import imageio_ffmpeg
import numpy as np

from audio_clock import ENCODED_CLOCK_VERSION, verify_encoded_clock, verify_reference_clock

STEM_FILENAME = "955717e8-8726e21a.th"
STEM_SHA256 = "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4"
MODEL_VERSION = f"demucs-4.0.1:955717e8:{ENCODED_CLOCK_VERSION}"


def decode(path, *, sample_rate=44100, channels=2):
    path = Path(path).resolve(strict=True)
    if not path.is_file() or not 1 <= path.stat().st_size <= 20 * 1024 * 1024:
        raise ValueError("MEDIA_UNAVAILABLE")
    result = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error",
        "-protocol_whitelist", "file,pipe",
        *(["-f", "mp3"] if path.suffix.lower() == ".mp3" else []), "-i", str(path),
        "-t", "300.1", "-vn", "-ac", str(channels), "-ar", str(sample_rate),
        "-f", "f32le", "pipe:1",
    ], check=True, capture_output=True, timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0)
    samples = np.frombuffer(result.stdout, dtype="<f4").copy().reshape(-1, channels)
    if not 400 <= len(samples) <= sample_rate * 300 or not np.isfinite(samples).all():
        raise ValueError("MEDIA_UNAVAILABLE")
    return samples


def encode(samples, sample_rate, output):
    output = Path(output)
    if output.exists():
        raise ValueError("INVALID_PROVIDER_RESULT")
    samples = np.asarray(samples, dtype="<f4")
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-f", "f32le",
        "-ar", str(sample_rate), "-ac", str(samples.shape[1]), "-i", "pipe:0",
        "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "1",
        "-n", str(output),
    ], input=samples.tobytes(), check=True, capture_output=True, timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0)
    decoded = decode(output, sample_rate=sample_rate, channels=samples.shape[1])
    return verify_encoded_clock(samples.mean(axis=1), decoded.mean(axis=1), sample_rate)


def separate(source, workspace, model_path):
    import torch
    from demucs.apply import apply_model
    from demucs.htdemucs import HTDemucs
    from demucs.states import load_model
    torch.set_num_threads(2)
    checkpoint = Path(model_path).resolve(strict=True) / STEM_FILENAME
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    if digest != STEM_SHA256:
        raise ValueError("PROCESSING_CONFIGURATION_INVALID")
    # Only our pinned official checkpoint/class is allowed, not arbitrary pickle.
    with torch.serialization.safe_globals([
        HTDemucs, Fraction, np.dtype, type(np.dtype(np.float64)),
        (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"),
    ]):
        package = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model = load_model(package).eval()
    samples = decode(source, sample_rate=model.samplerate, channels=model.audio_channels)
    waveform = torch.from_numpy(samples.T.copy())
    reference = waveform.mean(0)
    deviation = reference.std()
    if float(deviation) < 0.0001:
        raise ValueError("NO_USABLE_VOCALS")
    normalized = (waveform - reference.mean()) / deviation
    with torch.inference_mode():
        stems = apply_model(model, normalized[None], shifts=0, split=True,
                            overlap=0.25, progress=False, device="cpu", num_workers=0, segment=7.8)[0]
    stems = stems * deviation + reference.mean()
    vocal_index = model.sources.index("vocals")
    vocal = stems[vocal_index].T.cpu().numpy()
    backing = stems[[i for i in range(len(model.sources)) if i != vocal_index]].sum(0).T.cpu().numpy()
    if not np.isfinite(vocal).all() or not np.isfinite(backing).all():
        raise ValueError("INVALID_PROVIDER_RESULT")
    ratio = float(np.sqrt(np.mean(vocal ** 2)) / max(1e-9, np.sqrt(np.mean(samples ** 2))))
    if ratio < 0.03:
        raise ValueError("NO_USABLE_VOCALS")
    gain = min(1.0, 0.95 / max(float(np.max(abs(vocal))), float(np.max(abs(backing))), 1e-9))
    vocal, backing = vocal * gain, backing * gain
    workspace = Path(workspace)
    vocal_path, backing_path = workspace / "vocal.mp3", workspace / "instrumental.mp3"
    vocal_clock = encode(vocal, model.samplerate, vocal_path)
    backing_clock = encode(backing, model.samplerate, backing_path)
    return dict(vocal=str(vocal_path), instrumental=str(backing_path),
                duration_ms=round(len(samples) * 1000 / model.samplerate),
                timeline_offset_ms=backing_clock["offset_ms"] - vocal_clock["offset_ms"],
                model_version=MODEL_VERSION,
                diagnostics=dict(vocal_to_input_rms=round(ratio, 4), encoder_gain=round(gain, 4),
                                 vocal_clock=vocal_clock, instrumental_clock=backing_clock,
                                 model_sha256=digest))


def verify_reference(source, reference):
    a, b = decode(source, channels=1)[:, 0], decode(reference, channels=1)[:, 0]
    return verify_reference_clock(a, b, 44100)
