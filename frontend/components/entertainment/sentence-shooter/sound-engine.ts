export type ShooterSoundKind = "shot" | "correct" | "wrong" | "celebrate";

const SOUND_FREQUENCIES: Record<ShooterSoundKind, readonly number[]> = {
  shot: [520],
  correct: [660, 880],
  wrong: [300],
  celebrate: [660, 784, 988],
};

let sharedAudioContext: AudioContext | null = null;

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const candidate =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return typeof candidate === "function" ? candidate : null;
}

function getOrCreateAudioContext(): AudioContext | null {
  if (sharedAudioContext && sharedAudioContext.state !== "closed") {
    return sharedAudioContext;
  }
  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) return null;
  try {
    sharedAudioContext = new AudioContextCtor();
    return sharedAudioContext;
  } catch {
    return null;
  }
}

export function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Plays a lightweight Web Audio SFX using a single lazily initialized singleton
 * AudioContext reused across all shots (zero per-shot AudioContext allocations).
 */
export function playShooterSound(
  kind: ShooterSoundKind,
  enabled: boolean,
): void {
  if (!enabled) return;
  const context = getOrCreateAudioContext();
  if (!context) return;

  try {
    if (context.state === "suspended" && typeof context.resume === "function") {
      void Promise.resolve(context.resume()).catch(() => undefined);
    }

    const notes = SOUND_FREQUENCIES[kind];
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = kind === "wrong" ? "triangle" : "sine";
    notes.forEach((freq, idx) => {
      oscillator.frequency.setValueAtTime(freq, now + idx * 0.09);
    });

    const peakGain = prefersReducedMotion() ? 0.035 : 0.055;
    const duration = notes.length > 1 ? 0.34 : 0.16;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
    oscillator.onended = () => {
      try {
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        // Ignore already-disconnected audio nodes.
      }
    };
  } catch {
    // Sound is strictly optional; audio restrictions must never disrupt a shot.
  }
}

/**
 * Suspends the singleton AudioContext (used on Android backgrounding or tab hide).
 */
export function suspendShooterAudio(): void {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") return;
  try {
    if (
      sharedAudioContext.state === "running" &&
      typeof sharedAudioContext.suspend === "function"
    ) {
      void Promise.resolve(sharedAudioContext.suspend()).catch(() => undefined);
    }
  } catch {
    // Best-effort suspend.
  }
}

/**
 * Closes and clears the singleton AudioContext on teardown/unmount.
 */
export function disposeShooterAudio(): void {
  const ctx = sharedAudioContext;
  sharedAudioContext = null;
  if (!ctx || ctx.state === "closed") return;
  try {
    if (typeof ctx.close === "function") {
      void Promise.resolve(ctx.close()).catch(() => undefined);
    }
  } catch {
    // Best-effort close.
  }
}
