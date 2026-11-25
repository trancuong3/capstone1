/**
 * TypeScript data contracts for ViRead Intelligent OCR Content Extraction (M1).
 * Mirrors `backend/app/schemas/ocr_extraction.py`.
 */

export const OCR_BLOCK_TYPES = [
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
] as const;

export type OcrBlockType = (typeof OCR_BLOCK_TYPES)[number];

export const PAGE_KIND_TYPES = [
  "TEXT_ONLY",
  "TEXT_AND_IMAGE",
  "IMAGE_PRIMARY",
  "COMIC",
  "POEM",
  "EXERCISE",
  "MULTI_COLUMN",
  "TEXT_OVER_IMAGE",
  "LOW_QUALITY",
] as const;

export type PageKindType = (typeof PAGE_KIND_TYPES)[number];

export type BlockDecision = "KEEP" | "EXCLUDE" | "REVIEW";

export type DecisionSource =
  | "GEOMETRIC"
  | "CROSS_PAGE"
  | "SEMANTIC_AI"
  | "HUMAN"
  | "CIRCUIT_BREAKER"
  | "SHADOW_FALLBACK";

export type FilterMode = "off" | "shadow" | "active";

export type HumanBlockActionType = "KEEP" | "EXCLUDE" | "RESTORE" | "EDIT";

export type LightingProfile =
  "NORMAL" | "SHADOW" | "UNEVEN_LIGHT" | "LOW_LIGHT" | "OVER_EXPOSED";

export interface GutterDetectionResultDTO {
  readonly is_double_page: boolean;
  readonly gutter_x_norm: number | null;
  readonly confidence: number;
  readonly crossing_line_count: number;
  readonly split_recommended: boolean;
  readonly reason_vi: string;
}

export interface DocumentBoundaryResultDTO {
  readonly image_width: number;
  readonly image_height: number;
  readonly boundary_quad_norm: ReadonlyArray<ReadonlyArray<number>>;
  readonly boundary_quad_px: ReadonlyArray<ReadonlyArray<number>>;
  readonly boundary_bbox_norm: ReadonlyArray<number>;
  readonly area_ratio: number;
  readonly confidence: number;
  readonly deskew_angle_deg: number;
  readonly auto_crop: boolean;
  readonly requires_crop_review: boolean;
  readonly clips_margin_text: boolean;
  readonly transform_matrix: ReadonlyArray<ReadonlyArray<number>>;
  readonly inverse_transform_matrix: ReadonlyArray<ReadonlyArray<number>>;
  readonly output_width: number;
  readonly output_height: number;
  readonly gutter: GutterDetectionResultDTO;
  readonly lighting_profile: LightingProfile;
  readonly processing_ms: number;
  readonly reason_vi: string;
}

export interface OcrWordInputDTO {
  readonly word_id?: string | null;
  readonly source_word_index?: number | null;
  readonly line_index?: number;
  readonly text: string;
  readonly bbox: readonly [number, number, number, number];
  readonly confidence?: number | null;
  readonly angle_deg?: number | null;
  readonly contrast_score?: number | null;
}

export interface CrossPageContextInputDTO {
  readonly page_number: number;
  readonly words: readonly OcrWordInputDTO[];
}

export interface ExtractedWordDTO {
  readonly word_id: string;
  readonly source_word_index: number;
  readonly block_id: string;
  readonly reading_order: number;
  readonly line_index: number;
  readonly text: string;
  readonly normalized_text: string;
  readonly bbox: readonly number[];
  readonly confidence: number | null;
}

export interface BlockAuditEventDTO {
  readonly actor_id: string;
  readonly action: string;
  readonly previous_decision: BlockDecision | null;
  readonly new_decision: BlockDecision;
  readonly reason: string | null;
  readonly timestamp: string;
}

export interface ExtractedBlockDTO {
  readonly block_id: string;
  readonly raw_text: string;
  readonly display_text: string;
  readonly bbox: readonly number[];
  readonly reading_order: number;
  readonly column_index: number;
  readonly line_indices: readonly number[];
  readonly word_ids: readonly string[];
  readonly source_word_indices: readonly number[];
  readonly block_type: OcrBlockType;
  readonly decision: BlockDecision;
  readonly auto_decision: BlockDecision;
  readonly reason_vi: string;
  readonly reason_code: string;
  readonly decision_source: DecisionSource;
  readonly confidence: number;
  readonly user_override: boolean;
  readonly edited_text: string | null;
  readonly cross_page_matches: readonly number[];
  readonly in_canonical: boolean;
  readonly audit_trail: readonly BlockAuditEventDTO[];
}

export interface ExtractionStatsDTO {
  readonly total_blocks: number;
  readonly keep_blocks: number;
  readonly exclude_blocks: number;
  readonly review_blocks: number;
  readonly total_chars: number;
  readonly kept_chars: number;
  readonly excluded_chars: number;
  readonly review_chars: number;
  readonly retention_ratio: number;
  readonly circuit_breaker_triggered: boolean;
  readonly fast_path_ms: number;
  readonly cross_page_ms: number;
  readonly semantic_ai_ms: number;
  readonly total_ms: number;
  readonly semantic_ai_invoked: boolean;
  readonly semantic_ai_fallback_used: boolean;
  readonly semantic_ai_error_code: string | null;
}

export interface PageOcrExtractionDTO {
  readonly extraction_id: string | null;
  readonly book_id: string | null;
  readonly book_page_id: string | null;
  readonly page_revision_id: string | null;
  readonly source_hash: string;
  readonly algorithm_version: string;
  readonly filter_mode: FilterMode;
  readonly page_kind: PageKindType;
  readonly geometry_transform: DocumentBoundaryResultDTO | null;
  readonly blocks: readonly ExtractedBlockDTO[];
  readonly canonical_text: string;
  readonly canonical_words: readonly ExtractedWordDTO[];
  readonly stats: ExtractionStatsDTO;
  readonly requires_review: boolean;
  readonly undo_available: boolean;
  readonly undo_depth: number;
  readonly persisted: boolean;
  readonly storage_degraded: boolean;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

export interface AnalyzeBlocksRequestDTO {
  readonly book_id?: string | null;
  readonly page_id?: string | null;
  readonly page_number?: number;
  readonly book_title?: string | null;
  readonly book_author?: string | null;
  readonly image_width?: number;
  readonly image_height?: number;
  readonly image_base64?: string | null;
  readonly words: readonly OcrWordInputDTO[];
  readonly cross_pages?: readonly CrossPageContextInputDTO[];
  readonly filter_mode?: FilterMode | null;
  readonly boundary?: DocumentBoundaryResultDTO | null;
  readonly target_spread_side?: "LEFT" | "RIGHT" | null;
}

export interface PageExtractRequestDTO {
  readonly page_revision_id?: string | null;
  readonly words?: readonly OcrWordInputDTO[] | null;
  readonly cross_pages?: readonly CrossPageContextInputDTO[] | null;
  readonly image_base64?: string | null;
  readonly filter_mode?: FilterMode | null;
  readonly include_cross_page?: boolean;
  readonly boundary?: DocumentBoundaryResultDTO | null;
}

export interface BlockDecisionActionInputDTO {
  readonly block_id: string;
  readonly action: HumanBlockActionType;
  readonly edited_text?: string | null;
  readonly reason?: string | null;
}

export interface PatchPageBlocksRequestDTO {
  readonly actions?: readonly BlockDecisionActionInputDTO[];
  readonly accept_clear_blocks?: boolean;
  readonly undo?: boolean;
}

export const BLOCK_TYPE_LABELS_VI: Record<OcrBlockType, string> = {
  MAIN_TITLE: "Tiêu đề chính",
  CHAPTER_TITLE: "Tiêu đề chương / bài",
  SUBHEADING: "Tiêu đề phụ",
  STORY_BODY: "Nội dung truyện",
  POEM_BODY: "Khổ thơ",
  DIALOGUE: "Lời thoại",
  READING_CAPTION: "Chú thích tranh",
  EXERCISE: "Bài tập",
  QUESTION: "Câu hỏi",
  EDUCATIONAL_LABEL: "Ghi nhớ / kiến thức",
  PAGE_NUMBER: "Số trang",
  RUNNING_HEADER: "Tiêu đề lặp đầu trang",
  RUNNING_FOOTER: "Chân trang lặp cuối trang",
  WATERMARK: "Chữ nền / watermark",
  PUBLISHER_METADATA: "Thông tin nhà xuất bản",
  OUTSIDE_PAGE: "Chữ ngoài vùng trang",
  ADJACENT_PAGE_TEXT: "Chữ từ trang kế bên",
  BACKGROUND_TEXT: "Chữ nền mờ",
  ILLUSTRATION: "Vùng tranh minh họa",
  UNKNOWN: "Chưa phân loại rõ",
};

export const PAGE_KIND_LABELS_VI: Record<PageKindType, string> = {
  TEXT_ONLY: "Trang toàn chữ",
  TEXT_AND_IMAGE: "Trang chữ và tranh",
  IMAGE_PRIMARY: "Trang chủ yếu hình ảnh",
  COMIC: "Trang truyện tranh",
  POEM: "Trang thơ",
  EXERCISE: "Trang bài tập",
  MULTI_COLUMN: "Trang nhiều cột",
  TEXT_OVER_IMAGE: "Chữ in trên nền tranh",
  LOW_QUALITY: "Ảnh chất lượng thấp",
};
