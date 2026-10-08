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


# Read-only Parent DTOs. Legacy request/response contracts above stay unchanged.
from typing import Literal
from pydantic import AliasChoices


class CatalogBookResponse(BaseModel):
    id: UUID = Field(validation_alias=AliasChoices("id", "Id"))
    title: str = Field(validation_alias=AliasChoices("title", "Title"))
    author: str | None = Field(validation_alias=AliasChoices("author", "Author"))
    min_grade: int = Field(ge=1, le=5, validation_alias=AliasChoices("min_grade", "MinGrade"))
    max_grade: int = Field(ge=1, le=5, validation_alias=AliasChoices("max_grade", "MaxGrade"))
    lifecycle_status: Literal["ACTIVE", "RETIRED"] = Field(
        validation_alias=AliasChoices("lifecycle_status", "LifecycleStatus")
    )
    model_config = ConfigDict(from_attributes=True)


class CatalogPagePreviewResponse(BaseModel):
    page_id: UUID
    page_number: int = Field(gt=0)
    lifecycle_status: Literal["ACTIVE"]
    current_verified_revision_id: UUID
    preview_url: str


class AdminCatalogBookResponse(BaseModel):
    book: CatalogBookResponse
    page_count: int = Field(ge=0)
    processing_count: int = Field(ge=0)
    needs_review_count: int = Field(ge=0)
    verified_count: int = Field(ge=0)
    parent_catalog_eligible: bool


class AdminPageProcessingRead(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    revision_no: int = Field(gt=0)
    verification_status: Literal["PROCESSING", "NEEDS_REVIEW", "VERIFIED"]
    lifecycle_status: Literal["ACTIVE", "RETIRED"]
    ocr_preview_metadata: dict[str, object]
    verified_at: datetime | None
    current_verified_revision_id: UUID | None


class AdminPageListRead(BaseModel):
    book_id: UUID
    page_number: int = Field(gt=0)
    processing: AdminPageProcessingRead


class AdminPageImageRead(BaseModel):
    page_id: UUID
    page_number: int = Field(gt=0)
    preview_url: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class AdminRevisionSummaryRead(BaseModel):
    page_revision_id: UUID
    revision_no: int = Field(gt=0)
    verification_status: Literal["PROCESSING", "NEEDS_REVIEW", "VERIFIED"]
    created_at: datetime
    is_current_verified: bool


class AdminRevisionWordRead(BaseModel):
    word_index: int = Field(ge=0)
    line_index: int = Field(ge=0)
    text: str
    normalized_text: str
    bbox: tuple[float, float, float, float]
    ocr_confidence: float | None = Field(ge=0, le=1)


class AdminRevisionDetailRead(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    revision_no: int = Field(gt=0)
    verification_status: Literal["PROCESSING", "NEEDS_REVIEW", "VERIFIED"]
    lifecycle_status: Literal["ACTIVE", "RETIRED"]
    draft_text: str | None
    words: list[AdminRevisionWordRead]
    ocr_metadata: dict[str, object]
    created_at: datetime
    verified_at: datetime | None
    verified_by: UUID | None
