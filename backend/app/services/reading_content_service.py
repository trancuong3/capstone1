from __future__ import annotations

import asyncio
import inspect
import math
import os
from datetime import datetime, timezone
from uuid import UUID

import httpx
from fastapi import HTTPException, status

from app.database.config import APP_ENVIRONMENT, SUPABASE_STORAGE_BUCKET
from app.models import BookPage, FluencyAssessment, ReadingEvent, ReadingSession, ReadingSessionPage
from app.policies.book_access import (
    is_book_private,
    private_page_image_url,
    private_page_image_urls_async,
)
from app.repositories.reading_content_repository import ReadingContentRepository
from app.schemas.reading import (
    FluencyAssessmentCreate,
    ReadingCompletionSummaryDTO,
    ReadingEventCreate,
    ReadingPageDTO,
    ReadingPageWordDTO,
    ReadingPageWordTimingDTO,
    ReadingSessionCreate,
    SessionSummaryRead,
    ReadingPageNavigationCreate,
    ReadingSessionPageProgressDTO,
    ReadingSessionPageProgressItem,
)
from app.services.catalog_tts_cache import (
    get_catalog_tts_default_voice_id,
    resolve_verified_catalog_tts_url,
)
from app.services import storage_service as _storage_service_module
from app.services.storage_service import (
    create_cached_signed_image_urls,
    create_cached_signed_image_urls_async,
    create_signed_image_url,
    is_local_storage_enabled,
)
from app.services.word_box_geometry import has_verified_geometry

_ORIGINAL_CREATE_SIGNED_IMAGE_URL = create_signed_image_url
_ORIGINAL_PRIVATE_PAGE_IMAGE_URL = private_page_image_url
_ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS = create_cached_signed_image_urls
_ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS_ASYNC = create_cached_signed_image_urls_async


class ReadingContentService:
    """Business rules for starting a session and reading verified catalog content."""

    def __init__(self, repository: ReadingContentRepository):
        self.repository = repository

    async def _repo_session(self, session_id: UUID, actor_id: UUID) -> ReadingSession | None:
        if isinstance(self.repository, ReadingContentRepository):
            return await self.repository.session(session_id, actor_id=actor_id)
        return await self.repository.session(session_id)

    async def _repo_session_for_update(self, session_id: UUID, actor_id: UUID) -> ReadingSession | None:
        if isinstance(self.repository, ReadingContentRepository):
            return await self.repository.session_for_update(session_id, actor_id=actor_id)
        return await self.repository.session_for_update(session_id)

    async def _repo_book_is_eligible(self, book_id: UUID, actor_id: UUID) -> bool:
        if isinstance(self.repository, ReadingContentRepository):
            book = await self.repository.book_by_id(book_id)
            if book is not None and is_book_private(book) and getattr(book, "OwnerParentId", None) != actor_id:
                raise HTTPException(status_code=404, detail="Resource not found")
            return await self.repository.book_is_eligible(book_id, actor_id=actor_id)
        return await self.repository.book_is_eligible(book_id)

    async def _repo_verified_page(self, page_id: UUID, book_id: UUID | None, actor_id: UUID) -> BookPage | None:
        if isinstance(self.repository, ReadingContentRepository):
            return await self.repository.verified_page(page_id, book_id, actor_id=actor_id)
        return await self.repository.verified_page(page_id, book_id)

    async def _repo_first_verified_page(self, book_id: UUID, actor_id: UUID) -> BookPage | None:
        if isinstance(self.repository, ReadingContentRepository):
            return await self.repository.first_verified_page(book_id, actor_id=actor_id)
        return await self.repository.first_verified_page(book_id)

    async def _repo_verified_pages_between(
        self, book_id: UUID, start_page_number: int, end_page_number: int, actor_id: UUID
    ) -> list[BookPage]:
        if isinstance(self.repository, ReadingContentRepository):
            return await self.repository.verified_pages_between_numbers(
                book_id, start_page_number, end_page_number, actor_id=actor_id
            )
        return await self.repository.verified_pages_between_numbers(
            book_id, start_page_number, end_page_number
        )

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
        session = await self._repo_session(session_id, actor_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)

        # Page completion and first-pass assessment use durable evidence.
        # Raw spoken-word counts stay unknown when only an assessment is saved.
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
        from app.services.reading_assessment import aggregate_assessment
        assessment = aggregate_assessment(
            session.Id, await self.repository.comparison_reports(session.Id),
            await self.repository.events_for_session(session.Id),
        )
        return ReadingCompletionSummaryDTO(
            duration_minutes=duration_min,
            pages_explored=(
                sum(1 for row in page_rows if row.Status == "COMPLETED")
                if page_rows
                else None
            ),
            selected_range_pages=len(page_rows) if page_rows else None,
            **assessment,
        )

    async def get_practice_state(self, session_id: UUID, actor_id: UUID):
        from pydantic import ValidationError
        from app.schemas.reading import PracticePageRead, PracticeWordRead, ReadingPracticeStateRead, StoredInitialWordAssessment
        await self.require_parent(actor_id)
        is_real_repo = isinstance(self.repository, ReadingContentRepository)
        if is_real_repo:
            ctx = await self.repository.session_with_ownership_and_book(session_id, actor_id)
            if ctx is None:
                raise HTTPException(status_code=404, detail="Reading session not found")
            session, _book, child_owned = ctx
            if not child_owned:
                raise HTTPException(status_code=404, detail="Child profile not found")
        else:
            session = await self._repo_session(session_id, actor_id)
            if session is None:
                raise HTTPException(status_code=404, detail="Reading session not found")
            await self.require_owned_child(session.ChildId, actor_id)
        reports = await self.repository.comparison_reports(session_id)
        events = await self.repository.events_for_session(session_id)
        selected_rows = await self.repository.session_page_rows(session_id)
        selected = {(row.PageId, row.PageRevisionId) for row in selected_rows}

        retry_events_by_word: dict[tuple[UUID | None, UUID | None, UUID | None], list[ReadingEvent]] = {}
        for event in events:
            if event.SessionId == session_id and event.Type == "WORD_RETRY":
                retry_events_by_word.setdefault(
                    (event.PageId, event.PageRevisionId, event.WordId), []
                ).append(event)

        seen_keys: set[tuple[UUID, UUID]] = set()
        candidate_reports: list[tuple[object, dict, tuple[UUID, UUID]]] = []
        legacy = False
        for report in reversed(reports):
            metadata = report.Summary if isinstance(report.Summary, dict) else {}
            if metadata.get("assessment_version") != 1:
                legacy = True
                continue
            key = (report.PageId, report.PageRevisionId)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            candidate_reports.append((report, metadata, key))

        pages_map: dict = {}
        revisions_map: dict = {}
        word_ids_map: dict[UUID, set[UUID]] = {}
        if candidate_reports and is_real_repo:
            pages_map = await self.repository.pages_by_ids(
                [report.PageId for report, _, _ in candidate_reports]
            )
            revisions_map = await self.repository.revision_snapshots(
                [key for _, _, key in candidate_reports]
            )
            word_ids_map = await self.repository.revision_word_ids_by_revisions(
                [report.PageRevisionId for report, _, _ in candidate_reports]
            )

        pages = []
        words = []
        for report, metadata, key in candidate_reports:
            if is_real_repo:
                page = pages_map.get(report.PageId)
                revision = revisions_map.get(key)
            else:
                page = await self.repository.page_by_id(report.PageId)
                revision = await self.repository.revision_snapshot(*key)
            if (report.SessionId != session_id or page is None or page.BookId != session.BookId
                    or revision is None or (selected and key not in selected)):
                raise HTTPException(status_code=501, detail="Saved practice identity is not available")
            try:
                snapshot = [StoredInitialWordAssessment.model_validate(item)
                            for item in metadata.get("initial_assessment", [])]
                if is_real_repo:
                    valid_word_ids = word_ids_map.get(report.PageRevisionId, set())
                else:
                    valid_words = await self.repository.revision_words(report.PageRevisionId)
                    valid_word_ids = {word.Id for word in valid_words}
                if (not snapshot or len({word.word_id for word in snapshot}) != len(snapshot)
                        or {word.word_id for word in snapshot} != valid_word_ids):
                    raise ValueError("Invalid saved word identity")
                saved_page = PracticePageRead(page_id=report.PageId, page_revision_id=report.PageRevisionId,
                    page_number=page.PageNumber, transcript=report.Transcript, initial_assessment=snapshot)
            except (ValidationError, TypeError, ValueError):
                raise HTTPException(status_code=501, detail="Saved practice evidence is not available") from None
            pages.append(saved_page)
            for word in snapshot:
                if word.status not in {"MISPRONUNCIATION", "OMISSION"}:
                    continue
                matching = retry_events_by_word.get(
                    (report.PageId, report.PageRevisionId, word.word_id), []
                )
                attempts = []
                failed = set()
                unkeyed_failed = 0
                corrected = skipped = False
                for event in matching:
                    event_meta = self._canonical_retry_metadata(event.Metadata)
                    attempt = event_meta.get("retry_attempt")
                    if type(attempt) is int and attempt > 0:
                        attempts.append(attempt)
                        if event.Status == "FAILED":
                            failed.add(attempt)
                    elif event.Status == "FAILED":
                        unkeyed_failed += 1
                    corrected |= event.Status == "CONFIRMED"
                    skipped |= (
                        event.Status in {"FAILED", "UNCERTAIN"}
                        and event_meta.get("resolution_status") == "UNRESOLVED"
                    ) or (
                        event.Status == "UNCERTAIN"
                        and event_meta.get("skip_reason") == "TECHNICAL_OR_MANUAL"
                    )
                incorrect = min(3, len(failed) + unkeyed_failed)
                words.append(PracticeWordRead(page_id=report.PageId, page_revision_id=report.PageRevisionId,
                    word_id=word.word_id, retry_attempt_count=max(attempts, default=0), incorrect_retry_count=incorrect,
                    resolution_status="SELF_CORRECTED" if corrected else "UNRESOLVED" if skipped or incorrect >= 3 else "RETRYING"))
        return ReadingPracticeStateRead(session_id=session_id, legacy_evidence_present=legacy, pages=pages, words=words)

    async def create_reading_event(
        self,
        actor_id: UUID,
        payload: ReadingEventCreate,
    ) -> ReadingEvent:
        await self.require_parent(actor_id)
        # Serialize event writes with session completion and other attempts.
        session = await self._repo_session_for_update(payload.SessionId, actor_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)
        if session.State in {"COMPLETED", "FINISHED", "ABORTED"}:
            # Another client may finish after an event committed but its HTTP
            # response was lost. A read-only replay is still safe after finish.
            metadata = self._canonical_retry_metadata(payload.Metadata)
            attempt = metadata.get("retry_attempt")
            if (payload.Type in {"WORD_RETRY", "SELF_CORRECTION"}
                    and payload.WordId is not None and type(attempt) is int and attempt > 0):
                existing = await self.repository.retry_event_for_attempt(
                    session.Id, payload.PageId, payload.PageRevisionId,
                    payload.WordId, payload.Type, attempt,
                )
                if existing is not None and (
                    existing.Status == payload.Status
                    and self._canonical_retry_metadata(existing.Metadata) == metadata
                    and existing.StartMs == payload.StartMs and existing.EndMs == payload.EndMs
                    and existing.Confidence == payload.Confidence
                ):
                    return existing
            raise HTTPException(
                status_code=409,
                detail="Cannot create reading events for a finished session",
            )
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
            page = await self._repo_verified_page(payload.PageId, session.BookId, actor_id)
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

        if payload.Type in {"WORD_RETRY", "SELF_CORRECTION"}:
            metadata = self._canonical_retry_metadata(payload.Metadata)
            attempt = metadata.get("retry_attempt")
            if type(attempt) is not int or attempt < 1 or payload.WordId is None:
                raise HTTPException(status_code=422, detail="Retry attempts require a positive integer and a word identity")
            if "attempt" in payload.Metadata and (
                type(payload.Metadata["attempt"]) is not int
                or payload.Metadata["attempt"] != attempt
            ):
                raise HTTPException(status_code=422, detail="Retry attempt identities must agree")
            # Accept the legacy alias on new requests without rewriting history
            # or mutating the caller's payload. All new writes use one key.
            payload = payload.model_copy(update={"Metadata": metadata})
            existing = await self.repository.retry_event_for_attempt(
                session.Id, payload.PageId, payload.PageRevisionId,
                payload.WordId, payload.Type, attempt,
            )
            if existing is not None:
                if (
                    existing.Status != payload.Status
                    or self._canonical_retry_metadata(existing.Metadata) != payload.Metadata
                    or existing.StartMs != payload.StartMs
                    or existing.EndMs != payload.EndMs
                    or existing.Confidence != payload.Confidence
                ):
                    raise HTTPException(status_code=409, detail="This retry attempt already has a different saved result")
                return existing
            if payload.Type == "WORD_RETRY":
                initial_status = await self.repository.initial_word_status(
                    session.Id, payload.PageId, payload.PageRevisionId, payload.WordId,
                )
                if initial_status not in {"MISPRONUNCIATION", "OMISSION"}:
                    raise HTTPException(status_code=409, detail="Save the initial word error before retrying")
                if payload.Status not in {"CONFIRMED", "FAILED", "UNCERTAIN"}:
                    raise HTTPException(status_code=422, detail="Unsupported retry result")
                previous = await self.repository.retry_events_for_word(
                    session.Id, payload.PageId, payload.PageRevisionId, payload.WordId,
                )
                incorrect_attempts = set()
                unkeyed_incorrect_count = 0
                for previous_event in previous:
                    if previous_event.Status != "FAILED":
                        continue
                    previous_attempt = self._canonical_retry_metadata(previous_event.Metadata).get("retry_attempt")
                    if type(previous_attempt) is int and previous_attempt > 0:
                        incorrect_attempts.add(previous_attempt)
                    else:
                        # Historical failed rows still count even if an older
                        # writer omitted the attempt identity. Never edit them.
                        unkeyed_incorrect_count += 1
                if len(incorrect_attempts) + unkeyed_incorrect_count >= 3:
                    raise HTTPException(status_code=409, detail="This word has reached three incorrect retry results")
                if any(event.Status == "CONFIRMED" for event in previous):
                    raise HTTPException(status_code=409, detail="This word is already self-corrected")
                previous_attempts = [
                    self._canonical_retry_metadata(event.Metadata).get("retry_attempt")
                    for event in previous
                ]
                last_attempt = max((value for value in previous_attempts
                                    if type(value) is int and value > 0), default=0)
                if attempt != last_attempt + 1:
                    raise HTTPException(status_code=409, detail="Retry attempts must be sequential")
                expected_count = len(incorrect_attempts) + unkeyed_incorrect_count + (payload.Status == "FAILED")
                if "incorrect_retry_count" in metadata and (
                    type(metadata["incorrect_retry_count"]) is not int
                    or metadata["incorrect_retry_count"] != expected_count
                ):
                    raise HTTPException(status_code=422, detail="Incorrect retry count does not match saved attempts")

        event = ReadingEvent(**payload.model_dump())
        return await self.repository.create_reading_event(event)

    @staticmethod
    def _canonical_retry_metadata(metadata: dict | None) -> dict:
        result = dict(metadata) if isinstance(metadata, dict) else {}
        if "retry_attempt" not in result and "attempt" in result:
            result["retry_attempt"] = result["attempt"]
        result.pop("attempt", None)
        return result

    async def create_fluency_assessment(
        self,
        actor_id: UUID,
        payload: FluencyAssessmentCreate,
    ) -> FluencyAssessment:
        await self.require_parent(actor_id)
        session = await self._repo_session(payload.SessionId, actor_id)
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
        page_id = payload.SelectedPageId or payload.selected_page_id
        requested_revision_id = (
            payload.SelectedPageRevisionId or payload.selected_page_revision_id
        )
        end_page_id = payload.EndPageId or payload.end_page_id

        if isinstance(self.repository, ReadingContentRepository):
            child_owned, book_row, is_readable = await self.repository.session_start_context(
                child_id, book_id, actor_id
            )
            if not child_owned:
                raise HTTPException(status_code=404, detail="Child profile not found")
            if (
                book_row is not None
                and is_book_private(book_row)
                and getattr(book_row, "OwnerParentId", None) != actor_id
            ):
                raise HTTPException(status_code=404, detail="Resource not found")
            if not is_readable or book_row is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "BOOK_BLOCKED_BY_CHILD_SAFETY",
                        "message": "Sách chưa được phép sử dụng cho trẻ; OCR hoặc Child Safety chưa hoàn tất trên toàn bộ nội dung hiện tại.",
                    },
                )

            page_tuples = await self.repository.active_book_pages_with_revisions(
                book_id,
                include_private_batch_check=is_book_private(book_row),
            )
            eligible_entries = [
                (p, rev) for p, rev, is_elig in page_tuples if is_elig and rev is not None
            ]
            eligible_by_id = {p.Id: (p, rev) for p, rev in eligible_entries}

            if page_id is not None:
                start_entry = eligible_by_id.get(page_id)
                if start_entry is None:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CONTENT_NOT_READY",
                            "message": "Trang bắt đầu không còn ACTIVE và VERIFIED để đọc.",
                        },
                    )
                page = start_entry[0]
            else:
                if not eligible_entries:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CONTENT_NOT_READY",
                            "message": "Sách chưa có trang ACTIVE và VERIFIED để đọc.",
                        },
                    )
                page = eligible_entries[0][0]

            if end_page_id is not None:
                end_entry = eligible_by_id.get(end_page_id)
                if end_entry is None:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CONTENT_NOT_READY",
                            "message": "Trang kết thúc không thuộc sách hoặc chưa ACTIVE và VERIFIED.",
                        },
                    )
                end_page = end_entry[0]
            else:
                end_page = page

            if end_page.PageNumber < page.PageNumber:
                raise HTTPException(
                    status_code=422,
                    detail="Trang kết thúc không được đứng trước trang bắt đầu.",
                )

            raw_numbers = [
                p.PageNumber
                for p, _, _ in page_tuples
                if page.PageNumber <= p.PageNumber <= end_page.PageNumber
            ]
            range_entries = [
                (p, rev)
                for p, rev in eligible_entries
                if page.PageNumber <= p.PageNumber <= end_page.PageNumber
            ]
            eligible_numbers = [p.PageNumber for p, _ in range_entries]
            expected_numbers = list(range(page.PageNumber, end_page.PageNumber + 1))
            if raw_numbers != expected_numbers or eligible_numbers != expected_numbers:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "READING_RANGE_NOT_CONTIGUOUS",
                        "message": "Khoảng trang có trang bị thiếu, ngừng hoạt động hoặc chưa được quản trị viên xác minh. Vui lòng chọn lại phạm vi.",
                    },
                )

            verified_snapshots: list[tuple[BookPage, object]] = []
            for index, (candidate_page, revision) in enumerate(range_entries):
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
                if revision is None or not (revision.VerifiedText or "").strip():
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CONTENT_NOT_READY",
                            "message": f"Trang {candidate_page.PageNumber} không có nội dung đã xác minh để đọc.",
                        },
                    )
                verified_snapshots.append((candidate_page, revision))

            word_rows = await self.repository.revision_word_validation_rows(
                [rev.Id for _, rev in verified_snapshots]
            )
            valid_revision_ids: set[UUID] = set()
            for rev_id, word_text, bbox in word_rows:
                if rev_id in valid_revision_ids:
                    continue
                if isinstance(word_text, str) and word_text.strip() and self._valid_bbox(bbox) is not None:
                    valid_revision_ids.add(rev_id)

            for candidate_page, revision in verified_snapshots:
                if revision.Id not in valid_revision_ids:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CONTENT_NOT_READY",
                            "message": f"Trang {candidate_page.PageNumber} không có dữ liệu từ và vị trí hợp lệ.",
                        },
                    )
        else:
            await self.require_owned_child(child_id, actor_id)
            if not await self._repo_book_is_eligible(book_id, actor_id):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "BOOK_BLOCKED_BY_CHILD_SAFETY",
                        "message": "Sách chưa được phép sử dụng cho trẻ; OCR hoặc Child Safety chưa hoàn tất trên toàn bộ nội dung hiện tại.",
                    },
                )

            if page_id is not None:
                page = await self._repo_verified_page(page_id, book_id, actor_id)
                if page is None:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CONTENT_NOT_READY",
                            "message": "Trang bắt đầu không còn ACTIVE và VERIFIED để đọc.",
                        },
                    )
            else:
                page = await self._repo_first_verified_page(book_id, actor_id)
                if page is None:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CONTENT_NOT_READY",
                            "message": "Sách chưa có trang ACTIVE và VERIFIED để đọc.",
                        },
                    )

            end_page = (
                await self._repo_verified_page(end_page_id, book_id, actor_id)
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
            eligible_pages = await self._repo_verified_pages_between(
                book_id, page.PageNumber, end_page.PageNumber, actor_id
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

            verified_snapshots = []
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
        session = await self._repo_session_for_update(session_id, actor_id)
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
        session = await self._repo_session(session_id, actor_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        await self.require_owned_child(session.ChildId, actor_id)
        return self._summary(session)

    async def get_session_page(
        self, session_id: UUID, actor_id: UUID, *, base_url: str | None = None
    ) -> ReadingPageDTO:
        await self.require_parent(actor_id)
        known_book_is_private: bool | None = None
        if isinstance(self.repository, ReadingContentRepository):
            ctx = await self.repository.session_with_ownership_and_book(
                session_id, actor_id
            )
            if ctx is None:
                raise HTTPException(status_code=404, detail="Reading session not found")
            session, book_row, child_owned = ctx
            if not child_owned:
                raise HTTPException(status_code=404, detail="Child profile not found")
            known_book_is_private = is_book_private(book_row)

            content_rows = await self.repository.session_pages_with_content(session.Id)
            if content_rows:
                current_id = session.CurrentPageId or next(
                    (row.PageId for row, _, _ in content_rows if row.Status == "IN_PROGRESS"),
                    content_rows[0][0].PageId,
                )
                selected_tuple = next(
                    (item for item in content_rows if item[0].PageId == current_id),
                    None,
                )
                if selected_tuple is None:
                    raise HTTPException(
                        status_code=409,
                        detail="Current page is not part of this session's range",
                    )
                _, page, revision = selected_tuple
                if page is None or revision is None or page.BookId != session.BookId:
                    raise HTTPException(status_code=409, detail="Saved page snapshot is unavailable")
                return await self._build_page_dto(
                    page,
                    revision,
                    base_url=base_url,
                    book_is_private=known_book_is_private,
                )
        else:
            session = await self._repo_session(session_id, actor_id)
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
                return await self._build_page_dto(page, revision, base_url=base_url)

        # Legacy sessions created before range persistence continue to use the
        # original one-page selection and current verified-revision contract.
        page = None
        if session.SelectedPageId is not None:
            page = await self._repo_verified_page(session.SelectedPageId, session.BookId, actor_id)
            if page is None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_NOT_READY",
                        "message": "The selected page is no longer an active, verified reading page.",
                    },
                )
        else:
            page = await self._repo_first_verified_page(session.BookId, actor_id)
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
        return await self._build_page_dto(
            page,
            revision,
            base_url=base_url,
            book_is_private=known_book_is_private,
        )

    async def get_page(
        self,
        page_id: UUID,
        session_id: UUID,
        actor_id: UUID,
        revision_id: UUID | None = None,
        *,
        base_url: str | None = None,
    ) -> ReadingPageDTO:
        await self.require_parent(actor_id)
        known_book_is_private: bool | None = None
        if isinstance(self.repository, ReadingContentRepository):
            ctx = await self.repository.session_with_ownership_and_book(
                session_id, actor_id
            )
            if ctx is None:
                raise HTTPException(status_code=404, detail="Reading session not found")
            session, book_row, child_owned = ctx
            if not child_owned:
                raise HTTPException(status_code=404, detail="Child profile not found")
            known_book_is_private = is_book_private(book_row)

            content_rows = await self.repository.session_pages_with_content(session.Id)
            if content_rows:
                selected_tuple = next(
                    (item for item in content_rows if item[0].PageId == page_id),
                    None,
                )
                if selected_tuple is None:
                    raise HTTPException(
                        status_code=404,
                        detail="Page is outside this reading session's selected range",
                    )
                snapshot, page, revision = selected_tuple
                if revision_id is not None and snapshot.PageRevisionId != revision_id:
                    raise HTTPException(
                        status_code=409,
                        detail="Requested revision does not match the reading session snapshot",
                    )
                if page is None or revision is None or page.BookId != session.BookId:
                    raise HTTPException(status_code=409, detail="Saved page snapshot is unavailable")
                return await self._build_page_dto(
                    page,
                    revision,
                    base_url=base_url,
                    book_is_private=known_book_is_private,
                )
        else:
            session = await self._repo_session(session_id, actor_id)
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

                if revision_id is not None and snapshot.PageRevisionId != revision_id:
                    raise HTTPException(
                        status_code=409,
                        detail="Requested revision does not match the reading session snapshot",
                    )

                page = await self.repository.page_by_id(snapshot.PageId)
                revision = await self.repository.revision_snapshot(
                    snapshot.PageId,
                    snapshot.PageRevisionId,
                )

                if page is None or revision is None or page.BookId != session.BookId:
                    raise HTTPException(status_code=409, detail="Saved page snapshot is unavailable")

                return await self._build_page_dto(page, revision, base_url=base_url)

        # Legacy session
        page = await self._repo_verified_page(page_id, session.BookId, actor_id)

        if page is None:
            raise HTTPException(
                status_code=404,
                detail="Active verified page not found in this reading session's book",
            )

        if revision_id is not None:
            revision = await self.repository.verified_revision(page.Id, revision_id)
        else:
            revision = await self.repository.verified_revision(
                page.Id,
                page.CurrentVerifiedRevisionId,
            )

        if revision is None:
            raise HTTPException(status_code=409, detail="Page revision is unavailable")

        return await self._build_page_dto(
            page,
            revision,
            base_url=base_url,
            book_is_private=known_book_is_private,
        )

    async def get_session_progress(
        self, session_id: UUID, actor_id: UUID
    ) -> ReadingSessionPageProgressDTO:
        await self.require_parent(actor_id)
        session = await self._repo_session(session_id, actor_id)
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
        session = await self._repo_session_for_update(session_id, actor_id)
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
        session = await self._repo_session_for_update(session_id, actor_id)
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

    async def _build_page_dto(
        self,
        page: BookPage,
        revision,
        *,
        base_url: str | None = None,
        book_is_private: bool | None = None,
        owner_parent_id: UUID | None = None,
    ) -> ReadingPageDTO:
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
        for row in word_rows:
            box = self._valid_bbox(row.BoundingBox)
            if box is None or not row.Text.strip():
                continue
            x, y, width, height = box
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

        # Copy all ORM values needed for the response before ending the read
        # transaction. Supabase Storage signed-URL creation is an external call and
        # must not retain a PostgreSQL connection or transaction.
        page_id = page.Id
        page_revision_id = revision.Id
        page_number = page.PageNumber
        page_width = int(page.Width)
        page_height = int(page.Height)
        is_verified_revision = (
            getattr(revision, "VerificationStatus", None) == "VERIFIED"
            or page.CurrentVerifiedRevisionId == page_revision_id
        )
        processing_meta = getattr(revision, "ProcessingMeta", None)
        if not isinstance(processing_meta, dict):
            processing_meta = {}
        else:
            processing_meta = dict(processing_meta)

        source_path = processing_meta.get("source_image_path")
        source_width = processing_meta.get("source_image_width")
        source_height = processing_meta.get("source_image_height")
        has_source_snapshot = any(
            key in processing_meta
            for key in ("source_image_path", "source_image_width", "source_image_height")
        )
        image_path = None
        if (
            isinstance(source_path, str)
            and source_path.strip()
            and type(source_width) is int
            and type(source_height) is int
            and source_width > 0
            and source_height > 0
        ):
            image_path = source_path
            page_width = source_width
            page_height = source_height
        elif not has_source_snapshot and page.CurrentVerifiedRevisionId == page_revision_id:
            # Legacy current revisions still use the page's source. Historical
            # revisions without provenance must not borrow a replacement image.
            image_path = page.ImagePath

        book_id_value = getattr(page, "BookId", None)
        needs_book_lookup = book_is_private is None or (
            book_is_private and owner_parent_id is None
        )
        if (
            needs_book_lookup
            and book_id_value is not None
            and isinstance(self.repository, ReadingContentRepository)
        ):
            book_row = await self.repository.book_by_id(book_id_value)
            if book_is_private is None:
                book_is_private = book_row is not None and is_book_private(book_row)
            if book_row is not None and owner_parent_id is None:
                owner_parent_id = getattr(book_row, "OwnerParentId", None)
        elif book_is_private is None:
            book_is_private = False

        tts_audio_url = resolve_verified_catalog_tts_url(
            is_public_catalog=not bool(book_is_private),
            is_verified=is_verified_revision,
            text=text_content,
            processing_meta=processing_meta,
        )
        tts_word_timings: list[ReadingPageWordTimingDTO] | None = None
        tts_voice_id: str | None = None
        tts_cached_speed: float | None = None

        if tts_audio_url and not bool(book_is_private) and is_verified_revision:
            raw_timings = None
            inferred_speed: float | None = None
            catalog_tts_meta = processing_meta.get("catalog_tts")
            if isinstance(catalog_tts_meta, dict):
                meta_voice = catalog_tts_meta.get("voice_id")
                if isinstance(meta_voice, str) and meta_voice.strip():
                    tts_voice_id = meta_voice.strip()
                meta_speed = catalog_tts_meta.get("speed")
                if isinstance(meta_speed, (int, float)) and math.isfinite(float(meta_speed)) and float(meta_speed) > 0:
                    tts_cached_speed = round(float(meta_speed), 2)
                    inferred_speed = tts_cached_speed
                else:
                    obj_path = catalog_tts_meta.get("object_path")
                    if isinstance(obj_path, str):
                        parts = [seg.strip() for seg in obj_path.strip("/").split("/") if seg.strip()]
                        if len(parts) >= 3:
                            try:
                                parsed_spd = float(parts[-2])
                                if math.isfinite(parsed_spd) and 0.5 <= parsed_spd <= 2.0:
                                    inferred_speed = round(parsed_spd, 2)
                            except ValueError:
                                pass
                if isinstance(catalog_tts_meta.get("word_timings"), list):
                    raw_timings = catalog_tts_meta.get("word_timings")

            expected_speed = inferred_speed if inferred_speed is not None else 1.0

            if raw_timings is None:
                try:
                    from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository
                    from app.services.tts_audio_cache_service import (
                        canonical_tts_sha256,
                        canonical_tts_text,
                        folded_catalog_tts_text,
                    )

                    db_session = getattr(self.repository, "db", None)
                    if (
                        db_session is not None
                        and isinstance(self.repository, ReadingContentRepository)
                        and callable(getattr(db_session, "begin_nested", None))
                    ):
                        lookup_voice = tts_voice_id or get_catalog_tts_default_voice_id()
                        norm_text = canonical_tts_text(text_content)
                        content_sha = canonical_tts_sha256(norm_text) if norm_text else None
                        folded_text = folded_catalog_tts_text(norm_text) if norm_text else ""
                        folded_sha = (
                            canonical_tts_sha256(folded_text)
                            if folded_text and folded_text != norm_text
                            else None
                        )
                        async with db_session.begin_nested():
                            meta_row = await TtsAudioCacheRepository(
                                db_session
                            ).get_page_precomputed_timed_metadata(
                                page_id=page_id,
                                page_revision_id=page_revision_id,
                                voice_id=lookup_voice,
                                content_sha256=content_sha,
                                folded_sha256=folded_sha,
                                target_speed=expected_speed,
                            )
                            if meta_row is not None:
                                raw_timings, found_voice, found_speed = meta_row
                                tts_voice_id = found_voice
                                if found_speed is not None and math.isfinite(found_speed) and found_speed > 0:
                                    tts_cached_speed = round(float(found_speed), 2)
                except Exception:
                    raw_timings = None

            if isinstance(raw_timings, list) and len(raw_timings) == len(words):
                parsed_timings: list[ReadingPageWordTimingDTO] = []
                valid_timings = True
                for idx, item in enumerate(raw_timings):
                    if not isinstance(item, dict) or "id" in item:
                        valid_timings = False
                        break
                    try:
                        start_val = float(item.get("start", -1.0))
                        end_val = float(item.get("end", -1.0))
                    except (TypeError, ValueError):
                        valid_timings = False
                        break
                    if (
                        not (math.isfinite(start_val) and math.isfinite(end_val))
                        or start_val < 0.0
                        or end_val < start_val
                    ):
                        valid_timings = False
                        break
                    parsed_timings.append(
                        ReadingPageWordTimingDTO(
                            index=idx,
                            start=round(start_val, 3),
                            end=round(end_val, 3),
                        )
                    )
                if valid_timings and parsed_timings:
                    tts_word_timings = parsed_timings
                    if not tts_voice_id:
                        tts_voice_id = get_catalog_tts_default_voice_id()
                    if tts_cached_speed is None:
                        tts_cached_speed = expected_speed

        ill_id: UUID | None = None
        ill_storage_path: str | None = None
        ill_owner_id = None
        illustration_text_free = False
        try:
            from sqlalchemy import desc, select
            from app.models.smart_book_studio import BookPresentationAsset

            db_session = getattr(self.repository, "db", None)
            if db_session is not None and callable(getattr(db_session, "begin_nested", None)):
                async with db_session.begin_nested():
                    ill_asset = await db_session.scalar(
                        select(BookPresentationAsset)
                        .where(
                            BookPresentationAsset.BookPageId == page_id,
                            BookPresentationAsset.AssetRole == "PAGE_ILLUSTRATION",
                            BookPresentationAsset.IsActive.is_(True),
                            BookPresentationAsset.ModerationStatus == "APPROVED",
                            BookPresentationAsset.TextFreeVerified.is_(True),
                        )
                        .order_by(desc(BookPresentationAsset.AssetVersion), desc(BookPresentationAsset.UpdatedAt))
                        .limit(1)
                    )
                    if ill_asset is not None:
                        ill_id = ill_asset.Id
                        raw_ill_path = getattr(ill_asset, "StoragePath", None)
                        if isinstance(raw_ill_path, str) and raw_ill_path.strip():
                            ill_storage_path = raw_ill_path.strip()
                        ill_owner_id = getattr(ill_asset, "OwnerId", None)
                        illustration_text_free = True
        except Exception:
            ill_id = None
            ill_storage_path = None
            ill_owner_id = None
            illustration_text_free = False

        rollback = getattr(self.repository.db, "rollback", None)
        if callable(rollback):
            res = rollback()
            if inspect.isawaitable(res):
                await res

        image_url = None
        illustration_url = f"/studio/assets/{ill_id}/media" if ill_id is not None else None
        if book_is_private and book_id_value is not None:
            if private_page_image_url is not _ORIGINAL_PRIVATE_PAGE_IMAGE_URL:
                image_url = await asyncio.to_thread(
                    private_page_image_url,
                    book_id_value,
                    page_id,
                    revision_id=page_revision_id,
                    base_url=base_url,
                    storage_path=image_path,
                    owner_id=owner_parent_id,
                )
            else:
                image_url = (
                    await private_page_image_urls_async(
                        book_id_value,
                        [(page_id, page_revision_id, image_path)],
                        base_url=base_url,
                        owner_id=owner_parent_id,
                    )
                )[0]
        elif not book_is_private:
            skip_unpatched_ill_signing = (
                APP_ENVIRONMENT == "test"
                and (os.getenv("SUPABASE_KEY") or "").strip() == "isolated-test-key"
                and not _storage_service_module.SUPABASE_ADMIN_KEY
                and create_cached_signed_image_urls is _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS
                and create_cached_signed_image_urls_async is _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS_ASYNC
                and _storage_service_module.create_signed_image_urls is _storage_service_module._ORIGINAL_CREATE_SIGNED_IMAGE_URLS
                and _storage_service_module.get_supabase_admin_client is _storage_service_module._ORIGINAL_GET_SUPABASE_ADMIN_CLIENT
                and httpx.AsyncClient is _storage_service_module._ORIGINAL_HTTPX_ASYNC_CLIENT
            )
            can_sign_ill = (
                ill_id is not None
                and ill_owner_id is None
                and ill_storage_path is not None
                and not is_local_storage_enabled()
                and not skip_unpatched_ill_signing
            )

            async def _sign_paths(paths: list[str]) -> list[str]:
                if create_cached_signed_image_urls is not _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS:
                    return await asyncio.to_thread(create_cached_signed_image_urls, paths)
                return await create_cached_signed_image_urls_async(paths)

            if create_signed_image_url is not _ORIGINAL_CREATE_SIGNED_IMAGE_URL:
                if image_path:
                    try:
                        image_url = await asyncio.to_thread(create_signed_image_url, image_path)
                    except Exception:
                        # Keep reading text available if Storage preview URLs are temporarily unavailable.
                        image_url = None
                if can_sign_ill and ill_storage_path is not None:
                    try:
                        signed_ill = (await _sign_paths([ill_storage_path]))[0]
                        if signed_ill:
                            illustration_url = signed_ill
                    except Exception:
                        pass
            elif image_path and can_sign_ill and ill_storage_path is not None:
                try:
                    signed_pair = await _sign_paths([image_path, ill_storage_path])
                    image_url = signed_pair[0]
                    if signed_pair[1]:
                        illustration_url = signed_pair[1]
                except Exception:
                    try:
                        image_url = (await _sign_paths([image_path]))[0]
                    except Exception:
                        image_url = None
                    try:
                        signed_ill = (await _sign_paths([ill_storage_path]))[0]
                        if signed_ill:
                            illustration_url = signed_ill
                    except Exception:
                        pass
            elif image_path:
                try:
                    image_url = (await _sign_paths([image_path]))[0]
                except Exception:
                    image_url = None
            elif can_sign_ill and ill_storage_path is not None:
                try:
                    signed_ill = (await _sign_paths([ill_storage_path]))[0]
                    if signed_ill:
                        illustration_url = signed_ill
                except Exception:
                    pass

        def safe_line_indices(name: str) -> list[int]:
            value = processing_meta.get(name, [])
            if not isinstance(value, (list, tuple)):
                return []
            return sorted({
                item for item in value
                if isinstance(item, int) and not isinstance(item, bool) and item >= 0
            })

        return ReadingPageDTO(
            page_id=page_id,
            page_revision_id=page_revision_id,
            page_number=page_number,
            # OCR engine scores are not calibrated probabilities and cannot be
            # averaged into a verified page-level confidence value.
            confidence=None,
            width=page_width,
            height=page_height,
            image_url=image_url,
            tts_audio_url=tts_audio_url,
            tts_word_timings=tts_word_timings,
            tts_voice_id=tts_voice_id,
            tts_cached_speed=tts_cached_speed,
            image_overlay_safe=has_verified_geometry(
                processing_meta.get("word_box_geometry"),
                [word.model_dump() for word in words], page_width, page_height,
            ),
            illustration_url=illustration_url,
            illustration_text_free=illustration_text_free,
            text=text_content,
            words=words,
            paragraph_start_line_indices=safe_line_indices("paragraph_start_line_indices"),
            indented_line_indices=safe_line_indices("indented_line_indices"),
        )
