"use client";

import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Ear,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { TaiThinhEarTrainerModal } from "@/components/entertainment/tai-thinh-ear-trainer-modal";
import { RegionalPhoneticProfileCard } from "@/components/profiles/regional-phonetic-profile-card";
import { CreateMicroStoryModal } from "@/components/reports/create-micro-story-modal";
import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { VoiceEngineBadge } from "@/components/reading/voice-engine-badge";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { useRecordingPlayback } from "@/hooks/use-recording-playback";
import { createSpeechService } from "@/lib/api/speech-service";
import { translateMessage } from "@/lib/i18n/formatter";
import { normalizeLocale, type SupportedLocale } from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import { getCachedLocaleMessages } from "@/messages/loader";
import { useMicroStoryTranslations } from "@/messages/features/micro_story";
import { useRegionalDialectTranslations } from "@/messages/features/regional_dialect";
import { viMessages } from "@/messages/vi";
import { prepareShortWordAudio } from "@/lib/reading/short-word-audio";
import { isServiceError } from "@/lib/api/service-error";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
import {
  BrowserTranscriptCollector,
  type SegmentResultMeta,
} from "@/lib/reading/browser-transcript-collector";
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
} from "@/lib/reading/browser-wasm-stt";
import { EchoGuard } from "@/lib/reading/echo-guard";
import {
  LocalSegmentSpeechRecognition,
  isInjectedTestSpeechRecognition,
  resolveLocalFirstSpeechRecognitionConstructor,
  shouldPreferAndroidNativeStt,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  getAndroidSpeechCapabilities,
  isAndroidNativeSpeechAvailable,
} from "@/lib/reading/native-speech-bridge";
import {
  fetchVoiceEngineHealth,
  getVoiceEngineHealthForRouting,
  recordSttEngineUsage,
} from "@/lib/reading/voice-engine-status";
import {
  awaitSttReadyBeforeListening,
  preloadReadingVoiceEngines,
} from "@/lib/reading/voice-preloader";
import {
  buildPhonicsLesson,
  evaluatePostPhonicsAttempt,
  type PhonicsLessonPlan,
  type ReadingWordMasteryOutcome,
  type SupportedPhonicsLessonPlan,
} from "@/lib/reading/phonics-lesson";
import { hasUsableBrowserConfidence } from "@/lib/reading/recognition-evidence";
import {
  getEffectiveTeacherPersona,
  getVoicePolicyPreferences,
  lockSessionVoice,
  releaseSessionVoiceLock,
} from "@/lib/reading/session-voice-lock";
import { parseVoiceIntent } from "@/lib/reading/voice-intent";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import {
  isAssistantPromptBleed,
  shortWordContext,
  stripNonSpeechAnnotations,
} from "@/lib/reading/retry-word-recognition";
import {
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";
import {
  isReplaySampleRequest,
  isSpellingHelpRequest,
  isWordHelpRequest,
  MAX_WORD_HELP_ROUNDS,
  WORD_HELP_SILENCE_LIMIT,
} from "@/lib/reading/word-help";
import {
  SHORT_WORD_CAPTURE_CONFIG,
  PHRASE_CAPTURE_CONFIG,
  VOICE_PROMPTS,
  classifyShortWordFailureLabel,
  hasShortWordSpeechActivity,
  shouldAutoStopShortWordCapture,
  type ShortWordFailureLabel,
  type WordPracticeState,
} from "@/lib/reading/word-practice-engine";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DifficultWordAssessmentStatus,
  DifficultWordDTO,
  DifficultWordPracticeAttemptDTO,
  DifficultWordPracticeHistoryItemDTO,
  DifficultWordPracticeStatus,
} from "@/types/reports";

interface BrowserSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult: ((event: BrowserSpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort?(): void;
}

interface BrowserSpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly onsetAt?: number | null;
    readonly 0?: { readonly transcript?: string; readonly confidence?: number };
  }>;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognitionLike;

interface WindowWithSpeechRecognition {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface CapturedAttemptPayload {
  readonly requestId: string;
  readonly audioBlob?: Blob | null;
  readonly durationMs: number;
  readonly audioQualityStatus: string | undefined;
  readonly browserTranscript: string | null;
  readonly browserConfidence: number | null;
}

type PreparedShortWordLike =
  | (Blob & { readonly pcm16k?: Float32Array | null })
  | { readonly blob: Blob; readonly pcm16k?: Float32Array | null };

function unpackPreparedShortWordAudio(
  prepared: PreparedShortWordLike | null,
): { readonly blob: Blob; readonly pcm16k: Float32Array | null } | null {
  if (!prepared) return null;
  if (prepared instanceof Blob) {
    return {
      blob: prepared,
      pcm16k: prepared.pcm16k ?? null,
    };
  }
  return {
    blob: prepared.blob,
    pcm16k: prepared.pcm16k ?? null,
  };
}

function hasTargetTokenSequence(
  spokenTokens: readonly string[],
  expectedTokens: readonly string[],
): boolean {
  if (
    expectedTokens.length === 0 ||
    spokenTokens.length < expectedTokens.length
  ) {
    return false;
  }
  for (let i = 0; i <= spokenTokens.length - expectedTokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < expectedTokens.length; j += 1) {
      if (spokenTokens[i + j] !== expectedTokens[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function isBackendSttHealthyForPractice(): boolean {
  const routingHealth = getVoiceEngineHealthForRouting();
  if (!routingHealth) return false;
  if (routingHealth.local.available && routingHealth.local.stt_ready) {
    return true;
  }
  const policy = getVoicePolicyPreferences();
  const allowCloud =
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleSttFallback;
  if (!allowCloud) return false;
  return Boolean(
    (routingHealth.google.stt_configured &&
      !routingHealth.google.stt_cooldown) ||
    (routingHealth.elevenlabs?.stt_configured &&
      !routingHealth.elevenlabs?.stt_cooldown),
  );
}

const PRACTICE_STATUS_KEYS: Record<DifficultWordPracticeStatus, string> = {
  NOT_PRACTICED: "practice.statusNotPracticed",
  IN_PROGRESS: "practice.statusInProgress",
  NEEDS_MORE_PRACTICE: "practice.statusNeedsMore",
  COMPLETED: "practice.statusCompleted",
};

const PRACTICE_STATUS_CLASSES: Record<DifficultWordPracticeStatus, string> = {
  NOT_PRACTICED: "border-red-200 bg-red-50 text-red-900",
  IN_PROGRESS: "border-amber-200 bg-amber-50 text-amber-900",
  NEEDS_MORE_PRACTICE: "border-red-200 bg-red-50 text-red-900",
  COMPLETED: "border-emerald-300 bg-emerald-50 text-emerald-900",
};

const ASSESSMENT_LABEL_KEYS: Record<DifficultWordAssessmentStatus, string> = {
  CORRECT: "practice.assessmentCorrect",
  INCORRECT: "practice.assessmentIncorrect",
  UNCERTAIN: "practice.assessmentUncertain",
  NO_CLEAR_AUDIO: "practice.assessmentNoClearAudio",
  ENGINE_ERROR: "practice.assessmentEngineError",
};

const FAILURE_LABEL_KEYS: Record<string, string> = {
  "Đọc đúng": "practice.assessmentCorrect",
  "Đọc sai": "practice.assessmentIncorrect",
  "Nghe chưa rõ": "practice.assessmentUncertain",
  "Chưa nghe thấy": "practice.assessmentNoClearAudio",
  "Máy đang bận": "practice.assessmentEngineError",
};

const EVALUATION_TIMEOUT_MS = 13_000;
const CUE_TIMEOUT_MS = 8_000;
const STT_WARMUP_WAIT_CAP_MS = 1_500;
const WASM_INIT_TIMEOUT_MS = 4_000;
const WASM_DECODE_TIMEOUT_MS = 8_000;

function resolvePracticeLocale(): SupportedLocale {
  if (typeof document !== "undefined") {
    const cookieLocale = readLocaleCookie();
    if (cookieLocale) return cookieLocale;
    const htmlLang = normalizeLocale(document.documentElement.lang);
    if (htmlLang) return htmlLang;
  }
  return "vi";
}

function createRequestUuid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
}

function mapMicrophoneErrorMessage(error: unknown): string {
  const locale = resolvePracticeLocale();
  const activeMessages = getCachedLocaleMessages(locale) ?? viMessages;
  const translateMic = (key: string) =>
    translateMessage(
      activeMessages,
      viMessages,
      locale,
      `difficultWords.practice.${key}`,
    );
  const errObj =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : null;
  const name = typeof errObj?.name === "string" ? errObj.name : "";
  const message =
    typeof errObj?.message === "string" ? errObj.message.toLowerCase() : "";
  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    message.includes("denied") ||
    message.includes("permission")
  ) {
    return translateMic("micPermissionError");
  }
  if (name === "NotFoundError" || message.includes("device not found")) {
    return translateMic("micNotFoundError");
  }
  if (message.includes("not supported")) {
    return translateMic("micUnsupportedError");
  }
  return translateMic("micGenericError");
}

interface DifficultWordPracticePanelProps {
  readonly autoStart?: boolean;
  readonly contextPhrase?: string | null;
  readonly visitedWords?: readonly string[];
  readonly child: ChildProfileDTO;
  readonly word: DifficultWordDTO;
  readonly words: readonly DifficultWordDTO[];
  readonly onSelectWord: (
    normalizedWord: string,
    options?: { readonly autoStart?: boolean },
  ) => void;
  readonly onClose: () => void;
  readonly onAttemptCompleted?: (
    attempt: DifficultWordPracticeAttemptDTO,
  ) => void;
  readonly onProgressSaved: () => Promise<void> | void;
}

export function DifficultWordPracticePanel({
  autoStart = false,
  contextPhrase: explicitContextPhrase,
  visitedWords,
  child,
  word,
  words,
  onSelectWord,
  onClose,
  onAttemptCompleted,
  onProgressSaved,
}: DifficultWordPracticePanelProps) {
  const { formatDateTime } = useI18n();
  const t = useTranslations("difficultWords");
  const tCommon = useTranslations("common");
  const tMicroStory = useMicroStoryTranslations();
  const tDialect = useRegionalDialectTranslations();
  const [showMicroStoryModal, setShowMicroStoryModal] = useState(false);
  const [showEarTrainerModal, setShowEarTrainerModal] = useState(false);
  const { difficultWordService } = useReportServices();
  const teacherPersona = useTeacherPersona();
  const speechService = useMemo(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const echoGuard = useMemo(() => new EchoGuard(), []);
  const practiceSessionLockId = `practice_${child.id}`;

  const [flowState, setFlowState] = useState<WordPracticeState>("IDLE");
  const [phraseTurn, setPhraseTurn] = useState(false);
  const [phraseAttemptFailed, setPhraseAttemptFailed] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [coachCue, setCoachCue] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [evaluationDurationMs, setEvaluationDurationMs] = useState<
    number | null
  >(null);
  const {
    playing: isPlayingSelf,
    error: playbackError,
    stop: stopSelfPlayback,
    toggle: toggleSelfPlayback,
  } = useRecordingPlayback();
  const [liveTranscript, setLiveTranscript] = useState<string | null>(null);
  const [latestResult, setLatestResult] =
    useState<DifficultWordPracticeAttemptDTO | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyStorageReady, setHistoryStorageReady] = useState(true);
  const [historyItems, setHistoryItems] = useState<
    readonly DifficultWordPracticeHistoryItemDTO[]
  >([]);
  const [historyPage, setHistoryPage] = useState(1);
  const HISTORY_PAGE_SIZE = 5;
  const [pendingSavePayload, setPendingSavePayload] =
    useState<CapturedAttemptPayload | null>(null);
  const [retryLoopPaused, setRetryLoopPaused] = useState(false);
  const [failureLabel, setFailureLabel] =
    useState<ShortWordFailureLabel | null>(null);
  const [activePhonicsStep, setActivePhonicsStep] = useState<number | null>(
    null,
  );
  const [isPlayingPhonics, setIsPlayingPhonics] = useState(false);
  const [aiPhonicsResult, setAiPhonicsResult] = useState<{
    readonly key: string;
    readonly status: "done";
    readonly plan: SupportedPhonicsLessonPlan | null;
  } | null>(null);
  const [masteryOutcome, setMasteryOutcome] =
    useState<ReadingWordMasteryOutcome | null>(null);
  const isEvaluatingPronunciation =
    flowState === "EVALUATING" || flowState === "SAVING";
  const evalProgress = useAiProgress({
    active: isEvaluatingPronunciation,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.transcribing") },
      { atPct: 50, label: tCommon("aiProgress.evaluatingAnswer") },
      { atPct: 86, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 5_000,
  });
  const phonicsProgress = useAiProgress({
    active: isPlayingPhonics,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.synthesizingVoice") },
      { atPct: 72, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 4_000,
  });

  const mountedRef = useRef(true);
  const flowGenerationRef = useRef(0);
  const playbackSeqRef = useRef(0);
  const usingAndroidNativeSttRef = useRef(false);
  const pollTimeoutRef = useRef<number | null>(null);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const captureStartedAtRef = useRef(0);
  const speechObservedRef = useRef(false);
  const browserPulseRef = useRef(false);
  const silenceStartedAtRef = useRef<number | null>(null);
  const browserCollectorRef = useRef(new BrowserTranscriptCollector());
  const browserBestConfRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognitionLike | null>(null);
  const stopCaptureLockRef = useRef(false);
  const stopCaptureTokenRef = useRef(0);
  const sttWarmupAttemptedRef = useRef(false);
  const lastKnownPracticeStatusRef = useRef<DifficultWordPracticeStatus>(
    word.practice_status ?? "NOT_PRACTICED",
  );
  const autoRetryCountRef = useRef(0);
  const incorrectCountRef = useRef(0);
  const heardFailuresRef = useRef(0);
  const phraseTurnRef = useRef(false);
  const silenceStreakRef = useRef(0);
  const helpRoundsRef = useRef(0);
  const usedHintRef = useRef(false);
  const usedPhonicsRef = useRef(false);
  const micPreparedRef = useRef(false);
  const evaluationRef = useRef<AbortController | null>(null);
  const wordCardRef = useRef<HTMLDivElement | null>(null);
  const phonicsCardRef = useRef<HTMLDivElement | null>(null);
  const captureTurnRef = useRef<(generation: number) => Promise<void>>(
    async () => undefined,
  );
  const cleanupRef = useRef<() => void>(() => undefined);
  const didAutoStartRef = useRef(false);

  const speechRecorder = useSpeechRecorder((error) => {
    if (mountedRef.current) {
      setMicError(mapMicrophoneErrorMessage(error));
    }
  });

  const primarySource = word.sources?.[0];
  // Fail-closed privacy isolation (Invariant #48 / TTS-03): any book-bound difficult word
  // that is explicitly PARENT_PRIVATE or not explicitly PUBLIC_CATALOG never touches
  // shared CATALOG or Browser IndexedDB caches.
  const isPrivateBookSource =
    primarySource?.visibility_scope === "PARENT_PRIVATE" ||
    Boolean(primarySource?.is_private_book) ||
    Boolean(
      primarySource?.book_id &&
      primarySource?.visibility_scope !== "PUBLIC_CATALOG",
    );
  const rawContextPhrase =
    explicitContextPhrase ?? primarySource?.context_phrase ?? null;
  const contextPhrase = shortWordContext(word.display_text, rawContextPhrase);
  const staticPhonicsLesson = useMemo(() => {
    if (rawContextPhrase && rawContextPhrase.trim()) {
      const targetNorm = normalizeVietnameseWord(word.display_text);
      const ctxTokens = tokenizeVietnameseText(rawContextPhrase);
      const focusIdx = ctxTokens.findIndex((t) => t === targetNorm);
      if (focusIdx >= 0 && ctxTokens.length > 1) {
        const withCtx = buildPhonicsLesson(rawContextPhrase, {
          focusSyllableIndex: focusIdx,
        });
        if (withCtx.supported) {
          return withCtx;
        }
      }
    }
    return buildPhonicsLesson(word.display_text);
  }, [rawContextPhrase, word.display_text]);

  const aiPhonicsLookupKey = `${word.display_text}::${rawContextPhrase ?? ""}`;
  const shouldFetchAiPhonics =
    !staticPhonicsLesson.supported &&
    staticPhonicsLesson.canPlayWholeWord &&
    typeof speechService.analyzePhonics === "function";

  useEffect(() => {
    if (!shouldFetchAiPhonics) return;
    let active = true;
    const controller = new AbortController();
    void speechService.analyzePhonics!(word.display_text, {
      contextPhrase: rawContextPhrase,
      signal: controller.signal,
    })
      .then((resolved) => {
        if (active) {
          setAiPhonicsResult({
            key: aiPhonicsLookupKey,
            status: "done",
            plan: resolved && resolved.supported ? resolved : null,
          });
        }
      })
      .catch(() => {
        if (active) {
          setAiPhonicsResult({
            key: aiPhonicsLookupKey,
            status: "done",
            plan: null,
          });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    aiPhonicsLookupKey,
    rawContextPhrase,
    shouldFetchAiPhonics,
    speechService,
    word.display_text,
  ]);

  const resolvedAiForWord =
    aiPhonicsResult?.key === aiPhonicsLookupKey ? aiPhonicsResult : null;
  const isAnalyzingPhonicsAi =
    shouldFetchAiPhonics && resolvedAiForWord === null;
  const phonicsLesson: PhonicsLessonPlan = staticPhonicsLesson.supported
    ? staticPhonicsLesson
    : (resolvedAiForWord?.plan ?? staticPhonicsLesson);
  const wordIndexInQueue = useMemo(
    () =>
      words.findIndex((item) => item.normalized_word === word.normalized_word),
    [word.normalized_word, words],
  );

  const nextWordTarget = useMemo(() => {
    const serverNext = latestResult?.next_recommended_word;
    if (serverNext) {
      const found = words.find((item) => item.normalized_word === serverNext);
      if (found) return found;
    }
    const incompleteOther = words.find(
      (item) =>
        item.normalized_word !== word.normalized_word &&
        item.practice_status !== "COMPLETED",
    );
    if (incompleteOther) return incompleteOther;
    return (
      words.find((item) => item.normalized_word !== word.normalized_word) ??
      null
    );
  }, [latestResult?.next_recommended_word, word.normalized_word, words]);

  const effectiveStatus: DifficultWordPracticeStatus =
    latestResult?.word_progress.practice_status ??
    word.practice_status ??
    "NOT_PRACTICED";

  const clearTimers = useCallback(() => {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, []);

  const stopBrowserRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        try {
          rec.abort?.();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }, []);

  useEffect(() => {
    lastKnownPracticeStatusRef.current =
      word.practice_status ?? "NOT_PRACTICED";
  }, [word.normalized_word, word.practice_status]);

  useEffect(() => {
    let active = true;
    difficultWordService
      .getPracticeHistory(child.id, {
        normalizedWord: word.normalized_word,
        limit: 10,
      })
      .then((response) => {
        if (!active) return;
        setHistoryStorageReady(response.storage_ready);
        setHistoryItems(response.items);
      })
      .catch(() => {
        if (!active) return;
        setHistoryStorageReady(false);
        setHistoryItems([]);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [child.id, difficultWordService, word.normalized_word]);

  useEffect(() => {
    cleanupRef.current = () => {
      evaluationRef.current?.abort();
      evaluationRef.current = null;
      clearTimers();
      stopBrowserRecognition();
      speechPlayer.stop();
      speechRecorder.cancel();
      stopSelfPlayback();
    };
  });

  const setSpeechCacheContext = speechPlayer.setCacheContext;
  useEffect(() => {
    setSpeechCacheContext?.({
      bookId: primarySource?.book_id ?? null,
      pageId: primarySource?.page_id ?? null,
      pageRevisionId: primarySource?.page_revision_id ?? null,
      isPrivateBook: isPrivateBookSource,
      bypassSessionLock: true,
    });
    return () => {
      setSpeechCacheContext?.(null);
    };
  }, [
    setSpeechCacheContext,
    primarySource?.book_id,
    primarySource?.page_id,
    primarySource?.page_revision_id,
    isPrivateBookSource,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    lockSessionVoice(practiceSessionLockId, { forceUpdate: true });
    if (isAndroidNativeSpeechAvailable()) {
      void getAndroidSpeechCapabilities().catch(() => null);
    }
    if (!getVoiceEngineHealthForRouting()) {
      void fetchVoiceEngineHealth().catch(() => null);
    }
    return () => {
      mountedRef.current = false;
      flowGenerationRef.current += 1;
      cleanupRef.current();
      releaseSessionVoiceLock(practiceSessionLockId);
    };
  }, [practiceSessionLockId]);

  useEffect(() => {
    void preloadReadingVoiceEngines({
      bookId: primarySource?.book_id ?? null,
      pageId: primarySource?.page_id ?? null,
      pageRevisionId: primarySource?.page_revision_id ?? null,
      isPrivateBook: isPrivateBookSource,
      previewWords: [word.display_text],
    });
  }, [
    isPrivateBookSource,
    primarySource?.book_id,
    primarySource?.page_id,
    primarySource?.page_revision_id,
    word.display_text,
  ]);

  const playCue = useCallback(
    async (
      text: string,
      generation: number,
      wordSample = false,
      options?: { readonly preserveBookText?: boolean },
    ) => {
      if (!mountedRef.current || generation !== flowGenerationRef.current)
        return false;
      // Pause/release mic before TTS playback so Android restores loudspeaker
      // USAGE_MEDIA and EchoGuard blocks speaker bleed (Bug 5a & 5c).
      stopBrowserRecognition();
      speechRecorder.cancel({ retainStream: false });
      const adaptedText =
        wordSample || options?.preserveBookText
          ? text
          : adaptTextToTeacherPersona(
              text,
              getEffectiveTeacherPersona().gender,
            );
      setCoachCue(adaptedText);
      const playbackId = `practice-cue-${(playbackSeqRef.current += 1)}`;
      echoGuard.playbackStarted(playbackId, adaptedText, performance.now());
      try {
        await withRequestDeadline(
          () =>
            wordSample
              ? speechPlayer.play(adaptedText, {
                  wordSample: true,
                  bypassSessionLock: true,
                  bookId: primarySource?.book_id ?? null,
                  pageId: primarySource?.page_id ?? null,
                  pageRevisionId: primarySource?.page_revision_id ?? null,
                  isPrivateBook: isPrivateBookSource,
                  cacheScope: isPrivateBookSource ? "PRIVATE" : "CATALOG",
                })
              : speechPlayer.play(adaptedText, {
                  coaching: true,
                  isPrivateBook: false,
                  cacheScope: "COACHING",
                }),
          undefined,
          CUE_TIMEOUT_MS,
        );
      } catch {
        if (!mountedRef.current || generation !== flowGenerationRef.current)
          return false;
        speechPlayer.stop();
        if (wordSample) setSampleError(t("practice.sampleErrorGeneric"));
      } finally {
        echoGuard.playbackEnded(playbackId, performance.now());
      }
      return mountedRef.current && generation === flowGenerationRef.current;
    },
    [
      echoGuard,
      isPrivateBookSource,
      primarySource?.book_id,
      primarySource?.page_id,
      primarySource?.page_revision_id,
      speechPlayer,
      speechRecorder,
      stopBrowserRecognition,
      t,
    ],
  );

  const runPhonicsGuidance = useCallback(
    async (generation: number, reopenMicAfter: boolean) => {
      if (!mountedRef.current || generation !== flowGenerationRef.current)
        return;
      stopBrowserRecognition();
      speechRecorder.cancel();
      stopSelfPlayback();
      setSampleError(null);
      setFailureLabel(null);

      if (!phonicsLesson.supported) {
        if (phonicsLesson.canPlayWholeWord) {
          usedHintRef.current = true;
          setFlowState("INSTRUCTING");
          await playCue(word.display_text, generation, true);
          if (
            reopenMicAfter &&
            micPreparedRef.current &&
            mountedRef.current &&
            generation === flowGenerationRef.current
          ) {
            await playCue("Đến lượt con. Con đọc lại nhé.", generation);
            await captureTurnRef.current(generation);
          } else if (
            mountedRef.current &&
            generation === flowGenerationRef.current
          ) {
            setFlowState("IDLE");
          }
        } else if (
          mountedRef.current &&
          generation === flowGenerationRef.current
        ) {
          setFlowState("IDLE");
        }
        return;
      }

      usedPhonicsRef.current = true;
      setFlowState("INSTRUCTING");
      setIsPlayingPhonics(true);
      setActivePhonicsStep(0);
      const phonicsTeacher =
        getEffectiveTeacherPersona().gender === "male" ? "Thầy" : "Cô";
      setCoachCue(
        `${phonicsTeacher} đánh vần từng bước tiếng “${phonicsLesson.focusSyllable}” nhé.`,
      );

      const phonicsPlaybackId = `practice-phonics-${(playbackSeqRef.current += 1)}`;
      echoGuard.playbackStarted(
        phonicsPlaybackId,
        phonicsLesson.steps.map((s) => s.spokenText).join(" "),
        performance.now(),
      );
      try {
        if (typeof speechPlayer.playPhonicsLesson === "function") {
          await withRequestDeadline(
            () =>
              speechPlayer.playPhonicsLesson(phonicsLesson, {
                bypassSessionLock: true,
                bookId: primarySource?.book_id ?? null,
                pageId: primarySource?.page_id ?? null,
                pageRevisionId: primarySource?.page_revision_id ?? null,
                isPrivateBook: isPrivateBookSource,
                cacheScope: isPrivateBookSource ? "PRIVATE" : "CATALOG",
                onStepChange: (idx) => {
                  if (
                    mountedRef.current &&
                    generation === flowGenerationRef.current
                  ) {
                    setActivePhonicsStep(idx);
                  }
                },
              }),
            undefined,
            CUE_TIMEOUT_MS * 2,
          );
        } else {
          for (const step of phonicsLesson.steps) {
            if (!mountedRef.current || generation !== flowGenerationRef.current)
              break;
            setActivePhonicsStep(step.index);
            await playCue(step.spokenText, generation, false, {
              preserveBookText: true,
            });
          }
        }
      } catch {
        if (!mountedRef.current || generation !== flowGenerationRef.current)
          return;
        speechPlayer.stop();
        setSampleError(t("practice.phonicsLockedBusy"));
      } finally {
        echoGuard.playbackEnded(phonicsPlaybackId, performance.now());
        if (mountedRef.current && generation === flowGenerationRef.current) {
          setIsPlayingPhonics(false);
        }
      }

      if (!mountedRef.current || generation !== flowGenerationRef.current)
        return;

      if (reopenMicAfter && micPreparedRef.current) {
        if (!(await playCue("Đến lượt con. Con đọc lại nhé.", generation)))
          return;
        await captureTurnRef.current(generation);
      } else {
        setFlowState("IDLE");
      }
    },
    [
      echoGuard,
      isPrivateBookSource,
      phonicsLesson,
      playCue,
      primarySource?.book_id,
      primarySource?.page_id,
      primarySource?.page_revision_id,
      speechPlayer,
      speechRecorder,
      stopBrowserRecognition,
      stopSelfPlayback,
      t,
      word.display_text,
    ],
  );

  const scheduleNextWord = useCallback(
    (generation: number, recommended?: string | null): boolean => {
      const currentNormalized = word.normalized_word;
      const eligible = words.filter(
        (item) =>
          item.normalized_word !== currentNormalized &&
          item.practice_status !== "COMPLETED" &&
          !visitedWords?.includes(item.normalized_word),
      );
      const next =
        eligible.find((item) => item.normalized_word === recommended) ??
        eligible[0];
      if (!next) return false;
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current && generation === flowGenerationRef.current) {
          onSelectWord(next.normalized_word, { autoStart: true });
        }
      }, SHORT_WORD_CAPTURE_CONFIG.autoAdvanceCorrectMs);
      return true;
    },
    [onSelectWord, visitedWords, word.normalized_word, words],
  );

  const retryTurn = useCallback(
    async (
      generation: number,
      reason: "help" | "silence" | "unclear" | "incorrect",
      heardSpeech = false,
    ) => {
      const silence = reason === "silence";
      silenceStreakRef.current = silence ? silenceStreakRef.current + 1 : 0;
      const guide =
        reason === "help" ||
        silenceStreakRef.current >= WORD_HELP_SILENCE_LIMIT;
      if (reason === "incorrect") incorrectCountRef.current += 1;
      if (reason === "incorrect" || (reason === "unclear" && heardSpeech))
        heardFailuresRef.current += 1;
      const switchToPhrase =
        contextPhrase &&
        !phraseTurnRef.current &&
        heardFailuresRef.current >= 1;
      if (
        !switchToPhrase &&
        (incorrectCountRef.current >= 3 ||
          helpRoundsRef.current >= MAX_WORD_HELP_ROUNDS ||
          (!guide &&
            autoRetryCountRef.current >=
              SHORT_WORD_CAPTURE_CONFIG.maxAutoRetries))
      ) {
        speechRecorder.cancel();
        setMasteryOutcome("NEEDS_PRACTICE");
        setRetryLoopPaused(true);
        setFlowState("NEEDS_RETRY");
        const hasEligibleNext = words.some(
          (item) =>
            item.normalized_word !== word.normalized_word &&
            item.practice_status !== "COMPLETED" &&
            !visitedWords?.includes(item.normalized_word),
        );
        if (hasEligibleNext) {
          await playCue(
            "Không sao đâu, từ này mình luyện thêm sau. Mình sang từ tiếp theo nhé!",
            generation,
          );
          if (mountedRef.current && generation === flowGenerationRef.current) {
            scheduleNextWord(generation);
          }
        }
        return;
      }

      setFlowState("INSTRUCTING");
      if (switchToPhrase) {
        usedHintRef.current = true;
        phraseTurnRef.current = true;
        setPhraseTurn(true);
        if (
          !(await playCue(
            `Con hãy đọc cả cụm: ${contextPhrase}.`,
            generation,
            false,
            {
              preserveBookText: true,
            },
          ))
        )
          return;
      } else if (guide) {
        helpRoundsRef.current += 1;
        usedHintRef.current = true;
        if (phraseTurnRef.current && contextPhrase) {
          void speechPlayer.prefetch?.(contextPhrase + ".", {
            coaching: false,
          });
        } else {
          void speechPlayer.prefetch?.(word.display_text, {
            wordSample: true,
          });
        }
        void speechPlayer.prefetch?.("Đến lượt con. Con đọc lại nhé.", {
          coaching: true,
        });
        if (
          !(await playCue(
            adaptTextToTeacherPersona(
              "Không sao đâu. Con nghe cô đọc nhé.",
              getEffectiveTeacherPersona().gender,
            ),
            generation,
          ))
        )
          return;
        if (phraseTurnRef.current && contextPhrase) {
          if (
            !(await playCue(contextPhrase + ".", generation, false, {
              preserveBookText: true,
            }))
          )
            return;
        } else if (!(await playCue(word.display_text, generation, true)))
          return;
        if (!(await playCue("Đến lượt con. Con đọc lại nhé.", generation)))
          return;
      } else {
        autoRetryCountRef.current += 1;
        if (reason === "incorrect") usedHintRef.current = true;
        const cue = adaptTextToTeacherPersona(
          reason === "incorrect"
            ? "Con thử đọc lại nhé."
            : silence
              ? "Cô đang nghe. Con thử đọc nhé."
              : "Cô chưa nghe rõ. Con đọc lại nhé.",
          getEffectiveTeacherPersona().gender,
        );
        if (!(await playCue(cue, generation))) return;
      }
      await captureTurnRef.current(generation);
    },
    [
      contextPhrase,
      playCue,
      scheduleNextWord,
      speechPlayer,
      speechRecorder,
      visitedWords,
      word.display_text,
      word.normalized_word,
      words,
    ],
  );

  const submitEvaluation = useCallback(
    async (
      payload: CapturedAttemptPayload,
      generation: number,
      existingController?: AbortController,
      startedAtMs?: number,
    ) => {
      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }
      if (existingController) {
        if (existingController.signal.aborted) return;
      } else if (evaluationRef.current) {
        return;
      }
      const controller = existingController ?? new AbortController();
      const evaluationStart = startedAtMs ?? performance.now();
      evaluationRef.current = controller;
      setFlowState("EVALUATING");
      setSubmitError(null);
      setPendingSavePayload(null);

      try {
        const policy = getVoicePolicyPreferences();
        const evaluated = await withRequestDeadline(
          async (signal) => {
            if (difficultWordService.evaluatePracticeWord) {
              return difficultWordService.evaluatePracticeWord(
                child.id,
                {
                  request_id: payload.requestId,
                  normalized_word: word.normalized_word,
                  display_text: word.display_text,
                  context_phrase: rawContextPhrase ?? undefined,
                  audio: payload.audioBlob ?? undefined,
                  audio_duration_ms: payload.durationMs,
                  audio_quality_status: payload.audioQualityStatus ?? undefined,
                  browser_transcript: payload.browserTranscript ?? undefined,
                  browser_confidence: payload.browserConfidence ?? undefined,
                  book_id: primarySource?.book_id ?? undefined,
                  session_id: primarySource?.session_id ?? undefined,
                  page_id: primarySource?.page_id ?? undefined,
                  page_revision_id:
                    primarySource?.page_revision_id ?? undefined,
                  word_id: primarySource?.word_id ?? undefined,
                  evidence_word_ids: word.evidence_word_ids,
                  provider_mode: policy.providerMode,
                  allow_google_stt: policy.allowGoogleSttFallback,
                  includeNextRecommended: false,
                  timeoutMs: 12_000,
                },
                signal,
              );
            } else {
              const started = await difficultWordService.startPractice(
                child.id,
                {
                  request_id: payload.requestId,
                  normalized_word: word.normalized_word,
                  display_text: word.display_text,
                  evidence_word_ids: word.evidence_word_ids,
                },
                signal,
              );
              signal.throwIfAborted();
              return difficultWordService.evaluateAudio(
                child.id,
                started.attempt_id,
                {
                  completion_request_id: payload.requestId,
                  audio:
                    payload.audioBlob ?? new Blob([], { type: "audio/wav" }),
                  audio_duration_ms: payload.durationMs,
                  audio_quality_status: payload.audioQualityStatus ?? undefined,
                  browser_transcript: payload.browserTranscript ?? undefined,
                  browser_confidence: payload.browserConfidence ?? undefined,
                },
                signal,
              );
            }
          },
          controller.signal,
          EVALUATION_TIMEOUT_MS,
        );

        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }

        if (evaluationRef.current === controller) {
          evaluationRef.current = null;
        }
        setEvaluationDurationMs(
          Math.round(performance.now() - evaluationStart),
        );
        setLatestResult(evaluated);
        onAttemptCompleted?.(evaluated);
        const prevPracticeStatus = lastKnownPracticeStatusRef.current;
        const nextPracticeStatus = evaluated.word_progress?.practice_status;
        if (nextPracticeStatus) {
          lastKnownPracticeStatusRef.current = nextPracticeStatus;
        }
        if (
          nextPracticeStatus === "COMPLETED" &&
          prevPracticeStatus !== "COMPLETED"
        ) {
          void Promise.resolve()
            .then(onProgressSaved)
            .catch(() => undefined);
        }
        const nowIso = new Date().toISOString();
        setHistoryItems((prev) => {
          const attemptId = evaluated.attempt_id ?? payload.requestId;
          const deduped = prev.filter((item) => item.attempt_id !== attemptId);
          const localItem: DifficultWordPracticeHistoryItemDTO = {
            attempt_id: attemptId,
            normalized_word: evaluated.normalized_word ?? word.normalized_word,
            display_text: evaluated.display_text ?? word.display_text,
            attempt_number:
              typeof evaluated.attempt_number === "number"
                ? evaluated.attempt_number
                : deduped.length + 1,
            state: evaluated.state ?? "COMPLETED",
            assessment_status: evaluated.assessment_status ?? null,
            recognition_source: evaluated.recognition_source ?? null,
            spoken_transcript: evaluated.spoken_transcript ?? null,
            confidence: evaluated.confidence ?? null,
            audio_duration_ms:
              evaluated.audio_duration_ms ?? payload.durationMs,
            assessment_version: evaluated.assessment_version ?? 1,
            started_at: evaluated.started_at ?? nowIso,
            completed_at: evaluated.completed_at ?? nowIso,
          };
          return [localItem, ...deduped].slice(0, 10);
        });
        setHistoryLoading(false);

        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }

        if (evaluated.assessment_status === "CORRECT") {
          const spokenForCheck =
            evaluated.spoken_transcript ?? payload.browserTranscript ?? "";
          if (
            usedPhonicsRef.current &&
            phonicsLesson.supported &&
            spokenForCheck
          ) {
            const postCheck = evaluatePostPhonicsAttempt(
              spokenForCheck,
              phonicsLesson,
            );
            if (postCheck.kind === "SPELLING_STEP_ONLY") {
              setFlowState("INSTRUCTING");
              if (!(await playCue(postCheck.message, generation))) return;
              await captureTurnRef.current(generation);
              return;
            }
          }
          speechRecorder.cancel();
          autoRetryCountRef.current = 0;
          silenceStreakRef.current = 0;
          setRetryLoopPaused(false);
          setFailureLabel(null);
          setMasteryOutcome(
            usedPhonicsRef.current
              ? "CORRECT_AFTER_SPELLING"
              : usedHintRef.current
                ? "CORRECT_AFTER_HINT"
                : "FIRST_PASS_CORRECT",
          );
          setFlowState("SUCCESS");
          if (!(await playCue(VOICE_PROMPTS.correctPraise(), generation)))
            return;
          const scheduled = scheduleNextWord(
            generation,
            evaluated.next_recommended_word,
          );
          if (!scheduled) {
            const allQueueFinished =
              words.length > 0 &&
              words.every(
                (item) =>
                  item.normalized_word === word.normalized_word ||
                  item.practice_status === "COMPLETED" ||
                  visitedWords?.includes(item.normalized_word),
              );
            if (allQueueFinished) {
              await playCue(
                "Tuyệt vời! Con đã hoàn thành hết tất cả các từ cần luyện hôm nay rồi! Hoan hô con!",
                generation,
              );
            }
          }
        } else if (evaluated.assessment_status === "ENGINE_ERROR") {
          speechRecorder.cancel();
          setFailureLabel(null);
          setFlowState("TECHNICAL_ERROR");
        } else {
          const nextFailureLabel = classifyShortWordFailureLabel(
            evaluated.assessment_status,
            payload.audioQualityStatus,
            evaluated.spoken_transcript,
          );
          setFailureLabel(nextFailureLabel);
          const spoken =
            evaluated.spoken_transcript ?? payload.browserTranscript ?? "";
          const spokenIntent = spoken
            ? parseVoiceIntent(spoken, { upcomingText: word.display_text })
            : { type: "NONE" as const };
          if (
            isSpellingHelpRequest(spoken, word.display_text) ||
            spokenIntent.type === "SPELL"
          ) {
            setFailureLabel(null);
            await runPhonicsGuidance(generation, true);
            return;
          }
          if (
            isReplaySampleRequest(spoken, word.display_text) ||
            spokenIntent.type === "REPLAY"
          ) {
            usedHintRef.current = true;
            setFailureLabel(null);
            setFlowState("INSTRUCTING");
            await playCue(word.display_text, generation, true);
            await playCue("Đến lượt con. Con đọc lại nhé.", generation);
            await captureTurnRef.current(generation);
            return;
          }
          if (spokenIntent.type === "STOP") {
            flowGenerationRef.current += 1;
            cleanupRef.current();
            setFlowState("PAUSED");
            return;
          }
          if (spokenIntent.type === "SKIP") {
            speechRecorder.cancel();
            setFailureLabel(null);
            if (
              nextWordTarget &&
              nextWordTarget.normalized_word !== word.normalized_word
            ) {
              onSelectWord(nextWordTarget.normalized_word, { autoStart: true });
            } else {
              onClose();
            }
            return;
          }
          if (usedPhonicsRef.current && phonicsLesson.supported && spoken) {
            const postCheck = evaluatePostPhonicsAttempt(spoken, phonicsLesson);
            if (postCheck.kind === "SPELLING_STEP_ONLY") {
              setFailureLabel(null);
              setFlowState("INSTRUCTING");
              if (!(await playCue(postCheck.message, generation))) return;
              await captureTurnRef.current(generation);
              return;
            }
          }
          const askedForHelp =
            evaluated.assessment_status === "UNCERTAIN" &&
            isWordHelpRequest(spoken, word.display_text);
          const spokenTokens = tokenizeVietnameseText(
            stripNonSpeechAnnotations(spoken),
          );
          const heardSpeech =
            spokenTokens.length > 0 &&
            !isAssistantPromptBleed(
              spokenTokens,
              tokenizeVietnameseText(word.display_text),
            );
          if (
            phraseTurnRef.current &&
            !askedForHelp &&
            (evaluated.assessment_status === "INCORRECT" ||
              (evaluated.assessment_status === "UNCERTAIN" && heardSpeech))
          ) {
            speechRecorder.cancel();
            setMasteryOutcome("NEEDS_PRACTICE");
            setPhraseAttemptFailed(true);
            setRetryLoopPaused(true);
            setFlowState("NEEDS_RETRY");
            if (
              words.some(
                (item) =>
                  item.normalized_word !== word.normalized_word &&
                  item.practice_status !== "COMPLETED" &&
                  !visitedWords?.includes(item.normalized_word),
              )
            ) {
              await playCue(
                "Không sao đâu, từ này mình luyện thêm sau. Mình sang từ tiếp theo nhé!",
                generation,
              );
              if (
                mountedRef.current &&
                generation === flowGenerationRef.current
              ) {
                scheduleNextWord(generation, evaluated.next_recommended_word);
              }
            }
            return;
          }
          await retryTurn(
            generation,
            askedForHelp
              ? "help"
              : nextFailureLabel === "Chưa nghe thấy"
                ? "silence"
                : nextFailureLabel === "Đọc sai"
                  ? "incorrect"
                  : "unclear",
            heardSpeech,
          );
        }
      } catch (error) {
        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }
        speechRecorder.cancel();
        setPendingSavePayload(payload);
        setFlowState("TECHNICAL_ERROR");
        if (isServiceError(error) && error.status === 503) {
          setSubmitError(error.message);
        } else if (error instanceof Error && error.name === "TimeoutError") {
          setSubmitError(t("practice.evaluationTimeoutError"));
        } else {
          setSubmitError(t("practice.evaluationSaveError"));
        }
      } finally {
        if (evaluationRef.current === controller) evaluationRef.current = null;
      }
    },
    [
      child.id,
      difficultWordService,
      nextWordTarget,
      onAttemptCompleted,
      onClose,
      onProgressSaved,
      onSelectWord,
      phonicsLesson,
      primarySource,
      rawContextPhrase,
      playCue,
      runPhonicsGuidance,
      scheduleNextWord,
      retryTurn,
      speechRecorder,
      t,
      visitedWords,
      word.display_text,
      word.evidence_word_ids,
      word.normalized_word,
      words,
    ],
  );

  const finalizeCaptureAndEvaluate = useCallback(
    async (generation: number) => {
      if (stopCaptureLockRef.current) return;
      const myStopToken = ++stopCaptureTokenRef.current;
      stopCaptureLockRef.current = true;
      clearTimers();

      const evalController = new AbortController();
      const evaluationStart = performance.now();
      evaluationRef.current?.abort();
      evaluationRef.current = evalController;
      setFlowState("EVALUATING");
      setSubmitError(null);
      setPendingSavePayload(null);

      const isStale = () =>
        !mountedRef.current ||
        generation !== flowGenerationRef.current ||
        evalController.signal.aborted;

      const releaseEvalControllerIfOwned = () => {
        if (evaluationRef.current === evalController) {
          evaluationRef.current = null;
        }
      };

      const releaseStopLockIfOwned = () => {
        if (stopCaptureTokenRef.current === myStopToken) {
          stopCaptureLockRef.current = false;
        }
      };

      try {
        const recognition = recognitionRef.current;
        // stop() may deliver its last final after the recorder has already stopped.
        const finalResult = recognition
          ? new Promise<void>((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                evalController.signal.removeEventListener("abort", onAbort);
                resolve();
              };
              const onAbort = () => {
                try {
                  recognition.abort?.();
                } catch {
                  // Ignore abort errors
                }
                finish();
              };
              const timer = window.setTimeout(() => {
                try {
                  recognition.abort?.();
                } catch {
                  // Ignore abort errors
                }
                finish();
              }, 300);
              if (evalController.signal.aborted) {
                onAbort();
                return;
              }
              evalController.signal.addEventListener("abort", onAbort, {
                once: true,
              });
              recognition.onend = () => {
                finish();
              };
              try {
                recognition.stop();
              } catch {
                finish();
              }
            })
          : Promise.resolve();

        const usedAndroidNativeStt = usingAndroidNativeSttRef.current;
        let blob: Blob | null = null;
        if (!usedAndroidNativeStt) {
          try {
            blob = await speechRecorder.stop();
          } catch {
            blob = null;
          }
        }
        await finalResult;

        if (isStale()) {
          return;
        }
        stopBrowserRecognition();
        const transcript = browserCollectorRef.current.getTranscript();
        const transcriptIntent = transcript
          ? parseVoiceIntent(transcript, { upcomingText: word.display_text })
          : { type: "NONE" as const };
        if (
          isSpellingHelpRequest(transcript, word.display_text) ||
          transcriptIntent.type === "SPELL"
        ) {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          setFailureLabel(null);
          setLiveTranscript(null);
          await runPhonicsGuidance(generation, true);
          return;
        }
        if (
          isReplaySampleRequest(transcript, word.display_text) ||
          transcriptIntent.type === "REPLAY"
        ) {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          usedHintRef.current = true;
          setFailureLabel(null);
          setLiveTranscript(null);
          setFlowState("INSTRUCTING");
          await playCue(word.display_text, generation, true);
          await playCue("Đến lượt con. Con đọc lại nhé.", generation);
          await captureTurnRef.current(generation);
          return;
        }
        if (transcriptIntent.type === "STOP") {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          flowGenerationRef.current += 1;
          cleanupRef.current();
          setFlowState("PAUSED");
          return;
        }
        if (transcriptIntent.type === "SKIP") {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          speechRecorder.cancel();
          setFailureLabel(null);
          setLiveTranscript(null);
          if (
            nextWordTarget &&
            nextWordTarget.normalized_word !== word.normalized_word
          ) {
            onSelectWord(nextWordTarget.normalized_word, { autoStart: true });
          } else {
            onClose();
          }
          return;
        }
        if (
          isWordHelpRequest(transcript, word.display_text) ||
          transcriptIntent.type === "HELP"
        ) {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          setFailureLabel(null);
          setLiveTranscript(null);
          await retryTurn(generation, "help");
          return;
        }
        if (usedPhonicsRef.current && phonicsLesson.supported && transcript) {
          const preCheck = evaluatePostPhonicsAttempt(
            transcript,
            phonicsLesson,
          );
          if (preCheck.kind === "SPELLING_STEP_ONLY") {
            releaseEvalControllerIfOwned();
            releaseStopLockIfOwned();
            setFailureLabel(null);
            setLiveTranscript(null);
            setFlowState("INSTRUCTING");
            if (!(await playCue(preCheck.message, generation))) return;
            await captureTurnRef.current(generation);
            return;
          }
        }

        if (usedAndroidNativeStt && (!blob || blob.size === 0)) {
          if (!transcript) {
            releaseEvalControllerIfOwned();
            releaseStopLockIfOwned();
            setRecordedBlob(null);
            setFailureLabel("Chưa nghe thấy");
            await retryTurn(generation, "silence");
            return;
          }
          const elapsed = Math.max(
            200,
            Math.round(performance.now() - captureStartedAtRef.current),
          );
          stopSelfPlayback();
          setRecordedBlob(null);
          const captured: CapturedAttemptPayload = {
            requestId: createRequestUuid(),
            audioBlob: undefined,
            durationMs: elapsed,
            audioQualityStatus: "ANDROID_NATIVE_STT",
            browserTranscript: transcript,
            browserConfidence: browserBestConfRef.current ?? 0.9,
          };
          releaseStopLockIfOwned();
          await submitEvaluation(
            captured,
            generation,
            evalController,
            evaluationStart,
          );
          return;
        }

        if (!blob || blob.size === 0) {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          speechRecorder.cancel({ retainStream: false });
          setMicError(t("practice.micEmptyAudioError"));
          setFlowState("NEEDS_RETRY");
          return;
        }

        const quality = speechRecorder.getQuality?.();
        const qualityStatus = quality?.status as string | undefined;
        if (
          qualityStatus === "CLIPPING" ||
          qualityStatus === "INVALID_AUDIO" ||
          qualityStatus === "AUDIO_TOO_SHORT"
        ) {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          setRecordedBlob(null);
          setFailureLabel("Nghe chưa rõ");
          await retryTurn(generation, "unclear");
          return;
        }
        const preparedRaw =
          quality?.status === "SILENCE" || quality?.status === "NO_AUDIO"
            ? null
            : await prepareShortWordAudio(blob);
        if (isStale()) return;
        const prepared = unpackPreparedShortWordAudio(
          preparedRaw as PreparedShortWordLike | null,
        );
        if (!prepared) {
          releaseEvalControllerIfOwned();
          releaseStopLockIfOwned();
          setRecordedBlob(null);
          setFailureLabel("Chưa nghe thấy");
          await retryTurn(generation, "silence");
          return;
        }
        const recording = prepared.blob;
        const preparedPcm16k = prepared.pcm16k;
        const elapsed =
          quality?.durationMs && quality.durationMs > 0
            ? quality.durationMs
            : Math.max(
                0,
                Math.round(performance.now() - captureStartedAtRef.current),
              );

        stopSelfPlayback();
        setRecordedBlob(recording);

        const policy = getVoicePolicyPreferences();
        const allowCloudSttFallback =
          policy.providerMode === "local_with_google_fallback" &&
          policy.allowGoogleSttFallback;
        let effectiveTranscript = transcript
          ? transcript.normalize("NFC").trim()
          : null;
        let effectiveConfidence = browserBestConfRef.current;
        let effectiveQualityStatus: string | undefined = quality?.status;
        let uploadAudioBlob: Blob | undefined = recording;
        const routingHealth = getVoiceEngineHealthForRouting();
        const localSttDown =
          routingHealth !== null &&
          (!routingHealth.local.available || !routingHealth.local.stt_ready);
        if (
          localSttDown &&
          !effectiveTranscript &&
          detectBrowserWasmSttSupport().supported
        ) {
          const wasmClient = getBrowserWasmSttClient();
          const shouldSkipColdWasm =
            allowCloudSttFallback && !wasmClient.isReady();
          if (!shouldSkipColdWasm) {
            try {
              const wasmOpts = {
                initTimeoutMs: WASM_INIT_TIMEOUT_MS,
                timeoutMs: WASM_DECODE_TIMEOUT_MS,
                signal: evalController.signal,
                voicedDurationMs: quality?.speechDurationMs,
              };
              const wasmRes =
                preparedPcm16k && preparedPcm16k.length > 0
                  ? await wasmClient.transcribeSamples(preparedPcm16k, wasmOpts)
                  : await wasmClient.transcribeBlob(recording, wasmOpts);
              if (isStale()) {
                return;
              }
              const wasmText = wasmRes.text.normalize("NFC").trim();
              if (wasmText) {
                effectiveTranscript = wasmText;
                recordSttEngineUsage({
                  provider: "wasm",
                  fallbackUsed: true,
                  fallbackReason: "LOCAL_STT_UNAVAILABLE",
                });
                const isExactMatch =
                  normalizeVietnameseWord(wasmText) ===
                  normalizeVietnameseWord(word.display_text);
                const isPhraseMatch =
                  phraseTurnRef.current &&
                  Boolean(contextPhrase) &&
                  hasTargetTokenSequence(
                    tokenizeVietnameseText(wasmText),
                    tokenizeVietnameseText(word.display_text),
                  );
                const wasmIsCorrect = isExactMatch || isPhraseMatch;
                if (wasmIsCorrect || !allowCloudSttFallback) {
                  effectiveQualityStatus = "BROWSER_WASM_VERIFIED";
                  effectiveConfidence = Math.max(
                    effectiveConfidence ?? 0,
                    wasmIsCorrect ? 0.95 : 0.85,
                  );
                  uploadAudioBlob = undefined;
                }
              }
            } catch {
              if (isStale()) {
                return;
              }
              // Proceed to backend evaluation cleanly if WASM decode fails.
            }
          }
        }

        const captured: CapturedAttemptPayload = {
          requestId: createRequestUuid(),
          audioBlob: uploadAudioBlob,
          durationMs: elapsed,
          audioQualityStatus: effectiveQualityStatus,
          browserTranscript: effectiveTranscript,
          browserConfidence: effectiveConfidence,
        };
        releaseStopLockIfOwned();
        await submitEvaluation(
          captured,
          generation,
          evalController,
          evaluationStart,
        );
      } finally {
        releaseStopLockIfOwned();
        releaseEvalControllerIfOwned();
      }
    },
    [
      clearTimers,
      contextPhrase,
      nextWordTarget,
      onClose,
      onSelectWord,
      phonicsLesson,
      playCue,
      retryTurn,
      runPhonicsGuidance,
      speechRecorder,
      stopBrowserRecognition,
      stopSelfPlayback,
      submitEvaluation,
      t,
      word.display_text,
      word.normalized_word,
    ],
  );

  const captureWordTurn = useCallback(
    async (generation: number) => {
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, SHORT_WORD_CAPTURE_CONFIG.acousticSettleMs),
      );
      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }

      const preferAndroidNativeStt = shouldPreferAndroidNativeStt();
      if (
        !sttWarmupAttemptedRef.current &&
        !preferAndroidNativeStt &&
        detectBrowserWasmSttSupport().supported &&
        !getBrowserWasmSttClient().isReady() &&
        !isBackendSttHealthyForPractice()
      ) {
        sttWarmupAttemptedRef.current = true;
        await awaitSttReadyBeforeListening(STT_WARMUP_WAIT_CAP_MS).catch(
          () => false,
        );
        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }
      }
      usingAndroidNativeSttRef.current = preferAndroidNativeStt;
      if (!preferAndroidNativeStt) {
        try {
          await speechRecorder.start({
            mode: SHORT_WORD_CAPTURE_CONFIG.mode,
            retainStream: false,
          });
        } catch (error) {
          if (!mountedRef.current || generation !== flowGenerationRef.current) {
            return;
          }
          setMicError(mapMicrophoneErrorMessage(error));
          setFlowState("PAUSED");
          return;
        }
      }

      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        speechRecorder.cancel({ retainStream: false });
        return;
      }

      setFlowState("LISTENING");
      setCoachCue(null);
      setEvaluationDurationMs(null);
      setLiveTranscript(null);
      setLatestResult(null);
      stopCaptureLockRef.current = false;
      browserCollectorRef.current.reset();
      browserBestConfRef.current = null;
      captureStartedAtRef.current = performance.now();
      speechObservedRef.current = false;
      browserPulseRef.current = false;
      silenceStartedAtRef.current = null;
      let prevSpeechDurationMs = 0;

      if (typeof window !== "undefined") {
        const win = window as unknown as WindowWithSpeechRecognition & {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const injectedCtor =
          win.SpeechRecognition || win.webkitSpeechRecognition;
        const allowParallelRecognition =
          preferAndroidNativeStt ||
          isInjectedTestSpeechRecognition(injectedCtor);
        const SpeechRec = allowParallelRecognition
          ? (resolveLocalFirstSpeechRecognitionConstructor(
              win as unknown as Parameters<
                typeof resolveLocalFirstSpeechRecognitionConstructor
              >[0],
              speechService,
              () => ({
                sessionId: practiceSessionLockId,
                keyterms: [word.display_text],
              }),
              () => speechRecorder.getStream()?.getAudioTracks()[0],
              {
                onBeforeExternalMicStart: () => {
                  usingAndroidNativeSttRef.current = true;
                  speechRecorder.cancel({ retainStream: false });
                },
              },
            ) as unknown as SpeechRecognitionConstructor | undefined)
          : undefined;
        if (SpeechRec) {
          try {
            const rec = new SpeechRec();
            rec.lang = "vi-VN";
            rec.continuous = true;
            rec.interimResults = true;
            rec.maxAlternatives = 1;
            rec.onresult = (event) => {
              if (
                !mountedRef.current ||
                generation !== flowGenerationRef.current ||
                recognitionRef.current !== rec
              ) {
                return;
              }
              const isLocalRec = rec instanceof LocalSegmentSpeechRecognition;
              let rejectedByQuality = false;
              const isFencedItem = (meta?: SegmentResultMeta): boolean => {
                if (!meta) return true;
                if (
                  isLocalRec &&
                  meta.epoch !== undefined &&
                  meta.epoch !== rec.getEpoch()
                ) {
                  return false;
                }
                if (
                  meta.sessionId !== undefined &&
                  meta.sessionId !== null &&
                  meta.sessionId !== practiceSessionLockId
                ) {
                  return false;
                }
                return true;
              };
              const isAcceptedPracticeSpeech = (
                text: string,
                onsetAt?: number | null,
              ) => {
                const normalizedOnset =
                  typeof onsetAt === "number" && Number.isFinite(onsetAt)
                    ? onsetAt
                    : null;
                const verdict = echoGuard.evaluate({
                  text,
                  receivedAt: performance.now(),
                  onsetAt: normalizedOnset,
                });
                if (verdict.accept) return true;
                if (
                  verdict.reason === "tail-overlap" &&
                  normalizedOnset === null &&
                  (isSpellingHelpRequest(text, word.display_text) ||
                    isReplaySampleRequest(text, word.display_text) ||
                    isWordHelpRequest(text, word.display_text) ||
                    text.normalize("NFC").trim().toLowerCase() ===
                      word.display_text.normalize("NFC").trim().toLowerCase() ||
                    (usedPhonicsRef.current &&
                      phonicsLesson.supported &&
                      evaluatePostPhonicsAttempt(text, phonicsLesson).kind ===
                        "SPELLING_STEP_ONLY"))
                ) {
                  return true;
                }
                return false;
              };
              const addedFinals = browserCollectorRef.current.addResults(
                event,
                (text, usable, _confidence, meta) => {
                  if (!isFencedItem(meta)) return false;
                  if (
                    meta?.audioQuality &&
                    (meta.audioQuality.status === "CLIPPING" ||
                      meta.audioQuality.status === "AUDIO_TOO_SHORT")
                  ) {
                    rejectedByQuality = true;
                    setFailureLabel("Nghe chưa rõ");
                    setCoachCue(
                      adaptTextToTeacherPersona(
                        "Cô chưa nghe rõ tiếng vừa rồi, con đọc lại nhé.",
                        getEffectiveTeacherPersona().gender,
                      ),
                    );
                    return false;
                  }
                  if (!usable) return false;
                  return isAcceptedPracticeSpeech(text, meta?.onsetAt);
                },
              );
              if (rejectedByQuality) {
                return;
              }
              if (addedFinals.length > 0) {
                speechObservedRef.current = true;
                browserPulseRef.current = true;
                silenceStartedAtRef.current = null;
              }
              let interimText = "";
              for (
                let i = event.resultIndex;
                i < event.results.length;
                i += 1
              ) {
                const item = event.results[
                  i
                ] as BrowserSpeechRecognitionEventLike["results"][number] &
                  SegmentResultMeta;
                if (!isFencedItem(item)) continue;
                const chunk = item?.[0]?.transcript?.trim() ?? "";
                const conf = item?.[0]?.confidence;
                if (!chunk || !hasUsableBrowserConfidence(conf)) continue;
                if (!isAcceptedPracticeSpeech(chunk, item?.onsetAt ?? null)) {
                  continue;
                }
                speechObservedRef.current = true;
                browserPulseRef.current = true;
                silenceStartedAtRef.current = null;
                if (item.isFinal && addedFinals.includes(chunk)) {
                  browserBestConfRef.current = Math.min(
                    browserBestConfRef.current ?? 1,
                    conf ?? 0,
                  );
                }
                if (!item.isFinal) {
                  interimText = chunk;
                }
              }
              const collected = browserCollectorRef.current.getTranscript();
              const displaySpeech = [collected, interimText]
                .filter(Boolean)
                .join(" ")
                .trim();
              if (displaySpeech) {
                setLiveTranscript(displaySpeech);
              }
            };
            rec.onerror = () => undefined;
            rec.onend = () => {
              if (recognitionRef.current === rec) recognitionRef.current = null;
            };
            recognitionRef.current = rec;
            const track = speechRecorder.getStream()?.getAudioTracks()[0];
            if (track) rec.start(track);
            else rec.start();
          } catch {
            recognitionRef.current = null;
          }
        }
      }

      const schedulePoll = () => {
        pollTimeoutRef.current = window.setTimeout(() => {
          pollTimeoutRef.current = null;
          if (!mountedRef.current || generation !== flowGenerationRef.current) {
            return;
          }
          const now = performance.now();
          const elapsedMs = now - captureStartedAtRef.current;
          const quality = speechRecorder.getQuality?.();
          const browserPulse = browserPulseRef.current;
          browserPulseRef.current = false;
          const active = hasShortWordSpeechActivity({
            isSpeakingNow: speechRecorder.getIsSpeaking(),
            audioLevel:
              speechRecorder.getAudioLevel?.() ?? speechRecorder.audioLevel,
            quality,
            hasLiveBrowserSpeech: browserPulse,
            speechObserved: speechObservedRef.current,
            previousSpeechDurationMs: prevSpeechDurationMs,
          });
          prevSpeechDurationMs =
            quality?.speechDurationMs ?? prevSpeechDurationMs;
          if (active) {
            speechObservedRef.current = true;
            silenceStartedAtRef.current = null;
          } else if (
            speechObservedRef.current &&
            silenceStartedAtRef.current === null
          ) {
            silenceStartedAtRef.current = now;
          }

          const silenceElapsedMs =
            silenceStartedAtRef.current === null
              ? 0
              : now - silenceStartedAtRef.current;

          if (
            shouldAutoStopShortWordCapture({
              elapsedMs,
              speechObserved: speechObservedRef.current,
              silenceElapsedMs,
              config: phraseTurnRef.current ? PHRASE_CAPTURE_CONFIG : undefined,
            })
          ) {
            void finalizeCaptureAndEvaluate(generation);
            return;
          }
          schedulePoll();
        }, SHORT_WORD_CAPTURE_CONFIG.pollIntervalMs);
      };
      schedulePoll();
    },
    [
      echoGuard,
      finalizeCaptureAndEvaluate,
      phonicsLesson,
      practiceSessionLockId,
      speechRecorder,
      speechService,
      word.display_text,
    ],
  );

  useEffect(() => {
    captureTurnRef.current = captureWordTurn;
  }, [captureWordTurn]);

  const startHandsFreePractice = useCallback(async () => {
    const generation = ++flowGenerationRef.current;
    evaluationRef.current?.abort();
    evaluationRef.current = null;
    clearTimers();
    stopBrowserRecognition();
    speechPlayer.stop();
    stopSelfPlayback();
    autoRetryCountRef.current = 0;
    incorrectCountRef.current = 0;
    heardFailuresRef.current = 0;
    phraseTurnRef.current = false;
    setPhraseTurn(false);
    setPhraseAttemptFailed(false);
    silenceStreakRef.current = 0;
    helpRoundsRef.current = 0;
    usedHintRef.current = false;
    usedPhonicsRef.current = false;
    setActivePhonicsStep(null);
    setIsPlayingPhonics(false);
    setMasteryOutcome(null);
    setRetryLoopPaused(false);
    setFailureLabel(null);
    setSampleError(null);
    setMicError(null);
    setSubmitError(null);
    setPendingSavePayload(null);
    setRecordedBlob(null);
    setLatestResult(null);
    setLiveTranscript(null);
    browserCollectorRef.current.reset();
    browserBestConfRef.current = null;
    stopCaptureLockRef.current = false;

    setFlowState("PREPARING");
    void speechPlayer.prefetch?.("Con đọc từ trên màn hình nhé.", {
      coaching: true,
    });
    void speechPlayer.prefetch?.(word.display_text, {
      wordSample: true,
    });
    let pendingWasmWarmup = false;
    if (shouldPreferAndroidNativeStt()) {
      micPreparedRef.current = true;
      sttWarmupAttemptedRef.current = true;
    } else {
      if (
        detectBrowserWasmSttSupport().supported &&
        !getBrowserWasmSttClient().isReady() &&
        !isBackendSttHealthyForPractice()
      ) {
        // Kick off WASM warmup in parallel with mic prep & teacher instruction
        // instead of blocking before speaking the cue.
        pendingWasmWarmup = true;
        void awaitSttReadyBeforeListening(STT_WARMUP_WAIT_CAP_MS).catch(
          () => false,
        );
      }
      sttWarmupAttemptedRef.current = true;
      try {
        await speechRecorder.prepare();
        micPreparedRef.current = true;
      } catch (error) {
        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }
        setMicError(mapMicrophoneErrorMessage(error));
        setFlowState("PAUSED");
        return;
      }
    }

    if (!mountedRef.current || generation !== flowGenerationRef.current) {
      speechRecorder.cancel();
      return;
    }

    setFlowState("INSTRUCTING");
    await playCue("Con đọc từ trên màn hình nhé.", generation);

    if (!mountedRef.current || generation !== flowGenerationRef.current) {
      return;
    }

    if (pendingWasmWarmup && !getBrowserWasmSttClient().isReady()) {
      await awaitSttReadyBeforeListening(STT_WARMUP_WAIT_CAP_MS).catch(
        () => false,
      );
      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }
    }

    await captureWordTurn(generation);
  }, [
    captureWordTurn,
    clearTimers,
    playCue,
    speechPlayer,
    speechRecorder,
    stopBrowserRecognition,
    stopSelfPlayback,
    word.display_text,
  ]);

  function handlePauseSession(): void {
    flowGenerationRef.current += 1;
    cleanupRef.current();
    setFlowState("PAUSED");
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const isSmallScreen =
      window.innerWidth < 768 ||
      Boolean(window.matchMedia?.("(max-width: 767px)").matches);
    if (!isSmallScreen) return;
    if (
      flowState === "PREPARING" ||
      flowState === "INSTRUCTING" ||
      flowState === "LISTENING"
    ) {
      wordCardRef.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [flowState, word.normalized_word]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isPlayingPhonics && activePhonicsStep === null) return;
    const isSmallScreen =
      window.innerWidth < 768 ||
      Boolean(window.matchMedia?.("(max-width: 767px)").matches);
    if (!isSmallScreen) return;
    phonicsCardRef.current?.scrollIntoView?.({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activePhonicsStep, isPlayingPhonics]);

  useEffect(() => {
    if (!autoStart || didAutoStartRef.current) return;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current || didAutoStartRef.current) return;
      didAutoStartRef.current = true;
      void startHandsFreePractice();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, startHandsFreePractice]);

  async function handlePlaySample(): Promise<void> {
    const generation = ++flowGenerationRef.current;
    clearTimers();
    stopBrowserRecognition();
    speechRecorder.cancel({ retainStream: false });
    setSampleError(null);
    stopSelfPlayback();
    usedHintRef.current = true;
    const playbackId = `practice-sample-${(playbackSeqRef.current += 1)}`;
    echoGuard.playbackStarted(playbackId, word.display_text, performance.now());
    try {
      await withRequestDeadline(
        () =>
          speechPlayer.play(word.display_text, {
            wordSample: true,
            bypassSessionLock: true,
            bookId: primarySource?.book_id ?? null,
            pageId: primarySource?.page_id ?? null,
            pageRevisionId: primarySource?.page_revision_id ?? null,
            isPrivateBook: isPrivateBookSource,
            cacheScope: isPrivateBookSource ? "PRIVATE" : "CATALOG",
          }),
        undefined,
        CUE_TIMEOUT_MS,
      );
      if (
        micPreparedRef.current &&
        mountedRef.current &&
        generation === flowGenerationRef.current
      ) {
        await captureWordTurn(generation);
      }
    } catch {
      if (mountedRef.current && generation === flowGenerationRef.current) {
        speechPlayer.stop();
        setSampleError(t("practice.sampleErrorDevice"));
      }
    } finally {
      echoGuard.playbackEnded(playbackId, performance.now());
    }
  }

  function handlePlayPhonics(): void {
    const generation = ++flowGenerationRef.current;
    clearTimers();
    void runPhonicsGuidance(generation, micPreparedRef.current);
  }

  function handleStopPhonicsOrSample(): void {
    flowGenerationRef.current += 1;
    clearTimers();
    speechPlayer.stop();
    setIsPlayingPhonics(false);
    setFlowState("IDLE");
  }

  async function handlePlaySelfRecording(): Promise<void> {
    if (!recordedBlob) return;
    flowGenerationRef.current += 1;
    clearTimers();
    speechPlayer.stop();
    await toggleSelfPlayback(recordedBlob);
  }

  const stageThemeClass =
    flowState === "SUCCESS"
      ? "border-emerald-300 bg-emerald-50"
      : flowState === "LISTENING" || flowState === "EVALUATING"
        ? "border-amber-300 bg-warning-surface/70"
        : failureLabel === "Đọc sai" &&
            (flowState === "INSTRUCTING" || flowState === "NEEDS_RETRY")
          ? "border-orange-300 bg-orange-50/90"
          : flowState === "NEEDS_RETRY" || flowState === "TECHNICAL_ERROR"
            ? "border-warning/30 bg-warning-surface"
            : "border-border bg-cream";

  const failureDisplay = failureLabel
    ? FAILURE_LABEL_KEYS[failureLabel]
      ? t(FAILURE_LABEL_KEYS[failureLabel])
      : failureLabel
    : null;

  const formatPracticeTimestamp = (isoValue: string | null | undefined) => {
    if (!isoValue) return t("practice.timeMissing");
    const parsed = new Date(isoValue);
    if (Number.isNaN(parsed.getTime())) return t("practice.timeInvalid");
    return formatDateTime(parsed, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: REPORT_TIMEZONE,
    });
  };

  const stageLabel =
    flowState === "SUCCESS"
      ? t("practice.stageCorrect")
      : flowState === "PREPARING"
        ? t("practice.stagePreparing")
        : flowState === "INSTRUCTING"
          ? t("practice.stageInstructing")
          : speechPlayer.isPlaying
            ? t("practice.stageSample")
            : flowState === "LISTENING"
              ? t("practice.stageListening")
              : flowState === "EVALUATING" || flowState === "SAVING"
                ? t("practice.stageEvaluating")
                : flowState === "NEEDS_RETRY" || flowState === "TECHNICAL_ERROR"
                  ? (failureDisplay ?? t("practice.stageRetry"))
                  : t("practice.stageIdle", { alias: child.alias });

  const statusBadgeClass = PRACTICE_STATUS_CLASSES[effectiveStatus];
  const isBusyActive =
    flowState === "PREPARING" ||
    flowState === "INSTRUCTING" ||
    flowState === "LISTENING" ||
    flowState === "EVALUATING" ||
    flowState === "SAVING";

  return (
    <section
      aria-labelledby="practice-word-heading"
      className="mx-auto flex w-full max-w-[780px] flex-col gap-5 rounded-card border border-border bg-white p-5 shadow-sm sm:gap-6 sm:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border pb-3.5 sm:gap-3 sm:pb-4">
        <Button
          className="min-h-12 sm:w-auto"
          onClick={() => {
            flowGenerationRef.current += 1;
            cleanupRef.current();
            onClose();
          }}
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
          {t("practice.backToList")}
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <VoiceEngineBadge compact />
          <ReadingVoiceSettings
            childId={child.id}
            disabled={flowState === "LISTENING"}
            fallbackNotice={speechPlayer.fallbackNotice}
            isPreviewing={speechPlayer.isPlaying && !speechPlayer.isPaused}
            onOpen={() => {
              flowGenerationRef.current += 1;
              cleanupRef.current();
              setIsPlayingPhonics(false);
              setFlowState((prev) =>
                prev === "LISTENING" ||
                prev === "INSTRUCTING" ||
                prev === "EVALUATING"
                  ? "IDLE"
                  : prev,
              );
            }}
            onPreview={(sample) => {
              flowGenerationRef.current += 1;
              clearTimers();
              stopBrowserRecognition();
              speechPlayer.stop();
              return speechPlayer.play(sample, {
                coaching: true,
                cacheScope: "COACHING",
                isPrivateBook: false,
                bypassSessionLock: true,
                utteranceKind: "voice_preview",
              });
            }}
            onStopPreview={() => {
              flowGenerationRef.current += 1;
              clearTimers();
              speechPlayer.stop();
            }}
          />
          {wordIndexInQueue >= 0 ? (
            <span className="rounded-full bg-surface-subtle px-3 py-1 text-xs font-bold text-muted">
              {t("practice.wordPosition", {
                current: wordIndexInQueue + 1,
                total: words.length,
              })}
            </span>
          ) : null}
          <span
            className={`rounded-full border px-3 py-1 text-xs font-extrabold ${statusBadgeClass}`}
          >
            {t(PRACTICE_STATUS_KEYS[effectiveStatus])}
          </span>
        </div>
      </div>

      {primarySource?.book_title ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <BookOpen aria-hidden="true" className="size-4 text-primary" />
          <span
            className="viread-learning-content font-bold text-ink"
            dir="ltr"
            lang="vi"
          >
            {primarySource.book_title}
          </span>
          {primarySource.page_number ? (
            <span>
              {t("practice.pageNumber", { page: primarySource.page_number })}
            </span>
          ) : null}
          {primarySource.context_phrase ? (
            <span
              className="viread-learning-content rounded-control bg-surface-subtle px-2.5 py-0.5 text-xs italic text-muted"
              dir="ltr"
              lang="vi"
            >
              “{primarySource.context_phrase}”
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={wordCardRef}
        data-capture-ms={latestResult?.audio_duration_ms ?? undefined}
        data-evaluation-ms={evaluationDurationMs ?? undefined}
        className={`flex flex-col items-center gap-4 rounded-card border px-5 py-6 text-center transition-colors sm:py-8 ${stageThemeClass}`}
      >
        <p className="text-sm font-extrabold text-primary" aria-live="polite">
          {stageLabel}
        </p>

        {failureDisplay && flowState !== "SUCCESS" ? (
          <span className="rounded-full border border-warning/30 bg-white/90 px-3 py-0.5 text-xs font-extrabold text-ink">
            {failureDisplay}
          </span>
        ) : null}
        {phraseTurn && contextPhrase && flowState !== "SUCCESS" ? (
          <p
            className="viread-learning-content rounded-control bg-white px-4 py-2 text-xl font-bold text-ink"
            dir="ltr"
            lang="vi"
          >
            {contextPhrase}
          </p>
        ) : null}

        <h2
          className="viread-learning-content text-5xl font-black tracking-tight text-ink sm:text-6xl"
          dir="ltr"
          id="practice-word-heading"
          lang="vi"
        >
          {word.display_text}
        </h2>

        <p aria-live="polite" className="max-w-md text-base font-bold text-ink">
          {flowState === "PREPARING"
            ? t("practice.promptPreparing")
            : flowState === "INSTRUCTING"
              ? adaptTextToTeacherPersona(
                  coachCue ?? t("practice.promptInstructingFallback"),
                  teacherPersona.gender,
                )
              : flowState === "LISTENING"
                ? phraseTurn
                  ? t("practice.promptListeningPhrase")
                  : t("practice.promptListeningWord")
                : flowState === "EVALUATING" || flowState === "SAVING"
                  ? t("practice.promptEvaluating")
                  : flowState === "SUCCESS"
                    ? latestResult?.feedback_message
                      ? adaptTextToTeacherPersona(
                          latestResult.feedback_message,
                          teacherPersona.gender,
                        )
                      : VOICE_PROMPTS.correctPraise()
                    : flowState === "NEEDS_RETRY"
                      ? phraseAttemptFailed
                        ? t("practice.promptPhraseFailed")
                        : retryLoopPaused
                          ? t("practice.promptLoopPaused", {
                              prefix: failureDisplay
                                ? `${failureDisplay}. `
                                : "",
                            })
                          : latestResult?.feedback_message
                            ? adaptTextToTeacherPersona(
                                latestResult.feedback_message,
                                teacherPersona.gender,
                              )
                            : VOICE_PROMPTS.retryGentle(word.display_text)
                      : flowState === "TECHNICAL_ERROR"
                        ? latestResult?.feedback_message
                          ? adaptTextToTeacherPersona(
                              latestResult.feedback_message,
                              teacherPersona.gender,
                            )
                          : VOICE_PROMPTS.technicalFallback()
                        : flowState === "PAUSED"
                          ? t("practice.promptPaused")
                          : t("practice.promptIdle")}
        </p>

        {isEvaluatingPronunciation ? (
          <div className="w-full max-w-md">
            <AiProgressBar
              active
              label={
                evalProgress.stageLabel ??
                tCommon("aiProgress.evaluatingAnswer")
              }
              percent={evalProgress.percent}
              size="compact"
              testId="practice-evaluating-progress"
            />
          </div>
        ) : isPlayingPhonics ? (
          <div className="w-full max-w-md">
            <AiProgressBar
              active
              label={
                phonicsProgress.stageLabel ??
                tCommon("aiProgress.synthesizingVoice")
              }
              percent={phonicsProgress.percent}
              size="compact"
              testId="practice-phonics-progress"
            />
          </div>
        ) : null}

        {latestResult?.spoken_transcript ? (
          <p className="rounded-full bg-white/85 px-4 py-1 text-sm font-semibold text-[#526970]">
            {t("practice.heardFinalPrefix")}
            <span className="viread-learning-content" dir="ltr" lang="vi">
              “{latestResult.spoken_transcript}”
            </span>
          </p>
        ) : liveTranscript ? (
          <p className="rounded-full bg-white/85 px-4 py-1 text-sm font-semibold text-[#526970]">
            {t("practice.heardLivePrefix")}
            <span className="viread-learning-content" dir="ltr" lang="vi">
              “{liveTranscript}”
            </span>
          </p>
        ) : null}

        {flowState === "SUCCESS" ? (
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-extrabold text-white">
            <CheckCircle2 aria-hidden="true" className="size-4" />
            {t("practice.wordCompletedBadge")}
          </div>
        ) : null}

        {masteryOutcome ? (
          <span
            className="rounded-full border border-[#DCE8E4] bg-white px-3.5 py-1 text-xs font-extrabold text-[#147D87]"
            data-mastery-outcome={masteryOutcome}
            data-testid="word-mastery-outcome"
          >
            {t(`practice.mastery.${masteryOutcome}`)}
          </span>
        ) : null}
      </div>

      <div ref={phonicsCardRef}>
        <PhonicsLessonCard
          activeStepIndex={activePhonicsStep}
          isAnalyzingAi={isAnalyzingPhonicsAi}
          isListeningRetry={flowState === "LISTENING"}
          isPlayingPhonics={isPlayingPhonics}
          isPlayingWord={speechPlayer.isPlaying && !isPlayingPhonics}
          lesson={phonicsLesson}
          onPlayPhonics={handlePlayPhonics}
          onPlayWord={() => void handlePlaySample()}
          onStartRetry={() => void startHandsFreePractice()}
          onStopAudio={handleStopPhonicsOrSample}
        />
      </div>

      {sampleError ? (
        <StatusMessage tone="warning">{sampleError}</StatusMessage>
      ) : null}
      {micError ? (
        <StatusMessage tone="warning">{micError}</StatusMessage>
      ) : null}
      {playbackError ? (
        <StatusMessage tone="warning">{playbackError}</StatusMessage>
      ) : null}
      {submitError ? (
        <StatusMessage tone="warning">
          <div className="flex flex-col gap-3">
            <span>{submitError}</span>
            {pendingSavePayload ? (
              <Button
                className="sm:w-auto sm:self-start"
                onClick={() => {
                  const gen = flowGenerationRef.current;
                  void submitEvaluation(pendingSavePayload, gen);
                }}
                variant="secondary"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                {t("practice.saveResultAction")}
              </Button>
            ) : null}
          </div>
        </StatusMessage>
      ) : null}

      <div className="flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:flex-wrap">
        {flowState === "LISTENING" ? (
          <>
            <Button
              className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
              onClick={() =>
                void finalizeCaptureAndEvaluate(flowGenerationRef.current)
              }
              variant="primary"
            >
              <Square aria-hidden="true" className="size-5 fill-current" />
              {t("practice.stopRecording")}
            </Button>
            <Button
              className="min-h-14 rounded-2xl sm:w-auto"
              onClick={handlePauseSession}
              variant="secondary"
            >
              <Pause aria-hidden="true" className="size-4" />
              {t("practice.pause")}
            </Button>
          </>
        ) : flowState === "PREPARING" ||
          flowState === "INSTRUCTING" ||
          flowState === "EVALUATING" ||
          flowState === "SAVING" ? (
          <Button
            className="min-h-14 rounded-2xl sm:w-auto"
            onClick={handlePauseSession}
            variant="secondary"
          >
            <Pause aria-hidden="true" className="size-4" />
            {t("practice.pause")}
          </Button>
        ) : flowState === "SUCCESS" ? (
          <>
            {nextWordTarget &&
            nextWordTarget.normalized_word !== word.normalized_word ? (
              <Button
                className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
                onClick={() => {
                  clearTimers();
                  onSelectWord(nextWordTarget.normalized_word, {
                    autoStart: true,
                  });
                }}
              >
                <Sparkles aria-hidden="true" className="size-5" />
                {t("practice.nextWordWithText", {
                  word: nextWordTarget.display_text,
                })}
                <ArrowRight
                  aria-hidden="true"
                  className="viread-rtl-flip size-4"
                />
              </Button>
            ) : (
              <Button
                className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
                onClick={() => {
                  clearTimers();
                  onClose();
                }}
              >
                <CheckCircle2 aria-hidden="true" className="size-5" />
                {t("practice.finishPractice")}
              </Button>
            )}
            <Button
              className="min-h-14 rounded-2xl sm:w-auto"
              onClick={() => void startHandsFreePractice()}
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              {t("practice.rereadWord")}
            </Button>
          </>
        ) : flowState === "NEEDS_RETRY" && retryLoopPaused ? (
          <>
            <Button
              className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
              onClick={() => void startHandsFreePractice()}
            >
              <Mic aria-hidden="true" className="size-5" />
              {t("practice.continueTry")}
            </Button>
            {nextWordTarget &&
            nextWordTarget.normalized_word !== word.normalized_word ? (
              <Button
                className="min-h-14 rounded-2xl sm:w-auto"
                onClick={() => {
                  handlePauseSession();
                  onSelectWord(nextWordTarget.normalized_word, {
                    autoStart: true,
                  });
                }}
                variant="secondary"
              >
                {t("practice.nextWord")}
              </Button>
            ) : null}
            <Button
              className="min-h-14 rounded-2xl sm:w-auto"
              onClick={() => {
                handlePauseSession();
                void handlePlaySample();
              }}
              variant="secondary"
            >
              {t("practice.askParentHelp")}
            </Button>
          </>
        ) : (
          <Button
            className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
            onClick={() => void startHandsFreePractice()}
          >
            <Mic aria-hidden="true" className="size-5" />
            {flowState === "PAUSED"
              ? t("practice.resumePractice")
              : flowState === "NEEDS_RETRY" || flowState === "TECHNICAL_ERROR"
                ? t("practice.retryWord")
                : t("practice.startPractice")}
          </Button>
        )}

        <Button
          className="min-h-14 rounded-2xl sm:w-auto"
          disabled={isBusyActive}
          onClick={() => void handlePlaySample()}
          variant="secondary"
        >
          <Volume2 aria-hidden="true" className="size-5" />
          {t("practice.listenSample")}
        </Button>

        <Button
          className="min-h-14 rounded-2xl sm:w-auto"
          data-testid="practice-open-micro-story-cta"
          disabled={isBusyActive}
          onClick={() => {
            flowGenerationRef.current += 1;
            cleanupRef.current();
            setFlowState("IDLE");
            setShowMicroStoryModal(true);
          }}
          variant="secondary"
        >
          <Sparkles aria-hidden="true" className="size-4 text-primary" />
          {tMicroStory("ctaButton")}
        </Button>

        <Button
          className="min-h-14 rounded-2xl sm:w-auto"
          data-testid="practice-open-tai-thinh-cta"
          disabled={isBusyActive}
          onClick={() => {
            flowGenerationRef.current += 1;
            cleanupRef.current();
            setFlowState("IDLE");
            setShowEarTrainerModal(true);
          }}
          variant="secondary"
        >
          <Ear aria-hidden="true" className="size-4 text-primary" />
          {tDialect("practiceDialectBtn")}
        </Button>

        {recordedBlob ? (
          <Button
            className="min-h-14 rounded-2xl sm:w-auto"
            disabled={isBusyActive}
            onClick={() => void handlePlaySelfRecording()}
            variant="quiet"
          >
            <Play aria-hidden="true" className="size-4" />
            {isPlayingSelf
              ? t("practice.stopSelfPlayback")
              : t("practice.playSelfPlayback")}
          </Button>
        ) : null}
      </div>

      <details className="rounded-2xl border border-[#DCE8E4] bg-[#F6FAF8] px-4 py-3 text-sm">
        <summary className="cursor-pointer font-bold text-[#213C42]">
          {t("practice.historySummary", { count: historyItems.length })}
        </summary>
        <div className="mt-3 border-t border-[#DCE8E4] pt-3">
          {historyLoading ? (
            <p className="text-xs text-[#526970]">
              {t("practice.historyLoading")}
            </p>
          ) : !historyStorageReady && historyItems.length === 0 ? (
            <p className="text-xs text-[#526970]">
              {t("practice.historyUnavailable")}
            </p>
          ) : historyItems.length === 0 ? (
            <p className="text-xs text-[#526970]">
              {t("practice.historyEmpty")}
            </p>
          ) : (
            <>
              <ul className="space-y-1.5 text-xs text-[#526970]">
                {(() => {
                  const totalHistoryPages = Math.max(
                    1,
                    Math.ceil(historyItems.length / HISTORY_PAGE_SIZE),
                  );
                  const safeHistoryPage = Math.min(
                    Math.max(1, historyPage),
                    totalHistoryPages,
                  );
                  return historyItems
                    .slice(
                      (safeHistoryPage - 1) * HISTORY_PAGE_SIZE,
                      safeHistoryPage * HISTORY_PAGE_SIZE,
                    )
                    .map((item) => (
                      <li
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3 py-2"
                        key={item.attempt_id}
                      >
                        <span className="font-bold text-[#213C42]">
                          {t("practice.attemptNumber", {
                            number: item.attempt_number,
                          })}
                          {item.assessment_status
                            ? t(ASSESSMENT_LABEL_KEYS[item.assessment_status])
                            : t("practice.attemptInProgress")}
                        </span>
                        <span>
                          {item.spoken_transcript ? (
                            <>
                              <span
                                className="viread-learning-content"
                                dir="ltr"
                                lang="vi"
                              >
                                “{item.spoken_transcript}”
                              </span>
                              {" · "}
                            </>
                          ) : (
                            ""
                          )}
                          {formatPracticeTimestamp(
                            item.completed_at ?? item.started_at,
                          )}
                        </span>
                      </li>
                    ));
                })()}
              </ul>
              <PaginationBar
                className="mt-2.5"
                compact
                onPageChange={setHistoryPage}
                page={Math.min(
                  Math.max(1, historyPage),
                  Math.max(
                    1,
                    Math.ceil(historyItems.length / HISTORY_PAGE_SIZE),
                  ),
                )}
                pageSize={HISTORY_PAGE_SIZE}
                total={historyItems.length}
              />
            </>
          )}
        </div>
      </details>

      <details
        className="rounded-2xl border border-amber-200/80 bg-amber-50/40 px-4 py-3 text-sm"
        data-testid="practice-regional-profile-details"
      >
        <summary className="cursor-pointer font-bold text-[#213C42]">
          {tDialect("practiceProfileToggle")}
        </summary>
        <div className="mt-3">
          <RegionalPhoneticProfileCard
            childAlias={child.alias}
            childId={child.id}
            compact
            onOpenEarTrainer={() => setShowEarTrainerModal(true)}
          />
        </div>
      </details>

      <CreateMicroStoryModal
        child={child}
        isOpen={showMicroStoryModal}
        onClose={() => setShowMicroStoryModal(false)}
      />

      <TaiThinhEarTrainerModal
        childAlias={child.alias}
        childId={child.id}
        isOpen={showEarTrainerModal}
        onClose={() => setShowEarTrainerModal(false)}
        speechPlayer={speechPlayer}
        speechService={speechService}
      />
    </section>
  );
}
