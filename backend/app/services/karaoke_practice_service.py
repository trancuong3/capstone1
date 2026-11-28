"""Business logic for Musical Karaoke practice persistence, evidence & profiles."""

from datetime import datetime, timezone
import inspect
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
from app.services.karaoke_service import _match_song_difficult_words


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


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _filter_lyrics_for_practice(
    published_lyrics: Any,
    report_payload: dict[str, Any] | None,
    segment_start_ms: int | None,
    segment_end_ms: int | None,
) -> dict[str, Any]:
    """Scope lyric lines to what the child actually sang in this practice session."""
    has_segment_window = (
        segment_start_ms is not None
        and segment_end_ms is not None
        and segment_end_ms > segment_start_ms
    )
    if isinstance(report_payload, dict):
        raw_segments = report_payload.get("segments")
        if isinstance(raw_segments, list) and raw_segments:
            text_segments = [
                seg
                for seg in raw_segments
                if isinstance(seg, dict)
                and isinstance(seg.get("text"), str)
                and seg["text"].strip()
            ]
            if text_segments:
                has_per_segment_lyric_scores = any(
                    _is_number(seg.get("lyrics_score")) for seg in text_segments
                )
                has_per_segment_status = any(
                    isinstance(seg.get("status"), str) and seg["status"].strip()
                    for seg in text_segments
                )
                selected_lines: list[dict[str, Any]] = []
                for seg in text_segments:
                    if has_segment_window:
                        seg_start = seg.get("start_ms")
                        seg_end = seg.get("end_ms")
                        if _is_number(seg_start) and _is_number(seg_end):
                            if seg_end <= segment_start_ms or seg_start >= segment_end_ms:  # type: ignore[operator]
                                continue
                    seg_score = seg.get("lyrics_score")
                    if _is_number(seg_score):
                        if seg_score < 60:
                            continue
                    elif has_per_segment_lyric_scores or has_per_segment_status:
                        if seg.get("status") not in ("GREAT", "GOOD"):
                            continue
                    selected_lines.append({"text": seg["text"]})
                return {"lines": selected_lines}

    if not isinstance(published_lyrics, dict):
        return {"lines": []}
    lines = published_lyrics.get("lines")
    if not isinstance(lines, list):
        return {"lines": []}
    if has_segment_window:
        scoped: list[Any] = []
        for line in lines:
            if not isinstance(line, dict):
                continue
            start_ms = line.get("start_ms")
            end_ms = line.get("end_ms")
            if _is_number(start_ms) and _is_number(end_ms):
                if end_ms <= segment_start_ms or start_ms >= segment_end_ms:  # type: ignore[operator]
                    continue
            scoped.append(line)
        return {"lines": scoped}
    return published_lyrics


class KaraokePracticeService:
    def __init__(self, repository: KaraokePracticeRepository):
        self.repository = repository

    async def _load_child_difficult_words(
        self,
        parent_id: UUID,
        child_id: UUID,
        *,
        limit: int = 12,
    ) -> list[str]:
        custom_fn = getattr(self.repository, "list_difficult_words", None) or getattr(
            self.repository, "difficult_words", None
        )
        if callable(custom_fn):
            try:
                maybe_words = custom_fn(child_id, parent_id, limit=limit)
                if inspect.isawaitable(maybe_words):
                    maybe_words = await maybe_words
                if isinstance(maybe_words, (list, tuple)):
                    return [str(word) for word in maybe_words if str(word).strip()]
            except Exception:
                return []
        db = getattr(self.repository, "db", None)
        if db is None:
            return []
        try:
            from app.services.child_difficult_word_feed import ChildDifficultWordFeed

            return await ChildDifficultWordFeed(db).list_words(
                child_id,
                parent_id,
                limit=limit,
            )
        except Exception:
            return []

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
        raw_matched_words = (
            payload.report_payload.get("matched_difficult_words")
            if isinstance(payload.report_payload, dict)
            else None
        )
        matched_words: list[str] = (
            [
                str(w).strip()[:80]
                for w in raw_matched_words
                if isinstance(w, str) and str(w).strip()
            ][:8]
            if isinstance(raw_matched_words, list)
            else []
        )
        difficulty = max(1, min(5, int(getattr(child, "Grade", 1) or 1)))
        if payload.scoring_mode != "INSUFFICIENT_EVIDENCE":
            evidence_type = (
                "OBSERVED"
                if payload.scoring_mode in ("FULL_MUSICAL", "RHYTHM_AND_LYRICS")
                and payload.practice_mode == "FULL_SONG"
                else "ESTIMATED"
            )
            practiced_words: list[str] = []
            if (
                payload.practice_mode != "RHYTHM_TAP"
                and payload.lyrics_score is not None
            ):
                difficult_words = await self._load_child_difficult_words(
                    parent_id,
                    payload.child_id,
                    limit=12,
                )
                if difficult_words:
                    scoped_lyrics = _filter_lyrics_for_practice(
                        getattr(published, "lyrics", None),
                        payload.report_payload,
                        payload.segment_start_ms,
                        payload.segment_end_ms,
                    )
                    practiced_words = _match_song_difficult_words(
                        scoped_lyrics,
                        difficult_words,
                    )[:6]
            metadata_json = {
                "song_id": str(payload.song_id),
                "practice_mode": payload.practice_mode,
                "scoring_mode": payload.scoring_mode,
                "playback_rate": payload.playback_rate,
                "headphone_mode": payload.headphone_mode,
            }
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
            effective_words = list(practiced_words)
            if (
                not effective_words
                and matched_words
                and payload.practice_mode != "RHYTHM_TAP"
                and payload.lyrics_score is not None
                and payload.lyrics_score >= 55
            ):
                effective_words = list(matched_words)
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
                        PracticeWords=(
                            list(effective_words)
                            if skill_key == "lyric_delivery"
                            else []
                        ),
                        MetadataJson=dict(metadata_json),
                        CreatedAt=now,
                    )
                )
            if (
                effective_words
                and payload.practice_mode != "RHYTHM_TAP"
                and payload.lyrics_score is not None
            ):
                evidence_rows.append(
                    LearningSkillEvidence(
                        Id=uuid4(),
                        ChildId=payload.child_id,
                        ParentId=parent_id,
                        SkillKey="difficult_word_mastery",
                        SourceModule="KARAOKE",
                        SourceRecordId=str(session_id),
                        EvidenceType=evidence_type,
                        ScoreNormalized=round(float(payload.lyrics_score) / 100.0, 4),
                        Confidence=0.80,
                        DifficultyLevel=difficulty,
                        PracticeWords=list(effective_words),
                        MetadataJson=dict(metadata_json),
                        CreatedAt=now,
                    )
                )

        try:
            saved = await self.repository.create_practice_session(
                session_row, evidence_rows
            )
            vocal_words = matched_words or (
                practiced_words if payload.scoring_mode != "INSUFFICIENT_EVIDENCE" else []
            )
            if (
                vocal_words
                and payload.scoring_mode != "INSUFFICIENT_EVIDENCE"
                and payload.practice_mode != "RHYTHM_TAP"
                and payload.lyrics_score is not None
                and payload.lyrics_score >= 55
            ):
                from app.services.active_weak_words import (
                    record_entertainment_vocal_word_practice,
                )

                await record_entertainment_vocal_word_practice(
                    getattr(self.repository, "db", None),
                    child_id=payload.child_id,
                    parent_id=parent_id,
                    words=vocal_words,
                    source_module="KARAOKE",
                    source_record_id=str(session_id),
                    transcript_text=", ".join(vocal_words),
                    confidence=0.80,
                    difficulty_level=difficulty,
                    recognition_source="BROWSER_SPEECH",
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
            raw_melody = raw_json.get("melody_profile")
            melody_profile = raw_melody if isinstance(raw_melody, dict) else None
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
                melody_profile=melody_profile,
                updated_at=stored.UpdatedAt,
            )

        version_melody = None
        if hasattr(self.repository, "get_version_melody_profile"):
            version_melody = await self.repository.get_version_melody_profile(published.id)
        if isinstance(version_melody, dict):
            raw_contour = version_melody.get("pitch_contour")
            contour = [
                PitchContourPointRead(
                    time_ms=int(pt["time_ms"]),
                    hz=float(pt["hz"]),
                    midi=float(pt["midi"]) if isinstance(pt.get("midi"), (int, float)) else None,
                )
                for pt in (raw_contour if isinstance(raw_contour, list) else [])
                if isinstance(pt, dict)
                and isinstance(pt.get("time_ms"), (int, float))
                and isinstance(pt.get("hz"), (int, float))
                and pt["hz"] > 0
            ]
            return MusicalProfileRead(
                song_id=song.id,
                song_version_id=published.id,
                bpm=float(version_melody["bpm"])
                if isinstance(version_melody.get("bpm"), (int, float))
                else derived_bpm,
                audio_type="DUAL_TRACK",
                has_pitch_contour=len(contour) > 0,
                has_beat_grid=len(derived_beats) > 0,
                source_method="AUDIO_DSP",
                beat_grid_ms=derived_beats,
                pitch_contour=contour,
                phrase_windows=derived_phrases,
                melody_profile=version_melody,
                updated_at=published.updated_at,
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
            melody_profile=None,
            updated_at=published.updated_at,
        )
