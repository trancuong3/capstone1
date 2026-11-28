export const TTS_MIC_COOLDOWN_MS = 280;

/**
 * Append `autoplay=1` to an entertainment URL without duplicating query separators.
 */
export function appendAutoplayParam(href: string): string {
  if (!href) return "?autoplay=1";
  if (/[?&]autoplay=1(?:&|$)/.test(href)) {
    return href;
  }
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}autoplay=1`;
}

/**
 * Resolve `?autoplay=1` from an optional server-passed prop or `window.location.search`.
 * Avoids `useSearchParams()` so client components remain compatible with lightweight mocks.
 */
export function resolveAutoPlayFlag(propAutoPlay?: boolean): boolean {
  if (propAutoPlay) return true;
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("autoplay") === "1";
  } catch {
    return false;
  }
}

/**
 * Count meaningful alphabetic words in Vietnamese/Latin child speech text.
 */
export function countMeaningfulWords(value: string): number {
  const matches = value.trim().match(/\p{L}+/gu);
  return matches ? matches.length : 0;
}

/**
 * Normalize a spoken or written Vietnamese snippet for substring/word matching.
 */
export function normalizePracticeSnippet(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/[.!?,;:…]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Return `true` when `text` contains the target difficult word/phrase.
 */
export function textContainsPracticeWord(text: string, word: string): boolean {
  const normalizedText = normalizePracticeSnippet(text);
  const normalizedWord = normalizePracticeSnippet(word);
  if (!normalizedText || !normalizedWord) return false;
  return ` ${normalizedText} `.includes(` ${normalizedWord} `);
}

/**
 * Format millisecond countdown into calm tenths of seconds (`2.5` -> `0.5`).
 */
export function formatCountdownSeconds(remainingMs: number): string {
  const clamped = Math.max(0, remainingMs);
  return (clamped / 1000).toFixed(1);
}
