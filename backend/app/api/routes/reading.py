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

router = APIRouter()

@router.get("/sessions", response_model=List[ReadingSessionResponse])
async def get_sessions(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách các phiên đọc"""
    result = await db.execute(select(ReadingSession))
    return result.scalars().all()

@router.post("/sessions", response_model=ReadingSessionResponse)
async def create_session(session_in: ReadingSessionCreate, db: AsyncSession = Depends(get_db)):
    """Tạo phiên đọc mới khi bé bắt đầu đọc sách"""
    new_session = ReadingSession(**session_in.model_dump())
    db.add(new_session)
    await db.commit()
    await db.refresh(new_session)
    return new_session

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