export interface BrowserRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript?: string };
}

export interface BrowserRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserRecognitionResultLike>;
}

/**
 * Collects only final Web Speech API results. Result indexes are stable within
 * one recognition cycle, so repeated onresult callbacks replace a slot instead
 * of appending duplicate text.
 */
export class BrowserTranscriptCollector {
  private readonly currentCycle = new Map<number, string>();
  private readonly completedCycles: string[] = [];

  addResults(event: BrowserRecognitionEventLike): void {
    const start = Math.max(
      0,
      Number.isSafeInteger(event.resultIndex) ? event.resultIndex : 0,
    );

    for (let index = start; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result?.isFinal) continue;

      const text = result[0]?.transcript?.trim();
      if (text) this.currentCycle.set(index, text);
    }
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

/** Prefer the provider result for one capture, using actual browser final text
 * only when provider STT returned no usable transcript.
 */
export function resolveTranscriptForSegment(
  providerText: string | null | undefined,
  browserFinalText: string | null | undefined,
): string | null {
  const preferred = providerText?.trim();
  if (preferred) return preferred;
  const fallback = browserFinalText?.trim();
  return fallback || null;
}
