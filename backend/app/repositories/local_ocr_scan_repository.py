"""Persistence queries for parent-authorized local OCR page scanning.

Only reads verified, child-safety-approved catalog books and pages.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Sequence
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.role_cache import get_cached_profile_role
from app.models import Book, BookPage, ChildProfile, PageRevision, PageRevisionWord
from app.repositories.book_repository import CatalogRepository

MAX_GLOBAL_OCR_SCAN_CANDIDATES = 200
MAX_BOOK_OCR_SCAN_CANDIDATES = 500
_MAX_ANCHOR_TOKENS = 12


@dataclass(frozen=True, slots=True)
class _ScanBookRow:
    Id: UUID
    Title: str | None


@dataclass(frozen=True, slots=True)
class _ScanPageRow:
    Id: UUID
    PageNumber: int
    Width: int | None
    Height: int | None


@dataclass(frozen=True, slots=True)
class _ScanRevisionRow:
    Id: UUID
    VerifiedText: str | None
    OriginalOcrText: str | None


def _bounded_ocr_scan_limit(
    *, book_id: UUID | None, limit: int | None
) -> int:
    if book_id is not None:
        if limit is not None:
            return max(20, min(2000, int(limit)))
        return MAX_BOOK_OCR_SCAN_CANDIDATES
    if limit is not None:
        return max(20, min(1000, int(limit)))
    raw = (os.getenv("VIREAD_MAX_OCR_SCAN_CANDIDATES") or "").strip()
    if raw:
        try:
            return max(20, min(1000, int(raw)))
        except ValueError:
            pass
    return MAX_GLOBAL_OCR_SCAN_CANDIDATES


def _select_anchor_tokens(ocr_tokens: Sequence[str] | None) -> list[str]:
    if not ocr_tokens:
        return []
    seen: set[str] = set()
    cleaned: list[str] = []
    for raw in ocr_tokens:
        token = str(raw or "").strip()
        if token and token not in seen:
            seen.add(token)
            cleaned.append(token)
    if not cleaned:
        return []
    preferred = [t for t in cleaned if len(t) >= 2]
    pool = preferred if preferred else cleaned
    if len(pool) <= _MAX_ANCHOR_TOKENS:
        return pool
    # Pick longest distinctive tokens deterministically.
    ranked = sorted(enumerate(pool), key=lambda item: (-len(item[1]), item[0]))
    return [tok for _idx, tok in ranked[:_MAX_ANCHOR_TOKENS]]


def _escape_like_pattern(token: str) -> str:
    escaped = token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class LocalOcrScanRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def profile_role(self, actor_id: UUID) -> str | None:
        return await get_cached_profile_role(self.db, actor_id)

    async def child_belongs_to_parent(self, child_id: UUID, actor_id: UUID) -> bool:
        found = await self.db.scalar(
            select(ChildProfile.Id).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == actor_id,
            )
        )
        return found is not None

    async def eligible_verified_pages(
        self,
        book_id: UUID | None = None,
        *,
        ocr_tokens: Sequence[str] | None = None,
        limit: int | None = None,
    ) -> list[tuple[_ScanBookRow, _ScanPageRow, _ScanRevisionRow]]:
        effective_limit = _bounded_ocr_scan_limit(book_id=book_id, limit=limit)
        query = (
            select(
                Book.Id,
                Book.Title,
                BookPage.Id,
                BookPage.PageNumber,
                BookPage.Width,
                BookPage.Height,
                PageRevision.Id,
                PageRevision.VerifiedText,
                PageRevision.OriginalOcrText,
            )
            .join(BookPage, BookPage.BookId == Book.Id)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                CatalogRepository.eligible_book(),
                CatalogRepository.eligible_page(),
            )
            .order_by(Book.Id, BookPage.PageNumber)
        )
        if book_id is not None:
            query = query.where(Book.Id == book_id)
        else:
            anchors = _select_anchor_tokens(ocr_tokens)
            if anchors:
                text_expr = func.coalesce(
                    PageRevision.VerifiedText,
                    PageRevision.OriginalOcrText,
                    "",
                )
                query = query.where(
                    or_(
                        *(
                            text_expr.ilike(_escape_like_pattern(tok), escape="\\")
                            for tok in anchors
                        )
                    )
                )
        query = query.limit(effective_limit)
        result = await self.db.execute(query)
        rows: list[tuple[_ScanBookRow, _ScanPageRow, _ScanRevisionRow]] = []
        for row in result.all():
            if len(row) == 3:
                rows.append(row)  # type: ignore[arg-type]
            else:
                rows.append(
                    (
                        _ScanBookRow(Id=row[0], Title=row[1]),
                        _ScanPageRow(
                            Id=row[2],
                            PageNumber=row[3],
                            Width=row[4],
                            Height=row[5],
                        ),
                        _ScanRevisionRow(
                            Id=row[6],
                            VerifiedText=row[7],
                            OriginalOcrText=row[8],
                        ),
                    )
                )
        return rows

    async def revision_words(self, revision_id: UUID) -> list[PageRevisionWord]:
        result = await self.db.execute(
            select(PageRevisionWord)
            .where(PageRevisionWord.PageRevisionId == revision_id)
            .order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id)
        )
        return list(result.scalars().all())
