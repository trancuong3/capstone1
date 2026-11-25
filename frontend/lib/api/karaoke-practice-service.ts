import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";
import type {
  KaraokePracticeMode,
  MusicalEvaluationResult,
  MusicalProfileData,
} from "@/lib/karaoke/musical-scoring";

const practiceModeSchema = z.enum([
  "FULL_SONG",
  "SEGMENT",
  "RHYTHM_TAP",
  "LINE_PRACTICE",
]);

const scoringModeSchema = z.enum([
  "FULL_MUSICAL",
  "RHYTHM_AND_LYRICS",
  "LYRICS_ONLY",
  "INSUFFICIENT_EVIDENCE",
]);

export const karaokePracticeSessionSchema = z.object({
  id: z.guid(),
  child_id: z.guid(),
  song_id: z.guid(),
  song_version_id: z.guid().nullable().optional(),
  practice_mode: practiceModeSchema,
  scoring_mode: scoringModeSchema,
  playback_rate: z.number(),
  headphone_mode: z.boolean(),
  overall_score: z.number().int().min(0).max(100).nullable(),
  rhythm_score: z.number().int().min(0).max(100).nullable(),
  pitch_score: z.number().int().min(0).max(100).nullable(),
  lyrics_score: z.number().int().min(0).max(100).nullable(),
  fluency_score: z.number().int().min(0).max(100).nullable(),
  stars: z.number().int().min(0).max(3),
  segment_start_ms: z.number().int().nullable(),
  segment_end_ms: z.number().int().nullable(),
  report_payload: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
  persisted: z.boolean().optional().default(true),
  storage_notice: z.string().nullable().optional(),
});

export const karaokePracticeHistorySchema = z.object({
  child_id: z.guid(),
  song_id: z.guid().nullable().optional(),
  best_full_song_score: z.number().int().min(0).max(100).nullable(),
  best_full_song_stars: z.number().int().min(0).max(3),
  total_sessions: z.number().int().nonnegative(),
  items: z.array(karaokePracticeSessionSchema),
  storage_ready: z.boolean().optional().default(true),
});

export const musicalProfileResponseSchema = z.object({
  song_id: z.guid(),
  song_version_id: z.guid(),
  bpm: z.number().nullable(),
  audio_type: z.enum([
    "VOCAL_FULL",
    "INSTRUMENTAL_ONLY",
    "DUAL_TRACK",
    "UNKNOWN",
  ]),
  has_pitch_contour: z.boolean(),
  has_beat_grid: z.boolean(),
  source_method: z.enum([
    "ID3_LRC",
    "AUDIO_DSP",
    "WHISPER_DRAFT",
    "MANUAL_TAP",
    "LYRICS_TIMING",
  ]),
  beat_grid_ms: z.array(z.number().int().nonnegative()),
  pitch_contour: z.array(
    z.object({
      time_ms: z.number().int().nonnegative(),
      hz: z.number().positive(),
      midi: z.number().nullable().optional(),
    }),
  ),
  phrase_windows: z
    .array(z.object({ start_ms: z.number().int(), end_ms: z.number().int() }))
    .optional()
    .default([]),
  updated_at: z.string().nullable().optional(),
});

export type KaraokePracticeSessionDTO = z.infer<
  typeof karaokePracticeSessionSchema
>;
export type KaraokePracticeHistoryDTO = z.infer<
  typeof karaokePracticeHistorySchema
>;

export interface SavePracticeSessionPayload {
  childId: string;
  songId: string;
  songVersionId?: string | null;
  practiceMode: KaraokePracticeMode;
  playbackRate: number;
  headphoneMode: boolean;
  segmentStartMs?: number | null;
  segmentEndMs?: number | null;
  evaluation: MusicalEvaluationResult;
}

/**
 * Compact Musical Karaoke practice API adapter.
 * Never transmits raw child audio — only numeric scores & compact segment summaries.
 */
export function createKaraokePracticeService() {
  return {
    async savePracticeSession(
      payload: SavePracticeSessionPayload,
      signal?: AbortSignal,
    ): Promise<KaraokePracticeSessionDTO> {
      z.guid().parse(payload.childId);
      z.guid().parse(payload.songId);
      if (payload.songVersionId) z.guid().parse(payload.songVersionId);

      const ev = payload.evaluation;
      const isInsufficient = ev.scoringMode === "INSUFFICIENT_EVIDENCE";

      const body = {
        child_id: payload.childId,
        song_id: payload.songId,
        song_version_id: payload.songVersionId ?? null,
        practice_mode: payload.practiceMode,
        scoring_mode: ev.scoringMode,
        playback_rate: payload.playbackRate,
        headphone_mode: payload.headphoneMode,
        overall_score: isInsufficient ? null : ev.overallScore,
        rhythm_score: isInsufficient ? null : ev.rhythmScore,
        pitch_score: isInsufficient ? null : ev.pitchScore,
        lyrics_score: isInsufficient ? null : ev.lyricsScore,
        fluency_score: isInsufficient ? null : ev.fluencyScore,
        stars: isInsufficient ? 0 : ev.stars,
        segment_start_ms: payload.segmentStartMs ?? null,
        segment_end_ms: payload.segmentEndMs ?? null,
        report_payload: {
          pitch_basis: ev.pitchBasis,
          gate_reason: ev.gateReason,
          speaker_bleed_suspected: ev.speakerBleedSuspected,
          active_vocal_coverage: ev.activeVocalCoverage,
          mean_cents_error: ev.meanCentsError,
          mean_signed_timing_offset_ms: ev.meanSignedTimingOffsetMs,
          segments: ev.segments.slice(0, 60).map((seg) => ({
            line_index: seg.lineIndex,
            line_id: seg.lineId,
            start_ms: seg.startMs,
            end_ms: seg.endMs,
            text: seg.text.slice(0, 200),
            rhythm_score: seg.rhythmScore,
            pitch_score: seg.pitchScore,
            lyrics_score: seg.lyricsScore,
            status: seg.status,
            tip_vi: seg.tipVi.slice(0, 200),
          })),
        },
      };

      return requestApi(
        "/karaoke/practice-sessions",
        karaokePracticeSessionSchema,
        signal,
        { method: "POST", body },
      );
    },

    listPracticeSessions(
      childId: string,
      songId?: string,
      limit = 10,
      signal?: AbortSignal,
    ): Promise<KaraokePracticeHistoryDTO> {
      z.guid().parse(childId);
      if (songId) z.guid().parse(songId);
      return requestApi(
        `/karaoke/practice-sessions${apiQuery({
          child_id: childId,
          song_id: songId,
          limit,
        })}`,
        karaokePracticeHistorySchema,
        signal,
      );
    },

    async getMusicalProfile(
      songId: string,
      signal?: AbortSignal,
    ): Promise<MusicalProfileData> {
      z.guid().parse(songId);
      const dto = await requestApi(
        `/karaoke/songs/${songId}/musical-profile`,
        musicalProfileResponseSchema,
        signal,
      );
      return {
        songId: dto.song_id,
        songVersionId: dto.song_version_id,
        bpm: dto.bpm,
        audioType: dto.audio_type,
        hasPitchContour: dto.has_pitch_contour,
        hasBeatGrid: dto.has_beat_grid,
        sourceMethod: dto.source_method,
        beatGridMs: dto.beat_grid_ms,
        pitchContour: dto.pitch_contour.map((pt) => ({
          timeMs: pt.time_ms,
          hz: pt.hz,
          midi: pt.midi ?? undefined,
        })),
      };
    },
  };
}

export type KaraokePracticeService = ReturnType<
  typeof createKaraokePracticeService
>;
