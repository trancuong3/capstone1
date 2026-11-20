import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";
import type { KaraokeLine, KaraokeLyrics } from "@/types/karaoke";

export type LiveWordState = "matched" | "different" | "omitted" | "unknown";

export interface LiveWord {
  id: string;
  syllableId: string | null;
  text: string;
  state: LiveWordState;
}
export interface LiveLineScore {
  lineIndex: number;
  lineId: string;
  lineText: string;
  words: LiveWord[];
  matchedWords: number;
  evaluatedWords: number;
}
export interface LiveSingingScore {
  kind: "whole" | "partial" | "insufficient";
  overallAccuracy: number | null;
  matchedWords: number;
  evaluatedWords: number;
  totalWords: number;
  lineScores: LiveLineScore[];
}

interface TimedWord extends LiveWord {
  lineIndex: number;
  start: number | null;
  end: number | null;
  position: number;
}
interface Anchor {
  expected: number;
  heard: number;
}

// Results can be delivered just after a syllable/line ends. Search backwards
// only; a final cannot be evidence of a lyric that has not started playing.
const finalLagMs = 750;

function wordsInLine(
  line: KaraokeLine,
  lineIndex: number,
  offset: number,
): TimedWord[] {
  const segments = line.syllables?.length ? line.syllables : [line];
  const words: TimedWord[] = [];
  for (const segment of segments) {
    for (const [i, text] of tokenizeVietnameseText(segment.text).entries()) {
      words.push({
        id: segment.id + "/" + i,
        syllableId: segment === line ? null : segment.id,
        text,
        state: "unknown",
        start: segment.start_ms,
        end: segment.end_ms,
        lineIndex,
        position: offset + words.length,
      });
    }
  }
  return words;
}

// An anchor is certain only when *every* longest ordered match assigns that
// rank to the same lyric position. One "la" against two simultaneous "la"s stays
// unknown instead of awarding it to whichever chorus was scanned first.
function uniqueAnchors(words: TimedWord[], heard: string[]): (Anchor | null)[] {
  const rows = words.length;
  const cols = heard.length;
  if (rows === cols && words.every((word, i) => word.text === heard[i]))
    return words.map((_, i) => ({ expected: i, heard: i }));
  // A very long, unsegmented result must not stall audio playback or allocate
  // a quadratic table for an entire song. No position can then be asserted.
  if ((rows + 1) * (cols + 1) > 1_000_000) return [null];
  const stride = cols + 1;
  const prefix = new Uint16Array((rows + 1) * stride);
  for (let i = 0; i < rows; i++) {
    const row = i * stride;
    for (let j = 0; j < cols; j++) {
      prefix[row + stride + j + 1] =
        words[i].text === heard[j]
          ? prefix[row + j] + 1
          : Math.max(prefix[row + stride + j], prefix[row + j + 1]);
    }
  }
  const length = prefix[rows * stride + cols];
  const anchors: (Anchor | null)[] = new Array(length);
  const suffix = new Uint16Array(stride);
  for (let i = rows - 1; i >= 0; i--) {
    let diagonal = 0;
    for (let j = cols - 1; j >= 0; j--) {
      const previous = suffix[j];
      if (words[i].text === heard[j]) {
        const rank = prefix[i * stride + j];
        if (rank + 1 + diagonal === length) {
          const previousAnchor = anchors[rank];
          if (previousAnchor === undefined)
            anchors[rank] = { expected: i, heard: j };
          else if (previousAnchor?.expected === i) {
            // A stutter can give two equally good *heard* positions for a single
            // certain lyric position. Neither can bound a deletion/substitution.
            previousAnchor.heard = -1;
          } else anchors[rank] = null;
        }
        suffix[j] = diagonal + 1;
      } else suffix[j] = Math.max(previous, suffix[j + 1]);
      diagonal = previous;
    }
  }
  return anchors;
}

function overlaps(word: TimedWord, start: number, end: number) {
  return (
    word.start !== null &&
    word.end !== null &&
    word.start < end &&
    word.end > start
  );
}

export class LiveSingingAttempt {
  private readonly words: TimedWord[] = [];
  private readonly byLine: TimedWord[][];
  private lastEnd = -1;
  private cursor = -1;

  constructor(private readonly lyrics: KaraokeLyrics) {
    this.byLine = lyrics.lines.map((line, i) => {
      const words = wordsInLine(line, i, this.words.length);
      this.words.push(...words);
      return words;
    });
  }

  accept(
    text: string,
    fromMs: number,
    toMs: number,
    earliestCapturedMs = 0,
  ): boolean {
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      !Number.isFinite(earliestCapturedMs) ||
      earliestCapturedMs < 0 ||
      fromMs < earliestCapturedMs ||
      toMs <= fromMs
    )
      return false;
    const heard = tokenizeVietnameseText(text);
    if (!heard.length) return false;
    const forward = fromMs >= this.lastEnd;
    // A delayed final may reach back within its capture, never across a seek,
    // pause, or time spent waiting for microphone access.
    const searchFrom = Math.max(earliestCapturedMs, fromMs - finalLagMs);
    const eligible = this.words.filter(
      (word) =>
        (!forward || word.position > this.cursor) &&
        overlaps(word, searchFrom, toMs),
    );
    const core = eligible.filter((word) => overlaps(word, fromMs, toMs));
    if (!eligible.length) return false;
    // Prefer the actual sung interval for identical words in adjacent lines
    // when the recording spans that full phrase. A short boundary fragment
    // can also belong to the previous line; require unambiguous anchors.
    const covers = (word: TimedWord) =>
      word.start !== null &&
      word.end !== null &&
      word.start >= fromMs &&
      word.end <= toMs;
    const exactCore =
      core.length === heard.length &&
      core.every((word, i) => covers(word) && word.text === heard[i]);
    const words = exactCore ? core : eligible;
    const anchors = uniqueAnchors(words, heard);
    let changed = false;
    let lastPosition = -1;
    const mark = (word: TimedWord, state: LiveWordState) => {
      lastPosition = Math.max(lastPosition, word.position);
      if (word.state !== "unknown") return;
      word.state = state;
      changed = true;
    };
    for (const anchor of anchors) {
      if (anchor) mark(words[anchor.expected], "matched");
    }

    // Missing interior words require two reliable anchors within one line.
    // Substitutions need equal counts plus anchors or full timed coverage;
    // a missing edge, unclear segment or ASR insertion stays unassessed.
    const before = { expected: -1, heard: -1 };
    const after = { expected: words.length, heard: heard.length };
    const boundaries = [before, ...anchors, after];
    for (let k = 1; k < boundaries.length; k++) {
      const left = boundaries[k - 1],
        right = boundaries[k];
      if (!left || !right) continue;
      if (
        (left !== before && left.heard < 0) ||
        (right !== after && right.heard < 0)
      )
        continue;
      const interior = left !== before && right !== after;
      const gap = words
        .slice(left.expected + 1, right.expected)
        .filter((w) => interior || overlaps(w, fromMs, toMs));
      if (!gap.length || !gap.every((w) => w.lineIndex === gap[0].lineIndex))
        continue;
      const anchored =
        interior &&
        words[left.expected].lineIndex === gap[0].lineIndex &&
        words[right.expected].lineIndex === gap[0].lineIndex;
      const heardCount = right.heard - left.heard - 1;
      if (anchored && heardCount === 0)
        gap.forEach((word) => mark(word, "omitted"));
      else if (gap.length === heardCount && (anchored || gap.every(covers)))
        gap.forEach((word) => mark(word, "different"));
    }
    if (lastPosition >= 0) {
      this.cursor = lastPosition;
      this.lastEnd = toMs;
    }
    return changed;
  }

  result(practice = false): LiveSingingScore {
    let matchedWords = 0;
    let evaluatedWords = 0;
    const lineScores = this.byLine.map((lineWords, lineIndex) => {
      const words = lineWords.map(({ id, syllableId, text, state }) => ({
        id,
        syllableId,
        text,
        state,
      }));
      const matched = words.filter((word) => word.state === "matched").length;
      const evaluated = words.filter((word) => word.state !== "unknown").length;
      matchedWords += matched;
      evaluatedWords += evaluated;
      const line = this.lyrics.lines[lineIndex];
      return {
        lineIndex,
        lineId: line.id,
        lineText: line.text,
        words,
        matchedWords: matched,
        evaluatedWords: evaluated,
      };
    });
    const totalWords = this.words.length;
    const kind =
      evaluatedWords === 0
        ? "insufficient"
        : !practice && evaluatedWords * 5 >= totalWords * 4
          ? "whole"
          : "partial";
    return {
      kind,
      overallAccuracy:
        kind === "whole"
          ? Math.round((100 * matchedWords) / evaluatedWords)
          : null,
      matchedWords,
      evaluatedWords,
      totalWords,
      lineScores,
    };
  }
}
