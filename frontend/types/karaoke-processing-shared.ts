import { z } from "zod";

// Shared admin-only pieces avoid a runtime cycle with the lyrics/preview DTOs.
export const processingStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "READY",
  "NEEDS_REVIEW",
  "FAILED",
  "CANCELLED",
  "STALE",
  "APPLIED",
]);
export const processingStageSchema = z.enum([
  "QUEUED",
  "VALIDATING_INPUT",
  "PREPARING_AUDIO",
  "ALIGNING_LYRICS",
  "VALIDATING_RESULT",
  "COMPLETE",
]);
export const processingModeSchema = z.enum([
  "VOCAL_TRACK",
  "INSTRUMENTAL_WITH_REFERENCE",
]);
export const processingSourceSchema = z.enum([
  "DRAFT_AUDIO",
  "ORIGINAL_RECORDING",
]);
export const retryPolicySchema = z.enum([
  "NONE",
  "SAFE_RETRY",
  "NEEDS_INPUT_CHANGE",
  "EXPLICIT_COST_ACK",
]);
export const qualityCodeSchema = z.enum([
  "LOW_ALIGNMENT_SUPPORT",
  "LYRIC_MISMATCH",
  "AMBIGUOUS_REPEAT",
  "UNALIGNED_SYLLABLES",
  "HELD_NOTE_UNCERTAIN",
  "BACKGROUND_ARTIFACT",
]);
export const processingErrorSchema = z.enum([
  "NO_USABLE_VOCALS",
  "REFERENCE_TIMELINE_MISMATCH",
  "LYRICS_NOT_MATCHED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_OUTCOME_UNKNOWN",
  "INVALID_PROVIDER_RESULT",
  "MEDIA_UNAVAILABLE",
  "ACTOR_UNAVAILABLE",
  "PROCESSING_CONFIGURATION_INVALID",
]);
export const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const processingDateSchema = z.iso.datetime({ offset: true });
export const qualityFlagSchema = z
  .object({
    id: z.guid(),
    codes: z.array(qualityCodeSchema).min(1).max(6),
    line_id: z.guid().nullable(),
    syllable_ids: z.array(z.guid()).max(10),
    affected_syllable_count: z.number().int().min(0).max(10000),
    message_key: qualityCodeSchema,
  })
  .superRefine((flag, ctx) => {
    if (
      !flag.codes.includes(flag.message_key) ||
      new Set(flag.codes).size !== flag.codes.length ||
      new Set(flag.syllable_ids).size !== flag.syllable_ids.length
    )
      ctx.addIssue({ code: "custom", message: "Cảnh báo xử lý chưa hợp lệ." });
  });
export const qualityFlagsSchema = z
  .array(qualityFlagSchema)
  .max(301)
  .refine(
    (flags) => new Set(flags.map((flag) => flag.id)).size === flags.length,
    "ID cảnh báo bị trùng.",
  );
export const processingSummarySchema = z.object({
  job_id: z.guid(),
  draft_version_id: z.guid(),
  status: processingStatusSchema,
  stage: processingStageSchema,
  safe_error_code: processingErrorSchema.nullable(),
  retry_policy: retryPolicySchema,
  updated_at: processingDateSchema,
});
export const processingReviewSchema = z.object({
  required: z.boolean(),
  current_content_fingerprint: fingerprintSchema.nullable(),
  reviewed: z.boolean(),
  reviewed_at: processingDateSchema.nullable(),
  quality_flags: qualityFlagsSchema,
});
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;
export type ProcessingMode = z.infer<typeof processingModeSchema>;
export type QualityFlag = z.infer<typeof qualityFlagSchema>;
export type ProcessingSummary = z.infer<typeof processingSummarySchema>;
