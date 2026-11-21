from sqlalchemy import Column, String, SmallInteger, Integer, ForeignKey, DateTime, Float, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.session import Base

class Book(Base):
    __tablename__ = "books"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    Name = Column("name", String, nullable=True)
    Title = Column("title", String, nullable=False)
    Author = Column("author", String)
    MinGrade = Column("mingrade", SmallInteger, nullable=False)
    MaxGrade = Column("maxgrade", SmallInteger, nullable=False)
    ExpectedPageCount = Column("expectedpagecount", Integer, nullable=True)
    LifecycleStatus = Column("lifecyclestatus", String, nullable=False)
    CreatedBy = Column("createdby", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    VisibilityScope = Column("visibility_scope", String, nullable=False, default="CATALOG", server_default=text("'CATALOG'"))
    OwnerParentId = Column("owner_parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="RESTRICT"), nullable=True)
    ModerationStatus = Column("moderation_status", String, nullable=False, default="ACTIVE", server_default=text("'ACTIVE'"))
    SuspendedAt = Column("suspended_at", DateTime(timezone=True), nullable=True)
    SuspendedBy = Column("suspended_by", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    SuspendedReason = Column("suspended_reason", String, nullable=True)
    SourceDeclaration = Column("source_declaration", String, nullable=True)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    pages = relationship("BookPage", back_populates="book", cascade="all, delete-orphan")


class BookPage(Base):
    __tablename__ = "bookpages"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    PageNumber = Column("pagenumber", SmallInteger, nullable=False)
    ImagePath = Column("imagepath", String, nullable=False)
    Width = Column("width", SmallInteger, nullable=False)
    Height = Column("height", SmallInteger, nullable=False)
    FeaturePath = Column("featurepath", String)
    ContentType = Column("contenttype", String(32), nullable=False, server_default=text("'CONTENT'"))
    ProcessingMeta = Column("processingmeta", JSONB, server_default=text("'{}'::jsonb"))
    CurrentVerifiedRevisionId = Column("currentverifiedrevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="SET NULL"))
    LifecycleStatus = Column("lifecyclestatus", String, nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    book = relationship("Book", back_populates="pages")
    revisions = relationship("PageRevision", back_populates="page", foreign_keys="[PageRevision.PageId]", cascade="all, delete-orphan")


class PageRevision(Base):
    __tablename__ = "pagerevisions"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=False)
    RevisionNo = Column("revisionno", String, nullable=False)
    VerificationStatus = Column("verificationstatus", String, nullable=False)
    OriginalOcrText = Column("originalocrtext", String)
    VerifiedText = Column("verifiedtext", String)
    DraftText = Column("drafttext", String)
    ContentHash = Column("contenthash", String, nullable=False)
    ProcessingMeta = Column("processingmeta", JSONB, server_default=text("'{}'::jsonb"))
    VerifiedBy = Column("verifiedby", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    VerifiedAt = Column("verifiedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    page = relationship("BookPage", back_populates="revisions", foreign_keys=[PageId])
    words = relationship("PageRevisionWord", back_populates="revision", cascade="all, delete-orphan")


class PageRevisionWord(Base):
    __tablename__ = "pagerevisionwords"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="CASCADE"), nullable=False)
    WordIndex = Column("wordindex", SmallInteger, nullable=False)
    LineIndex = Column("lineindex", SmallInteger, nullable=False)
    Text = Column("text", String, nullable=False)
    NormalizedText = Column("normalizedtext", String, nullable=False)
    BoundingBox = Column("boundingbox", JSONB, nullable=False)
    OCRConfidence = Column("ocrconfidence", Float)

    revision = relationship("PageRevision", back_populates="words")
