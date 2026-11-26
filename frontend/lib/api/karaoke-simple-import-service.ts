import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";
import {
  adminKaraokeDetailSchema,
  type AdminKaraokeDetail,
  type KaraokeLyrics,
} from "@/types/karaoke";
import {
  processingErrorSchema,
  processingSourceSchema,
  processingStageSchema,
  processingStatusSchema,
  qualityFlagsSchema,
  retryPolicySchema,
  type ProcessingMode,
} from "@/types/karaoke-processing";

export type SimpleProcessingSourceKind = z.infer<typeof processingSourceSchema>;

export const simpleAudioTypeSchema = z.enum([
  "VOCAL_FULL",
  "INSTRUMENTAL_ONLY",
  "DUAL_TRACK",
  "UNKNOWN",
]);

export const simpleLyricsSourceSchema = z.enum([
  "EMBEDDED_SYNCED",
  "EMBEDDED_UNSYNCED",
  "ADMIN_TEXT",
  "GROQ_WHISPER",
  "NONE",
]);

export const simplePipelineLifecycleStateSchema = z.enum([
  "UPLOADED",
  "QUEUED",
  "SEPARATING_AUDIO",
  "TRANSCRIBING_LYRICS",
  "ALIGNING_LYRICS",
  "ANALYZING_RHYTHM",
  "ANALYZING_MELODY",
  "READY_FOR_REVIEW",
  "NEEDS_REVIEW",
  "FAILED",
]);

export const flaggedLyricLineSchema = z.object({
  line_id: z.guid(),
  line_index: z.number().int().nonnegative(),
  text: z.string(),
  flag: z.enum(["NEEDS_REVIEW", "NEEDS_TIMING_CHECK"]),
  reason: z.string(),
  avg_logprob: z.number().nullable().optional(),
  no_speech_prob: z.number().nullable().optional(),
});

export const simpleImportResultSchema = z.object({
  song_id: z.guid(),
  version_id: z.guid(),
  revision: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  duration_ms: z.number().int().positive(),
  has_cover: z.boolean(),
  audio_type: simpleAudioTypeSchema,
  bpm: z.number().nullable().optional(),
  lyrics_source: simpleLyricsSourceSchema,
  lyrics_line_count: z.number().int().nonnegative(),
  flagged_lines: z.array(flaggedLyricLineSchema),
  requires_lyrics_input: z.boolean(),
  guidance_vi: z.string(),
  ready_to_publish: z.boolean(),
  missing_checks: z.array(z.string()),
  lifecycle_state: simplePipelineLifecycleStateSchema
    .optional()
    .default("UPLOADED"),
  worker_online: z.boolean().optional().default(false),
  processing_queued: z.boolean().optional().default(false),
  processing_job_id: z.guid().nullable().optional().default(null),
  processing_notice: z.string().nullable().optional().default(null),
  song: adminKaraokeDetailSchema,
});

export const simpleProcessingStatusSchema = z.object({
  song_id: z.guid(),
  draft_version_id: z.guid().nullable(),
  revision: z.number().int().positive(),
  lifecycle_state: simplePipelineLifecycleStateSchema,
  worker_online: z.boolean(),
  processing_enabled: z.boolean(),
  processing_configured: z.boolean(),
  job_id: z.guid().nullable().optional().default(null),
  job_status: processingStatusSchema.nullable().optional().default(null),
  job_stage: processingStageSchema.nullable().optional().default(null),
  can_apply: z.boolean(),
  review_required: z.boolean(),
  reviewed: z.boolean(),
  has_beat_grid: z.boolean(),
  has_pitch_contour: z.boolean(),
  bpm: z.number().nullable().optional().default(null),
  safe_error_code: processingErrorSchema.nullable().optional().default(null),
  retry_policy: retryPolicySchema.nullable().optional().default(null),
  quality_flags: qualityFlagsSchema,
  guidance_vi: z.string(),
  song: adminKaraokeDetailSchema,
});

export type SimpleAudioType = z.infer<typeof simpleAudioTypeSchema>;
export type SimpleLyricsSource = z.infer<typeof simpleLyricsSourceSchema>;
export type SimplePipelineLifecycleState = z.infer<
  typeof simplePipelineLifecycleStateSchema
>;
export type FlaggedLyricLine = z.infer<typeof flaggedLyricLineSchema>;
export type SimpleImportResult = z.infer<typeof simpleImportResultSchema>;
export type SimpleProcessingStatus = z.infer<
  typeof simpleProcessingStatusSchema
>;

export interface SimpleImportInput {
  audio: File;
  title?: string;
  author?: string;
  min_grade?: number;
  max_grade?: number;
  lyrics_text?: string;
  audio_type?: SimpleAudioType;
  bpm?: number | null;
  auto_transcribe?: boolean;
  enable_background_processing?: boolean;
  source_note?: string;
  usage_note?: string;
  rights_confirmed?: boolean;
  child_safe_confirmed?: boolean;
}

export interface SimpleProcessingStartInput {
  expected_revision: number;
  draft_version_id: string;
  idempotency_key?: string;
  mode?: ProcessingMode;
  source_kind?: SimpleProcessingSourceKind;
  audio_type?: SimpleAudioType;
  bpm?: number | null;
  lyrics?: KaraokeLyrics;
}

export interface SimpleProcessingApplyInput {
  expected_revision: number;
  draft_version_id: string;
  job_id: string;
  audio_type?: SimpleAudioType;
  bpm?: number | null;
}

export interface SimplePublishInput {
  expected_revision: number;
  draft_version_id: string;
  rights_confirmed: boolean;
  child_safe_confirmed: boolean;
  title?: string;
  author?: string;
  min_grade?: number;
  max_grade?: number;
  source_note?: string;
  usage_note?: string;
  lyrics?: KaraokeLyrics;
}

const SIMPLE_ROOT = "/karaoke/admin/songs";

export function createKaraokeSimpleImportService() {
  return {
    simpleImport(
      input: SimpleImportInput,
      signal?: AbortSignal,
    ): Promise<SimpleImportResult> {
      const form = new FormData();
      form.set("audio", input.audio);
      if (input.title !== undefined && input.title.trim()) {
        form.set("title", input.title.trim());
      }
      if (input.author !== undefined && input.author.trim()) {
        form.set("author", input.author.trim());
      }
      if (input.min_grade !== undefined) {
        form.set("min_grade", String(input.min_grade));
      }
      if (input.max_grade !== undefined) {
        form.set("max_grade", String(input.max_grade));
      }
      if (input.lyrics_text !== undefined && input.lyrics_text.trim()) {
        form.set("lyrics_text", input.lyrics_text);
      }
      if (input.audio_type !== undefined) {
        form.set("audio_type", input.audio_type);
      }
      if (input.bpm !== undefined && input.bpm !== null) {
        form.set("bpm", String(input.bpm));
      }
      form.set("auto_transcribe", String(input.auto_transcribe ?? true));
      if (input.enable_background_processing !== undefined) {
        form.set(
          "enable_background_processing",
          String(input.enable_background_processing),
        );
      }
      if (input.source_note !== undefined && input.source_note.trim()) {
        form.set("source_note", input.source_note.trim());
      }
      if (input.usage_note !== undefined && input.usage_note.trim()) {
        form.set("usage_note", input.usage_note.trim());
      }
      form.set("rights_confirmed", String(input.rights_confirmed ?? false));
      form.set(
        "child_safe_confirmed",
        String(input.child_safe_confirmed ?? false),
      );
      return requestApi(
        `${SIMPLE_ROOT}/simple-import`,
        simpleImportResultSchema,
        signal,
        { method: "POST", body: form },
      );
    },
    startSimpleProcessing(
      songId: string,
      input: SimpleProcessingStartInput,
      signal?: AbortSignal,
    ): Promise<SimpleProcessingStatus> {
      const validId = z.guid().parse(songId);
      const validDraftId = z.guid().parse(input.draft_version_id);
      return requestApi(
        `${SIMPLE_ROOT}/${validId}/simple-processing`,
        simpleProcessingStatusSchema.refine(
          (value) => value.song_id === validId,
        ),
        signal,
        {
          method: "POST",
          body: {
            ...input,
            draft_version_id: validDraftId,
          },
        },
      );
    },
    getSimpleProcessingStatus(
      songId: string,
      signal?: AbortSignal,
    ): Promise<SimpleProcessingStatus> {
      const validId = z.guid().parse(songId);
      return requestApi(
        `${SIMPLE_ROOT}/${validId}/simple-processing`,
        simpleProcessingStatusSchema.refine(
          (value) => value.song_id === validId,
        ),
        signal,
      );
    },
    applySimpleProcessing(
      songId: string,
      input: SimpleProcessingApplyInput,
      signal?: AbortSignal,
    ): Promise<SimpleProcessingStatus> {
      const validId = z.guid().parse(songId);
      const validDraftId = z.guid().parse(input.draft_version_id);
      const validJobId = z.guid().parse(input.job_id);
      return requestApi(
        `${SIMPLE_ROOT}/${validId}/simple-processing/apply`,
        simpleProcessingStatusSchema.refine(
          (value) => value.song_id === validId,
        ),
        signal,
        {
          method: "POST",
          body: {
            ...input,
            draft_version_id: validDraftId,
            job_id: validJobId,
          },
        },
      );
    },
    simplePublish(
      songId: string,
      input: SimplePublishInput,
      signal?: AbortSignal,
    ): Promise<AdminKaraokeDetail> {
      const validId = z.guid().parse(songId);
      const validDraftId = z.guid().parse(input.draft_version_id);
      return requestApi(
        `${SIMPLE_ROOT}/${validId}/simple-publish`,
        adminKaraokeDetailSchema.refine((value) => value.song_id === validId),
        signal,
        {
          method: "POST",
          body: {
            ...input,
            draft_version_id: validDraftId,
          },
        },
      );
    },
  };
}

export type KaraokeSimpleImportService = ReturnType<
  typeof createKaraokeSimpleImportService
>;
