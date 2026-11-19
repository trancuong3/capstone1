from __future__ import annotations

import asyncio
import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, List, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import literal, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.reading import HistoryRepository, HistoryService
from app.models import AuditLog, ChildProfile, ConsentRecord, Profile, ProgressReport
from app.providers.elevenlabs_voice_provider import ElevenLabsVoiceProvider
from app.repositories.difficult_words_repository import DifficultWordsRepository
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig, LocalOcrCorrector
from app.services.difficult_words_service import (
    DifficultWordsService,
    MAX_PRACTICE_AUDIO_BYTES,
)
from app.schemas import (
    AuditLogCreate,
    AuditLogResponse,
    ConsentRecordCreate,
    ConsentRecordResponse,
    ProgressReportCreate,
    ProgressReportResponse,
)
from app.schemas.difficult_words import (
    DifficultWordPracticeAttemptRead,
    DifficultWordPracticeCompleteRequest,
    DifficultWordPracticeHistoryRead,
    DifficultWordPracticeStartRequest,
    PracticeStatusLiteral,
)
from app.schemas.system import (
    AdminAuditLogRead,
    AdminAuditPageRead,
    AdminHealthItemRead,
    AdminHealthRead,
    DifficultWordRead,
    ProgressLegacyRead,
    ProgressPeriodOptionRead,
    ProgressPeriodRead,
    ProgressPeriodsRead,
    ProgressRead,
    ProgressTrendRead,
    SavedProgressPeriodRead,
)

router = APIRouter()


@router.get("/reports", response_model=List[ProgressReportResponse])
async def get_reports(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách báo cáo tiến độ"""
    result = await db.execute(select(ProgressReport))
    return result.scalars().all()


@router.post("/reports", response_model=ProgressReportResponse)
async def create_report(report_in: ProgressReportCreate, db: AsyncSession = Depends(get_db)):
    """Tạo báo cáo tiến độ học tập mới"""
    new_report = ProgressReport(**report_in.model_dump())
    db.add(new_report)
    await db.commit()
    await db.refresh(new_report)
    return new_report


@router.get("/consents", response_model=List[ConsentRecordResponse])
async def get_consents(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách các bản ghi đồng ý (Consent)"""
    result = await db.execute(select(ConsentRecord))
    return result.scalars().all()


@router.post("/consents", response_model=ConsentRecordResponse)
async def create_consent(consent_in: ConsentRecordCreate, db: AsyncSession = Depends(get_db)):
    """Ghi nhận quyền riêng tư/đồng ý (Consent) mới"""
    new_consent = ConsentRecord(**consent_in.model_dump())
    db.add(new_consent)
    await db.commit()
    await db.refresh(new_consent)
    return new_consent


@router.get("/logs", response_model=List[AuditLogResponse])
async def get_audit_logs(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách log kiểm toán hệ thống"""
    result = await db.execute(select(AuditLog))
    return result.scalars().all()


@router.post("/logs", response_model=AuditLogResponse)
async def create_audit_log(log_in: AuditLogCreate, db: AsyncSession = Depends(get_db)):
    """Ghi log hệ thống"""
    new_log = AuditLog(**log_in.model_dump())
    db.add(new_log)
    await db.commit()
    await db.refresh(new_log)
    return new_log


class ProgressRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def period_assessment(self, child_id, actor_id, start, end, generated_at):
        from app.models import ReadingSession
        from app.repositories.reading_content_repository import ReadingContentRepository
        from app.services.reading_assessment import aggregate_period_assessment
        local_tz = timezone(timedelta(hours=7))
        begin = datetime.combine(start, datetime.min.time(), tzinfo=local_tz)
        finish = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=local_tz)
        rows = await self.db.execute(
            select(ReadingSession)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(ChildProfile.ParentId == actor_id, ReadingSession.ChildId == child_id,
                   ReadingSession.State == "COMPLETED", ReadingSession.StartedAt >= begin,
                   ReadingSession.StartedAt < finish, ReadingSession.EndedAt <= generated_at)
            .order_by(ReadingSession.StartedAt, ReadingSession.Id)
        )
        repository = ReadingContentRepository(self.db)
        evidence = []
        for session in rows.scalars().all():
            evidence.append((session.Id, await repository.comparison_reports(session.Id),
                             await repository.events_for_session(session.Id)))
        return aggregate_period_assessment(evidence)

    async def report(self, child_id: UUID, period_start: date, period_end: date, actor_id: UUID):
        return await self.db.scalar(
            select(ProgressReport)
            .join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
            .where(
                ProgressReport.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                ProgressReport.PeriodStart == period_start,
                ProgressReport.PeriodEnd == period_end,
            )
            .order_by(ProgressReport.GeneratedAt.desc(), ProgressReport.Id.desc())
            .limit(1)
        )

    async def latest(self, child_id: UUID, actor_id: UUID):
        return await self.db.scalar(
            select(ProgressReport)
            .join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
            .where(ProgressReport.ChildId == child_id, ChildProfile.ParentId == actor_id)
            .order_by(
                ProgressReport.PeriodEnd.desc(),
                ProgressReport.PeriodStart.desc(),
                ProgressReport.GeneratedAt.desc(),
                ProgressReport.Id.desc(),
            )
            .limit(1)
        )

    async def periods(self, child_id: UUID, actor_id: UUID, offset: int, limit: int):
        from sqlalchemy import func

        ranked = (
            select(
                ProgressReport.Id.label("id"),
                ProgressReport.ChildId.label("child_id"),
                ProgressReport.PeriodStart.label("period_start"),
                ProgressReport.PeriodEnd.label("period_end"),
                ProgressReport.GeneratedAt.label("generated_at"),
                func.row_number()
                .over(
                    partition_by=(ProgressReport.PeriodStart, ProgressReport.PeriodEnd),
                    order_by=(ProgressReport.GeneratedAt.desc(), ProgressReport.Id.desc()),
                )
                .label("rank"),
            )
            .join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
            .where(ProgressReport.ChildId == child_id, ChildProfile.ParentId == actor_id)
            .subquery()
        )
        result = await self.db.execute(
            select(ranked)
            .where(ranked.c.rank == 1)
            .order_by(
                ranked.c.period_end.desc(),
                ranked.c.period_start.desc(),
                ranked.c.generated_at.desc(),
                ranked.c.id.desc(),
            )
            .offset(offset)
            .limit(limit)
        )
        return result.mappings().all()


class ProgressService:
    def __init__(self, repository: ProgressRepository, access: HistoryService):
        self.repository = repository
        self.access = access

    async def periods(self, child_id: UUID, actor_id: UUID, cursor: str | None, limit: int):
        await self.access.require_child(child_id, actor_id)
        if not 1 <= limit <= 100 or (
            cursor is not None
            and re.fullmatch(r"page-[1-9][0-9]{0,5}", cursor, flags=re.ASCII) is None
        ):
            raise HTTPException(status_code=422, detail="Invalid report pagination")
        page = int(cursor[5:]) if cursor else 1
        if page > 100000:
            raise HTTPException(status_code=422, detail="Invalid report pagination")
        rows = await self.repository.periods(child_id, actor_id, (page - 1) * limit, limit + 1)
        try:
            items = [ProgressPeriodOptionRead.model_validate(row) for row in rows[:limit]]
            if any(item.period_end < item.period_start for item in items):
                raise ValueError("Invalid saved period")
            return ProgressPeriodsRead(
                items=items,
                next_cursor=f"page-{page + 1}" if len(rows) > limit and page < 100000 else None,
            )
        except (ValidationError, TypeError, ValueError):
            raise HTTPException(status_code=501, detail="Report contract is not available yet") from None

    @staticmethod
    def saved_report(row):
        from math import isfinite

        raw = row.Summary if isinstance(row.Summary, dict) else {}
        values = {}
        valid_fields = 0
        for name in SavedProgressPeriodRead.model_fields:
            if name not in raw:
                values[name] = None
                continue
            try:
                if isinstance(raw[name], bool):
                    raise ValueError("Invalid metric")
                values[name] = getattr(SavedProgressPeriodRead.model_validate({name: raw[name]}), name)
                if values[name] is not None or name.endswith("rate") or name == "comprehension_accuracy":
                    valid_fields += 1
            except (ValidationError, TypeError, ValueError):
                values[name] = None
        metrics_status = (
            "available"
            if valid_fields == len(values)
            else "partial"
            if valid_fields
            else "absent"
            if not any(k in raw for k in values)
            else "unsupported"
        )
        words = None
        words_status = "absent" if "difficult_words" not in raw else "unsupported"
        if isinstance(raw.get("difficult_words"), list):
            words = []
            invalid = False
            for item in raw["difficult_words"]:
                try:
                    word = DifficultWordRead.model_validate(item)
                    if not isfinite(word.difficulty_score) or word.last_seen_at.utcoffset() is None:
                        raise ValueError("Invalid word evidence")
                    words.append(word)
                except (ValidationError, TypeError, ValueError):
                    invalid = True
            words_status = (
                "partial" if invalid and words else "unsupported" if invalid else "available"
            )
            if invalid and not words:
                words = None
        previous = trend = None
        comparison_status = "absent"
        if raw.get("previous_period") is not None:
            comparison_status = "unsupported"
            try:
                previous = ProgressPeriodRead.model_validate(raw["previous_period"], strict=True)
                SavedProgressPeriodRead.model_validate(raw["previous_period"], strict=True)
                trend = ProgressTrendRead.model_validate(raw.get("trend_deltas"), strict=True)
                numbers = [v for v in previous.model_dump().values() if v is not None]
                numbers += [v for v in trend.model_dump().values() if v is not None]
                if not all(isfinite(v) for v in numbers):
                    raise ValueError("Invalid comparison")
                comparison_status = "available"
            except (ValidationError, TypeError, ValueError):
                previous = trend = None
        legacy_values = {}
        for name in ProgressLegacyRead.model_fields:
            if name in raw:
                try:
                    if isinstance(raw[name], bool):
                        raise ValueError("Invalid legacy metric")
                    value = getattr(ProgressLegacyRead.model_validate({name: raw[name]}), name)
                    if value is not None:
                        legacy_values[name] = value
                except (ValidationError, TypeError, ValueError):
                    pass
        legacy = ProgressLegacyRead(**legacy_values) if legacy_values else None
        available = {
            "metrics": metrics_status,
            "difficult_words": words_status,
            "comparison": comparison_status,
        }
        status = (
            "complete"
            if metrics_status == "available"
            and words_status == "available"
            and comparison_status != "unsupported"
            else "partial"
            if valid_fields or words is not None or legacy
            else "unsupported"
        )
        try:
            result = ProgressRead(
                **values,
                id=row.Id,
                child_id=row.ChildId,
                period_start=row.PeriodStart,
                period_end=row.PeriodEnd,
                generated_at=row.GeneratedAt,
                difficult_words=words,
                previous_period=previous,
                trend_deltas=trend,
                legacy=legacy,
                data_status=status,
                availability=available,
            )
            if result.period_end < result.period_start:
                raise ValueError("Invalid period")
            return result
        except (ValidationError, TypeError, ValueError):
            raise HTTPException(status_code=501, detail="Report contract is not available yet") from None

    async def read(
        self,
        child_id: UUID,
        actor_id: UUID,
        period_start: date | None,
        period_end: date | None,
        words_only: bool = False,
    ):
        await self.access.require_child(child_id, actor_id)
        if not words_only:
            if (period_start is None) != (period_end is None) or (
                period_start is not None and period_end < period_start
            ):
                raise HTTPException(status_code=422, detail="Invalid date window")
            row = (
                await self.repository.latest(child_id, actor_id)
                if period_start is None
                else await self.repository.report(child_id, period_start, period_end, actor_id)
            )
            if row is None:
                raise HTTPException(status_code=404, detail="Saved report not found")
            saved = self.saved_report(row)
            evidence = await self.repository.period_assessment(
                child_id, actor_id, row.PeriodStart, row.PeriodEnd, row.GeneratedAt,
            )
            return ProgressRead.model_validate({**saved.model_dump(), **evidence})

        today = datetime.now(timezone(timedelta(hours=7))).date()
        end = period_end or today
        start = period_start or (end - timedelta(days=89 if words_only else 29))
        if end < start:
            raise HTTPException(status_code=422, detail="Invalid date window")
        row = await self.repository.report(child_id, start, end, actor_id)
        if row is None:
            raise HTTPException(status_code=501, detail="Report has not been generated yet")
        try:
            if words_only:
                if not isinstance(row.Summary, dict) or "difficult_words" not in row.Summary:
                    raise HTTPException(status_code=501, detail="Word evidence is not available yet")
                return TypeAdapter(list[DifficultWordRead]).validate_python(
                    row.Summary["difficult_words"]
                )
        except (ValidationError, TypeError, ValueError):
            raise HTTPException(status_code=501, detail="Report contract is not available yet") from None


@router.get("/progress/{child_id}", response_model=ProgressRead)
async def get_owned_progress(
    child_id: UUID,
    period_start: date | None = None,
    period_end: date | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ProgressService(
        ProgressRepository(db), HistoryService(HistoryRepository(db))
    ).read(child_id, actor_id, period_start, period_end)


@router.get("/progress/{child_id}/periods", response_model=ProgressPeriodsRead)
async def get_owned_progress_periods(
    child_id: UUID,
    cursor: str | None = None,
    limit: int = 20,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ProgressService(
        ProgressRepository(db), HistoryService(HistoryRepository(db))
    ).periods(child_id, actor_id, cursor, limit)


def _difficult_words_service(db: AsyncSession) -> DifficultWordsService:
    return DifficultWordsService(
        DifficultWordsRepository(db),
        HistoryService(HistoryRepository(db)),
    )


@router.get("/difficult-words/{child_id}", response_model=list[DifficultWordRead])
async def get_owned_difficult_words(
    child_id: UUID,
    period_start: date | None = None,
    period_end: date | None = None,
    status_filter: PracticeStatusLiteral | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _difficult_words_service(db).list_difficult_words(
        child_id,
        actor_id,
        period_start=period_start,
        period_end=period_end,
        status_filter=status_filter,
    )


@router.get(
    "/difficult-words/{child_id}/practice/history",
    response_model=DifficultWordPracticeHistoryRead,
)
async def get_difficult_word_practice_history(
    child_id: UUID,
    normalized_word: Annotated[str | None, Query(max_length=120)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _difficult_words_service(db).practice_history(
        child_id,
        actor_id,
        normalized_word=normalized_word,
        limit=limit,
    )


@router.post(
    "/difficult-words/{child_id}/practice/evaluate",
    response_model=DifficultWordPracticeAttemptRead,
)
async def evaluate_difficult_word_direct(
    child_id: UUID,
    request_id: Annotated[UUID, Form()],
    normalized_word: Annotated[str, Form(min_length=1, max_length=120)],
    display_text: Annotated[str | None, Form(max_length=120)] = None,
    file: Annotated[UploadFile | None, File(description="Child reading recording for this word")] = None,
    audio_duration_ms: Annotated[int | None, Form(ge=0, le=60_000)] = None,
    audio_quality_status: Annotated[str | None, Form(max_length=32)] = None,
    browser_transcript: Annotated[str | None, Form(max_length=160)] = None,
    browser_confidence: Annotated[float | None, Form(ge=0.0, le=1.0)] = None,
    book_id: Annotated[UUID | None, Form()] = None,
    session_id: Annotated[UUID | None, Form()] = None,
    page_id: Annotated[UUID | None, Form()] = None,
    page_revision_id: Annotated[UUID | None, Form()] = None,
    word_id: Annotated[UUID | None, Form()] = None,
    context_phrase: Annotated[str | None, Form(max_length=240)] = None,
    evidence_word_ids: Annotated[str | None, Form(max_length=4096)] = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    audio_bytes: bytes | None = None
    filename = "practice.webm"
    content_type: str | None = None
    if file is not None:
        filename = file.filename or "practice.webm"
        content_type = file.content_type
        try:
            audio_bytes = await file.read(MAX_PRACTICE_AUDIO_BYTES + 1)
        finally:
            await file.close()

    parsed_evidence_ids: list[UUID] = []
    if evidence_word_ids:
        try:
            raw_list = json.loads(evidence_word_ids)
            if isinstance(raw_list, list):
                for item in raw_list[:50]:
                    if isinstance(item, str):
                        parsed_evidence_ids.append(UUID(item))
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail="INVALID_EVIDENCE_WORD_IDS") from None

    return await _difficult_words_service(db).evaluate_word_direct(
        child_id,
        actor_id,
        request_id=request_id,
        normalized_word=normalized_word,
        display_text=display_text,
        audio_bytes=audio_bytes,
        filename=filename,
        content_type=content_type,
        audio_duration_ms=audio_duration_ms,
        audio_quality_status=audio_quality_status,
        browser_transcript=browser_transcript,
        browser_confidence=browser_confidence,
        evidence_word_ids=parsed_evidence_ids,
        book_id=book_id,
        session_id=session_id,
        page_id=page_id,
        page_revision_id=page_revision_id,
        word_id=word_id,
        context_phrase=context_phrase,
    )


@router.post(
    "/difficult-words/{child_id}/practice/start",
    response_model=DifficultWordPracticeAttemptRead,
)
async def start_difficult_word_practice(
    child_id: UUID,
    payload: DifficultWordPracticeStartRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _difficult_words_service(db).start_attempt(
        child_id,
        actor_id,
        payload,
    )


@router.post(
    "/difficult-words/{child_id}/practice/{attempt_id}/evaluate-audio",
    response_model=DifficultWordPracticeAttemptRead,
)
async def evaluate_difficult_word_practice_audio(
    child_id: UUID,
    attempt_id: UUID,
    completion_request_id: Annotated[UUID, Form()],
    file: Annotated[UploadFile, File(description="Child reading recording for this word")],
    audio_duration_ms: Annotated[int | None, Form(ge=0, le=60_000)] = None,
    audio_quality_status: Annotated[str | None, Form(max_length=32)] = None,
    browser_transcript: Annotated[str | None, Form(max_length=160)] = None,
    browser_confidence: Annotated[float | None, Form(ge=0.0, le=1.0)] = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    try:
        audio_bytes = await file.read(MAX_PRACTICE_AUDIO_BYTES + 1)
    finally:
        await file.close()

    return await _difficult_words_service(db).evaluate_audio_attempt(
        child_id,
        attempt_id,
        actor_id,
        completion_request_id=completion_request_id,
        audio_bytes=audio_bytes,
        filename=file.filename or "practice.webm",
        content_type=file.content_type,
        audio_duration_ms=audio_duration_ms,
        audio_quality_status=audio_quality_status,
        browser_transcript=browser_transcript,
        browser_confidence=browser_confidence,
    )


@router.post(
    "/difficult-words/{child_id}/practice/{attempt_id}/complete",
    response_model=DifficultWordPracticeAttemptRead,
)
async def complete_difficult_word_practice(
    child_id: UUID,
    attempt_id: UUID,
    payload: DifficultWordPracticeCompleteRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _difficult_words_service(db).complete_attempt(
        child_id,
        attempt_id,
        actor_id,
        payload,
    )


class AdminSystemRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID):
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))

    async def logs(self, action: str | None, resource_type: str | None, offset: int, limit: int):
        query = select(AuditLog)
        if action:
            query = query.where(AuditLog.Action == action)
        if resource_type:
            query = query.where(AuditLog.ResourceType == resource_type)
        result = await self.db.execute(
            query.order_by(AuditLog.CreatedAt.desc(), AuditLog.Id.desc()).offset(offset).limit(limit)
        )
        return result.scalars().all()

    async def probe_database(self):
        return await self.db.scalar(select(literal(1))) == 1


class AdminSystemService:
    def __init__(
        self,
        repository: AdminSystemRepository,
        voice_provider: ElevenLabsVoiceProvider | None = None,
    ):
        self.repository = repository
        self.voice_provider = voice_provider or ElevenLabsVoiceProvider()

    async def require_admin(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Access denied")

    async def logs(
        self,
        action: str | None,
        resource_type: str | None,
        cursor: str | None,
        limit: int,
    ):
        if not 1 <= limit <= 100:
            raise HTTPException(status_code=422, detail="Invalid page size")
        if (
            cursor is not None
            and re.fullmatch(r"page-[1-9][0-9]{0,5}", cursor, flags=re.ASCII) is None
        ):
            raise HTTPException(status_code=422, detail="Invalid cursor")
        page = int(cursor[5:]) if cursor else 1
        if page > 100000:
            raise HTTPException(status_code=422, detail="Invalid cursor")
        rows = await self.repository.logs(action, resource_type, (page - 1) * limit, limit + 1)
        try:
            return AdminAuditPageRead(
                items=[
                    AdminAuditLogRead(
                        id=row.Id,
                        actor_id=row.ActorId,
                        action=row.Action,
                        resource_type=row.ResourceType,
                        resource_id=row.ResourceId,
                        request_id=row.RequestId,
                        created_at=row.CreatedAt,
                        metadata={},
                    )
                    for row in rows[:limit]
                ],
                next_cursor=f"page-{page + 1}" if len(rows) > limit and page < 100000 else None,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Audit contract is not available yet") from None

    async def health(self):
        # Probes the API, database, local OCR model, and voice providers.
        try:
            database_ready = await asyncio.wait_for(self.repository.probe_database(), timeout=4)
        except (TimeoutError, asyncio.TimeoutError, SQLAlchemyError, OSError):
            database_ready = False

        try:
            local_ocr_status, local_ocr_message = await LocalOcrCorrector.probe(
                LocalOcrConfig.from_environment()
            )
        except LocalCorrectionError:
            local_ocr_status, local_ocr_message = (
                "UNAVAILABLE",
                "Cấu hình AI OCR cục bộ chưa hợp lệ.",
            )
        except Exception:
            local_ocr_status, local_ocr_message = (
                "UNAVAILABLE",
                "Không thể kiểm tra AI OCR cục bộ.",
            )

        try:
            tts_status, tts_message = await self.voice_provider.probe_tts()
        except Exception:
            tts_status, tts_message = "UNAVAILABLE", "Không thể kiểm tra dịch vụ TTS."

        try:
            stt_status, stt_message = await self.voice_provider.probe_stt()
        except Exception:
            stt_status, stt_message = "UNAVAILABLE", "Không thể kiểm tra dịch vụ STT."

        checked_at = datetime.now(timezone.utc)
        items = [
            AdminHealthItemRead(
                id="api",
                label="FastAPI",
                status="HEALTHY",
                checked_at=checked_at,
                safe_message="API đã phản hồi yêu cầu kiểm tra.",
            ),
            AdminHealthItemRead(
                id="database",
                label="Database",
                status="HEALTHY" if database_ready else "UNAVAILABLE",
                checked_at=checked_at,
                safe_message=(
                    "Database đã phản hồi truy vấn đọc."
                    if database_ready
                    else "Chưa kiểm tra được kết nối database. Vui lòng thử lại."
                ),
            ),
            AdminHealthItemRead(
                id="local_ocr",
                label="AI OCR cục bộ",
                status=local_ocr_status,
                checked_at=checked_at,
                safe_message=local_ocr_message,
            ),
            AdminHealthItemRead(
                id="tts",
                label="Text-to-Speech (TTS)",
                status=tts_status,
                checked_at=checked_at,
                safe_message=tts_message,
            ),
            AdminHealthItemRead(
                id="stt",
                label="Speech-to-Text (STT)",
                status=stt_status,
                checked_at=checked_at,
                safe_message=stt_message,
            ),
        ]

        statuses = [item.status for item in items]
        overall = "HEALTHY" if all(s == "HEALTHY" for s in statuses) else "DEGRADED"

        return AdminHealthRead(
            overall_status=overall,
            checked_at=checked_at,
            services=items,
        )


@router.get("/admin/audit-logs", response_model=AdminAuditPageRead)
async def get_admin_audit_logs(
    action: str | None = None,
    resource_type: str | None = None,
    cursor: str | None = None,
    limit: int = Query(default=10, ge=1, le=100),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminSystemService(AdminSystemRepository(db))
    await service.require_admin(actor_id)
    return await service.logs(action, resource_type, cursor, limit)


@router.get("/admin/health", response_model=AdminHealthRead)
async def get_admin_health(
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)
):
    service = AdminSystemService(AdminSystemRepository(db))
    await service.require_admin(actor_id)
    return await service.health()
