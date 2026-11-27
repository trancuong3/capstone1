"""Business logic for Musical Karaoke practice persistence, evidence & profiles."""

from datetime import datetime, timezone
from statistics import median
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException

from app.models.entertainment_v4 import (
    KaraokePracticeSession,
    LearningSkillEvidence,
)
from app.repositories.karaoke_practice_repository import (
    KaraokePracticeRepository,
    KaraokePracticeTableUnavailable,
)
from app.schemas.karaoke_practice import (
    KaraokePracticeHistoryResponse,
    KaraokePracticeSessionCreate,
    KaraokePracticeSessionRead,
    MusicalProfileRead,
    PitchContourPointRead,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def derive_musical_profile_from_lyrics(
    lyrics_json: dict[str, Any] | None,
) -> tuple[list[int], float | None, list[dict[str, int]]]:
    """Deterministically derive beat grid, BPM, and phrase windows from lyrics timing."""
    if not isinstance(lyrics_json, dict):
        return [], None, []
    lines = lyrics_json.get("lines")
    if not isinstance(lines, list):
        return [], None, []

    beats: list[int] = []
    phrase_windows: list[dict[str, int]] = []

    for line in lines:
        if not isinstance(line, dict):
            continue
        start_ms = line.get("start_ms")
        end_ms = line.get("end_ms")
        if (
            isinstance(start_ms, int)
            and isinstance(end_ms, int)
            and 0 <= start_ms < end_ms
        ):
            phrase_windows.append({"start_ms": start_ms, "end_ms": end_ms})

        syllables = line.get("syllables")
        added_syllable_beat = False
        if isinstance(syllables, list) and syllables:
            for syl in syllables:
                if isinstance(syl, dict) and isinstance(syl.get("start_ms"), int):
                    beats.append(syl["start_ms"])
                    added_syllable_beat = True
        if not added_syllable_beat and isinstance(start_ms, int) and isinstance(end_ms, int) and end_ms > start_ms:
            text = str(line.get("text") or "").strip()
            tokens = [tok for tok in text.split() if tok]
            count = max(1, min(8, len(tokens)))
            step = (end_ms - start_ms) / count
            for idx in range(count):
                beats.append(int(round(start_ms + idx * step)))

    unique_beats = sorted(set(beats))
    if len(unique_beats) < 2:
        return unique_beats, None, phrase_windows

    iois = [
        unique_beats[i] - unique_beats[i - 1]
        for i in range(1, len(unique_beats))
        if 180 <= (unique_beats[i] - unique_beats[i - 1]) <= 1600
    ]
    if not iois:
        return unique_beats, 100.0, phrase_windows

    med_ioi = float(median(iois))
    bpm = 60_000.0 / med_ioi
    while bpm < 72.0:
        bpm *= 2.0
    while bpm > 144.0:
        bpm /= 2.0
    bpm = max(30.0, min(240.0, round(bpm, 1)))
    return unique_beats, bpm, phrase_windows


def _session_to_read(
    row: KaraokePracticeSession,
    *,
    persisted: bool = True,
    storage_notice: str | None = None,
) -> KaraokePracticeSessionRead:
    return KaraokePracticeSessionRead(
        id=row.Id,
        child_id=row.ChildId,
        song_id=row.SongId,
        song_version_id=row.SongVersionId,
        practice_mode=row.PracticeMode,
        scoring_mode=row.ScoringMode,
        playback_rate=float(row.PlaybackRate),
        headphone_mode=bool(row.HeadphoneMode),
        overall_score=row.OverallScore,
        rhythm_score=row.RhythmScore,
        pitch_score=row.PitchScore,
        lyrics_score=row.LyricsScore,
        fluency_score=row.FluencyScore,
        stars=int(row.Stars),
        segment_start_ms=row.SegmentStartMs,
        segment_end_ms=row.SegmentEndMs,
        report_payload=row.ReportPayload or {},
        created_at=row.CreatedAt or _utcnow(),
        persisted=persisted,
        storage_notice=storage_notice,
    )


class KaraokePracticeService:
    def __init__(self, repository: KaraokePracticeRepository):
        self.repository = repository

    async def _require_owned_child(self, parent_id: UUID, child_id: UUID):
        child = await self.repository.get_child_for_parent(parent_id, child_id)
        if child is None:
            raise HTTPException(
                status_code=404,
                detail="Child profile not found",
            )
        return child

    async def create_practice_session(
        self,
        parent_id: UUID,
        payload: KaraokePracticeSessionCreate,
    ) -> KaraokePracticeSessionRead:
        child = await self._require_owned_child(parent_id, payload.child_id)
        song_bundle = await self.repository.get_song_and_published_version(payload.song_id)
        if song_bundle is None:
            raise HTTPException(status_code=404, detail="Karaoke song not found")
        song, published = song_bundle

        version_id = payload.song_version_id or (
            published.id if published is not None else song.published_version_id
        )
        session_id = uuid4()
        now = _utcnow()

        session_row = KaraokePracticeSession(
            Id=session_id,
            ChildId=payload.child_id,
            ParentId=parent_id,
            SongId=payload.song_id,
            SongVersionId=version_id,
            PracticeMode=payload.practice_mode,
            ScoringMode=payload.scoring_mode,
            PlaybackRate=payload.playback_rate,
            HeadphoneMode=payload.headphone_mode,
            OverallScore=payload.overall_score,
            RhythmScore=payload.rhythm_score,
            PitchScore=payload.pitch_score,
            LyricsScore=payload.lyrics_score,
            FluencyScore=payload.fluency_score,
            Stars=payload.stars,
            SegmentStartMs=payload.segment_start_ms,
            SegmentEndMs=payload.segment_end_ms,
            ReportPayload=payload.report_payload,
            CreatedAt=now,
        )

        evidence_rows: list[LearningSkillEvidence] = []
        if payload.scoring_mode != "INSUFFICIENT_EVIDENCE":
            difficulty = max(1, min(5, int(getattr(child, "Grade", 1) or 1)))
            evidence_type = (
                "OBSERVED"
                if payload.scoring_mode in ("FULL_MUSICAL", "RHYTHM_AND_LYRICS")
                and payload.practice_mode == "FULL_SONG"
                else "ESTIMATED"
            )
            skill_entries = (
                (
                    "rhythm_timing",
                    payload.rhythm_score,
                    0.85 if payload.headphone_mode else 0.72,
                ),
                (
                    "pitch_melody",
                    payload.pitch_score,
                    0.85 if payload.headphone_mode else 0.70,
                ),
                ("lyric_delivery", payload.lyrics_score, 0.80),
            )
            for skill_key, score_val, confidence in skill_entries:
                if score_val is None:
                    continue
                evidence_rows.append(
                    LearningSkillEvidence(
                        Id=uuid4(),
                        ChildId=payload.child_id,
                        ParentId=parent_id,
                        SkillKey=skill_key,
                        SourceModule="KARAOKE",
                        SourceRecordId=str(session_id),
                        EvidenceType=evidence_type,
                        ScoreNormalized=round(float(score_val) / 100.0, 4),
                        Confidence=confidence,
                        DifficultyLevel=difficulty,
                        PracticeWords=[],
                        MetadataJson={
                            "song_id": str(payload.song_id),
                            "practice_mode": payload.practice_mode,
                            "scoring_mode": payload.scoring_mode,
                            "playback_rate": payload.playback_rate,
                            "headphone_mode": payload.headphone_mode,
                        },
                        CreatedAt=now,
                    )
                )

        try:
            saved = await self.repository.create_practice_session(
                session_row, evidence_rows
            )
            return _session_to_read(saved, persisted=True)
        except KaraokePracticeTableUnavailable:
            return _session_to_read(
                session_row,
                persisted=False,
                storage_notice="KARAOKE_PRACTICE_STORAGE_UNAVAILABLE",
            )

    async def list_practice_sessions(
        self,
        parent_id: UUID,
        child_id: UUID,
        *,
        song_id: UUID | None = None,
        limit: int = 10,
    ) -> KaraokePracticeHistoryResponse:
        await self._require_owned_child(parent_id, child_id)
        try:
            rows, total, best_score, best_stars = (
                await self.repository.list_practice_sessions(
                    parent_id,
                    child_id,
                    song_id=song_id,
                    limit=limit,
                )
            )
            return KaraokePracticeHistoryResponse(
                child_id=child_id,
                song_id=song_id,
                best_full_song_score=best_score,
                best_full_song_stars=best_stars,
                total_sessions=total,
                items=[_session_to_read(row) for row in rows],
                storage_ready=True,
            )
        except KaraokePracticeTableUnavailable:
            return KaraokePracticeHistoryResponse(
                child_id=child_id,
                song_id=song_id,
                best_full_song_score=None,
                best_full_song_stars=0,
                total_sessions=0,
                items=[],
                storage_ready=False,
            )

    async def get_musical_profile(self, song_id: UUID) -> MusicalProfileRead:
        song_bundle = await self.repository.get_song_and_published_version(song_id)
        if song_bundle is None:
            raise HTTPException(status_code=404, detail="Karaoke song not found")
        song, published = song_bundle
        if song.status != "PUBLISHED" or published is None:
            raise HTTPException(
                status_code=404, detail="Published karaoke song not found"
            )

        derived_beats, derived_bpm, derived_phrases = derive_musical_profile_from_lyrics(
            published.lyrics if isinstance(published.lyrics, dict) else None
        )
        stored = await self.repository.get_musical_profile(published.id)

        if stored is not None:
            raw_json = stored.ProfileJson if isinstance(stored.ProfileJson, dict) else {}
            raw_beats = raw_json.get("beat_grid_ms")
            beat_grid = (
                [int(t) for t in raw_beats if isinstance(t, (int, float)) and t >= 0]
                if isinstance(raw_beats, list) and raw_beats
                else derived_beats
            )
            raw_contour = raw_json.get("pitch_contour")
            contour: list[PitchContourPointRead] = []
            if isinstance(raw_contour, list):
                for pt in raw_contour:
                    if (
                        isinstance(pt, dict)
                        and isinstance(pt.get("time_ms"), (int, float))
                        and isinstance(pt.get("hz"), (int, float))
                        and pt["hz"] > 0
                    ):
                        contour.append(
                            PitchContourPointRead(
                                time_ms=int(pt["time_ms"]),
                                hz=float(pt["hz"]),
                                midi=float(pt["midi"])
                                if isinstance(pt.get("midi"), (int, float))
                                else None,
                            )
                        )
            raw_phrases = raw_json.get("phrase_windows")
            phrase_windows = (
                raw_phrases if isinstance(raw_phrases, list) and raw_phrases else derived_phrases
            )
            return MusicalProfileRead(
                song_id=song.id,
                song_version_id=published.id,
                bpm=float(stored.Bpm) if stored.Bpm is not None else derived_bpm,
                audio_type=stored.AudioType,
                has_pitch_contour=bool(stored.HasPitchContour or len(contour) > 0),
                has_beat_grid=bool(stored.HasBeatGrid or len(beat_grid) > 0),
                source_method=stored.SourceMethod,
                beat_grid_ms=beat_grid,
                pitch_contour=contour,
                phrase_windows=phrase_windows,
                updated_at=stored.UpdatedAt,
            )

        return MusicalProfileRead(
            song_id=song.id,
            song_version_id=published.id,
            bpm=derived_bpm,
            audio_type="UNKNOWN",
            has_pitch_contour=False,
            has_beat_grid=len(derived_beats) > 0,
            source_method="LYRICS_TIMING",
            beat_grid_ms=derived_beats,
            pitch_contour=[],
            phrase_windows=derived_phrases,
            updated_at=published.updated_at,
        )
