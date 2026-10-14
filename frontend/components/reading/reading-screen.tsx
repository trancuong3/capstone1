"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
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
  const [sessionSummary, setSessionSummary] =
    useState<ReadingCompletionSummaryUI | null>(null);
  const spokenWordsSetRef = useRef<Set<string>>(new Set());
  const transcriptsListRef = useRef<string[]>([]);
  const finishStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const isListeningActiveRef = useRef(false);
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
  }, []);

  const handleWordClick = useCallback(
    (word: ReadingPageWordDTO) => {
      setCurrentWordId(word.word_id);
      setLatestTranscript(word.text);
      recordSpokenText(word.text);
    },
    [recordSpokenText],
  );

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
        ] = await Promise.all([
          services.bookService.get(session.book_id),
          services.childService.get(session.child_id),
          services.readingService.getCurrentPage(sessionId),
          services.bookService.listPages(session.book_id),
          services.devicePermissionService.getSnapshot(),
          services.readingService.getCompletionSummary(sessionId),
        ]);

        const selectedPage = initialPageId
          ? await services.pageMatchService.selectPage(sessionId, initialPageId)
          : currentPage;

        if (!active) return;

        setPage(selectedPage);
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
    if (loadState.status !== "ready" || uiState !== "page-turn" || !page) {
      return;
    }

    const nextPage = loadState.data.pagePreviews.find(
      (candidate) => candidate.page_id !== page.page_id,
    );
    if (!nextPage) return;

    let active = true;
    void services.pageMatchService
      .selectPage(sessionId, nextPage.page_id)
      .then((matchedPage) => {
        if (!active) return;
        setPage(matchedPage);
        setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
        setSelectedManualPageId(matchedPage.page_id);
        setCanonicalState("LISTENING");
        setUiState("reading");
      });

    return () => {
      active = false;
    };
  }, [loadState, page, services.pageMatchService, sessionId, uiState]);

  function normalizeVietnamese(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'“”—]/g, "")
      .trim();
  }

  function matchSpokenWord(spokenText: string) {
    if (!page || !page.words.length || !spokenText) return;
    const cleanSpoken = normalizeVietnamese(spokenText);
    const tokens = cleanSpoken.split(/\s+/).filter(Boolean);
    if (!tokens.length) return;

    let matchedWordId: string | null = null;
    for (const token of tokens) {
      for (const w of page.words) {
        const cleanWord = normalizeVietnamese(w.text);
        if (
          cleanWord === token ||
          cleanWord.includes(token) ||
          token.includes(cleanWord)
        ) {
          spokenWordsSetRef.current.add(w.text);
          matchedWordId = w.word_id;
        }
      }
    }
    if (matchedWordId) {
      setCurrentWordId(matchedWordId);
    }
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
            matchSpokenWord(cleanText);
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
    if (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    ) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SpeechRec =
          (window as any).SpeechRecognition ||
          (window as any).webkitSpeechRecognition;
        const rec = new SpeechRec();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = "vi-VN";
        rec.maxAlternatives = 1;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rec.onresult = (event: any) => {
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
            matchSpokenWord(currentWord);
            recordSpokenText(currentWord);
          }
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rec.onerror = (event: any) => {
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
      } catch (e) {
        console.warn("SpeechRecognition initialization skipped:", e);
      }
    }

    return true;
  }

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
        matchSpokenWord(transcript.text);
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
    if (isBusy) return;
    if (isMicRecording) {
      try {
        await stopListeningAndTranscribe();
      } catch {
        speechRecorder.cancel();
      }
      if (mountedRef.current) setIsMicRecording(false);
    }
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      return;
    }
    if (!page) return;
    const rawText =
      page.text || page.words.map((w) => w.text).join(" ") || "";
    const fullText = rawText.replace(/\s+/g, " ").trim();
    if (!fullText) return;

    setIsBusy(true);
    try {
      await speechPlayer.play(fullText);
    } catch {
      if (mountedRef.current) setUiState("tts-error");
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function handleToggleListening() {
    if (isBusy) return;
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
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

  async function retryPageMatch() {
    if (isBusy) return;
    setIsBusy(true);
    const matchedPage =
      await services.pageMatchService.retryCurrentPage(sessionId);
    if (!mountedRef.current) return;
    setPage(matchedPage);
    setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
    setSelectedManualPageId(matchedPage.page_id);
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
    await Promise.all([
      services.readingService.finish(sessionId),
      services.readingSocketAdapter.sendControl(sessionId, "finish"),
    ]);
    if (!mountedRef.current) return;
    const wordsList = Array.from(spokenWordsSetRef.current);
    const existingSummary =
      loadState.status === "ready" ? loadState.data.completion : null;
    const updatedSummary: ReadingCompletionSummaryUI = {
      duration_minutes: existingSummary?.duration_minutes ?? 1,
      pages_explored: existingSummary?.pages_explored ?? 1,
      practiced_words: wordsList.length,
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
      <ReadingLayout
        audioLevel={speechRecorder.audioLevel}
        bookTitle={book.title}
        controlsDisabled={uiState !== "reading" || isBusy}
        currentWordId={currentWordId}
        exitHref={detailHref}
        isListening={uiState === "reading"}
        isMicRecording={isMicRecording}
        isPageTransitioning={uiState === "page-turn"}
        isPlayingSample={speechPlayer.isPlaying}
        isSpeaking={speechRecorder.isSpeaking}
        latestTranscript={latestTranscript}
        onFinish={() => setConfirmFinish(true)}
        onHelp={() => void requestTutor()}
        onManualPage={() => setUiState("manual-page")}
        onPause={() => void pauseReading()}
        onReadSample={() => void handleReadSample()}
        onToggleListening={() => void handleToggleListening()}
        onWordClick={handleWordClick}
        page={page}
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
          pages={pagePreviews}
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

function connectionLabel(state: ReadingConnectionState): string {
  const labels: Record<ReadingConnectionState, string> = {
    connected: "đã kết nối",
    reconnecting: "đang kết nối lại",
    recovered: "đã khôi phục kết nối",
    "timed-out": "kết nối lại quá thời gian",
  };

  return labels[state];
}
