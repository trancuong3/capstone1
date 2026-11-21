/**
 * Sentence-level fluency reinforcement (G20).
 *
 * Example: page sentence is "Tôi ăn cơm."
 * If the child misreads or gets stuck on "Tôi", once they finish practicing
 * "Tôi" (whether they pronounced it right or used up attempts and received
 * encouragement), ViRead invites them to read back the full sentence
 * "Tôi ăn cơm" so they practise smooth blending in context.
 *
 * Invariants:
 *  - Only triggers for sentences of 2..12 words (longer sentences fall back to
 *    the local clause containing the practiced word).
 *  - Max 1 reinforcement per sentence (never loops forever).
 *  - Strictly reinforcement only: NEVER mutates first-pass word scores or
 *    creates duplicate comparison reports.
 */

import {
  isPhonicsInProgress,
  matchPhonicsSpelling,
} from "@/lib/reading/phonics-spelling";
import {
  normalizeRealtimeWord,
  tokenizeRealtimeText,
} from "@/lib/reading/realtime-alignment";
import type { ReadingPageWordDTO } from "@/types/reading";

export interface SentenceSpan {
  /** Stable identifier for this sentence/clause within a page revision. */
  readonly sentenceKey: string;
  readonly startIndex: number;
  /** Inclusive end word index. */
  readonly endIndex: number;
  readonly words: readonly ReadingPageWordDTO[];
  /** Clean display/TTS sentence text. */
  readonly text: string;
  /** True if a long sentence (> maxWords) was narrowed to a clause/window. */
  readonly isClause: boolean;
}

export interface SentenceExtractionOptions {
  readonly pageRevisionId?: string;
  readonly minWords?: number;
  readonly maxWords?: number;
}

const SENTENCE_END_RE = /[.!?…]["”’')\]]*$/u;
const CLAUSE_BREAK_RE = /[,;:—–-]["”’')\]]*$/u;

function hasParagraphBreakBefore(
  words: readonly ReadingPageWordDTO[],
  index: number,
): boolean {
  if (index <= 0) return false;
  const prev = words[index - 1];
  const curr = words[index];
  if (!prev || !curr) return false;
  const prevLine = prev.line_index ?? 0;
  const currLine = curr.line_index ?? 0;
  if (currLine === prevLine) return false;
  const verticalGap = curr.bbox[1] - (prev.bbox[1] + prev.bbox[3]);
  return verticalGap > Math.max(prev.bbox[3], curr.bbox[3]) * 1.8;
}

/**
 * Extract the sentence (2..12 words) containing `targetWordId`.
 * If the enclosing sentence exceeds `maxWords`, narrows to the clause
 * delimited by commas/semicolons/dashes or a focused window around the word.
 * Returns `null` when the sentence has fewer than `minWords` words (e.g. a
 * 1-word title or exclamation).
 */
export function extractSentenceForWord(
  words: readonly ReadingPageWordDTO[],
  targetWordId: string,
  options: SentenceExtractionOptions = {},
): SentenceSpan | null {
  const minWords = options.minWords ?? 2;
  const maxWords = options.maxWords ?? 12;
  const targetIndex = words.findIndex((w) => w.word_id === targetWordId);
  if (targetIndex < 0) return null;

  // Walk backward to find sentence start
  let start = targetIndex;
  while (start > 0) {
    if (SENTENCE_END_RE.test(words[start - 1].text.trim())) break;
    if (hasParagraphBreakBefore(words, start)) break;
    start -= 1;
  }

  // Walk forward to find sentence end (inclusive)
  let end = targetIndex;
  while (end < words.length - 1) {
    if (SENTENCE_END_RE.test(words[end].text.trim())) break;
    if (hasParagraphBreakBefore(words, end + 1)) break;
    end += 1;
  }

  let isClause = false;
  if (end - start + 1 > maxWords) {
    isClause = true;
    // Narrow to comma/semicolon clause containing targetIndex
    let clauseStart = targetIndex;
    while (clauseStart > start) {
      if (CLAUSE_BREAK_RE.test(words[clauseStart - 1].text.trim())) break;
      clauseStart -= 1;
    }
    let clauseEnd = targetIndex;
    while (clauseEnd < end) {
      if (CLAUSE_BREAK_RE.test(words[clauseEnd].text.trim())) break;
      clauseEnd += 1;
    }
    if (
      clauseEnd - clauseStart + 1 >= minWords &&
      clauseEnd - clauseStart + 1 <= maxWords
    ) {
      start = clauseStart;
      end = clauseEnd;
    } else {
      // Balanced window of up to 7 words centered on targetIndex
      const windowSize = Math.min(7, maxWords);
      const half = Math.floor(windowSize / 2);
      start = Math.max(start, targetIndex - half);
      end = Math.min(end, start + windowSize - 1);
      start = Math.max(0, end - windowSize + 1);
    }
  }

  const slice = words.slice(start, end + 1);
  if (slice.length < minWords) return null;

  const text = slice
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(" ");
  const rev = options.pageRevisionId ?? "page";
  return {
    sentenceKey: `${rev}:${start}-${end}`,
    startIndex: start,
    endIndex: end,
    words: slice,
    text,
    isClause,
  };
}

export type ReinforcementTriggerOutcome = "fixed" | "helped";

export interface ActiveSentenceReinforcement {
  readonly span: SentenceSpan;
  readonly triggerWordId: string;
  readonly outcome: ReinforcementTriggerOutcome;
  readonly matchedIndices: ReadonlySet<number>;
}

export type ReinforcementSpeechResult = "completed" | "in-progress" | "ignored";

/**
 * Tracks sentence-level fluency reinforcement across a page/session,
 * enforcing at most one reinforcement pass per sentence.
 */
export class SentenceReinforcementTracker {
  private readonly completedKeys = new Set<string>();
  private active: ActiveSentenceReinforcement | null = null;
  private activeMatched = new Set<number>();
  private spellingBuffer: { cursor: number; tokens: string[] } | null = null;

  getActive(): ActiveSentenceReinforcement | null {
    return this.active;
  }

  getBufferedSpellingTokens(): readonly string[] {
    return this.spellingBuffer?.tokens ?? [];
  }

  hasReinforced(sentenceKey: string): boolean {
    return this.completedKeys.has(sentenceKey);
  }

  /**
   * Arm a sentence reinforcement after the child finishes practicing
   * `triggerWordId` (whether fixed or helped/encouraged).
   * Returns the active reinforcement, or `null` if this sentence was already
   * reinforced or is too short (< 2 words).
   */
  beginForWord(
    words: readonly ReadingPageWordDTO[],
    triggerWordId: string,
    outcome: ReinforcementTriggerOutcome,
    options: SentenceExtractionOptions = {},
  ): ActiveSentenceReinforcement | null {
    const span = extractSentenceForWord(words, triggerWordId, options);
    if (!span || this.completedKeys.has(span.sentenceKey)) return null;
    this.activeMatched = new Set();
    this.spellingBuffer = null;
    this.active = {
      span,
      triggerWordId,
      outcome,
      matchedIndices: this.activeMatched,
    };
    return this.active;
  }

  /**
   * Consume a final speech transcript during sentence reinforcement.
   * Accepts normal fluent speech AND Grade-1 phonics spelling-out (including
   * multi-chunk spelling like "ê" -> "tờ" -> "ê" -> "tê").
   * Marks completed once the child has read >= 65% of the sentence's words
   * (or at least 2 words for 2-3 word sentences) including the final word or
   * the practiced word.
   */
  consumeSpeech(transcript: string): ReinforcementSpeechResult {
    if (!this.active) return "ignored";
    let tokens = tokenizeRealtimeText(transcript);
    if (!tokens.length) return "ignored";

    const expected = this.active.span.words.map((w) =>
      normalizeRealtimeWord(w.text),
    );

    let cursor = 0;
    // Start scanning from the earliest unmatched word so multi-chunk reading works
    while (cursor < expected.length && this.activeMatched.has(cursor)) {
      cursor += 1;
    }

    let newlyMatched = 0;
    if (this.spellingBuffer && this.spellingBuffer.cursor === cursor) {
      const combined = [...this.spellingBuffer.tokens, ...tokens];
      const bufferedMatch = matchPhonicsSpelling(combined, expected[cursor]);
      if (bufferedMatch) {
        this.spellingBuffer = null;
        this.activeMatched.add(cursor);
        newlyMatched += 1;
        cursor += 1;
        tokens = combined.slice(bufferedMatch.consumedCount);
      } else if (isPhonicsInProgress(combined, expected[cursor])) {
        this.spellingBuffer = { cursor, tokens: combined };
        return "in-progress";
      } else {
        this.spellingBuffer = null;
      }
    } else {
      this.spellingBuffer = null;
    }

    for (let i = 0; i < tokens.length && cursor < expected.length;) {
      if (tokens[i] === expected[cursor]) {
        this.activeMatched.add(cursor);
        newlyMatched += 1;
        cursor += 1;
        i += 1;
        continue;
      }
      const remaining = tokens.slice(i);
      const phonics = matchPhonicsSpelling(remaining, expected[cursor]);
      if (phonics) {
        this.activeMatched.add(cursor);
        newlyMatched += 1;
        cursor += 1;
        i += phonics.consumedCount;
        continue;
      }
      if (isPhonicsInProgress(remaining, expected[cursor])) {
        this.spellingBuffer = { cursor, tokens: [...remaining] };
        return "in-progress";
      }
      // Look slightly ahead inside the sentence in case one word was dropped
      const ahead = expected.indexOf(tokens[i], cursor + 1);
      if (ahead !== -1 && ahead <= cursor + 2) {
        this.activeMatched.add(ahead);
        newlyMatched += 1;
        cursor = ahead + 1;
        i += 1;
        continue;
      }
      i += 1;
    }

    if (newlyMatched === 0) return "ignored";

    this.active = {
      ...this.active,
      matchedIndices: new Set(this.activeMatched),
    };

    const ratio = this.activeMatched.size / expected.length;
    const minRequired = expected.length <= 3 ? Math.min(2, expected.length) : 0;
    const reachedEnd = this.activeMatched.has(expected.length - 1);
    if (
      (ratio >= 0.65 && (reachedEnd || ratio >= 0.75)) ||
      (expected.length <= 3 &&
        this.activeMatched.size >= minRequired &&
        reachedEnd)
    ) {
      this.finishCurrent();
      return "completed";
    }
    return "in-progress";
  }

  /** Complete or skip the current reinforcement so the child can move on. */
  finishCurrent(): void {
    if (this.active) {
      this.completedKeys.add(this.active.span.sentenceKey);
    }
    this.active = null;
    this.activeMatched = new Set();
    this.spellingBuffer = null;
  }

  reset(): void {
    this.completedKeys.clear();
    this.active = null;
    this.activeMatched = new Set();
    this.spellingBuffer = null;
  }
}
