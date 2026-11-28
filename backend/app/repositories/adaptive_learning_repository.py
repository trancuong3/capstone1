"""Repository for Adaptive Learning Engine evidence and cross-module snapshots."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import desc, select
from sqlalchemy.exc import IntegrityError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    DifficultWordPracticeAttempt,
    GameSession,
    KaraokePracticeSession,
    LearningSkillEvidence,
    MemoryGameSession,
    PictureDescriptionSession,
)

logger = logging.getLogger(__name__)


def _is_missing_table_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "does not exist" in text or "undefinedtable" in text or "no such table" in text


async def record_skill_evidence_safe(
    db: AsyncSession,
    *,
    child_id: UUID,
    parent_id: UUID,
    skill_key: str,
    source_module: str,
    score_normalized: float,
    confidence: float = 0.75,
    difficulty_level: int = 1,
    evidence_type: str = "OBSERVED",
    source_record_id: str | None = None,
    practice_words: list[str] | None = None,
    metadata_json: dict | None = None,
) -> LearningSkillEvidence | None:
    """Persist skill evidence idempotently without failing if V4 tables are not migrated yet."""
    clamped_score = max(0.0, min(1.0, float(score_normalized)))
    clamped_conf = max(0.0, min(1.0, float(confidence)))
    clamped_diff = max(1, min(5, int(difficulty_level)))
    clean_words = [w.strip() for w in (practice_words or []) if isinstance(w, str) and w.strip()][:20]

    row = LearningSkillEvidence(
        ChildId=child_id,
        ParentId=parent_id,
        SkillKey=skill_key,
        SourceModule=source_module,
        SourceRecordId=source_record_id,
        EvidenceType=evidence_type,
        ScoreNormalized=clamped_score,
        Confidence=clamped_conf,
        DifficultyLevel=clamped_diff,
        PracticeWords=clean_words,
        MetadataJson=metadata_json or {},
    )
    try:
        async with db.begin_nested():
            db.add(row)
            await db.flush()
        return row
    except IntegrityError:
        return None
    except ProgrammingError as exc:
        if _is_missing_table_error(exc):
            logger.debug("learning_skill_evidence table not migrated yet; skipping write.")
            return None
        raise


class AdaptiveLearningRepository:
    """Read/write repository aggregating child evidence across Reading & Play modules."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_owned_child(self, child_id: UUID, parent_id: UUID) -> ChildProfile | None:
        result = await self.db.execute(
            select(ChildProfile).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_skill_evidence(
        self,
        child_id: UUID,
        *,
        window_days: int = 90,
        limit: int = 400,
    ) -> list[LearningSkillEvidence]:
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(LearningSkillEvidence)
                    .where(
                        LearningSkillEvidence.ChildId == child_id,
                        LearningSkillEvidence.CreatedAt >= since,
                    )
                    .order_by(desc(LearningSkillEvidence.CreatedAt))
                    .limit(limit)
                )
                return list(result.scalars().all())
        except ProgrammingError as exc:
            if _is_missing_table_error(exc):
                return []
            raise

    async def list_difficult_word_attempts(
        self,
        child_id: UUID,
        *,
        window_days: int = 90,
        limit: int = 200,
    ) -> list[Any]:
        from app.services.active_weak_words import load_unified_weak_word_attempts

        unified = await load_unified_weak_word_attempts(
            self.db,
            child_id,
            window_days=window_days,
        )
        if unified:
            return unified[: max(limit, 300)]

        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(DifficultWordPracticeAttempt)
                    .where(
                        DifficultWordPracticeAttempt.ChildId == child_id,
                        DifficultWordPracticeAttempt.CreatedAt >= since,
                    )
                    .order_by(desc(DifficultWordPracticeAttempt.CreatedAt))
                    .limit(limit)
                )
                return list(result.scalars().all())
        except ProgrammingError as exc:
            if _is_missing_table_error(exc):
                return []
            raise

    async def list_picture_sessions(
        self,
        child_id: UUID,
        *,
        window_days: int = 30,
        limit: int = 50,
    ) -> list[PictureDescriptionSession]:
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(PictureDescriptionSession)
                    .where(
                        PictureDescriptionSession.ChildProfileId == child_id,
                        PictureDescriptionSession.CreatedAt >= since,
                    )
                    .order_by(desc(PictureDescriptionSession.CreatedAt))
                    .limit(limit)
                )
                return list(result.scalars().all())
        except ProgrammingError as exc:
            if _is_missing_table_error(exc):
                return []
            raise

    async def list_shooter_sessions(
        self,
        child_id: UUID,
        *,
        window_days: int = 30,
        limit: int = 50,
    ) -> list[GameSession]:
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(GameSession)
                    .where(
                        GameSession.ChildProfileId == child_id,
                        GameSession.CreatedAt >= since,
                    )
                    .order_by(desc(GameSession.CreatedAt))
                    .limit(limit)
                )
                return list(result.scalars().all())
        except ProgrammingError as exc:
            if _is_missing_table_error(exc):
                return []
            raise

    async def list_karaoke_sessions(
        self,
        child_id: UUID,
        *,
        window_days: int = 30,
        limit: int = 50,
    ) -> list[KaraokePracticeSession]:
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(KaraokePracticeSession)
                    .where(
                        KaraokePracticeSession.ChildId == child_id,
                        KaraokePracticeSession.CreatedAt >= since,
                    )
                    .order_by(desc(KaraokePracticeSession.CreatedAt))
                    .limit(limit)
                )
                return list(result.scalars().all())
        except ProgrammingError as exc:
            if _is_missing_table_error(exc):
                return []
            raise

    async def list_memory_sessions(
        self,
        child_id: UUID,
        *,
        window_days: int = 30,
        limit: int = 50,
    ) -> list[MemoryGameSession]:
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(MemoryGameSession)
                    .where(
                        MemoryGameSession.ChildId == child_id,
                        MemoryGameSession.CreatedAt >= since,
                    )
                    .order_by(desc(MemoryGameSession.CreatedAt))
                    .limit(limit)
                )
                return list(result.scalars().all())
        except ProgrammingError as exc:
            if _is_missing_table_error(exc):
                return []
            raise

    async def create_evidence(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        skill_key: str,
        source_module: str,
        source_record_id: str | None,
        evidence_type: str,
        score_normalized: float,
        confidence: float,
        difficulty_level: int,
        practice_words: list[str],
        metadata_json: dict,
    ) -> LearningSkillEvidence:
        row = LearningSkillEvidence(
            ChildId=child_id,
            ParentId=parent_id,
            SkillKey=skill_key,
            SourceModule=source_module,
            SourceRecordId=source_record_id,
            EvidenceType=evidence_type,
            ScoreNormalized=score_normalized,
            Confidence=confidence,
            DifficultyLevel=difficulty_level,
            PracticeWords=practice_words,
            MetadataJson=metadata_json,
        )
        self.db.add(row)
        await self.db.flush()
        return row
