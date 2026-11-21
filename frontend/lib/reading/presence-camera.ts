import {
  analyzeFrame,
  classifyFrame,
  type FrameStats,
} from "@/lib/reading/presence-frame";
import type { PresenceSample } from "@/lib/reading/presence-monitor";

/**
 * Low-rate, on-device camera sampling for the presence check. It never records,
 * stores or uploads frames: each tick reduces a tiny frame to a handful of
 * numbers (see presence-frame) and drops the pixels.
 */
export interface PresenceSampleSource {
  start(onSample: (sample: PresenceSample) => void): Promise<StartResult>;
  stop(): void;
}

export type StartResult = "started" | "denied" | "unavailable";

interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<readonly unknown[]>;
}
interface FaceDetectorConstructor {
  new (options?: {
    fastMode?: boolean;
    maxDetectedFaces?: number;
  }): FaceDetectorLike;
}

export interface CameraSourceOptions {
  /** Prompt for the camera if it was never decided. Off by default. */
  readonly allowPrompt?: boolean;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

const WIDTH = 160;
const HEIGHT = 120;

/** True only if the camera is ALREADY granted; never triggers a prompt. */
export async function isCameraAlreadyGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({
      name: "camera" as PermissionName,
    });
    return status?.state === "granted";
  } catch {
    return false;
  }
}

export function createCameraPresenceSource(
  options: CameraSourceOptions = {},
): PresenceSampleSource {
  const intervalMs = options.intervalMs ?? 1000;
  const now = options.now ?? (() => performance.now());
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let previous: FrameStats | null = null;
  let generation = 0;

  function release() {
    generation += 1;
    if (timer !== null) clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    video = null;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    canvas = null;
    previous = null;
  }

  return {
    async start(onSample) {
      release();
      const mine = generation;
      if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
      if (!options.allowPrompt && !(await isCameraAlreadyGranted())) {
        return "denied";
      }
      let acquired: MediaStream;
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: WIDTH },
            height: { ideal: HEIGHT },
          },
          audio: false,
        });
      } catch {
        return "denied";
      }
      if (mine !== generation) {
        // Stopped while the browser was asking: release at once.
        acquired.getTracks().forEach((track) => track.stop());
        return "unavailable";
      }
      stream = acquired;
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = acquired;
      canvas = document.createElement("canvas");
      canvas.width = 80;
      canvas.height = 60;
      try {
        await video.play();
      } catch {
        // Autoplay can be refused; frames may still arrive on some browsers.
      }
      const Detector = (
        globalThis as { FaceDetector?: FaceDetectorConstructor }
      ).FaceDetector;
      const detector = Detector
        ? new Detector({ fastMode: true, maxDetectedFaces: 2 })
        : null;

      acquired.getVideoTracks()[0]?.addEventListener(
        "ended",
        () => {
          if (mine !== generation) return;
          onSample({ at: now(), faceCount: null, quality: "error", motion: 0 });
          release();
        },
        { once: true },
      );

      timer = setInterval(() => {
        if (mine !== generation || !video || !canvas) return;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || video.readyState < 2) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const { data } = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const stats = analyzeFrame(data, previous?.luma ?? null);
        previous = stats;
        const finish = (faceCount: number | null, failed = false) => {
          if (mine !== generation) return;
          const classified = classifyFrame(stats, faceCount);
          onSample({
            at: now(),
            faceCount: classified.faceCount,
            quality: failed ? "error" : classified.quality,
            motion: stats.motion,
          });
        };
        if (!detector || !video) {
          finish(null);
          return;
        }
        detector.detect(video).then(
          (faces) => finish(faces.length),
          () => finish(null, true),
        );
      }, intervalMs);
      return "started";
    },
    stop: release,
  };
}
