/**
 * Eager STT + TTS Preloader for ViRead (Web, Mobile Web, and Android WebView APK).
 *
 * Starts warming voice engines the moment the user taps "Chuẩn bị đọc" / enters
 * Reading Preparation, Reading Screen, or Difficult Words Practice — so STT
 * (especially 33.92 MB Browser WASM Sherpa-ONNX) and TTS (Backend / Android Native /
 * Browser SpeechSynthesis voices) are ALREADY initialized before the child speaks
 * the first word!
 */

import { getBrowserAccessToken } from "@/lib/api/browser-auth";
import { createSpeechService } from "@/lib/api/speech-service";
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
  getWasmModelCacheStatus,
  type WasmSttProgressEvent,
} from "@/lib/reading/browser-wasm-stt";
import {
  getAndroidSpeechCapabilities,
  isAndroidNativeSpeechAvailable,
} from "@/lib/reading/native-speech-bridge";
import {
  getEffectiveVoiceId,
  getVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { getSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  fetchVoiceEngineHealth,
  getFreshVoiceEngineHealth,
  isHostedLocalVoiceUnconfigured,
} from "@/lib/reading/voice-engine-status";

export type VoiceEnginePreloadStatus =
  "idle" | "loading" | "ready" | "degraded";

export interface VoicePreloadState {
  readonly sttStatus: VoiceEnginePreloadStatus;
  readonly ttsStatus: VoiceEnginePreloadStatus;
  readonly sttEngineLabel: string | null;
  readonly sttProgressStage: string | null;
  readonly startedAt: number | null;
  readonly readyAt: number | null;
}

export interface PreloadReadingVoiceOptions {
  readonly bookId?: string | null;
  readonly pageId?: string | null;
  readonly pageRevisionId?: string | null;
  readonly isPrivateBook?: boolean;
  readonly previewWords?: readonly string[];
  readonly warmWasmStt?: boolean;
  readonly warmTts?: boolean;
}

const INITIAL_STATE: VoicePreloadState = {
  sttStatus: "idle",
  ttsStatus: "idle",
  sttEngineLabel: null,
  sttProgressStage: null,
  startedAt: null,
  readyAt: null,
};

const listeners = new Set<() => void>();
let state: VoicePreloadState = INITIAL_STATE;
let activePreloadPromise: Promise<void> | null = null;
let wasmInitPromise: Promise<boolean> | null = null;
let wasmProgressUnsub: (() => void) | null = null;
const prefetchedTtsKeys = new Set<string>();

function updateState(patch: Partial<VoicePreloadState>): void {
  const next: VoicePreloadState = { ...state, ...patch };
  if (
    next.sttStatus === state.sttStatus &&
    next.ttsStatus === state.ttsStatus &&
    next.sttEngineLabel === state.sttEngineLabel &&
    next.sttProgressStage === state.sttProgressStage &&
    next.startedAt === state.startedAt &&
    next.readyAt === state.readyAt
  ) {
    return;
  }
  state = next;
  listeners.forEach((fn) => fn());
}

export function getVoicePreloadState(): VoicePreloadState {
  return state;
}

export function subscribeVoicePreloadState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function warmBrowserSpeechVoices(): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof window.speechSynthesis?.getVoices !== "function"
  ) {
    return Promise.resolve(false);
  }
  try {
    const existing = window.speechSynthesis.getVoices() ?? [];
    if (existing.length > 0) {
      return Promise.resolve(true);
    }
    if (typeof window.speechSynthesis.addEventListener !== "function") {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try {
          window.speechSynthesis.removeEventListener?.(
            "voiceschanged",
            onVoicesChanged,
          );
        } catch {
          // Ignore cleanup errors
        }
        try {
          resolve((window.speechSynthesis.getVoices?.() ?? []).length > 0);
        } catch {
          resolve(false);
        }
      };
      const onVoicesChanged = () => done();
      try {
        window.speechSynthesis.addEventListener(
          "voiceschanged",
          onVoicesChanged,
        );
      } catch {
        done();
        return;
      }
      const timer = window.setTimeout(done, 800);
    });
  } catch {
    return Promise.resolve(false);
  }
}

function startWasmSttWarmup(): Promise<boolean> {
  const wasmClient = getBrowserWasmSttClient();
  if (wasmClient.isReady()) {
    updateState({
      sttStatus: "ready",
      sttEngineLabel: "Offline (WASM)",
      sttProgressStage: "ready",
    });
    return Promise.resolve(true);
  }
  if (wasmInitPromise) {
    return wasmInitPromise;
  }
  updateState({
    sttStatus: "loading",
    sttEngineLabel: "Offline (WASM)",
    sttProgressStage: "loading",
  });
  wasmProgressUnsub?.();
  wasmProgressUnsub = wasmClient.subscribeProgress(
    (evt: WasmSttProgressEvent) => {
      updateState({
        sttStatus: evt.stage === "ready" ? "ready" : "loading",
        sttEngineLabel: "Offline (WASM)",
        sttProgressStage: evt.stage,
      });
    },
  );
  wasmInitPromise = wasmClient
    .init()
    .then(() => {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: "Offline (WASM)",
        sttProgressStage: "ready",
      });
      return true;
    })
    .catch(() => {
      updateState({
        sttStatus: "degraded",
        sttProgressStage: "error",
      });
      return false;
    })
    .finally(() => {
      wasmProgressUnsub?.();
      wasmProgressUnsub = null;
      if (!wasmClient.isReady()) {
        wasmInitPromise = null;
      }
    });
  return wasmInitPromise;
}

async function warmInitialTtsCues(
  options: PreloadReadingVoiceOptions,
): Promise<void> {
  if (options.warmTts === false) return;
  const voiceId = getEffectiveVoiceId();
  const speed = getSpeechPreferences().speed;
  const speechService = createSpeechService();
  const cues: Array<{ text: string; wordSample: boolean }> = [
    { text: "Đến lượt con đọc nhé.", wordSample: false },
  ];
  const sampleWords = (options.previewWords ?? [])
    .map((w) => w.normalize("NFC").trim())
    .filter(Boolean)
    .slice(0, 3);
  for (const word of sampleWords) {
    cues.push({ text: word, wordSample: true });
  }
  for (const cue of cues) {
    const key = `${voiceId}::${speed}::${cue.wordSample ? "w" : "c"}::${cue.text}`;
    if (prefetchedTtsKeys.has(key)) continue;
    prefetchedTtsKeys.add(key);
    try {
      await speechService.synthesize(cue.text, {
        voiceId,
        speed,
        wordSample: cue.wordSample,
        bookId: cue.wordSample ? (options.bookId ?? null) : null,
        pageId: cue.wordSample ? (options.pageId ?? null) : null,
        pageRevisionId: cue.wordSample
          ? (options.pageRevisionId ?? null)
          : null,
        isPrivateBook: cue.wordSample ? options.isPrivateBook : false,
        cacheScope: cue.wordSample
          ? options.isPrivateBook
            ? "PRIVATE"
            : "CATALOG"
          : "COACHING",
        bypassSessionLock: true,
        timeoutMs: 8_000,
      });
    } catch {
      // Best-effort preload only; never block reading flow.
      prefetchedTtsKeys.delete(key);
      break;
    }
  }
}

/**
 * Idempotently preloads STT & TTS engines in parallel across Web, Mobile Web,
 * and Android WebView APK. Safe to call repeatedly on click ("Chuẩn bị đọc"),
 * on preparation mount, and on reading/practice screen mount.
 */
export function preloadReadingVoiceEngines(
  options: PreloadReadingVoiceOptions = {},
): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  const now = Date.now();
  if (state.startedAt === null) {
    updateState({
      startedAt: now,
      sttStatus: state.sttStatus === "ready" ? "ready" : "loading",
      ttsStatus: state.ttsStatus === "ready" ? "ready" : "loading",
    });
  }

  // If already preloading, still trigger best-effort TTS word cue warmup if new preview words arrived
  if (activePreloadPromise) {
    if (options.previewWords?.length && options.warmTts !== false) {
      const freshHealth = getFreshVoiceEngineHealth();
      if (freshHealth && !isHostedLocalVoiceUnconfigured(freshHealth)) {
        void warmInitialTtsCues(options);
      }
    }
    return activePreloadPromise;
  }

  const run = async (): Promise<void> => {
    const isAndroid = isAndroidNativeSpeechAvailable();
    const wasmSupported =
      !isAndroid &&
      options.warmWasmStt !== false &&
      detectBrowserWasmSttSupport().supported;

    // Kick off independent warmups in parallel immediately:
    // 1. Auth token cache
    // 2. Backend /voice/status health (wakes Render Free backend early!)
    // 3. Android native capabilities (warms Android TextToSpeech + SpeechRecognizer)
    // 4. Browser SpeechSynthesis voice list population
    // 5. IndexedDB WASM cache check (if already cached, boot WASM worker immediately!)
    const tokenPromise = getBrowserAccessToken({
      onUnauthorized: () => new Error("unauthorized"),
    }).catch(() => null);
    const healthPromise = fetchVoiceEngineHealth().catch(() => null);
    const androidCapsPromise = isAndroid
      ? getAndroidSpeechCapabilities().catch(() => null)
      : Promise.resolve(null);
    const browserVoicesPromise = !isAndroid
      ? warmBrowserSpeechVoices()
      : Promise.resolve(false);

    let earlyWasmStarted = false;
    if (wasmSupported) {
      void getWasmModelCacheStatus()
        .then((cacheStatus) => {
          if (cacheStatus.ready && !earlyWasmStarted) {
            const currentHealth = getFreshVoiceEngineHealth();
            if (!currentHealth || !currentHealth.local.stt_ready) {
              earlyWasmStarted = true;
              void startWasmSttWarmup();
            }
          }
        })
        .catch(() => undefined);
    }

    const [, health, androidCaps] = await Promise.all([
      tokenPromise,
      healthPromise,
      androidCapsPromise,
      browserVoicesPromise,
    ]);

    const policy = getVoicePolicyPreferences();
    const localSttReady = Boolean(
      health?.local.available && health.local.stt_ready,
    );
    const localTtsReady = Boolean(
      health?.local.available && health.local.tts_ready,
    );
    const hostedUnconfigured = health
      ? isHostedLocalVoiceUnconfigured(health)
      : true;
    const sttAllowsCloud =
      policy.providerMode === "local_with_google_fallback" &&
      policy.allowGoogleSttFallback;
    const googleSttReady = Boolean(
      sttAllowsCloud &&
      health?.google.stt_configured &&
      !health.google.stt_cooldown,
    );

    // 1. STT Readiness
    if (localSttReady) {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: "Offline",
        sttProgressStage: "ready",
      });
    } else if (isAndroid && (androidCaps?.sttAvailable ?? true)) {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: "Android Native",
        sttProgressStage: "ready",
      });
    } else if (wasmSupported && (!googleSttReady || hostedUnconfigured)) {
      earlyWasmStarted = true;
      await startWasmSttWarmup();
    } else {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: googleSttReady ? "Google STT" : "Trình duyệt",
        sttProgressStage: "ready",
      });
    }

    // 2. TTS Readiness
    const hasLiveServerTts = Boolean(
      localTtsReady ||
      health?.elevenlabs?.tts_configured ||
      (policy.providerMode === "local_with_google_fallback" &&
        policy.allowGoogleTtsFallback &&
        health?.google.tts_configured &&
        !health.google.tts_cooldown),
    );
    if (hasLiveServerTts) {
      void warmInitialTtsCues(options);
      updateState({ ttsStatus: "ready", readyAt: Date.now() });
    } else {
      // Hosted on-device TTS (Android Native or Browser SpeechSynthesis):
      // already warmed via getAndroidSpeechCapabilities() / warmBrowserSpeechVoices().
      updateState({ ttsStatus: "ready", readyAt: Date.now() });
    }
  };

  activePreloadPromise = run().finally(() => {
    activePreloadPromise = null;
  });
  return activePreloadPromise;
}

/**
 * Called right before opening the microphone in ReadingScreen / PracticePanel:
 * if Browser WASM STT is the selected engine and is still finishing its preload,
 * waits briefly (bounded by `maxWaitMs`) so the child's first spoken words are
 * NEVER dropped during WASM initialization.
 */
export async function awaitSttReadyBeforeListening(
  maxWaitMs = 5_000,
): Promise<boolean> {
  if (typeof window === "undefined") return true;
  if (isAndroidNativeSpeechAvailable()) {
    await getAndroidSpeechCapabilities().catch(() => null);
    return true;
  }
  const health = getFreshVoiceEngineHealth();
  if (health?.local.available && health.local.stt_ready) {
    return true;
  }
  if (!detectBrowserWasmSttSupport().supported) {
    return true;
  }
  const wasmClient = getBrowserWasmSttClient();
  if (wasmClient.isReady()) {
    return true;
  }
  const pending = wasmInitPromise ?? startWasmSttWarmup();
  if (maxWaitMs <= 0) return wasmClient.isReady();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(
      () => finish(wasmClient.isReady()),
      maxWaitMs,
    );
    pending.then(
      (ok) => finish(ok),
      () => finish(false),
    );
  });
}

export function resetVoicePreloaderForTests(): void {
  state = INITIAL_STATE;
  activePreloadPromise = null;
  wasmInitPromise = null;
  wasmProgressUnsub?.();
  wasmProgressUnsub = null;
  prefetchedTtsKeys.clear();
}
