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
let sharedAudioElement: HTMLAudioElement | null = null;
let sharedAudioInUse = false;

export function isAndroidAudioUnlocked(): boolean {
  return unlocked;
}

/**
 * Borrow the persistent unlocked `<audio>` element on mobile / Android WebView so
 * async TTS fetches keep the user-gesture autoplay unlock across network delays.
 * Returns `null` if unavailable or already in use (caller creates a fresh `Audio`).
 */
export function acquireUnlockedAudioElement(): {
  readonly audio: HTMLAudioElement;
  readonly release: () => void;
} | null {
  if (!sharedAudioElement || sharedAudioInUse) return null;
  sharedAudioInUse = true;
  const audio = sharedAudioElement;
  let released = false;
  return {
    audio,
    release: () => {
      if (released) return;
      released = true;
      sharedAudioInUse = false;
    },
  };
}

export function unlockAudioNow(options?: { readonly force?: boolean }): void {
  if ((unlocked && !options?.force) || typeof window === "undefined") return;
  unlocked = true;
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
    installed = false;
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
        void ctx
          .resume()
          .catch(() => undefined)
          .finally(() => {
            void ctx.close().catch(() => undefined);
          });
      } else {
        void ctx.close().catch(() => undefined);
      }
    }
  } catch {
    // Ignore unsupported WebAudio environments
  }

  try {
    if (typeof document !== "undefined") {
      const probe = sharedAudioElement ?? document.createElement("audio");
      sharedAudioElement = probe;
      probe.src = SILENT_WAV_DATA_URI;
      probe.muted = true;
      probe.volume = 0;
      const playPromise = probe.play();
      if (playPromise && typeof playPromise.then === "function") {
        void playPromise
          .then(() => {
            if (!sharedAudioInUse) {
              probe.pause();
              probe.muted = false;
              probe.volume = 1;
              probe.src = "";
            }
          })
          .catch((error: unknown) => {
            if (!sharedAudioInUse) {
              probe.muted = false;
              probe.volume = 1;
              probe.src = "";
            }
            if (error instanceof Error && error.name === "NotAllowedError") {
              unlocked = false;
              installed = false;
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
    installed = false;
  };
}

export function resetAndroidAudioUnlockForTest(): void {
  cleanupListeners?.();
  cleanupListeners = null;
  installed = false;
  unlocked = false;
  sharedAudioElement = null;
  sharedAudioInUse = false;
}
