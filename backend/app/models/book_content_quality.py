from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database.session import Base


class BookContentReport(Base):
    __tablename__ = "bookcontentreports"
    __table_args__ = (
        CheckConstraint(
            "issuetype IN ('BOOK_METADATA_ERROR', 'SPELLING_ERROR', 'MISSING_CONTENT', "
            "'OCR_MISMATCH', 'IMAGE_QUALITY_ERROR', 'DUPLICATE_PAGE', "
            "'PAGE_ORDER_ERROR', 'OTHER')",
            name="ck_bookcontentreports_issue_type",
        ),
        CheckConstraint(
            "status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')",
            name="ck_bookcontentreports_status",
        ),
        CheckConstraint(
            "length(btrim(description)) BETWEEN 1 AND 4000",
            name="ck_bookcontentreports_description",
        ),
        UniqueConstraint(
            "reporterid",
            "idempotencykey",
            name="uq_bookcontentreports_reporter_idempotency",
        ),
        Index("ix_bookcontentreports_status_created", "status", "createdat"),
        Index("ix_bookcontentreports_book_created", "bookid", "createdat"),
        Index("ix_bookcontentreports_page_created", "pageid", "createdat"),
        Index("ix_bookcontentreports_reporter_created", "reporterid", "createdat"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ReporterId = Column("reporterid", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    ReporterNameSnapshot = Column("reporternamesnapshot", String(160))
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="SET NULL"))
    BookTitleSnapshot = Column("booktitlesnapshot", String(500), nullable=False)
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    PageNumberSnapshot = Column("pagenumbersnapshot", Integer)
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="SET NULL"))
    VerifiedTextSnapshot = Column("verifiedtextsnapshot", Text)
    ContentHashSnapshot = Column("contenthashsnapshot", String(128))
    IssueType = Column("issuetype", String(40), nullable=False)
    Description = Column("description", String(4000), nullable=False)
    ReportedText = Column("reportedtext", String(1200))
    SuggestedCorrection = Column("suggestedcorrection", String(1200))
    IdempotencyKey = Column("idempotencykey", UUID(as_uuid=True), nullable=False)
    ScanRunId = Column("scanrunid", UUID(as_uuid=True), ForeignKey("bookqualityscanruns.id", ondelete="SET NULL"))
    Status = Column("status", String(20), nullable=False, server_default=text("'OPEN'"))
    AdminResolutionNote = Column("adminresolutionnote", String(2000))
    ReviewedBy = Column("reviewedby", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    ReviewedByNameSnapshot = Column("reviewedbynamesnapshot", String(160))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    ResolvedAt = Column("resolvedat", DateTime(timezone=True))


class BookQualityScanRun(Base):
    __tablename__ = "bookqualityscanruns"
    __table_args__ = (
        CheckConstraint(
            "triggertype IN ('PARENT_REPORT', 'ADMIN_MANUAL', 'STALE_RESCAN')",
            name="ck_bookqualityscanruns_trigger_type",
        ),
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')",
            name="ck_bookqualityscanruns_status",
        ),
        CheckConstraint(
            "scan_scope IN ('BOOK', 'PAGE')",
            name="ck_bookqualityscanruns_scope",
        ),
        CheckConstraint(
            "totalpages >= 0 AND completedpages >= 0 AND skippedpages >= 0 "
            "AND failedpages >= 0 AND aicompletedpages >= 0 AND aiunavailablepages >= 0",
            name="ck_bookqualityscanruns_nonnegative_counts",
        ),
        Index("ix_bookqualityscanruns_queue", "status", "createdat"),
        Index("ix_bookqualityscanruns_book_created", "bookid", "createdat"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="SET NULL"))
    BookTitleSnapshot = Column("booktitlesnapshot", String(500), nullable=False)
    TriggerType = Column("triggertype", String(24), nullable=False)
    Scope = Column("scan_scope", String(8), nullable=False, server_default=text("'BOOK'"))
    TargetPageId = Column("targetpageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    Status = Column("status", String(16), nullable=False, server_default=text("'QUEUED'"))
    TotalPages = Column("totalpages", Integer, nullable=False, server_default=text("0"))
    CompletedPages = Column("completedpages", Integer, nullable=False, server_default=text("0"))
    SkippedPages = Column("skippedpages", Integer, nullable=False, server_default=text("0"))
    FailedPages = Column("failedpages", Integer, nullable=False, server_default=text("0"))
    AICompletedPages = Column("aicompletedpages", Integer, nullable=False, server_default=text("0"))
    AIUnavailablePages = Column("aiunavailablepages", Integer, nullable=False, server_default=text("0"))
    ErrorSummary = Column("errorsummary", String(2000))
    AttemptCount = Column("attemptcount", Integer, nullable=False, server_default=text("0"))
    WorkerId = Column("workerid", String(120))
    LeaseExpiresAt = Column("leaseexpiresat", DateTime(timezone=True))
    StartedAt = Column("startedat", DateTime(timezone=True))
    CompletedAt = Column("completedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class BookQualityPageScan(Base):
    __tablename__ = "bookqualitypagescans"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'NOT_SCANNABLE', 'STALE', 'FAILED')",
            name="ck_bookqualitypagescans_status",
        ),
        CheckConstraint(
            "rulecheckstatus IN ('PENDING', 'COMPLETED', 'FAILED', 'SKIPPED')",
            name="ck_bookqualitypagescans_rule_status",
        ),
        CheckConstraint(
            "aianalysisstatus IN ('PENDING', 'COMPLETED', 'UNAVAILABLE', 'FAILED', 'SKIPPED')",
            name="ck_bookqualitypagescans_ai_status",
        ),
        CheckConstraint(
            "rejectedaifindingcount >= 0 AND attemptcount >= 0",
            name="ck_bookqualitypagescans_nonnegative_counts",
        ),
        UniqueConstraint("scanrunid", "pageid", name="uq_bookqualitypagescans_run_page"),
        Index("ix_bookqualitypagescans_run_status", "scanrunid", "status"),
        Index("ix_bookqualitypagescans_page_revision", "pageid", "pagerevisionid"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ScanRunId = Column("scanrunid", UUID(as_uuid=True), ForeignKey("bookqualityscanruns.id", ondelete="RESTRICT"), nullable=False)
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="SET NULL"))
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    PageNumberSnapshot = Column("pagenumbersnapshot", Integer, nullable=False)
    PageLifecycleSnapshot = Column("pagelifecyclesnapshot", String(20), nullable=False)
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="SET NULL"))
    ContentHash = Column("contenthash", String(128))
    VerifiedTextSnapshot = Column("verifiedtextsnapshot", Text)
    Status = Column("status", String(20), nullable=False, server_default=text("'QUEUED'"))
    RuleCheckStatus = Column("rulecheckstatus", String(16), nullable=False, server_default=text("'PENDING'"))
    AIAnalysisStatus = Column("aianalysisstatus", String(16), nullable=False, server_default=text("'PENDING'"))
    RejectedAIFindingCount = Column("rejectedaifindingcount", Integer, nullable=False, server_default=text("0"))
    AttemptCount = Column("attemptcount", Integer, nullable=False, server_default=text("0"))
    ErrorCode = Column("errorcode", String(80))
    ErrorSummary = Column("errorsummary", String(1000))
    StartedAt = Column("startedat", DateTime(timezone=True))
    CompletedAt = Column("completedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class BookQualityFinding(Base):
    __tablename__ = "bookqualityfindings"
    __table_args__ = (
        CheckConstraint(
            "detectionsource IN ('RULE', 'OLLAMA_TEXT')",
            name="ck_bookqualityfindings_source",
        ),
        CheckConstraint(
            "severity IN ('LOW', 'MEDIUM', 'HIGH')",
            name="ck_bookqualityfindings_severity",
        ),
        CheckConstraint(
            "status IN ('NEEDS_REVIEW', 'CONFIRMED', 'DISMISSED', 'RESOLVED', 'STALE')",
            name="ck_bookqualityfindings_status",
        ),
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_bookqualityfindings_confidence",
        ),
        UniqueConstraint(
            "pagescanid",
            "issuetype",
            "excerptstart",
            "excerptend",
            "detectionsource",
            name="uq_bookqualityfindings_scan_evidence",
        ),
        Index("ix_bookqualityfindings_book_status", "bookid", "status"),
        Index("ix_bookqualityfindings_page_revision", "pageid", "pagerevisionid"),
        Index("ix_bookqualityfindings_pagescan", "pagescanid"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    PageScanId = Column("pagescanid", UUID(as_uuid=True), ForeignKey("bookqualitypagescans.id", ondelete="RESTRICT"), nullable=False)
    BookId = Column("bookid", UUID(as_uuid=True), ForeignKey("books.id", ondelete="SET NULL"))
    PageId = Column("pageid", UUID(as_uuid=True), ForeignKey("bookpages.id", ondelete="SET NULL"))
    PageRevisionId = Column("pagerevisionid", UUID(as_uuid=True), ForeignKey("pagerevisions.id", ondelete="SET NULL"))
    IssueType = Column("issuetype", String(50), nullable=False)
    Severity = Column("severity", String(10), nullable=False)
    OriginalExcerpt = Column("originalexcerpt", Text, nullable=False)
    ExcerptStart = Column("excerptstart", Integer, nullable=False)
    ExcerptEnd = Column("excerptend", Integer, nullable=False)
    SuggestedCorrection = Column("suggestedcorrection", String(1200))
    Explanation = Column("explanation", String(2000), nullable=False)
    DetectionSource = Column("detectionsource", String(20), nullable=False)
    ModelName = Column("modelname", String(160))
    Confidence = Column("confidence", Float)
    Status = Column("status", String(20), nullable=False, server_default=text("'NEEDS_REVIEW'"))
    ReviewedBy = Column("reviewedby", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    ReviewNote = Column("reviewnote", String(2000))
    ReviewedAt = Column("reviewedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())


class BookQualityReportFinding(Base):
    __tablename__ = "bookqualityreportfindings"
    __table_args__ = (
        UniqueConstraint("reportid", "findingid", name="uq_bookqualityreportfindings_pair"),
        Index("ix_bookqualityreportfindings_finding", "findingid"),
    )

    ReportId = Column("reportid", UUID(as_uuid=True), ForeignKey("bookcontentreports.id", ondelete="CASCADE"), primary_key=True)
    FindingId = Column("findingid", UUID(as_uuid=True), ForeignKey("bookqualityfindings.id", ondelete="CASCADE"), primary_key=True)


class BookContentReportHistory(Base):
    __tablename__ = "bookcontentreporthistory"
    __table_args__ = (
        CheckConstraint(
            "fromstatus IS NULL OR fromstatus IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')",
            name="ck_bookcontentreporthistory_from_status",
        ),
        CheckConstraint(
            "tostatus IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')",
            name="ck_bookcontentreporthistory_to_status",
        ),
        Index("ix_bookcontentreporthistory_report_created", "reportid", "createdat"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ReportId = Column("reportid", UUID(as_uuid=True), ForeignKey("bookcontentreports.id", ondelete="RESTRICT"), nullable=False)
    ActorId = Column("actorid", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    ActorNameSnapshot = Column("actornamesnapshot", String(160))
    FromStatus = Column("fromstatus", String(20))
    ToStatus = Column("tostatus", String(20), nullable=False)
    Note = Column("note", String(2000))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
