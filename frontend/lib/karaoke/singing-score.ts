import type { KaraokeLine, KaraokeLyrics } from "@/types/karaoke";
import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split text into normalized word tokens for comparison. */
function tokenize(text: string): string[] {
  return (text.normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
    .map(normalizeVietnameseWord)
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single line by comparing expected lyrics to spoken words.
 *
 * Uses a greedy sequential scan: for each expected word we look forward
 * through the remaining spoken tokens for a match.  This tolerates
 * insertions (extra words the child said) while still rewarding correct
 * order.
 */
export function scoreLine(
  lineIndex: number,
  line: KaraokeLine,
  spokenText: string,
): LineScore {
  const expectedTokens = tokenize(line.text);
  const spokenTokens = tokenize(spokenText);

  const wordMatches: WordMatch[] = [];
  let spokenCursor = 0;

  for (const expected of expectedTokens) {
    let matched = false;
    // Look ahead in remaining spoken tokens for a match.
    for (let j = spokenCursor; j < spokenTokens.length; j++) {
      if (spokenTokens[j] === expected) {
        matched = true;
        spokenCursor = j + 1;
        wordMatches.push({ expected, spoken: spokenTokens[j], matched: true });
        break;
      }
    }
    if (!matched) {
      wordMatches.push({ expected, spoken: null, matched: false });
    }
  }

  const total = expectedTokens.length;
  const correct = wordMatches.filter((m) => m.matched).length;

  return {
    lineIndex,
    lineText: line.text,
    wordMatches,
    accuracy: total > 0 ? Math.round((correct / total) * 100) : 100,
  };
}

/**
 * Score an entire song given the lyrics and a map of line-index → spoken text.
 *
 * Lines without a spoken entry are scored as 0% (all words missed).
 * Pass an empty map to score everything as missed.
 */
export function scoreSong(
  lyrics: KaraokeLyrics,
  spokenByLine: Map<number, string>,
): SingingScore {
  const lineScores: LineScore[] = [];
  let totalWords = 0;
  let matchedWords = 0;

  for (let i = 0; i < lyrics.lines.length; i++) {
    const line = lyrics.lines[i];
    const spoken = spokenByLine.get(i) ?? "";
    const ls = scoreLine(i, line, spoken);
    lineScores.push(ls);
    totalWords += ls.wordMatches.length;
    matchedWords += ls.wordMatches.filter((m) => m.matched).length;
  }

  return {
    lineScores,
    overallAccuracy:
      totalWords > 0 ? Math.round((matchedWords / totalWords) * 100) : 100,
    totalWords,
    matchedWords,
  };
}

/**
 * Convenience: score from a flat transcript against full lyrics.
 *
 * When Browser Web Speech API is used, we get a continuous transcript
 * rather than per-line segments.  This function uses the lyrics line
 * timing data (start_ms/end_ms) to slice the transcript approximately,
 * then scores each line.
 *
 * Since the Browser Speech API doesn't provide word-level timestamps,
 * this uses a simpler strategy: compare the entire transcript against
 * all lyrics words in order.
 */
export function scoreFromFullTranscript(
  lyrics: KaraokeLyrics,
  fullTranscript: string,
): SingingScore {
  // Build all expected words across all lines, tracking which line each
  // belongs to.
  const allExpected: { word: string; lineIndex: number }[] = [];
  for (let i = 0; i < lyrics.lines.length; i++) {
    for (const token of tokenize(lyrics.lines[i].text)) {
      allExpected.push({ word: token, lineIndex: i });
    }
  }

  const spokenTokens = tokenize(fullTranscript);

  // Greedy sequential matching across all expected words.
  const lineMatches = new Map<number, { total: number; matched: number }>();
  for (let i = 0; i < lyrics.lines.length; i++) {
    lineMatches.set(i, { total: 0, matched: 0 });
  }

  let spokenCursor = 0;
  for (const { word, lineIndex } of allExpected) {
    const entry = lineMatches.get(lineIndex)!;
    entry.total++;

    for (let j = spokenCursor; j < spokenTokens.length; j++) {
      if (spokenTokens[j] === word) {
        entry.matched++;
        spokenCursor = j + 1;
        break;
      }
    }
  }

  // Build per-line scores.
  const lineScores: LineScore[] = [];
  let totalWords = 0;
  let matchedWords = 0;

  for (let i = 0; i < lyrics.lines.length; i++) {
    const line = lyrics.lines[i];
    const { total, matched } = lineMatches.get(i)!;
    const expectedTokens = tokenize(line.text);

    // Build approximate word matches for display.
    const wordMatches: WordMatch[] = expectedTokens.map((expected) => ({
      expected,
      spoken: null,
      matched: false,
    }));

    // Mark the first N words as matched based on count.
    let remaining = matched;
    for (const wm of wordMatches) {
      if (remaining <= 0) break;
      wm.matched = true;
      wm.spoken = wm.expected;
      remaining--;
    }

    lineScores.push({
      lineIndex: i,
      lineText: line.text,
      wordMatches,
      accuracy: total > 0 ? Math.round((matched / total) * 100) : 100,
    });

    totalWords += total;
    matchedWords += matched;
  }

  return {
    lineScores,
    overallAccuracy:
      totalWords > 0 ? Math.round((matchedWords / totalWords) * 100) : 100,
    totalWords,
    matchedWords,
  };
}
