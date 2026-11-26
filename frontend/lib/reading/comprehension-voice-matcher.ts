/**
 * Voice answer & command resolver for hands-free comprehension questions.
 *
 * STRICT ANSWER-KEY ISOLATION:
 * Only ever receives `(transcript, visibleChoices)`. It NEVER knows which choice
 * is the correct answer; grading happens purely on the server after selection.
 */

import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";
import type { ComprehensionChoiceUI } from "@/types/reading";

export type ComprehensionVoiceMatch =
  | {
      readonly type: "CHOICE";
      readonly choice: ComprehensionChoiceUI;
      readonly matchedBy:
        "letter" | "ordinal" | "content" | "letter_and_content";
    }
  | { readonly type: "REPLAY" }
  | { readonly type: "STOP" }
  | { readonly type: "NONE" };

export type ComprehensionVoiceAnalysis =
  | ComprehensionVoiceMatch
  | {
      readonly type: "CONFLICT";
      readonly letterChoice: ComprehensionChoiceUI;
      readonly contentChoice: ComprehensionChoiceUI;
      readonly clarificationPrompt: string;
    }
  | {
      readonly type: "AMBIGUOUS";
      readonly candidates: readonly ComprehensionChoiceUI[];
      readonly clarificationPrompt: string;
    }
  | {
      readonly type: "NEGATED";
      readonly clarificationPrompt: string;
    };

const LETTER_ALIASES: readonly (readonly string[])[] = [
  // Index 0 -> A (IMPORTANT: NEVER include Vietnamese particles "à/á/ả/ã/ạ"!)
  ["a"],
  // Index 1 -> B
  ["b", "bê", "bờ", "be", "bề"],
  // Index 2 -> C
  ["c", "xê", "cê", "sê", "cờ", "xe", "se"],
  // Index 3 -> D
  ["d", "đê", "dê", "dờ", "đờ", "de", "đề"],
];

// Vietnamese homophone nouns that should NEVER be treated as bare choice letters
// without an explicit choice marker ("đáp án / câu / chữ / phương án") or when
// they appear as vocabulary inside any visible choice label.
const NOUN_HOMOPHONE_LETTER_ALIASES = new Set([
  "xe",
  "se",
  "cờ",
  "bờ",
  "dê",
  "bề",
  "đề",
  "dờ",
  "đờ",
  "be",
  "de",
]);

const EXPLICIT_LETTER_MARKERS = new Set([
  "đáp",
  "án",
  "câu",
  "phương",
  "chữ",
  "ý",
]);

const CONTENT_CLASSIFIER_WORDS = new Set([
  "chiếc",
  "cái",
  "con",
  "quả",
  "trái",
  "quyển",
  "cuốn",
  "bông",
  "lá",
  "cây",
  "chú",
  "cô",
  "bác",
  "ông",
  "bà",
  "bạn",
  "người",
  "một",
  "các",
  "những",
]);

const ORDINAL_ALIASES: readonly (readonly string[])[] = [
  ["một", "1", "nhất", "đầu"],
  ["hai", "2", "nhì"],
  ["ba", "3"],
  ["bốn", "4", "tư"],
];

const CHOICE_MARKER_TOKENS = new Set([
  "đáp",
  "án",
  "câu",
  "chọn",
  "phương",
  "chữ",
  "số",
  "thứ",
  "ý",
  "là",
]);

const FILLER_OR_POLITE_WORDS = new Set([
  "dạ",
  "vâng",
  "thưa",
  "ạ",
  "nhé",
  "nha",
  "ơi",
  "à",
  "ờ",
  "ừ",
  "ừm",
  "nhỉ",
  "ha",
  "hử",
  "cô",
  "thầy",
  "con",
  "bé",
  "em",
  "mình",
  "tớ",
  "cái",
  "cho",
  "với",
  "thôi",
  "của",
]);

const CHOICE_PREFIX_WORDS = new Set([
  ...CHOICE_MARKER_TOKENS,
  ...FILLER_OR_POLITE_WORDS,
]);

const REPLAY_PHRASES = [
  "đọc lại giúp con",
  "đọc lại giúp bé",
  "đọc lại giúp em",
  "đọc lại cho con",
  "đọc lại cho bé",
  "đọc lại cho em",
  "cô đọc lại giúp con",
  "thầy đọc lại giúp con",
  "cô đọc lại",
  "thầy đọc lại",
  "đọc lại",
  "nghe lại",
  "nhắc lại",
  "nói lại",
];

const STOP_PHRASES = [
  "dừng lại",
  "tạm dừng",
  "nghỉ một chút",
  "thôi không nghe",
  "tạm nghỉ",
];

const CORRECTION_PIVOTS: readonly string[] = [
  "à không",
  "ơ không",
  "ồ không",
  "à nhầm",
  "nhầm rồi",
  "ý con là",
  "ý bé là",
  "ý em là",
  "đổi sang",
  "đổi lại",
  "sửa lại",
  "chọn lại",
  "mà là",
  "không con chọn",
  "không bé chọn",
  "không em chọn",
  "không phải con chọn",
  "không phải bé chọn",
  "không phải em chọn",
];

const VIETNAMESE_DIGIT_MAP: Readonly<Record<string, string>> = {
  không: "0",
  "0": "0",
  một: "1",
  mốt: "1",
  "1": "1",
  hai: "2",
  "2": "2",
  ba: "3",
  "3": "3",
  bốn: "4",
  tư: "4",
  "4": "4",
  năm: "5",
  lăm: "5",
  "5": "5",
  sáu: "6",
  "6": "6",
  bảy: "7",
  bẩy: "7",
  "7": "7",
  tám: "8",
  "8": "8",
  chín: "9",
  "9": "9",
  mười: "10",
  "10": "10",
};

function normalizeContentToken(token: string): string {
  return VIETNAMESE_DIGIT_MAP[token] ?? token;
}

function containsTokenSubsequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function subtractLabelTokens(
  tokens: readonly string[],
  labelTokens: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const token of labelTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const remaining: string[] = [];
  for (const token of tokens) {
    const left = counts.get(token) ?? 0;
    if (left > 0) {
      counts.set(token, left - 1);
    } else {
      remaining.push(token);
    }
  }
  return remaining;
}

const NEGATION_RE =
  /(?:^|\s)(?:không\s+chọn|không\s+phải(?:\s+là)?|chẳng\s+chọn|chẳng\s+phải|đừng\s+chọn|không\s+lấy|không\s+đúng)(?:\s|$)/u;

const CHOICE_LETTER_SPOKEN: readonly string[] = ["A", "B", "C", "D"];

export function choiceLetterForSpeech(
  choice: ComprehensionChoiceUI,
  index: number,
): string {
  const id = choice.id.trim().toUpperCase();
  if (/^[A-D]$/u.test(id)) return id;
  return CHOICE_LETTER_SPOKEN[index] ?? String(index + 1);
}

/**
 * When the child self-corrects mid-turn (e.g. "A… à không, con chọn B" or
 * "không phải Lan, mà là bạn An"), discard the retracted clause before the pivot
 * and keep only the final committed clause.
 */
function extractSelfCorrectedTail(normalized: string): {
  readonly clause: string;
  readonly hadRevision: boolean;
} {
  let latestEnd = -1;
  for (const pivot of CORRECTION_PIVOTS) {
    const idx = normalized.lastIndexOf(pivot);
    if (idx !== -1) {
      const end = idx + pivot.length;
      if (end > latestEnd) latestEnd = end;
    }
  }
  if (latestEnd !== -1) {
    const tail = normalized.slice(latestEnd).trim();
    if (tail) return { clause: tail, hadRevision: true };
  }
  // Pattern: "không phải <X> con chọn <Y>"
  const notMatch =
    /^(?:con |bé |em )?không\s+(?:chọn|phải)\s+.+?\s+(?:con\s+|bé\s+|em\s+)?(?:chọn|là)\s+(.+)$/u.exec(
      normalized,
    );
  if (notMatch?.[1]) {
    return { clause: notMatch[1].trim(), hadRevision: true };
  }
  return { clause: normalized, hadRevision: false };
}

function collectChoiceVocabulary(
  choices: readonly ComprehensionChoiceUI[],
): Set<string> {
  const vocab = new Set<string>();
  for (const choice of choices) {
    for (const token of tokenizeVietnameseText(choice.label)) {
      vocab.add(token);
    }
  }
  return vocab;
}

function matchLetterIndex(
  tokens: readonly string[],
  choices: readonly ComprehensionChoiceUI[],
): { index: number | "ambiguous" | -1; hasExplicitMarker: boolean } {
  if (!tokens.length || tokens.length > 8) {
    return { index: -1, hasExplicitMarker: false };
  }
  if (tokens.includes("hay") || tokens.includes("hoặc")) {
    return { index: "ambiguous", hasExplicitMarker: false };
  }

  const choiceVocab = collectChoiceVocabulary(choices);
  const hasStrongLetterMarker = tokens.some((t) =>
    EXPLICIT_LETTER_MARKERS.has(t),
  );
  const matchedIndexes = new Set<number>();
  let hasExplicitMarker = false;
  let unknownNonPrefix = 0;

  for (const token of tokens) {
    if (CHOICE_MARKER_TOKENS.has(token)) hasExplicitMarker = true;
    let found = -1;
    const isNounHomophone = NOUN_HOMOPHONE_LETTER_ALIASES.has(token);
    const collidesWithChoiceVocab = choiceVocab.has(token);
    // Block ambiguous noun homophones ("xe", "cờ", "bờ", "dê", "bê", "đê") when they
    // appear inside any visible choice label or lack an explicit choice-letter marker.
    const allowAsLetter =
      (!collidesWithChoiceVocab || hasStrongLetterMarker) &&
      (!isNounHomophone || hasStrongLetterMarker);

    if (allowAsLetter) {
      for (let idx = 0; idx < LETTER_ALIASES.length; idx += 1) {
        if (idx < choices.length && LETTER_ALIASES[idx].includes(token)) {
          found = idx;
          break;
        }
      }
    }
    if (found >= 0) {
      matchedIndexes.add(found);
    } else if (!CHOICE_PREFIX_WORDS.has(token)) {
      unknownNonPrefix += 1;
    }
  }

  if (matchedIndexes.size > 1) return { index: "ambiguous", hasExplicitMarker };
  if (matchedIndexes.size === 1 && unknownNonPrefix === 0) {
    return { index: [...matchedIndexes][0], hasExplicitMarker };
  }
  return { index: -1, hasExplicitMarker };
}

function matchOrdinalIndex(
  tokens: readonly string[],
  choices: readonly ComprehensionChoiceUI[],
): number | "ambiguous" | -1 {
  if (!tokens.length || tokens.length > 8) return -1;
  if (tokens.includes("hay") || tokens.includes("hoặc")) return "ambiguous";

  // Require an explicit marker ("câu", "đáp án", "số", "chọn", "thứ") so
  // numeric option labels ("1", "2", "3") are matched as content when bare.
  const hasMarker = tokens.some((t) =>
    ["câu", "số", "thứ", "chọn", "án"].includes(t),
  );
  if (!hasMarker) return -1;

  const matchedIndexes = new Set<number>();
  let unknownNonPrefix = 0;
  for (const token of tokens) {
    let found = -1;
    for (let idx = 0; idx < ORDINAL_ALIASES.length; idx += 1) {
      if (idx < choices.length && ORDINAL_ALIASES[idx].includes(token)) {
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
):
  | { kind: "unique"; choice: ComprehensionChoiceUI }
  | { kind: "ambiguous"; candidates: readonly ComprehensionChoiceUI[] }
  | { kind: "none" } {
  if (!tokens.length) return { kind: "none" };
  const strippedTokens = tokens.filter((t) => !CHOICE_PREFIX_WORDS.has(t));
  const evalTokens = (strippedTokens.length ? strippedTokens : tokens).map(
    normalizeContentToken,
  );
  const fullTokens = tokens.map(normalizeContentToken);
  const evalSet = new Set(evalTokens);
  const fullJoined = fullTokens.join(" ");
  const strippedJoined = evalTokens.join(" ");

  const fullExactMatches: ComprehensionChoiceUI[] = [];
  const contiguousMatches: Array<{
    choice: ComprehensionChoiceUI;
    labelTokens: readonly string[];
    score: number;
  }> = [];
  let best: { choice: ComprehensionChoiceUI; score: number } | null = null;
  let secondScore = 0;
  const candidatesSharingToken: ComprehensionChoiceUI[] = [];

  for (const choice of choices) {
    const rawLabelTokens = tokenizeVietnameseText(choice.label);
    if (!rawLabelTokens.length) continue;
    const labelTokens = rawLabelTokens.map(normalizeContentToken);

    // Track partial distinct token overlap across choices to catch e.g. "Bạn" -> [Bạn Lan, Bạn An]
    const meaningfulLabelTokens = labelTokens.filter(
      (t) => !FILLER_OR_POLITE_WORDS.has(t),
    );
    if (
      meaningfulLabelTokens.some((t) => evalSet.has(t)) &&
      evalTokens.some((t) => meaningfulLabelTokens.includes(t))
    ) {
      candidatesSharingToken.push(choice);
    }

    const labelJoined = labelTokens.join(" ");
    const isFullExact =
      fullJoined === labelJoined || strippedJoined === labelJoined;

    if (isFullExact) {
      fullExactMatches.push(choice);
    }

    const isContiguous =
      isFullExact ||
      (labelTokens.length >= 2 &&
        (containsTokenSubsequence(evalTokens, labelTokens) ||
          containsTokenSubsequence(fullTokens, labelTokens)));

    if (isContiguous) {
      const score = isFullExact
        ? 1
        : 0.75 + 0.2 * (labelTokens.length / Math.max(evalTokens.length, 1));
      if (!isFullExact) {
        contiguousMatches.push({ choice, labelTokens, score });
      }
      if (!best || score > best.score) {
        secondScore = best ? best.score : 0;
        best = { choice, score };
      } else if (score > secondScore) {
        secondScore = score;
      }
      continue;
    }

    if (labelTokens.length >= 2) {
      let overlap = 0;
      for (const word of labelTokens) {
        if (evalSet.has(word)) overlap += 1;
      }
      const recall = overlap / labelTokens.length;
      const precision = overlap / evalTokens.length;
      const score =
        recall >= 0.6 && precision >= 0.5
          ? ((recall + precision) / 2) * 0.65
          : 0;
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

  if (fullExactMatches.length === 1) {
    return { kind: "unique", choice: fullExactMatches[0] };
  }
  if (fullExactMatches.length >= 2) {
    return { kind: "ambiguous", candidates: fullExactMatches };
  }

  // If one contiguous phrase strictly subsumes shorter prefix matches
  // (e.g. "B, bạn An nhỏ ạ" vs "Bạn An"), prefer the longest contiguous match.
  if (contiguousMatches.length >= 2) {
    const sorted = [...contiguousMatches].sort(
      (a, b) => b.labelTokens.length - a.labelTokens.length,
    );
    const longest = sorted[0];
    const allShorterSubsumed = sorted
      .slice(1)
      .every(
        (other) =>
          other.labelTokens.length < longest.labelTokens.length &&
          containsTokenSubsequence(longest.labelTokens, other.labelTokens),
      );
    if (allShorterSubsumed) {
      return { kind: "unique", choice: longest.choice };
    }
  }

  if (best && best.score - secondScore >= 0.2) {
    return { kind: "unique", choice: best.choice };
  }

  // Grade-1 short distinctive content answer (e.g. "ô" for "Chiếc ô", "dê" for "Con dê",
  // "xe" for "Xe đạp"): match uniquely when the child speaks a single non-classifier content
  // word that belongs to exactly ONE visible choice label.
  if (evalTokens.length === 1) {
    const singleToken = evalTokens[0];
    if (
      singleToken &&
      !CONTENT_CLASSIFIER_WORDS.has(singleToken) &&
      !FILLER_OR_POLITE_WORDS.has(singleToken) &&
      !CHOICE_MARKER_TOKENS.has(singleToken)
    ) {
      const uniqueContentMatches: ComprehensionChoiceUI[] = [];
      for (const choice of choices) {
        const labelTokens = tokenizeVietnameseText(choice.label).map(
          normalizeContentToken,
        );
        const distinctiveTokens = labelTokens.filter(
          (t) =>
            !CONTENT_CLASSIFIER_WORDS.has(t) && !FILLER_OR_POLITE_WORDS.has(t),
        );
        if (distinctiveTokens.includes(singleToken)) {
          uniqueContentMatches.push(choice);
        }
      }
      if (uniqueContentMatches.length === 1) {
        return { kind: "unique", choice: uniqueContentMatches[0] };
      }
      if (uniqueContentMatches.length >= 2) {
        return { kind: "ambiguous", candidates: uniqueContentMatches };
      }
    }
  }

  if (candidatesSharingToken.length >= 2) {
    return { kind: "ambiguous", candidates: candidatesSharingToken };
  }
  return { kind: "none" };
}

function findInlineLetterIndex(
  tokens: readonly string[],
  choices: readonly ComprehensionChoiceUI[],
): number | "ambiguous" | -1 {
  const choiceVocab = collectChoiceVocabulary(choices);
  const hasStrongLetterMarker = tokens.some((t) =>
    EXPLICIT_LETTER_MARKERS.has(t),
  );
  const matched = new Set<number>();
  for (const token of tokens) {
    const isNounHomophone = NOUN_HOMOPHONE_LETTER_ALIASES.has(token);
    if ((choiceVocab.has(token) || isNounHomophone) && !hasStrongLetterMarker) {
      continue;
    }
    for (
      let idx = 0;
      idx < choices.length && idx < LETTER_ALIASES.length;
      idx += 1
    ) {
      if (LETTER_ALIASES[idx].includes(token)) {
        matched.add(idx);
      }
    }
  }
  if (matched.size > 1) return "ambiguous";
  if (matched.size === 1) return [...matched][0];
  return -1;
}

/**
 * Full diagnostic resolver separating fillers, commands, negations,
 * self-corrections, ambiguous partial words, letter+content conflicts, and clear picks.
 */
export function analyzeComprehensionVoiceInput(
  transcript: string,
  choices: readonly ComprehensionChoiceUI[],
): ComprehensionVoiceAnalysis {
  const rawTokens = tokenizeVietnameseText(transcript);
  if (!rawTokens.length) return { type: "NONE" };
  const rawNormalized = rawTokens.join(" ");

  if (
    REPLAY_PHRASES.some(
      (phrase) => rawNormalized === phrase || rawNormalized.includes(phrase),
    )
  ) {
    return { type: "REPLAY" };
  }
  if (
    STOP_PHRASES.some(
      (phrase) => rawNormalized === phrase || rawNormalized.includes(phrase),
    )
  ) {
    return { type: "STOP" };
  }

  const { clause } = extractSelfCorrectedTail(rawNormalized);
  const tokens = tokenizeVietnameseText(clause);
  if (!tokens.length) return { type: "NONE" };

  // Reject pure polite fillers / hesitation sounds ("ạ", "à...", "dạ", "ờ")
  if (tokens.every((t) => FILLER_OR_POLITE_WORDS.has(t))) {
    return { type: "NONE" };
  }

  // Explicitly detect hesitations ("A hay B nhỉ?", "A hoặc B")
  if (tokens.includes("hay") || tokens.includes("hoặc")) {
    return {
      type: "AMBIGUOUS",
      candidates: choices.slice(0, 2),
      clarificationPrompt:
        "Con đang phân vân phải không? Mình nghĩ thêm rồi nói một đáp án con chọn nhé.",
    };
  }

  // Negation without positive correction ("con không chọn bạn An") must never submit
  if (NEGATION_RE.test(clause)) {
    return {
      type: "NEGATED",
      clarificationPrompt: "Vậy con muốn chọn đáp án nào nhé?",
    };
  }

  const contentRes = matchContentChoice(tokens, choices);
  const ordinalIdx = matchOrdinalIndex(tokens, choices);
  const hasPositionalMarker = tokens.includes("câu") || tokens.includes("thứ");
  if (
    hasPositionalMarker &&
    typeof ordinalIdx === "number" &&
    ordinalIdx >= 0 &&
    ordinalIdx < choices.length
  ) {
    return {
      type: "CHOICE",
      choice: choices[ordinalIdx],
      matchedBy: "ordinal",
    };
  }

  const inlineLetter =
    contentRes.kind === "unique"
      ? findInlineLetterIndex(
          subtractLabelTokens(
            tokens,
            tokenizeVietnameseText(contentRes.choice.label),
          ),
          choices,
        )
      : findInlineLetterIndex(tokens, choices);
  const pureLetter = matchLetterIndex(tokens, choices);

  // Conflict check: spoken both a letter ("A") and a DIFFERENT option's text ("bạn An")
  if (
    contentRes.kind === "unique" &&
    typeof inlineLetter === "number" &&
    inlineLetter >= 0 &&
    inlineLetter < choices.length
  ) {
    const letterChoice = choices[inlineLetter];
    if (letterChoice.id !== contentRes.choice.id) {
      return {
        type: "CONFLICT",
        letterChoice,
        contentChoice: contentRes.choice,
        clarificationPrompt: `Con chọn ${letterChoice.label} hay ${contentRes.choice.label}?`,
      };
    }
    return {
      type: "CHOICE",
      choice: contentRes.choice,
      matchedBy: "letter_and_content",
    };
  }

  if (contentRes.kind === "unique") {
    // Also verify no extra unconsumed choice content words create hidden conflict
    return { type: "CHOICE", choice: contentRes.choice, matchedBy: "content" };
  }

  if (pureLetter.index === "ambiguous") {
    return {
      type: "AMBIGUOUS",
      candidates: choices.slice(0, 2),
      clarificationPrompt: "Con nhắc lại một chữ cái đáp án rõ hơn nhé.",
    };
  }
  if (pureLetter.index >= 0 && pureLetter.index < choices.length) {
    return {
      type: "CHOICE",
      choice: choices[pureLetter.index],
      matchedBy: "letter",
    };
  }

  if (ordinalIdx === "ambiguous") {
    return {
      type: "AMBIGUOUS",
      candidates: choices.slice(0, 2),
      clarificationPrompt: "Con nói rõ số đáp án mình chọn nhé.",
    };
  }
  if (ordinalIdx >= 0 && ordinalIdx < choices.length) {
    return {
      type: "CHOICE",
      choice: choices[ordinalIdx],
      matchedBy: "ordinal",
    };
  }

  if (contentRes.kind === "ambiguous") {
    const names = contentRes.candidates
      .slice(0, 2)
      .map((c) => c.label)
      .join(" hay ");
    return {
      type: "AMBIGUOUS",
      candidates: contentRes.candidates,
      clarificationPrompt: `Con chọn ${names}?`,
    };
  }

  return { type: "NONE" };
}

/**
 * Resolve a child's spoken utterance against the active question's choices.
 * Returns simple discriminated union (`CHOICE | REPLAY | STOP | NONE`) compatible with
 * existing unit test contracts.
 */
export function matchComprehensionVoiceInput(
  transcript: string,
  choices: readonly ComprehensionChoiceUI[],
): ComprehensionVoiceMatch {
  const analysis = analyzeComprehensionVoiceInput(transcript, choices);
  if (
    analysis.type === "CHOICE" ||
    analysis.type === "REPLAY" ||
    analysis.type === "STOP"
  ) {
    return analysis;
  }
  return { type: "NONE" };
}
