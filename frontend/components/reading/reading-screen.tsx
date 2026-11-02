"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ServiceError } from "@/lib/api/service-error";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
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
import { SequentialReadingTracker } from "@/lib/utils/sequential-reading-alignment";

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
}

interface BrowserSpeechResult {
  isFinal: boolean;
  [index: number]: BrowserSpeechAlternative;
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
  const [isComparing, setIsComparing] = useState(false);
  const [, setComparisonResult] = useState<ComparisonResult | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
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
  const [sessionSummary, setSessionSummary] =
    useState<ReadingCompletionSummaryUI | null>(null);
  const spokenWordsSetRef = useRef<Set<string>>(new Set());
  const correctWordIdsRef = useRef<Set<string>>(new Set());
   const failedWordsSetRef = useRef<Set<string>>(new Set());
  const transcriptsListRef = useRef<string[]>([]);
  const wordTextByIdRef = useRef<Map<string, string>>(new Map());
  const finishStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isListeningActiveRef = useRef(false);
  const trackerRef = useRef<SequentialReadingTracker | null>(null);
  const utteranceSequenceRef = useRef(0);
  const browserRecognitionEpochRef = useRef(0);
  const recognitionQueueRef = useRef<Promise<void>>(Promise.resolve());

  const startListeningRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const isUsingRecorderRef = useRef(false);

  function resetPageTracking(nextPage: ReadingPageDTO) {
    trackerRef.current = new SequentialReadingTracker(
      nextPage.page_id,
      nextPage.page_revision_id,
      nextPage.words,
    );
    utteranceSequenceRef.current = 0;
    for (const word of nextPage.words) {
      wordTextByIdRef.current.set(word.word_id, word.text);
    }
    setCurrentWordId(nextPage.words[0]?.word_id ?? null);
    setCorrectWordIds(new Set());
    setMispronouncedWordIds(new Set());
    setReviewedWordIds(new Set());
  }

  function activatePage(nextPage: ReadingPageDTO) {
    setPage(nextPage);
    resetPageTracking(nextPage);
  }

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
  ]);

  function commitRecognizedTranscript(eventId: string, spokenText: string) {
    const tracker = trackerRef.current;
    if (!tracker || !spokenText.trim()) return;

    const result = tracker.commitFinal(eventId, spokenText);
    if (result.duplicate) return;

    for (const wordId of result.correctWordIds) {
      correctWordIdsRef.current.add(wordId);
    }
     if (result.mismatchWordId) {
      const failedWord = wordTextByIdRef.current.get(result.mismatchWordId);
      if (failedWord) failedWordsSetRef.current.add(failedWord);
    }

    setCurrentWordId(result.currentWordId);
    setCorrectWordIds(new Set(result.correctWordIds));
    setMispronouncedWordIds(new Set(result.needsReviewWordIds));
    setReviewedWordIds(new Set(result.reviewedWordIds));
    recordSpokenText(spokenText);
  }

  function enqueueRecordedUtterance(utteranceBlob: Blob) {
    const tracker = trackerRef.current;
    if (!tracker || utteranceBlob.size <= 800) return;
    const eventId = [
      "media-recorder",
      sessionId,
      tracker.pageId,
      tracker.pageRevisionId,
      ++utteranceSequenceRef.current,
    ].join(":");

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
          commitRecognizedTranscript(eventId, finalText);
        }
      } catch (error) {
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

    // Browser recognition is a visual preview only while MediaRecorder is active.
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
                commitRecognizedTranscript(finalEventId, finalText);
              }
            }
          };

          rec.onerror = (event: BrowserSpeechErrorEvent) => {
            // If browser speech API fails (e.g. network / Google blocked), MediaRecorder is already running
            // and ElevenLabs STT will transcribe the full audio upon pause/finish.
            console.warn("Browser SpeechRecognition notice:", event?.error);
          };

          rec.onend = () => {
            if (mountedRef.current && isListeningActiveRef.current) {
              setTimeout(() => {
                if (mountedRef.current && isListeningActiveRef.current) {
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
          } catch {
            // Safe ignore if browser blocks concurrent audio capture
          }
        }
      } catch (e) {
        console.warn("SpeechRecognition initialization skipped:", e);
      }
    }

    return true;
  }

  useEffect(() => {
    startListeningRef.current = startListening;
  });

  async function stopListeningAndTranscribe() {
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

    // The sample temporarily moves the visual focus but is not child reading
    // evidence and must not clear or commit any token status.

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
          }
        },
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
    setCountdown(3);
    if (page) resetPageTracking(page);
    correctWordIdsRef.current.clear();
    failedWordsSetRef.current.clear();
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

async function finishReading() {
  if (finishStartedRef.current) return;

  finishStartedRef.current = true;
  setIsBusy(true);
  speechPlayer.stop();

  try {
    // 1. Dừng microphone và chờ chuyển ghi âm thành văn bản
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

    // 2. Ghép transcript của tất cả các lần ghi âm
    const combinedTranscript = transcriptsListRef.current
      .join(" ")
      .trim();

    setFinalTranscript(combinedTranscript);

    // 3. So sánh transcript đúng một lần khi bé đọc xong
    if (combinedTranscript) {
      setIsComparing(true);
      setComparisonError(null);
      setComparisonResult(null);

      try {
        const result = await compareTranscript(
          sessionId,
          combinedTranscript,
        );

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
        if (mountedRef.current) {
          setIsComparing(false);
        }
      }
    }

    if (!mountedRef.current) return;

    // 4. Kết thúc session
    const [finishedSession] = await Promise.all([
      services.readingService.finish(sessionId),
      services.readingSocketAdapter.sendControl(
        sessionId,
        "finish",
      ),
    ]);

    if (!mountedRef.current) return;

    // 5. Lấy thống kê buổi đọc
    const wordsList = Array.from(spokenWordsSetRef.current);

    const durationMinutes = getDurationMinutes(
      finishedSession.duration_ms,
    );

    const persistedCompletion = await services.readingService
      .getCompletionSummary(sessionId)
      .catch(() => null);

    const correctWordsList = Array.from(
      correctWordIdsRef.current,
    )
      .map((wordId) => wordTextByIdRef.current.get(wordId))
      .filter((word): word is string => Boolean(word));

    const mispronouncedWordsList = Array.from(
      failedWordsSetRef.current,
    );

    const totalTracked =
      correctWordsList.length + mispronouncedWordsList.length;

    const score =
      totalTracked > 0
        ? Math.round(
            (correctWordsList.length / totalTracked) * 100,
          )
        : null;

    // 6. Tạo thống kê hoàn thành
    const updatedSummary: ReadingCompletionSummaryUI = {
      correct_words: correctWordsList,
      duration_minutes: durationMinutes,
      mispronounced_words: mispronouncedWordsList,
      pages_explored:
        persistedCompletion?.pages_explored ??
        (pageProgress?.persisted
          ? pageProgress.completed_pages
          : null),
      selected_range_pages:
        persistedCompletion?.selected_range_pages ??
        (pageProgress?.persisted
          ? pageProgress.total_pages
          : null),
      practiced_words: wordsList.length,
      score,
      spoken_words: wordsList,
      transcripts: [...transcriptsListRef.current],
    };

    // 7. Hiển thị màn hình hoàn thành
    setSessionSummary(updatedSummary);
    setCanonicalState("FINISHED");
    setConfirmFinish(false);
    setUiState("complete");
  } catch (error) {
    console.error("Lỗi khi kết thúc buổi đọc:", error);

    // Cho phép thử kết thúc lại nếu có lỗi
    finishStartedRef.current = false;
  } finally {
    if (mountedRef.current) {
      setIsComparing(false);
      setIsBusy(false);
    }
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
        ) : null}
      </ReadingLayout>
      {confirmFinish ? (
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
