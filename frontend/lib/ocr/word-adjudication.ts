import { normalizeVietnameseWord } from "@/lib/ocr/sync-page-text-words";
import type { AdminOcrWordEvidenceDTO } from "@/types/admin";

/**
 * Mirror of backend `app/services/ocr_adjudication.py` (`adjudicate_word`).
 * Both sides must reach the same decision from the same evidence snapshot;
 * keep the rule constants and reading order identical when either changes.
 *
 * VietOCR and Tesseract are Vietnamese recognizers. PaddleOCR's Latin model
 * cannot output most Vietnamese letters, so its differing token is never
 * evidence against a Vietnamese reading.
 */
export const OCR_ADJUDICATION_RULE = "independent_engine_agreement_v2";

const LINE_READINGS = [
  "paddleocr_line",
  "vietocr_line",
  "tesseract_line",
] as const;
const CROP_READINGS = [
  "paddleocr_crop",
  "vietocr_crop",
  "tesseract_crop",
] as const;
type ReadingKey =
  (typeof LINE_READINGS)[number] | (typeof CROP_READINGS)[number];

const READING_ENGINE: Record<ReadingKey, string> = {
  paddleocr_line: "paddleocr",
  vietocr_line: "vietocr",
  tesseract_line: "tesseract",
  paddleocr_crop: "paddleocr",
  vietocr_crop: "vietocr",
  tesseract_crop: "tesseract",
};
const VIETNAMESE_CAPABLE_ENGINES = new Set(["vietocr", "tesseract"]);

const MIN_SUPPORTING_ENGINES = 2;
const MAX_OPPOSING_READINGS_PER_TOKEN = 1;

export type WordAdjudication = {
  readonly status: "resolved" | "unresolved" | "not_applicable";
  readonly text: string | null;
  readonly support: readonly string[];
};

function adjudicationToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = normalizeVietnameseWord(value);
  if (!token || /\s/u.test(token)) return null;
  return token;
}

function baseLetters(token: string): string {
  return token
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/đ/gu, "d");
}

function collectWordReadings(
  evidence: AdminOcrWordEvidenceDTO,
): Partial<Record<ReadingKey, string>> {
  const readings: Partial<Record<ReadingKey, string>> = {};
  const statuses = evidence.engine_statuses;
  for (const [key, engine] of [
    ["paddleocr_line", "paddleocr"],
    ["vietocr_line", "vietocr"],
    ["tesseract_line", "tesseract"],
  ] as const) {
    // A line reading counts only when that engine demonstrably ran.
    if (!statuses || statuses[engine] !== "success") continue;
    const token = adjudicationToken(evidence.engine_outputs?.[engine]);
    if (token !== null) readings[key] = token;
  }
  const crop = evidence.crop_evidence;
  if (crop && crop.status === "completed") {
    for (const [key, field, errorField] of [
      ["paddleocr_crop", "paddleocr_candidate", "paddle_error"],
      ["vietocr_crop", "vietocr_candidate", "vietocr_error"],
      ["tesseract_crop", "tesseract_candidate", "tesseract_error"],
    ] as const) {
      if (typeof crop[errorField] === "string") continue;
      const token = adjudicationToken(crop[field]);
      if (token !== null) readings[key] = token;
    }
  }
  return readings;
}

/**
 * "resolved" means independent engines confirm one token: both Vietnamese
 * engines when Tesseract ran (PaddleOCR + VietOCR for evidence recorded
 * without a Tesseract reading), no Vietnamese engine reading the same base
 * letters with different marks, and supporters outnumbering the opposition.
 */
export function adjudicateWord(
  evidence: AdminOcrWordEvidenceDTO | null | undefined,
): WordAdjudication {
  const notApplicable: WordAdjudication = {
    status: "not_applicable",
    text: null,
    support: [],
  };
  if (!evidence) return notApplicable;
  const tesseractRan = evidence.engine_statuses?.tesseract === "success";
  const regionUsable =
    evidence.bbox_quality === "valid" && evidence.crop_quality === "usable";
  // Line readings are attached by token order, not by the box, so a clipped
  // crop says nothing about the text. Only evidence recorded before
  // Tesseract was an engine keeps the old region gate.
  if (!regionUsable && !tesseractRan) return notApplicable;

  const readings = collectWordReadings(evidence);
  const byToken = new Map<string, ReadingKey[]>();
  for (const key of [...LINE_READINGS, ...CROP_READINGS]) {
    const token = readings[key];
    if (token === undefined) continue;
    byToken.set(token, [...(byToken.get(token) ?? []), key]);
  }
  const confirmed: Array<[string, ReadingKey[]]> = [];
  for (const [token, supporters] of byToken) {
    const engines = new Set(supporters.map((key) => READING_ENGINE[key]));
    const capableEngines = [...engines].filter((engine) =>
      VIETNAMESE_CAPABLE_ENGINES.has(engine),
    );
    let opposing = 0;
    let strongestOpponent = 0;
    let diacriticConflict = false;
    let incompleteDetectorReading = false;
    for (const [otherToken, otherSupporters] of byToken) {
      if (otherToken === token) continue;
      // PaddleOCR's generic Latin recognizer often drops Vietnamese marks,
      // so a different full token is not a veto. A strict prefix suggests
      // that it saw only part of the word (for example "M" while both
      // Vietnamese engines say "Mỹ"); leave that token for human review.
      if (
        (otherToken.length < token.length && token.startsWith(otherToken)) ||
        (token.length < otherToken.length && otherToken.startsWith(token))
      ) {
        const hasPaddlePrefix = otherSupporters.some(
          (key) => READING_ENGINE[key] === "paddleocr",
        );
        incompleteDetectorReading ||= hasPaddlePrefix;
      }
      const capable = otherSupporters.filter((key) =>
        VIETNAMESE_CAPABLE_ENGINES.has(READING_ENGINE[key]),
      );
      if (capable.length === 0) continue;
      opposing += capable.length;
      strongestOpponent = Math.max(strongestOpponent, capable.length);
      if (baseLetters(otherToken) === baseLetters(token))
        diacriticConflict = true;
    }
    const enoughEngines = tesseractRan
      ? capableEngines.length >= MIN_SUPPORTING_ENGINES
      : engines.size >= MIN_SUPPORTING_ENGINES;
    if (
      enoughEngines &&
      strongestOpponent <= MAX_OPPOSING_READINGS_PER_TOKEN &&
      supporters.length > opposing &&
      !diacriticConflict &&
      !incompleteDetectorReading
    ) {
      confirmed.push([token, supporters]);
    }
  }

  if (confirmed.length !== 1)
    return { status: "unresolved", text: null, support: [] };
  const [token, supporters] = confirmed[0];
  return { status: "resolved", text: token, support: supporters };
}
