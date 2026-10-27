from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


MetadataQualityIssueType = Literal[
    "MISSING_TITLE",
    "MISSING_AUTHOR",
    "INVALID_GRADE_RANGE",
    "POSSIBLE_DUPLICATE",
]


class MetadataQualityBookIssue(BaseModel):
    id: UUID
    title: str | None
    author: str | None
    min_grade: int | None
    max_grade: int | None
    lifecycle_status: str
    issues: list[MetadataQualityIssueType] = Field(min_length=1)


class MetadataQualitySummary(BaseModel):
    total_books: int = Field(ge=0)
    books_with_issues: int = Field(ge=0)
    missing_title: int = Field(ge=0)
    missing_author: int = Field(ge=0)
    invalid_grade_range: int = Field(ge=0)
    possible_duplicate_groups: int = Field(ge=0)
    books_in_duplicate_groups: int = Field(ge=0)
    checked_at: datetime


class MetadataQualityResponse(BaseModel):
    summary: MetadataQualitySummary
    items: list[MetadataQualityBookIssue]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
