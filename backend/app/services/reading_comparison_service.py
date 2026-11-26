from __future__ import annotations

import asyncio
import inspect
import unicodedata
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

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

    def __init__(self, db: AsyncSession):
        self.db = db
        self.content = ReadingContentService(ReadingContentRepository(db))
        self.repository = ReadingComparisonRepository(db)

    async def _release_read_transaction(self) -> None:
        db = getattr(self, "db", None) or getattr(self.repository, "db", None)
        rollback = getattr(db, "rollback", None)
        if callable(rollback):
            res = rollback()
            if inspect.isawaitable(res):
                await res

    @staticmethod
    def _to_read(
        report: ReadingComparisonReport,
        self_corrected_word_ids: list[UUID] | None = None,
    ) -> ReadingComparisonReportRead:
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
            self_corrected_word_ids=self_corrected_word_ids or [],
        )

    async def compare(
        self,
        session_id: UUID,
        actor_id: UUID,
        payload: CompareReadingRequest,
    ) -> ReadingComparisonReportRead:
        transcript = unicodedata.normalize("NFC", payload.transcript).strip()
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

        reference_text = unicodedata.normalize(
            "NFC", page.text or " ".join(word.text for word in page.words)
        )
        if not reference_text.strip():
            raise HTTPException(status_code=422, detail="Book text is empty.")

        initial_assessment = None
        if payload.finalize:
            if not page.words:
                raise HTTPException(status_code=422, detail="A final assessment requires page words")
            if payload.initial_assessment is None:
                raise HTTPException(status_code=422, detail="A final assessment requires word evidence")
            supplied = {str(item.word_id): item.status for item in payload.initial_assessment}
            word_ids = {str(word.word_id) for word in page.words}
            if len(supplied) != len(payload.initial_assessment) or set(supplied) != word_ids:
                raise HTTPException(status_code=422, detail="Assessment words must match the page revision exactly")
            initial_assessment = [
                {
                    "word_id": str(word.word_id),
                    "word_index": word.word_index,
                    "text": unicodedata.normalize("NFC", str(word.text)),
                    "status": supplied[str(word.word_id)],
                }
                for word in page.words
            ]
        elif payload.initial_assessment is not None:
            raise HTTPException(status_code=422, detail="Word evidence requires a final assessment")

        # Release the read transaction before offloading CPU-heavy DP alignment
        # so no DB connection permit or row lock is held during alignment.
        await self._release_read_transaction()
        result = await asyncio.to_thread(align_text, reference_text, transcript)
        words = (
            [
                {
                    **word.model_dump(),
                    "text": unicodedata.normalize("NFC", str(word.text)),
                }
                for word in payload.words
            ]
            if payload.words is not None
            else None
        )
        summary = await asyncio.to_thread(
            summarize_alignment,
            result["alignment"],
            words=words,
            threshold=1.0,
        )
        if payload.finalize:
            summary = {**summary, "assessment_version": 1,
                       "initial_assessment": initial_assessment}

        session = await self.repository.lock_session(session_id, actor_id=actor_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")

        finalized = await self.repository.finalized_for_page(
            session_id, page.page_id, page.page_revision_id,
        )
        if finalized is not None:
            finalized_transcript_nfc = unicodedata.normalize(
                "NFC", str(finalized.Transcript or "")
            ).strip()
            existing_initial = (
                finalized.Summary.get("initial_assessment")
                if isinstance(finalized.Summary, dict)
                else None
            )
            if isinstance(existing_initial, list):
                existing_initial_nfc = [
                    (
                        {**item, "text": unicodedata.normalize("NFC", str(item["text"]))}
                        if isinstance(item, dict) and isinstance(item.get("text"), str)
                        else item
                    )
                    for item in existing_initial
                ]
            else:
                existing_initial_nfc = existing_initial
            if (
                finalized_transcript_nfc != transcript
                or (payload.finalize and existing_initial_nfc != initial_assessment)
            ):
                raise HTTPException(status_code=409, detail="The initial assessment is immutable")
            return self._to_read(finalized)
        if session.State in {"COMPLETED", "FINISHED", "ABORTED"}:
            raise HTTPException(status_code=409, detail="Cannot assess a finished session")
        if payload.finalize and any(
            row.PageId == page.page_id and row.PageRevisionId == page.page_revision_id
            for row in await self.repository.list_for_session(session_id)
        ):
            raise HTTPException(status_code=409, detail="A legacy comparison cannot be replaced with a new initial assessment")

        # Safe retry after a lost HTTP response: return an already-persisted
        # identical comparison instead of creating a duplicate report.
        existing = await self.repository.find_exact(
            session_id,
            page.page_id,
            page.page_revision_id,
            transcript,
        )
        if existing is not None and not payload.finalize:
            return self._to_read(existing)
        if existing is None and not payload.finalize:
            for row in await self.repository.list_for_session(session_id):
                if (
                    row.PageId == page.page_id
                    and row.PageRevisionId == page.page_revision_id
                    and unicodedata.normalize("NFC", str(row.Transcript or "")).strip() == transcript
                ):
                    return self._to_read(row)

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
        events = await self.content.repository.events_for_session(session_id)
        from app.services.reading_assessment import aggregate_assessment
        assessment = aggregate_assessment(
            session_id, reports, events,
        )["assessment"]
        corrected_by_page: dict[tuple[UUID, UUID], set[UUID]] = {}
        for event in events:
            if (
                event.Type == "WORD_RETRY"
                and event.Status == "CONFIRMED"
                and event.WordId is not None
            ):
                key = (event.PageId, event.PageRevisionId)
                corrected_by_page.setdefault(key, set()).add(event.WordId)
        return ReadingSessionReportsRead(
            assessment=assessment,
            session_id=session_id,
            total=len(reports),
            reports=[
                self._to_read(
                    report,
                    sorted(
                        corrected_by_page.get((report.PageId, report.PageRevisionId), set()),
                        key=str,
                    ),
                )
                for report in reports
            ],
        )

    async def delete(
        self, report_id: UUID, actor_id: UUID
    ) -> dict[str, str]:
        report = await self.repository.get(report_id)
        if report is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy báo cáo.")
        await self.content.get_session_summary(report.SessionId, actor_id)
        if isinstance(report.Summary, dict) and report.Summary.get("assessment_version") == 1:
            raise HTTPException(status_code=409, detail="The initial assessment is immutable")
        await self.repository.delete(report)
        return {
            "message": "Report deleted successfully",
            "report_id": str(report_id),
        }
