/**
 * Occurrence-based alignment for Vietnamese reading.
 *
 * Unlike text-set matching, every assessment belongs to one source occurrence
 * (page revision + word ID + word index). Only Scribe word-level logprob is
 * accepted as confidence evidence; language_probability is not word confidence.
 */

export type PronunciationStatus =
  | "CORRECT"
  | "INCORRECT"
  | "UNCERTAIN"
  | "NOT_REACHED";

export interface ReadingSourceWord {
  readonly word_id: string;
  readonly word_index: number;
  readonly text: string;
}

export interface RecognizedSpeechWord {
  readonly text: string;
  readonly start?: number;
  readonly end?: number;
  readonly logprob?: number | null;
}

export interface WordOccurrenceAssessment {
  readonly word_id: string;
  readonly word_index: number;
  readonly expected_text: string;
  readonly recognized_text: string | null;
  readonly confidence: number | null;
  readonly status: Exclude<PronunciationStatus, "NOT_REACHED">;
  readonly reason:
    | "EXACT_WORD_MATCH"
    | "CONFIDENT_SUBSTITUTION"
    | "BOUNDED_OMISSION"
    | "LOW_CONFIDENCE"
    | "INCOMPLETE_TOKEN";
}

export interface ReadingSegmentAlignment {
  readonly assessments: readonly WordOccurrenceAssessment[];
  readonly next_word_index: number;
  readonly consumed_recognized_words: number;
}

export const DEFAULT_WORD_CONFIDENCE_THRESHOLD = 0.7;

export function normalizeVietnameseToken(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("vi")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .trim();
}

export function confidenceFromLogprob(
  logprob: number | null | undefined,
): number | null {
  if (typeof logprob !== "number" || !Number.isFinite(logprob) || logprob > 0) {
    return null;
  }

  const confidence = Math.exp(logprob);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : null;
}

function transcriptWords(
  words: readonly RecognizedSpeechWord[] | null | undefined,
  transcript: string,
): RecognizedSpeechWord[] {
  if (words?.length) {
    return words.filter((word) => normalizeVietnameseToken(word.text).length > 0);
  }

  // Text-only transcripts are retained for diagnostics, but have no per-word
  // confidence and therefore cannot confirm either correctness or an error.
  return transcript
    .normalize("NFC")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((text) => ({ text, logprob: null }));
}

function isLikelyIncompleteToken(spoken: string, expected: string): boolean {
  if (!spoken || !expected) return true;
  if (spoken.length === 1 && expected.length >= 3) return true;
  return expected.length >= 4 && spoken.length / expected.length < 0.5;
}

type AlignmentStep =
  | { readonly kind: "mapped"; readonly sourceOffset: number; readonly spokenIndex: number }
  | { readonly kind: "skipped-source"; readonly sourceOffset: number }
  | { readonly kind: "extra-spoken"; readonly spokenIndex: number };

const SUBSTITUTION_COST = 1.25;
const GAP_COST = 1;

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

/**
 * Align one completed STT utterance to the not-yet-consumed source suffix.
 *
 * Trailing source words are deliberately not consumed: a child may simply be
 * pausing before the next utterance. Leading omissions are UNCERTAIN because
 * they can be caused by a clipped first phoneme. An omission is INCORRECT only
 * when high-confidence words on both sides bound that exact source occurrence.
 */
export function alignReadingSegment(
  sourceWords: readonly ReadingSourceWord[],
  startWordIndex: number,
  transcript: string,
  recognizedEvidence?: readonly RecognizedSpeechWord[] | null,
  confidenceThreshold = DEFAULT_WORD_CONFIDENCE_THRESHOLD,
): ReadingSegmentAlignment {
  const start = Math.max(0, Math.min(startWordIndex, sourceWords.length));
  const spoken = transcriptWords(recognizedEvidence, transcript);
  if (!spoken.length || start >= sourceWords.length) {
    return {
      assessments: [],
      next_word_index: start,
      consumed_recognized_words: 0,
    };
  }

  const source = sourceWords.slice(
    start,
    Math.min(sourceWords.length, start + Math.max(spoken.length + 3, 8)),
  );
  const expectedTokens = source.map((word) =>
    normalizeVietnameseToken(word.text),
  );
  const spokenTokens = spoken.map((word) =>
    normalizeVietnameseToken(word.text),
  );

  const rows = source.length + 1;
  const columns = spoken.length + 1;
  const costs = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(Number.POSITIVE_INFINITY),
  );

  costs[0][0] = 0;
  for (let i = 1; i < rows; i += 1) {
    costs[i][0] = i * GAP_COST;
  }
  for (let j = 1; j < columns; j += 1) {
    costs[0][j] = j * GAP_COST;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const substitutionCost =
        expectedTokens[i - 1] === spokenTokens[j - 1]
          ? 0
          : SUBSTITUTION_COST;

      costs[i][j] = Math.min(
        costs[i - 1][j - 1] + substitutionCost,
        costs[i - 1][j] + GAP_COST,
        costs[i][j - 1] + GAP_COST,
      );
    }
  }

  // Consume all recognized words, but stop at the cheapest source prefix.
  // On ties prefer the shorter prefix so a pause cannot become trailing errors.
  let endSourceOffset = 1;
  for (let i = 2; i < rows; i += 1) {
    if (costs[i][spoken.length] < costs[endSourceOffset][spoken.length] - 1e-9) {
      endSourceOffset = i;
    }
  }

  const reversedSteps: AlignmentStep[] = [];
  let sourceOffset = endSourceOffset;
  let spokenIndex = spoken.length;

  while (sourceOffset > 0 || spokenIndex > 0) {
    const current = costs[sourceOffset][spokenIndex];

    if (sourceOffset > 0 && spokenIndex > 0) {
      const substitutionCost =
        expectedTokens[sourceOffset - 1] === spokenTokens[spokenIndex - 1]
          ? 0
          : SUBSTITUTION_COST;
      if (
        nearlyEqual(
          current,
          costs[sourceOffset - 1][spokenIndex - 1] + substitutionCost,
        )
      ) {
        reversedSteps.push({
          kind: "mapped",
          sourceOffset: sourceOffset - 1,
          spokenIndex: spokenIndex - 1,
        });
        sourceOffset -= 1;
        spokenIndex -= 1;
        continue;
      }
    }

    if (
      sourceOffset > 0 &&
      nearlyEqual(current, costs[sourceOffset - 1][spokenIndex] + GAP_COST)
    ) {
      reversedSteps.push({
        kind: "skipped-source",
        sourceOffset: sourceOffset - 1,
      });
      sourceOffset -= 1;
      continue;
    }

    if (spokenIndex > 0) {
      reversedSteps.push({ kind: "extra-spoken", spokenIndex: spokenIndex - 1 });
      spokenIndex -= 1;
      continue;
    }

    break;
  }

  const steps = reversedSteps.reverse();
  const mapped = steps.filter(
    (step): step is Extract<AlignmentStep, { kind: "mapped" }> =>
      step.kind === "mapped",
  );
  const mappedByOffset = new Map<
    number,
    { readonly spokenIndex: number; readonly confidence: number | null; readonly status: "CORRECT" | "INCORRECT" | "UNCERTAIN"; readonly reason: WordOccurrenceAssessment["reason"] }
  >();
  const assessments: WordOccurrenceAssessment[] = [];

  for (const step of mapped) {
    const sourceWord = source[step.sourceOffset];
    const spokenWord = spoken[step.spokenIndex];
    const expected = expectedTokens[step.sourceOffset];
    const recognized = spokenTokens[step.spokenIndex];
    const confidence = confidenceFromLogprob(spokenWord.logprob);
    const hasConfidence =
      confidence !== null && confidence >= confidenceThreshold;
    const incomplete = isLikelyIncompleteToken(recognized, expected);
    const exact = expected === recognized;

    let status: WordOccurrenceAssessment["status"];
    let reason: WordOccurrenceAssessment["reason"];

    if (!hasConfidence) {
      status = "UNCERTAIN";
      reason = "LOW_CONFIDENCE";
    } else if (incomplete) {
      status = "UNCERTAIN";
      reason = "INCOMPLETE_TOKEN";
    } else if (exact) {
      status = "CORRECT";
      reason = "EXACT_WORD_MATCH";
    } else {
      status = "INCORRECT";
      reason = "CONFIDENT_SUBSTITUTION";
    }

    mappedByOffset.set(step.sourceOffset, {
      spokenIndex: step.spokenIndex,
      confidence,
      status,
      reason,
    });
    assessments.push({
      word_id: sourceWord.word_id,
      word_index: sourceWord.word_index,
      expected_text: sourceWord.text,
      recognized_text: spokenWord.text,
      confidence,
      status,
      reason,
    });
  }

  const skippedOffsets = steps
    .filter(
      (step): step is Extract<AlignmentStep, { kind: "skipped-source" }> =>
        step.kind === "skipped-source",
    )
    .map((step) => step.sourceOffset);

  for (const skippedOffset of skippedOffsets) {
    const previous = mappedByOffset.get(skippedOffset - 1);
    const next = mappedByOffset.get(skippedOffset + 1);
    const boundedByReliableSpeech =
      previous?.status === "CORRECT" &&
      next?.status === "CORRECT" &&
      previous.confidence !== null &&
      next.confidence !== null;
    const sourceWord = source[skippedOffset];

    assessments.push({
      word_id: sourceWord.word_id,
      word_index: sourceWord.word_index,
      expected_text: sourceWord.text,
      recognized_text: null,
      confidence:
        boundedByReliableSpeech && previous && next
          ? Math.min(previous.confidence ?? 0, next.confidence ?? 0)
          : null,
      status: boundedByReliableSpeech ? "INCORRECT" : "UNCERTAIN",
      reason: boundedByReliableSpeech ? "BOUNDED_OMISSION" : "LOW_CONFIDENCE",
    });
  }

  assessments.sort((left, right) => left.word_index - right.word_index);

  const trustedSourceOffsets = [...mappedByOffset.entries()]
    .filter(([, assessment]) => assessment.status !== "UNCERTAIN")
    .map(([offset]) => offset);
  const nextWordIndex =
    trustedSourceOffsets.length > 0
      ? start + Math.max(...trustedSourceOffsets) + 1
      : start;

  return {
    assessments,
    next_word_index: nextWordIndex,
    consumed_recognized_words: spoken.length,
  };
}

export interface PronunciationReviewCandidate {
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly word_id: string;
  readonly word_index: number;
  readonly expected_word: string;
  readonly recognized_word: string | null;
  readonly confidence: number | null;
  readonly sentence_text: string | null;
  readonly sentence_start_word_index: number | null;
  readonly sentence_end_word_index_exclusive: number | null;
}

export interface PronunciationReviewGroup {
  readonly key: string;
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly sentence_text: string | null;
  readonly sentence_start_word_index: number | null;
  readonly sentence_end_word_index_exclusive: number | null;
  readonly words: readonly PronunciationReviewCandidate[];
}

const SENTENCE_ENDING = /[.!?…。！？]["'’”」』)\]]*$/u;

/** Returns only a sentence bounded by real source punctuation. */
export function findOriginalSentence(
  words: readonly ReadingSourceWord[],
  targetWordIndex: number,
): {
  readonly text: string;
  readonly startWordIndex: number;
  readonly endWordIndexExclusive: number;
} | null {
  if (targetWordIndex < 0 || targetWordIndex >= words.length) return null;

  let start = targetWordIndex;
  while (start > 0 && !SENTENCE_ENDING.test(words[start - 1].text.trim())) {
    start -= 1;
  }
  if (
    start > 0 ||
    (start === 0 && targetWordIndex === 0)
  ) {
    // A page boundary is accepted as a sentence boundary only when the target
    // belongs to the first sentence beginning at the start of the verified page.
  } else {
    return null;
  }

  let end = targetWordIndex;
  while (end < words.length && !SENTENCE_ENDING.test(words[end].text.trim())) {
    end += 1;
  }
  if (end >= words.length) return null;

  return {
    text: words.slice(start, end + 1).map((word) => word.text).join(" "),
    startWordIndex: start,
    endWordIndexExclusive: end + 1,
  };
}

export function groupPronunciationReviewCandidates(
  candidates: readonly PronunciationReviewCandidate[],
): PronunciationReviewGroup[] {
  const groups = new Map<string, PronunciationReviewGroup>();

  for (const candidate of [...candidates].sort(
    (left, right) =>
      left.page_id.localeCompare(right.page_id) ||
      left.word_index - right.word_index,
  )) {
    const sentenceKey =
      candidate.sentence_start_word_index === null ||
      candidate.sentence_end_word_index_exclusive === null
        ? `word:${candidate.word_id}`
        : `sentence:${candidate.sentence_start_word_index}:${candidate.sentence_end_word_index_exclusive}`;
    const key = [
      candidate.page_id,
      candidate.page_revision_id,
      sentenceKey,
    ].join(":");
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, {
        ...existing,
        words: [...existing.words, candidate],
      });
    } else {
      groups.set(key, {
        key,
        page_id: candidate.page_id,
        page_revision_id: candidate.page_revision_id,
        sentence_text: candidate.sentence_text,
        sentence_start_word_index: candidate.sentence_start_word_index,
        sentence_end_word_index_exclusive:
          candidate.sentence_end_word_index_exclusive,
        words: [candidate],
      });
    }
  }

  return [...groups.values()].sort(
    (left, right) =>
      left.page_id.localeCompare(right.page_id) ||
      (left.words[0]?.word_index ?? 0) - (right.words[0]?.word_index ?? 0),
  );
}
