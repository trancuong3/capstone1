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

import { invalidateBrowserTokenCache } from "@/lib/api/browser-auth";
import { isSttFallbackEligibleError } from "@/lib/api/speech-error";
import type { SpeechService, WordTimestamp } from "@/lib/api/speech-service";
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

export interface SegmentSpeechWordTiming {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly type?: string;
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
  /** Optional word-level timestamps forwarded from streaming WS or HTTP STT. */
  readonly words?: readonly WordTimestamp[] | null;
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
  onspeechstart?: (() => void) | null;
  onsoundstart?: (() => void) | null;
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
const SILENCE_FLUSH_MS = 420;
const CLAUSE_FLUSH_MIN_SPEECH_MS = 1_800;
const CLAUSE_FLUSH_SILENCE_MS = 160;
const MIN_SPEECH_MS = 120;
const MAX_SEGMENT_MS = 3_600;
const INTERIM_MIN_SPEECH_MS = 140;
const INTERIM_STEP_MS = 380;
const PAUSE_INTERIM_SILENCE_MS = 100;
const MIN_NEW_VOICED_INTERIM_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.08);
const WS_PCM_CHUNK_SAMPLES = 1024; // 64ms @ 16kHz mono Int16 LE (2048 bytes)
const WS_FLUSH_FALLBACK_TIMEOUT_MS = 3_500;
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

/**
 * Stateful per-stream resampler to 16 kHz mono Float32 PCM.
 *
 * Preserves 2nd-order Butterworth anti-aliasing low-pass filter state
 * (`x1, x2, y1, y2`) AND fractional sample phase (`pos`, `prevFiltered`)
 * continuously across consecutive AudioWorklet (1024@48kHz) or
 * ScriptProcessor (512@44.1kHz) chunks, eliminating boundary clicks
 * (46.9 Hz / 93.75 Hz) and tail-sample drops that distort Vietnamese tones.
 */
export class StatefulResampler16k {
  private readonly ratio: number;
  private readonly needsFilter: boolean;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private filterInitialized = false;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private hasPrevFiltered = false;
  private prevFiltered = 0;
  private phase = 0;

  constructor(private readonly inputRate: number) {
    this.ratio =
      inputRate > 0 && inputRate !== TARGET_SAMPLE_RATE
        ? inputRate / TARGET_SAMPLE_RATE
        : 1;
    this.needsFilter = inputRate > TARGET_SAMPLE_RATE;
    if (this.needsFilter) {
      // 2nd-order Butterworth anti-aliasing low-pass filter (fc = 7.2 kHz)
      // before decimation from 44.1/48 kHz -> 16 kHz to preserve Vietnamese sibilants (s/x, ch/tr).
      const fc = Math.min(7_200, TARGET_SAMPLE_RATE * 0.45);
      const omega = (2 * Math.PI * fc) / inputRate;
      const sinW = Math.sin(omega);
      const cosW = Math.cos(omega);
      const alpha = sinW / (2 * Math.SQRT1_2);
      const a0 = 1 + alpha;
      this.b0 = (1 - cosW) / 2 / a0;
      this.b1 = (1 - cosW) / a0;
      this.b2 = this.b0;
      this.a1 = (-2 * cosW) / a0;
      this.a2 = (1 - alpha) / a0;
    } else {
      this.b0 = 1;
      this.b1 = 0;
      this.b2 = 0;
      this.a1 = 0;
      this.a2 = 0;
    }
  }

  reset(): void {
    this.filterInitialized = false;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
    this.hasPrevFiltered = false;
    this.prevFiltered = 0;
    this.phase = 0;
  }

  process(input: Float32Array): Float32Array {
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    if (this.inputRate === TARGET_SAMPLE_RATE || this.inputRate <= 0) {
      return new Float32Array(input);
    }

    let source: Float32Array;
    if (this.needsFilter) {
      source = new Float32Array(n);
      if (!this.filterInitialized) {
        const init = input[0];
        this.x1 = init;
        this.x2 = init;
        this.y1 = init;
        this.y2 = init;
        this.filterInitialized = true;
      }
      let { x1, x2, y1, y2 } = this;
      const { b0, b1, b2, a1, a2 } = this;
      for (let i = 0; i < n; i += 1) {
        const x0 = input[i];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        source[i] = y0;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
      }
      this.x1 = x1;
      this.x2 = x2;
      this.y1 = y1;
      this.y2 = y2;
    } else {
      source = input;
    }

    if (!this.hasPrevFiltered) {
      this.prevFiltered = source[0];
      this.hasPrevFiltered = true;
    }

    const ratio = this.ratio;
    let pos = this.phase;
    const maxPos = n - 1;
    const estimatedOut =
      pos <= maxPos ? Math.floor((maxPos - pos) / ratio) + 2 : 0;
    const out = new Float32Array(Math.max(0, estimatedOut));
    let outIdx = 0;

    while (pos <= maxPos) {
      if (pos < 0) {
        const frac = pos + 1;
        out[outIdx] =
          this.prevFiltered + (source[0] - this.prevFiltered) * frac;
      } else {
        const idx = Math.floor(pos);
        const frac = pos - idx;
        if (frac === 0 || idx >= maxPos) {
          out[outIdx] = source[idx];
        } else {
          const s0 = source[idx];
          const s1 = source[idx + 1];
          out[outIdx] = s0 + (s1 - s0) * frac;
        }
      }
      outIdx += 1;
      pos += ratio;
    }

    this.prevFiltered = source[n - 1];
    this.phase = pos - n;
    return outIdx === out.length ? out : out.subarray(0, outIdx);
  }
}

export function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
): Float32Array {
  return new StatefulResampler16k(inputRate).process(input);
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

/**
 * Returns `true` when Android native `SpeechRecognizer` should handle STT
 * exclusively (skipping parallel WebView `getUserMedia`/`MediaRecorder` to
 * avoid Android audio HAL microphone contention).
 */
export function shouldPreferAndroidNativeStt(): boolean {
  if (!isAndroidNativeSpeechAvailable()) return false;
  const caps = getCachedAndroidSpeechCapabilities();
  if (caps && !caps.sttAvailable) return false;
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
  if (isSttFallbackEligibleError(error)) return true;
  if (typeof error === "object") {
    const rec = error as { code?: unknown; message?: unknown };
    const code = typeof rec.code === "string" ? rec.code : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    const combined = `${code} ${message}`;
    return (
      combined.includes("WASM STT") ||
      combined.includes("Model fetch failed") ||
      combined.includes("Model SHA-256") ||
      combined.includes("Model size mismatch") ||
      combined.includes("OfflineRecognizer") ||
      combined.includes("WASM aborted")
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

async function resolveDefaultSttStreamEndpoint(
  forceRefresh = false,
): Promise<SttStreamEndpointConfig | null> {
  try {
    const wsUrl = toWebSocketSttUrl(getApiBaseUrl());
    if (!wsUrl) return null;
    const supabase = createBrowserSupabaseClient();
    const { error: initError } = await supabase.auth.initialize();
    if (initError) return null;
    if (forceRefresh && typeof supabase.auth.refreshSession === "function") {
      const { data: refreshed, error: refreshErr } =
        await supabase.auth.refreshSession();
      const refreshedToken = refreshed.session?.access_token;
      if (!refreshErr && refreshedToken) {
        return { wsUrl, token: refreshedToken };
      }
    }
    const { data, error } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (error || !token) return null;
    return { wsUrl, token };
  } catch {
    return null;
  }
}

interface ResolvedSegmentResult {
  readonly text: string;
  readonly words?: readonly WordTimestamp[] | null;
  readonly audioQuality?: SegmentAudioQuality;
}

function normalizeWordTimings(
  rawWords:
    | readonly {
        text?: string;
        start?: number;
        end?: number;
        type?: string;
        logprob?: number | null;
      }[]
    | null
    | undefined,
): WordTimestamp[] | undefined {
  if (!rawWords?.length) return undefined;
  const out: WordTimestamp[] = [];
  for (const w of rawWords) {
    const text = (w.text ?? "").normalize("NFC").trim();
    if (
      text &&
      typeof w.start === "number" &&
      typeof w.end === "number" &&
      Number.isFinite(w.start) &&
      Number.isFinite(w.end) &&
      w.end >= w.start
    ) {
      out.push({
        text,
        start: w.start,
        end: w.end,
        type: w.type ?? "word",
        ...(w.logprob !== undefined ? { logprob: w.logprob } : {}),
      });
    }
  }
  return out.length ? out : undefined;
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
  readonly voicedDurationMs: number;
  readonly qualitySnapshot: SegmentAudioQuality;
  readonly audioToEncode: Float32Array;
  readonly resolve: (result: ResolvedSegmentResult | null) => void;
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
  private resampler: StatefulResampler16k | null = null;
  private abortController: AbortController | null = null;
  private interimAbortController: AbortController | null = null;
  private resultsHistory: SegmentSpeechResultItem[] = [];
  private preRoll: Float32Array = new Float32Array(0);
  private speechChunks: Float32Array[] = [];
  private speechSamples = 0;
  private segmentPreRollSamples = 0;
  private voicedSamples = 0;
  private silenceSamples = 0;
  private quietFrameStreak = 0;
  private inSpeech = false;
  private segmentOnsetAt: number | null = null;
  private segmentSumSq = 0;
  private segmentPeak = 0;
  private segmentClippedSamples = 0;
  private segmentCheckedSamples = 0;
  private recentChunkClipRatios: number[] = [];
  private segmentClippedFrames = 0;
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private turnSeq = 0;
  private epoch = 0;
  private lastInterimSpeechSamples = 0;
  private lastInterimVoicedSamples = 0;
  private lastInterimActiveSamples = 0;
  private interimInFlight = false;
  private interimGeneration = 0;
  private segmentInterims: string[] = [];
  private pendingUploads: Set<Promise<void>> = new Set();
  private uploadChain: Promise<void> = Promise.resolve();
  private browserFallbackRec: SegmentSpeechRecognitionLike | null = null;
  private usingBrowserFallback = false;
  private usingWasmStt = false;
  private wasmFallbackReason: string | null = null;
  private browserBaseOffset = 0;
  private browserCycleSlotToHistoryIdx = new Map<number, number>();
  private browserSpeechOnsetAt: number | null = null;
  private browserNetworkErrorCount = 0;
  private browserFatalError = false;
  private browserRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveTechnicalFailures = 0;
  private sttCircuitOpen = false;

  private ws: WebSocket | null = null;
  private wsReady = false;
  private wsDisabledForRun = false;
  private wsAuthRetriedForRun = false;
  private wsCurrentTurnId: string | null = null;
  private wsStreamingCurrentSegment = false;
  private wsStartedPageId: string | null = null;
  private wsStartedSessionId: string | null = null;
  private wsPcmTail: Float32Array = new Float32Array(0);
  private wsPendingByTurnId = new Map<string, PendingWsSegment>();
  private lifecycleCleanup: (() => void) | null = null;
  private boundTrack: MediaStreamTrack | null = null;
  private boundTrackEndedHandler: (() => void) | null = null;

  constructor(
    private readonly speechService: SpeechService,
    private readonly getContext?: () => LocalSegmentContextSnapshot,
    private readonly resolveWsEndpoint: (
      forceRefresh?: boolean,
    ) => Promise<SttStreamEndpointConfig | null> = resolveDefaultSttStreamEndpoint,
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
    this.browserCycleSlotToHistoryIdx.clear();
    this.browserSpeechOnsetAt = null;
    this.browserNetworkErrorCount = 0;
    this.browserFatalError = false;
    this.clearBrowserRestartTimer();
    this.abortController = new AbortController();
    this.resultsHistory = [];
    this.uploadChain = Promise.resolve();
    this.consecutiveTechnicalFailures = 0;
    this.wsDisabledForRun = false;
    this.wsAuthRetriedForRun = false;
    this.wsReady = false;
    this.wsCurrentTurnId = null;
    this.wsStartedPageId = null;
    this.wsStartedSessionId = null;
    this.wsPcmTail = new Float32Array(0);
    this.resetSegmentState();
    this.attachLifecycleListeners();

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
      const localUnconfigured =
        freshHealth !== null &&
        (freshHealth.local.configured === false ||
          freshHealth.local.error_code === "LOCAL_VOICE_UNCONFIGURED");
      const now = Date.now();
      const withinEmergencyCooldown =
        lastLocalSttOutageAt > 0 &&
        now - lastLocalSttOutageAt < LOCAL_OUTAGE_RETRY_MS &&
        (getVoiceEngineStatus().stt.tier === "browser_wasm" ||
          getVoiceEngineStatus().stt.tier === "browser_default" ||
          getVoiceEngineStatus().stt.tier === "android_native");

      const caps = getCachedAndroidSpeechCapabilities();
      const androidSttReady =
        isAndroidNativeSpeechAvailable() && (caps ? caps.sttAvailable : true);
      const optedInStreamingBrowser =
        policy.providerMode === "local_with_google_fallback" &&
        policy.allowGoogleSttFallback &&
        Boolean(getBrowserSpeechRecognitionCtor());
      const backendGoogleSttAvailable =
        policy.providerMode === "local_with_google_fallback" &&
        policy.allowGoogleSttFallback &&
        freshHealth !== null &&
        freshHealth.google.stt_configured &&
        !freshHealth.google.stt_cooldown;
      const confirmedLocalDownNoGoogle =
        confirmedLocalDown &&
        (!freshHealth.google.stt_configured || freshHealth.google.stt_cooldown);

      // Priority when Local Worker is unavailable:
      // 1. Android Native STT (100% on-device streaming on Android APK WebView).
      // 2. Hosted opted-in streaming Web Speech API (low-latency vi-VN on Chrome/Edge
      //    when parent enabled online fallback & backend Google STT is unavailable).
      // 3. Backend Google Cloud STT (when opted-in and configured/not in cooldown).
      // 4. On-device Browser WASM Sherpa-ONNX (100% offline / privacy-first under `local_only`
      //    or browsers without Web Speech API).
      if (
        (confirmedLocalDown || withinEmergencyCooldown) &&
        androidSttReady &&
        this.tryActivateBrowserFallback()
      ) {
        if (confirmedLocalDown) {
          lastLocalSttOutageAt = now;
        }
        return;
      }

      if (
        optedInStreamingBrowser &&
        localUnconfigured &&
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
        !backendGoogleSttAvailable &&
        (confirmedLocalDown || withinEmergencyCooldown) &&
        detectBrowserWasmSttSupport().supported
      ) {
        if (confirmedLocalDown) {
          lastLocalSttOutageAt = now;
        }
        this.usingWasmStt = true;
        this.wsDisabledForRun = true;
        this.wasmFallbackReason = localUnconfigured
          ? null
          : confirmedLocalDown
            ? "LOCAL_STT_UNAVAILABLE"
            : null;
        recordSttEngineUsage({
          provider: "wasm",
          fallbackUsed: !localUnconfigured && confirmedLocalDown,
          fallbackReason: this.wasmFallbackReason,
        });
        void getBrowserWasmSttClient()
          .init(this.abortController.signal)
          .catch(() => undefined);
      } else if (
        optedInStreamingBrowser &&
        (confirmedLocalDownNoGoogle || withinEmergencyCooldown)
      ) {
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
    const stopEpoch = this.epoch;
    this.stopping = true;
    this.clearBrowserRestartTimer();
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
        this.detachLifecycleListeners();
        this.onend?.();
      }
      return;
    }
    // Flush any pending speech segment before emitting onend
    if (
      this.inSpeech &&
      this.voicedSamples >= (TARGET_SAMPLE_RATE * MIN_SPEECH_MS) / 1000
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
      if (this.epoch !== stopEpoch) return;
      this.closeSttWebSocket();
      this.detachLifecycleListeners();
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
    this.browserCycleSlotToHistoryIdx.clear();
    this.browserSpeechOnsetAt = null;
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
    this.detachLifecycleListeners();
    this.onend?.();
  }

  private clearBrowserRestartTimer(): void {
    if (this.browserRestartTimer !== null) {
      clearTimeout(this.browserRestartTimer);
      this.browserRestartTimer = null;
    }
  }

  private attachLifecycleListeners(): void {
    if (this.lifecycleCleanup || typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.hidden && this.active && !this.stopping) {
        this.abort();
      }
    };
    const onAndroidBg = () => {
      if (this.active && !this.stopping) {
        this.abort();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("viread:android-background", onAndroidBg);
    this.lifecycleCleanup = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("viread:android-background", onAndroidBg);
    };
  }

  private detachLifecycleListeners(): void {
    if (this.lifecycleCleanup) {
      this.lifecycleCleanup();
      this.lifecycleCleanup = null;
    }
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
      const caps = getCachedAndroidSpeechCapabilities();
      const androidSttReady =
        isAndroidNativeSpeechAvailable() && (caps ? caps.sttAvailable : true);
      if (androidSttReady && this.tryActivateBrowserFallback()) {
        return true;
      }
      const policy = getVoicePolicyPreferences();
      const localUnconfigured =
        freshHealth !== null &&
        (freshHealth.local.configured === false ||
          freshHealth.local.error_code === "LOCAL_VOICE_UNCONFIGURED");
      const optedInStreamingBrowser =
        policy.providerMode === "local_with_google_fallback" &&
        policy.allowGoogleSttFallback &&
        Boolean(getBrowserSpeechRecognitionCtor());
      if (
        localUnconfigured &&
        optedInStreamingBrowser &&
        this.tryActivateBrowserFallback()
      ) {
        return true;
      }
      if (detectBrowserWasmSttSupport().supported) {
        this.usingWasmStt = true;
        this.wsDisabledForRun = true;
        this.wasmFallbackReason = localUnconfigured
          ? null
          : "LOCAL_STT_UNAVAILABLE";
        this.closeSttWebSocket();
        recordSttEngineUsage({
          provider: "wasm",
          fallbackUsed: !localUnconfigured,
          fallbackReason: this.wasmFallbackReason,
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
    this.closeSttWebSocket();
    this.resetSegmentState();
    this.teardownAudioGraph();
    this.attachLifecycleListeners();
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
    this.browserCycleSlotToHistoryIdx.clear();
    this.browserSpeechOnsetAt = null;
    this.browserNetworkErrorCount = 0;
    this.browserFatalError = false;

    const recordSpeechOnset = () => {
      if (!this.active || this.browserFallbackRec !== nativeRec) return;
      if (this.browserSpeechOnsetAt === null) {
        this.browserSpeechOnsetAt =
          typeof performance !== "undefined" ? performance.now() : Date.now();
      }
    };
    nativeRec.onspeechstart = recordSpeechOnset;
    nativeRec.onsoundstart = recordSpeechOnset;

    nativeRec.onresult = (ev: SegmentSpeechEvent) => {
      if (!this.active || this.browserFallbackRec !== nativeRec) return;
      this.browserNetworkErrorCount = 0;
      const ctx = this.getContext?.() ?? {};
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const capturedOnset = this.browserSpeechOnsetAt;

      const pendingInterims: SegmentSpeechResultItem[] = [];
      let firstNewHistoryIdx: number | null = null;
      let sawFinal = false;

      for (let i = 0; i < ev.results.length; i += 1) {
        const rawItem = ev.results[i];
        if (!rawItem) continue;
        // Explicitly copy WebIDL SpeechRecognitionResult getters (`isFinal`, `length`, `[0..N]`)
        // instead of `{ ...rawItem }`, which drops non-enumerable prototype getters!
        const rawAltCount = Number(rawItem.length ?? 0);
        const copiedAlts: SegmentSpeechResultAlternative[] = [];
        for (let a = 0; a < rawAltCount; a += 1) {
          const alt = rawItem[a];
          if (alt) {
            copiedAlts.push({
              transcript: String(alt.transcript ?? "").normalize("NFC"),
              confidence:
                typeof alt.confidence === "number" ? alt.confidence : undefined,
            });
          }
        }
        if (copiedAlts.length === 0 && rawItem[0]) {
          copiedAlts.push({
            transcript: String(rawItem[0].transcript ?? "").normalize("NFC"),
            confidence:
              typeof rawItem[0].confidence === "number"
                ? rawItem[0].confidence
                : undefined,
          });
        }

        const isFinal = Boolean(rawItem.isFinal);
        // Interim-onset fallback for browsers that emit onresult before onspeechstart/onsoundstart.
        if (
          !isFinal &&
          this.browserSpeechOnsetAt === null &&
          copiedAlts[0]?.transcript.trim()
        ) {
          this.browserSpeechOnsetAt = now;
        }
        const effectiveOnset =
          rawItem.onsetAt ?? capturedOnset ?? this.browserSpeechOnsetAt ?? null;
        const fallbackTurnId =
          rawItem.turnId ?? nextTurnId(ctx.pageId ?? "browser", ++this.turnSeq);
        const itemObj: Record<number, SegmentSpeechResultAlternative> & {
          isFinal: boolean;
          length: number;
          epoch: number;
          sessionId: string | null;
          pageId: string | null;
          turnId: string;
          segmentId: string;
          onsetAt: number | null;
          audioEndedAt: number;
          speechDurationMs: number | null;
          audioQuality?: SegmentAudioQuality;
          words?: readonly WordTimestamp[] | null;
        } = {
          isFinal,
          length: copiedAlts.length,
          epoch: rawItem.epoch ?? this.epoch,
          sessionId: rawItem.sessionId ?? ctx.sessionId ?? null,
          pageId: rawItem.pageId ?? ctx.pageId ?? null,
          turnId: fallbackTurnId,
          segmentId: rawItem.segmentId ?? fallbackTurnId,
          onsetAt: effectiveOnset,
          audioEndedAt: rawItem.audioEndedAt ?? now,
          speechDurationMs: rawItem.speechDurationMs ?? null,
          audioQuality: rawItem.audioQuality,
          words: rawItem.words,
        };
        for (let a = 0; a < copiedAlts.length; a += 1) {
          itemObj[a] = copiedAlts[a];
        }
        const item = itemObj as unknown as SegmentSpeechResultItem;

        if (isFinal) {
          sawFinal = true;
          if (!this.browserCycleSlotToHistoryIdx.has(i)) {
            const histIdx = this.resultsHistory.length;
            this.resultsHistory.push(item);
            this.browserCycleSlotToHistoryIdx.set(i, histIdx);
            if (firstNewHistoryIdx === null) {
              firstNewHistoryIdx = histIdx;
            }
          }
        } else if (!this.browserCycleSlotToHistoryIdx.has(i)) {
          pendingInterims.push(item);
        }
      }

      if (sawFinal) {
        this.browserSpeechOnsetAt = null;
      }

      // Build a 100% dense results array-like (zero sparse holes across restarts or out-of-order finals).
      const historyLen = this.resultsHistory.length;
      const totalLength = historyLen + pendingInterims.length;
      const resultsObj: Record<number, SegmentSpeechResultItem> & {
        length: number;
      } = { length: totalLength };
      for (let i = 0; i < historyLen; i += 1) {
        resultsObj[i] = this.resultsHistory[i];
      }
      for (let i = 0; i < pendingInterims.length; i += 1) {
        resultsObj[historyLen + i] = pendingInterims[i];
      }
      const emittedResultIndex =
        firstNewHistoryIdx !== null
          ? firstNewHistoryIdx
          : Math.min(historyLen, Math.max(0, totalLength - 1));
      this.onresult?.({
        resultIndex: emittedResultIndex,
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
      const errCode = ev?.error ?? "";
      if (
        errCode === "not-allowed" ||
        errCode === "service-not-allowed" ||
        errCode === "language-not-supported" ||
        errCode === "stt-unavailable"
      ) {
        this.browserFatalError = true;
      } else if (errCode === "network" || errCode === "audio-capture") {
        this.browserNetworkErrorCount += 1;
        if (this.browserNetworkErrorCount >= 3) {
          this.browserFatalError = true;
        }
      }
      this.onerror?.(ev);
    };

    nativeRec.onend = () => {
      if (this.browserFallbackRec !== nativeRec) return;
      this.browserSpeechOnsetAt = null;
      if (
        this.active &&
        !this.stopping &&
        this.continuous &&
        !this.browserFatalError
      ) {
        this.browserCycleSlotToHistoryIdx.clear();
        this.browserBaseOffset = this.resultsHistory.length;
        const backoffMs =
          this.browserNetworkErrorCount > 0
            ? Math.min(4_000, 500 * 2 ** (this.browserNetworkErrorCount - 1))
            : 80;
        this.clearBrowserRestartTimer();
        this.browserRestartTimer = setTimeout(() => {
          this.browserRestartTimer = null;
          if (
            !this.active ||
            this.stopping ||
            this.browserFatalError ||
            this.browserFallbackRec !== nativeRec
          ) {
            return;
          }
          try {
            nativeRec.start();
          } catch {
            this.browserFallbackRec = null;
            this.usingBrowserFallback = false;
            this.active = false;
            this.stopping = false;
            this.detachLifecycleListeners();
            this.onend?.();
          }
        }, backoffMs);
        return;
      }
      this.clearBrowserRestartTimer();
      this.browserFallbackRec = null;
      this.usingBrowserFallback = false;
      this.active = false;
      this.stopping = false;
      this.detachLifecycleListeners();
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
    this.segmentPreRollSamples = 0;
    this.voicedSamples = 0;
    this.lastInterimVoicedSamples = 0;
    this.lastInterimActiveSamples = 0;
    this.silenceSamples = 0;
    this.inSpeech = false;
    this.segmentOnsetAt = null;
    this.segmentSumSq = 0;
    this.segmentPeak = 0;
    this.segmentClippedSamples = 0;
    this.segmentCheckedSamples = 0;
    this.recentChunkClipRatios = [];
    this.segmentClippedFrames = 0;
    this.segmentInterims = [];
    this.wsStreamingCurrentSegment = false;
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
        (result) => pending.resolve(result),
        (err) => {
          if (isTechnicalSttUnavailabilityError(err)) {
            this.recordTechnicalFailureAndMaybeFallback(err);
          }
          pending.resolve(null);
        },
      );
    }
  }

  private async runHttpFallbackForPendingSegment(
    pending: PendingWsSegment,
  ): Promise<ResolvedSegmentResult | null> {
    if (
      pending.capturedEpoch !== this.epoch ||
      this.usingBrowserFallback ||
      (!this.active && !this.stopping)
    ) {
      return null;
    }
    const signal = this.abortController?.signal;
    let rawText = "";
    let rawWords: readonly WordTimestamp[] | null | undefined;
    if (this.usingWasmStt) {
      const wasmRes = await getBrowserWasmSttClient().transcribeSamples(
        pending.audioToEncode,
        {
          signal,
          timeoutMs: 20_000,
          voicedDurationMs: pending.voicedDurationMs,
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
        voicedDurationMs: pending.voicedDurationMs,
        source: "local_live_segment",
        signal,
        timeoutMs: 12_000,
      });
      this.consecutiveTechnicalFailures = 0;
      lastLocalSttOutageAt = 0;
      rawText = (res.text ?? "").normalize("NFC").trim();
      rawWords = normalizeWordTimings(res.words) ?? null;
    }
    if (!rawText) return null;
    const reconciled = reconcileSegmentTranscriptWithInterims(
      rawText,
      pending.capturedInterims,
      pending.keyterms,
    );
    return reconciled ? { text: reconciled, words: rawWords } : null;
  }

  private async openSttWebSocket(forceRefresh = false): Promise<void> {
    if (
      typeof WebSocket !== "function" ||
      this.wsDisabledForRun ||
      !this.active ||
      this.stopping ||
      this.usingBrowserFallback
    ) {
      return;
    }
    const capturedEpoch = this.epoch;
    const endpoint = await this.resolveWsEndpoint(forceRefresh);
    if (
      capturedEpoch !== this.epoch ||
      !endpoint ||
      !this.active ||
      this.stopping ||
      this.usingBrowserFallback ||
      this.wsDisabledForRun
    ) {
      return;
    }
    let socket: WebSocket;
    try {
      // Never put JWT tokens in Sec-WebSocket-Protocol (`bearer.<jwt>` leaks in logs/proxies);
      // authenticate cleanly via first JSON "auth" frame followed by "start" frame.
      socket = new WebSocket(endpoint.wsUrl, ["viread-stt-v1"]);
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
            type: "auth",
            token: endpoint.token,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "start",
            session_id: this.wsStartedSessionId,
            page_id: this.wsStartedPageId,
            turn_id: turnId,
            sample_rate: TARGET_SAMPLE_RATE,
            language: "vi",
            vad_mode: "client",
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
        words?: readonly WordTimestamp[] | null;
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
        this.wsAuthRetriedForRun = false;
        recordSttEngineUsage({
          provider: "local",
          fallbackUsed: false,
          fallbackReason: null,
        });
        return;
      }

      if (msg.type === "error") {
        if (msg.code === "UNAUTHORIZED" && !this.wsAuthRetriedForRun) {
          this.wsAuthRetriedForRun = true;
          invalidateBrowserTokenCache();
          this.closeSttWebSocket();
          void this.openSttWebSocket(true);
          return;
        }
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
      const mappedWords = normalizeWordTimings(msg.words) ?? null;
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
        const voicedSpeechMs = (this.voicedSamples / TARGET_SAMPLE_RATE) * 1000;
        const activeSpeechMs =
          voicedSpeechMs > 0
            ? voicedSpeechMs
            : Math.max(
                0,
                ((this.speechSamples -
                  this.segmentPreRollSamples -
                  this.silenceSamples) /
                  TARGET_SAMPLE_RATE) *
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
          words: mappedWords,
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
            : "";
          pending.resolve(
            reconciled
              ? {
                  text: reconciled,
                  words: mappedWords,
                  audioQuality: mappedQuality,
                }
              : null,
          );
        }
        return;
      }

      // Spontaneous final from WS without a preceding client flush (e.g. safety cap)
      if (!rawText || (!this.active && !this.stopping)) return;
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const voicedSpeechMs = (this.voicedSamples / TARGET_SAMPLE_RATE) * 1000;
      const activeSpeechMs =
        voicedSpeechMs > 0
          ? voicedSpeechMs
          : Math.max(
              0,
              ((this.speechSamples -
                this.segmentPreRollSamples -
                this.silenceSamples) /
                TARGET_SAMPLE_RATE) *
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
        ...(mappedWords ? { words: mappedWords } : {}),
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
      // Let onclose distinguish auth refresh (1008/4401) from hard outages.
      this.wsReady = false;
    };

    socket.onclose = (ev: CloseEvent) => {
      if (this.ws !== socket) return;
      const isAuthClose = ev.code === 1008 || ev.code === 4401;
      if (
        isAuthClose &&
        !this.wsAuthRetriedForRun &&
        this.active &&
        !this.stopping &&
        !this.usingBrowserFallback &&
        capturedEpoch === this.epoch
      ) {
        this.wsAuthRetriedForRun = true;
        invalidateBrowserTokenCache();
        this.closeSttWebSocket();
        void this.openSttWebSocket(true);
        return;
      }
      if (
        ev.code === 1008 ||
        ev.code === 4401 ||
        ev.code === 4503 ||
        ev.code !== 1000
      ) {
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
    const scopeChanged =
      this.wsStartedPageId !== nextPageId ||
      this.wsStartedSessionId !== nextSessionId;
    if (!this.wsCurrentTurnId) {
      this.wsCurrentTurnId = turnId;
    }
    // Only send a fresh "start" control frame when session/page scope changes;
    // normal sentence-to-sentence turns advance via flush.next_turn_id with zero redundant "start"/"ready" RTT!
    if (scopeChanged) {
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
            vad_mode: "client",
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
    if (this.boundTrack && this.boundTrackEndedHandler) {
      try {
        this.boundTrack.removeEventListener(
          "ended",
          this.boundTrackEndedHandler,
        );
      } catch {
        // Ignore
      }
    }
    this.boundTrack = null;
    this.boundTrackEndedHandler = null;
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
    this.resampler = null;
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
    const capturedEpoch = this.epoch;
    const isStale = () =>
      capturedEpoch !== this.epoch || !this.active || this.stopping;
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
        if (isStale()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.ownedStream = stream;
      }

      // Cleanly abort capture & close WS if the mic track ends or app enters background.
      const primaryTrack = stream.getAudioTracks?.()?.[0] ?? audioTrack ?? null;
      if (primaryTrack) {
        const onTrackEnded = () => {
          if (capturedEpoch === this.epoch && this.active && !this.stopping) {
            this.abort();
          }
        };
        this.boundTrack = primaryTrack;
        this.boundTrackEndedHandler = onTrackEnded;
        try {
          primaryTrack.addEventListener("ended", onTrackEnded, { once: true });
        } catch {
          // Ignore
        }
      }
      this.attachLifecycleListeners();

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
        if (isStale()) {
          if (this.audioCtx === ctx) {
            this.teardownAudioGraph();
          } else {
            void ctx.close().catch(() => undefined);
          }
          return;
        }
        if (ctx.state === "suspended") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (isStale()) {
            if (this.audioCtx === ctx) {
              this.teardownAudioGraph();
            } else {
              void ctx.close().catch(() => undefined);
            }
            return;
          }
          await ctx.resume().catch(() => undefined);
          if (isStale()) {
            if (this.audioCtx === ctx) {
              this.teardownAudioGraph();
            } else {
              void ctx.close().catch(() => undefined);
            }
            return;
          }
        }
      }

      const source = ctx.createMediaStreamSource(stream);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      this.sourceNode = source;
      const resampler = new StatefulResampler16k(ctx.sampleRate);
      this.resampler = resampler;

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
          if (isStale()) {
            if (this.audioCtx === ctx) {
              this.teardownAudioGraph();
            } else {
              URL.revokeObjectURL(workletUrl);
              void ctx.close().catch(() => undefined);
            }
            return;
          }
          const worklet = new AudioWorkletNode(ctx, "viread-capture-processor");
          worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => {
            if (isStale()) return;
            const raw = ev.data;
            if (!raw?.length) return;
            const mono16 = resampler.process(raw);
            if (mono16.length > 0) {
              this.consumeSamples16k(mono16);
            }
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

      if (isStale()) {
        if (this.audioCtx === ctx) {
          this.teardownAudioGraph();
        } else {
          void ctx.close().catch(() => undefined);
        }
        return;
      }

      if (!workletAttached) {
        const processor = ctx.createScriptProcessor(512, 1, 1);
        this.processorNode = processor;
        processor.onaudioprocess = (ev: AudioProcessingEvent) => {
          if (isStale()) return;
          const raw = ev.inputBuffer.getChannelData(0);
          const mono16 = resampler.process(raw);
          if (mono16.length > 0) {
            this.consumeSamples16k(mono16);
          }
        };
        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(ctx.destination);
      }
      void this.openSttWebSocket();
    } catch (err) {
      if (capturedEpoch !== this.epoch || !this.active) return;
      this.active = false;
      this.teardownAudioGraph();
      this.detachLifecycleListeners();
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
    let clippedInChunk = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = chunk[i];
      sumSq += sample * sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      if (abs >= 0.99) clippedInChunk += 1;
    }
    const isClippedChunk =
      clippedInChunk >= 16 && clippedInChunk / Math.max(1, chunk.length) > 0.05;
    const rms = Math.sqrt(sumSq / Math.max(1, chunk.length));
    const chunkClipRatio = clippedInChunk / Math.max(1, chunk.length);
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
        this.segmentPreRollSamples = this.preRoll.length;
        this.segmentClippedSamples = clippedInChunk;
        this.segmentCheckedSamples = chunk.length;
        this.recentChunkClipRatios = [chunkClipRatio];
        this.segmentClippedFrames = isClippedChunk ? 1 : 0;
        const ctx = this.getContext?.() ?? {};
        const turnId =
          this.wsCurrentTurnId ??
          nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
        const wsActive = this.ensureWsTurnStarted(turnId);
        this.wsStreamingCurrentSegment = wsActive;
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

    if (
      this.wsStreamingCurrentSegment &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.wsReady
    ) {
      this.streamWsPcmChunk(chunk);
    }
    this.speechChunks.push(chunk);
    this.speechSamples += chunk.length;
    this.segmentClippedSamples += clippedInChunk;
    this.segmentCheckedSamples += chunk.length;
    this.recentChunkClipRatios.push(chunkClipRatio);
    if (this.recentChunkClipRatios.length > 8) {
      this.recentChunkClipRatios.shift();
    }
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
      if (isClippedChunk) this.segmentClippedFrames += 1;
    }

    const silenceMs = (this.silenceSamples / TARGET_SAMPLE_RATE) * 1000;
    const voicedMs = (this.voicedSamples / TARGET_SAMPLE_RATE) * 1000;
    const activePostOnsetSamples = Math.max(
      0,
      this.speechSamples - this.segmentPreRollSamples,
    );
    const activeSpanMs = (activePostOnsetSamples / TARGET_SAMPLE_RATE) * 1000;
    const wsStreamingActive = Boolean(
      this.wsStreamingCurrentSegment &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.wsReady &&
      !this.wsDisabledForRun,
    );
    const canDispatchHttpInterim = !this.interimInFlight;
    const deltaActiveSamples =
      activePostOnsetSamples - this.lastInterimActiveSamples;
    const newVoicedSamples = this.voicedSamples - this.lastInterimVoicedSamples;
    const hasFreshSpeech = newVoicedSamples >= MIN_NEW_VOICED_INTERIM_SAMPLES;
    const isPauseBoundaryInterim =
      hasFreshSpeech &&
      silenceMs >= PAUSE_INTERIM_SILENCE_MS &&
      this.voicedSamples >= INTERIM_MIN_SAMPLES &&
      deltaActiveSamples >= Math.floor(TARGET_SAMPLE_RATE * 0.08);
    const isRegularInterimStep =
      hasFreshSpeech &&
      this.voicedSamples >= INTERIM_MIN_SAMPLES &&
      newVoicedSamples >= INTERIM_STEP_SAMPLES;

    if (silenceMs >= SILENCE_FLUSH_MS) {
      if (voicedMs >= MIN_SPEECH_MS) {
        this.flushCurrentSegment(false);
      } else {
        // Sub-120ms non-speech click/pop followed by silence: discard cleanly while preserving quiet pre-roll.
        const quietTail = chunk.slice();
        this.resetSegmentState();
        this.quietFrameStreak = 0;
        this.preRoll =
          quietTail.length > PRE_ROLL_SAMPLES
            ? quietTail.slice(quietTail.length - PRE_ROLL_SAMPLES)
            : quietTail;
      }
    } else if (
      voicedMs >= CLAUSE_FLUSH_MIN_SPEECH_MS &&
      silenceMs >= CLAUSE_FLUSH_SILENCE_MS
    ) {
      this.flushCurrentSegment(false);
    } else if (activeSpanMs >= MAX_SEGMENT_MS) {
      this.flushCurrentSegment(true);
    } else if (
      !wsStreamingActive &&
      this.interimResults &&
      canDispatchHttpInterim &&
      (isPauseBoundaryInterim || isRegularInterimStep)
    ) {
      this.dispatchRollingInterim();
    }
  }

  private computeAudioQuality(speechDurationMs: number): SegmentAudioQuality {
    // Compute RMS over voiced frames only (never diluted by pre-roll / tail silence).
    const rmsDenominator =
      this.voicedSamples > 0
        ? this.voicedSamples
        : Math.max(1, this.speechSamples);
    const rms = Math.sqrt(this.segmentSumSq / rmsDenominator);
    const peak = this.segmentPeak;
    const clipRatio =
      this.segmentClippedSamples / Math.max(1, this.segmentCheckedSamples);
    const sustainedWindowClip =
      this.recentChunkClipRatios.filter((r) => r >= 0.1).length >= 3 &&
      this.segmentClippedSamples >= 480;
    const isClipped =
      this.segmentClippedFrames >= 3 ||
      (clipRatio >= 0.05 && this.segmentClippedSamples >= 480) ||
      sustainedWindowClip;
    let status: SegmentAudioQuality["status"] = "OK";
    if (speechDurationMs < 80) {
      status = "AUDIO_TOO_SHORT";
    } else if (isClipped) {
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
    const usedWasm = this.usingWasmStt;
    if (usedWasm && !getBrowserWasmSttClient().isReady()) {
      // Avoid timing out a 4s rolling interim while the 34MB WASM model is still cold-initializing.
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
    const voicedDurationMs = Math.max(
      0,
      Math.round((this.voicedSamples / TARGET_SAMPLE_RATE) * 1000),
    );
    const activeSpeechMs =
      voicedDurationMs > 0
        ? voicedDurationMs
        : Math.max(
            0,
            ((total - this.segmentPreRollSamples - this.silenceSamples) /
              TARGET_SAMPLE_RATE) *
              1000,
          );
    const qualitySnapshot = this.computeAudioQuality(activeSpeechMs);
    const onsetAt = this.segmentOnsetAt;
    const capturedEpoch = this.epoch;
    this.lastInterimSpeechSamples = total;
    this.lastInterimVoicedSamples = this.voicedSamples;
    this.lastInterimActiveSamples = Math.max(
      0,
      total - this.segmentPreRollSamples,
    );
    this.interimInFlight = true;
    const gen = this.interimGeneration;
    const activeSegmentInterims = this.segmentInterims;
    const ctx = this.getContext?.() ?? {};
    const interimTurnId = nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);

    const interimPromise: Promise<{ text: string }> = usedWasm
      ? getBrowserWasmSttClient().transcribeSamples(combined, {
          signal: interimCtrl.signal,
          timeoutMs: 4_000,
          voicedDurationMs,
        })
      : this.speechService.transcribe(encodeFloat32ToWav16kBlob(combined), {
          filename: "interim.wav",
          languageCode: "vi",
          keyterms: ctx.keyterms,
          sessionId: ctx.sessionId ?? null,
          pageId: ctx.pageId ?? null,
          turnId: interimTurnId,
          voicedDurationMs,
          source: "local_live_interim",
          signal: interimCtrl.signal,
          timeoutMs: 3_500,
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
        if (
          !usedWasm &&
          !this.usingBrowserFallback &&
          capturedEpoch === this.epoch &&
          isTechnicalSttUnavailabilityError(err)
        ) {
          this.recordTechnicalFailureAndMaybeFallback(err);
          return;
        }
        if (interimCtrl.signal.aborted) return;
        if (usedWasm && this.usingWasmStt) {
          // Only leave WASM mode if browser/Android fallback actually activates;
          // otherwise stay on WASM to prevent an infinite WASM <-> dead-network ping-pong loop!
          if (this.tryActivateBrowserFallback()) {
            this.usingWasmStt = false;
          }
          return;
        }
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
    // Cancel any stale in-flight rolling interim immediately so it never head-of-line blocks final decode.
    if (this.interimAbortController) {
      try {
        this.interimAbortController.abort();
      } catch {
        // Ignore abort errors
      }
      this.interimAbortController = null;
      this.interimInFlight = false;
    }
    this.interimGeneration += 1;
    this.lastInterimSpeechSamples = 0;
    this.lastInterimVoicedSamples = 0;
    this.lastInterimActiveSamples = 0;
    if (!this.speechChunks.length) {
      this.resetSegmentState();
      return;
    }
    const total = this.speechSamples;
    const voicedDurationMs = Math.max(
      0,
      Math.round((this.voicedSamples / TARGET_SAMPLE_RATE) * 1000),
    );
    const silenceTailSamples = this.silenceSamples;
    const capturedInterims = this.segmentInterims;
    const capturedEpoch = this.epoch;
    const onsetAt = this.segmentOnsetAt;
    const audioEndedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const activeSpeechMs =
      voicedDurationMs > 0
        ? voicedDurationMs
        : Math.max(
            0,
            ((total - this.segmentPreRollSamples - silenceTailSamples) /
              TARGET_SAMPLE_RATE) *
              1000,
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
    const wasStreamingViaWs = this.wsStreamingCurrentSegment;
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
    const canFlushViaWs =
      wasStreamingViaWs &&
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.wsReady &&
      !this.wsDisabledForRun;
    // Only consume/advance `wsCurrentTurnId` when this segment actually streamed over WS;
    // if WS connected mid-utterance, preserve the server's open WS turn ID for the next utterance!
    const turnId = canFlushViaWs
      ? (this.wsCurrentTurnId ??
        nextTurnId(ctx.pageId ?? "live", ++this.turnSeq))
      : nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
    const nextTurn = nextTurnId(ctx.pageId ?? "live", ++this.turnSeq);
    const signal = this.abortController?.signal;

    const deliverFinalResult = (result: ResolvedSegmentResult | null) => {
      const text = result?.text ?? null;
      if (
        !text ||
        this.usingBrowserFallback ||
        capturedEpoch !== this.epoch ||
        (!this.active && !this.stopping)
      ) {
        return;
      }
      const resultIndex = this.resultsHistory.length;
      const effectiveQuality = result?.audioQuality ?? qualitySnapshot;
      const item: SegmentSpeechResultItem = {
        isFinal: true,
        length: 1,
        0: {
          transcript: text.normalize("NFC"),
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
        speechDurationMs: effectiveQuality.speechDurationMs,
        audioQuality: effectiveQuality,
        ...(result?.words ? { words: result.words } : {}),
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

    if (canFlushViaWs) {
      this.wsCurrentTurnId = nextTurn;
    }
    let attemptedWasm = false;

    const responsePromise: Promise<ResolvedSegmentResult | null> = canFlushViaWs
      ? new Promise<ResolvedSegmentResult | null>((resolve) => {
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
            voicedDurationMs,
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
                (res) => resolve(res),
                (err) => {
                  if (isTechnicalSttUnavailabilityError(err)) {
                    this.recordTechnicalFailureAndMaybeFallback(err);
                  }
                  resolve(null);
                },
              );
            }, WS_FLUSH_FALLBACK_TIMEOUT_MS),
          };
          this.wsPendingByTurnId.set(turnId, pending);
          try {
            this.ws!.send(
              JSON.stringify({
                type: "flush",
                turn_id: turnId,
                next_turn_id: nextTurn,
                voiced_duration_ms: voicedDurationMs,
              }),
            );
          } catch {
            this.wsPendingByTurnId.delete(turnId);
            clearTimeout(pending.fallbackTimer);
            pending.settled = true;
            this.wsDisabledForRun = true;
            void this.runHttpFallbackForPendingSegment(pending).then(
              (res) => resolve(res),
              (err) => {
                if (isTechnicalSttUnavailabilityError(err)) {
                  this.recordTechnicalFailureAndMaybeFallback(err);
                }
                resolve(null);
              },
            );
          }
        })
      : (() => {
          const transcribeWithWasm = async () => {
            attemptedWasm = true;
            const wasmRes = await getBrowserWasmSttClient().transcribeSamples(
              audioToEncode,
              {
                signal,
                timeoutMs: 20_000,
                voicedDurationMs,
              },
            );
            const freshHealth = getFreshVoiceEngineHealth();
            const localUnconfigured =
              freshHealth !== null &&
              (freshHealth.local.configured === false ||
                freshHealth.local.error_code === "LOCAL_VOICE_UNCONFIGURED");
            recordSttEngineUsage({
              provider: "wasm",
              fallbackUsed: !localUnconfigured,
              fallbackReason: localUnconfigured
                ? null
                : (this.wasmFallbackReason ?? "LOCAL_STT_UNAVAILABLE"),
            });
            return {
              text: wasmRes.text,
              words: null as readonly WordTimestamp[] | null,
              fromWasm: true as const,
            };
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
              voicedDurationMs,
              source: "local_live_segment",
              signal,
              timeoutMs: 12_000,
            });
            return {
              text: res.text,
              words: normalizeWordTimings(res.words) ?? null,
              fromWasm: false as const,
            };
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
                // Tier 1 WASM failed -> switch to Tier 3 (Android Native / Web Speech) ONLY if allowed & available.
                if (this.tryActivateBrowserFallback()) {
                  this.usingWasmStt = false;
                  return {
                    text: "",
                    words: null as readonly WordTimestamp[] | null,
                    fromWasm: true as const,
                  };
                }
                throw err;
              }
              if (
                isTechnicalSttUnavailabilityError(err) &&
                this.recordTechnicalFailureAndMaybeFallback(err)
              ) {
                if (this.usingWasmStt) {
                  try {
                    return await transcribeWithWasm();
                  } catch (wasmErr) {
                    if (this.tryActivateBrowserFallback()) {
                      this.usingWasmStt = false;
                      return {
                        text: "",
                        words: null as readonly WordTimestamp[] | null,
                        fromWasm: true as const,
                      };
                    }
                    throw wasmErr;
                  }
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
            const reconciled = reconcileSegmentTranscriptWithInterims(
              rawText,
              capturedInterims,
              ctx.keyterms,
            );
            return reconciled ? { text: reconciled, words: res.words } : null;
          });
        })();

    // Deliver results strictly in FIFO order via uploadChain so segment N+1
    // NEVER overtakes segment N and causes false RED alignment skips!
    const deliveryTask = this.uploadChain
      .then(async () => {
        const result = await responsePromise;
        deliverFinalResult(result);
      })
      .catch((err) => {
        if (signal?.aborted || capturedEpoch !== this.epoch) return;
        const isWasmFailure =
          attemptedWasm && !(err instanceof Error && err.name === "AbortError");
        if (
          (isTechnicalSttUnavailabilityError(err) || isWasmFailure) &&
          !this.usingBrowserFallback
        ) {
          if (this.tryActivateBrowserFallback()) {
            return;
          }
          this.tripServiceCircuitBreaker();
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
