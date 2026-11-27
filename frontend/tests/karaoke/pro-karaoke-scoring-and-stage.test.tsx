import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KaraokeScoreCard } from "@/components/karaoke/karaoke-score-card";
import { PitchHighwayCanvas } from "@/components/karaoke/pitch-highway-canvas";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { useKaraokeScoring } from "@/hooks/use-karaoke-scoring";
import type { LiveSingingScore } from "@/lib/karaoke/live-singing-score";
import {
  midiToHz,
  MusicalDspAnalyzer,
  RealtimePitchSmoother,
  type DspSessionSummary,
  type LyricTimeSpan,
} from "@/lib/karaoke/musical-dsp";
import {
  evaluateLivePitchJudgement,
  evaluateProKaraokePerformance,
  gradeOnsetDeltaMs,
  gradePitchCents,
  resolveTargetNotes,
} from "@/lib/karaoke/pro-karaoke-scoring";
import { previewDetail, syllableLyrics } from "@/test/karaoke-fixtures";
import type { KaraokeLyrics, KaraokeMelodyProfile } from "@/types/karaoke";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const HOP_MS = 40;

const SONG_MIDIS = [
  [60, 62, 64, 60], // C4 D4 E4 C4
  [64, 65, 67, 67], // E4 F4 G4 G4
  [67, 65, 64, 62], // G4 F4 E4 D4
  [60, 64, 67, 72], // C4 E4 G4 C5
];
const SONG_WORDS = [
  ["Bé", "hát", "vui", "ca"],
  ["Nắng", "mai", "rực", "rỡ"],
  ["Chim", "hót", "trên", "cành"],
  ["Hoa", "cười", "trong", "nắng"],
];

function buildTestSong(): {
  lyrics: KaraokeLyrics;
  melodyProfile: KaraokeMelodyProfile;
  spans: LyricTimeSpan[];
  durationMs: number;
  notes: { startMs: number; endMs: number; midi: number; text: string }[];
} {
  const spans: LyricTimeSpan[] = [];
  const notes: { startMs: number; endMs: number; midi: number; text: string }[] =
    [];
  const profileNotes: KaraokeMelodyProfile["notes"] = [];
  const pitchContour: KaraokeMelodyProfile["pitch_contour"] = [];

  const lines = SONG_WORDS.map((words, li) => {
    const lineStart = 800 + li * 3000;
    const lineEnd = lineStart + 2400;
    spans.push({ startMs: lineStart, endMs: lineEnd });
    const syllables = words.map((text, si) => {
      const startMs = lineStart + si * 600;
      const endMs = startMs + 500;
      const midi = SONG_MIDIS[li][si];
      const hz = Number(midiToHz(midi).toFixed(2));
      const sylId = `syl-${li}-${si}`;
      notes.push({ startMs, endMs, midi, text });
      profileNotes.push({
        start_ms: startMs,
        end_ms: endMs,
        midi,
        hz,
        confidence: 0.94,
        voiced: true,
        syllable_id: sylId,
        line_id: `line-${li}`,
        text,
      });
      for (let t = startMs + 40; t <= endMs - 40; t += 40) {
        pitchContour.push({ time_ms: t, hz, midi, confidence: 0.94 });
      }
      return { id: sylId, text, start_ms: startMs, end_ms: endMs };
    });
    return {
      id: `line-${li}`,
      text: words.join(" "),
      start_ms: lineStart,
      end_ms: lineEnd,
      syllables,
    };
  });

  const durationMs = 800 + SONG_WORDS.length * 3000 + 600;
  return {
    lyrics: { format_version: 2, lines },
    melodyProfile: {
      melody_version: 1,
      hop_ms: 40,
      duration_ms: durationMs,
      min_midi: 60,
      max_midi: 72,
      median_midi: 64,
      bpm: 100,
      notes: profileNotes,
      pitch_contour: pitchContour,
    },
    spans,
    durationMs,
    notes,
  };
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

function synthesizePerformanceDsp(
  song: ReturnType<typeof buildTestSong>,
  options: {
    mode:
      | "exact"
      | "octave_up"
      | "shifted_plus2"
      | "off_pitch"
      | "monotone"
      | "late_300ms"
      | "early_300ms"
      | "silence"
      | "white_noise";
    micLatencyMs?: number;
  },
): DspSessionSummary {
  const analyzer = new MusicalDspAnalyzer({
    sampleRate: SAMPLE_RATE,
    frameSize: FRAME_SIZE,
    lyricSpans: song.spans,
    headphoneMode: true,
    micLatencyMs: options.micLatencyMs ?? 0,
  });
  const rng = makeRng(777);
  const frame = new Float32Array(FRAME_SIZE);
  const timingShiftMs =
    options.mode === "late_300ms"
      ? 290
      : options.mode === "early_300ms"
        ? -290
        : 0;

  for (let tMs = 0; tMs <= song.durationMs; tMs += HOP_MS) {
    frame.fill(0);
    if (options.mode === "silence") {
      analyzer.processFrame(frame, tMs);
      continue;
    }
    if (options.mode === "white_noise") {
      for (let i = 0; i < FRAME_SIZE; i++) frame[i] = rng() * 0.15;
      analyzer.processFrame(frame, tMs);
      continue;
    }

    const active = song.notes.find(
      (n) => tMs >= n.startMs + timingShiftMs && tMs <= n.endMs + timingShiftMs,
    );
    if (active) {
      let targetMidi = active.midi;
      if (options.mode === "octave_up") targetMidi += 12;
      else if (options.mode === "shifted_plus2") targetMidi += 2;
      else if (options.mode === "off_pitch") targetMidi += 2.6; // +260 cents
      else if (options.mode === "monotone") targetMidi = 57.2; // flat speaking A3

      const hz = midiToHz(targetMidi);
      const t0 = tMs / 1000;
      for (let i = 0; i < FRAME_SIZE; i++) {
        const sec = t0 + i / SAMPLE_RATE;
        frame[i] =
          0.32 * Math.sin(2 * Math.PI * hz * sec) +
          0.11 * Math.sin(2 * Math.PI * 2 * hz * sec) +
          0.04 * Math.sin(2 * Math.PI * 3 * hz * sec) +
          rng() * 0.002;
      }
    } else {
      for (let i = 0; i < FRAME_SIZE; i++) frame[i] = rng() * 0.0008;
    }
    analyzer.processFrame(frame, tMs);
  }
  return analyzer.summarize();
}

function buildPerfectLyricsScore(lyrics: KaraokeLyrics): LiveSingingScore {
  const lineScores = lyrics.lines.map((line, lineIndex) => {
    const words = (line.syllables ?? []).map((s) => ({
      id: `${s.id}/0`,
      syllableId: s.id,
      text: s.text.toLowerCase(),
      state: "matched" as const,
    }));
    return {
      lineId: line.id,
      lineIndex,
      lineText: line.text,
      matchedWords: words.length,
      evaluatedWords: words.length,
      totalWords: words.length,
      words,
    };
  });
  const total = lineScores.reduce((acc, l) => acc + l.totalWords, 0);
  return {
    kind: "whole",
    overallAccuracy: 100,
    matchedWords: total,
    evaluatedWords: total,
    totalWords: total,
    lineScores,
  };
}

describe("Pro Karaoke 3-Pillar Synthetic DSP & Honest Scoring Engine", () => {
  it("grades exact pitch cents and onset delta thresholds cleanly", () => {
    expect(gradePitchCents(20)).toEqual({ credit: 1, judgement: "perfect" });
    expect(gradePitchCents(35)).toEqual({ credit: 1, judgement: "perfect" });
    expect(gradePitchCents(60)).toEqual({ credit: 0.8, judgement: "great" });
    expect(gradePitchCents(110)).toEqual({ credit: 0.5, judgement: "good" });
    expect(gradePitchCents(300).credit).toBe(0);

    expect(gradeOnsetDeltaMs(50)).toEqual({ credit: 1, tier: "perfect" });
    expect(gradeOnsetDeltaMs(140)).toEqual({ credit: 0.8, tier: "great" });
    expect(gradeOnsetDeltaMs(220)).toEqual({ credit: 0.5, tier: "good" });
    expect(gradeOnsetDeltaMs(310)).toEqual({ credit: 0, tier: "miss" });
  });

  it("scores >= 90 (Rank S/A+, 5 stars) for exact pitch + on-beat + exact lyrics", () => {
    const song = buildTestSong();
    const dsp = synthesizePerformanceDsp(song, { mode: "exact" });
    const lyricsScore = buildPerfectLyricsScore(song.lyrics);

    const res = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      liveLyricsScore: lyricsScore,
      melodyProfile: song.melodyProfile,
    });

    expect(res.kind).toBe("scored");
    expect(res.activePillars).toEqual({ pitch: true, rhythm: true, lyrics: true });
    expect(res.totalScore).toBeGreaterThanOrEqual(92);
    expect(res.pitchScore).toBeGreaterThanOrEqual(92);
    expect(res.rhythmScore).toBeGreaterThanOrEqual(88);
    expect(res.lyricsScore).toBe(100);
    expect(res.rank).toBe("S");
    expect(res.stars).toBe(5);
    expect(res.maxCombo).toBeGreaterThanOrEqual(4);
    expect(res.timingBias).toBe("on_beat");
  });

  it("uses smart octave-folding so a child singing +12 semitones higher scores high on Pitch", () => {
    const song = buildTestSong();
    const dsp = synthesizePerformanceDsp(song, { mode: "octave_up" });
    const lyricsScore = buildPerfectLyricsScore(song.lyrics);

    const res = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      liveLyricsScore: lyricsScore,
      melodyProfile: song.melodyProfile,
    });

    expect(res.kind).toBe("scored");
    expect(res.pitchScore).toBeGreaterThanOrEqual(90);
    expect(res.totalScore).toBeGreaterThanOrEqual(90);
  });

  it("syncs target MIDI automatically when Key Shift (+2 semitones) is enabled", () => {
    const song = buildTestSong();
    const dsp = synthesizePerformanceDsp(song, { mode: "shifted_plus2" });

    // Without keyShift -> detects constant +2 semitone transposition and suggests +2!
    const unshifted = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      melodyProfile: song.melodyProfile,
      keyShift: 0,
    });
    expect(unshifted.pitchScore).toBeLessThan(35);
    expect(unshifted.suggestedKeyShift).toBe(2);
    expect(unshifted.relativeMelodyScore).toBeGreaterThanOrEqual(90);

    // With keyShift = +2 -> scores >= 90!
    const shifted = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      melodyProfile: song.melodyProfile,
      keyShift: 2,
    });
    expect(shifted.pitchScore).toBeGreaterThanOrEqual(90);
  });

  it("sharply penalizes off-pitch (+260c) and monotone recitation even when lyrics are 100%", () => {
    const song = buildTestSong();
    const lyricsScore = buildPerfectLyricsScore(song.lyrics);

    const offPitch = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: synthesizePerformanceDsp(song, { mode: "off_pitch" }),
      liveLyricsScore: lyricsScore,
      melodyProfile: song.melodyProfile,
    });
    expect(offPitch.lyricsScore).toBe(100);
    expect(offPitch.pitchScore).toBeLessThan(20);
    expect(offPitch.totalScore!).toBeLessThan(65);

    const monotone = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: synthesizePerformanceDsp(song, { mode: "monotone" }),
      liveLyricsScore: lyricsScore,
      melodyProfile: song.melodyProfile,
    });
    expect(monotone.lyricsScore).toBe(100);
    expect(monotone.pitchScore).toBeLessThan(35);
  });

  it("detects +290ms late and -290ms early singing accurately and drops Rhythm score", () => {
    const song = buildTestSong();

    const late = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: synthesizePerformanceDsp(song, { mode: "late_300ms" }),
      melodyProfile: song.melodyProfile,
    });
    expect(late.rhythmScore).toBeLessThan(55);
    expect(late.timingBias).toBe("late");
    expect(late.rhythmInsightVi).toMatch(/chậm/i);

    const early = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: synthesizePerformanceDsp(song, { mode: "early_300ms" }),
      melodyProfile: song.melodyProfile,
    });
    expect(early.rhythmScore).toBeLessThan(55);
    expect(early.timingBias).toBe("early");
    expect(early.rhythmInsightVi).toMatch(/sớm/i);
  });

  it("returns insufficient (never fake points) on silence and white noise", () => {
    const song = buildTestSong();

    const silent = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: synthesizePerformanceDsp(song, { mode: "silence" }),
      melodyProfile: song.melodyProfile,
    });
    expect(silent.kind).toBe("insufficient");
    expect(silent.totalScore).toBeNull();
    expect(silent.stars).toBe(0);
    expect(silent.rank).toBeNull();

    const noisy = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: synthesizePerformanceDsp(song, { mode: "white_noise" }),
      melodyProfile: song.melodyProfile,
    });
    expect(noisy.kind).toBe("insufficient");
    expect(noisy.totalScore).toBeNull();
    expect(noisy.stars).toBe(0);
  });

  it("re-normalizes weights honestly for legacy songs without melody_profile (no fabricated pitch) and no-STT humming", () => {
    const song = buildTestSong();
    const dsp = synthesizePerformanceDsp(song, { mode: "exact" });
    const lyricsScore = buildPerfectLyricsScore(song.lyrics);

    // Legacy song: melodyProfile=null -> Pitch MUST be null, Rhythm + Lyrics re-normalized!
    const legacy = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      liveLyricsScore: lyricsScore,
      melodyProfile: null,
    });
    expect(legacy.kind).toBe("scored");
    expect(legacy.hasReferenceMelody).toBe(false);
    expect(legacy.pitchScore).toBeNull();
    expect(legacy.activePillars).toEqual({
      pitch: false,
      rhythm: true,
      lyrics: true,
    });
    expect(legacy.weights.pitch).toBe(0);
    expect(legacy.weights.rhythm + legacy.weights.lyrics).toBeCloseTo(1, 3);
    expect(legacy.rhythmScore).toBeGreaterThanOrEqual(85);
    expect(legacy.lyricsScore).toBe(100);

    // Humming in tune without STT -> Pitch (60%) + Rhythm (40%), Lyrics MUST be null!
    const humming = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      liveLyricsScore: null,
      melodyProfile: song.melodyProfile,
    });
    expect(humming.kind).toBe("scored");
    expect(humming.lyricsScore).toBeNull();
    expect(humming.activePillars).toEqual({
      pitch: true,
      rhythm: true,
      lyrics: false,
    });
    expect(humming.weights.pitch).toBeCloseTo(0.6, 2);
    expect(humming.weights.rhythm).toBeCloseTo(0.4, 2);
    expect(humming.pitchScore).toBeGreaterThanOrEqual(90);

    // Humming in tune while SpeechRecognition IS active (0 words matched) -> high Pitch+Rhythm, LOW Lyrics (0)!
    const hummingUnderActiveStt = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      liveLyricsScore: {
        kind: "insufficient",
        overallAccuracy: null,
        matchedWords: 0,
        evaluatedWords: 0,
        totalWords: 16,
        lineScores: [],
      },
      sttActive: true,
      melodyProfile: song.melodyProfile,
    });
    expect(hummingUnderActiveStt.kind).toBe("scored");
    expect(hummingUnderActiveStt.pitchScore).toBeGreaterThanOrEqual(90);
    expect(hummingUnderActiveStt.rhythmScore).toBeGreaterThanOrEqual(85);
    expect(hummingUnderActiveStt.lyricsScore).toBe(0);
    expect(hummingUnderActiveStt.activePillars.lyrics).toBe(true);
  });

  it("blocks +360ms late legato abuse and continuous monotone drone rhythm inflation", () => {
    const song = buildTestSong();
    const rng = makeRng(321);
    const frame = new Float32Array(FRAME_SIZE);

    // 1. Singing +360ms late (worse than +300ms) MUST stay low Rhythm and report timingBias="late"
    const lateAnalyzer = new MusicalDspAnalyzer({
      sampleRate: SAMPLE_RATE,
      frameSize: FRAME_SIZE,
      lyricSpans: song.spans,
      headphoneMode: true,
    });
    for (let tMs = 0; tMs <= song.durationMs; tMs += HOP_MS) {
      frame.fill(0);
      const active = song.notes.find(
        (n) => tMs >= n.startMs + 360 && tMs <= n.endMs + 360,
      );
      if (active) {
        const hz = midiToHz(active.midi);
        const t0 = tMs / 1000;
        for (let i = 0; i < FRAME_SIZE; i++) {
          frame[i] = 0.35 * Math.sin(2 * Math.PI * hz * (t0 + i / SAMPLE_RATE));
        }
      }
      lateAnalyzer.processFrame(frame, tMs);
    }
    const late360 = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: lateAnalyzer.summarize(),
      melodyProfile: song.melodyProfile,
    });
    expect(late360.rhythmScore!).toBeLessThan(40);
    expect(late360.timingBias).toBe("late");

    // 2. Single continuous flat drone ("aaaaah") from start to end MUST NOT get high Rhythm or high Combo
    const droneAnalyzer = new MusicalDspAnalyzer({
      sampleRate: SAMPLE_RATE,
      frameSize: FRAME_SIZE,
      lyricSpans: song.spans,
      headphoneMode: true,
    });
    for (let tMs = 0; tMs <= song.durationMs; tMs += HOP_MS) {
      const hz = 330;
      const t0 = tMs / 1000;
      for (let i = 0; i < FRAME_SIZE; i++) {
        frame[i] =
          0.3 * Math.sin(2 * Math.PI * hz * (t0 + i / SAMPLE_RATE)) +
          rng() * 0.001;
      }
      droneAnalyzer.processFrame(frame, tMs);
    }
    const drone = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: droneAnalyzer.summarize(),
      melodyProfile: song.melodyProfile,
    });
    expect(drone.rhythmScore!).toBeLessThan(35);
    expect(drone.maxCombo).toBeLessThanOrEqual(1);
  });

  it("RealtimePitchSmoother resists isolated octave-jump spikes and live pitch judgement guides up/down", () => {
    const smoother = new RealtimePitchSmoother(0.4);
    expect(smoother.update(64, true)).toBeCloseTo(64, 1);
    expect(smoother.update(64.1, true)).toBeCloseTo(64.04, 1);
    // Single-frame +12 semitone spike -> folded back!
    const afterSpike = smoother.update(76, true);
    expect(afterSpike).not.toBeNull();
    expect(Math.abs(afterSpike! - 64)).toBeLessThan(0.5);

    const song = buildTestSong();
    const notes = resolveTargetNotes(song.melodyProfile, null, song.lyrics);
    const flatJudge = evaluateLivePitchJudgement(58.5, true, notes, 950, 0);
    expect(flatJudge.direction).toBe("up");
    const sharpJudge = evaluateLivePitchJudgement(61.5, true, notes, 950, 0);
    expect(sharpJudge.direction).toBe("down");
    const onJudge = evaluateLivePitchJudgement(60.05, true, notes, 950, 0);
    expect(onJudge.judgement).toBe("perfect");
    expect(onJudge.direction).toBe("on");
  });
});

describe("Pro Karaoke UI Components & Lifecycle Cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders upgraded KaraokeScoreCard with S rank, 3-pillar breakdown, Song Pitch Overview, 1-tap worst line & local replay", () => {
    const song = buildTestSong();
    const dsp = synthesizePerformanceDsp(song, { mode: "exact" });
    const lyricsScore = buildPerfectLyricsScore(song.lyrics);
    const proScore = evaluateProKaraokePerformance({
      lyrics: song.lyrics,
      dspSummary: dsp,
      liveLyricsScore: lyricsScore,
      melodyProfile: song.melodyProfile,
    });
    const onPractice = vi.fn();
    const targetNotes = resolveTargetNotes(song.melodyProfile, null, song.lyrics);

    render(
      <KaraokeScoreCard
        score={lyricsScore}
        proScore={proScore}
        targetNotes={targetNotes}
        dspFrames={dsp.frames}
        durationMs={song.durationMs}
        replayAudioUrl="blob:http://localhost/local-vocal-take"
        onPractice={onPractice}
      />,
    );

    expect(screen.getByTestId("karaoke-pro-score-header")).toBeInTheDocument();
    expect(screen.getByTestId("karaoke-pro-rank")).toHaveTextContent("S");
    expect(screen.getByTestId("karaoke-pro-pillars")).toBeInTheDocument();
    expect(screen.getByTestId("karaoke-pitch-overview-chart")).toBeInTheDocument();
    expect(screen.getByTestId("karaoke-local-vocal-replay")).toHaveTextContent(
      /Chỉ lưu tạm trên máy của bé/,
    );

    fireEvent.click(screen.getByTestId("karaoke-practice-worst-line-btn"));
    expect(onPractice).toHaveBeenCalledWith(proScore.worstLine!.lineId);
  });

  it("draws Pitch Highway canvas frames and cancels RAF cleanly on viread:android-background & unmount", () => {
    const cancelSpy = vi.fn();
    const rafSpy = vi.fn(() => 42);
    vi.stubGlobal("requestAnimationFrame", rafSpy);
    vi.stubGlobal("cancelAnimationFrame", cancelSpy);

    const fillRectSpy = vi.fn();
    const strokeSpy = vi.fn();
    const arcSpy = vi.fn();
    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill: vi.fn(),
      stroke: strokeSpy,
      fillRect: fillRectSpy,
      fillText: vi.fn(),
      arc: arcSpy,
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "round",
      lineJoin: "round",
      shadowColor: "",
      shadowBlur: 0,
      font: "",
      textAlign: "left",
      textBaseline: "middle",
      globalAlpha: 1,
    };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);

    const song = buildTestSong();
    const targetNotes = resolveTargetNotes(song.melodyProfile, null, song.lyrics);
    const liveRing = [
      {
        timeMs: 880,
        rawMidi: 60.05,
        smoothedMidi: 60.05,
        frequencyHz: 262.4,
        clarity: 0.94,
        rms: 0.14,
        vocalBandRms: 0.12,
        voiced: true,
        signalState: "singing" as const,
      },
      {
        timeMs: 920,
        rawMidi: 60.0,
        smoothedMidi: 60.02,
        frequencyHz: 261.9,
        clarity: 0.95,
        rms: 0.15,
        vocalBandRms: 0.13,
        voiced: true,
        signalState: "singing" as const,
      },
    ];

    const { unmount } = render(
      <PitchHighwayCanvas
        targetNotes={targetNotes}
        keyShift={0}
        getCurrentMs={() => 920}
        getPitchRing={() => liveRing}
        getLatestPitchSample={() => liveRing[1]}
        playing={true}
        listening={true}
        scoredMode={true}
        sttAvailable={true}
        phraseStartsMs={[800, 3800]}
      />,
    );

    expect(screen.getByTestId("karaoke-pitch-highway")).toBeInTheDocument();
    expect(fillRectSpy).toHaveBeenCalled();
    expect(strokeSpy).toHaveBeenCalled();
    expect(arcSpy).toHaveBeenCalled();
    expect(rafSpy).toHaveBeenCalled();
    expect(screen.getByTestId("karaoke-pitch-guidance")).toHaveTextContent(
      /Tuyệt vời! Chuẩn tông!/,
    );
    // Combo badge keeps its Flame SVG icon intact across drawn frames
    expect(
      screen.getByTestId("karaoke-pitch-highway").querySelector("svg.lucide-flame"),
    ).not.toBeNull();

    act(() => {
      document.dispatchEvent(new Event("viread:android-background"));
    });
    expect(cancelSpy).toHaveBeenCalledWith(42);
    unmount();
    getContextSpy.mockRestore();
  });

  it("exposes Key Shift (-3..+3) and Mic Latency calibration controls on KaraokeStage", () => {
    class DummyAudio extends EventTarget {
      src = "";
      preload = "";
      volume = 1;
      currentTime = 0;
      duration = 20;
      paused = true;
      ended = false;
      playbackRate = 1;
      preservesPitch = true;
      play = vi.fn(async () => {});
      pause = vi.fn();
      load = vi.fn();
      removeAttribute() {}
    }
    vi.stubGlobal("Audio", DummyAudio);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    render(
      <KaraokePlayer
        source={{ ...previewDetail(), lyrics: syllableLyrics() }}
        presentation="child"
        childAlias="Bé Na"
        label="Sân khấu Karaoke"
      />,
    );

    expect(screen.getByTestId("karaoke-pitch-highway")).toBeInTheDocument();
    expect(screen.getByTestId("karaoke-key-shift-controls")).toBeInTheDocument();

    const upBtn = screen.getByRole("button", { name: "Tăng tông 1 bán âm" });
    fireEvent.click(upBtn);
    fireEvent.click(upBtn);
    expect(screen.getByTestId("karaoke-key-shift-controls")).toHaveTextContent(
      "+2",
    );

    const latencySlider = screen.getByRole("slider", {
      name: "Hiệu chỉnh độ trễ micro",
    });
    fireEvent.change(latencySlider, { target: { value: "120" } });
    expect(screen.getByTestId("karaoke-mic-latency-value")).toHaveTextContent(
      "+120 ms",
    );
  });

  it("useKaraokeScoring starts companion Vocal DSP stream even when SpeechRecognition.start(track) is unsupported (standard browsers)", async () => {
    const song = buildTestSong();
    const recognizers: { start: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onstart: (() => void) | null; onend: (() => void) | null }[] = [];
    class StandardBrowserRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onresult = null;
      onerror = null;
      start = vi.fn(); // Ignores optional MediaStreamTrack -> trackInput stays false
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        recognizers.push(this);
      }
    }
    vi.stubGlobal("SpeechRecognition", StandardBrowserRecognition);

    const stopTrackSpy = vi.fn();
    const makeStream = () =>
      ({
        getTracks: () => [{ readyState: "live", enabled: true, muted: false, stop: stopTrackSpy, onended: null }],
        getAudioTracks: () => [{ readyState: "live", enabled: true, muted: false, stop: stopTrackSpy, onended: null }],
      }) as unknown as MediaStream;
    const getUserMediaSpy = vi.fn(async () => makeStream());
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: getUserMediaSpy },
    });

    const closeAudioCtxSpy = vi.fn(async () => {});
    class FakeAudioContext {
      sampleRate = 48_000;
      state = "running";
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
      createAnalyser = vi.fn(() => ({
        fftSize: 2048,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData: vi.fn((buf: Float32Array) => buf.fill(0)),
        disconnect: vi.fn(),
      }));
      resume = vi.fn(async () => {});
      close = closeAudioCtxSpy;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const { result, unmount } = renderHook(() =>
      useKaraokeScoring(song.lyrics, () => 900, {
        melodyProfile: song.melodyProfile,
      }),
    );

    let armPromise!: Promise<boolean>;
    await act(async () => {
      armPromise = result.current.arm();
    });
    await act(async () => {
      recognizers[0].onstart?.();
    });
    expect(await armPromise).toBe(true);

    // Resume listening -> standard browser SpeechRecognition starts, then companion Vocal DSP opens AudioContext!
    await act(async () => {
      result.current.resume();
    });
    await act(async () => {
      recognizers[1].onstart?.();
      await Promise.resolve();
    });

    expect(result.current.status).toBe("listening");
    // 1st getUserMedia was probe, 2nd is companion Vocal DSP stream!
    expect(getUserMediaSpy).toHaveBeenCalledTimes(2);

    unmount();
    expect(closeAudioCtxSpy).toHaveBeenCalled();
  });
});
