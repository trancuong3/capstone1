"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Drum,
  Headphones,
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
  Volume2,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/common/button";
import { KaraokeScoreCard } from "@/components/karaoke/karaoke-score-card";
import { PitchHighwayCanvas } from "@/components/karaoke/pitch-highway-canvas";
import { StatusMessage } from "@/components/common/status-message";
import { SyllableLyrics } from "@/components/karaoke/syllable-lyrics";
import { useEntertainmentPreferences } from "@/hooks/use-entertainment-preferences";
import { useTranslations } from "@/hooks/use-i18n";
import { useKaraokeScoring } from "@/hooks/use-karaoke-scoring";
import type { KaraokePlayerController } from "@/hooks/use-karaoke-player";
import {
  activeLyricIndex,
  formatKaraokeTime,
} from "@/lib/karaoke/lyrics-timeline";
import {
  DEFAULT_MIC_LATENCY_MS,
  MIC_LATENCY_MAX_MS,
  MIC_LATENCY_MIN_MS,
} from "@/lib/karaoke/musical-dsp";
import {
  evaluateMusicalPerformance,
  type KaraokePracticeMode,
  type MusicalEvaluationResult,
  type MusicalProfileData,
  type MusicalSegmentReport,
} from "@/lib/karaoke/musical-scoring";
import {
  buildSegmentSelection,
  mergeBestFullSongScore,
  PRACTICE_MODES,
  resolveMusicalProfile,
  RhythmTapTracker,
  SEGMENT_PRACTICE_DEFAULT_RATE,
  type RhythmTapFeedback,
} from "@/lib/karaoke/musical-practice";
import { resolveTargetNotes } from "@/lib/karaoke/pro-karaoke-scoring";
import type { KaraokeLine, KaraokePreview } from "@/types/karaoke";
import { createCountdownSound } from "@/lib/karaoke/countdown-sound";
import styles from "./karaoke-stage.module.css";

const MIC_LATENCY_STORAGE_KEY = "viread.karaoke-mic-latency.v1";

function readStoredMicLatencyMs(): number {
  if (typeof window === "undefined") return DEFAULT_MIC_LATENCY_MS;
  try {
    const raw = window.localStorage.getItem(MIC_LATENCY_STORAGE_KEY);
    if (!raw) return DEFAULT_MIC_LATENCY_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_MIC_LATENCY_MS;
    return Math.max(
      MIC_LATENCY_MIN_MS,
      Math.min(MIC_LATENCY_MAX_MS, Math.round(parsed)),
    );
  } catch {
    return DEFAULT_MIC_LATENCY_MS;
  }
}

export interface KaraokePracticeHistorySummary {
  bestFullSongScore: number | null;
  bestFullSongStars: number;
  totalSessions: number;
}

const LyricPickerList = memo(function LyricPickerList({
  lines,
  ready,
  practiceId,
  onSelectLine,
}: {
  lines: KaraokeLine[];
  ready: boolean;
  practiceId: string | null;
  onSelectLine: (line: KaraokeLine) => void;
}) {
  const t = useTranslations("entertainment");
  return (
    <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto">
      {lines.map((line, i) => (
        <button
          type="button"
          key={line.id}
          disabled={!ready}
          aria-label={t("karaoke.stage.pickLineAria", {
            number: i + 1,
            text: line.text,
          })}
          aria-pressed={practiceId === line.id}
          className="min-h-14 rounded-control border border-border bg-white px-4 py-3 text-start break-words focus-visible:outline-3 focus-visible:outline-primary disabled:opacity-50"
          onClick={() => onSelectLine(line)}
        >
          <span className="me-2 font-bold text-primary">{i + 1}.</span>
          <span className="viread-learning-content" dir="ltr" lang="vi">
            {line.text}
          </span>
        </button>
      ))}
    </div>
  );
});

const MusicalSummaryPanel = memo(function MusicalSummaryPanel({
  evaluation,
  bestFullSongScore,
  onPracticeSegment,
}: {
  evaluation: MusicalEvaluationResult;
  bestFullSongScore: number | null;
  onPracticeSegment: (segment: MusicalSegmentReport) => void;
}) {
  const t = useTranslations("entertainment");
  const isInsufficient = evaluation.scoringMode === "INSUFFICIENT_EVIDENCE";
  const formatSubScore = (value: number | null) =>
    value === null
      ? t("karaoke.stage.musicalSummary.unmeasured")
      : t("karaoke.stage.musicalSummary.points", { score: value });
  const statusBadge = (status: MusicalSegmentReport["status"]) => {
    if (status === "GREAT")
      return "border-green-400 bg-green-100 text-green-900";
    if (status === "GOOD")
      return "border-amber-400 bg-amber-100 text-amber-900";
    return "border-orange-400 bg-orange-100 text-orange-900";
  };
  const statusLabel = (status: MusicalSegmentReport["status"]) => {
    if (status === "GREAT")
      return t("karaoke.stage.musicalSummary.statusGreat");
    if (status === "GOOD") return t("karaoke.stage.musicalSummary.statusGood");
    return t("karaoke.stage.musicalSummary.statusPractice");
  };

  return (
    <section
      aria-label={t("karaoke.stage.musicalSummary.ariaLabel")}
      data-testid="karaoke-musical-summary"
      className="mx-auto grid w-full max-w-2xl gap-4 rounded-card border border-border bg-white p-5 text-start shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid="karaoke-scoring-mode-badge"
          className="rounded-full border border-primary/30 bg-sky px-3 py-1 text-xs font-extrabold text-primary"
        >
          {evaluation.scoringModeLabelVi}
        </span>
        {bestFullSongScore !== null && (
          <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-900">
            {t("karaoke.stage.musicalSummary.bestFullSong", {
              score: bestFullSongScore,
            })}
          </span>
        )}
      </div>

      {!isInsufficient ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-control border border-border bg-sky/40 p-3 text-center">
              <span className="block text-xs font-bold text-muted">
                {t("karaoke.stage.musicalSummary.rhythmLabel")}
              </span>
              <span className="text-lg font-extrabold text-primary">
                {formatSubScore(evaluation.rhythmScore)}
              </span>
            </div>
            <div className="rounded-control border border-border bg-sky/40 p-3 text-center">
              <span className="block text-xs font-bold text-muted">
                {t("karaoke.stage.musicalSummary.pitchLabel")}
              </span>
              <span className="text-lg font-extrabold text-primary">
                {formatSubScore(evaluation.pitchScore)}
              </span>
            </div>
            <div className="rounded-control border border-border bg-sky/40 p-3 text-center">
              <span className="block text-xs font-bold text-muted">
                {t("karaoke.stage.musicalSummary.lyricsLabel")}
              </span>
              <span className="text-lg font-extrabold text-primary">
                {formatSubScore(evaluation.lyricsScore)}
              </span>
            </div>
            <div className="rounded-control border border-border bg-sky/40 p-3 text-center">
              <span className="block text-xs font-bold text-muted">
                {t("karaoke.stage.musicalSummary.fluencyLabel")}
              </span>
              <span className="text-lg font-extrabold text-primary">
                {formatSubScore(evaluation.fluencyScore)}
              </span>
            </div>
          </div>

          <p className="text-xs text-muted">
            {t("karaoke.stage.musicalSummary.pitchBasisPrefix")}{" "}
            <strong>{evaluation.pitchBasisLabelVi}</strong>
            {evaluation.speakerBleedSuspected
              ? ` · ${t("karaoke.stage.musicalSummary.speakerBleedNote")}`
              : ""}
          </p>
        </>
      ) : (
        <p className="text-sm font-semibold text-amber-900">
          {t("karaoke.stage.musicalSummary.insufficientHint")}
        </p>
      )}

      {evaluation.weakestSegment && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-orange-300 bg-orange-50 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-extrabold text-orange-900">
              {t("karaoke.stage.musicalSummary.weakestSegmentTitle", {
                number: evaluation.weakestSegment.lineIndex + 1,
              })}
            </p>
            <p
              className="viread-learning-content truncate text-sm font-bold text-slate-900"
              dir="ltr"
              lang="vi"
            >
              {evaluation.weakestSegment.text}
            </p>
            <p className="text-xs text-orange-900">
              {evaluation.weakestSegment.tipVi}
            </p>
          </div>
          <Button
            variant="secondary"
            className="sm:w-auto"
            onClick={() => onPracticeSegment(evaluation.weakestSegment!)}
          >
            {t("karaoke.stage.musicalSummary.retrySegmentSlow")}
          </Button>
        </div>
      )}

      {evaluation.segments.length > 0 && !isInsufficient && (
        <details className="rounded-control border border-border bg-slate-50/70 p-3">
          <summary className="cursor-pointer text-sm font-bold text-primary">
            {t("karaoke.stage.musicalSummary.segmentReportSummary", {
              count: evaluation.segments.length,
            })}
          </summary>
          <ol className="mt-3 grid max-h-64 gap-2 overflow-y-auto">
            {evaluation.segments.map((seg) => (
              <li
                key={seg.lineId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border bg-white p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-extrabold text-primary">
                      {t("karaoke.stage.musicalSummary.segmentLineHeader", {
                        number: seg.lineIndex + 1,
                        start: formatKaraokeTime(seg.startMs),
                        end: formatKaraokeTime(seg.endMs),
                      })}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusBadge(seg.status)}`}
                    >
                      {statusLabel(seg.status)}
                    </span>
                  </div>
                  <p
                    className="viread-learning-content text-sm font-semibold"
                    dir="ltr"
                    lang="vi"
                  >
                    {seg.text}
                  </p>
                  <p className="text-xs text-muted">{seg.tipVi}</p>
                </div>
                {seg.status === "PRACTICE" && (
                  <button
                    type="button"
                    className="min-h-10 rounded-control border border-primary bg-sky px-3 py-1.5 text-xs font-bold text-primary"
                    onClick={() => onPracticeSegment(seg)}
                  >
                    {t("karaoke.stage.musicalSummary.retrySegmentSlow")}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
});

/** Child view shares the exact native audio/controller used by admin preview. */
export function KaraokeStage({
  source,
  player,
  childAlias,
  label,
  onReload,
  onLoadMusicalProfile,
  onLoadPracticeHistory,
  onSavePracticeSession,
}: {
  source: Omit<KaraokePreview, "revision">;
  player: KaraokePlayerController;
  childAlias: string;
  label: string;
  onReload?: () => void;
  onLoadMusicalProfile?: () => Promise<MusicalProfileData | null>;
  onLoadPracticeHistory?: () => Promise<KaraokePracticeHistorySummary | null>;
  onSavePracticeSession?: (
    evaluation: MusicalEvaluationResult,
    meta: {
      playbackRate: number;
      headphoneMode: boolean;
      segmentStartMs: number | null;
      segmentEndMs: number | null;
    },
  ) => Promise<void>;
}) {
  // Stabilize lyric & song references even if parent wrapper clones `source` per frame.
  const lyrics = source.lyrics;
  const t = useTranslations("entertainment");
  const { reducedMotion, calmSound } = useEntertainmentPreferences();
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
  const [practiceMode, setPracticeMode] =
    useState<KaraokePracticeMode>("FULL_SONG");
  const [repeat, setRepeat] = useState(false);
  const [scoredMode, setScoredMode] = useState(false);
  const [headphones, setHeadphones] = useState(false);
  const [speakerBacking, setSpeakerBacking] = useState(false);
  const [practiceReturnMs, setPracticeReturnMs] = useState(0);
  const [manualEnded, setManualEnded] = useState(false);
  const [remoteProfile, setRemoteProfile] = useState<MusicalProfileData | null>(
    null,
  );
  const [bestFullSongScore, setBestFullSongScore] = useState<number | null>(
    null,
  );
  const [rhythmTapFeedback, setRhythmTapFeedback] =
    useState<RhythmTapFeedback | null>(null);
  const [rhythmTapResult, setRhythmTapResult] =
    useState<MusicalEvaluationResult | null>(null);
  const [micLatencyMs, setMicLatencyMsState] = useState<number>(() =>
    readStoredMicLatencyMs(),
  );
  const setMicLatencyMs = useCallback((value: number) => {
    const clamped = Math.max(
      MIC_LATENCY_MIN_MS,
      Math.min(MIC_LATENCY_MAX_MS, Math.round(value)),
    );
    setMicLatencyMsState(clamped);
    try {
      window.localStorage.setItem(MIC_LATENCY_STORAGE_KEY, String(clamped));
    } catch {
      /* Ignore blocked storage. */
    }
  }, []);

  const profileLoadedRef = useRef(false);
  const lastSavedScoreRef = useRef<MusicalEvaluationResult | null>(null);
  const lastPlaybackMs = useRef<number | null>(null);
  const playheadBarRef = useRef<HTMLDivElement | null>(null);

  const effectiveMelodyProfile =
    source.melody_profile ?? remoteProfile?.melodyProfile ?? null;

  const resolvedProfile = useMemo(() => {
    const base = resolveMusicalProfile(lyrics, remoteProfile);
    if (
      effectiveMelodyProfile &&
      !base.hasPitchContour &&
      effectiveMelodyProfile.pitch_contour?.length
    ) {
      return {
        ...base,
        bpm: effectiveMelodyProfile.bpm ?? base.bpm,
        hasPitchContour: true,
        sourceMethod: "AUDIO_DSP" as const,
        pitchContour: effectiveMelodyProfile.pitch_contour.map((pt) => ({
          timeMs: pt.time_ms,
          hz: pt.hz,
          midi: pt.midi,
        })),
        melodyProfile: effectiveMelodyProfile,
      };
    }
    return {
      ...base,
      melodyProfile: effectiveMelodyProfile,
    };
  }, [lyrics, remoteProfile, effectiveMelodyProfile]);

  const targetNotes = useMemo(
    () => resolveTargetNotes(effectiveMelodyProfile, resolvedProfile, lyrics),
    [effectiveMelodyProfile, resolvedProfile, lyrics],
  );
  const phraseStartsMs = useMemo(
    () =>
      lyrics.lines
        .map((line) => line.start_ms)
        .filter((t): t is number => t !== null && Number.isFinite(t)),
    [lyrics.lines],
  );
  const tapTrackerRef = useRef<RhythmTapTracker>(
    new RhythmTapTracker(resolvedProfile.beatGridMs),
  );
  useEffect(() => {
    tapTrackerRef.current = new RhythmTapTracker(resolvedProfile.beatGridMs);
  }, [resolvedProfile]);

  const lines = lyrics.lines;
  const practiceLine = useMemo(
    () => lines.find((line) => line.id === practiceId) ?? null,
    [lines, practiceId],
  );
  const segmentRange = useMemo(
    () =>
      practiceLine &&
      practiceLine.start_ms !== null &&
      practiceLine.end_ms !== null
        ? { startMs: practiceLine.start_ms, endMs: practiceLine.end_ms }
        : null,
    [practiceLine],
  );

  const scoring = useKaraokeScoring(lyrics, player.getCurrentMs, {
    headphoneMode: headphones,
    practiceMode,
    musicalProfile: resolvedProfile,
    melodyProfile: effectiveMelodyProfile,
    keyShift: player.keyShift,
    playbackRate: player.rate,
    micLatencyMs,
    segmentRange,
  });
  const {
    resume: resumeMic,
    pause: pauseMic,
    finish: finishMic,
    seekBoundary,
    observePlayback,
  } = scoring;

  // Ref-driven 60fps progress bar update with zero React re-renders.
  const { subscribeClock } = player;
  useEffect(() => {
    if (!subscribeClock) return;
    return subscribeClock((ms) => {
      const bar = playheadBarRef.current;
      if (!bar || source.duration_ms <= 0) return;
      const pct = Math.max(0, Math.min(100, (ms / source.duration_ms) * 100));
      bar.style.width = `${pct}%`;
    });
  }, [subscribeClock, source.duration_ms]);

  // Lazily fetch musical profile & practice history only when entering scored/rhythm-tap modes.
  const ensureMusicalMetadataLoaded = useCallback(() => {
    if (profileLoadedRef.current) return;
    profileLoadedRef.current = true;
    if (onLoadMusicalProfile) {
      void onLoadMusicalProfile()
        .then((prof) => {
          if (prof) setRemoteProfile(prof);
        })
        .catch(() => {});
    }
    if (onLoadPracticeHistory) {
      void onLoadPracticeHistory()
        .then((hist) => {
          if (hist && hist.bestFullSongScore !== null) {
            setBestFullSongScore((prev) =>
              prev === null
                ? hist.bestFullSongScore
                : Math.max(prev, hist.bestFullSongScore!),
            );
          }
        })
        .catch(() => {});
    }
  }, [onLoadMusicalProfile, onLoadPracticeHistory]);

  const activeIndex = activeLyricIndex(lines, player.currentMs);
  const activeLine = lines[activeIndex];
  const next = lines.find(
    (line) => line.start_ms !== null && line.start_ms > player.currentMs,
  );
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

  // Persist compact musical evaluation when a scored or Rhythm Tap session finishes.
  const completedMusicalEval =
    practiceMode === "RHYTHM_TAP"
      ? rhythmTapResult
      : scoring.status === "scored" || scoring.status === "insufficient"
        ? scoring.musicalScore
        : null;

  useEffect(() => {
    if (!completedMusicalEval) return;
    if (lastSavedScoreRef.current === completedMusicalEval) return;
    lastSavedScoreRef.current = completedMusicalEval;
    setBestFullSongScore((prev) =>
      mergeBestFullSongScore(prev, completedMusicalEval),
    );
    if (onSavePracticeSession) {
      void onSavePracticeSession(completedMusicalEval, {
        playbackRate: player.rate,
        headphoneMode: headphones,
        segmentStartMs: segmentRange?.startMs ?? null,
        segmentEndMs: segmentRange?.endMs ?? null,
      }).catch(() => {});
    }
  }, [
    completedMusicalEval,
    headphones,
    onSavePracticeSession,
    player.rate,
    segmentRange?.endMs,
    segmentRange?.startMs,
  ]);

  // Finalize Rhythm Tap score automatically when playback reaches the end.
  useEffect(() => {
    if (practiceMode !== "RHYTHM_TAP" || !ended || rhythmTapResult !== null) {
      return;
    }
    const evaluated = evaluateMusicalPerformance({
      lyrics,
      referenceProfile: resolvedProfile,
      rhythmTapsMs: tapTrackerRef.current.getTaps(),
      practiceMode: "RHYTHM_TAP",
      headphoneMode: headphones,
    });
    setRhythmTapResult(evaluated);
  }, [
    ended,
    headphones,
    lyrics,
    practiceMode,
    resolvedProfile,
    rhythmTapResult,
  ]);

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
      if (calmSound) countdownSound.current?.play(value);
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
    tapTrackerRef.current.reset();
    setRhythmTapFeedback(null);
    setRhythmTapResult(null);
    setManualEnded(false);
    setPracticeId(null);
    setRepeat(false);
    setStarted(false);
    const useMic = scoredMode && practiceMode !== "RHYTHM_TAP";
    prepare(0, undefined, false, useMic);
  }
  function finishAndScoreSong() {
    cancelPreparation();
    player.pause();
    setManualEnded(true);
    if (practiceMode === "RHYTHM_TAP") {
      setRhythmTapResult(
        evaluateMusicalPerformance({
          lyrics,
          referenceProfile: resolvedProfile,
          rhythmTapsMs: tapTrackerRef.current.getTaps(),
          practiceMode: "RHYTHM_TAP",
          headphoneMode: headphones,
        }),
      );
      return;
    }
    finishMic();
  }

  // Native playback (including buffering) determines when sung words are eligible.
  useEffect(() => {
    if (!scoredMode || practiceMode === "RHYTHM_TAP") return;
    if (
      ((player.ended || manualEnded) && !practiceId) ||
      (practiceId && (player.segmentFinished || player.ended))
    )
      finishMic();
    else if (player.playing && !player.waiting && !player.error) resumeMic();
    else pauseMic();
  }, [
    scoredMode,
    practiceMode,
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
      practiceMode === "RHYTHM_TAP" ||
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
    practiceMode,
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
    setSpeakerBacking(false);
    setRhythmTapResult(null);
    if (scored) {
      ensureMusicalMetadataLoaded();
      if (practiceMode === "RHYTHM_TAP") setPracticeMode("FULL_SONG");
    }
    player.setMuted(scored);
    setScoredMode(scored);
  }

  function selectPracticeMode(nextMode: KaraokePracticeMode) {
    if (nextMode === practiceMode) return;
    cancelPreparation();
    player.pause();
    setManualEnded(false);
    setRhythmTapResult(null);
    setRhythmTapFeedback(null);
    tapTrackerRef.current.reset();
    ensureMusicalMetadataLoaded();

    if (nextMode === "RHYTHM_TAP") {
      scoring.reset();
      setPracticeId(null);
      setRepeat(false);
      setPracticeMode("RHYTHM_TAP");
      player.setMuted(false);
      return;
    }

    setPracticeMode(nextMode);
    if (nextMode === "FULL_SONG") {
      if (practiceId) {
        scoring.endPractice();
        setPracticeId(null);
      }
      setRepeat(false);
      player.setRate(1);
    } else if (nextMode === "SEGMENT" && targetLine) {
      const idx = Math.max(0, lines.indexOf(targetLine));
      const selection = buildSegmentSelection({
        lineIndex: idx,
        lineId: targetLine.id,
        startMs: targetLine.start_ms ?? 0,
        endMs: targetLine.end_ms ?? source.duration_ms,
        text: targetLine.text,
      });
      player.setRate(selection.playbackRate);
      setRepeat(selection.loop);
      setPracticeId(targetLine.id);
    }
  }

  function handleRhythmTap() {
    if (!player.playing) return;
    const feedback = tapTrackerRef.current.recordTap(player.getCurrentMs());
    if (feedback) setRhythmTapFeedback(feedback);
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
    const useMic = scoredMode && practiceMode !== "RHYTHM_TAP";
    if (
      !practiceLine &&
      (!started ||
        (useMic && ["idle", "scored", "insufficient"].includes(scoring.status)))
    ) {
      prepare(player.getCurrentMs(), undefined, false, useMic);
      return;
    }
    if (
      practiceLine?.start_ms !== null &&
      practiceLine?.start_ms !== undefined &&
      practiceLine.end_ms !== null
    ) {
      if (
        useMic &&
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

  const practice = useCallback(
    (
      line: KaraokeLine | undefined = targetLine,
      options?: {
        mode?: "SEGMENT" | "LINE_PRACTICE";
        rate?: number;
        loop?: boolean;
      },
    ) => {
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
      const nextMode = options?.mode ?? "LINE_PRACTICE";
      const nextLoop = options?.loop ?? repeat;
      if (options?.rate) player.setRate(options.rate);
      if (options?.loop !== undefined) setRepeat(options.loop);
      setPracticeMode(nextMode);
      setPracticeId(line.id);
      prepare(
        line.start_ms,
        line.end_ms,
        nextLoop,
        scoredMode && nextMode !== ("RHYTHM_TAP" as string),
        line.id,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      targetLine,
      scoring.status,
      practiceId,
      ended,
      source.duration_ms,
      player,
      pauseMic,
      repeat,
      scoredMode,
    ],
  );

  function practiceSegmentSlow(segment: MusicalSegmentReport) {
    const line = lines.find((item) => item.id === segment.lineId);
    if (!line) return;
    practice(line, {
      mode: "SEGMENT",
      rate: SEGMENT_PRACTICE_DEFAULT_RATE,
      loop: true,
    });
  }

  function leavePractice() {
    cancelPreparation();
    player.pause();
    scoring.endPractice();
    player.seek(practiceReturnMs);
    player.setRate(1);
    setPracticeId(null);
    setPracticeMode("FULL_SONG");
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
    if (practiceMode === "RHYTHM_TAP" && player.playing) {
      handleRhythmTap();
      return;
    }
    if (player.ready) togglePlay();
  }
  const status =
    countdown !== null || scoring.status === "arming"
      ? t("karaoke.stage.status.preparing")
      : player.waiting
        ? t("karaoke.stage.status.loading")
        : !started && !practiceLine && player.currentMs === 0
          ? t("karaoke.stage.status.pressStart")
          : activeLine
            ? player.playing
              ? t("karaoke.stage.status.activePlaying")
              : t("karaoke.stage.status.activeReady")
            : !player.playing
              ? t("karaoke.stage.status.pressResume")
              : next
                ? secondsToNext !== null && secondsToNext <= 3
                  ? t("karaoke.stage.status.countdownNext", {
                      seconds: secondsToNext,
                    })
                  : t("karaoke.stage.status.interludeNext")
                : t("karaoke.stage.status.outro");
  const finalScore =
    scoring.score ??
    (scoring.status === "insufficient" ? scoring.liveScore : null);
  const showMusicalPanel =
    ended &&
    !practiceLine &&
    ((practiceMode === "RHYTHM_TAP" && rhythmTapResult !== null) ||
      (scoredMode &&
        scoring.status === "scored" &&
        scoring.musicalScore !== null));
  const panelEvaluation =
    practiceMode === "RHYTHM_TAP" ? rhythmTapResult : scoring.musicalScore;

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
  const progressPct =
    source.duration_ms > 0
      ? Math.max(
          0,
          Math.min(100, (player.currentMs / source.duration_ms) * 100),
        )
      : 0;

  return (
    <section
      ref={root}
      tabIndex={0}
      aria-label={label}
      data-reduced-motion={reducedMotion ? "true" : undefined}
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
              {t("karaoke.stage.eyebrow", { alias: childAlias })}
            </p>
            <h1
              className="viread-learning-content break-words text-heading font-extrabold"
              dir="ltr"
              lang="vi"
            >
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
            {expanded ? t("karaoke.stage.collapse") : t("karaoke.stage.expand")}
          </button>
        </div>
      </div>

      <div
        role="group"
        aria-label={t("karaoke.stage.modeGroupAria")}
        className="flex flex-wrap gap-2"
      >
        <Button
          className="sm:w-auto"
          variant={scoredMode ? "secondary" : "primary"}
          aria-pressed={!scoredMode}
          onClick={() => selectMode(false)}
        >
          <MicOff aria-hidden className="size-5" />
          {t("karaoke.stage.freeMode")}
        </Button>
        <Button
          className="sm:w-auto"
          variant={scoredMode ? "primary" : "secondary"}
          aria-pressed={scoredMode}
          disabled={!scoring.supported}
          onClick={() => selectMode(true)}
        >
          <Mic aria-hidden className="size-5" />
          {t("karaoke.stage.scoredMode")}
        </Button>
      </div>
      <div
        role="group"
        aria-label={t("karaoke.stage.practiceModeGroupAria")}
        className="flex flex-wrap gap-2"
      >
        {PRACTICE_MODES.map((item) => {
          const active = practiceMode === item.mode;
          return (
            <button
              key={item.mode}
              type="button"
              aria-pressed={active}
              onClick={() => selectPracticeMode(item.mode)}
              className={`min-h-11 rounded-control border px-3 py-2 text-xs font-bold ${reducedMotion ? "" : "transition "}sm:text-sm ${
                active
                  ? "border-primary bg-primary text-white"
                  : "border-border bg-white text-slate-800 hover:bg-sky/50"
              }`}
            >
              {item.labelVi}
            </button>
          );
        })}
      </div>

      {scoredMode && practiceMode !== "RHYTHM_TAP" && (
        <div className="grid gap-2 rounded-control bg-sky p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-primary">
            <Headphones aria-hidden className="size-4 shrink-0" />
            <span>{t("karaoke.stage.headphoneRecommendation")}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex min-h-12 items-center gap-3">
              <input
                type="checkbox"
                checked={headphones}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setHeadphones(checked);
                  if (checked) {
                    setSpeakerBacking(false);
                    player.setMuted(false);
                  } else {
                    player.setMuted(!speakerBacking);
                  }
                }}
              />
              <span>
                {t("karaoke.stage.headphonesLabel")}
                <small className="block text-muted">
                  {t("karaoke.stage.speakerFilterHint")}
                </small>
              </span>
            </label>
            <button
              type="button"
              aria-pressed={speakerBacking}
              className={`inline-flex min-h-11 items-center gap-2 rounded-control border px-3 py-2 text-xs font-bold ${
                speakerBacking
                  ? "border-primary bg-white text-primary"
                  : "border-border bg-white/70 text-slate-700"
              }`}
              onClick={() => {
                const nextSpeaker = !speakerBacking;
                setSpeakerBacking(nextSpeaker);
                if (nextSpeaker) {
                  setHeadphones(false);
                  player.setMuted(false);
                } else {
                  player.setMuted(!headphones);
                }
              }}
            >
              <Volume2 aria-hidden className="size-4" />
              {speakerBacking
                ? t("karaoke.stage.speakerBackingOn")
                : t("karaoke.stage.speakerBackingOff")}
            </button>
          </div>
        </div>
      )}

      {!scoring.supported && practiceMode !== "RHYTHM_TAP" ? (
        <p className="text-sm text-muted">
          {t("karaoke.stage.unsupportedScoringWithRhythmHint")}
        </p>
      ) : scoring.error && practiceMode !== "RHYTHM_TAP" ? (
        <StatusMessage tone="warning">{scoring.error}</StatusMessage>
      ) : scoredMode &&
        practiceMode !== "RHYTHM_TAP" &&
        !started &&
        countdown === null ? (
        <p role="status" className="text-sm text-muted">
          {scoring.status === "arming"
            ? t("karaoke.stage.micArmingStatus")
            : t("karaoke.stage.micReadyNoticeDsp")}
        </p>
      ) : null}

      {ended ? (
        <div className={`${styles.lyrics} rounded-card bg-white/80 px-4`}>
          {finalScore ||
          (scoredMode &&
            practiceMode !== "RHYTHM_TAP" &&
            scoring.proScore !== null) ? (
            <KaraokeScoreCard
              score={finalScore}
              proScore={scoring.proScore}
              targetNotes={targetNotes}
              dspFrames={scoring.dspFrames}
              durationMs={source.duration_ms}
              replayAudioUrl={scoring.replayAudioUrl}
              onApplySuggestedKeyShift={(nextShift) => {
                player.setKeyShift(nextShift);
              }}
              onPractice={(id) =>
                practice(lines.find((line) => line.id === id))
              }
            />
          ) : !showMusicalPanel ? (
            <Star
              aria-hidden
              className="mx-auto size-16 fill-amber-100 text-amber-700"
            />
          ) : null}
          {showMusicalPanel && panelEvaluation && (
            <MusicalSummaryPanel
              evaluation={panelEvaluation}
              bestFullSongScore={bestFullSongScore}
              onPracticeSegment={practiceSegmentSlow}
            />
          )}
          <h2 className="text-heading font-extrabold">
            {t("karaoke.stage.finishedHeading", { alias: childAlias })}
          </h2>
          {!finalScore && !showMusicalPanel && !scoring.proScore && (
            <p role="status" className="text-muted">
              {scoring.status === "finishing"
                ? t("karaoke.stage.finishingLastLine")
                : t("karaoke.stage.thanksSinging")}
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-3 px-4">
            <Button
              className={`${styles.action} sm:w-auto`}
              onClick={restartSong}
            >
              <RotateCcw aria-hidden className="size-5" />
              {t("karaoke.stage.singAgain")}
            </Button>
            <ButtonLink
              variant="secondary"
              className={`${styles.action} sm:w-auto`}
              href="/karaoke"
            >
              {t("karaoke.stage.chooseAnother")}
            </ButtonLink>
          </div>
        </div>
      ) : (
        <>
          <PitchHighwayCanvas
            targetNotes={targetNotes}
            keyShift={player.keyShift}
            getCurrentMs={player.getCurrentMs}
            subscribeClock={player.subscribeClock}
            getPitchRing={scoring.getPitchRing}
            getLatestPitchSample={scoring.getLatestPitchSample}
            playing={player.playing}
            listening={scoring.listening}
            scoredMode={scoredMode && practiceMode !== "RHYTHM_TAP"}
            sttAvailable={scoring.sttAvailable}
            beatGridMs={resolvedProfile.beatGridMs}
            phraseStartsMs={phraseStartsMs}
            reducedMotion={reducedMotion}
          />
          <div
            className={`${styles.lyrics} rounded-card bg-white/80 px-4`}
            aria-label={t("karaoke.lyrics.regionAria")}
          >
            <p
              role="status"
              className={
                countdown === null
                  ? "flex items-center justify-center gap-2 font-bold text-primary"
                  : styles.countIn
              }
              data-testid="karaoke-cue"
            >
              {scoring.listening && (
                <Mic
                  aria-label={t("karaoke.stage.listeningAria")}
                  className={
                    reducedMotion
                      ? "size-4 text-primary"
                      : "size-4 animate-pulse text-primary"
                  }
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
                      reducedMotion={reducedMotion}
                      subscribeClock={player.subscribeClock}
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
                  ) : next?.text ? (
                    <span
                      className="viread-learning-content"
                      dir="ltr"
                      lang="vi"
                    >
                      {next.text}
                    </span>
                  ) : (
                    t("karaoke.stage.listenMusicDefault")
                  )}
                </p>

                {practiceMode === "RHYTHM_TAP" && (
                  <div className="mx-auto grid max-w-md gap-2">
                    <Button
                      className="min-h-16 text-lg font-extrabold"
                      disabled={!player.playing}
                      onClick={handleRhythmTap}
                    >
                      <Drum aria-hidden className="size-6" />
                      {t("karaoke.stage.rhythmTapButton")}
                    </Button>
                    {rhythmTapFeedback && (
                      <p
                        role="status"
                        data-testid="karaoke-rhythm-tap-feedback"
                        className="text-sm font-bold text-primary"
                      >
                        {t("karaoke.stage.rhythmTapFeedback", {
                          feedback: rhythmTapFeedback.labelVi,
                          streak: rhythmTapFeedback.streak,
                        })}
                      </p>
                    )}
                  </div>
                )}

                {scoredMode && practiceMode !== "RHYTHM_TAP" && (
                  <div
                    data-testid="karaoke-live-feedback"
                    className="mx-auto flex flex-wrap items-center justify-center gap-2 text-xs font-bold sm:text-sm"
                  >
                    <span className="rounded-full border border-green-500 bg-green-100 px-3 py-1 text-green-900">
                      {t("karaoke.stage.liveMatched", { count: liveMatched })}
                    </span>
                    <span className="rounded-full border border-red-500 bg-red-100 px-3 py-1 text-red-900">
                      {t("karaoke.stage.liveWrong", { count: liveWrong })}
                    </span>
                    <span className="rounded-full border border-orange-400 bg-orange-100 px-3 py-1 text-orange-900">
                      {t("karaoke.stage.liveOmitted", { count: liveOmitted })}
                    </span>
                    {pendingWords > 0 && (
                      <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-slate-700">
                        {t("karaoke.stage.liveProcessing", {
                          count: pendingWords,
                        })}
                      </span>
                    )}
                    {livePercent !== null && (
                      <span className="rounded-full border border-primary bg-sky px-3 py-1 text-primary">
                        {t("karaoke.stage.livePercent", {
                          percent: livePercent,
                        })}
                      </span>
                    )}
                    {scoring.liveTelemetry?.voiced &&
                      scoring.liveTelemetry.frequencyHz && (
                        <span className="rounded-full border border-indigo-300 bg-indigo-50 px-3 py-1 text-indigo-900">
                          {t("karaoke.stage.livePitchHz", {
                            hz: Math.round(scoring.liveTelemetry.frequencyHz),
                          })}
                        </span>
                      )}
                  </div>
                )}
                {scoredMode &&
                  practiceMode !== "RHYTHM_TAP" &&
                  scoring.listening && (
                    <p className="text-xs text-muted">
                      {scoring.signal === "uncertain" &&
                      liveEvaluated === 0 &&
                      pendingWords === 0
                        ? t("karaoke.stage.uncertainMicHint")
                        : t("karaoke.stage.dottedMatchingHint")}
                    </p>
                  )}
                {activeLine && next && (
                  <p className={styles.next}>
                    {t("karaoke.lyrics.nextPrefix")}
                    <span
                      className="viread-learning-content"
                      dir="ltr"
                      lang="vi"
                    >
                      {next.text}
                    </span>
                  </p>
                )}
                <p className="text-sm text-muted">
                  {practiceLine ? (
                    <>
                      <span>
                        {practiceMode === "SEGMENT"
                          ? t("karaoke.stage.practicingSegment", {
                              number: lines.indexOf(practiceLine) + 1,
                            })
                          : t("karaoke.stage.practicingLine", {
                              number: lines.indexOf(practiceLine) + 1,
                            })}
                      </span>
                      {player.rate < 1 ? (
                        <span>
                          {" "}
                          {t("karaoke.stage.practicingRateSuffix", {
                            rate: player.rate,
                          })}
                        </span>
                      ) : null}
                    </>
                  ) : activeLine ? (
                    t("karaoke.stage.lineProgress", {
                      current: activeIndex + 1,
                      total: lines.length,
                    })
                  ) : (
                    t("karaoke.stage.readyToSing")
                  )}
                </p>
              </>
            )}
          </div>
          {practiceLine && scoring.status === "finishing" && (
            <p role="status">{t("karaoke.stage.finishingLastLine")}</p>
          )}
          {practiceLine && scoring.score && (
            <KaraokeScoreCard score={scoring.score} practice />
          )}
          {practiceLine && scoring.status === "insufficient" && (
            <p role="status">{t("karaoke.stage.notClearRetry")}</p>
          )}
          {practiceLine && (scoredMode || practiceMode === "SEGMENT") && (
            <Button variant="quiet" onClick={leavePractice}>
              {scoring.songScore || practiceReturnMs >= source.duration_ms
                ? t("karaoke.stage.backToSongScore")
                : t("karaoke.stage.backToFullSong")}
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
                ? t("karaoke.stage.cancelPrep")
                : player.playing
                  ? t("karaoke.stage.pause")
                  : player.error
                    ? t("karaoke.stage.retryPlay")
                    : !started && player.currentMs === 0
                      ? t("karaoke.stage.startSinging")
                      : t("karaoke.stage.resumeSinging")}
            </Button>
            <Button
              variant="secondary"
              className={`${styles.action} sm:w-auto`}
              disabled={!player.ready || !targetLine}
              onClick={() => practice()}
            >
              <RotateCcw aria-hidden className="size-5" />
              {t("karaoke.stage.practiceThisLine")}
            </Button>
            {(scoredMode || practiceMode === "RHYTHM_TAP") &&
              started &&
              !practiceLine &&
              countdown === null && (
                <Button
                  variant="secondary"
                  className={`${styles.action} sm:w-auto`}
                  onClick={finishAndScoreSong}
                >
                  <Star aria-hidden className="size-5" />
                  {t("karaoke.stage.finishAndScore")}
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
                {repeat
                  ? t("karaoke.stage.repeatingLine")
                  : t("karaoke.stage.repeatLine")}
              </Button>
            )}
          </div>
        </>
      )}
      {player.error && (
        <StatusMessage tone="error" title={t("karaoke.stage.audioErrorTitle")}>
          {t("karaoke.stage.audioErrorDesc")}
        </StatusMessage>
      )}
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <label htmlFor={`karaoke-position-${source.version_id}`}>
            {t("karaoke.controls.positionLabel")}
          </label>
          <span className="tabular-nums">
            {formatKaraokeTime(player.currentMs)} /{" "}
            {formatKaraokeTime(source.duration_ms)}
          </span>
        </div>
        <div
          aria-hidden="true"
          className="h-1.5 w-full overflow-hidden rounded-full bg-sky"
        >
          <div
            ref={playheadBarRef}
            className="h-full bg-primary transition-none"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <input
          id={`karaoke-position-${source.version_id}`}
          aria-label={t("karaoke.controls.positionLabel")}
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
        <div className="flex flex-wrap items-center justify-center gap-4">
          <label className="flex flex-wrap items-center justify-center gap-3 font-bold">
            {t("karaoke.stage.tempoLabel")}
            <select
              aria-label={t("karaoke.stage.tempoLabel")}
              className="min-h-14 rounded-control border border-border bg-white px-4"
              value={player.rate}
              onChange={(event) => player.setRate(Number(event.target.value))}
            >
              <option value={0.75}>{t("karaoke.stage.tempoSlow")}</option>
              <option value={0.85}>{t("karaoke.stage.tempoSegment")}</option>
              <option value={1}>{t("karaoke.stage.tempoNormal")}</option>
            </select>
          </label>
          <div
            role="group"
            aria-label="Chỉnh tông mục tiêu"
            data-testid="karaoke-key-shift-controls"
            className="flex items-center gap-1.5 rounded-control border border-border bg-white px-2.5 py-1.5"
          >
            <span className="text-xs font-extrabold text-muted">Tông:</span>
            <button
              type="button"
              aria-label="Hạ tông 1 bán âm"
              disabled={player.keyShift <= -3}
              onClick={() => player.setKeyShift(player.keyShift - 1)}
              className="grid min-h-12 min-w-12 place-items-center rounded-control border border-border bg-sky/50 text-lg font-black text-primary hover:bg-sky disabled:opacity-40"
            >
              −
            </button>
            <button
              type="button"
              aria-label="Đặt lại tông chuẩn 0 bán âm"
              onClick={() => player.setKeyShift(0)}
              className="min-h-12 min-w-16 rounded-control px-2 text-sm font-extrabold text-ink tabular-nums hover:bg-cream"
            >
              {player.keyShift > 0
                ? `+${player.keyShift}`
                : `${player.keyShift}`}
            </button>
            <button
              type="button"
              aria-label="Tăng tông 1 bán âm"
              disabled={player.keyShift >= 3}
              onClick={() => player.setKeyShift(player.keyShift + 1)}
              className="grid min-h-12 min-w-12 place-items-center rounded-control border border-border bg-sky/50 text-lg font-black text-primary hover:bg-sky disabled:opacity-40"
            >
              +
            </button>
          </div>
        </div>
      </div>
      <details className="min-w-0 rounded-control border border-border bg-white/70 p-4">
        <summary className="min-h-11 cursor-pointer content-center font-bold text-primary">
          {t("karaoke.stage.pickLineSummary")}
        </summary>
        <LyricPickerList
          lines={lines}
          ready={player.ready}
          practiceId={practiceId}
          onSelectLine={practice}
        />
        {practiceLine && (
          <Button
            variant="secondary"
            className="mt-3 sm:w-auto"
            onClick={leavePractice}
          >
            {t("karaoke.stage.backToWholeSong")}
          </Button>
        )}
      </details>
      <details className="min-w-0 rounded-control border border-border bg-white/70 p-4">
        <summary className="min-h-11 cursor-pointer content-center font-bold text-primary">
          {t("karaoke.stage.volumeAndInfoSummary")}
        </summary>
        <div className="mt-3 grid min-w-0 gap-4">
          <label className="grid gap-2 font-bold">
            {t("karaoke.controls.volumeLabel")}
            <input
              aria-label={t("karaoke.controls.volumeLabel")}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={player.volume}
              onChange={(event) => player.setVolume(Number(event.target.value))}
              className="min-h-12 w-full accent-primary"
            />
          </label>
          <label className="grid gap-1.5 font-bold">
            <span className="flex items-center justify-between gap-2 text-sm">
              <span>Hiệu chỉnh độ trễ micro (tai nghe Bluetooth / loa)</span>
              <span
                data-testid="karaoke-mic-latency-value"
                className="tabular-nums text-primary"
              >
                {micLatencyMs > 0 ? `+${micLatencyMs}` : micLatencyMs} ms
              </span>
            </span>
            <input
              aria-label="Hiệu chỉnh độ trễ micro"
              type="range"
              min={MIC_LATENCY_MIN_MS}
              max={MIC_LATENCY_MAX_MS}
              step={10}
              value={micLatencyMs}
              onChange={(event) => setMicLatencyMs(Number(event.target.value))}
              className="min-h-12 w-full accent-primary"
            />
          </label>
          {source.author && (
            <div className="min-w-0">
              <h2 className="font-bold">
                {t("karaoke.stage.songInfoHeading")}
              </h2>
              <p
                className="viread-learning-content mt-2 break-words text-sm text-muted"
                dir="ltr"
                lang="vi"
              >
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
              {t("karaoke.stage.restartFromBeginning")}
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
                {t("karaoke.stage.reloadAudio")}
              </Button>
            )}
          </div>
          <p className="text-sm text-muted">
            {scoredMode
              ? t("karaoke.stage.spaceHintScored")
              : practiceMode === "RHYTHM_TAP"
                ? t("karaoke.stage.spaceHintRhythmTap")
                : t("karaoke.stage.spaceHintFree")}
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
          {t("karaoke.stage.reloadAudioRetry")}
        </Button>
      )}
    </section>
  );
}
