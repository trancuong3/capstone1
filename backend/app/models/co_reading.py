"""ORM models for Feature #2: Co-Reading Role-Play & Parent Storyteller Voice (PARENT_PRIVATE).

NOTE: Do NOT import this via backend/app/models/__init__.py to avoid merge conflicts.
      Import directly: `from app.models.co_reading import ParentPageNarration, FamilyReadingPostcard`
"""

from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class ParentPageNarration(Base):
    """Mom/Dad storyteller voice recording per book page — strictly PARENT_PRIVATE.

    Unique per (book_id, page_id); CASCADE-deleted when book, page, or parent is deleted.
    word_timings stores [{word, start_ms, end_ms}] JSONB for synchronized word highlight.
    """

    __tablename__ = "parent_page_narrations"
    __table_args__ = (
        CheckConstraint(
            "audio_format IN ('webm','ogg','wav','mp3','m4a','aac')",
            name="ck_parent_page_narrations_audio_format",
        ),
        CheckConstraint(
            "file_size_bytes > 0 AND file_size_bytes <= 2097152",
            name="ck_parent_page_narrations_file_size",
        ),
        CheckConstraint(
            "duration_ms > 0",
            name="ck_parent_page_narrations_duration",
        ),
        CheckConstraint(
            "visibility = 'PARENT_PRIVATE'",
            name="ck_parent_page_narrations_visibility",
        ),
        UniqueConstraint(
            "book_id",
            "page_id",
            name="uq_parent_page_narrations_book_page",
        ),
        Index("ix_parent_page_narrations_parent_id", "parent_id"),
        Index("ix_parent_page_narrations_book_id", "book_id"),
    )

    Id = Column(
        "id",
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    ParentId = Column(
        "parent_id",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    BookId = Column(
        "book_id",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="CASCADE"),
        nullable=False,
    )
    PageId = Column(
        "page_id",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="CASCADE"),
        nullable=False,
    )
    StoragePath = Column("storage_path", Text, nullable=False)
    AudioFormat = Column("audio_format", String(8), nullable=False)
    FileSizeBytes = Column("file_size_bytes", Integer, nullable=False)
    DurationMs = Column("duration_ms", Integer, nullable=False)
    WordTimings = Column(
        "word_timings",
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
    Visibility = Column(
        "visibility",
        String(24),
        nullable=False,
        default="PARENT_PRIVATE",
        server_default=text("'PARENT_PRIVATE'"),
    )
    CreatedAt = Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    UpdatedAt = Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class FamilyReadingPostcard(Base):
    """PARENT_PRIVATE family keepsake celebrating a child's best reading passage.

    CASCADE-deleted when parent or child profile is deleted. Never shared externally.
    Optional short audio clip (<= 256 KiB).
    """

    __tablename__ = "family_reading_postcards"
    __table_args__ = (
        CheckConstraint(
            "audio_format IS NULL OR audio_format IN ('webm','ogg','wav','mp3','m4a','aac')",
            name="ck_family_reading_postcards_audio_format",
        ),
        CheckConstraint(
            "audio_size_bytes IS NULL OR (audio_size_bytes > 0 AND audio_size_bytes <= 262144)",
            name="ck_family_reading_postcards_audio_size",
        ),
        CheckConstraint(
            "visibility = 'PARENT_PRIVATE'",
            name="ck_family_reading_postcards_visibility",
        ),
        Index("ix_family_reading_postcards_parent_id", "parent_id"),
        Index("ix_family_reading_postcards_child_id", "child_id"),
        Index(
            "ix_family_reading_postcards_child_created",
            "child_id",
            "created_at",
        ),
    )

    Id = Column(
        "id",
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    ParentId = Column(
        "parent_id",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    ChildId = Column(
        "child_id",
        UUID(as_uuid=True),
        ForeignKey("childprofiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    Title = Column("title", String(240), nullable=False)
    PassageText = Column("passage_text", Text, nullable=False)
    SourceBookId = Column(
        "source_book_id",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="SET NULL"),
        nullable=True,
    )
    SourcePageId = Column(
        "source_page_id",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="SET NULL"),
        nullable=True,
    )
    AudioClipPath = Column("audio_clip_path", Text, nullable=True)
    AudioFormat = Column("audio_format", String(8), nullable=True)
    AudioSizeBytes = Column("audio_size_bytes", Integer, nullable=True)
    EmojiBadge = Column(
        "emoji_badge",
        String(16),
        nullable=False,
        default="🌟",
        server_default=text("'🌟'"),
    )
    Visibility = Column(
        "visibility",
        String(24),
        nullable=False,
        default="PARENT_PRIVATE",
        server_default=text("'PARENT_PRIVATE'"),
    )
    CreatedAt = Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    UpdatedAt = Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
