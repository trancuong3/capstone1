from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database.session import Base


class ReadingPresenceSetting(Base):
    """Parent opt-in for "reading paused, nobody in frame" email. Off by default."""

    __tablename__ = "readingpresencesettings"

    ParentId = Column(
        "parentid",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    EmailEnabled = Column(
        "emailenabled", Boolean, nullable=False, server_default=text("false")
    )
    UpdatedAt = Column(
        "updatedat",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ReadingPresenceAlert(Base):
    """One pending/sent "nobody in frame" notification for an absence episode.

    No images, audio, transcript or book text is ever stored here.
    The recipient is NOT stored: it is resolved from the verified auth email
    of the session owner at send time.
    """

    __tablename__ = "readingpresencealerts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('PENDING', 'SENDING', 'SENT', 'CANCELLED', 'EXPIRED', 'FAILED')",
            name="ck_readingpresencealerts_status",
        ),
        UniqueConstraint(
            "sessionid", "episodeid", name="uq_readingpresencealerts_session_episode"
        ),
        Index("ix_readingpresencealerts_due", "status", "dueat"),
        Index("ix_readingpresencealerts_parent_created", "parentid", "createdat"),
    )

    Id = Column(
        "id",
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    SessionId = Column(
        "sessionid",
        UUID(as_uuid=True),
        ForeignKey("readingsessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    ParentId = Column(
        "parentid",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    ChildId = Column(
        "childid",
        UUID(as_uuid=True),
        ForeignKey("childprofiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    EpisodeId = Column("episodeid", UUID(as_uuid=True), nullable=False)
    Status = Column(
        "status", String(16), nullable=False, server_default=text("'PENDING'")
    )
    DueAt = Column("dueat", DateTime(timezone=True), nullable=False)
    ExpiresAt = Column("expiresat", DateTime(timezone=True), nullable=False)
    LastConfirmedAt = Column(
        "lastconfirmedat", DateTime(timezone=True), nullable=False
    )
    Attempts = Column(
        "attempts", Integer, nullable=False, server_default=text("0")
    )
    ClaimedAt = Column("claimedat", DateTime(timezone=True))
    SentAt = Column("sentat", DateTime(timezone=True))
    CancelReason = Column("cancelreason", String(32))
    ErrorCode = Column("errorcode", String(64))
    CreatedAt = Column(
        "createdat",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
