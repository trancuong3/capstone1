"""Curated Copyright-Clean Vietnamese Children's Karaoke Catalog & Audio/Melody Builder.

Provides 8 primary-school songs (Grades 1–5) aligned with Vietnamese phonics practice:
0. Ngôi sao nhỏ (enriches existing published song with exact 126-note `melody_profile`)
1. Bắc kim thang (Đồng dao dân gian Việt Nam, Grades 1–3)
2. Tập tầm vông (Đồng dao dân gian Việt Nam, Grades 1–2)
3. Chi chi chành chành (Đồng dao dân gian Việt Nam, Grades 1–2)
4. Cò lả đồng dao (Dân ca đồng bằng Bắc Bộ, Grades 2–5)
5. Rồng rắn lên mây (Đồng dao dân gian Việt Nam, Grades 1–3)
6. Khúc ca Đánh vần vui (Sáng tác giáo dục ViRead CC0, luyện âm l/n, s/x, tr/ch, Grades 1–2)
7. Vườn xuân lung linh (Sáng tác giáo dục ViRead CC0, luyện từ láy & thanh hỏi/ngã, Grades 3–5)

100% public-domain / CC0 copyright clean; zero external paid APIs.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5
import wave

import numpy as np
from PIL import Image, ImageDraw

from app.schemas.karaoke import Lyrics, MelodyProfileRead
from app.services.karaoke_lyrics import timing_issues
from app.services.karaoke_media_service import inspect_audio, normalize_cover
from app.services.karaoke_melody_extractor import midi_to_hz


@dataclass(frozen=True, slots=True)
class ChildrenSongSpec:
    slug: str
    title: str
    author: str
    min_grade: int
    max_grade: int
    bpm: float
    source_note: str
    usage_note: str
    phonics_focus: str
    palette: tuple[tuple[int, int, int], tuple[int, int, int], tuple[int, int, int]]
    lines: tuple[tuple[str, tuple[int, ...]], ...]

    @property
    def deterministic_song_id(self) -> UUID:
        return uuid5(NAMESPACE_URL, f"viread:karaoke:children-pack:song:{self.slug}")

    @property
    def deterministic_version_id(self) -> UUID:
        return uuid5(NAMESPACE_URL, f"viread:karaoke:children-pack:version:{self.slug}:v1")


NGOI_SAO_NHO_VERSE_MIDIS: tuple[tuple[int, ...], ...] = (
    (60, 60, 67, 67, 69, 69, 67),
    (65, 65, 64, 64, 62, 62, 60),
    (67, 67, 65, 65, 64, 64, 62),
    (67, 67, 65, 65, 64, 64, 62),
    (60, 60, 67, 67, 69, 69, 67),
    (65, 65, 64, 64, 62, 62, 60),
)


CHILDREN_KARAOKE_PACK: tuple[ChildrenSongSpec, ...] = (
    ChildrenSongSpec(
        slug="bac-kim-thang",
        title="Bắc kim thang",
        author="Đồng dao dân gian Việt Nam",
        min_grade=1,
        max_grade=3,
        bpm=100.0,
        source_note="Đồng dao dân gian truyền thống Việt Nam thuộc phạm vi công cộng (Public Domain); hòa âm thiếu nhi bởi ViRead (CC0 1.0).",
        usage_note="Phát trực tuyến và luyện hát theo âm quãng mẫu trong ứng dụng học tập ViRead.",
        phonics_focus="Vần ang / an & thanh hỏi",
        palette=((254, 243, 199), (251, 191, 36), (217, 119, 6)),
        lines=(
            ("Bắc kim thang cà lang bí rợ", (67, 67, 69, 67, 64, 69, 62)),
            ("Cột qua kèo là kèo qua cột", (62, 64, 62, 60, 62, 64, 60)),
            ("Chú bán dầu qua cầu mà té", (69, 69, 67, 69, 67, 64, 69)),
            ("Chú bán ếch ở lại làm chi", (69, 69, 67, 64, 62, 60, 64)),
            ("Con le le đánh trống thổi kèn", (67, 67, 69, 72, 72, 69, 67)),
            ("Con bìm bịp thổi tò tí te", (67, 64, 62, 64, 62, 69, 67)),
            ("Tò tí te cùng nghe vui ghê", (64, 69, 67, 64, 67, 64, 60)),
            ("Bạn bên nhau hát vang câu vè", (62, 64, 67, 69, 67, 64, 60)),
        ),
    ),
    ChildrenSongSpec(
        slug="tap-tam-vong",
        title="Tập tầm vông",
        author="Đồng dao dân gian Việt Nam",
        min_grade=1,
        max_grade=2,
        bpm=104.0,
        source_note="Đồng dao dân gian truyền thống Việt Nam thuộc phạm vi công cộng (Public Domain); hòa âm thiếu nhi bởi ViRead (CC0 1.0).",
        usage_note="Phát trực tuyến và luyện nhịp điệu thiếu nhi trong ứng dụng ViRead.",
        phonics_focus="Âm đầu t / kh & vần ông",
        palette=((224, 242, 254), (56, 189, 248), (2, 132, 199)),
        lines=(
            ("Tập tầm vông tay không tay có", (60, 62, 64, 64, 67, 67, 69)),
            ("Tập tầm vó tay có tay không", (60, 69, 69, 67, 69, 67, 64)),
            ("Mời các bạn đoán sao cho trúng", (62, 69, 62, 69, 67, 64, 69)),
            ("Tập tầm vó tay nào có đố", (60, 64, 69, 67, 64, 69, 67)),
            ("Tay nào không đố bạn tìm ra", (67, 64, 67, 69, 62, 64, 67)),
            ("Có có không không vui cùng bạn", (69, 69, 67, 67, 64, 62, 60)),
            ("Xòe bàn tay nắng mai tươi hồng", (62, 64, 67, 69, 67, 64, 62)),
            ("Cười giòn tan giữa sân trường đông", (62, 64, 67, 69, 64, 62, 60)),
        ),
    ),
    ChildrenSongSpec(
        slug="chi-chi-chanh-chanh",
        title="Chi chi chành chành",
        author="Đồng dao dân gian Việt Nam",
        min_grade=1,
        max_grade=2,
        bpm=102.0,
        source_note="Đồng dao dân gian truyền thống Việt Nam thuộc phạm vi công cộng (Public Domain); hòa âm thiếu nhi bởi ViRead (CC0 1.0).",
        usage_note="Phát trực tuyến và luyện phát âm âm ch / tr cho học sinh tiểu học trong ViRead.",
        phonics_focus="Âm đầu ch / tr & nhịp phách",
        palette=((252, 231, 243), (244, 114, 182), (219, 39, 119)),
        lines=(
            ("Chi chi chành chành", (67, 67, 64, 64)),
            ("Cái đanh thổi lửa", (69, 67, 64, 62)),
            ("Con ngựa đứt cương", (64, 62, 69, 67)),
            ("Ba vương ngũ đế", (67, 67, 64, 69)),
            ("Bắt dế đi tìm", (69, 69, 67, 64)),
            ("Ù à ù ập", (62, 62, 64, 60)),
            ("Nhắm mắt mở ra", (69, 69, 64, 67)),
            ("Cùng cười ha ha", (64, 62, 67, 60)),
        ),
    ),
    ChildrenSongSpec(
        slug="co-la-dong-dao",
        title="Cò lả đồng dao",
        author="Dân ca đồng bằng Bắc Bộ",
        min_grade=2,
        max_grade=5,
        bpm=88.0,
        source_note="Dân ca truyền thống đồng bằng Bắc Bộ thuộc phạm vi công cộng (Public Domain); chuyển soạn thiếu nhi bởi ViRead (CC0 1.0).",
        usage_note="Phát trực tuyến, tập lấy hơi và luyến giọng theo âm quãng mẫu trong ViRead.",
        phonics_focus="Âm đầu l / n & ngân câu mượt",
        palette=((220, 252, 231), (74, 222, 128), (22, 163, 74)),
        lines=(
            ("Con cò bay lả bay la", (60, 62, 64, 64, 67, 67)),
            ("Bay từ cửa phủ bay ra cánh đồng", (67, 64, 64, 64, 67, 69, 72, 67)),
            ("Tình tính tang tang tính tình", (62, 69, 67, 67, 69, 62)),
            ("Bạn ơi rằng có biết không", (60, 64, 62, 69, 67, 64)),
            ("Rằng có nhớ chăng đồng lúa xanh rờn", (62, 69, 69, 67, 64, 69, 67, 62)),
            ("Cánh cò trắng muốt nắng vương trên đồng", (69, 64, 69, 67, 69, 67, 64, 60)),
        ),
    ),
    ChildrenSongSpec(
        slug="rong-ran-len-may",
        title="Rồng rắn lên mây",
        author="Đồng dao dân gian Việt Nam",
        min_grade=1,
        max_grade=3,
        bpm=102.0,
        source_note="Đồng dao dân gian truyền thống Việt Nam thuộc phạm vi công cộng (Public Domain); hòa âm thiếu nhi bởi ViRead (CC0 1.0).",
        usage_note="Phát trực tuyến và luyện âm r / l / n cho học sinh tiểu học trong ViRead.",
        phonics_focus="Âm đầu r / l & thanh hỏi",
        palette=((237, 233, 254), (167, 139, 250), (124, 58, 237)),
        lines=(
            ("Rồng rắn lên mây", (62, 69, 67, 67)),
            ("Có cây lúc lắc", (69, 67, 69, 69)),
            ("Hỏi thăm thầy thuốc", (64, 67, 62, 69)),
            ("Có nhà hay không", (69, 62, 67, 67)),
            ("Bước chân nhịp nhàng", (69, 67, 62, 64)),
            ("Nối đuôi rộn ràng", (69, 67, 62, 64)),
            ("Bạn bè tươi tắn", (62, 62, 67, 69)),
            ("Vui dưới nắng vàng", (67, 69, 69, 60)),
        ),
    ),
    ChildrenSongSpec(
        slug="khuc-ca-danh-van-vui",
        title="Khúc ca Đánh vần vui",
        author="ViRead Âm nhạc Giáo dục (CC0)",
        min_grade=1,
        max_grade=2,
        bpm=96.0,
        source_note="Sáng tác giáo dục gốc của dự án ViRead phát hành theo CC0 1.0 Public Domain Dedication.",
        usage_note="Luyện phát âm chuẩn các cặp phụ âm dễ lẫn l/n, s/x, tr/ch qua giai điệu thiếu nhi.",
        phonics_focus="Phân biệt l/n · s/x · tr/ch",
        palette=((254, 226, 226), (251, 113, 133), (225, 29, 72)),
        lines=(
            ("Lá non lung linh đón nắng vàng", (69, 67, 67, 67, 69, 69, 64)),
            ("Sương sớm xôn xao gió nhẹ sang", (67, 69, 67, 67, 69, 62, 67)),
            ("Chim sẻ chuyền cành trên trúc biếc", (67, 64, 62, 62, 67, 69, 69)),
            ("Bé đọc tròn vành chữ rõ ràng", (69, 62, 62, 62, 64, 64, 60)),
            ("Nắng lên lấp lánh sân trường nhỏ", (69, 67, 69, 69, 67, 62, 64)),
            ("Bạn hiền chăm chỉ nở nụ cười", (62, 62, 67, 64, 64, 62, 60)),
        ),
    ),
    ChildrenSongSpec(
        slug="vuon-xuan-lung-linh",
        title="Vườn xuân lung linh",
        author="ViRead Âm nhạc Giáo dục (CC0)",
        min_grade=3,
        max_grade=5,
        bpm=94.0,
        source_note="Sáng tác giáo dục gốc của dự án ViRead phát hành theo CC0 1.0 Public Domain Dedication.",
        usage_note="Luyện từ láy gợi tả và phân biệt thanh hỏi / ngã qua giai điệu thiếu nhi.",
        phonics_focus="Từ láy & thanh hỏi / ngã",
        palette=((204, 251, 241), (45, 212, 191), (13, 148, 136)),
        lines=(
            ("Vườn xuân rực rỡ muôn sắc hoa", (62, 67, 62, 64, 67, 69, 67)),
            ("Khúc khích chim ca dưới nắng hòa", (69, 69, 67, 67, 69, 69, 62)),
            ("Ríu rít bướm vàng bay lấp lánh", (69, 69, 69, 62, 67, 69, 69)),
            ("Lung linh giọt sương khẽ ngân nga", (67, 67, 62, 67, 64, 67, 67)),
            ("Gió mát dịu dàng qua tán lá", (69, 69, 62, 62, 67, 69, 69)),
            ("Mặt hồ trong trẻo ánh mây xa", (62, 62, 67, 64, 69, 67, 67)),
            ("Tuổi thơ vững chãi thêm khôn lớn", (64, 67, 64, 64, 67, 67, 69)),
            ("Yêu tiếng Việt mình đẹp thiết tha", (67, 69, 62, 62, 62, 69, 60)),
        ),
    ),
)


def build_melody_profile_for_v2_lyrics(
    lyrics_v2: dict[str, Any],
    *,
    line_midis: list[tuple[int, ...]] | tuple[tuple[int, ...], ...],
    duration_ms: int,
    bpm: float,
    hop_ms: int = 80,
) -> dict[str, Any]:
    """Build a `MelodyProfileRead`-valid reference melody profile aligned 1:1 to v2 syllables."""
    lines = lyrics_v2.get("lines") or []
    notes: list[dict[str, Any]] = []
    contour: list[dict[str, Any]] = []
    all_midis: list[float] = []

    for line_idx, line in enumerate(lines):
        line_id = str(line["id"])
        syllables = line.get("syllables") or []
        midi_seq = line_midis[line_idx % len(line_midis)]
        for syl_idx, syl in enumerate(syllables):
            start_ms = int(syl["start_ms"])
            end_ms = int(syl["end_ms"])
            if end_ms <= start_ms:
                continue
            midi_val = float(midi_seq[syl_idx % len(midi_seq)])
            hz_val = round(midi_to_hz(midi_val), 2)
            all_midis.append(midi_val)
            notes.append(
                {
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "midi": midi_val,
                    "hz": hz_val,
                    "confidence": 0.95,
                    "voiced": True,
                    "syllable_id": str(syl["id"]),
                    "line_id": line_id,
                    "text": str(syl["text"]),
                }
            )
            t = start_ms
            while t < end_ms and len(contour) < 2800:
                contour.append(
                    {
                        "time_ms": t,
                        "hz": hz_val,
                        "midi": midi_val,
                        "confidence": 0.95,
                    }
                )
                t += hop_ms

    if not all_midis:
        all_midis = [60.0]
    sorted_midis = sorted(all_midis)
    median_midi = sorted_midis[len(sorted_midis) // 2]
    profile = {
        "melody_version": 1,
        "hop_ms": hop_ms,
        "duration_ms": duration_ms,
        "min_midi": min(sorted_midis),
        "max_midi": max(sorted_midis),
        "median_midi": median_midi,
        "bpm": round(bpm, 1),
        "notes": notes[:1500],
        "pitch_contour": contour[:3000],
    }
    return MelodyProfileRead.model_validate(profile).model_dump(mode="json")


def build_ngoi_sao_nho_melody_profile(
    lyrics_v2: dict[str, Any],
    duration_ms: int = 103_366,
) -> dict[str, Any]:
    """Build exact Twinkle Twinkle reference `melody_profile` for `ngoi-sao-nho-v2.json`."""
    return build_melody_profile_for_v2_lyrics(
        lyrics_v2,
        line_midis=NGOI_SAO_NHO_VERSE_MIDIS,
        duration_ms=duration_ms,
        bpm=88.0,
        hop_ms=80,
    )


def build_timed_lyrics_for_spec(
    spec: ChildrenSongSpec,
    *,
    max_duration_ms: int | None = None,
) -> tuple[dict[str, Any], int]:
    """Generate deterministic v2 syllable timings and planned duration in ms for a `ChildrenSongSpec`."""
    beat_ms = 60_000.0 / spec.bpm
    intro_ms = int(round(beat_ms * 4))  # gentle 4-beat count-in intro
    inter_line_gap_ms = int(round(beat_ms * 1.0))
    cursor_ms = intro_ms
    v2_lines: list[dict[str, Any]] = []

    for line_idx, (line_text, midis) in enumerate(spec.lines, start=1):
        tokens = [tok for tok in line_text.strip().split() if tok]
        if len(tokens) != len(midis):
            raise ValueError(f"Syllable count mismatch in {spec.slug} line {line_idx}")

        line_id = str(
            uuid5(NAMESPACE_URL, f"viread:karaoke:children-pack:{spec.slug}:line:{line_idx}")
        )
        syllables: list[dict[str, Any]] = []
        line_start = cursor_ms
        for syl_idx, token in enumerate(tokens, start=1):
            # Final syllable of each phrase holds 2 beats for comfortable child breathing
            beats = 1.6 if syl_idx == len(tokens) else 0.9
            syl_dur = max(320, int(round(beat_ms * beats)))
            syl_start = cursor_ms
            syl_end = syl_start + syl_dur
            syllables.append(
                {
                    "id": str(
                        uuid5(
                            NAMESPACE_URL,
                            f"viread:karaoke:children-pack:{spec.slug}:syl:{line_idx}:{syl_idx}",
                        )
                    ),
                    "text": token,
                    "start_ms": syl_start,
                    "end_ms": syl_end,
                }
            )
            cursor_ms = syl_end

        v2_lines.append(
            {
                "id": line_id,
                "text": " ".join(tokens),
                "start_ms": line_start,
                "end_ms": cursor_ms,
                "syllables": syllables,
            }
        )
        cursor_ms += inter_line_gap_ms

    planned_total_ms = cursor_ms + int(round(beat_ms * 3))
    if max_duration_ms is not None and max_duration_ms > 0:
        if v2_lines and v2_lines[-1]["end_ms"] > max_duration_ms:
            scale = (max_duration_ms - 400) / float(v2_lines[-1]["end_ms"])
            for ln in v2_lines:
                syls = ln["syllables"]
                for idx_s, s in enumerate(syls):
                    s["start_ms"] = max(0, int(round(s["start_ms"] * scale)))
                    s["end_ms"] = max(s["start_ms"] + 20, int(round(s["end_ms"] * scale)))
                    if idx_s > 0 and s["start_ms"] < syls[idx_s - 1]["end_ms"]:
                        s["start_ms"] = syls[idx_s - 1]["end_ms"]
                        s["end_ms"] = max(s["start_ms"] + 20, s["end_ms"])
                ln["start_ms"] = syls[0]["start_ms"]
                ln["end_ms"] = syls[-1]["end_ms"]
        planned_total_ms = max_duration_ms

    validated = Lyrics.model_validate({"format_version": 2, "lines": v2_lines})
    issues = timing_issues(validated, planned_total_ms)
    if issues:
        raise ValueError(f"Timing issues in {spec.slug}: {issues}")
    return validated.model_dump(mode="json"), planned_total_ms


def synthesize_gentle_children_backing_wav(
    spec: ChildrenSongSpec,
    lyrics_v2: dict[str, Any],
    duration_ms: int,
    *,
    sample_rate: int = 44_100,
) -> bytes:
    """Synthesize a warm marimba + soft electric-piano chord + gentle woodblock backing WAV."""
    total_samples = max(sample_rate, int(round(duration_ms * sample_rate / 1000.0)))
    mix = np.zeros(total_samples, dtype=np.float64)

    # 1. Soft beat woodblock / shaker pulse so children feel the tempo naturally
    beat_sec = 60.0 / spec.bpm
    beat_idx = 0
    t_beat = 0.0
    while int(t_beat * sample_rate) < total_samples - int(0.06 * sample_rate):
        start_i = int(t_beat * sample_rate)
        pulse_len = int(0.045 * sample_rate)
        t_arr = np.arange(pulse_len, dtype=np.float64) / sample_rate
        freq = 880.0 if (beat_idx % 4 == 0) else 660.0
        amp = 0.075 if (beat_idx % 4 == 0) else 0.042
        env = np.exp(-t_arr * 65.0)
        mix[start_i : start_i + pulse_len] += amp * env * np.sin(2.0 * math.pi * freq * t_arr)
        t_beat += beat_sec
        beat_idx += 1

    # 2. Warm marimba lead + soft C-major/pentatonic root-fifth pad per phrase
    lines = lyrics_v2.get("lines") or []
    for line_idx, line in enumerate(lines):
        midi_seq = spec.lines[line_idx % len(spec.lines)][1]
        l_start_i = min(total_samples - 1, int(line["start_ms"] * sample_rate / 1000.0))
        l_end_i = min(total_samples, int(line["end_ms"] * sample_rate / 1000.0))
        if l_end_i > l_start_i + 64:
            pad_len = l_end_i - l_start_i
            t_pad = np.arange(pad_len, dtype=np.float64) / sample_rate
            root_hz = midi_to_hz(48)  # C3 warm bass
            fifth_hz = midi_to_hz(55)  # G3 warm fifth
            fade = np.ones(pad_len, dtype=np.float64)
            ramp = min(int(0.06 * sample_rate), pad_len // 4)
            if ramp > 1:
                fade[:ramp] = np.linspace(0.0, 1.0, ramp)
                fade[-ramp:] = np.linspace(1.0, 0.0, ramp)
            pad_wave = 0.09 * fade * (
                0.65 * np.sin(2.0 * math.pi * root_hz * t_pad)
                + 0.35 * np.sin(2.0 * math.pi * fifth_hz * t_pad)
            )
            mix[l_start_i:l_end_i] += pad_wave

        for syl_idx, syl in enumerate(line.get("syllables") or []):
            s_i = min(total_samples - 1, int(syl["start_ms"] * sample_rate / 1000.0))
            e_i = min(total_samples, int(syl["end_ms"] * sample_rate / 1000.0))
            note_len = e_i - s_i
            if note_len < 32:
                continue
            midi_val = float(midi_seq[syl_idx % len(midi_seq)])
            f0 = midi_to_hz(midi_val)
            t_note = np.arange(note_len, dtype=np.float64) / sample_rate
            attack = np.minimum(1.0, t_note / 0.012)
            decay = np.exp(-t_note * 3.4)
            release_len = min(int(0.025 * sample_rate), note_len // 3)
            env = attack * decay
            if release_len > 1:
                env[-release_len:] *= np.linspace(1.0, 0.0, release_len)
            note_wave = env * (
                0.26 * np.sin(2.0 * math.pi * f0 * t_note)
                + 0.08 * np.sin(2.0 * math.pi * (f0 * 2.0) * t_note)
                + 0.03 * np.sin(2.0 * math.pi * (f0 * 3.0) * t_note)
            )
            mix[s_i:e_i] += note_wave

    peak = float(np.max(np.abs(mix))) if mix.size else 1.0
    if peak > 0.001:
        mix = mix * (0.78 / peak)
    pcm16 = np.clip(np.round(mix * 32767.0), -32767, 32767).astype(np.int16)

    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def transcode_wav_bytes_to_mp3(wav_bytes: bytes) -> bytes:
    """Encode WAV PCM bytes into valid MPEG Layer III MP3 via ffmpeg or Windows Media Foundation."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin:
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                "-f",
                "mp3",
                "pipe:1",
            ],
            input=wav_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=45,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout:
            inspect_audio(proc.stdout)
            return proc.stdout

    if sys.platform == "win32":
        tmp_dir = Path(tempfile.mkdtemp(prefix="viread_karaoke_mp3_"))
        try:
            wav_path = tmp_dir / "source.wav"
            mp3_path = tmp_dir / "encoded.mp3"
            wav_path.write_bytes(wav_bytes)
            ps_script = """
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskProgress = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1' })[0]
Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
Function AwaitProgress($WinRtAction, $ProgressType) {
    $asTask = $asTaskProgress.MakeGenericMethod($ProgressType)
    $netTask = $asTask.Invoke($null, @($WinRtAction))
    $netTask.Wait(-1) | Out-Null
}
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFolder,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.MediaProperties.MediaEncodingProfile,Windows.Media,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Transcoding.MediaTranscoder,Windows.Media,ContentType=WindowsRuntime] | Out-Null

$srcFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('WAV_PATH')) ([Windows.Storage.StorageFile])
$dstFolder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync('TMP_DIR')) ([Windows.Storage.StorageFolder])
$dstFile = Await ($dstFolder.CreateFileAsync('encoded.mp3', [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp3([Windows.Media.MediaProperties.AudioEncodingQuality]::Medium)
$transcoder = New-Object Windows.Media.Transcoding.MediaTranscoder
$prep = Await ($transcoder.PrepareFileTranscodeAsync($srcFile, $dstFile, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
if ($prep.CanTranscode) {
    AwaitProgress ($prep.TranscodeAsync()) ([double])
    Write-Output 'OK'
} else {
    throw ('Transcode failed: ' + $prep.FailureReason)
}
""".replace("WAV_PATH", str(wav_path)).replace("TMP_DIR", str(tmp_dir))
            res = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if res.returncode == 0 and mp3_path.is_file():
                mp3_bytes = mp3_path.read_bytes()
                inspect_audio(mp3_bytes)
                return mp3_bytes
            raise RuntimeError(f"Windows MediaTranscoder failed: {res.stderr.strip()[:240]}")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    raise RuntimeError("No MP3 encoder (ffmpeg or Windows Media Foundation) available")


def render_children_song_cover_webp(spec: ChildrenSongSpec, *, size: int = 512) -> bytes:
    """Render a cheerful pastel geometric illustration cover for a children's song."""
    bg, mid, accent = spec.palette
    img = Image.new("RGB", (size, size), bg)
    draw = ImageDraw.Draw(img)

    # Soft horizon hills + sun/stars + musical note motif
    draw.ellipse((size * 0.58, size * 0.08, size * 0.88, size * 0.38), fill=mid)
    draw.ellipse((-size * 0.2, size * 0.62, size * 0.72, size * 1.18), fill=mid)
    draw.ellipse((size * 0.32, size * 0.68, size * 1.2, size * 1.22), fill=accent)

    # Central friendly music badge
    cx, cy, r = size // 2, int(size * 0.46), int(size * 0.20)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255), outline=accent, width=8)
    # Musical eighth-note pair inside badge
    nx1, nx2 = cx - 26, cx + 24
    ny_top, ny_bot = cy - 38, cy + 28
    draw.line((nx1 + 14, ny_bot, nx1 + 14, ny_top), fill=accent, width=10)
    draw.line((nx2 + 14, ny_bot - 8, nx2 + 14, ny_top - 10), fill=accent, width=10)
    draw.line((nx1 + 14, ny_top, nx2 + 14, ny_top - 10), fill=accent, width=12)
    draw.ellipse((nx1 - 14, ny_bot - 12, nx1 + 18, ny_bot + 14), fill=accent)
    draw.ellipse((nx2 - 14, ny_bot - 20, nx2 + 18, ny_bot + 6), fill=accent)

    png_buf = BytesIO()
    img.save(png_buf, format="PNG")
    return normalize_cover(png_buf.getvalue())


def build_complete_song_bundle(spec: ChildrenSongSpec) -> dict[str, Any]:
    """Synthesize MP3, WebP cover, verified v2 lyrics, and reference `melody_profile`."""
    initial_lyrics, planned_ms = build_timed_lyrics_for_spec(spec)
    wav_bytes = synthesize_gentle_children_backing_wav(spec, initial_lyrics, planned_ms)
    mp3_bytes = transcode_wav_bytes_to_mp3(wav_bytes)
    audio_meta = inspect_audio(mp3_bytes)

    final_lyrics, _ = build_timed_lyrics_for_spec(spec, max_duration_ms=audio_meta.duration_ms)
    melody_profile = build_melody_profile_for_v2_lyrics(
        final_lyrics,
        line_midis=[line_midis for _text, line_midis in spec.lines],
        duration_ms=audio_meta.duration_ms,
        bpm=spec.bpm,
    )
    cover_webp = render_children_song_cover_webp(spec)
    return {
        "spec": spec,
        "mp3_bytes": mp3_bytes,
        "cover_webp": cover_webp,
        "audio_meta": audio_meta,
        "lyrics": final_lyrics,
        "melody_profile": melody_profile,
    }
