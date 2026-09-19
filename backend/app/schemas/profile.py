# file: backend/app/schemas/profile.py
from pydantic import BaseModel, UUID4, Field, ConfigDict
from typing import Optional, Dict, Any, List
from datetime import datetime

# ==========================================
# 1. SCHEMAS CHO HỒ SƠ BÉ (CHILD PROFILE)
# ==========================================

class ChildProfileBase(BaseModel):
    Alias: str
    Grade: int = Field(..., ge=1, le=5)
    Settings: Dict[str, Any] = Field(default_factory=dict)

class ChildProfileCreate(ChildProfileBase):
    ParentId: UUID4

class ChildProfileResponse(ChildProfileBase):
    Id: UUID4
    ParentId: UUID4
    CreatedAt: datetime

    # Chuẩn mới nhất của Pydantic v2 để đọc dữ liệu từ SQLAlchemy Model
    model_config = ConfigDict(from_attributes=True)


# ==========================================
# 2. SCHEMAS CHO PHỤ HUYNH (PROFILE)
# ==========================================

class ProfileBase(BaseModel):
    Role: str
    DisplayName: Optional[str] = None

class ProfileCreate(ProfileBase):
    pass 

class ProfileResponse(ProfileBase):
    Id: UUID4
    CreatedAt: datetime
    children: List[ChildProfileResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)