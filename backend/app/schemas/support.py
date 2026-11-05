from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

SupportCategory = Literal[
    "technical_issue",
    "feature_feedback",
    "account_support",
    "how_to",
    "feature_request",
    "other",
]


class SupportFeedbackRequest(BaseModel):
    """Validated parent feedback; the recipient is never supplied by clients."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    category: SupportCategory
    subject: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=5000)
    contact_email: EmailStr

    @field_validator("subject")
    @classmethod
    def validate_subject(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("subject must not be empty")
        if "\r" in normalized or "\n" in normalized:
            raise ValueError("subject must be a single line")
        if any(ord(character) < 32 for character in normalized):
            raise ValueError("subject contains unsupported control characters")
        return normalized

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        normalized = value.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized:
            raise ValueError("message must not be empty")
        if "\x00" in normalized:
            raise ValueError("message contains an unsupported control character")
        if any(
            ord(character) < 32 and character not in {"\n", "\t"}
            for character in normalized
        ):
            raise ValueError("message contains unsupported control characters")
        return normalized

    @field_validator("contact_email")
    @classmethod
    def normalize_contact_email(cls, value: EmailStr) -> str:
        normalized = str(value).strip().lower()
        if len(normalized) > 254 or not re.fullmatch(
            r"[^\s@]+@[^\s@]+\.[^\s@]+", normalized
        ):
            raise ValueError("contact_email is invalid")
        return normalized
