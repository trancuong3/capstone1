import { requiresSelectedChildForHref } from "@/lib/assistant/child-gate";
import {
  hasMobileBottomNavPath,
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
      "Cần hỗ trợ đăng nhập tài khoản quản trị hoặc quay về trang đăng nhập phụ huynh?",
    greetingEn: "Need help signing in or returning to the parent sign-in page?",
    promptsVi: [
      "Cách đăng nhập và xác minh tài khoản ViRead?",
      "Quên mật khẩu thì khôi phục thế nào?",
      "ViRead có những chức năng gì?",
    ],
    promptsEn: [
      "How do I sign in or verify my ViRead account?",
      "How do I reset a forgotten password?",
      "What features does ViRead offer?",
    ],
    actions: [
      {
        labelVi: "Đăng nhập phụ huynh",
        labelEn: "Parent Login",
        href: "/login",
      },
      {
        labelVi: "Quên mật khẩu",
        labelEn: "Forgot password",
        href: "/forgot-password",
      },
    ],
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
    ],
  },
  {
    prefix: "/admin",
    titleVi: "Khu vực Quản trị",
    titleEn: "Admin Workspace",
    greetingVi:
      "Xin chào Quản trị viên! Hỏi nhanh về kho sách, OCR, chất lượng hay vận hành.",
    greetingEn:
      "Hello Admin! Ask about catalog books, OCR review, quality, or operations.",
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
    prefix: "/reading-management",
    titleVi: "Quản lý đọc",
    titleEn: "Reading Management",
    greetingVi:
      "Hỏi tôi cách đặt mục tiêu tuần, lịch email nhắc đọc và sách đã lưu cho bé.",
    greetingEn:
      "Ask how to set weekly goals, email reminders, and bookmarked books.",
    promptsVi: [
      "Cách đặt lịch email nhắc đọc cho bé?",
      "Làm sao đặt mục tiêu đọc hàng tuần?",
      "Tại sao chưa nhận được email nhắc đọc?",
    ],
    promptsEn: [
      "How do I schedule email reminders?",
      "How do I set weekly reading goals?",
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
      "Sẵn sàng đọc sách! Cần hướng dẫn chọn phạm vi trang hay kiểm tra micro?",
    greetingEn:
      "Ready to read! Need help selecting pages or checking your microphone?",
    promptsVi: [
      "Cách chọn phạm vi trang đọc phù hợp?",
      "Kiểm tra micro trước khi bé đọc?",
      "Giọng đọc mẫu và chế độ đọc là gì?",
    ],
    promptsEn: [
      "How do I pick a page range?",
      "How do I test the mic before reading?",
      "How do model voice & reading modes work?",
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
      "Khung gọn nhẹ để bé tập trung đọc. Ba mẹ cần hỗ trợ gì về micro hay giọng đọc?",
    greetingEn:
      "Compact guide so your child stays focused. Need help with mic or voice?",
    promptsVi: [
      "Micro không nhận giọng bé phải làm sao?",
      "Cách đổi giọng đọc mẫu (TTS)?",
      "Từ bé đọc nhầm sẽ lưu ở đâu?",
    ],
    promptsEn: [
      "Mic isn't picking up my child's voice",
      "How do I change the model voice?",
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
      "Hỏi tôi cách tải sách ảnh/PDF/DOCX của gia đình hoặc xem lại nội dung OCR.",
    greetingEn:
      "Ask how to upload private books (images/PDF/DOCX) or edit OCR scans.",
    promptsVi: [
      "Cách tải sách riêng từ ảnh hoặc PDF?",
      "Hàng chờ OCR ngoại tuyến hoạt động ra sao?",
      "Làm sao bắt đầu buổi đọc từ sách của tôi?",
    ],
    promptsEn: [
      "How do I upload a book from images or PDF?",
      "How does the offline OCR queue work?",
      "How do I start reading my uploaded book?",
    ],
    actions: [
      { labelVi: "Quét sách", labelEn: "Book Scanner", href: "/book-scanner" },
      { labelVi: "Kho sách", labelEn: "Library", href: "/books" },
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
      "Tôi có thể giải thích 4 chỉ số đọc và cách ôn luyện cho bé hiệu quả.",
    greetingEn:
      "I can explain the 4 reading metrics and how to help your child improve.",
    promptsVi: [
      "4 chỉ số tiến bộ của bé có ý nghĩa gì?",
      "Cách ôn luyện các từ bé hay đọc nhầm?",
      "Làm sao đặt lịch nhắc đọc hàng tuần?",
    ],
    promptsEn: [
      "What do the 4 progress metrics mean?",
      "How do we practice missed words?",
      "How do I schedule reading reminders?",
    ],
    actions: [
      {
        labelVi: "Từ cần luyện",
        labelEn: "Difficult Words",
        href: "/reports/difficult-words",
      },
      { labelVi: "Lịch sử đọc", labelEn: "History", href: "/sessions" },
    ],
  },
  {
    prefix: "/entertainment",
    titleVi: "Góc giải trí",
    titleEn: "Entertainment",
    greetingVi:
      "Khám phá Karaoke thiếu nhi, Ghép câu và Mô tả tranh AI cùng bé!",
    greetingEn:
      "Explore Karaoke, Sentence Shooter, and AI Picture Description!",
    promptsVi: [
      "Trò chơi Mô tả tranh AI hoạt động thế nào?",
      "Karaoke và Ghép câu giúp bé luyện gì?",
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
    titleVi: "Karaoke thiếu nhi",
    titleEn: "Kids Karaoke",
    greetingVi:
      "Cần hướng dẫn bật nhạc, theo dõi lời chạy nhịp hoặc kiểm tra âm thanh?",
    greetingEn:
      "Need help with lyrics sync, audio playback, or other learning games?",
    promptsVi: [
      "Karaoke giúp bé luyện đọc thế nào?",
      "Còn trò chơi ngôn ngữ nào khác không?",
      "Không nghe âm thanh hoặc micro bị lỗi?",
    ],
    promptsEn: [
      "How does Karaoke help reading?",
      "What other language games are there?",
      "Audio or microphone not working?",
    ],
    actions: [
      {
        labelVi: "Góc giải trí",
        labelEn: "Entertainment",
        href: "/entertainment",
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
      "Theo dõi tiến trình quét OCR, tạo ảnh minh họa và audio cho tài khoản của bạn.",
    greetingEn:
      "Monitor your own OCR scans, AI illustrations, and audio jobs here.",
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
    prefix: "/books",
    titleVi: "Kho sách ViRead",
    titleEn: "ViRead Book Library",
    greetingVi:
      "Chọn cuốn sách phù hợp lớp của bé hoặc tải sách giấy gia đình tại Sách của tôi.",
    greetingEn:
      "Pick a catalog book for your child's grade or upload family books in My Books.",
    promptsVi: [
      "Cách chọn sách và bắt đầu buổi đọc?",
      "Làm sao quét sách giấy bằng camera?",
      "Làm sao báo lỗi chữ sai trong sách?",
    ],
    promptsEn: [
      "How do I pick a book and start reading?",
      "How do I scan a paper book?",
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
      "Quản lý hồ sơ từng bé theo lớp 1–5 để lưu riêng tủ sách, báo cáo và từ cần luyện.",
    greetingEn:
      "Manage Grade 1–5 child profiles with separate bookshelves, reports, and difficult words.",
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
      "Đổi mật khẩu bảo mật hoặc gửi liên kết đặt mật khẩu cho tài khoản Google/Facebook.",
    greetingEn:
      "Change your password or request a password setup link for Google/Facebook accounts.",
    promptsVi: [
      "Làm sao đổi mật khẩu tài khoản?",
      "Cách đổi ngôn ngữ giao diện ViRead?",
      "Cách cập nhật hồ sơ ba mẹ?",
    ],
    promptsEn: [
      "How do I change my password?",
      "How do I switch the UI language?",
      "How do I update my parent profile?",
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
      "Xem lại từng buổi đọc đã hoàn thành, điểm đọc hiểu và các từ bé cần ôn thêm.",
    greetingEn:
      "Review completed reading sessions, comprehension scores, and words to practice.",
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
      "Cần hỏi nhanh về tính năng ViRead, báo lỗi sách hay gửi phản hồi cho đội ngũ?",
    greetingEn:
      "Need quick help with ViRead features, book issue reports, or contacting support?",
    promptsVi: [
      "Cách gửi phản hồi hoặc báo lỗi kỹ thuật?",
      "Làm sao báo lỗi chữ sai trong sách?",
      "Trợ lý ViRead dùng AI phân tầng thế nào?",
    ],
    promptsEn: [
      "How do I send support feedback?",
      "How do I report a typo in a book?",
      "How does the tiered AI assistant work?",
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

export {
  hasMobileBottomNavPath,
  isAdminPath,
  isAuthPath,
  isReadingSessionPath,
};

export function resolvePageGuide(
  pathname: string,
  locale: string,
): ResolvedPageGuide {
  const clean = pathname && pathname.startsWith("/") ? pathname : "/";
  const useEn = !locale.toLowerCase().startsWith("vi");

  const matched = PAGE_GUIDES.find(
    (entry) => clean === entry.prefix || clean.startsWith(`${entry.prefix}/`),
  );

  if (!matched) {
    if (isAuthPath(clean)) {
      return useEn
        ? {
            ...DEFAULT_GUIDE_EN,
            actions: [
              { label: "Sign in", href: "/login" },
              { label: "Register", href: "/register" },
            ],
          }
        : {
            ...DEFAULT_GUIDE_VI,
            actions: [
              { label: "Đăng nhập", href: "/login" },
              { label: "Đăng ký", href: "/register" },
            ],
          };
    }
    return useEn ? DEFAULT_GUIDE_EN : DEFAULT_GUIDE_VI;
  }

  return {
    title: useEn ? matched.titleEn : matched.titleVi,
    greeting: useEn ? matched.greetingEn : matched.greetingVi,
    prompts: useEn ? matched.promptsEn : matched.promptsVi,
    actions: matched.actions.map((item) => ({
      label: useEn ? item.labelEn : item.labelVi,
      href: item.href,
    })),
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

interface OfflineRule {
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
  {
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
    keywords: [
      "nhac doc",
      "muc tieu tuan",
      "lich doc",
      "email nhac",
      "quan ly doc",
      "weekly goal",
      "reminder",
    ],
    replyVi:
      "Thói quen đọc & Email nhắc lịch hàng tuần:\n• Mở Quản lý đọc (/reading-management) để đặt mục tiêu phút/buổi mỗi tuần và lịch gửi email nhắc đọc cho bé.\n• Kiểm tra email đã xác minh trong Hồ sơ ba mẹ (/profile) nếu chưa nhận được thư.",
    replyEn:
      "Weekly reading goals & email reminders:\n• Open Reading Management (/reading-management) to set weekly targets and scheduled email reminders.\n• Verify your email address in Parent Profile (/profile) if reminder emails do not arrive.",
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
  {
    keywords: ["micro", "mic", "camera", "quyen", "khong nghe", "permission"],
    replyVi:
      "Chế độ ngoại tuyến — Khắc phục nhanh Micro / Camera:\n• Chọn hồ sơ bé rồi mở Chuẩn bị buổi đọc (/reading-preparation) để kiểm tra nhanh micro trước khi vào buổi đọc.\n• Bấm biểu tượng ổ khóa trên thanh địa chỉ → Cho phép Microphone & Camera → tải lại trang.\n• Đóng ứng dụng gọi video khác đang chiếm micro.",
    replyEn:
      "Offline quick guide — Mic / Camera fix:\n• Select a child profile and open Reading Preparation (/reading-preparation) to test your mic before reading.\n• Click the browser lock icon → Allow Microphone & Camera → reload.\n• Close any other app using your microphone.",
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
      "Quét sách (/book-scanner) vs Sách của tôi (/my-books):\n• **Quét sách (/book-scanner)**: chụp nhanh từng trang sách giấy bằng camera, phẳng và đủ sáng để đọc ngay.\n• **Sách của tôi (/my-books)**: tải nhiều ảnh/PDF/DOCX của gia đình, chỉnh sửa nội dung OCR và tạo minh họa Smart Studio.\n• Trang quét khi mất mạng sẽ được giữ trong Hàng chờ OCR để xử lý sau.",
    replyEn:
      "Book Scanner (/book-scanner) vs My Books (/my-books):\n• **Book Scanner (/book-scanner)**: snap flat, well-lit paper pages with your camera for immediate reading.\n• **My Books (/my-books)**: upload multi-page images/PDF/DOCX, refine OCR text, and manage Smart Studio art.\n• Offline scans stay safely in the OCR queue.",
    actions: [
      { labelVi: "Quét sách", labelEn: "Book Scanner", href: "/book-scanner" },
      { labelVi: "Sách của tôi", labelEn: "My Books", href: "/my-books" },
    ],
  },
  {
    keywords: [
      "karaoke",
      "giai tri",
      "tro choi",
      "mo ta tranh",
      "ghep cau",
      "memory game",
      "lat the",
      "game",
      "luoi doc",
      "chan doc",
      "reluctant",
    ],
    replyVi:
      "Gợi ý Góc giải trí (/entertainment) cho bé hào hứng hơn:\n• Karaoke thiếu nhi (/karaoke): luyện nhịp điệu và phát âm vui nhộn.\n• Memory Game lật thẻ (/entertainment/memory-game): nhớ mặt chữ qua cặp thẻ.\n• Ghép câu (/entertainment/sentence-shooter) & Mô tả tranh AI (/entertainment/picture-description): tăng phản xạ đặt câu.",
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
      "Chế độ ngoại tuyến — Tài khoản & Mật khẩu:\n• Quên mật khẩu: mở /forgot-password và mở liên kết trong email trên cùng trình duyệt.\n• Đổi mật khẩu khi đã đăng nhập: mở menu tài khoản → Cài đặt (/settings).",
    replyEn:
      "Offline quick guide — Account & Password:\n• Forgot password: open /forgot-password and open the link in the same browser.\n• Signed-in password change: Account Menu → Settings (/settings).",
    actions: [
      { labelVi: "Đăng nhập", labelEn: "Sign in", href: "/login" },
      { labelVi: "Cài đặt", labelEn: "Settings", href: "/settings" },
    ],
  },
  {
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
    keywords: [
      "tien bo",
      "bao cao",
      "tu kho",
      "tu can luyen",
      "lich su",
      "report",
    ],
    replyVi:
      "Chế độ ngoại tuyến — Tiến bộ & Từ cần luyện:\n• Xem 4 chỉ số (Đọc đúng, Trôi chảy, Hiểu bài, Thói quen) tại Tiến bộ (/reports).\n• Ôn lại các từ bé đọc nhầm tại Từ cần luyện (/reports/difficult-words) và xem buổi cũ tại Lịch sử (/sessions).",
    replyEn:
      "Offline quick guide — Progress & Difficult Words:\n• View Accuracy, Fluency, Comprehension, and Habit trends in Progress (/reports).\n• Drill tricky words at Difficult Words (/reports/difficult-words) and review past sessions at /sessions.",
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
    keywords: ["tac vu ai", "tien trinh ai", "studio tasks", "global task"],
    replyVi:
      "Chế độ ngoại tuyến — Trung tâm tác vụ AI (/studio/tasks):\n• Theo dõi tiến trình quét OCR, tạo ảnh bìa/minh họa Smart Studio và audio trên thanh nổi tác vụ AI hoặc trang /studio/tasks.",
    replyEn:
      "Offline quick guide — AI Task Center (/studio/tasks):\n• Track OCR scans, Smart Studio illustrations, and audio jobs inside /studio/tasks.",
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
    keywords: ["giong doc", "khoa giong", "voice lock", "giong mau"],
    replyVi:
      "Chế độ ngoại tuyến — Khóa giọng đọc theo buổi:\n• Trong lúc buổi đọc đang chạy, giọng mẫu được khóa để bé nghe ổn định. Bạn có thể chọn giọng Bắc/Trung/Nam trong Cài đặt (/settings) hoặc Chuẩn bị buổi đọc (/reading-preparation) trước buổi mới.",
    replyEn:
      "Offline quick guide — Session Voice Lock:\n• Model voice stays locked mid-session for consistency. Update regional voice preferences in Settings (/settings) or Reading Preparation (/reading-preparation) before a new session.",
    actions: [
      { labelVi: "Cài đặt", labelEn: "Settings", href: "/settings" },
      {
        labelVi: "Chuẩn bị đọc",
        labelEn: "Reading Prep",
        href: "/reading-preparation",
      },
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
    {
      phrases: [
        "doi mat khau",
        "thay doi mat khau",
        "change password",
        "cai dat",
        "bang thong",
        "tiet kiem du lieu",
        "bandwidth",
      ],
      href: "/settings",
      scenarioId: "account_settings",
      labelVi: "Đi đến trang Cài đặt tài khoản",
      labelEn: "Go to Account Settings",
      reasonVi:
        "Mở Cài đặt để đổi mật khẩu và tùy chỉnh cho chính tài khoản bạn.",
      reasonEn:
        "Update your password and account preferences safely in Settings.",
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
        "nhac doc",
        "muc tieu tuan",
        "quan ly doc",
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
      phrases: ["tien bo", "bao cao", "progress", "reports"],
      href: "/reports",
      scenarioId: "progress_reports",
      labelVi: "Đi đến Báo cáo tiến bộ",
      labelEn: "Go to Progress Reports",
      reasonVi: "Xem 4 chỉ số tiến bộ đọc của bé.",
      reasonEn: "Review your child's 4 reading progress metrics.",
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
      ],
      href: "/my-books",
      scenarioId: "scanner_vs_my_books",
      labelVi: "Đi đến Sách của tôi",
      labelEn: "Go to My Books",
      reasonVi: "Tải sách ảnh/PDF/DOCX gia đình và quản lý nội dung OCR.",
      reasonEn: "Upload family books (images/PDF/DOCX) and manage OCR.",
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
      phrases: ["karaoke"],
      href: "/karaoke",
      scenarioId: "game_suggestions",
      labelVi: "Đi đến Karaoke thiếu nhi",
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
      ],
      href: "/reading-preparation",
      scenarioId: "mic_camera_permissions",
      labelVi: "Đi đến Chuẩn bị buổi đọc",
      labelEn: "Go to Reading Preparation",
      reasonVi: "Kiểm tra nhanh micro, giọng đọc mẫu và phạm vi trang.",
      reasonEn: "Check microphone, model voice, and page range before reading.",
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
  const roleScope: AssistantRoleScope = isAuthPath(pathname)
    ? "public"
    : isAdminPath(pathname)
      ? "admin"
      : "parent";

  const asksOtherUser =
    folded.includes("nguoi dung khac") ||
    folded.includes("tai khoan khac") ||
    folded.includes("phu huynh khac") ||
    folded.includes("be nha khac") ||
    folded.includes("nguoi khac") ||
    folded.includes("another user") ||
    folded.includes("other parent") ||
    folded.includes("someone else");
  const lowerRaw = message.toLowerCase();
  const asksForbiddenAdmin =
    roleScope !== "admin" &&
    (lowerRaw.includes("/admin") ||
      folded === "admin" ||
      folded.startsWith("admin ") ||
      folded.includes("trang admin") ||
      folded.includes("vao admin") ||
      folded.includes("mo admin") ||
      folded.includes("sang admin") ||
      folded.includes("trang quan tri") ||
      folded.includes("admin dashboard") ||
      folded.includes("admin panel"));
  if (asksOtherUser || asksForbiddenAdmin) {
    return {
      reply: useEn
        ? "For security and family privacy, I can only help and navigate within your own authorized ViRead pages — never admin areas or another user's account."
        : "Vì bảo mật và quyền riêng tư gia đình, mình chỉ có thể hỗ trợ và điều hướng trong phạm vi các trang của chính tài khoản bạn — không thể sang trang quản trị hay tài khoản của người dùng khác nhé!",
      source_tier: "offline",
      provider_id: "viread_scope_guard",
      model_id: null,
      bandwidth_applied: bandwidth,
      latency_ms: 1,
      cached: false,
      role_scope: roleScope,
      quick_actions: pageGuide.actions.slice(0, 2),
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
          actions.length > 0 ? actions : pageGuide.actions.slice(0, 2),
        suggested_prompts: pageGuide.prompts,
        navigation_offer: navigationOffer,
      };
    }
  }

  return {
    reply: useEn
      ? "You appear to be offline or the assistant server is unreachable right now. You can still browse ViRead quick tips using the page suggestions below, or retry once your connection is back."
      : "Hiện thiết bị đang ngoại tuyến hoặc máy chủ trợ lý tạm gián đoạn. Bạn vẫn có thể hỏi về chọn hồ sơ bé, micro/camera, quét sách, báo cáo tiến bộ, hoặc bấm thử lại khi có mạng ổn định nhé.",
    source_tier: "offline",
    provider_id: "viread_offline_guide",
    model_id: null,
    bandwidth_applied: bandwidth,
    latency_ms: 1,
    cached: false,
    role_scope: roleScope,
    quick_actions: pageGuide.actions.slice(0, 2),
    suggested_prompts: pageGuide.prompts,
    navigation_offer: navigationOffer,
  };
}
