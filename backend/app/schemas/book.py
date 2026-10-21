from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator
from typing import Optional, Dict, Any, List, Literal
from datetime import datetime
from uuid import UUID

# --- BOOK ---
class BookBase(BaseModel):
    Name: str | None = Field(default=None, max_length=250)
    Title: str = Field(..., min_length=1)
    Author: Optional[str] = None
    MinGrade: int = Field(..., ge=1, le=5)
    MaxGrade: int = Field(..., ge=1, le=5)
    LifecycleStatus: Literal["ACTIVE", "RETIRED"] = Field(..., example="ACTIVE")

    @field_validator("Name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("Vui lòng nhập tên sách.")
        return normalized

    @field_validator("Title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Title must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_grade_range(self):
        if self.MinGrade > self.MaxGrade:
            raise ValueError("MinGrade must be less than or equal to MaxGrade")
        return self

class BookCreate(BookBase):
    Name: str = Field(..., min_length=1, max_length=250)
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
from pydantic import AliasChoices


class CatalogBookResponse(BaseModel):
    id: UUID = Field(validation_alias=AliasChoices("id", "Id"))
    name: str | None = Field(default=None, validation_alias=AliasChoices("name", "Name"))
    title: str = Field(validation_alias=AliasChoices("title", "Title"))
    author: str | None = Field(validation_alias=AliasChoices("author", "Author"))
    min_grade: int = Field(ge=1, le=5, validation_alias=AliasChoices("min_grade", "MinGrade"))
    max_grade: int = Field(ge=1, le=5, validation_alias=AliasChoices("max_grade", "MaxGrade"))
    lifecycle_status: Literal["ACTIVE", "RETIRED"] = Field(
        validation_alias=AliasChoices("lifecycle_status", "LifecycleStatus")
    )
    model_config = ConfigDict(from_attributes=True)


class AdminBookMetadataResponse(BaseModel):
    """Admin metadata contract tolerates legacy values so invalid rows remain repairable."""

    id: UUID = Field(validation_alias=AliasChoices("id", "Id"))
    name: str | None = Field(default=None, validation_alias=AliasChoices("name", "Name"))
    title: str = Field(validation_alias=AliasChoices("title", "Title"))
    author: str | None = Field(validation_alias=AliasChoices("author", "Author"))
    min_grade: int = Field(validation_alias=AliasChoices("min_grade", "MinGrade"))
    max_grade: int = Field(validation_alias=AliasChoices("max_grade", "MaxGrade"))
    lifecycle_status: Literal["ACTIVE", "RETIRED"] = Field(
        validation_alias=AliasChoices("lifecycle_status", "LifecycleStatus")
    )
    model_config = ConfigDict(from_attributes=True)


class AdminCatalogBookDetailResponse(AdminBookMetadataResponse):
    """Admin-only book detail metadata; includes retired page numbers for safe numbering."""

    next_page_number: int = Field(ge=1)


class CatalogPagePreviewResponse(BaseModel):
    page_id: UUID
    page_number: int = Field(gt=0)
    lifecycle_status: Literal["ACTIVE"]
    current_verified_revision_id: UUID
    preview_url: str


class AdminCatalogBookResponse(BaseModel):
    book: AdminBookMetadataResponse
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
    text_preview: str | None = None


class AdminPageLifecycleRead(BaseModel):
    page_id: UUID
    book_id: UUID
    page_number: int = Field(gt=0)
    lifecycle_status: Literal["RETIRED"]


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
