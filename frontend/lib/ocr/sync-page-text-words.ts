import type { AdminRevisionWordDTO } from "@/types/admin";

export type PageTextWordSyncResult =
  | {
      readonly status: "synchronized";
      readonly tokens: readonly string[];
      readonly words: readonly AdminRevisionWordDTO[];
    }
  | {
      readonly status: "token-count-mismatch";
      readonly tokens: readonly string[];
      readonly expectedWordCount: number;
      readonly actualTokenCount: number;
      readonly words: readonly AdminRevisionWordDTO[];
    };

/**
 * Mirrors the backend's normalize_word semantics for Vietnamese text.
 * Display text is kept separately; this value is used only for alignment.
 */
export function normalizeVietnameseWord(value: string): string {
  const characters = Array.from(
    value.normalize("NFC").trim().toLocaleLowerCase("vi"),
  );
  const shouldTrim = (character: string) =>
    /[\p{P}\p{S}]/u.test(character) &&
    character !== "'" &&
    character !== "-";

  while (characters.length > 0 && shouldTrim(characters[0])) {
    characters.shift();
  }
  while (
    characters.length > 0 &&
    shouldTrim(characters[characters.length - 1])
  ) {
    characters.pop();
  }

  return characters.join("").replace(/\s+/gu, " ").trim();
}

/** Tokenizes like the backend: Unicode NFC, whitespace-separated words, edge punctuation ignored for comparison. */
export function tokenizePageText(value: string): string[] {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) return [];
  return normalized
    .split(/\s+/u)
    .filter((token) => normalizeVietnameseWord(token).length > 0);
}

/**
 * Synchronizes page text into OCR word records only when there is a safe
 * one-to-one token mapping. Text edits never recalculate or synthesize boxes.
 * If the word count changes, preserve the existing records and require an
 * explicit reconciliation rather than attaching a stale box to a different word.
 */
export function syncPageTextToWords(
  draftText: string,
  existingWords: readonly AdminRevisionWordDTO[],
): PageTextWordSyncResult {
  const tokens = tokenizePageText(draftText);

  if (tokens.length !== existingWords.length) {
    return {
      status: "token-count-mismatch",
      tokens,
      expectedWordCount: existingWords.length,
      actualTokenCount: tokens.length,
      words: existingWords,
    };
  }

  const words = existingWords.map((word, index) => ({
    ...word,
    text: tokens[index],
    normalized_text: normalizeVietnameseWord(tokens[index]),
    // Deliberately preserve bbox, confidence, index and line index byte-for-byte.
    bbox: [...word.bbox] as [number, number, number, number],
  }));

  return { status: "synchronized", tokens, words };
}


export type WordsToPageTextSyncResult =
  | { readonly status: "synchronized"; readonly text: string }
  | {
      readonly status: "token-count-mismatch";
      readonly text: string;
      readonly expectedWordCount: number;
      readonly actualTokenCount: number;
    };

/**
 * Applies direct single-word edits back into the page text without flattening
 * line breaks or other whitespace separators. It refuses word entries that
 * have become blank or contain multiple tokens rather than guessing box mapping.
 */
export function syncWordsToPageText(
  currentPageText: string,
  words: readonly AdminRevisionWordDTO[],
): WordsToPageTextSyncResult {
  const segments = currentPageText.match(/\s+|\S+/gu) ?? [];
  const pageTokenCount = segments.filter((segment) => !/^\s+$/u.test(segment)).length;

  const hasInvalidWord = words.some(
    (word) => tokenizePageText(word.text).length !== 1,
  );
  if (pageTokenCount !== words.length || hasInvalidWord) {
    return {
      status: "token-count-mismatch",
      text: currentPageText,
      expectedWordCount: words.length,
      actualTokenCount: pageTokenCount,
    };
  }

  let wordIndex = 0;
  const text = segments
    .map((segment) => {
      if (/^\s+$/u.test(segment)) return segment;
      const nextWord = words[wordIndex++];
      return nextWord.text.trim();
    })
    .join("");

  return { status: "synchronized", text };
}
