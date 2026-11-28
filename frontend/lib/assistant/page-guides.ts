import { requiresSelectedChildForHref } from "@/lib/assistant/child-gate";
import {
  hasMobileBottomNavPath,
  inferAssistantRoleScope,
  isAdminPath,
  isAuthPath,
  isReadingSessionPath,
  isSafeAssistantNavigationHref,
  isSafeAssistantQuickActionHref,
} from "@/lib/assistant/route-helpers";
import type {
  AssistantChatResponse,
  AssistantNavigationOffer,
  AssistantQuickAction,
  AssistantRoleScope,
  AssistantScopeBoundaryReason,
  BandwidthPreference,
  BandwidthProfile,
  DetectedNetworkInfo,
} from "@/types/assistant";

interface PageGuideConfig {
  readonly prefix: string;
  readonly titleVi: string;
  readonly titleEn: string;
  readonly greetingVi: string;
  readonly greetingEn: string;
  readonly promptsVi: readonly [string, string, string];
  readonly promptsEn: readonly [string, string, string];
  readonly actions: readonly {
    readonly labelVi: string;
    readonly labelEn: string;
    readonly href: string;
  }[];
}

export interface ResolvedPageGuide {
  readonly title: string;
  readonly greeting: string;
  readonly prompts: readonly string[];
  readonly actions: readonly AssistantQuickAction[];
}

const PAGE_GUIDES: readonly PageGuideConfig[] = [
  {
    prefix: "/admin/login",
    titleVi: "Đăng nhập Quản trị",
    titleEn: "Admin Sign In",
    greetingVi:
      "Cần hỗ trợ đăng nhập tài khoản quản trị ViRead hoặc xử lý lỗi xác thực?",
    greetingEn:
      "Need help signing in to your ViRead admin account or resolving authentication issues?",
    promptsVi: [
      "Cách đăng nhập và xác minh tài khoản quản trị?",
      "Quên mật khẩu tài khoản thì xử lý thế nào?",
      "ViRead có những chức năng gì?",
    ],
    promptsEn: [
      "How do I sign in to the admin portal?",
      "How do I recover a forgotten account password?",
      "What features does ViRead offer?",
    ],
    actions: [],
  },
  {
    prefix: "/admin/viread-training",
    titleVi: "Quản lý mô hình đọc chữ",
    titleEn: "OCR Model Training",
    greetingVi:
      "Cần hướng dẫn về Flow 1/Flow 2, chuẩn hygiene hay Apps Script Bridge?",
    greetingEn:
      "Need help with Flow 1/Flow 2 datasets, hygiene rules, or Apps Script Bridge?",
    promptsVi: [
      "Quy trình Flow 2 hygiene cần điều kiện gì?",
      "Apps Script Bridge dùng khi nào?",
      "Kiểm tra sức khỏe worker ở đâu?",
    ],
    promptsEn: [
      "What are Flow 2 hygiene requirements?",
      "When should I use Apps Script Bridge?",
      "Where can I check worker health?",
    ],
    actions: [
      { labelVi: "Mở Vận hành", labelEn: "Open Health", href: "/admin/health" },
      { labelVi: "Kho sách", labelEn: "Books", href: "/admin/books" },
    ],
  },
  {
    prefix: "/admin/health",
    titleVi: "Vận hành hệ thống",
    titleEn: "Operations Health",
    greetingVi:
      "Hỏi tôi về trạng thái OCR worker, Voice worker hoặc các tầng AI phân tầng.",
    greetingEn:
      "Ask about OCR workers, voice workers, or tiered AI provider circuits.",
    promptsVi: [
      "Cách kiểm tra worker OCR và giọng đọc?",
      "Trợ lý AI phân tầng hoạt động thế nào?",
      "Xem nhật ký kiểm toán quản trị ở đâu?",
    ],
    promptsEn: [
      "How do I check OCR and voice workers?",
      "How does tiered AI routing work?",
      "Where are admin audit logs?",
    ],
    actions: [
      {
        labelVi: "Nhật ký",
        labelEn: "Audit Logs",
        href: "/admin/audit-logs",
      },
      {
        labelVi: "Mô hình đọc chữ",
        labelEn: "OCR Training",
        href: "/admin/viread-training",
      },
    ],
  },
  {
    prefix: "/admin/metadata-quality",
    titleVi: "Chất lượng sách",
    titleEn: "Book Quality Hub",
    greetingVi:
      "Cần hướng dẫn duyệt Child Safety, lỗi chính tả hay báo cáo từ phụ huynh?",
    greetingEn:
      "Need help reviewing Child Safety, text findings, or parent reports?",
    promptsVi: [
      "Điều kiện phê duyệt sách an toàn trẻ em?",
      "Xử lý báo lỗi trang sách từ phụ huynh?",
      "Cách duyệt revision OCR thành VERIFIED?",
    ],
    promptsEn: [
      "What is required to approve a book?",
      "How do I resolve parent page reports?",
      "How do I verify an OCR revision?",
    ],
    actions: [
      { labelVi: "Mở Kho sách", labelEn: "Open Books", href: "/admin/books" },
      {
        labelVi: "Nhật ký",
        labelEn: "Audit Logs",
        href: "/admin/audit-logs",
      },
    ],
  },
  {
    prefix: "/admin/books",
    titleVi: "Kho sách Quản trị",
    titleEn: "Admin Books Catalog",
    greetingVi:
      "Tạo sách mới, rà soát OCR Gemini vs Ollama Qwen3-VL / VietOCR và duyệt VERIFIED.",
    greetingEn:
      "Create books, review Gemini vs Ollama Qwen3-VL / VietOCR pages, and verify revisions.",
    promptsVi: [
      "Quy trình tạo sách mới và duyệt OCR VERIFIED?",
      "So sánh kết quả OCR giữa Gemini và Ollama Qwen3-VL?",
      "Điều kiện kiểm duyệt Child Safety trước khi xuất bản?",
    ],
    promptsEn: [
      "How do I create a book and mark OCR VERIFIED?",
      "How does Gemini vs Ollama Qwen3-VL OCR review work?",
      "What are the Child Safety approval rules?",
    ],
    actions: [
      {
        labelVi: "Thêm sách mới",
        labelEn: "New Book",
        href: "/admin/books/new",
      },
      {
        labelVi: "Chất lượng sách",
        labelEn: "Book Quality",
        href: "/admin/metadata-quality",
      },
    ],
  },
  {
    prefix: "/admin/karaoke",
    titleVi: "Quản lý Karaoke",
    titleEn: "Admin Karaoke",
    greetingVi:
      "Quản lý bài đồng dao thiếu nhi, tệp audio và đồng bộ lời LRC theo nhịp.",
    greetingEn:
      "Manage kids karaoke songs, audio tracks, and synchronized LRC lyrics.",
    promptsVi: [
      "Cách thêm bài Karaoke đồng dao mới?",
      "Chuẩn đồng bộ lời LRC và âm thanh thế nào?",
      "Kiểm tra tác vụ xử lý Karaoke ở đâu?",
    ],
    promptsEn: [
      "How do I add a new Karaoke song?",
      "How should LRC lyrics and audio be synced?",
      "Where do I track Karaoke processing tasks?",
    ],
    actions: [
      {
        labelVi: "Thêm bài Karaoke",
        labelEn: "New Karaoke",
        href: "/admin/karaoke/new",
      },
      { labelVi: "Tác vụ nền", labelEn: "Admin Tasks", href: "/admin/tasks" },
    ],
  },
  {
    prefix: "/admin/parents",
    titleVi: "Quản lý Phụ huynh",
    titleEn: "Parent Accounts",
    greetingVi:
      "Theo dõi tài khoản phụ huynh, trạng thái xác minh và phạm vi hỗ trợ quản trị.",
    greetingEn:
      "Review parent account status, verification state, and admin operations.",
    promptsVi: [
      "Quản trị viên xem thông tin phụ huynh ở mức nào?",
      "Xem lịch sử thao tác quản trị trên tài khoản ở đâu?",
      "Kiểm tra sức khỏe dịch vụ xác thực ở đâu?",
    ],
    promptsEn: [
      "What parent account details are visible to admins?",
      "Where are admin actions on accounts logged?",
      "Where do I check system service health?",
    ],
    actions: [
      {
        labelVi: "Nhật ký",
        labelEn: "Audit Logs",
        href: "/admin/audit-logs",
      },
      { labelVi: "Vận hành", labelEn: "Health", href: "/admin/health" },
    ],
  },
  {
    prefix: "/admin/tasks",
    titleVi: "Tác vụ nền Quản trị",
    titleEn: "Admin Tasks",
    greetingVi:
      "Giám sát hàng đợi OCR, sinh giọng đọc, xử lý karaoke và tác vụ AI nền.",
    greetingEn:
      "Monitor background OCR queues, TTS audio builds, and admin AI jobs.",
    promptsVi: [
      "Cách theo dõi tác vụ OCR và TTS đang chạy?",
      "Khi tác vụ nền lỗi thì kiểm tra ở đâu?",
      "Xem nhật ký kiểm toán tác vụ ở đâu?",
    ],
    promptsEn: [
      "How do I monitor running OCR and TTS jobs?",
      "Where do I inspect failed worker health?",
      "Where are admin task audit logs?",
    ],
    actions: [
      { labelVi: "Vận hành", labelEn: "Health", href: "/admin/health" },
      { labelVi: "Kho sách", labelEn: "Books", href: "/admin/books" },
    ],
  },
  {
    prefix: "/admin/audit-logs",
    titleVi: "Nhật ký Kiểm toán",
    titleEn: "Admin Audit Logs",
    greetingVi:
      "Tra cứu lịch sử duyệt sách, thay đổi cấu hình, huấn luyện OCR và thao tác quản trị.",
    greetingEn:
      "Inspect immutable logs of book approvals, config updates, and admin actions.",
    promptsVi: [
      "Nhật ký kiểm toán ghi lại những hành động nào?",
      "Cách đối chiếu sự cố hệ thống với nhật ký?",
      "Mở trang Chất lượng sách để xem báo cáo?",
    ],
    promptsEn: [
      "Which actions are recorded in audit logs?",
      "How do I correlate logs with system health?",
      "Where do I review book quality reports?",
    ],
    actions: [
      { labelVi: "Vận hành", labelEn: "Health", href: "/admin/health" },
      { labelVi: "Phụ huynh", labelEn: "Parents", href: "/admin/parents" },
    ],
  },
  {
    prefix: "/admin",
    titleVi: "Khu vực Quản trị",
    titleEn: "Admin Workspace",
    greetingVi:
      "Xin chào Quản trị viên! Hỏi nhanh về kho sách, OCR, chất lượng, karaoke hay vận hành.",
    greetingEn:
      "Hello Admin! Ask about catalog books, OCR review, quality, karaoke, or operations.",
    promptsVi: [
      "Quy trình tạo sách và duyệt OCR VERIFIED?",
      "Kiểm tra Child Safety và bản quyền sách?",
      "Xem trạng thái vận hành hệ thống?",
    ],
    promptsEn: [
      "How do I upload and verify book OCR?",
      "How do Child Safety & rights checks work?",
      "Where is system health monitoring?",
    ],
    actions: [
      { labelVi: "Kho sách", labelEn: "Books", href: "/admin/books" },
      { labelVi: "Vận hành", labelEn: "Health", href: "/admin/health" },
    ],
  },
  {
    prefix: "/achievements",
    titleVi: "Vườn Âm Vị & Huy hiệu",
    titleEn: "Phoneme Garden & Badges",
    greetingVi:
      "Theo dõi hoa âm vị tiếng Việt bé đã nở và bộ sưu tập huy hiệu rèn luyện!",
    greetingEn:
      "Explore your child's blooming Vietnamese phonemes and earned achievement badges!",
    promptsVi: [
      "Vườn Âm Vị giúp bé luyện những gì?",
      "Cách mở khóa thêm huy hiệu cho bé?",
      "Chuyến Tàu Đọc 5 Phút hoạt động thế nào?",
    ],
    promptsEn: [
      "What does the Phoneme Garden track?",
      "How does my child unlock more badges?",
      "How does the 5-Minute Reading Train work?",
    ],
    actions: [
      {
        labelVi: "Tàu Đọc 5 Phút",
        labelEn: "5-Min Train",
        href: "/learning-train",
      },
      { labelVi: "Xem Tiến bộ", labelEn: "Progress", href: "/reports" },
    ],
  },
  {
    prefix: "/learning-train",
    titleVi: "Chuyến Tàu Đọc 5 Phút",
    titleEn: "5-Minute Reading Train",
    greetingVi:
      "Luyện đọc nhanh 5 phút mỗi ngày với lộ trình ngắn gọn vừa sức cho bé!",
    greetingEn:
      "Complete a focused 5-minute daily reading loop tailored to your child!",
    promptsVi: [
      "Chuyến Tàu Đọc 5 Phút gồm những chặng nào?",
      "Cần chọn hồ sơ bé trước khi lên tàu không?",
      "Xem huy hiệu bé đạt được ở đâu?",
    ],
    promptsEn: [
      "What steps are inside the 5-Minute Reading Train?",
      "Do I need a selected child profile first?",
      "Where can I view earned badges?",
    ],
    actions: [
      {
        labelVi: "Vườn Âm Vị",
        labelEn: "Phoneme Garden",
        href: "/achievements",
      },
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
    ],
  },
  {
    prefix: "/reading-management",
    titleVi: "Quản lý đọc",
    titleEn: "Reading Management",
    greetingVi:
      "Hỏi tôi cách đặt mục tiêu tuần, lịch email nhắc đọc, Reading Presence Email và sách đã lưu.",
    greetingEn:
      "Ask about weekly goals, reminder schedules, Reading Presence Emails, and bookmarks.",
    promptsVi: [
      "Cách đặt lịch email nhắc đọc cho bé?",
      "Email thông báo buổi đọc (Reading Presence) hoạt động ra sao?",
      "Tại sao chưa nhận được email nhắc đọc?",
    ],
    promptsEn: [
      "How do I schedule email reminders?",
      "How do Reading Presence Emails work?",
      "Why didn't I receive reminder emails?",
    ],
    actions: [
      { labelVi: "Xem Tiến bộ", labelEn: "Progress", href: "/reports" },
      { labelVi: "Chọn sách", labelEn: "Books", href: "/books" },
    ],
  },
  {
    prefix: "/reading-preparation",
    titleVi: "Chuẩn bị buổi đọc",
    titleEn: "Reading Preparation",
    greetingVi:
      "Sẵn sàng đọc sách! Hỏi về chọn trang, kiểm tra micro, đọc đôi Duet hoặc Đếm ngược đọc ngay.",
    greetingEn:
      "Ready to read! Ask about page range, mic test, Duet Reading, or Instant Countdown.",
    promptsVi: [
      "Chế độ đọc đôi (Duet Reading) hoạt động thế nào?",
      "Giọng cô giáo AI và WASM ngoại tuyến có gì hay?",
      "Kiểm tra micro trước khi bé đọc?",
    ],
    promptsEn: [
      "How does Duet Reading work?",
      "How do AI Teacher Voice and offline WASM work?",
      "How do I test the mic before reading?",
    ],
    actions: [
      { labelVi: "Chọn sách", labelEn: "Books", href: "/books" },
      {
        labelVi: "Trợ giúp & hỗ trợ",
        labelEn: "Help & Support",
        href: "/help-support",
      },
    ],
  },
  {
    prefix: "/reading",
    titleVi: "Buổi đọc cùng bé",
    titleEn: "Reading Session",
    greetingVi:
      "Khung gọn nhẹ để bé tập trung đọc. Hỏi nhanh về micro, đọc đôi Duet hoặc giọng mẫu!",
    greetingEn:
      "Compact guide so your child stays focused. Need help with mic, Duet mode, or voice?",
    promptsVi: [
      "Micro không nhận giọng bé phải làm sao?",
      "Cách đổi giọng cô giáo AI hoặc tốc độ 0.85x?",
      "Từ bé đọc nhầm sẽ lưu ở đâu?",
    ],
    promptsEn: [
      "Mic isn't picking up my child's voice",
      "How do I adjust AI Teacher Voice or 0.85x speed?",
      "Where are missed words saved?",
    ],
    actions: [
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
      {
        labelVi: "Từ cần luyện",
        labelEn: "Difficult Words",
        href: "/reports/difficult-words",
      },
    ],
  },
  {
    prefix: "/book-scanner",
    titleVi: "Quét sách giấy",
    titleEn: "Book Scanner",
    greetingVi:
      "Cần mẹo chụp trang sách rõ chữ hay tìm hiểu về hàng chờ OCR ngoại tuyến?",
    greetingEn:
      "Want tips for sharp page scans or info on the offline OCR queue?",
    promptsVi: [
      "Mẹo chụp trang sách để OCR chuẩn nhất?",
      "Hàng chờ OCR ngoại tuyến hoạt động thế nào?",
      "Camera không mở được thì xử lý sao?",
    ],
    promptsEn: [
      "Tips for the sharpest OCR page scan?",
      "How does the offline OCR queue work?",
      "Camera won't open — how do I fix it?",
    ],
    actions: [
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
    ],
  },
  {
    prefix: "/my-books",
    titleVi: "Sách của tôi",
    titleEn: "My Books",
    greetingVi:
      "Tạo truyện Family StoryWeaver, tải sách ảnh/PDF/DOCX gia đình hoặc chỉnh sửa OCR.",
    greetingEn:
      "Create Family StoryWeaver books, upload images/PDF/DOCX, or refine OCR scans.",
    promptsVi: [
      "Family StoryWeaver tạo truyện riêng cho bé thế nào?",
      "Cách tải sách riêng từ ảnh hoặc PDF?",
      "Hàng chờ OCR ngoại tuyến hoạt động ra sao?",
    ],
    promptsEn: [
      "How does Family StoryWeaver create custom stories?",
      "How do I upload a book from images or PDF?",
      "How does the offline OCR queue work?",
    ],
    actions: [
      { labelVi: "Quét sách", labelEn: "Book Scanner", href: "/book-scanner" },
      { labelVi: "Tác vụ AI", labelEn: "AI Tasks", href: "/studio/tasks" },
    ],
  },
  {
    prefix: "/reports/difficult-words",
    titleVi: "Từ cần luyện",
    titleEn: "Difficult Words",
    greetingVi:
      "Cần hướng dẫn giúp bé ôn phát âm các từ khó bằng giọng mẫu và micro tự động?",
    greetingEn:
      "Need tips for practicing tricky words with audio playback and auto-mic?",
    promptsVi: [
      "Cách luyện phát âm từ khó cho bé?",
      "Micro không nhận giọng bé khi luyện từ?",
      "Xem báo cáo tiến bộ tổng hợp ở đâu?",
    ],
    promptsEn: [
      "How do we practice difficult words?",
      "Mic isn't hearing my child during practice",
      "Where is the full progress report?",
    ],
    actions: [
      { labelVi: "Xem Tiến bộ", labelEn: "Progress", href: "/reports" },
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
    ],
  },
  {
    prefix: "/reports",
    titleVi: "Báo cáo tiến bộ",
    titleEn: "Progress Reports",
    greetingVi:
      "Tôi có thể giải thích 4 chỉ số đọc, Chứng nhận cột mốc và cách ôn từ khó cho bé.",
    greetingEn:
      "I can explain the 4 reading metrics, Milestone Certificates, and word practice.",
    promptsVi: [
      "4 chỉ số tiến bộ của bé có ý nghĩa gì?",
      "Chứng nhận cột mốc (Milestone Certificate) nhận thế nào?",
      "Cách ôn luyện các từ bé hay đọc nhầm?",
    ],
    promptsEn: [
      "What do the 4 progress metrics mean?",
      "How do Milestone Certificates work?",
      "How do we practice missed words?",
    ],
    actions: [
      {
        labelVi: "Từ cần luyện",
        labelEn: "Difficult Words",
        href: "/reports/difficult-words",
      },
      { labelVi: "Vườn Âm Vị", labelEn: "Achievements", href: "/achievements" },
    ],
  },
  {
    prefix: "/entertainment/memory-game",
    titleVi: "Memory Game lật thẻ",
    titleEn: "Memory Card Game",
    greetingVi:
      "Giúp bé lật cặp thẻ chữ/hình để rèn trí nhớ từ vựng và phản xạ mặt chữ!",
    greetingEn:
      "Match card pairs to build Vietnamese word recall and reading focus!",
    promptsVi: [
      "Memory game lật thẻ ở đâu và chơi thế nào?",
      "Còn trò chơi nào khác trong Góc giải trí?",
      "Cách chọn sách và bắt đầu buổi đọc?",
    ],
    promptsEn: [
      "How do I play Memory Game?",
      "What other games are in Entertainment?",
      "How do I start a reading session?",
    ],
    actions: [
      {
        labelVi: "Góc giải trí",
        labelEn: "Entertainment",
        href: "/entertainment",
      },
      { labelVi: "Kho sách", labelEn: "Books", href: "/books" },
    ],
  },
  {
    prefix: "/entertainment/sentence-shooter",
    titleVi: "Trò chơi Ghép câu",
    titleEn: "Sentence Shooter",
    greetingVi:
      "Giúp bé ghép cụm từ thành câu tiếng Việt hoàn chỉnh, tăng phản xạ đọc nhanh!",
    greetingEn:
      "Help your child assemble Vietnamese phrases into complete sentences!",
    promptsVi: [
      "Trò chơi Ghép câu luyện kỹ năng gì cho bé?",
      "Còn trò chơi nào khác trong Góc giải trí?",
      "Cách chuyển hồ sơ bé khi chơi?",
    ],
    promptsEn: [
      "What skills does Sentence Shooter build?",
      "What other games are in Entertainment?",
      "How do I switch child profiles while playing?",
    ],
    actions: [
      {
        labelVi: "Góc giải trí",
        labelEn: "Entertainment",
        href: "/entertainment",
      },
      {
        labelVi: "Memory Game",
        labelEn: "Memory Game",
        href: "/entertainment/memory-game",
      },
    ],
  },
  {
    prefix: "/entertainment/picture-description",
    titleVi: "Mô tả tranh AI",
    titleEn: "AI Picture Description",
    greetingVi:
      "Khuyến khích bé quan sát tranh và kể lại bằng lời nói để AI gợi ý từ vựng hay!",
    greetingEn:
      "Encourage your child to describe illustrations aloud with gentle AI feedback!",
    promptsVi: [
      "Trò chơi Mô tả tranh AI hoạt động thế nào?",
      "Micro không nhận giọng khi chơi trò chơi?",
      "Cách mở Vườn Âm Vị xem huy hiệu của bé?",
    ],
    promptsEn: [
      "How does AI Picture Description work?",
      "Mic not working during the game?",
      "How do I open Phoneme Garden badges?",
    ],
    actions: [
      {
        labelVi: "Góc giải trí",
        labelEn: "Entertainment",
        href: "/entertainment",
      },
      { labelVi: "Vườn Âm Vị", labelEn: "Achievements", href: "/achievements" },
    ],
  },
  {
    prefix: "/entertainment",
    titleVi: "Góc giải trí",
    titleEn: "Entertainment",
    greetingVi:
      "Khám phá Karaoke đồng dao, Memory Game, Ghép câu và Mô tả tranh AI cùng bé!",
    greetingEn:
      "Explore Kids Karaoke, Memory Game, Sentence Shooter, and AI Picture Description!",
    promptsVi: [
      "Trò chơi Mô tả tranh AI hoạt động thế nào?",
      "Karaoke đồng dao và Ghép câu giúp bé luyện gì?",
      "Micro không nhận giọng khi chơi trò chơi?",
    ],
    promptsEn: [
      "How does AI Picture Description work?",
      "What skills do Karaoke & Sentence Shooter train?",
      "Mic not working during games?",
    ],
    actions: [
      { labelVi: "Mở Karaoke", labelEn: "Karaoke", href: "/karaoke" },
      {
        labelVi: "Mô tả tranh",
        labelEn: "Picture Description",
        href: "/entertainment/picture-description",
      },
    ],
  },
  {
    prefix: "/karaoke",
    titleVi: "Karaoke đồng dao thiếu nhi",
    titleEn: "Kids Karaoke",
    greetingVi:
      "Bé tập đọc theo nhịp điệu đồng dao với lời chạy chuẩn thời gian và âm thanh vui nhộn!",
    greetingEn:
      "Practice Vietnamese rhythm and pronunciation with synced children's karaoke lyrics!",
    promptsVi: [
      "Karaoke đồng dao giúp bé luyện đọc thế nào?",
      "Còn trò chơi ngôn ngữ nào khác không?",
      "Không nghe âm thanh hoặc micro bị lỗi?",
    ],
    promptsEn: [
      "How does Kids Karaoke help reading?",
      "What other language games are there?",
      "Audio or microphone not working?",
    ],
    actions: [
      {
        labelVi: "Góc giải trí",
        labelEn: "Entertainment",
        href: "/entertainment",
      },
      {
        labelVi: "Tàu Đọc 5 Phút",
        labelEn: "5-Min Train",
        href: "/learning-train",
      },
    ],
  },
  {
    prefix: "/login",
    titleVi: "Đăng nhập ViRead",
    titleEn: "Sign in to ViRead",
    greetingVi:
      "Chào mừng đến ViRead! Hỏi nhanh về đăng nhập, đăng ký hay quên mật khẩu.",
    greetingEn:
      "Welcome to ViRead! Ask about signing in, registering, or resetting a password.",
    promptsVi: [
      "ViRead có những tính năng gì cho bé?",
      "Quên mật khẩu thì khôi phục thế nào?",
      "Không nhận được email xác nhận tài khoản?",
    ],
    promptsEn: [
      "What features does ViRead offer?",
      "How do I reset a forgotten password?",
      "Didn't receive the confirmation email?",
    ],
    actions: [
      { labelVi: "Đăng ký", labelEn: "Register", href: "/register" },
      {
        labelVi: "Quên mật khẩu",
        labelEn: "Forgot password",
        href: "/forgot-password",
      },
    ],
  },
  {
    prefix: "/register",
    titleVi: "Đăng ký ViRead",
    titleEn: "Register for ViRead",
    greetingVi:
      "Cần hỗ trợ tạo tài khoản phụ huynh hoặc xác minh email ViRead?",
    greetingEn:
      "Need help creating your parent account or verifying your email?",
    promptsVi: [
      "Cách xác minh email sau khi đăng ký?",
      "Sau khi đăng ký tôi cần làm bước gì tiếp?",
      "ViRead phù hợp cho bé lớp mấy?",
    ],
    promptsEn: [
      "How do I verify my email after sign-up?",
      "What should I do after signing up?",
      "Which grade levels is ViRead built for?",
    ],
    actions: [{ labelVi: "Đăng nhập", labelEn: "Sign in", href: "/login" }],
  },
  {
    prefix: "/forgot-password",
    titleVi: "Quên mật khẩu",
    titleEn: "Forgot Password",
    greetingVi:
      "Nhập email đã đăng ký để nhận liên kết khôi phục mật khẩu trên cùng trình duyệt nhé.",
    greetingEn:
      "Enter your registered email to receive a password recovery link in the same browser.",
    promptsVi: [
      "Quên mật khẩu thì khôi phục thế nào?",
      "Không nhận được email xác nhận tài khoản?",
      "ViRead có những chức năng gì?",
    ],
    promptsEn: [
      "How do I reset a forgotten password?",
      "Didn't receive the confirmation email?",
      "What features does ViRead offer?",
    ],
    actions: [{ labelVi: "Đăng nhập", labelEn: "Sign in", href: "/login" }],
  },
  {
    prefix: "/reset-password",
    titleVi: "Đặt lại mật khẩu",
    titleEn: "Reset Password",
    greetingVi:
      "Mở liên kết đặt lại mật khẩu trên cùng trình duyệt vừa yêu cầu để hoàn tất an toàn.",
    greetingEn:
      "Open the reset link in the same browser where you requested it to finish securely.",
    promptsVi: [
      "Liên kết đặt lại mật khẩu hết hạn thì làm sao?",
      "Làm sao đổi mật khẩu sau khi đăng nhập?",
      "ViRead có những chức năng gì?",
    ],
    promptsEn: [
      "What if my reset link expired?",
      "How do I change my password after signing in?",
      "What features does ViRead offer?",
    ],
    actions: [
      {
        labelVi: "Gửi lại liên kết",
        labelEn: "Forgot password",
        href: "/forgot-password",
      },
      { labelVi: "Đăng nhập", labelEn: "Sign in", href: "/login" },
    ],
  },
  {
    prefix: "/studio/tasks",
    titleVi: "Trung tâm tác vụ AI",
    titleEn: "AI Task Center",
    greetingVi:
      "Theo dõi tiến trình quét OCR, tạo truyện StoryWeaver, ảnh minh họa và audio của bạn.",
    greetingEn:
      "Monitor your own OCR scans, StoryWeaver jobs, AI art, and audio tasks here.",
    promptsVi: [
      "Làm sao xem sách tôi vừa quét xong?",
      "Smart Studio tạo ảnh bìa và minh họa thế nào?",
      "Làm sao bắt đầu buổi đọc cho bé?",
    ],
    promptsEn: [
      "Where are my newly scanned books?",
      "How does Smart Studio create covers & art?",
      "How do I start a reading session?",
    ],
    actions: [
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
      { labelVi: "Quét sách", labelEn: "Book Scanner", href: "/book-scanner" },
    ],
  },
  {
    prefix: "/books",
    titleVi: "Kho sách ViRead",
    titleEn: "ViRead Book Library",
    greetingVi:
      "Chọn sách theo Nhãn độ khó lớp 1–5 hoặc tải sách gia đình tại Sách của tôi.",
    greetingEn:
      "Pick books by Grade 1–5 Readability Badge or upload family books in My Books.",
    promptsVi: [
      "Nhãn độ khó đọc (Readability Badge) giúp chọn sách thế nào?",
      "Cách chọn sách và bắt đầu buổi đọc?",
      "Làm sao báo lỗi chữ sai trong sách?",
    ],
    promptsEn: [
      "How does the Readability Badge help pick books?",
      "How do I pick a book and start reading?",
      "How do I report a typo in a book?",
    ],
    actions: [
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
      { labelVi: "Quét sách", labelEn: "Book Scanner", href: "/book-scanner" },
    ],
  },
  {
    prefix: "/children",
    titleVi: "Hồ sơ bé",
    titleEn: "Child Profiles",
    greetingVi:
      "Quản lý hồ sơ từng bé theo lớp 1–5 để lưu riêng tủ sách, huy hiệu, báo cáo và từ cần luyện.",
    greetingEn:
      "Manage Grade 1–5 child profiles with separate bookshelves, badges, and reports.",
    promptsVi: [
      "Làm sao tạo hồ sơ bé?",
      "Cách chuyển nhanh giữa các hồ sơ bé?",
      "Cách bắt đầu buổi đọc đầu tiên?",
    ],
    promptsEn: [
      "How do I create a child profile?",
      "How do I switch between child profiles?",
      "How do I start a reading session?",
    ],
    actions: [
      {
        labelVi: "Tạo hồ sơ bé",
        labelEn: "Create Child Profile",
        href: "/children/new",
      },
      { labelVi: "Tổng quan", labelEn: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    prefix: "/profile",
    titleVi: "Hồ sơ ba mẹ",
    titleEn: "Parent Profile",
    greetingVi:
      "Cập nhật tên hiển thị, số điện thoại, ảnh đại diện hoặc đổi email xác minh tại đây.",
    greetingEn:
      "Update your display name, contact phone, avatar, or verified email here.",
    promptsVi: [
      "Cách cập nhật hồ sơ ba mẹ và đổi email?",
      "Làm sao đổi mật khẩu tài khoản?",
      "Cách đổi ngôn ngữ giao diện ViRead?",
    ],
    promptsEn: [
      "How do I edit my parent profile or email?",
      "How do I change my password?",
      "How do I switch the interface language?",
    ],
    actions: [
      { labelVi: "Cài đặt", labelEn: "Settings", href: "/settings" },
      { labelVi: "Hồ sơ bé", labelEn: "Child Profiles", href: "/children" },
    ],
  },
  {
    prefix: "/settings",
    titleVi: "Cài đặt tài khoản",
    titleEn: "Account Settings",
    greetingVi:
      "Đổi mật khẩu, thiết lập Mã PIN phụ huynh 4 số, giọng đọc mẫu và tiết kiệm băng thông.",
    greetingEn:
      "Change password, configure the 4-digit Parent PIN Lock, model voice, and bandwidth.",
    promptsVi: [
      "Mã PIN phụ huynh 4 số dùng để khóa những trang nào?",
      "Làm sao đổi mật khẩu tài khoản?",
      "Cách đổi giọng cô giáo AI và bật WASM ngoại tuyến?",
    ],
    promptsEn: [
      "What does the 4-digit Parent PIN Lock protect?",
      "How do I change my password?",
      "How do I change AI Teacher Voice & offline WASM?",
    ],
    actions: [
      { labelVi: "Hồ sơ ba mẹ", labelEn: "Parent Profile", href: "/profile" },
      {
        labelVi: "Trợ giúp & hỗ trợ",
        labelEn: "Help & Support",
        href: "/help-support",
      },
    ],
  },
  {
    prefix: "/sessions",
    titleVi: "Lịch sử buổi đọc",
    titleEn: "Reading History",
    greetingVi:
      "Xem lại buổi đọc đã hoàn thành, điểm đọc hiểu, Chứng nhận cột mốc và từ cần ôn.",
    greetingEn:
      "Review completed sessions, comprehension scores, Milestone Certificates, and words.",
    promptsVi: [
      "Báo cáo chi tiết buổi đọc gồm những gì?",
      "Câu hỏi đọc hiểu AI Tutor hoạt động thế nào?",
      "Cách ôn lại các từ bé đọc nhầm?",
    ],
    promptsEn: [
      "What is shown in a session report?",
      "How does the AI Tutor comprehension quiz work?",
      "How do we practice missed words?",
    ],
    actions: [
      { labelVi: "Xem Tiến bộ", labelEn: "Progress", href: "/reports" },
      {
        labelVi: "Từ cần luyện",
        labelEn: "Difficult Words",
        href: "/reports/difficult-words",
      },
    ],
  },
  {
    prefix: "/device-permissions",
    titleVi: "Kiểm tra Micro & Camera",
    titleEn: "Mic & Camera Check",
    greetingVi:
      "Kiểm tra nhanh quyền Micro và phạm vi trang ngay tại Chuẩn bị buổi đọc (/reading-preparation) sau khi chọn hồ sơ bé.",
    greetingEn:
      "Check Microphone permissions and page range directly in Reading Preparation (/reading-preparation) after selecting a child profile.",
    promptsVi: [
      "Micro không nhận giọng bé phải làm sao?",
      "Camera không mở được khi quét sách?",
      "Vì sao cần chọn hồ sơ bé trước khi đọc?",
    ],
    promptsEn: [
      "Mic isn't picking up my child's voice",
      "Camera won't open in Book Scanner",
      "Why do I need to select a child profile first?",
    ],
    actions: [
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
      { labelVi: "Tổng quan", labelEn: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    prefix: "/help-support",
    titleVi: "Trợ giúp & hỗ trợ",
    titleEn: "Help & Support",
    greetingVi:
      "Cần hỏi nhanh về tính năng ViRead, ứng dụng Android APK, báo lỗi sách hay gửi phản hồi?",
    greetingEn:
      "Need quick help with ViRead features, Android APK, book reports, or support?",
    promptsVi: [
      "Cách gửi phản hồi hoặc báo lỗi kỹ thuật?",
      "Làm sao báo lỗi chữ sai trong sách?",
      "ViRead có ứng dụng Android APK và chạy ngoại tuyến không?",
    ],
    promptsEn: [
      "How do I send support feedback?",
      "How do I report a typo in a book?",
      "Does ViRead have an Android APK & offline mode?",
    ],
    actions: [
      {
        labelVi: "Báo cáo sách",
        labelEn: "Book Reports",
        href: "/book-reports",
      },
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
    ],
  },
  {
    prefix: "/book-reports",
    titleVi: "Báo cáo sách",
    titleEn: "Book Reports",
    greetingVi:
      "Theo dõi trạng thái xử lý các báo lỗi chữ hoặc trang sách bạn đã gửi.",
    greetingEn:
      "Track the review status of book typos and page issues you reported.",
    promptsVi: [
      "Làm sao báo lỗi chữ sai trong sách?",
      "Cách gửi phản hồi cho đội ngũ ViRead?",
      "Cách chọn sách và bắt đầu buổi đọc?",
    ],
    promptsEn: [
      "How do I report a typo in a book?",
      "How do I contact ViRead support?",
      "How do I browse library books?",
    ],
    actions: [
      { labelVi: "Kho sách", labelEn: "Books", href: "/books" },
      {
        labelVi: "Trợ giúp & hỗ trợ",
        labelEn: "Help & Support",
        href: "/help-support",
      },
    ],
  },
  {
    prefix: "/dashboard",
    titleVi: "Tổng quan gia đình",
    titleEn: "Family Dashboard",
    greetingVi:
      "Xin chào ba mẹ! Tôi hỗ trợ mọi thao tác trong ViRead — chọn gợi ý hoặc hỏi ngay.",
    greetingEn:
      "Hi! I support everything in ViRead — tap a quick tip or ask any question.",
    promptsVi: [
      "Cách bắt đầu buổi đọc đầu tiên cho bé?",
      "Làm sao quét sách giấy bằng camera?",
      "Cách xem tiến bộ và ôn từ cần luyện?",
    ],
    promptsEn: [
      "How do I start our first reading session?",
      "How do I scan a paper book?",
      "How do I view progress & difficult words?",
    ],
    actions: [
      { labelVi: "Chọn sách", labelEn: "Books", href: "/books" },
      { labelVi: "Quét sách", labelEn: "Scanner", href: "/book-scanner" },
      { labelVi: "Tiến bộ", labelEn: "Progress", href: "/reports" },
    ],
  },
];

const DEFAULT_GUIDE_VI: ResolvedPageGuide = {
  title: "Trợ lý ViRead",
  greeting:
    "Xin chào! Hỏi tôi bất kỳ tính năng nào trong ViRead — trả lời nhanh theo băng tần của bạn.",
  prompts: [
    "ViRead có những chức năng gì?",
    "Cách bắt đầu buổi đọc cho bé?",
    "Khắc phục lỗi micro và camera?",
  ],
  actions: [
    { label: "Về Tổng quan", href: "/dashboard" },
    { label: "Trợ giúp & hỗ trợ", href: "/help-support" },
  ],
};

const DEFAULT_GUIDE_EN: ResolvedPageGuide = {
  title: "ViRead Assistant",
  greeting:
    "Hi! Ask me anything about ViRead — fast, bandwidth-aware guidance on every page.",
  prompts: [
    "What features does ViRead offer?",
    "How do I start a reading session?",
    "How do I fix mic and camera permissions?",
  ],
  actions: [
    { label: "Dashboard", href: "/dashboard" },
    { label: "Help & Support", href: "/help-support" },
  ],
};

const DEFAULT_PUBLIC_GUIDE_VI: ResolvedPageGuide = {
  title: "Trợ lý ViRead",
  greeting:
    "Chào mừng đến ViRead! Hỏi nhanh về tính năng đọc tiếng Việt lớp 1–5, đăng nhập hoặc đăng ký.",
  prompts: [
    "ViRead có những tính năng gì cho bé?",
    "Cách đăng ký và xác minh tài khoản?",
    "Quên mật khẩu thì khôi phục thế nào?",
  ],
  actions: [
    { label: "Đăng nhập", href: "/login" },
    { label: "Đăng ký", href: "/register" },
  ],
};

const DEFAULT_PUBLIC_GUIDE_EN: ResolvedPageGuide = {
  title: "ViRead Assistant",
  greeting:
    "Welcome to ViRead! Ask about Grade 1–5 Vietnamese reading features, sign-in, or registration.",
  prompts: [
    "What features does ViRead offer?",
    "How do I sign up and verify my email?",
    "How do I reset a forgotten password?",
  ],
  actions: [
    { label: "Sign in", href: "/login" },
    { label: "Register", href: "/register" },
  ],
};

const DEFAULT_ADMIN_GUIDE_VI: ResolvedPageGuide = {
  title: "Khu vực Quản trị",
  greeting:
    "Xin chào Quản trị viên! Hỏi nhanh về kho sách, OCR, chất lượng sách, karaoke hay vận hành.",
  prompts: [
    "Quy trình tạo sách và duyệt OCR VERIFIED?",
    "Kiểm tra Child Safety và bản quyền sách?",
    "Xem trạng thái vận hành hệ thống?",
  ],
  actions: [
    { label: "Kho sách", href: "/admin/books" },
    { label: "Vận hành", href: "/admin/health" },
  ],
};

const DEFAULT_ADMIN_GUIDE_EN: ResolvedPageGuide = {
  title: "Admin Workspace",
  greeting:
    "Hello Admin! Ask about catalog books, OCR review, book quality, karaoke, or operations.",
  prompts: [
    "How do I upload and verify book OCR?",
    "How do Child Safety & rights checks work?",
    "Where is system health monitoring?",
  ],
  actions: [
    { label: "Books", href: "/admin/books" },
    { label: "Health", href: "/admin/health" },
  ],
};

export {
  hasMobileBottomNavPath,
  isAdminPath,
  isAuthPath,
  isReadingSessionPath,
};

function filterGuideActions(
  actions: readonly AssistantQuickAction[],
  pathname: string,
  roleScope: AssistantRoleScope,
): AssistantQuickAction[] {
  return actions.filter((item) =>
    isSafeAssistantQuickActionHref(item.href, pathname, roleScope),
  );
}

export function resolvePageGuide(
  pathname: string,
  locale: string,
): ResolvedPageGuide {
  const clean = pathname && pathname.startsWith("/") ? pathname : "/";
  const useEn = !locale.toLowerCase().startsWith("vi");
  const roleScope = inferAssistantRoleScope(clean);

  const matched = PAGE_GUIDES.find(
    (entry) => clean === entry.prefix || clean.startsWith(`${entry.prefix}/`),
  );

  if (!matched) {
    const fallbackBase =
      roleScope === "public"
        ? useEn
          ? DEFAULT_PUBLIC_GUIDE_EN
          : DEFAULT_PUBLIC_GUIDE_VI
        : roleScope === "admin"
          ? useEn
            ? DEFAULT_ADMIN_GUIDE_EN
            : DEFAULT_ADMIN_GUIDE_VI
          : useEn
            ? DEFAULT_GUIDE_EN
            : DEFAULT_GUIDE_VI;
    return {
      ...fallbackBase,
      actions: filterGuideActions(fallbackBase.actions, clean, roleScope),
    };
  }

  return {
    title: useEn ? matched.titleEn : matched.titleVi,
    greeting: useEn ? matched.greetingEn : matched.greetingVi,
    prompts: useEn ? matched.promptsEn : matched.promptsVi,
    actions: filterGuideActions(
      matched.actions.map((item) => ({
        label: useEn ? item.labelEn : item.labelVi,
        href: item.href,
      })),
      clean,
      roleScope,
    ),
  };
}

interface NavigatorConnectionLike {
  readonly effectiveType?: string;
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export function getNavigatorConnection(): NavigatorConnectionLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const nav = navigator as Navigator & {
    connection?: NavigatorConnectionLike;
    mozConnection?: NavigatorConnectionLike;
    webkitConnection?: NavigatorConnectionLike;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
}

export function detectNetworkBandwidth(): DetectedNetworkInfo {
  if (typeof navigator === "undefined") {
    return {
      online: true,
      profile: "high",
      effectiveType: null,
      saveData: false,
      rtt: null,
    };
  }

  const online = navigator.onLine !== false;
  const conn = getNavigatorConnection();
  const effectiveType =
    typeof conn?.effectiveType === "string"
      ? conn.effectiveType.toLowerCase()
      : null;
  const downlink =
    typeof conn?.downlink === "number" && Number.isFinite(conn.downlink)
      ? conn.downlink
      : null;
  const rtt =
    typeof conn?.rtt === "number" && Number.isFinite(conn.rtt) && conn.rtt > 0
      ? conn.rtt
      : null;
  const saveData = Boolean(conn?.saveData);

  let profile: BandwidthProfile = "high";
  if (
    saveData ||
    effectiveType === "slow-2g" ||
    effectiveType === "2g" ||
    (downlink !== null && downlink > 0 && downlink < 1.2) ||
    (rtt !== null && rtt >= 450)
  ) {
    profile = "low";
  } else if (
    effectiveType === "3g" ||
    (downlink !== null && downlink > 0 && downlink < 5.0) ||
    (rtt !== null && rtt >= 200)
  ) {
    profile = "medium";
  }

  return {
    online,
    profile,
    effectiveType,
    saveData,
    rtt,
  };
}

export function resolveEffectiveBandwidth(
  preference: BandwidthPreference,
  detected: DetectedNetworkInfo,
): BandwidthProfile {
  if (preference === "low") return "low";
  if (preference === "high") return "high";
  return detected.profile;
}

function foldAscii(input: string): string {
  return input
    .normalize("NFC")
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CUSTOMER_PATH_RE =
  /(?:^|[\s"'`(\[])\/(dashboard|books|my-books|book-scanner|children|profile|settings|reports|sessions|reading-management|reading-preparation|reading|entertainment|karaoke|achievements|learning-train|help-support|book-reports|studio\/tasks)(?:\/|\b)/i;

const CUSTOMER_GUEST_AUTH_PATH_RE =
  /(?:^|[\s"'`(\[])\/(login|register|forgot-password|reset-password)(?:\/|\b)/i;

const ADMIN_PATH_RE = /(?:^|[\s"'`(\[])\/admin(?:\/|\b)/i;

export function detectOfflineScopeBoundary(
  message: string,
  roleScope: AssistantRoleScope,
): AssistantScopeBoundaryReason | null {
  const folded = foldAscii(message);
  const lowerRaw = message.toLowerCase();

  // 1. Other users' data is forbidden across EVERY role (including admin).
  const asksOtherUser =
    folded.includes("nguoi dung khac") ||
    folded.includes("tai khoan khac") ||
    folded.includes("phu huynh khac") ||
    folded.includes("khach hang khac") ||
    folded.includes("be nha khac") ||
    folded.includes("gia dinh khac") ||
    folded.includes("nguoi khac") ||
    folded.includes("another user") ||
    folded.includes("other parent") ||
    folded.includes("other customer") ||
    folded.includes("other account") ||
    folded.includes("another family") ||
    folded.includes("someone else");
  if (asksOtherUser) {
    return "other_user";
  }

  // 2. Guest area mismatches (parent -> /admin/login; admin -> /login, /register, ...).
  if (
    roleScope === "parent" &&
    (lowerRaw.includes("/admin/login") ||
      folded.includes("dang nhap quan tri") ||
      folded.includes("admin login"))
  ) {
    return "guest_area";
  }
  if (
    roleScope === "admin" &&
    (CUSTOMER_GUEST_AUTH_PATH_RE.test(lowerRaw) ||
      folded.includes("dang nhap phu huynh") ||
      folded.includes("dang ky phu huynh") ||
      folded.includes("parent login") ||
      folded.includes("customer login"))
  ) {
    return "guest_area";
  }

  // 3. Public or Parent trying to enter /admin/* or admin-only tooling.
  if (
    roleScope !== "admin" &&
    (ADMIN_PATH_RE.test(lowerRaw) ||
      folded === "admin" ||
      folded.startsWith("admin ") ||
      folded.includes("trang admin") ||
      folded.includes("vao admin") ||
      folded.includes("mo admin") ||
      folded.includes("sang admin") ||
      folded.includes("trang quan tri") ||
      folded.includes("khu vuc quan tri") ||
      folded.includes("admin dashboard") ||
      folded.includes("admin panel") ||
      folded.includes("admin workspace") ||
      folded.includes("nhat ky kiem toan") ||
      folded.includes("audit log") ||
      folded.includes("viread training") ||
      folded.includes("metadata quality"))
  ) {
    return "admin_area";
  }

  // 4. Admin trying to enter customer/parent workspace (while still allowing /admin/parents, /admin/books, /admin/karaoke, /admin/tasks).
  if (roleScope === "admin") {
    const isAdminManagementTopic =
      ADMIN_PATH_RE.test(lowerRaw) ||
      folded.includes("quan ly phu huynh") ||
      folded.includes("quan ly sach") ||
      folded.includes("quan ly karaoke") ||
      folded.includes("duyet sach");
    const asksCustomerArea =
      CUSTOMER_PATH_RE.test(lowerRaw) ||
      folded.includes("trang khach hang") ||
      folded.includes("khu vuc khach hang") ||
      folded.includes("customer area") ||
      folded.includes("customer workspace") ||
      folded.includes("parent dashboard") ||
      folded.includes("parent workspace") ||
      (!isAdminManagementTopic &&
        (folded.includes("trang phu huynh") ||
          folded.includes("mo kho sach cho be") ||
          folded.includes("vao buoi doc") ||
          folded.includes("choi game cung be") ||
          folded.includes("vuon am vi") ||
          folded.includes("chuyen tau doc")));
    if (asksCustomerArea) {
      return "customer_area";
    }
  }

  // 5. Public guest trying to open authenticated customer pages.
  if (roleScope === "public") {
    const asksCustomerPage =
      CUSTOMER_PATH_RE.test(lowerRaw) ||
      folded.includes("mo dashboard") ||
      folded.includes("vao dashboard") ||
      folded.includes("open dashboard") ||
      folded.includes("mo trang tong quan") ||
      folded.includes("mo ho so be") ||
      folded.includes("vao ho so be") ||
      folded.includes("tao ho so be") ||
      folded.includes("mo sach cua toi") ||
      folded.includes("open my books") ||
      folded.includes("xem bao cao tien bo") ||
      folded.includes("mo bao cao") ||
      folded.includes("open reports") ||
      folded.includes("mo vuon am vi") ||
      folded.includes("vao chuyen tau doc") ||
      folded.includes("mo goc giai tri") ||
      folded.includes("mo cai dat") ||
      folded.includes("doi mat khau trong cai dat");
    if (asksCustomerPage) {
      return "guest_to_customer_area";
    }
  }

  return null;
}

function formatScopeBoundaryReply(
  reason: AssistantScopeBoundaryReason,
  roleScope: AssistantRoleScope,
  useEn: boolean,
): string {
  switch (reason) {
    case "other_user":
      return useEn
        ? "For family privacy and security, I cannot view or access another user's, parent's, or child's account data."
        : "Vì bảo mật và quyền riêng tư, mình không thể xem hay truy cập dữ liệu tài khoản, phụ huynh hoặc hồ sơ bé của người dùng khác nhé.";
    case "admin_area":
      return useEn
        ? "That area belongs to ViRead Admin operations. For security, I can only assist within your current workspace."
        : "Khu vực đó thuộc phạm vi Quản trị ViRead. Vì bảo mật, mình chỉ hỗ trợ và điều hướng trong phạm vi tài khoản hiện tại của bạn nhé.";
    case "customer_area":
      return useEn
        ? "In Admin mode, I stay strictly inside `/admin/*` operations (such as `/admin/books`, `/admin/parents`, `/admin/karaoke`, `/admin/tasks`) and cannot navigate into customer/parent pages."
        : "Ở chế độ Quản trị, mình chỉ làm việc trong khu vực `/admin/*` (như `/admin/books`, `/admin/parents`, `/admin/karaoke`, `/admin/tasks`) và không điều hướng sang trang khách hàng/phụ huynh nhé.";
    case "guest_to_customer_area":
      return useEn
        ? "Please sign in with your parent account first to open family reading features, child profiles, or reports."
        : "Vui lòng đăng nhập tài khoản phụ huynh trước để mở trang đọc sách, hồ sơ bé và báo cáo gia đình nhé.";
    case "guest_area":
      return roleScope === "admin"
        ? useEn
          ? "In Admin mode, I stay inside the `/admin/*` workspace and cannot open parent guest sign-in/registration pages."
          : "Ở chế độ Quản trị, mình chỉ hỗ trợ trong khu vực `/admin/*` và không chuyển sang trang đăng nhập/đăng ký của khách hàng."
        : useEn
          ? "You are already signed in as a parent, so I can only navigate within your parent ViRead pages."
          : "Bạn đang ở phiên phụ huynh, mình chỉ điều hướng trong các trang phụ huynh của ViRead thôi nhé.";
  }
}

const VIREAD_DOMAIN_ANCHORS: readonly string[] = [
  "viread",
  "vuon am vi",
  "chuyen tau doc",
  "tau doc 5 phut",
  "storyweaver",
  "duet reading",
  "doc doi",
  "readability badge",
  "nhan do kho",
  "parent pin",
  "ma pin",
  "reading presence",
  "book scanner",
  "quet sach",
  "smart studio",
  "metadata quality",
  "viread training",
  "child safety",
  "audit log",
  "memory game",
  "sentence shooter",
  "picture description",
  "karaoke",
  "dong dao",
  "ho so be",
  "tu can luyen",
  "wasm",
  "apps script bridge",
];

const GREETING_ONLY_RE =
  /^(xin chao|chao|chao ban|chao tro ly|hello|hi|hey|good morning|good afternoon|good evening|cam on|thanks|thank you)(\s+(viread|tro ly|ban|assistant))?$/i;

const OFF_TOPIC_PATTERNS: readonly string[] = [
  "thoi tiet",
  "du bao thoi tiet",
  "nhiet do hom nay",
  "troi co mua",
  "weather forecast",
  "weather today",
  "chung khoan",
  "co phieu",
  "gia vang",
  "gia bitcoin",
  "bitcoin",
  "crypto",
  "vnindex",
  "stock price",
  "stock market",
  "forex",
  "ty so bong da",
  "ket qua bong da",
  "lich thi dau",
  "world cup",
  "premier league",
  "champions league",
  "football score",
  "cong thuc nau",
  "cach nau",
  "mon ngon",
  "lam banh",
  "nau pho",
  "recipe for",
  "how to cook",
  "viet code",
  "lap trinh python",
  "lap trinh java",
  "lap trinh c",
  "javascript",
  "typescript",
  "react hook",
  "sql query",
  "leetcode",
  "binary search",
  "write a python",
  "write a javascript",
  "phuong trinh bac",
  "tinh tich phan",
  "tinh dao ham",
  "luong giac",
  "giai toan",
  "bai tap toan",
  "phuong trinh hoa hoc",
  "dinh luat newton",
  "solve equation",
  "quadratic equation",
  "calculus",
  "physics homework",
  "chemistry homework",
  "don thuoc",
  "kham benh",
  "trieu chung benh",
  "chan doan benh",
  "tu van y te",
  "medical advice",
  "tu van phap luat",
  "luat su",
  "legal advice",
  "ve may bay",
  "dat phong khach san",
  "tour du lich",
  "flight ticket",
  "hotel booking",
  "tin tuc chinh tri",
  "bau cu",
  "politics",
  "election",
];

export function detectOfflineOffTopicRequest(message: string): boolean {
  const folded = foldAscii(message);
  if (!folded || GREETING_ONLY_RE.test(folded)) {
    return false;
  }
  if (VIREAD_DOMAIN_ANCHORS.some((anchor) => folded.includes(anchor))) {
    return false;
  }
  return OFF_TOPIC_PATTERNS.some((pattern) => folded.includes(pattern));
}

interface OfflineRule {
  readonly scopes?: readonly AssistantRoleScope[];
  readonly keywords: readonly string[];
  readonly replyVi: string;
  readonly replyEn: string;
  readonly actions: readonly {
    readonly labelVi: string;
    readonly labelEn: string;
    readonly href: string;
  }[];
}

const OFFLINE_RULES: readonly OfflineRule[] = [
  // --- ADMIN-ONLY RULES ---
  {
    scopes: ["admin"],
    keywords: [
      "admin books",
      "tao sach",
      "duyet ocr",
      "verified",
      "gemini",
      "qwen3",
      "vietocr",
      "tesseract",
      "child safety",
      "ban quyen",
    ],
    replyVi:
      "Quản lý Kho sách & Duyệt OCR (`/admin/books`):\n• Tạo sách mới tại `/admin/books/new` hoặc mở trang chỉnh sửa `/admin/books/[bookId]/edit`.\n• So sánh & duyệt kết quả OCR từng trang (`Gemini` vs `Ollama Qwen3-VL` và `Tesseract/VietOCR`) thành `VERIFIED`.\n• Kiểm tra **Child Safety**, độ tuổi và bản quyền tại `/admin/metadata-quality` trước khi xuất bản.",
    replyEn:
      "Admin Books & OCR Review (`/admin/books`):\n• Create books at `/admin/books/new` or inspect pages in `/admin/books/[bookId]/edit`.\n• Compare OCR outputs (`Gemini` vs `Ollama Qwen3-VL` and `Tesseract/VietOCR`) and promote revisions to `VERIFIED`.\n• Complete **Child Safety** and rights checks in `/admin/metadata-quality` before publishing.",
    actions: [
      { labelVi: "Kho sách", labelEn: "Admin Books", href: "/admin/books" },
      {
        labelVi: "Chất lượng sách",
        labelEn: "Book Quality",
        href: "/admin/metadata-quality",
      },
    ],
  },
  {
    scopes: ["admin"],
    keywords: [
      "flow 1",
      "flow 2",
      "hygiene",
      "apps script",
      "training",
      "mo hinh doc chu",
    ],
    replyVi:
      "Huấn luyện mô hình đọc chữ (`/admin/viread-training`):\n• **Flow 1 / Flow 2**: thu thập mẫu chữ đã chuẩn hóa và kiểm tra điều kiện **hygiene** (sạch nhiễu, nhãn chuẩn tiếng Việt, không rò dữ liệu nhạy cảm) trước khi đưa vào tập huấn luyện.\n• **Apps Script Bridge**: dùng để đồng bộ bảng ghi chú/duyệt mẫu Google Sheet với kho huấn luyện ViRead.",
    replyEn:
      "OCR Model Training (`/admin/viread-training`):\n• **Flow 1 / Flow 2**: curate normalized samples and enforce **hygiene** rules (clean crops, valid Vietnamese labels, zero PII) before training.\n• **Apps Script Bridge**: syncs curated review sheets with the ViRead training pipeline.",
    actions: [
      {
        labelVi: "Mô hình đọc chữ",
        labelEn: "OCR Training",
        href: "/admin/viread-training",
      },
      { labelVi: "Vận hành", labelEn: "Health", href: "/admin/health" },
    ],
  },
  {
    scopes: ["admin"],
    keywords: [
      "worker",
      "health",
      "van hanh",
      "phan tang",
      "audit log",
      "nhat ky",
      "karaoke",
      "phu huynh",
      "admin parents",
      "admin tasks",
      "tac vu nen",
    ],
    replyVi:
      "Vận hành, Karaoke & Quản trị ViRead (`/admin/*`):\n• `/admin/health`: theo dõi OCR worker, Voice worker và trạng thái các tầng AI.\n• `/admin/tasks`: giám sát hàng đợi tác vụ nền OCR/TTS/Karaoke.\n• `/admin/karaoke`: thêm bài đồng dao mới và đồng bộ lời LRC.\n• `/admin/parents` & `/admin/audit-logs`: quản lý tài khoản phụ huynh và tra cứu nhật ký kiểm toán.",
    replyEn:
      "ViRead Admin Operations (`/admin/*`):\n• `/admin/health`: check OCR workers, Voice workers, and tiered AI circuits.\n• `/admin/tasks`: monitor background OCR/TTS/Karaoke jobs.\n• `/admin/karaoke`: manage children's songs and LRC lyric timing.\n• `/admin/parents` & `/admin/audit-logs`: manage parent accounts and inspect audit logs.",
    actions: [
      { labelVi: "Vận hành", labelEn: "Health", href: "/admin/health" },
      {
        labelVi: "Nhật ký",
        labelEn: "Audit Logs",
        href: "/admin/audit-logs",
      },
    ],
  },

  // --- PARENT-ONLY FEATURE RULES ---
  {
    scopes: ["parent"],
    keywords: [
      "vuon am vi",
      "huy hieu",
      "thanh tich",
      "phoneme garden",
      "achievements",
      "badges",
    ],
    replyVi:
      "Vườn Âm Vị & Huy hiệu (`/achievements`):\n• Hiển thị các âm/vần tiếng Việt bé đã luyện thành thạo như những bông hoa nở rộ cùng bộ sưu tập huy hiệu.\n• Cần chọn hồ sơ bé trước để mở đúng vườn âm vị riêng của bé.",
    replyEn:
      "Phoneme Garden & Badges (`/achievements`):\n• Tracks mastered Vietnamese phonemes as blooming flowers alongside your child's earned badges.\n• Select a child profile first to view that child's personal Phoneme Garden.",
    actions: [
      { labelVi: "Vườn Âm Vị", labelEn: "Achievements", href: "/achievements" },
      {
        labelVi: "Tàu Đọc 5 Phút",
        labelEn: "5-Min Train",
        href: "/learning-train",
      },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "chuyen tau",
      "tau doc 5 phut",
      "5 phut",
      "learning train",
      "5 minute",
    ],
    replyVi:
      "Chuyến Tàu Đọc 5 Phút (`/learning-train`):\n• Lộ trình luyện đọc ngắn 5 phút mỗi ngày kết hợp khởi động âm vị, đọc đoạn ngắn và thưởng sao giữ nhịp thói quen.\n• Cần chọn hồ sơ bé trước để hệ thống điều chỉnh đúng lớp (1–5).",
    replyEn:
      "5-Minute Reading Train (`/learning-train`):\n• A bite-sized 5-minute daily reading loop with phoneme warm-up, short passage reading, and streak rewards.\n• Select a child profile first so passages match their grade (1–5).",
    actions: [
      {
        labelVi: "Tàu Đọc 5 Phút",
        labelEn: "5-Min Train",
        href: "/learning-train",
      },
      { labelVi: "Vườn Âm Vị", labelEn: "Achievements", href: "/achievements" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "storyweaver",
      "story weaver",
      "tao truyen",
      "viet truyen",
      "family story",
    ],
    replyVi:
      "Family StoryWeaver (`/my-books`):\n• Cho phép ba mẹ tạo truyện riêng theo tên, sở thích và lớp của bé kèm minh họa Smart Studio.\n• Truyện sau khi tạo sẽ nằm ngay trong Sách của tôi (/my-books) để mở buổi đọc cho bé.",
    replyEn:
      "Family StoryWeaver (`/my-books`):\n• Lets parents craft personalized stories tailored to their child's name, interests, and grade with Smart Studio art.\n• Saved directly in My Books (/my-books) for immediate reading.",
    actions: [
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
      { labelVi: "Tác vụ AI", labelEn: "AI Tasks", href: "/studio/tasks" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "duet",
      "doc doi",
      "doc luan phien",
      "doc cung ba me",
      "instant countdown",
      "dem nguoc",
    ],
    replyVi:
      "Đọc đôi (Duet Reading) & Đếm ngược vào đọc ngay (`/reading-preparation`):\n• **Duet Reading**: bé và ba mẹ/AI đọc luân phiên từng câu để bé bớt ngại khi gặp bài dài.\n• **Instant Countdown**: đếm ngược ngắn trước khi bật micro giúp bé chuẩn bị nhịp thở vào đọc mượt mà.",
    replyEn:
      "Duet Reading & Instant Countdown (`/reading-preparation`):\n• **Duet Reading**: alternate sentences between parent/AI and child to keep longer stories fun.\n• **Instant Countdown**: brief pre-mic countdown so your child starts speaking smoothly.",
    actions: [
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
      { labelVi: "Kho sách", labelEn: "Books", href: "/books" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "wasm",
      "offline tts",
      "offline stt",
      "teacher voice",
      "co giao ai",
      "ai teacher",
      "giong doc",
      "khoa giong",
      "voice lock",
      "giong mau",
    ],
    replyVi:
      "Giọng Cô Giáo AI & WASM Offline TTS/STT:\n• **AI Teacher Voice Persona**: chọn giọng Bắc/Trung/Nam và lưu đồng bộ theo hồ sơ bé (giọng được khóa ổn định suốt buổi đọc).\n• **WASM Offline TTS/STT**: hỗ trợ tổng hợp giọng mẫu và nhận diện tiếng Việt cục bộ trên trình duyệt khi mạng yếu hoặc ngoại tuyến.",
    replyEn:
      "AI Teacher Voice & WASM Offline TTS/STT:\n• **AI Teacher Voice Persona**: pick regional Vietnamese voices synced per child profile (locked mid-session for consistency).\n• **WASM Offline TTS/STT**: runs browser-side speech synthesis and recognition when offline or on slow connections.",
    actions: [
      { labelVi: "Cài đặt", labelEn: "Settings", href: "/settings" },
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "readability",
      "do kho",
      "nhan do kho",
      "chung nhan",
      "bang khen",
      "cot moc",
      "certificate",
      "milestone",
    ],
    replyVi:
      "Nhãn độ khó đọc & Chứng nhận cột mốc:\n• **Readability Badge** trên Kho sách (`/books`): gắn nhãn mức độ đọc tiếng Việt phù hợp lớp 1–5.\n• **Milestone Certificate** (`/reports` & báo cáo buổi đọc): ghi nhận cột mốc số buổi đọc và huy hiệu để khích lệ bé.",
    replyEn:
      "Readability Badge & Milestone Certificates:\n• **Readability Badge** in Library (`/books`): tags books by Grade 1–5 Vietnamese reading difficulty.\n• **Milestone Certificate** (`/reports` & session reports): celebrates reading milestones and achievements.",
    actions: [
      { labelVi: "Kho sách", labelEn: "Books", href: "/books" },
      { labelVi: "Tiến bộ", labelEn: "Progress", href: "/reports" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "pin",
      "ma pin",
      "4 so",
      "parent pin",
      "khoa tre em",
      "child mode lock",
    ],
    replyVi:
      "Mã PIN phụ huynh 4 số (Parent PIN Lock):\n• Bảo vệ các khu vực quản trị gia đình như Cài đặt (/settings), Hồ sơ bé (/children) và Quản lý đọc khi đưa thiết bị cho bé tự học.\n• Có thể thiết lập hoặc mở khóa nhanh bằng mã PIN 4 chữ số của ba mẹ.",
    replyEn:
      "4-digit Parent PIN Lock:\n• Protects Settings (/settings), Child Profiles (/children), and Reading Management when handing the device to your child.\n• Set or unlock anytime with your 4-digit parent PIN.",
    actions: [
      { labelVi: "Cài đặt", labelEn: "Settings", href: "/settings" },
      { labelVi: "Hồ sơ bé", labelEn: "Child Profiles", href: "/children" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "vi sao phai chon be",
      "tai sao phai chon be",
      "chua chon be",
      "chon ho so be truoc",
      "child selection",
      "select a child",
      "why choose a child",
    ],
    replyVi:
      "Vì sao cần chọn hồ sơ bé trước khi đọc hoặc chơi?\n• Mỗi bé có lớp (1–5), tốc độ đọc, từ cần luyện và báo cáo tiến bộ riêng biệt.\n• Ba mẹ có thể chọn hoặc chuyển bé ngay trong hộp chọn của Trợ lý hoặc tại Tổng quan (/dashboard) và Hồ sơ bé (/children).",
    replyEn:
      "Why select a child profile before reading or playing?\n• Each child has their own grade (1–5), reading speed, difficult words, and progress history.\n• Pick or switch a child inline in the Assistant picker, Dashboard (/dashboard), or Child Profiles (/children).",
    actions: [
      { labelVi: "Hồ sơ bé", labelEn: "Child Profiles", href: "/children" },
      { labelVi: "Tổng quan", labelEn: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "nhieu be",
      "hai be",
      "2 be",
      "anh em",
      "chuyen be",
      "doi be",
      "chuyen ho so",
      "switch child",
      "multiple children",
      "siblings",
    ],
    replyVi:
      "Chuyển nhanh giữa nhiều bé trong gia đình:\n• Bấm chọn tên bé ở thanh đầu trang, trang Tổng quan (/dashboard), Hồ sơ bé (/children), hoặc ngay trong hộp chọn bé của Trợ lý.\n• Dữ liệu sách, từ khó và giọng đọc mẫu tự động tách riêng cho từng bé.",
    replyEn:
      "Switching between siblings:\n• Switch the active child anytime from the top header, Dashboard (/dashboard), Child Profiles (/children), or the Assistant child picker.\n• Bookshelves, difficult words, and model voice preferences stay isolated per child.",
    actions: [
      { labelVi: "Hồ sơ bé", labelEn: "Child Profiles", href: "/children" },
      { labelVi: "Tổng quan", labelEn: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "doc cham",
      "be doc cham",
      "danh van",
      "gap ngung",
      "kho doc",
      "slow reader",
      "struggling",
      "toc do doc",
      "0 85",
    ],
    replyVi:
      "Hỗ trợ bé đọc chậm hoặc hay ngập ngừng:\n• Hạ tốc độ giọng mẫu (ví dụ 0.85x) trong Chuẩn bị buổi đọc (/reading-preparation) hoặc Cài đặt.\n• Dùng chế độ đánh vần từng âm tiết AI khi bé gặp từ dài.\n• Ôn lại danh sách từ đọc nhầm mỗi ngày tại Từ cần luyện (/reports/difficult-words).",
    replyEn:
      "Supporting slow or hesitant readers:\n• Lower TTS model speed (e.g. 0.85x) in Reading Preparation (/reading-preparation).\n• Use AI syllable spelling support on tricky words.\n• Review missed words daily in Difficult Words (/reports/difficult-words).",
    actions: [
      {
        labelVi: "Từ cần luyện",
        labelEn: "Difficult Words",
        href: "/reports/difficult-words",
      },
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "reading presence",
      "email bao doc",
      "nhac doc",
      "muc tieu tuan",
      "lich doc",
      "email nhac",
      "quan ly doc",
      "weekly goal",
      "reminder",
    ],
    replyVi:
      "Thói quen đọc, Email nhắc lịch & Reading Presence Email:\n• Mở Quản lý đọc (/reading-management) để đặt mục tiêu phút/buổi mỗi tuần, lịch email nhắc đọc và bật thông báo khi bé hoàn thành buổi đọc (Reading Presence Email).\n• Kiểm tra email đã xác minh trong Hồ sơ ba mẹ (/profile) nếu chưa nhận được thư.",
    replyEn:
      "Weekly goals, reminders & Reading Presence Emails:\n• Open Reading Management (/reading-management) to set weekly targets, reminder schedules, and Reading Presence notifications.\n• Verify your email address in Parent Profile (/profile) if reminder emails do not arrive.",
    actions: [
      {
        labelVi: "Quản lý đọc",
        labelEn: "Reading Management",
        href: "/reading-management",
      },
      { labelVi: "Xem Tiến bộ", labelEn: "Progress", href: "/reports" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "quet",
      "scan",
      "ocr",
      "pdf",
      "docx",
      "sach cua toi",
      "sach rieng",
      "my books",
      "scanner",
      "smart studio",
    ],
    replyVi:
      "Quét sách (/book-scanner) vs Sách của tôi (/my-books):\n• **Quét sách (/book-scanner)**: chụp nhanh từng trang sách giấy bằng camera, phẳng và đủ sáng để đọc ngay.\n• **Sách của tôi (/my-books)**: tải nhiều ảnh/PDF/DOCX của gia đình, tạo truyện StoryWeaver, chỉnh sửa OCR và tạo minh họa Smart Studio.\n• Trang quét khi mất mạng sẽ được giữ trong Hàng chờ OCR để xử lý sau.",
    replyEn:
      "Book Scanner (/book-scanner) vs My Books (/my-books):\n• **Book Scanner (/book-scanner)**: snap flat, well-lit paper pages with your camera for immediate reading.\n• **My Books (/my-books)**: upload images/PDF/DOCX, create StoryWeaver stories, refine OCR text, and manage Smart Studio art.\n• Offline scans stay safely in the OCR queue.",
    actions: [
      { labelVi: "Quét sách", labelEn: "Book Scanner", href: "/book-scanner" },
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "karaoke",
      "dong dao",
      "giai tri",
      "tro choi",
      "mo ta tranh",
      "ghep cau",
      "sentence shooter",
      "picture description",
      "memory game",
      "lat the",
      "game",
      "luoi doc",
      "chan doc",
      "reluctant",
    ],
    replyVi:
      "Gợi ý Góc giải trí (/entertainment) cho bé hào hứng hơn:\n• Karaoke đồng dao thiếu nhi (/karaoke): luyện nhịp điệu và phát âm vui nhộn.\n• Memory Game lật thẻ (/entertainment/memory-game): nhớ mặt chữ qua cặp thẻ.\n• Ghép câu (/entertainment/sentence-shooter) & Mô tả tranh AI (/entertainment/picture-description): tăng phản xạ đặt câu.",
    replyEn:
      "Fun Entertainment (/entertainment) suggestions for reluctant readers:\n• Kids Karaoke (/karaoke): practice rhythm and pronunciation.\n• Memory Game (/entertainment/memory-game): build word recognition.\n• Sentence Shooter (/entertainment/sentence-shooter) & AI Picture Description (/entertainment/picture-description): boost sentence fluency.",
    actions: [
      {
        labelVi: "Góc giải trí",
        labelEn: "Entertainment",
        href: "/entertainment",
      },
      {
        labelVi: "Memory Game",
        labelEn: "Memory Game",
        href: "/entertainment/memory-game",
      },
    ],
  },
  {
    scopes: ["parent"],
    keywords: ["ho so", "them be", "child", "profile"],
    replyVi:
      "Chế độ ngoại tuyến — Hồ sơ bé:\n• Mở Hồ sơ bé (/children) → Tạo hồ sơ bé (/children/new), nhập tên gọi và lớp (1–5).\n• Chuyển nhanh giữa các bé ngay tại Tổng quan (/dashboard) hoặc trong Trợ lý.",
    replyEn:
      "Offline quick guide — Child Profiles:\n• Open Child Profiles (/children) → Create (/children/new) with name & grade (1–5).\n• Switch active child anytime on Dashboard (/dashboard) or in the Assistant.",
    actions: [
      { labelVi: "Hồ sơ bé", labelEn: "Child Profiles", href: "/children" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: [
      "tien bo",
      "bao cao",
      "tu kho",
      "tu can luyen",
      "lich su",
      "report",
    ],
    replyVi:
      "Chế độ ngoại tuyến — Tiến bộ & Từ cần luyện:\n• Xem 4 chỉ số (Đọc đúng, Trôi chảy, Hiểu bài, Thói quen) và Chứng nhận cột mốc tại Tiến bộ (/reports).\n• Ôn lại các từ bé đọc nhầm tại Từ cần luyện (/reports/difficult-words) và xem buổi cũ tại Lịch sử (/sessions).",
    replyEn:
      "Offline quick guide — Progress & Difficult Words:\n• View Accuracy, Fluency, Comprehension, Habit trends, and Milestone Certificates in Progress (/reports).\n• Drill tricky words at Difficult Words (/reports/difficult-words) and review past sessions at /sessions.",
    actions: [
      { labelVi: "Tiến bộ", labelEn: "Progress", href: "/reports" },
      {
        labelVi: "Từ cần luyện",
        labelEn: "Difficult Words",
        href: "/reports/difficult-words",
      },
    ],
  },
  {
    scopes: ["parent"],
    keywords: ["tac vu ai", "tien trinh ai", "studio tasks", "global task"],
    replyVi:
      "Chế độ ngoại tuyến — Trung tâm tác vụ AI (/studio/tasks):\n• Theo dõi tiến trình quét OCR, tạo truyện StoryWeaver, ảnh bìa/minh họa Smart Studio và audio trên thanh nổi tác vụ AI hoặc trang /studio/tasks.",
    replyEn:
      "Offline quick guide — AI Task Center (/studio/tasks):\n• Track OCR scans, StoryWeaver jobs, Smart Studio illustrations, and audio jobs inside /studio/tasks.",
    actions: [
      {
        labelVi: "Tác vụ AI",
        labelEn: "AI Tasks",
        href: "/studio/tasks",
      },
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: ["bao cao sach", "loi chu", "typo", "book report"],
    replyVi:
      "Báo cáo lỗi sách (`/book-reports`):\n• Khi phát hiện sai chính tả hoặc thiếu trang, ba mẹ có thể gửi báo lỗi ngay tại trang sách và theo dõi tiến độ xử lý tại `/book-reports`.",
    replyEn:
      "Book Issue Reports (`/book-reports`):\n• Report typos or page errors directly from a book and track resolution status in `/book-reports`.",
    actions: [
      {
        labelVi: "Báo cáo sách",
        labelEn: "Book Reports",
        href: "/book-reports",
      },
      { labelVi: "Kho sách", labelEn: "Books", href: "/books" },
    ],
  },
  {
    scopes: ["parent"],
    keywords: ["ngoai tuyen", "mat mang", "offline", "khong co mang"],
    replyVi:
      "Chế độ ngoại tuyến trên ViRead:\n• Trợ lý tự động chuyển sang hướng dẫn nhanh ngoại tuyến để hỗ trợ micro, quét sách, hồ sơ bé và tiến bộ.\n• Trang chụp từ Quét sách (/book-scanner) được giữ an toàn trong Hàng chờ OCR và xử lý tiếp khi có mạng.",
    replyEn:
      "ViRead Offline Mode:\n• The Assistant automatically switches to offline quick guides for mic checks, book scanning, child profiles, and progress.\n• Captured scanner pages remain safely queued in the offline OCR queue until connectivity returns.",
    actions: [
      { labelVi: "Quét sách", labelEn: "Book Scanner", href: "/book-scanner" },
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
    ],
  },

  // --- SHARED PUBLIC + PARENT RULES (actions strictly filtered per scope!) ---
  {
    scopes: ["public", "parent"],
    keywords: [
      "mang cham",
      "3g",
      "2g",
      "bang thong",
      "bandwidth",
      "tiet kiem du lieu",
      "save data",
      "slow network",
      "lag",
    ],
    replyVi:
      "Tối ưu khi mạng 3G yếu hoặc tiết kiệm dữ liệu:\n• Nhấn nút băng thông trên tiêu đề Trợ lý để chuyển sang chế độ **Tiết kiệm** — câu trả lời ngắn gọn, tải siêu nhẹ.\n• Khi mạng chập chờn, ưu tiên hướng dẫn nhanh thay vì gọi AI sâu hơn.",
    replyEn:
      "Tips for slow 3G or data-saver connections:\n• Tap the Assistant header bandwidth toggle to switch to **Low** mode for compact, fast replies.\n• Prefer quick guides over deeper LLM requests on unstable networks.",
    actions: [
      { labelVi: "Cài đặt", labelEn: "Settings", href: "/settings" },
      {
        labelVi: "Trợ giúp & hỗ trợ",
        labelEn: "Help & Support",
        href: "/help-support",
      },
    ],
  },
  {
    scopes: ["public", "parent"],
    keywords: ["micro", "mic", "camera", "quyen", "khong nghe", "permission"],
    replyVi:
      "Khắc phục nhanh Micro / Camera:\n• Chọn hồ sơ bé rồi mở Chuẩn bị buổi đọc để kiểm tra nhanh micro trước khi vào buổi đọc.\n• Bấm biểu tượng ổ khóa trên thanh địa chỉ → Cho phép Microphone & Camera → tải lại trang.\n• Đóng ứng dụng gọi video khác đang chiếm micro.",
    replyEn:
      "Quick Mic / Camera fix:\n• Select a child profile and open Reading Preparation to test your mic before reading.\n• Click the browser lock icon → Allow Microphone & Camera → reload.\n• Close any other app using your microphone.",
    actions: [
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
      {
        labelVi: "Trợ giúp & hỗ trợ",
        labelEn: "Help & Support",
        href: "/help-support",
      },
    ],
  },
  {
    scopes: ["public", "parent"],
    keywords: [
      "mat khau",
      "dang nhap",
      "dang ky",
      "quen",
      "email",
      "login",
      "password",
    ],
    replyVi:
      "Tài khoản & Mật khẩu ViRead:\n• Quên mật khẩu: mở /forgot-password và mở liên kết trong email trên cùng trình duyệt.\n• Đổi mật khẩu khi đã đăng nhập: mở menu tài khoản → Cài đặt.",
    replyEn:
      "ViRead Account & Password:\n• Forgot password: open /forgot-password and open the email link in the same browser.\n• Signed-in password change: Account Menu → Settings.",
    actions: [
      { labelVi: "Đăng nhập", labelEn: "Sign in", href: "/login" },
      { labelVi: "Cài đặt", labelEn: "Settings", href: "/settings" },
    ],
  },
  {
    scopes: ["public", "parent"],
    keywords: [
      "tinh nang",
      "chuc nang",
      "viread la gi",
      "lop may",
      "apk",
      "android",
      "features",
      "grade",
    ],
    replyVi:
      "ViRead — Nền tảng luyện đọc tiếng Việt cho học sinh lớp 1–5:\n• Kho sách phân cấp độ khó, Quét sách giấy OCR, Chuyến Tàu Đọc 5 Phút, Vườn Âm Vị & Huy hiệu.\n• Chấm đọc theo câu bằng AI + WASM ngoại tuyến, Chế độ đọc đôi Duet, Karaoke đồng dao, Góc giải trí & Báo cáo phụ huynh (có cả bản Android APK).",
    replyEn:
      "ViRead — Vietnamese reading platform for Grades 1–5:\n• Grade-leveled library, AI Paper Book Scanner, 5-Minute Reading Train, Phoneme Garden & Badges.\n• AI + offline WASM pronunciation feedback, Duet Reading, Kids Karaoke, learning games, and parent reports (including Android APK).",
    actions: [
      { labelVi: "Đăng nhập", labelEn: "Sign in", href: "/login" },
      { labelVi: "Đăng ký", labelEn: "Register", href: "/register" },
      { labelVi: "Kho sách", labelEn: "Books", href: "/books" },
    ],
  },
];

function resolveOfflineNavigationOffer(
  foldedQuery: string,
  pathname: string,
  roleScope: AssistantRoleScope,
  useEn: boolean,
): AssistantNavigationOffer | null {
  const candidates: readonly {
    readonly phrases: readonly string[];
    readonly href: string;
    readonly scenarioId: string;
    readonly labelVi: string;
    readonly labelEn: string;
    readonly reasonVi: string;
    readonly reasonEn: string;
  }[] = [
    // --- ADMIN CANDIDATES ---
    {
      phrases: ["admin/books/new", "them sach moi", "tao sach moi"],
      href: "/admin/books/new",
      scenarioId: "admin_books_new",
      labelVi: "Đi đến Thêm sách mới (Admin)",
      labelEn: "Go to New Book (Admin)",
      reasonVi: "Tạo đầu sách mới vào kho quản trị.",
      reasonEn: "Create a new book in the admin catalog.",
    },
    {
      phrases: ["admin/books", "kho sach", "duyet ocr", "admin books"],
      href: "/admin/books",
      scenarioId: "admin_books_catalog",
      labelVi: "Đi đến Kho sách Quản trị",
      labelEn: "Go to Admin Books",
      reasonVi: "Quản lý sách và duyệt OCR từng trang.",
      reasonEn: "Manage catalog books and verify OCR pages.",
    },
    {
      phrases: [
        "admin/metadata-quality",
        "chat luong sach",
        "child safety",
        "metadata quality",
      ],
      href: "/admin/metadata-quality",
      scenarioId: "admin_metadata_quality",
      labelVi: "Đi đến Chất lượng sách",
      labelEn: "Go to Book Quality Hub",
      reasonVi: "Kiểm tra Child Safety và báo cáo từ phụ huynh.",
      reasonEn: "Review Child Safety checks and parent reports.",
    },
    {
      phrases: [
        "admin/viread-training",
        "flow 2",
        "hygiene",
        "apps script",
        "viread training",
        "mo hinh doc chu",
      ],
      href: "/admin/viread-training",
      scenarioId: "admin_viread_training",
      labelVi: "Đi đến Huấn luyện mô hình đọc chữ",
      labelEn: "Go to OCR Model Training",
      reasonVi: "Quản lý dữ liệu Flow 1/Flow 2 và chuẩn hygiene.",
      reasonEn: "Manage Flow 1/Flow 2 datasets and hygiene rules.",
    },
    {
      phrases: ["admin/karaoke/new", "them bai karaoke"],
      href: "/admin/karaoke/new",
      scenarioId: "admin_karaoke_new",
      labelVi: "Đi đến Thêm bài Karaoke",
      labelEn: "Go to New Karaoke Song",
      reasonVi: "Tải bài đồng dao mới và lời đồng bộ LRC.",
      reasonEn: "Upload a new kids karaoke song and LRC lyrics.",
    },
    {
      phrases: ["admin/karaoke", "quan ly karaoke"],
      href: "/admin/karaoke",
      scenarioId: "admin_karaoke",
      labelVi: "Đi đến Quản lý Karaoke",
      labelEn: "Go to Admin Karaoke",
      reasonVi: "Quản lý kho bài hát Karaoke thiếu nhi.",
      reasonEn: "Manage the kids karaoke catalog.",
    },
    {
      phrases: ["admin/parents", "quan ly phu huynh"],
      href: "/admin/parents",
      scenarioId: "admin_parents",
      labelVi: "Đi đến Quản lý Phụ huynh",
      labelEn: "Go to Parent Accounts",
      reasonVi: "Xem trạng thái tài khoản phụ huynh trong phạm vi quản trị.",
      reasonEn: "Manage parent account status within admin scope.",
    },
    {
      phrases: ["admin/tasks", "tac vu nen", "admin tasks"],
      href: "/admin/tasks",
      scenarioId: "admin_tasks",
      labelVi: "Đi đến Tác vụ nền Quản trị",
      labelEn: "Go to Admin Tasks",
      reasonVi: "Theo dõi hàng đợi OCR và xử lý nền.",
      reasonEn: "Monitor background OCR and AI tasks.",
    },
    {
      phrases: [
        "admin/audit-logs",
        "nhat ky kiem toan",
        "audit log",
        "audit logs",
      ],
      href: "/admin/audit-logs",
      scenarioId: "admin_audit_logs",
      labelVi: "Đi đến Nhật ký Kiểm toán",
      labelEn: "Go to Admin Audit Logs",
      reasonVi: "Tra cứu lịch sử thao tác quản trị hệ thống.",
      reasonEn: "Review admin audit trail entries.",
    },
    {
      phrases: [
        "admin/health",
        "van hanh",
        "worker",
        "operations health",
        "system health",
      ],
      href: "/admin/health",
      scenarioId: "admin_health",
      labelVi: "Đi đến Vận hành hệ thống",
      labelEn: "Go to Operations Health",
      reasonVi: "Kiểm tra OCR worker, Voice worker và tầng AI.",
      reasonEn: "Inspect OCR/Voice workers and AI circuit health.",
    },

    // --- PUBLIC CANDIDATES ---
    {
      phrases: ["dang ky", "register", "tao tai khoan"],
      href: "/register",
      scenarioId: "public_register",
      labelVi: "Đi đến Đăng ký ViRead",
      labelEn: "Go to Register",
      reasonVi: "Tạo tài khoản phụ huynh ViRead mới.",
      reasonEn: "Create a new ViRead parent account.",
    },
    {
      phrases: ["quen mat khau", "forgot password"],
      href: "/forgot-password",
      scenarioId: "forgot_password",
      labelVi: "Đi đến Khôi phục mật khẩu",
      labelEn: "Go to Forgot Password",
      reasonVi: "Nhập email của bạn để nhận liên kết đặt lại mật khẩu.",
      reasonEn: "Request a password reset link by email.",
    },
    {
      phrases: ["dang nhap", "sign in", "login"],
      href: "/login",
      scenarioId: "public_login",
      labelVi: "Đi đến Đăng nhập ViRead",
      labelEn: "Go to Sign In",
      reasonVi: "Đăng nhập để mở trang đọc sách và hồ sơ gia đình.",
      reasonEn: "Sign in to access family reading features.",
    },

    // --- PARENT CANDIDATES ---
    {
      phrases: [
        "doi mat khau",
        "thay doi mat khau",
        "change password",
        "cai dat",
        "bang thong",
        "tiet kiem du lieu",
        "bandwidth",
        "ma pin",
        "parent pin",
      ],
      href: "/settings",
      scenarioId: "account_settings",
      labelVi: "Đi đến trang Cài đặt tài khoản",
      labelEn: "Go to Account Settings",
      reasonVi:
        "Mở Cài đặt để đổi mật khẩu, Mã PIN 4 số và tùy chỉnh tài khoản bạn.",
      reasonEn:
        "Update your password, 4-digit Parent PIN, and preferences in Settings.",
    },
    {
      phrases: ["ho so ba me", "parent profile", "doi email"],
      href: "/profile",
      scenarioId: "parent_profile",
      labelVi: "Đi đến Hồ sơ ba mẹ",
      labelEn: "Go to Parent Profile",
      reasonVi: "Cập nhật thông tin tài khoản của bạn.",
      reasonEn: "Edit your parent profile details.",
    },
    {
      phrases: ["tao ho so be", "them be", "create child", "add child"],
      href: "/children/new",
      scenarioId: "create_child_profile",
      labelVi: "Đi đến Tạo hồ sơ bé",
      labelEn: "Go to Create Child Profile",
      reasonVi: "Tạo hồ sơ mới theo tên gọi và lớp (1–5) cho bé.",
      reasonEn: "Create a new Grade 1–5 profile for your child.",
    },
    {
      phrases: [
        "ho so be",
        "chon be",
        "doi be",
        "chuyen be",
        "chuyen ho so",
        "child profile",
        "switch child",
        "select child",
      ],
      href: "/children",
      scenarioId: "child_selection_gate_and_switching",
      labelVi: "Đi đến trang Hồ sơ bé",
      labelEn: "Go to Child Profiles",
      reasonVi: "Quản lý hoặc chuyển đổi giữa hồ sơ các bé trong gia đình bạn.",
      reasonEn: "Manage or switch between your family's child profiles.",
    },
    {
      phrases: [
        "vuon am vi",
        "huy hieu",
        "thanh tich",
        "phoneme garden",
        "achievements",
      ],
      href: "/achievements",
      scenarioId: "phoneme_garden_achievements",
      labelVi: "Đi đến Vườn Âm Vị & Huy hiệu",
      labelEn: "Go to Phoneme Garden & Badges",
      reasonVi: "Xem hoa âm vị đã nở và bộ sưu tập huy hiệu của bé.",
      reasonEn: "View blooming phonemes and earned badges for your child.",
    },
    {
      phrases: [
        "chuyen tau",
        "tau doc 5 phut",
        "learning train",
        "5 minute",
        "5 phut",
      ],
      href: "/learning-train",
      scenarioId: "five_minute_learning_train",
      labelVi: "Đi đến Chuyến Tàu Đọc 5 Phút",
      labelEn: "Go to 5-Minute Reading Train",
      reasonVi: "Bắt đầu chặng luyện đọc ngắn 5 phút mỗi ngày cùng bé.",
      reasonEn: "Start a focused 5-minute daily reading loop with your child.",
    },
    {
      phrases: [
        "nhac doc",
        "muc tieu tuan",
        "quan ly doc",
        "reading presence",
        "weekly goal",
        "email reminder",
        "reading management",
      ],
      href: "/reading-management",
      scenarioId: "weekly_reminders",
      labelVi: "Đi đến Quản lý đọc",
      labelEn: "Go to Reading Management",
      reasonVi: "Đặt mục tiêu đọc hàng tuần và lịch email nhắc đọc cho bé.",
      reasonEn: "Set weekly reading goals and email reminder schedules.",
    },
    {
      phrases: [
        "tu kho",
        "tu can luyen",
        "doc cham",
        "be doc cham",
        "danh van",
        "difficult words",
        "slow reader",
      ],
      href: "/reports/difficult-words",
      scenarioId: "slow_reader_support",
      labelVi: "Đi đến Từ cần luyện",
      labelEn: "Go to Difficult Words",
      reasonVi: "Ôn lại các từ bé hay đọc nhầm với giọng mẫu và micro.",
      reasonEn: "Practice tricky words with model audio and mic support.",
    },
    {
      phrases: [
        "tien bo",
        "bao cao",
        "chung nhan",
        "certificate",
        "progress",
        "reports",
      ],
      href: "/reports",
      scenarioId: "progress_reports",
      labelVi: "Đi đến Báo cáo tiến bộ",
      labelEn: "Go to Progress Reports",
      reasonVi: "Xem 4 chỉ số tiến bộ đọc và chứng nhận cột mốc của bé.",
      reasonEn: "Review your child's 4 progress metrics and certificates.",
    },
    {
      phrases: ["lich su doc", "lich su buoi doc", "session history"],
      href: "/sessions",
      scenarioId: "session_history",
      labelVi: "Đi đến Lịch sử buổi đọc",
      labelEn: "Go to Reading History",
      reasonVi: "Xem lại các buổi đọc đã hoàn thành và kết quả đọc hiểu.",
      reasonEn: "Review completed reading sessions and comprehension scores.",
    },
    {
      phrases: ["quet sach", "book scanner", "chup trang", "scan book", "ocr"],
      href: "/book-scanner",
      scenarioId: "scanner_vs_my_books",
      labelVi: "Đi đến Quét sách giấy AI",
      labelEn: "Go to Book Scanner",
      reasonVi: "Chụp hoặc tải trang sách giấy để trích xuất chữ cho bé.",
      reasonEn: "Scan printed pages into ViRead for your child.",
    },
    {
      phrases: [
        "sach cua toi",
        "my books",
        "tai pdf",
        "upload book",
        "sach rieng",
        "storyweaver",
        "tao truyen",
      ],
      href: "/my-books",
      scenarioId: "scanner_vs_my_books",
      labelVi: "Đi đến Sách của tôi",
      labelEn: "Go to My Books",
      reasonVi: "Tạo truyện StoryWeaver hoặc tải sách ảnh/PDF/DOCX gia đình.",
      reasonEn: "Create StoryWeaver stories or upload family books.",
    },
    {
      phrases: ["tac vu ai", "tien trinh ai", "studio/tasks", "smart studio"],
      href: "/studio/tasks",
      scenarioId: "ai_task_center",
      labelVi: "Đi đến Trung tâm tác vụ AI",
      labelEn: "Go to AI Task Center",
      reasonVi: "Xem tiến trình tác vụ AI của bạn.",
      reasonEn: "Monitor your background AI tasks.",
    },
    {
      phrases: ["memory game", "lat the"],
      href: "/entertainment/memory-game",
      scenarioId: "game_suggestions",
      labelVi: "Đi đến Memory Game lật thẻ",
      labelEn: "Go to Memory Game",
      reasonVi: "Chơi lật thẻ luyện trí nhớ từ vựng cùng bé.",
      reasonEn: "Play the Memory Card Game with your child.",
    },
    {
      phrases: ["ghep cau", "sentence shooter"],
      href: "/entertainment/sentence-shooter",
      scenarioId: "game_suggestions",
      labelVi: "Đi đến Trò chơi Ghép câu",
      labelEn: "Go to Sentence Shooter",
      reasonVi: "Luyện phản xạ ghép câu tiếng Việt sinh động cùng bé.",
      reasonEn: "Practice Vietnamese sentence building in Sentence Shooter.",
    },
    {
      phrases: ["mo ta tranh", "picture description"],
      href: "/entertainment/picture-description",
      scenarioId: "game_suggestions",
      labelVi: "Đi đến Mô tả tranh AI",
      labelEn: "Go to AI Picture Description",
      reasonVi: "Khuyến khích bé quan sát và kể lại tranh bằng lời nói.",
      reasonEn: "Encourage your child to describe illustrations aloud with AI.",
    },
    {
      phrases: ["karaoke", "dong dao"],
      href: "/karaoke",
      scenarioId: "game_suggestions",
      labelVi: "Đi đến Karaoke đồng dao",
      labelEn: "Go to Kids Karaoke",
      reasonVi: "Bé luyện nhịp điệu và phát âm qua bài hát thiếu nhi.",
      reasonEn: "Practice rhythm and pronunciation with Kids Karaoke.",
    },
    {
      phrases: [
        "giai tri",
        "tro choi",
        "entertainment",
        "luoi doc",
        "chan doc",
        "games",
      ],
      href: "/entertainment",
      scenarioId: "game_suggestions",
      labelVi: "Đi đến Góc giải trí",
      labelEn: "Go to Entertainment",
      reasonVi: "Khám phá trò chơi ngôn ngữ và Karaoke giúp bé hứng thú đọc.",
      reasonEn: "Explore language games and Karaoke for your child.",
    },
    {
      phrases: [
        "micro",
        "camera",
        "quyen thiet bi",
        "chuan bi doc",
        "reading preparation",
        "microphone",
        "duet",
        "doc doi",
      ],
      href: "/reading-preparation",
      scenarioId: "mic_camera_permissions",
      labelVi: "Đi đến Chuẩn bị buổi đọc",
      labelEn: "Go to Reading Preparation",
      reasonVi: "Kiểm tra nhanh micro, chế độ đọc đôi Duet và phạm vi trang.",
      reasonEn: "Check mic, Duet Reading, and page range before reading.",
    },
    {
      phrases: [
        "chon sach",
        "kho sach",
        "thu vien",
        "bat dau doc",
        "buoi doc",
        "reading session",
        "books",
        "library",
        "readability",
      ],
      href: "/books",
      scenarioId: "browse_books_and_start_reading",
      labelVi: "Đi đến Kho sách ViRead",
      labelEn: "Go to ViRead Book Library",
      reasonVi: "Chọn cuốn sách phù hợp lớp của bé để bắt đầu buổi đọc.",
      reasonEn: "Pick a grade-matched book to start a reading session.",
    },
    {
      phrases: ["tong quan", "dashboard"],
      href: "/dashboard",
      scenarioId: "family_dashboard",
      labelVi: "Đi đến Tổng quan gia đình",
      labelEn: "Go to Family Dashboard",
      reasonVi: "Xem tổng quan hoạt động và chọn hồ sơ bé nhanh chóng.",
      reasonEn: "View family activity and switch child profiles.",
    },
  ];

  for (const item of candidates) {
    if (!item.phrases.some((p) => foldedQuery.includes(p))) {
      continue;
    }
    if (!isSafeAssistantNavigationHref(item.href, pathname, roleScope)) {
      continue;
    }
    return {
      href: item.href,
      label: useEn ? item.labelEn : item.labelVi,
      reason: useEn ? item.reasonEn : item.reasonVi,
      requires_child_selection: requiresSelectedChildForHref(item.href),
      scenario_id: item.scenarioId,
    };
  }
  return null;
}

export function resolveOfflineAssistantReply(
  message: string,
  pathname: string,
  locale: string,
  bandwidth: BandwidthProfile,
): AssistantChatResponse {
  const useEn = !locale.toLowerCase().startsWith("vi");
  const folded = foldAscii(message);
  const pageGuide = resolvePageGuide(pathname, locale);
  const roleScope = inferAssistantRoleScope(pathname);
  const safePageActions = pageGuide.actions.filter((a) =>
    isSafeAssistantQuickActionHref(a.href, pathname, roleScope),
  );

  // 1. Strict 4-way scope boundary check (Public vs Parent vs Admin vs Other Users).
  const scopeBoundary = detectOfflineScopeBoundary(message, roleScope);
  if (scopeBoundary) {
    const guestSignInActions: AssistantQuickAction[] =
      scopeBoundary === "guest_to_customer_area"
        ? (
            [
              { label: useEn ? "Sign in" : "Đăng nhập", href: "/login" },
              { label: useEn ? "Register" : "Đăng ký", href: "/register" },
            ] satisfies AssistantQuickAction[]
          ).filter((a) =>
            isSafeAssistantQuickActionHref(a.href, pathname, roleScope),
          )
        : [];
    return {
      reply: formatScopeBoundaryReply(scopeBoundary, roleScope, useEn),
      source_tier: "offline",
      provider_id: "viread_scope_guard",
      model_id: null,
      bandwidth_applied: bandwidth,
      latency_ms: 1,
      cached: false,
      role_scope: roleScope,
      quick_actions:
        guestSignInActions.length > 0
          ? guestSignInActions
          : safePageActions.slice(0, 2),
      suggested_prompts: pageGuide.prompts,
      navigation_offer: null,
    };
  }

  // 2. Deterministic ViRead-only off-topic domain guard.
  if (detectOfflineOffTopicRequest(message)) {
    return {
      reply: useEn
        ? "I am the ViRead Assistant and can only help with ViRead reading features, child profiles, scanning, learning games, or your authorized ViRead workspace."
        : "Mình là Trợ lý ViRead nên chỉ hỗ trợ các tính năng và thao tác trong ứng dụng ViRead (đọc sách tiếng Việt, hồ sơ bé, quét sách, trò chơi, báo cáo hoặc quản trị hợp lệ), không trả lời các chủ đề ngoài ViRead nhé.",
      source_tier: "offline",
      provider_id: "viread_domain_guard",
      model_id: null,
      bandwidth_applied: bandwidth,
      latency_ms: 1,
      cached: false,
      role_scope: roleScope,
      quick_actions: safePageActions.slice(0, 2),
      suggested_prompts: pageGuide.prompts,
      navigation_offer: null,
    };
  }

  // 3. Friendly ViRead greeting pass-through.
  if (GREETING_ONLY_RE.test(folded)) {
    return {
      reply: pageGuide.greeting,
      source_tier: "offline",
      provider_id: "viread_offline_guide",
      model_id: null,
      bandwidth_applied: bandwidth,
      latency_ms: 1,
      cached: false,
      role_scope: roleScope,
      quick_actions: safePageActions.slice(0, 2),
      suggested_prompts: pageGuide.prompts,
      navigation_offer: null,
    };
  }

  const navigationOffer = resolveOfflineNavigationOffer(
    folded,
    pathname,
    roleScope,
    useEn,
  );

  for (const rule of OFFLINE_RULES) {
    if (rule.scopes && !rule.scopes.includes(roleScope)) {
      continue;
    }
    if (rule.keywords.some((kw) => folded.includes(kw))) {
      const actions = rule.actions
        .filter((a) =>
          isSafeAssistantQuickActionHref(a.href, pathname, roleScope),
        )
        .map((a) => ({
          label: useEn ? a.labelEn : a.labelVi,
          href: a.href,
        }));
      return {
        reply: useEn ? rule.replyEn : rule.replyVi,
        source_tier: "offline",
        provider_id: "viread_offline_guide",
        model_id: null,
        bandwidth_applied: bandwidth,
        latency_ms: 1,
        cached: false,
        role_scope: roleScope,
        quick_actions:
          actions.length > 0 ? actions : safePageActions.slice(0, 2),
        suggested_prompts: pageGuide.prompts,
        navigation_offer: navigationOffer,
      };
    }
  }

  return {
    reply: useEn
      ? "You appear to be offline or the assistant server is unreachable right now. You can still browse ViRead quick tips using the page suggestions below, or retry once your connection is back."
      : "Hiện thiết bị đang ngoại tuyến hoặc máy chủ trợ lý tạm gián đoạn. Bạn vẫn có thể hỏi về các tính năng ViRead trong phạm vi hiện tại hoặc bấm thử lại khi có mạng ổn định nhé.",
    source_tier: "offline",
    provider_id: "viread_offline_guide",
    model_id: null,
    bandwidth_applied: bandwidth,
    latency_ms: 1,
    cached: false,
    role_scope: roleScope,
    quick_actions: safePageActions.slice(0, 2),
    suggested_prompts: pageGuide.prompts,
    navigation_offer: navigationOffer,
  };
}
