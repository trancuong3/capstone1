from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List

from app.api.deps import get_db
from app.models import ComprehensionQuestion, ComprehensionAnswer
from app.schemas import (
    ComprehensionQuestionResponse, ComprehensionQuestionCreate,
    ComprehensionAnswerResponse, ComprehensionAnswerCreate
)

router = APIRouter()

@router.get("/questions", response_model=List[ComprehensionQuestionResponse])
async def get_questions(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách câu hỏi đọc hiểu"""
    result = await db.execute(select(ComprehensionQuestion))
    return result.scalars().all()

@router.post("/questions", response_model=ComprehensionQuestionResponse)
async def create_question(question_in: ComprehensionQuestionCreate, db: AsyncSession = Depends(get_db)):
    """Lưu câu hỏi do AI tạo ra"""
    new_question = ComprehensionQuestion(**question_in.model_dump())
    db.add(new_question)
    await db.commit()
    await db.refresh(new_question)
    return new_question

@router.post("/answers", response_model=ComprehensionAnswerResponse)
async def create_answer(answer_in: ComprehensionAnswerCreate, db: AsyncSession = Depends(get_db)):
    """Lưu câu trả lời của bé"""
    new_answer = ComprehensionAnswer(**answer_in.model_dump())
    db.add(new_answer)
    await db.commit()
    await db.refresh(new_answer)
    return new_answer