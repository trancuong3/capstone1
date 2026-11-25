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
import { useSentenceShooterService } from "@/hooks/use-sentence-shooter-service";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
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
  title: string;
  description: string;
}> = [
  { value: "easy", title: "Dễ", description: "Câu ngắn, 3–5 từ" },
  { value: "medium", title: "Trung bình", description: "Câu vừa, 6–9 từ" },
  { value: "challenge", title: "Thử thách", description: "Câu dài, 10–14 từ" },
];

const learningModes: ReadonlyArray<{
  value: SentenceShooterLearningMode;
  title: string;
  description: string;
}> = [
  {
    value: "WORD_ORDER",
    title: "Xếp thứ tự từ",
    description: "Bắn lần lượt từng từ để ghép lại thành câu hoàn chỉnh.",
  },
  {
    value: "FILL_BLANK",
    title: "Điền từ vào chỗ trống",
    description: "Đọc câu còn thiếu và chọn từ phù hợp bắn vào chỗ trống.",
  },
  {
    value: "GRAMMAR_FOCUS",
    title: "Luyện ngữ pháp",
    description: "Luyện từ nối, từ chỉ hoạt động và dấu câu tiếng Việt.",
  },
];

const LEARNING_MODE_LABELS: Record<SentenceShooterLearningMode, string> = {
  WORD_ORDER: "Xếp thứ tự từ",
  FILL_BLANK: "Điền từ vào chỗ trống",
  GRAMMAR_FOCUS: "Luyện ngữ pháp",
};

const gameError = "Chưa kết nối được trò chơi. Ba mẹ và bé hãy thử lại nhé.";
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

export function SentenceShooterScreen({
  initialBookId,
  readingSessionId,
}: SentenceShooterScreenProps = {}) {
  const router = useRouter();
  const shooterService = useSentenceShooterService();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const child = childState.status === "ready" ? childState.child : null;
  const childId = child?.id ?? null;

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
  const SHOOTER_BOOKS_PAGE_SIZE = 9;
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
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [cannonAngle, setCannonAngle] = useState(0);
  const [wobbleTokenId, setWobbleTokenId] = useState("");
  const [prefetchedNextRound, setPrefetchedNextRound] =
    useState<SentenceShooterRoundDTO | null>(null);
  const [isLoadingResult, setIsLoadingResult] = useState(false);
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
  const soundEnabledRef = useRef(soundEnabled);
  const roundRef = useRef(round);

  const readingCompletionHref = readingSessionId
    ? `/reading/${encodeURIComponent(readingSessionId)}`
    : "/entertainment";
  const speechPlayer = useSpeechPlayer();

  useEffect(() => {
    shooterServiceRef.current = shooterService;
  }, [shooterService]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

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
          playShooterSound("wrong", soundEnabledRef.current);
        }
      },
      onShotError: (shot) => {
        setError("Chưa gửi được lượt bắn. Từ vẫn còn để bé thử lại nhé.");
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
      setBookState({ status: "loading" });
      setSelectedBookId("");
      try {
        const books = await shooterService.listBooks(
          selectedChildId,
          difficulty,
          totalRounds,
          controller.signal,
        );
        if (!active) return;
        setBooksPage(1);
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
  }, [childId, difficulty, reloadKey, shooterService, totalRounds]);

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

    if (prefersReducedMotion()) {
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
    playShooterSound("shot", soundEnabled);
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
        setError("Chưa lấy được gợi ý. Bé có thể thử lại sau nhé.");
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
        setError("Chưa mở được câu tiếp theo. Bé hãy thử lại nhé.");
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
    const shouldExit = window.confirm("Bé muốn kết thúc lượt chơi này chứ?");
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
      setError("Chưa thể lưu lượt chơi. Hãy thử thoát lại nhé.");
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
    if (!text.trim()) return;
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
          Đang xác minh hồ sơ của bé…
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title="Chưa xác minh được hồ sơ của bé" tone="error">
          Ba mẹ vui lòng thử lại trước khi bắt đầu trò chơi.
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" /> Thử lại
        </Button>
      </section>
    );
  }

  if (mode === "result" && (result || session)) {
    const summaryBookTitle = result?.book.title ?? session?.book.title ?? "";
    const summaryCompletedRounds =
      result?.completed_rounds ?? session?.completed_rounds ?? 0;
    const summaryTotalRounds =
      result?.total_rounds ?? session?.total_rounds ?? 0;
    const summaryTotalStars = result?.total_stars ?? session?.total_stars ?? 0;
    const summaryMode =
      result?.learning_mode ?? session?.learning_mode ?? learningMode;
    const summaryPracticedWords =
      result?.practiced_difficult_words ??
      session?.practiced_difficult_words ??
      [];

    return (
      <section className="mx-auto flex w-full max-w-[900px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
        <BookChildHeader
          backHref={readingCompletionHref}
          child={child}
          mobileLabel={readingSessionId ? "Kết quả đọc" : "Khu vui học"}
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
            Lượt chơi đã lưu · {LEARNING_MODE_LABELS[summaryMode]}
          </p>
          <h1 className="mt-2 text-heading font-extrabold text-ink">
            {result && result.status !== "COMPLETED"
              ? "Kết quả lượt chơi"
              : "Giỏi quá, bé đã hoàn thành!"}
          </h1>
          <p className="mt-2 text-body text-muted">{summaryBookTitle}</p>
          <div className="mx-auto mt-7 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [
                "Câu hoàn thành",
                `${summaryCompletedRounds}/${summaryTotalRounds}`,
              ],
              ["Từ ghép đúng", result ? String(result.correct_count) : "—"],
              ["Lần thử lại", result ? String(result.mistakes_total) : "—"],
              ["Gợi ý", result ? String(result.hint_count) : "—"],
            ].map(([label, value]) => (
              <div className="rounded-control bg-white/90 p-4" key={label}>
                <p className="text-sm font-bold text-muted">{label}</p>
                <p className="mt-1 text-2xl font-extrabold text-ink">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-warning-surface px-5 py-3 text-xl font-extrabold text-warning">
            <span aria-hidden="true">★</span> {summaryTotalStars} sao
          </p>
          {summaryPracticedWords.length > 0 ? (
            <p className="mt-4 inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full bg-sky px-4 py-1.5 text-sm font-bold text-primary">
              <Sparkles aria-hidden="true" className="size-4" />
              Từ khó bé vừa luyện: {summaryPracticedWords.join(", ")}
            </p>
          ) : null}
          {result ? (
            <p className="mt-3 text-sm font-semibold text-muted">
              Thời gian chơi: {Math.floor(result.duration_seconds / 60)} phút{" "}
              {result.duration_seconds % 60} giây
            </p>
          ) : isLoadingResult ? (
            <p className="mt-3 text-sm font-semibold text-muted" role="status">
              Đang tải chi tiết bảng tổng kết…
            </p>
          ) : resultError ? (
            <div className="mt-3 flex flex-col items-center gap-2">
              <p className="text-sm font-semibold text-danger">
                Chưa tải được chi tiết bảng tổng kết.
              </p>
              <Button
                onClick={() => void loadCompletedResult()}
                size="compact"
                variant="secondary"
              >
                <RefreshCw aria-hidden="true" className="size-4" /> Tải lại bảng
                tổng kết
              </Button>
            </div>
          ) : null}
          <div className="mx-auto mt-7 flex max-w-md flex-col gap-3 sm:flex-row">
            <Button
              className="sm:flex-1"
              onClick={restartLobby}
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-5" /> Chơi lượt mới
            </Button>
            <Button
              className="sm:flex-1"
              onClick={() => playSentenceAudio(finalSentence)}
              variant="quiet"
            >
              <Volume2 aria-hidden="true" className="size-5" /> Nghe lại câu
              hoàn chỉnh
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted">
            Câu cuối:{" "}
            {finalSentence || "Bé đã cùng khám phá những câu trong cuốn sách!"}
          </p>
        </div>
        <Link
          className="self-center rounded-control px-4 py-3 font-bold text-primary hover:bg-sky"
          href={readingCompletionHref}
        >
          <ArrowLeft aria-hidden="true" className="mr-2 inline size-4" />
          {readingSessionId ? "Quay lại kết quả đọc" : "Về khu Giải trí"}
        </Link>
      </section>
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
      <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-3 px-4 py-4 sm:px-6 sm:py-5">
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel="Khu vui học"
        />
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-border bg-white px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-extrabold text-ink">
                {session.book.title}
              </h1>
              <span className="rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary">
                {LEARNING_MODE_LABELS[activeLearningMode]}
              </span>
              {activePracticedWords.length > 0 ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-warning-surface px-2.5 py-0.5 text-xs font-extrabold text-warning"
                  data-testid="difficult-word-badge"
                >
                  <Sparkles aria-hidden="true" className="size-3.5" />
                  {activeLearningMode === "WORD_ORDER" || roundComplete
                    ? `Ôn từ khó: ${activePracticedWords.join(", ")}`
                    : "Có từ bé đang luyện"}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm font-bold text-muted">
              Câu {round.round_number}/{session.total_rounds}
            </p>
          </div>
          <div
            className="flex items-center gap-3"
            role="group"
            aria-label={`Đã ghép ${placedTokens.length} trên ${round.token_count} từ`}
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
              aria-label={`${session.total_stars} sao`}
              className="inline-flex items-center gap-1 font-extrabold text-warning"
            >
              <span aria-hidden="true">★</span>
              {session.total_stars}
            </span>
            {sessionScore > 0 ? (
              <span
                className="rounded-full bg-success-surface px-2.5 py-0.5 text-xs font-extrabold text-success-ink"
                data-testid="session-score"
              >
                {sessionScore} điểm
              </span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button
              aria-label={soundEnabled ? "Tắt âm thanh" : "Bật âm thanh"}
              aria-pressed={soundEnabled}
              className="flex size-11 items-center justify-center rounded-control bg-sky text-primary hover:bg-border"
              onClick={() => setSoundEnabled((enabled) => !enabled)}
              type="button"
            >
              {soundEnabled ? (
                <Volume2 aria-hidden="true" className="size-5" />
              ) : (
                <VolumeX aria-hidden="true" className="size-5" />
              )}
            </button>
            <button
              aria-label="Tạm dừng"
              className="flex min-h-11 items-center justify-center gap-2 rounded-control bg-sky px-3 font-bold text-primary hover:bg-border disabled:opacity-55"
              onClick={() => setIsPaused(true)}
              type="button"
            >
              <Pause aria-hidden="true" className="size-5" />
              <span className="hidden sm:inline">Tạm dừng</span>
            </button>
            <button
              className="flex min-h-11 items-center justify-center rounded-control px-3 font-bold text-danger hover:bg-danger-surface disabled:opacity-55"
              disabled={isExiting}
              onClick={() => void exitGame()}
              type="button"
            >
              Thoát
            </button>
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
                  ? "Điền từ vào chỗ trống"
                  : activeLearningMode === "GRAMMAR_FOCUS"
                    ? "Hoàn thiện ngữ pháp câu"
                    : "Câu của bé"}
              </p>
              <div
                role="list"
                className="flex w-full flex-wrap gap-2"
                aria-label="Các ô ghép câu"
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
                              ? `Ô ${slotIndex + 1}: ${confirmed.text}`
                              : optimistic
                                ? `Ô ${slotIndex + 1}: ${optimistic.text} (đang kiểm tra)`
                                : `Ô ${slotIndex + 1} còn trống`
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
                                className="mr-1 size-4 shrink-0"
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
                              ? `Ô ${index + 1}: ${confirmed.text}`
                              : optimistic
                                ? `Ô ${index + 1}: ${optimistic.text} (đang kiểm tra)`
                                : `Ô ${index + 1} còn trống`
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
                                className="mr-1 size-4 shrink-0"
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
                {round.prompt_hint || "Chọn từ tiếp theo"}
              </p>
              <div
                role="group"
                className="flex w-full flex-wrap items-center gap-2.5"
                aria-label="Các từ để ghép"
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
                        hinted ? `${token.text} · Từ gợi ý` : undefined
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
                            title="Từ bé đang luyện"
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
                {pendingShots.length > 0
                  ? pendingShots.length > 1
                    ? `Đang kiểm tra ${pendingShots.length} từ bé chọn…`
                    : "Đang kiểm tra từ bé chọn…"
                  : feedback || "Bấm vào một từ để ghép câu."}
              </p>
              <button
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-warning-surface px-3 font-bold text-warning hover:bg-book-orange disabled:opacity-55"
                disabled={isRequestingHint || isPaused || roundComplete}
                onClick={() => void requestHint()}
                type="button"
              >
                <Lightbulb aria-hidden="true" className="size-5" /> Gợi ý một từ
              </button>
            </div>
            {roundComplete ? (
              <div className="w-full rounded-card border border-[#B6DDBB] bg-success-surface p-5 text-center">
                <p className="text-xl font-extrabold text-success-ink">
                  {completedDisplaySentence}
                </p>
                <p className="mt-2 font-bold text-success-ink">
                  Tuyệt vời! Bé đã ghép đúng cả câu.
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <button
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-[#98D4A2] bg-white px-4 py-1.5 text-sm font-extrabold text-success-ink hover:bg-cream"
                    onClick={() => playSentenceAudio(completedDisplaySentence)}
                    type="button"
                  >
                    <Volume2 aria-hidden="true" className="size-4" />
                    Nghe lại câu hoàn chỉnh
                  </button>
                  {activePracticedWords.length > 0 ? (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full bg-warning-surface px-3.5 py-1.5 text-xs font-extrabold text-warning"
                      data-testid="practiced-difficult-words"
                    >
                      <Sparkles aria-hidden="true" className="size-3.5" />
                      Từ bé vừa luyện: {activePracticedWords.join(", ")}
                    </span>
                  ) : null}
                </div>
                {roundGrammarTip ? (
                  <p
                    className="mx-auto mt-3 inline-flex max-w-xl items-center gap-2 rounded-control bg-white/90 px-4 py-2 text-sm font-bold text-primary"
                    data-testid="grammar-tip-pill"
                  >
                    <BookOpen aria-hidden="true" className="size-4 shrink-0" />
                    <span>{roundGrammarTip}</span>
                  </p>
                ) : null}
                <div className="mt-4">
                  {session.completed_rounds < session.total_rounds ? (
                    <Button
                      className="mx-auto max-w-sm"
                      disabled={isLoadingNextRound}
                      isLoading={isLoadingNextRound}
                      onClick={() => void continueToNextRound()}
                    >
                      <Play aria-hidden="true" className="size-5" /> Câu tiếp
                      theo
                    </Button>
                  ) : (
                    <Button
                      className="mx-auto max-w-sm"
                      disabled={isLoadingResult}
                      isLoading={isLoadingResult}
                      onClick={() => void loadCompletedResult()}
                    >
                      <RefreshCw aria-hidden="true" className="size-5" /> Xem
                      kết quả
                    </Button>
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
                <Play aria-hidden="true" className="size-5" /> Chơi tiếp
              </Button>
              <Button
                className="sm:flex-1"
                onClick={() => void exitGame()}
                variant="quiet"
              >
                Kết thúc lượt
              </Button>
            </div>
          }
          isOpen={isPaused}
          onClose={() => setIsPaused(false)}
          showCloseButton={false}
          title="Tạm nghỉ một chút nhé?"
          tone="paper"
        >
          <p className="text-muted">Lượt chơi của bé đang được giữ lại.</p>
          {error ? (
            <StatusMessage className="mt-4 text-left" tone="error">
              {error}
            </StatusMessage>
          ) : null}
        </Modal>
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-6 px-4 py-4 sm:px-8 sm:py-7">
      <BookChildHeader
        backHref={readingCompletionHref}
        child={child}
        mobileLabel={readingSessionId ? "Kết quả đọc" : "Khu vui học"}
      />
      <header className="flex flex-col gap-2 border-b border-border pb-5">
        <p className="font-extrabold text-primary">Xạ thủ ghép câu</p>
        <h1 className="text-heading font-extrabold text-ink">
          Chọn sách và bắt đầu chơi
        </h1>
        <p className="text-body text-muted">
          Chọn chế độ học, độ khó và một cuốn sách để cùng bắn từ hoàn thiện
          câu.
        </p>
      </header>

      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}

      {initialBookId &&
      bookState.status === "ready" &&
      !hasManuallySelectedBook &&
      !bookState.books.some((book) => book.id === initialBookId) ? (
        <StatusMessage title="Cuốn sách chưa sẵn sàng" tone="warning">
          Cuốn sách bé vừa đọc chưa có đủ câu phù hợp với độ khó và số câu hiện
          tại. Bé có thể đổi lựa chọn hoặc chọn sách khác bên dưới.
        </StatusMessage>
      ) : null}

      <fieldset>
        <legend className="mb-3 text-lg font-extrabold text-ink">
          Chọn chế độ học
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {learningModes.map((option) => (
            <button
              aria-pressed={learningMode === option.value}
              className={[
                "min-h-24 rounded-card border-2 p-4 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                learningMode === option.value
                  ? "border-primary bg-sky"
                  : "border-border bg-white hover:bg-sky/50",
              ].join(" ")}
              key={option.value}
              onClick={() => setLearningMode(option.value)}
              type="button"
            >
              <span className="flex items-center justify-between font-extrabold text-ink">
                {option.title}
                {learningMode === option.value ? (
                  <Check aria-hidden="true" className="size-5 text-primary" />
                ) : null}
              </span>
              <span className="mt-1 block text-sm font-semibold text-muted">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-lg font-extrabold text-ink">
          Chọn độ khó
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {difficulties.map((option) => (
            <button
              aria-pressed={difficulty === option.value}
              className={[
                "min-h-24 rounded-card border-2 p-4 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                difficulty === option.value
                  ? "border-primary bg-sky"
                  : "border-border bg-white hover:bg-sky/50",
              ].join(" ")}
              key={option.value}
              onClick={() => setDifficulty(option.value)}
              type="button"
            >
              <span className="flex items-center justify-between font-extrabold text-ink">
                {option.title}
                {difficulty === option.value ? (
                  <Check aria-hidden="true" className="size-5 text-primary" />
                ) : null}
              </span>
              <span className="mt-1 block text-sm font-semibold text-muted">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-lg font-extrabold text-ink">
          Số câu trong lượt chơi
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
              {count} câu
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-extrabold text-ink">Chọn sách</h2>
          <span className="text-sm font-semibold text-muted">
            Đang chọn: {LEARNING_MODE_LABELS[learningMode]} ·{" "}
            {difficulties.find((option) => option.value === difficulty)?.title}{" "}
            · {totalRounds} câu
          </span>
        </div>
        {initialBookId && selectedBook?.id === initialBookId ? (
          <p className="mb-3 rounded-control bg-success-surface px-4 py-3 text-sm font-semibold text-success-ink">
            <Gamepad2 aria-hidden="true" className="mr-2 inline size-4" />
            Đã chọn sách bé vừa đọc: <strong>{selectedBook.title}</strong>
          </p>
        ) : null}
        {bookState.status === "loading" ? (
          <div
            aria-busy="true"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <span className="sr-only" role="status">
              Đang tìm sách có câu phù hợp…
            </span>
            {[0, 1, 2].map((item) => (
              <Skeleton className="h-48 w-full rounded-card" key={item} />
            ))}
          </div>
        ) : null}
        {bookState.status === "error" ? (
          <div className="flex flex-col gap-3">
            <StatusMessage title="Chưa tải được danh sách sách" tone="error">
              {gameError}
            </StatusMessage>
            <Button
              className="sm:w-auto"
              onClick={() => setReloadKey((key) => key + 1)}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-5" /> Thử lại
            </Button>
          </div>
        ) : null}
        {bookState.status === "ready" && bookState.books.length === 0 ? (
          <EmptyState
            description="Chưa có sách phù hợp với độ khó và số câu đã chọn. Hãy thử mức dễ hơn hoặc chọn 3 câu."
            icon={
              <span aria-hidden="true" className="text-4xl">
                📚
              </span>
            }
            title="Chưa có sách sẵn sàng"
          />
        ) : null}
        {bookState.status === "ready" && bookState.books.length > 0 ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {bookState.books
                .slice(
                  (booksPage - 1) * SHOOTER_BOOKS_PAGE_SIZE,
                  booksPage * SHOOTER_BOOKS_PAGE_SIZE,
                )
                .map((book) => {
                  const selected = effectiveSelectedBookId === book.id;
                  return (
                    <button
                      aria-pressed={selected}
                      className={[
                        "flex min-h-28 items-center gap-4 rounded-control border bg-white p-4 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
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
                        <span className="block line-clamp-2 break-words font-extrabold text-ink">
                          {book.title}
                        </span>
                        <span className="mt-1 block text-sm font-semibold text-muted">
                          {book.author
                            ? `Tác giả: ${book.author}`
                            : "Sách ViRead"}
                        </span>
                        <span className="mt-3 inline-block rounded-full bg-success-surface px-3 py-1 text-xs font-extrabold text-success-ink">
                          Sẵn sàng chơi · {book.available_rounds} câu phù hợp
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
            <PaginationBar
              ariaLabel="Phân trang sách Xạ thủ ghép câu"
              compact
              itemLabel="cuốn sách"
              onPageChange={setBooksPage}
              page={booksPage}
              pageSize={SHOOTER_BOOKS_PAGE_SIZE}
              total={bookState.books.length}
            />
          </>
        ) : null}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
        <Link
          className="flex min-h-14 items-center justify-center gap-2 rounded-control px-5 font-bold text-primary hover:bg-sky"
          href="/entertainment"
        >
          <ArrowLeft aria-hidden="true" className="size-5" /> Về khu Giải trí
        </Link>
        <Button
          className="sm:max-w-sm"
          disabled={
            !selectedBook || isStartingSession || bookState.status !== "ready"
          }
          isLoading={isStartingSession}
          onClick={() => void startGame()}
        >
          <Play aria-hidden="true" className="size-5" /> Bắt đầu chơi
        </Button>
      </div>
      <p className="text-center text-sm font-semibold text-muted">
        Mỗi từ có thẻ riêng, kể cả khi trong câu có từ lặp lại.
      </p>
    </section>
  );
}
