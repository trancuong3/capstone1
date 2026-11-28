/**
 * Core state machine and fast isolated short-word evaluation helpers shared by:
 * - In-book reading retry flow (`ReadingScreen`)
 * - Difficult-words hands-free voice practice (`DifficultWordPracticePanel`)
 *
 * Guarantees:
 * - Capture stops after a short quiet tail to keep the final consonant.
 * - Acoustic VAD onset works even when browser Web Speech API fails on 1-syllable Vietnamese words.
 * - Never fabricates "CORRECT" from keyterm hints without high confidence or browser corroboration.
 */

import {
  hasShortWordBlockingAudioIssue,
  type AudioQualitySnapshot,
  type AudioQualityStatus,
} from "@/lib/reading/audio-quality";
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
} from "@/lib/reading/browser-wasm-stt";
import {
  getFreshVoiceEngineHealth,
  isPermanentlyHostedLocalUnconfigured,
  markHostedLocalUnconfigured,
  recordSttEngineUsage,
} from "@/lib/reading/voice-engine-status";
import {
  hasHighConfidenceKeytermResult,
  hasUsableBrowserConfidence,
  hasUsableTranscript,
} from "@/lib/reading/recognition-evidence";
import {
  buildContrastiveKeyterms,
  classifyPracticePhraseTranscript,
  stripNonSpeechAnnotations,
  type RetryRecognitionStatus,
} from "@/lib/reading/retry-word-recognition";
import type { SpeechService } from "@/lib/api/speech-service";

export const SHORT_WORD_CONTEXT_RETRY_THRESHOLD = 1;

export type WordPracticeState =
  | "IDLE"
  | "PREPARING"
  | "INSTRUCTING"
  | "LISTENING"
  | "EVALUATING"
  | "SAVING"
  | "SUCCESS"
  | "NEEDS_RETRY"
  | "TECHNICAL_ERROR"
  | "PAUSED";

export const SHORT_WORD_CAPTURE_CONFIG = {
  mode: "short-word" as const,
  pollIntervalMs: 120,
  acousticSettleMs: 140,
  minCaptureMs: 800,
  postSpeechSilenceMs: 950,
  noSpeechTimeoutMs: 4500,
  maxCaptureMs: 6500,
  softSpeechRmsThreshold: 0.015,
  maxAutoRetries: 2,
  maxSilenceStreak: 2,
  autoAdvanceCorrectMs: 1100,
  autoRetryPauseMs: 900,
} as const;

export const PHRASE_CAPTURE_CONFIG = {
  ...SHORT_WORD_CAPTURE_CONFIG,
  minCaptureMs: 1400,
  postSpeechSilenceMs: 1200,
  maxCaptureMs: 11_000,
};

export type ShortWordFailureLabel =
  "Chưa nghe thấy" | "Nghe chưa rõ" | "Đọc sai";

/** Distinguish missing/silent audio, unclear/noisy audio, and wrong pronunciation. */
export function classifyShortWordFailureLabel(
  status: string | null | undefined,
  audioQualityStatus: AudioQualityStatus | string | null | undefined,
  transcript: string | null | undefined,
): ShortWordFailureLabel | null {
  if (status === "INCORRECT") return "Đọc sai";
  if (status === "UNCERTAIN") return "Nghe chưa rõ";
  if (status === "NO_CLEAR_AUDIO" || status === "NOT_RECOGNIZED") {
    const hasSpokenText = Boolean(
      typeof transcript === "string" &&
      stripNonSpeechAnnotations(transcript).trim(),
    );
    if (
      hasSpokenText ||
      audioQualityStatus === "LOW_VOLUME" ||
      audioQualityStatus === "AUDIO_TOO_SHORT" ||
      audioQualityStatus === "BACKGROUND_NOISE" ||
      audioQualityStatus === "INVALID_AUDIO"
    ) {
      return "Nghe chưa rõ";
    }
    return "Chưa nghe thấy";
  }
  return null;
}

export const VOICE_PROMPTS = {
  introWord: (word: string) => `Bé hãy đọc từ ${word} nhé.`,
  correctPraise: () => "Chính xác rồi! Con giỏi lắm!",
  retryGentle: (word: string) =>
    `Mình chưa nghe rõ. Con đọc lại từ ${word} một lần nhé!`,
  incorrectGentle: (word: string) => `Con nghe lại rồi đọc theo nhé: ${word}.`,
  technicalFallback: () => "Máy đang bận một chút, con thử lại nhé!",
} as const;

export interface ShortWordAutoStopInput {
  readonly elapsedMs: number;
  readonly speechObserved: boolean;
  readonly silenceElapsedMs: number;
  readonly config?: {
    readonly minCaptureMs: number;
    readonly postSpeechSilenceMs: number;
    readonly noSpeechTimeoutMs: number;
    readonly maxCaptureMs: number;
  };
}

export function shouldAutoStopShortWordCapture({
  elapsedMs,
  speechObserved,
  silenceElapsedMs,
  config = SHORT_WORD_CAPTURE_CONFIG,
}: ShortWordAutoStopInput): boolean {
  if (elapsedMs >= config.maxCaptureMs) return true;
  if (!speechObserved && elapsedMs >= config.noSpeechTimeoutMs) return true;
  if (
    speechObserved &&
    elapsedMs >= config.minCaptureMs &&
    silenceElapsedMs >= config.postSpeechSilenceMs
  ) {
    return true;
  }
  return false;
}

export interface ShortWordSpeechActivityInput {
  readonly isSpeakingNow: boolean;
  readonly audioLevel: number;
  readonly quality?: AudioQualitySnapshot;
  readonly hasLiveBrowserSpeech: boolean;
  readonly speechObserved?: boolean;
  readonly previousSpeechDurationMs?: number;
  readonly consecutiveEnergyPolls?: number;
}

export function hasShortWordSpeechActivity(
  input: ShortWordSpeechActivityInput,
): boolean {
  const liveRms = input.quality
    ? input.quality.rms
    : input.audioLevel > 1
      ? input.audioLevel / 500
      : input.audioLevel;
  const speechDurationMs = input.quality?.speechDurationMs ?? 0;
  const noiseFloor = input.quality?.noiseFloor ?? 0;
  const initialBurstOnset = !input.speechObserved && speechDurationMs >= 40;
  const speechDurationGrew =
    input.previousSpeechDurationMs !== undefined &&
    speechDurationMs > input.previousSpeechDurationMs;
  const hasRelativeEnergy =
    liveRms >= Math.max(0.008, noiseFloor * 1.8) &&
    (Boolean(input.speechObserved) ||
      (input.consecutiveEnergyPolls ?? 0) >= 2 ||
      speechDurationMs >= 40);
  return (
    input.hasLiveBrowserSpeech ||
    input.isSpeakingNow ||
    Boolean(input.quality?.isSpeaking) ||
    initialBurstOnset ||
    speechDurationGrew ||
    hasRelativeEnergy
  );
}

export interface ShortWordKeytermPass2Input {
  readonly status: RetryRecognitionStatus | "ENGINE_ERROR";
  readonly audioQuality?: AudioQualitySnapshot;
  readonly transcript?: string | null;
  readonly browserStatus?: RetryRecognitionStatus | null;
  readonly hasNonSpeechTagOnly?: boolean;
}

export function shouldAttemptShortWordKeytermPass2({
  status,
  audioQuality,
  transcript,
  browserStatus,
  hasNonSpeechTagOnly,
}: ShortWordKeytermPass2Input): boolean {
  const nonSpeechOnly =
    hasNonSpeechTagOnly ??
    Boolean(
      transcript &&
      transcript.trim() &&
      !stripNonSpeechAnnotations(transcript).trim(),
    );
  if (nonSpeechOnly) return false;
  if (status === "INCORRECT" && browserStatus === "CORRECT") {
    return true;
  }
  if (status !== "NOT_RECOGNIZED" && status !== "UNCERTAIN") {
    return false;
  }
  if (audioQuality?.status === "SPEECH_DETECTED") {
    return true;
  }
  if (browserStatus === "CORRECT") {
    return true;
  }
  return status === "UNCERTAIN";
}

export type ShortWordEvaluationSource =
  | "SERVER_STT"
  | "SERVER_STT_KEYTERM"
  | "BROWSER_WASM"
  | "BROWSER_SPEECH"
  | "AUDIO_QUALITY_GATE"
  | "ENGINE_ERROR";

export interface ShortWordEvaluationParams {
  readonly expectedWord: string;
  readonly contextPhrase?: string | null;
  readonly audioBlob: Blob | null;
  readonly audioQuality?: AudioQualitySnapshot;
  readonly browserTranscript?: string | null;
  readonly browserConfidence?: number;
  readonly speechService: Pick<SpeechService, "transcribe">;
  readonly filename?: string;
}

export interface ShortWordEvaluationResult {
  readonly status: RetryRecognitionStatus | "ENGINE_ERROR";
  readonly source: ShortWordEvaluationSource;
  readonly transcript: string | null;
  readonly sttDurationMs: number;
}

/**
 * Evaluate a single isolated Vietnamese word/short phrase recording via:
 * 1) Non-blocking acoustic quality gate
 * 2) Pass 1 Server STT (`languageCode: "vi"`, no keyterms)
 * 3) Pass 2 keyterm corroboration ONLY if needed and backed by logprob >= -0.5 or browser speech
 * 4) Browser transcript fallback ONLY on STT engine failure
 */
export async function evaluateRecordedShortWord({
  expectedWord,
  contextPhrase,
  audioBlob,
  audioQuality,
  browserTranscript,
  browserConfidence,
  speechService,
  filename = "retry-word.webm",
}: ShortWordEvaluationParams): Promise<ShortWordEvaluationResult> {
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const elapsedMs = () =>
    Math.max(
      0,
      Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
          startedAt,
      ),
    );

  const cleanBrowser =
    typeof browserTranscript === "string" && browserTranscript.trim()
      ? browserTranscript.trim()
      : null;
  const usableBrowser = Boolean(
    cleanBrowser && hasUsableBrowserConfidence(browserConfidence),
  );
  const browserStatus: RetryRecognitionStatus | null = usableBrowser
    ? classifyPracticePhraseTranscript(expectedWord, cleanBrowser, {
        contextPhrase,
      })
    : null;

  if (!audioBlob || audioBlob.size === 0) {
    if (usableBrowser && browserStatus !== null) {
      return {
        status: browserStatus,
        source: "BROWSER_SPEECH",
        transcript: cleanBrowser,
        sttDurationMs: elapsedMs(),
      };
    }
    return {
      status: "NOT_RECOGNIZED",
      source: "AUDIO_QUALITY_GATE",
      transcript: null,
      sttDurationMs: elapsedMs(),
    };
  }

  if (hasShortWordBlockingAudioIssue(audioQuality)) {
    return {
      status: "NOT_RECOGNIZED",
      source: "AUDIO_QUALITY_GATE",
      transcript: null,
      sttDurationMs: elapsedMs(),
    };
  }

  const freshHealth = getFreshVoiceEngineHealth();
  const permanentlyUnconfigured =
    isPermanentlyHostedLocalUnconfigured(freshHealth);
  const localSttUnavailable =
    permanentlyUnconfigured ||
    (freshHealth !== null &&
      (!freshHealth.local.available || !freshHealth.local.stt_ready));
  const canUseWasm = detectBrowserWasmSttSupport().supported;
  let triedWasmFirst = false;

  // Strict Offline-First STT priority: when Local Worker STT is known unavailable,
  // try On-Device Offline Browser WASM BEFORE falling back to Cloud backend STT.
  if (localSttUnavailable && canUseWasm) {
    triedWasmFirst = true;
    try {
      const wasmResult = await getBrowserWasmSttClient().transcribeBlob(
        audioBlob,
        {
          timeoutMs: 12_000,
          voicedDurationMs: audioQuality?.speechDurationMs,
        },
      );
      const wasmText = wasmResult.text.normalize("NFC").trim();
      if (wasmText) {
        recordSttEngineUsage({
          provider: "wasm",
          fallbackUsed:
            !permanentlyUnconfigured && freshHealth?.local.configured !== false,
          fallbackReason:
            permanentlyUnconfigured || freshHealth?.local.configured === false
              ? null
              : "LOCAL_STT_UNAVAILABLE",
        });
        const wasmStatus = classifyPracticePhraseTranscript(
          expectedWord,
          wasmText,
          { contextPhrase },
        );
        return {
          status: wasmStatus,
          source: "BROWSER_WASM",
          transcript: wasmText,
          sttDurationMs: elapsedMs(),
        };
      }
    } catch {
      // Fall through cleanly to backend / browser fallback when WASM fails.
    }
  }

  try {
    const firstPass = await speechService.transcribe(audioBlob, {
      filename,
      languageCode: "vi",
    });
    const firstText = firstPass.text.trim();
    const strippedFirst = stripNonSpeechAnnotations(firstText);
    const hasNonSpeechTagOnly = Boolean(firstText && !strippedFirst);

    const firstStatus: RetryRecognitionStatus = hasNonSpeechTagOnly
      ? "NOT_RECOGNIZED"
      : hasUsableTranscript(firstPass)
        ? classifyPracticePhraseTranscript(expectedWord, firstText, {
            contextPhrase,
          })
        : "UNCERTAIN";

    if (firstStatus === "CORRECT") {
      return {
        status: "CORRECT",
        source: "SERVER_STT",
        transcript: firstText || expectedWord,
        sttDurationMs: elapsedMs(),
      };
    }

    const shouldTryKeytermPass =
      !permanentlyUnconfigured &&
      shouldAttemptShortWordKeytermPass2({
        status: firstStatus,
        audioQuality,
        transcript: firstText,
        browserStatus,
        hasNonSpeechTagOnly,
      });

    if (shouldTryKeytermPass) {
      try {
        const secondPass = await speechService.transcribe(audioBlob, {
          filename,
          languageCode: "vi",
          keyterms: buildContrastiveKeyterms(expectedWord, contextPhrase),
        });
        const secondText = secondPass.text.trim();
        const corroborated = browserStatus === "CORRECT";
        const highConf = hasHighConfidenceKeytermResult(
          secondPass,
          expectedWord,
          browserStatus,
        );
        if (hasUsableTranscript(secondPass) && (corroborated || highConf)) {
          return {
            status: classifyPracticePhraseTranscript(expectedWord, secondText, {
              contextPhrase,
            }),
            source: "SERVER_STT_KEYTERM",
            transcript: secondText || firstText || null,
            sttDurationMs: elapsedMs(),
          };
        }
      } catch {
        // Ignore secondary pass failure and preserve primary STT classification.
      }
    }

    if (
      (firstStatus === "UNCERTAIN" || firstStatus === "NOT_RECOGNIZED") &&
      browserStatus === "CORRECT"
    ) {
      return {
        status: "UNCERTAIN",
        source: "SERVER_STT",
        transcript: firstText || cleanBrowser,
        sttDurationMs: elapsedMs(),
      };
    }

    return {
      status: firstStatus,
      source: "SERVER_STT",
      transcript: firstText || null,
      sttDurationMs: elapsedMs(),
    };
  } catch (err) {
    const errText =
      typeof err === "object" && err !== null
        ? `${String((err as { code?: unknown }).code ?? "")} ${String((err as { providerCode?: unknown }).providerCode ?? "")} ${err instanceof Error ? err.message : ""}`
        : "";
    if (errText.includes("LOCAL_VOICE_UNCONFIGURED")) {
      markHostedLocalUnconfigured();
    }
    if (!triedWasmFirst && canUseWasm) {
      try {
        const wasmResult = await getBrowserWasmSttClient().transcribeBlob(
          audioBlob,
          {
            timeoutMs: 12_000,
            voicedDurationMs: audioQuality?.speechDurationMs,
          },
        );
        const wasmText = wasmResult.text.normalize("NFC").trim();
        const wasmStatus = classifyPracticePhraseTranscript(
          expectedWord,
          wasmText,
          { contextPhrase },
        );
        return {
          status: wasmStatus,
          source: "BROWSER_WASM",
          transcript: wasmText || null,
          sttDurationMs: elapsedMs(),
        };
      } catch {
        // Fall through cleanly to browser transcript / ENGINE_ERROR.
      }
    }
    if (usableBrowser && browserStatus !== null) {
      return {
        status: browserStatus,
        source: "BROWSER_SPEECH",
        transcript: cleanBrowser,
        sttDurationMs: elapsedMs(),
      };
    }
    return {
      status: "ENGINE_ERROR",
      source: "ENGINE_ERROR",
      transcript: null,
      sttDurationMs: elapsedMs(),
    };
  }
}
