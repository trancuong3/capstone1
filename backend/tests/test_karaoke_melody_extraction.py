"""Tests for ViRead Pro Karaoke reference melody extraction, backfill & backward compatibility."""
from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4
import wave

import numpy as np
import pytest
from fastapi import HTTPException

from app.schemas.karaoke import MelodyProfileRead, Playback
from app.services.karaoke_melody_extractor import (
    MELODY_PROFILE_VERSION,
    build_musical_profile_payload,
    extract_melody_profile,
    hz_to_midi,
    midi_to_hz,
)
from app.services.karaoke_service import KaraokeService
from test_karaoke import ADMIN, CHILD, PARENT, MemoryRepository, mp3_fixture


def _synthesize_wav_bytes(
    notes: list[tuple[float, float, float]],
    *,
    sample_rate: int = 22_050,
    duration_s: float = 3.2,
    noise_level: float = 0.005,
    seed: int = 42,
) -> bytes:
    """Create a deterministic mono 16-bit WAV containing harmonic vocal-like notes."""
    rng = np.random.default_rng(seed)
    total_samples = int(round(duration_s * sample_rate))
    signal = rng.normal(0.0, noise_level, size=total_samples).astype(np.float64)
    for start_s, end_s, hz in notes:
        i0 = max(0, int(round(start_s * sample_rate)))
        i1 = min(total_samples, int(round(end_s * sample_rate)))
        if i1 <= i0 or hz <= 0:
            continue
        t = np.arange(i1 - i0, dtype=np.float64) / float(sample_rate)
        # Smooth fade envelope so onset/offset are realistic
        env = np.ones_like(t)
        fade = min(int(0.02 * sample_rate), t.size // 4)
        if fade > 0:
            env[:fade] = np.linspace(0.0, 1.0, fade)
            env[-fade:] = np.linspace(1.0, 0.0, fade)
        # Fundamental + gentle 2nd/3rd harmonics mimicking singing vocal formants
        tone = (
            0.55 * np.sin(2.0 * np.pi * hz * t)
            + 0.22 * np.sin(2.0 * np.pi * 2.0 * hz * t)
            + 0.10 * np.sin(2.0 * np.pi * 3.0 * hz * t)
        )
        signal[i0:i1] += env * tone

    pcm16 = np.clip(signal, -0.98, 0.98)
    pcm16 = (pcm16 * 32767.0).astype(np.int16)
    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def test_extract_melody_profile_accuracy_and_syllable_alignment():
    # C4 (261.63), D4 (293.66), E4 (329.63), G4 (392.00), C5 (523.25)
    target_midis = [60.0, 62.0, 64.0, 67.0, 72.0]
    words = ["Bé", "hát", "vui", "ca", "nào"]
    notes_spec = [
        (0.20 + i * 0.55, 0.65 + i * 0.55, midi_to_hz(m))
        for i, m in enumerate(target_midis)
    ]
    wav_bytes = _synthesize_wav_bytes(notes_spec, duration_s=3.4)

    line_id = str(uuid4())
    syl_ids = [str(uuid4()) for _ in words]
    lyrics_v2 = {
        "format_version": 2,
        "lines": [
            {
                "id": line_id,
                "text": " ".join(words),
                "start_ms": 200,
                "end_ms": 2850,
                "syllables": [
                    {
                        "id": syl_ids[i],
                        "text": words[i],
                        "start_ms": int(round((0.20 + i * 0.55) * 1000)),
                        "end_ms": int(round((0.65 + i * 0.55) * 1000)),
                    }
                    for i in range(len(words))
                ],
            }
        ],
    }

    profile = extract_melody_profile(wav_bytes, lyrics=lyrics_v2, duration_ms=3400)
    assert profile is not None
    validated = MelodyProfileRead.model_validate(profile)
    assert validated.melody_version == MELODY_PROFILE_VERSION
    assert len(validated.notes) == 5
    assert len(validated.pitch_contour) >= 20
    assert validated.min_midi == pytest.approx(60.0, abs=0.4)
    assert validated.max_midi == pytest.approx(72.0, abs=0.4)
    assert validated.median_midi == pytest.approx(64.0, abs=0.5)
    assert validated.bpm is not None and 60.0 <= validated.bpm <= 180.0

    for idx, note in enumerate(validated.notes):
        assert note.syllable_id == syl_ids[idx]
        assert note.line_id == line_id
        assert note.text == words[idx]
        assert note.midi == pytest.approx(target_midis[idx], abs=0.20)
        assert note.confidence >= 0.70

    musical_payload = build_musical_profile_payload(profile, lyrics_v2)
    assert musical_payload["melody_profile"]["melody_version"] == 1
    assert len(musical_payload["beat_grid_ms"]) == 5
    assert len(musical_payload["pitch_contour"]) >= 20


def test_extract_melody_suppresses_isolated_octave_glitches():
    # Sustained A4 (440 Hz = MIDI 69) with a brief 40ms octave-up glitch in the middle
    notes_spec = [
        (0.10, 0.58, 440.0),
        (0.58, 0.62, 880.0),  # 1-frame octave glitch
        (0.62, 1.20, 440.0),
    ]
    wav_bytes = _synthesize_wav_bytes(notes_spec, duration_s=1.4)
    profile = extract_melody_profile(wav_bytes, duration_ms=1400)
    assert profile is not None
    midis = [pt["midi"] for pt in profile["pitch_contour"]]
    assert all(abs(m - hz_to_midi(440.0)) < 0.6 for m in midis), f"Glitch leaked: {midis}"


def test_extract_melody_returns_none_for_silence_and_white_noise():
    silent_wav = _synthesize_wav_bytes([], duration_s=1.5, noise_level=0.0)
    assert extract_melody_profile(silent_wav, duration_ms=1500) is None

    noise_wav = _synthesize_wav_bytes([], duration_s=1.5, noise_level=0.25, seed=99)
    assert extract_melody_profile(noise_wav, duration_ms=1500) is None


@pytest.mark.asyncio
async def test_playback_backward_compatible_and_admin_extract_melody_backfill():
    repo = MemoryRepository()

    wav_bytes = _synthesize_wav_bytes(
        [(0.15, 0.55, 261.63), (0.65, 1.05, 329.63), (1.15, 1.55, 392.00)],
        duration_s=2.0,
    )
    storage = MagicMock()
    storage.verify.return_value = None
    storage.sign.side_effect = lambda path, _song_id: f"https://cdn.example.test/{path}"
    storage.download.return_value = wav_bytes

    service = KaraokeService(repo, storage)
    line_id = uuid4()
    syls = [
        {"id": str(uuid4()), "text": "Bé", "start_ms": 150, "end_ms": 550},
        {"id": str(uuid4()), "text": "hát", "start_ms": 650, "end_ms": 1050},
        {"id": str(uuid4()), "text": "vui", "start_ms": 1150, "end_ms": 1550},
    ]
    lyrics_v2 = {
        "format_version": 2,
        "lines": [
            {
                "id": str(line_id),
                "text": "Bé hát vui",
                "start_ms": 150,
                "end_ms": 1550,
                "syllables": syls,
            }
        ],
    }

    async with repo.write():
        state = await repo.create(
            ADMIN,
            {
                "title": "Bài ca thiếu nhi",
                "author": "Nhạc mẫu",
                "min_grade": 1,
                "max_grade": 5,
                "source_note": "Public domain",
                "usage_note": "Education",
                "lyrics": lyrics_v2,
            },
        )
        song_id = state.song.id
        v = state.draft
        v.state = "PUBLISHED"
        v.audio_path = f"songs/{song_id}/versions/{v.id}/audio/beat.mp3"
        v.audio_sha256 = "a" * 64
        v.timed_audio_sha256 = "a" * 64
        v.audio_size_bytes = len(mp3_fixture())
        v.duration_ms = 2000
        v.reference_audio_path = f"songs/{song_id}/versions/{v.id}/reference/vocal.wav"
        v.reference_audio_sha256 = "b" * 64
        v.reference_audio_size_bytes = len(wav_bytes)
        v.reference_duration_ms = 2000
        state.song.status = "PUBLISHED"
        state.song.published_version_id = v.id

    # 1. Legacy song without melody_profile -> Playback succeeds with melody_profile=None
    legacy_playback = await service.playback(PARENT, song_id, CHILD)
    assert isinstance(legacy_playback, Playback)
    assert legacy_playback.melody_profile is None

    # 2. Non-admin cannot invoke backfill
    with pytest.raises(HTTPException) as exc:
        await service.extract_melody(PARENT, song_id)
    assert exc.value.status_code == 403

    # 3. Admin backfills melody_profile from reference_audio -> persisted & returned in Playback
    extracted = await service.extract_melody(ADMIN, song_id)
    assert extracted.source_audio == "reference_audio"
    assert extracted.persisted is True
    assert extracted.melody_profile is not None
    assert len(extracted.melody_profile.notes) == 3

    upgraded_playback = await service.playback(PARENT, song_id, CHILD)
    assert upgraded_playback.melody_profile is not None
    assert len(upgraded_playback.melody_profile.notes) == 3
    assert upgraded_playback.melody_profile.notes[0].midi == pytest.approx(60.0, abs=0.25)


def test_extract_melody_clamps_300s_boundary_for_schema_validation():
    # Notes near the 300_000ms MAX_DURATION_MS ceiling must clamp seg_end <= 300_000
    wav_bytes = _synthesize_wav_bytes([(0.05, 0.95, 392.0)], duration_s=1.0)
    profile = extract_melody_profile(
        wav_bytes,
        offset_ms=299_100,
        duration_ms=300_000,
        hop_ms=40,
    )
    assert profile is not None
    validated = MelodyProfileRead.model_validate(profile)
    assert all(n.end_ms <= 300_000 for n in validated.notes)
    assert all(pt.time_ms <= 300_000 for pt in validated.pitch_contour)


@pytest.mark.asyncio
async def test_get_musical_profile_missing_table_uses_savepoint_not_outer_rollback():
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock
    from sqlalchemy.exc import ProgrammingError
    from app.repositories.karaoke_practice_repository import KaraokePracticeRepository

    savepoints = 0
    outer_rollbacks = 0

    class FakeDb:
        @asynccontextmanager
        async def begin_nested(self):
            nonlocal savepoints
            savepoints += 1
            yield

        async def scalar(self, *_args, **_kwargs):
            raise ProgrammingError("SELECT ...", {}, Exception('relation "karaoke_musical_profiles" does not exist'))

        async def rollback(self):
            nonlocal outer_rollbacks
            outer_rollbacks += 1

    repo = KaraokePracticeRepository(FakeDb())  # type: ignore[arg-type]
    assert await repo.get_musical_profile(uuid4()) is None
    assert savepoints == 1
    assert outer_rollbacks == 0
