from datetime import datetime
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, model_validator


Difficulty = Literal["easy", "medium", "challenge"]
LearningMode = Literal["WORD_ORDER", "FILL_BLANK", "GRAMMAR_FOCUS"]
SessionStatus = Literal["IN_PROGRESS", "COMPLETED", "ABANDONED"]


def resolve_shot_request_uuid(
    request_id: UUID | None,
    client_shot_id: str | UUID | None,
) -> UUID:
    """Resolve a deterministic UUID deduplication key from client_shot_id or request_id."""
    if client_shot_id is not None:
        raw = str(client_shot_id).strip()
        if raw:
            try:
                return UUID(raw)
            except ValueError:
                return uuid5(NAMESPACE_URL, f"viread:sentence-shooter:shot:{raw}")
    if request_id is not None:
        return request_id
    raise ValueError("Either request_id or client_shot_id must be provided")


class SentenceShooterBookRead(BaseModel):
    id: UUID
    name: str | None
    title: str
    author: str | None
    min_grade: int = Field(ge=1, le=5)
    max_grade: int = Field(ge=1, le=5)
    available_rounds: int = Field(ge=1)
    difficult_word_count: int = Field(default=0, ge=0)
    matched_difficult_words: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class SentenceShooterSessionCreate(BaseModel):
    child_id: UUID
    book_id: UUID
    difficulty: Difficulty
    total_rounds: int = Field(default=3, ge=1, le=5)
    learning_mode: LearningMode = "WORD_ORDER"
    focus_words: list[str] = Field(default_factory=list, max_length=20)

    model_config = ConfigDict(extra="forbid")


class SentenceShooterRoundToken(BaseModel):
    id: UUID
    text: str
    is_difficult_word: bool = False


class SentenceShooterPromptSlot(BaseModel):
    position: int = Field(ge=0)
    text: str | None = None
    is_blank: bool = False
    is_difficult_word: bool = False


class SentenceShooterRoundRead(BaseModel):
    round_id: UUID
    round_number: int = Field(ge=1, le=5)
    token_count: int = Field(ge=1, le=14)
    tokens: list[SentenceShooterRoundToken]
    learning_mode: LearningMode = "WORD_ORDER"
    prompt_slots: list[SentenceShooterPromptSlot] = Field(default_factory=list)
    practiced_difficult_words: list[str] = Field(default_factory=list)
    prompt_hint: str | None = None


class SentenceShooterSessionRead(BaseModel):
    session_id: UUID
    book: SentenceShooterBookRead
    difficulty: Difficulty
    learning_mode: LearningMode = "WORD_ORDER"
    total_rounds: int = Field(ge=1, le=5)
    completed_rounds: int = Field(ge=0, le=5)
    total_stars: int = Field(ge=0)
    practiced_difficult_words: list[str] = Field(default_factory=list)
    round: SentenceShooterRoundRead


class SentenceShooterShotRequest(BaseModel):
    round_id: UUID
    token_id: UUID
    request_id: UUID | None = None
    client_shot_id: str | None = Field(default=None, min_length=1, max_length=128)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _ensure_idempotency_key(self) -> "SentenceShooterShotRequest":
        if self.request_id is None and (self.client_shot_id is None or not self.client_shot_id.strip()):
            raise ValueError("Either request_id or client_shot_id is required")
        return self

    @property
    def effective_request_id(self) -> UUID:
        return resolve_shot_request_uuid(self.request_id, self.client_shot_id)


class SentenceShooterShotRead(BaseModel):
    is_correct: bool
    correct_count: int = Field(ge=0)
    token_count: int = Field(ge=1, le=14)
    mistakes_total: int = Field(ge=0)
    completed_rounds: int = Field(ge=0, le=5)
    total_stars: int = Field(ge=0)
    round_completed: bool
    session_completed: bool
    next_expected_position: int = Field(ge=0)
    stars_awarded: int = Field(ge=0, le=3)
    score: int = Field(default=0, ge=0)
    completed_sentence: str | None = None
    next_round: SentenceShooterRoundRead | None = None
    message: str
    client_shot_id: str | None = None
    learning_mode: LearningMode = "WORD_ORDER"
    grammar_tip: str | None = None
    practiced_difficult_words: list[str] = Field(default_factory=list)


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
    learning_mode: LearningMode = "WORD_ORDER"
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
    practiced_difficult_words: list[str] = Field(default_factory=list)


class SentenceShooterAbandonRead(BaseModel):
    session_id: UUID
    status: Literal["ABANDONED"]
