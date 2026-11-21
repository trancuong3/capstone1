"""Canonical Actor x Resource x State access policy for catalog and parent private books.

Every list, detail, preview, reading, history, management, and image endpoint must
use these expressions/helpers so private parent books can never leak across families,
into anonymous endpoints, into public catalog counts/searches, or past an Admin suspension.
"""
from __future__ import annotations

import os
from uuid import UUID

from sqlalchemy import String, and_, cast, exists, not_, or_, select

from app.models import (
    Book,
    BookPage,
    PageRevision,
    ParentBookPageSubmission,
    Profile,
)

VISIBILITY_CATALOG = "CATALOG"
VISIBILITY_PARENT_PRIVATE = "PARENT_PRIVATE"
MODERATION_ACTIVE = "ACTIVE"
MODERATION_SUSPENDED = "SUSPENDED"


def is_catalog_book():
    """Match shared system catalog books only (never parent private books)."""
    return Book.VisibilityScope == VISIBILITY_CATALOG


def is_private_book():
    """Match parent-owned private books only."""
    return Book.VisibilityScope == VISIBILITY_PARENT_PRIVATE


def is_private_book_owned_by(actor_id: UUID):
    """Match private books owned by `actor_id` (management scope; includes drafts/suspended)."""
    return and_(
        Book.VisibilityScope == VISIBILITY_PARENT_PRIVATE,
        Book.OwnerParentId == actor_id,
    )


def _private_page_has_incomplete_multipage_batch():
    """True when a committed page belongs to a multi-page upload batch that still has held/pending pages."""
    return exists(
        select(ParentBookPageSubmission.Id)
        .where(
            ParentBookPageSubmission.BookId == BookPage.BookId,
            ParentBookPageSubmission.BatchTotalPages > 1,
            cast(ParentBookPageSubmission.BatchId, String)
            == BookPage.ProcessingMeta["parent_submission_batch_id"].as_string(),
            ParentBookPageSubmission.WorkflowStatus.not_in(("ADDED_TO_BOOK", "CANCELLED")),
        )
        .correlate(BookPage)
    )


def is_private_page_readable():
    """Committed ACTIVE+VERIFIED page of a private book not blocked by an incomplete multi-page batch."""
    return and_(
        BookPage.LifecycleStatus == "ACTIVE",
        PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
        PageRevision.PageId == BookPage.Id,
        PageRevision.VerificationStatus == "VERIFIED",
        not_(_private_page_has_incomplete_multipage_batch()),
    )


def is_private_book_readable_by(actor_id: UUID | None, *, require_active: bool = True):
    """True only when `actor_id` is the active owner parent, book is ACTIVE & not SUSPENDED,
    and at least one verified committed page is ready (not part of an incomplete held multi-page batch).
    """
    if actor_id is None:
        return Book.Id.is_(None)  # Always false in SQL

    owner_is_active_parent = exists(
        select(Profile.Id).where(
            Profile.Id == actor_id,
            Profile.Role == "parent",
            Profile.Active == 1,
        )
    )
    has_ready_page = exists(
        select(BookPage.Id)
        .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
        .where(
            BookPage.BookId == Book.Id,
            is_private_page_readable(),
        )
        .correlate(Book)
    )
    criteria = [
        Book.VisibilityScope == VISIBILITY_PARENT_PRIVATE,
        Book.OwnerParentId == actor_id,
        Book.ModerationStatus == MODERATION_ACTIVE,
        owner_is_active_parent,
        has_ready_page,
    ]
    if require_active:
        criteria.append(Book.LifecycleStatus == "ACTIVE")
    return and_(*criteria)


def public_api_base_url(request_base_url: str | None = None) -> str:
    """Resolve base URL used when building authenticated private media proxy URLs."""
    configured = (
        os.getenv("BACKEND_PUBLIC_URL")
        or os.getenv("API_PUBLIC_URL")
        or ""
    ).strip().rstrip("/")
    if configured:
        return configured
    if request_base_url:
        return request_base_url.rstrip("/")
    return "http://127.0.0.1:8000"


def private_page_image_url(
    book_id: UUID,
    page_id: UUID,
    *,
    revision_id: UUID | None = None,
    base_url: str | None = None,
) -> str:
    root = public_api_base_url(base_url)
    suffix = f"?revision_id={revision_id}" if revision_id is not None else ""
    return f"{root}/books/my-books/{book_id}/pages/{page_id}/image{suffix}"


def private_submission_image_url(
    book_id: UUID,
    submission_id: UUID,
    *,
    base_url: str | None = None,
) -> str:
    root = public_api_base_url(base_url)
    return f"{root}/books/my-books/{book_id}/submissions/{submission_id}/image"


def admin_submission_image_url(
    submission_id: UUID,
    *,
    base_url: str | None = None,
) -> str:
    root = public_api_base_url(base_url)
    return f"{root}/books/admin/quality/user-books/submissions/{submission_id}/image"


def is_book_private(book: Book) -> bool:
    return getattr(book, "VisibilityScope", VISIBILITY_CATALOG) == VISIBILITY_PARENT_PRIVATE
