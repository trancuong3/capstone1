"use client";

import {
  ArrowLeft,
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
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { isInjectedTestSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import { useTranslations } from "@/hooks/use-i18n";
import { usePictureDescriptionService } from "@/hooks/use-picture-description-service";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import {
  BrowserTranscriptCollector,
  type BrowserRecognitionEventLike,
} from "@/lib/reading/browser-transcript-collector";
import type {
  PictureAttemptDTO,
  PictureBookPageItemDTO,
  PictureCatalogDTO,
  PictureInputMode,
  PictureSampleItemDTO,
  PictureSessionDTO,
  PictureSessionSummaryDTO,
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

function countMeaningfulWords(value: string): number {
  const matches = value.trim().match(/\p{L}+/gu);
  return matches ? matches.length : 0;
}

function descriptionContainsTerm(description: string, term: string): boolean {
  const normalizedDesc = normalizeSpeechUnit(description);
  const normalizedTerm = normalizeSpeechUnit(term);
  if (!normalizedDesc || !normalizedTerm) return false;
  return ` ${normalizedDesc} `.includes(` ${normalizedTerm} `);
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

export function PictureDescriptionScreen() {
  const t = useTranslations("entertainment");
  const defaultGameError = t("pictureDescription.defaultError");
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const pictureService = usePictureDescriptionService();
  const speechService = useMemo<SpeechService>(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const recorder = useSpeechRecorder();

  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
  });
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<SourceTab>("SAMPLE");
  const [practiceTab, setPracticeTab] = useState<PracticeTab>("PRACTICE");
  const [session, setSession] = useState<PictureSessionDTO | null>(null);
  const [selectedVocabWord, setSelectedVocabWord] = useState<string | null>(
    null,
  );
  const [showHints, setShowHints] = useState(false);
  const [showSampleSentences, setShowSampleSentences] = useState(false);
  const [samplesPage, setSamplesPage] = useState(1);
  const [bookPagesPage, setBookPagesPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const PICTURE_GRID_PAGE_SIZE = 6;

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
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
  const sessionEpochRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const isRecordingVoiceRef = useRef(false);
  const browserRecognitionRef = useRef<BrowserSpeechRecognitionLike | null>(
    null,
  );
  const collectorRef = useRef<BrowserTranscriptCollector>(
    new BrowserTranscriptCollector(),
  );
  const requestControllerRef = useRef<AbortController | null>(null);
  const sttControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const unmountActionsRef = useRef({
    cancelRecorder: recorder.cancel,
    stopSpeech: speechPlayer.stop,
  });

  const childId = childState.status === "ready" ? childState.child.id : null;

  useEffect(() => {
    sessionIdRef.current = session?.session_id ?? null;
  }, [session?.session_id]);

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
    };
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionEpochRef.current += 1;
      isRecordingVoiceRef.current = false;
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
      unmountActionsRef.current.cancelRecorder();
    };
  }, []);

  useEffect(() => {
    if (!childId) return;

    const controller = new AbortController();
    let active = true;

    void Promise.all([
      pictureService.getCatalog(childId, controller.signal),
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
  }, [catalogRefreshKey, childId, defaultGameError, pictureService]);

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

  const stopSpeechPlayback = useCallback(() => {
    speechPlayer.stop();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingSpeechKey(null);
  }, [speechPlayer]);

  const speakVietnamese = useCallback(
    async (text: string, key: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      if (playingSpeechKey === key) {
        stopSpeechPlayback();
        return;
      }

      stopSpeechPlayback();
      setPlayingSpeechKey(key);

      try {
        await speechPlayer.play(cleaned);
        setPlayingSpeechKey((current) => (current === key ? null : current));
      } catch {
        setPlayingSpeechKey(null);
      }
    },
    [playingSpeechKey, speechPlayer, stopSpeechPlayback],
  );

  const stopVoiceCaptureAndStt = useCallback(() => {
    sessionEpochRef.current += 1;
    isRecordingVoiceRef.current = false;
    sttControllerRef.current?.abort();
    sttControllerRef.current = null;
    try {
      browserRecognitionRef.current?.abort();
    } catch {
      // Ignore browser recognition abort errors.
    }
    browserRecognitionRef.current = null;
    collectorRef.current.reset();
    recorder.cancel();
    setIsRecordingVoice(false);
    setIsTranscribing(false);
    setLiveTranscript("");
  }, [recorder]);

  const openSession = useCallback(
    (loaded: PictureSessionDTO, initialTab: PracticeTab = "PRACTICE") => {
      stopSpeechPlayback();
      stopVoiceCaptureAndStt();
      sessionIdRef.current = loaded.session_id;
      const newestAttempt = loaded.attempts[0] ?? null;
      setSession(loaded);
      setSelectedAttemptId(newestAttempt?.attempt_id ?? null);
      setPracticeTab(
        initialTab === "RESULT" && newestAttempt ? "RESULT" : "PRACTICE",
      );
      setSelectedVocabWord(null);
      setShowHints(false);
      setShowSampleSentences(false);
      setDescriptionText("");
      setLiveTranscript("");
      setInputMode("TEXT");
      setActionError(null);
      setEvaluateError(null);
      setVoiceMessage(null);
    },
    [stopSpeechPlayback, stopVoiceCaptureAndStt],
  );

  const handleResumeSession = async (
    sessionId: string,
    preferredTab?: PracticeTab,
  ) => {
    if (!pictureService || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setIsAnalyzing(true);
    try {
      const loaded = await pictureService.getSession(
        sessionId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const targetTab =
        preferredTab ?? (loaded.attempts.length > 0 ? "RESULT" : "PRACTICE");
      openSession(loaded, targetTab);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleCreateSampleSession = async (sample: PictureSampleItemDTO) => {
    if (!childId || !pictureService || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "SAMPLE",
          sample_key: sample.sample_key,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created, "PRACTICE");
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStartSample = async (sample: PictureSampleItemDTO) => {
    const existing = sampleSessionMap.get(sample.sample_key);
    if (existing) {
      await handleResumeSession(
        existing.session_id,
        existing.attempts_count > 0 ? "RESULT" : "PRACTICE",
      );
      return;
    }
    await handleCreateSampleSession(sample);
  };

  const handleCreateBookPageSession = async (page: PictureBookPageItemDTO) => {
    if (!childId || !pictureService || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "BOOK_PAGE",
          book_page_id: page.page_id,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created, "PRACTICE");
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
      await handleResumeSession(
        existing.session_id,
        existing.attempts_count > 0 ? "RESULT" : "PRACTICE",
      );
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
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created, "PRACTICE");
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startVoiceRecording = async () => {
    if (isRecordingVoice || isTranscribing || isEvaluating) return;
    const captureEpoch = sessionEpochRef.current;
    stopSpeechPlayback();
    setVoiceMessage(null);
    setActionError(null);
    setLiveTranscript("");
    collectorRef.current.reset();

    try {
      await recorder.start();
    } catch {
      if (!mountedRef.current || sessionEpochRef.current !== captureEpoch) {
        return;
      }
      isRecordingVoiceRef.current = false;
      setIsRecordingVoice(false);
      setVoiceMessage(t("pictureDescription.micUnavailable"));
      return;
    }

    if (!mountedRef.current || sessionEpochRef.current !== captureEpoch) {
      recorder.cancel();
      return;
    }

    isRecordingVoiceRef.current = true;
    setIsRecordingVoice(true);
    setVoiceMessage(t("pictureDescription.micListening"));

    const rawCtor = getSpeechRecognitionCtor();
    const SpeechRecognition = isInjectedTestSpeechRecognition(rawCtor)
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
          if (
            !mountedRef.current ||
            !isRecordingVoiceRef.current ||
            sessionEpochRef.current !== captureEpoch
          ) {
            return;
          }
          collectorRef.current.addResults(event);
          setLiveTranscript(collectLiveTranscript(collectorRef.current, event));
        };
        recognition.onend = () => {
          collectorRef.current.completeRecognitionCycle();
          if (
            mountedRef.current &&
            isRecordingVoiceRef.current &&
            sessionEpochRef.current === captureEpoch &&
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
      } catch {
        browserRecognitionRef.current = null;
      }
    }
  };

  const stopVoiceRecording = async () => {
    if (!isRecordingVoice) return;
    const captureEpoch = sessionEpochRef.current;
    const activeSessionId = session?.session_id ?? null;
    isRecordingVoiceRef.current = false;
    setIsRecordingVoice(false);
    setIsTranscribing(true);
    setVoiceMessage(t("pictureDescription.transcribingSpeech"));

    sttControllerRef.current?.abort();
    const sttController = new AbortController();
    sttControllerRef.current = sttController;

    const liveSnapshot = liveTranscript;
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
      const audioBlob = await recorder.stop();
      if (isStaleCapture()) return;
      const browserFallback = collapseDuplicateSpeech(
        collectorRef.current.getTranscript() || liveSnapshot,
      );
      let sttTranscript: string | null = null;

      if (audioBlob && audioBlob.size > 0) {
        const keyterms = session
          ? session.guide.suggested_vocabulary
              .map((item) => item.word)
              .slice(0, 10)
          : [];
        try {
          const sttResult = await speechService.transcribe(audioBlob, {
            languageCode: "vi",
            keyterms,
            signal: sttController.signal,
          });
          if (isStaleCapture()) return;
          sttTranscript = sttResult.text?.trim() || null;
        } catch {
          if (isStaleCapture()) return;
          sttTranscript = null;
        }
      }

      if (isStaleCapture()) return;
      const finalTranscript = sttTranscript || browserFallback || null;
      if (!finalTranscript) {
        setVoiceMessage(t("pictureDescription.unclearVoice"));
        return;
      }

      setDescriptionText((previous) => {
        const prefix = previous.trim();
        return prefix ? `${prefix} ${finalTranscript}` : finalTranscript;
      });
      setInputMode("VOICE");
      setVoiceMessage(
        sttTranscript
          ? t("pictureDescription.transcribedElevenLabs")
          : t("pictureDescription.transcribedBrowser"),
      );
    } finally {
      if (sttControllerRef.current === sttController) {
        sttControllerRef.current = null;
      }
      if (mountedRef.current && sessionEpochRef.current === captureEpoch) {
        setIsTranscribing(false);
        setLiveTranscript("");
        browserRecognitionRef.current = null;
      }
    }
  };

  const handleInsertVocabWord = (word: string) => {
    setDescriptionText((previous) => {
      if (descriptionContainsTerm(previous, word)) return previous;
      const trimmedEnd = previous.replace(/\s+$/g, "");
      return trimmedEnd ? `${trimmedEnd} ${word}` : word;
    });
  };

  const handleClearDraft = () => {
    stopSpeechPlayback();
    setDescriptionText("");
    setInputMode("TEXT");
    setVoiceMessage(null);
    setActionError(null);
    setEvaluateError(null);
  };

  const handleEvaluate = async (
    overrideTranscript?: string,
    overrideMode?: PictureInputMode,
  ) => {
    if (!session || !pictureService || isEvaluating) return;
    const rawText =
      overrideTranscript !== undefined ? overrideTranscript : descriptionText;
    const trimmed = rawText.trim();
    if (!trimmed) {
      setEvaluateError(t("pictureDescription.emptySubmissionError"));
      return;
    }

    stopSpeechPlayback();
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setEvaluateError(null);
    setIsEvaluating(true);
    try {
      const response = await pictureService.evaluate(
        session.session_id,
        {
          transcript_text: trimmed,
          input_mode: overrideMode ?? inputMode,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSession(response.session);
      setSelectedAttemptId(response.latest_attempt.attempt_id);
      setVoiceMessage(null);
      setEvaluateError(null);
      setPracticeTab("RESULT");
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setEvaluateError(
        isServiceError(error) ? error.message : defaultGameError,
      );
    } finally {
      setIsEvaluating(false);
    }
  };

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
  const draftWordCount = countMeaningfulWords(descriptionText);
  const draftReadiness = readinessHint(
    draftWordCount,
    session?.child_grade ?? selectedChild.grade,
    t,
  );
  const usedVocabCount = session
    ? session.guide.suggested_vocabulary.filter((item) =>
        descriptionContainsTerm(descriptionText, item.word),
      ).length
    : 0;

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 pb-6">
      <BookChildHeader
        child={selectedChild}
        mobileLabel={t("pictureDescription.mobileLabel")}
        backHref="/entertainment"
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <Link
            className="inline-flex items-center gap-2 text-xs font-extrabold text-primary hover:underline sm:text-sm"
            href="/entertainment"
          >
            <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
            {t("pictureDescription.backLink")}
          </Link>
          <h1 className="book-title mt-1 flex items-center gap-2 text-2xl text-ink sm:text-[32px]">
            {t("pictureDescription.heading")}
          </h1>
          <p className="text-sm text-muted sm:text-base">
            {t("pictureDescription.lead")}
          </p>
        </div>

        {session ? (
          <Button
            onClick={() => {
              stopSpeechPlayback();
              stopVoiceCaptureAndStt();
              sessionIdRef.current = null;
              setShowHints(false);
              setShowSampleSentences(false);
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
            <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
            {t("pictureDescription.chooseAnotherPicture")}
          </Button>
        ) : null}
      </div>

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
            className="size-8 animate-spin text-primary"
          />
          <h2 className="text-xl font-extrabold text-ink">
            {t("pictureDescription.analyzingTitle")}
          </h2>
          <p className="max-w-md text-body text-muted">
            {t("pictureDescription.analyzingDesc", {
              grade: selectedChild.grade,
            })}
          </p>
        </div>
      ) : null}

      {!session && !isAnalyzing ? (
        <>
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
                          (samplesPage - 1) * PICTURE_GRID_PAGE_SIZE,
                          samplesPage * PICTURE_GRID_PAGE_SIZE,
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
                              className="flex flex-col overflow-hidden rounded-card border border-border bg-white shadow-sm transition-transform hover:-translate-y-0.5"
                              key={sample.sample_key}
                            >
                              <div className="relative aspect-[4/3] w-full overflow-hidden bg-sky/40">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  alt={sample.title}
                                  className="h-full w-full object-cover"
                                  src={sample.image_url}
                                />
                                <span className="absolute start-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-extrabold text-primary shadow-sm">
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
                                        void handleCreateSampleSession(sample)
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
                      page={samplesPage}
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
                            (bookPagesPage - 1) * PICTURE_GRID_PAGE_SIZE,
                            bookPagesPage * PICTURE_GRID_PAGE_SIZE,
                          )
                          .map((page) => {
                            const existing = bookPageSessionMap.get(
                              page.page_id,
                            );
                            const hasPriorAttempt = Boolean(
                              existing && existing.attempts_count > 0,
                            );
                            return (
                              <article
                                className="flex flex-col overflow-hidden rounded-card border border-border bg-white shadow-sm"
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
                        page={bookPagesPage}
                        pageSize={PICTURE_GRID_PAGE_SIZE}
                        total={catalogState.catalog.book_pages.length}
                      />
                    </>
                  ) : (
                    <EmptyState
                      description={t("pictureDescription.emptyBookPagesDesc")}
                      title={t("pictureDescription.emptyBookPagesTitle")}
                    />
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
                    (sessionsPage - 1) * PICTURE_GRID_PAGE_SIZE,
                    sessionsPage * PICTURE_GRID_PAGE_SIZE,
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
                page={sessionsPage}
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
              <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
                {t("pictureDescription.stepsTitle")}
              </p>
              <ol className="mt-2 grid gap-2 sm:grid-cols-3">
                {STORYTELLING_STEPS.map((item) => (
                  <li
                    className="rounded-control bg-white/90 p-2.5 text-xs shadow-2xs"
                    key={item.step}
                  >
                    <span className="font-extrabold text-primary">
                      {t("pictureDescription.stepPrefix", { step: item.step })}
                    </span>{" "}
                    <span className="font-bold text-ink">
                      {t(item.titleKey)}
                    </span>
                    <p className="mt-0.5 text-muted">{t(item.detailKey)}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>

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
                {/* Coaching Reminder from Previous Attempt so Child Knows What to Improve */}
                {latestAttempt ? (
                  <section
                    aria-label={t("pictureDescription.previousCoachingAria")}
                    className="rounded-card border border-primary/25 bg-sky/20 p-4"
                  >
                    <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-primary">
                      <Lightbulb aria-hidden="true" className="size-4" />
                      {t("pictureDescription.previousCoachingTitle", {
                        attempt: latestAttempt.attempt_number,
                      })}
                    </p>
                    <p
                      className="viread-learning-content mt-1 text-sm font-semibold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {latestAttempt.feedback.improvement_tip}
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
                        <Button
                          disabled={isTranscribing || isEvaluating}
                          onClick={() => void startVoiceRecording()}
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          <Mic aria-hidden="true" className="size-4" />
                          {t("pictureDescription.speakWithMic")}
                        </Button>
                      ) : (
                        <Button
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

                  {isRecordingVoice ? (
                    <div
                      aria-live="polite"
                      className="mt-3 flex items-center gap-3 rounded-control border border-primary/35 bg-sky/25 px-4 py-3 shadow-sm"
                    >
                      <div className="flex shrink-0 items-center gap-2">
                        {recorder.isSpeaking ? (
                          <span
                            aria-hidden="true"
                            className="flex items-center gap-1"
                          >
                            <span className="h-4 w-1 animate-pulse rounded-full bg-emerald-500" />
                            <span className="h-6 w-1 animate-pulse rounded-full bg-emerald-500 delay-75" />
                            <span className="h-3 w-1 animate-pulse rounded-full bg-emerald-500 delay-150" />
                          </span>
                        ) : (
                          <span className="relative flex size-3.5">
                            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
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
                          <span className="animate-pulse font-bold text-emerald-700">
                            {t("pictureDescription.liveRecognizing")}
                          </span>
                        ) : (
                          <span className="text-sm font-medium italic text-muted">
                            {t("pictureDescription.liveListening")}
                          </span>
                        )}
                      </p>
                    </div>
                  ) : voiceMessage ? (
                    <div className="mt-3">
                      <StatusMessage tone="info">{voiceMessage}</StatusMessage>
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
                        const nextValue = event.target.value;
                        setDescriptionText(nextValue);
                        if (evaluateError) setEvaluateError(null);
                        if (!nextValue.trim() || inputMode !== "VOICE") {
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
                      className="mt-3 flex items-center gap-2.5 rounded-control border border-primary/25 bg-sky/25 px-3.5 py-2.5 text-sm font-bold text-primary"
                    >
                      <RefreshCw
                        aria-hidden="true"
                        className="size-4 shrink-0 animate-spin"
                      />
                      <span>{t("pictureDescription.evaluatingBanner")}</span>
                    </div>
                  ) : null}

                  {evaluateError ? (
                    <div className="mt-3">
                      <StatusMessage tone="error">
                        <div className="flex flex-wrap items-center justify-between gap-2.5">
                          <span>{evaluateError}</span>
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
                        {draftReadiness.label}
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
                      {isEvaluating
                        ? t("pictureDescription.evaluatingButton")
                        : t("pictureDescription.submitButton")}
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
                      onClick={() => setShowHints((value) => !value)}
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
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                          {t("pictureDescription.guidingQuestionsTitle")}
                        </p>
                        <Button
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
                        {session.guide.guiding_questions.map(
                          (question, index) => (
                            <li
                              className="flex items-start gap-2 rounded-control bg-sky/30 px-3 py-2 text-sm font-bold text-ink"
                              key={question}
                            >
                              <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-extrabold text-white">
                                {index + 1}
                              </span>
                              <span
                                className="viread-learning-content"
                                dir="ltr"
                                lang="vi"
                              >
                                {question}
                              </span>
                            </li>
                          ),
                        )}
                      </ol>

                      <div className="mt-4">
                        <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                          {t("pictureDescription.suggestedVocabTitle")}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {session.guide.suggested_vocabulary.map((item) => {
                            const active = selectedVocabWord === item.word;
                            const used = descriptionContainsTerm(
                              descriptionText,
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
                            {!descriptionContainsTerm(
                              descriptionText,
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
                  <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3">
                    <span className="text-xs font-extrabold uppercase tracking-wide text-muted">
                      {t("pictureDescription.attemptHistoryLabel")}
                    </span>
                    {session.attempts.map((attempt, index) => {
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
                          {t("pictureDescription.fallbackEvalNotice")}
                        </span>
                        <Button
                          disabled={isEvaluating}
                          onClick={() =>
                            void handleEvaluate(
                              activeAttempt.transcript_text,
                              activeAttempt.input_mode,
                            )
                          }
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          <RefreshCw
                            aria-hidden="true"
                            className={
                              "size-4 " + (isEvaluating ? "animate-spin" : "")
                            }
                          />
                          {isEvaluating
                            ? t("pictureDescription.reEvaluatingAi")
                            : t("pictureDescription.reEvaluateWithAi")}
                        </Button>
                      </div>
                    </StatusMessage>
                  </div>
                ) : null}

                {evaluateError ? (
                  <div className="mt-3">
                    <StatusMessage tone="error">{evaluateError}</StatusMessage>
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
                  {activeAttempt.feedback.praise_message}
                </p>

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
                      {activeAttempt.feedback.improvement_tip}
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

                  {activeAttempt.feedback.vocabulary_highlights.length > 0 ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                        {t("pictureDescription.vocabHighlightsTitle")}
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

                <div className="mt-4 flex flex-wrap justify-end gap-2.5">
                  <Button
                    onClick={() => {
                      stopSpeechPlayback();
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
                      setDescriptionText("");
                      setInputMode("TEXT");
                      setVoiceMessage(null);
                      setPracticeTab("PRACTICE");
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
