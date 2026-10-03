from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any, List
from datetime import datetime
from uuid import UUID

# ==========================================
# 1. SCHEMAS CHO HỒ SƠ BÉ (CHILD PROFILE)
# ==========================================

class ChildProfileBase(BaseModel):
    Alias: str
    Grade: int = Field(..., ge=1, le=5)
    Settings: Dict[str, Any] = Field(default_factory=dict)

class ChildProfileCreate(ChildProfileBase):
    ParentId: UUID

class ChildProfileResponse(ChildProfileBase):
    Id: UUID
    ParentId: UUID
    CreatedAt: datetime
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
    Id: UUID
    CreatedAt: datetime
    children: List[ChildProfileResponse] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)