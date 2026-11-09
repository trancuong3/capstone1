/**
 * Backend `detail` strings of Reading Management conflicts (HTTP 409) mapped to
 * parent-facing Vietnamese text. Only these authored strings may reach the UI.
 */
export const readingManagementMessages: Readonly<Record<string, string>> = {
  "An active goal with the same metric and period already overlaps these dates":
    "Bé đã có mục tiêu cùng loại và cùng chu kỳ trong khoảng ngày này. Hãy sửa mục tiêu cũ hoặc kết thúc nó trước.",
  "The end date is already in the past":
    "Ngày kết thúc đã qua. Hãy chọn một ngày từ hôm nay trở đi.",
  "The end date must not be before the start date":
    "Ngày kết thúc không được trước ngày bắt đầu.",
  "The plan end date is already in the past":
    "Ngày kết thúc của kế hoạch đã qua. Hãy chọn một ngày từ hôm nay trở đi.",
  "The plan has no reading day between its start and end dates":
    "Khoảng ngày đã chọn không có ngày đọc nào trong tuần. Hãy chọn thêm ngày đọc hoặc kéo dài ngày kết thúc.",
  "The selected book is not available to read":
    "Sách đã chọn hiện chưa thể đọc. Hãy chọn sách khác.",
  "A reminder with the same time and overlapping days already exists":
    "Đã có lịch nhắc cùng giờ vào những ngày này. Hãy sửa lịch nhắc đó thay vì tạo thêm.",
  "The requested state transition is not allowed":
    "Thao tác này không còn phù hợp với trạng thái hiện tại. Hãy tải lại trang rồi thử lại.",
};

const knownMessages = new Set(Object.values(readingManagementMessages));

/**
 * The specific, parent-facing reason when a mutation was refused by a business
 * rule (409); `null` for anything else so callers keep their generic wording.
 */
export function conflictMessage(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 409 &&
    "message" in error &&
    typeof error.message === "string" &&
    knownMessages.has(error.message)
  ) {
    return error.message;
  }
  return null;
}
