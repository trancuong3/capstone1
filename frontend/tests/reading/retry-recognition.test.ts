import { describe, expect, it } from "vitest";

import {
  isRetryWordRecognized,
  normalizeRetryText,
  sortRetryWordRecords,
  type RetryWordRecord,
} from "@/lib/reading/retry-recognition";

describe("retry speech recognition", () => {
  it("normalizes casing, punctuation, and composed Vietnamese text", () => {
    expect(normalizeRetryText("MÈO, nhỏ!")).toBe("mèo nhỏ");
  });

  it("accepts the target as a standalone word", () => {
    expect(isRetryWordRecognized("mèo", ["Mèo"])).toBe(true);
  });

  it("accepts the target as a complete word in the suggested phrase", () => {
    expect(isRetryWordRecognized("mèo", ["Bé mèo nhỏ đang ngủ."])).toBe(true);
  });

  it("checks every supplied recognition alternative instead of only the first", () => {
    expect(isRetryWordRecognized("mèo", ["Bé méo nhỏ", "Bé mèo nhỏ"])).toBe(
      true,
    );
  });

  it("does not accept a substring as a complete word", () => {
    expect(isRetryWordRecognized("con", ["conmèo"])).toBe(false);
  });

  it("preserves Vietnamese tone marks when comparing words", () => {
    expect(isRetryWordRecognized("mèo", ["meo"])).toBe(false);
    expect(isRetryWordRecognized("mèo", ["méo"])).toBe(false);
  });

  it("rejects empty targets and empty transcripts", () => {
    expect(isRetryWordRecognized(" ", ["Bé mèo"])).toBe(false);
    expect(isRetryWordRecognized("mèo", [" ", ""])).toBe(false);
  });
});

describe("retry word queue ordering", () => {
  const word = (
    word_id: string,
    page_number: number,
    word_index: number,
  ): RetryWordRecord => ({
    word_id,
    page_id: `page-${page_number}`,
    page_revision_id: `revision-${page_number}`,
    page_number,
    word_index,
    text: word_id,
    original_status: "MISPRONUNCIATION",
  });

  it("orders retry candidates by page and then by word position", () => {
    const records = [
      word("p2w0", 2, 0),
      word("p1w3", 1, 3),
      word("p1w1", 1, 1),
      word("p2w2", 2, 2),
    ];

    expect(sortRetryWordRecords(records).map((item) => item.word_id)).toEqual([
      "p1w1",
      "p1w3",
      "p2w0",
      "p2w2",
    ]);
  });

  it("uses word id as a deterministic tie-breaker", () => {
    const records = [word("word-b", 1, 4), word("word-a", 1, 4)];

    expect(sortRetryWordRecords(records).map((item) => item.word_id)).toEqual([
      "word-a",
      "word-b",
    ]);
  });

  it("returns an empty queue when there are no unresolved words", () => {
    expect(sortRetryWordRecords([])).toEqual([]);
  });
});
