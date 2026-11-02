import { describe, expect, it } from "vitest";

import {
  alignReadingSegment,
  findOriginalSentence,
  groupPronunciationReviewCandidates,
  normalizeVietnameseToken,
  type ReadingSourceWord,
  type RecognizedSpeechWord,
} from "@/lib/utils/reading-pronunciation-alignment";

function source(texts: string[]): ReadingSourceWord[] {
  return texts.map((text, word_index) => ({
    word_id: `word-${word_index}`,
    word_index,
    text,
  }));
}

function evidence(texts: string[]): RecognizedSpeechWord[] {
  return texts.map((text, index) => ({
    text,
    start: index * 0.3,
    end: index * 0.3 + 0.2,
    logprob: -0.05,
  }));
}

describe("Vietnamese occurrence-based pronunciation alignment", () => {
  it("preserves Vietnamese diacritics while normalizing case and punctuation", () => {
    expect(normalizeVietnameseToken("KHỎE,")).toBe("khỏe");
    expect(normalizeVietnameseToken("khỏe")).not.toBe(
      normalizeVietnameseToken("khẻo"),
    );
  });

  it("does nothing when no speech was recognized", () => {
    const result = alignReadingSegment(source(["Con", "mèo"]), 0, "", []);
    expect(result.assessments).toEqual([]);
    expect(result.next_word_index).toBe(0);
  });

  it("marks every confidently recognized word in the first phrase in order", () => {
    const result = alignReadingSegment(
      source(["Con", "mèo", "đang", "ngủ."]),
      0,
      "Con mèo đang ngủ.",
      evidence(["Con", "mèo", "đang", "ngủ."]),
    );

    expect(result.assessments.map((item) => item.status)).toEqual([
      "CORRECT",
      "CORRECT",
      "CORRECT",
      "CORRECT",
    ]);
    expect(result.next_word_index).toBe(4);
  });

  it("keeps a clipped first token uncertain without losing later exact matches", () => {
    const result = alignReadingSegment(
      source(["Con", "mèo", "đang", "ngủ."]),
      0,
      "c mèo",
      evidence(["c", "mèo"]),
    );

    expect(result.assessments[0]).toMatchObject({
      expected_text: "Con",
      recognized_text: "c",
      status: "UNCERTAIN",
      reason: "INCOMPLETE_TOKEN",
    });
    expect(result.assessments[1]).toMatchObject({
      expected_text: "mèo",
      status: "CORRECT",
    });
    expect(result.next_word_index).toBe(2);
  });

  it("classifies a high-confidence Vietnamese substitution as incorrect", () => {
    const result = alignReadingSegment(
      source(["khỏe", "không?"]),
      0,
      "khẻo không?",
      evidence(["khẻo", "không?"]),
    );

    expect(result.assessments[0]).toMatchObject({
      expected_text: "khỏe",
      recognized_text: "khẻo",
      status: "INCORRECT",
      reason: "CONFIDENT_SUBSTITUTION",
    });
    expect(result.assessments[1].status).toBe("CORRECT");
  });

  it("marks a confidently mispronounced first word only when the next source word confirms context", () => {
    const result = alignReadingSegment(
      source(["Con", "mèo", "đang", "ngủ."]),
      0,
      "Còn mèo đang ngủ.",
      evidence(["Còn", "mèo", "đang", "ngủ."]),
    );

    expect(result.assessments[0]).toMatchObject({
      expected_text: "Con",
      recognized_text: "Còn",
      status: "INCORRECT",
      reason: "CONFIDENT_SUBSTITUTION",
    });
    expect(
      result.assessments.slice(1).every((item) => item.status === "CORRECT"),
    ).toBe(true);
  });

  it("does not mark unrelated background speech as an incorrect word", () => {
    const result = alignReadingSegment(
      source(["Con", "mèo"]),
      0,
      "hello mèo",
      evidence(["hello", "mèo"]),
    );

    expect(result.assessments[0]).toMatchObject({
      expected_text: "Con",
      recognized_text: "hello",
      status: "UNCERTAIN",
    });
    expect(result.assessments[1].status).toBe("CORRECT");
  });

  it("does not turn a short partial token into a correct or incorrect result", () => {
    const result = alignReadingSegment(
      source(["Con", "mèo"]),
      0,
      "c mèo",
      evidence(["c", "mèo"]),
    );

    expect(result.assessments[0].status).toBe("UNCERTAIN");
    expect(result.assessments[0].reason).toBe("INCOMPLETE_TOKEN");
  });

  it("does not use transcript-only text as word-level confidence", () => {
    const result = alignReadingSegment(source(["Con", "mèo"]), 0, "Con mèo");

    expect(result.assessments.map((item) => item.status)).toEqual([
      "UNCERTAIN",
      "UNCERTAIN",
    ]);
    expect(result.next_word_index).toBe(0);
  });

  it("continues the next utterance from the previously aligned occurrence", () => {
    const words = source(["Con", "mèo", "đang", "ngủ."]);
    const first = alignReadingSegment(
      words,
      0,
      "Con mèo",
      evidence(["Con", "mèo"]),
    );
    const second = alignReadingSegment(
      words,
      first.next_word_index,
      "đang ngủ.",
      evidence(["đang", "ngủ."]),
    );

    expect(first.next_word_index).toBe(2);
    expect(second.assessments.map((item) => item.word_index)).toEqual([2, 3]);
    expect(second.assessments.every((item) => item.status === "CORRECT")).toBe(
      true,
    );
  });

  it("treats repeated source words as separate occurrences", () => {
    const texts = [
      "Bạn",
      "An",
      "khỏe",
      "không?",
      "Bạn",
      "Bình",
      "khỏe",
      "không?",
    ];
    const result = alignReadingSegment(
      source(texts),
      0,
      texts.join(" "),
      evidence(texts),
    );

    const khỏe = result.assessments.filter(
      (item) => item.expected_text === "khỏe",
    );
    expect(khỏe.map((item) => item.word_index)).toEqual([2, 6]);
    expect(khỏe.map((item) => item.status)).toEqual(["CORRECT", "CORRECT"]);
  });

  it("does not classify a skipped leading word as an error when speech starts later", () => {
    const result = alignReadingSegment(
      source(["Con", "mèo", "đang", "ngủ."]),
      0,
      "đang ngủ.",
      evidence(["đang", "ngủ."]),
    );

    expect(
      result.assessments.find((item) => item.word_index === 0)?.status,
    ).toBe("UNCERTAIN");
    expect(
      result.assessments.find((item) => item.word_index === 1)?.status,
    ).toBe("UNCERTAIN");
    expect(
      result.assessments.find((item) => item.word_index === 2)?.status,
    ).toBe("CORRECT");
  });
});

describe("source sentence extraction and review grouping", () => {
  it("extracts the original sentence using its punctuation boundary", () => {
    const words = source(["Bạn", "An", "khỏe", "không?", "Bạn", "Bình", "đi."]);
    expect(findOriginalSentence(words, 2)).toEqual({
      text: "Bạn An khỏe không?",
      startWordIndex: 0,
      endWordIndexExclusive: 4,
    });
    expect(findOriginalSentence(words, 5)).toEqual({
      text: "Bạn Bình đi.",
      startWordIndex: 4,
      endWordIndexExclusive: 7,
    });
  });

  it("does not invent a sentence when the source has no closing punctuation", () => {
    expect(findOriginalSentence(source(["Bạn", "An", "khỏe"]), 1)).toBeNull();
  });

  it("groups multiple wrong words from the same sentence for one sentence reread", () => {
    const candidates = [
      {
        page_id: "page-1",
        page_number: 1,
        page_revision_id: "revision-1",
        word_id: "word-1",
        word_index: 1,
        expected_word: "An",
        recognized_word: "Anh",
        confidence: 0.95,
        sentence_text: "Bạn An khỏe không?",
        sentence_start_word_index: 0,
        sentence_end_word_index_exclusive: 4,
      },
      {
        page_id: "page-1",
        page_number: 1,
        page_revision_id: "revision-1",
        word_id: "word-3",
        word_index: 3,
        expected_word: "không?",
        recognized_word: "không",
        confidence: 0.94,
        sentence_text: "Bạn An khỏe không?",
        sentence_start_word_index: 0,
        sentence_end_word_index_exclusive: 4,
      },
    ];

    const groups = groupPronunciationReviewCandidates(candidates);
    expect(groups).toHaveLength(1);
    expect(groups[0].words.map((item) => item.word_id)).toEqual([
      "word-1",
      "word-3",
    ]);
    expect(groups[0].sentence_text).toBe("Bạn An khỏe không?");
  });
});
