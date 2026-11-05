/**
 * Helpers for isolated Vietnamese retry-word recognition.
 *
 * Không xóa dấu thanh tiếng Việt và không chuyển "đ" thành "d".
 * Một từ chỉ được xác nhận đúng khi transcript khớp chính xác
 * với từ mục tiêu sau khi chuẩn hóa Unicode và dấu câu.
 */

export type RetryRecognitionStatus =
  | "CORRECT"
  | "INCORRECT"
  | "UNCERTAIN"
  | "NOT_RECOGNIZED";

/**
 * Chuẩn hóa một từ tiếng Việt.
 *
 * Giữ nguyên:
 * - Dấu thanh: á, à, ả, ã, ạ...
 * - Chữ đ và Đ.
 *
 * Chỉ loại bỏ dấu câu ở đầu và cuối từ.
 */
export function normalizeVietnameseRetryToken(
  value: string,
): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("vi-VN")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .normalize("NFC")
    .trim();
}

/**
 * Đánh giá kết quả nhận diện một từ.
 *
 * Quy tắc:
 * 1. Khớp chính xác một từ: CORRECT.
 * 2. Nhận diện một từ khác: INCORRECT.
 * 3. Transcript chứa nhiều từ: UNCERTAIN.
 * 4. Không có transcript: NOT_RECOGNIZED.
 *
 * Không chấp nhận trường hợp transcript chứa từ mục tiêu
 * ở giữa một câu dài.
 */
export function classifyRetryTranscript(
  expectedWord: string,
  transcript: string | null | undefined,
): RetryRecognitionStatus {
  const expected =
    normalizeVietnameseRetryToken(expectedWord);

  if (!expected || /\s/u.test(expected)) {
    return "UNCERTAIN";
  }

  const rawTranscript = transcript?.trim() ?? "";

  if (!rawTranscript) {
    return "NOT_RECOGNIZED";
  }

  const tokens = rawTranscript
    .split(/\s+/u)
    .map(normalizeVietnameseRetryToken)
    .filter(Boolean);

  if (tokens.length === 0) {
    return "NOT_RECOGNIZED";
  }

  // Chế độ luyện một từ, không chấp nhận cả cụm từ.
  if (tokens.length !== 1) {
    return "UNCERTAIN";
  }

  return tokens[0] === expected
    ? "CORRECT"
    : "INCORRECT";
}