/**
 * Pro Karaoke 3-Pillar Honest Scoring Engine (SingStar / Smule / DAM inspired for kids).
 *
 * Strictly deterministic, transparent, and anti-cheat:
 *   1. Pitch / Tông giọng (45% when reference melody exists):
 *      - Smart octave-folding (+12 semitones child voice = 0 cents error)
 *      - Key Shift (-3..+3 semitones) synced directly to target MIDI
 *      - Exact cent tiers: <=35c Perfect (100%), <=75c Great (80%), <=125c Good (50%), >125c rapid drop
 *      - Optional Auto Key-Offset detection & pitch stability bonus (capped at 100)
 *   2. Rhythm & Timing / Đúng nhịp (30%):
 *      - Syllable onset delta (compensated for micLatencyMs & playbackRate):
 *        <=80ms Perfect (100%), <=160ms Great (80%), <=260ms Good (50%), >260ms 0%
 *      - Sustain coverage across [syllable.start_ms, syllable.end_ms]
 *      - Combo Streak tracking (exciting HUD feedback, never inflates total > 100)
 *   3. Lyrics & Articulation / Đúng lời (25%):
 *      - Vietnamese diacritic-aware matching from LiveSingingScore
 *      - Dynamic weight re-normalization across actually measured pillars (NEVER fabricates scores!)
 */

import type {
  KaraokeLine,
  KaraokeLyrics,
  KaraokeMelodyNote,
  KaraokeMelodyProfile,
} from "@/types/karaoke";
import type { LiveSingingScore } from "./live-singing-score";
import {
  clamp01,
  hzToMidi,
  midiToHz,
  octaveInvariantCentsError,
  octaveInvariantSemitoneError,
  type AcousticGateReason,
  type DspFrame,
  type DspOnset,
  type DspSessionSummary,
  type LyricTimeSpan,
} from "./musical-dsp";
import type {
  MusicalProfileData,
  ReferencePitchPoint,
} from "./musical-scoring";

export type PitchJudgement =
  "perfect" | "great" | "good" | "off_pitch" | "unvoiced";

export type TimingBias = "early" | "on_beat" | "late" | "unknown";

export type ProKaraokeRank = "S" | "A+" | "A" | "B" | "C";

export interface TargetNoteSpan {
  startMs: number;
  endMs: number;
  midi: number;
  hz: number;
  confidence: number;
  syllableId?: string | null;
  lineId?: string | null;
  text?: string | null;
}

export interface LivePitchJudgement {
  judgement: PitchJudgement;
  direction: "up" | "down" | "on" | "none";
  centsError: number | null;
  signedCents: number | null;
  sungMidi: number | null;
  targetMidi: number | null;
  hasReference: boolean;
}

export interface ProKaraokeLineScore {
  lineIndex: number;
  lineId: string;
  text: string;
  startMs: number;
  endMs: number;
  pitchScore: number | null;
  rhythmScore: number | null;
  lyricsScore: number | null;
  overallScore: number | null;
  timingBias: TimingBias;
  meanDeltaMs: number | null;
  tipVi: string;
}

export interface ProKaraokePillarWeights {
  pitch: number;
  rhythm: number;
  lyrics: number;
}

export interface ProKaraokeScore {
  kind: "scored" | "insufficient";
  totalScore: number | null;
  rank: ProKaraokeRank | null;
  stars: 0 | 1 | 2 | 3 | 4 | 5;
  pitchScore: number | null;
  rhythmScore: number | null;
  lyricsScore: number | null;
  weights: ProKaraokePillarWeights;
  activePillars: {
    pitch: boolean;
    rhythm: boolean;
    lyrics: boolean;
  };
  hasReferenceMelody: boolean;
  keyShift: number;
  suggestedKeyShift: number | null;
  relativeMelodyScore: number | null;
  pitchStabilityBonus: number;
  meanCentsError: number | null;
  timingBias: TimingBias;
  meanTimingDeltaMs: number | null;
  meanAbsTimingErrorMs: number | null;
  sustainCoverage: number | null;
  maxCombo: number;
  perfectNotes: number;
  greatNotes: number;
  goodNotes: number;
  offPitchNotes: number;
  gateReason: AcousticGateReason;
  headlineVi: string;
  pitchInsightVi: string;
  rhythmInsightVi: string;
  lyricsInsightVi: string;
  lineScores: ProKaraokeLineScore[];
  worstLine: ProKaraokeLineScore | null;
}

export interface EvaluateProKaraokeInput {
  lyrics: KaraokeLyrics;
  dspSummary?: DspSessionSummary | null;
  liveLyricsScore?: LiveSingingScore | null;
  /** True when live SpeechRecognition actually ran during the take (humming with 0 words -> low Lyrics score rather than dropping pillar). */
  sttActive?: boolean;
  melodyProfile?: KaraokeMelodyProfile | null;
  musicalProfile?: MusicalProfileData | null;
  keyShift?: number;
  playbackRate?: number;
  segmentRange?: LyricTimeSpan | null;
}

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export function midiToNoteName(midi: number): string {
  if (!Number.isFinite(midi)) return "";
  const rounded = Math.round(midi);
  const note = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${note}${octave}`;
}

export function rankForScore(score: number): ProKaraokeRank {
  if (score >= 92) return "S";
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  return "C";
}

export function fiveStarsForScore(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score >= 92) return 5;
  if (score >= 80) return 4;
  if (score >= 66) return 3;
  if (score >= 48) return 2;
  return 1;
}

/** Exact cent grading specified for child-friendly pro karaoke scoring. */
export function gradePitchCents(absCents: number): {
  credit: number;
  judgement: Exclude<PitchJudgement, "unvoiced">;
} {
  if (!Number.isFinite(absCents)) {
    return { credit: 0, judgement: "off_pitch" };
  }
  if (absCents <= 35) return { credit: 1.0, judgement: "perfect" };
  if (absCents <= 75) return { credit: 0.8, judgement: "great" };
  if (absCents <= 125) return { credit: 0.5, judgement: "good" };
  // Rapid exponential decay past ±125 cents so off-pitch singing drops cleanly toward 0%.
  if (absCents >= 275) return { credit: 0, judgement: "off_pitch" };
  const decay = 0.5 * Math.exp(-(absCents - 125) / 50);
  return { credit: Math.max(0, decay), judgement: "off_pitch" };
}

/** Exact onset timing grading specified for child-friendly pro karaoke scoring. */
export function gradeOnsetDeltaMs(absDeltaMs: number): {
  credit: number;
  tier: "perfect" | "great" | "good" | "miss";
} {
  if (!Number.isFinite(absDeltaMs)) return { credit: 0, tier: "miss" };
  if (absDeltaMs <= 80) return { credit: 1.0, tier: "perfect" };
  if (absDeltaMs <= 160) return { credit: 0.8, tier: "great" };
  if (absDeltaMs <= 260) return { credit: 0.5, tier: "good" };
  return { credit: 0, tier: "miss" };
}

/** Normalize target note bars from `melody_profile` or `musicalProfile.pitchContour`. */
export function resolveTargetNotes(
  melodyProfile?: KaraokeMelodyProfile | null,
  musicalProfile?: MusicalProfileData | null,
  lyrics?: KaraokeLyrics | null,
): TargetNoteSpan[] {
  const effectiveMelody =
    melodyProfile ?? musicalProfile?.melodyProfile ?? null;
  if (effectiveMelody?.notes?.length) {
    return effectiveMelody.notes
      .filter((n: KaraokeMelodyNote) => n.voiced && n.end_ms > n.start_ms)
      .map((n: KaraokeMelodyNote) => ({
        startMs: n.start_ms,
        endMs: n.end_ms,
        midi: n.midi,
        hz: n.hz,
        confidence: n.confidence ?? 0.85,
        syllableId: n.syllable_id ?? null,
        lineId: n.line_id ?? null,
        text: n.text ?? null,
      }))
      .sort((a, b) => a.startMs - b.startMs);
  }

  // Fallback: synthesize target note spans from pitchContour + lyrics syllables.
  const contour: ReferencePitchPoint[] =
    effectiveMelody?.pitch_contour?.map((pt) => ({
      timeMs: pt.time_ms,
      hz: pt.hz,
      midi: pt.midi,
    })) ??
    musicalProfile?.pitchContour ??
    [];
  if (!contour.length) return [];

  if (lyrics?.lines?.length) {
    const spans: TargetNoteSpan[] = [];
    for (const line of lyrics.lines) {
      const units = line.syllables?.length
        ? line.syllables
        : line.start_ms !== null && line.end_ms !== null
          ? [
              {
                id: line.id,
                text: line.text,
                start_ms: line.start_ms,
                end_ms: line.end_ms,
              },
            ]
          : [];
      for (const u of units) {
        if (
          u.start_ms === null ||
          u.end_ms === null ||
          u.end_ms <= u.start_ms
        ) {
          continue;
        }
        const pts = contour.filter(
          (p) => p.timeMs >= u.start_ms! - 25 && p.timeMs <= u.end_ms! + 25,
        );
        if (!pts.length) continue;
        const midis = pts
          .map((p) => (p.midi !== undefined ? p.midi : hzToMidi(p.hz)))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        if (!midis.length) continue;
        const med = midis[Math.floor(midis.length / 2)];
        spans.push({
          startMs: u.start_ms,
          endMs: u.end_ms,
          midi: Number(med.toFixed(2)),
          hz: Number(midiToHz(med).toFixed(2)),
          confidence: 0.85,
          syllableId: u.id,
          lineId: line.id,
          text: u.text,
        });
      }
    }
    if (spans.length > 0) return spans;
  }

  // Group contiguous contour points into note bars.
  const sorted = [...contour].sort((a, b) => a.timeMs - b.timeMs);
  const bars: TargetNoteSpan[] = [];
  let i = 0;
  while (i < sorted.length) {
    const startMs = sorted[i].timeMs;
    const firstMidi =
      sorted[i].midi !== undefined ? sorted[i].midi! : hzToMidi(sorted[i].hz);
    const group = [firstMidi];
    let j = i + 1;
    while (
      j < sorted.length &&
      sorted[j].timeMs - sorted[j - 1].timeMs <= 120
    ) {
      const m =
        sorted[j].midi !== undefined ? sorted[j].midi! : hzToMidi(sorted[j].hz);
      if (Math.abs(m - group[0]) > 0.85) break;
      group.push(m);
      j++;
    }
    const endMs = Math.max(startMs + 80, sorted[j - 1].timeMs + 40);
    group.sort((a, b) => a - b);
    const med = group[Math.floor(group.length / 2)];
    bars.push({
      startMs,
      endMs,
      midi: Number(med.toFixed(2)),
      hz: Number(midiToHz(med).toFixed(2)),
      confidence: 0.85,
    });
    i = j;
  }
  return bars;
}

/** Find active target note at `timeMs` (shifted by `keyShift` semitones). */
export function getTargetNoteAtTime(
  notes: readonly TargetNoteSpan[],
  timeMs: number,
  keyShift = 0,
): (TargetNoteSpan & { shiftedMidi: number; shiftedHz: number }) | null {
  if (!notes.length) return null;
  // Binary search by startMs
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const n = notes[mid];
    if (timeMs < n.startMs - 20) {
      hi = mid - 1;
    } else if (timeMs > n.endMs + 20) {
      lo = mid + 1;
    } else {
      const shiftedMidi = n.midi + keyShift;
      return {
        ...n,
        shiftedMidi,
        shiftedHz: midiToHz(shiftedMidi),
      };
    }
  }
  return null;
}

/** Zero-allocation-friendly live per-frame pitch judgement for Pitch Highway & HUD. */
export function evaluateLivePitchJudgement(
  sungMidi: number | null,
  voiced: boolean,
  notes: readonly TargetNoteSpan[],
  timeMs: number,
  keyShift = 0,
): LivePitchJudgement {
  const target = getTargetNoteAtTime(notes, timeMs, keyShift);
  const hasReference = notes.length > 0;
  if (!voiced || sungMidi === null || !Number.isFinite(sungMidi)) {
    return {
      judgement: "unvoiced",
      direction: "none",
      centsError: null,
      signedCents: null,
      sungMidi: null,
      targetMidi: target?.shiftedMidi ?? null,
      hasReference,
    };
  }
  if (!target) {
    return {
      judgement: "unvoiced",
      direction: "none",
      centsError: null,
      signedCents: null,
      sungMidi,
      targetMidi: null,
      hasReference,
    };
  }
  const sungHz = midiToHz(sungMidi);
  const signedSemitones = octaveInvariantSemitoneError(
    sungHz,
    target.shiftedHz,
  );
  const signedCents = signedSemitones * 100;
  const absCents = Math.abs(signedCents);
  const { judgement } = gradePitchCents(absCents);
  let direction: LivePitchJudgement["direction"] = "on";
  if (absCents > 55) {
    direction = signedCents > 0 ? "down" : "up";
  }
  return {
    judgement,
    direction,
    centsError: Math.round(absCents),
    signedCents: Math.round(signedCents),
    sungMidi,
    targetMidi: target.shiftedMidi,
    hasReference,
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function iqr(values: number[]): number {
  if (values.length < 4) return 0;
  const s = [...values].sort((a, b) => a - b);
  return (
    s[Math.floor((s.length - 1) * 0.75)] - s[Math.floor((s.length - 1) * 0.25)]
  );
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - avg;
    sum += d * d;
  }
  return Math.sqrt(sum / values.length);
}

interface SyllableWindow {
  lineIndex: number;
  lineId: string;
  startMs: number;
  endMs: number;
  text: string;
}

function extractSyllableWindows(
  lyrics: KaraokeLyrics,
  range?: LyricTimeSpan | null,
): {
  lines: {
    line: KaraokeLine;
    lineIndex: number;
    startMs: number;
    endMs: number;
  }[];
  syllables: SyllableWindow[];
} {
  const lines: {
    line: KaraokeLine;
    lineIndex: number;
    startMs: number;
    endMs: number;
  }[] = [];
  const syllables: SyllableWindow[] = [];

  for (let i = 0; i < lyrics.lines.length; i++) {
    const line = lyrics.lines[i];
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
    lines.push({
      line,
      lineIndex: i,
      startMs: line.start_ms,
      endMs: line.end_ms,
    });
    if (line.syllables?.length) {
      for (const s of line.syllables) {
        if (s.start_ms !== null && s.end_ms !== null && s.end_ms > s.start_ms) {
          syllables.push({
            lineIndex: i,
            lineId: line.id,
            startMs: s.start_ms,
            endMs: s.end_ms,
            text: s.text,
          });
        }
      }
    } else {
      const tokens = line.text.trim().split(/\s+/).filter(Boolean);
      const count = Math.max(1, Math.min(8, tokens.length));
      const span = (line.end_ms - line.start_ms) / count;
      for (let k = 0; k < count; k++) {
        syllables.push({
          lineIndex: i,
          lineId: line.id,
          startMs: Math.round(line.start_ms + k * span),
          endMs: Math.round(line.start_ms + (k + 1) * span),
          text: tokens[k] ?? line.text,
        });
      }
    }
  }
  return { lines, syllables };
}

function evaluateRhythmForWindows(
  syllables: SyllableWindow[],
  onsets: readonly DspOnset[],
  frames: readonly DspFrame[],
  playbackRate: number,
): {
  score: number | null;
  meanDeltaMs: number | null;
  meanAbsErrorMs: number | null;
  timingBias: TimingBias;
  sustainCoverage: number | null;
  maxCombo: number;
} {
  if (!syllables.length || !frames.length) {
    return {
      score: null,
      meanDeltaMs: null,
      meanAbsErrorMs: null,
      timingBias: "unknown",
      sustainCoverage: null,
      maxCombo: 0,
    };
  }
  const rateScale =
    Number.isFinite(playbackRate) && playbackRate > 0.4 ? playbackRate : 1;
  // Wide enough to capture +300..450ms off-beat attacks honestly as misses (with timing bias)
  // rather than letting severe lateness fall into legato continuation credit.
  const searchRadiusMs = 450;
  const usedOnsets = new Set<number>();
  const hasRealArticulation =
    onsets.length >= Math.max(2, Math.floor(syllables.length * 0.25));

  let onsetCreditSum = 0;
  const signedDeltas: number[] = [];
  const absErrors: number[] = [];
  let sustainRatioSum = 0;
  let sustainCount = 0;
  let streak = 0;
  let maxCombo = 0;
  let prevSylMedianMidi: number | null = null;

  for (let i = 0; i < syllables.length; i++) {
    const syl = syllables[i];
    // Find nearest unused detected onset to syl.startMs
    let bestIdx = -1;
    let bestAbs = Infinity;
    let bestSigned = 0;
    for (let j = 0; j < onsets.length; j++) {
      if (usedOnsets.has(j)) continue;
      const signed = (onsets[j].timeMs - syl.startMs) / rateScale;
      const abs = Math.abs(signed);
      if (abs <= searchRadiusMs && abs < bestAbs) {
        bestAbs = abs;
        bestSigned = signed;
        bestIdx = j;
      }
    }

    // Measure sustain coverage & pitch change in [syl.startMs, syl.endMs]
    let totalInSyl = 0;
    let voicedInSyl = 0;
    const sylMidis: number[] = [];
    for (let f = 0; f < frames.length; f++) {
      const fr = frames[f];
      if (fr.timeMs >= syl.startMs && fr.timeMs <= syl.endMs) {
        totalInSyl++;
        if (fr.voiced && !fr.isHumLike) {
          voicedInSyl++;
          if (fr.midiNote !== null && Number.isFinite(fr.midiNote)) {
            sylMidis.push(fr.midiNote);
          }
        }
      }
    }
    const sylSustain =
      totalInSyl > 0
        ? clamp01(voicedInSyl / Math.max(1, totalInSyl * 0.72))
        : 0;
    const curSylMedianMidi = sylMidis.length > 0 ? median(sylMidis) : null;
    const pitchChangedFromPrev =
      curSylMedianMidi !== null &&
      prevSylMedianMidi !== null &&
      Math.abs(curSylMedianMidi - prevSylMedianMidi) >= 0.7;
    if (totalInSyl > 0) {
      sustainRatioSum += sylSustain;
      sustainCount++;
    }

    if (bestIdx >= 0) {
      usedOnsets.add(bestIdx);
      const { credit, tier } = gradeOnsetDeltaMs(bestAbs);
      onsetCreditSum += credit;
      signedDeltas.push(bestSigned);
      absErrors.push(bestAbs);
      if (tier === "perfect" || tier === "great") {
        streak++;
        if (streak > maxCombo) maxCombo = streak;
      } else {
        streak = 0;
      }
    } else if (
      i > 0 &&
      hasRealArticulation &&
      sylSustain >= 0.55 &&
      pitchChangedFromPrev
    ) {
      // Genuine melodic legato slide (pitch actually moved across syllables during articulated singing)
      onsetCreditSum += 0.45;
      streak = 0;
    } else {
      streak = 0;
    }
    prevSylMedianMidi = curSylMedianMidi;
  }

  const onsetScore = (onsetCreditSum / syllables.length) * 100;
  const sustainCoverage = sustainCount > 0 ? sustainRatioSum / sustainCount : 0;
  const sustainScore = sustainCoverage * 100;
  const rhythmScore = Math.max(
    0,
    Math.min(100, Math.round(0.72 * onsetScore + 0.28 * sustainScore)),
  );

  const meanDeltaMs = signedDeltas.length
    ? Math.round(signedDeltas.reduce((a, b) => a + b, 0) / signedDeltas.length)
    : null;
  const meanAbsErrorMs = absErrors.length
    ? Math.round(absErrors.reduce((a, b) => a + b, 0) / absErrors.length)
    : null;

  let timingBias: TimingBias = "unknown";
  if (meanDeltaMs !== null) {
    if (meanDeltaMs <= -75) timingBias = "early";
    else if (meanDeltaMs >= 75) timingBias = "late";
    else timingBias = "on_beat";
  }

  return {
    score: rhythmScore,
    meanDeltaMs,
    meanAbsErrorMs,
    timingBias,
    sustainCoverage: Number(sustainCoverage.toFixed(3)),
    maxCombo,
  };
}

function evaluatePitchForFrames(
  frames: readonly DspFrame[],
  targetNotes: readonly TargetNoteSpan[],
  keyShift: number,
): {
  score: number | null;
  meanCentsError: number | null;
  suggestedKeyShift: number | null;
  relativeMelodyScore: number | null;
  stabilityBonus: number;
  perfectNotes: number;
  greatNotes: number;
  goodNotes: number;
  offPitchNotes: number;
  maxPitchCombo: number;
} {
  if (!targetNotes.length || !frames.length) {
    return {
      score: null,
      meanCentsError: null,
      suggestedKeyShift: null,
      relativeMelodyScore: null,
      stabilityBonus: 0,
      perfectNotes: 0,
      greatNotes: 0,
      goodNotes: 0,
      offPitchNotes: 0,
      maxPitchCombo: 0,
    };
  }

  const signedSemitonesAll: number[] = [];
  const absCentsAll: number[] = [];
  let noteCreditSum = 0;
  let evaluatedNotes = 0;
  let perfectNotes = 0;
  let greatNotes = 0;
  let goodNotes = 0;
  let offPitchNotes = 0;
  let steadyNotes = 0;
  let streak = 0;
  let maxPitchCombo = 0;

  for (let i = 0; i < targetNotes.length; i++) {
    const note = targetNotes[i];
    const targetHz = midiToHz(note.midi + keyShift);
    const noteSigned: number[] = [];
    const noteAbsCents: number[] = [];

    for (let f = 0; f < frames.length; f++) {
      const fr = frames[f];
      if (
        fr.timeMs < note.startMs - 20 ||
        fr.timeMs > note.endMs + 20 ||
        !fr.voiced ||
        fr.isHumLike ||
        fr.frequencyHz === null
      ) {
        continue;
      }
      const signedSemi = octaveInvariantSemitoneError(fr.frequencyHz, targetHz);
      const absCents = octaveInvariantCentsError(fr.frequencyHz, targetHz);
      if (Number.isFinite(signedSemi) && Number.isFinite(absCents)) {
        noteSigned.push(signedSemi);
        noteAbsCents.push(absCents);
        signedSemitonesAll.push(signedSemi);
        absCentsAll.push(absCents);
      }
    }

    if (!noteAbsCents.length) {
      streak = 0;
      continue;
    }

    evaluatedNotes++;
    // Median error per note resists transient vibrato / consonant slide at syllable attack.
    const medAbsCents = median(noteAbsCents);
    const { credit, judgement } = gradePitchCents(medAbsCents);
    noteCreditSum += credit;

    if (judgement === "perfect") {
      perfectNotes++;
      streak++;
    } else if (judgement === "great") {
      greatNotes++;
      streak++;
    } else if (judgement === "good") {
      goodNotes++;
      streak = 0;
    } else {
      offPitchNotes++;
      streak = 0;
    }
    if (streak > maxPitchCombo) maxPitchCombo = streak;

    // Sustained stability check (>=3 voiced frames & low pitch jitter)
    if (noteSigned.length >= 3 && stdDev(noteSigned) * 100 <= 38) {
      steadyNotes++;
    }
  }

  if (evaluatedNotes === 0) {
    return {
      score: null,
      meanCentsError: null,
      suggestedKeyShift: null,
      relativeMelodyScore: null,
      stabilityBonus: 0,
      perfectNotes: 0,
      greatNotes: 0,
      goodNotes: 0,
      offPitchNotes: 0,
      maxPitchCombo: 0,
    };
  }

  // Coverage factor ensures singing only 1 easy note out of 20 doesn't yield 100%.
  const noteCoverage = evaluatedNotes / targetNotes.length;
  const coverageFactor =
    noteCoverage >= 0.45 ? 1.0 : Math.max(0.4, noteCoverage / 0.45);
  const rawPitchScore = (noteCreditSum / evaluatedNotes) * 100 * coverageFactor;
  const stabilityRatio = steadyNotes / evaluatedNotes;
  const stabilityBonus =
    rawPitchScore >= 55 ? Math.round(stabilityRatio * 5) : 0;
  const finalPitchScore = Math.max(
    0,
    Math.min(100, Math.round(rawPitchScore + stabilityBonus)),
  );

  // Auto Key-Offset detection: if child consistently sang at a steady transposed key
  // (e.g., +2 semitones across >=6 frames with tight IQR), compute relative melody score
  // and suggest the best Key Shift (-3..+3) for next take!
  let suggestedKeyShift: number | null = null;
  let relativeMelodyScore: number | null = null;
  if (signedSemitonesAll.length >= 6) {
    const medOffset = median(signedSemitonesAll);
    const spread = iqr(signedSemitonesAll);
    if (Math.abs(medOffset) >= 1.1 && spread <= 1.7) {
      const relCredits = signedSemitonesAll.map(
        (s) => gradePitchCents(Math.abs(s - medOffset) * 100).credit,
      );
      relativeMelodyScore = Math.round(
        (relCredits.reduce((a, b) => a + b, 0) / relCredits.length) * 100,
      );
      const nextShift = Math.max(
        -3,
        Math.min(3, Math.round(keyShift + medOffset)),
      );
      if (nextShift !== keyShift) {
        suggestedKeyShift = nextShift;
      }
    }
  }

  return {
    score: finalPitchScore,
    meanCentsError: Math.round(
      absCentsAll.reduce((a, b) => a + b, 0) / absCentsAll.length,
    ),
    suggestedKeyShift,
    relativeMelodyScore,
    stabilityBonus,
    perfectNotes,
    greatNotes,
    goodNotes,
    offPitchNotes,
    maxPitchCombo,
  };
}

function buildHeadlineVi(
  score: number | null,
  rank: ProKaraokeRank | null,
): string {
  if (score === null || rank === null) {
    return "Mình chưa nghe rõ giọng hát của bé. Bé thử lại gần micro hơn nhé!";
  }
  if (rank === "S") return "Xuất sắc tuyệt đỉnh! Giọng ca nhí tỏa sáng rực rỡ!";
  if (rank === "A+")
    return "Tuyệt vời quá! Bé hát rất đúng tông và bắt nhịp cực chuẩn!";
  if (rank === "A")
    return "Giỏi lắm bé ơi! Bài hát nghe rất hay và truyền cảm!";
  if (rank === "B")
    return "Khá tốt rồi! Bé luyện thêm vài câu nữa là đạt điểm A ngay!";
  return "Cố lên bé ơi! Bấm luyện từng câu chậm lại một chút để hát hay hơn nhé!";
}

/** Main deterministic 3-pillar Pro Karaoke evaluator. */
export function evaluateProKaraokePerformance(
  input: EvaluateProKaraokeInput,
): ProKaraokeScore {
  const keyShift = Math.max(-3, Math.min(3, Math.round(input.keyShift ?? 0)));
  const playbackRate = input.playbackRate ?? 1;
  const targetNotes = resolveTargetNotes(
    input.melodyProfile,
    input.musicalProfile,
    input.lyrics,
  );
  const hasReferenceMelody = targetNotes.length > 0;
  const { lines, syllables } = extractSyllableWindows(
    input.lyrics,
    input.segmentRange,
  );

  const dsp = input.dspSummary ?? null;
  const gateReason: AcousticGateReason = dsp?.qualityGate.reason ?? "OK";
  const dspUsable = Boolean(
    dsp && dsp.frameCount > 0 && dsp.qualityGate.passed,
  );

  const liveLyrics = input.liveLyricsScore ?? null;
  const lyricsEvaluated = liveLyrics?.evaluatedWords ?? 0;
  const hummedWithoutWordsUnderActiveStt = Boolean(
    input.sttActive &&
    dspUsable &&
    liveLyrics !== null &&
    liveLyrics.totalWords > 0 &&
    (liveLyrics.kind === "insufficient" || lyricsEvaluated === 0),
  );
  const lyricsScore =
    liveLyrics &&
    liveLyrics.kind !== "insufficient" &&
    lyricsEvaluated > 0 &&
    liveLyrics.totalWords > 0
      ? Math.max(
          0,
          Math.min(
            100,
            liveLyrics.overallAccuracy ??
              Math.round((100 * liveLyrics.matchedWords) / lyricsEvaluated),
          ),
        )
      : hummedWithoutWordsUnderActiveStt
        ? 0
        : null;

  // Hard anti-cheat gate: if microphone ran and detected ONLY silence/noise/hum/bleed,
  // NEVER fabricate points (unless pure lyrics-only mode where DSP never ran).
  if (dsp && dsp.frameCount > 0 && !dspUsable && lyricsScore === null) {
    return {
      kind: "insufficient",
      totalScore: null,
      rank: null,
      stars: 0,
      pitchScore: null,
      rhythmScore: null,
      lyricsScore: null,
      weights: { pitch: 0, rhythm: 0, lyrics: 0 },
      activePillars: { pitch: false, rhythm: false, lyrics: false },
      hasReferenceMelody,
      keyShift,
      suggestedKeyShift: null,
      relativeMelodyScore: null,
      pitchStabilityBonus: 0,
      meanCentsError: null,
      timingBias: "unknown",
      meanTimingDeltaMs: null,
      meanAbsTimingErrorMs: null,
      sustainCoverage: null,
      maxCombo: 0,
      perfectNotes: 0,
      greatNotes: 0,
      goodNotes: 0,
      offPitchNotes: 0,
      gateReason,
      headlineVi: buildHeadlineVi(null, null),
      pitchInsightVi: hasReferenceMelody
        ? "Chưa thu đủ giọng hát có cao độ rõ ràng để chấm tông giọng."
        : "Bài hát này chưa có giai điệu mẫu nên chưa chấm điểm tông giọng.",
      rhythmInsightVi:
        "Chưa nhận diện đủ nhịp vào tiếng — bé hát rõ và đều hơi hơn nhé.",
      lyricsInsightVi: "Chưa nhận diện rõ lời hát từ micro.",
      lineScores: [],
      worstLine: null,
    };
  }

  // If silence/noise/hum explicitly failed acoustic gate even with stray STT hallucinations:
  if (
    dsp &&
    dsp.frameCount > 0 &&
    !dspUsable &&
    (gateReason === "SILENCE" ||
      gateReason === "NOISE_ONLY" ||
      gateReason === "ELECTRICAL_HUM")
  ) {
    return {
      kind: "insufficient",
      totalScore: null,
      rank: null,
      stars: 0,
      pitchScore: null,
      rhythmScore: null,
      lyricsScore: null,
      weights: { pitch: 0, rhythm: 0, lyrics: 0 },
      activePillars: { pitch: false, rhythm: false, lyrics: false },
      hasReferenceMelody,
      keyShift,
      suggestedKeyShift: null,
      relativeMelodyScore: null,
      pitchStabilityBonus: 0,
      meanCentsError: null,
      timingBias: "unknown",
      meanTimingDeltaMs: null,
      meanAbsTimingErrorMs: null,
      sustainCoverage: null,
      maxCombo: 0,
      perfectNotes: 0,
      greatNotes: 0,
      goodNotes: 0,
      offPitchNotes: 0,
      gateReason,
      headlineVi: buildHeadlineVi(null, null),
      pitchInsightVi:
        gateReason === "SILENCE"
          ? "Micro chưa nghe thấy giọng hát của bé."
          : "Micro chỉ thu được tiếng ồn nền — bé hát gần micro và rõ tiếng hơn nhé!",
      rhythmInsightVi: "Chưa đủ tín hiệu giọng hát để chấm nhịp.",
      lyricsInsightVi: "Chưa đủ tín hiệu giọng hát để chấm lời.",
      lineScores: [],
      worstLine: null,
    };
  }

  const rhythmEval = dspUsable
    ? evaluateRhythmForWindows(
        syllables,
        dsp!.onsets,
        dsp!.frames,
        playbackRate,
      )
    : {
        score: null,
        meanDeltaMs: null,
        meanAbsErrorMs: null,
        timingBias: "unknown" as TimingBias,
        sustainCoverage: null,
        maxCombo: 0,
      };

  const scopedTargetNotes = input.segmentRange
    ? targetNotes.filter(
        (n) =>
          n.endMs > input.segmentRange!.startMs &&
          n.startMs < input.segmentRange!.endMs,
      )
    : targetNotes;

  const pitchEval =
    dspUsable && hasReferenceMelody
      ? evaluatePitchForFrames(dsp!.frames, scopedTargetNotes, keyShift)
      : {
          score: null,
          meanCentsError: null,
          suggestedKeyShift: null,
          relativeMelodyScore: null,
          stabilityBonus: 0,
          perfectNotes: 0,
          greatNotes: 0,
          goodNotes: 0,
          offPitchNotes: 0,
          maxPitchCombo: 0,
        };

  const hasPitch = pitchEval.score !== null;
  const hasRhythm = rhythmEval.score !== null;
  const hasLyrics = lyricsScore !== null;

  if (!hasPitch && !hasRhythm && !hasLyrics) {
    return {
      kind: "insufficient",
      totalScore: null,
      rank: null,
      stars: 0,
      pitchScore: null,
      rhythmScore: null,
      lyricsScore: null,
      weights: { pitch: 0, rhythm: 0, lyrics: 0 },
      activePillars: { pitch: false, rhythm: false, lyrics: false },
      hasReferenceMelody,
      keyShift,
      suggestedKeyShift: null,
      relativeMelodyScore: null,
      pitchStabilityBonus: 0,
      meanCentsError: null,
      timingBias: "unknown",
      meanTimingDeltaMs: null,
      meanAbsTimingErrorMs: null,
      sustainCoverage: null,
      maxCombo: 0,
      perfectNotes: 0,
      greatNotes: 0,
      goodNotes: 0,
      offPitchNotes: 0,
      gateReason,
      headlineVi: buildHeadlineVi(null, null),
      pitchInsightVi: hasReferenceMelody
        ? "Chưa đủ tín hiệu để chấm tông giọng."
        : "Bài hát chưa có giai điệu mẫu.",
      rhythmInsightVi: "Chưa đủ tín hiệu để chấm nhịp.",
      lyricsInsightVi: "Chưa nhận diện được lời hát.",
      lineScores: [],
      worstLine: null,
    };
  }

  // Dynamic honest weight normalization across ONLY measured pillars!
  const rawPitchW = hasPitch ? 0.45 : 0;
  const rawRhythmW = hasRhythm ? 0.3 : 0;
  const rawLyricsW = hasLyrics ? 0.25 : 0;
  const weightSum = rawPitchW + rawRhythmW + rawLyricsW;
  const weights: ProKaraokePillarWeights = {
    pitch: Number((rawPitchW / weightSum).toFixed(4)),
    rhythm: Number((rawRhythmW / weightSum).toFixed(4)),
    lyrics: Number((rawLyricsW / weightSum).toFixed(4)),
  };

  const totalScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (pitchEval.score ?? 0) * weights.pitch +
          (rhythmEval.score ?? 0) * weights.rhythm +
          (lyricsScore ?? 0) * weights.lyrics,
      ),
    ),
  );
  const rank = rankForScore(totalScore);
  const stars = fiveStarsForScore(totalScore);

  // Per-line 3D mini-scores
  const lineScores: ProKaraokeLineScore[] = lines.map(
    ({ line, lineIndex, startMs, endMs }) => {
      const lineSyls = syllables.filter((s) => s.lineId === line.id);
      const lineFrames = dspUsable
        ? dsp!.frames.filter(
            (f) => f.timeMs >= startMs - 120 && f.timeMs <= endMs + 120,
          )
        : [];
      const lineOnsets = dspUsable
        ? dsp!.onsets.filter(
            (o) => o.timeMs >= startMs - 260 && o.timeMs <= endMs + 260,
          )
        : [];
      const lineNotes = scopedTargetNotes.filter(
        (n) => n.endMs > startMs && n.startMs < endMs,
      );

      const lp =
        dspUsable && lineNotes.length > 0
          ? evaluatePitchForFrames(lineFrames, lineNotes, keyShift)
          : null;
      const lr = dspUsable
        ? evaluateRhythmForWindows(
            lineSyls,
            lineOnsets,
            lineFrames,
            playbackRate,
          )
        : null;
      const lineWordScore = liveLyrics?.lineScores.find(
        (l) => l.lineId === line.id,
      );
      const ll =
        lineWordScore && lineWordScore.evaluatedWords > 0
          ? Math.round(
              (100 * lineWordScore.matchedWords) / lineWordScore.evaluatedWords,
            )
          : null;

      const wP = lp?.score !== null && lp?.score !== undefined ? 0.45 : 0;
      const wR = lr?.score !== null && lr?.score !== undefined ? 0.3 : 0;
      const wL = ll !== null ? 0.25 : 0;
      const wSum = wP + wR + wL;
      const lineOverall =
        wSum > 0
          ? Math.round(
              ((lp?.score ?? 0) * wP + (lr?.score ?? 0) * wR + (ll ?? 0) * wL) /
                wSum,
            )
          : null;

      let tipVi = "Câu này bé hát rất hay!";
      if (lp?.score !== null && lp?.score !== undefined && lp.score < 68) {
        tipVi = "Chú ý nghe giai điệu mẫu để vào đúng tông câu này nhé.";
      } else if (lr?.timingBias === "early") {
        tipVi = "Câu này bé vào hơi sớm một chút — chờ chấm nhịp nhé!";
      } else if (lr?.timingBias === "late") {
        tipVi = "Câu này bé vào hơi chậm — nhìn thanh giai điệu tới gần nhé!";
      } else if (ll !== null && ll < 70) {
        tipVi = "Bé phát âm rõ từng tiếng câu này hơn nhé.";
      }

      return {
        lineIndex,
        lineId: line.id,
        text: line.text,
        startMs,
        endMs,
        pitchScore: lp?.score ?? null,
        rhythmScore: lr?.score ?? null,
        lyricsScore: ll,
        overallScore: lineOverall,
        timingBias: lr?.timingBias ?? "unknown",
        meanDeltaMs: lr?.meanDeltaMs ?? null,
        tipVi,
      };
    },
  );

  const scoredLines = lineScores.filter((l) => l.overallScore !== null);
  const worstLine =
    scoredLines.length > 0
      ? scoredLines.reduce((worst, cur) =>
          (cur.overallScore ?? 100) < (worst.overallScore ?? 100) ? cur : worst,
        )
      : null;

  // Natural Vietnamese insights for each pillar
  let pitchInsightVi: string;
  if (!hasReferenceMelody) {
    pitchInsightVi =
      "Bài hát cũ chưa có dữ liệu giai điệu mẫu — hệ thống chỉ chấm Nhịp & Lời (không bịa điểm tông).";
  } else if (pitchEval.score === null) {
    pitchInsightVi = "Chưa thu đủ nốt ngân rõ để đánh giá cao độ.";
  } else if (pitchEval.score >= 85) {
    pitchInsightVi = `Tuyệt vời! Sai lệch trung bình chỉ khoảng ${pitchEval.meanCentsError ?? 0} cents (${pitchEval.perfectNotes} nốt chuẩn xác).`;
  } else if (pitchEval.suggestedKeyShift !== null) {
    const dir = pitchEval.suggestedKeyShift > keyShift ? "tăng" : "hạ";
    pitchInsightVi = `Bé hát đúng giai điệu nhưng hơi lệch tông cố định — thử ${dir} tông lên ${pitchEval.suggestedKeyShift > 0 ? `+${pitchEval.suggestedKeyShift}` : pitchEval.suggestedKeyShift} bán âm nhé!`;
  } else {
    pitchInsightVi = `Sai lệch trung bình ${pitchEval.meanCentsError ?? 0} cents — bé nhìn đường tông trên màn hình để giữ đúng cao độ nhé!`;
  }

  let rhythmInsightVi: string;
  if (rhythmEval.score === null) {
    rhythmInsightVi = "Chưa có dữ liệu micro để đo nhịp điệu.";
  } else if (rhythmEval.timingBias === "early") {
    rhythmInsightVi = `Bé thường vào hơi sớm khoảng ${Math.abs(rhythmEval.meanDeltaMs ?? 0)}ms — chờ nhạc dẫn rồi mới vào tiếng nhé!`;
  } else if (rhythmEval.timingBias === "late") {
    rhythmInsightVi = `Bé thường vào hơi chậm khoảng ${Math.abs(rhythmEval.meanDeltaMs ?? 0)}ms — thử chỉnh độ trễ micro hoặc luyện tốc độ 0.85x nhé!`;
  } else {
    rhythmInsightVi = `Bắt nhịp rất chắc! Sai lệch trung bình ${rhythmEval.meanAbsErrorMs ?? 0}ms, chuỗi chuẩn liên tiếp ${Math.max(rhythmEval.maxCombo, pitchEval.maxPitchCombo)} tiếng.`;
  }

  let lyricsInsightVi: string;
  if (lyricsScore === null) {
    lyricsInsightVi =
      "Trình duyệt không bật nhận diện lời — tổng điểm được tính trung thực từ Cao độ & Nhịp điệu.";
  } else if (hummedWithoutWordsUnderActiveStt) {
    lyricsInsightVi =
      "Bé ngân đúng giai điệu nhưng chưa nghe rõ lời bài hát — hãy phát âm rõ từng tiếng hơn nhé!";
  } else if (lyricsScore >= 85) {
    lyricsInsightVi = `Phát âm rõ ràng! Khớp ${liveLyrics?.matchedWords ?? 0}/${liveLyrics?.evaluatedWords ?? 0} tiếng.`;
  } else {
    lyricsInsightVi = `Khớp ${liveLyrics?.matchedWords ?? 0}/${liveLyrics?.evaluatedWords ?? 0} tiếng — bé hát chậm lại một chút để tròn vành rõ chữ nhé!`;
  }

  return {
    kind: "scored",
    totalScore,
    rank,
    stars,
    pitchScore: pitchEval.score,
    rhythmScore: rhythmEval.score,
    lyricsScore,
    weights,
    activePillars: {
      pitch: hasPitch,
      rhythm: hasRhythm,
      lyrics: hasLyrics,
    },
    hasReferenceMelody,
    keyShift,
    suggestedKeyShift: pitchEval.suggestedKeyShift,
    relativeMelodyScore: pitchEval.relativeMelodyScore,
    pitchStabilityBonus: pitchEval.stabilityBonus,
    meanCentsError: pitchEval.meanCentsError,
    timingBias: rhythmEval.timingBias,
    meanTimingDeltaMs: rhythmEval.meanDeltaMs,
    meanAbsTimingErrorMs: rhythmEval.meanAbsErrorMs,
    sustainCoverage: rhythmEval.sustainCoverage,
    maxCombo: Math.max(rhythmEval.maxCombo, pitchEval.maxPitchCombo),
    perfectNotes: pitchEval.perfectNotes,
    greatNotes: pitchEval.greatNotes,
    goodNotes: pitchEval.goodNotes,
    offPitchNotes: pitchEval.offPitchNotes,
    gateReason,
    headlineVi: buildHeadlineVi(totalScore, rank),
    pitchInsightVi,
    rhythmInsightVi,
    lyricsInsightVi,
    lineScores,
    worstLine,
  };
}
