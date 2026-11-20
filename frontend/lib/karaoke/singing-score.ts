import type { KaraokeLine, KaraokeLyrics } from "@/types/karaoke";
import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WordMatch {
  /** Expected word from lyrics. */
  expected: string;
  /** Recognized word from speech recognition, or null if missing. */
  spoken: string | null;
  /** Whether the expected word was found in the spoken text. */
  matched: boolean;
}

export interface LineScore {
  lineIndex: number;
  lineText: string;
  wordMatches: WordMatch[];
  /** 0–100 word accuracy for this line. */
  accuracy: number;
}

export interface SingingScore {
  lineScores: LineScore[];
  /** 0–100 overall word accuracy across all lines. */
  overallAccuracy: number;
  /** Total expected words. */
  totalWords: number;
  /** Total correctly recognized words. */
  matchedWords: number;
}

/** Match in transcript order while preserving the real lyric position. */
function orderedMatcher(text: string) {
  const spoken = tokenizeVietnameseText(text);
  let next = 0;
  return (expected: string): WordMatch => {
    const index = spoken.indexOf(expected, next);
    if (index < 0) return { expected, spoken: null, matched: false };
    next = index + 1;
    return { expected, spoken: spoken[index], matched: true };
  };
}

function evaluateLine(
  lineIndex: number,
  line: KaraokeLine,
  match: (word: string) => WordMatch,
): LineScore {
  const wordMatches = tokenizeVietnameseText(line.text).map(match);
  const correct = wordMatches.filter((word) => word.matched).length;
  return {
    lineIndex,
    lineText: line.text,
    wordMatches,
    accuracy: wordMatches.length
      ? Math.round((100 * correct) / wordMatches.length)
      : 100,
  };
}

function summarize(lineScores: LineScore[]): SingingScore {
  let totalWords = 0;
  let matchedWords = 0;
  for (const line of lineScores) {
    totalWords += line.wordMatches.length;
    matchedWords += line.wordMatches.filter((word) => word.matched).length;
  }
  return {
    lineScores,
    matchedWords,
    totalWords,
    overallAccuracy: totalWords
      ? Math.round((100 * matchedWords) / totalWords)
      : 100,
  };
}

export function scoreLine(
  lineIndex: number,
  line: KaraokeLine,
  spokenText: string,
): LineScore {
  return evaluateLine(lineIndex, line, orderedMatcher(spokenText));
}

export function scoreSong(
  lyrics: KaraokeLyrics,
  spokenByLine: Map<number, string>,
): SingingScore {
  return summarize(
    lyrics.lines.map((line, i) =>
      scoreLine(i, line, spokenByLine.get(i) ?? ""),
    ),
  );
}

/** Legacy untimed scoring for callers with a single, complete transcript. */
export function scoreFromFullTranscript(
  lyrics: KaraokeLyrics,
  fullTranscript: string,
): SingingScore {
  const match = orderedMatcher(fullTranscript);
  return summarize(lyrics.lines.map((line, i) => evaluateLine(i, line, match)));
}
