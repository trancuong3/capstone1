import { describe, expect, it } from "vitest";
import {
  READING_MASTERY_LABELS,
  buildPhonicsLesson,
  evaluatePostPhonicsAttempt,
} from "@/lib/reading/phonics-lesson";

describe("phonics-lesson — Vietnamese Grade-1 step-by-step phonics & tone integrity", () => {
  it("builds the exact canonical 4-step lesson for mandatory case 'mốt'", () => {
    const plan = buildPhonicsLesson("mốt");
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;

    expect(plan.focusSyllable).toBe("mốt");
    expect(plan.onset).toEqual({ written: "m", spoken: "mờ" });
    expect(plan.rhyme).toEqual({
      written: "ốt",
      untoned: "ôt",
      nucleus: "ô",
      coda: "t",
      spoken: "ốt",
    });
    expect(plan.tone).toEqual({
      code: "sac",
      label: "dấu sắc",
      spoken: "sắc",
    });

    expect(plan.steps.map((s) => s.kind)).toEqual([
      "rhyme_build",
      "onset_blend",
      "tone_blend",
      "whole_syllable",
    ]);
    expect(plan.steps.map((s) => s.displayText)).toEqual([
      "ô · tờ → ốt",
      "mờ + ốt",
      "sắc → mốt",
      "mốt",
    ]);
    expect(plan.steps.map((s) => s.spokenText)).toEqual([
      "ô, tờ, ốt.",
      "mờ, ốt.",
      "sắc, mốt.",
      "mốt.",
    ]);
    for (const step of plan.steps) {
      expect(step.spokenText).not.toMatch(/[-→+·]/u);
    }
  });

  it("keeps 'mốt', 'một', and 'mót' distinct in decomposition, spoken steps, and evaluation", () => {
    const motSac = buildPhonicsLesson("mốt");
    const motNang = buildPhonicsLesson("một");
    const motOSac = buildPhonicsLesson("mót");
    expect(motSac.supported && motNang.supported && motOSac.supported).toBe(
      true,
    );
    if (!motSac.supported || !motNang.supported || !motOSac.supported) return;

    expect(motSac.tone.code).toBe("sac");
    expect(motNang.tone.code).toBe("nang");
    expect(motOSac.rhyme.untoned).toBe("ot");
    expect(motSac.rhyme.untoned).toBe("ôt");

    expect(motNang.steps.map((s) => s.spokenText)).toEqual([
      "ô, tờ, ốt.",
      "mờ, ốt.",
      "nặng, một.",
      "một.",
    ]);
    expect(motOSac.steps.map((s) => s.spokenText)).toEqual([
      "o, tờ, ót.",
      "mờ, ót.",
      "sắc, mót.",
      "mót.",
    ]);

    expect(evaluatePostPhonicsAttempt("một", motSac)).toEqual({
      kind: "WRONG_TONE",
      spoken: "một",
    });
    expect(evaluatePostPhonicsAttempt("mót", motSac)).toEqual({
      kind: "WRONG_TONE",
      spoken: "mót",
    });
    expect(evaluatePostPhonicsAttempt("mốt", motSac)).toEqual({
      kind: "CORRECT_AFTER_SPELLING",
      mastery: "CORRECT_AFTER_SPELLING",
    });
  });

  it("preserves all 6 Vietnamese tones (ma, má, mà, mả, mã, mạ) and normalizes NFD to NFC", () => {
    const sixTones: readonly [string, string, string | null][] = [
      ["ma", "ngang", null],
      ["má", "sac", "sắc"],
      ["mà", "huyen", "huyền"],
      ["mả", "hoi", "hỏi"],
      ["mã", "nga", "ngã"],
      ["mạ", "nang", "nặng"],
    ];

    for (const [word, expectedTone, expectedSpoken] of sixTones) {
      const nfcPlan = buildPhonicsLesson(word.normalize("NFC"));
      const nfdPlan = buildPhonicsLesson(word.normalize("NFD"));
      expect(nfcPlan.supported).toBe(true);
      expect(nfdPlan).toEqual(nfcPlan);
      if (!nfcPlan.supported) continue;

      expect(nfcPlan.focusSyllable).toBe(word.normalize("NFC"));
      expect(nfcPlan.tone.code).toBe(expectedTone);
      expect(nfcPlan.tone.spoken).toBe(expectedSpoken);
    }
  });

  it("distinguishes đ/d and Vietnamese modified vowels (ă/â/a, ê/e, ô/ơ/o, ư/u)", () => {
    const pairs = [
      ["đa", "đờ", "a"],
      ["da", "dờ", "a"],
      ["ăn", null, "ăn"],
      ["ân", null, "ân"],
      ["an", null, "an"],
      ["tê", "tờ", "ê"],
      ["te", "tờ", "e"],
      ["cô", "cờ", "ô"],
      ["cơ", "cờ", "ơ"],
      ["co", "cờ", "o"],
      ["tư", "tờ", "ư"],
      ["tu", "tờ", "u"],
    ] as const;

    for (const [word, onsetSpoken, expectedRhyme] of pairs) {
      const plan = buildPhonicsLesson(word);
      expect(plan.supported).toBe(true);
      if (!plan.supported) continue;
      expect(plan.onset?.spoken ?? null).toBe(onsetSpoken);
      expect(plan.rhyme.untoned).toBe(expectedRhyme);
      expect(plan.focusSyllable).toBe(word);
    }

    // Verify SGK vowel names `ă -> á` and `â -> ớ` in rhyme_build
    const anBreve = buildPhonicsLesson("ăn");
    const anCircumflex = buildPhonicsLesson("ân");
    expect(anBreve.supported && anCircumflex.supported).toBe(true);
    if (anBreve.supported && anCircumflex.supported) {
      expect(anBreve.steps[0].spokenText).toBe("á, nờ, ăn.");
      expect(anCircumflex.steps[0].spokenText).toBe("ớ, nờ, ân.");
    }
  });

  it("handles compound onsets (qu, gi, ngh, kh, ch, tr, nh) and onset-less syllables", () => {
    const cases: readonly [string, string | null, string][] = [
      ["quýt", "quờ", "uyt"],
      ["quỳnh", "quờ", "uynh"],
      ["quốc", "quờ", "ôc"],
      ["giếng", "gi", "iêng"],
      ["gì", "gi", "i"],
      ["nghiêng", "ngờ", "iêng"],
      ["khúc", "khờ", "uc"],
      ["chăm", "chờ", "ăm"],
      ["trường", "trờ", "ương"],
      ["nho", "nhờ", "o"],
      ["ấm", null, "âm"],
      ["oai", null, "oai"],
      ["ý", null, "y"],
    ];

    for (const [word, expectedOnset, expectedRhyme] of cases) {
      const plan = buildPhonicsLesson(word);
      expect(plan.supported).toBe(true);
      if (!plan.supported) continue;
      expect(plan.onset?.spoken ?? null).toBe(expectedOnset);
      expect(plan.rhyme.untoned).toBe(expectedRhyme);
    }
  });

  it("focuses the stuck syllable 'mốt' in 'hai mươi mốt' and appends phrase context", () => {
    const plan = buildPhonicsLesson("hai mươi mốt", {
      spokenAttempt: "hai mươi một",
    });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;

    expect(plan.focusSyllable).toBe("mốt");
    expect(plan.focusSyllableIndex).toBe(2);
    expect(plan.steps.map((s) => s.spokenText)).toEqual([
      "ô, tờ, ốt.",
      "mờ, ốt.",
      "sắc, mốt.",
      "mốt.",
      "hai mươi mốt.",
    ]);

    expect(
      evaluatePostPhonicsAttempt("mốt", plan, { requireFullPhrase: true }).kind,
    ).toBe("CORRECT_SYLLABLE_NEEDS_PHRASE");
    expect(
      evaluatePostPhonicsAttempt("hai mươi mốt", plan, {
        requireFullPhrase: true,
      }),
    ).toEqual({
      kind: "CORRECT_AFTER_SPELLING",
      mastery: "CORRECT_AFTER_SPELLING",
    });
  });

  it("rejects intermediate spelling steps ('ô, tờ, ốt') from counting as reading 'mốt'", () => {
    const plan = buildPhonicsLesson("mốt");
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;

    const stepOnly1 = evaluatePostPhonicsAttempt("ô tờ ốt", plan);
    expect(stepOnly1.kind).toBe("SPELLING_STEP_ONLY");

    const stepOnly2 = evaluatePostPhonicsAttempt("ô tờ ốt mờ ốt", plan);
    expect(stepOnly2.kind).toBe("SPELLING_STEP_ONLY");

    const fullSpelling = evaluatePostPhonicsAttempt(
      "ô tờ ốt mờ ốt sắc mốt",
      plan,
    );
    expect(fullSpelling).toEqual({
      kind: "CORRECT_AFTER_SPELLING",
      mastery: "CORRECT_AFTER_SPELLING",
    });
  });

  it("refuses foreign words, acronyms, numbers, OCR-broken strings, and unverified proper nouns cleanly", () => {
    for (const invalid of ["pizza", "SGK", "21", "trng", "gho", "mốt123", ""]) {
      const plan = buildPhonicsLesson(invalid);
      expect(plan.supported).toBe(false);
      if (plan.supported) continue;
      expect(plan.message).toBe("Chưa có mẫu đánh vần");
    }

    const proper = buildPhonicsLesson("Washington", {
      rejectCapitalizedProperNoun: true,
    });
    expect(proper.supported).toBe(false);
    if (!proper.supported) {
      expect(proper.message).toBe("Chưa có mẫu đánh vần");
      expect(proper.canPlayWholeWord).toBe(true);
    }
  });

  it("exposes all 4 distinct mastery labels without collapsing outcomes", () => {
    expect(READING_MASTERY_LABELS).toEqual({
      FIRST_PASS_CORRECT: "Đọc đúng ngay lần đầu",
      CORRECT_AFTER_HINT: "Đọc đúng sau gợi ý",
      CORRECT_AFTER_SPELLING: "Đọc đúng sau đánh vần",
      NEEDS_PRACTICE: "Cần luyện lại",
    });
  });
});
