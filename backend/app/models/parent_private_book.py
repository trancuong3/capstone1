from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class ParentBookPageSubmission(Base):
    __tablename__ = "parent_book_page_submissions"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    OwnerParentId = Column("owner_parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    BatchId = Column("batch_id", UUID(as_uuid=True), nullable=False)
    BatchTotalPages = Column("batch_total_pages", Integer, nullable=False, default=1, server_default=text("1"))
    SourcePageNumber = Column("source_page_number", Integer, nullable=False, default=1, server_default=text("1"))
    TargetPageNumber = Column("target_page_number", Integer, nullable=True)
    IdempotencyKey = Column("idempotency_key", String(128), nullable=False)
    SourceFileName = Column("source_file_name", Text, nullable=False)
    SourceFormat = Column("source_format", String(24), nullable=False)
    SourceStoragePath = Column("source_storage_path", Text, nullable=False)
    SourceSha256 = Column("source_sha256", String(64), nullable=False)
    ImageWidth = Column("image_width", Integer, nullable=False)
    ImageHeight = Column("image_height", Integer, nullable=False)
    SourceType = Column("source_type", String(40), nullable=False, default="OWNED_PHYSICAL_BOOK", server_default=text("'OWNED_PHYSICAL_BOOK'"))
    SourceNote = Column("source_note", Text, nullable=True)
    SubmissionVersion = Column("submission_version", Integer, nullable=False, default=1, server_default=text("1"))
    OptimisticLockVersion = Column("optimistic_lock_version", Integer, nullable=False, default=1, server_default=text("1"))
    WorkflowStatus = Column("workflow_status", String(40), nullable=False, default="CHECKING", server_default=text("'CHECKING'"))

    # Stage 1: OCR
    OcrStatus = Column("ocr_status", String(32), nullable=False, default="PENDING", server_default=text("'PENDING'"))
    OcrText = Column("ocr_text", Text, nullable=True)
    OcrWordsJson = Column("ocr_words_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    OcrMetaJson = Column("ocr_meta_json", JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    OcrHash = Column("ocr_hash", String(64), nullable=True)
    OcrErrorCode = Column("ocr_error_code", String(80), nullable=True)
    IsImageOnly = Column("is_image_only", Boolean, nullable=False, default=False, server_default=text("false"))

    # Stage 2: Spelling / OCR Proofreading
    ProofreadStatus = Column("proofread_status", String(32), nullable=False, default="PENDING", server_default=text("'PENDING'"))
    ProofreadText = Column("proofread_text", Text, nullable=True)
    ProofreadHash = Column("proofread_hash", String(64), nullable=True)
    ProofreadSuggestionsJson = Column("proofread_suggestions_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    UncertainWordIndicesJson = Column("uncertain_word_indices_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    ProofreadProviderEventsJson = Column("proofread_provider_events_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    ProofreadErrorCode = Column("proofread_error_code", String(80), nullable=True)
    SpellingAcceptedAt = Column("spelling_accepted_at", DateTime(timezone=True), nullable=True)

    # Candidate snapshot
    CandidateText = Column("candidate_text", Text, nullable=True)
    CandidateHash = Column("candidate_hash", String(64), nullable=True)
    CandidateWordsJson = Column("candidate_words_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))

    # Stage 3: Tool Check
    ToolCheckStatus = Column("tool_check_status", String(32), nullable=False, default="PENDING", server_default=text("'PENDING'"))
    ToolCheckInputHash = Column("tool_check_input_hash", String(64), nullable=True)
    ToolCheckSuitability = Column("tool_check_suitability", String(32), nullable=True)
    ToolCheckScopeJson = Column("tool_check_scope_json", JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    ToolCheckFindingsJson = Column("tool_check_findings_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    ToolCheckProviderEventsJson = Column("tool_check_provider_events_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    ToolCheckErrorCode = Column("tool_check_error_code", String(80), nullable=True)
    ToolCheckPolicyBlocked = Column("tool_check_policy_blocked", Boolean, nullable=False, default=False, server_default=text("false"))
    ToolCheckWorkflowId = Column("tool_check_workflow_id", UUID(as_uuid=True), nullable=True)
    ToolCheckCompletedAt = Column("tool_check_completed_at", DateTime(timezone=True), nullable=True)

    # Admin approval snapshot binding
    ApprovedSnapshotHash = Column("approved_snapshot_hash", String(64), nullable=True)
    ApprovedSubmissionVersion = Column("approved_submission_version", Integer, nullable=True)
    ApprovedBy = Column("approved_by", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    ApprovedAt = Column("approved_at", DateTime(timezone=True), nullable=True)
    AdminDecision = Column("admin_decision", String(32), nullable=True)
    AdminDecisionReason = Column("admin_decision_reason", Text, nullable=True)

    # Committed page link
    CommittedPageId = Column("committed_page_id", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"), nullable=True)
    CommittedRevisionId = Column("committed_revision_id", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="SET NULL"), nullable=True)
    CommittedAt = Column("committed_at", DateTime(timezone=True), nullable=True)

    # Worker lease & temp TTL
    WorkerId = Column("worker_id", String(120), nullable=True)
    LeaseExpiresAt = Column("lease_expires_at", DateTime(timezone=True), nullable=True)
    RetryAfter = Column("retry_after", DateTime(timezone=True), nullable=True)
    Attempts = Column("attempts", Integer, nullable=False, default=0, server_default=text("0"))
    TempExpiresAt = Column("temp_expires_at", DateTime(timezone=True), nullable=False, server_default=text("now() + interval '7 days'"))
    CreatedAt = Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
    UpdatedAt = Column("updated_at", DateTime(timezone=True), server_default=func.now(), nullable=False)


class ParentBookModerationRequest(Base):
    __tablename__ = "parent_book_moderation_requests"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    SubmissionId = Column("submission_id", UUID(as_uuid=True), ForeignKey("parent_book_page_submissions.id", ondelete="CASCADE"), nullable=False)
    OwnerParentId = Column("owner_parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    SubmissionVersion = Column("submission_version", Integer, nullable=False)
    SnapshotHash = Column("snapshot_hash", String(64), nullable=False)
    SourceSha256 = Column("source_sha256", String(64), nullable=False)
    SourceStoragePath = Column("source_storage_path", Text, nullable=False)
    OcrTextSnapshot = Column("ocr_text_snapshot", Text, nullable=True)
    ProofreadTextSnapshot = Column("proofread_text_snapshot", Text, nullable=True)
    CandidateTextSnapshot = Column("candidate_text_snapshot", Text, nullable=True)
    ToolCheckSnapshotJson = Column("tool_check_snapshot_json", JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    ParentSourceType = Column("parent_source_type", String(40), nullable=False)
    ParentSourceNote = Column("parent_source_note", Text, nullable=True)
    ParentRequestNote = Column("parent_request_note", Text, nullable=True)
    Status = Column("status", String(32), nullable=False, default="PENDING_ADMIN", server_default=text("'PENDING_ADMIN'"))
    PolicyBlocked = Column("policy_blocked", Boolean, nullable=False, default=False, server_default=text("false"))
    DecidedBy = Column("decided_by", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    DecidedAt = Column("decided_at", DateTime(timezone=True), nullable=True)
    DecisionReason = Column("decision_reason", Text, nullable=True)
    PreviousStatus = Column("previous_status", String(32), nullable=True)
    OptimisticLockVersion = Column("optimistic_lock_version", Integer, nullable=False, default=1, server_default=text("1"))
    CreatedAt = Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
    UpdatedAt = Column("updated_at", DateTime(timezone=True), server_default=func.now(), nullable=False)


class ParentBookOcrContributionConsent(Base):
    __tablename__ = "parent_book_ocr_contribution_consents"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False, unique=True)
    OwnerParentId = Column("owner_parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    Purpose = Column("purpose", Text, nullable=False, default="FLOW2_ADMIN_VERIFIED_OCR", server_default=text("'FLOW2_ADMIN_VERIFIED_OCR'"))
    Status = Column("status", Text, nullable=False, default="OPTED_OUT", server_default=text("'OPTED_OUT'"))
    ConsentVersion = Column("consent_version", Integer, nullable=False, default=1, server_default=text("1"))
    NoticeVersion = Column("notice_version", String(64), nullable=False)
    RightsConfirmed = Column("rights_confirmed", Boolean, nullable=False, default=False, server_default=text("false"))
    ConsentedAt = Column("consented_at", DateTime(timezone=True), nullable=True)
    RevokedAt = Column("revoked_at", DateTime(timezone=True), nullable=True)
    RevokeReason = Column("revoke_reason", Text, nullable=True)
    CreatedAt = Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
    UpdatedAt = Column("updated_at", DateTime(timezone=True), server_default=func.now(), nullable=False)


class ParentBookOcrContributionConsentEvent(Base):
    __tablename__ = "parent_book_ocr_contribution_consent_events"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    OwnerParentId = Column("owner_parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    ActorId = Column("actor_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    Action = Column("action", Text, nullable=False)
    ConsentVersion = Column("consent_version", Integer, nullable=False)
    Purpose = Column("purpose", Text, nullable=False, default="FLOW2_ADMIN_VERIFIED_OCR", server_default=text("'FLOW2_ADMIN_VERIFIED_OCR'"))
    NoticeVersion = Column("notice_version", String(64), nullable=False)
    RightsConfirmed = Column("rights_confirmed", Boolean, nullable=False, default=False, server_default=text("false"))
    Reason = Column("reason", Text, nullable=True)
    CreatedAt = Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False)


Table(
    "viread_ocr_outbox",
    Base.metadata,
    Column("id", UUID(as_uuid=True), primary_key=True),
    extend_existing=True,
    info={"skip_autogenerate": True},
)


class ParentBookFlow2Candidate(Base):
    __tablename__ = "parent_book_flow2_candidates"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    OwnerParentId = Column("owner_parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    PageId = Column("page_id", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=False)
    RevisionId = Column("revision_id", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="CASCADE"), nullable=False)
    SubmissionId = Column("submission_id", UUID(as_uuid=True), ForeignKey("parent_book_page_submissions.id", ondelete="SET NULL"), nullable=True)
    ConsentVersion = Column("consent_version", Integer, nullable=False)
    LineIndex = Column("line_index", Integer, nullable=False)
    IdempotencyKey = Column("idempotency_key", String(256), nullable=False, unique=True)
    SourceImagePath = Column("source_image_path", Text, nullable=False)
    SourceContentHash = Column("source_content_hash", String(64), nullable=False)
    CropBoxJson = Column("crop_box_json", JSONB, nullable=False)
    ImageSha256 = Column("image_sha256", String(64), nullable=False)
    ProposedLabel = Column("proposed_label", Text, nullable=False)
    VerifiedLabel = Column("verified_label", Text, nullable=True)
    VerifiedLabelSha256 = Column("verified_label_sha256", String(64), nullable=True)
    RightsBasis = Column("rights_basis", String(40), nullable=False)
    PiiCheckStatus = Column("pii_check_status", String(32), nullable=False, default="CLEAR", server_default=text("'CLEAR'"))
    PiiFlagsJson = Column("pii_flags_json", JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    QualityMetricsJson = Column("quality_metrics_json", JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    Status = Column("status", String(32), nullable=False, default="PENDING_VERIFICATION", server_default=text("'PENDING_VERIFICATION'"))
    VerifiedBy = Column("verified_by", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    VerifiedAt = Column("verified_at", DateTime(timezone=True), nullable=True)
    RejectionCode = Column("rejection_code", String(64), nullable=True)
    RejectionReason = Column("rejection_reason", Text, nullable=True)
    OutboxEventId = Column("outbox_event_id", UUID(as_uuid=True), ForeignKey("viread_ocr_outbox.id", ondelete="SET NULL"), nullable=True)
    SampleId = Column("sample_id", UUID(as_uuid=True), nullable=True)
    RevokedAt = Column("revoked_at", DateTime(timezone=True), nullable=True)
    RevokeReason = Column("revoke_reason", Text, nullable=True)
    CreatedAt = Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
    UpdatedAt = Column("updated_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
