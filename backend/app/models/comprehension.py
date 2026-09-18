from sqlalchemy import Column, String, Boolean, Float, ForeignKey, DateTime, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func
from app.database.session import Base

class ComprehensionQuestion(Base):
    __tablename__ = "ComprehensionQuestions"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column(UUID(as_uuid=True), ForeignKey("ReadingSessions.Id", ondelete="CASCADE"), nullable=False)
    PageId = Column(UUID(as_uuid=True), ForeignKey("BookPages.Id"), nullable=False)
    PageRevisionId = Column(UUID(as_uuid=True), ForeignKey("PageRevisions.Id"), nullable=False)
    Type = Column(String, nullable=False)
    Prompt = Column(String, nullable=False)
    ExpectedAnswer = Column(String, nullable=False)
    AcceptedAnswers = Column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    SourceSpan = Column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    Difficulty = Column(String, nullable=False)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

class ComprehensionAnswer(Base):
    __tablename__ = "ComprehensionAnswers"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    QuestionId = Column(UUID(as_uuid=True), ForeignKey("ComprehensionQuestions.Id", ondelete="CASCADE"), nullable=False)
    Answer = Column(String, nullable=False)
    IsCorrect = Column(Boolean)
    Score = Column(Float)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)