import { describe, expect, it } from "vitest";

import {
  scoreLine,
  scoreFromFullTranscript,
  scoreSong,
} from "@/lib/karaoke/singing-score";
import type { KaraokeLine, KaraokeLyrics } from "@/types/karaoke";

function line(text: string, index = 0): KaraokeLine {
  return {
    id: crypto.randomUUID(),
    text,
    start_ms: index * 5000,
    end_ms: (index + 1) * 5000 - 200,
  };
}

function lyrics(texts: string[]): KaraokeLyrics {
  return {
    format_version: 1,
    lines: texts.map((t, i) => line(t, i)),
  };
}

describe("scoreLine", () => {
  it("gives 100% for a perfect match", () => {
    const result = scoreLine(0, line("Bé đi học"), "Bé đi học");
    expect(result.accuracy).toBe(100);
    expect(result.wordMatches.every((m) => m.matched)).toBe(true);
  });

  it("gives 100% for exact match with extra spoken words", () => {
    const result = scoreLine(0, line("Bé đi"), "à Bé ừm đi nhé");
    expect(result.accuracy).toBe(100);
  });

  it("gives 0% when nothing was spoken", () => {
    const result = scoreLine(0, line("Bé đi học"), "");
    expect(result.accuracy).toBe(0);
    expect(result.wordMatches.every((m) => !m.matched)).toBe(true);
  });

  it("scores partial matches correctly", () => {
    const result = scoreLine(0, line("Bé đi học vui"), "Bé vui");
    // "Bé" matches, "đi" doesn't match (vui already consumed), "học" doesn't, "vui" matches
    // Sequential scan: Bé → matched. đi → scan "vui" no match. học → no match. vui → no spoken left after "vui" consumed for Bé.
    // Actually: spoken = ["bé", "vui"]. Expected = ["bé", "đi", "học", "vui"]
    // bé: scan from 0, spokenTokens[0]="bé" -> match, cursor=1
    // đi: scan from 1, spokenTokens[1]="vui" != "đi" -> no match
    // học: scan from 1, spokenTokens[1]="vui" != "học" -> no match
    // vui: scan from 1, spokenTokens[1]="vui" -> match, cursor=2
    expect(result.accuracy).toBe(50); // 2/4
  });

  it("handles Vietnamese diacritics correctly", () => {
    const result = scoreLine(0, line("Mèo con đáng yêu"), "mèo con đáng yêu");
    expect(result.accuracy).toBe(100);
  });

  it("handles completely wrong words", () => {
    const result = scoreLine(0, line("Bé đi học"), "Mèo con chơi");
    expect(result.accuracy).toBe(0);
  });

  it("gives 100% for empty lyrics line", () => {
    const result = scoreLine(0, line(""), "some words");
    expect(result.accuracy).toBe(100);
  });

  it("strips punctuation during comparison", () => {
    const result = scoreLine(0, line("Xin chào, bạn!"), "xin chào bạn");
    expect(result.accuracy).toBe(100);
  });
});

describe("scoreSong", () => {
  it("scores all lines independently", () => {
    const ly = lyrics(["Bé đi", "Mèo chơi"]);
    const spoken = new Map<number, string>();
    spoken.set(0, "Bé đi");
    spoken.set(1, "Mèo ngủ");

    const result = scoreSong(ly, spoken);
    expect(result.lineScores).toHaveLength(2);
    expect(result.lineScores[0].accuracy).toBe(100);
    expect(result.lineScores[1].accuracy).toBe(50); // Mèo matched, chơi not
  });

  it("treats missing lines as 0%", () => {
    const ly = lyrics(["Bé đi", "Mèo chơi"]);
    const spoken = new Map<number, string>();
    spoken.set(0, "Bé đi");
    // Line 1 not provided

    const result = scoreSong(ly, spoken);
    expect(result.lineScores[1].accuracy).toBe(0);
    expect(result.overallAccuracy).toBe(50); // 2 of 4 words
  });

  it("computes overall accuracy across all lines", () => {
    const ly = lyrics(["Bé đi học", "Mèo con chơi"]);
    const spoken = new Map<number, string>();
    spoken.set(0, "Bé đi học");
    spoken.set(1, "Mèo con chơi");

    const result = scoreSong(ly, spoken);
    expect(result.overallAccuracy).toBe(100);
    expect(result.totalWords).toBe(6);
    expect(result.matchedWords).toBe(6);
  });
});

describe("scoreFromFullTranscript", () => {
  it("preserves tones while matching decomposed Vietnamese text", () => {
    const ly = lyrics(["Bé lá"]);
    const result = scoreFromFullTranscript(ly, "BÉ LÀ".normalize("NFD"));

    expect(result.matchedWords).toBe(1);
    expect(
      result.lineScores[0].wordMatches.map((word) => word.matched),
    ).toEqual([true, false]);
  });

  it("identifies the actual matching positions around a skipped syllable", () => {
    const result = scoreFromFullTranscript(lyrics(["Bé đi học"]), "bé học");
    const matches = result.lineScores[0].wordMatches;

    expect(matches.map((word) => word.matched)).toEqual([true, false, true]);
  });

  it("matches words sequentially across lines", () => {
    const ly = lyrics(["Bé đi học", "Mèo con chơi"]);
    const result = scoreFromFullTranscript(ly, "Bé đi học Mèo con chơi");

    expect(result.overallAccuracy).toBe(100);
    expect(result.totalWords).toBe(6);
    expect(result.matchedWords).toBe(6);
  });

  it("handles partial matches from full transcript", () => {
    const ly = lyrics(["Bé đi học", "Mèo con chơi"]);
    const result = scoreFromFullTranscript(ly, "Bé đi Mèo chơi");

    // bé → match, đi → match, học → scan "mèo","chơi" → no.
    // mèo → match, con → scan "chơi" → no, chơi → match
    expect(result.matchedWords).toBe(4);
    expect(result.overallAccuracy).toBe(67); // 4/6 ≈ 66.7 → rounds to 67
  });

  it("gives 0% for empty transcript", () => {
    const ly = lyrics(["Bé đi học"]);
    const result = scoreFromFullTranscript(ly, "");
    expect(result.overallAccuracy).toBe(0);
  });

  it("gives 100% for empty lyrics", () => {
    const ly: KaraokeLyrics = { format_version: 1, lines: [] };
    const result = scoreFromFullTranscript(ly, "some words");
    expect(result.overallAccuracy).toBe(100);
    expect(result.lineScores).toHaveLength(0);
  });
});
