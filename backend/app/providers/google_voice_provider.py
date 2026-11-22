"""Controlled Google Cloud Speech-to-Text & Text-to-Speech backup adapter.

Credentials remain strictly server-side (`GOOGLE_CLOUD_STT_API_KEY`,
`GOOGLE_CLOUD_TTS_API_KEY`, `GOOGLE_CLOUD_API_KEY`, or `GOOGLE_CLOUD_ACCESS_TOKEN`).
Never logs audio bytes, child transcripts, or secret values.
"""

from __future__ import annotations

import base64
import io
import os
import struct
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


def _detect_google_encoding(filename: str, content_type: str, raw: bytes) -> dict[str, Any]:
    lower_name = filename.lower()
    lower_ct = content_type.lower()
    if raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        # Parse WAV sample rate from fmt chunk if standard PCM
        sr = 16000
        if len(raw) >= 28:
            sr = int(struct.unpack("<I", raw[24:28])[0]) or 16000
        return {"encoding": "LINEAR16", "sampleRateHertz": sr}
    if "webm" in lower_ct or lower_name.endswith(".webm"):
        return {"encoding": "WEBM_OPUS", "sampleRateHertz": 48000}
    if "ogg" in lower_ct or lower_name.endswith(".ogg"):
        return {"encoding": "OGG_OPUS", "sampleRateHertz": 48000}
    if "flac" in lower_ct or lower_name.endswith(".flac"):
        return {"encoding": "FLAC"}
    if "mp3" in lower_ct or "mpeg" in lower_ct or lower_name.endswith(".mp3"):
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

        lang = "vi-VN" if not language_code or language_code.startswith("vi") else language_code
        config: dict[str, Any] = {
            **_detect_google_encoding(filename, content_type, audio),
            "languageCode": lang,
            "enableWordTimeOffsets": True,
            "enableAutomaticPunctuation": False,
            "maxAlternatives": 1,
        }
        if keyterms:
            clean_phrases = [k.strip()[:64] for k in keyterms[:30] if k and k.strip()]
            if clean_phrases:
                config["speechContexts"] = [{"phrases": clean_phrases}]

        body = {
            "config": config,
            "audio": {"content": base64.b64encode(audio).decode("ascii")},
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
            for w in top.get("words") or []:
                wtxt = unicodedata.normalize("NFC", str(w.get("word") or "").strip().lower())
                if not wtxt:
                    continue
                start = _parse_google_duration_seconds(w.get("startTime"))
                end = max(start, _parse_google_duration_seconds(w.get("endTime")))
                words_out.append(
                    {"text": wtxt, "start": round(start, 3), "end": round(end, 3), "logprob": None}
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

        body = {
            "input": {"text": unicodedata.normalize("NFC", text.strip())},
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
                text=str(step["spoken_text"]), voice_id=voice_id, speed=speed
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
