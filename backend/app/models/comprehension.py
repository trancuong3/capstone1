from sqlalchemy import Column, String, ForeignKey, DateTime, Float, text, Boolean
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.session import Base

class ComprehensionQuestion(Base):
    __tablename__ = "comprehensionquestions"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column("sessionid", UUID(as_uuid=True), ForeignKey("readingsessions.id", ondelete="CASCADE"), nullable=False)
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=False)
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="CASCADE"), nullable=False)
    Type = Column("type", String, nullable=False)
    Prompt = Column("prompt", String, nullable=False)
    ExpectedAnswer = Column("expectedanswer", String, nullable=False)
    AcceptedAnswers = Column("acceptedanswers", JSONB, server_default=text("'[]'::jsonb"))
    SourceSpan = Column("sourcespan", JSONB, server_default=text("'[]'::jsonb"))
    Difficulty = Column("difficulty", String, nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    answers = relationship("ComprehensionAnswer", back_populates="question", cascade="all, delete-orphan")


class ComprehensionAnswer(Base):
    __tablename__ = "comprehensionanswers"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    QuestionId = Column("questionid", UUID(as_uuid=True), ForeignKey("comprehensionquestions.id", ondelete="CASCADE"), nullable=False)
    Answer = Column("answer", String, nullable=False)
    IsCorrect = Column("iscorrect", Boolean)
    Score = Column("score", Float)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    question = relationship("ComprehensionQuestion", back_populates="answers")