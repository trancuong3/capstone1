from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class AdminAiWorkflow(Base):
    """Durable Admin proofreading and provisional child-safety review state."""

    __tablename__ = "adminaiworkflows"
    __table_args__ = (
        UniqueConstraint("actorid", "pageid", "idempotencykey", name="uq_adminaiworkflows_idempotency"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=False)
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="CASCADE"), nullable=False)
    ActorId = Column("actorid", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    IdempotencyKey = Column("idempotencykey", UUID(as_uuid=True), nullable=False)
    OriginalText = Column("originaltext", Text, nullable=False)
    InputText = Column("inputtext", Text, nullable=False)
    InputWords = Column("inputwords", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    ImagePath = Column("imagepath", String, nullable=False)
    ImageHash = Column("imagehash", String(64))
    OriginalOcrHash = Column("originalocrhash", String(64), nullable=False)
    AdminInputHash = Column("admininputhash", String(64), nullable=False)
    ProofreadText = Column("proofreadtext", Text)
    ProofreadOutputHash = Column("proofreadoutputhash", String(64))
    CandidateText = Column("candidatetext", Text)
    CandidateHash = Column("candidatehash", String(64))
    CandidateVersion = Column("candidateversion", Integer, nullable=False, server_default=text("0"))
    CandidateHistory = Column("candidatehistory", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    SafetyInputHash = Column("safetyinputhash", String(64))
    SafetyHistory = Column("safetyhistory", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    Suitability = Column("suitability", String(32))
    SafetyStatus = Column("safetystatus", String(32), nullable=False, server_default=text("'PENDING'"))
    Findings = Column("findings", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    CorrectionSuggestions = Column("correctionsuggestions", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    UncertainWordIndices = Column("uncertainwordindices", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    ProviderEvents = Column("providerevents", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    ProofreadMetadata = Column("proofreadmetadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    SafetyMetadata = Column("safetymetadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    ReviewEvents = Column("reviewevents", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    Status = Column("status", String(40), nullable=False, server_default=text("'QUEUED'"))
    Stage = Column("stage", String(40), nullable=False, server_default=text("'PROOFREADING'"))
    CompletedChunks = Column("completedchunks", Integer, nullable=False, server_default=text("0"))
    TotalChunks = Column("totalchunks", Integer, nullable=False, server_default=text("1"))
    Attempts = Column("attempts", Integer, nullable=False, server_default=text("0"))
    ErrorCode = Column("errorcode", String(80))
    WorkerId = Column("workerid", String(120))
    LeaseExpiresAt = Column("leaseexpiresat", DateTime(timezone=True))
    RetryAfter = Column("retryafter", DateTime(timezone=True))
    SafetyConfirmedAt = Column("safetyconfirmedat", DateTime(timezone=True))
    SafetyConfirmedBy = Column("safetyconfirmedby", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    ImageSafetyStatus = Column("imagesafetystatus", String(32), nullable=False, server_default=text("'NOT_REVIEWED'"))
    ImageSafetyReviewedBy = Column("imagesafetyreviewedby", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    ImageSafetyReviewedAt = Column("imagesafetyreviewedat", DateTime(timezone=True))
    ImageSafetyReviewNote = Column("imagesafetyreviewnote", String(1000))
    RightsProfileId = Column("rightsprofileid", UUID(as_uuid=True), ForeignKey("bookcontentrightsprofiles.id", ondelete="SET NULL"))
    RightsProfileVersion = Column("rightsprofileversion", Integer)
    RightsProfileHash = Column("rightsprofilehash", String(64))
    OcrApprovedAt = Column("ocrapprovedat", DateTime(timezone=True))
    OcrApprovedBy = Column("ocrapprovedby", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    FinalApprovedTextHash = Column("finalapprovedtexthash", String(64))
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)
    UpdatedAt = Column("updatedat", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
