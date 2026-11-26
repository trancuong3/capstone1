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

const PRIMARY_LETTER_ALIASES: readonly (readonly string[])[] = [
  // Index 0 -> A (IMPORTANT: NEVER include Vietnamese particles "à/á/ả/ã/ạ"!)
  ["a"],
  // Index 1 -> B
  ["b", "bê", "bề"],
  // Index 2 -> C
  ["c", "xê", "cê", "sê"],
  // Index 3 -> D
  ["d", "đê", "dờ", "đờ"],
];

// Common Vietnamese homophone nouns that must never match as a choice letter
// unless preceded by an explicit choice marker and absent from all visible options.
const HOMOPHONE_LETTER_ALIASES: readonly (readonly string[])[] = [
  [],
  ["bờ", "be"],
  ["cờ", "xe", "se"],
  ["dê", "đề", "de"],
];

const SINGLE_TOKEN_EXPLICIT_MARKERS = new Set(["chọn", "câu", "chữ", "ý"]);

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
];

const PURE_FILLER_OR_PRONOUN_TOKENS = new Set([
  "con",
  "bé",
  "em",
  "mình",
  "tớ",
  "dạ",
  "vâng",
  "thưa",
  "ạ",
  "à",
  "ờ",
  "ừ",
  "ừm",
  "cô",
  "thầy",
  "ơi",
  "nhé",
  "nha",
]);

function isOnlyFillerOrPronoun(fragment: string): boolean {
  const parts = fragment.trim().split(/\s+/u).filter(Boolean);
  return (
    parts.length === 0 ||
    parts.every((part) => PURE_FILLER_OR_PRONOUN_TOKENS.has(part))
  );
}

function isAnyHomophoneLetterAlias(token: string): boolean {
  return HOMOPHONE_LETTER_ALIASES.some((group) => group.includes(token));
}

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
  /(?:^|\s)(?:không\s+(?:(?:con|bé|em)\s+)?chọn|không\s+phải(?:\s+là)?|chẳng\s+chọn|chẳng\s+phải|đừng\s+chọn|không\s+lấy|không\s+đúng)(?:\s|$)/u;

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

  // Unanchored negation + positive correction:
  // "không phải A, chọn C", "không phải A, đáp án C", "đừng chọn A, chọn C", "bỏ A chọn C",
  // "con chọn A, không phải A mà C".
  // Guard: retracted <X> must contain real non-pronoun content so pure negations
  // like "không phải con chọn A" stay NEGATED and NEVER submit A!
  const negCorrectionMatch =
    /(?:^|\s)(?:không\s+(?:chọn|phải)|chẳng\s+(?:chọn|phải)|đừng\s+chọn|bỏ)\s+(.+?)\s+(?:mà\s+)?(?:(?:con|bé|em)\s+)?(?:(?:chọn|là)\s+|(?=(?:đáp\s+án|phương\s+án|câu)\s+))(.+)$/u.exec(
      normalized,
    );
  if (
    negCorrectionMatch?.[1] &&
    negCorrectionMatch?.[2] &&
    !isOnlyFillerOrPronoun(negCorrectionMatch[1])
  ) {
    return { clause: negCorrectionMatch[2].trim(), hadRevision: true };
  }

  // "không phải A mà C" / "đừng chọn A mà C"
  const notButMatch =
    /(?:^|\s)(?:không\s+(?:chọn|phải)|chẳng\s+(?:chọn|phải)|đừng\s+chọn|bỏ)\s+(.+?)\s+mà\s+(.+)$/u.exec(
      normalized,
    );
  if (
    notButMatch?.[1] &&
    notButMatch?.[2] &&
    !isOnlyFillerOrPronoun(notButMatch[1])
  ) {
    return { clause: notButMatch[2].trim(), hadRevision: true };
  }

  // Retracted-prefix correction: "A, không, con chọn B" or "A, không phải, chọn B".
  // Requires real retracted content BEFORE "không" so "không phải con chọn A" stays NEGATED!
  const prefixRetractMatch =
    /^(.+?)\s+không(?:\s+phải)?\s+(?:(?:con|bé|em)\s+)?(?:(?:chọn|là)\s+|(?=(?:đáp\s+án|phương\s+án|câu)\s+))(.+)$/u.exec(
      normalized,
    );
  if (
    prefixRetractMatch?.[1] &&
    prefixRetractMatch?.[2] &&
    !isOnlyFillerOrPronoun(prefixRetractMatch[1])
  ) {
    return { clause: prefixRetractMatch[2].trim(), hadRevision: true };
  }

  return { clause: normalized, hadRevision: false };
}

function collectVisibleChoiceTokens(
  choices: readonly ComprehensionChoiceUI[],
): Set<string> {
  const tokens = new Set<string>();
  for (const choice of choices) {
    for (const token of tokenizeVietnameseText(choice.label)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function hasExplicitChoiceMarkerBefore(
  tokens: readonly string[],
  index: number,
): boolean {
  let cursor = index - 1;
  if (cursor >= 0 && tokens[cursor] === "là") {
    cursor -= 1;
  }
  if (cursor < 0) return false;
  if (SINGLE_TOKEN_EXPLICIT_MARKERS.has(tokens[cursor])) {
    return true;
  }
  return (
    cursor >= 1 &&
    tokens[cursor] === "án" &&
    (tokens[cursor - 1] === "đáp" || tokens[cursor - 1] === "phương")
  );
}

function resolveLetterIndexAt(
  tokens: readonly string[],
  tokenIndex: number,
  choicesLength: number,
  visibleChoiceTokens: ReadonlySet<string>,
): number {
  const token = tokens[tokenIndex];
  if (!token) return -1;
  const hasExplicitMarker = hasExplicitChoiceMarkerBefore(tokens, tokenIndex);
  const inVisibleChoice = visibleChoiceTokens.has(token);
  const limit = Math.min(choicesLength, PRIMARY_LETTER_ALIASES.length);
  for (let idx = 0; idx < limit; idx += 1) {
    if (PRIMARY_LETTER_ALIASES[idx].includes(token)) {
      // Only let visibleChoiceTokens block bare unprefixed tokens (e.g. bare "bê"
      // when "Con bê" is an option). Explicit "con chọn B ạ" / "đáp án bê" ALWAYS resolves!
      if (!inVisibleChoice || hasExplicitMarker) {
        return idx;
      }
      return -1;
    }
  }
  // Homophone nouns ("dê", "xe", "cờ") require explicit marker AND absence from visible options.
  if (hasExplicitMarker && !inVisibleChoice) {
    const homophoneLimit = Math.min(
      choicesLength,
      HOMOPHONE_LETTER_ALIASES.length,
    );
    for (let idx = 0; idx < homophoneLimit; idx += 1) {
      if (HOMOPHONE_LETTER_ALIASES[idx].includes(token)) {
        return idx;
      }
    }
  }
  return -1;
}

function matchLetterIndex(
  tokens: readonly string[],
  choices: readonly ComprehensionChoiceUI[],
  visibleChoiceTokens: ReadonlySet<string>,
): { index: number | "ambiguous" | -1; hasExplicitMarker: boolean } {
  if (!tokens.length || tokens.length > 8) {
    return { index: -1, hasExplicitMarker: false };
  }
  if (tokens.includes("hay") || tokens.includes("hoặc")) {
    return { index: "ambiguous", hasExplicitMarker: false };
  }

  const matchedIndexes = new Set<number>();
  let hasExplicitMarker = false;
  let unknownNonPrefix = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (CHOICE_MARKER_TOKENS.has(token)) hasExplicitMarker = true;
    const found = resolveLetterIndexAt(
      tokens,
      i,
      choices.length,
      visibleChoiceTokens,
    );
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

    // Strip the same filler/classifier words from labels symmetrically so
    // "chọn bò ạ" matches "Con bò", while guarding bare homophones like "dê".
    const meaningfulLabelTokens = labelTokens.filter(
      (t) => !FILLER_OR_POLITE_WORDS.has(t),
    );
    const strippedLabelTokens = meaningfulLabelTokens.length
      ? meaningfulLabelTokens
      : labelTokens;
    if (
      meaningfulLabelTokens.some((t) => evalSet.has(t)) &&
      evalTokens.some((t) => meaningfulLabelTokens.includes(t))
    ) {
      candidatesSharingToken.push(choice);
    }

    const labelJoined = labelTokens.join(" ");
    const strippedLabelJoined = strippedLabelTokens.join(" ");
    const isBareHomophoneSingleToken =
      tokens.length === 1 && isAnyHomophoneLetterAlias(tokens[0]);
    const isFullExact =
      fullJoined === labelJoined ||
      strippedJoined === labelJoined ||
      (!isBareHomophoneSingleToken &&
        strippedLabelTokens.length < labelTokens.length &&
        strippedJoined === strippedLabelJoined);

    if (isFullExact) {
      fullExactMatches.push(choice);
    }

    const isContiguous =
      isFullExact ||
      (labelTokens.length >= 2 &&
        (containsTokenSubsequence(evalTokens, labelTokens) ||
          containsTokenSubsequence(fullTokens, labelTokens))) ||
      (!isBareHomophoneSingleToken &&
        strippedLabelTokens.length >= 2 &&
        containsTokenSubsequence(evalTokens, strippedLabelTokens));

    if (isContiguous) {
      const matchedLen = containsTokenSubsequence(evalTokens, labelTokens)
        ? labelTokens.length
        : strippedLabelTokens.length;
      const ratio = Math.min(1, matchedLen / Math.max(evalTokens.length, 1));
      const score = isFullExact ? 1 : Math.min(0.95, 0.75 + 0.2 * ratio);
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

    const computePartialScore = (candidateLabel: readonly string[]): number => {
      if (candidateLabel.length < 2) return 0;
      let overlap = 0;
      for (const word of candidateLabel) {
        if (evalSet.has(word)) overlap += 1;
      }
      const recall = overlap / candidateLabel.length;
      const precision = overlap / evalTokens.length;
      return recall >= 0.6 && precision >= 0.5
        ? Math.min(1, ((recall + precision) / 2) * 0.65)
        : 0;
    };

    const score = Math.max(
      computePartialScore(labelTokens),
      computePartialScore(strippedLabelTokens),
    );
    if (score > 0) {
      if (!best || score > best.score) {
        secondScore = best ? best.score : 0;
        best = { choice, score };
      } else if (score > secondScore) {
        secondScore = score;
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
  // word that belongs to exactly ONE visible choice label (never hijacking active ordinals
  // like "ba" when >= 3 choices exist so ordinal ambiguity still prompts clarification).
  if (evalTokens.length === 1) {
    const singleToken = evalTokens[0];
    const matchesActiveOrdinal = Boolean(
      singleToken &&
      ORDINAL_ALIASES.some(
        (aliases, idx) => idx < choices.length && aliases.includes(singleToken),
      ),
    );
    if (
      singleToken &&
      !matchesActiveOrdinal &&
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
  visibleChoiceTokens: ReadonlySet<string>,
): number | "ambiguous" | -1 {
  const matched = new Set<number>();
  for (let i = 0; i < tokens.length; i += 1) {
    const found = resolveLetterIndexAt(
      tokens,
      i,
      choices.length,
      visibleChoiceTokens,
    );
    if (found >= 0) {
      matched.add(found);
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

  const visibleChoiceTokens = collectVisibleChoiceTokens(choices);
  const inlineLetter =
    contentRes.kind === "unique"
      ? findInlineLetterIndex(
          subtractLabelTokens(
            tokens,
            tokenizeVietnameseText(contentRes.choice.label),
          ),
          choices,
          visibleChoiceTokens,
        )
      : findInlineLetterIndex(tokens, choices, visibleChoiceTokens);
  const pureLetter = matchLetterIndex(tokens, choices, visibleChoiceTokens);

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
    // Disambiguate non-positional ordinal (e.g. "chọn ba") when the ordinal token
    // also appears inside another option's label (e.g. Choice A = "Ba con bò").
    if (!hasPositionalMarker) {
      const ordinalTokens = ORDINAL_ALIASES[ordinalIdx] ?? [];
      const spokenOrdinalTokens = tokens.filter((t) =>
        ordinalTokens.includes(t),
      );
      const conflictingLabelChoice = choices.find(
        (choice, idx) =>
          idx !== ordinalIdx &&
          tokenizeVietnameseText(choice.label).some((tok) =>
            spokenOrdinalTokens.includes(tok),
          ),
      );
      if (conflictingLabelChoice) {
        const ordinalChoice = choices[ordinalIdx];
        return {
          type: "AMBIGUOUS",
          candidates: [conflictingLabelChoice, ordinalChoice],
          clarificationPrompt: `Con chọn ${conflictingLabelChoice.label} hay ${ordinalChoice.label}?`,
        };
      }
    }
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
