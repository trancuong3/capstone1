/**
 * Musical Karaoke Practice Modes, Beat Grid Derivation & Rhythm Tap Tracker.
 *
 * Supports 4 child-friendly modes:
 *   - FULL_SONG     (Hát cả bài)
 *   - SEGMENT       (Luyện đoạn khó — loops [startMs, endMs] at 0.85x, NEVER overwrites full-song best!)
 *   - LINE_PRACTICE (Tập từng câu)
 *   - RHYTHM_TAP    (Gõ nhịp theo bài hát — tap button/Spacebar on beats even without mic)
 */

import { translateRuntime } from "@/lib/i18n/runtime";
import type { KaraokeLine, KaraokeLyrics } from "@/types/karaoke";
import type { LyricTimeSpan } from "./musical-dsp";
import {
  expectedOnsetsForLine,
  type KaraokePracticeMode,
  type MusicalEvaluationResult,
  type MusicalProfileData,
  type MusicalSegmentReport,
} from "./musical-scoring";

export interface PracticeModeMeta {
  mode: KaraokePracticeMode;
  labelVi: string;
  shortLabelVi: string;
  descriptionVi: string;
  requiresMic: boolean;
  updatesBestFullSong: boolean;
}

export const PRACTICE_MODES: readonly PracticeModeMeta[] = [
  {
    mode: "FULL_SONG",
    get labelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.FULL_SONG.label",
      );
    },
    get shortLabelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.FULL_SONG.shortLabel",
      );
    },
    get descriptionVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.FULL_SONG.description",
      );
    },
    requiresMic: true,
    updatesBestFullSong: true,
  },
  {
    mode: "SEGMENT",
    get labelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.SEGMENT.label",
      );
    },
    get shortLabelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.SEGMENT.shortLabel",
      );
    },
    get descriptionVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.SEGMENT.description",
      );
    },
    requiresMic: true,
    updatesBestFullSong: false,
  },
  {
    mode: "LINE_PRACTICE",
    get labelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.LINE_PRACTICE.label",
      );
    },
    get shortLabelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.LINE_PRACTICE.shortLabel",
      );
    },
    get descriptionVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.LINE_PRACTICE.description",
      );
    },
    requiresMic: true,
    updatesBestFullSong: false,
  },
  {
    mode: "RHYTHM_TAP",
    get labelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.RHYTHM_TAP.label",
      );
    },
    get shortLabelVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.RHYTHM_TAP.shortLabel",
      );
    },
    get descriptionVi() {
      return translateRuntime(
        "entertainment.karaoke.stage.practiceModes.RHYTHM_TAP.description",
      );
    },
    requiresMic: false,
    updatesBestFullSong: false,
  },
] as const;

export const SEGMENT_PRACTICE_DEFAULT_RATE = 0.85;
export const ALLOWED_PLAYBACK_RATES = [0.75, 0.85, 1] as const;

export interface SegmentPracticeSelection {
  lineIndex: number;
  lineId: string;
  startMs: number;
  endMs: number;
  text: string;
  playbackRate: number;
  loop: boolean;
}

export function buildSegmentSelection(
  segment: Pick<
    MusicalSegmentReport,
    "lineIndex" | "lineId" | "startMs" | "endMs" | "text"
  >,
  options: { playbackRate?: number; loop?: boolean } = {},
): SegmentPracticeSelection {
  return {
    lineIndex: segment.lineIndex,
    lineId: segment.lineId,
    startMs: Math.max(0, Math.round(segment.startMs)),
    endMs: Math.max(
      Math.round(segment.startMs) + 250,
      Math.round(segment.endMs),
    ),
    text: segment.text,
    playbackRate: options.playbackRate ?? SEGMENT_PRACTICE_DEFAULT_RATE,
    loop: options.loop ?? true,
  };
}

export function buildSegmentSelectionFromLine(
  line: KaraokeLine,
  lineIndex: number,
  options: { playbackRate?: number; loop?: boolean } = {},
): SegmentPracticeSelection | null {
  if (
    line.start_ms === null ||
    line.end_ms === null ||
    line.end_ms <= line.start_ms
  ) {
    return null;
  }
  return buildSegmentSelection(
    {
      lineIndex,
      lineId: line.id,
      startMs: line.start_ms,
      endMs: line.end_ms,
      text: line.text,
    },
    options,
  );
}

/**
 * Extract lyric time spans for DSP active-vs-gap vocal coverage and bleed detection.
 */
export function extractLyricSpans(
  lyrics: KaraokeLyrics,
  range?: LyricTimeSpan | null,
): LyricTimeSpan[] {
  const spans: LyricTimeSpan[] = [];
  for (const line of lyrics.lines) {
    if (
      line.start_ms === null ||
      line.end_ms === null ||
      line.end_ms <= line.start_ms
    ) {
      continue;
    }
    if (
      range &&
      (line.end_ms <= range.startMs || line.start_ms >= range.endMs)
    ) {
      continue;
    }
    spans.push({ startMs: line.start_ms, endMs: line.end_ms });
  }
  return spans;
}

/**
 * Deterministically derive a beat grid and estimated BPM from published lyrics
 * when no precomputed musical profile exists on the server.
 */
export function deriveBeatGridFromLyrics(lyrics: KaraokeLyrics): {
  beatGridMs: number[];
  bpm: number | null;
} {
  const rawBeats: number[] = [];
  for (const line of lyrics.lines) {
    rawBeats.push(...expectedOnsetsForLine(line));
  }
  const unique = Array.from(new Set(rawBeats)).sort((a, b) => a - b);
  if (unique.length < 2) {
    return { beatGridMs: unique, bpm: null };
  }

  const intervals: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    const dt = unique[i] - unique[i - 1];
    if (dt >= 180 && dt <= 1600) intervals.push(dt);
  }
  if (!intervals.length) {
    return { beatGridMs: unique, bpm: 100 };
  }
  intervals.sort((a, b) => a - b);
  const medianIoi = intervals[Math.floor(intervals.length / 2)];
  let bpm = 60_000 / medianIoi;
  // Normalize into comfortable children's song tempo range [72..144 BPM].
  while (bpm < 72) bpm *= 2;
  while (bpm > 144) bpm /= 2;
  return {
    beatGridMs: unique,
    bpm: Math.round(bpm * 10) / 10,
  };
}

/** Merge a musical profile with deterministic lyric-derived fallback beat grid. */
export function resolveMusicalProfile(
  lyrics: KaraokeLyrics,
  remote?: MusicalProfileData | null,
): MusicalProfileData {
  const derived = deriveBeatGridFromLyrics(lyrics);
  if (!remote) {
    return {
      bpm: derived.bpm,
      audioType: "UNKNOWN",
      hasPitchContour: false,
      hasBeatGrid: derived.beatGridMs.length > 0,
      sourceMethod: "LYRICS_TIMING",
      beatGridMs: derived.beatGridMs,
      pitchContour: [],
    };
  }
  const beatGridMs =
    remote.beatGridMs.length > 0 ? remote.beatGridMs : derived.beatGridMs;
  return {
    ...remote,
    bpm: remote.bpm ?? derived.bpm,
    hasBeatGrid: beatGridMs.length > 0,
    beatGridMs,
  };
}

export type TapFeedbackQuality = "PERFECT" | "GOOD" | "EARLY" | "LATE";

export interface RhythmTapFeedback {
  tapMs: number;
  nearestBeatMs: number | null;
  offsetMs: number | null;
  quality: TapFeedbackQuality;
  labelVi: string;
  streak: number;
  totalTaps: number;
}

/**
 * Interactive Rhythm Tap tracker for `RHYTHM_TAP` practice mode.
 * Works completely without a microphone via tap button or Spacebar.
 */
export class RhythmTapTracker {
  private readonly taps: number[] = [];
  private readonly beats: number[];
  private lastTapMs = -Infinity;
  private streak = 0;

  constructor(beatGridMs: readonly number[]) {
    this.beats = [...beatGridMs].sort((a, b) => a - b);
  }

  reset(): void {
    this.taps.length = 0;
    this.lastTapMs = -Infinity;
    this.streak = 0;
  }

  recordTap(currentMs: number): RhythmTapFeedback | null {
    if (!Number.isFinite(currentMs) || currentMs < 0) return null;
    // Debounce accidental rapid double-taps (< 110 ms).
    if (currentMs - this.lastTapMs < 110) return null;
    this.lastTapMs = currentMs;
    const rounded = Math.round(currentMs);
    this.taps.push(rounded);

    let nearest: number | null = null;
    let bestSigned = Infinity;
    for (let i = 0; i < this.beats.length; i++) {
      const signed = rounded - this.beats[i];
      if (Math.abs(signed) < Math.abs(bestSigned)) {
        bestSigned = signed;
        nearest = this.beats[i];
      }
    }

    let quality: TapFeedbackQuality = "GOOD";
    let labelVi = translateRuntime("entertainment.karaoke.rhythmTap.steady");
    if (nearest === null || Math.abs(bestSigned) > 360) {
      quality = bestSigned < 0 ? "EARLY" : "LATE";
      labelVi =
        bestSigned < 0
          ? translateRuntime("entertainment.karaoke.rhythmTap.early")
          : translateRuntime("entertainment.karaoke.rhythmTap.late");
      this.streak = 0;
    } else if (Math.abs(bestSigned) <= 95) {
      quality = "PERFECT";
      labelVi = translateRuntime("entertainment.karaoke.rhythmTap.perfect");
      this.streak += 1;
    } else if (Math.abs(bestSigned) <= 190) {
      quality = "GOOD";
      labelVi = translateRuntime("entertainment.karaoke.rhythmTap.good");
      this.streak += 1;
    } else if (bestSigned < 0) {
      quality = "EARLY";
      labelVi = translateRuntime(
        "entertainment.karaoke.rhythmTap.slightlyFast",
      );
      this.streak = 0;
    } else {
      quality = "LATE";
      labelVi = translateRuntime(
        "entertainment.karaoke.rhythmTap.slightlySlow",
      );
      this.streak = 0;
    }

    return {
      tapMs: rounded,
      nearestBeatMs: nearest,
      offsetMs: nearest !== null ? bestSigned : null,
      quality,
      labelVi,
      streak: this.streak,
      totalTaps: this.taps.length,
    };
  }

  getTaps(): number[] {
    return [...this.taps];
  }

  getStreak(): number {
    return this.streak;
  }
}

/**
 * Guard invariant: ONLY completed `FULL_SONG` sessions with real evidence
 * may update a child's `bestFullSongScore`. `SEGMENT`, `LINE_PRACTICE`, and
 * `RHYTHM_TAP` NEVER overwrite the full-song best score!
 */
export function mergeBestFullSongScore(
  currentBest: number | null,
  evaluation: Pick<
    MusicalEvaluationResult,
    "practiceMode" | "scoringMode" | "overallScore"
  >,
): number | null {
  if (
    evaluation.practiceMode !== "FULL_SONG" ||
    evaluation.scoringMode === "INSUFFICIENT_EVIDENCE" ||
    evaluation.overallScore === null
  ) {
    return currentBest;
  }
  return currentBest === null
    ? evaluation.overallScore
    : Math.max(currentBest, evaluation.overallScore);
}
