"""Public DTOs for the AI progress assessment of a child."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

ComponentKey = Literal["ACCURACY", "FLUENCY", "COMPREHENSION", "CONSISTENCY"]
Grade = Literal["EXCELLENT", "GOOD", "FAIR", "NEEDS_SUPPORT"]


class AssessmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    days: int = Field(default=30, ge=7, le=90)
    # Ask the AI for a new comment even when the data did not change.
    refresh: bool = False


class ScoreComponentRead(BaseModel):
    key: ComponentKey
    label: str
    score: int | None = Field(default=None, ge=0, le=100)
    previous_score: int | None = Field(default=None, ge=0, le=100)
    detail: str


class ScoreRead(BaseModel):
    overall: int | None = Field(default=None, ge=0, le=100)
    previous_overall: int | None = Field(default=None, ge=0, le=100)
    delta: int | None = None
    grade: Grade | None = None
    grade_label: str | None = None
    components: list[ScoreComponentRead]


class ComprehensionTypeRead(BaseModel):
    type: Literal["FACTUAL", "CLOZE", "VOCABULARY"]
    answered: int = Field(ge=0)
    first_try_correct: int = Field(ge=0)


class ProgressMetricsRead(BaseModel):
    sessions: int = Field(ge=0)
    active_days: int = Field(ge=0)
    reading_minutes: int = Field(ge=0)
    books: int = Field(ge=0)
    pages_compared: int = Field(ge=0)
    words_read: int = Field(ge=0)
    coverage_pct: float | None = None
    accuracy_pct: float | None = None
    skipped_rate_pct: float | None = None
    substitution_rate_pct: float | None = None
    hesitations: int = Field(ge=0)
    repeated_words: int = Field(ge=0)
    hesitations_per_100_words: float | None = None
    words_per_minute: float | None = None
    comprehension_answered: int = Field(ge=0)
    comprehension_first_try_pct: float | None = None
    comprehension_by_type: list[ComprehensionTypeRead]
    retry_confirmed: int = Field(ge=0)
    retry_failed: int = Field(ge=0)


class WeeklyPointRead(BaseModel):
    week_start: date
    sessions: int = Field(ge=0)
    minutes: int = Field(ge=0)
    accuracy_pct: float | None = None


class DifficultWordStatRead(BaseModel):
    word: str
    times: int = Field(ge=1)
    heard_as: str | None = None


class WeaknessRead(BaseModel):
    area: str
    detail: str


class ActionRead(BaseModel):
    title: str
    detail: str
    audience: Literal["PARENT", "CHILD"]


class AssessmentTextRead(BaseModel):
    source: Literal["AI", "RULE_BASED"]
    model: str | None = None
    headline: str
    summary: str
    strengths: list[str]
    weaknesses: list[WeaknessRead]
    actions: list[ActionRead]
    practice_words: list[str]
    encouragement: str


class ChildProgressAssessmentRead(BaseModel):
    child_id: UUID
    period_start: date
    period_end: date
    days: int
    generated_at: datetime
    data_status: Literal["OK", "INSUFFICIENT"]
    score: ScoreRead
    metrics: ProgressMetricsRead
    weekly: list[WeeklyPointRead]
    difficult_words: list[DifficultWordStatRead]
    assessment: AssessmentTextRead
    ai_cached: bool
