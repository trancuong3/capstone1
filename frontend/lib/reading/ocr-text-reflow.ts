/**
 * Universal presentation-only OCR text reflow for Vietnamese children's books.
 *
 * Strictly presentation-only invariants:
 *  - NEVER alters `word.word_id`, `word.word_index`, `word.text`, `word.bbox`,
 *    or Vietnamese diacritics.
 *  - Reflows prose lines cut mid-sentence by OCR into natural readable paragraphs.
 *  - Preserves poetry verse line breaks, dialogue speaker dashes, and titles.
 *  - Falls back to source line breaks on ambiguous / multi-column OCR geometry
 *    so column reading order is never scrambled.
 */

import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

export type PageReflowMode = "prose" | "poetry" | "source-preserved";

export interface WordLayoutEntry {
  readonly word: ReadingPageWordDTO;
  readonly index: number;
  readonly lineIndex: number;
  readonly breakCount: number;
  readonly isIndented: boolean;
  readonly isHeadingLine: boolean;
}

export interface PageReflowResult {
  readonly mode: PageReflowMode;
  readonly entries: WordLayoutEntry[];
}

interface OcrLineGroup {
  readonly lineIndex: number;
  readonly startWordIdx: number;
  readonly endWordIdx: number; // inclusive
  readonly words: readonly ReadingPageWordDTO[];
  readonly wordCount: number;
  readonly text: string;
  readonly hasValidBbox: boolean;
  readonly xMin: number;
  readonly xMax: number;
  readonly yTop: number;
  readonly yBottom: number;
  readonly height: number;
  readonly explicitNewlinesBefore: number;
}

const DIALOGUE_START_RE = /^[-–—•“"]/u;
const SENTENCE_END_RE = /[.!?…]["”’')\]]*$/u;
const LOWERCASE_START_RE = /^\p{Ll}/u;
const UPPERCASE_LETTER_RE = /\p{Lu}/u;

function hasUsableBbox(word: ReadingPageWordDTO): boolean {
  return (
    Array.isArray(word.bbox) &&
    word.bbox.length >= 4 &&
    Number.isFinite(word.bbox[0]) &&
    Number.isFinite(word.bbox[1]) &&
    Number.isFinite(word.bbox[2]) &&
    Number.isFinite(word.bbox[3]) &&
    word.bbox[2] > 0 &&
    word.bbox[3] > 0
  );
}

function isAllCapsLine(text: string): boolean {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 2) return false;
  return letters.every((ch) => ch === ch.toUpperCase());
}

function buildLineGroups(page: ReadingPageDTO): OcrLineGroup[] {
  const words = page.words;
  if (!words.length) return [];

  const textTokens = [...(page.text ?? "").matchAll(/\S+/gu)];
  const textMatchesWords =
    textTokens.length === words.length &&
    textTokens.every(
      (match, idx) =>
        match[0].normalize("NFC") === words[idx].text.normalize("NFC"),
    );

  const explicitNewlinesBeforeWord: number[] = words.map((_, idx) => {
    if (!textMatchesWords || idx === 0) return 0;
    const gap = page.text!.slice(
      textTokens[idx - 1].index! + textTokens[idx - 1][0].length,
      textTokens[idx].index,
    );
    return Math.min(2, (gap.match(/\n/gu) ?? []).length);
  });

  const groups: OcrLineGroup[] = [];
  let start = 0;

  while (start < words.length) {
    const firstWord = words[start];
    const lineIdx = firstWord.line_index ?? groups.length;
    let end = start;
    while (end + 1 < words.length) {
      const nextWord = words[end + 1];
      const nextLineIdx = nextWord.line_index;
      const lineChanged =
        nextLineIdx !== undefined && firstWord.line_index !== undefined
          ? nextLineIdx !== firstWord.line_index
          : explicitNewlinesBeforeWord[end + 1] > 0;
      if (lineChanged) break;
      end += 1;
    }

    const slice = words.slice(start, end + 1);
    const validBboxes = slice.filter(hasUsableBbox);
    const hasValid = validBboxes.length > 0;
    const xMin = hasValid ? Math.min(...validBboxes.map((w) => w.bbox[0])) : 0;
    const xMax = hasValid
      ? Math.max(...validBboxes.map((w) => w.bbox[0] + w.bbox[2]))
      : 0;
    const yTop = hasValid ? Math.min(...validBboxes.map((w) => w.bbox[1])) : 0;
    const yBottom = hasValid
      ? Math.max(...validBboxes.map((w) => w.bbox[1] + w.bbox[3]))
      : 0;
    const height = hasValid
      ? Math.max(0.001, Math.max(...validBboxes.map((w) => w.bbox[3])))
      : 0;

    groups.push({
      lineIndex: lineIdx,
      startWordIdx: start,
      endWordIdx: end,
      words: slice,
      wordCount: slice.length,
      text: slice.map((w) => w.text.trim()).join(" "),
      hasValidBbox: hasValid,
      xMin,
      xMax,
      yTop,
      yBottom,
      height,
      explicitNewlinesBefore: explicitNewlinesBeforeWord[start] ?? 0,
    });

    start = end + 1;
  }

  return groups;
}

function isMultiColumnOrAmbiguous(lines: readonly OcrLineGroup[]): boolean {
  if (lines.length < 2) return false;
  const geomLines = lines.filter((l) => l.hasValidBbox);
  if (geomLines.length < 2) return false;

  for (let i = 1; i < geomLines.length; i += 1) {
    const prev = geomLines[i - 1];
    const curr = geomLines[i];
    const refH = Math.max(prev.height, curr.height);
    // Significant upward Y jump indicates jumping to the top of a second column
    if (curr.yTop < prev.yTop - refH * 1.5) {
      return true;
    }
    // Side-by-side non-overlapping horizontal bands on the same vertical row
    const sameRow =
      Math.abs(curr.yTop - prev.yTop) <= refH * 0.65 &&
      (curr.xMin > prev.xMax + refH * 0.8 ||
        prev.xMin > curr.xMax + refH * 0.8);
    if (sameRow) {
      return true;
    }
  }
  return false;
}

function isLikelyPoetryBlock(lines: readonly OcrLineGroup[]): boolean {
  if (lines.length < 3) return false;
  // Exclude lines that are clearly dialogue
  const nonDialogue = lines.filter((l) => !DIALOGUE_START_RE.test(l.text));
  if (nonDialogue.length < 3) return false;

  const shortLines = nonDialogue.filter(
    (l) => l.wordCount >= 3 && l.wordCount <= 9,
  );
  if (shortLines.length / nonDialogue.length < 0.75) return false;

  // Check capitalized line starts (very strong signal in Vietnamese poetry: lục bát, 4-5 chữ)
  const capStarts = nonDialogue.filter((l) =>
    UPPERCASE_LETTER_RE.test(l.text.trim().slice(0, 1)),
  ).length;
  const startsMostCapitalized = capStarts / nonDialogue.length >= 0.7;

  // Check rhythmic verse pattern (e.g. alternating 6-8 lục bát or uniform 4-5 words)
  const counts = nonDialogue.map((l) => l.wordCount);
  const minC = Math.min(...counts);
  const maxC = Math.max(...counts);
  const tightRhythm = maxC - minC <= 2 && maxC <= 8;

  // Check whether most lines do NOT end with prose mid-sentence comma-free run-ons
  const geomLines = nonDialogue.filter((l) => l.hasValidBbox);
  let narrowConsistentWidth = false;
  if (geomLines.length >= 3) {
    const widths = geomLines.map((l) => l.xMax - l.xMin);
    const maxW = Math.max(...widths);
    if (maxW > 0 && maxW < 0.65) {
      narrowConsistentWidth = true;
    }
  }

  return startsMostCapitalized && (tightRhythm || narrowConsistentWidth);
}

function isLikelyHeadingLine(
  line: OcrLineGroup,
  index: number,
  lines: readonly OcrLineGroup[],
): boolean {
  if (line.wordCount < 1 || line.wordCount > 8) return false;
  if (/[,;]$/.test(line.text.trim())) return false;
  const allCaps = isAllCapsLine(line.text);
  const isFirst = index === 0 && lines.length >= 2;
  const next = lines[index + 1];
  const gapAfter =
    next && line.hasValidBbox && next.hasValidBbox
      ? next.yTop - line.yBottom
      : 0;
  const refH = Math.max(line.height, next?.height ?? line.height);
  const hasGapAfter =
    (refH > 0 && gapAfter > refH * 1.15) ||
    (next !== undefined && next.explicitNewlinesBefore >= 2);

  if (allCaps && (isFirst || hasGapAfter)) return true;
  if (isFirst && hasGapAfter && line.wordCount <= 6) return true;
  return false;
}

export function computeUniversalPageWordLayout(
  page: ReadingPageDTO,
): PageReflowResult {
  const words = page.words;
  if (!words.length) {
    return { mode: "prose", entries: [] };
  }

  const lines = buildLineGroups(page);
  const paragraphStarts = new Set(page.paragraph_start_line_indices ?? []);
  const indentedLines = new Set(page.indented_line_indices ?? []);

  const ambiguousMultiCol = isMultiColumnOrAmbiguous(lines);
  const poetry = !ambiguousMultiCol && isLikelyPoetryBlock(lines);
  const mode: PageReflowMode = ambiguousMultiCol
    ? "source-preserved"
    : poetry
      ? "poetry"
      : "prose";

  const headingIndices = new Set<number>();
  if (mode !== "source-preserved") {
    lines.forEach((line, idx) => {
      if (isLikelyHeadingLine(line, idx, lines)) {
        headingIndices.add(idx);
      }
    });
  }

  const lineBreakBefore = new Map<number, number>();
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const refH = Math.max(prev.height, curr.height);
    const verticalGap =
      prev.hasValidBbox && curr.hasValidBbox ? curr.yTop - prev.yBottom : 0;
    const largeVerticalGap = refH > 0 && verticalGap > refH * 1.55;
    const explicitParagraph = curr.explicitNewlinesBefore >= 2;
    const startsDialogue = DIALOGUE_START_RE.test(curr.text.trim());
    const prevIsHeading = headingIndices.has(i - 1);
    const currIsHeading = headingIndices.has(i);

    if (mode === "source-preserved") {
      lineBreakBefore.set(
        i,
        explicitParagraph ||
          largeVerticalGap ||
          paragraphStarts.has(curr.lineIndex)
          ? 2
          : 1,
      );
      continue;
    }

    if (mode === "poetry") {
      const stanzaBreak =
        explicitParagraph || largeVerticalGap || prevIsHeading || currIsHeading;
      lineBreakBefore.set(i, stanzaBreak ? 2 : 1);
      continue;
    }

    // Prose mode: merge OCR-cut lines unless there is genuine structural evidence of a break
    if (prevIsHeading || currIsHeading) {
      lineBreakBefore.set(i, 2);
      continue;
    }

    if (startsDialogue) {
      lineBreakBefore.set(i, explicitParagraph || largeVerticalGap ? 2 : 1);
      continue;
    }

    const currStartsLowercase = LOWERCASE_START_RE.test(curr.text.trim());
    if (currStartsLowercase && !explicitParagraph && !largeVerticalGap) {
      // Mid-sentence OCR line wrap (e.g., "Em rất." / "yêu chú mèo..." or "mềm" / "mượt")
      lineBreakBefore.set(i, 0);
      continue;
    }

    const prevEndedSentence = SENTENCE_END_RE.test(prev.text.trim());
    const isGenuineParagraph =
      explicitParagraph ||
      largeVerticalGap ||
      (paragraphStarts.has(curr.lineIndex) && prevEndedSentence) ||
      (indentedLines.has(curr.lineIndex) && prevEndedSentence);

    lineBreakBefore.set(i, isGenuineParagraph ? 2 : 0);
  }

  const entries: WordLayoutEntry[] = [];
  for (let linePos = 0; linePos < lines.length; linePos += 1) {
    const line = lines[linePos];
    const breakBeforeLine =
      linePos === 0 ? 0 : (lineBreakBefore.get(linePos) ?? 0);
    const isHeading = headingIndices.has(linePos);
    const shouldIndent =
      mode === "prose" &&
      !isHeading &&
      (linePos === 0 || breakBeforeLine >= 2) &&
      indentedLines.has(line.lineIndex);

    for (let offset = 0; offset < line.words.length; offset += 1) {
      const word = line.words[offset];
      const wordIndex = line.startWordIdx + offset;
      entries.push({
        word,
        index: wordIndex,
        lineIndex: line.lineIndex,
        breakCount: offset === 0 ? breakBeforeLine : 0,
        isIndented: offset === 0 && shouldIndent,
        isHeadingLine: isHeading,
      });
    }
  }

  return { mode, entries };
}
