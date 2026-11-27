"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface AiProgressStage {
  readonly atPct: number;
  readonly label: string;
}

export interface UseAiProgressOptions {
  readonly active: boolean;
  readonly realPercent?: number | null;
  readonly progressMode?: "measured" | "staged";
  readonly stages?: readonly AiProgressStage[];
  readonly expectedDurationMs?: number;
  readonly completed?: boolean;
  readonly failed?: boolean;
  readonly floorPct?: number;
  readonly ceilingPct?: number;
  readonly resetKey?: string | number | null;
}

export interface UseAiProgressResult {
  readonly percent: number;
  readonly displayPercent: number;
  readonly stageLabel: string | null;
  readonly elapsedSeconds: number;
  readonly isComplete: boolean;
}

export interface StagedAiProgressCalcOptions {
  readonly realPercent?: number | null;
  readonly progressMode?: "measured" | "staged";
  readonly expectedDurationMs?: number;
  readonly floorPct?: number;
  readonly ceilingPct?: number;
}

const DEFAULT_FLOOR_PCT = 8;
const DEFAULT_CEILING_PCT = 94;
const DEFAULT_DURATION_MS = 12_000;
const TICK_INTERVAL_MS = 250;
const STAGED_MILESTONE_CREEP_PCT = 12;

export function clampAiProgressPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function formatAiProgressPct(value: number | null | undefined): string {
  const clamped = clampAiProgressPct(
    typeof value === "number" && Number.isFinite(value) ? value : 0,
  );
  return `${Math.round(clamped)}%`;
}

export function computeStagedAiProgress(
  elapsedMs: number,
  options: StagedAiProgressCalcOptions = {},
): number {
  const floor = clampAiProgressPct(options.floorPct ?? DEFAULT_FLOOR_PCT);
  const ceiling = Math.max(
    floor,
    clampAiProgressPct(options.ceilingPct ?? DEFAULT_CEILING_PCT),
  );
  const duration = Math.max(
    1_000,
    options.expectedDurationMs ?? DEFAULT_DURATION_MS,
  );
  const tau = duration / 2.2;
  const safeElapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);

  const hasReal =
    typeof options.realPercent === "number" &&
    Number.isFinite(options.realPercent);

  if (hasReal) {
    const clampedReal = clampAiProgressPct(options.realPercent!);
    if (options.progressMode === "measured") {
      return clampedReal;
    }
    if (clampedReal >= 100) {
      return 100;
    }
    const base = Math.min(ceiling, Math.max(clampedReal, floor));
    const localCap = Math.min(
      ceiling,
      Math.max(base, clampedReal + STAGED_MILESTONE_CREEP_PCT),
    );
    const ratio = 1 - Math.exp(-safeElapsed / tau);
    return base + (localCap - base) * ratio;
  }

  const ratio = 1 - Math.exp(-safeElapsed / tau);
  return floor + (ceiling - floor) * ratio;
}

export function resolveAiProgressStageLabel(
  percent: number,
  stages?: readonly AiProgressStage[],
): string | null {
  if (!stages || stages.length === 0) return null;
  let chosen: AiProgressStage | null = null;
  let lowest: AiProgressStage = stages[0];
  for (const stage of stages) {
    if (stage.atPct < lowest.atPct) {
      lowest = stage;
    }
    if (stage.atPct <= percent) {
      if (!chosen || stage.atPct >= chosen.atPct) {
        chosen = stage;
      }
    }
  }
  return (chosen ?? lowest).label;
}

interface ProgressTickState {
  readonly running: boolean;
  readonly elapsedMs: number;
  readonly peakPct: number;
  readonly resetKey?: string | number | null;
}

const IDLE_TICK_STATE: ProgressTickState = {
  running: false,
  elapsedMs: 0,
  peakPct: 0,
  resetKey: undefined,
};

export function useAiProgress(
  options: UseAiProgressOptions,
): UseAiProgressResult {
  const {
    active,
    realPercent = null,
    progressMode = "staged",
    stages,
    expectedDurationMs = DEFAULT_DURATION_MS,
    completed = false,
    failed = false,
    floorPct = DEFAULT_FLOOR_PCT,
    ceilingPct = DEFAULT_CEILING_PCT,
    resetKey,
  } = options;

  const [tick, setTick] = useState<ProgressTickState>(IDLE_TICK_STATE);

  const latestConfigRef = useRef<StagedAiProgressCalcOptions>({
    realPercent,
    progressMode,
    expectedDurationMs,
    floorPct,
    ceilingPct,
  });

  useEffect(() => {
    latestConfigRef.current = {
      realPercent,
      progressMode,
      expectedDurationMs,
      floorPct,
      ceilingPct,
    };
  }, [ceilingPct, expectedDurationMs, floorPct, progressMode, realPercent]);

  const shouldTick = active && !completed && !failed;

  useEffect(() => {
    if (!shouldTick) {
      return;
    }

    const startedAt = Date.now();
    let milestoneStart = startedAt;
    let lastRealPercent = latestConfigRef.current.realPercent;

    const timerId = globalThis.setInterval(() => {
      const cfg = latestConfigRef.current;
      const now = Date.now();
      if (cfg.realPercent !== lastRealPercent) {
        lastRealPercent = cfg.realPercent;
        milestoneStart = now;
      }
      const totalElapsed = Math.max(0, now - startedAt);
      const hasReal =
        typeof cfg.realPercent === "number" && Number.isFinite(cfg.realPercent);
      const isMeasuredReal = cfg.progressMode === "measured" && hasReal;
      const effectiveElapsed = hasReal
        ? Math.max(0, now - milestoneStart)
        : totalElapsed;
      const computed = computeStagedAiProgress(effectiveElapsed, cfg);

      setTick((prev) => {
        const prevPeak =
          prev.running && prev.resetKey === resetKey ? prev.peakPct : 0;
        return {
          running: true,
          elapsedMs: totalElapsed,
          peakPct: isMeasuredReal ? computed : Math.max(prevPeak, computed),
          resetKey,
        };
      });
    }, TICK_INTERVAL_MS);

    return () => {
      globalThis.clearInterval(timerId);
      setTick(IDLE_TICK_STATE);
    };
  }, [resetKey, shouldTick]);

  const hasMeasuredReal =
    progressMode === "measured" &&
    typeof realPercent === "number" &&
    Number.isFinite(realPercent);
  const isCurrentTick = tick.running && tick.resetKey === resetKey;

  const instantPct = useMemo(() => {
    if (completed) return 100;
    if (!active || failed) return 0;
    return computeStagedAiProgress(0, {
      realPercent,
      progressMode,
      expectedDurationMs,
      floorPct,
      ceilingPct,
    });
  }, [
    active,
    ceilingPct,
    completed,
    expectedDurationMs,
    failed,
    floorPct,
    progressMode,
    realPercent,
  ]);

  const percent = useMemo(() => {
    if (completed) return 100;
    if (!active || failed) return 0;
    if (hasMeasuredReal) {
      return clampAiProgressPct(instantPct);
    }
    const raw = isCurrentTick ? Math.max(tick.peakPct, instantPct) : instantPct;
    return clampAiProgressPct(raw);
  }, [
    active,
    completed,
    failed,
    hasMeasuredReal,
    instantPct,
    isCurrentTick,
    tick.peakPct,
  ]);

  const displayPercent = Math.round(percent);
  const elapsedSeconds =
    shouldTick && isCurrentTick ? Math.floor(tick.elapsedMs / 1000) : 0;
  const stageLabel = useMemo(
    () => resolveAiProgressStageLabel(percent, stages),
    [percent, stages],
  );

  return {
    percent,
    displayPercent,
    stageLabel,
    elapsedSeconds,
    isComplete: completed || displayPercent >= 100,
  };
}
