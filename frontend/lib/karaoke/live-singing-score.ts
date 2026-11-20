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
  clockStart: number | null;
  clockEnd: number | null;
  playedMs: number;
  clockOmitted: boolean;
  position: number;
}
interface Anchor {
  expected: number;
  heard: number;
}

// Results can be delivered just after a syllable/line ends. Search backwards
// only; a final cannot be evidence of a lyric that has not started playing.
const finalLagMs = 750;

/**
 * Strips Vietnamese tone marks (sắc, huyền, hỏi, ngã, nặng) while preserving
 * base vowel quality (ă, â, ê, ô, ơ, ư) and đ. When singing softly, melody
 * pitch often overrides lexical tone in speech recognition.
 */
export function stripVietnameseTones(word: string): string {
  return word
    .normalize("NFD")
    .replace(/[\u0300\u0301\u0303\u0309\u0323]/g, "")
    .normalize("NFC");
}

/**
 * Phonetic key for soft singing ("hát bé"): normalizes tone marks and
 * common soft-consonant/coda confusions in quiet Vietnamese singing
 * while keeping distinct words separate (e.g. "nói" !== "hát", "mèo" !== "bé").
 */
export function softSingingKey(word: string): string {
  let s = stripVietnameseTones(word.toLowerCase().trim());
  if (!s) return s;
  s = s
    .replace(/^ngh/, "ng")
    .replace(/^gh/, "g")
    .replace(/^(gi|r)/, "d")
    .replace(/^x/, "s")
    .replace(/^tr/, "ch")
    .replace(/^(k|q)/, "c");
  if (s.length >= 3) {
    s = s.replace(/(nh|ng)$/, "n");
  }
  return s;
}

export function wordsMatchForSinging(
  expected: string,
  heard: string,
  softVoice = false,
): boolean {
  if (expected === heard) return true;
  if (!softVoice || !expected || !heard) return false;
  if (stripVietnameseTones(expected) === stripVietnameseTones(heard))
    return true;
  return softSingingKey(expected) === softSingingKey(heard);
}

function wordsInLine(
  line: KaraokeLine,
  lineIndex: number,
  offset: number,
): TimedWord[] {
  const segments = line.syllables?.length ? line.syllables : [line];
  const words: TimedWord[] = [];
  for (const segment of segments) {
    const tokens = tokenizeVietnameseText(segment.text);
    const count = Math.max(1, tokens.length);
    const hasTiming =
      segment.start_ms !== null &&
      segment.end_ms !== null &&
      segment.end_ms > segment.start_ms;
    const span = hasTiming ? segment.end_ms! - segment.start_ms! : 0;
    for (const [i, text] of tokens.entries()) {
      const clockStart = hasTiming
        ? Math.round(segment.start_ms! + (i * span) / count)
        : null;
      const clockEnd = hasTiming
        ? Math.round(segment.start_ms! + ((i + 1) * span) / count)
        : null;
      words.push({
        id: segment.id + "/" + i,
        syllableId: segment === line ? null : segment.id,
        text,
        state: "unknown",
        start: segment.start_ms,
        end: segment.end_ms,
        clockStart,
        clockEnd,
        playedMs: 0,
        clockOmitted: false,
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
function uniqueAnchors(
  words: TimedWord[],
  heard: string[],
  softVoice = false,
): (Anchor | null)[] {
  const rows = words.length;
  const cols = heard.length;
  if (
    rows === cols &&
    words.every((word, i) =>
      wordsMatchForSinging(word.text, heard[i], softVoice),
    )
  )
    return words.map((_, i) => ({ expected: i, heard: i }));
  // A very long, unsegmented result must not stall audio playback or allocate
  // a quadratic table for an entire song. No position can then be asserted.
  if ((rows + 1) * (cols + 1) > 1_000_000) return [null];
  const stride = cols + 1;
  const prefix = new Uint16Array((rows + 1) * stride);
  for (let i = 0; i < rows; i++) {
    const row = i * stride;
    for (let j = 0; j < cols; j++) {
      prefix[row + stride + j + 1] = wordsMatchForSinging(
        words[i].text,
        heard[j],
        softVoice,
      )
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
      if (wordsMatchForSinging(words[i].text, heard[j], softVoice)) {
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

  constructor(
    private readonly lyrics: KaraokeLyrics,
    private readonly softVoice = false,
  ) {
    this.byLine = lyrics.lines.map((line, i) => {
      const words = wordsInLine(line, i, this.words.length);
      this.words.push(...words);
      return words;
    });
  }

  /**
   * Selects the recognition alternative (from maxAlternatives) that matches
   * the most expected lyric words in the active time window.
   */
  bestAlternative(
    alternatives: readonly string[],
    fromMs: number,
    toMs: number,
    earliestCapturedMs = 0,
  ): string {
    if (alternatives.length <= 1) return alternatives[0] ?? "";
    const searchFrom = Math.max(earliestCapturedMs, fromMs - finalLagMs);
    const windowEnd = Math.max(toMs + 400, fromMs + 400);
    const eligible = this.words.filter((word) =>
      overlaps(word, searchFrom, windowEnd),
    );
    if (!eligible.length) return alternatives[0] ?? "";
    let best = alternatives[0] ?? "";
    let bestScore = -1;
    for (const candidate of alternatives) {
      const tokens = tokenizeVietnameseText(candidate);
      let score = 0;
      let cursor = 0;
      for (const token of tokens) {
        const hit = eligible.findIndex(
          (w, idx) =>
            idx >= cursor &&
            wordsMatchForSinging(w.text, token, this.softVoice),
        );
        if (hit !== -1) {
          score += eligible[hit].text === token ? 2 : 1;
          cursor = hit + 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
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
      core.every(
        (word, i) =>
          covers(word) &&
          wordsMatchForSinging(word.text, heard[i], this.softVoice),
      );
    const words = exactCore ? core : eligible;
    const anchors = uniqueAnchors(words, heard, this.softVoice);
    let changed = false;
    let lastPosition = -1;
    const mark = (word: TimedWord, state: LiveWordState) => {
      lastPosition = Math.max(lastPosition, word.position);
      if (word.state !== "unknown" && !word.clockOmitted) return;
      const stateChanged = word.state !== state;
      word.state = state;
      word.clockOmitted = false;
      if (stateChanged) changed = true;
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
      const sameLineLeft =
        left !== before && words[left.expected].lineIndex === gap[0].lineIndex;
      const sameLineRight =
        right !== after && words[right.expected].lineIndex === gap[0].lineIndex;
      const anchored = interior && sameLineLeft && sameLineRight;
      const nearCovers = (word: TimedWord) =>
        word.start !== null &&
        word.end !== null &&
        fromMs <= word.start + 400 &&
        toMs >= word.end - 400;
      const heardCount = right.heard - left.heard - 1;
      if (anchored && heardCount === 0)
        gap.forEach((word) => mark(word, "omitted"));
      else if (
        gap.length === heardCount &&
        (anchored ||
          gap.every(covers) ||
          ((sameLineLeft || sameLineRight) &&
            gap.every(
              (word) =>
                nearCovers(word) ||
                (word.syllableId !== null && overlaps(word, fromMs, toMs)),
            )))
      )
        gap.forEach((word) => mark(word, "different"));
    }
    if (lastPosition >= 0) {
      this.cursor = lastPosition;
      this.lastEnd = toMs;
    }
    return changed;
  }

  /**
   * Computes non-destructive real-time word states from interim speech
   * recognition (like RealtimeAlignmentEngine.previewAlignment in Reading).
   */
  preview(
    text: string,
    fromMs: number,
    toMs: number,
    earliestCapturedMs = 0,
  ): Map<string, LiveWordState> {
    const map = new Map<string, LiveWordState>();
    const heard = tokenizeVietnameseText(text);
    if (!heard.length || !Number.isFinite(fromMs) || !Number.isFinite(toMs))
      return map;
    const searchFrom = Math.max(earliestCapturedMs, fromMs - finalLagMs);
    const windowEnd = Math.max(toMs, fromMs + 400);
    const activeLineIndex = this.lyrics.lines.findIndex(
      (line) =>
        line.start_ms !== null &&
        line.end_ms !== null &&
        line.start_ms <= windowEnd &&
        windowEnd <= line.end_ms + finalLagMs,
    );
    const eligible =
      activeLineIndex >= 0
        ? this.byLine[activeLineIndex]
        : this.words.filter(
            (word) =>
              word.position > this.cursor &&
              overlaps(word, searchFrom, windowEnd),
          );
    if (!eligible.length) return map;

    const isOpen = (w: TimedWord) => w.state === "unknown" || w.clockOmitted;
    let idx = 0;
    while (idx < eligible.length && !isOpen(eligible[idx])) idx++;
    for (const token of heard) {
      if (idx >= eligible.length) break;
      const current = eligible[idx];
      if (wordsMatchForSinging(current.text, token, this.softVoice)) {
        map.set(current.id, "matched");
        idx++;
        while (idx < eligible.length && !isOpen(eligible[idx])) idx++;
        continue;
      }
      // Ignore immediate stutter of previous word
      if (
        idx > 0 &&
        wordsMatchForSinging(eligible[idx - 1].text, token, this.softVoice)
      ) {
        continue;
      }
      // Lookahead up to 3 words in the same line (like Reading previewAlignment)
      let ahead = -1;
      const maxLook = Math.min(eligible.length - 1, idx + 3);
      for (let look = idx + 1; look <= maxLook; look++) {
        if (
          eligible[look].lineIndex === current.lineIndex &&
          isOpen(eligible[look]) &&
          wordsMatchForSinging(eligible[look].text, token, this.softVoice)
        ) {
          ahead = look;
          break;
        }
      }
      if (ahead !== -1) {
        for (let skip = idx; skip < ahead; skip++) {
          if (
            isOpen(eligible[skip]) &&
            map.get(eligible[skip].id) !== "different"
          ) {
            map.set(eligible[skip].id, "omitted");
          }
        }
        map.set(eligible[ahead].id, "matched");
        idx = ahead + 1;
        while (idx < eligible.length && !isOpen(eligible[idx])) idx++;
        continue;
      }
      // Unmatched token at current cursor: mark as temporary substitution
      map.set(current.id, "different");
      idx++;
      while (idx < eligible.length && !isOpen(eligible[idx])) idx++;
    }
    return map;
  }

  /**
   * Tracks continuous playback across timed words while the microphone is
   * active. Any word whose time window was played through without being sung
   * is marked as "omitted" ("Bỏ qua") once its window ends. If interim
   * preview already matched a word (e.g. soft singing), it locks in that
   * match rather than marking it omitted.
   */
  observePlayback(
    fromMs: number,
    toMs: number,
    graceMs = 150,
    preview?: ReadonlyMap<string, LiveWordState>,
  ): boolean {
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      toMs <= fromMs ||
      toMs - fromMs > 650
    )
      return false;
    let changed = false;
    for (const word of this.words) {
      if (word.clockStart === null || word.clockEnd === null) continue;
      const overlap =
        Math.min(toMs, word.clockEnd) - Math.max(fromMs, word.clockStart);
      if (overlap > 0) {
        word.playedMs += overlap;
      }
      const duration = Math.max(1, word.clockEnd - word.clockStart);
      const required = Math.min(180, Math.max(40, duration * 0.35));
      if (
        (word.state === "unknown" || word.clockOmitted) &&
        word.playedMs >= required &&
        toMs >= word.clockEnd + graceMs
      ) {
        const previewState = preview?.get(word.id);
        if (previewState === "matched" || previewState === "different") {
          if (word.state !== previewState || word.clockOmitted) {
            word.state = previewState;
            word.clockOmitted = false;
            changed = true;
          }
        } else if (word.state === "unknown") {
          word.state = "omitted";
          word.clockOmitted = true;
          changed = true;
        }
      }
    }
    return changed;
  }

  flushPlayedOmissions(
    currentMs: number,
    preview?: ReadonlyMap<string, LiveWordState>,
  ): boolean {
    let changed = false;
    for (const word of this.words) {
      if (word.clockStart === null || word.clockEnd === null) continue;
      const duration = Math.max(1, word.clockEnd - word.clockStart);
      const required = Math.min(180, Math.max(40, duration * 0.35));
      if (
        (word.state === "unknown" || word.clockOmitted) &&
        word.playedMs >= required &&
        currentMs >= word.clockStart + required
      ) {
        const previewState = preview?.get(word.id);
        if (previewState === "matched" || previewState === "different") {
          if (word.state !== previewState || word.clockOmitted) {
            word.state = previewState;
            word.clockOmitted = false;
            changed = true;
          }
        } else if (word.state === "unknown") {
          word.state = "omitted";
          word.clockOmitted = true;
          changed = true;
        }
      }
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
