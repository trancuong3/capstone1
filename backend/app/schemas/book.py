from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any, List
from datetime import datetime
from uuid import UUID

# --- BOOK ---
class BookBase(BaseModel):
    Title: str = Field(...)
    Author: Optional[str] = None
    MinGrade: int = Field(..., ge=1, le=5)
    MaxGrade: int = Field(..., ge=1, le=5)
    LifecycleStatus: str = Field(..., example="ACTIVE")

class BookCreate(BookBase):
    CreatedBy: Optional[UUID] = None

class BookResponse(BookBase):
    Id: UUID
    CreatedBy: Optional[UUID]
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)

# --- BOOK PAGE ---
class BookPageBase(BaseModel):
    PageNumber: int = Field(..., gt=0)
    ImagePath: str
    Width: int
    Height: int
    FeaturePath: Optional[str] = None
    ProcessingMeta: Dict[str, Any] = Field(default_factory=dict)
    LifecycleStatus: str = Field(..., example="ACTIVE")

class BookPageCreate(BookPageBase):
    BookId: UUID
    CurrentVerifiedRevisionId: Optional[UUID] = None

class BookPageResponse(BookPageBase):
    Id: UUID
    BookId: UUID
    CurrentVerifiedRevisionId: Optional[UUID]
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)

# --- PAGE REVISION ---
class PageRevisionBase(BaseModel):
    RevisionNo: str
    VerificationStatus: str
    VerifiedText: Optional[str] = None
    ContentHash: str
    ProcessingMeta: Dict[str, Any] = Field(default_factory=dict)

class PageRevisionCreate(PageRevisionBase):
    PageId: UUID
    VerifiedBy: Optional[UUID] = None
    VerifiedAt: Optional[datetime] = None

class PageRevisionResponse(PageRevisionBase):
    Id: UUID
    PageId: UUID
    VerifiedBy: Optional[UUID]
    VerifiedAt: Optional[datetime]
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)

# --- PAGE REVISION WORD ---
class PageRevisionWordBase(BaseModel):
    WordIndex: int
    LineIndex: int
    Text: str
    NormalizedText: str
    BoundingBox: Dict[str, Any]
    OCRConfidence: Optional[float] = Field(None, ge=0, le=1)

class PageRevisionWordCreate(PageRevisionWordBase):
    PageRevisionId: UUID

class PageRevisionWordResponse(PageRevisionWordBase):
    Id: UUID
    PageRevisionId: UUID
    model_config = ConfigDict(from_attributes=True)