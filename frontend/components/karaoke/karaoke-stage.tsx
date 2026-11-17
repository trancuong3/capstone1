"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Music2,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  Star,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/common/button";
import { KaraokeScoreCard } from "@/components/karaoke/karaoke-score-card";
import { StatusMessage } from "@/components/common/status-message";
import { SyllableLyrics } from "@/components/karaoke/syllable-lyrics";
import { useKaraokeScoring } from "@/hooks/use-karaoke-scoring";
import type { KaraokePlayerController } from "@/hooks/use-karaoke-player";
import {
  activeLyricIndex,
  formatKaraokeTime,
} from "@/lib/karaoke/lyrics-timeline";
import type { KaraokePreview } from "@/types/karaoke";
import styles from "./karaoke-stage.module.css";

/** Child view shares the exact native audio/controller used by admin preview. */
export function KaraokeStage({
  source,
  player,
  childAlias,
  label,
  onReload,
}: {
  source: Omit<KaraokePreview, "revision">;
  player: KaraokePlayerController;
  childAlias: string;
  label: string;
  onReload?: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [practiceId, setPracticeId] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const scoring = useKaraokeScoring(source.lyrics);
  const lines = source.lyrics.lines;
  const activeIndex = activeLyricIndex(lines, player.currentMs);
  const activeLine = lines[activeIndex];
  const next = lines.find(
    (line) => line.start_ms !== null && line.start_ms > player.currentMs,
  );
  const practiceLine = lines.find((line) => line.id === practiceId);
  const recentIndex = lines.findLastIndex(
    (line) => line.start_ms !== null && line.start_ms <= player.currentMs,
  );
  const targetLine =
    practiceLine ?? activeLine ?? lines[Math.max(0, recentIndex)];
  const ended =
    countdown === null &&
    !practiceLine &&
    (player.ended || player.currentMs >= source.duration_ms) &&
    !player.playing;
  const secondsToNext =
    next?.start_ms === null || next?.start_ms === undefined
      ? null
      : Math.ceil((next.start_ms - player.currentMs) / 1000);

  useEffect(
    () => () => {
      generation.current++;
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    function changed() {
      setExpanded(document.fullscreenElement === root.current);
      if (!document.fullscreenElement) expandButton.current?.focus();
    }
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  function cancelPreparation() {
    generation.current++;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setCountdown(null);
  }
  function prepare(start: number, end?: number, loop = false) {
    cancelPreparation();
    player.pause();
    player.seek(start);
    const ticket = generation.current;
    setCountdown(3);
    function tick(value: number) {
      if (ticket !== generation.current) return;
      if (value === 0) {
        timer.current = null;
        setCountdown(null);
        setStarted(true);
        // Start scoring recognition when playback begins (non-practice only).
        if (!practiceId && scoring.enabled) scoring.startListening();
        void player.play(start, end, loop);
      } else {
        setCountdown(value);
        timer.current = setTimeout(() => tick(value - 1), 1000);
      }
    }
    timer.current = setTimeout(() => tick(2), 1000);
  }
  function restartSong() {
    scoring.reset();
    setPracticeId(null);
    setRepeat(false);
    prepare(0);
  }

  // Auto-score when song ends.
  const prevEndedRef = useRef(false);
  useEffect(() => {
    if (
      ended &&
      !prevEndedRef.current &&
      scoring.enabled &&
      scoring.listening
    ) {
      scoring.stopAndScore();
    }
    prevEndedRef.current = ended;
  }, [ended, scoring]);
  function togglePlay() {
    if (countdown !== null) {
      cancelPreparation();
      return;
    }
    if (player.playing) {
      player.pause();
      return;
    }
    if (ended) {
      restartSong();
      return;
    }
    if (!started && player.currentMs === 0) {
      prepare(0);
      return;
    }
    if (
      practiceLine?.start_ms !== null &&
      practiceLine?.start_ms !== undefined &&
      practiceLine.end_ms !== null
    ) {
      const current = player.getCurrentMs();
      void player.play(
        current >= practiceLine.start_ms && current < practiceLine.end_ms
          ? current
          : practiceLine.start_ms,
        practiceLine.end_ms,
        repeat,
        practiceLine.start_ms,
      );
    } else void player.play();
    setStarted(true);
  }
  function practice(line = targetLine) {
    if (!line || line.start_ms === null || line.end_ms === null) return;
    setPracticeId(line.id);
    prepare(line.start_ms, line.end_ms, repeat);
  }
  async function toggleExpanded() {
    if (document.fullscreenElement === root.current) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (root.current?.requestFullscreen) {
      try {
        await root.current.requestFullscreen();
        return;
      } catch {
        /* Inline enlarged view is available on unsupported devices. */
      }
    }
    if (!root.current) return;
    setExpanded(true);
    root.current.scrollIntoView?.({ block: "start" });
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === "Escape" && expanded && !document.fullscreenElement) {
      setExpanded(false);
      expandButton.current?.focus();
    }
    if (
      event.code !== "Space" ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target instanceof HTMLElement &&
        event.target.closest(
          "input,select,textarea,button,a,summary,[contenteditable=true]",
        ))
    )
      return;
    event.preventDefault();
    if (player.ready) togglePlay();
  }
  const status =
    countdown !== null
      ? `Chuẩn bị · ${countdown}`
      : player.waiting
        ? "Đang tải nhạc…"
        : activeLine
          ? player.playing
            ? "Câu đang hát"
            : "Câu để hát"
          : next
            ? secondsToNext !== null && secondsToNext <= 3
              ? `Vào lời sau ${secondsToNext} giây`
              : "Đoạn nhạc · Chuẩn bị câu tiếp theo"
            : "Cùng nghe đoạn nhạc cuối nhé";
  const displayed =
    countdown !== null ? (practiceLine ?? lines[0]) : activeLine;
  return (
    <section
      ref={root}
      tabIndex={0}
      aria-label={label}
      onKeyDown={keyboard}
      className={`${styles.stage} ${expanded ? styles.expanded : ""} grid gap-5 focus-visible:outline-3 focus-visible:outline-primary`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="grid size-12 shrink-0 place-items-center rounded-full bg-sky text-primary">
            <Music2 aria-hidden className="size-6" />
          </div>
          <div className="min-w-0">
            <p className="text-label font-bold text-primary">
              HÁT VUI CÙNG {childAlias}
            </p>
            <h1 className="break-words text-heading font-extrabold">
              {source.title}
            </h1>
          </div>
        </div>
        <div className="flex gap-2">
          {scoring.supported && (
            <button
              type="button"
              className={`inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-control px-4 py-3 font-bold focus-visible:outline-3 focus-visible:outline-primary sm:w-auto ${
                scoring.enabled
                  ? "bg-primary text-white"
                  : "bg-sky text-primary"
              }`}
              aria-pressed={scoring.enabled}
              onClick={scoring.toggle}
            >
              {scoring.enabled ? (
                <Mic aria-hidden className="size-5" />
              ) : (
                <MicOff aria-hidden className="size-5" />
              )}
              {scoring.enabled ? "Chấm điểm" : "Chấm điểm"}
            </button>
          )}
          <button
            ref={expandButton}
            type="button"
            className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-control bg-sky px-4 py-3 font-bold text-primary focus-visible:outline-3 focus-visible:outline-primary sm:w-auto"
            aria-pressed={expanded}
            onClick={() => void toggleExpanded()}
          >
            {expanded ? (
              <Minimize2 aria-hidden className="size-5" />
            ) : (
              <Maximize2 aria-hidden className="size-5" />
            )}
            {expanded ? "Thu gọn màn hát" : "Mở rộng màn hát"}
          </button>
        </div>
      </div>
      {ended ? (
        <div className={`${styles.lyrics} rounded-card bg-white/80`}>
          {scoring.score ? (
            <KaraokeScoreCard score={scoring.score} />
          ) : (
            <Star
              aria-hidden
              className="mx-auto size-16 fill-amber-100 text-amber-700"
            />
          )}
          <h2 className="text-heading font-extrabold">
            {childAlias} đã hát xong rồi!
          </h2>
          <p className="text-muted">
            {scoring.score
              ? `Bé hát đúng ${scoring.score.matchedWords}/${scoring.score.totalWords} từ. Giỏi lắm!`
              : "Cảm ơn bé đã mang tiếng hát đến hôm nay."}
          </p>
          <div className="flex flex-wrap justify-center gap-3 px-4">
            <Button
              className={`${styles.action} sm:w-auto`}
              onClick={restartSong}
            >
              <RotateCcw aria-hidden className="size-5" />
              Hát lại bài này
            </Button>
            <ButtonLink
              variant="secondary"
              className={`${styles.action} sm:w-auto`}
              href="/karaoke"
            >
              Chọn bài khác
            </ButtonLink>
          </div>
        </div>
      ) : (
        <>
          <div
            className={`${styles.lyrics} rounded-card bg-white/80 px-4`}
            aria-label="Lời bài hát"
          >
            <p
              role="status"
              className="flex items-center gap-2 font-bold text-primary"
              data-testid="karaoke-cue"
            >
              {scoring.listening && (
                <Mic
                  aria-label="Đang lắng nghe"
                  className="size-4 animate-pulse text-primary"
                />
              )}
              {status}
            </p>
            <p className={styles.line} data-testid="karaoke-active-line">
              {displayed ? (
                countdown !== null ? (
                  displayed.text
                ) : displayed.syllables?.length ? (
                  <SyllableLyrics
                    line={displayed}
                    currentMs={player.currentMs}
                  />
                ) : (
                  displayed.text
                )
              ) : (
                (next?.text ?? "Cùng nghe nhạc nhé!")
              )}
            </p>
            {activeLine && next && (
              <p className={styles.next}>Tiếp theo: {next.text}</p>
            )}
            <p className="text-sm text-muted">
              {practiceLine
                ? `Đang luyện câu ${lines.indexOf(practiceLine) + 1}`
                : activeLine
                  ? `Câu ${activeIndex + 1} / ${lines.length}`
                  : "Bé sẵn sàng hát cùng mình nhé"}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <Button
              className={`${styles.action} sm:min-w-56 sm:w-auto`}
              disabled={!player.ready}
              onClick={togglePlay}
            >
              {player.playing || countdown !== null ? (
                <Pause aria-hidden className="size-6" />
              ) : (
                <Play aria-hidden className="size-6" />
              )}
              {countdown !== null
                ? "Hủy chuẩn bị"
                : player.playing
                  ? "Tạm dừng"
                  : player.error
                    ? "Thử phát lại"
                    : !started && player.currentMs === 0
                      ? "Bắt đầu hát"
                      : "Hát tiếp"}
            </Button>
            <Button
              variant="secondary"
              className={`${styles.action} sm:w-auto`}
              disabled={!player.ready || !targetLine}
              onClick={() => practice()}
            >
              <RotateCcw aria-hidden className="size-5" />
              Hát lại câu này
            </Button>
            {practiceLine && (
              <Button
                variant="secondary"
                className={`${styles.action} sm:w-auto`}
                aria-pressed={repeat}
                onClick={() => {
                  cancelPreparation();
                  const enabled = !repeat;
                  setRepeat(enabled);
                  if (
                    player.playing &&
                    practiceLine.start_ms !== null &&
                    practiceLine.end_ms !== null
                  )
                    void player.play(
                      player.getCurrentMs(),
                      practiceLine.end_ms,
                      enabled,
                      practiceLine.start_ms,
                    );
                }}
              >
                <Repeat2 aria-hidden className="size-5" />
                {repeat ? "Đang lặp câu" : "Lặp câu"}
              </Button>
            )}
          </div>
        </>
      )}
      {player.error && (
        <StatusMessage tone="error" title="Nhạc đang gặp chút trục trặc">
          Ba mẹ giúp bé tải lại nhạc rồi thử lại nhé.
        </StatusMessage>
      )}
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <label htmlFor={`karaoke-position-${source.version_id}`}>
            Vị trí phát
          </label>
          <span className="tabular-nums">
            {formatKaraokeTime(player.currentMs)} /{" "}
            {formatKaraokeTime(source.duration_ms)}
          </span>
        </div>
        <input
          id={`karaoke-position-${source.version_id}`}
          aria-label="Vị trí phát"
          type="range"
          min={0}
          max={source.duration_ms}
          step={1}
          value={player.currentMs}
          disabled={!player.ready}
          onChange={(event) => {
            cancelPreparation();
            setPracticeId(null);
            setRepeat(false);
            player.seek(Number(event.target.value));
          }}
          className="min-h-12 w-full accent-primary"
        />
        <label className="flex flex-wrap items-center justify-center gap-3 font-bold">
          Tốc độ hát
          <select
            aria-label="Tốc độ hát"
            className="min-h-14 rounded-control border border-border bg-white px-4"
            value={player.rate}
            onChange={(event) => player.setRate(Number(event.target.value))}
          >
            <option value={0.75}>Chậm · 0.75×</option>
            <option value={1}>Bình thường · 1×</option>
          </select>
        </label>
      </div>
      <details className="min-w-0 rounded-control border border-border bg-white/70 p-4">
        <summary className="min-h-11 cursor-pointer content-center font-bold text-primary">
          Chọn câu để luyện
        </summary>
        <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto">
          {lines.map((line, i) => (
            <button
              type="button"
              key={line.id}
              disabled={!player.ready}
              aria-label={`Luyện câu ${i + 1}: ${line.text}`}
              aria-pressed={practiceId === line.id}
              className="min-h-14 rounded-control border border-border bg-white px-4 py-3 text-left break-words focus-visible:outline-3 focus-visible:outline-primary disabled:opacity-50"
              onClick={() => practice(line)}
            >
              <span className="mr-2 font-bold text-primary">{i + 1}.</span>
              {line.text}
            </button>
          ))}
        </div>
        {practiceLine && (
          <Button
            variant="secondary"
            className="mt-3 sm:w-auto"
            onClick={() => {
              cancelPreparation();
              player.pause();
              setPracticeId(null);
              setRepeat(false);
            }}
          >
            Trở về hát cả bài
          </Button>
        )}
      </details>
      <details className="min-w-0 rounded-control border border-border bg-white/70 p-4">
        <summary className="min-h-11 cursor-pointer content-center font-bold text-primary">
          Âm lượng và thông tin bài hát
        </summary>
        <div className="mt-3 grid min-w-0 gap-4">
          <label className="grid gap-2 font-bold">
            Âm lượng
            <input
              aria-label="Âm lượng"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={player.volume}
              onChange={(event) => player.setVolume(Number(event.target.value))}
              className="min-h-12 w-full accent-primary"
            />
          </label>
          {source.author && (
            <div className="min-w-0">
              <h2 className="font-bold">Thông tin bài hát</h2>
              <p className="mt-2 break-words text-sm text-muted">
                {source.author}
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              className="sm:w-auto"
              disabled={!player.ready}
              onClick={restartSong}
            >
              Hát lại từ đầu
            </Button>
            {onReload && (
              <Button
                variant="quiet"
                className="sm:w-auto"
                onClick={() => {
                  cancelPreparation();
                  player.pause();
                  onReload();
                }}
              >
                Tải lại nhạc
              </Button>
            )}
          </div>
          <p className="text-sm text-muted">
            {scoring.enabled
              ? "Bé hát theo lời trên màn hình. Trình duyệt đang lắng nghe để chấm điểm đúng lời. Phím cách để phát hoặc tạm dừng."
              : "Nhạc phát khi bé bấm nút. Bé hát vui cùng lời trên màn hình; không thu âm. Phím cách để phát hoặc tạm dừng khi vùng hát có focus."}
          </p>
        </div>
      </details>
      {player.error && onReload && (
        <Button
          variant="secondary"
          className="sm:w-auto"
          onClick={() => {
            cancelPreparation();
            player.pause();
            onReload();
          }}
        >
          Tải lại nhạc để thử lại
        </Button>
      )}
    </section>
  );
}
