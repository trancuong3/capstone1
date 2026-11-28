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
let warmAudioContext: AudioContext | null = null;
let warmAudioResumePromise: Promise<void> | null = null;
let resumeListenersCleanup: (() => void) | null = null;

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

function ensureWarmAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (warmAudioContext && warmAudioContext.state !== "closed") {
      if (warmAudioContext.state === "suspended") {
        warmAudioResumePromise = Promise.resolve(
          warmAudioContext.resume(),
        ).then(
          () => undefined,
          () => undefined,
        );
      }
      return warmAudioContext;
    }
    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    warmAudioContext = ctx;
    warmAudioResumePromise =
      ctx.state === "suspended"
        ? Promise.resolve(ctx.resume()).then(
            () => undefined,
            () => undefined,
          )
        : null;
    return ctx;
  } catch {
    return null;
  }
}

function ensureAudioContextResumeListeners(): void {
  if (resumeListenersCleanup || typeof document === "undefined") return;
  const resumeOnGesture = () => {
    if (
      warmAudioContext &&
      warmAudioContext.state !== "closed" &&
      warmAudioContext.state === "suspended"
    ) {
      void warmAudioContext.resume().catch(() => undefined);
    }
  };
  document.addEventListener("pointerdown", resumeOnGesture, { passive: true });
  document.addEventListener("touchstart", resumeOnGesture, { passive: true });
  document.addEventListener("keydown", resumeOnGesture, { passive: true });
  resumeListenersCleanup = () => {
    document.removeEventListener("pointerdown", resumeOnGesture);
    document.removeEventListener("touchstart", resumeOnGesture);
    document.removeEventListener("keydown", resumeOnGesture);
    resumeListenersCleanup = null;
  };
}

/**
 * Returns the persistent warm singleton `AudioContext` created/resumed during
 * user gesture unlock so async mic/TTS flows on iOS Safari & Android Chrome
 * do not stall on a newly created suspended `AudioContext`.
 */
export function getWarmAudioContext(): AudioContext | null {
  if (!warmAudioContext || warmAudioContext.state === "closed") {
    return null;
  }
  if (warmAudioContext.state === "suspended") {
    void warmAudioContext.resume().catch(() => undefined);
  }
  return warmAudioContext;
}

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
  if (typeof window === "undefined") return;
  // Always resume the persistent warm AudioContext on user gesture even if
  // HTMLAudio was already unlocked earlier (e.g. after tab/app backgrounding).
  ensureWarmAudioContext();
  ensureAudioContextResumeListeners();
  if (unlocked && !options?.force) return;
  unlocked = true;
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
    installed = false;
  }

  try {
    if (typeof document !== "undefined" && !sharedAudioInUse) {
      const probe = sharedAudioElement ?? document.createElement("audio");
      sharedAudioElement = probe;
      probe.src = SILENT_WAV_DATA_URI;
      probe.muted = true;
      probe.volume = 0;
      const playPromise = probe.play();
      if (playPromise && typeof playPromise.then === "function") {
        void playPromise
          .then(() => {
            // Never interrupt a real TTS playback that acquired `sharedAudioElement`
            // while the silent unlock probe was still settling.
            if (sharedAudioInUse) return;
            probe.pause();
            probe.muted = false;
            probe.volume = 1;
            probe.src = "";
          })
          .catch((error: unknown) => {
            if (!sharedAudioInUse) {
              probe.muted = false;
              probe.volume = 1;
              probe.src = "";
            }
            if (
              !sharedAudioInUse &&
              error instanceof Error &&
              error.name === "NotAllowedError"
            ) {
              const failedCtx = warmAudioContext;
              const pendingResume = warmAudioResumePromise;
              warmAudioContext = null;
              warmAudioResumePromise = null;
              if (failedCtx && failedCtx.state !== "closed") {
                void (pendingResume ?? Promise.resolve()).finally(() => {
                  try {
                    void failedCtx.close?.().catch(() => undefined);
                  } catch {
                    // Ignore mock AudioContext close errors
                  }
                });
              }
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
  resumeListenersCleanup?.();
  resumeListenersCleanup = null;
  installed = false;
  unlocked = false;
  sharedAudioElement = null;
  sharedAudioInUse = false;
  warmAudioResumePromise = null;
  if (warmAudioContext) {
    try {
      void warmAudioContext.close?.().catch(() => undefined);
    } catch {
      // Ignore mock AudioContext close errors in tests
    }
    warmAudioContext = null;
  }
}
