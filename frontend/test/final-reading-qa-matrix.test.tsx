import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BookPageContent } from "@/components/reading/book-page-content";
import { computeUniversalPageWordLayout } from "@/lib/reading/ocr-text-reflow";
import { matchPhonicsSpelling } from "@/lib/reading/phonics-spelling";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  isVoiceExitSentenceReinforcement,
  SentenceReinforcementTracker,
  shouldEscapeToUpcomingWords,
} from "@/lib/reading/sentence-reinforcement";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

function makeWord(
  idx: number,
  text: string,
  lineIndex: number,
  bbox: [number, number, number, number],
): ReadingPageWordDTO {
  return {
    word_id: `w-${idx}`,
    word_index: idx,
    text,
    line_index: lineIndex,
    bbox,
  };
}

function makePage(words: ReadingPageWordDTO[], text?: string): ReadingPageDTO {
  return {
    page_id: "page-qa-1",
    page_number: 1,
    page_revision_id: "rev-qa-1",
    width: 1000,
    height: 1400,
    confidence: 0.99,
    text: text ?? words.map((w) => w.text).join(" "),
    words,
  };
}

describe("QA-01..QA-05: Universal OCR Text Reflow (Presentation-Only, Zero Data Mutation)", () => {
  afterEach(() => cleanup());

  it("QA-01: merges prose OCR mid-sentence line cuts while preserving word_id, order, text, diacritics & bbox", () => {
    const words = [
      makeWord(0, "Sáng", 0, [0.1, 0.1, 0.08, 0.03]),
      makeWord(1, "chủ", 0, [0.2, 0.1, 0.07, 0.03]),
      makeWord(2, "nhật,", 0, [0.3, 0.1, 0.09, 0.03]),
      makeWord(3, "bé", 0, [0.42, 0.1, 0.05, 0.03]),
      makeWord(4, "Lan", 0, [0.5, 0.1, 0.07, 0.03]),
      makeWord(5, "theo", 1, [0.1, 0.145, 0.08, 0.03]),
      makeWord(6, "ông", 1, [0.2, 0.145, 0.07, 0.03]),
      makeWord(7, "ra", 1, [0.3, 0.145, 0.05, 0.03]),
      makeWord(8, "vườn.", 1, [0.37, 0.145, 0.1, 0.03]),
    ];
    const page = makePage(words, "Sáng chủ nhật, bé Lan\ntheo ông ra vườn.");

    const reflow = computeUniversalPageWordLayout(page);
    expect(reflow.mode).toBe("prose");
    // Line 1 ("theo ...") starts lowercase -> merged seamlessly with breakCount = 0!
    expect(reflow.entries[5]?.breakCount).toBe(0);
    // Invariants: word_id, order, text, bbox 100% untouched
    expect(reflow.entries.map((e) => e.word.word_id)).toEqual(
      words.map((w) => w.word_id),
    );
    expect(reflow.entries.map((e) => e.word.text)).toEqual(
      words.map((w) => w.text),
    );
    expect(reflow.entries.map((e) => e.word.bbox)).toEqual(
      words.map((w) => w.bbox),
    );

    render(<BookPageContent page={page} currentWordId="w-0" />);
    const panel = screen
      .getByText("Sáng")
      .closest("[data-reading-panel='text']");
    expect(panel?.getAttribute("data-reflow-mode")).toBe("prose");
  });

  it("QA-02: preserves verse line breaks on Vietnamese poetry", () => {
    const poemLines = [
      ["Trăng", "lên", "đỉnh", "núi", "cao"],
      ["Gió", "thổi", "mát", "rì", "rào"],
      ["Bé", "ngồi", "nghe", "bà", "kể"],
      ["Chuyện", "cổ", "tích", "hôm", "nào."],
    ];
    const words: ReadingPageWordDTO[] = [];
    poemLines.forEach((line, lIdx) => {
      line.forEach((t, wIdx) => {
        words.push(
          makeWord(words.length, t, lIdx, [
            0.2 + wIdx * 0.08,
            0.1 + lIdx * 0.05,
            0.07,
            0.03,
          ]),
        );
      });
    });
    const page = makePage(words, poemLines.map((l) => l.join(" ")).join("\n"));

    const reflow = computeUniversalPageWordLayout(page);
    expect(reflow.mode).toBe("poetry");
    // Every new verse starts with breakCount >= 1
    expect(reflow.entries[5]?.breakCount).toBe(1);
    expect(reflow.entries[10]?.breakCount).toBe(1);
    expect(reflow.entries[15]?.breakCount).toBe(1);
  });

  it("QA-03: preserves dialogue speaker lines cleanly", () => {
    const words = [
      makeWord(0, "-", 0, [0.1, 0.1, 0.02, 0.03]),
      makeWord(1, "Hôm", 0, [0.14, 0.1, 0.08, 0.03]),
      makeWord(2, "nay", 0, [0.24, 0.1, 0.07, 0.03]),
      makeWord(3, "con", 0, [0.33, 0.1, 0.07, 0.03]),
      makeWord(4, "học", 0, [0.42, 0.1, 0.07, 0.03]),
      makeWord(5, "gì?", 0, [0.51, 0.1, 0.06, 0.03]),
      makeWord(6, "-", 1, [0.1, 0.145, 0.02, 0.03]),
      makeWord(7, "Dạ,", 1, [0.14, 0.145, 0.06, 0.03]),
      makeWord(8, "con", 1, [0.22, 0.145, 0.07, 0.03]),
      makeWord(9, "đọc", 1, [0.31, 0.145, 0.07, 0.03]),
      makeWord(10, "sách!", 1, [0.4, 0.145, 0.09, 0.03]),
    ];
    const page = makePage(words, "- Hôm nay con học gì?\n- Dạ, con đọc sách!");
    const reflow = computeUniversalPageWordLayout(page);
    expect(reflow.entries[6]?.breakCount).toBeGreaterThanOrEqual(1);
  });

  it("QA-04: separates ALL-CAPS heading/title from body prose", () => {
    const words = [
      makeWord(0, "BÀI", 0, [0.35, 0.08, 0.08, 0.035]),
      makeWord(1, "TẬP", 0, [0.45, 0.08, 0.08, 0.035]),
      makeWord(2, "ĐỌC", 0, [0.55, 0.08, 0.08, 0.035]),
      makeWord(3, "12", 0, [0.65, 0.08, 0.05, 0.035]),
      makeWord(4, "Bé", 1, [0.1, 0.18, 0.06, 0.03]),
      makeWord(5, "Minh", 1, [0.18, 0.18, 0.09, 0.03]),
      makeWord(6, "đi", 1, [0.29, 0.18, 0.05, 0.03]),
      makeWord(7, "học.", 1, [0.36, 0.18, 0.08, 0.03]),
    ];
    const page = makePage(words, "BÀI TẬP ĐỌC 12\n\nBé Minh đi học.");
    const reflow = computeUniversalPageWordLayout(page);
    expect(reflow.entries[0]?.isHeadingLine).toBe(true);
    expect(reflow.entries[4]?.breakCount).toBe(2);
  });

  it("QA-05: falls back to source-preserved mode on ambiguous multi-column pages", () => {
    const words = [
      // Column 1 bottom
      makeWord(0, "Cột", 0, [0.05, 0.6, 0.08, 0.03]),
      makeWord(1, "trái", 0, [0.15, 0.6, 0.08, 0.03]),
      // Column 2 top (y jumps upward from 0.60 -> 0.12!)
      makeWord(2, "Cột", 1, [0.55, 0.12, 0.08, 0.03]),
      makeWord(3, "phải", 1, [0.65, 0.12, 0.08, 0.03]),
    ];
    const page = makePage(words, "Cột trái\nCột phải");
    const reflow = computeUniversalPageWordLayout(page);
    expect(reflow.mode).toBe("source-preserved");
    expect(reflow.entries[2]?.breakCount).toBeGreaterThanOrEqual(1);
  });
});

describe("QA-06..QA-08: Universal Phonics Spelling ('tâm', 'mốt', tone safety)", () => {
  it("QA-07: accepts Grade-1 rime-first spelling for 'tâm' ('â mờ âm tờ âm tâm') & rejects wrong tones ('tầm'/'tấm')", () => {
    const exact = matchPhonicsSpelling(
      ["â", "mờ", "âm", "tờ", "âm", "tâm"],
      "tâm",
    );
    expect(exact).not.toBeNull();
    expect(exact?.consumedCount).toBe(6);

    // Tolerates mild STT drift on cue vowel ("ơ mờ âm tờ âm tâm") while keeping final word strict
    const driftedCue = matchPhonicsSpelling(
      ["ơ", "mờ", "âm", "tờ", "âm", "tâm"],
      "tâm",
    );
    expect(driftedCue).not.toBeNull();

    // Multi-chunk spelling across separate finals
    const engine = new RealtimeAlignmentEngine([
      makeWord(0, "tâm", 0, [0.1, 0.1, 0.1, 0.03]),
      makeWord(1, "hồn", 0, [0.22, 0.1, 0.1, 0.03]),
    ]);
    const s1 = engine.addFinalTranscript("â mờ âm");
    expect(s1.spellingInProgress).toBe(true);
    expect(s1.statusByWordId.get("w-0")).toBeUndefined();
    const s2 = engine.addFinalTranscript("tờ âm tâm");
    expect(s2.statusByWordId.get("w-0")?.status).toBe("MATCH");

    // G1 strict tone safety: wrong final tone MUST be rejected
    expect(
      matchPhonicsSpelling(["â", "mờ", "âm", "tờ", "âm", "tầm"], "tâm"),
    ).toBeNull();
    expect(
      matchPhonicsSpelling(["â", "mờ", "âm", "tờ", "âm", "tấm"], "tâm"),
    ).toBeNull();
    expect(
      matchPhonicsSpelling(["ô", "tờ", "ốt", "mờ", "ốt", "một"], "mốt"),
    ).toBeNull();
    expect(
      matchPhonicsSpelling(["ô", "tờ", "ốt", "mờ", "ốt", "mót"], "mốt"),
    ).toBeNull();
  });
});

describe("QA-15 & QA-19: Interim Preview Isolation & Never-Trap SentenceReinforcement", () => {
  it("QA-15: interim previewAlignment never mutates confirmed final statusByWordId", () => {
    const engine = new RealtimeAlignmentEngine([
      makeWord(0, "Sáng", 0, [0.1, 0.1, 0.1, 0.03]),
      makeWord(1, "chủ", 0, [0.22, 0.1, 0.1, 0.03]),
      makeWord(2, "nhật", 0, [0.34, 0.1, 0.1, 0.03]),
    ]);
    const preview = engine.previewAlignment("sáng chủ");
    expect(preview.previewMatchedWordIds.has("w-0")).toBe(true);
    expect(preview.previewMatchedWordIds.has("w-1")).toBe(true);
    // Final engine state remains clean until addFinalTranscript arrives
    expect(engine.getSnapshot().statusByWordId.size).toBe(0);
  });

  it("QA-19: SentenceReinforcement supports voice exit and auto-escapes when child reads next sentence", () => {
    expect(isVoiceExitSentenceReinforcement("đọc tiếp")).toBe(true);
    expect(isVoiceExitSentenceReinforcement("bỏ qua")).toBe(true);
    expect(isVoiceExitSentenceReinforcement("sáng chủ nhật")).toBe(false);

    const words = [
      makeWord(0, "Trời", 0, [0.1, 0.1, 0.08, 0.03]),
      makeWord(1, "sáng", 0, [0.2, 0.1, 0.08, 0.03]),
      makeWord(2, "rồi.", 0, [0.3, 0.1, 0.08, 0.03]),
      makeWord(3, "Bé", 1, [0.1, 0.16, 0.06, 0.03]),
      makeWord(4, "thức", 1, [0.18, 0.16, 0.09, 0.03]),
      makeWord(5, "dậy", 1, [0.29, 0.16, 0.08, 0.03]),
      makeWord(6, "ngay.", 1, [0.39, 0.16, 0.09, 0.03]),
    ];
    const tracker = new SentenceReinforcementTracker();
    const active = tracker.beginForWord(words, "w-1", "fixed");
    expect(active?.span.text).toBe("Trời sáng rồi.");

    // Child ignores repeating old sentence and continues to the next sentence
    const outcome = tracker.consumeSpeech("bé thức dậy ngay");
    expect(outcome).toBe("ignored");
    expect(
      shouldEscapeToUpcomingWords(
        "bé thức dậy ngay",
        words.slice((active?.span.endIndex ?? 0) + 1),
      ),
    ).toBe(true);
  });
});
