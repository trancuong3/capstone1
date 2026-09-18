from pydantic import BaseModel, UUID4, Field
from typing import Optional, Dict, Any, List
from datetime import datetime

# ==========================================
# 1. SCHEMAS CHO HỒ SƠ BÉ (CHILD PROFILE)
# ==========================================

# Base: Các trường dữ liệu cơ bản nhất
class ChildProfileBase(BaseModel):
    Alias: str = Field(..., example="Bé Bo")
    Grade: int = Field(..., ge=1, le=5, description="Lớp của bé (1 đến 5)")
    Settings: Dict[str, Any] = Field(default_factory=dict)

# Create: Dữ liệu yêu cầu khi Frontend muốn TẠO MỚI một bé
class ChildProfileCreate(ChildProfileBase):
    ParentId: UUID4

# Response: Dữ liệu Backend TRẢ VỀ cho Frontend khi lấy thông tin bé
class ChildProfileResponse(ChildProfileBase):
    Id: UUID4
    ParentId: UUID4
    CreatedAt: datetime

    class Config:
        # Quan trọng: Cho phép Pydantic tự động đọc dữ liệu từ SQLAlchemy Model
        from_attributes = True 


# ==========================================
# 2. SCHEMAS CHO PHỤ HUYNH (PROFILE)
# ==========================================

class ProfileBase(BaseModel):
    Role: str = Field(..., example="parent")
    DisplayName: Optional[str] = Field(None, example="Mẹ bé Bo")

class ProfileCreate(ProfileBase):
    pass 

class ProfileResponse(ProfileBase):
    Id: UUID4
    CreatedAt: datetime
    
    # Kéo theo danh sách các bé thuộc về phụ huynh này
    children: List[ChildProfileResponse] = []

    class Config:
        from_attributes = True