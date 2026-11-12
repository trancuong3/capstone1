/** Shared NFC/token policy. Tone marks and đ are meaningful, not noise. */
export function normalizeVietnameseWord(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("vi-VN")
    .trim()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .trim()
    .normalize("NFC");
}

export function tokenizeVietnameseText(value: string): string[] {
  return (value.normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
    .map(normalizeVietnameseWord)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
}

export function normalizeVietnameseText(value: string): string {
  return tokenizeVietnameseText(value).join(" ");
}
