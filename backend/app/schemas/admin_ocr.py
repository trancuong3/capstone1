from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator
from uuid import UUID


class AdminBookCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=250)
    author: str | None = Field(default=None, max_length=250)
    min_grade: int = Field(ge=1, le=5)
    max_grade: int = Field(ge=1, le=5)

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("title must not be blank")
        return value

    @field_validator("author")
    @classmethod
    def normalize_author(cls, value: str | None) -> str | None:
        value = value.strip() if value is not None else None
        return value or None

    @model_validator(mode="after")
    def grade_range_is_valid(self):
        if self.min_grade > self.max_grade:
            raise ValueError("min_grade must be less than or equal to max_grade")
        return self


class AdminOcrWordInput(BaseModel):
    word_index: int = Field(ge=0)
    line_index: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=500)
    normalized_text: str = Field(min_length=1, max_length=500)
    bbox: tuple[float, float, float, float]
    ocr_confidence: float | None = Field(default=None, ge=0, le=1)

    @field_validator("text", "normalized_text")
    @classmethod
    def word_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("word text must not be blank")
        return value

    @model_validator(mode="after")
    def validate_normalized_box(self):
        x, y, width, height = self.bbox
        if any(value < 0 or value > 1 for value in self.bbox):
            raise ValueError("bbox values must be normalized between 0 and 1")
        if width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001:
            raise ValueError("bbox must have positive size and remain inside the image")
        return self


class AdminOcrDraftRequest(BaseModel):
    draft_text: str = Field(max_length=500_000)
    words: list[AdminOcrWordInput] = Field(max_length=30_000)


class AdminOcrVerifyRequest(BaseModel):
    page_revision_id: UUID
    corrected_text: str = Field(min_length=1, max_length=500_000)
    words: list[AdminOcrWordInput] = Field(min_length=1, max_length=30_000)
