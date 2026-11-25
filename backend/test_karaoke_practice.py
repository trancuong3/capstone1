"""Comprehensive tests for Musical Karaoke practice persistence & profiles (G07)."""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api.deps import get_current_parent_id, require_parent_id
from app.api.routes.karaoke_practice import get_karaoke_practice_service, router
from app.models.entertainment_v4 import (
    KaraokeMusicalProfile,
    KaraokePracticeSession,
    LearningSkillEvidence,
)
from app.repositories.karaoke_practice_repository import KaraokePracticeTableUnavailable
from app.services.karaoke_practice_service import (
    KaraokePracticeService,
    derive_musical_profile_from_lyrics,
)

PARENT_A = uuid4()
PARENT_B = uuid4()
CHILD_A = uuid4()
CHILD_B = uuid4()
SONG_ID = uuid4()
VERSION_ID = uuid4()
DRAFT_SONG_ID = uuid4()


def _sample_v2_lyrics():
    return {
        "format_version": 2,
        "lines": [
            {
                "id": str(uuid4()),
                "text": "Bé hát vui ca",
                "start_ms": 1000,
                "end_ms": 3000,
                "syllables": [
                    {"id": str(uuid4()), "text": "Bé", "start_ms": 1000, "end_ms": 1500},
                    {"id": str(uuid4()), "text": "hát", "start_ms": 1500, "end_ms": 2000},
                    {"id": str(uuid4()), "text": "vui", "start_ms": 2000, "end_ms": 2500},
                    {"id": str(uuid4()), "text": "ca", "start_ms": 2500, "end_ms": 3000},
                ],
            },
            {
                "id": str(uuid4()),
                "text": "Nắng mai rực rỡ",
                "start_ms": 3500,
                "end_ms": 5500,
                "syllables": [
                    {"id": str(uuid4()), "text": "Nắng", "start_ms": 3500, "end_ms": 4000},
                    {"id": str(uuid4()), "text": "mai", "start_ms": 4000, "end_ms": 4500},
                    {"id": str(uuid4()), "text": "rực", "start_ms": 4500, "end_ms": 5000},
                    {"id": str(uuid4()), "text": "rỡ", "start_ms": 5000, "end_ms": 5500},
                ],
            },
        ],
    }


class FakePracticeRepository:
    def __init__(self, *, unmigrated: bool = False):
        self.unmigrated = unmigrated
        self.children = {
            (PARENT_A, CHILD_A): SimpleNamespace(Id=CHILD_A, ParentId=PARENT_A, Grade=3, Alias="Bé An"),
            (PARENT_B, CHILD_B): SimpleNamespace(Id=CHILD_B, ParentId=PARENT_B, Grade=2, Alias="Bé Bình"),
        }
        now = datetime.now(timezone.utc)
        published_version = SimpleNamespace(
            id=VERSION_ID,
            song_id=SONG_ID,
            state="PUBLISHED",
            lyrics=_sample_v2_lyrics(),
            updated_at=now,
        )
        self.songs = {
            SONG_ID: (
                SimpleNamespace(id=SONG_ID, status="PUBLISHED", published_version_id=VERSION_ID),
                published_version,
            ),
            DRAFT_SONG_ID: (
                SimpleNamespace(id=DRAFT_SONG_ID, status="DRAFT", published_version_id=None),
                None,
            ),
        }
        self.sessions: list[KaraokePracticeSession] = []
        self.evidence: list[LearningSkillEvidence] = []
        self.profiles: dict[UUID, KaraokeMusicalProfile] = {}

    async def get_child_for_parent(self, parent_id: UUID, child_id: UUID):
        return self.children.get((parent_id, child_id))

    async def get_song_and_published_version(self, song_id: UUID):
        return self.songs.get(song_id)

    async def create_practice_session(self, session_row, evidence_rows):
        if self.unmigrated:
            raise KaraokePracticeTableUnavailable("table missing")
        self.sessions.append(session_row)
        self.evidence.extend(evidence_rows)
        return session_row

    async def list_practice_sessions(self, parent_id, child_id, *, song_id=None, limit=10):
        if self.unmigrated:
            raise KaraokePracticeTableUnavailable("table missing")
        matched = [
            s
            for s in self.sessions
            if s.ParentId == parent_id
            and s.ChildId == child_id
            and (song_id is None or s.SongId == song_id)
        ]
        matched.sort(key=lambda s: s.CreatedAt, reverse=True)
        full_song = [
            s
            for s in matched
            if s.PracticeMode == "FULL_SONG"
            and s.ScoringMode != "INSUFFICIENT_EVIDENCE"
            and s.OverallScore is not None
        ]
        best_score = max((s.OverallScore for s in full_song), default=None)
        best_stars = max((s.Stars for s in full_song), default=0)
        return matched[:limit], len(matched), best_score, best_stars

    async def get_musical_profile(self, song_version_id: UUID):
        if self.unmigrated:
            return None
        return self.profiles.get(song_version_id)


def _make_client(repo: FakePracticeRepository, actor_id: UUID = PARENT_A) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/karaoke")
    service = KaraokePracticeService(repo)
    app.dependency_overrides[require_parent_id] = lambda: actor_id
    app.dependency_overrides[get_current_parent_id] = lambda: actor_id
    app.dependency_overrides[get_karaoke_practice_service] = lambda: service
    return TestClient(app)


def test_create_full_musical_session_records_evidence_and_history():
    repo = FakePracticeRepository()
    client = _make_client(repo, PARENT_A)

    res = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "practice_mode": "FULL_SONG",
            "scoring_mode": "FULL_MUSICAL",
            "playback_rate": 1.0,
            "headphone_mode": True,
            "overall_score": 88,
            "rhythm_score": 90,
            "pitch_score": 85,
            "lyrics_score": 92,
            "fluency_score": 84,
            "stars": 3,
            "report_payload": {
                "pitch_basis": "REFERENCE_MELODY",
                "segments": [
                    {
                        "line_index": 0,
                        "start_ms": 1000,
                        "end_ms": 3000,
                        "text": "Bé hát vui ca",
                        "rhythm_score": 90,
                        "pitch_score": 85,
                        "lyrics_score": 92,
                        "status": "GREAT",
                        "tip_vi": "Tuyệt vời!",
                    }
                ],
            },
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["persisted"] is True
    assert body["overall_score"] == 88
    assert body["stars"] == 3
    assert body["song_version_id"] == str(VERSION_ID)

    # Verify learning_skill_evidence recorded for all 3 musical dimensions.
    assert len(repo.evidence) == 3
    skill_map = {e.SkillKey: e for e in repo.evidence}
    assert set(skill_map.keys()) == {"rhythm_timing", "pitch_melody", "lyric_delivery"}
    assert skill_map["rhythm_timing"].ScoreNormalized == pytest.approx(0.90)
    assert skill_map["pitch_melody"].ScoreNormalized == pytest.approx(0.85)
    assert skill_map["lyric_delivery"].ScoreNormalized == pytest.approx(0.92)
    assert all(e.SourceModule == "KARAOKE" for e in repo.evidence)
    assert all(e.EvidenceType == "OBSERVED" for e in repo.evidence)
    assert all(e.DifficultyLevel == 3 for e in repo.evidence)


def test_segment_practice_never_overwrites_best_full_song_score():
    repo = FakePracticeRepository()
    client = _make_client(repo, PARENT_A)

    # 1. Full song session with 76 points (2 stars).
    r1 = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "practice_mode": "FULL_SONG",
            "scoring_mode": "FULL_MUSICAL",
            "playback_rate": 1.0,
            "overall_score": 76,
            "rhythm_score": 78,
            "pitch_score": 72,
            "lyrics_score": 80,
            "fluency_score": 74,
            "stars": 2,
        },
    )
    assert r1.status_code == 201

    # 2. Segment practice at 0.85x with 99 points (3 stars) MUST NOT overwrite best_full_song_score!
    r2 = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "practice_mode": "SEGMENT",
            "scoring_mode": "FULL_MUSICAL",
            "playback_rate": 0.85,
            "overall_score": 99,
            "rhythm_score": 99,
            "pitch_score": 99,
            "lyrics_score": 99,
            "fluency_score": 99,
            "stars": 3,
            "segment_start_ms": 1000,
            "segment_end_ms": 3000,
        },
    )
    assert r2.status_code == 201

    # 3. Rhythm tap session with 95 points MUST NOT overwrite best_full_song_score!
    r3 = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "practice_mode": "RHYTHM_TAP",
            "scoring_mode": "RHYTHM_AND_LYRICS",
            "playback_rate": 1.0,
            "overall_score": 95,
            "rhythm_score": 96,
            "pitch_score": None,
            "lyrics_score": None,
            "fluency_score": 90,
            "stars": 3,
        },
    )
    assert r3.status_code == 201

    history = client.get(
        f"/karaoke/practice-sessions?child_id={CHILD_A}&song_id={SONG_ID}&limit=10"
    )
    assert history.status_code == 200
    data = history.json()
    assert data["total_sessions"] == 3
    assert data["best_full_song_score"] == 76
    assert data["best_full_song_stars"] == 2
    assert len(data["items"]) == 3


def test_insufficient_evidence_never_writes_skill_evidence():
    repo = FakePracticeRepository()
    client = _make_client(repo, PARENT_A)

    res = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "practice_mode": "FULL_SONG",
            "scoring_mode": "INSUFFICIENT_EVIDENCE",
            "overall_score": None,
            "rhythm_score": None,
            "pitch_score": None,
            "lyrics_score": None,
            "fluency_score": None,
            "stars": 0,
            "report_payload": {"gate_reason": "SILENCE"},
        },
    )
    assert res.status_code == 201
    assert len(repo.sessions) == 1
    assert len(repo.evidence) == 0


def test_rejects_raw_audio_and_conflated_scores():
    repo = FakePracticeRepository()
    client = _make_client(repo, PARENT_A)

    # Extra top-level raw audio field rejected.
    r_extra = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "scoring_mode": "FULL_MUSICAL",
            "overall_score": 80,
            "raw_audio": "AAAA",
        },
    )
    assert r_extra.status_code == 422

    # Nested raw audio key inside report_payload rejected.
    r_nested = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "scoring_mode": "FULL_MUSICAL",
            "overall_score": 80,
            "report_payload": {"debug": {"audio_base64": "UklGRg=="}},
        },
    )
    assert r_nested.status_code == 422

    # LYRICS_ONLY claiming pitch_score rejected.
    r_lyrics = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "scoring_mode": "LYRICS_ONLY",
            "overall_score": 80,
            "pitch_score": 85,
            "lyrics_score": 80,
        },
    )
    assert r_lyrics.status_code == 422

    # RHYTHM_AND_LYRICS claiming pitch_score rejected.
    r_rhythm = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "scoring_mode": "RHYTHM_AND_LYRICS",
            "overall_score": 75,
            "rhythm_score": 75,
            "pitch_score": 70,
        },
    )
    assert r_rhythm.status_code == 422

    # INSUFFICIENT_EVIDENCE claiming overall_score rejected.
    r_insuff = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "scoring_mode": "INSUFFICIENT_EVIDENCE",
            "overall_score": 50,
            "stars": 1,
        },
    )
    assert r_insuff.status_code == 422


def test_idor_blocks_access_to_foreign_child():
    repo = FakePracticeRepository()
    client = _make_client(repo, PARENT_A)

    r_post = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_B),
            "song_id": str(SONG_ID),
            "scoring_mode": "LYRICS_ONLY",
            "overall_score": 85,
            "lyrics_score": 85,
            "stars": 3,
        },
    )
    assert r_post.status_code == 404

    r_get = client.get(f"/karaoke/practice-sessions?child_id={CHILD_B}")
    assert r_get.status_code == 404


def test_graceful_degradation_when_v4_tables_unmigrated():
    repo = FakePracticeRepository(unmigrated=True)
    client = _make_client(repo, PARENT_A)

    r_post = client.post(
        "/karaoke/practice-sessions",
        json={
            "child_id": str(CHILD_A),
            "song_id": str(SONG_ID),
            "scoring_mode": "FULL_MUSICAL",
            "overall_score": 82,
            "rhythm_score": 84,
            "pitch_score": 80,
            "lyrics_score": 82,
            "fluency_score": 80,
            "stars": 2,
        },
    )
    assert r_post.status_code == 201
    assert r_post.json()["persisted"] is False
    assert r_post.json()["storage_notice"] == "KARAOKE_PRACTICE_STORAGE_UNAVAILABLE"

    r_get = client.get(f"/karaoke/practice-sessions?child_id={CHILD_A}")
    assert r_get.status_code == 200
    assert r_get.json()["storage_ready"] is False
    assert r_get.json()["items"] == []

    # Musical profile still works deterministically from lyrics!
    r_prof = client.get(f"/karaoke/songs/{SONG_ID}/musical-profile")
    assert r_prof.status_code == 200
    prof = r_prof.json()
    assert prof["source_method"] == "LYRICS_TIMING"
    assert prof["has_beat_grid"] is True
    assert prof["beat_grid_ms"] == [1000, 1500, 2000, 2500, 3500, 4000, 4500, 5000]
    assert prof["bpm"] == pytest.approx(120.0)


def test_musical_profile_returns_stored_profile_or_404_for_draft():
    repo = FakePracticeRepository()
    repo.profiles[VERSION_ID] = KaraokeMusicalProfile(
        SongVersionId=VERSION_ID,
        Bpm=108.5,
        AudioType="DUAL_TRACK",
        HasPitchContour=True,
        HasBeatGrid=True,
        SourceMethod="AUDIO_DSP",
        ProfileJson={
            "beat_grid_ms": [1000, 1553, 2106, 2659],
            "pitch_contour": [
                {"time_ms": 1000, "hz": 261.63, "midi": 60.0},
                {"time_ms": 1553, "hz": 293.66, "midi": 62.0},
            ],
        },
        UpdatedAt=datetime.now(timezone.utc),
    )
    client = _make_client(repo, PARENT_A)

    res = client.get(f"/karaoke/songs/{SONG_ID}/musical-profile")
    assert res.status_code == 200
    data = res.json()
    assert data["bpm"] == pytest.approx(108.5)
    assert data["audio_type"] == "DUAL_TRACK"
    assert data["has_pitch_contour"] is True
    assert data["source_method"] == "AUDIO_DSP"
    assert len(data["pitch_contour"]) == 2
    assert data["pitch_contour"][0]["hz"] == pytest.approx(261.63)

    # Draft/unpublished song returns 404.
    r_draft = client.get(f"/karaoke/songs/{DRAFT_SONG_ID}/musical-profile")
    assert r_draft.status_code == 404


def test_derive_musical_profile_handles_v1_line_only_lyrics():
    beats, bpm, phrases = derive_musical_profile_from_lyrics(
        {
            "format_version": 1,
            "lines": [
                {"id": "l1", "text": "Một hai ba bốn", "start_ms": 0, "end_ms": 2000},
                {"id": "l2", "text": "Năm sáu bảy tám", "start_ms": 2000, "end_ms": 4000},
            ],
        }
    )
    assert len(beats) == 8
    assert beats[0] == 0
    assert beats[4] == 2000
    assert bpm == pytest.approx(120.0)
    assert len(phrases) == 2


import unittest


class KaraokePracticeUnittestBridge(unittest.TestCase):
    """Allows standard `python -m unittest` / `scripts/run_ci_tests.py` to execute all tests."""

    def test_01_full_musical_session(self):
        test_create_full_musical_session_records_evidence_and_history()

    def test_02_segment_never_overwrites_full_song_best(self):
        test_segment_practice_never_overwrites_best_full_song_score()

    def test_03_insufficient_evidence_no_skill_write(self):
        test_insufficient_evidence_never_writes_skill_evidence()

    def test_04_rejects_raw_audio_and_conflation(self):
        test_rejects_raw_audio_and_conflated_scores()

    def test_05_idor_blocks_foreign_child(self):
        test_idor_blocks_access_to_foreign_child()

    def test_06_graceful_degradation_unmigrated(self):
        test_graceful_degradation_when_v4_tables_unmigrated()

    def test_07_musical_profile_endpoint(self):
        test_musical_profile_returns_stored_profile_or_404_for_draft()

    def test_08_v1_lyrics_profile_derivation(self):
        test_derive_musical_profile_handles_v1_line_only_lyrics()
