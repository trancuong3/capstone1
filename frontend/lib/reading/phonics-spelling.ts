/**
 * Vietnamese Grade-1 phonics (đánh vần) matcher & pedagogical phonics guide
 * (GDPT 2018 — G19, G25, G26, G28).
 *
 * First-grade Vietnamese readers sound out syllables using two textbook models:
 *  1. Vowel/rhyme-first, onset-second (SGK Tiếng Việt 1):
 *     - "ê - tờ - ê - tê" -> "tê"
 *     - "a - cờ - a - ca - sắc - cá" -> "cá"
 *     - "ô - i - ôi - tờ - ôi - tôi" -> "tôi"
 *     - "ơ - mờ - ơm - cờ - ơm - cơm" -> "cơm"
 *     - "ư - ơ - cờ - ước - nờ - ước - nước - sắc - nước" -> "nước"
 *  2. Onset-first, rhyme-second, tone, blend:
 *     - "tờ - ê - tê" -> "tê"
 *     - "mờ - e - me - nặng - mẹ" -> "mẹ"
 *     - "gi - a - gia - huyền - già" -> "già"
 *     - "quờ - a - qua - hỏi - quả" -> "quả"
 *
 * Real ASR (Web Speech `vi-VN` & server STT) frequently drops or shifts tones on
 * isolated pre-target cues (e.g. "tờ" -> "tơ", "ê" -> "ế"). This module applies
 * controlled phonetic tolerance ONLY to pre-target cue positions while strictly
 * requiring the final blended word to match the exact target word (including
 * full Vietnamese vowel marks, đ, and all 6 tones).
 */

import {
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";
import {
  adaptTextToTeacherPersona,
  type VoiceGender,
} from "@/lib/reading/voice-persona";

export type VietnameseTone = "ngang" | "sac" | "huyen" | "hoi" | "nga" | "nang";

export interface VietnameseSyllableParts {
  readonly normalized: string;
  readonly onset: string;
  readonly rhyme: string;
  readonly untonedSyllable: string;
  readonly tone: VietnameseTone;
}

export function splitVietnameseRhyme(rhyme: string): {
  readonly nucleus: string;
  readonly coda: string;
} {
  for (const candidate of CODAS) {
    if (rhyme.length > candidate.length && rhyme.endsWith(candidate)) {
      return {
        nucleus: rhyme.slice(0, -candidate.length),
        coda: candidate,
      };
    }
  }
  return { nucleus: rhyme, coda: "" };
}

export interface PhonicsSpellingMatch {
  readonly matched: true;
  /** Total tokens consumed from the start of the slice (cues + target word). */
  readonly consumedCount: number;
  /** Number of spelling cue tokens preceding the final blended target word. */
  readonly cueCount: number;
}

/** Longest-first Vietnamese onsets (âm đầu). */
const ONSETS = [
  "ngh",
  "ng",
  "nh",
  "ch",
  "gh",
  "gi",
  "kh",
  "ph",
  "qu",
  "th",
  "tr",
  "b",
  "c",
  "d",
  "đ",
  "g",
  "h",
  "k",
  "l",
  "m",
  "n",
  "p",
  "q",
  "r",
  "s",
  "t",
  "v",
  "x",
] as const;

const CODAS = ["ch", "ng", "nh", "c", "m", "n", "p", "t"] as const;

/** Canonical spoken names for pedagogical TTS guidance (SGK Lớp 1). */
const CANONICAL_ONSET_SPOKEN: Readonly<Record<string, string>> = {
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

const CANONICAL_CODA_SPOKEN: Readonly<Record<string, string>> = {
  c: "cờ",
  ch: "chờ",
  m: "mờ",
  n: "nờ",
  ng: "ngờ",
  nh: "nhờ",
  p: "pờ",
  t: "tờ",
};

const CANONICAL_TONE_SPOKEN: Readonly<Record<VietnameseTone, string>> = {
  ngang: "",
  sac: "sắc",
  huyen: "huyền",
  hoi: "hỏi",
  nga: "ngã",
  nang: "nặng",
};

/**
 * Grade-1 spoken names for onsets and codas, including real-world ASR phonetic
 * variants (dropped/shifted tone on isolated consonant names).
 * Strictly used for PRE-TARGET cues only — never for the final target word.
 */
const CONSONANT_SPOKEN_NAMES: Readonly<Record<string, readonly string[]>> = {
  b: ["bờ", "bơ", "bợ", "bê", "b"],
  c: ["cờ", "cơ", "cợ", "ca", "kờ", "xê", "c"],
  k: ["ca", "cờ", "cơ", "kờ", "kơ", "k"],
  d: ["dờ", "dơ", "giờ", "dê", "d"],
  đ: ["đờ", "đơ", "đợ", "đê", "đ"],
  g: ["gờ", "gơ", "ghờ", "giê", "g"],
  gh: ["gờ", "gơ", "ghờ", "gh", "g"],
  gi: ["di", "gi", "giờ", "giơ", "dờ", "dơ", "gờ", "gơ", "i"],
  h: ["hờ", "hơ", "hát", "h"],
  l: ["lờ", "lơ", "l"],
  m: ["mờ", "mơ", "mợ", "m"],
  n: ["nờ", "nơ", "n"],
  p: ["pờ", "pơ", "pê", "p"],
  ph: ["phờ", "phơ", "pờ", "pơ", "hờ", "hơ", "ph"],
  q: ["quờ", "quơ", "cu", "q"],
  qu: ["quờ", "quơ", "cu", "cờ", "cơ", "u", "qu"],
  r: ["rờ", "rơ", "r"],
  s: ["sờ", "sơ", "xờ", "xơ", "s"],
  t: ["tờ", "tơ", "tợ", "tở", "từ", "tê", "t"],
  th: ["thờ", "thơ", "tờ", "tơ", "hờ", "hơ", "th"],
  tr: ["trờ", "trơ", "chờ", "chơ", "tờ", "tơ", "rờ", "rơ", "tr"],
  v: ["vờ", "vơ", "vê", "v"],
  x: ["xờ", "xơ", "sờ", "sơ", "x"],
  ch: ["chờ", "chơ", "cờ", "cơ", "hờ", "hơ", "ch"],
  kh: ["khờ", "khơ", "ca", "cờ", "cơ", "hờ", "hơ", "kh"],
  ng: ["ngờ", "ngơ", "nghờ", "nờ", "nơ", "gờ", "gơ", "ng"],
  ngh: ["ngờ", "ngơ", "nghờ", "nờ", "nơ", "gờ", "gơ", "hờ", "hơ", "ngh"],
  nh: ["nhờ", "nhơ", "nờ", "nơ", "hờ", "hơ", "nh"],
};

/**
 * Spoken names STT may produce when a child utters isolated Vietnamese vowels
 * (including stray light tones or breathy `h-` onset added by browser ASR).
 */
const VOWEL_SPOKEN_NAMES: Readonly<Record<string, readonly string[]>> = {
  a: ["a", "á", "à", "ả", "ạ", "ha"],
  ă: ["ă", "á", "ắ", "ằ", "ha"],
  â: ["â", "ớ", "ơ", "ấ", "ầ"],
  e: ["e", "é", "è", "he"],
  ê: ["ê", "ế", "ề", "ể", "ệ", "hê"],
  i: ["i", "í", "ì", "y", "ý", "ỳ", "hi"],
  y: ["y", "i", "ý", "ỳ", "í", "ì"],
  o: ["o", "ó", "ò", "ho"],
  ô: ["ô", "ố", "ồ", "ổ", "ộ", "hô"],
  ơ: ["ơ", "ớ", "ờ", "ở", "ợ", "hơ"],
  u: ["u", "ú", "ù", "hu"],
  ư: ["ư", "ứ", "ừ", "hư"],
};

const TONE_WORDS: Readonly<Record<VietnameseTone, readonly string[]>> = {
  ngang: ["ngang"],
  sac: ["sắc", "sắt", "xắc", "dấu"],
  huyen: ["huyền", "hiền", "dấu"],
  hoi: ["hỏi", "dấu"],
  nga: ["ngã", "ngả", "dấu"],
  nang: ["nặng", "nặn", "dấu"],
};

/** Hesitation fillers children utter mid-spelling (valid only after a real cue). */
const HESITATION_FILLERS = new Set(["dấu", "à", "ờ", "ừm"]);

/**
 * Strip only the 5 Vietnamese tone marks while preserving vowel quality
 * (a/ă/â, e/ê, o/ô/ơ, u/ư) and đ.
 */
const TONE_CHAR_MAP: Readonly<
  Record<string, readonly [base: string, tone: VietnameseTone]>
> = {
  á: ["a", "sac"],
  à: ["a", "huyen"],
  ả: ["a", "hoi"],
  ã: ["a", "nga"],
  ạ: ["a", "nang"],
  ắ: ["ă", "sac"],
  ằ: ["ă", "huyen"],
  ẳ: ["ă", "hoi"],
  ẵ: ["ă", "nga"],
  ặ: ["ă", "nang"],
  ấ: ["â", "sac"],
  ầ: ["â", "huyen"],
  ẩ: ["â", "hoi"],
  ẫ: ["â", "nga"],
  ậ: ["â", "nang"],
  é: ["e", "sac"],
  è: ["e", "huyen"],
  ẻ: ["e", "hoi"],
  ẽ: ["e", "nga"],
  ẹ: ["e", "nang"],
  ế: ["ê", "sac"],
  ề: ["ê", "huyen"],
  ể: ["ê", "hoi"],
  ễ: ["ê", "nga"],
  ệ: ["ê", "nang"],
  í: ["i", "sac"],
  ì: ["i", "huyen"],
  ỉ: ["i", "hoi"],
  ĩ: ["i", "nga"],
  ị: ["i", "nang"],
  ó: ["o", "sac"],
  ò: ["o", "huyen"],
  ỏ: ["o", "hoi"],
  õ: ["o", "nga"],
  ọ: ["o", "nang"],
  ố: ["ô", "sac"],
  ồ: ["ô", "huyen"],
  ổ: ["ô", "hoi"],
  ỗ: ["ô", "nga"],
  ộ: ["ô", "nang"],
  ớ: ["ơ", "sac"],
  ờ: ["ơ", "huyen"],
  ở: ["ơ", "hoi"],
  ỡ: ["ơ", "nga"],
  ợ: ["ơ", "nang"],
  ú: ["u", "sac"],
  ù: ["u", "huyen"],
  ủ: ["u", "hoi"],
  ũ: ["u", "nga"],
  ụ: ["u", "nang"],
  ứ: ["ư", "sac"],
  ừ: ["ư", "huyen"],
  ử: ["ư", "hoi"],
  ữ: ["ư", "nga"],
  ự: ["ư", "nang"],
  ý: ["y", "sac"],
  ỳ: ["y", "huyen"],
  ỷ: ["y", "hoi"],
  ỹ: ["y", "nga"],
  ỵ: ["y", "nang"],
};

/** Maximum phonics cue tokens allowed before the blended target word. */
const MAX_PHONICS_CUES = 14;

export function decomposeVietnameseSyllable(
  word: string,
): VietnameseSyllableParts | null {
  const normalized = normalizeVietnameseWord(word);
  if (!normalized || /^\d+$/u.test(normalized)) return null;

  let tone: VietnameseTone = "ngang";
  let untoned = "";
  for (const ch of normalized) {
    const mapped = TONE_CHAR_MAP[ch];
    if (mapped) {
      untoned += mapped[0];
      tone = mapped[1];
    } else {
      untoned += ch;
    }
  }

  // Single-vowel "gi" words like "gì" / "gỉ" / "gị": onset "gi", rhyme "i"
  // (must be checked BEFORE single-char onset "g" matches "gi").
  let onset = "";
  let rhyme = untoned;
  if (untoned === "gi") {
    onset = "gi";
    rhyme = "i";
  } else {
    for (const candidate of ONSETS) {
      if (untoned.startsWith(candidate) && untoned.length > candidate.length) {
        onset = candidate;
        rhyme = untoned.slice(candidate.length);
        break;
      }
    }
  }

  return {
    normalized,
    onset,
    rhyme,
    untonedSyllable: untoned,
    tone,
  };
}

const SAC_VOWEL: Readonly<Record<string, string>> = {
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

const NANG_VOWEL: Readonly<Record<string, string>> = {
  a: "ạ",
  ă: "ặ",
  â: "ậ",
  e: "ẹ",
  ê: "ệ",
  i: "ị",
  o: "ọ",
  ô: "ộ",
  ơ: "ợ",
  u: "ụ",
  ư: "ự",
  y: "ỵ",
};

function applyToneToRhyme(rhyme: string, tone: "sac" | "nang"): string | null {
  const table = tone === "sac" ? SAC_VOWEL : NANG_VOWEL;
  const chars = [...rhyme];
  let idx = chars.findIndex((c) => "êơôăâ".includes(c));
  if (idx < 0) {
    for (let i = chars.length - 1; i >= 0; i -= 1) {
      if (chars[i] in table) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return null;
  chars[idx] = table[chars[idx]];
  return chars.join("");
}

/**
 * Build the set of legal single-token phonics cues (including controlled ASR
 * phonetic variants) a child may utter BEFORE blending `word`.
 */
export function buildPhonicsCueSet(word: string): ReadonlySet<string> {
  const parts = decomposeVietnameseSyllable(word);
  if (!parts) return new Set();

  const cues = new Set<string>();
  const add = (token: string) => {
    const clean = normalizeVietnameseWord(token);
    if (clean) cues.add(clean);
  };

  // 1. Onset spoken names + ASR variants
  if (parts.onset) {
    for (const name of CONSONANT_SPOKEN_NAMES[parts.onset] ?? [parts.onset]) {
      add(name);
    }
    if (parts.onset === "qu") {
      add("u");
      add(`u${parts.rhyme}`);
    }
    if (parts.onset === "gi") {
      add("i");
    }
  }

  // 2. Rhyme itself & its letter-by-letter decomposition
  const { rhyme } = parts;
  const { nucleus, coda } = splitVietnameseRhyme(rhyme);
  add(rhyme);
  // Also allow mildly toned rhyme variants ASR produces when a child pronounces
  // a rhyme in isolation (e.g. "ôi" -> "ối"/"ồi", "ơm" -> "ớm"/"ờm", "ang" -> "áng"/"àng")
  // and always include the word's own toned rhyme even for 1-vowel rhymes (e.g. "ự" for "tự").
  if (rhyme.length >= 2) {
    const sacRhyme = applyToneToRhyme(rhyme, "sac");
    const nangRhyme = applyToneToRhyme(rhyme, "nang");
    if (sacRhyme) add(sacRhyme);
    if (nangRhyme && parts.tone === "nang") add(nangRhyme);
  }
  if (parts.tone === "sac" || parts.tone === "nang") {
    const targetTonedRhyme = applyToneToRhyme(rhyme, parts.tone);
    if (targetTonedRhyme) add(targetTonedRhyme);
  }

  if (coda) {
    for (const name of CONSONANT_SPOKEN_NAMES[coda] ?? [coda]) {
      add(name);
    }
    if (["c", "ch", "p", "t"].includes(coda)) {
      const checkedRhyme = applyToneToRhyme(rhyme, "sac");
      if (checkedRhyme) add(checkedRhyme);
      const checkedSyllable = parts.onset
        ? `${parts.onset}${checkedRhyme ?? rhyme}`
        : (checkedRhyme ?? rhyme);
      add(checkedSyllable);
      if (parts.tone === "nang") {
        const heavyRhyme = applyToneToRhyme(rhyme, "nang");
        if (heavyRhyme) add(heavyRhyme);
      }
    }
  }

  if (nucleus) {
    add(nucleus);
    for (const ch of nucleus) {
      for (const name of VOWEL_SPOKEN_NAMES[ch] ?? [ch]) {
        add(name);
      }
    }
    if (nucleus.length >= 2) {
      add(nucleus.slice(0, 2));
      if (nucleus === "iê" || nucleus === "yê") {
        add("ia");
        add("iê");
        add("yê");
      } else if (nucleus === "ươ") {
        add("ưa");
        add("ươ");
      } else if (nucleus === "uô") {
        add("ua");
        add("uô");
      }
    }
  }

  // 3. Untoned combined syllable (e.g. "ca" for "cá", "meo" for "mèo", "nho" for "nhỏ")
  add(parts.untonedSyllable);
  if (parts.onset && nucleus.length >= 2) {
    add(`${parts.onset}${nucleus[0]}`);
  }

  // 4. Tone word matching this syllable's actual tone (never allow wrong tone words!)
  for (const toneWord of TONE_WORDS[parts.tone]) {
    add(toneWord);
  }

  return cues;
}

/**
 * Check whether `tokens` (starting at index 0) begins with a valid Grade-1
 * Vietnamese spelling-out sequence ending in the exact `targetWord`.
 *
 * Returns `null` if:
 *  - `tokens[0]` is already `targetWord` AND no spelling cues follow before
 *    another `targetWord` (caller handles normal 1-word match),
 *  - any cue token before `targetWord` is neither a legal phonics cue nor a
 *    mid-spelling hesitation filler,
 *  - or the final blended word does not match `targetWord` with exact diacritics.
 */
export function matchPhonicsSpelling(
  tokens: readonly string[],
  targetWord: string,
): PhonicsSpellingMatch | null {
  const target = normalizeVietnameseWord(targetWord);
  if (!target || tokens.length < 2) return null;

  const cues = buildPhonicsCueSet(target);
  if (!cues.size) return null;

  // If tokens[0] === target, only treat as phonics if at least one distinct
  // sub-syllable cue (token !== target) appears before a subsequent `target`
  // (e.g. "tê ê tê"), never consuming repeated book words ("tê tê tê").
  const startsWithTarget = normalizeVietnameseWord(tokens[0]) === target;
  if (startsWithTarget && !cues.has(target)) return null;

  const limit = Math.min(tokens.length, MAX_PHONICS_CUES + 1);
  let lastMatchIndex = -1;
  let realCueCount = 0;
  let distinctCueCount = 0;

  for (let i = 0; i < limit; i += 1) {
    const token = normalizeVietnameseWord(tokens[i]);
    if (!token) break;

    if (token === target && i >= 1 && realCueCount >= 1) {
      if (!startsWithTarget || distinctCueCount >= 1) {
        lastMatchIndex = i;
      }
      // Continue scanning in case the target appears before the tone word
      // or is repeated after blending (e.g. "nờ ước nước sắc nước").
      if (cues.has(token) && !startsWithTarget) {
        realCueCount += 1;
      }
      continue;
    }

    if (cues.has(token)) {
      if (token !== target) distinctCueCount += 1;
      if (!HESITATION_FILLERS.has(token)) {
        realCueCount += 1;
      } else if (realCueCount === 0) {
        // Never start a phonics sequence with a bare filler like "dấu" or "à"
        // unless that vowel itself belongs to the target's nucleus.
        const parts = decomposeVietnameseSyllable(target);
        const targetNucleus = parts
          ? splitVietnameseRhyme(parts.rhyme).nucleus
          : "";
        const isOwnVowel =
          (token === "à" &&
            (targetNucleus.includes("a") || targetNucleus.includes("ă"))) ||
          (token === "ờ" &&
            (targetNucleus.includes("ơ") || targetNucleus.includes("â")));
        if (!isOwnVowel) break;
        realCueCount += 1;
      }
      continue;
    }

    if (HESITATION_FILLERS.has(token) && realCueCount >= 1) {
      continue;
    }

    break;
  }

  if (lastMatchIndex >= 1 && (!startsWithTarget || lastMatchIndex >= 2)) {
    return {
      matched: true,
      consumedCount: lastMatchIndex + 1,
      cueCount: lastMatchIndex,
    };
  }
  return null;
}

/**
 * True when `tokens` consists purely of legal phonics cues for `targetWord`
 * (the child is partway through spelling out the syllable and hasn't blended
 * the final word yet — e.g. "ê", "ê tờ", "ê tờ ê" before "tê", or "ô i ôi"
 * before "tờ ôi tôi").
 */
export function isPhonicsInProgress(
  tokens: readonly string[],
  targetWord: string,
): boolean {
  const parts = decomposeVietnameseSyllable(targetWord);
  if (!parts || tokens.length === 0 || tokens.length > MAX_PHONICS_CUES) {
    return false;
  }
  const target = parts.normalized;
  const { nucleus } = splitVietnameseRhyme(parts.rhyme);
  const cues = buildPhonicsCueSet(target);
  if (!cues.size) return false;

  // Guard single-token utterances so genuine tone errors on the full word
  // (e.g. "ma" for "má", "từ" for "tư", "ờ" for "ở") are immediately treated
  // as reading attempts rather than "spelling in progress".
  if (tokens.length === 1) {
    const single = normalizeVietnameseWord(tokens[0]);
    if (!single || single === target) return false;
    if (HESITATION_FILLERS.has(single)) {
      const isOwnVowel =
        (single === "à" && (nucleus.includes("a") || nucleus.includes("ă"))) ||
        (single === "ờ" && (nucleus.includes("ơ") || nucleus.includes("â")));
      if (!isOwnVowel) return false;
    }
    if (parts.onset) {
      if (single === parts.untonedSyllable) return false;
      const singleParts = decomposeVietnameseSyllable(single);
      if (
        singleParts &&
        singleParts.untonedSyllable === parts.untonedSyllable &&
        parts.rhyme !== "ơ"
      ) {
        return false;
      }
    } else if (parts.rhyme.length === 1 && single !== parts.untonedSyllable) {
      return false;
    }
  }

  let realCueCount = 0;
  for (const raw of tokens) {
    const token = normalizeVietnameseWord(raw);
    if (!token) return false;
    if (cues.has(token)) {
      if (!HESITATION_FILLERS.has(token)) {
        realCueCount += 1;
      } else {
        const isOwnVowel =
          (token === "à" && (nucleus.includes("a") || nucleus.includes("ă"))) ||
          (token === "ờ" && (nucleus.includes("ơ") || nucleus.includes("â")));
        if (isOwnVowel) {
          realCueCount += 1;
        } else if (realCueCount === 0) {
          return false;
        }
      }
      continue;
    }
    if (HESITATION_FILLERS.has(token) && realCueCount >= 1) {
      continue;
    }
    return false;
  }
  return realCueCount >= 1;
}

/**
 * Check whether a browser transcript chunk (possibly combined with existing
 * buffered phonics cues) is a valid phonics cue or complete spelling for
 * `targetWord`. Used to safely relax browser STT confidence (`>= 0.28`) ONLY
 * for genuine Grade-1 spelling cues without weakening general noise rejection.
 */
export function isLikelyPhonicsCueForWord(
  text: string,
  targetWord: string,
  bufferedTokens: readonly string[] = [],
): boolean {
  const tokens = tokenizeVietnameseText(text);
  if (!tokens.length) return false;
  const combined = [...bufferedTokens, ...tokens];
  const match = matchPhonicsSpelling(combined, targetWord);
  if (match) return true;
  return isPhonicsInProgress(combined, targetWord);
}

/**
 * Generate a warm, step-by-step Grade-1 Vietnamese textbook (SGK GDPT 2018)
 * spoken phonics guide for `word` so the teacher voice can model how to spell
 * and blend any Vietnamese word when a child struggles (G28).
 *
 * Examples:
 *  - "tê"   -> "Mình đánh vần chậm cùng cô nhé: tờ... ê... tê! Đọc trơn là: tê. Giờ con đọc thử cùng cô nào!"
 *  - "cá"   -> "Con nghe cô đánh vần nhé: cờ... a... ca... sắc... cá! Đọc trơn là: cá. Đến lượt con giỏi lắm nào!"
 *  - "tôi"  -> "Mình ghép vần cùng cô nha: ô... i... ôi, tờ... ôi... tôi! Đọc trơn là: tôi. Con thử đọc lại chữ “tôi” nhé!"
 */
const UNIVERSAL_PHONICS_CUE_TOKENS: ReadonlySet<string> = (() => {
  const set = new Set<string>([
    "sắc",
    "sắt",
    "xắc",
    "huyền",
    "hiền",
    "hỏi",
    "ngã",
    "ngả",
    "nặng",
    "nặn",
    "dấu",
  ]);
  for (const names of Object.values(CONSONANT_SPOKEN_NAMES)) {
    for (const n of names) set.add(normalizeVietnameseWord(n));
  }
  for (const names of Object.values(VOWEL_SPOKEN_NAMES)) {
    for (const n of names) set.add(normalizeVietnameseWord(n));
  }
  return set;
})();

/**
 * True if a token is a recognizable Vietnamese spelling cue (consonant spoken name,
 * single vowel letter, or tone name like "mờ", "trờ", "ô", "i", "nặng", "huyền").
 */
export function isLikelyPhonicsCueToken(token: string): boolean {
  const norm = normalizeVietnameseWord(token);
  if (!norm) return false;
  return UNIVERSAL_PHONICS_CUE_TOKENS.has(norm);
}

/**
 * True if `token` belongs to the phonics cue set of any upcoming target word
 * in a multi-word cluster (e.g., spelling 2–4 words like "môi trường tự nhiên"
 * in sequence before reading the full phrase smoothly).
 */
export function isPhonicsCueForWindow(
  token: string,
  windowTargets: readonly string[],
): boolean {
  const norm = normalizeVietnameseWord(token);
  if (!norm) return false;
  for (const target of windowTargets) {
    const cues = buildPhonicsCueSet(target);
    if (cues && cues.has(norm)) return true;
  }
  return false;
}

export function generateSpokenPhonicsGuide(
  word: string,
  gender: VoiceGender = "female",
): string {
  return adaptTextToTeacherPersona(
    generateFemaleSpokenPhonicsGuide(word),
    gender,
  );
}

function generateFemaleSpokenPhonicsGuide(word: string): string {
  const parts = decomposeVietnameseSyllable(word);
  const displayWord = normalizeVietnameseWord(word) || word.trim();
  if (!parts) {
    return `Con nghe cô đọc chậm chữ “${displayWord}” rồi đọc cùng cô nhé!`;
  }

  const { normalized, onset, rhyme, untonedSyllable, tone } = parts;
  const { nucleus, coda } = splitVietnameseRhyme(rhyme);
  const onsetSpoken = onset ? (CANONICAL_ONSET_SPOKEN[onset] ?? onset) : "";
  const codaSpoken = coda ? (CANONICAL_CODA_SPOKEN[coda] ?? coda) : "";
  const toneSpoken = CANONICAL_TONE_SPOKEN[tone];
  const isCheckedCoda = ["c", "ch", "p", "t"].includes(coda);
  const spokenRhyme = isCheckedCoda
    ? (applyToneToRhyme(rhyme, "sac") ?? rhyme)
    : rhyme;
  const preToneSyllable = isCheckedCoda
    ? `${onset}${spokenRhyme}`
    : untonedSyllable;

  // Case 1: Compound rhyme (2+ letters, e.g. "tôi", "đang", "cơm", "nước", "ăn")
  if (rhyme.length >= 2) {
    const rhymeLetters = [...nucleus];
    if (codaSpoken) rhymeLetters.push(codaSpoken);
    const rhymeStep = `${rhymeLetters.join("... ")}... ${spokenRhyme}`;

    if (!onset) {
      const blendTail =
        tone !== "ngang" && !(isCheckedCoda && tone === "sac")
          ? `... ${toneSpoken}... ${normalized}`
          : "";
      return `Mình đánh vần chậm cùng cô nhé: ${rhymeStep}${blendTail}! Đọc trơn là: ${normalized}. Giờ con đọc thử cùng cô nào!`;
    }

    const blendParts = [onsetSpoken, spokenRhyme, preToneSyllable];
    if (tone !== "ngang") {
      blendParts.push(toneSpoken, normalized);
    }
    return `Mình ghép vần cùng cô nha: ${rhymeStep}, ${blendParts.join("... ")}! Đọc trơn là: ${normalized}. Con thử đọc lại chữ “${normalized}” nhé!`;
  }

  // Case 2: Simple 1-vowel rhyme with onset (e.g. "tê", "cá", "nhỏ", "mẹ")
  if (onset) {
    if (tone === "ngang") {
      return `Mình đánh vần chậm cùng cô nhé: ${onsetSpoken}... ${spokenRhyme}... ${normalized}! Đọc trơn là: ${normalized}. Giờ con đọc thử cùng cô nào!`;
    }
    return `Con nghe cô đánh vần nhé: ${onsetSpoken}... ${spokenRhyme}... ${untonedSyllable}... ${toneSpoken}... ${normalized}! Đọc trơn là: ${normalized}. Đến lượt con giỏi lắm nào!`;
  }

  // Case 3: Single-vowel syllable without onset (e.g. "ở", "ý", "ô")
  if (tone !== "ngang") {
    return `Mình đánh vần chậm cùng cô nhé: ${untonedSyllable}... ${toneSpoken}... ${normalized}! Đọc trơn là: ${normalized}. Giờ con đọc thử cùng cô nào!`;
  }
  return `Mình đọc chậm cùng cô nhé: ${normalized}! Giờ con đọc thử cùng cô nào!`;
}
