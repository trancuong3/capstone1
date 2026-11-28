/**
 * Helpers for isolated Vietnamese retry-word recognition.
 *
 * Không xóa dấu thanh tiếng Việt và không chuyển "đ" thành "d".
 * Một từ chỉ được xác nhận đúng khi transcript có từ mục tiêu như một token
 * hoàn chỉnh (hoặc chuỗi đánh vần Lớp 1 kết thúc chính xác bằng từ mục tiêu).
 * Dấu thanh tiếng Việt vẫn được giữ nguyên.
 */

import {
  decomposeVietnameseSyllable,
  matchPhonicsSpelling,
  isPhonicsInProgress,
  splitVietnameseRhyme,
  type VietnameseTone,
} from "@/lib/reading/phonics-spelling";
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

function mapDigitToken(token: string): string {
  if (token === "10") return "mười";
  if (/^[0-9]$/u.test(token)) return DIGIT_WORDS[Number(token)];
  return token;
}

function tokenizeShortWordTokens(value: string): string[] {
  return tokenizeVietnameseText(stripNonSpeechAnnotations(value)).map(
    mapDigitToken,
  );
}

export function normalizeShortWordTranscript(value: string): string {
  return tokenizeShortWordTokens(value).join(" ");
}

const MAX_CONTRASTIVE_KEYTERMS = 14;
const ALL_TONES: readonly VietnameseTone[] = [
  "ngang",
  "sac",
  "huyen",
  "hoi",
  "nga",
  "nang",
];
const CHECKED_TONES: readonly VietnameseTone[] = ["sac", "nang"];
const NASAL_CODAS = ["m", "n", "ng", "nh"] as const;
const STOPPED_CODAS = ["t", "c", "p", "ch"] as const;
const VOWEL_TONE_TABLE: Readonly<
  Record<string, Readonly<Record<VietnameseTone, string>>>
> = {
  a: { ngang: "a", sac: "á", huyen: "à", hoi: "ả", nga: "ã", nang: "ạ" },
  ă: { ngang: "ă", sac: "ắ", huyen: "ằ", hoi: "ẳ", nga: "ẵ", nang: "ặ" },
  â: { ngang: "â", sac: "ấ", huyen: "ầ", hoi: "ẩ", nga: "ẫ", nang: "ậ" },
  e: { ngang: "e", sac: "é", huyen: "è", hoi: "ẻ", nga: "ẽ", nang: "ẹ" },
  ê: { ngang: "ê", sac: "ế", huyen: "ề", hoi: "ể", nga: "ễ", nang: "ệ" },
  i: { ngang: "i", sac: "í", huyen: "ì", hoi: "ỉ", nga: "ĩ", nang: "ị" },
  o: { ngang: "o", sac: "ó", huyen: "ò", hoi: "ỏ", nga: "õ", nang: "ọ" },
  ô: { ngang: "ô", sac: "ố", huyen: "ồ", hoi: "ổ", nga: "ỗ", nang: "ộ" },
  ơ: { ngang: "ơ", sac: "ớ", huyen: "ờ", hoi: "ở", nga: "ỡ", nang: "ợ" },
  u: { ngang: "u", sac: "ú", huyen: "ù", hoi: "ủ", nga: "ũ", nang: "ụ" },
  ư: { ngang: "ư", sac: "ứ", huyen: "ừ", hoi: "ử", nga: "ữ", nang: "ự" },
  y: { ngang: "y", sac: "ý", huyen: "ỳ", hoi: "ỷ", nga: "ỹ", nang: "ỵ" },
};
const PALATAL_CODA_NUCLEI = new Set(["a", "ê", "i", "oa", "uê", "uy"]);

function pickToneVowelIndex(nucleus: string, coda: string): number {
  const chars = [...nucleus];
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if ("ăâêôơư".includes(chars[i])) return i;
  }
  if (coda && chars.length >= 2) return 1;
  if (chars.length >= 3) return 1;
  if (
    chars.length === 2 &&
    (nucleus === "oa" || nucleus === "oe" || nucleus === "uy")
  ) {
    return 0;
  }
  return 0;
}

function renderVietnameseSyllable(
  onset: string,
  nucleus: string,
  coda: string,
  tone: VietnameseTone,
): string | null {
  const chars = [...nucleus];
  if (!chars.length) return null;
  const idx = pickToneVowelIndex(nucleus, coda);
  const base = chars[idx];
  const toned = VOWEL_TONE_TABLE[base]?.[tone];
  if (!toned) return null;
  chars[idx] = toned;
  return `${onset}${chars.join("")}${coda}`.normalize("NFC");
}

function expandSyllableContrastiveTerms(syllable: string): string[] {
  const parts = decomposeVietnameseSyllable(syllable);
  if (!parts) return [];
  const { nucleus, coda } = splitVietnameseRhyme(parts.rhyme);
  if (!nucleus) return [];

  const out: string[] = [parts.normalized];
  const isStopped = (STOPPED_CODAS as readonly string[]).includes(coda);
  const tones = isStopped ? CHECKED_TONES : ALL_TONES;
  for (const tone of tones) {
    if (tone === parts.tone) continue;
    const variant = renderVietnameseSyllable(parts.onset, nucleus, coda, tone);
    if (variant) out.push(variant);
  }

  const codaGroup: readonly string[] = (
    NASAL_CODAS as readonly string[]
  ).includes(coda)
    ? NASAL_CODAS
    : isStopped
      ? STOPPED_CODAS
      : [];
  for (const altCoda of codaGroup) {
    if (altCoda === coda) continue;
    if (
      (altCoda === "nh" || altCoda === "ch") &&
      !PALATAL_CODA_NUCLEI.has(nucleus)
    ) {
      continue;
    }
    const comp = renderVietnameseSyllable(
      parts.onset,
      nucleus,
      altCoda,
      parts.tone,
    );
    if (comp) out.push(comp);
    if (isStopped) {
      const altTone: VietnameseTone = parts.tone === "nang" ? "sac" : "nang";
      const altComp = renderVietnameseSyllable(
        parts.onset,
        nucleus,
        altCoda,
        altTone,
      );
      if (altComp) out.push(altComp);
    }
  }

  if (parts.onset === "đ") {
    const dVar = renderVietnameseSyllable("d", nucleus, coda, parts.tone);
    if (dVar) out.push(dVar);
  } else if (parts.onset === "d") {
    const ddVar = renderVietnameseSyllable("đ", nucleus, coda, parts.tone);
    if (ddVar) out.push(ddVar);
  }

  return out;
}

/**
 * Generate a contrastive Vietnamese keyterm list (6-tone minimal-pair family
 * + close coda competitors, capped at ~14 items) so ASR prioritizes the phonetic
 * neighborhood while acoustic scores still strictly discriminate tones/codas.
 */
export function buildContrastiveKeyterms(
  target: string,
  contextPhrase?: string | null,
): string[] {
  const cleanTarget = target.normalize("NFC").trim();
  if (!cleanTarget) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    const cleaned = term.normalize("NFC").trim();
    if (!cleaned) return;
    const key = cleaned.toLocaleLowerCase("vi-VN");
    if (seen.has(key) || out.length >= MAX_CONTRASTIVE_KEYTERMS) return;
    seen.add(key);
    out.push(cleaned);
  };

  add(cleanTarget);
  const cleanContext = contextPhrase
    ?.replace(/\.\.\./g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
  if (cleanContext) {
    const shortCtx = shortWordContext(cleanTarget, cleanContext);
    if (shortCtx) add(shortCtx);
    else if (tokenizeVietnameseText(cleanContext).length <= 4) {
      add(cleanContext);
    }
  }

  const targetTokens = tokenizeVietnameseText(cleanTarget);
  for (const tok of targetTokens) {
    for (const variant of expandSyllableContrastiveTerms(tok)) {
      if (out.length >= MAX_CONTRASTIVE_KEYTERMS) return out;
      add(variant);
    }
  }
  return out.slice(0, MAX_CONTRASTIVE_KEYTERMS);
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

/** Similar nasal or stopped codas need corroboration before an attempt is marked wrong. */
export function hasConfusableShortCoda(
  target: string,
  transcript?: string | null,
): boolean {
  if (!transcript) return false;
  const expected = tokenizeVietnameseText(target);
  const actual = tokenizeVietnameseText(transcript);
  if (expected.length !== 1 || actual.length !== 1 || expected[0] === actual[0])
    return false;
  const nasalCoda = /^(.+?)(ng|nh|m|n)$/u;
  const nLeft = nasalCoda.exec(expected[0]);
  const nRight = nasalCoda.exec(actual[0]);
  if (nLeft && nRight && nLeft[1] === nRight[1]) return true;

  const stopCoda = /^(.+?)(ch|c|p|t)$/u;
  const sLeft = stopCoda.exec(expected[0]);
  const sRight = stopCoda.exec(actual[0]);
  return Boolean(sLeft && sRight && sLeft[1] === sRight[1]);
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
  const contextTokens = tokenizeShortWordTokens(contextPhrase);
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
 * Cụm từ ngắn, từ ghép gạch nối ("ô-tô", "ba-lô") hoặc chuỗi đánh vần Lớp 1
 * (ví dụ "ê tờ ê tê", "ô i ôi tờ ôi tôi") được chấp nhận khi khớp chính xác
 * dấu thanh và chữ đ. Transcript dài hơn không thuộc đánh vần hoặc câu ngữ cảnh
 * cần được coi là không chắc chắn. Không dùng nội dung keyterm làm bằng chứng nhận diện.
 */
export function classifyRetryTranscript(
  expectedWord: string,
  transcript: string | null | undefined,
  options?: RetryTranscriptOptions,
): RetryRecognitionStatus {
  const expectedTokens = tokenizeShortWordTokens(expectedWord);
  if (expectedTokens.length === 0 || expectedTokens.length > 4) {
    return "UNCERTAIN";
  }
  if (expectedTokens.length > 1) {
    return classifyPracticePhraseTranscript(expectedWord, transcript, options);
  }
  const expected = expectedTokens[0];

  const rawTranscript =
    typeof transcript === "string" ? stripNonSpeechAnnotations(transcript) : "";

  if (!rawTranscript) {
    return "NOT_RECOGNIZED";
  }

  const tokens = tokenizeShortWordTokens(rawTranscript);

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
    tokens.length > 4 && collapsed.length <= 4 && collapsed.includes(expected)
      ? collapsed
      : tokens;

  if (candidateTokens.length > 4) {
    if (
      isPhonicsInProgress(tokens, expected) ||
      isPhonicsInProgress(collapsed, expected)
    ) {
      return "UNCERTAIN";
    }
    if (
      matchesExpectedInsideContextPhrase(
        [expected],
        candidateTokens,
        options?.contextPhrase,
      )
    ) {
      return "CORRECT";
    }
    const expectedParts = decomposeVietnameseSyllable(expected);
    const lastParts = decomposeVietnameseSyllable(tokens[tokens.length - 1]);
    if (
      expectedParts &&
      lastParts &&
      lastParts.untonedSyllable === expectedParts.untonedSyllable &&
      lastParts.normalized !== expected
    ) {
      return "INCORRECT";
    }
    return "UNCERTAIN";
  }
  if (candidateTokens.includes(expected)) return "CORRECT";
  if (
    isPhonicsInProgress(candidateTokens, expected) ||
    isPhonicsInProgress(collapsed, expected)
  ) {
    return "UNCERTAIN";
  }
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
  const expectedTokens = tokenizeShortWordTokens(expectedPhrase);
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

  const tokens = tokenizeShortWordTokens(rawTranscript);
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
    if (
      reducedTokens.length <= 10 &&
      containsContiguousTokenSubslice(expectedTokens, reducedTokens)
    ) {
      return "CORRECT";
    }
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
  if (
    expectedCursor < expectedTokens.length &&
    isPhonicsInProgress(
      tokens.slice(expectedCursor),
      expectedTokens[expectedCursor],
    )
  ) {
    return "UNCERTAIN";
  }
  return "INCORRECT";
}
