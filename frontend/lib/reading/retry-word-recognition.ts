/**
 * Helpers for isolated Vietnamese retry-word recognition.
 *
 * Không xóa dấu thanh tiếng Việt và không chuyển "đ" thành "d".
 * Một từ chỉ được xác nhận đúng khi transcript có từ mục tiêu như một token
 * hoàn chỉnh (hoặc chuỗi đánh vần Lớp 1 kết thúc chính xác bằng từ mục tiêu).
 * Dấu thanh tiếng Việt vẫn được giữ nguyên.
 */

import { matchPhonicsSpelling } from "@/lib/reading/phonics-spelling";
import {
  normalizeVietnameseText,
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";

export type RetryRecognitionStatus =
  "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NOT_RECOGNIZED";

const NON_SPEECH_ANNOTATION_RE =
  /\[[^\]]*\]|\((?:tiếng|âm\s*thanh|nhạc|ồn|cười|ho|thở|applause|laughter|music|noise)[^)]*\)/giu;

const ASSISTANT_BLEED_PHRASES = [
  "bé hãy đọc",
  "hãy đọc lại",
  "đọc lại từ",
  "chưa nghe rõ",
  "mình chưa nghe rõ",
  "con đọc lại",
  "con thử đọc cả cụm",
  "con hãy đọc cả cụm",
  "nghe lại rồi đọc",
  "một lần nhé",
  "chính xác rồi",
  "con giỏi lắm",
  "máy chưa nghe",
  "đánh vần chậm cùng cô",
  "ghép vần cùng cô",
  "nghe cô đánh vần",
  "đọc trơn là",
  "đến lượt con giỏi lắm",
] as const;

export function isAssistantPromptBleed(
  tokens: readonly string[],
  expectedTokens: readonly string[],
): boolean {
  if (tokens.length <= expectedTokens.length) return false;
  const joined = tokens.join(" ");
  return ASSISTANT_BLEED_PHRASES.some((phrase) => joined.includes(phrase));
}

/**
 * Loại bỏ nhãn mô tả tiếng động nền do STT trả về (vd: "[tiếng đập]", "[tiếng chuông]")
 * để không chấm nhầm tiếng động môi trường thành đọc sai.
 */
export function stripNonSpeechAnnotations(value: string): string {
  return value.replace(NON_SPEECH_ANNOTATION_RE, " ").trim();
}

/**
 * Chuẩn hóa một từ tiếng Việt.
 *
 * Giữ nguyên:
 * - Dấu thanh: á, à, ả, ã, ạ...
 * - Chữ đ và Đ.
 *
 * Chỉ loại bỏ dấu câu ở đầu và cuối từ.
 */
export function normalizeVietnameseRetryToken(value: string): string {
  return normalizeVietnameseWord(value);
}

const DIGIT_WORDS = [
  "không",
  "một",
  "hai",
  "ba",
  "bốn",
  "năm",
  "sáu",
  "bảy",
  "tám",
  "chín",
];

export function normalizeShortWordTranscript(value: string): string {
  const text = normalizeVietnameseText(stripNonSpeechAnnotations(value));
  return /^[0-9]$/u.test(text) ? DIGIT_WORDS[Number(text)] : text;
}

/** Select up to three adjacent words from the child's book for a second try. */
export function shortWordContext(
  target: string,
  context?: string | null,
): string | null {
  const expected = tokenizeVietnameseText(target);
  if (expected.length < 1 || expected.length > 2 || !context) return null;
  for (const sentence of context.split(/[.!?…;\n]+/u)) {
    const original =
      sentence.normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
    const words = original.map(normalizeVietnameseWord);
    const index = words.findIndex((_, start) =>
      expected.every((word, offset) => word === words[start + offset]),
    );
    if (index < 0 || words.length <= expected.length) continue;
    // OCR word lists may omit the period before the next sentence's capital.
    const nextCapital = original.findIndex(
      (word, position) =>
        position > index + expected.length && /^\p{Lu}/u.test(word),
    );
    const end = nextCapital < 0 ? words.length : nextCapital;
    if (nextCapital >= 0 && end - index > expected.length)
      return words.slice(index, Math.min(index + 3, end)).join(" ");
    const start = Math.max(0, Math.min(index, end - 3));
    return words.slice(start, Math.min(start + 3, end)).join(" ");
  }
  return null;
}

/** Similar nasal codas need corroboration before an attempt is marked wrong. */
export function hasConfusableNasalEnding(
  target: string,
  transcript?: string | null,
): boolean {
  if (!transcript) return false;
  const expected = tokenizeVietnameseText(target);
  const actual = tokenizeVietnameseText(transcript);
  if (expected.length !== 1 || actual.length !== 1 || expected[0] === actual[0])
    return false;
  const coda = /^(.+?)(ng|nh|m|n)$/u;
  const left = coda.exec(expected[0]);
  const right = coda.exec(actual[0]);
  return Boolean(left && right && left[1] === right[1]);
}

export interface RetryTranscriptOptions {
  readonly contextPhrase?: string | null;
}

function containsContiguousTokenSubslice(
  needle: readonly string[],
  haystack: readonly string[],
): boolean {
  const span = needle.length;
  if (span === 0 || span > haystack.length) return false;
  for (let i = 0; i <= haystack.length - span; i += 1) {
    let matches = true;
    for (let j = 0; j < span; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function matchesExpectedInsideContextPhrase(
  expectedTokens: readonly string[],
  candidateTokens: readonly string[],
  contextPhrase: string | null | undefined,
): boolean {
  if (
    !contextPhrase ||
    candidateTokens.length < 2 ||
    candidateTokens.length > 10
  ) {
    return false;
  }
  const contextTokens = tokenizeVietnameseText(contextPhrase);
  return (
    containsContiguousTokenSubslice(expectedTokens, candidateTokens) &&
    containsContiguousTokenSubslice(candidateTokens, contextTokens)
  );
}

/**
 * True when `tokens` contains a valid Grade-1 phonics spelling-out of
 * `expected` without unrelated trailing chatter (at most 1 trailing repeat of
 * `expected`).
 */
function matchesRetryPhonicsSpelling(
  tokens: readonly string[],
  expected: string,
): boolean {
  if (tokens.length < 2) return false;
  const direct = matchPhonicsSpelling(tokens, expected);
  if (direct) {
    const rest = tokens.slice(direct.consumedCount);
    return rest.length === 0 || rest.every((t) => t === expected);
  }
  return false;
}

/**
 * Đánh giá từ đích trong một transcript ngắn.
 *
 * Cụm từ ngắn hoặc chuỗi đánh vần Lớp 1 (ví dụ "ê tờ ê tê", "ô i ôi tờ ôi tôi")
 * được chấp nhận khi kết thúc bằng đúng từ đích. Transcript dài hơn không thuộc
 * đánh vần hoặc câu ngữ cảnh cần được coi là không chắc chắn.
 * Không dùng nội dung keyterm làm bằng chứng nhận diện.
 */
export function classifyRetryTranscript(
  expectedWord: string,
  transcript: string | null | undefined,
  options?: RetryTranscriptOptions,
): RetryRecognitionStatus {
  const expected = normalizeShortWordTranscript(expectedWord);

  if (!expected || /\s/u.test(expected)) {
    return "UNCERTAIN";
  }

  const rawTranscript =
    typeof transcript === "string" ? stripNonSpeechAnnotations(transcript) : "";

  if (!rawTranscript) {
    return "NOT_RECOGNIZED";
  }

  const tokens = tokenizeVietnameseText(
    normalizeShortWordTranscript(rawTranscript),
  );

  if (tokens.length === 0) {
    return "NOT_RECOGNIZED";
  }

  if (isAssistantPromptBleed(tokens, [expected])) {
    return "UNCERTAIN";
  }

  // Grade-1 phonics spelling-out in retry mode (G26): e.g. "ê tờ ê tê",
  // "ô i ôi tờ ôi tôi", "a cờ a ca sắc cá".
  if (matchesRetryPhonicsSpelling(tokens, expected)) {
    return "CORRECT";
  }

  const collapsed = tokens.filter(
    (token, idx) => idx === 0 || token !== tokens[idx - 1],
  );
  if (matchesRetryPhonicsSpelling(collapsed, expected)) {
    return "CORRECT";
  }

  const candidateTokens =
    tokens.length > 4 &&
    collapsed.length <= 4 &&
    collapsed.every((token) => token === expected)
      ? collapsed
      : tokens;

  if (candidateTokens.length > 4) {
    return matchesExpectedInsideContextPhrase(
      [expected],
      candidateTokens,
      options?.contextPhrase,
    )
      ? "CORRECT"
      : "UNCERTAIN";
  }
  if (candidateTokens.includes(expected)) return "CORRECT";
  return "INCORRECT";
}

/**
 * Đánh giá từ đơn hoặc cụm từ ngắn (tối đa 4 tiếng) cho bài luyện từ khó.
 */
export function classifyPracticePhraseTranscript(
  expectedPhrase: string,
  transcript: string | null | undefined,
  options?: RetryTranscriptOptions,
): RetryRecognitionStatus {
  const expectedTokens = tokenizeVietnameseText(expectedPhrase);
  if (expectedTokens.length === 0 || expectedTokens.length > 4) {
    return "UNCERTAIN";
  }

  if (expectedTokens.length === 1) {
    return classifyRetryTranscript(expectedPhrase, transcript, options);
  }

  const rawTranscript =
    typeof transcript === "string" ? stripNonSpeechAnnotations(transcript) : "";
  if (!rawTranscript) {
    return "NOT_RECOGNIZED";
  }

  const tokens = tokenizeVietnameseText(rawTranscript);
  if (tokens.length === 0) {
    return "NOT_RECOGNIZED";
  }

  if (isAssistantPromptBleed(tokens, expectedTokens)) {
    return "UNCERTAIN";
  }

  // Allow spelling out words inside a practice phrase as well.
  const reducedTokens: string[] = [];
  let expectedCursor = 0;
  for (let i = 0; i < tokens.length;) {
    if (expectedCursor < expectedTokens.length) {
      const target = expectedTokens[expectedCursor];
      if (tokens[i] === target) {
        reducedTokens.push(target);
        expectedCursor += 1;
        i += 1;
        continue;
      }
      const phonics = matchPhonicsSpelling(tokens.slice(i), target);
      if (phonics) {
        reducedTokens.push(target);
        expectedCursor += 1;
        i += phonics.consumedCount;
        continue;
      }
    }
    reducedTokens.push(tokens[i]);
    i += 1;
  }

  const maxTokens = Math.max(4, expectedTokens.length + 3);
  if (reducedTokens.length > maxTokens) {
    return matchesExpectedInsideContextPhrase(
      expectedTokens,
      reducedTokens,
      options?.contextPhrase,
    )
      ? "CORRECT"
      : "UNCERTAIN";
  }

  if (containsContiguousTokenSubslice(expectedTokens, reducedTokens)) {
    return "CORRECT";
  }
  return "INCORRECT";
}
