"""Persistence-only repository for Parent Private Books, staged submissions, and Admin User-Books moderation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import inspect
from typing import Any
from uuid import UUID

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.role_cache import get_cached_profile_role
from app.request_context import request_id_context
from app.models import (
    AuditLog,
    Book,
    BookPage,
    PageRevision,
    PageRevisionWord,
    ParentBookModerationRequest,
    ParentBookPageSubmission,
    Profile,
)
from app.policies.book_access import (
    VISIBILITY_PARENT_PRIVATE,
    is_private_book_owned_by,
    is_private_book_readable_by,
)


class ParentPrivateBookRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return await get_cached_profile_role(self.db, actor_id)

    async def active_profile(self, actor_id: UUID) -> Profile | None:
        return await self.db.scalar(
            select(Profile).where(Profile.Id == actor_id, Profile.Active == 1)
        )

    async def profile_display_map(self, profile_ids: list[UUID]) -> dict[UUID, str]:
        if not profile_ids:
            return {}
        result = await self.db.execute(
            select(Profile.Id, Profile.DisplayName).where(Profile.Id.in_(set(profile_ids)))
        )
        out: dict[UUID, str] = {}
        for pid, name in result.all():
            clean = (name or "").strip()
            short_id = str(pid)[:8]
            out[pid] = f"{clean} (#{short_id})" if clean else f"Phụ huynh #{short_id}"
        return out

    # ------------------------------------------------------------------
    # Private Books
    # ------------------------------------------------------------------
    async def create_private_book(self, book: Book) -> Book:
        self.db.add(book)
        await self.db.flush([book])
        return book

    async def get_owned_private_book(
        self, book_id: UUID, owner_parent_id: UUID, *, lock: bool = False
    ) -> Book | None:
        query = select(Book).where(
            Book.Id == book_id,
            is_private_book_owned_by(owner_parent_id),
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def get_private_book(self, book_id: UUID, *, lock: bool = False) -> Book | None:
        query = select(Book).where(
            Book.Id == book_id,
            Book.VisibilityScope == VISIBILITY_PARENT_PRIVATE,
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def list_owned_private_books(
        self, owner_parent_id: UUID, *, ready_only: bool = False
    ) -> list[Book]:
        cond = (
            is_private_book_readable_by(owner_parent_id)
            if ready_only
            else is_private_book_owned_by(owner_parent_id)
        )
        result = await self.db.execute(
            select(Book).where(cond).order_by(Book.CreatedAt.desc(), Book.Id.desc())
        )
        return list(result.scalars().all())

    async def list_owned_private_books_paged(
        self,
        owner_parent_id: UUID,
        *,
        ready_only: bool = False,
        search: str | None = None,
        limit: int = 9,
        offset: int = 0,
    ) -> tuple[list[Book], int]:
        cond = (
            is_private_book_readable_by(owner_parent_id)
            if ready_only
            else is_private_book_owned_by(owner_parent_id)
        )
        filters = [cond]
        if search and search.strip():
            escaped = (
                search.strip()
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            pattern = f"%{escaped}%"
            filters.append(
                or_(
                    Book.Title.ilike(pattern, escape="\\"),
                    Book.Author.ilike(pattern, escape="\\"),
                )
            )
        total = int(
            await self.db.scalar(select(func.count(Book.Id)).where(*filters)) or 0
        )
        if total == 0 or offset >= total:
            return [], total
        result = await self.db.execute(
            select(Book)
            .where(*filters)
            .order_by(Book.CreatedAt.desc(), Book.Id.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all()), total

    async def is_private_book_readable(self, book_id: UUID, owner_parent_id: UUID) -> bool:
        found = await self.db.scalar(
            select(Book.Id).where(
                Book.Id == book_id,
                is_private_book_readable_by(owner_parent_id),
            )
        )
        return found is not None

    async def list_committed_pages(
        self, book_id: UUID, *, lock: bool = False
    ) -> list[tuple[BookPage, PageRevision | None]]:
        query = (
            select(BookPage, PageRevision)
            .outerjoin(
                PageRevision,
                and_(
                    PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
                    PageRevision.PageId == BookPage.Id,
                ),
            )
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
            )
            .order_by(BookPage.PageNumber.asc(), BookPage.Id.asc())
        )
        if lock:
            query = query.with_for_update(of=BookPage).execution_options(populate_existing=True)
        result = await self.db.execute(query)
        return [(row[0], row[1]) for row in result.all()]

    async def get_committed_page(
        self, book_id: UUID, page_id: UUID, *, lock: bool = False
    ) -> tuple[BookPage, PageRevision | None] | None:
        query = (
            select(BookPage, PageRevision)
            .outerjoin(
                PageRevision,
                and_(
                    PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
                    PageRevision.PageId == BookPage.Id,
                ),
            )
            .where(
                BookPage.BookId == book_id,
                BookPage.Id == page_id,
                BookPage.LifecycleStatus == "ACTIVE",
            )
        )
        if lock:
            query = query.with_for_update(of=BookPage).execution_options(populate_existing=True)
        result = await self.db.execute(query)
        row = result.one_or_none()
        return (row[0], row[1]) if row is not None else None

    async def list_revision_words(self, revision_id: UUID) -> list[PageRevisionWord]:
        result = await self.db.execute(
            select(PageRevisionWord)
            .where(PageRevisionWord.PageRevisionId == revision_id)
            .order_by(PageRevisionWord.WordIndex.asc())
        )
        return list(result.scalars().all())

    async def get_page_revision(self, page_id: UUID, revision_id: UUID) -> PageRevision | None:
        return await self.db.scalar(
            select(PageRevision).where(
                PageRevision.Id == revision_id,
                PageRevision.PageId == page_id,
            )
        )

    async def max_page_number(self, book_id: UUID) -> int:
        value = await self.db.scalar(
            select(func.coalesce(func.max(BookPage.PageNumber), 0)).where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus.in_(("ACTIVE", "PROCESSING")),
            )
        )
        return int(value or 0)

    async def page_number_exists(self, book_id: UUID, page_number: int) -> bool:
        found = await self.db.scalar(
            select(BookPage.Id).where(
                BookPage.BookId == book_id,
                BookPage.PageNumber == page_number,
                BookPage.LifecycleStatus.in_(("ACTIVE", "PROCESSING")),
            )
        )
        return found is not None

    async def list_committed_page_texts(self, book_id: UUID) -> list[tuple[int, str]]:
        result = await self.db.execute(
            select(BookPage.PageNumber, PageRevision.VerifiedText)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
                PageRevision.VerificationStatus == "VERIFIED",
            )
            .order_by(BookPage.PageNumber.asc())
        )
        return [(int(num), str(txt or "")) for num, txt in result.all()]

    # ------------------------------------------------------------------
    # Staged Page Submissions
    # ------------------------------------------------------------------
    async def list_submissions_for_book(
        self, book_id: UUID, *, include_cancelled: bool = False, lock: bool = False
    ) -> list[ParentBookPageSubmission]:
        query = select(ParentBookPageSubmission).where(
            ParentBookPageSubmission.BookId == book_id
        )
        if not include_cancelled:
            query = query.where(ParentBookPageSubmission.WorkflowStatus != "CANCELLED")
        query = query.order_by(
            ParentBookPageSubmission.CreatedAt.desc(),
            ParentBookPageSubmission.SourcePageNumber.asc(),
            ParentBookPageSubmission.Id.asc(),
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def get_submission_by_committed_page_id(
        self, book_id: UUID, page_id: UUID, *, lock: bool = False
    ) -> ParentBookPageSubmission | None:
        query = (
            select(ParentBookPageSubmission)
            .where(
                ParentBookPageSubmission.BookId == book_id,
                ParentBookPageSubmission.CommittedPageId == page_id,
            )
            .order_by(ParentBookPageSubmission.UpdatedAt.desc())
            .limit(1)
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def list_submissions_for_books(
        self, book_ids: list[UUID]
    ) -> list[ParentBookPageSubmission]:
        if not book_ids:
            return []
        result = await self.db.execute(
            select(ParentBookPageSubmission)
            .where(
                ParentBookPageSubmission.BookId.in_(book_ids),
                ParentBookPageSubmission.WorkflowStatus != "CANCELLED",
            )
            .order_by(
                ParentBookPageSubmission.CreatedAt.desc(),
                ParentBookPageSubmission.SourcePageNumber.asc(),
            )
        )
        return list(result.scalars().all())

    async def get_submissions_by_idempotency(
        self, owner_parent_id: UUID, book_id: UUID, idempotency_key: str
    ) -> list[ParentBookPageSubmission]:
        result = await self.db.execute(
            select(ParentBookPageSubmission)
            .where(
                ParentBookPageSubmission.OwnerParentId == owner_parent_id,
                ParentBookPageSubmission.BookId == book_id,
                ParentBookPageSubmission.IdempotencyKey == idempotency_key,
            )
            .order_by(ParentBookPageSubmission.SourcePageNumber.asc())
        )
        return list(result.scalars().all())

    async def get_owned_submission(
        self,
        book_id: UUID,
        submission_id: UUID,
        owner_parent_id: UUID,
        *,
        lock: bool = False,
    ) -> ParentBookPageSubmission | None:
        query = select(ParentBookPageSubmission).where(
            ParentBookPageSubmission.Id == submission_id,
            ParentBookPageSubmission.BookId == book_id,
            ParentBookPageSubmission.OwnerParentId == owner_parent_id,
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def get_submission_book_id(self, submission_id: UUID) -> UUID | None:
        return await self.db.scalar(
            select(ParentBookPageSubmission.BookId).where(
                ParentBookPageSubmission.Id == submission_id
            )
        )

    async def get_submission(
        self, submission_id: UUID, *, lock: bool = False
    ) -> ParentBookPageSubmission | None:
        query = select(ParentBookPageSubmission).where(
            ParentBookPageSubmission.Id == submission_id
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def add_submissions(self, rows: list[ParentBookPageSubmission]) -> None:
        self.db.add_all(rows)
        await self.db.flush(rows)

    async def claim_next_checking_submission(
        self,
        worker_id: str,
        *,
        lease_seconds: int = 900,
        only_post_ocr: bool = False,
    ) -> ParentBookPageSubmission | None:
        now = datetime.now(timezone.utc)
        filters = [
            ParentBookPageSubmission.WorkflowStatus == "CHECKING",
            or_(
                ParentBookPageSubmission.RetryAfter.is_(None),
                ParentBookPageSubmission.RetryAfter <= now,
            ),
            or_(
                ParentBookPageSubmission.LeaseExpiresAt.is_(None),
                ParentBookPageSubmission.LeaseExpiresAt <= now,
            ),
        ]
        if only_post_ocr:
            filters.append(
                ParentBookPageSubmission.OcrStatus.in_(
                    ("COMPLETED", "NO_TEXT_DETECTED")
                )
            )
        row = await self.db.scalar(
            select(ParentBookPageSubmission)
            .where(*filters)
            .order_by(ParentBookPageSubmission.CreatedAt.asc(), ParentBookPageSubmission.Id.asc())
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
            .limit(1)
        )
        if row is None:
            return None
        row.WorkerId = worker_id
        row.LeaseExpiresAt = now + timedelta(seconds=lease_seconds)
        row.Attempts = int(row.Attempts or 0) + 1
        row.UpdatedAt = now
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_expired_temp_submissions(
        self, now: datetime, *, limit: int = 50
    ) -> list[ParentBookPageSubmission]:
        result = await self.db.execute(
            select(ParentBookPageSubmission)
            .where(
                ParentBookPageSubmission.CommittedPageId.is_(None),
                ParentBookPageSubmission.WorkflowStatus.not_in(("PENDING_ADMIN", "ADDED_TO_BOOK")),
                ParentBookPageSubmission.TempExpiresAt < now,
            )
            .order_by(ParentBookPageSubmission.TempExpiresAt.asc())
            .limit(limit)
        )
        return list(result.scalars().all())

    # ------------------------------------------------------------------
    # Moderation Requests & Audit
    # ------------------------------------------------------------------
    async def get_open_moderation_request(
        self, submission_id: UUID, *, lock: bool = False
    ) -> ParentBookModerationRequest | None:
        query = select(ParentBookModerationRequest).where(
            ParentBookModerationRequest.SubmissionId == submission_id,
            ParentBookModerationRequest.Status == "PENDING_ADMIN",
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def get_matching_approved_request(
        self,
        submission_id: UUID,
        submission_version: int,
        snapshot_hash: str,
    ) -> ParentBookModerationRequest | None:
        return await self.db.scalar(
            select(ParentBookModerationRequest)
            .where(
                ParentBookModerationRequest.SubmissionId == submission_id,
                ParentBookModerationRequest.SubmissionVersion == submission_version,
                ParentBookModerationRequest.SnapshotHash == snapshot_hash,
                ParentBookModerationRequest.Status == "APPROVED",
            )
            .order_by(ParentBookModerationRequest.DecidedAt.desc())
            .limit(1)
        )

    async def supersede_open_moderation_requests(
        self, submission_id: UUID, now: datetime
    ) -> None:
        await self.db.execute(
            update(ParentBookModerationRequest)
            .where(
                ParentBookModerationRequest.SubmissionId == submission_id,
                ParentBookModerationRequest.Status == "PENDING_ADMIN",
            )
            .values(
                PreviousStatus="PENDING_ADMIN",
                Status="SUPERSEDED",
                UpdatedAt=now,
            )
        )

    async def suspend_open_moderation_requests_for_book(
        self, book_id: UUID, actor_id: UUID, reason: str, now: datetime
    ) -> None:
        await self.db.execute(
            update(ParentBookModerationRequest)
            .where(
                ParentBookModerationRequest.BookId == book_id,
                ParentBookModerationRequest.Status == "PENDING_ADMIN",
            )
            .values(
                PreviousStatus="PENDING_ADMIN",
                Status="SUSPENDED",
                DecidedBy=actor_id,
                DecidedAt=now,
                DecisionReason=reason,
                OptimisticLockVersion=ParentBookModerationRequest.OptimisticLockVersion + 1,
                UpdatedAt=now,
            )
        )

    async def supersede_open_moderation_requests_for_book(
        self, book_id: UUID, now: datetime
    ) -> None:
        await self.db.execute(
            update(ParentBookModerationRequest)
            .where(
                ParentBookModerationRequest.BookId == book_id,
                ParentBookModerationRequest.Status == "PENDING_ADMIN",
            )
            .values(
                PreviousStatus="PENDING_ADMIN",
                Status="SUPERSEDED",
                UpdatedAt=now,
            )
        )

    async def list_moderation_storage_paths_for_book(self, book_id: UUID) -> set[str]:
        result = await self.db.execute(
            select(ParentBookModerationRequest.SourceStoragePath).where(
                ParentBookModerationRequest.BookId == book_id
            )
        )
        return {str(row[0]) for row in result.all() if row[0]}

    async def list_moderation_history(
        self, submission_id: UUID
    ) -> list[ParentBookModerationRequest]:
        result = await self.db.execute(
            select(ParentBookModerationRequest)
            .where(ParentBookModerationRequest.SubmissionId == submission_id)
            .order_by(
                ParentBookModerationRequest.CreatedAt.desc(),
                ParentBookModerationRequest.Id.desc(),
            )
        )
        return list(result.scalars().all())

    async def list_all_private_books_for_admin(
        self, *, search: str | None = None
    ) -> list[Book]:
        query = select(Book).where(
            Book.VisibilityScope == VISIBILITY_PARENT_PRIVATE,
            Book.LifecycleStatus == "ACTIVE",
        )
        if search and search.strip():
            escaped = (
                search.strip()
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            pattern = f"%{escaped}%"
            query = query.where(
                or_(
                    Book.Title.ilike(pattern, escape="\\"),
                    Book.Author.ilike(pattern, escape="\\"),
                )
            )
        result = await self.db.execute(
            query.order_by(Book.CreatedAt.desc(), Book.Id.desc())
        )
        return list(result.scalars().all())

    async def committed_page_counts(self, book_ids: list[UUID]) -> dict[UUID, int]:
        if not book_ids:
            return {}
        result = await self.db.execute(
            select(BookPage.BookId, func.count(BookPage.Id))
            .where(
                BookPage.BookId.in_(book_ids),
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.CurrentVerifiedRevisionId.is_not(None),
            )
            .group_by(BookPage.BookId)
        )
        return {row[0]: int(row[1]) for row in result.all()}

    async def add_moderation_request(
        self, request: ParentBookModerationRequest
    ) -> ParentBookModerationRequest:
        self.db.add(request)
        await self.db.flush([request])
        return request

    async def add_audit_log(
        self,
        *,
        actor_id: UUID | None,
        action: str,
        resource_type: str,
        resource_id: UUID,
        metadata: dict[str, Any],
    ) -> AuditLog:
        from uuid import uuid4

        entry = AuditLog(
            ActorId=actor_id,
            Action=action,
            ResourceType=resource_type,
            ResourceId=resource_id,
            Metadata=metadata,
            RequestId=request_id_context.get() or uuid4().hex,
        )
        self.db.add(entry)
        await self.db.flush([entry])
        return entry

    async def create_committed_page(
        self,
        *,
        page: BookPage,
        revision: PageRevision,
        words: list[PageRevisionWord],
    ) -> tuple[BookPage, PageRevision]:
        self.db.add(page)
        await self.db.flush([page])
        revision.PageId = page.Id
        self.db.add(revision)
        await self.db.flush([revision])
        for word in words:
            word.PageRevisionId = revision.Id
        self.db.add_all(words)
        page.CurrentVerifiedRevisionId = revision.Id
        await self.db.flush([page])
        return page, revision

    async def commit(self) -> None:
        await self.db.commit()

    async def rollback(self) -> None:
        rollback_fn = getattr(self.db, "rollback", None)
        if callable(rollback_fn):
            result = rollback_fn()
            if inspect.isawaitable(result):
                await result
