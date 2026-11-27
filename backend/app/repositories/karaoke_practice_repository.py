"""SQLAlchemy repository for karaoke musical practice sessions & musical profiles."""

from datetime import datetime, timezone
import json
from typing import Any, Sequence
from uuid import UUID

from sqlalchemy import desc, func, select, text
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


def is_missing_column_error(error: BaseException) -> bool:
    orig = getattr(error, "orig", None)
    sqlstate = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    if sqlstate == "42703":
        return True
    message = f"{error} {orig or ''}".lower()
    return (
        "undefinedcolumn" in message
        or "no such column" in message
        or ("column" in message and "does not exist" in message)
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
            async with self.db.begin_nested():
                return await self.db.scalar(
                    select(KaraokeMusicalProfile).where(
                        KaraokeMusicalProfile.SongVersionId == song_version_id
                    )
                )
        except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
            if is_missing_table_error(exc):
                return None
            raise

    async def is_storage_ready(self) -> bool:
        """Check whether karaoke_musical_profiles storage is migrated & queryable."""
        try:
            async with self.db.begin_nested():
                await self.db.execute(
                    select(KaraokeMusicalProfile.SongVersionId).limit(1)
                )
            return True
        except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
            if is_missing_table_error(exc):
                return False
            return False

    async def get_version_melody_profile(
        self, song_version_id: UUID
    ) -> dict[str, Any] | None:
        """Read `karaoke_song_versions.melody_profile` safely (degrades to None if unmigrated)."""
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    text(
                        "SELECT melody_profile FROM karaoke_song_versions WHERE id = :vid"
                    ),
                    {"vid": song_version_id},
                )
                row = result.first()
                if not row or row[0] is None:
                    return None
                val = row[0]
                if isinstance(val, str):
                    val = json.loads(val)
                return val if isinstance(val, dict) else None
        except (ProgrammingError, OperationalError, SQLAlchemyError, ValueError) as exc:
            if is_missing_column_error(exc) or is_missing_table_error(exc):
                return None
            return None

    async def save_version_melody_profile(
        self, song_version_id: UUID, melody_profile: dict[str, Any]
    ) -> bool:
        """Persist `karaoke_song_versions.melody_profile` safely (no-op if column not yet migrated)."""
        try:
            async with self.db.begin_nested():
                await self.db.execute(
                    text(
                        "UPDATE karaoke_song_versions "
                        "SET melody_profile = CAST(:payload AS jsonb) "
                        "WHERE id = :vid"
                    ),
                    {
                        "vid": song_version_id,
                        "payload": json.dumps(melody_profile, ensure_ascii=False),
                    },
                )
            return True
        except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
            if is_missing_column_error(exc) or is_missing_table_error(exc):
                return False
            return False

    async def upsert_musical_profile(
        self,
        song_version_id: UUID,
        *,
        bpm: float | None,
        audio_type: str,
        has_pitch_contour: bool,
        has_beat_grid: bool,
        source_method: str,
        profile_json: dict[str, Any],
    ) -> bool:
        """Upsert a version's musical & melody profile safely; returns False if table unavailable."""
        now = datetime.now(timezone.utc)
        try:
            async with self.db.begin_nested():
                existing = await self.db.scalar(
                    select(KaraokeMusicalProfile).where(
                        KaraokeMusicalProfile.SongVersionId == song_version_id
                    )
                )
                if existing is None:
                    self.db.add(
                        KaraokeMusicalProfile(
                            SongVersionId=song_version_id,
                            Bpm=bpm,
                            AudioType=audio_type,
                            HasPitchContour=has_pitch_contour,
                            HasBeatGrid=has_beat_grid,
                            SourceMethod=source_method,
                            ProfileJson=profile_json,
                            UpdatedAt=now,
                        )
                    )
                else:
                    existing.Bpm = bpm
                    existing.AudioType = audio_type
                    existing.HasPitchContour = has_pitch_contour
                    existing.HasBeatGrid = has_beat_grid
                    existing.SourceMethod = source_method
                    existing.ProfileJson = profile_json
                    existing.UpdatedAt = now
                await self.db.flush()
            return True
        except (ProgrammingError, OperationalError, SQLAlchemyError) as exc:
            if is_missing_table_error(exc):
                return False
            raise
