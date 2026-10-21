from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, PageRevision, PageRevisionWord, Profile


class AdminOcrRepository:
    """Persistence-only operations; the service owns authorization and business rules."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, profile_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == profile_id))

    async def book(self, book_id: UUID, *, lock: bool = False) -> Book | None:
        query = select(Book).where(Book.Id == book_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    def stage_revision_bundle(
        self,
        revision: PageRevision,
        words: list[dict[str, object]],
    ) -> None:
        """Stage a new OCR revision and its word boxes without committing."""
        self.db.add(revision)
        for word in words:
            self.db.add(
                PageRevisionWord(
                    PageRevisionId=revision.Id,
                    WordIndex=int(word["word_index"]),
                    LineIndex=int(word["line_index"]),
                    Text=str(word["text"]),
                    NormalizedText=str(word["normalized_text"]),
                    BoundingBox=list(word["bbox"]),
                    OCRConfidence=word.get("ocr_confidence"),
                )
            )

    @staticmethod
    def update_revision_draft(
        revision: PageRevision,
        *,
        draft_text: str,
        content_hash: str,
    ) -> PageRevision:
        """Apply already-validated Admin draft values to the ORM entity."""
        revision.DraftText = draft_text
        revision.ContentHash = content_hash
        return revision

    @staticmethod
    def update_revision_verification(
        revision: PageRevision,
        *,
        corrected_text: str,
        content_hash: str,
        verified_by: UUID,
        verified_at,
    ) -> PageRevision:
        """Persist verification values after the Service authorizes the transition."""
        revision.DraftText = corrected_text
        revision.VerifiedText = corrected_text
        revision.VerificationStatus = "VERIFIED"
        revision.VerifiedAt = verified_at
        revision.VerifiedBy = verified_by
        revision.ContentHash = content_hash
        return revision

    @staticmethod
    def set_current_verified_revision(
        page: BookPage,
        revision_id: UUID,
    ) -> BookPage:
        """Update the page's current verified pointer when the Service permits it."""
        page.CurrentVerifiedRevisionId = revision_id
        return page

    async def page(self, page_id: UUID, *, lock: bool = False) -> BookPage | None:
        query = select(BookPage).where(BookPage.Id == page_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    @staticmethod
    def set_page_lifecycle_status(page: BookPage, status: str) -> BookPage:
        """Change page availability without deleting revisions or reading history."""
        page.LifecycleStatus = status
        return page

    async def page_number_exists(self, book_id: UUID, page_number: int) -> bool:
        value = await self.db.scalar(
            select(BookPage.Id).where(BookPage.BookId == book_id, BookPage.PageNumber == page_number)
        )
        return value is not None

    async def next_active_page_number(self, book_id: UUID) -> int:
        """Return the next page number from ACTIVE rows only.

        Callers serialize allocation by locking the owning Book row first.
        """
        value = await self.db.scalar(
            select(func.max(BookPage.PageNumber)).where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
            )
        )
        return int(value or 0) + 1

    async def active_pages_for_renumber(
        self, book_id: UUID, *, lock: bool = False
    ) -> list[BookPage]:
        query = (
            select(BookPage)
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        if lock:
            query = query.with_for_update()
        result = await self.db.execute(query)
        return list(result.scalars().all())

    @staticmethod
    def set_page_number(page: BookPage, page_number: int) -> BookPage:
        """Persist a page's display/order number selected by the Service."""
        page.PageNumber = page_number
        return page

    @staticmethod
    def set_page_image_source(
        page: BookPage, *, image_path: str, width: int, height: int
    ) -> BookPage:
        """Update the active source image after the corresponding OCR revision is verified."""
        page.ImagePath = image_path
        page.Width = width
        page.Height = height
        return page

    def stage_page_revision_bundle(
        self,
        page: BookPage,
        revision: PageRevision,
        words: list[dict[str, object]],
    ) -> None:
        """Stage the Admin-uploaded page, initial OCR revision and word boxes.

        The Service owns the surrounding Storage/Database transaction because it
        must also clean up the uploaded Storage object if the commit fails.
        This method performs persistence staging only; it does not decide whether
        the page should be created or verified.
        """
        self.db.add_all([page, revision])
        for word in words:
            self.db.add(
                PageRevisionWord(
                    PageRevisionId=revision.Id,
                    WordIndex=int(word["word_index"]),
                    LineIndex=int(word["line_index"]),
                    Text=str(word["text"]),
                    NormalizedText=str(word["normalized_text"]),
                    BoundingBox=list(word["bbox"]),
                    OCRConfidence=word.get("ocr_confidence"),
                )
            )

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
