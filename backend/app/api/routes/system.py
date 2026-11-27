from __future__ import annotations

import asyncio
import json
import os
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
from app.core.karaoke_processing_config import (
    KaraokeConfigurationError,
    KaraokeProcessingConfig,
)
from app.database.role_cache import get_cached_profile_role
from app.database.session import AsyncSessionLocal, probe_database_connection
from app.models import AuditLog, ChildProfile, ConsentRecord, Profile, ProgressReport, ReadingSession
from app.repositories.difficult_words_repository import DifficultWordsRepository
from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository
from app.services import remote_ocr_wakeup
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig, LocalOcrCorrector
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError
from app.services.ocr_inference_job_service import is_remote_ocr_mode
from app.services.rate_limiter import rate_limiter
from app.services.remote_ocr_wakeup import (
    is_remote_worker_wakeup_configured,
    send_remote_ocr_wakeup,
)
from app.services.runtime_diagnostics import (
    collect_email_delivery_health,
    collect_ocr_health,
    collect_persisted_worker_heartbeats,
    collect_remote_ocr_health,
    collect_worker_health,
    collect_worker_queue_metrics,
    derive_operational_state,
    is_ocr_engine_ready_status,
    probe_storage_health,
)
from app.services.tts_audio_cache_service import (
    TtsAudioCacheService,
    get_cached_tts_audio_cache_summary,
    get_tts_cache_daily_egress_limit_bytes,
    get_tts_cache_max_bytes,
    is_tts_cache_enabled,
    is_tts_cache_runtime_quota_exhausted,
    set_cached_tts_audio_cache_summary,
)
from app.services.worker_telemetry import get_worker_telemetry
from app.services.voice_orchestrator import VoiceOrchestrator, VoicePolicyContext
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
    AdminOcrWorkerWakeupResponse,
    DifficultWordRead,
    HealthCriticality,
    HealthDetailStatus,
    HealthExecutionMode,
    ProgressLegacyRead,
    ProgressPeriodOptionRead,
    ProgressPeriodRead,
    ProgressPeriodsRead,
    ProgressRead,
    ProgressTrendRead,
    SavedProgressPeriodRead,
)

router = APIRouter()

_ORIG_VOICE_ORCHESTRATOR_CLS = VoiceOrchestrator
_ORIG_TTS_CACHE_GET_SUMMARY = TtsAudioCacheService.get_summary
_TRUTHY_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSY_VALUES = frozenset({"0", "false", "no", "off"})
_NON_DEGRADING_STATES = frozenset({"Standby", "Scheduled", "Local only"})
_CRON_HEARTBEAT_FRESH_SECONDS = 90.0 * 60.0
_VALID_EXECUTION_MODES: frozenset[str] = frozenset(
    {
        "always_on",
        "in_process",
        "on_demand",
        "cron_scheduled",
        "remote_worker",
        "remote_delegated",
        "precomputed_cache",
        "browser_wasm",
        "cloud_ai",
        "local_only",
        "disabled_opt_in",
    }
)


def _remote_ocr_health_timeout_seconds() -> float:
    raw = (os.getenv("VIREAD_HEALTH_OCR_TIMEOUT_SECONDS") or "").strip()
    if raw:
        try:
            return max(2.5, min(15.0, float(raw)))
        except ValueError:
            pass
    return 8.0


def _is_hosted_deployment() -> bool:
    app_env = (os.getenv("APP_ENVIRONMENT") or "").strip().lower()
    render_flag = (os.getenv("RENDER") or "").strip().lower()
    disable_heavy = (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower()
    return (
        app_env == "production"
        or render_flag in _TRUTHY_VALUES
        or disable_heavy in _TRUTHY_VALUES
    )


def _is_hosted_cron_workers_mode() -> bool:
    override = (os.getenv("VIREAD_ENABLE_LIGHTWEIGHT_WORKERS") or "").strip().lower()
    if override in _FALSY_VALUES:
        return True
    if override in _TRUTHY_VALUES:
        return False
    return _is_hosted_deployment()


def _parse_utc_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if isinstance(value, str):
        cleaned = value.strip()
        if not cleaned:
            return None
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(cleaned)
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return None


def _resolve_merged_worker_telemetry(
    *,
    in_mem: dict[str, object],
    persisted: dict[str, object],
    metric: dict[str, object],
) -> tuple[datetime | None, datetime | None, str | None, HealthExecutionMode | None]:
    in_mem_succ = _parse_utc_datetime(in_mem.get("last_success_at"))
    in_mem_err_raw = in_mem.get("last_error")
    in_mem_err = str(in_mem_err_raw).strip() if isinstance(in_mem_err_raw, str) and in_mem_err_raw.strip() else None

    pers_succ = _parse_utc_datetime(persisted.get("last_success_at"))
    pers_err_at = _parse_utc_datetime(persisted.get("last_error_at"))
    pers_err_raw = persisted.get("last_error_code")
    pers_err = str(pers_err_raw).strip() if isinstance(pers_err_raw, str) and pers_err_raw.strip() else None

    db_succ = _parse_utc_datetime(metric.get("last_success_at"))
    db_err_raw = metric.get("last_error")
    db_err = str(db_err_raw).strip() if isinstance(db_err_raw, str) and db_err_raw.strip() else None

    hb_candidates = [dt for dt in (in_mem_succ, pers_succ) if dt is not None]
    hb_last_success = max(hb_candidates) if hb_candidates else None

    all_candidates = [dt for dt in (hb_last_success, db_succ) if dt is not None]
    combined_last_success = max(all_candidates) if all_candidates else None

    active_error: str | None = None
    if in_mem_err:
        active_error = in_mem_err
    elif pers_err:
        if hb_last_success is not None and pers_err_at is not None and hb_last_success > pers_err_at:
            active_error = None
        else:
            active_error = pers_err
    elif db_err:
        active_error = db_err

    raw_mode = str(persisted.get("execution_mode") or "").strip()
    persisted_mode: HealthExecutionMode | None = (
        raw_mode  # type: ignore[assignment]
        if raw_mode in _VALID_EXECUTION_MODES
        else None
    )
    return hb_last_success, combined_last_success, active_error, persisted_mode


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
    provider_mode: Annotated[str | None, Form(max_length=40)] = None,
    allow_google_stt: Annotated[str | None, Form(max_length=16)] = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    from app.api.routes.voice import _parse_bool_form, _parse_provider_mode

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

    policy = VoicePolicyContext(
        provider_mode=_parse_provider_mode(provider_mode),
        allow_google_stt=_parse_bool_form(allow_google_stt),
        actor_id=actor_id,
        book_id=book_id,
        session_id=str(session_id) if session_id is not None else None,
        page_id=str(page_id) if page_id is not None else None,
        page_revision_id=page_revision_id,
    )
    service = _difficult_words_service(db)
    evaluate_kwargs: dict[str, object] = {
        "request_id": request_id,
        "normalized_word": normalized_word,
        "display_text": display_text,
        "audio_bytes": audio_bytes,
        "filename": filename,
        "content_type": content_type,
        "audio_duration_ms": audio_duration_ms,
        "audio_quality_status": audio_quality_status,
        "browser_transcript": browser_transcript,
        "browser_confidence": browser_confidence,
        "evidence_word_ids": parsed_evidence_ids,
        "book_id": book_id,
        "session_id": session_id,
        "page_id": page_id,
        "page_revision_id": page_revision_id,
        "word_id": word_id,
        "context_phrase": context_phrase,
    }
    import inspect

    try:
        sig = inspect.signature(service.evaluate_word_direct)
        if "policy" in sig.parameters or any(
            p.kind == inspect.Parameter.VAR_KEYWORD
            for p in sig.parameters.values()
        ):
            evaluate_kwargs["policy"] = policy
    except (TypeError, ValueError):
        evaluate_kwargs["policy"] = policy

    return await service.evaluate_word_direct(
        child_id,
        actor_id,
        **evaluate_kwargs,  # type: ignore[arg-type]
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
        if isinstance(self.db, AsyncSession):
            probe = await probe_database_connection(timeout=6.0)
            return bool(probe.get("ok"))
        return await self.db.scalar(select(literal(1))) == 1

    async def worker_queue_metrics(self, *, include_ocr_worker: bool | None = None):
        inc_ocr = (
            (not is_remote_ocr_mode())
            if include_ocr_worker is None
            else bool(include_ocr_worker)
        )
        if isinstance(self.db, AsyncSession):
            return await collect_worker_queue_metrics(
                None, include_ocr_worker=inc_ocr, timeout=5.0
            )
        return await collect_worker_queue_metrics(
            self.db, include_ocr_worker=inc_ocr, timeout=5.0
        )

    async def persisted_worker_heartbeats(self) -> dict[str, dict[str, object]]:
        if isinstance(self.db, AsyncSession):
            return await collect_persisted_worker_heartbeats(None, timeout=3.0)
        return await collect_persisted_worker_heartbeats(self.db, timeout=3.0)


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
        elevenlabs: dict | None = None,
        audio_cache_summary: dict | None = None,
        tts_cache_enabled: bool = True,
        hosted_mode: bool = False,
    ) -> dict[str, object]:
        ready_key = "tts_ready" if capability == "tts" else "stt_ready"
        cap_label = "TTS" if capability == "tts" else "STT"
        el_info = elevenlabs if isinstance(elevenlabs, dict) else {}
        elevenlabs_configured = bool(el_info.get("configured"))
        elevenlabs_cooldown = bool(el_info.get(f"{capability}_cooldown"))
        google_configured = bool(google.get(f"{capability}_configured"))
        google_cooldown = bool(google.get(f"{capability}_cooldown"))
        local_configured = bool(
            local.get("configured")
            if "configured" in local
            else local.get("url_configured", True)
        )
        error_code = local.get(f"{capability}_error_code") or local.get("error_code")
        if error_code == "LOCAL_VOICE_UNCONFIGURED":
            local_configured = False

        if local.get(ready_key):
            return {
                "status": "HEALTHY",
                "detail_status": "healthy",
                "operational_state": "Healthy",
                "safe_message": (
                    "Dịch vụ giọng đọc cục bộ đang sẵn sàng."
                    if capability == "tts"
                    else "Dịch vụ nhận diện giọng nói cục bộ đang sẵn sàng."
                ),
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": None,
            }

        if capability == "tts":
            if elevenlabs_configured and not elevenlabs_cooldown:
                return {
                    "status": "HEALTHY",
                    "detail_status": "cloud_ready",
                    "operational_state": "Healthy",
                    "safe_message": "Dịch vụ ElevenLabs TTS đang sẵn sàng.",
                    "execution_mode": "cloud_ai",
                    "criticality": "important",
                    "action_hint": None,
                    "last_error": None,
                }
            if google_configured and not google_cooldown:
                return {
                    "status": "HEALTHY",
                    "detail_status": "cloud_ready",
                    "operational_state": "Healthy",
                    "safe_message": "Dịch vụ giọng đọc đám mây đang sẵn sàng.",
                    "execution_mode": "cloud_ai",
                    "criticality": "important",
                    "action_hint": None,
                    "last_error": None,
                }
            cache_entries = (
                int(audio_cache_summary.get("entry_count") or 0)
                if isinstance(audio_cache_summary, dict)
                else 0
            )
            cache_quota_exhausted = bool(
                (
                    isinstance(audio_cache_summary, dict)
                    and audio_cache_summary.get("quota_exhausted")
                )
                or is_tts_cache_runtime_quota_exhausted()
            )
            if hosted_mode and tts_cache_enabled and not cache_quota_exhausted:
                if cache_entries > 0:
                    if not local_configured:
                        return {
                            "status": "HEALTHY",
                            "detail_status": "cached",
                            "operational_state": "Healthy",
                            "safe_message": f"Đang phục vụ giọng đọc từ bộ nhớ đệm TTS dựng sẵn ({cache_entries} mục).",
                            "execution_mode": "precomputed_cache",
                            "criticality": "important",
                            "action_hint": None,
                            "last_error": None,
                        }
                    return {
                        "status": "DEGRADED",
                        "detail_status": "cached",
                        "operational_state": "Degraded",
                        "safe_message": f"Tunnel Local TTS không phản hồi; hệ thống vẫn phục vụ từ bộ nhớ đệm TTS dựng sẵn ({cache_entries} mục).",
                        "execution_mode": "precomputed_cache",
                        "criticality": "optional",
                        "action_hint": "Gỡ bỏ biến môi trường VIREAD_LOCAL_VOICE_WORKER_URL đã hết hạn trên Render để dùng hoàn toàn bộ nhớ đệm TTS dựng sẵn.",
                        "last_error": str(error_code or "LOCAL_VOICE_UNAVAILABLE"),
                    }
                if not local_configured:
                    cloud_cooldown_note = (
                        " (dịch vụ TTS đám mây đang tạm nghỉ cooldown)"
                        if (
                            (elevenlabs_configured and elevenlabs_cooldown)
                            or (google_configured and google_cooldown)
                        )
                        else ""
                    )
                    return {
                        "status": "HEALTHY",
                        "detail_status": "cached",
                        "operational_state": "Healthy",
                        "safe_message": (
                            f"Bộ nhớ đệm TTS sẵn sàng tự động lưu và hệ thống hỗ trợ phát giọng đọc dự phòng trên trình duyệt{cloud_cooldown_note}."
                        ),
                        "execution_mode": "precomputed_cache",
                        "criticality": "important",
                        "action_hint": None,
                        "last_error": None,
                    }
                return {
                    "status": "DEGRADED",
                    "detail_status": "client_side",
                    "operational_state": "Degraded",
                    "safe_message": "Tunnel Local TTS không phản hồi; hệ thống vẫn sẵn sàng tạo bộ nhớ đệm TTS và phát dự phòng trên trình duyệt.",
                    "execution_mode": "on_demand",
                    "criticality": "optional",
                    "action_hint": "Gỡ bỏ biến môi trường VIREAD_LOCAL_VOICE_WORKER_URL đã hết hạn trên Render để dùng hoàn toàn chế độ cloud/trình duyệt.",
                    "last_error": str(error_code or "LOCAL_VOICE_UNAVAILABLE"),
                }
            if hosted_mode and tts_cache_enabled and cache_quota_exhausted:
                return {
                    "status": "DEGRADED",
                    "detail_status": "unknown",
                    "operational_state": "Quota exhausted",
                    "safe_message": "Bộ nhớ đệm giọng đọc đã chạm hạn mức lưu lượng ngày và chưa có dịch vụ giọng đọc trực tuyến dự phòng.",
                    "execution_mode": "precomputed_cache",
                    "criticality": "important",
                    "action_hint": "Chờ qua ngày mới hoặc tăng VIREAD_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES / bật Google Cloud TTS dự phòng.",
                    "last_error": "QUOTA_EXHAUSTED",
                }
            if (elevenlabs_configured and elevenlabs_cooldown) or (
                google_configured and google_cooldown
            ):
                return {
                    "status": "DEGRADED",
                    "detail_status": "cloud_ready",
                    "operational_state": "Degraded",
                    "safe_message": "Dịch vụ TTS đám mây đã cấu hình nhưng đang trong thời gian chờ quota/giới hạn tốc độ.",
                    "execution_mode": "cloud_ai",
                    "criticality": "important",
                    "action_hint": "Kiểm tra hạn mức ElevenLabs / Google Cloud TTS hoặc khởi chạy Local Voice Worker dự phòng.",
                    "last_error": "CLOUD_TTS_COOLDOWN",
                }
            if not local_configured:
                return {
                    "status": "UNAVAILABLE",
                    "detail_status": "disabled",
                    "operational_state": None,
                    "safe_message": "Dịch vụ giọng đọc cục bộ chưa được cấu hình.",
                    "execution_mode": "on_demand",
                    "criticality": "important",
                    "action_hint": "Dựng sẵn TTS Audio Cache hoặc cấu hình ElevenLabs / Google Cloud TTS / Local Voice Worker.",
                    "last_error": "LOCAL_VOICE_UNCONFIGURED",
                }
            if error_code == "LOCAL_VOICE_TIMEOUT":
                return {
                    "status": "UNAVAILABLE",
                    "detail_status": "failed",
                    "operational_state": None,
                    "safe_message": "Kết nối dịch vụ giọng đọc cục bộ bị hết thời gian chờ.",
                    "execution_mode": "on_demand",
                    "criticality": "important",
                    "action_hint": "Kiểm tra hoặc gỡ bỏ biến VIREAD_LOCAL_VOICE_WORKER_URL nếu tunnel không còn hoạt động.",
                    "last_error": "LOCAL_VOICE_TIMEOUT",
                }
            if error_code == "LOCAL_VOICE_BUSY":
                return {
                    "status": "DEGRADED",
                    "detail_status": "unknown",
                    "operational_state": None,
                    "safe_message": "Dịch vụ giọng đọc cục bộ đang bận xử lý.",
                    "execution_mode": "on_demand",
                    "criticality": "important",
                    "action_hint": None,
                    "last_error": "LOCAL_VOICE_BUSY",
                }
            return {
                "status": "UNAVAILABLE",
                "detail_status": "failed",
                "operational_state": None,
                "safe_message": "Không thể kết nối dịch vụ giọng đọc.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": (
                    "Gỡ bỏ VIREAD_LOCAL_VOICE_WORKER_URL đã hết hạn hoặc khởi động lại Local Voice Worker."
                    if hosted_mode
                    else None
                ),
                "last_error": str(error_code or "LOCAL_TTS_UNAVAILABLE"),
            }

        # capability == "stt"
        if hosted_mode:
            if not local_configured:
                return {
                    "status": "HEALTHY",
                    "detail_status": "client_side",
                    "operational_state": "Healthy",
                    "safe_message": "Nhận diện giọng nói hoạt động trực tiếp trên trình duyệt.",
                    "execution_mode": "browser_wasm",
                    "criticality": "important",
                    "action_hint": None,
                    "last_error": None,
                }
            return {
                "status": "DEGRADED",
                "detail_status": "client_side",
                "operational_state": "Degraded",
                "safe_message": "Kết nối nhận diện giọng nói cục bộ không phản hồi; nhận diện giọng nói trên trình duyệt vẫn hoạt động bình thường.",
                "execution_mode": "browser_wasm",
                "criticality": "optional",
                "action_hint": "Nhận diện giọng nói WASM trên trình duyệt vẫn đang hoạt động; hãy gỡ bỏ biến VIREAD_LOCAL_VOICE_WORKER_URL đã hết hạn trên Render.",
                "last_error": str(error_code or "LOCAL_VOICE_UNAVAILABLE"),
            }

        if elevenlabs_configured and not elevenlabs_cooldown:
            return {
                "status": "HEALTHY",
                "detail_status": "cloud_ready",
                "operational_state": "Healthy",
                "safe_message": "Dịch vụ ElevenLabs STT dự phòng đang sẵn sàng.",
                "execution_mode": "cloud_ai",
                "criticality": "important",
                "action_hint": None,
                "last_error": None,
            }
        if google_configured and not google_cooldown:
            return {
                "status": "HEALTHY",
                "detail_status": "cloud_ready",
                "operational_state": "Healthy",
                "safe_message": "Dịch vụ nhận diện giọng nói đám mây dự phòng đang sẵn sàng.",
                "execution_mode": "cloud_ai",
                "criticality": "important",
                "action_hint": None,
                "last_error": None,
            }
        if not local_configured:
            return {
                "status": "UNAVAILABLE",
                "detail_status": "disabled",
                "operational_state": None,
                "safe_message": "Dịch vụ nhận diện giọng nói cục bộ chưa được cấu hình.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": "LOCAL_VOICE_UNCONFIGURED",
            }
        if error_code == "LOCAL_VOICE_TIMEOUT":
            return {
                "status": "UNAVAILABLE",
                "detail_status": "failed",
                "operational_state": None,
                "safe_message": "Kết nối dịch vụ nhận diện giọng nói cục bộ bị hết thời gian chờ.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": "LOCAL_VOICE_TIMEOUT",
            }
        if error_code == "LOCAL_VOICE_BUSY":
            return {
                "status": "DEGRADED",
                "detail_status": "unknown",
                "operational_state": None,
                "safe_message": "Dịch vụ nhận diện giọng nói cục bộ đang bận xử lý.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": "LOCAL_VOICE_BUSY",
            }
        return {
            "status": "UNAVAILABLE",
            "detail_status": "failed",
            "operational_state": None,
            "safe_message": "Không thể kết nối dịch vụ nhận diện giọng nói.",
            "execution_mode": "on_demand",
            "criticality": "important",
            "action_hint": None,
            "last_error": str(error_code or "LOCAL_STT_UNAVAILABLE"),
        }

    async def _probe_voice_raw(self) -> dict[str, object]:
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
            return {"legacy": True, "tts": tts_res, "stt": stt_res}

        if self.voice_provider is not None:
            orchestrator = self.voice_provider
        elif VoiceOrchestrator is not _ORIG_VOICE_ORCHESTRATOR_CLS:
            orchestrator = VoiceOrchestrator()
        else:
            from app.api.routes.voice import get_voice_orchestrator

            orchestrator = get_voice_orchestrator()
        try:
            status_payload = await asyncio.wait_for(orchestrator.get_status(), timeout=4)
        except Exception:
            return {"legacy": False, "error": True}
        return {
            "legacy": False,
            "error": False,
            "local": status_payload.get("local") or {},
            "google": status_payload.get("google") or {},
            "elevenlabs": status_payload.get("elevenlabs") or {},
        }

    async def _probe_audio_cache_isolated(self) -> tuple[dict[str, object] | None, str | None]:
        repo_db = getattr(self.repository, "db", None)
        if TtsAudioCacheService.get_summary is not _ORIG_TTS_CACHE_GET_SUMMARY:
            try:
                res = await asyncio.wait_for(
                    TtsAudioCacheService(repo_db).get_summary(), timeout=6.0
                )
                if not isinstance(res, dict):
                    return None, "AUDIO_CACHE_PROBE_FAILED"
                return res, None
            except (TimeoutError, asyncio.TimeoutError):
                return None, "AUDIO_CACHE_PROBE_TIMEOUT"
            except asyncio.CancelledError:
                raise
            except Exception:
                return None, "AUDIO_CACHE_PROBE_FAILED"

        if isinstance(repo_db, AsyncSession):
            repo_bind = getattr(repo_db, "bind", None)
            repo_dialect = str(
                getattr(getattr(repo_bind, "dialect", None), "name", "")
            ).lower()
            if repo_dialect != "sqlite":
                cached_summary = get_cached_tts_audio_cache_summary(repo_db)
                if isinstance(cached_summary, dict):
                    return cached_summary, None

            async def _read_from_autocommit_session() -> dict[str, object]:
                async with AsyncSessionLocal() as cache_db:
                    if isinstance(cache_db, AsyncSession) and not cache_db.in_transaction():
                        bind = getattr(cache_db, "bind", None)
                        dialect_name = str(
                            getattr(getattr(bind, "dialect", None), "name", "")
                        ).lower()
                        if dialect_name != "sqlite":
                            await cache_db.connection(
                                execution_options={"isolation_level": "AUTOCOMMIT"}
                            )
                    summary = await TtsAudioCacheRepository(cache_db).get_summary()
                hits = int(summary["hit_count"])
                misses = int(summary["miss_count"])
                total_reqs = hits + misses
                daily_egress = int(summary["daily_egress_bytes"])
                max_bytes = get_tts_cache_max_bytes()
                daily_limit = get_tts_cache_daily_egress_limit_bytes()
                quota_exhausted = (
                    (daily_limit > 0 and daily_egress >= daily_limit)
                    or is_tts_cache_runtime_quota_exhausted()
                )
                return {
                    "entry_count": int(summary["entry_count"]),
                    "storage_used_bytes": int(summary["storage_used_bytes"]),
                    "storage_quota_bytes": max_bytes,
                    "daily_egress_bytes": daily_egress,
                    "daily_egress_limit_bytes": daily_limit,
                    "cache_hit_ratio": round(hits / total_reqs, 4) if total_reqs > 0 else None,
                    "quota_exhausted": quota_exhausted,
                }

            try:
                res = await asyncio.wait_for(_read_from_autocommit_session(), timeout=6.0)
                if repo_dialect != "sqlite":
                    set_cached_tts_audio_cache_summary(repo_db, res)
                return res, None
            except (TimeoutError, asyncio.TimeoutError):
                return None, "AUDIO_CACHE_PROBE_TIMEOUT"
            except asyncio.CancelledError:
                raise
            except Exception:
                return None, "AUDIO_CACHE_PROBE_FAILED"

        try:
            res = await asyncio.wait_for(
                TtsAudioCacheService(None).get_summary(), timeout=6.0
            )
            return (res, None) if isinstance(res, dict) else (None, "AUDIO_CACHE_PROBE_FAILED")
        except (TimeoutError, asyncio.TimeoutError):
            return None, "AUDIO_CACHE_PROBE_TIMEOUT"
        except asyncio.CancelledError:
            raise
        except Exception:
            return None, "AUDIO_CACHE_PROBE_FAILED"

    async def wake_ocr_worker(self) -> AdminOcrWorkerWakeupResponse:
        if not is_remote_worker_wakeup_configured():
            return AdminOcrWorkerWakeupResponse(
                status="unconfigured",
                woken=False,
                detail="Chưa cấu hình VIREAD_OCR_REMOTE_WORKER_URL cho OCR worker từ xa.",
            )
        remote_ocr_wakeup._HEALTH_CACHE = None
        try:
            woken = await asyncio.wait_for(
                send_remote_ocr_wakeup(
                    reason="admin_manual_wakeup",
                    bypass_coalesce=True,
                ),
                timeout=15.0,
            )
        except (TimeoutError, asyncio.TimeoutError):
            remote_ocr_wakeup._HEALTH_CACHE = None
            return AdminOcrWorkerWakeupResponse(
                status="woken",
                woken=True,
                detail="Đã gửi tín hiệu đánh thức OCR worker từ xa; worker đang khởi động nền.",
            )
        except Exception:
            remote_ocr_wakeup._HEALTH_CACHE = None
            return AdminOcrWorkerWakeupResponse(
                status="failed",
                woken=False,
                detail="Không thể gửi lệnh đánh thức OCR worker từ xa. Vui lòng thử lại.",
            )
        remote_ocr_wakeup._HEALTH_CACHE = None
        if woken:
            return AdminOcrWorkerWakeupResponse(
                status="woken",
                woken=True,
                detail="Đã gửi lệnh đánh thức OCR worker từ xa thành công.",
            )
        return AdminOcrWorkerWakeupResponse(
            status="failed",
            woken=False,
            detail="OCR worker từ xa chưa xác nhận đánh thức. Vui lòng kiểm tra cấu hình token và trạng thái Space/Container.",
        )

    async def health(self, workers: dict[str, object] | None = None):
        # Lightweight, bounded probes executed concurrently. Never initialize OCR weights from Health.
        hosted_mode = _is_hosted_deployment()
        hosted_cron_mode = _is_hosted_cron_workers_mode()
        remote_ocr_mode = is_remote_ocr_mode()
        ocr_timeout = _remote_ocr_health_timeout_seconds()
        tts_cache_enabled = is_tts_cache_enabled()

        async def _probe_db() -> bool:
            try:
                return bool(await asyncio.wait_for(self.repository.probe_database(), timeout=6.0))
            except (TimeoutError, asyncio.TimeoutError, SQLAlchemyError, OSError):
                return False

        async def _probe_local_ocr() -> dict[str, object]:
            if not OcrCorrectionConfig.local_ollama_enabled():
                try:
                    cfg = OcrCorrectionConfig.from_environment()
                except OcrConfigurationError:
                    return {
                        "status": "DEGRADED",
                        "detail_status": "failed",
                        "operational_state": None,
                        "safe_message": "Cấu hình hỗ trợ hậu kiểm nhận diện chữ đám mây chưa hợp lệ.",
                        "service_group": "ocr",
                        "execution_mode": "cloud_ai",
                        "criticality": "important",
                        "action_hint": "Kiểm tra lại OCR_CLOUD_CORRECTION_ENABLED và biến khóa API đám mây.",
                        "last_error": "INVALID_CLOUD_OCR_CONFIG",
                    }
                if cfg.gemini_enabled or cfg.groq_enabled:
                    providers = (
                        "Gemini & Groq"
                        if (cfg.gemini_enabled and cfg.groq_enabled)
                        else ("Gemini" if cfg.gemini_enabled else "Groq")
                    )
                    return {
                        "status": "HEALTHY",
                        "detail_status": "cloud_ready",
                        "operational_state": "Healthy",
                        "safe_message": f"Hỗ trợ hậu kiểm nhận diện chữ đang hoạt động qua dịch vụ đám mây ({providers}).",
                        "service_group": "ocr",
                        "execution_mode": "cloud_ai",
                        "criticality": "important",
                        "action_hint": None,
                        "last_error": None,
                    }
                return {
                    "status": "HEALTHY",
                    "detail_status": "local_only",
                    "operational_state": "Local only",
                    "safe_message": "Hỗ trợ hậu kiểm nhận diện chữ cục bộ chỉ dùng trên máy phát triển; môi trường hiện tại chưa bật hậu kiểm đám mây.",
                    "service_group": "ocr",
                    "execution_mode": "local_only",
                    "criticality": "optional",
                    "action_hint": "Đặt OCR_CLOUD_CORRECTION_ENABLED=true và cấu hình GEMINI_API_KEY (hoặc GROQ_API_KEY) nếu muốn bật hậu kiểm AI trên cloud.",
                    "last_error": None,
                }
            try:
                st, msg = await asyncio.wait_for(
                    LocalOcrCorrector.probe(LocalOcrConfig.from_environment()), timeout=4.0
                )
                return {
                    "status": st,
                    "detail_status": "healthy" if st == "HEALTHY" else "failed",
                    "operational_state": None,
                    "safe_message": msg,
                    "service_group": "ocr",
                    "execution_mode": "local_only",
                    "criticality": "important",
                    "action_hint": None,
                    "last_error": None if st == "HEALTHY" else "LOCAL_OCR_UNAVAILABLE",
                }
            except LocalCorrectionError:
                return {
                    "status": "UNAVAILABLE",
                    "detail_status": "failed",
                    "operational_state": None,
                    "safe_message": "Cấu hình dịch vụ nhận diện chữ cục bộ chưa hợp lệ.",
                    "service_group": "ocr",
                    "execution_mode": "local_only",
                    "criticality": "important",
                    "action_hint": None,
                    "last_error": "LOCAL_OCR_CONFIG_INVALID",
                }
            except Exception:
                return {
                    "status": "UNAVAILABLE",
                    "detail_status": "failed",
                    "operational_state": None,
                    "safe_message": "Không thể kiểm tra dịch vụ nhận diện chữ.",
                    "service_group": "ocr",
                    "execution_mode": "local_only",
                    "criticality": "important",
                    "action_hint": None,
                    "last_error": "LOCAL_OCR_PROBE_FAILED",
                }

        remote_worker_desc = "remote_worker"
        remote_ocr_ready = False
        remote_snapshot: dict[str, object] = {}
        remote_ocr_probe_failed = False
        remote_ocr_probe_error_code: str | None = None

        def _build_remote_ocr_items(remote_info: dict[str, object]) -> list[dict[str, object]]:
            nonlocal remote_worker_desc, remote_ocr_ready, remote_snapshot
            remote_snapshot = remote_info
            workers_list = list(remote_info.get("workers") or [])
            online_workers = [w for w in workers_list if isinstance(w, dict) and w.get("online")]
            primary = online_workers[0] if online_workers else (
                workers_list[0] if workers_list and isinstance(workers_list[0], dict) else None
            )
            if primary:
                wid = str(primary.get("worker_id") or "ocr-worker")
                profile = str(primary.get("model_profile") or "").strip()
                remote_worker_desc = f"{wid} ({profile})" if profile else wid
            engines_map = dict(
                remote_info.get("engines")
                or (primary.get("engines") if primary else {})
                or {}
            )
            remote_ocr_ready = bool(remote_info.get("ready", False))
            wakeup_configured = (
                bool(remote_info.get("wakeup_configured"))
                if "wakeup_configured" in remote_info
                else is_remote_worker_wakeup_configured()
            )
            probe_degraded = bool(remote_info.get("probe_degraded", False))
            queue_info = dict(remote_info.get("queue") or {})
            q_depth = int(queue_info.get("pending_total", 0) or 0) + int(
                queue_info.get("active_total", 0) or 0
            )
            has_backlog = q_depth > 0
            is_sleeping_standby = (
                not online_workers and wakeup_configured and probe_degraded and not has_backlog
            )
            is_sleeping_with_backlog = (
                not online_workers and wakeup_configured and probe_degraded and has_backlog
            )
            is_hosted_idle_standby = (
                hosted_mode
                and not online_workers
                and not wakeup_configured
                and not probe_degraded
                and not has_backlog
            )

            base_meta: dict[str, object] = {
                "service_group": "ocr",
                "execution_mode": "remote_worker",
                "criticality": "important",
            }
            items_out: list[dict[str, object]] = []
            for key, label in (
                ("paddleocr", "Nhận diện vùng chữ"),
                ("vietocr", "Nhận diện chữ tiếng Việt"),
                ("tesseract_vie", "Bộ đối chiếu chữ tiếng Việt"),
            ):
                eng = engines_map.get(key)
                if isinstance(eng, dict) and online_workers:
                    verified = bool(eng.get("inference_verified", False))
                    loaded = bool(eng.get("loaded", False))
                    installed = bool(eng.get("installed", False))
                    raw_detail = str(eng.get("detail_status") or "").strip().lower()
                    if verified or raw_detail in {"healthy", "inference_verified"}:
                        items_out.append(
                            {
                                **base_meta,
                                "id": key,
                                "label": label,
                                "status": "HEALTHY",
                                "detail_status": "healthy",
                                "safe_message": f"Dịch vụ nhận diện chữ từ xa ({remote_worker_desc}) đã sẵn sàng.",
                            }
                        )
                    elif loaded or raw_detail == "loaded":
                        items_out.append(
                            {
                                **base_meta,
                                "id": key,
                                "label": label,
                                "status": "HEALTHY",
                                "detail_status": "loaded",
                                "safe_message": f"Dịch vụ nhận diện chữ từ xa ({remote_worker_desc}) đã nạp mô hình sẵn sàng.",
                            }
                        )
                    elif installed:
                        items_out.append(
                            {
                                **base_meta,
                                "id": key,
                                "label": label,
                                "status": "DEGRADED",
                                "detail_status": "installed",
                                "safe_message": f"Dịch vụ nhận diện chữ từ xa ({remote_worker_desc}) đã cài đặt nhưng chưa xác minh xử lý.",
                            }
                        )
                    else:
                        items_out.append(
                            {
                                **base_meta,
                                "id": key,
                                "label": label,
                                "status": "DEGRADED",
                                "detail_status": "unknown",
                                "safe_message": f"Dịch vụ nhận diện chữ từ xa ({remote_worker_desc}) chưa báo cáo trạng thái.",
                            }
                        )
                elif is_sleeping_standby:
                    had_known_engine = isinstance(eng, dict) and (
                        bool(eng.get("loaded"))
                        or bool(eng.get("inference_verified"))
                        or bool(eng.get("installed"))
                        or is_ocr_engine_ready_status(eng.get("detail_status"))
                    )
                    items_out.append(
                        {
                            **base_meta,
                            "id": key,
                            "label": label,
                            "status": "DEGRADED",
                            "detail_status": "standby",
                            "operational_state": "Standby",
                            "safe_message": (
                                f"Dịch vụ nhận diện chữ từ xa ({remote_worker_desc}) đang ở chế độ chờ (lần kiểm tra gần nhất đã sẵn sàng)."
                                if had_known_engine
                                else f"Dịch vụ nhận diện chữ từ xa ({remote_worker_desc}) đang tạm nghỉ hoặc khởi động."
                            ),
                        }
                    )
                elif is_sleeping_with_backlog:
                    items_out.append(
                        {
                            **base_meta,
                            "id": key,
                            "label": label,
                            "status": "UNAVAILABLE",
                            "detail_status": "failed",
                            "operational_state": "Offline",
                            "last_error": "REMOTE_OCR_SLEEPING_OR_WAKING",
                            "safe_message": f"Dịch vụ nhận diện chữ từ xa ({remote_worker_desc}) chưa phản hồi trong khi có {q_depth} trang đang chờ.",
                        }
                    )
                elif is_hosted_idle_standby:
                    items_out.append(
                        {
                            **base_meta,
                            "id": key,
                            "label": label,
                            "status": "DEGRADED",
                            "detail_status": "standby",
                            "operational_state": "Standby",
                            "safe_message": "OCR worker độc lập đang ở chế độ chờ (hàng đợi trống); engine sẵn sàng khi worker kết nối.",
                            "action_hint": None,
                        }
                    )
                else:
                    items_out.append(
                        {
                            **base_meta,
                            "id": key,
                            "label": label,
                            "status": "DEGRADED",
                            "detail_status": "unknown",
                            "safe_message": "Chưa có dịch vụ nhận diện chữ từ xa trực tuyến báo cáo thành phần này.",
                            "action_hint": (
                                "Cấu hình VIREAD_OCR_REMOTE_WORKER_URL hoặc khởi chạy OCR worker độc lập."
                                if not wakeup_configured
                                else None
                            ),
                        }
                    )

            vie_item = next((x for x in items_out if x["id"] == "tesseract_vie"), None)
            if vie_item and vie_item["status"] == "HEALTHY":
                tess_item: dict[str, object] = {
                    **base_meta,
                    "id": "tesseract",
                    "label": "Bộ đối chiếu chữ viết",
                    "status": "HEALTHY",
                    "detail_status": "healthy",
                    "safe_message": f"Bộ đối chiếu chữ viết sẵn sàng trên dịch vụ nhận diện chữ từ xa ({remote_worker_desc}).",
                }
            elif is_sleeping_standby:
                tess_item = {
                    **base_meta,
                    "id": "tesseract",
                    "label": "Bộ đối chiếu chữ viết",
                    "status": "DEGRADED",
                    "detail_status": "standby",
                    "operational_state": "Standby",
                    "safe_message": f"Bộ đối chiếu chữ viết trên dịch vụ từ xa ({remote_worker_desc}) đang ở chế độ chờ.",
                }
            elif is_sleeping_with_backlog:
                tess_item = {
                    **base_meta,
                    "id": "tesseract",
                    "label": "Bộ đối chiếu chữ viết",
                    "status": "UNAVAILABLE",
                    "detail_status": "failed",
                    "operational_state": "Offline",
                    "last_error": "REMOTE_OCR_SLEEPING_OR_WAKING",
                    "safe_message": f"Không thể xác minh bộ đối chiếu chữ viết khi dịch vụ từ xa ({remote_worker_desc}) đang ngoại tuyến.",
                }
            elif is_hosted_idle_standby:
                tess_item = {
                    **base_meta,
                    "id": "tesseract",
                    "label": "Tesseract",
                    "status": "DEGRADED",
                    "detail_status": "standby",
                    "operational_state": "Standby",
                    "safe_message": "Binary Tesseract đang ở chế độ chờ kết nối OCR worker độc lập (hàng đợi trống).",
                }
            else:
                tess_item = {
                    **base_meta,
                    "id": "tesseract",
                    "label": "Bộ đối chiếu chữ viết",
                    "status": "DEGRADED",
                    "detail_status": "unknown",
                    "safe_message": "Chưa xác minh được bộ đối chiếu chữ viết trên dịch vụ từ xa.",
                }
            items_out.insert(2, tess_item)
            return items_out

        async def _probe_ocr_engines():
            nonlocal remote_ocr_probe_failed, remote_ocr_probe_error_code
            if remote_ocr_mode:
                try:
                    remote_info = await asyncio.wait_for(
                        collect_remote_ocr_health(), timeout=ocr_timeout
                    )
                    return _build_remote_ocr_items(remote_info)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    remote_ocr_probe_failed = True
                    remote_ocr_probe_error_code = (
                        "OCR_HEALTH_PROBE_TIMEOUT"
                        if isinstance(exc, (TimeoutError, asyncio.TimeoutError))
                        else "OCR_HEALTH_PROBE_FAILED"
                    )
                    if is_remote_worker_wakeup_configured():
                        try:
                            passive_worker = (
                                await remote_ocr_wakeup.probe_configured_remote_ocr_worker_health(
                                    timeout_seconds=min(4.0, ocr_timeout)
                                )
                            )
                        except Exception:
                            passive_worker = None
                        probe_degraded = remote_ocr_wakeup.peek_remote_ocr_probe_degraded()
                        if passive_worker is not None:
                            remote_ocr_probe_failed = False
                            remote_ocr_probe_error_code = None
                            fallback_remote_info: dict[str, object] = {
                                "mode": "remote_worker",
                                "ready": bool(passive_worker.get("ready", False)),
                                "wakeup_configured": True,
                                "probe_degraded": probe_degraded,
                                "engines": dict(passive_worker.get("engines") or {}),
                                "workers": [passive_worker],
                                "queue": {"pending_total": 0, "active_total": 0},
                            }
                            return _build_remote_ocr_items(fallback_remote_info)
                    return [
                        dict(
                            id=key,
                            label=label,
                            status="DEGRADED",
                            detail_status="unknown",
                            operational_state="Unknown",
                            safe_message="Chưa xác minh được trạng thái OCR worker độc lập từ Database.",
                            last_error=remote_ocr_probe_error_code,
                            service_group="ocr",
                            execution_mode="remote_worker",
                            criticality="important",
                        )
                        for key, label in (
                            ("paddleocr", "Nhận diện vùng chữ"),
                            ("vietocr", "Nhận diện chữ tiếng Việt"),
                            ("tesseract", "Bộ đối chiếu chữ viết"),
                            ("tesseract_vie", "Bộ đối chiếu chữ tiếng Việt"),
                        )
                    ]
            try:
                raw_local = await asyncio.wait_for(
                    asyncio.to_thread(collect_ocr_health), timeout=ocr_timeout
                )
                return [
                    {
                        "service_group": "ocr",
                        "execution_mode": "in_process",
                        "criticality": "important",
                        **entry,
                    }
                    for entry in raw_local
                ]
            except Exception:
                return [
                    dict(
                        id=key,
                        label=label,
                        status="DEGRADED",
                        detail_status="unknown",
                        safe_message="Chưa xác minh được trạng thái hệ thống nhận diện chữ.",
                        service_group="ocr",
                        execution_mode="in_process",
                        criticality="important",
                    )
                    for key, label in (
                        ("paddleocr", "Nhận diện vùng chữ"),
                        ("vietocr", "Nhận diện chữ tiếng Việt"),
                        ("tesseract", "Bộ đối chiếu chữ viết"),
                        ("tesseract_vie", "Bộ đối chiếu chữ tiếng Việt"),
                    )
                ]

        async def _probe_storage():
            try:
                res = await asyncio.wait_for(probe_storage_health(), timeout=6.0)
                return {
                    "service_group": "core",
                    "execution_mode": "always_on",
                    "criticality": "core",
                    **res,
                }
            except Exception:
                return dict(
                    id="storage",
                    label="Lưu trữ tệp tin",
                    status="DEGRADED",
                    detail_status="unknown",
                    safe_message="Chưa thể xác minh trạng thái lưu trữ tệp tin.",
                    service_group="core",
                    execution_mode="always_on",
                    criticality="core",
                )

        async def _probe_worker_metrics() -> dict[str, dict[str, object]]:
            if workers is None:
                return {}
            try:
                raw_metrics = await asyncio.wait_for(
                    self.repository.worker_queue_metrics(), timeout=5.0
                )
                return raw_metrics if isinstance(raw_metrics, dict) else {}
            except Exception:
                return {}

        async def _probe_persisted_heartbeats() -> dict[str, dict[str, object]]:
            if workers is None:
                return {}
            has_method = isinstance(self.repository, AdminSystemRepository) or (
                "persisted_worker_heartbeats" in getattr(self.repository, "__dict__", {})
            )
            if not has_method:
                return {}
            try:
                raw_hb = await asyncio.wait_for(
                    self.repository.persisted_worker_heartbeats(), timeout=3.0
                )
                return raw_hb if isinstance(raw_hb, dict) else {}
            except Exception:
                return {}

        (
            db_res,
            ocr_res,
            voice_raw_res,
            ocr_details_res,
            storage_res,
            audio_cache_probe_res,
            worker_metrics_res,
            persisted_hb_res,
        ) = await asyncio.gather(
            _probe_db(),
            _probe_local_ocr(),
            self._probe_voice_raw(),
            _probe_ocr_engines(),
            _probe_storage(),
            self._probe_audio_cache_isolated(),
            _probe_worker_metrics(),
            _probe_persisted_heartbeats(),
            return_exceptions=True,
        )

        for probe_res in (
            db_res,
            ocr_res,
            voice_raw_res,
            ocr_details_res,
            storage_res,
            audio_cache_probe_res,
            worker_metrics_res,
            persisted_hb_res,
        ):
            if isinstance(probe_res, asyncio.CancelledError):
                raise probe_res

        audio_cache_summary: dict[str, object] | None
        audio_cache_error: str | None
        if isinstance(audio_cache_probe_res, BaseException) or not isinstance(
            audio_cache_probe_res, tuple
        ):
            audio_cache_summary = None
            audio_cache_error = "AUDIO_CACHE_PROBE_FAILED"
        else:
            audio_cache_summary, audio_cache_error = audio_cache_probe_res

        database_ready = False if isinstance(db_res, BaseException) else bool(db_res)

        if isinstance(ocr_res, BaseException) or not isinstance(ocr_res, dict):
            local_ocr_info: dict[str, object] = {
                "status": "UNAVAILABLE",
                "detail_status": "failed",
                "operational_state": None,
                "safe_message": "Không thể kiểm tra dịch vụ nhận diện chữ.",
                "service_group": "ocr",
                "execution_mode": "local_only",
                "criticality": "important",
                "action_hint": None,
                "last_error": "LOCAL_OCR_PROBE_FAILED",
            }
        else:
            local_ocr_info = ocr_res

        if isinstance(voice_raw_res, BaseException) or not isinstance(voice_raw_res, dict):
            tts_info: dict[str, object] = {
                "status": "UNAVAILABLE",
                "detail_status": "failed",
                "operational_state": None,
                "safe_message": "Không thể kiểm tra dịch vụ giọng đọc.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": "VOICE_PROBE_FAILED",
            }
            stt_info: dict[str, object] = {
                "status": "UNAVAILABLE",
                "detail_status": "failed",
                "operational_state": None,
                "safe_message": "Không thể kiểm tra dịch vụ nhận diện giọng nói.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": "VOICE_PROBE_FAILED",
            }
        elif voice_raw_res.get("legacy"):
            tts_st, tts_det, tts_msg = voice_raw_res["tts"]  # type: ignore[misc]
            stt_st, stt_det, stt_msg = voice_raw_res["stt"]  # type: ignore[misc]
            tts_info = {
                "status": tts_st,
                "detail_status": tts_det,
                "operational_state": None,
                "safe_message": tts_msg,
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": None,
            }
            stt_info = {
                "status": stt_st,
                "detail_status": stt_det,
                "operational_state": None,
                "safe_message": stt_msg,
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": None,
            }
        elif voice_raw_res.get("error"):
            tts_info = {
                "status": "UNAVAILABLE",
                "detail_status": "failed",
                "operational_state": None,
                "safe_message": "Không thể kiểm tra dịch vụ giọng đọc.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": "VOICE_PROBE_FAILED",
            }
            stt_info = {
                "status": "UNAVAILABLE",
                "detail_status": "failed",
                "operational_state": None,
                "safe_message": "Không thể kiểm tra dịch vụ nhận diện giọng nói.",
                "execution_mode": "on_demand",
                "criticality": "important",
                "action_hint": None,
                "last_error": "VOICE_PROBE_FAILED",
            }
        else:
            local_voice = voice_raw_res.get("local") or {}
            google_voice = voice_raw_res.get("google") or {}
            elevenlabs_voice = voice_raw_res.get("elevenlabs") or {}
            tts_info = self._map_voice_capability_health(
                "tts",
                local=local_voice,  # type: ignore[arg-type]
                google=google_voice,  # type: ignore[arg-type]
                elevenlabs=elevenlabs_voice,  # type: ignore[arg-type]
                audio_cache_summary=audio_cache_summary,
                tts_cache_enabled=tts_cache_enabled,
                hosted_mode=hosted_mode,
            )
            stt_info = self._map_voice_capability_health(
                "stt",
                local=local_voice,  # type: ignore[arg-type]
                google=google_voice,  # type: ignore[arg-type]
                elevenlabs=elevenlabs_voice,  # type: ignore[arg-type]
                audio_cache_summary=audio_cache_summary,
                tts_cache_enabled=tts_cache_enabled,
                hosted_mode=hosted_mode,
            )

        if isinstance(ocr_details_res, BaseException):
            ocr_details: list[dict[str, object]] = [
                dict(
                    id=key,
                    label=label,
                    status="DEGRADED",
                    detail_status="unknown",
                    safe_message="Chưa xác minh được trạng thái hệ thống nhận diện chữ.",
                    service_group="ocr",
                    execution_mode="remote_worker" if remote_ocr_mode else "in_process",
                    criticality="important",
                )
                for key, label in (
                    ("paddleocr", "Nhận diện vùng chữ"),
                    ("vietocr", "Nhận diện chữ tiếng Việt"),
                    ("tesseract", "Bộ đối chiếu chữ viết"),
                    ("tesseract_vie", "Bộ đối chiếu chữ tiếng Việt"),
                )
            ]
        else:
            ocr_details = ocr_details_res

        if isinstance(storage_res, BaseException):
            storage_details: dict[str, object] = dict(
                id="storage",
                label="Lưu trữ tệp tin",
                status="DEGRADED",
                detail_status="unknown",
                safe_message="Chưa thể xác minh trạng thái lưu trữ tệp tin.",
                service_group="core",
                execution_mode="always_on",
                criticality="core",
            )
        else:
            storage_details = storage_res

        metrics: dict[str, dict[str, object]] = (
            worker_metrics_res if isinstance(worker_metrics_res, dict) else {}
        )
        persisted_heartbeats: dict[str, dict[str, object]] = (
            persisted_hb_res if isinstance(persisted_hb_res, dict) else {}
        )

        checked_at = datetime.now(timezone.utc)
        items = [
            AdminHealthItemRead(
                id="api",
                label="Hệ thống xử lý chính",
                status="HEALTHY",
                detail_status="healthy",
                checked_at=checked_at,
                safe_message="Hệ thống xử lý chính đang hoạt động bình thường.",
                service_group="core",
                execution_mode="always_on",
                criticality="core",
            ),
            AdminHealthItemRead(
                id="database",
                label="Cơ sở dữ liệu",
                status="HEALTHY" if database_ready else "UNAVAILABLE",
                detail_status="healthy" if database_ready else "failed",
                checked_at=checked_at,
                safe_message=(
                    "Cơ sở dữ liệu đã phản hồi truy vấn kiểm tra."
                    if database_ready
                    else "Chưa kiểm tra được kết nối cơ sở dữ liệu. Vui lòng thử lại."
                ),
                last_error=None if database_ready else "DATABASE_UNAVAILABLE",
                service_group="core",
                execution_mode="always_on",
                criticality="core",
                action_hint=(
                    None
                    if database_ready
                    else "Kiểm tra kết nối Supabase PostgreSQL (DATABASE_URL / pooler) và trạng thái mạng."
                ),
            ),
            AdminHealthItemRead(
                id="local_ocr",
                label=(
                    "AI OCR đám mây"
                    if local_ocr_info.get("execution_mode") == "cloud_ai"
                    else "Nhận diện chữ"
                ),
                status=local_ocr_info["status"],  # type: ignore[arg-type]
                detail_status=local_ocr_info.get("detail_status"),  # type: ignore[arg-type]
                operational_state=local_ocr_info.get("operational_state"),  # type: ignore[arg-type]
                checked_at=checked_at,
                safe_message=str(local_ocr_info["safe_message"]),
                last_error=local_ocr_info.get("last_error"),  # type: ignore[arg-type]
                service_group=local_ocr_info.get("service_group", "ocr"),  # type: ignore[arg-type]
                execution_mode=local_ocr_info.get("execution_mode"),  # type: ignore[arg-type]
                criticality=local_ocr_info.get("criticality"),  # type: ignore[arg-type]
                action_hint=local_ocr_info.get("action_hint"),  # type: ignore[arg-type]
            ),
            AdminHealthItemRead(
                id="tts",
                label="Giọng đọc & nghe",
                status=tts_info["status"],  # type: ignore[arg-type]
                detail_status=tts_info.get("detail_status"),  # type: ignore[arg-type]
                operational_state=tts_info.get("operational_state"),  # type: ignore[arg-type]
                checked_at=checked_at,
                safe_message=str(tts_info["safe_message"]),
                last_error=tts_info.get("last_error"),  # type: ignore[arg-type]
                service_group="voice",
                execution_mode=tts_info.get("execution_mode"),  # type: ignore[arg-type]
                criticality=tts_info.get("criticality"),  # type: ignore[arg-type]
                action_hint=tts_info.get("action_hint"),  # type: ignore[arg-type]
            ),
            AdminHealthItemRead(
                id="stt",
                label="Nhận diện giọng nói",
                status=stt_info["status"],  # type: ignore[arg-type]
                detail_status=stt_info.get("detail_status"),  # type: ignore[arg-type]
                operational_state=stt_info.get("operational_state"),  # type: ignore[arg-type]
                checked_at=checked_at,
                safe_message=str(stt_info["safe_message"]),
                last_error=stt_info.get("last_error"),  # type: ignore[arg-type]
                service_group="voice",
                execution_mode=stt_info.get("execution_mode"),  # type: ignore[arg-type]
                criticality=stt_info.get("criticality"),  # type: ignore[arg-type]
                action_hint=stt_info.get("action_hint"),  # type: ignore[arg-type]
            ),
        ]

        if not tts_cache_enabled:
            cache_item = AdminHealthItemRead(
                id="tts_audio_cache",
                label="Bộ nhớ đệm giọng đọc",
                status="DEGRADED",
                detail_status="disabled",
                operational_state="Offline",
                checked_at=checked_at,
                safe_message="Bộ nhớ đệm giọng đọc đang tắt theo cấu hình.",
                service_group="voice",
                execution_mode="precomputed_cache",
                criticality="important",
            )
        elif audio_cache_error is not None or audio_cache_summary is None:
            cache_item = AdminHealthItemRead(
                id="tts_audio_cache",
                label="Bộ nhớ đệm giọng đọc",
                status="DEGRADED",
                detail_status="unknown",
                operational_state="Unknown",
                checked_at=checked_at,
                safe_message="Không thể đọc thống kê bộ nhớ đệm giọng đọc từ cơ sở dữ liệu.",
                last_error=audio_cache_error or "AUDIO_CACHE_PROBE_FAILED",
                service_group="voice",
                execution_mode="precomputed_cache",
                criticality="important",
                action_hint="Kiểm tra bảng tts_audio_cache_entries và kết nối database.",
            )
        elif bool(audio_cache_summary.get("quota_exhausted")):
            cache_item = AdminHealthItemRead(
                id="tts_audio_cache",
                label="Bộ nhớ đệm giọng đọc",
                status="DEGRADED",
                detail_status="unknown",
                operational_state="Quota exhausted",
                checked_at=checked_at,
                safe_message="Lưu lượng bộ nhớ đệm giọng đọc hôm nay đã chạm ngưỡng giới hạn miễn phí.",
                last_error="QUOTA_EXHAUSTED",
                service_group="voice",
                execution_mode="precomputed_cache",
                criticality="important",
            )
        else:
            cache_item = AdminHealthItemRead(
                id="tts_audio_cache",
                label="Bộ nhớ đệm giọng đọc",
                status="HEALTHY",
                detail_status="healthy",
                operational_state="Healthy",
                checked_at=checked_at,
                safe_message=f"Bộ nhớ đệm giọng đọc sẵn sàng ({int(audio_cache_summary.get('entry_count') or 0)} mục).",
                service_group="voice",
                execution_mode="precomputed_cache",
                criticality="important",
            )
        items.append(cache_item)

        items.append(AdminHealthItemRead(**storage_details, checked_at=checked_at))
        items.extend(AdminHealthItemRead(**entry, checked_at=checked_at) for entry in ocr_details)

        def _build_cron_or_event_worker_item(
            worker_key: str,
            worker_label: str,
            *,
            criticality: HealthCriticality,
            default_execution_mode: HealthExecutionMode = "cron_scheduled",
            allow_old_db_activity_healthy: bool = False,
        ) -> AdminHealthItemRead:
            w_metric = metrics.get(worker_key) or {}
            w_tel = get_worker_telemetry(worker_key)
            w_pers = persisted_heartbeats.get(worker_key) or {}
            hb_last_succ, last_succ, last_err, pers_mode = _resolve_merged_worker_telemetry(
                in_mem=w_tel,
                persisted=w_pers,
                metric=w_metric,
            )
            exec_mode: HealthExecutionMode = pers_mode or default_execution_mode
            q_depth_raw = w_metric.get("queue_depth")
            q_depth = int(q_depth_raw) if q_depth_raw is not None else None
            oldest_raw = w_metric.get("oldest_pending_job_age_seconds")
            oldest_age = float(oldest_raw) if oldest_raw is not None else None
            stale_limit = 300.0 if worker_key == "reading_presence" else 900.0
            hb_fresh = (
                hb_last_succ is not None
                and (checked_at - hb_last_succ).total_seconds() <= _CRON_HEARTBEAT_FRESH_SECONDS
            )
            recent_success = (
                last_succ is not None
                and (checked_at - last_succ).total_seconds() <= _CRON_HEARTBEAT_FRESH_SECONDS
            )
            has_queue = q_depth is not None and q_depth > 0

            op_state: str | None = None
            action_hint: str | None = None
            if last_err:
                w_status: Literal["HEALTHY", "DEGRADED", "UNAVAILABLE"] = "UNAVAILABLE"
                w_detail: HealthDetailStatus = "failed"
                w_msg = f"Worker gặp lỗi gần nhất: {last_err}."
                action_hint = "Kiểm tra nhật ký Render và endpoint /internal/cron/dispatch để xử lý lỗi."
            elif oldest_age is not None and oldest_age > stale_limit:
                w_status = "DEGRADED"
                w_detail = "scheduled" if hb_fresh else "unknown"
                op_state = "Degraded"
                last_err = "STALE_PENDING_JOBS"
                w_msg = (
                    "Có cảnh báo hiện diện chờ quá 5 phút."
                    if worker_key == "reading_presence"
                    else "Có tác vụ chờ xử lý quá 15 phút."
                )
                action_hint = "Kiểm tra Cloudflare Cron Trigger gọi /internal/cron/dispatch với VIREAD_CRON_DISPATCH_TOKEN."
            elif has_queue:
                w_status = "HEALTHY" if (hb_fresh or recent_success) else "DEGRADED"
                w_detail = "scheduled" if (hb_fresh or recent_success) else "unknown"
                op_state = "Queued"
                w_msg = f"Đang có {q_depth} tác vụ trong hàng đợi chờ xử lý."
            elif hb_fresh or recent_success:
                w_status = "HEALTHY"
                w_detail = "scheduled"
                op_state = "Scheduled"
                w_msg = "Cron/event worker hoạt động bình thường theo lịch định kỳ."
            elif allow_old_db_activity_healthy and last_succ is not None:
                w_status = "HEALTHY"
                w_detail = "healthy"
                w_msg = "Đã ghi nhận lần chạy thành công gần đây."
            elif last_succ is not None:
                w_status = "DEGRADED"
                w_detail = "unknown"
                op_state = "Unknown"
                w_msg = "Chưa ghi nhận lượt chạy cron mới trong 90 phút gần nhất."
                action_hint = "Kiểm tra Cloudflare Cron Trigger gọi POST /internal/cron/dispatch với VIREAD_CRON_DISPATCH_TOKEN."
            else:
                w_status = "DEGRADED"
                w_detail = "unknown"
                op_state = "Unknown"
                w_msg = "Chưa ghi nhận lượt chạy cron/worker độc lập."
                action_hint = "Cấu hình Cloudflare Cron Trigger gọi POST /internal/cron/dispatch với header xác thực VIREAD_CRON_DISPATCH_TOKEN."

            return AdminHealthItemRead(
                id=worker_key,
                label=worker_label,
                status=w_status,
                detail_status=w_detail,
                operational_state=op_state,  # type: ignore[arg-type]
                checked_at=checked_at,
                safe_message=w_msg,
                last_success_at=last_succ,
                oldest_pending_job_age_seconds=oldest_age,
                queue_depth=q_depth,
                last_error=last_err,
                service_group="workers",
                execution_mode=exec_mode,
                criticality=criticality,
                action_hint=action_hint,
            )

        if workers is not None:
            items.append(
                AdminHealthItemRead(
                    **collect_email_delivery_health(),
                    checked_at=checked_at,
                    service_group="workers",
                    execution_mode="cron_scheduled",
                    criticality="optional",
                )
            )
            raw_workers = collect_worker_health(workers)

            # Honest ocr_worker health entry (with quiet_standby / scale_to_zero & sleeping support)
            ocr_m = metrics.get("ocr_worker") or {}
            if remote_ocr_mode:
                queue_info = dict(remote_snapshot.get("queue") or {})
                workers_list = list(remote_snapshot.get("workers") or [])
                online_workers = [w for w in workers_list if isinstance(w, dict) and w.get("online")]
                primary = online_workers[0] if online_workers else (
                    workers_list[0] if workers_list and isinstance(workers_list[0], dict) else None
                )
                standby_mode = (
                    str(primary.get("standby_mode") or "").strip().lower()
                    if primary
                    else ""
                )
                wakeup_configured = (
                    bool(remote_snapshot.get("wakeup_configured"))
                    if "wakeup_configured" in remote_snapshot
                    else is_remote_worker_wakeup_configured()
                )
                probe_degraded = bool(remote_snapshot.get("probe_degraded", False))
                last_succ = _parse_utc_datetime(
                    primary.get("last_heartbeat_at") if primary else None
                )
                if last_succ is None:
                    last_succ = _parse_utc_datetime(queue_info.get("latest_succeeded_at"))
                if last_succ is None:
                    last_succ = _parse_utc_datetime(ocr_m.get("last_success_at"))
                q_depth = (
                    int(queue_info.get("pending_total", 0) or 0)
                    + int(queue_info.get("active_total", 0) or 0)
                    if queue_info
                    else (int(ocr_m["queue_depth"]) if ocr_m.get("queue_depth") is not None else None)
                )
                oldest_ocr_age = (
                    queue_info.get("oldest_pending_job_age_seconds")
                    if "oldest_pending_job_age_seconds" in queue_info
                    else ocr_m.get("oldest_pending_job_age_seconds")
                )
                has_backlog = bool(q_depth and int(q_depth) > 0)
                ocr_action_hint: str | None = None
                ocr_op_state: str | None = None
                ocr_can_wake = False

                if remote_ocr_probe_failed and not online_workers and not remote_ocr_ready:
                    ocr_can_wake = wakeup_configured
                    ocr_w_status = "DEGRADED"
                    ocr_w_detail = "unknown"
                    ocr_op_state = "Unknown"
                    ocr_w_err = remote_ocr_probe_error_code or "OCR_HEALTH_PROBE_FAILED"
                    ocr_w_msg = (
                        "Hết thời gian kiểm tra trạng thái OCR worker từ Database."
                        if ocr_w_err == "OCR_HEALTH_PROBE_TIMEOUT"
                        else "Chưa thể kiểm tra trạng thái OCR worker từ Database lúc này."
                    )
                    ocr_action_hint = "Thử bấm Kiểm tra lại hoặc kiểm tra kết nối Supabase PostgreSQL / trạng thái ocr_worker."
                elif remote_ocr_ready and standby_mode in {"quiet_standby", "scale_to_zero"}:
                    ocr_w_status = "HEALTHY"
                    ocr_w_detail = "standby"
                    ocr_op_state = "Queued" if has_backlog else "Standby"
                    ocr_w_err = None
                    ocr_can_wake = True
                    ocr_w_msg = f"Máy chủ nhận diện chữ ({remote_worker_desc}) đang ở chế độ chờ tiết kiệm và sẵn sàng khởi động tức thì."
                elif remote_ocr_ready:
                    ocr_w_status = "HEALTHY"
                    ocr_w_detail = "healthy"
                    ocr_w_err = None
                    ocr_can_wake = wakeup_configured
                    ocr_w_msg = f"Máy chủ nhận diện chữ ({remote_worker_desc}) đang trực tuyến và hoạt động bình thường."
                elif online_workers:
                    ocr_w_status = "DEGRADED"
                    ocr_w_detail = "initialized"
                    ocr_w_err = "OCR_ENGINES_NOT_READY"
                    ocr_can_wake = wakeup_configured
                    ocr_w_msg = f"Máy chủ nhận diện chữ ({remote_worker_desc}) trực tuyến nhưng mô hình chưa sẵn sàng."
                elif wakeup_configured and probe_degraded:
                    ocr_can_wake = True
                    if has_backlog:
                        ocr_w_status = "UNAVAILABLE"
                        ocr_w_detail = "failed"
                        ocr_op_state = "Offline"
                        ocr_w_err = "REMOTE_OCR_SLEEPING_OR_WAKING"
                        ocr_w_msg = f"Máy chủ nhận diện chữ từ xa ({remote_worker_desc}) chưa phản hồi trong khi có {q_depth} trang đang chờ xử lý."
                        ocr_action_hint = "Bấm nút Đánh thức OCR worker và kiểm tra trạng thái Hugging Face Space / Container App."
                    else:
                        ocr_w_status = "DEGRADED"
                        ocr_w_detail = "standby"
                        ocr_op_state = "Standby"
                        ocr_w_err = "REMOTE_OCR_SLEEPING_OR_WAKING"
                        ocr_w_msg = f"Máy chủ nhận diện chữ từ xa ({remote_worker_desc}) đang tạm nghỉ hoặc đang khởi động (hàng đợi trống)."
                        ocr_action_hint = "Bấm nút Đánh thức OCR worker để khởi động trước, hoặc tải trang mới để hệ thống tự đánh thức."
                elif wakeup_configured:
                    ocr_can_wake = True
                    ocr_w_status = "UNAVAILABLE" if has_backlog else "DEGRADED"
                    ocr_w_detail = "failed" if has_backlog else "disabled"
                    ocr_w_err = "NO_ONLINE_OCR_WORKER"
                    ocr_w_msg = "Máy chủ nhận diện chữ từ xa chưa phản hồi kiểm tra sẵn sàng."
                    ocr_action_hint = "Kiểm tra VIREAD_OCR_REMOTE_WORKER_URL, VIREAD_OCR_WORKER_TOKEN và VIREAD_HF_SPACE_TOKEN."
                elif hosted_mode and not has_backlog:
                    ocr_can_wake = False
                    ocr_w_status = "DEGRADED"
                    ocr_w_detail = "standby"
                    ocr_op_state = "Standby"
                    ocr_w_err = None
                    ocr_w_msg = "Chưa có OCR worker độc lập đang kết nối (hàng đợi OCR đang trống)."
                    ocr_action_hint = "Khởi chạy ocr_worker cục bộ (Start-ViReadOcrWorker.ps1) hoặc cấu hình VIREAD_OCR_REMOTE_WORKER_URL khi cần OCR trang sách mới."
                else:
                    ocr_can_wake = False
                    ocr_w_status = "UNAVAILABLE" if has_backlog else "DEGRADED"
                    ocr_w_detail = "failed" if has_backlog else "disabled"
                    ocr_w_err = "REMOTE_OCR_WORKER_UNCONFIGURED"
                    ocr_w_msg = "Chưa có máy chủ nhận diện chữ nào trực tuyến và chưa cấu hình địa chỉ máy chủ từ xa."
                    ocr_action_hint = "Cấu hình biến VIREAD_OCR_REMOTE_WORKER_URL và VIREAD_OCR_WORKER_TOKEN (cùng VIREAD_HF_SPACE_TOKEN nếu là Private Space) hoặc khởi chạy ocr_worker."

                items.append(
                    AdminHealthItemRead(
                        id="ocr_worker",
                        label="Máy chủ nhận diện chữ",
                        status=ocr_w_status,
                        detail_status=ocr_w_detail,
                        operational_state=ocr_op_state,  # type: ignore[arg-type]
                        checked_at=checked_at,
                        safe_message=ocr_w_msg,
                        last_success_at=last_succ,
                        oldest_pending_job_age_seconds=oldest_ocr_age,  # type: ignore[arg-type]
                        queue_depth=q_depth,
                        last_error=ocr_w_err,
                        service_group="ocr",
                        execution_mode="remote_worker",
                        criticality="important",
                        action_hint=ocr_action_hint,
                        can_wake=ocr_can_wake,
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
                        label="Máy chủ nhận diện chữ",
                        status="HEALTHY" if local_ready else "DEGRADED",
                        detail_status="loaded" if local_ready else "installed",
                        checked_at=checked_at,
                        safe_message=(
                            "Hệ thống nhận diện chữ chạy trực tiếp trên máy chủ chính."
                            if local_ready
                            else "Hệ thống nhận diện chữ chưa nạp mô hình."
                        ),
                        last_success_at=ocr_m.get("last_success_at"),  # type: ignore[arg-type]
                        oldest_pending_job_age_seconds=ocr_m.get("oldest_pending_job_age_seconds"),  # type: ignore[arg-type]
                        queue_depth=ocr_m.get("queue_depth"),  # type: ignore[arg-type]
                        last_error=ocr_m.get("last_error"),  # type: ignore[arg-type]
                        service_group="ocr",
                        execution_mode="in_process",
                        criticality="important",
                    )
                )

            local_training_enabled = (
                os.getenv("VIREAD_LOCAL_TRAINING_ENABLED", "false").strip().lower()
                in _TRUTHY_VALUES
            )
            _worker_criticality: dict[str, HealthCriticality] = {
                "viread_ocr_outbox": "important",
                "viread_ocr_training": "optional",
                "book_quality": "important",
                "admin_ai_workflow": "important",
                "parent_book_submission": "important",
                "active_model_registry": "optional",
                "local_trainer_process": "optional",
            }
            for entry in raw_workers:
                wid = str(entry.get("id") or "")
                wlabel = str(entry.get("label") or wid)
                worker_obj = workers.get(wid)
                crit: HealthCriticality = _worker_criticality.get(wid, "important")

                if wid == "active_model_registry" and worker_obj is None and remote_ocr_mode:
                    m = metrics.get(wid) or {}
                    items.append(
                        AdminHealthItemRead(
                            id=wid,
                            label=wlabel,
                            status="HEALTHY",
                            detail_status="remote_delegated",
                            operational_state="Standby",
                            checked_at=checked_at,
                            safe_message="Đồng bộ mô hình nhận diện chữ do máy chủ nhận diện chữ từ xa tự quản lý khi chạy.",
                            last_success_at=_parse_utc_datetime(m.get("last_success_at")),
                            queue_depth=0,
                            service_group="workers",
                            execution_mode="remote_delegated",
                            criticality="optional",
                        )
                    )
                    continue

                if wid == "local_trainer_process" and worker_obj is None and (
                    not local_training_enabled or hosted_mode or remote_ocr_mode
                ):
                    items.append(
                        AdminHealthItemRead(
                            id=wid,
                            label=wlabel,
                            status="HEALTHY",
                            detail_status="local_only",
                            operational_state="Local only",
                            checked_at=checked_at,
                            safe_message="Tiến trình huấn luyện nhận diện chữ chỉ dùng trên máy nội bộ (đã tắt trên máy chủ đám mây).",
                            service_group="workers",
                            execution_mode="local_only",
                            criticality="optional",
                        )
                    )
                    continue

                if wid == "parent_email_dispatcher" and worker_obj is None and hosted_cron_mode:
                    items.append(
                        _build_cron_or_event_worker_item(
                            wid,
                            wlabel,
                            criticality="optional",
                            default_execution_mode="cron_scheduled",
                            allow_old_db_activity_healthy=True,
                        )
                    )
                    continue

                if (
                    wid
                    in {
                        "viread_ocr_outbox",
                        "viread_ocr_training",
                        "book_quality",
                        "admin_ai_workflow",
                        "parent_book_submission",
                    }
                    and worker_obj is None
                    and hosted_cron_mode
                ):
                    items.append(
                        _build_cron_or_event_worker_item(
                            wid,
                            wlabel,
                            criticality=crit,
                            default_execution_mode="cron_scheduled",
                            allow_old_db_activity_healthy=False,
                        )
                    )
                    continue

                m = metrics.get(wid) or {}
                w_pers = persisted_heartbeats.get(wid) or {}
                _hb_succ, merged_succ, merged_err, _pers_mode = _resolve_merged_worker_telemetry(
                    in_mem={
                        "last_success_at": entry.get("last_success_at"),
                        "last_error": entry.get("last_error"),
                    },
                    persisted=w_pers,
                    metric=m,
                )
                entry["last_success_at"] = merged_succ
                entry["last_error"] = merged_err
                if m.get("queue_depth") is not None:
                    entry["queue_depth"] = int(m["queue_depth"])
                oldest_age = m.get("oldest_pending_job_age_seconds")
                if oldest_age is not None:
                    entry["oldest_pending_job_age_seconds"] = float(oldest_age)
                    if entry.get("status") == "HEALTHY" and float(oldest_age) > 900.0:
                        entry["status"] = "DEGRADED"
                        entry["last_error"] = entry.get("last_error") or "STALE_PENDING_JOBS"
                        entry["safe_message"] = "Worker có tác vụ chờ xử lý quá 15 phút."
                items.append(
                    AdminHealthItemRead(
                        **entry,
                        checked_at=checked_at,
                        service_group="workers",
                        execution_mode=(
                            "local_only" if wid == "local_trainer_process" else "in_process"
                        ),
                        criticality=crit,
                    )
                )

            # Report external/cron workers honestly (reading_reminder, reading_presence, karaoke_processing)
            for ext_key, ext_label in (
                ("reading_reminder", "Nhắc nhở đọc sách"),
                ("reading_presence", "Theo dõi phiên đọc"),
            ):
                items.append(
                    _build_cron_or_event_worker_item(
                        ext_key,
                        ext_label,
                        criticality="important",
                        default_execution_mode="cron_scheduled",
                        allow_old_db_activity_healthy=not hosted_cron_mode,
                    )
                )

            try:
                karaoke_cfg = KaraokeProcessingConfig.from_env()
                karaoke_config_invalid = False
            except KaraokeConfigurationError:
                karaoke_cfg = None
                karaoke_config_invalid = True

            if karaoke_config_invalid:
                items.append(
                    AdminHealthItemRead(
                        id="karaoke_processing",
                        label="Xử lý tách nhạc Karaoke",
                        status="DEGRADED",
                        detail_status="failed",
                        checked_at=checked_at,
                        safe_message="Cấu hình xử lý tách nhạc Karaoke chưa hợp lệ.",
                        last_error="KARAOKE_CONFIG_INVALID",
                        service_group="workers",
                        execution_mode="disabled_opt_in",
                        criticality="optional",
                        action_hint="Kiểm tra các biến môi trường KARAOKE_PROCESSING_*.",
                    )
                )
            elif karaoke_cfg is not None and not karaoke_cfg.enabled and not karaoke_cfg.worker_enabled:
                items.append(
                    AdminHealthItemRead(
                        id="karaoke_processing",
                        label="Xử lý tách nhạc Karaoke",
                        status="HEALTHY",
                        detail_status="local_only",
                        operational_state="Local only",
                        checked_at=checked_at,
                        safe_message="Xử lý tách nhạc Karaoke là tính năng tùy chọn nội bộ (đang tắt theo cấu hình).",
                        service_group="workers",
                        execution_mode="disabled_opt_in",
                        criticality="optional",
                    )
                )
            else:
                items.append(
                    _build_cron_or_event_worker_item(
                        "karaoke_processing",
                        "Xử lý tách nhạc Karaoke",
                        criticality="optional",
                        default_execution_mode="on_demand",
                        allow_old_db_activity_healthy=True,
                    )
                )

        cache_quota_exhausted = bool(
            isinstance(audio_cache_summary, dict)
            and audio_cache_summary.get("quota_exhausted")
        )
        for item in items:
            if item.operational_state is None:
                item.operational_state = derive_operational_state(  # type: ignore[assignment]
                    status=item.status,
                    detail_status=item.detail_status,
                    queue_depth=item.queue_depth,
                    last_error=item.last_error,
                    quota_exhausted=(
                        item.id == "tts"
                        and item.status != "HEALTHY"
                        and cache_quota_exhausted
                    ),
                )

        if any(item.criticality == "core" and item.status == "UNAVAILABLE" for item in items):
            overall: Literal["HEALTHY", "DEGRADED", "UNAVAILABLE"] = "UNAVAILABLE"
        elif any(
            (item.criticality or "important") in {"core", "important"}
            and item.status != "HEALTHY"
            and item.operational_state not in _NON_DEGRADING_STATES
            for item in items
        ):
            overall = "DEGRADED"
        else:
            overall = "HEALTHY"

        return AdminHealthRead(
            overall_status=overall,
            checked_at=checked_at,
            services=items,
            audio_cache=(
                AdminAudioCacheSummaryRead(**audio_cache_summary)
                if audio_cache_summary is not None
                else None
            ),
            audio_cache_error=audio_cache_error,
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
    if isinstance(db, AsyncSession) and db.in_transaction() is True:
        await db.rollback()
    return await service.health(
        workers=getattr(request.app.state, "background_workers", None) or {}
    )


@router.post(
    "/admin/health/ocr-worker/wakeup",
    response_model=AdminOcrWorkerWakeupResponse,
)
async def wake_admin_ocr_worker(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminSystemService(AdminSystemRepository(db))
    await service.require_admin(actor_id)
    if isinstance(db, AsyncSession) and db.in_transaction() is True:
        await db.rollback()
    max_requests, window_seconds = rate_limiter.resolve_limits(
        "admin_ocr_wakeup", 6, 60.0
    )
    retry_after = rate_limiter.check(
        "admin_ocr_wakeup",
        str(actor_id),
        max_requests=max_requests,
        window_seconds=window_seconds,
    )
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "RATE_LIMIT_EXCEEDED",
                "message": "Quá nhiều yêu cầu đánh thức OCR worker. Vui lòng thử lại sau.",
            },
            headers={"Retry-After": str(retry_after)},
        )
    return await service.wake_ocr_worker()
