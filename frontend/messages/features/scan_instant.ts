import type { MessageTree } from "@/lib/i18n/types";

export const scanInstantVi = {
  readNowCta: "Đọc ngay cùng AI",
  saveToMyBooksCta: "Lưu vào Sách của tôi",
  autoOcrCalmNotice:
    "Văn bản được nhận diện tự động từ ảnh chụp — ba mẹ có thể bấm sửa nhanh nếu có dấu thanh hoặc chữ chưa chuẩn.",
  quickEditToggle: "Sửa nhanh văn bản",
  quickEditDone: "Xong chỉnh sửa",
  quickEditReset: "Khôi phục văn bản gốc",
  quickEditLabel: "Nội dung trang sách để đọc cùng AI",
  quickEditPlaceholder:
    "Nhập hoặc chỉnh sửa văn bản tiếng Việt trên trang sách vừa chụp...",
  editedBadge: "Đã chỉnh sửa",
  panel: {
    regionAria: "Bảng đọc ngay cùng AI trên trang vừa chụp",
    badge: "Chụp là đọc ngay",
    heading: "Đọc cùng AI ngay trên trang vừa chụp",
    wordTapHint:
      "Chạm vào bất kỳ từ nào bên dưới để nghe phát âm và xem hướng dẫn đánh vần từng bước.",
    listenPassage: "Nghe AI đọc mẫu",
    pausePassage: "Tạm dừng nghe",
    resumePassage: "Tiếp tục nghe",
    stopPassage: "Dừng đọc mẫu",
    startMic: "Bắt đầu đọc cùng AI",
    stopMic: "Dừng & chấm đọc",
    transcribing: "AI đang lắng nghe và căn chỉnh từng từ...",
    resetAlignment: "Đọc lại từ đầu",
    closePanel: "Thu gọn",
    liveListeningHint:
      "Con hãy đọc to, rõ từng từ theo thứ tự trên trang nhé...",
    summaryProgress: "Đã đọc khớp {matched}/{total} từ ({accuracy}%)",
    summaryGreat: "Tuyệt vời! Con đã đọc rất tốt đoạn văn vừa chụp.",
    summaryKeepGoing:
      "Cố lên nhé! Chạm vào các từ tô vàng để nghe AI hướng dẫn đánh vần.",
    ttsError: "Chưa phát được giọng đọc mẫu lúc này. Vui lòng thử lại.",
    micPermissionError:
      "Chưa được cấp quyền micro. Vui lòng cho phép micro trên trình duyệt để luyện đọc.",
    sttEmptyNotice:
      "Chưa nghe rõ giọng đọc. Con hãy đưa thiết bị lại gần hơn và thử đọc lại nhé.",
    sttError: "Không thể nhận diện giọng đọc lúc này. Vui lòng thử lại.",
  },
  saveModal: {
    dialogAria: "Lưu trang vừa chụp vào Sách của tôi",
    heading: "Lưu vào Sách của tôi",
    privacyBadge: "Riêng tư gia đình",
    privacyNotice:
      "Trang sách được lưu riêng tư trong Sách của tôi của gia đình bạn, không công khai và không tạo liên kết chia sẻ ra bên ngoài.",
    modeCreateTab: "Tạo sách riêng mới",
    modeAppendTab: "Thêm vào sách đã có",
    bookTitleLabel: "Tên cuốn sách",
    bookTitlePlaceholder: "Nhập tên sách dễ nhớ cho bé...",
    gradeLabel: "Khối lớp phù hợp",
    gradeOption: "Lớp {grade}",
    targetBookLabel: "Chọn sách trong Sách của tôi",
    targetBookPageCount: "{count} trang đã lưu",
    loadingBooks: "Đang tải danh sách Sách của tôi...",
    emptyBooksNotice:
      "Bạn chưa có cuốn sách riêng nào đang hoạt động. Hãy chọn “Tạo sách riêng mới” để lưu ngay trang đầu tiên.",
    missingFileError:
      "Tệp ảnh chụp không còn trong bộ nhớ sau khi tải lại trang. Vui lòng chọn lại ảnh trang sách để lưu.",
    attachedImageReady:
      "Sẵn sàng lưu ảnh “{fileName}” ({wordCount} từ) — không cần chọn lại tệp ảnh.",
    submitCreate: "Lưu thành sách mới",
    submitAppend: "Thêm làm trang tiếp theo",
    saving: "Đang lưu an toàn...",
    cancel: "Đóng",
    successTitle: "Đã lưu vào Sách của tôi!",
    successBody:
      "Trang {pageNumber} của sách “{title}” đã sẵn sàng để bé mở đọc bất cứ lúc nào.",
    openSavedPageCta: "Mở Trang {pageNumber} để đọc ngay",
    viewInMyBooksCta: "Xem trong Sách của tôi",
    saveErrorFallback: "Không thể lưu trang sách lúc này. Vui lòng thử lại.",
    defaultTitleFallback: "Trang chụp ngày {date}",
  },
} as const satisfies MessageTree;

export const scanInstantEn = {
  readNowCta: "Read along with AI now",
  saveToMyBooksCta: "Save to My Books",
  autoOcrCalmNotice:
    "Text was automatically recognized from your photo — you can quickly edit minor diacritic typos if needed.",
  quickEditToggle: "Quick-edit text",
  quickEditDone: "Done editing",
  quickEditReset: "Restore original OCR",
  quickEditLabel: "Scanned page text for AI Read-Along",
  quickEditPlaceholder:
    "Enter or edit the Vietnamese text from the scanned page...",
  editedBadge: "Edited",
  panel: {
    regionAria: "Instant AI Read-Along panel for scanned page",
    badge: "Instant Read-Along",
    heading: "Read along with AI right on this scanned page",
    wordTapHint:
      "Tap any word below to hear pronunciation and view step-by-step Vietnamese phonics.",
    listenPassage: "Listen to AI model",
    pausePassage: "Pause audio",
    resumePassage: "Resume audio",
    stopPassage: "Stop audio",
    startMic: "Start reading aloud",
    stopMic: "Stop & check reading",
    transcribing: "AI is transcribing and aligning each word...",
    resetAlignment: "Read again from start",
    closePanel: "Collapse",
    liveListeningHint: "Read each word aloud clearly in order on the page...",
    summaryProgress: "Matched {matched}/{total} words ({accuracy}%)",
    summaryGreat: "Wonderful! You read the scanned passage smoothly.",
    summaryKeepGoing:
      "Nice effort! Tap any highlighted word to practice its phonics breakdown.",
    ttsError: "Unable to play AI model voice right now. Please try again.",
    micPermissionError:
      "Microphone permission was denied. Please allow microphone access to read aloud.",
    sttEmptyNotice:
      "Could not hear clear speech. Please hold the device closer and try again.",
    sttError: "Unable to recognize speech right now. Please try again.",
  },
  saveModal: {
    dialogAria: "Save scanned page to My Books",
    heading: "Save to My Books",
    privacyBadge: "Household private",
    privacyNotice:
      "This page is saved strictly inside your household's private My Books — never published publicly or shared via external links.",
    modeCreateTab: "Create new private book",
    modeAppendTab: "Add to existing book",
    bookTitleLabel: "Book title",
    bookTitlePlaceholder: "Enter a memorable book title...",
    gradeLabel: "Grade level",
    gradeOption: "Grade {grade}",
    targetBookLabel: "Select a book in My Books",
    targetBookPageCount: "{count} saved pages",
    loadingBooks: "Loading your private books...",
    emptyBooksNotice:
      "You do not have any active private books yet. Choose 'Create new private book' to save your first page.",
    missingFileError:
      "The scanned image file is no longer in memory after reload. Please re-select the page image to save.",
    attachedImageReady:
      "Ready to save '{fileName}' ({wordCount} words) — no second upload needed.",
    submitCreate: "Save as new book",
    submitAppend: "Append as next page",
    saving: "Saving privately...",
    cancel: "Close",
    successTitle: "Saved to My Books!",
    successBody: "Page {pageNumber} of '{title}' is ready to read anytime.",
    openSavedPageCta: "Open Page {pageNumber} to read now",
    viewInMyBooksCta: "View in My Books",
    saveErrorFallback:
      "Unable to save scanned page right now. Please try again.",
    defaultTitleFallback: "Scanned page {date}",
  },
} as const satisfies MessageTree;
