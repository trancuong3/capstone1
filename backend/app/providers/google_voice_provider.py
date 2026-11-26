"""Controlled Google Cloud Speech-to-Text & Text-to-Speech backup adapter.

Credentials remain strictly server-side (`GOOGLE_CLOUD_STT_API_KEY`,
`GOOGLE_CLOUD_TTS_API_KEY`, `GOOGLE_CLOUD_API_KEY`, or `GOOGLE_CLOUD_ACCESS_TOKEN`).
Never logs audio bytes, child transcripts, or secret values.
"""

from __future__ import annotations

import asyncio
import base64
import io
import math
import os
import shutil
import struct
import subprocess
import time
import unicodedata
import wave
from typing import Any

import httpx

from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.local_voice_provider import (
    LocalPhonicsSpeech,
    LocalPhonicsStepTiming,
    LocalSynthesizedAudio,
    LocalTimedSpeech,
    LocalTimedWord,
    LocalTranscription,
)
from app.services.vietnamese_tts_normalizer import normalize_vietnamese_tts_text

GOOGLE_STT_ENDPOINT = "https://speech.googleapis.com/v1/speech:recognize"
GOOGLE_TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize"
GOOGLE_TTS_MODEL_VERSION = "google-cloud-tts-v1"
GOOGLE_STT_MODEL_VERSION = "google-cloud-stt-v1-default"

MAX_GOOGLE_STT_BYTES = 2_500_000  # ~60s synchronous REST safeguard
GOOGLE_TIMEOUT_SECONDS = 8.0

GOOGLE_BACKUP_VOICES: tuple[dict[str, Any], ...] = (
    {
        "voice_id": "google_vi_vn_neural2_a",
        "google_name": "vi-VN-Neural2-A",
        "name": "Google Nữ · Miền Bắc (Dự phòng)",
        "provider": "google",
        "region": "north",
        "region_label": "Miền Bắc",
        "model_version": GOOGLE_TTS_MODEL_VERSION,
        "category": "google_cloud_backup",
        "gender": "female",
        "accent": "Miền Bắc (Google dự phòng)",
        "use_case": "backup_coach",
        "description": "Google dự phòng · Nữ · Miền Bắc",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "google_vi_vn_neural2_d",
        "google_name": "vi-VN-Neural2-D",
        "name": "Google Nam · Miền Bắc (Dự phòng)",
        "provider": "google",
        "region": "north",
        "region_label": "Miền Bắc",
        "model_version": GOOGLE_TTS_MODEL_VERSION,
        "category": "google_cloud_backup",
        "gender": "male",
        "accent": "Miền Bắc (Google dự phòng)",
        "use_case": "backup_coach",
        "description": "Google dự phòng · Nam · Miền Bắc",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "google_vi_vn_wavenet_c",
        "google_name": "vi-VN-Wavenet-C",
        "name": "Google Nữ · Miền Nam (Dự phòng)",
        "provider": "google",
        "region": "south",
        "region_label": "Miền Nam",
        "model_version": GOOGLE_TTS_MODEL_VERSION,
        "category": "google_cloud_backup",
        "gender": "female",
        "accent": "Miền Nam (Google dự phòng)",
        "use_case": "backup_coach",
        "description": "Google dự phòng · Nữ · Miền Nam",
        "preview_url": None,
        "is_default": False,
    },
    {
        "voice_id": "google_vi_vn_wavenet_b",
        "google_name": "vi-VN-Wavenet-B",
        "name": "Google Nam · Miền Nam (Dự phòng)",
        "provider": "google",
        "region": "south",
        "region_label": "Miền Nam",
        "model_version": GOOGLE_TTS_MODEL_VERSION,
        "category": "google_cloud_backup",
        "gender": "male",
        "accent": "Miền Nam (Google dự phòng)",
        "use_case": "backup_coach",
        "description": "Google dự phòng · Nam · Miền Nam",
        "preview_url": None,
        "is_default": False,
    },
)

GOOGLE_VOICE_BY_ID: dict[str, dict[str, Any]] = {
    v["voice_id"]: v for v in GOOGLE_BACKUP_VOICES
}

_stt_cooldown_until: float = 0.0
_tts_cooldown_until: float = 0.0


def reset_google_cooldowns() -> None:
    global _stt_cooldown_until, _tts_cooldown_until
    _stt_cooldown_until = 0.0
    _tts_cooldown_until = 0.0


def _parse_google_duration_seconds(value: Any) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if isinstance(value, str) and value.endswith("s"):
        try:
            return max(0.0, float(value[:-1]))
        except ValueError:
            return 0.0
    if isinstance(value, dict):
        secs = float(value.get("seconds") or 0)
        nanos = float(value.get("nanos") or 0) / 1e9
        return max(0.0, secs + nanos)
    return 0.0


def _is_mp4_m4a_aac(filename: str, content_type: str, raw: bytes) -> bool:
    lower_name = filename.lower()
    lower_ct = content_type.lower()
    if len(raw) >= 8 and raw[4:8] == b"ftyp":
        return True
    if any(ext in lower_name for ext in (".mp4", ".m4a", ".aac")) and (
        lower_name.endswith(".mp4")
        or lower_name.endswith(".m4a")
        or lower_name.endswith(".aac")
    ):
        return True
    if any(tok in lower_ct for tok in ("audio/mp4", "video/mp4", "m4a", "aac")):
        return True
    return False


def _transcode_container_to_wav_16k_sync(raw: bytes) -> bytes | None:
    """Best-effort transcode of MP4/M4A/AAC to 16kHz mono PCM16 WAV for Google STT v1."""
    try:
        import av  # type: ignore[import-not-found]
        import numpy as np

        container = av.open(io.BytesIO(raw), mode="r")
        try:
            audio_streams = [s for s in container.streams if s.type == "audio"]
            if not audio_streams:
                return None
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            pcm_parts: list[bytes] = []
            for frame in container.decode(audio_streams[0]):
                for out_frame in resampler.resample(frame):
                    arr = out_frame.to_ndarray()
                    pcm_parts.append(np.asarray(arr, dtype="<i2").tobytes())
            for out_frame in resampler.resample(None):
                arr = out_frame.to_ndarray()
                pcm_parts.append(np.asarray(arr, dtype="<i2").tobytes())
            if not pcm_parts:
                return None
            return _wrap_pcm16_mono_wav(b"".join(pcm_parts), 16000)
        finally:
            container.close()
    except Exception:
        pass

    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin:
        try:
            proc = subprocess.run(
                [
                    ffmpeg_bin,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    "pipe:0",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-f",
                    "wav",
                    "pipe:1",
                ],
                input=raw,
                capture_output=True,
                timeout=6.0,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout[:4] == b"RIFF":
                return proc.stdout
        except Exception:
            pass
    return None


def _detect_google_encoding(filename: str, content_type: str, raw: bytes) -> dict[str, Any]:
    lower_name = filename.lower()
    lower_ct = content_type.lower()
    if raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        # Parse WAV sample rate from fmt chunk if standard PCM
        sr = 16000
        if len(raw) >= 28:
            sr = int(struct.unpack("<I", raw[24:28])[0]) or 16000
        return {"encoding": "LINEAR16", "sampleRateHertz": sr}
    if _is_mp4_m4a_aac(filename, content_type, raw):
        raise VoiceProviderError(
            status_code=415,
            code="GOOGLE_STT_UNSUPPORTED_AUDIO_FORMAT",
        )
    if "webm" in lower_ct or lower_name.endswith(".webm") or raw[:4] == b"\x1a\x45\xdf\xa3":
        return {"encoding": "WEBM_OPUS", "sampleRateHertz": 48000}
    if "ogg" in lower_ct or lower_name.endswith(".ogg") or raw[:4] == b"OggS":
        return {"encoding": "OGG_OPUS", "sampleRateHertz": 48000}
    if "flac" in lower_ct or lower_name.endswith(".flac") or raw[:4] == b"fLaC":
        return {"encoding": "FLAC"}
    if "mp3" in lower_ct or "mpeg" in lower_ct or lower_name.endswith(".mp3") or raw[:3] == b"ID3":
        return {"encoding": "MP3", "sampleRateHertz": 16000}
    return {"encoding": "WEBM_OPUS", "sampleRateHertz": 48000}


def _wav_duration_and_pcm(wav_bytes: bytes) -> tuple[float, int, bytes]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sr = wf.getframerate()
        nframes = wf.getnframes()
        pcm = wf.readframes(nframes)
        return float(nframes / max(1, sr)), sr, pcm


def _wrap_pcm16_mono_wav(pcm: bytes, sr: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return buf.getvalue()


class GoogleCloudVoiceProvider:
    def __init__(
        self,
        *,
        stt_api_key: str | None = None,
        tts_api_key: str | None = None,
        access_token: str | None = None,
    ) -> None:
        shared_key = os.getenv("GOOGLE_CLOUD_API_KEY", "").strip()
        self._stt_api_key = (
            stt_api_key
            if stt_api_key is not None
            else (os.getenv("GOOGLE_CLOUD_STT_API_KEY", "").strip() or shared_key)
        )
        self._tts_api_key = (
            tts_api_key
            if tts_api_key is not None
            else (os.getenv("GOOGLE_CLOUD_TTS_API_KEY", "").strip() or shared_key)
        )
        self._access_token = (
            access_token
            if access_token is not None
            else os.getenv("GOOGLE_CLOUD_ACCESS_TOKEN", "").strip()
        )

    def is_stt_configured(self) -> bool:
        return bool(self._stt_api_key or self._access_token)

    def is_tts_configured(self) -> bool:
        return bool(self._tts_api_key or self._access_token)

    def is_stt_in_cooldown(self) -> bool:
        return time.monotonic() < _stt_cooldown_until

    def is_tts_in_cooldown(self) -> bool:
        return time.monotonic() < _tts_cooldown_until

    def _auth_headers(self, kind: str) -> dict[str, str]:
        if self._access_token:
            return {"Authorization": f"Bearer {self._access_token}"}
        key = self._stt_api_key if kind == "stt" else self._tts_api_key
        if not key:
            raise VoiceProviderError(
                status_code=503,
                code="GOOGLE_VOICE_UNCONFIGURED",
            )
        return {"X-Goog-Api-Key": key}

    def list_backup_voices(self) -> list[dict[str, Any]]:
        if not self.is_tts_configured():
            return []
        return [
            {k: v for k, v in entry.items() if k != "google_name"}
            for entry in GOOGLE_BACKUP_VOICES
        ]

    async def transcribe(
        self,
        *,
        audio: bytes,
        filename: str,
        content_type: str,
        language_code: str | None = "vi",
        keyterms: list[str] | None = None,
        fallback_reason: str = "LOCAL_STT_UNAVAILABLE",
    ) -> LocalTranscription:
        global _stt_cooldown_until

        if not self.is_stt_configured():
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_STT_UNCONFIGURED"
            )
        if self.is_stt_in_cooldown():
            raise VoiceProviderError(status_code=503, code="GOOGLE_STT_COOLDOWN")
        if len(audio) > MAX_GOOGLE_STT_BYTES:
            raise VoiceProviderError(
                status_code=413, code="GOOGLE_STT_AUDIO_TOO_LONG"
            )

        effective_audio = audio
        effective_filename = filename
        effective_ct = content_type
        if _is_mp4_m4a_aac(filename, content_type, audio):
            transcoded = await asyncio.to_thread(_transcode_container_to_wav_16k_sync, audio)
            if transcoded is not None:
                effective_audio = transcoded
                effective_filename = "recording.wav"
                effective_ct = "audio/wav"

        lang = "vi-VN" if not language_code or language_code.startswith("vi") else language_code
        config: dict[str, Any] = {
            **_detect_google_encoding(effective_filename, effective_ct, effective_audio),
            "languageCode": lang,
            "enableWordTimeOffsets": True,
            "enableWordConfidence": True,
            "enableAutomaticPunctuation": False,
            "maxAlternatives": 1,
        }
        if keyterms:
            clean_phrases = [k.strip()[:64] for k in keyterms[:30] if k and k.strip()]
            if clean_phrases:
                config["speechContexts"] = [{"phrases": clean_phrases, "boost": 12.0}]

        body = {
            "config": config,
            "audio": {"content": base64.b64encode(effective_audio).decode("ascii")},
        }

        try:
            async with httpx.AsyncClient(
                timeout=GOOGLE_TIMEOUT_SECONDS, trust_env=False
            ) as client:
                resp = await client.post(
                    GOOGLE_STT_ENDPOINT,
                    headers=self._auth_headers("stt"),
                    json=body,
                )
        except httpx.TimeoutException as exc:
            _stt_cooldown_until = time.monotonic() + 30.0
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_STT_TIMEOUT"
            ) from exc
        except httpx.HTTPError as exc:
            _stt_cooldown_until = time.monotonic() + 30.0
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_STT_UNAVAILABLE"
            ) from exc

        if resp.status_code in (401, 403):
            _stt_cooldown_until = time.monotonic() + 300.0
            raise VoiceProviderError(status_code=503, code="GOOGLE_STT_AUTH_ERROR")
        if resp.status_code == 429:
            _stt_cooldown_until = time.monotonic() + 120.0
            raise VoiceProviderError(status_code=503, code="STT_QUOTA_EXCEEDED")
        if resp.status_code >= 500:
            _stt_cooldown_until = time.monotonic() + 60.0
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_STT_UNAVAILABLE"
            )
        if resp.status_code >= 400:
            raise VoiceProviderError(
                status_code=502, code="GOOGLE_STT_REJECTED"
            )

        payload = resp.json()
        results = payload.get("results") or []
        transcript_parts: list[str] = []
        words_out: list[dict[str, Any]] = []
        confidences: list[float] = []

        for res in results:
            alts = res.get("alternatives") or []
            if not alts:
                continue
            top = alts[0]
            txt = unicodedata.normalize("NFC", str(top.get("transcript") or "").strip())
            if txt:
                transcript_parts.append(txt)
            conf = top.get("confidence")
            if isinstance(conf, (int, float)) and 0.0 <= conf <= 1.0:
                confidences.append(float(conf))
            alt_conf = (
                float(conf)
                if isinstance(conf, (int, float)) and 0.0 < float(conf) <= 1.0
                else None
            )
            for w in top.get("words") or []:
                wtxt = unicodedata.normalize("NFC", str(w.get("word") or "").strip().lower())
                if not wtxt:
                    continue
                start = _parse_google_duration_seconds(w.get("startTime"))
                end = max(start, _parse_google_duration_seconds(w.get("endTime")))
                raw_wconf = w.get("confidence")
                wconf = (
                    float(raw_wconf)
                    if isinstance(raw_wconf, (int, float)) and 0.0 < float(raw_wconf) <= 1.0
                    else alt_conf
                )
                word_logprob = (
                    round(math.log(max(1e-6, min(1.0, wconf))), 4)
                    if wconf is not None
                    else None
                )
                words_out.append(
                    {
                        "text": wtxt,
                        "start": round(start, 3),
                        "end": round(end, 3),
                        "logprob": word_logprob,
                    }
                )

        avg_conf = (
            round(sum(confidences) / len(confidences), 4) if confidences else None
        )
        return LocalTranscription(
            text=" ".join(transcript_parts).strip(),
            language_code="vi",
            language_probability=avg_conf,
            words=words_out or None,
            provider="google",
            model_version=GOOGLE_STT_MODEL_VERSION,
            fallback_used=True,
            fallback_reason=fallback_reason,
        )

    async def _synthesize_wav_raw(
        self,
        *,
        text: str,
        voice_id: str,
        speed: float,
        for_phonics_step: bool = False,
    ) -> tuple[bytes, dict[str, Any]]:
        global _tts_cooldown_until

        if not self.is_tts_configured():
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_TTS_UNCONFIGURED"
            )
        if self.is_tts_in_cooldown():
            raise VoiceProviderError(status_code=503, code="GOOGLE_TTS_COOLDOWN")

        meta = GOOGLE_VOICE_BY_ID.get(voice_id)
        if meta is None:
            raise VoiceProviderError(status_code=404, code="VOICE_NOT_FOUND")

        normalized_text = normalize_vietnamese_tts_text(
            text, for_phonics_step=for_phonics_step
        ) or unicodedata.normalize("NFC", text.strip())
        body = {
            "input": {"text": normalized_text},
            "voice": {
                "languageCode": "vi-VN",
                "name": meta["google_name"],
            },
            "audioConfig": {
                "audioEncoding": "LINEAR16",
                "sampleRateHertz": 24000,
                "speakingRate": round(min(1.3, max(0.7, float(speed))), 2),
            },
        }

        try:
            async with httpx.AsyncClient(
                timeout=GOOGLE_TIMEOUT_SECONDS, trust_env=False
            ) as client:
                resp = await client.post(
                    GOOGLE_TTS_ENDPOINT,
                    headers=self._auth_headers("tts"),
                    json=body,
                )
        except httpx.TimeoutException as exc:
            _tts_cooldown_until = time.monotonic() + 30.0
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_TTS_TIMEOUT"
            ) from exc
        except httpx.HTTPError as exc:
            _tts_cooldown_until = time.monotonic() + 30.0
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_TTS_UNAVAILABLE"
            ) from exc

        if resp.status_code in (401, 403):
            _tts_cooldown_until = time.monotonic() + 300.0
            raise VoiceProviderError(status_code=503, code="GOOGLE_TTS_AUTH_ERROR")
        if resp.status_code == 429:
            _tts_cooldown_until = time.monotonic() + 120.0
            raise VoiceProviderError(status_code=503, code="TTS_QUOTA_EXCEEDED")
        if resp.status_code >= 500:
            _tts_cooldown_until = time.monotonic() + 60.0
            raise VoiceProviderError(
                status_code=503, code="GOOGLE_TTS_UNAVAILABLE"
            )
        if resp.status_code >= 400:
            raise VoiceProviderError(status_code=502, code="GOOGLE_TTS_REJECTED")

        audio_b64 = resp.json().get("audioContent") or ""
        wav_bytes = base64.b64decode(audio_b64)
        if not wav_bytes:
            raise VoiceProviderError(
                status_code=502, code="GOOGLE_TTS_EMPTY_AUDIO"
            )
        return wav_bytes, meta

    async def synthesize(
        self,
        *,
        text: str,
        voice_id: str,
        speed: float = 1.0,
    ) -> LocalSynthesizedAudio:
        wav_bytes, meta = await self._synthesize_wav_raw(
            text=text, voice_id=voice_id, speed=speed
        )
        return LocalSynthesizedAudio(
            content=wav_bytes,
            content_type="audio/wav",
            resolved_voice_id=meta["voice_id"],
            region=meta["region"],
            model_version=GOOGLE_TTS_MODEL_VERSION,
            provider="google",
            used_fallback_voice=False,
        )

    async def synthesize_timed(
        self,
        *,
        words: list[str],
        voice_id: str,
        speed: float = 1.0,
    ) -> LocalTimedSpeech:
        wav_bytes, meta = await self._synthesize_wav_raw(
            text=" ".join(words), voice_id=voice_id, speed=speed
        )
        duration, _, _ = _wav_duration_and_pcm(wav_bytes)
        duration = max(0.05, round(duration, 3))
        weights = [max(1, len(w)) for w in words]
        total = float(sum(weights))
        cursor = 0.0
        timed_words: list[LocalTimedWord] = []
        for idx, weight in enumerate(weights):
            span = duration * (weight / total)
            start = min(duration, max(0.0, cursor))
            end = min(duration, max(start, cursor + span))
            timed_words.append(
                LocalTimedWord(index=idx, start=round(start, 3), end=round(end, 3))
            )
            cursor += span

        return LocalTimedSpeech(
            audio=wav_bytes,
            content_type="audio/wav",
            duration_seconds=duration,
            words=timed_words,
            resolved_voice_id=meta["voice_id"],
            region=meta["region"],
            model_version=GOOGLE_TTS_MODEL_VERSION,
            provider="google",
            used_fallback_voice=False,
        )

    async def synthesize_phonics(
        self,
        *,
        steps: list[dict[str, Any]],
        voice_id: str,
        speed: float = 1.0,
    ) -> LocalPhonicsSpeech:
        meta = GOOGLE_VOICE_BY_ID.get(voice_id)
        if meta is None:
            raise VoiceProviderError(status_code=404, code="VOICE_NOT_FOUND")

        sr = 24000
        pcm_chunks: list[bytes] = []
        cursor_samples = 0
        timings: list[LocalPhonicsStepTiming] = []

        for idx, step in enumerate(steps):
            wav_bytes, _ = await self._synthesize_wav_raw(
                text=str(step["spoken_text"]),
                voice_id=voice_id,
                speed=speed,
                for_phonics_step=True,
            )
            _, step_sr, pcm = _wav_duration_and_pcm(wav_bytes)
            sr = step_sr
            step_samples = len(pcm) // 2
            start_s = round(cursor_samples / sr, 3)
            end_s = round((cursor_samples + step_samples) / sr, 3)
            timings.append(
                LocalPhonicsStepTiming(
                    id=str(step["id"]),
                    index=idx,
                    start=start_s,
                    end=max(start_s, end_s),
                )
            )
            pcm_chunks.append(pcm)
            cursor_samples += step_samples

            pause_ms = int(step.get("pause_after_ms", 400))
            pause_samples = int(sr * (pause_ms / 1000.0))
            pcm_chunks.append(b"\x00\x00" * pause_samples)
            cursor_samples += pause_samples

        merged_wav = _wrap_pcm16_mono_wav(b"".join(pcm_chunks), sr)
        duration = round(cursor_samples / sr, 3)
        return LocalPhonicsSpeech(
            audio=merged_wav,
            content_type="audio/wav",
            duration_seconds=max(0.05, duration),
            step_timings=timings,
            resolved_voice_id=meta["voice_id"],
            region=meta["region"],
            model_version=GOOGLE_TTS_MODEL_VERSION,
            provider="google",
        )
