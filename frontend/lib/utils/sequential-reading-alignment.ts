/**
 * Position-based alignment for a single verified page revision.
 *
 * Word text is comparison data only. Stable word IDs and the ordered token array
 * determine which occurrence is updated.
 */

export interface SequentialReadingToken {
  readonly word_id: string;
  readonly text: string;
}

export interface SequentialAlignmentSnapshot {
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly cursorIndex: number;
  readonly currentWordId: string | null;
  readonly complete: boolean;
  readonly correctWordIds: ReadonlySet<string>;
  readonly needsReviewWordIds: ReadonlySet<string>;
  readonly reviewedWordIds: ReadonlySet<string>;
  readonly mismatchWordId: string | null;
  readonly duplicate: boolean;
  readonly matchedCount: number;
}

export interface InterimReadingPreview {
  readonly previewWordIds: readonly string[];
  readonly mismatchWordId: string | null;
}

export function normalizeReadingToken(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("vi")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .trim();
}

function transcriptTokens(transcript: string): string[] {
  return transcript
    .normalize("NFC")
    .trim()
    .split(/\s+/u)
    .map(normalizeReadingToken)
    .filter(Boolean);
}

export class SequentialReadingTracker {
  readonly pageId: string;
  readonly pageRevisionId: string;
  private readonly tokens: readonly SequentialReadingToken[];
  private cursorIndex = 0;
  private readonly processedEventIds = new Set<string>();
  private readonly correctWordIds = new Set<string>();
  private readonly needsReviewWordIds = new Set<string>();
  private readonly reviewedWordIds = new Set<string>();

  constructor(
    pageId: string,
    pageRevisionId: string,
    tokens: readonly SequentialReadingToken[],
  ) {
    this.pageId = pageId;
    this.pageRevisionId = pageRevisionId;
    this.tokens = [...tokens];
  }

  /**
   * The first pass always takes priority. After it reaches the end, the cursor
   * points to the earliest missed occurrence in original reading order.
   */
  get currentWordId(): string | null {
    if (this.cursorIndex < this.tokens.length) {
      return this.tokens[this.cursorIndex]?.word_id ?? null;
    }
    return (
      this.tokens.find((token) => this.needsReviewWordIds.has(token.word_id))
        ?.word_id ?? null
    );
  }

  get isReviewing(): boolean {
    return this.cursorIndex >= this.tokens.length &&
      this.needsReviewWordIds.size > 0;
  }

  /**
   * Completion includes the correction phase, not just reaching the final token
   * on the initial pass.
   */
  get complete(): boolean {
    return this.cursorIndex >= this.tokens.length &&
      this.needsReviewWordIds.size === 0;
  }

  /**
   * Interim recognition previews only the next expected sequence and never
   * mutates permanent token state or the reading cursor.
   */
  previewInterim(transcript: string): InterimReadingPreview {
    const expectedTokens =
      this.cursorIndex < this.tokens.length
        ? this.tokens.slice(this.cursorIndex)
        : this.tokens.filter((token) =>
            this.needsReviewWordIds.has(token.word_id),
          );
    const previewWordIds: string[] = [];
    let mismatchWordId: string | null = null;

    for (const [index, spoken] of transcriptTokens(transcript).entries()) {
      const expected = expectedTokens[index];
      if (!expected) break;
      if (normalizeReadingToken(expected.text) !== spoken) {
        mismatchWordId = expected.word_id;
        break;
      }
      previewWordIds.push(expected.word_id);
    }

    return { previewWordIds, mismatchWordId };
  }

  /**
   * Final transcript tokens are consumed in order from the current position.
   * During the initial pass, a mismatch marks that exact occurrence for later
   * review and the next recognized token is compared with the next position.
   * After the pass, only pending review occurrences can be corrected.
   */
  commitFinal(
    eventId: string,
    transcript: string,
  ): SequentialAlignmentSnapshot {
    const stableEventId = eventId.trim();
    if (!stableEventId || this.processedEventIds.has(stableEventId)) {
      return this.snapshot({ duplicate: true, matchedCount: 0 });
    }

    this.processedEventIds.add(stableEventId);
    const correctionPhaseAtStart = this.isReviewing;
    let matchedCount = 0;
    let mismatchWordId: string | null = null;

    for (const spoken of transcriptTokens(transcript)) {
      if (this.cursorIndex < this.tokens.length) {
        const expected = this.tokens[this.cursorIndex];
        const matches =
          normalizeReadingToken(expected.text) === spoken;

        if (matches) {
          this.correctWordIds.add(expected.word_id);
        } else {
          this.correctWordIds.delete(expected.word_id);
          this.needsReviewWordIds.add(expected.word_id);
          mismatchWordId = expected.word_id;
        }

        if (matches) matchedCount += 1;
        this.cursorIndex += 1;

        // Do not reinterpret trailing words from this first-pass utterance as
        // correction attempts. The correction phase starts with a new utterance.
        if (this.cursorIndex >= this.tokens.length) break;
        continue;
      }

      if (!correctionPhaseAtStart) break;

      const expected = this.tokens.find((token) =>
        this.needsReviewWordIds.has(token.word_id),
      );
      if (!expected) break;

      if (normalizeReadingToken(expected.text) !== spoken) {
        mismatchWordId = expected.word_id;
        break;
      }

      this.needsReviewWordIds.delete(expected.word_id);
      this.correctWordIds.add(expected.word_id);
      this.reviewedWordIds.add(expected.word_id);
      matchedCount += 1;
    }

    return this.snapshot({ duplicate: false, mismatchWordId, matchedCount });
  }

  private snapshot(options: {
    duplicate: boolean;
    mismatchWordId?: string | null;
    matchedCount: number;
  }): SequentialAlignmentSnapshot {
    return {
      pageId: this.pageId,
      pageRevisionId: this.pageRevisionId,
      cursorIndex: this.cursorIndex,
      currentWordId: this.currentWordId,
      complete: this.complete,
      correctWordIds: new Set(this.correctWordIds),
      needsReviewWordIds: new Set(this.needsReviewWordIds),
      reviewedWordIds: new Set(this.reviewedWordIds),
      mismatchWordId: options.mismatchWordId ?? null,
      duplicate: options.duplicate,
      matchedCount: options.matchedCount,
    };
  }
}
