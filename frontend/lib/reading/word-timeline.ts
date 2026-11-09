import type { WordTiming } from "@/lib/api/voice-studio-service";

/**
 * Highlight a little before the exact start: a frame of rendering latency
 * (~16 ms) plus the audio output buffer would otherwise make the mark trail
 * the voice.
 */
export const HIGHLIGHT_LEAD_SECONDS = 0.04;

/**
 * Index of the word being spoken at `time`: the last word whose start is not
 * after `time`. Before the first word it is 0; after the last it stays on the
 * last word. `words` must be sorted by start (the backend guarantees it).
 */
export function findActiveWordIndex(
  words: readonly Pick<WordTiming, "start">[],
  time: number,
): number {
  if (words.length === 0 || !Number.isFinite(time)) return -1;
  let low = 0;
  let high = words.length - 1;
  let answer = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[middle].start <= time) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}
