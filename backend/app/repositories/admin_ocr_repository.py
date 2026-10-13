from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, PageRevision, PageRevisionWord, Profile


class AdminOcrRepository:
    """Persistence-only operations; the service owns authorization and business rules."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, profile_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == profile_id))

    async def book(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

    async def page(self, page_id: UUID, *, lock: bool = False) -> BookPage | None:
        query = select(BookPage).where(BookPage.Id == page_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def page_number_exists(self, book_id: UUID, page_number: int) -> bool:
        value = await self.db.scalar(
            select(BookPage.Id).where(BookPage.BookId == book_id, BookPage.PageNumber == page_number)
        )
        return value is not None

    async def revisions(self, page_id: UUID) -> list[PageRevision]:
        result = await self.db.execute(
            select(PageRevision)
            .where(PageRevision.PageId == page_id)
            .order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc())
        )
        return list(result.scalars().all())

    async def revision(self, page_id: UUID, revision_id: UUID, *, lock: bool = False) -> PageRevision | None:
        query = select(PageRevision).where(
            PageRevision.Id == revision_id,
            PageRevision.PageId == page_id,
        )
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def next_revision_number(self, page_id: UUID) -> int:
        rows = await self.db.execute(select(PageRevision.RevisionNo).where(PageRevision.PageId == page_id))
        numbers: list[int] = []
        for raw in rows.scalars().all():
            value = str(raw)
            if not value.isascii() or not value.isdecimal() or int(value) < 1:
                raise ValueError("Existing revision number is not a positive numeric string")
            numbers.append(int(value))
        return max(numbers, default=0) + 1

    async def words(self, revision_id: UUID) -> list[PageRevisionWord]:
        result = await self.db.execute(
            select(PageRevisionWord)
            .where(PageRevisionWord.PageRevisionId == revision_id)
            .order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id)
        )
        return list(result.scalars().all())

    async def sync_words(self, revision_id: UUID, words: list[dict[str, object]]) -> None:
        existing = await self.words(revision_id)
        by_index = {row.WordIndex: row for row in existing}
        keep = {int(word["word_index"]) for word in words}
        for row in existing:
            if row.WordIndex not in keep:
                await self.db.delete(row)
        for word in words:
            index = int(word["word_index"])
            row = by_index.get(index)
            if row is None:
                row = PageRevisionWord(PageRevisionId=revision_id, WordIndex=index, LineIndex=int(word["line_index"]),
                    Text=str(word["text"]), NormalizedText=str(word["normalized_text"]),
                    BoundingBox=list(word["bbox"]), OCRConfidence=word.get("ocr_confidence"))
                self.db.add(row)
            else:
                row.LineIndex = int(word["line_index"])
                row.Text = str(word["text"])
                row.NormalizedText = str(word["normalized_text"])
                row.BoundingBox = list(word["bbox"])
                row.OCRConfidence = word.get("ocr_confidence")
