from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List

from app.api.deps import get_db
from app.models import ProgressReport, ConsentRecord, AuditLog
from app.schemas import (
    ProgressReportResponse, ProgressReportCreate,
    ConsentRecordResponse, ConsentRecordCreate,
    AuditLogResponse, AuditLogCreate
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


from datetime import date, datetime, timedelta, timezone
from uuid import UUID
from fastapi import HTTPException
from pydantic import ValidationError, TypeAdapter
from app.api.deps import get_current_parent_id
from app.api.routes.reading import HistoryRepository, HistoryService
from app.schemas.system import (ProgressRead, DifficultWordRead, SavedProgressPeriodRead,
    ProgressPeriodRead, ProgressTrendRead, ProgressLegacyRead, ProgressPeriodOptionRead, ProgressPeriodsRead)


class ProgressRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def report(self, child_id: UUID, period_start: date, period_end: date, actor_id: UUID):
        from app.models import ChildProfile
        return await self.db.scalar(
            select(ProgressReport).join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
            .where(ProgressReport.ChildId == child_id, ChildProfile.ParentId == actor_id,
                   ProgressReport.PeriodStart == period_start, ProgressReport.PeriodEnd == period_end)
            .order_by(ProgressReport.GeneratedAt.desc(), ProgressReport.Id.desc()).limit(1)
        )

    async def latest(self, child_id: UUID, actor_id: UUID):
        from app.models import ChildProfile
        return await self.db.scalar(
            select(ProgressReport).join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
            .where(ProgressReport.ChildId == child_id, ChildProfile.ParentId == actor_id)
            .order_by(ProgressReport.PeriodEnd.desc(), ProgressReport.PeriodStart.desc(),
                      ProgressReport.GeneratedAt.desc(), ProgressReport.Id.desc()).limit(1)
        )

    async def periods(self, child_id: UUID, actor_id: UUID, offset: int, limit: int):
        from app.models import ChildProfile
        from sqlalchemy import func
        # Rank before paging so duplicate generations never consume a period slot.
        ranked = select(
            ProgressReport.Id.label("id"), ProgressReport.ChildId.label("child_id"),
            ProgressReport.PeriodStart.label("period_start"), ProgressReport.PeriodEnd.label("period_end"),
            ProgressReport.GeneratedAt.label("generated_at"),
            func.row_number().over(partition_by=(ProgressReport.PeriodStart, ProgressReport.PeriodEnd),
                order_by=(ProgressReport.GeneratedAt.desc(), ProgressReport.Id.desc())).label("rank")
        ).join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id).where(
            ProgressReport.ChildId == child_id, ChildProfile.ParentId == actor_id).subquery()
        result = await self.db.execute(select(ranked).where(ranked.c.rank == 1)
            .order_by(ranked.c.period_end.desc(), ranked.c.period_start.desc(),
                      ranked.c.generated_at.desc(), ranked.c.id.desc()).offset(offset).limit(limit))
        return result.mappings().all()


class ProgressService:
    def __init__(self, repository: ProgressRepository, access: HistoryService):
        self.repository = repository
        self.access = access

    async def periods(self, child_id: UUID, actor_id: UUID, cursor: str | None, limit: int):
        import re
        await self.access.require_child(child_id, actor_id)
        if not 1 <= limit <= 100 or (cursor is not None and
                re.fullmatch(r"page-[1-9][0-9]{0,5}", cursor, flags=re.ASCII) is None):
            raise HTTPException(status_code=422, detail="Invalid report pagination")
        page = int(cursor[5:]) if cursor else 1
        if page > 100000:
            raise HTTPException(status_code=422, detail="Invalid report pagination")
        rows = await self.repository.periods(child_id, actor_id, (page - 1) * limit, limit + 1)
        try:
            items = [ProgressPeriodOptionRead.model_validate(row) for row in rows[:limit]]
            if any(item.period_end < item.period_start for item in items):
                raise ValueError("Invalid saved period")
            return ProgressPeriodsRead(items=items,
                next_cursor=f"page-{page + 1}" if len(rows) > limit and page < 100000 else None)
        except (ValidationError, TypeError, ValueError):
            raise HTTPException(status_code=501, detail="Report contract is not available yet") from None

    @staticmethod
    def saved_report(row):
        # Validate groups independently. Unknown/private Summary keys never leave the service.
        from math import isfinite
        raw = row.Summary if isinstance(row.Summary, dict) else {}
        values = {}
        valid_fields = 0
        for name in SavedProgressPeriodRead.model_fields:
            if name not in raw:
                values[name] = None
                continue
            try:
                # A bool is not a numeric observation even though Python subclasses int.
                if isinstance(raw[name], bool):
                    raise ValueError("Invalid metric")
                values[name] = getattr(SavedProgressPeriodRead.model_validate({name: raw[name]}), name)
                if values[name] is not None or name.endswith("rate") or name == "comprehension_accuracy":
                    valid_fields += 1
            except (ValidationError, TypeError, ValueError):
                values[name] = None
        metrics_status = "available" if valid_fields == len(values) else "partial" if valid_fields else "absent" if not any(k in raw for k in values) else "unsupported"
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
            words_status = "partial" if invalid and words else "unsupported" if invalid else "available"
            if invalid and not words:
                words = None
        previous = trend = None
        comparison_status = "absent"
        if raw.get("previous_period") is not None:
            comparison_status = "unsupported"
            try:
                # No coercion, fabricated deltas, or implicit previous 30-day window.
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
        available = {"metrics": metrics_status, "difficult_words": words_status,
                     "comparison": comparison_status}
        status = "complete" if metrics_status == "available" and words_status == "available" and comparison_status != "unsupported" else "partial" if valid_fields or words is not None or legacy else "unsupported"
        try:
            result = ProgressRead(**values, id=row.Id, child_id=row.ChildId,
                period_start=row.PeriodStart, period_end=row.PeriodEnd, generated_at=row.GeneratedAt,
                difficult_words=words, previous_period=previous, trend_deltas=trend,
                legacy=legacy, data_status=status, availability=available)
            if result.period_end < result.period_start:
                raise ValueError("Invalid period")
            return result
        except (ValidationError, TypeError, ValueError):
            raise HTTPException(status_code=501, detail="Report contract is not available yet") from None

    async def read(self, child_id: UUID, actor_id: UUID, period_start: date | None, period_end: date | None, words_only: bool = False):
        await self.access.require_child(child_id, actor_id)
        if not words_only:
            if (period_start is None) != (period_end is None) or (period_start is not None and period_end < period_start):
                raise HTTPException(status_code=422, detail="Invalid date window")
            row = await self.repository.latest(child_id, actor_id) if period_start is None else await self.repository.report(child_id, period_start, period_end, actor_id)
            if row is None:
                raise HTTPException(status_code=404, detail="Saved report not found")
            return self.saved_report(row)
        # Keep the separate difficult-words endpoint's existing 90-day contract.
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
                return TypeAdapter(list[DifficultWordRead]).validate_python(row.Summary["difficult_words"])
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
    return await ProgressService(ProgressRepository(db), HistoryService(HistoryRepository(db))).read(child_id, actor_id, period_start, period_end)


@router.get("/progress/{child_id}/periods", response_model=ProgressPeriodsRead)
async def get_owned_progress_periods(
    child_id: UUID, cursor: str | None = None, limit: int = 20,
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db),
):
    return await ProgressService(ProgressRepository(db), HistoryService(HistoryRepository(db))).periods(child_id, actor_id, cursor, limit)


@router.get("/difficult-words/{child_id}", response_model=list[DifficultWordRead])
async def get_owned_difficult_words(
    child_id: UUID,
    period_start: date | None = None,
    period_end: date | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await ProgressService(ProgressRepository(db), HistoryService(HistoryRepository(db))).read(child_id, actor_id, period_start, period_end, words_only=True)


import asyncio
import re
from fastapi import Query
from sqlalchemy import literal
from sqlalchemy.exc import SQLAlchemyError
from app.models import Profile
from app.schemas.system import AdminAuditLogRead, AdminAuditPageRead, AdminHealthItemRead, AdminHealthRead


from app.providers.elevenlabs_voice_provider import ElevenLabsVoiceProvider


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
    def __init__(self, repository: AdminSystemRepository, voice_provider: ElevenLabsVoiceProvider | None = None):
        self.repository = repository
        self.voice_provider = voice_provider or ElevenLabsVoiceProvider()

    async def require_admin(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Access denied")

    async def logs(self, action: str | None, resource_type: str | None, cursor: str | None, limit: int):
        if not 1 <= limit <= 100:
            raise HTTPException(status_code=422, detail="Invalid page size")
        if cursor is not None and re.fullmatch(r"page-[1-9][0-9]{0,5}", cursor, flags=re.ASCII) is None:
            raise HTTPException(status_code=422, detail="Invalid cursor")
        page = int(cursor[5:]) if cursor else 1
        if page > 100000:
            raise HTTPException(status_code=422, detail="Invalid cursor")
        rows = await self.repository.logs(action, resource_type, (page - 1) * limit, limit + 1)
        try:
            return AdminAuditPageRead(
                items=[AdminAuditLogRead(
                    id=row.Id, actor_id=row.ActorId, action=row.Action, resource_type=row.ResourceType,
                    resource_id=row.ResourceId, request_id=row.RequestId, created_at=row.CreatedAt,
                    # Raw JSON can contain credentials or personal data. Never return it.
                    metadata={},
                ) for row in rows[:limit]],
                next_cursor=f"page-{page + 1}" if len(rows) > limit and page < 100000 else None,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Audit contract is not available yet") from None

    async def health(self):
        # Probes API, Database, and Voice Provider (TTS / STT)
        try:
            database_ready = await asyncio.wait_for(self.repository.probe_database(), timeout=4)
        except (TimeoutError, asyncio.TimeoutError, SQLAlchemyError, OSError):
            database_ready = False

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
            AdminHealthItemRead(id="api", label="FastAPI", status="HEALTHY", checked_at=checked_at,
                                safe_message="API đã phản hồi yêu cầu kiểm tra."),
            AdminHealthItemRead(id="database", label="Database", status="HEALTHY" if database_ready else "UNAVAILABLE",
                                checked_at=checked_at, safe_message="Database đã phản hồi truy vấn đọc." if database_ready else "Chưa kiểm tra được kết nối database. Vui lòng thử lại."),
            AdminHealthItemRead(id="tts", label="Text-to-Speech (TTS)", status=tts_status,
                                checked_at=checked_at, safe_message=tts_message),
            AdminHealthItemRead(id="stt", label="Speech-to-Text (STT)", status=stt_status,
                                checked_at=checked_at, safe_message=stt_message),
        ]

        statuses = [item.status for item in items]
        if all(s == "HEALTHY" for s in statuses):
            overall = "HEALTHY"
        elif not database_ready or any(s == "UNAVAILABLE" for s in statuses):
            overall = "DEGRADED"
        else:
            overall = "DEGRADED"

        return AdminHealthRead(
            overall_status=overall,
            checked_at=checked_at,
            services=items,
        )


@router.get("/admin/audit-logs", response_model=AdminAuditPageRead)
async def get_admin_audit_logs(
    action: str | None = None, resource_type: str | None = None,
    cursor: str | None = None, limit: int = Query(default=10, ge=1, le=100),
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db),
):
    service = AdminSystemService(AdminSystemRepository(db))
    await service.require_admin(actor_id)
    return await service.logs(action, resource_type, cursor, limit)


@router.get("/admin/health", response_model=AdminHealthRead)
async def get_admin_health(actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    service = AdminSystemService(AdminSystemRepository(db))
    await service.require_admin(actor_id)
    return await service.health()
