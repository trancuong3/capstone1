import { normalizeVietnameseText } from "./vietnamese-text";

export const WORD_HELP_SILENCE_LIMIT = 2;
export const MAX_WORD_HELP_ROUNDS = 1;

function notInTarget(spoken: string, target: string): boolean {
  return !` ${normalizeVietnameseText(target)} `.startsWith(` ${spoken} `);
}

// Match a whole final utterance. A child can also be reading these words
// from a story, in which case the passage takes precedence.
export function isWordHelpRequest(text: string, target: string): boolean {
  const spoken = normalizeVietnameseText(text);
  if (!spoken || !notInTarget(spoken, target)) return false;
  return (
    /^(?:(?:cô|thầy) ơi )?(?:con|bé|em) (?:không|chưa) biết(?: đọc)?(?: từ này| chữ này| chỗ này)?(?: ạ)?$/u.test(
      spoken,
    ) ||
    /^(?:(?:cô|thầy) ơi )?(?:chữ này|từ này|chỗ này) (?:con|bé|em) (?:không|chưa) biết(?: đọc)?(?: ạ)?$/u.test(
      spoken,
    )
  );
}

export function isSpellingHelpRequest(text: string, target: string): boolean {
  const spoken = normalizeVietnameseText(text);
  if (!spoken || !notInTarget(spoken, target)) return false;
  return /^(?:(?:cô|thầy) ơi )?(?:(?:cô |thầy )?đánh vần(?: giúp| cho| hộ)?(?: con| bé| em)?|(?:cho )?(?:con |bé |em )?nghe đánh vần)(?: từ này| chữ này| tiếng này)?(?: ạ| nhé| nha)?$/u.test(
    spoken,
  );
}

export function isReplaySampleRequest(text: string, target: string): boolean {
  const spoken = normalizeVietnameseText(text);
  if (!spoken || !notInTarget(spoken, target)) return false;
  return /^(?:(?:cô|thầy) ơi )?(?:cô |thầy )?(?:đọc|nghe) lại(?: lần nữa| một lần nữa| giúp con| cho con)?(?: ạ| nhé| nha)?$/u.test(
    spoken,
  );
}
