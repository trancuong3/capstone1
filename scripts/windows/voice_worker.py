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
import os
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import av
import librosa
import numpy as np
from scipy import signal as scipy_signal
import sherpa_onnx
import soundfile as sf
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

VOICE_RUNTIME_ROOT = Path(
    os.environ.get("VIREAD_VOICE_RUNTIME_DIR", r"F:\c1\tools\voice-runtime")
)
HF_CACHE_DIR = Path(
    os.environ.get("HF_HOME", str(VOICE_RUNTIME_ROOT / "hf-cache"))
)
os.environ.setdefault("HF_HOME", str(HF_CACHE_DIR))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
if (HF_CACHE_DIR / "hub").is_dir() and any((HF_CACHE_DIR / "hub").iterdir()):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from vieneu import Vieneu  # noqa: E402
from vieneu_utils.core_utils import gaps_to_silence  # noqa: E402
from vieneu_utils.phonemize_text import normalize_to_chunks_v3_with_gaps  # noqa: E402

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
STT_MODEL_VERSION = "sherpa-onnx-zipformer-vi-30m-int8-2026-02-09"
TTS_PRECISION = os.environ.get("VIREAD_VOICE_TTS_PRECISION", "int8").strip().lower()
if TTS_PRECISION not in ("fp32", "int8"):
    TTS_PRECISION = "int8"
TTS_HYBRID_WORD_FP32 = os.environ.get("VIREAD_VOICE_HYBRID_WORD_FP32", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
TTS_MODEL_VERSION = f"vieneu-v3-turbo-onnx-{TTS_PRECISION}-3.8.5"

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
TTS_CACHE_DIR = Path(
    os.environ.get(
        "VIREAD_VOICE_TTS_CACHE_DIR", str(VOICE_RUNTIME_ROOT / "tts-cache")
    )
)
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
TTS_CACHE_MAX_BYTES = max(
    1024 * 1024,
    int(os.environ.get("VIREAD_VOICE_TTS_CACHE_MAX_BYTES", str(500 * 1024 * 1024))),
)
_TTS_DISK_CACHE_LOCK = threading.Lock()

MAX_AUDIO_BYTES = 15 * 1024 * 1024
MAX_TEXT_CHARS = 5000
QUEUE_WAIT_SECONDS = float(os.environ.get("VIREAD_VOICE_QUEUE_WAIT_SECONDS", "25.0"))
STT_QUEUE_WAIT_SECONDS = float(os.environ.get("VIREAD_VOICE_STT_QUEUE_WAIT_SECONDS", "15.0"))
TTS_MEM_CACHE_MAX_ENTRIES = 128
_TTS_MEM_CACHE: OrderedDict[str, tuple[bytes, float]] = OrderedDict()
# Precompute 80Hz high-pass SOS filter once instead of solving filter design per STT call.
_HIGHPASS_80HZ_SOS = scipy_signal.butter(
    2, 80.0, btype="highpass", fs=16000.0, output="sos"
)
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


class VoiceRuntimeEngine:
    def __init__(self) -> None:
        self.stt_recognizer: sherpa_onnx.OfflineRecognizer | None = None
        self.tts_engine: Any | None = None
        self.word_fp32_tts_engine: Any | None = None
        self.stt_semaphore = asyncio.Semaphore(2)
        self.tts_semaphore = asyncio.Semaphore(1)
        self._load_lock = asyncio.Lock()
        self.active_stt_jobs = 0
        self.active_tts_jobs = 0

    def load_models_sync(self) -> None:
        if self.stt_recognizer is None:
            if not (SHERPA_MODEL_DIR / "encoder.int8.onnx").is_file():
                raise RuntimeError(
                    f"Missing Sherpa-ONNX Vietnamese STT model at {SHERPA_MODEL_DIR}"
                )
            t0 = time.perf_counter()
            self.stt_recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=str(SHERPA_MODEL_DIR / "encoder.int8.onnx"),
                decoder=str(SHERPA_MODEL_DIR / "decoder.onnx"),
                joiner=str(SHERPA_MODEL_DIR / "joiner.int8.onnx"),
                tokens=str(SHERPA_MODEL_DIR / "tokens.txt"),
                num_threads=4,
                sample_rate=16000,
                feature_dim=80,
                decoding_method="modified_beam_search",
                max_active_paths=6,
                blank_penalty=-0.05,
            )
            logger.info(
                "Loaded STT (%s) in %.2fs",
                STT_MODEL_VERSION,
                time.perf_counter() - t0,
            )

        if self.tts_engine is None:
            t0 = time.perf_counter()
            self.tts_engine = Vieneu(
                mode="v3turbo",
                backend="onnx",
                precision=TTS_PRECISION,
                threads=4,
            )
            # Warm up once so first child utterance has zero JIT stall
            _ = self.tts_engine.infer(
                "Xin chào.",
                voice="Trúc Ly",
                temperature=0.25,
                top_k=15,
                apply_watermark=False,
            )
            logger.info(
                "Loaded TTS (%s) in %.2fs",
                TTS_MODEL_VERSION,
                time.perf_counter() - t0,
            )

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

    def get_tts_engine_for_mode(self, *, crisp: bool) -> tuple[Any, str]:
        if crisp and TTS_HYBRID_WORD_FP32:
            if self.word_fp32_tts_engine is not None:
                return self.word_fp32_tts_engine, "fp32"
            if TTS_PRECISION == "fp32" and self.tts_engine is not None:
                return self.tts_engine, "fp32"
        return self.tts_engine, TTS_PRECISION

    async def ensure_loaded(self) -> None:
        if self.stt_recognizer is not None and self.tts_engine is not None:
            return
        async with self._load_lock:
            if self.stt_recognizer is not None and self.tts_engine is not None:
                return
            await asyncio.to_thread(self.load_models_sync)


runtime = VoiceRuntimeEngine()


async def _ensure_capability_loaded(capability: Literal["tts", "stt"]) -> None:
    try:
        await runtime.ensure_loaded()
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


_VIET_DIACRITIC_RE = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ"
    r"ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]"
)
_VIET_ONSETS = (
    "ngh", "ng", "nh", "ch", "gh", "gi", "kh", "ph", "qu", "th", "tr",
    "b", "c", "d", "đ", "g", "h", "k", "l", "m", "n", "p", "q", "r", "s", "t", "v", "x", "",
)
_VIET_CODAS = ("nh", "ng", "ch", "c", "m", "n", "p", "t", "")
_VIET_VOWELS = set("aeiouyàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ")
_LATIN_LETTER_VIET_NAMES: dict[str, str] = {
    "A": "a", "B": "bê", "C": "xê", "D": "đê", "E": "e", "F": "ép",
    "G": "gờ", "H": "hát", "I": "i", "J": "di", "K": "ca", "L": "lờ",
    "M": "mờ", "N": "nờ", "O": "o", "P": "pê", "Q": "quy", "R": "rờ",
    "S": "ét", "T": "tê", "U": "u", "V": "vê", "W": "vê kép", "X": "ích",
    "Y": "i", "Z": "dét",
}
_KNOWN_ACRONYMS = {"LEC", "LAB", "PDF", "AI", "TTS", "STT", "OCR", "API", "LAN", "APK", "URL", "HTTP", "HTTPS", "WIFI", "CPU", "GPU", "RAM"}
_YEAR_RANGE_RE = re.compile(r"\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b")
_CODE_HYPHEN_RE = re.compile(r"\b([A-Z]{2,5})-(\d{1,5})\b")
_ALPHA_TOKEN_RE = re.compile(r"[A-Za-zÀ-ỹĐđ]+")
_PHONICS_SINGLE_CHAR_FIX: dict[str, str] = {
    "ă": "á",
    "â": "ớ",
    "đ": "đờ",
}


def _is_likely_vietnamese_syllable(word: str) -> bool:
    lower = unicodedata.normalize("NFC", word).lower()
    if not lower or len(lower) > 8:
        return False
    if _VIET_DIACRITIC_RE.search(lower):
        return True
    if word.upper() in _KNOWN_ACRONYMS:
        return False
    for onset in _VIET_ONSETS:
        if onset and not lower.startswith(onset):
            continue
        rest = lower[len(onset):]
        if not rest:
            continue
        for coda in _VIET_CODAS:
            if coda and not rest.endswith(coda):
                continue
            nucleus = rest[: len(rest) - len(coda)] if coda else rest
            if not nucleus or len(nucleus) > 3:
                continue
            if all(ch in _VIET_VOWELS for ch in nucleus):
                return True
    return False


def _spell_acronym_vietnamese(code: str) -> str:
    return " ".join(_LATIN_LETTER_VIET_NAMES.get(ch, ch.lower()) for ch in code.upper())


def normalize_vietnamese_tts_text(
    text: str,
    *,
    expand_ranges_and_codes: bool = True,
    for_phonics_step: bool = False,
) -> str:
    cleaned = unicodedata.normalize("NFC", text or "").strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r"\s+", " ", cleaned)

    if expand_ranges_and_codes:
        cleaned = _YEAR_RANGE_RE.sub(r"\1 đến \2", cleaned)
        cleaned = _CODE_HYPHEN_RE.sub(
            lambda m: f"{_spell_acronym_vietnamese(m.group(1))} {m.group(2)}", cleaned
        )

    out_parts: list[str] = []
    last_end = 0
    for m in _ALPHA_TOKEN_RE.finditer(cleaned):
        out_parts.append(cleaned[last_end : m.start()])
        token = m.group(0)
        if len(token) >= 2 and token.isupper():
            before_text = cleaned[: m.start()].rstrip()
            is_start = not before_text or before_text[-1] in ".!?:;\n"
            if token in _KNOWN_ACRONYMS:
                out_parts.append(_spell_acronym_vietnamese(token))
            elif _is_likely_vietnamese_syllable(token):
                lower = token.lower()
                out_parts.append(lower[0].upper() + lower[1:] if is_start else lower)
            elif len(token) <= 4 and token.isascii():
                out_parts.append(_spell_acronym_vietnamese(token))
            else:
                out_parts.append(token.lower())
        else:
            out_parts.append(token)
        last_end = m.end()
    out_parts.append(cleaned[last_end:])
    normalized = unicodedata.normalize("NFC", re.sub(r"\s+", " ", "".join(out_parts)).strip())

    if for_phonics_step and normalized.lower() in _PHONICS_SINGLE_CHAR_FIX:
        return _PHONICS_SINGLE_CHAR_FIX[normalized.lower()]
    return normalized


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
) -> str:
    canonical = json.dumps(
        {
            "provider": "local",
            "voice_id": voice_id,
            "model_version": TTS_MODEL_VERSION,
            "precision": precision,
            "norm_v": 3,
            "speed": normalize_speed(speed),
            "mode": mode,
            "payload": unicodedata.normalize("NFC", payload),
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def apply_speed_preserve_pitch(wav: np.ndarray, speed: float) -> np.ndarray:
    spd = normalize_speed(speed)
    if wav.size == 0 or abs(spd - 1.0) < 0.01:
        return wav.astype(np.float32)
    stretched = librosa.effects.time_stretch(wav.astype(np.float32), rate=spd)
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
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


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


def _guess_av_format_hints(
    raw_bytes: bytes,
    *,
    filename: str = "",
    content_type: str = "",
) -> list[str | None]:
    hints: list[str | None] = [None]
    candidates: list[str] = []

    if raw_bytes.startswith(b"RIFF") and raw_bytes[8:12] == b"WAVE":
        candidates.append("wav")
    elif raw_bytes.startswith(b"OggS"):
        candidates.append("ogg")
    elif raw_bytes.startswith(b"\x1a\x45\xdf\xa3"):
        candidates.extend(["webm", "matroska"])
    elif len(raw_bytes) >= 12 and raw_bytes[4:8] == b"ftyp":
        candidates.extend(["mp4", "mov"])
    elif raw_bytes.startswith(b"ID3") or (len(raw_bytes) >= 2 and raw_bytes[0] == 0xFF and (raw_bytes[1] & 0xE0) == 0xE0):
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

    for c in candidates:
        if c not in hints:
            hints.append(c)
    return hints


def decode_audio_bytes_to_16k_mono(
    raw_bytes: bytes,
    *,
    filename: str = "",
    content_type: str = "",
) -> tuple[np.ndarray, float]:
    if not raw_bytes:
        raise ValueError("Empty audio file")

    # Fast path for WAV / FLAC / OGG Vorbis supported by libsndfile
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


def build_stt_words_from_sherpa(
    tokens: list[str],
    timestamps: list[float],
    duration_s: float,
) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    cur_text = ""
    cur_start: float | None = None
    cur_end: float = 0.0

    for idx, raw_tok in enumerate(tokens):
        ts = float(timestamps[idx]) if idx < len(timestamps) else cur_end
        starts_new = raw_tok.startswith(" ") or raw_tok.startswith("▁")
        piece = raw_tok.replace("▁", " ").strip()
        if not piece:
            continue
        if starts_new and cur_text:
            end_val = max(cur_start or 0.0, min(duration_s, ts))
            words.append(
                {
                    "text": unicodedata.normalize("NFC", cur_text.lower()),
                    "start": round(cur_start or 0.0, 3),
                    "end": round(max((cur_start or 0.0) + 0.04, end_val), 3),
                    "type": "word",
                }
            )
            cur_text = piece
            cur_start = ts
            cur_end = ts + 0.08
        else:
            if cur_start is None:
                cur_start = ts
            cur_text += piece
            cur_end = max(cur_end, ts + 0.08)

    if cur_text:
        end_val = min(duration_s, max(cur_end, (cur_start or 0.0) + 0.08))
        words.append(
            {
                "text": unicodedata.normalize("NFC", cur_text.lower()),
                "start": round(cur_start or 0.0, 3),
                "end": round(max(cur_start or 0.0, end_val), 3),
                "type": "word",
            }
        )
    return words


def synthesize_single_utterance_sync(
    tts_engine: Any,
    text_nfc: str,
    preset: LocalVoicePreset,
    speed: float,
    word_sample: bool,
    *,
    precision_override: str | None = None,
) -> tuple[bytes, float]:
    syllable_estimate = len(text_nfc.split())
    use_crisp_temp = word_sample or syllable_estimate <= 3
    temp = 0.22 if use_crisp_temp else 0.55
    top_k = 15 if use_crisp_temp else 25

    cache_mode = "word" if use_crisp_temp else "sentence"
    precision = precision_override or TTS_PRECISION
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=speed,
        mode=cache_mode,
        payload=text_nfc,
        precision=precision,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    if wav_cache.is_file() and meta_cache.is_file():
        meta = json.loads(meta_cache.read_text(encoding="utf-8"))
        _touch_cache_files(wav_cache, meta_cache)
        return wav_cache.read_bytes(), float(meta["duration_seconds"])

    normalized_text = (
        normalize_vietnamese_tts_text(text_nfc, expand_ranges_and_codes=True)
        or text_nfc
    )
    spoken_input = (
        normalized_text if normalized_text[-1] in ".!?" else f"{normalized_text}."
    )
    raw_wav = tts_engine.infer(
        spoken_input,
        voice=preset.preset_name,
        temperature=temp,
        top_k=top_k,
        apply_watermark=False,
    )
    stretched = apply_speed_preserve_pitch(raw_wav, speed)
    padded = pad_edges(
        stretched,
        tts_engine.sample_rate,
        lead_ms=90 if use_crisp_temp else 70,
        tail_ms=220 if use_crisp_temp else 160,
    )
    duration_s = round(float(len(padded) / tts_engine.sample_rate), 3)
    wav_bytes = encode_wav_bytes(padded, tts_engine.sample_rate)

    wav_cache.write_bytes(wav_bytes)
    meta_cache.write_text(
        json.dumps({"duration_seconds": duration_s}, ensure_ascii=False),
        encoding="utf-8",
    )
    prune_tts_cache_dir()
    return wav_bytes, duration_s


def synthesize_timed_passage_sync(
    tts_engine: Any,
    text_nfc: str,
    preset: LocalVoicePreset,
    speed: float,
    *,
    preferred_media_type: str = "audio/wav",
) -> dict[str, Any]:
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=speed,
        mode="timed_passage",
        payload=text_nfc,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    if wav_cache.is_file() and meta_cache.is_file():
        meta = json.loads(meta_cache.read_text(encoding="utf-8"))
        _touch_cache_files(wav_cache, meta_cache)
        out_bytes, out_media_type = encode_audio_bytes_for_media_type(
            wav_cache.read_bytes(), preferred_media_type
        )
        return {
            "audio_base64": base64.b64encode(out_bytes).decode("ascii"),
            "media_type": out_media_type,
            "provider": "local",
            "voice_id": preset.voice_id,
            "region": preset.region,
            "model_version": TTS_MODEL_VERSION,
            "speed": normalize_speed(speed),
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
        raw_chunk = tts_engine.infer(
            chunk_text,
            voice=preset.preset_name,
            temperature=0.52,
            top_k=22,
            apply_watermark=False,
        )
        stretched = apply_speed_preserve_pitch(raw_chunk, speed)
        start_s = cursor_samples / sr
        end_s = (cursor_samples + len(stretched)) / sr
        chunk_spans.append((chunk_text, start_s, end_s))
        assembled.append(stretched)
        cursor_samples += len(stretched)

        if idx < len(silence_secs):
            gap_s = max(0.12, float(silence_secs[idx]) / max(speed, 0.7))
            gap_samples = int(sr * gap_s)
            assembled.append(np.zeros(gap_samples, dtype=np.float32))
            cursor_samples += gap_samples

    assembled.append(np.zeros(tail_samples, dtype=np.float32))
    full_wav = np.concatenate(assembled).astype(np.float32)
    duration_seconds = round(float(len(full_wav) / sr), 3)

    # Align original whitespace-delimited surface words across chunk spans proportionally
    surface_words = WORD_TOKEN_RE.findall(text_nfc)
    chunk_word_lists = [WORD_TOKEN_RE.findall(c) for c, _, _ in chunk_spans]
    total_chunk_words = sum(len(cw) for cw in chunk_word_lists)

    timed_words: list[dict[str, Any]] = []
    if surface_words:
        if total_chunk_words == len(surface_words):
            sw_idx = 0
            for (_, c_start, c_end), c_words in zip(chunk_spans, chunk_word_lists):
                if not c_words:
                    continue
                weights = [max(1, len(re.sub(r"[^\w]", "", w))) for w in c_words]
                w_sum = float(sum(weights))
                span = max(0.05, c_end - c_start)
                acc = c_start
                for w_weight in weights:
                    w_dur = span * (w_weight / w_sum)
                    w_start = min(duration_seconds, max(0.0, acc))
                    w_end = min(duration_seconds, max(w_start, acc + w_dur))
                    timed_words.append(
                        {
                            "word": surface_words[sw_idx],
                            "start": round(w_start, 3),
                            "end": round(w_end, 3),
                        }
                    )
                    acc += w_dur
                    sw_idx += 1
        else:
            active_start = chunk_spans[0][1] if chunk_spans else 0.07
            active_end = (
                chunk_spans[-1][2] if chunk_spans else max(0.1, duration_seconds - 0.16)
            )
            weights = [max(1, len(re.sub(r"[^\w]", "", w))) for w in surface_words]
            w_sum = float(sum(weights))
            span = max(0.05, active_end - active_start)
            acc = active_start
            for word, w_weight in zip(surface_words, weights):
                w_dur = span * (w_weight / w_sum)
                w_start = min(duration_seconds, max(0.0, acc))
                w_end = min(duration_seconds, max(w_start, acc + w_dur))
                timed_words.append(
                    {
                        "word": word,
                        "start": round(w_start, 3),
                        "end": round(w_end, 3),
                    }
                )
                acc += w_dur

    wav_bytes = encode_wav_bytes(full_wav, sr)
    wav_cache.write_bytes(wav_bytes)
    meta_cache.write_text(
        json.dumps(
            {"duration_seconds": duration_seconds, "words": timed_words},
            ensure_ascii=False,
        ),
        encoding="utf-8",
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
        "speed": normalize_speed(speed),
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
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=speed,
        mode="phonics_steps",
        payload=serialized_steps,
        precision=precision,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    if wav_cache.is_file() and meta_cache.is_file():
        meta = json.loads(meta_cache.read_text(encoding="utf-8"))
        _touch_cache_files(wav_cache, meta_cache)
        out_bytes, out_media_type = encode_audio_bytes_for_media_type(
            wav_cache.read_bytes(), preferred_media_type
        )
        return {
            "audio_base64": base64.b64encode(out_bytes).decode("ascii"),
            "media_type": out_media_type,
            "provider": "local",
            "voice_id": preset.voice_id,
            "region": preset.region,
            "model_version": TTS_MODEL_VERSION,
            "speed": normalize_speed(speed),
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
        spoken = clean_step if clean_step[-1] in ".!?" else f"{clean_step}."
        raw_wav = tts_engine.infer(
            spoken,
            voice=preset.preset_name,
            temperature=0.22,
            top_k=15,
            apply_watermark=False,
        )
        stretched = apply_speed_preserve_pitch(raw_wav, speed)
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

    wav_cache.write_bytes(wav_bytes)
    meta_cache.write_text(
        json.dumps(
            {"duration_seconds": duration_seconds, "step_timings": step_timings},
            ensure_ascii=False,
        ),
        encoding="utf-8",
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
        "speed": normalize_speed(speed),
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
            "model_version": STT_MODEL_VERSION,
            "active_jobs": runtime.active_stt_jobs,
        },
        "tts": {
            "ready": tts_ready,
            "model_version": TTS_MODEL_VERSION,
            "precision": TTS_PRECISION,
            "hybrid_word_fp32": TTS_HYBRID_WORD_FP32,
            "cache_max_bytes": TTS_CACHE_MAX_BYTES,
            "voices_count": len(CURATED_VOICES),
            "regions": ["north", "central", "south"],
            "active_jobs": runtime.active_tts_jobs,
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


@app.post("/tts", dependencies=[Depends(require_voice_worker_token)])
async def post_tts(req: TtsSynthesisRequest, request: Request) -> Response:
    await _ensure_capability_loaded("tts")
    preset = resolve_strict_voice(req.voice_id)
    text_nfc = normalize_nfc_text(req.text)
    speed = normalize_speed(req.speed)
    word_count = len(WORD_TOKEN_RE.findall(text_nfc))
    use_crisp_temp = bool(req.word_sample or word_count <= 3)
    cache_mode = "word" if use_crisp_temp else "sentence"
    tts_engine, used_precision = runtime.get_tts_engine_for_mode(crisp=use_crisp_temp)
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
            runtime.tts_engine,
            text_nfc,
            preset,
            speed,
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
    tts_engine, used_precision = runtime.get_tts_engine_for_mode(crisp=True)
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


@app.post("/stt", dependencies=[Depends(require_voice_worker_token)])
async def post_stt(
    request: Request,
    response: Response,
    audio_file: UploadFile = File(...),
    language: str = Form(default="vi"),
    source: str = Form(default=""),
    session_id: str = Form(default=""),
    turn_id: str = Form(default=""),
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
        if is_interim:
            if await request.is_disconnected() or (
                session_key
                and my_interim_seq < _LATEST_INTERIM_SEQ_BY_SESSION.get(session_key, 0)
            ):
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

        def _decode_sync() -> tuple[str, list[dict[str, Any]], float]:
            assert runtime.stt_recognizer is not None
            t_d0 = time.perf_counter()
            # Child-voice acoustic preprocessing:
            # 1) Remove DC offset + precomputed 80Hz Butterworth high-pass filter
            # 2) RMS-aware gentle AGC so soft-spoken children reach clean speech loudness without clipping
            # 3) Pad 250ms leading + 350ms trailing silence so Zipformer never drops initial/final syllables
            arr = samples16.astype(np.float32, copy=True)
            arr = arr - float(np.mean(arr))
            if arr.size > 32:
                arr = scipy_signal.sosfilt(_HIGHPASS_80HZ_SOS, arr).astype(np.float32)

            # Compute RMS over active speech frames (20ms) so leading/trailing silence
            # length never dilutes AGC gain or shifts beam decoding between interim & final.
            frame_len = 320
            n_frames = arr.size // frame_len
            if n_frames > 0:
                frames = arr[: n_frames * frame_len].reshape(n_frames, frame_len)
                frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
                max_frame_rms = float(np.max(frame_rms))
                active_thresh = max(0.002, max_frame_rms * 0.2)
                active_frames = frame_rms[frame_rms >= active_thresh]
                rms = (
                    float(np.sqrt(np.mean(active_frames * active_frames)))
                    if active_frames.size > 0
                    else float(np.sqrt(np.mean(arr * arr)))
                )
            else:
                rms = float(np.sqrt(np.mean(arr * arr))) if arr.size > 0 else 0.0
            peak = float(np.max(np.abs(arr))) if arr.size > 0 else 0.0
            if rms > 0.0004 and peak > 0.0015:
                gain_rms = 0.08 / rms
                gain_peak = 0.92 / peak
                gain = min(15.0, gain_rms, gain_peak)
                if gain > 1.0:
                    arr = np.clip(arr * gain, -0.98, 0.98).astype(np.float32)

            lead_pad_s = 0.25
            trail_pad_s = 0.35
            padded = np.concatenate(
                [
                    np.zeros(int(16000 * lead_pad_s), dtype=np.float32),
                    arr,
                    np.zeros(int(16000 * trail_pad_s), dtype=np.float32),
                ]
            )
            stream = runtime.stt_recognizer.create_stream()
            stream.accept_waveform(16000, padded)
            runtime.stt_recognizer.decode_stream(stream)
            res = stream.result
            txt = unicodedata.normalize("NFC", res.text.strip().lower())
            adjusted_timestamps = [
                max(0.0, float(t) - lead_pad_s) for t in list(res.timestamps)
            ]
            words = build_stt_words_from_sherpa(
                list(res.tokens), adjusted_timestamps, duration_s
            )
            return txt, words, (time.perf_counter() - t_d0) * 1000.0

        text_out, words_out, decode_ms = await asyncio.to_thread(_decode_sync)
        total_ms = (time.perf_counter() - t_req_start) * 1000.0
        response.headers["X-STT-Queue-Ms"] = f"{queue_ms:.2f}"
        response.headers["X-STT-Decode-Ms"] = f"{decode_ms:.2f}"
        response.headers["X-STT-Total-Ms"] = f"{total_ms:.2f}"
        logger.info(
            "stt_ok audio_bytes=%d duration_s=%.3f word_count=%d",
            len(raw),
            duration_s,
            len(words_out),
        )
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


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VIREAD_VOICE_WORKER_HOST", "127.0.0.1")
    port = int(os.environ.get("VIREAD_VOICE_WORKER_PORT", "8010"))
    uvicorn.run(app, host=host, port=port, log_level="info", timeout_keep_alive=65)
