"""ViRead Local Windows Voice Worker (Loopback 127.0.0.1:8010).

Runs completely isolated from the OCR Python environment so OCR ABI pins
(`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`,
`pytesseract==0.3.13`) remain untouched.

Provides:
  - Local Vietnamese STT: `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09`
  - Local 3-region Vietnamese TTS (`Bắc · Trung · Nam`): `VieNeu-TTS v3 Turbo` (ONNX CPU, 48 kHz)
  - Pitch-preserving speed control (`0.85x · 1.0x · 1.15x`) applied once at generation
  - Content-addressed WAV cache keyed by `(provider, voice_id, model_version, speed, mode, text_nfc)`
  - Sample-accurate step-timed phonics synthesis (`POST /tts/phonics`) for Grade-1 `Đánh vần`
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import logging
import math
import os
import re
import struct
import sys
import tempfile
import threading
import time
import unicodedata
import wave
from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_ROOT = _REPO_ROOT / "backend"
if _BACKEND_ROOT.is_dir() and str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

try:
    import av  # type: ignore[import-not-found]
except (ImportError, OSError):
    av = None  # type: ignore[assignment]

try:
    import librosa  # type: ignore[import-not-found]
except (ImportError, OSError):
    librosa = None  # type: ignore[assignment]

import numpy as np
from scipy import signal as scipy_signal

try:
    import onnxruntime as ort  # type: ignore[import-not-found]
except (ImportError, OSError):
    ort = None  # type: ignore[assignment]

_sherpa_import_err: Exception | None = None
try:
    import sherpa_onnx  # type: ignore[import-not-found]
except (ImportError, OSError) as _exc:
    sherpa_onnx = None  # type: ignore[assignment]
    _sherpa_import_err = _exc

try:
    import soundfile as sf  # type: ignore[import-not-found]
except (ImportError, OSError):
    sf = None  # type: ignore[assignment]

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

_WORKSPACE_PARENT = _REPO_ROOT.parent
VOICE_RUNTIME_ROOT = Path(
    os.environ.get("VIREAD_VOICE_RUNTIME_DIR")
    or os.environ.get("VIREAD_VOICE_RUNTIME_ROOT")
    or str(_WORKSPACE_PARENT / "tools" / "voice-runtime")
)
HF_CACHE_DIR = Path(
    os.environ.get("HF_HOME", str(VOICE_RUNTIME_ROOT / "hf-cache"))
)
os.environ.setdefault("HF_HOME", str(HF_CACHE_DIR))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
if (HF_CACHE_DIR / "hub").is_dir() and any((HF_CACHE_DIR / "hub").iterdir()):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

try:
    from vieneu import Vieneu  # type: ignore[import-not-found]  # noqa: E402
    from vieneu_utils.core_utils import gaps_to_silence  # type: ignore[import-not-found]  # noqa: E402
    from vieneu_utils.phonemize_text import (  # type: ignore[import-not-found]  # noqa: E402
        normalize_to_chunks_v3_with_gaps,
    )
except ImportError:
    Vieneu = None  # type: ignore[assignment]

    def gaps_to_silence(gaps: list[Any]) -> list[float]:
        return [0.28 for _ in (gaps or [])]

    def normalize_to_chunks_v3_with_gaps(
        text: str, *, max_chars: int = 220
    ) -> tuple[list[str], list[str]]:
        cleaned = " ".join((text or "").split()).strip()
        if not cleaned:
            return [], []
        if len(cleaned) <= max_chars:
            return [cleaned], []
        sentences = [
            s.strip()
            for s in re.split(r"(?<=[.!?])\s+", cleaned)
            if s.strip()
        ]
        chunks: list[str] = []
        buf = ""
        for sent in sentences:
            if buf and len(buf) + 1 + len(sent) > max_chars:
                chunks.append(buf)
                buf = sent
            else:
                buf = f"{buf} {sent}".strip() if buf else sent
        if buf:
            chunks.append(buf)
        return chunks, ["sentence"] * max(0, len(chunks) - 1)

from app.services.vietnamese_tts_normalizer import (  # noqa: E402
    CHOICE_LETTER_SPOKEN as _CHOICE_LETTER_SPOKEN,
    QUIZ_CHOICE_LABEL_RE as _QUIZ_CHOICE_LABEL_RE,
    ensure_tts_terminal_punctuation,
    normalize_vietnamese_tts_text,
    project_chunk_spans_to_surface_words,
)

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_request_id_ctx: ContextVar[str] = ContextVar("viread_voice_request_id", default="-")


def _sanitize_request_id(raw: str | None) -> str:
    candidate = (raw or "").strip()
    if candidate and _REQUEST_ID_RE.fullmatch(candidate):
        return candidate
    return uuid4().hex


def get_voice_request_id() -> str:
    return _request_id_ctx.get()


class _RequestIdLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id_ctx.get()
        return True


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [voice_worker] [rid=%(request_id)s] %(message)s",
)
for _handler in logging.getLogger().handlers:
    _handler.addFilter(_RequestIdLogFilter())
logger = logging.getLogger("viread.voice_worker")
logger.addFilter(_RequestIdLogFilter())

WORKER_VERSION = "1.1.0"
SHERPA_MODEL_DIR = Path(
    os.environ.get(
        "VIREAD_SHERPA_MODEL_DIR",
        str(
            VOICE_RUNTIME_ROOT
            / "models"
            / "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09"
        ),
    )
)
STT_MODE = os.environ.get("VIREAD_STT_MODE", "ws").strip().lower()
if STT_MODE not in ("ws", "http"):
    STT_MODE = "ws"
STT_MODEL_VERSION = (
    os.environ.get("VIREAD_SHERPA_MODEL_VERSION", "").strip()
    or SHERPA_MODEL_DIR.name.lower()
)
TTS_PRECISION = os.environ.get("VIREAD_VOICE_TTS_PRECISION", "hybrid").strip().lower()
if TTS_PRECISION not in ("hybrid", "fp32", "int8"):
    TTS_PRECISION = "hybrid"
TTS_MODEL_VERSION = f"vieneu-v3-turbo-onnx-{TTS_PRECISION}-3.8.5"
TTS_HYBRID_WORD_FP32 = os.environ.get("VIREAD_VOICE_HYBRID_WORD_FP32", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
TTS_THREADS = int(os.environ.get("VIREAD_VOICE_TTS_THREADS", "6"))
TTS_CACHE_DIR = Path(
    os.environ.get(
        "VIREAD_VOICE_TTS_CACHE_DIR", str(VOICE_RUNTIME_ROOT / "tts-cache")
    )
)
try:
    TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    TTS_CACHE_DIR = Path(tempfile.gettempdir()) / "viread-voice-tts-cache"
    TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
TTS_CACHE_MAX_BYTES = max(
    1024 * 1024,
    int(os.environ.get("VIREAD_VOICE_TTS_CACHE_MAX_BYTES", str(500 * 1024 * 1024))),
)
_TTS_DISK_CACHE_LOCK = threading.Lock()

MAX_AUDIO_BYTES = 15 * 1024 * 1024
MAX_TEXT_CHARS = 5000
QUEUE_WAIT_SECONDS = float(os.environ.get("VIREAD_VOICE_QUEUE_WAIT_SECONDS", "25.0"))
STT_QUEUE_WAIT_SECONDS = float(os.environ.get("VIREAD_VOICE_STT_QUEUE_WAIT_SECONDS", "3.0"))
TTS_MEM_CACHE_MAX_ENTRIES = 128
_TTS_MEM_CACHE: OrderedDict[str, tuple[bytes, float]] = OrderedDict()
# Precompute 60Hz high-pass SOS filter once instead of solving filter design per STT call.
# 60Hz cuts DC drift/table rumble/50Hz hum while preserving Vietnamese low-register tones (huyền/nặng).
_HIGHPASS_60HZ_SOS = scipy_signal.butter(
    2, 60.0, btype="highpass", fs=16000.0, output="sos"
)
_HIGHPASS_80HZ_SOS = _HIGHPASS_60HZ_SOS
_LATEST_INTERIM_SEQ_BY_SESSION: dict[str, int] = {}
_INTERIM_COUNTER = 0


def _mem_cache_get(key: str) -> tuple[bytes, float] | None:
    hit = _TTS_MEM_CACHE.get(key)
    if hit is not None:
        _TTS_MEM_CACHE.move_to_end(key)
    return hit


def _mem_cache_put(key: str, value: tuple[bytes, float]) -> None:
    _TTS_MEM_CACHE[key] = value
    _TTS_MEM_CACHE.move_to_end(key)
    while len(_TTS_MEM_CACHE) > TTS_MEM_CACHE_MAX_ENTRIES:
        _TTS_MEM_CACHE.popitem(last=False)


def _touch_cache_files(*paths: Path) -> None:
    now = time.time()
    for p in paths:
        try:
            os.utime(p, (now, now))
        except OSError:
            pass


def prune_tts_cache_dir(
    cache_dir: Path | None = None,
    max_bytes: int | None = None,
) -> int:
    """Enforce bounded LRU disk budget (default 500 MB) on TTS cache entries."""
    target_dir = cache_dir or TTS_CACHE_DIR
    budget = TTS_CACHE_MAX_BYTES if max_bytes is None else max(0, int(max_bytes))
    if not target_dir.is_dir():
        return 0
    with _TTS_DISK_CACHE_LOCK:
        grouped: dict[str, list[tuple[Path, int, float]]] = {}
        total_bytes = 0
        try:
            entries = list(target_dir.iterdir())
        except OSError:
            return 0
        for item in entries:
            try:
                if not item.is_file():
                    continue
                stat = item.stat()
            except OSError:
                continue
            size = int(stat.st_size)
            total_bytes += size
            grouped.setdefault(item.stem, []).append((item, size, float(stat.st_mtime)))
        if total_bytes <= budget:
            return 0
        # Sort entry groups oldest-last-touched first so LRU entries are evicted first.
        ordered_groups = sorted(
            grouped.values(),
            key=lambda files: max(m for _, _, m in files),
        )
        reclaimed = 0
        for files in ordered_groups:
            if total_bytes <= budget:
                break
            for fpath, fsize, _ in files:
                try:
                    fpath.unlink(missing_ok=True)
                    total_bytes -= fsize
                    reclaimed += fsize
                except OSError:
                    pass
        return reclaimed


@dataclass(frozen=True, slots=True)
class LocalVoicePreset:
    voice_id: str
    preset_name: str
    display_name: str
    region: Literal["north", "central", "south"]
    region_label: str
    gender: Literal["female", "male"]
    style_label: str
    is_default: bool = False


CURATED_VOICES: tuple[LocalVoicePreset, ...] = (
    LocalVoicePreset(
        voice_id="local_north_truc_ly",
        preset_name="Trúc Ly",
        display_name="Cô Trúc Ly",
        region="north",
        region_label="Miền Bắc",
        gender="female",
        style_label="Tự nhiên, ấm áp",
        is_default=True,
    ),
    LocalVoicePreset(
        voice_id="local_north_ngoc_linh",
        preset_name="Ngọc Linh",
        display_name="Cô Ngọc Linh",
        region="north",
        region_label="Miền Bắc",
        gender="female",
        style_label="Kể chuyện dịu dàng",
    ),
    LocalVoicePreset(
        voice_id="local_north_thien_minh",
        preset_name="Thiện Minh",
        display_name="Thầy Thiện Minh",
        region="north",
        region_label="Miền Bắc",
        gender="male",
        style_label="Kể chuyện truyền cảm",
    ),
    LocalVoicePreset(
        voice_id="local_central_ngoc_tran",
        preset_name="Ngọc Trân",
        display_name="Cô Ngọc Trân",
        region="central",
        region_label="Miền Trung",
        gender="female",
        style_label="Tự nhiên, dịu dàng",
    ),
    LocalVoicePreset(
        voice_id="local_central_quang_son",
        preset_name="Quang Sơn",
        display_name="Thầy Quang Sơn",
        region="central",
        region_label="Miền Trung",
        gender="male",
        style_label="Tự nhiên, rõ chữ",
    ),
    LocalVoicePreset(
        voice_id="local_south_thuc_doan",
        preset_name="Thục Đoan",
        display_name="Cô Thục Đoan",
        region="south",
        region_label="Miền Nam",
        gender="female",
        style_label="Kể chuyện ấm áp",
    ),
    LocalVoicePreset(
        voice_id="local_south_my_duyen",
        preset_name="Mỹ Duyên",
        display_name="Cô Mỹ Duyên",
        region="south",
        region_label="Miền Nam",
        gender="female",
        style_label="Đọc truyện thiếu nhi",
    ),
    LocalVoicePreset(
        voice_id="local_south_thai_son",
        preset_name="Thái Sơn",
        display_name="Thầy Thái Sơn",
        region="south",
        region_label="Miền Nam",
        gender="male",
        style_label="Kể chuyện rõ ràng",
    ),
)

VOICE_BY_ID: dict[str, LocalVoicePreset] = {v.voice_id: v for v in CURATED_VOICES}
DEFAULT_VOICE_ID = "local_north_truc_ly"

WORD_TOKEN_RE = re.compile(r"\S+", re.UNICODE)


class TtsSynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice_id: str = Field(default=DEFAULT_VOICE_ID, min_length=1, max_length=128)
    speed: float = Field(default=1.0, ge=0.7, le=1.3)
    word_sample: bool = False
    audio_format: Literal["wav", "mp3", "ogg"] | None = None


class PhonicsStepRequestItem(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    spoken_text: str = Field(min_length=1, max_length=240)
    pause_after_ms: int = Field(default=400, ge=80, le=2000)


class PhonicsSynthesisRequest(BaseModel):
    steps: list[PhonicsStepRequestItem] = Field(min_length=1, max_length=12)
    voice_id: str = Field(default=DEFAULT_VOICE_ID, min_length=1, max_length=128)
    speed: float = Field(default=1.0, ge=0.7, le=1.3)
    audio_format: Literal["wav", "mp3", "ogg"] | None = None


def _ensure_bpe_vocab(model_dir: Path) -> Path | None:
    """Ensure `bpe.vocab` exists alongside `bpe.model` using SentencePiece when available."""
    vocab_path = model_dir / "bpe.vocab"
    try:
        if vocab_path.is_file() and vocab_path.stat().st_size > 0:
            return vocab_path
    except OSError:
        pass
    bpe_model = model_dir / "bpe.model"
    if not bpe_model.is_file():
        return None
    try:
        import sentencepiece as spm  # type: ignore[import-not-found]
    except ImportError:
        return None
    try:
        sp = spm.SentencePieceProcessor()
        sp.load(str(bpe_model))
        lines = [
            f"{sp.id_to_piece(i)}\t{sp.get_score(i)}\n"
            for i in range(sp.get_piece_size())
        ]
        _atomic_write_bytes(vocab_path, "".join(lines).encode("utf-8"))
        return vocab_path
    except Exception as exc:
        logger.warning("bpe_vocab_export_failed error_type=%s", type(exc).__name__)
        return None


def _parse_stt_hotwords(raw_keyterms: list[str] | str | None) -> list[str]:
    if not raw_keyterms:
        return []
    candidates: list[str] = []
    if isinstance(raw_keyterms, str):
        stripped = raw_keyterms.strip()
        if not stripped:
            return []
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, list):
                    candidates = [str(item) for item in parsed if isinstance(item, str)]
            except Exception:
                candidates = []
        if not candidates:
            candidates = re.split(r"[\n,;]+", stripped)
    else:
        candidates = [str(item) for item in raw_keyterms if isinstance(item, str)]

    out: list[str] = []
    seen: set[str] = set()
    for raw in candidates:
        term = unicodedata.normalize("NFC", raw).strip()[:80]
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(term)
        if len(out) >= 30:
            break
    return out


class _OrtOfflineRecognitionResult:
    __slots__ = ("text", "tokens", "timestamps", "ys_log_probs")

    def __init__(
        self,
        *,
        text: str = "",
        tokens: list[str] | None = None,
        timestamps: list[float] | None = None,
        ys_log_probs: list[float] | None = None,
    ) -> None:
        self.text = text
        self.tokens = tokens if tokens is not None else []
        self.timestamps = timestamps if timestamps is not None else []
        self.ys_log_probs = ys_log_probs if ys_log_probs is not None else []


class _OrtOfflineStream:
    __slots__ = ("hotwords", "sample_rate", "samples", "result")

    def __init__(self, hotwords: str = "") -> None:
        self.hotwords = hotwords
        self.sample_rate = 16000
        self.samples = np.zeros(0, dtype=np.float32)
        self.result = _OrtOfflineRecognitionResult()

    def accept_waveform(self, sample_rate: int, samples: Any) -> None:
        arr = np.asarray(samples, dtype=np.float32).reshape(-1)
        if sample_rate != 16000 and arr.size > 0:
            if librosa is not None:
                arr = librosa.resample(arr, orig_sr=int(sample_rate), target_sr=16000)
            else:
                target_n = max(1, int(round(arr.size * 16000.0 / float(sample_rate))))
                arr = scipy_signal.resample(arr, target_n).astype(np.float32)
        self.sample_rate = 16000
        self.samples = arr


@dataclass(slots=True)
class _BeamHyp:
    ys: tuple[int, ...]
    log_prob: float
    tokens: list[str]
    timestamps: list[float]
    ys_log_probs: list[float]


class OrtZipformerOfflineRecognizer:
    """Pure ONNX Runtime + Kaldi 80-dim Mel-fbank Zipformer2 transducer recognizer.

    Provides 100% offline Vietnamese STT parity on Windows 11 hosts where Smart App
    Control / WDAC blocks unsigned `_sherpa_onnx.pyd` / `_kaldi_native_fbank.pyd`
    while Microsoft-signed `onnxruntime` runs natively at full speed.
    """

    def __init__(
        self,
        *,
        encoder_path: Path,
        decoder_path: Path,
        joiner_path: Path,
        tokens_path: Path,
        bpe_model_path: Path | None = None,
        num_threads: int = 4,
        max_active_paths: int = 4,
        hotwords_score: float = 1.2,
    ) -> None:
        if ort is None:
            raise RuntimeError("onnxruntime is not available for OrtZipformerOfflineRecognizer")
        sess_opts = ort.SessionOptions()
        sess_opts.intra_op_num_threads = max(1, int(num_threads))
        sess_opts.inter_op_num_threads = 1
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = ["CPUExecutionProvider"]

        self._encoder = ort.InferenceSession(
            str(encoder_path), sess_options=sess_opts, providers=providers
        )
        self._decoder = ort.InferenceSession(
            str(decoder_path), sess_options=sess_opts, providers=providers
        )
        self._joiner = ort.InferenceSession(
            str(joiner_path), sess_options=sess_opts, providers=providers
        )

        dec_meta = self._decoder.get_modelmeta().custom_metadata_map
        self._context_size = int(dec_meta.get("context_size", "2") or 2)
        self._blank_id = 0
        self._sos_eos_id = 1
        self._unk_id = 2
        self._max_active_paths = max(1, int(max_active_paths))
        self._hotwords_score = float(hotwords_score)

        self._id_to_token: dict[int, str] = {}
        for line in tokens_path.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split()
            if len(parts) >= 2:
                self._id_to_token[int(parts[-1])] = parts[0]
            elif len(parts) == 1 and parts[0].isdigit():
                self._id_to_token[int(parts[0])] = ""

        self._sp: Any | None = None
        if bpe_model_path is not None and bpe_model_path.is_file():
            try:
                import sentencepiece as spm  # type: ignore[import-not-found]

                sp = spm.SentencePieceProcessor()
                sp.load(str(bpe_model_path))
                self._sp = sp
            except Exception:
                self._sp = None

        self._frame_len = 400
        self._frame_shift = 160
        self._n_fft = 512
        self._n_mels = 80
        self._povey = np.power(
            0.5
            - 0.5
            * np.cos(
                2.0 * np.pi * np.arange(self._frame_len, dtype=np.float64) / (self._frame_len - 1)
            ),
            0.85,
        ).astype(np.float32)
        self._mel_bins_t = self._build_kaldi_mel_bins(
            sr=16000, n_fft=self._n_fft, n_mels=self._n_mels, low_freq=20.0, high_freq=7600.0
        )

        # Warm ONNX thread pools & arenas once with 0.25s silence
        warm_stream = self.create_stream()
        warm_stream.accept_waveform(16000, np.zeros(4000, dtype=np.float32))
        self.decode_stream(warm_stream)

    @staticmethod
    def _build_kaldi_mel_bins(
        *, sr: int, n_fft: int, n_mels: int, low_freq: float, high_freq: float
    ) -> np.ndarray:
        def _hz_to_mel(freq: np.ndarray | float) -> np.ndarray | float:
            return 1127.0 * np.log(1.0 + np.asarray(freq, dtype=np.float64) / 700.0)

        half_bins = n_fft // 2
        low_mel = float(_hz_to_mel(low_freq))
        high_mel = float(_hz_to_mel(high_freq))
        mel_pts = np.linspace(low_mel, high_mel, n_mels + 2, dtype=np.float64)
        fft_freqs = np.arange(half_bins, dtype=np.float64) * (float(sr) / float(n_fft))
        fft_mels = np.asarray(_hz_to_mel(fft_freqs), dtype=np.float64)

        bins = np.zeros((n_mels, half_bins), dtype=np.float32)
        for m in range(n_mels):
            left, center, right = mel_pts[m], mel_pts[m + 1], mel_pts[m + 2]
            up = (fft_mels - left) / max(1e-9, center - left)
            down = (right - fft_mels) / max(1e-9, right - center)
            bins[m] = np.maximum(0.0, np.minimum(up, down)).astype(np.float32)
        return np.ascontiguousarray(bins.T)

    def _extract_fbank_80(self, samples: np.ndarray) -> np.ndarray:
        x = np.asarray(samples, dtype=np.float32).reshape(-1)
        if x.size < self._frame_len:
            return np.zeros((0, self._n_mels), dtype=np.float32)
        windows = np.lib.stride_tricks.sliding_window_view(x, self._frame_len)[
            :: self._frame_shift
        ]
        frames = np.array(windows, dtype=np.float32, copy=True)
        frames -= np.mean(frames, axis=1, keepdims=True)
        frames[:, 1:] -= 0.97 * frames[:, :-1]
        frames[:, 0] *= 1.0 - 0.97
        frames *= self._povey[None, :]
        power_spec = np.abs(np.fft.rfft(frames, n=self._n_fft, axis=1)[:, : self._n_fft // 2]) ** 2
        mel_energies = np.maximum(power_spec @ self._mel_bins_t, 1.1920929e-7)
        return np.log(mel_energies).astype(np.float32, copy=False)

    def _build_hotword_token_boost(self, hotwords: str) -> set[int]:
        boosted: set[int] = set()
        if not hotwords or self._sp is None:
            return boosted
        for phrase in hotwords.split("/"):
            cleaned = unicodedata.normalize("NFC", phrase).strip().upper()
            if not cleaned:
                continue
            try:
                ids = self._sp.encode_as_ids(cleaned)
                for tid in ids:
                    if int(tid) > self._unk_id:
                        boosted.add(int(tid))
            except Exception:
                continue
        return boosted

    def create_stream(self, hotwords: str = "") -> _OrtOfflineStream:
        return _OrtOfflineStream(hotwords=hotwords)

    def decode_stream(self, stream: _OrtOfflineStream) -> None:
        feats = self._extract_fbank_80(stream.samples)
        if feats.shape[0] < 4:
            stream.result = _OrtOfflineRecognitionResult()
            return

        enc_out, enc_lens = self._encoder.run(
            None,
            {
                "x": feats[None, :, :],
                "x_lens": np.array([feats.shape[0]], dtype=np.int64),
            },
        )
        t_out = int(enc_lens[0]) if enc_lens is not None and len(enc_lens) > 0 else int(enc_out.shape[1])
        if t_out <= 0:
            stream.result = _OrtOfflineRecognitionResult()
            return

        frame_shift_out_s = 0.04
        ctx_size = self._context_size
        k_beam = self._max_active_paths
        boosted_ids = self._build_hotword_token_boost(stream.hotwords)
        dec_cache: dict[tuple[int, ...], np.ndarray] = {}

        init_ctx = tuple([self._blank_id] * ctx_size)
        hyps: list[_BeamHyp] = [
            _BeamHyp(
                ys=init_ctx,
                log_prob=0.0,
                tokens=[],
                timestamps=[],
                ys_log_probs=[],
            )
        ]

        for t in range(t_out):
            missing_ctxs: list[tuple[int, ...]] = []
            for h in hyps:
                ctx = h.ys[-ctx_size:]
                if ctx not in dec_cache and ctx not in missing_ctxs:
                    missing_ctxs.append(ctx)
            if missing_ctxs:
                ctx_arr = np.asarray(missing_ctxs, dtype=np.int64)
                dec_outs = self._decoder.run(None, {"y": ctx_arr})[0]
                for idx_c, ctx in enumerate(missing_ctxs):
                    dec_cache[ctx] = dec_outs[idx_c]

            batch_size = len(hyps)
            batch_dec = np.stack([dec_cache[h.ys[-ctx_size:]] for h in hyps], axis=0)
            batch_enc = np.repeat(enc_out[:, t, :], batch_size, axis=0)
            logits = self._joiner.run(
                None,
                {"encoder_out": batch_enc, "decoder_out": batch_dec},
            )[0]

            # Numerically stable log_softmax
            max_logits = np.max(logits, axis=-1, keepdims=True)
            shifted = logits - max_logits
            log_probs = shifted - np.log(np.sum(np.exp(shifted), axis=-1, keepdims=True))

            merged: dict[tuple[int, ...], _BeamHyp] = {}
            ts_sec = round(t * frame_shift_out_s, 3)
            top_n = min(logits.shape[-1], k_beam + 3)

            for b_idx, h in enumerate(hyps):
                row_lp = log_probs[b_idx]
                # 1) Blank transition
                blank_lp = h.log_prob + float(row_lp[self._blank_id])
                existing_blank = merged.get(h.ys)
                if existing_blank is None:
                    merged[h.ys] = _BeamHyp(
                        ys=h.ys,
                        log_prob=blank_lp,
                        tokens=h.tokens,
                        timestamps=h.timestamps,
                        ys_log_probs=h.ys_log_probs,
                    )
                else:
                    combined = float(np.logaddexp(existing_blank.log_prob, blank_lp))
                    if blank_lp > existing_blank.log_prob:
                        merged[h.ys] = _BeamHyp(
                            ys=h.ys,
                            log_prob=combined,
                            tokens=h.tokens,
                            timestamps=h.timestamps,
                            ys_log_probs=h.ys_log_probs,
                        )
                    else:
                        existing_blank.log_prob = combined

                # 2) Top non-blank token transitions
                cand_ids = np.argpartition(row_lp, -top_n)[-top_n:]
                for raw_tid in cand_ids:
                    tid = int(raw_tid)
                    if tid in (self._blank_id, self._sos_eos_id, self._unk_id):
                        continue
                    tok_lp = float(row_lp[tid])
                    score_bonus = (
                        self._hotwords_score * 0.25 if tid in boosted_ids else 0.0
                    )
                    cand_lp = h.log_prob + tok_lp + score_bonus
                    next_ys = h.ys + (tid,)
                    tok_str = self._id_to_token.get(tid, "")
                    existing = merged.get(next_ys)
                    if existing is None:
                        merged[next_ys] = _BeamHyp(
                            ys=next_ys,
                            log_prob=cand_lp,
                            tokens=[*h.tokens, tok_str],
                            timestamps=[*h.timestamps, ts_sec],
                            ys_log_probs=[*h.ys_log_probs, tok_lp],
                        )
                    else:
                        combined = float(np.logaddexp(existing.log_prob, cand_lp))
                        if cand_lp > existing.log_prob:
                            merged[next_ys] = _BeamHyp(
                                ys=next_ys,
                                log_prob=combined,
                                tokens=[*h.tokens, tok_str],
                                timestamps=[*h.timestamps, ts_sec],
                                ys_log_probs=[*h.ys_log_probs, tok_lp],
                            )
                        else:
                            existing.log_prob = combined

            hyps = sorted(merged.values(), key=lambda item: item.log_prob, reverse=True)[
                :k_beam
            ]

        best = hyps[0]
        raw_text = "".join(best.tokens).replace("▁", " ").strip()
        stream.result = _OrtOfflineRecognitionResult(
            text=raw_text,
            tokens=best.tokens,
            timestamps=best.timestamps,
            ys_log_probs=best.ys_log_probs,
        )


class VoiceRuntimeEngine:
    def __init__(self) -> None:
        self.stt_recognizer: Any | None = None
        self.stt_backend: str = "unloaded"
        self.stt_bpe_vocab_active: bool = False
        self.stt_load_error: str | None = None
        self.tts_engine: Any | None = None
        self.tts_engine_fp32: Any | None = None
        self.tts_engine_int8: Any | None = None
        self.word_fp32_tts_engine: Any | None = None
        self.tts_load_error: str | None = None
        self.stt_semaphore = asyncio.Semaphore(2)
        self.tts_semaphore = asyncio.Semaphore(1)
        self._load_lock = asyncio.Lock()
        self._stt_load_lock = asyncio.Lock()
        self._tts_load_lock = asyncio.Lock()
        self.active_stt_jobs = 0
        self.active_tts_jobs = 0
        self.tts_waiters = 0
        self._prewarm_task: asyncio.Task[None] | None = None

    def select_tts_engine(
        self,
        *,
        word_sample: bool = False,
        is_phonics: bool = False,
        word_count: int = 0,
    ) -> tuple[Any, str]:
        wants_crisp = bool(is_phonics or word_sample or word_count <= 4)
        if TTS_PRECISION == "fp32":
            engine = self.tts_engine_fp32 or self.tts_engine
            assert engine is not None
            return engine, "fp32"
        if TTS_PRECISION == "int8":
            if wants_crisp and TTS_HYBRID_WORD_FP32 and self.word_fp32_tts_engine is not None:
                return self.word_fp32_tts_engine, "fp32"
            engine = self.tts_engine_int8 or self.tts_engine
            assert engine is not None
            return engine, "int8"
        # Hybrid mode: route short words / phonics to crisp fp32, longer passages to fast int8.
        if wants_crisp:
            if self.tts_engine_fp32 is not None:
                return self.tts_engine_fp32, "fp32"
            if self.word_fp32_tts_engine is not None:
                return self.word_fp32_tts_engine, "fp32"
        if self.tts_engine_int8 is not None:
            return self.tts_engine_int8, "int8"
        if self.tts_engine_fp32 is not None:
            return self.tts_engine_fp32, "fp32"
        assert self.tts_engine is not None
        return self.tts_engine, "fp32"

    def load_stt_sync(self) -> None:
        if self.stt_recognizer is not None:
            return
        encoder_path = SHERPA_MODEL_DIR / "encoder.int8.onnx"
        if not encoder_path.is_file():
            encoder_path = SHERPA_MODEL_DIR / "encoder.onnx"
        joiner_path = SHERPA_MODEL_DIR / "joiner.int8.onnx"
        if not joiner_path.is_file():
            joiner_path = SHERPA_MODEL_DIR / "joiner.onnx"
        decoder_path = SHERPA_MODEL_DIR / "decoder.onnx"
        if not decoder_path.is_file():
            decoder_path = SHERPA_MODEL_DIR / "decoder.int8.onnx"
        tokens_path = SHERPA_MODEL_DIR / "tokens.txt"
        if not encoder_path.is_file() or not decoder_path.is_file() or not tokens_path.is_file():
            raise RuntimeError(
                f"Missing Sherpa-ONNX Vietnamese STT model at {SHERPA_MODEL_DIR}"
            )
        t0 = time.perf_counter()
        bpe_vocab_path = _ensure_bpe_vocab(SHERPA_MODEL_DIR)
        bpe_model_path = SHERPA_MODEL_DIR / "bpe.model"

        sherpa_err: Exception | None = _sherpa_import_err
        if sherpa_onnx is not None:
            try:
                transducer_kwargs: dict[str, Any] = {
                    "encoder": str(encoder_path),
                    "decoder": str(decoder_path),
                    "joiner": str(joiner_path),
                    "tokens": str(tokens_path),
                    "num_threads": 4,
                    "sample_rate": 16000,
                    "feature_dim": 80,
                    "decoding_method": "modified_beam_search",
                    "max_active_paths": 4,
                    "blank_penalty": 0.0,
                }
                if bpe_vocab_path is not None:
                    transducer_kwargs["modeling_unit"] = "bpe"
                    transducer_kwargs["bpe_vocab"] = str(bpe_vocab_path)
                    transducer_kwargs["hotwords_score"] = 1.2
                self.stt_recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                    **transducer_kwargs
                )
                self.stt_backend = "sherpa_onnx"
                self.stt_bpe_vocab_active = bpe_vocab_path is not None
                self.stt_load_error = None
                logger.info(
                    "Loaded STT via sherpa_onnx (%s, mode=%s, bpe_vocab=%s) in %.2fs",
                    STT_MODEL_VERSION,
                    STT_MODE,
                    self.stt_bpe_vocab_active,
                    time.perf_counter() - t0,
                )
                return
            except Exception as exc:
                sherpa_err = exc
                logger.warning(
                    "sherpa_onnx native recognizer unavailable (%s); falling back to OrtZipformerOfflineRecognizer",
                    type(exc).__name__,
                )

        self.stt_recognizer = OrtZipformerOfflineRecognizer(
            encoder_path=encoder_path,
            decoder_path=decoder_path,
            joiner_path=joiner_path,
            tokens_path=tokens_path,
            bpe_model_path=bpe_model_path if bpe_model_path.is_file() else None,
            num_threads=4,
            max_active_paths=4,
            hotwords_score=1.2,
        )
        self.stt_backend = "onnxruntime_zipformer"
        self.stt_bpe_vocab_active = bpe_model_path.is_file()
        self.stt_load_error = None
        logger.info(
            "Loaded STT via onnxruntime_zipformer (%s, mode=%s, sherpa_fallback_reason=%s) in %.2fs",
            STT_MODEL_VERSION,
            STT_MODE,
            type(sherpa_err).__name__ if sherpa_err is not None else "sherpa_missing",
            time.perf_counter() - t0,
        )

    _load_stt_sync = load_stt_sync

    def load_tts_sync(self) -> None:
        if Vieneu is None:
            raise RuntimeError("Vieneu TTS runtime is not installed")
        need_fp32 = TTS_PRECISION in ("hybrid", "fp32") and self.tts_engine_fp32 is None
        need_int8 = TTS_PRECISION in ("hybrid", "int8") and self.tts_engine_int8 is None
        if need_fp32:
            t0 = time.perf_counter()
            self.tts_engine_fp32 = Vieneu(
                mode="v3turbo",
                backend="onnx",
                precision="fp32",
                threads=TTS_THREADS,
            )
            _ = self.tts_engine_fp32.infer(
                "Xin chào.",
                voice="Trúc Ly",
                temperature=0.22,
                top_k=15,
                apply_watermark=False,
            )
            logger.info(
                "Loaded TTS fp32 (threads=%d) in %.2fs",
                TTS_THREADS,
                time.perf_counter() - t0,
            )
        if need_int8:
            t0 = time.perf_counter()
            self.tts_engine_int8 = Vieneu(
                mode="v3turbo",
                backend="onnx",
                precision="int8",
                threads=TTS_THREADS,
                babble_retries=0,
            )
            _ = self.tts_engine_int8.infer(
                "Xin chào.",
                voice="Trúc Ly",
                temperature=0.22,
                top_k=15,
                apply_watermark=False,
            )
            for _chunk in self.tts_engine_int8.infer_stream(
                "Xin chào.",
                voice="Trúc Ly",
                temperature=0.22,
                top_k=15,
                apply_watermark=False,
            ):
                pass
            logger.info(
                "Loaded TTS int8 (threads=%d, babble_retries=0, stream warmed) in %.2fs",
                TTS_THREADS,
                time.perf_counter() - t0,
            )
        self.tts_engine = self.tts_engine_fp32 or self.tts_engine_int8
        self.tts_load_error = None

        if (
            TTS_HYBRID_WORD_FP32
            and TTS_PRECISION == "int8"
            and self.word_fp32_tts_engine is None
        ):
            try:
                t_fp32 = time.perf_counter()
                self.word_fp32_tts_engine = Vieneu(
                    mode="v3turbo",
                    backend="onnx",
                    precision="fp32",
                    threads=4,
                )
                logger.info(
                    "Loaded hybrid word/phonics TTS (fp32) in %.2fs",
                    time.perf_counter() - t_fp32,
                )
            except Exception as exc:
                logger.warning(
                    "hybrid_word_fp32_load_failed error_type=%s; keeping %s",
                    type(exc).__name__,
                    TTS_PRECISION,
                )
                self.word_fp32_tts_engine = None

    _load_tts_sync = load_tts_sync

    def load_models_sync(
        self, capability: Literal["tts", "stt", "all"] = "all"
    ) -> None:
        if capability in ("stt", "all") and self.stt_recognizer is None:
            try:
                self.load_stt_sync()
            except Exception as exc:
                self.stt_load_error = f"{type(exc).__name__}: {exc}"
                logger.error(
                    "stt_model_load_failed error_type=%s",
                    type(exc).__name__,
                )
                if capability == "stt":
                    raise

        if capability in ("tts", "all") and self.tts_engine is None:
            try:
                self.load_tts_sync()
            except Exception as exc:
                self.tts_load_error = f"{type(exc).__name__}: {exc}"
                logger.error(
                    "tts_model_load_failed error_type=%s",
                    type(exc).__name__,
                )
                if capability == "tts":
                    raise

    def get_tts_engine_for_mode(self, *, crisp: bool) -> tuple[Any, str]:
        if crisp and TTS_HYBRID_WORD_FP32:
            if self.word_fp32_tts_engine is not None:
                return self.word_fp32_tts_engine, "fp32"
            if TTS_PRECISION == "fp32" and self.tts_engine is not None:
                return self.tts_engine, "fp32"
        return self.tts_engine, TTS_PRECISION

    def _is_capability_ready(
        self, capability: Literal["tts", "stt", "all"] = "all"
    ) -> bool:
        if capability == "tts":
            return self.tts_engine is not None
        if capability == "stt":
            return self.stt_recognizer is not None
        return self.stt_recognizer is not None and self.tts_engine is not None

    async def ensure_stt_loaded(self) -> None:
        if "ensure_loaded" in self.__dict__:
            await self.ensure_loaded()
            return
        if self.stt_recognizer is not None:
            return
        async with self._stt_load_lock:
            if self.stt_recognizer is not None:
                return
            await asyncio.to_thread(self.load_models_sync, "stt")

    async def ensure_tts_loaded(self) -> None:
        if "ensure_loaded" in self.__dict__:
            await self.ensure_loaded()
            return
        if self.tts_engine is not None:
            return
        async with self._tts_load_lock:
            if self.tts_engine is not None:
                return
            await asyncio.to_thread(self.load_models_sync, "tts")

    async def ensure_loaded(
        self, capability: Literal["tts", "stt", "all"] = "all"
    ) -> None:
        if self._is_capability_ready(capability):
            return
        async with self._load_lock:
            if self._is_capability_ready(capability):
                return
            if "load_models_sync" in self.__dict__:
                await asyncio.to_thread(self.load_models_sync)
                return
            await asyncio.to_thread(self.load_models_sync, capability)
        if not self._is_capability_ready(capability):
            raise RuntimeError(f"{capability} runtime not ready")


_PREWARM_COACHING_PHRASES_BY_VOICE: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "local_north_truc_ly",
        (
            "Chào con, hôm nay cô trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
            "Con đọc tốt lắm.",
            "Mình cùng đọc tiếp nhé.",
            "Bây giờ con nghe câu hỏi nhé.",
            "Con trả lời đúng rồi, giỏi quá!",
            "Con chọn lại câu trả lời khác nhé.",
            "Con đọc từ trên màn hình nhé.",
        ),
    ),
    (
        "local_north_thien_minh",
        (
            "Chào con, hôm nay thầy trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
            "Con đọc tốt lắm.",
            "Mình cùng đọc tiếp nhé.",
            "Bây giờ con nghe câu hỏi nhé.",
            "Con trả lời đúng rồi, giỏi quá!",
            "Con chọn lại câu trả lời khác nhé.",
            "Con đọc từ trên màn hình nhé.",
        ),
    ),
)


async def _prewarm_coaching_phrases() -> None:
    """Pre-warm top deterministic female & male preview/coaching phrases in background when idle."""
    for voice_id, phrases in _PREWARM_COACHING_PHRASES_BY_VOICE:
        preset = VOICE_BY_ID.get(voice_id)
        if preset is None:
            continue
        for phrase in phrases:
            await asyncio.sleep(0.2)
            if runtime.tts_engine is None:
                return
            while runtime.active_tts_jobs > 0 or runtime.tts_waiters > 0:
                await asyncio.sleep(0.5)
            try:
                await runtime.tts_semaphore.acquire()
                try:
                    if runtime.tts_waiters > 0:
                        continue
                    word_count = len(WORD_TOKEN_RE.findall(phrase))
                    engine, active_prec = runtime.select_tts_engine(
                        word_sample=False, is_phonics=False, word_count=word_count
                    )
                    wav_bytes, duration_s = await asyncio.to_thread(
                        synthesize_single_utterance_sync,
                        engine,
                        phrase,
                        preset,
                        1.0,
                        False,
                        precision_override=active_prec,
                    )
                    cache_mode = "word" if word_count <= 3 else "sentence"
                    cache_key = make_cache_key(
                        voice_id=preset.voice_id,
                        speed=1.0,
                        mode=cache_mode,
                        payload=phrase,
                        precision=active_prec,
                    )
                    _mem_cache_put(cache_key, (wav_bytes, duration_s))
                finally:
                    runtime.tts_semaphore.release()
            except Exception as exc:
                logger.debug("TTS prewarm skipped: %s", type(exc).__name__)


runtime = VoiceRuntimeEngine()


async def _ensure_capability_loaded(capability: Literal["tts", "stt"]) -> None:
    try:
        if capability == "stt":
            await runtime.ensure_stt_loaded()
        else:
            await runtime.ensure_tts_loaded()
    except Exception as exc:
        logger.error("worker_model_load_failed capability=%s error_type=%s", capability, type(exc).__name__)
        code = "LOCAL_TTS_UNAVAILABLE" if capability == "tts" else "LOCAL_STT_UNAVAILABLE"
        msg = (
            "Bộ đọc giọng nói trên máy chưa sẵn sàng."
            if capability == "tts"
            else "Bộ nhận diện giọng nói trên máy chưa sẵn sàng."
        )
        raise HTTPException(
            status_code=503,
            detail={"code": code, "message": msg},
        ) from None
app = FastAPI(title="ViRead Local Voice Worker", version=WORKER_VERSION)


def _expected_voice_token() -> str:
    return os.environ.get("VIREAD_VOICE_WORKER_TOKEN", "").strip()


async def require_voice_worker_token(
    x_viread_voice_token: str | None = Header(default=None, alias="X-ViRead-Voice-Token"),
) -> None:
    expected = _expected_voice_token()
    if not expected:
        return
    provided = (x_viread_voice_token or "").strip()
    if not provided or not hmac.compare_digest(
        provided.encode("utf-8"), expected.encode("utf-8")
    ):
        logger.warning("voice_auth_rejected")
        raise HTTPException(
            status_code=401,
            detail={
                "code": "VOICE_WORKER_UNAUTHORIZED",
                "message": "Không được phép truy cập dịch vụ giọng nói.",
            },
        )


@app.middleware("http")
async def _request_context_middleware(request: Request, call_next):
    req_id = _sanitize_request_id(request.headers.get("X-Request-ID"))
    token = _request_id_ctx.set(req_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = req_id
        if request.url.path != "/health":
            logger.info(
                "http_done method=%s path=%s status=%d ms=%.1f",
                request.method,
                request.url.path,
                response.status_code,
                (time.perf_counter() - started) * 1000.0,
            )
        return response
    except Exception:
        logger.warning(
            "http_unhandled method=%s path=%s ms=%.1f",
            request.method,
            request.url.path,
            (time.perf_counter() - started) * 1000.0,
        )
        raise
    finally:
        _request_id_ctx.reset(token)


@app.on_event("startup")
async def _startup() -> None:
    eager = os.environ.get("VIREAD_VOICE_EAGER_LOAD", "1").strip() != "0"
    if eager:
        await runtime.ensure_loaded()
        if os.environ.get("VIREAD_VOICE_PREWARM", "1").strip() != "0":
            runtime._prewarm_task = asyncio.create_task(_prewarm_coaching_phrases())


def resolve_strict_voice(voice_id: str) -> LocalVoicePreset:
    normalized = (voice_id or "").strip()
    if not normalized:
        normalized = DEFAULT_VOICE_ID
    preset = VOICE_BY_ID.get(normalized)
    if preset is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "VOICE_NOT_FOUND",
                "message": f"Giọng đọc '{normalized}' không tồn tại trên máy này.",
            },
        )
    return preset


def normalize_nfc_text(text: str) -> str:
    cleaned = unicodedata.normalize("NFC", text).strip()
    if not cleaned:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "TTS_EMPTY_TEXT",
                "message": "Nội dung đọc mẫu đang trống.",
            },
        )
    return cleaned


def normalize_speed(speed: float) -> float:
    return round(min(1.3, max(0.7, float(speed))), 2)


def make_cache_key(
    *,
    voice_id: str,
    speed: float,
    mode: str,
    payload: str,
    precision: str = TTS_PRECISION,
    model_version: str = TTS_MODEL_VERSION,
) -> str:
    canonical = json.dumps(
        {
            "provider": "local",
            "voice_id": voice_id,
            "model_version": model_version,
            "precision": precision,
            "norm_v": 8,
            "speed": normalize_speed(speed),
            "mode": mode,
            "payload": unicodedata.normalize("NFC", payload),
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_BASE_WAV_CACHE_MAX_ENTRIES = 64
_BASE_WAV_CACHE: OrderedDict[str, tuple[np.ndarray, int]] = OrderedDict()
_BASE_WAV_CACHE_LOCK = threading.Lock()


def _base_wav_cache_get(key: str) -> tuple[np.ndarray, int] | None:
    with _BASE_WAV_CACHE_LOCK:
        hit = _BASE_WAV_CACHE.get(key)
        if hit is not None:
            _BASE_WAV_CACHE.move_to_end(key)
        return hit


def _base_wav_cache_put(key: str, wav: np.ndarray, sr: int) -> None:
    with _BASE_WAV_CACHE_LOCK:
        _BASE_WAV_CACHE[key] = (wav.astype(np.float32, copy=True), int(sr))
        _BASE_WAV_CACHE.move_to_end(key)
        while len(_BASE_WAV_CACHE) > _BASE_WAV_CACHE_MAX_ENTRIES:
            _BASE_WAV_CACHE.popitem(last=False)


def clear_base_wav_cache() -> None:
    with _BASE_WAV_CACHE_LOCK:
        _BASE_WAV_CACHE.clear()


def apply_speed_preserve_pitch(wav: np.ndarray, speed: float) -> np.ndarray:
    """Deterministically scale waveform duration inversely with speed (monotonic across 0.70..1.30)."""
    spd = normalize_speed(speed)
    arr = np.asarray(wav, dtype=np.float32)
    if arr.size == 0 or abs(spd - 1.0) < 0.01:
        return arr.astype(np.float32, copy=False)
    target_len = max(1, int(round(arr.size / spd)))
    if librosa is not None:
        stretched = librosa.effects.time_stretch(arr, rate=spd)
        if stretched.size != target_len:
            stretched = scipy_signal.resample(stretched, target_len).astype(np.float32)
    else:
        stretched = scipy_signal.resample(arr, target_len).astype(np.float32)
    return np.clip(stretched, -1.0, 1.0).astype(np.float32)


def pad_edges(
    wav: np.ndarray,
    sr: int,
    lead_ms: int = 80,
    tail_ms: int = 180,
) -> np.ndarray:
    lead = np.zeros(int(sr * lead_ms / 1000.0), dtype=np.float32)
    tail = np.zeros(int(sr * tail_ms / 1000.0), dtype=np.float32)
    return np.concatenate([lead, wav.astype(np.float32), tail])


def encode_wav_bytes(wav: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    if sf is not None:
        sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    pcm16 = (np.clip(np.asarray(wav, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sr))
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Atomically write bytes via sibling temp file + os.replace so readers never see partial files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{time.time_ns()}.tmp"
    )
    try:
        with open(tmp_path, "wb") as fh:
            fh.write(data)
            fh.flush()
        os.replace(tmp_path, path)
    except BaseException:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _atomic_write_bytes(path, encoded)


def _read_disk_cache_entry(
    wav_cache: Path, meta_cache: Path
) -> tuple[bytes, dict[str, Any]] | None:
    """Safely load a cached (wav, meta) pair; discard and recompute if truncated or corrupted."""
    if not (wav_cache.is_file() and meta_cache.is_file()):
        return None
    try:
        meta = json.loads(meta_cache.read_text(encoding="utf-8"))
        if not isinstance(meta, dict) or "duration_seconds" not in meta:
            raise ValueError("Invalid cache metadata schema")
        dur = float(meta["duration_seconds"])
        if dur <= 0:
            raise ValueError("Non-positive duration_seconds")
        wav_bytes = wav_cache.read_bytes()
        if len(wav_bytes) < 44 or wav_bytes[:4] != b"RIFF":
            raise ValueError("Truncated or invalid WAV cache entry")
        _touch_cache_files(wav_cache, meta_cache)
        return wav_bytes, meta
    except Exception as exc:
        logger.warning(
            "Discarding corrupt TTS disk cache entry %s (%s)",
            wav_cache.name,
            type(exc).__name__,
        )
        for p in (wav_cache, meta_cache):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
        return None


def _detect_chunk_speech_bounds(wav: np.ndarray, sr: int) -> tuple[float, float]:
    """Return active (speech_start_s, speech_end_s) within a synthesized chunk using frame RMS."""
    arr = np.asarray(wav, dtype=np.float32)
    total_s = float(arr.size / max(1, sr))
    if arr.size < max(1, int(sr * 0.04)):
        return 0.0, total_s
    frame_len = max(1, int(sr * 0.01))
    n_frames = arr.size // frame_len
    if n_frames <= 1:
        return 0.0, total_s
    frames = arr[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    peak_rms = float(np.max(rms))
    if peak_rms < 1e-4:
        return 0.0, total_s
    thresh = max(0.003, peak_rms * 0.08)
    active = np.flatnonzero(rms >= thresh)
    if active.size == 0:
        return 0.0, total_s
    start_s = max(0.0, (int(active[0]) * frame_len) / float(sr))
    end_s = min(total_s, ((int(active[-1]) + 1) * frame_len) / float(sr))
    if end_s - start_s < 0.02:
        return 0.0, total_s
    return start_s, end_s


_AUDIO_FORMAT_ALIAS_TO_MIME = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
}


def resolve_preferred_audio_media_type(
    accept_header: str | None = None,
    audio_format: str | None = None,
) -> str:
    """Resolve desired TTS output MIME from Accept header (priority) or body audio_format."""
    if isinstance(accept_header, str) and accept_header.strip():
        candidates: list[tuple[float, int, str]] = []
        for idx, part in enumerate(accept_header.split(",")):
            raw_item = part.strip()
            if not raw_item:
                continue
            pieces = [seg.strip() for seg in raw_item.split(";")]
            mime = pieces[0].lower()
            q = 1.0
            for param in pieces[1:]:
                if param.startswith("q="):
                    try:
                        q = float(param[2:])
                    except ValueError:
                        q = 0.0
            if q <= 0:
                continue
            if mime in ("audio/mpeg", "audio/mp3"):
                candidates.append((q, -idx, "audio/mpeg"))
            elif mime in ("audio/ogg", "audio/opus"):
                candidates.append((q, -idx, "audio/ogg"))
            elif mime in ("audio/wav", "audio/x-wav", "audio/wave"):
                candidates.append((q, -idx, "audio/wav"))
        if candidates:
            candidates.sort(reverse=True)
            return candidates[0][2]

    if isinstance(audio_format, str):
        mapped = _AUDIO_FORMAT_ALIAS_TO_MIME.get(audio_format.strip().lower())
        if mapped:
            return mapped
    return "audio/wav"


def _encode_via_pyav(wav: np.ndarray, sr: int, *, fmt: str, codecs: tuple[str, ...], target_sr: int | None = None) -> bytes:
    arr = np.asarray(wav, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=1)
    if arr.size == 0:
        raise ValueError("Empty PCM buffer")
    out_sr = target_sr or sr
    if out_sr != sr:
        arr = librosa.resample(arr, orig_sr=sr, target_sr=out_sr).astype(np.float32)
    arr = np.clip(arr, -1.0, 1.0).astype(np.float32)
    pcm_2d = arr.reshape(1, -1)

    last_exc: Exception | None = None
    for codec_name in codecs:
        buf = io.BytesIO()
        container = None
        try:
            container = av.open(buf, mode="w", format=fmt)
            stream = container.add_stream(codec_name, rate=out_sr, layout="mono")
            resampler = av.AudioResampler(
                format=stream.format.name,
                layout="mono",
                rate=out_sr,
            )
            frame_size = int(getattr(stream, "frame_size", 0) or 1024)
            for offset in range(0, pcm_2d.shape[1], frame_size):
                chunk = pcm_2d[:, offset : offset + frame_size]
                frame = av.AudioFrame.from_ndarray(chunk, format="fltp", layout="mono")
                frame.rate = out_sr
                for resampled in resampler.resample(frame):
                    for packet in stream.encode(resampled):
                        container.mux(packet)
            for resampled in resampler.resample(None):
                for packet in stream.encode(resampled):
                    container.mux(packet)
            for packet in stream.encode(None):
                container.mux(packet)
            container.close()
            container = None
            encoded = buf.getvalue()
            if encoded:
                return encoded
        except Exception as exc:
            last_exc = exc
        finally:
            if container is not None:
                try:
                    container.close()
                except Exception:
                    pass
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"Failed to encode {fmt}")


def encode_audio_bytes_for_media_type(
    wav_bytes: bytes,
    preferred_media_type: str,
) -> tuple[bytes, str]:
    """Transcode cached WAV bytes to audio/mpeg or audio/ogg with safe WAV fallback."""
    if preferred_media_type not in ("audio/mpeg", "audio/ogg"):
        return wav_bytes, "audio/wav"
    try:
        arr, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
        sr_int = int(sr)
        if preferred_media_type == "audio/mpeg":
            encoded = _encode_via_pyav(
                np.asarray(arr, dtype=np.float32),
                sr_int,
                fmt="mp3",
                codecs=("libmp3lame", "mp3"),
            )
            return encoded, "audio/mpeg"

        try:
            encoded = _encode_via_pyav(
                np.asarray(arr, dtype=np.float32),
                sr_int,
                fmt="ogg",
                codecs=("libopus",),
                target_sr=48000,
            )
            return encoded, "audio/ogg"
        except Exception:
            try:
                encoded = _encode_via_pyav(
                    np.asarray(arr, dtype=np.float32),
                    sr_int,
                    fmt="ogg",
                    codecs=("libvorbis",),
                )
                return encoded, "audio/ogg"
            except Exception:
                ogg_buf = io.BytesIO()
                sf.write(ogg_buf, arr, sr_int, format="OGG", subtype="VORBIS")
                return ogg_buf.getvalue(), "audio/ogg"
    except Exception as exc:
        logger.warning(
            "tts_audio_transcode_fallback_wav target=%s error_type=%s",
            preferred_media_type,
            type(exc).__name__,
        )
        return wav_bytes, "audio/wav"


def _sniff_magic_audio_format(raw_bytes: bytes) -> str | None:
    if raw_bytes.startswith(b"RIFF") and raw_bytes[8:12] == b"WAVE":
        return "wav"
    if raw_bytes.startswith(b"fLaC"):
        return "flac"
    if raw_bytes.startswith(b"\x1a\x45\xdf\xa3"):
        return "webm"
    if raw_bytes.startswith(b"OggS"):
        return "ogg_opus" if b"OpusHead" in raw_bytes[:96] else "ogg"
    if len(raw_bytes) >= 12 and raw_bytes[4:8] == b"ftyp":
        return "mp4"
    if raw_bytes.startswith(b"ID3") or (
        len(raw_bytes) >= 2 and raw_bytes[0] == 0xFF and (raw_bytes[1] & 0xE0) == 0xE0
    ):
        return "mp3"
    return None


def _guess_av_format_hints(
    raw_bytes: bytes,
    *,
    filename: str = "",
    content_type: str = "",
) -> list[str | None]:
    candidates: list[str] = []
    magic = _sniff_magic_audio_format(raw_bytes)
    if magic == "wav":
        candidates.append("wav")
    elif magic == "flac":
        candidates.append("flac")
    elif magic in ("ogg", "ogg_opus"):
        candidates.append("ogg")
    elif magic == "webm":
        candidates.extend(["webm", "matroska"])
    elif magic == "mp4":
        candidates.extend(["mp4", "mov"])
    elif magic == "mp3":
        candidates.append("mp3")

    lower_name = (filename or "").lower()
    lower_ct = (content_type or "").lower()
    ext_map = (
        (".webm", "webm"),
        (".ogg", "ogg"),
        (".oga", "ogg"),
        (".mp4", "mp4"),
        (".m4a", "mp4"),
        (".aac", "aac"),
        (".wav", "wav"),
        (".mp3", "mp3"),
        (".flac", "flac"),
    )
    for ext, fmt in ext_map:
        if lower_name.endswith(ext) or ext.lstrip(".") in lower_ct:
            candidates.append(fmt)

    hints: list[str | None] = []
    for c in candidates:
        if c not in hints:
            hints.append(c)
    # Keep auto-probe (None) as fallback after explicit magic/extension hints.
    hints.append(None)
    return hints


def decode_audio_bytes_to_16k_mono(
    raw_bytes: bytes,
    *,
    filename: str = "",
    content_type: str = "",
) -> tuple[np.ndarray, float]:
    if not raw_bytes:
        raise ValueError("Empty audio file")

    magic = _sniff_magic_audio_format(raw_bytes)
    # Fast path for WAV / FLAC / non-Opus OGG supported by libsndfile.
    # Skip doomed sf.read() attempts on browser WebM/Opus, MP4/M4A, MP3, and Ogg Opus containers.
    try_sndfile = magic in ("wav", "flac", "ogg") or (
        magic is None
        and not any(
            marker in (filename or "").lower() or marker in (content_type or "").lower()
            for marker in ("webm", "opus", "mp4", "m4a", "aac", "mp3", "mpeg")
        )
    )
    if try_sndfile:
        try:
            wav, sr = sf.read(io.BytesIO(raw_bytes), dtype="float32", always_2d=False)
            arr = np.asarray(wav, dtype=np.float32)
            if arr.ndim > 1:
                arr = arr.mean(axis=1)
            if arr.size > 0 and sr > 0:
                arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
                if sr != 16000:
                    arr = librosa.resample(arr, orig_sr=sr, target_sr=16000)
                arr = np.clip(arr, -1.0, 1.0).astype(np.float32)
                return arr, float(len(arr) / 16000.0)
        except Exception:
            pass

    # Container path (.webm / .ogg Opus / .mp4 / .m4a / .aac / .mp3 / .wav) via PyAV
    last_exc: Exception | None = None
    for fmt_hint in _guess_av_format_hints(
        raw_bytes, filename=filename, content_type=content_type
    ):
        container = None
        try:
            open_kwargs: dict[str, Any] = {"mode": "r"}
            if fmt_hint is not None:
                open_kwargs["format"] = fmt_hint
            container = av.open(io.BytesIO(raw_bytes), **open_kwargs)
            audio_streams = [s for s in container.streams if s.type == "audio"]
            if not audio_streams:
                raise ValueError("No audio stream found")
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
            chunks: list[np.ndarray] = []
            try:
                for frame in container.decode(audio_streams[0]):
                    for out_frame in resampler.resample(frame):
                        plane = out_frame.to_ndarray()
                        mono = plane[0] if plane.ndim > 1 else plane
                        if mono.size > 0:
                            chunks.append(np.asarray(mono, dtype=np.float32))
            except (av.error.EOFError, av.error.InvalidDataError) as decode_err:
                if not chunks:
                    raise decode_err
            try:
                for out_frame in resampler.resample(None):
                    plane = out_frame.to_ndarray()
                    mono = plane[0] if plane.ndim > 1 else plane
                    if mono.size > 0:
                        chunks.append(np.asarray(mono, dtype=np.float32))
            except Exception:
                pass
            if not chunks:
                return np.zeros(0, dtype=np.float32), 0.0
            merged = np.concatenate(chunks).astype(np.float32)
            merged = np.nan_to_num(merged, nan=0.0, posinf=0.0, neginf=0.0)
            merged = np.clip(merged, -1.0, 1.0).astype(np.float32)
            return merged, float(len(merged) / 16000.0)
        except Exception as exc:
            last_exc = exc
        finally:
            if container is not None:
                try:
                    container.close()
                except Exception:
                    pass

    assert last_exc is not None
    raise last_exc


def _estimate_word_end_seconds(
    cur_start: float,
    cur_last_tok: float,
    next_start: float | None,
    duration_s: float,
    audio_16k: np.ndarray | None = None,
) -> float:
    """Bound word end by actual speech energy/duration rather than stretching across pauses."""
    upper_bound = duration_s
    if next_start is not None:
        upper_bound = min(upper_bound, max(cur_start + 0.04, next_start))
    min_end = min(upper_bound, max(cur_start + 0.04, cur_last_tok + 0.04))

    if audio_16k is not None and audio_16k.size >= 160:
        search_start = max(0, int(cur_last_tok * 16000))
        search_limit = min(
            audio_16k.size,
            int(min(upper_bound, cur_last_tok + 0.42) * 16000),
        )
        if search_limit - search_start >= 160:
            win = audio_16k[search_start:search_limit]
            n_frames = win.size // 160
            if n_frames > 0:
                frames = win[: n_frames * 160].reshape(n_frames, 160)
                rms = np.sqrt(np.mean(frames * frames, axis=1))
                peak_rms = float(np.max(rms))
                thresh = max(0.004, peak_rms * 0.14)
                active_idxs = np.flatnonzero(rms >= thresh)
                if active_idxs.size > 0:
                    last_active_s = (
                        search_start + (int(active_idxs[-1]) + 1) * 160
                    ) / 16000.0 + 0.03
                    return round(max(min_end, min(upper_bound, last_active_s)), 3)

    # Without audio or when quiet, cap trailing syllable tail to ~0.18s (never across comma pauses).
    heuristic_end = max(cur_last_tok + 0.18, cur_start + 0.22)
    return round(max(min_end, min(upper_bound, heuristic_end)), 3)


def build_stt_words_from_sherpa(
    tokens: list[str],
    timestamps: list[float],
    duration_s: float,
    *,
    audio_16k: np.ndarray | None = None,
    ys_log_probs: list[float] | tuple[float, ...] | None = None,
) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    cur_text = ""
    cur_start: float | None = None
    cur_last_tok: float = 0.0
    cur_logprobs: list[float] = []

    def _safe_word_logprob(logprobs: list[float]) -> float | None:
        if not logprobs:
            return None
        return round(sum(logprobs), 4)

    for idx, raw_tok in enumerate(tokens):
        ts = float(timestamps[idx]) if idx < len(timestamps) else cur_last_tok
        tok_lp: float | None = None
        if ys_log_probs is not None and idx < len(ys_log_probs):
            raw_lp = ys_log_probs[idx]
            if isinstance(raw_lp, (int, float)) and not isinstance(raw_lp, bool):
                lp_val = float(raw_lp)
                if math.isfinite(lp_val):
                    tok_lp = lp_val
        starts_new = raw_tok.startswith(" ") or raw_tok.startswith("▁")
        piece = raw_tok.replace("▁", " ").strip()
        if not piece:
            continue
        if starts_new and cur_text:
            w_start = max(0.0, cur_start or 0.0)
            w_end = _estimate_word_end_seconds(
                w_start, cur_last_tok, ts, duration_s, audio_16k
            )
            words.append(
                {
                    "text": unicodedata.normalize("NFC", cur_text.lower()),
                    "start": round(w_start, 3),
                    "end": round(max(w_start + 0.04, w_end), 3),
                    "type": "word",
                    "logprob": _safe_word_logprob(cur_logprobs),
                }
            )
            cur_text = piece
            cur_start = ts
            cur_last_tok = ts
            cur_logprobs = [tok_lp] if tok_lp is not None else []
        else:
            if cur_start is None:
                cur_start = ts
            cur_text += piece
            cur_last_tok = max(cur_last_tok, ts)
            if tok_lp is not None:
                cur_logprobs.append(tok_lp)

    if cur_text:
        w_start = max(0.0, cur_start or 0.0)
        w_end = _estimate_word_end_seconds(
            w_start, cur_last_tok, None, duration_s, audio_16k
        )
        words.append(
            {
                "text": unicodedata.normalize("NFC", cur_text.lower()),
                "start": round(w_start, 3),
                "end": round(max(w_start, w_end), 3),
                "type": "word",
                "logprob": _safe_word_logprob(cur_logprobs),
            }
        )
    return words


_STT_CHECK_TOKEN_RE = re.compile(r"[0-9A-Za-zÀ-ỹĐđ]+", re.UNICODE)
_CHOICE_LETTER_ACCEPT_STT: dict[str, set[str]] = {
    "a": {"a", "à", "á", "ạ"},
    "bê": {"bê", "b", "be", "bề", "bể"},
    "xê": {"xê", "c", "xe", "sê", "se"},
    "đê": {"đê", "d", "đ", "de", "dê"},
}


def _tokenize_stt_check(text: str) -> list[str]:
    return _STT_CHECK_TOKEN_RE.findall(unicodedata.normalize("NFC", text or "").lower())


def _check_tts_audio_quality(
    wav_float32: np.ndarray,
    sr: int,
    expected_spoken: str,
    *,
    is_short_word: bool,
    event_loop: asyncio.AbstractEventLoop | None = None,
) -> tuple[bool, str, str]:
    """Fast local Sherpa STT self-check to catch trailing hallucinations, stutters, or swallowed choice labels."""
    if runtime.stt_recognizer is None or wav_float32.size < 400:
        return True, "skipped", ""
    # Never steal CPU or stt_semaphore from active child STT requests.
    if runtime.active_stt_jobs > 0 or runtime.stt_semaphore.locked():
        return True, "stt_busy_skipped", ""
    expected_tokens = _tokenize_stt_check(expected_spoken)
    if not expected_tokens:
        return True, "empty_expected", ""

    if sr != 16000:
        if librosa is not None:
            samples16 = librosa.resample(
                wav_float32.astype(np.float32), orig_sr=sr, target_sr=16000
            )
        else:
            target_n = max(1, int(round(wav_float32.size * 16000.0 / float(sr))))
            samples16 = scipy_signal.resample(wav_float32.astype(np.float32), target_n).astype(
                np.float32
            )
    else:
        samples16 = wav_float32.astype(np.float32, copy=False)

    acquired_async_sem = False
    if event_loop is not None and event_loop.is_running():
        handoff_lock = threading.Lock()
        abandoned = threading.Event()
        permit_held = False

        async def _try_acquire_idle_stt() -> bool:
            nonlocal permit_held
            if abandoned.is_set() or runtime.active_stt_jobs > 0 or runtime.stt_semaphore.locked():
                return False
            try:
                await asyncio.wait_for(runtime.stt_semaphore.acquire(), timeout=0.01)
            except (asyncio.TimeoutError, TimeoutError, asyncio.CancelledError):
                return False
            with handoff_lock:
                if abandoned.is_set() or runtime.active_stt_jobs > 0:
                    runtime.stt_semaphore.release()
                    return False
                permit_held = True
                return True

        fut = None
        try:
            fut = asyncio.run_coroutine_threadsafe(_try_acquire_idle_stt(), event_loop)
            acquired_async_sem = bool(fut.result(timeout=0.1))
        except Exception:
            should_release = False
            with handoff_lock:
                abandoned.set()
                if permit_held:
                    permit_held = False
                    should_release = True
            if fut is not None:
                fut.cancel()
            if should_release:
                event_loop.call_soon_threadsafe(runtime.stt_semaphore.release)
            return True, "stt_busy_skipped", ""
        if not acquired_async_sem:
            return True, "stt_busy_skipped", ""
    try:
        stt_text, _words, _ms = decode_stt_window_sync(
            samples16,
            lead_pad_s=0.25,
            trail_pad_s=0.35,
        )
    finally:
        if acquired_async_sem and event_loop is not None:
            event_loop.call_soon_threadsafe(runtime.stt_semaphore.release)

    stt_tokens = _tokenize_stt_check(stt_text)
    if not stt_tokens:
        return False, "empty_stt", stt_text

    max_extra = 0 if is_short_word or len(expected_tokens) <= 5 else 1
    if len(stt_tokens) > len(expected_tokens) + max_extra:
        return False, f"extra_words:{len(stt_tokens)}>{len(expected_tokens)}", stt_text

    expected_adjacent_dups = sum(
        1 for i in range(1, len(expected_tokens)) if expected_tokens[i] == expected_tokens[i - 1]
    )
    stt_adjacent_dups = sum(
        1 for i in range(1, len(stt_tokens)) if stt_tokens[i] == stt_tokens[i - 1]
    )
    if stt_adjacent_dups > expected_adjacent_dups:
        return False, "adjacent_repeat_stutter", stt_text
    for i in range(1, len(stt_tokens)):
        prev_t, cur_t = stt_tokens[i - 1], stt_tokens[i]
        if (
            len(prev_t) >= 2
            and len(cur_t) > len(prev_t)
            and cur_t.startswith(prev_t)
            and prev_t not in expected_tokens
        ):
            return False, f"prefix_stutter:{prev_t}->{cur_t}", stt_text

    if len(expected_tokens) >= 3 and expected_tokens[0] == "đáp" and expected_tokens[1] == "án":
        label_tok = expected_tokens[2]
        accepted = _CHOICE_LETTER_ACCEPT_STT.get(label_tok)
        if accepted and not any(tok in accepted for tok in stt_tokens[:5]):
            return False, f"missing_choice_label:{label_tok}", stt_text

    return True, "ok", stt_text


def synthesize_single_utterance_sync(
    tts_engine: Any,
    text_nfc: str,
    preset: LocalVoicePreset,
    speed: float,
    word_sample: bool,
    *,
    precision_override: str | None = None,
    event_loop: asyncio.AbstractEventLoop | None = None,
) -> tuple[bytes, float]:
    syllable_estimate = len(text_nfc.split())
    use_crisp_temp = word_sample or syllable_estimate <= 3
    temp = 0.22 if use_crisp_temp else 0.55
    top_k = 15 if use_crisp_temp else 25

    cache_mode = "word" if use_crisp_temp else "sentence"
    precision = precision_override or TTS_PRECISION
    norm_speed = normalize_speed(speed)
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=norm_speed,
        mode=cache_mode,
        payload=text_nfc,
        precision=precision,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    disk_hit = _read_disk_cache_entry(wav_cache, meta_cache)
    if disk_hit is not None:
        cached_wav, meta = disk_hit
        return cached_wav, float(meta["duration_seconds"])

    sr = int(tts_engine.sample_rate)
    base_key = make_cache_key(
        voice_id=preset.voice_id,
        speed=1.0,
        mode=f"{cache_mode}_base",
        payload=text_nfc,
        precision=precision,
    )
    quiz_choice_match = _QUIZ_CHOICE_LABEL_RE.match(text_nfc)
    is_quiz_choice = bool(quiz_choice_match)
    base_hit = _base_wav_cache_get(base_key)
    if base_hit is not None:
        base_wav, sr = base_hit
    else:
        normalized_text = (
            normalize_vietnamese_tts_text(text_nfc, expand_ranges_and_codes=True)
            or text_nfc
        )
        spoken_input = ensure_tts_terminal_punctuation(normalized_text)
        should_guard = word_sample or syllable_estimate <= 8 or is_quiz_choice

        def _infer_base_once(
            cand_text: str, cand_temp: float, cand_top_k: int, attempt_idx: int = 0
        ) -> np.ndarray:
            if quiz_choice_match:
                prefix_word = quiz_choice_match.group(1)
                letter = quiz_choice_match.group(2)
                spoken_letter = _CHOICE_LETTER_SPOKEN.get(letter.upper(), letter.lower())
                label_body = text_nfc[quiz_choice_match.end() :].strip()
                norm_body = (
                    normalize_vietnamese_tts_text(label_body, expand_ranges_and_codes=True)
                    or label_body
                )
                body_core = norm_body.rstrip(".!?").strip() if norm_body else ""
                if attempt_idx == 0:
                    prefix_text = f"{prefix_word} {spoken_letter}."
                    body_text = ensure_tts_terminal_punctuation(norm_body)
                    gap_s = 0.36
                elif attempt_idx == 1:
                    prefix_text = f"{prefix_word} {spoken_letter}!"
                    body_text = f"{body_core}!" if body_core else norm_body
                    gap_s = 0.42
                else:
                    prefix_text = f"{prefix_word}, {spoken_letter}."
                    body_text = body_core or norm_body
                    gap_s = 0.45
                wav_prefix = np.asarray(
                    tts_engine.infer(
                        prefix_text,
                        voice=preset.preset_name,
                        temperature=cand_temp,
                        top_k=cand_top_k,
                        apply_watermark=False,
                    ),
                    dtype=np.float32,
                )
                wav_body = np.asarray(
                    tts_engine.infer(
                        body_text,
                        voice=preset.preset_name,
                        temperature=cand_temp,
                        top_k=cand_top_k,
                        apply_watermark=False,
                    ),
                    dtype=np.float32,
                )
                gap = np.zeros(int(sr * gap_s), dtype=np.float32)
                return np.concatenate([wav_prefix, gap, wav_body]).astype(np.float32)

            if len(cand_text) > 140:
                clauses, gaps = normalize_to_chunks_v3_with_gaps(cand_text, max_chars=140)
                if not clauses:
                    clauses, gaps = [cand_text], []
                silence_secs = gaps_to_silence(gaps) if gaps else []
                parts: list[np.ndarray] = []
                for c_idx, clause in enumerate(clauses):
                    raw_clause = np.asarray(
                        tts_engine.infer(
                            ensure_tts_terminal_punctuation(clause),
                            voice=preset.preset_name,
                            temperature=cand_temp,
                            top_k=cand_top_k,
                            apply_watermark=False,
                        ),
                        dtype=np.float32,
                    )
                    parts.append(raw_clause)
                    if c_idx < len(silence_secs):
                        gap_s = max(0.14, float(silence_secs[c_idx]))
                        parts.append(np.zeros(int(sr * gap_s), dtype=np.float32))
                return np.concatenate(parts).astype(np.float32)

            return np.asarray(
                tts_engine.infer(
                    cand_text,
                    voice=preset.preset_name,
                    temperature=cand_temp,
                    top_k=cand_top_k,
                    apply_watermark=False,
                ),
                dtype=np.float32,
            )

        attempt_specs = (
            [(spoken_input, temp, top_k), (spoken_input, 0.16, 10), (spoken_input, 0.12, 8)]
            if should_guard
            else [(spoken_input, temp, top_k)]
        )
        base_wav = np.zeros(0, dtype=np.float32)
        for attempt_idx, (cand_text, cand_temp, cand_top_k) in enumerate(attempt_specs):
            cand_wav = _infer_base_once(cand_text, cand_temp, cand_top_k, attempt_idx=attempt_idx)
            base_wav = cand_wav
            if not should_guard or attempt_idx == len(attempt_specs) - 1:
                break
            ok, reason, _stt = _check_tts_audio_quality(
                cand_wav,
                sr,
                normalized_text,
                is_short_word=bool(word_sample or syllable_estimate <= 3),
                event_loop=event_loop,
            )
            if ok:
                break
            logger.info(
                "tts_quality_retry attempt=%d reason=%s voice=%s",
                attempt_idx + 1,
                reason,
                preset.voice_id,
            )
        _base_wav_cache_put(base_key, base_wav, sr)

    stretched = apply_speed_preserve_pitch(base_wav, norm_speed)
    padded = pad_edges(
        stretched,
        sr,
        lead_ms=90 if (use_crisp_temp or is_quiz_choice) else 70,
        tail_ms=220 if (use_crisp_temp or is_quiz_choice) else 160,
    )
    duration_s = round(float(len(padded) / sr), 3)
    wav_bytes = encode_wav_bytes(padded, sr)

    _atomic_write_bytes(wav_cache, wav_bytes)
    _atomic_write_json(meta_cache, {"duration_seconds": duration_s})
    prune_tts_cache_dir()
    return wav_bytes, duration_s


def synthesize_timed_passage_sync(
    tts_engine: Any,
    text_nfc: str,
    preset: LocalVoicePreset,
    speed: float,
    *,
    precision_override: str | None = None,
    preferred_media_type: str = "audio/wav",
) -> dict[str, Any]:
    precision = precision_override or TTS_PRECISION
    norm_speed = normalize_speed(speed)
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=norm_speed,
        mode="timed_passage",
        payload=text_nfc,
        precision=precision,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    disk_hit = _read_disk_cache_entry(wav_cache, meta_cache)
    if disk_hit is not None:
        cached_wav, meta = disk_hit
        out_bytes, out_media_type = encode_audio_bytes_for_media_type(
            cached_wav, preferred_media_type
        )
        return {
            "audio_base64": base64.b64encode(out_bytes).decode("ascii"),
            "media_type": out_media_type,
            "provider": "local",
            "voice_id": preset.voice_id,
            "region": preset.region,
            "model_version": TTS_MODEL_VERSION,
            "speed": norm_speed,
            "duration_seconds": float(meta["duration_seconds"]),
            "words": meta["words"],
        }

    sr = int(tts_engine.sample_rate)
    spoken_passage = (
        normalize_vietnamese_tts_text(text_nfc, expand_ranges_and_codes=True)
        or text_nfc
    )
    chunks, gaps = normalize_to_chunks_v3_with_gaps(spoken_passage, max_chars=220)
    if not chunks:
        chunks = [spoken_passage]
        gaps = []

    silence_secs = gaps_to_silence(gaps) if gaps else []
    lead_samples = int(sr * 0.07)
    tail_samples = int(sr * 0.16)

    assembled: list[np.ndarray] = [np.zeros(lead_samples, dtype=np.float32)]
    cursor_samples = lead_samples
    chunk_spans: list[tuple[str, float, float]] = []

    for idx, chunk_text in enumerate(chunks):
        chunk_base_key = make_cache_key(
            voice_id=preset.voice_id,
            speed=1.0,
            mode="timed_chunk_base",
            payload=chunk_text,
            precision=precision,
        )
        base_hit = _base_wav_cache_get(chunk_base_key)
        if base_hit is not None:
            raw_chunk, _ = base_hit
        else:
            raw_chunk = np.asarray(
                tts_engine.infer(
                    ensure_tts_terminal_punctuation(chunk_text),
                    voice=preset.preset_name,
                    temperature=0.52,
                    top_k=22,
                    apply_watermark=False,
                ),
                dtype=np.float32,
            )
            _base_wav_cache_put(chunk_base_key, raw_chunk, sr)

        stretched = apply_speed_preserve_pitch(raw_chunk, norm_speed)
        rel_start_s, rel_end_s = _detect_chunk_speech_bounds(stretched, sr)
        chunk_offset_s = cursor_samples / float(sr)
        start_s = chunk_offset_s + rel_start_s
        end_s = chunk_offset_s + rel_end_s
        chunk_spans.append((chunk_text, start_s, end_s))
        assembled.append(stretched)
        cursor_samples += len(stretched)

        if idx < len(silence_secs):
            gap_s = max(0.12, float(silence_secs[idx]) / max(norm_speed, 0.7))
            gap_samples = int(sr * gap_s)
            assembled.append(np.zeros(gap_samples, dtype=np.float32))
            cursor_samples += gap_samples

    assembled.append(np.zeros(tail_samples, dtype=np.float32))
    full_wav = np.concatenate(assembled).astype(np.float32)
    duration_seconds = round(float(len(full_wav) / sr), 3)

    # Project chunk spans back onto original surface words preserving inter-chunk silence gaps
    surface_words = WORD_TOKEN_RE.findall(text_nfc)
    timed_words = project_chunk_spans_to_surface_words(
        surface_words,
        chunk_spans,
        duration_seconds,
        expand_ranges_and_codes=True,
    )

    wav_bytes = encode_wav_bytes(full_wav, sr)
    _atomic_write_bytes(wav_cache, wav_bytes)
    _atomic_write_json(
        meta_cache,
        {"duration_seconds": duration_seconds, "words": timed_words},
    )
    prune_tts_cache_dir()
    out_bytes, out_media_type = encode_audio_bytes_for_media_type(
        wav_bytes, preferred_media_type
    )
    return {
        "audio_base64": base64.b64encode(out_bytes).decode("ascii"),
        "media_type": out_media_type,
        "provider": "local",
        "voice_id": preset.voice_id,
        "region": preset.region,
        "model_version": TTS_MODEL_VERSION,
        "speed": norm_speed,
        "duration_seconds": duration_seconds,
        "words": timed_words,
    }


def synthesize_phonics_steps_sync(
    tts_engine: Any,
    steps: list[PhonicsStepRequestItem],
    preset: LocalVoicePreset,
    speed: float,
    *,
    precision_override: str | None = None,
    preferred_media_type: str = "audio/wav",
) -> dict[str, Any]:
    serialized_steps = json.dumps(
        [
            {
                "id": s.id,
                "spoken_text": unicodedata.normalize("NFC", s.spoken_text.strip()),
                "pause_after_ms": s.pause_after_ms,
            }
            for s in steps
        ],
        ensure_ascii=False,
    )
    precision = precision_override or TTS_PRECISION
    norm_speed = normalize_speed(speed)
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=norm_speed,
        mode="phonics_steps",
        payload=serialized_steps,
        precision=precision,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    disk_hit = _read_disk_cache_entry(wav_cache, meta_cache)
    if disk_hit is not None:
        cached_wav, meta = disk_hit
        out_bytes, out_media_type = encode_audio_bytes_for_media_type(
            cached_wav, preferred_media_type
        )
        return {
            "audio_base64": base64.b64encode(out_bytes).decode("ascii"),
            "media_type": out_media_type,
            "provider": "local",
            "voice_id": preset.voice_id,
            "region": preset.region,
            "model_version": TTS_MODEL_VERSION,
            "speed": norm_speed,
            "duration_seconds": float(meta["duration_seconds"]),
            "step_timings": meta["step_timings"],
        }

    sr = int(tts_engine.sample_rate)
    lead_samples = int(sr * 0.08)
    assembled: list[np.ndarray] = [np.zeros(lead_samples, dtype=np.float32)]
    cursor_samples = lead_samples
    step_timings: list[dict[str, Any]] = []

    for idx, step in enumerate(steps):
        clean_step = (
            normalize_vietnamese_tts_text(
                step.spoken_text,
                expand_ranges_and_codes=True,
                for_phonics_step=True,
            )
            or unicodedata.normalize("NFC", step.spoken_text.strip())
        )
        spoken = ensure_tts_terminal_punctuation(clean_step)
        step_base_key = make_cache_key(
            voice_id=preset.voice_id,
            speed=1.0,
            mode="phonics_step_base",
            payload=spoken,
            precision=precision,
        )
        base_hit = _base_wav_cache_get(step_base_key)
        if base_hit is not None:
            raw_wav, _ = base_hit
        else:
            raw_wav = np.asarray(
                tts_engine.infer(
                    spoken,
                    voice=preset.preset_name,
                    temperature=0.22,
                    top_k=15,
                    apply_watermark=False,
                ),
                dtype=np.float32,
            )
            _base_wav_cache_put(step_base_key, raw_wav, sr)

        stretched = apply_speed_preserve_pitch(raw_wav, norm_speed)
        start_s = round(cursor_samples / sr, 3)
        end_s = round((cursor_samples + len(stretched)) / sr, 3)
        step_timings.append(
            {
                "id": step.id,
                "index": idx,
                "start": start_s,
                "end": max(start_s, end_s),
            }
        )
        assembled.append(stretched)
        cursor_samples += len(stretched)

        pause_samples = int(sr * (step.pause_after_ms / 1000.0))
        assembled.append(np.zeros(pause_samples, dtype=np.float32))
        cursor_samples += pause_samples

    full_wav = np.concatenate(assembled).astype(np.float32)
    duration_seconds = round(float(len(full_wav) / sr), 3)
    wav_bytes = encode_wav_bytes(full_wav, sr)

    _atomic_write_bytes(wav_cache, wav_bytes)
    _atomic_write_json(
        meta_cache,
        {"duration_seconds": duration_seconds, "step_timings": step_timings},
    )
    prune_tts_cache_dir()
    out_bytes, out_media_type = encode_audio_bytes_for_media_type(
        wav_bytes, preferred_media_type
    )
    return {
        "audio_base64": base64.b64encode(out_bytes).decode("ascii"),
        "media_type": out_media_type,
        "provider": "local",
        "voice_id": preset.voice_id,
        "region": preset.region,
        "model_version": TTS_MODEL_VERSION,
        "speed": norm_speed,
        "duration_seconds": duration_seconds,
        "step_timings": step_timings,
    }


@app.get("/health")
async def get_health() -> dict[str, Any]:
    stt_ready = runtime.stt_recognizer is not None
    tts_ready = runtime.tts_engine is not None
    return {
        "status": "ok" if (stt_ready and tts_ready) else "initializing",
        "version": WORKER_VERSION,
        "provider": "local",
        "auth_required": bool(_expected_voice_token()),
        "stt": {
            "ready": stt_ready,
            "backend": runtime.stt_backend,
            "model_version": STT_MODEL_VERSION,
            "mode": STT_MODE,
            "ws_stream_supported": STT_MODE == "ws" and stt_ready,
            "active_jobs": runtime.active_stt_jobs,
            "error": runtime.stt_load_error,
        },
        "tts": {
            "ready": tts_ready,
            "model_version": TTS_MODEL_VERSION,
            "precision": TTS_PRECISION,
            "hybrid_word_fp32": TTS_HYBRID_WORD_FP32,
            "cache_max_bytes": TTS_CACHE_MAX_BYTES,
            "voices_count": len(CURATED_VOICES),
            "active_voices": [v.voice_id for v in CURATED_VOICES],
            "regions": ["north", "central", "south"],
            "active_jobs": runtime.active_tts_jobs,
            "error": runtime.tts_load_error,
        },
    }


@app.get("/voices", dependencies=[Depends(require_voice_worker_token)])
async def list_voices() -> dict[str, Any]:
    return {
        "provider": "local",
        "model_version": TTS_MODEL_VERSION,
        "default_voice_id": DEFAULT_VOICE_ID,
        "voices": [
            {
                "voice_id": v.voice_id,
                "name": v.display_name,
                "preset_name": v.preset_name,
                "provider": "local",
                "model_version": TTS_MODEL_VERSION,
                "region": v.region,
                "region_label": v.region_label,
                "gender": v.gender,
                "style_label": v.style_label,
                "is_default": v.is_default,
                "labels": {
                    "accent": v.region_label,
                    "region": v.region,
                    "gender": "Nữ" if v.gender == "female" else "Nam",
                    "description": f"{v.region_label} · {v.style_label}",
                },
            }
            for v in CURATED_VOICES
        ],
    }


def _streaming_wav_header(sample_rate: int) -> bytes:
    """Build a 44-byte PCM_16 mono WAV header with streaming placeholder sizes."""
    data_size = 0x7FFFF000
    riff_size = 36 + data_size
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        data_size,
    )


def _float32_to_pcm16_bytes(wav: np.ndarray) -> bytes:
    if wav.size == 0:
        return b""
    clipped = np.clip(wav.astype(np.float32, copy=False), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


@app.post("/tts", dependencies=[Depends(require_voice_worker_token)])
async def post_tts(req: TtsSynthesisRequest, request: Request) -> Response:
    await _ensure_capability_loaded("tts")
    preset = resolve_strict_voice(req.voice_id)
    text_nfc = normalize_nfc_text(req.text)
    speed = normalize_speed(req.speed)
    word_count = len(WORD_TOKEN_RE.findall(text_nfc))
    use_crisp_temp = bool(req.word_sample or word_count <= 3)
    cache_mode = "word" if use_crisp_temp else "sentence"
    tts_engine, used_precision = runtime.select_tts_engine(
        word_sample=bool(req.word_sample),
        is_phonics=False,
        word_count=word_count,
    )
    preferred_media_type = resolve_preferred_audio_media_type(
        request.headers.get("accept"), req.audio_format
    )
    cache_key = make_cache_key(
        voice_id=preset.voice_id,
        speed=speed,
        mode=cache_mode,
        payload=text_nfc,
        precision=used_precision,
    )

    # Ultra-fast in-memory LRU cache (< 10ms TTFA, never blocks TTS semaphore)
    mem_hit = _mem_cache_get(cache_key)
    if mem_hit is not None:
        wav_bytes, duration_s = mem_hit
        logger.info(
            "tts_cache_hit voice=%s region=%s speed=%.2f duration_s=%.3f",
            preset.voice_id,
            preset.region,
            speed,
            duration_s,
        )
    else:
        runtime.tts_waiters += 1
        try:
            await asyncio.wait_for(
                runtime.tts_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS
            )
        except TimeoutError as exc:
            logger.warning("tts_busy voice=%s region=%s", preset.voice_id, preset.region)
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "VOICE_WORKER_BUSY",
                    "message": "Bộ đọc giọng nói trên máy đang bận xử lý câu trước.",
                },
            ) from exc
        finally:
            runtime.tts_waiters = max(0, runtime.tts_waiters - 1)

        runtime.active_tts_jobs += 1
        try:
            wav_bytes, duration_s = await asyncio.to_thread(
                synthesize_single_utterance_sync,
                tts_engine,
                text_nfc,
                preset,
                speed,
                req.word_sample,
                precision_override=used_precision,
                event_loop=asyncio.get_running_loop(),
            )
        finally:
            runtime.active_tts_jobs -= 1
            runtime.tts_semaphore.release()
        _mem_cache_put(cache_key, (wav_bytes, duration_s))
        logger.info(
            "tts_ok voice=%s region=%s speed=%.2f words=%d duration_s=%.3f",
            preset.voice_id,
            preset.region,
            speed,
            word_count,
            duration_s,
        )

    out_bytes, out_media_type = await asyncio.to_thread(
        encode_audio_bytes_for_media_type, wav_bytes, preferred_media_type
    )
    return Response(
        content=out_bytes,
        media_type=out_media_type,
        headers={
            "Cache-Control": "no-store",
            "X-Voice-Provider": "local",
            "X-Resolved-Voice-Id": preset.voice_id,
            "X-Voice-Region": preset.region,
            "X-Voice-Gender": preset.gender,
            "X-Voice-Model-Version": TTS_MODEL_VERSION,
            "X-TTS-Precision": used_precision,
            "X-Voice-Fallback": "0",
            "X-Audio-Duration-Seconds": str(duration_s),
        },
    )


@app.post("/tts/timed", dependencies=[Depends(require_voice_worker_token)])
async def post_tts_timed(req: TtsSynthesisRequest, request: Request) -> dict[str, Any]:
    await _ensure_capability_loaded("tts")
    preset = resolve_strict_voice(req.voice_id)
    text_nfc = normalize_nfc_text(req.text)
    speed = normalize_speed(req.speed)
    word_count = len(WORD_TOKEN_RE.findall(text_nfc))
    tts_engine, used_precision = runtime.select_tts_engine(
        word_sample=False,
        is_phonics=False,
        word_count=word_count,
    )
    preferred_media_type = resolve_preferred_audio_media_type(
        request.headers.get("accept"), req.audio_format
    )

    try:
        await asyncio.wait_for(
            runtime.tts_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS
        )
    except TimeoutError as exc:
        logger.warning("tts_timed_busy voice=%s region=%s", preset.voice_id, preset.region)
        raise HTTPException(
            status_code=503,
            detail={
                "code": "VOICE_WORKER_BUSY",
                "message": "Bộ đọc giọng nói trên máy đang bận xử lý câu trước.",
            },
        ) from exc

    runtime.active_tts_jobs += 1
    try:
        result = await asyncio.to_thread(
            synthesize_timed_passage_sync,
            tts_engine,
            text_nfc,
            preset,
            speed,
            precision_override=used_precision,
            preferred_media_type=preferred_media_type,
        )
        logger.info(
            "tts_timed_ok voice=%s region=%s speed=%.2f words=%d duration_s=%.3f",
            preset.voice_id,
            preset.region,
            speed,
            len(result.get("words") or []),
            float(result.get("duration_seconds") or 0.0),
        )
        return result
    finally:
        runtime.active_tts_jobs -= 1
        runtime.tts_semaphore.release()


@app.post("/tts/phonics", dependencies=[Depends(require_voice_worker_token)])
async def post_tts_phonics(req: PhonicsSynthesisRequest, request: Request) -> dict[str, Any]:
    await _ensure_capability_loaded("tts")
    preset = resolve_strict_voice(req.voice_id)
    speed = normalize_speed(req.speed)
    tts_engine, used_precision = runtime.select_tts_engine(
        word_sample=False,
        is_phonics=True,
        word_count=len(req.steps),
    )
    preferred_media_type = resolve_preferred_audio_media_type(
        request.headers.get("accept"), req.audio_format
    )

    try:
        await asyncio.wait_for(
            runtime.tts_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS
        )
    except TimeoutError as exc:
        logger.warning("tts_phonics_busy voice=%s region=%s", preset.voice_id, preset.region)
        raise HTTPException(
            status_code=503,
            detail={
                "code": "VOICE_WORKER_BUSY",
                "message": "Bộ đánh vần trên máy đang bận xử lý câu trước.",
            },
        ) from exc

    runtime.active_tts_jobs += 1
    try:
        result = await asyncio.to_thread(
            synthesize_phonics_steps_sync,
            tts_engine,
            req.steps,
            preset,
            speed,
            precision_override=used_precision,
            preferred_media_type=preferred_media_type,
        )
        logger.info(
            "tts_phonics_ok voice=%s region=%s speed=%.2f steps=%d duration_s=%.3f",
            preset.voice_id,
            preset.region,
            speed,
            len(req.steps),
            float(result.get("duration_seconds") or 0.0),
        )
        return result
    finally:
        runtime.active_tts_jobs -= 1
        runtime.tts_semaphore.release()


def _speech_window_from_frame_rms(
    frame_rms: np.ndarray,
    total_samples: int,
    *,
    frame_len: int = 320,
    sample_rate: float = 16000.0,
) -> tuple[float, float, float]:
    n_frames = int(frame_rms.size)
    if n_frames == 0:
        return 0.0, 0.0, 0.0
    max_rms = float(np.max(frame_rms))
    full_dur = float(total_samples / sample_rate)
    if max_rms < 0.002:
        return 0.0, full_dur, full_dur
    thresh = max(0.004, max_rms * 0.15)
    active = np.flatnonzero(frame_rms >= thresh)
    if active.size == 0:
        return 0.0, full_dur, full_dur
    first_idx = int(active[0])
    last_idx = int(active[-1])
    voiced_s = float(((last_idx - first_idx + 1) * frame_len) / sample_rate)
    lead_s = float((first_idx * frame_len) / sample_rate)
    tail_s = float((max(0, n_frames - 1 - last_idx) * frame_len) / sample_rate)
    return voiced_s, lead_s, tail_s


def _preprocess_audio_for_stt_with_stats(
    samples16: np.ndarray,
) -> tuple[np.ndarray, float, tuple[float, float, float]]:
    """Preprocess 16kHz audio and return (arr, pre_trimmed_lead_s, (voiced_s, lead_s, tail_s)) in one RMS pass."""
    arr = samples16.astype(np.float32, copy=True)
    if arr.size == 0:
        return arr, 0.0, (0.0, 0.0, 0.0)
    arr = arr - float(np.mean(arr))
    if arr.size > 32:
        arr = scipy_signal.sosfilt(_HIGHPASS_60HZ_SOS, arr).astype(np.float32)

    sr = 16000
    frame_len = 320
    n_frames = arr.size // frame_len
    start_sample = 0
    post_frame_rms: np.ndarray | None = None
    if n_frames > 0:
        frames = arr[: n_frames * frame_len].reshape(n_frames, frame_len)
        frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
        sorted_desc = np.sort(frame_rms)[::-1]
        ref_rms = float(sorted_desc[min(1, sorted_desc.size - 1)])
        active_thresh = max(0.002, ref_rms * 0.15)
        active_indices = np.flatnonzero(frame_rms >= active_thresh)
        if active_indices.size > 0:
            first_idx = int(active_indices[0])
            last_idx = int(active_indices[-1])
            lead_samples = first_idx * frame_len
            last_active_end = min(arr.size, (last_idx + 1) * frame_len)
            trail_samples = arr.size - last_active_end
            max_dead_samples = int(sr * 0.35)
            lead_keep = int(sr * 0.18)
            trail_keep = int(sr * 0.22)
            start_sample = (
                max(0, lead_samples - lead_keep)
                if lead_samples > max_dead_samples
                else 0
            )
            end_sample = (
                min(arr.size, last_active_end + trail_keep)
                if trail_samples > max_dead_samples
                else arr.size
            )
            if end_sample > start_sample:
                arr = arr[start_sample:end_sample]
                start_frame = start_sample // frame_len
                end_frame = min(n_frames, end_sample // frame_len)
                post_frame_rms = frame_rms[start_frame:end_frame]
            else:
                start_sample = 0
                post_frame_rms = frame_rms
            voiced_frames = frame_rms[active_indices]
            rms = float(np.percentile(voiced_frames, 90))
        else:
            post_frame_rms = frame_rms
            rms = float(np.sqrt(np.mean(arr * arr)))
    else:
        rms = float(np.sqrt(np.mean(arr * arr)))

    gain_applied = False
    peak = float(np.max(np.abs(arr))) if arr.size > 0 else 0.0
    if 0.0004 < rms < 0.065 and peak > 0.0015:
        gain = min(15.0, 0.08 / rms)
        if gain > 1.0:
            scaled = arr * gain
            arr = (0.95 * np.tanh(scaled / 0.95)).astype(np.float32)
            gain_applied = True

    pre_trimmed_lead_s = float(start_sample / float(sr))
    if not gain_applied and post_frame_rms is not None:
        window_stats = _speech_window_from_frame_rms(
            post_frame_rms, arr.size, frame_len=frame_len, sample_rate=float(sr)
        )
    else:
        window_stats = analyze_speech_window_s(arr, sample_rate=sr)
    return arr, pre_trimmed_lead_s, window_stats


def preprocess_audio_for_stt(samples16: np.ndarray) -> np.ndarray:
    """Apply DC removal, 60Hz HPF, dead-air trim (>350ms -> 180ms/220ms), voiced p90 AGC, and tanh soft-limiter."""
    arr, _pre_trimmed_lead_s, _stats = _preprocess_audio_for_stt_with_stats(samples16)
    return arr


def analyze_speech_window_s(
    samples16: np.ndarray, sample_rate: int = 16000
) -> tuple[float, float, float]:
    """Compute (voiced_s, leading_silence_s, trailing_silence_s) in one 20ms-frame RMS pass."""
    arr = np.asarray(samples16, dtype=np.float32)
    sr = float(sample_rate) if sample_rate and sample_rate > 0 else 16000.0
    frame_len = max(1, int(round(sr * 0.02)))
    if arr.size < frame_len:
        return 0.0, 0.0, 0.0
    n_frames = arr.size // frame_len
    if n_frames == 0:
        return 0.0, 0.0, 0.0
    frames = arr[: n_frames * frame_len].reshape(n_frames, frame_len)
    frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
    return _speech_window_from_frame_rms(
        frame_rms, arr.size, frame_len=frame_len, sample_rate=sr
    )


def estimate_voiced_duration_s(samples16: np.ndarray, sample_rate: int = 16000) -> float:
    """Estimate active voiced speech duration excluding quiet lead/pre-roll and trailing silence."""
    return analyze_speech_window_s(samples16, sample_rate=sample_rate)[0]


def estimate_leading_silence_s(samples16: np.ndarray, sample_rate: int = 16000) -> float:
    """Estimate leading silence duration before the first active voiced 20ms frame."""
    return analyze_speech_window_s(samples16, sample_rate=sample_rate)[1]


def estimate_trailing_silence_s(samples16: np.ndarray, sample_rate: int = 16000) -> float:
    """Estimate trailing silence duration after the last active voiced 20ms frame."""
    return analyze_speech_window_s(samples16, sample_rate=sample_rate)[2]


def decode_stt_window_sync(
    samples16: np.ndarray,
    *,
    lead_pad_s: float = 0.18,
    trail_pad_s: float = 0.35,
    short_trail_cap_s: float = 0.20,
    voiced_duration_ms: float | None = None,
    cap_lead_silence: bool = True,
    cap_trail_silence: bool = True,
    keyterms: list[str] | str | None = None,
) -> tuple[str, list[dict[str, Any]], float]:
    """Decode one 16kHz float32 audio window using Sherpa-ONNX Zipformer."""
    assert runtime.stt_recognizer is not None
    t_d0 = time.perf_counter()
    if samples16.size < 400:
        return "", [], (time.perf_counter() - t_d0) * 1000.0
    if float(np.max(np.abs(samples16))) <= 0.0008:
        return "", [], (time.perf_counter() - t_d0) * 1000.0
    duration_s = float(samples16.size / 16000.0)
    arr, pre_trimmed_lead_s, (estimated_voiced_s, existing_lead_s, existing_tail_s) = (
        _preprocess_audio_for_stt_with_stats(samples16)
    )
    # Never decode filtered silence (e.g. 20-50Hz desk rumble removed by 60Hz HPF)
    # even if unfiltered client VAD reported a non-zero voiced_duration_ms.
    if estimated_voiced_s <= 0.0:
        return "", [], (time.perf_counter() - t_d0) * 1000.0
    # Gate trailing silence padding on VOICED speech duration (excluding pre-roll/tail),
    # so short isolated words (~0.6s speech + 0.45s pre-roll) never trigger collocation hallucinations.
    voiced_s = (
        float(voiced_duration_ms) / 1000.0
        if voiced_duration_ms is not None and voiced_duration_ms > 0
        else estimated_voiced_s
    )
    target_lead_s = max(0.0, float(lead_pad_s))
    trimmed_lead_s = pre_trimmed_lead_s
    arr_for_decode = arr
    if cap_lead_silence:
        # Avoid double-stacking leading silence (e.g. 0.45s pre-roll + 0.18s pad -> 0.63s),
        # which causes leading collocation hallucinations like "tất cả" on isolated "cả".
        if voiced_s < 1.2 and target_lead_s > 0.0 and existing_lead_s > target_lead_s:
            trim_samples = int((existing_lead_s - target_lead_s) * 16000)
            if 0 < trim_samples < arr_for_decode.size:
                arr_for_decode = arr_for_decode[trim_samples:]
                trimmed_lead_s += trim_samples / 16000.0
            effective_lead_s = 0.0
        else:
            effective_lead_s = max(0.0, target_lead_s - existing_lead_s)
    else:
        effective_lead_s = target_lead_s

    if voiced_s >= 1.2:
        effective_trail_pad = trail_pad_s
    else:
        effective_trail_pad = 0.0
        target_short_tail_s = max(0.0, float(short_trail_cap_s))
        if cap_trail_silence and target_short_tail_s > 0.0 and existing_tail_s > target_short_tail_s:
            # Cap excess trailing silence on isolated short words (e.g. 0.40-0.55s VAD hangover)
            # down to 0.20s so Zipformer does not hallucinate trailing stop codas ("nhà"->"nhạc").
            trim_tail_samples = int((existing_tail_s - target_short_tail_s) * 16000)
            if 0 < trim_tail_samples < arr_for_decode.size:
                arr_for_decode = arr_for_decode[:-trim_tail_samples]
    padded = np.concatenate(
        [
            np.zeros(int(16000 * effective_lead_s), dtype=np.float32),
            arr_for_decode,
            np.zeros(int(16000 * effective_trail_pad), dtype=np.float32),
        ]
    )
    hotwords_list = _parse_stt_hotwords(keyterms)
    stream = None
    if hotwords_list and getattr(runtime, "stt_bpe_vocab_active", False):
        hotwords_str = "/".join(hotwords_list)
        try:
            stream = runtime.stt_recognizer.create_stream(hotwords=hotwords_str)
        except Exception:
            stream = None
    if stream is None:
        stream = runtime.stt_recognizer.create_stream()
    stream.accept_waveform(16000, padded)
    runtime.stt_recognizer.decode_stream(stream)
    res = stream.result
    txt = unicodedata.normalize("NFC", res.text.strip().lower())
    adjusted_timestamps = [
        max(0.0, float(t) + trimmed_lead_s - effective_lead_s) for t in list(res.timestamps)
    ]
    raw_ys_log_probs = getattr(res, "ys_log_probs", None)
    ys_log_probs = (
        list(raw_ys_log_probs)
        if isinstance(raw_ys_log_probs, (list, tuple))
        else None
    )
    words = build_stt_words_from_sherpa(
        list(res.tokens),
        adjusted_timestamps,
        duration_s,
        audio_16k=arr,
        ys_log_probs=ys_log_probs,
    )
    return txt, words, (time.perf_counter() - t_d0) * 1000.0


@app.post("/stt", dependencies=[Depends(require_voice_worker_token)])
async def post_stt(
    request: Request,
    response: Response,
    audio_file: UploadFile = File(...),
    language: str = Form(default="vi"),
    keyterms: str = Form(default=""),
    source: str = Form(default=""),
    session_id: str = Form(default=""),
    turn_id: str = Form(default=""),
    voiced_duration_ms: float | None = Form(default=None),
) -> dict[str, Any]:
    del language, turn_id
    global _INTERIM_COUNTER
    t_req_start = time.perf_counter()
    await _ensure_capability_loaded("stt")
    raw = await audio_file.read(MAX_AUDIO_BYTES + 1)
    if not raw:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "STT_EMPTY_AUDIO",
                "message": "Tệp ghi âm trống.",
            },
        )
    if len(raw) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "STT_AUDIO_TOO_LARGE",
                "message": "Tệp ghi âm vượt quá giới hạn 15MB.",
            },
        )

    is_interim = source.strip() == "local_live_interim"
    session_key = session_id.strip()[:80] if session_id else ""
    my_interim_seq = 0
    if is_interim and session_key:
        _INTERIM_COUNTER += 1
        my_interim_seq = _INTERIM_COUNTER
        _LATEST_INTERIM_SEQ_BY_SESSION[session_key] = my_interim_seq

    def _empty_superseded_payload() -> dict[str, Any]:
        return {
            "text": "",
            "words": [],
            "language_code": "vi",
            "language_probability": None,
            "duration_seconds": 0.0,
            "provider": "local",
            "model_version": STT_MODEL_VERSION,
            "fallback_used": False,
            "superseded": True,
        }

    if await request.is_disconnected() or (
        is_interim
        and session_key
        and my_interim_seq < _LATEST_INTERIM_SEQ_BY_SESSION.get(session_key, 0)
    ):
        return _empty_superseded_payload()

    # Decode container/audio bytes OUTSIDE stt_semaphore so decode I/O never blocks Sherpa inference slots.
    try:
        samples16, duration_s = await asyncio.to_thread(
            decode_audio_bytes_to_16k_mono,
            raw,
            filename=audio_file.filename or "",
            content_type=audio_file.content_type or "",
        )
    except Exception as exc:
        logger.warning(
            "stt_decode_failed audio_bytes=%d error_type=%s",
            len(raw),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=422,
            detail={
                "code": "STT_INVALID_AUDIO",
                "message": "Định dạng âm thanh không đọc được.",
            },
        ) from exc

    if samples16.size < 400:
        logger.info("stt_short_audio audio_bytes=%d duration_s=%.3f", len(raw), duration_s)
        return {
            "text": "",
            "words": [],
            "language_code": "vi",
            "language_probability": None,
            "duration_seconds": round(duration_s, 3),
            "provider": "local",
            "model_version": STT_MODEL_VERSION,
            "fallback_used": False,
        }

    if await request.is_disconnected() or (
        is_interim
        and session_key
        and my_interim_seq < _LATEST_INTERIM_SEQ_BY_SESSION.get(session_key, 0)
    ):
        return _empty_superseded_payload()

    t_q0 = time.perf_counter()
    try:
        await asyncio.wait_for(
            runtime.stt_semaphore.acquire(), timeout=STT_QUEUE_WAIT_SECONDS
        )
    except TimeoutError as exc:
        logger.warning("stt_busy audio_bytes=%d", len(raw))
        raise HTTPException(
            status_code=503,
            detail={
                "code": "VOICE_WORKER_BUSY",
                "message": "Bộ nhận diện giọng nói trên máy đang bận.",
            },
        ) from exc
    queue_ms = (time.perf_counter() - t_q0) * 1000.0

    runtime.active_stt_jobs += 1
    try:
        if await request.is_disconnected() or (
            is_interim
            and session_key
            and my_interim_seq < _LATEST_INTERIM_SEQ_BY_SESSION.get(session_key, 0)
        ):
            return _empty_superseded_payload()

        text_out, words_out, decode_ms = await asyncio.to_thread(
            decode_stt_window_sync,
            samples16,
            lead_pad_s=0.18,
            trail_pad_s=0.35,
            voiced_duration_ms=voiced_duration_ms,
            cap_lead_silence=True,
            keyterms=keyterms,
        )
        total_ms = (time.perf_counter() - t_req_start) * 1000.0
        response.headers["X-STT-Queue-Ms"] = f"{queue_ms:.2f}"
        response.headers["X-STT-Decode-Ms"] = f"{decode_ms:.2f}"
        response.headers["X-STT-Total-Ms"] = f"{total_ms:.2f}"
        return {
            "text": text_out,
            "words": words_out,
            "language_code": "vi",
            "language_probability": None,
            "duration_seconds": round(duration_s, 3),
            "provider": "local",
            "model_version": STT_MODEL_VERSION,
            "fallback_used": False,
        }
    finally:
        runtime.active_stt_jobs -= 1
        runtime.stt_semaphore.release()


_WS_TARGET_SR = 16000
_WS_PRE_ROLL_SAMPLES = int(_WS_TARGET_SR * 0.32)
_WS_MAX_ACTIVE_WINDOW_SAMPLES = int(_WS_TARGET_SR * 1.7)
_WS_ADVANCE_TRIGGER_SAMPLES = int(_WS_TARGET_SR * 1.35)
_WS_ACOUSTIC_OVERLAP_SAMPLES = int(_WS_TARGET_SR * 0.24)
_WS_INTERIM_MIN_SPEECH_SAMPLES = int(_WS_TARGET_SR * 0.12)
_WS_INTERIM_STEP_SAMPLES = int(_WS_TARGET_SR * 0.28)
_WS_SILENCE_FLUSH_SAMPLES = int(_WS_TARGET_SR * 0.42)
_WS_MIN_FLUSH_SAMPLES = int(_WS_TARGET_SR * 0.12)
_WS_CLIENT_VAD_MAX_SAMPLES = int(_WS_TARGET_SR * 18.0)
_WS_CLIP_SAMPLE_THRESHOLD = 0.985
_WS_CLIP_SUSTAINED_RATIO = 0.03
_WS_CLIP_WINDOW_RATIO = 0.05
_WS_CLIP_MIN_SAMPLES = 480
_WS_CLIP_WINDOW_CHUNKS = 8


def _merge_window_words(
    committed_words: list[dict[str, Any]],
    window_words: list[dict[str, Any]],
    window_origin_s: float,
    last_committed_end_s: float,
) -> list[dict[str, Any]]:
    """Merge prefix committed words with newly decoded active-window words without overlap duplicates."""
    merged = list(committed_words)
    shifted: list[dict[str, Any]] = []
    for item in window_words:
        w_start = round(window_origin_s + float(item["start"]), 3)
        w_end = round(max(w_start + 0.04, window_origin_s + float(item["end"])), 3)
        shifted.append(
            {
                "text": item["text"],
                "start": w_start,
                "end": w_end,
                "type": item.get("type", "word"),
            }
        )

    if not merged:
        return shifted

    tail_text = merged[-1]["text"]
    for idx, w in enumerate(shifted):
        midpoint = (w["start"] + w["end"]) * 0.5
        if w["end"] <= last_committed_end_s + 0.03 or midpoint <= last_committed_end_s + 0.01:
            continue
        if idx == 0 and w["text"] == tail_text and w["start"] <= last_committed_end_s + 0.08:
            continue
        merged.append(w)
    return merged


def _advance_bounded_window(
    *,
    seg_total_samples: int,
    window_origin_sample: int,
    committed_words: list[dict[str, Any]],
    window_words: list[dict[str, Any]],
    last_committed_end_s: float,
) -> tuple[list[dict[str, Any]], int, float]:
    """Advance active decode window origin so decode cost stays O(1) even on 15s utterances."""
    window_origin_s = window_origin_sample / float(_WS_TARGET_SR)
    merged = _merge_window_words(
        committed_words, window_words, window_origin_s, last_committed_end_s
    )
    active_samples = seg_total_samples - window_origin_sample
    if active_samples <= _WS_ADVANCE_TRIGGER_SAMPLES or len(merged) < 3:
        return merged, window_origin_sample, last_committed_end_s

    # Prefer splitting at a natural micro-pause (>= 120ms) inside the active window,
    # otherwise commit all words except the trailing 2 words so acoustic boundaries stay intact.
    split_idx = len(merged) - 2
    for idx in range(len(committed_words) + 1, len(merged) - 1):
        gap = float(merged[idx]["start"]) - float(merged[idx - 1]["end"])
        if gap >= 0.12 and (float(merged[idx - 1]["end"]) - window_origin_s) >= 0.6:
            split_idx = idx
            break

    if split_idx <= len(committed_words):
        # Fallback if window still exceeds hard cap (~1.9s) without enough words
        if active_samples > _WS_MAX_ACTIVE_WINDOW_SAMPLES:
            new_origin = max(
                window_origin_sample,
                seg_total_samples - _WS_ADVANCE_TRIGGER_SAMPLES,
            )
            return merged, new_origin, last_committed_end_s
        return merged, window_origin_sample, last_committed_end_s

    new_committed = merged[:split_idx]
    new_last_end_s = float(new_committed[-1]["end"])
    new_origin = max(
        window_origin_sample,
        int(new_last_end_s * _WS_TARGET_SR) - _WS_ACOUSTIC_OVERLAP_SAMPLES,
    )
    # Guarantee active tail stays bounded <= _WS_MAX_ACTIVE_WINDOW_SAMPLES
    min_bounded_origin = max(0, seg_total_samples - _WS_MAX_ACTIVE_WINDOW_SAMPLES)
    if new_origin < min_bounded_origin:
        new_origin = min_bounded_origin
    return new_committed, new_origin, new_last_end_s


@dataclass
class _PendingFlushJob:
    audio_window: np.ndarray
    window_origin_sample: int
    committed_words: list[dict[str, Any]]
    last_committed_end_s: float
    segment_id: str
    turn_id: str
    session_id: str
    page_id: str
    audio_ended_ms: int
    audio_quality: dict[str, Any]
    voiced_duration_ms: float | None = None


class _WsSttSession:
    def __init__(self) -> None:
        self.session_id: str = ""
        self.page_id: str = ""
        self.turn_id: str = ""
        self.sample_rate: int = _WS_TARGET_SR
        self.language: str = "vi"
        self.vad_mode: Literal["server", "client"] = "server"
        self.total_samples_received: int = 0
        self.noise_floor: float = 0.0018
        self.pre_roll: np.ndarray = np.zeros(0, dtype=np.float32)

        self.in_speech: bool = False
        self.seg_seq: int = 0
        self.segment_id: str = "ws:seg_0"
        self.seg_chunks: list[np.ndarray] = []
        self.seg_total_samples: int = 0
        self.pre_roll_samples: int = 0
        self.leading_silence_samples: int = 0
        self.silence_samples: int = 0
        self.quiet_streak: int = 0
        self.voiced_samples: int = 0
        self.sum_sq: float = 0.0
        self.total_sum_sq: float = 0.0
        self.peak: float = 0.0
        self.clipped_samples: int = 0
        self.checked_samples: int = 0
        self.recent_clip_ratios: list[float] = []

        self.window_origin_sample: int = 0
        self.committed_words: list[dict[str, Any]] = []
        self.last_committed_end_s: float = 0.0
        self.last_interim_sample: int = 0
        self.latest_interim_seq: int = 0
        self.last_decoded_interim_seq: int = 0
        self.pending_flushes: list[_PendingFlushJob] = []
        self.decode_event = asyncio.Event()
        self.stopped: bool = False

    def _is_sustained_clipping(self) -> bool:
        if self.clipped_samples < _WS_CLIP_MIN_SAMPLES:
            return False
        overall_ratio = self.clipped_samples / float(max(1, self.checked_samples))
        if overall_ratio >= _WS_CLIP_SUSTAINED_RATIO:
            return True
        if (
            len(self.recent_clip_ratios) >= 2
            and (sum(self.recent_clip_ratios) / float(len(self.recent_clip_ratios)))
            >= _WS_CLIP_WINDOW_RATIO
        ):
            return True
        if len(self.recent_clip_ratios) >= 3:
            high_chunks = sum(
                1 for r in self.recent_clip_ratios[-_WS_CLIP_WINDOW_CHUNKS:] if r >= 0.10
            )
            if high_chunks >= 3:
                return True
        return False

    def _build_quality(self) -> dict[str, Any]:
        # Compute RMS strictly over voiced speech samples so pre-roll and trailing silence
        # never dilute quiet child voices into false LOW_VOLUME rejections.
        non_silence_samples = max(
            0,
            self.seg_total_samples
            - self.pre_roll_samples
            - self.leading_silence_samples
            - self.silence_samples,
        )
        if self.voiced_samples > 0:
            active_samples = max(self.voiced_samples, non_silence_samples)
            rms = float(np.sqrt(self.sum_sq / self.voiced_samples))
        else:
            active_samples = 0
            denom = max(1, self.seg_total_samples - self.pre_roll_samples)
            rms = float(np.sqrt(self.total_sum_sq / denom))
        active_ms = round(max(0.0, active_samples / _WS_TARGET_SR * 1000.0))
        overall_clip_ratio = self.clipped_samples / float(max(1, self.checked_samples))
        status = "OK"
        if active_ms < 80:
            status = "AUDIO_TOO_SHORT"
        elif self._is_sustained_clipping():
            status = "CLIPPING"
        elif rms < 0.002 and self.peak < 0.01:
            status = "LOW_VOLUME"
        return {
            "status": status,
            "rms": round(rms, 5),
            "peak": round(float(self.peak), 4),
            "clipped_ratio": round(overall_clip_ratio, 5),
            "speech_duration_ms": active_ms,
        }

    def reset_segment(self, keep_pre_roll: np.ndarray | None = None) -> None:
        self.in_speech = False
        self.seg_chunks = []
        self.seg_total_samples = 0
        self.pre_roll_samples = 0
        self.leading_silence_samples = 0
        self.silence_samples = 0
        self.quiet_streak = 0
        self.voiced_samples = 0
        self.sum_sq = 0.0
        self.total_sum_sq = 0.0
        self.peak = 0.0
        self.clipped_samples = 0
        self.checked_samples = 0
        self.recent_clip_ratios = []
        self.window_origin_sample = 0
        self.committed_words = []
        self.last_committed_end_s = 0.0
        self.last_interim_sample = 0
        self.pre_roll = (
            keep_pre_roll[-_WS_PRE_ROLL_SAMPLES:]
            if keep_pre_roll is not None and keep_pre_roll.size > 0
            else np.zeros(0, dtype=np.float32)
        )

    def _snapshot_window(self) -> tuple[np.ndarray, int, list[dict[str, Any]], float]:
        if not self.seg_chunks:
            return np.zeros(0, dtype=np.float32), 0, [], 0.0
        full = (
            self.seg_chunks[0]
            if len(self.seg_chunks) == 1
            else np.concatenate(self.seg_chunks)
        )
        self.seg_chunks = [full]
        origin = min(self.window_origin_sample, full.size)
        return (
            full[origin:].copy(),
            origin,
            list(self.committed_words),
            self.last_committed_end_s,
        )

    def enqueue_flush(
        self,
        *,
        carry_tail: bool,
        turn_id_override: str | None = None,
        emit_empty_ack: bool = False,
    ) -> None:
        flush_turn_id = (turn_id_override or "").strip() or self.turn_id
        if not self.in_speech or self.seg_total_samples < _WS_MIN_FLUSH_SAMPLES:
            if emit_empty_ack:
                self.seg_seq += 1
                prefix = self.session_id or "ws"
                empty_job = _PendingFlushJob(
                    audio_window=np.zeros(0, dtype=np.float32),
                    window_origin_sample=0,
                    committed_words=[],
                    last_committed_end_s=0.0,
                    segment_id=f"{prefix}:seg_{self.seg_seq}",
                    turn_id=flush_turn_id,
                    session_id=self.session_id,
                    page_id=self.page_id,
                    audio_ended_ms=round(self.total_samples_received / _WS_TARGET_SR * 1000.0),
                    audio_quality=self._build_quality(),
                    voiced_duration_ms=0.0,
                )
                self.pending_flushes.append(empty_job)
                self.latest_interim_seq += 1
                self.reset_segment()
                self.decode_event.set()
                return
            self.reset_segment()
            return
        win_audio, origin, committed, last_end = self._snapshot_window()
        full_tail = (
            self.seg_chunks[0][-min(self.silence_samples, _WS_PRE_ROLL_SAMPLES) :]
            if carry_tail and self.seg_chunks and self.silence_samples > 0
            else None
        )
        voiced_ms = round(self.voiced_samples / float(_WS_TARGET_SR) * 1000.0, 1)
        job = _PendingFlushJob(
            audio_window=win_audio,
            window_origin_sample=origin,
            committed_words=committed,
            last_committed_end_s=last_end,
            segment_id=self.segment_id,
            turn_id=flush_turn_id,
            session_id=self.session_id,
            page_id=self.page_id,
            audio_ended_ms=round(self.total_samples_received / _WS_TARGET_SR * 1000.0),
            audio_quality=self._build_quality(),
            voiced_duration_ms=voiced_ms,
        )
        self.pending_flushes.append(job)
        self.latest_interim_seq += 1  # Supersede any in-flight interim for this segment
        self.reset_segment(full_tail)
        self.decode_event.set()

    def push_pcm16k(self, chunk: np.ndarray) -> None:
        if chunk.size == 0:
            return
        self.total_samples_received += int(chunk.size)
        abs_chunk = np.abs(chunk)
        sum_sq = float(np.sum(chunk * chunk))
        rms = float(np.sqrt(sum_sq / chunk.size))
        peak = float(np.max(abs_chunk))
        clipped_count = int(np.sum(abs_chunk >= _WS_CLIP_SAMPLE_THRESHOLD))
        chunk_clip_ratio = clipped_count / float(chunk.size)
        onset_thresh = max(0.0028, self.noise_floor * 2.0)
        hold_thresh = max(0.0016, self.noise_floor * 1.4)
        is_onset = rms >= onset_thresh or peak >= onset_thresh * 3.0
        is_voiced = rms >= hold_thresh or peak >= hold_thresh * 3.0

        if not self.in_speech:
            if is_onset or self.vad_mode == "client":
                self.in_speech = True
                self.seg_seq += 1
                prefix = self.session_id or "ws"
                self.segment_id = f"{prefix}:seg_{self.seg_seq}"
                self.silence_samples = 0
                self.leading_silence_samples = 0
                self.quiet_streak = 0
                self.clipped_samples = clipped_count
                self.checked_samples = int(chunk.size)
                self.recent_clip_ratios = [chunk_clip_ratio]
                if self.pre_roll.size > 0:
                    self.seg_chunks.append(self.pre_roll)
                    self.pre_roll_samples = int(self.pre_roll.size)
                    self.seg_total_samples += int(self.pre_roll.size)
                    self.pre_roll = np.zeros(0, dtype=np.float32)
                self.seg_chunks.append(chunk)
                self.seg_total_samples += int(chunk.size)
                self.total_sum_sq = sum_sq
                if is_onset or is_voiced:
                    self.sum_sq = sum_sq
                    self.peak = peak
                    self.voiced_samples = int(chunk.size)
                else:
                    # In vad_mode="client", initial chunks may be client pre-roll/quiet lead-in:
                    # keep adapting noise_floor instead of freezing it, and do not count unvoiced
                    # samples toward voiced RMS/duration.
                    self.noise_floor = min(
                        0.0055, max(0.0009, self.noise_floor * 0.95 + rms * 0.05)
                    )
                    self.sum_sq = 0.0
                    self.peak = peak
                    self.voiced_samples = 0
                    self.leading_silence_samples = int(chunk.size)
            else:
                self.noise_floor = min(
                    0.0055, max(0.0009, self.noise_floor * 0.95 + rms * 0.05)
                )
                if self.pre_roll.size == 0:
                    self.pre_roll = chunk[-_WS_PRE_ROLL_SAMPLES:]
                else:
                    merged = np.concatenate([self.pre_roll, chunk])
                    self.pre_roll = merged[-_WS_PRE_ROLL_SAMPLES:]
            return

        self.seg_chunks.append(chunk)
        self.seg_total_samples += int(chunk.size)
        self.total_sum_sq += sum_sq
        self.clipped_samples += clipped_count
        self.checked_samples += int(chunk.size)
        self.recent_clip_ratios.append(chunk_clip_ratio)
        if len(self.recent_clip_ratios) > _WS_CLIP_WINDOW_CHUNKS:
            self.recent_clip_ratios.pop(0)
        if not is_voiced:
            if self.voiced_samples == 0:
                self.noise_floor = min(
                    0.0055, max(0.0009, self.noise_floor * 0.95 + rms * 0.05)
                )
                self.leading_silence_samples += int(chunk.size)
            else:
                self.quiet_streak += 1
                if self.quiet_streak >= 2:
                    self.silence_samples += int(chunk.size)
        else:
            self.quiet_streak = 0
            self.silence_samples = 0
            self.voiced_samples += int(chunk.size)
            self.sum_sq += sum_sq
            if peak > self.peak:
                self.peak = peak

        # Single source of truth for VAD:
        # - vad_mode == "server" (standalone WS clients): auto-flush after _WS_SILENCE_FLUSH_SAMPLES (420ms).
        # - vad_mode == "client" (LocalSegmentSpeechRecognition): client owns turn boundaries via
        #   explicit {type: "flush", turn_id} / "stop" frames (server only hard-caps at 18s).
        if self.vad_mode != "client":
            if (
                self.silence_samples >= _WS_SILENCE_FLUSH_SAMPLES
                and self.seg_total_samples >= _WS_MIN_FLUSH_SAMPLES
            ):
                self.enqueue_flush(carry_tail=True)
                return
        elif self.seg_total_samples >= _WS_CLIENT_VAD_MAX_SAMPLES:
            self.enqueue_flush(carry_tail=True)
            return

        active_samples = self.seg_total_samples - self.silence_samples
        delta_samples = self.seg_total_samples - self.last_interim_sample
        is_pause_trigger = (
            self.silence_samples >= int(_WS_TARGET_SR * 0.12)
            and active_samples >= _WS_INTERIM_MIN_SPEECH_SAMPLES
            and delta_samples >= int(_WS_TARGET_SR * 0.14)
        )
        is_step_trigger = (
            active_samples >= _WS_INTERIM_MIN_SPEECH_SAMPLES
            and delta_samples >= _WS_INTERIM_STEP_SAMPLES
        )
        if is_pause_trigger or is_step_trigger:
            self.last_interim_sample = self.seg_total_samples
            self.latest_interim_seq += 1
            self.decode_event.set()


@app.websocket("/stt/stream")
async def stt_stream(websocket: WebSocket) -> None:
    """True WebSocket streaming STT with O(1) bounded sliding-window decode."""
    expected = _expected_voice_token()
    provided = websocket.headers.get("X-ViRead-Voice-Token", "").strip()
    if expected and not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    if STT_MODE == "http":
        await websocket.send_json(
            {
                "type": "error",
                "code": "STT_WS_DISABLED",
                "message": "Streaming WebSocket STT is disabled by VIREAD_STT_MODE=http.",
                "retryable": True,
            }
        )
        await websocket.close(code=4503)
        return

    try:
        await _ensure_capability_loaded("stt")
    except HTTPException:
        await websocket.send_json(
            {
                "type": "error",
                "code": "LOCAL_STT_UNAVAILABLE",
                "message": "Bộ nhận diện giọng nói trên máy chưa sẵn sàng.",
                "retryable": True,
            }
        )
        await websocket.close(code=4503)
        return
    session = _WsSttSession()

    async def _decode_and_emit_loop() -> None:
        while not session.stopped or session.pending_flushes:
            await session.decode_event.wait()
            session.decode_event.clear()

            # 1. Drain all finalized segment flushes in order
            while session.pending_flushes:
                job = session.pending_flushes.pop(0)
                committed = list(job.committed_words)
                last_end = job.last_committed_end_s
                origin = job.window_origin_sample
                full_tail = job.audio_window
                total_decode_ms = 0.0
                max_step_decode_ms = 0.0
                _txt = ""

                _txt = ""
                if full_tail.size == 0:
                    final_words = committed
                else:
                    # Bound every Sherpa decode call to <= ~1.9s even if a client bursts audio
                    # faster than real-time before interim ticks advance the window.
                    step_offset = 0
                    while True:
                        remaining = full_tail.size - step_offset
                        if remaining <= _WS_MAX_ACTIVE_WINDOW_SAMPLES:
                            chunk_audio = full_tail[step_offset:]
                            is_last_slice = True
                        else:
                            chunk_audio = full_tail[
                                step_offset : step_offset + _WS_ADVANCE_TRIGGER_SAMPLES
                            ]
                            is_last_slice = False

                        await runtime.stt_semaphore.acquire()
                        runtime.active_stt_jobs += 1
                        try:
                            _txt, win_words, step_decode_ms = await asyncio.to_thread(
                                decode_stt_window_sync,
                                chunk_audio,
                                lead_pad_s=0.18,
                                trail_pad_s=0.22,
                                voiced_duration_ms=(
                                    job.voiced_duration_ms
                                    if step_offset == 0 and is_last_slice
                                    else None
                                ),
                                cap_lead_silence=True,
                            )
                        finally:
                            runtime.active_stt_jobs -= 1
                            runtime.stt_semaphore.release()

                        total_decode_ms += step_decode_ms
                        if step_decode_ms > max_step_decode_ms:
                            max_step_decode_ms = step_decode_ms
                        slice_origin_sample = origin + step_offset
                        slice_origin_s = slice_origin_sample / float(_WS_TARGET_SR)
                        merged = _merge_window_words(
                            committed, win_words, slice_origin_s, last_end
                        )
                        if is_last_slice:
                            final_words = merged
                            break

                        if len(merged) > len(committed) + 1:
                            committed = merged[:-1]
                        else:
                            committed = merged
                        if committed:
                            last_end = float(committed[-1]["end"])
                        next_offset = max(
                            step_offset + _WS_TARGET_SR,
                            int(last_end * _WS_TARGET_SR) - origin - _WS_ACOUSTIC_OVERLAP_SAMPLES,
                        )
                        if next_offset <= step_offset:
                            next_offset = step_offset + _WS_ADVANCE_TRIGGER_SAMPLES - _WS_ACOUSTIC_OVERLAP_SAMPLES
                        step_offset = next_offset

                final_text = unicodedata.normalize(
                    "NFC", " ".join(w["text"] for w in final_words).strip()
                )
                if not final_text and _txt and not job.committed_words:
                    final_text = _txt
                await websocket.send_json(
                    {
                        "type": "final",
                        "text": final_text,
                        "words": final_words,
                        "segment_id": job.segment_id,
                        "turn_id": job.turn_id,
                        "session_id": job.session_id,
                        "page_id": job.page_id,
                        "epoch_ms": int(time.time() * 1000),
                        "audio_ended_ms": job.audio_ended_ms,
                        "decode_ms": round(max_step_decode_ms, 2),
                        "provider": "local",
                        "model_version": STT_MODEL_VERSION,
                        "audio_quality": job.audio_quality,
                    }
                )

            if session.stopped:
                break

            # 2. Decode latest rolling interim (coalesced; stale interims superseded automatically).
            # Always prioritize pending finalized flushes ahead of rolling interim decodes.
            if session.pending_flushes:
                session.decode_event.set()
                continue

            target_seq = session.latest_interim_seq
            if (
                target_seq > session.last_decoded_interim_seq
                and session.in_speech
                and session.seg_total_samples >= _WS_INTERIM_MIN_SPEECH_SAMPLES
            ):
                session.last_decoded_interim_seq = target_seq
                win_audio, origin_sample, committed, last_end = session._snapshot_window()
                seg_id = session.segment_id
                turn_id = session.turn_id
                sess_id = session.session_id
                page_id = session.page_id
                total_seg_samples = session.seg_total_samples
                audio_ended_ms = round(
                    session.total_samples_received / _WS_TARGET_SR * 1000.0
                )
                quality = session._build_quality()

                await runtime.stt_semaphore.acquire()
                runtime.active_stt_jobs += 1
                try:
                    if session.pending_flushes or not session.in_speech or session.segment_id != seg_id:
                        if session.pending_flushes:
                            session.decode_event.set()
                        continue
                    _txt, win_words, decode_ms = await asyncio.to_thread(
                        decode_stt_window_sync,
                        win_audio,
                        lead_pad_s=0.12,
                        trail_pad_s=0.12,
                    )
                finally:
                    runtime.active_stt_jobs -= 1
                    runtime.stt_semaphore.release()

                # Only discard if the segment already flushed/ended before this decode finished.
                # Never discard a completed interim just because newer audio arrived mid-decode
                # (otherwise continuous speech starves interims until final flush!).
                if (
                    not session.in_speech
                    or session.segment_id != seg_id
                    or any(j.segment_id == seg_id for j in session.pending_flushes)
                ):
                    continue

                # Advance active window origin in O(1) while still on the same active segment
                new_committed, new_origin, new_last_end = _advance_bounded_window(
                    seg_total_samples=total_seg_samples,
                    window_origin_sample=origin_sample,
                    committed_words=committed,
                    window_words=win_words,
                    last_committed_end_s=last_end,
                )
                if new_origin > session.window_origin_sample:
                    session.committed_words = new_committed
                    session.window_origin_sample = new_origin
                    session.last_committed_end_s = new_last_end

                interim_words = _merge_window_words(
                    committed,
                    win_words,
                    origin_sample / float(_WS_TARGET_SR),
                    last_end,
                )
                interim_text = unicodedata.normalize(
                    "NFC", " ".join(w["text"] for w in interim_words).strip()
                )
                await websocket.send_json(
                    {
                        "type": "interim",
                        "text": interim_text,
                        "words": interim_words,
                        "segment_id": seg_id,
                        "turn_id": turn_id,
                        "session_id": sess_id,
                        "page_id": page_id,
                        "epoch_ms": int(time.time() * 1000),
                        "audio_ended_ms": audio_ended_ms,
                        "decode_ms": round(decode_ms, 2),
                        "provider": "local",
                        "model_version": STT_MODEL_VERSION,
                        "audio_quality": quality,
                    }
                )

    decode_task = asyncio.create_task(_decode_and_emit_loop())
    try:
        while True:
            msg = await websocket.receive()
            msg_type = msg.get("type")
            if msg_type == "websocket.disconnect":
                session.enqueue_flush(carry_tail=False)
                session.stopped = True
                session.decode_event.set()
                break

            raw_bytes = msg.get("bytes")
            if raw_bytes is not None:
                usable_len = len(raw_bytes) - (len(raw_bytes) % 2)
                if usable_len > 0:
                    pcm = (
                        np.frombuffer(raw_bytes[:usable_len], dtype="<i2").astype(
                            np.float32
                        )
                        / 32768.0
                    )
                    if session.sample_rate != _WS_TARGET_SR and pcm.size > 0:
                        pcm = await asyncio.to_thread(
                            librosa.resample,
                            pcm,
                            orig_sr=session.sample_rate,
                            target_sr=_WS_TARGET_SR,
                        )
                    session.push_pcm16k(pcm.astype(np.float32, copy=False))
                continue

            raw_text = msg.get("text")
            if raw_text is not None:
                try:
                    ctrl = json.loads(raw_text)
                except Exception:
                    await websocket.send_json(
                        {
                            "type": "error",
                            "code": "INVALID_CONTROL_MESSAGE",
                            "message": "Invalid JSON control frame.",
                            "retryable": False,
                        }
                    )
                    continue

                if not isinstance(ctrl, dict):
                    continue
                action = str(ctrl.get("type") or "").strip().lower()
                if action == "start":
                    new_sess = str(ctrl.get("session_id") or "").strip()[:80]
                    new_page = str(ctrl.get("page_id") or "").strip()[:80]
                    new_turn = str(ctrl.get("turn_id") or "").strip()[:80]
                    if (
                        session.in_speech
                        and (new_sess != session.session_id or new_page != session.page_id)
                    ):
                        session.reset_segment()
                    session.session_id = new_sess or session.session_id
                    session.page_id = new_page or session.page_id
                    session.turn_id = new_turn or session.turn_id
                    sr_val = ctrl.get("sample_rate")
                    if isinstance(sr_val, int) and 8000 <= sr_val <= 96000:
                        session.sample_rate = sr_val
                    lang_val = ctrl.get("language")
                    if isinstance(lang_val, str) and lang_val.strip():
                        session.language = lang_val.strip()[:8]
                    vad_val = str(ctrl.get("vad_mode") or "").strip().lower()
                    if vad_val in ("client", "server"):
                        session.vad_mode = vad_val
                    await websocket.send_json(
                        {
                            "type": "ready",
                            "session_id": session.session_id,
                            "page_id": session.page_id,
                            "turn_id": session.turn_id,
                            "sample_rate": _WS_TARGET_SR,
                            "vad_mode": session.vad_mode,
                            "model_version": STT_MODEL_VERSION,
                            "stt_mode": STT_MODE,
                        }
                    )
                elif action == "flush":
                    flush_turn = str(ctrl.get("turn_id") or "").strip()[:80]
                    next_turn = str(ctrl.get("next_turn_id") or "").strip()[:80]
                    session.enqueue_flush(
                        carry_tail=(session.vad_mode != "client"),
                        turn_id_override=flush_turn or session.turn_id,
                        emit_empty_ack=(session.vad_mode == "client" or bool(flush_turn)),
                    )
                    if next_turn:
                        session.turn_id = next_turn
                    elif flush_turn:
                        session.turn_id = flush_turn
                elif action == "stop":
                    session.enqueue_flush(
                        carry_tail=False,
                        emit_empty_ack=(session.vad_mode == "client" and session.in_speech),
                    )
                    session.stopped = True
                    session.decode_event.set()
                    break
                elif action == "ping":
                    await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        session.stopped = True
        session.decode_event.set()
    finally:
        session.stopped = True
        session.decode_event.set()
        try:
            await asyncio.wait_for(decode_task, timeout=10.0)
        except Exception:
            if not decode_task.done():
                decode_task.cancel()
                await asyncio.gather(decode_task, return_exceptions=True)
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VIREAD_VOICE_WORKER_HOST", "127.0.0.1")
    port = int(os.environ.get("VIREAD_VOICE_WORKER_PORT", "8010"))
    uvicorn.run(app, host=host, port=port, log_level="info", timeout_keep_alive=65)
