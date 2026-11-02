"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import {
  EndOfReadingReview,
  type EndReviewActivity,
} from "@/components/reading/end-of-reading-review";
import { ManualPageSelector } from "@/components/reading/manual-page-selector";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { ReadingReady } from "@/components/reading/reading-ready";
import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";
import { SessionComplete } from "@/components/reading/session-complete";
import { StatusBanner } from "@/components/reading/status-banner";
import { TutorMessage } from "@/components/reading/tutor-message";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { isServiceError } from "@/lib/api/service-error";
import { createSpeechService } from "@/lib/api/speech-service";
import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DeviceKind,
  DevicePermissionSnapshotUI,
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
import {
  normalizeReadingToken,
  SequentialReadingTracker,
  type RecognitionWordEvidence,
} from "@/lib/utils/sequential-reading-alignment";
import { getReadingWordConfidenceThreshold } from "@/lib/utils/reading-confidence";
import {
  MAX_REVIEW_ATTEMPTS,
  SessionReviewQueue,
  type SessionReviewQueueSnapshot,
  type SessionReviewItem,
} from "@/lib/utils/session-review-queue";
import type { SpeechTranscript } from "@/lib/api/speech-service";

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
  permissions: DevicePermissionSnapshotUI;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: ReadingScreenData }
  | { status: "not-found" }
  | { status: "error" };
interface BrowserSpeechAlternative {
  transcript: string;
  confidence?: number;
}

interface BrowserSpeechResult {
  isFinal: boolean;
  [index: number]: BrowserSpeechAlternative;
}

interface ReviewAttempt {
  readonly reviewId: string;
  readonly sequence: number;
  readonly results: SpeechTranscript[];
  queue: Promise<void>;
  interval: ReturnType<typeof setInterval> | null;
  stopping: boolean;
  sttFailed: boolean;
  readonly abortController: AbortController;
  deadlineMs: number;
}

interface BrowserSpeechEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: BrowserSpeechResult;
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
  const wordConfidenceThreshold = useMemo(
    () => getReadingWordConfidenceThreshold(),
    [],
  );
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
  const [, setFinalTranscript] = useState("");
  const [, setIsComparing] = useState(false);
  const [, setComparisonResult] = useState<ComparisonResult | null>(null);
  const [, setComparisonError] = useState<string | null>(null);
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isReadingWord, setIsReadingWord] = useState(false);
  const [correctWordIds, setCorrectWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mispronouncedWordIds, setMispronouncedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [reviewedWordIds, setReviewedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isReviewingWords, setIsReviewingWords] = useState(false);
  const [uncertainWordIds, setUncertainWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isSessionReviewing, setIsSessionReviewing] = useState(false);
  const [isReviewPaused, setIsReviewPaused] = useState(false);
  const [reviewQueueSnapshot, setReviewQueueSnapshot] =
    useState<SessionReviewQueueSnapshot>({
      items: [],
      pendingCount: 0,
      completedCount: 0,
      current: null,
      total: 0,
    });
  const [reviewActivity, setReviewActivity] =
    useState<EndReviewActivity>("ready");
  const [reviewSecondsRemaining, setReviewSecondsRemaining] = useState<
    number | null
  >(null);
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [reviewedCorrectWordIds, setReviewedCorrectWordIds] = useState<
    Set<string>
  >(() => new Set());
  const [assistedWordIds, setAssistedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [sessionSummary, setSessionSummary] =
    useState<ReadingCompletionSummaryUI | null>(null);
  const spokenWordsSetRef = useRef<Set<string>>(new Set());
  const correctWordIdsRef = useRef<Set<string>>(new Set());
  const failedWordIdsRef = useRef<Set<string>>(new Set());
  const uncertainWordIdsRef = useRef<Set<string>>(new Set());
  const reviewedCorrectWordIdsRef = useRef<Set<string>>(new Set());
  const assistedWordIdsRef = useRef<Set<string>>(new Set());
  const sessionStartedAtMsRef = useRef<number>(Date.now());
  const persistedReviewEventKeysRef = useRef<Set<string>>(new Set());
  const sessionReviewQueueRef = useRef(new SessionReviewQueue());
  const reviewAttemptRef = useRef<ReviewAttempt | null>(null);
  const reviewSequenceRef = useRef(0);
  const transcriptsListRef = useRef<string[]>([]);
  const wordTextByIdRef = useRef<Map<string, string>>(new Map());
  const finishStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isListeningActiveRef = useRef(false);
  const isStoppingRecognitionRef = useRef(false);
  const trackerRef = useRef<SequentialReadingTracker | null>(null);
  const utteranceSequenceRef = useRef(0);
  const utteranceEventIdsRef = useRef(new WeakMap<Blob, string>());
  const browserRecognitionEpochRef = useRef(0);
  const recognitionQueueRef = useRef<Promise<void>>(Promise.resolve());

  const startListeningRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const isUsingRecorderRef = useRef(false);

  const resetPageTracking = useCallback(
    (nextPage: ReadingPageDTO) => {
      trackerRef.current = new SequentialReadingTracker(
        nextPage.page_id,
        nextPage.page_revision_id,
        nextPage.words,
        {
          deferReviewUntilSessionEnd: true,
          minWordConfidence: wordConfidenceThreshold,
          requireWordConfidence: true,
        },
      );
      utteranceSequenceRef.current = 0;
      for (const word of nextPage.words) {
        wordTextByIdRef.current.set(word.word_id, word.text);
        // Revisiting a page starts a fresh first pass for these exact token IDs.
        // Do not let an earlier attempt inflate this session's final score.
        correctWordIdsRef.current.delete(word.word_id);
        failedWordIdsRef.current.delete(word.word_id);
        uncertainWordIdsRef.current.delete(word.word_id);
        reviewedCorrectWordIdsRef.current.delete(word.word_id);
        assistedWordIdsRef.current.delete(word.word_id);
      }
      setCurrentWordId(nextPage.words[0]?.word_id ?? null);
      setCorrectWordIds(new Set());
      setMispronouncedWordIds(new Set());
      setReviewedWordIds(new Set());
      setUncertainWordIds(new Set());
      setIsReviewingWords(false);
    },
    [wordConfidenceThreshold],
  );

  const activatePage = useCallback(
    (nextPage: ReadingPageDTO) => {
      setPage(nextPage);
      resetPageTracking(nextPage);
    },
    [resetPageTracking],
  );

  const collectCurrentPageReviewCandidates = useCallback(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    const pageOrder =
      pageProgress?.pages.find((item) => item.page_id === tracker.pageId)
        ?.page_order ??
      pageProgress?.current_index ??
      0;
    sessionReviewQueueRef.current.replacePageCandidates(
      tracker.getReviewCandidates(),
      pageOrder,
      tracker.pageId,
      tracker.pageRevisionId,
    );
    setReviewQueueSnapshot(sessionReviewQueueRef.current.snapshot());
  }, [pageProgress]);

  const recordSpokenText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const transcripts = transcriptsListRef.current;
    transcripts.push(trimmed);

    const words = trimmed
      .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'“”—]/g, "")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

    for (const w of words) {
      spokenWordsSetRef.current.add(w);
    }
  }, []);

  const handleWordClick = useCallback(
    async (word: ReadingPageWordDTO) => {
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
      const activeReviewAttempt = reviewAttemptRef.current;
      if (activeReviewAttempt && activeReviewAttempt.interval !== null) {
        clearInterval(activeReviewAttempt.interval);
      }
      reviewAttemptRef.current = null;
      activeReviewAttempt?.abortController.abort();
      try {
        recognitionRef.current?.abort?.();
      } catch {
        // Safe ignore
      }
    };
  }, []);

  useEffect(() => {
    if (countdown === null || uiState !== "reading") return;
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
  }, [countdown, uiState]);

  useEffect(() => {
    if (!page) return;
    for (const word of page.words) {
      wordTextByIdRef.current.set(word.word_id, word.text);
    }
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
          permissions,
          completion,
          initialProgress,
        ] = await Promise.all([
          services.bookService.get(session.book_id),
          services.childService.get(session.child_id),
          services.readingService.getCurrentPage(sessionId),
          services.bookService.listPages(session.book_id),
          services.devicePermissionService.getSnapshot(),
          services.readingService.getCompletionSummary(sessionId),
          services.readingService.getPageProgress(sessionId),
        ]);

        // Server-side progress is authoritative on reload. A stale pageId query
        // must not reset a session that was already advanced to another page.
        const requestedPageIsOutsideRange =
          Boolean(initialPageId) &&
          !initialProgress.pages.some((item) => item.page_id === initialPageId);

        if (!active) return;
        const sessionStart = Date.parse(session.started_at);
        if (Number.isFinite(sessionStart)) {
          sessionStartedAtMsRef.current = sessionStart;
        }

        activatePage(currentPage);
        setPageProgress(initialProgress);
        setPageNavigationError(
          requestedPageIsOutsideRange
            ? "Trang từ liên kết không thuộc phạm vi buổi đọc. Đã khôi phục trang hiện tại đã lưu."
            : null,
        );
        setSelectedManualPageId(currentPage.page_id);
        setCanonicalState(session.state);
        setLoadState({
          status: "ready",
          data: { book, child, completion, pagePreviews, permissions },
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
  }, [activatePage, initialPageId, loadKey, services, sessionId]);

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
        collectCurrentPageReviewCandidates();
        activatePage(matchedPage);
        setPageProgress(progress);
        setPageNavigationError(null);
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
    activatePage,
    collectCurrentPageReviewCandidates,
  ]);

  function commitRecognizedTranscript(
    eventId: string,
    spokenText: string,
    expectedTracker?: SequentialReadingTracker,
    evidenceWords?: readonly RecognitionWordEvidence[] | null,
  ) {
    const tracker = trackerRef.current;
    if (
      !tracker ||
      (expectedTracker !== undefined && tracker !== expectedTracker) ||
      !spokenText.trim()
    ) {
      return;
    }

    const result = tracker.commitFinal(eventId, spokenText, evidenceWords);
    if (result.duplicate) return;

    for (const wordId of result.correctWordIds) {
      correctWordIdsRef.current.add(wordId);
      failedWordIdsRef.current.delete(wordId);
      uncertainWordIdsRef.current.delete(wordId);
    }
    for (const wordId of result.needsReviewWordIds) {
      correctWordIdsRef.current.delete(wordId);
      failedWordIdsRef.current.add(wordId);
      uncertainWordIdsRef.current.delete(wordId);
    }
    for (const wordId of result.uncertainWordIds) {
      correctWordIdsRef.current.delete(wordId);
      failedWordIdsRef.current.delete(wordId);
      uncertainWordIdsRef.current.add(wordId);
    }

    setCurrentWordId(result.currentWordId);
    setCorrectWordIds(new Set(result.correctWordIds));
    setMispronouncedWordIds(new Set(result.needsReviewWordIds));
    setUncertainWordIds(new Set(result.uncertainWordIds));
    setReviewedWordIds(new Set(result.reviewedWordIds));
    setIsReviewingWords(false);
    recordSpokenText(spokenText);
  }

  function commitUncertainRecognition(
    eventId: string,
    expectedTracker: SequentialReadingTracker,
    reason: "NO_SPEECH" | "UNCERTAIN",
  ) {
    const tracker = trackerRef.current;
    if (!tracker || tracker !== expectedTracker) return;
    const result = tracker.markNoSpeech(eventId, reason);
    if (result.duplicate) return;
    for (const wordId of result.uncertainWordIds) {
      correctWordIdsRef.current.delete(wordId);
      failedWordIdsRef.current.delete(wordId);
      uncertainWordIdsRef.current.add(wordId);
    }
    setCurrentWordId(result.currentWordId);
    setCorrectWordIds(new Set(result.correctWordIds));
    setMispronouncedWordIds(new Set(result.needsReviewWordIds));
    setUncertainWordIds(new Set(result.uncertainWordIds));
    setReviewedWordIds(new Set(result.reviewedWordIds));
    setIsReviewingWords(false);
  }

  function enqueueRecordedUtterance(utteranceBlob: Blob) {
    const tracker = trackerRef.current;
    if (!tracker || utteranceBlob.size <= 800) return;
    let eventId = utteranceEventIdsRef.current.get(utteranceBlob);
    if (!eventId) {
      eventId = [
        "media-recorder",
        sessionId,
        tracker.pageId,
        tracker.pageRevisionId,
        ++utteranceSequenceRef.current,
      ].join(":");
      utteranceEventIdsRef.current.set(utteranceBlob, eventId);
    }

    const pending = recognitionQueueRef.current.then(async () => {
      if (!mountedRef.current || !isListeningActiveRef.current) return;
      try {
        const transcript = await speechService.transcribe(utteranceBlob, {
          languageCode: "vi",
        });
        if (!mountedRef.current || !isListeningActiveRef.current) return;
        const finalText = transcript.text.trim();
        if (finalText) {
          setLatestTranscript(finalText);
          commitRecognizedTranscript(
            eventId,
            finalText,
            tracker,
            transcript.words,
          );
        } else {
          commitUncertainRecognition(eventId, tracker, "NO_SPEECH");
        }
      } catch (error) {
        commitUncertainRecognition(eventId, tracker, "UNCERTAIN");
        console.warn("Live ElevenLabs STT utterance notice:", error);
      }
    });
    recognitionQueueRef.current = pending.catch((error: unknown) => {
      console.warn("Speech alignment queue failed:", error);
    });
  }

  async function startListening(): Promise<boolean> {
    setLatestTranscript(null);
    setComparisonResult(null);
    setComparisonError(null);
    setIsComparing(false);
    isListeningActiveRef.current = true;
    isStoppingRecognitionRef.current = false;
    isUsingRecorderRef.current = false;

    // MediaRecorder utterances are the authoritative final STT stream.
    try {
      await speechRecorder.start(enqueueRecordedUtterance);
      isUsingRecorderRef.current = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("not supported")) {
        isListeningActiveRef.current = false;
        if (mountedRef.current) {
          setConnectionState("reconnecting");
          setUiState("microphone-denied");
        }
        return false;
      }
      if (mountedRef.current) setLatestTranscript(null);
      // Continue to the browser SpeechRecognition fallback below.
    }

    // Browser SpeechRecognition is only a fallback. Starting it beside
    // MediaRecorder would open a second microphone capture pipeline.
    let hasSpeechInput = isUsingRecorderRef.current;
    if (!isUsingRecorderRef.current && typeof window !== "undefined") {
      try {
        const win = window as unknown as WindowWithSpeech;
        const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
        if (SpeechRec) {
          const rec = new SpeechRec();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = "vi-VN";
          rec.maxAlternatives = 1;

          let recognitionEpoch = ++browserRecognitionEpochRef.current;
          rec.onresult = (event: BrowserSpeechEvent) => {
            let latestWord = "";
            let fullLive = "";

            for (let i = 0; i < event.results.length; ++i) {
              const part = event.results[i][0]?.transcript || "";
              if (part.trim()) {
                fullLive += (fullLive ? " " : "") + part.trim();
              }
            }

            for (let i = event.resultIndex; i < event.results.length; ++i) {
              const part = event.results[i][0]?.transcript || "";
              if (part.trim()) {
                latestWord += (latestWord ? " " : "") + part.trim();
              }
            }

            const currentWord = latestWord.trim() || fullLive.trim();
            if (currentWord && mountedRef.current) {
              // Interim recognition is display-only while MediaRecorder is active.
              setLatestTranscript(currentWord);
            }

            if (!isUsingRecorderRef.current && isListeningActiveRef.current) {
              for (let i = event.resultIndex; i < event.results.length; ++i) {
                const result = event.results[i];
                const finalText = result[0]?.transcript?.trim();
                if (!result.isFinal || !finalText) continue;
                const activeTracker = trackerRef.current;
                if (!activeTracker) continue;
                const finalEventId = [
                  "web-speech",
                  sessionId,
                  activeTracker.pageId,
                  activeTracker.pageRevisionId,
                  recognitionEpoch,
                  i,
                ].join(":");
                // Browser SpeechRecognition confidence is phrase-level, not word-aligned.
                // Keep the event UNCERTAIN instead of copying one score to every token.
                commitRecognizedTranscript(
                  finalEventId,
                  finalText,
                  activeTracker,
                  null,
                );
              }
            }
          };

          rec.onerror = (event: BrowserSpeechErrorEvent) => {
            // Browser recognition remains a preview source when MediaRecorder is active.
            // Without MediaRecorder, only browser results marked isFinal are committed.
            console.warn("Browser SpeechRecognition notice:", event?.error);
          };

          rec.onend = () => {
            if (
              mountedRef.current &&
              isListeningActiveRef.current &&
              !isStoppingRecognitionRef.current
            ) {
              setTimeout(() => {
                if (
                  mountedRef.current &&
                  isListeningActiveRef.current &&
                  !isStoppingRecognitionRef.current
                ) {
                  try {
                    recognitionEpoch = ++browserRecognitionEpochRef.current;
                    rec.start();
                  } catch {
                    // Safe ignore
                  }
                }
              }, 200);
            }
          };

          try {
            rec.start();
            recognitionRef.current = rec;
            hasSpeechInput = true;
          } catch {
            // Safe ignore if browser blocks concurrent audio capture
          }
        }
      } catch (e) {
        console.warn("SpeechRecognition initialization skipped:", e);
      }
    }

    if (!hasSpeechInput) {
      isListeningActiveRef.current = false;
      if (mountedRef.current) {
        setConnectionState("reconnecting");
        setUiState("microphone-denied");
      }
      return false;
    }

    return true;
  }

  useEffect(() => {
    startListeningRef.current = startListening;
  });

  async function stopListeningAndTranscribe() {
    isStoppingRecognitionRef.current = true;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Safe ignore
      }
      recognitionRef.current = null;
    }
    try {
      // stop() emits only the not-yet-processed tail into the same ordered queue.
      await speechRecorder.stop();
    } catch {
      speechRecorder.cancel();
    }
    await recognitionQueueRef.current;
    isListeningActiveRef.current = false;
  }

  async function handleReadSample() {
    if (isBusy && !speechPlayer.isPlaying) return;
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      setIsReadingWord(false);
      setCurrentWordId(trackerRef.current?.currentWordId ?? null);
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

    // A sample playback is not child reading evidence. Keep the authoritative
    // reading cursor fixed while the example voice is playing.

    try {
      await speechPlayer.play(fullText, {
        onEnded: () => {
          if (!mountedRef.current) return;
          setIsBusy(false);
          setCurrentWordId(trackerRef.current?.currentWordId ?? null);
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
    const nextState = await services.readingSocketAdapter.sendControl(
      sessionId,
      "start",
    );
    if (!mountedRef.current) return;
    setCanonicalState(nextState);
    setConnectionState("connected");
    setUiState("reading");
    setIsMicRecording(false);
    //Set lại ghi âm mới
    transcriptsListRef.current = [];

    setLatestTranscript("");
    setFinalTranscript("");
    setComparisonResult(null);
    setComparisonError(null);
    setIsComparing(false);
    setIsBusy(false);
    setIsReviewPaused(false);
    setCountdown(3);
    if (page) resetPageTracking(page);
    correctWordIdsRef.current.clear();
    failedWordIdsRef.current.clear();
    spokenWordsSetRef.current.clear();
    setCorrectWordIds(new Set());
    setMispronouncedWordIds(new Set());
    setReviewedWordIds(new Set());
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
    setCountdown(null);

    // Invalidate a pending permission/countdown start before pausing.
    if (!isMicRecording) {
      isListeningActiveRef.current = false;
      speechRecorder.cancel();
    }
    if (isMicRecording) {
      try {
        await stopListeningAndTranscribe();
      } catch {
        speechRecorder.cancel();
      }
      if (mountedRef.current) setIsMicRecording(false);
    }
    if (!mountedRef.current) return;

    const nextState = await services.readingSocketAdapter
      .sendControl(sessionId, "pause")
      .catch(() => "PAUSED" as const);
    if (!mountedRef.current) return;
    isListeningActiveRef.current = false;
    setCanonicalState(nextState);
    setUiState("paused");
    setIsBusy(false);
  }

  async function retryPermission(kind: DeviceKind) {
    if (isBusy) return;
    setIsBusy(true);
    await services.devicePermissionService.retry(kind);
    if (!mountedRef.current) return;
    if (kind === "microphone" && !(await startListening())) {
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
      collectCurrentPageReviewCandidates();
      setPageProgress(nextProgress);
      activatePage(nextPage);
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
    collectCurrentPageReviewCandidates();
    activatePage(matchedPage);
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
    collectCurrentPageReviewCandidates();
    activatePage(matchedPage);
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

  function enqueueReviewUtterance(attempt: ReviewAttempt, audio: Blob) {
    if (audio.size <= 800 || reviewAttemptRef.current !== attempt) return;

    const pending = attempt.queue.then(async () => {
      if (!mountedRef.current || reviewAttemptRef.current !== attempt) return;
      try {
        const transcript = await speechService.transcribe(audio, {
          languageCode: "vi",
          signal: attempt.abortController.signal,
        });
        // Do not discard a final response just because the 3-second capture
        // window elapsed. It is consumed after speechRecorder.stop() settles.
        if (!mountedRef.current || reviewAttemptRef.current !== attempt) return;
        attempt.results.push(transcript);
        if (transcript.text.trim()) {
          recordSpokenText(transcript.text);
          setLatestTranscript(transcript.text.trim());
        }
      } catch (error) {
        attempt.sttFailed = true;
        console.warn("Review STT notice:", error);
      }
    });

    attempt.queue = pending.catch((error: unknown) => {
      attempt.sttFailed = true;
      console.warn("Review STT queue notice:", error);
    });
  }

  function updateReviewQueueSnapshot() {
    const snapshot = sessionReviewQueueRef.current.snapshot();
    setReviewQueueSnapshot(snapshot);
    return snapshot;
  }

  async function completeCurrentReviewItem(
    item: SessionReviewItem,
    result: "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_SPEECH",
    confidence: number | null,
  ) {
    const attemptResult = sessionReviewQueueRef.current.recordAttempt(
      item.reviewId,
      result,
      confidence,
    );
    if (!attemptResult.accepted || !attemptResult.item) return;

    if (result === "CORRECT") {
      reviewedCorrectWordIdsRef.current.add(item.wordId);
      if (item.reason !== "CONFIDENTLY_INCORRECT") {
        uncertainWordIdsRef.current.delete(item.wordId);
        setUncertainWordIds(new Set(uncertainWordIdsRef.current));
      }
      setReviewedCorrectWordIds(new Set(reviewedCorrectWordIdsRef.current));
      setReviewFeedback("Rất tốt! Sang từ tiếp theo nào.");
    } else if (attemptResult.needsAssistance) {
      setReviewActivity("assisting");
      setReviewFeedback("Mình nghe mẫu trước nhé.");
      try {
        // The word is marked assisted only after the existing TTS service
        // successfully returns playable audio.
        speechPlayer.stop();
        await new Promise<void>((resolve, reject) => {
          speechPlayer
            .play(item.expectedWord, {
              onEnded: resolve,
              onError: () =>
                reject(new Error("Reference pronunciation playback failed.")),
              onStopped: () =>
                reject(new Error("Reference pronunciation playback was stopped.")),
            })
            .catch(reject);
        });
        if (!mountedRef.current) return;
        sessionReviewQueueRef.current.markAssisted(item.reviewId);
        if (item.reason !== "CONFIDENTLY_INCORRECT") {
          uncertainWordIdsRef.current.delete(item.wordId);
          setUncertainWordIds(new Set(uncertainWordIdsRef.current));
        }
        assistedWordIdsRef.current.add(item.wordId);
        setAssistedWordIds(new Set(assistedWordIdsRef.current));
        setReviewFeedback("Mình đã nghe mẫu cùng nhau. Sang từ tiếp theo nhé!");
      } catch {
        sessionReviewQueueRef.current.markUnresolved(item.reviewId);
        if (item.reason !== "CONFIDENTLY_INCORRECT") {
          uncertainWordIdsRef.current.add(item.wordId);
          setUncertainWordIds(new Set(uncertainWordIdsRef.current));
        }
        setReviewFeedback(
          "Mình chưa phát được âm mẫu. Mình chuyển sang từ tiếp theo nhé.",
        );
      }
    } else if (result === "NO_SPEECH") {
      setReviewFeedback("Mình chưa nghe thấy. Con thử lại nhé!");
    } else if (result === "UNCERTAIN") {
      setReviewFeedback("Mình nghe chưa rõ. Con thử lại nhé!");
    } else {
      setReviewFeedback("Con thử lại nhé!");
    }

    const nextSnapshot = updateReviewQueueSnapshot();
    if (nextSnapshot.current) {
      setReviewActivity("ready");
      setReviewSecondsRemaining(null);
      return;
    }

    // The queue is session-scoped and ordered by page_order + word_index.
    // Only now may the existing finish/history API flow run.
    reviewAttemptRef.current = null;
    setReviewActivity("ready");
    setReviewSecondsRemaining(null);
    setIsBusy(true);
    setIsSessionReviewing(false);
    await finalizeReadingSession();
  }

  function classifyReviewRecognition(
    item: SessionReviewItem,
    attempt: ReviewAttempt,
  ): {
    result: "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_SPEECH";
    confidence: number | null;
  } {
    const usable = attempt.results.filter((result) => result.text.trim());
    if (!usable.length) {
      return {
        result: attempt.sttFailed ? "UNCERTAIN" : "NO_SPEECH",
        confidence: null,
      };
    }

    // Multiple short utterances can occur inside the listening window. A
    // confidently recognized target word wins; otherwise use the latest
    // confidently recognized single-word result.
    let latestConfidentMismatch: number | null = null;
    for (const result of usable) {
      const spokenTokens = result.text
        .normalize("NFC")
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      const wordEvidence = result.words;
      if (
        spokenTokens.length !== 1 ||
        !wordEvidence ||
        wordEvidence.length !== 1 ||
        normalizeReadingToken(wordEvidence[0].text) !==
          normalizeReadingToken(spokenTokens[0]) ||
        typeof wordEvidence[0].logprob !== "number" ||
        wordConfidenceThreshold === null
      ) {
        continue;
      }

      const confidence = Math.exp(wordEvidence[0].logprob);
      if (
        !Number.isFinite(confidence) ||
        confidence < wordConfidenceThreshold ||
        confidence > 1
      ) {
        continue;
      }

      if (
        normalizeReadingToken(spokenTokens[0]) ===
        normalizeReadingToken(item.expectedWord)
      ) {
        return { result: "CORRECT", confidence };
      }
      latestConfidentMismatch = confidence;
    }

    return latestConfidentMismatch === null
      ? { result: "UNCERTAIN", confidence: null }
      : { result: "INCORRECT", confidence: latestConfidentMismatch };
  }

  async function stopReviewAttempt(attempt: ReviewAttempt) {
    if (reviewAttemptRef.current !== attempt || attempt.stopping) {
      return;
    }

    attempt.stopping = true;
    if (attempt.interval !== null) {
      clearInterval(attempt.interval);
      attempt.interval = null;
    }
    setReviewSecondsRemaining(0);
    setReviewActivity("processing");
    setReviewFeedback("Mình đang kiểm tra lời đọc…");

    try {
      // stop() emits only the unprocessed final tail. Await both stop and the
      // serialized STT queue so a delayed valid final transcript is not lost.
      await speechRecorder.stop();
    } catch {
      attempt.sttFailed = true;
      speechRecorder.cancel();
    }
    await attempt.queue;

    if (!mountedRef.current || reviewAttemptRef.current !== attempt) {
      return;
    }

    const current = sessionReviewQueueRef.current.getCurrent();
    if (!current || current.reviewId !== attempt.reviewId) {
      reviewAttemptRef.current = null;
      return;
    }

    const classified = classifyReviewRecognition(current, attempt);
    reviewAttemptRef.current = null;
    await completeCurrentReviewItem(
      current,
      classified.result,
      classified.confidence,
    );
  }

  async function startReviewAttempt() {
    const item = sessionReviewQueueRef.current.getCurrent();
    if (
      !item ||
      reviewAttemptRef.current ||
      item.attempts >= MAX_REVIEW_ATTEMPTS ||
      !mountedRef.current
    ) {
      return;
    }

    const attempt: ReviewAttempt = {
      reviewId: item.reviewId,
      sequence: ++reviewSequenceRef.current,
      results: [],
      queue: Promise.resolve(),
      interval: null,
      stopping: false,
      sttFailed: false,
      abortController: new AbortController(),
      deadlineMs: 0,
    };
    reviewAttemptRef.current = attempt;
    setReviewActivity("processing");
    setReviewSecondsRemaining(null);
    setReviewFeedback("Mình đang chuẩn bị micro…");

    try {
      await speechRecorder.start((audio) =>
        enqueueReviewUtterance(attempt, audio),
      );
      // Permission prompts can resolve after this screen has unmounted or the
      // review item has been invalidated. Never arm a countdown for a stale attempt.
      if (!mountedRef.current || reviewAttemptRef.current !== attempt) {
        speechRecorder.cancel();
        attempt.abortController.abort();
        return;
      }
    } catch (error) {
      attempt.sttFailed = true;
      console.warn("Could not start the review microphone:", error);
      await stopReviewAttempt(attempt);
      return;
    }

    // Start the child-facing 3-second window only after the microphone is ready.
    attempt.deadlineMs = Date.now() + 3_000;
    setReviewActivity("listening");
    setReviewSecondsRemaining(3);
    setReviewFeedback("Con cứ đọc nhé!");

    // The deadline ends capture, not recognition processing. A final STT
    // request that is still running is awaited after stop() has emitted its tail.
    attempt.interval = setInterval(() => {
      if (
        !mountedRef.current ||
        reviewAttemptRef.current !== attempt ||
        attempt.stopping
      ) {
        return;
      }
      const remainingMs = attempt.deadlineMs - Date.now();
      setReviewSecondsRemaining(Math.max(0, Math.ceil(remainingMs / 1_000)));
      if (remainingMs <= 0) {
        void stopReviewAttempt(attempt);
      }
    }, 100);
  }


  async function pauseSessionReview(): Promise<boolean> {
    if (reviewActivity === "processing" || reviewActivity === "assisting") {
      return false;
    }

    const attempt = reviewAttemptRef.current;
    if (attempt) {
      if (attempt.interval !== null) {
        clearInterval(attempt.interval);
        attempt.interval = null;
      }
      attempt.abortController.abort();
      reviewAttemptRef.current = null;
      await attempt.queue;
    }

    speechRecorder.cancel();
    speechPlayer.stop();
    const failedWrites = await persistSessionReviewEvents();
    const nextState = await services.readingSocketAdapter
      .sendControl(sessionId, "pause")
      .catch(() => "PAUSED" as const);
    if (!mountedRef.current) return false;

    setCanonicalState(nextState);
    setIsMicRecording(false);
    setReviewActivity("ready");
    setReviewSecondsRemaining(null);
    setReviewFeedback(
      failedWrites > 0
        ? "Đã tạm dừng. Một số kết quả chưa lưu được; bé có thể thử lại sau."
        : "Đã tạm dừng. Bé có thể tiếp tục khi sẵn sàng.",
    );
    setIsSessionReviewing(false);
    setIsReviewPaused(true);
    setUiState("paused");
    return true;
  }

  async function resumeSessionReview() {
    if (isBusy) return;
    setIsBusy(true);
    const nextState = await services.readingSocketAdapter
      .sendControl(sessionId, "resume")
      .catch(() => "LISTENING" as const);
    if (!mountedRef.current) return;

    setCanonicalState(nextState);
    setUiState("reading");
    setIsReviewPaused(false);
    setIsSessionReviewing(true);
    setReviewActivity("ready");
    setReviewSecondsRemaining(null);
    setIsBusy(false);
  }

  async function requestExitSessionReview() {
    const paused = await pauseSessionReview();
    if (paused && mountedRef.current) setConfirmFinish(true);
  }

  async function exitSessionReview() {
    const attempt = reviewAttemptRef.current;
    if (attempt) {
      if (attempt.interval !== null) {
        clearInterval(attempt.interval);
        attempt.interval = null;
      }
      attempt.abortController.abort();
      reviewAttemptRef.current = null;
      await attempt.queue;
    }

    speechRecorder.cancel();
    speechPlayer.stop();
    isListeningActiveRef.current = false;
    if (!mountedRef.current) return;

    setCountdown(null);
    setIsMicRecording(false);
    setIsReviewPaused(false);
    setIsSessionReviewing(false);
    setIsBusy(true);
    await finalizeReadingSession();
  }

  function toReadingEventStartMs(timestamp: number): number {
    // The current PostgreSQL ReadingEvents.StartMs contract is SMALLINT.
    // Preserve the full elapsed value in metadata while clamping this legacy field.
    const elapsed = Math.max(
      0,
      Math.round(timestamp - sessionStartedAtMsRef.current),
    );
    return Math.min(32_767, elapsed);
  }

  async function persistSessionReviewEvents(): Promise<number> {
    const items = sessionReviewQueueRef.current.snapshot().items;
    let failedWrites = 0;

    for (const item of items) {
      const firstPassKey = `${item.reviewId}:first-pass`;
      if (!persistedReviewEventKeysRef.current.has(firstPassKey)) {
        try {
          await services.readingService.createEvent({
            SessionId: sessionId,
            PageId: item.pageId,
            PageRevisionId: item.pageRevisionId,
            WordId: item.wordId,
            Type: "MISPRONUNCIATION",
            StartMs: toReadingEventStartMs(item.occurredAtMs),
            EndMs: null,
            Confidence: item.confidence,
            Status:
              item.reason === "CONFIDENTLY_INCORRECT"
                ? "DETECTED"
                : "IGNORED_BY_GATE",
            Metadata: {
              source: "SEQUENTIAL_READING_ALIGNMENT",
              reason: item.reason,
              expected_word: item.expectedWord,
              recognized_word: item.recognizedWord,
              page_order: item.pageOrder,
              word_index: item.wordIndex,
              occurred_at_ms: item.occurredAtMs,
            },
          });
          persistedReviewEventKeysRef.current.add(firstPassKey);
        } catch (error) {
          failedWrites += 1;
          console.warn("Could not persist first-pass reading event:", error);
        }
      }

      const reviewResolutionKey = `${item.reviewId}:review-resolution`;
      if (
        (item.resolution === "REVIEWED_CORRECT" ||
          item.resolution === "ASSISTED") &&
        !persistedReviewEventKeysRef.current.has(reviewResolutionKey)
      ) {
        try {
          await services.readingService.createEvent({
            SessionId: sessionId,
            PageId: item.pageId,
            PageRevisionId: item.pageRevisionId,
            WordId: item.wordId,
            Type:
              item.resolution === "REVIEWED_CORRECT"
                ? "SELF_CORRECTION"
                : "READ_EXAMPLE",
            StartMs: toReadingEventStartMs(Date.now()),
            EndMs: null,
            Confidence:
              item.resolution === "REVIEWED_CORRECT"
                ? (item.lastReviewConfidence ?? null)
                : null,
            Status: "FEEDBACK_GIVEN",
            Metadata: {
              source: "END_OF_SESSION_WORD_REVIEW",
              resolution: item.resolution,
              attempts: item.attempts,
              original_reason: item.reason,
            },
          });
          persistedReviewEventKeysRef.current.add(reviewResolutionKey);
        } catch (error) {
          failedWrites += 1;
          console.warn("Could not persist end-review outcome:", error);
        }
      }
    }

    return failedWrites;
  }

  async function finalizeReadingSession() {
    try {
      const failedEventWrites = await persistSessionReviewEvents();
      const combinedTranscript = transcriptsListRef.current.join(" ").trim();
      setFinalTranscript(combinedTranscript);

      if (combinedTranscript) {
        setIsComparing(true);
        setComparisonError(null);
        setComparisonResult(null);
        try {
          const result = await compareTranscript(sessionId, combinedTranscript);
          if (!mountedRef.current) return;
          setComparisonResult(result);
        } catch (error) {
          console.error("Lỗi so sánh bài đọc:", error);
          if (mountedRef.current) {
            setComparisonError(
              error instanceof Error
                ? error.message
                : "Không thể so sánh bài đọc.",
            );
          }
        } finally {
          if (mountedRef.current) setIsComparing(false);
        }
      }

      if (!mountedRef.current) return;

      const [finishedSession] = await Promise.all([
        services.readingService.finish(sessionId),
        services.readingSocketAdapter.sendControl(sessionId, "finish"),
      ]);
      if (!mountedRef.current) return;

      const wordsList = Array.from(spokenWordsSetRef.current);
      const durationMinutes = getDurationMinutes(finishedSession.duration_ms);
      const persistedCompletion = await services.readingService
        .getCompletionSummary(sessionId)
        .catch(() => null);

      const correctWordsList = Array.from(correctWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));
      const mispronouncedWordsList = Array.from(failedWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));
      const reviewedWordsList = Array.from(reviewedCorrectWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));
      const assistedWordsList = Array.from(assistedWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));
      const uncertainWordsList = Array.from(uncertainWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));

      // One token occurrence contributes at most once to each first-pass set.
      // Review success and model assistance are reported separately and do not
      // inflate independent first-pass accuracy.
      const totalEvaluated =
        correctWordIdsRef.current.size + failedWordIdsRef.current.size;
      const score =
        totalEvaluated > 0
          ? Math.round((correctWordIdsRef.current.size / totalEvaluated) * 100)
          : null;
      const uniqueOccurrences = new Set([
        ...correctWordIdsRef.current,
        ...failedWordIdsRef.current,
        ...uncertainWordIdsRef.current,
        ...reviewedCorrectWordIdsRef.current,
        ...assistedWordIdsRef.current,
      ]);

      const updatedSummary: ReadingCompletionSummaryUI = {
        correct_words: correctWordsList,
        reviewed_correct_words: reviewedWordsList,
        assisted_words: assistedWordsList,
        uncertain_words: uncertainWordsList,
        result_persistence_warning:
          failedEventWrites > 0
            ? `Chưa lưu được ${failedEventWrites} sự kiện kết quả vào lịch sử. Kết quả vừa đọc vẫn được hiển thị trong buổi này.`
            : null,
        duration_minutes: durationMinutes,
        mispronounced_words: mispronouncedWordsList,
        pages_explored:
          persistedCompletion?.pages_explored ??
          (pageProgress?.persisted ? pageProgress.completed_pages : null),
        selected_range_pages:
          persistedCompletion?.selected_range_pages ??
          (pageProgress?.persisted ? pageProgress.total_pages : null),
        practiced_words: uniqueOccurrences.size,
        score,
        spoken_words: wordsList,
        transcripts: [...transcriptsListRef.current],
      };

      setSessionSummary(updatedSummary);
      setCanonicalState(finishedSession.state);
      setConfirmFinish(false);
      setIsSessionReviewing(false);
      setUiState("complete");
    } catch (error) {
      console.error("Lỗi khi kết thúc buổi đọc:", error);
      finishStartedRef.current = false;
      setIsSessionReviewing(false);
      setConfirmFinish(true);
    } finally {
      if (mountedRef.current) {
        setIsComparing(false);
        setIsBusy(false);
      }
    }
  }

  async function finishReading() {
    if (finishStartedRef.current) return;
    finishStartedRef.current = true;
    setIsBusy(true);
    setCountdown(null);
    if (!isMicRecording) {
      isListeningActiveRef.current = false;
      speechRecorder.cancel();
    }
    speechPlayer.stop();

    try {
      if (isMicRecording) {
        try {
          await stopListeningAndTranscribe();
        } catch (error) {
          console.error("Lỗi khi dừng ghi âm:", error);
          speechRecorder.cancel();
        }
        if (mountedRef.current) setIsMicRecording(false);
      }

      if (!mountedRef.current) return;

      // Include errors from every already-read page and the final current page.
      collectCurrentPageReviewCandidates();
      const snapshot = sessionReviewQueueRef.current.snapshot();
      setReviewQueueSnapshot(snapshot);
      setConfirmFinish(false);

      if (snapshot.current) {
        setIsBusy(false);
        setIsSessionReviewing(true);
        setReviewActivity("ready");
        setReviewSecondsRemaining(null);
        setReviewFeedback("Con cùng đọc lại nhé!");
        return;
      }

      await finalizeReadingSession();
    } catch (error) {
      console.error("Lỗi khi chuẩn bị kết thúc buổi đọc:", error);
      finishStartedRef.current = false;
      setIsBusy(false);
    }
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

  const { book, child, completion, pagePreviews, permissions } = loadState.data;
  const rangePagePreviews = pageProgress
    ? pagePreviews.filter((candidate) =>
        pageProgress.pages.some((entry) => entry.page_id === candidate.page_id),
      )
    : pagePreviews;
  const detailHref = `/books/${encodeURIComponent(book.id)}?childId=${encodeURIComponent(child.id)}`;
  const booksHref = `/books?childId=${encodeURIComponent(child.id)}`;
  const safety = services.readingSocketAdapter.getSafetySnapshot(uiState);
  const currentWord =
    page.words.find((word) => word.word_id === currentWordId)?.text ?? "đang";

  if (isSessionReviewing && reviewQueueSnapshot.current) {
    return (
      <EndOfReadingReview
        activity={reviewActivity}
        currentPosition={reviewQueueSnapshot.completedCount + 1}
        feedback={reviewFeedback}
        item={reviewQueueSnapshot.current}
        onExit={() => void requestExitSessionReview()}
        onPause={() => void pauseSessionReview()}
        onStartAttempt={() => void startReviewAttempt()}
        secondsRemaining={reviewSecondsRemaining}
        totalItems={reviewQueueSnapshot.total}
      />
    );
  }

  if (uiState === "ready") {
    return (
      <ReadingReady
        book={book}
        child={child}
        isStarting={isBusy}
        onStart={() => void startReading()}
        permissions={permissions}
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
        controlsDisabled={
          uiState !== "reading" || (isBusy && !speechPlayer.isPlaying)
        }
        correctWordIds={correctWordIds}
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
        isPageTransitioning={uiState === "page-turn"}
        isPlayingSample={speechPlayer.isPlaying && !isReadingWord}
        isReadingWord={isReadingWord}
        isSpeaking={speechRecorder.isSpeaking}
        latestTranscript={latestTranscript}
        mispronouncedWordIds={mispronouncedWordIds}
        uncertainWordIds={uncertainWordIds}
        onFinish={() => setConfirmFinish(true)}
        onHelp={() => void requestTutor()}
        onManualPage={() => setUiState("manual-page")}
        onPause={() => void pauseReading()}
        onReadSample={() => void handleReadSample()}
        onReadWord={handleReadCurrentWord}
        onToggleListening={() => void handleToggleListening()}
        onWordClick={handleWordClick}
        page={page}
        reviewedWordIds={reviewedWordIds}
      >
        {uiState === "page-turn" ? (
          <StatusBanner className="fixed left-1/2 top-20 z-40 w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2">
            Đang chuyển trang và liên kết lại từ đang đọc…
          </StatusBanner>
        ) : isReviewingWords ? (
          <StatusBanner className="fixed left-1/2 top-20 z-40 w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2">
            Bé đã đọc hết trang. Mình cùng đọc lại các từ cần ôn nhé!
          </StatusBanner>
        ) : null}
      </ReadingLayout>
      {confirmFinish ? (
        <ReadingStatusDialog
          body={
            isReviewPaused
              ? "Mình sẽ lưu phần bé đã đọc. Những từ chưa luyện xong sẽ không bị tính là bé đã đọc đúng."
              : "Mình sẽ lưu lại phần bé đã đọc. Khi nào thích, mình lại đọc cùng nhau."
          }
          closeOnEscape
          onClose={() => setConfirmFinish(false)}
          primaryAction={{
            isLoading: isBusy,
            label: "Lưu và dừng",
            onClick: () =>
              void (isReviewPaused ? exitSessionReview() : finishReading()),
          }}
          secondaryAction={{
            label: "Đọc tiếp",
            onClick: () => setConfirmFinish(false),
          }}
          title="Bé muốn nghỉ hôm nay?"
        />
      ) : uiState === "paused" ? (
        <ReadingStatusDialog
          body={
            isReviewPaused
              ? "Phần luyện từ đang được lưu tạm. Bé có thể tiếp tục đúng từ đang luyện hoặc lưu và dừng buổi đọc."
              : "Khi sẵn sàng, mình đọc tiếp nhé. Đánh giá đang tạm dừng và không tạo lỗi đọc."
          }
          closeOnEscape
          onClose={() =>
            void (isReviewPaused ? resumeSessionReview() : resumeReading())
          }
          primaryAction={{
            isLoading: isBusy,
            label: isReviewPaused ? "Tiếp tục luyện từ" : "Đọc tiếp",
            onClick: () =>
              void (isReviewPaused ? resumeSessionReview() : resumeReading()),
          }}
          secondaryAction={{
            label: isReviewPaused ? "Lưu và dừng" : "Dừng buổi đọc",
            onClick: () => setConfirmFinish(true),
          }}
          title="Bé đang nghỉ một chút"
        />
      ) : uiState === "camera-denied" ? (
        <ReadingStatusDialog
          body="Bé hãy nhờ ba mẹ bật quyền camera trong trình duyệt. Đây là trạng thái mô phỏng, camera chưa được mở."
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Thử lại",
            onClick: () => void retryPermission("camera"),
          }}
          secondaryAction={{
            label: "Chọn trang thủ công",
            onClick: () => setUiState("manual-page"),
          }}
          title="Camera chưa sẵn sàng"
        />
      ) : uiState === "microphone-denied" ? (
        <ReadingStatusDialog
          body="Nhờ ba mẹ bật quyền micro trong trình duyệt nhé. Hệ thống đang ngừng nghe và không kết luận bé đọc sai."
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Thử lại",
            onClick: () => void retryPermission("microphone"),
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
