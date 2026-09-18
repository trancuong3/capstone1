from sqlalchemy import Column, String, Integer, Float, ForeignKey, DateTime, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func
from app.database.session import Base

class ReadingSession(Base):
    __tablename__ = "ReadingSessions"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column(UUID(as_uuid=True), ForeignKey("ChildProfiles.Id", ondelete="CASCADE"), nullable=False)
    BookId = Column(UUID(as_uuid=True), ForeignKey("Books.Id"), nullable=False)
    SelectedPageId = Column(UUID(as_uuid=True), ForeignKey("BookPages.Id"))
    SelectedPageRevisionId = Column(UUID(as_uuid=True), ForeignKey("PageRevisions.Id"))
    StartedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    EndedAt = Column(DateTime(timezone=True))
    State = Column(String, nullable=False)
    Mode = Column(String, server_default="realtime", nullable=False)
    ClientMeta = Column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)

class ReadingEvent(Base):
    __tablename__ = "ReadingEvents"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column(UUID(as_uuid=True), ForeignKey("ReadingSessions.Id", ondelete="CASCADE"), nullable=False)
    PageId = Column(UUID(as_uuid=True), ForeignKey("BookPages.Id"), nullable=False)
    PageRevisionId = Column(UUID(as_uuid=True), ForeignKey("PageRevisions.Id"), nullable=False)
    WordId = Column(UUID(as_uuid=True), ForeignKey("PageRevisionWords.Id"))
    Type = Column(String, nullable=False)
    StartMs = Column(Integer, nullable=False)
    EndMs = Column(Integer)
    Confidence = Column(Float)
    Status = Column(String, nullable=False)
    Metadata = Column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

class FluencyAssessment(Base):
    __tablename__ = "FluencyAssessments"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column(UUID(as_uuid=True), ForeignKey("ReadingSessions.Id", ondelete="CASCADE"), unique=True, nullable=False)
    Metrics = Column(JSONB, nullable=False)
    Score = Column(Float)
    Uncertainty = Column(Float)
    ModelVersion = Column(String, nullable=False)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)