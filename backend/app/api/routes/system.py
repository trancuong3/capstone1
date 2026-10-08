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
from app.schemas.system import ProgressRead, DifficultWordRead


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


class ProgressService:
    def __init__(self, repository: ProgressRepository, access: HistoryService):
        self.repository = repository
        self.access = access

    async def read(self, child_id: UUID, actor_id: UUID, period_start: date | None, period_end: date | None, words_only: bool = False):
        await self.access.require_child(child_id, actor_id)
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
            # Require the actual complete stored DTO. Never turn avg_fluency or
            # total_books into a different metric or manufacture zeros.
            payload = dict(row.Summary)
            payload.update(child_id=row.ChildId, period_start=row.PeriodStart, period_end=row.PeriodEnd)
            return ProgressRead.model_validate(payload)
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
    def __init__(self, repository: AdminSystemRepository):
        self.repository = repository

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
        # This checks only this API handler and a real database round trip.
        # Auth/OCR/STT/TTS are not probed and must not be reported healthy.
        try:
            async with asyncio.timeout(4):
                database_ready = await self.repository.probe_database()
        except (TimeoutError, SQLAlchemyError, OSError):
            database_ready = False
        checked_at = datetime.now(timezone.utc)
        return AdminHealthRead(
            overall_status="HEALTHY" if database_ready else "DEGRADED",
            checked_at=checked_at,
            services=[
                AdminHealthItemRead(id="api", label="FastAPI", status="HEALTHY", checked_at=checked_at,
                                    safe_message="API đã phản hồi yêu cầu kiểm tra."),
                AdminHealthItemRead(id="database", label="Database", status="HEALTHY" if database_ready else "UNAVAILABLE",
                                    checked_at=checked_at, safe_message="Database đã phản hồi truy vấn đọc." if database_ready else "Chưa kiểm tra được kết nối database. Vui lòng thử lại."),
            ],
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
