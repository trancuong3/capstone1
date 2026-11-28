"use client";

import {
  ArrowLeft,
  BookOpen,
  Check,
  Gamepad2,
  Lightbulb,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { BookCover } from "@/components/books/book-cover";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import {
  OrderedShotQueue,
  type QueuedShot,
} from "@/components/entertainment/sentence-shooter/shot-queue";
import {
  disposeShooterAudio,
  playShooterSound,
  prefersReducedMotion,
  suspendShooterAudio,
} from "@/components/entertainment/sentence-shooter/sound-engine";
import { StageLayoutCache } from "@/components/entertainment/sentence-shooter/stage-layout-cache";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useEntertainmentPreferences } from "@/hooks/use-entertainment-preferences";
import { useTranslations } from "@/hooks/use-i18n";
import { useSentenceShooterService } from "@/hooks/use-sentence-shooter-service";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { cn } from "@/lib/utils/cn";
import type { BookListItemDTO } from "@/types/book";
import type {
  SentenceShooterBookDTO,
  SentenceShooterDifficulty,
  SentenceShooterLearningMode,
  SentenceShooterResultDTO,
  SentenceShooterRoundDTO,
  SentenceShooterSessionDTO,
  SentenceShooterShotDTO,
  SentenceShooterTokenDTO,
} from "@/types/sentence-shooter";

type ScreenMode = "lobby" | "playing" | "result";
type BookLoadState =
  | { status: "loading" }
  | { status: "ready"; books: SentenceShooterBookDTO[] }
  | { status: "error" };

interface ActiveProjectile {
  readonly id: number;
  readonly left: number;
  readonly top: number;
  readonly dx: number;
  readonly dy: number;
  readonly endX: number;
  readonly endY: number;
}

const difficulties: ReadonlyArray<{
  value: SentenceShooterDifficulty;
  titleKey: string;
  descKey: string;
}> = [
  {
    value: "easy",
    titleKey: "sentenceShooter.difficulties.easyTitle",
    descKey: "sentenceShooter.difficulties.easyDesc",
  },
  {
    value: "medium",
    titleKey: "sentenceShooter.difficulties.mediumTitle",
    descKey: "sentenceShooter.difficulties.mediumDesc",
  },
  {
    value: "challenge",
    titleKey: "sentenceShooter.difficulties.challengeTitle",
    descKey: "sentenceShooter.difficulties.challengeDesc",
  },
];

const learningModes: ReadonlyArray<{
  value: SentenceShooterLearningMode;
  titleKey: string;
  descKey: string;
}> = [
  {
    value: "WORD_ORDER",
    titleKey: "sentenceShooter.learningModes.wordOrderTitle",
    descKey: "sentenceShooter.learningModes.wordOrderDesc",
  },
  {
    value: "FILL_BLANK",
    titleKey: "sentenceShooter.learningModes.fillBlankTitle",
    descKey: "sentenceShooter.learningModes.fillBlankDesc",
  },
  {
    value: "GRAMMAR_FOCUS",
    titleKey: "sentenceShooter.learningModes.grammarFocusTitle",
    descKey: "sentenceShooter.learningModes.grammarFocusDesc",
  },
];

const LEARNING_MODE_LABEL_KEYS: Record<SentenceShooterLearningMode, string> = {
  WORD_ORDER: "sentenceShooter.learningModes.wordOrderTitle",
  FILL_BLANK: "sentenceShooter.learningModes.fillBlankTitle",
  GRAMMAR_FOCUS: "sentenceShooter.learningModes.grammarFocusTitle",
};

const MAX_ACTIVE_PROJECTILES = 6;

interface SentenceShooterScreenProps {
  initialBookId?: string;
  readingSessionId?: string;
}

function toBookCover(book: SentenceShooterBookDTO): BookListItemDTO {
  return {
    id: book.id,
    name: book.name,
    title: book.title,
    author: book.author,
    min_grade: book.min_grade,
    max_grade: book.max_grade,
    lifecycle_status: "ACTIVE",
  };
}

interface SentenceShooterResultViewProps {
  backHref: string;
  calmSound: boolean;
  child: NonNullable<
    ReturnType<typeof useValidatedSelectedChild>["state"] & { status: "ready" }
  >["child"];
  finalSentence: string;
  isLoadingResult: boolean;
  learningMode: SentenceShooterLearningMode;
  onReloadResult: () => void;
  onRestartLobby: () => void;
  readingSessionId?: string;
  reducedMotion: boolean;
  result: SentenceShooterResultDTO | null;
  resultError: boolean;
  session: SentenceShooterSessionDTO | null;
}

function SentenceShooterResultView({
  backHref,
  calmSound,
  child,
  finalSentence,
  isLoadingResult,
  learningMode,
  onReloadResult,
  onRestartLobby,
  readingSessionId,
  reducedMotion,
  result,
  resultError,
  session,
}: SentenceShooterResultViewProps) {
  const t = useTranslations("games");
  const tCommon = useTranslations("common");
  const speechPlayer = useSpeechPlayer();
  const resultDetailsProgress = useAiProgress({
    active: !result && isLoadingResult,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.evaluatingAnswer") },
      { atPct: 72, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 4_000,
  });
  const summaryBookTitle = result?.book.title ?? session?.book.title ?? "";
  const summaryCompletedRounds =
    result?.completed_rounds ?? session?.completed_rounds ?? 0;
  const summaryTotalRounds = result?.total_rounds ?? session?.total_rounds ?? 0;
  const summaryTotalStars = result?.total_stars ?? session?.total_stars ?? 0;
  const summaryMode =
    result?.learning_mode ?? session?.learning_mode ?? learningMode;
  const summaryPracticedWords =
    result?.practiced_difficult_words ??
    session?.practiced_difficult_words ??
    [];

  useEffect(() => {
    if (!calmSound) {
      speechPlayer.stop();
    }
  }, [calmSound, speechPlayer]);

  function readSentence() {
    if (!calmSound || !finalSentence.trim()) return;
    speechPlayer.stop();
    void speechPlayer.play(finalSentence).catch(() => undefined);
  }

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-[900px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10",
        reducedMotion && "motion-reduce",
      )}
      data-calm-sound={calmSound ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <BookChildHeader
        backHref={backHref}
        child={child}
        mobileLabel={
          readingSessionId
            ? t("sentenceShooter.mobileResultLabel")
            : t("sentenceShooter.mobilePlayZoneLabel")
        }
      />
      <div className="relative overflow-hidden rounded-card border border-border bg-cream p-6 text-center shadow-sm sm:p-10">
        <div
          aria-hidden="true"
          className="mb-3 flex justify-center gap-3 text-warning"
        >
          <span className="text-3xl">✦</span>
          <span className="mt-3 text-4xl">★</span>
          <span className="text-3xl">✦</span>
        </div>
        <p className="font-extrabold text-primary">
          {t("sentenceShooter.resultSavedEyebrow")} ·{" "}
          {t(LEARNING_MODE_LABEL_KEYS[summaryMode])}
        </p>
        <h1 className="mt-2 text-heading font-extrabold text-ink">
          {result && result.status !== "COMPLETED"
            ? t("sentenceShooter.resultPartialTitle")
            : t("sentenceShooter.resultCompletedTitle")}
        </h1>
        <p
          className="viread-learning-content mt-2 text-body text-muted"
          dir="ltr"
          lang="vi"
        >
          {summaryBookTitle}
        </p>
        <div className="mx-auto mt-7 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            [
              t("sentenceShooter.statCompletedRounds"),
              `${summaryCompletedRounds}/${summaryTotalRounds}`,
            ],
            [
              t("sentenceShooter.statCorrectWords"),
              result ? String(result.correct_count) : "—",
            ],
            [
              t("sentenceShooter.statRetries"),
              result ? String(result.mistakes_total) : "—",
            ],
            [
              t("sentenceShooter.statHints"),
              result ? String(result.hint_count) : "—",
            ],
          ].map(([label, value]) => (
            <div className="rounded-control bg-white/90 p-4" key={label}>
              <p className="text-sm font-bold text-muted">{label}</p>
              <p className="mt-1 text-2xl font-extrabold tabular-nums text-ink">
                {value}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-warning-surface px-5 py-3 text-xl font-extrabold text-warning">
          <span aria-hidden="true">★</span>{" "}
          {t("sentenceShooter.starsEarned", { count: summaryTotalStars })}
        </p>
        {summaryPracticedWords.length > 0 ? (
          <p className="mt-4 inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full bg-sky px-4 py-1.5 text-sm font-bold text-primary">
            <Sparkles aria-hidden="true" className="size-4" />
            {t("sentenceShooter.practicedDifficultWordsSummary")}{" "}
            <span className="viread-learning-content" dir="ltr" lang="vi">
              {summaryPracticedWords.join(", ")}
            </span>
          </p>
        ) : null}
        {result ? (
          <p className="mt-3 text-sm font-semibold text-muted">
            {t("sentenceShooter.durationLine", {
              minutes: Math.floor(result.duration_seconds / 60),
              seconds: result.duration_seconds % 60,
            })}
          </p>
        ) : isLoadingResult ? (
          <div className="mx-auto mt-3 flex max-w-sm flex-col items-center gap-2">
            <p className="text-sm font-semibold text-muted" role="status">
              {t("sentenceShooter.loadingResultDetails")}
            </p>
            <AiProgressBar
              active
              className="w-full"
              label={
                resultDetailsProgress.stageLabel ??
                tCommon("aiProgress.evaluatingAnswer")
              }
              percent={resultDetailsProgress.percent}
              size="compact"
              testId="sentence-shooter-result-details-progress"
            />
          </div>
        ) : resultError ? (
          <div className="mt-3 flex flex-col items-center gap-2">
            <p className="text-sm font-semibold text-danger">
              {t("sentenceShooter.loadResultFailed")}
            </p>
            <Button onClick={onReloadResult} size="compact" variant="secondary">
              <RefreshCw aria-hidden="true" className="size-4" />{" "}
              {t("sentenceShooter.reloadResult")}
            </Button>
          </div>
        ) : null}
        <div className="mx-auto mt-7 flex max-w-md flex-col gap-3 sm:flex-row">
          <Button
            className="sm:flex-1"
            onClick={onRestartLobby}
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-5" />{" "}
            {t("sentenceShooter.playNewSession")}
          </Button>
          <Button
            className="sm:flex-1"
            disabled={!calmSound}
            onClick={readSentence}
            variant="quiet"
          >
            <Volume2 aria-hidden="true" className="size-5" />{" "}
            {t("sentenceShooter.readSampleSentence")}
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted">
          {t("sentenceShooter.lastSentencePrefix")}
          {finalSentence ? (
            <span className="viread-learning-content" dir="ltr" lang="vi">
              {finalSentence}
            </span>
          ) : (
            t("sentenceShooter.lastSentenceFallback")
          )}
        </p>
      </div>
      <Link
        className="self-center rounded-control px-4 py-3 font-bold text-primary hover:bg-sky"
        href={backHref}
      >
        <ArrowLeft
          aria-hidden="true"
          className="viread-rtl-flip me-2 inline size-4"
        />
        {readingSessionId
          ? t("sentenceShooter.backToReadingResult")
          : t("sentenceShooter.backToEntertainment")}
      </Link>
    </section>
  );
}

export function SentenceShooterScreen({
  initialBookId,
  readingSessionId,
}: SentenceShooterScreenProps = {}) {
  const t = useTranslations("games");
  const tCommon = useTranslations("common");
  const gameError = t("sentenceShooter.gameError");
  const shootError = t("sentenceShooter.shootError");
  const router = useRouter();
  const shooterService = useSentenceShooterService();
  const speechPlayer = useSpeechPlayer();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const child = childState.status === "ready" ? childState.child : null;
  const childId = child?.id ?? null;

  const { reducedMotion, calmSound, setCalmSound } =
    useEntertainmentPreferences();
  const soundEnabled = calmSound;

  const [difficulty, setDifficulty] =
    useState<SentenceShooterDifficulty>("easy");
  const [learningMode, setLearningMode] =
    useState<SentenceShooterLearningMode>("WORD_ORDER");
  const [totalRounds, setTotalRounds] = useState<3 | 5>(3);
  const [bookState, setBookState] = useState<BookLoadState>({
    status: "loading",
  });
  const [selectedBookId, setSelectedBookId] = useState("");
  const [booksPage, setBooksPage] = useState(1);
  const SHOOTER_BOOKS_PAGE_SIZE = 6;
  const [hasManuallySelectedBook, setHasManuallySelectedBook] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<ScreenMode>("lobby");

  const [session, setSession] = useState<SentenceShooterSessionDTO | null>(
    null,
  );
  const [round, setRound] = useState<SentenceShooterRoundDTO | null>(null);
  const [result, setResult] = useState<SentenceShooterResultDTO | null>(null);
  const [finalSentence, setFinalSentence] = useState("");
  const [roundCompletedSentence, setRoundCompletedSentence] = useState("");
  const [roundGrammarTip, setRoundGrammarTip] = useState<string | null>(null);
  const [roundPracticedWords, setRoundPracticedWords] = useState<string[]>([]);

  const [placedTokens, setPlacedTokens] = useState<SentenceShooterTokenDTO[]>(
    [],
  );
  const [pendingShots, setPendingShots] = useState<readonly QueuedShot[]>([]);
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const [hintTargetId, setHintTargetId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [isLoadingNextRound, setIsLoadingNextRound] = useState(false);
  const [isRequestingHint, setIsRequestingHint] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [cannonAngle, setCannonAngle] = useState(0);
  const [wobbleTokenId, setWobbleTokenId] = useState("");
  const [prefetchedNextRound, setPrefetchedNextRound] =
    useState<SentenceShooterRoundDTO | null>(null);
  const [isLoadingResult, setIsLoadingResult] = useState(false);
  const startSessionProgress = useAiProgress({
    active: isStartingSession,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 48, label: tCommon("aiProgress.generatingQuestion") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 6_000,
  });
  const nextRoundProgress = useAiProgress({
    active: isLoadingNextRound,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.generatingQuestion") },
      { atPct: 75, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 4_000,
  });
  const hintProgress = useAiProgress({
    active: isRequestingHint,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.generatingHint") },
      { atPct: 74, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 3_500,
  });
  const loadResultProgress = useAiProgress({
    active: isLoadingResult,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.evaluatingAnswer") },
      { atPct: 75, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 4_500,
  });
  const [resultError, setResultError] = useState(false);
  const [sessionScore, setSessionScore] = useState(0);
  const [projectiles, setProjectiles] = useState<readonly ActiveProjectile[]>(
    [],
  );

  const arenaRef = useRef<HTMLDivElement>(null);
  const cannonRef = useRef<HTMLDivElement>(null);
  const roundCompletedRef = useRef(false);
  const [layoutCache] = useState(() => new StageLayoutCache());
  const tokenRefCallbacks = useMemo(() => {
    const callbacks = new Map<
      string,
      (element: HTMLButtonElement | null) => void
    >();
    for (const token of round?.tokens ?? []) {
      callbacks.set(token.id, (element) => {
        layoutCache.registerToken(token.id, element);
      });
    }
    return callbacks;
  }, [layoutCache, round]);

  const shotVisualIdRef = useRef(0);
  const projectileTimersRef = useRef(
    new Map<number, ReturnType<typeof setTimeout>>(),
  );
  const sessionEpochRef = useRef(0);
  const controlAbortRef = useRef<AbortController | null>(null);
  const shooterServiceRef = useRef(shooterService);
  const speechPlayerRef = useRef(speechPlayer);
  const soundEnabledRef = useRef(soundEnabled);
  const reducedMotionRef = useRef(reducedMotion);
  const calmSoundRef = useRef(calmSound);
  const roundRef = useRef(round);
  const shootErrorRef = useRef(shootError);
  const readingCompletionHref = readingSessionId
    ? `/reading/${encodeURIComponent(readingSessionId)}`
    : "/entertainment";

  useEffect(() => {
    shooterServiceRef.current = shooterService;
  }, [shooterService]);

  useEffect(() => {
    speechPlayerRef.current = speechPlayer;
  }, [speechPlayer]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    calmSoundRef.current = calmSound;
    if (!calmSound) {
      speechPlayerRef.current.stop();
    }
  }, [calmSound, soundEnabled]);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  useEffect(() => {
    shootErrorRef.current = shootError;
  }, [shootError]);

  function clearProjectileTimers() {
    for (const timer of projectileTimersRef.current.values()) {
      clearTimeout(timer);
    }
    projectileTimersRef.current.clear();
  }

  async function fetchCompletedResult(sessionId: string, epoch: number) {
    const controller = new AbortController();
    controlAbortRef.current = controller;
    setIsLoadingResult(true);
    setResultError(false);
    try {
      const completedResult = await shooterServiceRef.current.result(
        sessionId,
        controller.signal,
      );
      if (epoch !== sessionEpochRef.current) return;
      setResult(completedResult);
    } catch {
      if (epoch === sessionEpochRef.current && !controller.signal.aborted) {
        setResultError(true);
      }
    } finally {
      if (controlAbortRef.current === controller) {
        controlAbortRef.current = null;
      }
      if (epoch === sessionEpochRef.current) {
        setIsLoadingResult(false);
      }
    }
  }

  const queueCallbacksRef = useRef<{
    onShotResolved: (
      shot: QueuedShot,
      response: SentenceShooterShotDTO,
    ) => void;
    onShotError: (shot: QueuedShot) => void;
  }>({
    onShotResolved: () => undefined,
    onShotError: () => undefined,
  });

  useEffect(() => {
    queueCallbacksRef.current = {
      onShotResolved: (shot, response) => {
        setFeedback(response.message);
        setSelectedTokenId("");
        if (typeof response.score === "number") {
          setSessionScore(response.score);
        }
        if (response.is_correct) {
          setPlacedTokens((current) =>
            current.some((item) => item.id === shot.token.id)
              ? current
              : [...current, shot.token],
          );
          setHintTargetId("");
          playShooterSound(
            response.session_completed ? "celebrate" : "correct",
            soundEnabledRef.current,
            {
              reducedMotion: reducedMotionRef.current,
              calmSound: calmSoundRef.current,
            },
          );
          if (response.round_completed) {
            roundCompletedRef.current = true;
            const completedText = response.completed_sentence ?? "";
            setRoundCompletedSentence(completedText);
            setRoundGrammarTip(response.grammar_tip ?? null);
            const practiced =
              response.practiced_difficult_words &&
              response.practiced_difficult_words.length > 0
                ? [...response.practiced_difficult_words]
                : [...(roundRef.current?.practiced_difficult_words ?? [])];
            setRoundPracticedWords(practiced);
            setSession((current) =>
              current
                ? {
                    ...current,
                    completed_rounds: response.completed_rounds,
                    total_stars: response.total_stars,
                  }
                : current,
            );
            if (response.session_completed) {
              setFinalSentence(completedText);
              setResult(null);
              setMode("result");
              void fetchCompletedResult(
                shot.sessionId,
                sessionEpochRef.current,
              );
            } else {
              setPrefetchedNextRound(response.next_round ?? null);
            }
          }
        } else {
          // Surgical rollback: shot has already been shifted off pendingShots,
          // so only this bubble wobbles & returns to the selectable tray.
          setWobbleTokenId(shot.token.id);
          playShooterSound("wrong", soundEnabledRef.current, {
            reducedMotion: reducedMotionRef.current,
            calmSound: calmSoundRef.current,
          });
        }
      },
      onShotError: (shot) => {
        setError(shootErrorRef.current);
        setSelectedTokenId(shot.token.id);
      },
    };
  });

  const shotQueueRef = useRef<OrderedShotQueue | null>(null);

  useEffect(() => {
    if (mode === "playing" && round) {
      layoutCache.bindStage(arenaRef.current, cannonRef.current);
      layoutCache.scheduleMeasure();
    } else {
      layoutCache.bindStage(null, null);
    }
  }, [layoutCache, mode, round]);

  useEffect(() => {
    const shotQueue = new OrderedShotQueue(
      (shot, signal) =>
        shooterServiceRef.current.shoot(
          shot.sessionId,
          {
            round_id: shot.roundId,
            token_id: shot.token.id,
            request_id: shot.clientShotId,
            client_shot_id: shot.clientShotId,
          },
          signal,
        ),
      {
        onQueueChange: (snapshot) => {
          setPendingShots(snapshot.pending);
        },
        onShotResolved: (shot, response) => {
          queueCallbacksRef.current.onShotResolved(shot, response);
        },
        onShotError: (shot) => {
          queueCallbacksRef.current.onShotError(shot);
        },
      },
    );
    shotQueueRef.current = shotQueue;

    const onBackground = () => suspendShooterAudio();
    const onVisibility = () => {
      if (document.hidden) suspendShooterAudio();
    };
    document.addEventListener("viread:android-background", onBackground);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("viread:android-background", onBackground);
      document.removeEventListener("visibilitychange", onVisibility);
      sessionEpochRef.current += 1;
      controlAbortRef.current?.abort();
      shotQueue.resetEpoch();
      shotQueueRef.current = null;
      layoutCache.dispose();
      clearProjectileTimers();
      disposeShooterAudio();
    };
  }, [layoutCache]);

  useEffect(() => {
    if (!childId) return;
    const selectedChildId = childId;
    const controller = new AbortController();
    let active = true;
    async function loadBooks() {
      setBookState((current) =>
        current.status === "loading" ? current : { status: "loading" },
      );
      setSelectedBookId((current) => (current === "" ? current : ""));
      try {
        const books = await shooterService.listBooks(
          selectedChildId,
          difficulty,
          totalRounds,
          controller.signal,
        );
        if (!active) return;
        const initialBookIdx = initialBookId
          ? books.findIndex((book) => book.id === initialBookId)
          : -1;
        setBooksPage(
          initialBookIdx >= 0
            ? Math.floor(initialBookIdx / SHOOTER_BOOKS_PAGE_SIZE) + 1
            : 1,
        );
        setBookState({ status: "ready", books });
      } catch {
        if (!active || controller.signal.aborted) return;
        setBookState({ status: "error" });
      }
    }
    void loadBooks();
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    childId,
    difficulty,
    initialBookId,
    reloadKey,
    shooterService,
    totalRounds,
  ]);

  const effectiveSelectedBookId =
    !hasManuallySelectedBook &&
    initialBookId &&
    bookState.status === "ready" &&
    bookState.books.some((book) => book.id === initialBookId)
      ? initialBookId
      : selectedBookId;

  const selectedBook = useMemo(
    () =>
      bookState.status === "ready"
        ? (bookState.books.find(
            (book) => book.id === effectiveSelectedBookId,
          ) ?? null)
        : null,
    [bookState, effectiveSelectedBookId],
  );

  const placedTokenIds = useMemo(
    () => new Set(placedTokens.map((token) => token.id)),
    [placedTokens],
  );

  const inFlightTokenIds = useMemo(
    () => new Set(pendingShots.map((shot) => shot.token.id)),
    [pendingShots],
  );

  function spawnVisualProjectile(tokenId: string) {
    const trajectory = layoutCache.getTrajectory(tokenId);
    if (!trajectory) return;

    setCannonAngle(trajectory.angle);

    if (reducedMotionRef.current || prefersReducedMotion()) {
      return;
    }

    shotVisualIdRef.current += 1;
    const visualId = shotVisualIdRef.current;
    const entry: ActiveProjectile = {
      id: visualId,
      left: trajectory.startX,
      top: trajectory.startY,
      dx: trajectory.dx,
      dy: trajectory.dy,
      endX: trajectory.endX,
      endY: trajectory.endY,
    };

    setProjectiles((current) => [
      ...current.slice(-(MAX_ACTIVE_PROJECTILES - 1)),
      entry,
    ]);

    const timer = setTimeout(() => {
      projectileTimersRef.current.delete(visualId);
      setProjectiles((current) =>
        current.filter((item) => item.id !== visualId),
      );
    }, 360);
    projectileTimersRef.current.set(visualId, timer);
  }

  function removeProjectile(visualId: number) {
    const timer = projectileTimersRef.current.get(visualId);
    if (timer) {
      clearTimeout(timer);
      projectileTimersRef.current.delete(visualId);
    }
    setProjectiles((current) => current.filter((item) => item.id !== visualId));
  }

  function selectToken(token: SentenceShooterTokenDTO) {
    if (
      !session ||
      !round ||
      isPaused ||
      isExiting ||
      mode !== "playing" ||
      roundCompletedRef.current ||
      placedTokens.length >= round.token_count ||
      placedTokenIds.has(token.id)
    ) {
      return;
    }

    const queue = shotQueueRef.current;
    if (!queue) return;

    // Enqueue immediately (<1ms): blocks duplicate clicks on the SAME bubble
    // while allowing rapid sequential taps on OTHER bubbles!
    const queued = queue.enqueue({
      sessionId: session.session_id,
      roundId: round.round_id,
      token,
    });
    if (!queued) return;

    setSelectedTokenId(token.id);
    setHintTargetId("");
    setWobbleTokenId("");
    setError("");
    setFeedback("");

    // Immediate non-blocking visual + audio feedback (<30ms, zero HTTP wait,
    // zero forced layout reflows via ResizeObserver-cached coordinates).
    spawnVisualProjectile(token.id);
    playShooterSound("shot", soundEnabled, {
      reducedMotion,
      calmSound,
    });
  }

  async function startGame() {
    if (!child || !selectedBook || isStartingSession) return;
    sessionEpochRef.current += 1;
    const epoch = sessionEpochRef.current;
    shotQueueRef.current?.resetEpoch();
    controlAbortRef.current?.abort();
    const controller = new AbortController();
    controlAbortRef.current = controller;
    setIsStartingSession(true);
    setError("");
    try {
      const created = await shooterService.createSession(
        {
          child_id: child.id,
          book_id: selectedBook.id,
          difficulty,
          total_rounds: totalRounds,
          learning_mode: learningMode,
        },
        controller.signal,
      );
      if (epoch !== sessionEpochRef.current) return;
      clearProjectileTimers();
      layoutCache.clearTokens();
      roundCompletedRef.current = false;
      setSessionScore(0);
      setProjectiles([]);
      setPrefetchedNextRound(null);
      setIsLoadingResult(false);
      setResultError(false);
      setSession(created);
      setRound(created.round);
      setPlacedTokens([]);
      setSelectedTokenId("");
      setHintTargetId("");
      setFeedback("");
      setResult(null);
      setFinalSentence("");
      setRoundCompletedSentence("");
      setRoundGrammarTip(null);
      setRoundPracticedWords([]);
      setCannonAngle(0);
      setMode("playing");
      setIsPaused(false);
    } catch {
      if (epoch === sessionEpochRef.current && !controller.signal.aborted) {
        setError(gameError);
      }
    } finally {
      if (controlAbortRef.current === controller) {
        controlAbortRef.current = null;
      }
      if (epoch === sessionEpochRef.current) {
        setIsStartingSession(false);
      }
    }
  }

  async function requestHint() {
    if (
      !session ||
      !round ||
      isRequestingHint ||
      isPaused ||
      placedTokens.length >= round.token_count
    ) {
      return;
    }
    const epoch = sessionEpochRef.current;
    const controller = new AbortController();
    controlAbortRef.current = controller;
    setIsRequestingHint(true);
    setError("");
    try {
      const hint = await shooterService.hint(
        session.session_id,
        round.round_id,
        controller.signal,
      );
      if (epoch !== sessionEpochRef.current) return;
      setHintTargetId(hint.target_token_id);
      setFeedback(hint.message);
    } catch {
      if (epoch === sessionEpochRef.current && !controller.signal.aborted) {
        setError(t("sentenceShooter.hintError"));
      }
    } finally {
      if (controlAbortRef.current === controller) {
        controlAbortRef.current = null;
      }
      if (epoch === sessionEpochRef.current) {
        setIsRequestingHint(false);
      }
    }
  }

  async function continueToNextRound() {
    if (!session || !round || isLoadingNextRound) return;
    setError("");
    speechPlayer.stop();
    if (
      prefetchedNextRound &&
      prefetchedNextRound.round_id !== round.round_id
    ) {
      sessionEpochRef.current += 1;
      shotQueueRef.current?.resetEpoch();
      clearProjectileTimers();
      layoutCache.clearTokens();
      roundCompletedRef.current = false;
      const upcoming = prefetchedNextRound;
      setPrefetchedNextRound(null);
      setProjectiles([]);
      setSession((current) =>
        current
          ? {
              ...current,
              round: upcoming,
            }
          : current,
      );
      setRound(upcoming);
      setPlacedTokens([]);
      setSelectedTokenId("");
      setHintTargetId("");
      setFeedback("");
      setRoundCompletedSentence("");
      setRoundGrammarTip(null);
      setRoundPracticedWords([]);
      setCannonAngle(0);
      return;
    }

    const epoch = sessionEpochRef.current;
    const controller = new AbortController();
    controlAbortRef.current = controller;
    setIsLoadingNextRound(true);
    try {
      const next = await shooterService.nextRound(
        session.session_id,
        round.round_id,
        controller.signal,
      );
      if (epoch !== sessionEpochRef.current) return;
      shotQueueRef.current?.resetEpoch();
      clearProjectileTimers();
      layoutCache.clearTokens();
      roundCompletedRef.current = false;
      setPrefetchedNextRound(null);
      setProjectiles([]);
      setSession((current) =>
        current
          ? {
              ...current,
              completed_rounds: next.completed_rounds,
              total_stars: next.total_stars,
              round: next.round,
            }
          : current,
      );
      setRound(next.round);
      setPlacedTokens([]);
      setSelectedTokenId("");
      setHintTargetId("");
      setFeedback("");
      setRoundCompletedSentence("");
      setRoundGrammarTip(null);
      setRoundPracticedWords([]);
      setCannonAngle(0);
    } catch {
      if (epoch === sessionEpochRef.current && !controller.signal.aborted) {
        setError(t("sentenceShooter.nextRoundError"));
      }
    } finally {
      if (controlAbortRef.current === controller) {
        controlAbortRef.current = null;
      }
      if (epoch === sessionEpochRef.current) {
        setIsLoadingNextRound(false);
      }
    }
  }

  async function loadCompletedResult() {
    if (!session) return;
    setMode("result");
    await fetchCompletedResult(session.session_id, sessionEpochRef.current);
  }

  async function exitGame() {
    if (!session) return;
    const shouldExit = window.confirm(t("sentenceShooter.exitConfirm"));
    if (!shouldExit) return;
    sessionEpochRef.current += 1;
    shotQueueRef.current?.resetEpoch();
    controlAbortRef.current?.abort();
    controlAbortRef.current = null;
    clearProjectileTimers();
    speechPlayer.stop();
    setProjectiles([]);
    setIsExiting(true);
    setError("");
    try {
      await shooterService.abandon(session.session_id);
      router.push("/entertainment");
    } catch {
      setError(t("sentenceShooter.exitError"));
      setIsExiting(false);
    }
  }

  function restartLobby() {
    sessionEpochRef.current += 1;
    shotQueueRef.current?.resetEpoch();
    controlAbortRef.current?.abort();
    controlAbortRef.current = null;
    clearProjectileTimers();
    layoutCache.clearTokens();
    roundCompletedRef.current = false;
    setSessionScore(0);
    speechPlayer.stop();
    setIsStartingSession(false);
    setIsLoadingNextRound(false);
    setIsRequestingHint(false);
    setIsExiting(false);
    setProjectiles([]);
    setPrefetchedNextRound(null);
    setIsLoadingResult(false);
    setResultError(false);
    setMode("lobby");
    setSession(null);
    setRound(null);
    setResult(null);
    setFinalSentence("");
    setRoundCompletedSentence("");
    setRoundGrammarTip(null);
    setRoundPracticedWords([]);
    setPlacedTokens([]);
    setSelectedTokenId("");
    setHintTargetId("");
    setFeedback("");
    setError("");
    setIsPaused(false);
    setCannonAngle(0);
  }

  function playSentenceAudio(text: string) {
    if (!calmSound || !text.trim()) return;
    speechPlayer.stop();
    void speechPlayer.play(text).catch(() => undefined);
  }

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[1130px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          {t("sentenceShooter.verifyingChild")}
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage
          title={t("sentenceShooter.childErrorTitle")}
          tone="error"
        >
          {t("sentenceShooter.childErrorBody")}
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />{" "}
          {t("sentenceShooter.retry")}
        </Button>
      </section>
    );
  }

  if (mode === "result" && (result || session) && child) {
    return (
      <SentenceShooterResultView
        backHref={readingCompletionHref}
        calmSound={calmSound}
        child={child}
        finalSentence={finalSentence}
        isLoadingResult={isLoadingResult}
        learningMode={learningMode}
        onReloadResult={() => void loadCompletedResult()}
        onRestartLobby={restartLobby}
        readingSessionId={readingSessionId}
        reducedMotion={reducedMotion}
        result={result}
        resultError={resultError}
        session={session}
      />
    );
  }

  if (mode === "playing" && session && round) {
    const roundComplete = placedTokens.length === round.token_count;
    const activeLearningMode: SentenceShooterLearningMode =
      round.learning_mode ?? session.learning_mode ?? learningMode;
    const hasPromptSlots = Boolean(
      round.prompt_slots && round.prompt_slots.length > 0,
    );
    const activePracticedWords =
      roundPracticedWords.length > 0
        ? roundPracticedWords
        : (round.practiced_difficult_words ?? []);
    const completedDisplaySentence =
      roundCompletedSentence ||
      (hasPromptSlots
        ? (() => {
            let blankIdx = 0;
            return (round.prompt_slots ?? [])
              .map((slot) => {
                if (!slot.is_blank) return slot.text ?? "";
                const token = placedTokens[blankIdx];
                blankIdx += 1;
                return token?.text ?? "___";
              })
              .join(" ");
          })()
        : placedTokens.map((token) => token.text).join(" "));

    // Optimistic preview tokens map cleanly after server-confirmed slots.
    const optimisticPreviewCount = Math.min(
      round.token_count,
      placedTokens.length + pendingShots.length,
    );
    let blankCursor = 0;

    return (
      <section
        className={cn(
          "mx-auto flex w-full max-w-[1130px] flex-col gap-3 px-4 py-4 sm:px-6 sm:py-5",
          reducedMotion && "motion-reduce",
        )}
        data-calm-sound={calmSound ? "true" : "false"}
        data-reduced-motion={reducedMotion ? "true" : "false"}
      >
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel={t("sentenceShooter.mobilePlayZoneLabel")}
        />
        <header className="flex flex-col gap-2.5 rounded-card border border-border bg-white px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:py-2.5">
          <div className="min-w-0 flex-1">
            <h1
              className="viread-learning-content break-words text-lg leading-snug font-extrabold text-ink sm:truncate"
              dir="ltr"
              lang="vi"
            >
              {session.book.title}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary">
                {t(LEARNING_MODE_LABEL_KEYS[activeLearningMode])}
              </span>
              {activePracticedWords.length > 0 ? (
                <span
                  className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full bg-warning-surface px-2.5 py-0.5 text-xs font-extrabold text-warning"
                  data-testid="difficult-word-badge"
                >
                  <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
                  {activeLearningMode === "WORD_ORDER" || roundComplete ? (
                    <>
                      <span>
                        {t("sentenceShooter.difficultWordReviewPrefix")}
                      </span>
                      <span
                        className="viread-learning-content break-words"
                        dir="ltr"
                        lang="vi"
                      >
                        {activePracticedWords.join(", ")}
                      </span>
                    </>
                  ) : (
                    <span>{t("sentenceShooter.difficultWordActiveHint")}</span>
                  )}
                </span>
              ) : null}
              <span className="text-sm font-bold text-muted">
                {t("sentenceShooter.roundProgress", {
                  current: round.round_number,
                  total: session.total_rounds,
                })}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-2 lg:shrink-0 lg:border-t-0 lg:pt-0">
            <div
              className="flex flex-wrap items-center gap-2.5 sm:gap-3"
              role="group"
              aria-label={t("sentenceShooter.placedAria", {
                placed: placedTokens.length,
                total: round.token_count,
              })}
            >
              <div className="h-3 w-24 overflow-hidden rounded-full bg-sky sm:w-36">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{
                    width: `${(optimisticPreviewCount / round.token_count) * 100}%`,
                  }}
                />
              </div>
              <span
                aria-label={t("sentenceShooter.starsAria", {
                  count: session.total_stars,
                })}
                className="inline-flex shrink-0 items-center gap-1 font-extrabold text-warning"
              >
                <span aria-hidden="true">★</span>
                {session.total_stars}
              </span>
              {sessionScore > 0 ? (
                <span
                  className="shrink-0 whitespace-nowrap rounded-full bg-success-surface px-2.5 py-0.5 text-xs font-extrabold tabular-nums text-success-ink"
                  data-testid="session-score"
                >
                  {t("sentenceShooter.scoreBadge", { score: sessionScore })}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                aria-label={
                  soundEnabled
                    ? t("sentenceShooter.muteSoundAria")
                    : t("sentenceShooter.enableSoundAria")
                }
                aria-pressed={soundEnabled}
                className="flex size-11 items-center justify-center rounded-control bg-sky text-primary hover:bg-border"
                onClick={() => setCalmSound(!soundEnabled)}
                type="button"
              >
                {soundEnabled ? (
                  <Volume2 aria-hidden="true" className="size-5" />
                ) : (
                  <VolumeX aria-hidden="true" className="size-5" />
                )}
              </button>
              <button
                aria-label={t("sentenceShooter.pauseAria")}
                className="flex min-h-11 items-center justify-center gap-2 rounded-control bg-sky px-3 font-bold text-primary hover:bg-border disabled:opacity-55"
                onClick={() => setIsPaused(true)}
                type="button"
              >
                <Pause aria-hidden="true" className="size-5" />
                <span className="hidden sm:inline">
                  {t("sentenceShooter.pause")}
                </span>
              </button>
              <button
                className="flex min-h-11 items-center justify-center rounded-control px-3 font-bold text-danger hover:bg-danger-surface disabled:opacity-55"
                disabled={isExiting}
                onClick={() => void exitGame()}
                type="button"
              >
                {t("sentenceShooter.exit")}
              </button>
            </div>
          </div>
        </header>

        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
        <div
          ref={arenaRef}
          className="relative isolate rounded-card border border-border bg-white p-4 sm:p-5"
        >
          <div className="flex flex-col gap-3">
            <div className="space-y-2 rounded-control bg-cream px-3 py-3 sm:px-4">
              <p className="font-bold text-ink">
                {activeLearningMode === "FILL_BLANK"
                  ? t("sentenceShooter.slotHeadingFillBlank")
                  : activeLearningMode === "GRAMMAR_FOCUS"
                    ? t("sentenceShooter.slotHeadingGrammarFocus")
                    : t("sentenceShooter.childSentenceHeading")}
              </p>
              <div
                aria-label={t("sentenceShooter.slotsAria")}
                className="viread-learning-content flex w-full flex-wrap gap-2"
                dir="ltr"
                lang="vi"
                role="list"
              >
                {hasPromptSlots
                  ? (round.prompt_slots ?? []).map((slot) => {
                      if (!slot.is_blank) {
                        return (
                          <div
                            className="flex min-h-12 items-center justify-center rounded-control border border-border bg-white px-3 py-2 text-base font-bold text-ink sm:min-h-14 sm:px-4 sm:text-lg"
                            key={`fixed-${slot.position}`}
                            role="listitem"
                          >
                            {slot.text}
                          </div>
                        );
                      }
                      const slotIndex = blankCursor;
                      blankCursor += 1;
                      const confirmed = placedTokens[slotIndex];
                      const optimistic =
                        !confirmed && slotIndex >= placedTokens.length
                          ? pendingShots[slotIndex - placedTokens.length]?.token
                          : undefined;
                      return (
                        <div
                          aria-label={
                            confirmed
                              ? t("sentenceShooter.slotFilledAria", {
                                  index: slotIndex + 1,
                                  word: confirmed.text,
                                })
                              : optimistic
                                ? t("sentenceShooter.slotPendingAria", {
                                    index: slotIndex + 1,
                                    word: optimistic.text,
                                  })
                                : t("sentenceShooter.slotEmptyAria", {
                                    index: slotIndex + 1,
                                  })
                          }
                          className={[
                            "flex min-h-12 min-w-[68px] max-w-full items-center justify-center rounded-control border-2 px-3 py-2 text-center text-base font-extrabold sm:min-h-14 sm:min-w-[84px] sm:px-4 sm:text-lg",
                            confirmed
                              ? "sentence-success-pulse border-[#98D4A2] bg-success-surface text-success-ink"
                              : optimistic
                                ? "border-dashed border-primary bg-sky text-primary"
                                : "border-dashed border-primary/50 bg-sky/30 text-primary/70",
                          ].join(" ")}
                          data-slot-state={
                            confirmed
                              ? "confirmed"
                              : optimistic
                                ? "optimistic"
                                : "empty"
                          }
                          key={`blank-${slot.position}`}
                          role="listitem"
                        >
                          {confirmed ? (
                            <>
                              <Check
                                aria-hidden="true"
                                className="me-1 size-4 shrink-0"
                              />
                              {confirmed.text}
                            </>
                          ) : optimistic ? (
                            optimistic.text
                          ) : (
                            "___"
                          )}
                        </div>
                      );
                    })
                  : Array.from({ length: round.token_count }, (_, index) => {
                      const confirmed = placedTokens[index];
                      const optimistic =
                        !confirmed && index >= placedTokens.length
                          ? pendingShots[index - placedTokens.length]?.token
                          : undefined;
                      return (
                        <div
                          aria-label={
                            confirmed
                              ? t("sentenceShooter.slotFilledAria", {
                                  index: index + 1,
                                  word: confirmed.text,
                                })
                              : optimistic
                                ? t("sentenceShooter.slotPendingAria", {
                                    index: index + 1,
                                    word: optimistic.text,
                                  })
                                : t("sentenceShooter.slotEmptyAria", {
                                    index: index + 1,
                                  })
                          }
                          className={[
                            "flex min-h-12 min-w-[54px] max-w-full items-center justify-center rounded-control border-2 px-3 py-2 text-center text-base font-extrabold sm:min-h-14 sm:min-w-[70px] sm:px-4 sm:text-lg",
                            confirmed
                              ? "sentence-success-pulse border-[#98D4A2] bg-success-surface text-success-ink"
                              : optimistic
                                ? "border-dashed border-primary bg-sky text-primary"
                                : "border-dashed border-[#B8CECA] bg-white/80 text-muted/60",
                          ].join(" ")}
                          data-slot-state={
                            confirmed
                              ? "confirmed"
                              : optimistic
                                ? "optimistic"
                                : "empty"
                          }
                          key={index}
                          role="listitem"
                        >
                          {confirmed ? (
                            <>
                              <Check
                                aria-hidden="true"
                                className="me-1 size-4 shrink-0"
                              />
                              {confirmed.text}
                            </>
                          ) : optimistic ? (
                            optimistic.text
                          ) : (
                            "···"
                          )}
                        </div>
                      );
                    })}
              </div>
            </div>
            <div className="space-y-2 rounded-control bg-sky/45 px-3 py-3 sm:px-4">
              <p className="font-bold text-ink">
                {round.prompt_hint ? (
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    {round.prompt_hint}
                  </span>
                ) : (
                  t("sentenceShooter.nextWordHeading")
                )}
              </p>
              <div
                aria-label={t("sentenceShooter.wordBankAria")}
                className="viread-learning-content flex w-full flex-wrap items-center gap-2.5"
                dir="ltr"
                lang="vi"
                role="group"
              >
                {round.tokens.map((token) => {
                  const placed = placedTokenIds.has(token.id);
                  const inFlight = inFlightTokenIds.has(token.id);
                  const selected = selectedTokenId === token.id;
                  const hinted =
                    hintTargetId === token.id && !placed && !inFlight;
                  const showDifficultDot =
                    activeLearningMode === "WORD_ORDER" &&
                    Boolean(token.is_difficult_word) &&
                    !placed;
                  return (
                    <button
                      aria-pressed={selected || inFlight}
                      aria-label={
                        hinted
                          ? t("sentenceShooter.hintedTokenAria", {
                              word: token.text,
                            })
                          : undefined
                      }
                      aria-busy={inFlight || undefined}
                      className={[
                        "min-h-12 rounded-control border px-4 py-2 text-lg font-extrabold text-ink transition-transform duration-100 hover:bg-sky active:scale-95 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:min-h-14 sm:px-5",
                        placed
                          ? "invisible pointer-events-none"
                          : "border-border bg-white",
                        selected ? "ring-2 ring-primary" : "",
                        hinted
                          ? "border-[#d3a446] bg-warning-surface ring-1 ring-warning"
                          : "",
                        inFlight
                          ? "scale-95 border-primary bg-sky/80 opacity-75"
                          : "",
                        wobbleTokenId === token.id
                          ? "sentence-token-wobble border-danger/60"
                          : "",
                      ].join(" ")}
                      data-difficult-word={
                        showDifficultDot ? "true" : undefined
                      }
                      data-shot-state={
                        placed
                          ? "placed"
                          : inFlight
                            ? "in-flight"
                            : wobbleTokenId === token.id
                              ? "wrong"
                              : "ready"
                      }
                      disabled={placed || inFlight || isPaused || roundComplete}
                      key={token.id}
                      onAnimationEnd={() => {
                        if (wobbleTokenId === token.id) setWobbleTokenId("");
                      }}
                      onClick={() => selectToken(token)}
                      ref={tokenRefCallbacks.get(token.id)}
                      type="button"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {token.text}
                        {showDifficultDot ? (
                          <span
                            aria-hidden="true"
                            className="inline-block size-2 rounded-full bg-warning"
                            title={t("sentenceShooter.difficultWordDotTitle")}
                          />
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <div
                ref={cannonRef}
                aria-hidden="true"
                className="shrink-0 motion-safe:transition-transform"
                data-cannon-angle={Math.round(cannonAngle)}
              >
                <ToyCannon angle={cannonAngle} className="size-14" />
              </div>
              <p
                className="min-h-10 min-w-40 flex-1 content-center break-words text-sm font-bold text-primary"
                role="status"
                aria-live="polite"
              >
                {pendingShots.length > 0 ? (
                  pendingShots.length > 1 ? (
                    t("sentenceShooter.checkingMultipleTokensStatus", {
                      count: pendingShots.length,
                    })
                  ) : (
                    t("sentenceShooter.checkingTokenStatus")
                  )
                ) : feedback ? (
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    {feedback}
                  </span>
                ) : (
                  t("sentenceShooter.defaultPromptStatus")
                )}
              </p>
              <button
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-warning-surface px-3 font-bold text-warning hover:bg-book-orange disabled:opacity-55"
                disabled={isRequestingHint || isPaused || roundComplete}
                onClick={() => void requestHint()}
                type="button"
              >
                <Lightbulb aria-hidden="true" className="size-5" />{" "}
                {t("sentenceShooter.hintButton")}
              </button>
            </div>
            {isRequestingHint ? (
              <div className="w-full">
                <AiProgressBar
                  active
                  label={
                    hintProgress.stageLabel ??
                    tCommon("aiProgress.generatingHint")
                  }
                  percent={hintProgress.percent}
                  size="compact"
                  testId="sentence-shooter-hint-progress"
                />
              </div>
            ) : null}
            {roundComplete ? (
              <div className="w-full rounded-card border border-[#B6DDBB] bg-success-surface p-5 text-center">
                <p
                  className="viread-learning-content text-xl font-extrabold text-success-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {completedDisplaySentence}
                </p>
                <p className="mt-2 font-bold text-success-ink">
                  {t("sentenceShooter.roundCompletePraise")}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <button
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-[#98D4A2] bg-white px-4 py-1.5 text-sm font-extrabold text-success-ink hover:bg-cream disabled:opacity-50"
                    disabled={!calmSound}
                    onClick={() => playSentenceAudio(completedDisplaySentence)}
                    type="button"
                  >
                    <Volume2 aria-hidden="true" className="size-4" />
                    {t("sentenceShooter.readFullSentence")}
                  </button>
                  {activePracticedWords.length > 0 ? (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full bg-warning-surface px-3.5 py-1.5 text-xs font-extrabold text-warning"
                      data-testid="practiced-difficult-words"
                    >
                      <Sparkles aria-hidden="true" className="size-3.5" />
                      {t("sentenceShooter.practicedDifficultWordsRound")}{" "}
                      <span
                        className="viread-learning-content"
                        dir="ltr"
                        lang="vi"
                      >
                        {activePracticedWords.join(", ")}
                      </span>
                    </span>
                  ) : null}
                </div>
                {roundGrammarTip ? (
                  <p
                    className="mx-auto mt-3 inline-flex max-w-xl items-center gap-2 rounded-control bg-white/90 px-4 py-2 text-sm font-bold text-primary"
                    data-testid="grammar-tip-pill"
                  >
                    <BookOpen aria-hidden="true" className="size-4 shrink-0" />
                    <span
                      className="viread-learning-content"
                      dir="ltr"
                      lang="vi"
                    >
                      {roundGrammarTip}
                    </span>
                  </p>
                ) : null}
                <div className="mt-4 space-y-2.5">
                  {session.completed_rounds < session.total_rounds ? (
                    <>
                      <Button
                        className="mx-auto max-w-sm"
                        disabled={isLoadingNextRound}
                        isLoading={isLoadingNextRound}
                        onClick={() => void continueToNextRound()}
                      >
                        <Play aria-hidden="true" className="size-5" />{" "}
                        {t("sentenceShooter.nextRound")}
                      </Button>
                      {isLoadingNextRound ? (
                        <div className="mx-auto max-w-sm">
                          <AiProgressBar
                            active
                            label={
                              nextRoundProgress.stageLabel ??
                              tCommon("aiProgress.generatingQuestion")
                            }
                            percent={nextRoundProgress.percent}
                            size="compact"
                            testId="sentence-shooter-next-round-progress"
                          />
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Button
                        className="mx-auto max-w-sm"
                        disabled={isLoadingResult}
                        isLoading={isLoadingResult}
                        onClick={() => void loadCompletedResult()}
                      >
                        <RefreshCw aria-hidden="true" className="size-5" />{" "}
                        {t("sentenceShooter.viewResult")}
                      </Button>
                      {isLoadingResult ? (
                        <div className="mx-auto max-w-sm">
                          <AiProgressBar
                            active
                            label={
                              loadResultProgress.stageLabel ??
                              tCommon("aiProgress.evaluatingAnswer")
                            }
                            percent={loadResultProgress.percent}
                            size="compact"
                            testId="sentence-shooter-result-progress"
                          />
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          {projectiles.map((item) => {
            const shotStyle = {
              left: item.left,
              top: item.top,
              "--shot-dx": `${item.dx}px`,
              "--shot-dy": `${item.dy}px`,
            } as CSSProperties & Record<"--shot-dx" | "--shot-dy", string>;
            const burstStyle = {
              left: item.endX,
              top: item.endY,
              transform: "translate(-50%, -50%)",
            } as CSSProperties;
            return (
              <span key={item.id}>
                <span
                  aria-hidden="true"
                  className="sentence-shot-projectile pointer-events-none absolute z-20 flex size-5 items-center justify-center text-warning will-change-transform"
                  data-testid="shot-projectile"
                  onAnimationEnd={() => removeProjectile(item.id)}
                  style={shotStyle}
                >
                  ✦
                </span>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute z-10 flex items-center justify-center text-xs text-primary/70 opacity-80"
                  data-testid="shot-particles"
                  style={burstStyle}
                >
                  ✧
                </span>
              </span>
            );
          })}
        </div>

        <Modal
          closeOnBackdropClick
          footer={
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                className="sm:flex-1"
                onClick={() => setIsPaused(false)}
                variant="secondary"
              >
                <Play aria-hidden="true" className="size-5" />{" "}
                {t("sentenceShooter.resumePlay")}
              </Button>
              <Button
                className="sm:flex-1"
                onClick={() => void exitGame()}
                variant="quiet"
              >
                {t("sentenceShooter.endSession")}
              </Button>
            </div>
          }
          isOpen={isPaused}
          onClose={() => setIsPaused(false)}
          showCloseButton={false}
          title={t("sentenceShooter.pauseModalTitle")}
          tone="paper"
        >
          <p className="text-muted">{t("sentenceShooter.pauseModalBody")}</p>
          {error ? (
            <StatusMessage className="mt-4 text-start" tone="error">
              {error}
            </StatusMessage>
          ) : null}
        </Modal>
      </section>
    );
  }

  const selectedDifficultyOption = difficulties.find(
    (option) => option.value === difficulty,
  );

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-[1130px] flex-col gap-6 px-4 py-4 sm:px-8 sm:py-7",
        reducedMotion && "motion-reduce",
      )}
      data-calm-sound={calmSound ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <BookChildHeader
        backHref={readingCompletionHref}
        child={child}
        mobileLabel={
          readingSessionId
            ? t("sentenceShooter.mobileResultLabel")
            : t("sentenceShooter.mobilePlayZoneLabel")
        }
      />
      <header className="flex flex-col gap-2 border-b border-border pb-5">
        <p className="font-extrabold text-primary">
          {t("sentenceShooter.eyebrow")}
        </p>
        <h1 className="text-heading font-extrabold text-ink">
          {t("sentenceShooter.lobbyTitle")}
        </h1>
        <p className="text-body text-muted">
          {t("sentenceShooter.lobbySubtitle")}
        </p>
      </header>

      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}

      {initialBookId &&
      bookState.status === "ready" &&
      !hasManuallySelectedBook &&
      !bookState.books.some((book) => book.id === initialBookId) ? (
        <StatusMessage
          title={t("sentenceShooter.bookNotReadyTitle")}
          tone="warning"
        >
          {t("sentenceShooter.bookNotReadyBody")}
        </StatusMessage>
      ) : null}

      <fieldset>
        <legend className="mb-3 text-lg font-extrabold text-ink">
          {t("sentenceShooter.chooseLearningMode")}
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {learningModes.map((option) => (
            <button
              aria-pressed={learningMode === option.value}
              className={[
                "min-h-24 rounded-card border-2 p-4 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                learningMode === option.value
                  ? "border-primary bg-sky"
                  : "border-border bg-white hover:bg-sky/50",
              ].join(" ")}
              key={option.value}
              onClick={() => setLearningMode(option.value)}
              type="button"
            >
              <span className="flex items-center justify-between font-extrabold text-ink">
                {t(option.titleKey)}
                {learningMode === option.value ? (
                  <Check aria-hidden="true" className="size-5 text-primary" />
                ) : null}
              </span>
              <span className="mt-1 block text-sm font-semibold text-muted">
                {t(option.descKey)}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-lg font-extrabold text-ink">
          {t("sentenceShooter.chooseDifficulty")}
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {difficulties.map((option) => (
            <button
              aria-pressed={difficulty === option.value}
              className={[
                "min-h-24 rounded-card border-2 p-4 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                difficulty === option.value
                  ? "border-primary bg-sky"
                  : "border-border bg-white hover:bg-sky/50",
              ].join(" ")}
              key={option.value}
              onClick={() => setDifficulty(option.value)}
              type="button"
            >
              <span className="flex items-center justify-between font-extrabold text-ink">
                {t(option.titleKey)}
                {difficulty === option.value ? (
                  <Check aria-hidden="true" className="size-5 text-primary" />
                ) : null}
              </span>
              <span className="mt-1 block text-sm font-semibold text-muted">
                {t(option.descKey)}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-lg font-extrabold text-ink">
          {t("sentenceShooter.roundsPerGame")}
        </legend>
        <div className="flex gap-3">
          {([3, 5] as const).map((count) => (
            <button
              aria-pressed={totalRounds === count}
              className={[
                "min-h-12 rounded-control border-2 px-5 font-bold",
                totalRounds === count
                  ? "border-primary bg-sky text-primary"
                  : "border-border bg-white text-ink hover:bg-sky/50",
              ].join(" ")}
              key={count}
              onClick={() => setTotalRounds(count)}
              type="button"
            >
              {t("sentenceShooter.roundsCount", { count })}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-extrabold text-ink">
            {t("sentenceShooter.chooseBook")}
          </h2>
          <span className="text-sm font-semibold text-muted">
            {t("sentenceShooter.selectedConfigWithMode", {
              mode: t(LEARNING_MODE_LABEL_KEYS[learningMode]),
              difficulty: selectedDifficultyOption
                ? t(selectedDifficultyOption.titleKey)
                : "",
              rounds: totalRounds,
            })}
          </span>
        </div>
        {initialBookId && selectedBook?.id === initialBookId ? (
          <p className="mb-3 rounded-control bg-success-surface px-4 py-3 text-sm font-semibold text-success-ink">
            <Gamepad2 aria-hidden="true" className="me-2 inline size-4" />
            {t("sentenceShooter.preselectedRecentBook")}
            <strong className="viread-learning-content" dir="ltr" lang="vi">
              {selectedBook.title}
            </strong>
          </p>
        ) : null}
        {bookState.status === "loading" ? (
          <div
            aria-busy="true"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <span className="sr-only" role="status">
              {t("sentenceShooter.findingBooksStatus")}
            </span>
            {[0, 1, 2].map((item) => (
              <Skeleton className="h-48 w-full rounded-card" key={item} />
            ))}
          </div>
        ) : null}
        {bookState.status === "error" ? (
          <div className="flex flex-col gap-3">
            <StatusMessage
              title={t("sentenceShooter.booksLoadErrorTitle")}
              tone="error"
            >
              {gameError}
            </StatusMessage>
            <Button
              className="sm:w-auto"
              onClick={() => setReloadKey((key) => key + 1)}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-5" />{" "}
              {t("sentenceShooter.retry")}
            </Button>
          </div>
        ) : null}
        {bookState.status === "ready" && bookState.books.length === 0 ? (
          <EmptyState
            description={t("sentenceShooter.emptyBooksDesc")}
            icon={
              <span aria-hidden="true" className="text-4xl">
                📚
              </span>
            }
            title={t("sentenceShooter.emptyBooksTitle")}
          />
        ) : null}
        {bookState.status === "ready" && bookState.books.length > 0
          ? (() => {
              const totalBooksPages = Math.max(
                1,
                Math.ceil(bookState.books.length / SHOOTER_BOOKS_PAGE_SIZE),
              );
              const safeBooksPage = Math.min(
                Math.max(1, booksPage),
                totalBooksPages,
              );
              const visibleBooks = bookState.books.slice(
                (safeBooksPage - 1) * SHOOTER_BOOKS_PAGE_SIZE,
                safeBooksPage * SHOOTER_BOOKS_PAGE_SIZE,
              );
              return (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleBooks.map((book) => {
                      const selected = effectiveSelectedBookId === book.id;
                      return (
                        <button
                          aria-pressed={selected}
                          className={[
                            "flex min-h-28 items-center gap-4 rounded-control border bg-white p-4 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                            selected
                              ? "border-primary ring-2 ring-primary/20"
                              : "border-border hover:border-primary/60",
                          ].join(" ")}
                          key={book.id}
                          onClick={() => {
                            setHasManuallySelectedBook(true);
                            setSelectedBookId(book.id);
                          }}
                          type="button"
                        >
                          <BookCover book={toBookCover(book)} size="small" />
                          <span className="min-w-0">
                            <span
                              className="viread-learning-content block line-clamp-2 break-words font-extrabold text-ink"
                              dir="ltr"
                              lang="vi"
                            >
                              {book.title}
                            </span>
                            <span className="mt-1 block text-sm font-semibold text-muted">
                              {book.author ? (
                                <>
                                  {t("sentenceShooter.authorPrefix", {
                                    author: "",
                                  }).trimEnd()}{" "}
                                  <span
                                    className="viread-learning-content"
                                    dir="ltr"
                                    lang="vi"
                                  >
                                    {book.author}
                                  </span>
                                </>
                              ) : (
                                t("sentenceShooter.defaultBookSource")
                              )}
                            </span>
                            <span className="mt-3 inline-block rounded-full bg-success-surface px-3 py-1 text-xs font-extrabold text-success-ink">
                              {t("sentenceShooter.readyRoundsBadge", {
                                count: book.available_rounds,
                              })}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <PaginationBar
                    ariaLabel={t("sentenceShooter.booksPaginationAria")}
                    compact
                    itemLabel={t("sentenceShooter.booksPaginationItem")}
                    onPageChange={setBooksPage}
                    page={safeBooksPage}
                    pageSize={SHOOTER_BOOKS_PAGE_SIZE}
                    total={bookState.books.length}
                  />
                </>
              );
            })()
          : null}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
        <Link
          className="flex min-h-14 items-center justify-center gap-2 rounded-control px-5 font-bold text-primary hover:bg-sky"
          href="/entertainment"
        >
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-5" />{" "}
          {t("sentenceShooter.backToEntertainment")}
        </Link>
        <Button
          className="sm:max-w-sm"
          disabled={
            !selectedBook || isStartingSession || bookState.status !== "ready"
          }
          isLoading={isStartingSession}
          onClick={() => void startGame()}
        >
          <Play aria-hidden="true" className="size-5" />{" "}
          {t("sentenceShooter.startPlaying")}
        </Button>
      </div>
      {isStartingSession ? (
        <div className="mx-auto w-full max-w-md">
          <AiProgressBar
            active
            label={
              startSessionProgress.stageLabel ?? tCommon("aiProgress.preparing")
            }
            percent={startSessionProgress.percent}
            size="sm"
            testId="sentence-shooter-starting-progress"
          />
        </div>
      ) : null}
      <p className="text-center text-sm font-semibold text-muted">
        {t("sentenceShooter.duplicateTokenNote")}
      </p>
    </section>
  );
}
