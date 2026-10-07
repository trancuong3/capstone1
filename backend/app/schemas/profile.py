from pydantic import BaseModel, Field, ConfigDict, field_validator
from typing import Optional, Dict, Any, List
from datetime import datetime
from uuid import UUID

# ==========================================
# 1. SCHEMAS CHO HỒ SƠ BÉ (CHILD PROFILE)
# ==========================================

class ChildProfileCreate(BaseModel):
    alias: str
    grade: int = Field(..., ge=1, le=5)
    settings: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("alias")
    @classmethod
    def validate_alias(cls, value: str) -> str:
        value = value.strip()

        if not value:
            raise ValueError("alias must not be empty")

        return value


class ChildProfileResponse(BaseModel):
    id: UUID = Field(validation_alias="Id", serialization_alias="id")
    parent_id: UUID = Field(
        validation_alias="ParentId",
        serialization_alias="parent_id",
    )
    alias: str = Field(
        validation_alias="Alias",
        serialization_alias="alias",
    )
    grade: int = Field(
        validation_alias="Grade",
        serialization_alias="grade",
    )
    settings: Dict[str, Any] = Field(
        validation_alias="Settings",
        serialization_alias="settings",
    )
    created_at: datetime = Field(
        validation_alias="CreatedAt",
        serialization_alias="created_at",
    )

    model_config = ConfigDict(from_attributes=True)


class ChildProfileUpdate(BaseModel):
    alias: str
    grade: int = Field(..., ge=1, le=5)

    @field_validator("alias")
    @classmethod
    def validate_alias(cls, value: str) -> str:
        value = value.strip()

        if not value:
            raise ValueError("alias must not be empty")

        return value


# ==========================================
# 2. SCHEMAS CHO PHỤ HUYNH (PROFILE)
# ==========================================

class ProfileBase(BaseModel):
    Role: str
    DisplayName: Optional[str] = None


class ProfileCreate(ProfileBase):
    pass


# Dùng cho PUT (Cập nhật toàn bộ hồ sơ)
class ProfileUpdate(ProfileBase):
    displayname: str


class ProfileResponse(ProfileBase):
    Id: UUID
    CreatedAt: datetime
    children: List[ChildProfileResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)