"""Repository for Wave 1 Feature #4:
- Parent PIN security table (`parent_security_pins`)
- Parent Voice Encouragement notes (`parent_encouragement_notes`)
- Reading Passport history aggregation across `readingsessions`, `readinggoals`,
  `difficult_word_practice_attempts`, and `comprehensionanswers`.

All queries use `to_regclass(...)` probes and `db.begin_nested()` savepoints so pre-migration
deployments degrade cleanly without aborting outer PostgreSQL transactions.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import desc, func, select, text, update
from sqlalchemy.exc import ProgrammingError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    ComprehensionAnswer,
    ComprehensionQuestion,
    DifficultWordPracticeAttempt,
    Profile,
    ReadingGoal,
    ReadingSession,
)
from app.models.family_pedagogy import ParentEncouragementNote, ParentSecurityPin


def _is_missing_relation_error(exc: BaseException) -> bool:
    for candidate in (exc, getattr(exc, "orig", None), getattr(exc, "__cause__", None)):
        if candidate is None:
            continue
        code = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        if code in ("42P01", "42703"):
            return True
        lowered = str(candidate).lower()
        if "does not exist" in lowered or "undefinedtable" in lowered or "no such table" in lowered:
            return True
    return False


class FamilyPedagogyRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def is_pin_storage_ready(self) -> bool:
        try:
            reg = await self.db.scalar(
                select(text("to_regclass('public.parent_security_pins')"))
            )
            return reg is not None
        except SQLAlchemyError:
            return False

    async def is_encouragement_storage_ready(self) -> bool:
        try:
            reg = await self.db.scalar(
                select(text("to_regclass('public.parent_encouragement_notes')"))
            )
            return reg is not None
        except SQLAlchemyError:
            return False

    async def owned_child(self, child_id: UUID, parent_id: UUID) -> ChildProfile | None:
        return await self.db.scalar(
            select(ChildProfile)
            .join(Profile, Profile.Id == ChildProfile.ParentId)
            .where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
                Profile.Active == 1,
                Profile.Role == "parent",
            )
        )

    async def get_pin_record(self, parent_id: UUID) -> ParentSecurityPin | None:
        if not await self.is_pin_storage_ready():
            return None
        try:
            async with self.db.begin_nested():
                return await self.db.scalar(
                    select(ParentSecurityPin).where(
                        ParentSecurityPin.ParentId == parent_id
                    )
                )
        except ProgrammingError as exc:
            if _is_missing_relation_error(exc):
                return None
            raise

    async def upsert_pin_record(
        self,
        *,
        parent_id: UUID,
        pin_hash: str,
        pin_salt: str,
        child_mode_default: bool,
    ) -> ParentSecurityPin:
        now = datetime.now(timezone.utc)
        existing = await self.get_pin_record(parent_id)
        if existing is not None:
            existing.PinHash = pin_hash
            existing.PinSalt = pin_salt
            existing.ChildModeDefault = child_mode_default
            existing.FailedAttempts = 0
            existing.LockedUntil = None
            existing.UpdatedAt = now
            await self.db.commit()
            await self.db.refresh(existing)
            return existing

        row = ParentSecurityPin(
            ParentId=parent_id,
            PinHash=pin_hash,
            PinSalt=pin_salt,
            ChildModeDefault=child_mode_default,
            FailedAttempts=0,
            LockedUntil=None,
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def record_pin_attempt(
        self,
        record: ParentSecurityPin,
        *,
        failed_attempts: int,
        locked_until: datetime | None,
    ) -> ParentSecurityPin:
        record.FailedAttempts = max(0, int(failed_attempts))
        record.LockedUntil = locked_until
        record.UpdatedAt = datetime.now(timezone.utc)
        await self.db.commit()
        await self.db.refresh(record)
        return record

    async def delete_pin_record(self, record: ParentSecurityPin) -> None:
        await self.db.delete(record)
        await self.db.commit()

    async def get_active_encouragement_note(
        self, child_id: UUID, parent_id: UUID
    ) -> ParentEncouragementNote | None:
        if not await self.is_encouragement_storage_ready():
            return None
        try:
            async with self.db.begin_nested():
                return await self.db.scalar(
                    select(ParentEncouragementNote)
                    .where(
                        ParentEncouragementNote.ChildId == child_id,
                        ParentEncouragementNote.ParentId == parent_id,
                        ParentEncouragementNote.IsActive.is_(True),
                    )
                    .order_by(desc(ParentEncouragementNote.CreatedAt))
                    .limit(1)
                )
        except ProgrammingError as exc:
            if _is_missing_relation_error(exc):
                return None
            raise

    async def get_encouragement_note_by_id(
        self, note_id: UUID, child_id: UUID, parent_id: UUID
    ) -> ParentEncouragementNote | None:
        if not await self.is_encouragement_storage_ready():
            return None
        try:
            async with self.db.begin_nested():
                return await self.db.scalar(
                    select(ParentEncouragementNote).where(
                        ParentEncouragementNote.Id == note_id,
                        ParentEncouragementNote.ChildId == child_id,
                        ParentEncouragementNote.ParentId == parent_id,
                    )
                )
        except ProgrammingError as exc:
            if _is_missing_relation_error(exc):
                return None
            raise

    async def replace_active_encouragement_note(
        self,
        *,
        note_id: UUID,
        child_id: UUID,
        parent_id: UUID,
        title: str | None,
        storage_bucket: str,
        storage_path: str,
        mime_type: str,
        size_bytes: int,
        duration_ms: int | None,
    ) -> tuple[ParentEncouragementNote, list[tuple[str, str]]]:
        now = datetime.now(timezone.utc)
        previous_rows = (
            await self.db.execute(
                select(ParentEncouragementNote).where(
                    ParentEncouragementNote.ChildId == child_id,
                    ParentEncouragementNote.ParentId == parent_id,
                    ParentEncouragementNote.IsActive.is_(True),
                )
            )
        ).scalars().all()
        old_objects = [(row.StorageBucket, row.StoragePath) for row in previous_rows]

        if previous_rows:
            await self.db.execute(
                update(ParentEncouragementNote)
                .where(
                    ParentEncouragementNote.ChildId == child_id,
                    ParentEncouragementNote.ParentId == parent_id,
                    ParentEncouragementNote.IsActive.is_(True),
                )
                .values(IsActive=False, UpdatedAt=now)
            )

        note = ParentEncouragementNote(
            Id=note_id,
            ChildId=child_id,
            ParentId=parent_id,
            Title=title,
            StorageBucket=storage_bucket,
            StoragePath=storage_path,
            MimeType=mime_type,
            SizeBytes=size_bytes,
            DurationMs=duration_ms,
            IsActive=True,
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.db.add(note)
        await self.db.commit()
        await self.db.refresh(note)
        return note, old_objects

    async def delete_encouragement_note(self, note: ParentEncouragementNote) -> None:
        await self.db.delete(note)
        await self.db.commit()

    async def load_passport_facts(self, child_id: UUID) -> dict:
        since = datetime.now(timezone.utc) - timedelta(days=120)
        sessions_res = await self.db.execute(
            select(
                ReadingSession.Id,
                ReadingSession.BookId,
                ReadingSession.State,
                ReadingSession.StartedAt,
                ReadingSession.EndedAt,
            )
            .where(
                ReadingSession.ChildId == child_id,
                ReadingSession.StartedAt >= since,
            )
            .order_by(desc(ReadingSession.StartedAt))
            .limit(1000)
        )
        sessions = sessions_res.all()

        goals: list[ReadingGoal] = []
        try:
            async with self.db.begin_nested():
                goals_res = await self.db.execute(
                    select(ReadingGoal)
                    .where(ReadingGoal.ChildId == child_id)
                    .limit(50)
                )
                goals = list(goals_res.scalars().all())
        except SQLAlchemyError:
            goals = []

        mastered_words = 0
        try:
            reg = await self.db.scalar(
                select(text("to_regclass('public.difficult_word_practice_attempts')"))
            )
            if reg is not None:
                async with self.db.begin_nested():
                    mastered_words = int(
                        await self.db.scalar(
                            select(
                                func.count(
                                    func.distinct(DifficultWordPracticeAttempt.NormalizedWord)
                                )
                            ).where(
                                DifficultWordPracticeAttempt.ChildId == child_id,
                                DifficultWordPracticeAttempt.AssessmentStatus == "CORRECT",
                            )
                        )
                        or 0
                    )
        except SQLAlchemyError:
            mastered_words = 0

        comp_correct = int(
            await self.db.scalar(
                select(func.count(func.distinct(ComprehensionAnswer.QuestionId)))
                .join(
                    ComprehensionQuestion,
                    ComprehensionQuestion.Id == ComprehensionAnswer.QuestionId,
                )
                .join(
                    ReadingSession,
                    ReadingSession.Id == ComprehensionQuestion.SessionId,
                )
                .where(
                    ReadingSession.ChildId == child_id,
                    ComprehensionAnswer.IsCorrect.is_(True),
                )
            )
            or 0
        )

        has_note = (
            await self.db.scalar(
                select(func.count(ParentEncouragementNote.Id)).where(
                    ParentEncouragementNote.ChildId == child_id,
                    ParentEncouragementNote.IsActive.is_(True),
                )
            )
            if await self.is_encouragement_storage_ready()
            else 0
        )

        return {
            "sessions": sessions,
            "goals": goals,
            "mastered_words": mastered_words,
            "comprehension_correct": comp_correct,
            "has_parent_encouragement": bool(has_note and int(has_note) > 0),
        }

    async def release(self) -> None:
        await self.db.rollback()
