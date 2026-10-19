from datetime import date, time, datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

GoalMetric = Literal["MINUTES", "SESSIONS"]
GoalPeriod = Literal["DAILY", "WEEKLY"]
GoalStatus = Literal["ACTIVE", "PAUSED", "COMPLETED", "ENDED"]
CollectionType = Literal["FAVORITE", "WANT_TO_READ"]
ReminderStatus = Literal["PENDING", "ACKNOWLEDGED"]


def validate_timezone(value: str) -> str:
    normalized = value.strip()
    try:
        ZoneInfo(normalized)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("timezone must be a valid IANA timezone") from None
    return normalized


class ReadingGoalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    child_id: UUID
    metric: GoalMetric
    target_value: int = Field(gt=0, le=100000)
    period: GoalPeriod
    starts_on: date
    ends_on: date | None = None
    timezone: str = "Asia/Ho_Chi_Minh"

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, value: str) -> str:
        return validate_timezone(value)

    @model_validator(mode="after")
    def check_dates(self):
        if self.ends_on is not None and self.ends_on < self.starts_on:
            raise ValueError("ends_on must be on or after starts_on")
        return self


class ReadingGoalUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_value: int | None = Field(default=None, gt=0, le=100000)
    ends_on: date | None = None

    @model_validator(mode="after")
    def require_changes(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be supplied")
        return self


class ReadingGoalTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["ACTIVE", "PAUSED", "COMPLETED", "ENDED"]


class ReadingGoalRead(BaseModel):
    id: UUID
    child_id: UUID
    metric: GoalMetric
    target_value: int
    period: GoalPeriod
    starts_on: date
    ends_on: date | None
    timezone: str
    status: GoalStatus
    current_value: int = Field(ge=0)
    progress_percent: float = Field(ge=0, le=100)
    completed_value: int | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ChildBookCollectionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    child_id: UUID
    collection_type: CollectionType


class BookSummaryRead(BaseModel):
    id: UUID
    title: str
    author: str | None
    min_grade: int
    max_grade: int
    lifecycle_status: str
    available_to_read: bool


class ChildBookCollectionRead(BaseModel):
    id: UUID
    child_id: UUID
    book_id: UUID
    collection_type: CollectionType
    created_at: datetime
    book: BookSummaryRead


class ReadingReminderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    child_id: UUID
    remind_at: time
    weekdays: list[int] = Field(min_length=1, max_length=7)
    timezone: str = "Asia/Ho_Chi_Minh"
    is_active: bool = True

    @field_validator("weekdays")
    @classmethod
    def validate_weekdays(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("weekdays use Monday=0 through Sunday=6")
        if len(set(value)) != len(value):
            raise ValueError("weekdays must not contain duplicates")
        return sorted(value)

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, value: str) -> str:
        return validate_timezone(value)


class ReadingReminderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    remind_at: time | None = None
    weekdays: list[int] | None = Field(default=None, min_length=1, max_length=7)
    timezone: str | None = None
    is_active: bool | None = None

    @field_validator("weekdays")
    @classmethod
    def validate_weekdays(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return value
        if any(day < 0 or day > 6 for day in value) or len(set(value)) != len(value):
            raise ValueError("weekdays must be unique values from 0 to 6")
        return sorted(value)

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, value: str | None) -> str | None:
        return validate_timezone(value) if value is not None else None

    @model_validator(mode="after")
    def require_changes(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be supplied")
        return self


class ReadingReminderRead(BaseModel):
    id: UUID
    child_id: UUID
    remind_at: time
    weekdays: list[int]
    timezone: str
    is_active: bool
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ReadingReminderOccurrenceRead(BaseModel):
    id: UUID
    reminder_id: UUID
    scheduled_local_date: date
    scheduled_for: datetime
    status: ReminderStatus
    acknowledged_at: datetime | None
    reminder: ReadingReminderRead | None = None


class DeletedResponse(BaseModel):
    deleted: Literal[True] = True
