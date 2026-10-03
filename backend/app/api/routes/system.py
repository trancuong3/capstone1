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