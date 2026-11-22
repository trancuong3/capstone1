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
import { Button } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { createSpeechService } from "@/lib/api/speech-service";
import { resolveLocalFirstSpeechRecognitionConstructor } from "@/lib/reading/local-segment-speech-recognition";
import { lockSessionVoice } from "@/lib/reading/session-voice-lock";
import {
  choiceLetterForSpeech,
  matchComprehensionVoiceInput,
} from "@/lib/reading/comprehension-voice-matcher";
import { EchoGuard } from "@/lib/reading/echo-guard";
import { InteractivePromptSelector } from "@/lib/reading/interactive-prompts";
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

const REMIND_SILENCE_MS = 10_000;

export function ComprehensionQuestion({
  child,
  onComplete,
  sessionId,
}: ComprehensionQuestionProps) {
  const { comprehensionService } = useReadingServices();
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
  const [progress, setProgress] = useState<{
    position?: number;
    total?: number;
  }>({});
  const [readingChoiceId, setReadingChoiceId] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voicePausedByUser, setVoicePausedByUser] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const flowGenRef = useRef(0);
  const playbackSeqRef = useRef(0);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const remindTimerRef = useRef<number | null>(null);
  const remindedForQuestionRef = useRef(false);
  const isSubmittingRef = useRef(false);
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

  const stopVoiceRecognition = useCallback(() => {
    clearRemindTimer();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // Already stopped
      }
    }
  }, [clearRemindTimer]);

  const stopAllVoice = useCallback(() => {
    flowGenRef.current += 1;
    stopVoiceRecognition();
    speechPlayerRef.current.stop();
    setReadingChoiceId(null);
  }, [stopVoiceRecognition]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flowGenRef.current += 1;
      clearRemindTimer();
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
      speechPlayerRef.current.stop();
    };
  }, [clearRemindTimer]);

  const speakGuarded = useCallback(
    async (text: string, gen: number): Promise<boolean> => {
      if (!mountedRef.current || gen !== flowGenRef.current) return false;
      const id = `quiz-tts-${(playbackSeqRef.current += 1)}`;
      echoGuard.playbackStarted(id, text, performance.now());
      try {
        await speechPlayerRef.current.play(text, { coaching: true });
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

  const advanceToNextQuestion = useCallback(() => {
    stopAllVoice();
    if (!hasNextQuestionRef.current) {
      onCompleteRef.current();
      return;
    }
    setSelectedAnswer(null);
    setResult(null);
    setFeedbackNote(null);
    setLoadState({ status: "loading" });
    setLoadKey((key) => key + 1);
  }, [stopAllVoice]);

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
      if (result?.is_correct) return;

      // Any direct click cancels active TTS & voice listening immediately.
      stopAllVoice();
      const gen = flowGenRef.current;

      isSubmittingRef.current = true;
      setSelectedAnswer(answer);
      setIsSubmitting(true);
      setResult(null);
      setFeedbackNote(null);

      let nextResult: ComprehensionAnswerResultDTO | null = null;
      try {
        nextResult = await comprehensionService.submitAnswer(
          sessionId,
          activeValue.question.id,
          answer,
        );
        if (mountedRef.current) {
          setResult(nextResult);
        }
      } finally {
        isSubmittingRef.current = false;
        if (mountedRef.current) setIsSubmitting(false);
      }

      if (
        !mountedRef.current ||
        !nextResult ||
        source !== "voice" ||
        gen !== flowGenRef.current ||
        voicePausedRef.current
      ) {
        return;
      }

      if (nextResult.is_correct) {
        const praise = prompts.next("quizCorrect");
        setFeedbackNote(praise);
        setVoicePhase("reading");
        const stillCurrent = await speakGuarded(praise, gen);
        if (stillCurrent && mountedRef.current && !voicePausedRef.current) {
          advanceToNextQuestion();
        }
      } else {
        const encourage = prompts.next("quizTryAgain");
        setFeedbackNote(encourage);
        setVoicePhase("reading");
        const stillCurrent = await speakGuarded(encourage, gen);
        if (stillCurrent && mountedRef.current && !voicePausedRef.current) {
          startVoiceListenRef.current(activeValue, gen);
        }
      }
    },
    [
      advanceToNextQuestion,
      comprehensionService,
      prompts,
      result?.is_correct,
      sessionId,
      speakGuarded,
      stopAllVoice,
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
      lockSessionVoice(sessionId);
      const Ctor = resolveLocalFirstSpeechRecognitionConstructor(
        window as unknown as {
          SpeechRecognition?: BrowserSpeechRecognitionCtor;
          webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        },
        speechService,
        () => ({ sessionId }),
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

      const armReminder = () => {
        clearRemindTimer();
        if (remindedForQuestionRef.current) return;
        remindTimerRef.current = window.setTimeout(() => {
          if (
            !mountedRef.current ||
            gen !== flowGenRef.current ||
            voicePausedRef.current ||
            isSubmittingRef.current
          ) {
            return;
          }
          remindedForQuestionRef.current = true;
          stopVoiceRecognition();
          setVoicePhase("reading");
          void speakGuarded(prompts.next("quizRemind"), gen).then((ok) => {
            if (ok && mountedRef.current && !voicePausedRef.current) {
              startVoiceListenRef.current(value, gen);
            }
          });
        }, REMIND_SILENCE_MS);
      };

      armReminder();

      rec.onresult = (event) => {
        if (
          !mountedRef.current ||
          gen !== flowGenRef.current ||
          recognitionRef.current !== rec ||
          isSubmittingRef.current
        ) {
          return;
        }
        const start = Math.max(event.resultIndex ?? 0, processedUpTo + 1);
        for (let idx = start; idx < event.results.length; idx += 1) {
          const item = event.results[idx];
          if (!item?.isFinal) continue;
          processedUpTo = idx;
          const transcript = item[0]?.transcript?.trim() ?? "";
          if (!transcript) continue;
          const confidence = item[0]?.confidence;
          if (
            typeof confidence === "number" &&
            confidence > 0 &&
            confidence < 0.35
          ) {
            continue;
          }

          // Block echo from our own question / option TTS!
          if (
            !echoGuard.evaluate({
              text: transcript,
              receivedAt: performance.now(),
            }).accept
          ) {
            continue;
          }

          const matched = matchComprehensionVoiceInput(
            transcript,
            value.choices,
          );
          if (matched.type === "STOP") {
            voicePausedRef.current = true;
            setVoicePausedByUser(true);
            setVoicePhase("paused");
            stopAllVoice();
            return;
          }
          if (matched.type === "REPLAY") {
            void readQuestionAloudRef.current(value);
            return;
          }
          if (matched.type === "CHOICE") {
            void submitAnswer(matched.choice.value, "voice");
            return;
          }
        }
      };

      rec.onerror = (event) => {
        if (recognitionRef.current !== rec) return;
        if (
          event.error === "not-allowed" ||
          event.error === "service-not-allowed"
        ) {
          stopVoiceRecognition();
          setVoicePhase("idle");
        }
      };

      rec.onend = () => {
        if (recognitionRef.current !== rec) return;
        if (
          mountedRef.current &&
          gen === flowGenRef.current &&
          !voicePausedRef.current &&
          !isSubmittingRef.current
        ) {
          try {
            rec.start();
          } catch {
            // Keep manual buttons usable
          }
        }
      };

      try {
        rec.start();
      } catch {
        recognitionRef.current = null;
        setVoicePhase("idle");
      }
    },
    [
      clearRemindTimer,
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
      const hasVoiceApi =
        Boolean(getSpeechRecognitionCtor()) ||
        (typeof window !== "undefined" &&
          (typeof window.AudioContext === "function" ||
            Boolean(window.speechSynthesis?.getVoices?.().length)));
      if (!hasVoiceApi) return;
      lockSessionVoice(sessionId);

      stopAllVoice();
      const gen = flowGenRef.current;
      remindedForQuestionRef.current = false;
      setVoicePhase("reading");

      if (!(await speakGuarded(value.question.prompt, gen))) return;

      for (let i = 0; i < value.choices.length; i += 1) {
        const choice = value.choices[i];
        const letter = choiceLetterForSpeech(choice, i);
        if (!mountedRef.current || gen !== flowGenRef.current) return;
        setReadingChoiceId(choice.id);
        const ok = await speakGuarded(`Đáp án ${letter}: ${choice.label}`, gen);
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
    [prompts, sessionId, speakGuarded, stopAllVoice],
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
    void comprehensionService
      .getQuestion(sessionId)
      .then((value) => {
        if (!active) return;
        activeQuestionRef.current = value;
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
      <BookChildHeader child={child} mobileLabel="Bạn nhỏ cùng đọc" />
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink sm:text-center">
          Mình cùng trả lời nhé
        </h1>
        <div
          aria-hidden="true"
          className="mx-auto hidden w-[392px] gap-1 sm:grid"
          style={{
            gridTemplateColumns: `repeat(${questionTotal ?? 5}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: questionTotal ?? 5 }, (_, step) => (
            <span
              className={cn(
                "h-2",
                step < (questionPosition ?? 2) ? "bg-primary" : "bg-border",
              )}
              key={step}
            />
          ))}
        </div>

        {loadState.status === "loading" ? (
          <div aria-label="Đang tải câu hỏi" className="space-y-4">
            <Skeleton className="h-40 rounded-card" />
            <Skeleton className="h-18 rounded-card" />
            <Skeleton className="h-18 rounded-card" />
          </div>
        ) : loadState.status === "error" ? (
          <div className="space-y-4">
            <StatusMessage title="Chưa tải được câu hỏi" tone="error">
              Có lỗi xảy ra. Bé có thể thử lại mà không ảnh hưởng buổi đọc.
            </StatusMessage>
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
          </div>
        ) : (
          <>
            <div className="rounded-card bg-cream p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-label font-semibold text-purple-ink">
                  {loadState.value.progress_label}
                </p>
                <div className="flex items-center gap-2">
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
                    Nghe lại
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
                        Bật nghe giọng nói
                      </>
                    ) : (
                      <>
                        <MicOff aria-hidden="true" className="size-4" />
                        Tạm dừng nghe
                      </>
                    )}
                  </button>
                </div>
              </div>
              <p className="mt-4 text-[26px] font-semibold text-ink sm:text-heading">
                {loadState.value.question.prompt}
              </p>
            </div>

            <div className="space-y-3">
              {loadState.value.choices.map((choice) => {
                const selected = selectedAnswer === choice.value;
                const correct = selected && result?.is_correct === true;
                const beingRead = readingChoiceId === choice.id;
                return (
                  <button
                    aria-pressed={selected}
                    data-reading-choice={beingRead ? "true" : undefined}
                    className={cn(
                      "flex min-h-18 w-full items-center gap-6 rounded-card border-2 p-4 text-left text-body font-semibold text-ink transition duration-150 ease-out focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                      // Hover only applies to answers that can still be chosen.
                      "enabled:cursor-pointer enabled:hover:border-primary enabled:hover:bg-cream enabled:hover:font-semibold enabled:hover:shadow-md",
                      !correct &&
                        !(selected && result) &&
                        !beingRead &&
                        "bg-white",
                      beingRead &&
                        "border-primary bg-sky/50 ring-2 ring-primary/40",
                      selected && "border-primary",
                      selected &&
                        result?.is_correct === false &&
                        "border-warning bg-warning-surface",
                      correct &&
                        "border-success-ink bg-success-surface font-semibold text-success-ink",
                    )}
                    disabled={isSubmitting || result?.is_correct === true}
                    key={choice.id}
                    onClick={() => void submitAnswer(choice.value, "click")}
                    type="button"
                  >
                    <span className="w-8 shrink-0 text-purple-ink">
                      {choice.id}
                    </span>
                    <span className="flex-1 text-center">{choice.label}</span>
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

            {result ? (
              <StatusMessage tone={result.is_correct ? "success" : "warning"}>
                {feedbackNote ??
                  (result.is_correct
                    ? "Đúng rồi. Bé nhớ rất tốt."
                    : "Gần đúng rồi, thử lại nhé.")}
              </StatusMessage>
            ) : (
              <p
                role="status"
                aria-live="polite"
                className="text-center text-body text-muted"
              >
                {voicePhase === "reading"
                  ? "Cô đang đọc câu hỏi và các đáp án cho bé nghe…"
                  : voicePhase === "listening"
                    ? "Bé nói đáp án A, B, C hoặc chạm vào lựa chọn bé thích nhé."
                    : "Không cần vội. Bé cứ nghĩ một chút nhé."}
              </p>
            )}

            {result?.is_correct ? (
              <Button
                className="mx-auto max-w-[360px]"
                onClick={advanceToNextQuestion}
              >
                {questionTotal !== undefined && !hasNextQuestion
                  ? "Hoàn thành"
                  : "Câu tiếp theo"}
                <ArrowRight aria-hidden="true" className="size-5" />
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
