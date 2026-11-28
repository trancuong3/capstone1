"use client";

import {
  CheckCircle2,
  Ear,
  Mic,
  Play,
  Sparkles,
  Timer,
  Volume2,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import type {
  MinimalPairExerciseDTO,
  PhonologySandboxDTO,
} from "@/lib/api/child-progress-service";
import { createSpeechService } from "@/lib/api/speech-service";
import { resolveLocalFirstSpeechRecognitionConstructor } from "@/lib/reading/local-segment-speech-recognition";
import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";

interface MinimalPairSandboxProps {
  readonly childId: string;
  readonly childAlias?: string;
  readonly days?: number;
  readonly compact?: boolean;
  readonly initialOpen?: boolean;
}

export function MinimalPairSandbox({
  childId,
  childAlias,
  days = 30,
  compact = false,
  initialOpen = false,
}: MinimalPairSandboxProps) {
  const t = useTranslations("difficultWords");
  const tCommon = useTranslations("common");
  const services = useContext(AppServicesContext);
  const childProgressService = services?.childProgressService;
  const speechPlayer = useSpeechPlayer();

  const requestKey = `${childId}:${days}`;
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [fetchState, setFetchState] = useState<{
    readonly key: string;
    readonly sandbox: PhonologySandboxDTO | null;
    readonly failed: boolean;
  } | null>(null);
  const isLoading =
    isOpen &&
    Boolean(childProgressService?.getPhonologySandbox) &&
    fetchState?.key !== requestKey;
  const loadFailed = fetchState?.key === requestKey && fetchState.failed;
  const sandbox = fetchState?.key === requestKey ? fetchState.sandbox : null;
  const [pairIndex, setPairIndex] = useState(0);
  const [speakingWord, setSpeakingWord] = useState<string | null>(null);
  const [quizSecretWord, setQuizSecretWord] = useState<string | null>(null);
  const [quizFeedback, setQuizFeedback] = useState<"correct" | "retry" | null>(
    null,
  );
  const [isListening, setIsListening] = useState(false);
  const [spokenResult, setSpokenResult] = useState<{
    readonly status: "match" | "contrast" | "other";
    readonly transcript: string;
  } | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const recognitionRef = useRef<{
    stop?: () => void;
    abort?: () => void;
  } | null>(null);

  const loadingProgress = useAiProgress({
    active: isLoading,
    expectedDurationMs: 3_500,
    resetKey: `${childId}:${days}:${isOpen ? 1 : 0}`,
  });

  const ttsProgress = useAiProgress({
    active: speakingWord !== null && !speechPlayer.isPlaying,
    expectedDurationMs: 2_500,
    resetKey: speakingWord,
  });

  useEffect(() => {
    if (
      !isOpen ||
      !childProgressService?.getPhonologySandbox ||
      fetchState?.key === requestKey
    ) {
      return;
    }
    const controller = new AbortController();
    childProgressService
      .getPhonologySandbox(childId, days, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setFetchState({ key: requestKey, sandbox: result, failed: false });
        setPairIndex(0);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFetchState({ key: requestKey, sandbox: null, failed: true });
        }
      });
    return () => {
      controller.abort();
    };
  }, [
    childId,
    childProgressService,
    days,
    fetchState?.key,
    isOpen,
    requestKey,
  ]);

  useEffect(() => {
    if (remainingSeconds === null || remainingSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setRemainingSeconds((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [remainingSeconds]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort?.();
      recognitionRef.current = null;
    };
  }, []);

  const pairs: readonly MinimalPairExerciseDTO[] = useMemo(
    () => sandbox?.recommended_pairs ?? [],
    [sandbox],
  );
  const activePair = pairs[pairIndex] ?? null;

  const playWord = useCallback(
    async (word: string) => {
      setSpeakingWord(word);
      try {
        await speechPlayer.play(word, {
          wordSample: true,
          bypassSessionLock: true,
        });
      } catch {
        // Handled gracefully by speechPlayer fallbackNotice
      } finally {
        setSpeakingWord((curr) => (curr === word ? null : curr));
      }
    },
    [speechPlayer],
  );

  const startEarQuiz = useCallback(async () => {
    if (!activePair) return;
    if (remainingSeconds === null || remainingSeconds === 0) {
      setRemainingSeconds(sandbox?.duration_seconds ?? 60);
    }
    const chosen = Math.random() < 0.5 ? activePair.word_a : activePair.word_b;
    setQuizSecretWord(chosen);
    setQuizFeedback(null);
    await playWord(chosen);
  }, [activePair, playWord, remainingSeconds, sandbox?.duration_seconds]);

  const answerEarQuiz = useCallback(
    (guess: string) => {
      if (!quizSecretWord) return;
      if (guess === quizSecretWord) {
        setQuizFeedback("correct");
      } else {
        setQuizFeedback("retry");
      }
    },
    [quizSecretWord],
  );

  const startPronunciationCheck = useCallback(
    (targetWord: string, contrastWord: string) => {
      recognitionRef.current?.abort?.();
      speechPlayer.stop();
      setSpokenResult(null);
      if (remainingSeconds === null || remainingSeconds === 0) {
        setRemainingSeconds(sandbox?.duration_seconds ?? 60);
      }

      const Ctor =
        typeof window !== "undefined"
          ? resolveLocalFirstSpeechRecognitionConstructor(
              window as unknown as Parameters<
                typeof resolveLocalFirstSpeechRecognitionConstructor
              >[0],
              createSpeechService(),
            )
          : undefined;
      if (!Ctor) {
        setSpokenResult({ status: "other", transcript: "" });
        return;
      }

      try {
        const rec = new Ctor();
        recognitionRef.current = rec;
        rec.lang = "vi-VN";
        rec.continuous = false;
        rec.interimResults = false;
        setIsListening(true);

        rec.onresult = (event: unknown) => {
          const ev = event as {
            results?: ArrayLike<ArrayLike<{ transcript?: string }>>;
          };
          const raw = ev.results?.[0]?.[0]?.transcript ?? "";
          const normSpoken = normalizeVietnameseWord(raw);
          const normTarget = normalizeVietnameseWord(targetWord);
          const normContrast = normalizeVietnameseWord(contrastWord);
          const tokens = raw
            .split(/\s+/)
            .map((item) => normalizeVietnameseWord(item))
            .filter(Boolean);
          if (normSpoken === normTarget || tokens.includes(normTarget)) {
            setSpokenResult({ status: "match", transcript: raw.trim() });
          } else if (
            normSpoken === normContrast ||
            tokens.includes(normContrast)
          ) {
            setSpokenResult({ status: "contrast", transcript: raw.trim() });
          } else {
            setSpokenResult({ status: "other", transcript: raw.trim() });
          }
          setIsListening(false);
        };
        rec.onerror = () => {
          setIsListening(false);
        };
        rec.onend = () => {
          setIsListening(false);
        };
        rec.start();
      } catch {
        setIsListening(false);
      }
    },
    [remainingSeconds, sandbox?.duration_seconds, speechPlayer],
  );

  if (!childProgressService?.getPhonologySandbox) {
    return null;
  }

  return (
    <section
      aria-label={t("minimalPairSandbox.title")}
      className="rounded-card border border-primary/25 bg-gradient-to-r from-cream/90 via-white to-sky/50 p-4 shadow-2xs sm:p-5"
      data-testid="minimal-pair-sandbox-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="inline-flex items-center gap-1.5 text-xs font-extrabold tracking-wide text-primary uppercase">
            <Sparkles aria-hidden="true" className="size-3.5" />
            {t("minimalPairSandbox.eyebrow")}
          </div>
          <h3 className="text-base font-extrabold text-ink sm:text-lg">
            {t("minimalPairSandbox.title")}
          </h3>
          {!compact ? (
            <p className="text-sm text-muted">
              {t("minimalPairSandbox.subtitle", {
                alias: childAlias ?? "",
              })}
            </p>
          ) : null}
        </div>

        <Button
          onClick={() => setIsOpen((prev) => !prev)}
          size="compact"
          type="button"
          variant={isOpen ? "secondary" : "primary"}
        >
          {isOpen
            ? t("minimalPairSandbox.collapseButton")
            : t("minimalPairSandbox.openButton")}
        </Button>
      </div>

      {isOpen ? (
        <div className="mt-4 space-y-4 border-t border-border/70 pt-4">
          {isLoading ? (
            <AiProgressBar
              active
              elapsedSeconds={loadingProgress.elapsedSeconds}
              label={
                loadingProgress.stageLabel ?? tCommon("aiProgress.analyzing")
              }
              percent={loadingProgress.percent}
              size="sm"
              testId="minimal-pair-sandbox-progress"
            />
          ) : loadFailed ? (
            <p className="text-sm text-muted">
              {t("minimalPairSandbox.unavailableHint")}
            </p>
          ) : activePair ? (
            <>
              {sandbox?.patterns && sandbox.patterns.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {sandbox.patterns.map((pat) => (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-white px-3 py-1 text-xs font-bold text-ink"
                      key={pat.pattern_key}
                    >
                      <span
                        className="viread-learning-content"
                        dir="ltr"
                        lang="vi"
                      >
                        {pat.title_vi}
                      </span>
                      <span className="text-muted">
                        ({pat.distinct_sessions})
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}

              {speakingWord !== null && !speechPlayer.isPlaying ? (
                <AiProgressBar
                  active
                  label={tCommon("aiProgress.synthesizingVoice")}
                  percent={ttsProgress.percent}
                  size="compact"
                  testId="minimal-pair-tts-progress"
                />
              ) : null}

              <div className="rounded-control border border-border bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-muted">
                    {t("minimalPairSandbox.pairCounter", {
                      current: pairIndex + 1,
                      total: pairs.length,
                    })}
                  </span>
                  {remainingSeconds !== null ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary-hover tabular-nums">
                      <Timer aria-hidden="true" className="size-3.5" />
                      {remainingSeconds}s
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    {
                      word: activePair.word_a,
                      contrast: activePair.word_b,
                    },
                    {
                      word: activePair.word_b,
                      contrast: activePair.word_a,
                    },
                  ].map((item) => (
                    <div
                      className="flex items-center justify-between gap-3 rounded-control border border-border bg-cream/60 p-3"
                      key={item.word}
                    >
                      <span
                        className="viread-learning-content text-2xl font-extrabold text-ink"
                        dir="ltr"
                        lang="vi"
                      >
                        {item.word}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Button
                          aria-label={`${t("minimalPairSandbox.listenWord")}: ${item.word}`}
                          onClick={() => void playWord(item.word)}
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          <Volume2 aria-hidden="true" className="size-4" />
                          {t("minimalPairSandbox.listenWord")}
                        </Button>
                        <Button
                          aria-label={`${t("minimalPairSandbox.speakWord")}: ${item.word}`}
                          disabled={isListening}
                          onClick={() =>
                            startPronunciationCheck(item.word, item.contrast)
                          }
                          size="compact"
                          type="button"
                          variant="primary"
                        >
                          <Mic aria-hidden="true" className="size-4" />
                          {isListening
                            ? t("minimalPairSandbox.listening")
                            : t("minimalPairSandbox.speakWord")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <p
                  className="viread-learning-content mt-3 text-xs leading-relaxed text-muted"
                  dir="ltr"
                  lang="vi"
                >
                  {activePair.hint_vi}
                </p>

                {spokenResult ? (
                  <div
                    className={`mt-3 flex items-center gap-2 rounded-control px-3 py-2 text-sm font-semibold ${
                      spokenResult.status === "match"
                        ? "bg-success-surface text-success-ink"
                        : "bg-warning-surface text-ink"
                    }`}
                    data-testid="minimal-pair-spoken-feedback"
                  >
                    <CheckCircle2
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    <span>
                      {spokenResult.status === "match"
                        ? t("minimalPairSandbox.spokenMatch")
                        : spokenResult.status === "contrast"
                          ? t("minimalPairSandbox.spokenContrast", {
                              heard: spokenResult.transcript,
                            })
                          : t("minimalPairSandbox.spokenRetry")}
                    </span>
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={() => void startEarQuiz()}
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      <Ear aria-hidden="true" className="size-4" />
                      {t("minimalPairSandbox.earChallengeButton")}
                    </Button>
                    {quizSecretWord ? (
                      <>
                        {[activePair.word_a, activePair.word_b].map(
                          (option) => (
                            <button
                              className="viread-learning-content min-h-9 rounded-full border border-primary/40 bg-white px-3 py-1 text-sm font-extrabold text-ink hover:bg-sky"
                              dir="ltr"
                              key={option}
                              lang="vi"
                              onClick={() => answerEarQuiz(option)}
                              type="button"
                            >
                              <Play
                                aria-hidden="true"
                                className="me-1 inline size-3 text-primary"
                              />
                              {option}
                            </button>
                          ),
                        )}
                        {quizFeedback ? (
                          <span className="text-xs font-bold text-primary">
                            {quizFeedback === "correct"
                              ? t("minimalPairSandbox.earCorrect")
                              : t("minimalPairSandbox.earRetry")}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>

                  {pairs.length > 1 ? (
                    <Button
                      onClick={() => {
                        setPairIndex((idx) => (idx + 1) % pairs.length);
                        setQuizSecretWord(null);
                        setQuizFeedback(null);
                        setSpokenResult(null);
                      }}
                      size="compact"
                      type="button"
                      variant="quiet"
                    >
                      {t("minimalPairSandbox.nextPairButton")}
                    </Button>
                  ) : null}
                </div>
              </div>

              <p className="text-xs text-muted">
                {t("minimalPairSandbox.nonClinicalDisclaimer")}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
