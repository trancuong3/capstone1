import { hasUsableBrowserConfidence } from "@/lib/reading/recognition-evidence";

export interface BrowserRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript?: string; readonly confidence?: number };
}

export interface BrowserRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserRecognitionResultLike>;
}

/**
 * Collects only final Web Speech API results. Result indexes are stable within
 * one recognition cycle. Once emitted, a final slot is immutable so persisted
 * fallback text cannot diverge from the tokens already consumed by alignment.
 */
export class BrowserTranscriptCollector {
  private readonly currentCycle = new Map<number, string>();
  private readonly completedCycles: string[] = [];

  addResults(event: BrowserRecognitionEventLike): string[] {
    const newFinals: string[] = [];
    const start = Math.max(
      0,
      Number.isSafeInteger(event.resultIndex) ? event.resultIndex : 0,
    );

    for (let index = start; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (
        !result?.isFinal ||
        !hasUsableBrowserConfidence(result[0]?.confidence)
      )
        continue;

      const text = result[0]?.transcript?.trim();
      if (text && !this.currentCycle.has(index)) {
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
