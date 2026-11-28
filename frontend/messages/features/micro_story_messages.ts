import type { MessageTree } from "@/lib/i18n/types";

export const microStoryVi = {
  ctaButton: "Tạo Truyện Tranh 4 Trang Từ Từ Khó",
  modalTitle: "Truyện Tranh Mini 4 Trang Của Riêng {alias}",
  modalTitleDefault: "Tạo Truyện Tranh 4 Trang Từ Từ Khó",
  privacyLockLabel: "Riêng tư gia đình (PARENT_PRIVATE)",
  privacyNotice:
    "Truyện được lưu riêng tư trong Sách của tôi của gia đình — không công khai và không tạo liên kết chia sẻ ra bên ngoài.",
  selectChildLabel: "Chọn hồ sơ của bé",
  gradeBadge: "Lớp {grade}",
  quotaAvailable: "Còn {remaining}/{limit} lượt tạo miễn phí hôm nay",
  quotaExceededBadge: "Đã hết {limit}/{limit} lượt tạo hôm nay",
  quotaExceededTitle: "Hôm nay bé đã tạo đủ số truyện tranh mini miễn phí",
  quotaExceededBody:
    "Mỗi bé có tối đa {limit} lượt tạo/ngày để bảo vệ hạn mức minh họa AI miễn phí. Ba mẹ hãy cùng {alias} mở đọc các cuốn trong Sách của tôi và quay lại vào ngày mai nhé!",
  coldStartNotice:
    "Bé mới có ít lịch sử từ khó nên hệ thống đã gợi ý thêm các từ luyện vần phù hợp Lớp {grade} (GDPT 2018).",
  targetWordsHeading: "Chọn 3–5 từ khó để lồng ghép tự nhiên vào truyện",
  selectedCountBadge: "Đã chọn {count}/5 từ",
  minMaxWordsHint:
    "Hãy giữ từ 3 đến 5 từ để câu chuyện 4 trang vừa sức với bé.",
  sourceWeakWord: "Từ cần ôn",
  sourceColdStart: "Gợi ý lớp {grade}",
  sourceCustom: "Ba mẹ thêm",
  customWordLabel: "Thêm từ muốn bé luyện đọc (tùy chọn)",
  customWordPlaceholder: "Ví dụ: lung linh, rộn ràng...",
  addCustomWordAction: "Thêm từ",
  themeHintLabel: "Chủ đề câu chuyện yêu thích (tùy chọn)",
  themeHintPlaceholder: "Ví dụ: Khu vườn nắng sớm và chú mèo nhỏ...",
  generateAction: "Tạo truyện tranh 4 trang ngay",
  generatingAction: "Đang sáng tác & vẽ minh họa...",
  cancelAction: "Đóng",
  retryPreviewAction: "Tải lại gợi ý từ",
  noChildrenTitle: "Chưa có hồ sơ của bé",
  noChildrenBody:
    "Hãy tạo hồ sơ cho bé trước để hệ thống chọn đúng từ khó và độ tuổi tiểu học.",
  createChildAction: "Tạo hồ sơ cho bé",
  loadingPreview: "Đang chuẩn bị danh sách từ khó và hạn mức hôm nay của bé...",
  progressStageWords:
    "Đang chọn lọc 3–5 từ khó và kiểm tra an toàn nội dung...",
  progressStageStory: "Đang viết cốt truyện 4 trang phù hợp độ tuổi của bé...",
  progressStageArt: "Đang vẽ 4 tranh minh họa đồng nhất không chứa chữ...",
  progressStageSave: "Đang lưu sách riêng tư và tạo câu hỏi đọc hiểu...",
  createdBadge: "Đã lưu vào Sách của tôi · Sẵn sàng đọc ngay",
  createdSummary:
    "Đã tạo xong 4 trang truyện minh họa lồng ghép {wordCount} từ mục tiêu kèm {questionCount} câu hỏi đọc hiểu cho {alias}!",
  fallbackIllustrationNote:
    "Tranh minh họa được dựng bằng bộ minh họa an toàn tích hợp sẵn để bé đọc ngay không gián đoạn.",
  safetySanitizedNote:
    "Nội dung đã được chuẩn hóa theo tiêu chuẩn an toàn học sinh tiểu học GDPT 2018.",
  pagePreviewLabel: "Trang {page}",
  embeddedWordsLabel: "Từ mục tiêu trong truyện:",
  openReaderPrimary: "Mở đọc ngay truyện 4 trang",
  openMyBooksSecondary: "Xem chi tiết trong Sách của tôi",
  errorSafetyRejected:
    "Từ ngữ hoặc chủ đề gợi ý chưa phù hợp với tiêu chuẩn an toàn trẻ em tiểu học. Ba mẹ vui lòng chỉnh lại nhé.",
  errorGeneric:
    "Chưa thể tạo truyện tranh lúc này. Ba mẹ vui lòng kiểm tra kết nối và thử lại.",
} as const satisfies MessageTree;

export const microStoryEn = {
  ctaButton: "Create 4-Page Comic From Tricky Words",
  modalTitle: "{alias}'s Personalized 4-Page Mini Storybook",
  modalTitleDefault: "Create 4-Page Mini Storybook",
  privacyLockLabel: "Household Private (PARENT_PRIVATE)",
  privacyNotice:
    "Saved strictly as a private book in your family's My Books — never published publicly or shared externally.",
  selectChildLabel: "Choose child profile",
  gradeBadge: "Grade {grade}",
  quotaAvailable: "{remaining}/{limit} free stories left today",
  quotaExceededBadge: "0/{limit} free stories left today",
  quotaExceededTitle: "Daily mini-storybook quota reached for today",
  quotaExceededBody:
    "Each child can create up to {limit} stories per day to protect free AI illustration capacity. Enjoy reading saved books with {alias} and come back tomorrow!",
  coldStartNotice:
    "Because tricky-word history is still light, Grade {grade} Vietnamese phonics words were added.",
  targetWordsHeading: "Choose 3–5 target words to weave into the 4-page story",
  selectedCountBadge: "{count}/5 words selected",
  minMaxWordsHint:
    "Keep between 3 and 5 words so the 4-page story stays balanced.",
  sourceWeakWord: "Due review",
  sourceColdStart: "Grade {grade} pick",
  sourceCustom: "Parent custom",
  customWordLabel: "Add a custom Vietnamese word (optional)",
  customWordPlaceholder: "e.g. lung linh, rộn ràng...",
  addCustomWordAction: "Add word",
  themeHintLabel: "Story theme idea (optional)",
  themeHintPlaceholder: "e.g. Morning garden with a friendly kitten...",
  generateAction: "Generate 4-page storybook",
  generatingAction: "Writing & illustrating...",
  cancelAction: "Close",
  retryPreviewAction: "Reload word suggestions",
  noChildrenTitle: "No child profile yet",
  noChildrenBody:
    "Create a child profile first so ViRead can match tricky words and grade level.",
  createChildAction: "Create child profile",
  loadingPreview: "Loading target tricky words and today's quota...",
  progressStageWords: "Selecting 3–5 target words & verifying child safety...",
  progressStageStory: "Writing an age-adapted 4-page Vietnamese story...",
  progressStageArt: "Illustrating 4 consistent text-free panels...",
  progressStageSave: "Saving private book & comprehension questions...",
  createdBadge: "Saved to My Books · Ready to read",
  createdSummary:
    "Created a 4-page illustrated story with {wordCount} target words and {questionCount} comprehension questions for {alias}!",
  fallbackIllustrationNote:
    "Illustrated using built-in child-safe storybook artwork so reading starts right away.",
  safetySanitizedNote:
    "Story content was verified and normalized for elementary child safety.",
  pagePreviewLabel: "Page {page}",
  embeddedWordsLabel: "Target words in this story:",
  openReaderPrimary: "Open & read 4-page story now",
  openMyBooksSecondary: "View in My Books",
  errorSafetyRejected:
    "The suggested word or theme did not pass elementary child-safety checks. Please adjust and try again.",
  errorGeneric:
    "Could not generate the mini-storybook right now. Please try again shortly.",
} as const satisfies MessageTree;

export type MicroStoryMessageKey = keyof typeof microStoryVi;
