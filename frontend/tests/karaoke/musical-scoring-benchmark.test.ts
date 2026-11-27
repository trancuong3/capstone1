/**
 * 12-Scenario Controlled Synthetic PCM Scientific Benchmark for ViRead G07.
 *
 * Pure deterministic math — zero external audio fixtures, zero paid APIs.
 * Evaluates real Web Audio DSP (YIN F0 + spectral-flux onset + quality gate)
 * and honest non-conflated musical scoring across 12 musical & failure scenarios.
 */

import { describe, expect, it } from "vitest";
import {
  MusicalDspAnalyzer,
  type LyricTimeSpan,
} from "@/lib/karaoke/musical-dsp";
import {
  evaluateMusicalPerformance,
  type MusicalEvaluationResult,
  type MusicalProfileData,
  type ReferencePitchPoint,
} from "@/lib/karaoke/musical-scoring";
import type { LiveSingingScore } from "@/lib/karaoke/live-singing-score";
import type { KaraokeLyrics } from "@/types/karaoke";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const HOP_MS = 40; // 25 Hz frame stream

// 10-line, 40-syllable deterministic child song in C major (C4..G4: 261.63–392.00 Hz).
// Each line spans 1600 ms (4 syllables x 360 ms active + 40 ms breath), followed by a 400 ms gap.
const MELODY_NOTES_HZ = [
  [261.63, 293.66, 329.63, 261.63], // C4 D4 E4 C4
  [329.63, 349.23, 392.0, 392.0], // E4 F4 G4 G4
  [392.0, 349.23, 329.63, 293.66], // G4 F4 E4 D4
  [261.63, 329.63, 392.0, 329.63], // C4 E4 G4 E4
  [293.66, 329.63, 349.23, 293.66], // D4 E4 F4 D4
  [329.63, 349.23, 392.0, 349.23], // E4 F4 G4 F4
  [392.0, 329.63, 293.66, 261.63], // G4 E4 D4 C4
  [261.63, 293.66, 329.63, 349.23], // C4 D4 E4 F4
  [392.0, 349.23, 329.63, 293.66], // G4 F4 E4 D4
  [293.66, 329.63, 261.63, 261.63], // D4 E4 C4 C4
];

const LINE_TEXTS = [
  ["Bé", "hát", "vui", "ca"],
  ["Nắng", "mai", "rực", "rỡ"],
  ["Chim", "hót", "trên", "cành"],
  ["Hoa", "cười", "trong", "gió"],
  ["Em", "bước", "tới", "trường"],
  ["Gặp", "bạn", "thân", "yêu"],
  ["Cô", "giáo", "mỉm", "cười"],
  ["Vang", "tiếng", "trống", "vui"],
  ["Cùng", "nhau", "học", "tốt"],
  ["Bé", "hát", "thật", "hay"],
];

interface ScheduledNote {
  lineIndex: number;
  startMs: number;
  endMs: number;
  hz: number;
  text: string;
}

function buildCanonicalSong(): {
  lyrics: KaraokeLyrics;
  notes: ScheduledNote[];
  spans: LyricTimeSpan[];
  profile: MusicalProfileData;
  durationMs: number;
} {
  const notes: ScheduledNote[] = [];
  const spans: LyricTimeSpan[] = [];
  const pitchContour: ReferencePitchPoint[] = [];
  const beatGridMs: number[] = [];

  const lines = LINE_TEXTS.map((words, lineIndex) => {
    // Realistic primary-school song tempo (~100 BPM): 600 ms/syllable (520 ms active + 80 ms breath),
    // 2400 ms per 4-syllable line + 800 ms instrumental gap between lines.
    const lineStart = 800 + lineIndex * 3200;
    const lineEnd = lineStart + 2400;
    spans.push({ startMs: lineStart, endMs: lineEnd });
    const syllables = words.map((text, sylIdx) => {
      const startMs = lineStart + sylIdx * 600;
      const endMs = startMs + 520;
      const hz = MELODY_NOTES_HZ[lineIndex][sylIdx];
      notes.push({ lineIndex, startMs, endMs, hz, text });
      beatGridMs.push(startMs);
      for (let t = startMs + 40; t <= endMs - 40; t += 40) {
        pitchContour.push({ timeMs: t, hz });
      }
      return {
        id: `syl-${lineIndex}-${sylIdx}`,
        text,
        start_ms: startMs,
        end_ms: endMs,
      };
    });
    return {
      id: `line-${lineIndex}`,
      text: words.join(" "),
      start_ms: lineStart,
      end_ms: lineEnd,
      syllables,
    };
  });

  return {
    lyrics: { format_version: 2, lines },
    notes,
    spans,
    profile: {
      bpm: 100,
      audioType: "DUAL_TRACK",
      hasPitchContour: true,
      hasBeatGrid: true,
      sourceMethod: "AUDIO_DSP",
      beatGridMs,
      pitchContour,
    },
    durationMs: 800 + LINE_TEXTS.length * 3200 + 600,
  };
}

/** Deterministic pseudo-random generator in [-1, 1] for reproducible benchmarks. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

function buildLyricsEvidence(
  lyrics: KaraokeLyrics,
  lineAccuracy: (lineIndex: number) => number,
): LiveSingingScore {
  let matchedWords = 0;
  let evaluatedWords = 0;
  let totalWords = 0;
  const lineScores = lyrics.lines.map((line, lineIndex) => {
    const acc = lineAccuracy(lineIndex);
    const syls = line.syllables ?? [];
    const words = syls.map((s, idx) => {
      totalWords++;
      if (acc < 0) {
        return {
          id: `${s.id}/0`,
          syllableId: s.id,
          text: s.text.toLowerCase(),
          state: "unknown" as const,
        };
      }
      evaluatedWords++;
      const matched = idx / Math.max(1, syls.length) < acc;
      if (matched) matchedWords++;
      return {
        id: `${s.id}/0`,
        syllableId: s.id,
        text: s.text.toLowerCase(),
        state: matched ? ("matched" as const) : ("different" as const),
      };
    });
    return {
      lineIndex,
      lineId: line.id,
      lineText: line.text,
      words,
      matchedWords: words.filter((w) => w.state === "matched").length,
      evaluatedWords: words.filter((w) => w.state !== "unknown").length,
    };
  });
  return {
    kind:
      evaluatedWords === 0
        ? "insufficient"
        : evaluatedWords >= totalWords * 0.8
          ? "whole"
          : "partial",
    overallAccuracy:
      evaluatedWords > 0
        ? Math.round((100 * matchedWords) / evaluatedWords)
        : null,
    matchedWords,
    evaluatedWords,
    totalWords,
    lineScores,
  };
}

interface SynthesisParams {
  pitchShiftCents?: number | ((noteIdx: number) => number);
  timingOffsetMs?: number;
  activeLineIndices?: Set<number>;
  monotoneSpoken?: boolean;
  amplitude?: number;
  noiseLevel?: number;
  seed?: number;
}

/** Synthesize continuous harmonic singing PCM frames aligned to song clock. */
function runMelodicSynthesis(
  song: ReturnType<typeof buildCanonicalSong>,
  params: SynthesisParams,
  options: {
    headphoneMode?: boolean;
    withReferenceContour?: boolean;
    lyricsAcc?: (i: number) => number;
  } = {},
): MusicalEvaluationResult {
  const analyzer = new MusicalDspAnalyzer({
    sampleRate: SAMPLE_RATE,
    frameSize: FRAME_SIZE,
    lyricSpans: song.spans,
    headphoneMode: options.headphoneMode ?? true,
  });
  const rng = makeRng(params.seed ?? 42);
  const amp = params.amplitude ?? 0.24;
  const noiseLevel = params.noiseLevel ?? 0.002;
  const timingOffset = params.timingOffsetMs ?? 0;
  const frameBuf = new Float32Array(FRAME_SIZE);

  // Build shifted/filtered active notes.
  const shiftedNotes = song.notes
    .map((n, idx) => {
      if (
        params.activeLineIndices &&
        !params.activeLineIndices.has(n.lineIndex)
      ) {
        return null;
      }
      if (params.monotoneSpoken) {
        // Rapid clipped spoken syllables around flat ~198 Hz with uneven spoken cadence.
        const spokenStart = n.startMs + ((idx % 3) - 1) * 140;
        return {
          startMs: spokenStart,
          endMs: spokenStart + 180, // Short clipped speech bursts vs 360ms sustained singing
          hz: 198 + ((idx % 2) * 2 - 1) * 1.5, // Essentially flat monotone (< 0.25 semitone spread)
          spoken: true,
        };
      }
      const cents =
        typeof params.pitchShiftCents === "function"
          ? params.pitchShiftCents(idx)
          : (params.pitchShiftCents ?? 0);
      return {
        startMs: n.startMs + timingOffset,
        endMs: n.endMs + timingOffset,
        hz: n.hz * Math.pow(2, cents / 1200),
        spoken: false,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  for (let frameMs = 0; frameMs <= song.durationMs; frameMs += HOP_MS) {
    frameBuf.fill(0);
    const active = shiftedNotes.find(
      (n) => frameMs >= n.startMs && frameMs < n.endMs,
    );

    for (let i = 0; i < FRAME_SIZE; i++) {
      const sampleSec = frameMs / 1000 + i / SAMPLE_RATE;
      const sampleMs = sampleSec * 1000;
      let val = rng() * noiseLevel;

      if (active && sampleMs >= active.startMs && sampleMs <= active.endMs) {
        const localMs = sampleMs - active.startMs;
        const durMs = active.endMs - active.startMs;
        // Smooth attack (20 ms) & release (25 ms) envelope.
        const env =
          localMs < 20
            ? localMs / 20
            : localMs > durMs - 25
              ? Math.max(0, (durMs - localMs) / 25)
              : 1;

        if (active.spoken) {
          // Flat monotone spoken reading: weak periodic fundamental + heavy unpitched aspiration/consonant noise.
          const freq = active.hz;
          val +=
            amp *
            env *
            (0.28 * Math.sin(2 * Math.PI * freq * sampleSec) +
              0.12 * Math.sin(2 * Math.PI * 2 * freq * sampleSec) +
              0.38 * rng());
        } else {
          // Singing: sustained resonant harmonic vocal with true phase-integrated
          // gentle vibrato (±6 cents @ 5.2 Hz).
          const f0 = active.hz;
          const vibPhase =
            ((f0 * 0.0035) / 5.2) * Math.sin(2 * Math.PI * 5.2 * sampleSec);
          const basePhase = 2 * Math.PI * f0 * sampleSec + vibPhase;
          val +=
            amp *
            env *
            (0.54 * Math.sin(basePhase) +
              0.27 * Math.sin(2 * basePhase + 0.25) +
              0.13 * Math.sin(3 * basePhase + 0.6) +
              0.06 * Math.sin(4 * basePhase + 1.0));
        }
      }
      frameBuf[i] = val;
    }

    analyzer.processFrame(frameBuf, frameMs);
  }

  const dspSummary = analyzer.summarize();
  const refProfile =
    options.withReferenceContour === false
      ? { ...song.profile, hasPitchContour: false, pitchContour: [] }
      : song.profile;

  const liveLyricsScore = options.lyricsAcc
    ? buildLyricsEvidence(song.lyrics, options.lyricsAcc)
    : null;

  return evaluateMusicalPerformance({
    lyrics: song.lyrics,
    dspSummary,
    liveLyricsScore,
    referenceProfile: refProfile,
    practiceMode: "FULL_SONG",
    headphoneMode: options.headphoneMode ?? true,
  });
}

function runRawSignalScenario(
  song: ReturnType<typeof buildCanonicalSong>,
  generator: (
    sampleIndex: number,
    frameMs: number,
    rng: () => number,
  ) => number,
  options: { headphoneMode?: boolean; seed?: number } = {},
): MusicalEvaluationResult {
  const analyzer = new MusicalDspAnalyzer({
    sampleRate: SAMPLE_RATE,
    frameSize: FRAME_SIZE,
    lyricSpans: song.spans,
    headphoneMode: options.headphoneMode ?? false,
  });
  const rng = makeRng(options.seed ?? 99);
  const frameBuf = new Float32Array(FRAME_SIZE);

  for (let frameMs = 0; frameMs <= song.durationMs; frameMs += HOP_MS) {
    const baseSample = Math.round((frameMs / 1000) * SAMPLE_RATE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      frameBuf[i] = generator(baseSample + i, frameMs, rng);
    }
    analyzer.processFrame(frameBuf, frameMs);
  }

  return evaluateMusicalPerformance({
    lyrics: song.lyrics,
    dspSummary: analyzer.summarize(),
    liveLyricsScore: null,
    referenceProfile: song.profile,
    practiceMode: "FULL_SONG",
    headphoneMode: options.headphoneMode ?? false,
  });
}

export interface BenchmarkScenarioReport {
  id: number;
  key: string;
  name: string;
  scoringMode: string;
  pitchBasis: string;
  overallScore: number | null;
  rhythmScore: number | null;
  pitchScore: number | null;
  lyricsScore: number | null;
  fluencyScore: number | null;
  stars: number;
  meanCentsError: number | null;
  meanSignedTimingOffsetMs: number | null;
  activeVocalCoverage: number;
  speakerBleedSuspected: boolean;
  gateReason: string;
  practiceSegmentsCount: number;
}

export function runAll12BenchmarkScenarios(): {
  results: Record<string, MusicalEvaluationResult>;
  report: BenchmarkScenarioReport[];
} {
  const song = buildCanonicalSong();
  const allLyricsMatched = () => 1.0;

  // 1. In-tune & in-time child singing (C4–G4, 262–392 Hz)
  const s1 = runMelodicSynthesis(
    song,
    { pitchShiftCents: 0, timingOffsetMs: 0, seed: 101 },
    { headphoneMode: true, lyricsAcc: allLyricsMatched },
  );

  // 2. Octave-shifted singing (+1 octave, 523–784 Hz)
  const s2 = runMelodicSynthesis(
    song,
    { pitchShiftCents: 1200, timingOffsetMs: 0, seed: 102 },
    { headphoneMode: true, lyricsAcc: allLyricsMatched },
  );

  // 3. Slightly sharp/flat singing (~35 cents)
  const s3 = runMelodicSynthesis(
    song,
    {
      pitchShiftCents: (idx) => (idx % 2 === 0 ? 35 : -35),
      timingOffsetMs: 0,
      seed: 103,
    },
    { headphoneMode: true, lyricsAcc: allLyricsMatched },
  );

  // 4. Badly off-pitch singing (±350 cents)
  const s4 = runMelodicSynthesis(
    song,
    {
      pitchShiftCents: (idx) => (idx % 2 === 0 ? 350 : -350),
      timingOffsetMs: 0,
      seed: 104,
    },
    { headphoneMode: true, lyricsAcc: allLyricsMatched },
  );

  // 5. Rhythmically delayed singing (+350 ms lag)
  const s5 = runMelodicSynthesis(
    song,
    { pitchShiftCents: 0, timingOffsetMs: 350, seed: 105 },
    { headphoneMode: true, lyricsAcc: allLyricsMatched },
  );

  // 6. Rhythmically rushed singing (-300 ms early)
  const s6 = runMelodicSynthesis(
    song,
    { pitchShiftCents: 0, timingOffsetMs: -300, seed: 106 },
    { headphoneMode: true, lyricsAcc: allLyricsMatched },
  );

  // 7. Flat monotone spoken reading (even when lyrics text matches!)
  const s7 = runMelodicSynthesis(
    song,
    { monotoneSpoken: true, seed: 107 },
    { headphoneMode: true, lyricsAcc: allLyricsMatched },
  );

  // 8. Pure silence
  const s8 = runRawSignalScenario(song, () => 0, {
    headphoneMode: false,
    seed: 108,
  });

  // 9. White / pink room noise
  let pinkB0 = 0;
  let pinkB1 = 0;
  let pinkB2 = 0;
  const s9 = runRawSignalScenario(
    song,
    (_sampleIdx, _ms, rng) => {
      const white = rng();
      pinkB0 = 0.997 * pinkB0 + white * 0.029;
      pinkB1 = 0.985 * pinkB1 + white * 0.032;
      pinkB2 = 0.95 * pinkB2 + white * 0.048;
      return 0.05 * (0.55 * white + 0.45 * (pinkB0 + pinkB1 + pinkB2));
    },
    { headphoneMode: false, seed: 109 },
  );

  // 10. Constant electrical hum (50 Hz + 60 Hz)
  const s10 = runRawSignalScenario(
    song,
    (sampleIdx) => {
      const t = sampleIdx / SAMPLE_RATE;
      return (
        0.09 * Math.sin(2 * Math.PI * 50 * t) +
        0.06 * Math.sin(2 * Math.PI * 60 * t) +
        0.015 * Math.sin(2 * Math.PI * 100 * t)
      );
    },
    { headphoneMode: false, seed: 110 },
  );

  // 11. Speaker bleed simulation (low-SNR constant polyphonic backing chord bed across lyrics & gaps)
  const s11 = runRawSignalScenario(
    song,
    (sampleIdx, _ms, rng) => {
      const t = sampleIdx / SAMPLE_RATE;
      // Continuous low-level backing music (C-E-G-B polyphonic chord + soft percussion haze)
      // with zero lyric-vs-gap vocal modulation.
      return (
        0.014 * Math.sin(2 * Math.PI * 261.63 * t) +
        0.013 * Math.sin(2 * Math.PI * 329.63 * t) +
        0.012 * Math.sin(2 * Math.PI * 392.0 * t) +
        0.011 * Math.sin(2 * Math.PI * 493.88 * t) +
        0.01 * Math.sin(2 * Math.PI * 659.25 * t) +
        0.012 * rng()
      );
    },
    { headphoneMode: false, seed: 111 },
  );

  // 12. Partial singing (only 30% of lines sung = first 3 of 10 lines)
  const s12 = runMelodicSynthesis(
    song,
    {
      pitchShiftCents: 0,
      timingOffsetMs: 0,
      activeLineIndices: new Set([0, 1, 2]),
      seed: 112,
    },
    {
      headphoneMode: true,
      lyricsAcc: (lineIndex) => (lineIndex < 3 ? 1.0 : -1),
    },
  );

  const pairs: [number, string, string, MusicalEvaluationResult][] = [
    [
      1,
      "in_tune_in_time_child_singing",
      "In-tune & in-time child singing (C4–G4)",
      s1,
    ],
    [
      2,
      "octave_shifted_plus_one",
      "Octave-shifted singing (+1 octave, C5–G5)",
      s2,
    ],
    [
      3,
      "slightly_sharp_flat_35_cents",
      "Slightly sharp/flat singing (±35 cents)",
      s3,
    ],
    [
      4,
      "badly_off_pitch_350_cents",
      "Badly off-pitch singing (±350 cents)",
      s4,
    ],
    [
      5,
      "rhythm_delayed_plus_350ms",
      "Rhythmically delayed singing (+350 ms lag)",
      s5,
    ],
    [
      6,
      "rhythm_rushed_minus_300ms",
      "Rhythmically rushed singing (-300 ms early)",
      s6,
    ],
    [7, "flat_monotone_spoken_reading", "Flat monotone spoken reading", s7],
    [8, "pure_silence", "Pure silence", s8],
    [9, "white_pink_room_noise", "White/pink room noise", s9],
    [
      10,
      "constant_electrical_hum_50_60hz",
      "Constant electrical hum (50/60 Hz)",
      s10,
    ],
    [
      11,
      "speaker_bleed_low_snr_backing",
      "Speaker bleed (low-SNR constant backing)",
      s11,
    ],
    [
      12,
      "partial_singing_30_percent",
      "Partial singing (30% of lines sung)",
      s12,
    ],
  ];

  const results: Record<string, MusicalEvaluationResult> = {};
  const report: BenchmarkScenarioReport[] = [];
  for (const [id, key, name, res] of pairs) {
    results[key] = res;
    report.push({
      id,
      key,
      name,
      scoringMode: res.scoringMode,
      pitchBasis: res.pitchBasis,
      overallScore: res.overallScore,
      rhythmScore: res.rhythmScore,
      pitchScore: res.pitchScore,
      lyricsScore: res.lyricsScore,
      fluencyScore: res.fluencyScore,
      stars: res.stars,
      meanCentsError: res.meanCentsError,
      meanSignedTimingOffsetMs: res.meanSignedTimingOffsetMs,
      activeVocalCoverage: res.activeVocalCoverage,
      speakerBleedSuspected: res.speakerBleedSuspected,
      gateReason: res.gateReason,
      practiceSegmentsCount: res.segments.filter(
        (seg) => seg.status === "PRACTICE",
      ).length,
    });
  }

  return { results, report };
}

describe("12-scenario synthetic PCM musical karaoke scientific benchmark", () => {
  const { results, report } = runAll12BenchmarkScenarios();

  it("Scenario 1 & 2: in-tune child singing scores high and +1 octave is invariant", () => {
    const s1 = results.in_tune_in_time_child_singing;
    const s2 = results.octave_shifted_plus_one;

    expect(s1.scoringMode).toBe("FULL_MUSICAL");
    expect(s1.overallScore!).toBeGreaterThanOrEqual(90);
    expect(s1.rhythmScore!).toBeGreaterThanOrEqual(88);
    expect(s1.pitchScore!).toBeGreaterThanOrEqual(92);
    expect(s1.fluencyScore!).toBeGreaterThanOrEqual(90);
    expect(s1.stars).toBe(3);

    expect(s2.scoringMode).toBe("FULL_MUSICAL");
    expect(Math.abs(s2.pitchScore! - s1.pitchScore!)).toBeLessThanOrEqual(5);
    expect(Math.abs(s2.overallScore! - s1.overallScore!)).toBeLessThanOrEqual(
      5,
    );
    expect(s2.stars).toBe(3);
  });

  it("Scenario 3 & 4: distinguishes slight ±35 cents drift from badly off-pitch ±350 cents", () => {
    const s1 = results.in_tune_in_time_child_singing;
    const s3 = results.slightly_sharp_flat_35_cents;
    const s4 = results.badly_off_pitch_350_cents;

    expect(s3.scoringMode).toBe("FULL_MUSICAL");
    expect(s3.pitchScore!).toBeLessThan(s1.pitchScore!);
    expect(s3.pitchScore!).toBeGreaterThanOrEqual(80);
    expect(s3.meanCentsError!).toBeGreaterThanOrEqual(20);
    expect(s3.meanCentsError!).toBeLessThanOrEqual(55);

    expect(s4.scoringMode).toBe("FULL_MUSICAL");
    expect(s4.pitchScore!).toBeLessThanOrEqual(30);
    expect(s4.meanCentsError!).toBeGreaterThanOrEqual(280);
    expect(s4.overallScore!).toBeLessThanOrEqual(s1.overallScore! - 20);
  });

  it("Scenario 5 & 6: penalizes +350ms delayed and -300ms rushed singing on rhythm", () => {
    const s1 = results.in_tune_in_time_child_singing;
    const s5 = results.rhythm_delayed_plus_350ms;
    const s6 = results.rhythm_rushed_minus_300ms;

    expect(s5.scoringMode).toBe("FULL_MUSICAL");
    expect(s5.rhythmScore!).toBeLessThanOrEqual(s1.rhythmScore! - 35);
    expect(s5.meanSignedTimingOffsetMs!).toBeGreaterThanOrEqual(220);
    expect(s5.overallScore!).toBeLessThanOrEqual(s1.overallScore! - 15);

    expect(s6.scoringMode).toBe("FULL_MUSICAL");
    expect(s6.rhythmScore!).toBeLessThanOrEqual(s1.rhythmScore! - 30);
    expect(s6.meanSignedTimingOffsetMs!).toBeLessThanOrEqual(-180);
    expect(s6.overallScore!).toBeLessThanOrEqual(s1.overallScore! - 12);
  });

  it("Scenario 7 (Anti-Gaming): flat monotone spoken reading scores far lower than melodic singing (both with & without reference contour)", () => {
    const s1 = results.in_tune_in_time_child_singing;
    const s7 = results.flat_monotone_spoken_reading;

    expect(s7.overallScore).not.toBeNull();
    expect(s7.overallScore!).toBeLessThanOrEqual(s1.overallScore! - 25);
    if (s7.pitchScore !== null) {
      expect(s7.pitchScore).toBeLessThanOrEqual(38);
    }

    // Also verify anti-gaming without a reference melody contour!
    const song = buildCanonicalSong();
    const singingNoRef = runMelodicSynthesis(
      song,
      { pitchShiftCents: 0, timingOffsetMs: 0, seed: 201 },
      {
        headphoneMode: true,
        withReferenceContour: false,
        lyricsAcc: () => 1.0,
      },
    );
    const flatDroneNoRef = runMelodicSynthesis(
      song,
      {
        pitchShiftCents: (idx) => {
          // Force every note onto a single flat 220 Hz monotone drone.
          const targetHz = song.notes[idx].hz;
          return 1200 * Math.log2(220 / targetHz);
        },
        timingOffsetMs: 0,
        seed: 202,
      },
      {
        headphoneMode: true,
        withReferenceContour: false,
        lyricsAcc: () => 1.0,
      },
    );
    expect(singingNoRef.pitchBasis).toBe("VOCAL_STEADINESS_AND_CONTOUR");
    expect(flatDroneNoRef.pitchBasis).toBe("VOCAL_STEADINESS_AND_CONTOUR");
    expect(singingNoRef.pitchScore!).toBeGreaterThanOrEqual(75);
    expect(flatDroneNoRef.pitchScore!).toBeLessThanOrEqual(35);
    expect(flatDroneNoRef.overallScore!).toBeLessThanOrEqual(
      singingNoRef.overallScore! - 12,
    );
  });

  it("Scenarios 8, 9, 10: silence, white/pink room noise, and 50/60Hz hum return INSUFFICIENT_EVIDENCE", () => {
    for (const [key, expectedReason] of [
      ["pure_silence", "SILENCE"],
      ["white_pink_room_noise", "NOISE_ONLY"],
      ["constant_electrical_hum_50_60hz", "ELECTRICAL_HUM"],
    ] as const) {
      const res = results[key];
      expect(res.scoringMode).toBe("INSUFFICIENT_EVIDENCE");
      expect(res.overallScore).toBeNull();
      expect(res.rhythmScore).toBeNull();
      expect(res.pitchScore).toBeNull();
      expect(res.stars).toBe(0);
      expect(res.gateReason).toBe(expectedReason);
    }
  });

  it("Scenario 11: constant low-SNR speaker bleed is flagged and downgraded", () => {
    const s11 = results.speaker_bleed_low_snr_backing;
    expect(s11.speakerBleedSuspected).toBe(true);
    expect(s11.scoringMode).toBe("INSUFFICIENT_EVIDENCE");
    expect(s11.gateReason).toBe("SPEAKER_BLEED");
    expect(s11.overallScore).toBeNull();
  });

  it("Scenario 12: partial singing (30% of lines) lowers fluency proportionally and flags missed lines in segment report", () => {
    const s1 = results.in_tune_in_time_child_singing;
    const s12 = results.partial_singing_30_percent;

    expect(s12.scoringMode).toBe("FULL_MUSICAL");
    expect(s12.fluencyScore!).toBeLessThanOrEqual(45);
    expect(s12.rhythmScore!).toBeLessThanOrEqual(55);
    expect(s12.overallScore!).toBeLessThanOrEqual(s1.overallScore! - 28);

    // First 3 lines sung -> GREAT/GOOD; remaining 7 lines missed -> PRACTICE.
    expect(
      s12.segments.slice(0, 3).every((seg) => seg.status !== "PRACTICE"),
    ).toBe(true);
    expect(
      s12.segments.slice(3).every((seg) => seg.status === "PRACTICE"),
    ).toBe(true);
    expect(s12.weakestSegment).not.toBeNull();
    expect(s12.weakestSegment!.lineIndex).toBeGreaterThanOrEqual(3);
  });

  it("emits complete 12-scenario structured benchmark metrics", () => {
    expect(report).toHaveLength(12);
    if (process.env.PRINT_KARAOKE_BENCHMARK === "1") {
      console.log("KARAOKE_BENCHMARK_JSON=" + JSON.stringify(report));
    }
  });
});
