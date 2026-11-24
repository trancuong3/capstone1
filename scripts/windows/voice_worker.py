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
import io
import json
import logging
import os
import re
import time
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import av
import librosa
import numpy as np
from scipy import signal as scipy_signal
import sherpa_onnx
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [voice_worker] %(message)s",
)
logger = logging.getLogger("viread.voice_worker")

STT_MODEL_VERSION = "sherpa-onnx-zipformer-vi-30m-int8-2026-02-09"
TTS_PRECISION = os.environ.get("VIREAD_VOICE_TTS_PRECISION", "int8").strip().lower()
if TTS_PRECISION not in ("fp32", "int8"):
    TTS_PRECISION = "int8"
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

MAX_AUDIO_BYTES = 15 * 1024 * 1024
MAX_TEXT_CHARS = 5000
QUEUE_WAIT_SECONDS = 40.0
TTS_MEM_CACHE_MAX_ENTRIES = 128
_TTS_MEM_CACHE: OrderedDict[str, tuple[bytes, float]] = OrderedDict()


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


class PhonicsStepRequestItem(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    spoken_text: str = Field(min_length=1, max_length=240)
    pause_after_ms: int = Field(default=400, ge=80, le=2000)


class PhonicsSynthesisRequest(BaseModel):
    steps: list[PhonicsStepRequestItem] = Field(min_length=1, max_length=12)
    voice_id: str = Field(default=DEFAULT_VOICE_ID, min_length=1, max_length=128)
    speed: float = Field(default=1.0, ge=0.7, le=1.3)


class VoiceRuntimeEngine:
    def __init__(self) -> None:
        self.stt_recognizer: sherpa_onnx.OfflineRecognizer | None = None
        self.tts_engine: Any | None = None
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

    async def ensure_loaded(self) -> None:
        if self.stt_recognizer is not None and self.tts_engine is not None:
            return
        async with self._load_lock:
            if self.stt_recognizer is not None and self.tts_engine is not None:
                return
            await asyncio.to_thread(self.load_models_sync)


runtime = VoiceRuntimeEngine()
app = FastAPI(title="ViRead Local Voice Worker", version="1.0.0")


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
) -> str:
    canonical = json.dumps(
        {
            "provider": "local",
            "voice_id": voice_id,
            "model_version": TTS_MODEL_VERSION,
            "norm_v": 2,
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


def decode_audio_bytes_to_16k_mono(raw_bytes: bytes) -> tuple[np.ndarray, float]:
    if not raw_bytes:
        raise ValueError("Empty audio file")

    # Fast path for WAV / FLAC / OGG Vorbis supported by libsndfile
    try:
        wav, sr = sf.read(io.BytesIO(raw_bytes), dtype="float32", always_2d=False)
        arr = np.asarray(wav, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        if arr.size > 0:
            if sr != 16000:
                arr = librosa.resample(arr, orig_sr=sr, target_sr=16000)
            return arr.astype(np.float32), float(len(arr) / 16000.0)
    except Exception:
        pass

    # Container path (.webm / .ogg Opus / .mp4 / .m4a / .mp3) via PyAV (without metadata_errors)
    container = av.open(io.BytesIO(raw_bytes), mode="r")
    try:
        audio_streams = [s for s in container.streams if s.type == "audio"]
        if not audio_streams:
            raise ValueError("No audio stream found")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        chunks: list[np.ndarray] = []
        for frame in container.decode(audio_streams[0]):
            for out_frame in resampler.resample(frame):
                plane = out_frame.to_ndarray()
                chunks.append(np.asarray(plane[0], dtype=np.float32))
        for out_frame in resampler.resample(None):
            plane = out_frame.to_ndarray()
            chunks.append(np.asarray(plane[0], dtype=np.float32))
        if not chunks:
            return np.zeros(0, dtype=np.float32), 0.0
        merged = np.concatenate(chunks).astype(np.float32)
        return merged, float(len(merged) / 16000.0)
    finally:
        container.close()


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
) -> tuple[bytes, float]:
    syllable_estimate = len(text_nfc.split())
    use_crisp_temp = word_sample or syllable_estimate <= 3
    temp = 0.22 if use_crisp_temp else 0.55
    top_k = 15 if use_crisp_temp else 25

    cache_mode = "word" if use_crisp_temp else "sentence"
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=speed,
        mode=cache_mode,
        payload=text_nfc,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    if wav_cache.is_file() and meta_cache.is_file():
        meta = json.loads(meta_cache.read_text(encoding="utf-8"))
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
    return wav_bytes, duration_s


def synthesize_timed_passage_sync(
    tts_engine: Any,
    text_nfc: str,
    preset: LocalVoicePreset,
    speed: float,
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
        return {
            "audio_base64": base64.b64encode(wav_cache.read_bytes()).decode("ascii"),
            "media_type": "audio/wav",
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
    return {
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
        "media_type": "audio/wav",
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
    key = make_cache_key(
        voice_id=preset.voice_id,
        speed=speed,
        mode="phonics_steps",
        payload=serialized_steps,
    )
    wav_cache = TTS_CACHE_DIR / f"{key}.wav"
    meta_cache = TTS_CACHE_DIR / f"{key}.json"
    if wav_cache.is_file() and meta_cache.is_file():
        meta = json.loads(meta_cache.read_text(encoding="utf-8"))
        return {
            "audio_base64": base64.b64encode(wav_cache.read_bytes()).decode("ascii"),
            "media_type": "audio/wav",
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
    return {
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
        "media_type": "audio/wav",
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
        "provider": "local",
        "stt": {
            "ready": stt_ready,
            "model_version": STT_MODEL_VERSION,
            "active_jobs": runtime.active_stt_jobs,
        },
        "tts": {
            "ready": tts_ready,
            "model_version": TTS_MODEL_VERSION,
            "precision": TTS_PRECISION,
            "voices_count": len(CURATED_VOICES),
            "regions": ["north", "central", "south"],
            "active_jobs": runtime.active_tts_jobs,
        },
    }


@app.get("/voices")
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


@app.post("/tts")
async def post_tts(req: TtsSynthesisRequest) -> Response:
    await runtime.ensure_loaded()
    preset = resolve_strict_voice(req.voice_id)
    text_nfc = normalize_nfc_text(req.text)
    speed = normalize_speed(req.speed)
    word_count = len(WORD_TOKEN_RE.findall(text_nfc))
    cache_mode = "word" if (req.word_sample or word_count <= 3) else "sentence"
    cache_key = make_cache_key(
        voice_id=preset.voice_id,
        speed=speed,
        mode=cache_mode,
        payload=text_nfc,
    )

    # Ultra-fast in-memory LRU cache (< 10ms TTFA, never blocks TTS semaphore)
    mem_hit = _mem_cache_get(cache_key)
    if mem_hit is not None:
        wav_bytes, duration_s = mem_hit
    else:
        try:
            await asyncio.wait_for(
                runtime.tts_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS
            )
        except TimeoutError as exc:
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
                runtime.tts_engine,
                text_nfc,
                preset,
                speed,
                req.word_sample,
            )
        finally:
            runtime.active_tts_jobs -= 1
            runtime.tts_semaphore.release()
        _mem_cache_put(cache_key, (wav_bytes, duration_s))

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-Voice-Provider": "local",
            "X-Resolved-Voice-Id": preset.voice_id,
            "X-Voice-Region": preset.region,
            "X-Voice-Gender": preset.gender,
            "X-Voice-Model-Version": TTS_MODEL_VERSION,
            "X-Voice-Fallback": "0",
            "X-Audio-Duration-Seconds": str(duration_s),
        },
    )


@app.post("/tts/timed")
async def post_tts_timed(req: TtsSynthesisRequest) -> dict[str, Any]:
    await runtime.ensure_loaded()
    preset = resolve_strict_voice(req.voice_id)
    text_nfc = normalize_nfc_text(req.text)
    speed = normalize_speed(req.speed)

    try:
        await asyncio.wait_for(
            runtime.tts_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "VOICE_WORKER_BUSY",
                "message": "Bộ đọc giọng nói trên máy đang bận xử lý câu trước.",
            },
        ) from exc

    runtime.active_tts_jobs += 1
    try:
        return await asyncio.to_thread(
            synthesize_timed_passage_sync,
            runtime.tts_engine,
            text_nfc,
            preset,
            speed,
        )
    finally:
        runtime.active_tts_jobs -= 1
        runtime.tts_semaphore.release()


@app.post("/tts/phonics")
async def post_tts_phonics(req: PhonicsSynthesisRequest) -> dict[str, Any]:
    await runtime.ensure_loaded()
    preset = resolve_strict_voice(req.voice_id)
    speed = normalize_speed(req.speed)

    try:
        await asyncio.wait_for(
            runtime.tts_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "VOICE_WORKER_BUSY",
                "message": "Bộ đánh vần trên máy đang bận xử lý câu trước.",
            },
        ) from exc

    runtime.active_tts_jobs += 1
    try:
        return await asyncio.to_thread(
            synthesize_phonics_steps_sync,
            runtime.tts_engine,
            req.steps,
            preset,
            speed,
        )
    finally:
        runtime.active_tts_jobs -= 1
        runtime.tts_semaphore.release()


@app.post("/stt")
async def post_stt(
    audio_file: UploadFile = File(...),
    language: str = Form(default="vi"),
) -> dict[str, Any]:
    del language
    await runtime.ensure_loaded()
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

    try:
        await asyncio.wait_for(
            runtime.stt_semaphore.acquire(), timeout=QUEUE_WAIT_SECONDS
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "VOICE_WORKER_BUSY",
                "message": "Bộ nhận diện giọng nói trên máy đang bận.",
            },
        ) from exc

    runtime.active_stt_jobs += 1
    try:
        try:
            samples16, duration_s = await asyncio.to_thread(
                decode_audio_bytes_to_16k_mono, raw
            )
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "STT_INVALID_AUDIO",
                    "message": "Định dạng âm thanh không đọc được.",
                },
            ) from exc

        if samples16.size < 400:
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

        def _decode_sync() -> tuple[str, list[dict[str, Any]]]:
            assert runtime.stt_recognizer is not None
            # Child-voice acoustic preprocessing:
            # 1) Remove DC offset + 80Hz Butterworth high-pass filter (strips laptop fan & 50/60Hz hum)
            # 2) RMS-aware gentle AGC so soft-spoken children reach clean speech loudness without clipping
            # 3) Pad 250ms leading + 350ms trailing silence so Zipformer never drops initial/final syllables
            arr = samples16.astype(np.float32, copy=True)
            arr = arr - float(np.mean(arr))
            if arr.size > 32:
                sos = scipy_signal.butter(
                    2, 80.0, btype="highpass", fs=16000.0, output="sos"
                )
                arr = scipy_signal.sosfilt(sos, arr).astype(np.float32)

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
            return txt, words

        text_out, words_out = await asyncio.to_thread(_decode_sync)
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
    uvicorn.run(app, host=host, port=port, log_level="info")
