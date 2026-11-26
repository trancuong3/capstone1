from __future__ import annotations

import asyncio
import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, List, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import literal, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db, require_admin_id, require_parent_id
from app.api.routes.reading import HistoryRepository, HistoryService
from app.database.role_cache import get_cached_profile_role
from app.models import AuditLog, ChildProfile, ConsentRecord, Profile, ProgressReport, ReadingSession
from app.repositories.difficult_words_repository import DifficultWordsRepository
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig, LocalOcrCorrector
from app.services.ocr_inference_job_service import is_remote_ocr_mode
from app.services.runtime_diagnostics import (
    collect_email_delivery_health,
    collect_ocr_health,
    collect_remote_ocr_health,
    collect_worker_health,
    collect_worker_queue_metrics,
    derive_operational_state,
    is_ocr_engine_ready_status,
    probe_storage_health,
)
from app.services.tts_audio_cache_service import (
    TtsAudioCacheService,
    is_tts_cache_enabled,
)
from app.services.worker_telemetry import get_worker_telemetry
from app.services.voice_orchestrator import VoiceOrchestrator
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
    AdminAudioCacheSummaryRead,
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


async def _require_owned_child(db: AsyncSession, actor_id: UUID, child_id: UUID) -> None:
    """Use a non-enumerating owner predicate before any child-scoped write."""
    owned_id = await db.scalar(
        select(ChildProfile.Id).where(
            ChildProfile.Id == child_id,
            ChildProfile.ParentId == actor_id,
        )
    )
    if owned_id is None:
        raise HTTPException(status_code=404, detail="Resource not found")


@router.get("/reports", response_model=List[ProgressReportResponse])
async def get_reports(
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Only the signed-in parent's children's reports."""
    result = await db.execute(
        select(ProgressReport)
        .join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
        .where(ChildProfile.ParentId == actor_id)
    )
    return result.scalars().all()


class LegacyReportRepository:
    """Bounded, owner-scoped evidence for the legacy snapshot writer."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def lock_owned_child(self, actor_id: UUID, child_id: UUID) -> bool:
        # Locking the child serializes concurrent snapshot requests for the same
        # owner/period, avoiding duplicate writes without touching the schema.
        child = await self.db.scalar(
            select(ChildProfile.Id)
            .where(ChildProfile.Id == child_id, ChildProfile.ParentId == actor_id)
            .with_for_update()
        )
        return child is not None

    async def trusted_snapshot(
        self, actor_id: UUID, child_id: UUID, start: date, end: date
    ) -> ProgressReport | None:
        return await self.db.scalar(
            select(ProgressReport)
            .join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
            .where(
                ChildProfile.ParentId == actor_id,
                ProgressReport.ChildId == child_id,
                ProgressReport.PeriodStart == start,
                ProgressReport.PeriodEnd == end,
                ProgressReport.Summary["source"].as_string() == "server_completed_sessions_v1",
            )
            .order_by(ProgressReport.GeneratedAt.desc(), ProgressReport.Id.desc())
            .limit(1)
        )

    async def completed_sessions(
        self, actor_id: UUID, child_id: UUID, start: datetime, end: datetime, cutoff: datetime
    ) -> list[tuple[datetime, datetime]]:
        result = await self.db.execute(
            select(ReadingSession.StartedAt, ReadingSession.EndedAt)
            .join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
            .where(
                ChildProfile.ParentId == actor_id,
                ReadingSession.ChildId == child_id,
                ReadingSession.State == "COMPLETED",
                ReadingSession.StartedAt >= start,
                ReadingSession.StartedAt < end,
                ReadingSession.EndedAt.is_not(None),
                ReadingSession.EndedAt >= ReadingSession.StartedAt,
                ReadingSession.EndedAt <= cutoff,
            )
        )
        return list(result.all())

    async def save(self, snapshot: ProgressReport) -> ProgressReport:
        self.db.add(snapshot)
        try:
            await self.db.commit()
            await self.db.refresh(snapshot)
        except Exception:
            await self.db.rollback()
            raise
        return snapshot


class LegacyReportService:
    """Never trust client-generated progress metrics as persisted evidence."""

    def __init__(self, repository: LegacyReportRepository):
        self.repository = repository

    async def create(self, report_in: ProgressReportCreate, actor_id: UUID) -> ProgressReport:
        # Keep the old JSON request shape but reject claimed scores and metrics.
        if report_in.Summary:
            raise HTTPException(status_code=422, detail="Client report metrics are not accepted")

        start, end = report_in.PeriodStart, report_in.PeriodEnd
        today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=7))).date()
        if end < start or end > today or (end - start).days > 366:
            raise HTTPException(status_code=422, detail="Invalid report period")

        if not await self.repository.lock_owned_child(actor_id, report_in.ChildId):
            raise HTTPException(status_code=404, detail="Resource not found")

        existing = await self.repository.trusted_snapshot(
            actor_id, report_in.ChildId, start, end
        )
        if existing is not None:
            return existing

        local_tz = timezone(timedelta(hours=7))
        begin = datetime.combine(start, datetime.min.time(), tzinfo=local_tz)
        finish = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=local_tz)
        sessions = await self.repository.completed_sessions(
            actor_id, report_in.ChildId, begin, finish, datetime.now(timezone.utc)
        )
        if not sessions:
            # An empty snapshot would be indistinguishable from unsupported
            # evidence in old reports; do not invent a successful period.
            raise HTTPException(status_code=409, detail="No completed reading sessions in period")

        duration_ms = sum(
            max(0, int((ended_at - started_at).total_seconds() * 1000))
            for started_at, ended_at in sessions
        )
        snapshot = ProgressReport(
            ChildId=report_in.ChildId,
            PeriodStart=start,
            PeriodEnd=end,
            Summary={
                "source": "server_completed_sessions_v1",
                "completed_sessions": len(sessions),
                "reading_duration_ms": duration_ms,
            },
        )
        return await self.repository.save(snapshot)


@router.post("/reports", response_model=ProgressReportResponse)
async def create_report(
    report_in: ProgressReportCreate,
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await LegacyReportService(LegacyReportRepository(db)).create(report_in, actor_id)


@router.get("/consents", response_model=List[ConsentRecordResponse])
async def get_consents(
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Consent is visible only when both parent and child belong to the actor."""
    result = await db.execute(
        select(ConsentRecord)
        .join(ChildProfile, ConsentRecord.ChildId == ChildProfile.Id)
        .where(
            ConsentRecord.ParentId == actor_id,
            ChildProfile.ParentId == actor_id,
        )
    )
    return result.scalars().all()


@router.post("/consents", response_model=ConsentRecordResponse)
async def create_consent(
    consent_in: ConsentRecordCreate,
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    if consent_in.ParentId != actor_id:
        raise HTTPException(status_code=403, detail="Access denied")
    await _require_owned_child(db, actor_id, consent_in.ChildId)
    new_consent = ConsentRecord(**consent_in.model_dump())
    db.add(new_consent)
    await db.commit()
    await db.refresh(new_consent)
    return new_consent


@router.get("/logs", response_model=List[AuditLogResponse])
async def get_audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
):
    """Raw audit records are restricted to active administrators."""
    result = await db.execute(
        select(AuditLog)
        .order_by(AuditLog.CreatedAt.desc(), AuditLog.Id.desc())
        .offset(offset)
        .limit(limit)
    )
    return result.scalars().all()


@router.post("/logs", response_model=AuditLogResponse)
async def create_audit_log(
    log_in: AuditLogCreate,
    actor_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
):
    # A client must not impersonate another actor in an audit trail.
    if log_in.ActorId != actor_id:
        raise HTTPException(status_code=403, detail="Access denied")
    new_log = AuditLog(**log_in.model_dump())
    db.add(new_log)
    await db.commit()
    await db.refresh(new_log)
    return new_log


class ProgressRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def period_assessment(self, child_id, actor_id, start, end, generated_at):
        from app.models import ReadingComparisonReport, ReadingEvent, ReadingSession
        from app.services.reading_assessment import aggregate_period_assessment

        local_tz = timezone(timedelta(hours=7))
        begin = datetime.combine(start, datetime.min.time(), tzinfo=local_tz)
        finish = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=local_tz)
        rows = await self.db.execute(
            select(ReadingSession)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ChildProfile.ParentId == actor_id,
                ReadingSession.ChildId == child_id,
                ReadingSession.State == "COMPLETED",
                ReadingSession.StartedAt >= begin,
                ReadingSession.StartedAt < finish,
                ReadingSession.EndedAt <= generated_at,
            )
            .order_by(ReadingSession.StartedAt, ReadingSession.Id)
        )
        sessions = list(rows.scalars().all())
        if not sessions:
            return aggregate_period_assessment([])

        session_ids = [session.Id for session in sessions]
        report_rows = await self.db.execute(
            select(ReadingComparisonReport)
            .where(ReadingComparisonReport.SessionId.in_(session_ids))
            .order_by(
                ReadingComparisonReport.SessionId,
                ReadingComparisonReport.CreatedAt.desc(),
                ReadingComparisonReport.Id.desc(),
            )
        )
        reports_by_session: dict[UUID, list[ReadingComparisonReport]] = {}
        for report in report_rows.scalars().all():
            reports_by_session.setdefault(report.SessionId, []).append(report)

        event_rows = await self.db.execute(
            select(ReadingEvent)
            .where(ReadingEvent.SessionId.in_(session_ids))
            .order_by(
                ReadingEvent.SessionId,
                ReadingEvent.StartMs,
                ReadingEvent.Id,
            )
        )
        events_by_session: dict[UUID, list[ReadingEvent]] = {}
        for event in event_rows.scalars().all():
            events_by_session.setdefault(event.SessionId, []).append(event)

        evidence = [
            (
                session.Id,
                reports_by_session.get(session.Id, []),
                events_by_session.get(session.Id, []),
            )
            for session in sessions
        ]
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
    from app.api.routes.voice import get_voice_orchestrator

    return DifficultWordsService(
        DifficultWordsRepository(db),
        HistoryService(HistoryRepository(db)),
        voice_provider=get_voice_orchestrator(),
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
        return await get_cached_profile_role(self.db, actor_id)

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

    async def worker_queue_metrics(self):
        return await collect_worker_queue_metrics(self.db)


class AdminSystemService:
    def __init__(
        self,
        repository: AdminSystemRepository,
        voice_provider: object | None = None,
    ):
        self.repository = repository
        self.voice_provider = voice_provider

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

    @staticmethod
    def _is_legacy_voice_probe(voice_provider: object | None) -> bool:
        if voice_provider is None or isinstance(voice_provider, VoiceOrchestrator):
            return False
        mock_children = getattr(voice_provider, "_mock_children", None)
        if isinstance(mock_children, dict):
            return ("probe_tts" in mock_children or "probe_stt" in mock_children) and (
                "get_status" not in mock_children
            )
        return callable(getattr(voice_provider, "probe_tts", None)) and not callable(
            getattr(voice_provider, "get_status", None)
        )

    @staticmethod
    def _map_voice_capability_health(
        capability: str,
        *,
        local: dict,
        google: dict,
    ) -> tuple[str, Literal["installed", "initialized", "loaded", "healthy", "failed", "unknown", "disabled"] | None, str]:
        ready_key = "tts_ready" if capability == "tts" else "stt_ready"
        cap_label = "TTS" if capability == "tts" else "STT"
        google_configured = bool(google.get(f"{capability}_configured"))
        google_cooldown = bool(google.get(f"{capability}_cooldown"))
        local_configured = bool(local.get("configured", True))
        error_code = local.get(f"{capability}_error_code") or local.get("error_code")

        if local.get(ready_key):
            engine_name = "VieNeu-TTS" if capability == "tts" else "Sherpa-ONNX"
            return (
                "HEALTHY",
                "healthy",
                f"Local {cap_label} ({engine_name}) đang sẵn sàng.",
            )
        if not local_configured or error_code == "LOCAL_VOICE_UNCONFIGURED":
            if google_configured and not google_cooldown:
                return (
                    "DEGRADED",
                    "disabled",
                    f"Local {cap_label} chưa cấu hình; dịch vụ Google {cap_label} dự phòng sẵn sàng.",
                )
            return (
                "UNAVAILABLE",
                "disabled",
                f"Local {cap_label} chưa được cấu hình (VIREAD_LOCAL_VOICE_WORKER_URL).",
            )
        if error_code == "LOCAL_VOICE_TIMEOUT":
            return (
                "UNAVAILABLE",
                "failed",
                f"Kết nối Local {cap_label} bị hết thời gian chờ.",
            )
        if error_code == "LOCAL_VOICE_BUSY":
            return (
                "DEGRADED",
                "unknown",
                f"Local {cap_label} đang bận xử lý.",
            )
        if google_configured and not google_cooldown:
            return (
                "DEGRADED",
                "failed",
                f"Local {cap_label} tạm thời không phản hồi; Google {cap_label} dự phòng sẵn sàng.",
            )
        return (
            "UNAVAILABLE",
            "failed",
            f"Không thể kết nối dịch vụ {cap_label}.",
        )

    async def _probe_voice_health(
        self,
    ) -> tuple[
        tuple[str, str | None, str],
        tuple[str, str | None, str],
    ]:
        if self._is_legacy_voice_probe(self.voice_provider):
            async def _legacy_tts():
                try:
                    st, msg = await asyncio.wait_for(self.voice_provider.probe_tts(), timeout=5)
                    return st, None, msg
                except Exception:
                    return "UNAVAILABLE", None, "Không thể kiểm tra dịch vụ TTS."

            async def _legacy_stt():
                try:
                    st, msg = await asyncio.wait_for(self.voice_provider.probe_stt(), timeout=5)
                    return st, None, msg
                except Exception:
                    return "UNAVAILABLE", None, "Không thể kiểm tra dịch vụ STT."

            tts_res, stt_res = await asyncio.gather(_legacy_tts(), _legacy_stt())
            return tts_res, stt_res

        orchestrator = (
            self.voice_provider
            if self.voice_provider is not None
            else VoiceOrchestrator()
        )
        try:
            status_payload = await asyncio.wait_for(orchestrator.get_status(), timeout=4)
        except Exception:
            return (
                ("UNAVAILABLE", "failed", "Không thể kiểm tra dịch vụ TTS."),
                ("UNAVAILABLE", "failed", "Không thể kiểm tra dịch vụ STT."),
            )
        local = status_payload.get("local") or {}
        google = status_payload.get("google") or {}
        return (
            self._map_voice_capability_health("tts", local=local, google=google),
            self._map_voice_capability_health("stt", local=local, google=google),
        )

    async def health(self, workers: dict[str, object] | None = None):
        # Lightweight, bounded probes executed concurrently. Never initialize OCR weights from Health.
        async def _probe_db() -> bool:
            try:
                return bool(await asyncio.wait_for(self.repository.probe_database(), timeout=4))
            except (TimeoutError, asyncio.TimeoutError, SQLAlchemyError, OSError):
                return False

        async def _probe_local_ocr() -> tuple[str, str]:
            try:
                return await asyncio.wait_for(
                    LocalOcrCorrector.probe(LocalOcrConfig.from_environment()), timeout=4
                )
            except LocalCorrectionError:
                return "UNAVAILABLE", "Cấu hình AI OCR cục bộ chưa hợp lệ."
            except Exception:
                return "UNAVAILABLE", "Không thể kiểm tra AI OCR cục bộ."

        remote_ocr_mode = is_remote_ocr_mode()
        remote_worker_desc = "remote_worker"
        remote_ocr_ready = False
        remote_snapshot: dict[str, object] = {}

        def _build_remote_ocr_items(remote_info: dict[str, object]) -> list[dict[str, str]]:
            nonlocal remote_worker_desc, remote_ocr_ready, remote_snapshot
            remote_snapshot = remote_info
            workers_list = list(remote_info.get("workers") or [])
            online_workers = [w for w in workers_list if isinstance(w, dict) and w.get("online")]
            primary = online_workers[0] if online_workers else (workers_list[0] if workers_list and isinstance(workers_list[0], dict) else None)
            if primary:
                wid = str(primary.get("worker_id") or "ocr-worker")
                profile = str(primary.get("model_profile") or "").strip()
                remote_worker_desc = f"{wid} ({profile})" if profile else wid
            engines_map = dict(remote_info.get("engines") or (primary.get("engines") if primary else {}) or {})
            remote_ocr_ready = bool(remote_info.get("ready", False))

            items_out: list[dict[str, str]] = []
            for key, label in (
                ("paddleocr", "PaddleOCR"),
                ("vietocr", "VietOCR"),
                ("tesseract_vie", "Tesseract tiếng Việt"),
            ):
                eng = engines_map.get(key)
                if isinstance(eng, dict) and online_workers:
                    verified = bool(eng.get("inference_verified", False))
                    loaded = bool(eng.get("loaded", False))
                    installed = bool(eng.get("installed", False))
                    raw_detail = str(eng.get("detail_status") or "")
                    if verified or raw_detail == "healthy":
                        items_out.append(
                            dict(
                                id=key,
                                label=label,
                                status="HEALTHY",
                                detail_status="healthy",
                                safe_message=f"Đã xác minh suy luận trên OCR worker độc lập {remote_worker_desc} (inference_verified).",
                            )
                        )
                    elif loaded:
                        items_out.append(
                            dict(
                                id=key,
                                label=label,
                                status="HEALTHY" if key == "tesseract_vie" else "DEGRADED",
                                detail_status="loaded",
                                safe_message=f"Đã nạp model trên OCR worker {remote_worker_desc}.",
                            )
                        )
                    elif installed:
                        items_out.append(
                            dict(
                                id=key,
                                label=label,
                                status="DEGRADED",
                                detail_status="installed",
                                safe_message=f"OCR worker {remote_worker_desc} đã cài thư viện nhưng chưa xác minh suy luận.",
                            )
                        )
                    else:
                        items_out.append(
                            dict(
                                id=key,
                                label=label,
                                status="DEGRADED",
                                detail_status="unknown",
                                safe_message=f"OCR worker {remote_worker_desc} chưa báo cáo trạng thái engine.",
                            )
                        )
                else:
                    items_out.append(
                        dict(
                            id=key,
                            label=label,
                            status="DEGRADED",
                            detail_status="unknown",
                            safe_message="Chưa có OCR worker độc lập online báo cáo engine này.",
                        )
                    )
            vie_item = next((x for x in items_out if x["id"] == "tesseract_vie"), None)
            if vie_item and vie_item["status"] == "HEALTHY":
                tess_item = dict(
                    id="tesseract",
                    label="Tesseract",
                    status="HEALTHY",
                    detail_status="healthy",
                    safe_message=f"Binary Tesseract sẵn sàng trên OCR worker độc lập {remote_worker_desc}.",
                )
            else:
                tess_item = dict(
                    id="tesseract",
                    label="Tesseract",
                    status="DEGRADED",
                    detail_status="unknown",
                    safe_message="Chưa xác minh binary Tesseract trên OCR worker độc lập.",
                )
            items_out.insert(2, tess_item)
            return items_out

        async def _probe_ocr_engines():
            if remote_ocr_mode:
                try:
                    remote_info = await asyncio.wait_for(collect_remote_ocr_health(), timeout=3)
                    return _build_remote_ocr_items(remote_info)
                except Exception:
                    return [
                        dict(
                            id=key,
                            label=label,
                            status="DEGRADED",
                            detail_status="unknown",
                            safe_message="Chưa xác minh được trạng thái OCR worker độc lập.",
                        )
                        for key, label in (
                            ("paddleocr", "PaddleOCR"),
                            ("vietocr", "VietOCR"),
                            ("tesseract", "Tesseract"),
                            ("tesseract_vie", "Tesseract tiếng Việt"),
                        )
                    ]
            try:
                return await asyncio.wait_for(asyncio.to_thread(collect_ocr_health), timeout=3)
            except Exception:
                return [
                    dict(
                        id=key,
                        label=label,
                        status="DEGRADED",
                        detail_status="unknown",
                        safe_message="Chưa xác minh được trạng thái runtime OCR.",
                    )
                    for key, label in (
                        ("paddleocr", "PaddleOCR"),
                        ("vietocr", "VietOCR"),
                        ("tesseract", "Tesseract"),
                        ("tesseract_vie", "Tesseract tiếng Việt"),
                    )
                ]

        async def _probe_storage():
            try:
                return await asyncio.wait_for(probe_storage_health(), timeout=3)
            except Exception:
                return dict(
                    id="storage",
                    label="Supabase Storage",
                    status="DEGRADED",
                    detail_status="unknown",
                    safe_message="Chưa thể xác minh trạng thái Storage.",
                )

        async def _probe_audio_cache() -> dict[str, object]:
            cache_svc = TtsAudioCacheService(getattr(self.repository, "db", None))
            return await cache_svc.get_summary()

        db_res, ocr_res, voice_res, ocr_details_res, storage_res, audio_cache_res = await asyncio.gather(
            _probe_db(),
            _probe_local_ocr(),
            self._probe_voice_health(),
            _probe_ocr_engines(),
            _probe_storage(),
            _probe_audio_cache(),
            return_exceptions=True,
        )

        for probe_res in (db_res, ocr_res, voice_res, ocr_details_res, storage_res, audio_cache_res):
            if isinstance(probe_res, asyncio.CancelledError):
                raise probe_res

        if isinstance(audio_cache_res, BaseException) or not isinstance(audio_cache_res, dict):
            audio_cache_summary: dict[str, object] = {
                "entry_count": 0,
                "storage_used_bytes": 0,
                "storage_quota_bytes": 150 * 1024 * 1024,
                "daily_egress_bytes": 0,
                "daily_egress_limit_bytes": 300 * 1024 * 1024,
                "cache_hit_ratio": None,
                "quota_exhausted": False,
            }
        else:
            audio_cache_summary = audio_cache_res

        database_ready = False if isinstance(db_res, BaseException) else bool(db_res)
        if isinstance(ocr_res, BaseException):
            local_ocr_status, local_ocr_message = (
                "UNAVAILABLE",
                "Không thể kiểm tra AI OCR cục bộ.",
            )
        else:
            local_ocr_status, local_ocr_message = ocr_res

        if isinstance(voice_res, BaseException):
            tts_status, tts_detail, tts_message = (
                "UNAVAILABLE",
                "failed",
                "Không thể kiểm tra dịch vụ TTS.",
            )
            stt_status, stt_detail, stt_message = (
                "UNAVAILABLE",
                "failed",
                "Không thể kiểm tra dịch vụ STT.",
            )
        else:
            (tts_status, tts_detail, tts_message), (stt_status, stt_detail, stt_message) = voice_res

        if isinstance(ocr_details_res, BaseException):
            ocr_details = [
                dict(
                    id=key,
                    label=label,
                    status="DEGRADED",
                    detail_status="unknown",
                    safe_message="Chưa xác minh được trạng thái runtime OCR.",
                )
                for key, label in (
                    ("paddleocr", "PaddleOCR"),
                    ("vietocr", "VietOCR"),
                    ("tesseract", "Tesseract"),
                    ("tesseract_vie", "Tesseract tiếng Việt"),
                )
            ]
        else:
            ocr_details = ocr_details_res

        if isinstance(storage_res, BaseException):
            storage_details = dict(
                id="storage",
                label="Supabase Storage",
                status="DEGRADED",
                detail_status="unknown",
                safe_message="Chưa thể xác minh trạng thái Storage.",
            )
        else:
            storage_details = storage_res

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
                detail_status=tts_detail,
                checked_at=checked_at,
                safe_message=tts_message,
            ),
            AdminHealthItemRead(
                id="stt",
                label="Speech-to-Text (STT)",
                status=stt_status,
                detail_status=stt_detail,
                checked_at=checked_at,
                safe_message=stt_message,
            ),
        ]

        if not is_tts_cache_enabled():
            cache_item = AdminHealthItemRead(
                id="tts_audio_cache",
                label="TTS Audio Cache",
                status="DEGRADED",
                detail_status="disabled",
                operational_state="Offline",
                checked_at=checked_at,
                safe_message="Bộ nhớ đệm TTS đang tắt theo cấu hình.",
            )
        elif bool(audio_cache_summary.get("quota_exhausted")):
            cache_item = AdminHealthItemRead(
                id="tts_audio_cache",
                label="TTS Audio Cache",
                status="DEGRADED",
                detail_status="unknown",
                operational_state="Quota exhausted",
                checked_at=checked_at,
                safe_message="Lưu lượng cache TTS hôm nay đã chạm ngưỡng giới hạn miễn phí.",
                last_error="QUOTA_EXHAUSTED",
            )
        else:
            cache_item = AdminHealthItemRead(
                id="tts_audio_cache",
                label="TTS Audio Cache",
                status="HEALTHY",
                detail_status="healthy",
                operational_state="Healthy",
                checked_at=checked_at,
                safe_message=f"Bộ nhớ đệm TTS sẵn sàng ({int(audio_cache_summary.get('entry_count') or 0)} mục).",
            )
        items.append(cache_item)

        items.append(AdminHealthItemRead(**storage_details, checked_at=checked_at))
        items.extend(AdminHealthItemRead(**entry, checked_at=checked_at) for entry in ocr_details)
        if workers is not None:
            items.append(
                AdminHealthItemRead(**collect_email_delivery_health(), checked_at=checked_at)
            )
            metrics: dict[str, dict[str, object]] = {}
            try:
                raw_metrics = await asyncio.wait_for(
                    self.repository.worker_queue_metrics(), timeout=2.0
                )
                if isinstance(raw_metrics, dict):
                    metrics = raw_metrics
            except Exception:
                metrics = {}

            raw_workers = collect_worker_health(workers)
            for entry in raw_workers:
                wid = str(entry.get("id") or "")
                m = metrics.get(wid) or {}
                if entry.get("last_success_at") is None and m.get("last_success_at") is not None:
                    entry["last_success_at"] = m.get("last_success_at")
                if entry.get("last_error") is None and m.get("last_error") is not None:
                    entry["last_error"] = m.get("last_error")
                if m.get("queue_depth") is not None:
                    entry["queue_depth"] = int(m["queue_depth"])
                oldest_age = m.get("oldest_pending_job_age_seconds")
                if oldest_age is not None:
                    entry["oldest_pending_job_age_seconds"] = float(oldest_age)
                    if entry.get("status") == "HEALTHY" and float(oldest_age) > 900.0:
                        entry["status"] = "DEGRADED"
                        entry["last_error"] = entry.get("last_error") or "STALE_PENDING_JOBS"
                        entry["safe_message"] = "Worker có tác vụ chờ xử lý quá 15 phút."

            # Honest ocr_worker health entry (no false-green overrides)
            ocr_m = metrics.get("ocr_worker") or {}
            if remote_ocr_mode:
                queue_info = dict(remote_snapshot.get("queue") or {})
                workers_list = list(remote_snapshot.get("workers") or [])
                online_workers = [w for w in workers_list if isinstance(w, dict) and w.get("online")]
                primary = online_workers[0] if online_workers else (
                    workers_list[0] if workers_list and isinstance(workers_list[0], dict) else None
                )
                hb_iso = primary.get("last_heartbeat_at") if primary else None
                last_succ = None
                if isinstance(hb_iso, str) and hb_iso:
                    try:
                        last_succ = datetime.fromisoformat(hb_iso)
                    except ValueError:
                        last_succ = None
                if last_succ is None:
                    succ_iso = queue_info.get("latest_succeeded_at")
                    if isinstance(succ_iso, str) and succ_iso:
                        try:
                            last_succ = datetime.fromisoformat(succ_iso)
                        except ValueError:
                            last_succ = None
                if last_succ is None:
                    last_succ = ocr_m.get("last_success_at")  # type: ignore[assignment]
                q_depth = (
                    int(queue_info.get("pending_total", 0) or 0)
                    + int(queue_info.get("active_total", 0) or 0)
                    if queue_info
                    else ocr_m.get("queue_depth")
                )
                oldest_ocr_age = (
                    queue_info.get("oldest_pending_job_age_seconds")
                    if "oldest_pending_job_age_seconds" in queue_info
                    else ocr_m.get("oldest_pending_job_age_seconds")
                )
                if remote_ocr_ready:
                    ocr_w_status = "HEALTHY"
                    ocr_w_detail = "healthy"
                    ocr_w_err = None
                    ocr_w_msg = f"OCR worker {remote_worker_desc} online và đã xác minh suy luận."
                elif online_workers:
                    ocr_w_status = "DEGRADED"
                    ocr_w_detail = "initialized"
                    ocr_w_err = "OCR_ENGINES_NOT_READY"
                    ocr_w_msg = f"OCR worker {remote_worker_desc} online nhưng engine chưa sẵn sàng."
                else:
                    has_backlog = bool(q_depth and int(q_depth) > 0)
                    ocr_w_status = "UNAVAILABLE" if has_backlog else "DEGRADED"
                    ocr_w_detail = "failed" if has_backlog else "disabled"
                    ocr_w_err = "NO_ONLINE_OCR_WORKER"
                    ocr_w_msg = "Chưa có OCR worker độc lập nào online."
                items.append(
                    AdminHealthItemRead(
                        id="ocr_worker",
                        label="OCR worker",
                        status=ocr_w_status,
                        detail_status=ocr_w_detail,
                        checked_at=checked_at,
                        safe_message=ocr_w_msg,
                        last_success_at=last_succ,
                        oldest_pending_job_age_seconds=oldest_ocr_age,
                        queue_depth=q_depth,
                        last_error=ocr_w_err,
                    )
                )
            else:
                local_ready = any(
                    is_ocr_engine_ready_status(e.get("detail_status"))
                    for e in ocr_details
                    if e.get("id") in {"paddleocr", "vietocr"}
                )
                items.append(
                    AdminHealthItemRead(
                        id="ocr_worker",
                        label="OCR worker",
                        status="HEALTHY" if local_ready else "DEGRADED",
                        detail_status="loaded" if local_ready else "installed",
                        checked_at=checked_at,
                        safe_message=(
                            "OCR chạy trực tiếp trong tiến trình (local_inprocess)."
                            if local_ready
                            else "OCR local_inprocess chưa nạp model."
                        ),
                        last_success_at=ocr_m.get("last_success_at"),  # type: ignore[arg-type]
                        oldest_pending_job_age_seconds=ocr_m.get("oldest_pending_job_age_seconds"),  # type: ignore[arg-type]
                        queue_depth=ocr_m.get("queue_depth"),  # type: ignore[arg-type]
                        last_error=ocr_m.get("last_error"),  # type: ignore[arg-type]
                    )
                )

            items.extend(
                AdminHealthItemRead(**entry, checked_at=checked_at)
                for entry in raw_workers
            )

            # Report external/cron workers honestly
            for ext_key, ext_label in (
                ("reading_reminder", "Reading reminder worker"),
                ("reading_presence", "Reading presence worker"),
                ("karaoke_processing", "Karaoke processing worker"),
            ):
                ext_m = metrics.get(ext_key) or {}
                ext_tel = get_worker_telemetry(ext_key)
                ext_last_succ = ext_tel.get("last_success_at") or ext_m.get("last_success_at")
                ext_last_err = ext_tel.get("last_error") or ext_m.get("last_error")
                ext_q_depth = ext_m.get("queue_depth")
                ext_oldest = ext_m.get("oldest_pending_job_age_seconds")
                if ext_last_err:
                    ext_status = "UNAVAILABLE"
                    ext_detail = "failed"
                    ext_msg = f"Worker gặp lỗi gần nhất: {ext_last_err}."
                elif ext_oldest is not None and float(ext_oldest) > 900.0:
                    ext_status = "DEGRADED"
                    ext_detail = "unknown"
                    ext_last_err = "STALE_PENDING_JOBS"
                    ext_msg = "Có tác vụ chờ xử lý quá 15 phút."
                elif ext_last_succ is not None:
                    ext_status = "HEALTHY"
                    ext_detail = "healthy"
                    ext_msg = "Đã ghi nhận lần chạy thành công gần đây."
                else:
                    ext_status = "DEGRADED"
                    ext_detail = "unknown"
                    ext_msg = "Chưa ghi nhận lượt chạy cron/worker độc lập."
                items.append(
                    AdminHealthItemRead(
                        id=ext_key,
                        label=ext_label,
                        status=ext_status,
                        detail_status=ext_detail,
                        checked_at=checked_at,
                        safe_message=ext_msg,
                        last_success_at=ext_last_succ,
                        oldest_pending_job_age_seconds=ext_oldest,
                        queue_depth=ext_q_depth,
                        last_error=ext_last_err,
                    )
                )

        cache_quota_exhausted = bool(audio_cache_summary.get("quota_exhausted"))
        for item in items:
            if item.operational_state is None:
                item.operational_state = derive_operational_state(
                    status=item.status,
                    detail_status=item.detail_status,
                    queue_depth=item.queue_depth,
                    last_error=item.last_error,
                    quota_exhausted=(item.id == "tts" and item.status != "HEALTHY" and cache_quota_exhausted),
                )

        statuses = [item.status for item in items]
        overall = "HEALTHY" if all(s == "HEALTHY" for s in statuses) else "DEGRADED"

        return AdminHealthRead(
            overall_status=overall,
            checked_at=checked_at,
            services=items,
            audio_cache=AdminAudioCacheSummaryRead(**audio_cache_summary),
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
    request: Request,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminSystemService(AdminSystemRepository(db))
    await service.require_admin(actor_id)
    return await service.health(
        workers=getattr(request.app.state, "background_workers", None) or {}
    )
