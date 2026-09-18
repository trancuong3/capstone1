from sqlalchemy import Column, String, SmallInteger, Integer, Float, ForeignKey, DateTime, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.session import Base

class Book(Base):
    __tablename__ = "Books"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    Title = Column(String, nullable=False)
    Author = Column(String)
    MinGrade = Column(SmallInteger, nullable=False)
    MaxGrade = Column(SmallInteger, nullable=False)
    LifecycleStatus = Column(String, nullable=False)
    CreatedBy = Column(UUID(as_uuid=True), ForeignKey("Profiles.Id"))
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

class BookPage(Base):
    __tablename__ = "BookPages"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column(UUID(as_uuid=True), ForeignKey("Books.Id", ondelete="CASCADE"), nullable=False)
    PageNumber = Column(Integer, nullable=False)
    ImagePath = Column(String, nullable=False)
    Width = Column(Integer, nullable=False)
    Height = Column(Integer, nullable=False)
    FeaturePath = Column(String)
    ProcessingMeta = Column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    LifecycleStatus = Column(String, nullable=False)
    CurrentVerifiedRevisionId = Column(UUID(as_uuid=True), ForeignKey("PageRevisions.Id"))
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

class PageRevision(Base):
    __tablename__ = "PageRevisions"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    PageId = Column(UUID(as_uuid=True), ForeignKey("BookPages.Id", ondelete="CASCADE"), nullable=False)
    RevisionNo = Column(String, nullable=False)
    VerificationStatus = Column(String, nullable=False)
    VerifiedText = Column(String)
    ContentHash = Column(String, nullable=False)
    ProcessingMeta = Column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    VerifiedAt = Column(DateTime(timezone=True))
    VerifiedBy = Column(UUID(as_uuid=True), ForeignKey("Profiles.Id"))

class PageRevisionWord(Base):
    __tablename__ = "PageRevisionWords"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    PageRevisionId = Column(UUID(as_uuid=True), ForeignKey("PageRevisions.Id", ondelete="CASCADE"), nullable=False)
    WordIndex = Column(Integer, nullable=False)
    LineIndex = Column(Integer, nullable=False)
    Text = Column(String, nullable=False)
    NormalizedText = Column(String, nullable=False)
    BoundingBox = Column(JSONB, nullable=False)
    OCRConfidence = Column(Float)