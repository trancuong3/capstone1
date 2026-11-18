"use client";

import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useReportServices } from "@/hooks/use-report-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { isServiceError } from "@/lib/api/service-error";
import { BrowserTranscriptCollector } from "@/lib/reading/browser-transcript-collector";
import { hasUsableBrowserConfidence } from "@/lib/reading/recognition-evidence";
import {
  SHORT_WORD_CAPTURE_CONFIG,
  VOICE_PROMPTS,
  classifyShortWordFailureLabel,
  hasShortWordSpeechActivity,
  shouldAutoStopShortWordCapture,
  type ShortWordFailureLabel,
  type WordPracticeState,
} from "@/lib/reading/word-practice-engine";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DifficultWordAssessmentStatus,
  DifficultWordDTO,
  DifficultWordPracticeAttemptDTO,
  DifficultWordPracticeHistoryItemDTO,
  DifficultWordPracticeStatus,
} from "@/types/reports";

interface BrowserSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult: ((event: BrowserSpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

interface BrowserSpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly 0?: { readonly transcript?: string; readonly confidence?: number };
  }>;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognitionLike;

interface WindowWithSpeechRecognition {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface CapturedAttemptPayload {
  readonly requestId: string;
  readonly audioBlob: Blob;
  readonly durationMs: number;
  readonly audioQualityStatus: string | undefined;
  readonly browserTranscript: string | null;
  readonly browserConfidence: number | null;
}

const PRACTICE_STATUS_LABELS: Record<DifficultWordPracticeStatus, string> = {
  NOT_PRACTICED: "Chưa luyện",
  IN_PROGRESS: "Đang luyện",
  NEEDS_MORE_PRACTICE: "Cần luyện thêm",
  COMPLETED: "Đã đọc đúng",
};

const PRACTICE_STATUS_CLASSES: Record<DifficultWordPracticeStatus, string> = {
  NOT_PRACTICED: "border-red-200 bg-red-50 text-red-900",
  IN_PROGRESS: "border-amber-200 bg-amber-50 text-amber-900",
  NEEDS_MORE_PRACTICE: "border-red-200 bg-red-50 text-red-900",
  COMPLETED: "border-emerald-300 bg-emerald-50 text-emerald-900",
};

const ASSESSMENT_LABELS: Record<DifficultWordAssessmentStatus, string> = {
  CORRECT: "Đọc đúng",
  INCORRECT: "Đọc sai",
  UNCERTAIN: "Nghe chưa rõ",
  NO_CLEAR_AUDIO: "Chưa nghe thấy",
  ENGINE_ERROR: "Máy đang bận",
};

function createRequestUuid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
}

function formatDateTimeVn(isoValue: string | null | undefined): string {
  if (!isoValue) return "Chưa có";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return "Chưa rõ thời gian";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(parsed);
}

function mapMicrophoneErrorMessage(error: unknown): string {
  const errObj =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : null;
  const name = typeof errObj?.name === "string" ? errObj.name : "";
  const message =
    typeof errObj?.message === "string" ? errObj.message.toLowerCase() : "";
  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    message.includes("denied") ||
    message.includes("permission")
  ) {
    return "Trình duyệt chưa được cấp quyền Micro. Ba mẹ hãy cho phép quyền micro trong cài đặt trình duyệt rồi thử lại nhé.";
  }
  if (name === "NotFoundError" || message.includes("device not found")) {
    return "Không tìm thấy micro trên thiết bị này. Ba mẹ hãy kiểm tra lại kết nối micro nhé.";
  }
  if (message.includes("not supported")) {
    return "Trình duyệt hiện tại chưa hỗ trợ ghi âm trực tiếp.";
  }
  return "Chưa thể thu âm lúc này. Ba mẹ và bé hãy thử lại nhé.";
}

interface DifficultWordPracticePanelProps {
  readonly autoStart?: boolean;
  readonly child: ChildProfileDTO;
  readonly word: DifficultWordDTO;
  readonly words: readonly DifficultWordDTO[];
  readonly onSelectWord: (
    normalizedWord: string,
    options?: { readonly autoStart?: boolean },
  ) => void;
  readonly onClose: () => void;
  readonly onAttemptCompleted?: (
    attempt: DifficultWordPracticeAttemptDTO,
  ) => void;
  readonly onProgressSaved: () => Promise<void> | void;
}

export function DifficultWordPracticePanel({
  autoStart = false,
  child,
  word,
  words,
  onSelectWord,
  onClose,
  onAttemptCompleted,
  onProgressSaved,
}: DifficultWordPracticePanelProps) {
  const { difficultWordService } = useReportServices();
  const speechPlayer = useSpeechPlayer();

  const [flowState, setFlowState] = useState<WordPracticeState>("IDLE");
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [isPlayingSelf, setIsPlayingSelf] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState<string | null>(null);
  const [latestResult, setLatestResult] =
    useState<DifficultWordPracticeAttemptDTO | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyStorageReady, setHistoryStorageReady] = useState(true);
  const [historyItems, setHistoryItems] = useState<
    readonly DifficultWordPracticeHistoryItemDTO[]
  >([]);
  const [pendingSavePayload, setPendingSavePayload] =
    useState<CapturedAttemptPayload | null>(null);
  const [retryLoopPaused, setRetryLoopPaused] = useState(false);
  const [failureLabel, setFailureLabel] =
    useState<ShortWordFailureLabel | null>(null);

  const mountedRef = useRef(true);
  const flowGenerationRef = useRef(0);
  const pollTimeoutRef = useRef<number | null>(null);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const captureStartedAtRef = useRef(0);
  const speechObservedRef = useRef(false);
  const browserPulseRef = useRef(false);
  const silenceStartedAtRef = useRef<number | null>(null);
  const browserCollectorRef = useRef(new BrowserTranscriptCollector());
  const browserBestConfRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognitionLike | null>(null);
  const stopCaptureLockRef = useRef(false);
  const autoRetryCountRef = useRef(0);
  const silenceStreakRef = useRef(0);
  const captureTurnRef = useRef<(generation: number) => Promise<void>>(
    async () => undefined,
  );
  const selfAudioRef = useRef<HTMLAudioElement | null>(null);
  const selfAudioUrlRef = useRef<string | null>(null);
  const cleanupRef = useRef<() => void>(() => undefined);
  const didAutoStartRef = useRef(false);

  const speechRecorder = useSpeechRecorder((error) => {
    if (mountedRef.current) {
      setMicError(mapMicrophoneErrorMessage(error));
    }
  });

  const primarySource = word.sources?.[0];
  const wordIndexInQueue = useMemo(
    () =>
      words.findIndex((item) => item.normalized_word === word.normalized_word),
    [word.normalized_word, words],
  );

  const nextWordTarget = useMemo(() => {
    const serverNext = latestResult?.next_recommended_word;
    if (serverNext) {
      const found = words.find((item) => item.normalized_word === serverNext);
      if (found) return found;
    }
    const incompleteOther = words.find(
      (item) =>
        item.normalized_word !== word.normalized_word &&
        item.practice_status !== "COMPLETED",
    );
    if (incompleteOther) return incompleteOther;
    return (
      words.find((item) => item.normalized_word !== word.normalized_word) ??
      null
    );
  }, [latestResult?.next_recommended_word, word.normalized_word, words]);

  const effectiveStatus: DifficultWordPracticeStatus =
    latestResult?.word_progress.practice_status ??
    word.practice_status ??
    "NOT_PRACTICED";

  const clearTimers = useCallback(() => {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, []);

  const stopBrowserRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        try {
          rec.abort?.();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }, []);

  const stopSelfPlayback = useCallback(() => {
    if (selfAudioRef.current) {
      selfAudioRef.current.pause();
      selfAudioRef.current.onended = null;
      selfAudioRef.current.onerror = null;
      selfAudioRef.current = null;
    }
    if (selfAudioUrlRef.current) {
      URL.revokeObjectURL(selfAudioUrlRef.current);
      selfAudioUrlRef.current = null;
    }
    if (mountedRef.current) setIsPlayingSelf(false);
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await difficultWordService.getPracticeHistory(child.id, {
        normalizedWord: word.normalized_word,
        limit: 10,
      });
      if (!mountedRef.current) return;
      setHistoryStorageReady(response.storage_ready);
      setHistoryItems(response.items);
    } catch {
      if (mountedRef.current) {
        setHistoryStorageReady(false);
        setHistoryItems([]);
      }
    } finally {
      if (mountedRef.current) setHistoryLoading(false);
    }
  }, [child.id, difficultWordService, word.normalized_word]);

  useEffect(() => {
    let active = true;
    difficultWordService
      .getPracticeHistory(child.id, {
        normalizedWord: word.normalized_word,
        limit: 10,
      })
      .then((response) => {
        if (!active) return;
        setHistoryStorageReady(response.storage_ready);
        setHistoryItems(response.items);
      })
      .catch(() => {
        if (!active) return;
        setHistoryStorageReady(false);
        setHistoryItems([]);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [child.id, difficultWordService, word.normalized_word]);

  useEffect(() => {
    cleanupRef.current = () => {
      clearTimers();
      stopBrowserRecognition();
      speechPlayer.stop();
      speechRecorder.cancel();
      stopSelfPlayback();
    };
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flowGenerationRef.current += 1;
      cleanupRef.current();
    };
  }, []);

  const submitEvaluation = useCallback(
    async (payload: CapturedAttemptPayload, generation: number) => {
      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }
      setFlowState("EVALUATING");
      setSubmitError(null);
      setPendingSavePayload(null);

      try {
        let evaluated: DifficultWordPracticeAttemptDTO;
        if (difficultWordService.evaluatePracticeWord) {
          evaluated = await difficultWordService.evaluatePracticeWord(
            child.id,
            {
              request_id: payload.requestId,
              normalized_word: word.normalized_word,
              display_text: word.display_text,
              context_phrase: primarySource?.context_phrase ?? undefined,
              audio: payload.audioBlob,
              audio_duration_ms: payload.durationMs,
              audio_quality_status: payload.audioQualityStatus ?? undefined,
              browser_transcript: payload.browserTranscript ?? undefined,
              browser_confidence: payload.browserConfidence ?? undefined,
              book_id: primarySource?.book_id ?? undefined,
              session_id: primarySource?.session_id ?? undefined,
              page_id: primarySource?.page_id ?? undefined,
              page_revision_id: primarySource?.page_revision_id ?? undefined,
              word_id: primarySource?.word_id ?? undefined,
              evidence_word_ids: word.evidence_word_ids,
            },
          );
        } else {
          const started = await difficultWordService.startPractice(child.id, {
            request_id: payload.requestId,
            normalized_word: word.normalized_word,
            display_text: word.display_text,
            evidence_word_ids: word.evidence_word_ids,
          });
          evaluated = await difficultWordService.evaluateAudio(
            child.id,
            started.attempt_id,
            {
              completion_request_id: payload.requestId,
              audio: payload.audioBlob,
              audio_duration_ms: payload.durationMs,
              audio_quality_status: payload.audioQualityStatus ?? undefined,
              browser_transcript: payload.browserTranscript ?? undefined,
              browser_confidence: payload.browserConfidence ?? undefined,
            },
          );
        }

        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }

        setLatestResult(evaluated);
        onAttemptCompleted?.(evaluated);
        await onProgressSaved();
        void refreshHistory();

        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }

        if (evaluated.assessment_status === "CORRECT") {
          autoRetryCountRef.current = 0;
          silenceStreakRef.current = 0;
          setRetryLoopPaused(false);
          setFailureLabel(null);
          setFlowState("SUCCESS");
          try {
            await speechPlayer.play(VOICE_PROMPTS.correctPraise());
          } catch {
            // Audio praise fallback silently ignored if TTS unavailable
          }
          if (!mountedRef.current || generation !== flowGenerationRef.current) {
            return;
          }
          if (
            nextWordTarget &&
            nextWordTarget.normalized_word !== word.normalized_word &&
            nextWordTarget.practice_status !== "COMPLETED"
          ) {
            autoAdvanceTimerRef.current = window.setTimeout(() => {
              if (
                mountedRef.current &&
                generation === flowGenerationRef.current
              ) {
                onSelectWord(nextWordTarget.normalized_word, {
                  autoStart: true,
                });
              }
            }, SHORT_WORD_CAPTURE_CONFIG.autoAdvanceCorrectMs);
          }
        } else if (evaluated.assessment_status === "ENGINE_ERROR") {
          speechRecorder.cancel();
          setFailureLabel(null);
          setFlowState("TECHNICAL_ERROR");
        } else {
          const nextFailureLabel = classifyShortWordFailureLabel(
            evaluated.assessment_status,
            payload.audioQualityStatus,
            evaluated.spoken_transcript,
          );
          setFailureLabel(nextFailureLabel);
          silenceStreakRef.current =
            nextFailureLabel === "Chưa nghe thấy"
              ? silenceStreakRef.current + 1
              : 0;
          const gentleCue =
            evaluated.assessment_status === "INCORRECT"
              ? VOICE_PROMPTS.incorrectGentle(word.display_text)
              : VOICE_PROMPTS.retryGentle(word.display_text);

          if (
            autoRetryCountRef.current <
              SHORT_WORD_CAPTURE_CONFIG.maxAutoRetries &&
            silenceStreakRef.current <
              SHORT_WORD_CAPTURE_CONFIG.maxSilenceStreak
          ) {
            autoRetryCountRef.current += 1;
            setFlowState("INSTRUCTING");
            try {
              await speechPlayer.play(gentleCue);
            } catch {
              // Proceed directly to next listen turn if TTS is unavailable
            }
            if (
              !mountedRef.current ||
              generation !== flowGenerationRef.current
            ) {
              return;
            }
            stopCaptureLockRef.current = false;
            browserCollectorRef.current.reset();
            browserBestConfRef.current = null;
            setLiveTranscript(null);
            await captureTurnRef.current(generation);
          } else {
            speechRecorder.cancel();
            setRetryLoopPaused(true);
            setFlowState("NEEDS_RETRY");
            void speechPlayer.play(gentleCue).catch(() => undefined);
          }
        }
      } catch (error) {
        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }
        setPendingSavePayload(payload);
        setFlowState("TECHNICAL_ERROR");
        if (isServiceError(error) && error.status === 503) {
          setSubmitError(error.message);
        } else {
          setSubmitError(
            "Chưa lưu được kết quả lên máy chủ. Giọng đọc của bé vẫn được giữ nguyên — bấm Lưu lại kết quả nhé.",
          );
        }
      }
    },
    [
      child.id,
      difficultWordService,
      nextWordTarget,
      onAttemptCompleted,
      onProgressSaved,
      onSelectWord,
      primarySource,
      refreshHistory,
      speechPlayer,
      speechRecorder,
      word.display_text,
      word.evidence_word_ids,
      word.normalized_word,
    ],
  );

  const finalizeCaptureAndEvaluate = useCallback(
    async (generation: number) => {
      if (stopCaptureLockRef.current) return;
      stopCaptureLockRef.current = true;
      clearTimers();
      stopBrowserRecognition();

      let blob: Blob | null = null;
      try {
        blob = await speechRecorder.stop();
      } catch {
        blob = null;
      }

      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }

      if (!blob || blob.size === 0) {
        setMicError(
          "Không thu được âm thanh từ micro. Ba mẹ hãy thử lại giúp bé nhé.",
        );
        setFlowState("NEEDS_RETRY");
        return;
      }

      const quality = speechRecorder.getQuality?.();
      const elapsed =
        quality?.durationMs && quality.durationMs > 0
          ? quality.durationMs
          : Math.max(
              0,
              Math.round(performance.now() - captureStartedAtRef.current),
            );

      stopSelfPlayback();
      setRecordedBlob(blob);

      const captured: CapturedAttemptPayload = {
        requestId: createRequestUuid(),
        audioBlob: blob,
        durationMs: elapsed,
        audioQualityStatus: quality?.status,
        browserTranscript: browserCollectorRef.current.getTranscript() || null,
        browserConfidence: browserBestConfRef.current,
      };
      await submitEvaluation(captured, generation);
    },
    [
      clearTimers,
      speechRecorder,
      stopBrowserRecognition,
      stopSelfPlayback,
      submitEvaluation,
    ],
  );

  const captureWordTurn = useCallback(
    async (generation: number) => {
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, SHORT_WORD_CAPTURE_CONFIG.acousticSettleMs),
      );
      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }

      try {
        await speechRecorder.start({
          mode: SHORT_WORD_CAPTURE_CONFIG.mode,
          retainStream: true,
        });
      } catch (error) {
        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }
        setMicError(mapMicrophoneErrorMessage(error));
        setFlowState("PAUSED");
        return;
      }

      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        speechRecorder.cancel();
        return;
      }

      setFlowState("LISTENING");
      captureStartedAtRef.current = performance.now();
      speechObservedRef.current = false;
      browserPulseRef.current = false;
      silenceStartedAtRef.current = null;
      let prevSpeechDurationMs = 0;

      if (typeof window !== "undefined") {
        const win = window as unknown as WindowWithSpeechRecognition;
        const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
        if (SpeechRec) {
          try {
            const rec = new SpeechRec();
            rec.lang = "vi-VN";
            rec.continuous = true;
            rec.interimResults = true;
            rec.maxAlternatives = 1;
            rec.onresult = (event) => {
              if (
                !mountedRef.current ||
                generation !== flowGenerationRef.current
              ) {
                return;
              }
              const addedFinals = browserCollectorRef.current.addResults(event);
              if (addedFinals.length > 0) {
                speechObservedRef.current = true;
                browserPulseRef.current = true;
                silenceStartedAtRef.current = null;
              }
              let interimText = "";
              for (
                let i = event.resultIndex;
                i < event.results.length;
                i += 1
              ) {
                const item = event.results[i];
                const chunk = item?.[0]?.transcript?.trim() ?? "";
                const conf = item?.[0]?.confidence;
                if (!chunk || !hasUsableBrowserConfidence(conf)) continue;
                speechObservedRef.current = true;
                browserPulseRef.current = true;
                silenceStartedAtRef.current = null;
                if (typeof conf === "number" && Number.isFinite(conf)) {
                  browserBestConfRef.current = conf;
                }
                if (!item.isFinal) {
                  interimText = chunk;
                }
              }
              const collected = browserCollectorRef.current.getTranscript();
              const displaySpeech = [collected, interimText]
                .filter(Boolean)
                .join(" ")
                .trim();
              if (displaySpeech) {
                setLiveTranscript(displaySpeech);
              }
            };
            rec.onerror = () => undefined;
            rec.onend = () => {
              if (recognitionRef.current === rec) recognitionRef.current = null;
            };
            recognitionRef.current = rec;
            rec.start();
          } catch {
            recognitionRef.current = null;
          }
        }
      }

      const schedulePoll = () => {
        pollTimeoutRef.current = window.setTimeout(() => {
          pollTimeoutRef.current = null;
          if (!mountedRef.current || generation !== flowGenerationRef.current) {
            return;
          }
          const now = performance.now();
          const elapsedMs = now - captureStartedAtRef.current;
          const quality = speechRecorder.getQuality?.();
          const browserPulse = browserPulseRef.current;
          browserPulseRef.current = false;
          const active = hasShortWordSpeechActivity({
            isSpeakingNow: speechRecorder.getIsSpeaking(),
            audioLevel: speechRecorder.audioLevel,
            quality,
            hasLiveBrowserSpeech: browserPulse,
            speechObserved: speechObservedRef.current,
            previousSpeechDurationMs: prevSpeechDurationMs,
          });
          prevSpeechDurationMs =
            quality?.speechDurationMs ?? prevSpeechDurationMs;
          if (active) {
            speechObservedRef.current = true;
            silenceStartedAtRef.current = null;
          } else if (
            speechObservedRef.current &&
            silenceStartedAtRef.current === null
          ) {
            silenceStartedAtRef.current = now;
          }

          const silenceElapsedMs =
            silenceStartedAtRef.current === null
              ? 0
              : now - silenceStartedAtRef.current;

          if (
            shouldAutoStopShortWordCapture({
              elapsedMs,
              speechObserved: speechObservedRef.current,
              silenceElapsedMs,
            })
          ) {
            void finalizeCaptureAndEvaluate(generation);
            return;
          }
          schedulePoll();
        }, SHORT_WORD_CAPTURE_CONFIG.pollIntervalMs);
      };
      schedulePoll();
    },
    [finalizeCaptureAndEvaluate, speechRecorder],
  );

  useEffect(() => {
    captureTurnRef.current = captureWordTurn;
  }, [captureWordTurn]);

  const startHandsFreePractice = useCallback(async () => {
    const generation = ++flowGenerationRef.current;
    clearTimers();
    stopBrowserRecognition();
    speechPlayer.stop();
    stopSelfPlayback();
    autoRetryCountRef.current = 0;
    silenceStreakRef.current = 0;
    setRetryLoopPaused(false);
    setFailureLabel(null);
    setSampleError(null);
    setMicError(null);
    setSubmitError(null);
    setPendingSavePayload(null);
    setRecordedBlob(null);
    setLatestResult(null);
    setLiveTranscript(null);
    browserCollectorRef.current.reset();
    browserBestConfRef.current = null;
    stopCaptureLockRef.current = false;

    setFlowState("PREPARING");
    try {
      await speechRecorder.prepare();
    } catch (error) {
      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }
      setMicError(mapMicrophoneErrorMessage(error));
      setFlowState("PAUSED");
      return;
    }

    if (!mountedRef.current || generation !== flowGenerationRef.current) {
      speechRecorder.cancel();
      return;
    }

    setFlowState("INSTRUCTING");
    try {
      await speechPlayer.play(VOICE_PROMPTS.introWord(word.display_text));
    } catch {
      // Proceed to microphone even if TTS fails
    }

    if (!mountedRef.current || generation !== flowGenerationRef.current) {
      return;
    }

    await captureWordTurn(generation);
  }, [
    captureWordTurn,
    clearTimers,
    speechPlayer,
    speechRecorder,
    stopBrowserRecognition,
    stopSelfPlayback,
    word.display_text,
  ]);

  function handlePauseSession(): void {
    flowGenerationRef.current += 1;
    clearTimers();
    stopBrowserRecognition();
    speechPlayer.stop();
    speechRecorder.cancel();
    setFlowState("PAUSED");
  }

  useEffect(() => {
    if (!autoStart || didAutoStartRef.current) return;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current || didAutoStartRef.current) return;
      didAutoStartRef.current = true;
      void startHandsFreePractice();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, startHandsFreePractice]);

  async function handlePlaySample(): Promise<void> {
    setSampleError(null);
    stopSelfPlayback();
    try {
      await speechPlayer.play(word.display_text);
    } catch {
      if (mountedRef.current) {
        setSampleError(
          "Chưa phát được giọng đọc mẫu tiếng Việt trên thiết bị này. Bé vẫn có thể đọc cùng ba mẹ nhé.",
        );
      }
    }
  }

  async function handlePlaySelfRecording(): Promise<void> {
    if (!recordedBlob) return;
    if (isPlayingSelf) {
      stopSelfPlayback();
      return;
    }
    stopSelfPlayback();
    const url = URL.createObjectURL(recordedBlob);
    selfAudioUrlRef.current = url;
    const audio = new Audio(url);
    selfAudioRef.current = audio;
    audio.onended = () => stopSelfPlayback();
    audio.onerror = () => stopSelfPlayback();
    setIsPlayingSelf(true);
    try {
      await audio.play();
    } catch {
      stopSelfPlayback();
    }
  }

  const stageThemeClass =
    flowState === "SUCCESS" || flowState === "LISTENING"
      ? "border-primary/30 bg-sky"
      : flowState === "NEEDS_RETRY" || flowState === "TECHNICAL_ERROR"
        ? "border-warning/30 bg-warning-surface"
        : "border-border bg-cream";

  const stageLabel =
    flowState === "PREPARING"
      ? "Chuẩn bị micro"
      : flowState === "INSTRUCTING" || speechPlayer.isPlaying
        ? "Nghe mẫu"
        : flowState === "LISTENING"
          ? "Đang nghe bé"
          : flowState === "EVALUATING" || flowState === "SAVING"
            ? "Đang kiểm tra"
            : flowState === "NEEDS_RETRY" || flowState === "TECHNICAL_ERROR"
              ? (failureLabel ?? "Thử lại")
              : `Luyện đọc cùng ${child.alias}`;

  const statusBadgeClass = PRACTICE_STATUS_CLASSES[effectiveStatus];
  const isBusyActive =
    flowState === "PREPARING" ||
    flowState === "INSTRUCTING" ||
    flowState === "LISTENING" ||
    flowState === "EVALUATING" ||
    flowState === "SAVING";

  return (
    <section
      aria-labelledby="practice-word-heading"
      className="mx-auto flex w-full max-w-[780px] flex-col gap-5 rounded-[24px] border border-[#DCE8E4] bg-white p-5 shadow-sm sm:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#DCE8E4] pb-4">
        <Button
          className="sm:w-auto"
          onClick={() => {
            flowGenerationRef.current += 1;
            clearTimers();
            stopBrowserRecognition();
            speechPlayer.stop();
            speechRecorder.cancel();
            stopSelfPlayback();
            onClose();
          }}
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Quay về danh sách
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          {wordIndexInQueue >= 0 ? (
            <span className="rounded-full bg-[#F6FAF8] px-3 py-1 text-xs font-bold text-[#526970]">
              Từ {wordIndexInQueue + 1}/{words.length}
            </span>
          ) : null}
          <span
            className={`rounded-full border px-3 py-1 text-xs font-extrabold ${statusBadgeClass}`}
          >
            {PRACTICE_STATUS_LABELS[effectiveStatus]}
          </span>
        </div>
      </div>

      {primarySource?.book_title ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[#526970]">
          <BookOpen aria-hidden="true" className="size-4 text-[#147D87]" />
          <span className="font-bold text-[#213C42]">
            {primarySource.book_title}
          </span>
          {primarySource.page_number ? (
            <span>· Trang {primarySource.page_number}</span>
          ) : null}
          {primarySource.context_phrase ? (
            <span className="rounded-lg bg-[#F6FAF8] px-2.5 py-0.5 text-xs italic text-[#526970]">
              “{primarySource.context_phrase}”
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        className={`flex flex-col items-center gap-4 rounded-card border px-5 py-5 text-center transition-colors sm:py-7 ${stageThemeClass}`}
      >
        <p className="text-sm font-extrabold text-primary" aria-live="polite">
          {stageLabel}
        </p>

        {failureLabel && flowState !== "SUCCESS" ? (
          <span className="rounded-full border border-warning/30 bg-white/90 px-3 py-0.5 text-xs font-extrabold text-[#213C42]">
            {failureLabel}
          </span>
        ) : null}

        <h2
          className="text-5xl font-black tracking-tight text-[#213C42] sm:text-6xl"
          id="practice-word-heading"
        >
          {word.display_text}
        </h2>

        <p
          aria-live="polite"
          className="max-w-md text-base font-bold text-[#213C42]"
        >
          {flowState === "PREPARING"
            ? "Đang bật sẵn micro cho bé..."
            : flowState === "INSTRUCTING"
              ? "ViRead đang mời bé đọc..."
              : flowState === "LISTENING"
                ? "Bé đọc từ trên màn hình một lần nhé."
                : flowState === "EVALUATING" || flowState === "SAVING"
                  ? "Đang kiểm tra giọng đọc của bé..."
                  : flowState === "SUCCESS"
                    ? (latestResult?.feedback_message ??
                      VOICE_PROMPTS.correctPraise())
                    : flowState === "NEEDS_RETRY"
                      ? retryLoopPaused
                        ? `${failureLabel ? `${failureLabel}. ` : ""}Mình tạm nghỉ một nhịp nhé. Bé muốn tiếp tục thử hay nhờ ba mẹ giúp?`
                        : (latestResult?.feedback_message ??
                          VOICE_PROMPTS.retryGentle(word.display_text))
                      : flowState === "TECHNICAL_ERROR"
                        ? (latestResult?.feedback_message ??
                          VOICE_PROMPTS.technicalFallback())
                        : flowState === "PAUSED"
                          ? "Đã tạm dừng. Khi sẵn sàng, bé bấm Tiếp tục luyện nhé."
                          : "Bấm Bắt đầu luyện, nghe hướng dẫn rồi đọc từ trên màn hình."}
        </p>

        {latestResult?.spoken_transcript ? (
          <p className="rounded-full bg-white/85 px-4 py-1 text-sm font-semibold text-[#526970]">
            Máy nghe được: “{latestResult.spoken_transcript}”
          </p>
        ) : liveTranscript ? (
          <p className="rounded-full bg-white/85 px-4 py-1 text-sm font-semibold text-[#526970]">
            Đang nghe: “{liveTranscript}”
          </p>
        ) : null}

        {flowState === "SUCCESS" ? (
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-extrabold text-white">
            <CheckCircle2 aria-hidden="true" className="size-4" />
            Hoàn thành từ này
          </div>
        ) : null}
      </div>

      {sampleError ? (
        <StatusMessage tone="warning">{sampleError}</StatusMessage>
      ) : null}
      {micError ? (
        <StatusMessage tone="warning">{micError}</StatusMessage>
      ) : null}
      {submitError ? (
        <StatusMessage tone="warning">
          <div className="flex flex-col gap-3">
            <span>{submitError}</span>
            {pendingSavePayload ? (
              <Button
                className="sm:w-auto sm:self-start"
                onClick={() => {
                  const gen = flowGenerationRef.current;
                  void submitEvaluation(pendingSavePayload, gen);
                }}
                variant="secondary"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                Lưu lại kết quả
              </Button>
            ) : null}
          </div>
        </StatusMessage>
      ) : null}

      <div className="flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:flex-wrap">
        {flowState === "LISTENING" ? (
          <>
            <Button
              className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
              onClick={() =>
                void finalizeCaptureAndEvaluate(flowGenerationRef.current)
              }
              variant="primary"
            >
              <Square aria-hidden="true" className="size-5 fill-current" />
              Dừng ghi âm
            </Button>
            <Button
              className="min-h-14 rounded-2xl sm:w-auto"
              onClick={handlePauseSession}
              variant="secondary"
            >
              <Pause aria-hidden="true" className="size-4" />
              Tạm dừng
            </Button>
          </>
        ) : flowState === "PREPARING" ||
          flowState === "INSTRUCTING" ||
          flowState === "EVALUATING" ||
          flowState === "SAVING" ? (
          <Button
            className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
            disabled
          >
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
            {flowState === "PREPARING" || flowState === "INSTRUCTING"
              ? "Đang chuẩn bị micro..."
              : "Đang chấm kết quả..."}
          </Button>
        ) : flowState === "SUCCESS" ? (
          <>
            {nextWordTarget &&
            nextWordTarget.normalized_word !== word.normalized_word ? (
              <Button
                className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
                onClick={() => {
                  clearTimers();
                  onSelectWord(nextWordTarget.normalized_word);
                }}
              >
                <Sparkles aria-hidden="true" className="size-5" />
                Sang từ tiếp theo ({nextWordTarget.display_text})
                <ArrowRight aria-hidden="true" className="size-4" />
              </Button>
            ) : (
              <Button
                className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
                onClick={() => {
                  clearTimers();
                  onClose();
                }}
              >
                <CheckCircle2 aria-hidden="true" className="size-5" />
                Hoàn thành bài luyện
              </Button>
            )}
            <Button
              className="min-h-14 rounded-2xl sm:w-auto"
              onClick={() => void startHandsFreePractice()}
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Đọc lại từ này
            </Button>
          </>
        ) : flowState === "NEEDS_RETRY" && retryLoopPaused ? (
          <>
            <Button
              className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
              onClick={() => void startHandsFreePractice()}
            >
              <Mic aria-hidden="true" className="size-5" />
              Tiếp tục thử
            </Button>
            <Button
              className="min-h-14 rounded-2xl sm:w-auto"
              onClick={() => {
                handlePauseSession();
                void handlePlaySample();
              }}
              variant="secondary"
            >
              Nhờ ba mẹ giúp
            </Button>
          </>
        ) : (
          <Button
            className="min-h-14 flex-1 rounded-2xl text-base font-extrabold"
            onClick={() => void startHandsFreePractice()}
          >
            <Mic aria-hidden="true" className="size-5" />
            {flowState === "PAUSED"
              ? "Tiếp tục luyện"
              : flowState === "NEEDS_RETRY" || flowState === "TECHNICAL_ERROR"
                ? "Thử lại từ này"
                : "Bắt đầu luyện"}
          </Button>
        )}

        <Button
          className="min-h-14 rounded-2xl sm:w-auto"
          disabled={isBusyActive}
          onClick={() => void handlePlaySample()}
          variant="secondary"
        >
          <Volume2 aria-hidden="true" className="size-5" />
          Nghe phát âm mẫu
        </Button>

        {recordedBlob ? (
          <Button
            className="min-h-14 rounded-2xl sm:w-auto"
            disabled={isBusyActive}
            onClick={() => void handlePlaySelfRecording()}
            variant="quiet"
          >
            <Play aria-hidden="true" className="size-4" />
            {isPlayingSelf ? "Dừng phát" : "Nghe lại giọng bé"}
          </Button>
        ) : null}
      </div>

      <details className="rounded-2xl border border-[#DCE8E4] bg-[#F6FAF8] px-4 py-3 text-sm">
        <summary className="cursor-pointer font-bold text-[#213C42]">
          Lịch sử luyện từ này ({historyItems.length} lượt)
        </summary>
        <div className="mt-3 border-t border-[#DCE8E4] pt-3">
          {historyLoading ? (
            <p className="text-xs text-[#526970]">Đang tải lịch sử...</p>
          ) : !historyStorageReady && historyItems.length === 0 ? (
            <p className="text-xs text-[#526970]">
              Chưa có lượt luyện nào cho từ này.
            </p>
          ) : historyItems.length === 0 ? (
            <p className="text-xs text-[#526970]">
              Bé chưa có lượt luyện nào trước đây cho từ này.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs text-[#526970]">
              {historyItems.map((item) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3 py-2"
                  key={item.attempt_id}
                >
                  <span className="font-bold text-[#213C42]">
                    Lần #{item.attempt_number} ·{" "}
                    {item.assessment_status
                      ? ASSESSMENT_LABELS[item.assessment_status]
                      : "Đang luyện"}
                  </span>
                  <span>
                    {item.spoken_transcript
                      ? `“${item.spoken_transcript}” · `
                      : ""}
                    {formatDateTimeVn(item.completed_at ?? item.started_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}
