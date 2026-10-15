from __future__ import annotations

import math
from datetime import timezone
from uuid import UUID

from fastapi import HTTPException, status

from app.models import BookPage, ReadingSession
from app.repositories.reading_content_repository import ReadingContentRepository
from app.schemas.reading import (
    ReadingPageDTO,
    ReadingPageWordDTO,
    ReadingSessionCreate,
    SessionSummaryRead,
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
                        "message": "The selected page is not an active, verified reading page.",
                    },
                )
        else:
            page = await self.repository.first_verified_page(book_id)
            if page is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "This book has no active page verified by an administrator.",
                    },
                )

        # Starting a reading session must only reference the page's current
        # verified revision. Never silently select a draft or create page data.
        current_revision_id = page.CurrentVerifiedRevisionId
        if current_revision_id is None or (
            requested_revision_id is not None
            and requested_revision_id != current_revision_id
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "The requested revision is not the current verified revision.",
                },
            )
        revision = await self.repository.verified_revision(page.Id, current_revision_id)
        if revision is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "The page's verified revision is unavailable.",
                },
            )
        if not (revision.VerifiedText or "").strip():
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONTENT_NOT_READY",
                    "message": "The verified revision does not contain reading text.",
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
                    "message": "The verified revision has no valid word-position data.",
                },
            )

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

        session = ReadingSession(
            ChildId=child_id,
            BookId=book_id,
            SelectedPageId=page.Id,
            SelectedPageRevisionId=revision.Id,
            State=state_mapping[state],
            Mode=mode,
            ClientMeta=payload.ClientMeta or {},
        )
        return await self.repository.create_session(session)

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

        page = None
        if session.SelectedPageId is not None:
            page = await self.repository.verified_page(
                session.SelectedPageId,
                session.BookId,
            )
            if page is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "The selected page is no longer an active, verified reading page.",
                    },
                )
        else:
            # Legacy sessions without a selection may use the first verified
            # page; never fall back to an arbitrary unverified page.
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

    async def get_page(self, page_id: UUID, actor_id: UUID) -> ReadingPageDTO:
        await self.require_parent(actor_id)
        page = await self.repository.verified_page(page_id)
        if page is None:
            raise HTTPException(
                status_code=404,
                detail="Active verified reading page not found",
            )
        revision = await self.repository.verified_revision(
            page.Id,
            page.CurrentVerifiedRevisionId,
        )
        if revision is None:
            raise HTTPException(status_code=409, detail="Verified page revision is unavailable")
        return await self._build_page_dto(page, revision)

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
        for row in word_rows:
            box = self._valid_bbox(row.BoundingBox)
            if box is None or not row.Text.strip():
                continue
            x, y, width, height = box
            raw_confidence = row.OCRConfidence
            if raw_confidence is not None:
                try:
                    numeric_confidence = float(raw_confidence)
                except (TypeError, ValueError):
                    numeric_confidence = float("nan")
                if math.isfinite(numeric_confidence) and 0.0 <= numeric_confidence <= 1.0:
                    confidence_scores.append(numeric_confidence)
            words.append(
                ReadingPageWordDTO(
                    word_id=row.Id,
                    word_index=row.WordIndex,
                    text=row.Text,
                    bbox=(x, y, width, height),
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

        return ReadingPageDTO(
            page_id=page.Id,
            page_revision_id=revision.Id,
            page_number=page.PageNumber,
            confidence=(sum(confidence_scores) / len(confidence_scores)) if confidence_scores else None,
            width=int(page.Width),
            height=int(page.Height),
            image_url=image_url,
            text=text_content,
            words=words,
        )
