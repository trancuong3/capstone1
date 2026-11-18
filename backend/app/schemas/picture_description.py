from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


SourceType = Literal["BOOK_PAGE", "CUSTOM_UPLOAD", "SAMPLE"]
SessionStatus = Literal["ACTIVE", "COMPLETED"]
InputMode = Literal["VOICE", "TEXT"]


class PictureVocabItem(BaseModel):
    word: str = Field(..., min_length=1, max_length=60)
    hint: str = Field(..., min_length=1, max_length=180)


class PictureSampleItem(BaseModel):
    sample_key: str
    title: str
    theme: str
    description: str
    image_url: str


class PictureBookPageItem(BaseModel):
    book_id: UUID
    book_title: str
    page_id: UUID
    page_number: int = Field(..., ge=1)
    image_url: str


class PictureCatalogRead(BaseModel):
    samples: list[PictureSampleItem]
    book_pages: list[PictureBookPageItem]


class PictureGuideRead(BaseModel):
    is_child_safe: bool = True
    scene_title: str
    scene_summary: str
    guiding_questions: list[str]
    suggested_vocabulary: list[PictureVocabItem]
    model_sample_sentences: list[str]


class PictureEvaluationFeedbackRead(BaseModel):
    is_relevant: bool = True
    score_out_of_10: int = Field(..., ge=0, le=10)
    stars: int = Field(..., ge=0, le=3)
    matched_details: list[str]
    missed_details: list[str]
    praise_message: str
    improvement_tip: str
    upgraded_sentences: list[str]
    vocabulary_highlights: list[str]


class PictureAttemptRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    attempt_id: UUID
    attempt_number: int = Field(..., ge=1)
    input_mode: InputMode
    transcript_text: str
    score_out_of_10: int = Field(..., ge=0, le=10)
    stars: int = Field(..., ge=0, le=3)
    feedback: PictureEvaluationFeedbackRead
    created_at: datetime


class PictureSessionRead(BaseModel):
    session_id: UUID
    child_id: UUID
    child_grade: int = Field(..., ge=1, le=5)
    source_type: SourceType
    sample_key: str | None = None
    book_id: UUID | None = None
    book_page_id: UUID | None = None
    image_url: str
    scene_title: str
    status: SessionStatus
    best_stars: int = Field(..., ge=0, le=3)
    best_score: int = Field(..., ge=0, le=10)
    attempts_count: int = Field(..., ge=0)
    guide: PictureGuideRead
    attempts: list[PictureAttemptRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class PictureSessionSummaryRead(BaseModel):
    session_id: UUID
    child_id: UUID
    source_type: SourceType
    sample_key: str | None = None
    book_page_id: UUID | None = None
    scene_title: str
    image_url: str
    status: SessionStatus
    best_stars: int = Field(..., ge=0, le=3)
    best_score: int = Field(..., ge=0, le=10)
    attempts_count: int = Field(..., ge=0)
    created_at: datetime
    updated_at: datetime


class PictureEvaluateRequest(BaseModel):
    transcript_text: str = Field(..., min_length=1, max_length=2000)
    input_mode: InputMode = "TEXT"

    @field_validator("transcript_text")
    @classmethod
    def normalize_transcript(cls, value: str) -> str:
        cleaned = " ".join(value.strip().split())
        if not cleaned:
            raise ValueError("Bé hãy nói hoặc viết câu mô tả trước nhé")
        return cleaned


class PictureEvaluateResponse(BaseModel):
    session: PictureSessionRead
    latest_attempt: PictureAttemptRead
