import { z } from "zod";

export const assetRoleSchema = z.enum([
  "COVER",
  "PAGE_ILLUSTRATION",
  "THUMBNAIL",
]);

export const assetSourceTypeSchema = z.enum([
  "USER_UPLOAD",
  "ORIGINAL_CROP",
  "ENHANCED_CROP",
  "AI_GENERATED",
  "METADATA_RENDER",
]);

export const assetModerationStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "STALE",
]);

export const coverPrioritySourceSchema = z.enum([
  "USER_UPLOAD",
  "AI_GENERATED",
  "METADATA_RENDER",
]);

export const readingDisplayModeSchema = z.enum([
  "ILLUSTRATED",
  "TEXT",
  "ORIGINAL",
]);

export const metadataCoverFallbackSchema = z.object({
  palette_id: z.string(),
  primary_color: z.string(),
  secondary_color: z.string(),
  accent_color: z.string(),
  motif: z.string(),
  title: z.string(),
  author: z.string().nullable().optional(),
  grade_label: z.string(),
  source_type: z.literal("METADATA_RENDER"),
});

export const bookPresentationAssetSchema = z.object({
  id: z.string().uuid(),
  book_id: z.string().uuid(),
  book_page_id: z.string().uuid().nullable().optional(),
  source_revision_id: z.string().uuid().nullable().optional(),
  asset_role: assetRoleSchema,
  source_type: assetSourceTypeSchema,
  media_url: z.string(),
  mime_type: z.string(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  size_bytes: z.number().int().nullable().optional(),
  asset_hash: z.string(),
  asset_version: z.number().int(),
  is_active: z.boolean(),
  text_free_verified: z.boolean(),
  moderation_status: assetModerationStatusSchema,
  provider_name: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  job_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
  updated_at: z.string(),
});

export const styleBibleCharacterSchema = z.object({
  name: z.string(),
  description: z.string(),
  visual_traits: z.array(z.string()).default([]),
});

export const styleBibleContentSchema = z.object({
  genre: z.string(),
  age_group: z.string(),
  color_palette: z.array(z.string()).default([]),
  art_style: z.string(),
  characters: z.array(styleBibleCharacterSchema).default([]),
  settings: z.array(z.string()).default([]),
  invariants: z.array(z.string()).default([]),
  mood: z.string().default(""),
  prompt_prefix: z.string().default(""),
});

export const bookStyleBibleSchema = z.object({
  book_id: z.string().uuid(),
  context_hash: z.string(),
  cache_hit: z.boolean().default(false),
  bible: styleBibleContentSchema,
  provider_name: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  updated_at: z.string(),
});

export const bookCoverGenerateResponseSchema = z.object({
  status: z.enum([
    "QUEUED",
    "SUCCEEDED",
    "BLOCKED_NO_IMAGE_PROVIDER",
    "WAITING_FOR_QUOTA",
    "SUPERSEDED_BY_USER_UPLOAD",
  ]),
  job_id: z.string().uuid().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  message_vi: z.string(),
  cover: bookPresentationAssetSchema.nullable().optional(),
  metadata_fallback: metadataCoverFallbackSchema,
  style_bible: bookStyleBibleSchema.nullable().optional(),
  honest_ai_generated: z.boolean(),
});

export const bookCoverDeleteResponseSchema = z.object({
  book_id: z.string().uuid(),
  removed_count: z.number().int(),
  metadata_fallback: metadataCoverFallbackSchema,
  message_vi: z.string(),
});

export const pageIllustrationExtractResponseSchema = z.object({
  status: z.enum([
    "EXTRACTED_VERIFIED",
    "REJECTED_CONTAINS_TEXT",
    "NO_CLEAN_ARTWORK",
    "FAILED",
  ]),
  asset: bookPresentationAssetSchema.nullable().optional(),
  text_free_verified: z.boolean(),
  text_density_score: z.number(),
  ocr_overlap_score: z.number(),
  artwork_area_ratio: z.number(),
  recommended_reading_mode: readingDisplayModeSchema,
  message_vi: z.string(),
});

export const pageIllustrationGenerateResponseSchema = z.object({
  status: z.enum([
    "QUEUED",
    "SUCCEEDED",
    "BLOCKED_NO_IMAGE_PROVIDER",
    "WAITING_FOR_QUOTA",
    "REJECTED_CONTAINS_TEXT",
  ]),
  job_id: z.string().uuid().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  asset: bookPresentationAssetSchema.nullable().optional(),
  recommended_reading_mode: readingDisplayModeSchema,
  message_vi: z.string(),
});

export const bookAssetsSummarySchema = z.object({
  book_id: z.string().uuid(),
  title: z.string(),
  author: z.string().nullable().optional(),
  min_grade: z.number().int(),
  max_grade: z.number().int(),
  visibility_scope: z.string(),
  active_cover: bookPresentationAssetSchema.nullable().optional(),
  effective_cover_source: coverPrioritySourceSchema,
  metadata_fallback: metadataCoverFallbackSchema,
  style_bible: bookStyleBibleSchema.nullable().optional(),
  page_illustrations: z.array(bookPresentationAssetSchema).default([]),
  ai_image_provider_available: z.boolean().default(false),
  ai_image_provider_name: z.string().nullable().optional(),
  ai_image_provider_message_vi: z.string(),
  v2_storage_degraded: z.boolean().default(false),
});

export type AssetRole = z.infer<typeof assetRoleSchema>;
export type AssetSourceType = z.infer<typeof assetSourceTypeSchema>;
export type AssetModerationStatus = z.infer<typeof assetModerationStatusSchema>;
export type CoverPrioritySource = z.infer<typeof coverPrioritySourceSchema>;
export type ReadingDisplayMode = z.infer<typeof readingDisplayModeSchema>;
export type MetadataCoverFallbackDTO = z.infer<
  typeof metadataCoverFallbackSchema
>;
export type BookPresentationAssetDTO = z.infer<
  typeof bookPresentationAssetSchema
>;
export type StyleBibleCharacterDTO = z.infer<typeof styleBibleCharacterSchema>;
export type StyleBibleContentDTO = z.infer<typeof styleBibleContentSchema>;
export type BookStyleBibleDTO = z.infer<typeof bookStyleBibleSchema>;
export type BookCoverGenerateResponseDTO = z.infer<
  typeof bookCoverGenerateResponseSchema
>;
export type BookCoverDeleteResponseDTO = z.infer<
  typeof bookCoverDeleteResponseSchema
>;
export type PageIllustrationExtractResponseDTO = z.infer<
  typeof pageIllustrationExtractResponseSchema
>;
export type PageIllustrationGenerateResponseDTO = z.infer<
  typeof pageIllustrationGenerateResponseSchema
>;
export type BookAssetsSummaryDTO = z.infer<typeof bookAssetsSummarySchema>;

export interface CoverCropRect {
  readonly crop_x: number;
  readonly crop_y: number;
  readonly crop_w: number;
  readonly crop_h: number;
}

export type CoverRotationDegrees = 0 | 90 | 180 | 270;
