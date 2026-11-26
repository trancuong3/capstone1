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
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
} from "@/lib/reading/browser-wasm-stt";
import { getVoicePolicyPreferences } from "@/lib/reading/session-voice-lock";
import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";
import {
  getFreshVoiceEngineHealth,
  getVoiceEngineStatus,
  recordSttEngineUsage,
} from "@/lib/reading/voice-engine-status";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

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
const WS_PCM_CHUNK_SAMPLES = 1024; // 64ms @ 16kHz mono Int16 LE (2048 bytes)
const WS_FLUSH_FALLBACK_TIMEOUT_MS = 5_500;
const INTERIM_HTTP_TIMEOUT_MS = 6_500;
const ANDROID_STT_RESTART_DELAY_MS = 120;
const ANDROID_STT_BUSY_RESTART_DELAY_MS = 350;
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

export function isPermanentLocalVoiceUnconfigured(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rec = error as {
    code?: unknown;
    message?: unknown;
    providerCode?: unknown;
    provider_code?: unknown;
  };
  const combined = `${String(rec.code ?? "")} ${String(rec.provider_code ?? "")} ${String(rec.providerCode ?? "")} ${String(rec.message ?? "")}`;
  return combined.includes("LOCAL_VOICE_UNCONFIGURED");
}

function isImmediateLocalOutageError(error: unknown): boolean {
  if (isPermanentLocalVoiceUnconfigured(error)) return true;
  if (!error || typeof error !== "object") return false;
  const rec = error as { code?: unknown; message?: unknown };
  const code = typeof rec.code === "string" ? rec.code : "";
  const message = typeof rec.message === "string" ? rec.message : "";
  const combined = `${code} ${message}`;
  return combined.includes("máy chủ giọng nói cục bộ chưa được bật");
}

function isAndroidNativeSttReady(): boolean {
  if (!isAndroidNativeSpeechAvailable()) return false;
  const caps = getCachedAndroidSpeechCapabilities();
  return caps ? caps.sttAvailable : true;
}

/**
 * Returns `true` when Android native `SpeechRecognizer` should handle STT
 * exclusively (skipping parallel WebView `getUserMedia`/`MediaRecorder` to
 * avoid Android audio HAL microphone contention).
 */
export function shouldPreferAndroidNativeStt(): boolean {
  if (!isAndroidNativeSttReady()) return false;
  const policy = getVoicePolicyPreferences();
  const freshHealth = getFreshVoiceEngineHealth();
  if (freshHealth) {
    if (freshHealth.local.available && freshHealth.local.stt_ready) {
      return false;
    }
    if (
      policy.providerMode === "local_only" ||
      !policy.allowGoogleSttFallback ||
      !freshHealth.google.stt_configured ||
      freshHealth.google.stt_cooldown
    ) {
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

export interface SttStreamEndpointConfig {
  readonly wsUrl: string;
  readonly token: string;
}

function toWebSocketSttUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().replace(/\/+$/u, "");
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}/voice/stt-stream`;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}/voice/stt-stream`;
  }
  if (typeof window !== "undefined" && window.location?.host) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return `${proto}//${window.location.host}${path}/voice/stt-stream`;
  }
  return "";
}

async function resolveDefaultSttStreamEndpoint(): Promise<SttStreamEndpointConfig | null> {
  try {
    const wsUrl = toWebSocketSttUrl(getApiBaseUrl());
    if (!wsUrl) return null;
    const supabase = createBrowserSupabaseClient();
    const { error: initError } = await supabase.auth.initialize();
    if (initError) return null;
    const { data, error } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (error || !token) return null;
    return { wsUrl, token };
  } catch {
    return null;
  }
}

function float32ToInt16LeBuffer(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      i * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }
  return buffer;
}

interface PendingWsSegment {
  readonly turnId: string;
  readonly capturedEpoch: number;
  readonly sessionId: string | null;
  readonly pageId: string | null;
  readonly keyterms: readonly string[] | undefined;
  readonly capturedInterims: string[];
  readonly onsetAt: number | null;
  readonly audioEndedAt: number;
  readonly qualitySnapshot: SegmentAudioQuality;
  readonly audioToEncode: Float32Array;
  readonly resolve: (text: string | null) => void;
  readonly fallbackTimer: ReturnType<typeof setTimeout>;
  settled: boolean;
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
  private browserRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private usingBrowserFallback = false;
  private usingWasmStt = false;
  private wasmFallbackReason: string | null = null;
  private browserBaseOffset = 0;
  private consecutiveTechnicalFailures = 0;
  private sttCircuitOpen = false;

  private ws: WebSocket | null = null;
  private wsReady = false;
  private wsDisabledForRun = false;
  private wsCurrentTurnId: string | null = null;
  private wsStartedPageId: string | null = null;
  private wsStartedSessionId: string | null = null;
  private wsPcmTail: Float32Array = new Float32Array(0);
  private wsPendingByTurnId = new Map<string, PendingWsSegment>();

  constructor(
    private readonly speechService: SpeechService,
    private readonly getContext?: () => LocalSegmentContextSnapshot,
    private readonly resolveWsEndpoint: () => Promise<SttStreamEndpointConfig | null> = resolveDefaultSttStreamEndpoint,
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
    this.usingWasmStt = false;
    this.wasmFallbackReason = null;
    this.sttCircuitOpen = false;
    this.browserFallbackRec = null;
    this.browserBaseOffset = 0;
    this.abortController = new AbortController();
    this.resultsHistory = [];
    this.uploadChain = Promise.resolve();
    this.consecutiveTechnicalFailures = 0;
    this.wsDisabledForRun = false;
    this.wsReady = false;
    this.wsCurrentTurnId = null;
    this.wsStartedPageId = null;
    this.wsStartedSessionId = null;
    this.wsPcmTail = new Float32Array(0);
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
    } else {
      const confirmedLocalDown =
        freshHealth !== null &&
        (!freshHealth.local.available || !freshHealth.local.stt_ready);
      const now = Date.now();
      const androidSttReady = isAndroidNativeSttReady();
      const confirmedLocalDownNoGoogle =
        confirmedLocalDown &&
        (policy.providerMode === "local_only" ||
          !policy.allowGoogleSttFallback ||
          !freshHealth.google.stt_configured ||
          freshHealth.google.stt_cooldown);
      const withinEmergencyCooldown =
        lastLocalSttOutageAt > 0 &&
        now - lastLocalSttOutageAt < LOCAL_OUTAGE_RETRY_MS &&
        (getVoiceEngineStatus().stt.tier === "browser_default" ||
          getVoiceEngineStatus().stt.tier === "android_native");
      const withinWasmCooldown =
        lastLocalSttOutageAt > 0 &&
        now - lastLocalSttOutageAt < LOCAL_OUTAGE_RETRY_MS &&
        (getVoiceEngineStatus().stt.tier === "browser_wasm" ||
          getVoiceEngineStatus().stt.tier === "browser_default" ||
          getVoiceEngineStatus().stt.tier === "android_native");

      if (
        androidSttReady &&
        (confirmedLocalDownNoGoogle || withinEmergencyCooldown)
      ) {
        if (confirmedLocalDownNoGoogle) {
          lastLocalSttOutageAt = now;
        }
        if (this.tryActivateBrowserFallback()) {
          return;
        }
      }

      if (
        !androidSttReady &&
        (confirmedLocalDown || withinWasmCooldown) &&
        detectBrowserWasmSttSupport().supported
      ) {
        if (confirmedLocalDown) {
          lastLocalSttOutageAt = now;
        }
        this.usingWasmStt = true;
        this.wsDisabledForRun = true;
        this.wasmFallbackReason = confirmedLocalDown
          ? "LOCAL_STT_UNAVAILABLE"
          : null;
        recordSttEngineUsage({
          provider: "wasm",
          fallbackUsed: true,
          fallbackReason: this.wasmFallbackReason,
        });
        void getBrowserWasmSttClient()
          .init(this.abortController.signal)
          .catch(() => undefined);
      } else if (
        policy.providerMode === "local_with_google_fallback" &&
        policy.allowGoogleSttFallback
      ) {
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
      } else if (
        lastLocalSttOutageAt > 0 &&
        now - lastLocalSttOutageAt >= LOCAL_OUTAGE_RETRY_MS
      ) {
        lastLocalSttOutageAt = 0;
      }
    }

    void this.openAudioGraph(audioTrack);
  }

  private clearBrowserRestartTimer(): void {
    if (this.browserRestartTimer !== null) {
      clearTimeout(this.browserRestartTimer);
      this.browserRestartTimer = null;
    }
  }

  stop(): void {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    const hadPendingRestart = this.browserRestartTimer !== null;
    this.clearBrowserRestartTimer();
    this.interimAbortController?.abort();
    this.interimAbortController = null;
    if (this.usingBrowserFallback && this.browserFallbackRec) {
      if (hadPendingRestart) {
        this.browserFallbackRec = null;
        this.usingBrowserFallback = false;
        this.active = false;
        this.stopping = false;
        this.onend?.();
        return;
      }
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        // Ignore WS close send errors
      }
    }
    this.teardownAudioGraph();
    const inflight = Array.from(this.pendingUploads);
    void Promise.allSettled(inflight).finally(() => {
      this.closeSttWebSocket();
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
    this.clearBrowserRestartTimer();
    this.interimAbortController?.abort();
    this.interimAbortController = null;
    this.abortController?.abort();
    this.closeSttWebSocket();
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
    if (androidAvailable) {
      return true;
    }
    return (
      policy.providerMode === "local_with_google_fallback" &&
      policy.allowGoogleSttFallback &&
      Boolean(getBrowserSpeechRecognitionCtor())
    );
  }

  private tripServiceCircuitBreaker(): void {
    if (this.sttCircuitOpen || !this.active) return;
    this.sttCircuitOpen = true;
    this.active = false;
    this.stopping = false;
    this.clearBrowserRestartTimer();
    this.abortController?.abort();
    this.closeSttWebSocket();
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

  private recordTechnicalFailureAndMaybeFallback(
    errorOrForce?: unknown,
  ): boolean {
    this.consecutiveTechnicalFailures += 1;
    const forceImmediate =
      typeof errorOrForce === "boolean"
        ? errorOrForce
        : isImmediateLocalOutageError(errorOrForce);
    const freshHealth = getFreshVoiceEngineHealth();
    const confirmedLocalOutage =
      forceImmediate ||
      (freshHealth !== null &&
        (!freshHealth.local.available || !freshHealth.local.stt_ready));
    if (
      confirmedLocalOutage ||
      this.consecutiveTechnicalFailures >= EMERGENCY_FAILURE_THRESHOLD
    ) {
      lastLocalSttOutageAt = Date.now();
      if (isAndroidNativeSttReady() && this.tryActivateBrowserFallback()) {
        return true;
      }
      if (detectBrowserWasmSttSupport().supported) {
        this.usingWasmStt = true;
        this.wsDisabledForRun = true;
        this.wasmFallbackReason = "LOCAL_STT_UNAVAILABLE";
        this.closeSttWebSocket();
        recordSttEngineUsage({
          provider: "wasm",
          fallbackUsed: true,
          fallbackReason: "LOCAL_STT_UNAVAILABLE",
        });
        void getBrowserWasmSttClient()
          .init(this.abortController?.signal)
          .catch(() => undefined);
        return true;
      }
      return this.tryActivateBrowserFallback();
    }
    return false;
  }

  private tryActivateBrowserFallback(): boolean {
    if (!this.active || this.stopping || this.usingBrowserFallback) {
      return false;
    }
    const caps = getCachedAndroidSpeechCapabilities();
    const useAndroidNative =
      isAndroidNativeSpeechAvailable() && (caps ? caps.sttAvailable : true);
    if (!useAndroidNative) {
      const policy = getVoicePolicyPreferences();
      if (
        policy.providerMode !== "local_with_google_fallback" ||
        !policy.allowGoogleSttFallback
      ) {
        return false;
      }
    }
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
    this.clearBrowserRestartTimer();
    let fatalFallbackError = false;
    let lastFallbackError: string | null = null;

    nativeRec.onresult = (ev: SegmentSpeechEvent) => {
      if (!this.active || this.browserFallbackRec !== nativeRec) return;
      const ctx = this.getContext?.() ?? {};
      const base = this.browserBaseOffset;
      const totalLength = base + ev.results.length;
      const resultsObj: Record<number, SegmentSpeechResultItem> & {
        length: number;
      } = { length: totalLength };
      for (let i = 0; i < base; i += 1) {
        resultsObj[i] = this.resultsHistory[i];
      }
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      for (let i = 0; i < ev.results.length; i += 1) {
        const rawItem = ev.results[i];
        const fallbackTurnId =
          rawItem?.turnId ??
          nextTurnId(ctx.pageId ?? "browser", ++this.turnSeq);
        const item: SegmentSpeechResultItem = {
          ...rawItem,
          epoch: rawItem?.epoch ?? this.epoch,
          sessionId: rawItem?.sessionId ?? ctx.sessionId ?? null,
          pageId: rawItem?.pageId ?? ctx.pageId ?? null,
          turnId: fallbackTurnId,
          segmentId: rawItem?.segmentId ?? fallbackTurnId,
          onsetAt: rawItem?.onsetAt ?? null,
          audioEndedAt: rawItem?.audioEndedAt ?? now,
          speechDurationMs: rawItem?.speechDurationMs ?? null,
          audioQuality: rawItem?.audioQuality,
        };
        resultsObj[base + i] = item;
        if (item.isFinal) {
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
      lastFallbackError = ev.error ?? null;
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
        if (useAndroidNative) {
          const restartDelayMs =
            lastFallbackError === "aborted"
              ? ANDROID_STT_BUSY_RESTART_DELAY_MS
              : ANDROID_STT_RESTART_DELAY_MS;
          lastFallbackError = null;
          this.clearBrowserRestartTimer();
          this.browserRestartTimer = setTimeout(() => {
            this.browserRestartTimer = null;
            if (
              !this.active ||
              this.stopping ||
              this.browserFallbackRec !== nativeRec ||
              fatalFallbackError
            ) {
              return;
            }
            try {
              this.browserBaseOffset = this.resultsHistory.length;
              nativeRec.start();
            } catch {
              this.browserFallbackRec = null;
              this.usingBrowserFallback = false;
              this.active = false;
              this.stopping = false;
              this.onend?.();
            }
          }, restartDelayMs);
          return;
        }
        try {
          lastFallbackError = null;
          this.browserBaseOffset = this.resultsHistory.length;
          nativeRec.start();
          return;
        } catch {
          // Fall through to clean termination
        }
      }
      this.clearBrowserRestartTimer();
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
    this.lastInterimVoicedSamples = 0;
    this.silenceSamples = 0;
    this.inSpeech = false;
    this.segmentOnsetAt = null;
    this.segmentSumSq = 0;
    this.segmentPeak = 0;
    this.segmentInterims = [];
    this.wsPcmTail = new Float32Array(0);
  }

  private closeSttWebSocket(): void {
    const socket = this.ws;
    this.ws = null;
    this.wsReady = false;
    this.wsCurrentTurnId = null;
    this.wsPcmTail = new Float32Array(0);
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
      } catch {
        // Ignore WS close errors
      }
    }
    this.fallbackAllPendingWsSegments();
  }

  private fallbackAllPendingWsSegments(): void {
    for (const [turnId, pending] of this.wsPendingByTurnId.entries()) {
      this.wsPendingByTurnId.delete(turnId);
      if (pending.settled) continue;
      pending.settled = true;
      clearTimeout(pending.fallbackTimer);
      void this.runHttpFallbackForPendingSegment(pending).then(
        (text) => pending.resolve(text),
        () => pending.resolve(null),
      );
    }
  }

  private async runHttpFallbackForPendingSegment(
    pending: PendingWsSegment,
  ): Promise<string | null> {
    if (
      pending.capturedEpoch !== this.epoch ||
      this.usingBrowserFallback ||
      (!this.active && !this.stopping)
    ) {
      return null;
    }
    const signal = this.abortController?.signal;
    let rawText = "";
    if (this.usingWasmStt) {
      const wasmRes = await getBrowserWasmSttClient().transcribeSamples(
        pending.audioToEncode,
        {
          signal,
          timeoutMs: 20_000,
        },
      );
      rawText = (wasmRes.text ?? "").normalize("NFC").trim();
    } else {
      const wavBlob = encodeFloat32ToWav16kBlob(pending.audioToEncode);
      const res = await this.speechService.transcribe(wavBlob, {
        filename: "segment.wav",
        languageCode: "vi",
        keyterms: pending.keyterms,
        sessionId: pending.sessionId,
        pageId: pending.pageId,
        turnId: pending.turnId,
        source: "local_live_segment",
        signal,
        timeoutMs: 12_000,
      });
      this.consecutiveTechnicalFailures = 0;
      lastLocalSttOutageAt = 0;
      rawText = (res.text ?? "").normalize("NFC").trim();
    }
    if (!rawText) return null;
    return reconcileSegmentTranscriptWithInterims(
      rawText,
      pending.capturedInterims,
      pending.keyterms,
    );
  }

  private async openSttWebSocket(): Promise<void> {
    if (
      typeof WebSocket !== "function" ||
      this.wsDisabledForRun ||
      !this.active ||
      this.stopping ||
      this.usingBrowserFallback
    ) {
      return;
    }
    const endpoint = await this.resolveWsEndpoint();
    if (
      !endpoint ||
      !this.active ||
      this.stopping ||
      this.usingBrowserFallback ||
      this.wsDisabledForRun
    ) {
      return;
    }
    const capturedEpoch = this.epoch;
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpoint.wsUrl, [
        "viread-stt-v1",
        `bearer.${endpoint.token}`,
      ]);
      socket.binaryType = "arraybuffer";
    } catch {
      this.wsDisabledForRun = true;
      return;
    }
    this.ws = socket;
    this.wsReady = false;

    socket.onopen = () => {
      if (this.ws !== socket || !this.active || capturedEpoch !== this.epoch) {
        try {
          socket.close();
        } catch {
          // Ignore
        }
        return;
      }
      const ctx = this.getContext?.() ?? {};
      const turnId =
        this.wsCurrentTurnId ??
        nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
      this.wsCurrentTurnId = turnId;
      this.wsStartedSessionId = ctx.sessionId ?? null;
      this.wsStartedPageId = ctx.pageId ?? null;
      try {
        socket.send(
          JSON.stringify({
            type: "start",
            session_id: this.wsStartedSessionId,
            page_id: this.wsStartedPageId,
            turn_id: turnId,
            sample_rate: TARGET_SAMPLE_RATE,
            language: "vi",
            token: endpoint.token,
            ...(ctx.keyterms?.length ? { keyterms: ctx.keyterms } : {}),
          }),
        );
      } catch {
        this.wsDisabledForRun = true;
        this.closeSttWebSocket();
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (this.ws !== socket || capturedEpoch !== this.epoch) return;
      if (typeof ev.data !== "string") return;
      let msg: {
        type?: string;
        text?: string;
        segment_id?: string;
        turn_id?: string;
        session_id?: string | null;
        page_id?: string | null;
        epoch_ms?: number;
        audio_ended_ms?: number;
        code?: string;
        audio_quality?: {
          status?: SegmentAudioQuality["status"];
          rms?: number;
          peak?: number;
          speech_duration_ms?: number;
        };
      };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === "ready") {
        this.wsReady = true;
        recordSttEngineUsage({
          provider: "local",
          fallbackUsed: false,
          fallbackReason: null,
        });
        return;
      }

      if (msg.type === "error") {
        if (
          msg.code === "LOCAL_STT_UNAVAILABLE" ||
          msg.code === "STT_TEMPORARILY_UNAVAILABLE"
        ) {
          this.wsDisabledForRun = true;
          this.closeSttWebSocket();
        }
        return;
      }

      if (msg.type !== "interim" && msg.type !== "final") return;
      const ctx = this.getContext?.() ?? {};
      if (msg.session_id && ctx.sessionId && msg.session_id !== ctx.sessionId) {
        return;
      }
      if (msg.page_id && ctx.pageId && msg.page_id !== ctx.pageId) {
        return;
      }
      const rawText = (msg.text ?? "").normalize("NFC").trim();
      const mappedQuality: SegmentAudioQuality | undefined = msg.audio_quality
        ?.status
        ? {
            status: msg.audio_quality.status,
            rms: Number((msg.audio_quality.rms ?? 0).toFixed(5)),
            peak: Number((msg.audio_quality.peak ?? 0).toFixed(4)),
            speechDurationMs: Math.round(
              msg.audio_quality.speech_duration_ms ?? 0,
            ),
          }
        : undefined;

      if (msg.type === "interim") {
        if (!this.active || this.stopping || !this.inSpeech || !rawText) {
          return;
        }
        if (this.segmentInterims[this.segmentInterims.length - 1] !== rawText) {
          this.segmentInterims.push(rawText);
          if (this.segmentInterims.length > 12) {
            this.segmentInterims.shift();
          }
        }
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        const activeSpeechMs = Math.max(
          0,
          ((this.speechSamples - this.silenceSamples) / TARGET_SAMPLE_RATE) *
            1000,
        );
        const qualitySnapshot =
          mappedQuality ?? this.computeAudioQuality(activeSpeechMs);
        const turnId =
          msg.turn_id ??
          this.wsCurrentTurnId ??
          nextTurnId(ctx.pageId ?? "live", this.turnSeq);
        const segmentId = msg.segment_id ?? turnId;
        const resultIndex = this.resultsHistory.length;
        const interimItem: SegmentSpeechResultItem = {
          isFinal: false,
          length: 1,
          0: { transcript: rawText, confidence: 0 },
          epoch: capturedEpoch,
          sessionId: msg.session_id ?? ctx.sessionId ?? null,
          pageId: msg.page_id ?? ctx.pageId ?? null,
          turnId,
          segmentId,
          onsetAt: this.segmentOnsetAt,
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
        this.onresult?.({ resultIndex, results: resultsObj });
        return;
      }

      // Final message
      this.consecutiveTechnicalFailures = 0;
      lastLocalSttOutageAt = 0;
      const pendingKey = msg.turn_id ?? "";
      const pending = this.wsPendingByTurnId.get(pendingKey);
      if (pending) {
        this.wsPendingByTurnId.delete(pendingKey);
        if (!pending.settled) {
          pending.settled = true;
          clearTimeout(pending.fallbackTimer);
          const reconciled = rawText
            ? reconcileSegmentTranscriptWithInterims(
                rawText,
                pending.capturedInterims,
                pending.keyterms,
              )
            : null;
          pending.resolve(reconciled || null);
        }
        return;
      }

      // Spontaneous final from WS without a preceding client flush (e.g. server VAD)
      if (!rawText || (!this.active && !this.stopping)) return;
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const activeSpeechMs = Math.max(
        0,
        ((this.speechSamples - this.silenceSamples) / TARGET_SAMPLE_RATE) *
          1000,
      );
      const qualitySnapshot =
        mappedQuality ?? this.computeAudioQuality(activeSpeechMs);
      const turnId =
        msg.turn_id ?? nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
      const segmentId = msg.segment_id ?? turnId;
      const resultIndex = this.resultsHistory.length;
      const item: SegmentSpeechResultItem = {
        isFinal: true,
        length: 1,
        0: { transcript: rawText, confidence: 0 },
        epoch: capturedEpoch,
        sessionId: msg.session_id ?? ctx.sessionId ?? null,
        pageId: msg.page_id ?? ctx.pageId ?? null,
        turnId,
        segmentId,
        onsetAt: this.segmentOnsetAt,
        audioEndedAt: now,
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
      this.onresult?.({ resultIndex, results: resultsObj });
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      this.wsDisabledForRun = true;
      this.closeSttWebSocket();
    };

    socket.onclose = (ev: CloseEvent) => {
      if (this.ws !== socket) return;
      if (ev.code === 4401 || ev.code === 4503 || ev.code !== 1000) {
        this.wsDisabledForRun = true;
      }
      this.closeSttWebSocket();
    };
  }

  private ensureWsTurnStarted(turnId: string): boolean {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.wsReady ||
      this.wsDisabledForRun
    ) {
      return false;
    }
    const ctx = this.getContext?.() ?? {};
    const nextSessionId = ctx.sessionId ?? null;
    const nextPageId = ctx.pageId ?? null;
    if (
      this.wsCurrentTurnId !== turnId ||
      this.wsStartedPageId !== nextPageId ||
      this.wsStartedSessionId !== nextSessionId
    ) {
      this.wsCurrentTurnId = turnId;
      this.wsStartedSessionId = nextSessionId;
      this.wsStartedPageId = nextPageId;
      try {
        this.ws.send(
          JSON.stringify({
            type: "start",
            session_id: nextSessionId,
            page_id: nextPageId,
            turn_id: turnId,
            sample_rate: TARGET_SAMPLE_RATE,
            language: "vi",
            ...(ctx.keyterms?.length ? { keyterms: ctx.keyterms } : {}),
          }),
        );
      } catch {
        this.wsDisabledForRun = true;
        this.closeSttWebSocket();
        return false;
      }
    }
    return true;
  }

  private streamWsPcmChunk(
    samples: Float32Array,
    flushRemainder = false,
  ): void {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.wsReady ||
      this.wsDisabledForRun
    ) {
      return;
    }
    const combined =
      this.wsPcmTail.length > 0
        ? (() => {
            const merged = new Float32Array(
              this.wsPcmTail.length + samples.length,
            );
            merged.set(this.wsPcmTail, 0);
            merged.set(samples, this.wsPcmTail.length);
            return merged;
          })()
        : samples;

    let offset = 0;
    while (offset + WS_PCM_CHUNK_SAMPLES <= combined.length) {
      const slice = combined.subarray(offset, offset + WS_PCM_CHUNK_SAMPLES);
      try {
        this.ws.send(float32ToInt16LeBuffer(slice));
      } catch {
        this.wsDisabledForRun = true;
        this.closeSttWebSocket();
        return;
      }
      offset += WS_PCM_CHUNK_SAMPLES;
    }
    const remainder = combined.subarray(offset);
    if (flushRemainder && remainder.length > 0) {
      try {
        this.ws.send(float32ToInt16LeBuffer(remainder));
      } catch {
        this.wsDisabledForRun = true;
        this.closeSttWebSocket();
      }
      this.wsPcmTail = new Float32Array(0);
    } else {
      this.wsPcmTail =
        remainder.length > 0
          ? new Float32Array(remainder)
          : new Float32Array(0);
    }
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
      void this.openSttWebSocket();
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
        const ctx = this.getContext?.() ?? {};
        const turnId = nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
        const wsActive = this.ensureWsTurnStarted(turnId);
        if (this.preRoll.length > 0) {
          if (wsActive) this.streamWsPcmChunk(this.preRoll);
          this.speechChunks.push(this.preRoll);
          this.speechSamples += this.preRoll.length;
          this.preRoll = new Float32Array(0);
        }
        if (wsActive) this.streamWsPcmChunk(chunk);
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

    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsReady) {
      this.streamWsPcmChunk(chunk);
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
    const wsStreamingActive = Boolean(
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.wsReady &&
      !this.wsDisabledForRun,
    );
    const wsConnecting = Boolean(
      this.ws &&
      this.ws.readyState === WebSocket.CONNECTING &&
      !this.wsDisabledForRun,
    );
    const canDispatchHttpInterim = !this.interimInFlight;
    const deltaSamples = this.speechSamples - this.lastInterimSpeechSamples;
    const newVoicedSamples = this.voicedSamples - this.lastInterimVoicedSamples;
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
      !wsStreamingActive &&
      !wsConnecting &&
      this.interimResults &&
      canDispatchHttpInterim &&
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
      !this.speechChunks.length ||
      this.interimInFlight
    ) {
      return;
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
    const combined = new Float32Array(total);
    let offset = 0;
    for (const part of this.speechChunks) {
      combined.set(part, offset);
      offset += part.length;
    }
    const activeSpeechMs = Math.max(
      0,
      ((total - this.silenceSamples) / TARGET_SAMPLE_RATE) * 1000,
    );
    const qualitySnapshot = this.computeAudioQuality(activeSpeechMs);
    const onsetAt = this.segmentOnsetAt;
    const capturedEpoch = this.epoch;
    this.lastInterimSpeechSamples = total;
    this.lastInterimVoicedSamples = this.voicedSamples;
    this.interimInFlight = true;
    const gen = this.interimGeneration;
    const activeSegmentInterims = this.segmentInterims;
    const ctx = this.getContext?.() ?? {};
    const interimTurnId = nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
    const usedWasm = this.usingWasmStt;

    const interimPromise: Promise<{ text: string }> = usedWasm
      ? getBrowserWasmSttClient().transcribeSamples(combined, {
          signal: interimCtrl.signal,
          timeoutMs: 4_000,
        })
      : this.speechService.transcribe(encodeFloat32ToWav16kBlob(combined), {
          filename: "interim.wav",
          languageCode: "vi",
          keyterms: ctx.keyterms,
          sessionId: ctx.sessionId ?? null,
          pageId: ctx.pageId ?? null,
          turnId: interimTurnId,
          source: "local_live_interim",
          signal: interimCtrl.signal,
          timeoutMs: INTERIM_HTTP_TIMEOUT_MS,
        });

    void interimPromise
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
        if (!usedWasm) {
          this.consecutiveTechnicalFailures = 0;
          lastLocalSttOutageAt = 0;
        }
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
    if (!this.active && !this.stopping) return;
    this.interimGeneration += 1;
    this.lastInterimSpeechSamples = 0;
    this.lastInterimVoicedSamples = 0;
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

    const ctx = this.getContext?.() ?? {};
    const turnId =
      this.wsCurrentTurnId ?? nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
    this.wsCurrentTurnId = null;
    const signal = this.abortController?.signal;

    const deliverFinalText = (text: string | null) => {
      if (
        !text ||
        this.usingBrowserFallback ||
        capturedEpoch !== this.epoch ||
        (!this.active && !this.stopping)
      ) {
        return;
      }
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
    };

    const canFlushViaWs =
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.wsReady &&
      !this.wsDisabledForRun;

    const responsePromise: Promise<string | null> = canFlushViaWs
      ? new Promise<string | null>((resolve) => {
          this.streamWsPcmChunk(new Float32Array(0), true);
          const pending: PendingWsSegment = {
            turnId,
            capturedEpoch,
            sessionId: ctx.sessionId ?? null,
            pageId: ctx.pageId ?? null,
            keyterms: ctx.keyterms,
            capturedInterims,
            onsetAt,
            audioEndedAt,
            qualitySnapshot,
            audioToEncode,
            resolve,
            settled: false,
            fallbackTimer: setTimeout(() => {
              this.wsPendingByTurnId.delete(turnId);
              if (pending.settled) return;
              pending.settled = true;
              this.wsDisabledForRun = true;
              void this.runHttpFallbackForPendingSegment(pending).then(
                (text) => resolve(text),
                () => resolve(null),
              );
            }, WS_FLUSH_FALLBACK_TIMEOUT_MS),
          };
          this.wsPendingByTurnId.set(turnId, pending);
          try {
            this.ws!.send(JSON.stringify({ type: "flush", turn_id: turnId }));
          } catch {
            this.wsPendingByTurnId.delete(turnId);
            clearTimeout(pending.fallbackTimer);
            pending.settled = true;
            this.wsDisabledForRun = true;
            void this.runHttpFallbackForPendingSegment(pending).then(
              (text) => resolve(text),
              () => resolve(null),
            );
          }
        })
      : (() => {
          const transcribeWithWasm = async () => {
            const wasmRes = await getBrowserWasmSttClient().transcribeSamples(
              audioToEncode,
              {
                signal,
                timeoutMs: 20_000,
              },
            );
            recordSttEngineUsage({
              provider: "wasm",
              fallbackUsed: true,
              fallbackReason:
                this.wasmFallbackReason ?? "LOCAL_STT_UNAVAILABLE",
            });
            return { text: wasmRes.text, fromWasm: true as const };
          };

          const transcribeOnce = async () => {
            if (this.usingWasmStt) {
              return transcribeWithWasm();
            }
            const wavBlob = encodeFloat32ToWav16kBlob(audioToEncode);
            const res = await this.speechService.transcribe(wavBlob, {
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
            return { text: res.text, fromWasm: false as const };
          };

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
              if (this.usingWasmStt) {
                throw err;
              }
              if (
                isTechnicalSttUnavailabilityError(err) &&
                this.recordTechnicalFailureAndMaybeFallback(err)
              ) {
                if (this.usingWasmStt) {
                  return transcribeWithWasm();
                }
                throw err;
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

          return transcribeWithRetry().then((res) => {
            if (!res.fromWasm) {
              this.consecutiveTechnicalFailures = 0;
              lastLocalSttOutageAt = 0;
            }
            const rawText = (res.text ?? "").normalize("NFC").trim();
            if (!rawText) return null;
            return reconcileSegmentTranscriptWithInterims(
              rawText,
              capturedInterims,
              ctx.keyterms,
            );
          });
        })();

    // Deliver results strictly in FIFO order via uploadChain so segment N+1
    // NEVER overtakes segment N and causes false RED alignment skips!
    const deliveryTask = this.uploadChain
      .then(async () => {
        const text = await responsePromise;
        deliverFinalText(text);
      })
      .catch((err) => {
        if (signal?.aborted || this.usingBrowserFallback) return;
        if (this.usingWasmStt) {
          this.usingWasmStt = false;
          if (this.tryActivateBrowserFallback()) {
            return;
          }
          this.active = false;
          this.stopping = false;
          this.closeSttWebSocket();
          this.teardownAudioGraph();
          this.onerror?.({ error: "stt-unavailable" });
          this.onend?.();
          return;
        }
        if (isTechnicalSttUnavailabilityError(err)) {
          // Both attempts in transcribeWithRetry already failed for this segment;
          // force failover evaluation when an emergency fallback (e.g. Android Native STT)
          // is available so a mixed attempt-1/attempt-2 failure still fails over cleanly.
          if (
            this.recordTechnicalFailureAndMaybeFallback(
              this.canActivateBrowserFallback() ? true : err,
            )
          ) {
            return;
          }
          if (
            !this.canActivateBrowserFallback() &&
            !detectBrowserWasmSttSupport().supported
          ) {
            this.tripServiceCircuitBreaker();
          } else {
            this.active = false;
            this.stopping = false;
            this.closeSttWebSocket();
            this.teardownAudioGraph();
            this.onerror?.({ error: "stt-unavailable" });
            this.onend?.();
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
      super(
        speechService,
        getContext,
        undefined,
        options?.onBeforeExternalMicStart,
      );
    }
    override start(audioTrack?: MediaStreamTrack): void {
      super.start(audioTrack ?? getLiveTrack?.());
    }
  };
}
