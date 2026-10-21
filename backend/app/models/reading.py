from sqlalchemy import Column, String, SmallInteger, ForeignKey, DateTime, Float, CheckConstraint, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.session import Base

class ReadingSession(Base):
    __tablename__ = "readingsessions"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("childid", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    SelectedPageId = Column("selectedpageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    SelectedPageRevisionId = Column("selectedpagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="SET NULL"))
    StartPageId = Column("startpageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    EndPageId = Column("endpageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    CurrentPageId = Column("currentpageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    State = Column("state", String, nullable=False)
    Mode = Column("mode", String, nullable=False)
    ClientMeta = Column("clientmeta", JSONB, server_default=text("'{}'::jsonb"))
    StartedAt = Column("startedat", DateTime(timezone=True), server_default=func.now(), nullable=False)
    EndedAt = Column("endedat", DateTime(timezone=True))

    events = relationship("ReadingEvent", back_populates="session", cascade="all, delete-orphan")
    fluency_assessments = relationship("FluencyAssessment", back_populates="session", cascade="all, delete-orphan")


class ReadingEvent(Base):
    __tablename__ = "readingevents"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column("sessionid", UUID(as_uuid=True), ForeignKey("readingsessions.id", ondelete="CASCADE"), nullable=False)
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=False)
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="CASCADE"), nullable=False)
    WordId = Column("wordid", UUID(as_uuid=True), ForeignKey("pagerevisionwords.id", ondelete="SET NULL"))
    Type = Column("type", String, nullable=False)
    StartMs = Column("startms", SmallInteger, nullable=False)
    EndMs = Column("endms", SmallInteger)
    Confidence = Column("confidence", Float)
    Status = Column("status", String, nullable=False)
    Metadata = Column("metadata", JSONB, server_default=text("'{}'::jsonb"))
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    session = relationship("ReadingSession", back_populates="events")


class FluencyAssessment(Base):
    __tablename__ = "fluencyassessments"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column("sessionid", UUID(as_uuid=True), ForeignKey("readingsessions.id", ondelete="CASCADE"), nullable=False)
    Metrics = Column("metrics", JSONB, nullable=False)
    Score = Column("score", Float)
    Uncertainty = Column("uncertainty", Float)
    ModelVersion = Column("modelversion", String, nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    session = relationship("ReadingSession", back_populates="fluency_assessments")


class ReadingSessionPage(Base):
    """Immutable page/revision snapshot and durable progress for one reading session."""

    __tablename__ = "readingsessionpages"
    __table_args__ = (
        UniqueConstraint("sessionid", "pageorder", name="uq_readingsessionpages_session_order"),
        UniqueConstraint("sessionid", "pageid", name="uq_readingsessionpages_session_page"),
        CheckConstraint("pageorder >= 0", name="ck_readingsessionpages_pageorder"),
        CheckConstraint("status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')", name="ck_readingsessionpages_status"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column("sessionid", UUID(as_uuid=True), ForeignKey("readingsessions.id", ondelete="CASCADE"), nullable=False)
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="RESTRICT"), nullable=False)
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="RESTRICT"), nullable=False)
    PageNumber = Column("pagenumber", SmallInteger, nullable=False)
    PageOrder = Column("pageorder", SmallInteger, nullable=False)
    Status = Column("status", String, nullable=False, server_default=text("'PENDING'"))
    StartedAt = Column("startedat", DateTime(timezone=True))
    CompletedAt = Column("completedat", DateTime(timezone=True))
