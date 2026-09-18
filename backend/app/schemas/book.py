# file: backend/app/schemas/book.py
from pydantic import BaseModel, UUID4, Field
from typing import Optional, Dict, Any, List
from datetime import datetime

# --- BOOK ---
class BookBase(BaseModel):
    Title: str = Field(...)
    Author: Optional[str] = None
    MinGrade: int = Field(..., ge=1, le=5)
    MaxGrade: int = Field(..., ge=1, le=5)
    LifecycleStatus: str = Field(..., example="ACTIVE")

class BookCreate(BookBase):
    CreatedBy: Optional[UUID4] = None

class BookResponse(BookBase):
    Id: UUID4
    CreatedBy: Optional[UUID4]
    CreatedAt: datetime
    class Config:
        from_attributes = True

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
    BookId: UUID4
    CurrentVerifiedRevisionId: Optional[UUID4] = None

class BookPageResponse(BookPageBase):
    Id: UUID4
    BookId: UUID4
    CurrentVerifiedRevisionId: Optional[UUID4]
    CreatedAt: datetime
    class Config:
        from_attributes = True

# --- PAGE REVISION ---
class PageRevisionBase(BaseModel):
    RevisionNo: str
    VerificationStatus: str
    VerifiedText: Optional[str] = None
    ContentHash: str
    ProcessingMeta: Dict[str, Any] = Field(default_factory=dict)

class PageRevisionCreate(PageRevisionBase):
    PageId: UUID4
    VerifiedBy: Optional[UUID4] = None
    VerifiedAt: Optional[datetime] = None

class PageRevisionResponse(PageRevisionBase):
    Id: UUID4
    PageId: UUID4
    VerifiedBy: Optional[UUID4]
    VerifiedAt: Optional[datetime]
    CreatedAt: datetime
    class Config:
        from_attributes = True

# --- PAGE REVISION WORD ---
class PageRevisionWordBase(BaseModel):
    WordIndex: int
    LineIndex: int
    Text: str
    NormalizedText: str
    BoundingBox: Dict[str, Any]
    OCRConfidence: Optional[float] = Field(None, ge=0, le=1)

class PageRevisionWordCreate(PageRevisionWordBase):
    PageRevisionId: UUID4

class PageRevisionWordResponse(PageRevisionWordBase):
    Id: UUID4
    PageRevisionId: UUID4
    class Config:
        from_attributes = True