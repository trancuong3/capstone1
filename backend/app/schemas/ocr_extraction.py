"""Pydantic schemas and canonical taxonomy for ViRead Intelligent OCR Content Extraction (M1)."""

from __future__ import annotations

import unicodedata
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# 20-Class Canonical Block Taxonomy
# ---------------------------------------------------------------------------
OcrBlockType = Literal[
    "MAIN_TITLE",
    "CHAPTER_TITLE",
    "SUBHEADING",
    "STORY_BODY",
    "POEM_BODY",
    "DIALOGUE",
    "READING_CAPTION",
    "EXERCISE",
    "QUESTION",
    "EDUCATIONAL_LABEL",
    "PAGE_NUMBER",
    "RUNNING_HEADER",
    "RUNNING_FOOTER",
    "WATERMARK",
    "PUBLISHER_METADATA",
    "OUTSIDE_PAGE",
    "ADJACENT_PAGE_TEXT",
    "BACKGROUND_TEXT",
    "ILLUSTRATION",
    "UNKNOWN",
]

CANONICAL_BLOCK_TYPES: tuple[OcrBlockType, ...] = (
    "MAIN_TITLE",
    "CHAPTER_TITLE",
    "SUBHEADING",
    "STORY_BODY",
    "POEM_BODY",
    "DIALOGUE",
    "READING_CAPTION",
    "EXERCISE",
    "QUESTION",
    "EDUCATIONAL_LABEL",
    "PAGE_NUMBER",
    "RUNNING_HEADER",
    "RUNNING_FOOTER",
    "WATERMARK",
    "PUBLISHER_METADATA",
    "OUTSIDE_PAGE",
    "ADJACENT_PAGE_TEXT",
    "BACKGROUND_TEXT",
    "ILLUSTRATION",
    "UNKNOWN",
)

# Readable classes (1-10) NEVER auto-exclude; UNKNOWN also NEVER auto-excludes (always REVIEW).
PROTECTED_CONTENT_BLOCK_TYPES: frozenset[str] = frozenset(
    {
        "MAIN_TITLE",
        "CHAPTER_TITLE",
        "SUBHEADING",
        "STORY_BODY",
        "POEM_BODY",
        "DIALOGUE",
        "READING_CAPTION",
        "EXERCISE",
        "QUESTION",
        "EDUCATIONAL_LABEL",
    }
)

NEVER_AUTO_EXCLUDE_BLOCK_TYPES: frozenset[str] = PROTECTED_CONTENT_BLOCK_TYPES | frozenset(
    {"UNKNOWN"}
)

NOISE_CANDIDATE_BLOCK_TYPES: frozenset[str] = frozenset(
    {
        "PAGE_NUMBER",
        "RUNNING_HEADER",
        "RUNNING_FOOTER",
        "WATERMARK",
        "PUBLISHER_METADATA",
        "OUTSIDE_PAGE",
        "ADJACENT_PAGE_TEXT",
        "BACKGROUND_TEXT",
    }
)

PageKindType = Literal[
    "TEXT_ONLY",
    "TEXT_AND_IMAGE",
    "IMAGE_PRIMARY",
    "COMIC",
    "POEM",
    "EXERCISE",
    "MULTI_COLUMN",
    "TEXT_OVER_IMAGE",
    "LOW_QUALITY",
]

BlockDecision = Literal["KEEP", "EXCLUDE", "REVIEW"]
DecisionSource = Literal[
    "GEOMETRIC",
    "CROSS_PAGE",
    "SEMANTIC_AI",
    "HUMAN",
    "CIRCUIT_BREAKER",
    "SHADOW_FALLBACK",
]
FilterMode = Literal["off", "shadow", "active"]
HumanBlockActionType = Literal["KEEP", "EXCLUDE", "RESTORE", "EDIT"]
LightingProfile = Literal[
    "NORMAL",
    "SHADOW",
    "UNEVEN_LIGHT",
    "LOW_LIGHT",
    "OVER_EXPOSED",
]


def _validate_normalized_bbox(bbox: list[float]) -> list[float]:
    if len(bbox) != 4:
        raise ValueError("bbox must contain exactly 4 floats: [x, y, w, h]")
    x, y, w, h = (float(v) for v in bbox)
    if any(v != v for v in (x, y, w, h)):  # NaN guard
        raise ValueError("bbox cannot contain NaN")
    if w <= 0.0 or h <= 0.0:
        raise ValueError("bbox width and height must be positive")
    if x < -1e-3 or y < -1e-3 or x > 1.0 + 1e-3 or y > 1.0 + 1e-3:
        raise ValueError("bbox origin must lie inside normalized [0, 1] bounds")
    if x + w > 1.0 + 1e-2 or y + h > 1.0 + 1e-2:
        raise ValueError("bbox extends beyond normalized [0, 1] bounds")
    cx = max(0.0, min(1.0, x))
    cy = max(0.0, min(1.0, y))
    cw = max(1e-6, min(1.0 - cx, w))
    ch = max(1e-6, min(1.0 - cy, h))
    return [round(cx, 6), round(cy, 6), round(cw, 6), round(ch, 6)]


# ---------------------------------------------------------------------------
# Document Boundary & Geometry Contracts
# ---------------------------------------------------------------------------
class GutterDetectionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_double_page: bool = False
    gutter_x_norm: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    crossing_line_count: int = Field(default=0, ge=0)
    split_recommended: bool = False
    reason_vi: str = "Trang đơn — không phát hiện nếp gấp gáy sách."


class DocumentBoundaryResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_width: int = Field(ge=1)
    image_height: int = Field(ge=1)
    boundary_quad_norm: list[list[float]] = Field(min_length=4, max_length=4)
    boundary_quad_px: list[list[float]] = Field(min_length=4, max_length=4)
    boundary_bbox_norm: list[float] = Field(min_length=4, max_length=4)
    area_ratio: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    deskew_angle_deg: float = Field(default=0.0, ge=-45.0, le=45.0)
    auto_crop: bool = False
    requires_crop_review: bool = False
    clips_margin_text: bool = False
    transform_matrix: list[list[float]] = Field(min_length=3, max_length=3)
    inverse_transform_matrix: list[list[float]] = Field(min_length=3, max_length=3)
    output_width: int = Field(ge=1)
    output_height: int = Field(ge=1)
    gutter: GutterDetectionResult = Field(default_factory=GutterDetectionResult)
    lighting_profile: LightingProfile = "NORMAL"
    processing_ms: float = Field(default=0.0, ge=0.0)
    reason_vi: str = "Giữ nguyên khung ảnh gốc để bảo toàn chữ gần mép trang."


# ---------------------------------------------------------------------------
# OCR Extraction Input & Output Contracts
# ---------------------------------------------------------------------------
class OcrWordInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    word_id: str | None = Field(default=None, max_length=96)
    source_word_index: int | None = Field(default=None, ge=0)
    line_index: int = Field(default=0, ge=0)
    text: str = Field(..., min_length=1, max_length=500)
    bbox: list[float] = Field(..., min_length=4, max_length=4)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    angle_deg: float | None = Field(default=None, ge=-90.0, le=90.0)
    contrast_score: float | None = Field(default=None, ge=0.0, le=1.0)

    @field_validator("text")
    @classmethod
    def normalize_nfc_text(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFC", value).strip()
        if not normalized:
            raise ValueError("word text must not be blank")
        return normalized

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: list[float]) -> list[float]:
        return _validate_normalized_bbox(value)


class CrossPageContextInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    page_number: int = Field(ge=1, le=32767)
    words: list[OcrWordInput] = Field(default_factory=list, max_length=10_000)


class ExtractedWord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word_id: str
    source_word_index: int = Field(ge=0)
    block_id: str
    reading_order: int = Field(ge=0)
    line_index: int = Field(ge=0)
    text: str
    normalized_text: str
    bbox: list[float] = Field(min_length=4, max_length=4)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class BlockAuditEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actor_id: str
    action: str
    previous_decision: BlockDecision | None = None
    new_decision: BlockDecision
    reason: str | None = None
    timestamp: str


class ExtractedBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    block_id: str
    raw_text: str
    display_text: str
    bbox: list[float] = Field(min_length=4, max_length=4)
    reading_order: int = Field(ge=0)
    column_index: int = Field(default=0, ge=0)
    line_indices: list[int] = Field(default_factory=list)
    word_ids: list[str] = Field(default_factory=list)
    source_word_indices: list[int] = Field(default_factory=list)
    block_type: OcrBlockType
    decision: BlockDecision
    auto_decision: BlockDecision
    reason_vi: str
    reason_code: str
    decision_source: DecisionSource
    confidence: float = Field(ge=0.0, le=1.0)
    user_override: bool = False
    edited_text: str | None = None
    cross_page_matches: list[int] = Field(default_factory=list)
    in_canonical: bool = True
    audit_trail: list[BlockAuditEvent] = Field(default_factory=list)


class ExtractionStats(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_blocks: int = Field(default=0, ge=0)
    keep_blocks: int = Field(default=0, ge=0)
    exclude_blocks: int = Field(default=0, ge=0)
    review_blocks: int = Field(default=0, ge=0)
    total_chars: int = Field(default=0, ge=0)
    kept_chars: int = Field(default=0, ge=0)
    excluded_chars: int = Field(default=0, ge=0)
    review_chars: int = Field(default=0, ge=0)
    retention_ratio: float = Field(default=1.0, ge=0.0, le=1.0)
    circuit_breaker_triggered: bool = False
    fast_path_ms: float = Field(default=0.0, ge=0.0)
    cross_page_ms: float = Field(default=0.0, ge=0.0)
    semantic_ai_ms: float = Field(default=0.0, ge=0.0)
    total_ms: float = Field(default=0.0, ge=0.0)
    semantic_ai_invoked: bool = False
    semantic_ai_fallback_used: bool = False
    semantic_ai_error_code: str | None = None


class AnalyzeBlocksRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    book_id: UUID | None = None
    page_id: UUID | None = None
    page_number: int = Field(default=1, ge=1, le=32767)
    book_title: str | None = Field(default=None, max_length=300)
    book_author: str | None = Field(default=None, max_length=200)
    image_width: int = Field(default=1000, ge=1, le=20_000)
    image_height: int = Field(default=1400, ge=1, le=20_000)
    image_base64: str | None = Field(default=None, max_length=14_000_000)
    words: list[OcrWordInput] = Field(default_factory=list, max_length=30_000)
    cross_pages: list[CrossPageContextInput] = Field(default_factory=list, max_length=300)
    filter_mode: FilterMode | None = None
    boundary: DocumentBoundaryResult | None = None
    target_spread_side: Literal["LEFT", "RIGHT"] | None = None
    semantic_ai_json: str | dict[str, Any] | None = None
    run_semantic_ai: bool = False


class PageExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_revision_id: UUID | None = None
    words: list[OcrWordInput] | None = Field(default=None, max_length=30_000)
    cross_pages: list[CrossPageContextInput] | None = Field(default=None, max_length=300)
    image_base64: str | None = Field(default=None, max_length=14_000_000)
    filter_mode: FilterMode | None = None
    include_cross_page: bool = True
    boundary: DocumentBoundaryResult | None = None
    semantic_ai_json: str | dict[str, Any] | None = None
    run_semantic_ai: bool = False


class ApplyExtractionToDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_revision_id: UUID | None = None


class ApplyExtractionToDraftResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_id: UUID
    revision_id: UUID
    applied_word_count: int = Field(ge=0)
    canonical_text: str
    status: Literal["APPLIED"] = "APPLIED"


class BlockDecisionUpdateItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    block_id: str = Field(..., min_length=1, max_length=96)
    action: HumanBlockActionType
    edited_text: str | None = Field(default=None, max_length=50_000)
    reason: str | None = Field(default=None, max_length=300)

    @field_validator("edited_text")
    @classmethod
    def normalize_edited_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = unicodedata.normalize("NFC", value).strip()
        if not normalized:
            raise ValueError("edited_text must not be blank when provided")
        return normalized


class PatchPageBlocksRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actions: list[BlockDecisionUpdateItem] = Field(default_factory=list, max_length=1000)
    accept_clear_blocks: bool = False
    undo: bool = False


class PageOcrExtractionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    extraction_id: UUID | None = None
    book_id: UUID | None = None
    book_page_id: UUID | None = None
    page_revision_id: UUID | None = None
    source_hash: str
    algorithm_version: str = "v2.0"
    filter_mode: FilterMode
    page_kind: PageKindType
    geometry_transform: DocumentBoundaryResult | None = None
    blocks: list[ExtractedBlock]
    canonical_text: str
    canonical_words: list[ExtractedWord]
    stats: ExtractionStats
    requires_review: bool
    undo_available: bool = False
    undo_depth: int = Field(default=0, ge=0)
    persisted: bool = False
    storage_degraded: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None
