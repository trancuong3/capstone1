"""SQLAlchemy ORM models for Wave 1 Family Safety and Encouragement Notes."""

from __future__ import annotations

import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database.session import Base


class ParentSecurityPin(Base):
    __tablename__ = "parent_security_pins"
    __table_args__ = (
        CheckConstraint("failed_attempts >= 0", name="ck_parent_security_pins_failed_nonneg"),
    )

    ParentId = Column(
        "parent_id",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    PinHash = Column("pin_hash", String(256), nullable=False)
    PinSalt = Column("pin_salt", String(64), nullable=False)
    ChildModeDefault = Column(
        "child_mode_default",
        Boolean,
        nullable=False,
        default=False,
        server_default=text("false"),
    )
    FailedAttempts = Column(
        "failed_attempts",
        SmallInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    LockedUntil = Column("locked_until", DateTime(timezone=True), nullable=True)
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
        onupdate=func.now(),
    )


class ParentEncouragementNote(Base):
    __tablename__ = "parent_encouragement_notes"
    __table_args__ = (
        CheckConstraint(
            "size_bytes > 0 AND size_bytes <= 262144",
            name="ck_parent_encouragement_notes_size",
        ),
        CheckConstraint(
            "duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 10500)",
            name="ck_parent_encouragement_notes_duration",
        ),
        Index(
            "ix_parent_encouragement_notes_child_active",
            "child_id",
            "is_active",
            "created_at",
        ),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ChildId = Column(
        "child_id",
        UUID(as_uuid=True),
        ForeignKey("childprofiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    ParentId = Column(
        "parent_id",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    Title = Column("title", String(100), nullable=True)
    StorageBucket = Column("storage_bucket", String(80), nullable=False)
    StoragePath = Column("storage_path", String(320), nullable=False)
    MimeType = Column("mime_type", String(64), nullable=False)
    SizeBytes = Column("size_bytes", Integer, nullable=False)
    DurationMs = Column("duration_ms", Integer, nullable=True)
    IsActive = Column(
        "is_active",
        Boolean,
        nullable=False,
        default=True,
        server_default=text("true"),
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
        onupdate=func.now(),
    )
