"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import { ManualPageSelector } from "@/components/reading/manual-page-selector";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { ReadingReady } from "@/components/reading/reading-ready";
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
import { isRetryWordRecognized } from "@/lib/reading/retry-recognition";
import { isServiceError } from "@/lib/api/service-error";
import { createSpeechService } from "@/lib/api/speech-service";
import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
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
  pagePreviews: readonly BookPagePreviewDTO[];
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
interface PageTranscriptBucket {
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly page_number: number;
  readonly segments: string[];
  readonly words: WordTimestamp[];
}
type RetryOriginalStatus = "OMISSION" | "MISPRONUNCIATION";

interface RetryWordItem {
  word_id: string;
  page_id: string;
  page_revision_id: string;
  page_number: number;
  word_index: number;
  text: string;
  original_status: RetryOriginalStatus;
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
  const [selectedManualPageId, setSelectedManualPageId] = useState<
    string | null
  >(null);
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
  const [latestTranscript, setLatestTranscript] = useState<string | null>(null);
  const [comparisonResult, setComparisonResult] =
    useState<ComparisonResult | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
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
  const lastPreviewWordIndexRef = useRef(-1);
  const skippedWordIdsRef = useRef<Set<string>>(new Set());
  const repeatedWordIdsRef = useRef<Set<string>>(new Set());
  const hesitationWordIdsRef = useRef<Set<string>>(new Set());
  const [retryPrompt, setRetryPrompt] = useState(false);
  const [retryMode, setRetryMode] = useState(false);
  const [retryCandidates, setRetryCandidates] = useState<RetryWordCandidate[]>(
    [],
  );
  const [retryConfirmedWordIds, setRetryConfirmedWordIds] = useState<
    Set<string>
  >(() => new Set());
  const [retryWordPosition, setRetryWordPosition] = useState(0);
  const [retryFeedback, setRetryFeedback] = useState<
    "waiting" | "incorrect" | "success"
  >("waiting");
  const retryModeRef = useRef(false);
  const retryProcessingRef = useRef(false);
  const retryShouldRestartRef = useRef(false);
  const retryListeningWantedRef = useRef(false);
  const retryPositionRef = useRef(0);

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
  const finishStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isListeningActiveRef = useRef(false);

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
      if (!trimmed) return;

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

  const handleWordClick = useCallback(
    async (word: ReadingPageWordDTO) => {
      setCurrentWordId(word.word_id);
      setLatestTranscript(word.text);

      if (speechPlayer.isPlaying) {
        speechPlayer.stop();
      }

      setIsReadingWord(true);
      try {
        await speechPlayer.play(word.text);
      } catch (err) {
        console.warn("Lỗi phát âm 1 từ:", err);
      } finally {
        if (mountedRef.current) {
          setIsReadingWord(false);
        }
      }
    },
    [speechPlayer],
  );

  const handleReadCurrentWord = useCallback(() => {
    if (!page || !currentWordId) return;
    const word = page.words.find((w) => w.word_id === currentWordId);
    if (word) {
      void handleWordClick(word);
    }
  }, [currentWordId, handleWordClick, page]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      isListeningActiveRef.current = false;
      retryModeRef.current = false;
      transcriptionAbortRef.current?.abort();
      try {
        recognitionRef.current?.abort?.();
      } catch {
        // Safe ignore
      }
    };
  }, []);

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
        const [
          book,
          child,
          currentPage,
          pagePreviews,
          completion,
          initialProgress,
        ] = await Promise.all([
          services.bookService.get(session.book_id),
          services.childService.get(session.child_id),
          services.readingService.getCurrentPage(sessionId),
          services.bookService.listPages(session.book_id),
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
        setSelectedManualPageId(currentPage.page_id);
        setCanonicalState(session.state);
        setLoadState({
          status: "ready",
          data: { book, child, completion, pagePreviews },
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
        setSelectedManualPageId(matchedPage.page_id);
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

  function normalizeVietnamese(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .replace(/[.,/#!$%^&*;:{}=\-_`~()?'\"“”—]/g, "")
      .trim();
  }

  function applyRealtimeSnapshot(snapshot: RealtimeAlignmentSnapshot) {
    // Đây là kết quả đã xác nhận, không phải preview.
    const nextCorrectIds = new Set(correctWordIdsRef.current);
    const nextMispronouncedIds = new Set(mispronouncedWordIdsRef.current);
    const nextSkippedIds = new Set(skippedWordIdsRef.current);
    const nextRepeatedIds = new Set(repeatedWordIdsRef.current);
    const nextHesitationIds = new Set(hesitationWordIdsRef.current);

    for (const word of snapshot.statusByWordId.values()) {
      const retryItem = retryWordsByIdRef.current.get(word.wordId);

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

          if (retryItem) {
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

          if (retryItem) {
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
    setLatestTranscript(null);
    setComparisonResult(null);
    setComparisonError(null);
    browserTranscriptCollectorRef.current.reset();

    let recorderStarted = false;
    try {
      await speechRecorder.start();
      isUsingRecorderRef.current = true;
      recorderStarted = true;
    } catch (error) {
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
          };

          rec.onerror = (event: BrowserSpeechErrorEvent) => {
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

      setLatestTranscript(text);
      setComparisonError(null);

      return {
        text,
        words: transcript.words?.length ? transcript.words : null,
      };
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("Lỗi chuyển ghi âm thành văn bản:", error);
      }
      return null;
    }
  }

  async function stopListeningAndTranscribe(): Promise<string> {
    // Snapshot the page before waiting for asynchronous recorder/provider work.
    const targetPage = page;
    isListeningActiveRef.current = false;
    await stopBrowserRecognition();

    let recording: Blob | null = null;
    if (isUsingRecorderRef.current) {
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
      elevenLabsResult = await transcribeRecording(recording);
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

      if (engine) {
        const snapshot = engine.finish();
        applyRealtimeSnapshot(snapshot);
      }

      setLatestTranscript(resolvedText);
      setComparisonError(null);
    }

    return resolvedText ?? "";
  }

  async function handleReadSample() {
    if (retryModeRef.current) {
      stopRetryRecognition();
      if (speechPlayer.isPlaying) speechPlayer.stop();
      const candidate = retryCandidates[retryWordPosition];
      if (candidate) {
        setIsReadingWord(true);
        try {
          await speechPlayer.play(candidate.text);
        } finally {
          if (mountedRef.current) setIsReadingWord(false);
        }
      }
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

    if (isMicRecording) {
      try {
        await stopListeningAndTranscribe();
      } catch {
        speechRecorder.cancel();
      }
      if (mountedRef.current) setIsMicRecording(false);
    }

    const rawText = page.text || page.words.map((w) => w.text).join(" ") || "";
    const fullText = rawText.replace(/\s+/g, " ").trim();
    if (!fullText) return;

    const words = page.words;
    if (!words.length) return;

    setIsBusy(true);
    setIsReadingWord(false);
    lastPreviewWordIndexRef.current = -1;
    alignmentEngineRef.current?.reset();
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

    // Clear previous word tracking so sample read starts fresh
    correctWordIdsRef.current.clear();
    mispronouncedWordIdsRef.current.clear();
    spokenWordsSetRef.current.clear();
    skippedWordIdsRef.current.clear();
    repeatedWordIdsRef.current.clear();
    hesitationWordIdsRef.current.clear();

    failedWordsSetRef.current.clear();

    setSkippedWordIds(new Set());
    setRepeatedWordIds(new Set());
    setHesitationWordIds(new Set());
    setCorrectWordIds(new Set());
    setMispronouncedWordIds(new Set());
    setSpokenWords(new Set());

    // Set first word active immediately so user sees what is being queued
    setCurrentWordId(words[0].word_id);

    try {
      await speechPlayer.play(fullText, {
        onPlay: () => {
          if (!mountedRef.current) return;
          setCurrentWordId(words[0].word_id);
        },
        onTimeUpdate: (currentTime, duration) => {
          if (!mountedRef.current || !duration || duration <= 0) return;
          const progress = Math.min(0.999, Math.max(0, currentTime / duration));
          const targetWeight = progress * totalWeight;
          let idx = cumulativeWeights.findIndex((cw) => cw >= targetWeight);
          if (idx < 0) idx = 0;
          if (idx >= words.length) idx = words.length - 1;

          const targetWord = words[idx];
          if (targetWord) {
            setCurrentWordId(targetWord.word_id);
            correctWordIdsRef.current.clear();
            spokenWordsSetRef.current.clear();

            for (let i = 0; i < idx; i++) {
              correctWordIdsRef.current.add(words[i].word_id);
              spokenWordsSetRef.current.add(words[i].text);
            }

            mispronouncedWordIdsRef.current.delete(targetWord.word_id);
            skippedWordIdsRef.current.delete(targetWord.word_id);
            repeatedWordIdsRef.current.delete(targetWord.word_id);
            hesitationWordIdsRef.current.delete(targetWord.word_id);

            setCorrectWordIds(new Set(correctWordIdsRef.current));
            setMispronouncedWordIds(new Set(mispronouncedWordIdsRef.current));
            setSkippedWordIds(new Set(skippedWordIdsRef.current));
            setRepeatedWordIds(new Set(repeatedWordIdsRef.current));
            setHesitationWordIds(new Set(hesitationWordIdsRef.current));
            setSpokenWords(new Set(spokenWordsSetRef.current));
          }
        },
        onEnded: () => {
          if (!mountedRef.current) return;
          setIsBusy(false);
          const lastWord = words[words.length - 1];
          if (lastWord) {
            setCurrentWordId(lastWord.word_id);
            for (const w of words) {
              correctWordIdsRef.current.add(w.word_id);
              spokenWordsSetRef.current.add(w.text);
            }
            setCorrectWordIds(new Set(correctWordIdsRef.current));
            setSpokenWords(new Set(spokenWordsSetRef.current));
          }
        },
      });
    } catch {
      if (mountedRef.current) {
        setUiState("tts-error");
        setIsBusy(false);
      }
    }
  }

  async function handleToggleListening() {
    if (retryModeRef.current) {
      const candidate = retryCandidates[retryWordPosition];
      if (!candidate) return;
      if (isMicRecording) {
        stopRetryRecognition();
      } else {
        startRetryRecognition(candidate);
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
      browserTranscriptCollectorRef.current.reset();
      retryWordsByIdRef.current.clear();
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
    speechPlayer.stop();
    setIsReadingWord(false);
    try {
      if (isMicRecording) {
        await stopListeningAndTranscribe();
        if (mountedRef.current) setIsMicRecording(false);
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
      setSelectedManualPageId(nextPage.page_id);
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
    try {
      const progress = await services.readingService.completeCurrentPage(
        sessionId,
        page.page_id,
      );
      if (!mountedRef.current) return;
      setPageProgress(progress);
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

  async function retryPageMatch() {
    if (isBusy) return;
    setIsBusy(true);
    const matchedPage =
      await services.pageMatchService.retryCurrentPage(sessionId);
    if (!mountedRef.current) return;
    setPage(matchedPage);
    setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
    setSelectedManualPageId(matchedPage.page_id);
    setPageProgress(await services.readingService.getPageProgress(sessionId));
    setPageNavigationError(null);
    setCanonicalState("LISTENING");
    setConnectionState("connected");
    setUiState("reading");
    setIsBusy(false);
  }

  async function confirmManualPage() {
    if (!selectedManualPageId || isBusy) return;
    setIsBusy(true);
    const matchedPage = await services.pageMatchService.selectPage(
      sessionId,
      selectedManualPageId,
    );
    if (!mountedRef.current) return;
    setPage(matchedPage);
    setPageProgress(await services.readingService.getPageProgress(sessionId));
    setPageNavigationError(null);
    setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
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
    setTutorOpen(true);
    setIsBusy(true);
    try {
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
      await speechPlayer.play(action?.tts_text ?? word);
      if (mountedRef.current) setTutorAction(action);
    } catch {
      if (mountedRef.current) setUiState("tts-error");
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
    setIsBusy(true);
    try {
      let nextAction = tutorAction;
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
      await speechPlayer.play(nextAction?.tts_text ?? word);
      if (mountedRef.current) {
        setTutorAction(nextAction);
        setUiState("reading");
      }
    } catch {
      if (mountedRef.current) setUiState("tts-error");
    } finally {
      if (mountedRef.current) setIsBusy(false);
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
    if (!page) return [];

    return page.words
      .map((word, index) => ({
        word,
        index,
      }))
      .filter(
        ({ word }) =>
          skippedWordIdsRef.current.has(word.word_id) ||
          mispronouncedWordIdsRef.current.has(word.word_id),
      )
      .map(({ word, index }) => ({
        wordId: word.word_id,
        text: word.text,
        contextPhrase: buildRetryContextPhrase(page.words, index),
        pageId: page.page_id,
        pageRevisionId: page.page_revision_id,
        pageNumber: page.page_number,
        wordIndex: word.word_index ?? index,
        originalStatus: skippedWordIdsRef.current.has(word.word_id)
          ? "OMISSION"
          : "MISPRONUNCIATION",
      }));
  }

  function stopRetryRecognition(): void {
    // Tắt cờ trước khi gọi stop để onend không tự bật microphone lại.
    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;

    const recognition = recognitionRef.current;
    recognitionRef.current = null;

    if (recognition) {
      try {
        // stop() kết thúc phiên nhận diện bình thường; abort() gây lỗi "aborted"
        // dù người dùng chỉ đang chủ động tắt microphone.
        recognition.stop();
      } catch {
        // Recognition có thể đã tự kết thúc.
      }
    }

    if (mountedRef.current) setIsMicRecording(false);
  }

  function startRetryRecognition(candidate: RetryWordCandidate): boolean {
    if (typeof window === "undefined") return false;

    const win = window as unknown as WindowWithSpeech;
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRec) {
      retryListeningWantedRef.current = false;
      isListeningActiveRef.current = false;
      setIsMicRecording(false);
      setRetryFeedback("incorrect");
      setLatestTranscript(
        "Trình duyệt chưa hỗ trợ nhận diện giọng nói. Bé hãy thử dùng Chrome nhé.",
      );
      return false;
    }

    // Tránh mở hai phiên SpeechRecognition cùng lúc.
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Bỏ qua phiên cũ đã kết thúc.
      }
      recognitionRef.current = null;
    }

    const recognition = new SpeechRec();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "vi-VN";
    recognition.maxAlternatives = 3;

    retryListeningWantedRef.current = true;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = true;

    recognition.onresult = (event: BrowserSpeechEvent) => {
      if (!mountedRef.current || !retryModeRef.current) return;

      let interim = "";
      const finalTranscripts: string[] = [];

      // Read every final segment and every alternative. SpeechRecognition may
      // split an utterance into multiple results, and maxAlternatives is
      // meaningful only when the alternatives are actually inspected.
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];

        if (result.isFinal) {
          for (
            let alternativeIndex = 0;
            alternativeIndex < result.length;
            alternativeIndex += 1
          ) {
            const transcript =
              result[alternativeIndex]?.transcript?.trim() ?? "";

            if (transcript && !finalTranscripts.includes(transcript)) {
              finalTranscripts.push(transcript);
            }
          }
        } else {
          const transcript = result[0]?.transcript?.trim() ?? "";
          if (transcript) {
            interim = [interim, transcript].filter(Boolean).join(" ");
          }
        }
      }

      if (interim) {
        setLatestTranscript(interim);
      }

      if (finalTranscripts.length === 0 || retryProcessingRef.current) return;

      retryProcessingRef.current = true;
      setLatestTranscript(finalTranscripts[0]);

      // Accept the target as a complete Vietnamese token anywhere in the
      // utterance (including a short context phrase), not a substring.
      const isCorrect = isRetryWordRecognized(
        candidate.text,
        finalTranscripts,
      );
      if (isCorrect) {
        retryListeningWantedRef.current = false;
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = false;
        setIsMicRecording(false);
        setRetryFeedback("success");

        setRetryConfirmedWordIds((previous) => {
          const next = new Set(previous);
          next.add(candidate.wordId);
          return next;
        });

        // Chỉ cập nhật màu giao diện, không thay đổi kết quả lượt đọc gốc.
        setCorrectWordIds((previous) => {
          const next = new Set(previous);
          next.add(candidate.wordId);
          return next;
        });

        window.setTimeout(() => {
          retryProcessingRef.current = false;

          const nextPosition = retryPositionRef.current + 1;

          if (nextPosition >= retryCandidates.length) {
            retryModeRef.current = false;
            retryListeningWantedRef.current = false;
            setRetryMode(false);
            stopRetryRecognition();
            void completeReadingSession();
            return;
          }

          setRetryWordPosition(nextPosition);
          void beginRetryWord(nextPosition);
        }, 450);
      } else {
        setRetryFeedback("incorrect");

        // Giữ cơ chế tự nghe lại hiện tại.
        retryShouldRestartRef.current = true;
        retryProcessingRef.current = false;
      }
    };

    recognition.onerror = (event: BrowserSpeechErrorEvent) => {
      // "aborted" thường xuất hiện khi chủ động dừng phiên nhận diện.
      // Không xem đây là lỗi và không in log gây nhiễu.
      if (event.error === "aborted") return;

      if (event.error === "no-speech") {
        // Bé chưa nói trong khoảng thời gian của trình duyệt.
        // Tự mở lại phiên nghe nếu microphone vẫn đang được bật.
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
        retryListeningWantedRef.current = false;
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = false;
        setIsMicRecording(false);
        setRetryFeedback("incorrect");

        const message =
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "Microphone chưa được cấp quyền. Hãy cho phép trình duyệt sử dụng microphone."
            : event.error === "audio-capture"
              ? "Không tìm thấy microphone. Hãy kiểm tra thiết bị ghi âm."
              : event.error === "network"
                ? "Kết nối nhận diện giọng nói bị gián đoạn. Hãy kiểm tra Internet."
                : "Trình duyệt không hỗ trợ nhận diện tiếng Việt.";
        setLatestTranscript(message);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }

      if (!mountedRef.current || !retryModeRef.current) return;

      if (retryListeningWantedRef.current) {
        // Chrome thường kết thúc một lượt nhận diện sau câu nói hoặc no-speech.
        // Tạo phiên mới để tiếp tục nghe từ hiện tại.
        window.setTimeout(() => {
          if (
            mountedRef.current &&
            retryModeRef.current &&
            retryListeningWantedRef.current &&
            !recognitionRef.current
          ) {
            retryProcessingRef.current = false;
            startRetryRecognition(candidate);
          }
        }, 250);
        return;
      }

      isListeningActiveRef.current = false;
      setIsMicRecording(false);
    };

    try {
      recognitionRef.current = recognition;
      recognition.start();
      setIsMicRecording(true);
      return true;
    } catch (error) {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      retryListeningWantedRef.current = false;
      isListeningActiveRef.current = false;
      setIsMicRecording(false);
      console.error("Không thể bắt đầu nhận diện từ cần đọc lại:", error);
      return false;
    }
  }

  async function beginRetryWord(position: number): Promise<void> {
    const candidate = retryCandidates[position];
    if (!candidate || !mountedRef.current) return;

    stopRetryRecognition();
    retryListeningWantedRef.current = false;
    retryProcessingRef.current = false;
    retryPositionRef.current = position;
    setRetryWordPosition(position);
    setRetryFeedback("waiting");
    setCurrentWordId(candidate.wordId);
    setLatestTranscript("");
    setIsReadingWord(false);
    setRetryFeedback("waiting");
    // Không tự phát âm mẫu và không tự bật microphone.
    // Bé chủ động bấm "Nghe mẫu" hoặc "Bật mic" khi đã sẵn sàng.
  }

  function skipRetryWord(): void {
    if (!retryModeRef.current || retryProcessingRef.current) return;

    const nextPosition = retryPositionRef.current + 1;
    stopRetryRecognition();

    if (nextPosition >= retryCandidates.length) {
      retryModeRef.current = false;
      setRetryMode(false);
      void completeReadingSession();
      return;
    }

    // A skipped word remains unresolved; it is deliberately not added to the
    // retry-confirmed set or the original correct-word statistics.
    void beginRetryWord(nextPosition);
  }

  function startRetrySession(): void {
    if (retryCandidates.length === 0) {
      void completeReadingSession();
      return;
    }

    retryModeRef.current = true;
    retryProcessingRef.current = false;
    setRetryConfirmedWordIds(new Set());
    retryPositionRef.current = 0;
    setRetryWordPosition(0);
    setRetryFeedback("waiting");
    setRetryMode(true);
    void beginRetryWord(0);
  }

  async function completeReadingSession() {
    if (finishStartedRef.current) return;

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

      const correctWordsList = Array.from(correctWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));

      const mispronouncedWordsList = Array.from(failedWordsSetRef.current);

      const totalTracked =
        correctWordsList.length + mispronouncedWordsList.length;

      const score =
        totalTracked > 0
          ? Math.round((correctWordsList.length / totalTracked) * 100)
          : null;

      const updatedSummary: ReadingCompletionSummaryUI = {
        correct_words: correctWordsList,
        duration_minutes: durationMinutes,
        mispronounced_words: mispronouncedWordsList,
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
      setRetryMode(false);
      setUiState("complete");
    } catch (error) {
      console.error("Lỗi khi kết thúc buổi đọc:", error);
      finishStartedRef.current = false;
    } finally {
      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }
  async function prepareInitialReading() {
    if (initialAssessmentPreparedRef.current) return;
    if (prepareFinishStartedRef.current) return;
    if (finishStartedRef.current) return;

    prepareFinishStartedRef.current = true;
    setIsBusy(true);
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
        const finalSnapshot = engine.finish();
        applyRealtimeSnapshot(finalSnapshot);
      }
      // 4. Lấy transcript theo từng trang.
      const pageBuckets = [...pageTranscriptsRef.current.values()]
        .filter((bucket) => bucket.segments.some((segment) => segment.trim()))
        .sort((left, right) => left.page_number - right.page_number);

      // 5. So sánh transcript với nội dung từng trang.
      setComparisonResult(null);

      if (pageBuckets.length > 0) {
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
      } else {
        setComparisonError(
          "Chưa nhận diện được lời đọc thực tế nên chưa thể tạo báo cáo đối chiếu.",
        );
      }

      if (!mountedRef.current) return;

      // 6. Đánh dấu lượt đánh giá đầu tiên đã hoàn tất.
      initialAssessmentPreparedRef.current = true;

      // 7. Tạo danh sách từ cần đọc lại.
      const candidates = buildRetryCandidates();

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
      stopRetryRecognition();

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

  const { book, child, completion, pagePreviews } = loadState.data;
  const rangePagePreviews = pageProgress
    ? pagePreviews.filter((candidate) =>
        pageProgress.pages.some((entry) => entry.page_id === candidate.page_id),
      )
    : pagePreviews;
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
          <StatusMessage tone="info">{pageNavigationError}</StatusMessage>
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
          uiState !== "reading" || (isBusy && !speechPlayer.isPlaying)
        }
        correctWordIds={
          retryConfirmedWordIds.size > 0
            ? new Set([...correctWordIds, ...retryConfirmedWordIds])
            : correctWordIds
        }
        countdown={countdown}
        currentWordId={currentWordId}
        currentWordText={
          page.words.find((w) => w.word_id === currentWordId)?.text ?? null
        }
        exitHref={detailHref}
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
        retryCompleted={
          retryCandidates.length === 0 ||
          retryConfirmedWordIds.size >= retryCandidates.length
        }
        onSkipRetryWord={skipRetryWord}
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
        onManualPage={() => setUiState("manual-page")}
        onPause={() => void pauseReading()}
        onReadSample={() => void handleReadSample()}
        onReadWord={
          retryMode ? () => void handleReadSample() : handleReadCurrentWord
        }
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
              setRetryPrompt(false);
              startRetrySession();
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
            label: "Chọn trang",
            onClick: () => setUiState("manual-page"),
          }}
          title="Mình chưa nhìn rõ trang sách"
        />
      ) : uiState === "manual-page" ? (
        <ManualPageSelector
          isSaving={isBusy}
          onCancel={() => setUiState("reading")}
          onConfirm={() => void confirmManualPage()}
          onSelect={setSelectedManualPageId}
          pages={rangePagePreviews}
          selectedPageId={selectedManualPageId}
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
          onClose={() => {
            speechPlayer.stop();
            setTutorOpen(false);
            setUiState("reading");
          }}
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
