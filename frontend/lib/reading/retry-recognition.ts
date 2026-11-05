const retryPunctuation = /[^\p{L}\p{N}\s]/gu;

/**
 * Normalizes browser speech text without stripping Vietnamese diacritics.
 * Tone marks are semantically meaningful and must remain part of recognition.
 */
export function normalizeRetryText(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("vi-VN")
    .replace(retryPunctuation, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Returns true only when the target appears as a complete token sequence in
 * at least one final transcript/alternative. This allows a child to read the
 * suggested phrase while still requiring the target word to be recognized.
 */
export function isRetryWordRecognized(
  expectedWord: string,
  transcripts: readonly string[],
): boolean {
  const expectedTokens = normalizeRetryText(expectedWord)
    .split(" ")
    .filter(Boolean);

  if (expectedTokens.length === 0) return false;

  return transcripts.some((transcript) => {
    const actualTokens = normalizeRetryText(transcript)
      .split(" ")
      .filter(Boolean);

    return actualTokens.some((_, startIndex) =>
      expectedTokens.every(
        (token, offset) => actualTokens[startIndex + offset] === token,
      ),
    );
  });
}
