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
import { ReadingPronunciationReview } from "@/components/reading/reading-pronunciation-review";
import { StatusBanner } from "@/components/reading/status-banner";
import { TutorMessage } from "@/components/reading/tutor-message";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useSpeechPlayer, type SpeechPlayOptions } from "@/hooks/use-speech-player";
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
import { compareTranscript } from "@/lib/api/comparison-service";
import {
  alignReadingSegment,
  findOriginalSentence,
  groupPronunciationReviewCandidates,
  type PronunciationReviewCandidate,
  type PronunciationReviewGroup,
} from "@/lib/utils/reading-pronunciation-alignment";
import type { ReadingEventCreateDTO } from "@/types/reading";

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
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isReadingWord, setIsReadingWord] = useState(false);
  const [correctWordIds, setCorrectWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mispronouncedWordIds, setMispronouncedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [uncertainWordIds, setUncertainWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pronunciationReviewGroups, setPronunciationReviewGroups] = useState<PronunciationReviewGroup[]>([]);
  const [isPronunciationReview, setIsPronunciationReview] = useState(false);
  const [sessionSummary, setSessionSummary] =
    useState<ReadingCompletionSummaryUI | null>(null);
  const spokenWordsSetRef = useRef<Set<string>>(new Set());
  const correctWordIdsRef = useRef<Set<string>>(new Set());
  const mispronouncedWordIdsRef = useRef<Set<string>>(new Set());
  const uncertainWordIdsRef = useRef<Set<string>>(new Set());
  const transcriptsListRef = useRef<string[]>([]);
  const wordTextByIdRef = useRef<Map<string, string>>(new Map());
  const activePageRef = useRef<ReadingPageDTO | null>(null);
  const pageCursorByRevisionRef = useRef<Map<string, number>>(new Map());
  const processedSpeechSegmentIdsRef = useRef<Set<string>>(new Set());
  const speechSegmentSequenceRef = useRef(0);
  const recognitionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pronunciationReviewCandidatesRef = useRef<Map<string, PronunciationReviewCandidate>>(new Map());
  const pendingReadingEventsRef = useRef<Map<string, ReadingEventCreateDTO>>(new Map());
  const pendingPracticeEventsRef = useRef<Map<string, ReadingEventCreateDTO>>(new Map());
  const persistedReadingEventKeysRef = useRef<Set<string>>(new Set());
  const sessionStartedAtMsRef = useRef(Date.now());
  const resumeMicrophoneAfterSpeechRef = useRef(false);
  const finishStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const isListeningActiveRef = useRef(false);

  const startListeningRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(false),
  );

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

  async function pauseMicrophoneForReferenceAudio() {
    if (!isMicRecording) return;
    resumeMicrophoneAfterSpeechRef.current = true;
    try {
      await stopListeningAndTranscribe();
    } catch (error) {
      console.warn("Could not flush microphone before TTS playback:", error);
      speechRecorder.cancel();
    }
    if (mountedRef.current) setIsMicRecording(false);
  }

  async function resumeMicrophoneAfterReferenceAudio() {
    if (!resumeMicrophoneAfterSpeechRef.current) return;
    resumeMicrophoneAfterSpeechRef.current = false;
    if (
      !mountedRef.current ||
      uiState !== "reading" ||
      finishStartedRef.current
    ) {
      return;
    }
    const microphoneReady = await startListeningRef.current();
    if (!mountedRef.current) return;
    setIsMicRecording(microphoneReady);
    if (!microphoneReady) setUiState("microphone-denied");
  }

  async function playReferenceAudio(
    text: string,
    options?: SpeechPlayOptions,
  ) {
    await pauseMicrophoneForReferenceAudio();
    try {
      await speechPlayer.play(text, {
        ...options,
        onEnded: () => {
          options?.onEnded?.();
          void resumeMicrophoneAfterReferenceAudio();
        },
      });
    } catch (error) {
      await resumeMicrophoneAfterReferenceAudio();
      throw error;
    }
  }

  const handleWordClick = useCallback(
    async (word: ReadingPageWordDTO) => {
      setCurrentWordId(word.word_id);
      setLatestTranscript(word.text);

      setIsReadingWord(true);
      try {
        await playReferenceAudio(word.text, {
          onEnded: () => {
            if (mountedRef.current) setIsReadingWord(false);
          },
        });
      } catch (err) {
        console.warn("Lỗi phát âm 1 từ:", err);
        if (mountedRef.current) setIsReadingWord(false);
      }
    },
    [speechPlayer, isMicRecording, uiState],
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
      speechRecorder.cancel();
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
    activePageRef.current = page;
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
        const sessionStartedAtMs = Date.parse(session.started_at);
        if (Number.isFinite(sessionStartedAtMs)) {
          sessionStartedAtMsRef.current = sessionStartedAtMs;
        }
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
        setCurrentWordId(currentPage.words[0]?.word_id ?? null);
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

  function enqueueRecordedUtterance(
    utteranceBlob: Blob,
    segmentStartedAtMs = Date.now(),
    audioSegmentId?: string,
  ) {
    if (utteranceBlob.size <= 800) return;
    const pageAtCapture = activePageRef.current;
    if (!pageAtCapture) return;

    const pageKey = `${pageAtCapture.page_id}:${pageAtCapture.page_revision_id}`;
    const segmentId = [
      sessionId,
      pageAtCapture.page_id,
      pageAtCapture.page_revision_id,
      audioSegmentId ?? `${Math.round(segmentStartedAtMs)}:${utteranceBlob.size}:${++speechSegmentSequenceRef.current}`,
    ].join(":");

    const pending = recognitionQueueRef.current.then(async () => {
      if (!mountedRef.current || processedSpeechSegmentIdsRef.current.has(segmentId)) return;
      processedSpeechSegmentIdsRef.current.add(segmentId);
      try {
        const transcript = await speechService.transcribe(utteranceBlob, { languageCode: "vi" });
        if (!mountedRef.current || !transcript.text.trim()) return;
        setLatestTranscript(transcript.text.trim());

        const startIndex = pageCursorByRevisionRef.current.get(pageKey) ?? 0;
        const result = alignReadingSegment(
          pageAtCapture.words,
          startIndex,
          transcript.text,
          transcript.words,
        );
        if (result.next_word_index > startIndex) {
          pageCursorByRevisionRef.current.set(pageKey, result.next_word_index);
        }

        for (const assessment of result.assessments) {
          if (assessment.status === "CORRECT") {
            correctWordIdsRef.current.add(assessment.word_id);
            uncertainWordIdsRef.current.delete(assessment.word_id);
          } else if (assessment.status === "INCORRECT") {
            correctWordIdsRef.current.delete(assessment.word_id);
            uncertainWordIdsRef.current.delete(assessment.word_id);
            mispronouncedWordIdsRef.current.add(assessment.word_id);
            const sentence = findOriginalSentence(pageAtCapture.words, assessment.word_index);
            const candidateKey = [
              pageAtCapture.page_id,
              pageAtCapture.page_revision_id,
              assessment.word_id,
            ].join(":");
            pronunciationReviewCandidatesRef.current.set(candidateKey, {
              page_id: pageAtCapture.page_id,
              page_number: pageAtCapture.page_number,
              page_revision_id: pageAtCapture.page_revision_id,
              word_id: assessment.word_id,
              word_index: assessment.word_index,
              expected_word: assessment.expected_text,
              recognized_word: assessment.recognized_text,
              confidence: assessment.confidence,
              sentence_text: sentence?.text ?? null,
              sentence_start_word_index: sentence?.startWordIndex ?? null,
              sentence_end_word_index_exclusive: sentence?.endWordIndexExclusive ?? null,
            });
            if (assessment.confidence !== null) {
              const eventKey = candidateKey;
              const eventStartMs = Math.max(
                0,
                Math.round(
                  segmentStartedAtMs +
                    (assessment.recognized_start_seconds ?? 0) * 1000 -
                    sessionStartedAtMsRef.current,
                ),
              );
              pendingReadingEventsRef.current.set(eventKey, {
                session_id: sessionId,
                page_id: pageAtCapture.page_id,
                page_revision_id: pageAtCapture.page_revision_id,
                word_id: assessment.word_id,
                type:
                  assessment.reason === "BOUNDED_OMISSION"
                    ? "OMISSION"
                    : "SUBSTITUTION",
                start_ms: eventStartMs,
                end_ms: null,
                confidence: assessment.confidence,
                status: "CONFIRMED",
                metadata: {
                  phase: "FIRST_PASS",
                  occurrence_key: candidateKey,
                  word_index: assessment.word_index,
                  expected_word: assessment.expected_text,
                  recognized_word: assessment.recognized_text,
                  recognition_reason: assessment.reason,
                  segment_id: segmentId,
                },
              });
            }
          } else {
            uncertainWordIdsRef.current.add(assessment.word_id);
          }
        }

        setCorrectWordIds(new Set(correctWordIdsRef.current));
        setMispronouncedWordIds(new Set(mispronouncedWordIdsRef.current));
        setUncertainWordIds(new Set(uncertainWordIdsRef.current));
        recordSpokenText(transcript.text);

        const activePage = activePageRef.current;
        if (activePage?.page_id === pageAtCapture.page_id &&
            activePage.page_revision_id === pageAtCapture.page_revision_id) {
          const nextWord = pageAtCapture.words.find(
            (word) => word.word_index >= result.next_word_index,
          ) ?? null;
          setCurrentWordId(nextWord?.word_id ?? null);
        }
      } catch (error) {
        console.warn("Reading utterance could not be transcribed:", error);
      }
    });
    recognitionQueueRef.current = pending.catch((error: unknown) => {
      console.warn("Reading recognition queue failed:", error);
    });
  }

  async function startListening(): Promise<boolean> {
    setLatestTranscript(null);
    isListeningActiveRef.current = true;
    try {
      // MediaRecorder + Scribe is the sole authoritative recognition pipeline.
      await speechRecorder.start(enqueueRecordedUtterance);
      if (!mountedRef.current || !isListeningActiveRef.current) {
        speechRecorder.cancel();
        return false;
      }
      return true;
    } catch (error) {
      isListeningActiveRef.current = false;
      console.warn("Microphone capture could not start:", error);
      if (mountedRef.current) {
        setConnectionState("reconnecting");
        setUiState("microphone-denied");
      }
      return false;
    }
  }

  useEffect(() => {
    startListeningRef.current = startListening;
  });

  async function persistPracticeOutcome(
    candidate: PronunciationReviewCandidate,
    stage: "WORD" | "SENTENCE",
    outcome: "CORRECT" | "ASSISTED",
    confidence: number | null,
    recognizedTranscript: string | null,
  ) {
    const eventKey = [
      candidate.page_id,
      candidate.page_revision_id,
      candidate.word_id,
      "PRACTICE",
      stage,
      outcome,
    ].join(":");
    if (persistedReadingEventKeysRef.current.has(eventKey)) return;

    const startMs = Math.max(
      0,
      Date.now() - sessionStartedAtMsRef.current,
    );
    pendingPracticeEventsRef.current.set(eventKey, {
      session_id: sessionId,
      page_id: candidate.page_id,
      page_revision_id: candidate.page_revision_id,
      word_id: candidate.word_id,
      type: "SELF_CORRECTION",
      start_ms: startMs,
      end_ms: null,
      confidence,
      status: outcome === "CORRECT" ? "CONFIRMED" : "UNCERTAIN",
      metadata: {
        phase: "POST_SESSION_PRACTICE",
        practice_stage: stage,
        practice_outcome: outcome,
        occurrence_key: [
          candidate.page_id,
          candidate.page_revision_id,
          candidate.word_id,
        ].join(":"),
        word_index: candidate.word_index,
        expected_word: candidate.expected_word,
        recognized_word: candidate.recognized_word,
        original_sentence: candidate.sentence_text,
        practice_transcript: recognizedTranscript,
      },
    });

    await persistPendingPracticeEvents();
  }

  async function persistPendingPracticeEvents() {
    const createEvent = services.readingService.createEvent;
    if (!createEvent) {
      console.warn("ReadingService.createEvent is unavailable; practice events were not persisted.");
      return;
    }

    for (const [eventKey, event] of pendingPracticeEventsRef.current) {
      if (persistedReadingEventKeysRef.current.has(eventKey)) {
        pendingPracticeEventsRef.current.delete(eventKey);
        continue;
      }
      try {
        await createEvent(event);
        persistedReadingEventKeysRef.current.add(eventKey);
        pendingPracticeEventsRef.current.delete(eventKey);
      } catch (error) {
        // Keep failed practice events queued so completion can make one final attempt.
        console.warn("Could not persist a practice outcome:", error);
      }
    }
  }

  async function persistPendingReadingEvents() {
    const createEvent = services.readingService.createEvent;
    if (!createEvent) {
      if (pendingReadingEventsRef.current.size > 0) {
        console.warn("ReadingService.createEvent is unavailable; pronunciation events were not persisted.");
      }
      return;
    }

    for (const [eventKey, event] of pendingReadingEventsRef.current) {
      if (persistedReadingEventKeysRef.current.has(eventKey)) continue;
      try {
        await createEvent(event);
        persistedReadingEventKeysRef.current.add(eventKey);
        pendingReadingEventsRef.current.delete(eventKey);
      } catch (error) {
        // Keep the event queued in memory for one final retry at session finish.
        console.warn("Could not persist a confirmed pronunciation event:", error);
      }
    }
  }

  async function stopListeningAndTranscribe() {
    isListeningActiveRef.current = false;
    try {
      // stop() emits the final unprocessed tail through enqueueRecordedUtterance.
      // Do not upload the returned Blob again: that would duplicate the same speech.
      await speechRecorder.stop();
      await recognitionQueueRef.current;
    } catch (error) {
      speechRecorder.cancel();
      console.warn("Could not drain pending reading audio:", error);
      await recognitionQueueRef.current;
    }
  }

  async function handleReadSample() {
    if (isBusy && !speechPlayer.isPlaying) return;
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      setIsReadingWord(false);
      setIsBusy(false);
      await resumeMicrophoneAfterReferenceAudio();
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

    // TTS playback is guidance only; it must never mutate first-pass recognition.
    // Set first word active immediately so user sees what is being queued
    setCurrentWordId(words[0].word_id);

    try {
      await playReferenceAudio(fullText, {
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
          const lastWord = words[words.length - 1];
          if (lastWord) {
            setCurrentWordId(lastWord.word_id);
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
    //Set lại ghi âm mới
    transcriptsListRef.current = [];

    setLatestTranscript(null);
    setIsBusy(false);
    setCountdown(3);
    if (page && page.words.length > 0) {
      setCurrentWordId(page.words[0].word_id);
    }
    pageCursorByRevisionRef.current.clear();
    processedSpeechSegmentIdsRef.current.clear();
    speechSegmentSequenceRef.current = 0;
    recognitionQueueRef.current = Promise.resolve();
    pronunciationReviewCandidatesRef.current.clear();
    pendingReadingEventsRef.current.clear();
    pendingPracticeEventsRef.current.clear();
    persistedReadingEventKeysRef.current.clear();
    correctWordIdsRef.current.clear();
    mispronouncedWordIdsRef.current.clear();
    uncertainWordIdsRef.current.clear();
    spokenWordsSetRef.current.clear();
    setCorrectWordIds(new Set());
    setMispronouncedWordIds(new Set());
    setUncertainWordIds(new Set());
  }

  async function resumeReading() {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const nextState = await services.readingSocketAdapter.sendControl(
        sessionId,
        "resume",
      );
      if (!mountedRef.current) return;

      const microphoneReady = await startListening();
      if (!mountedRef.current) return;
      setCanonicalState(nextState);
      setConnectionState("connected");
      setIsMicRecording(microphoneReady);
      setUiState(microphoneReady ? "reading" : "microphone-denied");
    } catch (error) {
      console.warn("Could not resume reading:", error);
      if (mountedRef.current) {
        setUiState("microphone-denied");
        setIsMicRecording(false);
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function pauseReading() {
    if (isBusy) return;
    if (speechPlayer.isPlaying) speechPlayer.stop();
    resumeMicrophoneAfterSpeechRef.current = false;
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
    try {
      await services.devicePermissionService.retry(kind);
      if (!mountedRef.current) return;

      const microphoneReady = isMicRecording || (await startListening());
      if (!mountedRef.current) return;
      if (!microphoneReady) {
        setIsMicRecording(false);
        setUiState("microphone-denied");
        return;
      }

      setIsMicRecording(true);
      setConnectionState("connected");
      setUiState("reading");
      setCanonicalState("LISTENING");
    } catch (error) {
      console.warn("Could not recover reading device:", error);
      if (mountedRef.current) {
        setUiState(kind === "microphone" ? "microphone-denied" : "camera-denied");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
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

      activePageRef.current = nextPage;
      setPageProgress(nextProgress);
      setPage(nextPage);
      setCurrentWordId(nextPage.words[0]?.word_id ?? null);
      setSelectedManualPageId(nextPage.page_id);
      setCountdown(null);

      const microphoneReady = await startListening();
      if (!mountedRef.current) return;
      setIsMicRecording(microphoneReady);
      setUiState(microphoneReady ? "reading" : "microphone-denied");
    } catch (error) {
      console.warn("Could not navigate reading page:", error);
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
    try {
      if (isMicRecording) {
        await stopListeningAndTranscribe();
        if (mountedRef.current) setIsMicRecording(false);
      }

      const matchedPage =
        await services.pageMatchService.retryCurrentPage(sessionId);
      if (!mountedRef.current) return;
      activePageRef.current = matchedPage;
      setPage(matchedPage);
      setCurrentWordId(matchedPage.words[0]?.word_id ?? null);
      setSelectedManualPageId(matchedPage.page_id);
      setPageProgress(await services.readingService.getPageProgress(sessionId));
      setPageNavigationError(null);

      const microphoneReady = await startListening();
      if (!mountedRef.current) return;
      setCanonicalState("LISTENING");
      setConnectionState("connected");
      setIsMicRecording(microphoneReady);
      setUiState(microphoneReady ? "reading" : "microphone-denied");
    } catch (error) {
      console.warn("Could not retry page recognition:", error);
      if (mountedRef.current) setUiState("page-confidence-low");
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function confirmManualPage() {
    if (!selectedManualPageId || isBusy) return;
    setIsBusy(true);
    try {
      if (isMicRecording) {
        await stopListeningAndTranscribe();
        if (mountedRef.current) setIsMicRecording(false);
      }

      const matchedPage = await services.pageMatchService.selectPage(
        sessionId,
        selectedManualPageId,
      );
      if (!mountedRef.current) return;
      activePageRef.current = matchedPage;
      setPage(matchedPage);
      setPageProgress(await services.readingService.getPageProgress(sessionId));
      setPageNavigationError(null);
      setCurrentWordId(matchedPage.words[0]?.word_id ?? null);

      const microphoneReady = await startListening();
      if (!mountedRef.current) return;
      setCanonicalState("LISTENING");
      setConnectionState("connected");
      setIsMicRecording(microphoneReady);
      setUiState(microphoneReady ? "reading" : "microphone-denied");
    } catch (error) {
      console.warn("Could not select reading page:", error);
      if (mountedRef.current) setUiState("manual-page");
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function reconnect(mode: ReadingReconnectDemoMode) {  async function reconnect(mode: ReadingReconnectDemoMode) {
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
      await playReferenceAudio(action?.tts_text ?? word);
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
      await playReferenceAudio(nextAction?.tts_text ?? word);
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

    // Save confirmed source-occurrence errors before finishing the session.
    await persistPendingReadingEvents();
    if (!mountedRef.current) return;

    // 2. Ghép transcript của tất cả các lần ghi âm
    const combinedTranscript = transcriptsListRef.current
      .join(" ")
      .trim();


    // Text-only comparison is diagnostic, not a source of word-level
    // pronunciation decisions. Multi-page transcripts must not be compared
    // against the current page alone.
    if (combinedTranscript && (pageProgress?.total_pages ?? 1) === 1) {
      try {
        await compareTranscript(sessionId, combinedTranscript);
      } catch (error) {
        console.error("Lỗi so sánh bài đọc:", error);
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
      mispronouncedWordIdsRef.current,
    )
      .map((wordId) => wordTextByIdRef.current.get(wordId))
      .filter((word): word is string => Boolean(word));

    // Score source occurrences, not unique word strings: repeated words are
    // independent pronunciation assessments.
    const totalTracked =
      correctWordIdsRef.current.size + mispronouncedWordIdsRef.current.size;

    const score =
      totalTracked > 0
        ? Math.round(
            (correctWordIdsRef.current.size / totalTracked) * 100,
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
    const reviewGroups = groupPronunciationReviewCandidates(
      [...pronunciationReviewCandidatesRef.current.values()],
    );
    setPronunciationReviewGroups(reviewGroups);
    if (reviewGroups.length > 0) {
      setIsPronunciationReview(true);
    } else {
      setUiState("complete");
    }
  } catch (error) {
    console.error("Lỗi khi kết thúc buổi đọc:", error);

    // Cho phép thử kết thúc lại nếu có lỗi
    finishStartedRef.current = false;
  } finally {
    if (mountedRef.current) {
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

  if (isPronunciationReview) {
    return (
      <ReadingPronunciationReview
        groups={pronunciationReviewGroups}
        onComplete={() => {
          void (async () => {
            await persistPendingPracticeEvents();
            setIsPronunciationReview(false);
            setUiState("complete");
          })();
        }}
        onPracticeOutcome={persistPracticeOutcome}
      />
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
