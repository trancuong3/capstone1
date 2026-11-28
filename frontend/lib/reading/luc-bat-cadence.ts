/**
 * Pure Vietnamese Lục Bát (6–8) Poetry Cadence & 6th-Syllable Rhyme Detector (#6).
 * Detects 6-8 couplets, 2/2/2 & 2/2/2/2 beat caesuras, and vần lưng (6th syllable of 6-line
 * rhyming in bằng tone with 6th syllable of 8-line).
 */

import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

export type LucBatWordRole = "rhyme6_luc" | "rhyme6_bat" | "rhyme8_bat";

export interface LucBatWordAnnotation {
  readonly role?: LucBatWordRole;
  readonly caesuraAfter: boolean;
  readonly coupletIndex: number;
}

export interface LucBatCoupletSummary {
  readonly coupletIndex: number;
  readonly lucLineIndex: number;
  readonly batLineIndex: number;
  readonly lucText: string;
  readonly batText: string;
  readonly lucSixthWord: string;
  readonly batSixthWord: string;
  readonly batEighthWord: string;
  readonly rhymeMatched: boolean;
}

export interface LucBatPageGuide {
  readonly isLucBat: boolean;
  readonly couplets: readonly LucBatCoupletSummary[];
  readonly wordAnnotations: ReadonlyMap<string, LucBatWordAnnotation>;
}

const TRAC_COMBINING_MARKS = new Set([
  "\u0301", // sắc
  "\u0309", // hỏi
  "\u0303", // ngã
  "\u0323", // nặng
]);

const INITIAL_CONSONANT_RE =
  /^(ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|[bcdđghklmnpqrstvx])/i;

function cleanVietnameseToken(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

export function isBangTone(word: string): boolean {
  const cleaned = cleanVietnameseToken(word);
  if (!cleaned) return false;
  const nfd = cleaned.normalize("NFD");
  for (const ch of nfd) {
    if (TRAC_COMBINING_MARKS.has(ch)) {
      return false;
    }
  }
  return true;
}

export function extractVietnameseRhymeKey(word: string): string {
  const cleaned = cleanVietnameseToken(word).toLocaleLowerCase("vi");
  if (!cleaned) return "";
  // Strip tone marks while preserving vowel quality diacritics (ă, â, ê, ô, ơ, ư)
  const toneless = cleaned
    .normalize("NFD")
    .replace(/[\u0300\u0301\u0303\u0309\u0323]/g, "")
    .normalize("NFC");

  let body = toneless.replace(INITIAL_CONSONANT_RE, "");
  if (!body && toneless.startsWith("gi")) {
    body = "i";
  }
  if (!body && toneless.startsWith("qu")) {
    body = toneless.slice(1);
  }
  // Normalize y/i rhyme equivalence (e.g. "kỳ" ~ "đi")
  if (body === "y") body = "i";
  return body;
}

export function doVietnameseSyllablesRhyme(a: string, b: string): boolean {
  const keyA = extractVietnameseRhymeKey(a);
  const keyB = extractVietnameseRhymeKey(b);
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  // Near-rhyme allowance common in folk ca dao (e.g., an/ang, ơn/ương tail match >= 2 chars)
  if (
    keyA.length >= 2 &&
    keyB.length >= 2 &&
    keyA.slice(-2) === keyB.slice(-2)
  ) {
    return true;
  }
  return false;
}

export function analyzeLucBatPage(page: ReadingPageDTO): LucBatPageGuide {
  const empty: LucBatPageGuide = {
    isLucBat: false,
    couplets: [],
    wordAnnotations: new Map(),
  };

  if (!page.words || page.words.length < 14) {
    return empty;
  }

  const byLine = new Map<number, ReadingPageWordDTO[]>();
  for (const word of page.words) {
    const cleaned = cleanVietnameseToken(word.text);
    if (!cleaned) continue;
    const lineIdx = Math.max(0, word.line_index ?? 0);
    const list = byLine.get(lineIdx);
    if (list) list.push(word);
    else byLine.set(lineIdx, [word]);
  }

  const sortedLines = Array.from(byLine.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([lineIndex, words]) => ({
      lineIndex,
      words: [...words].sort((a, b) => a.word_index - b.word_index),
    }))
    .filter((line) => line.words.length > 0);

  if (sortedLines.length < 2) {
    return empty;
  }

  const couplets: LucBatCoupletSummary[] = [];
  const annotations = new Map<string, LucBatWordAnnotation>();

  let idx = 0;
  while (idx < sortedLines.length - 1) {
    const lineA = sortedLines[idx];
    const lineB = sortedLines[idx + 1];
    if (lineA.words.length === 6 && lineB.words.length === 8) {
      const luc6 = lineA.words[5];
      const bat6 = lineB.words[5];
      const bat8 = lineB.words[7];
      const bangOk =
        isBangTone(luc6.text) && isBangTone(bat6.text) && isBangTone(bat8.text);
      const rhymeMatched =
        bangOk && doVietnameseSyllablesRhyme(luc6.text, bat6.text);

      if (bangOk) {
        const coupletIndex = couplets.length;
        couplets.push({
          coupletIndex,
          lucLineIndex: lineA.lineIndex,
          batLineIndex: lineB.lineIndex,
          lucText: lineA.words.map((w) => w.text).join(" "),
          batText: lineB.words.map((w) => w.text).join(" "),
          lucSixthWord: cleanVietnameseToken(luc6.text),
          batSixthWord: cleanVietnameseToken(bat6.text),
          batEighthWord: cleanVietnameseToken(bat8.text),
          rhymeMatched,
        });

        // 2 / 2 / 2 caesura on 6-syllable line
        lineA.words.forEach((w, pos) => {
          annotations.set(w.word_id, {
            role: pos === 5 ? "rhyme6_luc" : undefined,
            caesuraAfter: pos === 1 || pos === 3,
            coupletIndex,
          });
        });
        // 2 / 2 / 2 / 2 caesura on 8-syllable line
        lineB.words.forEach((w, pos) => {
          annotations.set(w.word_id, {
            role:
              pos === 5 ? "rhyme6_bat" : pos === 7 ? "rhyme8_bat" : undefined,
            caesuraAfter: pos === 1 || pos === 3 || pos === 5,
            coupletIndex,
          });
        });

        idx += 2;
        continue;
      }
    }
    idx += 1;
  }

  if (couplets.length === 0) {
    return empty;
  }

  const meterLinesCount = couplets.length * 2;
  const isPoemKind = page.page_kind === "POEM";
  const ratio = meterLinesCount / sortedLines.length;
  if (!isPoemKind && ratio < 0.5) {
    return empty;
  }

  return {
    isLucBat: true,
    couplets,
    wordAnnotations: annotations,
  };
}
