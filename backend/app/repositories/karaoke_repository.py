"""SQL persistence and short transaction boundaries for karaoke."""
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import dataclass
from types import SimpleNamespace
from uuid import UUID, uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import aliased

from app.models.karaoke import KaraokeSong, KaraokeSongVersion, utcnow
from app.models.profile import ChildProfile, Profile


@dataclass
class SongState:
    song: KaraokeSong
    draft: KaraokeSongVersion | None
    published: KaraokeSongVersion | None

    def snapshot(self):
        """Materialize only columns before rollback expires ORM objects."""
        def freeze(record):
            if record is None:
                return None
            return SimpleNamespace(**{
                column.key: deepcopy(getattr(record, column.key))
                for column in record.__table__.columns
            })
        return SongState(freeze(self.song), freeze(self.draft), freeze(self.published))


class ConcurrentKaraokeUpdate(Exception):
    pass


class KaraokeRepository:
    def __init__(self, db):
        self.db = db

    @asynccontextmanager
    async def read(self):
        try:
            yield
        finally:
            await self.db.rollback()

    @asynccontextmanager
    async def write(self):
        try:
            yield
            await self.db.commit()
        except BaseException:
            await self.db.rollback()
            raise

    async def actor(self, actor_id):
        row = (await self.db.execute(
            select(Profile.Role, Profile.Active).where(Profile.Id == actor_id)
        )).first()
        return tuple(row) if row else None

    async def child_grade(self, actor_id, child_id):
        return await self.db.scalar(select(ChildProfile.Grade).where(
            ChildProfile.Id == child_id, ChildProfile.ParentId == actor_id,
        ))

    async def state(self, song_id, *, lock=False):
        query = select(KaraokeSong).where(KaraokeSong.id == song_id)
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        song = await self.db.scalar(query)
        if song is None:
            return None
        draft = await self.db.scalar(select(KaraokeSongVersion).where(
            KaraokeSongVersion.song_id == song_id, KaraokeSongVersion.state == "DRAFT",
        ))
        published = None
        if song.published_version_id:
            published = await self.db.scalar(select(KaraokeSongVersion).where(
                KaraokeSongVersion.id == song.published_version_id,
                KaraokeSongVersion.song_id == song_id,
            ))
        return SongState(song, draft, published)

    async def create(self, actor_id, values):
        now = utcnow()
        song = KaraokeSong(id=uuid4(), status="DRAFT", revision=1,
                           created_by=actor_id, created_at=now, updated_at=now)
        self.db.add(song)
        await self.db.flush()
        draft = await self.add_draft(song.id, actor_id, 1, values)
        return SongState(song, draft, None)

    async def add_draft(self, song_id, actor_id, version_no, values):
        now = utcnow()
        version = KaraokeSongVersion(
            id=uuid4(), song_id=song_id, version_no=version_no, state="DRAFT",
            created_by=actor_id, created_at=now, updated_at=now, **values,
        )
        self.db.add(version)
        await self.db.flush()
        return version

    async def next_version(self, song_id):
        return 1 + (await self.db.scalar(select(func.max(KaraokeSongVersion.version_no)).where(
            KaraokeSongVersion.song_id == song_id,
        )) or 0)

    async def bump(self, song, expected_revision):
        now = utcnow()
        # Flush business changes under the row lock; publication FK is deferred.
        await self.db.flush()
        result = await self.db.execute(update(KaraokeSong).where(
            KaraokeSong.id == song.id, KaraokeSong.revision == expected_revision,
        ).values(revision=expected_revision + 1, updated_at=now).returning(KaraokeSong.id))
        if result.scalar_one_or_none() is None:
            raise ConcurrentKaraokeUpdate()
        song.revision = expected_revision + 1
        song.updated_at = now

    async def referenced(self, path):
        return bool(await self.db.scalar(select(KaraokeSongVersion.id).where(or_(
            KaraokeSongVersion.audio_path == path, KaraokeSongVersion.cover_path == path,
        )).limit(1)))

    async def list_states(self, *, search, status, grade, limit, offset):
        draft, published = aliased(KaraokeSongVersion), aliased(KaraokeSongVersion)
        query = select(KaraokeSong, draft, published).outerjoin(draft, (
            (draft.song_id == KaraokeSong.id) & (draft.state == "DRAFT")
        )).outerjoin(published, (
            (published.id == KaraokeSong.published_version_id) &
            (published.song_id == KaraokeSong.id)
        ))
        if grade is not None:
            query = query.where(KaraokeSong.status == "PUBLISHED", published.state == "PUBLISHED",
                                published.min_grade <= grade, published.max_grade >= grade)
            title = published.title
        else:
            title = func.coalesce(func.nullif(draft.title, ""), published.title, "")
            if status:
                query = query.where(KaraokeSong.status == status)
        if search:
            literal = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            query = query.where(title.ilike(f"%{literal}%", escape="\\"))
        total = await self.db.scalar(select(func.count()).select_from(query.subquery()))
        rows = (await self.db.execute(query.order_by(
            KaraokeSong.created_at.desc(), KaraokeSong.id.desc(),
        ).offset(offset).limit(limit))).all()
        return [SongState(*row).snapshot() for row in rows], total
