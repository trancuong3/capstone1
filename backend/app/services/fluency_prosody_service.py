"""Service for Feature #5: Prosody, Punctuation-Pause & Intonation Coach.

Strictly `PARENT_PRIVATE`:
  - Enforces parent-owns-child and child-owns-session checks (403/404 isolation).
  - Merges `prosody_metrics` into `FluencyAssessment.Metrics` JSONB without
    clobbering existing `accuracy_percent` / `reading_wpm` / fluency metrics.
"""
from __future__ import annotations

import base64
import logging
from pathlib import Path
import sys
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

# Ensure repo root `<worktree>` is importable so `ai.fluency` resolves in all launch modes
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from ai.fluency.prosody_punctuation_analyzer import (  # noqa: E402
    PROSODY_ANALYZER_VERSION,
    ProsodyAnalysisResult,
    analyze_prosody,
    annotate_punctuation_breathing_cues,
)
from app.models.book import Book  # noqa: E402
from app.models.profile import ChildProfile  # noqa: E402
from app.models.reading import FluencyAssessment, ReadingSession  # noqa: E402
from app.schemas.fluency_prosody import (  # noqa: E402
    AnalyzeProsodyRequest,
    AnnotateCuesRequest,
    AnnotateCuesResponse,
    BreathingCueTokenResponse,
    ClauseBreakdownResponse,
    ProsodyAnalysisResponse,
)

logger = logging.getLogger(__name__)


class FluencyProsodyService:
    """Coordinates PARENT_PRIVATE prosody analysis, persistence, and breathing cue annotation."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def _verify_parent_owns_session(
        self,
        parent_id: UUID,
        child_id: UUID,
        session_id: UUID,
    ) -> UUID:
        """Verify `parent_id` owns `child_id` and `session_id`; return snapshotted `session_id`."""
        child_res = await self._db.execute(
            select(ChildProfile).where(ChildProfile.Id == child_id)
        )
        child = child_res.scalar_one_or_none()
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        if child.ParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied to child profile",
            )

        session_res = await self._db.execute(
            select(ReadingSession).where(ReadingSession.Id == session_id)
        )
        session = session_res.scalar_one_or_none()
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Reading session not found",
            )
        if session.ChildId != child_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Reading session does not belong to child",
            )

        # Defense-in-depth: block cross-parent private book leakage
        if session.BookId is not None:
            book_res = await self._db.execute(
                select(Book).where(Book.Id == session.BookId)
            )
            book = book_res.scalar_one_or_none()
            if (
                book is not None
                and getattr(book, "VisibilityScope", None) == "PARENT_PRIVATE"
                and getattr(book, "OwnerParentId", None) != parent_id
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied to private book session",
                )

        return UUID(str(session.Id))

    async def _merge_prosody_into_fluency_assessment(
        self,
        session_id: UUID,
        result: ProsodyAnalysisResult,
    ) -> bool:
        """Upsert `prosody_metrics` into `FluencyAssessment.Metrics` without clobbering existing keys."""
        prosody_payload: dict[str, Any] = {
            "comma_pause_score": result.comma_pause_score,
            "period_pause_score": result.period_pause_score,
            "intonation_contour_score": result.intonation_contour_score,
            "overall_prosody_score": result.overall_prosody_score,
            "grade_band_verdict": result.grade_band_verdict,
            "coaching_tip_vi": result.coaching_tip_vi,
            "median_inter_word_gap_ms": result.median_inter_word_gap_ms,
            "noise_floor_rms": result.noise_floor_rms,
            "audio_analyzed": result.audio_analyzed,
            "clause_count": len(result.clauses),
            "model_version": result.model_version,
        }

        existing_res = await self._db.execute(
            select(FluencyAssessment)
            .where(FluencyAssessment.SessionId == session_id)
            .order_by(FluencyAssessment.CreatedAt.desc(), FluencyAssessment.Id.desc())
            .limit(1)
        )
        existing = existing_res.scalar_one_or_none()

        if existing is not None:
            merged_metrics: dict[str, Any] = dict(existing.Metrics or {})
            merged_metrics["prosody_metrics"] = prosody_payload
            existing.Metrics = merged_metrics
            try:
                flag_modified(existing, "Metrics")
            except Exception:
                pass
            if existing.Score is None:
                existing.Score = round(result.overall_prosody_score / 100.0, 4)
        else:
            uncertainty = 0.15 if result.audio_analyzed else 0.32
            assessment = FluencyAssessment(
                SessionId=session_id,
                Metrics={"prosody_metrics": prosody_payload},
                Score=round(result.overall_prosody_score / 100.0, 4),
                Uncertainty=uncertainty,
                ModelVersion=PROSODY_ANALYZER_VERSION,
            )
            self._db.add(assessment)

        await self._db.flush()
        await self._db.commit()
        return True

    async def analyze_session_prosody(
        self,
        parent_id: UUID,
        child_id: UUID,
        session_id: UUID,
        payload: AnalyzeProsodyRequest,
    ) -> ProsodyAnalysisResponse:
        """Validate ownership, run local DSP prosody analysis, merge JSONB metrics, and return coaching."""
        verified_session_id = await self._verify_parent_owns_session(
            parent_id, child_id, session_id
        )

        audio_bytes: bytes | None = None
        if payload.audio_wav_base64:
            raw_b64 = payload.audio_wav_base64.strip()
            if "," in raw_b64 and raw_b64.lower().startswith("data:"):
                raw_b64 = raw_b64.split(",", 1)[1]
            try:
                audio_bytes = base64.b64decode(raw_b64, validate=False)
            except Exception as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Invalid base64 audio payload",
                ) from exc

        timings_dicts = [
            {"word": wt.word, "start_ms": wt.start_ms, "end_ms": wt.end_ms}
            for wt in payload.word_timings
        ]

        result = analyze_prosody(
            payload.reference_text,
            timings_dicts,
            audio=audio_bytes,
            sample_rate=payload.sample_rate,
            f0_frames=payload.f0_frames,
            rms_frames=payload.rms_frames,
            hop_ms=payload.hop_ms,
        )

        persisted = await self._merge_prosody_into_fluency_assessment(
            verified_session_id, result
        )

        clause_items = [
            ClauseBreakdownResponse(
                clause_index=c.clause_index,
                clause_text=c.clause_text,
                start_word_idx=c.start_word_idx,
                end_word_idx=c.end_word_idx,
                start_ms=c.start_ms,
                end_ms=c.end_ms,
                terminal_punct=c.terminal_punct,
                punctuation_kind=c.punctuation_kind,  # type: ignore[arg-type]
                observed_pause_ms=c.observed_pause_ms,
                relative_pause_ratio=c.relative_pause_ratio,
                expected_pause_ratio=c.expected_pause_ratio,
                pause_score=c.pause_score,
                terminal_f0_delta_semitones=c.terminal_f0_delta_semitones,
                intonation_score=c.intonation_score,
            )
            for c in result.clauses
        ]

        return ProsodyAnalysisResponse(
            child_id=child_id,
            session_id=verified_session_id,
            comma_pause_score=result.comma_pause_score,
            period_pause_score=result.period_pause_score,
            intonation_contour_score=result.intonation_contour_score,
            overall_prosody_score=result.overall_prosody_score,
            grade_band_verdict=result.grade_band_verdict,  # type: ignore[arg-type]
            coaching_tip_vi=result.coaching_tip_vi,
            clauses=clause_items,
            median_inter_word_gap_ms=result.median_inter_word_gap_ms,
            noise_floor_rms=result.noise_floor_rms,
            audio_analyzed=result.audio_analyzed,
            model_version=result.model_version,
            persisted=persisted,
        )

    def annotate_cues(self, payload: AnnotateCuesRequest) -> AnnotateCuesResponse:
        """Produce deterministic visual breathing & intonation cues for a reading page."""
        annotation = annotate_punctuation_breathing_cues(payload.text)
        return AnnotateCuesResponse(
            original_text=annotation.original_text,
            annotated_text=annotation.annotated_text,
            tokens=[
                BreathingCueTokenResponse(
                    text=t.text,
                    punctuation=t.punctuation,
                    cue_symbol=t.cue_symbol,  # type: ignore[arg-type]
                    cue_type=t.cue_type,  # type: ignore[arg-type]
                    pause_beats=t.pause_beats,
                )
                for t in annotation.tokens
            ],
            cue_counts=annotation.cue_counts,
            cue_legend=annotation.cue_legend,
        )
