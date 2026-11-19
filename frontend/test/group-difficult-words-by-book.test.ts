import { describe, expect, it } from "vitest";

import { groupDifficultWordsByBook } from "@/lib/api/difficult-word-service";
import type { DifficultWordDTO, DifficultWordSourceDTO } from "@/types/reports";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOOK_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeSource(
  overrides: Partial<DifficultWordSourceDTO> = {},
): DifficultWordSourceDTO {
  return {
    book_id: BOOK_A_ID,
    book_title: "Sách A",
    book_author: "Tác giả A",
    min_grade: 1,
    max_grade: 3,
    last_seen_at: "2026-01-01T00:00:00+07:00",
    ...overrides,
  };
}

function makeWord(
  overrides: Partial<DifficultWordDTO> & { normalized_word: string },
): DifficultWordDTO {
  return {
    display_text: overrides.normalized_word,
    difficulty_score: 5,
    omission_count: 1,
    repetition_count: 0,
    long_pause_count: 0,
    read_example_count: 0,
    session_count: 1,
    last_seen_at: "2026-01-01T00:00:00+07:00",
    evidence_word_ids: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("groupDifficultWordsByBook", () => {
  it("groups a word appearing in TWO different books into both groups", () => {
    const word = makeWord({
      normalized_word: "khủng_long",
      sources: [
        makeSource({
          book_id: BOOK_A_ID,
          book_title: "Sách A",
          page_number: 3,
        }),
        makeSource({
          book_id: BOOK_B_ID,
          book_title: "Sách B",
          page_number: 7,
        }),
      ],
    });

    const groups = groupDifficultWordsByBook([word]);

    // The word must appear in both groups.
    expect(groups).toHaveLength(2);

    const groupA = groups.find((g) => g.bookId === BOOK_A_ID)!;
    const groupB = groups.find((g) => g.bookId === BOOK_B_ID)!;
    expect(groupA).toBeDefined();
    expect(groupB).toBeDefined();

    expect(groupA.words).toHaveLength(1);
    expect(groupA.words[0]!.normalized_word).toBe("khủng_long");
    expect(groupB.words).toHaveLength(1);
    expect(groupB.words[0]!.normalized_word).toBe("khủng_long");

    // Each group's word copy should only carry sources for THAT book.
    expect(
      groupA.words[0]!.sources!.every((s) => s.book_id === BOOK_A_ID),
    ).toBe(true);
    expect(
      groupB.words[0]!.sources!.every((s) => s.book_id === BOOK_B_ID),
    ).toBe(true);
  });

  it("handles multiple pages of the same book without duplicating the word", () => {
    const word = makeWord({
      normalized_word: "bướm",
      sources: [
        makeSource({ book_id: BOOK_A_ID, page_number: 1 }),
        makeSource({ book_id: BOOK_A_ID, page_number: 5 }),
        makeSource({ book_id: BOOK_A_ID, page_number: 12 }),
      ],
    });

    const groups = groupDifficultWordsByBook([word]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.bookId).toBe(BOOK_A_ID);
    // Word should appear exactly once despite 3 sources.
    expect(groups[0]!.words).toHaveLength(1);
    // All 3 page sources should be preserved.
    expect(groups[0]!.words[0]!.sources).toHaveLength(3);
  });

  it("puts a word with NO sources in the unknown group", () => {
    const word = makeWord({ normalized_word: "mèo" });

    const groups = groupDifficultWordsByBook([word]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.bookId).toBeNull();
    expect(groups[0]!.bookTitle).toBe("Chưa xác định nguồn sách");
    expect(groups[0]!.words).toHaveLength(1);
  });

  it("puts a word whose sources all lack book_id in the unknown group", () => {
    const word = makeWord({
      normalized_word: "cá",
      sources: [
        makeSource({ book_id: null, book_title: null }),
        makeSource({ book_id: undefined, book_title: null }),
      ],
    });

    const groups = groupDifficultWordsByBook([word]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.bookId).toBeNull();
    expect(groups[0]!.key).toBe("__unknown_book__");
  });

  it("does not duplicate a word when two input entries share the same normalized_word and book", () => {
    // Two DifficultWordDTO entries with the same normalized_word pointing to the same book.
    const w1 = makeWord({
      normalized_word: "hổ",
      sources: [makeSource({ book_id: BOOK_A_ID })],
    });
    const w2 = makeWord({
      normalized_word: "hổ",
      sources: [makeSource({ book_id: BOOK_A_ID, page_number: 9 })],
    });

    const groups = groupDifficultWordsByBook([w1, w2]);

    const groupA = groups.find((g) => g.bookId === BOOK_A_ID)!;
    expect(groupA.words).toHaveLength(1);
  });

  it("preserves practice_status and progress calculation", () => {
    const completed = makeWord({
      normalized_word: "voi",
      practice_status: "COMPLETED",
      sources: [makeSource({ book_id: BOOK_A_ID })],
    });
    const inProgress = makeWord({
      normalized_word: "cọp",
      practice_status: "IN_PROGRESS",
      sources: [makeSource({ book_id: BOOK_A_ID })],
    });

    const groups = groupDifficultWordsByBook([completed, inProgress]);

    const groupA = groups.find((g) => g.bookId === BOOK_A_ID)!;
    expect(groupA.totalWords).toBe(2);
    expect(groupA.completedWords).toBe(1);
    expect(groupA.progressPercent).toBe(50);
  });

  it("mixed scenario: multi-book word + single-book word + no-source word", () => {
    const multiBook = makeWord({
      normalized_word: "rồng",
      sources: [
        makeSource({ book_id: BOOK_A_ID, book_title: "Sách A" }),
        makeSource({ book_id: BOOK_B_ID, book_title: "Sách B" }),
      ],
    });
    const singleBook = makeWord({
      normalized_word: "phượng",
      sources: [makeSource({ book_id: BOOK_B_ID, book_title: "Sách B" })],
    });
    const noSource = makeWord({ normalized_word: "lân" });

    const groups = groupDifficultWordsByBook([multiBook, singleBook, noSource]);

    // 3 groups: Book A, Book B, unknown
    expect(groups).toHaveLength(3);

    const groupA = groups.find((g) => g.bookId === BOOK_A_ID)!;
    const groupB = groups.find((g) => g.bookId === BOOK_B_ID)!;
    const unknown = groups.find((g) => g.bookId === null)!;

    expect(groupA.words.map((w) => w.normalized_word)).toEqual(["rồng"]);
    expect(groupB.words.map((w) => w.normalized_word).sort()).toEqual([
      "phượng",
      "rồng",
    ]);
    expect(unknown.words.map((w) => w.normalized_word)).toEqual(["lân"]);
  });
});
