from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, PageRevision, PageRevisionWord, Profile


class AdminOcrRepository:
    """Persistence-only operations; the service owns authorization and business rules."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def rollback(self) -> None:
        """Roll back the current unit of work after a failed persistence operation."""
        await self.db.rollback()

    async def commit_and_refresh(self, *entities: object) -> None:
        """Commit pending changes and refresh the returned ORM entities."""
        await self.db.commit()
        for entity in entities:
            await self.db.refresh(entity)

    async def persist_book(self, book: Book) -> Book:
        """Persist a Book model; business validation remains in the service."""
        self.db.add(book)
        await self.commit_and_refresh(book)
        return book

    @staticmethod
    def _word_rows(
        revision_id: UUID,
        words: list[dict[str, object]],
    ) -> list[PageRevisionWord]:
        """Map validated OCR word data to ORM rows without applying business rules."""
        return [
            PageRevisionWord(
                PageRevisionId=revision_id,
                WordIndex=int(word["word_index"]),
                LineIndex=int(word["line_index"]),
                Text=str(word["text"]),
                NormalizedText=str(word["normalized_text"]),
                BoundingBox=list(word["bbox"]),
                OCRConfidence=word.get("ocr_confidence"),
            )
            for word in words
        ]

    async def persist_page_revision(
        self,
        page: BookPage,
        revision: PageRevision,
        words: list[dict[str, object]],
    ) -> tuple[BookPage, PageRevision]:
        """Persist a new page, its initial revision, and OCR word rows atomically."""
        self.db.add_all([page, revision, *self._word_rows(revision.Id, words)])
        await self.commit_and_refresh(page, revision)
        return page, revision

    async def persist_revision(
        self,
        revision: PageRevision,
        words: list[dict[str, object]],
        *refresh_entities: object,
    ) -> PageRevision:
        """Persist a new revision and its word rows as one database unit of work."""
        self.db.add_all([revision, *self._word_rows(revision.Id, words)])
        await self.commit_and_refresh(revision, *refresh_entities)
        return revision

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
        # revisionno is TEXT in the established schema. Sort valid numeric strings
        # numerically after retrieval so same-timestamp inserts cannot reorder history
        # lexically or by random UUID. Invalid legacy values remain visible at the end
        # and are rejected by the service contract instead of being silently rewritten.
        rows = list(result.scalars().all())

        def revision_order(row: PageRevision) -> tuple[int, int]:
            value = str(row.RevisionNo)
            if value.isascii() and value.isdecimal() and int(value) > 0:
                return (1, int(value))
            return (0, -1)

        return sorted(rows, key=revision_order, reverse=True)

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
