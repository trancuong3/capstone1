from __future__ import annotations

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
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class ParentEmailPreference(Base):
    """Per-parent notification settings and anti-spam guardrails."""

    __tablename__ = "parentemailpreferences"
    __table_args__ = (
        CheckConstraint(
            "inactivitydays BETWEEN 2 AND 30",
            name="ck_parentemailpreferences_inactivity_days",
        ),
        CheckConstraint(
            "digestweekday BETWEEN 0 AND 6",
            name="ck_parentemailpreferences_digest_weekday",
        ),
        CheckConstraint(
            "timezone <> ''",
            name="ck_parentemailpreferences_timezone_nonempty",
        ),
        CheckConstraint(
            "quiethoursstart BETWEEN 0 AND 23",
            name="ck_parentemailpreferences_quiet_start",
        ),
        CheckConstraint(
            "quiethoursend BETWEEN 0 AND 23",
            name="ck_parentemailpreferences_quiet_end",
        ),
        CheckConstraint(
            "maxemailsperweek BETWEEN 1 AND 14",
            name="ck_parentemailpreferences_max_per_week",
        ),
    )

    ParentId = Column(
        "parentid",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    WeeklyDigestEnabled = Column(
        "weeklydigestenabled", Boolean, nullable=False, server_default=text("true")
    )
    InactivityAlertEnabled = Column(
        "inactivityalertenabled", Boolean, nullable=False, server_default=text("true")
    )
    InactivityDays = Column(
        "inactivitydays", Integer, nullable=False, server_default=text("5")
    )
    MilestoneEnabled = Column(
        "milestoneenabled", Boolean, nullable=False, server_default=text("true")
    )
    DigestWeekday = Column(
        "digestweekday", SmallInteger, nullable=False, server_default=text("6")
    )
    Timezone = Column(
        "timezone",
        String(64),
        nullable=False,
        server_default=text("'Asia/Ho_Chi_Minh'"),
    )
    QuietHoursStart = Column(
        "quiethoursstart", SmallInteger, nullable=False, server_default=text("21")
    )
    QuietHoursEnd = Column(
        "quiethoursend", SmallInteger, nullable=False, server_default=text("7")
    )
    MaxEmailsPerWeek = Column(
        "maxemailsperweek", SmallInteger, nullable=False, server_default=text("4")
    )
    UpdatedAt = Column(
        "updatedat",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class ParentEmailDelivery(Base):
    """Durable, deduplicated ledger of automated parent notification emails."""

    __tablename__ = "parentemaildeliveries"
    __table_args__ = (
        CheckConstraint(
            "category IN ('WEEKLY_DIGEST', 'INACTIVITY_ALERT', 'MILESTONE', 'TEST_EMAIL')",
            name="ck_parentemaildeliveries_category",
        ),
        CheckConstraint(
            "status IN ('PENDING', 'SENDING', 'SENT', 'RETRY', 'FAILED', 'SKIPPED')",
            name="ck_parentemaildeliveries_status",
        ),
        UniqueConstraint("dedupekey", name="uq_parentemaildeliveries_dedupekey"),
        Index("ix_parentemaildeliveries_parent_created", "parentid", "createdat"),
        Index(
            "ix_parentemaildeliveries_parent_category_sent",
            "parentid",
            "category",
            "sentat",
        ),
        Index("ix_parentemaildeliveries_retry", "status", "nextattemptat"),
    )

    Id = Column(
        "id",
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
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
        ForeignKey("childprofiles.id", ondelete="SET NULL"),
        nullable=True,
    )
    Category = Column("category", String(32), nullable=False)
    DedupeKey = Column("dedupekey", String(160), nullable=False)
    Status = Column(
        "status", String(20), nullable=False, server_default=text("'PENDING'")
    )
    Subject = Column("subject", String(200), nullable=False)
    Attempts = Column(
        "attempts", Integer, nullable=False, server_default=text("0")
    )
    LastAttemptAt = Column("lastattemptat", DateTime(timezone=True), nullable=True)
    NextAttemptAt = Column("nextattemptat", DateTime(timezone=True), nullable=True)
    SentAt = Column("sentat", DateTime(timezone=True), nullable=True)
    ErrorCode = Column("errorcode", String(64), nullable=True)
    Metadata = Column(
        "metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    CreatedAt = Column(
        "createdat",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
