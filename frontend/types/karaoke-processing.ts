import { z } from "zod";
import { karaokePreviewSchema, lyricsSchema } from "@/types/karaoke";
import {
  fingerprintSchema,
  processingDateSchema,
  processingErrorSchema,
  processingModeSchema,
  processingSourceSchema,
  processingStageSchema,
  processingStatusSchema,
  qualityFlagsSchema,
  retryPolicySchema,
} from "@/types/karaoke-processing-shared";
export * from "@/types/karaoke-processing-shared";

export const processingDraftRequestSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    draft_version_id: z.guid(),
  })
  .strict();
export const processingStartSchema = processingDraftRequestSchema.extend({
  idempotency_key: z.guid(),
  mode: processingModeSchema,
  source_kind: processingSourceSchema,
});
export const processingRetrySchema = processingDraftRequestSchema.extend({
  idempotency_key: z.guid(),
  acknowledge_possible_charge: z.boolean(),
});
export const processingCancelSchema = z
  .object({ draft_version_id: z.guid() })
  .strict();
export const processingReviewRequestSchema =
  processingDraftRequestSchema.extend({
    content_fingerprint: fingerprintSchema,
    confirmed_listened: z.boolean(),
    acknowledged_flag_ids: z
      .array(z.guid())
      .max(301)
      .refine((ids) => new Set(ids).size === ids.length),
  });
export const processingCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  supported_modes: z.array(processingModeSchema).max(2),
  unavailable_reason: z
    .enum(["DISABLED", "PROVIDER_NOT_CONFIGURED"])
    .nullable(),
  limits: z.object({
    max_audio_bytes: z.number().int().positive(),
    max_duration_ms: z.number().int().positive(),
    max_lyric_lines: z.number().int().positive(),
    max_lyric_characters: z.number().int().positive(),
  }),
  queue_warning_after_seconds: z.number().int().positive(),
});
export const processingJobSchema = z
  .object({
    id: z.guid(),
    song_id: z.guid(),
    draft_version_id: z.guid(),
    base_revision: z.number().int().positive(),
    mode: processingModeSchema,
    source_kind: processingSourceSchema,
    status: processingStatusSchema,
    stage: processingStageSchema,
    input_fingerprint: fingerprintSchema,
    created_at: processingDateSchema,
    updated_at: processingDateSchema,
    finished_at: processingDateSchema.nullable(),
    applied_at: processingDateSchema.nullable(),
    applied_revision: z.number().int().positive().nullable(),
    safe_error_code: processingErrorSchema.nullable(),
    retry_policy: retryPolicySchema,
    can_apply: z.boolean(),
    quality_flags: qualityFlagsSchema,
  })
  .refine(
    (job) => !job.can_apply || ["READY", "NEEDS_REVIEW"].includes(job.status),
    "Kết quả chưa thể áp dụng.",
  );
export const processingJobListSchema = z.object({
  items: z.array(processingJobSchema).max(50),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(50),
  offset: z.number().int().nonnegative(),
});
const mediaUrl = karaokePreviewSchema.shape.audio_url;
export const processingPreviewSchema = z
  .object({
    job_id: z.guid(),
    song_id: z.guid(),
    draft_version_id: z.guid(),
    base_revision: z.number().int().positive(),
    input_fingerprint: fingerprintSchema,
    title: z.string().max(200),
    author: z.string().max(200),
    duration_ms: z.number().int().min(1).max(300000),
    audio_url: mediaUrl,
    audio_url_expires_at: processingDateSchema,
    cover_url: mediaUrl.nullable(),
    reference_audio_url: mediaUrl.nullable(),
    reference_audio_url_expires_at: processingDateSchema.nullable(),
    lyrics: lyricsSchema.refine((lyrics) => lyrics.format_version === 2),
    quality_flags: qualityFlagsSchema,
  })
  .refine(
    (value) =>
      (value.reference_audio_url === null) ===
      (value.reference_audio_url_expires_at === null),
    "Nguồn đối chiếu chưa hợp lệ.",
  );
export const draftReferencePreviewSchema = z.object({
  song_id: z.guid(),
  draft_version_id: z.guid(),
  revision: z.number().int().positive(),
  content_fingerprint: fingerprintSchema,
  reference_audio_url: mediaUrl,
  reference_audio_url_expires_at: processingDateSchema,
});
export type ProcessingCapabilities = z.infer<
  typeof processingCapabilitiesSchema
>;
export type ProcessingJob = z.infer<typeof processingJobSchema>;
export type ProcessingPreview = z.infer<typeof processingPreviewSchema>;
export type DraftReferencePreview = z.infer<typeof draftReferencePreviewSchema>;
export type ProcessingStart = z.infer<typeof processingStartSchema>;
export type ProcessingRetry = z.infer<typeof processingRetrySchema>;
export type ProcessingDraftRequest = z.infer<
  typeof processingDraftRequestSchema
>;
export type ProcessingReviewRequest = z.infer<
  typeof processingReviewRequestSchema
>;
export type ProcessingSnapshot = Pick<
  ProcessingJob,
  "song_id" | "draft_version_id" | "base_revision" | "input_fingerprint"
>;
