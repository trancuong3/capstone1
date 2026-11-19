import { describe, expect, it } from "vitest";
import {
  prepareWizardLyrics,
  suggestRepeatedLyrics,
} from "@/lib/karaoke/wizard-lyrics";

describe("explicit repeated lyric proposals", () => {
  it.each(["×2", "x2", "X 2", "(×2)", "[x2]"])(
    "expands a line suffix %s without inventing text or timing",
    (marker) => {
      const proposal = suggestRepeatedLyrics(
        `Bé hát, vui! ${marker}\r\nCùng bạn.`,
      )!;
      expect(proposal).toEqual({
        text: "Bé hát, vui!\nBé hát, vui!\nCùng bạn.",
        markedLines: 1,
        error: null,
      });
      const lyrics = prepareWizardLyrics(
        proposal.text,
        { format_version: 2, lines: [] },
        null,
      );
      expect(new Set(lyrics.lines.map((line) => line.id)).size).toBe(3);
      expect(
        lyrics.lines.every((line) =>
          line.syllables?.every(
            (s) => s.start_ms === null && s.end_ms === null,
          ),
        ),
      ).toBe(true);
    },
  );
  it.each([
    "Bé hát\nx2",
    "Bé hát ×1",
    "Bé hát ×0",
    "Bé hát ×99",
    "Bé hát x2 rồi vui",
    "x2",
    "Bé hát (x2]",
    "Bé hát",
  ])("leaves ambiguous or unsupported notation unchanged: %s", (text) => {
    expect(suggestRepeatedLyrics(text)).toBeNull();
  });
  it("proposes multiple repeats in sequence and keeps punctuation", () => {
    expect(suggestRepeatedLyrics("A! ×3\nB? ×2")?.text).toBe(
      "A!\nA!\nA!\nB?\nB?",
    );
  });
  it("does not produce an actionable proposal over the line or text limits", () => {
    expect(
      suggestRepeatedLyrics(Array(151).fill("Bé hát ×2").join("\n"))?.error,
    ).toBeTruthy();
    expect(suggestRepeatedLyrics(`${"a".repeat(301)} ×2`)?.error).toBeTruthy();
    expect(
      suggestRepeatedLyrics(`${Array(151).fill("a").join(" ")} ×2`)?.error,
    ).toBeTruthy();
  });
  it("keeps unchanged IDs while repeated new lines get separate IDs", () => {
    const old = prepareWizardLyrics(
      "Cùng bạn.\nBé hát ×2",
      { format_version: 2, lines: [] },
      null,
    );
    const next = prepareWizardLyrics(
      suggestRepeatedLyrics("Cùng bạn.\nBé hát ×2")!.text,
      old,
      null,
    );
    expect(next.lines[0]).toEqual(old.lines[0]);
    expect(
      new Set(
        next.lines.flatMap((line) => [
          line.id,
          ...line.syllables!.map((s) => s.id),
        ]),
      ).size,
    ).toBe(9);
  });
});
