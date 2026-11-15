"use client";

import {
  ArrowLeft,
  Check,
  Lightbulb,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
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
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";
import { useSentenceShooterService } from "@/hooks/use-sentence-shooter-service";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import type {
  SentenceShooterBookDTO,
  SentenceShooterDifficulty,
  SentenceShooterResultDTO,
  SentenceShooterRoundDTO,
  SentenceShooterSessionDTO,
  SentenceShooterTokenDTO,
} from "@/types/sentence-shooter";
import type { BookListItemDTO } from "@/types/book";

type ScreenMode = "lobby" | "playing" | "result";
type BookLoadState =
  | { status: "loading" }
  | { status: "ready"; books: SentenceShooterBookDTO[] }
  | { status: "error" };

const difficulties: ReadonlyArray<{
  value: SentenceShooterDifficulty;
  title: string;
  description: string;
}> = [
  { value: "easy", title: "Dễ", description: "Câu ngắn, 3–5 từ" },
  { value: "medium", title: "Trung bình", description: "Câu vừa, 6–9 từ" },
  { value: "challenge", title: "Thử thách", description: "Câu dài, 10–14 từ" },
];

const gameError = "Chưa kết nối được trò chơi. Ba mẹ và bé hãy thử lại nhé.";

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

function playSound(kind: "shot" | "correct" | "wrong" | "celebrate") {
  if (typeof window === "undefined") return;
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return;

  try {
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const frequencies = {
      shot: [520],
      correct: [660, 880],
      wrong: [300],
      celebrate: [660, 784, 988],
    } as const;
    const notes = frequencies[kind];
    const firstNote = notes[0] ?? 520;
    const secondNote = notes[1];
    const thirdNote = notes[2];
    oscillator.type = kind === "wrong" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(firstNote, context.currentTime);
    if (secondNote !== undefined) {
      oscillator.frequency.setValueAtTime(
        secondNote,
        context.currentTime + 0.1,
      );
    }
    if (thirdNote !== undefined) {
      oscillator.frequency.setValueAtTime(thirdNote, context.currentTime + 0.2);
    }
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      context.currentTime + (notes.length > 1 ? 0.34 : 0.18),
    );
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (notes.length > 1 ? 0.36 : 0.2));
    oscillator.onended = () => void context.close();
  } catch {
    // Sound is optional; a browser audio restriction never blocks a turn.
  }
}

export function SentenceShooterScreen() {
  const router = useRouter();
  const shooterService = useSentenceShooterService();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const child = childState.status === "ready" ? childState.child : null;
  const childId = child?.id ?? null;
  const [difficulty, setDifficulty] =
    useState<SentenceShooterDifficulty>("easy");
  const [totalRounds, setTotalRounds] = useState<3 | 5>(3);
  const [bookState, setBookState] = useState<BookLoadState>({
    status: "loading",
  });
  const [selectedBookId, setSelectedBookId] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<ScreenMode>("lobby");
  const [session, setSession] = useState<SentenceShooterSessionDTO | null>(
    null,
  );
  const [round, setRound] = useState<SentenceShooterRoundDTO | null>(null);
  const [result, setResult] = useState<SentenceShooterResultDTO | null>(null);
  const [finalSentence, setFinalSentence] = useState("");
  const [placedTokens, setPlacedTokens] = useState<SentenceShooterTokenDTO[]>(
    [],
  );
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const [hintTargetId, setHintTargetId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [cannonAngle, setCannonAngle] = useState(0);
  const [firingTokenId, setFiringTokenId] = useState("");
  const [wobbleTokenId, setWobbleTokenId] = useState("");
  const [projectile, setProjectile] = useState<{
    id: number;
    left: number;
    top: number;
    dx: number;
    dy: number;
  } | null>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const cannonRef = useRef<HTMLDivElement>(null);
  const tokenButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const shotIdRef = useRef(0);

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

  const selectedBook = useMemo(
    () =>
      bookState.status === "ready"
        ? (bookState.books.find((book) => book.id === selectedBookId) ?? null)
        : null,
    [bookState, selectedBookId],
  );
  const placedTokenIds = useMemo(
    () => new Set(placedTokens.map((token) => token.id)),
    [placedTokens],
  );

  function selectToken(token: SentenceShooterTokenDTO) {
    if (
      isBusy ||
      isPaused ||
      mode !== "playing" ||
      placedTokenIds.has(token.id)
    ) {
      return;
    }
    setSelectedTokenId(token.id);
    setHintTargetId("");

    const target = tokenButtonRefs.current.get(token.id);
    const cannon = cannonRef.current;
    if (!target || !cannon) return;
    const targetRect = target.getBoundingClientRect();
    const cannonRect = cannon.getBoundingClientRect();
    const muzzleX = cannonRect.left + cannonRect.width / 2;
    const muzzleY = cannonRect.top + cannonRect.height * 0.2;
    const targetX = targetRect.left + targetRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2;
    const angle =
      (Math.atan2(targetX - muzzleX, muzzleY - targetY) * 180) / Math.PI;
    setCannonAngle(Math.max(-58, Math.min(58, angle)));
    void fireToken(token);
  }

  function animateShot(tokenId: string) {
    const arena = arenaRef.current;
    const cannon = cannonRef.current;
    const target = tokenButtonRefs.current.get(tokenId);
    if (!arena || !cannon || !target) return;
    const bounds = arena.getBoundingClientRect();
    const cannonBounds = cannon.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const startX = cannonBounds.left + cannonBounds.width / 2 - bounds.left;
    const startY = cannonBounds.top + cannonBounds.height * 0.2 - bounds.top;
    const endX = targetBounds.left + targetBounds.width / 2 - bounds.left;
    const endY = targetBounds.top + targetBounds.height / 2 - bounds.top;
    shotIdRef.current += 1;
    setProjectile({
      id: shotIdRef.current,
      left: startX,
      top: startY,
      dx: endX - startX,
      dy: endY - startY,
    });
  }

  async function startGame() {
    if (!child || !selectedBook || isBusy) return;
    setIsBusy(true);
    setError("");
    try {
      const created = await shooterService.createSession({
        child_id: child.id,
        book_id: selectedBook.id,
        difficulty,
        total_rounds: totalRounds,
      });
      setSession(created);
      setRound(created.round);
      setPlacedTokens([]);
      setSelectedTokenId("");
      setHintTargetId("");
      setFeedback("");
      setResult(null);
      setFinalSentence("");
      setMode("playing");
      setIsPaused(false);
    } catch {
      setError(gameError);
    } finally {
      setIsBusy(false);
    }
  }

  async function fireToken(token: SentenceShooterTokenDTO) {
    if (!session || !round || isBusy || isPaused) return;
    setIsBusy(true);
    setError("");
    setFeedback("");
    setFiringTokenId(token.id);
    setWobbleTokenId("");
    animateShot(token.id);
    if (soundEnabled) playSound("shot");

    try {
      const response = await shooterService.shoot(session.session_id, {
        round_id: round.round_id,
        token_id: token.id,
        request_id: crypto.randomUUID(),
      });
      setFeedback(response.message);
      setSelectedTokenId("");
      if (response.is_correct) {
        setPlacedTokens((current) => [...current, token]);
        setHintTargetId("");
        if (soundEnabled) {
          playSound(response.session_completed ? "celebrate" : "correct");
        }
        if (response.round_completed) {
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
            setFinalSentence(response.completed_sentence ?? "");
            try {
              const completedResult = await shooterService.result(
                session.session_id,
              );
              setResult(completedResult);
              setMode("result");
            } catch {
              setError(
                "Câu cuối đã hoàn thành. Chưa tải được bảng kết quả; hãy thử tải lại kết quả.",
              );
            }
          }
        }
      } else {
        setWobbleTokenId(token.id);
        if (soundEnabled) playSound("wrong");
      }
    } catch {
      setError("Chưa gửi được lượt bắn. Từ vẫn còn để bé thử lại nhé.");
      setSelectedTokenId(token.id);
    } finally {
      setIsBusy(false);
      setFiringTokenId("");
    }
  }

  async function requestHint() {
    if (
      !session ||
      !round ||
      isBusy ||
      isPaused ||
      placedTokens.length >= round.token_count
    ) {
      return;
    }
    setIsBusy(true);
    setError("");
    try {
      const hint = await shooterService.hint(
        session.session_id,
        round.round_id,
      );
      setHintTargetId(hint.target_token_id);
      setFeedback(hint.message);
    } catch {
      setError("Chưa lấy được gợi ý. Bé có thể thử lại sau nhé.");
    } finally {
      setIsBusy(false);
    }
  }

  async function continueToNextRound() {
    if (!session || !round || isBusy) return;
    setIsBusy(true);
    setError("");
    try {
      const next = await shooterService.nextRound(
        session.session_id,
        round.round_id,
      );
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
    } catch {
      setError("Chưa mở được câu tiếp theo. Bé hãy thử lại nhé.");
    } finally {
      setIsBusy(false);
    }
  }

  async function loadCompletedResult() {
    if (!session || isBusy) return;
    setIsBusy(true);
    setError("");
    try {
      const completedResult = await shooterService.result(session.session_id);
      setResult(completedResult);
      setMode("result");
    } catch {
      setError("Chưa tải được bảng kết quả. Bé hãy thử lại nhé.");
    } finally {
      setIsBusy(false);
    }
  }

  async function exitGame() {
    if (!session || isBusy) return;
    const shouldExit = window.confirm("Bé muốn kết thúc lượt chơi này chứ?");
    if (!shouldExit) return;
    setIsBusy(true);
    setError("");
    try {
      await shooterService.abandon(session.session_id);
      router.push("/entertainment");
    } catch {
      setError("Chưa thể lưu lượt chơi. Hãy thử thoát lại nhé.");
      setIsBusy(false);
    }
  }

  function restartLobby() {
    setMode("lobby");
    setSession(null);
    setRound(null);
    setResult(null);
    setFinalSentence("");
    setPlacedTokens([]);
    setSelectedTokenId("");
    setFeedback("");
    setError("");
    setIsPaused(false);
  }

  function readSentence() {
    if (!result || typeof window === "undefined" || !window.speechSynthesis)
      return;
    const utterance = new SpeechSynthesisUtterance(finalSentence);
    if (!utterance.text) return;
    utterance.lang = "vi-VN";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
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

  if (mode === "result" && result) {
    return (
      <section className="mx-auto flex w-full max-w-[900px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel="Khu vui học"
        />
        <div className="relative overflow-hidden rounded-card border border-border bg-gradient-to-br from-[#FFF8D9] via-white to-[#E2F7F7] p-6 text-center shadow-sm sm:p-10">
          <div
            aria-hidden="true"
            className="mb-3 flex justify-center gap-3 text-warning"
          >
            <span className="text-3xl">✦</span>
            <span className="mt-3 text-4xl">★</span>
            <span className="text-3xl">✦</span>
          </div>
          <p className="font-extrabold text-primary">Lượt chơi đã lưu</p>
          <h1 className="mt-2 text-heading font-extrabold text-ink">
            {result.status === "COMPLETED"
              ? "Giỏi quá, bé đã hoàn thành!"
              : "Kết quả lượt chơi"}
          </h1>
          <p className="mt-2 text-body text-muted">{result.book.title}</p>
          <div className="mx-auto mt-7 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [
                "Câu hoàn thành",
                `${result.completed_rounds}/${result.total_rounds}`,
              ],
              ["Từ ghép đúng", String(result.correct_count)],
              ["Lần thử lại", String(result.mistakes_total)],
              ["Gợi ý", String(result.hint_count)],
            ].map(([label, value]) => (
              <div className="rounded-control bg-white/90 p-4" key={label}>
                <p className="text-sm font-bold text-muted">{label}</p>
                <p className="mt-1 text-2xl font-extrabold text-ink">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-warning-surface px-5 py-3 text-xl font-extrabold text-warning">
            <span aria-hidden="true">★</span> {result.total_stars} sao
          </p>
          <p className="mt-3 text-sm font-semibold text-muted">
            Thời gian chơi: {Math.floor(result.duration_seconds / 60)} phút{" "}
            {result.duration_seconds % 60} giây
          </p>
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
              onClick={readSentence}
              variant="quiet"
            >
              Đọc câu mẫu
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted">
            Câu cuối:{" "}
            {finalSentence || "Bé đã cùng khám phá những câu trong cuốn sách!"}
          </p>
        </div>
        <Link
          className="self-center rounded-control px-4 py-3 font-bold text-primary hover:bg-sky"
          href="/entertainment"
        >
          <ArrowLeft aria-hidden="true" className="mr-2 inline size-4" /> Về khu
          Giải trí
        </Link>
      </section>
    );
  }

  if (mode === "playing" && session && round) {
    const roundComplete = placedTokens.length === round.token_count;
    const shotStyle = projectile
      ? ({
          left: projectile.left,
          top: projectile.top,
          "--shot-dx": `${projectile.dx}px`,
          "--shot-dy": `${projectile.dy}px`,
        } as CSSProperties & Record<"--shot-dx" | "--shot-dy", string>)
      : undefined;

    return (
      <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-5 px-4 py-4 sm:px-8 sm:py-7">
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel="Khu vui học"
        />
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-white p-4 shadow-sm sm:p-5">
          <div className="min-w-0 flex-1">
            <p className="truncate font-extrabold text-ink">
              {session.book.title}
            </p>
            <p className="mt-1 text-sm font-bold text-muted">
              Câu {round.round_number}/{session.total_rounds}
            </p>
          </div>
          <div
            className="flex items-center gap-3"
            aria-label={`Đã ghép ${placedTokens.length} trên ${round.token_count} từ`}
          >
            <div className="h-3 w-24 overflow-hidden rounded-full bg-sky sm:w-36">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{
                  width: `${(placedTokens.length / round.token_count) * 100}%`,
                }}
              />
            </div>
            <span className="inline-flex items-center gap-1 font-extrabold text-warning">
              <span aria-hidden="true">★</span>
              {session.total_stars}
            </span>
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
              className="flex min-h-11 items-center justify-center gap-2 rounded-control bg-sky px-3 font-bold text-primary hover:bg-border disabled:opacity-55"
              disabled={isBusy}
              onClick={() => setIsPaused(true)}
              type="button"
            >
              <Pause aria-hidden="true" className="size-5" />
              <span className="hidden sm:inline">Tạm dừng</span>
            </button>
            <button
              className="flex min-h-11 items-center justify-center rounded-control px-3 font-bold text-danger hover:bg-danger-surface disabled:opacity-55"
              disabled={isBusy}
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
          className="relative isolate overflow-hidden rounded-card border border-border bg-gradient-to-b from-[#EAF8FF] via-white to-[#FFF8E8] p-4 shadow-sm sm:p-7"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-20 -z-10 size-56 rounded-full bg-purple/50 blur-3xl"
          />
          <div className="flex flex-col items-center gap-5">
            <div
              className="flex min-h-[120px] w-full flex-wrap items-center justify-center gap-3 rounded-card bg-white/75 p-4 sm:min-h-[145px] sm:gap-4 sm:p-6"
              aria-label="Các từ để ghép"
            >
              {round.tokens.map((token, index) => {
                const placed = placedTokenIds.has(token.id);
                const selected = selectedTokenId === token.id;
                const hinted = hintTargetId === token.id && !placed;
                return (
                  <button
                    aria-pressed={selected}
                    className={[
                      "min-h-12 rounded-full border px-4 py-2 text-lg font-extrabold text-ink shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:min-h-14 sm:px-5",
                      placed
                        ? "invisible pointer-events-none"
                        : index % 3 === 0
                          ? "border-white bg-white"
                          : index % 3 === 1
                            ? "border-[#BFE8F3] bg-[#E1F7FF]"
                            : "border-[#F3E4AA] bg-[#FFF6CF]",
                      selected ? "scale-105 ring-3 ring-primary" : "",
                      hinted
                        ? "ring-4 ring-warning shadow-[0_0_0_6px_rgba(255,217,104,0.25)]"
                        : "",
                      firingTokenId === token.id ? "opacity-70" : "",
                      wobbleTokenId === token.id ? "sentence-token-wobble" : "",
                    ].join(" ")}
                    disabled={placed || isBusy || isPaused}
                    key={token.id}
                    onAnimationEnd={() => {
                      if (wobbleTokenId === token.id) setWobbleTokenId("");
                    }}
                    onClick={() => selectToken(token)}
                    ref={(element) => {
                      if (element)
                        tokenButtonRefs.current.set(token.id, element);
                      else tokenButtonRefs.current.delete(token.id);
                    }}
                    type="button"
                  >
                    {token.text}
                  </button>
                );
              })}
            </div>

            <div
              className="flex w-full flex-wrap justify-center gap-2"
              aria-label="Các ô ghép câu"
            >
              {round.tokens.map((token, index) => (
                <div
                  aria-label={
                    placedTokens[index]
                      ? `Ô ${index + 1}: ${placedTokens[index].text}`
                      : `Ô ${index + 1} còn trống`
                  }
                  className={[
                    "flex min-h-12 min-w-[54px] max-w-full items-center justify-center rounded-control border-2 px-3 py-2 text-center text-base font-extrabold sm:min-h-14 sm:min-w-[70px] sm:px-4 sm:text-lg",
                    placedTokens[index]
                      ? "sentence-success-pulse border-[#98D4A2] bg-success-surface text-success-ink"
                      : "border-dashed border-[#B8CECA] bg-white/80 text-muted/60",
                  ].join(" ")}
                  key={index}
                  role="listitem"
                >
                  {placedTokens[index]?.text ?? "···"}
                </div>
              ))}
            </div>

            <div className="flex w-full flex-col items-center gap-3 py-1 sm:gap-4">
              <div
                ref={cannonRef}
                className="transition-transform duration-200 ease-out"
              >
                <ToyCannon
                  angle={cannonAngle}
                  className="h-28 w-28 sm:h-32 sm:w-32"
                />
              </div>
              <div className="flex w-full max-w-xl flex-col items-center gap-2">
                <p className="px-3 text-center text-sm font-bold leading-relaxed text-ink sm:text-base">
                  Chạm vào một từ để khẩu súng tự ngắm và bắn ngôi sao.
                </p>
                <button
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-sky px-4 font-bold text-primary transition-[transform,background-color] duration-150 hover:bg-sky/75 active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:opacity-55"
                  disabled={isBusy || isPaused || roundComplete}
                  onClick={() => void requestHint()}
                  type="button"
                >
                  <Lightbulb aria-hidden="true" className="size-5" /> Gợi ý một
                  từ
                </button>
              </div>
            </div>

            {feedback ? (
              <p
                aria-live="polite"
                className="min-h-7 text-center text-lg font-extrabold text-primary"
                role="status"
              >
                {feedback}
              </p>
            ) : (
              <div aria-hidden="true" className="min-h-7" />
            )}
            {roundComplete ? (
              <div className="w-full rounded-card border border-[#B6DDBB] bg-success-surface p-5 text-center">
                <p className="text-xl font-extrabold text-success-ink">
                  {placedTokens.map((token) => token.text).join(" ")}
                </p>
                <p className="mt-2 font-bold text-success-ink">
                  Tuyệt vời! Bé đã ghép đúng cả câu.
                </p>
                {session.completed_rounds < session.total_rounds ? (
                  <Button
                    className="mx-auto mt-4 max-w-sm"
                    disabled={isBusy}
                    isLoading={isBusy}
                    onClick={() => void continueToNextRound()}
                  >
                    <Play aria-hidden="true" className="size-5" /> Câu tiếp theo
                  </Button>
                ) : (
                  <Button
                    className="mx-auto mt-4 max-w-sm"
                    disabled={isBusy}
                    isLoading={isBusy}
                    onClick={() => void loadCompletedResult()}
                  >
                    <RefreshCw aria-hidden="true" className="size-5" /> Xem kết
                    quả
                  </Button>
                )}
              </div>
            ) : null}
          </div>
          {projectile ? (
            <span
              aria-hidden="true"
              className="sentence-shot-projectile pointer-events-none absolute z-20 flex size-5 items-center justify-center text-warning"
              key={projectile.id}
              onAnimationEnd={() => setProjectile(null)}
              style={shotStyle}
            >
              ✦
            </span>
          ) : null}
        </div>

        {isPaused ? (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/45 p-4">
            <section
              aria-labelledby="pause-title"
              aria-modal="true"
              className="w-full max-w-md rounded-card bg-white p-6 text-center shadow-xl"
              role="dialog"
            >
              <h2 className="text-2xl font-extrabold text-ink" id="pause-title">
                Tạm nghỉ một chút nhé?
              </h2>
              <p className="mt-2 text-muted">
                Lượt chơi của bé đang được giữ lại.
              </p>
              {error ? (
                <StatusMessage className="mt-4 text-left" tone="error">
                  {error}
                </StatusMessage>
              ) : null}
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Button
                  className="sm:flex-1"
                  onClick={() => setIsPaused(false)}
                  variant="secondary"
                >
                  <Play aria-hidden="true" className="size-5" /> Chơi tiếp
                </Button>
                <Button
                  className="sm:flex-1"
                  disabled={isBusy}
                  onClick={() => void exitGame()}
                  variant="quiet"
                >
                  Kết thúc lượt
                </Button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-6 px-4 py-4 sm:px-8 sm:py-7">
      <BookChildHeader
        backHref="/entertainment"
        child={child}
        mobileLabel="Khu vui học"
      />
      <header className="flex flex-col gap-2">
        <p className="font-extrabold text-primary">Xạ thủ ghép câu</p>
        <h1 className="text-heading font-extrabold text-ink">
          Chọn sách và bắt đầu chơi
        </h1>
        <p className="text-body text-muted">
          Mỗi câu đều lấy từ nội dung sách đã được xác minh.
        </p>
      </header>

      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}

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
            Đang chọn:{" "}
            {difficulties.find((option) => option.value === difficulty)?.title}{" "}
            · {totalRounds} câu
          </span>
        </div>
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {bookState.books.map((book) => {
              const selected = selectedBookId === book.id;
              return (
                <button
                  aria-pressed={selected}
                  className={[
                    "flex min-h-40 items-center gap-4 rounded-card border-2 bg-white p-4 text-left shadow-sm transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                    selected
                      ? "border-primary ring-2 ring-primary/20"
                      : "border-border hover:border-primary/60",
                  ].join(" ")}
                  key={book.id}
                  onClick={() => setSelectedBookId(book.id)}
                  type="button"
                >
                  <BookCover
                    book={toBookCover(book)}
                    className="h-36 w-24 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block line-clamp-2 font-extrabold text-ink">
                      {book.title}
                    </span>
                    <span className="mt-1 block text-sm font-semibold text-muted">
                      {book.author ? `Tác giả: ${book.author}` : "Sách ViRead"}
                    </span>
                    <span className="mt-3 inline-block rounded-full bg-success-surface px-3 py-1 text-xs font-extrabold text-success-ink">
                      Sẵn sàng chơi · {book.available_rounds} câu phù hợp
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
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
          disabled={!selectedBook || isBusy || bookState.status !== "ready"}
          isLoading={isBusy}
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
