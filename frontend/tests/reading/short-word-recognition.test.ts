import { describe, expect, it, vi } from "vitest";
import {
  AudioQualityMonitor,
  hasShortWordBlockingAudioIssue,
  hasUnusableAudio,
} from "@/lib/reading/audio-quality";
import { classifyRetryTranscript } from "@/lib/reading/retry-word-recognition";
import {
  SHORT_WORD_CAPTURE_CONFIG,
  SHORT_WORD_CONTEXT_RETRY_THRESHOLD,
  classifyShortWordFailureLabel,
  evaluateRecordedShortWord,
  hasShortWordSpeechActivity,
  shouldAttemptShortWordKeytermPass2,
  shouldAutoStopShortWordCapture,
} from "@/lib/reading/word-practice-engine";
import type { SpeechService } from "@/lib/api/speech-service";

function createSyntheticFormantSpeechFrame(
  length: number,
  sampleRate: number,
  amplitude: number,
): Float32Array {
  const frame = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    // Synthesize Vietnamese vowel /ɔ/ harmonics (F0=260Hz child pitch, F1=550Hz, F2=900Hz)
    const raw =
      0.55 * Math.sin(2 * Math.PI * 260 * t) +
      0.3 * Math.sin(2 * Math.PI * 550 * t) +
      0.15 * Math.sin(2 * Math.PI * 900 * t);
    frame[i] = amplitude * raw;
  }
  return frame;
}

function createNoiseFrame(length: number, rmsTarget: number): Float32Array {
  const frame = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    frame[i] = (i % 2 === 0 ? 1 : -1) * rmsTarget;
  }
  return frame;
}

describe("Short-word AudioQualityMonitor preset & capture timing", () => {
  it("detects a single 180ms Vietnamese syllable starting early at t=40ms in short-word mode", () => {
    const monitor = new AudioQualityMonitor({ mode: "short-word" });
    const quiet = createNoiseFrame(320, 0.001);
    const vowel = createSyntheticFormantSpeechFrame(320, 16000, 0.04);

    // Opening 20ms quiet room noise, then immediate speech from t=40ms to t=220ms
    monitor.addFrame(quiet, 0);
    monitor.addFrame(quiet, 20);
    for (let t = 40; t <= 220; t += 20) {
      monitor.addFrame(vowel, t);
    }
    monitor.addFrame(quiet, 240);

    const snap = monitor.getSnapshot();
    expect(snap.status).toBe("SPEECH_DETECTED");
    expect(snap.speechDurationMs).toBeGreaterThanOrEqual(60);
    expect(snap.noiseFloor).toBeLessThan(0.01);
    expect(hasShortWordBlockingAudioIssue(snap)).toBe(false);
  });

  it("does not block soft Grade-1 voices (LOW_VOLUME/BACKGROUND_NOISE) from reaching STT in short-word gate", () => {
    const lowMonitor = new AudioQualityMonitor({ mode: "short-word" });
    const soft = createSyntheticFormantSpeechFrame(320, 16000, 0.004);
    for (let t = 0; t <= 240; t += 20) {
      lowMonitor.addFrame(soft, t);
    }
    const lowSnap = lowMonitor.getSnapshot();
    expect(lowSnap.status).toBe("LOW_VOLUME");
    expect(hasUnusableAudio(lowSnap)).toBe(true);
    expect(hasShortWordBlockingAudioIssue(lowSnap)).toBe(false);

    const silenceMonitor = new AudioQualityMonitor({ mode: "short-word" });
    const zero = new Float32Array(320);
    for (let t = 0; t <= 240; t += 20) {
      silenceMonitor.addFrame(zero, t);
    }
    expect(silenceMonitor.getSnapshot().status).toBe("SILENCE");
    expect(hasShortWordBlockingAudioIssue(silenceMonitor.getSnapshot())).toBe(
      true,
    );
  });

  it("stops promptly after a full quiet tail and guards 1-poll energy spikes", () => {
    expect(SHORT_WORD_CONTEXT_RETRY_THRESHOLD).toBe(1);
    expect(SHORT_WORD_CAPTURE_CONFIG.postSpeechSilenceMs).toBe(950);

    expect(
      shouldAutoStopShortWordCapture({
        elapsedMs: 500,
        speechObserved: true,
        silenceElapsedMs: 800,
      }),
    ).toBe(false);

    expect(
      shouldAutoStopShortWordCapture({
        elapsedMs: 1050,
        speechObserved: true,
        silenceElapsedMs: 950,
      }),
    ).toBe(true);

    expect(
      shouldAutoStopShortWordCapture({
        elapsedMs: SHORT_WORD_CAPTURE_CONFIG.noSpeechTimeoutMs,
        speechObserved: false,
        silenceElapsedMs: SHORT_WORD_CAPTURE_CONFIG.noSpeechTimeoutMs,
      }),
    ).toBe(true);

    // Unguarded 1-poll liveRms >= 0.015 spike must NOT trigger speechObserved
    expect(
      hasShortWordSpeechActivity({
        isSpeakingNow: false,
        audioLevel: 0.03,
        quality: {
          status: "UNKNOWN",
          durationMs: 120,
          speechDurationMs: 0,
          silenceDurationMs: 0,
          rms: 0.03,
          peak: 0.05,
          noiseFloor: 0.002,
          clipped: false,
          isSpeaking: false,
        },
        hasLiveBrowserSpeech: false,
        speechObserved: false,
        previousSpeechDurationMs: 0,
      }),
    ).toBe(false);

    // Confirmed across multiple polls above noiseFloor (1.8x) -> true
    expect(
      hasShortWordSpeechActivity({
        isSpeakingNow: false,
        audioLevel: 0.02,
        quality: {
          status: "UNKNOWN",
          durationMs: 240,
          speechDurationMs: 0,
          silenceDurationMs: 0,
          rms: 0.012,
          peak: 0.03,
          noiseFloor: 0.003,
          clipped: false,
          isSpeaking: false,
        },
        hasLiveBrowserSpeech: false,
        speechObserved: false,
        previousSpeechDurationMs: 0,
        consecutiveEnergyPolls: 2,
      }),
    ).toBe(true);

    expect(
      hasShortWordSpeechActivity({
        isSpeakingNow: true,
        audioLevel: 0.02,
        hasLiveBrowserSpeech: false,
      }),
    ).toBe(true);
  });

  it("triggers Pass 2 with contrastive keyterms on SPEECH_DETECTED + NOT_RECOGNIZED/UNCERTAIN and accepts logprob >= -0.75", async () => {
    expect(
      shouldAttemptShortWordKeytermPass2({
        status: "NOT_RECOGNIZED",
        audioQuality: {
          status: "SPEECH_DETECTED",
          durationMs: 600,
          speechDurationMs: 220,
          silenceDurationMs: 300,
          rms: 0.03,
          peak: 0.08,
          noiseFloor: 0.002,
          clipped: false,
          isSpeaking: false,
        },
      }),
    ).toBe(true);

    expect(
      shouldAttemptShortWordKeytermPass2({
        status: "NOT_RECOGNIZED",
        transcript: "[tiếng đập]",
        audioQuality: {
          status: "SPEECH_DETECTED",
          durationMs: 600,
          speechDurationMs: 220,
          silenceDurationMs: 300,
          rms: 0.03,
          peak: 0.08,
          noiseFloor: 0.002,
          clipped: false,
          isSpeaking: false,
        },
      }),
    ).toBe(false);

    const calls: Array<readonly string[] | undefined> = [];
    const speech = {
      transcribe: vi.fn(async (_blob, opts) => {
        calls.push(opts?.keyterms);
        if (!opts?.keyterms) {
          return {
            text: "",
            language_code: "vi",
            language_probability: 0.5,
            words: null,
          };
        }
        return {
          text: "có",
          language_code: "vi",
          language_probability: 0.94,
          words: [{ text: "có", start: 0.05, end: 0.3, logprob: -0.68 }],
        };
      }),
    };

    const res = await evaluateRecordedShortWord({
      expectedWord: "có",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
      audioQuality: {
        status: "SPEECH_DETECTED",
        durationMs: 600,
        speechDurationMs: 220,
        silenceDurationMs: 300,
        rms: 0.03,
        peak: 0.08,
        noiseFloor: 0.002,
        clipped: false,
        isSpeaking: false,
      },
      speechService: speech,
    });
    expect(res.status).toBe("CORRECT");
    expect(res.source).toBe("SERVER_STT_KEYTERM");
    expect(calls[1]).toEqual(expect.arrayContaining(["có", "cò", "cỏ", "cọ"]));
  });
});

describe("12 mandatory recognition test cases for target word 'có'", () => {
  const dummyBlob = new Blob(["synthetic-webm-audio"], { type: "audio/webm" });
  const goodQuality = {
    status: "SPEECH_DETECTED" as const,
    durationMs: 700,
    speechDurationMs: 240,
    silenceDurationMs: 420,
    rms: 0.04,
    peak: 0.09,
    noiseFloor: 0.002,
    clipped: false,
    isSpeaking: false,
  };

  const makeMockSpeech = (
    handler: SpeechService["transcribe"],
  ): Pick<SpeechService, "transcribe"> => ({
    transcribe: vi.fn(handler),
  });

  it("Case 1: 'có' clear single utterance -> CORRECT in 1 pass", async () => {
    const speech = makeMockSpeech(async () => ({
      text: "có",
      language_code: "vie",
      language_probability: 0.98,
      words: [{ text: "có", start: 0, end: 0.25, logprob: -0.08 }],
    }));
    const res = await evaluateRecordedShortWord({
      expectedWord: "có",
      audioBlob: dummyBlob,
      audioQuality: goodQuality,
      speechService: speech,
    });
    expect(res.status).toBe("CORRECT");
    expect(res.source).toBe("SERVER_STT");
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });

  it("Case 2: 'Có.' with trailing punctuation -> CORRECT", () => {
    expect(classifyRetryTranscript("có", "Có.")).toBe("CORRECT");
  });

  it("Case 3: 'từ có ạ' short natural utterance -> CORRECT", () => {
    expect(classifyRetryTranscript("có", "từ có ạ")).toBe("CORRECT");
  });

  it("Case 4: 'có có' repeated child read -> CORRECT", () => {
    expect(classifyRetryTranscript("có", "có có")).toBe("CORRECT");
  });

  it("Case 5: 'có [tiếng đập]' with background click noise -> CORRECT", () => {
    expect(classifyRetryTranscript("có", "có [tiếng đập]")).toBe("CORRECT");
  });

  it("Case 6: wrong tone 'cò' -> INCORRECT (never false positive)", () => {
    expect(classifyRetryTranscript("có", "cò")).toBe("INCORRECT");
  });

  it("Case 7: missing tone 'co' -> INCORRECT", () => {
    expect(classifyRetryTranscript("có", "co")).toBe("INCORRECT");
  });

  it("Case 8: different vowel + tone 'cô' -> INCORRECT", () => {
    expect(classifyRetryTranscript("có", "cô")).toBe("INCORRECT");
  });

  it("Case 9: '[tiếng đập]' pure noise tag -> NOT_RECOGNIZED (never INCORRECT)", async () => {
    expect(classifyRetryTranscript("có", "[tiếng đập]")).toBe("NOT_RECOGNIZED");
    const speech = makeMockSpeech(async () => ({
      text: "[tiếng đập]",
      language_code: "vie",
      language_probability: 0.9,
      words: [],
    }));
    const res = await evaluateRecordedShortWord({
      expectedWord: "có",
      audioBlob: dummyBlob,
      audioQuality: goodQuality,
      speechService: speech,
    });
    expect(res.status).toBe("NOT_RECOGNIZED");
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });

  it("Case 10: silence recording -> blocked cleanly as NOT_RECOGNIZED without STT call", async () => {
    const speech = makeMockSpeech(async () => {
      throw new Error("Should not call STT on silence");
    });
    const res = await evaluateRecordedShortWord({
      expectedWord: "có",
      audioBlob: dummyBlob,
      audioQuality: { ...goodQuality, status: "SILENCE", speechDurationMs: 0 },
      speechService: speech,
    });
    expect(res.status).toBe("NOT_RECOGNIZED");
    expect(res.source).toBe("AUDIO_QUALITY_GATE");
    expect(speech.transcribe).not.toHaveBeenCalled();
  });

  it("Case 11: quiet speech (LOW_VOLUME) still passes to STT and succeeds when Scribe hears 'có'", async () => {
    const speech = makeMockSpeech(async () => ({
      text: "có",
      language_code: "vie",
      language_probability: 0.92,
      words: [{ text: "có", start: 0, end: 0.2, logprob: -0.22 }],
    }));
    const res = await evaluateRecordedShortWord({
      expectedWord: "có",
      audioBlob: dummyBlob,
      audioQuality: { ...goodQuality, status: "LOW_VOLUME", rms: 0.005 },
      speechService: speech,
    });
    expect(res.status).toBe("CORRECT");
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });

  it("Case 12: Scribe Pass 1 uncertain without browser speech stays honest UNCERTAIN even with keyterms, while keyterm + high logprob recovers cleanly", async () => {
    const lowConfSpeech = makeMockSpeech(async () => ({
      text: "có",
      language_code: "vie",
      language_probability: 0.7,
      words: [{ text: "có", start: 0, end: 0.2, logprob: -1.8 }],
    }));
    const blocked = await evaluateRecordedShortWord({
      expectedWord: "có",
      audioBlob: dummyBlob,
      audioQuality: goodQuality,
      speechService: lowConfSpeech,
    });
    expect(blocked.status).toBe("UNCERTAIN");

    let callIdx = 0;
    const recoveredSpeech = makeMockSpeech(async (_blob, opts) => {
      callIdx += 1;
      if (!opts?.keyterms) {
        return {
          text: "",
          language_code: "vie",
          language_probability: 0.4,
          words: [],
        };
      }
      return {
        text: "có",
        language_code: "vie",
        language_probability: 0.96,
        words: [{ text: "có", start: 0, end: 0.22, logprob: -0.15 }],
      };
    });
    const recovered = await evaluateRecordedShortWord({
      expectedWord: "có",
      audioBlob: dummyBlob,
      audioQuality: goodQuality,
      browserTranscript: "có",
      browserConfidence: 0.9,
      speechService: recoveredSpeech,
    });
    expect(callIdx).toBe(2);
    expect(recovered.status).toBe("CORRECT");
    expect(recovered.source).toBe("SERVER_STT_KEYTERM");
  });

  it("records deterministic pipeline latency metrics (p50/p95 < 50ms client overhead)", async () => {
    const speech = makeMockSpeech(async () => ({
      text: "có",
      language_code: "vie",
      language_probability: 0.97,
      words: [{ text: "có", start: 0, end: 0.25, logprob: -0.1 }],
    }));
    const durations: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await evaluateRecordedShortWord({
        expectedWord: "có",
        audioBlob: dummyBlob,
        audioQuality: goodQuality,
        speechService: speech,
      });
      durations.push(res.sttDurationMs);
    }
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
    expect(p50).toBeLessThan(50);
    expect(p95).toBeLessThan(50);
  });

  it("captures immediate speech onset during t=20ms<60ms, classifies TTS bleed as UNCERTAIN, and distinguishes 3 failure states", () => {
    const monitor = new AudioQualityMonitor({ mode: "short-word" });
    const sampleRate = 16_000;
    const immediateSpeech = createSyntheticFormantSpeechFrame(
      320,
      sampleRate,
      0.08,
    );
    // Immediate speech frames during first <60ms calibrationWindowMs activate early
    monitor.addFrame(immediateSpeech, 0);
    monitor.addFrame(immediateSpeech, 20);
    monitor.addFrame(immediateSpeech, 40);
    const earlySnap = monitor.addFrame(immediateSpeech, 55);
    expect(earlySnap.isSpeaking).toBe(true);

    // Assistant speaker bleed is NEVER graded CORRECT or INCORRECT
    expect(classifyRetryTranscript("một", "bé hãy đọc lại từ một nhé")).toBe(
      "UNCERTAIN",
    );
    expect(classifyRetryTranscript("có", "mình chưa nghe rõ từ có")).toBe(
      "UNCERTAIN",
    );

    // 3 explicit distinct failure labels
    expect(
      classifyShortWordFailureLabel("NO_CLEAR_AUDIO", "SILENCE", null),
    ).toBe("Chưa nghe thấy");
    expect(
      classifyShortWordFailureLabel("NO_CLEAR_AUDIO", "LOW_VOLUME", null),
    ).toBe("Nghe chưa rõ");
    expect(
      classifyShortWordFailureLabel(
        "UNCERTAIN",
        "SPEECH_DETECTED",
        "bé hãy đọc",
      ),
    ).toBe("Nghe chưa rõ");
    expect(
      classifyShortWordFailureLabel("INCORRECT", "SPEECH_DETECTED", "mốt"),
    ).toBe("Đọc sai");
  });
});
