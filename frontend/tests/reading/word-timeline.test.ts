import { describe, expect, it } from "vitest";

import {
  findActiveWordIndex,
  HIGHLIGHT_LEAD_SECONDS,
} from "@/lib/reading/word-timeline";

const timeline = [
  { start: 0.1 },
  { start: 0.6 },
  { start: 1.0 },
  { start: 1.9 },
];

describe("findActiveWordIndex", () => {
  it("returns the last word that has already started", () => {
    expect(findActiveWordIndex(timeline, 0.1)).toBe(0);
    expect(findActiveWordIndex(timeline, 0.59)).toBe(0);
    expect(findActiveWordIndex(timeline, 0.6)).toBe(1);
    expect(findActiveWordIndex(timeline, 1.5)).toBe(2);
    expect(findActiveWordIndex(timeline, 1.9)).toBe(3);
  });

  it("stays on the first word before speech and on the last word after it", () => {
    expect(findActiveWordIndex(timeline, 0)).toBe(0);
    expect(findActiveWordIndex(timeline, 99)).toBe(3);
  });

  it("handles empty or invalid input", () => {
    expect(findActiveWordIndex([], 1)).toBe(-1);
    expect(findActiveWordIndex(timeline, Number.NaN)).toBe(-1);
  });

  it("matches a linear scan on a long timeline", () => {
    const long = Array.from({ length: 500 }, (_, index) => ({
      start: index * 0.37,
    }));
    for (const time of [0, 0.2, 18.5, 100.01, 184.6, 500]) {
      let expected = 0;
      long.forEach((word, index) => {
        if (word.start <= time) expected = index;
      });
      expect(findActiveWordIndex(long, time)).toBe(expected);
    }
  });

  it("uses a small lead so the mark does not trail the voice", () => {
    expect(HIGHLIGHT_LEAD_SECONDS).toBeGreaterThan(0);
    expect(HIGHLIGHT_LEAD_SECONDS).toBeLessThanOrEqual(0.08);
  });
});
