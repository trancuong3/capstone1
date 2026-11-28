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
  "đánh vần chậm cùng thầy",
  "ghép vần cùng thầy",
  "nghe thầy đánh vần",
  "đọc trơn là",
  "đến lượt con giỏi lắm",
  "con nghe từ này nhé",
  "cô đọc mẫu cho con nhé",
  "thầy đọc mẫu cho con nhé",
  "đến lượt con đọc nhé",
  "con nghe cô đọc",
  "con nghe thầy đọc",
  "con có muốn cùng cô",
  "con có muốn cùng thầy",
  "đọc lại vài từ khó",
  "vài từ khó không",
  "cùng cô đọc lại",
  "cùng thầy đọc lại",
  "đọc lại cả câu",
  "con đọc lại cả câu",
  "nghe cô đọc mẫu",
  "nghe thầy đọc mẫu",
] as const;

const YES_NO_SPEAKER_QUESTION_BLEED_PHRASES = [
  "con có muốn cùng cô",
  "con có muốn cùng thầy",
  "đọc lại vài từ khó",
  "vài từ khó không",
  "cùng cô đọc lại",
  "cùng thầy đọc lại",
  "bé có muốn đọc lại",
  "con có muốn luyện lại",
] as const;

const YES_INTENT_TOKENS = new Set([
  "có",
  "dạ",
  "vâng",
  "ừ",
  "muốn",
  "đồng",
  "ok",
  "được",
  "đọc",
]);

const NO_INTENT_TOKENS = new Set([
  "không",
  "thôi",
  "bỏ",
  "qua",
  "khỏi",
  "chưa",
]);

const NO_OVERRIDE_PHRASES = [
  "không đồng ý",
  "không cần đọc lại",
  "không cần",
  "chưa muốn đọc lại",
  "chưa muốn",
  "không muốn",
  "không đọc",
  "chưa đọc",
  "không đâu",
  "không ạ",
  "dạ không",
  "con không",
  "bé không",
  "em không",
  "bỏ qua",
  "để sau",
  "thôi",
] as const;

/**
 * Classifies a child's spoken Yes/No answer to the post-reading wrap-up prompt
 * ("Con có muốn cùng cô/thầy đọc lại vài từ khó không?").
 */
export function classifyYesNoVoiceIntent(
  transcript: string,
): "yes" | "no" | "unknown" {
  const tokens = tokenizeVietnameseText(stripNonSpeechAnnotations(transcript));
  if (!tokens.length) return "unknown";
  const joined = tokens.join(" ");

  // 1. Reject speaker echo of the assistant's own prompt question.
  if (
    YES_NO_SPEAKER_QUESTION_BLEED_PHRASES.some((phrase) =>
      joined.includes(phrase),
    ) ||
    (joined.includes("có muốn") && tokens[tokens.length - 1] === "không")
  ) {
    return "unknown";
  }

  // 2. Always evaluate explicit refusals BEFORE positive phrases so negations
  //    like "không đồng ý", "không cần đọc lại", "con chưa muốn đọc lại" never return "yes".
  if (NO_OVERRIDE_PHRASES.some((phrase) => joined.includes(phrase))) {
    return "no";
  }

  // Also reject any negated positive token ("không/chưa/đừng" directly preceding a positive intent)
  if (
    /(?:^|\s)(?:không|chưa|chẳng|đừng|khỏi)\s+(?:có|muốn|cần|đồng|được|đọc)(?:\s|$)/u.test(
      joined,
    )
  ) {
    return "no";
  }

  if (
    joined.includes("dạ có") ||
    joined.includes("con có") ||
    joined.includes("con muốn") ||
    joined.includes("đọc lại") ||
    joined.includes("đồng ý")
  ) {
    return "yes";
  }
  let yesCount = 0;
  let noCount = 0;
  for (const t of tokens) {
    if (NO_INTENT_TOKENS.has(t)) noCount += 1;
    else if (YES_INTENT_TOKENS.has(t)) yesCount += 1;
  }
  if (noCount > 0 && noCount >= yesCount) return "no";
  if (yesCount > 0) return "yes";
  return "unknown";
}

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
