/**
 * Position-based alignment for a single verified page revision.
 *
 * Text is comparison data only. Stable word IDs and ordered token positions
 * decide which occurrence can receive a reading status.
 */

export interface SequentialReadingToken {
  readonly word_id: string;
  readonly text: string;
}

export interface RecognitionWordEvidence {
  readonly text: string;
  /** Scribe v2 log probability. Missing evidence must never be treated as certainty. */
  readonly logprob?: number | null;
}

export type SequentialReviewReason =
  | "CONFIDENTLY_INCORRECT"
  | "UNCERTAIN"
  | "NO_SPEECH";

export interface SequentialReviewCandidate {
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly wordId: string;
  readonly wordIndex: number;
  readonly expectedWord: string;
  readonly recognizedWord: string | null;
  readonly logprob: number | null;
  readonly confidence: number | null;
  readonly occurredAtMs: number;
  readonly reason: SequentialReviewReason;
}

export interface SequentialAlignmentSnapshot {
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly cursorIndex: number;
  readonly currentWordId: string | null;
  readonly complete: boolean;
  readonly correctWordIds: ReadonlySet<string>;
  readonly needsReviewWordIds: ReadonlySet<string>;
  readonly uncertainWordIds: ReadonlySet<string>;
  readonly reviewedWordIds: ReadonlySet<string>;
  readonly mismatchWordId: string | null;
  readonly duplicate: boolean;
  readonly matchedCount: number;
}

export interface InterimReadingPreview {
  readonly previewWordIds: readonly string[];
  readonly mismatchWordId: string | null;
}

export interface SequentialReadingTrackerOptions {
  /**
   * Session mode defers all corrections until the selected reading range ends.
   * The default preserves the PROMPT 1 single-page tracker behavior for callers
   * and existing unit tests.
   */
  readonly deferReviewUntilSessionEnd?: boolean;
  /** Probability threshold derived from Scribe word logprob; null means unknown. */
  readonly minWordConfidence?: number | null;
  /** Fail closed when no calibrated project threshold is configured. */
  readonly requireWordConfidence?: boolean;
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

function wordConfidence(logprob: number | null | undefined): number | null {
  if (typeof logprob !== "number" || !Number.isFinite(logprob)) return null;
  const value = Math.exp(logprob);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export class SequentialReadingTracker {
  readonly pageId: string;
  readonly pageRevisionId: string;
  private readonly tokens: readonly SequentialReadingToken[];
  private readonly options: Required<SequentialReadingTrackerOptions>;
  private cursorIndex = 0;
  private readonly processedEventIds = new Set<string>();
  private readonly correctWordIds = new Set<string>();
  private readonly needsReviewWordIds = new Set<string>();
  private readonly uncertainWordIds = new Set<string>();
  private readonly reviewedWordIds = new Set<string>();
  private readonly reviewCandidates = new Map<string, SequentialReviewCandidate>();

  constructor(
    pageId: string,
    pageRevisionId: string,
    tokens: readonly SequentialReadingToken[],
    options: SequentialReadingTrackerOptions = {},
  ) {
    this.pageId = pageId;
    this.pageRevisionId = pageRevisionId;
    this.tokens = [...tokens];
    this.options = {
      deferReviewUntilSessionEnd: options.deferReviewUntilSessionEnd ?? false,
      minWordConfidence: options.minWordConfidence ?? null,
      requireWordConfidence: options.requireWordConfidence ?? false,
    };
  }

  /** During session mode the first-pass cursor never jumps backwards into review. */
  get currentWordId(): string | null {
    if (this.cursorIndex < this.tokens.length) {
      return this.tokens[this.cursorIndex]?.word_id ?? null;
    }
    if (this.options.deferReviewUntilSessionEnd) return null;
    return (
      this.tokens.find((token) => this.needsReviewWordIds.has(token.word_id))
        ?.word_id ?? null
    );
  }

  get isReviewing(): boolean {
    return (
      !this.options.deferReviewUntilSessionEnd &&
      this.cursorIndex >= this.tokens.length &&
      this.needsReviewWordIds.size > 0
    );
  }

  /** In session mode, complete means the normal pass on this page has ended. */
  get complete(): boolean {
    if (this.options.deferReviewUntilSessionEnd) {
      return this.cursorIndex >= this.tokens.length;
    }
    return (
      this.cursorIndex >= this.tokens.length &&
      this.needsReviewWordIds.size === 0
    );
  }

  getReviewCandidates(): readonly SequentialReviewCandidate[] {
    return [...this.reviewCandidates.values()].sort(
      (left, right) => left.wordIndex - right.wordIndex,
    );
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
   * Final words are consumed strictly from the current position. In strict
   * confidence mode, matches without a calibrated per-word confidence threshold
   * remain UNCERTAIN and are never colored CORRECT.
   */
  commitFinal(
    eventId: string,
    transcript: string,
    evidenceWords?: readonly RecognitionWordEvidence[] | null,
  ): SequentialAlignmentSnapshot {
    const stableEventId = eventId.trim();
    if (!stableEventId || this.processedEventIds.has(stableEventId)) {
      return this.snapshot({ duplicate: true, matchedCount: 0 });
    }

    this.processedEventIds.add(stableEventId);
    const correctionPhaseAtStart = this.isReviewing;
    const spokenTokens = transcriptTokens(transcript);
    const evidence = this.alignEvidence(spokenTokens, evidenceWords);
    let matchedCount = 0;
    let mismatchWordId: string | null = null;

    for (let index = 0; index < spokenTokens.length; index += 1) {
      const spoken = spokenTokens[index];
      if (this.cursorIndex < this.tokens.length) {
        const expected = this.tokens[this.cursorIndex];
        const matches = normalizeReadingToken(expected.text) === spoken;
        const wordEvidence = evidence[index];
        const confidence = wordConfidence(wordEvidence?.logprob);
        const confident =
          !this.options.requireWordConfidence ||
          (confidence !== null &&
            this.options.minWordConfidence !== null &&
            confidence >= this.options.minWordConfidence);

        this.correctWordIds.delete(expected.word_id);
        this.needsReviewWordIds.delete(expected.word_id);
        this.uncertainWordIds.delete(expected.word_id);
        this.reviewCandidates.delete(expected.word_id);

        if (!confident) {
          this.uncertainWordIds.add(expected.word_id);
          this.reviewCandidates.set(
            expected.word_id,
            this.createCandidate(
              expected,
              this.cursorIndex,
              spoken,
              wordEvidence?.logprob ?? null,
              "UNCERTAIN",
            ),
          );
        } else if (matches) {
          this.correctWordIds.add(expected.word_id);
          matchedCount += 1;
        } else {
          this.needsReviewWordIds.add(expected.word_id);
          mismatchWordId = expected.word_id;
          this.reviewCandidates.set(
            expected.word_id,
            this.createCandidate(
              expected,
              this.cursorIndex,
              spoken,
              wordEvidence?.logprob ?? null,
              "CONFIDENTLY_INCORRECT",
            ),
          );
        }

        this.cursorIndex += 1;

        if (
          this.cursorIndex >= this.tokens.length &&
          this.options.deferReviewUntilSessionEnd
        ) {
          break;
        }
        continue;
      }

      if (this.options.deferReviewUntilSessionEnd || !correctionPhaseAtStart) {
        break;
      }

      const expected = this.tokens.find((token) =>
        this.needsReviewWordIds.has(token.word_id),
      );
      if (!expected) break;

      const expectedIndex = this.tokens.findIndex(
        (token) => token.word_id === expected.word_id,
      );
      const wordEvidence = evidence[index];
      const confidence = wordConfidence(wordEvidence?.logprob);
      const confident =
        !this.options.requireWordConfidence ||
        (confidence !== null &&
          this.options.minWordConfidence !== null &&
          confidence >= this.options.minWordConfidence);
      if (!confident) {
        this.uncertainWordIds.add(expected.word_id);
        this.reviewCandidates.set(
          expected.word_id,
          this.createCandidate(
            expected,
            expectedIndex,
            spoken,
            wordEvidence?.logprob ?? null,
            "UNCERTAIN",
          ),
        );
        break;
      }
      if (normalizeReadingToken(expected.text) !== spoken) {
        mismatchWordId = expected.word_id;
        break;
      }

      this.needsReviewWordIds.delete(expected.word_id);
      this.correctWordIds.add(expected.word_id);
      this.reviewedWordIds.add(expected.word_id);
      this.reviewCandidates.delete(expected.word_id);
      matchedCount += 1;
    }

    return this.snapshot({ duplicate: false, mismatchWordId, matchedCount });
  }

  /** Empty/noisy segments are uncertain, never confirmed pronunciation errors. */
  markNoSpeech(
    eventId: string,
    reason: "NO_SPEECH" | "UNCERTAIN" = "NO_SPEECH",
  ): SequentialAlignmentSnapshot {
    const stableEventId = eventId.trim();
    if (!stableEventId || this.processedEventIds.has(stableEventId)) {
      return this.snapshot({ duplicate: true, matchedCount: 0 });
    }
    this.processedEventIds.add(stableEventId);
    const expected = this.tokens[this.cursorIndex];
    if (expected) {
      this.correctWordIds.delete(expected.word_id);
      this.needsReviewWordIds.delete(expected.word_id);
      this.uncertainWordIds.add(expected.word_id);
      this.reviewCandidates.set(
        expected.word_id,
        this.createCandidate(
          expected,
          this.cursorIndex,
          null,
          null,
          reason,
        ),
      );
      this.cursorIndex += 1;
    }
    return this.snapshot({ duplicate: false, matchedCount: 0 });
  }

  private alignEvidence(
    spokenTokens: readonly string[],
    evidenceWords?: readonly RecognitionWordEvidence[] | null,
  ): readonly (RecognitionWordEvidence | undefined)[] {
    if (!evidenceWords?.length || evidenceWords.length !== spokenTokens.length) {
      return spokenTokens.map(() => undefined);
    }
    const aligned = evidenceWords.map((word) => normalizeReadingToken(word.text));
    if (aligned.some((token, index) => token !== spokenTokens[index])) {
      return spokenTokens.map(() => undefined);
    }
    return evidenceWords;
  }

  private createCandidate(
    token: SequentialReadingToken,
    wordIndex: number,
    recognizedWord: string | null,
    logprob: number | null,
    reason: SequentialReviewReason,
  ): SequentialReviewCandidate {
    return {
      pageId: this.pageId,
      pageRevisionId: this.pageRevisionId,
      wordId: token.word_id,
      wordIndex,
      expectedWord: token.text,
      recognizedWord,
      logprob,
      confidence: wordConfidence(logprob),
      occurredAtMs: Date.now(),
      reason,
    };
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
      uncertainWordIds: new Set(this.uncertainWordIds),
      reviewedWordIds: new Set(this.reviewedWordIds),
      mismatchWordId: options.mismatchWordId ?? null,
      duplicate: options.duplicate,
      matchedCount: options.matchedCount,
    };
  }
}
