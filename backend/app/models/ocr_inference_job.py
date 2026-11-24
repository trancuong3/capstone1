from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class OcrInferenceJob(Base):
    """Durable queue job executed by the remote OCR worker."""

    __tablename__ = "ocr_inference_jobs"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    JobKind = Column("job_kind", String(40), nullable=False)
    Status = Column("status", String(32), nullable=False, default="QUEUED", server_default=text("'QUEUED'"))
    Priority = Column("priority", Integer, nullable=False, default=100, server_default=text("100"))
    IdempotencyKey = Column("idempotency_key", Text, nullable=True)

    OwnerUserId = Column(
        "owner_user_id",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="SET NULL"),
        nullable=True,
    )
    BookId = Column(
        "book_id",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="CASCADE"),
        nullable=True,
    )
    PageId = Column(
        "page_id",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="CASCADE"),
        nullable=True,
    )
    RevisionId = Column(
        "revision_id",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    SubmissionId = Column(
        "submission_id",
        UUID(as_uuid=True),
        ForeignKey("parent_book_page_submissions.id", ondelete="CASCADE"),
        nullable=True,
    )
    LocalScanRequestId = Column("local_scan_request_id", Text, nullable=True)

    ImageBucket = Column("image_bucket", Text, nullable=True)
    ImagePath = Column("image_path", Text, nullable=False)
    ImageSha256 = Column("image_sha256", Text, nullable=False)
    ImageWidth = Column("image_width", Integer, nullable=True)
    ImageHeight = Column("image_height", Integer, nullable=True)
    ImageMimeType = Column("image_mime_type", Text, nullable=True)
    ProcessingMeta = Column("processing_meta", JSONB, nullable=False, server_default=text("'{}'::jsonb"))

    ExpectedVersion = Column("expected_version", Integer, nullable=False, default=1, server_default=text("1"))
    ExpectedCandidateHash = Column("expected_candidate_hash", Text, nullable=True)
    ExpectedVerifiedRevisionId = Column("expected_verified_revision_id", UUID(as_uuid=True), nullable=True)
    ExpectedLatestRevisionId = Column("expected_latest_revision_id", UUID(as_uuid=True), nullable=True)

    FencingToken = Column("fencing_token", BigInteger, nullable=False, default=0, server_default=text("0"))
    WorkerId = Column("worker_id", Text, nullable=True)
    ClaimedAt = Column("claimed_at", DateTime(timezone=True), nullable=True)
    HeartbeatAt = Column("heartbeat_at", DateTime(timezone=True), nullable=True)
    LeaseExpiresAt = Column("lease_expires_at", DateTime(timezone=True), nullable=True)

    AttemptCount = Column("attempt_count", Integer, nullable=False, default=0, server_default=text("0"))
    MaxAttempts = Column("max_attempts", Integer, nullable=False, default=3, server_default=text("3"))
    NextRetryAt = Column("next_retry_at", DateTime(timezone=True), nullable=True)
    RetryDelaySeconds = Column("retry_delay_seconds", Integer, nullable=True)
    ErrorCode = Column("error_code", Text, nullable=True)
    ErrorMessage = Column("error_message", Text, nullable=True)

    ResultPayload = Column("result_payload", JSONB, nullable=True)
    ModelProfile = Column("model_profile", Text, nullable=True)
    ModelSha256 = Column("model_sha256", Text, nullable=True)
    EngineDiagnostics = Column("engine_diagnostics", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    DurationMs = Column("duration_ms", Integer, nullable=True)
    CancelledReason = Column("cancelled_reason", Text, nullable=True)

    CreatedAt = Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
    UpdatedAt = Column("updated_at", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    CompletedAt = Column("completed_at", DateTime(timezone=True), nullable=True)


class OcrWorkerHeartbeat(Base):
    """Latest health/model/hardware heartbeat emitted by a remote OCR worker."""

    __tablename__ = "ocr_worker_heartbeats"

    WorkerId = Column("worker_id", Text, primary_key=True)
    Hostname = Column("hostname", Text, nullable=True)
    AppVersion = Column("app_version", Text, nullable=True)
    GitSha = Column("git_sha", Text, nullable=True)
    Status = Column("status", String(32), nullable=False, default="IDLE", server_default=text("'IDLE'"))
    ActiveJobId = Column(
        "active_job_id",
        UUID(as_uuid=True),
        ForeignKey("ocr_inference_jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    ActiveJobCount = Column("active_job_count", Integer, nullable=False, default=0, server_default=text("0"))
    ConcurrencyLimit = Column("concurrency_limit", Integer, nullable=False, default=1, server_default=text("1"))
    ModelProfile = Column("model_profile", Text, nullable=True)
    ModelSha256 = Column("model_sha256", Text, nullable=True)
    Engines = Column("engines", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    SystemStats = Column("system_stats", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    LastError = Column("last_error", Text, nullable=True)
    LastHeartbeatAt = Column("last_heartbeat_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
    CreatedAt = Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False)
    UpdatedAt = Column("updated_at", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
