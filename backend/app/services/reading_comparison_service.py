from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException

from app.models.reading_comparison_report import ReadingComparisonReport
from app.repositories.reading_comparison_repository import ReadingComparisonRepository
from app.repositories.reading_content_repository import ReadingContentRepository
from app.schemas.reading import (
    CompareReadingRequest,
    ReadingComparisonReportRead,
    ReadingSessionReportsRead,
)
from app.services.reading_content_service import ReadingContentService
from app.services.text_alignment import align_text, summarize_alignment


class ReadingComparisonService:
    """Owns authorization, page/revision validation and report lifecycle."""

    def __init__(self, db):
        self.content = ReadingContentService(ReadingContentRepository(db))
        self.repository = ReadingComparisonRepository(db)

    @staticmethod
    def _to_read(report: ReadingComparisonReport) -> ReadingComparisonReportRead:
        return ReadingComparisonReportRead(
            report_id=report.Id,
            session_id=report.SessionId,
            page_id=report.PageId,
            page_revision_id=report.PageRevisionId,
            transcript=report.Transcript,
            distance=report.Distance,
            alignment=report.Alignment,
            summary=report.Summary,
            created_at=report.CreatedAt,
        )

    async def compare(
        self,
        session_id: UUID,
        actor_id: UUID,
        payload: CompareReadingRequest,
    ) -> ReadingComparisonReportRead:
        transcript = payload.transcript.strip()
        if not transcript:
            raise HTTPException(status_code=422, detail="Transcript must contain recognized speech.")

        if (payload.page_id is None) != (payload.page_revision_id is None):
            raise HTTPException(
                status_code=422,
                detail="page_id and page_revision_id must be supplied together.",
            )

        if payload.page_id is not None:
            page = await self.content.get_page(
                payload.page_id,
                session_id,
                actor_id,
                revision_id=payload.page_revision_id,
            )
        else:
            # Backward compatibility for callers that still compare only the
            # current page. New multi-page clients must send the exact snapshot.
            page = await self.content.get_session_page(session_id, actor_id)

        reference_text = page.text or " ".join(word.text for word in page.words)
        if not reference_text.strip():
            raise HTTPException(status_code=422, detail="Book text is empty.")

        result = align_text(reference_text, transcript)
        words = (
            [word.model_dump() for word in payload.words]
            if payload.words is not None
            else None
        )
        summary = summarize_alignment(
            result["alignment"],
            words=words,
            threshold=1.0,
        )

        # Safe retry after a lost HTTP response: return an already-persisted
        # identical comparison instead of creating a duplicate report.
        existing = await self.repository.find_exact(
            session_id,
            page.page_id,
            page.page_revision_id,
            transcript,
        )
        if existing is not None:
            return self._to_read(existing)

        report = ReadingComparisonReport(
            SessionId=session_id,
            PageId=page.page_id,
            PageRevisionId=page.page_revision_id,
            Transcript=transcript,
            Distance=result["distance"],
            Alignment=result["alignment"],
            Summary=summary,
        )
        persisted = await self.repository.create(report)
        return self._to_read(persisted)

    async def list_for_session(
        self, session_id: UUID, actor_id: UUID
    ) -> ReadingSessionReportsRead:
        await self.content.get_session_summary(session_id, actor_id)
        reports = await self.repository.list_for_session(session_id)
        return ReadingSessionReportsRead(
            session_id=session_id,
            total=len(reports),
            reports=[self._to_read(report) for report in reports],
        )

    async def delete(
        self, report_id: UUID, actor_id: UUID
    ) -> dict[str, str]:
        report = await self.repository.get(report_id)
        if report is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy báo cáo.")
        await self.content.get_session_summary(report.SessionId, actor_id)
        await self.repository.delete(report)
        return {
            "message": "Report deleted successfully",
            "report_id": str(report_id),
        }
