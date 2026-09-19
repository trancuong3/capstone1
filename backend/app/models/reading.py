from sqlalchemy import Column, String, SmallInteger, ForeignKey, DateTime, Float, text
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