import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import { LocalSegmentSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import { ReadingEvidencePipeline } from "@/lib/reading/reading-evidence-pipeline";
import {
  countUnintendedVoiceSwitches,
  getVoicePolicyPreferences,
  lockSessionVoice,
  recordSessionUtteranceVoice,
  resetVoiceLockAndPolicyForTests,
} from "@/lib/reading/session-voice-lock";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import type { ReadingPageWordDTO } from "@/types/reading";

function word(
  word_id: string,
  text: string,
  word_index: number,
): ReadingPageWordDTO {
  return {
    word_id,
    text,
    word_index,
    bbox: [0.1, 0.1, 0.08, 0.05],
  };
}

const SAMPLE_WORDS: readonly ReadingPageWordDTO[] = [
  word("w1", "Con", 0),
  word("w2", "mèo", 1),
  word("w3", "trèo", 2),
  word("w4", "cây", 3),
  word("w5", "cau", 4),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Section 3.3 Reading State Machine Invariants (all 11 invariants)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
  });

  afterEach(() => {
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    vi.restoreAllMocks();
  });

  it("1-3. mutes mic evidence during TTS playback, rejects self-echo, and re-enables cleanly afterward", () => {
    const scope = {
      sessionId: "sess-1",
      pageId: "page-1",
      revisionId: "rev-1",
      runId: 1,
    };
    const pipeline = new ReadingEvidencePipeline(SAMPLE_WORDS, { scope });

    // 1. TTS starts playing "Con mèo" -> EchoGuard marks active window
    pipeline.playbackStarted("tts-1", "Con mèo", 1000);
    expect(pipeline.echo.isPlaying()).toBe(true);

    // While TTS is speaking, acoustic leak is rejected as "playing"
    const duringPlay = pipeline.ingestFinal({
      text: "Con mèo",
      receivedAt: 1200,
      onsetAt: 1050,
      segmentId: "seg-echo-1",
      seq: 1,
      scope,
    });
    expect(duringPlay).toEqual({ kind: "rejected", reason: "playing" });
    expect(pipeline.snapshot().statusByWordId.size).toBe(0);

    // 2. TTS stops at 2000ms -> immediate tail overlap / grace echo is rejected
    pipeline.playbackEnded("tts-1", 2000);
    expect(pipeline.echo.isPlaying()).toBe(false);
    const tailEcho = pipeline.ingestFinal({
      text: "Con mèo",
      receivedAt: 2400,
      onsetAt: 2100,
      segmentId: "seg-echo-2",
      seq: 2,
      scope,
    });
    expect(tailEcho).toEqual({
      kind: "rejected",
      reason: "onset-during-playback",
    });

    // 3. After grace window, child reads cleanly -> mic evidence resumes without wedging!
    const childRead = pipeline.ingestFinal({
      text: "Con mèo trèo cây cau",
      receivedAt: 3200,
      onsetAt: 2600,
      segmentId: "seg-child-1",
      seq: 3,
      speechDurationMs: 1200,
      scope,
    });
    expect(childRead.kind).toBe("scored");
    expect(pipeline.snapshot().statusByWordId.size).toBe(5);
  });

  it("4. blocks concurrent mic recording start() calls while already active", () => {
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      () => ({ sessionId: "s-conc", pageId: "p-1" }),
    );
    rec.start();
    (rec as unknown as { active: boolean }).active = true;
    const firstEpoch = rec.getEpoch();
    rec.start();
    expect(rec.getEpoch()).toBe(firstEpoch);
    rec.abort();
  });

  it("5. cancels prior TTS playback immediately so two utterances never overlap", async () => {
    const firstSynth = deferred<Blob>();
    const secondSynth = deferred<Blob>();
    let call = 0;
    const speech: SpeechService = {
      synthesize: vi.fn((_text, opts) => {
        call += 1;
        return new Promise<Blob>((resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          const d = call === 1 ? firstSynth : secondSynth;
          void d.promise.then(resolve, reject);
        });
      }),
      transcribe: vi.fn(),
    };
    const studio: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    };
    const playback = new TtsPlayback(speech, studio);

    const p1 = playback.play("Đoạn một").catch((e: Error) => e.name);
    const p2 = playback.play("Đoạn hai").catch((e: Error) => e.name);

    expect(await p1).toBe("AbortError");
    secondSynth.resolve(new Blob(["mp3"], { type: "audio/mpeg" }));
    playback.stop();
    expect(await p2).toBe("AbortError");
  });

  it("6. enforces 'Một buổi, một giọng' lock and detects unintended mid-session voice switches", () => {
    const lock = lockSessionVoice("sess-voice-1", {
      voiceId: "local_north_truc_ly",
    });
    expect(lock.provider).toBe("local");

    recordSessionUtteranceVoice(
      {
        kind: "word_sample",
        provider: "local",
        voiceId: "local_north_truc_ly",
        region: "north",
        modelVersion: lock.modelVersion,
        speed: lock.speed,
        textPreview: "Con",
      },
      "sess-voice-1",
    );
    expect(countUnintendedVoiceSwitches("sess-voice-1")).toBe(0);

    recordSessionUtteranceVoice(
      {
        kind: "coaching",
        provider: "google",
        voiceId: "google_vi_vn_neural2_a",
        region: "north",
        modelVersion: "google-cloud-tts-v1",
        speed: lock.speed,
        textPreview: "Con",
      },
      "sess-voice-1",
    );
    expect(countUnintendedVoiceSwitches("sess-voice-1")).toBe(1);
  });

  it("7-8 & 11. supports 3-strikes give-up/uncertain progression, preserves progress across stale/duplicate/off-topic inputs", () => {
    const scope = {
      sessionId: "sess-progress",
      pageId: "page-1",
      revisionId: "rev-1",
      runId: 1,
    };
    const pipeline = new ReadingEvidencePipeline(SAMPLE_WORDS, { scope });

    // Read word 1 accurately
    pipeline.ingestFinal({
      text: "Con",
      receivedAt: 1000,
      segmentId: "seg-1",
      seq: 1,
      scope,
    });
    expect(pipeline.snapshot().statusByWordId.get("w1")?.status).toBe("MATCH");

    // 11. Off-topic / unrecognized speech or duplicate / stale scope never falsely advances cursor
    const offTopic = pipeline.ingestFinal({
      text: "một hai ba bốn năm",
      receivedAt: 1500,
      segmentId: "seg-off",
      seq: 2,
      speechDurationMs: 1200,
      scope,
    });
    expect(offTopic.kind).toBe("off-topic");
    expect(pipeline.snapshot().statusByWordId.size).toBe(1);

    const dup = pipeline.ingestFinal({
      text: "Con",
      receivedAt: 1600,
      segmentId: "seg-1",
      seq: 3,
      scope,
    });
    expect(dup).toEqual({ kind: "rejected", reason: "duplicate-segment" });

    const stale = pipeline.ingestFinal({
      text: "mèo",
      receivedAt: 1700,
      segmentId: "seg-stale",
      seq: 4,
      scope: { ...scope, runId: 99 },
    });
    expect(stale).toEqual({ kind: "rejected", reason: "stale-scope" });

    // 7. 3-strikes / give-up marks difficult word without losing prior matched progress
    pipeline.markUncertain();
    pipeline.markUncertain();
    pipeline.markGaveUp("w2");
    expect(pipeline.snapshot().statusByWordId.get("w1")?.status).toBe("MATCH");
    expect(pipeline.grade().get("w2")).toBe("SKIPPED");
  });

  it("9-10. enforces local_only privacy default and emits stt-unavailable instead of fake grading when STT is down", async () => {
    expect(getVoicePolicyPreferences()).toMatchObject({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });

    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    const transcribe = vi.fn().mockRejectedValue({
      code: "STT_UNAVAILABLE",
      status: 503,
      retryable: true,
    });
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "s-err", pageId: "p-1" }),
    );
    rec.interimResults = false;
    const errors: string[] = [];
    const results: string[] = [];
    rec.onerror = (e) => {
      if (e.error) errors.push(e.error);
    };
    rec.onresult = (e) => {
      const item = e.results[e.resultIndex];
      results.push(item[0].transcript);
    };
    rec.start();
    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;
    for (let i = 0; i < 10; i += 1)
      internal.consumeSamples16k(new Float32Array(640).fill(0.05));
    for (let i = 0; i < 20; i += 1)
      internal.consumeSamples16k(new Float32Array(640).fill(0));
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(results).toEqual([]);
    expect(errors).toContain("stt-unavailable");
  });
});
