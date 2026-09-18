# file: backend/app/schemas/comprehension.py
from pydantic import BaseModel, UUID4, Field
from typing import Optional, Dict, Any, List
from datetime import datetime

# --- COMPREHENSION QUESTION ---
class ComprehensionQuestionBase(BaseModel):
    Type: str
    Prompt: str
    ExpectedAnswer: str
    AcceptedAnswers: List[Any] = Field(default_factory=list)
    SourceSpan: List[Any] = Field(default_factory=list)
    Difficulty: str

class ComprehensionQuestionCreate(ComprehensionQuestionBase):
    SessionId: UUID4
    PageId: UUID4
    PageRevisionId: UUID4

class ComprehensionQuestionResponse(ComprehensionQuestionBase):
    Id: UUID4
    SessionId: UUID4
    PageId: UUID4
    PageRevisionId: UUID4
    CreatedAt: datetime
    class Config:
        from_attributes = True

# --- COMPREHENSION ANSWER ---
class ComprehensionAnswerBase(BaseModel):
    Answer: str
    IsCorrect: Optional[bool] = None
    Score: Optional[float] = None

class ComprehensionAnswerCreate(ComprehensionAnswerBase):
    QuestionId: UUID4

class ComprehensionAnswerResponse(ComprehensionAnswerBase):
    Id: UUID4
    QuestionId: UUID4
    CreatedAt: datetime
    class Config:
        from_attributes = True