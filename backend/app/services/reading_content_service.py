from __future__ import annotations

import math
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status

from app.models import BookPage, FluencyAssessment, ReadingEvent, ReadingSession, ReadingSessionPage
from app.repositories.reading_content_repository import ReadingContentRepository
from app.schemas.reading import (
    FluencyAssessmentCreate,
    ReadingCompletionSummaryDTO,
    ReadingEventCreate,
    ReadingPageDTO,
    ReadingPageWordDTO,
    ReadingSessionCreate,
    SessionSummaryRead,
    ReadingPageNavigationCreate,
    ReadingSessionPageProgressDTO,
    ReadingSessionPageProgressItem,
)
from app.services.storage_service import create_signed_image_url


class ReadingContentService:
    """Business rules for starting a session and reading verified catalog content."""

    def __init__(self, repository: ReadingContentRepository):
        self.repository = repository

    async def require_parent(self, actor_id: UUID) -> None:
        if await self.repository.profile_role(actor_id) != "parent":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Parent access required",
            )

    async def require_owned_child(self, child_id: UUID, actor_id: UUID) -> None:
        if not await self.repository.child_belongs_to_parent(child_id, actor_id):
            # Return the same response for a missing child and a child owned by
            # another parent so this endpoint cannot enumerate child profiles.
            raise HTTPException(status_code=404, detail="Child profile not found")

    @staticmethod
    def _valid_bbox(
        bbox: object,
    ) -> tuple[float, float, float, float] | None:
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            return None
        try:
            x, y, width, height = (float(value) for value in bbox)
        except (TypeError, ValueError):
            return None
        if (
            not all(math.isfinite(value) for value in (x, y, width, height))
            or x < 0
            or y < 0
            or width <= 0
            or height <= 0
            or x + width > 1.000001
            or y + height > 1.000001
        ):
            return None
        return x, y, width, height

    async def list_sessions(self, actor_id: UUID) -> list[ReadingSession]:
        await self.require_parent(actor_id)
        return await self.repository.sessions_for_parent(actor_id)

    async def get_completion_summary(
        self,
        session_id: UUID,
        actor_id: UUID,
    ) -> ReadingCompletionSummaryDTO:
        await self.require_parent(actor_id)
        session = await self.repository.session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)

        # Page completion comes from the durable session-page table. The current
        # schema still does not persist recognized words or audio transcripts, so
        # those metrics remain null rather than fabricated zeroes.
        duration_min = None
        if session.EndedAt and session.StartedAt:
            start = session.StartedAt
            end = session.EndedAt
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            duration_min = max(0, int((end - start).total_seconds() // 60))
        page_rows = await self.repository.session_page_rows(session.Id)
        return ReadingCompletionSummaryDTO(
            duration_minutes=duration_min,
            pages_explored=(
                sum(1 for row in page_rows if row.Status == "COMPLETED")
                if page_rows
                else None
            ),
            selected_range_pages=len(page_rows) if page_rows else None,
            practiced_words=None,
            spoken_words=None,
            transcripts=None,
        )

    async def create_reading_event(
        self,
        actor_id: UUID,
        payload: ReadingEventCreate,
    ) -> ReadingEvent:
        await self.require_parent(actor_id)
        session = await self.repository.session(payload.SessionId)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)

        session_rows = await self.repository.session_page_rows(session.Id)
        if session_rows:
            snapshot = await self.repository.session_page(session.Id, payload.PageId)
            if snapshot is None or snapshot.PageRevisionId != payload.PageRevisionId:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "Reading events must reference a page and revision in this session's selected range.",
                    },
                )
            page = await self.repository.page_by_id(snapshot.PageId)
            revision = await self.repository.revision_snapshot(
                snapshot.PageId, snapshot.PageRevisionId
            )
            if page is None or page.BookId != session.BookId or revision is None:
                raise HTTPException(status_code=409, detail="Saved page revision is unavailable")
        else:
            page = await self.repository.verified_page(payload.PageId, session.BookId)
            if page is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "Reading events must reference an active verified page in this session's book.",
                    },
                )
            revision = await self.repository.verified_revision(page.Id, payload.PageRevisionId)
            if revision is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "Reading events must reference a verified revision of the selected page.",
                    },
                )
        if payload.WordId is not None and not await self.repository.revision_word_exists(
            revision.Id, payload.WordId
        ):
            raise HTTPException(status_code=422, detail="Word does not belong to the referenced page revision")

        event = ReadingEvent(**payload.model_dump())
        return await self.repository.create_reading_event(event)

    async def create_fluency_assessment(
        self,
        actor_id: UUID,
        payload: FluencyAssessmentCreate,
    ) -> FluencyAssessment:
        await self.require_parent(actor_id)
        session = await self.repository.session(payload.SessionId)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)

        assessment = FluencyAssessment(**payload.model_dump())
        return await self.repository.create_fluency_assessment(assessment)

    async def create_session(
        self,
        actor_id: UUID,
        payload: ReadingSessionCreate,
    ) -> ReadingSession:
        await self.require_parent(actor_id)
        child_id = payload.ChildId or payload.child_id
        book_id = payload.BookId or payload.book_id
        if child_id is None or book_id is None:
            raise HTTPException(
                status_code=422,
                detail="ChildId and BookId are required",
            )
        await self.require_owned_child(child_id, actor_id)

        page_id = payload.SelectedPageId or payload.selected_page_id
        requested_revision_id = (
            payload.SelectedPageRevisionId or payload.selected_page_revision_id
        )
        if page_id is not None:
            page = await self.repository.verified_page(page_id, book_id)
            if page is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "Trang bắt đầu không còn ACTIVE và VERIFIED để đọc.",
                    },
                )
        else:
            page = await self.repository.first_verified_page(book_id)
            if page is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "Sách chưa có trang ACTIVE và VERIFIED để đọc.",
                    },
                )

        end_page_id = payload.EndPageId or payload.end_page_id
        end_page = (
            await self.repository.verified_page(end_page_id, book_id)
            if end_page_id is not None
            else page
        )
        if end_page is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "Trang kết thúc không thuộc sách hoặc chưa ACTIVE và VERIFIED.",
                },
            )
        if end_page.PageNumber < page.PageNumber:
            raise HTTPException(status_code=422, detail="Trang kết thúc không được đứng trước trang bắt đầu.")

        # A selected range must be complete. Do not silently skip missing,
        # retired, unverified, or duplicate-numbered pages in the middle.
        raw_pages = await self.repository.all_pages_between_numbers(
            book_id, page.PageNumber, end_page.PageNumber
        )
        eligible_pages = await self.repository.verified_pages_between_numbers(
            book_id, page.PageNumber, end_page.PageNumber
        )
        expected_numbers = list(range(page.PageNumber, end_page.PageNumber + 1))
        raw_numbers = [row.PageNumber for row in raw_pages]
        eligible_numbers = [row.PageNumber for row in eligible_pages]
        if raw_numbers != expected_numbers or eligible_numbers != expected_numbers:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "READING_RANGE_NOT_CONTIGUOUS",
                    "message": "Khoảng trang có trang bị thiếu, ngừng hoạt động hoặc chưa được quản trị viên xác minh. Vui lòng chọn lại phạm vi.",
                },
            )

        verified_snapshots: list[tuple[BookPage, object]] = []
        for index, candidate_page in enumerate(eligible_pages):
            current_revision_id = candidate_page.CurrentVerifiedRevisionId
            if current_revision_id is None or (
                index == 0
                and requested_revision_id is not None
                and requested_revision_id != current_revision_id
            ):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "Revision của một trang trong phạm vi không còn là revision VERIFIED hiện tại.",
                    },
                )
            revision = await self.repository.verified_revision(
                candidate_page.Id, current_revision_id
            )
            if revision is None or not (revision.VerifiedText or "").strip():
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": f"Trang {candidate_page.PageNumber} không có nội dung đã xác minh để đọc.",
                    },
                )
            revision_words = await self.repository.revision_words(revision.Id)
            if not any(
                row.Text.strip() and self._valid_bbox(row.BoundingBox) is not None
                for row in revision_words
            ):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": f"Trang {candidate_page.PageNumber} không có dữ liệu từ và vị trí hợp lệ.",
                    },
                )
            verified_snapshots.append((candidate_page, revision))

        state = payload.state or payload.State or "CREATED"
        state_mapping = {
            "CREATED": "IN_PROGRESS",
            "PAGE_READY": "IN_PROGRESS",
            "LISTENING": "IN_PROGRESS",
            "IN_PROGRESS": "IN_PROGRESS",
        }
        if state not in state_mapping:
            raise HTTPException(
                status_code=422,
                detail="A new reading session must start in CREATED, PAGE_READY, LISTENING, or IN_PROGRESS state.",
            )
        mode = (payload.mode or payload.Mode or "realtime").strip()
        if not mode:
            raise HTTPException(status_code=422, detail="Reading mode is required")

        now = datetime.now(timezone.utc)
        first_revision = verified_snapshots[0][1]
        session = ReadingSession(
            ChildId=child_id,
            BookId=book_id,
            SelectedPageId=page.Id,
            SelectedPageRevisionId=first_revision.Id,
            StartPageId=page.Id,
            EndPageId=end_page.Id,
            CurrentPageId=page.Id,
            State=state_mapping[state],
            Mode=mode,
            ClientMeta=payload.ClientMeta or {},
        )
        page_rows = [
            ReadingSessionPage(
                PageId=snapshot_page.Id,
                PageRevisionId=snapshot_revision.Id,
                PageNumber=snapshot_page.PageNumber,
                PageOrder=order,
                Status="IN_PROGRESS" if order == 0 else "PENDING",
                StartedAt=now if order == 0 else None,
            )
            for order, (snapshot_page, snapshot_revision) in enumerate(verified_snapshots)
        ]
        return await self.repository.create_session(session, page_rows)

    @staticmethod
    def _summary(session: ReadingSession) -> SessionSummaryRead:
        duration_ms = None
        if session.EndedAt is not None and session.StartedAt is not None:
            start = session.StartedAt
            end = session.EndedAt
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            duration_ms = max(0, int((end - start).total_seconds() * 1000))

        if session.State in ("FINISHED", "COMPLETED"):
            wire_state = "FINISHED"
        elif session.State in ("CREATED", "PAGE_READY", "LISTENING", "PAUSED", "RECONNECTING", "QUESTIONING", "ABORTED"):
            wire_state = session.State
        else:
            wire_state = "PAGE_READY"

        return SessionSummaryRead(
            id=session.Id,
            child_id=session.ChildId,
            book_id=session.BookId,
            state=wire_state,
            started_at=session.StartedAt,
            ended_at=session.EndedAt,
            duration_ms=duration_ms,
        )

    async def finish_session(
        self,
        session_id: UUID,
        actor_id: UUID,
    ) -> SessionSummaryRead:
        await self.require_parent(actor_id)
        session = await self.repository.session_for_update(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)

        if session.State not in ("COMPLETED", "FINISHED"):
            rows = await self.repository.session_page_rows(session.Id)
            ended_at = datetime.now(timezone.utc)
            if rows:
                # Finishing a session is not, by itself, proof that its
                # current page was read. Page completion is persisted by explicit
                # confirmation or when the child advances to the next page.
                self.repository.update_session_state(
                    session, state="COMPLETED", ended_at=ended_at
                )
                session = await self.repository.save_session_progress(session, rows)
            else:
                self.repository.update_session_state(
                    session, state="COMPLETED", ended_at=ended_at
                )
                session = await self.repository.save_session(session)
        return self._summary(session)

    async def get_session_summary(
        self,
        session_id: UUID,
        actor_id: UUID,
    ) -> SessionSummaryRead:
        await self.require_parent(actor_id)
        session = await self.repository.session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)
        return self._summary(session)

    async def get_session_page(self, session_id: UUID, actor_id: UUID) -> ReadingPageDTO:
        await self.require_parent(actor_id)
        session = await self.repository.session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)

        page_rows = await self.repository.session_page_rows(session.Id)
        if page_rows:
            current_id = session.CurrentPageId or next(
                (row.PageId for row in page_rows if row.Status == "IN_PROGRESS"),
                page_rows[0].PageId,
            )
            snapshot = next((row for row in page_rows if row.PageId == current_id), None)
            if snapshot is None:
                raise HTTPException(status_code=409, detail="Current page is not part of this session's range")
            page = await self.repository.page_by_id(snapshot.PageId)
            revision = await self.repository.revision_snapshot(
                snapshot.PageId, snapshot.PageRevisionId
            )
            if page is None or revision is None or page.BookId != session.BookId:
                raise HTTPException(status_code=409, detail="Saved page snapshot is unavailable")
            return await self._build_page_dto(page, revision)

        # Legacy sessions created before range persistence continue to use the
        # original one-page selection and current verified-revision contract.
        page = None
        if session.SelectedPageId is not None:
            page = await self.repository.verified_page(session.SelectedPageId, session.BookId)
            if page is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "The selected page is no longer an active, verified reading page.",
                    },
                )
        else:
            page = await self.repository.first_verified_page(session.BookId)
        if page is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "No active page verified by an administrator is available.",
                },
            )
        revision_id = (
            session.SelectedPageRevisionId
            if session.SelectedPageId == page.Id
            else page.CurrentVerifiedRevisionId
        )
        revision = await self.repository.verified_revision(page.Id, revision_id)
        if revision is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "The reading session does not reference a verified page revision.",
                },
            )
        return await self._build_page_dto(page, revision)

    async def get_page(
        self,
        page_id: UUID,
        session_id: UUID,
        actor_id: UUID,
    ) -> ReadingPageDTO:
        await self.require_parent(actor_id)
        session = await self.repository.session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)

        session_rows = await self.repository.session_page_rows(session.Id)
        if session_rows:
            snapshot = await self.repository.session_page(session.Id, page_id)
            if snapshot is None:
                raise HTTPException(
                    status_code=404,
                    detail="Page is outside this reading session's selected range",
                )
            page = await self.repository.page_by_id(snapshot.PageId)
            revision = await self.repository.revision_snapshot(
                snapshot.PageId, snapshot.PageRevisionId
            )
            if page is None or revision is None or page.BookId != session.BookId:
                raise HTTPException(status_code=409, detail="Saved page snapshot is unavailable")
            return await self._build_page_dto(page, revision)

        # Legacy one-page sessions retain the existing same-book eligibility rule.
        page = await self.repository.verified_page(page_id, session.BookId)
        if page is None:
            raise HTTPException(
                status_code=404,
                detail="Active verified page not found in this reading session's book",
            )
        revision = await self.repository.verified_revision(page.Id, page.CurrentVerifiedRevisionId)
        if revision is None:
            raise HTTPException(status_code=409, detail="Verified page revision is unavailable")
        return await self._build_page_dto(page, revision)

    async def get_session_progress(
        self, session_id: UUID, actor_id: UUID
    ) -> ReadingSessionPageProgressDTO:
        await self.require_parent(actor_id)
        session = await self.repository.session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)
        rows = await self.repository.session_page_rows(session.Id)
        if not rows:
            # Stable compatibility response for sessions created before this
            # feature: expose their selected page as a one-page range.
            page = await self.get_session_page(session_id, actor_id)
            # Legacy sessions have no durable page-completion evidence.
            return ReadingSessionPageProgressDTO(
                session_id=session.Id,
                persisted=False,
                start_page_id=page.page_id,
                end_page_id=page.page_id,
                current_page_id=page.page_id,
                start_page_number=page.page_number,
                end_page_number=page.page_number,
                current_page_number=page.page_number,
                current_index=0,
                total_pages=1,
                completed_pages=0,
                pages=[ReadingSessionPageProgressItem(
                    page_id=page.page_id,
                    page_revision_id=page.page_revision_id,
                    page_number=page.page_number,
                    page_order=0,
                    status="IN_PROGRESS",
                    started_at=session.StartedAt,
                    completed_at=None,
                )],
            )

        current_id = session.CurrentPageId or next(
            (row.PageId for row in rows if row.Status == "IN_PROGRESS"),
            rows[0].PageId,
        )
        current_index = next(
            (i for i, row in enumerate(rows) if row.PageId == current_id), 0
        )
        current_row = rows[current_index]
        return ReadingSessionPageProgressDTO(
            session_id=session.Id,
            persisted=True,
            start_page_id=rows[0].PageId,
            end_page_id=rows[-1].PageId,
            current_page_id=current_row.PageId,
            start_page_number=rows[0].PageNumber,
            end_page_number=rows[-1].PageNumber,
            current_page_number=current_row.PageNumber,
            current_index=current_index,
            total_pages=len(rows),
            completed_pages=sum(1 for row in rows if row.Status == "COMPLETED"),
            pages=[
                ReadingSessionPageProgressItem(
                    page_id=row.PageId,
                    page_revision_id=row.PageRevisionId,
                    page_number=row.PageNumber,
                    page_order=row.PageOrder,
                    status=row.Status,
                    started_at=row.StartedAt,
                    completed_at=row.CompletedAt,
                )
                for row in rows
            ],
        )

    async def complete_session_page(
        self,
        session_id: UUID,
        page_id: UUID,
        actor_id: UUID,
    ) -> ReadingSessionPageProgressDTO:
        await self.require_parent(actor_id)
        session = await self.repository.session_for_update(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)
        if session.State in ("COMPLETED", "FINISHED", "ABORTED"):
            raise HTTPException(status_code=409, detail="A finished session cannot complete another page")

        rows = await self.repository.session_page_rows(session.Id)
        if not rows:
            raise HTTPException(
                status_code=409,
                detail="Page completion is not persisted for this legacy session",
            )
        current_id = session.CurrentPageId or next(
            (row.PageId for row in rows if row.Status == "IN_PROGRESS"),
            rows[0].PageId,
        )
        if page_id != current_id:
            raise HTTPException(
                status_code=409,
                detail="Only the current page can be explicitly marked as completed",
            )
        current = next((row for row in rows if row.PageId == page_id), None)
        if current is None:
            raise HTTPException(status_code=404, detail="Page is outside this session's selected range")

        if current.Status != "COMPLETED":
            current.Status = "COMPLETED"
            current.CompletedAt = current.CompletedAt or datetime.now(timezone.utc)
            await self.repository.save_session_progress(session, rows)
        return await self.get_session_progress(session_id, actor_id)

    async def navigate_session_page(
        self,
        session_id: UUID,
        actor_id: UUID,
        payload: ReadingPageNavigationCreate,
    ) -> ReadingSessionPageProgressDTO:
        await self.require_parent(actor_id)
        session = await self.repository.session_for_update(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)
        if session.State in ("COMPLETED", "FINISHED", "ABORTED"):
            raise HTTPException(status_code=409, detail="A finished session cannot change its current page")

        rows = await self.repository.session_page_rows(session.Id)
        if not rows:
            page = await self.get_session_page(session_id, actor_id)
            if payload.target_page_id != page.page_id:
                raise HTTPException(status_code=409, detail="Legacy session is limited to its selected page")
            return await self.get_session_progress(session_id, actor_id)

        target = next((row for row in rows if row.PageId == payload.target_page_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail="Page is outside this reading session's selected range")
        current_id = session.CurrentPageId or next(
            (row.PageId for row in rows if row.Status == "IN_PROGRESS"),
            rows[0].PageId,
        )
        current = next((row for row in rows if row.PageId == current_id), None)
        if current is None:
            raise HTTPException(status_code=409, detail="Saved current page is not in this reading session")
        if current.PageId == target.PageId:
            return await self.get_session_progress(session_id, actor_id)

        now = datetime.now(timezone.utc)
        if target.PageOrder == current.PageOrder + 1:
            # Explicitly continuing to the next page is the completion action.
            # Merely opening or revisiting a page is not completion.
            current.Status = "COMPLETED"
            current.CompletedAt = current.CompletedAt or now
        elif current.Status == "IN_PROGRESS":
            current.Status = "PENDING"

        if target.Status == "PENDING":
            target.Status = "IN_PROGRESS"
            target.StartedAt = target.StartedAt or now
        session.CurrentPageId = target.PageId
        await self.repository.save_session_progress(session, rows)
        return await self.get_session_progress(session_id, actor_id)

    async def _build_page_dto(self, page: BookPage, revision) -> ReadingPageDTO:
        text_content = (revision.VerifiedText or "").strip()
        if not text_content:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "The verified page does not contain reading text.",
                },
            )

        word_rows = await self.repository.revision_words(revision.Id)
        words: list[ReadingPageWordDTO] = []
        confidence_scores: list[float] = []
        confidence_complete = True
        for row in word_rows:
            box = self._valid_bbox(row.BoundingBox)
            if box is None or not row.Text.strip():
                continue
            x, y, width, height = box
            raw_confidence = row.OCRConfidence
            numeric_confidence = float("nan")
            if raw_confidence is not None:
                try:
                    numeric_confidence = float(raw_confidence)
                except (TypeError, ValueError):
                    pass
            if math.isfinite(numeric_confidence) and 0.0 <= numeric_confidence <= 1.0:
                confidence_scores.append(numeric_confidence)
            else:
                confidence_complete = False
            words.append(
                ReadingPageWordDTO(
                    word_id=row.Id,
                    word_index=row.WordIndex,
                    text=row.Text,
                    bbox=(x, y, width, height),
                    line_index=max(0, int(getattr(row, "LineIndex", 0) or 0)),
                )
            )

        if not words:
            # Never invent fake normalized boxes for missing OCR alignment.
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "The verified page has no valid word-position data. Ask an administrator to review the page.",
                },
            )

        image_url = None
        if page.ImagePath:
            try:
                image_url = create_signed_image_url(page.ImagePath)
            except Exception:
                # Keep reading text available if Storage preview URLs are temporarily unavailable.
                image_url = None

        processing_meta = getattr(revision, "ProcessingMeta", None)
        if not isinstance(processing_meta, dict):
            processing_meta = {}

        def safe_line_indices(name: str) -> list[int]:
            value = processing_meta.get(name, [])
            if not isinstance(value, (list, tuple)):
                return []
            return sorted({
                item for item in value
                if isinstance(item, int) and not isinstance(item, bool) and item >= 0
            })

        return ReadingPageDTO(
            page_id=page.Id,
            page_revision_id=revision.Id,
            page_number=page.PageNumber,
            confidence=(
                sum(confidence_scores) / len(confidence_scores)
                if confidence_complete and len(confidence_scores) == len(words)
                else None
            ),
            width=int(page.Width),
            height=int(page.Height),
            image_url=image_url,
            text=text_content,
            words=words,
            paragraph_start_line_indices=safe_line_indices("paragraph_start_line_indices"),
            indented_line_indices=safe_line_indices("indented_line_indices"),
        )
