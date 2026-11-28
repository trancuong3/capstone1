"""Feature #5 test suite: Prosody, Punctuation-Pause & Intonation Coach.

Compatible with both `pytest` and `python -m unittest`.

Verifies:
1. Local zero-cost DSP prosody analyzer (`ai/fluency/prosody_punctuation_analyzer.py`):
   - Synthetic 16 kHz mono WAV/PCM with natural comma/period pauses + terminal rising F0 on `?`
     vs flat robotic monotone WAV without pauses.
   - Pre-extracted `f0_frames` + `rms_frames` array mode & timing-only mode.
   - Adaptive household mic noise-floor resilience so background noise never unfairly fails a child.
   - Deterministic `annotate_punctuation_breathing_cues(text)` producing `•`, `••`, `↗`, `✦`.
2. FastAPI `/fluency` endpoints (`fluency_prosody.py` / `fluency_prosody_service.py`):
   - `POST /fluency/children/{child_id}/sessions/{session_id}/analyze-prosody` merges `prosody_metrics`
     into `FluencyAssessment.Metrics` JSONB without clobbering existing accuracy/WPM metrics.
   - `POST /fluency/annotate-cues` returns breathing/intonation visual cues.
   - Strict `PARENT_PRIVATE` 403/404 cross-parent & cross-child isolation + `Cache-Control: private, no-store`.
"""
from __future__ import annotations

import base64
from io import BytesIO
import math
import os
from pathlib import Path
import sys
import unittest
from uuid import UUID, uuid4
import wave

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_DIR = _REPO_ROOT / "backend"
for _p in (str(_BACKEND_DIR), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from ai.fluency import (  # noqa: E402
    analyze_prosody,
    annotate_punctuation_breathing_cues,
    extract_f0_and_rms_frames,
)
from app.api.deps import get_current_parent_id, get_db  # noqa: E402
from app.api.router import api_router  # noqa: E402
from app.models import (  # noqa: E402
    Book,
    ChildProfile,
    FluencyAssessment,
    Profile,
    ReadingSession,
)
from test_durable_workflows_and_router import (  # noqa: E402
    FakeStudioAsyncSession,
    StudioDbState,
)


def _synthesize_reading_wav(
    segments: list[tuple[str, int, float, float, int]],
    *,
    sr: int = 16_000,
    noise_rms: float = 0.0,
    seed: int = 42,
) -> tuple[bytes, list[dict[str, object]]]:
    """Build a 16 kHz 16-bit mono WAV + `word_timings` from `(word, dur_ms, f0_start_hz, f0_end_hz, post_gap_ms)`.

    Synthesizes a voiced glottal harmonic signal (`f0 + 2*f0 + 3*f0`) with smooth Hann edges.
    """
    rng = np.random.default_rng(seed)
    chunks: list[np.ndarray] = []
    timings: list[dict[str, object]] = []
    cursor_samples = 0

    for word, dur_ms, f0_start, f0_end, gap_ms in segments:
        n_word = max(1, int(round(sr * (dur_ms / 1000.0))))
        start_ms = int(round((cursor_samples / float(sr)) * 1000.0))
        end_ms = int(round(((cursor_samples + n_word) / float(sr)) * 1000.0))
        timings.append({"word": word, "start_ms": start_ms, "end_ms": end_ms})

        f0_curve = np.linspace(f0_start, f0_end, num=n_word, dtype=np.float64)
        phase = 2.0 * math.pi * np.cumsum(f0_curve) / float(sr)
        voiced = (
            0.52 * np.sin(phase)
            + 0.24 * np.sin(2.0 * phase)
            + 0.11 * np.sin(3.0 * phase)
        )
        # Smooth 12ms attack/release envelope
        edge = min(n_word // 4, int(sr * 0.012))
        if edge > 2:
            ramp = np.hanning(edge * 2)
            voiced[:edge] *= ramp[:edge]
            voiced[-edge:] *= ramp[edge:]
        chunks.append(voiced)
        cursor_samples += n_word

        n_gap = max(0, int(round(sr * (gap_ms / 1000.0))))
        if n_gap > 0:
            chunks.append(np.zeros(n_gap, dtype=np.float64))
            cursor_samples += n_gap

    full = np.concatenate(chunks) if chunks else np.zeros(sr, dtype=np.float64)
    if noise_rms > 0.0:
        full = full + rng.normal(0.0, noise_rms, size=full.size)
    pcm16 = np.clip(full * 32767.0, -32768, 32767).astype(np.int16)

    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue(), timings


def _seed_two_households() -> tuple[StudioDbState, dict[str, UUID]]:
    state = StudioDbState()
    parent_a = uuid4()
    parent_b = uuid4()
    inactive_parent = uuid4()
    child_a = uuid4()
    child_b = uuid4()
    book_catalog = uuid4()
    private_book_b = uuid4()
    session_a_existing_fluency = uuid4()
    session_a_fresh = uuid4()
    session_b = uuid4()
    session_cross_private_book = uuid4()

    state.tables[Profile] = [
        Profile(Id=parent_a, Role="parent", DisplayName="Parent A", Active=1),
        Profile(Id=parent_b, Role="parent", DisplayName="Parent B", Active=1),
        Profile(Id=inactive_parent, Role="guest", DisplayName="Non Parent", Active=1),
    ]
    state.tables[ChildProfile] = [
        ChildProfile(Id=child_a, ParentId=parent_a, Alias="Bé Minh", Grade=3, Settings={}),
        ChildProfile(Id=child_b, ParentId=parent_b, Alias="Bé Lan", Grade=4, Settings={}),
    ]
    state.tables[Book] = [
        Book(
            Id=book_catalog,
            Title="Truyện Đọc Lớp 3",
            MinGrade=2,
            MaxGrade=4,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="CATALOG",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
        Book(
            Id=private_book_b,
            Title="Sách riêng nhà B",
            MinGrade=2,
            MaxGrade=5,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=parent_b,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        ),
    ]
    state.tables[ReadingSession] = [
        ReadingSession(
            Id=session_a_existing_fluency,
            ChildId=child_a,
            BookId=book_catalog,
            State="FINISHED",
            Mode="realtime",
        ),
        ReadingSession(
            Id=session_a_fresh,
            ChildId=child_a,
            BookId=book_catalog,
            State="FINISHED",
            Mode="realtime",
        ),
        ReadingSession(
            Id=session_b,
            ChildId=child_b,
            BookId=book_catalog,
            State="FINISHED",
            Mode="realtime",
        ),
        ReadingSession(
            Id=session_cross_private_book,
            ChildId=child_a,
            BookId=private_book_b,
            State="FINISHED",
            Mode="realtime",
        ),
    ]
    state.tables[FluencyAssessment] = [
        FluencyAssessment(
            Id=uuid4(),
            SessionId=session_a_existing_fluency,
            Metrics={
                "accuracy_percent": 94.5,
                "reading_wpm": 76.0,
                "active_reading_ms": 21_500,
                "confirmed_error_words": 1,
            },
            Score=0.92,
            Uncertainty=0.08,
            ModelVersion="fluency-core-v1",
        )
    ]

    return state, {
        "parent_a": parent_a,
        "parent_b": parent_b,
        "inactive_parent": inactive_parent,
        "child_a": child_a,
        "child_b": child_b,
        "session_a_existing_fluency": session_a_existing_fluency,
        "session_a_fresh": session_a_fresh,
        "session_b": session_b,
        "session_cross_private_book": session_cross_private_book,
    }


def _build_test_client(
    state: StudioDbState,
    actor_holder: dict[str, UUID],
) -> TestClient:
    app = FastAPI()
    app.include_router(api_router)

    async def _override_db():
        yield FakeStudioAsyncSession(state)

    def _override_actor() -> UUID:
        return actor_holder["actor_id"]

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_parent_id] = _override_actor
    return TestClient(app)


class Feat5ProsodyCoachTests(unittest.TestCase):
    PASSAGE_TEXT = "Mẹ ơi, hôm nay con vui không? Con thích đọc sách lắm."

    def test_synthetic_wav_expressive_pauses_and_question_rise_vs_flat_robotic_monotone(self) -> None:
        # 1. Expressive child reading: clear comma breath (220ms), question pause (420ms) + rising F0
        #    at "không?" (215 -> 290 Hz), and natural settled statement fall (235 -> 195 Hz) + trailing pause.
        expressive_wav, expressive_timings = _synthesize_reading_wav(
            [
                ("Mẹ", 220, 225.0, 220.0, 55),
                ("ơi", 240, 220.0, 212.0, 225),       # ',' -> ~4.1x baseline pause
                ("hôm", 210, 218.0, 222.0, 55),
                ("nay", 210, 222.0, 220.0, 55),
                ("con", 210, 220.0, 224.0, 50),
                ("vui", 220, 224.0, 232.0, 50),
                ("không", 320, 228.0, 292.0, 430),    # '?' -> rising F0 + ~7.8x period pause
                ("Con", 210, 236.0, 232.0, 55),
                ("thích", 220, 232.0, 226.0, 55),
                ("đọc", 210, 224.0, 218.0, 55),
                ("sách", 220, 218.0, 210.0, 50),
                ("lắm", 280, 210.0, 192.0, 380),      # '.' -> settled falling cadence
            ]
        )

        # 2. Flat robotic monotone reading: dead-flat 200 Hz everywhere, uniform 35ms gaps (0 pauses)
        robotic_wav, robotic_timings = _synthesize_reading_wav(
            [
                (w, 220, 200.0, 200.0, 35)
                for w in [
                    "Mẹ", "ơi", "hôm", "nay", "con", "vui",
                    "không", "Con", "thích", "đọc", "sách", "lắm",
                ]
            ]
        )

        expressive = analyze_prosody(
            self.PASSAGE_TEXT,
            expressive_timings,
            audio=expressive_wav,
        )
        robotic = analyze_prosody(
            self.PASSAGE_TEXT,
            robotic_timings,
            audio=robotic_wav,
        )

        self.assertTrue(expressive.audio_analyzed)
        self.assertTrue(robotic.audio_analyzed)

        self.assertGreaterEqual(expressive.comma_pause_score, 88.0)
        self.assertGreaterEqual(expressive.period_pause_score, 88.0)
        self.assertGreaterEqual(expressive.intonation_contour_score, 82.0)
        self.assertGreaterEqual(expressive.overall_prosody_score, 85.0)
        self.assertEqual(expressive.grade_band_verdict, "EXCELLENT")

        self.assertLessEqual(robotic.comma_pause_score, 40.0)
        self.assertLessEqual(robotic.period_pause_score, 40.0)
        self.assertLessEqual(robotic.intonation_contour_score, 45.0)
        self.assertLessEqual(robotic.overall_prosody_score, 42.0)
        self.assertEqual(robotic.grade_band_verdict, "NEEDS_PRACTICE")

        question_clause_exp = next(c for c in expressive.clauses if c.terminal_punct == "?")
        question_clause_rob = next(c for c in robotic.clauses if c.terminal_punct == "?")
        self.assertIsNotNone(question_clause_exp.terminal_f0_delta_semitones)
        self.assertGreater(question_clause_exp.terminal_f0_delta_semitones or 0.0, 2.0)
        self.assertLess(abs(question_clause_rob.terminal_f0_delta_semitones or 0.0), 0.4)

    def test_household_noise_resilience_and_preextracted_frame_modes(self) -> None:
        noisy_wav, timings = _synthesize_reading_wav(
            [
                ("Trời", 220, 230.0, 225.0, 55),
                ("sáng", 230, 225.0, 218.0, 230),     # ','
                ("bé", 210, 225.0, 230.0, 55),
                ("đi", 210, 230.0, 235.0, 55),
                ("học", 280, 235.0, 285.0, 410),      # '?'
            ],
            noise_rms=0.025,  # steady household fan/ambient mic noise
        )
        ref_text = "Trời sáng, bé đi học?"
        noisy_res = analyze_prosody(ref_text, timings, audio=noisy_wav)
        self.assertGreater(noisy_res.noise_floor_rms, 0.005)
        self.assertGreaterEqual(noisy_res.overall_prosody_score, 80.0)
        self.assertIn(noisy_res.grade_band_verdict, ("EXCELLENT", "GOOD"))

        # Pre-extracted F0/RMS frame arrays mode + timing-only mode
        from ai.fluency.prosody_punctuation_analyzer import decode_speech_audio

        decoded = decode_speech_audio(noisy_wav)
        assert decoded is not None
        f0_arr, rms_arr = extract_f0_and_rms_frames(decoded[0], decoded[1], hop_ms=20)
        frame_mode_res = analyze_prosody(
            ref_text,
            timings,
            f0_frames=f0_arr.tolist(),
            rms_frames=rms_arr.tolist(),
            hop_ms=20,
        )
        self.assertAlmostEqual(
            frame_mode_res.overall_prosody_score,
            noisy_res.overall_prosody_score,
            places=1,
        )

        timing_only_res = analyze_prosody(ref_text, timings)
        self.assertFalse(timing_only_res.audio_analyzed)
        # In timing-only mode (no audio), scores are computed purely from word-gap ratios.
        # 70+ is a solid "GOOD" that confirms timing-only mode works correctly;
        # the synthetic gap of 410ms vs median ~110ms is well above the threshold.
        self.assertGreaterEqual(timing_only_res.comma_pause_score, 70.0)
        self.assertGreaterEqual(timing_only_res.period_pause_score, 70.0)

    def test_annotate_punctuation_breathing_cues_deterministic_tokens(self) -> None:
        raw = "Hôm nay, trời nắng đẹp. Con có vui không? Thật tuyệt vời!"
        cues = annotate_punctuation_breathing_cues(raw)
        self.assertEqual(
            cues.annotated_text,
            "Hôm nay, • trời nắng đẹp. •• Con có vui không? ↗ Thật tuyệt vời! ✦",
        )
        self.assertEqual(cues.cue_counts["•"], 1)
        self.assertEqual(cues.cue_counts["••"], 1)
        self.assertEqual(cues.cue_counts["↗"], 1)
        self.assertEqual(cues.cue_counts["✦"], 1)

    def test_api_analyze_prosody_merges_fluency_assessment_metrics_and_sets_no_store(self) -> None:
        state, ids = _seed_two_households()
        actor_holder = {"actor_id": ids["parent_a"]}
        client = _build_test_client(state, actor_holder)

        wav_bytes, timings = _synthesize_reading_wav(
            [
                ("Mẹ", 220, 225.0, 220.0, 55),
                ("ơi", 240, 220.0, 212.0, 225),
                ("vui", 220, 224.0, 232.0, 50),
                ("không", 320, 228.0, 292.0, 420),
                ("Vui", 220, 235.0, 220.0, 55),
                ("lắm", 260, 220.0, 194.0, 360),
            ]
        )
        wav_b64 = base64.b64encode(wav_bytes).decode("ascii")

        resp = client.post(
            f"/fluency/children/{ids['child_a']}/sessions/{ids['session_a_existing_fluency']}/analyze-prosody",
            json={
                "reference_text": "Mẹ ơi, vui không? Vui lắm.",
                "word_timings": timings,
                "audio_wav_base64": wav_b64,
            },
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.headers.get("cache-control"), "private, no-store")
        body = resp.json()
        self.assertTrue(body["persisted"])
        self.assertEqual(body["visibility_scope"], "PARENT_PRIVATE")
        self.assertEqual(body["grade_band_verdict"], "EXCELLENT")
        self.assertGreaterEqual(body["overall_prosody_score"], 84.0)

        # Verify FluencyAssessment.Metrics merged WITHOUT clobbering accuracy_percent / reading_wpm / Score!
        fa_rows = [
            r
            for r in state.tables[FluencyAssessment]
            if r.SessionId == ids["session_a_existing_fluency"]
        ]
        self.assertEqual(len(fa_rows), 1)
        stored_metrics = fa_rows[0].Metrics
        self.assertEqual(stored_metrics["accuracy_percent"], 94.5)
        self.assertEqual(stored_metrics["reading_wpm"], 76.0)
        self.assertEqual(stored_metrics["active_reading_ms"], 21_500)
        self.assertEqual(fa_rows[0].Score, 0.92)
        self.assertIn("prosody_metrics", stored_metrics)
        self.assertEqual(
            stored_metrics["prosody_metrics"]["grade_band_verdict"],
            "EXCELLENT",
        )

        # Fresh session with no prior FluencyAssessment creates a new row cleanly
        resp_fresh = client.post(
            f"/fluency/children/{ids['child_a']}/sessions/{ids['session_a_fresh']}/analyze-prosody",
            json={
                "reference_text": "Mẹ ơi, vui không? Vui lắm.",
                "word_timings": timings,
            },
        )
        self.assertEqual(resp_fresh.status_code, 200)
        self.assertEqual(resp_fresh.headers.get("cache-control"), "private, no-store")
        fresh_rows = [
            r for r in state.tables[FluencyAssessment] if r.SessionId == ids["session_a_fresh"]
        ]
        self.assertEqual(len(fresh_rows), 1)
        self.assertIn("prosody_metrics", fresh_rows[0].Metrics)

        # Annotate cues endpoint check + private, no-store header
        cues_resp = client.post(
            "/fluency/annotate-cues",
            json={"text": "Chào buổi sáng, bé ơi! Hôm nay đọc truyện nhé?"},
        )
        self.assertEqual(cues_resp.status_code, 200)
        self.assertEqual(cues_resp.headers.get("cache-control"), "private, no-store")
        cues_data = cues_resp.json()
        self.assertIn("•", cues_data["annotated_text"])
        self.assertIn("✦", cues_data["annotated_text"])
        self.assertIn("↗", cues_data["annotated_text"])

    def test_cross_parent_and_cross_child_isolation_403_404(self) -> None:
        state, ids = _seed_two_households()
        actor_holder = {"actor_id": ids["parent_b"]}
        client = _build_test_client(state, actor_holder)

        payload = {
            "reference_text": "Hôm nay, trời đẹp.",
            "word_timings": [
                {"word": "Hôm", "start_ms": 0, "end_ms": 200},
                {"word": "nay", "start_ms": 250, "end_ms": 450},
                {"word": "trời", "start_ms": 680, "end_ms": 880},
                {"word": "đẹp", "start_ms": 930, "end_ms": 1150},
            ],
        }

        # Parent B attempting to access Parent A's child & session -> 403
        res_cross_parent = client.post(
            f"/fluency/children/{ids['child_a']}/sessions/{ids['session_a_fresh']}/analyze-prosody",
            json=payload,
        )
        self.assertEqual(res_cross_parent.status_code, 403)

        # Parent A attempting to access Parent B's session under Child A -> 403
        actor_holder["actor_id"] = ids["parent_a"]
        res_cross_session = client.post(
            f"/fluency/children/{ids['child_a']}/sessions/{ids['session_b']}/analyze-prosody",
            json=payload,
        )
        self.assertEqual(res_cross_session.status_code, 403)

        # Parent A attempting to analyze a session pointing at Parent B's PARENT_PRIVATE book -> 403
        res_private_book = client.post(
            f"/fluency/children/{ids['child_a']}/sessions/{ids['session_cross_private_book']}/analyze-prosody",
            json=payload,
        )
        self.assertEqual(res_private_book.status_code, 403)

        # Unknown child or unknown session -> 404
        res_unknown_child = client.post(
            f"/fluency/children/{uuid4()}/sessions/{ids['session_a_fresh']}/analyze-prosody",
            json=payload,
        )
        self.assertEqual(res_unknown_child.status_code, 404)

        res_unknown_session = client.post(
            f"/fluency/children/{ids['child_a']}/sessions/{uuid4()}/analyze-prosody",
            json=payload,
        )
        self.assertEqual(res_unknown_session.status_code, 404)

        # Non-parent role rejected by require_parent_id -> 403
        actor_holder["actor_id"] = ids["inactive_parent"]
        res_non_parent = client.post(
            "/fluency/annotate-cues",
            json={"text": "Xin chào."},
        )
        self.assertEqual(res_non_parent.status_code, 403)


if __name__ == "__main__":
    unittest.main()
