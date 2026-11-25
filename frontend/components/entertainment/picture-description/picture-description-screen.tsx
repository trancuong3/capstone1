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
const TTS_MIC_COOLDOWN_MS = 280;
const DUPLICATE_SUBMIT_WINDOW_MS = 1500;
const defaultGameError =
  "Chưa kết nối được góc Kể chuyện qua tranh. Ba mẹ và bé hãy thử lại nhé.";

const TEACHING_MODES: readonly {
  readonly id: PictureTeachingMode;
  readonly label: string;
  readonly cue: string;
  readonly audioHint: string;
}[] = [
  {
    id: "OBSERVE",
    label: "Quan sát",
    cue: "Gọi tên nhân vật, con vật, đồ vật và màu sắc bé nhìn thấy.",
    audioHint:
      "Chế độ Quan sát: Bé hãy nhìn kỹ tranh và kể xem trong tranh có ai, có vật gì và màu sắc ra sao nhé.",
  },
  {
    id: "VOCABULARY",
    label: "Từ vựng",
    cue: "Dùng các từ gợi ý hoặc từ khó mục tiêu vào câu kể thật tự nhiên.",
    audioHint:
      "Chế độ Từ vựng: Bé hãy chọn từ hay hoặc từ khó rồi đặt một câu trọn ý gắn với bức tranh nhé.",
  },
  {
    id: "SENTENCE",
    label: "Ghép câu",
    cue: "Ghép thành câu trọn ý: Ai / Con gì + đang làm gì + ở đâu.",
    audioHint:
      "Chế độ Ghép câu: Bé hãy ghép thành một câu hoàn chỉnh xem ai đang làm gì và ở đâu nhé.",
  },
  {
    id: "STORY",
    label: "Kể chuyện",
    cue: "Kể câu chuyện nhỏ có mở đầu, diễn biến và cảm xúc vui vẻ.",
    audioHint:
      "Chế độ Kể chuyện: Bé hãy kể thành một câu chuyện ngắn có mở đầu, hoạt động chính và cảm xúc nhé.",
  },
  {
    id: "INFER",
    label: "Suy luận",
    cue: "Đoán xem vì sao nhân vật vui và điều gì có thể sắp xảy ra.",
    audioHint:
      "Chế độ Suy luận: Bé hãy nhìn gợi ý trong tranh để đoán xem vì sao lại như vậy và chuyện gì sắp xảy ra nhé.",
  },
  {
    id: "CREATE",
    label: "Sáng tạo",
    cue: "Tưởng tượng lời thoại dễ thương hoặc đặt tên mới cho bức tranh.",
    audioHint:
      "Chế độ Sáng tạo: Bé hãy thử tưởng tượng nhân vật trong tranh đang nói gì hoặc đặt một cái tên thật hay nhé.",
  },
] as const;

const TEACHING_MODE_BY_ID: Record<
  PictureTeachingMode,
  (typeof TEACHING_MODES)[number]
> = {
  OBSERVE: TEACHING_MODES[0],
  VOCABULARY: TEACHING_MODES[1],
  SENTENCE: TEACHING_MODES[2],
  STORY: TEACHING_MODES[3],
  INFER: TEACHING_MODES[4],
  CREATE: TEACHING_MODES[5],
};

const SCAFFOLDING_STEP_LABELS: Record<PictureScaffoldingStep, string> = {
  PROMPT: "Gợi mở quan sát",
  EXPAND: "Mở rộng câu kể",
  PRAISE: "Khen ngợi & nâng cao",
  NEXT_CHALLENGE: "Thử thách tiếp theo",
};

const GRADE_1_2_VISUAL_HINT_CHIPS = [
  { id: "who", badge: "1", text: "Có ai / con gì?" },
  { id: "action", badge: "2", text: "Đang làm gì?" },
  { id: "where", badge: "3", text: "Màu gì / ở đâu?" },
] as const;

const STORYTELLING_STEPS = [
  {
    step: "1",
    title: "Trong tranh có ai, vật gì?",
    detail: "Gọi tên nhân vật, con vật hoặc đồ vật nổi bật.",
  },
  {
    step: "2",
    title: "Đang làm gì, ở đâu?",
    detail: "Kể hoạt động đang diễn ra và khung cảnh xung quanh.",
  },
  {
    step: "3",
    title: "Màu sắc, cảm nghĩ ra sao?",
    detail: "Thêm màu sắc, thời tiết hoặc cảm xúc của bé.",
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

function sourceLabel(source: PictureSessionSummaryDTO["source_type"]): string {
  switch (source) {
    case "BOOK_PAGE":
      return "Từ sách ViRead";
    case "CUSTOM_UPLOAD":
      return "Ảnh tải lên";
    default:
      return "Tranh chủ đề";
  }
}

function readinessHint(
  wordCount: number,
  grade: number,
): {
  readonly label: string;
  readonly readyFor3Stars: boolean;
} {
  const targetWords = grade >= 3 ? 7 : 5;
  if (wordCount === 0) {
    return {
      label: "Bé hãy bấm Nói bằng Micro hoặc gõ câu mô tả bức tranh nhé.",
      readyFor3Stars: false,
    };
  }
  if (wordCount <= 2) {
    return {
      label: `Mới có ${wordCount} từ rời — bé hãy ghép thành 1 câu trọn vẹn nhé!`,
      readyFor3Stars: false,
    };
  }
  if (wordCount < targetWords) {
    return {
      label: `Đã có ${wordCount} từ — kể thêm 1–2 chi tiết nữa để săn đủ 3 sao nhé!`,
      readyFor3Stars: false,
    };
  }
  return {
    label: `Bài kể đã có ${wordCount} từ rất đầy đặn — sẵn sàng gửi cô giáo AI chấm!`,
    readyFor3Stars: true,
  };
}

function renderStars(count: number) {
  return (
    <span
      aria-label={`${count} trên 3 sao`}
      className="inline-flex items-center gap-1"
    >
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
  const [teachingMode, setTeachingMode] =
    useState<PictureTeachingMode>("OBSERVE");
  const [activeFollowUpQuestion, setActiveFollowUpQuestion] = useState<
    string | null
  >(null);
  const [showGradeHintChips, setShowGradeHintChips] = useState(true);
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

  const isRecordingVoiceRef = useRef(false);
  const isTtsPlayingRef = useRef(false);
  const lastTtsEndAtRef = useRef(0);
  const micArmTokenRef = useRef(0);
  const micCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const unmountActionsRef = useRef({
    cancelRecorder: recorder.cancel,
    stopSpeech: speechPlayer.stop,
  });

  const childId = childState.status === "ready" ? childState.child.id : null;

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

  const clearMicCooldown = useCallback(() => {
    if (micCooldownTimerRef.current !== null) {
      clearTimeout(micCooldownTimerRef.current);
      micCooldownTimerRef.current = null;
    }
  }, []);

  const abortActiveVoiceCapture = useCallback(
    (options?: { preserveDraft?: boolean }) => {
      micArmTokenRef.current += 1;
      clearMicCooldown();
      const wasActive =
        isRecordingVoiceRef.current || browserRecognitionRef.current !== null;
      isRecordingVoiceRef.current = false;
      setIsRecordingVoice(false);

      const pendingLive = collapseDuplicateSpeech(
        collectorRef.current.getTranscript() || liveTranscriptRef.current,
      );
      try {
        browserRecognitionRef.current?.abort();
      } catch {
        // Ignore browser recognition abort errors.
      }
      browserRecognitionRef.current = null;
      if (wasActive) {
        unmountActionsRef.current.cancelRecorder();
      }
      if (options?.preserveDraft && pendingLive) {
        setDescriptionText((previous) => {
          const prefix = previous.trim();
          if (!prefix) return pendingLive;
          if (
            normalizeSpeechUnit(prefix).endsWith(
              normalizeSpeechUnit(pendingLive),
            )
          ) {
            return prefix;
          }
          return `${prefix} ${pendingLive}`;
        });
        setInputMode("VOICE");
      }
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      return wasActive;
    },
    [clearMicCooldown],
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

  useEffect(() => {
    const suspendMediaOnBackground = () => {
      stopSpeechPlayback();
      const interruptedMic = abortActiveVoiceCapture({ preserveDraft: true });
      if (interruptedMic) {
        setVoiceMessage(
          "Ứng dụng vừa tạm ẩn nên micro đã tắt an toàn. Lời kể của bé vẫn được giữ nguyên!",
        );
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
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        document.removeEventListener(
          "viread:android-background",
          onAndroidBackground,
        );
      }
      micArmTokenRef.current += 1;
      clearMicCooldown();
      isRecordingVoiceRef.current = false;
      isTtsPlayingRef.current = false;
      requestControllerRef.current?.abort();
      try {
        browserRecognitionRef.current?.abort();
      } catch {
        // Ignore cleanup abort errors.
      }
      browserRecognitionRef.current = null;
      unmountActionsRef.current.stopSpeech();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      unmountActionsRef.current.cancelRecorder();
    };
  }, [abortActiveVoiceCapture, clearMicCooldown, stopSpeechPlayback]);

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
  }, [catalogRefreshKey, childId, pictureService]);

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

  const speakVietnamese = useCallback(
    async (text: string, key: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      if (playingSpeechKey === key) {
        stopSpeechPlayback();
        return;
      }

      // G10 Anti-Self-Capture: Immediately abort any active mic / SpeechRecognition before TTS starts.
      abortActiveVoiceCapture({ preserveDraft: true });
      stopSpeechPlayback();
      isTtsPlayingRef.current = true;
      setPlayingSpeechKey(key);

      try {
        await speechPlayer.play(cleaned);
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
      playingSpeechKey,
      speechPlayer,
      stopSpeechPlayback,
    ],
  );

  const openSession = useCallback(
    (loaded: PictureSessionDTO, initialTab: PracticeTab = "PRACTICE") => {
      stopSpeechPlayback();
      abortActiveVoiceCapture({ preserveDraft: false });
      const newestAttempt = loaded.attempts[0] ?? null;
      const initialMode =
        loaded.teaching_mode ?? loaded.guide.teaching_mode ?? "OBSERVE";
      setSession(loaded);
      setTeachingMode(initialMode);
      setActiveFollowUpQuestion(
        newestAttempt?.feedback.next_prompt_question ?? null,
      );
      // Grade-adaptive scaffolding: prominent audio-first hints for Grades 1-2,
      // collapsed by default for Grades 4-5 (expandable in 1 tap).
      setShowGradeHintChips(loaded.child_grade < 4);
      setSelectedAttemptId(newestAttempt?.attempt_id ?? null);
      setPracticeTab(
        initialTab === "RESULT" && newestAttempt ? "RESULT" : "PRACTICE",
      );
      setSelectedVocabWord(null);
      setShowHints(false);
      setShowSampleSentences(false);
      setDescriptionText("");
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      setInputMode("TEXT");
      setActionError(null);
      setEvaluateError(null);
      setVoiceMessage(null);
      lastSuccessfulSubmitRef.current = null;
    },
    [abortActiveVoiceCapture, stopSpeechPlayback],
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

  const handleCreateSampleSession = async (
    sample: PictureSampleItemDTO,
    options?: { refreshAiGuide?: boolean },
  ) => {
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
          refresh_ai_guide: options?.refreshAiGuide,
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
      setUploadError(
        "Chỉ hỗ trợ ảnh định dạng JPG, PNG hoặc WebP. Ba mẹ hãy chọn lại ảnh nhé.",
      );
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setUploadFile(null);
      setUploadPreviewUrl(null);
      setUploadError("Ảnh hơi nặng (tối đa 5 MB). Hãy chọn ảnh nhẹ hơn nhé.");
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
      setVoiceMessage("Đang đợi giọng đọc dừng hẳn rồi mở micro cho bé...");
      await new Promise<void>((resolve) => {
        micCooldownTimerRef.current = setTimeout(() => {
          micCooldownTimerRef.current = null;
          resolve();
        }, cooldownRemainingMs);
      });
      if (
        micArmTokenRef.current !== armToken ||
        isTtsPlayingRef.current ||
        (typeof document !== "undefined" && document.hidden)
      ) {
        return;
      }
    }

    try {
      await recorder.start();
    } catch {
      isRecordingVoiceRef.current = false;
      setIsRecordingVoice(false);
      setVoiceMessage(
        "Không mở được micro trên thiết bị này. Bé có thể gõ câu mô tả vào ô bên dưới nhé.",
      );
      return;
    }

    if (micArmTokenRef.current !== armToken || isTtsPlayingRef.current) {
      recorder.cancel();
      return;
    }

    isRecordingVoiceRef.current = true;
    setIsRecordingVoice(true);
    setVoiceMessage("Đang lắng nghe bé nói mô tả bức tranh...");

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
          // Never capture AI Teacher TTS audio into the child's transcript.
          const synthesisSpeaking =
            typeof window !== "undefined" &&
            "speechSynthesis" in window &&
            Boolean(window.speechSynthesis.speaking);
          if (
            !isRecordingVoiceRef.current ||
            isTtsPlayingRef.current ||
            synthesisSpeaking
          ) {
            return;
          }
          collectorRef.current.addResults(event);
          const nextLive = collectLiveTranscript(collectorRef.current, event);
          liveTranscriptRef.current = nextLive;
          setLiveTranscript(nextLive);
        };
        recognition.onend = () => {
          collectorRef.current.completeRecognitionCycle();
          if (
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
      } catch {
        browserRecognitionRef.current = null;
      }
    }
  };

  const stopVoiceRecording = async () => {
    if (!isRecordingVoice) return;
    isRecordingVoiceRef.current = false;
    setIsRecordingVoice(false);
    setIsTranscribing(true);
    setVoiceMessage("Đang chuyển giọng nói của bé bằng ElevenLabs...");

    const liveSnapshot = liveTranscriptRef.current || liveTranscript;
    try {
      browserRecognitionRef.current?.stop();
    } catch {
      // Ignore browser recognition stop errors.
    }

    try {
      const audioBlob = await recorder.stop();
      const browserFallback = collapseDuplicateSpeech(
        collectorRef.current.getTranscript() || liveSnapshot,
      );
      let elevenLabsText: string | null = null;

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
          });
          elevenLabsText = sttResult.text?.trim() || null;
        } catch {
          elevenLabsText = null;
        }
      }

      const finalTranscript = elevenLabsText || browserFallback || null;
      if (!finalTranscript) {
        setVoiceMessage(
          "Cô chưa nghe rõ tiếng bé nói. Bé hãy bấm micro nói lại hoặc gõ chữ nhé!",
        );
        return;
      }

      setDescriptionText((previous) => {
        const prefix = previous.trim();
        return prefix ? `${prefix} ${finalTranscript}` : finalTranscript;
      });
      setInputMode("VOICE");
      setVoiceMessage(
        elevenLabsText
          ? "Đã chuyển giọng nói bằng ElevenLabs! Bé có thể bấm Nghe lại hoặc sửa trước khi gửi chấm bài nhé."
          : "Đã ghi lại lời kể của bé! Bé có thể đọc lại hoặc sửa trước khi gửi chấm bài nhé.",
      );
    } finally {
      setIsTranscribing(false);
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      browserRecognitionRef.current = null;
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
    lastSuccessfulSubmitRef.current = null;
  };

  const handleEvaluate = async (
    overrideTranscript?: string,
    overrideMode?: PictureInputMode,
    options?: { allowDuplicate?: boolean },
  ) => {
    if (!session || !pictureService || isEvaluating || isEvaluatingRef.current)
      return;
    const rawText =
      overrideTranscript !== undefined ? overrideTranscript : descriptionText;
    const trimmed = rawText.trim();
    if (!trimmed) {
      setEvaluateError(
        "Bé hãy nói hoặc viết ít nhất 1 câu mô tả bức tranh nhé.",
      );
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
      setEvaluateError(
        "Thiết bị đang mất mạng. Bài kể của bé vẫn được giữ nguyên — khi có mạng lại bé bấm Thử chấm lại ngay nhé!",
      );
      return;
    }

    stopSpeechPlayback();
    abortActiveVoiceCapture({ preserveDraft: false });
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    const sessionTargetWords = Array.from(
      new Set([
        ...(session.target_words ?? []),
        ...(session.guide.target_words ?? []),
      ]),
    );

    isEvaluatingRef.current = true;
    setActionError(null);
    setEvaluateError(null);
    setIsEvaluating(true);
    try {
      const response = await pictureService.evaluate(
        session.session_id,
        {
          transcript_text: trimmed,
          input_mode: overrideMode ?? inputMode,
          teaching_mode: teachingMode,
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
      setActiveFollowUpQuestion(
        response.latest_attempt.feedback.next_prompt_question ?? null,
      );
      setVoiceMessage(null);
      setEvaluateError(null);
      setPracticeTab("RESULT");
      setCatalogRefreshKey((value) => value + 1);
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
            <span>Chưa tải được hồ sơ của bé. Ba mẹ hãy thử lại nhé.</span>
            <Button
              className="w-auto"
              onClick={retryChild}
              size="compact"
              variant="secondary"
            >
              Thử lại
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
  const isLowerGrade = effectiveGrade <= 2;
  const isUpperGrade = effectiveGrade >= 4;
  const activeModeSpec = TEACHING_MODE_BY_ID[teachingMode];
  const targetWords = session
    ? Array.from(
        new Set([
          ...(session.target_words ?? []),
          ...(session.guide.target_words ?? []),
        ]),
      )
    : [];
  const usedTargetWordsCount = targetWords.filter((word) =>
    descriptionContainsTerm(descriptionText, word),
  ).length;
  const draftWordCount = countMeaningfulWords(descriptionText);
  const draftReadiness = readinessHint(draftWordCount, effectiveGrade);
  const usedVocabCount = session
    ? session.guide.suggested_vocabulary.filter((item) =>
        descriptionContainsTerm(descriptionText, item.word),
      ).length
    : 0;

  return (
    <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-6 pb-8">
      <BookChildHeader
        child={selectedChild}
        mobileLabel="Góc kể chuyện"
        backHref="/entertainment"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            className="inline-flex items-center gap-2 text-sm font-extrabold text-primary hover:underline"
            href="/entertainment"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Quay lại góc Giải trí
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-heading font-extrabold text-ink">
            Kể chuyện qua tranh
          </h1>
          <p className="text-body text-muted">
            Chọn một bức tranh. Bé có thể kể bằng giọng nói hoặc viết một câu về
            điều mình nhìn thấy.
          </p>
        </div>

        {session ? (
          <Button
            onClick={() => {
              stopSpeechPlayback();
              abortActiveVoiceCapture({ preserveDraft: false });
              setShowHints(false);
              setShowSampleSentences(false);
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
            <ArrowLeft aria-hidden="true" className="size-4" />
            Chọn bức tranh khác
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
            Đang chuẩn bị câu hỏi cho bức tranh…
          </h2>
          <p className="max-w-md text-body text-muted">
            Hệ thống đang chuẩn bị câu hỏi gợi ý và bộ từ vựng phù hợp cho Lớp{" "}
            {selectedChild.grade}. Đợi một chút xíu nhé!
          </p>
        </div>
      ) : null}

      {!session && !isAnalyzing ? (
        <>
          <div className="rounded-card border border-border bg-white p-5 shadow-sm sm:p-7">
            <div
              aria-label="Chọn nguồn tranh"
              className="flex flex-wrap gap-2 border-b border-border pb-4"
              role="tablist"
            >
              {(
                [
                  {
                    id: "SAMPLE",
                    label: "Tranh chủ đề ViRead",
                    icon: Images,
                  },
                  {
                    id: "CUSTOM_UPLOAD",
                    label: "Tải ảnh từ máy",
                    icon: ImagePlus,
                  },
                  {
                    id: "BOOK_PAGE",
                    label: "Tranh từ sách ViRead",
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
                      Thử lại
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
                                <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-extrabold text-primary shadow-sm">
                                  {sample.theme}
                                </span>
                                {hasPriorAttempt && existing ? (
                                  <span className="absolute right-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-extrabold text-success-ink shadow-sm">
                                    {existing.best_stars}/3 sao
                                  </span>
                                ) : null}
                              </div>
                              <div className="flex flex-1 flex-col justify-between gap-4 p-4">
                                <div>
                                  <h2 className="text-lg font-extrabold text-ink">
                                    {sample.title}
                                  </h2>
                                  <p className="mt-1 text-sm text-muted">
                                    {hasPriorAttempt && existing
                                      ? `Bé đã kể ${existing.attempts_count} lượt (cao nhất ${existing.best_score}/10).`
                                      : "Quan sát tranh và kể lại theo cách nghĩ của bé."}
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
                                      ? "Xem kết quả & Kể tiếp"
                                      : "Khám phá tranh này"}
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
                                      Tạo bộ gợi ý mới
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                    </div>
                    <PaginationBar
                      ariaLabel="Phân trang tranh chủ đề"
                      className="mt-4"
                      compact
                      itemLabel="tranh"
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
                            Chọn một bức ảnh hoặc tranh vẽ từ máy
                          </h2>
                          <p className="mt-1 text-sm text-muted">
                            Hỗ trợ ảnh JPG, PNG, WebP tối đa 5 MB. AI sẽ kiểm
                            tra độ an toàn cho bé và tạo câu hỏi gợi ý riêng cho
                            bức ảnh này.
                          </p>
                        </div>
                      </div>

                      <input
                        accept="image/jpeg,image/png,image/webp"
                        aria-label="Chọn tệp ảnh để mô tả"
                        className="sr-only"
                        onChange={handleFileChange}
                        ref={fileInputRef}
                        type="file"
                      />

                      <div className="flex flex-wrap gap-3">
                        <Button
                          onClick={() => fileInputRef.current?.click()}
                          type="button"
                          variant="secondary"
                        >
                          <ImagePlus aria-hidden="true" className="size-4" />
                          {uploadFile ? "Đổi ảnh khác" : "Chọn ảnh từ thiết bị"}
                        </Button>
                        {uploadFile ? (
                          <Button
                            onClick={() => void handleStartUpload()}
                            type="button"
                          >
                            <Sparkles aria-hidden="true" className="size-4" />
                            Phân tích tranh & Bắt đầu
                          </Button>
                        ) : null}
                      </div>

                      {uploadFile ? (
                        <p className="text-sm font-bold text-primary">
                          Đã chọn: {uploadFile.name}
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
                          alt="Ảnh xem trước của bé"
                          className="max-h-72 w-full rounded-control object-contain"
                          src={uploadPreviewUrl}
                        />
                      ) : (
                        <p className="text-center text-sm font-semibold text-muted">
                          Ảnh ba mẹ và bé chọn sẽ hiện xem trước ở đây.
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
                                    alt={`${page.book_title} - Trang ${page.page_number}`}
                                    className="h-full w-full object-cover"
                                    src={page.image_url}
                                  />
                                  {hasPriorAttempt && existing ? (
                                    <span className="absolute right-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-extrabold text-success-ink shadow-sm">
                                      {existing.best_stars}/3 sao
                                    </span>
                                  ) : null}
                                </div>
                                <div className="flex flex-1 flex-col justify-between gap-3 p-4">
                                  <div>
                                    <h2 className="line-clamp-1 text-base font-extrabold text-ink">
                                      {page.book_title}
                                    </h2>
                                    <p className="text-sm font-semibold text-muted">
                                      Trang {page.page_number}
                                      {hasPriorAttempt && existing
                                        ? ` • Đã kể ${existing.attempts_count} lượt`
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
                                        ? "Xem kết quả & Kể tiếp"
                                        : "Mô tả trang này"}
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
                                        Tạo bộ gợi ý mới
                                      </Button>
                                    ) : null}
                                  </div>
                                </div>
                              </article>
                            );
                          })}
                      </div>
                      <PaginationBar
                        ariaLabel="Phân trang tranh từ sách"
                        className="mt-4"
                        compact
                        itemLabel="trang"
                        onPageChange={setBookPagesPage}
                        page={bookPagesPage}
                        pageSize={PICTURE_GRID_PAGE_SIZE}
                        total={catalogState.catalog.book_pages.length}
                      />
                    </>
                  ) : (
                    <EmptyState
                      description="Hiện chưa có trang sách có tranh cho khối lớp này. Bé hãy thử chọn Tranh chủ đề ViRead hoặc Tải ảnh từ máy nhé!"
                      title="Chưa có trang sách phù hợp"
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
                Những bức tranh bé đã kể gần đây
              </h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {catalogState.sessions
                  .slice(
                    (sessionsPage - 1) * PICTURE_GRID_PAGE_SIZE,
                    sessionsPage * PICTURE_GRID_PAGE_SIZE,
                  )
                  .map((item) => (
                    <button
                      className="flex items-center gap-3 rounded-control border border-border bg-white p-3 text-left transition-colors hover:border-primary hover:bg-sky/20 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
                        <p className="truncate font-extrabold text-ink">
                          {item.scene_title}
                        </p>
                        <p className="text-xs font-semibold text-muted">
                          {sourceLabel(item.source_type)} •{" "}
                          {item.attempts_count > 0
                            ? `${item.attempts_count} lượt kể`
                            : "Chưa gửi lượt kể"}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          {renderStars(item.best_stars)}
                          {item.best_score > 0 ? (
                            <span className="text-xs font-extrabold text-primary">
                              {item.best_score}/10 điểm
                            </span>
                          ) : (
                            <span className="text-xs font-semibold text-muted">
                              Đang mở
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
              <PaginationBar
                ariaLabel="Phân trang tranh bé đã kể gần đây"
                className="mt-4"
                compact
                itemLabel="phiên"
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
                  {sourceLabel(session.source_type)} • Lớp {session.child_grade}
                </span>
                <h2 className="mt-2 text-xl font-extrabold text-ink">
                  {session.scene_title}
                </h2>
              </div>
              <div className="flex flex-col items-end gap-1">
                {renderStars(session.best_stars)}
                <span className="text-xs font-bold text-muted">
                  {session.attempts_count > 0
                    ? `Kỷ lục ${session.best_score}/10 • ${session.attempts_count} lượt`
                    : "Chưa có lượt chấm"}
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
                  {isLowerGrade
                    ? "Gợi ý trực quan cho bé (Lớp 1–2)"
                    : "Bố cục 3 bước kể chuyện hay"}
                </p>
                {isUpperGrade ? (
                  <button
                    aria-expanded={showGradeHintChips}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-extrabold text-primary shadow-2xs transition-colors hover:bg-sky"
                    data-testid="toggle-grade-hint-chips"
                    onClick={() => setShowGradeHintChips((value) => !value)}
                    type="button"
                  >
                    {showGradeHintChips ? (
                      <>
                        <ChevronUp aria-hidden="true" className="size-3.5" />
                        Thu gọn gợi ý khung kể
                      </>
                    ) : (
                      <>
                        <ChevronDown aria-hidden="true" className="size-3.5" />
                        Mở gợi ý khung kể
                      </>
                    )}
                  </button>
                ) : null}
              </div>

              {showGradeHintChips ? (
                <div
                  className="mt-2 space-y-2.5"
                  data-testid="grade-hint-chips"
                >
                  {isLowerGrade ? (
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
                            {chip.text}
                          </span>
                        ))}
                      </div>
                      <Button
                        onClick={() =>
                          void speakVietnamese(
                            activeModeSpec.audioHint,
                            `mode-audio:${teachingMode}`,
                          )
                        }
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        {playingSpeechKey === `mode-audio:${teachingMode}` ? (
                          <>
                            <VolumeX aria-hidden="true" className="size-3.5" />
                            Dừng nghe
                          </>
                        ) : (
                          <>
                            <Volume2 aria-hidden="true" className="size-3.5" />
                            Nghe hướng dẫn
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
                          Bước {item.step}:
                        </span>{" "}
                        <span className="font-bold text-ink">{item.title}</span>
                        <p className="mt-0.5 text-muted">{item.detail}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="mt-1.5 text-xs font-semibold text-muted">
                  Gợi ý khung kể đang được thu gọn cho Lớp {effectiveGrade} để
                  bé tự do diễn đạt — bấm &ldquo;Mở gợi ý khung kể&rdquo; bất cứ
                  lúc nào nhé!
                </p>
              )}
            </div>
          </div>

          {/* Interactive Recording + Optional Collapsed Hints + Evaluation Column */}
          <div className="flex flex-col gap-5">
            <div
              aria-label="Chế độ làm bài và kết quả"
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
                Mô tả tranh
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
                Kết quả chấm điểm
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
                  aria-label="Chế độ luyện tập cùng cô giáo AI"
                  className="rounded-card border border-border bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
                      Chế độ học cùng cô giáo AI
                    </p>
                    <Button
                      onClick={() =>
                        void speakVietnamese(
                          activeModeSpec.audioHint,
                          `mode-cue:${teachingMode}`,
                        )
                      }
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      {playingSpeechKey === `mode-cue:${teachingMode}` ? (
                        <>
                          <VolumeX aria-hidden="true" className="size-3.5" />
                          Dừng đọc
                        </>
                      ) : (
                        <>
                          <Volume2 aria-hidden="true" className="size-3.5" />
                          Nghe chế độ
                        </>
                      )}
                    </Button>
                  </div>
                  <div
                    className="mt-2.5 flex flex-wrap gap-2"
                    data-testid="teaching-mode-pills"
                    role="group"
                    aria-label="Chọn chế độ luyện kể chuyện"
                  >
                    {TEACHING_MODES.map((mode) => {
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
                          {mode.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs font-semibold text-muted">
                    {activeModeSpec.cue}
                  </p>

                  {targetWords.length > 0 ? (
                    <div
                      className="mt-3 border-t border-border pt-3"
                      data-testid="target-words-panel"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
                          Từ khó mục tiêu bé đang luyện ({usedTargetWordsCount}/
                          {targetWords.length})
                        </p>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {targetWords.map((word) => {
                          const used = descriptionContainsTerm(
                            descriptionText,
                            word,
                          );
                          return (
                            <button
                              className={
                                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-extrabold transition-colors " +
                                (used
                                  ? "border-success-ink/40 bg-success-surface text-success-ink"
                                  : "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100")
                              }
                              key={word}
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
                    aria-label="Câu hỏi gợi mở tiếp theo của cô giáo"
                    className="rounded-card border border-amber-300/70 bg-amber-50/70 p-4"
                    data-testid="practice-followup-banner"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-amber-900">
                        <Sparkles aria-hidden="true" className="size-4" />
                        Câu hỏi tiếp theo của cô giáo
                      </p>
                      <Button
                        onClick={() =>
                          void speakVietnamese(
                            activeFollowUpQuestion,
                            "practice-followup",
                          )
                        }
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        <Volume2 aria-hidden="true" className="size-3.5" />
                        {playingSpeechKey === "practice-followup"
                          ? "Dừng"
                          : "Nghe câu hỏi"}
                      </Button>
                    </div>
                    <p className="mt-1.5 text-sm font-bold text-ink">
                      {activeFollowUpQuestion}
                    </p>
                  </section>
                ) : null}

                {/* Coaching Reminder from Previous Attempt so Child Knows What to Improve */}
                {latestAttempt ? (
                  <section
                    aria-label="Gợi ý từ lượt chấm trước"
                    className="rounded-card border border-primary/25 bg-sky/20 p-4"
                  >
                    <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-primary">
                      <Lightbulb aria-hidden="true" className="size-4" />
                      Lời dặn của cô giáo từ Lượt #
                      {latestAttempt.attempt_number}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-ink">
                      {latestAttempt.feedback.improvement_tip}
                    </p>
                    {latestAttempt.feedback.missed_details.length > 0 ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-bold text-muted">
                          Chi tiết có thể kể thêm:
                        </span>
                        {latestAttempt.feedback.missed_details.map((detail) => (
                          <span
                            className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-ink shadow-2xs"
                            key={detail}
                          >
                            {detail}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {/* Child Input Area (Mic + Realtime Text + ElevenLabs TTS + Textarea) */}
                <section className="rounded-card border border-border bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-extrabold text-ink">
                      {latestAttempt
                        ? `Phần mô tả lượt #${session.attempts_count + 1} của bé`
                        : "Phần mô tả của bé"}
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
                            Xóa nháp
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
                                Dừng nghe
                              </>
                            ) : (
                              <>
                                <Volume2
                                  aria-hidden="true"
                                  className="size-4"
                                />
                                Nghe lại
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
                          Nói bằng Micro
                        </Button>
                      ) : (
                        <Button
                          onClick={() => void stopVoiceRecording()}
                          size="compact"
                          type="button"
                          variant="destructive"
                        >
                          <Square aria-hidden="true" className="size-4" />
                          Dừng ghi âm
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
                          Bé đang nói:
                        </span>
                      </div>
                      <p
                        className="min-w-0 flex-1 text-base font-extrabold text-ink"
                        data-testid="live-voice-transcript"
                      >
                        {liveTranscript ? (
                          <span className="text-primary underline decoration-2 underline-offset-4">
                            &ldquo;{liveTranscript}&rdquo;
                          </span>
                        ) : recorder.isSpeaking ? (
                          <span className="animate-pulse font-bold text-emerald-700">
                            Đang nhận diện giọng bé… (bé kể tiếp đi nào)
                          </span>
                        ) : (
                          <span className="text-sm font-medium italic text-muted">
                            Đang lắng nghe bé kể… (bé hãy nói vào mic)
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
                    <span className="sr-only">Nội dung bé mô tả bức tranh</span>
                    <textarea
                      className="min-h-32 w-full rounded-control border border-border bg-white p-3.5 text-base font-medium text-ink focus:border-primary focus:outline-none"
                      id="picture-description-input"
                      maxLength={2000}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setDescriptionText(nextValue);
                        if (evaluateError) setEvaluateError(null);
                        if (!nextValue.trim() || inputMode !== "VOICE") {
                          setInputMode("TEXT");
                        }
                      }}
                      placeholder="Bé hãy nói qua Micro hoặc viết 1–3 câu tự kể những gì bé nhìn thấy trong tranh nhé..."
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
                      <span>
                        Cô giáo AI đang ngắm tranh và đọc kỹ bài kể của bé, đợi
                        cô vài giây nhé...
                      </span>
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
                            Thử chấm lại ngay
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
                        {descriptionText.trim().length}/2000 ký tự
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
                        ? "Cô giáo AI đang chấm bài..."
                        : "Gửi cô giáo AI chấm bài"}
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
                        Gợi ý thêm (khi bé cần)
                      </h2>
                      {usedVocabCount > 0 ? (
                        <span className="rounded-full bg-success-surface px-2.5 py-0.5 text-xs font-extrabold text-success-ink">
                          Đã dùng {usedVocabCount}/
                          {session.guide.suggested_vocabulary.length} từ gợi ý
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
                          Thu gọn gợi ý
                        </>
                      ) : (
                        <>
                          <ChevronDown aria-hidden="true" className="size-4" />
                          Mở gợi ý câu hỏi
                        </>
                      )}
                    </Button>
                  </div>

                  {showHints ? (
                    <div className="mt-4 border-t border-border pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                          Câu hỏi gợi mở quan sát
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
                              Dừng đọc
                            </>
                          ) : (
                            <>
                              <Volume2 aria-hidden="true" className="size-4" />
                              Nghe gợi ý
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
                              <span>{question}</span>
                            </li>
                          ),
                        )}
                      </ol>

                      <div className="mt-4">
                        <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                          Từ vựng gợi ý (nhấn vào từ để nghe giải nghĩa)
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
                                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                                  (active
                                    ? "border-primary bg-primary text-white"
                                    : used
                                      ? "border-success-ink/40 bg-success-surface/60 text-success-ink"
                                      : "border-border bg-white text-ink hover:border-primary hover:bg-sky/30")
                                }
                                key={item.word}
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
                            <p>
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
                                Chèn vào bài kể
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-4 border-t border-border pt-3">
                        {!hasSubmittedAttempt ? (
                          <p className="text-sm font-semibold text-muted">
                            Câu mẫu tham khảo sẽ mở sau khi bé tự kể và gửi lượt
                            đầu tiên nhé!
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
                                  Ẩn câu mẫu tham khảo
                                </>
                              ) : (
                                <>
                                  <Eye aria-hidden="true" className="size-4" />
                                  Xem câu mẫu tham khảo
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
                                      <span>“{sentence}”</span>
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
                                          ? "Dừng"
                                          : "Nghe"}
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
                      Lịch sử các lượt:
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
                          Lượt #{attempt.attempt_number}
                          {index === 0 ? " (Mới nhất)" : ""} •{" "}
                          {attempt.score_out_of_10}/10
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                  <div className="flex flex-wrap items-center gap-3">
                    {renderStars(activeAttempt.stars)}
                    <span className="rounded-full bg-success-surface px-3 py-1 text-sm font-extrabold text-success-ink">
                      {activeAttempt.score_out_of_10}/10 điểm
                    </span>
                    <span className="text-xs font-bold text-muted">
                      Lượt #{activeAttempt.attempt_number}
                    </span>
                    {activeAttempt.feedback.teaching_mode ? (
                      <span className="rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary">
                        Chế độ:{" "}
                        {
                          TEACHING_MODE_BY_ID[
                            activeAttempt.feedback.teaching_mode
                          ].label
                        }
                      </span>
                    ) : null}
                    {scoreDelta !== null && scoreDelta > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-extrabold text-emerald-800">
                        <TrendingUp aria-hidden="true" className="size-3.5" />+
                        {scoreDelta} điểm so với lượt trước!
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
                        Dừng nghe
                      </>
                    ) : (
                      <>
                        <Volume2 aria-hidden="true" className="size-4" />
                        Nghe nhận xét
                      </>
                    )}
                  </Button>
                </div>

                {activeAttempt.evaluation_source === "FALLBACK" ? (
                  <div className="mt-4">
                    <StatusMessage tone="info">
                      <div className="flex flex-wrap items-center justify-between gap-2.5">
                        <span>
                          Cô giáo AI đang tạm bận nên hệ thống đã chấm nhanh
                          theo gợi ý của bức tranh để bé nhận phản hồi ngay.
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
                              "size-4 " + (isEvaluating ? "animate-spin" : "")
                            }
                          />
                          {isEvaluating
                            ? "Đang chấm lại..."
                            : "Chấm lại bằng cô giáo AI"}
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
                    Lời bé đã kể (Lượt #{activeAttempt.attempt_number})
                  </p>
                  <p className="mt-1 text-sm font-semibold text-ink">
                    “{activeAttempt.transcript_text}”
                  </p>
                </div>

                <p className="mt-4 rounded-control bg-warning-surface/50 px-4 py-3 text-base font-extrabold text-ink">
                  {activeAttempt.feedback.praise_message}
                </p>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-control bg-success-surface/40 p-3.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-success-ink">
                      <CheckCircle2 aria-hidden="true" className="size-4" />
                      Chi tiết bé kể đúng
                    </h3>
                    {activeAttempt.feedback.matched_details.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink">
                        {activeAttempt.feedback.matched_details.map((item) => (
                          <li key={item}>• {item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted">
                        Chưa có chi tiết khớp trong lượt này — bé hãy quan sát
                        kỹ tranh và thử lại nhé!
                      </p>
                    )}
                  </div>

                  <div className="rounded-control bg-sky/40 p-3.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-primary">
                      <Lightbulb aria-hidden="true" className="size-4" />
                      Chi tiết bé có thể kể thêm
                    </h3>
                    {activeAttempt.feedback.missed_details.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink">
                        {activeAttempt.feedback.missed_details.map((item) => (
                          <li key={item}>• {item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted">
                        Bé đã kể đầy đủ các chi tiết chính trong tranh rồi!
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-4 rounded-control border border-border p-3.5">
                  <p className="text-sm font-bold text-ink">
                    Mẹo cho lượt kể sau:{" "}
                    <span className="font-semibold text-muted">
                      {activeAttempt.feedback.improvement_tip}
                    </span>
                  </p>
                  {activeAttempt.feedback.upgraded_sentences.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                        Gợi ý câu diễn đạt hay hơn cho bé
                      </p>
                      <ul className="mt-1.5 flex flex-col gap-1.5">
                        {activeAttempt.feedback.upgraded_sentences.map(
                          (sentence, index) => (
                            <li
                              className="flex items-center justify-between gap-2 rounded-control bg-sky/25 px-3 py-2 text-sm font-bold text-ink"
                              key={sentence}
                            >
                              <span>“{sentence}”</span>
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
                                  ? "Dừng"
                                  : "Nghe"}
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
                        Từ khó mục tiêu bé đã dùng rất tốt
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {activeAttempt.feedback.used_target_words.map(
                          (word) => (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-success-surface px-3 py-1 text-xs font-extrabold text-success-ink"
                              key={word}
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
                        Từ ngữ miêu tả hay cô tặng bé (nhấn để nghe)
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {activeAttempt.feedback.vocabulary_highlights.map(
                          (word) => (
                            <button
                              className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-sky/25 px-3 py-1 text-xs font-extrabold text-primary transition-colors hover:bg-sky/50"
                              key={word}
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

                {activeAttempt.feedback.next_prompt_question ? (
                  <div
                    className="mt-4 rounded-control border border-primary/30 bg-sky/25 p-4"
                    data-testid="ai-followup-question"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-primary">
                          <Sparkles aria-hidden="true" className="size-4" />
                          Câu hỏi gợi mở tiếp theo của cô giáo
                        </p>
                        {activeAttempt.feedback.scaffolding_step ? (
                          <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-extrabold text-ink shadow-2xs">
                            {
                              SCAFFOLDING_STEP_LABELS[
                                activeAttempt.feedback.scaffolding_step
                              ]
                            }
                          </span>
                        ) : null}
                      </div>
                      <Button
                        onClick={() =>
                          void speakVietnamese(
                            activeAttempt.feedback.next_prompt_question ?? "",
                            `followup:${activeAttempt.attempt_id}`,
                          )
                        }
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        <Volume2 aria-hidden="true" className="size-3.5" />
                        {playingSpeechKey ===
                        `followup:${activeAttempt.attempt_id}`
                          ? "Dừng nghe"
                          : "Nghe câu hỏi"}
                      </Button>
                    </div>
                    <p className="mt-2 text-sm font-bold text-ink">
                      {activeAttempt.feedback.next_prompt_question}
                    </p>
                    <div className="mt-3">
                      <Button
                        onClick={() => {
                          stopSpeechPlayback();
                          setActiveFollowUpQuestion(
                            activeAttempt.feedback.next_prompt_question ?? null,
                          );
                          setDescriptionText("");
                          setInputMode("TEXT");
                          setVoiceMessage(null);
                          setPracticeTab("PRACTICE");
                        }}
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        Trả lời câu hỏi này
                      </Button>
                    </div>
                  </div>
                ) : null}

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
                    Sửa & bổ sung bài vừa kể
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
                    Kể lại từ đầu (lượt mới)
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
