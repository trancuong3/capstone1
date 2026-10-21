"""Request contracts for Admin book metadata and lifecycle mutations."""
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class AdminBookWriteRequest(BaseModel):
    name: str = Field(min_length=1, max_length=250)
    title: str = Field(min_length=1, max_length=250)
    author: str | None = Field(default=None, max_length=250)
    min_grade: int = Field(ge=1, le=5)
    max_grade: int = Field(ge=1, le=5)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Vui lòng nhập tên sách.")
        return value

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Title must not be blank")
        return value

    @field_validator("author")
    @classmethod
    def normalize_author(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_grade_range(self):
        if self.min_grade > self.max_grade:
            raise ValueError("min_grade must be less than or equal to max_grade")
        return self


class AdminBookLifecycleRequest(BaseModel):
    status: Literal["ACTIVE", "RETIRED"]
