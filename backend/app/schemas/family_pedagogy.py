"""Pydantic V2 schemas for Wave 1 Feature #4:
- Child-Safe Mode Parent PIN Lock
- Intrinsic Reading Passport (non-addictive stamps & family streak)
- Parent Voice Encouragement Notes (parent-recorded only; zero child audio persisted)
"""

from __future__ import annotations

from datetime import datetime
import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

_PIN_REGEX = re.compile(r"^\d{4}$")

StampCategory = Literal[
    "STREAK",
    "BOOKS",
    "COURAGE_WORDS",
    "GOAL_KEEPER",
    "COMPREHENSION",
]


class ParentPinStatusRead(BaseModel):
    has_pin: bool = False
    child_mode_default: bool = False
    is_locked_out: bool = False
    locked_until: datetime | None = None
    remaining_attempts: int = Field(default=5, ge=0, le=5)
    storage_ready: bool = True


class ParentPinUpsertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pin: str = Field(min_length=4, max_length=4)
    current_pin: str | None = Field(default=None, min_length=4, max_length=4)
    child_mode_default: bool = False

    @field_validator("pin")
    @classmethod
    def validate_pin_digits(cls, value: str) -> str:
        clean = value.strip()
        if not _PIN_REGEX.fullmatch(clean):
            raise ValueError("PIN must be exactly 4 digits")
        return clean

    @field_validator("current_pin")
    @classmethod
    def validate_current_pin(cls, value: str | None) -> str | None:
        if value is None:
            return None
        clean = value.strip()
        if not _PIN_REGEX.fullmatch(clean):
            raise ValueError("current_pin must be exactly 4 digits")
        return clean


class ParentPinVerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pin: str = Field(min_length=4, max_length=4)

    @field_validator("pin")
    @classmethod
    def validate_pin_digits(cls, value: str) -> str:
        clean = value.strip()
        if not _PIN_REGEX.fullmatch(clean):
            raise ValueError("PIN must be exactly 4 digits")
        return clean


class ParentPinVerifyResponse(BaseModel):
    verified: bool
    remaining_attempts: int = Field(ge=0, le=5)
    locked_until: datetime | None = None


class PassportStampRead(BaseModel):
    stamp_key: str
    category: StampCategory
    title_vi: str
    description_vi: str
    unlocked: bool
    progress_current: int = Field(ge=0)
    progress_target: int = Field(ge=1)


class ReadingPassportRead(BaseModel):
    child_id: UUID
    child_alias: str
    streak_days: int = Field(ge=0)
    best_goal_streak_cycles: int = Field(ge=0)
    completed_sessions: int = Field(ge=0)
    books_explored: int = Field(ge=0)
    mastered_difficult_words: int = Field(ge=0)
    comprehension_correct: int = Field(ge=0)
    unlocked_stamps_count: int = Field(ge=0)
    total_stamps_count: int = Field(ge=0)
    stamps: list[PassportStampRead] = Field(default_factory=list)
    gentle_message_vi: str
    has_parent_encouragement: bool = False


class ParentEncouragementNoteRead(BaseModel):
    id: UUID
    child_id: UUID
    title: str | None = None
    mime_type: str
    size_bytes: int = Field(gt=0, le=262144)
    duration_ms: int | None = Field(default=None, gt=0, le=10500)
    audio_stream_path: str
    signed_audio_url: str | None = None
    created_at: datetime
