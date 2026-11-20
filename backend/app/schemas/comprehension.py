from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any, List
from datetime import datetime
from uuid import UUID

# --- COMPREHENSION QUESTION ---
class ComprehensionQuestionBase(BaseModel):
    Type: str
    Prompt: str
    ExpectedAnswer: str
    AcceptedAnswers: List[Any] = Field(default_factory=list)
    SourceSpan: List[Any] = Field(default_factory=list)
    Difficulty: str

class ComprehensionQuestionCreate(ComprehensionQuestionBase):
    SessionId: UUID
    PageId: UUID
    PageRevisionId: UUID

class ComprehensionQuestionResponse(ComprehensionQuestionBase):
    Id: UUID
    SessionId: UUID
    PageId: UUID
    PageRevisionId: UUID
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)

# --- COMPREHENSION ANSWER ---
class ComprehensionAnswerBase(BaseModel):
    Answer: str
    IsCorrect: Optional[bool] = None
    Score: Optional[float] = None

class ComprehensionAnswerCreate(ComprehensionAnswerBase):
    QuestionId: UUID

class ComprehensionAnswerResponse(ComprehensionAnswerBase):
    Id: UUID
    QuestionId: UUID
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)

class ComprehensionQuestionPublic(BaseModel):
    """Safe legacy read response: never expose stored grading answers.

    Tutor-created rows store SourceSpan as JSON object; historical legacy rows
    may store it as a list. Neither shape needs to be exposed to clients.
    """

    Id: UUID
    SessionId: UUID
    PageId: UUID
    PageRevisionId: UUID
    Type: str
    Prompt: str
    Difficulty: str
    CreatedAt: datetime

    model_config = ConfigDict(from_attributes=True)
