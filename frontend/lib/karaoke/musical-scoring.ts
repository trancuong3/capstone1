/**
 * Honest, non-conflated Musical Karaoke Scoring Engine.
 *
 * Explicitly separates 4 scoring modes so pitch/rhythm are NEVER fabricated
 * when acoustic evidence is missing or degraded:
 *   1. FULL_MUSICAL          — 40% Rhythm / 30% Pitch & Melody / 20% Lyrics / 10% Fluency
 *   2. RHYTHM_AND_LYRICS     — 60% Rhythm / 30% Lyrics / 10% Fluency (pitchScore = null)
 *   3. LYRICS_ONLY           — Lyrics only fallback (pitchScore = null, rhythmScore = null)
 *   4. INSUFFICIENT_EVIDENCE — Silence, noise, hum, speaker bleed, or <15% vocal coverage
 *                              (overallScore = null, warm guidance)
 */

import type { KaraokeLine, KaraokeLyrics } from "@/types/karaoke";
import type { LiveSingingScore } from "./live-singing-score";
import {
  clamp01,
  octaveInvariantCentsError,
  octaveInvariantSemitoneError,
  type AcousticGateReason,
  type DspFrame,
  type DspSessionSummary,
  type LyricTimeSpan,
} from "./musical-dsp";

export type MusicalScoringMode =
  | "FULL_MUSICAL"
  | "RHYTHM_AND_LYRICS"
  | "LYRICS_ONLY"
  | "INSUFFICIENT_EVIDENCE";

export type KaraokePracticeMode =
  "FULL_SONG" | "SEGMENT" | "LINE_PRACTICE" | "RHYTHM_TAP";

export type PitchScoringBasis =
  "REFERENCE_MELODY" | "VOCAL_STEADINESS_AND_CONTOUR" | "UNAVAILABLE";

export type SegmentPracticeStatus = "GREAT" | "GOOD" | "PRACTICE";

export interface ReferencePitchPoint {
  timeMs: number;
  hz: number;
  midi?: number;
}

export interface MusicalProfileData {
  songId?: string;
  songVersionId?: string;
  bpm: number | null;
  audioType: "VOCAL_FULL" | "INSTRUMENTAL_ONLY" | "DUAL_TRACK" | "UNKNOWN";
  hasPitchContour: boolean;
  hasBeatGrid: boolean;
  sourceMethod:
    "ID3_LRC" | "AUDIO_DSP" | "WHISPER_DRAFT" | "MANUAL_TAP" | "LYRICS_TIMING";
  beatGridMs: number[];
  pitchContour: ReferencePitchPoint[];
}

export interface MusicalSegmentReport {
  lineIndex: number;
  lineId: string;
  startMs: number;
  endMs: number;
  text: string;
  rhythmScore: number | null;
  pitchScore: number | null;
  lyricsScore: number | null;
  vocalCoverage: number;
  lineOverallScore: number | null;
  status: SegmentPracticeStatus;
  tipVi: string;
}

export interface MusicalScoreWeights {
  rhythm: number;
  pitch: number;
  lyrics: number;
  fluency: number;
}

export interface MusicalEvaluationResult {
  scoringMode: MusicalScoringMode;
  scoringModeLabelVi: string;
  practiceMode: KaraokePracticeMode;
  pitchBasis: PitchScoringBasis;
  pitchBasisLabelVi: string;
  overallScore: number | null;
  rhythmScore: number | null;
  pitchScore: number | null;
  lyricsScore: number | null;
  fluencyScore: number | null;
  stars: 0 | 1 | 2 | 3;
  weightsUsed: MusicalScoreWeights;
  activeVocalCoverage: number;
  voicedCoverage: number;
  meanCentsError: number | null;
  meanSignedTimingOffsetMs: number | null;
  meanAbsTimingErrorMs: number | null;
  speakerBleedSuspected: boolean;
  gateReason: AcousticGateReason;
  guidanceVi: string;
  encouragementVi: string;
  segments: MusicalSegmentReport[];
  weakestSegment: MusicalSegmentReport | null;
}

export interface EvaluateMusicalInput {
  lyrics: KaraokeLyrics;
  dspSummary?: DspSessionSummary | null;
  liveLyricsScore?: LiveSingingScore | null;
  referenceProfile?: MusicalProfileData | null;
  rhythmTapsMs?: number[] | null;
  practiceMode?: KaraokePracticeMode;
  headphoneMode?: boolean;
  segmentRange?: LyricTimeSpan | null;
}

export const SCORING_MODE_LABELS_VI: Record<MusicalScoringMode, string> = {
  FULL_MUSICAL: "Chấm đầy đủ nhạc lý (Nhịp · Giai điệu · Lời)",
  RHYTHM_AND_LYRICS: "Chấm nhịp điệu & lời hát",
  LYRICS_ONLY: "Chỉ chấm lời hát",
  INSUFFICIENT_EVIDENCE: "Chưa đủ tín hiệu giọng hát",
};

export const PITCH_BASIS_LABELS_VI: Record<PitchScoringBasis, string> = {
  REFERENCE_MELODY: "Đối chiếu giai điệu chuẩn (không phân biệt quãng 8)",
  VOCAL_STEADINESS_AND_CONTOUR: "Độ ổn định & đường nét giai điệu giọng hát",
  UNAVAILABLE: "Chưa đo cao độ",
};

function roundScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function interquartileRange(values: number[]): number {
  if (values.length < 4) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)];
  const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)];
  return q3 - q1;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - avg;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / values.length);
}

/** Extract lyric lines in scope (filtering by segmentRange if practicing a segment). */
function scopedLines(
  lyrics: KaraokeLyrics,
  range?: LyricTimeSpan | null,
): { line: KaraokeLine; lineIndex: number; startMs: number; endMs: number }[] {
  const result: {
    line: KaraokeLine;
    lineIndex: number;
    startMs: number;
    endMs: number;
  }[] = [];
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
    result.push({
      line,
      lineIndex: i,
      startMs: line.start_ms,
      endMs: line.end_ms,
    });
  }
  return result;
}

/** Collect expected onset timestamps for one lyric line (syllable-accurate when v2). */
export function expectedOnsetsForLine(line: KaraokeLine): number[] {
  if (line.syllables?.length) {
    const timed = line.syllables
      .map((s) => s.start_ms)
      .filter((t): t is number => t !== null && Number.isFinite(t));
    if (timed.length > 0) return timed;
  }
  if (
    line.start_ms === null ||
    line.end_ms === null ||
    line.end_ms <= line.start_ms
  ) {
    return [];
  }
  const tokens = line.text.trim().split(/\s+/).filter(Boolean);
  const count = Math.max(1, Math.min(8, tokens.length));
  const span = line.end_ms - line.start_ms;
  const step = span / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round(line.start_ms + i * step));
  }
  return out;
}

/**
 * Piecewise timing credit for a single onset error in milliseconds.
 * Calibrated for primary-school children:
 *   <= 70 ms  -> 1.00 (in-time)
 *   160 ms    -> 0.80 (good groove)
 *   280 ms    -> 0.45 (noticeable drift)
 *   350 ms    -> 0.30 (delayed/rushed)
 *   > 420 ms  -> 0.00 (off-beat / missed)
 */
function onsetTimingCredit(absErrMs: number): number {
  if (absErrMs <= 70) return 1.0;
  if (absErrMs <= 160) return 1.0 - ((absErrMs - 70) / 90) * 0.2;
  if (absErrMs <= 280) return 0.8 - ((absErrMs - 160) / 120) * 0.35;
  if (absErrMs <= 420) return 0.45 - ((absErrMs - 280) / 140) * 0.3;
  return 0;
}

/**
 * Piecewise octave-invariant pitch credit for cents deviation.
 *   <= 15 cents -> 1.00 (dead-on in tune)
 *   35 cents    -> 0.93 (slightly sharp/flat, still very encouraging)
 *   80 cents    -> 0.78
 *   200 cents   -> 0.35
 *   350 cents   -> 0.125 (badly off-pitch)
 */
function centsPitchCredit(centsErr: number): number {
  if (centsErr <= 15) return 1.0;
  if (centsErr <= 80) return 1.0 - ((centsErr - 15) / 65) * 0.22;
  if (centsErr <= 200) return 0.78 - ((centsErr - 80) / 120) * 0.43;
  if (centsErr <= 400) return 0.35 - ((centsErr - 200) / 200) * 0.3;
  return 0.05;
}

interface RhythmEval {
  score: number | null;
  meanSignedOffsetMs: number | null;
  meanAbsErrorMs: number | null;
  matchedCount: number;
  expectedCount: number;
}

function evaluateRhythmAgainstTargets(
  expectedMs: number[],
  detectedMs: number[],
  activeFramesInLyricRatio: number | null,
): RhythmEval {
  if (!expectedMs.length) {
    return {
      score: null,
      meanSignedOffsetMs: null,
      meanAbsErrorMs: null,
      matchedCount: 0,
      expectedCount: 0,
    };
  }
  if (!detectedMs.length) {
    return {
      score: 0,
      meanSignedOffsetMs: null,
      meanAbsErrorMs: null,
      matchedCount: 0,
      expectedCount: expectedMs.length,
    };
  }

  // Order-preserving minimum-cost DP alignment (gap penalty = 680 ms, max match = 450 ms)
  // prevents beat-skip aliasing where a +350ms delayed onset steals the next syllable.
  const exp = [...expectedMs].sort((a, b) => a - b);
  const det = [...detectedMs].sort((a, b) => a - b);
  const m = exp.length;
  const n = det.length;
  const maxWindowMs = 450;
  const gapPenalty = 680;
  const stride = n + 1;

  const signedErrors: number[] = [];
  const absErrors: number[] = [];
  let creditSum = 0;
  let matchedCount = 0;

  // Guard against gigantic songs blowing memory (normal songs <= 300 syllables).
  if ((m + 1) * (n + 1) <= 250_000) {
    const dp = new Float64Array((m + 1) * stride);
    const bt = new Uint8Array((m + 1) * stride); // 1 = skip exp, 2 = skip det, 3 = match
    for (let i = 1; i <= m; i++) {
      dp[i * stride] = i * gapPenalty;
      bt[i * stride] = 1;
    }
    for (let j = 1; j <= n; j++) {
      dp[j] = j * gapPenalty;
      bt[j] = 2;
    }
    for (let i = 1; i <= m; i++) {
      const row = i * stride;
      const prevRow = (i - 1) * stride;
      const target = exp[i - 1];
      for (let j = 1; j <= n; j++) {
        let bestCost = dp[prevRow + j] + gapPenalty;
        let move = 1;
        const skipDet = dp[row + j - 1] + gapPenalty;
        if (skipDet < bestCost) {
          bestCost = skipDet;
          move = 2;
        }
        const err = Math.abs(det[j - 1] - target);
        if (err <= maxWindowMs) {
          const matchCost = dp[prevRow + j - 1] + err;
          if (matchCost <= bestCost) {
            bestCost = matchCost;
            move = 3;
          }
        }
        dp[row + j] = bestCost;
        bt[row + j] = move;
      }
    }
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      const move = bt[i * stride + j];
      if (move === 3 && i > 0 && j > 0) {
        const signed = det[j - 1] - exp[i - 1];
        const absErr = Math.abs(signed);
        signedErrors.push(signed);
        absErrors.push(absErr);
        creditSum += onsetTimingCredit(absErr);
        matchedCount++;
        i--;
        j--;
      } else if (move === 1 && i > 0) {
        i--;
      } else {
        j--;
      }
    }
  } else {
    const used = new Uint8Array(n);
    for (let i = 0; i < m; i++) {
      const target = exp[i];
      let bestIdx = -1;
      let bestAbs = Infinity;
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const err = Math.abs(det[j] - target);
        if (err <= maxWindowMs && err < bestAbs) {
          bestAbs = err;
          bestIdx = j;
        }
      }
      if (bestIdx !== -1) {
        used[bestIdx] = 1;
        matchedCount++;
        signedErrors.push(det[bestIdx] - target);
        absErrors.push(bestAbs);
        creditSum += onsetTimingCredit(bestAbs);
      }
    }
  }

  // Recall-aware onset score: missing 70% of expected notes MUST lower rhythm score.
  const recallCredit = creditSum / expectedMs.length;
  // Precision guard: spamming random extra onsets/taps cannot inflate rhythm score.
  const precision =
    detectedMs.length > 0 ? matchedCount / detectedMs.length : 0;
  const precisionPenalty =
    detectedMs.length > expectedMs.length * 1.4
      ? Math.max(0.55, precision / 0.75)
      : 1.0;

  // Timing accuracy among matched onsets + overall coverage balance.
  const onsetScore = clamp01(recallCredit * precisionPenalty);

  // Combine with phrase-span alignment when vocal frames are available.
  const combined =
    activeFramesInLyricRatio !== null
      ? 0.75 * onsetScore + 0.25 * clamp01(activeFramesInLyricRatio)
      : onsetScore;

  return {
    score: roundScore(combined * 100),
    meanSignedOffsetMs:
      signedErrors.length > 0
        ? Math.round(
            signedErrors.reduce((a, b) => a + b, 0) / signedErrors.length,
          )
        : null,
    meanAbsErrorMs:
      absErrors.length > 0
        ? Math.round(absErrors.reduce((a, b) => a + b, 0) / absErrors.length)
        : null,
    matchedCount,
    expectedCount: expectedMs.length,
  };
}

interface PitchEval {
  score: number | null;
  basis: PitchScoringBasis;
  meanCentsError: number | null;
}

function findNearestReferenceHz(
  timeMs: number,
  contour: readonly ReferencePitchPoint[],
  maxDeltaMs = 140,
): number | null {
  if (!contour.length) return null;
  // Binary search by timeMs (contour is sorted ascending).
  let lo = 0;
  let hi = contour.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (contour[mid].timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  let bestIdx = lo;
  let bestDist = Math.abs(contour[lo].timeMs - timeMs);
  if (lo > 0) {
    const prevDist = Math.abs(contour[lo - 1].timeMs - timeMs);
    if (prevDist < bestDist) {
      bestDist = prevDist;
      bestIdx = lo - 1;
    }
  }
  return bestDist <= maxDeltaMs && contour[bestIdx].hz > 0
    ? contour[bestIdx].hz
    : null;
}

/**
 * Evaluate pitch either against a reference melody contour (octave-invariant +
 * relative melodic contour) OR via vocal steadiness & melodic contour when no
 * reference melody exists (explicitly penalizing flat monotone spoken reading).
 */
function evaluatePitchForFrames(
  frames: readonly DspFrame[],
  referenceContour: readonly ReferencePitchPoint[],
): PitchEval {
  const voiced = frames.filter(
    (f) => f.voiced && f.frequencyHz !== null && f.midiNote !== null,
  );
  if (voiced.length < 3) {
    return { score: null, basis: "UNAVAILABLE", meanCentsError: null };
  }

  const meanClarity =
    voiced.reduce((sum, f) => sum + f.clarity, 0) / voiced.length;
  // Low clarity (breathy spoken reading) attenuates pitch confidence.
  const clarityFactor = clamp01(0.45 + 0.55 * ((meanClarity - 0.65) / 0.3));

  // Branch A: Reference melody contour available.
  if (referenceContour.length >= 3) {
    const sortedContour = [...referenceContour].sort(
      (a, b) => a.timeMs - b.timeMs,
    );
    const matchedPairs: {
      sungHz: number;
      refHz: number;
      centsErr: number;
      credit: number;
      timeMs: number;
    }[] = [];

    for (let i = 0; i < voiced.length; i++) {
      const f = voiced[i];
      const refHz = findNearestReferenceHz(f.timeMs, sortedContour);
      if (refHz === null || f.frequencyHz === null) continue;
      const centsErr = octaveInvariantCentsError(f.frequencyHz, refHz);
      if (!Number.isFinite(centsErr)) continue;
      matchedPairs.push({
        sungHz: f.frequencyHz,
        refHz,
        centsErr,
        credit: centsPitchCredit(centsErr),
        timeMs: f.timeMs,
      });
    }

    if (matchedPairs.length >= 3) {
      const avgCredit =
        matchedPairs.reduce((acc, p) => acc + p.credit, 0) /
        matchedPairs.length;
      const meanCents =
        matchedPairs.reduce((acc, p) => acc + p.centsErr, 0) /
        matchedPairs.length;

      // Relative melodic contour check: compare semitone intervals across distinct notes
      // (~280–900 ms apart) rather than repeating identical adjacent 40ms frames inside one held note.
      let contourWeightSum = 0;
      let contourMatchSum = 0;
      let anchorIdx = 0;
      for (let i = 1; i < matchedPairs.length; i++) {
        const curr = matchedPairs[i];
        while (
          anchorIdx < i - 1 &&
          curr.timeMs - matchedPairs[anchorIdx].timeMs > 850
        ) {
          anchorIdx++;
        }
        const prev = matchedPairs[anchorIdx];
        const dt = curr.timeMs - prev.timeMs;
        if (dt < 260 || dt > 850) continue;
        const refStep = octaveInvariantSemitoneError(curr.refHz, prev.refHz);
        const sungStep = octaveInvariantSemitoneError(curr.sungHz, prev.sungHz);
        if (!Number.isFinite(refStep) || !Number.isFinite(sungStep)) continue;
        const stepDiff = Math.abs(sungStep - refStep);
        const stepCredit = clamp01(1 - stepDiff / 4.0);
        // Emphasize real melodic moves (>= 0.8 semitone) so flat monotone or wild off-pitch is exposed!
        const weight = Math.abs(refStep) >= 0.8 ? 2.5 : 0.4;
        contourMatchSum += stepCredit * weight;
        contourWeightSum += weight;
        anchorIdx = i;
      }
      const contourScore =
        contourWeightSum > 0 ? contourMatchSum / contourWeightSum : avgCredit;

      // Also check whether reference melody has movement while sung voice is flat monotone.
      const refMidis = matchedPairs.map(
        (p) => Math.round(12 * Math.log2(p.refHz / 440) * 10) / 10,
      );
      const sungMidis = matchedPairs.map(
        (p) => Math.round(12 * Math.log2(p.sungHz / 440) * 10) / 10,
      );
      const refSpread = stdDev(refMidis);
      const sungSpread = stdDev(sungMidis);
      const monotonePenalty =
        refSpread >= 1.2 && sungSpread < 0.45 ? 0.55 : 1.0;

      const rawPitch =
        (0.78 * avgCredit + 0.22 * contourScore) *
        clarityFactor *
        monotonePenalty;

      return {
        score: roundScore(rawPitch * 100),
        basis: "REFERENCE_MELODY",
        meanCentsError: Math.round(meanCents),
      };
    }
  }

  // Branch B: No reference melody contour -> Melodic Contour & Vocal Steadiness.
  // Distinguishes sustained melodic singing from flat monotone speech!
  const midis = voiced.map((f) => f.midiNote!);
  const pitchStd = stdDev(midis);
  const pitchIqr = interquartileRange(midis);
  const pitchRange = Math.max(...midis) - Math.min(...midis);

  // Measure sustained steady voiced runs (>= 120 ms continuous frames with < 0.85 semitone jump).
  let sustainedFrames = 0;
  let runFrames = 1;
  const intraRunJitters: number[] = [];
  for (let i = 1; i < voiced.length; i++) {
    const dt = voiced[i].timeMs - voiced[i - 1].timeMs;
    const dMidi = Math.abs(voiced[i].midiNote! - voiced[i - 1].midiNote!);
    if (dt <= 95 && dMidi <= 0.85) {
      runFrames++;
      intraRunJitters.push(dMidi * 100);
    } else {
      if (runFrames >= 3) sustainedFrames += runFrames;
      runFrames = 1;
    }
  }
  if (runFrames >= 3) sustainedFrames += runFrames;

  const sustainedRatio = clamp01(sustainedFrames / voiced.length);
  const medianJitterCents =
    intraRunJitters.length > 0 ? median(intraRunJitters) : 65;
  const steadinessScore = clamp01(1 - Math.max(0, medianJitterCents - 15) / 90);

  // Melodic expressiveness rewards real singing intervals (2–10 semitones spread)
  // and penalizes robotic flat monotone (< 0.8 semitone std).
  const movementScore = clamp01(
    0.6 * clamp01((pitchStd - 0.35) / 2.0) +
      0.4 * clamp01((pitchIqr - 0.4) / 2.4),
  );

  let combined =
    (0.42 * sustainedRatio + 0.28 * steadinessScore + 0.3 * movementScore) *
    clarityFactor *
    100;

  // Hard anti-gaming monotone cap: flat monotone voice over a phrase cannot score high!
  if (voiced.length >= 10 && pitchRange < 1.25 && pitchStd < 0.4) {
    combined = Math.min(combined, 35);
  }

  return {
    score: roundScore(combined),
    basis: "VOCAL_STEADINESS_AND_CONTOUR",
    meanCentsError: null,
  };
}

function guidanceForGate(
  reason: AcousticGateReason,
  headphoneMode: boolean,
): string {
  switch (reason) {
    case "SILENCE":
      return "Mình chưa nghe thấy giọng hát của bé. Bé đưa micro lại gần hơn một chút hoặc kiểm tra micro rồi thử lại nhé!";
    case "NOISE_ONLY":
      return "Xung quanh hơi ồn nên mình chưa nghe rõ tiếng hát của bé. Bé hãy chọn góc yên tĩnh hơn hoặc đeo tai nghe nhé!";
    case "ELECTRICAL_HUM":
      return "Micro đang có tiếng ù nền. Ba mẹ giúp bé kiểm tra lại micro hoặc dây cắm rồi thử lại nhé!";
    case "SPEAKER_BLEED":
      return headphoneMode
        ? "Âm thanh bị lặp lại nên chưa tách rõ giọng bé. Bé giảm nhẹ âm lượng tai nghe và hát rõ hơn nhé!"
        : "Mình đang nghe tiếng nhạc từ loa nhiều hơn giọng bé. Bé đeo tai nghe hoặc đưa micro gần miệng hơn để mình chấm chính xác nhé!";
    case "LOW_COVERAGE":
      return "Bé mới hát được một đoạn ngắn thôi. Hãy hát thêm vài câu nữa để mình chấm điểm đầy đủ cho bé nhé!";
    case "OK":
      return headphoneMode
        ? "Chế độ tai nghe giúp micro thu giọng bé rất rõ nét!"
        : "Mẹo nhỏ: Đeo tai nghe sẽ giúp micro nghe rõ giai điệu và nhịp điệu của bé nhất!";
  }
}

function encouragementForScore(
  score: number | null,
  mode: MusicalScoringMode,
): string {
  if (mode === "INSUFFICIENT_EVIDENCE" || score === null) {
    return "Chưa đủ tín hiệu để chấm điểm lần này. Bé thử hát rõ hơn gần micro nhé!";
  }
  if (score >= 88)
    return "Tuyệt vời quá! Bé hát đúng nhịp, rõ lời và rất có cảm xúc!";
  if (score >= 72) return "Giỏi lắm! Bé giữ nhịp và giai điệu khá tốt rồi đó!";
  if (score >= 52)
    return "Khá tốt! Bé thử luyện chậm lại đoạn khó ở tốc độ 0.85x nhé!";
  return "Cố lên nhé! Mình cùng tập chậm từng câu để bé hát ngày càng hay hơn!";
}

function starsForScore(score: number | null): 0 | 1 | 2 | 3 {
  if (score === null) return 0;
  if (score >= 85) return 3;
  if (score >= 65) return 2;
  if (score >= 40) return 1;
  return 0;
}

function buildLineTipVi(params: {
  status: SegmentPracticeStatus;
  vocalCoverage: number;
  rhythmScore: number | null;
  pitchScore: number | null;
  lyricsScore: number | null;
  meanSignedOffsetMs: number | null;
}): string {
  if (params.vocalCoverage < 0.18 && (params.lyricsScore ?? 0) < 30) {
    return "Câu này bé chưa hát rõ, bấm luyện lại chậm 0.85x nhé!";
  }
  if (params.status === "GREAT") {
    return "Tuyệt vời! Bé hát câu này rất tự tin và đúng nhịp!";
  }
  const scores: { key: "rhythm" | "pitch" | "lyrics"; val: number }[] = [];
  if (params.rhythmScore !== null)
    scores.push({ key: "rhythm", val: params.rhythmScore });
  if (params.pitchScore !== null)
    scores.push({ key: "pitch", val: params.pitchScore });
  if (params.lyricsScore !== null)
    scores.push({ key: "lyrics", val: params.lyricsScore });
  scores.sort((a, b) => a.val - b.val);
  const weakest = scores[0]?.key;

  if (weakest === "rhythm") {
    if (params.meanSignedOffsetMs !== null && params.meanSignedOffsetMs > 120) {
      return "Bé vào câu này hơi chậm nhịp một chút, nghe nhạc và vào sớm hơn nhé!";
    }
    if (
      params.meanSignedOffsetMs !== null &&
      params.meanSignedOffsetMs < -120
    ) {
      return "Bé hát hơi nhanh hơn nhịp một chút, hãy hát đều theo chữ chạy nhé!";
    }
    return "Bé thử gõ nhịp hoặc tập câu này ở tốc độ 0.85x cho đều nhịp hơn nhé!";
  }
  if (weakest === "pitch") {
    return "Bé nghe kỹ giai điệu câu này, hát ngân tròn chữ để giữ cao độ đều hơn nhé!";
  }
  if (weakest === "lyrics") {
    return "Bé đọc chậm lại lời câu này một lần rồi hát lại cho rõ từng tiếng nhé!";
  }
  return "Khá tốt rồi! Bé luyện thêm một lượt ở tốc độ 0.85x sẽ còn hay hơn nữa!";
}

/**
 * Evaluate a child's karaoke performance across Rhythm, Pitch/Melody, Lyrics,
 * and Fluency without conflating unavailable modalities.
 */
export function evaluateMusicalPerformance(
  input: EvaluateMusicalInput,
): MusicalEvaluationResult {
  const practiceMode: KaraokePracticeMode = input.practiceMode ?? "FULL_SONG";
  const headphoneMode = input.headphoneMode ?? false;
  const linesInScope = scopedLines(input.lyrics, input.segmentRange);
  const dsp = input.dspSummary ?? null;
  const liveLyrics = input.liveLyricsScore ?? null;
  const profile = input.referenceProfile ?? null;
  const taps = input.rhythmTapsMs ?? null;

  // Compute global lyrics score strictly when words were evaluated.
  const hasLyricsEvidence =
    liveLyrics !== null && liveLyrics.evaluatedWords > 0;
  const lyricsScore = hasLyricsEvidence
    ? roundScore((100 * liveLyrics!.matchedWords) / liveLyrics!.evaluatedWords)
    : null;

  // Special path: Rhythm Tap practice mode (no microphone required!).
  if (practiceMode === "RHYTHM_TAP") {
    const beatTargets = profile?.beatGridMs?.length
      ? profile.beatGridMs.filter(
          (t) =>
            !input.segmentRange ||
            (t >= input.segmentRange.startMs && t <= input.segmentRange.endMs),
        )
      : linesInScope.flatMap((entry) => expectedOnsetsForLine(entry.line));
    const tapList = taps ?? [];

    if (
      beatTargets.length === 0 ||
      tapList.length < Math.max(2, Math.ceil(beatTargets.length * 0.15))
    ) {
      return {
        scoringMode: "INSUFFICIENT_EVIDENCE",
        scoringModeLabelVi: SCORING_MODE_LABELS_VI.INSUFFICIENT_EVIDENCE,
        practiceMode,
        pitchBasis: "UNAVAILABLE",
        pitchBasisLabelVi: PITCH_BASIS_LABELS_VI.UNAVAILABLE,
        overallScore: null,
        rhythmScore: null,
        pitchScore: null,
        lyricsScore: null,
        fluencyScore: null,
        stars: 0,
        weightsUsed: { rhythm: 0, pitch: 0, lyrics: 0, fluency: 0 },
        activeVocalCoverage: 0,
        voicedCoverage: 0,
        meanCentsError: null,
        meanSignedTimingOffsetMs: null,
        meanAbsTimingErrorMs: null,
        speakerBleedSuspected: false,
        gateReason: "LOW_COVERAGE",
        guidanceVi:
          "Bé hãy nhấn nút Gõ nhịp (hoặc phím Cách) theo từng tiếng chạy trên màn hình nhé!",
        encouragementVi: encouragementForScore(null, "INSUFFICIENT_EVIDENCE"),
        segments: linesInScope.map((entry) => ({
          lineIndex: entry.lineIndex,
          lineId: entry.line.id,
          startMs: entry.startMs,
          endMs: entry.endMs,
          text: entry.line.text,
          rhythmScore: null,
          pitchScore: null,
          lyricsScore: null,
          vocalCoverage: 0,
          lineOverallScore: null,
          status: "PRACTICE",
          tipVi: "Bé thử gõ nhịp đều theo câu này nhé!",
        })),
        weakestSegment: null,
      };
    }

    const rhythmEval = evaluateRhythmAgainstTargets(beatTargets, tapList, null);
    const segments: MusicalSegmentReport[] = linesInScope.map((entry) => {
      const lineTargets = expectedOnsetsForLine(entry.line);
      const lineTaps = tapList.filter(
        (t) => t >= entry.startMs - 300 && t <= entry.endMs + 300,
      );
      const lineRhythm = evaluateRhythmAgainstTargets(
        lineTargets,
        lineTaps,
        null,
      );
      const cov = lineTargets.length
        ? clamp01(lineRhythm.matchedCount / lineTargets.length)
        : 0;
      const lineScore = lineRhythm.score;
      const status: SegmentPracticeStatus =
        lineScore !== null && lineScore >= 80 && cov >= 0.4
          ? "GREAT"
          : lineScore !== null && lineScore >= 58 && cov >= 0.25
            ? "GOOD"
            : "PRACTICE";
      return {
        lineIndex: entry.lineIndex,
        lineId: entry.line.id,
        startMs: entry.startMs,
        endMs: entry.endMs,
        text: entry.line.text,
        rhythmScore: lineScore,
        pitchScore: null,
        lyricsScore: null,
        vocalCoverage: Number(cov.toFixed(3)),
        lineOverallScore: lineScore,
        status,
        tipVi: buildLineTipVi({
          status,
          vocalCoverage: cov,
          rhythmScore: lineScore,
          pitchScore: null,
          lyricsScore: null,
          meanSignedOffsetMs: lineRhythm.meanSignedOffsetMs,
        }),
      };
    });

    const completedLines = segments.filter(
      (s) => s.vocalCoverage >= 0.3,
    ).length;
    const fluencyScore = roundScore(
      (100 * completedLines) / Math.max(1, segments.length),
    );
    const rhythmScore = rhythmEval.score ?? 0;
    const overallScore = roundScore(0.85 * rhythmScore + 0.15 * fluencyScore);
    const weakestSegment = pickWeakestSegment(segments);

    return {
      scoringMode: "RHYTHM_AND_LYRICS",
      scoringModeLabelVi: "Chấm gõ nhịp theo bài hát",
      practiceMode,
      pitchBasis: "UNAVAILABLE",
      pitchBasisLabelVi: PITCH_BASIS_LABELS_VI.UNAVAILABLE,
      overallScore,
      rhythmScore,
      pitchScore: null,
      lyricsScore: null,
      fluencyScore,
      stars: starsForScore(overallScore),
      weightsUsed: { rhythm: 0.85, pitch: 0, lyrics: 0, fluency: 0.15 },
      activeVocalCoverage: Number(
        (
          rhythmEval.matchedCount / Math.max(1, rhythmEval.expectedCount)
        ).toFixed(3),
      ),
      voicedCoverage: 0,
      meanCentsError: null,
      meanSignedTimingOffsetMs: rhythmEval.meanSignedOffsetMs,
      meanAbsTimingErrorMs: rhythmEval.meanAbsErrorMs,
      speakerBleedSuspected: false,
      gateReason: "OK",
      guidanceVi:
        "Chế độ gõ nhịp giúp bé làm quen với tiết tấu bài hát trước khi hát có micro!",
      encouragementVi: encouragementForScore(overallScore, "RHYTHM_AND_LYRICS"),
      segments,
      weakestSegment,
    };
  }

  // Fallback path: No DSP captured at all -> LYRICS_ONLY if ASR evaluated words, else INSUFFICIENT_EVIDENCE.
  if (!dsp || dsp.frameCount === 0) {
    if (!hasLyricsEvidence) {
      return buildInsufficientResult({
        practiceMode,
        headphoneMode,
        linesInScope,
        reason: "SILENCE",
        speakerBleedSuspected: false,
        activeVocalCoverage: 0,
        voicedCoverage: 0,
      });
    }

    const segments: MusicalSegmentReport[] = linesInScope.map((entry) => {
      const lineEv = liveLyrics?.lineScores.find(
        (ls) => ls.lineId === entry.line.id,
      );
      const lineLyrics =
        lineEv && lineEv.evaluatedWords > 0
          ? roundScore((100 * lineEv.matchedWords) / lineEv.evaluatedWords)
          : null;
      const cov =
        lineEv && lineEv.words.length > 0
          ? lineEv.evaluatedWords / lineEv.words.length
          : 0;
      const status: SegmentPracticeStatus =
        lineLyrics !== null && lineLyrics >= 80 && cov >= 0.4
          ? "GREAT"
          : lineLyrics !== null && lineLyrics >= 58 && cov >= 0.25
            ? "GOOD"
            : "PRACTICE";
      return {
        lineIndex: entry.lineIndex,
        lineId: entry.line.id,
        startMs: entry.startMs,
        endMs: entry.endMs,
        text: entry.line.text,
        rhythmScore: null,
        pitchScore: null,
        lyricsScore: lineLyrics,
        vocalCoverage: Number(cov.toFixed(3)),
        lineOverallScore: lineLyrics,
        status,
        tipVi: buildLineTipVi({
          status,
          vocalCoverage: cov,
          rhythmScore: null,
          pitchScore: null,
          lyricsScore: lineLyrics,
          meanSignedOffsetMs: null,
        }),
      };
    });

    const overall = lyricsScore;
    return {
      scoringMode: "LYRICS_ONLY",
      scoringModeLabelVi: SCORING_MODE_LABELS_VI.LYRICS_ONLY,
      practiceMode,
      pitchBasis: "UNAVAILABLE",
      pitchBasisLabelVi: PITCH_BASIS_LABELS_VI.UNAVAILABLE,
      overallScore: overall,
      rhythmScore: null,
      pitchScore: null,
      lyricsScore,
      fluencyScore: null,
      stars: starsForScore(overall),
      weightsUsed: { rhythm: 0, pitch: 0, lyrics: 1, fluency: 0 },
      activeVocalCoverage: Number(
        (
          (liveLyrics?.evaluatedWords ?? 0) /
          Math.max(1, liveLyrics?.totalWords ?? 1)
        ).toFixed(3),
      ),
      voicedCoverage: 0,
      meanCentsError: null,
      meanSignedTimingOffsetMs: null,
      meanAbsTimingErrorMs: null,
      speakerBleedSuspected: false,
      gateReason: "OK",
      guidanceVi:
        "Thiết bị chưa kích hoạt bộ phân tích âm thanh Web Audio, nên lần này hệ thống chỉ chấm lời hát.",
      encouragementVi: encouragementForScore(overall, "LYRICS_ONLY"),
      segments,
      weakestSegment: pickWeakestSegment(segments),
    };
  }

  // Acoustic quality gate check (silence, room noise, 50/60 Hz hum, speaker bleed, <15% coverage).
  const gate = dsp.qualityGate;
  if (!gate.passed) {
    return buildInsufficientResult({
      practiceMode,
      headphoneMode,
      linesInScope,
      reason: gate.reason,
      speakerBleedSuspected: gate.speakerBleedSuspected,
      activeVocalCoverage: gate.activeVocalCoverageRatio,
      voicedCoverage: gate.voicedCoverageRatio,
    });
  }

  // Evaluate Rhythm across all scoped lines.
  const allExpectedOnsets = linesInScope.flatMap((entry) =>
    expectedOnsetsForLine(entry.line),
  );
  const detectedOnsetsMs = dsp.onsets.map((o) => o.timeMs);

  // Measure fraction of active vocal frames that fall inside expected lyric spans.
  const activeFrames = dsp.frames.filter(
    (f) => f.vocalBandRms >= 0.008 && !f.isHumLike,
  );
  const inLyricActiveRatio =
    activeFrames.length > 0
      ? activeFrames.filter((f) => f.inLyricSpan).length / activeFrames.length
      : 0;

  const rhythmEval = evaluateRhythmAgainstTargets(
    allExpectedOnsets,
    detectedOnsetsMs,
    inLyricActiveRatio,
  );

  // Evaluate Pitch strictly on frames inside active lyric spans.
  const lyricFrames = dsp.frames.filter((f) => f.inLyricSpan);
  const voicedInLyrics = lyricFrames.filter((f) => f.voiced);
  const hasReliablePitch =
    voicedInLyrics.length >= 5 && gate.voicedCoverageRatio >= 0.16;

  const referenceContour = profile?.pitchContour ?? [];
  const pitchEval: PitchEval = hasReliablePitch
    ? evaluatePitchForFrames(lyricFrames, referenceContour)
    : { score: null, basis: "UNAVAILABLE", meanCentsError: null };

  // Build per-line timestamped segment reports.
  const segments: MusicalSegmentReport[] = linesInScope.map((entry) => {
    const lineFrames = dsp.frames.filter(
      (f) => f.timeMs >= entry.startMs && f.timeMs <= entry.endMs,
    );
    const lineActiveFrames = lineFrames.filter(
      (f) =>
        f.vocalBandRms >= 0.008 && !f.isHumLike && f.spectralFlatness < 0.4,
    );
    const vocalCoverage =
      lineFrames.length > 0 ? lineActiveFrames.length / lineFrames.length : 0;

    const lineExpected = expectedOnsetsForLine(entry.line);
    const lineDetected = dsp.onsets
      .filter(
        (o) => o.timeMs >= entry.startMs - 380 && o.timeMs <= entry.endMs + 380,
      )
      .map((o) => o.timeMs);
    const lineRhythm =
      vocalCoverage >= 0.12 || lineDetected.length > 0
        ? evaluateRhythmAgainstTargets(
            lineExpected,
            lineDetected,
            vocalCoverage > 0 ? 1 : 0,
          )
        : {
            score: 0,
            meanSignedOffsetMs: null,
            meanAbsErrorMs: null,
            matchedCount: 0,
            expectedCount: lineExpected.length,
          };

    const lineRefContour = referenceContour.filter(
      (p) => p.timeMs >= entry.startMs - 150 && p.timeMs <= entry.endMs + 150,
    );
    const lineVoiced = lineFrames.filter((f) => f.voiced);
    const linePitch =
      hasReliablePitch && lineVoiced.length >= 3
        ? evaluatePitchForFrames(lineFrames, lineRefContour)
        : { score: null, basis: "UNAVAILABLE" as const, meanCentsError: null };

    const lineEv = liveLyrics?.lineScores.find(
      (ls) => ls.lineId === entry.line.id,
    );
    const lineLyrics =
      lineEv && lineEv.evaluatedWords > 0
        ? roundScore((100 * lineEv.matchedWords) / lineEv.evaluatedWords)
        : null;

    // Combine available line metrics honestly.
    let lineWeightSum = 0;
    let lineWeighted = 0;
    if (lineRhythm.score !== null) {
      lineWeighted += lineRhythm.score * 0.45;
      lineWeightSum += 0.45;
    }
    if (linePitch.score !== null) {
      lineWeighted += linePitch.score * 0.35;
      lineWeightSum += 0.35;
    }
    if (lineLyrics !== null) {
      lineWeighted += lineLyrics * 0.2;
      lineWeightSum += 0.2;
    }
    const lineOverall =
      vocalCoverage < 0.12 && (lineLyrics ?? 0) < 20
        ? 0
        : lineWeightSum > 0
          ? roundScore(lineWeighted / lineWeightSum)
          : null;

    const status: SegmentPracticeStatus =
      lineOverall !== null && lineOverall >= 80 && vocalCoverage >= 0.3
        ? "GREAT"
        : lineOverall !== null && lineOverall >= 58 && vocalCoverage >= 0.2
          ? "GOOD"
          : "PRACTICE";

    return {
      lineIndex: entry.lineIndex,
      lineId: entry.line.id,
      startMs: entry.startMs,
      endMs: entry.endMs,
      text: entry.line.text,
      rhythmScore: lineRhythm.score,
      pitchScore: linePitch.score,
      lyricsScore: lineLyrics,
      vocalCoverage: Number(vocalCoverage.toFixed(3)),
      lineOverallScore: lineOverall,
      status,
      tipVi: buildLineTipVi({
        status,
        vocalCoverage,
        rhythmScore: lineRhythm.score,
        pitchScore: linePitch.score,
        lyricsScore: lineLyrics,
        meanSignedOffsetMs: lineRhythm.meanSignedOffsetMs,
      }),
    };
  });

  // Fluency measures how completely and smoothly the child sang across all scoped lines.
  const sungLinesCount = segments.filter((s) => s.vocalCoverage >= 0.28).length;
  const lineCompletionRatio =
    segments.length > 0
      ? sungLinesCount / segments.length
      : gate.activeVocalCoverageRatio;
  const normalizedDuty = Math.min(1, gate.activeVocalCoverageRatio / 0.62);
  const fluencyScore = roundScore(
    100 * (0.6 * lineCompletionRatio + 0.4 * normalizedDuty),
  );

  // Select explicit scoring mode & compute non-conflated overall score.
  let scoringMode: MusicalScoringMode;
  let weightsUsed: MusicalScoreWeights;
  let overallScore: number;

  const rhythmScore = rhythmEval.score ?? 0;
  const pitchScore = pitchEval.score;

  if (pitchScore !== null) {
    scoringMode = "FULL_MUSICAL";
    if (lyricsScore !== null) {
      weightsUsed = { rhythm: 0.4, pitch: 0.3, lyrics: 0.2, fluency: 0.1 };
      overallScore = roundScore(
        0.4 * rhythmScore +
          0.3 * pitchScore +
          0.2 * lyricsScore +
          0.1 * fluencyScore,
      );
    } else {
      // Pure DSP without browser SpeechRecognition: re-normalize 40/30/10 transparently.
      weightsUsed = { rhythm: 0.5, pitch: 0.375, lyrics: 0, fluency: 0.125 };
      overallScore = roundScore(
        0.5 * rhythmScore + 0.375 * pitchScore + 0.125 * fluencyScore,
      );
    }
  } else {
    scoringMode = "RHYTHM_AND_LYRICS";
    if (lyricsScore !== null) {
      weightsUsed = { rhythm: 0.6, pitch: 0, lyrics: 0.3, fluency: 0.1 };
      overallScore = roundScore(
        0.6 * rhythmScore + 0.3 * lyricsScore + 0.1 * fluencyScore,
      );
    } else {
      weightsUsed = { rhythm: 0.85, pitch: 0, lyrics: 0, fluency: 0.15 };
      overallScore = roundScore(0.85 * rhythmScore + 0.15 * fluencyScore);
    }
  }

  // Honest full-song completion scaling: singing only 30% of lines cannot claim
  // a near-perfect full-song score even if the 30% sung portion was accurate.
  if (
    practiceMode === "FULL_SONG" &&
    segments.length >= 2 &&
    lineCompletionRatio < 0.85
  ) {
    const completionScale = 0.45 + 0.55 * (lineCompletionRatio / 0.85);
    overallScore = roundScore(overallScore * completionScale);
  }

  // Mild speaker-bleed flag (still passed gate, but apply honest transparency note).
  const guidanceVi = gate.speakerBleedSuspected
    ? "Có một ít tiếng nhạc loa lọt vào micro. Bé đeo tai nghe sẽ giúp điểm cao độ và nhịp điệu chính xác hơn nữa!"
    : guidanceForGate("OK", headphoneMode);

  return {
    scoringMode,
    scoringModeLabelVi: SCORING_MODE_LABELS_VI[scoringMode],
    practiceMode,
    pitchBasis: pitchEval.basis,
    pitchBasisLabelVi: PITCH_BASIS_LABELS_VI[pitchEval.basis],
    overallScore,
    rhythmScore,
    pitchScore,
    lyricsScore,
    fluencyScore,
    stars: starsForScore(overallScore),
    weightsUsed,
    activeVocalCoverage: gate.activeVocalCoverageRatio,
    voicedCoverage: gate.voicedCoverageRatio,
    meanCentsError: pitchEval.meanCentsError,
    meanSignedTimingOffsetMs: rhythmEval.meanSignedOffsetMs,
    meanAbsTimingErrorMs: rhythmEval.meanAbsErrorMs,
    speakerBleedSuspected: gate.speakerBleedSuspected,
    gateReason: gate.reason,
    guidanceVi,
    encouragementVi: encouragementForScore(overallScore, scoringMode),
    segments,
    weakestSegment: pickWeakestSegment(segments),
  };
}

function pickWeakestSegment(
  segments: readonly MusicalSegmentReport[],
): MusicalSegmentReport | null {
  if (!segments.length) return null;
  let weakest: MusicalSegmentReport | null = null;
  for (const seg of segments) {
    if (!weakest) {
      weakest = seg;
      continue;
    }
    const segPriority =
      seg.status === "PRACTICE" ? 0 : seg.status === "GOOD" ? 1 : 2;
    const weakPriority =
      weakest.status === "PRACTICE" ? 0 : weakest.status === "GOOD" ? 1 : 2;
    if (segPriority < weakPriority) {
      weakest = seg;
      continue;
    }
    if (segPriority === weakPriority) {
      const segVal = seg.lineOverallScore ?? -1;
      const weakVal = weakest.lineOverallScore ?? -1;
      if (segVal < weakVal) weakest = seg;
    }
  }
  return weakest && weakest.status !== "GREAT" ? weakest : null;
}

function buildInsufficientResult(params: {
  practiceMode: KaraokePracticeMode;
  headphoneMode: boolean;
  linesInScope: {
    line: KaraokeLine;
    lineIndex: number;
    startMs: number;
    endMs: number;
  }[];
  reason: AcousticGateReason;
  speakerBleedSuspected: boolean;
  activeVocalCoverage: number;
  voicedCoverage: number;
}): MusicalEvaluationResult {
  return {
    scoringMode: "INSUFFICIENT_EVIDENCE",
    scoringModeLabelVi: SCORING_MODE_LABELS_VI.INSUFFICIENT_EVIDENCE,
    practiceMode: params.practiceMode,
    pitchBasis: "UNAVAILABLE",
    pitchBasisLabelVi: PITCH_BASIS_LABELS_VI.UNAVAILABLE,
    overallScore: null,
    rhythmScore: null,
    pitchScore: null,
    lyricsScore: null,
    fluencyScore: null,
    stars: 0,
    weightsUsed: { rhythm: 0, pitch: 0, lyrics: 0, fluency: 0 },
    activeVocalCoverage: params.activeVocalCoverage,
    voicedCoverage: params.voicedCoverage,
    meanCentsError: null,
    meanSignedTimingOffsetMs: null,
    meanAbsTimingErrorMs: null,
    speakerBleedSuspected: params.speakerBleedSuspected,
    gateReason: params.reason,
    guidanceVi: guidanceForGate(params.reason, params.headphoneMode),
    encouragementVi: encouragementForScore(null, "INSUFFICIENT_EVIDENCE"),
    segments: params.linesInScope.map((entry) => ({
      lineIndex: entry.lineIndex,
      lineId: entry.line.id,
      startMs: entry.startMs,
      endMs: entry.endMs,
      text: entry.line.text,
      rhythmScore: null,
      pitchScore: null,
      lyricsScore: null,
      vocalCoverage: 0,
      lineOverallScore: null,
      status: "PRACTICE",
      tipVi: "Chưa nghe rõ câu này, bé thử lại gần micro hơn nhé!",
    })),
    weakestSegment: null,
  };
}
