from pydantic import BaseModel, Field, ConfigDict, EmailStr, field_validator, model_validator
from typing import Optional, Dict, Any, List, Literal
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
    id: UUID = Field(
        validation_alias="Id",
        serialization_alias="id",
    )

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


# ==========================================
# 3. RESPONSE CHO CURRENT PARENT PROFILE
# ==========================================

class ParentProfileChildResponse(BaseModel):
    """Safe child summary exposed on the authenticated parent's profile page."""

    id: UUID
    alias: str
    grade: int = Field(ge=1, le=5)
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


class ParentProfileResponse(BaseModel):
    id: UUID = Field(
        validation_alias="Id",
        serialization_alias="id",
    )

    display_name: Optional[str] = Field(
        default=None,
        validation_alias="DisplayName",
        serialization_alias="display_name",
    )

    role: str = Field(
        validation_alias="Role",
        serialization_alias="role",
    )

    created_at: datetime = Field(
        validation_alias="CreatedAt",
        serialization_alias="created_at",
    )

    # Email and phone are owned by Supabase Auth, not public.profiles.
    email: Optional[str] = None
    phone: Optional[str] = None
    email_verified: Optional[bool] = None
    phone_verified: Optional[bool] = None
    contact_info_status: Literal[
        "available", "not_configured", "user_not_found", "lookup_failed"
    ] = "lookup_failed"
    children: List[ParentProfileChildResponse] = Field(default_factory=list)

    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        extra="forbid",
    )


class ProfileResponse(ProfileBase):
    Id: UUID
    CreatedAt: datetime

    children: List[ChildProfileResponse] = Field(
        default_factory=list
    )

    model_config = ConfigDict(from_attributes=True)


# =========================================================
# ADMIN: PARENT CRUD REQUEST SCHEMAS
# =========================================================

class AdminParentCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    phone: Optional[str] = Field(default=None, max_length=30)

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("display_name must not be empty")
        return value

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return str(value).strip().lower()

    @field_validator("phone")
    @classmethod
    def normalize_phone(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return None
        value = value.strip()
        import re
        if not re.fullmatch(r"\+?[0-9][0-9\s().-]{5,24}", value):
            raise ValueError("phone format is invalid")
        return value


class AdminParentUpdateRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=30)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_patch(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be supplied")
        if "display_name" in self.model_fields_set:
            if self.display_name is None or not self.display_name.strip():
                raise ValueError("display_name must not be empty")
            self.display_name = self.display_name.strip()
        if "email" in self.model_fields_set:
            if self.email is None:
                raise ValueError("email cannot be null")
            self.email = str(self.email).strip().lower()
        if "phone" in self.model_fields_set:
            if self.phone is None:
                raise ValueError("phone cannot be null; omit it to leave unchanged")
            self.phone = self.phone.strip()
            import re
            if not re.fullmatch(r"\+?[0-9][0-9\s().-]{5,24}", self.phone):
                raise ValueError("phone format is invalid")
        return self


class AdminParentListItem(BaseModel):
    id: UUID
    display_name: Optional[str] = None
    created_at: datetime
    children_count: int = Field(ge=0)


class AdminParentListResponse(BaseModel):
    items: List[AdminParentListItem]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)


class AdminParentSoftDeleteResponse(BaseModel):
    id: UUID
    active: Literal[0]


# =========================================================
# ADMIN: READ-ONLY PARENT DETAIL
# =========================================================

class AdminParentDetailChild(BaseModel):
    id: UUID
    alias: str
    grade: int = Field(ge=1, le=5)
    created_at: datetime


class AdminParentDetailResponse(BaseModel):
    id: UUID
    display_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    created_at: datetime
    children: List[AdminParentDetailChild] = Field(default_factory=list)
    contact_info_status: Literal["available", "not_configured", "user_not_found", "lookup_failed"] = Field(
        description="Normalized status of the server-side Supabase Auth lookup."
    )

    model_config = ConfigDict(extra="forbid")
