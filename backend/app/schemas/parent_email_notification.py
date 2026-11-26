from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator


ParentEmailCategory = Literal[
    "WEEKLY_DIGEST", "INACTIVITY_ALERT", "MILESTONE", "TEST_EMAIL"
]
ParentEmailDeliveryStatus = Literal[
    "PENDING", "SENDING", "SENT", "RETRY", "FAILED", "SKIPPED"
]
CronDispatchScope = Literal["all", "reminders", "presence", "engagement"]


class ParentEmailPreferencesRead(BaseModel):
    weekly_digest_enabled: bool = True
    inactivity_alert_enabled: bool = True
    inactivity_days: int = Field(default=5, ge=2, le=30)
    milestone_enabled: bool = True
    digest_weekday: int = Field(default=6, ge=0, le=6)
    timezone: str = "Asia/Ho_Chi_Minh"
    quiet_hours_start: int = Field(default=21, ge=0, le=23)
    quiet_hours_end: int = Field(default=7, ge=0, le=23)
    max_emails_per_week: int = Field(default=4, ge=1, le=14)
    delivery_configured: bool = False
    delivery_provider: str = "unconfigured"
    updated_at: datetime | None = None


class ParentEmailPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    weekly_digest_enabled: bool | None = None
    inactivity_alert_enabled: bool | None = None
    inactivity_days: int | None = Field(default=None, ge=2, le=30)
    milestone_enabled: bool | None = None
    digest_weekday: int | None = Field(default=None, ge=0, le=6)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    quiet_hours_start: int | None = Field(default=None, ge=0, le=23)
    quiet_hours_end: int | None = Field(default=None, ge=0, le=23)
    max_emails_per_week: int | None = Field(default=None, ge=1, le=14)

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        try:
            ZoneInfo(cleaned)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Invalid IANA timezone") from None
        return cleaned


class ParentEmailDeliveryRead(BaseModel):
    id: UUID
    category: ParentEmailCategory
    status: ParentEmailDeliveryStatus
    subject: str
    sent_at: datetime | None = None
    created_at: datetime
    error_code: str | None = None


class ParentEmailTestResponse(BaseModel):
    status: Literal["SENT", "FAILED"]
    delivery_id: UUID | None = None
    provider: str
    error_code: str | None = None
    message: str


class ParentEmailCronDispatchResponse(BaseModel):
    scope: CronDispatchScope
    delivery_configured: bool
    delivery_provider: str
    presence_sent: int = 0
    reminders_sent: int = 0
    engagement_sent: int = 0
    checked_at: datetime
