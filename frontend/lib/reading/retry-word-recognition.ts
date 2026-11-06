/**
 * Helpers for isolated Vietnamese retry-word recognition.
 *
 * Không xóa dấu thanh tiếng Việt và không chuyển "đ" thành "d".
 * Một từ chỉ được xác nhận đúng khi transcript có từ mục tiêu như một token
 * hoàn chỉnh. Dấu thanh tiếng Việt vẫn được giữ nguyên.
 */

export type RetryRecognitionStatus =
  "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NOT_RECOGNIZED";

/**
 * Chuẩn hóa một từ tiếng Việt.
 *
 * Giữ nguyên:
 * - Dấu thanh: á, à, ả, ã, ạ...
 * - Chữ đ và Đ.
 *
 * Chỉ loại bỏ dấu câu ở đầu và cuối từ.
 */
export function normalizeVietnameseRetryToken(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("vi-VN")
    .trim()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .normalize("NFC")
    .trim();
}

/**
 * Đánh giá từ đích trong một transcript ngắn.
 *
 * Cụm từ ngắn được chấp nhận khi từ đích xuất hiện như một token riêng.
 * Transcript dài hơn cần được coi là không chắc chắn vì có thể là hội thoại
 * không liên quan. Không dùng nội dung keyterm làm bằng chứng nhận diện.
 */
export function classifyRetryTranscript(
  expectedWord: string,
  transcript: string | null | undefined,
): RetryRecognitionStatus {
  const expected = normalizeVietnameseRetryToken(expectedWord);

  if (!expected || /\s/u.test(expected)) {
    return "UNCERTAIN";
  }

  const rawTranscript = transcript?.trim() ?? "";

  if (!rawTranscript) {
    return "NOT_RECOGNIZED";
  }

  const normalizedTranscript = rawTranscript
    .normalize("NFC")
    .toLocaleLowerCase("vi-VN")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  const tokens = normalizedTranscript
    .split(" ")
    .map(normalizeVietnameseRetryToken)
    .filter(Boolean);

  if (tokens.length === 0) {
    return "NOT_RECOGNIZED";
  }

  if (tokens.length > 4) return "UNCERTAIN";
  if (tokens.includes(expected)) return "CORRECT";
  return "INCORRECT";
}
