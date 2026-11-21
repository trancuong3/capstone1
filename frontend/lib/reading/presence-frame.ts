import type { FrameQuality } from "@/lib/reading/presence-monitor";

/**
 * Numbers computed from one camera frame, on the device. The pixels are read
 * once here and are never stored, returned or sent anywhere: only brightness,
 * contrast and motion leave this module.
 */
export interface FrameStats {
  readonly meanLuma: number;
  readonly lumaStd: number;
  /** Share of pixels that changed noticeably since the previous frame (0..1). */
  readonly motion: number;
  /** Luma plane kept only to compare with the next frame; stays in memory. */
  readonly luma: Uint8Array;
}

/** Pixel is "changed" when its luma moved by more than this (sensor noise is ~2). */
const CHANGED_LUMA = 20;
const DARK_MEAN = 20;
const FLAT_STD = 8;

export function analyzeFrame(
  rgba: Uint8ClampedArray,
  previousLuma: Uint8Array | null,
): FrameStats {
  const pixels = Math.floor(rgba.length / 4);
  const luma = new Uint8Array(pixels);
  let sum = 0;
  for (let i = 0; i < pixels; i += 1) {
    const value = Math.round(
      0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2],
    );
    luma[i] = value;
    sum += value;
  }
  const mean = pixels ? sum / pixels : 0;
  let variance = 0;
  let changed = 0;
  for (let i = 0; i < pixels; i += 1) {
    variance += (luma[i] - mean) ** 2;
    if (previousLuma && previousLuma.length === pixels) {
      if (Math.abs(luma[i] - previousLuma[i]) > CHANGED_LUMA) changed += 1;
    }
  }
  return {
    meanLuma: mean,
    lumaStd: pixels ? Math.sqrt(variance / pixels) : 0,
    motion:
      previousLuma && previousLuma.length === pixels && pixels
        ? changed / pixels
        : 0,
    luma,
  };
}

/** `faceCount` is null when the browser has no face detector. */
export function classifyFrame(
  stats: Pick<FrameStats, "meanLuma" | "lumaStd">,
  faceCount: number | null,
): { quality: FrameQuality; faceCount: number | null } {
  if (stats.meanLuma < DARK_MEAN) return { quality: "dark", faceCount };
  if (stats.lumaStd < FLAT_STD) return { quality: "covered", faceCount };
  if (faceCount === null) return { quality: "unsupported", faceCount: null };
  return { quality: "ok", faceCount };
}
