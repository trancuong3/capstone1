"""Persistence operations for book and page catalog endpoints.

Repository methods own SQLAlchemy queries and database writes. They return ORM
objects to services and never format HTTP responses.
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import and_, case, cast, exists, func, not_, or_, select, String
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import aggregate_order_by

from app.models import (
    AdminAiWorkflow,
    AuditLog,
    Book,
    BookPage,
    PageRevision,
    PageRevisionWord,
    Profile,
)
from app.policies.book_approval import BOOK_APPROVAL_POLICY_VERSION
from sqlalchemy.dialects.postgresql import JSONB
from app.database.role_cache import get_cached_profile_role


class BookRepository:
    """Persistence-only operations used by legacy book endpoints."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_books(self) -> list[Book]:
        result = await self.db.execute(
            select(Book).where(CatalogRepository.eligible_book())
        )
        return list(result.scalars().all())

    async def role(self, actor_id: UUID) -> str | None:
        return await get_cached_profile_role(self.db, actor_id)

    async def create(self, book: Book) -> Book:
        self.db.add(book)
        try:
            await self.db.commit()
            await self.db.refresh(book)
        except Exception:
            await self.db.rollback()
            raise
        return book

    async def list_pages(self, book_id: UUID) -> list[BookPage]:
        query = (
            select(BookPage)
            .join(Book, Book.Id == BookPage.BookId)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.BookId == book_id,
                CatalogRepository.eligible_book(),
                CatalogRepository.eligible_page(),
            )
            .order_by(BookPage.PageNumber)
        )
        result = await self.db.execute(query)
        return list(result.scalars().all())


class CatalogRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return await get_cached_profile_role(self.db, actor_id)

    @staticmethod
    def eligible_page():
        return and_(
            BookPage.LifecycleStatus == "ACTIVE",
            PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
            PageRevision.PageId == BookPage.Id,
            PageRevision.VerificationStatus == "VERIFIED",
        )

    @staticmethod
    def current_page_revision_verified():
        return exists(
            select(PageRevision.Id).where(
                PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
                PageRevision.PageId == BookPage.Id,
                PageRevision.VerificationStatus == "VERIFIED",
            ).correlate(BookPage)
        )

    @staticmethod
    def current_page_safety_approved():
        return exists(
            select(AdminAiWorkflow.Id)
            .join(
                PageRevision,
                PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
            )
            .where(
                PageRevision.PageId == BookPage.Id,
                AdminAiWorkflow.PageId == BookPage.Id,
                AdminAiWorkflow.PageRevisionId == BookPage.CurrentVerifiedRevisionId,
                AdminAiWorkflow.Status == "READY_FOR_ADMIN_REVIEW",
                AdminAiWorkflow.SafetyStatus == "CONFIRMED",
                AdminAiWorkflow.SafetyConfirmedAt.is_not(None),
                AdminAiWorkflow.SafetyConfirmedBy.is_not(None),
                AdminAiWorkflow.SafetyInputHash == AdminAiWorkflow.CandidateHash,
                AdminAiWorkflow.FinalApprovedTextHash == AdminAiWorkflow.CandidateHash,
                AdminAiWorkflow.OcrApprovedAt.is_not(None),
                AdminAiWorkflow.OcrApprovedBy.is_not(None),
                PageRevision.ProcessingMeta["admin_ai_workflow"][
                    "workflow_id"
                ].as_string() == cast(AdminAiWorkflow.Id, String),
                PageRevision.ProcessingMeta["admin_ai_workflow"][
                    "candidate_hash"
                ].as_string() == AdminAiWorkflow.CandidateHash,
                PageRevision.ProcessingMeta["admin_ai_workflow"][
                    "safety_input_hash"
                ].as_string() == AdminAiWorkflow.CandidateHash,
                # REVIEW_REQUIRED can proceed only after the existing Admin
                # Safety confirmation. NOT_RECOMMENDED and any HIGH finding
                # remain blocked with no override policy in this workflow.
                AdminAiWorkflow.Suitability.in_(
                    ("SUITABLE", "SUITABLE_WITH_GUIDANCE", "REVIEW_REQUIRED")
                ),
                not_(AdminAiWorkflow.Findings.contains([{"severity": "HIGH"}])),
            )
            .correlate(BookPage)
        )

    @classmethod
    def eligible_book(cls, *, require_active: bool = True):
        child_content_page = exists(
            select(BookPage.Id).where(
                BookPage.BookId == Book.Id,
                BookPage.LifecycleStatus.in_(("ACTIVE", "PROCESSING")),
            ).correlate(Book)
        )
        unready_page = exists(
            select(BookPage.Id).where(
                BookPage.BookId == Book.Id,
                BookPage.LifecycleStatus.in_(("ACTIVE", "PROCESSING")),
                or_(
                    BookPage.LifecycleStatus != "ACTIVE",
                    not_(cls.current_page_revision_verified()),
                    not_(cls.current_page_safety_approved()),
                ),
            ).correlate(Book)
        )
        latest_workflows = (
            select(
                AdminAiWorkflow.Id.label("workflow_id"),
                AdminAiWorkflow.PageId.label("page_id"),
                AdminAiWorkflow.CandidateHash.label("candidate_hash"),
                AdminAiWorkflow.SafetyInputHash.label("safety_input_hash"),
                AdminAiWorkflow.Suitability.label("suitability"),
                AdminAiWorkflow.Status.label("workflow_status"),
                AdminAiWorkflow.SafetyStatus.label("safety_status"),
                AdminAiWorkflow.FinalApprovedTextHash.label("final_approved_text_hash"),
                AdminAiWorkflow.SafetyConfirmedAt.label("safety_confirmed_at"),
                AdminAiWorkflow.SafetyConfirmedBy.label("safety_confirmed_by"),
                AdminAiWorkflow.OcrApprovedAt.label("ocr_approved_at"),
                AdminAiWorkflow.OcrApprovedBy.label("ocr_approved_by"),
                AdminAiWorkflow.Findings.label("findings"),
                AdminAiWorkflow.SafetyMetadata.label("safety_metadata"),
                AdminAiWorkflow.ProofreadMetadata.label("proofread_metadata"),
                func.row_number().over(
                    partition_by=AdminAiWorkflow.PageId,
                    order_by=(AdminAiWorkflow.CreatedAt.desc(), AdminAiWorkflow.Id.desc()),
                ).label("row_number"),
            )
            .subquery()
        )
        snapshot_pages = (
            select(
                BookPage.Id.label("page_id"),
                BookPage.PageNumber.label("page_number"),
                BookPage.LifecycleStatus.label("lifecycle_status"),
                PageRevision.Id.label("revision_id"),
                PageRevision.ContentHash.label("revision_content_hash"),
                PageRevision.VerificationStatus.label("revision_status"),
                PageRevision.ProcessingMeta["admin_ai_workflow"]["workflow_id"].as_string().label("revision_workflow_id"),
                PageRevision.ProcessingMeta["admin_ai_workflow"]["candidate_hash"].as_string().label("revision_candidate_hash"),
                PageRevision.ProcessingMeta["admin_ai_workflow"]["safety_input_hash"].as_string().label("revision_safety_input_hash"),
                latest_workflows.c.workflow_id,
                latest_workflows.c.candidate_hash,
                latest_workflows.c.safety_input_hash,
                latest_workflows.c.suitability,
                latest_workflows.c.workflow_status,
                latest_workflows.c.safety_status,
                latest_workflows.c.final_approved_text_hash,
                latest_workflows.c.safety_confirmed_at.is_not(None).label("safety_confirmed"),
                latest_workflows.c.safety_confirmed_by.is_not(None).label("safety_confirmed_by"),
                (
                    latest_workflows.c.ocr_approved_at.is_not(None)
                    & latest_workflows.c.ocr_approved_by.is_not(None)
                ).label("ocr_approved"),
                func.md5(
                    cast(
                        func.coalesce(latest_workflows.c.findings, func.jsonb_build_array()),
                        String,
                    )
                ).label("findings_hash"),
                func.md5(
                    cast(
                        func.coalesce(latest_workflows.c.safety_metadata, func.jsonb_build_object()),
                        String,
                    )
                ).label("safety_metadata_hash"),
                func.md5(
                    cast(
                        func.coalesce(latest_workflows.c.proofread_metadata, func.jsonb_build_object()),
                        String,
                    )
                ).label("proofread_metadata_hash"),
            )
            .select_from(BookPage)
            .outerjoin(
                PageRevision,
                (PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                & (PageRevision.PageId == BookPage.Id),
            )
            .outerjoin(
                latest_workflows,
                (latest_workflows.c.page_id == BookPage.Id)
                & (latest_workflows.c.row_number == 1),
            )
            .where(
                BookPage.BookId == Book.Id,
                BookPage.LifecycleStatus.in_(("ACTIVE", "PROCESSING")),
            )
            .correlate(Book)
            .subquery()
        )
        page_object = func.jsonb_build_object(
            "page_id", cast(snapshot_pages.c.page_id, String),
            "page_number", snapshot_pages.c.page_number,
            "lifecycle_status", snapshot_pages.c.lifecycle_status,
            "revision_id", cast(snapshot_pages.c.revision_id, String),
            "revision_content_hash", snapshot_pages.c.revision_content_hash,
            "revision_status", snapshot_pages.c.revision_status,
            "revision_workflow_id", snapshot_pages.c.revision_workflow_id,
            "revision_candidate_hash", snapshot_pages.c.revision_candidate_hash,
            "revision_safety_input_hash", snapshot_pages.c.revision_safety_input_hash,
            "workflow_id", cast(snapshot_pages.c.workflow_id, String),
            "candidate_hash", snapshot_pages.c.candidate_hash,
            "safety_input_hash", snapshot_pages.c.safety_input_hash,
            "suitability", snapshot_pages.c.suitability,
            "workflow_status", snapshot_pages.c.workflow_status,
            "safety_status", snapshot_pages.c.safety_status,
            "final_approved_text_hash", snapshot_pages.c.final_approved_text_hash,
            "safety_confirmed", snapshot_pages.c.safety_confirmed,
            "safety_confirmed_by", snapshot_pages.c.safety_confirmed_by,
            "ocr_approved", snapshot_pages.c.ocr_approved,
            "findings_hash", snapshot_pages.c.findings_hash,
            "safety_metadata_hash", snapshot_pages.c.safety_metadata_hash,
            "proofread_metadata_hash", snapshot_pages.c.proofread_metadata_hash,
        )
        current_snapshot = (
            select(
                func.coalesce(
                    func.jsonb_agg(
                        aggregate_order_by(
                            page_object,
                            snapshot_pages.c.page_number,
                            snapshot_pages.c.page_id,
                        )
                    ),
                    cast("[]", JSONB),
                )
            )
            .select_from(snapshot_pages)
            .scalar_subquery()
        )
        latest_book_decision_id = (
            select(AuditLog.Id)
            .where(
                AuditLog.ResourceType == "book",
                AuditLog.ResourceId == Book.Id,
                AuditLog.Action.like("book.children.%"),
            )
            .order_by(AuditLog.CreatedAt.desc(), AuditLog.Id.desc())
            .limit(1)
            .correlate(Book)
            .scalar_subquery()
        )
        current_book_approval = exists(
            select(AuditLog.Id).where(
                AuditLog.Id == latest_book_decision_id,
                AuditLog.Action == "book.children.approved",
                AuditLog.Metadata["policy"].as_string() == BOOK_APPROVAL_POLICY_VERSION,
                AuditLog.Metadata["page_snapshot"] == current_snapshot,
            )
        ).correlate(Book)
        criteria = [child_content_page, not_(unready_page), current_book_approval]
        if require_active:
            criteria.append(Book.LifecycleStatus == "ACTIVE")
        return and_(*criteria)

    @staticmethod
    def search_pattern(value: str) -> str:
        escaped = value.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return f"%{escaped}%"

    async def list(self, search: str | None, author: str | None, grade: int | None):
        query = select(Book).where(self.eligible_book())
        if search and search.strip():
            pattern = self.search_pattern(search)
            query = query.where(or_(Book.Name.ilike(pattern, escape="\\"), Book.Title.ilike(pattern, escape="\\"), Book.Author.ilike(pattern, escape="\\")))
        if author is not None:
            query = query.where(Book.Author == author)
        if grade is not None:
            query = query.where(Book.MinGrade <= grade, Book.MaxGrade >= grade)
        result = await self.db.execute(query.order_by(Book.Title, Book.Id))
        return result.scalars().all()

    async def get(self, book_id: UUID):
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

    async def is_eligible(self, book_id: UUID) -> bool:
        return (await self.db.scalar(select(Book.Id).where(Book.Id == book_id, self.eligible_book()))) is not None

    async def is_ready_for_children(self, book_id: UUID) -> bool:
        return (
            await self.db.scalar(
                select(Book.Id).where(
                    Book.Id == book_id,
                    self.eligible_book(require_active=False),
                )
            )
        ) is not None

    async def previews(self, book_id: UUID):
        result = await self.db.execute(
            select(BookPage)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(BookPage.BookId == book_id, self.eligible_page())
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return result.scalars().all()


class AdminCatalogRepository(CatalogRepository):
    @staticmethod
    def _latest_revision_subquery(*, book_id: UUID | None = None):
        """Return one revision per active page, preserving numeric revision order."""
        normalized_number = func.regexp_replace(PageRevision.RevisionNo, r"^0+", "")
        positive_number = and_(
            PageRevision.RevisionNo.op("~")(r"^[0-9]+$"),
            normalized_number != "",
        )
        numeric_value = case((positive_number, normalized_number), else_=None)
        query = select(
            PageRevision.Id.label("revision_id"),
            PageRevision.PageId.label("page_id"),
            PageRevision.RevisionNo.label("revision_no"),
            PageRevision.VerificationStatus.label("verification_status"),
            PageRevision.DraftText.label("draft_text"),
            PageRevision.VerifiedText.label("verified_text"),
            PageRevision.VerifiedAt.label("verified_at"),
            func.jsonb_build_object(
                "ai_proofread_audit",
                PageRevision.ProcessingMeta["ai_proofread_audit"],
            ).label("processing_meta"),
            func.row_number()
            .over(
                partition_by=PageRevision.PageId,
                order_by=(
                    case((positive_number, 1), else_=0).desc(),
                    func.length(numeric_value).desc().nullslast(),
                    numeric_value.desc().nullslast(),
                    PageRevision.CreatedAt.desc(),
                    PageRevision.Id.desc(),
                ),
            )
            .label("revision_rank"),
        ).join(BookPage, BookPage.Id == PageRevision.PageId).where(
            BookPage.LifecycleStatus == "ACTIVE"
        )
        if book_id is not None:
            query = query.where(BookPage.BookId == book_id)
        return query.subquery()

    async def max_page_number(self, book_id: UUID) -> int | None:
        """Return the maximum page number among active pages and pending reservations."""
        value = await self.db.scalar(
            select(func.max(BookPage.PageNumber)).where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus.in_(("ACTIVE", "PROCESSING")),
            )
        )
        return int(value) if value is not None else None

    async def books(self, search: str | None, lifecycle_status: str | None):
        query = select(Book)
        if search and search.strip():
            pattern = self.search_pattern(search)
            query = query.where(or_(Book.Name.ilike(pattern, escape="\\"), Book.Title.ilike(pattern, escape="\\"), Book.Author.ilike(pattern, escape="\\")))
        if lifecycle_status is not None:
            query = query.where(Book.LifecycleStatus == lifecycle_status)
        result = await self.db.execute(query.order_by(Book.Title, Book.Id))
        return result.scalars().all()

    async def catalog_rows(
        self,
        search: str | None,
        lifecycle_status: str | None,
        verification_status: str | None,
    ):
        """Fetch the admin catalog and all page-status counts in one query."""
        latest = self._latest_revision_subquery()
        page_statuses = (
            select(
                BookPage.BookId.label("book_id"),
                BookPage.Id.label("page_id"),
                latest.c.verification_status.label("verification_status"),
            )
            .outerjoin(
                latest,
                and_(latest.c.page_id == BookPage.Id, latest.c.revision_rank == 1),
            )
            .where(BookPage.LifecycleStatus == "ACTIVE")
            .subquery()
        )
        stats = (
            select(
                page_statuses.c.book_id,
                func.count(page_statuses.c.page_id).label("page_count"),
                func.count(page_statuses.c.page_id)
                .filter(page_statuses.c.verification_status == "PROCESSING")
                .label("processing_count"),
                func.count(page_statuses.c.page_id)
                .filter(page_statuses.c.verification_status == "NEEDS_REVIEW")
                .label("needs_review_count"),
                func.count(page_statuses.c.page_id)
                .filter(page_statuses.c.verification_status == "VERIFIED")
                .label("verified_count"),
                func.count(page_statuses.c.page_id)
                .filter(
                    page_statuses.c.verification_status.not_in(
                        ("PROCESSING", "NEEDS_REVIEW", "VERIFIED")
                    )
                    & page_statuses.c.verification_status.is_not(None)
                )
                .label("unknown_status_count"),
            )
            .group_by(page_statuses.c.book_id)
            .subquery()
        )
        query = (
            select(
                Book,
                func.coalesce(stats.c.page_count, 0).label("page_count"),
                func.coalesce(stats.c.processing_count, 0).label("processing_count"),
                func.coalesce(stats.c.needs_review_count, 0).label("needs_review_count"),
                func.coalesce(stats.c.verified_count, 0).label("verified_count"),
                func.coalesce(stats.c.unknown_status_count, 0).label("unknown_status_count"),
                case((self.eligible_book(), True), else_=False).label(
                    "parent_catalog_eligible"
                ),
            )
            .outerjoin(stats, stats.c.book_id == Book.Id)
        )
        if search and search.strip():
            pattern = self.search_pattern(search)
            query = query.where(
                or_(
                    Book.Name.ilike(pattern, escape="\\"),
                    Book.Title.ilike(pattern, escape="\\"),
                    Book.Author.ilike(pattern, escape="\\"),
                )
            )
        if lifecycle_status is not None:
            query = query.where(Book.LifecycleStatus == lifecycle_status)
        result = await self.db.execute(query.order_by(Book.Title, Book.Id))
        return result.all()

    async def page_list_rows(self, book_id: UUID):
        """Fetch active pages with their latest revision in one database query."""
        latest = self._latest_revision_subquery(book_id=book_id)
        result = await self.db.execute(
            select(
                BookPage,
                latest.c.revision_id,
                latest.c.revision_no,
                latest.c.verification_status,
                latest.c.draft_text,
                latest.c.verified_text,
                latest.c.verified_at,
                latest.c.processing_meta,
            )
            .outerjoin(
                latest,
                and_(latest.c.page_id == BookPage.Id, latest.c.revision_rank == 1),
            )
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return result.all()

    async def pages(self, book_id: UUID):
        result = await self.db.execute(
            select(BookPage)
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return result.scalars().all()

    async def page(self, page_id: UUID):
        return await self.db.scalar(select(BookPage).where(BookPage.Id == page_id))

    async def revisions(self, page_id: UUID):
        result = await self.db.execute(
            select(PageRevision)
            .where(PageRevision.PageId == page_id)
            .order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc())
        )
        rows = list(result.scalars().all())

        def revision_order(row: PageRevision) -> tuple[int, int]:
            value = str(row.RevisionNo)
            if value.isascii() and value.isdecimal() and int(value) > 0:
                return (1, int(value))
            return (0, -1)

        return sorted(rows, key=revision_order, reverse=True)

    async def revision(self, page_id: UUID, revision_id: UUID):
        return await self.db.scalar(select(PageRevision).where(PageRevision.Id == revision_id, PageRevision.PageId == page_id))

    async def words(self, revision_id: UUID):
        result = await self.db.execute(select(PageRevisionWord).where(PageRevisionWord.PageRevisionId == revision_id).order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id))
        return result.scalars().all()
