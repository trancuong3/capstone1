from sqlalchemy import Column, String, Integer, SmallInteger, Date, Time, Boolean, DateTime, ForeignKey, CheckConstraint, UniqueConstraint, Index, text
from sqlalchemy.dialects.postgresql import UUID, ARRAY
from sqlalchemy.sql import func
from app.database.session import Base


class ReadingGoal(Base):
    __tablename__ = "readinggoals"
    __table_args__ = (
        CheckConstraint("metric IN ('MINUTES', 'SESSIONS')", name="ck_readinggoals_metric"),
        CheckConstraint("period IN ('DAILY', 'WEEKLY')", name="ck_readinggoals_period"),
        CheckConstraint("targetvalue > 0", name="ck_readinggoals_target_positive"),
        CheckConstraint("status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'ENDED')", name="ck_readinggoals_status"),
        CheckConstraint("endson IS NULL OR endson >= startson", name="ck_readinggoals_date_range"),
        Index("ix_readinggoals_child_status", "childid", "status"),
    )
    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("childid", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    Metric = Column("metric", String(16), nullable=False)
    TargetValue = Column("targetvalue", Integer, nullable=False)
    Period = Column("period", String(16), nullable=False)
    StartsOn = Column("startson", Date, nullable=False)
    EndsOn = Column("endson", Date)
    Timezone = Column("timezone", String(64), nullable=False, server_default=text("'Asia/Ho_Chi_Minh'"))
    Status = Column("status", String(16), nullable=False, server_default=text("'ACTIVE'"))
    CompletedValue = Column("completedvalue", Integer)
    CompletedAt = Column("completedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ChildBookCollection(Base):
    __tablename__ = "childbookcollections"
    __table_args__ = (
        UniqueConstraint("childid", "bookid", "collectiontype", name="uq_childbookcollections_child_book_type"),
        CheckConstraint("collectiontype IN ('FAVORITE', 'WANT_TO_READ')", name="ck_childbookcollections_type"),
        Index("ix_childbookcollections_child_type_created", "childid", "collectiontype", "createdat"),
    )
    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("childid", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="RESTRICT"), nullable=False)
    CollectionType = Column("collectiontype", String(20), nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())


class ReadingReminder(Base):
    __tablename__ = "readingreminders"
    __table_args__ = (
        CheckConstraint("cardinality(weekdays) BETWEEN 1 AND 7", name="ck_readingreminders_weekdays_count"),
        CheckConstraint("timezone <> ''", name="ck_readingreminders_timezone_nonempty"),
        Index("ix_readingreminders_child_active", "childid", "isactive"),
    )
    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("childid", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    RemindAt = Column("remindat", Time, nullable=False)
    Weekdays = Column("weekdays", ARRAY(SmallInteger), nullable=False, server_default=text("ARRAY[0,1,2,3,4,5,6]::smallint[]"))
    Timezone = Column("timezone", String(64), nullable=False, server_default=text("'Asia/Ho_Chi_Minh'"))
    IsActive = Column("isactive", Boolean, nullable=False, server_default=text("true"))
    EmailEnabled = Column("emailenabled", Boolean, nullable=False, server_default=text("false"))
    EmailEnabledAt = Column("emailenabledat", DateTime(timezone=True))
    DeletedAt = Column("deletedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ReadingReminderOccurrence(Base):
    __tablename__ = "readingreminderoccurrences"
    __table_args__ = (
        UniqueConstraint("reminderid", "scheduledlocaldate", name="uq_reminder_occurrence_local_day"),
        CheckConstraint("status IN ('PENDING', 'ACKNOWLEDGED')", name="ck_reminderoccurrence_status"),
        Index("ix_reminderoccurrences_status_scheduled", "status", "scheduledfor"),
    )
    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ReminderId = Column("reminderid", UUID(as_uuid=True), ForeignKey("readingreminders.id", ondelete="CASCADE"), nullable=False)
    ScheduledLocalDate = Column("scheduledlocaldate", Date, nullable=False)
    ScheduledFor = Column("scheduledfor", DateTime(timezone=True), nullable=False)
    Status = Column("status", String(16), nullable=False, server_default=text("'PENDING'"))
    AcknowledgedAt = Column("acknowledgedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())


class ReadingReminderEmailDelivery(Base):
    """Durable email outbox; owner and occurrence key survive reminder deletion."""

    __tablename__ = "readingreminderemaildeliveries"
    __table_args__ = (
        UniqueConstraint("occurrencekey", name="uq_reminder_email_delivery_occurrence_key"),
        UniqueConstraint("providermessageid", name="uq_reminder_email_delivery_provider_message"),
        CheckConstraint("status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED')", name="ck_reminder_email_delivery_status"),
        CheckConstraint("attemptcount >= 0", name="ck_reminder_email_delivery_attempts"),
        Index("ix_reminder_email_delivery_due", "status", "nextattemptat"),
        Index("ix_reminder_email_delivery_parent_created", "parentid", "createdat"),
    )
    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    # Deliberately not a foreign key, so history survives hard deletion.
    OccurrenceKey = Column("occurrencekey", UUID(as_uuid=True), nullable=False)
    OccurrenceId = Column("occurrenceid", UUID(as_uuid=True), ForeignKey("readingreminderoccurrences.id", ondelete="SET NULL"), nullable=True)
    ReminderId = Column("reminderid", UUID(as_uuid=True), ForeignKey("readingreminders.id", ondelete="SET NULL"), nullable=True)
    # Snapshot of the owning Parent account at queue time; no email address is stored.
    ParentId = Column("parentid", UUID(as_uuid=True), nullable=False)
    Status = Column("status", String(16), nullable=False, server_default=text("'PENDING'"))
    AttemptCount = Column("attemptcount", Integer, nullable=False, server_default=text("0"))
    LastAttemptAt = Column("lastattemptat", DateTime(timezone=True))
    NextAttemptAt = Column("nextattemptat", DateTime(timezone=True), nullable=True, server_default=func.now())
    ProviderAcceptedAt = Column("provideracceptedat", DateTime(timezone=True))
    ProviderMessageId = Column("providermessageid", String(255))
    LastErrorCode = Column("lasterrorcode", String(80))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
