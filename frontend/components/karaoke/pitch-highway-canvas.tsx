"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { Flame, Mic, Sparkles } from "lucide-react";
import type { ClockListener } from "@/hooks/use-karaoke-player";
import type { LivePitchSample } from "@/lib/karaoke/musical-dsp";
import {
  evaluateLivePitchJudgement,
  midiToNoteName,
  type PitchJudgement,
  type TargetNoteSpan,
} from "@/lib/karaoke/pro-karaoke-scoring";

export interface PitchHighwayCanvasProps {
  /** Reference melody target note bars (empty array for legacy songs without melody_profile). */
  targetNotes: readonly TargetNoteSpan[];
  /** Key shift in semitones (-3..+3) applied live to target notes. */
  keyShift: number;
  /** Live playback clock reader (no React state dependency). */
  getCurrentMs: () => number;
  /** Optional 60fps clock subscriber from useKaraokePlayer. */
  subscribeClock?: (listener: ClockListener) => () => void;
  /** Zero-re-render ref accessor for recent smoothed live vocal pitch samples. */
  getPitchRing: () => readonly LivePitchSample[];
  /** Zero-re-render ref accessor for latest live vocal pitch sample. */
  getLatestPitchSample: () => LivePitchSample | null;
  /** Whether audio playback is running. */
  playing: boolean;
  /** Whether microphone scoring is active & listening. */
  listening: boolean;
  /** Whether scored mode is enabled. */
  scoredMode: boolean;
  /** Whether speech recognition (STT) is available for the Lyrics pillar. */
  sttAvailable: boolean;
  /** Beat grid timestamps (ms) for subtle beat pulse & lead-in dots. */
  beatGridMs?: readonly number[];
  /** Honor prefers-reduced-motion & child calm preferences. */
  reducedMotion?: boolean;
  /** Phrase start timestamps (ms) for 3-2-1 lead-in dots before each line. */
  phraseStartsMs?: readonly number[];
}

interface SparkleParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

const WINDOW_MS = 5000;
const PLAYHEAD_RATIO = 0.3;
const PAST_MS = WINDOW_MS * PLAYHEAD_RATIO;
const FUTURE_MS = WINDOW_MS * (1 - PLAYHEAD_RATIO);

function judgementColor(j: PitchJudgement): string {
  switch (j) {
    case "perfect":
      return "#34D399"; // emerald-400
    case "great":
      return "#38BDF8"; // sky-400
    case "good":
      return "#FBBF24"; // amber-400
    case "off_pitch":
      return "#FB7185"; // rose-400
    default:
      return "#A5B4FC"; // indigo-300
  }
}

function foldMidiNear(midi: number, centerMidi: number): number {
  let folded = midi;
  while (folded - centerMidi > 6.5) folded -= 12;
  while (folded - centerMidi < -6.5) folded += 12;
  return folded;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * 60fps HiDPI Pro Pitch Highway Canvas (SingStar / Smule / DAM inspired).
 * Completely decoupled from React state: reads playback clock & vocal DSP ring
 * buffer through refs inside requestAnimationFrame so React never janks.
 */
export const PitchHighwayCanvas = memo(function PitchHighwayCanvas({
  targetNotes,
  keyShift,
  getCurrentMs,
  subscribeClock,
  getPitchRing,
  getLatestPitchSample,
  playing,
  listening,
  scoredMode,
  sttAvailable,
  beatGridMs = [],
  reducedMotion = false,
  phraseStartsMs = [],
}: PitchHighwayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vuBarRef = useRef<HTMLDivElement | null>(null);
  const liveScoreTextRef = useRef<HTMLSpanElement | null>(null);
  const comboBadgeRef = useRef<HTMLSpanElement | null>(null);
  const comboTextRef = useRef<HTMLSpanElement | null>(null);
  const guidePillRef = useRef<HTMLSpanElement | null>(null);
  const particlesRef = useRef<SparkleParticle[]>([]);
  const liveStatsRef = useRef({
    hits: 0,
    total: 0,
    combo: 0,
    lastJudgedMs: -1,
  });

  // Reset live rolling stats when song notes change or singing stops/restarts at 0
  const hasReference = targetNotes.length > 0;
  const { minMidi, maxMidi, centerMidi } = useMemo(() => {
    if (!targetNotes.length) {
      // Child comfortable default ribbon range: C4 (60) .. A5 (81)
      return { minMidi: 57, maxMidi: 81, centerMidi: 69 };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < targetNotes.length; i++) {
      const m = targetNotes[i].midi + keyShift;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    const padLo = Math.floor(lo - 4);
    const padHi = Math.ceil(hi + 4);
    const span = Math.max(14, padHi - padLo);
    const mid = (padLo + padHi) / 2;
    return {
      minMidi: mid - span / 2,
      maxMidi: mid + span / 2,
      centerMidi: mid,
    };
  }, [targetNotes, keyShift]);

  const propsRef = useRef({
    targetNotes,
    keyShift,
    getCurrentMs,
    getPitchRing,
    getLatestPitchSample,
    playing,
    listening,
    scoredMode,
    beatGridMs,
    phraseStartsMs,
    reducedMotion,
    minMidi,
    maxMidi,
    centerMidi,
  });
  propsRef.current = {
    targetNotes,
    keyShift,
    getCurrentMs,
    getPitchRing,
    getLatestPitchSample,
    playing,
    listening,
    scoredMode,
    beatGridMs,
    phraseStartsMs,
    reducedMotion,
    minMidi,
    maxMidi,
    centerMidi,
  };

  useEffect(() => {
    if (!scoredMode) {
      liveStatsRef.current = { hits: 0, total: 0, combo: 0, lastJudgedMs: -1 };
      particlesRef.current = [];
    }
  }, [scoredMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!ctx) return;

    let rafId = 0;
    let disposed = false;
    let lastDrawWall = 0;

    const drawFrame = (forcedMs?: number) => {
      if (disposed || !canvas || !ctx) return;
      const {
        targetNotes: notes,
        keyShift: shift,
        getCurrentMs: readClock,
        getPitchRing: readRing,
        getLatestPitchSample: readLatest,
        listening: isListening,
        scoredMode: isScored,
        beatGridMs: beats,
        phraseStartsMs: phraseStarts,
        reducedMotion: noMotion,
        minMidi: loMidi,
        maxMidi: hiMidi,
        centerMidi: midMidi,
      } = propsRef.current;

      const dpr =
        typeof window !== "undefined"
          ? Math.min(2, window.devicePixelRatio || 1)
          : 1;
      const cssW = Math.max(280, canvas.clientWidth || 640);
      const cssH = Math.max(150, canvas.clientHeight || 196);
      const targetW = Math.round(cssW * dpr);
      const targetH = Math.round(cssH * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      const nowMs = forcedMs ?? readClock();
      if (nowMs < 200 && liveStatsRef.current.lastJudgedMs > 1000) {
        liveStatsRef.current = { hits: 0, total: 0, combo: 0, lastJudgedMs: -1 };
        particlesRef.current = [];
      }

      const playheadX = cssW * PLAYHEAD_RATIO;
      const pxPerMs = cssW / WINDOW_MS;
      const padTop = 22;
      const padBottom = 18;
      const plotH = cssH - padTop - padBottom;
      const midiSpan = Math.max(12, hiMidi - loMidi);
      const midiToY = (midi: number) => {
        const clamped = Math.max(loMidi, Math.min(hiMidi, midi));
        const ratio = (clamped - loMidi) / midiSpan;
        return padTop + (1 - ratio) * plotH;
      };
      const msToX = (ms: number) => playheadX + (ms - nowMs) * pxPerMs;

      // 1. Concert-stage gradient background
      const bg = ctx.createLinearGradient(0, 0, 0, cssH);
      bg.addColorStop(0, "#0B162C");
      bg.addColorStop(0.55, "#13264A");
      bg.addColorStop(1, "#0E1A33");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cssW, cssH);

      // 2. Subtle horizontal pitch grid (Cao / Vừa / Thấp + octave lines)
      ctx.lineWidth = 1;
      const gridLevels = [
        { ratio: 0.16, label: "Cao" },
        { ratio: 0.5, label: "Vừa" },
        { ratio: 0.84, label: "Thấp" },
      ];
      ctx.font = "600 10px system-ui, -apple-system, sans-serif";
      for (const level of gridLevels) {
        const y = padTop + level.ratio * plotH;
        ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
        ctx.stroke();

        ctx.fillStyle = "rgba(186, 230, 253, 0.55)";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const noteLabel = midiToNoteName(hiMidi - level.ratio * midiSpan);
        ctx.fillText(`${level.label} · ${noteLabel}`, 8, y - 7);
      }

      // 3. Subtle beat pulse vertical lines
      if (beats.length > 0) {
        ctx.strokeStyle = "rgba(56, 189, 248, 0.08)";
        ctx.lineWidth = 1;
        for (let i = 0; i < beats.length; i++) {
          const bMs = beats[i];
          if (bMs < nowMs - PAST_MS || bMs > nowMs + FUTURE_MS) continue;
          const x = msToX(bMs);
          ctx.beginPath();
          ctx.moveTo(x, padTop);
          ctx.lineTo(x, cssH - padBottom);
          ctx.stroke();
        }
      }

      // 4. Lead-in dots (● ● ●) right before upcoming phrase start
      for (let i = 0; i < phraseStarts.length; i++) {
        const pStart = phraseStarts[i];
        const delta = pStart - nowMs;
        if (delta > 0 && delta <= 1800) {
          const dotsLit = delta <= 600 ? 3 : delta <= 1200 ? 2 : 1;
          const dotY = 12;
          for (let d = 0; d < 3; d++) {
            ctx.beginPath();
            ctx.arc(playheadX + 18 + d * 12, dotY, 4, 0, Math.PI * 2);
            ctx.fillStyle =
              d < dotsLit ? "#FACC15" : "rgba(255, 255, 255, 0.22)";
            ctx.fill();
          }
          break;
        }
      }

      // 5. Scrolling Reference Melody Target Bars
      const latestSample = isListening ? readLatest() : null;
      const liveJudgement =
        isListening && latestSample
          ? evaluateLivePitchJudgement(
              latestSample.smoothedMidi ?? latestSample.rawMidi,
              latestSample.voiced,
              notes,
              nowMs,
              shift,
            )
          : null;

      if (notes.length > 0) {
        const barHeight = Math.max(12, Math.min(20, plotH / 9));
        for (let i = 0; i < notes.length; i++) {
          const note = notes[i];
          if (note.endMs < nowMs - PAST_MS - 100) continue;
          if (note.startMs > nowMs + FUTURE_MS + 100) break;

          const x1 = msToX(note.startMs);
          const x2 = msToX(note.endMs);
          const w = Math.max(10, x2 - x1);
          const y = midiToY(note.midi + shift) - barHeight / 2;
          const isCurrent = note.startMs <= nowMs && nowMs <= note.endMs;
          const isPast = note.endMs < nowMs;

          roundRectPath(ctx, x1, y, w, barHeight, barHeight / 2);
          if (isCurrent) {
            const hitColor =
              liveJudgement &&
              (liveJudgement.judgement === "perfect" ||
                liveJudgement.judgement === "great")
                ? "#34D399"
                : "#38BDF8";
            ctx.fillStyle = hitColor;
            ctx.shadowColor = hitColor;
            ctx.shadowBlur = noMotion ? 0 : 12;
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = "#FFFFFF";
            ctx.lineWidth = 1.6;
            ctx.stroke();
          } else if (isPast) {
            ctx.fillStyle = "rgba(129, 140, 248, 0.32)";
            ctx.fill();
          } else {
            const barGrad = ctx.createLinearGradient(x1, y, x2, y);
            barGrad.addColorStop(0, "rgba(56, 189, 248, 0.85)");
            barGrad.addColorStop(1, "rgba(129, 140, 248, 0.85)");
            ctx.fillStyle = barGrad;
            ctx.fill();
            ctx.strokeStyle = "rgba(224, 242, 254, 0.55)";
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          // Crisp syllable label inside wider upcoming/active bars
          if (note.text && w >= 28) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x1 + 4, y, w - 8, barHeight);
            ctx.clip();
            ctx.font = "700 11px system-ui, -apple-system, sans-serif";
            ctx.fillStyle = isCurrent ? "#052E16" : "#F8FAFC";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(note.text, x1 + 6, y + barHeight / 2 + 0.5);
            ctx.restore();
          }
        }
      }

      // 6. Fixed Playhead Vertical Beam (~30% from left)
      const beamGrad = ctx.createLinearGradient(playheadX, 0, playheadX, cssH);
      beamGrad.addColorStop(0, "rgba(250, 204, 21, 0.15)");
      beamGrad.addColorStop(0.5, "rgba(250, 204, 21, 0.88)");
      beamGrad.addColorStop(1, "rgba(250, 204, 21, 0.15)");
      ctx.strokeStyle = beamGrad;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, cssH);
      ctx.stroke();

      // 7. Smooth Live Vocal Pitch Curve from Ring Buffer
      const ring = readRing();
      if (ring.length > 1) {
        let segment: { x: number; y: number; color: string }[] = [];
        const flushSegment = () => {
          if (segment.length < 2 || !ctx) {
            segment = [];
            return;
          }
          ctx.lineWidth = 4;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.strokeStyle = segment[segment.length - 1].color;
          ctx.beginPath();
          ctx.moveTo(segment[0].x, segment[0].y);
          for (let k = 1; k < segment.length - 1; k++) {
            const xc = (segment[k].x + segment[k + 1].x) / 2;
            const yc = (segment[k].y + segment[k + 1].y) / 2;
            ctx.quadraticCurveTo(segment[k].x, segment[k].y, xc, yc);
          }
          const lastPt = segment[segment.length - 1];
          ctx.lineTo(lastPt.x, lastPt.y);
          ctx.stroke();
          segment = [];
        };

        let prevSampleMs = -Infinity;
        for (let i = 0; i < ring.length; i++) {
          const s = ring[i];
          if (s.timeMs < nowMs - PAST_MS - 60 || s.timeMs > nowMs + 60) {
            continue;
          }
          const m = s.smoothedMidi ?? s.rawMidi;
          if (!s.voiced || m === null || s.timeMs - prevSampleMs > 180) {
            flushSegment();
            prevSampleMs = s.timeMs;
            if (!s.voiced || m === null) continue;
          }
          prevSampleMs = s.timeMs;
          const x = msToX(s.timeMs);
          const folded = notes.length > 0 ? foldMidiNear(m, midMidi) : m;
          const y = midiToY(folded);
          const j =
            notes.length > 0
              ? evaluateLivePitchJudgement(m, true, notes, s.timeMs, shift)
                  .judgement
              : "great";
          segment.push({ x, y, color: judgementColor(j) });
        }
        flushSegment();
      }

      // 8. Glowing Cursor Star/Orb at Playhead + Sparkle Particles
      if (
        latestSample &&
        latestSample.voiced &&
        (latestSample.smoothedMidi ?? latestSample.rawMidi) !== null &&
        Math.abs(nowMs - latestSample.timeMs) <= 280
      ) {
        const rawM = (latestSample.smoothedMidi ?? latestSample.rawMidi)!;
        const foldedM = notes.length > 0 ? foldMidiNear(rawM, midMidi) : rawM;
        const cy = midiToY(foldedM);
        const color = judgementColor(liveJudgement?.judgement ?? "great");

        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = noMotion ? 0 : 16;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(playheadX, cy, 7.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(playheadX, cy, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Update live rolling HUD stats + spawn sparkle particles on hit
        if (
          isScored &&
          liveJudgement &&
          liveJudgement.targetMidi !== null &&
          nowMs - liveStatsRef.current.lastJudgedMs >= 140
        ) {
          liveStatsRef.current.lastJudgedMs = nowMs;
          liveStatsRef.current.total++;
          if (
            liveJudgement.judgement === "perfect" ||
            liveJudgement.judgement === "great"
          ) {
            liveStatsRef.current.hits++;
            liveStatsRef.current.combo++;
            if (!noMotion && particlesRef.current.length < 36) {
              for (let p = 0; p < 4; p++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 1.2 + Math.random() * 2.4;
                particlesRef.current.push({
                  x: playheadX,
                  y: cy,
                  vx: Math.cos(angle) * speed,
                  vy: Math.sin(angle) * speed - 0.8,
                  life: 0,
                  maxLife: 18 + Math.random() * 14,
                  size: 2 + Math.random() * 2.5,
                  color:
                    liveJudgement.judgement === "perfect"
                      ? "#FACC15"
                      : "#34D399",
                });
              }
            }
          } else if (liveJudgement.judgement === "good") {
            liveStatsRef.current.hits += 0.55;
            liveStatsRef.current.combo = 0;
          } else {
            liveStatsRef.current.combo = 0;
          }
        }
      }

      // Draw & step sparkle particles (disabled when reducedMotion=true)
      if (!noMotion && particlesRef.current.length > 0) {
        const alive: SparkleParticle[] = [];
        for (let i = 0; i < particlesRef.current.length; i++) {
          const p = particlesRef.current[i];
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.08;
          p.life++;
          if (p.life < p.maxLife) {
            const alpha = 1 - p.life / p.maxLife;
            ctx.globalAlpha = alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            alive.push(p);
          }
        }
        ctx.globalAlpha = 1;
        particlesRef.current = alive;
      }

      ctx.restore();

      // 9. Ref-driven HUD DOM updates (ZERO React re-renders!)
      if (vuBarRef.current) {
        const rms = latestSample?.vocalBandRms ?? 0;
        const pct = isListening
          ? Math.max(4, Math.min(100, Math.round(rms * 580)))
          : 0;
        vuBarRef.current.style.width = `${pct}%`;
      }
      if (liveScoreTextRef.current) {
        const st = liveStatsRef.current;
        liveScoreTextRef.current.textContent =
          st.total > 0 ? `${Math.round((st.hits / st.total) * 100)}` : "--";
      }
      if (comboBadgeRef.current) {
        const combo = liveStatsRef.current.combo;
        comboBadgeRef.current.style.opacity = combo >= 2 ? "1" : "0";
        if (comboTextRef.current) {
          comboTextRef.current.textContent = combo >= 2 ? `x${combo}` : "";
        }
      }
      if (guidePillRef.current) {
        if (!isListening) {
          guidePillRef.current.textContent =
            notes.length > 0
              ? "Nhìn thanh giai điệu chạy tới vạch vàng để hát đúng tông"
              : "Sẵn sàng thu cao độ trực tiếp của bé";
        } else if (!liveJudgement || liveJudgement.judgement === "unvoiced") {
          guidePillRef.current.textContent = latestSample?.voiced
            ? `Đang hát: ${midiToNoteName(latestSample.smoothedMidi ?? latestSample.rawMidi ?? 69)}`
            : "Hát rõ tiếng vào micro nhé!";
        } else if (liveJudgement.judgement === "perfect") {
          guidePillRef.current.textContent = "✨ Tuyệt vời! Chuẩn tông!";
        } else if (liveJudgement.judgement === "great") {
          guidePillRef.current.textContent = "🌟 Rất tốt!";
        } else if (liveJudgement.direction === "up") {
          guidePillRef.current.textContent = "↑ Hát cao hơn một chút";
        } else if (liveJudgement.direction === "down") {
          guidePillRef.current.textContent = "↓ Hát trầm hơn một chút";
        } else {
          guidePillRef.current.textContent = "Gần chuẩn rồi, giữ đều hơi!";
        }
      }
    };

    const tick = (wall: number) => {
      if (disposed) return;
      if (wall - lastDrawWall >= 14) {
        lastDrawWall = wall;
        drawFrame();
      }
      if (propsRef.current.playing || propsRef.current.listening) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    };

    drawFrame();
    if (playing || listening) {
      rafId = requestAnimationFrame(tick);
    }

    const unsubClock = subscribeClock?.((ms) => {
      if (!rafId && !disposed) {
        drawFrame(ms);
      }
    });

    const stopLoop = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stopLoop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("viread:android-background", stopLoop);

    return () => {
      disposed = true;
      stopLoop();
      unsubClock?.();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("viread:android-background", stopLoop);
    };
  }, [playing, listening, subscribeClock, targetNotes, keyShift, reducedMotion]);

  return (
    <div
      data-testid="karaoke-pitch-highway"
      className="relative overflow-hidden rounded-2xl border border-indigo-900/40 bg-[#0B162C] text-white shadow-md"
    >
      {/* Top Pro HUD Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-slate-950/60 px-3.5 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/25 px-2.5 py-0.5 font-extrabold text-sky-200">
            <Sparkles aria-hidden className="size-3.5 text-amber-300" />
            {hasReference
              ? "Biểu đồ tông giọng trực tiếp"
              : "Chưa có giai điệu mẫu — Cao độ trực tiếp của bé"}
          </span>
          {keyShift !== 0 && (
            <span className="rounded-full bg-amber-400/20 px-2 py-0.5 font-bold text-amber-200">
              Tông {keyShift > 0 ? `+${keyShift}` : keyShift} bán âm
            </span>
          )}
        </div>

        {/* Active pillars + live rolling score + combo + VU meter */}
        <div className="flex flex-wrap items-center gap-2">
          {scoredMode && (
            <>
              <div className="hidden items-center gap-1 sm:flex">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    hasReference
                      ? "bg-emerald-500/20 text-emerald-200"
                      : "bg-white/10 text-slate-300"
                  }`}
                >
                  {hasReference ? "✓ Tông" : "— Tông"}
                </span>
                <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[11px] font-bold text-sky-200">
                  ✓ Nhịp
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    sttAvailable
                      ? "bg-violet-500/20 text-violet-200"
                      : "bg-white/10 text-slate-300"
                  }`}
                >
                  {sttAvailable ? "✓ Lời" : "— Lời"}
                </span>
              </div>
              {hasReference && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-0.5 font-extrabold text-amber-200 tabular-nums">
                  Điểm tông:
                  <span ref={liveScoreTextRef}>--</span>
                </span>
              )}
              <span
                ref={comboBadgeRef}
                style={{ opacity: 0 }}
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-500 px-2 py-0.5 font-black text-slate-950 transition-opacity"
              >
                <Flame aria-hidden className="size-3.5" />
                <span ref={comboTextRef} />
              </span>
            </>
          )}
          <div
            aria-label="Mức âm lượng micro"
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-1"
          >
            <Mic
              aria-hidden
              className={`size-3.5 ${listening ? "text-emerald-300" : "text-slate-400"}`}
            />
            <div className="h-2 w-14 overflow-hidden rounded-full bg-slate-800">
              <div
                ref={vuBarRef}
                className="h-full w-0 rounded-full bg-gradient-to-r from-emerald-400 via-sky-400 to-amber-300 transition-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* 60fps HiDPI Pitch Highway Canvas */}
      <div className="relative h-44 w-full sm:h-52">
        <canvas
          ref={canvasRef}
          aria-label="Biểu đồ cao độ giọng hát trực tiếp"
          className="block size-full"
        />
        <span
          ref={guidePillRef}
          aria-live="off"
          data-testid="karaoke-pitch-guidance"
          className="pointer-events-none absolute right-2.5 bottom-2 rounded-full border border-white/15 bg-slate-950/75 px-3 py-1 text-xs font-extrabold text-sky-100 backdrop-blur-xs"
        >
          {hasReference
            ? "Nhìn thanh giai điệu chạy tới vạch vàng để hát đúng tông"
            : "Sẵn sàng thu cao độ trực tiếp của bé"}
        </span>
      </div>
    </div>
  );
});
