import { hasUsableBrowserConfidence } from "@/lib/reading/recognition-evidence";

export interface SegmentAudioQualityMeta {
  readonly status: "OK" | "LOW_VOLUME" | "CLIPPING" | "AUDIO_TOO_SHORT";
  readonly rms: number;
  readonly peak: number;
  readonly speechDurationMs: number;
}

export interface SegmentResultMeta {
  readonly epoch?: number;
  readonly sessionId?: string | null;
  readonly pageId?: string | null;
  readonly turnId?: string;
  readonly segmentId?: string;
  readonly onsetAt?: number | null;
  readonly audioEndedAt?: number | null;
  readonly speechDurationMs?: number | null;
  readonly audioQuality?: SegmentAudioQualityMeta;
}

export interface BrowserRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript?: string; readonly confidence?: number };
  readonly epoch?: number;
  readonly sessionId?: string | null;
  readonly pageId?: string | null;
  readonly turnId?: string;
  readonly segmentId?: string;
  readonly onsetAt?: number | null;
  readonly audioEndedAt?: number | null;
  readonly speechDurationMs?: number | null;
  readonly audioQuality?: SegmentAudioQualityMeta;
}

export interface BrowserRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserRecognitionResultLike>;
}

export function extractSegmentResultMeta(
  result: BrowserRecognitionResultLike | undefined,
): SegmentResultMeta | undefined {
  if (!result) return undefined;
  const hasMeta =
    result.epoch !== undefined ||
    result.sessionId !== undefined ||
    result.pageId !== undefined ||
    result.turnId !== undefined ||
    result.segmentId !== undefined ||
    result.onsetAt !== undefined ||
    result.audioEndedAt !== undefined ||
    result.speechDurationMs !== undefined ||
    result.audioQuality !== undefined;
  if (!hasMeta) return undefined;
  return {
    epoch: result.epoch,
    sessionId: result.sessionId,
    pageId: result.pageId,
    turnId: result.turnId,
    segmentId: result.segmentId,
    onsetAt: result.onsetAt,
    audioEndedAt: result.audioEndedAt,
    speechDurationMs: result.speechDurationMs,
    audioQuality: result.audioQuality,
  };
}

/**
 * Collects only final Web Speech API results. Result indexes are stable within
 * one recognition cycle. Once emitted, a final slot is immutable so persisted
 * fallback text cannot diverge from the tokens already consumed by alignment.
 */
export class BrowserTranscriptCollector {
  private readonly currentCycle = new Map<number, string>();
  private readonly completedCycles: string[] = [];

  addResults(
    event: BrowserRecognitionEventLike,
    acceptFinal?: (
      text: string,
      usable: boolean,
      confidence?: number,
      meta?: SegmentResultMeta,
    ) => boolean,
  ): string[] {
    const newFinals: string[] = [];
    const start = Math.max(
      0,
      Number.isSafeInteger(event.resultIndex) ? event.resultIndex : 0,
    );

    for (let index = start; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result?.isFinal || this.currentCycle.has(index)) continue;
      const text = result[0]?.transcript?.trim();
      if (text) {
        const confidence = result[0]?.confidence;
        const usable = hasUsableBrowserConfidence(confidence);
        const meta = extractSegmentResultMeta(result);
        const accept = acceptFinal
          ? acceptFinal(text, usable, confidence, meta)
          : usable;
        if (!accept) {
          // A discarded command or uncertain final still occupies its slot.
          this.currentCycle.set(index, "");
          continue;
        }
        newFinals.push(text);
        this.currentCycle.set(index, text);
      }
    }

    return newFinals;
  }

  completeRecognitionCycle(): void {
    const text = [...this.currentCycle.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join(" ")
      .trim();

    if (text) this.completedCycles.push(text);
    this.currentCycle.clear();
  }

  getTranscript(): string {
    const pending = [...this.currentCycle.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join(" ");

    return [...this.completedCycles, pending]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  reset(): void {
    this.currentCycle.clear();
    this.completedCycles.length = 0;
  }
}

/** Keep the final text already consumed by live alignment as this capture's
 * assessment source. Provider speech is used only without browser finals;
 * replacing an aligned capture would split retry and persisted assessment.
 */
export function resolveTranscriptForSegment(
  providerText: string | null | undefined,
  browserFinalText: string | null | undefined,
): string | null {
  const preferred = browserFinalText?.trim();
  if (preferred) return preferred;
  const fallback = providerText?.trim();
  return fallback || null;
}
