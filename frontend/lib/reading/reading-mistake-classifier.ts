/**
 * Pedagogical Vietnamese Grade-1 reading mistake classifier (G27).
 *
 * Classifies a child's misread syllable against the expected book syllable so
 * the empathetic teacher voice can comfort and guide the child accurately:
 *  - "TONE" (Group A): right letters/sound, wrong tone mark (e.g. "má" <- "ma", "mèo" <- "méo")
 *  - "NEAR_SOUND" (Group B): confusable Vietnamese onset or rhyme pair (d/đ, s/x, ch/tr, l/n,
 *    c/k/qu, iê/ươ/uô, an/ang, ăt/ăc, etc.)
 *  - "GENERAL" (Group C): unrelated word substitution or general hesitation
 */

import {
  decomposeVietnameseSyllable,
  splitVietnameseRhyme,
} from "@/lib/reading/phonics-spelling";

export type ReadingMistakeCategory = "TONE" | "NEAR_SOUND" | "GENERAL";

const CONFUSABLE_ONSET_GROUPS: readonly (readonly string[])[] = [
  ["d", "đ", "gi", "r", "v"],
  ["s", "x"],
  ["ch", "tr"],
  ["l", "n"],
  ["c", "k", "q", "qu", "kh"],
  ["g", "gh", "ng", "ngh"],
  ["t", "th"],
  ["b", "p", "ph"],
  ["m", "n", "nh"],
];

const CONFUSABLE_NUCLEUS_GROUPS: readonly (readonly string[])[] = [
  ["a", "ă", "â"],
  ["e", "ê"],
  ["o", "ô", "ơ"],
  ["u", "ư"],
  ["i", "y"],
  ["iê", "yê", "ươ", "uô", "ia", "ưa", "ua"],
  ["ai", "ay", "ây"],
  ["ao", "au", "âu"],
  ["eo", "êu", "êu"],
  ["oi", "ôi", "ơi"],
  ["ui", "ưi"],
  ["iu", "ưu"],
  ["oa", "oe", "uê", "uy"],
  ["oai", "oay", "uây"],
];

const CONFUSABLE_CODA_GROUPS: readonly (readonly string[])[] = [
  ["n", "ng", "nh", "m"],
  ["t", "c", "ch", "p"],
];

function canonicalOrthographicOnset(onset: string): string {
  if (onset === "k") return "c";
  if (onset === "gh") return "g";
  if (onset === "ngh") return "ng";
  return onset;
}

function inSameGroup(
  left: string,
  right: string,
  groups: readonly (readonly string[])[],
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return groups.some((group) => group.includes(left) && group.includes(right));
}

function isOneCharEditDistance(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diffs = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        diffs += 1;
        if (diffs > 1) return false;
      }
    }
    return diffs === 1;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let si = 0;
  let li = 0;
  let skipped = false;
  while (si < shorter.length && li < longer.length) {
    if (shorter[si] === longer[li]) {
      si += 1;
      li += 1;
    } else if (!skipped) {
      skipped = true;
      li += 1;
    } else {
      return false;
    }
  }
  return true;
}

export function classifyReadingMistake(
  expectedWord: string,
  spokenWord: string | null | undefined,
): ReadingMistakeCategory {
  if (!spokenWord) return "GENERAL";
  const expected = decomposeVietnameseSyllable(expectedWord);
  const spoken = decomposeVietnameseSyllable(spokenWord);
  if (!expected || !spoken) return "GENERAL";
  if (expected.normalized === spoken.normalized) return "GENERAL";

  const expectedRhyme = splitVietnameseRhyme(expected.rhyme);
  const spokenRhyme = splitVietnameseRhyme(spoken.rhyme);
  const expectedCanonOnset = canonicalOrthographicOnset(expected.onset);
  const spokenCanonOnset = canonicalOrthographicOnset(spoken.onset);
  const expectedCanonNucleus =
    expectedRhyme.nucleus === "y" ? "i" : expectedRhyme.nucleus;
  const spokenCanonNucleus =
    spokenRhyme.nucleus === "y" ? "i" : spokenRhyme.nucleus;

  // Group A: Identical base letters (onset + nucleus + coda), differing only in tone
  if (
    expectedCanonOnset === spokenCanonOnset &&
    expectedCanonNucleus === spokenCanonNucleus &&
    expectedRhyme.coda === spokenRhyme.coda &&
    expected.tone !== spoken.tone
  ) {
    return "TONE";
  }

  // Group B: Near-sound onset or rhyme confusion
  const sameOrCloseRhyme =
    expected.rhyme === spoken.rhyme ||
    (expectedCanonNucleus === spokenCanonNucleus &&
      inSameGroup(
        expectedRhyme.coda,
        spokenRhyme.coda,
        CONFUSABLE_CODA_GROUPS,
      )) ||
    (expectedRhyme.coda === spokenRhyme.coda &&
      inSameGroup(
        expectedCanonNucleus,
        spokenCanonNucleus,
        CONFUSABLE_NUCLEUS_GROUPS,
      ));

  const sameOrCloseOnset =
    expectedCanonOnset === spokenCanonOnset ||
    inSameGroup(expected.onset, spoken.onset, CONFUSABLE_ONSET_GROUPS);

  if (
    expected.onset !== spoken.onset &&
    inSameGroup(expected.onset, spoken.onset, CONFUSABLE_ONSET_GROUPS) &&
    sameOrCloseRhyme
  ) {
    return "NEAR_SOUND";
  }

  if (sameOrCloseOnset && sameOrCloseRhyme) {
    return "NEAR_SOUND";
  }

  // Dropped/added final consonant or close 1-letter slip on >= 2-letter syllable
  if (
    expected.untonedSyllable.length >= 2 &&
    spoken.untonedSyllable.length >= 2 &&
    expectedCanonOnset === spokenCanonOnset &&
    isOneCharEditDistance(expected.untonedSyllable, spoken.untonedSyllable)
  ) {
    return "NEAR_SOUND";
  }

  return "GENERAL";
}
