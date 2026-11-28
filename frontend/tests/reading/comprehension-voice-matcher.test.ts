import { describe, expect, it } from "vitest";

import {
  analyzeComprehensionVoiceInput,
  choiceLetterForSpeech,
  matchComprehensionVoiceInput,
} from "@/lib/reading/comprehension-voice-matcher";
import type { ComprehensionChoiceUI } from "@/types/reading";

const NEAR_IDENTICAL_CHOICES: readonly ComprehensionChoiceUI[] = [
  { id: "A", label: "Bạn Lan", value: "Bạn Lan" },
  { id: "B", label: "Bạn An", value: "Bạn An" },
  { id: "C", label: "Bạn An nhỏ", value: "Bạn An nhỏ" },
];

const SHUFFLED_CHOICES: readonly ComprehensionChoiceUI[] = [
  { id: "A", label: "Cô giáo", value: "Cô giáo" },
  { id: "B", label: "Bạn Lan", value: "Bạn Lan" },
  { id: "C", label: "Bạn An", value: "Bạn An" },
];

const NUMERIC_CHOICES: readonly ComprehensionChoiceUI[] = [
  { id: "A", label: "2", value: "2" },
  { id: "B", label: "3", value: "3" },
  { id: "C", label: "0", value: "0" },
  { id: "D", label: "10", value: "10" },
];

const ANIMAL_CHOICES: readonly ComprehensionChoiceUI[] = [
  { id: "A", label: "Con dê", value: "Con dê" },
  { id: "B", label: "Xe đạp", value: "Xe đạp" },
  { id: "C", label: "Lá cờ", value: "Lá cờ" },
  { id: "D", label: "Con mèo", value: "Con mèo" },
];

describe("comprehension-voice-matcher", () => {
  it("keeps strict answer-key isolation (only accepts transcript + visibleChoices)", () => {
    expect(analyzeComprehensionVoiceInput.length).toBe(2);
    expect(matchComprehensionVoiceInput.length).toBe(2);
  });

  it.each([
    ["B", "B", "letter"],
    ["bê", "B", "letter"],
    ["câu B", "B", "letter"],
    ["dạ, con chọn bê ạ", "B", "letter"],
    ["đáp án b", "B", "letter"],
    ["chữ xê", "C", "letter"],
    ["Bạn An", "B", "content"],
    ["cho bạn An", "B", "content"],
    ["B, bạn An ạ", "B", "letter_and_content"],
    ["Bạn Lan", "A", "content"],
    ["Bạn An nhỏ", "C", "content"],
    ["cho bạn An nhỏ", "C", "content"],
    ["câu C bạn An nhỏ", "C", "letter_and_content"],
    ["A… à không, con chọn B", "B", "letter"],
    ["A, không, con chọn B", "B", "letter"],
    ["không phải Bạn Lan, ý con là Bạn An", "B", "content"],
    ["đổi sang đáp án C", "C", "letter"],
    ["bê bê", "B", "letter"],
    ["câu thứ nhất", "A", "ordinal"],
    ["chọn câu hai", "B", "ordinal"],
  ] as const)(
    "resolves clear choice '%s' -> %s (%s)",
    (spoken, expectedId, matchedBy) => {
      const res = analyzeComprehensionVoiceInput(
        spoken,
        NEAR_IDENTICAL_CHOICES,
      );
      expect(res).toMatchObject({
        type: "CHOICE",
        choice: { id: expectedId },
        matchedBy,
      });
    },
  );

  it.each([
    ["Ạ", "NONE"],
    ["à…", "NONE"],
    ["dạ", "NONE"],
    ["ờ ừm nhé", "NONE"],
    ["A hay B nhỉ?", "AMBIGUOUS"],
    ["A hoặc B", "AMBIGUOUS"],
    ["con không chọn bạn An", "NEGATED"],
    ["không phải bạn Lan", "NEGATED"],
    ["hôm nay trời đẹp quá", "NONE"],
    ["cháu thích đọc truyện tranh", "NONE"],
    ["Bạn", "AMBIGUOUS"],
  ] as const)(
    "keeps quiz open for filler/hesitation/negation/off-book '%s' -> %s",
    (spoken, expectedType) => {
      const res = analyzeComprehensionVoiceInput(
        spoken,
        NEAR_IDENTICAL_CHOICES,
      );
      expect(res.type).toBe(expectedType);
      expect(
        matchComprehensionVoiceInput(spoken, NEAR_IDENTICAL_CHOICES),
      ).toEqual({
        type: "NONE",
      });
    },
  );

  it("formats clarification prompt for conflict 'A, bạn An' and ambiguous 'Bạn'", () => {
    const conflict = analyzeComprehensionVoiceInput(
      "A, bạn An",
      NEAR_IDENTICAL_CHOICES,
    );
    expect(conflict).toMatchObject({
      type: "CONFLICT",
      letterChoice: { id: "A", label: "Bạn Lan" },
      contentChoice: { id: "B", label: "Bạn An" },
      clarificationPrompt: "Con chọn Bạn Lan hay Bạn An?",
    });

    const ambiguous = analyzeComprehensionVoiceInput(
      "Bạn",
      NEAR_IDENTICAL_CHOICES,
    );
    expect(ambiguous).toMatchObject({
      type: "AMBIGUOUS",
      clarificationPrompt: "Con chọn Bạn Lan hay Bạn An?",
    });
  });

  it("recognizes replay & stop commands for both Cô and Thầy", () => {
    expect(
      analyzeComprehensionVoiceInput(
        "Cô đọc lại giúp con",
        NEAR_IDENTICAL_CHOICES,
      ),
    ).toEqual({ type: "REPLAY" });
    expect(
      analyzeComprehensionVoiceInput(
        "Thầy đọc lại giúp con",
        NEAR_IDENTICAL_CHOICES,
      ),
    ).toEqual({ type: "REPLAY" });
    expect(
      analyzeComprehensionVoiceInput("Dừng lại", NEAR_IDENTICAL_CHOICES),
    ).toEqual({ type: "STOP" });
    expect(
      analyzeComprehensionVoiceInput("nghỉ một chút", NEAR_IDENTICAL_CHOICES),
    ).toEqual({ type: "STOP" });
  });

  it.each([
    ["hai", "A"],
    ["số hai", "A"],
    ["con chọn số 2", "A"],
    ["ba", "B"],
    ["số ba", "B"],
    ["không", "C"],
    ["số không", "C"],
    ["mười", "D"],
  ] as const)(
    "matches Vietnamese spoken digits '%s' -> numeric choice %s",
    (spoken, expectedId) => {
      const res = analyzeComprehensionVoiceInput(spoken, NUMERIC_CHOICES);
      expect(res).toMatchObject({
        type: "CHOICE",
        choice: { id: expectedId },
        matchedBy: "content",
      });
    },
  );

  it("treats explicit positional 'câu hai' as ordinal B even when options are numbers", () => {
    const res = analyzeComprehensionVoiceInput("câu hai", NUMERIC_CHOICES);
    expect(res).toMatchObject({
      type: "CHOICE",
      choice: { id: "B", label: "3" },
      matchedBy: "ordinal",
    });
  });

  it("handles NFC and NFD Unicode identically for transcripts and choices", () => {
    const nfdChoices = NEAR_IDENTICAL_CHOICES.map((c) => ({
      ...c,
      label: c.label.normalize("NFD"),
      value: c.value.normalize("NFD"),
    }));
    const nfdSpoken = "dạ, con chọn Bạn An ạ".normalize("NFD");
    const nfcSpoken = "dạ, con chọn Bạn An ạ".normalize("NFC");

    const fromNfd = analyzeComprehensionVoiceInput(nfdSpoken, nfdChoices);
    const fromNfc = analyzeComprehensionVoiceInput(nfcSpoken, nfdChoices);

    expect(fromNfd).toMatchObject({
      type: "CHOICE",
      choice: { id: "B" },
      matchedBy: "content",
    });
    expect(fromNfc).toMatchObject({
      type: "CHOICE",
      choice: { id: "B" },
      matchedBy: "content",
    });
  });

  it("works with shuffled choice order and avoids false inline letter conflicts on words like dê/xe/cờ", () => {
    expect(
      analyzeComprehensionVoiceInput("Bạn An", SHUFFLED_CHOICES),
    ).toMatchObject({
      type: "CHOICE",
      choice: { id: "C", label: "Bạn An" },
    });
    expect(analyzeComprehensionVoiceInput("C", SHUFFLED_CHOICES)).toMatchObject(
      {
        type: "CHOICE",
        choice: { id: "C", label: "Bạn An" },
      },
    );
    expect(
      analyzeComprehensionVoiceInput("Con dê", ANIMAL_CHOICES),
    ).toMatchObject({
      type: "CHOICE",
      choice: { id: "A", label: "Con dê" },
      matchedBy: "content",
    });
    expect(
      analyzeComprehensionVoiceInput("Xe đạp", ANIMAL_CHOICES),
    ).toMatchObject({
      type: "CHOICE",
      choice: { id: "B", label: "Xe đạp" },
      matchedBy: "content",
    });
    expect(
      analyzeComprehensionVoiceInput("Lá cờ", ANIMAL_CHOICES),
    ).toMatchObject({
      type: "CHOICE",
      choice: { id: "C", label: "Lá cờ" },
      matchedBy: "content",
    });
  });

  it("maps choice letters for speech", () => {
    expect(choiceLetterForSpeech(SHUFFLED_CHOICES[0], 0)).toBe("A");
    expect(choiceLetterForSpeech({ id: "", label: "X", value: "X" }, 2)).toBe(
      "C",
    );
  });
});
