import { describe, expect, it } from "vitest";
import { lyricsSchema, type KaraokeLyrics } from "@/types/karaoke";
import { syllableLyrics } from "@/test/karaoke-fixtures";
import { LiveSingingAttempt } from "@/lib/karaoke/live-singing-score";
import demoV1 from "../../../docs/karaoke-demo/ngoi-sao-nho.json";
import demoV2 from "../../../docs/karaoke-demo/ngoi-sao-nho-v2.json";

function lines(...texts: string[]): KaraokeLyrics {
  return {
    format_version: 1,
    lines: texts.map((text, i) => ({
      id: "line-" + i,
      text,
      start_ms: i * 3000,
      end_ms: (i + 1) * 3000,
    })),
  };
}

describe("timed lyric evidence", () => {
  it("recognizes a stutter once while leaving unresolved repetitions unknown", () => {
    const a = new LiveSingingAttempt(lines("Bé đi"));
    a.accept("bé bé đi", 0, 3000);
    expect(a.result().matchedWords).toBe(2);
    const b = new LiveSingingAttempt(lines("Bé bé đi"));
    b.accept("bé đi", 0, 3000);
    expect(b.result().lineScores[0].words.map((word) => word.state)).toEqual([
      "unknown",
      "unknown",
      "matched",
    ]);
  });

  it("retains unknown edges, proves an interior omission and keeps word positions", () => {
    const a = new LiveSingingAttempt(lines("Nào bé đi học đi"));
    expect(a.accept("BÉ học!", 0, 2800)).toBe(true);
    expect(a.result().lineScores[0].words.map((w) => w.state)).toEqual([
      "unknown",
      "matched",
      "omitted",
      "matched",
      "unknown",
    ]);
    expect(a.result()).toMatchObject({
      kind: "partial",
      matchedWords: 2,
      evaluatedWords: 3,
      totalWords: 5,
      overallAccuracy: null,
    });
    expect(a.accept("BÉ học!", 0, 2800)).toBe(false);
  });

  it("distinguishes clear substitutions from silence, one-sided partial speech and missing timing", () => {
    const a = new LiveSingingAttempt(lines("Bé lá"));
    for (const sample of ["", "…"])
      expect(a.accept(sample, 0, 3000)).toBe(false);
    expect(a.accept("khác lời", 100, 200)).toBe(false);
    expect(a.accept("Bé lá", 5000, 5100)).toBe(false);
    expect(a.result().kind).toBe("insufficient");
    a.accept("BÉ LÀ".normalize("NFD"), 0, 3000);
    expect(a.result()).toMatchObject({
      kind: "whole",
      overallAccuracy: 50,
      evaluatedWords: 2,
    });
    expect(a.result().lineScores[0].words.map((w) => w.state)).toEqual([
      "matched",
      "different",
    ]);
    const other = new LiveSingingAttempt(lines("Bé đi học"));
    expect(other.accept("mèo con vui", 0, 3000)).toBe(true);
    expect(other.result()).toMatchObject({
      kind: "whole",
      overallAccuracy: 0,
      matchedWords: 0,
      evaluatedWords: 3,
    });
  });

  it.each([demoV1, demoV2])(
    "attributes a real repeated chorus to only its played occurrence (format $format_version)",
    (file) => {
      const song = lyricsSchema.parse(file);
      expect(song.lines[0].text).toBe(song.lines[4].text);
      const a = new LiveSingingAttempt(song);
      const later = song.lines[4];
      a.accept(later.text, later.start_ms!, later.end_ms!);
      const summary = a.result();
      expect(summary.kind).toBe("partial");
      expect(summary.lineScores[0].evaluatedWords).toBe(0);
      expect(summary.lineScores[4].matchedWords).toBe(
        summary.lineScores[4].words.length,
      );
      expect(summary.evaluatedWords).toBe(summary.lineScores[4].matchedWords);
    },
  );

  it("recognizes a delayed final from the previous line without moving a shared word across an ambiguous boundary", () => {
    const a = new LiveSingingAttempt(lines("Bé hát", "Hát vui"));
    expect(a.accept("hát", 2900, 3250)).toBe(false);
    expect(a.accept("bé", 3100, 3350)).toBe(true);
    expect(a.result().lineScores.map((l) => l.matchedWords)).toEqual([1, 0]);
  });

  it("never credits a skipped line before capture starts, including the exact boundary", () => {
    for (const captureStart of [3000, 3100]) {
      const attempt = new LiveSingingAttempt(lines("la", "mi"));
      expect(attempt.accept("la", 3200, 3400, captureStart)).toBe(false);
      expect(attempt.result().evaluatedWords).toBe(0);
      expect(attempt.accept("mi", 3200, 3400, captureStart)).toBe(true);
      expect(
        attempt.result().lineScores.map((line) => line.matchedWords),
      ).toEqual([0, 1]);
    }
    const continuous = new LiveSingingAttempt(lines("la", "mi"));
    expect(continuous.accept("la", 3200, 3400, 2800)).toBe(true);
  });

  it("uses syllable IDs and clocks even for repeating words within one line", () => {
    const song = syllableLyrics();
    song.lines[0].text = "Bé bé vui";
    song.lines[0].syllables![1].text = "bé";
    const a = new LiveSingingAttempt(song);
    a.accept("bé", 1800, 2500);
    const words = a.result().lineScores[0].words;
    expect(words.map((w) => w.state)).toEqual([
      "unknown",
      "matched",
      "unknown",
    ]);
    expect(words[1].syllableId).toBe(song.lines[0].syllables![1].id);
    expect(words[1].id).not.toBe(words[0].id);
  });

  it("combines successive captures in order, without spending confidence on unmapped extra words", () => {
    const a = new LiveSingingAttempt(lines("Trời xanh bé hát"));
    a.accept("ờ bé ừm", 0, 900);
    expect(a.accept("trời", 900, 1500)).toBe(false);
    a.accept("hát", 1500, 2200);
    expect(a.result().lineScores[0].words.map((w) => w.state)).toEqual([
      "unknown",
      "unknown",
      "matched",
      "matched",
    ]);
  });

  it("uses the exact coverage boundary for grading and keeps practice partial even for perfect coverage", () => {
    const song = lines(
      "bé đi chơi vui",
      "con chim hót hay",
      "trời xanh nắng lên",
      "mẹ đang ở nhà",
      "bé thương mẹ nhiều",
    );
    const a = new LiveSingingAttempt(song);
    for (let i = 0; i < 3; i++)
      a.accept(song.lines[i].text, i * 3000, (i + 1) * 3000);
    a.accept("mẹ đang ở", 9000, 11000);
    expect(a.result()).toMatchObject({
      kind: "partial",
      overallAccuracy: null,
      matchedWords: 15,
      evaluatedWords: 15,
      totalWords: 20,
    });
    const b = new LiveSingingAttempt(song);
    for (let i = 0; i < 3; i++)
      b.accept(song.lines[i].text, i * 3000, (i + 1) * 3000);
    b.accept("anh mới đi xa", 9000, 12000);
    expect(b.result()).toMatchObject({
      kind: "whole",
      overallAccuracy: 75,
      matchedWords: 12,
      evaluatedWords: 16,
      totalWords: 20,
    });
    expect(b.result(true)).toMatchObject({
      kind: "partial",
      overallAccuracy: null,
    });
  });
});
