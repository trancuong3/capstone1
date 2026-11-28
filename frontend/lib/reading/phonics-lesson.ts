/**
 * Shared Vietnamese Grade-1 Step-by-Step Phonics Lesson Engine (`Đánh vần từng bước`).
 *
 * Used identically by:
 *  1. In-book Reading Screen (`ReadingScreen`)
 *  2. Difficult Words Practice (`DifficultWordPracticePanel`)
 *
 * Guarantees:
 *  - Strict Unicode NFC normalization from book source -> UI -> TTS input -> cache keys.
 *  - Never strips Vietnamese vowel marks (`ă/â/a`, `ê/e`, `ô/ơ/o`, `ư/u`), `đ/d`, or the 6 tones.
 *  - Canonical textbook decomposition for `"mốt"`:
 *      Step 1 (`rhyme_build`):   display `ô · tờ → ốt`  | spoken `"ô, tờ, ốt."`
 *      Step 2 (`onset_blend`):   display `mờ + ốt`      | spoken `"mờ, ốt."`
 *      Step 3 (`tone_blend`):    display `sắc → mốt`    | spoken `"sắc, mốt."`
 *      Step 4 (`whole_syllable`):display `mốt`          | spoken `"mốt."`
 *      (+ Step 5 `context_phrase` when practicing `"mốt"` inside `"hai mươi mốt"`).
 *  - Refuses to guess/fabricate phonics for foreign words, numbers, acronyms, or OCR-broken
 *    strings (`supported: false` -> UI displays `"Chưa có mẫu đánh vần"` while keeping `Nghe từ`).
 *  - Distinguishes 4 durable reading/practice outcomes without overwriting first-pass assessment:
 *      `FIRST_PASS_CORRECT` | `CORRECT_AFTER_HINT` | `CORRECT_AFTER_SPELLING` | `NEEDS_PRACTICE`.
 */

import {
  decomposeVietnameseSyllable,
  isPhonicsInProgress,
  matchPhonicsSpelling,
  splitVietnameseRhyme,
  type VietnameseTone,
} from "@/lib/reading/phonics-spelling";
import {
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";

export type ReadingWordMasteryOutcome =
  | "FIRST_PASS_CORRECT"
  | "CORRECT_AFTER_HINT"
  | "CORRECT_AFTER_SPELLING"
  | "NEEDS_PRACTICE";

export const READING_MASTERY_LABELS: Readonly<
  Record<ReadingWordMasteryOutcome, string>
> = {
  FIRST_PASS_CORRECT: "Đọc đúng ngay lần đầu",
  CORRECT_AFTER_HINT: "Đọc đúng sau gợi ý",
  CORRECT_AFTER_SPELLING: "Đọc đúng sau đánh vần",
  NEEDS_PRACTICE: "Cần luyện lại",
};

export type PhonicsStepKind =
  | "rhyme_build"
  | "onset_blend"
  | "tone_blend"
  | "whole_syllable"
  | "context_phrase";

export type PhonicsHighlightPart =
  | "rhyme"
  | "onset_and_rhyme"
  | "tone_and_syllable"
  | "whole_syllable"
  | "context";

export interface CharRange {
  readonly start: number;
  readonly end: number;
}

export interface PhonicsLessonStep {
  readonly id: string;
  readonly index: number;
  readonly kind: PhonicsStepKind;
  readonly displayText: string;
  /** Clean Vietnamese spoken phrase for TTS — never contains `-`, `→`, or raw non-syllabic symbols. */
  readonly spokenText: string;
  readonly highlightPart: PhonicsHighlightPart;
  /** Character slice inside `focusSyllable` (or `contextText` when `kind === "context_phrase"`). */
  readonly highlightRange: CharRange;
  /** Natural pause after this step (ms) so the child can hear & echo mentally. */
  readonly pauseAfterMs: number;
}

export type UnsupportedPhonicsReason =
  | "EMPTY"
  | "NUMBER_OR_SYMBOL"
  | "ACRONYM"
  | "FOREIGN_OR_NON_VIETNAMESE"
  | "UNVERIFIED_PROPER_NOUN";

export interface SupportedPhonicsLessonPlan {
  readonly supported: true;
  readonly source?: "rules" | "ai";
  readonly rawText: string;
  readonly cleanPhrase: string;
  readonly syllables: readonly string[];
  readonly focusSyllableIndex: number;
  readonly focusSyllable: string;
  /** Slice of `focusSyllable` within `cleanPhrase` (NFC code units). */
  readonly focusRangeInPhrase: CharRange;
  readonly onset: {
    readonly written: string;
    readonly spoken: string;
  } | null;
  readonly rhyme: {
    readonly written: string;
    readonly untoned: string;
    readonly nucleus: string;
    readonly coda: string;
    readonly spoken: string;
  };
  readonly tone: {
    readonly code: VietnameseTone;
    readonly label: string;
    readonly spoken: string | null;
  };
  readonly steps: readonly PhonicsLessonStep[];
}

export interface UnsupportedPhonicsLessonPlan {
  readonly supported: false;
  readonly rawText: string;
  readonly cleanPhrase: string;
  readonly reason: UnsupportedPhonicsReason;
  readonly message: "Chưa có mẫu đánh vần";
  /** True when `Nghe từ` whole-word sample can still be offered. */
  readonly canPlayWholeWord: boolean;
}

export type PhonicsLessonPlan =
  SupportedPhonicsLessonPlan | UnsupportedPhonicsLessonPlan;

const ONSET_SPOKEN: Readonly<Record<string, string>> = {
  b: "bờ",
  c: "cờ",
  k: "ca",
  d: "dờ",
  đ: "đờ",
  g: "gờ",
  gh: "gờ",
  gi: "gi",
  h: "hờ",
  l: "lờ",
  m: "mờ",
  n: "nờ",
  p: "pờ",
  ph: "phờ",
  q: "quờ",
  qu: "quờ",
  r: "rờ",
  s: "sờ",
  t: "tờ",
  th: "thờ",
  tr: "trờ",
  v: "vờ",
  x: "xờ",
  ch: "chờ",
  kh: "khờ",
  ng: "ngờ",
  ngh: "ngờ",
  nh: "nhờ",
};

const CODA_SPOKEN: Readonly<Record<string, string>> = {
  c: "cờ",
  ch: "chờ",
  m: "mờ",
  n: "nờ",
  ng: "ngờ",
  nh: "nhờ",
  p: "pờ",
  t: "tờ",
};

/**
 * SGK Tiếng Việt 1 spoken names for single vowel letters during rhyme building:
 * `ă` is spoken `"á"` and `â` is spoken `"ớ"` (standalone `ă`/`â` are not valid
 * open Vietnamese syllables).
 */
const VOWEL_LETTER_SPOKEN: Readonly<Record<string, string>> = {
  a: "a",
  ă: "á",
  â: "ớ",
  e: "e",
  ê: "ê",
  i: "i",
  y: "y",
  o: "o",
  ô: "ô",
  ơ: "ơ",
  u: "u",
  ư: "ư",
};

const TONE_INFO: Readonly<
  Record<
    VietnameseTone,
    { readonly label: string; readonly spoken: string | null }
  >
> = {
  ngang: { label: "thanh ngang", spoken: null },
  sac: { label: "dấu sắc", spoken: "sắc" },
  huyen: { label: "dấu huyền", spoken: "huyền" },
  hoi: { label: "dấu hỏi", spoken: "hỏi" },
  nga: { label: "dấu ngã", spoken: "ngã" },
  nang: { label: "dấu nặng", spoken: "nặng" },
};

/**
 * Approved Vietnamese rhymes (untoned NFC) taught in Grade 1–2 Vietnamese.
 * Rejects accidental OCR gibberish (`"aeo"`, `"iou"`, `"trng"`, `"piz"`) so ViRead
 * never invents fake phonics for broken OCR or foreign words.
 */
const VALID_VIETNAMESE_UNT0NED_RHYMES = new Set([
  // Single vowels
  "a",
  "e",
  "ê",
  "i",
  "o",
  "ô",
  "ơ",
  "u",
  "ư",
  "y",
  // Diphthongs & open rhymes
  "ai",
  "ao",
  "au",
  "ay",
  "âu",
  "ây",
  "eo",
  "êu",
  "ia",
  "iu",
  "oa",
  "oe",
  "oi",
  "ôi",
  "ơi",
  "ua",
  "ưa",
  "uê",
  "uơ",
  "ui",
  "ưi",
  "ưu",
  "uy",
  "uya",
  "uyu",
  "uôi",
  "ươi",
  "oai",
  "oao",
  "oay",
  "oeo",
  "uây",
  "iêu",
  "yêu",
  "ươu",
  // -m / -n / -ng / -nh rhymes
  "am",
  "ăm",
  "âm",
  "em",
  "êm",
  "im",
  "om",
  "ôm",
  "ơm",
  "um",
  "ưm",
  "iêm",
  "yêm",
  "uôm",
  "ươm",
  "oam",
  "oăm",
  "uâm",
  "uêm",
  "uym",
  "an",
  "ăn",
  "ân",
  "en",
  "ên",
  "in",
  "on",
  "ôn",
  "ơn",
  "un",
  "ưn",
  "oan",
  "oăn",
  "oen",
  "uan",
  "uân",
  "uyên",
  "uyn",
  "iên",
  "yên",
  "uôn",
  "ươn",
  "ang",
  "ăng",
  "âng",
  "eng",
  "ong",
  "ông",
  "ung",
  "ưng",
  "oang",
  "oăng",
  "oong",
  "oeng",
  "uang",
  "uâng",
  "iêng",
  "yêng",
  "uông",
  "ương",
  "anh",
  "ênh",
  "inh",
  "oanh",
  "uênh",
  "uynh",
  // Checked codas (-c / -ch / -p / -t)
  "ac",
  "ăc",
  "âc",
  "ec",
  "êc",
  "oc",
  "ôc",
  "uc",
  "ưc",
  "oac",
  "oăc",
  "oec",
  "ooc",
  "uâc",
  "uêc",
  "uôc",
  "iêc",
  "yêc",
  "ươc",
  "ach",
  "êch",
  "ich",
  "oach",
  "uêch",
  "uych",
  "ap",
  "ăp",
  "âp",
  "ep",
  "êp",
  "ip",
  "op",
  "ôp",
  "ơp",
  "up",
  "ưp",
  "oap",
  "oăp",
  "oep",
  "uâp",
  "uôp",
  "uyp",
  "iêp",
  "yêp",
  "ươp",
  "at",
  "ăt",
  "ât",
  "et",
  "êt",
  "it",
  "ot",
  "ôt",
  "ơt",
  "ut",
  "ưt",
  "oat",
  "oăt",
  "oet",
  "uat",
  "uât",
  "uêt",
  "uyt",
  "uyêt",
  "iêt",
  "yêt",
  "uôt",
  "ươt",
]);

const SAC_VOWEL_MAP: Readonly<Record<string, string>> = {
  a: "á",
  ă: "ắ",
  â: "ấ",
  e: "é",
  ê: "ế",
  i: "í",
  o: "ó",
  ô: "ố",
  ơ: "ớ",
  u: "ú",
  ư: "ứ",
  y: "ý",
};

function applySacForCheckedRhyme(untonedRhyme: string, coda: string): string {
  const nucleus = coda ? untonedRhyme.slice(0, -coda.length) : untonedRhyme;
  let targetIdx = 0;
  for (let i = 0; i < nucleus.length; i += 1) {
    if ("ăâêôơư".includes(nucleus[i])) {
      targetIdx = i;
      break;
    }
  }
  if (
    nucleus.length >= 2 &&
    !"ăâêôơư".includes(nucleus[targetIdx]) &&
    (nucleus.startsWith("oa") ||
      nucleus.startsWith("oe") ||
      nucleus.startsWith("uy"))
  ) {
    targetIdx = 1;
  }
  const ch = nucleus[targetIdx];
  const toned = SAC_VOWEL_MAP[ch] ?? ch;
  return (
    nucleus.slice(0, targetIdx) +
    toned +
    nucleus.slice(targetIdx + 1) +
    coda
  ).normalize("NFC");
}

function stripOuterPunctuationPreservingNfc(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function hasForeignLetters(token: string): boolean {
  return /[fjwzFJWZ]/u.test(token);
}

/**
 * In Vietnamese orthography:
 *  - After onset `gi`, rhymes starting with `iê` drop the duplicate `i` (`gi` + `iêng` -> `giếng`,
 *    `gi` + `iêt` -> `giết`, `gi` + `iêc` -> `giếc`, `gi` + `iêu` -> `giễu`).
 *  - After onset `qu`, rhymes `uynh`/`uyt`/`uych` drop the duplicate `u` (`qu` + `uynh` -> `quỳnh`,
 *    `qu` + `uyt` -> `quýt`, `qu` + `uych` -> `quỵch`).
 */
function resolveUnderlyingVietnameseRhyme(
  onset: string,
  rhyme: string,
): string {
  if (
    onset === "gi" &&
    (rhyme === "êng" ||
      rhyme === "êt" ||
      rhyme === "êc" ||
      rhyme === "êp" ||
      rhyme === "êu" ||
      rhyme === "êm" ||
      rhyme === "ên")
  ) {
    return `i${rhyme}`;
  }
  if (
    onset === "qu" &&
    (rhyme === "ynh" ||
      rhyme === "yt" ||
      rhyme === "ych" ||
      rhyme === "ya" ||
      rhyme === "yu" ||
      rhyme === "yên" ||
      rhyme === "yêt")
  ) {
    return `u${rhyme}`;
  }
  return rhyme;
}

function isOrthographicallyValidVietnamese(
  onset: string,
  untonedRhyme: string,
  coda: string,
  tone: VietnameseTone,
): boolean {
  const canonicalRhyme = resolveUnderlyingVietnameseRhyme(onset, untonedRhyme);
  if (!VALID_VIETNAMESE_UNT0NED_RHYMES.has(canonicalRhyme)) return false;
  // Checked codas (-c, -ch, -p, -t) in Vietnamese can ONLY carry sắc or nặng!
  if (
    (coda === "c" || coda === "ch" || coda === "p" || coda === "t") &&
    tone !== "sac" &&
    tone !== "nang"
  ) {
    return false;
  }
  // Orthographic distribution rules for k / gh / ngh / c /q
  const firstVowel = canonicalRhyme[0] ?? "";
  if ((onset === "gh" || onset === "ngh") && !"eêi".includes(firstVowel)) {
    return false;
  }
  if (onset === "q") return false; // bare 'q' without 'u' is invalid
  return true;
}

export interface BuildPhonicsLessonOptions {
  /** Explicit index in multi-syllable phrase (0-based) if caller knows which syllable failed. */
  readonly focusSyllableIndex?: number;
  /** Child's spoken attempt so we can automatically focus the first mismatched syllable. */
  readonly spokenAttempt?: string | null;
  /** True when the token comes from mid-sentence capitalized proper noun that shouldn't be guessed if multi-word foreign. */
  readonly rejectCapitalizedProperNoun?: boolean;
}

function locateSyllableSlices(cleanPhrase: string): {
  readonly text: string;
  readonly normalized: string;
  readonly range: CharRange;
}[] {
  const out: {
    readonly text: string;
    readonly normalized: string;
    readonly range: CharRange;
  }[] = [];
  const regex = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanPhrase)) !== null) {
    const surface = match[0].normalize("NFC");
    const normalized = normalizeVietnameseWord(surface);
    out.push({
      text: surface,
      normalized,
      range: { start: match.index, end: match.index + surface.length },
    });
  }
  return out;
}

function pickFocusIndex(
  syllables: readonly { readonly text: string; readonly normalized: string }[],
  options: BuildPhonicsLessonOptions,
): number {
  if (
    options.focusSyllableIndex !== undefined &&
    options.focusSyllableIndex >= 0 &&
    options.focusSyllableIndex < syllables.length
  ) {
    return options.focusSyllableIndex;
  }
  if (options.spokenAttempt && syllables.length > 1) {
    const spokenTokens = tokenizeVietnameseText(options.spokenAttempt);
    if (spokenTokens.length > 0) {
      for (let i = 0; i < syllables.length; i += 1) {
        if (spokenTokens[i] !== syllables[i].normalized) {
          return i;
        }
      }
    }
  }
  if (syllables.length === 1) return 0;
  // Default to the final / most complex syllable (e.g. "mốt" in "hai mươi mốt")
  let bestIdx = syllables.length - 1;
  let bestScore = -1;
  for (let i = 0; i < syllables.length; i += 1) {
    const parts = decomposeVietnameseSyllable(syllables[i].normalized);
    const score = parts
      ? parts.rhyme.length * 2 + (parts.tone !== "ngang" ? 1 : 0) + i * 0.5
      : 0;
    if (score >= bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function buildPhonicsLesson(
  rawInput: string,
  options: BuildPhonicsLessonOptions = {},
): PhonicsLessonPlan {
  const rawNfc = (rawInput ?? "").normalize("NFC");
  const cleanPhrase = stripOuterPunctuationPreservingNfc(rawNfc);

  if (!cleanPhrase) {
    return {
      supported: false,
      rawText: rawNfc,
      cleanPhrase: "",
      reason: "EMPTY",
      message: "Chưa có mẫu đánh vần",
      canPlayWholeWord: false,
    };
  }

  if (/\d/u.test(cleanPhrase)) {
    return {
      supported: false,
      rawText: rawNfc,
      cleanPhrase,
      reason: "NUMBER_OR_SYMBOL",
      message: "Chưa có mẫu đánh vần",
      canPlayWholeWord: true,
    };
  }

  const syllableSlices = locateSyllableSlices(cleanPhrase);
  if (syllableSlices.length === 0) {
    return {
      supported: false,
      rawText: rawNfc,
      cleanPhrase,
      reason: "EMPTY",
      message: "Chưa có mẫu đánh vần",
      canPlayWholeWord: false,
    };
  }

  // Reject genuine all-uppercase acronyms >= 2 chars (e.g. "SGK", "UBND", "TV"),
  // while ALLOWING valid ALL-CAPS Vietnamese words/headings (e.g. "TRƯỜNG", "HỌC",
  // "TỰ", "TOÁN", "PHAN", "QUÝ") that pass Vietnamese syllable orthography!
  const isAllUpperSlice = (text: string): boolean =>
    text.length >= 2 &&
    text === text.toUpperCase() &&
    text !== text.toLowerCase();

  if (options.rejectCapitalizedProperNoun) {
    const isCapitalized = syllableSlices.every(
      (s) =>
        s.text.length > 0 &&
        s.text[0] === s.text[0].toUpperCase() &&
        s.text[0] !== s.text[0].toLowerCase(),
    );
    if (isCapitalized) {
      return {
        supported: false,
        rawText: rawNfc,
        cleanPhrase,
        reason: "UNVERIFIED_PROPER_NOUN",
        message: "Chưa có mẫu đánh vần",
        canPlayWholeWord: true,
      };
    }
  }

  // Every syllable in the word/phrase must be valid Vietnamese orthography
  for (const slice of syllableSlices) {
    const sliceIsAllUpper = isAllUpperSlice(slice.text);
    if (hasForeignLetters(slice.text)) {
      return {
        supported: false,
        rawText: rawNfc,
        cleanPhrase,
        reason: sliceIsAllUpper ? "ACRONYM" : "FOREIGN_OR_NON_VIETNAMESE",
        message: "Chưa có mẫu đánh vần",
        canPlayWholeWord: true,
      };
    }
    const parts = decomposeVietnameseSyllable(slice.normalized);
    if (!parts) {
      return {
        supported: false,
        rawText: rawNfc,
        cleanPhrase,
        reason: sliceIsAllUpper ? "ACRONYM" : "FOREIGN_OR_NON_VIETNAMESE",
        message: "Chưa có mẫu đánh vần",
        canPlayWholeWord: true,
      };
    }
    const { coda } = splitVietnameseRhyme(parts.rhyme);
    if (
      !isOrthographicallyValidVietnamese(
        parts.onset,
        parts.rhyme,
        coda,
        parts.tone,
      )
    ) {
      return {
        supported: false,
        rawText: rawNfc,
        cleanPhrase,
        reason: sliceIsAllUpper ? "ACRONYM" : "FOREIGN_OR_NON_VIETNAMESE",
        message: "Chưa có mẫu đánh vần",
        canPlayWholeWord: true,
      };
    }
  }

  const focusIdx = pickFocusIndex(syllableSlices, options);
  const focusSlice = syllableSlices[focusIdx];
  const parts = decomposeVietnameseSyllable(focusSlice.normalized)!;
  const canonicalRhyme = resolveUnderlyingVietnameseRhyme(
    parts.onset,
    parts.rhyme,
  );
  const { nucleus, coda } = splitVietnameseRhyme(canonicalRhyme);
  const isCheckedCoda =
    coda === "c" || coda === "ch" || coda === "p" || coda === "t";
  const spokenRhyme = isCheckedCoda
    ? applySacForCheckedRhyme(canonicalRhyme, coda)
    : canonicalRhyme;

  const focusSyllable = parts.normalized;
  // Determine onset vs rhyme character split inside `focusSyllable`
  // Special case: `"gì"` / `"giếng"` / `"quýt"` where `i` or `u` is shared at the boundary
  const onsetCharLen =
    parts.onset === "gi" &&
    (focusSyllable.length === 2 || canonicalRhyme !== parts.rhyme)
      ? 1
      : parts.onset === "qu" && canonicalRhyme !== parts.rhyme
        ? 1
        : parts.onset.length;
  const writtenRhyme = focusSyllable.slice(onsetCharLen) || focusSyllable;
  const rhymeRangeInSyllable: CharRange = {
    start: onsetCharLen,
    end: focusSyllable.length,
  };
  const fullSyllableRange: CharRange = {
    start: 0,
    end: focusSyllable.length,
  };

  const onsetObj = parts.onset
    ? {
        written: parts.onset,
        spoken: ONSET_SPOKEN[parts.onset] ?? parts.onset,
      }
    : null;
  const toneMeta = TONE_INFO[parts.tone];

  const steps: PhonicsLessonStep[] = [];

  // Step A: Build compound rhyme (2+ chars, e.g. `ôt` -> `"ô, tờ, ốt."`, `ôi` -> `"ô, i, ôi."`)
  if (canonicalRhyme.length >= 2) {
    const spokenLetters = [...nucleus].map(
      (ch) => VOWEL_LETTER_SPOKEN[ch] ?? ch,
    );
    const displayLetters = [...nucleus];
    if (coda) {
      spokenLetters.push(CODA_SPOKEN[coda] ?? coda);
      displayLetters.push(CODA_SPOKEN[coda] ?? coda);
    }
    steps.push({
      id: "rhyme_build",
      index: steps.length,
      kind: "rhyme_build",
      displayText: `${displayLetters.join(" · ")} → ${spokenRhyme}`,
      spokenText: `${spokenLetters.join(", ")}, ${spokenRhyme}.`,
      highlightPart: "rhyme",
      highlightRange: rhymeRangeInSyllable,
      pauseAfterMs: 420,
    });
  }

  // Step B: Blend onset + rhyme
  if (onsetObj) {
    if (canonicalRhyme.length >= 2) {
      // Canonical SGK / mandatory `"mốt"` form:
      // For `"mốt"`: Step 2 is `"mờ, ốt."` (when tone != ngang, Step 3 adds `"sắc, mốt."`),
      // or when tone === "ngang" (e.g. `"tôi"`), Step 2 blends directly `"tờ, ôi, tôi."`!
      if (parts.tone === "ngang") {
        steps.push({
          id: "onset_blend",
          index: steps.length,
          kind: "onset_blend",
          displayText: `${onsetObj.spoken} + ${spokenRhyme} → ${focusSyllable}`,
          spokenText: `${onsetObj.spoken}, ${spokenRhyme}, ${focusSyllable}.`,
          highlightPart: "onset_and_rhyme",
          highlightRange: fullSyllableRange,
          pauseAfterMs: 420,
        });
      } else if (isCheckedCoda) {
        // Canonical SGK / mandatory `"mốt"` form for checked codas (p/t/c/ch):
        // Step 2 stays `"mờ, ốt."` and Step 3 applies `"sắc, mốt."`.
        steps.push({
          id: "onset_blend",
          index: steps.length,
          kind: "onset_blend",
          displayText: `${onsetObj.spoken} + ${spokenRhyme}`,
          spokenText: `${onsetObj.spoken}, ${spokenRhyme}.`,
          highlightPart: "onset_and_rhyme",
          highlightRange: fullSyllableRange,
          pauseAfterMs: 420,
        });
      } else {
        // Unchecked compound rhymes with non-ngang tones (e.g. `"chuyện"`):
        // explicitly blend the base untoned syllable `"chờ + uyên → chuyên"` before tone step.
        steps.push({
          id: "onset_blend",
          index: steps.length,
          kind: "onset_blend",
          displayText: `${onsetObj.spoken} + ${spokenRhyme} → ${parts.untonedSyllable}`,
          spokenText: `${onsetObj.spoken}, ${spokenRhyme}, ${parts.untonedSyllable}.`,
          highlightPart: "onset_and_rhyme",
          highlightRange: fullSyllableRange,
          pauseAfterMs: 420,
        });
      }
    } else {
      // Single-vowel rhyme with onset (e.g. `"tê"` -> `"tờ, ê, tê."`, `"cá"` -> `"cờ, a, ca."`)
      const vowelSpoken = VOWEL_LETTER_SPOKEN[canonicalRhyme] ?? canonicalRhyme;
      const untonedBlend = parts.untonedSyllable;
      steps.push({
        id: "onset_blend",
        index: steps.length,
        kind: "onset_blend",
        displayText: `${onsetObj.spoken} + ${canonicalRhyme} → ${untonedBlend}`,
        spokenText: `${onsetObj.spoken}, ${vowelSpoken}, ${untonedBlend}.`,
        highlightPart: "onset_and_rhyme",
        highlightRange: fullSyllableRange,
        pauseAfterMs: 420,
      });
    }
  }

  // Step C: Apply Vietnamese tone mark -> toned syllable (for non-ngang tones, e.g. `"sắc, mốt."`)
  if (toneMeta.spoken) {
    if (!onsetObj && canonicalRhyme.length === 1) {
      const baseVowel = VOWEL_LETTER_SPOKEN[canonicalRhyme] ?? canonicalRhyme;
      steps.push({
        id: "tone_blend",
        index: steps.length,
        kind: "tone_blend",
        displayText: `${baseVowel} + ${toneMeta.spoken} → ${focusSyllable}`,
        spokenText: `${baseVowel}, ${toneMeta.spoken}, ${focusSyllable}.`,
        highlightPart: "tone_and_syllable",
        highlightRange: fullSyllableRange,
        pauseAfterMs: 450,
      });
    } else {
      steps.push({
        id: "tone_blend",
        index: steps.length,
        kind: "tone_blend",
        displayText: `${toneMeta.spoken} → ${focusSyllable}`,
        spokenText: `${toneMeta.spoken}, ${focusSyllable}.`,
        highlightPart: "tone_and_syllable",
        highlightRange: fullSyllableRange,
        pauseAfterMs: 450,
      });
    }
  }

  // Step D: Clear whole toned syllable confirmation (`"mốt."`)
  steps.push({
    id: "whole_syllable",
    index: steps.length,
    kind: "whole_syllable",
    displayText: focusSyllable,
    spokenText: `${focusSyllable}.`,
    highlightPart: "whole_syllable",
    highlightRange: fullSyllableRange,
    pauseAfterMs: syllableSlices.length > 1 ? 450 : 320,
  });

  // Step E: Multi-syllable phrase blend in context (e.g. `"hai mươi mốt."`)
  if (syllableSlices.length > 1) {
    const normalizedPhrase = syllableSlices.map((s) => s.normalized).join(" ");
    steps.push({
      id: "context_phrase",
      index: steps.length,
      kind: "context_phrase",
      displayText: cleanPhrase,
      spokenText: `${normalizedPhrase}.`,
      highlightPart: "context",
      highlightRange: { start: 0, end: cleanPhrase.length },
      pauseAfterMs: 320,
    });
  }

  return {
    supported: true,
    rawText: rawNfc,
    cleanPhrase,
    syllables: syllableSlices.map((s) => s.normalized),
    focusSyllableIndex: focusIdx,
    focusSyllable,
    focusRangeInPhrase: focusSlice.range,
    onset: onsetObj,
    rhyme: {
      written: writtenRhyme,
      untoned: canonicalRhyme,
      nucleus,
      coda,
      spoken: spokenRhyme,
    },
    tone: {
      code: parts.tone,
      label: toneMeta.label,
      spoken: toneMeta.spoken,
    },
    steps,
  };
}

export type PostPhonicsAttemptClassification =
  | { readonly kind: "EMPTY_OR_UNCERTAIN" }
  | { readonly kind: "SPELLING_STEP_ONLY"; readonly message: string }
  | { readonly kind: "WRONG_TONE"; readonly spoken: string }
  | { readonly kind: "WRONG_WORD"; readonly spoken: string }
  | {
      readonly kind: "CORRECT_SYLLABLE_NEEDS_PHRASE";
      readonly message: string;
    }
  | {
      readonly kind: "CORRECT_AFTER_SPELLING";
      readonly mastery: "CORRECT_AFTER_SPELLING";
    };

/**
 * Evaluate the child's spoken attempt AFTER hearing a step-by-step phonics lesson:
 *  - Rejects intermediate spelling cues (`"ô, tờ, ốt"` or `"mờ, ốt"`) as `SPELLING_STEP_ONLY`
 *    so repeating a partial cue NEVER falsely marks `"mốt"` as read!
 *  - Strictly checks Vietnamese vowel marks + tone (`"một"` or `"mót"` for `"mốt"` -> `WRONG_TONE`).
 *  - Accepts either the blended target syllable (`"mốt"`) OR full spelling ending in `"mốt"`
 *    (`"ô tờ ốt mờ ốt sắc mốt"`), and for multi-syllable words accepts the full phrase or
 *    prompts to blend the full phrase.
 */
export function evaluatePostPhonicsAttempt(
  transcript: string,
  lesson: SupportedPhonicsLessonPlan,
  options: { readonly requireFullPhrase?: boolean } = {},
): PostPhonicsAttemptClassification {
  const tokens = tokenizeVietnameseText(transcript.normalize("NFC"));
  if (tokens.length === 0) {
    return { kind: "EMPTY_OR_UNCERTAIN" };
  }

  const target = lesson.focusSyllable;
  const fullPhraseTokens = lesson.syllables;

  // 1. Multi-syllable full phrase check (e.g. "hai mươi mốt")
  if (fullPhraseTokens.length > 1 && tokens.length >= fullPhraseTokens.length) {
    for (
      let start = 0;
      start <= tokens.length - fullPhraseTokens.length;
      start += 1
    ) {
      const slice = tokens.slice(start, start + fullPhraseTokens.length);
      if (slice.every((tok, idx) => tok === fullPhraseTokens[idx])) {
        return {
          kind: "CORRECT_AFTER_SPELLING",
          mastery: "CORRECT_AFTER_SPELLING",
        };
      }
    }
  }

  // 2. Did the child only echo intermediate spelling steps WITHOUT saying `target`?
  const containsExactTarget = tokens.includes(target);
  if (!containsExactTarget) {
    if (isPhonicsInProgress(tokens, target)) {
      return {
        kind: "SPELLING_STEP_ONLY",
        message: `Con đánh vần đúng nhịp rồi! Giờ con đọc trọn tiếng “${target}” nhé!`,
      };
    }

    // Check if the child said the right base letters/rhyme but the WRONG Vietnamese tone or vowel mark
    const targetParts = decomposeVietnameseSyllable(target);
    const lastToken = tokens[tokens.length - 1];
    const lastParts = decomposeVietnameseSyllable(lastToken);
    if (targetParts && lastParts) {
      const targetSkeleton = targetParts.untonedSyllable
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "");
      const lastSkeleton = lastParts.untonedSyllable
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "");
      if (
        (targetParts.untonedSyllable === lastParts.untonedSyllable &&
          targetParts.tone !== lastParts.tone) ||
        (targetParts.onset === lastParts.onset &&
          targetSkeleton === lastSkeleton &&
          targetParts.normalized !== lastParts.normalized)
      ) {
        return { kind: "WRONG_TONE", spoken: lastToken };
      }
    }

    return { kind: "WRONG_WORD", spoken: lastToken };
  }

  // 3. `tokens` contains `target` (either standalone `"mốt"` or `"ô tờ ốt mờ ốt sắc mốt"`).
  // Ensure `target` is either a valid phonics sequence ending in `target` or the final spoken word!
  const lastToken = tokens[tokens.length - 1];
  const phonicsMatch = matchPhonicsSpelling(tokens, target);
  if (lastToken !== target && !phonicsMatch) {
    return { kind: "WRONG_WORD", spoken: lastToken };
  }

  if (options.requireFullPhrase && fullPhraseTokens.length > 1) {
    return {
      kind: "CORRECT_SYLLABLE_NEEDS_PHRASE",
      message: `Giỏi lắm, con đọc đúng tiếng “${target}” rồi! Giờ mình đọc cả cụm “${lesson.cleanPhrase}” nhé!`,
    };
  }

  return {
    kind: "CORRECT_AFTER_SPELLING",
    mastery: "CORRECT_AFTER_SPELLING",
  };
}

export interface RawAiPhonicsPayload {
  readonly supported: boolean;
  readonly source?: "rules" | "ai" | "none";
  readonly raw_text?: string;
  readonly clean_phrase?: string;
  readonly syllables?: readonly string[];
  readonly focus_syllable_index?: number;
  readonly focus_syllable?: string;
  readonly focus_range_start?: number;
  readonly focus_range_end?: number;
  readonly onset?: { readonly written: string; readonly spoken: string } | null;
  readonly rhyme?: {
    readonly written: string;
    readonly untoned: string;
    readonly nucleus: string;
    readonly coda: string;
    readonly spoken: string;
  } | null;
  readonly tone?: {
    readonly key: VietnameseTone;
    readonly label: string;
    readonly spoken: string | null;
  } | null;
  readonly steps?: readonly {
    readonly id: string;
    readonly index: number;
    readonly kind: PhonicsStepKind;
    readonly display_text: string;
    readonly spoken_text: string;
    readonly highlight_part: PhonicsHighlightPart;
    readonly highlight_start: number;
    readonly highlight_end: number;
    readonly pause_after_ms: number;
  }[];
}

/**
 * Convert a validated `/voice/phonics/analyze` AI payload into a `SupportedPhonicsLessonPlan`.
 * Returns `null` if the payload is unsupported or fails structural safety checks.
 */
export function normalizeAiPhonicsResponse(
  payload: RawAiPhonicsPayload | null | undefined,
  fallbackRawText: string,
): SupportedPhonicsLessonPlan | null {
  if (!payload || !payload.supported || !payload.steps?.length) return null;
  const rawText = (payload.raw_text || fallbackRawText).normalize("NFC").trim();
  const cleanPhrase = (payload.clean_phrase || rawText).normalize("NFC").trim();
  const focusSyllable = (payload.focus_syllable || cleanPhrase)
    .normalize("NFC")
    .trim()
    .toLowerCase();
  if (!cleanPhrase || !focusSyllable || !payload.rhyme || !payload.tone) {
    return null;
  }
  const steps: PhonicsLessonStep[] = payload.steps
    .map((step, idx) => ({
      id: step.id || `${step.kind}_${idx}`,
      index: idx,
      kind: step.kind,
      displayText: step.display_text.normalize("NFC").trim(),
      spokenText: step.spoken_text
        .normalize("NFC")
        .replace(/[→+\-/*=<>{}\[\]|\\~^_`#@$%&]+/g, ", ")
        .replace(/\s+/g, " ")
        .trim(),
      highlightPart: step.highlight_part,
      highlightRange: {
        start: Math.max(0, step.highlight_start),
        end: Math.max(Math.max(0, step.highlight_start), step.highlight_end),
      },
      pauseAfterMs: Math.max(150, Math.min(1500, step.pause_after_ms || 420)),
    }))
    .filter((s) => s.displayText.length > 0 && s.spokenText.length > 0);

  if (steps.length < 2) return null;

  const syllables =
    payload.syllables && payload.syllables.length > 0
      ? payload.syllables.map((s) => s.normalize("NFC").trim()).filter(Boolean)
      : [focusSyllable];
  const focusSyllableIndex = Math.max(
    0,
    Math.min(syllables.length - 1, payload.focus_syllable_index ?? 0),
  );
  const start = Math.max(0, payload.focus_range_start ?? 0);
  const end = Math.max(
    start,
    Math.min(cleanPhrase.length, payload.focus_range_end ?? cleanPhrase.length),
  );

  return {
    supported: true,
    source: payload.source === "rules" ? "rules" : "ai",
    rawText,
    cleanPhrase,
    syllables,
    focusSyllableIndex,
    focusSyllable,
    focusRangeInPhrase: { start, end },
    onset: payload.onset
      ? {
          written: payload.onset.written.normalize("NFC").trim(),
          spoken: payload.onset.spoken.normalize("NFC").trim(),
        }
      : null,
    rhyme: {
      written: payload.rhyme.written.normalize("NFC").trim(),
      untoned: payload.rhyme.untoned.normalize("NFC").trim(),
      nucleus: payload.rhyme.nucleus.normalize("NFC").trim(),
      coda: payload.rhyme.coda.normalize("NFC").trim(),
      spoken: payload.rhyme.spoken.normalize("NFC").trim(),
    },
    tone: {
      code: payload.tone.key,
      label: payload.tone.label.normalize("NFC").trim(),
      spoken: payload.tone.spoken
        ? payload.tone.spoken.normalize("NFC").trim()
        : null,
    },
    steps,
  };
}
