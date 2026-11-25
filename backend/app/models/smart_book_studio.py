"""ORM models for ViRead AI Smart Book Studio V2 (strictly additive satellite tables)."""

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class BookPresentationAsset(Base):
    """Stores cover and page presentation assets strictly isolated from Source Evidence & OCR training."""

    __tablename__ = "book_presentation_assets"
    __table_args__ = (
        CheckConstraint(
            "asset_role IN ('COVER', 'PAGE_ILLUSTRATION', 'THUMBNAIL')",
            name="ck_book_presentation_assets_role",
        ),
        CheckConstraint(
            "source_type IN ('USER_UPLOAD', 'ORIGINAL_CROP', 'ENHANCED_CROP', 'AI_GENERATED', 'METADATA_RENDER')",
            name="ck_book_presentation_assets_source",
        ),
        CheckConstraint(
            "moderation_status IN ('PENDING', 'APPROVED', 'REJECTED', 'STALE')",
            name="ck_book_presentation_assets_moderation",
        ),
        CheckConstraint("asset_version >= 1", name="ck_book_presentation_assets_version"),
        Index("ix_book_presentation_assets_book_role_active", "book_id", "asset_role", "is_active"),
        Index(
            "ix_book_presentation_assets_page_role_active",
            "book_page_id",
            "asset_role",
            "is_active",
            postgresql_where=text("book_page_id IS NOT NULL"),
        ),
        Index("ix_book_presentation_assets_owner", "owner_id", "created_at"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    BookPageId = Column("book_page_id", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=True)
    SourceRevisionId = Column(
        "source_revision_id",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    OwnerId = Column("owner_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    AssetRole = Column("asset_role", String(32), nullable=False)
    SourceType = Column("source_type", String(32), nullable=False)
    StoragePath = Column("storage_path", Text, nullable=False)
    MimeType = Column("mime_type", String(32), nullable=False, server_default=text("'image/webp'"))
    Width = Column("width", Integer, nullable=True)
    Height = Column("height", Integer, nullable=True)
    SizeBytes = Column("size_bytes", Integer, nullable=True)
    AssetHash = Column("asset_hash", String(64), nullable=False)
    AssetVersion = Column("asset_version", Integer, nullable=False, server_default=text("1"))
    IsActive = Column("is_active", Boolean, nullable=False, server_default=text("true"))
    TextFreeVerified = Column("text_free_verified", Boolean, nullable=False, server_default=text("false"))
    ModerationStatus = Column("moderation_status", String(24), nullable=False, server_default=text("'PENDING'"))
    ProviderName = Column("provider_name", String(64), nullable=True)
    ModelId = Column("model_id", String(96), nullable=True)
    JobId = Column("job_id", UUID(as_uuid=True), nullable=True)
    MetadataJson = Column("metadata_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class BookStyleBible(Base):
    """Caches visual style & character consistency constraints per book (invalidated only by context_hash)."""

    __tablename__ = "book_style_bibles"

    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), primary_key=True)
    OwnerId = Column("owner_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    ContextHash = Column("context_hash", String(64), nullable=False)
    BibleJson = Column("bible_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    ProviderName = Column("provider_name", String(64), nullable=True)
    ModelId = Column("model_id", String(96), nullable=True)
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class PageOcrExtraction(Base):
    """Stores 3-layer OCR content extraction provenance, geometry transforms, and block decisions."""

    __tablename__ = "page_ocr_extractions"
    __table_args__ = (
        CheckConstraint("filter_mode IN ('shadow', 'active')", name="ck_page_ocr_extractions_mode"),
        CheckConstraint(
            "page_kind IN ('TEXT_ONLY', 'TEXT_AND_IMAGE', 'IMAGE_PRIMARY', 'COMIC', "
            "'POEM', 'EXERCISE', 'MULTI_COLUMN', 'TEXT_OVER_IMAGE', 'LOW_QUALITY')",
            name="ck_page_ocr_extractions_kind",
        ),
        Index("ix_page_ocr_extractions_page_updated", "book_page_id", "updated_at"),
        Index("ix_page_ocr_extractions_book_updated", "book_id", "updated_at"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=False)
    BookPageId = Column("book_page_id", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=False)
    PageRevisionId = Column(
        "page_revision_id",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    OwnerId = Column("owner_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    SourceHash = Column("source_hash", String(64), nullable=False)
    AlgorithmVersion = Column("algorithm_version", String(32), nullable=False, server_default=text("'v2.0'"))
    FilterMode = Column("filter_mode", String(16), nullable=False, server_default=text("'active'"))
    PageKind = Column("page_kind", String(32), nullable=False, server_default=text("'TEXT_AND_IMAGE'"))
    GeometryTransformJson = Column("geometry_transform_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    BlocksJson = Column("blocks_json", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    CanonicalText = Column("canonical_text", Text, nullable=False, server_default=text("''"))
    StatsJson = Column("stats_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    RequiresReview = Column("requires_review", Boolean, nullable=False, server_default=text("false"))
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class SmartStudioJob(Base):
    """Durable background job with atomic lease, heartbeat, checkpoints, revision fencing & idempotency."""

    __tablename__ = "smart_studio_jobs"
    __table_args__ = (
        CheckConstraint(
            "job_type IN ('OCR_EXTRACT', 'COVER_GENERATE', 'ILLUSTRATION_EXTRACT', "
            "'ILLUSTRATION_GENERATE', 'STYLE_BIBLE', 'BATCH_BOOK_IMPORT')",
            name="ck_smart_studio_jobs_type",
        ),
        CheckConstraint("actor_role IN ('admin', 'parent')", name="ck_smart_studio_jobs_role"),
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_WORKER', 'WAITING_FOR_QUOTA', "
            "'WAITING_FOR_REVIEW', 'RETRY_SCHEDULED', 'PARTIAL_SUCCESS', 'SUCCEEDED', "
            "'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'STALE')",
            name="ck_smart_studio_jobs_status",
        ),
        CheckConstraint("attempt_count >= 0 AND max_attempts >= 1", name="ck_smart_studio_jobs_attempts"),
        CheckConstraint(
            "(progress_completed IS NULL AND progress_total IS NULL) OR "
            "(progress_completed IS NOT NULL AND progress_total IS NOT NULL AND "
            "progress_completed >= 0 AND progress_total >= progress_completed)",
            name="ck_smart_studio_jobs_progress",
        ),
        UniqueConstraint("actor_id", "idempotency_key", name="uq_smart_studio_jobs_actor_idem"),
        Index("ix_smart_studio_jobs_actor_updated", "actor_id", "updated_at"),
        Index("ix_smart_studio_jobs_status_priority", "status", "priority", "created_at"),
        Index(
            "ix_smart_studio_jobs_lease",
            "status",
            "lease_expires_at",
            postgresql_where=text("status = 'RUNNING'"),
        ),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    JobType = Column("job_type", String(40), nullable=False)
    ActorId = Column("actor_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    ActorRole = Column("actor_role", String(16), nullable=False)
    BookId = Column("book_id", UUID(as_uuid=True), ForeignKey("books.id", ondelete="CASCADE"), nullable=True)
    BookPageId = Column("book_page_id", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="CASCADE"), nullable=True)
    SourceRevisionId = Column(
        "source_revision_id",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    InputHash = Column("input_hash", String(64), nullable=False)
    IdempotencyKey = Column("idempotency_key", String(128), nullable=False)
    Stage = Column("stage", String(40), nullable=False, server_default=text("'QUEUED'"))
    Status = Column("status", String(24), nullable=False, server_default=text("'QUEUED'"))
    Priority = Column("priority", SmallInteger, nullable=False, server_default=text("50"))
    AttemptCount = Column("attempt_count", Integer, nullable=False, server_default=text("0"))
    MaxAttempts = Column("max_attempts", Integer, nullable=False, server_default=text("3"))
    WorkerId = Column("worker_id", String(96), nullable=True)
    LeaseToken = Column("lease_token", UUID(as_uuid=True), nullable=True)
    LeaseExpiresAt = Column("lease_expires_at", DateTime(timezone=True), nullable=True)
    HeartbeatAt = Column("heartbeat_at", DateTime(timezone=True), nullable=True)
    ProgressCompleted = Column("progress_completed", Integer, nullable=True)
    ProgressTotal = Column("progress_total", Integer, nullable=True)
    ProgressUnit = Column("progress_unit", String(24), nullable=True)
    CheckpointsJson = Column("checkpoints_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    ResultRefJson = Column("result_ref_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    ErrorCode = Column("error_code", String(64), nullable=True)
    ErrorMessageVi = Column("error_message_vi", Text, nullable=True)
    RetryAfterAt = Column("retry_after_at", DateTime(timezone=True), nullable=True)
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())
    StartedAt = Column("started_at", DateTime(timezone=True), nullable=True)
    CompletedAt = Column("completed_at", DateTime(timezone=True), nullable=True)
