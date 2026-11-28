"use client";

import {
  ArrowLeft,
  BookHeart,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eraser,
  Eye,
  EyeOff,
  History,
  ImagePlus,
  Lightbulb,
  Mic,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  Images,
  LoaderCircle,
  Sparkles,
  Square,
  Star,
  TrendingUp,
  Upload,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { VocabularyNotebookDrawer } from "@/components/reading/vocabulary-notebook-drawer";
import { useAiProgress } from "@/hooks/use-ai-progress";
import {
  getEntertainmentPreferences,
  subscribeEntertainmentPreferences,
  useEntertainmentPreferences,
} from "@/hooks/use-entertainment-preferences";
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
} from "@/lib/reading/browser-wasm-stt";
import {
  isInjectedTestSpeechRecognition,
  resolveLocalFirstSpeechRecognitionConstructor,
  shouldPreferAndroidNativeStt,
} from "@/lib/reading/local-segment-speech-recognition";
import { useTranslations } from "@/hooks/use-i18n";
import { usePictureDescriptionService } from "@/hooks/use-picture-description-service";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import {
  createVocabularyNotebookService,
  type VocabularyNotebookListDTO,
  type VocabularyNotebookService,
} from "@/lib/api/vocabulary-notebook-service";
import { useWordGlossaryTranslations } from "@/messages/features/word_glossary";
import {
  BrowserTranscriptCollector,
  type BrowserRecognitionEventLike,
} from "@/lib/reading/browser-transcript-collector";
import {
  getEffectiveTeacherPersona,
  getVoicePolicyPreferences,
  lockSessionVoice,
  releaseSessionVoiceLock,
} from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import {
  isConfirmedSilentVoiceCapture,
  isServerSttConfirmedUnavailable,
  refreshVoiceHealthQuietlyAfterSttFailure,
} from "@/lib/reading/voice-capture-guard";
import { preloadReadingVoiceEngines } from "@/lib/reading/voice-preloader";
import { createCountdownSound } from "@/lib/karaoke/countdown-sound";
import {
  getVoiceEngineHealthForRouting,
  isPermanentlyHostedLocalUnconfigured,
  markHostedLocalUnconfigured,
  recordSttEngineUsage,
} from "@/lib/reading/voice-engine-status";
import { cn } from "@/lib/utils/cn";
import {
  TTS_MIC_COOLDOWN_MS,
  countMeaningfulWords,
  formatCountdownSeconds,
  resolveAllowedQueryParam,
  resolveAutoPlayFlag,
} from "@/lib/entertainment/autopilot";
import type {
  PictureAttemptDTO,
  PictureBookPageItemDTO,
  PictureCatalogDTO,
  PictureInputMode,
  PictureSampleItemDTO,
  PictureScaffoldingStep,
  PictureSessionDTO,
  PictureSessionSummaryDTO,
  PictureTeachingMode,
} from "@/types/picture-description";

type SourceTab = "SAMPLE" | "CUSTOM_UPLOAD" | "BOOK_PAGE";
type PracticeTab = "PRACTICE" | "RESULT";
type CatalogState =
  | { status: "loading" }
  | {
      status: "ready";
      catalog: PictureCatalogDTO;
      sessions: PictureSessionSummaryDTO[];
    }
  | { status: "error"; message: string };

interface BrowserSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognitionLike;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DUPLICATE_SUBMIT_WINDOW_MS = 1500;
const SILENCE_AUTO_SUBMIT_MS = 2200;
const SILENCE_COUNTDOWN_TICK_MS = 100;

const TEACHING_MODE_SPECS: readonly {
  readonly id: PictureTeachingMode;
  readonly labelKey: string;
  readonly cueKey: string;
  readonly audioHintKey: string;
}[] = [
  {
    id: "OBSERVE",
    labelKey: "pictureDescription.teachingModes.OBSERVE.label",
    cueKey: "pictureDescription.teachingModes.OBSERVE.cue",
    audioHintKey: "pictureDescription.teachingModes.OBSERVE.audioHint",
  },
  {
    id: "VOCABULARY",
    labelKey: "pictureDescription.teachingModes.VOCABULARY.label",
    cueKey: "pictureDescription.teachingModes.VOCABULARY.cue",
    audioHintKey: "pictureDescription.teachingModes.VOCABULARY.audioHint",
  },
  {
    id: "SENTENCE",
    labelKey: "pictureDescription.teachingModes.SENTENCE.label",
    cueKey: "pictureDescription.teachingModes.SENTENCE.cue",
    audioHintKey: "pictureDescription.teachingModes.SENTENCE.audioHint",
  },
  {
    id: "STORY",
    labelKey: "pictureDescription.teachingModes.STORY.label",
    cueKey: "pictureDescription.teachingModes.STORY.cue",
    audioHintKey: "pictureDescription.teachingModes.STORY.audioHint",
  },
  {
    id: "INFER",
    labelKey: "pictureDescription.teachingModes.INFER.label",
    cueKey: "pictureDescription.teachingModes.INFER.cue",
    audioHintKey: "pictureDescription.teachingModes.INFER.audioHint",
  },
  {
    id: "CREATE",
    labelKey: "pictureDescription.teachingModes.CREATE.label",
    cueKey: "pictureDescription.teachingModes.CREATE.cue",
    audioHintKey: "pictureDescription.teachingModes.CREATE.audioHint",
  },
] as const;

const TEACHING_MODE_SPEC_BY_ID: Record<
  PictureTeachingMode,
  (typeof TEACHING_MODE_SPECS)[number]
> = {
  OBSERVE: TEACHING_MODE_SPECS[0],
  VOCABULARY: TEACHING_MODE_SPECS[1],
  SENTENCE: TEACHING_MODE_SPECS[2],
  STORY: TEACHING_MODE_SPECS[3],
  INFER: TEACHING_MODE_SPECS[4],
  CREATE: TEACHING_MODE_SPECS[5],
};

const SCAFFOLDING_STEP_KEYS: Record<PictureScaffoldingStep, string> = {
  PROMPT: "pictureDescription.scaffoldingSteps.PROMPT",
  EXPAND: "pictureDescription.scaffoldingSteps.EXPAND",
  PRAISE: "pictureDescription.scaffoldingSteps.PRAISE",
  NEXT_CHALLENGE: "pictureDescription.scaffoldingSteps.NEXT_CHALLENGE",
};

const GRADE_1_2_VISUAL_HINT_CHIPS = [
  { id: "who", badge: "1", textKey: "pictureDescription.visualHintChips.who" },
  {
    id: "action",
    badge: "2",
    textKey: "pictureDescription.visualHintChips.action",
  },
  {
    id: "where",
    badge: "3",
    textKey: "pictureDescription.visualHintChips.where",
  },
] as const;

const STORYTELLING_STEPS = [
  {
    step: "1",
    titleKey: "pictureDescription.storySteps.step1Title",
    detailKey: "pictureDescription.storySteps.step1Detail",
  },
  {
    step: "2",
    titleKey: "pictureDescription.storySteps.step2Title",
    detailKey: "pictureDescription.storySteps.step2Detail",
  },
  {
    step: "3",
    titleKey: "pictureDescription.storySteps.step3Title",
    detailKey: "pictureDescription.storySteps.step3Detail",
  },
] as const;

function normalizeSpeechUnit(value: string): string {
  return value
    .trim()
    .replace(/[.!?,;:…]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizedContainsTerm(normalizedDesc: string, term: string): boolean {
  if (!normalizedDesc) return false;
  const normalizedTerm = normalizeSpeechUnit(term);
  if (!normalizedTerm) return false;
  return ` ${normalizedDesc} `.includes(` ${normalizedTerm} `);
}

function descriptionContainsTerm(description: string, term: string): boolean {
  return normalizedContainsTerm(normalizeSpeechUnit(description), term);
}

function collapseDuplicateSpeech(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const dedupedSentences: string[] = [];
  for (const sentence of sentences) {
    const prev = dedupedSentences[dedupedSentences.length - 1];
    if (prev && normalizeSpeechUnit(prev) === normalizeSpeechUnit(sentence)) {
      continue;
    }
    dedupedSentences.push(sentence);
  }

  const tokens = dedupedSentences.join(" ").split(" ").filter(Boolean);
  const resultTokens: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    let matchedRepeat = false;
    const maxWindow = Math.min(6, resultTokens.length, tokens.length - index);
    for (let windowSize = maxWindow; windowSize >= 2; windowSize -= 1) {
      const previousSlice = resultTokens
        .slice(-windowSize)
        .map(normalizeSpeechUnit)
        .join(" ");
      const nextSlice = tokens
        .slice(index, index + windowSize)
        .map(normalizeSpeechUnit)
        .join(" ");
      if (previousSlice && previousSlice === nextSlice) {
        index += windowSize;
        matchedRepeat = true;
        break;
      }
    }
    if (!matchedRepeat) {
      resultTokens.push(tokens[index]);
      index += 1;
    }
  }

  return resultTokens.join(" ").trim();
}

function collectLiveTranscript(
  collector: BrowserTranscriptCollector,
  event: BrowserRecognitionEventLike,
): string {
  const finalized = collector.getTranscript();
  const interimParts: string[] = [];
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    if (result && !result.isFinal) {
      const piece = result[0]?.transcript?.trim();
      if (piece) interimParts.push(piece);
    }
  }
  return collapseDuplicateSpeech(
    [finalized, ...interimParts].filter(Boolean).join(" "),
  );
}

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const record = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return record.SpeechRecognition ?? record.webkitSpeechRecognition ?? null;
}

type TranslateFn = ReturnType<typeof useTranslations>;

function sourceLabel(
  source: PictureSessionSummaryDTO["source_type"],
  t: TranslateFn,
): string {
  switch (source) {
    case "BOOK_PAGE":
      return t("pictureDescription.sources.BOOK_PAGE");
    case "CUSTOM_UPLOAD":
      return t("pictureDescription.sources.CUSTOM_UPLOAD");
    default:
      return t("pictureDescription.sources.SAMPLE");
  }
}

function readinessHint(
  wordCount: number,
  grade: number,
  t: TranslateFn,
): {
  readonly label: string;
  readonly readyFor3Stars: boolean;
} {
  const targetWords = grade >= 3 ? 7 : 5;
  if (wordCount === 0) {
    return {
      label: t("pictureDescription.readiness.empty"),
      readyFor3Stars: false,
    };
  }
  if (wordCount <= 2) {
    return {
      label: t("pictureDescription.readiness.tooShort", { count: wordCount }),
      readyFor3Stars: false,
    };
  }
  if (wordCount < targetWords) {
    return {
      label: t("pictureDescription.readiness.needMoreDetail", {
        count: wordCount,
      }),
      readyFor3Stars: false,
    };
  }
  return {
    label: t("pictureDescription.readiness.ready", { count: wordCount }),
    readyFor3Stars: true,
  };
}

function renderStars(count: number, ariaLabel: string) {
  return (
    <span aria-label={ariaLabel} className="inline-flex items-center gap-1">
      {[1, 2, 3].map((index) => (
        <Star
          aria-hidden="true"
          className={
            index <= count
              ? "size-5 fill-[#F4C430] text-[#E5A913]"
              : "size-5 text-border"
          }
          key={index}
        />
      ))}
    </span>
  );
}

const VALID_TEACHING_MODES: readonly PictureTeachingMode[] = [
  "OBSERVE",
  "VOCABULARY",
  "SENTENCE",
  "STORY",
  "INFER",
  "CREATE",
];

export interface PictureDescriptionScreenProps {
  readonly autoPlay?: boolean;
  readonly initialTeachingMode?: PictureTeachingMode;
  readonly vocabularyService?: VocabularyNotebookService;
  readonly initialChildId?: string;
  readonly initialBookId?: string;
  readonly initialPageId?: string;
}

export function PictureDescriptionScreen({
  autoPlay,
  initialTeachingMode,
  vocabularyService,
  initialBookId,
  initialPageId,
}: PictureDescriptionScreenProps = {}) {
  const tRaw = useTranslations("entertainment");
  const tCommon = useTranslations("common");
  const tGlossary = useWordGlossaryTranslations();
  const resolvedVocabService = useMemo(
    () => vocabularyService ?? createVocabularyNotebookService(),
    [vocabularyService],
  );
  const autoPlayRequested = resolveAutoPlayFlag(autoPlay);
  const resolvedInitialTeachingMode = useMemo(
    () =>
      resolveAllowedQueryParam(
        initialTeachingMode,
        "mode",
        VALID_TEACHING_MODES,
      ),
    [initialTeachingMode],
  );
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const pictureService = usePictureDescriptionService();
  const speechService = useMemo<SpeechService>(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const teacherPersona = useTeacherPersona();
  const t = useCallback(
    (key: string, params?: Parameters<TranslateFn>[1], defaultValue?: string) =>
      adaptTextToTeacherPersona(
        tRaw(key, params, defaultValue),
        teacherPersona.gender,
      ),
    [tRaw, teacherPersona.gender],
  );
  const defaultGameError = t("pictureDescription.defaultError");
  const adaptTeacherText = useCallback(
    (value: string) => adaptTextToTeacherPersona(value, teacherPersona.gender),
    [teacherPersona.gender],
  );
  const recorder = useSpeechRecorder();
  const {
    reducedMotion,
    calmSound,
    autoPlayFlow,
    autopilotEnabled,
    toggleCalmSound,
    toggleAutoPlayFlow,
  } = useEntertainmentPreferences();

  const [urlFocusWords] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("focus") ?? "";
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6);
    } catch {
      return [];
    }
  });
  const [notebookData, setNotebookData] =
    useState<VocabularyNotebookListDTO | null>(null);
  const [notebookDrawerOpen, setNotebookDrawerOpen] = useState(false);
  const [micCountdown, setMicCountdown] = useState<number | null>(null);
  const [isAutoSubmitPending, setIsAutoSubmitPending] = useState(false);

  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
  });
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<SourceTab>(() =>
    initialPageId || initialBookId ? "BOOK_PAGE" : "SAMPLE",
  );
  const [practiceTab, setPracticeTab] = useState<PracticeTab>("PRACTICE");
  const [session, setSession] = useState<PictureSessionDTO | null>(null);
  const [autopilotSessionActive, setAutopilotSessionActive] = useState<boolean>(
    autoPlayRequested && autoPlayFlow,
  );
  const [autoVoicePaused, setAutoVoicePaused] = useState(false);
  const [autoSubmitPaused, setAutoSubmitPaused] = useState(false);
  const [hasLiveSpeechRecognition, setHasLiveSpeechRecognition] =
    useState(false);
  const [silenceCountdown, setSilenceCountdown] = useState<{
    key: string;
    remainingMs: number;
  } | null>(null);
  const [selectedVocabWord, setSelectedVocabWord] = useState<string | null>(
    null,
  );
  const [teachingMode, setTeachingMode] = useState<PictureTeachingMode>(
    () => resolvedInitialTeachingMode ?? "OBSERVE",
  );
  const [activeFollowUpQuestion, setActiveFollowUpQuestion] = useState<
    string | null
  >(null);
  const [showGradeHintChips, setShowGradeHintChips] = useState(true);
  const [showHints, setShowHints] = useState(false);
  const [showSampleSentences, setShowSampleSentences] = useState(false);
  const [samplesPage, setSamplesPage] = useState(1);
  const [bookPagesPage, setBookPagesPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [attemptsPage, setAttemptsPage] = useState(1);
  const PICTURE_GRID_PAGE_SIZE = 6;
  const ATTEMPTS_PAGE_SIZE = 6;

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const analyzeStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.safetyChecking") },
      { atPct: 30, label: tCommon("aiProgress.analyzing") },
      { atPct: 70, label: tCommon("aiProgress.generatingQuestion") },
      { atPct: 90, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );
  const transcribeStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.transcribing") },
      { atPct: 74, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );
  const evaluateStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.evaluatingAnswer") },
      { atPct: 50, label: tCommon("aiProgress.analyzing") },
      { atPct: 86, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );
  const analyzeProgress = useAiProgress({
    active: isAnalyzing,
    stages: analyzeStages,
    expectedDurationMs: 12_000,
  });
  const transcribeProgress = useAiProgress({
    active: isTranscribing,
    stages: transcribeStages,
    expectedDurationMs: 4_500,
  });
  const evaluateProgress = useAiProgress({
    active: isEvaluating,
    stages: evaluateStages,
    expectedDurationMs: 10_000,
  });
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [evaluateError, setEvaluateError] = useState<string | null>(null);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [playingSpeechKey, setPlayingSpeechKey] = useState<string | null>(null);

  const [descriptionText, setDescriptionText] = useState("");
  const [inputMode, setInputMode] = useState<PictureInputMode>("TEXT");
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    null,
  );

  const mountedRef = useRef(true);
  const usingExternalNativeSttRef = useRef(false);
  const sessionEpochRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const isRecordingVoiceRef = useRef(false);
  const isTtsPlayingRef = useRef(false);
  const lastTtsEndAtRef = useRef(0);
  const micArmTokenRef = useRef(0);
  const micCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vadSpeechDetectedRef = useRef(false);
  const autopilotRunIdRef = useRef(0);
  const autopilotTurnKeyRef = useRef<string | null>(null);
  const autoStartedFromQueryRef = useRef(false);
  const spokenResultAttemptRef = useRef<string | null>(null);
  const descriptionTextRef = useRef("");
  const calmSoundRef = useRef(calmSound);
  const autoPlayFlowRef = useRef(autoPlayFlow);
  const autopilotSessionActiveRef = useRef(autopilotSessionActive);
  const practiceTabRef = useRef(practiceTab);
  const liveTranscriptRef = useRef("");
  const isEvaluatingRef = useRef(false);
  const lastSuccessfulSubmitRef = useRef<{ key: string; at: number } | null>(
    null,
  );
  const browserRecognitionRef = useRef<BrowserSpeechRecognitionLike | null>(
    null,
  );
  const collectorRef = useRef<BrowserTranscriptCollector>(
    new BrowserTranscriptCollector(),
  );
  const requestControllerRef = useRef<AbortController | null>(null);
  const sttControllerRef = useRef<AbortController | null>(null);
  const micCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const micCountdownSoundRef = useRef<ReturnType<
    typeof createCountdownSound
  > | null>(null);
  const silenceStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const autoSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadSpeechDuringCaptureRef = useRef(false);
  const startVoiceRecordingRef = useRef<
    (options?: { fromAutopilot?: boolean }) => Promise<void>
  >(async () => undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const unmountActionsRef = useRef({
    cancelRecorder: recorder.cancel,
    stopSpeech: speechPlayer.stop,
    getIsSpeaking: recorder.getIsSpeaking,
  });

  const childId = childState.status === "ready" ? childState.child.id : null;
  const pictureVoiceSessionId = childId
    ? `game_picture_${childId}`
    : "game_picture";

  useEffect(() => {
    if (!childId) return;
    const controller = new AbortController();
    void resolvedVocabService
      .listNotebook(childId, 12, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setNotebookData(data);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [childId, resolvedVocabService]);

  const activeNotebook =
    notebookData && notebookData.child_id === childId ? notebookData : null;
  const [fetchedDueFocusWords, setFetchedDueFocusWords] = useState<string[]>(
    [],
  );
  const [ephemeralFocusCleared, setEphemeralFocusCleared] = useState(false);

  useEffect(() => {
    if (!childId || urlFocusWords.length > 0) return;
    const controller = new AbortController();
    void createAdaptiveLearningService()
      .getRecommendations(childId, teacherPersona.gender, {
        signal: controller.signal,
      })
      .then((recs) => {
        if (!controller.signal.aborted) {
          setFetchedDueFocusWords(
            (recs.focus_difficult_words ?? []).slice(0, 5),
          );
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [childId, teacherPersona.gender, urlFocusWords.length]);

  const effectiveDueFocusWords = useMemo(
    () =>
      (urlFocusWords.length > 0 ? urlFocusWords : fetchedDueFocusWords).slice(
        0,
        5,
      ),
    [fetchedDueFocusWords, urlFocusWords],
  );
  const notebookBonusWords = useMemo(() => {
    if (!activeNotebook) return [];
    const raw = activeNotebook.storytelling_words?.length
      ? activeNotebook.storytelling_words
      : activeNotebook.items.map((item) => item.word);
    return raw.filter(Boolean).slice(0, 3);
  }, [activeNotebook]);
  const combinedFocusWords = useMemo(
    () =>
      Array.from(
        new Set([...effectiveDueFocusWords, ...notebookBonusWords]),
      ).slice(0, 6),
    [effectiveDueFocusWords, notebookBonusWords],
  );

  const speakEphemeralFocusWord = useCallback(
    (word: string) => {
      if (!calmSound || !word.trim()) return;
      speechPlayer.stop();
      void speechPlayer
        .play(word, {
          ephemeral: true,
          wordSample: true,
          speedScale: 0.9,
          bypassSessionLock: true,
          utteranceKind: "word_sample",
        })
        .catch(() => undefined);
    },
    [calmSound, speechPlayer],
  );

  useEffect(() => {
    lockSessionVoice(pictureVoiceSessionId);
    void preloadReadingVoiceEngines();
    return () => {
      releaseSessionVoiceLock(pictureVoiceSessionId);
    };
  }, [pictureVoiceSessionId]);

  useEffect(() => {
    sessionIdRef.current = session?.session_id ?? null;
  }, [session?.session_id]);

  useEffect(() => {
    descriptionTextRef.current = descriptionText;
  }, [descriptionText]);

  useEffect(() => {
    calmSoundRef.current = calmSound;
  }, [calmSound]);

  useEffect(() => {
    autoPlayFlowRef.current = autoPlayFlow;
  }, [autoPlayFlow]);

  useEffect(() => {
    autopilotSessionActiveRef.current = autopilotSessionActive;
  }, [autopilotSessionActive]);

  useEffect(() => {
    practiceTabRef.current = practiceTab;
  }, [practiceTab]);

  useEffect(() => {
    if (!uploadPreviewUrl) return;
    return () => {
      URL.revokeObjectURL(uploadPreviewUrl);
    };
  }, [uploadPreviewUrl]);

  useEffect(() => {
    unmountActionsRef.current = {
      cancelRecorder: recorder.cancel,
      stopSpeech: speechPlayer.stop,
      getIsSpeaking: recorder.getIsSpeaking,
    };
  });

  const clearMicCooldown = useCallback(() => {
    if (micCooldownTimerRef.current !== null) {
      clearTimeout(micCooldownTimerRef.current);
      micCooldownTimerRef.current = null;
    }
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const clearSilenceStopTimer = useCallback(() => {
    if (silenceStopTimerRef.current !== null) {
      clearTimeout(silenceStopTimerRef.current);
      silenceStopTimerRef.current = null;
    }
  }, []);

  const cancelMicCountdown = useCallback(() => {
    if (micCountdownTimerRef.current !== null) {
      clearInterval(micCountdownTimerRef.current);
      micCountdownTimerRef.current = null;
    }
    micCountdownSoundRef.current?.stop();
    micCountdownSoundRef.current = null;
    setMicCountdown(null);
  }, []);

  const cancelAutoSubmit = useCallback(() => {
    if (autoSubmitTimerRef.current !== null) {
      clearTimeout(autoSubmitTimerRef.current);
      autoSubmitTimerRef.current = null;
    }
    setIsAutoSubmitPending(false);
  }, []);

  const startMicCountdown = useCallback(
    (seconds = 3) => {
      if (
        isRecordingVoiceRef.current ||
        isEvaluatingRef.current ||
        (typeof document !== "undefined" && document.hidden)
      ) {
        return;
      }
      cancelMicCountdown();
      cancelAutoSubmit();
      if (process.env.NODE_ENV !== "test") {
        void recorder.prepare?.().catch(() => undefined);
        const routingHealth = getVoiceEngineHealthForRouting();
        const localReady = Boolean(
          routingHealth?.local.available && routingHealth.local.stt_ready,
        );
        if (
          !shouldPreferAndroidNativeStt() &&
          !localReady &&
          detectBrowserWasmSttSupport().supported &&
          !getBrowserWasmSttClient().isReady()
        ) {
          void getBrowserWasmSttClient()
            .init()
            .catch(() => undefined);
        }
      }
      const sound = getEntertainmentPreferences().calmSound
        ? createCountdownSound()
        : null;
      micCountdownSoundRef.current = sound;
      sound?.play(seconds);
      setMicCountdown(seconds);
      let remaining = seconds;
      micCountdownTimerRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          if (micCountdownTimerRef.current !== null) {
            clearInterval(micCountdownTimerRef.current);
            micCountdownTimerRef.current = null;
          }
          if (getEntertainmentPreferences().calmSound) {
            micCountdownSoundRef.current?.play(0);
          } else {
            micCountdownSoundRef.current?.stop();
          }
          micCountdownSoundRef.current = null;
          setMicCountdown(null);
          if (
            mountedRef.current &&
            !isRecordingVoiceRef.current &&
            !isEvaluatingRef.current &&
            !(typeof document !== "undefined" && document.hidden)
          ) {
            void startVoiceRecordingRef.current({ fromAutopilot: true });
          }
        } else {
          if (getEntertainmentPreferences().calmSound) {
            micCountdownSoundRef.current?.play(remaining);
          }
          setMicCountdown(remaining);
        }
      }, 1000);
    },
    [cancelAutoSubmit, cancelMicCountdown, recorder],
  );

  const abortActiveVoiceCapture = useCallback(
    (options?: { preserveDraft?: boolean }) => {
      sessionEpochRef.current += 1;
      micArmTokenRef.current += 1;
      clearMicCooldown();
      clearSilenceTimer();
      setSilenceCountdown(null);
      clearSilenceStopTimer();
      cancelMicCountdown();
      cancelAutoSubmit();
      hadSpeechDuringCaptureRef.current = false;
      const wasActive =
        isRecordingVoiceRef.current ||
        browserRecognitionRef.current !== null ||
        sttControllerRef.current !== null;
      isRecordingVoiceRef.current = false;
      usingExternalNativeSttRef.current = false;
      vadSpeechDetectedRef.current = false;
      setHasLiveSpeechRecognition(false);
      setIsRecordingVoice(false);
      setIsTranscribing(false);
      sttControllerRef.current?.abort();
      sttControllerRef.current = null;

      const pendingLive = collapseDuplicateSpeech(
        collectorRef.current.getTranscript() || liveTranscriptRef.current,
      );
      try {
        browserRecognitionRef.current?.abort();
      } catch {
        // Ignore browser recognition abort errors.
      }
      browserRecognitionRef.current = null;
      collectorRef.current.reset();
      if (wasActive) {
        unmountActionsRef.current.cancelRecorder();
      }
      if (options?.preserveDraft && pendingLive) {
        const prefix = descriptionTextRef.current.trim();
        const merged = !prefix
          ? pendingLive
          : normalizeSpeechUnit(prefix).endsWith(
                normalizeSpeechUnit(pendingLive),
              )
            ? prefix
            : `${prefix} ${pendingLive}`;
        descriptionTextRef.current = merged;
        setDescriptionText(merged);
        setInputMode("VOICE");
      }
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      return wasActive;
    },
    [
      cancelAutoSubmit,
      cancelMicCountdown,
      clearMicCooldown,
      clearSilenceStopTimer,
      clearSilenceTimer,
    ],
  );

  const stopSpeechPlayback = useCallback(() => {
    const browserSpeaking =
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      Boolean(window.speechSynthesis.speaking);
    if (isTtsPlayingRef.current || browserSpeaking) {
      lastTtsEndAtRef.current = Date.now();
    }
    isTtsPlayingRef.current = false;
    unmountActionsRef.current.stopSpeech();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingSpeechKey(null);
  }, []);

  const micPausedBackgroundText = t("pictureDescription.micPausedBackground");
  const micPausedBackgroundTextRef = useRef(micPausedBackgroundText);
  useEffect(() => {
    micPausedBackgroundTextRef.current = micPausedBackgroundText;
  }, [micPausedBackgroundText]);

  useEffect(() => {
    mountedRef.current = true;
    const suspendMediaOnBackground = () => {
      autopilotRunIdRef.current += 1;
      stopSpeechPlayback();
      const interruptedMic = abortActiveVoiceCapture({ preserveDraft: true });
      if (interruptedMic) {
        setVoiceMessage(micPausedBackgroundTextRef.current);
      }
    };
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.hidden) {
        suspendMediaOnBackground();
      }
    };
    const onAndroidBackground = () => {
      suspendMediaOnBackground();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
      document.addEventListener(
        "viread:android-background",
        onAndroidBackground,
      );
    }
    return () => {
      mountedRef.current = false;
      sessionEpochRef.current += 1;
      autopilotRunIdRef.current += 1;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        document.removeEventListener(
          "viread:android-background",
          onAndroidBackground,
        );
      }
      micArmTokenRef.current += 1;
      clearMicCooldown();
      clearSilenceTimer();
      clearSilenceStopTimer();
      if (micCountdownTimerRef.current !== null) {
        clearInterval(micCountdownTimerRef.current);
        micCountdownTimerRef.current = null;
      }
      micCountdownSoundRef.current?.stop();
      micCountdownSoundRef.current = null;
      if (autoSubmitTimerRef.current !== null) {
        clearTimeout(autoSubmitTimerRef.current);
        autoSubmitTimerRef.current = null;
      }
      isRecordingVoiceRef.current = false;
      isTtsPlayingRef.current = false;
      requestControllerRef.current?.abort();
      sttControllerRef.current?.abort();
      sttControllerRef.current = null;
      try {
        browserRecognitionRef.current?.abort();
      } catch {
        // Ignore browser recognition abort errors on unmount.
      }
      browserRecognitionRef.current = null;
      unmountActionsRef.current.stopSpeech();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      unmountActionsRef.current.cancelRecorder();
    };
  }, [
    abortActiveVoiceCapture,
    clearMicCooldown,
    clearSilenceStopTimer,
    clearSilenceTimer,
    stopSpeechPlayback,
  ]);

  useEffect(() => {
    if (!childId) return;

    const controller = new AbortController();
    let active = true;

    const catalogOptions =
      initialBookId || initialPageId
        ? { bookId: initialBookId, bookPageId: initialPageId }
        : undefined;

    void Promise.all([
      catalogOptions
        ? pictureService.getCatalog(childId, controller.signal, catalogOptions)
        : pictureService.getCatalog(childId, controller.signal),
      pictureService.listSessions(childId, controller.signal),
    ])
      .then(([catalog, sessions]) => {
        if (!active) return;
        setCatalogState({ status: "ready", catalog, sessions });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        const message = isServiceError(error)
          ? error.message
          : defaultGameError;
        setCatalogState({ status: "error", message });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    catalogRefreshKey,
    childId,
    defaultGameError,
    initialBookId,
    initialPageId,
    pictureService,
  ]);

  const sampleSessionMap = useMemo(() => {
    const map = new Map<string, PictureSessionSummaryDTO>();
    if (catalogState.status !== "ready") return map;
    for (const item of catalogState.sessions) {
      if (
        item.source_type === "SAMPLE" &&
        item.sample_key &&
        !map.has(item.sample_key)
      ) {
        map.set(item.sample_key, item);
      }
    }
    return map;
  }, [catalogState]);

  const bookPageSessionMap = useMemo(() => {
    const map = new Map<string, PictureSessionSummaryDTO>();
    if (catalogState.status !== "ready") return map;
    for (const item of catalogState.sessions) {
      if (
        item.source_type === "BOOK_PAGE" &&
        item.book_page_id &&
        !map.has(item.book_page_id)
      ) {
        map.set(item.book_page_id, item);
      }
    }
    return map;
  }, [catalogState]);

  useEffect(() => {
    return subscribeEntertainmentPreferences(() => {
      if (!getEntertainmentPreferences().calmSound) {
        stopSpeechPlayback();
      }
    });
  }, [stopSpeechPlayback]);

  const speakVietnamese = useCallback(
    async (
      text: string,
      key: string,
      options?: { readonly adaptPersona?: boolean },
    ) => {
      if (!calmSound) return;
      const cleaned = text.trim();
      if (!cleaned) return;
      if (playingSpeechKey === key) {
        stopSpeechPlayback();
        return;
      }

      // Preserve exact vocabulary/sample story content and child's own draft; adapt teacher coaching prompts/feedback.
      const isStoryOrVocabSample =
        key === "draft-description" ||
        key.startsWith("target-word:") ||
        key.startsWith("vocab:") ||
        key.startsWith("highlight:") ||
        key.startsWith("sample:") ||
        key.startsWith("sample-sentence:") ||
        key.startsWith("upgraded:");
      const shouldAdapt =
        options?.adaptPersona !== undefined
          ? options.adaptPersona
          : !isStoryOrVocabSample;
      const spokenText = shouldAdapt
        ? adaptTextToTeacherPersona(cleaned, teacherPersona.gender)
        : cleaned;

      // G10 Anti-Self-Capture: Immediately abort any active mic / SpeechRecognition before TTS starts.
      abortActiveVoiceCapture({ preserveDraft: true });
      stopSpeechPlayback();
      isTtsPlayingRef.current = true;
      setPlayingSpeechKey(key);

      try {
        await speechPlayer.play(spokenText, {
          utteranceKind: shouldAdapt ? "game_coaching" : "game_sample",
          ...(shouldAdapt ? { coaching: true } : {}),
          bypassSessionLock: true,
        });
      } catch {
        // Ignore playback interruption / fallback errors.
      } finally {
        isTtsPlayingRef.current = false;
        lastTtsEndAtRef.current = Date.now();
        setPlayingSpeechKey((current) => (current === key ? null : current));
      }
    },
    [
      abortActiveVoiceCapture,
      calmSound,
      playingSpeechKey,
      speechPlayer,
      stopSpeechPlayback,
      teacherPersona.gender,
    ],
  );

  const openSession = useCallback(
    (
      loaded: PictureSessionDTO,
      initialTab: PracticeTab = "PRACTICE",
      options?: { autopilot?: boolean; autoCountdown?: boolean },
    ) => {
      autopilotRunIdRef.current += 1;
      autopilotTurnKeyRef.current = null;
      spokenResultAttemptRef.current = null;
      const nextAutopilot = Boolean(options?.autopilot);
      autopilotSessionActiveRef.current = nextAutopilot;
      setAutopilotSessionActive(nextAutopilot);
      setAutoVoicePaused(false);
      setAutoSubmitPaused(false);
      stopSpeechPlayback();
      abortActiveVoiceCapture({ preserveDraft: false });
      sessionIdRef.current = loaded.session_id;
      const newestAttempt = loaded.attempts[0] ?? null;
      const initialMode =
        loaded.teaching_mode ?? loaded.guide.teaching_mode ?? "OBSERVE";
      const resolvedTab: PracticeTab =
        initialTab === "RESULT" && newestAttempt ? "RESULT" : "PRACTICE";
      setSession(loaded);
      setTeachingMode(initialMode);
      setActiveFollowUpQuestion(
        newestAttempt?.feedback.next_prompt_question ?? null,
      );
      // Grade-adaptive scaffolding: prominent audio-first hints for Grades 1-2,
      // collapsed by default for Grades 4-5 (expandable in 1 tap).
      setShowGradeHintChips(loaded.child_grade < 4);
      setSelectedAttemptId(newestAttempt?.attempt_id ?? null);
      setAttemptsPage(1);
      setPracticeTab(resolvedTab);
      setSelectedVocabWord(null);
      setShowHints(false);
      setShowSampleSentences(false);
      descriptionTextRef.current = "";
      setDescriptionText("");
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      setInputMode("TEXT");
      setActionError(null);
      setEvaluateError(null);
      setVoiceMessage(null);
      lastSuccessfulSubmitRef.current = null;
      if (
        resolvedTab === "PRACTICE" &&
        options?.autoCountdown &&
        !options?.autopilot &&
        getEntertainmentPreferences().autopilotEnabled
      ) {
        startMicCountdown(3);
      }
    },
    [abortActiveVoiceCapture, startMicCountdown, stopSpeechPlayback],
  );

  const handleAutoSelectSession = useCallback(
    async (options?: {
      enableAutopilot?: boolean;
      teachingMode?: PictureTeachingMode;
    }) => {
      if (!childId || !pictureService || isAnalyzing) return;
      requestControllerRef.current?.abort();
      const controller = new AbortController();
      requestControllerRef.current = controller;

      setActionError(null);
      setIsAnalyzing(true);
      try {
        const selectedMode =
          options?.teachingMode ?? resolvedInitialTeachingMode;
        const created = await pictureService.createSession(
          {
            child_id: childId,
            auto_select: true,
            ...(selectedMode ? { teaching_mode: selectedMode } : {}),
            teacher_gender: teacherPersona.gender,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        openSession(created, "PRACTICE", {
          autopilot: options?.enableAutopilot !== false,
        });
        setCatalogRefreshKey((value) => value + 1);
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        setActionError(
          isServiceError(error) ? error.message : defaultGameError,
        );
      } finally {
        setIsAnalyzing(false);
      }
    },
    [
      childId,
      defaultGameError,
      isAnalyzing,
      openSession,
      pictureService,
      resolvedInitialTeachingMode,
      teacherPersona.gender,
    ],
  );

  useEffect(() => {
    if (!autoPlayRequested || autoStartedFromQueryRef.current) return;
    if (!autoPlayFlow) {
      autoStartedFromQueryRef.current = true;
      return;
    }
    if (!childId || session || isAnalyzing) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active || autoStartedFromQueryRef.current) return;
      autoStartedFromQueryRef.current = true;
      void handleAutoSelectSession({
        enableAutopilot: true,
        teachingMode: resolvedInitialTeachingMode,
      });
    });
    return () => {
      active = false;
    };
  }, [
    autoPlayFlow,
    autoPlayRequested,
    childId,
    handleAutoSelectSession,
    isAnalyzing,
    resolvedInitialTeachingMode,
    session,
  ]);

  const handleResumeSession = async (
    sessionId: string,
    preferredTab?: PracticeTab,
    options?: { autoCountdown?: boolean },
  ) => {
    if (!pictureService || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setEphemeralFocusCleared(false);
    setIsAnalyzing(true);
    try {
      const loaded = await pictureService.getSession(
        sessionId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const targetTab =
        preferredTab ?? (loaded.attempts.length > 0 ? "RESULT" : "PRACTICE");
      openSession(loaded, targetTab, options);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleCreateSampleSession = async (
    sample: PictureSampleItemDTO,
    options?: { refreshAiGuide?: boolean },
  ) => {
    if (!childId || !pictureService || isAnalyzing) return;
    void recorder.prepare?.().catch(() => undefined);
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setEphemeralFocusCleared(false);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "SAMPLE",
          sample_key: sample.sample_key,
          ...(resolvedInitialTeachingMode
            ? { teaching_mode: resolvedInitialTeachingMode }
            : {}),
          refresh_ai_guide: options?.refreshAiGuide,
          teacher_gender: teacherPersona.gender,
          ...(combinedFocusWords.length > 0
            ? { target_words: combinedFocusWords }
            : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created, "PRACTICE", { autoCountdown: true });
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStartSample = async (sample: PictureSampleItemDTO) => {
    setEphemeralFocusCleared(false);
    const existing = sampleSessionMap.get(sample.sample_key);
    if (existing) {
      const targetTab: PracticeTab =
        existing.attempts_count > 0 ? "RESULT" : "PRACTICE";
      if (targetTab === "PRACTICE") {
        void recorder.prepare?.().catch(() => undefined);
      }
      await handleResumeSession(existing.session_id, targetTab, {
        autoCountdown: targetTab === "PRACTICE",
      });
      return;
    }
    await handleCreateSampleSession(sample);
  };

  const handleCreateBookPageSession = async (page: PictureBookPageItemDTO) => {
    if (!childId || !pictureService || isAnalyzing) return;
    void recorder.prepare?.().catch(() => undefined);
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setEphemeralFocusCleared(false);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "BOOK_PAGE",
          book_page_id: page.page_id,
          ...(resolvedInitialTeachingMode
            ? { teaching_mode: resolvedInitialTeachingMode }
            : {}),
          teacher_gender: teacherPersona.gender,
          ...(combinedFocusWords.length > 0
            ? { target_words: combinedFocusWords }
            : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created, "PRACTICE", { autoCountdown: true });
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStartBookPage = async (page: PictureBookPageItemDTO) => {
    const existing = bookPageSessionMap.get(page.page_id);
    if (existing) {
      const targetTab: PracticeTab =
        existing.attempts_count > 0 ? "RESULT" : "PRACTICE";
      if (targetTab === "PRACTICE") {
        void recorder.prepare?.().catch(() => undefined);
      }
      await handleResumeSession(existing.session_id, targetTab, {
        autoCountdown: targetTab === "PRACTICE",
      });
      return;
    }
    await handleCreateBookPageSession(page);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const chosen = event.target.files?.[0] ?? null;
    if (!chosen) {
      setUploadFile(null);
      setUploadPreviewUrl(null);
      return;
    }
    if (!ACCEPTED_TYPES.has(chosen.type)) {
      setUploadFile(null);
      setUploadPreviewUrl(null);
      setUploadError(t("pictureDescription.uploadInvalidType"));
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setUploadFile(null);
      setUploadPreviewUrl(null);
      setUploadError(t("pictureDescription.uploadTooLarge"));
      return;
    }
    setUploadFile(chosen);
    setUploadPreviewUrl(URL.createObjectURL(chosen));
  };

  const handleStartUpload = async () => {
    if (!childId || !pictureService || !uploadFile || isAnalyzing) return;
    void recorder.prepare?.().catch(() => undefined);
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setUploadError(null);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "CUSTOM_UPLOAD",
          image_file: uploadFile,
          ...(resolvedInitialTeachingMode
            ? { teaching_mode: resolvedInitialTeachingMode }
            : {}),
          teacher_gender: teacherPersona.gender,
          ...(combinedFocusWords.length > 0
            ? { target_words: combinedFocusWords }
            : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created, "PRACTICE", { autoCountdown: true });
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startVoiceRecording = useCallback(
    async (options?: { fromAutopilot?: boolean }) => {
      cancelMicCountdown();
      cancelAutoSubmit();
      clearSilenceStopTimer();
      hadSpeechDuringCaptureRef.current = false;
      if (isRecordingVoiceRef.current || isTranscribing || isEvaluating) return;
      const captureEpoch = sessionEpochRef.current;

      if (!options?.fromAutopilot) {
        autopilotRunIdRef.current += 1;
      }
      setAutoSubmitPaused(false);
      clearSilenceTimer();
      setSilenceCountdown(null);

      // G10 Anti-Self-Capture: Immediately cancel any active TTS playback before arming mic.
      const browserSpeaking =
        typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        Boolean(window.speechSynthesis.speaking);
      const wasTtsActive =
        isTtsPlayingRef.current || speechPlayer.isPlaying || browserSpeaking;
      stopSpeechPlayback();

      clearMicCooldown();
      const armToken = ++micArmTokenRef.current;

      setVoiceMessage(null);
      setActionError(null);
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      collectorRef.current.reset();

      const elapsedSinceTts =
        lastTtsEndAtRef.current > 0
          ? Date.now() - lastTtsEndAtRef.current
          : Number.POSITIVE_INFINITY;
      const cooldownRemainingMs = wasTtsActive
        ? TTS_MIC_COOLDOWN_MS
        : elapsedSinceTts < TTS_MIC_COOLDOWN_MS
          ? TTS_MIC_COOLDOWN_MS - elapsedSinceTts
          : 0;

      if (cooldownRemainingMs > 0) {
        setVoiceMessage(t("pictureDescription.waitingTtsCooldown"));
        await new Promise<void>((resolve) => {
          micCooldownTimerRef.current = setTimeout(() => {
            micCooldownTimerRef.current = null;
            resolve();
          }, cooldownRemainingMs);
        });
        if (
          !mountedRef.current ||
          sessionEpochRef.current !== captureEpoch ||
          micArmTokenRef.current !== armToken ||
          isTtsPlayingRef.current ||
          (typeof document !== "undefined" && document.hidden)
        ) {
          return;
        }
      }

      const preferAndroidNativeStt = shouldPreferAndroidNativeStt();
      usingExternalNativeSttRef.current = preferAndroidNativeStt;
      if (!preferAndroidNativeStt) {
        try {
          await recorder.start({ mode: "child-passage" });
        } catch {
          if (!mountedRef.current || sessionEpochRef.current !== captureEpoch) {
            return;
          }
          isRecordingVoiceRef.current = false;
          setIsRecordingVoice(false);
          setVoiceMessage(
            options?.fromAutopilot
              ? t("pictureDescription.autoMicBlockedFallback")
              : t("pictureDescription.micUnavailable"),
          );
          return;
        }
      }

      if (
        !mountedRef.current ||
        sessionEpochRef.current !== captureEpoch ||
        micArmTokenRef.current !== armToken ||
        isTtsPlayingRef.current
      ) {
        if (!preferAndroidNativeStt) {
          recorder.cancel();
        }
        return;
      }

      isRecordingVoiceRef.current = true;
      vadSpeechDetectedRef.current = false;
      setHasLiveSpeechRecognition(false);
      setIsRecordingVoice(true);
      setVoiceMessage(t("pictureDescription.micListening"));

      const rawCtor = getSpeechRecognitionCtor();
      const hasSharedWebTrack =
        process.env.NODE_ENV !== "test" &&
        Boolean(recorder.getStream?.()?.getAudioTracks()?.[0]);
      const SpeechRecognition =
        preferAndroidNativeStt || hasSharedWebTrack
          ? ((resolveLocalFirstSpeechRecognitionConstructor(
              window as unknown as Parameters<
                typeof resolveLocalFirstSpeechRecognitionConstructor
              >[0],
              speechService,
              () => ({ sessionId: pictureVoiceSessionId }),
              () => recorder.getStream?.()?.getAudioTracks()?.[0],
            ) as BrowserSpeechRecognitionCtor | undefined) ?? null)
          : isInjectedTestSpeechRecognition(rawCtor)
            ? rawCtor
            : null;
      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          let recognitionFailed = false;
          recognition.lang = "vi-VN";
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.onresult = (event) => {
            // Never capture AI Teacher TTS audio into the child's transcript.
            const synthesisSpeaking =
              typeof window !== "undefined" &&
              "speechSynthesis" in window &&
              Boolean(window.speechSynthesis.speaking);
            if (
              !mountedRef.current ||
              sessionEpochRef.current !== captureEpoch ||
              !isRecordingVoiceRef.current ||
              isTtsPlayingRef.current ||
              synthesisSpeaking
            ) {
              return;
            }
            collectorRef.current.addResults(event);
            const nextLive = collectLiveTranscript(collectorRef.current, event);
            if (nextLive.trim()) {
              hadSpeechDuringCaptureRef.current = true;
            }
            liveTranscriptRef.current = nextLive;
            setLiveTranscript(nextLive);
          };
          recognition.onend = () => {
            collectorRef.current.completeRecognitionCycle();
            if (
              mountedRef.current &&
              sessionEpochRef.current === captureEpoch &&
              isRecordingVoiceRef.current &&
              !isTtsPlayingRef.current &&
              !recognitionFailed &&
              browserRecognitionRef.current === recognition
            ) {
              try {
                recognition.start();
              } catch {
                browserRecognitionRef.current = null;
              }
            }
          };
          recognition.onerror = () => {
            recognitionFailed = true;
          };
          browserRecognitionRef.current = recognition;
          recognition.start();
          setHasLiveSpeechRecognition(true);
        } catch {
          browserRecognitionRef.current = null;
          setHasLiveSpeechRecognition(false);
        }
      }
    },
    [
      cancelAutoSubmit,
      cancelMicCountdown,
      clearMicCooldown,
      clearSilenceStopTimer,
      clearSilenceTimer,
      isEvaluating,
      isTranscribing,
      pictureVoiceSessionId,
      recorder,
      speechPlayer.isPlaying,
      speechService,
      stopSpeechPlayback,
      t,
    ],
  );

  const stopVoiceRecording = useCallback(async (): Promise<string | null> => {
    if (!isRecordingVoiceRef.current) return null;
    clearSilenceStopTimer();
    hadSpeechDuringCaptureRef.current = false;
    const captureEpoch = sessionEpochRef.current;
    const activeSessionId = sessionIdRef.current;
    clearSilenceTimer();
    setSilenceCountdown(null);
    isRecordingVoiceRef.current = false;
    vadSpeechDetectedRef.current = false;
    setHasLiveSpeechRecognition(false);
    setIsRecordingVoice(false);
    setIsTranscribing(true);
    setVoiceMessage(t("pictureDescription.transcribingSpeech"));

    sttControllerRef.current?.abort();
    const sttController = new AbortController();
    sttControllerRef.current = sttController;

    const liveSnapshot = liveTranscriptRef.current;
    try {
      browserRecognitionRef.current?.stop();
    } catch {
      // Ignore browser recognition stop errors.
    }

    const isStaleCapture = () =>
      !mountedRef.current ||
      sttController.signal.aborted ||
      sessionEpochRef.current !== captureEpoch ||
      sessionIdRef.current !== activeSessionId;

    try {
      const usedExternalNative = usingExternalNativeSttRef.current;
      usingExternalNativeSttRef.current = false;
      const audioBlob = usedExternalNative ? null : await recorder.stop();
      if (isStaleCapture()) return null;
      const captureQuality = usedExternalNative
        ? undefined
        : recorder.getQuality?.();
      const silentCapture = isConfirmedSilentVoiceCapture(captureQuality);
      const browserFallback = collapseDuplicateSpeech(
        collectorRef.current.getTranscript() || liveSnapshot,
      );
      let sttTranscript: string | null = null;

      if (silentCapture && !browserFallback) {
        setVoiceMessage(
          adaptTextToTeacherPersona(
            t(
              "pictureDescription.quietVoicePrompt",
              undefined,
              "Cô chưa nghe thấy tiếng bé nói. Bé hãy đưa micro gần hơn và nói to rõ hơn nhé!",
            ),
            getEffectiveTeacherPersona().gender,
          ),
        );
        return null;
      }

      if (audioBlob && audioBlob.size > 0 && !silentCapture) {
        const keyterms = session
          ? Array.from(
              new Set([
                ...(session.target_words ?? []),
                ...(session.guide.target_words ?? []),
                ...combinedFocusWords,
                ...session.guide.suggested_vocabulary.map((item) => item.word),
              ]),
            )
              .filter(Boolean)
              .slice(0, 16)
          : [];
        const routingHealth = getVoiceEngineHealthForRouting();
        const policy = getVoicePolicyPreferences();
        const cloudSttAllowed =
          policy.providerMode === "local_with_google_fallback" &&
          policy.allowGoogleSttFallback;
        const serverSttUnavailable =
          isPermanentlyHostedLocalUnconfigured(routingHealth) ||
          isServerSttConfirmedUnavailable() ||
          (!cloudSttAllowed &&
            routingHealth !== null &&
            (!routingHealth.local.available || !routingHealth.local.stt_ready));
        const wasmSupported = detectBrowserWasmSttSupport().supported;
        if (serverSttUnavailable && browserFallback) {
          sttTranscript = browserFallback;
        } else if (serverSttUnavailable && wasmSupported) {
          try {
            const wasmResult = await getBrowserWasmSttClient().transcribeBlob(
              audioBlob,
              { timeoutMs: 12_000 },
            );
            if (isStaleCapture()) return null;
            sttTranscript = wasmResult.text.normalize("NFC").trim() || null;
            if (sttTranscript) {
              recordSttEngineUsage({
                provider: "wasm",
                fallbackUsed:
                  !isPermanentlyHostedLocalUnconfigured(routingHealth),
                fallbackReason: isPermanentlyHostedLocalUnconfigured(
                  routingHealth,
                )
                  ? null
                  : "LOCAL_STT_UNAVAILABLE",
              });
            }
          } catch {
            if (isStaleCapture()) return null;
            sttTranscript = null;
          }
        } else if (!serverSttUnavailable) {
          try {
            const sttResult = await speechService.transcribe(audioBlob, {
              languageCode: "vi",
              keyterms,
              signal: sttController.signal,
            });
            if (isStaleCapture()) return null;
            sttTranscript = sttResult.text?.trim() || null;
          } catch (err: unknown) {
            if (isStaleCapture()) return null;
            const errText =
              typeof err === "object" && err !== null
                ? `${String((err as { code?: unknown }).code ?? "")} ${String((err as { providerCode?: unknown }).providerCode ?? "")} ${err instanceof Error ? err.message : ""}`
                : "";
            if (errText.includes("LOCAL_VOICE_UNCONFIGURED")) {
              markHostedLocalUnconfigured();
            }
            if (isServiceError(err) && err.status === 503) {
              refreshVoiceHealthQuietlyAfterSttFailure();
            }
            sttTranscript = null;
          }
          if (!sttTranscript && wasmSupported) {
            try {
              const wasmResult = await getBrowserWasmSttClient().transcribeBlob(
                audioBlob,
                { timeoutMs: 12_000 },
              );
              if (isStaleCapture()) return null;
              sttTranscript = wasmResult.text.normalize("NFC").trim() || null;
            } catch {
              if (isStaleCapture()) return null;
            }
          }
        }
      }

      if (isStaleCapture()) return null;
      const finalTranscript = sttTranscript || browserFallback || null;
      if (!finalTranscript) {
        setVoiceMessage(
          adaptTextToTeacherPersona(
            t("pictureDescription.unclearVoice"),
            getEffectiveTeacherPersona().gender,
          ),
        );
        return null;
      }

      const prefix = descriptionTextRef.current.trim();
      const mergedTranscript = prefix
        ? `${prefix} ${finalTranscript}`
        : finalTranscript;
      descriptionTextRef.current = mergedTranscript;
      setDescriptionText(mergedTranscript);
      setInputMode("VOICE");
      setVoiceMessage(
        sttTranscript
          ? t("pictureDescription.transcribedElevenLabs")
          : t("pictureDescription.transcribedBrowser"),
      );
      return mergedTranscript;
    } finally {
      if (sttControllerRef.current === sttController) {
        sttControllerRef.current = null;
      }
      if (mountedRef.current && sessionEpochRef.current === captureEpoch) {
        setIsTranscribing(false);
        liveTranscriptRef.current = "";
        setLiveTranscript("");
        browserRecognitionRef.current = null;
      }
    }
  }, [
    clearSilenceStopTimer,
    clearSilenceTimer,
    combinedFocusWords,
    recorder,
    session,
    speechService,
    t,
  ]);

  const handleInsertVocabWord = (word: string) => {
    if (isRecordingVoice || isRecordingVoiceRef.current) {
      abortActiveVoiceCapture({ preserveDraft: true });
    } else {
      cancelMicCountdown();
      cancelAutoSubmit();
    }
    setDescriptionText((previous) => {
      if (descriptionContainsTerm(previous, word)) return previous;
      const trimmedEnd = previous.replace(/\s+$/g, "");
      const next = trimmedEnd ? `${trimmedEnd} ${word}` : word;
      descriptionTextRef.current = next;
      return next;
    });
  };

  const handleClearDraft = () => {
    cancelMicCountdown();
    cancelAutoSubmit();
    stopSpeechPlayback();
    descriptionTextRef.current = "";
    setDescriptionText("");
    setInputMode("TEXT");
    setVoiceMessage(null);
    setActionError(null);
    setEvaluateError(null);
    lastSuccessfulSubmitRef.current = null;
  };

  const handleEvaluate = useCallback(
    async (
      overrideTranscript?: string,
      overrideMode?: PictureInputMode,
      options?: { allowDuplicate?: boolean },
    ) => {
      cancelMicCountdown();
      cancelAutoSubmit();
      if (
        !session ||
        !pictureService ||
        isEvaluating ||
        isEvaluatingRef.current
      )
        return;
      const rawText =
        overrideTranscript !== undefined
          ? overrideTranscript
          : descriptionTextRef.current;
      const trimmed = rawText.trim();
      if (!trimmed) {
        setEvaluateError(t("pictureDescription.emptySubmissionError"));
        return;
      }

      const submitKey = `${session.session_id}:${teachingMode}:${normalizeSpeechUnit(trimmed)}`;
      const now = Date.now();
      if (
        !options?.allowDuplicate &&
        lastSuccessfulSubmitRef.current &&
        lastSuccessfulSubmitRef.current.key === submitKey &&
        now - lastSuccessfulSubmitRef.current.at < DUPLICATE_SUBMIT_WINDOW_MS
      ) {
        return;
      }

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setEvaluateError(t("pictureDescription.offlineNotice"));
        return;
      }

      autopilotRunIdRef.current += 1;
      stopSpeechPlayback();
      abortActiveVoiceCapture({ preserveDraft: false });
      requestControllerRef.current?.abort();
      const controller = new AbortController();
      requestControllerRef.current = controller;

      const sessionTargetWords = Array.from(
        new Set([
          ...(session.target_vocabulary ?? []),
          ...(session.target_words ?? []),
          ...(session.guide.target_words ?? []),
          ...urlFocusWords,
        ]),
      );
      const effectiveInputMode = overrideMode ?? inputMode;

      isEvaluatingRef.current = true;
      setActionError(null);
      setEvaluateError(null);
      setIsEvaluating(true);
      try {
        const response = await pictureService.evaluate(
          session.session_id,
          {
            transcript_text: trimmed,
            input_mode: effectiveInputMode,
            teaching_mode: teachingMode,
            teacher_gender: teacherPersona.gender,
            ...(sessionTargetWords.length > 0
              ? { target_words: sessionTargetWords }
              : {}),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        lastSuccessfulSubmitRef.current = { key: submitKey, at: Date.now() };
        setSession(response.session);
        setSelectedAttemptId(response.latest_attempt.attempt_id);
        setAttemptsPage(1);
        setActiveFollowUpQuestion(
          response.latest_attempt.feedback.next_prompt_question ?? null,
        );
        setVoiceMessage(null);
        setEvaluateError(null);
        setPracticeTab("RESULT");
        setCatalogRefreshKey((value) => value + 1);
        if (
          !autopilotSessionActiveRef.current &&
          effectiveInputMode === "VOICE" &&
          getEntertainmentPreferences().autopilotEnabled &&
          getEntertainmentPreferences().calmSound
        ) {
          const spokenPraise = [
            response.latest_attempt.feedback.praise_message,
            response.latest_attempt.feedback.next_prompt_question ?? "",
          ]
            .filter(Boolean)
            .join(" ");
          if (spokenPraise) {
            void speakVietnamese(
              spokenPraise,
              `feedback:${response.latest_attempt.attempt_id}`,
            );
          }
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        lastSuccessfulSubmitRef.current = null;
        setEvaluateError(
          isServiceError(error) ? error.message : defaultGameError,
        );
      } finally {
        isEvaluatingRef.current = false;
        setIsEvaluating(false);
      }
    },
    [
      abortActiveVoiceCapture,
      cancelAutoSubmit,
      cancelMicCountdown,
      defaultGameError,
      inputMode,
      isEvaluating,
      pictureService,
      session,
      speakVietnamese,
      stopSpeechPlayback,
      t,
      teacherPersona.gender,
      teachingMode,
      urlFocusWords,
    ],
  );

  const stopVoiceRecordingRef = useRef(stopVoiceRecording);
  const handleEvaluateRef = useRef(handleEvaluate);
  const speakVietnameseRef = useRef(speakVietnamese);
  const autoEvaluateInFlightRef = useRef(false);

  useEffect(() => {
    startVoiceRecordingRef.current = startVoiceRecording;
  }, [startVoiceRecording]);

  useEffect(() => {
    stopVoiceRecordingRef.current = stopVoiceRecording;
  }, [stopVoiceRecording]);

  useEffect(() => {
    handleEvaluateRef.current = handleEvaluate;
  }, [handleEvaluate]);

  useEffect(() => {
    speakVietnameseRef.current = speakVietnamese;
  }, [speakVietnamese]);

  const triggerAutoVoiceSubmit = useCallback(async () => {
    if (autoEvaluateInFlightRef.current || isEvaluatingRef.current) return;
    autoEvaluateInFlightRef.current = true;
    try {
      clearSilenceTimer();
      setSilenceCountdown(null);
      const transcribedDraft = await stopVoiceRecordingRef.current();
      const textToEvaluate = (transcribedDraft ?? "").trim();
      if (
        !mountedRef.current ||
        !sessionIdRef.current ||
        !textToEvaluate ||
        isEvaluatingRef.current
      ) {
        return;
      }
      await handleEvaluateRef.current(textToEvaluate, "VOICE");
    } finally {
      autoEvaluateInFlightRef.current = false;
    }
  }, [clearSilenceTimer]);

  // Hands-Free Autopilot Turn Loop: speak opening/follow-up prompt -> 280ms cooldown -> auto-arm mic
  useEffect(() => {
    if (
      !autopilotSessionActive ||
      !autoPlayFlow ||
      autoVoicePaused ||
      !session ||
      practiceTab !== "PRACTICE" ||
      isAnalyzing ||
      isEvaluating ||
      isRecordingVoice ||
      isTranscribing ||
      (typeof document !== "undefined" && document.hidden)
    ) {
      return;
    }

    const turnKey = `${session.session_id}:${session.attempts_count}:${activeFollowUpQuestion ?? "open"}`;
    if (autopilotTurnKeyRef.current === turnKey) {
      return;
    }
    autopilotTurnKeyRef.current = turnKey;
    const runId = ++autopilotRunIdRef.current;

    const promptText =
      activeFollowUpQuestion?.trim() ||
      session.guide.guiding_questions[0]?.trim() ||
      adaptTeacherText(t("pictureDescription.openingAutopilotPrompt"));

    void (async () => {
      if (calmSoundRef.current && promptText) {
        await speakVietnameseRef.current(promptText, `autopilot:${turnKey}`);
      }
      if (
        !mountedRef.current ||
        autopilotRunIdRef.current !== runId ||
        !autoPlayFlowRef.current ||
        !autopilotSessionActiveRef.current ||
        practiceTabRef.current !== "PRACTICE" ||
        (typeof document !== "undefined" && document.hidden)
      ) {
        return;
      }
      await startVoiceRecordingRef.current({ fromAutopilot: true });
    })();
  }, [
    activeFollowUpQuestion,
    adaptTeacherText,
    autoPlayFlow,
    autoVoicePaused,
    autopilotSessionActive,
    isAnalyzing,
    isEvaluating,
    isRecordingVoice,
    isTranscribing,
    practiceTab,
    session,
    t,
  ]);

  // Auto-speak AI teacher reply once on entering RESULT during autopilot
  useEffect(() => {
    if (
      !autopilotSessionActive ||
      !autoPlayFlow ||
      !calmSound ||
      !session ||
      practiceTab !== "RESULT"
    ) {
      return;
    }
    const newestAttempt = session.attempts[0] ?? null;
    if (
      !newestAttempt ||
      spokenResultAttemptRef.current === newestAttempt.attempt_id
    ) {
      return;
    }
    spokenResultAttemptRef.current = newestAttempt.attempt_id;
    const replyText = [
      newestAttempt.feedback.praise_message,
      newestAttempt.feedback.improvement_tip,
      newestAttempt.feedback.next_prompt_question,
    ]
      .filter((item): item is string => Boolean(item && item.trim()))
      .join(" ");
    if (replyText) {
      void speakVietnameseRef.current(
        replyText,
        `feedback-auto:${newestAttempt.attempt_id}`,
      );
    }
  }, [autoPlayFlow, autopilotSessionActive, calmSound, practiceTab, session]);

  // Silence Auto-Submit:
  // - With live SpeechRecognition (Android native or test mock): starts 2.2s countdown once live transcript has >= 2 words and stops changing.
  // - On real web browsers without SpeechRecognition (MediaRecorder + ElevenLabs/WASM STT): uses recorder.isSpeaking Web Audio VAD
  //   so after speech is detected and the child stays quiet for 2.2s, recording stops, transcribes, and evaluates automatically.
  useEffect(() => {
    clearSilenceTimer();
    if (!isRecordingVoice) {
      vadSpeechDetectedRef.current = false;
      return;
    }
    if (recorder.isSpeaking) {
      vadSpeechDetectedRef.current = true;
      return;
    }
    if (
      !autoPlayFlow ||
      autoSubmitPaused ||
      isEvaluating ||
      isTranscribing ||
      (typeof document !== "undefined" && document.hidden)
    ) {
      return;
    }

    const hasLiveWords = countMeaningfulWords(liveTranscript) >= 2;
    const hasVadSpeechFinished =
      !hasLiveSpeechRecognition && vadSpeechDetectedRef.current;
    if (!hasLiveWords && !hasVadSpeechFinished) {
      return;
    }

    const silenceKey = hasLiveWords ? `stt:${liveTranscript}` : "vad-silence";
    let deadline = Date.now() + SILENCE_AUTO_SUBMIT_MS;
    const initialTick = hasVadSpeechFinished
      ? setTimeout(() => {
          if (
            mountedRef.current &&
            isRecordingVoiceRef.current &&
            !unmountActionsRef.current.getIsSpeaking() &&
            !(typeof document !== "undefined" && document.hidden)
          ) {
            setSilenceCountdown({
              key: silenceKey,
              remainingMs: Math.max(0, deadline - Date.now()),
            });
          }
        }, 0)
      : null;

    const timer = setInterval(() => {
      if (
        !mountedRef.current ||
        !isRecordingVoiceRef.current ||
        (typeof document !== "undefined" && document.hidden)
      ) {
        clearSilenceTimer();
        setSilenceCountdown(null);
        return;
      }
      if (unmountActionsRef.current.getIsSpeaking()) {
        vadSpeechDetectedRef.current = true;
        deadline = Date.now() + SILENCE_AUTO_SUBMIT_MS;
        setSilenceCountdown(null);
        return;
      }
      const remainingMs = Math.max(0, deadline - Date.now());
      setSilenceCountdown({ key: silenceKey, remainingMs });
      if (remainingMs <= 0) {
        clearSilenceTimer();
        void triggerAutoVoiceSubmit();
      }
    }, SILENCE_COUNTDOWN_TICK_MS);

    silenceTimerRef.current = timer;
    return () => {
      if (initialTick !== null) clearTimeout(initialTick);
      clearInterval(timer);
      if (silenceTimerRef.current === timer) {
        silenceTimerRef.current = null;
      }
    };
  }, [
    autoPlayFlow,
    autoSubmitPaused,
    clearSilenceTimer,
    hasLiveSpeechRecognition,
    isEvaluating,
    isRecordingVoice,
    isTranscribing,
    liveTranscript,
    recorder.isSpeaking,
    triggerAutoVoiceSubmit,
  ]);

  const normalizedDescription = useMemo(
    () => normalizeSpeechUnit(descriptionText),
    [descriptionText],
  );
  const selectedChildForHeader =
    childState.status === "ready" ? childState.child : null;
  const hasActiveSession = session !== null;
  const effectiveGradeMemo =
    session?.child_grade ?? selectedChildForHeader?.grade ?? 2;
  const isLowerGradeMemo = effectiveGradeMemo <= 2;
  const isUpperGradeMemo = effectiveGradeMemo >= 4;
  const activeModeSpec = TEACHING_MODE_SPEC_BY_ID[teachingMode];

  const headerBlock = useMemo(() => {
    if (!selectedChildForHeader) return null;
    return (
      <>
        <BookChildHeader
          child={selectedChildForHeader}
          mobileLabel={t("pictureDescription.mobileLabel")}
          backHref="/entertainment"
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <Link
              className="inline-flex items-center gap-2 text-xs font-extrabold text-primary hover:underline sm:text-sm"
              href="/entertainment"
            >
              <ArrowLeft
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
              {t("pictureDescription.backLink")}
            </Link>
            <h1 className="book-title mt-1 flex items-center gap-2 text-2xl text-ink sm:text-[32px]">
              {t("pictureDescription.heading")}
            </h1>
            <p className="text-sm text-muted sm:text-base">
              {t("pictureDescription.lead")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ReadingVoiceSettings
              childId={selectedChildForHeader.id}
              disabled={isRecordingVoice}
              fallbackNotice={speechPlayer.fallbackNotice}
              isPreviewing={speechPlayer.isPlaying && !speechPlayer.isPaused}
              onPreview={(sample) => {
                abortActiveVoiceCapture({ preserveDraft: true });
                stopSpeechPlayback();
                return speechPlayer.play(sample, {
                  coaching: true,
                  cacheScope: "COACHING",
                  isPrivateBook: false,
                  bypassSessionLock: true,
                  utteranceKind: "voice_preview",
                });
              }}
              onStopPreview={stopSpeechPlayback}
            />
            <Button
              aria-pressed={autoPlayFlow}
              className="min-h-11"
              data-testid="picture-autopilot-toggle"
              fullWidth={false}
              onClick={() => {
                if (autoPlayFlow) {
                  autopilotRunIdRef.current += 1;
                  clearSilenceTimer();
                  setSilenceCountdown(null);
                  cancelMicCountdown();
                  cancelAutoSubmit();
                }
                toggleAutoPlayFlow();
              }}
              size="compact"
              type="button"
              variant={autoPlayFlow ? "secondary" : "quiet"}
            >
              <Mic aria-hidden="true" className="size-4" />
              {autoPlayFlow
                ? t("pictureDescription.autoPlayOn")
                : t("pictureDescription.autoPlayOff")}
            </Button>
            <Button
              aria-pressed={!calmSound}
              className="min-h-11"
              fullWidth={false}
              onClick={toggleCalmSound}
              size="compact"
              type="button"
              variant="quiet"
            >
              {calmSound ? (
                <Volume2 aria-hidden="true" className="size-4" />
              ) : (
                <VolumeX aria-hidden="true" className="size-4" />
              )}
              {calmSound ? t("hub.calmSound") : t("hub.soundMuted")}
            </Button>
            {hasActiveSession ? (
              <Button
                fullWidth={false}
                onClick={() => {
                  autopilotRunIdRef.current += 1;
                  stopSpeechPlayback();
                  abortActiveVoiceCapture({ preserveDraft: false });
                  sessionIdRef.current = null;
                  autopilotSessionActiveRef.current = false;
                  setAutopilotSessionActive(false);
                  setShowHints(false);
                  setShowSampleSentences(false);
                  setEphemeralFocusCleared(true);
                  setActiveFollowUpQuestion(null);
                  setPracticeTab("PRACTICE");
                  setSession(null);
                  setSelectedAttemptId(null);
                  setActionError(null);
                  setEvaluateError(null);
                }}
                size="compact"
                type="button"
                variant="secondary"
              >
                <ArrowLeft
                  aria-hidden="true"
                  className="viread-rtl-flip size-4"
                />
                {t("pictureDescription.chooseAnotherPicture")}
              </Button>
            ) : null}
          </div>
        </div>
      </>
    );
  }, [
    abortActiveVoiceCapture,
    autoPlayFlow,
    calmSound,
    cancelAutoSubmit,
    cancelMicCountdown,
    clearSilenceTimer,
    hasActiveSession,
    isRecordingVoice,
    selectedChildForHeader,
    speechPlayer,
    stopSpeechPlayback,
    t,
    toggleAutoPlayFlow,
    toggleCalmSound,
  ]);

  const pictureFrameColumn = useMemo(() => {
    if (!session) return null;
    return (
      <div className="flex flex-col gap-4 rounded-card border border-border bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="rounded-full bg-sky px-3 py-1 text-xs font-extrabold text-primary">
              {t("pictureDescription.sourceGradeBadge", {
                source: sourceLabel(session.source_type, t),
                grade: session.child_grade,
              })}
            </span>
            <h2
              className="viread-learning-content mt-2 text-xl font-extrabold text-ink"
              dir="ltr"
              lang="vi"
            >
              {session.scene_title}
            </h2>
          </div>
          <div className="flex flex-col items-end gap-1">
            {renderStars(
              session.best_stars,
              t("pictureDescription.starsAria", {
                count: session.best_stars,
              }),
            )}
            <span className="text-xs font-bold text-muted">
              {session.attempts_count > 0
                ? t("pictureDescription.sessionStats", {
                    score: session.best_score,
                    count: session.attempts_count,
                  })
                : t("pictureDescription.sessionNoAttempts")}
            </span>
          </div>
        </div>

        <div className="overflow-hidden rounded-control border border-border bg-sky/20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={session.scene_title}
            className="max-h-[420px] w-full object-contain"
            src={session.image_url}
          />
        </div>

        <div className="rounded-control bg-sky/25 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
              {isLowerGradeMemo
                ? t("pictureDescription.gradeHintChipsLowerTitle")
                : t("pictureDescription.stepsTitle")}
            </p>
            {isUpperGradeMemo ? (
              <button
                aria-expanded={showGradeHintChips}
                className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-extrabold text-primary shadow-2xs transition-colors hover:bg-sky"
                data-testid="toggle-grade-hint-chips"
                onClick={() => setShowGradeHintChips((value) => !value)}
                type="button"
              >
                {showGradeHintChips ? (
                  <>
                    <ChevronUp aria-hidden="true" className="size-3.5" />
                    {t("pictureDescription.collapseGradeHints")}
                  </>
                ) : (
                  <>
                    <ChevronDown aria-hidden="true" className="size-3.5" />
                    {t("pictureDescription.expandGradeHints")}
                  </>
                )}
              </button>
            ) : null}
          </div>

          {showGradeHintChips ? (
            <div className="mt-2 space-y-2.5" data-testid="grade-hint-chips">
              {isLowerGradeMemo ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-primary/20 bg-white px-3 py-2">
                  <div className="flex flex-wrap gap-1.5">
                    {GRADE_1_2_VISUAL_HINT_CHIPS.map((chip) => (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-sky/50 px-2.5 py-1 text-xs font-extrabold text-ink"
                        key={chip.id}
                      >
                        <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-white">
                          {chip.badge}
                        </span>
                        {t(chip.textKey)}
                      </span>
                    ))}
                  </div>
                  <Button
                    disabled={!calmSound}
                    fullWidth={false}
                    onClick={() =>
                      void speakVietnamese(
                        t(activeModeSpec.audioHintKey),
                        `mode-audio:${teachingMode}`,
                        { adaptPersona: true },
                      )
                    }
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    {playingSpeechKey === `mode-audio:${teachingMode}` ? (
                      <>
                        <VolumeX aria-hidden="true" className="size-3.5" />
                        {t("pictureDescription.stopListen")}
                      </>
                    ) : (
                      <>
                        <Volume2 aria-hidden="true" className="size-3.5" />
                        {t("pictureDescription.listenGuideButton")}
                      </>
                    )}
                  </Button>
                </div>
              ) : null}
              <ol className="grid gap-2 sm:grid-cols-3">
                {STORYTELLING_STEPS.map((item) => (
                  <li
                    className="rounded-control bg-white/90 p-2.5 text-xs shadow-2xs"
                    key={item.step}
                  >
                    <span className="font-extrabold text-primary">
                      {t("pictureDescription.stepPrefix", {
                        step: item.step,
                      })}
                    </span>{" "}
                    <span className="font-bold text-ink">
                      {t(item.titleKey)}
                    </span>
                    <p className="mt-0.5 text-muted">{t(item.detailKey)}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="mt-1.5 text-xs font-semibold text-muted">
              {t("pictureDescription.gradeHintsCollapsedNote", {
                grade: effectiveGradeMemo,
              })}
            </p>
          )}
        </div>
      </div>
    );
  }, [
    activeModeSpec.audioHintKey,
    calmSound,
    effectiveGradeMemo,
    isLowerGradeMemo,
    isUpperGradeMemo,
    playingSpeechKey,
    session,
    showGradeHintChips,
    speakVietnamese,
    t,
    teachingMode,
  ]);

  const teachingModeHeaderAndPills = useMemo(
    () => (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
            {adaptTeacherText(t("pictureDescription.teachingModeHeading"))}
          </p>
          <Button
            disabled={!calmSound}
            fullWidth={false}
            onClick={() =>
              void speakVietnamese(
                t(activeModeSpec.audioHintKey),
                `mode-cue:${teachingMode}`,
                { adaptPersona: true },
              )
            }
            size="compact"
            type="button"
            variant="secondary"
          >
            {playingSpeechKey === `mode-cue:${teachingMode}` ? (
              <>
                <VolumeX aria-hidden="true" className="size-3.5" />
                {t("pictureDescription.stopListen")}
              </>
            ) : (
              <>
                <Volume2 aria-hidden="true" className="size-3.5" />
                {t("pictureDescription.listenModeButton")}
              </>
            )}
          </Button>
        </div>
        <div
          className="mt-2.5 flex flex-wrap gap-2"
          data-testid="teaching-mode-pills"
          role="group"
          aria-label={t("pictureDescription.teachingModeGroupAria")}
        >
          {TEACHING_MODE_SPECS.map((mode) => {
            const active = teachingMode === mode.id;
            return (
              <button
                aria-pressed={active}
                className={
                  "min-h-9 rounded-full border px-3.5 py-1.5 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                  (active
                    ? "border-primary bg-primary text-white shadow-2xs"
                    : "border-border bg-sky/30 text-ink hover:border-primary hover:bg-sky")
                }
                key={mode.id}
                onClick={() => setTeachingMode(mode.id)}
                type="button"
              >
                {t(mode.labelKey)}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs font-semibold text-muted">
          {t(activeModeSpec.cueKey)}
        </p>
      </>
    ),
    [
      activeModeSpec.audioHintKey,
      activeModeSpec.cueKey,
      adaptTeacherText,
      calmSound,
      playingSpeechKey,
      speakVietnamese,
      t,
      teachingMode,
    ],
  );

  const guidingQuestionsList = useMemo(() => {
    if (!session) return null;
    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
            {t("pictureDescription.guidingQuestionsTitle")}
          </p>
          <Button
            fullWidth={false}
            onClick={() =>
              void speakVietnamese(
                session.guide.guiding_questions.join(" "),
                "guide",
              )
            }
            size="compact"
            type="button"
            variant="secondary"
          >
            {playingSpeechKey === "guide" ? (
              <>
                <VolumeX aria-hidden="true" className="size-4" />
                {t("pictureDescription.stopGuideRead")}
              </>
            ) : (
              <>
                <Volume2 aria-hidden="true" className="size-4" />
                {t("pictureDescription.listenGuide")}
              </>
            )}
          </Button>
        </div>

        <ol className="mt-3 flex flex-col gap-2">
          {session.guide.guiding_questions.map((question, index) => (
            <li
              className="flex items-start gap-2 rounded-control bg-sky/30 px-3 py-2 text-sm font-bold text-ink"
              key={question}
            >
              <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-extrabold text-white">
                {index + 1}
              </span>
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {adaptTeacherText(question)}
              </span>
            </li>
          ))}
        </ol>
      </>
    );
  }, [adaptTeacherText, playingSpeechKey, session, speakVietnamese, t]);

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-6">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-96 w-full rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[780px] flex-col gap-4">
        <StatusMessage tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t("pictureDescription.childLoadError")}</span>
            <Button
              className="w-auto"
              onClick={retryChild}
              size="compact"
              variant="secondary"
            >
              {t("pictureDescription.retry")}
            </Button>
          </div>
        </StatusMessage>
      </section>
    );
  }

  const selectedChild = childState.child;
  const latestAttempt = session?.attempts[0] ?? null;
  const activeAttempt: PictureAttemptDTO | null = session
    ? (session.attempts.find((item) => item.attempt_id === selectedAttemptId) ??
      latestAttempt)
    : null;
  const previousAttemptForActive: PictureAttemptDTO | null =
    session && activeAttempt
      ? (session.attempts.find(
          (item) => item.attempt_number === activeAttempt.attempt_number - 1,
        ) ?? null)
      : null;
  const scoreDelta =
    activeAttempt && previousAttemptForActive
      ? activeAttempt.score_out_of_10 - previousAttemptForActive.score_out_of_10
      : null;

  const hasSubmittedAttempt = Boolean(
    session && (session.attempts_count >= 1 || latestAttempt),
  );
  const effectiveGrade = session?.child_grade ?? selectedChild.grade;
  const targetWords = session
    ? Array.from(
        new Set([
          ...(session.target_vocabulary ?? []),
          ...(session.target_words ?? []),
          ...(session.guide.target_words ?? []),
          ...notebookBonusWords,
        ]),
      )
    : [];
  const usedTargetWordsCount = targetWords.filter(
    (word) =>
      normalizedContainsTerm(normalizedDescription, word) ||
      descriptionContainsTerm(liveTranscript, word) ||
      (latestAttempt?.practiced_difficult_words?.some((item) =>
        descriptionContainsTerm(item, word),
      ) ??
        false),
  ).length;
  const draftWordCount = countMeaningfulWords(descriptionText);
  const draftReadiness = readinessHint(draftWordCount, effectiveGrade, t);
  const usedVocabCount = session
    ? session.guide.suggested_vocabulary.filter((item) =>
        normalizedContainsTerm(normalizedDescription, item.word),
      ).length
    : 0;
  const liveTranscriptReady = countMeaningfulWords(liveTranscript) >= 2;
  const activeSilenceKey = liveTranscriptReady
    ? `stt:${liveTranscript}`
    : !hasLiveSpeechRecognition && silenceCountdown?.key === "vad-silence"
      ? "vad-silence"
      : null;
  const silenceAutoEligible =
    isRecordingVoice &&
    autoPlayFlow &&
    !autoSubmitPaused &&
    !isEvaluating &&
    !isTranscribing &&
    !recorder.isSpeaking &&
    activeSilenceKey !== null;
  const effectiveSilenceRemainingMs = silenceAutoEligible
    ? silenceCountdown?.key === activeSilenceKey
      ? silenceCountdown.remainingMs
      : SILENCE_AUTO_SUBMIT_MS
    : null;

  const samplesTotal =
    catalogState.status === "ready" ? catalogState.catalog.samples.length : 0;
  const safeSamplesPage = Math.min(
    Math.max(1, samplesPage),
    Math.max(1, Math.ceil(samplesTotal / PICTURE_GRID_PAGE_SIZE)),
  );
  const bookPagesTotal =
    catalogState.status === "ready"
      ? catalogState.catalog.book_pages.length
      : 0;
  const safeBookPagesPage = Math.min(
    Math.max(1, bookPagesPage),
    Math.max(1, Math.ceil(bookPagesTotal / PICTURE_GRID_PAGE_SIZE)),
  );
  const sessionsTotal =
    catalogState.status === "ready" ? catalogState.sessions.length : 0;
  const safeSessionsPage = Math.min(
    Math.max(1, sessionsPage),
    Math.max(1, Math.ceil(sessionsTotal / PICTURE_GRID_PAGE_SIZE)),
  );
  const attemptsTotal = session ? session.attempts.length : 0;
  const safeAttemptsPage = Math.min(
    Math.max(1, attemptsPage),
    Math.max(1, Math.ceil(attemptsTotal / ATTEMPTS_PAGE_SIZE)),
  );
  const attemptsStartIndex = (safeAttemptsPage - 1) * ATTEMPTS_PAGE_SIZE;
  const visibleAttempts = session
    ? session.attempts.slice(
        attemptsStartIndex,
        attemptsStartIndex + ATTEMPTS_PAGE_SIZE,
      )
    : [];

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-[1130px] flex-col gap-6 pb-8",
        reducedMotion && "motion-reduce",
      )}
      data-auto-play-flow={autoPlayFlow ? "true" : "false"}
      data-autopilot={autopilotEnabled ? "true" : "false"}
      data-calm-sound={calmSound ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      {headerBlock}

      {childId ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-amber-200 bg-amber-50/75 px-4 py-2.5"
          data-testid="picture-notebook-bridge-bar"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-amber-950">
              <BookHeart aria-hidden="true" className="size-4 text-amber-700" />
              {tGlossary("bonusStoryWordsLabel")}
            </span>
            {notebookBonusWords.length > 0 ? (
              notebookBonusWords.map((word) => (
                <button
                  className="viread-learning-content inline-flex min-h-8 items-center gap-1 rounded-full border border-amber-300 bg-white px-3 py-0.5 text-xs font-extrabold text-amber-950 transition hover:bg-amber-100"
                  data-testid={`picture-notebook-word-${word}`}
                  dir="ltr"
                  key={word}
                  lang="vi"
                  onClick={() => {
                    if (session) {
                      handleInsertVocabWord(word);
                    } else if (calmSound) {
                      void speechPlayer
                        .play(word, {
                          wordSample: true,
                          bypassSessionLock: true,
                        })
                        .catch(() => undefined);
                    }
                  }}
                  type="button"
                >
                  <Sparkles
                    aria-hidden="true"
                    className="size-3 text-amber-600"
                  />
                  {word}
                </button>
              ))
            ) : (
              <span className="text-xs font-semibold text-muted">
                {tGlossary("bonusStoryWordsHint")}
              </span>
            )}
          </div>
          <Button
            className="min-h-9 w-auto!"
            data-testid="picture-open-notebook-btn"
            onClick={() => setNotebookDrawerOpen(true)}
            size="compact"
            type="button"
            variant="secondary"
          >
            <BookHeart aria-hidden="true" className="size-3.5" />
            {activeNotebook && activeNotebook.total > 0
              ? tGlossary("hubNotebookButton", { count: activeNotebook.total })
              : tGlossary("hubNotebookButtonEmpty")}
          </Button>
        </div>
      ) : null}

      {childId ? (
        <VocabularyNotebookDrawer
          childAlias={selectedChild.alias}
          childId={childId}
          initialNotebook={activeNotebook}
          onClose={() => setNotebookDrawerOpen(false)}
          onNotebookChange={setNotebookData}
          open={notebookDrawerOpen}
          service={resolvedVocabService}
          showGameLinks={false}
          speechPlayer={speechPlayer}
        />
      ) : null}

      {actionError ? (
        <StatusMessage tone="error">{actionError}</StatusMessage>
      ) : null}

      {isAnalyzing ? (
        <div
          aria-live="polite"
          className="flex flex-col items-center justify-center gap-4 rounded-card border border-border bg-white p-10 text-center shadow-sm"
        >
          <LoaderCircle
            aria-hidden="true"
            className={cn(
              "size-8 text-primary",
              !reducedMotion && "animate-spin",
            )}
          />
          <h2 className="text-xl font-extrabold text-ink">
            {t("pictureDescription.analyzingTitle")}
          </h2>
          <p className="max-w-md text-body text-muted">
            {t("pictureDescription.analyzingDesc", {
              grade: selectedChild.grade,
            })}
          </p>
          <div className="w-full max-w-md">
            <AiProgressBar
              active
              elapsedSeconds={analyzeProgress.elapsedSeconds}
              label={
                analyzeProgress.stageLabel ?? tCommon("aiProgress.analyzing")
              }
              percent={analyzeProgress.percent}
              size="md"
              testId="picture-analyzing-progress"
            />
          </div>
        </div>
      ) : null}

      {!session && !isAnalyzing ? (
        <>
          {catalogState.status === "ready" ? (
            <div
              className="flex flex-col gap-3 rounded-card border-2 border-primary/35 bg-gradient-to-br from-sky/60 via-white to-emerald-50/50 p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between"
              data-testid="picture-catalog-autopilot-card"
            >
              <div className="flex flex-col gap-2">
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-primary">
                  <Sparkles aria-hidden="true" className="size-3.5" />
                  {t("pictureDescription.practicingWordsBadge")}
                </span>
                {catalogState.catalog.focus_difficult_words &&
                catalogState.catalog.focus_difficult_words.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {catalogState.catalog.focus_difficult_words.map((word) => (
                      <span
                        className="viread-learning-content rounded-full border border-primary/30 bg-white px-3 py-1 text-xs font-extrabold text-primary shadow-2xs"
                        dir="ltr"
                        key={word}
                        lang="vi"
                      >
                        {word}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm font-bold text-ink">
                    {adaptTeacherText(
                      t("pictureDescription.openingAutopilotPrompt"),
                    )}
                  </p>
                )}
              </div>
              <Button
                className="shrink-0"
                data-testid="picture-quick-play-btn"
                fullWidth={false}
                onClick={() =>
                  void handleAutoSelectSession({ enableAutopilot: true })
                }
                type="button"
              >
                <Sparkles aria-hidden="true" className="size-4" />
                {t("pictureDescription.quickPlayAutopilotBtn")}
              </Button>
            </div>
          ) : null}

          <div className="rounded-card border border-border bg-white p-5 shadow-sm sm:p-7">
            <div
              aria-label={t("pictureDescription.sourceTabsAria")}
              className="flex flex-wrap gap-2 border-b border-border pb-4"
              role="tablist"
            >
              {(
                [
                  {
                    id: "SAMPLE",
                    label: t("pictureDescription.tabSample"),
                    icon: Images,
                  },
                  {
                    id: "CUSTOM_UPLOAD",
                    label: t("pictureDescription.tabCustomUpload"),
                    icon: ImagePlus,
                  },
                  {
                    id: "BOOK_PAGE",
                    label: t("pictureDescription.tabBookPage"),
                    icon: BookOpen,
                  },
                ] as const
              ).map(({ id, label, icon: Icon }) => {
                const selected = activeTab === id;
                return (
                  <button
                    aria-selected={selected}
                    className={
                      "inline-flex min-h-11 items-center gap-2 rounded-control px-4 py-2 text-sm font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                      (selected
                        ? "bg-primary text-white shadow-sm"
                        : "bg-sky/50 text-ink hover:bg-sky")
                    }
                    key={id}
                    onClick={() => setActiveTab(id)}
                    role="tab"
                    type="button"
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {label}
                  </button>
                );
              })}
            </div>

            {catalogState.status === "loading" ? (
              <div className="mt-6 grid gap-5 md:grid-cols-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton className="h-72 rounded-card" key={item} />
                ))}
              </div>
            ) : catalogState.status === "error" ? (
              <div className="mt-6">
                <StatusMessage tone="error">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>{catalogState.message}</span>
                    <Button
                      className="w-auto"
                      onClick={() => {
                        setCatalogState({ status: "loading" });
                        setCatalogRefreshKey((value) => value + 1);
                      }}
                      size="compact"
                      variant="secondary"
                    >
                      <RefreshCw aria-hidden="true" className="size-4" />
                      {t("pictureDescription.retry")}
                    </Button>
                  </div>
                </StatusMessage>
              </div>
            ) : (
              <div className="mt-6">
                {activeTab === "SAMPLE" ? (
                  <>
                    <div className="grid gap-5 md:grid-cols-3">
                      {catalogState.catalog.samples
                        .slice(
                          (safeSamplesPage - 1) * PICTURE_GRID_PAGE_SIZE,
                          safeSamplesPage * PICTURE_GRID_PAGE_SIZE,
                        )
                        .map((sample) => {
                          const existing = sampleSessionMap.get(
                            sample.sample_key,
                          );
                          const hasPriorAttempt = Boolean(
                            existing && existing.attempts_count > 0,
                          );
                          return (
                            <article
                              className={cn(
                                "flex flex-col overflow-hidden rounded-card border border-border bg-white shadow-sm",
                                !reducedMotion &&
                                  "transition-transform hover:-translate-y-0.5",
                              )}
                              key={sample.sample_key}
                            >
                              <div className="relative aspect-[4/3] w-full overflow-hidden bg-sky/40">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  alt={sample.title}
                                  className="h-full w-full object-cover"
                                  src={sample.image_url}
                                />
                                <span
                                  className="viread-learning-content absolute start-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-extrabold text-primary shadow-sm"
                                  dir="ltr"
                                  lang="vi"
                                >
                                  {sample.theme}
                                </span>
                                {hasPriorAttempt && existing ? (
                                  <span className="absolute end-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-extrabold text-success-ink shadow-sm">
                                    {t("pictureDescription.starsBadge", {
                                      count: existing.best_stars,
                                    })}
                                  </span>
                                ) : null}
                              </div>
                              <div className="flex flex-1 flex-col justify-between gap-4 p-4">
                                <div>
                                  <h2
                                    className="viread-learning-content text-lg font-extrabold text-ink"
                                    dir="ltr"
                                    lang="vi"
                                  >
                                    {sample.title}
                                  </h2>
                                  <p className="mt-1 text-sm text-muted">
                                    {hasPriorAttempt && existing
                                      ? t(
                                          "pictureDescription.sampleAttemptsSummary",
                                          {
                                            count: existing.attempts_count,
                                            score: existing.best_score,
                                          },
                                        )
                                      : t(
                                          "pictureDescription.sampleDefaultPrompt",
                                        )}
                                  </p>
                                  {sample.matched_difficult_words &&
                                  sample.matched_difficult_words.length > 0 ? (
                                    <p
                                      className="viread-learning-content mt-2 inline-flex w-fit items-center rounded-full border border-emerald-300 bg-success-surface px-2.5 py-0.5 text-xs font-extrabold text-success-ink"
                                      dir="ltr"
                                      lang="vi"
                                    >
                                      {t(
                                        "pictureDescription.cardDifficultWordsTag",
                                        {
                                          words:
                                            sample.matched_difficult_words.join(
                                              ", ",
                                            ),
                                        },
                                      )}
                                    </p>
                                  ) : null}
                                </div>
                                <div className="flex flex-col gap-2">
                                  <Button
                                    onClick={() =>
                                      void handleStartSample(sample)
                                    }
                                    type="button"
                                  >
                                    {hasPriorAttempt
                                      ? t(
                                          "pictureDescription.viewResultsAndContinue",
                                        )
                                      : t("pictureDescription.explorePicture")}
                                  </Button>
                                  {hasPriorAttempt ? (
                                    <Button
                                      onClick={() =>
                                        void handleCreateSampleSession(sample, {
                                          refreshAiGuide: true,
                                        })
                                      }
                                      size="compact"
                                      type="button"
                                      variant="secondary"
                                    >
                                      {t("pictureDescription.createNewGuide")}
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                    </div>
                    <PaginationBar
                      ariaLabel={t("pictureDescription.samplesPaginationAria")}
                      className="mt-4"
                      compact
                      itemLabel={t("pictureDescription.samplesPaginationItem")}
                      onPageChange={setSamplesPage}
                      page={safeSamplesPage}
                      pageSize={PICTURE_GRID_PAGE_SIZE}
                      total={catalogState.catalog.samples.length}
                    />
                  </>
                ) : null}

                {activeTab === "CUSTOM_UPLOAD" ? (
                  <div className="grid items-start gap-6 lg:grid-cols-[1.05fr_0.95fr]">
                    <div className="flex flex-col gap-4 rounded-card border-2 border-dashed border-primary/40 bg-sky/20 p-6">
                      <div className="flex items-start gap-3">
                        <Upload
                          aria-hidden="true"
                          className="mt-1 size-6 shrink-0 text-primary"
                        />
                        <div>
                          <h2 className="text-lg font-extrabold text-ink">
                            {t("pictureDescription.uploadHeading")}
                          </h2>
                          <p className="mt-1 text-sm text-muted">
                            {t("pictureDescription.uploadLead")}
                          </p>
                        </div>
                      </div>

                      <input
                        accept="image/jpeg,image/png,image/webp"
                        aria-label={t("pictureDescription.uploadInputAria")}
                        className="sr-only"
                        onChange={handleFileChange}
                        ref={fileInputRef}
                        type="file"
                      />

                      <div className="flex flex-wrap items-center gap-2.5">
                        <Button
                          fullWidth={false}
                          onClick={() => fileInputRef.current?.click()}
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          <ImagePlus aria-hidden="true" className="size-4" />
                          {uploadFile
                            ? t("pictureDescription.changePhoto")
                            : t("pictureDescription.chooseFromDevice")}
                        </Button>
                        {uploadFile ? (
                          <Button
                            fullWidth={false}
                            onClick={() => void handleStartUpload()}
                            size="compact"
                            type="button"
                          >
                            <Sparkles aria-hidden="true" className="size-4" />
                            {t("pictureDescription.analyzeAndStart")}
                          </Button>
                        ) : null}
                      </div>

                      {uploadFile ? (
                        <p className="text-sm font-bold text-primary">
                          {t("pictureDescription.selectedFile", {
                            name: uploadFile.name,
                          })}
                        </p>
                      ) : null}
                      {uploadError ? (
                        <StatusMessage tone="error">
                          {uploadError}
                        </StatusMessage>
                      ) : null}
                    </div>

                    <div className="flex min-h-[240px] items-center justify-center overflow-hidden rounded-card border border-border bg-white p-3">
                      {uploadPreviewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt={t("pictureDescription.uploadPreviewAlt")}
                          className="max-h-72 w-full rounded-control object-contain"
                          src={uploadPreviewUrl}
                        />
                      ) : (
                        <p className="text-center text-sm font-semibold text-muted">
                          {t("pictureDescription.uploadPreviewEmpty")}
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeTab === "BOOK_PAGE" ? (
                  catalogState.catalog.book_pages.length > 0 ? (
                    <>
                      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {catalogState.catalog.book_pages
                          .slice(
                            (safeBookPagesPage - 1) * PICTURE_GRID_PAGE_SIZE,
                            safeBookPagesPage * PICTURE_GRID_PAGE_SIZE,
                          )
                          .map((page) => {
                            const existing = bookPageSessionMap.get(
                              page.page_id,
                            );
                            const hasPriorAttempt = Boolean(
                              existing && existing.attempts_count > 0,
                            );
                            const isPinnedPage = Boolean(
                              initialPageId && page.page_id === initialPageId,
                            );
                            return (
                              <article
                                className={cn(
                                  "flex flex-col overflow-hidden rounded-card border bg-white shadow-sm",
                                  isPinnedPage
                                    ? "border-2 border-primary ring-2 ring-primary/20"
                                    : "border-border",
                                )}
                                data-pinned-book-page={
                                  isPinnedPage ? "true" : undefined
                                }
                                key={page.page_id}
                              >
                                <div className="relative aspect-[4/3] w-full overflow-hidden bg-sky/30">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    alt={t(
                                      "pictureDescription.bookPageImageAlt",
                                      {
                                        title: page.book_title,
                                        page: page.page_number,
                                      },
                                    )}
                                    className="h-full w-full object-cover"
                                    src={page.image_url}
                                  />
                                  {page.has_verified_illustration ? (
                                    <span className="absolute start-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-extrabold text-primary shadow-sm">
                                      {t(
                                        "pictureDescription.studioIllustrationBadge",
                                      )}
                                    </span>
                                  ) : null}
                                  {hasPriorAttempt && existing ? (
                                    <span className="absolute end-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-extrabold text-success-ink shadow-sm">
                                      {t("pictureDescription.starsBadge", {
                                        count: existing.best_stars,
                                      })}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="flex flex-1 flex-col justify-between gap-3 p-4">
                                  <div>
                                    <h2
                                      className="viread-learning-content line-clamp-1 text-base font-extrabold text-ink"
                                      dir="ltr"
                                      lang="vi"
                                    >
                                      {page.book_title}
                                    </h2>
                                    <p className="text-sm font-semibold text-muted">
                                      {t("pictureDescription.bookPageNumber", {
                                        page: page.page_number,
                                      })}
                                      {hasPriorAttempt && existing
                                        ? t(
                                            "pictureDescription.bookPageAttemptsSuffix",
                                            {
                                              count: existing.attempts_count,
                                            },
                                          )
                                        : ""}
                                    </p>
                                    {page.matched_difficult_words &&
                                    page.matched_difficult_words.length > 0 ? (
                                      <p
                                        className="viread-learning-content mt-1.5 inline-flex w-fit items-center rounded-full border border-emerald-300 bg-success-surface px-2.5 py-0.5 text-xs font-extrabold text-success-ink"
                                        dir="ltr"
                                        lang="vi"
                                      >
                                        {t(
                                          "pictureDescription.cardDifficultWordsTag",
                                          {
                                            words:
                                              page.matched_difficult_words.join(
                                                ", ",
                                              ),
                                          },
                                        )}
                                      </p>
                                    ) : null}
                                  </div>
                                  <div className="flex flex-col gap-2">
                                    <Button
                                      onClick={() =>
                                        void handleStartBookPage(page)
                                      }
                                      type="button"
                                    >
                                      {hasPriorAttempt
                                        ? t(
                                            "pictureDescription.viewResultsAndContinue",
                                          )
                                        : t(
                                            "pictureDescription.describeThisPage",
                                          )}
                                    </Button>
                                    {hasPriorAttempt ? (
                                      <Button
                                        onClick={() =>
                                          void handleCreateBookPageSession(page)
                                        }
                                        size="compact"
                                        type="button"
                                        variant="secondary"
                                      >
                                        {t("pictureDescription.createNewGuide")}
                                      </Button>
                                    ) : null}
                                  </div>
                                </div>
                              </article>
                            );
                          })}
                      </div>
                      <PaginationBar
                        ariaLabel={t(
                          "pictureDescription.bookPagesPaginationAria",
                        )}
                        className="mt-4"
                        compact
                        itemLabel={t(
                          "pictureDescription.bookPagesPaginationItem",
                        )}
                        onPageChange={setBookPagesPage}
                        page={safeBookPagesPage}
                        pageSize={PICTURE_GRID_PAGE_SIZE}
                        total={catalogState.catalog.book_pages.length}
                      />
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3">
                      <EmptyState
                        description={t("pictureDescription.emptyBookPagesDesc")}
                        title={t("pictureDescription.emptyBookPagesTitle")}
                      />
                      {catalogState.catalog.samples.length > 0 ? (
                        <Button
                          className="sm:w-auto"
                          data-testid="picture-empty-focus-bridge-cta"
                          onClick={() => {
                            setEphemeralFocusCleared(false);
                            setActiveTab("SAMPLE");
                            const firstSample = catalogState.catalog.samples[0];
                            if (firstSample) {
                              void handleCreateSampleSession(firstSample);
                            }
                          }}
                          size="compact"
                          type="button"
                        >
                          <Sparkles aria-hidden="true" className="size-4" />
                          {t("pictureDescription.emptyBookPagesBridgeCta")}
                        </Button>
                      ) : null}
                    </div>
                  )
                ) : null}
              </div>
            )}
          </div>

          {catalogState.status === "ready" &&
          catalogState.sessions.length > 0 ? (
            <section className="rounded-card border border-border bg-white p-5 shadow-sm sm:p-7">
              <h2 className="flex items-center gap-2 text-lg font-extrabold text-ink">
                <History aria-hidden="true" className="size-5 text-primary" />
                {t("pictureDescription.recentHeading")}
              </h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {catalogState.sessions
                  .slice(
                    (safeSessionsPage - 1) * PICTURE_GRID_PAGE_SIZE,
                    safeSessionsPage * PICTURE_GRID_PAGE_SIZE,
                  )
                  .map((item) => (
                    <button
                      className="flex items-center gap-3 rounded-control border border-border bg-white p-3 text-start transition-colors hover:border-primary hover:bg-sky/20 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      key={item.session_id}
                      onClick={() => void handleResumeSession(item.session_id)}
                      type="button"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        alt={item.scene_title}
                        className="size-16 shrink-0 rounded-control object-cover"
                        src={item.image_url}
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className="viread-learning-content truncate font-extrabold text-ink"
                          dir="ltr"
                          lang="vi"
                        >
                          {item.scene_title}
                        </p>
                        <p className="text-xs font-semibold text-muted">
                          {sourceLabel(item.source_type, t)} •{" "}
                          {item.attempts_count > 0
                            ? t("pictureDescription.recentAttemptsCount", {
                                count: item.attempts_count,
                              })
                            : t("pictureDescription.recentNoAttempts")}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          {renderStars(
                            item.best_stars,
                            t("pictureDescription.starsAria", {
                              count: item.best_stars,
                            }),
                          )}
                          {item.best_score > 0 ? (
                            <span className="text-xs font-extrabold text-primary">
                              {t("pictureDescription.recentScoreBadge", {
                                score: item.best_score,
                              })}
                            </span>
                          ) : (
                            <span className="text-xs font-semibold text-muted">
                              {t("pictureDescription.recentInProgress")}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
              <PaginationBar
                ariaLabel={t("pictureDescription.recentPaginationAria")}
                className="mt-4"
                compact
                itemLabel={t("pictureDescription.recentPaginationItem")}
                onPageChange={setSessionsPage}
                page={safeSessionsPage}
                pageSize={PICTURE_GRID_PAGE_SIZE}
                total={catalogState.sessions.length}
              />
            </section>
          ) : null}
        </>
      ) : null}

      {session && !isAnalyzing ? (
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_1.15fr]">
          {/* Picture Frame */}
          {pictureFrameColumn}

          {/* Interactive Recording + Optional Collapsed Hints + Evaluation Column */}
          <div className="flex flex-col gap-5">
            <div
              aria-label={t("pictureDescription.modeTabsAria")}
              className="flex flex-wrap gap-2 rounded-card border border-border bg-white p-2 shadow-sm"
              role="tablist"
            >
              <button
                aria-selected={practiceTab === "PRACTICE"}
                className={
                  "inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                  (practiceTab === "PRACTICE"
                    ? "bg-primary text-white shadow-sm"
                    : "bg-sky/40 text-ink hover:bg-sky")
                }
                id="tab-picture-practice"
                onClick={() => setPracticeTab("PRACTICE")}
                role="tab"
                type="button"
              >
                <Sparkles aria-hidden="true" className="size-4" />
                {t("pictureDescription.tabPractice")}
              </button>
              <button
                aria-selected={practiceTab === "RESULT"}
                className={
                  "inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 " +
                  (practiceTab === "RESULT"
                    ? "bg-primary text-white shadow-sm"
                    : "bg-sky/40 text-ink hover:bg-sky")
                }
                disabled={!activeAttempt}
                id="tab-picture-result"
                onClick={() => {
                  if (!activeAttempt) return;
                  cancelMicCountdown();
                  cancelAutoSubmit();
                  if (isRecordingVoice) {
                    void stopVoiceRecording();
                  }
                  setPracticeTab("RESULT");
                }}
                role="tab"
                type="button"
              >
                <Star aria-hidden="true" className="size-4" />
                {t("pictureDescription.tabResult")}
                {latestAttempt ? (
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-xs font-extrabold " +
                      (practiceTab === "RESULT"
                        ? "bg-white/20 text-white"
                        : "bg-success-surface text-success-ink")
                    }
                  >
                    {latestAttempt.score_out_of_10}/10
                  </span>
                ) : null}
              </button>
            </div>

            {practiceTab === "PRACTICE" ? (
              <>
                {/* Teaching Mode Selector Pills (6 Pedagogical Modes V4.0) */}
                <section
                  aria-label={adaptTeacherText(
                    t("pictureDescription.teachingModeSectionAria"),
                  )}
                  className="rounded-card border border-border bg-white p-4 shadow-sm"
                >
                  {teachingModeHeaderAndPills}

                  {targetWords.length > 0 ? (
                    <div
                      className="mt-3 border-t border-border pt-3"
                      data-testid="target-words-panel"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-extrabold text-primary">
                            {t("pictureDescription.practicingWordsBadge")}
                          </span>
                          <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
                            {t("pictureDescription.targetWordsProgress", {
                              used: usedTargetWordsCount,
                              total: targetWords.length,
                            })}
                          </p>
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {targetWords.map((word) => {
                          const used =
                            normalizedContainsTerm(
                              normalizedDescription,
                              word,
                            ) ||
                            descriptionContainsTerm(liveTranscript, word) ||
                            (latestAttempt?.feedback.used_target_words?.some(
                              (item) => descriptionContainsTerm(item, word),
                            ) ??
                              false) ||
                            (latestAttempt?.practiced_difficult_words?.some(
                              (item) => descriptionContainsTerm(item, word),
                            ) ??
                              false);
                          return (
                            <button
                              className={
                                "viread-learning-content inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-extrabold transition-colors " +
                                (used
                                  ? "border-success-ink/40 bg-success-surface text-success-ink"
                                  : "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100")
                              }
                              data-word-matched={used ? "true" : "false"}
                              dir="ltr"
                              key={word}
                              lang="vi"
                              onClick={() =>
                                void speakVietnamese(
                                  word,
                                  `target-word:${word}`,
                                )
                              }
                              type="button"
                            >
                              {used ? (
                                <CheckCircle2
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                              ) : (
                                <Volume2
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                              )}
                              {word}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </section>

                {/* Active PEER/CROWD Follow-Up Prompt when Child Replies to AI Teacher */}
                {activeFollowUpQuestion ? (
                  <section
                    aria-label={adaptTeacherText(
                      t("pictureDescription.followUpSectionAria"),
                    )}
                    className="rounded-card border border-amber-300/70 bg-amber-50/70 p-4"
                    data-testid="practice-followup-banner"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-amber-900">
                        <Sparkles aria-hidden="true" className="size-4" />
                        {adaptTeacherText(
                          t("pictureDescription.practiceFollowUpTitle"),
                        )}
                      </p>
                      <Button
                        disabled={!calmSound}
                        onClick={() =>
                          void speakVietnamese(
                            activeFollowUpQuestion,
                            "practice-followup",
                            { adaptPersona: true },
                          )
                        }
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        <Volume2 aria-hidden="true" className="size-3.5" />
                        {playingSpeechKey === "practice-followup"
                          ? t("pictureDescription.stopShort")
                          : t("pictureDescription.listenQuestionButton")}
                      </Button>
                    </div>
                    <p
                      className="viread-learning-content mt-1.5 text-sm font-bold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {adaptTeacherText(activeFollowUpQuestion)}
                    </p>
                  </section>
                ) : null}

                {/* Coaching Reminder from Previous Attempt so Child Knows What to Improve */}
                {latestAttempt ? (
                  <section
                    aria-label={t("pictureDescription.previousCoachingAria")}
                    className="rounded-card border border-primary/25 bg-sky/20 p-4"
                  >
                    <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-primary">
                      <Lightbulb aria-hidden="true" className="size-4" />
                      {adaptTeacherText(
                        t("pictureDescription.previousCoachingTitle", {
                          attempt: latestAttempt.attempt_number,
                        }),
                      )}
                    </p>
                    <p
                      className="viread-learning-content mt-1 text-sm font-semibold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {adaptTeacherText(latestAttempt.feedback.improvement_tip)}
                    </p>
                    {latestAttempt.feedback.missed_details.length > 0 ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-bold text-muted">
                          {t("pictureDescription.missedDetailsHintLabel")}
                        </span>
                        {latestAttempt.feedback.missed_details.map((detail) => (
                          <span
                            className="viread-learning-content rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-ink shadow-2xs"
                            dir="ltr"
                            key={detail}
                            lang="vi"
                          >
                            {detail}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {effectiveDueFocusWords.length > 0 && !ephemeralFocusCleared ? (
                  <section
                    className="rounded-card border-2 border-amber-300 bg-gradient-to-r from-amber-50 via-white to-sky/50 p-4 shadow-2xs"
                    data-testid="picture-ephemeral-focus-bar"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-sm font-extrabold text-amber-950">
                        <Sparkles
                          aria-hidden="true"
                          className="size-4 text-amber-600"
                        />
                        {t("pictureDescription.ephemeralFocusBarTitle")}
                      </p>
                      <button
                        className="text-xs font-bold text-muted underline hover:text-ink"
                        data-testid="picture-ephemeral-focus-dismiss"
                        onClick={() => setEphemeralFocusCleared(true)}
                        type="button"
                      >
                        {t("hub.onboardingClose")}
                      </button>
                    </div>
                    <p className="mt-1 text-xs font-semibold text-muted">
                      {t("pictureDescription.ephemeralFocusBarHint")}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {effectiveDueFocusWords.map((word) => (
                        <button
                          className="viread-learning-content inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3.5 py-1 text-xs font-extrabold text-amber-950 shadow-2xs transition hover:border-primary hover:bg-amber-100"
                          data-testid={`picture-ephemeral-word-${word}`}
                          dir="ltr"
                          key={word}
                          lang="vi"
                          onClick={() => speakEphemeralFocusWord(word)}
                          type="button"
                        >
                          <Volume2
                            aria-hidden="true"
                            className="size-3.5 text-amber-700"
                          />
                          ⭐ {word}
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}

                {/* Child Input Area (Mic + Realtime Text + ViRead Vietnamese TTS + Textarea) */}
                <section className="rounded-card border border-border bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-extrabold text-ink">
                      {latestAttempt
                        ? t("pictureDescription.draftHeadingNext", {
                            attempt: session.attempts_count + 1,
                          })
                        : t("pictureDescription.draftHeadingFirst")}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                      {descriptionText.trim() ? (
                        <>
                          <Button
                            disabled={
                              isRecordingVoice || isTranscribing || isEvaluating
                            }
                            fullWidth={false}
                            onClick={handleClearDraft}
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            <Eraser aria-hidden="true" className="size-4" />
                            {t("pictureDescription.clearDraft")}
                          </Button>
                          <Button
                            disabled={isRecordingVoice || isTranscribing}
                            fullWidth={false}
                            onClick={() =>
                              void speakVietnamese(
                                descriptionText,
                                "draft-description",
                              )
                            }
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            {playingSpeechKey === "draft-description" ? (
                              <>
                                <VolumeX
                                  aria-hidden="true"
                                  className="size-4"
                                />
                                {t("pictureDescription.stopListen")}
                              </>
                            ) : (
                              <>
                                <Volume2
                                  aria-hidden="true"
                                  className="size-4"
                                />
                                {t("pictureDescription.replayDraft")}
                              </>
                            )}
                          </Button>
                        </>
                      ) : null}

                      {!isRecordingVoice ? (
                        <>
                          {micCountdown === null ? (
                            <Button
                              className="min-h-11"
                              data-testid="picture-start-countdown-btn"
                              disabled={isTranscribing || isEvaluating}
                              fullWidth={false}
                              onClick={() => {
                                void recorder
                                  .prepare?.()
                                  .catch(() => undefined);
                                startMicCountdown(3);
                              }}
                              size="compact"
                              type="button"
                            >
                              <Sparkles aria-hidden="true" className="size-4" />
                              {t(
                                "pictureDescription.startWithCountdown",
                                undefined,
                                "Bắt đầu miêu tả (3s)",
                              )}
                            </Button>
                          ) : null}
                          <Button
                            className="min-h-11"
                            disabled={isTranscribing || isEvaluating}
                            fullWidth={false}
                            onClick={() => void startVoiceRecording()}
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            <Mic aria-hidden="true" className="size-4" />
                            {t("pictureDescription.speakWithMic")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          className="min-h-11"
                          fullWidth={false}
                          onClick={() => void stopVoiceRecording()}
                          size="compact"
                          type="button"
                          variant="destructive"
                        >
                          <Square aria-hidden="true" className="size-4" />
                          {t("pictureDescription.stopRecording")}
                        </Button>
                      )}
                    </div>
                  </div>

                  {micCountdown !== null && !isRecordingVoice ? (
                    <div
                      aria-live="polite"
                      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-card border-2 border-amber-300 bg-amber-50/90 px-4 py-3 shadow-xs"
                      data-testid="picture-mic-countdown"
                      role="status"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "grid size-11 shrink-0 place-items-center rounded-full bg-amber-500 text-xl font-extrabold text-white shadow-sm",
                            !reducedMotion && "animate-pulse",
                          )}
                          data-testid="picture-mic-countdown-number"
                        >
                          {micCountdown}
                        </span>
                        <div>
                          <p className="text-sm font-extrabold text-amber-950">
                            {t(
                              "pictureDescription.countdownTitle",
                              { seconds: micCountdown },
                              `Chuẩn bị nhé! Tự động bật Micro sau ${micCountdown} giây…`,
                            )}
                          </p>
                          <p className="text-xs font-semibold text-amber-900/80">
                            {t(
                              "pictureDescription.countdownHint",
                              undefined,
                              "Hít một hơi thật sâu, nhìn tranh rồi kể tự nhiên nhé!",
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          className="min-h-10"
                          data-testid="picture-countdown-speak-now"
                          onClick={() => void startVoiceRecording()}
                          size="compact"
                          type="button"
                        >
                          <Mic aria-hidden="true" className="size-4" />
                          {t(
                            "pictureDescription.speakNowAction",
                            undefined,
                            "Nói ngay",
                          )}
                        </Button>
                        <Button
                          className="min-h-10"
                          data-testid="picture-countdown-cancel"
                          onClick={cancelMicCountdown}
                          size="compact"
                          type="button"
                          variant="quiet"
                        >
                          {t(
                            "pictureDescription.cancelCountdownAction",
                            undefined,
                            "Hủy / Gõ chữ",
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {isAutoSubmitPending && !isEvaluating ? (
                    <div
                      aria-live="polite"
                      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-emerald-300 bg-emerald-50/90 px-4 py-3"
                      data-testid="picture-autosubmit-banner"
                      role="status"
                    >
                      <p className="text-sm font-extrabold text-emerald-950">
                        {adaptTeacherText(
                          t(
                            "pictureDescription.autoSubmittingNotice",
                            undefined,
                            "Đang tự động gửi bài kể cho cô giáo AI chấm điểm…",
                          ),
                        )}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          className="min-h-10"
                          onClick={() =>
                            void handleEvaluate(descriptionText, "VOICE")
                          }
                          size="compact"
                          type="button"
                        >
                          <Send aria-hidden="true" className="size-3.5" />
                          {t(
                            "pictureDescription.submitImmediately",
                            undefined,
                            "Gửi ngay",
                          )}
                        </Button>
                        <Button
                          className="min-h-10"
                          data-testid="picture-autosubmit-cancel"
                          onClick={cancelAutoSubmit}
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          {t(
                            "pictureDescription.editBeforeSubmit",
                            undefined,
                            "Sửa lại",
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {isRecordingVoice ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <div
                        aria-live="polite"
                        className="flex items-center gap-3 rounded-control border border-primary/35 bg-sky/25 px-4 py-3 shadow-sm"
                      >
                        <div className="flex shrink-0 items-center gap-2">
                          {recorder.isSpeaking ? (
                            <span
                              aria-hidden="true"
                              className="flex items-center gap-1"
                            >
                              <span
                                className={cn(
                                  "h-4 w-1 rounded-full bg-emerald-500",
                                  !reducedMotion && "animate-pulse",
                                )}
                              />
                              <span
                                className={cn(
                                  "h-6 w-1 rounded-full bg-emerald-500 delay-75",
                                  !reducedMotion && "animate-pulse",
                                )}
                              />
                              <span
                                className={cn(
                                  "h-3 w-1 rounded-full bg-emerald-500 delay-150",
                                  !reducedMotion && "animate-pulse",
                                )}
                              />
                            </span>
                          ) : (
                            <span className="relative flex size-3.5">
                              {!reducedMotion ? (
                                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                              ) : null}
                              <span className="relative inline-flex size-3.5 rounded-full bg-primary" />
                            </span>
                          )}
                          <span className="text-xs font-extrabold uppercase tracking-wider text-primary">
                            {t("pictureDescription.childSpeakingLabel")}
                          </span>
                        </div>
                        <p
                          className="min-w-0 flex-1 text-base font-extrabold text-ink"
                          data-testid="live-voice-transcript"
                        >
                          {liveTranscript ? (
                            <span
                              className="viread-learning-content text-primary underline decoration-2 underline-offset-4"
                              dir="ltr"
                              lang="vi"
                            >
                              &ldquo;{liveTranscript}&rdquo;
                            </span>
                          ) : recorder.isSpeaking ? (
                            <span
                              className={cn(
                                "font-bold text-emerald-700",
                                !reducedMotion && "animate-pulse",
                              )}
                            >
                              {t("pictureDescription.liveRecognizing")}
                            </span>
                          ) : (
                            <span className="text-sm font-medium italic text-muted">
                              {t("pictureDescription.liveListening")}
                            </span>
                          )}
                        </p>
                      </div>

                      {effectiveSilenceRemainingMs !== null ? (
                        <div
                          className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-primary/30 bg-white px-3.5 py-2 text-sm font-bold text-ink shadow-2xs"
                          data-testid="picture-auto-submit-bar"
                          role="status"
                        >
                          <span
                            className="text-primary"
                            data-testid="picture-auto-submit-countdown"
                          >
                            {t("pictureDescription.autoSubmitCountdown", {
                              seconds: formatCountdownSeconds(
                                effectiveSilenceRemainingMs,
                              ),
                            })}
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              data-testid="picture-send-now-btn"
                              fullWidth={false}
                              onClick={() => void triggerAutoVoiceSubmit()}
                              size="compact"
                              type="button"
                            >
                              {t("pictureDescription.submitNowAction")}
                            </Button>
                            <Button
                              data-testid="picture-pause-auto-btn"
                              fullWidth={false}
                              onClick={() => {
                                autopilotRunIdRef.current += 1;
                                clearSilenceTimer();
                                setSilenceCountdown(null);
                                setAutoSubmitPaused(true);
                                setVoiceMessage(
                                  adaptTeacherText(
                                    t("pictureDescription.autoPausedNotice"),
                                  ),
                                );
                              }}
                              size="compact"
                              type="button"
                              variant="quiet"
                            >
                              {t("pictureDescription.pauseAutoAction")}
                            </Button>
                          </div>
                        </div>
                      ) : autoSubmitPaused ? (
                        <p
                          className="text-xs font-semibold text-muted"
                          data-testid="picture-auto-paused-note"
                        >
                          {adaptTeacherText(
                            t("pictureDescription.autoPausedNotice"),
                          )}
                        </p>
                      ) : null}
                    </div>
                  ) : voiceMessage ? (
                    <div className="mt-3">
                      <StatusMessage tone="info">{voiceMessage}</StatusMessage>
                    </div>
                  ) : null}

                  {isTranscribing ? (
                    <div className="mt-3">
                      <AiProgressBar
                        active
                        label={
                          transcribeProgress.stageLabel ??
                          tCommon("aiProgress.transcribing")
                        }
                        percent={transcribeProgress.percent}
                        size="compact"
                        testId="picture-transcribing-progress"
                      />
                    </div>
                  ) : null}

                  <label
                    className="mt-3 block"
                    htmlFor="picture-description-input"
                  >
                    <span className="sr-only">
                      {t("pictureDescription.textareaSrLabel")}
                    </span>
                    <textarea
                      className="viread-learning-content min-h-32 w-full rounded-control border border-border bg-white p-3.5 text-base font-medium text-ink focus:border-primary focus:outline-none"
                      dir="ltr"
                      id="picture-description-input"
                      lang="vi"
                      maxLength={2000}
                      onChange={(event) => {
                        if (isRecordingVoice || isRecordingVoiceRef.current) {
                          abortActiveVoiceCapture({ preserveDraft: true });
                        } else {
                          if (
                            micCountdown !== null ||
                            micCountdownTimerRef.current !== null
                          ) {
                            cancelMicCountdown();
                          }
                          if (
                            isAutoSubmitPending ||
                            autoSubmitTimerRef.current !== null
                          ) {
                            cancelAutoSubmit();
                          }
                        }
                        const nextValue = event.target.value;
                        descriptionTextRef.current = nextValue;
                        setDescriptionText(nextValue);
                        if (isRecordingVoice) {
                          clearSilenceTimer();
                          setSilenceCountdown(null);
                          setAutoSubmitPaused(true);
                        }
                        if (evaluateError) setEvaluateError(null);
                        if (
                          inputMode !== "TEXT" &&
                          (!nextValue.trim() || inputMode !== "VOICE")
                        ) {
                          setInputMode("TEXT");
                        }
                      }}
                      placeholder={t("pictureDescription.textareaPlaceholder")}
                      value={descriptionText}
                    />
                  </label>

                  {isEvaluating ? (
                    <div
                      aria-live="polite"
                      className="mt-3 space-y-2 rounded-control border border-primary/25 bg-sky/25 px-3.5 py-2.5 text-sm font-bold text-primary"
                    >
                      <div className="flex items-center gap-2.5">
                        <RefreshCw
                          aria-hidden="true"
                          className={cn(
                            "size-4 shrink-0",
                            !reducedMotion && "animate-spin",
                          )}
                        />
                        <span>
                          {adaptTeacherText(
                            t("pictureDescription.evaluatingBanner"),
                          )}
                        </span>
                      </div>
                      <AiProgressBar
                        active
                        elapsedSeconds={evaluateProgress.elapsedSeconds}
                        label={
                          evaluateProgress.stageLabel ??
                          tCommon("aiProgress.evaluatingAnswer")
                        }
                        percent={evaluateProgress.percent}
                        size="sm"
                        testId="picture-evaluating-progress"
                      />
                    </div>
                  ) : null}

                  {evaluateError ? (
                    <div className="mt-3">
                      <StatusMessage tone="error">
                        <div className="flex flex-wrap items-center justify-between gap-2.5">
                          <span>{adaptTeacherText(evaluateError)}</span>
                          <Button
                            disabled={isEvaluating || !descriptionText.trim()}
                            onClick={() => void handleEvaluate()}
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            <RefreshCw aria-hidden="true" className="size-4" />
                            {t("pictureDescription.retryEvaluateNow")}
                          </Button>
                        </div>
                      </StatusMessage>
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <p
                        className={
                          "text-xs font-bold " +
                          (draftReadiness.readyFor3Stars
                            ? "text-success-ink"
                            : "text-muted")
                        }
                      >
                        {adaptTeacherText(draftReadiness.label)}
                      </p>
                      <p className="text-xs text-muted">
                        {t("pictureDescription.charCounter", {
                          count: descriptionText.trim().length,
                        })}
                      </p>
                    </div>
                    <Button
                      disabled={
                        isEvaluating ||
                        isRecordingVoice ||
                        isTranscribing ||
                        !descriptionText.trim()
                      }
                      onClick={() => void handleEvaluate()}
                      type="button"
                    >
                      <Send aria-hidden="true" className="size-4" />
                      {adaptTeacherText(
                        isEvaluating
                          ? t("pictureDescription.evaluatingButton")
                          : t("pictureDescription.submitButton"),
                      )}
                    </Button>
                  </div>
                </section>

                {/* Optional Guiding Questions & Vocabulary (Collapsed by default so child thinks independently) */}
                <section className="rounded-card border border-border bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="flex items-center gap-2 text-base font-extrabold text-ink">
                        <Lightbulb
                          aria-hidden="true"
                          className="size-5 text-[#E5A913]"
                        />
                        {t("pictureDescription.hintsHeading")}
                      </h2>
                      {usedVocabCount > 0 ? (
                        <span className="rounded-full bg-success-surface px-2.5 py-0.5 text-xs font-extrabold text-success-ink">
                          {t("pictureDescription.usedVocabBadge", {
                            used: usedVocabCount,
                            total: session.guide.suggested_vocabulary.length,
                          })}
                        </span>
                      ) : null}
                    </div>
                    <Button
                      aria-expanded={showHints}
                      onClick={() => {
                        cancelMicCountdown();
                        setShowHints((value) => !value);
                      }}
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      {showHints ? (
                        <>
                          <ChevronUp aria-hidden="true" className="size-4" />
                          {t("pictureDescription.collapseHints")}
                        </>
                      ) : (
                        <>
                          <ChevronDown aria-hidden="true" className="size-4" />
                          {t("pictureDescription.expandHints")}
                        </>
                      )}
                    </Button>
                  </div>

                  {showHints ? (
                    <div className="mt-4 border-t border-border pt-4">
                      {guidingQuestionsList}

                      <div className="mt-4">
                        <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                          {t("pictureDescription.suggestedVocabTitle")}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {session.guide.suggested_vocabulary.map((item) => {
                            const active = selectedVocabWord === item.word;
                            const used = normalizedContainsTerm(
                              normalizedDescription,
                              item.word,
                            );
                            return (
                              <button
                                className={
                                  "viread-learning-content inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                                  (active
                                    ? "border-primary bg-primary text-white"
                                    : used
                                      ? "border-success-ink/40 bg-success-surface/60 text-success-ink"
                                      : "border-border bg-white text-ink hover:border-primary hover:bg-sky/30")
                                }
                                dir="ltr"
                                key={item.word}
                                lang="vi"
                                onClick={() => {
                                  cancelMicCountdown();
                                  setSelectedVocabWord(item.word);
                                  void speakVietnamese(
                                    item.word,
                                    `vocab:${item.word}`,
                                  );
                                }}
                                type="button"
                              >
                                {used && !active ? (
                                  <CheckCircle2
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                ) : (
                                  <Volume2
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                )}
                                {item.word}
                              </button>
                            );
                          })}
                        </div>
                        {selectedVocabWord ? (
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-control bg-warning-surface/60 px-3 py-2 text-sm font-semibold text-ink">
                            <p
                              className="viread-learning-content"
                              dir="ltr"
                              lang="vi"
                            >
                              <strong>{selectedVocabWord}:</strong>{" "}
                              {
                                session.guide.suggested_vocabulary.find(
                                  (item) => item.word === selectedVocabWord,
                                )?.hint
                              }
                            </p>
                            {!normalizedContainsTerm(
                              normalizedDescription,
                              selectedVocabWord,
                            ) ? (
                              <Button
                                onClick={() =>
                                  handleInsertVocabWord(selectedVocabWord)
                                }
                                size="compact"
                                type="button"
                                variant="secondary"
                              >
                                <Plus aria-hidden="true" className="size-3.5" />
                                {t("pictureDescription.insertIntoDraft")}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-4 border-t border-border pt-3">
                        {!hasSubmittedAttempt ? (
                          <p className="text-sm font-semibold text-muted">
                            {t("pictureDescription.sampleSentencesLocked")}
                          </p>
                        ) : (
                          <>
                            <button
                              className="inline-flex items-center gap-2 text-sm font-extrabold text-primary hover:underline"
                              onClick={() =>
                                setShowSampleSentences((value) => !value)
                              }
                              type="button"
                            >
                              {showSampleSentences ? (
                                <>
                                  <EyeOff
                                    aria-hidden="true"
                                    className="size-4"
                                  />
                                  {t("pictureDescription.hideSampleSentences")}
                                </>
                              ) : (
                                <>
                                  <Eye aria-hidden="true" className="size-4" />
                                  {t("pictureDescription.showSampleSentences")}
                                </>
                              )}
                            </button>
                            {showSampleSentences ? (
                              <ul className="mt-2 flex flex-col gap-2">
                                {session.guide.model_sample_sentences.map(
                                  (sentence, idx) => (
                                    <li
                                      className="flex items-center justify-between gap-2 rounded-control bg-success-surface/50 px-3 py-2 text-sm font-semibold text-success-ink"
                                      key={sentence}
                                    >
                                      <span
                                        className="viread-learning-content"
                                        dir="ltr"
                                        lang="vi"
                                      >
                                        “{sentence}”
                                      </span>
                                      <Button
                                        onClick={() =>
                                          void speakVietnamese(
                                            sentence,
                                            `sample-sentence:${idx}`,
                                          )
                                        }
                                        size="compact"
                                        type="button"
                                        variant="secondary"
                                      >
                                        <Volume2
                                          aria-hidden="true"
                                          className="size-3.5"
                                        />
                                        {playingSpeechKey ===
                                        `sample-sentence:${idx}`
                                          ? t("pictureDescription.stopShort")
                                          : t("pictureDescription.listenShort")}
                                      </Button>
                                    </li>
                                  ),
                                )}
                              </ul>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>
              </>
            ) : null}

            {/* AI Teacher Feedback Card (Dedicated Result Tab) */}
            {practiceTab === "RESULT" && activeAttempt ? (
              <section
                aria-labelledby="tab-picture-result"
                aria-live="polite"
                className="rounded-card border-2 border-primary/25 bg-white p-5 shadow-sm"
                role="tabpanel"
              >
                {session.attempts.length > 1 ? (
                  <div className="mb-4 flex flex-col gap-2 border-b border-border pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-extrabold uppercase tracking-wide text-muted">
                        {t("pictureDescription.attemptHistoryLabel")}
                      </span>
                      {visibleAttempts.map((attempt, offsetIndex) => {
                        const index = attemptsStartIndex + offsetIndex;
                        const isSelected =
                          attempt.attempt_id === activeAttempt.attempt_id;
                        return (
                          <button
                            aria-pressed={isSelected}
                            className={
                              "rounded-full px-3 py-1 text-xs font-extrabold transition-colors " +
                              (isSelected
                                ? "bg-primary text-white shadow-2xs"
                                : "bg-sky/40 text-ink hover:bg-sky")
                            }
                            key={attempt.attempt_id}
                            onClick={() =>
                              setSelectedAttemptId(attempt.attempt_id)
                            }
                            type="button"
                          >
                            {t("pictureDescription.attemptTab", {
                              number: attempt.attempt_number,
                              latest:
                                index === 0
                                  ? t("pictureDescription.attemptLatestSuffix")
                                  : "",
                              score: attempt.score_out_of_10,
                            })}
                          </button>
                        );
                      })}
                    </div>
                    <PaginationBar
                      compact
                      onPageChange={setAttemptsPage}
                      page={safeAttemptsPage}
                      pageSize={ATTEMPTS_PAGE_SIZE}
                      total={session.attempts.length}
                    />
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                  <div className="flex flex-wrap items-center gap-3">
                    {renderStars(
                      activeAttempt.stars,
                      t("pictureDescription.starsAria", {
                        count: activeAttempt.stars,
                      }),
                    )}
                    <span className="rounded-full bg-success-surface px-3 py-1 text-sm font-extrabold text-success-ink">
                      {t("pictureDescription.recentScoreBadge", {
                        score: activeAttempt.score_out_of_10,
                      })}
                    </span>
                    <span className="text-xs font-bold text-muted">
                      {t("pictureDescription.attemptNumberBadge", {
                        number: activeAttempt.attempt_number,
                      })}
                    </span>
                    {activeAttempt.feedback.teaching_mode ? (
                      <span className="rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary">
                        {t("pictureDescription.resultModeBadge", {
                          mode: t(
                            TEACHING_MODE_SPEC_BY_ID[
                              activeAttempt.feedback.teaching_mode
                            ].labelKey,
                          ),
                        })}
                      </span>
                    ) : null}
                    {scoreDelta !== null && scoreDelta > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-extrabold text-emerald-800">
                        <TrendingUp aria-hidden="true" className="size-3.5" />
                        {t("pictureDescription.scoreImprovement", {
                          delta: scoreDelta,
                        })}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    onClick={() =>
                      void speakVietnamese(
                        `${activeAttempt.feedback.praise_message} ${activeAttempt.feedback.improvement_tip}`,
                        `feedback:${activeAttempt.attempt_id}`,
                        { adaptPersona: true },
                      )
                    }
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    {playingSpeechKey ===
                    `feedback:${activeAttempt.attempt_id}` ? (
                      <>
                        <VolumeX aria-hidden="true" className="size-4" />
                        {t("pictureDescription.stopListen")}
                      </>
                    ) : (
                      <>
                        <Volume2 aria-hidden="true" className="size-4" />
                        {t("pictureDescription.listenFeedback")}
                      </>
                    )}
                  </Button>
                </div>

                {activeAttempt.evaluation_source === "FALLBACK" ? (
                  <div className="mt-4">
                    <StatusMessage tone="info">
                      <div className="flex flex-wrap items-center justify-between gap-2.5">
                        <span>
                          {adaptTeacherText(
                            t("pictureDescription.fallbackEvalNotice"),
                          )}
                        </span>
                        <Button
                          disabled={isEvaluating}
                          onClick={() =>
                            void handleEvaluate(
                              activeAttempt.transcript_text,
                              activeAttempt.input_mode,
                              { allowDuplicate: true },
                            )
                          }
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          <RefreshCw
                            aria-hidden="true"
                            className={
                              "size-4 " +
                              (isEvaluating && !reducedMotion
                                ? "animate-spin"
                                : "")
                            }
                          />
                          {adaptTeacherText(
                            isEvaluating
                              ? t("pictureDescription.reEvaluatingAi")
                              : t("pictureDescription.reEvaluateWithAi"),
                          )}
                        </Button>
                      </div>
                      {isEvaluating ? (
                        <div className="mt-2">
                          <AiProgressBar
                            active
                            label={
                              evaluateProgress.stageLabel ??
                              tCommon("aiProgress.evaluatingAnswer")
                            }
                            percent={evaluateProgress.percent}
                            size="compact"
                            testId="picture-re-evaluating-progress"
                          />
                        </div>
                      ) : null}
                    </StatusMessage>
                  </div>
                ) : null}

                {evaluateError ? (
                  <div className="mt-3">
                    <StatusMessage tone="error">
                      {adaptTeacherText(evaluateError)}
                    </StatusMessage>
                  </div>
                ) : null}

                <div className="mt-4 rounded-control border border-border bg-sky/15 px-3.5 py-2.5">
                  <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                    {t("pictureDescription.childTranscriptTitle", {
                      attempt: activeAttempt.attempt_number,
                    })}
                  </p>
                  <p
                    className="viread-learning-content mt-1 text-sm font-semibold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    “{activeAttempt.transcript_text}”
                  </p>
                </div>

                <p
                  className="viread-learning-content mt-4 rounded-control bg-warning-surface/50 px-4 py-3 text-base font-extrabold text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {adaptTeacherText(activeAttempt.feedback.praise_message)}
                </p>

                {(() => {
                  const practicedWords =
                    activeAttempt.practiced_difficult_words ??
                    session.practiced_difficult_words ??
                    [];
                  if (practicedWords.length === 0) return null;
                  return (
                    <div
                      className="mt-3 flex flex-wrap items-center gap-2 rounded-control border border-emerald-300 bg-success-surface/60 px-3.5 py-2.5 text-sm font-bold text-success-ink"
                      data-testid="picture-practiced-difficult-words"
                    >
                      <span
                        className="viread-learning-content"
                        dir="ltr"
                        lang="vi"
                      >
                        {t("pictureDescription.matchedDifficultWordBanner", {
                          words: practicedWords.join(", "),
                        })}
                      </span>
                    </div>
                  );
                })()}

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-control bg-success-surface/40 p-3.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-success-ink">
                      <CheckCircle2 aria-hidden="true" className="size-4" />
                      {t("pictureDescription.matchedDetailsTitle")}
                    </h3>
                    {activeAttempt.feedback.matched_details.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink">
                        {activeAttempt.feedback.matched_details.map((item) => (
                          <li
                            className="viread-learning-content"
                            dir="ltr"
                            key={item}
                            lang="vi"
                          >
                            • {item}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted">
                        {t("pictureDescription.noMatchedDetails")}
                      </p>
                    )}
                  </div>

                  <div className="rounded-control bg-sky/40 p-3.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-primary">
                      <Lightbulb aria-hidden="true" className="size-4" />
                      {t("pictureDescription.missedDetailsTitle")}
                    </h3>
                    {activeAttempt.feedback.missed_details.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink">
                        {activeAttempt.feedback.missed_details.map((item) => (
                          <li
                            className="viread-learning-content"
                            dir="ltr"
                            key={item}
                            lang="vi"
                          >
                            • {item}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted">
                        {t("pictureDescription.allDetailsCovered")}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-4 rounded-control border border-border p-3.5">
                  <p className="text-sm font-bold text-ink">
                    {t("pictureDescription.nextAttemptTipLabel")}
                    <span
                      className="viread-learning-content font-semibold text-muted"
                      dir="ltr"
                      lang="vi"
                    >
                      {adaptTeacherText(activeAttempt.feedback.improvement_tip)}
                    </span>
                  </p>
                  {activeAttempt.feedback.upgraded_sentences.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                        {t("pictureDescription.upgradedSentencesTitle")}
                      </p>
                      <ul className="mt-1.5 flex flex-col gap-1.5">
                        {activeAttempt.feedback.upgraded_sentences.map(
                          (sentence, index) => (
                            <li
                              className="flex items-center justify-between gap-2 rounded-control bg-sky/25 px-3 py-2 text-sm font-bold text-ink"
                              key={sentence}
                            >
                              <span
                                className="viread-learning-content"
                                dir="ltr"
                                lang="vi"
                              >
                                “{sentence}”
                              </span>
                              <Button
                                onClick={() =>
                                  void speakVietnamese(
                                    sentence,
                                    `upgraded:${activeAttempt.attempt_id}:${index}`,
                                  )
                                }
                                size="compact"
                                type="button"
                                variant="secondary"
                              >
                                <Volume2
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                {playingSpeechKey ===
                                `upgraded:${activeAttempt.attempt_id}:${index}`
                                  ? t("pictureDescription.stopShort")
                                  : t("pictureDescription.listenShort")}
                              </Button>
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  ) : null}

                  {activeAttempt.feedback.used_target_words &&
                  activeAttempt.feedback.used_target_words.length > 0 ? (
                    <div
                      className="mt-3 border-t border-border pt-3"
                      data-testid="used-target-words-result"
                    >
                      <p className="text-xs font-extrabold uppercase tracking-wide text-success-ink">
                        {t("pictureDescription.usedTargetWordsTitle")}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {activeAttempt.feedback.used_target_words.map(
                          (word) => (
                            <span
                              className="viread-learning-content inline-flex items-center gap-1 rounded-full bg-success-surface px-3 py-1 text-xs font-extrabold text-success-ink"
                              dir="ltr"
                              key={word}
                              lang="vi"
                            >
                              <CheckCircle2
                                aria-hidden="true"
                                className="size-3.5"
                              />
                              {word}
                            </span>
                          ),
                        )}
                      </div>
                    </div>
                  ) : null}

                  {activeAttempt.feedback.vocabulary_highlights.length > 0 ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                        {adaptTeacherText(
                          t("pictureDescription.vocabHighlightsTitle"),
                        )}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {activeAttempt.feedback.vocabulary_highlights.map(
                          (word) => (
                            <button
                              className="viread-learning-content inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-sky/25 px-3 py-1 text-xs font-extrabold text-primary transition-colors hover:bg-sky/50"
                              dir="ltr"
                              key={word}
                              lang="vi"
                              onClick={() =>
                                void speakVietnamese(
                                  word,
                                  `highlight:${activeAttempt.attempt_id}:${word}`,
                                  { adaptPersona: false },
                                )
                              }
                              type="button"
                            >
                              <Volume2
                                aria-hidden="true"
                                className="size-3.5"
                              />
                              {word}
                            </button>
                          ),
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>

                {activeAttempt.feedback.next_prompt_question ? (
                  <div
                    className="mt-4 rounded-control border border-primary/30 bg-sky/25 p-4"
                    data-testid="ai-followup-question"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-primary">
                          <Sparkles aria-hidden="true" className="size-4" />
                          {adaptTeacherText(
                            t("pictureDescription.resultFollowUpTitle"),
                          )}
                        </p>
                        {activeAttempt.feedback.scaffolding_step ? (
                          <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-extrabold text-ink shadow-2xs">
                            {t(
                              SCAFFOLDING_STEP_KEYS[
                                activeAttempt.feedback.scaffolding_step
                              ],
                            )}
                          </span>
                        ) : null}
                      </div>
                      <Button
                        disabled={!calmSound}
                        onClick={() =>
                          void speakVietnamese(
                            activeAttempt.feedback.next_prompt_question ?? "",
                            `followup:${activeAttempt.attempt_id}`,
                            { adaptPersona: true },
                          )
                        }
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        <Volume2 aria-hidden="true" className="size-3.5" />
                        {playingSpeechKey ===
                        `followup:${activeAttempt.attempt_id}`
                          ? t("pictureDescription.stopListen")
                          : t("pictureDescription.listenQuestionButton")}
                      </Button>
                    </div>
                    <p
                      className="viread-learning-content mt-2 text-sm font-bold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {adaptTeacherText(
                        activeAttempt.feedback.next_prompt_question,
                      )}
                    </p>
                    <div className="mt-3">
                      <Button
                        onClick={() => {
                          stopSpeechPlayback();
                          autopilotRunIdRef.current += 1;
                          autopilotTurnKeyRef.current = null;
                          setAutoVoicePaused(false);
                          setAutoSubmitPaused(false);
                          cancelAutoSubmit();
                          setActiveFollowUpQuestion(
                            activeAttempt.feedback.next_prompt_question ?? null,
                          );
                          descriptionTextRef.current = "";
                          setDescriptionText("");
                          setInputMode("TEXT");
                          setVoiceMessage(null);
                          setPracticeTab("PRACTICE");
                          if (
                            !autopilotSessionActiveRef.current &&
                            getEntertainmentPreferences().autopilotEnabled
                          ) {
                            void recorder.prepare?.().catch(() => undefined);
                            startMicCountdown(3);
                          }
                        }}
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        {t("pictureDescription.answerFollowUpButton")}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap justify-end gap-2.5">
                  <Button
                    onClick={() => {
                      stopSpeechPlayback();
                      cancelMicCountdown();
                      cancelAutoSubmit();
                      setDescriptionText(activeAttempt.transcript_text);
                      setInputMode("TEXT");
                      setVoiceMessage(null);
                      setPracticeTab("PRACTICE");
                    }}
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    <PenLine aria-hidden="true" className="size-4" />
                    {t("pictureDescription.editPreviousDraft")}
                  </Button>
                  <Button
                    onClick={() => {
                      stopSpeechPlayback();
                      cancelAutoSubmit();
                      setDescriptionText("");
                      setInputMode("TEXT");
                      setVoiceMessage(null);
                      setPracticeTab("PRACTICE");
                      if (getEntertainmentPreferences().autopilotEnabled) {
                        void recorder.prepare?.().catch(() => undefined);
                        startMicCountdown(3);
                      }
                    }}
                    size="compact"
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" className="size-4" />
                    {t("pictureDescription.restartFromScratch")}
                  </Button>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
