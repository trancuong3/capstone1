import asyncio
from dataclasses import dataclass
import inspect
from io import BytesIO
import logging
import math

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import and_, or_, select
from typing import List
from uuid import UUID

from PIL import Image, UnidentifiedImageError

from app.api.deps import get_current_parent_id, get_db
from app.models import (
    Book,
    BookPage,
    PageRevision,
    ReadingSession,
    ReadingEvent,
    FluencyAssessment,
    ReadingSessionPage,
)
from app.schemas import (
    ReadingSessionResponse, ReadingSessionCreate,
    ReadingEventResponse, ReadingEventCreate,
    FluencyAssessmentResponse, FluencyAssessmentCreate
)
from app.schemas.reading import (
    CompareReadingRequest,
    ReadingComparisonReportRead,
    ReadingSessionReportsRead,
    ReadingPracticeStateRead,
)
from datetime import datetime, timezone
from app.repositories.reading_content_repository import ReadingContentRepository
from app.repositories.reading_presence_repository import ReadingPresenceRepository
from app.repositories.book_repository import CatalogRepository
from app.services.reading_content_service import ReadingContentService
from app.services.reading_comparison_service import ReadingComparisonService
from app.services.reading_presence_service import ReadingPresenceService
from app.services.local_ocr_scan_service import MAX_SCAN_IMAGE_BYTES
from app.services.rate_limiter import rate_limit
from app.schemas.reading import (
    ReadingPageDTO, ReadingCompletionSummaryDTO,
    SessionSummaryRead, ReadingPageNavigationCreate,
    ReadingSessionPageProgressDTO,
)

logger = logging.getLogger(__name__)

router = APIRouter()


async def _release_db(db: AsyncSession | None) -> None:
    """End an open read transaction so no DB permit is held during slow I/O or CPU work."""
    rollback = getattr(db, "rollback", None)
    if callable(rollback):
        res = rollback()
        if inspect.isawaitable(res):
            await res


@dataclass(frozen=True, slots=True)
class _CameraCandidatePage:
    Id: UUID
    BookId: UUID
    PageNumber: int
    ImagePath: str | None
    CurrentVerifiedRevisionId: UUID | None
    Width: int | None
    Height: int | None


@dataclass(frozen=True, slots=True)
class _CameraCandidateBook:
    VisibilityScope: str | None


def _snapshot_camera_candidates(rows) -> list[tuple[_CameraCandidatePage, _CameraCandidateBook]]:
    """Snapshot ORM scalars before db.rollback() so Storage/OpenCV never hits expired attributes."""
    snapshots: list[tuple[_CameraCandidatePage, _CameraCandidateBook]] = []
    for page_orm, book_row in rows:
        snapshots.append(
            (
                _CameraCandidatePage(
                    Id=page_orm.Id,
                    BookId=page_orm.BookId,
                    PageNumber=page_orm.PageNumber,
                    ImagePath=page_orm.ImagePath,
                    CurrentVerifiedRevisionId=page_orm.CurrentVerifiedRevisionId,
                    Width=getattr(page_orm, "Width", None),
                    Height=getattr(page_orm, "Height", None),
                ),
                _CameraCandidateBook(
                    VisibilityScope=getattr(book_row, "VisibilityScope", "CATALOG"),
                ),
            )
        )
    return snapshots

@router.get("/sessions", response_model=List[ReadingSessionResponse])
async def get_sessions(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).list_sessions(actor_id)

@router.post("/sessions", response_model=ReadingSessionResponse)
async def create_session(
    session_in: ReadingSessionCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Create a session referencing an existing page verified by Admin."""
    return await ReadingContentService(ReadingContentRepository(db)).create_session(
        actor_id, session_in
    )


@router.get("/sessions/{session_id}", response_model=SessionSummaryRead)
async def get_session(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).get_session_summary(
        session_id, actor_id
    )


@router.get("/sessions/{session_id}/page", response_model=ReadingPageDTO)
async def get_session_current_page(
    session_id: UUID,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store, max-age=0"
    response.headers["Vary"] = "Authorization"
    return await ReadingContentService(ReadingContentRepository(db)).get_session_page(
        session_id, actor_id, base_url=str(request.base_url)
    )


@router.get(
    "/sessions/{session_id}/progress",
    response_model=ReadingSessionPageProgressDTO,
)
async def get_session_page_progress(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).get_session_progress(
        session_id, actor_id
    )


@router.post(
    "/sessions/{session_id}/pages/{page_id}/complete",
    response_model=ReadingSessionPageProgressDTO,
)
async def complete_session_page(
    session_id: UUID,
    page_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).complete_session_page(
        session_id, page_id, actor_id
    )


@router.post(
    "/sessions/{session_id}/navigate",
    response_model=ReadingSessionPageProgressDTO,
)
async def navigate_session_page(
    session_id: UUID,
    navigation_in: ReadingPageNavigationCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).navigate_session_page(
        session_id, actor_id, navigation_in
    )


@router.get("/pages/{page_id}", response_model=ReadingPageDTO)
async def get_reading_page(
    page_id: UUID,
    request: Request,
    response: Response,
    session_id: UUID = Query(...),
    revision_id: UUID | None = Query(None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store, max-age=0"
    response.headers["Vary"] = "Authorization"
    return await ReadingContentService(ReadingContentRepository(db)).get_page(
        page_id, session_id, actor_id, revision_id=revision_id, base_url=str(request.base_url)
    )


@router.post("/sessions/{session_id}/finish", response_model=SessionSummaryRead)
async def finish_session(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    summary = await ReadingContentService(ReadingContentRepository(db)).finish_session(
        session_id, actor_id
    )
    try:
        await ReadingPresenceService(
            ReadingPresenceRepository(db)
        ).cancel_for_session(session_id, reason="SESSION_ENDED")
    except Exception as exc:
        logger.warning(
            "reading_presence_cancel_on_finish_failed: %s", type(exc).__name__
        )
        try:
            await _release_db(db)
        except Exception:
            pass
    return summary


@router.get("/sessions/{session_id}/completion-summary", response_model=ReadingCompletionSummaryDTO)
async def get_session_completion_summary(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).get_completion_summary(
        session_id, actor_id
    )

@router.post("/events", response_model=ReadingEventResponse)
async def create_reading_event(
    event_in: ReadingEventCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).create_reading_event(
        actor_id, event_in
    )


@router.get("/sessions/{session_id}/practice-state", response_model=ReadingPracticeStateRead)
async def get_reading_practice_state(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingContentService(ReadingContentRepository(db)).get_practice_state(session_id, actor_id)

@router.post("/fluency", response_model=FluencyAssessmentResponse)
async def create_fluency_assessment(
    assessment_in: FluencyAssessmentCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    if assessment_in.Score is not None and not math.isfinite(assessment_in.Score):
        raise HTTPException(status_code=422, detail="Score must be a finite number")
    if assessment_in.Uncertainty is not None and not math.isfinite(assessment_in.Uncertainty):
        raise HTTPException(status_code=422, detail="Uncertainty must be a finite number")
    return await ReadingContentService(ReadingContentRepository(db)).create_fluency_assessment(
        actor_id, assessment_in
    )


import re
from math import isfinite
from pydantic import ValidationError
from app.models import ChildProfile, Profile, ComprehensionQuestion, ComprehensionAnswer
from app.schemas.book import CatalogBookResponse
from app.schemas.reading import (
    HistorySessionSummaryRead, SessionHistoryRead, SessionDetailRead, HistoryEventRead,
    HistoryFluencyRead, HistoryFluencyMetricsRead, HistoryComprehensionRead, HistoryQuestionRead,
    HistoryAnswerRead, SessionSourceSpanRead,
)


class HistoryRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def comparison_reports(self, session_id: UUID):
        from app.repositories.reading_comparison_repository import ReadingComparisonRepository
        return await ReadingComparisonRepository(self.db).list_for_session(session_id)

    async def role(self, actor_id: UUID):
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id, Profile.Active == 1))

    async def owned_child(self, child_id: UUID, actor_id: UUID):
        return await self.db.scalar(select(ChildProfile.Id).where(ChildProfile.Id == child_id, ChildProfile.ParentId == actor_id))

    async def sessions(self, child_id: UUID, actor_id: UUID, offset: int, limit: int):
        result = await self.db.execute(
            select(ReadingSession).join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
            .where(ReadingSession.ChildId == child_id, ChildProfile.ParentId == actor_id)
            .order_by(ReadingSession.StartedAt.desc(), ReadingSession.Id.desc())
            .offset(offset).limit(limit + 1)
        )
        return result.scalars().all()

    async def session(self, session_id: UUID, actor_id: UUID):
        return await self.db.scalar(
            select(ReadingSession).join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
            .where(ReadingSession.Id == session_id, ChildProfile.ParentId == actor_id)
        )

    async def session_book(self, session_id: UUID, actor_id: UUID):
        # Historical metadata must not depend on current catalog eligibility,
        # but private books must always belong to the authenticated parent.
        return await self.db.scalar(
            select(Book).join(ReadingSession, ReadingSession.BookId == Book.Id)
            .join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
            .where(
                ReadingSession.Id == session_id,
                ChildProfile.ParentId == actor_id,
                or_(
                    Book.VisibilityScope == "CATALOG",
                    and_(
                        Book.VisibilityScope == "PARENT_PRIVATE",
                        Book.OwnerParentId == actor_id,
                    ),
                ),
            )
        )

    async def events(self, session_id: UUID):
        result = await self.db.execute(select(ReadingEvent).where(ReadingEvent.SessionId == session_id).order_by(ReadingEvent.StartMs, ReadingEvent.Id))
        return result.scalars().all()

    async def fluency(self, session_id: UUID):
        return await self.db.scalar(select(FluencyAssessment).where(FluencyAssessment.SessionId == session_id).order_by(FluencyAssessment.CreatedAt.desc(), FluencyAssessment.Id.desc()).limit(1))

    async def session_page_rows(self, session_id: UUID):
        result = await self.db.execute(
            select(ReadingSessionPage)
            .where(ReadingSessionPage.SessionId == session_id)
            .order_by(ReadingSessionPage.PageOrder, ReadingSessionPage.Id)
        )
        return result.scalars().all()

    async def questions(self, session_id: UUID):
        result = await self.db.execute(select(ComprehensionQuestion).where(ComprehensionQuestion.SessionId == session_id).order_by(ComprehensionQuestion.CreatedAt, ComprehensionQuestion.Id))
        return result.scalars().all()

    async def answer(self, question_id: UUID):
        return await self.db.scalar(select(ComprehensionAnswer).where(ComprehensionAnswer.QuestionId == question_id).order_by(ComprehensionAnswer.CreatedAt.desc(), ComprehensionAnswer.Id.desc()).limit(1))

    async def answers_for_questions(self, question_ids: list[UUID]) -> dict[UUID, ComprehensionAnswer]:
        """Batch-load the newest comprehension answer for each question ID."""
        if not question_ids:
            return {}
        result = await self.db.execute(
            select(ComprehensionAnswer)
            .where(ComprehensionAnswer.QuestionId.in_(question_ids))
            .order_by(
                ComprehensionAnswer.QuestionId,
                ComprehensionAnswer.CreatedAt.desc(),
                ComprehensionAnswer.Id.desc(),
            )
        )
        answers: dict[UUID, ComprehensionAnswer] = {}
        for row in result.scalars().all():
            answers.setdefault(row.QuestionId, row)
        return answers


class HistoryService:
    def __init__(self, repository: HistoryRepository):
        self.repository = repository

    async def require_parent(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "parent":
            raise HTTPException(status_code=403, detail="Access denied")

    async def require_child(self, child_id: UUID, actor_id: UUID):
        await self.require_parent(actor_id)
        if await self.repository.owned_child(child_id, actor_id) is None:
            raise HTTPException(status_code=404, detail="Resource not found")

    @staticmethod
    def summary(row):
        duration = None
        try:
            if row.EndedAt is not None:
                duration = int((row.EndedAt - row.StartedAt).total_seconds() * 1000)
            return HistorySessionSummaryRead(
                id=row.Id, child_id=row.ChildId, book_id=row.BookId,
                state="FINISHED" if row.State == "COMPLETED" else row.State,
                started_at=row.StartedAt, ended_at=row.EndedAt, duration_ms=duration,
            )
        except (ValidationError, TypeError, ValueError):
            # Unknown states and invalid timelines must never be guessed.
            raise HTTPException(status_code=501, detail="Session contract is not available yet") from None

    @staticmethod
    def safe_event_metadata(event) -> dict[str, object]:
        """Expose only the retry fields needed by a parent-facing history view."""
        if event.Type != "WORD_RETRY" or not isinstance(event.Metadata, dict):
            return {}

        source = event.Metadata
        result: dict[str, object] = {}
        attempt = source.get("retry_attempt")
        if type(attempt) is int and 1 <= attempt <= 10000:
            result["retry_attempt"] = attempt

        incorrect_count = source.get("incorrect_retry_count")
        if type(incorrect_count) is int and 0 <= incorrect_count <= 3:
            result["incorrect_retry_count"] = incorrect_count

        resolution_status = source.get("resolution_status")
        if isinstance(resolution_status, str) and resolution_status in (
            "RETRYING", "SELF_CORRECTED", "UNRESOLVED",
        ):
            result["resolution_status"] = resolution_status

        original_status = source.get("original_status")
        if isinstance(original_status, str) and original_status in (
            "OMISSION",
            "MISPRONUNCIATION",
        ):
            result["original_status"] = original_status

        target_word = source.get("target_word")
        if isinstance(target_word, str) and target_word.strip():
            result["target_word"] = target_word.strip()[:100]

        recognized_text = source.get("recognized_text")
        if isinstance(recognized_text, str) and recognized_text.strip():
            result["recognized_text"] = recognized_text.strip()[:200]
        if source.get("skip_reason") == "TECHNICAL_OR_MANUAL":
            result["skip_reason"] = "TECHNICAL_OR_MANUAL"

        return result

    async def list(self, child_id: UUID, actor_id: UUID, cursor: str | None, limit: int):
        await self.require_child(child_id, actor_id)
        page = 1
        if cursor is not None:
            match = re.fullmatch(r"page-([1-9][0-9]{0,5})", cursor)
            if match is None:
                raise HTTPException(status_code=422, detail="Invalid cursor")
            page = int(match.group(1))
            if not 1 <= page <= 100000:
                raise HTTPException(status_code=422, detail="Invalid cursor")
        rows = await self.repository.sessions(child_id, actor_id, (page - 1) * limit, limit)
        return SessionHistoryRead(
            sessions=[self.summary(row) for row in rows[:limit]],
            next_cursor=f"page-{page + 1}" if len(rows) > limit and page < 100000 else None,
        )

    async def get(self, session_id: UUID, actor_id: UUID):
        await self.require_parent(actor_id)
        row = await self.repository.session(session_id, actor_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        summary = self.summary(row)
        page_rows = await self.repository.session_page_rows(session_id)
        events = await self.repository.events(session_id)
        assessment = await self.repository.fluency(session_id)
        questions = await self.repository.questions(session_id)
        event_dtos = []
        for event in events:
            try:
                dto = HistoryEventRead(
                    id=event.Id, session_id=event.SessionId, page_id=event.PageId,
                    page_revision_id=event.PageRevisionId, page_revision_word_id=event.WordId,
                    type=event.Type, start_ms=event.StartMs, end_ms=event.EndMs,
                    confidence=event.Confidence, status=event.Status,
                    # Never expose arbitrary diagnostic/device/account metadata.
                    metadata=self.safe_event_metadata(event),
                )
                if dto.session_id != session_id or (dto.end_ms is not None and dto.end_ms < dto.start_ms):
                    continue
                event_dtos.append(dto)
            except (ValidationError, TypeError, ValueError):
                continue

        fluency = None
        if assessment is not None:
            metrics = None
            try:
                metrics = HistoryFluencyMetricsRead.model_validate(assessment.Metrics)
            except ValidationError:
                pass  # A legacy JSON shape is not equivalent to missing data.
            try:
                fluency = HistoryFluencyRead(metrics=metrics, score=assessment.Score, uncertainty=assessment.Uncertainty, model_version=assessment.ModelVersion)
            except ValidationError:
                pass

        comprehension = []
        question_partial = False
        answers_by_question: dict[UUID, ComprehensionAnswer] | None = None
        if isinstance(HistoryRepository, type) and isinstance(self.repository, HistoryRepository):
            answers_by_question = await self.repository.answers_for_questions(
                [question.Id for question in questions]
            )
        for question in questions:
            answer = (
                answers_by_question.get(question.Id)
                if answers_by_question is not None
                else await self.repository.answer(question.Id)
            )
            source_span = None
            try:
                source_span = SessionSourceSpanRead.model_validate(question.SourceSpan)
                if source_span.end_word_index_exclusive <= source_span.start_word_index:
                    source_span = None
            except ValidationError:
                pass
            difficulty = question.Difficulty
            if not isinstance(difficulty, (str, int, float)) or isinstance(difficulty, bool):
                difficulty = None
            if isinstance(difficulty, str) and (not difficulty.strip() or len(difficulty) > 120):
                difficulty = None
            if isinstance(difficulty, (int, float)) and not isfinite(difficulty):
                difficulty = None
            answer_dto = None
            if answer is not None:
                try:
                    answer_dto = HistoryAnswerRead(
                        answer_id=answer.Id, question_id=question.Id,
                        submitted_answer=answer.Answer, is_correct=answer.IsCorrect,
                        score=answer.Score, feedback_code=None,
                    )
                except ValidationError:
                    pass
            try:
                question_dto = HistoryQuestionRead(
                    id=question.Id, type=question.Type, prompt=question.Prompt,
                    page_revision_id=question.PageRevisionId, source_span=source_span,
                    difficulty=difficulty, answered=answer is not None,
                )
                comprehension.append(HistoryComprehensionRead(question=question_dto, answer=answer_dto))
                question_partial |= source_span is None or difficulty is None or (answer is not None and answer_dto is None)
            except ValidationError:
                continue

        def section_status(total, readable, partial=False):
            if total == 0:
                return "absent"
            if readable == 0:
                return "unsupported"
            return "partial" if readable < total or partial else "available"

        from app.services.reading_assessment import aggregate_assessment
        assessment_metrics = aggregate_assessment(
            session_id, await self.repository.comparison_reports(session_id), events,
        )["assessment"]
        return SessionDetailRead(
            **summary.model_dump(),
            assessment=assessment_metrics,
            selected_range_pages=len(page_rows) if page_rows else None,
            pages_completed=(
                sum(1 for page_row in page_rows if page_row.Status == "COMPLETED")
                if page_rows
                else None
            ),
            selected_page_revision_ids=(
                [page_row.PageRevisionId for page_row in page_rows]
                if page_rows
                else ([] if row.SelectedPageRevisionId is None else [row.SelectedPageRevisionId])
            ),
            reference_page_revision_ids=list(dict.fromkeys(event.PageRevisionId for event in events if event.SessionId == session_id)),
            events=event_dtos, fluency_assessment=fluency, comprehension=comprehension,
            availability={
                "events": section_status(len(events), len(event_dtos)),
                "fluency": section_status(int(assessment is not None), int(fluency is not None), fluency is not None and fluency.metrics is None),
                "comprehension": section_status(len(questions), len(comprehension), question_partial),
            },
            report_id=None,
        )

    async def book(self, session_id: UUID, actor_id: UUID):
        await self.require_parent(actor_id)
        row = await self.repository.session_book(session_id, actor_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        try:
            return CatalogBookResponse.model_validate(row)
        except ValidationError:
            raise HTTPException(status_code=501, detail="Book metadata is not available yet") from None


@router.get("/history", response_model=SessionHistoryRead)
async def get_owned_history(
    child_id: UUID,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await HistoryService(HistoryRepository(db)).list(child_id, actor_id, cursor, limit)


@router.get("/history/{session_id}", response_model=SessionDetailRead)
async def get_owned_session_detail(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await HistoryService(HistoryRepository(db)).get(session_id, actor_id)


@router.get("/history/{session_id}/book", response_model=CatalogBookResponse)
async def get_owned_session_book(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await HistoryService(HistoryRepository(db)).book(session_id, actor_id)




@router.post(
    "/sessions/{session_id}/compare",
    response_model=ReadingComparisonReportRead,
)
async def compare_reading(
    session_id: UUID,
    request: CompareReadingRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingComparisonService(db).compare(
        session_id, actor_id, request
    )


@router.get(
    "/sessions/{session_id}/reports",
    response_model=ReadingSessionReportsRead,
)
async def get_session_reports(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingComparisonService(db).list_for_session(
        session_id, actor_id
    )


@router.delete("/reports/{report_id}")
async def delete_reading_report(
    report_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ReadingComparisonService(db).delete(report_id, actor_id)


#Kadepham
from fastapi import UploadFile, File
from app.models.book import PageRevisionWord
from app.schemas.reading import CameraPageMatchRead, ReadingPageRead, ReadingPageWordRead
from app.services.storage_service import download_object
from app.services.vision_page_matcher import vision_page_matcher

MAX_CAMERA_FRAME_BYTES = 8 * 1024 * 1024
MAX_CAMERA_FRAME_PIXELS = 40_000_000
MAX_CAMERA_CANDIDATE_PAGES = 100
MAX_CAMERA_STORAGE_CONCURRENCY = 8
_CAMERA_READ_CHUNK_BYTES = 256 * 1024
_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")


def _is_safe_storage_object_path(image_path: str) -> bool:
    """Allow only relative storage object keys; block URLs, local paths, and traversal."""
    if not isinstance(image_path, str):
        return False
    stripped = image_path.strip()
    if not stripped:
        return False
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in stripped):
        return False
    lowered = stripped.lower()
    if lowered.startswith(("http://", "https://", "file:", "ftp:", "data:")) or "://" in lowered:
        return False
    if stripped.startswith(("/", "\\")) or "\\" in stripped or _WINDOWS_DRIVE_RE.match(stripped):
        return False
    segments = [seg for seg in stripped.split("/") if seg]
    if not segments or any(seg in (".", "..") for seg in segments):
        return False
    return True


async def _read_and_validate_camera_frame(file: UploadFile) -> bytes:
    """Chunk-read uploaded camera image up to 8 MB and verify valid image dimensions."""
    chunks: list[bytes] = []
    total_bytes = 0
    try:
        while True:
            chunk = await file.read(_CAMERA_READ_CHUNK_BYTES)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > MAX_CAMERA_FRAME_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="Uploaded camera frame exceeds the 8 MB limit",
                )
            chunks.append(chunk)
    finally:
        await file.close()

    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=422, detail="Uploaded camera frame is empty")

    try:
        with Image.open(BytesIO(data)) as image:
            if image.width <= 0 or image.height <= 0 or image.width * image.height > MAX_CAMERA_FRAME_PIXELS:
                raise HTTPException(status_code=422, detail="Uploaded image dimensions exceed allowed bounds")
            image.verify()
        with Image.open(BytesIO(data)) as verified_image:
            verified_image.load()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(status_code=422, detail="Invalid or corrupt camera image") from None

    return data


async def _fetch_stored_page_bytes(
    image_path: str, *, bucket_name: str | None = None
) -> bytes | None:
    """Read stored page image strictly from Supabase Storage using validated object keys."""
    if not _is_safe_storage_object_path(image_path):
        return None
    try:
        return await asyncio.to_thread(
            download_object, image_path.strip(), bucket_name=bucket_name
        )
    except Exception:
        return None


async def _fetch_candidate_pages(rows) -> list[dict]:
    """Fetch bounded stored page images with a concurrency cap."""
    from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
    from app.policies.book_access import is_book_private

    bounded_rows = list(rows)[:MAX_CAMERA_CANDIDATE_PAGES]
    semaphore = asyncio.Semaphore(MAX_CAMERA_STORAGE_CONCURRENCY)

    async def _load_one(page_orm, book_row):
        bucket = SUPABASE_PRIVATE_BOOKS_BUCKET if is_book_private(book_row) else None
        async with semaphore:
            img_bytes = await _fetch_stored_page_bytes(page_orm.ImagePath, bucket_name=bucket)
        if not img_bytes:
            return None
        return {"page_orm": page_orm, "image_bytes": img_bytes}

    loaded = await asyncio.gather(*(_load_one(p, b) for p, b in bounded_rows))
    return [item for item in loaded if item is not None]


def _normalize_bbox_tuple(raw_bbox: object) -> tuple[float, float, float, float]:
    """Đảm bảo bbox luôn là tuple 4 số [x, y, width, height] trong đoạn [0, 1]."""
    if isinstance(raw_bbox, (list, tuple)) and len(raw_bbox) == 4:
        return (
            float(raw_bbox[0]),
            float(raw_bbox[1]),
            float(raw_bbox[2]),
            float(raw_bbox[3]),
        )
    if isinstance(raw_bbox, dict):
        return (
            float(raw_bbox.get("x", 0.0)),
            float(raw_bbox.get("y", 0.0)),
            float(raw_bbox.get("w", raw_bbox.get("width", 0.1))),
            float(raw_bbox.get("h", raw_bbox.get("height", 0.05))),
        )
    return (0.0, 0.0, 0.1, 0.05)


_UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_MATCH_PAGE_BOOK_CANDIDATES = 120
MAX_MATCH_PAGE_GLOBAL_CANDIDATES = 60


def _bounded_match_limit(default_limit: int) -> int:
    import os

    raw = (os.getenv("VIREAD_MAX_MATCH_PAGE_CANDIDATES") or "").strip()
    if raw:
        try:
            return max(1, min(200, int(raw)))
        except ValueError:
            pass
    return default_limit


async def _read_upload_bounded(
    file: UploadFile,
    *,
    max_bytes: int = MAX_SCAN_IMAGE_BYTES,
) -> bytes:
    """Read an uploaded image in bounded chunks and fail fast with HTTP 413 above limit."""
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            chunk = await file.read(_UPLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail="Image exceeds the 12 MB limit",
                )
            chunks.append(chunk)
    finally:
        try:
            await file.close()
        except Exception:
            pass
    return b"".join(chunks)


async def _build_match_candidates(
    rows: list[tuple[BookPage, Book]],
) -> list[dict[str, object]]:
    """Resolve candidate page ORB descriptors using the bounded LRU cache before hitting Storage."""
    import asyncio

    from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
    from app.policies.book_access import is_book_private

    candidates: list[dict[str, object]] = []
    missing: list[tuple[BookPage, str | None, tuple[str, str]]] = []
    for p, book_row in rows:
        cache_key = (str(p.Id), str(p.ImagePath or ""))
        cached = vision_page_matcher.get_cached_features(cache_key)
        if cached is not None:
            candidates.append(
                {
                    "page_orm": p,
                    "features": cached,
                    "cache_key": cache_key,
                }
            )
            continue
        bucket = SUPABASE_PRIVATE_BOOKS_BUCKET if is_book_private(book_row) else None
        missing.append((p, bucket, cache_key))

    if missing:
        sem = asyncio.Semaphore(6)

        async def _load_one(
            page_orm: BookPage, bucket_name: str | None, key: tuple[str, str]
        ) -> dict[str, object] | None:
            async with sem:
                img_bytes = await _fetch_stored_page_bytes(
                    page_orm.ImagePath, bucket_name=bucket_name
                )
            if not img_bytes:
                return None
            features = await asyncio.to_thread(
                vision_page_matcher.compute_and_cache_features, key, img_bytes
            )
            if features is not None:
                return {
                    "page_orm": page_orm,
                    "features": features,
                    "cache_key": key,
                }
            return {
                "page_orm": page_orm,
                "image_bytes": img_bytes,
                "cache_key": key,
            }

        loaded = await asyncio.gather(
            *(_load_one(p, bucket, key) for p, bucket, key in missing)
        )
        for item in loaded:
            if item is not None:
                candidates.append(item)

    return candidates


@router.post("/books/{book_id}/match-page", response_model=CameraPageMatchRead)
async def match_book_page_from_camera(
    book_id: UUID,
    file: UploadFile = File(...),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("reading_match", default_max=60, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    Nhận frame ảnh từ Camera của trẻ, kiểm tra sách đã đặt đúng khung chưa,
    sau đó nhận diện xem đó là trang số mấy trong cuốn sách `book_id`.
    """
    import asyncio

    await HistoryService(HistoryRepository(db)).require_parent(actor_id)
    await _release_db(db)

    camera_bytes = await _read_and_validate_camera_frame(file)
    framing = await asyncio.to_thread(vision_page_matcher.check_framing, camera_bytes)

    if not framing["framing_valid"]:
        return CameraPageMatchRead(
            framing_valid=False,
            matched=False,
            status_code=framing["status_code"],
            message=framing["message"],
            confidence=0.0,
            matched_page=None,
        )

    # Lấy các trang ACTIVE của cuốn sách (catalog hợp lệ hoặc sách riêng đã sẵn sàng của actor)
    from app.policies.book_access import (
        is_private_book,
        is_private_page_readable,
    )

    max_candidates = _bounded_match_limit(MAX_MATCH_PAGE_BOOK_CANDIDATES)
    pages_result = await db.execute(
        select(BookPage, Book)
        .join(Book, Book.Id == BookPage.BookId)
        .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
        .where(
            BookPage.BookId == book_id,
            BookPage.LifecycleStatus == "ACTIVE",
            BookPage.CurrentVerifiedRevisionId.is_not(None),
            CatalogRepository.readable_book(actor_id),
            or_(
                ~is_private_book(),
                is_private_page_readable(),
            ),
        )
        .order_by(BookPage.PageNumber)
        .limit(max_candidates)
    )
    rows = pages_result.all()[:max_candidates]
    candidate_rows = _snapshot_camera_candidates(rows)
    await _release_db(db)

    if not candidate_rows:
        raise HTTPException(status_code=404, detail="Resource not found")

    candidate_pages = await _build_match_candidates(candidate_rows)

    if not candidate_pages:
        raise HTTPException(
            status_code=503,
            detail="Could not read the image from Supabase Storage",
        )

    match_res = await asyncio.to_thread(
        vision_page_matcher.match_page, camera_bytes, candidate_pages
    )

    if not match_res["matched"]:
        return CameraPageMatchRead(
            framing_valid=True,
            matched=False,
            status_code="LOW_CONFIDENCE",
            message="Sách đã vào khung nhưng mình chưa nhìn rõ trang mấy. Bé giữ sách phẳng và gần hơn một chút nhé!",
            confidence=match_res["confidence"],
            matched_page=None,
        )

    matched_orm: BookPage = match_res["page"]["page_orm"]
    revision_id = matched_orm.CurrentVerifiedRevisionId

    if revision_id is None:
        raise HTTPException(status_code=404, detail="Resource not found")

    words_result = await db.execute(
        select(PageRevisionWord)
        .where(PageRevisionWord.PageRevisionId == revision_id)
        .order_by(PageRevisionWord.WordIndex)
    )
    words_orm = words_result.scalars().all()

    words_dto = [
        ReadingPageWordRead(
            word_id=w.Id,
            word_index=w.WordIndex,
            text=w.Text,
            bbox=_normalize_bbox_tuple(w.BoundingBox),
        )
        for w in words_orm
    ]

    page_dto = ReadingPageRead(
        page_id=matched_orm.Id,
        page_revision_id=revision_id,
        page_number=matched_orm.PageNumber,
        confidence=match_res["confidence"],
        width=max(1, int(matched_orm.Width or 1000)),
        height=max(1, int(matched_orm.Height or 1400)),
        words=words_dto,
    )

    return CameraPageMatchRead(
        framing_valid=True,
        matched=True,
        book_id=book_id,  # Gán thêm book_id
        status_code="MATCHED",
        message=f"Tuyệt vời! ViRead Vision đã nhận ra Trang {matched_orm.PageNumber}.",
        confidence=match_res["confidence"],
        matched_page=page_dto,
    )

@router.post("/match-page", response_model=CameraPageMatchRead)
async def match_page_global_from_camera(
    file: UploadFile = File(...),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("reading_match", default_max=60, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    Nhận diện sách và trang toàn cục từ Camera (dành cho Dashboard).
    So khớp frame ảnh với các trang sách ACTIVE trong phạm vi tối đa cho phép để tìm cuốn sách và trang tương ứng.
    """
    import asyncio

    await HistoryService(HistoryRepository(db)).require_parent(actor_id)
    await _release_db(db)

    camera_bytes = await _read_and_validate_camera_frame(file)
    framing = await asyncio.to_thread(vision_page_matcher.check_framing, camera_bytes)

    if not framing["framing_valid"]:
        return CameraPageMatchRead(
            framing_valid=False,
            matched=False,
            book_id=None,
            status_code=framing["status_code"],
            message=framing["message"],
            confidence=0.0,
            matched_page=None,
        )

    # Lấy tập ứng viên giới hạn các trang sách ACTIVE của các sách mà actor được phép đọc
    from app.policies.book_access import (
        is_private_book,
        is_private_page_readable,
    )

    max_candidates = _bounded_match_limit(MAX_MATCH_PAGE_GLOBAL_CANDIDATES)
    pages_result = await db.execute(
        select(BookPage, Book)
        .join(Book, Book.Id == BookPage.BookId)
        .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
        .where(
            BookPage.LifecycleStatus == "ACTIVE",
            BookPage.CurrentVerifiedRevisionId.is_not(None),
            CatalogRepository.readable_book(actor_id),
            or_(
                ~is_private_book(),
                is_private_page_readable(),
            ),
        )
        .order_by(BookPage.BookId, BookPage.PageNumber)
        .limit(max_candidates)
    )
    rows = pages_result.all()[:max_candidates]
    candidate_rows = _snapshot_camera_candidates(rows)
    await _release_db(db)

    if not candidate_rows:
        raise HTTPException(status_code=404, detail="No active books or pages found")

    candidate_pages = await _build_match_candidates(candidate_rows)

    if not candidate_pages:
        raise HTTPException(
            status_code=503,
            detail="Could not read the image from Supabase Storage",
        )

    match_res = await asyncio.to_thread(
        vision_page_matcher.match_page, camera_bytes, candidate_pages
    )

    if not match_res["matched"]:
        return CameraPageMatchRead(
            framing_valid=True,
            matched=False,
            book_id=None,
            status_code="LOW_CONFIDENCE",
            message="Sách đã vào khung nhưng mình chưa nhận diện được trang. Bé giữ sách phẳng và gần hơn một chút nhé!",
            confidence=match_res["confidence"],
            matched_page=None,
        )

    matched_orm: BookPage = match_res["page"]["page_orm"]
    revision_id = matched_orm.CurrentVerifiedRevisionId

    if revision_id is None:
        raise HTTPException(status_code=404, detail="Resource not found")

    words_result = await db.execute(
        select(PageRevisionWord)
        .where(PageRevisionWord.PageRevisionId == revision_id)
        .order_by(PageRevisionWord.WordIndex)
    )
    words_orm = words_result.scalars().all()

    words_dto = [
        ReadingPageWordRead(
            word_id=w.Id,
            word_index=w.WordIndex,
            text=w.Text,
            bbox=_normalize_bbox_tuple(w.BoundingBox),
        )
        for w in words_orm
    ]

    page_dto = ReadingPageRead(
        page_id=matched_orm.Id,
        page_revision_id=revision_id,
        page_number=matched_orm.PageNumber,
        confidence=match_res["confidence"],
        width=max(1, int(matched_orm.Width or 1000)),
        height=max(1, int(matched_orm.Height or 1400)),
        words=words_dto,
    )

    return CameraPageMatchRead(
        framing_valid=True,
        matched=True,
        book_id=matched_orm.BookId,
        status_code="MATCHED",
        message=f"Tuyệt vời! ViRead Vision đã nhận ra Trang {matched_orm.PageNumber}.",
        confidence=match_res["confidence"],
        matched_page=page_dto,
    )


from fastapi import Form, Header, Request
from app.repositories.local_ocr_scan_repository import LocalOcrScanRepository
from app.schemas.reading import (
    LocalOcrPageScanJobListRead,
    LocalOcrPageScanJobRead,
    LocalOcrPageScanRead,
)
from app.services.local_ocr_scan_service import LocalOcrScanService


@router.post("/scan-page-ocr", response_model=LocalOcrPageScanRead)
async def scan_page_with_local_ocr(
    request: Request,
    file: UploadFile = File(...),
    book_id: UUID | None = Form(default=None),
    child_id: UUID | None = Form(default=None),
    idempotency_key: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("reading_ocr", default_max=20, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    """Run local Vietnamese OCR on an uploaded/photographed book page and match verified catalog pages."""
    request_id = str(getattr(request.state, "request_id", ""))
    return await LocalOcrScanService(LocalOcrScanRepository(db)).scan_page(
        actor_id,
        file,
        request_id=request_id,
        book_id=book_id,
        child_id=child_id,
        idempotency_key=idempotency_key,
    )


@router.post(
    "/scan-page-ocr/jobs",
    response_model=LocalOcrPageScanJobRead,
    status_code=202,
)
async def enqueue_scan_page_ocr_job(
    request: Request,
    file: UploadFile = File(...),
    book_id: UUID | None = Form(default=None),
    child_id: UUID | None = Form(default=None),
    idempotency_key: UUID | None = Form(default=None),
    idempotency_key_header: str | None = Header(default=None, alias="Idempotency-Key"),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("reading_ocr", default_max=20, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    """Enqueue an asynchronous Vietnamese OCR page scan job (safe even while remote worker is offline)."""
    request_id = str(getattr(request.state, "request_id", ""))
    return await LocalOcrScanService(LocalOcrScanRepository(db)).enqueue_scan_page_job(
        actor_id,
        file,
        request_id=request_id,
        book_id=book_id,
        child_id=child_id,
        idempotency_key=idempotency_key,
        idempotency_key_raw=idempotency_key_header,
    )


@router.get(
    "/scan-page-ocr/jobs",
    response_model=LocalOcrPageScanJobListRead,
)
async def list_scan_page_ocr_jobs(
    request: Request,
    active_only: bool = Query(default=True),
    limit: int = Query(default=10, ge=1, le=20),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """List authenticated parent's own queued/recent async page scan OCR jobs."""
    request_id = str(getattr(request.state, "request_id", ""))
    return await LocalOcrScanService(LocalOcrScanRepository(db)).list_scan_page_jobs(
        actor_id,
        request_id=request_id,
        active_only=active_only,
        limit=limit,
    )


@router.get(
    "/scan-page-ocr/jobs/{job_id}",
    response_model=LocalOcrPageScanJobRead,
)
async def get_scan_page_ocr_job(
    job_id: UUID,
    request: Request,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Poll owner-scoped status and final result for an async page scan OCR job."""
    request_id = str(getattr(request.state, "request_id", ""))
    return await LocalOcrScanService(LocalOcrScanRepository(db)).get_scan_page_job(
        actor_id,
        job_id,
        request_id=request_id,
    )


@router.delete(
    "/scan-page-ocr/jobs/{job_id}",
    response_model=LocalOcrPageScanJobRead,
)
async def cancel_scan_page_ocr_job(
    job_id: UUID,
    request: Request,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Cancel an active owner-scoped async page scan OCR job and clean its temp image."""
    request_id = str(getattr(request.state, "request_id", ""))
    return await LocalOcrScanService(LocalOcrScanRepository(db)).cancel_scan_page_job(
        actor_id,
        job_id,
        request_id=request_id,
    )


