"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import { resolvePostFinishUiState } from "@/lib/reading/post-finish-questions";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { ReadingReady } from "@/components/reading/reading-ready";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { classifyRetryTranscript } from "@/lib/reading/retry-word-recognition";
import type { WordTimestamp } from "@/lib/api/speech-service";
import {
  BrowserTranscriptCollector,
  resolveTranscriptForSegment,
} from "@/lib/reading/browser-transcript-collector";
import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";
import { SessionComplete } from "@/components/reading/session-complete";
import { StatusBanner } from "@/components/reading/status-banner";
import { TutorMessage } from "@/components/reading/tutor-message";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import {
  RealtimeAlignmentEngine,
  type RealtimeAlignmentSnapshot,
} from "@/lib/reading/realtime-alignment";
import {
  sortRetryWordRecords,
  type RetryWordRecord,
} from "@/lib/reading/retry-recognition";
import { isServiceError } from "@/lib/api/service-error";
import { createSpeechService } from "@/lib/api/speech-service";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ReadingCompletionSummaryUI,
  ReadingConnectionState,
  ReadingPageDTO,
  ReadingPageWordDTO,
  ReadingReconnectDemoMode,
  ReadingSessionState,
  ReadingSessionPageProgressDTO,
  ReadingUiState,
  TutorAction,
} from "@/types/reading";
import {
  compareTranscript,
  type ComparisonResult,
} from "@/lib/api/comparison-service";

interface ReadingScreenProps {
  initialPageId?: string;
  initialUiState: ReadingUiState;
  reconnectMode: ReadingReconnectDemoMode;
  sessionId: string;
}

interface ReadingScreenData {
  book: BookDetailDTO;
  child: ChildProfileDTO;
  completion: ReadingCompletionSummaryUI;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: ReadingScreenData }
  | { status: "not-found" }
  | { status: "error" };
interface BrowserSpeechEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface BrowserSpeechErrorEvent {
  error?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechEvent) => void) | null;
  onerror: ((event: BrowserSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

interface WindowWithSpeech {
  SpeechRecognition?: new () => BrowserSpeechRecognition;
  webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
}
interface RetryWordCandidate {
  wordId: string;
  text: string;
  contextPhrase: string;
  pageId: string;
  pageRevisionId: string;
  pageNumber: number;
  wordIndex: number;
  originalStatus: "OMISSION" | "MISPRONUNCIATION";
}
type RetryFeedback =
  | "waiting"
  | "preparing-microphone"
  | "playing-instruction"
  | "playing-sample"
  | "listening"
  | "processing"
  | "correct"
  | "incorrect"
  | "not-recognized"
  | "microphone-unavailable"
  | "speech-unavailable"
  | "audio-unavailable"
  | "save-error";

interface PendingRetryEvent {
  readonly candidate: RetryWordCandidate;
  readonly status: "CONFIRMED" | "FAILED";
  readonly transcript: string;
  readonly attempt: number;
}
interface PageTranscriptBucket {
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly page_number: number;
  readonly segments: string[];
  readonly words: WordTimestamp[];
}
type RetryWordItem = RetryWordRecord;

const RETRY_CAPTURE_MAX_MS = 12_000;
const RETRY_CAPTURE_MIN_MS = 3_500;
const RETRY_CAPTURE_SILENCE_MS = 1_500;
const RETRY_CAPTURE_POLL_MS = 200;

// Measure recorder duration with a monotonic clock from capture callbacks.
function getRetryCaptureTimeMs(): number {
  return performance.now();
}

export function ReadingScreen({
  initialPageId,
  initialUiState,
  reconnectMode,
  sessionId,
}: ReadingScreenProps) {
  const services = useReadingServices();
  const speechService = useMemo(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const speechRecorder = useSpeechRecorder();
  const cancelRecording = speechRecorder.cancel;
  const [loadKey, setLoadKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [uiState, setUiState] = useState<ReadingUiState>(initialUiState);
  const [canonicalState, setCanonicalState] =
    useState<ReadingSessionState>("CREATED");
  const [page, setPage] = useState<ReadingPageDTO | null>(null);
  const [pageProgress, setPageProgress] =
    useState<ReadingSessionPageProgressDTO | null>(null);
  const [pageNavigationError, setPageNavigationError] = useState<string | null>(
    null,
  );
  const [currentWordId, setCurrentWordId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ReadingConnectionState>(() =>
      initialUiState === "reconnecting" || initialUiState === "stt-error"
        ? "reconnecting"
        : "connected",
    );
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [tutorAction, setTutorAction] = useState<TutorAction | null>(null);
  const tutorResumeListeningRef = useRef(false);
  const tutorResumeMicAfterPlaybackRef = useRef(false);
  const tutorPlaybackGenerationRef = useRef(0);
  const [latestTranscript, setLatestTranscript] = useState<string | null>(null);
  const [comparisonResult, setComparisonResult] =
    useState<ComparisonResult | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [hasPageTranscripts, setHasPageTranscripts] = useState(false);
  const [isRetryingReports, setIsRetryingReports] = useState(false);
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isReadingWord, setIsReadingWord] = useState(false);
  const [previewSnapshot, setPreviewSnapshot] =
    useState<RealtimeAlignmentSnapshot | null>(null);
  const [spokenWords, setSpokenWords] = useState<Set<string>>(() => new Set());
  const [correctWordIds, setCorrectWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mispronouncedWordIds, setMispronouncedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [skippedWordIds, setSkippedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [repeatedWordIds, setRepeatedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hesitationWordIds, setHesitationWordIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [sessionSummary, setSessionSummary] =
    useState<ReadingCompletionSummaryUI | null>(null);
  const spokenWordsSetRef = useRef<Set<string>>(new Set());
  const correctWordIdsRef = useRef<Set<string>>(new Set());
  const mispronouncedWordIdsRef = useRef<Set<string>>(new Set());
  const failedWordsSetRef = useRef<Set<string>>(new Set());
  const transcriptsListRef = useRef<string[]>([]);
  const alignmentEngineRef = useRef<RealtimeAlignmentEngine | null>(null);
  const autoCompletePageAfterFinalWordRef = useRef<
    (snapshot: RealtimeAlignmentSnapshot) => Promise<void>
  >(async () => undefined);
  const lastPreviewWordIndexRef = useRef(-1);
  const skippedWordIdsRef = useRef<Set<string>>(new Set());
  const repeatedWordIdsRef = useRef<Set<string>>(new Set());
  const hesitationWordIdsRef = useRef<Set<string>>(new Set());
  const [retryPrompt, setRetryPrompt] = useState(false);
  const [retryMode, setRetryMode] = useState(false);
  const [retryCandidates, setRetryCandidates] = useState<RetryWordCandidate[]>(
    [],
  );
  const retryCandidatesRef = useRef<RetryWordCandidate[]>([]);
  // The ref is the authoritative queue for asynchronous retry handlers.
  // Update it synchronously alongside render state at each queue mutation.
  const [retryConfirmedWordIds, setRetryConfirmedWordIds] = useState<
    Set<string>
  >(() => new Set());
  const [retryWordPosition, setRetryWordPosition] = useState(0);
  const [retryFeedback, setRetryFeedback] = useState<RetryFeedback>("waiting");
  const retryModeRef = useRef(false);
  const retryProcessingRef = useRef(false);
  const retryListeningWantedRef = useRef(false);
  const retryPositionRef = useRef(0);
  const retryShouldRestartRef = useRef(false);

  const retryAttemptIdRef = useRef(0);
  const retryAbortControllerRef = useRef<AbortController | null>(null);
  const retryCaptureAttemptRef = useRef(0);
  const retryCaptureStartedAtRef = useRef(0);
  const retrySpeechObservedRef = useRef(false);
  const retrySilenceStartedAtRef = useRef<number | null>(null);
  const pendingRetryEventRef = useRef<PendingRetryEvent | null>(null);

  useEffect(() => {
    if (!page?.words?.length) {
      alignmentEngineRef.current = null;
      return;
    }

    lastPreviewWordIndexRef.current = -1;
    alignmentEngineRef.current = new RealtimeAlignmentEngine(page.words, 3, 2);

    return () => {
      alignmentEngineRef.current = null;
    };
  }, [page]);
  const pageTranscriptsRef = useRef<Map<string, PageTranscriptBucket>>(
    new Map(),
  );
  const browserTranscriptCollectorRef = useRef(
    new BrowserTranscriptCollector(),
  );
  const browserStopResolveRef = useRef<(() => void) | null>(null);
  const wordTextByIdRef = useRef<Map<string, string>>(new Map());
  const retryWordsByIdRef = useRef<Map<string, RetryWordItem>>(new Map());
  const pageWordsByRevisionRef = useRef(
    new Map<string, readonly ReadingPageWordDTO[]>(),
  );
  const finishStartedRef = useRef(false);
  const retryReportSaveStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isListeningActiveRef = useRef(false);
  const retryRecorderActiveRef = useRef(false);
  const retryCaptureTimeoutRef = useRef<number | null>(null);
  const assistantAudioPendingRef = useRef(false);
  const assistantAudioPlayingRef = useRef(false);
  const assistantAudioGenerationRef = useRef(0);
  const assistantAudioResumeRequestedRef = useRef(false);
  const pageCompletionStartedRef = useRef<string | null>(null);

  const startListeningRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const isUsingRecorderRef = useRef(false);
  const prepareFinishStartedRef = useRef(false);
  const initialAssessmentPreparedRef = useRef(false);

  const pageWordContextRef = useRef(
    new Map<
      string,
      {
        pageId: string;
        pageRevisionId: string;
        pageNumber: number;
        wordIndex: number;
        text: string;
      }
    >(),
  );
  const recordSpokenText = useCallback(
    (
      text: string,
      pageSnapshot: Pick<
        ReadingPageDTO,
        "page_id" | "page_revision_id" | "page_number"
      >,
      words: readonly WordTimestamp[] | null = null,
    ) => {
      const trimmed = text.trim();
      if (!trimmed || assistantAudioPlayingRef.current) return;

      setHasPageTranscripts(true);
      transcriptsListRef.current.push(trimmed);

      const bucketKey = `${pageSnapshot.page_id}:${pageSnapshot.page_revision_id}`;
      let bucket = pageTranscriptsRef.current.get(bucketKey);
      if (!bucket) {
        bucket = {
          page_id: pageSnapshot.page_id,
          page_revision_id: pageSnapshot.page_revision_id,
          page_number: pageSnapshot.page_number,
          segments: [],
          words: [],
        };
        pageTranscriptsRef.current.set(bucketKey, bucket);
      }
      const isFirstSegmentForPage = bucket.segments.length === 0;
      bucket.segments.push(trimmed);

      // ElevenLabs word timestamps are relative to the uploaded audio segment.
      // Once a page uses more than one capture segment, their clocks cannot be
      // safely merged without real inter-segment timing evidence.
      if (isFirstSegmentForPage && words?.length) {
        bucket.words.push(...words);
      } else if (!isFirstSegmentForPage) {
        bucket.words.length = 0;
      }

      const spokenTokens = trimmed
        .replace(/[.,/#!$%^&*;:{}=\-_`~()?'\"“”—]/g, "")
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length > 0);

      for (const word of spokenTokens) {
        spokenWordsSetRef.current.add(word);
      }
      setSpokenWords(new Set(spokenWordsSetRef.current));
    },
    [],
  );

  async function handleWordClick(word: ReadingPageWordDTO): Promise<void> {
    setCurrentWordId(word.word_id);

    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
    }

    setIsReadingWord(true);
    try {
      await playAssistantAudio(() => speechPlayer.play(word.text), true);
    } catch (err) {
      console.warn("Lỗi phát âm 1 từ:", err);
    } finally {
      if (mountedRef.current) {
        setIsReadingWord(false);
      }
    }
  }

  function handleReadCurrentWord(): void {
    if (!page || !currentWordId) return;
    const word = page.words.find((w) => w.word_id === currentWordId);
    if (word) {
      void handleWordClick(word);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      isListeningActiveRef.current = false;
      retryModeRef.current = false;
      retryAttemptIdRef.current += 1;
      retryAbortControllerRef.current?.abort();
      cancelRecording();
      transcriptionAbortRef.current?.abort();
      if (
        typeof window !== "undefined" &&
        retryCaptureTimeoutRef.current !== null
      ) {
        window.clearTimeout(retryCaptureTimeoutRef.current);
        retryCaptureTimeoutRef.current = null;
      }
      if (retryRecorderActiveRef.current) {
        retryRecorderActiveRef.current = false;
      }
      try {
        recognitionRef.current?.abort?.();
      } catch {
        // Safe ignore
      }
    };
  }, [cancelRecording]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown > 0) {
      const timer = setTimeout(() => {
        if (mountedRef.current) {
          setCountdown((c) => (c !== null ? c - 1 : null));
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
    const finishTimer = setTimeout(() => {
      if (assistantAudioPendingRef.current) {
        setCountdown(null);
        return;
      }
      if (mountedRef.current) {
        setCountdown(null);
        void startListeningRef.current().then((ok) => {
          if (mountedRef.current && ok) {
            setIsMicRecording(true);
          }
        });
      }
    }, 400);
    return () => clearTimeout(finishTimer);
  }, [countdown]);

  useEffect(() => {
    if (!page) return;

    pageWordsByRevisionRef.current.set(
      `${page.page_id}:${page.page_revision_id}`,
      page.words,
    );

    page.words.forEach((word, index) => {
      wordTextByIdRef.current.set(word.word_id, word.text);

      pageWordContextRef.current.set(word.word_id, {
        pageId: page.page_id,
        pageRevisionId: page.page_revision_id,
        pageNumber: page.page_number,
        wordIndex: word.word_index ?? index,
        text: word.text,
      });
    });
  }, [page]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = await services.readingService.get(sessionId);
        const [book, child, currentPage, completion, initialProgress] =
          await Promise.all([
            services.bookService.get(session.book_id),
            services.childService.get(session.child_id),
            services.readingService.getCurrentPage(sessionId),
            services.readingService.getCompletionSummary(sessionId),
            services.readingService.getPageProgress(sessionId),
          ]);

        // Server-side progress is authoritative on reload. A stale pageId query
        // must not reset a session that was already advanced to another page.
        const requestedPageIsOutsideRange =
          Boolean(initialPageId) &&
          !initialProgress.pages.some((item) => item.page_id === initialPageId);

        if (!active) return;

        setPage(currentPage);
        setPageProgress(initialProgress);
        setPageNavigationError(
          requestedPageIsOutsideRange
            ? "Trang từ liên kết không thuộc phạm vi buổi đọc. Đã khôi phục trang hiện tại đã lưu."
            : null,
        );
        setCurrentWordId(currentPage.words[0]?.word_id ?? null);
        setCanonicalState(session.state);
        setLoadState({
          status: "ready",
          data: { book, child, completion },
        });
      } catch (error) {
        if (active) {
          setLoadState({
            status:
              isServiceError(error) && error.code === "RESOURCE_NOT_FOUND"
                ? "not-found"
                : "error",
          });
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [initialPageId, loadKey, services, sessionId]);

  useEffect(() => {
    if (loadState.status !== "ready") return;
    return services.readingSocketAdapter.subscribe(
      sessionId,
      setCanonicalState,
    );
  }, [loadState.status, services.readingSocketAdapter, sessionId]);

  useEffect(() => {
    if (
      loadState.status !== "ready" ||
      uiState !== "page-turn" ||
      !page ||
      !pageProgress
    ) {
      return;
    }

    const nextPage = pageProgress.pages[pageProgress.current_index + 1];
    // The final-page message and disabled Next button are rendered from
    // pageProgress; do not set state synchronously inside this effect.
    if (!nextPage) return;

    let active = true;
    void services.pageMatchService
      .selectPage(sessionId, nextPage.page_id)
      .then(async (matchedPage) => {
        const progress =
          await services.readingService.getPageProgress(sessionId);
        if (!active) return;
        setPage(matchedPage);
        setPageProgress(progress);
        setPageNavigationError(null);
        setCurrentWordId(matchedPage.words[0]?.word_id ?? null);
        setCanonicalState("LISTENING");
        setUiState("reading");
      })
      .catch(() => {
        if (!active) return;
        setPageNavigationError(
          "Chưa chuyển được sang trang tiếp theo. Bé có thể thử lại bằng nút Trang tiếp theo.",
        );
        setUiState("reading");
      });

    return () => {
      active = false;
    };
  }, [
    loadState,
    page,
    pageProgress,
    services.pageMatchService,
    services.readingService,
    sessionId,
    uiState,
  ]);

  function applyRealtimeSnapshot(snapshot: RealtimeAlignmentSnapshot) {
    // Đây là kết quả đã xác nhận, không phải preview.
    const nextCorrectIds = new Set(correctWordIdsRef.current);
    const nextMispronouncedIds = new Set(mispronouncedWordIdsRef.current);
    const nextSkippedIds = new Set(skippedWordIdsRef.current);
    const nextRepeatedIds = new Set(repeatedWordIdsRef.current);
    const nextHesitationIds = new Set(hesitationWordIdsRef.current);

    for (const word of snapshot.statusByWordId.values()) {
      const retryItem = retryWordsByIdRef.current.get(word.wordId);
      const retryContext = pageWordContextRef.current.get(word.wordId);

      switch (word.status) {
        case "MATCH":
          nextCorrectIds.add(word.wordId);
          nextMispronouncedIds.delete(word.wordId);
          nextSkippedIds.delete(word.wordId);
          nextRepeatedIds.delete(word.wordId);

          // Đọc đúng trong lượt đầu thì không cần retry.
          retryWordsByIdRef.current.delete(word.wordId);
          break;

        case "SUBSTITUTE":
          nextMispronouncedIds.add(word.wordId);
          nextCorrectIds.delete(word.wordId);
          nextSkippedIds.delete(word.wordId);
          nextRepeatedIds.delete(word.wordId);

          if (retryContext) {
            retryWordsByIdRef.current.set(word.wordId, {
              word_id: word.wordId,
              page_id: retryContext.pageId,
              page_revision_id: retryContext.pageRevisionId,
              page_number: retryContext.pageNumber,
              word_index: retryContext.wordIndex,
              text: retryContext.text,
              original_status: "MISPRONUNCIATION",
            });
          } else if (retryItem) {
            retryWordsByIdRef.current.set(word.wordId, {
              ...retryItem,
              original_status: "MISPRONUNCIATION",
            });
          }
          break;

        case "DELETE":
          nextSkippedIds.add(word.wordId);
          nextCorrectIds.delete(word.wordId);
          nextMispronouncedIds.delete(word.wordId);
          nextRepeatedIds.delete(word.wordId);

          if (retryContext) {
            retryWordsByIdRef.current.set(word.wordId, {
              word_id: word.wordId,
              page_id: retryContext.pageId,
              page_revision_id: retryContext.pageRevisionId,
              page_number: retryContext.pageNumber,
              word_index: retryContext.wordIndex,
              text: retryContext.text,
              original_status: "OMISSION",
            });
          } else if (retryItem) {
            retryWordsByIdRef.current.set(word.wordId, {
              ...retryItem,
              original_status: "OMISSION",
            });
          }
          break;

        case "REPEATED":
          nextRepeatedIds.add(word.wordId);
          nextCorrectIds.delete(word.wordId);
          nextMispronouncedIds.delete(word.wordId);
          nextSkippedIds.delete(word.wordId);

          // Không retry từ đọc lặp.
          retryWordsByIdRef.current.delete(word.wordId);
          break;
      }
    }

    for (const id of snapshot.repeatedWordIds) {
      nextRepeatedIds.add(id);
      retryWordsByIdRef.current.delete(id);
    }

    for (const id of snapshot.hesitationWordIds) {
      nextHesitationIds.add(id);
    }

    correctWordIdsRef.current = nextCorrectIds;
    mispronouncedWordIdsRef.current = nextMispronouncedIds;
    skippedWordIdsRef.current = nextSkippedIds;
    repeatedWordIdsRef.current = nextRepeatedIds;
    hesitationWordIdsRef.current = nextHesitationIds;

    const nextFailedWords = new Set<string>();

    for (const id of nextMispronouncedIds) {
      const word = wordTextByIdRef.current.get(id);
      if (word) nextFailedWords.add(word);
    }

    failedWordsSetRef.current = nextFailedWords;

    setCorrectWordIds(nextCorrectIds);
    setMispronouncedWordIds(nextMispronouncedIds);
    setSkippedWordIds(nextSkippedIds);
    setRepeatedWordIds(nextRepeatedIds);
    setHesitationWordIds(nextHesitationIds);

    setCurrentWordId(snapshot.currentWordId);

    const nextSpokenWords = new Set(spokenWordsSetRef.current);

    for (const word of snapshot.spokenWords) {
      nextSpokenWords.add(word);
    }

    spokenWordsSetRef.current = nextSpokenWords;
    setSpokenWords(nextSpokenWords);
  }

  function applyPreviewSnapshot(snapshot: RealtimeAlignmentSnapshot) {
    // Không ghi preview vào các ref thống kê chính thức.
    setPreviewSnapshot(snapshot);

    // Cập nhật từ đang đọc ngay cả khi chưa có final transcript.
    setCurrentWordId(snapshot.currentWordId);
  }

  function resetWordTracking() {
    setPreviewSnapshot(null);
    lastPreviewWordIndexRef.current = -1;
    spokenWordsSetRef.current.clear();
    correctWordIdsRef.current.clear();
    mispronouncedWordIdsRef.current.clear();
    skippedWordIdsRef.current.clear();
    repeatedWordIdsRef.current.clear();
    hesitationWordIdsRef.current.clear();
    failedWordsSetRef.current.clear();

    setSpokenWords(new Set());
    setCorrectWordIds(new Set());
    setMispronouncedWordIds(new Set());
    setSkippedWordIds(new Set());
    setRepeatedWordIds(new Set());
    setHesitationWordIds(new Set());
    setLatestTranscript(null);
    setComparisonResult(null);
    setCurrentWordId(null);
  }

  async function startListening(): Promise<boolean> {
    if (assistantAudioPendingRef.current) return false;

    setLatestTranscript(null);
    setComparisonResult(null);
    setComparisonError(null);
    browserTranscriptCollectorRef.current.reset();

    let recorderStarted = false;
    try {
      await speechRecorder.start();
      if (assistantAudioPendingRef.current) {
        speechRecorder.cancel();
        return false;
      }
      isUsingRecorderRef.current = true;
      recorderStarted = true;
    } catch (error) {
      if (assistantAudioPendingRef.current) return false;
      const message = error instanceof Error ? error.message : "";
      if (!message.toLowerCase().includes("not supported")) {
        if (mountedRef.current) {
          setConnectionState("reconnecting");
          setUiState("microphone-denied");
        }
        return false;
      }
      // Web Speech can still provide final transcript results without MediaRecorder.
      isUsingRecorderRef.current = false;
    }

    isListeningActiveRef.current = true;
    let browserRecognitionStarted = false;

    if (typeof window !== "undefined") {
      try {
        const win = window as unknown as WindowWithSpeech;
        const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
        if (SpeechRec) {
          const rec = new SpeechRec();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = "vi-VN";
          rec.maxAlternatives = 1;

          rec.onresult = (event: BrowserSpeechEvent) => {
            if (
              assistantAudioPlayingRef.current ||
              recognitionRef.current !== rec
            ) {
              return;
            }
            browserTranscriptCollectorRef.current.addResults(event);

            const engine = alignmentEngineRef.current;

            if (!engine || !mountedRef.current) return;

            let interimText = "";
            let latestFinalText = "";

            // 1. Xử lý các kết quả FINAL mới.
            for (
              let index = event.resultIndex;
              index < event.results.length;
              index += 1
            ) {
              const result = event.results[index];
              const part = result[0]?.transcript?.trim() || "";

              if (!part || !result.isFinal) continue;

              latestFinalText += (latestFinalText ? " " : "") + part;

              const snapshot = engine.addFinalTranscript(part);

              applyRealtimeSnapshot(snapshot);
            }

            // 2. Lấy toàn bộ INTERIM hiện tại.
            for (let index = 0; index < event.results.length; index += 1) {
              const result = event.results[index];

              if (result.isFinal) continue;

              const part = result[0]?.transcript?.trim() || "";

              if (part) {
                interimText += (interimText ? " " : "") + part;
              }
            }

            // 3. Cập nhật preview ngay khi bé đang nói.
            if (interimText.trim()) {
              const preview = engine.previewAlignment(interimText);

              applyPreviewSnapshot(preview);
            } else {
              setPreviewSnapshot(null);
            }

            // 4. Cập nhật nội dung transcript.
            if (!mountedRef.current) return;

            if (interimText.trim()) {
              setLatestTranscript(interimText.trim());
            } else if (latestFinalText.trim()) {
              setLatestTranscript((previous) =>
                [previous, latestFinalText.trim()].filter(Boolean).join(" "),
              );
            }

            if (latestFinalText.trim() && !interimText.trim()) {
              void autoCompletePageAfterFinalWordRef.current(
                engine.getSnapshot(),
              );
            }
          };

          rec.onerror = (event: BrowserSpeechErrorEvent) => {
            // Chrome often emits `aborted` when stopping recognition to play
            // an assistant sample. This is an expected handoff, not an STT
            // failure, and must not trigger a restart/error state.
            if (
              event.error === "aborted" ||
              event.error === "no-speech" ||
              assistantAudioPendingRef.current ||
              assistantAudioPlayingRef.current
            ) {
              return;
            }

            console.error("[REALTIME STT ERROR]", {
              error: event.error,
              recorderStarted,
              browserRecognitionStarted,
              isListeningActive: isListeningActiveRef.current,
            });

            if (
              event.error === "not-allowed" ||
              event.error === "service-not-allowed" ||
              event.error === "language-not-supported"
            ) {
              isListeningActiveRef.current = false;
            }
          };

          rec.onend = () => {
            if (recognitionRef.current !== rec) return;
            browserTranscriptCollectorRef.current.completeRecognitionCycle();

            if (mountedRef.current && isListeningActiveRef.current) {
              window.setTimeout(() => {
                if (mountedRef.current && isListeningActiveRef.current) {
                  try {
                    rec.start();
                  } catch {
                    // Previously collected final speech remains available.
                  }
                }
              }, 200);
              return;
            }

            const resolveStop = browserStopResolveRef.current;
            if (resolveStop) resolveStop();
          };

          try {
            rec.start();
            recognitionRef.current = rec;
            browserRecognitionStarted = true;
          } catch {
            // MediaRecorder remains the primary source when available.
          }
        }
      } catch (error) {
        console.warn("SpeechRecognition initialization skipped:", error);
      }
    }

    if (!recorderStarted && !browserRecognitionStarted) {
      isListeningActiveRef.current = false;
      if (mountedRef.current) {
        setConnectionState("reconnecting");
        setUiState("stt-error");
      }
      return false;
    }

    return true;
  }

  async function stopBrowserRecognition(): Promise<void> {
    const recognition = recognitionRef.current;
    if (!recognition) {
      browserTranscriptCollectorRef.current.completeRecognitionCycle();
      return;
    }

    isListeningActiveRef.current = false;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        browserStopResolveRef.current = null;
        resolve();
      };

      browserStopResolveRef.current = finish;
      try {
        recognition.stop();
      } catch {
        browserTranscriptCollectorRef.current.completeRecognitionCycle();
        finish();
      }

      // Do not block session completion if a browser fails to dispatch onend.
      window.setTimeout(() => {
        if (settled) return;
        browserTranscriptCollectorRef.current.completeRecognitionCycle();
        finish();
      }, 1500);
    });

    if (recognitionRef.current === recognition) {
      recognitionRef.current = null;
    }
  }

  useEffect(() => {
    startListeningRef.current = startListening;
  });

  async function transcribeRecording(
    recording: Blob,
    options: { updateTranscript?: boolean } = {},
  ): Promise<{ text: string; words: readonly WordTimestamp[] | null } | null> {
    transcriptionAbortRef.current?.abort();

    const controller = new AbortController();
    transcriptionAbortRef.current = controller;

    try {
      const transcript = await speechService.transcribe(recording, {
        languageCode: "vi",
        signal: controller.signal,
      });

      if (!mountedRef.current || controller.signal.aborted) return null;

      const text = transcript.text?.trim() ?? "";
      if (!text) return null;

      if (options.updateTranscript !== false) {
        setLatestTranscript(text);
        setComparisonError(null);
      }

      return {
        text,
        words: transcript.words?.length ? transcript.words : null,
      };
    } catch (error) {
      if (!controller.signal.aborted) {
        if (isServiceError(error)) {
          console.error("[STT SERVICE DIAGNOSTIC]", {
            code: error.code,
            status: error.status,
            request_id: error.request_id,
            retryable: error.retryable,
          });
        } else {
          console.error("Lỗi chuyển ghi âm thành văn bản:", error);
        }
      }
      return null;
    }
  }

  async function stopListeningAndTranscribe(
    options: { finishAlignment?: boolean; preserveAlignment?: boolean } = {},
  ): Promise<string> {
    // Snapshot the page before waiting for asynchronous recorder/provider work.
    const targetPage = page;
    isListeningActiveRef.current = false;
    await stopBrowserRecognition();

    let recording: Blob | null = null;
    if (isUsingRecorderRef.current || speechRecorder.isRecording) {
      try {
        recording = await speechRecorder.stop();
      } catch (error) {
        speechRecorder.cancel();
        console.error("Lỗi khi dừng ghi âm:", error);
      } finally {
        isUsingRecorderRef.current = false;
      }
    }

    let elevenLabsResult: {
      text: string;
      words: readonly WordTimestamp[] | null;
    } | null = null;

    if (recording && recording.size > 200) {
      elevenLabsResult = await transcribeRecording(recording, {
        updateTranscript: options.preserveAlignment !== true,
      });
    }

    const browserText = browserTranscriptCollectorRef.current
      .getTranscript()
      .trim();

    // Use exactly one source for this capture segment: ElevenLabs first,
    // browser final recognition only when provider STT did not return text.
    const resolvedText = resolveTranscriptForSegment(
      elevenLabsResult?.text,
      browserText,
    );
    if (resolvedText && targetPage) {
      recordSpokenText(
        resolvedText,
        targetPage,
        elevenLabsResult?.words ?? null,
      );

      if (!options.preserveAlignment) {
        // Nếu Browser SpeechRecognition không có transcript,
        // sử dụng kết quả ElevenLabs cho realtime alignment.
        if (!browserText && elevenLabsResult?.text) {
          const engine = alignmentEngineRef.current;

          if (engine) {
            const snapshot = engine.addFinalTranscript(elevenLabsResult.text);

            applyRealtimeSnapshot(snapshot);
          }
        }

        // Xác nhận từ cuối cùng đang chờ xử lý SUBSTITUTE.
        const engine = alignmentEngineRef.current;

        if (engine && options.finishAlignment !== false) {
          const snapshot = engine.finish();
          applyRealtimeSnapshot(snapshot);
        }

        setLatestTranscript(resolvedText);
        setComparisonError(null);
      }
    }

    return resolvedText ?? "";
  }

  async function playAssistantAudio(
    play: () => Promise<void>,
    resumeForPractice = false,
    resumeAfterPlayback = true,
  ): Promise<void> {
    const wasListening =
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current ||
      speechRecorder.isRecording ||
      retryRecorderActiveRef.current ||
      countdown !== null;
    assistantAudioResumeRequestedRef.current ||=
      wasListening || resumeForPractice;
    assistantAudioPendingRef.current = true;
    const generation = ++assistantAudioGenerationRef.current;
    setCountdown(null);

    try {
      if (retryModeRef.current) {
        // Retry mode has its own capture lifecycle. Cancel that capture without
        // transcribing it, then wait for browser recognition to fully stop
        // before the assistant speaks.
        retryListeningWantedRef.current = false;
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = false;
        clearRetryCaptureTimeout();
        retryRecorderActiveRef.current = false;
        isUsingRecorderRef.current = false;
        // A permission preflight can leave getUserMedia's stream open even
        // before MediaRecorder starts. Release its tracks so the microphone is
        // genuinely off for the whole sample, then reacquire after playback.
        speechRecorder.cancel();
        await stopBrowserRecognition();
        if (mountedRef.current) setIsMicRecording(false);
      } else if (
        isMicRecording ||
        isListeningActiveRef.current ||
        isUsingRecorderRef.current ||
        speechRecorder.isRecording
      ) {
        try {
          await stopListeningAndTranscribe({
            finishAlignment: false,
            preserveAlignment: true,
          });
        } catch {
          speechRecorder.cancel();
        } finally {
          if (mountedRef.current) setIsMicRecording(false);
        }
      } else {
        // A recognition instance can outlive a stale UI/ref state. Always
        // stop it and release any permission-preflight stream before playback,
        // even when the recorder looks idle.
        speechRecorder.cancel();
        isUsingRecorderRef.current = false;
        await stopBrowserRecognition();
      }

      if (
        !mountedRef.current ||
        generation !== assistantAudioGenerationRef.current
      ) {
        return;
      }

      assistantAudioPlayingRef.current = true;
      await play();
    } finally {
      if (generation === assistantAudioGenerationRef.current) {
        assistantAudioPlayingRef.current = false;
        assistantAudioPendingRef.current = false;

        const shouldResume = assistantAudioResumeRequestedRef.current;
        assistantAudioResumeRequestedRef.current = false;
        if (
          resumeAfterPlayback &&
          shouldResume &&
          mountedRef.current &&
          uiState === "reading" &&
          !retryModeRef.current
        ) {
          const resumed = await startListening();
          if (mountedRef.current) setIsMicRecording(resumed);
        }

        if (
          tutorResumeMicAfterPlaybackRef.current &&
          mountedRef.current &&
          !retryModeRef.current
        ) {
          tutorResumeMicAfterPlaybackRef.current = false;
          const resumed = await startListening();
          if (mountedRef.current) setIsMicRecording(resumed);
        }
      }
    }
  }

  function preventAssistantAudioResume(): void {
    assistantAudioGenerationRef.current += 1;
    assistantAudioResumeRequestedRef.current = false;
    assistantAudioPendingRef.current = false;
    assistantAudioPlayingRef.current = false;
  }

  function handleVoicePreview(sample: string): void {
    void speechPlayer
      .playWithWordTimings(sample.split(" "), {}, () =>
        speechPlayer.play(sample),
      )
      .catch(() => undefined);
  }

  async function handleReadSample() {
    if (retryModeRef.current) {
      const candidate = retryCandidatesRef.current[retryPositionRef.current];
      if (!candidate) return;
      if (speechPlayer.isPlaying) {
        speechPlayer.stop();
        setIsReadingWord(false);
        return;
      }
      cancelRetryRecognition();
      void playRetryInstructionAndListen(candidate, speechRecorder.prepare());
      return;
    }
    if (isBusy && !speechPlayer.isPlaying) return;
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      setIsReadingWord(false);
      setIsBusy(false);
      return;
    }
    if (!page) return;

    const rawText = page.text || page.words.map((w) => w.text).join(" ") || "";
    const fullText = rawText.replace(/\s+/g, " ").trim();
    if (!fullText) return;

    const words = page.words;
    if (!words.length) return;

    setIsBusy(true);
    setIsReadingWord(false);
    const readingCursorBeforeSample =
      alignmentEngineRef.current?.getSnapshot().currentWordId ??
      currentWordId ??
      words[0].word_id;
    // Calculate word duration weights for natural Vietnamese speech rhythm
    const weights = words.map((w) => {
      let weight = Math.max(2, w.text.length);
      if (/[.,;:!?…"”]/.test(w.text)) {
        weight += 4;
      }
      return weight;
    });
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const cumulativeWeights: number[] = [];
    let running = 0;
    for (const w of weights) {
      running += w;
      cumulativeWeights.push(running);
    }

    // A sample only moves the visual cursor; it is not evidence of the child's reading.
    setCurrentWordId(words[0].word_id);

    try {
      await playAssistantAudio(
        () =>
          speechPlayer.playWithWordTimings(
            words.map((word) => word.text),
            {
              onPlay: () => {
                if (!mountedRef.current) return;
                setCurrentWordId(words[0].word_id);
              },
              onWordChange: (index) => {
                if (!mountedRef.current) return;
                const targetWord = words[index];
                if (targetWord) setCurrentWordId(targetWord.word_id);
              },
              onEnded: () => {
                if (!mountedRef.current) return;
                setCurrentWordId(
                  alignmentEngineRef.current?.getSnapshot().currentWordId ??
                    readingCursorBeforeSample,
                );
              },
            },
            // No word timings available: keep the previous estimated highlight.
            () =>
              speechPlayer.play(fullText, {
                onPlay: () => {
                  if (!mountedRef.current) return;
                  setCurrentWordId(words[0].word_id);
                },
                onTimeUpdate: (currentTime, duration) => {
                  if (!mountedRef.current || !duration || duration <= 0) return;
                  const progress = Math.min(
                    0.999,
                    Math.max(0, currentTime / duration),
                  );
                  const targetWeight = progress * totalWeight;
                  let idx = cumulativeWeights.findIndex(
                    (cw) => cw >= targetWeight,
                  );
                  if (idx < 0) idx = 0;
                  if (idx >= words.length) idx = words.length - 1;

                  const targetWord = words[idx];
                  if (targetWord) {
                    setCurrentWordId(targetWord.word_id);
                  }
                },
                onEnded: () => {
                  if (!mountedRef.current) return;
                  setCurrentWordId(
                    alignmentEngineRef.current?.getSnapshot().currentWordId ??
                      readingCursorBeforeSample,
                  );
                },
              }),
          ),
        true,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (mountedRef.current) {
        setUiState("tts-error");
      }
    } finally {
      if (mountedRef.current) {
        setCurrentWordId(
          alignmentEngineRef.current?.getSnapshot().currentWordId ??
            readingCursorBeforeSample,
        );
        setIsBusy(false);
      }
    }
  }

  async function handleToggleListening() {
    if (retryModeRef.current) {
      const candidate = retryCandidatesRef.current[retryPositionRef.current];
      if (!candidate || isBusy || retryProcessingRef.current) return;

      if (isMicRecording) {
        await stopRetryListeningAndTranscribe(candidate);
      } else {
        retryCurrentWord();
      }
      return;
    }
    if (isBusy && !speechPlayer.isPlaying) return;
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      setIsReadingWord(false);
      setIsBusy(false);
    }
    if (isMicRecording) {
      setIsBusy(true);
      try {
        await stopListeningAndTranscribe();
        if (mountedRef.current) setIsMicRecording(false);
        const snapshot = alignmentEngineRef.current?.getSnapshot();
        if (snapshot) {
          await autoCompletePageAfterFinalWordRef.current(snapshot);
        }
      } finally {
        if (mountedRef.current) {
          setIsMicRecording(false);
          setIsBusy(false);
        }
      }
    } else {
      setIsBusy(true);
      try {
        const ok = await startListening();
        if (mountedRef.current && ok) {
          setIsMicRecording(true);
        }
      } finally {
        if (mountedRef.current) {
          setIsBusy(false);
        }
      }
    }
  }

  async function startReading() {
    if (isBusy) return;

    setIsBusy(true);

    try {
      const nextState = await services.readingSocketAdapter.sendControl(
        sessionId,
        "start",
      );

      if (!mountedRef.current) return;

      setCanonicalState(nextState);
      setConnectionState("connected");
      setUiState("reading");
      setIsMicRecording(false);

      // Xóa dữ liệu transcript của buổi đọc mới.
      transcriptsListRef.current = [];
      pageTranscriptsRef.current.clear();
      setHasPageTranscripts(false);
      browserTranscriptCollectorRef.current.reset();
      retryWordsByIdRef.current.clear();
      retryCandidatesRef.current = [];
      retryModeRef.current = false;
      retryListeningWantedRef.current = false;
      retryProcessingRef.current = false;
      setRetryMode(false);
      setRetryCandidates([]);
      setRetryConfirmedWordIds(new Set());
      setRetryWordPosition(0);
      setRetryFeedback("waiting");

      // Reset toàn bộ trạng thái nhận diện.
      correctWordIdsRef.current.clear();
      mispronouncedWordIdsRef.current.clear();
      skippedWordIdsRef.current.clear();
      repeatedWordIdsRef.current.clear();
      hesitationWordIdsRef.current.clear();

      failedWordsSetRef.current.clear();
      spokenWordsSetRef.current.clear();

      setCorrectWordIds(new Set());
      setMispronouncedWordIds(new Set());
      setSkippedWordIds(new Set());
      setRepeatedWordIds(new Set());
      setHesitationWordIds(new Set());
      setSpokenWords(new Set());

      // Reset alignment engine cho trang hiện tại.
      lastPreviewWordIndexRef.current = -1;
      const initialSnapshot = alignmentEngineRef.current?.reset();

      if (initialSnapshot) {
        setCurrentWordId(initialSnapshot.currentWordId);
      } else if (page?.words.length) {
        setCurrentWordId(page.words[0].word_id);
      }

      setLatestTranscript("");
      setComparisonResult(null);
      setComparisonError(null);

      setCountdown(3);
    } catch (error) {
      console.error("Không thể bắt đầu buổi đọc:", error);

      if (mountedRef.current) {
        setConnectionState("reconnecting");
      }
    } finally {
      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }

  async function resumeReading() {
    if (isBusy) return;
    setIsBusy(true);
    const nextState = await services.readingSocketAdapter.sendControl(
      sessionId,
      "resume",
    );
    if (!mountedRef.current) return;
    setCanonicalState(nextState);
    setConnectionState("connected");
    setUiState("reading");
    setIsMicRecording(false);
    setIsBusy(false);
  }

  async function pauseReading() {
    if (isBusy) return;
    setIsBusy(true);
    if (isMicRecording) {
      try {
        await stopListeningAndTranscribe();
      } catch {
        speechRecorder.cancel();
      }
      if (mountedRef.current) {
        setIsMicRecording(false);
      }
    }
    if (!mountedRef.current) return;
    setCanonicalState("PAUSED");
    setUiState("paused");
    setIsBusy(false);
  }

  async function retryMicrophonePermission() {
    if (isBusy) return;
    setIsBusy(true);
    await services.devicePermissionService.retry("microphone");
    if (!mountedRef.current) return;
    if (!(await startListening())) {
      if (mountedRef.current) setIsBusy(false);
      return;
    }
    setConnectionState("connected");
    setUiState("reading");
    setCanonicalState("LISTENING");
    setIsBusy(false);
  }

  function retryRetryMicrophonePermission(): void {
    const candidate = retryCandidatesRef.current[retryPositionRef.current];
    if (!candidate || isBusy) return;
    const permissionRequest = speechRecorder.prepare();
    void permissionRequest.catch(() => undefined);
    void playRetryInstructionAndListen(candidate, permissionRequest);
  }

  function retryCurrentWord(): void {
    const candidate = retryCandidatesRef.current[retryPositionRef.current];
    if (!candidate || isBusy || retryProcessingRef.current) return;
    cancelRetryRecognition();
    void playRetryInstructionAndListen(candidate, speechRecorder.prepare());
  }

  async function navigateWithinRange(targetIndex: number) {
    if (
      !pageProgress ||
      isBusy ||
      targetIndex < 0 ||
      targetIndex >= pageProgress.pages.length
    ) {
      return;
    }
    const target = pageProgress.pages[targetIndex];
    if (!target || target.page_id === page?.page_id) return;

    setIsBusy(true);
    setPageNavigationError(null);
    preventAssistantAudioResume();
    speechPlayer.stop();
    setIsReadingWord(false);
    try {
      if (
        isMicRecording ||
        isListeningActiveRef.current ||
        isUsingRecorderRef.current
      ) {
        await stopListeningAndTranscribe();
        if (mountedRef.current) setIsMicRecording(false);
      }

      // Finalize this page before its live alignment state is reset. Keep only
      // pages where the child actually produced final speech; opening a page
      // without reading it must not turn every word into an omission.
      const currentEngine = alignmentEngineRef.current;
      if (currentEngine) {
        const currentSnapshot = currentEngine.getSnapshot();
        if (
          currentSnapshot.spokenWords.length > 0 ||
          currentSnapshot.statusByWordId.size > 0
        ) {
          applyRealtimeSnapshot(currentEngine.finish());
        }
      }

      const nextProgress = await services.readingService.navigateToPage(
        sessionId,
        target.page_id,
      );
      const nextPage = await services.readingService.getCurrentPage(sessionId);
      if (!mountedRef.current) return;
      setPageProgress(nextProgress);
      resetWordTracking();
      setPage(nextPage);
      setCurrentWordId(nextPage.words[0]?.word_id ?? null);
      setCountdown(null);
      setUiState("reading");
    } catch {
      if (mountedRef.current) {
        setPageNavigationError(
          "Chưa tải được trang này. Tiến trình buổi đọc vẫn được giữ; vui lòng thử lại.",
        );
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function confirmCurrentPageCompleted() {
    if (!pageProgress?.persisted || !page || isBusy) return;
    setIsBusy(true);
    setPageNavigationError(null);
    setCountdown(null);
    try {
      if (
        isMicRecording ||
        isListeningActiveRef.current ||
        isUsingRecorderRef.current ||
        speechRecorder.isRecording
      ) {
        await stopListeningAndTranscribe({ finishAlignment: false });
      } else {
        isListeningActiveRef.current = false;
        isUsingRecorderRef.current = false;
        speechRecorder.cancel();
        await stopBrowserRecognition();
      }
      if (mountedRef.current) setIsMicRecording(false);

      const engine = alignmentEngineRef.current;
      if (engine) applyRealtimeSnapshot(engine.finish());

      const progress = await services.readingService.completeCurrentPage(
        sessionId,
        page.page_id,
      );
      if (!mountedRef.current) return;
      setPageProgress(progress);
      if (progress.current_index + 1 < progress.total_pages) {
        setUiState("page-turn");
      }
    } catch {
      if (mountedRef.current) {
        setPageNavigationError(
          "Chưa lưu được xác nhận hoàn thành trang. Vui lòng thử lại.",
        );
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function autoCompletePageAfterFinalWord(
    snapshot: RealtimeAlignmentSnapshot,
  ): Promise<void> {
    const completedPage = page;
    const progress = pageProgress;
    const finalWord = completedPage?.words.at(-1);
    if (
      !completedPage ||
      !progress?.persisted ||
      progress.current_page_id !== completedPage.page_id ||
      !finalWord ||
      snapshot.currentWordId !== null ||
      snapshot.statusByWordId.get(finalWord.word_id)?.status !== "MATCH" ||
      retryModeRef.current ||
      assistantAudioPendingRef.current ||
      assistantAudioPlayingRef.current ||
      tutorOpen ||
      uiState !== "reading" ||
      isBusy ||
      progress.pages[progress.current_index]?.status === "COMPLETED" ||
      pageCompletionStartedRef.current === completedPage.page_id
    ) {
      return;
    }

    const completedPageId = completedPage.page_id;
    pageCompletionStartedRef.current = completedPageId;
    setIsBusy(true);
    setCountdown(null);
    setPageNavigationError(null);

    try {
      // Stop capture and save the child's final utterance without replaying
      // that already-aligned transcript through scoring a second time.
      await stopListeningAndTranscribe({
        finishAlignment: false,
        preserveAlignment: true,
      });
      if (!mountedRef.current || page?.page_id !== completedPageId) return;

      const engine = alignmentEngineRef.current;
      if (engine) applyRealtimeSnapshot(engine.finish());

      const nextProgress = await services.readingService.completeCurrentPage(
        sessionId,
        completedPageId,
      );
      if (!mountedRef.current) return;

      setIsMicRecording(false);
      setPageProgress(nextProgress);
      if (nextProgress.current_index + 1 < nextProgress.total_pages) {
        setUiState("page-turn");
      }
    } catch {
      if (mountedRef.current) {
        setIsMicRecording(false);
        setPageNavigationError(
          "Chưa tự chuyển được sau trang này. Bé có thể bấm ‘Đánh dấu trang đã đọc xong’ để thử lại.",
        );
      }
    } finally {
      if (pageCompletionStartedRef.current === completedPageId) {
        pageCompletionStartedRef.current = null;
      }
      if (mountedRef.current) setIsBusy(false);
    }
  }

  useEffect(() => {
    autoCompletePageAfterFinalWordRef.current = autoCompletePageAfterFinalWord;
  });

  async function retryPageMatch() {
    if (isBusy) return;
    setIsBusy(true);
    const matchedPage =
      await services.pageMatchService.retryCurrentPage(sessionId);
    if (!mountedRef.current) return;
    setPage(matchedPage);
    setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
    setPageProgress(await services.readingService.getPageProgress(sessionId));
    setPageNavigationError(null);
    setCanonicalState("LISTENING");
    setConnectionState("connected");
    setUiState("reading");
    setIsBusy(false);
  }

  async function reconnect(mode: ReadingReconnectDemoMode) {
    if (isBusy) return;
    const resumeMicrophone = uiState === "stt-error";
    setIsBusy(true);
    setConnectionState("reconnecting");
    const nextConnection = await services.readingSocketAdapter.reconnect(
      sessionId,
      mode,
    );
    if (!mountedRef.current) return;
    setConnectionState(nextConnection);
    if (nextConnection === "recovered") {
      if (resumeMicrophone && !(await startListening())) {
        if (mountedRef.current) setIsBusy(false);
        return;
      }
      setCanonicalState("LISTENING");
      setUiState("reading");
    }
    setIsBusy(false);
  }

  async function requestTutor() {
    if (!page || !currentWordId || isBusy) return;
    const word = page.words.find(
      (item) => item.word_id === currentWordId,
    )?.text;
    if (!word) return;
    tutorPlaybackGenerationRef.current += 1;
    tutorResumeListeningRef.current =
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current ||
      speechRecorder.isRecording ||
      countdown !== null;
    setTutorOpen(true);
    setIsBusy(true);
    const playbackGeneration = tutorPlaybackGenerationRef.current;
    try {
      await playAssistantAudio(
        async () => {
          let action: TutorAction | null = null;
          try {
            action = await services.tutorService.requestReadExample(
              sessionId,
              currentWordId,
            );
          } catch {
            // Audio assistance remains available while the separate tutor-event API
            // is being connected by the reading-session owner.
          }
          if (
            !mountedRef.current ||
            playbackGeneration !== tutorPlaybackGenerationRef.current
          ) {
            return;
          }
          await speechPlayer.play(action?.tts_text ?? word);
          if (
            mountedRef.current &&
            playbackGeneration === tutorPlaybackGenerationRef.current
          ) {
            setTutorAction(action);
          }
        },
        false,
        false,
      );
    } catch (error) {
      if (
        mountedRef.current &&
        playbackGeneration === tutorPlaybackGenerationRef.current &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        setUiState("tts-error");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function retryTutor() {
    if (!page || !currentWordId || isBusy) return;
    const word = page.words.find(
      (item) => item.word_id === currentWordId,
    )?.text;
    if (!word) return;
    tutorResumeListeningRef.current ||=
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current ||
      speechRecorder.isRecording ||
      countdown !== null;
    setIsBusy(true);
    const playbackGeneration = ++tutorPlaybackGenerationRef.current;
    try {
      let nextAction = tutorAction;
      await playAssistantAudio(
        async () => {
          try {
            nextAction = nextAction
              ? await services.tutorService.retryReadExample(nextAction)
              : await services.tutorService.requestReadExample(
                  sessionId,
                  currentWordId,
                );
          } catch {
            // A retry must still replay the word even if tutor-event persistence is unavailable.
          }
          if (
            !mountedRef.current ||
            playbackGeneration !== tutorPlaybackGenerationRef.current
          ) {
            return;
          }
          await speechPlayer.play(nextAction?.tts_text ?? word);
        },
        false,
        false,
      );
      if (
        mountedRef.current &&
        playbackGeneration === tutorPlaybackGenerationRef.current
      ) {
        setTutorAction(nextAction);
        setUiState("reading");
      }
    } catch (error) {
      if (
        mountedRef.current &&
        playbackGeneration === tutorPlaybackGenerationRef.current &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        setUiState("tts-error");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  function closeTutor(): void {
    const shouldResumeListening = tutorResumeListeningRef.current;
    tutorResumeListeningRef.current = false;
    tutorPlaybackGenerationRef.current += 1;
    speechPlayer.stop();
    setTutorOpen(false);
    setUiState("reading");

    if (shouldResumeListening) {
      if (
        assistantAudioPendingRef.current ||
        assistantAudioPlayingRef.current
      ) {
        tutorResumeMicAfterPlaybackRef.current = true;
      } else {
        void startListening().then((resumed) => {
          if (mountedRef.current) setIsMicRecording(resumed);
        });
      }
    }
  }
  function buildRetryContextPhrase(
    words: readonly ReadingPageWordDTO[],
    targetIndex: number,
  ): string {
    const target = words[targetIndex];
    if (!target) return "";

    const targetLine = target.line_index;

    let start = targetIndex;
    let end = targetIndex;

    // Lấy tối đa 2 từ trước và 2 từ sau.
    for (let i = targetIndex - 1; i >= Math.max(0, targetIndex - 2); i--) {
      const word = words[i];

      if (
        targetLine !== undefined &&
        word.line_index !== undefined &&
        word.line_index !== targetLine
      ) {
        break;
      }

      // Không lấy qua ranh giới câu.
      if (/[.!?…]["”']?$/.test(words[i].text)) break;

      start = i;
    }

    for (
      let i = targetIndex + 1;
      i <= Math.min(words.length - 1, targetIndex + 2);
      i++
    ) {
      const word = words[i];

      if (
        targetLine !== undefined &&
        word.line_index !== undefined &&
        word.line_index !== targetLine
      ) {
        break;
      }

      end = i;

      // Không lấy tiếp sang câu kế tiếp.
      if (/[.!?…]["”']?$/.test(word.text)) break;
    }

    return words
      .slice(start, end + 1)
      .map((word) => word.text)
      .join(" ");
  }
  function buildRetryCandidates(): RetryWordCandidate[] {
    return sortRetryWordRecords(retryWordsByIdRef.current.values()).map(
      (item) => {
        const pageWords = pageWordsByRevisionRef.current.get(
          `${item.page_id}:${item.page_revision_id}`,
        );

        const targetIndex = pageWords?.findIndex(
          (word) => word.word_id === item.word_id,
        );

        const contextPhrase =
          pageWords && targetIndex !== undefined && targetIndex >= 0
            ? buildRetryContextPhrase(pageWords, targetIndex)
            : item.text;

        return {
          wordId: item.word_id,
          text: item.text,
          contextPhrase,
          pageId: item.page_id,
          pageRevisionId: item.page_revision_id,
          pageNumber: item.page_number,
          wordIndex: item.word_index,
          originalStatus: item.original_status,
        };
      },
    );
  }
  function cancelRetryRecognition(preserveProcessing = false): void {
    // Vô hiệu hóa callback và request thuộc lượt retry cũ.
    retryAttemptIdRef.current += 1;

    retryAbortControllerRef.current?.abort();
    retryAbortControllerRef.current = null;

    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;

    if (!preserveProcessing) {
      retryProcessingRef.current = false;
    }

    clearRetryCaptureTimeout();

    const recognition = recognitionRef.current;
    recognitionRef.current = null;

    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Recognition có thể đã kết thúc.
      }
    }

    if (retryRecorderActiveRef.current) {
      retryRecorderActiveRef.current = false;
      speechRecorder.cancel({ retainStream: true });
    }

    if (mountedRef.current) {
      setIsMicRecording(false);
    }
  }

  // Dừng nhận diện và hủy bản ghi đang hoạt động.
  // Không dùng hàm này để xử lý STT khi người dùng chủ động tắt mic.
  function stopRetryRecognition(): void {
    cancelRetryRecognition();
  }

  function clearRetryCaptureTimeout(): void {
    if (retryCaptureTimeoutRef.current !== null) {
      window.clearTimeout(retryCaptureTimeoutRef.current);
      retryCaptureTimeoutRef.current = null;
    }
  }

  function scheduleRetryCaptureStop(
    candidate: RetryWordCandidate,
    useAudioActivityForSpeechOnset = true,
  ): void {
    if (
      !retryRecorderActiveRef.current ||
      retryCaptureTimeoutRef.current !== null
    ) {
      return;
    }

    retryCaptureStartedAtRef.current = getRetryCaptureTimeMs();
    retrySpeechObservedRef.current = false;
    retrySilenceStartedAtRef.current = null;

    const checkCapture = () => {
      retryCaptureTimeoutRef.current = null;
      if (
        !mountedRef.current ||
        !retryModeRef.current ||
        !retryListeningWantedRef.current ||
        !retryRecorderActiveRef.current
      ) {
        return;
      }

      const now = getRetryCaptureTimeMs();
      const elapsed = now - retryCaptureStartedAtRef.current;
      if (speechRecorder.getIsSpeaking()) {
        // In the browser-recognition path, wait for a recognition result before
        // treating volume as speech onset. Once speech is confirmed, however,
        // keep the silence timer aligned with the actual microphone signal.
        if (useAudioActivityForSpeechOnset || retrySpeechObservedRef.current) {
          retrySpeechObservedRef.current = true;
          retrySilenceStartedAtRef.current = null;
        }
      } else if (
        retrySpeechObservedRef.current &&
        retrySilenceStartedAtRef.current === null
      ) {
        retrySilenceStartedAtRef.current = now;
      }

      const silenceElapsed =
        retrySilenceStartedAtRef.current === null
          ? 0
          : now - retrySilenceStartedAtRef.current;
      if (
        elapsed >= RETRY_CAPTURE_MAX_MS ||
        (elapsed >= RETRY_CAPTURE_MIN_MS &&
          retrySpeechObservedRef.current &&
          silenceElapsed >= RETRY_CAPTURE_SILENCE_MS)
      ) {
        void stopRetryListeningAndTranscribe(candidate);
        return;
      }

      retryCaptureTimeoutRef.current = window.setTimeout(
        checkCapture,
        RETRY_CAPTURE_POLL_MS,
      );
    };

    retryCaptureTimeoutRef.current = window.setTimeout(
      checkCapture,
      RETRY_CAPTURE_POLL_MS,
    );
  }

  function confirmRetryWord(
    candidate: RetryWordCandidate,
    transcript: string,
    fromTranscription = false,
  ): Promise<boolean> {
    // Chặn callback trùng, nhưng cho phép luồng STT đang xử lý
    // tự xác nhận kết quả của chính nó.
    if (retryProcessingRef.current && !fromTranscription) {
      return Promise.resolve(false);
    }

    retryProcessingRef.current = true;
    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;

    // Giữ khóa retry cho đến khi chuyển sang từ tiếp theo.
    cancelRetryRecognition(true);
    const pending: PendingRetryEvent = {
      candidate,
      status: "CONFIRMED",
      transcript,
      attempt: Math.max(1, retryCaptureAttemptRef.current),
    };
    return persistRetryOutcome(pending);
  }

  function retryUnclearCapture(
    candidate: RetryWordCandidate,
    transcript: string,
  ): void {
    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;
    retryProcessingRef.current = false;

    if (retryCaptureAttemptRef.current < 2) {
      setRetryFeedback("not-recognized");
      setLatestTranscript(
        transcript
          ? `ViRead chưa nghe rõ từ "${candidate.text}". Mình thử thu âm lại một lần nhé.`
          : `Chưa nghe thấy tiếng bé đọc từ "${candidate.text}". Mình thử lại một lần nhé.`,
      );
      window.setTimeout(() => {
        if (
          mountedRef.current &&
          retryModeRef.current &&
          retryCandidatesRef.current[retryPositionRef.current]?.wordId ===
            candidate.wordId
        ) {
          void playRetryInstructionAndListen(candidate);
        }
      }, 500);
      return;
    }

    setRetryFeedback("not-recognized");
    setLatestTranscript(
      `ViRead chưa nhận diện được từ "${candidate.text}". Bé có thể nghe lại rồi thử thêm nhé. Từ này chưa bị đánh dấu sai.`,
    );
  }

  async function persistRetryOutcome(
    pending: PendingRetryEvent,
  ): Promise<boolean> {
    setRetryFeedback("processing");
    setLatestTranscript("Đang lưu kết quả đọc lại...");
    setIsBusy(true);

    try {
      await services.readingService.createRetryEvent({
        sessionId,
        pageId: pending.candidate.pageId,
        pageRevisionId: pending.candidate.pageRevisionId,
        wordId: pending.candidate.wordId,
        status: pending.status,
        startMs: 0,
        endMs: null,
        metadata: {
          retry_attempt: pending.attempt,
          original_status: pending.candidate.originalStatus,
          target_word: pending.candidate.text.slice(0, 100),
          ...(pending.transcript
            ? { recognized_text: pending.transcript.slice(0, 200) }
            : {}),
        },
      });
      pendingRetryEventRef.current = null;
      if (pending.status === "CONFIRMED") {
        finishConfirmedRetryWord(pending.candidate, pending.transcript);
      } else {
        retryProcessingRef.current = false;
        setRetryFeedback("incorrect");
        setLatestTranscript(
          `Bé vừa đọc: "${pending.transcript}". Mình thử lại từ "${pending.candidate.text}" nhé.`,
        );
      }
      return true;
    } catch (error) {
      console.error("[RETRY EVENT PERSISTENCE]", error);
      pendingRetryEventRef.current = pending;
      retryProcessingRef.current = false;
      setRetryFeedback("save-error");
      setLatestTranscript(
        "Chưa lưu được kết quả. Bé thử lưu lại nhé; phần đọc vừa rồi vẫn được giữ.",
      );
      return false;
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  function finishConfirmedRetryWord(
    candidate: RetryWordCandidate,
    transcript: string,
  ): void {
    retryProcessingRef.current = true;
    setLatestTranscript(transcript);
    setRetryFeedback("correct");

    setRetryConfirmedWordIds((previous) => {
      const next = new Set(previous);
      next.add(candidate.wordId);
      return next;
    });

    retryWordsByIdRef.current.delete(candidate.wordId);

    const nextCorrectIds = new Set(correctWordIdsRef.current);
    nextCorrectIds.add(candidate.wordId);
    correctWordIdsRef.current = nextCorrectIds;

    const nextMispronouncedIds = new Set(mispronouncedWordIdsRef.current);
    nextMispronouncedIds.delete(candidate.wordId);
    mispronouncedWordIdsRef.current = nextMispronouncedIds;
    failedWordsSetRef.current = new Set(
      [...nextMispronouncedIds]
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word)),
    );

    const nextSkippedIds = new Set(skippedWordIdsRef.current);
    nextSkippedIds.delete(candidate.wordId);
    skippedWordIdsRef.current = nextSkippedIds;

    setCorrectWordIds(nextCorrectIds);
    setMispronouncedWordIds(nextMispronouncedIds);
    setSkippedWordIds(nextSkippedIds);

    window.setTimeout(() => {
      if (!mountedRef.current) return;

      const nextPosition = retryPositionRef.current + 1;

      if (nextPosition >= retryCandidatesRef.current.length) {
        retryModeRef.current = false;
        retryListeningWantedRef.current = false;
        setRetryMode(false);
        cancelRetryRecognition();
        void completeReadingSession();
        return;
      }

      retryProcessingRef.current = false;
      setRetryWordPosition(nextPosition);
      void beginRetryWord(nextPosition);
    }, 450);
  }

  async function retryPendingRetryEvent(): Promise<void> {
    const pending = pendingRetryEventRef.current;
    if (!pending || retryProcessingRef.current) return;
    retryProcessingRef.current = true;
    await persistRetryOutcome(pending);
  }

  async function stopRetryListeningAndTranscribe(
    candidate: RetryWordCandidate,
    browserTranscript?: string,
  ): Promise<void> {
    if (!retryModeRef.current || retryProcessingRef.current) {
      return;
    }

    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;

    clearRetryCaptureTimeout();

    const recognition = recognitionRef.current;
    recognitionRef.current = null;

    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Browser recognition có thể đã tự kết thúc.
      }
    }

    if (mountedRef.current) {
      setIsMicRecording(false);
    }

    if (!retryRecorderActiveRef.current) {
      if (
        browserTranscript &&
        classifyRetryTranscript(candidate.text, browserTranscript) === "CORRECT"
      ) {
        retryProcessingRef.current = true;
        await confirmRetryWord(candidate, browserTranscript, true);
      } else {
        retryUnclearCapture(candidate, browserTranscript ?? "");
      }
      return;
    }

    // Khóa để không xử lý cùng một bản ghi nhiều lần.
    retryProcessingRef.current = true;
    retryRecorderActiveRef.current = false;

    const attemptId = ++retryAttemptIdRef.current;

    retryAbortControllerRef.current?.abort();

    const controller = new AbortController();
    retryAbortControllerRef.current = controller;

    let advancePending = false;

    setIsBusy(true);

    try {
      const recording = await speechRecorder.stop();

      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        attemptId !== retryAttemptIdRef.current ||
        !retryModeRef.current
      ) {
        return;
      }

      if (!recording || recording.size <= 200) {
        if (
          browserTranscript &&
          classifyRetryTranscript(candidate.text, browserTranscript) ===
            "CORRECT"
        ) {
          advancePending = await confirmRetryWord(
            candidate,
            browserTranscript,
            true,
          );
        } else {
          retryUnclearCapture(candidate, browserTranscript ?? "");
        }
        return;
      }

      // Lần 1: STT bình thường, không dùng keyterms.
      let transcription = await speechService.transcribe(recording, {
        languageCode: "vi",
        signal: controller.signal,
      });

      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        attemptId !== retryAttemptIdRef.current ||
        !retryModeRef.current
      ) {
        return;
      }

      let transcript = transcription.text?.trim() ?? "";

      let status = classifyRetryTranscript(candidate.text, transcript);

      // Lần 2: chỉ chạy khi kết quả lần đầu không rõ.
      // Quan trọng: sử dụng lại chính recording cũ.
      if (status === "UNCERTAIN" || status === "NOT_RECOGNIZED") {
        console.info("[RETRY STT] Running same-audio keyterm fallback", {
          expectedWord: candidate.text,
          firstTranscript: transcript,
          firstStatus: status,
        });

        try {
          transcription = await speechService.transcribe(recording, {
            languageCode: "vi",
            keyterms: [candidate.text],
            signal: controller.signal,
          });

          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            attemptId !== retryAttemptIdRef.current ||
            !retryModeRef.current
          ) {
            return;
          }

          transcript = transcription.text?.trim() ?? "";
          status = classifyRetryTranscript(candidate.text, transcript);
        } catch (fallbackError) {
          if (controller.signal.aborted) return;
          // Keep the first real transcript if the keyterm-biased request is
          // unavailable. It remains uncertain and is never forced to correct.
          console.warn("[RETRY STT KEYTERM FALLBACK]", fallbackError);
        }
      }

      setLatestTranscript(transcript);

      console.info("[RETRY STT RESULT]", {
        status,
        attemptId,
        languageProbability: transcription.language_probability,
        wordConfidence: (transcription.words ?? [])
          .map((word) => word.logprob)
          .filter(
            (value): value is number => value !== null && value !== undefined,
          ),
      });

      if (status === "CORRECT") {
        advancePending = await confirmRetryWord(candidate, transcript, true);
        return;
      }

      if (
        browserTranscript &&
        classifyRetryTranscript(candidate.text, browserTranscript) === "CORRECT"
      ) {
        // The live recognizer and the recorded-audio recognizer disagree.
        // Keep the word unscored and let the child try again instead of
        // accepting a result that the saved recording did not confirm.
        retryUnclearCapture(candidate, transcript);
        return;
      }

      if (status === "INCORRECT") {
        await persistRetryOutcome({
          candidate,
          status: "FAILED",
          transcript,
          attempt: Math.max(1, retryCaptureAttemptRef.current),
        });
      } else {
        retryUnclearCapture(candidate, transcript);
      }
    } catch (error) {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        attemptId === retryAttemptIdRef.current
      ) {
        if (isServiceError(error)) {
          console.error("[RETRY STT SERVICE DIAGNOSTIC]", {
            code: error.code,
            status: error.status,
            request_id: error.request_id,
            retryable: error.retryable,
          });
        } else {
          console.error("Lỗi nhận diện từ retry:", error);
        }

        setRetryFeedback("speech-unavailable");

        setLatestTranscript(
          "Chưa kết nối được dịch vụ nhận diện. Bé thử lại sau nhé; hệ thống chưa đánh dấu từ này sai.",
        );
      }
    } finally {
      if (attemptId === retryAttemptIdRef.current) {
        retryAbortControllerRef.current = null;

        // Khi thành công, confirmRetryWord giữ khóa
        // trong lúc chờ chuyển sang từ tiếp theo.
        if (!advancePending) {
          retryProcessingRef.current = false;
        }
      }

      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }

  async function startRetryRecognition(
    candidate: RetryWordCandidate,
  ): Promise<boolean> {
    if (
      typeof window === "undefined" ||
      assistantAudioPendingRef.current ||
      assistantAudioPlayingRef.current ||
      !retryModeRef.current ||
      retryProcessingRef.current
    ) {
      return false;
    }

    // Nếu đây là lần restart do browser tự kết thúc,
    // không tạo bản ghi mới.
    const continuingCapture =
      retryRecorderActiveRef.current && retryListeningWantedRef.current;

    const attemptId = ++retryAttemptIdRef.current;

    retryAbortControllerRef.current?.abort();
    retryAbortControllerRef.current = null;

    retryListeningWantedRef.current = true;
    retryShouldRestartRef.current = true;
    retryProcessingRef.current = false;
    isListeningActiveRef.current = true;

    if (!continuingCapture) {
      retryCaptureAttemptRef.current += 1;
      setRetryFeedback("listening");
      setLatestTranscript("");
    }

    // Bắt đầu ghi âm dự phòng nếu chưa có bản ghi đang chạy.
    if (!retryRecorderActiveRef.current) {
      try {
        await speechRecorder.start({ retainStream: true });
        retryRecorderActiveRef.current = true;
      } catch (error) {
        console.warn("[RETRY RECORDER ERROR]", error);

        retryRecorderActiveRef.current = false;
      }
    }

    // Kiểm tra lại sau thao tác bất đồng bộ xin microphone.
    if (
      !mountedRef.current ||
      assistantAudioPendingRef.current ||
      assistantAudioPlayingRef.current ||
      attemptId !== retryAttemptIdRef.current ||
      !retryModeRef.current ||
      !retryListeningWantedRef.current
    ) {
      if (speechRecorder.isRecording) {
        speechRecorder.cancel(
          assistantAudioPendingRef.current || assistantAudioPlayingRef.current
            ? undefined
            : { retainStream: true },
        );
        retryRecorderActiveRef.current = false;
      }
      return false;
    }

    const win = window as unknown as WindowWithSpeech;
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;

    // Không có Browser SpeechRecognition:
    // vẫn có thể sử dụng MediaRecorder + STT backend.
    if (!SpeechRec) {
      if (retryRecorderActiveRef.current) {
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = true;

        setIsMicRecording(true);
        setLatestTranscript(
          "Bé đọc từ cần luyện, ViRead sẽ kiểm tra trong vài giây nhé.",
        );

        scheduleRetryCaptureStop(candidate);

        return true;
      }

      retryListeningWantedRef.current = false;
      retryShouldRestartRef.current = false;
      isListeningActiveRef.current = false;

      setIsMicRecording(false);
      setRetryFeedback("microphone-unavailable");
      setLatestTranscript(
        "Chưa bật được microphone. Nhờ ba mẹ kiểm tra quyền truy cập rồi thử lại nhé.",
      );

      return false;
    }

    const recognition = new SpeechRec();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "vi-VN";
    // Alternatives are competing guesses for the same audio, not separate
    // words. Only use the recognizer's best hypothesis for this single word.
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: BrowserSpeechEvent) => {
      if (
        !mountedRef.current ||
        assistantAudioPendingRef.current ||
        assistantAudioPlayingRef.current ||
        attemptId !== retryAttemptIdRef.current ||
        !retryModeRef.current ||
        !retryListeningWantedRef.current ||
        retryProcessingRef.current
      ) {
        return;
      }

      let interim = "";
      const finalTranscripts: string[] = [];

      // Only consume newly updated results. Each result[0] is the best
      // hypothesis; alternatives are not additional words in the recording.
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const text = result[0]?.transcript?.trim() ?? "";

        if (!text) continue;

        // Browser recognition is a better speech-onset signal than raw
        // microphone volume, which can be triggered by room noise.
        retrySpeechObservedRef.current = true;

        if (result.isFinal) {
          finalTranscripts.push(text);
        } else {
          interim = [interim, text].filter(Boolean).join(" ");
        }
      }

      if (interim) {
        setLatestTranscript(interim);
      }

      if (finalTranscripts.length === 0) {
        return;
      }

      const finalText = finalTranscripts.join(" ");

      setLatestTranscript(finalText);

      // A browser match can stop capture early, but the saved recording stays
      // the source used to score this retry.
      const matchingFinal = finalTranscripts.find(
        (text) => classifyRetryTranscript(candidate.text, text) === "CORRECT",
      );
      if (matchingFinal) {
        void stopRetryListeningAndTranscribe(candidate, matchingFinal);
        return;
      }

      // Keep listening; a non-matching browser interim result is not proof
      // that the child pronounced the target incorrectly.
      setRetryFeedback("listening");
      retryShouldRestartRef.current = true;
    };

    recognition.onerror = (event: BrowserSpeechErrorEvent) => {
      if (attemptId !== retryAttemptIdRef.current) return;
      if (event.error === "aborted") {
        return;
      }

      if (event.error === "no-speech") {
        retryShouldRestartRef.current = retryListeningWantedRef.current;
        return;
      }

      console.warn("[RETRY SPEECH RECOGNITION ERROR]", event.error);

      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "language-not-supported" ||
        event.error === "audio-capture" ||
        event.error === "network"
      ) {
        retryShouldRestartRef.current = false;

        if (retryRecorderActiveRef.current) {
          void stopRetryListeningAndTranscribe(candidate);
          return;
        }

        retryListeningWantedRef.current = false;
        isListeningActiveRef.current = false;

        setIsMicRecording(false);
        setRetryFeedback(
          event.error === "not-allowed" ||
            event.error === "service-not-allowed" ||
            event.error === "audio-capture"
            ? "microphone-unavailable"
            : "speech-unavailable",
        );

        const message =
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "Microphone chưa được cấp quyền. Hãy cho phép trình duyệt sử dụng microphone."
            : event.error === "audio-capture"
              ? "Không tìm thấy microphone. Hãy kiểm tra thiết bị ghi âm."
              : event.error === "network"
                ? "Kết nối nhận diện bị gián đoạn. Bé thử lại nhé."
                : "Trình duyệt không hỗ trợ nhận diện tiếng Việt.";

        setLatestTranscript(message);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }

      if (
        !mountedRef.current ||
        !retryModeRef.current ||
        attemptId !== retryAttemptIdRef.current
      ) {
        return;
      }

      if (retryListeningWantedRef.current && retryShouldRestartRef.current) {
        // Chrome có thể kết thúc một phiên nhận diện
        // dù MediaRecorder vẫn đang thu âm.
        window.setTimeout(() => {
          if (
            mountedRef.current &&
            retryModeRef.current &&
            retryListeningWantedRef.current &&
            retryShouldRestartRef.current &&
            !recognitionRef.current
          ) {
            void startRetryRecognition(candidate);
          }
        }, 250);

        return;
      }

      if (!retryListeningWantedRef.current) {
        isListeningActiveRef.current = false;

        if (mountedRef.current) {
          setIsMicRecording(false);
        }
      }
    };

    try {
      recognitionRef.current = recognition;
      recognition.start();

      setIsMicRecording(true);
      scheduleRetryCaptureStop(candidate, false);

      return true;
    } catch (error) {
      if (attemptId !== retryAttemptIdRef.current || !mountedRef.current) {
        return false;
      }

      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }

      console.warn("Không thể bắt đầu Browser SpeechRecognition:", error);

      // Browser recognition lỗi nhưng MediaRecorder vẫn chạy:
      // tiếp tục thu âm để backend nhận diện.
      if (retryRecorderActiveRef.current) {
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = true;

        setIsMicRecording(true);
        setLatestTranscript(
          "ViRead đang kiểm tra âm thanh. Bé đọc từ cần luyện nhé.",
        );

        scheduleRetryCaptureStop(candidate);

        return true;
      }

      retryListeningWantedRef.current = false;
      retryShouldRestartRef.current = false;
      isListeningActiveRef.current = false;

      setIsMicRecording(false);
      setRetryFeedback("microphone-unavailable");
      setLatestTranscript(
        "Chưa thể bật nhận diện giọng nói. Hãy kiểm tra microphone rồi thử lại nhé.",
      );

      return false;
    }
  }

  async function playRetryInstructionAndListen(
    candidate: RetryWordCandidate,
    permissionRequest?: Promise<void>,
  ): Promise<void> {
    setRetryFeedback("preparing-microphone");
    setLatestTranscript("Đang chuẩn bị microphone...");

    try {
      await (permissionRequest ?? speechRecorder.prepare());
    } catch (error) {
      console.warn("[RETRY MICROPHONE PERMISSION]", error);
      if (mountedRef.current && retryModeRef.current) {
        setIsMicRecording(false);
        setRetryFeedback("microphone-unavailable");
        setLatestTranscript(
          "Nhờ ba mẹ cho phép trình duyệt dùng microphone, rồi bé thử lại nhé.",
        );
      }
      return;
    }

    if (
      !mountedRef.current ||
      !retryModeRef.current ||
      retryCandidatesRef.current[retryPositionRef.current]?.wordId !==
        candidate.wordId
    ) {
      return;
    }

    try {
      await playAssistantAudio(async () => {
        setRetryFeedback("playing-instruction");
        setLatestTranscript("ViRead đang hướng dẫn bé đọc từ cần luyện...");
        await speechPlayer.play(`Bé hãy đọc lại từ ${candidate.text} nhé.`);

        if (
          !mountedRef.current ||
          !retryModeRef.current ||
          retryCandidatesRef.current[retryPositionRef.current]?.wordId !==
            candidate.wordId
        ) {
          return;
        }

        setRetryFeedback("playing-sample");
        setLatestTranscript(`ViRead đang đọc mẫu từ ${candidate.text}...`);
        setIsReadingWord(true);
        try {
          await speechPlayer.play(candidate.text);
        } finally {
          if (mountedRef.current) setIsReadingWord(false);
        }
      });

      if (
        !mountedRef.current ||
        !retryModeRef.current ||
        retryCandidatesRef.current[retryPositionRef.current]?.wordId !==
          candidate.wordId
      ) {
        return;
      }

      await startRetryRecognition(candidate);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      console.error("[RETRY TTS PLAYBACK]", error);
      if (mountedRef.current && retryModeRef.current) {
        setIsReadingWord(false);
        setIsMicRecording(false);
        setRetryFeedback("audio-unavailable");
        setLatestTranscript(
          "Chưa phát được lời hướng dẫn hoặc tiếng mẫu. Bé thử nghe lại nhé.",
        );
      }
    }
  }

  async function beginRetryWord(
    position: number,
    permissionRequest?: Promise<void>,
  ): Promise<void> {
    if (!mountedRef.current) return;
    const candidate = retryCandidatesRef.current[position];
    if (!candidate) {
      setRetryFeedback("incorrect");
      setPageNavigationError(
        "Danh sách từ cần luyện không còn hợp lệ. Tiến trình vẫn được giữ; vui lòng thử lại.",
      );
      return;
    }

    cancelRetryRecognition();
    retryPositionRef.current = position;
    retryCaptureAttemptRef.current = 0;
    setRetryWordPosition(position);
    setRetryFeedback("waiting");
    setLatestTranscript("");
    setIsReadingWord(false);
    setPageNavigationError(null);

    // Retry candidates can belong to pages visited earlier in a multi-page
    // session. Re-open the candidate's verified page before highlighting it.
    if (
      !page ||
      page.page_id !== candidate.pageId ||
      page.page_revision_id !== candidate.pageRevisionId
    ) {
      setIsBusy(true);
      try {
        const progress = await services.readingService.navigateToPage(
          sessionId,
          candidate.pageId,
        );
        const retryPage =
          await services.readingService.getCurrentPage(sessionId);
        if (!mountedRef.current) return;
        if (
          retryPage.page_id !== candidate.pageId ||
          retryPage.page_revision_id !== candidate.pageRevisionId
        ) {
          throw new Error(
            "The retry page revision no longer matches the session.",
          );
        }
        setPageProgress(progress);
        setPage(retryPage);
      } catch {
        if (mountedRef.current) {
          setRetryFeedback("incorrect");
          setPageNavigationError(
            `Chưa mở lại được trang ${candidate.pageNumber} để bé đọc từ này. Tiến trình vẫn được giữ; vui lòng thử lại.`,
          );
          speechRecorder.cancel();
        }
        return;
      } finally {
        if (mountedRef.current) setIsBusy(false);
      }
    }

    if (!mountedRef.current) return;
    setCurrentWordId(candidate.wordId);
    await playRetryInstructionAndListen(candidate, permissionRequest);
  }

  function skipRetryWord(): void {
    if (
      !retryModeRef.current ||
      retryProcessingRef.current ||
      pendingRetryEventRef.current
    ) {
      return;
    }

    const nextPosition = retryPositionRef.current + 1;
    stopRetryRecognition();

    if (nextPosition >= retryCandidatesRef.current.length) {
      retryModeRef.current = false;
      setRetryMode(false);
      void completeReadingSession();
      return;
    }

    // A skipped word remains unresolved; it is deliberately not added to the
    // retry-confirmed set or the original correct-word statistics.
    void beginRetryWord(nextPosition);
  }

  function startRetrySession(candidates: RetryWordCandidate[]): boolean {
    // Prefer the exact queue shown in the consent dialog. If an older render
    // supplied an empty array, rebuild from the durable word-id map rather
    // than silently completing the reading session.
    const activeCandidates =
      candidates.length > 0 ? candidates : buildRetryCandidates();

    if (activeCandidates.length === 0) {
      setRetryFeedback("incorrect");
      setLatestTranscript(
        "Danh sách từ cần luyện chưa sẵn sàng. Bé vui lòng thử lại nhé.",
      );
      setRetryPrompt(true);
      return false;
    }

    // Request microphone permission synchronously from the retry button's
    // gesture, before page navigation or any unrelated asynchronous work.
    const permissionRequest = speechRecorder.prepare();
    void permissionRequest.catch(() => undefined);

    // The consent transition invalidates any remaining initial-reading countdown.
    setCountdown(null);
    retryCandidatesRef.current = [...activeCandidates];
    setRetryCandidates(activeCandidates);
    retryModeRef.current = true;
    retryProcessingRef.current = false;
    pendingRetryEventRef.current = null;
    setRetryConfirmedWordIds(new Set());
    retryPositionRef.current = 0;
    setRetryWordPosition(0);
    setRetryFeedback("waiting");
    setRetryMode(true);
    void beginRetryWord(0, permissionRequest);
    return true;
  }

  async function completeReadingSession() {
    if (finishStartedRef.current) return;

    if (pendingRetryEventRef.current) {
      retryModeRef.current = true;
      setRetryMode(true);
      setRetryFeedback("save-error");
      setLatestTranscript(
        "Kết quả đọc lại vẫn chưa được lưu. Bé hãy thử lưu lại trước khi kết thúc nhé.",
      );
      return;
    }

    finishStartedRef.current = true;
    setIsBusy(true);

    try {
      // REST là nguồn dữ liệu chính thức để kết thúc session.
      const finishedSession = await services.readingService.finish(sessionId);

      // WebSocket chỉ là thông báo phụ, không ảnh hưởng kết quả REST.
      void services.readingSocketAdapter
        .sendControl(sessionId, "finish")
        .catch((error: unknown) => {
          console.warn("Không gửi được tín hiệu kết thúc buổi đọc:", error);
        });

      if (!mountedRef.current) return;

      const wordsList = Array.from(spokenWordsSetRef.current);
      const durationMinutes = getDurationMinutes(finishedSession.duration_ms);

      const persistedCompletion = await services.readingService
        .getCompletionSummary(sessionId)
        .catch(() => null);

      const correctWordIds = Array.from(correctWordIdsRef.current).filter(
        (wordId) =>
          !mispronouncedWordIdsRef.current.has(wordId) &&
          !skippedWordIdsRef.current.has(wordId),
      );
      const correctWordsList = correctWordIds
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));

      const mispronouncedWordsList = Array.from(mispronouncedWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));
      const skippedWordsList = Array.from(skippedWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));

      const totalTracked = new Set([
        ...correctWordIds,
        ...mispronouncedWordIdsRef.current,
        ...skippedWordIdsRef.current,
      ]).size;

      const score =
        totalTracked > 0
          ? Math.round((correctWordsList.length / totalTracked) * 100)
          : null;

      const updatedSummary: ReadingCompletionSummaryUI = {
        correct_words: correctWordsList,
        duration_minutes: durationMinutes,
        mispronounced_words: mispronouncedWordsList,
        skipped_words: skippedWordsList,
        pages_explored:
          persistedCompletion?.pages_explored ??
          (pageProgress?.persisted ? pageProgress.completed_pages : null),
        selected_range_pages:
          persistedCompletion?.selected_range_pages ??
          (pageProgress?.persisted ? pageProgress.total_pages : null),
        practiced_words: wordsList.length,
        score,
        spoken_words: wordsList,
        transcripts: [...transcriptsListRef.current],
      };

      setSessionSummary(updatedSummary);
      setCanonicalState("FINISHED");
      setConfirmFinish(false);
      setRetryPrompt(false);
      retryModeRef.current = false;
      setRetryMode(false);
      speechRecorder.cancel();
      setUiState(
        await resolvePostFinishUiState(
          services.comprehensionService,
          sessionId,
        ),
      );
    } catch (error) {
      console.error("Lỗi khi kết thúc buổi đọc:", error);
      finishStartedRef.current = false;
    } finally {
      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }
  async function persistPageComparisonReports(): Promise<void> {
    const pageBuckets = [...pageTranscriptsRef.current.values()]
      .filter((bucket) => bucket.segments.some((segment) => segment.trim()))
      .sort((left, right) => left.page_number - right.page_number);

    setComparisonResult(null);
    if (pageBuckets.length === 0) {
      setComparisonError(
        "Chưa nhận diện được lời đọc thực tế nên chưa thể tạo báo cáo đối chiếu.",
      );
      return;
    }

    setComparisonError(null);
    let latestResult: ComparisonResult | null = null;
    let firstComparisonError: string | null = null;

    for (const bucket of pageBuckets) {
      const transcript = bucket.segments.join(" ").trim();
      if (!transcript) continue;

      try {
        latestResult = await compareTranscript(
          sessionId,
          transcript,
          bucket.words,
          {
            page_id: bucket.page_id,
            page_revision_id: bucket.page_revision_id,
          },
        );
      } catch (error) {
        console.error("Lỗi so sánh bài đọc:", {
          sessionId,
          pageId: bucket.page_id,
          pageRevisionId: bucket.page_revision_id,
          error,
        });
        firstComparisonError ??=
          error instanceof Error
            ? error.message
            : "Không thể tạo một hoặc nhiều báo cáo đọc.";
      }
    }

    if (!mountedRef.current) return;
    setComparisonResult(latestResult);
    setComparisonError(firstComparisonError);
  }

  async function retrySavingPageReports(): Promise<void> {
    if (retryReportSaveStartedRef.current) return;
    retryReportSaveStartedRef.current = true;
    setIsRetryingReports(true);
    try {
      // Re-submit the actual transcript/page snapshots. The backend returns
      // an existing identical report, so previously saved pages stay unique.
      await persistPageComparisonReports();
    } finally {
      retryReportSaveStartedRef.current = false;
      if (mountedRef.current) setIsRetryingReports(false);
    }
  }

  async function prepareInitialReading() {
    if (initialAssessmentPreparedRef.current) return;
    if (prepareFinishStartedRef.current) return;
    if (finishStartedRef.current) return;

    prepareFinishStartedRef.current = true;
    // Cancel the initial reading countdown before finalizing; its expiry must
    // never restart the original microphone while retry mode owns capture.
    setCountdown(null);
    setIsBusy(true);
    preventAssistantAudioResume();
    speechPlayer.stop();

    let isCompletingSession = false;

    try {
      // 1. Dừng microphone và chờ chuyển ghi âm thành văn bản.
      if (isMicRecording) {
        try {
          await stopListeningAndTranscribe();
        } catch (error) {
          console.error("Lỗi khi dừng ghi âm:", error);
          speechRecorder.cancel();
        }

        if (mountedRef.current) {
          setIsMicRecording(false);
        }
      }

      if (!mountedRef.current) return;

      // 2. Hoàn tất alignment của lượt đọc đầu tiên.
      const engine = alignmentEngineRef.current;

      if (engine) {
        const currentSnapshot = engine.getSnapshot();
        if (
          currentSnapshot.spokenWords.length > 0 ||
          currentSnapshot.statusByWordId.size > 0
        ) {
          applyRealtimeSnapshot(engine.finish());
        }
      }
      // Persist a comparison for every page with an actual transcript.
      await persistPageComparisonReports();

      if (!mountedRef.current) return;

      // 6. Đánh dấu lượt đánh giá đầu tiên đã hoàn tất.
      initialAssessmentPreparedRef.current = true;

      // 7. Tạo danh sách từ cần đọc lại.
      const candidates = buildRetryCandidates();
      retryCandidatesRef.current = candidates;

      setRetryCandidates(candidates);
      setConfirmFinish(false);

      // 8. Nếu có từ sai hoặc bị bỏ qua, hỏi bé có muốn đọc lại không.
      if (candidates.length > 0) {
        setRetryPrompt(true);
        return;
      }

      // 9. Không có từ cần retry thì kết thúc session.
      isCompletingSession = true;
      await completeReadingSession();
    } catch (error) {
      console.error("Lỗi khi chuẩn bị kết thúc lượt đọc:", error);

      // Chỉ cho phép chuẩn bị lại nếu quá trình chuẩn bị thất bại.
      initialAssessmentPreparedRef.current = false;
    } finally {
      prepareFinishStartedRef.current = false;

      if (mountedRef.current) {
        // Không ghi đè trạng thái busy của completeReadingSession().
        if (!isCompletingSession) {
          setIsBusy(false);
        }
      }
    }
  }
  async function finishReading() {
    if (finishStartedRef.current) return;

    // Nếu đang ở chế độ đọc lại:
    // Dừng nhận diện và kết thúc session ngay.
    if (retryModeRef.current || retryMode) {
      cancelRetryRecognition();

      await completeReadingSession();
      return;
    }

    // Nếu lượt đọc đầu tiên đã được đánh giá,
    // không chạy alignment và compare lần nữa.
    if (initialAssessmentPreparedRef.current) {
      setConfirmFinish(false);
      setRetryPrompt(true);
      return;
    }

    await prepareInitialReading();
  }
  if (loadState.status === "error" || loadState.status === "not-found") {
    const notFound = loadState.status === "not-found";
    const title = notFound
      ? "Không tìm thấy buổi đọc"
      : "Chưa mở được buổi đọc";

    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col justify-center gap-4 p-4">
        <h1 className="text-heading font-extrabold text-ink">{title}</h1>
        <StatusMessage tone="error">
          {notFound
            ? "Buổi đọc không tồn tại hoặc không thuộc tài khoản hiện tại."
            : "Có lỗi xảy ra. Ba mẹ vui lòng thử lại hoặc quay về thư viện."}
        </StatusMessage>
        {!notFound ? (
          <Button
            onClick={() => {
              setLoadState({ status: "loading" });
              setLoadKey((key) => key + 1);
            }}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-5" />
            Thử lại
          </Button>
        ) : null}
        <ButtonLink href="/books" variant="quiet">
          <ArrowLeft aria-hidden="true" className="size-5" />
          Về thư viện
        </ButtonLink>
      </section>
    );
  }

  if (loadState.status === "loading" || !page) {
    return (
      <section
        aria-busy="true"
        aria-label="Đang chuẩn bị buổi đọc"
        className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 p-4"
      >
        <span className="sr-only" role="status">
          Đang chuẩn bị buổi đọc…
        </span>
        <Skeleton className="h-12 w-full rounded-control" />
        <Skeleton className="min-h-[680px] w-full rounded-card" />
        <Skeleton className="h-20 w-full rounded-card" />
      </section>
    );
  }

  const { book, child, completion } = loadState.data;
  const detailHref = `/books/${encodeURIComponent(book.id)}`;
  const booksHref = "/books";
  const safety = services.readingSocketAdapter.getSafetySnapshot(uiState);
  const currentWord =
    page.words.find((word) => word.word_id === currentWordId)?.text ?? "đang";

  if (uiState === "ready") {
    return (
      <ReadingReady
        book={book}
        child={child}
        isStarting={isBusy}
        onStart={() => void startReading()}
      />
    );
  }

  if (uiState === "question") {
    return (
      <ComprehensionQuestion
        child={child}
        onComplete={() => setUiState("complete")}
        sessionId={sessionId}
      />
    );
  }

  if (uiState === "complete") {
    return (
      <SessionComplete
        booksHref={booksHref}
        child={child}
        sessionId={sessionId}
        summary={sessionSummary ?? completion}
        reportError={comparisonError}
        onRetryReports={
          hasPageTranscripts ? () => void retrySavingPageReports() : undefined
        }
        isRetryingReports={isRetryingReports}
      />
    );
  }

  return (
    <div
      data-canonical-state={canonicalState}
      data-child-error-count={safety.child_error_events.length}
      data-evidence-valid={safety.evidence_valid}
      data-scoring-active={safety.scoring_active}
    >
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-2 px-4 pt-3 sm:px-8">
        {pageProgress ? (
          <div className="flex flex-col gap-3 rounded-card border border-line bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-bold text-ink">
                Phạm vi đọc: Trang {pageProgress.start_page_number}–
                {pageProgress.end_page_number}
              </p>
              <p className="text-sm text-muted" aria-live="polite">
                Trang {pageProgress.current_page_number} ·{" "}
                {pageProgress.current_index + 1}/{pageProgress.total_pages}{" "}
                trong phạm vi · {pageProgress.completed_pages}/
                {pageProgress.total_pages} trang đã hoàn thành
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                disabled={
                  isBusy ||
                  uiState !== "reading" ||
                  pageProgress.current_index <= 0
                }
                onClick={() =>
                  void navigateWithinRange(pageProgress.current_index - 1)
                }
                variant="secondary"
              >
                <ChevronLeft aria-hidden="true" className="size-5" />
                Trang trước
              </Button>
              <Button
                disabled={
                  isBusy ||
                  uiState !== "reading" ||
                  pageProgress.current_index >= pageProgress.total_pages - 1
                }
                onClick={() =>
                  void navigateWithinRange(pageProgress.current_index + 1)
                }
                variant="secondary"
              >
                Trang tiếp theo
                <ChevronRight aria-hidden="true" className="size-5" />
              </Button>
            </div>
            {pageProgress.persisted &&
            pageProgress.pages[pageProgress.current_index]?.status !==
              "COMPLETED" ? (
              <Button
                className="sm:self-start"
                disabled={isBusy || uiState !== "reading"}
                onClick={() => void confirmCurrentPageCompleted()}
                variant="quiet"
              >
                Đánh dấu trang đã đọc xong
              </Button>
            ) : null}
          </div>
        ) : null}
        {pageNavigationError ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusMessage tone="info">{pageNavigationError}</StatusMessage>
            {retryMode ? (
              <Button
                disabled={isBusy}
                onClick={() => void beginRetryWord(retryPositionRef.current)}
                variant="secondary"
              >
                Thử mở lại trang
              </Button>
            ) : null}
          </div>
        ) : null}
        {pageProgress &&
        pageProgress.current_index === pageProgress.total_pages - 1 ? (
          <p className="text-sm font-semibold text-primary" role="status">
            Bé đã đến trang cuối của phạm vi. Có thể kết thúc buổi đọc khi sẵn
            sàng.
          </p>
        ) : null}
      </div>

      <ReadingLayout
        audioLevel={speechRecorder.audioLevel}
        bookTitle={book.title}
        previewSnapshot={previewSnapshot}
        controlsDisabled={
          uiState !== "reading" ||
          (isBusy && !speechPlayer.isPlaying) ||
          (retryMode && pageNavigationError !== null) ||
          (retryMode &&
            [
              "preparing-microphone",
              "playing-instruction",
              "playing-sample",
            ].includes(retryFeedback))
        }
        correctWordIds={
          retryConfirmedWordIds.size > 0
            ? new Set([...correctWordIds, ...retryConfirmedWordIds])
            : correctWordIds
        }
        countdown={countdown}
        currentWordId={currentWordId}
        currentWordText={
          retryMode
            ? (retryCandidates[retryWordPosition]?.text ?? null)
            : (page.words.find((w) => w.word_id === currentWordId)?.text ??
              null)
        }
        exitHref={detailHref}
        voiceSettings={
          <ReadingVoiceSettings
            disabled={isMicRecording}
            isPreviewing={speechPlayer.isPlaying}
            onPreview={handleVoicePreview}
            onStopPreview={() => speechPlayer.stop()}
          />
        }
        isCurrentWordMispronounced={Boolean(
          currentWordId && mispronouncedWordIds.has(currentWordId),
        )}
        isListening={uiState === "reading"}
        isMicRecording={isMicRecording}
        retryContextPhrase={
          retryMode
            ? (retryCandidates[retryWordPosition]?.contextPhrase ?? null)
            : null
        }
        retryMode={retryMode}
        retryWordPosition={retryWordPosition + 1}
        retryWordCount={retryCandidates.length}
        retryFeedback={retryFeedback}
        isPageTransitioning={uiState === "page-turn"}
        isPlayingSample={speechPlayer.isPlaying && !isReadingWord}
        isReadingWord={isReadingWord}
        isSpeaking={speechRecorder.isSpeaking}
        latestTranscript={latestTranscript}
        mispronouncedWordIds={
          retryConfirmedWordIds.size > 0
            ? new Set(
                [...mispronouncedWordIds].filter(
                  (wordId) => !retryConfirmedWordIds.has(wordId),
                ),
              )
            : mispronouncedWordIds
        }
        onFinish={() => setConfirmFinish(true)}
        onHelp={() => void requestTutor()}
        onPause={() => void pauseReading()}
        onRetryMicrophonePermission={retryRetryMicrophonePermission}
        onRetryRead={retryCurrentWord}
        onRetrySave={() => void retryPendingRetryEvent()}
        onReadSample={() => void handleReadSample()}
        onReadWord={
          retryMode ? () => void handleReadSample() : handleReadCurrentWord
        }
        onSkipRetryWord={skipRetryWord}
        onToggleListening={() => void handleToggleListening()}
        onWordClick={handleWordClick}
        page={page}
        spokenWords={spokenWords}
        skippedWordIds={
          retryConfirmedWordIds.size > 0
            ? new Set(
                [...skippedWordIds].filter(
                  (wordId) => !retryConfirmedWordIds.has(wordId),
                ),
              )
            : skippedWordIds
        }
        repeatedWordIds={repeatedWordIds}
        hesitationWordIds={hesitationWordIds}
        comparisonResult={comparisonResult}
      >
        {uiState === "page-turn" ? (
          <StatusBanner className="fixed left-1/2 top-20 z-40 w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2">
            Đang chuyển trang và liên kết lại từ đang đọc…
          </StatusBanner>
        ) : null}
      </ReadingLayout>
      {retryPrompt ? (
        <ReadingStatusDialog
          body={`Bé còn ${retryCandidates.length} từ cần đọc lại. Mình cùng luyện thêm một lần nhé!`}
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Đồng ý, đọc lại",
            onClick: () => {
              if (startRetrySession(retryCandidatesRef.current)) {
                setRetryPrompt(false);
              }
            },
          }}
          secondaryAction={{
            label: "Bỏ qua",
            onClick: () => {
              retryModeRef.current = false;
              setRetryPrompt(false);
              void completeReadingSession();
            },
          }}
          title="Mình đọc lại những từ này nhé?"
        />
      ) : confirmFinish ? (
        <ReadingStatusDialog
          body="Mình sẽ lưu lại phần bé đã đọc. Khi nào thích, mình lại đọc cùng nhau."
          closeOnEscape
          onClose={() => setConfirmFinish(false)}
          primaryAction={{
            isLoading: isBusy,
            label: "Lưu và dừng",
            onClick: () => void finishReading(),
          }}
          secondaryAction={{
            label: "Đọc tiếp",
            onClick: () => setConfirmFinish(false),
          }}
          title="Bé muốn nghỉ hôm nay?"
        />
      ) : uiState === "paused" ? (
        <ReadingStatusDialog
          body="Khi sẵn sàng, mình đọc tiếp nhé. Đánh giá đang tạm dừng và không tạo lỗi đọc."
          closeOnEscape
          onClose={() => void resumeReading()}
          primaryAction={{
            isLoading: isBusy,
            label: "Đọc tiếp",
            onClick: () => void resumeReading(),
          }}
          secondaryAction={{
            label: "Dừng buổi đọc",
            onClick: () => setConfirmFinish(true),
          }}
          title="Bé đang nghỉ một chút"
        />
      ) : uiState === "microphone-denied" ? (
        <ReadingStatusDialog
          body="Nhờ ba mẹ bật quyền micro trong trình duyệt nhé. Hệ thống đang ngừng nghe và không kết luận bé đọc sai."
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Thử lại",
            onClick: () => void retryMicrophonePermission(),
          }}
          secondaryAction={{
            label: "Kết thúc an toàn",
            onClick: () => setConfirmFinish(true),
          }}
          title="Mình chưa nghe thấy giọng bé"
        />
      ) : uiState === "page-confidence-low" ? (
        <ReadingStatusDialog
          body={
            <div className="space-y-2">
              <p>Đặt sách ngay ngắn hơn một chút nhé.</p>
              <p>
                Đánh giá đang tạm dừng; chưa có trang chắc chắn nên không tạo
                lỗi đọc.
              </p>
            </div>
          }
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Thử lại",
            onClick: () => void retryPageMatch(),
          }}
          secondaryAction={{
            label: "Kết thúc an toàn",
            onClick: () => setConfirmFinish(true),
          }}
          title="Mình chưa nhìn rõ trang sách"
        />
      ) : uiState === "reconnecting" || uiState === "stt-error" ? (
        <ReadingStatusDialog
          body={
            <div className="space-y-2">
              <p>
                {uiState === "stt-error"
                  ? "Mình chưa thể nghe hoặc nhận dạng tạm thời."
                  : "Đang kết nối lại. Mình vẫn giữ chỗ bé vừa đọc."}
              </p>
              <p>Đánh giá đã dừng; khoảng mất kết nối không tạo lỗi đọc.</p>
              {connectionState === "timed-out" ? (
                <StatusMessage title="Chưa kết nối lại được" tone="error">
                  Ba mẹ có thể thử lại hoặc kết thúc buổi đọc an toàn.
                </StatusMessage>
              ) : null}
            </div>
          }
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: uiState === "stt-error" ? "Thử nghe lại" : "Kết nối lại",
            onClick: () =>
              void reconnect(
                uiState === "stt-error" ? "recover" : reconnectMode,
              ),
          }}
          secondaryAction={{
            label: "Kết thúc an toàn",
            onClick: () => setConfirmFinish(true),
          }}
          title={
            uiState === "stt-error"
              ? "Mình chưa nghe rõ"
              : "Đợi mình một chút nhé…"
          }
        />
      ) : null}

      {uiState === "tts-error" || tutorOpen ? (
        <TutorMessage
          action={tutorAction}
          isPlaying={speechPlayer.isPlaying}
          isRetrying={isBusy}
          onClose={closeTutor}
          onRetry={() => void retryTutor()}
          ttsFailed={uiState === "tts-error"}
          word={currentWord}
        />
      ) : null}

      <span className="sr-only" aria-live="polite">
        Trạng thái kết nối: {connectionLabel(connectionState)}. Số lỗi đọc được
        tạo trong khoảng này: 0.
      </span>
    </div>
  );
}

function getDurationMinutes(durationMs: number | null): number | null {
  if (durationMs === null) return null;
  return Math.ceil(Math.max(0, durationMs) / 60000);
}

function connectionLabel(state: ReadingConnectionState): string {
  const labels: Record<ReadingConnectionState, string> = {
    connected: "đã kết nối",
    reconnecting: "đang kết nối lại",
    recovered: "đã khôi phục kết nối",
    "timed-out": "kết nối lại quá thời gian",
  };

  return labels[state];
}
