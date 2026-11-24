/**
 * Voice answer & command matcher for hands-free comprehension questions (G24).
 *
 * Understands how Vietnamese Grade-1 children answer multiple-choice questions:
 *  - Letters & Vietnamese letter names: "A", "B", "bê", "C", "xê", "D", "đê"
 *  - Natural phrases: "đáp án A", "câu bê", "con chọn xê", "câu một / hai / ba"
 *  - Speaking the answer content directly (when unambiguous against other options)
 *  - Commands: "đọc lại" / "nghe lại" (replay), "dừng lại" (pause voice), "tiếp theo"
 */

import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";
import type { ComprehensionChoiceUI } from "@/types/reading";

export type ComprehensionVoiceMatch =
  | {
      readonly type: "CHOICE";
      readonly choice: ComprehensionChoiceUI;
      readonly matchedBy: "letter" | "ordinal" | "content";
    }
  | { readonly type: "REPLAY" }
  | { readonly type: "STOP" }
  | { readonly type: "NONE" };

const LETTER_ALIASES: readonly (readonly string[])[] = [
  // Index 0 -> A
  ["a", "à", "á", "ả", "ã", "ạ"],
  // Index 1 -> B
  ["b", "bê", "bờ", "be", "bề"],
  // Index 2 -> C
  ["c", "xê", "cê", "sê", "cờ", "xe", "se"],
  // Index 3 -> D
  ["d", "đê", "dê", "dờ", "đờ", "de", "đề"],
];

const ORDINAL_ALIASES: readonly (readonly string[])[] = [
  ["một", "1", "nhất", "đầu"],
  ["hai", "2", "nhì"],
  ["ba", "3"],
  ["bốn", "4", "tư"],
];

const CHOICE_PREFIX_WORDS = new Set([
  "đáp",
  "án",
  "câu",
  "chọn",
  "con",
  "bé",
  "em",
  "là",
  "chữ",
  "phương",
  "số",
  "thứ",
  "cái",
  "ý",
  "nhé",
  "nha",
  "ạ",
  "ơi",
  "cô",
  "thầy",
]);

const REPLAY_PHRASES = [
  "đọc lại",
  "nghe lại",
  "nhắc lại",
  "nói lại",
  "đọc lại giúp con",
  "cô đọc lại",
  "thầy đọc lại",
];

const STOP_PHRASES = [
  "dừng lại",
  "tạm dừng",
  "nghỉ một chút",
  "thôi không nghe",
];

const CHOICE_LETTER_SPOKEN: readonly string[] = ["A", "B", "C", "D"];

export function choiceLetterForSpeech(
  choice: ComprehensionChoiceUI,
  index: number,
): string {
  const id = choice.id.trim().toUpperCase();
  if (/^[A-D]$/u.test(id)) return id;
  return CHOICE_LETTER_SPOKEN[index] ?? String(index + 1);
}

function normalizePhrase(text: string): string {
  return tokenizeVietnameseText(text).join(" ");
}

function matchLetterIndex(
  tokens: readonly string[],
): number | "ambiguous" | -1 {
  if (!tokens.length || tokens.length > 6) return -1;

  // Reject hesitation/choice-questioning phrases like "a hay bê"
  if (tokens.includes("hay") || tokens.includes("hoặc")) return "ambiguous";

  const matchedIndexes = new Set<number>();
  let unknownNonPrefix = 0;

  for (const token of tokens) {
    let found = -1;
    for (let idx = 0; idx < LETTER_ALIASES.length; idx += 1) {
      if (LETTER_ALIASES[idx].includes(token)) {
        found = idx;
        break;
      }
    }
    if (found >= 0) {
      matchedIndexes.add(found);
    } else if (!CHOICE_PREFIX_WORDS.has(token)) {
      unknownNonPrefix += 1;
    }
  }

  if (matchedIndexes.size > 1) return "ambiguous";
  if (matchedIndexes.size === 1 && unknownNonPrefix === 0) {
    return [...matchedIndexes][0];
  }
  return -1;
}

function matchOrdinalIndex(
  tokens: readonly string[],
): number | "ambiguous" | -1 {
  if (!tokens.length || tokens.length > 6) return -1;
  if (tokens.includes("hay") || tokens.includes("hoặc")) return "ambiguous";

  // Require an explicit marker ("câu", "đáp án", "số", "chọn", "thứ") so
  // reading an option that happens to contain the word "một" or "hai" isn't
  // misclassified as ordinal #1/#2.
  const hasMarker = tokens.some((t) =>
    ["câu", "số", "thứ", "chọn", "án"].includes(t),
  );
  if (!hasMarker) return -1;

  const matchedIndexes = new Set<number>();
  let unknownNonPrefix = 0;
  for (const token of tokens) {
    let found = -1;
    for (let idx = 0; idx < ORDINAL_ALIASES.length; idx += 1) {
      if (ORDINAL_ALIASES[idx].includes(token)) {
        found = idx;
        break;
      }
    }
    if (found >= 0) {
      matchedIndexes.add(found);
    } else if (!CHOICE_PREFIX_WORDS.has(token)) {
      unknownNonPrefix += 1;
    }
  }

  if (matchedIndexes.size > 1) return "ambiguous";
  if (matchedIndexes.size === 1 && unknownNonPrefix === 0) {
    return [...matchedIndexes][0];
  }
  return -1;
}

function matchContentChoice(
  tokens: readonly string[],
  choices: readonly ComprehensionChoiceUI[],
): ComprehensionChoiceUI | null {
  if (!tokens.length) return null;
  const spokenSet = new Set(tokens);
  const spokenJoined = tokens.join(" ");

  let best: { choice: ComprehensionChoiceUI; score: number } | null = null;
  let secondScore = 0;

  for (const choice of choices) {
    const labelTokens = tokenizeVietnameseText(choice.label);
    if (!labelTokens.length) continue;

    // Exact normalized label match (e.g. "đúng", "sai", "con mèo")
    const labelJoined = labelTokens.join(" ");
    if (
      spokenJoined === labelJoined ||
      (labelTokens.length >= 2 && spokenJoined.includes(labelJoined))
    ) {
      if (!best || 1 > best.score) {
        secondScore = best ? best.score : 0;
        best = { choice, score: 1 };
      } else {
        secondScore = Math.max(secondScore, 1);
      }
      continue;
    }

    // Token overlap score (for multi-word answers spoken slightly differently)
    if (labelTokens.length >= 2) {
      let overlap = 0;
      for (const word of labelTokens) {
        if (spokenSet.has(word)) overlap += 1;
      }
      const recall = overlap / labelTokens.length;
      const precision = overlap / tokens.length;
      const score =
        recall >= 0.6 && precision >= 0.5 ? (recall + precision) / 2 : 0;
      if (score > 0) {
        if (!best || score > best.score) {
          secondScore = best ? best.score : 0;
          best = { choice, score };
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
    }
  }

  // Must be clearly better than the runner-up so ambiguous speech never auto-picks
  if (best && best.score - secondScore >= 0.2) {
    return best.choice;
  }
  return null;
}

/**
 * Resolve a child's spoken utterance against the active question's choices.
 */
export function matchComprehensionVoiceInput(
  transcript: string,
  choices: readonly ComprehensionChoiceUI[],
): ComprehensionVoiceMatch {
  const tokens = tokenizeVietnameseText(transcript);
  if (!tokens.length) return { type: "NONE" };
  const normalized = normalizePhrase(transcript);

  if (
    REPLAY_PHRASES.some(
      (phrase) => normalized === phrase || normalized.includes(phrase),
    )
  ) {
    return { type: "REPLAY" };
  }
  if (
    STOP_PHRASES.some(
      (phrase) => normalized === phrase || normalized.includes(phrase),
    )
  ) {
    return { type: "STOP" };
  }

  // 1. Try content match FIRST when exact label matches (e.g. "Đúng" / "Sai"
  // or "Con cá" so a word like "ba" inside an option text isn't hijacked).
  const byContent = matchContentChoice(tokens, choices);
  if (byContent) {
    return { type: "CHOICE", choice: byContent, matchedBy: "content" };
  }

  // 2. Letter match ("A", "bê", "đáp án xê", "con chọn B")
  const letterIdx = matchLetterIndex(tokens);
  if (letterIdx === "ambiguous") return { type: "NONE" };
  if (letterIdx >= 0 && letterIdx < choices.length) {
    return { type: "CHOICE", choice: choices[letterIdx], matchedBy: "letter" };
  }

  // 3. Ordinal match ("câu một", "đáp án hai", "chọn số 3")
  const ordinalIdx = matchOrdinalIndex(tokens);
  if (ordinalIdx === "ambiguous") return { type: "NONE" };
  if (ordinalIdx >= 0 && ordinalIdx < choices.length) {
    return {
      type: "CHOICE",
      choice: choices[ordinalIdx],
      matchedBy: "ordinal",
    };
  }

  return { type: "NONE" };
}
