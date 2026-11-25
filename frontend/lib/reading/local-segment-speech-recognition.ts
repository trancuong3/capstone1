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
import {
  AndroidNativeSpeechRecognition,
  getCachedAndroidSpeechCapabilities,
  isAndroidNativeSpeechAvailable,
} from "@/lib/reading/native-speech-bridge";
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

export interface SegmentAudioQuality {
  readonly status: "OK" | "LOW_VOLUME" | "CLIPPING" | "AUDIO_TOO_SHORT";
  readonly rms: number;
  readonly peak: number;
  readonly speechDurationMs: number;
}

export interface SegmentSpeechResultItem {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SegmentSpeechResultAlternative;
  /** Monotonic capture epoch incremented on start/stop/abort. */
  readonly epoch?: number;
  /** Session / page metadata for cross-page/quiz staleness fencing. */
  readonly sessionId?: string | null;
  readonly pageId?: string | null;
  readonly turnId?: string;
  readonly segmentId?: string;
  /** Monotonic `performance.now()` timestamp when speech onset started. */
  readonly onsetAt?: number | null;
  /** Monotonic `performance.now()` timestamp when audio slice ended. */
  readonly audioEndedAt?: number | null;
  /** Total voiced speech duration in milliseconds for this segment. */
  readonly speechDurationMs?: number | null;
  /** Acoustic quality telemetry from captured 16kHz mono PCM. */
  readonly audioQuality?: SegmentAudioQuality;
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
const SILENCE_FLUSH_MS = 520;
const CLAUSE_FLUSH_MIN_SPEECH_MS = 1_800;
const CLAUSE_FLUSH_SILENCE_MS = 160;
const MIN_SPEECH_MS = 120;
const MAX_SEGMENT_MS = 3_600;
const INTERIM_MIN_SPEECH_MS = 140;
const INTERIM_STEP_MS = 440;
const PAUSE_INTERIM_SILENCE_MS = 100;
const MIN_NEW_VOICED_INTERIM_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.08);
const MAX_INTERIM_TRAILING_SILENCE_SAMPLES = Math.floor(
  TARGET_SAMPLE_RATE * 0.12,
);
const STALE_INTERIM_ABORT_MS = 750;
const PRE_ROLL_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.45);
const QUIET_TAIL_CARRY_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.35);
const MAX_FLUSH_TRAILING_SILENCE_SAMPLES = Math.floor(
  TARGET_SAMPLE_RATE * 0.16,
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
        // Off-book guard: if the final interim right before flush already
        // consistently decoded this same span (`rSpan`), never let an older
        // transient interim replace the child's actual spoken deviation.
        const latestInterimText =
          interimTranscripts[interimTranscripts.length - 1] ?? "";
        const isLastInterim = idx === interimTranscripts.length - 1;
        if (!isLastInterim && latestInterimText) {
          const latestInterimTokens = tokenizeVietnameseText(latestInterimText);
          if (
            containsOrderedSubsequence(
              latestInterimTokens,
              leftAnchor
                ? [leftAnchor, ...rSpan, rightAnchor]
                : [...rSpan, rightAnchor],
            )
          ) {
            rebuilt.push(...rSpan);
            rebuilt.push(rightAnchor);
            prevR = rAnchor;
            prevI = iAnchor;
            continue;
          }
        }
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
  "LOCAL_VOICE_UNCONFIGURED",
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

function isImmediateLocalOutageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rec = error as { code?: unknown; message?: unknown };
  const code = typeof rec.code === "string" ? rec.code : "";
  const message = typeof rec.message === "string" ? rec.message : "";
  const combined = `${code} ${message}`;
  return (
    combined.includes("LOCAL_VOICE_UNCONFIGURED") ||
    combined.includes("máy chủ giọng nói cục bộ chưa được bật")
  );
}

/**
 * Returns `true` when Android native `SpeechRecognizer` should handle STT
 * exclusively (skipping parallel WebView `getUserMedia`/`MediaRecorder` to
 * avoid Android audio HAL microphone contention).
 */
export function shouldPreferAndroidNativeStt(): boolean {
  if (!isAndroidNativeSpeechAvailable()) return false;
  const caps = getCachedAndroidSpeechCapabilities();
  if (caps && !caps.sttAvailable) return false;
  const policy = getVoicePolicyPreferences();
  if (
    policy.providerMode !== "local_with_google_fallback" ||
    !policy.allowGoogleSttFallback
  ) {
    return false;
  }
  const freshHealth = getFreshVoiceEngineHealth();
  if (freshHealth) {
    if (freshHealth.local.available && freshHealth.local.stt_ready) {
      return false;
    }
    if (!freshHealth.google.stt_configured || freshHealth.google.stt_cooldown) {
      return true;
    }
  }
  const now = Date.now();
  const status = getVoiceEngineStatus().stt;
  return (
    lastLocalSttOutageAt > 0 &&
    now - lastLocalSttOutageAt < LOCAL_OUTAGE_RETRY_MS &&
    (status.tier === "android_native" || status.tier === "browser_default")
  );
}

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
  private workletNode: AudioWorkletNode | null = null;
  private workletUrl: string | null = null;
  private abortController: AbortController | null = null;
  private interimAbortController: AbortController | null = null;
  private interimStartedAt = 0;
  private resultsHistory: SegmentSpeechResultItem[] = [];
  private preRoll: Float32Array = new Float32Array(0);
  private speechChunks: Float32Array[] = [];
  private speechSamples = 0;
  private voicedSamples = 0;
  private silenceSamples = 0;
  private quietFrameStreak = 0;
  private inSpeech = false;
  private segmentOnsetAt: number | null = null;
  private segmentSumSq = 0;
  private segmentPeak = 0;
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private turnSeq = 0;
  private epoch = 0;
  private lastInterimSpeechSamples = 0;
  private lastInterimVoicedSamples = 0;
  private interimInFlight = false;
  private interimGeneration = 0;
  private segmentInterims: string[] = [];
  private pendingUploads: Set<Promise<void>> = new Set();
  private uploadChain: Promise<void> = Promise.resolve();
  private browserFallbackRec: SegmentSpeechRecognitionLike | null = null;
  private usingBrowserFallback = false;
  private browserBaseOffset = 0;
  private consecutiveTechnicalFailures = 0;
  private sttCircuitOpen = false;

  constructor(
    private readonly speechService: SpeechService,
    private readonly getContext?: () => LocalSegmentContextSnapshot,
    private readonly onBeforeExternalMicStart?: () => void,
  ) {}

  getEpoch(): number {
    return this.epoch;
  }

  /** True while the child is currently speaking or an STT segment upload is still in flight. */
  hasPendingUploads(): boolean {
    if (this.usingBrowserFallback) return false;
    return this.inSpeech || this.pendingUploads.size > 0;
  }

  start(audioTrack?: MediaStreamTrack): void {
    if (this.active) return;
    this.epoch += 1;
    this.active = true;
    this.stopping = false;
    this.usingBrowserFallback = false;
    this.browserFallbackRec = null;
    this.browserBaseOffset = 0;
    this.abortController = new AbortController();
    this.resultsHistory = [];
    this.uploadChain = Promise.resolve();
    this.consecutiveTechnicalFailures = 0;
    this.sttCircuitOpen = false;
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
        (getVoiceEngineStatus().stt.tier === "browser_default" ||
          getVoiceEngineStatus().stt.tier === "android_native");

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
    this.interimAbortController?.abort();
    this.interimAbortController = null;
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
    this.epoch += 1;
    this.active = false;
    this.stopping = false;
    this.interimAbortController?.abort();
    this.interimAbortController = null;
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

  private canActivateBrowserFallback(): boolean {
    const policy = getVoicePolicyPreferences();
    const caps = getCachedAndroidSpeechCapabilities();
    const androidAvailable =
      isAndroidNativeSpeechAvailable() && (caps ? caps.sttAvailable : true);
    return (
      policy.providerMode === "local_with_google_fallback" &&
      policy.allowGoogleSttFallback &&
      (androidAvailable || Boolean(getBrowserSpeechRecognitionCtor()))
    );
  }

  private tripServiceCircuitBreaker(): void {
    if (this.sttCircuitOpen || !this.active) return;
    this.sttCircuitOpen = true;
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
    this.onerror?.({ error: "stt-unavailable" });
  }

  private recordTechnicalFailureAndMaybeFallback(error?: unknown): boolean {
    this.consecutiveTechnicalFailures += 1;
    const freshHealth = getFreshVoiceEngineHealth();
    const confirmedLocalOutage =
      freshHealth !== null &&
      (!freshHealth.local.available || !freshHealth.local.stt_ready);
    if (
      isImmediateLocalOutageError(error) ||
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

    const caps = getCachedAndroidSpeechCapabilities();
    const useAndroidNative =
      isAndroidNativeSpeechAvailable() && (caps ? caps.sttAvailable : true);
    const BrowserCtor = useAndroidNative
      ? undefined
      : getBrowserSpeechRecognitionCtor();
    if (!useAndroidNative && !BrowserCtor) {
      return false;
    }

    this.usingBrowserFallback = true;
    this.abortController?.abort();
    this.resetSegmentState();
    this.teardownAudioGraph();
    if (useAndroidNative) {
      // Release any parallel WebView MediaStream BEFORE Android SpeechRecognizer claims the HAL mic!
      try {
        this.onBeforeExternalMicStart?.();
      } catch {
        // Ignore caller cleanup errors
      }
    }

    let nativeRec: SegmentSpeechRecognitionLike;
    try {
      nativeRec = useAndroidNative
        ? new AndroidNativeSpeechRecognition()
        : new BrowserCtor!();
    } catch {
      this.usingBrowserFallback = false;
      return false;
    }

    nativeRec.lang = this.lang || "vi-VN";
    nativeRec.continuous = this.continuous;
    nativeRec.interimResults = this.interimResults;
    nativeRec.maxAlternatives = useAndroidNative
      ? Math.max(3, this.maxAlternatives)
      : this.maxAlternatives;
    this.browserFallbackRec = nativeRec;
    this.browserBaseOffset = this.resultsHistory.length;
    let fatalFallbackError = false;

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
      if (
        ev.error === "not-allowed" ||
        ev.error === "service-not-allowed" ||
        ev.error === "language-not-supported" ||
        ev.error === "audio-capture" ||
        ev.error === "stt-unavailable" ||
        ev.error === "network"
      ) {
        fatalFallbackError = true;
      }
      this.onerror?.(ev);
    };

    nativeRec.onend = () => {
      if (this.browserFallbackRec !== nativeRec) return;
      if (
        this.active &&
        !this.stopping &&
        this.continuous &&
        !fatalFallbackError
      ) {
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
      provider: useAndroidNative ? "android_native" : "browser",
      fallbackUsed: true,
      fallbackReason: useAndroidNative
        ? "ANDROID_NATIVE_STT"
        : "LOCAL_STT_UNAVAILABLE",
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
    this.voicedSamples = 0;
    this.silenceSamples = 0;
    this.inSpeech = false;
    this.segmentOnsetAt = null;
    this.segmentSumSq = 0;
    this.segmentPeak = 0;
    this.segmentInterims = [];
    this.lastInterimVoicedSamples = 0;
  }

  private teardownAudioGraph(): void {
    try {
      this.interimAbortController?.abort();
    } catch {
      // Ignore abort errors
    }
    this.interimAbortController = null;
    this.interimInFlight = false;
    try {
      if (this.workletNode) {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      }
    } catch {
      // Ignore disconnect errors
    }
    this.workletNode = null;
    if (this.workletUrl) {
      try {
        URL.revokeObjectURL(this.workletUrl);
      } catch {
        // Ignore
      }
      this.workletUrl = null;
    }
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
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      this.sourceNode = source;

      let workletAttached = false;
      if (
        typeof AudioWorkletNode === "function" &&
        ctx.audioWorklet &&
        typeof ctx.audioWorklet.addModule === "function" &&
        typeof URL !== "undefined" &&
        typeof URL.createObjectURL === "function"
      ) {
        try {
          const workletCode = `
            class ViReadCaptureProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this._buf = [];
                this._len = 0;
                this._targetChunk = Math.max(256, Math.round(sampleRate * 0.02));
              }
              process(inputs) {
                const input = inputs[0]?.[0];
                if (!input) return true;
                this._buf.push(new Float32Array(input));
                this._len += input.length;
                if (this._len >= this._targetChunk) {
                  const out = new Float32Array(this._len);
                  let off = 0;
                  for (const part of this._buf) {
                    out.set(part, off);
                    off += part.length;
                  }
                  this._buf = [];
                  this._len = 0;
                  this.port.postMessage(out, [out.buffer]);
                }
                return true;
              }
            }
            registerProcessor("viread-capture-processor", ViReadCaptureProcessor);
          `;
          const blob = new Blob([workletCode], {
            type: "application/javascript",
          });
          const workletUrl = URL.createObjectURL(blob);
          this.workletUrl = workletUrl;
          await ctx.audioWorklet.addModule(workletUrl);
          if (!this.active || this.stopping) {
            this.teardownAudioGraph();
            return;
          }
          const worklet = new AudioWorkletNode(ctx, "viread-capture-processor");
          worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => {
            if (!this.active || this.stopping) return;
            const raw = ev.data;
            if (!raw?.length) return;
            const mono16 = downsampleTo16k(raw, ctx.sampleRate);
            this.consumeSamples16k(mono16);
          };
          this.workletNode = worklet;
          source.connect(worklet);
          worklet.connect(silentGain);
          silentGain.connect(ctx.destination);
          workletAttached = true;
        } catch {
          workletAttached = false;
        }
      }

      if (!workletAttached) {
        const processor = ctx.createScriptProcessor(512, 1, 1);
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
      }
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
        this.segmentOnsetAt =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        this.segmentSumSq = sumSq;
        this.segmentPeak = peak;
        if (this.preRoll.length > 0) {
          this.speechChunks.push(this.preRoll);
          this.speechSamples += this.preRoll.length;
          this.preRoll = new Float32Array(0);
        }
        this.speechChunks.push(chunk);
        this.speechSamples += chunk.length;
        this.voicedSamples += chunk.length;
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
      this.voicedSamples += chunk.length;
      this.segmentSumSq += sumSq;
      if (peak > this.segmentPeak) this.segmentPeak = peak;
    }

    const silenceMs = (this.silenceSamples / TARGET_SAMPLE_RATE) * 1000;
    const speechMs = (this.speechSamples / TARGET_SAMPLE_RATE) * 1000;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const canPreemptStaleInterim =
      !this.interimInFlight ||
      now - this.interimStartedAt >= STALE_INTERIM_ABORT_MS;
    const deltaSamples = this.speechSamples - this.lastInterimSpeechSamples;
    const newVoicedSamples = this.voicedSamples - this.lastInterimVoicedSamples;
    // VAD / speech-pause gating:
    // - Only dispatch a new interim when at least 80ms of NEW voiced speech occurred
    //   (prevents redundant re-uploads during trailing silence before flush).
    // - Dispatch immediately at natural >=100ms speech pauses, and otherwise space
    //   continuous-voicing interims to 440ms to cut HTTP amplification >65%.
    const hasFreshSpeech = newVoicedSamples >= MIN_NEW_VOICED_INTERIM_SAMPLES;
    const isPauseBoundaryInterim =
      hasFreshSpeech &&
      silenceMs >= PAUSE_INTERIM_SILENCE_MS &&
      this.speechSamples >= INTERIM_MIN_SAMPLES &&
      deltaSamples >= Math.floor(TARGET_SAMPLE_RATE * 0.08);
    const isRegularInterimStep =
      hasFreshSpeech &&
      this.speechSamples >= INTERIM_MIN_SAMPLES &&
      deltaSamples >= INTERIM_STEP_SAMPLES;

    if (silenceMs >= SILENCE_FLUSH_MS && speechMs >= MIN_SPEECH_MS) {
      this.flushCurrentSegment(false);
    } else if (
      speechMs >= CLAUSE_FLUSH_MIN_SPEECH_MS &&
      silenceMs >= CLAUSE_FLUSH_SILENCE_MS
    ) {
      this.flushCurrentSegment(false);
    } else if (speechMs >= MAX_SEGMENT_MS) {
      this.flushCurrentSegment(true);
    } else if (
      this.interimResults &&
      canPreemptStaleInterim &&
      (isPauseBoundaryInterim || isRegularInterimStep)
    ) {
      this.dispatchRollingInterim();
    }
  }

  private computeAudioQuality(speechDurationMs: number): SegmentAudioQuality {
    const rms = Math.sqrt(this.segmentSumSq / Math.max(1, this.speechSamples));
    const peak = this.segmentPeak;
    let status: SegmentAudioQuality["status"] = "OK";
    if (speechDurationMs < 80) {
      status = "AUDIO_TOO_SHORT";
    } else if (peak >= 0.99) {
      status = "CLIPPING";
    } else if (rms < 0.002 && peak < 0.01) {
      status = "LOW_VOLUME";
    }
    return {
      status,
      rms: Number(rms.toFixed(5)),
      peak: Number(peak.toFixed(4)),
      speechDurationMs: Math.round(speechDurationMs),
    };
  }

  /**
   * Real rolling partial decode (~160ms cadence + pause-boundary trigger) while the
   * child is still speaking. Emits `isFinal: false` preview-only transcripts so
   * word highlighting tracks the child's voice smoothly without mutating final scores.
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
    if (this.interimAbortController) {
      this.interimAbortController.abort();
      this.interimAbortController = null;
    }
    const interimCtrl = new AbortController();
    this.interimAbortController = interimCtrl;
    const parentSignal = this.abortController?.signal;
    const forwardAbort = () => interimCtrl.abort();
    if (parentSignal?.aborted) {
      interimCtrl.abort();
      return;
    }
    parentSignal?.addEventListener("abort", forwardAbort, { once: true });

    const total = this.speechSamples;
    const silenceTailSamples = this.silenceSamples;
    const combined = new Float32Array(total);
    let offset = 0;
    for (const part of this.speechChunks) {
      combined.set(part, offset);
      offset += part.length;
    }
    const activeSpeechMs = Math.max(
      0,
      ((total - silenceTailSamples) / TARGET_SAMPLE_RATE) * 1000,
    );
    const qualitySnapshot = this.computeAudioQuality(activeSpeechMs);
    const onsetAt = this.segmentOnsetAt;
    const capturedEpoch = this.epoch;
    this.lastInterimSpeechSamples = total;
    this.lastInterimVoicedSamples = this.voicedSamples;
    this.interimInFlight = true;
    this.interimStartedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const gen = this.interimGeneration;
    const activeSegmentInterims = this.segmentInterims;
    let audioForInterim = combined;
    if (silenceTailSamples > MAX_INTERIM_TRAILING_SILENCE_SAMPLES) {
      const trimCount =
        silenceTailSamples - MAX_INTERIM_TRAILING_SILENCE_SAMPLES;
      const keepLength = Math.max(
        INTERIM_MIN_SAMPLES,
        combined.length - trimCount,
      );
      if (keepLength < combined.length) {
        audioForInterim = combined.subarray(0, keepLength);
      }
    }
    const wavBlob = encodeFloat32ToWav16kBlob(audioForInterim);
    const ctx = this.getContext?.() ?? {};
    const interimTurnId = nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);

    void this.speechService
      .transcribe(wavBlob, {
        filename: "interim.wav",
        languageCode: "vi",
        keyterms: ctx.keyterms,
        sessionId: ctx.sessionId ?? null,
        pageId: ctx.pageId ?? null,
        turnId: interimTurnId,
        source: "local_live_interim",
        signal: interimCtrl.signal,
        timeoutMs: 3_500,
      })
      .then((res) => {
        if (
          interimCtrl.signal.aborted ||
          this.usingBrowserFallback ||
          capturedEpoch !== this.epoch ||
          !this.active ||
          this.stopping
        ) {
          return;
        }
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
          capturedEpoch !== this.epoch ||
          gen !== this.interimGeneration
        ) {
          return;
        }
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        const resultIndex = this.resultsHistory.length;
        const interimItem: SegmentSpeechResultItem = {
          isFinal: false,
          length: 1,
          0: {
            transcript: text,
            confidence: 0,
          },
          epoch: capturedEpoch,
          sessionId: ctx.sessionId ?? null,
          pageId: ctx.pageId ?? null,
          turnId: interimTurnId,
          segmentId: interimTurnId,
          onsetAt,
          audioEndedAt: now,
          speechDurationMs: qualitySnapshot.speechDurationMs,
          audioQuality: qualitySnapshot,
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
        if (interimCtrl.signal.aborted) return;
        if (isTechnicalSttUnavailabilityError(err)) {
          this.recordTechnicalFailureAndMaybeFallback(err);
        }
      })
      .finally(() => {
        parentSignal?.removeEventListener("abort", forwardAbort);
        if (this.interimAbortController === interimCtrl) {
          this.interimAbortController = null;
          this.interimInFlight = false;
        }
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
    const capturedEpoch = this.epoch;
    const onsetAt = this.segmentOnsetAt;
    const audioEndedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const activeSpeechMs = Math.max(
      0,
      ((total - silenceTailSamples) / TARGET_SAMPLE_RATE) * 1000,
    );
    const qualitySnapshot = this.computeAudioQuality(activeSpeechMs);
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

    // Trim excess trailing silence beyond 160ms before encoding WAV so trailing room noise
    // never degrades Sherpa-ONNX decoding compared to the clean rolling interim.
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
          capturedEpoch !== this.epoch ||
          this.usingBrowserFallback ||
          (!this.active && !this.stopping)
        ) {
          throw err;
        }
        if (isTechnicalSttUnavailabilityError(err)) {
          if (!this.canActivateBrowserFallback()) {
            this.tripServiceCircuitBreaker();
            throw err;
          }
          if (this.recordTechnicalFailureAndMaybeFallback(err)) {
            throw err;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (
          signal?.aborted ||
          capturedEpoch !== this.epoch ||
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
        if (
          this.usingBrowserFallback ||
          capturedEpoch !== this.epoch ||
          (!this.active && !this.stopping)
        ) {
          return;
        }
        this.consecutiveTechnicalFailures = 0;
        lastLocalSttOutageAt = 0;
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
          epoch: capturedEpoch,
          sessionId: ctx.sessionId ?? null,
          pageId: ctx.pageId ?? null,
          turnId,
          segmentId: turnId,
          onsetAt,
          audioEndedAt,
          speechDurationMs: qualitySnapshot.speechDurationMs,
          audioQuality: qualitySnapshot,
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
          if (!this.canActivateBrowserFallback()) {
            this.tripServiceCircuitBreaker();
          } else {
            this.recordTechnicalFailureAndMaybeFallback(err);
          }
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
  options?: { readonly onBeforeExternalMicStart?: () => void },
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
  if (explicitlyDisabled && !isAndroidNativeSpeechAvailable()) {
    return undefined;
  }
  const hasAndroidNative = isAndroidNativeSpeechAvailable();
  const hasNativeWebSpeech = typeof candidate === "function";
  const hasWebAudio =
    typeof win.AudioContext === "function" ||
    typeof win.webkitAudioContext === "function";
  if (!hasAndroidNative && !hasNativeWebSpeech && !hasWebAudio) {
    return undefined;
  }
  return class BoundLocalSegmentSpeechRecognition extends LocalSegmentSpeechRecognition {
    constructor() {
      super(speechService, getContext, options?.onBeforeExternalMicStart);
    }
    override start(audioTrack?: MediaStreamTrack): void {
      super.start(audioTrack ?? getLiveTrack?.());
    }
  };
}
