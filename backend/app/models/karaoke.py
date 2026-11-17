"""Independent, versioned karaoke catalog; never shares reading-session tables."""
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    CheckConstraint, Column, DateTime, ForeignKey, ForeignKeyConstraint,
    Index, Integer, SmallInteger, String, Text, UniqueConstraint, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database.session import Base


def utcnow():
    return datetime.now(timezone.utc)


class KaraokeSong(Base):
    __tablename__ = "karaoke_songs"
    __table_args__ = (
        CheckConstraint("status IN ('DRAFT','PUBLISHED','HIDDEN')", name="karaoke_song_status"),
        CheckConstraint("revision >= 1", name="karaoke_song_revision"),
        CheckConstraint(
            "(status = 'DRAFT' AND published_version_id IS NULL) OR "
            "(status IN ('PUBLISHED','HIDDEN') AND published_version_id IS NOT NULL)",
            name="karaoke_song_publication",
        ),
        ForeignKeyConstraint(
            ["id", "published_version_id"],
            ["karaoke_song_versions.song_id", "karaoke_song_versions.id"],
            name="karaoke_song_published_version_fk", use_alter=True,
            deferrable=True, initially="DEFERRED",
        ),
        Index("karaoke_song_catalog_idx", "status", "created_at", "id"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    status = Column(String(16), nullable=False, default="DRAFT", server_default="DRAFT")
    published_version_id = Column(UUID(as_uuid=True), nullable=True)
    revision = Column(Integer, nullable=False, default=1, server_default="1")
    created_by = Column(UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))


class KaraokeSongVersion(Base):
    __tablename__ = "karaoke_song_versions"
    __table_args__ = (
        UniqueConstraint("song_id", "id", name="karaoke_version_song_id_key"),
        UniqueConstraint("song_id", "version_no", name="karaoke_version_number_key"),
        CheckConstraint("version_no >= 1", name="karaoke_version_number"),
        CheckConstraint("state IN ('DRAFT','PUBLISHED','SUPERSEDED')", name="karaoke_version_state"),
        CheckConstraint("1 <= min_grade AND min_grade <= max_grade AND max_grade <= 5", name="karaoke_version_grades"),
        CheckConstraint("char_length(title) <= 200 AND char_length(author) <= 200", name="karaoke_version_title"),
        CheckConstraint("char_length(source_note) <= 1000 AND char_length(usage_note) <= 1000", name="karaoke_version_source"),
        CheckConstraint("duration_ms IS NULL OR duration_ms BETWEEN 1 AND 300000", name="karaoke_version_duration"),
        CheckConstraint("audio_size_bytes IS NULL OR audio_size_bytes BETWEEN 1 AND 20971520", name="karaoke_version_audio_size"),
        Index("karaoke_one_draft_idx", "song_id", unique=True, postgresql_where=text("state = 'DRAFT'")),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    song_id = Column(UUID(as_uuid=True), ForeignKey("karaoke_songs.id", ondelete="RESTRICT"), nullable=False)
    version_no = Column(Integer, nullable=False)
    state = Column(String(16), nullable=False, default="DRAFT", server_default="DRAFT")
    title = Column(String(200), nullable=False, default="", server_default="")
    author = Column(String(200), nullable=False, default="", server_default="")
    min_grade = Column(SmallInteger, nullable=False, default=1, server_default="1")
    max_grade = Column(SmallInteger, nullable=False, default=5, server_default="5")
    source_note = Column(Text, nullable=False, default="", server_default="")
    usage_note = Column(Text, nullable=False, default="", server_default="")
    audio_path = Column(Text)
    cover_path = Column(Text)
    audio_sha256 = Column(String(64))
    timed_audio_sha256 = Column(String(64))
    audio_size_bytes = Column(Integer)
    duration_ms = Column(Integer)
    lyrics = Column(JSONB, nullable=False, default=lambda: {"format_version": 1, "lines": []},
                    server_default=text("'{\"format_version\":1,\"lines\":[]}'::jsonb"))
    created_by = Column(UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))
    published_at = Column(DateTime(timezone=True))
