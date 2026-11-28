"use client";

import {
  ArrowRight,
  Check,
  Mic,
  MicOff,
  RefreshCw,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { invalidateApiReadCacheByPrefix } from "@/lib/api/read-cache";
import { isServiceError } from "@/lib/api/service-error";
import { createSpeechService } from "@/lib/api/speech-service";
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
} from "@/lib/reading/browser-wasm-stt";
import {
  isInjectedTestSpeechRecognition,
  resolveLocalFirstSpeechRecognitionConstructor,
} from "@/lib/reading/local-segment-speech-recognition";
import { isAndroidNativeSpeechAvailable } from "@/lib/reading/native-speech-bridge";
import {
  getActiveSessionVoiceLock,
  getEffectiveTeacherPersona,
  getEffectiveVoiceId,
  lockSessionVoice,
} from "@/lib/reading/session-voice-lock";
import { getSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  analyzeComprehensionVoiceInput,
  choiceLetterForSpeech,
} from "@/lib/reading/comprehension-voice-matcher";
import { EchoGuard } from "@/lib/reading/echo-guard";
import { InteractivePromptSelector } from "@/lib/reading/interactive-prompts";
import { parseVoiceIntent } from "@/lib/reading/voice-intent";
import { getFreshVoiceEngineHealth } from "@/lib/reading/voice-engine-status";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import {
  awaitSttReadyBeforeListening,
  preloadReadingVoiceEngines,
} from "@/lib/reading/voice-preloader";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ComprehensionAnswerResultDTO,
  ComprehensionQuestionViewModelUI,
} from "@/types/reading";

interface ComprehensionQuestionProps {
  child: ChildProfileDTO;
  onComplete: () => void;
  sessionId: string;
}

type QuestionLoadState =
  | { status: "loading" }
  | { status: "ready"; value: ComprehensionQuestionViewModelUI }
  | { status: "error" };

type VoicePhase = "idle" | "reading" | "listening" | "paused";

interface BrowserSpeechRecognitionAlternative {
  readonly transcript?: string;
  readonly confidence?: number;
}
interface BrowserSpeechRecognitionResult {
  readonly isFinal?: boolean;
  readonly epoch?: number;
  readonly onsetAt?: number | null;
  readonly sessionId?: string | null;
  readonly pageId?: string | null;
  readonly turnId?: string;
  readonly segmentId?: string;
  readonly 0?: BrowserSpeechRecognitionAlternative;
}
interface BrowserSpeechRecognitionEvent {
  readonly resultIndex?: number;
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>;
}
interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?: () => void;
}
type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function hasBrowserAudioOrVoiceApi(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as unknown as {
    AudioContext?: unknown;
    webkitAudioContext?: unknown;
  };
  return (
    Boolean(getSpeechRecognitionCtor()) ||
    isAndroidNativeSpeechAvailable() ||
    typeof win.AudioContext === "function" ||
    typeof win.webkitAudioContext === "function" ||
    Boolean(window.speechSynthesis?.getVoices?.().length)
  );
}

const REMIND_SILENCE_MS = 10_000;
const SECOND_REMIND_SILENCE_MS = 12_000;
const MAX_SILENCE_REMINDERS = 2;
const BARE_LETTER_SETTLE_MS = 850;

function hasQuizVoiceCapabilities(): boolean {
  if (typeof window === "undefined") return false;
  return (
    Boolean(getSpeechRecognitionCtor()) ||
    isAndroidNativeSpeechAvailable() ||
    typeof window.AudioContext === "function" ||
    Boolean(window.speechSynthesis?.getVoices?.().length)
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}

function isSkipQuestionVoiceCommand(transcript: string): boolean {
  if (parseVoiceIntent(transcript).type === "SKIP") {
    return true;
  }
  const normalized = transcript
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:(?:cô|thầy)\s+)?(?:ơi\s+)?(?:cho\s+(?:con|bé|em)\s+)?bỏ\s+qua(?:\s+câu(?:\s+này)?)?(?:\s+(?:ạ|nhé|nha|đi))?$/u.test(
    normalized,
  );
}

export function ComprehensionQuestion({
  child,
  onComplete,
  sessionId,
}: ComprehensionQuestionProps) {
  const t = useTranslations("reading");
  const tCommon = useTranslations("common");
  const { comprehensionService } = useReadingServices();
  const teacherPersona = useTeacherPersona();
  const speechService = useMemo(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const echoGuard = useMemo(() => new EchoGuard(), []);
  const prompts = useMemo(() => new InteractivePromptSelector(), []);

  const [loadKey, setLoadKey] = useState(0);
  const [loadState, setLoadState] = useState<QuestionLoadState>({
    status: "loading",
  });
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [result, setResult] = useState<ComprehensionAnswerResultDTO | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const questionGenProgress = useAiProgress({
    active: loadState.status === "loading",
    stages: [
      { atPct: 0, label: tCommon("aiProgress.generatingQuestion") },
      { atPct: 58, label: tCommon("aiProgress.analyzing") },
      { atPct: 86, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 6_000,
  });
  const evalAnswerProgress = useAiProgress({
    active: isSubmitting,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.evaluatingAnswer") },
      { atPct: 72, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 3_500,
  });
  const [progress, setProgress] = useState<{
    position?: number;
    total?: number;
  }>({});
  const [readingChoiceId, setReadingChoiceId] = useState<string | null>(null);
  const [previewChoiceId, setPreviewChoiceId] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voicePausedByUser, setVoicePausedByUser] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null);
  const [wrongCount, setWrongCount] = useState(0);
  const [eliminatedValues, setEliminatedValues] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [revealedHint, setRevealedHint] = useState<string | null>(null);
  const [feedbackPreserveVerbatim, setFeedbackPreserveVerbatim] =
    useState(false);

  const mountedRef = useRef(false);
  const flowGenRef = useRef(0);
  const playbackSeqRef = useRef(0);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const remindTimerRef = useRef<number | null>(null);
  const voiceSettleTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const silenceReminderCountRef = useRef(0);
  const isSubmittingRef = useRef(false);
  const solvedQuestionIdRef = useRef<string | null>(null);
  const advancingQuestionIdRef = useRef<string | null>(null);
  const wrongCountRef = useRef(0);
  const eliminatedValuesRef = useRef<Set<string>>(new Set());
  const choiceButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  const voicePausedRef = useRef(false);
  const activeQuestionRef = useRef<ComprehensionQuestionViewModelUI | null>(
    null,
  );
  const hasNextQuestionRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const speechPlayerRef = useRef(speechPlayer);

  const clearRemindTimer = useCallback(() => {
    if (remindTimerRef.current !== null) {
      window.clearTimeout(remindTimerRef.current);
      remindTimerRef.current = null;
    }
  }, []);

  const clearVoiceSettleTimer = useCallback(() => {
    if (voiceSettleTimerRef.current !== null) {
      window.clearTimeout(voiceSettleTimerRef.current);
      voiceSettleTimerRef.current = null;
    }
  }, []);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopVoiceRecognition = useCallback(() => {
    clearRemindTimer();
    clearVoiceSettleTimer();
    clearRestartTimer();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        if (typeof rec.abort === "function") {
          rec.abort();
        } else {
          rec.stop();
        }
      } catch {
        // Already stopped
      }
    }
  }, [clearRemindTimer, clearRestartTimer, clearVoiceSettleTimer]);

  const stopAllVoice = useCallback(() => {
    flowGenRef.current += 1;
    prefetchAbortRef.current?.abort();
    prefetchAbortRef.current = null;
    stopVoiceRecognition();
    speechPlayerRef.current.stop();
    setReadingChoiceId(null);
    setPreviewChoiceId(null);
  }, [stopVoiceRecognition]);

  useEffect(() => {
    mountedRef.current = true;
    lockSessionVoice(sessionId);
    void preloadReadingVoiceEngines();
    const cleanupVoice = () => {
      flowGenRef.current += 1;
      prefetchAbortRef.current?.abort();
      prefetchAbortRef.current = null;
      clearRemindTimer();
      clearVoiceSettleTimer();
      clearRestartTimer();
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try {
          if (typeof rec.abort === "function") {
            rec.abort();
          } else {
            rec.stop();
          }
        } catch {
          // ignore
        }
      }
      speechPlayerRef.current.stop();
    };
    const handlePageHide = () => {
      cleanupVoice();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", handlePageHide);
      cleanupVoice();
    };
  }, [clearRemindTimer, clearRestartTimer, clearVoiceSettleTimer, sessionId]);

  const speakGuarded = useCallback(
    async (
      text: string,
      gen: number,
      options?: { readonly adaptPersona?: boolean },
    ): Promise<boolean> => {
      if (!mountedRef.current || gen !== flowGenRef.current) return false;
      const spokenText =
        options?.adaptPersona === false
          ? text
          : adaptTextToTeacherPersona(
              text,
              getEffectiveTeacherPersona().gender,
            );
      const id = `quiz-tts-${(playbackSeqRef.current += 1)}`;
      echoGuard.playbackStarted(id, spokenText, performance.now());
      try {
        await speechPlayerRef.current.play(spokenText, { coaching: true });
        return mountedRef.current && gen === flowGenRef.current;
      } catch {
        return mountedRef.current && gen === flowGenRef.current;
      } finally {
        echoGuard.playbackEnded(id, performance.now());
      }
    },
    [echoGuard],
  );

  // Remembered across reloads so the progress bar does not jump while loading.
  const questionPosition = progress.position;
  const questionTotal = progress.total;
  const hasNextQuestion =
    questionPosition !== undefined &&
    questionTotal !== undefined &&
    questionPosition < questionTotal;

  const advanceToNextQuestion = useCallback(
    (expectedQuestionId?: string) => {
      if (
        expectedQuestionId &&
        advancingQuestionIdRef.current === expectedQuestionId
      ) {
        return;
      }
      if (expectedQuestionId) {
        advancingQuestionIdRef.current = expectedQuestionId;
      }
      stopAllVoice();
      if (!hasNextQuestionRef.current) {
        onCompleteRef.current();
        return;
      }
      solvedQuestionIdRef.current = null;
      wrongCountRef.current = 0;
      eliminatedValuesRef.current = new Set();
      silenceReminderCountRef.current = 0;
      setWrongCount(0);
      setEliminatedValues(new Set());
      setRevealedHint(null);
      setSelectedAnswer(null);
      setResult(null);
      setFeedbackNote(null);
      setFeedbackPreserveVerbatim(false);
      invalidateApiReadCacheByPrefix(
        `/tutor/sessions/${encodeURIComponent(sessionId)}/questions`,
      );
      setLoadState({ status: "loading" });
      setLoadKey((key) => key + 1);
    },
    [sessionId, stopAllVoice],
  );

  const startVoiceListenRef = useRef<
    (value: ComprehensionQuestionViewModelUI, gen: number) => void
  >(() => undefined);
  const readQuestionAloudRef = useRef<
    (value: ComprehensionQuestionViewModelUI) => Promise<void>
  >(async () => undefined);

  const submitAnswer = useCallback(
    async (answer: string, source: "click" | "voice" = "click") => {
      const activeValue = activeQuestionRef.current;
      if (!activeValue || isSubmittingRef.current) return;
      if (
        result?.is_correct ||
        solvedQuestionIdRef.current === activeValue.question.id
      ) {
        return;
      }

      const submittedQuestionId = activeValue.question.id;
      // Lock synchronously and cancel any active settle timer, STT, and TTS
      // so simultaneous touch + STT cannot double-submit.
      isSubmittingRef.current = true;
      clearVoiceSettleTimer();
      stopAllVoice();
      const gen = flowGenRef.current;

      setSelectedAnswer(answer);
      setIsSubmitting(true);
      setResult(null);
      setFeedbackNote(null);
      setFeedbackPreserveVerbatim(false);

      let nextResult: ComprehensionAnswerResultDTO | null = null;
      try {
        nextResult = await comprehensionService.submitAnswer(
          sessionId,
          submittedQuestionId,
          answer,
        );
        if (
          mountedRef.current &&
          activeQuestionRef.current?.question.id === submittedQuestionId
        ) {
          if (nextResult.is_correct) {
            solvedQuestionIdRef.current = submittedQuestionId;
          }
          setResult(nextResult);
        }
      } catch (error) {
        if (
          mountedRef.current &&
          activeQuestionRef.current?.question.id === submittedQuestionId
        ) {
          setSelectedAnswer(null);
          setResult(null);
          setFeedbackNote(
            isServiceError(error)
              ? error.message
              : adaptTextToTeacherPersona(
                  "Cô chưa lưu được câu trả lời. Con chọn hoặc nói lại giúp cô nhé!",
                  getEffectiveTeacherPersona().gender,
                ),
          );
        }
      } finally {
        isSubmittingRef.current = false;
        if (mountedRef.current) setIsSubmitting(false);
      }

      if (
        !mountedRef.current ||
        !nextResult ||
        activeQuestionRef.current?.question.id !== submittedQuestionId
      ) {
        return;
      }

      const storyHint = nextResult.story_hint?.trim() || null;
      const canUseVoice =
        hasQuizVoiceCapabilities() &&
        gen === flowGenRef.current &&
        !voicePausedRef.current;

      if (nextResult.is_correct) {
        setFeedbackPreserveVerbatim(false);
        if (source === "voice" || canUseVoice) {
          const praise = prompts.next("quizCorrect");
          setFeedbackNote(praise);
          setFeedbackPreserveVerbatim(false);
          setVoicePhase("reading");
          const stillCurrent = await speakGuarded(praise, gen);
          if (stillCurrent && mountedRef.current && !voicePausedRef.current) {
            advanceToNextQuestion(submittedQuestionId);
          }
        }
        return;
      }

      // Wrong answer: 3-step anti-stuck ladder
      const nextWrongCount = wrongCountRef.current + 1;
      wrongCountRef.current = nextWrongCount;
      setWrongCount(nextWrongCount);
      const nextEliminated = new Set(eliminatedValuesRef.current);
      nextEliminated.add(answer);
      eliminatedValuesRef.current = nextEliminated;
      setEliminatedValues(nextEliminated);

      const remainingChoices = activeValue.choices.filter(
        (c) => !nextEliminated.has(c.value),
      );
      const activeTeacherGender = getEffectiveTeacherPersona().gender;

      if (nextWrongCount >= 3) {
        solvedQuestionIdRef.current = submittedQuestionId;
        const framingLead = adaptTextToTeacherPersona(
          "Không sao đâu con!",
          activeTeacherGender,
        );
        const explainText =
          remainingChoices.length === 1
            ? `${framingLead} Đáp án đúng là ${remainingChoices[0].id}: “${remainingChoices[0].label}”.${storyHint ? ` ${storyHint}` : ""} Mình sang câu tiếp theo nhé!`
            : storyHint
              ? `${framingLead} Gợi ý từ bài đọc: ${storyHint} Mình sang câu tiếp theo nhé!`
              : `${framingLead} Mình cùng sang câu tiếp theo nhé!`;
        setFeedbackNote(explainText);
        setFeedbackPreserveVerbatim(true);
        setRevealedHint(explainText);
        if (source === "voice" || canUseVoice) {
          setVoicePhase("reading");
          const stillCurrent = await speakGuarded(explainText, gen, {
            adaptPersona: false,
          });
          if (stillCurrent && mountedRef.current && !voicePausedRef.current) {
            advanceToNextQuestion(submittedQuestionId);
          }
        } else {
          advanceToNextQuestion(submittedQuestionId);
        }
        return;
      }

      if (nextWrongCount === 2) {
        const adaptedNarrowLead = adaptTextToTeacherPersona(
          remainingChoices.length === 1
            ? "Mình loại bớt đáp án chưa đúng nhé. Chỉ còn đáp án __VIREAD_CHOICE_ID__: “__VIREAD_CHOICE_LABEL__” thôi!"
            : `Mình loại bớt đáp án chưa đúng nhé. Con xem ${remainingChoices.length} lựa chọn còn lại nha!`,
          activeTeacherGender,
        );
        const narrowPrefix =
          remainingChoices.length === 1
            ? adaptedNarrowLead
                .replace("__VIREAD_CHOICE_ID__", remainingChoices[0].id)
                .replace("__VIREAD_CHOICE_LABEL__", remainingChoices[0].label)
            : adaptedNarrowLead;
        const step2Text = storyHint
          ? `${narrowPrefix} ${storyHint}`
          : narrowPrefix;
        setFeedbackNote(step2Text);
        setFeedbackPreserveVerbatim(true);
        setRevealedHint(step2Text);
        if (source === "voice" || canUseVoice) {
          setVoicePhase("reading");
          const stillCurrent = await speakGuarded(step2Text, gen, {
            adaptPersona: false,
          });
          if (
            stillCurrent &&
            mountedRef.current &&
            !voicePausedRef.current &&
            activeQuestionRef.current?.question.id === submittedQuestionId
          ) {
            if (source === "voice") {
              startVoiceListenRef.current(activeValue, gen);
            } else {
              setVoicePhase("idle");
            }
          }
        }
        return;
      }

      // Wrong #1 -> story_hint
      if (source !== "voice") {
        if (storyHint) {
          // Keep story_hint verbatim so book characters ("Cô Tấm", "cô tiên") are never altered.
          setFeedbackNote(storyHint);
          setRevealedHint(storyHint);
          setFeedbackPreserveVerbatim(true);
          // Read story_hint aloud even on touch mistakes so Grade-1 readers hear
          // the clue immediately; tapping any other choice barges in via stopAllVoice().
          if (canUseVoice) {
            lockSessionVoice(sessionId);
            setVoicePhase("reading");
            const stillCurrent = await speakGuarded(storyHint, gen, {
              adaptPersona: false,
            });
            if (
              stillCurrent &&
              mountedRef.current &&
              !voicePausedRef.current &&
              activeQuestionRef.current?.question.id === submittedQuestionId
            ) {
              setVoicePhase("idle");
            }
          }
        }
        return;
      }

      if (gen !== flowGenRef.current || voicePausedRef.current) {
        return;
      }

      const chosen = activeValue.choices.find((c) => c.value === answer);
      const activeGender = getEffectiveTeacherPersona().gender;
      let encourage: string;
      let preserveVerbatim = false;
      if (storyHint) {
        setRevealedHint(storyHint);
        preserveVerbatim = true;
        if (chosen) {
          // Adapt ONLY the framing template BEFORE interpolating story text
          // so book characters ("Cô Tấm", "cô tiên") in label or storyHint are NEVER rewritten.
          const adaptedFrame = adaptTextToTeacherPersona(
            t("comprehension.chosenCorrectFeedback", {
              label: "__VIREAD_CHOICE_LABEL__",
              hint: "__VIREAD_STORY_HINT__",
            }),
            activeGender,
          );
          encourage = adaptedFrame
            .replace("__VIREAD_CHOICE_LABEL__", chosen.label)
            .replace("__VIREAD_STORY_HINT__", storyHint);
        } else {
          encourage = storyHint;
        }
      } else if (chosen) {
        preserveVerbatim = true;
        const adaptedFrame = adaptTextToTeacherPersona(
          t("comprehension.chosenWrongFeedback", {
            label: "__VIREAD_CHOICE_LABEL__",
          }),
          activeGender,
        );
        encourage = adaptedFrame.replace(
          "__VIREAD_CHOICE_LABEL__",
          chosen.label,
        );
      } else {
        encourage = prompts.next("quizTryAgain");
      }
      setFeedbackNote(encourage);
      setFeedbackPreserveVerbatim(preserveVerbatim);
      setVoicePhase("reading");
      const stillCurrent = await speakGuarded(encourage, gen, {
        adaptPersona: !preserveVerbatim,
      });
      if (
        stillCurrent &&
        mountedRef.current &&
        !voicePausedRef.current &&
        activeQuestionRef.current?.question.id === submittedQuestionId
      ) {
        startVoiceListenRef.current(activeValue, gen);
      }
    },
    [
      advanceToNextQuestion,
      clearVoiceSettleTimer,
      comprehensionService,
      prompts,
      result?.is_correct,
      sessionId,
      speakGuarded,
      stopAllVoice,
      t,
    ],
  );

  const startVoiceListen = useCallback(
    (value: ComprehensionQuestionViewModelUI, gen: number) => {
      if (
        !mountedRef.current ||
        gen !== flowGenRef.current ||
        voicePausedRef.current
      ) {
        return;
      }
      const rawCtor = getSpeechRecognitionCtor();
      const freshHealth = getFreshVoiceEngineHealth();
      const localSttReady = Boolean(
        freshHealth?.local.available && freshHealth.local.stt_ready,
      );
      const needsWasmWarmup =
        !isAndroidNativeSpeechAvailable() &&
        !isInjectedTestSpeechRecognition(rawCtor) &&
        !localSttReady &&
        detectBrowserWasmSttSupport().supported &&
        !getBrowserWasmSttClient().isReady();

      const beginRecognition = () => {
        if (
          !mountedRef.current ||
          gen !== flowGenRef.current ||
          voicePausedRef.current
        ) {
          return;
        }
        const boundQuestionId = value.question.id;
        const boundPageId = `quiz:${boundQuestionId}`;
        lockSessionVoice(sessionId);
        const Ctor = resolveLocalFirstSpeechRecognitionConstructor(
          window as unknown as {
            SpeechRecognition?: BrowserSpeechRecognitionCtor;
            webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
            AudioContext?: typeof AudioContext;
            webkitAudioContext?: typeof AudioContext;
          },
          speechService,
          () => ({ sessionId, pageId: boundPageId }),
        ) as BrowserSpeechRecognitionCtor | undefined;
        if (!Ctor) {
          setVoicePhase("idle");
          return;
        }
        stopVoiceRecognition();

        let rec: BrowserSpeechRecognition;
        try {
          rec = new Ctor();
        } catch {
          setVoicePhase("idle");
          return;
        }

        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = "vi-VN";
        rec.maxAlternatives = 1;
        recognitionRef.current = rec;
        setVoicePhase("listening");

        let processedUpTo = -1;
        let fatalError = false;
        let consecutiveRestarts = 0;
        let networkErrorStreak = 0;
        let maxEpochSeen = -1;
        const seenFinalTurnIds = new Set<string>();
        const SETTLE_IGNORED_POLITE = new Set([
          "ạ",
          "nhé",
          "nha",
          "ơi",
          "à",
          "ờ",
          "ừ",
          "ừm",
          "nhỉ",
          "ha",
          "dạ",
          "vâng",
          "thưa",
        ]);

        const isItemFencedIn = (
          item: BrowserSpeechRecognitionResult,
        ): boolean => {
          if (item.sessionId != null && item.sessionId !== sessionId)
            return false;
          if (item.pageId != null && item.pageId !== boundPageId) return false;
          if (typeof item.epoch === "number") {
            if (item.epoch < maxEpochSeen) return false;
            maxEpochSeen = item.epoch;
          }
          return true;
        };

        const armReminder = () => {
          clearRemindTimer();
          if (silenceReminderCountRef.current >= MAX_SILENCE_REMINDERS) return;
          const delayMs =
            silenceReminderCountRef.current === 0
              ? REMIND_SILENCE_MS
              : SECOND_REMIND_SILENCE_MS;
          remindTimerRef.current = window.setTimeout(() => {
            if (
              !mountedRef.current ||
              gen !== flowGenRef.current ||
              voicePausedRef.current ||
              isSubmittingRef.current ||
              solvedQuestionIdRef.current === boundQuestionId ||
              activeQuestionRef.current?.question.id !== boundQuestionId
            ) {
              return;
            }
            silenceReminderCountRef.current += 1;
            stopVoiceRecognition();
            setVoicePhase("reading");
            void speakGuarded(prompts.next("quizRemind"), gen).then((ok) => {
              if (
                ok &&
                mountedRef.current &&
                !voicePausedRef.current &&
                activeQuestionRef.current?.question.id === boundQuestionId
              ) {
                startVoiceListenRef.current(value, gen);
              }
            });
          }, delayMs);
        };

        armReminder();

        rec.onresult = (event) => {
          if (
            !mountedRef.current ||
            gen !== flowGenRef.current ||
            recognitionRef.current !== rec ||
            isSubmittingRef.current ||
            solvedQuestionIdRef.current === boundQuestionId ||
            activeQuestionRef.current?.question.id !== boundQuestionId
          ) {
            return;
          }
          // Check interim provisional highlight (only previews, NEVER submits!)
          for (let idx = event.results.length - 1; idx >= 0; idx -= 1) {
            const item = event.results[idx];
            if (!item || item.isFinal) continue;
            if (!isItemFencedIn(item)) continue;
            const interimText = item[0]?.transcript?.trim() ?? "";
            if (interimText) {
              // Cancel any pending bare-letter settle timer as soon as the child speaks again
              clearVoiceSettleTimer();
              armReminder();
              const interimAnalysis = analyzeComprehensionVoiceInput(
                interimText,
                value.choices,
              );
              setPreviewChoiceId(
                interimAnalysis.type === "CHOICE"
                  ? interimAnalysis.choice.id
                  : null,
              );
            } else {
              setPreviewChoiceId(null);
            }
            break;
          }

          const start = Math.max(event.resultIndex ?? 0, processedUpTo + 1);
          for (let idx = start; idx < event.results.length; idx += 1) {
            const item = event.results[idx];
            if (!item?.isFinal) continue;
            processedUpTo = idx;
            if (!isItemFencedIn(item)) continue;
            const turnKey = item.turnId ?? item.segmentId;
            if (turnKey) {
              if (seenFinalTurnIds.has(turnKey)) continue;
              seenFinalTurnIds.add(turnKey);
            }
            clearVoiceSettleTimer();
            const transcript = (item[0]?.transcript ?? "")
              .normalize("NFC")
              .trim();
            if (!transcript) continue;
            armReminder();
            const confidence = item[0]?.confidence;
            if (
              typeof confidence === "number" &&
              confidence > 0 &&
              confidence < 0.35
            ) {
              continue;
            }

            // Block echo from our own question / option TTS using real VAD onsetAt!
            const onsetAt =
              typeof item.onsetAt === "number" && Number.isFinite(item.onsetAt)
                ? item.onsetAt
                : null;
            if (
              !echoGuard.evaluate({
                text: transcript,
                receivedAt: performance.now(),
                onsetAt,
              }).accept
            ) {
              continue;
            }
            consecutiveRestarts = 0;
            networkErrorStreak = 0;

            if (isSkipQuestionVoiceCommand(transcript)) {
              setPreviewChoiceId(null);
              stopVoiceRecognition();
              solvedQuestionIdRef.current = boundQuestionId;
              const remainingChoices = value.choices.filter(
                (c) => !eliminatedValuesRef.current.has(c.value),
              );
              const skipExplain =
                remainingChoices.length === 1
                  ? `Được rồi con nhé! Đáp án là ${remainingChoices[0].id}: “${remainingChoices[0].label}”. Mình sang câu tiếp theo nhé!`
                  : "Được rồi con nhé! Mình cùng sang câu tiếp theo nhé!";
              setFeedbackNote(skipExplain);
              setFeedbackPreserveVerbatim(false);
              setVoicePhase("reading");
              void speakGuarded(skipExplain, gen).then((ok) => {
                if (ok && mountedRef.current && !voicePausedRef.current) {
                  advanceToNextQuestion(boundQuestionId);
                }
              });
              return;
            }

            const analysis = analyzeComprehensionVoiceInput(
              transcript,
              value.choices,
            );
            if (analysis.type === "STOP") {
              setPreviewChoiceId(null);
              voicePausedRef.current = true;
              setVoicePausedByUser(true);
              setVoicePhase("paused");
              stopAllVoice();
              return;
            }
            if (analysis.type === "REPLAY") {
              setPreviewChoiceId(null);
              void readQuestionAloudRef.current(value);
              return;
            }
            if (
              analysis.type === "CONFLICT" ||
              analysis.type === "AMBIGUOUS" ||
              analysis.type === "NEGATED"
            ) {
              setPreviewChoiceId(null);
              const promptMsg = adaptTextToTeacherPersona(
                analysis.clarificationPrompt,
                getEffectiveTeacherPersona().gender,
              );
              setFeedbackNote(promptMsg);
              setFeedbackPreserveVerbatim(false);
              stopVoiceRecognition();
              setVoicePhase("reading");
              void speakGuarded(promptMsg, gen).then((ok) => {
                if (
                  ok &&
                  mountedRef.current &&
                  !voicePausedRef.current &&
                  activeQuestionRef.current?.question.id === boundQuestionId
                ) {
                  startVoiceListenRef.current(value, gen);
                }
              });
              return;
            }
            if (analysis.type === "CHOICE") {
              setPreviewChoiceId(analysis.choice.id);
              const meaningfulWords = transcript
                .toLowerCase()
                .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
                .split(/\s+/u)
                .filter((w) => w && !SETTLE_IGNORED_POLITE.has(w));
              // Bare single-letter utterance ("A", "A ạ") waits 850ms so cross-segment
              // self-correction ("A" -> "à không, con chọn B") can retract cleanly.
              const settleMs =
                analysis.matchedBy === "letter" && meaningfulWords.length <= 1
                  ? BARE_LETTER_SETTLE_MS
                  : 0;
              if (settleMs > 0) {
                const targetVal = analysis.choice.value;
                voiceSettleTimerRef.current = window.setTimeout(() => {
                  voiceSettleTimerRef.current = null;
                  if (
                    !mountedRef.current ||
                    gen !== flowGenRef.current ||
                    isSubmittingRef.current ||
                    solvedQuestionIdRef.current === boundQuestionId ||
                    activeQuestionRef.current?.question.id !== boundQuestionId
                  ) {
                    return;
                  }
                  void submitAnswer(targetVal, "voice");
                }, settleMs);
              } else {
                void submitAnswer(analysis.choice.value, "voice");
              }
              return;
            }
            setPreviewChoiceId(null);
          }
        };

        rec.onerror = (event) => {
          if (recognitionRef.current !== rec) return;
          if (
            event.error === "not-allowed" ||
            event.error === "service-not-allowed" ||
            event.error === "stt-unavailable" ||
            event.error === "local-stt-unavailable" ||
            event.error === "audio-capture" ||
            event.error === "language-not-supported"
          ) {
            fatalError = true;
            stopVoiceRecognition();
            setVoicePhase("idle");
          } else if (event.error === "network") {
            networkErrorStreak += 1;
            if (networkErrorStreak >= 3) {
              fatalError = true;
              stopVoiceRecognition();
              setVoicePhase("idle");
            }
          }
        };

        rec.onend = () => {
          if (recognitionRef.current !== rec) return;
          if (fatalError) {
            stopVoiceRecognition();
            setVoicePhase("idle");
            return;
          }
          if (
            mountedRef.current &&
            gen === flowGenRef.current &&
            !voicePausedRef.current &&
            !isSubmittingRef.current
          ) {
            if (consecutiveRestarts >= 5) {
              stopVoiceRecognition();
              setVoicePhase("idle");
              return;
            }
            consecutiveRestarts += 1;
            // Reset index cursor for the new recognition cycle so results starting
            // at resultIndex=0 after restart are never skipped.
            processedUpTo = -1;
            const backoffMs =
              networkErrorStreak > 0
                ? Math.min(4_000, 500 * 2 ** (networkErrorStreak - 1))
                : 0;
            const restartNow = () => {
              if (
                recognitionRef.current !== rec ||
                !mountedRef.current ||
                gen !== flowGenRef.current ||
                voicePausedRef.current ||
                isSubmittingRef.current
              ) {
                return;
              }
              try {
                rec.start();
              } catch {
                stopVoiceRecognition();
                setVoicePhase("idle");
              }
            };
            if (backoffMs > 0) {
              clearRestartTimer();
              restartTimerRef.current = window.setTimeout(() => {
                restartTimerRef.current = null;
                restartNow();
              }, backoffMs);
            } else {
              restartNow();
            }
          }
        };

        try {
          rec.start();
        } catch {
          recognitionRef.current = null;
          setVoicePhase("idle");
        }
      };

      if (needsWasmWarmup) {
        void awaitSttReadyBeforeListening(4_000)
          .catch(() => false)
          .then(() => beginRecognition());
        return;
      }
      beginRecognition();
    },
    [
      advanceToNextQuestion,
      clearRemindTimer,
      clearRestartTimer,
      clearVoiceSettleTimer,
      echoGuard,
      prompts,
      sessionId,
      speakGuarded,
      speechService,
      stopAllVoice,
      stopVoiceRecognition,
      submitAnswer,
    ],
  );

  const readQuestionAloud = useCallback(
    async (value: ComprehensionQuestionViewModelUI) => {
      if (!mountedRef.current || voicePausedRef.current) return;
      // Only auto-start voice walkthrough when the browser supports voice
      // recognition or speech synthesis (keeps non-audio unit environments calm).
      if (!hasBrowserAudioOrVoiceApi()) return;
      lockSessionVoice(sessionId);

      stopAllVoice();
      const gen = flowGenRef.current;
      silenceReminderCountRef.current = 0;
      setVoicePhase("reading");

      // Start the question prompt first so it gets first priority on the local voice
      // worker (lowest TTFA), then pre-fetch choices B/C/D in background with an
      // AbortSignal tied to stopAllVoice() / unmount.
      // Never apply teacher-persona rewrite to story questions or answer choices!
      const questionPromise = speakGuarded(value.question.prompt, gen, {
        adaptPersona: false,
      });

      if (value.choices.length > 1) {
        const prefetchChoices = value.choices.slice(1).map((choice, offset) => {
          const letter = choiceLetterForSpeech(choice, offset + 1);
          return `Đáp án ${letter}: ${choice.label}`;
        });
        const prefetchController = new AbortController();
        prefetchAbortRef.current = prefetchController;
        const player = speechPlayerRef.current;
        const waitForQuestionDispatch = () =>
          new Promise<void>((resolve) => {
            if (prefetchController.signal.aborted) {
              resolve();
              return;
            }
            const timer = window.setTimeout(() => {
              prefetchController.signal.removeEventListener("abort", onAbort);
              resolve();
            }, 50);
            const onAbort = () => {
              window.clearTimeout(timer);
              resolve();
            };
            prefetchController.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          });
        if (typeof player.prefetch === "function") {
          void (async () => {
            await waitForQuestionDispatch();
            for (const phrase of prefetchChoices) {
              if (
                !mountedRef.current ||
                gen !== flowGenRef.current ||
                prefetchController.signal.aborted
              ) {
                break;
              }
              await player.prefetch!(phrase, {
                coaching: true,
                signal: prefetchController.signal,
              });
            }
          })();
        } else if (typeof speechService.synthesize === "function") {
          void (async () => {
            await waitForQuestionDispatch();
            for (const phrase of prefetchChoices) {
              if (
                !mountedRef.current ||
                gen !== flowGenRef.current ||
                prefetchController.signal.aborted
              ) {
                break;
              }
              try {
                const locked = getActiveSessionVoiceLock();
                await speechService.synthesize(phrase, {
                  sessionId,
                  voiceId: locked?.voiceId ?? getEffectiveVoiceId(),
                  speed: locked?.speed ?? getSpeechPreferences().speed,
                  signal: prefetchController.signal,
                });
              } catch {
                // Best-effort warmup only
              }
            }
          })();
        }
      }

      if (!(await questionPromise)) return;

      for (let i = 0; i < value.choices.length; i += 1) {
        const choice = value.choices[i];
        const letter = choiceLetterForSpeech(choice, i);
        if (!mountedRef.current || gen !== flowGenRef.current) return;
        setReadingChoiceId(choice.id);
        const ok = await speakGuarded(
          `Đáp án ${letter}: ${choice.label}`,
          gen,
          { adaptPersona: false },
        );
        if (!ok) {
          if (mountedRef.current) setReadingChoiceId(null);
          return;
        }
      }

      if (!mountedRef.current || gen !== flowGenRef.current) return;
      setReadingChoiceId(null);
      if (!(await speakGuarded(prompts.next("quizAskChoice"), gen))) return;

      if (mountedRef.current && gen === flowGenRef.current) {
        startVoiceListenRef.current(value, gen);
      }
    },
    [prompts, sessionId, speakGuarded, speechService, stopAllVoice],
  );

  useEffect(() => {
    onCompleteRef.current = onComplete;
    speechPlayerRef.current = speechPlayer;
    hasNextQuestionRef.current = hasNextQuestion;
    startVoiceListenRef.current = startVoiceListen;
    readQuestionAloudRef.current = readQuestionAloud;
  });

  useEffect(() => {
    let active = true;
    solvedQuestionIdRef.current = null;
    advancingQuestionIdRef.current = null;
    wrongCountRef.current = 0;
    eliminatedValuesRef.current = new Set();
    silenceReminderCountRef.current = 0;
    void comprehensionService
      .getQuestion(sessionId)
      .then((value) => {
        if (!active) return;
        activeQuestionRef.current = value;
        setWrongCount(0);
        setEliminatedValues(new Set());
        setRevealedHint(null);
        setProgress({ position: value.position, total: value.total });
        setLoadState({ status: "ready", value });
        if (!voicePausedRef.current) {
          void readQuestionAloudRef.current(value);
        }
      })
      .catch(() => {
        if (active) setLoadState({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, [comprehensionService, loadKey, sessionId]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleBackground = () => {
      if (document.hidden) {
        stopAllVoice();
        setVoicePhase("idle");
      }
    };
    const handleAndroidBackground = () => {
      stopAllVoice();
      setVoicePhase("idle");
    };
    document.addEventListener("visibilitychange", handleBackground);
    document.addEventListener(
      "viread:android-background",
      handleAndroidBackground,
    );
    return () => {
      document.removeEventListener("visibilitychange", handleBackground);
      document.removeEventListener(
        "viread:android-background",
        handleAndroidBackground,
      );
    };
  }, [stopAllVoice]);

  useEffect(() => {
    if (!readingChoiceId) return;
    const node = choiceButtonRefs.current.get(readingChoiceId);
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
  }, [readingChoiceId]);

  useEffect(() => {
    if (!result || result.is_correct) return;
    const node = feedbackRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
  }, [result, feedbackNote, revealedHint]);

  const handleToggleVoicePause = () => {
    if (voicePausedByUser) {
      voicePausedRef.current = false;
      setVoicePausedByUser(false);
      if (loadState.status === "ready") {
        void readQuestionAloud(loadState.value);
      }
    } else {
      voicePausedRef.current = true;
      setVoicePausedByUser(true);
      setVoicePhase("paused");
      stopAllVoice();
    }
  };

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader
        backHref="/dashboard"
        child={child}
        mobileLabel={t("session.mobileLabel")}
      />
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink sm:text-center">
          {t("comprehension.heading")}
        </h1>
        <div
          aria-hidden="true"
          className="mx-auto grid w-full max-w-[392px] gap-1"
          style={{
            gridTemplateColumns: `repeat(${questionTotal ?? 5}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: questionTotal ?? 5 }, (_, step) => (
            <span
              className={cn(
                "h-2 rounded-full",
                step < (questionPosition ?? 0) ? "bg-primary" : "bg-border",
              )}
              key={step}
            />
          ))}
        </div>

        {loadState.status === "loading" ? (
          <div
            aria-label={t("comprehension.loadingAria")}
            className="space-y-4"
          >
            <AiProgressBar
              active
              label={
                questionGenProgress.stageLabel ??
                tCommon("aiProgress.generatingQuestion")
              }
              percent={questionGenProgress.percent}
              size="sm"
              testId="comprehension-question-loading-progress"
            />
            <Skeleton className="h-40 rounded-card" />
            <Skeleton className="h-18 rounded-card" />
            <Skeleton className="h-18 rounded-card" />
          </div>
        ) : loadState.status === "error" ? (
          <div className="space-y-4">
            <StatusMessage
              title={t("comprehension.loadErrorTitle")}
              tone="error"
            >
              {t("comprehension.loadErrorDesc")}
            </StatusMessage>
            <div className="flex flex-wrap gap-3">
              <Button
                className="sm:w-auto"
                onClick={() => {
                  invalidateApiReadCacheByPrefix(
                    `/tutor/sessions/${encodeURIComponent(sessionId)}/questions`,
                  );
                  setLoadState({ status: "loading" });
                  setLoadKey((key) => key + 1);
                }}
                variant="secondary"
              >
                <RefreshCw aria-hidden="true" className="size-5" />
                {t("comprehension.retry")}
              </Button>
              <Button
                className="sm:w-auto"
                onClick={onComplete}
                variant="primary"
              >
                <ArrowRight
                  aria-hidden="true"
                  className="size-5 viread-rtl-flip"
                />
                {t("comprehension.skipToReport")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-card bg-cream p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-label font-semibold text-purple-ink">
                  {loadState.value.progress_label}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <ReadingVoiceSettings
                    disabled={voicePhase === "listening"}
                    fallbackNotice={speechPlayer.fallbackNotice}
                    isPreviewing={speechPlayer.isPlaying}
                    onPreview={(sample) => {
                      stopAllVoice();
                      return speechPlayer.play(sample, {
                        coaching: true,
                        cacheScope: "COACHING",
                        isPrivateBook: false,
                        bypassSessionLock: true,
                        utteranceKind: "voice_preview",
                      });
                    }}
                    onStopPreview={stopAllVoice}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      voicePausedRef.current = false;
                      setVoicePausedByUser(false);
                      void readQuestionAloud(loadState.value);
                    }}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-white px-3 py-1.5 text-sm font-semibold text-primary shadow-xs hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <Volume2 aria-hidden="true" className="size-4" />
                    {t("comprehension.replayAudio")}
                  </button>
                  <button
                    type="button"
                    onClick={handleToggleVoicePause}
                    aria-pressed={voicePausedByUser}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-white px-3 py-1.5 text-sm font-semibold text-ink shadow-xs hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {voicePausedByUser ? (
                      <>
                        <Mic aria-hidden="true" className="size-4" />
                        {t("comprehension.enableVoice")}
                      </>
                    ) : (
                      <>
                        <MicOff aria-hidden="true" className="size-4" />
                        {t("comprehension.pauseVoice")}
                      </>
                    )}
                  </button>
                </div>
              </div>
              <p
                className="viread-learning-content mt-4 text-[26px] font-semibold text-ink sm:text-heading"
                dir="ltr"
                lang="vi"
              >
                {loadState.value.question.prompt}
              </p>
            </div>

            <div className="space-y-3">
              {loadState.value.choices.map((choice) => {
                const selected = selectedAnswer === choice.value;
                const previewing =
                  !selected && previewChoiceId === choice.id && !result;
                const correct = selected && result?.is_correct === true;
                const beingRead = readingChoiceId === choice.id;
                const isEliminated =
                  wrongCount >= 2 && eliminatedValues.has(choice.value);
                return (
                  <button
                    ref={(node) => {
                      if (node) choiceButtonRefs.current.set(choice.id, node);
                      else choiceButtonRefs.current.delete(choice.id);
                    }}
                    aria-pressed={selected}
                    data-reading-choice={beingRead ? "true" : undefined}
                    data-preview-choice={previewing ? "true" : undefined}
                    data-eliminated-choice={isEliminated ? "true" : undefined}
                    className={cn(
                      "flex min-h-18 w-full items-center gap-6 rounded-card border-2 p-4 text-start text-body font-semibold text-ink transition duration-150 ease-out focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                      // Hover only applies to answers that can still be chosen.
                      "enabled:cursor-pointer enabled:hover:border-primary enabled:hover:bg-cream enabled:hover:font-semibold enabled:hover:shadow-md",
                      !correct &&
                        !(selected && result) &&
                        !beingRead &&
                        !previewing &&
                        !isEliminated &&
                        "bg-white",
                      isEliminated &&
                        "border-border bg-slate-100 text-muted line-through opacity-55",
                      beingRead &&
                        "border-primary bg-sky/50 ring-2 ring-primary/40",
                      previewing &&
                        "border-dashed border-emerald-600 bg-emerald-50 ring-2 ring-emerald-400/50",
                      selected && !isEliminated && "border-primary",
                      selected &&
                        !isEliminated &&
                        result?.is_correct === false &&
                        "border-warning bg-warning-surface",
                      correct &&
                        "border-success-ink bg-success-surface font-semibold text-success-ink",
                    )}
                    disabled={
                      isSubmitting ||
                      result?.is_correct === true ||
                      isEliminated
                    }
                    key={choice.id}
                    onClick={() => void submitAnswer(choice.value, "click")}
                    type="button"
                  >
                    <span className="w-8 shrink-0 text-purple-ink">
                      {choice.id}
                    </span>
                    <span
                      className="viread-learning-content flex-1 text-center"
                      dir="ltr"
                      lang="vi"
                    >
                      {choice.label}
                    </span>
                    {beingRead ? (
                      <Volume2
                        aria-hidden="true"
                        className="size-5 shrink-0 text-primary"
                      />
                    ) : correct ? (
                      <Check
                        aria-hidden="true"
                        className="size-6 shrink-0 text-success-ink"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {isSubmitting ? (
              <AiProgressBar
                active
                label={
                  evalAnswerProgress.stageLabel ??
                  tCommon("aiProgress.evaluatingAnswer")
                }
                percent={evalAnswerProgress.percent}
                size="compact"
                testId="comprehension-answer-evaluating-progress"
              />
            ) : null}

            {result ? (
              <div ref={feedbackRef}>
                <StatusMessage tone={result.is_correct ? "success" : "warning"}>
                  {feedbackNote !== null
                    ? feedbackPreserveVerbatim
                      ? feedbackNote
                      : adaptTextToTeacherPersona(
                          feedbackNote,
                          teacherPersona.gender,
                        )
                    : adaptTextToTeacherPersona(
                        result.is_correct
                          ? t("comprehension.correctPraise")
                          : t("comprehension.tryAgainHint"),
                        teacherPersona.gender,
                      )}
                </StatusMessage>
              </div>
            ) : (
              <p
                role="status"
                aria-live="polite"
                className="text-center text-body text-muted"
              >
                {feedbackNote ??
                  (voicePhase === "reading"
                    ? adaptTextToTeacherPersona(
                        t("comprehension.readingOptionsStatus"),
                        teacherPersona.gender,
                      )
                    : voicePhase === "listening"
                      ? adaptTextToTeacherPersona(
                          t("comprehension.voicePromptStatus"),
                          teacherPersona.gender,
                        )
                      : adaptTextToTeacherPersona(
                          t("comprehension.noRushHint"),
                          teacherPersona.gender,
                        ))}
              </p>
            )}

            {result?.is_correct ? (
              <Button
                className="mx-auto max-w-[360px]"
                onClick={() =>
                  advanceToNextQuestion(loadState.value.question.id)
                }
              >
                {questionTotal !== undefined && !hasNextQuestion
                  ? t("comprehension.finish")
                  : t("comprehension.nextQuestion")}
                <ArrowRight
                  aria-hidden="true"
                  className="viread-rtl-flip size-5"
                />
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
