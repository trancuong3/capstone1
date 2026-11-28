"""Pydantic schemas for Personalized Weak-Word 4-Page Micro-Storybooks (Feature #4)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

MicroStoryWordSource = Literal["WEAK_WORD", "COLD_START_GRADE", "PARENT_CUSTOM"]
MicroStorySafetyStatus = Literal["PASSED", "SANITIZED_FALLBACK"]


class MicroStoryQuotaRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    child_id: UUID
    daily_limit: int = Field(..., ge=0)
    used_today: int = Field(..., ge=0)
    remaining_today: int = Field(..., ge=0)
    quota_exceeded: bool
    resets_at_utc: datetime


class MicroStoryTargetWordItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    normalized_word: str
    display_text: str
    source: MicroStoryWordSource
    priority_score: float = Field(default=1.0, ge=0.0)
    practice_count: int = Field(default=0, ge=0)
    phonics_category: str = "general"
    phonics_label_vi: str = "Từ cần ôn"
    reason_vi: str
    selected_by_default: bool = True


class MicroStoryPreviewRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    child_id: UUID
    child_alias: str
    child_grade: int = Field(..., ge=1, le=5)
    recommended_words: list[MicroStoryTargetWordItem]
    candidate_pool: list[MicroStoryTargetWordItem]
    cold_start_filled: bool
    privacy_notice_vi: str
    quota: MicroStoryQuotaRead


class MicroStoryGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selected_words: list[str] | None = Field(default=None)
    theme_hint: str | None = Field(default=None, max_length=200)
    title_override: str | None = Field(default=None, max_length=160)

    @field_validator("theme_hint", "title_override")
    @classmethod
    def _strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class MicroStoryPageSummaryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    page_id: UUID
    page_number: int = Field(..., ge=1, le=4)
    revision_id: UUID
    text: str
    word_count: int = Field(..., ge=1)
    target_words_on_page: list[str]
    target_word_indices: list[int]
    image_url: str
    illustration_provider: str
    illustration_fallback_used: bool


class MicroStoryComprehensionItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    question_id: UUID
    page_number: int = Field(..., ge=1, le=4)
    prompt: str
    choices: list[str]
    correct_answer: str
    difficulty: str


class MicroStoryGenerateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    book_id: UUID
    seeded_session_id: UUID
    child_id: UUID
    child_alias: str
    child_grade: int = Field(..., ge=1, le=5)
    title: str
    visibility_scope: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    readable_for_children: bool = True
    reader_href: str
    my_book_href: str
    target_weak_words: list[MicroStoryTargetWordItem]
    cold_start_filled: bool
    story_provider: str
    illustration_provider: str
    illustration_fallback_used: bool
    safety_status: MicroStorySafetyStatus
    pages: list[MicroStoryPageSummaryRead]
    comprehension_questions: list[MicroStoryComprehensionItemRead]
    quota: MicroStoryQuotaRead
