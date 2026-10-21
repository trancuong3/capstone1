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
interface BrowserSpeechEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
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
  const [pageProgress, setPageProgress] = useState<ReadingSessionPageProgressDTO | null>(null);
  const [pageNavigationError, setPageNavigationError] = useState<string | null>(null);
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
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isReadingWord, setIsReadingWord] = useState(false);
  const [spokenWords, setSpokenWords] = useState<Set<string>>(() => new Set());
  const [correctWordIds, setCorrectWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mispronouncedWordIds, setMispronouncedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [sessionSummary, setSessionSummary] =
    useState<ReadingCompletionSummaryUI | null>(null);
  const spokenWordsSetRef = useRef<Set<string>>(new Set());
  const correctWordIdsRef = useRef<Set<string>>(new Set());
  const mispronouncedWordIdsRef = useRef<Set<string>>(new Set());
  const failedWordsSetRef = useRef<Set<string>>(new Set());
  const transcriptsListRef = useRef<string[]>([]);
  const wordTextByIdRef = useRef<Map<string, string>>(new Map());
  const finishStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isListeningActiveRef = useRef(false);
  const startListeningRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const isUsingRecorderRef = useRef(false);

  const recordSpokenText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const transcripts = transcriptsListRef.current;
    if (
      transcripts.length === 0 ||
      transcripts[transcripts.length - 1] !== trimmed
    ) {
      transcripts.push(trimmed);
    }

    const words = trimmed
      .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'“”—]/g, "")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

    for (const w of words) {
      spokenWordsSetRef.current.add(w);
    }
    setSpokenWords(new Set(spokenWordsSetRef.current));
  }, []);

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

        setPage(currentPage);
        setPageProgress(initialProgress);
        setPageNavigationError(
          requestedPageIsOutsideRange
            ? "Trang từ liên kết không thuộc phạm vi buổi đọc. Đã khôi phục trang hiện tại đã lưu."
            : null,
        );
        setCurrentWordId(selectedPage.words[3]?.word_id ?? null);
        setSelectedManualPageId(selectedPage.page_id);
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
    if (!nextPage) {
      setPageNavigationError("Bé đã đến trang cuối của phạm vi đọc đã chọn.");
      setUiState("reading");
      return;
    }

    let active = true;
    void services.pageMatchService
      .selectPage(sessionId, nextPage.page_id)
      .then(async (matchedPage) => {
        const progress = await services.readingService.getPageProgress(sessionId);
        if (!active) return;
        setPage(matchedPage);
        setPageProgress(progress);
        setPageNavigationError(null);
        setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
        setSelectedManualPageId(matchedPage.page_id);
        setCanonicalState("LISTENING");
        setUiState("reading");
      })
      .catch(() => {
        if (!active) return;
        setPageNavigationError("Chưa chuyển được sang trang tiếp theo. Bé có thể thử lại bằng nút Trang tiếp theo.");
        setUiState("reading");
      });

    return () => {
      active = false;
    };
  }, [loadState, page, pageProgress, services.pageMatchService, services.readingService, sessionId, uiState]);

  function normalizeVietnamese(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'“”—]/g, "")
      .trim();
  }

  function verifySpokenWord(spokenText: string) {
    if (!page || !page.words.length || !spokenText) return;
    const cleanSpoken = normalizeVietnamese(spokenText);
    const tokens = cleanSpoken.split(/\s+/).filter((t) => t.length > 0);
    if (!tokens.length) return;

    const words = page.words;
    const currentIdx = words.findIndex((w) => w.word_id === currentWordId);
    const searchIdx = currentIdx >= 0 ? currentIdx : 0;
    const targetWord = words[searchIdx];
    if (!targetWord) return;

    const targetClean = normalizeVietnamese(targetWord.text);

    // Look for target word match in the spoken tokens
    let matchedTokenIdx = -1;
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      if (
        tok === targetClean ||
        (targetClean.length >= 2 && tok.includes(targetClean)) ||
        (tok.length >= 2 && targetClean.includes(tok))
      ) {
        matchedTokenIdx = t;
        break;
      }
    }

    if (matchedTokenIdx >= 0) {
      // Correct pronunciation!
      correctWordIdsRef.current.add(targetWord.word_id);
      mispronouncedWordIdsRef.current.delete(targetWord.word_id);
      spokenWordsSetRef.current.add(targetWord.text);

      let nextIdx = searchIdx + 1;
      let nextTokIdx = matchedTokenIdx + 1;

      // Match subsequent words if user spoke a fluent phrase in one go
      while (nextIdx < words.length && nextTokIdx < tokens.length) {
        const nextTargetClean = normalizeVietnamese(words[nextIdx].text);
        const nextTok = tokens[nextTokIdx];
        if (
          nextTok === nextTargetClean ||
          (nextTargetClean.length >= 2 && nextTok.includes(nextTargetClean)) ||
          (nextTok.length >= 2 && nextTargetClean.includes(nextTok))
        ) {
          correctWordIdsRef.current.add(words[nextIdx].word_id);
          mispronouncedWordIdsRef.current.delete(words[nextIdx].word_id);
          spokenWordsSetRef.current.add(words[nextIdx].text);
          nextIdx++;
          nextTokIdx++;
        } else {
          // Child stumbled or mispronounced this subsequent word
          mispronouncedWordIdsRef.current.add(words[nextIdx].word_id);
          failedWordsSetRef.current.add(words[nextIdx].text);
          break;
        }
      }

      // Advance yellow highlight to the next word
      if (nextIdx < words.length) {
        setCurrentWordId(words[nextIdx].word_id);
      } else {
        setCurrentWordId(words[words.length - 1].word_id);
      }
    } else {
      // Child spoke, but did not pronounce the target word correctly -> Alert RED!
      mispronouncedWordIdsRef.current.add(targetWord.word_id);
      failedWordsSetRef.current.add(targetWord.text);
      // Keep currentWordId on targetWord (DO NOT jump forward)
      setCurrentWordId(targetWord.word_id);
    }

    setCorrectWordIds(new Set(correctWordIdsRef.current));
    setMispronouncedWordIds(new Set(mispronouncedWordIdsRef.current));
    setSpokenWords(new Set(spokenWordsSetRef.current));
  }

  async function startListening(): Promise<boolean> {
    setLatestTranscript(null);
    isListeningActiveRef.current = true;

    // 1. Always start MediaRecorder with continuous live utterance transcription for ElevenLabs STT
    try {
      await speechRecorder.start(async (utteranceBlob) => {
        if (!mountedRef.current || !isListeningActiveRef.current) return;
        try {
          const transcript = await speechService.transcribe(utteranceBlob, {
            languageCode: "vi",
          });
          if (!mountedRef.current || !transcript.text) return;
          const cleanText = transcript.text.trim();
          if (cleanText) {
            setLatestTranscript(cleanText);
            verifySpokenWord(cleanText);
            recordSpokenText(cleanText);
          }
        } catch (e) {
          console.warn("Live ElevenLabs STT utterance notice:", e);
        }
      });
      isUsingRecorderRef.current = true;
    } catch (error) {
      isUsingRecorderRef.current = false;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("not supported")) {
        if (mountedRef.current) setLatestTranscript(null);
        return true;
      }
      if (mountedRef.current) {
        setConnectionState("reconnecting");
        setUiState("microphone-denied");
      }
      return false;
    }

    // 2. Concurrently attempt Web Speech API for low-latency streaming text if supported by browser
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
              setLatestTranscript(currentWord);
              verifySpokenWord(currentWord);
              recordSpokenText(currentWord);
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

  async function transcribeRecording(recording: Blob) {
    transcriptionAbortRef.current?.abort();
    const controller = new AbortController();
    transcriptionAbortRef.current = controller;
    try {
      const transcript = await speechService.transcribe(recording, {
        languageCode: "vi",
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      if (transcript.text) {
        setLatestTranscript(transcript.text);
        verifySpokenWord(transcript.text);
        recordSpokenText(transcript.text);
      }
    } catch (err) {
      console.warn("ElevenLabs STT transcription notice:", err);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        finishStartedRef.current
      )
        return;
      if (spokenWordsSetRef.current.size === 0) {
        setConnectionState("reconnecting");
        setUiState("stt-error");
      }
    } finally {
      if (transcriptionAbortRef.current === controller) {
        transcriptionAbortRef.current = null;
      }
    }
  }

  async function stopListeningAndTranscribe() {
    isListeningActiveRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Safe ignore
      }
      recognitionRef.current = null;
    }
    isUsingRecorderRef.current = false;
    try {
      const recording = await speechRecorder.stop();
      if (recording && recording.size > 200) {
        await transcribeRecording(recording);
      }
    } catch {
      speechRecorder.cancel();
    }
  }

  async function handleReadSample() {
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
            for (let i = 0; i <= idx; i++) {
              spokenWordsSetRef.current.add(words[i].text);
            }
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
              spokenWordsSetRef.current.add(w.text);
            }
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
    setIsBusy(false);
    setCountdown(3);
    if (page && page.words.length > 0) {
      setCurrentWordId(page.words[0].word_id);
    }
    correctWordIdsRef.current.clear();
    mispronouncedWordIdsRef.current.clear();
    failedWordsSetRef.current.clear();
    spokenWordsSetRef.current.clear();
    setCorrectWordIds(new Set());
    setMispronouncedWordIds(new Set());
    setSpokenWords(new Set());
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
    if (!pageProgress || isBusy || targetIndex < 0 || targetIndex >= pageProgress.pages.length) {
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
      setPage(nextPage);
      setCurrentWordId(nextPage.words[3]?.word_id ?? null);
      setSelectedManualPageId(nextPage.page_id);
      setCountdown(null);
      setUiState("reading");
    } catch {
      if (mountedRef.current) {
        setPageNavigationError("Chưa tải được trang này. Tiến trình buổi đọc vẫn được giữ; vui lòng thử lại.");
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
        setPageNavigationError("Chưa lưu được xác nhận hoàn thành trang. Vui lòng thử lại.");
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

  async function finishReading() {
    if (finishStartedRef.current) return;
    finishStartedRef.current = true;
    setIsBusy(true);
    speechPlayer.stop();
    if (isMicRecording) {
      try {
        await stopListeningAndTranscribe();
      } catch {
        speechRecorder.cancel();
      }
      if (mountedRef.current) setIsMicRecording(false);
    }
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
      pages_explored: persistedCompletion?.pages_explored ?? null,
      practiced_words: wordsList.length,
      score,
      spoken_words: wordsList,
      transcripts: transcriptsListRef.current,
    };
    setSessionSummary(updatedSummary);
    setCanonicalState("FINISHED");
    setConfirmFinish(false);
    setUiState("complete");
    setIsBusy(false);
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
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-2 px-4 pt-3 sm:px-8">
      {pageProgress ? (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-bold text-ink">
              Phạm vi đọc: Trang {pageProgress.start_page_number}–{pageProgress.end_page_number}
            </p>
            <p className="text-sm text-muted" aria-live="polite">
              Trang {pageProgress.current_page_number} · {pageProgress.current_index + 1}/{pageProgress.total_pages} trong phạm vi · {pageProgress.completed_pages}/{pageProgress.total_pages} trang đã hoàn thành
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              disabled={isBusy || uiState !== "reading" || pageProgress.current_index <= 0}
              onClick={() => void navigateWithinRange(pageProgress.current_index - 1)}
              variant="secondary"
            >
              <ChevronLeft aria-hidden="true" className="size-5" />
              Trang trước
            </Button>
            <Button
              disabled={isBusy || uiState !== "reading" || pageProgress.current_index >= pageProgress.total_pages - 1}
              onClick={() => void navigateWithinRange(pageProgress.current_index + 1)}
              variant="secondary"
            >
              Trang tiếp theo
              <ChevronRight aria-hidden="true" className="size-5" />
            </Button>
          </div>
          {pageProgress.persisted &&
          pageProgress.pages[pageProgress.current_index]?.status !== "COMPLETED" ? (
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
      {pageProgress && pageProgress.current_index === pageProgress.total_pages - 1 ? (
        <p className="text-sm font-semibold text-primary" role="status">
          Bé đã đến trang cuối của phạm vi. Có thể kết thúc buổi đọc khi sẵn sàng.
        </p>
      ) : null}
    </div>

    <div
      data-canonical-state={canonicalState}
      data-child-error-count={safety.child_error_events.length}
      data-evidence-valid={safety.evidence_valid}
      data-scoring-active={safety.scoring_active}
    >
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
        spokenWords={spokenWords}
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
