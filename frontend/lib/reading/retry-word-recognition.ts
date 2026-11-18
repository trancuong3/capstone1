/**
 * Helpers for isolated Vietnamese retry-word recognition.
 *
 * Không xóa dấu thanh tiếng Việt và không chuyển "đ" thành "d".
 * Một từ chỉ được xác nhận đúng khi transcript có từ mục tiêu như một token
 * hoàn chỉnh. Dấu thanh tiếng Việt vẫn được giữ nguyên.
 */

import {
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
  "nghe lại rồi đọc",
  "một lần nhé",
  "chính xác rồi",
  "con giỏi lắm",
  "máy chưa nghe",
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
 * Đánh giá từ đích trong một transcript ngắn.
 *
 * Cụm từ ngắn được chấp nhận khi từ đích xuất hiện như một token riêng.
 * Transcript dài hơn cần được coi là không chắc chắn vì có thể là hội thoại
 * không liên quan, trừ khi cụm đọc khớp liên tiếp trong câu ngữ cảnh của từ đó.
 * Không dùng nội dung keyterm làm bằng chứng nhận diện.
 */
export function classifyRetryTranscript(
  expectedWord: string,
  transcript: string | null | undefined,
  options?: RetryTranscriptOptions,
): RetryRecognitionStatus {
  const expected = normalizeVietnameseRetryToken(expectedWord);

  if (!expected || /\s/u.test(expected)) {
    return "UNCERTAIN";
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

  if (isAssistantPromptBleed(tokens, [expected])) {
    return "UNCERTAIN";
  }

  const collapsed = tokens.filter(
    (token, idx) => idx === 0 || token !== tokens[idx - 1],
  );
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

  const maxTokens = Math.max(4, expectedTokens.length + 3);
  if (tokens.length > maxTokens) {
    return matchesExpectedInsideContextPhrase(
      expectedTokens,
      tokens,
      options?.contextPhrase,
    )
      ? "CORRECT"
      : "UNCERTAIN";
  }

  if (containsContiguousTokenSubslice(expectedTokens, tokens)) {
    return "CORRECT";
  }
  return "INCORRECT";
}
