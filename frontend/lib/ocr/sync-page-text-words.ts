import type { AdminRevisionWordDTO } from "@/types/admin";

export type PageTextWordSyncResult =
  | {
      readonly status: "synchronized";
      readonly tokens: readonly string[];
      readonly words: readonly AdminRevisionWordDTO[];
    }
  | {
      readonly status: "token-count-mismatch";
      readonly tokens: readonly string[];
      readonly expectedWordCount: number;
      readonly actualTokenCount: number;
      readonly words: readonly AdminRevisionWordDTO[];
    };

/**
 * Chuẩn hóa canonical tiếng Việt dùng chung cho so khớp OCR và văn bản nháp.
 * Đảm bảo 100% xử lý trên Unicode NFC để triệt tiêu lệch mã ký tự.
 */
export function normalizeVietnameseWord(value: string): string {
  const characters = Array.from(
    value.normalize("NFC").trim().toLocaleLowerCase("vi"),
  );
  const shouldTrim = (character: string) =>
    /[\p{P}\p{S}]/u.test(character) && character !== "'" && character !== "-";

  while (characters.length > 0 && shouldTrim(characters[0])) {
    characters.shift();
  }
  while (
    characters.length > 0 &&
    shouldTrim(characters[characters.length - 1])
  ) {
    characters.pop();
  }

  return characters.join("").replace(/\s+/gu, " ").trim().normalize("NFC");
}

/**
 * Phân tách chuỗi thành mảng token từ chuẩn hóa Unicode NFC.
 */
export function tokenizePageText(value: string): string[] {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) return [];
  return normalized
    .split(/\s+/u)
    .filter((token) => normalizeVietnameseWord(token).length > 0)
    .map((token) => token.normalize("NFC"));
}

/**
 * Đồng bộ văn bản trang với danh sách bounding box từ OCR khi số lượng token
 * khớp 1:1, giữ bbox và điểm OCR chỉ khi token không đổi. Token đã sửa mất
 * điểm OCR nguồn và cần được Admin xem lại trước khi xác minh.
 */
export function syncPageTextToWords(
  draftText: string,
  existingWords: readonly AdminRevisionWordDTO[],
): PageTextWordSyncResult {
  const tokens = tokenizePageText(draftText);

  if (tokens.length !== existingWords.length) {
    return {
      status: "token-count-mismatch",
      tokens,
      expectedWordCount: existingWords.length,
      actualTokenCount: tokens.length,
      words: existingWords,
    };
  }

  const words = existingWords.map((word, index) => {
    const token = tokens[index];
    const tokenChanged = token !== word.text.normalize("NFC");
    return {
      ...word,
      text: token,
      normalized_text: normalizeVietnameseWord(token),
      ocr_confidence: tokenChanged ? null : word.ocr_confidence,
      ocr_score_source: tokenChanged ? null : word.ocr_score_source,
      ocr_review_status: tokenChanged
        ? ("needs_review" as const)
        : (word.ocr_review_status ?? "needs_review"),
      bbox: [...word.bbox] as [number, number, number, number],
    };
  });

  return { status: "synchronized", tokens, words };
}

export type WordsToPageTextSyncResult =
  | { readonly status: "synchronized"; readonly text: string }
  | {
      readonly status: "token-count-mismatch";
      readonly text: string;
      readonly expectedWordCount: number;
      readonly actualTokenCount: number;
    };

/**
 * Đồng bộ danh sách từ đơn trở lại khung văn bản mà không làm vỡ cấu trúc
 * ngắt dòng.
 */
export function syncWordsToPageText(
  currentPageText: string,
  words: readonly AdminRevisionWordDTO[],
): WordsToPageTextSyncResult {
  const normalizedPageText = currentPageText.normalize("NFC");
  const segments = normalizedPageText.match(/\s+|\S+/gu) ?? [];
  const pageTokenCount = segments.filter(
    (segment) => !/^\s+$/u.test(segment),
  ).length;

  const hasInvalidWord = words.some(
    (word) => tokenizePageText(word.text).length !== 1,
  );
  if (pageTokenCount !== words.length || hasInvalidWord) {
    return {
      status: "token-count-mismatch",
      text: normalizedPageText,
      expectedWordCount: words.length,
      actualTokenCount: pageTokenCount,
    };
  }

  let wordIndex = 0;
  const text = segments
    .map((segment) => {
      if (/^\s+$/u.test(segment)) return segment;
      const nextWord = words[wordIndex++];
      return nextWord.text.trim().normalize("NFC");
    })
    .join("")
    .normalize("NFC");

  return { status: "synchronized", text };
}
