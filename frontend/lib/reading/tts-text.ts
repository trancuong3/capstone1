import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";

export const TIMED_TTS_MAX_WORDS = 800;
export const TIMED_TTS_MAX_CHARACTERS = 5_000;
export const SHORT_TTS_MAX_CHARACTERS = 2_500;

export interface SpeechChunk {
  readonly text: string;
  readonly words: readonly string[];
  readonly wordOffset: number;
}

/** Keep every character, including punctuation and paragraph breaks. */
export function splitSpeechText(
  text: string,
  maxCharacters = TIMED_TTS_MAX_CHARACTERS,
  maxWords = TIMED_TTS_MAX_WORDS,
): SpeechChunk[] {
  const tokens = [...text.matchAll(/\S+\s*/gu)];
  const chunks: SpeechChunk[] = [];
  let first = 0;
  while (first < tokens.length) {
    const start = first === 0 ? 0 : tokens[first].index;
    let next = first;
    let sentenceEnd = -1;
    while (next < tokens.length && next - first < maxWords) {
      const end = tokens[next].index + tokens[next][0].length;
      if (end - start > maxCharacters) break;
      if (
        /[.!?…]["”’')\]]*\s*$/u.test(tokens[next][0]) ||
        /\n\s*\n/u.test(tokens[next][0])
      )
        sentenceEnd = next + 1;
      next += 1;
    }
    if (next === first) throw new Error("Một từ vượt giới hạn đọc mẫu.");
    if (next < tokens.length && sentenceEnd > first) next = sentenceEnd;
    const end = next < tokens.length ? tokens[next].index : text.length;
    chunks.push({
      text: text.slice(start, end),
      words: tokens
        .slice(first, next)
        .map((token) => token[0].trim().normalize("NFC")),
      wordOffset: first,
    });
    first = next;
  }
  return chunks;
}

/** Never attach source-token timing to a different OCR word sequence. */
export function hasMatchingSpeechWords(
  text: string,
  words: readonly string[],
): boolean {
  const tokens = text.match(/\S+/gu) ?? [];
  return (
    tokens.length === words.length &&
    tokens.every((token, index) => {
      const original = normalizeVietnameseWord(token);
      const expected = normalizeVietnameseWord(words[index]);
      return original && expected
        ? original === expected
        : token.normalize("NFC") === words[index].normalize("NFC");
    })
  );
}

export function speechWordAtCharacter(text: string, charIndex: number): number {
  if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= text.length)
    return -1;
  const tokens = [...text.matchAll(/\S+/gu)];
  return tokens.findIndex(
    (token) =>
      charIndex >= token.index && charIndex < token.index + token[0].length,
  );
}
