"""ORM model for Feature #8 idempotent offline reading outbox sync ledger."""
from __future__ import annotations

from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class OfflineSyncEvent(Base):
    """Per-(parent_id, client_event_id) idempotency ledger for offline reading sync."""

    __tablename__ = "offline_sync_events"
    __table_args__ = (
        UniqueConstraint(
            "parent_id",
            "client_event_id",
            name="uq_offline_sync_events_parent_event",
        ),
        CheckConstraint(
            "event_kind IN ('SESSION_START', 'PAGE_READ', 'WORD_ATTEMPT', 'SESSION_FINISH')",
            name="ck_offline_sync_events_kind",
        ),
        CheckConstraint(
            "status IN ('APPLIED', 'RECONCILED')",
            name="ck_offline_sync_events_status",
        ),
    )

    Id = Column(
        "id",
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid4,
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
    ClientEventId = Column("client_event_id", UUID(as_uuid=True), nullable=False)
    ClientSessionId = Column("client_session_id", UUID(as_uuid=True), nullable=False)
    ServerSessionId = Column(
        "server_session_id",
        UUID(as_uuid=True),
        ForeignKey("readingsessions.id", ondelete="SET NULL"),
        nullable=True,
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
    PageRevisionId = Column(
        "page_revision_id",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    ReconciledRevisionId = Column(
        "reconciled_revision_id",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    EventKind = Column("event_kind", String(40), nullable=False)
    IdempotencyKey = Column("idempotency_key", String(160), nullable=True)
    StaleRevisionReconciled = Column(
        "stale_revision_reconciled",
        Boolean,
        nullable=False,
        default=False,
        server_default=text("false"),
    )
    Status = Column(
        "status",
        String(24),
        nullable=False,
        default="APPLIED",
        server_default=text("'APPLIED'"),
    )
    PayloadHash = Column("payload_hash", String(64), nullable=False)
    ResultMeta = Column(
        "result_meta",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    OccurredAt = Column(
        "occurred_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    CreatedAt = Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
