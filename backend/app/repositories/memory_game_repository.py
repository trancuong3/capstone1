from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import desc, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChildProfile, PageRevisionWord, ReadingEvent, ReadingSession
from app.models.entertainment_v4 import (
    LearningSkillEvidence,
    MemoryGameAttempt,
    MemoryGameSession,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ChildProjection:
    Id: UUID
    ParentId: UUID
    Grade: int
    Settings: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MemoryAttemptProjection:
    Id: UUID
    SessionId: UUID
    AttemptNumber: int
    Stage: str
    InputMode: str
    ResponseText: str
    FactualScore: int
    CreativeScore: int
    Stars: int
    EvaluationPayload: dict[str, Any]
    AiProvider: str | None
    CreatedAt: datetime


@dataclass(frozen=True, slots=True)
class MemorySessionProjection:
    Id: UUID
    ChildId: UUID
    ParentId: UUID
    ChildGrade: int
    ThemeKey: str
    DifficultyLevel: int
    SceneSeed: int
    TimerMode: str
    TimerSeconds: int | None
    RecallMode: str
    SceneSpec: dict[str, Any]
    Status: str
    HintsUsed: int
    PeekCount: int
    BestFactualScore: int
    BestCreativeScore: int
    Stars: int
    AttemptsCount: int
    CreatedAt: datetime
    UpdatedAt: datetime
    Attempts: tuple[MemoryAttemptProjection, ...] = ()


def _to_attempt_projection(row: MemoryGameAttempt) -> MemoryAttemptProjection:
    return MemoryAttemptProjection(
        Id=row.Id,
        SessionId=row.SessionId,
        AttemptNumber=int(row.AttemptNumber),
        Stage=str(row.Stage),
        InputMode=str(row.InputMode),
        ResponseText=str(row.ResponseText),
        FactualScore=int(row.FactualScore),
        CreativeScore=int(row.CreativeScore),
        Stars=int(row.Stars),
        EvaluationPayload=dict(row.EvaluationPayload or {}),
        AiProvider=row.AiProvider,
        CreatedAt=row.CreatedAt,
    )


def _to_session_projection(
    row: MemoryGameSession,
    attempts: tuple[MemoryAttemptProjection, ...] = (),
) -> MemorySessionProjection:
    return MemorySessionProjection(
        Id=row.Id,
        ChildId=row.ChildId,
        ParentId=row.ParentId,
        ChildGrade=int(row.ChildGrade),
        ThemeKey=str(row.ThemeKey),
        DifficultyLevel=int(row.DifficultyLevel),
        SceneSeed=int(row.SceneSeed),
        TimerMode=str(row.TimerMode),
        TimerSeconds=int(row.TimerSeconds) if row.TimerSeconds is not None else None,
        RecallMode=str(row.RecallMode),
        SceneSpec=dict(row.SceneSpec or {}),
        Status=str(row.Status),
        HintsUsed=int(row.HintsUsed),
        PeekCount=int(row.PeekCount),
        BestFactualScore=int(row.BestFactualScore),
        BestCreativeScore=int(row.BestCreativeScore),
        Stars=int(row.Stars),
        AttemptsCount=int(row.AttemptsCount),
        CreatedAt=row.CreatedAt,
        UpdatedAt=row.UpdatedAt,
        Attempts=attempts,
    )


class MemoryGameRepository:
    """Owner-scoped database access for AI Memory Game sessions, attempts, and learning evidence."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def child_owned_by(
        self,
        child_id: UUID,
        parent_id: UUID,
    ) -> ChildProjection | None:
        result = await self.db.execute(
            select(
                ChildProfile.Id,
                ChildProfile.ParentId,
                ChildProfile.Grade,
                ChildProfile.Settings,
            ).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        row = result.one_or_none()
        if row is None:
            return None
        raw_settings = getattr(row, "Settings", None)
        return ChildProjection(
            Id=row.Id,
            ParentId=row.ParentId,
            Grade=int(row.Grade),
            Settings=dict(raw_settings) if isinstance(raw_settings, dict) else {},
        )

    async def recent_difficult_words(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        limit: int = 8,
    ) -> list[str]:
        """Best-effort lookup of recent difficult reading words for scene personalization."""
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(PageRevisionWord.Text)
                    .join(ReadingEvent, ReadingEvent.WordId == PageRevisionWord.Id)
                    .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
                    .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
                    .where(
                        ReadingSession.ChildId == child_id,
                        ChildProfile.ParentId == parent_id,
                        ReadingEvent.Type.in_(
                            (
                                "OMISSION",
                                "REPETITION",
                                "LONG_PAUSE",
                                "MISPRONUNCIATION",
                                "SUBSTITUTION",
                                "READ_EXAMPLE",
                            )
                        ),
                        PageRevisionWord.Text.is_not(None),
                    )
                    .order_by(desc(ReadingEvent.CreatedAt))
                    .limit(limit * 4)
                )
                rows = result.scalars().all()
        except SQLAlchemyError:
            return []

        words: list[str] = []
        seen: set[str] = set()
        for raw in rows:
            cleaned = str(raw).strip()
            key = cleaned.casefold()
            if cleaned and key not in seen:
                seen.add(key)
                words.append(cleaned)
                if len(words) >= limit:
                    break
        return words

    async def _table_exists(self, table_name: str) -> bool:
        try:
            async with self.db.begin_nested():
                found = await self.db.scalar(
                    text("SELECT to_regclass(:regname)").bindparams(
                        regname=f"public.{table_name}"
                    )
                )
                return found is not None
        except SQLAlchemyError:
            # Non-PostgreSQL test engines or missing schema fall back safely
            return True

    async def create_session(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        child_grade: int,
        theme_key: str,
        difficulty_level: int,
        scene_seed: int,
        timer_mode: str,
        timer_seconds: int | None,
        recall_mode: str,
        scene_spec: dict[str, Any],
    ) -> MemorySessionProjection:
        now = datetime.now(timezone.utc)
        session_row = MemoryGameSession(
            ChildId=child_id,
            ParentId=parent_id,
            ChildGrade=child_grade,
            ThemeKey=theme_key,
            DifficultyLevel=difficulty_level,
            SceneSeed=scene_seed,
            TimerMode=timer_mode,
            TimerSeconds=timer_seconds,
            RecallMode=recall_mode,
            SceneSpec=scene_spec,
            Status="OBSERVING",
            HintsUsed=0,
            PeekCount=0,
            BestFactualScore=0,
            BestCreativeScore=0,
            Stars=0,
            AttemptsCount=0,
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.db.add(session_row)
        await self.db.commit()
        await self.db.refresh(session_row)
        return _to_session_projection(session_row)

    async def get_session_for_parent(
        self,
        session_id: UUID,
        parent_id: UUID,
    ) -> MemorySessionProjection | None:
        session_row = await self.db.scalar(
            select(MemoryGameSession).where(
                MemoryGameSession.Id == session_id,
                MemoryGameSession.ParentId == parent_id,
            )
        )
        if session_row is None:
            return None

        attempt_rows = (
            await self.db.execute(
                select(MemoryGameAttempt)
                .where(MemoryGameAttempt.SessionId == session_id)
                .order_by(MemoryGameAttempt.AttemptNumber.asc())
            )
        ).scalars().all()
        attempts = tuple(_to_attempt_projection(row) for row in attempt_rows)
        return _to_session_projection(session_row, attempts)

    async def list_sessions_for_child(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        limit: int = 10,
    ) -> list[MemorySessionProjection]:
        if not await self._table_exists("memory_game_sessions"):
            return []
        try:
            rows = (
                await self.db.execute(
                    select(MemoryGameSession)
                    .where(
                        MemoryGameSession.ChildId == child_id,
                        MemoryGameSession.ParentId == parent_id,
                    )
                    .order_by(desc(MemoryGameSession.CreatedAt), desc(MemoryGameSession.Id))
                    .limit(limit)
                )
            ).scalars().all()
        except SQLAlchemyError:
            await self.db.rollback()
            return []
        return [_to_session_projection(row) for row in rows]

    async def increment_hints(
        self,
        session_id: UUID,
        parent_id: UUID,
    ) -> int | None:
        session_row = await self.db.scalar(
            select(MemoryGameSession)
            .where(
                MemoryGameSession.Id == session_id,
                MemoryGameSession.ParentId == parent_id,
            )
            .with_for_update()
        )
        if session_row is None:
            return None
        session_row.HintsUsed = int(session_row.HintsUsed) + 1
        if session_row.Status == "OBSERVING":
            session_row.Status = "RECALLING"
        session_row.UpdatedAt = datetime.now(timezone.utc)
        await self.db.commit()
        return int(session_row.HintsUsed)

    async def increment_peeks(
        self,
        session_id: UUID,
        parent_id: UUID,
    ) -> int | None:
        session_row = await self.db.scalar(
            select(MemoryGameSession)
            .where(
                MemoryGameSession.Id == session_id,
                MemoryGameSession.ParentId == parent_id,
            )
            .with_for_update()
        )
        if session_row is None:
            return None
        session_row.PeekCount = int(session_row.PeekCount) + 1
        if session_row.Status == "OBSERVING":
            session_row.Status = "RECALLING"
        session_row.UpdatedAt = datetime.now(timezone.utc)
        await self.db.commit()
        return int(session_row.PeekCount)

    async def record_attempt(
        self,
        *,
        session_id: UUID,
        parent_id: UUID,
        stage: str,
        input_mode: str,
        response_text: str,
        factual_score: int,
        creative_score: int,
        stars: int,
        evaluation_payload: dict[str, Any],
        ai_provider: str | None,
    ) -> tuple[MemoryAttemptProjection, MemorySessionProjection] | None:
        session_row = await self.db.scalar(
            select(MemoryGameSession)
            .where(
                MemoryGameSession.Id == session_id,
                MemoryGameSession.ParentId == parent_id,
            )
            .with_for_update()
        )
        if session_row is None:
            return None

        now = datetime.now(timezone.utc)
        next_attempt_number = int(session_row.AttemptsCount) + 1
        attempt_row = MemoryGameAttempt(
            SessionId=session_row.Id,
            AttemptNumber=next_attempt_number,
            Stage=stage,
            InputMode=input_mode,
            ResponseText=response_text,
            FactualScore=factual_score,
            CreativeScore=creative_score,
            Stars=stars,
            EvaluationPayload=evaluation_payload,
            AiProvider=ai_provider,
            CreatedAt=now,
        )
        self.db.add(attempt_row)

        session_row.AttemptsCount = next_attempt_number
        session_row.BestFactualScore = max(int(session_row.BestFactualScore), factual_score)
        session_row.BestCreativeScore = max(int(session_row.BestCreativeScore), creative_score)
        session_row.Stars = max(int(session_row.Stars), stars)
        if stage == "CREATIVE":
            session_row.Status = "COMPLETED"
        elif session_row.Status in ("OBSERVING", "RECALLING"):
            session_row.Status = "CREATIVE"
        session_row.UpdatedAt = now

        await self.db.commit()
        await self.db.refresh(attempt_row)
        await self.db.refresh(session_row)

        attempt_rows = (
            await self.db.execute(
                select(MemoryGameAttempt)
                .where(MemoryGameAttempt.SessionId == session_id)
                .order_by(MemoryGameAttempt.AttemptNumber.asc())
            )
        ).scalars().all()
        attempts = tuple(_to_attempt_projection(row) for row in attempt_rows)
        return _to_attempt_projection(attempt_row), _to_session_projection(session_row, attempts)

    async def record_skill_evidence(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        source_record_id: str,
        difficulty_level: int,
        evidence_items: list[dict[str, Any]],
    ) -> None:
        """
        Persist skill evidence into `learning_skill_evidence` for visual memory, observation,
        creativity, and vocabulary naming. Gracefully skips if the table is not migrated yet.
        """
        if not evidence_items:
            return
        if not await self._table_exists("learning_skill_evidence"):
            return
        try:
            async with self.db.begin_nested():
                for item in evidence_items:
                    row = LearningSkillEvidence(
                        ChildId=child_id,
                        ParentId=parent_id,
                        SkillKey=str(item["skill_key"]),
                        SourceModule="MEMORY_GAME",
                        SourceRecordId=source_record_id,
                        EvidenceType=str(item.get("evidence_type", "OBSERVED")),
                        ScoreNormalized=max(0.0, min(1.0, float(item["score_normalized"]))),
                        Confidence=max(0.0, min(1.0, float(item.get("confidence", 0.8)))),
                        DifficultyLevel=max(1, min(5, int(difficulty_level))),
                        PracticeWords=list(item.get("practice_words", [])),
                        MetadataJson=dict(item.get("metadata_json", {})),
                    )
                    self.db.add(row)
                await self.db.flush()
            await self.db.commit()
        except SQLAlchemyError as exc:
            logger.debug("Skipping learning_skill_evidence write (graceful fallback): %s", type(exc).__name__)
            try:
                await self.db.rollback()
            except SQLAlchemyError:
                pass
