import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";

const countingWords: Readonly<Record<string, string>> = {
  "0": "không",
  "1": "một",
  "2": "hai",
  "3": "ba",
  "4": "bốn",
  "5": "năm",
  "6": "sáu",
  "7": "bảy",
  "8": "tám",
  "9": "chín",
  "10": "mười",
};

const singingTokens = /[+-]?\d+(?:[.,:/]\d+)+|[+-]\d+|[\p{L}\p{M}\p{N}]+/gu;

/** Rendering must assign the same occurrence IDs as the scoring tokenizer. */
export function splitSingingText(text: string): string[] {
  return text
    .normalize("NFC")
    .split(new RegExp(`(${singingTokens.source})`, "gu"));
}

/** ASR often formats counting lyrics as digits. Convert only unambiguous
 * standalone 0–10. Never split 67, decimal/time notation or signed numbers
 * to fit the reference; preserve Vietnamese tones and all other spelling. */
export function tokenizeSingingText(text: string): string[] {
  const tokens = text.normalize("NFC").match(singingTokens) ?? [];
  return tokens
    .map((token) => {
      if (/^[+-]\d/.test(token)) return token;
      const normalized = normalizeVietnameseWord(token);
      return countingWords[normalized] ?? normalized;
    })
    .filter(Boolean);
}
