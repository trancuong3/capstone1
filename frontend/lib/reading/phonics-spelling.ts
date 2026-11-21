/**
 * Vietnamese Grade-1 phonics (đánh vần) matcher.
 *
 * First-grade Vietnamese readers routinely sound out a syllable before saying
 * the full word — e.g. for "tôi":
 *   - "ô i ôi tờ ôi tôi"
 *   - "tờ ôi tôi"
 *   - "tờ ô i tôi"
 * Or for "cá": "cờ a ca sắc cá"; for "mèo": "mờ eo meo huyền mèo";
 * for "nhỏ": "nhờ o nho hỏi nhỏ"; for "nước": "ư ơ cờ ước nờ ước nước sắc nước".
 *
 * This module decomposes any normalized Vietnamese syllable into its legal
 * Grade-1 phonics cues (onset name, rhyme letters, rhyme, untoned syllable,
 * and tone word) so the alignment engine can:
 *  1. Avoid penalising or interrupting a child who is actively spelling out the
 *     current book word.
 *  2. Accept the word once the child blends and pronounces the exact target
 *     syllable (with full Vietnamese diacritics preserved).
 *  3. Reject unrelated chatter, TV speech, or wrong-tone endings (0 false positives).
 */

import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";

export type VietnameseTone = "ngang" | "sac" | "huyen" | "hoi" | "nga" | "nang";

export interface VietnameseSyllableParts {
  readonly normalized: string;
  readonly onset: string;
  readonly rhyme: string;
  readonly untonedSyllable: string;
  readonly tone: VietnameseTone;
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

/** Standard Grade-1 spoken names for onsets and codas (âm đầu / âm cuối). */
const CONSONANT_SPOKEN_NAMES: Readonly<Record<string, readonly string[]>> = {
  b: ["bờ", "bê", "b"],
  c: ["cờ", "xê", "c"],
  k: ["ca", "cờ", "k"],
  d: ["dờ", "dê", "d"],
  đ: ["đờ", "đê", "đ"],
  g: ["gờ", "giê", "g"],
  gh: ["gờ", "gh", "gờ kép"],
  gi: ["di", "gi", "giờ", "dờ", "gờ", "i"],
  h: ["hờ", "hát", "h"],
  l: ["lờ", "l"],
  m: ["mờ", "m"],
  n: ["nờ", "n"],
  p: ["pờ", "pê", "p"],
  q: ["quờ", "cu", "q"],
  qu: ["quờ", "cu", "cờ", "u", "qu"],
  r: ["rờ", "r"],
  s: ["sờ", "s"],
  t: ["tờ", "tê", "t"],
  v: ["vờ", "vê", "v"],
  x: ["xờ", "x"],
  ch: ["chờ", "cờ", "hờ", "ch"],
  kh: ["khờ", "ca", "cờ", "hờ", "kh"],
  ng: ["ngờ", "nờ", "gờ", "ng"],
  ngh: ["ngờ", "nờ", "gờ", "hờ", "ngh"],
  nh: ["nhờ", "nờ", "hờ", "nh"],
  ph: ["phờ", "pờ", "hờ", "ph"],
  th: ["thờ", "tờ", "hờ", "th"],
  tr: ["trờ", "tờ", "rờ", "tr"],
};

/** Spoken names STT may produce when a child names single Vietnamese vowels. */
const VOWEL_SPOKEN_NAMES: Readonly<Record<string, readonly string[]>> = {
  a: ["a"],
  ă: ["ă", "á"],
  â: ["â", "ớ", "ơ"],
  e: ["e"],
  ê: ["ê"],
  i: ["i", "y"],
  y: ["y", "i"],
  o: ["o"],
  ô: ["ô"],
  ơ: ["ơ"],
  u: ["u"],
  ư: ["ư"],
};

const TONE_WORDS: Readonly<Record<VietnameseTone, readonly string[]>> = {
  ngang: [],
  sac: ["sắc", "dấu"],
  huyen: ["huyền", "dấu"],
  hoi: ["hỏi", "dấu"],
  nga: ["ngã", "dấu"],
  nang: ["nặng", "dấu"],
};

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

const CODAS = ["ch", "ng", "nh", "c", "m", "n", "p", "t"] as const;

/** Maximum phonics cue tokens allowed before the blended target word. */
const MAX_PHONICS_CUES = 10;

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

  let onset = "";
  let rhyme = untoned;
  for (const candidate of ONSETS) {
    if (untoned.startsWith(candidate) && untoned.length > candidate.length) {
      // Special case: "gi" before a consonant or empty (e.g. "gì" -> untoned "gi")
      // keeps "i" in the rhyme; "gió" -> onset "gi", rhyme "o".
      onset = candidate;
      rhyme = untoned.slice(candidate.length);
      break;
    }
  }
  // Single-vowel "gi" words like "gì" / "gỉ" / "gị": onset "gi", rhyme "i".
  if (!onset && untoned === "gi") {
    onset = "gi";
    rhyme = "i";
  }

  return {
    normalized,
    onset,
    rhyme,
    untonedSyllable: untoned,
    tone,
  };
}

/**
 * Build the set of legal single-token phonics cues a child may utter while
 * sounding out `word` (never including unrelated words).
 */
export function buildPhonicsCueSet(word: string): ReadonlySet<string> {
  const parts = decomposeVietnameseSyllable(word);
  if (!parts) return new Set();

  const cues = new Set<string>();
  const add = (token: string) => {
    const clean = normalizeVietnameseWord(token);
    if (clean) cues.add(clean);
  };

  // 1. Onset spoken names
  if (parts.onset) {
    for (const name of CONSONANT_SPOKEN_NAMES[parts.onset] ?? [parts.onset]) {
      add(name);
    }
    // For "qu", children often spell with "u" included in the rhyme (e.g. "u a ua", "quờ a qua")
    if (parts.onset === "qu") {
      add("u");
      add(`u${parts.rhyme}`);
    }
    // For "gi", children may spell "gi i gi" or "dờ ..."
    if (parts.onset === "gi") {
      add("i");
    }
  }

  // 2. Rhyme itself & its letter-by-letter decomposition
  const rhyme = parts.rhyme;
  add(rhyme);

  // Check if rhyme ends with a consonant coda (c, ch, m, n, ng, nh, p, t)
  let nucleus = rhyme;
  let coda = "";
  for (const candidate of CODAS) {
    if (rhyme.length > candidate.length && rhyme.endsWith(candidate)) {
      coda = candidate;
      nucleus = rhyme.slice(0, -candidate.length);
      break;
    }
  }

  if (coda) {
    for (const name of CONSONANT_SPOKEN_NAMES[coda] ?? [coda]) {
      add(name);
    }
    // Checked rhymes ending in c/ch/p/t are pronounced with sắc tone when isolated
    // (e.g. "ư ơ cờ ước" for "nước", "a tờ át" for "hát", "ă cờ ắc" for "bắc").
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

  // Add nucleus and each vowel letter in the nucleus
  if (nucleus) {
    add(nucleus);
    for (const ch of nucleus) {
      for (const name of VOWEL_SPOKEN_NAMES[ch] ?? [ch]) {
        add(name);
      }
    }
    // Two-vowel glide/diphthong prefixes (e.g. "iê" in "iêng", "ươ" in "ươc", "uô" in "uông")
    if (nucleus.length >= 2) {
      add(nucleus.slice(0, 2));
      // STT sometimes writes "iê" as "ia" / "yê" or "ươ" as "ưa" or "uô" as "ua"
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
  // Common STT shortening where a child says "mờ e me huyền mèo" (first vowel of diphthong)
  if (parts.onset && nucleus.length >= 2) {
    add(`${parts.onset}${nucleus[0]}`);
  }

  // 4. Tone word matching this syllable's actual tone (never allow wrong tone words!)
  for (const toneWord of TONE_WORDS[parts.tone]) {
    add(toneWord);
  }

  return cues;
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
  // Place tone on main vowel: priority ê/ơ/ô/ă/â, else last vowel before coda
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
 * Check whether `tokens` (starting at index 0) begins with a valid Grade-1
 * Vietnamese spelling-out sequence ending in the exact `targetWord`.
 *
 * Returns `null` if:
 *  - `tokens[0]` is already `targetWord` (caller should handle normal match),
 *  - any cue token before `targetWord` is not a legal phonics cue for `targetWord`,
 *  - or `targetWord` does not appear within `MAX_PHONICS_CUES` cue tokens.
 */
export function matchPhonicsSpelling(
  tokens: readonly string[],
  targetWord: string,
): PhonicsSpellingMatch | null {
  const target = normalizeVietnameseWord(targetWord);
  if (!target || tokens.length < 2) return null;
  if (normalizeVietnameseWord(tokens[0]) === target) return null;

  const cues = buildPhonicsCueSet(target);
  if (!cues.size) return null;

  const limit = Math.min(tokens.length, MAX_PHONICS_CUES + 1);
  let lastMatchIndex = -1;
  for (let i = 0; i < limit; i += 1) {
    const token = normalizeVietnameseWord(tokens[i]);
    if (!token) break;
    if (token === target && i >= 1) {
      lastMatchIndex = i;
      // Continue scanning in case the target appears before the tone word
      // (e.g. "nờ ước nước sắc nước" or "ngờ a nga ngã ngã").
      continue;
    }
    if (!cues.has(token)) {
      break;
    }
  }
  if (lastMatchIndex >= 1) {
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
 * the final word yet — e.g. "ô i ôi" before pausing and saying "tờ ôi tôi").
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
  const cues = buildPhonicsCueSet(target);
  if (!cues.size) return false;

  // A single standalone word that equals the target or just drops its tone
  // (e.g. reading "ma" instead of "má") is a reading attempt, NOT spelling out.
  if (tokens.length === 1) {
    const single = normalizeVietnameseWord(tokens[0]);
    if (single === target) return false;
    if (parts.onset && single === parts.untonedSyllable) return false;
  }

  let hasMeaningfulCue = false;
  for (const raw of tokens) {
    const token = normalizeVietnameseWord(raw);
    if (!token || !cues.has(token)) return false;
    if (token !== "dấu") hasMeaningfulCue = true;
  }
  return hasMeaningfulCue;
}
