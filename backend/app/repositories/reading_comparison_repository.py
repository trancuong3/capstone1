from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.reading_comparison_report import ReadingComparisonReport
from app.models import Book, ReadingSession
from app.repositories.book_repository import CatalogRepository


class ReadingComparisonRepository:
    """Persistence operations for per-page reading comparison reports."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def lock_session(
        self, session_id: UUID, *, actor_id: UUID | None = None
    ) -> ReadingSession | None:
        return await self.db.scalar(
            select(ReadingSession)
            .join(Book, Book.Id == ReadingSession.BookId)
            .where(
                ReadingSession.Id == session_id,
                CatalogRepository.readable_book(actor_id),
            )
            .with_for_update(of=ReadingSession).execution_options(populate_existing=True)
        )

    async def finalized_for_page(
        self, session_id: UUID, page_id: UUID, revision_id: UUID,
    ) -> ReadingComparisonReport | None:
        rows = await self.list_for_session(session_id)
        # Old reports remain untouched. Only an explicitly finalized snapshot
        # is an immutable first-pass assessment.
        for row in reversed(rows):
            if (row.PageId == page_id and row.PageRevisionId == revision_id
                    and isinstance(row.Summary, dict)
                    and row.Summary.get("assessment_version") == 1):
                return row
        return None

    async def find_exact(
        self,
        session_id: UUID,
        page_id: UUID,
        page_revision_id: UUID,
        transcript: str,
    ) -> ReadingComparisonReport | None:
        statement = (
            select(ReadingComparisonReport)
            .where(
                ReadingComparisonReport.SessionId == session_id,
                ReadingComparisonReport.PageId == page_id,
                ReadingComparisonReport.PageRevisionId == page_revision_id,
                ReadingComparisonReport.Transcript == transcript,
            )
            .order_by(
                ReadingComparisonReport.CreatedAt.desc(),
                ReadingComparisonReport.Id.desc(),
            )
            .limit(1)
        )
        return await self.db.scalar(statement)

    async def create(
        self, report: ReadingComparisonReport
    ) -> ReadingComparisonReport:
        if report.Id is None:
            report.Id = uuid4()
        if report.CreatedAt is None:
            report.CreatedAt = datetime.now(timezone.utc)
        self.db.add(report)
        try:
            await self.db.commit()
            sync_session = getattr(self.db, "sync_session", None)
            if getattr(sync_session, "expire_on_commit", True):
                await self.db.refresh(report)
        except Exception:
            await self.db.rollback()
            raise
        return report

    async def list_for_session(
        self, session_id: UUID
    ) -> list[ReadingComparisonReport]:
        statement = (
            select(ReadingComparisonReport)
            .where(ReadingComparisonReport.SessionId == session_id)
            .order_by(
                ReadingComparisonReport.CreatedAt.desc(),
                ReadingComparisonReport.Id.desc(),
            )
        )
        result = await self.db.execute(statement)
        return list(result.scalars().all())

    async def get(
        self, report_id: UUID
    ) -> ReadingComparisonReport | None:
        statement = select(ReadingComparisonReport).where(
            ReadingComparisonReport.Id == report_id
        )
        return await self.db.scalar(statement)

    async def delete(self, report: ReadingComparisonReport) -> None:
        try:
            await self.db.delete(report)
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise
