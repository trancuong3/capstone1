"use client";

import type { TargetNoteSpan } from "@/lib/karaoke/pro-karaoke-scoring";

const SOLFEGE_VI = [
  "Đô",
  "Đô#",
  "Rê",
  "Rê#",
  "Mi",
  "Pha",
  "Pha#",
  "Son",
  "Son#",
  "La",
  "La#",
  "Si",
] as const;

export type VocalRegisterVi = "Thấp" | "Vừa" | "Cao";
export type WarmupStepKey = "low" | "mid" | "high" | null;

export interface VietnameseSolfegeInfo {
  solfege: string;
  octave: number;
  labelVi: string;
  registerVi: VocalRegisterVi;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToVietnameseSolfege(midi: number): VietnameseSolfegeInfo {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  const solfege = SOLFEGE_VI[pc] ?? "Đô";
  const registerVi: VocalRegisterVi =
    rounded <= 62 ? "Thấp" : rounded <= 69 ? "Vừa" : "Cao";
  return {
    solfege,
    octave,
    labelVi: `${solfege} ${octave}`,
    registerVi,
  };
}

export interface ReferenceMelodySynth {
  syncPlayback: (params: {
    currentMs: number;
    targetNotes: readonly TargetNoteSpan[];
    keyShift: number;
    micListening: boolean;
    headphoneMode?: boolean;
    enabled: boolean;
  }) => void;
  playWarmupSequence: (
    keyShift: number,
    onStep?: (step: WarmupStepKey, labelVi: string | null) => void,
  ) => Promise<void>;
  resetCursor: () => void;
  stop: () => void;
  dispose: () => void;
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return typeof Ctor === "function" ? Ctor : null;
}

/**
 * Pure Web Audio API Reference Pitch / Interval Guide (`Âm quãng mẫu`).
 * Plays a gentle marimba-flute harmonic guide synced to `targetNotes` + `keyShift`,
 * plus a 3-step vocal warm-up (`Thấp -> Vừa -> Cao`) so primary schoolers can
 * tune their vocal pitch up and down comfortably.
 */
export function createReferenceMelodySynth(): ReferenceMelodySynth {
  let ctx: AudioContext | null = null;
  let lastTriggeredKey: string | null = null;
  let lastCurrentMs = -1;
  let warmupTimers: ReturnType<typeof setTimeout>[] = [];
  let activeNodes: { osc: OscillatorNode; gain: GainNode }[] = [];

  const ensureContext = (): AudioContext | null => {
    if (ctx && ctx.state !== "closed") {
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      return ctx;
    }
    const Ctor = getAudioContextConstructor();
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      return ctx;
    } catch {
      return null;
    }
  };

  const triggerGentleTone = (
    midi: number,
    durationMs: number,
    peakGain: number,
  ) => {
    const audioCtx = ensureContext();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const durSec = Math.max(0.16, Math.min(1.6, durationMs / 1000));
    const fundamentalHz = midiToHz(midi);

    try {
      const oscMain = audioCtx.createOscillator();
      const oscHarm = audioCtx.createOscillator();
      const gainMain = audioCtx.createGain();
      const gainHarm = audioCtx.createGain();

      oscMain.type = "triangle";
      oscMain.frequency.setValueAtTime(fundamentalHz, now);

      oscHarm.type = "sine";
      oscHarm.frequency.setValueAtTime(fundamentalHz * 2, now);

      gainMain.gain.setValueAtTime(0.0001, now);
      gainMain.gain.linearRampToValueAtTime(peakGain, now + 0.02);
      gainMain.gain.exponentialRampToValueAtTime(
        Math.max(0.0008, peakGain * 0.35),
        now + durSec * 0.7,
      );
      gainMain.gain.exponentialRampToValueAtTime(0.0001, now + durSec);

      gainHarm.gain.setValueAtTime(0.0001, now);
      gainHarm.gain.linearRampToValueAtTime(peakGain * 0.22, now + 0.015);
      gainHarm.gain.exponentialRampToValueAtTime(0.0001, now + durSec * 0.65);

      oscMain.connect(gainMain);
      gainMain.connect(audioCtx.destination);
      oscHarm.connect(gainHarm);
      gainHarm.connect(audioCtx.destination);

      oscMain.start(now);
      oscHarm.start(now);
      oscMain.stop(now + durSec + 0.03);
      oscHarm.stop(now + durSec + 0.03);

      const entryMain = { osc: oscMain, gain: gainMain };
      const entryHarm = { osc: oscHarm, gain: gainHarm };
      activeNodes.push(entryMain, entryHarm);
      oscMain.onended = () => {
        activeNodes = activeNodes.filter(
          (item) => item !== entryMain && item !== entryHarm,
        );
      };
    } catch {
      /* Ignore Web Audio scheduling errors on restricted devices. */
    }
  };

  const clearWarmupTimers = () => {
    for (const timer of warmupTimers) clearTimeout(timer);
    warmupTimers = [];
  };

  const stop = () => {
    clearWarmupTimers();
    lastTriggeredKey = null;
    for (const item of activeNodes) {
      try {
        item.osc.stop();
      } catch {
        /* Already stopped. */
      }
    }
    activeNodes = [];
  };

  return {
    syncPlayback({
      currentMs,
      targetNotes,
      keyShift,
      micListening,
      headphoneMode = false,
      enabled,
    }) {
      if (!enabled || targetNotes.length === 0) {
        lastTriggeredKey = null;
        return;
      }
      if (currentMs < lastCurrentMs - 150) {
        lastTriggeredKey = null;
      }
      lastCurrentMs = currentMs;

      // Look slightly ahead (+25ms) so child hears the reference pitch right on beat
      const probeMs = currentMs + 25;
      let activeNote: TargetNoteSpan | null = null;
      for (let i = 0; i < targetNotes.length; i++) {
        const note = targetNotes[i];
        if (probeMs >= note.startMs && probeMs < note.endMs) {
          activeNote = note;
          break;
        }
        if (note.startMs > probeMs) break;
      }
      if (!activeNote) return;

      const noteKey = `${activeNote.startMs}:${activeNote.midi}:${keyShift}`;
      if (noteKey === lastTriggeredKey) return;
      lastTriggeredKey = noteKey;

      // On loudspeaker with an open mic (`micListening && !headphoneMode`), play a crisp
      // 140ms marimba onset pluck at ultra-low gain (0.026) so the child hears the exact
      // starting pitch on beat while leaving >80% of the note span free of synthetic f0
      // energy — acoustically preventing open-mic speaker bleed from self-scoring Pitch.
      const isOpenSpeakerMic = micListening && !headphoneMode;
      const gain = isOpenSpeakerMic ? 0.026 : micListening ? 0.065 : 0.13;
      const durationMs = isOpenSpeakerMic
        ? 140
        : Math.max(180, activeNote.endMs - activeNote.startMs);
      triggerGentleTone(activeNote.midi + keyShift, durationMs, gain);
    },

    playWarmupSequence(keyShift, onStep) {
      stop();
      const steps: { step: Exclude<WarmupStepKey, null>; midi: number }[] = [
        { step: "low", midi: 60 + keyShift }, // Đô 4 (Thấp)
        { step: "mid", midi: 67 + keyShift }, // Son 4 (Vừa)
        { step: "high", midi: 72 + keyShift }, // Đô 5 (Cao)
      ];
      return new Promise<void>((resolve) => {
        steps.forEach((item, index) => {
          const t = setTimeout(() => {
            const info = midiToVietnameseSolfege(item.midi);
            onStep?.(item.step, `${info.registerVi} · ${info.labelVi}`);
            triggerGentleTone(item.midi, 820, 0.14);
          }, index * 950);
          warmupTimers.push(t);
        });
        const doneTimer = setTimeout(
          () => {
            onStep?.(null, null);
            warmupTimers = [];
            resolve();
          },
          steps.length * 950 + 250,
        );
        warmupTimers.push(doneTimer);
      });
    },

    resetCursor() {
      lastTriggeredKey = null;
      lastCurrentMs = -1;
    },

    stop,

    dispose() {
      stop();
      if (ctx && ctx.state !== "closed") {
        void ctx.close().catch(() => {});
      }
      ctx = null;
    },
  };
}
