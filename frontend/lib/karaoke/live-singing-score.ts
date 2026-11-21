import { tokenizeSingingText } from "./singing-text";
import type { KaraokeLine, KaraokeLyrics } from "@/types/karaoke";

export type LiveWordState = "matched" | "different" | "omitted" | "unknown";

export type WordPhase = "upcoming" | "listening" | "processing" | "settled";
export type SingingActivity = "voice" | "quiet" | "uncertain";

export interface LiveWord {
  id: string;
  syllableId: string | null;
  text: string;
  state: LiveWordState;
  phase?: WordPhase;
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
  quietMs: number;
  uncertainAudio: boolean;
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
    const tokens = tokenizeSingingText(segment.text);
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
        quietMs: 0,
        uncertainAudio: false,
        phase: "upcoming",
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
  private lastAudioEnd = -1;
  private capture: {
    id: string;
    revision: number;
    cursor: number;
    lastEnd: number;
    words: { state: LiveWordState; phase: WordPhase | undefined }[];
  } | null = null;

  beginCapture(id = "capture"): void {
    this.beginTranscriptGroup(id);
    this.lastAudioEnd = -1;
    for (const word of this.words) {
      word.quietMs = 0;
      word.uncertainAudio = false;
    }
  }

  /** A transcript discontinuity does not restart the physical microphone.
   * Preserve its quiet/voice evidence until this capture drains or aborts. */
  beginTranscriptGroup(id: string): void {
    this.capture = {
      id,
      revision: 0,
      cursor: this.cursor,
      lastEnd: this.lastEnd,
      words: this.words.map(({ state, phase }) => ({ state, phase })),
    };
  }

  closeCapture(): void {
    this.capture = null;
  }

  /** Re-evaluate only the current capture as its final fragments accumulate.
   * Earlier captures are the immutable baseline. Revisions are ordered and
   * scoped to an identity so a seek/retry cannot rewrite a different attempt. */
  acceptCapture(
    id: string,
    revision: number,
    text: string,
    fromMs: number,
    toMs: number,
    earliestCapturedMs: number,
  ): boolean {
    const capture = this.capture;
    if (
      !capture ||
      id !== capture.id ||
      !Number.isSafeInteger(revision) ||
      revision <= capture.revision ||
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      !Number.isFinite(earliestCapturedMs) ||
      earliestCapturedMs < 0 ||
      fromMs < earliestCapturedMs ||
      toMs <= fromMs ||
      toMs - fromMs > 12000 ||
      !tokenizeSingingText(text).length
    )
      return false;
    const before = this.words.map((word) => word.state);
    capture.revision = revision;
    this.cursor = capture.cursor;
    this.lastEnd = capture.lastEnd;
    this.words.forEach((word, i) => {
      word.state = capture.words[i].state;
      // Preserve playback phase for words left unassessed by this revision.
      if (word.state !== "unknown") word.phase = capture.words[i].phase;
      else if (word.phase === "settled")
        word.phase = word.playedMs > 0 ? "processing" : "upcoming";
    });
    this.accept(text, fromMs, toMs, earliestCapturedMs);
    return this.words.some((word, i) => word.state !== before[i]);
  }

  noteSpeech(fromMs: number, toMs: number): void {
    for (const word of this.words) {
      if (overlaps(word, fromMs, toMs)) word.uncertainAudio = true;
    }
  }

  constructor(private readonly lyrics: KaraokeLyrics) {
    this.byLine = lyrics.lines.map((line, i) => {
      const words = wordsInLine(line, i, this.words.length);
      this.words.push(...words);
      return words;
    });
  }

  private align(
    text: string,
    fromMs: number,
    toMs: number,
    earliestCapturedMs = 0,
  ): Map<string, LiveWordState> {
    const decisions = new Map<string, LiveWordState>();
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      !Number.isFinite(earliestCapturedMs) ||
      earliestCapturedMs < 0 ||
      fromMs < earliestCapturedMs ||
      toMs <= fromMs
    )
      return decisions;
    const heard = tokenizeSingingText(text);
    if (!heard.length) return decisions;
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
    if (!eligible.length) return decisions;
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
    const mark = (word: TimedWord, state: LiveWordState) => {
      if (word.state === "unknown") decisions.set(word.id, state);
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
    return decisions;
  }

  accept(
    text: string,
    fromMs: number,
    toMs: number,
    earliestCapturedMs = 0,
  ): boolean {
    const decisions = this.align(text, fromMs, toMs, earliestCapturedMs);
    for (const word of this.words) {
      const state = decisions.get(word.id);
      if (!state) continue;
      word.state = state;
      word.phase = "settled";
      this.cursor = Math.max(this.cursor, word.position);
    }
    if (decisions.size) this.lastEnd = Math.max(this.lastEnd, toMs);
    return decisions.size > 0;
  }

  /** Interim and final use identical positional evidence; preview never commits. */
  preview(
    text: string,
    fromMs: number,
    toMs: number,
    earliestCapturedMs = 0,
  ): Map<string, LiveWordState> {
    return this.align(text, fromMs, toMs, earliestCapturedMs);
  }

  /** Playback measures exposure, not whether a child sang a word. */
  observePlayback(fromMs: number, toMs: number): boolean {
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      toMs <= fromMs ||
      toMs - fromMs > 650
    )
      return false;
    let changed = false;
    for (const word of this.words) {
      if (
        word.clockStart === null ||
        word.clockEnd === null ||
        word.state !== "unknown"
      )
        continue;
      const overlap =
        Math.min(toMs, word.clockEnd) - Math.max(fromMs, word.clockStart);
      if (word.phase === "settled" && overlap <= 0) continue;
      if (overlap > 0) word.playedMs += overlap;
      const phase: WordPhase =
        word.playedMs === 0
          ? "upcoming"
          : toMs < word.clockEnd
            ? "listening"
            : "processing";
      if (phase !== word.phase) {
        word.phase = phase;
        changed = true;
      }
    }
    return changed;
  }

  /** Quiet is useful only on a live, unmuted, calibrated input. A small
   * ambiguous/voiced interval prevents a silence verdict for the entire unit.
   * v1 uses the whole line, never the invented evenly spaced word clock. */
  observeAudio(fromMs: number, toMs: number, activity: SingingActivity): void {
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      toMs <= fromMs ||
      toMs - fromMs > 250 ||
      fromMs < this.lastAudioEnd
    )
      return;
    this.lastAudioEnd = toMs;
    for (const word of this.words) {
      if (word.start === null || word.end === null) continue;
      const overlap = Math.min(toMs, word.end) - Math.max(fromMs, word.start);
      if (overlap <= 0) continue;
      if (activity === "quiet") word.quietMs += overlap;
      else word.uncertainAudio = true;
    }
  }

  /** Called only after a capture has drained successfully. A timeout, pause,
   * network failure or mere playback tick is not a silence confirmation. */
  settleThrough(capturedEndMs: number): boolean {
    if (!Number.isFinite(capturedEndMs)) return false;
    let changed = false;
    for (const word of this.words) {
      if (
        word.state !== "unknown" ||
        word.start === null ||
        word.end === null ||
        word.uncertainAudio
      )
        continue;
      // Capture is sliced at line ends. Requiring samples beyond that boundary
      // makes a fully silent line impossible to assess. Use its actual timed
      // interval; successful drain still allows delayed ASR to contradict it.
      const end = word.end;
      const duration = end - word.start;
      if (duration <= 0) continue;
      if (capturedEndMs >= end && word.quietMs >= duration * 0.98) {
        word.state = "omitted";
        word.phase = "settled";
        changed = true;
      }
    }
    return changed;
  }

  /** Close unresolved exposure without inventing omissions when ASR is absent. */
  flushPlayedOmissions(currentMs: number): boolean {
    if (!Number.isFinite(currentMs)) return false;
    let changed = false;
    for (const word of this.words) {
      if (word.playedMs > 0 && word.phase !== "settled") {
        word.phase = "settled";
        changed = true;
      }
    }
    return changed;
  }

  result(practice = false): LiveSingingScore {
    let matchedWords = 0;
    let evaluatedWords = 0;
    const lineScores = this.byLine.map((lineWords, lineIndex) => {
      const words = lineWords.map(({ id, syllableId, text, state, phase }) => ({
        id,
        syllableId,
        text,
        state,
        phase,
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
