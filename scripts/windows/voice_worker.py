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
import struct
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
        self.tts_engine_fp32: Any | None = None
        self.tts_engine_int8: Any | None = None
        self.stt_semaphore = asyncio.Semaphore(2)
        self.tts_semaphore = asyncio.Semaphore(1)
        self._load_lock = asyncio.Lock()
        self.active_stt_jobs = 0
        self.active_tts_jobs = 0
        self._prewarm_task: asyncio.Task[None] | None = None

    def select_tts_engine(
        self,
        *,
        word_sample: bool = False,
        is_phonics: bool = False,
        word_count: int = 0,
    ) -> tuple[Any, str]:
        if TTS_PRECISION == "fp32":
            assert self.tts_engine_fp32 is not None
            return self.tts_engine_fp32, "fp32"
        if TTS_PRECISION == "int8":
            assert self.tts_engine_int8 is not None
            return self.tts_engine_int8, "int8"
        if is_phonics or word_sample or word_count <= 4:
            if self.tts_engine_fp32 is not None:
                return self.tts_engine_fp32, "fp32"
        if self.tts_engine_int8 is not None:
            return self.tts_engine_int8, "int8"
        assert self.tts_engine is not None
        return self.tts_engine, "fp32"

    def load_models_sync(self) -> None:
        if self.stt_recognizer is None:
            encoder_path = SHERPA_MODEL_DIR / "encoder.int8.onnx"
            if not encoder_path.is_file():
                encoder_path = SHERPA_MODEL_DIR / "encoder.onnx"
            joiner_path = SHERPA_MODEL_DIR / "joiner.int8.onnx"
            if not joiner_path.is_file():
                joiner_path = SHERPA_MODEL_DIR / "joiner.onnx"
            decoder_path = SHERPA_MODEL_DIR / "decoder.onnx"
            if not decoder_path.is_file():
                decoder_path = SHERPA_MODEL_DIR / "decoder.int8.onnx"
            if not encoder_path.is_file() or not decoder_path.is_file():
                raise RuntimeError(
                    f"Missing Sherpa-ONNX Vietnamese STT model at {SHERPA_MODEL_DIR}"
                )
            t0 = time.perf_counter()
            self.stt_recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=str(encoder_path),
                decoder=str(decoder_path),
                joiner=str(joiner_path),
                tokens=str(SHERPA_MODEL_DIR / "tokens.txt"),
                num_threads=4,
                sample_rate=16000,
                feature_dim=80,
                decoding_method="modified_beam_search",
                max_active_paths=4,
                blank_penalty=-0.05,
            )
            logger.info(
                "Loaded STT (%s, mode=%s) in %.2fs",
                STT_MODEL_VERSION,
                STT_MODE,
                time.perf_counter() - t0,
            )

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


_PREWARM_COACHING_PHRASES: tuple[str, ...] = (
    "Con đọc tốt lắm.",
    "Mình cùng đọc tiếp nhé.",
    "Bây giờ con nghe câu hỏi nhé.",
    "Con trả lời đúng rồi, giỏi quá!",
    "Con chọn lại câu trả lời khác nhé.",
)


async def _prewarm_coaching_phrases() -> None:
    """Pre-warm top deterministic coaching/quiz phrases in background when idle."""
    preset = VOICE_BY_ID[DEFAULT_VOICE_ID]
    for phrase in _PREWARM_COACHING_PHRASES:
        await asyncio.sleep(0.25)
        if runtime.tts_engine is None:
            return
        while runtime.active_tts_jobs > 0:
            await asyncio.sleep(0.3)
        try:
            await runtime.tts_semaphore.acquire()
            try:
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
                    active_prec,
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
    model_version: str = TTS_MODEL_VERSION,
) -> str:
    canonical = json.dumps(
        {
            "provider": "local",
            "voice_id": voice_id,
            "model_version": model_version,
            "precision": precision,
            "norm_v": 4,
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
) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    cur_text = ""
    cur_start: float | None = None
    cur_last_tok: float = 0.0

    for idx, raw_tok in enumerate(tokens):
        ts = float(timestamps[idx]) if idx < len(timestamps) else cur_last_tok
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
                }
            )
            cur_text = piece
            cur_start = ts
            cur_last_tok = ts
        else:
            if cur_start is None:
                cur_start = ts
            cur_text += piece
            cur_last_tok = max(cur_last_tok, ts)

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
            "mode": STT_MODE,
            "ws_stream_supported": STT_MODE == "ws",
            "active_jobs": runtime.active_stt_jobs,
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


def preprocess_audio_for_stt(samples16: np.ndarray) -> np.ndarray:
    """Apply DC offset removal, 80Hz high-pass filter, and gentle child-voice AGC."""
    arr = samples16.astype(np.float32, copy=True)
    if arr.size == 0:
        return arr
    arr = arr - float(np.mean(arr))
    if arr.size > 32:
        arr = scipy_signal.sosfilt(_HIGHPASS_80HZ_SOS, arr).astype(np.float32)

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
        rms = float(np.sqrt(np.mean(arr * arr)))
    peak = float(np.max(np.abs(arr)))
    if rms > 0.0004 and peak > 0.0015:
        gain_rms = 0.08 / rms
        gain_peak = 0.92 / peak
        gain = min(15.0, gain_rms, gain_peak)
        if gain > 1.0:
            arr = np.clip(arr * gain, -0.98, 0.98).astype(np.float32)
    return arr


def decode_stt_window_sync(
    samples16: np.ndarray,
    *,
    lead_pad_s: float = 0.20,
    trail_pad_s: float = 0.24,
) -> tuple[str, list[dict[str, Any]], float]:
    """Decode one 16kHz float32 audio window using Sherpa-ONNX Zipformer."""
    assert runtime.stt_recognizer is not None
    t_d0 = time.perf_counter()
    if samples16.size < 400:
        return "", [], (time.perf_counter() - t_d0) * 1000.0
    duration_s = float(samples16.size / 16000.0)
    arr = preprocess_audio_for_stt(samples16)
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
        list(res.tokens),
        adjusted_timestamps,
        duration_s,
        audio_16k=arr,
    )
    return txt, words, (time.perf_counter() - t_d0) * 1000.0


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

        text_out, words_out, decode_ms = await asyncio.to_thread(
            decode_stt_window_sync,
            samples16,
            lead_pad_s=0.25,
            trail_pad_s=0.35,
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
_WS_INTERIM_STEP_SAMPLES = int(_WS_TARGET_SR * 0.12)
_WS_SILENCE_FLUSH_SAMPLES = int(_WS_TARGET_SR * 0.42)
_WS_MIN_FLUSH_SAMPLES = int(_WS_TARGET_SR * 0.12)


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


class _WsSttSession:
    def __init__(self) -> None:
        self.session_id: str = ""
        self.page_id: str = ""
        self.turn_id: str = ""
        self.sample_rate: int = _WS_TARGET_SR
        self.language: str = "vi"
        self.total_samples_received: int = 0
        self.noise_floor: float = 0.0018
        self.pre_roll: np.ndarray = np.zeros(0, dtype=np.float32)

        self.in_speech: bool = False
        self.seg_seq: int = 0
        self.segment_id: str = "ws:seg_0"
        self.seg_chunks: list[np.ndarray] = []
        self.seg_total_samples: int = 0
        self.silence_samples: int = 0
        self.quiet_streak: int = 0
        self.voiced_samples: int = 0
        self.sum_sq: float = 0.0
        self.peak: float = 0.0

        self.window_origin_sample: int = 0
        self.committed_words: list[dict[str, Any]] = []
        self.last_committed_end_s: float = 0.0
        self.last_interim_sample: int = 0
        self.latest_interim_seq: int = 0
        self.last_decoded_interim_seq: int = 0
        self.pending_flushes: list[_PendingFlushJob] = []
        self.decode_event = asyncio.Event()
        self.stopped: bool = False

    def _build_quality(self) -> dict[str, Any]:
        active_ms = round(
            max(0.0, (self.seg_total_samples - self.silence_samples) / _WS_TARGET_SR * 1000.0)
        )
        rms = float(np.sqrt(self.sum_sq / max(1, self.seg_total_samples)))
        status = "OK"
        if active_ms < 80:
            status = "AUDIO_TOO_SHORT"
        elif self.peak >= 0.99:
            status = "CLIPPING"
        elif rms < 0.002 and self.peak < 0.01:
            status = "LOW_VOLUME"
        return {
            "status": status,
            "rms": round(rms, 5),
            "peak": round(float(self.peak), 4),
            "speech_duration_ms": active_ms,
        }

    def reset_segment(self, keep_pre_roll: np.ndarray | None = None) -> None:
        self.in_speech = False
        self.seg_chunks = []
        self.seg_total_samples = 0
        self.silence_samples = 0
        self.quiet_streak = 0
        self.voiced_samples = 0
        self.sum_sq = 0.0
        self.peak = 0.0
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

    def enqueue_flush(self, *, carry_tail: bool) -> None:
        if not self.in_speech or self.seg_total_samples < _WS_MIN_FLUSH_SAMPLES:
            self.reset_segment()
            return
        win_audio, origin, committed, last_end = self._snapshot_window()
        full_tail = (
            self.seg_chunks[0][-min(self.silence_samples, _WS_PRE_ROLL_SAMPLES) :]
            if carry_tail and self.seg_chunks and self.silence_samples > 0
            else None
        )
        job = _PendingFlushJob(
            audio_window=win_audio,
            window_origin_sample=origin,
            committed_words=committed,
            last_committed_end_s=last_end,
            segment_id=self.segment_id,
            turn_id=self.turn_id,
            session_id=self.session_id,
            page_id=self.page_id,
            audio_ended_ms=round(self.total_samples_received / _WS_TARGET_SR * 1000.0),
            audio_quality=self._build_quality(),
        )
        self.pending_flushes.append(job)
        self.latest_interim_seq += 1  # Supersede any in-flight interim for this segment
        self.reset_segment(full_tail)
        self.decode_event.set()

    def push_pcm16k(self, chunk: np.ndarray) -> None:
        if chunk.size == 0:
            return
        self.total_samples_received += int(chunk.size)
        sum_sq = float(np.sum(chunk * chunk))
        rms = float(np.sqrt(sum_sq / chunk.size))
        peak = float(np.max(np.abs(chunk)))
        onset_thresh = max(0.0028, self.noise_floor * 2.0)
        hold_thresh = max(0.0016, self.noise_floor * 1.4)
        is_onset = rms >= onset_thresh or peak >= onset_thresh * 3.0
        is_voiced = rms >= hold_thresh or peak >= hold_thresh * 3.0

        if not self.in_speech:
            if is_onset:
                self.in_speech = True
                self.seg_seq += 1
                prefix = self.session_id or "ws"
                self.segment_id = f"{prefix}:seg_{self.seg_seq}"
                self.silence_samples = 0
                self.quiet_streak = 0
                self.sum_sq = sum_sq
                self.peak = peak
                if self.pre_roll.size > 0:
                    self.seg_chunks.append(self.pre_roll)
                    self.seg_total_samples += int(self.pre_roll.size)
                    self.pre_roll = np.zeros(0, dtype=np.float32)
                self.seg_chunks.append(chunk)
                self.seg_total_samples += int(chunk.size)
                self.voiced_samples += int(chunk.size)
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
        if not is_voiced:
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

        if (
            self.silence_samples >= _WS_SILENCE_FLUSH_SAMPLES
            and self.seg_total_samples >= _WS_MIN_FLUSH_SAMPLES
        ):
            self.enqueue_flush(carry_tail=True)
            return

        active_samples = self.seg_total_samples - self.silence_samples
        delta_samples = self.seg_total_samples - self.last_interim_sample
        is_pause_trigger = (
            self.silence_samples >= int(_WS_TARGET_SR * 0.06)
            and active_samples >= _WS_INTERIM_MIN_SPEECH_SAMPLES
            and delta_samples >= int(_WS_TARGET_SR * 0.06)
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

    await runtime.ensure_loaded()
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

            # 2. Decode latest rolling interim (coalesced; stale interims superseded automatically)
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
                    await websocket.send_json(
                        {
                            "type": "ready",
                            "session_id": session.session_id,
                            "page_id": session.page_id,
                            "turn_id": session.turn_id,
                            "sample_rate": _WS_TARGET_SR,
                            "model_version": STT_MODEL_VERSION,
                            "stt_mode": STT_MODE,
                        }
                    )
                elif action == "flush":
                    next_turn = str(ctrl.get("turn_id") or "").strip()[:80]
                    session.enqueue_flush(carry_tail=True)
                    if next_turn:
                        session.turn_id = next_turn
                elif action == "stop":
                    session.enqueue_flush(carry_tail=False)
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
