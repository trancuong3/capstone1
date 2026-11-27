"""SQLAlchemy repository for karaoke musical practice sessions & musical profiles."""

from typing import Sequence
from uuid import UUID

from sqlalchemy import desc, func, select
from sqlalchemy.exc import OperationalError, ProgrammingError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.entertainment_v4 import (
    KaraokeMusicalProfile,
    KaraokePracticeSession,
    LearningSkillEvidence,
)
from app.models.karaoke import KaraokeSong, KaraokeSongVersion
from app.models.profile import ChildProfile


class KaraokePracticeTableUnavailable(Exception):
    """Raised when V4 karaoke practice tables have not been migrated yet."""


def is_missing_table_error(error: BaseException) -> bool:
    orig = getattr(error, "orig", None)
    sqlstate = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    if sqlstate == "42P01":
        return True
    message = f"{error} {orig or ''}".lower()
    return (
        "undefinedtable" in message
        or "no such table" in message
        or ("relation" in message and "does not exist" in message)
    )


class KaraokePracticeRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_child_for_parent(
        self, parent_id: UUID, child_id: UUID
    ) -> ChildProfile | None:
        return await self.db.scalar(
            select(ChildProfile).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )

    async def get_song_and_published_version(
        self, song_id: UUID
    ) -> tuple[KaraokeSong, KaraokeSongVersion | None] | None:
        song = await self.db.scalar(
            select(KaraokeSong).where(KaraokeSong.id == song_id)
        )
        if song is None:
            return None
        published = None
        if song.published_version_id is not None:
            published = await self.db.scalar(
                select(KaraokeSongVersion).where(
                    KaraokeSongVersion.id == song.published_version_id,
                    KaraokeSongVersion.song_id == song_id,
                )
            )
        return song, published

    async def create_practice_session(
        self,
        session_row: KaraokePracticeSession,
        evidence_rows: Sequence[LearningSkillEvidence],
    ) -> KaraokePracticeSession:
        try:
            self.db.add(session_row)
            await self.db.flush()
        except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
            if is_missing_table_error(exc):
                await self.db.rollback()
                raise KaraokePracticeTableUnavailable(
                    "karaoke_practice_sessions table is not migrated"
                ) from None
            await self.db.rollback()
            raise

        if evidence_rows:
            try:
                async with self.db.begin_nested():
                    for item in evidence_rows:
                        self.db.add(item)
                    await self.db.flush()
            except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
                if not is_missing_table_error(exc):
                    raise
                # LearningSkillEvidence table is optional if not yet migrated.

        await self.db.commit()
        await self.db.refresh(session_row)
        return session_row

    async def list_practice_sessions(
        self,
        parent_id: UUID,
        child_id: UUID,
        *,
        song_id: UUID | None = None,
        limit: int = 10,
    ) -> tuple[list[KaraokePracticeSession], int, int | None, int]:
        try:
            filters = [
                KaraokePracticeSession.ParentId == parent_id,
                KaraokePracticeSession.ChildId == child_id,
            ]
            if song_id is not None:
                filters.append(KaraokePracticeSession.SongId == song_id)

            total = int(
                (
                    await self.db.scalar(
                        select(func.count(KaraokePracticeSession.Id)).where(*filters)
                    )
                )
                or 0
            )

            rows = list(
                (
                    await self.db.scalars(
                        select(KaraokePracticeSession)
                        .where(*filters)
                        .order_by(
                            desc(KaraokePracticeSession.CreatedAt),
                            desc(KaraokePracticeSession.Id),
                        )
                        .limit(limit)
                    )
                ).all()
            )

            # Best full-song score strictly excludes SEGMENT / LINE_PRACTICE / RHYTHM_TAP
            # and INSUFFICIENT_EVIDENCE sessions!
            best_row = (
                await self.db.execute(
                    select(
                        func.max(KaraokePracticeSession.OverallScore),
                        func.max(KaraokePracticeSession.Stars),
                    ).where(
                        *filters,
                        KaraokePracticeSession.PracticeMode == "FULL_SONG",
                        KaraokePracticeSession.ScoringMode != "INSUFFICIENT_EVIDENCE",
                        KaraokePracticeSession.OverallScore.isnot(None),
                    )
                )
            ).first()
            best_score = int(best_row[0]) if best_row and best_row[0] is not None else None
            best_stars = int(best_row[1]) if best_row and best_row[1] is not None else 0
            return rows, total, best_score, best_stars
        except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
            if is_missing_table_error(exc):
                await self.db.rollback()
                raise KaraokePracticeTableUnavailable(
                    "karaoke_practice_sessions table is not migrated"
                ) from None
            raise

    async def get_musical_profile(
        self, song_version_id: UUID
    ) -> KaraokeMusicalProfile | None:
        try:
            return await self.db.scalar(
                select(KaraokeMusicalProfile).where(
                    KaraokeMusicalProfile.SongVersionId == song_version_id
                )
            )
        except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
            if is_missing_table_error(exc):
                await self.db.rollback()
                return None
            raise
