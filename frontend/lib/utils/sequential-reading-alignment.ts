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
    .toLocaleLowerCase("vi")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
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

  get currentWordId(): string | null {
    return this.tokens[this.cursorIndex]?.word_id ?? null;
  }

  /**
   * Interim recognition may preview only the uninterrupted sequence beginning
   * at the current cursor. It never mutates progress or token statuses.
   */
  previewInterim(transcript: string): InterimReadingPreview {
    let cursor = this.cursorIndex;
    const previewWordIds: string[] = [];
    let mismatchWordId: string | null = null;

    for (const spoken of transcriptTokens(transcript)) {
      const expected = this.tokens[cursor];
      if (!expected) break;
      if (normalizeReadingToken(expected.text) !== spoken) {
        mismatchWordId = expected.word_id;
        break;
      }
      previewWordIds.push(expected.word_id);
      cursor += 1;
    }

    return { previewWordIds, mismatchWordId };
  }

  /**
   * Commit one final transcript against the current cursor only. A mismatch
   * marks that exact occurrence for review and stops the utterance; later
   * occurrences are never searched or updated.
   */
  commitFinal(eventId: string, transcript: string): SequentialAlignmentSnapshot {
    const stableEventId = eventId.trim();
    if (!stableEventId || this.processedEventIds.has(stableEventId)) {
      return this.snapshot({ duplicate: true, matchedCount: 0 });
    }

    this.processedEventIds.add(stableEventId);
    let matchedCount = 0;
    let mismatchWordId: string | null = null;

    for (const spoken of transcriptTokens(transcript)) {
      const expected = this.tokens[this.cursorIndex];
      if (!expected) break;

      if (normalizeReadingToken(expected.text) !== spoken) {
        mismatchWordId = expected.word_id;
        this.needsReviewWordIds.add(expected.word_id);
        break;
      }

      const wasNeedsReview = this.needsReviewWordIds.delete(expected.word_id);
      this.correctWordIds.add(expected.word_id);
      if (wasNeedsReview) {
        this.reviewedWordIds.add(expected.word_id);
      }
      this.cursorIndex += 1;
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
      currentWordId: this.tokens[this.cursorIndex]?.word_id ?? null,
      complete: this.cursorIndex >= this.tokens.length,
      correctWordIds: new Set(this.correctWordIds),
      needsReviewWordIds: new Set(this.needsReviewWordIds),
      reviewedWordIds: new Set(this.reviewedWordIds),
      mismatchWordId: options.mismatchWordId ?? null,
      duplicate: options.duplicate,
      matchedCount: options.matchedCount,
    };
  }
}
