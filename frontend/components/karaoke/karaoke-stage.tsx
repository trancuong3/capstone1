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
import { createCountdownSound } from "@/lib/karaoke/countdown-sound";
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
  const countdownSound = useRef<ReturnType<typeof createCountdownSound> | null>(
    null,
  );
  const generation = useRef(0);
  const preparingMic = useRef(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [practiceId, setPracticeId] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [scoredMode, setScoredMode] = useState(false);
  const [headphones, setHeadphones] = useState(false);
  const [practiceReturnMs, setPracticeReturnMs] = useState(0);
  const [manualEnded, setManualEnded] = useState(false);
  const lastPlaybackMs = useRef<number | null>(null);
  const scoring = useKaraokeScoring(source.lyrics, player.getCurrentMs);
  const {
    resume: resumeMic,
    pause: pauseMic,
    finish: finishMic,
    seekBoundary,
    observePlayback,
  } = scoring;
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
    (manualEnded ||
      ((player.ended || player.currentMs >= source.duration_ms) &&
        !player.playing));
  const secondsToNext =
    next?.start_ms === null || next?.start_ms === undefined
      ? null
      : Math.ceil((next.start_ms - player.currentMs) / 1000);

  useEffect(
    () => () => {
      generation.current++;
      if (timer.current !== null) clearTimeout(timer.current);
      countdownSound.current?.stop();
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
    countdownSound.current?.stop();
    countdownSound.current = null;
    setCountdown(null);
    if (preparingMic.current) {
      preparingMic.current = false;
      if (practiceId) scoring.endPractice();
      else scoring.reset();
    }
  }
  function prepare(
    start: number,
    end?: number,
    loop = false,
    requestMic = false,
    practiceLineId?: string,
  ) {
    cancelPreparation();
    player.pause();
    player.seek(start);
    const ticket = generation.current;
    countdownSound.current = createCountdownSound();
    function tick(value: number) {
      if (ticket !== generation.current) return;
      countdownSound.current?.play(value);
      if (value === 0) {
        preparingMic.current = false;
        timer.current = null;
        setCountdown(null);
        setStarted(true);
        void player.play(start, end, loop);
      } else {
        setCountdown(value);
        timer.current = setTimeout(() => tick(value - 1), 1000);
      }
    }
    if (requestMic) {
      // Permission must originate from the start/replay gesture, before counting in.
      preparingMic.current = true;
      void scoring.arm(practiceLineId).then((granted) => {
        if (ticket !== generation.current) return;
        if (granted) tick(3);
        else {
          preparingMic.current = false;
          countdownSound.current?.stop();
        }
      });
    } else tick(3);
  }
  function restartSong() {
    scoring.reset();
    setManualEnded(false);
    setPracticeId(null);
    setRepeat(false);
    setStarted(false);
    prepare(0, undefined, false, scoredMode);
  }
  function finishAndScoreSong() {
    cancelPreparation();
    player.pause();
    setManualEnded(true);
    finishMic();
  }

  // Native playback (including buffering) determines when sung words are eligible.
  useEffect(() => {
    if (!scoredMode) return;
    if (
      ((player.ended || manualEnded) && !practiceId) ||
      (practiceId && (player.segmentFinished || player.ended))
    )
      finishMic();
    else if (player.playing && !player.waiting && !player.error) resumeMic();
    else pauseMic();
  }, [
    scoredMode,
    practiceId,
    manualEnded,
    player.ended,
    player.segmentFinished,
    player.playing,
    player.waiting,
    player.error,
    finishMic,
    resumeMic,
    pauseMic,
  ]);
  useEffect(() => {
    if (
      !scoredMode ||
      !player.playing ||
      player.waiting ||
      Boolean(player.error) ||
      countdown !== null ||
      !["listening", "armed"].includes(scoring.status)
    ) {
      lastPlaybackMs.current = null;
      return;
    }
    const current = player.currentMs;
    const previous = lastPlaybackMs.current;
    lastPlaybackMs.current = current;
    if (previous !== null && current > previous && current - previous <= 650) {
      observePlayback(previous, current);
    }
  }, [
    scoredMode,
    player.playing,
    player.waiting,
    player.error,
    player.currentMs,
    countdown,
    scoring.status,
    observePlayback,
  ]);
  const previousPass = useRef(player.loopPass);
  useEffect(() => {
    if (previousPass.current !== player.loopPass && practiceId)
      seekBoundary(true);
    previousPass.current = player.loopPass;
  }, [practiceId, player.loopPass, seekBoundary]);
  const { setMuted } = player;
  useEffect(() => {
    if (!scoredMode || !headphones) return;
    const devices = navigator.mediaDevices;
    function recheckOutput() {
      setMuted(true);
      setHeadphones(false);
    }
    devices?.addEventListener?.("devicechange", recheckOutput);
    return () => devices?.removeEventListener?.("devicechange", recheckOutput);
  }, [scoredMode, headphones, setMuted]);

  function selectMode(scored: boolean) {
    if (scored === scoredMode) return;
    cancelPreparation();
    player.pause();
    scoring.reset();
    setManualEnded(false);
    setStarted(false);
    setHeadphones(false);
    player.setMuted(scored);
    setScoredMode(scored);
  }
  function togglePlay() {
    if (countdown !== null || scoring.status === "arming") {
      cancelPreparation();
      if (practiceId && scoredMode) leavePractice();
      return;
    }
    if (player.playing) {
      pauseMic();
      player.pause();
      return;
    }
    if (ended) {
      restartSong();
      return;
    }
    if (
      !practiceLine &&
      (!started ||
        (scoredMode &&
          ["idle", "scored", "insufficient"].includes(scoring.status)))
    ) {
      prepare(player.getCurrentMs(), undefined, false, scoredMode);
      return;
    }
    if (
      practiceLine?.start_ms !== null &&
      practiceLine?.start_ms !== undefined &&
      practiceLine.end_ms !== null
    ) {
      if (
        scoredMode &&
        ["idle", "scored", "insufficient", "unavailable"].includes(
          scoring.status,
        )
      ) {
        practice(practiceLine);
        return;
      }
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
    if (
      !line ||
      line.start_ms === null ||
      line.end_ms === null ||
      scoring.status === "finishing"
    )
      return;
    if (!practiceId)
      setPracticeReturnMs(ended ? source.duration_ms : player.getCurrentMs());
    setManualEnded(false);
    pauseMic();
    setPracticeId(line.id);
    prepare(line.start_ms, line.end_ms, repeat, scoredMode, line.id);
  }
  function leavePractice() {
    cancelPreparation();
    player.pause();
    scoring.endPractice();
    player.seek(practiceReturnMs);
    setPracticeId(null);
    setRepeat(false);
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
    countdown !== null || scoring.status === "arming"
      ? "Chuẩn bị"
      : player.waiting
        ? "Đang tải nhạc…"
        : !started && !practiceLine && player.currentMs === 0
          ? "Bấm Bắt đầu hát"
          : activeLine
            ? player.playing
              ? "Câu đang hát"
              : "Câu để hát"
            : !player.playing
              ? "Bấm Hát tiếp"
              : next
                ? secondsToNext !== null && secondsToNext <= 3
                  ? `Vào lời sau ${secondsToNext} giây`
                  : "Đoạn nhạc · Chuẩn bị câu tiếp theo"
                : "Cùng nghe đoạn nhạc cuối nhé";
  const finalScore =
    scoring.score ??
    (scoring.status === "insufficient" ? scoring.liveScore : null);
  const liveWords = scoring.liveScore?.lineScores.flatMap((l) => l.words) ?? [];
  const liveMatched = liveWords.filter((w) => w.state === "matched").length;
  const liveWrong = liveWords.filter((w) => w.state === "different").length;
  const liveOmitted = liveWords.filter((w) => w.state === "omitted").length;
  const pendingWords = liveWords.filter(
    (w) =>
      w.state === "unknown" &&
      (w.phase === "processing" || scoring.previewWords.has(w.id)),
  ).length;
  const liveEvaluated = liveMatched + liveWrong + liveOmitted;
  const livePercent =
    liveEvaluated > 0 ? Math.round((100 * liveMatched) / liveEvaluated) : null;
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
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
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
      <div
        role="group"
        aria-label="Chế độ hát"
        className="flex flex-wrap gap-2"
      >
        <Button
          className="sm:w-auto"
          variant={scoredMode ? "secondary" : "primary"}
          aria-pressed={!scoredMode}
          onClick={() => selectMode(false)}
        >
          <MicOff aria-hidden className="size-5" />
          Hát tự do
        </Button>
        <Button
          className="sm:w-auto"
          variant={scoredMode ? "primary" : "secondary"}
          aria-pressed={scoredMode}
          disabled={!scoring.supported}
          onClick={() => selectMode(true)}
        >
          <Mic aria-hidden className="size-5" />
          Hát có chấm điểm
        </Button>
      </div>
      {scoredMode && (
        <label className="flex min-h-12 items-center gap-3 rounded-control bg-sky p-3">
          <input
            type="checkbox"
            checked={headphones}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              player.setMuted(!checked);
              setHeadphones(checked);
            }}
          />
          <span>
            Mình đang đeo tai nghe · Bật nhạc đệm
            <small className="block">
              Khi dùng loa, bé hát theo lời chạy để micro chỉ nghe tiếng của bé.
            </small>
          </span>
        </label>
      )}
      {!scoring.supported ? (
        <p className="text-sm text-muted">
          Trình duyệt này hỗ trợ hát tự do. Để chấm điểm, ba mẹ hãy mở bằng
          trình duyệt có nhận dạng giọng nói.
        </p>
      ) : scoring.error ? (
        <StatusMessage tone="warning">{scoring.error}</StatusMessage>
      ) : scoredMode && !started && countdown === null ? (
        <p role="status" className="text-sm text-muted">
          {scoring.status === "arming"
            ? "Đang chờ quyền micro. Ba mẹ giúp bé chọn Cho phép nhé."
            : "Khi bé bắt đầu hát, hãy cho phép dùng micro. Trình duyệt có thể gửi âm thanh đến dịch vụ nhận dạng giọng nói."}
        </p>
      ) : null}
      {ended ? (
        <div className={`${styles.lyrics} rounded-card bg-white/80`}>
          {finalScore ? (
            <KaraokeScoreCard
              score={finalScore}
              onPractice={(id) =>
                practice(lines.find((line) => line.id === id))
              }
            />
          ) : (
            <Star
              aria-hidden
              className="mx-auto size-16 fill-amber-100 text-amber-700"
            />
          )}
          <h2 className="text-heading font-extrabold">
            {childAlias} đã hát xong rồi!
          </h2>
          {!finalScore && (
            <p role="status" className="text-muted">
              {scoring.status === "finishing"
                ? "Đang nghe nốt câu cuối…"
                : "Cảm ơn bé đã mang tiếng hát đến hôm nay."}
            </p>
          )}
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
              className={
                countdown === null
                  ? "flex items-center gap-2 font-bold text-primary"
                  : styles.countIn
              }
              data-testid="karaoke-cue"
            >
              {scoring.listening && (
                <Mic
                  aria-label="Đang lắng nghe"
                  className="size-4 animate-pulse text-primary"
                />
              )}
              {status}
              {countdown !== null && (
                <span
                  className={styles.countdown}
                  data-testid="karaoke-countdown"
                >
                  {countdown}
                </span>
              )}
            </p>
            {countdown === null && (
              <>
                <p className={styles.line} data-testid="karaoke-active-line">
                  {activeLine ? (
                    <SyllableLyrics
                      line={activeLine}
                      currentMs={player.currentMs}
                      highlightActive
                      evidence={
                        scoredMode
                          ? scoring.liveScore?.lineScores.find(
                              (l) => l.lineId === activeLine.id,
                            )
                          : undefined
                      }
                      previewWords={
                        scoredMode ? scoring.previewWords : undefined
                      }
                    />
                  ) : (
                    (next?.text ?? "Cùng nghe nhạc nhé!")
                  )}
                </p>
                {scoredMode && (
                  <div
                    data-testid="karaoke-live-feedback"
                    className="mx-auto flex flex-wrap items-center justify-center gap-2 text-xs font-bold sm:text-sm"
                  >
                    <span className="rounded-full border border-green-500 bg-green-100 px-3 py-1 text-green-900">
                      Đúng: {liveMatched}
                    </span>
                    <span className="rounded-full border border-red-500 bg-red-100 px-3 py-1 text-red-900">
                      Chưa đúng: {liveWrong}
                    </span>
                    <span className="rounded-full border border-orange-400 bg-orange-100 px-3 py-1 text-orange-900">
                      Bỏ qua: {liveOmitted}
                    </span>
                    {pendingWords > 0 && (
                      <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-slate-700">
                        Đang xử lý: {pendingWords}
                      </span>
                    )}
                    {livePercent !== null && (
                      <span className="rounded-full border border-primary bg-sky px-3 py-1 text-primary">
                        Tỉ lệ đúng: {livePercent}%
                      </span>
                    )}
                  </div>
                )}
                {scoredMode && scoring.listening && (
                  <p className="text-xs text-muted">
                    {scoring.signal === "uncertain" &&
                    liveEvaluated === 0 &&
                    pendingWords === 0
                      ? "Mình chưa nghe rõ. Bé đưa micro gần hơn một chút nhé."
                      : "Nét chấm: đang nghe và đối chiếu, chưa tính điểm."}
                  </p>
                )}
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
              </>
            )}
          </div>
          {practiceLine && scoring.status === "finishing" && (
            <p role="status">Đang nghe nốt câu cuối…</p>
          )}
          {practiceLine && scoring.score && (
            <KaraokeScoreCard score={scoring.score} practice />
          )}
          {practiceLine && scoring.status === "insufficient" && (
            <p role="status">Mình chưa nghe rõ. Bé thử lại nhé!</p>
          )}
          {practiceLine && scoredMode && (
            <Button variant="quiet" onClick={leavePractice}>
              {scoring.songScore || practiceReturnMs >= source.duration_ms
                ? "Về kết quả bài hát"
                : "Về lượt hát cả bài"}
            </Button>
          )}
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
              {countdown !== null || scoring.status === "arming"
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
            {scoredMode && started && !practiceLine && countdown === null && (
              <Button
                variant="secondary"
                className={`${styles.action} sm:w-auto`}
                onClick={finishAndScoreSong}
              >
                <Star aria-hidden className="size-5" />
                Kết thúc & chấm điểm
              </Button>
            )}
            {practiceLine && (
              <Button
                variant="secondary"
                className={`${styles.action} sm:w-auto`}
                aria-pressed={repeat}
                disabled={
                  scoredMode &&
                  (countdown !== null ||
                    scoring.status === "arming" ||
                    scoring.status === "finishing")
                }
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
            if (practiceId && scoredMode) {
              player.pause();
              scoring.endPractice();
            }
            setManualEnded(false);
            setPracticeId(null);
            setRepeat(false);
            player.seek(Number(event.target.value));
            scoring.seekBoundary();
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
            onClick={leavePractice}
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
            {scoredMode
              ? "Phím cách để phát hoặc tạm dừng bài hát."
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
