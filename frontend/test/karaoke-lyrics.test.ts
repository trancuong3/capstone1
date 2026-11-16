import { describe, expect, it } from "vitest";
import { importLyrics } from "@/lib/karaoke/lyrics-import";
import {
  activeLyricIndex,
  formatLyricTimestamp,
  timingIssues,
} from "@/lib/karaoke/lyrics-timeline";
import { lyricsSchema } from "@/types/karaoke";
import { lineId } from "@/test/karaoke-fixtures";

describe("karaoke lyric import", () => {
  it("normalizes BOM, NFC and CRLF without inventing TXT timing", () => {
    const result = importLyrics(
      "\uFEFFBe\u0301 vui\r\n\r\n Đến trường ",
      "txt",
      20000,
    );
    expect(result.lyrics.lines.map((l) => l.text)).toEqual([
      "Bé vui",
      "Đến trường",
    ]);
    expect(
      result.lyrics.lines.every(
        (l) => l.start_ms === null && l.end_ms === null,
      ),
    ).toBe(true);
    expect(new Set(result.lyrics.lines.map((l) => l.id)).size).toBe(2);
    expect(result.suggestedEnds).toBe(false);
  });
  it("expands LRC timestamps, applies offsets and marks suggested ends", () => {
    const result = importLyrics(
      "[ti:Tên bài]\n[offset:-100]\n[00:01.20][00:04.500]Bé hát\n[00:03.00]Cả nhà vui",
      "lrc",
      6000,
    );
    expect(
      result.lyrics.lines.map((l) => [l.text, l.start_ms, l.end_ms]),
    ).toEqual([
      ["Bé hát", 1100, 2900],
      ["Cả nhà vui", 2900, 4400],
      ["Bé hát", 4400, 6000],
    ]);
    expect(result.suggestedEnds).toBe(true);
  });
  it("keeps the final LRC end unknown without audio", () => {
    expect(
      importLyrics("[00:01.000]Bé hát", "lrc", null).lyrics.lines[0].end_ms,
    ).toBeNull();
  });
  it.each([
    "[00:01.00]a\n[00:01.00]b",
    "[offset:-2000]\n[00:01.00]a",
    "[00:01.00]<00:01.10>a",
    "[00:90.00]a",
    "[offset:nope]",
    "[00:01.00]",
    "hello",
  ])("rejects malformed LRC: %s", (input) => {
    expect(() => importLyrics(input, "lrc", 20000)).toThrow();
  });
  it.each([
    "",
    "x".repeat(301),
    Array.from({ length: 301 }, () => "a").join("\n"),
    "x\u0000y",
    "x".repeat(262145),
  ])("rejects empty, oversized or control-character TXT", (input) => {
    expect(() => importLyrics(input, "txt", null)).toThrow();
  });
  it("treats markup as plain text", () => {
    expect(
      importLyrics("<img src=x onerror=alert(1)>", "txt", null).lyrics.lines[0]
        .text,
    ).toBe("<img src=x onerror=alert(1)>");
  });
  it("preserves canonical JSON IDs/order and incomplete timing", () => {
    const data = {
      format_version: 1,
      lines: [{ id: lineId, text: "Bé hát", start_ms: null, end_ms: null }],
    };
    expect(importLyrics(JSON.stringify(data), "json", 20000).lyrics).toEqual(
      data,
    );
  });
  it.each([true, 3, "1"])("rejects unsupported version %s", (version) => {
    expect(() =>
      importLyrics(
        JSON.stringify({ format_version: version, lines: [] }),
        "json",
        null,
      ),
    ).toThrow();
  });
  it("rejects duplicate IDs, floats and non-finite numbers", () => {
    const item = { id: lineId, text: "Bé hát", start_ms: 1000, end_ms: 2000 };
    expect(
      lyricsSchema.safeParse({ format_version: 1, lines: [item, item] })
        .success,
    ).toBe(false);
    for (const start_ms of [1.5, Infinity, NaN, -1, 300001])
      expect(
        lyricsSchema.safeParse({
          format_version: 1,
          lines: [{ ...item, start_ms }],
        }).success,
      ).toBe(false);
  });
  it("does not silently repair JSON chronology", () => {
    const a = { id: lineId, text: "Bé hát", start_ms: 3000, end_ms: 4000 };
    const b = { ...a, id: crypto.randomUUID(), start_ms: 1000, end_ms: 2000 };
    const result = importLyrics(
      JSON.stringify({ format_version: 1, lines: [a, b] }),
      "json",
      5000,
    );
    expect(result.lyrics.lines).toEqual([a, b]);
    expect(timingIssues(result.lyrics.lines, 5000).join(" ")).toContain(
      "sai thứ tự",
    );
  });
});
describe("karaoke timeline", () => {
  it("shows exact millisecond timestamps and distinguishes unset from zero", () => {
    expect(formatLyricTimestamp(62501)).toBe("01:02.501");
    expect(formatLyricTimestamp(0)).toBe("00:00.000");
    expect(formatLyricTimestamp(null)).toBe("Chưa đặt");
  });
  const lines = [
    { id: lineId, text: "Một", start_ms: 1000, end_ms: 2000 },
    { id: crypto.randomUUID(), text: "Hai", start_ms: 3000, end_ms: 4000 },
  ];
  it.each([
    [0, -1],
    [1000, 0],
    [1999, 0],
    [2000, -1],
    [2500, -1],
    [3000, 1],
    [4000, -1],
  ])("uses audio clock at %d ms", (ms, index) => {
    expect(activeLyricIndex(lines, ms)).toBe(index);
  });
  it("detects missing, overlapping and out-of-range times", () => {
    expect(
      timingIssues(
        [
          { ...lines[0], start_ms: null },
          { ...lines[1], start_ms: 5000, end_ms: 4000 },
        ],
        3500,
      ),
    ).toHaveLength(3);
    expect(
      timingIssues([{ ...lines[0], end_ms: 3500 }, lines[1]], 5000).join(" "),
    ).toContain("chồng lấn");
  });
});
