"use client";

import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
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
import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { useReportServices } from "@/hooks/use-report-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useRecordingPlayback } from "@/hooks/use-recording-playback";
import { createSpeechService } from "@/lib/api/speech-service";
import { prepareShortWordAudio } from "@/lib/reading/short-word-audio";
import { isServiceError } from "@/lib/api/service-error";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import { BrowserTranscriptCollector } from "@/lib/reading/browser-transcript-collector";
import {
  isInjectedTestSpeechRecognition,
  LocalSegmentSpeechRecognition,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  buildPhonicsLesson,
  evaluatePostPhonicsAttempt,
  READING_MASTERY_LABELS,
  type ReadingWordMasteryOutcome,
} from "@/lib/reading/phonics-lesson";
import { hasUsableBrowserConfidence } from "@/lib/reading/recognition-evidence";
import {
  lockSessionVoice,
  releaseSessionVoiceLock,
} from "@/lib/reading/session-voice-lock";
import {
  isAssistantPromptBleed,
  shortWordContext,
  stripNonSpeechAnnotations,
} from "@/lib/reading/retry-word-recognition";
import {
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";
import {
  isReplaySampleRequest,
  isSpellingHelpRequest,
  isWordHelpRequest,
  MAX_WORD_HELP_ROUNDS,
  WORD_HELP_SILENCE_LIMIT,
} from "@/lib/reading/word-help";
import {
  SHORT_WORD_CAPTURE_CONFIG,
  PHRASE_CAPTURE_CONFIG,
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
  start(track?: MediaStreamTrack): void;
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

const EVALUATION_TIMEOUT_MS = 15_000;
const CUE_TIMEOUT_MS = 8_000;

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
  readonly contextPhrase?: string | null;
  readonly visitedWords?: readonly string[];
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
  contextPhrase: explicitContextPhrase,
  visitedWords,
  child,
  word,
  words,
  onSelectWord,
  onClose,
  onAttemptCompleted,
  onProgressSaved,
}: DifficultWordPracticePanelProps) {
  const { difficultWordService } = useReportServices();
  const speechService = useMemo(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const practiceSessionLockId = `practice_${child.id}`;

  const [flowState, setFlowState] = useState<WordPracticeState>("IDLE");
  const [phraseTurn, setPhraseTurn] = useState(false);
  const [phraseAttemptFailed, setPhraseAttemptFailed] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [coachCue, setCoachCue] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [evaluationDurationMs, setEvaluationDurationMs] = useState<
    number | null
  >(null);
  const {
    playing: isPlayingSelf,
    error: playbackError,
    stop: stopSelfPlayback,
    toggle: toggleSelfPlayback,
  } = useRecordingPlayback();
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
  const [activePhonicsStep, setActivePhonicsStep] = useState<number | null>(
    null,
  );
  const [isPlayingPhonics, setIsPlayingPhonics] = useState(false);
  const [masteryOutcome, setMasteryOutcome] =
    useState<ReadingWordMasteryOutcome | null>(null);

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
  const incorrectCountRef = useRef(0);
  const heardFailuresRef = useRef(0);
  const phraseTurnRef = useRef(false);
  const silenceStreakRef = useRef(0);
  const helpRoundsRef = useRef(0);
  const usedHintRef = useRef(false);
  const usedPhonicsRef = useRef(false);
  const micPreparedRef = useRef(false);
  const evaluationRef = useRef<AbortController | null>(null);
  const captureTurnRef = useRef<(generation: number) => Promise<void>>(
    async () => undefined,
  );
  const cleanupRef = useRef<() => void>(() => undefined);
  const didAutoStartRef = useRef(false);

  const speechRecorder = useSpeechRecorder((error) => {
    if (mountedRef.current) {
      setMicError(mapMicrophoneErrorMessage(error));
    }
  });

  const primarySource = word.sources?.[0];
  const rawContextPhrase =
    explicitContextPhrase ?? primarySource?.context_phrase ?? null;
  const contextPhrase = shortWordContext(word.display_text, rawContextPhrase);
  const phonicsLesson = useMemo(() => {
    if (rawContextPhrase && rawContextPhrase.trim()) {
      const targetNorm = normalizeVietnameseWord(word.display_text);
      const ctxTokens = tokenizeVietnameseText(rawContextPhrase);
      const focusIdx = ctxTokens.findIndex((t) => t === targetNorm);
      if (focusIdx >= 0 && ctxTokens.length > 1) {
        const withCtx = buildPhonicsLesson(rawContextPhrase, {
          focusSyllableIndex: focusIdx,
        });
        if (withCtx.supported) {
          return withCtx;
        }
      }
    }
    return buildPhonicsLesson(word.display_text);
  }, [rawContextPhrase, word.display_text]);
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
      evaluationRef.current?.abort();
      evaluationRef.current = null;
      clearTimers();
      stopBrowserRecognition();
      speechPlayer.stop();
      speechRecorder.cancel();
      stopSelfPlayback();
    };
  });

  useEffect(() => {
    mountedRef.current = true;
    lockSessionVoice(practiceSessionLockId);
    return () => {
      mountedRef.current = false;
      flowGenerationRef.current += 1;
      cleanupRef.current();
      releaseSessionVoiceLock(practiceSessionLockId);
    };
  }, [practiceSessionLockId]);

  const playCue = useCallback(
    async (text: string, generation: number, wordSample = false) => {
      if (!mountedRef.current || generation !== flowGenerationRef.current)
        return false;
      setCoachCue(text);
      try {
        await withRequestDeadline(
          () =>
            wordSample
              ? speechPlayer.play(text, { wordSample: true })
              : speechPlayer.play(text, { coaching: true }),
          undefined,
          CUE_TIMEOUT_MS,
        );
      } catch {
        if (!mountedRef.current || generation !== flowGenerationRef.current)
          return false;
        speechPlayer.stop();
        if (wordSample)
          setSampleError(
            "Chưa phát được giọng đọc mẫu tiếng Việt. Bé có thể đọc cùng ba mẹ nhé.",
          );
      }
      return mountedRef.current && generation === flowGenerationRef.current;
    },
    [speechPlayer],
  );

  const runPhonicsGuidance = useCallback(
    async (generation: number, reopenMicAfter: boolean) => {
      if (!mountedRef.current || generation !== flowGenerationRef.current)
        return;
      stopBrowserRecognition();
      speechRecorder.cancel();
      stopSelfPlayback();
      setSampleError(null);
      setFailureLabel(null);

      if (!phonicsLesson.supported) {
        if (phonicsLesson.canPlayWholeWord) {
          usedHintRef.current = true;
          setFlowState("INSTRUCTING");
          await playCue(word.display_text, generation, true);
          if (
            reopenMicAfter &&
            micPreparedRef.current &&
            mountedRef.current &&
            generation === flowGenerationRef.current
          ) {
            await playCue("Đến lượt con. Con đọc lại nhé.", generation);
            await captureTurnRef.current(generation);
          } else if (
            mountedRef.current &&
            generation === flowGenerationRef.current
          ) {
            setFlowState("IDLE");
          }
        }
        return;
      }

      usedPhonicsRef.current = true;
      setFlowState("INSTRUCTING");
      setIsPlayingPhonics(true);
      setActivePhonicsStep(0);
      setCoachCue(
        `Cô đánh vần từng bước tiếng “${phonicsLesson.focusSyllable}” nhé.`,
      );

      try {
        if (typeof speechPlayer.playPhonicsLesson === "function") {
          await withRequestDeadline(
            () =>
              speechPlayer.playPhonicsLesson(phonicsLesson, {
                onStepChange: (idx) => {
                  if (
                    mountedRef.current &&
                    generation === flowGenerationRef.current
                  ) {
                    setActivePhonicsStep(idx);
                  }
                },
              }),
            undefined,
            CUE_TIMEOUT_MS * 2,
          );
        } else {
          for (const step of phonicsLesson.steps) {
            if (!mountedRef.current || generation !== flowGenerationRef.current)
              break;
            setActivePhonicsStep(step.index);
            await playCue(step.spokenText, generation);
          }
        }
      } catch {
        if (!mountedRef.current || generation !== flowGenerationRef.current)
          return;
        speechPlayer.stop();
        setSampleError(
          "Giọng đánh vần đã khóa đang tạm bận. Bé xem các bước trên màn hình và bấm Thử lại nhé.",
        );
      } finally {
        if (mountedRef.current && generation === flowGenerationRef.current) {
          setIsPlayingPhonics(false);
        }
      }

      if (!mountedRef.current || generation !== flowGenerationRef.current)
        return;

      if (reopenMicAfter && micPreparedRef.current) {
        if (!(await playCue("Đến lượt con. Con đọc lại nhé.", generation)))
          return;
        await captureTurnRef.current(generation);
      } else {
        setFlowState("IDLE");
      }
    },
    [
      phonicsLesson,
      playCue,
      speechPlayer,
      speechRecorder,
      stopBrowserRecognition,
      stopSelfPlayback,
      word.display_text,
    ],
  );

  const retryTurn = useCallback(
    async (
      generation: number,
      reason: "help" | "silence" | "unclear" | "incorrect",
      heardSpeech = false,
    ) => {
      const silence = reason === "silence";
      silenceStreakRef.current = silence ? silenceStreakRef.current + 1 : 0;
      const guide =
        reason === "help" ||
        silenceStreakRef.current >= WORD_HELP_SILENCE_LIMIT;
      if (reason === "incorrect") incorrectCountRef.current += 1;
      if (reason === "incorrect" || (reason === "unclear" && heardSpeech))
        heardFailuresRef.current += 1;
      const switchToPhrase =
        contextPhrase &&
        !phraseTurnRef.current &&
        heardFailuresRef.current >= 2;
      if (
        !switchToPhrase &&
        (incorrectCountRef.current >= 3 ||
          helpRoundsRef.current >= MAX_WORD_HELP_ROUNDS ||
          (!guide &&
            autoRetryCountRef.current >=
              SHORT_WORD_CAPTURE_CONFIG.maxAutoRetries))
      ) {
        speechRecorder.cancel();
        setMasteryOutcome("NEEDS_PRACTICE");
        setRetryLoopPaused(true);
        setFlowState("NEEDS_RETRY");
        return;
      }

      setFlowState("INSTRUCTING");
      if (switchToPhrase) {
        usedHintRef.current = true;
        phraseTurnRef.current = true;
        setPhraseTurn(true);
        if (
          !(await playCue(`Con hãy đọc cả cụm: ${contextPhrase}.`, generation))
        )
          return;
      } else if (guide) {
        helpRoundsRef.current += 1;
        usedHintRef.current = true;
        if (!(await playCue("Không sao đâu. Con nghe cô đọc nhé.", generation)))
          return;
        if (phraseTurnRef.current && contextPhrase) {
          if (!(await playCue(contextPhrase + ".", generation))) return;
        } else if (!(await playCue(word.display_text, generation, true)))
          return;
        if (!(await playCue("Đến lượt con. Con đọc lại nhé.", generation)))
          return;
      } else {
        autoRetryCountRef.current += 1;
        if (reason === "incorrect") usedHintRef.current = true;
        const cue =
          reason === "incorrect"
            ? "Con thử đọc lại nhé."
            : silence
              ? "Cô đang nghe. Con thử đọc nhé."
              : "Cô chưa nghe rõ. Con đọc lại nhé.";
        if (!(await playCue(cue, generation))) return;
      }
      await captureTurnRef.current(generation);
    },
    [contextPhrase, playCue, speechRecorder, word.display_text],
  );

  const scheduleNextWord = useCallback(
    (generation: number, recommended?: string | null) => {
      const eligible = words.filter(
        (item) =>
          item.normalized_word !== word.normalized_word &&
          item.practice_status !== "COMPLETED" &&
          !visitedWords?.includes(item.normalized_word),
      );
      const next =
        eligible.find((item) => item.normalized_word === recommended) ??
        eligible[0];
      if (!next) return;
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current && generation === flowGenerationRef.current) {
          onSelectWord(next.normalized_word, { autoStart: true });
        }
      }, SHORT_WORD_CAPTURE_CONFIG.autoAdvanceCorrectMs);
    },
    [onSelectWord, visitedWords, word.normalized_word, words],
  );

  const submitEvaluation = useCallback(
    async (payload: CapturedAttemptPayload, generation: number) => {
      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }
      if (evaluationRef.current) return;
      const controller = new AbortController();
      const evaluationStart = performance.now();
      evaluationRef.current = controller;
      setFlowState("EVALUATING");
      setSubmitError(null);
      setPendingSavePayload(null);

      try {
        const evaluated = await withRequestDeadline(
          async (signal) => {
            if (difficultWordService.evaluatePracticeWord) {
              return difficultWordService.evaluatePracticeWord(
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
                  page_revision_id:
                    primarySource?.page_revision_id ?? undefined,
                  word_id: primarySource?.word_id ?? undefined,
                  evidence_word_ids: word.evidence_word_ids,
                },
                signal,
              );
            } else {
              const started = await difficultWordService.startPractice(
                child.id,
                {
                  request_id: payload.requestId,
                  normalized_word: word.normalized_word,
                  display_text: word.display_text,
                  evidence_word_ids: word.evidence_word_ids,
                },
                signal,
              );
              signal.throwIfAborted();
              return difficultWordService.evaluateAudio(
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
                signal,
              );
            }
          },
          controller.signal,
          EVALUATION_TIMEOUT_MS,
        );

        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }

        evaluationRef.current = null;
        setEvaluationDurationMs(
          Math.round(performance.now() - evaluationStart),
        );
        setLatestResult(evaluated);
        onAttemptCompleted?.(evaluated);
        void Promise.resolve()
          .then(onProgressSaved)
          .catch(() => undefined);
        void refreshHistory();

        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }

        if (evaluated.assessment_status === "CORRECT") {
          const spokenForCheck =
            evaluated.spoken_transcript ?? payload.browserTranscript ?? "";
          if (
            usedPhonicsRef.current &&
            phonicsLesson.supported &&
            spokenForCheck
          ) {
            const postCheck = evaluatePostPhonicsAttempt(
              spokenForCheck,
              phonicsLesson,
            );
            if (postCheck.kind === "SPELLING_STEP_ONLY") {
              setFlowState("INSTRUCTING");
              if (!(await playCue(postCheck.message, generation))) return;
              await captureTurnRef.current(generation);
              return;
            }
          }
          speechRecorder.cancel();
          autoRetryCountRef.current = 0;
          silenceStreakRef.current = 0;
          setRetryLoopPaused(false);
          setFailureLabel(null);
          setMasteryOutcome(
            usedPhonicsRef.current
              ? "CORRECT_AFTER_SPELLING"
              : usedHintRef.current
                ? "CORRECT_AFTER_HINT"
                : "FIRST_PASS_CORRECT",
          );
          setFlowState("SUCCESS");
          if (!(await playCue(VOICE_PROMPTS.correctPraise(), generation)))
            return;
          scheduleNextWord(generation, evaluated.next_recommended_word);
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
          const spoken =
            evaluated.spoken_transcript ?? payload.browserTranscript ?? "";
          if (isSpellingHelpRequest(spoken, word.display_text)) {
            setFailureLabel(null);
            await runPhonicsGuidance(generation, true);
            return;
          }
          if (isReplaySampleRequest(spoken, word.display_text)) {
            usedHintRef.current = true;
            setFailureLabel(null);
            setFlowState("INSTRUCTING");
            await playCue(word.display_text, generation, true);
            await playCue("Đến lượt con. Con đọc lại nhé.", generation);
            await captureTurnRef.current(generation);
            return;
          }
          if (usedPhonicsRef.current && phonicsLesson.supported && spoken) {
            const postCheck = evaluatePostPhonicsAttempt(spoken, phonicsLesson);
            if (postCheck.kind === "SPELLING_STEP_ONLY") {
              setFailureLabel(null);
              setFlowState("INSTRUCTING");
              if (!(await playCue(postCheck.message, generation))) return;
              await captureTurnRef.current(generation);
              return;
            }
          }
          const askedForHelp =
            evaluated.assessment_status === "UNCERTAIN" &&
            isWordHelpRequest(spoken, word.display_text);
          const spokenTokens = tokenizeVietnameseText(
            stripNonSpeechAnnotations(spoken),
          );
          const heardSpeech =
            spokenTokens.length > 0 &&
            !isAssistantPromptBleed(
              spokenTokens,
              tokenizeVietnameseText(word.display_text),
            );
          if (
            phraseTurnRef.current &&
            !askedForHelp &&
            (evaluated.assessment_status === "INCORRECT" ||
              (evaluated.assessment_status === "UNCERTAIN" && heardSpeech))
          ) {
            speechRecorder.cancel();
            setMasteryOutcome("NEEDS_PRACTICE");
            setPhraseAttemptFailed(true);
            setRetryLoopPaused(true);
            setFlowState("NEEDS_RETRY");
            scheduleNextWord(generation, evaluated.next_recommended_word);
            return;
          }
          await retryTurn(
            generation,
            askedForHelp
              ? "help"
              : nextFailureLabel === "Chưa nghe thấy"
                ? "silence"
                : nextFailureLabel === "Đọc sai"
                  ? "incorrect"
                  : "unclear",
            heardSpeech,
          );
        }
      } catch (error) {
        if (!mountedRef.current || generation !== flowGenerationRef.current) {
          return;
        }
        speechRecorder.cancel();
        setPendingSavePayload(payload);
        setFlowState("TECHNICAL_ERROR");
        if (isServiceError(error) && error.status === 503) {
          setSubmitError(error.message);
        } else if (error instanceof Error && error.name === "TimeoutError") {
          setSubmitError(
            "Máy kiểm tra lâu hơn dự kiến. Bé có thể gửi lại bản ghi vừa rồi.",
          );
        } else {
          setSubmitError(
            "Chưa lưu được kết quả lên máy chủ. Giọng đọc của bé vẫn được giữ nguyên — bấm Lưu lại kết quả nhé.",
          );
        }
      } finally {
        if (evaluationRef.current === controller) evaluationRef.current = null;
      }
    },
    [
      child.id,
      difficultWordService,
      onAttemptCompleted,
      onProgressSaved,
      phonicsLesson,
      primarySource,
      refreshHistory,
      playCue,
      runPhonicsGuidance,
      scheduleNextWord,
      retryTurn,
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
      const recognition = recognitionRef.current;
      // stop() may deliver its last final after the recorder has already stopped.
      const finalResult = recognition
        ? new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 300);
            recognition.onend = () => {
              window.clearTimeout(timer);
              resolve();
            };
            try {
              recognition.stop();
            } catch {
              window.clearTimeout(timer);
              resolve();
            }
          })
        : Promise.resolve();

      let blob: Blob | null = null;
      try {
        blob = await speechRecorder.stop();
      } catch {
        blob = null;
      }
      await finalResult;

      if (!mountedRef.current || generation !== flowGenerationRef.current) {
        return;
      }
      stopBrowserRecognition();
      const transcript = browserCollectorRef.current.getTranscript();
      if (isSpellingHelpRequest(transcript, word.display_text)) {
        setFailureLabel(null);
        setLiveTranscript(null);
        await runPhonicsGuidance(generation, true);
        return;
      }
      if (isReplaySampleRequest(transcript, word.display_text)) {
        usedHintRef.current = true;
        setFailureLabel(null);
        setLiveTranscript(null);
        setFlowState("INSTRUCTING");
        await playCue(word.display_text, generation, true);
        await playCue("Đến lượt con. Con đọc lại nhé.", generation);
        await captureTurnRef.current(generation);
        return;
      }
      if (isWordHelpRequest(transcript, word.display_text)) {
        setFailureLabel(null);
        setLiveTranscript(null);
        await retryTurn(generation, "help");
        return;
      }
      if (usedPhonicsRef.current && phonicsLesson.supported && transcript) {
        const preCheck = evaluatePostPhonicsAttempt(transcript, phonicsLesson);
        if (preCheck.kind === "SPELLING_STEP_ONLY") {
          setFailureLabel(null);
          setLiveTranscript(null);
          setFlowState("INSTRUCTING");
          if (!(await playCue(preCheck.message, generation))) return;
          await captureTurnRef.current(generation);
          return;
        }
      }

      if (!blob || blob.size === 0) {
        speechRecorder.cancel();
        setMicError(
          "Không thu được âm thanh từ micro. Ba mẹ hãy thử lại giúp bé nhé.",
        );
        setFlowState("NEEDS_RETRY");
        return;
      }

      const quality = speechRecorder.getQuality?.();
      const recording =
        quality?.status === "SILENCE" || quality?.status === "NO_AUDIO"
          ? null
          : await prepareShortWordAudio(blob);
      if (!mountedRef.current || generation !== flowGenerationRef.current)
        return;
      if (!recording) {
        setRecordedBlob(null);
        setFailureLabel("Chưa nghe thấy");
        await retryTurn(generation, "silence");
        return;
      }
      const elapsed =
        quality?.durationMs && quality.durationMs > 0
          ? quality.durationMs
          : Math.max(
              0,
              Math.round(performance.now() - captureStartedAtRef.current),
            );

      stopSelfPlayback();
      setRecordedBlob(recording);

      const captured: CapturedAttemptPayload = {
        requestId: createRequestUuid(),
        audioBlob: recording,
        durationMs: elapsed,
        audioQualityStatus: quality?.status,
        browserTranscript: transcript || null,
        browserConfidence: browserBestConfRef.current,
      };
      await submitEvaluation(captured, generation);
    },
    [
      clearTimers,
      phonicsLesson,
      playCue,
      retryTurn,
      runPhonicsGuidance,
      speechRecorder,
      stopBrowserRecognition,
      stopSelfPlayback,
      submitEvaluation,
      word.display_text,
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
      setCoachCue(null);
      setEvaluationDurationMs(null);
      setLiveTranscript(null);
      setLatestResult(null);
      stopCaptureLockRef.current = false;
      browserCollectorRef.current.reset();
      browserBestConfRef.current = null;
      captureStartedAtRef.current = performance.now();
      speechObservedRef.current = false;
      browserPulseRef.current = false;
      silenceStartedAtRef.current = null;
      let prevSpeechDurationMs = 0;

      if (typeof window !== "undefined") {
        const win = window as unknown as WindowWithSpeechRecognition;
        const candidateCtor =
          win.SpeechRecognition || win.webkitSpeechRecognition;
        const track = speechRecorder.getStream()?.getAudioTracks()[0];
        const SpeechRec: SpeechRecognitionConstructor | null =
          isInjectedTestSpeechRecognition(candidateCtor)
            ? candidateCtor
            : track
              ? (class BoundLocalPracticeRec extends LocalSegmentSpeechRecognition {
                  constructor() {
                    super(speechService, () => ({
                      sessionId: practiceSessionLockId,
                      keyterms: [word.display_text],
                    }));
                  }
                } as unknown as SpeechRecognitionConstructor)
              : null;
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
                generation !== flowGenerationRef.current ||
                recognitionRef.current !== rec
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
                if (item.isFinal && addedFinals.includes(chunk)) {
                  browserBestConfRef.current = Math.min(
                    browserBestConfRef.current ?? 1,
                    conf ?? 0,
                  );
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
            const track = speechRecorder.getStream()?.getAudioTracks()[0];
            if (track) rec.start(track);
            else rec.start();
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
              config: phraseTurnRef.current ? PHRASE_CAPTURE_CONFIG : undefined,
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
    [
      finalizeCaptureAndEvaluate,
      practiceSessionLockId,
      speechRecorder,
      speechService,
      word.display_text,
    ],
  );

  useEffect(() => {
    captureTurnRef.current = captureWordTurn;
  }, [captureWordTurn]);

  const startHandsFreePractice = useCallback(async () => {
    const generation = ++flowGenerationRef.current;
    evaluationRef.current?.abort();
    evaluationRef.current = null;
    clearTimers();
    stopBrowserRecognition();
    speechPlayer.stop();
    stopSelfPlayback();
    autoRetryCountRef.current = 0;
    incorrectCountRef.current = 0;
    heardFailuresRef.current = 0;
    phraseTurnRef.current = false;
    setPhraseTurn(false);
    setPhraseAttemptFailed(false);
    silenceStreakRef.current = 0;
    helpRoundsRef.current = 0;
    usedHintRef.current = false;
    usedPhonicsRef.current = false;
    setActivePhonicsStep(null);
    setIsPlayingPhonics(false);
    setMasteryOutcome(null);
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
      micPreparedRef.current = true;
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
    await playCue("Con đọc từ trên màn hình nhé.", generation);

    if (!mountedRef.current || generation !== flowGenerationRef.current) {
      return;
    }

    await captureWordTurn(generation);
  }, [
    captureWordTurn,
    clearTimers,
    playCue,
    speechPlayer,
    speechRecorder,
    stopBrowserRecognition,
    stopSelfPlayback,
  ]);

  function handlePauseSession(): void {
    flowGenerationRef.current += 1;
    cleanupRef.current();
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
    const generation = ++flowGenerationRef.current;
    clearTimers();
    stopBrowserRecognition();
    speechRecorder.cancel();
    setSampleError(null);
    stopSelfPlayback();
    usedHintRef.current = true;
    try {
      await withRequestDeadline(
        () => speechPlayer.play(word.display_text, { wordSample: true }),
        undefined,
        CUE_TIMEOUT_MS,
      );
      if (
        micPreparedRef.current &&
        mountedRef.current &&
        generation === flowGenerationRef.current
      ) {
        await captureWordTurn(generation);
      }
    } catch {
      if (mountedRef.current && generation === flowGenerationRef.current) {
        speechPlayer.stop();
        setSampleError(
          "Chưa phát được giọng đọc mẫu tiếng Việt trên thiết bị này. Bé vẫn có thể đọc cùng ba mẹ nhé.",
        );
      }
    }
  }

  function handlePlayPhonics(): void {
    const generation = ++flowGenerationRef.current;
    clearTimers();
    void runPhonicsGuidance(generation, micPreparedRef.current);
  }

  function handleStopPhonicsOrSample(): void {
    flowGenerationRef.current += 1;
    clearTimers();
    speechPlayer.stop();
    setIsPlayingPhonics(false);
    setFlowState("IDLE");
  }

  async function handlePlaySelfRecording(): Promise<void> {
    if (!recordedBlob) return;
    flowGenerationRef.current += 1;
    clearTimers();
    speechPlayer.stop();
    await toggleSelfPlayback(recordedBlob);
  }

  const stageThemeClass =
    flowState === "SUCCESS"
      ? "border-emerald-300 bg-emerald-50"
      : flowState === "LISTENING" || flowState === "EVALUATING"
        ? "border-amber-300 bg-amber-50"
        : failureLabel === "Đọc sai" &&
            (flowState === "INSTRUCTING" || flowState === "NEEDS_RETRY")
          ? "border-red-300 bg-red-50"
          : flowState === "NEEDS_RETRY" || flowState === "TECHNICAL_ERROR"
            ? "border-warning/30 bg-warning-surface"
            : "border-border bg-cream";

  const stageLabel =
    flowState === "SUCCESS"
      ? "Đọc đúng rồi"
      : flowState === "PREPARING"
        ? "Chuẩn bị micro"
        : flowState === "INSTRUCTING"
          ? "Nghe hướng dẫn"
          : speechPlayer.isPlaying
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
            cleanupRef.current();
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
        data-capture-ms={latestResult?.audio_duration_ms ?? undefined}
        data-evaluation-ms={evaluationDurationMs ?? undefined}
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
        {phraseTurn && contextPhrase && flowState !== "SUCCESS" ? (
          <p className="rounded-control bg-white px-4 py-2 text-xl font-bold text-ink">
            {contextPhrase}
          </p>
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
              ? (coachCue ?? "ViRead đang mời bé đọc...")
              : flowState === "LISTENING"
                ? phraseTurn
                  ? "Bé đọc cả cụm trên màn hình nhé."
                  : "Bé đọc từ trên màn hình một lần nhé."
                : flowState === "EVALUATING" || flowState === "SAVING"
                  ? "Đang kiểm tra giọng đọc của bé..."
                  : flowState === "SUCCESS"
                    ? (latestResult?.feedback_message ??
                      VOICE_PROMPTS.correctPraise())
                    : flowState === "NEEDS_RETRY"
                      ? phraseAttemptFailed
                        ? "Từ này chưa luyện xong. Bé có thể luyện lại sau."
                        : retryLoopPaused
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

        {masteryOutcome ? (
          <span
            className="rounded-full border border-[#DCE8E4] bg-white px-3.5 py-1 text-xs font-extrabold text-[#147D87]"
            data-mastery-outcome={masteryOutcome}
            data-testid="word-mastery-outcome"
          >
            {READING_MASTERY_LABELS[masteryOutcome]}
          </span>
        ) : null}
      </div>

      <PhonicsLessonCard
        activeStepIndex={activePhonicsStep}
        isListeningRetry={flowState === "LISTENING"}
        isPlayingPhonics={isPlayingPhonics}
        isPlayingWord={speechPlayer.isPlaying && !isPlayingPhonics}
        lesson={phonicsLesson}
        onPlayPhonics={handlePlayPhonics}
        onPlayWord={() => void handlePlaySample()}
        onStartRetry={() => void startHandsFreePractice()}
        onStopAudio={handleStopPhonicsOrSample}
      />

      {sampleError ? (
        <StatusMessage tone="warning">{sampleError}</StatusMessage>
      ) : null}
      {micError ? (
        <StatusMessage tone="warning">{micError}</StatusMessage>
      ) : null}
      {playbackError ? (
        <StatusMessage tone="warning">{playbackError}</StatusMessage>
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
            className="min-h-14 rounded-2xl sm:w-auto"
            onClick={handlePauseSession}
            variant="secondary"
          >
            <Pause aria-hidden="true" className="size-4" />
            Tạm dừng
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
            {nextWordTarget &&
            nextWordTarget.normalized_word !== word.normalized_word ? (
              <Button
                className="min-h-14 rounded-2xl sm:w-auto"
                onClick={() => {
                  handlePauseSession();
                  onSelectWord(nextWordTarget.normalized_word);
                }}
                variant="secondary"
              >
                Sang từ tiếp theo
              </Button>
            ) : null}
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
