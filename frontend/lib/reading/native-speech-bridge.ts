/**
 * Android WebView Native Speech Bridge Client (`window.ViReadNativeSpeech`).
 *
 * Communicates with Android `WebViewCompat.addWebMessageListener` registered
 * strictly on the trusted HTTPS origin + main frame in `ViReadNativeSpeechBridge.java`.
 *
 * Provides 0-VND, 24/7 laptop-independent Vietnamese TTS (`android.speech.tts.TextToSpeech`
 * with `onRangeStart` word-highlight events) and STT (`android.speech.SpeechRecognizer`
 * with `onsetAt` and `rmsDb` telemetry) without holding a competing WebView `getUserMedia`
 * stream on Android audio HAL.
 */

import type {
  SegmentSpeechErrorEvent,
  SegmentSpeechEvent,
  SegmentSpeechRecognitionLike,
  SegmentSpeechResultItem,
} from "@/lib/reading/local-segment-speech-recognition";
import { recordSttEngineUsage } from "@/lib/reading/voice-engine-status";

export interface ViReadNativeSpeechPort {
  postMessage(message: string): void;
  onmessage?: ((event: { data?: unknown } | MessageEvent) => void) | null;
  addEventListener?: (
    type: "message",
    listener: (event: { data?: unknown } | MessageEvent) => void,
  ) => void;
  removeEventListener?: (
    type: "message",
    listener: (event: { data?: unknown } | MessageEvent) => void,
  ) => void;
}

export interface AndroidSpeechCapabilities {
  readonly ttsAvailable: boolean;
  readonly viVoicesCount: number;
  readonly hasMaleViVoice?: boolean;
  readonly hasFemaleViVoice?: boolean;
  readonly sttAvailable: boolean;
  readonly onDeviceSttAvailable: boolean;
  readonly platform: string;
}

export interface AndroidNativeTtsSpeakOptions {
  readonly rate?: number;
  readonly pitch?: number;
  readonly voiceGender?: "male" | "female" | null;
  readonly voiceId?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onStart?: (meta?: {
    readonly voiceGenderMismatch?: boolean;
    readonly resolvedVoiceName?: string | null;
    readonly actualVoiceGender?: string | null;
  }) => void;
  readonly onRangeStart?: (start: number, end: number) => void;
  readonly onDone?: () => void;
}

export interface NativeSpeechIncomingEvent {
  readonly type: string;
  readonly requestId?: string;
  readonly ttsAvailable?: boolean;
  readonly viVoicesCount?: number;
  readonly hasMaleViVoice?: boolean;
  readonly hasFemaleViVoice?: boolean;
  readonly actualVoiceGender?: string;
  readonly sttAvailable?: boolean;
  readonly onDeviceSttAvailable?: boolean;
  readonly platform?: string;
  readonly voiceGenderMismatch?: boolean;
  readonly resolvedVoiceName?: string | null;
  readonly start?: number;
  readonly end?: number;
  readonly onsetAt?: number;
  readonly rmsDb?: number;
  readonly transcript?: string;
  readonly alternatives?: readonly string[];
  readonly code?: string;
  readonly message?: string;
}

type BridgeEventListener = (event: NativeSpeechIncomingEvent) => void;

const MAX_TTS_TEXT_CHARS = 2_500;
const DEFAULT_CAPABILITIES_TIMEOUT_MS = 8_500;
const DEGRADED_CAPABILITIES_TTL_MS = 5_000;
const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const DEFAULT_SETTINGS_TIMEOUT_MS = 2_500;

let requestSeq = 0;
let attachedPort: ViReadNativeSpeechPort | null = null;
let attachedHandler:
  ((event: { data?: unknown } | MessageEvent) => void) | null = null;
let previousOnMessage:
  ((event: { data?: unknown } | MessageEvent) => void) | null = null;
const eventListeners = new Set<BridgeEventListener>();

let cachedCapabilities: AndroidSpeechCapabilities | null = null;
let cachedCapabilitiesAt = 0;
let cachedCapabilitiesPort: ViReadNativeSpeechPort | null = null;
let inflightCapabilitiesPromise: Promise<AndroidSpeechCapabilities | null> | null =
  null;

function getNativeSpeechPort(): ViReadNativeSpeechPort | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { ViReadNativeSpeech?: unknown })
    .ViReadNativeSpeech;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as ViReadNativeSpeechPort).postMessage === "function"
  ) {
    return candidate as ViReadNativeSpeechPort;
  }
  return null;
}

function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${requestSeq}`;
}

function parseIncomingPayload(
  rawEvent: { data?: unknown } | MessageEvent | string,
): NativeSpeechIncomingEvent | null {
  const raw =
    typeof rawEvent === "string"
      ? rawEvent
      : rawEvent && typeof rawEvent === "object" && "data" in rawEvent
        ? rawEvent.data
        : rawEvent;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.type !== "string" || !rec.type.trim()) return null;
  return rec as unknown as NativeSpeechIncomingEvent;
}

function ensureDispatcherAttached(port: ViReadNativeSpeechPort): void {
  if (attachedPort === port && attachedHandler) return;
  detachDispatcher();

  const handler = (rawEvent: { data?: unknown } | MessageEvent) => {
    const parsed = parseIncomingPayload(rawEvent);
    if (parsed) {
      for (const listener of [...eventListeners]) {
        try {
          listener(parsed);
        } catch {
          // Isolate subscriber errors so one callback never breaks the bridge.
        }
      }
    }
    if (previousOnMessage && previousOnMessage !== handler) {
      try {
        previousOnMessage(rawEvent);
      } catch {
        // Ignore chained listener failures.
      }
    }
  };

  attachedPort = port;
  attachedHandler = handler;

  if (typeof port.addEventListener === "function") {
    port.addEventListener("message", handler);
  } else {
    previousOnMessage =
      typeof port.onmessage === "function" ? port.onmessage : null;
    port.onmessage = handler;
  }
}

function detachDispatcher(): void {
  if (!attachedPort || !attachedHandler) {
    attachedPort = null;
    attachedHandler = null;
    previousOnMessage = null;
    return;
  }
  try {
    if (typeof attachedPort.removeEventListener === "function") {
      attachedPort.removeEventListener("message", attachedHandler);
    } else if (attachedPort.onmessage === attachedHandler) {
      attachedPort.onmessage = previousOnMessage;
    }
  } catch {
    // Ignore teardown errors on mocked/closed ports.
  }
  attachedPort = null;
  attachedHandler = null;
  previousOnMessage = null;
}

function subscribeBridgeEvents(listener: BridgeEventListener): () => void {
  const port = getNativeSpeechPort();
  if (port) {
    ensureDispatcherAttached(port);
  }
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

function sendBridgeCommand(
  payload: Record<string, unknown>,
): { ok: true; port: ViReadNativeSpeechPort } | { ok: false } {
  const port = getNativeSpeechPort();
  if (!port) return { ok: false };
  ensureDispatcherAttached(port);
  try {
    port.postMessage(JSON.stringify(payload));
    return { ok: true, port };
  } catch {
    return { ok: false };
  }
}

function clampNativeTtsRate(rate: number | undefined): number {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return 1.0;
  return Math.max(0.6, Math.min(1.4, Number(rate.toFixed(2))));
}

function clampNativeTtsPitch(pitch: number | undefined): number {
  if (typeof pitch !== "number" || !Number.isFinite(pitch)) return 1.0;
  return Math.max(0.5, Math.min(2.0, Number(pitch.toFixed(2))));
}

/**
 * Converts Android `System.currentTimeMillis()` timestamps into the same
 * monotonic `performance.now()` clock used by `EchoGuard`.
 */
export function normalizeNativeTimestampToPerfNow(
  rawTimestamp: number | null | undefined,
): number | null {
  if (typeof rawTimestamp !== "number" || !Number.isFinite(rawTimestamp)) {
    return null;
  }
  const perfNow =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  // Epoch milliseconds (>= year 2001) -> translate relative to Date.now().
  if (rawTimestamp >= 1_000_000_000_000) {
    const ageMs = Date.now() - rawTimestamp;
    const clampedAgeMs = Math.max(-500, Math.min(30_000, ageMs));
    return Math.max(0, perfNow - clampedAgeMs);
  }
  return rawTimestamp;
}

function mapAndroidSttErrorCode(rawCode: string | undefined): string {
  const code = (rawCode ?? "").trim().toLowerCase();
  if (!code) return "stt-unavailable";
  switch (code) {
    case "permission_denied":
    case "insufficient_permissions":
    case "not-allowed":
      return "not-allowed";
    case "audio":
    case "audio_error":
    case "audio-capture":
      return "audio-capture";
    case "network":
    case "network_timeout":
    case "server":
      return "network";
    case "no_match":
    case "speech_timeout":
    case "no-speech":
      return "no-speech";
    case "recognizer_busy":
    case "busy":
    case "cancelled":
    case "aborted":
      return "aborted";
    case "language_not_supported":
    case "language_unavailable":
    case "language-not-supported":
    case "language-unavailable":
      return "language-not-supported";
    case "service-not-allowed":
    case "service_not_allowed":
      return "service-not-allowed";
    default:
      return "stt-unavailable";
  }
}

export function isAndroidNativeSpeechAvailable(): boolean {
  return getNativeSpeechPort() !== null;
}

function isCachedCapabilitiesFresh(): boolean {
  if (!cachedCapabilities) return false;
  if (cachedCapabilities.ttsAvailable && cachedCapabilities.sttAvailable) {
    return true;
  }
  return (
    cachedCapabilitiesAt > 0 &&
    Date.now() - cachedCapabilitiesAt < DEGRADED_CAPABILITIES_TTL_MS
  );
}

export function getCachedAndroidSpeechCapabilities(): AndroidSpeechCapabilities | null {
  const port = getNativeSpeechPort();
  if (!port || cachedCapabilitiesPort !== port) return null;
  if (!isCachedCapabilitiesFresh()) return null;
  return cachedCapabilities;
}

export async function getAndroidSpeechCapabilities(options?: {
  readonly forceRefresh?: boolean;
  readonly timeoutMs?: number;
}): Promise<AndroidSpeechCapabilities | null> {
  const port = getNativeSpeechPort();
  if (!port) return null;

  if (
    !options?.forceRefresh &&
    cachedCapabilities &&
    cachedCapabilitiesPort === port &&
    isCachedCapabilitiesFresh()
  ) {
    return cachedCapabilities;
  }

  if (
    !options?.forceRefresh &&
    inflightCapabilitiesPromise &&
    cachedCapabilitiesPort === port
  ) {
    return inflightCapabilitiesPromise;
  }

  cachedCapabilitiesPort = port;
  const requestId = nextRequestId("cap");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CAPABILITIES_TIMEOUT_MS;

  const promise = new Promise<AndroidSpeechCapabilities | null>((resolve) => {
    let settled = false;
    const finish = (caps: AndroidSpeechCapabilities | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      if (inflightCapabilitiesPromise === promise) {
        inflightCapabilitiesPromise = null;
      }
      if (caps && getNativeSpeechPort() === port) {
        cachedCapabilities = caps;
        cachedCapabilitiesAt = Date.now();
        cachedCapabilitiesPort = port;
      }
      resolve(caps);
    };

    const unsubscribe = subscribeBridgeEvents((event) => {
      if (event.type !== "capabilities") return;
      if (event.requestId && event.requestId !== requestId) return;
      finish({
        ttsAvailable: Boolean(event.ttsAvailable),
        viVoicesCount:
          typeof event.viVoicesCount === "number" &&
          Number.isFinite(event.viVoicesCount)
            ? Math.max(0, Math.floor(event.viVoicesCount))
            : 0,
        ...(typeof event.hasMaleViVoice === "boolean"
          ? { hasMaleViVoice: event.hasMaleViVoice }
          : {}),
        ...(typeof event.hasFemaleViVoice === "boolean"
          ? { hasFemaleViVoice: event.hasFemaleViVoice }
          : {}),
        sttAvailable: Boolean(event.sttAvailable),
        onDeviceSttAvailable: Boolean(event.onDeviceSttAvailable),
        platform:
          typeof event.platform === "string" && event.platform.trim()
            ? event.platform
            : "android-webview",
      });
    });

    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const sent = sendBridgeCommand({
      action: "getCapabilities",
      requestId,
    });
    if (!sent.ok) {
      finish(null);
    }
  });

  inflightCapabilitiesPromise = promise;
  return promise;
}

export function stopAndroidNativeTts(): void {
  const requestId = nextRequestId("tts_stop");
  sendBridgeCommand({
    action: "stopSpeak",
    requestId,
  });
}

export async function openAndroidTtsInstallSettings(
  timeoutMs = DEFAULT_SETTINGS_TIMEOUT_MS,
): Promise<boolean> {
  if (!isAndroidNativeSpeechAvailable()) return false;
  const requestId = nextRequestId("tts_install");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(opened);
    };
    const unsubscribe = subscribeBridgeEvents((event) => {
      if (event.requestId && event.requestId !== requestId) return;
      if (event.type === "tts_settings_opened") {
        finish(true);
      } else if (event.type === "tts_settings_unavailable") {
        finish(false);
      }
    });
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    const sent = sendBridgeCommand({
      action: "openTtsInstallSettings",
      requestId,
    });
    if (!sent.ok) {
      finish(false);
    }
  });
}

export async function speakWithAndroidNativeTts(
  text: string,
  opts: AndroidNativeTtsSpeakOptions = {},
): Promise<number> {
  if (!isAndroidNativeSpeechAvailable()) {
    throw new Error("Android native speech bridge is not available.");
  }
  const normalized = text.normalize("NFC").trim().slice(0, MAX_TTS_TEXT_CHARS);
  if (!normalized) {
    throw new Error("TTS text must not be empty.");
  }
  if (opts.signal?.aborted) {
    throw new DOMException("Audio playback was stopped.", "AbortError");
  }

  const requestId = nextRequestId("tts");
  const rate = clampNativeTtsRate(opts.rate);
  const pitch = clampNativeTtsPitch(opts.pitch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let startedEmitted = false;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      if (error) {
        reject(error);
      } else {
        const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
        opts.onDone?.();
        resolve(elapsedSec);
      }
    };

    const emitStart = (meta?: {
      readonly voiceGenderMismatch?: boolean;
      readonly resolvedVoiceName?: string | null;
      readonly actualVoiceGender?: string | null;
    }) => {
      if (startedEmitted) return;
      startedEmitted = true;
      opts.onStart?.(meta);
    };

    const onAbort = () => {
      stopAndroidNativeTts();
      finish(new DOMException("Audio playback was stopped.", "AbortError"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const unsubscribe = subscribeBridgeEvents((event) => {
      if (event.requestId && event.requestId !== requestId) return;
      switch (event.type) {
        case "tts_start":
          emitStart({
            voiceGenderMismatch: Boolean(event.voiceGenderMismatch),
            resolvedVoiceName:
              typeof event.resolvedVoiceName === "string"
                ? event.resolvedVoiceName
                : null,
            actualVoiceGender:
              typeof event.actualVoiceGender === "string"
                ? event.actualVoiceGender
                : null,
          });
          break;
        case "tts_range":
          emitStart();
          if (typeof event.start === "number") {
            const end = typeof event.end === "number" ? event.end : event.start;
            opts.onRangeStart?.(event.start, end);
          }
          break;
        case "tts_done":
          emitStart();
          finish();
          break;
        case "tts_stopped":
          finish(new DOMException("Audio playback was stopped.", "AbortError"));
          break;
        case "tts_error":
          finish(
            new Error(
              event.message ||
                event.code ||
                "Android native TTS playback failed.",
            ),
          );
          break;
        default:
          break;
      }
    });

    const timer = window.setTimeout(() => {
      stopAndroidNativeTts();
      finish(new Error("Android native TTS timed out."));
    }, timeoutMs);

    const sent = sendBridgeCommand({
      action: "speak",
      requestId,
      text: normalized,
      rate,
      pitch,
      ...(opts.voiceGender ? { voiceGender: opts.voiceGender } : {}),
      ...(opts.voiceId ? { voiceId: opts.voiceId } : {}),
    });
    if (!sent.ok) {
      finish(new Error("Failed to dispatch Android native TTS command."));
    }
  });
}

/**
 * Browser `SpeechRecognition`-compatible wrapper backed by Android native
 * `SpeechRecognizer` over `window.ViReadNativeSpeech`.
 *
 * Exposes `onsetAt` (normalized to `performance.now()` clock for `EchoGuard`)
 * and `rmsDb` for live voice activity feedback.
 */
export class AndroidNativeSpeechRecognition implements SegmentSpeechRecognitionLike {
  continuous = true;
  interimResults = true;
  lang = "vi-VN";
  maxAlternatives = 3;
  preferOnDevice = true;

  onresult: ((event: SegmentSpeechEvent) => void) | null = null;
  onerror: ((event: SegmentSpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onready: (() => void) | null = null;
  onrms: ((rmsDb: number) => void) | null = null;
  ononset: ((onsetAt: number) => void) | null = null;

  onsetAt: number | null = null;
  rmsDb: number | null = null;

  private active = false;
  private stopping = false;
  private activeRequestId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private resultsHistory: SegmentSpeechResultItem[] = [];
  private currentCycleOnsetAt: number | null = null;
  private epoch = 0;

  start(): void {
    if (this.active) return;
    if (!isAndroidNativeSpeechAvailable()) {
      queueMicrotask(() => {
        this.onerror?.({ error: "stt-unavailable" });
        this.onend?.();
      });
      return;
    }

    this.epoch += 1;
    this.active = true;
    this.stopping = false;
    this.resultsHistory = [];
    this.onsetAt = null;
    this.rmsDb = null;
    this.currentCycleOnsetAt = null;

    const requestId = nextRequestId("stt");
    this.activeRequestId = requestId;

    this.unsubscribe?.();
    this.unsubscribe = subscribeBridgeEvents((event) => {
      if (!this.active || this.activeRequestId !== requestId) return;
      if (event.requestId && event.requestId !== requestId) return;

      switch (event.type) {
        case "stt_ready":
          this.currentCycleOnsetAt = null;
          this.onready?.();
          break;
        case "stt_onset": {
          const normalized =
            normalizeNativeTimestampToPerfNow(event.onsetAt) ??
            (typeof performance !== "undefined"
              ? performance.now()
              : Date.now());
          this.onsetAt = normalized;
          this.currentCycleOnsetAt = normalized;
          this.ononset?.(normalized);
          break;
        }
        case "stt_rms":
          if (typeof event.rmsDb === "number" && Number.isFinite(event.rmsDb)) {
            this.rmsDb = event.rmsDb;
            this.onrms?.(event.rmsDb);
          }
          break;
        case "stt_partial": {
          if (!this.interimResults) break;
          const transcript = (event.transcript ?? "").normalize("NFC").trim();
          if (!transcript) break;
          const onset =
            normalizeNativeTimestampToPerfNow(event.onsetAt) ??
            this.currentCycleOnsetAt ??
            this.onsetAt;
          if (onset !== null && this.currentCycleOnsetAt === null) {
            this.onsetAt = onset;
            this.currentCycleOnsetAt = onset;
          }
          const resultIndex = this.resultsHistory.length;
          const interimItem: SegmentSpeechResultItem = {
            isFinal: false,
            length: 1,
            0: { transcript, confidence: 0 },
            epoch: this.epoch,
            onsetAt: onset,
            audioEndedAt:
              typeof performance !== "undefined"
                ? performance.now()
                : Date.now(),
          };
          const resultsObj: Record<number, SegmentSpeechResultItem> & {
            length: number;
          } = { length: this.resultsHistory.length + 1 };
          for (let i = 0; i < this.resultsHistory.length; i += 1) {
            resultsObj[i] = this.resultsHistory[i];
          }
          resultsObj[resultIndex] = interimItem;
          this.onresult?.({ resultIndex, results: resultsObj });
          break;
        }
        case "stt_final": {
          const transcript = (event.transcript ?? "").normalize("NFC").trim();
          const finalOnset =
            normalizeNativeTimestampToPerfNow(event.onsetAt) ??
            this.currentCycleOnsetAt ??
            this.onsetAt;
          if (finalOnset !== null) {
            this.onsetAt = finalOnset;
          }
          if (!transcript) break;
          const rawAlts = Array.isArray(event.alternatives)
            ? event.alternatives
                .map((a) =>
                  typeof a === "string" ? a.normalize("NFC").trim() : "",
                )
                .filter(Boolean)
            : [];
          const uniqueAlts = [
            transcript,
            ...rawAlts.filter((a) => a !== transcript),
          ].slice(0, Math.max(1, this.maxAlternatives));
          const itemBase: Record<
            number,
            { transcript: string; confidence: number }
          > = {};
          uniqueAlts.forEach((alt, idx) => {
            itemBase[idx] = {
              transcript: alt,
              confidence: idx === 0 ? 0.9 : 0.7,
            };
          });
          const finalItem: SegmentSpeechResultItem = {
            ...itemBase,
            isFinal: true,
            length: uniqueAlts.length,
            0: itemBase[0],
            epoch: this.epoch,
            onsetAt: finalOnset,
            audioEndedAt:
              typeof performance !== "undefined"
                ? performance.now()
                : Date.now(),
          };
          const resultIndex = this.resultsHistory.length;
          this.resultsHistory.push(finalItem);
          const resultsObj: Record<number, SegmentSpeechResultItem> & {
            length: number;
          } = { length: this.resultsHistory.length };
          for (let i = 0; i < this.resultsHistory.length; i += 1) {
            resultsObj[i] = this.resultsHistory[i];
          }
          this.onresult?.({ resultIndex, results: resultsObj });
          break;
        }
        case "stt_error": {
          const mapped = mapAndroidSttErrorCode(event.code);
          this.teardownInternal();
          this.onerror?.({ error: mapped });
          this.onend?.();
          break;
        }
        case "stt_end": {
          this.teardownInternal();
          this.onend?.();
          break;
        }
        default:
          break;
      }
    });

    recordSttEngineUsage({
      provider: "android_native",
      fallbackUsed: true,
      fallbackReason: "ANDROID_NATIVE_STT",
    });

    const sent = sendBridgeCommand({
      action: "startStt",
      requestId,
      lang: this.lang || "vi-VN",
      partialResults: Boolean(this.interimResults),
      maxResults: Math.max(1, Math.min(5, this.maxAlternatives || 3)),
      preferOnDevice: Boolean(this.preferOnDevice),
    });
    if (!sent.ok) {
      this.teardownInternal();
      this.onerror?.({ error: "stt-unavailable" });
      this.onend?.();
    }
  }

  stop(): void {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    const requestId = this.activeRequestId ?? nextRequestId("stt_stop");
    const sent = sendBridgeCommand({
      action: "stopStt",
      requestId,
    });
    if (!sent.ok) {
      this.teardownInternal();
      this.onend?.();
    }
  }

  abort(): void {
    if (!this.active) return;
    const requestId = this.activeRequestId ?? nextRequestId("stt_cancel");
    this.teardownInternal();
    sendBridgeCommand({
      action: "cancelStt",
      requestId,
    });
    this.onend?.();
  }

  private teardownInternal(): void {
    this.active = false;
    this.stopping = false;
    this.activeRequestId = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

export function resetAndroidNativeSpeechBridgeForTests(): void {
  detachDispatcher();
  eventListeners.clear();
  cachedCapabilities = null;
  cachedCapabilitiesAt = 0;
  cachedCapabilitiesPort = null;
  inflightCapabilitiesPromise = null;
  requestSeq = 0;
}
