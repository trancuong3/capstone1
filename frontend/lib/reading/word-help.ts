import { normalizeVietnameseText } from "./vietnamese-text";

export const WORD_HELP_SILENCE_LIMIT = 2;
export const MAX_WORD_HELP_ROUNDS = 1;

// Match a whole final utterance. A child can also be reading these words
// from a story, in which case the passage takes precedence.
export function isWordHelpRequest(text: string, target: string): boolean {
  const spoken = normalizeVietnameseText(text);
  return (
    /^(?:(?:cô|thầy) ơi )?(?:con|bé|em) (?:không|chưa) biết(?: đọc)?(?: từ này| chữ này)?(?: ạ)?$/u.test(
      spoken,
    ) && !` ${normalizeVietnameseText(target)} `.startsWith(` ${spoken} `)
  );
}
