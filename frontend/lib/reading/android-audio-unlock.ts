/**
 * Idempotent first-gesture WebAudio / HTMLAudio unlocker for Android WebView & mobile browsers.
 *
 * Ensures server-synthesized Vietnamese TTS (`HTMLAudioElement`) and Karaoke backing tracks
 * play reliably even when network synthesis finishes asynchronously after the user's tap.
 */

const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let installed = false;
let unlocked = false;
let cleanupListeners: (() => void) | null = null;

export function isAndroidAudioUnlocked(): boolean {
  return unlocked;
}

export function unlockAudioNow(options?: { readonly force?: boolean }): void {
  if ((unlocked && !options?.force) || typeof window === "undefined") return;
  unlocked = true;
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
  }

  try {
    const win = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioCtx = win.AudioContext ?? win.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => undefined);
      }
      void ctx.close().catch(() => undefined);
    }
  } catch {
    // Ignore unsupported WebAudio environments
  }

  try {
    if (typeof document !== "undefined") {
      const probe = document.createElement("audio");
      probe.src = SILENT_WAV_DATA_URI;
      probe.muted = true;
      probe.volume = 0;
      const playPromise = probe.play();
      if (playPromise && typeof playPromise.then === "function") {
        void playPromise
          .then(() => {
            probe.pause();
            probe.src = "";
          })
          .catch((error: unknown) => {
            probe.src = "";
            if (error instanceof Error && error.name === "NotAllowedError") {
              unlocked = false;
              installAndroidAudioUnlock();
            }
          });
      }
    }
  } catch {
    // Ignore restricted test/headless audio stubs
  }
}

export function installAndroidAudioUnlock(): void {
  if (installed || unlocked || typeof document === "undefined") return;
  installed = true;

  const handler = () => {
    unlockAudioNow();
  };

  document.addEventListener("pointerdown", handler, { passive: true });
  document.addEventListener("touchstart", handler, { passive: true });
  document.addEventListener("keydown", handler, { passive: true });

  cleanupListeners = () => {
    document.removeEventListener("pointerdown", handler);
    document.removeEventListener("touchstart", handler);
    document.removeEventListener("keydown", handler);
  };
}

export function resetAndroidAudioUnlockForTest(): void {
  cleanupListeners?.();
  cleanupListeners = null;
  installed = false;
  unlocked = false;
}
