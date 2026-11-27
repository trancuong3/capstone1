"""Pydantic schemas for ViRead AI Smart Book Studio V2 covers, style bibles & illustrations."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

AssetRole = Literal["COVER", "PAGE_ILLUSTRATION", "THUMBNAIL"]
AssetSourceType = Literal[
    "USER_UPLOAD",
    "ORIGINAL_CROP",
    "ENHANCED_CROP",
    "AI_GENERATED",
    "METADATA_RENDER",
]
AssetModerationStatus = Literal["PENDING", "APPROVED", "REJECTED", "STALE"]
CoverPrioritySource = Literal["USER_UPLOAD", "AI_GENERATED", "METADATA_RENDER"]
ReadingDisplayMode = Literal["ILLUSTRATED", "TEXT", "ORIGINAL"]


class MetadataCoverFallbackRead(BaseModel):
    """Deterministic high-craft Vietnamese metadata cover configuration (never labeled AI)."""

    model_config = ConfigDict(extra="forbid")

    palette_id: str
    primary_color: str
    secondary_color: str
    accent_color: str
    motif: str
    title: str
    author: str | None = None
    grade_label: str
    source_type: Literal["METADATA_RENDER"] = "METADATA_RENDER"


class BookPresentationAssetRead(BaseModel):
    """Public/authenticated DTO for cover and page illustration assets (relative media URL only)."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    book_id: UUID
    book_page_id: UUID | None = None
    source_revision_id: UUID | None = None
    asset_role: AssetRole
    source_type: AssetSourceType
    media_url: str
    mime_type: str
    width: int | None = None
    height: int | None = None
    size_bytes: int | None = None
    asset_hash: str
    asset_version: int
    is_active: bool
    text_free_verified: bool
    moderation_status: AssetModerationStatus
    provider_name: str | None = None
    model_id: str | None = None
    job_id: UUID | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class StyleBibleCharacterRead(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    visual_traits: list[str] = Field(default_factory=list)


class StyleBibleContentRead(BaseModel):
    model_config = ConfigDict(extra="forbid")

    genre: str
    age_group: str
    color_palette: list[str] = Field(default_factory=list)
    art_style: str
    characters: list[StyleBibleCharacterRead] = Field(default_factory=list)
    settings: list[str] = Field(default_factory=list)
    invariants: list[str] = Field(default_factory=list)
    mood: str = "ấm áp, tươi sáng, thân thiện với thiếu nhi"
    prompt_prefix: str = ""


class BookStyleBibleRead(BaseModel):
    model_config = ConfigDict(extra="forbid")

    book_id: UUID
    context_hash: str
    cache_hit: bool = False
    bible: StyleBibleContentRead
    provider_name: str | None = None
    model_id: str | None = None
    updated_at: datetime


class BookStyleBibleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    force_refresh: bool = False
    sample_texts: list[str] = Field(default_factory=list, max_length=12)


class BookCoverGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt_hint: str | None = Field(default=None, max_length=400)
    idempotency_key: str | None = Field(default=None, max_length=128)
    force_regenerate: bool = False


class BookCoverFromPageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_id: UUID
    crop_x: float | None = Field(default=None, ge=0.0, le=1.0)
    crop_y: float | None = Field(default=None, ge=0.0, le=1.0)
    crop_w: float | None = Field(default=None, ge=0.05, le=1.0)
    crop_h: float | None = Field(default=None, ge=0.05, le=1.0)
    rotation: int = Field(default=0)
    apply_clahe_restore: bool = True
    force_replace_user_upload: bool = False


class BookCoverGenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal[
        "QUEUED",
        "SUCCEEDED",
        "BLOCKED_NO_IMAGE_PROVIDER",
        "WAITING_FOR_QUOTA",
        "SUPERSEDED_BY_USER_UPLOAD",
        "REJECTED_CONTAINS_TEXT",
    ]
    job_id: UUID | None = None
    provider_name: str | None = None
    model_id: str | None = None
    message_vi: str
    cover: BookPresentationAssetRead | None = None
    metadata_fallback: MetadataCoverFallbackRead
    style_bible: BookStyleBibleRead | None = None
    honest_ai_generated: bool = False


class BookCoverDeleteResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    book_id: UUID
    removed_count: int
    metadata_fallback: MetadataCoverFallbackRead
    message_vi: str


class PageIllustrationExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word_bboxes: list[list[float]] = Field(default_factory=list)
    canonical_text: str | None = Field(default=None, max_length=12000)
    apply_clahe_restore: bool = True
    min_area_ratio: float = Field(default=0.12, ge=0.05, le=0.8)


class PageIllustrationExtractResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal[
        "EXTRACTED_VERIFIED",
        "REJECTED_CONTAINS_TEXT",
        "NO_CLEAN_ARTWORK",
        "FAILED",
    ]
    asset: BookPresentationAssetRead | None = None
    text_free_verified: bool
    text_density_score: float
    ocr_overlap_score: float
    artwork_area_ratio: float
    recommended_reading_mode: ReadingDisplayMode
    message_vi: str


class PageIllustrationGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt_hint: str | None = Field(default=None, max_length=400)
    idempotency_key: str | None = Field(default=None, max_length=128)


class PageIllustrationGenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal[
        "QUEUED",
        "SUCCEEDED",
        "BLOCKED_NO_IMAGE_PROVIDER",
        "WAITING_FOR_QUOTA",
        "REJECTED_CONTAINS_TEXT",
        "STALE",
    ]
    job_id: UUID | None = None
    provider_name: str | None = None
    model_id: str | None = None
    asset: BookPresentationAssetRead | None = None
    recommended_reading_mode: ReadingDisplayMode
    message_vi: str


class PageIllustrationModerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["APPROVE", "REJECT", "RESTORE"]
    reason: str | None = Field(default=None, max_length=300)


class BookAssetsSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    book_id: UUID
    title: str
    author: str | None = None
    min_grade: int
    max_grade: int
    visibility_scope: str
    active_cover: BookPresentationAssetRead | None = None
    effective_cover_source: CoverPrioritySource
    metadata_fallback: MetadataCoverFallbackRead
    style_bible: BookStyleBibleRead | None = None
    page_illustrations: list[BookPresentationAssetRead] = Field(default_factory=list)
    ai_image_provider_available: bool = False
    ai_image_provider_name: str | None = None
    ai_image_provider_message_vi: str
    v2_storage_degraded: bool = False
