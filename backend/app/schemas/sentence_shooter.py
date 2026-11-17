from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


Difficulty = Literal["easy", "medium", "challenge"]
SessionStatus = Literal["IN_PROGRESS", "COMPLETED", "ABANDONED"]


class SentenceShooterBookRead(BaseModel):
    id: UUID
    name: str | None
    title: str
    author: str | None
    min_grade: int = Field(ge=1, le=5)
    max_grade: int = Field(ge=1, le=5)
    available_rounds: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


class SentenceShooterSessionCreate(BaseModel):
    child_id: UUID
    book_id: UUID
    difficulty: Difficulty
    total_rounds: int = Field(default=3, ge=1, le=5)

    model_config = ConfigDict(extra="forbid")


class SentenceShooterRoundToken(BaseModel):
    id: UUID
    text: str


class SentenceShooterRoundRead(BaseModel):
    round_id: UUID
    round_number: int = Field(ge=1, le=5)
    token_count: int = Field(ge=3, le=14)
    tokens: list[SentenceShooterRoundToken]


class SentenceShooterSessionRead(BaseModel):
    session_id: UUID
    book: SentenceShooterBookRead
    difficulty: Difficulty
    total_rounds: int = Field(ge=1, le=5)
    completed_rounds: int = Field(ge=0, le=5)
    total_stars: int = Field(ge=0)
    round: SentenceShooterRoundRead


class SentenceShooterShotRequest(BaseModel):
    round_id: UUID
    token_id: UUID
    request_id: UUID

    model_config = ConfigDict(extra="forbid")


class SentenceShooterShotRead(BaseModel):
    is_correct: bool
    correct_count: int = Field(ge=0)
    token_count: int = Field(ge=3, le=14)
    mistakes_total: int = Field(ge=0)
    completed_rounds: int = Field(ge=0, le=5)
    total_stars: int = Field(ge=0)
    round_completed: bool
    session_completed: bool
    next_expected_position: int = Field(ge=0)
    stars_awarded: int = Field(ge=0, le=3)
    completed_sentence: str | None = None
    message: str


class SentenceShooterHintRequest(BaseModel):
    round_id: UUID
    hint_level: int = Field(default=1, ge=1, le=1)

    model_config = ConfigDict(extra="forbid")


class SentenceShooterHintRead(BaseModel):
    target_token_id: UUID
    hint_count: int = Field(ge=1)
    message: str


class SentenceShooterNextRoundRequest(BaseModel):
    round_id: UUID

    model_config = ConfigDict(extra="forbid")


class SentenceShooterNextRoundRead(BaseModel):
    session_id: UUID
    completed_rounds: int = Field(ge=1, le=5)
    total_rounds: int = Field(ge=2, le=5)
    total_stars: int = Field(ge=0)
    round: SentenceShooterRoundRead


class SentenceShooterResultRead(BaseModel):
    session_id: UUID
    book: SentenceShooterBookRead
    difficulty: Difficulty
    status: SessionStatus
    total_rounds: int = Field(ge=1, le=5)
    completed_rounds: int = Field(ge=0, le=5)
    correct_count: int = Field(ge=0)
    mistakes_total: int = Field(ge=0)
    hint_count: int = Field(ge=0)
    total_stars: int = Field(ge=0)
    duration_seconds: int = Field(ge=0)
    started_at: datetime
    completed_at: datetime | None


class SentenceShooterAbandonRead(BaseModel):
    session_id: UUID
    status: Literal["ABANDONED"]
