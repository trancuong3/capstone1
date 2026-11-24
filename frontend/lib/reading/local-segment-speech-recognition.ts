/**
 * Local-First Utterance-Segment SpeechRecognition (`LocalSegmentSpeechRecognition`).
 *
 * Replaces Chrome's cloud-bound `webkitSpeechRecognition` in real browsers and
 * Android APK WebViews so child audio stays 100% on the local Windows machine
 * (`127.0.0.1:8010` Sherpa-ONNX worker via `/voice/speech-to-text`), while only
 * falling back to Google Cloud STT on the backend when explicitly permitted by
 * parent policy (`local_with_google_fallback` + `allowGoogleSttFallback`).
 *
 * Preserves compatibility with synthetic unit-test `SpeechRecognition` mocks
 * (detected via non-native constructor source).
 */

import { ServiceError } from "@/lib/api/service-error";
import type { SpeechService } from "@/lib/api/speech-service";
import { getVoicePolicyPreferences } from "@/lib/reading/session-voice-lock";
import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";
import {
  getFreshVoiceEngineHealth,
  getVoiceEngineStatus,
  recordSttEngineUsage,
} from "@/lib/reading/voice-engine-status";

export interface SegmentSpeechResultAlternative {
  readonly transcript: string;
  readonly confidence?: number;
}

export interface SegmentSpeechResultItem {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SegmentSpeechResultAlternative;
}

export interface SegmentSpeechEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SegmentSpeechResultItem;
  };
}

export interface SegmentSpeechErrorEvent {
  readonly error?: string;
}

export interface SegmentSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SegmentSpeechEvent) => void) | null;
  onerror: ((event: SegmentSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: (audioTrack?: MediaStreamTrack) => void;
  stop: () => void;
  abort?: () => void;
}

export interface LocalSegmentContextSnapshot {
  readonly sessionId?: string | null;
  readonly pageId?: string | null;
  readonly keyterms?: readonly string[];
}

const TARGET_SAMPLE_RATE = 16_000;
const MIN_SPEECH_RMS_ONSET = 0.0028;
const MIN_SPEECH_RMS_HOLD = 0.0016;
const INITIAL_NOISE_FLOOR = 0.0018;
const MAX_NOISE_FLOOR = 0.0055;
const MIN_NOISE_FLOOR = 0.0009;
const SILENCE_FLUSH_MS = 720;
const MIN_SPEECH_MS = 120;
const MAX_SEGMENT_MS = 4_500;
const INTERIM_MIN_SPEECH_MS = 280;
const INTERIM_STEP_MS = 320;
const PRE_ROLL_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.45);
const QUIET_TAIL_CARRY_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.35);
const MAX_FLUSH_TRAILING_SILENCE_SAMPLES = Math.floor(
  TARGET_SAMPLE_RATE * 0.18,
);
const OVERLAP_CARRY_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.32);
const INTERIM_MIN_SAMPLES = Math.floor(
  (TARGET_SAMPLE_RATE * INTERIM_MIN_SPEECH_MS) / 1000,
);
const INTERIM_STEP_SAMPLES = Math.floor(
  (TARGET_SAMPLE_RATE * INTERIM_STEP_MS) / 1000,
);
export const EMERGENCY_FAILURE_THRESHOLD = 2;
export const LOCAL_OUTAGE_RETRY_MS = 45_000;

let lastLocalSttOutageAt = 0;

export function resetLocalSttEmergencyStateForTests(): void {
  lastLocalSttOutageAt = 0;
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE || inputRate <= 0) {
    return new Float32Array(input);
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio) + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

export function encodeFloat32ToWav16kBlob(samples: Float32Array): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function nextTurnId(prefix: string, seq: number): string {
  return `${prefix}_seg_${Date.now().toString(36)}_${seq}`;
}

function lcsIndexPairs(
  left: readonly string[],
  right: readonly string[],
): Array<[number, number]> {
  const m = left.length;
  const n = right.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (left[i] === right[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function containsOrderedSubsequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Reconciles a final STT transcript against earlier rolling interim transcripts
 * decoded from the **exact same speech segment** when trailing silence caused
 * beam search to flip or drop a completed word (e.g. interim `"chú mèo tên"` vs
 * final `"chú em tên"`).
 *
 * Strict anti-hallucination invariants:
 * - Only ever uses words literally decoded by the local STT model on this exact segment.
 * - Preserves Vietnamese diacritics, tones, and `đ` (exact NFC token match).
 * - Only repairs spans strictly bounded on the right by a matching anchor token
 *   (so an incomplete cut-off last syllable of an interim can NEVER override the
 *   completed syllable in the final decode).
 * - Requires the interim span to match the exact ordered book word sequence with
 *   strictly stronger contextual support than the final span.
 */
export function reconcileSegmentTranscriptWithInterims(
  finalText: string,
  interimTranscripts: readonly string[],
  orderedKeyterms?: readonly string[],
): string {
  const normalizedFinal = finalText.normalize("NFC").trim();
  if (
    !normalizedFinal ||
    !interimTranscripts.length ||
    !orderedKeyterms?.length
  ) {
    return normalizedFinal;
  }
  const bookTokens = tokenizeVietnameseText(orderedKeyterms.join(" "));
  if (bookTokens.length < 2) return normalizedFinal;

  let currentTokens = tokenizeVietnameseText(normalizedFinal);
  if (currentTokens.length === 0) return normalizedFinal;

  const spanContextScore = (
    leftAnchor: string | null,
    span: readonly string[],
    rightAnchor: string,
  ): number => {
    if (span.length === 0) {
      return leftAnchor &&
        containsOrderedSubsequence(bookTokens, [leftAnchor, rightAnchor])
        ? 2
        : 0;
    }
    if (
      leftAnchor &&
      containsOrderedSubsequence(bookTokens, [leftAnchor, ...span, rightAnchor])
    ) {
      return 3;
    }
    const rightMatch = containsOrderedSubsequence(bookTokens, [
      ...span,
      rightAnchor,
    ]);
    const leftMatch = leftAnchor
      ? containsOrderedSubsequence(bookTokens, [leftAnchor, ...span])
      : false;
    if (leftMatch && rightMatch) return 2;
    if (rightMatch || leftMatch) return 1;
    return 0;
  };

  let changed = false;

  for (let idx = interimTranscripts.length - 1; idx >= 0; idx -= 1) {
    const interimTokens = tokenizeVietnameseText(interimTranscripts[idx] ?? "");
    if (interimTokens.length < 2) continue;

    const pairs = lcsIndexPairs(currentTokens, interimTokens);
    if (pairs.length === 0) continue;

    const rebuilt: string[] = [];
    let prevR = -1;
    let prevI = -1;

    for (const [rAnchor, iAnchor] of pairs) {
      const rSpan = currentTokens.slice(prevR + 1, rAnchor);
      const iSpan = interimTokens.slice(prevI + 1, iAnchor);
      const leftAnchor = prevR >= 0 ? currentTokens[prevR] : null;
      const rightAnchor = currentTokens[rAnchor];

      const eligibleSpan =
        iSpan.length >= 1 &&
        iSpan.length <= 2 &&
        rSpan.length <= 2 &&
        (rSpan.length !== iSpan.length ||
          rSpan.some((tok, pos) => tok !== iSpan[pos]));

      if (eligibleSpan) {
        const interimScore = spanContextScore(leftAnchor, iSpan, rightAnchor);
        const finalScore = spanContextScore(leftAnchor, rSpan, rightAnchor);
        const minRequiredScore = rSpan.length === 0 ? 3 : leftAnchor ? 2 : 1;
        if (interimScore >= minRequiredScore && interimScore > finalScore) {
          rebuilt.push(...iSpan);
          changed = true;
        } else {
          rebuilt.push(...rSpan);
        }
      } else {
        rebuilt.push(...rSpan);
      }

      rebuilt.push(rightAnchor);
      prevR = rAnchor;
      prevI = iAnchor;
    }

    // Always keep the final's trailing tokens after the last matching anchor intact
    // so an incomplete cut-off interim syllable never overrides a completed final word.
    if (prevR + 1 < currentTokens.length) {
      rebuilt.push(...currentTokens.slice(prevR + 1));
    }
    currentTokens = rebuilt;
  }

  return changed ? currentTokens.join(" ") : normalizedFinal;
}

const TECHNICAL_STT_UNAVAILABLE_CODES = new Set<string>([
  "STT_TEMPORARILY_UNAVAILABLE",
  "STT_UNAVAILABLE",
  "LOCAL_STT_UNAVAILABLE",
  "LOCAL_STT_TIMEOUT",
  "LOCAL_STT_BUSY",
  "GOOGLE_STT_UNCONFIGURED",
  "GOOGLE_STT_UNAVAILABLE",
  "STT_NETWORK_ERROR",
  "STT_TIMEOUT",
  "STT_RATE_LIMITED",
  "STT_CONCURRENCY_LIMITED",
]);

export function isTechnicalSttUnavailabilityError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof TypeError) return true;
  if (error instanceof ServiceError) {
    if (error.status >= 500 || error.status === 429 || error.status === 0) {
      return true;
    }
    return TECHNICAL_STT_UNAVAILABLE_CODES.has(String(error.code));
  }
  if (typeof error === "object") {
    const rec = error as {
      status?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (
      typeof rec.status === "number" &&
      (rec.status >= 500 || rec.status === 429 || rec.status === 0)
    ) {
      return true;
    }
    const code = typeof rec.code === "string" ? rec.code : "";
    if (TECHNICAL_STT_UNAVAILABLE_CODES.has(code)) return true;
    const message = typeof rec.message === "string" ? rec.message : "";
    const combined = `${code} ${message}`;
    for (const marker of TECHNICAL_STT_UNAVAILABLE_CODES) {
      if (combined.includes(marker)) return true;
    }
    return (
      combined.includes("503") ||
      combined.includes("502") ||
      combined.includes("504")
    );
  }
  return false;
}

function getBrowserSpeechRecognitionCtor():
  (new () => SegmentSpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const win = window as unknown as {
    SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SegmentSpeechRecognitionLike;
  };
  const ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
  return typeof ctor === "function" ? ctor : undefined;
}

export class LocalSegmentSpeechRecognition implements SegmentSpeechRecognitionLike {
  continuous = true;
  interimResults = true;
  lang = "vi-VN";
  maxAlternatives = 1;
  onresult: ((event: SegmentSpeechEvent) => void) | null = null;
  onerror: ((event: SegmentSpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;

  private active = false;
  private stopping = false;
  private ownedStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private abortController: AbortController | null = null;
  private resultsHistory: SegmentSpeechResultItem[] = [];
  private preRoll: Float32Array = new Float32Array(0);
  private speechChunks: Float32Array[] = [];
  private speechSamples = 0;
  private silenceSamples = 0;
  private quietFrameStreak = 0;
  private inSpeech = false;
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private turnSeq = 0;
  private lastInterimSpeechSamples = 0;
  private interimInFlight = false;
  private interimGeneration = 0;
  private segmentInterims: string[] = [];
  private pendingUploads: Set<Promise<void>> = new Set();
  private uploadChain: Promise<void> = Promise.resolve();
  private browserFallbackRec: SegmentSpeechRecognitionLike | null = null;
  private usingBrowserFallback = false;
  private browserBaseOffset = 0;
  private consecutiveTechnicalFailures = 0;

  constructor(
    private readonly speechService: SpeechService,
    private readonly getContext?: () => LocalSegmentContextSnapshot,
  ) {}

  /** True while the child is currently speaking or an STT segment upload is still in flight. */
  hasPendingUploads(): boolean {
    if (this.usingBrowserFallback) return false;
    return this.inSpeech || this.pendingUploads.size > 0;
  }

  start(audioTrack?: MediaStreamTrack): void {
    if (this.active) return;
    this.active = true;
    this.stopping = false;
    this.usingBrowserFallback = false;
    this.browserFallbackRec = null;
    this.browserBaseOffset = 0;
    this.abortController = new AbortController();
    this.resultsHistory = [];
    this.uploadChain = Promise.resolve();
    this.consecutiveTechnicalFailures = 0;
    this.resetSegmentState();

    const policy = getVoicePolicyPreferences();
    const freshHealth = getFreshVoiceEngineHealth();
    const localHealthy =
      freshHealth !== null &&
      freshHealth.local.available &&
      freshHealth.local.stt_ready;

    if (localHealthy) {
      // Local worker recovered -> immediately clear any emergency cooldown and stay 100% Offline!
      lastLocalSttOutageAt = 0;
      if (getVoiceEngineStatus().stt.fallbackUsed) {
        recordSttEngineUsage({
          provider: "local",
          fallbackUsed: false,
          fallbackReason: null,
        });
      }
    } else if (
      policy.providerMode === "local_with_google_fallback" &&
      policy.allowGoogleSttFallback
    ) {
      const confirmedLocalDownNoGoogle =
        freshHealth !== null &&
        (!freshHealth.local.available || !freshHealth.local.stt_ready) &&
        (!freshHealth.google.stt_configured || freshHealth.google.stt_cooldown);
      const now = Date.now();
      const withinEmergencyCooldown =
        lastLocalSttOutageAt > 0 &&
        now - lastLocalSttOutageAt < LOCAL_OUTAGE_RETRY_MS &&
        getVoiceEngineStatus().stt.tier === "browser_default";

      if (confirmedLocalDownNoGoogle || withinEmergencyCooldown) {
        if (confirmedLocalDownNoGoogle) {
          lastLocalSttOutageAt = now;
        }
        if (this.tryActivateBrowserFallback()) {
          return;
        }
      } else if (
        lastLocalSttOutageAt > 0 &&
        now - lastLocalSttOutageAt >= LOCAL_OUTAGE_RETRY_MS
      ) {
        // Emergency cooldown TTL elapsed -> automatically re-try Local Offline STT!
        lastLocalSttOutageAt = 0;
      }
    }

    void this.openAudioGraph(audioTrack);
  }

  stop(): void {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    if (this.usingBrowserFallback && this.browserFallbackRec) {
      try {
        this.browserFallbackRec.stop();
      } catch {
        this.browserFallbackRec = null;
        this.usingBrowserFallback = false;
        this.active = false;
        this.stopping = false;
        this.onend?.();
      }
      return;
    }
    // Flush any pending speech segment before emitting onend
    if (
      this.inSpeech &&
      this.speechSamples >= (TARGET_SAMPLE_RATE * MIN_SPEECH_MS) / 1000
    ) {
      this.flushCurrentSegment();
    } else {
      this.resetSegmentState();
    }
    this.teardownAudioGraph();
    const inflight = Array.from(this.pendingUploads);
    void Promise.allSettled(inflight).finally(() => {
      this.active = false;
      this.stopping = false;
      this.onend?.();
    });
  }

  abort(): void {
    if (!this.active) return;
    this.active = false;
    this.stopping = false;
    this.abortController?.abort();
    const fallbackRec = this.browserFallbackRec;
    this.browserFallbackRec = null;
    this.usingBrowserFallback = false;
    if (fallbackRec) {
      try {
        if (typeof fallbackRec.abort === "function") {
          fallbackRec.abort();
        } else {
          fallbackRec.stop();
        }
      } catch {
        // Ignore teardown errors
      }
    }
    this.resetSegmentState();
    this.teardownAudioGraph();
    this.onend?.();
  }

  private recordTechnicalFailureAndMaybeFallback(): boolean {
    this.consecutiveTechnicalFailures += 1;
    const freshHealth = getFreshVoiceEngineHealth();
    const confirmedLocalOutage =
      freshHealth !== null &&
      (!freshHealth.local.available || !freshHealth.local.stt_ready);
    if (
      confirmedLocalOutage ||
      this.consecutiveTechnicalFailures >= EMERGENCY_FAILURE_THRESHOLD
    ) {
      lastLocalSttOutageAt = Date.now();
      return this.tryActivateBrowserFallback();
    }
    return false;
  }

  private tryActivateBrowserFallback(): boolean {
    if (!this.active || this.stopping || this.usingBrowserFallback) {
      return false;
    }
    const policy = getVoicePolicyPreferences();
    if (
      policy.providerMode !== "local_with_google_fallback" ||
      !policy.allowGoogleSttFallback
    ) {
      return false;
    }
    const BrowserCtor = getBrowserSpeechRecognitionCtor();
    if (!BrowserCtor) {
      return false;
    }

    this.usingBrowserFallback = true;
    this.abortController?.abort();
    this.resetSegmentState();
    this.teardownAudioGraph();

    let nativeRec: SegmentSpeechRecognitionLike;
    try {
      nativeRec = new BrowserCtor();
    } catch {
      this.usingBrowserFallback = false;
      return false;
    }

    nativeRec.lang = this.lang || "vi-VN";
    nativeRec.continuous = this.continuous;
    nativeRec.interimResults = this.interimResults;
    nativeRec.maxAlternatives = this.maxAlternatives;
    this.browserFallbackRec = nativeRec;
    this.browserBaseOffset = this.resultsHistory.length;

    nativeRec.onresult = (ev: SegmentSpeechEvent) => {
      if (!this.active || this.browserFallbackRec !== nativeRec) return;
      const base = this.browserBaseOffset;
      const totalLength = base + ev.results.length;
      const resultsObj: Record<number, SegmentSpeechResultItem> & {
        length: number;
      } = { length: totalLength };
      for (let i = 0; i < base; i += 1) {
        resultsObj[i] = this.resultsHistory[i];
      }
      for (let i = 0; i < ev.results.length; i += 1) {
        const item = ev.results[i];
        resultsObj[base + i] = item;
        if (item?.isFinal) {
          this.resultsHistory[base + i] = item;
        }
      }
      this.onresult?.({
        resultIndex: base + ev.resultIndex,
        results: resultsObj,
      });
    };

    nativeRec.onerror = (ev: SegmentSpeechErrorEvent) => {
      if (
        !this.active ||
        this.stopping ||
        this.browserFallbackRec !== nativeRec
      ) {
        return;
      }
      this.onerror?.(ev);
    };

    nativeRec.onend = () => {
      if (this.browserFallbackRec !== nativeRec) return;
      if (this.active && !this.stopping && this.continuous) {
        try {
          this.browserBaseOffset = this.resultsHistory.length;
          nativeRec.start();
          return;
        } catch {
          // Fall through to clean termination
        }
      }
      this.browserFallbackRec = null;
      this.usingBrowserFallback = false;
      this.active = false;
      this.stopping = false;
      this.onend?.();
    };

    recordSttEngineUsage({
      provider: "browser",
      fallbackUsed: true,
      fallbackReason: "LOCAL_STT_UNAVAILABLE",
    });

    try {
      nativeRec.start();
      return true;
    } catch {
      this.browserFallbackRec = null;
      this.usingBrowserFallback = false;
      return false;
    }
  }

  private resetSegmentState(): void {
    this.preRoll = new Float32Array(0);
    this.speechChunks = [];
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.inSpeech = false;
    this.segmentInterims = [];
  }

  private teardownAudioGraph(): void {
    try {
      if (this.processorNode) {
        this.processorNode.onaudioprocess = null;
        this.processorNode.disconnect();
      }
    } catch {
      // Ignore disconnect errors
    }
    this.processorNode = null;
    try {
      this.sourceNode?.disconnect();
    } catch {
      // Ignore
    }
    this.sourceNode = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    if (this.ownedStream) {
      this.ownedStream.getTracks().forEach((t) => t.stop());
      this.ownedStream = null;
    }
  }

  private async openAudioGraph(audioTrack?: MediaStreamTrack): Promise<void> {
    try {
      let stream: MediaStream;
      if (audioTrack && audioTrack.readyState === "live") {
        stream = new MediaStream([audioTrack]);
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("not-allowed");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (!this.active || this.stopping) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.ownedStream = stream;
      }

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("audio-capture");
      }
      const ctx = new AudioCtx();
      this.audioCtx = ctx;
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => undefined);
        if (ctx.state === "suspended") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          await ctx.resume().catch(() => undefined);
        }
      }

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      this.sourceNode = source;
      this.processorNode = processor;

      processor.onaudioprocess = (ev: AudioProcessingEvent) => {
        if (!this.active || this.stopping) return;
        const raw = ev.inputBuffer.getChannelData(0);
        const mono16 = downsampleTo16k(raw, ctx.sampleRate);
        this.consumeSamples16k(mono16);
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);
    } catch (err) {
      if (!this.active) return;
      this.active = false;
      this.teardownAudioGraph();
      const isDenied =
        err instanceof Error &&
        (err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError" ||
          err.message === "not-allowed");
      this.onerror?.({ error: isDenied ? "not-allowed" : "audio-capture" });
      this.onend?.();
    }
  }

  private consumeSamples16k(chunk: Float32Array): void {
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = chunk[i];
      sumSq += sample * sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, chunk.length));
    const onsetThreshold = Math.max(
      MIN_SPEECH_RMS_ONSET,
      this.noiseFloor * 2.0,
    );
    const holdThreshold = Math.max(MIN_SPEECH_RMS_HOLD, this.noiseFloor * 1.4);
    const isOnsetFrame = rms >= onsetThreshold || peak >= onsetThreshold * 3.0;
    const isVoicedFrame = rms >= holdThreshold || peak >= holdThreshold * 3.0;

    if (!this.inSpeech) {
      if (isOnsetFrame) {
        this.inSpeech = true;
        this.silenceSamples = 0;
        this.quietFrameStreak = 0;
        if (this.preRoll.length > 0) {
          this.speechChunks.push(this.preRoll);
          this.speechSamples += this.preRoll.length;
          this.preRoll = new Float32Array(0);
        }
        this.speechChunks.push(chunk);
        this.speechSamples += chunk.length;
      } else {
        this.noiseFloor = Math.min(
          MAX_NOISE_FLOOR,
          Math.max(MIN_NOISE_FLOOR, this.noiseFloor * 0.95 + rms * 0.05),
        );
        const merged = new Float32Array(this.preRoll.length + chunk.length);
        merged.set(this.preRoll, 0);
        merged.set(chunk, this.preRoll.length);
        this.preRoll =
          merged.length > PRE_ROLL_SAMPLES
            ? merged.slice(merged.length - PRE_ROLL_SAMPLES)
            : merged;
      }
      return;
    }

    this.speechChunks.push(chunk);
    this.speechSamples += chunk.length;
    if (!isVoicedFrame) {
      this.quietFrameStreak += 1;
      // Ignore single-frame (~42ms) glottal dips inside Vietnamese hỏi/ngã/nặng/huyền tones
      if (this.quietFrameStreak >= 2) {
        this.silenceSamples += chunk.length;
      }
    } else {
      this.quietFrameStreak = 0;
      this.silenceSamples = 0;
    }

    const silenceMs = (this.silenceSamples / TARGET_SAMPLE_RATE) * 1000;
    const speechMs = (this.speechSamples / TARGET_SAMPLE_RATE) * 1000;

    if (silenceMs >= SILENCE_FLUSH_MS && speechMs >= MIN_SPEECH_MS) {
      this.flushCurrentSegment(false);
    } else if (speechMs >= MAX_SEGMENT_MS) {
      this.flushCurrentSegment(true);
    } else if (
      this.interimResults &&
      !this.interimInFlight &&
      this.speechSamples >= INTERIM_MIN_SAMPLES &&
      this.speechSamples - this.lastInterimSpeechSamples >= INTERIM_STEP_SAMPLES
    ) {
      this.dispatchRollingInterim();
    }
  }

  /**
   * Real rolling partial decode (~320ms cadence) while the child is still speaking.
   * Emits `isFinal: false` preview-only transcripts so word highlighting tracks the
   * child's voice smoothly without fake timers and without mutating final scores.
   */
  private dispatchRollingInterim(): void {
    if (
      !this.active ||
      this.stopping ||
      !this.inSpeech ||
      !this.speechChunks.length
    ) {
      return;
    }
    const total = this.speechSamples;
    const combined = new Float32Array(total);
    let offset = 0;
    for (const part of this.speechChunks) {
      combined.set(part, offset);
      offset += part.length;
    }
    this.lastInterimSpeechSamples = total;
    this.interimInFlight = true;
    const gen = this.interimGeneration;
    const activeSegmentInterims = this.segmentInterims;
    const wavBlob = encodeFloat32ToWav16kBlob(combined);
    const ctx = this.getContext?.() ?? {};
    const signal = this.abortController?.signal;

    void this.speechService
      .transcribe(wavBlob, {
        filename: "interim.wav",
        languageCode: "vi",
        keyterms: ctx.keyterms,
        sessionId: ctx.sessionId ?? null,
        pageId: ctx.pageId ?? null,
        source: "local_live_interim",
        signal,
        timeoutMs: 4_000,
      })
      .then((res) => {
        this.consecutiveTechnicalFailures = 0;
        lastLocalSttOutageAt = 0;
        const text = (res.text ?? "").normalize("NFC").trim();
        if (!text) return;
        if (activeSegmentInterims[activeSegmentInterims.length - 1] !== text) {
          activeSegmentInterims.push(text);
          if (activeSegmentInterims.length > 12) {
            activeSegmentInterims.shift();
          }
        }
        if (
          !this.active ||
          this.stopping ||
          !this.inSpeech ||
          gen !== this.interimGeneration
        ) {
          return;
        }
        const resultIndex = this.resultsHistory.length;
        const interimItem: SegmentSpeechResultItem = {
          isFinal: false,
          length: 1,
          0: {
            transcript: text,
            confidence: 0,
          },
        };
        const resultsObj: Record<number, SegmentSpeechResultItem> & {
          length: number;
        } = { length: this.resultsHistory.length + 1 };
        for (let i = 0; i < this.resultsHistory.length; i += 1) {
          resultsObj[i] = this.resultsHistory[i];
        }
        resultsObj[resultIndex] = interimItem;
        this.onresult?.({
          resultIndex,
          results: resultsObj,
        });
      })
      .catch((err) => {
        if (isTechnicalSttUnavailabilityError(err)) {
          this.recordTechnicalFailureAndMaybeFallback();
        }
      })
      .finally(() => {
        this.interimInFlight = false;
      });
  }

  private flushCurrentSegment(carryOverlap = false): void {
    this.interimGeneration += 1;
    this.lastInterimSpeechSamples = 0;
    if (!this.speechChunks.length) {
      this.resetSegmentState();
      return;
    }
    const total = this.speechSamples;
    const silenceTailSamples = this.silenceSamples;
    const capturedInterims = this.segmentInterims;
    const combined = new Float32Array(total);
    let offset = 0;
    for (const part of this.speechChunks) {
      combined.set(part, offset);
      offset += part.length;
    }
    // Always preserve a rolling pre-roll across flushes!
    // - On silence flush: carry the quiet tail (<= 350ms, strictly within silenceTailSamples)
    //   so the onset of the very next sentence's first word is NEVER chopped, with zero duplication.
    // - On max-length forced flush: carry 320ms overlap so mid-sentence syllables aren't split.
    const carryCount = carryOverlap
      ? Math.min(combined.length, OVERLAP_CARRY_SAMPLES)
      : Math.min(combined.length, silenceTailSamples, QUIET_TAIL_CARRY_SAMPLES);
    const preservedPreRoll =
      carryCount > 0 ? combined.slice(combined.length - carryCount) : null;
    this.resetSegmentState();
    this.quietFrameStreak = 0;
    if (preservedPreRoll) {
      this.preRoll = preservedPreRoll;
    }

    // Trim excess trailing silence beyond 180ms before encoding WAV so 720ms of trailing
    // room noise never degrades Sherpa-ONNX decoding compared to the clean rolling interim.
    let audioToEncode = combined;
    if (
      !carryOverlap &&
      silenceTailSamples > MAX_FLUSH_TRAILING_SILENCE_SAMPLES
    ) {
      const trimCount = silenceTailSamples - MAX_FLUSH_TRAILING_SILENCE_SAMPLES;
      const keepLength = Math.max(
        Math.floor((TARGET_SAMPLE_RATE * MIN_SPEECH_MS) / 1000),
        combined.length - trimCount,
      );
      if (keepLength < combined.length) {
        audioToEncode = combined.subarray(0, keepLength);
      }
    }

    const wavBlob = encodeFloat32ToWav16kBlob(audioToEncode);
    const seq = ++this.turnSeq;
    const ctx = this.getContext?.() ?? {};
    const turnId = nextTurnId(ctx.pageId ?? "live", seq);
    const signal = this.abortController?.signal;

    const transcribeOnce = () =>
      this.speechService.transcribe(wavBlob, {
        filename: "segment.wav",
        languageCode: "vi",
        keyterms: ctx.keyterms,
        sessionId: ctx.sessionId ?? null,
        pageId: ctx.pageId ?? null,
        turnId,
        source: "local_live_segment",
        signal,
        timeoutMs: 12_000,
      });

    const transcribeWithRetry = async () => {
      try {
        return await transcribeOnce();
      } catch (err) {
        if (
          signal?.aborted ||
          this.usingBrowserFallback ||
          (!this.active && !this.stopping)
        ) {
          throw err;
        }
        if (
          isTechnicalSttUnavailabilityError(err) &&
          this.recordTechnicalFailureAndMaybeFallback()
        ) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (
          signal?.aborted ||
          this.usingBrowserFallback ||
          (!this.active && !this.stopping)
        ) {
          throw err;
        }
        return await transcribeOnce();
      }
    };

    // Start upload immediately, but deliver results strictly in FIFO order via uploadChain
    // so segment N+1 NEVER overtakes segment N and causes false RED alignment skips!
    const responsePromise = transcribeWithRetry();
    const deliveryTask = this.uploadChain
      .then(async () => {
        const res = await responsePromise;
        this.consecutiveTechnicalFailures = 0;
        lastLocalSttOutageAt = 0;
        if (this.usingBrowserFallback || (!this.active && !this.stopping)) {
          return;
        }
        const rawText = (res.text ?? "").normalize("NFC").trim();
        if (!rawText) return;
        const text = reconcileSegmentTranscriptWithInterims(
          rawText,
          capturedInterims,
          ctx.keyterms,
        );
        if (!text) return;
        const resultIndex = this.resultsHistory.length;
        const item: SegmentSpeechResultItem = {
          isFinal: true,
          length: 1,
          0: {
            transcript: text,
            // 0 denotes uncalibrated confidence so recognition-evidence treats it honestly
            confidence: 0,
          },
        };
        this.resultsHistory.push(item);
        const resultsObj: Record<number, SegmentSpeechResultItem> & {
          length: number;
        } = { length: this.resultsHistory.length };
        for (let i = 0; i < this.resultsHistory.length; i += 1) {
          resultsObj[i] = this.resultsHistory[i];
        }
        this.onresult?.({
          resultIndex,
          results: resultsObj,
        });
      })
      .catch((err) => {
        if (isTechnicalSttUnavailabilityError(err)) {
          this.recordTechnicalFailureAndMaybeFallback();
        }
      })
      .finally(() => {
        this.pendingUploads.delete(deliveryTask);
      });

    this.uploadChain = deliveryTask;
    this.pendingUploads.add(deliveryTask);
  }
}

export function isInjectedTestSpeechRecognition(
  ctor: unknown,
): ctor is new () => SegmentSpeechRecognitionLike {
  if (typeof ctor !== "function") return false;
  try {
    const src = Function.prototype.toString.call(ctor);
    return !src.includes("[native code]");
  } catch {
    return false;
  }
}

/**
 * Returns the injected mock constructor in unit/E2E tests, and otherwise returns
 * a `LocalSegmentSpeechRecognition` constructor in all real browsers & Android
 * APK WebViews so Chrome's cloud `webkitSpeechRecognition` is never invoked!
 */
export function resolveLocalFirstSpeechRecognitionConstructor(
  win: {
    SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SegmentSpeechRecognitionLike;
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  },
  speechService: SpeechService,
  getContext?: () => LocalSegmentContextSnapshot,
  getLiveTrack?: () => MediaStreamTrack | undefined,
): (new () => SegmentSpeechRecognitionLike) | undefined {
  const candidate = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (isInjectedTestSpeechRecognition(candidate)) {
    return candidate;
  }
  const explicitlyDisabled =
    Object.prototype.hasOwnProperty.call(win, "SpeechRecognition") &&
    win.SpeechRecognition === undefined &&
    Object.prototype.hasOwnProperty.call(win, "webkitSpeechRecognition") &&
    win.webkitSpeechRecognition === undefined;
  if (explicitlyDisabled) {
    return undefined;
  }
  const hasNativeWebSpeech = typeof candidate === "function";
  const hasWebAudio =
    typeof win.AudioContext === "function" ||
    typeof win.webkitAudioContext === "function";
  if (!hasNativeWebSpeech && !hasWebAudio) {
    return undefined;
  }
  return class BoundLocalSegmentSpeechRecognition extends LocalSegmentSpeechRecognition {
    constructor() {
      super(speechService, getContext);
    }
    override start(audioTrack?: MediaStreamTrack): void {
      super.start(audioTrack ?? getLiveTrack?.());
    }
  };
}
