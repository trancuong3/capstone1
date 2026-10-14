from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
from uuid import UUID

from app.api.deps import get_db
from app.models import ReadingSession, ReadingEvent, FluencyAssessment
from app.schemas import (
    ReadingSessionResponse, ReadingSessionCreate,
    ReadingEventResponse, ReadingEventCreate,
    FluencyAssessmentResponse, FluencyAssessmentCreate
)

from datetime import datetime, timezone
from app.models import BookPage, PageRevision, PageRevisionWord
from app.services.storage_service import create_signed_image_url
from app.schemas.reading import (
    ReadingPageDTO, ReadingPageWordDTO, ReadingCompletionSummaryDTO,
    SessionSummaryRead,
)

router = APIRouter()

@router.get("/sessions", response_model=List[ReadingSessionResponse])
async def get_sessions(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách các phiên đọc"""
    result = await db.execute(select(ReadingSession))
    return result.scalars().all()

@router.post("/sessions", response_model=ReadingSessionResponse)
async def create_session(session_in: ReadingSessionCreate, db: AsyncSession = Depends(get_db)):
    """Tạo phiên đọc mới khi bé bắt đầu đọc sách"""
    child_id = session_in.ChildId or session_in.child_id
    book_id = session_in.BookId or session_in.book_id
    if not child_id or not book_id:
        raise HTTPException(status_code=422, detail="ChildId and BookId are required")

    state = session_in.state or session_in.State or "IN_PROGRESS"
    db_state = "IN_PROGRESS" if state in ("CREATED", "PAGE_READY", "LISTENING", "IN_PROGRESS") else ("COMPLETED" if state in ("FINISHED", "COMPLETED") else state)
    mode = session_in.mode or session_in.Mode or "realtime"
    page_id = session_in.SelectedPageId or session_in.selected_page_id
    rev_id = session_in.SelectedPageRevisionId or session_in.selected_page_revision_id

    if not page_id:
        first_page = await db.scalar(
            select(BookPage).where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.CurrentVerifiedRevisionId.isnot(None),
            ).order_by(BookPage.PageNumber, BookPage.Id).limit(1)
        )
        if not first_page:
            first_page = await db.scalar(
                select(BookPage).where(
                    BookPage.BookId == book_id,
                ).order_by(BookPage.PageNumber, BookPage.Id).limit(1)
            )
        if first_page:
            page_id = first_page.Id
            rev_id = first_page.CurrentVerifiedRevisionId

    new_session = ReadingSession(
        ChildId=child_id,
        BookId=book_id,
        SelectedPageId=page_id,
        SelectedPageRevisionId=rev_id,
        State=db_state,
        Mode=mode,
        ClientMeta=session_in.ClientMeta,
    )
    db.add(new_session)
    await db.commit()
    await db.refresh(new_session)
    return new_session


async def _build_reading_page_dto(page: BookPage, db: AsyncSession) -> ReadingPageDTO:
    rev_id = page.CurrentVerifiedRevisionId
    revision = None
    if rev_id:
        revision = await db.scalar(select(PageRevision).where(PageRevision.Id == rev_id))
    if not revision:
        revision = await db.scalar(
            select(PageRevision).where(
                PageRevision.PageId == page.Id,
                PageRevision.VerificationStatus == "VERIFIED",
            ).order_by(PageRevision.CreatedAt.desc()).limit(1)
        )
    if not revision:
        revision = await db.scalar(
            select(PageRevision).where(
                PageRevision.PageId == page.Id,
            ).order_by(PageRevision.CreatedAt.desc()).limit(1)
        )

    words: list[ReadingPageWordDTO] = []
    text_content = ""
    if revision:
        text_content = revision.VerifiedText or getattr(revision, "DraftText", None) or ""
        word_rows = (await db.execute(
            select(PageRevisionWord).where(
                PageRevisionWord.PageRevisionId == revision.Id
            ).order_by(PageRevisionWord.WordIndex)
        )).scalars().all()
        for w in word_rows:
            box = (0.1, 0.1, 0.1, 0.05)
            if isinstance(w.BoundingBox, (list, tuple)) and len(w.BoundingBox) == 4:
                try:
                    box = (float(w.BoundingBox[0]), float(w.BoundingBox[1]), float(w.BoundingBox[2]), float(w.BoundingBox[3]))
                except (ValueError, TypeError):
                    pass
            words.append(ReadingPageWordDTO(
                word_id=w.Id,
                word_index=w.WordIndex,
                text=w.Text,
                bbox=box,
            ))

    if not words and text_content:
        for idx, token in enumerate(text_content.split()):
            words.append(ReadingPageWordDTO(
                word_id=UUID(int=idx + 1),
                word_index=idx,
                text=token,
                bbox=(0.05 + (idx % 8) * 0.1, 0.1 + (idx // 8) * 0.08, 0.08, 0.05),
            ))

    image_url = None
    if page.ImagePath:
        try:
            image_url = create_signed_image_url(page.ImagePath)
        except Exception:
            pass

    return ReadingPageDTO(
        page_id=page.Id,
        page_revision_id=revision.Id if revision else page.Id,
        page_number=page.PageNumber,
        confidence=1.0,
        width=1000,
        height=1000,
        image_url=image_url,
        text=text_content,
        words=words,
    )


@router.get("/sessions/{session_id}", response_model=SessionSummaryRead)
async def get_session(session_id: UUID, db: AsyncSession = Depends(get_db)):
    session = await db.scalar(select(ReadingSession).where(ReadingSession.Id == session_id))
    if not session:
        raise HTTPException(status_code=404, detail="Reading session not found")
    duration = None
    if session.EndedAt and session.StartedAt:
        duration = int((session.EndedAt - session.StartedAt).total_seconds() * 1000)
    wire_state = "PAGE_READY"
    if session.State == "COMPLETED":
        wire_state = "FINISHED"
    elif session.State == "PAUSED":
        wire_state = "PAUSED"
    elif session.State == "ABORTED":
        wire_state = "ABORTED"
    elif session.State in ("CREATED", "PAGE_READY", "LISTENING"):
        wire_state = session.State
    return SessionSummaryRead(
        id=session.Id,
        child_id=session.ChildId,
        book_id=session.BookId,
        state=wire_state,
        started_at=session.StartedAt,
        ended_at=session.EndedAt,
        duration_ms=duration,
    )


@router.get("/sessions/{session_id}/page", response_model=ReadingPageDTO)
async def get_session_current_page(session_id: UUID, db: AsyncSession = Depends(get_db)):
    session = await db.scalar(select(ReadingSession).where(ReadingSession.Id == session_id))
    if not session:
        raise HTTPException(status_code=404, detail="Reading session not found")

    page = None
    if session.SelectedPageId:
        page = await db.scalar(select(BookPage).where(BookPage.Id == session.SelectedPageId))
    if not page:
        page = await db.scalar(
            select(BookPage).where(
                BookPage.BookId == session.BookId,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.CurrentVerifiedRevisionId.isnot(None),
            ).order_by(BookPage.PageNumber, BookPage.Id).limit(1)
        )
    if not page:
        page = await db.scalar(
            select(BookPage).where(BookPage.BookId == session.BookId).order_by(BookPage.PageNumber).limit(1)
        )
    if not page:
        raise HTTPException(status_code=404, detail="No pages available for this book")
    return await _build_reading_page_dto(page, db)


@router.get("/pages/{page_id}", response_model=ReadingPageDTO)
async def get_reading_page(page_id: UUID, db: AsyncSession = Depends(get_db)):
    page = await db.scalar(select(BookPage).where(BookPage.Id == page_id))
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    return await _build_reading_page_dto(page, db)


@router.post("/sessions/{session_id}/finish", response_model=SessionSummaryRead)
async def finish_session(session_id: UUID, db: AsyncSession = Depends(get_db)):
    session = await db.scalar(select(ReadingSession).where(ReadingSession.Id == session_id))
    if not session:
        raise HTTPException(status_code=404, detail="Reading session not found")
    session.State = "COMPLETED"
    session.EndedAt = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(session)
    duration = None
    if session.EndedAt and session.StartedAt:
        duration = int((session.EndedAt - session.StartedAt).total_seconds() * 1000)
    return SessionSummaryRead(
        id=session.Id,
        child_id=session.ChildId,
        book_id=session.BookId,
        state="FINISHED",
        started_at=session.StartedAt,
        ended_at=session.EndedAt,
        duration_ms=duration,
    )


@router.get("/sessions/{session_id}/completion-summary", response_model=ReadingCompletionSummaryDTO)
async def get_session_completion_summary(session_id: UUID, db: AsyncSession = Depends(get_db)):
    session = await db.scalar(select(ReadingSession).where(ReadingSession.Id == session_id))
    if not session:
        raise HTTPException(status_code=404, detail="Reading session not found")
    duration_min = 1
    if session.EndedAt and session.StartedAt:
        duration_min = max(1, int((session.EndedAt - session.StartedAt).total_seconds() // 60))
    return ReadingCompletionSummaryDTO(
        duration_minutes=duration_min,
        pages_explored=1,
        practiced_words=20,
        spoken_words=[],
        transcripts=[],
    )

@router.post("/events", response_model=ReadingEventResponse)
async def create_reading_event(event_in: ReadingEventCreate, db: AsyncSession = Depends(get_db)):
    """Ghi nhận một lỗi phát âm hoặc sự kiện đọc"""
    new_event = ReadingEvent(**event_in.model_dump())
    db.add(new_event)
    await db.commit()
    await db.refresh(new_event)
    return new_event

@router.post("/fluency", response_model=FluencyAssessmentResponse)
async def create_fluency_assessment(assessment_in: FluencyAssessmentCreate, db: AsyncSession = Depends(get_db)):
    """Lưu đánh giá độ trôi chảy sau khi kết thúc phiên đọc"""
    new_assessment = FluencyAssessment(**assessment_in.model_dump())
    db.add(new_assessment)
    await db.commit()
    await db.refresh(new_assessment)
    return new_assessment


from fastapi import Query
import re
from pydantic import ValidationError
from app.api.deps import get_current_parent_id
from app.models import Book, ChildProfile, Profile, ComprehensionQuestion, ComprehensionAnswer
from app.schemas.book import CatalogBookResponse
from app.schemas.reading import (
    SessionSummaryRead, SessionHistoryRead, SessionDetailRead, SessionEventRead,
    SessionFluencyRead, SessionComprehensionRead,
)


class HistoryRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID):
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))

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
        # Historical metadata must not depend on current catalog eligibility.
        return await self.db.scalar(
            select(Book).join(ReadingSession, ReadingSession.BookId == Book.Id)
            .join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
            .where(ReadingSession.Id == session_id, ChildProfile.ParentId == actor_id)
        )

    async def events(self, session_id: UUID):
        result = await self.db.execute(select(ReadingEvent).where(ReadingEvent.SessionId == session_id).order_by(ReadingEvent.StartMs, ReadingEvent.Id))
        return result.scalars().all()

    async def fluency(self, session_id: UUID):
        return await self.db.scalar(select(FluencyAssessment).where(FluencyAssessment.SessionId == session_id).order_by(FluencyAssessment.CreatedAt.desc(), FluencyAssessment.Id.desc()).limit(1))

    async def questions(self, session_id: UUID):
        result = await self.db.execute(select(ComprehensionQuestion).where(ComprehensionQuestion.SessionId == session_id).order_by(ComprehensionQuestion.CreatedAt, ComprehensionQuestion.Id))
        return result.scalars().all()

    async def answer(self, question_id: UUID):
        return await self.db.scalar(select(ComprehensionAnswer).where(ComprehensionAnswer.QuestionId == question_id).order_by(ComprehensionAnswer.CreatedAt.desc(), ComprehensionAnswer.Id.desc()).limit(1))


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
            return SessionSummaryRead(
                id=row.Id, child_id=row.ChildId, book_id=row.BookId, state=row.State,
                started_at=row.StartedAt, ended_at=row.EndedAt, duration_ms=duration,
            )
        except (ValidationError, TypeError, ValueError):
            # Do not reinterpret COMPLETED/IN_PROGRESS as a different wire enum.
            raise HTTPException(status_code=501, detail="Session contract is not available yet") from None

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
            next_cursor=f"page-{page + 1}" if len(rows) > limit else None,
        )

    async def get(self, session_id: UUID, actor_id: UUID):
        await self.require_parent(actor_id)
        row = await self.repository.session(session_id, actor_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        summary = self.summary(row)
        events = await self.repository.events(session_id)
        assessment = await self.repository.fluency(session_id)
        questions = await self.repository.questions(session_id)
        try:
            event_dtos = [SessionEventRead(
                id=event.Id, session_id=event.SessionId, page_id=event.PageId,
                page_revision_id=event.PageRevisionId, page_revision_word_id=event.WordId,
                type=event.Type, start_ms=event.StartMs, end_ms=event.EndMs,
                confidence=event.Confidence, status=event.Status,
                # Screens do not need raw metadata; it can contain account,
                # device or diagnostic payloads. Only expose the event DTO.
                metadata={},
            ) for event in events]
            fluency = None
            if assessment is not None:
                try:
                    fluency = SessionFluencyRead(metrics=assessment.Metrics, score=assessment.Score, uncertainty=assessment.Uncertainty, model_version=assessment.ModelVersion)
                except ValidationError:
                    # Optional assessment remains unknown until its DTO is available.
                    fluency = None
            comprehension = []
            for question in questions:
                answer = await self.repository.answer(question.Id)
                comprehension.append(SessionComprehensionRead(
                    question={
                        "id": question.Id, "type": question.Type, "prompt": question.Prompt,
                        "page_revision_id": question.PageRevisionId, "source_span": question.SourceSpan,
                        "difficulty": question.Difficulty, "answered": answer is not None,
                    },
                    answer=None if answer is None else {
                        "answer_id": answer.Id, "question_id": question.Id,
                        "submitted_answer": answer.Answer, "is_correct": answer.IsCorrect,
                        "score": answer.Score, "feedback_code": None,
                    },
                ))
            return SessionDetailRead(
                **summary.model_dump(),
                selected_page_revision_ids=[] if row.SelectedPageRevisionId is None else [row.SelectedPageRevisionId],
                reference_page_revision_ids=list(dict.fromkeys(event.PageRevisionId for event in events)),
                events=event_dtos, fluency_assessment=fluency, comprehension=comprehension,
                report_id=None,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Session detail contract is not available yet") from None

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
