"""Public DTOs for the AI tutor question flow.

The child-facing payloads never include the expected answer.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TutorSourceSpanRead(BaseModel):
    start_word_index: int = Field(ge=0)
    end_word_index_exclusive: int = Field(ge=0)
    sentence_index: int | None = None


class TutorQuestionRead(BaseModel):
    id: UUID
    type: Literal["FACTUAL", "CLOZE", "VOCABULARY"]
    prompt: str
    page_revision_id: UUID
    source_span: TutorSourceSpanRead
    difficulty: int = Field(ge=1, le=3)
    answered: bool


class TutorChoiceRead(BaseModel):
    id: str
    label: str
    value: str


class TutorQuestionSetRead(BaseModel):
    """Result of the (idempotent) generation call."""

    session_id: UUID
    total: int = Field(ge=0)
    source: Literal["AI", "RULE_BASED"] | None = None
    created: bool


class TutorNextQuestionRead(BaseModel):
    """The next question the child has not answered correctly yet."""

    question: TutorQuestionRead | None
    choices: list[TutorChoiceRead]
    progress_label: str
    position: int = Field(ge=0)
    total: int = Field(ge=0)
    completed: bool


class TutorAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: str = Field(min_length=1, max_length=200)

    @field_validator("answer")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Answer must not be blank")
        return value


class TutorAnswerResultRead(BaseModel):
    answer_id: UUID
    question_id: UUID
    submitted_answer: str
    is_correct: bool
    score: float
    feedback_code: Literal["CORRECT", "TRY_AGAIN"]
