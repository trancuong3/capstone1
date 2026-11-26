"""Canonical Actor x Resource x State access policy for catalog and parent private books.

Every list, detail, preview, reading, history, management, and image endpoint must
use these expressions/helpers so private parent books can never leak across families,
into anonymous endpoints, into public catalog counts/searches, or past an Admin suspension.
"""
from __future__ import annotations

import logging
import os
from uuid import UUID

from sqlalchemy import String, and_, cast, exists, not_, or_, select

from app.database.config import APP_ENVIRONMENT, SUPABASE_PRIVATE_BOOKS_BUCKET
from app.diagnostic_logging import log_diagnostic
from app.models import (
    Book,
    BookPage,
    PageRevision,
    ParentBookPageSubmission,
    Profile,
)
from app.services.storage_service import (
    create_signed_image_url,
    is_local_storage_enabled,
)

logger = logging.getLogger(__name__)
_ORIGINAL_CREATE_SIGNED_IMAGE_URL = create_signed_image_url
PRIVATE_SIGNED_URL_TTL_SECONDS = 300

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


def is_private_book_owned_by(actor_id: UUID, *, include_retired: bool = False):
    """Match private books owned by `actor_id` (management scope; includes drafts/suspended, excludes deleted/RETIRED by default)."""
    criteria = [
        Book.VisibilityScope == VISIBILITY_PARENT_PRIVATE,
        Book.OwnerParentId == actor_id,
    ]
    if not include_retired:
        criteria.append(Book.LifecycleStatus == "ACTIVE")
    return and_(*criteria)


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


def is_private_storage_path_owned_by(
    storage_path: str | None,
    owner_id: UUID,
    *,
    book_id: UUID | None = None,
) -> bool:
    """Verify a private Storage object path sits strictly inside the owner/book namespace."""
    if not isinstance(storage_path, str):
        return False
    cleaned = storage_path.strip()
    if (
        not cleaned
        or cleaned.startswith(("/", "\\", "http://", "https://"))
        or "\\" in cleaned
        or ".." in cleaned.split("/")
    ):
        return False
    expected_prefix = (
        f"private-books/{owner_id}/{book_id}/"
        if book_id is not None
        else f"private-books/{owner_id}/"
    )
    return cleaned.startswith(expected_prefix)


def _try_proxyless_private_signed_url(
    storage_path: str | None,
    *,
    owner_id: UUID | None = None,
    book_id: UUID | None = None,
    ttl_seconds: int = PRIVATE_SIGNED_URL_TTL_SECONDS,
) -> str | None:
    """Create a short-lived owner-scoped Supabase Storage URL when proxyless serving is active."""
    if not isinstance(storage_path, str) or not storage_path.strip():
        return None
    if is_local_storage_enabled():
        return None
    if owner_id is not None and not is_private_storage_path_owned_by(
        storage_path, owner_id, book_id=book_id
    ):
        log_diagnostic(
            logger,
            logging.WARNING,
            event="private_storage_path_scope_mismatch",
            stage="book_access",
        )
        return None
    force_proxyless = (
        (os.getenv("VIREAD_PROXYLESS_PRIVATE_URLS") or "").strip().lower()
        in {"1", "true", "yes", "on"}
    )
    if (
        APP_ENVIRONMENT == "test"
        and (os.getenv("SUPABASE_KEY") or "").strip() == "isolated-test-key"
        and create_signed_image_url is _ORIGINAL_CREATE_SIGNED_IMAGE_URL
        and not force_proxyless
    ):
        return None
    try:
        return create_signed_image_url(
            storage_path.strip(),
            bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
            ttl_seconds=ttl_seconds,
        )
    except Exception as exc:
        log_diagnostic(
            logger,
            logging.WARNING,
            event="private_signed_url_fallback_to_proxy",
            stage="book_access",
            exception=exc,
        )
        return None


def private_page_image_url(
    book_id: UUID,
    page_id: UUID,
    *,
    revision_id: UUID | None = None,
    base_url: str | None = None,
    storage_path: str | None = None,
    owner_id: UUID | None = None,
) -> str:
    signed_url = _try_proxyless_private_signed_url(
        storage_path,
        owner_id=owner_id,
        book_id=book_id,
    )
    if signed_url:
        return signed_url
    root = public_api_base_url(base_url)
    suffix = f"?revision_id={revision_id}" if revision_id is not None else ""
    return f"{root}/books/my-books/{book_id}/pages/{page_id}/image{suffix}"


def private_submission_image_url(
    book_id: UUID,
    submission_id: UUID,
    *,
    base_url: str | None = None,
    storage_path: str | None = None,
    owner_id: UUID | None = None,
) -> str:
    signed_url = _try_proxyless_private_signed_url(
        storage_path,
        owner_id=owner_id,
        book_id=book_id,
    )
    if signed_url:
        return signed_url
    root = public_api_base_url(base_url)
    return f"{root}/books/my-books/{book_id}/submissions/{submission_id}/image"


def admin_submission_image_url(
    submission_id: UUID,
    *,
    base_url: str | None = None,
    storage_path: str | None = None,
) -> str:
    signed_url = _try_proxyless_private_signed_url(storage_path)
    if signed_url:
        return signed_url
    root = public_api_base_url(base_url)
    return f"{root}/books/admin/quality/user-books/submissions/{submission_id}/image"


def admin_flow2_candidate_crop_url(
    candidate_id: UUID,
    *,
    base_url: str | None = None,
) -> str:
    root = public_api_base_url(base_url)
    return f"{root}/books/admin/quality/user-books/flow2-candidates/{candidate_id}/crop"


def is_book_private(book: Book) -> bool:
    return getattr(book, "VisibilityScope", VISIBILITY_CATALOG) == VISIBILITY_PARENT_PRIVATE
