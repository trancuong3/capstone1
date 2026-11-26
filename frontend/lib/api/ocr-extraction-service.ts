/**
 * Typed API service and Zod v4 response validation for Intelligent OCR Content Extraction.
 * Endpoints are mounted under `/studio/ocr`.
 */

import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";
import {
  OCR_BLOCK_TYPES,
  PAGE_KIND_TYPES,
  type AnalyzeBlocksRequestDTO,
  type ExtractedBlockDTO,
  type PageExtractRequestDTO,
  type PageOcrExtractionDTO,
  type PatchPageBlocksRequestDTO,
} from "@/types/ocr-extraction";

const ocrBlockTypeSchema = z.enum(OCR_BLOCK_TYPES);
const pageKindTypeSchema = z.enum(PAGE_KIND_TYPES);
const blockDecisionSchema = z.enum(["KEEP", "EXCLUDE", "REVIEW"]);
const decisionSourceSchema = z.enum([
  "GEOMETRIC",
  "CROSS_PAGE",
  "SEMANTIC_AI",
  "HUMAN",
  "CIRCUIT_BREAKER",
  "SHADOW_FALLBACK",
]);
const filterModeSchema = z.enum(["off", "shadow", "active"]);
const lightingProfileSchema = z.enum([
  "NORMAL",
  "SHADOW",
  "UNEVEN_LIGHT",
  "LOW_LIGHT",
  "OVER_EXPOSED",
]);

export const gutterDetectionResultSchema = z.object({
  is_double_page: z.boolean(),
  gutter_x_norm: z.number().min(0).max(1).nullable(),
  confidence: z.number().min(0).max(1),
  crossing_line_count: z.number().int().nonnegative(),
  split_recommended: z.boolean(),
  reason_vi: z.string(),
});

export const documentBoundaryResultSchema = z.object({
  image_width: z.number().int().positive(),
  image_height: z.number().int().positive(),
  boundary_quad_norm: z.array(z.array(z.number())).length(4),
  boundary_quad_px: z.array(z.array(z.number())).length(4),
  boundary_bbox_norm: z.array(z.number()).length(4),
  area_ratio: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  deskew_angle_deg: z.number(),
  auto_crop: z.boolean(),
  requires_crop_review: z.boolean(),
  clips_margin_text: z.boolean(),
  transform_matrix: z.array(z.array(z.number()).length(3)).length(3),
  inverse_transform_matrix: z.array(z.array(z.number()).length(3)).length(3),
  output_width: z.number().int().positive(),
  output_height: z.number().int().positive(),
  gutter: gutterDetectionResultSchema,
  lighting_profile: lightingProfileSchema,
  processing_ms: z.number().nonnegative(),
  reason_vi: z.string(),
});

export const extractedWordSchema = z.object({
  word_id: z.string(),
  source_word_index: z.number().int().nonnegative(),
  block_id: z.string(),
  reading_order: z.number().int().nonnegative(),
  line_index: z.number().int().nonnegative(),
  text: z.string(),
  normalized_text: z.string(),
  bbox: z.array(z.number()).length(4),
  confidence: z.number().min(0).max(1).nullable(),
});

export const blockAuditEventSchema = z.object({
  actor_id: z.string(),
  action: z.string(),
  previous_decision: blockDecisionSchema.nullable(),
  new_decision: blockDecisionSchema,
  reason: z.string().nullable(),
  timestamp: z.string(),
});

export const extractedBlockSchema = z.object({
  block_id: z.string(),
  raw_text: z.string(),
  display_text: z.string(),
  bbox: z.array(z.number()).length(4),
  reading_order: z.number().int().nonnegative(),
  column_index: z.number().int().nonnegative(),
  line_indices: z.array(z.number().int().nonnegative()),
  word_ids: z.array(z.string()),
  source_word_indices: z.array(z.number().int().nonnegative()),
  block_type: ocrBlockTypeSchema,
  decision: blockDecisionSchema,
  auto_decision: blockDecisionSchema,
  reason_vi: z.string(),
  reason_code: z.string(),
  decision_source: decisionSourceSchema,
  confidence: z.number().min(0).max(1),
  user_override: z.boolean(),
  edited_text: z.string().nullable(),
  cross_page_matches: z.array(z.number().int().positive()),
  in_canonical: z.boolean(),
  audit_trail: z.array(blockAuditEventSchema),
});

export const extractionStatsSchema = z.object({
  total_blocks: z.number().int().nonnegative(),
  keep_blocks: z.number().int().nonnegative(),
  exclude_blocks: z.number().int().nonnegative(),
  review_blocks: z.number().int().nonnegative(),
  total_chars: z.number().int().nonnegative(),
  kept_chars: z.number().int().nonnegative(),
  excluded_chars: z.number().int().nonnegative(),
  review_chars: z.number().int().nonnegative(),
  retention_ratio: z.number().min(0).max(1),
  circuit_breaker_triggered: z.boolean(),
  fast_path_ms: z.number().nonnegative(),
  cross_page_ms: z.number().nonnegative(),
  semantic_ai_ms: z.number().nonnegative(),
  total_ms: z.number().nonnegative(),
  semantic_ai_invoked: z.boolean(),
  semantic_ai_fallback_used: z.boolean(),
  semantic_ai_error_code: z.string().nullable(),
});

export const pageOcrExtractionSchema = z.object({
  extraction_id: z.string().nullable(),
  book_id: z.string().nullable(),
  book_page_id: z.string().nullable(),
  page_revision_id: z.string().nullable(),
  source_hash: z.string(),
  algorithm_version: z.string(),
  filter_mode: filterModeSchema,
  page_kind: pageKindTypeSchema,
  geometry_transform: documentBoundaryResultSchema.nullable(),
  blocks: z.array(extractedBlockSchema),
  canonical_text: z.string(),
  canonical_words: z.array(extractedWordSchema),
  stats: extractionStatsSchema,
  requires_review: z.boolean(),
  undo_available: z.boolean(),
  undo_depth: z.number().int().nonnegative(),
  persisted: z.boolean(),
  storage_degraded: z.boolean(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export async function analyzeOcrBlocks(
  payload: AnalyzeBlocksRequestDTO,
  signal?: AbortSignal,
): Promise<PageOcrExtractionDTO> {
  return requestApi(
    "/studio/ocr/analyze-blocks",
    pageOcrExtractionSchema,
    signal,
    {
      method: "POST",
      body: payload,
    },
  );
}

export async function extractPageOcrBlocks(
  pageId: string,
  payload: PageExtractRequestDTO = {},
  signal?: AbortSignal,
): Promise<PageOcrExtractionDTO> {
  return requestApi(
    `/studio/ocr/pages/${encodeURIComponent(pageId)}/extract`,
    pageOcrExtractionSchema,
    signal,
    {
      method: "POST",
      body: payload,
    },
  );
}

export async function getPageOcrExtraction(
  pageId: string,
  signal?: AbortSignal,
): Promise<PageOcrExtractionDTO> {
  return requestApi(
    `/studio/ocr/pages/${encodeURIComponent(pageId)}/extraction`,
    pageOcrExtractionSchema,
    signal,
    { bypassCache: true },
  );
}

export async function patchPageOcrBlocks(
  pageId: string,
  payload: PatchPageBlocksRequestDTO,
  signal?: AbortSignal,
): Promise<PageOcrExtractionDTO> {
  return requestApi(
    `/studio/ocr/pages/${encodeURIComponent(pageId)}/blocks`,
    pageOcrExtractionSchema,
    signal,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

/**
 * Pure helper computing canonical reading preview text in reading order.
 * Shadow/off modes preserve all non-illustration text; active mode keeps KEEP + REVIEW.
 */
export function computeCanonicalPreviewText(
  blocks: readonly ExtractedBlockDTO[],
  filterMode: PageOcrExtractionDTO["filter_mode"],
): string {
  return [...blocks]
    .sort((a, b) => a.reading_order - b.reading_order)
    .filter((block) => {
      if (block.block_type === "ILLUSTRATION") return false;
      if (filterMode === "shadow" || filterMode === "off") return true;
      return block.decision !== "EXCLUDE";
    })
    .map((block) =>
      (block.edited_text ?? block.display_text ?? block.raw_text)
        .normalize("NFC")
        .trim(),
    )
    .filter((text) => text.length > 0)
    .join("\n");
}
