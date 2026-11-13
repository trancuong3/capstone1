from __future__ import annotations

import math
import unicodedata
from typing import Literal
from pydantic import BaseModel, Field, field_validator, model_validator
from uuid import UUID

from app.schemas.admin_book import AdminBookWriteRequest as AdminBookCreateRequest


def normalize_ocr_bbox(value: object) -> tuple[float, float, float, float]:
    if isinstance(value, dict):
        keys = ("x", "y", "width", "height")
        if any(key not in value for key in keys):
            raise ValueError("bbox dictionary must include x, y, width and height")
        value = tuple(value[key] for key in keys)
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("bbox must contain exactly four coordinates")
    if any(isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) for coordinate in value):
        raise ValueError("bbox coordinates must be finite numbers")
    try:
        x, y, width, height = (float(coordinate) for coordinate in value)
    except (OverflowError, ValueError) as exc:
        raise ValueError("bbox coordinates must be finite numbers") from exc
    if not all(math.isfinite(coordinate) for coordinate in (x, y, width, height)):
        raise ValueError("bbox coordinates must be finite numbers")
    if (
        any(coordinate < 0 or coordinate > 1 for coordinate in (x, y, width, height))
        or width <= 0
        or height <= 0
        or x + width > 1
        or y + height > 1
    ):
        raise ValueError("bbox must have positive size and remain inside the image")
    return x, y, width, height


class AdminOcrWordInput(BaseModel):
    word_index: int = Field(ge=0)
    line_index: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=500)
    normalized_text: str = Field(min_length=1, max_length=500)
    bbox: tuple[float, float, float, float]
    ocr_confidence: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)

    @field_validator("bbox", mode="before")
    @classmethod
    def bbox_must_be_normalized(cls, value: object) -> tuple[float, float, float, float]:
        return normalize_ocr_bbox(value)

    @field_validator("text", "normalized_text")
    @classmethod
    def word_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("word text must not be blank")
        return value

    @model_validator(mode="after")
    def validate_normalized_box(self):
        normalize_ocr_bbox(self.bbox)
        return self


class AdminOcrDraftRequest(BaseModel):
    draft_text: str = Field(max_length=500_000)
    words: list[AdminOcrWordInput] = Field(max_length=30_000)


class AdminOcrCreateDraftRequest(BaseModel):
    expected_source_revision_id: UUID


class AdminOcrProofreadSuggestionInput(BaseModel):
    word_index: int = Field(ge=0)
    original: str = Field(min_length=1, max_length=500)
    proposed: str = Field(min_length=1, max_length=500)
    decision: Literal["ACCEPTED", "REJECTED"]


class AdminOcrProofreadAuditInput(BaseModel):
    mode: Literal["AI_CHECKED", "MANUAL_FALLBACK"]
    checked_text: str = Field(min_length=1, max_length=500_000)
    suggestions: list[AdminOcrProofreadSuggestionInput] = Field(max_length=30_000)
    reason_code: Literal["AI_CHECK_UNAVAILABLE"] | None = None

    @field_validator("checked_text")
    @classmethod
    def checked_text_must_not_be_blank(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFC", value).strip()
        if not normalized:
            raise ValueError("checked_text must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_mode(self):
        if self.mode == "AI_CHECKED" and self.reason_code is not None:
            raise ValueError("AI_CHECKED must not include a manual fallback reason")
        if self.mode == "MANUAL_FALLBACK" and (
            self.reason_code != "AI_CHECK_UNAVAILABLE" or self.suggestions
        ):
            raise ValueError("manual fallback requires AI_CHECK_UNAVAILABLE and no AI suggestions")
        return self


class AdminOcrVerifyRequest(BaseModel):
    page_revision_id: UUID
    corrected_text: str = Field(min_length=1, max_length=500_000)
    words: list[AdminOcrWordInput] = Field(min_length=1, max_length=30_000)
    proofread_audit: AdminOcrProofreadAuditInput
