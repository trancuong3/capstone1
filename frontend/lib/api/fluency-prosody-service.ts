/**
 * Feature #5: Fluency Prosody Coach — frontend API service & Zod v4 schemas.
 * Strictly `PARENT_PRIVATE`: uses authenticated `requestApi` with `bypassCache: true`.
 */
import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";

export const GradeBandVerdictSchema = z.enum([
  "EXCELLENT",
  "GOOD",
  "DEVELOPING",
  "NEEDS_PRACTICE",
]);
export type GradeBandVerdict = z.infer<typeof GradeBandVerdictSchema>;

export const PunctuationKindSchema = z.enum([
  "COMMA",
  "PERIOD",
  "QUESTION",
  "EXCLAMATION",
  "NONE",
]);
export type PunctuationKind = z.infer<typeof PunctuationKindSchema>;

export const BreathingCueSymbolSchema = z.enum(["•", "••", "↗", "✦"]);
export type BreathingCueSymbol = z.infer<typeof BreathingCueSymbolSchema>;

export const BreathingCueTypeSchema = z.enum([
  "COMMA_PAUSE",
  "PERIOD_PAUSE",
  "QUESTION_RISE",
  "EXCLAMATION_ENERGY",
]);
export type BreathingCueType = z.infer<typeof BreathingCueTypeSchema>;

export const ClauseBreakdownSchema = z.object({
  clause_index: z.number().int().nonnegative(),
  clause_text: z.string(),
  start_word_idx: z.number().int().nonnegative(),
  end_word_idx: z.number().int().nonnegative(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  terminal_punct: z.string().nullable(),
  punctuation_kind: PunctuationKindSchema,
  observed_pause_ms: z.number().nullable(),
  relative_pause_ratio: z.number().nullable(),
  expected_pause_ratio: z.number(),
  pause_score: z.number().min(0).max(100),
  terminal_f0_delta_semitones: z.number().nullable().optional().default(null),
  intonation_score: z.number().min(0).max(100).nullable(),
});
export type ClauseBreakdownDTO = z.infer<typeof ClauseBreakdownSchema>;

export const ProsodyAnalysisResponseSchema = z.object({
  child_id: z.string().min(1),
  session_id: z.string().min(1),
  visibility_scope: z.literal("PARENT_PRIVATE").default("PARENT_PRIVATE"),
  comma_pause_score: z.number().min(0).max(100),
  period_pause_score: z.number().min(0).max(100),
  intonation_contour_score: z.number().min(0).max(100),
  overall_prosody_score: z.number().min(0).max(100),
  grade_band_verdict: GradeBandVerdictSchema,
  coaching_tip_vi: z.string(),
  clauses: z.array(ClauseBreakdownSchema),
  median_inter_word_gap_ms: z.number().nonnegative(),
  noise_floor_rms: z.number().nonnegative(),
  audio_analyzed: z.boolean(),
  model_version: z.string(),
  persisted: z.boolean(),
});
export type ProsodyAnalysisResponse = z.infer<
  typeof ProsodyAnalysisResponseSchema
>;

export const BreathingCueTokenSchema = z.object({
  text: z.string(),
  punctuation: z.string().nullable(),
  cue_symbol: BreathingCueSymbolSchema.nullable(),
  cue_type: BreathingCueTypeSchema.nullable(),
  pause_beats: z.number().int().min(0).max(4),
});
export type BreathingCueTokenDTO = z.infer<typeof BreathingCueTokenSchema>;

export const AnnotateCuesResponseSchema = z.object({
  original_text: z.string(),
  annotated_text: z.string(),
  tokens: z.array(BreathingCueTokenSchema),
  cue_counts: z.record(z.string(), z.number().int().nonnegative()),
  cue_legend: z.record(z.string(), z.string()),
});
export type AnnotateCuesResponse = z.infer<typeof AnnotateCuesResponseSchema>;

export interface WordTiming {
  readonly word: string;
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface AnalyzeProsodyParams {
  readonly childId: string;
  readonly sessionId: string;
  readonly referenceText: string;
  readonly wordTimings?: readonly WordTiming[];
  readonly audioWavBase64?: string | null;
  readonly sampleRate?: number | null;
  readonly f0Frames?: readonly (number | null)[] | null;
  readonly rmsFrames?: readonly number[] | null;
  readonly hopMs?: number;
}

export async function analyzeProsody(
  params: AnalyzeProsodyParams,
  signal?: AbortSignal,
): Promise<ProsodyAnalysisResponse> {
  return requestApi(
    `/fluency/children/${encodeURIComponent(params.childId)}/sessions/${encodeURIComponent(params.sessionId)}/analyze-prosody`,
    ProsodyAnalysisResponseSchema,
    signal,
    {
      method: "POST",
      bypassCache: true,
      body: {
        reference_text: params.referenceText,
        word_timings: params.wordTimings ?? [],
        audio_wav_base64: params.audioWavBase64 ?? null,
        sample_rate: params.sampleRate ?? null,
        f0_frames: params.f0Frames ?? null,
        rms_frames: params.rmsFrames ?? null,
        hop_ms: params.hopMs ?? 20,
      },
    },
  );
}

export async function annotateCues(
  text: string,
  signal?: AbortSignal,
): Promise<AnnotateCuesResponse> {
  return requestApi(
    "/fluency/annotate-cues",
    AnnotateCuesResponseSchema,
    signal,
    {
      method: "POST",
      bypassCache: true,
      body: { text },
    },
  );
}

const DEFAULT_CUE_LEGEND: Record<string, string> = {
  "•": "Nghỉ hơi ngắn (dấu phẩy / chấm phẩy)",
  "••": "Nghỉ hơi dài (dấu chấm / ba chấm)",
  "↗": "Lên giọng nhẹ cuối câu (dấu chấm hỏi)",
  "✦": "Đọc vui tươi, nhấn giọng diễn cảm (dấu chấm than)",
};

function extractTrailingPunctuation(raw: string): string | null {
  const cleaned = raw.trim().replace(/["'”’)\]}»]+$/g, "");
  if (!cleaned) return null;
  if (cleaned.endsWith("...")) return "…";
  const last = cleaned[cleaned.length - 1];
  if (last && ",;.!?…،؛。！？".includes(last)) {
    return last;
  }
  return null;
}

/**
 * Zero-cost deterministic client-side mirror of `annotate_punctuation_breathing_cues`
 * so offline reading mode and instant UI previews work with 0ms latency.
 */
export function annotateBreathingCuesLocal(text: string): AnnotateCuesResponse {
  const original = (text ?? "").normalize("NFC").trim();
  const counts: Record<string, number> = {
    "•": 0,
    "••": 0,
    "↗": 0,
    "✦": 0,
  };
  if (!original) {
    return {
      original_text: "",
      annotated_text: "",
      tokens: [],
      cue_counts: counts,
      cue_legend: { ...DEFAULT_CUE_LEGEND },
    };
  }

  const normalized = original
    .replace(/\.{2,}/g, "…")
    .replace(/\s+([,;.!?…،؛。！？])/g, "$1");

  const tokens: BreathingCueTokenDTO[] = [];
  const parts: string[] = [];

  for (const rawTok of normalized.split(/\s+/)) {
    if (!rawTok) continue;
    const punct = extractTrailingPunctuation(rawTok);
    let cueSymbol: BreathingCueSymbol | null = null;
    let cueType: BreathingCueType | null = null;
    let pauseBeats = 0;

    if (punct === "," || punct === ";" || punct === "،" || punct === "؛") {
      cueSymbol = "•";
      cueType = "COMMA_PAUSE";
      pauseBeats = 1;
    } else if (punct === "?" || punct === "？") {
      cueSymbol = "↗";
      cueType = "QUESTION_RISE";
      pauseBeats = 2;
    } else if (punct === "!" || punct === "！") {
      cueSymbol = "✦";
      cueType = "EXCLAMATION_ENERGY";
      pauseBeats = 2;
    } else if (punct === "." || punct === "…" || punct === "。") {
      cueSymbol = "••";
      cueType = "PERIOD_PAUSE";
      pauseBeats = 2;
    }

    tokens.push({
      text: rawTok,
      punctuation: punct,
      cue_symbol: cueSymbol,
      cue_type: cueType,
      pause_beats: pauseBeats,
    });

    if (cueSymbol) {
      counts[cueSymbol] = (counts[cueSymbol] ?? 0) + 1;
      parts.push(`${rawTok} ${cueSymbol}`);
    } else {
      parts.push(rawTok);
    }
  }

  return {
    original_text: original,
    annotated_text: parts.join(" "),
    tokens,
    cue_counts: counts,
    cue_legend: { ...DEFAULT_CUE_LEGEND },
  };
}

/**
 * Derive word timings from punctuated text & session pace when raw audio frames
 * were not captured (e.g., browser-native Web Speech STT or sample check).
 */
export function buildSampleSessionWordTimings(
  referenceText: string,
  durationMinutes?: number | null,
): WordTiming[] {
  const words = referenceText
    .normalize("NFC")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];

  const wordDurMs =
    durationMinutes && durationMinutes > 0
      ? Math.max(
          160,
          Math.min(
            420,
            Math.round(
              (durationMinutes * 60_000) / Math.max(words.length * 1.4, 1),
            ),
          ),
        )
      : 230;

  let cursor = 0;
  return words.map((word) => {
    const start_ms = cursor;
    const end_ms = cursor + wordDurMs;
    const punct = extractTrailingPunctuation(word);
    const gap =
      punct && ".!?…".includes(punct)
        ? 250
        : punct && ",;".includes(punct)
          ? 145
          : 55;
    cursor = end_ms + gap;
    return { word, start_ms, end_ms };
  });
}
