"""ORM models for precomputed and cached TTS audio entries."""
from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Numeric,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class TtsAudioCacheEntry(Base):
    """Durable metadata & storage pointer for precomputed/cached TTS audio clips."""

    __tablename__ = "tts_audio_cache_entries"
    __table_args__ = (
        CheckConstraint(
            "scope IN ('CATALOG', 'PRIVATE', 'COACHING')",
            name="ck_tts_cache_scope",
        ),
        CheckConstraint(
            "status IN ('ACTIVE', 'STALE', 'DELETED')",
            name="ck_tts_cache_status",
        ),
        CheckConstraint(
            "(scope = 'PRIVATE' AND owner_parent_id IS NOT NULL) "
            "OR (scope IN ('CATALOG', 'COACHING') AND owner_parent_id IS NULL)",
            name="ck_tts_cache_scope_owner",
        ),
    )

    Id = Column(
        "id",
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    Scope = Column("scope", Text, nullable=False)
    OwnerParentId = Column(
        "owner_parent_id",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=True,
    )
    BookId = Column(
        "book_id",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="CASCADE"),
        nullable=True,
    )
    PageId = Column(
        "page_id",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="CASCADE"),
        nullable=True,
    )
    PageRevisionId = Column(
        "page_revision_id",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="CASCADE"),
        nullable=True,
    )
    ContentSha256 = Column("content_sha256", Text, nullable=False)
    NormalizedText = Column("normalized_text", Text, nullable=False)
    VoiceId = Column("voice_id", Text, nullable=False)
    ModelVersion = Column("model_version", Text, nullable=False)
    Speed = Column(
        "speed",
        Numeric(3, 2),
        nullable=False,
        default=1.00,
        server_default=text("1.00"),
    )
    AudioFormat = Column("audio_format", Text, nullable=False)
    StorageBucket = Column("storage_bucket", Text, nullable=False)
    StoragePath = Column("storage_path", Text, nullable=False)
    ByteSize = Column("byte_size", BigInteger, nullable=False)
    DurationSeconds = Column("duration_seconds", Float, nullable=True)
    WordTimingsJson = Column(
        "word_timings_json", JSONB(none_as_null=True), nullable=True
    )
    Status = Column(
        "status",
        Text,
        nullable=False,
        default="ACTIVE",
        server_default=text("'ACTIVE'"),
    )
    LastAccessedAt = Column(
        "last_accessed_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    HitCount = Column(
        "hit_count",
        BigInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
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


class TtsAudioCacheDailyUsage(Base):
    """Per-UTC-day TTS cache egress and hit/miss counters."""

    __tablename__ = "tts_audio_cache_daily_usage"

    UsageDate = Column("usage_date", Date, primary_key=True)
    BytesServed = Column(
        "bytes_served",
        BigInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    HitCount = Column(
        "hit_count",
        BigInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    MissCount = Column(
        "miss_count",
        BigInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    UpdatedAt = Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
