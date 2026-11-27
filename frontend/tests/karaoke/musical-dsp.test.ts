import { describe, expect, it, vi } from "vitest";
import {
  CHILD_MAX_F0_HZ,
  CHILD_MIN_F0_HZ,
  createBrowserMusicalMonitor,
  createYinWorkspace,
  detectPitchYIN,
  hzToMidi,
  midiToHz,
  MusicalDspAnalyzer,
  octaveInvariantCentsError,
  octaveInvariantSemitoneError,
  pitchClassFromHz,
} from "@/lib/karaoke/musical-dsp";
import { evaluateMusicalPerformance } from "@/lib/karaoke/musical-scoring";
import {
  deriveBeatGridFromLyrics,
  mergeBestFullSongScore,
  RhythmTapTracker,
} from "@/lib/karaoke/musical-practice";
import type { KaraokeLyrics } from "@/types/karaoke";

const SR = 48_000;
const FRAME_SIZE = 2048;

function synthesizeVocalFrame(
  f0Hz: number,
  amplitude = 0.25,
  sampleRate = SR,
  frameSize = FRAME_SIZE,
): Float32Array {
  const out = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    const t = i / sampleRate;
    // Harmonic-rich child vocal spectrum (F0 + 2F0 + 3F0 + 4F0).
    out[i] =
      amplitude *
      (0.55 * Math.sin(2 * Math.PI * f0Hz * t) +
        0.26 * Math.sin(2 * Math.PI * 2 * f0Hz * t + 0.3) +
        0.13 * Math.sin(2 * Math.PI * 3 * f0Hz * t + 0.7) +
        0.06 * Math.sin(2 * Math.PI * 4 * f0Hz * t + 1.1));
  }
  return out;
}

function synthesizeWhiteNoise(
  amplitude = 0.08,
  seed = 12345,
  frameSize = FRAME_SIZE,
): Float32Array {
  const out = new Float32Array(frameSize);
  let state = seed >>> 0;
  for (let i = 0; i < frameSize; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    const u = state / 0xffffffff;
    out[i] = (u * 2 - 1) * amplitude;
  }
  return out;
}

describe("Web Audio YIN pitch detector & octave-invariant helpers", () => {
  it.each([
    ["C3 low bound", 130.81],
    ["C4 child low", 261.63],
    ["E4 child mid", 329.63],
    ["G4 child mid", 392.0],
    ["A4 concert", 440.0],
    ["C5 child high", 523.25],
    ["G5 soprano", 783.99],
    ["A5 high bound", 880.0],
  ])("detects %s (%f Hz) within 10 cents", (_label, targetHz) => {
    const ws = createYinWorkspace(SR, CHILD_MIN_F0_HZ, FRAME_SIZE);
    const frame = synthesizeVocalFrame(targetHz);
    const result = detectPitchYIN(frame, SR, {}, ws);
    expect(result.voiced).toBe(true);
    expect(result.frequencyHz).not.toBeNull();
    const centsErr = Math.abs(1200 * Math.log2(result.frequencyHz! / targetHz));
    expect(centsErr).toBeLessThan(10);
    expect(result.clarity).toBeGreaterThanOrEqual(0.9);
    expect(result.isHumLike).toBe(false);
  });

  it("produces identical results when reusing a pre-allocated YinWorkspace", () => {
    const ws = createYinWorkspace(SR, CHILD_MIN_F0_HZ, FRAME_SIZE);
    const f1 = synthesizeVocalFrame(293.66);
    const f2 = synthesizeVocalFrame(587.33);
    const a1 = detectPitchYIN(f1, SR, {}, ws);
    const a2 = detectPitchYIN(f2, SR, {}, ws);
    const fresh = detectPitchYIN(f2, SR);
    expect(a1.voiced).toBe(true);
    expect(a2.frequencyHz).toBeCloseTo(fresh.frequencyHz!, 6);
    expect(a2.clarity).toBeCloseTo(fresh.clarity, 6);
  });

  it("computes octave-invariant pitch class and cents errors", () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 6);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
    expect(pitchClassFromHz(261.63)).toBe(0);
    expect(pitchClassFromHz(523.25)).toBe(0);
    // +1 octave = 0 cents error
    expect(octaveInvariantCentsError(523.25, 261.63)).toBeLessThan(0.5);
    // +1 octave and +35 cents sharp
    const sharpOctave = 523.25 * Math.pow(2, 35 / 1200);
    expect(octaveInvariantCentsError(sharpOctave, 261.63)).toBeCloseTo(35, 1);
    expect(octaveInvariantSemitoneError(sharpOctave, 261.63)).toBeCloseTo(
      0.35,
      2,
    );
  });

  it("rejects silence, broadband white noise, and 50/60 Hz electrical hum", () => {
    const silence = new Float32Array(FRAME_SIZE);
    const resSilence = detectPitchYIN(silence, SR);
    expect(resSilence.voiced).toBe(false);
    expect(resSilence.frequencyHz).toBeNull();

    const noise = synthesizeWhiteNoise(0.12);
    const resNoise = detectPitchYIN(noise, SR);
    expect(resNoise.voiced).toBe(false);
    expect(resNoise.clarity).toBeLessThan(0.6);

    const hum60 = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      hum60[i] = 0.15 * Math.sin((2 * Math.PI * 60 * i) / SR);
    }
    const resHum = detectPitchYIN(hum60, SR);
    expect(resHum.voiced).toBe(false);
    expect(resHum.isHumLike).toBe(true);
    expect(resHum.lowBandRatio).toBeGreaterThanOrEqual(0.65);

    const hum50 = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      hum50[i] = 0.15 * Math.sin((2 * Math.PI * 50 * i) / SR);
    }
    const resHum50 = detectPitchYIN(hum50, SR);
    expect(resHum50.voiced).toBe(false);
    expect(resHum50.isHumLike).toBe(true);
    expect(CHILD_MAX_F0_HZ).toBe(880);
  });

  it("detects vocal onsets aligned strictly to playback clock timestamps", () => {
    const analyzer = new MusicalDspAnalyzer({
      sampleRate: SR,
      frameSize: FRAME_SIZE,
      lyricSpans: [{ startMs: 400, endMs: 2000 }],
      headphoneMode: true,
    });
    const silent = new Float32Array(FRAME_SIZE);
    const noteC4 = synthesizeVocalFrame(261.63, 0.22);
    const noteE4 = synthesizeVocalFrame(329.63, 0.22);

    // 0..360 ms silent, 400..960 ms C4, 1000..1160 ms gap, 1200..1800 ms E4
    for (let t = 0; t <= 1800; t += 40) {
      if (t >= 400 && t < 1000) analyzer.processFrame(noteC4, t);
      else if (t >= 1200 && t < 1800) analyzer.processFrame(noteE4, t);
      else analyzer.processFrame(silent, t);
    }

    const summary = analyzer.summarize();
    expect(summary.qualityGate.passed).toBe(true);
    expect(summary.onsets.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(summary.onsets[0].timeMs - 400)).toBeLessThanOrEqual(40);
    expect(summary.onsets.some((o) => Math.abs(o.timeMs - 1200) <= 40)).toBe(
      true,
    );
  });

  it("manages browser AudioContext lifecycle and tears down on android background", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    const disconnect = vi.fn();
    let mediaMs = 0;

    class MockAudioContext {
      state = "running";
      sampleRate = SR;
      resume = vi.fn(async () => {});
      close = close;
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect });
      createAnalyser = () => ({
        fftSize: FRAME_SIZE,
        smoothingTimeConstant: 0,
        disconnect,
        getFloatTimeDomainData: (buf: Float32Array) => {
          buf.set(synthesizeVocalFrame(329.63, 0.2));
        },
      });
    }
    vi.stubGlobal("AudioContext", MockAudioContext);

    const stream = {
      getAudioTracks: () => [
        { readyState: "live", enabled: true, muted: false },
      ],
    } as unknown as MediaStream;

    const received: number[] = [];
    const monitor = createBrowserMusicalMonitor({
      stream,
      getCurrentMs: () => mediaMs,
      lyricSpans: [{ startMs: 0, endMs: 2000 }],
      headphoneMode: true,
      pollIntervalMs: 40,
      telemetryThrottleMs: 50,
      onTelemetry: (t) => {
        if (t.frequencyHz) received.push(t.frequencyHz);
      },
    });
    expect(monitor).not.toBeNull();

    for (let step = 1; step <= 6; step++) {
      mediaMs = step * 40;
      vi.advanceTimersByTime(40);
    }

    expect(monitor!.getSummary().voicedFrameCount).toBeGreaterThanOrEqual(4);
    expect(received.length).toBeGreaterThan(0);

    document.dispatchEvent(new Event("viread:android-background"));
    expect(close).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalled();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects high-ZCR unvoiced sibilant/breath noise while keeping high child vocals voiced", () => {
    const analyzer = new MusicalDspAnalyzer({
      sampleRate: SR,
      frameSize: FRAME_SIZE,
      lyricSpans: [{ startMs: 0, endMs: 1200 }],
      headphoneMode: true,
    });

    // High-frequency unvoiced sibilant/breath hiss (~6.5 kHz + broadband noise)
    const sibilant = new Float32Array(FRAME_SIZE);
    const noise = synthesizeWhiteNoise(0.18, 999);
    for (let i = 0; i < FRAME_SIZE; i++) {
      sibilant[i] =
        0.16 * Math.sin((2 * Math.PI * 6500 * i) / SR) + noise[i] * 0.5;
    }

    const noiseFrame = analyzer.processFrame(sibilant, 100);
    expect(noiseFrame.zeroCrossingRate).toBeGreaterThanOrEqual(0.25);
    expect(noiseFrame.voiced).toBe(false);
    expect(analyzer.getLiveTelemetry()?.signalState).toBe("noise");

    // Genuine high-pitched child vocal (987.77 Hz / B5) stays voiced & singing
    const highChildVocal = synthesizeVocalFrame(987.77, 0.22);
    const vocalFrame = analyzer.processFrame(highChildVocal, 200);
    expect(vocalFrame.voiced).toBe(true);
    expect(analyzer.getLiveTelemetry()?.signalState).toBe("singing");
  });

  it("tears down AudioContext automatically on document visibilitychange to hidden", () => {
    const close = vi.fn(async () => {});
    const disconnect = vi.fn();

    class MockAudioContext {
      state = "running";
      sampleRate = SR;
      resume = vi.fn(async () => {});
      close = close;
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect });
      createAnalyser = () => ({
        fftSize: FRAME_SIZE,
        smoothingTimeConstant: 0,
        disconnect,
        getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0),
      });
    }
    vi.stubGlobal("AudioContext", MockAudioContext);

    const stream = {
      getAudioTracks: () => [
        { readyState: "live", enabled: true, muted: false },
      ],
    } as unknown as MediaStream;

    const monitor = createBrowserMusicalMonitor({
      stream,
      getCurrentMs: () => 100,
    });
    expect(monitor).not.toBeNull();

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(close).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Document.prototype,
          "visibilityState",
          originalDescriptor,
        );
      } else {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      }
      vi.unstubAllGlobals();
    }
  });
});

describe("Practice modes, beat grid derivation & non-conflated scoring modes", () => {
  const sampleLyrics: KaraokeLyrics = {
    format_version: 2,
    lines: [
      {
        id: "line-1",
        text: "Bé hát vui",
        start_ms: 1000,
        end_ms: 2500,
        syllables: [
          { id: "s1", text: "Bé", start_ms: 1000, end_ms: 1500 },
          { id: "s2", text: "hát", start_ms: 1500, end_ms: 2000 },
          { id: "s3", text: "vui", start_ms: 2000, end_ms: 2500 },
        ],
      },
      {
        id: "line-2",
        text: "Ca vang lên",
        start_ms: 3000,
        end_ms: 4500,
        syllables: [
          { id: "s4", text: "Ca", start_ms: 3000, end_ms: 3500 },
          { id: "s5", text: "vang", start_ms: 3500, end_ms: 4000 },
          { id: "s6", text: "lên", start_ms: 4000, end_ms: 4500 },
        ],
      },
    ],
  };

  it("derives deterministic beat grid & BPM from lyrics and scores RHYTHM_TAP without mic", () => {
    const derived = deriveBeatGridFromLyrics(sampleLyrics);
    expect(derived.beatGridMs).toEqual([1000, 1500, 2000, 3000, 3500, 4000]);
    expect(derived.bpm).toBe(120);

    const tracker = new RhythmTapTracker(derived.beatGridMs);
    for (const beat of derived.beatGridMs) {
      const fb = tracker.recordTap(beat + 20);
      expect(fb?.quality).toBe("PERFECT");
    }
    expect(tracker.getStreak()).toBe(6);

    const result = evaluateMusicalPerformance({
      lyrics: sampleLyrics,
      practiceMode: "RHYTHM_TAP",
      rhythmTapsMs: tracker.getTaps(),
    });
    expect(result.scoringMode).toBe("RHYTHM_AND_LYRICS");
    expect(result.pitchScore).toBeNull();
    expect(result.lyricsScore).toBeNull();
    expect(result.rhythmScore).toBeGreaterThanOrEqual(90);
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
  });

  it("returns LYRICS_ONLY without fabricating pitch or rhythm when DSP is unavailable", () => {
    const result = evaluateMusicalPerformance({
      lyrics: sampleLyrics,
      dspSummary: null,
      liveLyricsScore: {
        kind: "whole",
        overallAccuracy: 83,
        matchedWords: 5,
        evaluatedWords: 6,
        totalWords: 6,
        lineScores: [
          {
            lineIndex: 0,
            lineId: "line-1",
            lineText: "Bé hát vui",
            matchedWords: 3,
            evaluatedWords: 3,
            words: [
              { id: "s1/0", syllableId: "s1", text: "bé", state: "matched" },
              { id: "s2/0", syllableId: "s2", text: "hát", state: "matched" },
              { id: "s3/0", syllableId: "s3", text: "vui", state: "matched" },
            ],
          },
          {
            lineIndex: 1,
            lineId: "line-2",
            lineText: "Ca vang lên",
            matchedWords: 2,
            evaluatedWords: 3,
            words: [
              { id: "s4/0", syllableId: "s4", text: "ca", state: "matched" },
              { id: "s5/0", syllableId: "s5", text: "vang", state: "matched" },
              { id: "s6/0", syllableId: "s6", text: "lên", state: "different" },
            ],
          },
        ],
      },
    });
    expect(result.scoringMode).toBe("LYRICS_ONLY");
    expect(result.scoringModeLabelVi).toBe("Chỉ chấm lời hát");
    expect(result.pitchScore).toBeNull();
    expect(result.rhythmScore).toBeNull();
    expect(result.lyricsScore).toBe(83);
    expect(result.overallScore).toBe(83);
  });

  it("guarantees SEGMENT / LINE_PRACTICE / RHYTHM_TAP never overwrite bestFullSongScore", () => {
    let best: number | null = 78;
    best = mergeBestFullSongScore(best, {
      practiceMode: "SEGMENT",
      scoringMode: "FULL_MUSICAL",
      overallScore: 99,
    });
    expect(best).toBe(78);

    best = mergeBestFullSongScore(best, {
      practiceMode: "LINE_PRACTICE",
      scoringMode: "FULL_MUSICAL",
      overallScore: 100,
    });
    expect(best).toBe(78);

    best = mergeBestFullSongScore(best, {
      practiceMode: "RHYTHM_TAP",
      scoringMode: "RHYTHM_AND_LYRICS",
      overallScore: 98,
    });
    expect(best).toBe(78);

    best = mergeBestFullSongScore(best, {
      practiceMode: "FULL_SONG",
      scoringMode: "FULL_MUSICAL",
      overallScore: 91,
    });
    expect(best).toBe(91);
  });
});
