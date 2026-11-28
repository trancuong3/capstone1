from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import re
import unicodedata
from typing import Literal, Sequence

from app.schemas.assistant import (
    AssistantNavigationOffer,
    AssistantQuickAction,
    AssistantRoleScope,
    BandwidthProfile,
    sanitize_current_path,
)


@dataclass(frozen=True)
class KbAction:
    label_vi: str
    label_en: str
    href: str


@dataclass(frozen=True)
class KbArticle:
    id: str
    title_vi: str
    title_en: str
    scopes: frozenset[AssistantRoleScope]
    route_prefixes: tuple[str, ...]
    keywords: tuple[str, ...]
    short_answer_vi: str
    detailed_answer_vi: str
    short_answer_en: str
    detailed_answer_en: str
    actions: tuple[KbAction, ...] = ()
    followups_vi: tuple[str, ...] = ()
    followups_en: tuple[str, ...] = ()


@dataclass(frozen=True)
class KbMatch:
    article: KbArticle
    score: float
    direct_score: float = 0.0


@dataclass(frozen=True)
class PageContextSpec:
    prefix: str
    scopes: frozenset[AssistantRoleScope]
    title_vi: str
    title_en: str
    greeting_vi: str
    greeting_en: str
    prompts_vi: tuple[str, str, str]
    prompts_en: tuple[str, str, str]
    actions: tuple[KbAction, ...]


_ALL_SCOPES: frozenset[AssistantRoleScope] = frozenset({"public", "parent", "admin"})
_PARENT_SCOPES: frozenset[AssistantRoleScope] = frozenset({"parent", "admin"})
_ADMIN_ONLY: frozenset[AssistantRoleScope] = frozenset({"admin"})


KB_ARTICLES: tuple[KbArticle, ...] = (
    KbArticle(
        id="viread_overview",
        title_vi="Tổng quan về ViRead",
        title_en="About ViRead",
        scopes=_ALL_SCOPES,
        route_prefixes=("/", "/login", "/dashboard"),
        keywords=(
            "viread la gi",
            "gioi thieu viread",
            "viread co nhung chuc nang gi",
            "viread co nhung tinh nang gi",
            "chuc nang viread",
            "tinh nang viread",
            "bat dau voi viread",
            "huong dan su dung viread",
            "huong dan su dung",
            "lam quen viread",
            "what is viread",
            "about viread",
            "getting started with viread",
            "viread overview",
            "viread features",
            "what can i do in viread",
            "what features does viread offer",
        ),
        short_answer_vi=(
            "ViRead đồng hành cùng ba mẹ và bé tiểu học (lớp 1–5) luyện đọc tiếng Việt:\n"
            "• Chọn sách từ thư viện hoặc quét trang sách giấy bằng camera.\n"
            "• Bé đọc to theo từng từ có micro nhận diện giọng nói, đọc mẫu (TTS) và câu hỏi đọc hiểu.\n"
            "• Theo dõi tiến bộ, ôn từ cần luyện, đặt lịch nhắc đọc và chơi trò chơi ngôn ngữ."
        ),
        detailed_answer_vi=(
            "ViRead (ReadAlong Vision) là nền tảng luyện đọc tiếng Việt dành cho gia đình có bé từ lớp 1 đến lớp 5:\n"
            "1. Tạo hồ sơ bé theo từng lớp để lưu tủ sách và tiến độ riêng.\n"
            "2. Chọn sách có sẵn ở mục Sách hoặc quét/tải sách giấy gia đình tại Quét sách / Sách của tôi.\n"
            "3. Cho bé vào buổi đọc tương tác: nhận diện lời đọc từng từ, phát âm mẫu (TTS), hỗ trợ sửa lỗi và câu hỏi đọc hiểu AI Tutor.\n"
            "4. Xem báo cáo Tiến bộ, Lịch sử buổi đọc, luyện Từ cần luyện, đặt mục tiêu & email nhắc đọc tại Quản lý đọc.\n"
            "5. Mở rộng vốn từ qua Góc giải trí: Karaoke thiếu nhi, Ghép câu và Mô tả tranh AI."
        ),
        short_answer_en=(
            "ViRead helps parents and Grade 1–5 children practice Vietnamese reading:\n"
            "• Pick catalog books or scan paper pages with your camera.\n"
            "• Read aloud word-by-word with speech recognition, model voice (TTS), and comprehension quizzes.\n"
            "• Track progress, practice difficult words, set reading reminders, and play language games."
        ),
        detailed_answer_en=(
            "ViRead (ReadAlong Vision) is a family reading companion for Grade 1–5 learners:\n"
            "1. Create individual child profiles by grade to keep bookshelves and reports separate.\n"
            "2. Choose books from the library or scan/upload family books via Book Scanner & My Books.\n"
            "3. Start guided reading sessions with speech recognition, model TTS voice, gentle retries, and AI Tutor comprehension checks.\n"
            "4. Review Progress Reports, Session History, Difficult Words practice, and weekly Reading Management goals & email reminders.\n"
            "5. Reinforce language skills in Entertainment: Karaoke, Sentence Shooter, and Picture Description."
        ),
        actions=(
            KbAction("Về Tổng quan", "Open Dashboard", "/dashboard"),
            KbAction("Mở Trợ giúp & hỗ trợ", "Open Help & Support", "/help-support"),
        ),
        followups_vi=(
            "Làm sao tạo hồ sơ cho bé?",
            "Cách bắt đầu buổi đọc đầu tiên?",
            "Làm sao quét sách giấy bằng camera?",
        ),
        followups_en=(
            "How do I create a child profile?",
            "How do I start a reading session?",
            "How do I scan a paper book?",
        ),
    ),
    KbArticle(
        id="auth_login_register",
        title_vi="Đăng nhập, đăng ký và xác minh tài khoản",
        title_en="Sign in, register, and email verification",
        scopes=_ALL_SCOPES,
        route_prefixes=("/login", "/register", "/forgot-password", "/reset-password"),
        keywords=(
            "dang nhap",
            "dang ky",
            "quen mat khau",
            "dat lai mat khau",
            "khoi phuc mat khau",
            "email xac nhan",
            "xac minh email",
            "khong nhan duoc email xac nhan",
            "dang nhap google",
            "dang nhap facebook",
            "login",
            "register",
            "sign up",
            "sign in",
            "forgot password",
            "reset password",
            "verification email",
            "confirmation email",
        ),
        short_answer_vi=(
            "Hỗ trợ tài khoản ViRead:\n"
            "• Đăng ký mới: mở trang Đăng ký, nhập email + mật khẩu và xác minh liên kết gửi về hộp thư (nhớ kiểm tra mục Thư rác).\n"
            "• Quên mật khẩu: bấm Quên mật khẩu ở trang Đăng nhập và mở liên kết khôi phục trên cùng trình duyệt/thiết bị.\n"
            "• Tài khoản Google/Facebook có thể đăng nhập trực tiếp hoặc đặt thêm mật khẩu trong mục Cài đặt."
        ),
        detailed_answer_vi=(
            "Hướng dẫn đăng nhập, đăng ký và khôi phục mật khẩu trên ViRead:\n"
            "1. Đăng ký: vào /register, điền email thật và mật khẩu, sau đó bấm liên kết xác minh trong email trên cùng trình duyệt vừa đăng ký (ViRead dùng chuẩn bảo mật PKCE).\n"
            "2. Không nhận được email xác nhận: kiểm tra hộp thư rác/Quảng cáo và chắc chắn email nhập đúng chính tả; nếu đang đổi email trong tài khoản, mở Hồ sơ ba mẹ để gửi lại email xác minh.\n"
            "3. Quên mật khẩu: vào /forgot-password, nhập email để nhận liên kết đặt lại mật khẩu.\n"
            "4. Đổi mật khẩu sau khi đăng nhập: mở menu tài khoản → Cài đặt. Với tài khoản đăng nhập bằng Google/Facebook, có thể gửi liên kết đặt mật khẩu qua email."
        ),
        short_answer_en=(
            "ViRead account help:\n"
            "• Register: sign up with your email & password and open the verification link in the same browser.\n"
            "• Forgot password: use Forgot Password on the login page and open the recovery link on the same browser/device.\n"
            "• Google/Facebook accounts can sign in directly or request a password setup link in Settings."
        ),
        detailed_answer_en=(
            "Sign-in, registration, and password recovery on ViRead:\n"
            "1. Register at /register with a valid email, then open the confirmation link in the same browser (ViRead uses PKCE).\n"
            "2. Missing confirmation email? Check Spam/Junk and verify spelling. For pending email changes, open Parent Profile to resend verification.\n"
            "3. Forgot password? Open /forgot-password, enter your account email, and complete reset in the same browser.\n"
            "4. To change your password while signed in, open Account Menu → Settings."
        ),
        actions=(
            KbAction("Trang đăng nhập", "Login page", "/login"),
            KbAction("Quên mật khẩu", "Forgot password", "/forgot-password"),
            KbAction("Cài đặt tài khoản", "Account settings", "/settings"),
        ),
        followups_vi=(
            "Không nhận được email xác nhận thì làm sao?",
            "Làm sao đổi mật khẩu tài khoản?",
            "ViRead có những chức năng gì?",
        ),
        followups_en=(
            "I didn't receive the verification email",
            "How do I change my password?",
            "What can I do in ViRead?",
        ),
    ),
    KbArticle(
        id="child_profiles",
        title_vi="Tạo và quản lý hồ sơ bé",
        title_en="Create and manage child profiles",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/children", "/dashboard", "/profile"),
        keywords=(
            "ho so be",
            "tao ho so",
            "tao ho so be",
            "them be",
            "doi be",
            "chuyen ho so",
            "lop cua be",
            "xoa ho so be",
            "sua ho so be",
            "anh dai dien be",
            "child profile",
            "create child profile",
            "add child",
            "switch child",
        ),
        short_answer_vi=(
            "Cách tạo và đổi hồ sơ bé:\n"
            "• Vào mục Hồ sơ bé (hoặc nút Tạo hồ sơ bé trên Tổng quan) → nhập tên gọi, chọn lớp (1–5) và ảnh đại diện (tùy chọn) → Lưu hồ sơ.\n"
            "• Để chuyển nhanh giữa các bé, bấm chọn hồ sơ trên trang Tổng quan hoặc nút đổi bé trên thanh đầu trang (di động)."
        ),
        detailed_answer_vi=(
            "Mỗi bé có tủ sách, lịch sử đọc, báo cáo tiến bộ và danh sách từ cần luyện riêng:\n"
            "1. Tạo mới: mở menu tài khoản → Hồ sơ bé → bấm Tạo hồ sơ bé (hoặc truy cập /children/new), nhập tên gọi của bé, chọn lớp từ Lớp 1 đến Lớp 5, tải ảnh đại diện nếu muốn rồi bấm Lưu hồ sơ.\n"
            "2. Chỉnh sửa hoặc xóa: vào Hồ sơ bé → chọn thẻ của bé cần sửa để đổi tên, lớp, ảnh đại diện hoặc xóa hồ sơ.\n"
            "3. Chuyển bé trước khi đọc/chơi: chọn đúng hồ sơ bé ở trang Tổng quan (hoặc bộ chuyển nhanh trên điện thoại) để mọi kết quả đọc được ghi đúng cho bé đó."
        ),
        short_answer_en=(
            "Manage child profiles:\n"
            "• Open Child Profiles (or Create Child Profile on Dashboard), enter the child's name and grade (1–5), then save.\n"
            "• Switch between children anytime from Dashboard or the compact mobile top switcher."
        ),
        detailed_answer_en=(
            "Each child profile keeps its own reading history, progress reports, and difficult words:\n"
            "1. Create: open Account Menu → Child Profiles → Create Child Profile (/children/new), fill in name, grade (1–5), optional avatar, and Save.\n"
            "2. Edit or delete: select a child card in Child Profiles to update details or remove the profile.\n"
            "3. Switch child: pick the active child on Dashboard or via the header switcher before starting a reading session or game."
        ),
        actions=(
            KbAction("Mở Hồ sơ bé", "Open Child Profiles", "/children"),
            KbAction("Tạo hồ sơ bé mới", "Create Child Profile", "/children/new"),
        ),
        followups_vi=(
            "Cách chọn sách và bắt đầu buổi đọc?",
            "Làm sao xem báo cáo tiến bộ của bé?",
            "Cách cập nhật hồ sơ ba mẹ?",
        ),
        followups_en=(
            "How do I pick a book and start reading?",
            "How do I view reading progress?",
            "How do I edit my parent profile?",
        ),
    ),
    KbArticle(
        id="parent_profile_settings",
        title_vi="Hồ sơ ba mẹ, cài đặt mật khẩu và ngôn ngữ",
        title_en="Parent profile, password settings, and language",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/profile", "/settings"),
        keywords=(
            "ho so ba me",
            "ho so phu huynh",
            "doi mat khau",
            "so dien thoai",
            "doi email",
            "anh dai dien",
            "doi ngon ngu",
            "chuyen ngon ngu",
            "ngon ngu giao dien",
            "cai dat tai khoan",
            "parent profile",
            "change password",
            "account settings",
            "change language",
            "switch language",
        ),
        short_answer_vi=(
            "Quản lý tài khoản ba mẹ & giao diện:\n"
            "• Sửa tên hiển thị, số điện thoại, ảnh đại diện hoặc yêu cầu đổi email tại Hồ sơ ba mẹ (/profile).\n"
            "• Đổi mật khẩu tại Cài đặt (/settings).\n"
            "• Đổi ngôn ngữ giao diện (11 ngôn ngữ, giữ nguyên nội dung học đọc tiếng Việt) bằng nút chọn ngôn ngữ trên thanh đầu trang hoặc menu tài khoản."
        ),
        detailed_answer_vi=(
            "Các thiết lập tài khoản phụ huynh trên ViRead:\n"
            "1. Hồ sơ ba mẹ (/profile): bấm Chỉnh sửa hồ sơ để cập nhật họ tên, số điện thoại liên hệ, ảnh đại diện hoặc yêu cầu đổi email (email mới chỉ có hiệu lực sau khi xác minh).\n"
            "2. Cài đặt bảo mật (/settings): đổi mật khẩu hiện tại sang mật khẩu mới, hoặc yêu cầu email đặt mật khẩu nếu đăng nhập qua Google/Facebook.\n"
            "3. Ngôn ngữ giao diện: ViRead hỗ trợ 11 ngôn ngữ (Tiếng Việt, English, Français, Deutsch, Español, 日本語, 한국어, 中文, العربية, עברית) mà vẫn giữ nguyên nội dung sách & nhận diện đọc tiếng Việt."
        ),
        short_answer_en=(
            "Parent account & interface settings:\n"
            "• Update display name, contact phone, avatar, or email in Parent Profile (/profile).\n"
            "• Change your password in Settings (/settings).\n"
            "• Switch between 11 UI languages via the language selector in the header or account menu (Vietnamese reading content remains intact)."
        ),
        detailed_answer_en=(
            "Managing your ViRead parent account:\n"
            "1. Parent Profile (/profile): click Edit Profile to update display name, phone number, avatar, or request an email change (requires verification).\n"
            "2. Settings (/settings): change your password or send a password setup link for Google/Facebook accounts.\n"
            "3. Language: switch among 11 supported interface languages (including RTL Arabic/Hebrew) while preserving Vietnamese reading and speech pipelines."
        ),
        actions=(
            KbAction("Mở Hồ sơ ba mẹ", "Open Parent Profile", "/profile"),
            KbAction("Mở Cài đặt", "Open Settings", "/settings"),
        ),
        followups_vi=(
            "Làm sao tạo hồ sơ bé?",
            "Cách gửi phản hồi cho đội ngũ ViRead?",
            "Làm sao đặt lịch nhắc đọc qua email?",
        ),
        followups_en=(
            "How do I create a child profile?",
            "How do I contact ViRead support?",
            "How do I set email reading reminders?",
        ),
    ),
    KbArticle(
        id="books_and_reading_start",
        title_vi="Chọn sách, chuẩn bị đọc và bắt đầu buổi đọc",
        title_en="Choose books, reading preparation, and starting a session",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/books", "/reading-preparation", "/dashboard"),
        keywords=(
            "chon sach",
            "thu vien sach",
            "bat dau doc",
            "bat dau buoi doc",
            "chuan bi doc",
            "pham vi doc",
            "pham vi trang doc",
            "doc tiep",
            "choose book",
            "book catalog",
            "start reading",
            "reading preparation",
            "reading session",
        ),
        short_answer_vi=(
            "Các bước bắt đầu buổi đọc cho bé:\n"
            "1. Chọn đúng hồ sơ bé ở Tổng quan.\n"
            "2. Vào mục Sách (/books) hoặc Sách của tôi (/my-books) và chọn cuốn sách phù hợp.\n"
            "3. Tại bước Chuẩn bị đọc, chọn trang bắt đầu/phạm vi đọc, kiểm tra micro rồi bấm Bắt đầu đọc."
        ),
        detailed_answer_vi=(
            "Để bắt đầu một buổi đọc suôn sẻ cùng bé:\n"
            "1. Đảm bảo đã chọn đúng hồ sơ bé ở trang Tổng quan (hoặc bộ chuyển bé ở thanh đầu trang).\n"
            "2. Mở kho Sách (/books) để chọn sách đã được kiểm duyệt, hoặc mở Sách của tôi (/my-books) để đọc sách gia đình tự tải/quét.\n"
            "3. Trong trang chi tiết sách và Chuẩn bị đọc (/reading-preparation), chọn trang hoặc khoảng trang phù hợp với sức đọc của bé.\n"
            "4. Cấp quyền micro khi trình duyệt hỏi và chọn chế độ đọc (đọc đồng hành từng từ, đọc tự động hoặc nghe giọng đọc mẫu) rồi bắt đầu."
        ),
        short_answer_en=(
            "To start a reading session:\n"
            "1. Select the child profile on Dashboard.\n"
            "2. Open Books (/books) or My Books (/my-books) and pick a book.\n"
            "3. In Reading Preparation, pick the page range, check the microphone, and start reading."
        ),
        detailed_answer_en=(
            "Starting a reading session on ViRead:\n"
            "1. Confirm the active child profile on Dashboard.\n"
            "2. Browse the verified Books library (/books) or your private uploads in My Books (/my-books).\n"
            "3. Choose starting pages/range in Reading Preparation (/reading-preparation), verify microphone permission, and launch the reader.\n"
            "4. You can resume unfinished sessions anytime from the Dashboard Reading Desk."
        ),
        actions=(
            KbAction("Mở kho Sách", "Browse Books", "/books"),
            KbAction("Mở Sách của tôi", "Open My Books", "/my-books"),
        ),
        followups_vi=(
            "Micro không nhận giọng bé phải làm sao?",
            "Cách dùng giọng đọc mẫu và chế độ đọc?",
            "Làm sao xem câu hỏi đọc hiểu sau khi đọc?",
        ),
        followups_en=(
            "Microphone isn't picking up my child's voice",
            "How do reading modes and model voice work?",
            "How do comprehension questions work?",
        ),
    ),
    KbArticle(
        id="active_reading_controls",
        title_vi="Hướng dẫn màn hình đọc, giọng đọc mẫu và sửa từ sai",
        title_en="Active reading screen, model voice (TTS), and word retries",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/reading",),
        keywords=(
            "man hinh doc",
            "che do doc",
            "giong doc mau",
            "doc mau",
            "tts",
            "stt",
            "nhan dien giong noi",
            "tu doc nham",
            "doc sai",
            "thu lai tu",
            "tam dung",
            "ket thuc buoi doc",
            "autopilot",
            "tu dong doc",
            "reading screen",
            "model voice",
            "speech recognition",
            "pause reading",
            "pronunciation",
        ),
        short_answer_vi=(
            "Trong màn hình đọc (/reading):\n"
            "• Chữ đang cần đọc được tô sáng theo từng từ; bé đọc rõ từng cụm từ gần micro.\n"
            "• Bấm Giọng đọc để chọn giọng đọc mẫu (TTS) và nghe đọc từng từ khó.\n"
            "• Nếu bé đọc nhầm, ViRead gợi ý bé thử lại nhẹ nhàng và ghi nhận vào mục Từ cần luyện sau buổi đọc.\n"
            "• Dùng Tạm dừng khi bé nghỉ và Hoàn thành để lưu kết quả & mở câu hỏi đọc hiểu."
        ),
        detailed_answer_vi=(
            "Sử dụng hiệu quả màn hình đọc tương tác của ViRead:\n"
            "1. Theo dõi từ tô sáng: ViRead tự động cuộn theo vị trí bé đang đọc (hỗ trợ cả văn xuôi và thơ).\n"
            "2. Nhận diện giọng nói (STT): hỗ trợ chạy trực tiếp trên thiết bị (WebAssembly sherpa-onnx) để phản hồi nhanh và giảm độ trễ mạng; nên ngồi nơi yên tĩnh, cách micro 20–30 cm.\n"
            "3. Giọng đọc mẫu (TTS): bấm nút Giọng đọc để đổi giọng mẫu hoặc bấm vào từ khó để bé nghe đọc lại từng tiếng.\n"
            "4. Thử lại & đồng hành: khi bé ngập ngừng hoặc đọc sai, hệ thống nhắc nhẹ để bé đọc lại tối đa vài lượt rồi cho qua mượt mà để bé không nản, đồng thời lưu từ đó vào Từ cần luyện.\n"
            "5. Kết thúc buổi đọc: bấm Hoàn thành để lưu tiến độ và mở bài tập đọc hiểu AI Tutor."
        ),
        short_answer_en=(
            "Inside the reading screen:\n"
            "• The active word highlights as your child reads aloud clearly near the mic.\n"
            "• Tap Model Voice to switch TTS voices or hear any tricky word pronounced.\n"
            "• Mispronounced words trigger gentle retries and are saved to Difficult Words.\n"
            "• Use Pause for breaks and Finish to save progress and unlock comprehension questions."
        ),
        detailed_answer_en=(
            "Making the most of the ViRead reading screen:\n"
            "1. Word highlighting & auto-scroll track progress for both prose and poetry.\n"
            "2. Speech recognition supports on-device WebAssembly (sherpa-onnx) for low-latency feedback; keep background noise low.\n"
            "3. Tap Voice to pick a model TTS voice or tap individual words to hear pronunciation.\n"
            "4. Tricky words prompt gentle retries and are automatically collected in Difficult Words for later practice.\n"
            "5. Tap Finish to save the session report and open AI Tutor comprehension questions."
        ),
        actions=(
            KbAction("Kiểm tra quyền thiết bị", "Check Device Permissions", "/device-permissions"),
            KbAction("Mở Từ cần luyện", "Open Difficult Words", "/reports/difficult-words"),
        ),
        followups_vi=(
            "Micro không thu được giọng bé thì kiểm tra gì?",
            "Làm sao ôn lại các từ bé đọc nhầm?",
            "Báo cáo sau buổi đọc gồm những gì?",
        ),
        followups_en=(
            "How do I fix microphone issues?",
            "How do we practice missed words?",
            "What is shown in the session report?",
        ),
    ),
    KbArticle(
        id="device_permissions_mic_camera",
        title_vi="Khắc phục lỗi micro, camera và quyền thiết bị",
        title_en="Troubleshooting microphone, camera, and device permissions",
        scopes=_ALL_SCOPES,
        route_prefixes=("/device-permissions", "/reading", "/book-scanner", "/entertainment"),
        keywords=(
            "micro",
            "microphone",
            "camera",
            "quyen thiet bi",
            "cap quyen",
            "cap quyen micro",
            "cap quyen camera",
            "khong nghe",
            "khong thu tieng",
            "khong mo duoc camera",
            "khong nhan giong",
            "loi micro",
            "loi camera",
            "loi am thanh",
            "device permissions",
            "mic not working",
            "camera not working",
        ),
        short_answer_vi=(
            "Khắc phục nhanh lỗi Micro / Camera:\n"
            "1. Mở trang Quyền thiết bị (/device-permissions) để kiểm tra trạng thái Micro và Camera ngay trong ViRead.\n"
            "2. Bấm biểu tượng ổ khóa trên thanh địa chỉ trình duyệt → chọn Cho phép (Allow) cho Microphone/Camera rồi tải lại trang.\n"
            "3. Đảm bảo đang truy cập qua HTTPS (hoặc localhost) và không có ứng dụng khác (Zoom, Meet, ghi âm) đang chiếm micro."
        ),
        detailed_answer_vi=(
            "Hướng dẫn xử lý khi Micro hoặc Camera không hoạt động trên ViRead:\n"
            "1. Kiểm tra nhanh tại /device-permissions để xem trình duyệt đang Cấp phép, Từ chối hay chưa hỏi.\n"
            "2. Trên Chrome/Edge máy tính: bấm biểu tượng cài đặt bên trái thanh URL → bật Microphone & Camera → tải lại trang.\n"
            "3. Trên điện thoại (Safari iOS / Chrome Android / ứng dụng ViRead Android): vào Cài đặt điện thoại → Ứng dụng → chọn trình duyệt hoặc ViRead → Quyền → bật Micro & Máy ảnh.\n"
            "4. Kiểm tra kết nối: trình duyệt chỉ cấp quyền micro/camera trên trang HTTPS (hoặc localhost khi chạy nội bộ) và khi không bị ứng dụng gọi video khác chiếm dụng."
        ),
        short_answer_en=(
            "Quick Mic / Camera fixes:\n"
            "1. Open Device Permissions (/device-permissions) to test mic and camera status.\n"
            "2. Click the browser address-bar lock/settings icon → set Microphone & Camera to Allow, then reload.\n"
            "3. Confirm you are on HTTPS (or localhost) and no other app is holding the microphone."
        ),
        detailed_answer_en=(
            "Troubleshooting Microphone and Camera access in ViRead:\n"
            "1. Visit /device-permissions to inspect current permission states.\n"
            "2. Desktop Chrome/Edge: click the site-settings icon next to the URL, enable Microphone & Camera, and refresh.\n"
            "3. Mobile (iOS Safari / Android Chrome / ViRead Android app): open OS Settings → Apps → Browser/ViRead → Permissions → allow Microphone & Camera.\n"
            "4. Browsers require HTTPS (or localhost) and exclusive mic access (close Zoom/Meet/recording apps)."
        ),
        actions=(
            KbAction("Kiểm tra Quyền thiết bị", "Open Device Permissions", "/device-permissions"),
            KbAction("Mở Trợ giúp & hỗ trợ", "Open Help & Support", "/help-support"),
        ),
        followups_vi=(
            "Cách quét sách giấy cho rõ chữ?",
            "Màn hình đọc dùng nhận diện giọng nói thế nào?",
            "Gửi báo lỗi kỹ thuật cho đội ngũ ViRead?",
        ),
        followups_en=(
            "Tips for scanning paper book pages clearly?",
            "How does on-device speech recognition work?",
            "How do I report a technical issue?",
        ),
    ),
    KbArticle(
        id="book_scanner_and_my_books",
        title_vi="Quét sách giấy (OCR) và Sách của tôi",
        title_en="Book Scanner (OCR) and My Books",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/book-scanner", "/my-books"),
        keywords=(
            "quet sach",
            "scan sach",
            "ocr",
            "sach cua toi",
            "sach rieng",
            "tai sach",
            "upload sach",
            "pdf",
            "docx",
            "chup trang sach",
            "hang cho ocr",
            "offline ocr",
            "dong gop ocr",
            "book scanner",
            "my books",
            "private book",
            "scan page",
            "upload pdf",
        ),
        short_answer_vi=(
            "Quét sách giấy & quản lý Sách của tôi:\n"
            "• Vào Quét sách (/book-scanner) để chụp nhanh trang sách giấy hoặc vào Sách của tôi (/my-books) để tải nhiều trang ảnh/PDF/DOCX thành cuốn sách riêng cho gia đình.\n"
            "• Mẹo chụp rõ chữ: đặt sách phẳng, đủ sáng, tránh bóng tay và chụp thẳng góc.\n"
            "• Nếu máy chủ OCR tạm ngoại tuyến, trang quét sẽ tự lưu vào Hàng chờ OCR và xử lý tự động khi hệ thống bật lại."
        ),
        detailed_answer_vi=(
            "ViRead hỗ trợ số hóa sách giấy gia đình qua hai khu vực:\n"
            "1. Quét sách (/book-scanner): chụp trực tiếp trang sách bằng camera hoặc chọn ảnh (JPG, PNG, WebP) để trích xuất văn bản tiếng Việt nhanh.\n"
            "2. Sách của tôi (/my-books): tạo cuốn sách riêng tư cho gia đình, tải nhiều ảnh trang sách hoặc tệp PDF/DOCX (tối đa 30 trang/cuốn), mở chi tiết cuốn sách để chỉnh sửa chữ nhận diện, thêm/bớt trang hoặc xóa sách riêng bất cứ lúc nào.\n"
            "3. Hàng chờ OCR ngoại tuyến (Offline OCR Queue): nếu worker OCR tạm bận hoặc mất kết nối, tác vụ được giữ an toàn trong Trung tâm tác vụ (góc trên thanh điều hướng) mà không mất ảnh đã tải.\n"
            "4. Đóng góp cải thiện OCR: ba mẹ có thể chủ động gửi bản sửa chữ đã kiểm tra để giúp nâng cao độ chính xác nhận diện tiếng Việt (tùy chọn, hoàn toàn tôn trọng quyền riêng tư)."
        ),
        short_answer_en=(
            "Scanning paper books & My Books:\n"
            "• Use Book Scanner (/book-scanner) to capture paper pages or My Books (/my-books) to upload images/PDF/DOCX as a private family book.\n"
            "• For best OCR accuracy: keep pages flat, well-lit, and shoot straight-on.\n"
            "• If the OCR worker is temporarily offline, pages stay safely in the Offline OCR Queue."
        ),
        detailed_answer_en=(
            "Digitizing your own paper books in ViRead:\n"
            "1. Book Scanner (/book-scanner): capture a page with your camera or upload JPEG/PNG/WebP images for Vietnamese OCR.\n"
            "2. My Books (/my-books): create private family books from multiple images, PDF, or DOCX files, review extracted text, and read them with your child.\n"
            "3. Offline OCR Queue: if the OCR server is paused, uploads wait safely in the Global Task Center without losing progress.\n"
            "4. Optional OCR contribution: parents may opt in to share corrected text snippets to improve Vietnamese OCR accuracy."
        ),
        actions=(
            KbAction("Mở Quét sách", "Open Book Scanner", "/book-scanner"),
            KbAction("Mở Sách của tôi", "Open My Books", "/my-books"),
        ),
        followups_vi=(
            "Làm sao báo lỗi chữ sai trong sách thư viện?",
            "Camera không mở được khi quét sách?",
            "Cách bắt đầu buổi đọc từ sách vừa tải?",
        ),
        followups_en=(
            "How do I report a typo in a library book?",
            "Camera won't open in Book Scanner",
            "How do I start reading my uploaded book?",
        ),
    ),
    KbArticle(
        id="reports_sessions_difficult_words",
        title_vi="Báo cáo tiến bộ, lịch sử đọc và ôn từ cần luyện",
        title_en="Progress reports, reading history, and difficult words practice",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/reports", "/sessions"),
        keywords=(
            "bao cao",
            "tien bo",
            "lich su doc",
            "phien doc",
            "tu can luyen",
            "tu kho",
            "on tu",
            "luyen phat am",
            "diem doc",
            "troi chay",
            "doc hieu",
            "thoi quen",
            "progress report",
            "reading history",
            "session report",
            "difficult words",
        ),
        short_answer_vi=(
            "Theo dõi kết quả & ôn tập cho bé:\n"
            "• Tiến bộ (/reports): xem điểm tổng hợp 4 mặt (Đọc đúng, Trôi chảy, Hiểu bài, Thói quen) và xu hướng so với kỳ trước.\n"
            "• Lịch sử (/sessions): mở lại từng buổi đọc đã hoàn thành cùng báo cáo chi tiết.\n"
            "• Từ cần luyện (/reports/difficult-words): gom các từ bé hay đọc nhầm hoặc bỏ sót để bé nghe mẫu và luyện phát âm lại."
        ),
        detailed_answer_vi=(
            "Bộ công cụ theo dõi học tập minh bạch trên ViRead:\n"
            "1. Báo cáo Tiến bộ (/reports): hiển thị số buổi đọc, thời lượng, tỷ lệ đọc đúng, độ trôi chảy, điểm đọc hiểu và xu hướng tăng/giảm theo kỳ. Khi chưa đủ dữ liệu, ViRead ghi rõ trạng thái chưa đủ dữ liệu thay vì tự suy đoán.\n"
            "2. Lịch sử đọc (/sessions): danh sách các buổi đọc theo từng bé; bấm vào từng phiên để xem báo cáo chi tiết (/sessions/[id]/report).\n"
            "3. Từ cần luyện (/reports/difficult-words): liệt kê từ bé từng đọc nhầm, ngập ngừng hoặc bỏ qua, cho phép bé nghe giọng đọc mẫu và đọc lại với micro tự động cho tới khi thành thạo."
        ),
        short_answer_en=(
            "Tracking progress & practicing tough words:\n"
            "• Progress (/reports): view Accuracy, Fluency, Comprehension, and Habit trends.\n"
            "• History (/sessions): review completed sessions and detailed post-reading reports.\n"
            "• Difficult Words (/reports/difficult-words): drill words your child missed or mispronounced with audio playback and mic checks."
        ),
        detailed_answer_en=(
            "ViRead learning analytics & reinforcement:\n"
            "1. Progress Reports (/reports): tracks sessions, reading minutes, accuracy, fluency, comprehension, and period-over-period trends (keeping insufficient data explicitly unmarked rather than guessing).\n"
            "2. Session History (/sessions): review every completed session and open full session reports.\n"
            "3. Difficult Words (/reports/difficult-words): automatically gathers tricky words so your child can hear model pronunciation and practice speaking them aloud."
        ),
        actions=(
            KbAction("Xem Tiến bộ", "Open Progress", "/reports"),
            KbAction("Ôn Từ cần luyện", "Practice Difficult Words", "/reports/difficult-words"),
            KbAction("Xem Lịch sử đọc", "Open Reading History", "/sessions"),
        ),
        followups_vi=(
            "Làm sao đặt mục tiêu đọc hàng tuần?",
            "Câu hỏi đọc hiểu AI Tutor hoạt động thế nào?",
            "Cách luyện phát âm từ khó bằng micro?",
        ),
        followups_en=(
            "How do I set weekly reading goals?",
            "How does the AI Tutor comprehension quiz work?",
            "How do we practice difficult words?",
        ),
    ),
    KbArticle(
        id="reading_management_reminders",
        title_vi="Quản lý đọc, mục tiêu tuần và email nhắc đọc",
        title_en="Reading management, weekly goals, and email reminders",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/reading-management",),
        keywords=(
            "quan ly doc",
            "muc tieu",
            "lich doc",
            "nhac doc",
            "email nhac doc",
            "ke hoach doc",
            "sach da luu",
            "thoi quen doc",
            "reading management",
            "reading goal",
            "reminder",
            "schedule",
            "email reminder",
        ),
        short_answer_vi=(
            "Quản lý thói quen đọc tại Quản lý đọc (/reading-management):\n"
            "• Đặt mục tiêu số buổi/phút đọc hàng tuần cho từng bé.\n"
            "• Tạo lịch nhắc đọc theo khung giờ và ngày trong tuần; ViRead gửi email nhắc tự động tới địa chỉ email đã xác minh của ba mẹ.\n"
            "• Quản lý danh sách sách đã lưu để mở nhanh cho các buổi đọc tiếp theo."
        ),
        detailed_answer_vi=(
            "Trang Quản lý đọc (/reading-management) giúp duy trì thói quen đọc đều đặn:\n"
            "1. Mục tiêu tuần: thiết lập mục tiêu số buổi hoặc số phút đọc mỗi tuần cho từng hồ sơ bé.\n"
            "2. Lịch nhắc đọc qua email: chọn giờ nhắc, múi giờ và các ngày trong tuần. Ba mẹ có thể bật/tắt tạm dừng hoặc xóa lịch nhắc ngay trên thẻ lịch nhắc; email chỉ gửi đến địa chỉ đã xác minh và hiển thị trạng thái lần gửi.\n"
            "3. Tủ sách đã lưu: đánh dấu những cuốn sách ba mẹ muốn bé đọc trong tuần."
        ),
        short_answer_en=(
            "Build a reading habit in Reading Management (/reading-management):\n"
            "• Set weekly session/minute reading goals per child.\n"
            "• Schedule recurring email reminders sent to your verified parent email.\n"
            "• Keep bookmarked books ready for upcoming sessions."
        ),
        detailed_answer_en=(
            "Reading Management (/reading-management) keeps family reading consistent:\n"
            "1. Weekly Goals: define target sessions or reading minutes per child.\n"
            "2. Email Reminders: pick days, time, and timezone. Reminders deliver to your verified account email and display delivery status.\n"
            "3. Saved Books: bookmark books you want your child to read next."
        ),
        actions=(
            KbAction("Mở Quản lý đọc", "Open Reading Management", "/reading-management"),
            KbAction("Kiểm tra Hồ sơ ba mẹ", "Check Parent Profile", "/profile"),
        ),
        followups_vi=(
            "Tại sao chưa nhận được email nhắc đọc?",
            "Làm sao xem báo cáo thói quen đọc của bé?",
            "Góc giải trí có trò chơi nào cho bé?",
        ),
        followups_en=(
            "Why didn't I receive a reading reminder email?",
            "How do I view habit progress?",
            "What games are in Entertainment?",
        ),
    ),
    KbArticle(
        id="entertainment_games_karaoke",
        title_vi="Góc giải trí: Karaoke, Lật thẻ ghi nhớ, Ghép câu và Mô tả tranh AI",
        title_en="Entertainment: Karaoke, Memory Game, Sentence Shooter, and Picture Description",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/entertainment", "/karaoke"),
        keywords=(
            "giai tri",
            "goc giai tri",
            "karaoke",
            "hat karaoke",
            "bai hat karaoke",
            "memory game",
            "lat the",
            "the ghi nho",
            "tro choi lat the",
            "ghep cau",
            "sentence shooter",
            "mo ta tranh",
            "ke chuyen theo tranh",
            "picture description",
            "entertainment",
            "language games",
        ),
        short_answer_vi=(
            "Góc giải trí (/entertainment) có 4 hoạt động vừa học vừa chơi cho bé:\n"
            "• Karaoke thiếu nhi (/karaoke): hát theo lời chạy khớp nhịp giúp bé luyện phát âm & nhịp điệu.\n"
            "• Memory Game lật thẻ (/entertainment/memory-game): lật cặp thẻ chữ/hình tương ứng để rèn trí nhớ từ vựng và phản xạ mặt chữ.\n"
            "• Ghép câu (/entertainment/sentence-shooter): sắp xếp từ thành câu tiếng Việt hoàn chỉnh.\n"
            "• Mô tả tranh AI (/entertainment/picture-description): bé nhìn tranh, nói hoặc nhập câu kể chuyện và nhận nhận xét, gợi ý từ vựng + sao khen ngợi."
        ),
        detailed_answer_vi=(
            "Khám phá 4 hoạt động trong Góc giải trí (/entertainment):\n"
            "1. Karaoke (/karaoke): chọn bài hát thiếu nhi, nghe nhạc nền và đọc/hát theo từng chữ tô sáng khớp thời gian.\n"
            "2. Memory Game lật thẻ (/entertainment/memory-game): tìm và ghép các cặp thẻ tương ứng để luyện ghi nhớ mặt chữ tiếng Việt, từ vựng và sự tập trung.\n"
            "3. Ghép câu — Sentence Shooter (/entertainment/sentence-shooter): rèn cấu trúc câu và ngữ pháp tiếng Việt qua từng vòng chơi sinh động.\n"
            "4. Mô tả tranh AI (/entertainment/picture-description): chọn tranh mẫu hoặc tải ảnh tranh lên, bé quan sát và kể lại bằng lời; AI gợi ý từ vựng, chấm điểm 1–10 (tối đa 3 sao) và khuyên cách mở rộng câu hay hơn."
        ),
        short_answer_en=(
            "Entertainment (/entertainment) offers 4 playful language activities:\n"
            "• Karaoke (/karaoke): sing along with synchronized lyrics.\n"
            "• Memory Game (/entertainment/memory-game): flip and match pairs to build vocabulary & character recall.\n"
            "• Sentence Shooter (/entertainment/sentence-shooter): build complete Vietnamese sentences.\n"
            "• Picture Description (/entertainment/picture-description): describe pictures and get AI vocabulary hints, stars, and friendly feedback."
        ),
        detailed_answer_en=(
            "Four learning games inside Entertainment (/entertainment):\n"
            "1. Karaoke (/karaoke): synchronized Vietnamese children's songs for rhythm and articulation.\n"
            "2. Memory Game (/entertainment/memory-game): card-flip matching game for Vietnamese word memory and focus.\n"
            "3. Sentence Shooter (/entertainment/sentence-shooter): arrange words into well-formed sentences.\n"
            "4. Picture Description (/entertainment/picture-description): upload or pick an illustration, let your child describe what they see, and receive AI praise, vocabulary tips, and up to 3 stars."
        ),
        actions=(
            KbAction("Mở Góc giải trí", "Open Entertainment", "/entertainment"),
            KbAction("Memory Game lật thẻ", "Open Memory Game", "/entertainment/memory-game"),
            KbAction("Mở Karaoke", "Open Karaoke", "/karaoke"),
        ),
        followups_vi=(
            "Memory Game lật thẻ chơi thế nào?",
            "Mô tả tranh AI chấm điểm như thế nào?",
            "Micro không hoạt động trong trò chơi thì sao?",
        ),
        followups_en=(
            "How do I play Memory Game?",
            "How does Picture Description score answers?",
            "Mic not working during games?",
        ),
    ),
    KbArticle(
        id="ai_tutor_comprehension",
        title_vi="AI Tutor & Câu hỏi đọc hiểu sau buổi đọc",
        title_en="AI Tutor & post-reading comprehension quiz",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/reading", "/sessions", "/reports"),
        keywords=(
            "ai tutor",
            "doc hieu",
            "cau hoi doc hieu",
            "trac nghiem",
            "quiz",
            "sau buoi doc",
            "hieu bai",
            "comprehension",
            "tutor",
        ),
        short_answer_vi=(
            "Sau khi bé hoàn thành buổi đọc, ViRead AI Tutor tạo 5–10 câu hỏi đọc hiểu bám sát đúng những trang bé vừa đọc.\n"
            "• Bé có thể trả lời bằng cách chạm đáp án hoặc bằng giọng nói.\n"
            "• Điểm đọc hiểu được lưu tự động vào Báo cáo Tiến bộ và Lịch sử phiên đọc."
        ),
        detailed_answer_vi=(
            "AI Tutor đánh giá mức độ hiểu bài của bé một cách công bằng:\n"
            "1. Sau khi kết thúc buổi đọc, hệ thống tạo bộ câu hỏi trắc nghiệm từ đúng nội dung các trang bé đã đọc (không hỏi ngoài bài).\n"
            "2. Bé có thể chọn đáp án A/B/C/D trực tiếp hoặc trả lời bằng giọng nói, kèm gợi ý trích đoạn liên quan trong sách.\n"
            "3. Kết quả được tổng hợp vào chỉ số Hiểu bài tại trang Tiến bộ (/reports) và báo cáo từng phiên (/sessions)."
        ),
        short_answer_en=(
            "After finishing a reading session, ViRead AI Tutor generates 5–10 comprehension questions strictly grounded in the pages your child just read.\n"
            "• Children can tap answers or respond by voice, and scores feed into Progress Reports."
        ),
        detailed_answer_en=(
            "How ViRead AI Tutor works:\n"
            "1. Once a reading session is completed, ViRead creates grounded multiple-choice questions strictly from the read pages.\n"
            "2. Kids answer via tap or voice with gentle hints tied to the text.\n"
            "3. Accuracy feeds directly into the Comprehension score in Progress Reports (/reports) and Session History (/sessions)."
        ),
        actions=(
            KbAction("Xem Tiến bộ", "View Progress", "/reports"),
            KbAction("Xem Lịch sử đọc", "View Sessions", "/sessions"),
        ),
        followups_vi=(
            "Làm sao xem báo cáo chi tiết buổi đọc?",
            "Cách ôn các từ bé đọc chưa đúng?",
            "Làm sao bắt đầu buổi đọc mới?",
        ),
        followups_en=(
            "How do I view detailed session reports?",
            "How do we practice missed words?",
            "How do I start a new reading session?",
        ),
    ),
    KbArticle(
        id="book_reports_and_support",
        title_vi="Báo lỗi nội dung sách và liên hệ hỗ trợ ViRead",
        title_en="Report book content issues and contact ViRead support",
        scopes=_ALL_SCOPES,
        route_prefixes=("/help-support", "/book-reports"),
        keywords=(
            "bao loi sach",
            "sai chinh ta",
            "bao cao sach",
            "gui phan hoi",
            "lien he ho tro",
            "lien he viread",
            "email ho tro",
            "gop y",
            "bao loi ky thuat",
            "tro giup va ho tro",
            "report book",
            "contact support",
            "send feedback",
            "help and support",
        ),
        short_answer_vi=(
            "Gửi phản hồi hoặc báo lỗi nội dung sách:\n"
            "• Báo lỗi chữ/trang sách trong thư viện: bấm nút báo lỗi ngay trên trang sách hoặc theo dõi các báo cáo tại Báo cáo sách (/book-reports).\n"
            "• Gửi yêu cầu hỗ trợ / góp ý: mở Trợ giúp & hỗ trợ (/help-support) → bấm Gửi phản hồi, hoặc liên hệ trực tiếp email vireadforyou@gmail.com.\n"
            "• Lưu ý bảo mật: tuyệt đối không gửi mật khẩu hay mã xác thực trong nội dung phản hồi."
        ),
        detailed_answer_vi=(
            "Khi phát hiện lỗi chính tả, nhận diện trang sách hoặc gặp sự cố kỹ thuật:\n"
            "1. Báo lỗi nội dung sách: dùng chức năng báo lỗi sách (ghi rõ tên sách, số trang và đoạn chữ sai) và theo dõi trạng thái xử lý tại /book-reports.\n"
            "2. Gửi phản hồi hỗ trợ: vào /help-support → bấm Gửi phản hồi, chọn loại yêu cầu (Báo lỗi kỹ thuật, Hỏi đáp, Góp ý...), nhập tiêu đề, mô tả và email liên hệ.\n"
            "3. Email hỗ trợ chính thức: vireadforyou@gmail.com. Không bao giờ chia sẻ mật khẩu hoặc mã OTP."
        ),
        short_answer_en=(
            "Report book errors or contact ViRead support:\n"
            "• Flag typos or OCR mismatches using the book report dialog and track status at Book Reports (/book-reports).\n"
            "• Send technical issues or feedback via Help & Support (/help-support) or email vireadforyou@gmail.com.\n"
            "• Never include passwords or verification codes in support messages."
        ),
        detailed_answer_en=(
            "Getting help or reporting book issues:\n"
            "1. Book content errors: submit a report specifying book title, page number, and issue, then monitor updates at /book-reports.\n"
            "2. Support feedback: open /help-support → Send Feedback to reach the ViRead team via email.\n"
            "3. Official support email: vireadforyou@gmail.com (never share passwords or OTP codes)."
        ),
        actions=(
            KbAction("Mở Trợ giúp & hỗ trợ", "Open Help & Support", "/help-support"),
            KbAction("Xem Báo cáo sách", "Open Book Reports", "/book-reports"),
        ),
        followups_vi=(
            "Micro/Camera không hoạt động thì kiểm tra gì?",
            "Làm sao đổi mật khẩu tài khoản?",
            "ViRead có những chức năng nào?",
        ),
        followups_en=(
            "How do I fix microphone/camera issues?",
            "How do I change my password?",
            "What features does ViRead include?",
        ),
    ),
    KbArticle(
        id="assistant_bandwidth_tiers",
        title_vi="Cách Trợ lý ViRead hoạt động theo API phân tầng & băng tần",
        title_en="How ViRead Assistant tiered APIs, Ollama, and bandwidth modes work",
        scopes=_ALL_SCOPES,
        route_prefixes=("/", "/dashboard", "/help-support"),
        keywords=(
            "chatbot",
            "tro ly viread",
            "tro ly ai",
            "ollama",
            "bang tan",
            "api phan tang",
            "an tro ly",
            "an chatbot",
            "tiet kiem du lieu",
            "che do ngoai tuyen",
            "viread assistant",
            "bandwidth mode",
            "hide assistant",
        ),
        short_answer_vi=(
            "Trợ lý ViRead dùng kiến trúc phân tầng ưu tiên tốc độ & độ chính xác:\n"
            "• Tầng 0: Bộ nhớ đệm & kho hướng dẫn ViRead nội bộ (<15ms, siêu tiết kiệm băng tần).\n"
            "• Tầng 1: Cloud AI tốc độ cao (Gemini Flash-Lite → Groq LPU) có ngắt mạch tự động khi quá tải.\n"
            "• Tầng 2: Ollama cục bộ làm lớp dự phòng cuối cùng (khi chạy môi trường cục bộ).\n"
            "• Bạn có thể bấm biểu tượng mắt gạch trên tiêu đề khung chat để ẩn trợ lý bất cứ lúc nào, hoặc đổi chế độ băng tần (Tự động / Tiết kiệm / Đầy đủ)."
        ),
        detailed_answer_vi=(
            "Trợ lý ViRead thích ứng tự động theo chất lượng mạng hiện tại của bạn:\n"
            "1. Tầng 0 (Tri thức ViRead & Cache): trả lời gần như tức thì với câu hỏi hướng dẫn quen thuộc và chế độ Tiết kiệm (mạng yếu 2G/3G).\n"
            "2. Tầng 1 (Cloud API phân tầng): ưu tiên Gemini Flash-Lite (chế độ tối thiểu độ trễ) và chuyển dự phòng nhanh sang Groq LPU nếu hết hạn mức.\n"
            "3. Tầng 2 (Ollama cục bộ): tự động đảm nhận làm lớp dự phòng cuối cùng khi Cloud API không khả dụng trên máy có Ollama.\n"
            "4. Ngoại tuyến & Ẩn gọn: mất mạng vẫn tra được hướng dẫn nhanh; bấm nút Ẩn trợ lý để thu gọn hoàn toàn thành tai nhỏ ở mép màn hình."
        ),
        short_answer_en=(
            "ViRead Assistant uses a tiered, bandwidth-aware cascade:\n"
            "• Tier 0: Local cache & grounded ViRead knowledge base (<15ms, ultra-low bandwidth).\n"
            "• Tier 1: Fast Cloud AI (Gemini Flash-Lite → Groq LPU) with circuit breakers.\n"
            "• Tier 2: Local Ollama loopback fallback when available.\n"
            "• Click the Hide icon in the header anytime to tuck the assistant away, or switch Auto / Saver / Full bandwidth mode."
        ),
        detailed_answer_en=(
            "How ViRead Assistant adapts to your connection:\n"
            "1. Tier 0 (KB + Cache): near-instant grounded answers for common guides and Low-bandwidth / Data Saver networks.\n"
            "2. Tier 1 (Cloud LLM APIs): Gemini Flash-Lite with minimal thinking latency, failing over cleanly to Groq LPU on quota limits.\n"
            "3. Tier 2 (Local Ollama): final loopback fallback when cloud APIs are unavailable on local deployments.\n"
            "4. Offline & Hideable: falls back to an offline quick guide with zero network, and hides into a subtle edge tab whenever you prefer."
        ),
        actions=(
            KbAction("Mở Trợ giúp & hỗ trợ", "Open Help & Support", "/help-support"),
        ),
        followups_vi=(
            "ViRead có những tính năng gì chính?",
            "Làm sao bắt đầu buổi đọc cho bé?",
            "Cách kiểm tra quyền micro và camera?",
        ),
        followups_en=(
            "What are ViRead's main features?",
            "How do I start a reading session?",
            "How do I check mic and camera permissions?",
        ),
    ),
    # ------------------------------------------------------------------ Admin-only KB (strictly isolated!)
    KbArticle(
        id="admin_books_ocr_review",
        title_vi="Quản trị kho sách, OCR và duyệt revision VERIFIED",
        title_en="Admin book catalog, OCR review, and VERIFIED revisions",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin/books",),
        keywords=(
            "kho sach",
            "duyet ocr",
            "revision",
            "verified",
            "ai sua",
            "tao sach",
            "upload trang",
            "admin books",
            "ocr review",
            "needs_review",
        ),
        short_answer_vi=(
            "Quy trình quản trị sách & OCR tại /admin/books:\n"
            "1. Tạo sách mới (/admin/books/new) và tải lên ảnh các trang sách.\n"
            "2. Mở chi tiết sách → duyệt từng trang OCR (NEEDS_REVIEW), dùng nút AI sửa nếu cần, chỉnh tay độ chính xác từng từ rồi xác minh thành VERIFIED.\n"
            "3. Sách chỉ đủ điều kiện phê duyệt khi mọi trang hoạt động đều đã hoàn tất OCR, rà soát nội dung và Child Safety."
        ),
        detailed_answer_vi=(
            "Hướng dẫn vận hành Kho sách Quản trị (/admin/books):\n"
            "1. Tạo/Sửa sách: vào /admin/books/new để nhập metadata, bìa sách và tải ảnh từng trang.\n"
            "2. OCR & AI sửa: thao tác Quét OCR và nút AI sửa là hai luồng tách biệt. Sau khi OCR trích xuất, Admin kiểm tra bounding box và văn bản, có thể chạy AI sửa theo lô rồi duyệt thủ công sang trạng thái VERIFIED.\n"
            "3. Xuất bản an toàn: trước khi phê duyệt sách cho thư viện thiếu nhi, đảm bảo mọi trang active có revision VERIFIED hiện hành, Proofreading và đánh giá Child Safety hợp lệ."
        ),
        short_answer_en=(
            "Admin book & OCR workflow (/admin/books):\n"
            "1. Create books (/admin/books/new) and upload page images.\n"
            "2. Review NEEDS_REVIEW OCR revisions, optionally run AI proofreading, verify text/boxes, and mark VERIFIED.\n"
            "3. Publish only after OCR, proofreading, and Child Safety checks are current on all active pages."
        ),
        detailed_answer_en=(
            "Admin Book Catalog operations (/admin/books):\n"
            "1. Create books and upload pages at /admin/books/new.\n"
            "2. OCR scan and AI proofreading are separate steps; review word boxes and text before verifying revisions to VERIFIED.\n"
            "3. Book approval requires current OCR, proofreading, and Child Safety results plus rights confirmation on all active pages."
        ),
        actions=(
            KbAction("Mở Kho sách Admin", "Open Admin Books", "/admin/books"),
            KbAction("Tạo sách mới", "Create Book", "/admin/books/new"),
            KbAction("Chất lượng sách", "Metadata & Quality", "/admin/metadata-quality"),
        ),
        followups_vi=(
            "Quy trình duyệt Child Safety & chất lượng nội dung?",
            "Cách huấn luyện VietOCR Flow 2?",
            "Xem trạng thái worker tại Vận hành?",
        ),
        followups_en=(
            "How do Child Safety and quality checks work?",
            "How does VietOCR Flow 2 training work?",
            "How do I check worker health?",
        ),
    ),
    KbArticle(
        id="admin_quality_child_safety",
        title_vi="Chất lượng sách, Child Safety và kiểm duyệt báo lỗi",
        title_en="Book content quality, Child Safety, and report moderation",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin/metadata-quality",),
        keywords=(
            "chat luong sach",
            "child safety",
            "an toan tre em",
            "metadata",
            "ban quyen",
            "kiem duyet",
            "bao cao nguoi dung",
            "quality",
            "rights",
        ),
        short_answer_vi=(
            "Kiểm soát chất lượng tại Chất lượng sách (/admin/metadata-quality):\n"
            "• Theo dõi cảnh báo chính tả/OCR, đánh giá Child Safety chuẩn GRADE_1_TO_5 và xác nhận bản quyền.\n"
            "• Nội dung mức HIGH hoặc NOT_RECOMMENDED bị chặn theo chính sách an toàn trẻ em; Admin phải xử lý findings trước khi phê duyệt sách."
        ),
        detailed_answer_vi=(
            "Trung tâm Chất lượng sách (/admin/metadata-quality) tổng hợp:\n"
            "1. Metadata Quality & Bản quyền: rà soát thông tin sách và xác nhận bằng chứng bản quyền.\n"
            "2. Text Quality & Child Safety (GRADE_1_TO_5): xem các finding theo mức độ LOW/MEDIUM/HIGH, đánh dấu false-positive có lý do rõ ràng hoặc tạo revision VERIFIED mới để khắc phục.\n"
            "3. Báo lỗi từ phụ huynh: giải quyết báo lỗi trang sách sau khi đã xuất bản revision VERIFIED mới."
        ),
        short_answer_en=(
            "Book Quality Hub (/admin/metadata-quality):\n"
            "• Review OCR/spelling findings, GRADE_1_TO_5 Child Safety verdicts, and rights evidence.\n"
            "• HIGH-severity or NOT_RECOMMENDED pages are blocked until resolved by Admin."
        ),
        detailed_answer_en=(
            "Admin Quality Hub (/admin/metadata-quality) consolidates:\n"
            "1. Metadata & Rights verification.\n"
            "2. Proofreading & Child Safety (GRADE_1_TO_5) findings review.\n"
            "3. Parent-reported page issues (requiring a new VERIFIED revision before marking fixed)."
        ),
        actions=(
            KbAction("Mở Chất lượng sách", "Open Quality Hub", "/admin/metadata-quality"),
            KbAction("Mở Kho sách Admin", "Open Admin Books", "/admin/books"),
        ),
        followups_vi=(
            "Cách duyệt revision OCR thành VERIFIED?",
            "Kiểm tra sức khỏe hệ thống ở đâu?",
            "Xem nhật ký kiểm toán quản trị?",
        ),
        followups_en=(
            "How do I verify an OCR revision?",
            "Where is system health monitoring?",
            "How do I check admin audit logs?",
        ),
    ),
    KbArticle(
        id="admin_training_health_ops",
        title_vi="Huấn luyện VietOCR, Vận hành hệ thống và Nhật ký",
        title_en="VietOCR training, system health, karaoke, parents, and audit logs",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin/viread-training", "/admin/health", "/admin/audit-logs", "/admin/parents", "/admin/karaoke"),
        keywords=(
            "huan luyen",
            "training",
            "vietocr",
            "flow 1",
            "flow 2",
            "apps script",
            "drive",
            "van hanh",
            "health",
            "worker",
            "nhat ky",
            "audit",
            "phu huynh",
            "karaoke admin",
        ),
        short_answer_vi=(
            "Công cụ vận hành Admin:\n"
            "• Mô hình đọc chữ (/admin/viread-training): quản lý dataset Flow 1 / Flow 2, kết nối Apps Script Bridge (trên cloud/Render) và theo dõi checkpoint VietOCR.\n"
            "• Vận hành (/admin/health): kiểm tra trạng thái DB, OCR worker, Voice worker và các provider AI.\n"
            "• Nhật ký (/admin/audit-logs), Phụ huynh (/admin/parents), Bài hát Karaoke (/admin/karaoke)."
        ),
        detailed_answer_vi=(
            "Các khu vực vận hành dành cho Quản trị viên:\n"
            "1. Quản lý mô hình đọc chữ (/admin/viread-training): duyệt dữ liệu đóng góp đạt chuẩn hygiene (vocab 229 ký tự, NFC), cấu hình Apps Script Bridge trên môi trường cloud/Render và theo dõi các lượt train/đánh giá VietOCR.\n"
            "2. Vận hành (/admin/health): kiểm tra tức thời trạng thái Database, Remote/Local OCR worker, Voice TTS/STT và circuit breaker AI.\n"
            "3. Phụ huynh (/admin/parents), Bài hát Karaoke (/admin/karaoke) và Nhật ký kiểm toán (/admin/audit-logs) để quản trị tài khoản và truy vết thao tác."
        ),
        short_answer_en=(
            "Admin operations tools:\n"
            "• OCR Training (/admin/viread-training): Flow 1 / Flow 2 datasets, Apps Script Bridge on cloud/Render, and VietOCR evaluation runs.\n"
            "• Operations Health (/admin/health): DB, OCR workers, Voice workers, and AI provider status.\n"
            "• Audit Logs (/admin/audit-logs), Parents (/admin/parents), and Karaoke (/admin/karaoke)."
        ),
        detailed_answer_en=(
            "Admin Operations suite:\n"
            "1. VietOCR Training (/admin/viread-training): manage hygiene-validated Flow 2 data, Apps Script Bridge storage on Render/cloud, and evaluation runs.\n"
            "2. Health (/admin/health): real-time status for Database, OCR workers, Voice workers, and AI providers.\n"
            "3. Parents (/admin/parents), Karaoke (/admin/karaoke), and Audit Logs (/admin/audit-logs)."
        ),
        actions=(
            KbAction("Mở Vận hành", "Open Health", "/admin/health"),
            KbAction("Mô hình đọc chữ", "Open OCR Training", "/admin/viread-training"),
            KbAction("Nhật ký kiểm toán", "Open Audit Logs", "/admin/audit-logs"),
        ),
        followups_vi=(
            "Quy trình duyệt sách và OCR?",
            "Cách kiểm tra Child Safety cho sách?",
            "Trợ lý ViRead dùng AI phân tầng thế nào?",
        ),
        followups_en=(
            "What is the book OCR approval flow?",
            "How do I review Child Safety findings?",
            "How does the tiered AI assistant work?",
        ),
    ),
    KbArticle(
        id="global_ai_task_center",
        title_vi="Trung tâm tác vụ AI & Theo dõi tiến trình chạy nền",
        title_en="AI Task Center & background job progress",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/studio/tasks", "/my-books", "/book-scanner", "/dashboard"),
        keywords=(
            "tac vu ai",
            "tien trinh ai",
            "tien trinh tac vu",
            "global task center",
            "studio tasks",
            "hang doi ai",
            "ocr dang chay",
            "tao anh dang chay",
            "task center",
            "background jobs",
        ),
        short_answer_vi=(
            "Bạn theo dõi mọi tác vụ AI đang chạy (quét OCR sách, tạo ảnh bìa/minh họa, chuẩn bị audio, đọc hiểu…) ngay trên thanh nổi Trung tâm tác vụ AI ở góc màn hình hoặc tại trang Tác vụ AI (/studio/tasks)."
        ),
        detailed_answer_vi=(
            "ViRead cập nhật tiến trình tác vụ AI theo thời gian thực:\n"
            "1. Thanh nổi GlobalTaskCenter: tự xuất hiện khi có tác vụ AI chạy nền cho tài khoản gia đình bạn (như quét OCR, tạo ảnh bìa/minh họa Smart Studio hoặc tổng hợp giọng đọc).\n"
            "2. Trang Tác vụ AI (/studio/tasks): xem đầy đủ danh sách tác vụ đang chạy, phần trăm tiến trình, trạng thái hoàn thành hoặc thử lại nếu tác vụ bị lỗi.\n"
            "3. Mọi tác vụ đều tách biệt nghiêm ngặt theo tài khoản của chính bạn."
        ),
        short_answer_en=(
            "Track all your background AI jobs (OCR scans, Smart Studio illustrations, audio generation) via the floating AI Task Center pill or the AI Tasks page (/studio/tasks)."
        ),
        detailed_answer_en=(
            "Monitor background AI progress cleanly in ViRead:\n"
            "1. Floating GlobalTaskCenter widget shows active jobs in real time without blocking reading.\n"
            "2. Open /studio/tasks to review full job details, completion progress, and retry controls.\n"
            "3. Task visibility is strictly scoped to your own account."
        ),
        actions=(
            KbAction("Mở Tác vụ AI", "Open AI Tasks", "/studio/tasks"),
            KbAction("Mở Sách của tôi", "Open My Books", "/my-books"),
        ),
        followups_vi=(
            "Quét sách giấy mất bao lâu?",
            "Smart Studio tạo bìa & tranh minh họa ở đâu?",
            "Làm sao xem sách tôi vừa tải lên?",
        ),
        followups_en=(
            "How long does book scanning take?",
            "Where is Smart Studio for covers & art?",
            "Where are my uploaded books?",
        ),
    ),
    KbArticle(
        id="voice_settings_lock_and_offline_audio",
        title_vi="Khóa giọng đọc theo buổi, giọng 3 miền & audio ngoại tuyến",
        title_en="Session Voice Lock, regional voices & offline audio cache",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/reading", "/reading-preparation", "/settings"),
        keywords=(
            "khoa giong doc",
            "khong doi duoc giong doc",
            "doi giong doc giua buoi",
            "session voice lock",
            "giong doc vung mien",
            "giong bac trung nam",
            "giong mau",
            "audio ngoai tuyen",
            "tai truoc audio",
            "offline audio",
            "voice lock",
        ),
        short_answer_vi=(
            "ViRead áp dụng Khóa giọng đọc theo buổi (Session Voice Lock): trong một buổi đọc đang mở, giọng đọc mẫu được giữ ổn định để bé không bị rối tai. Hãy chọn giọng Bắc/Trung/Nam trong phần Chuẩn bị đọc hoặc Cài đặt trước khi bắt đầu buổi mới."
        ),
        detailed_answer_vi=(
            "Cơ chế giọng đọc mẫu thông minh trên ViRead:\n"
            "1. Khóa giọng đọc trong buổi (Session Voice Lock): ngay khi buổi đọc bắt đầu, hệ thống cố định giọng đọc đã chọn cho đến hết buổi để đảm bảo âm sắc nhất quán và đồng bộ từ ngữ.\n"
            "2. Cách đổi giọng: bạn chỉ cần tạm dừng/kết thúc buổi hiện tại hoặc mở Cài đặt (/settings) và chọn giọng Bắc, Trung hoặc Nam trước khi mở buổi mới.\n"
            "3. Audio ngoại tuyến: ViRead có thể chuẩn bị và lưu bộ đệm âm thanh câu mẫu giúp phát mượt ngay cả khi mạng yếu."
        ),
        short_answer_en=(
            "ViRead uses Session Voice Lock: once a reading session starts, the model voice stays consistent so your child isn't distracted. Pick Northern/Central/Southern voice in Reading Preparation or Settings before starting a new session."
        ),
        detailed_answer_en=(
            "How model voices work in ViRead:\n"
            "1. Session Voice Lock prevents mid-session accent shifts and keeps word-timing highlights accurate.\n"
            "2. To switch accents (North/Central/South), update your voice preference in Reading Preparation or Settings (/settings) before starting a session.\n"
            "3. Supported model audio can be cached locally for smoother playback on unstable connections."
        ),
        actions=(
            KbAction("Mở Cài đặt", "Open Settings", "/settings"),
            KbAction("Quản lý đọc", "Reading Management", "/reading-management"),
        ),
        followups_vi=(
            "Micro không nhận giọng bé khi đang đọc?",
            "Làm sao thay đổi mật khẩu tài khoản?",
            "Chế độ đọc tự động và đồng hành khác gì nhau?",
        ),
        followups_en=(
            "Microphone not picking up my child's voice?",
            "How do I change my account password?",
            "What is the difference between reading modes?",
        ),
    ),
    KbArticle(
        id="smart_studio_covers_illustrations",
        title_vi="Smart Studio: Tạo ảnh bìa & minh họa sách AI",
        title_en="Smart Studio: AI book covers & page illustrations",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/my-books", "/book-scanner", "/studio/tasks"),
        keywords=(
            "smart studio",
            "tao anh bia",
            "anh bia ai",
            "tao tranh minh hoa",
            "minh hoa trang sach",
            "tao minh hoa",
            "book cover ai",
            "page illustration",
        ),
        short_answer_vi=(
            "Trong Sách của tôi (/my-books), bạn có thể dùng Smart Studio để tạo ảnh bìa và tranh minh họa phù hợp thiếu nhi bằng AI cho cuốn sách gia đình tự tải, và theo dõi tiến trình tạo ảnh tại Tác vụ AI (/studio/tasks)."
        ),
        detailed_answer_vi=(
            "Tính năng Smart Studio dành cho sách riêng tư (/my-books):\n"
            "1. Mở chi tiết cuốn sách trong Sách của tôi (/my-books).\n"
            "2. Chọn tạo ảnh bìa sách hoặc sinh tranh minh họa từng trang dựa theo nội dung đã quét.\n"
            "3. Tiến trình chạy nền hiển thị trong Trung tâm tác vụ AI (/studio/tasks) để bạn không phải chờ trên trang."
        ),
        short_answer_en=(
            "Inside My Books (/my-books), Smart Studio lets you generate child-friendly AI book covers and page illustrations for your private family books, tracked in AI Tasks (/studio/tasks)."
        ),
        detailed_answer_en=(
            "Smart Studio workflow inside My Books (/my-books):\n"
            "1. Open one of your uploaded/scanned books.\n"
            "2. Trigger AI cover art or per-page illustration generation.\n"
            "3. Monitor progress in AI Tasks (/studio/tasks)."
        ),
        actions=(
            KbAction("Mở Sách của tôi", "Open My Books", "/my-books"),
            KbAction("Mở Tác vụ AI", "Open AI Tasks", "/studio/tasks"),
        ),
        followups_vi=(
            "Sách của tôi có chia sẻ cho người khác không?",
            "Theo dõi tác vụ AI đang chạy ở đâu?",
            "Làm sao quét sách giấy mới?",
        ),
        followups_en=(
            "Are My Books private to my family?",
            "Where can I track running AI tasks?",
            "How do I scan a printed book?",
        ),
    ),
    KbArticle(
        id="reading_presence_and_email_prefs",
        title_vi="Nhắc đọc qua email & trạng thái đang đọc trực tuyến",
        title_en="Email reading reminders & live reading presence",
        scopes=_PARENT_SCOPES,
        route_prefixes=("/settings", "/profile", "/dashboard"),
        keywords=(
            "nhac doc email",
            "email nhac doc",
            "thong bao email",
            "email preferences",
            "trang thai dang doc",
            "reading presence",
            "online presence",
            "lich nhac doc",
        ),
        short_answer_vi=(
            "Bạn có thể bật/tắt email nhắc lịch đọc, báo cáo định kỳ và tùy chọn thông báo trong Cài đặt (/settings) hoặc Hồ sơ ba mẹ (/profile). Khi bé đang trong buổi đọc, ViRead đồng bộ trạng thái đọc an toàn trong chính tài khoản gia đình bạn."
        ),
        detailed_answer_vi=(
            "Quản lý thông báo & nhịp đọc đều đặn:\n"
            "1. Vào Cài đặt (/settings) → Tùy chọn Email để bật/tắt nhắc lịch đọc hằng ngày và tổng hợp tiến bộ.\n"
            "2. Trạng thái đang đọc trực tuyến (Reading Presence) giúp ghi nhận phiên đang mở để ba mẹ tiếp tục đúng trang đang đọc dở.\n"
            "3. Mọi dữ liệu hiện diện và lịch sử đọc chỉ hiển thị trong phạm vi tài khoản của bạn."
        ),
        short_answer_en=(
            "Manage reading reminder emails in Settings (/settings) or Parent Profile (/profile). Active reading presence keeps session state synced strictly inside your own account."
        ),
        detailed_answer_en=(
            "Reminders and reading presence:\n"
            "1. Configure daily reading reminders and summary emails in Settings (/settings).\n"
            "2. Reading presence tracks active sessions so you can resume cleanly without duplicates, scoped only to your own account."
        ),
        actions=(
            KbAction("Mở Cài đặt", "Open Settings", "/settings"),
            KbAction("Hồ sơ ba mẹ", "Parent Profile", "/profile"),
        ),
        followups_vi=(
            "Làm sao đổi mật khẩu tài khoản?",
            "Xem lại lịch sử các buổi đọc ở đâu?",
            "Cách xem báo cáo tiến bộ của bé?",
        ),
        followups_en=(
            "How do I change my password?",
            "Where do I view past reading sessions?",
            "How do I view child progress reports?",
        ),
    ),
    KbArticle(
        id="viread_system_architecture_and_privacy",
        title_vi="Bảo mật riêng tư & phạm vi dữ liệu tài khoản ViRead",
        title_en="Account privacy & strict own-scope data isolation",
        scopes=_ALL_SCOPES,
        route_prefixes=("/", "/settings", "/profile", "/help-support"),
        keywords=(
            "bao mat",
            "rieng tu",
            "du lieu gia dinh",
            "phan quyen",
            "rls",
            "pham vi tai khoan",
            "trang nguoi khac",
            "privacy",
            "security",
            "account scope",
        ),
        short_answer_vi=(
            "Mỗi tài khoản ViRead được cách ly dữ liệu nghiêm ngặt (Supabase Auth + RLS): phụ huynh chỉ truy cập được trang, hồ sơ bé, sách riêng tư và báo cáo của chính mình — không thể xem tài khoản người khác hay khu vực quản trị."
        ),
        detailed_answer_vi=(
            "Nguyên tắc an toàn & riêng tư của hệ thống ViRead:\n"
            "1. Đúng phạm vi người dùng (Own-Scope): mọi hồ sơ bé, sách tự quét (/my-books), buổi đọc (/sessions), tác vụ AI (/studio/tasks) và cài đặt (/settings) chỉ thuộc về tài khoản đang đăng nhập.\n"
            "2. Trợ lý AI bảo vệ quyền riêng tư: không bao giờ điều hướng bạn sang khu vực quản trị hoặc trang dữ liệu của người dùng khác.\n"
            "3. Hỗ trợ trực tiếp khi gặp sự cố quyền truy cập tại Trợ giúp (/help-support)."
        ),
        short_answer_en=(
            "ViRead strictly isolates every account's data: you can only view and navigate your own child profiles, private books, reading sessions, and settings — never another user's pages or admin tools."
        ),
        detailed_answer_en=(
            "ViRead security & isolation guarantees:\n"
            "1. Strict own-scope access enforced across API and database layers.\n"
            "2. The assistant only offers navigation to valid pages within your authorized scope.\n"
            "3. Need account assistance? Visit Help & Support (/help-support)."
        ),
        actions=(
            KbAction("Cài đặt tài khoản", "Account Settings", "/settings"),
            KbAction("Trợ giúp & Hỗ trợ", "Help & Support", "/help-support"),
        ),
        followups_vi=(
            "Cách đổi mật khẩu tài khoản ViRead?",
            "Quét sách giấy có an toàn cho bé không?",
            "Liên hệ hỗ trợ ViRead như thế nào?",
        ),
        followups_en=(
            "How do I change my ViRead password?",
            "Are scanned books private to my family?",
            "How do I contact ViRead support?",
        ),
    ),
    KbArticle(
        id="admin_task_center_isolation",
        title_vi="Quản lý tác vụ AI toàn hệ thống (Admin Tasks)",
        title_en="System AI Task Monitor (Admin Tasks)",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin/tasks", "/admin"),
        keywords=(
            "admin tasks",
            "tac vu he thong",
            "theo doi tac vu admin",
            "admin task center",
        ),
        short_answer_vi=(
            "Trang /admin/tasks giúp quản trị viên theo dõi toàn bộ tác vụ AI xử lý sách, OCR và tạo media ở cấp hệ thống, tách biệt khỏi màn hình phụ huynh."
        ),
        detailed_answer_vi=(
            "Bảng tác vụ Quản trị (/admin/tasks) tổng hợp các tác vụ nền theo thời gian thực để đội vận hành kiểm tra hàng đợi OCR, lỗi xử lý sách công khai và trạng thái worker (/admin/health)."
        ),
        short_answer_en=(
            "Admin Tasks (/admin/tasks) lets administrators monitor system-wide AI, OCR, and media jobs."
        ),
        detailed_answer_en=(
            "The Admin Task monitor (/admin/tasks) tracks background OCR and publishing queues alongside /admin/health."
        ),
        actions=(
            KbAction("Tác vụ Admin", "Admin Tasks", "/admin/tasks"),
            KbAction("Vận hành", "Admin Health", "/admin/health"),
        ),
        followups_vi=(
            "Kiểm tra sức khỏe worker ở đâu?",
            "Quy trình duyệt sách và OCR?",
            "Cách quản lý mô hình VietOCR?",
        ),
        followups_en=(
            "Where do I check worker health?",
            "How does book OCR approval work?",
            "How do I manage VietOCR training?",
        ),
    ),
)


PAGE_CONTEXT_SPECS: tuple[PageContextSpec, ...] = (
    PageContextSpec(
        prefix="/admin/login",
        scopes=_ALL_SCOPES,
        title_vi="Đăng nhập Quản trị",
        title_en="Admin Sign In",
        greeting_vi="Cần hỗ trợ đăng nhập tài khoản quản trị hoặc quay về trang đăng nhập phụ huynh?",
        greeting_en="Need help signing in or returning to the parent login page?",
        prompts_vi=(
            "Cách đăng nhập và xác minh tài khoản ViRead?",
            "Quên mật khẩu thì khôi phục thế nào?",
            "ViRead có những chức năng gì?",
        ),
        prompts_en=(
            "How do I sign in or verify my ViRead account?",
            "How do I reset a forgotten password?",
            "What can I do in ViRead?",
        ),
        actions=(
            KbAction("Đăng nhập phụ huynh", "Parent Login", "/login"),
            KbAction("Quên mật khẩu", "Forgot password", "/forgot-password"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/tasks",
        scopes=_ADMIN_ONLY,
        title_vi="Tác vụ AI Quản trị",
        title_en="Admin AI Tasks",
        greeting_vi="Theo dõi hàng đợi xử lý sách, OCR và media của toàn hệ thống tại đây.",
        greeting_en="Monitor system-wide OCR, book publishing, and media background jobs here.",
        prompts_vi=(
            "Kiểm tra sức khỏe worker ở đâu?",
            "Quy trình duyệt sách và OCR?",
            "Cách xem nhật ký kiểm toán Admin?",
        ),
        prompts_en=(
            "Where do I check worker health?",
            "What is the book OCR approval flow?",
            "How do I view Admin Audit Logs?",
        ),
        actions=(
            KbAction("Vận hành hệ thống", "System Health", "/admin/health"),
            KbAction("Kho sách Admin", "Admin Books", "/admin/books"),
        ),
    ),
    PageContextSpec(
        prefix="/studio/tasks",
        scopes=_PARENT_SCOPES,
        title_vi="Trung tâm tác vụ AI",
        title_en="AI Task Center",
        greeting_vi="Bạn có thể xem tiến trình quét OCR, tạo ảnh minh họa và audio của tài khoản bạn tại đây.",
        greeting_en="Track your own OCR scans, AI illustrations, and audio generation jobs here.",
        prompts_vi=(
            "Làm sao xem sách tôi vừa quét xong?",
            "Smart Studio tạo ảnh bìa và minh họa thế nào?",
            "Làm sao bắt đầu buổi đọc cho bé?",
        ),
        prompts_en=(
            "Where are my newly scanned books?",
            "How does Smart Studio create covers & art?",
            "How do I start a reading session?",
        ),
        actions=(
            KbAction("Mở Sách của tôi", "Open My Books", "/my-books"),
            KbAction("Quét sách giấy", "Book Scanner", "/book-scanner"),
        ),
    ),
    PageContextSpec(
        prefix="/entertainment/memory-game",
        scopes=_PARENT_SCOPES,
        title_vi="Memory Game lật thẻ",
        title_en="Memory Card Game",
        greeting_vi="Giúp bé lật cặp thẻ chữ/hình để rèn trí nhớ từ vựng và phản xạ mặt chữ tiếng Việt!",
        greeting_en="Match pairs of cards to sharpen your child's Vietnamese word recall and focus!",
        prompts_vi=(
            "Memory Game lật thẻ giúp bé rèn kỹ năng gì?",
            "Còn trò chơi nào khác trong Góc giải trí?",
            "Làm sao chuyển sang đọc sách cùng bé?",
        ),
        prompts_en=(
            "What skills does Memory Game build?",
            "What other games are in Entertainment?",
            "How do we start a reading session?",
        ),
        actions=(
            KbAction("Góc giải trí", "Entertainment", "/entertainment"),
            KbAction("Mở kho Sách", "Browse Books", "/books"),
        ),
    ),
    PageContextSpec(
        prefix="/entertainment/sentence-shooter",
        scopes=_PARENT_SCOPES,
        title_vi="Trò chơi Ghép câu",
        title_en="Sentence Shooter",
        greeting_vi="Cùng bé sắp xếp từ thành câu tiếng Việt hoàn chỉnh, đúng ngữ pháp!",
        greeting_en="Help your child arrange words into natural Vietnamese sentences!",
        prompts_vi=(
            "Trò chơi Ghép câu luyện kỹ năng gì cho bé?",
            "Thử Memory Game lật thẻ ở đâu?",
            "Cách quay về đọc sách?",
        ),
        prompts_en=(
            "What skills does Sentence Shooter train?",
            "Where is the Memory Card Game?",
            "How do I go back to reading books?",
        ),
        actions=(
            KbAction("Góc giải trí", "Entertainment", "/entertainment"),
            KbAction("Memory Game", "Memory Game", "/entertainment/memory-game"),
        ),
    ),
    PageContextSpec(
        prefix="/entertainment/picture-description",
        scopes=_PARENT_SCOPES,
        title_vi="Mô tả tranh AI",
        title_en="AI Picture Description",
        greeting_vi="Bé nhìn tranh kể chuyện bằng giọng nói hoặc gõ câu để nhận sao & gợi ý từ vựng AI!",
        greeting_en="Let your child describe pictures by voice or text for AI stars and vocabulary tips!",
        prompts_vi=(
            "Mô tả tranh AI chấm điểm như thế nào?",
            "Micro không nhận giọng khi chơi trò chơi?",
            "Còn trò chơi nào khác cho bé không?",
        ),
        prompts_en=(
            "How does AI Picture Description score?",
            "Mic not working during games?",
            "What other games can we play?",
        ),
        actions=(
            KbAction("Góc giải trí", "Entertainment", "/entertainment"),
            KbAction("Kiểm tra thiết bị", "Device Check", "/device-permissions"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/viread-training",
        scopes=_ADMIN_ONLY,
        title_vi="Quản lý mô hình đọc chữ",
        title_en="OCR Model Training",
        greeting_vi="Tôi có thể hỗ trợ về Flow 1/Flow 2, Apps Script Bridge và đánh giá VietOCR.",
        greeting_en="I can help with Flow 1/Flow 2 datasets, Apps Script Bridge, and VietOCR evaluation.",
        prompts_vi=(
            "Quy trình Flow 2 hygiene cần điều kiện gì?",
            "Apps Script Bridge dùng khi nào?",
            "Kiểm tra sức khỏe worker ở đâu?",
        ),
        prompts_en=(
            "What are Flow 2 hygiene rules?",
            "When should I use Apps Script Bridge?",
            "Where do I check worker health?",
        ),
        actions=(
            KbAction("Mở Vận hành", "Open Health", "/admin/health"),
            KbAction("Mở Kho sách", "Open Books", "/admin/books"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/health",
        scopes=_ADMIN_ONLY,
        title_vi="Vận hành hệ thống",
        title_en="Operations Health",
        greeting_vi="Tôi có thể giải thích trạng thái worker OCR, giọng đọc và các tầng AI.",
        greeting_en="I can explain OCR worker, voice worker, and AI provider health states.",
        prompts_vi=(
            "Cách kiểm tra worker OCR và giọng đọc?",
            "Trợ lý AI phân tầng hoạt động thế nào?",
            "Xem nhật ký kiểm toán quản trị?",
        ),
        prompts_en=(
            "How do I check OCR and voice workers?",
            "How does the tiered AI routing work?",
            "Where are admin audit logs?",
        ),
        actions=(
            KbAction("Nhật ký kiểm toán", "Audit Logs", "/admin/audit-logs"),
            KbAction("Mô hình đọc chữ", "OCR Training", "/admin/viread-training"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/metadata-quality",
        scopes=_ADMIN_ONLY,
        title_vi="Chất lượng sách",
        title_en="Book Quality Hub",
        greeting_vi="Cần hướng dẫn duyệt Child Safety, lỗi chính tả hay báo cáo phụ huynh?",
        greeting_en="Need help reviewing Child Safety, text findings, or parent reports?",
        prompts_vi=(
            "Điều kiện phê duyệt sách an toàn trẻ em?",
            "Xử lý báo lỗi trang sách từ phụ huynh?",
            "Cách duyệt revision OCR thành VERIFIED?",
        ),
        prompts_en=(
            "What is required to approve a book?",
            "How do I resolve parent page reports?",
            "How do I verify an OCR revision?",
        ),
        actions=(
            KbAction("Mở Kho sách", "Open Books", "/admin/books"),
        ),
    ),
    PageContextSpec(
        prefix="/admin",
        scopes=_ADMIN_ONLY,
        title_vi="Khu vực Quản trị",
        title_en="Admin Workspace",
        greeting_vi="Xin chào Quản trị viên! Hỏi tôi về kho sách, OCR, chất lượng hay vận hành.",
        greeting_en="Hello Admin! Ask about catalog books, OCR review, quality, or operations.",
        prompts_vi=(
            "Quy trình tải sách và duyệt OCR VERIFIED?",
            "Kiểm tra Child Safety và bản quyền sách?",
            "Xem trạng thái vận hành hệ thống?",
        ),
        prompts_en=(
            "How do I upload and verify book OCR?",
            "How do Child Safety & rights checks work?",
            "Where is system health monitoring?",
        ),
        actions=(
            KbAction("Kho sách", "Books", "/admin/books"),
            KbAction("Chất lượng", "Quality", "/admin/metadata-quality"),
            KbAction("Vận hành", "Health", "/admin/health"),
        ),
    ),
    PageContextSpec(
        prefix="/reading-management",
        scopes=_PARENT_SCOPES,
        title_vi="Quản lý đọc",
        title_en="Reading Management",
        greeting_vi="Tôi có thể hướng dẫn đặt mục tiêu tuần và lịch email nhắc đọc cho bé.",
        greeting_en="I can help you set weekly reading goals and email reminder schedules.",
        prompts_vi=(
            "Cách đặt lịch email nhắc đọc cho bé?",
            "Làm sao đặt mục tiêu đọc hàng tuần?",
            "Tại sao chưa nhận được email nhắc đọc?",
        ),
        prompts_en=(
            "How do I schedule email reminders?",
            "How do I set a weekly reading goal?",
            "Why haven't I received reminder emails?",
        ),
        actions=(
            KbAction("Xem Tiến bộ", "View Progress", "/reports"),
            KbAction("Chọn sách", "Browse Books", "/books"),
        ),
    ),
    PageContextSpec(
        prefix="/reading-preparation",
        scopes=_PARENT_SCOPES,
        title_vi="Chuẩn bị buổi đọc",
        title_en="Reading Preparation",
        greeting_vi="Sẵn sàng cho buổi đọc! Cần hỗ trợ chọn trang hay kiểm tra micro?",
        greeting_en="Ready to read! Need help picking pages or testing the microphone?",
        prompts_vi=(
            "Cách chọn phạm vi trang đọc phù hợp?",
            "Kiểm tra micro trước khi bé đọc?",
            "Giọng đọc mẫu và chế độ đọc là gì?",
        ),
        prompts_en=(
            "How do I pick a page range?",
            "How do I test the mic before reading?",
            "How do model voice and reading modes work?",
        ),
        actions=(
            KbAction("Quyền thiết bị", "Device Permissions", "/device-permissions"),
        ),
    ),
    PageContextSpec(
        prefix="/reading",
        scopes=_PARENT_SCOPES,
        title_vi="Buổi đọc cùng bé",
        title_en="Reading Session",
        greeting_vi="Mình giữ khung thật gọn để không làm bé mất tập trung. Ba mẹ cần hỗ trợ gì?",
        greeting_en="Keeping this compact so your child stays focused. How can I help?",
        prompts_vi=(
            "Micro không nhận giọng bé phải làm sao?",
            "Cách đổi giọng đọc mẫu (TTS)?",
            "Từ bé đọc nhầm sẽ lưu ở đâu?",
        ),
        prompts_en=(
            "Mic isn't picking up my child's voice",
            "How do I switch the model voice?",
            "Where are missed words saved?",
        ),
        actions=(
            KbAction("Kiểm tra Micro", "Check Mic", "/device-permissions"),
            KbAction("Từ cần luyện", "Difficult Words", "/reports/difficult-words"),
        ),
    ),
    PageContextSpec(
        prefix="/book-scanner",
        scopes=_PARENT_SCOPES,
        title_vi="Quét sách giấy",
        title_en="Book Scanner",
        greeting_vi="Tôi có thể hướng dẫn chụp trang sách rõ chữ và cách hoạt động của hàng chờ OCR.",
        greeting_en="I can share tips for clear page scans and how the OCR queue works.",
        prompts_vi=(
            "Mẹo chụp trang sách để OCR chuẩn nhất?",
            "Hàng chờ OCR ngoại tuyến hoạt động thế nào?",
            "Camera không mở được thì xử lý sao?",
        ),
        prompts_en=(
            "Tips for the sharpest OCR page scan?",
            "How does the offline OCR queue work?",
            "Camera won't open — how to fix?",
        ),
        actions=(
            KbAction("Sách của tôi", "My Books", "/my-books"),
            KbAction("Quyền thiết bị", "Device Permissions", "/device-permissions"),
        ),
    ),
    PageContextSpec(
        prefix="/my-books",
        scopes=_PARENT_SCOPES,
        title_vi="Sách của tôi",
        title_en="My Books",
        greeting_vi="Hỏi tôi về cách tải ảnh/PDF/DOCX sách gia đình hoặc chỉnh sửa nội dung quét.",
        greeting_en="Ask me about uploading family books (images/PDF/DOCX) or reviewing scans.",
        prompts_vi=(
            "Cách tải sách riêng từ ảnh hoặc PDF?",
            "Hàng chờ OCR ngoại tuyến hoạt động ra sao?",
            "Làm sao bắt đầu buổi đọc từ sách của tôi?",
        ),
        prompts_en=(
            "How do I upload a book from images or PDF?",
            "How does the offline OCR queue work?",
            "How do I start reading my private book?",
        ),
        actions=(
            KbAction("Mở Quét sách", "Open Scanner", "/book-scanner"),
            KbAction("Kho sách chung", "Library Books", "/books"),
        ),
    ),
    PageContextSpec(
        prefix="/reports/difficult-words",
        scopes=_PARENT_SCOPES,
        title_vi="Từ cần luyện",
        title_en="Difficult Words",
        greeting_vi="Cần hướng dẫn giúp bé ôn phát âm các từ khó bằng micro tự động?",
        greeting_en="Need tips on practicing tricky words with audio and auto-mic?",
        prompts_vi=(
            "Cách luyện phát âm từ khó cho bé?",
            "Micro không nhận giọng bé khi luyện từ?",
            "Xem báo cáo tiến bộ tổng hợp ở đâu?",
        ),
        prompts_en=(
            "How do we practice difficult words?",
            "Mic isn't hearing my child during practice",
            "Where is the full progress report?",
        ),
        actions=(
            KbAction("Xem Tiến bộ", "View Progress", "/reports"),
            KbAction("Quyền thiết bị", "Device Permissions", "/device-permissions"),
        ),
    ),
    PageContextSpec(
        prefix="/reports",
        scopes=_PARENT_SCOPES,
        title_vi="Báo cáo tiến bộ",
        title_en="Progress Reports",
        greeting_vi="Tôi có thể giải thích các chỉ số đọc đúng, trôi chảy, hiểu bài và thói quen.",
        greeting_en="I can explain Accuracy, Fluency, Comprehension, and Habit metrics.",
        prompts_vi=(
            "4 chỉ số tiến bộ của bé có ý nghĩa gì?",
            "Cách ôn luyện các từ bé hay đọc nhầm?",
            "Làm sao đặt lịch nhắc đọc hàng tuần?",
        ),
        prompts_en=(
            "What do the 4 progress metrics mean?",
            "How do we practice missed words?",
            "How do I set weekly reading reminders?",
        ),
        actions=(
            KbAction("Từ cần luyện", "Difficult Words", "/reports/difficult-words"),
            KbAction("Lịch sử đọc", "Session History", "/sessions"),
        ),
    ),
    PageContextSpec(
        prefix="/entertainment",
        scopes=_PARENT_SCOPES,
        title_vi="Góc giải trí",
        title_en="Entertainment",
        greeting_vi="Hỏi tôi về Karaoke, Memory Game lật thẻ, Ghép câu hoặc Mô tả tranh AI cho bé!",
        greeting_en="Ask me about Karaoke, Memory Game, Sentence Shooter, or AI Picture Description!",
        prompts_vi=(
            "Memory game lật thẻ ở đâu và chơi thế nào?",
            "Trò chơi Mô tả tranh AI hoạt động thế nào?",
            "Micro không nhận giọng khi chơi trò chơi?",
        ),
        prompts_en=(
            "How do I play Memory Game?",
            "How does AI Picture Description work?",
            "Mic not working during games?",
        ),
        actions=(
            KbAction("Memory Game lật thẻ", "Open Memory Game", "/entertainment/memory-game"),
            KbAction("Mô tả tranh AI", "Picture Description", "/entertainment/picture-description"),
        ),
    ),
    PageContextSpec(
        prefix="/karaoke",
        scopes=_PARENT_SCOPES,
        title_vi="Karaoke thiếu nhi",
        title_en="Kids Karaoke",
        greeting_vi="Hát vui cùng bé! Cần hướng dẫn bật nhạc, theo dõi lời hay kiểm tra âm thanh?",
        greeting_en="Sing along! Need help with lyrics, audio, or other games?",
        prompts_vi=(
            "Karaoke giúp bé luyện đọc thế nào?",
            "Còn trò chơi ngôn ngữ nào khác không?",
            "Không nghe âm thanh hoặc micro bị lỗi?",
        ),
        prompts_en=(
            "How does Karaoke support reading?",
            "What other language games exist?",
            "Audio or microphone not working?",
        ),
        actions=(
            KbAction("Góc giải trí", "Entertainment", "/entertainment"),
        ),
    ),
    PageContextSpec(
        prefix="/login",
        scopes=_ALL_SCOPES,
        title_vi="Đăng nhập ViRead",
        title_en="Sign in to ViRead",
        greeting_vi="Chào mừng đến ViRead! Cần hỗ trợ đăng nhập, đăng ký hay quên mật khẩu?",
        greeting_en="Welcome to ViRead! Need help signing in, registering, or resetting a password?",
        prompts_vi=(
            "ViRead có những tính năng gì cho bé?",
            "Quên mật khẩu thì khôi phục thế nào?",
            "Không nhận được email xác nhận tài khoản?",
        ),
        prompts_en=(
            "What features does ViRead offer?",
            "How do I reset a forgotten password?",
            "Didn't receive the verification email?",
        ),
        actions=(
            KbAction("Đăng ký tài khoản", "Register", "/register"),
            KbAction("Quên mật khẩu", "Forgot password", "/forgot-password"),
        ),
    ),
    PageContextSpec(
        prefix="/register",
        scopes=_ALL_SCOPES,
        title_vi="Đăng ký ViRead",
        title_en="Register for ViRead",
        greeting_vi="Tạo tài khoản phụ huynh ViRead chỉ trong 1 phút. Hỏi tôi nếu cần hỗ trợ!",
        greeting_en="Create your ViRead parent account in a minute. Ask me if you need help!",
        prompts_vi=(
            "Cách xác minh email sau khi đăng ký?",
            "Sau khi đăng ký tôi cần làm bước gì tiếp?",
            "ViRead phù hợp cho bé lớp mấy?",
        ),
        prompts_en=(
            "How do I verify my email after signing up?",
            "What should I do right after signing up?",
            "Which grade levels is ViRead for?",
        ),
        actions=(
            KbAction("Đã có tài khoản? Đăng nhập", "Sign in", "/login"),
        ),
    ),
    PageContextSpec(
        prefix="/forgot-password",
        scopes=_ALL_SCOPES,
        title_vi="Quên mật khẩu",
        title_en="Forgot Password",
        greeting_vi="Nhập email đã đăng ký để nhận liên kết khôi phục mật khẩu trên cùng trình duyệt nhé.",
        greeting_en="Enter your registered email to receive a password recovery link in the same browser.",
        prompts_vi=(
            "Quên mật khẩu thì khôi phục thế nào?",
            "Không nhận được email xác nhận thì làm sao?",
            "ViRead có những chức năng gì?",
        ),
        prompts_en=(
            "How do I reset a forgotten password?",
            "I didn't receive the verification email",
            "What can I do in ViRead?",
        ),
        actions=(
            KbAction("Quay lại Đăng nhập", "Back to Sign in", "/login"),
        ),
    ),
    PageContextSpec(
        prefix="/reset-password",
        scopes=_ALL_SCOPES,
        title_vi="Đặt lại mật khẩu",
        title_en="Reset Password",
        greeting_vi="Hãy mở liên kết đặt lại mật khẩu trên đúng trình duyệt vừa yêu cầu để đảm bảo bảo mật PKCE.",
        greeting_en="Open the reset link in the same browser where you requested it for PKCE security.",
        prompts_vi=(
            "Liên kết đặt lại mật khẩu hết hạn thì làm sao?",
            "Làm sao đổi mật khẩu sau khi đăng nhập?",
            "ViRead có những chức năng gì?",
        ),
        prompts_en=(
            "What if my reset link expired?",
            "How do I change my password after signing in?",
            "What can I do in ViRead?",
        ),
        actions=(
            KbAction("Gửi lại liên kết", "Forgot password", "/forgot-password"),
            KbAction("Đăng nhập", "Sign in", "/login"),
        ),
    ),
    PageContextSpec(
        prefix="/books",
        scopes=_PARENT_SCOPES,
        title_vi="Kho sách ViRead",
        title_en="ViRead Book Library",
        greeting_vi="Chọn cuốn sách phù hợp lớp của bé hoặc tải sách giấy gia đình tại Sách của tôi.",
        greeting_en="Pick a catalog book for your child's grade or upload family books in My Books.",
        prompts_vi=(
            "Cách chọn sách và bắt đầu buổi đọc?",
            "Làm sao quét sách giấy bằng camera?",
            "Làm sao báo lỗi chữ sai trong sách?",
        ),
        prompts_en=(
            "How do I pick a book and start reading?",
            "How do I scan a paper book?",
            "How do I report a typo in a book?",
        ),
        actions=(
            KbAction("Sách của tôi", "My Books", "/my-books"),
            KbAction("Quét sách", "Book Scanner", "/book-scanner"),
        ),
    ),
    PageContextSpec(
        prefix="/children",
        scopes=_PARENT_SCOPES,
        title_vi="Hồ sơ bé",
        title_en="Child Profiles",
        greeting_vi="Quản lý hồ sơ từng bé theo lớp 1–5 để lưu riêng tủ sách, báo cáo và từ cần luyện.",
        greeting_en="Manage Grade 1–5 child profiles with separate bookshelves, reports, and difficult words.",
        prompts_vi=(
            "Làm sao tạo hồ sơ cho bé?",
            "Cách chuyển nhanh giữa các hồ sơ bé?",
            "Cách bắt đầu buổi đọc đầu tiên?",
        ),
        prompts_en=(
            "How do I create a child profile?",
            "How do I switch between child profiles?",
            "How do I start a reading session?",
        ),
        actions=(
            KbAction("Tạo hồ sơ bé mới", "Create Child Profile", "/children/new"),
            KbAction("Về Tổng quan", "Dashboard", "/dashboard"),
        ),
    ),
    PageContextSpec(
        prefix="/profile",
        scopes=_PARENT_SCOPES,
        title_vi="Hồ sơ ba mẹ",
        title_en="Parent Profile",
        greeting_vi="Cập nhật tên hiển thị, số điện thoại, ảnh đại diện hoặc đổi email xác minh tại đây.",
        greeting_en="Update your display name, phone number, avatar, or verified email here.",
        prompts_vi=(
            "Cách cập nhật hồ sơ ba mẹ và đổi email?",
            "Làm sao đổi mật khẩu tài khoản?",
            "Cách đổi ngôn ngữ giao diện ViRead?",
        ),
        prompts_en=(
            "How do I edit my parent profile or email?",
            "How do I change my password?",
            "How do I switch the interface language?",
        ),
        actions=(
            KbAction("Cài đặt tài khoản", "Account Settings", "/settings"),
            KbAction("Hồ sơ bé", "Child Profiles", "/children"),
        ),
    ),
    PageContextSpec(
        prefix="/settings",
        scopes=_PARENT_SCOPES,
        title_vi="Cài đặt tài khoản",
        title_en="Account Settings",
        greeting_vi="Đổi mật khẩu bảo mật hoặc gửi liên kết đặt mật khẩu cho tài khoản Google/Facebook.",
        greeting_en="Change your password or send a password setup link for Google/Facebook sign-in.",
        prompts_vi=(
            "Làm sao đổi mật khẩu tài khoản?",
            "Cách đổi ngôn ngữ giao diện ViRead?",
            "Cách cập nhật hồ sơ ba mẹ?",
        ),
        prompts_en=(
            "How do I change my password?",
            "How do I switch the UI language?",
            "How do I update my parent profile?",
        ),
        actions=(
            KbAction("Hồ sơ ba mẹ", "Parent Profile", "/profile"),
            KbAction("Trợ giúp & hỗ trợ", "Help & Support", "/help-support"),
        ),
    ),
    PageContextSpec(
        prefix="/sessions",
        scopes=_PARENT_SCOPES,
        title_vi="Lịch sử buổi đọc",
        title_en="Reading History",
        greeting_vi="Xem lại từng buổi đọc đã hoàn thành, điểm đọc hiểu và các từ bé cần ôn thêm.",
        greeting_en="Review completed reading sessions, comprehension scores, and words to practice.",
        prompts_vi=(
            "Báo cáo chi tiết buổi đọc gồm những gì?",
            "Câu hỏi đọc hiểu AI Tutor hoạt động thế nào?",
            "Cách ôn lại các từ bé đọc nhầm?",
        ),
        prompts_en=(
            "What is shown in a session report?",
            "How does the AI Tutor comprehension quiz work?",
            "How do we practice missed words?",
        ),
        actions=(
            KbAction("Xem Tiến bộ", "View Progress", "/reports"),
            KbAction("Từ cần luyện", "Difficult Words", "/reports/difficult-words"),
        ),
    ),
    PageContextSpec(
        prefix="/device-permissions",
        scopes=_ALL_SCOPES,
        title_vi="Quyền thiết bị",
        title_en="Device Permissions",
        greeting_vi="Kiểm tra nhanh quyền Micro và Camera để bé đọc to và quét sách giấy mượt mà.",
        greeting_en="Check Microphone and Camera permissions for smooth reading and book scanning.",
        prompts_vi=(
            "Micro không nhận giọng bé phải làm sao?",
            "Camera không mở được khi quét sách?",
            "Cấp quyền micro trên điện thoại thế nào?",
        ),
        prompts_en=(
            "Microphone isn't picking up my child's voice",
            "Camera won't open in Book Scanner",
            "How do I allow mic on mobile?",
        ),
        actions=(
            KbAction("Trợ giúp & hỗ trợ", "Help & Support", "/help-support"),
            KbAction("Về Tổng quan", "Dashboard", "/dashboard"),
        ),
    ),
    PageContextSpec(
        prefix="/help-support",
        scopes=_ALL_SCOPES,
        title_vi="Trợ giúp & hỗ trợ",
        title_en="Help & Support",
        greeting_vi="Cần hỏi nhanh về tính năng ViRead, báo lỗi sách hay gửi phản hồi cho đội ngũ?",
        greeting_en="Need quick help with ViRead features, book issue reports, or contacting support?",
        prompts_vi=(
            "Cách gửi phản hồi hoặc báo lỗi kỹ thuật?",
            "Làm sao báo lỗi chữ sai trong sách?",
            "Trợ lý ViRead dùng AI phân tầng thế nào?",
        ),
        prompts_en=(
            "How do I send support feedback?",
            "How do I report a typo in a book?",
            "How does the tiered AI assistant work?",
        ),
        actions=(
            KbAction("Báo cáo sách", "Book Reports", "/book-reports"),
            KbAction("Quyền thiết bị", "Device Permissions", "/device-permissions"),
        ),
    ),
    PageContextSpec(
        prefix="/book-reports",
        scopes=_PARENT_SCOPES,
        title_vi="Báo cáo sách",
        title_en="Book Reports",
        greeting_vi="Theo dõi trạng thái xử lý các báo lỗi chữ hoặc trang sách bạn đã gửi.",
        greeting_en="Track the review status of book typos and page issues you reported.",
        prompts_vi=(
            "Làm sao báo lỗi chữ sai trong sách?",
            "Cách gửi phản hồi cho đội ngũ ViRead?",
            "Mở kho sách để đọc tiếp?",
        ),
        prompts_en=(
            "How do I report a typo in a book?",
            "How do I contact ViRead support?",
            "How do I browse library books?",
        ),
        actions=(
            KbAction("Kho sách", "Browse Books", "/books"),
            KbAction("Trợ giúp & hỗ trợ", "Help & Support", "/help-support"),
        ),
    ),
    PageContextSpec(
        prefix="/dashboard",
        scopes=_PARENT_SCOPES,
        title_vi="Tổng quan gia đình",
        title_en="Family Dashboard",
        greeting_vi="Xin chào ba mẹ! Tôi hỗ trợ mọi tính năng trên ViRead — chọn gợi ý hoặc đặt câu hỏi nhé.",
        greeting_en="Hi! I can help with everything in ViRead — pick a prompt or ask anything.",
        prompts_vi=(
            "Cách bắt đầu buổi đọc đầu tiên cho bé?",
            "Làm sao quét sách giấy bằng camera?",
            "Cách xem tiến bộ và ôn từ cần luyện?",
        ),
        prompts_en=(
            "How do I start our first reading session?",
            "How do I scan a paper book?",
            "How do I check progress & difficult words?",
        ),
        actions=(
            KbAction("Chọn sách", "Browse Books", "/books"),
            KbAction("Quét sách", "Scan Book", "/book-scanner"),
            KbAction("Tiến bộ", "Progress", "/reports"),
        ),
    ),
)

_DEFAULT_PUBLIC_CONTEXT = PageContextSpec(
    prefix="/",
    scopes=_ALL_SCOPES,
    title_vi="Trợ lý ViRead",
    title_en="ViRead Assistant",
    greeting_vi="Xin chào! Tôi là Trợ lý ViRead — hỏi tôi bất cứ điều gì về sản phẩm nhé.",
    greeting_en="Hi! I'm the ViRead Assistant — ask me anything about using ViRead.",
    prompts_vi=(
        "ViRead có những chức năng gì?",
        "Cách đăng nhập hoặc quên mật khẩu?",
        "Khắc phục lỗi micro và camera?",
    ),
    prompts_en=(
        "What can I do in ViRead?",
        "How do I sign in or reset my password?",
        "How do I fix mic and camera permissions?",
    ),
    actions=(
        KbAction("Đăng nhập", "Sign in", "/login"),
        KbAction("Đăng ký", "Register", "/register"),
    ),
)

_DEFAULT_PARENT_CONTEXT = PageContextSpec(
    prefix="/",
    scopes=_PARENT_SCOPES,
    title_vi="Trợ lý ViRead",
    title_en="ViRead Assistant",
    greeting_vi="Xin chào ba mẹ! Hỏi tôi bất kỳ thao tác nào trong ViRead nhé.",
    greeting_en="Hi! Ask me how to use any feature in ViRead.",
    prompts_vi=(
        "Cách bắt đầu buổi đọc cho bé?",
        "Làm sao quét sách giấy hoặc tải PDF?",
        "Khắc phục lỗi micro không thu tiếng?",
    ),
    prompts_en=(
        "How do I start a reading session?",
        "How do I scan a paper book or upload PDF?",
        "How do I fix microphone issues?",
    ),
    actions=(
        KbAction("Về Tổng quan", "Dashboard", "/dashboard"),
        KbAction("Trợ giúp & hỗ trợ", "Help & Support", "/help-support"),
    ),
)

_STOPWORDS: frozenset[str] = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "ba",
        "ban",
        "be",
        "bi",
        "bo",
        "cac",
        "cach",
        "cai",
        "can",
        "cho",
        "co",
        "cua",
        "da",
        "de",
        "den",
        "di",
        "do",
        "duoc",
        "for",
        "gi",
        "hay",
        "how",
        "i",
        "in",
        "is",
        "it",
        "khi",
        "khong",
        "la",
        "lam",
        "ma",
        "me",
        "minh",
        "mot",
        "muon",
        "my",
        "nao",
        "nay",
        "neu",
        "nhe",
        "nhu",
        "nhung",
        "o",
        "of",
        "on",
        "or",
        "phai",
        "ra",
        "sao",
        "se",
        "the",
        "thi",
        "to",
        "toi",
        "trong",
        "va",
        "vao",
        "ve",
        "voi",
        "what",
        "where",
        "with",
    }
)


def fold_vietnamese(text: str) -> str:
    """Fold Vietnamese diacritics and punctuation into clean lowercase ASCII tokens."""
    normalized = unicodedata.normalize("NFC", text).casefold().replace("đ", "d")
    decomposed = unicodedata.normalize("NFD", normalized)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    cleaned = re.sub(r"[^a-z0-9\s/-]+", " ", stripped)
    return " ".join(cleaned.split())


def _tokenize_meaningful(folded: str) -> list[str]:
    return [
        tok
        for tok in folded.split()
        if (len(tok) >= 2 or tok.isdigit()) and tok not in _STOPWORDS
    ]


def _bigrams(tokens: Sequence[str]) -> set[str]:
    return {f"{tokens[i]} {tokens[i + 1]}" for i in range(len(tokens) - 1)}


def _prefer_english(locale: str) -> bool:
    return not locale.casefold().startswith("vi")


_PUBLIC_ALLOWED_HREFS: frozenset[str] = frozenset(
    {"/", "/login", "/register", "/forgot-password", "/reset-password", "/admin/login"}
)

_PARENT_STATIC_NAV_ALLOWLIST: frozenset[str] = frozenset(
    {
        "/dashboard",
        "/books",
        "/my-books",
        "/book-scanner",
        "/children",
        "/children/new",
        "/profile",
        "/settings",
        "/reports",
        "/reports/difficult-words",
        "/sessions",
        "/reading-management",
        "/reading-preparation",
        "/entertainment",
        "/entertainment/memory-game",
        "/entertainment/sentence-shooter",
        "/entertainment/picture-description",
        "/karaoke",
        "/device-permissions",
        "/help-support",
        "/book-reports",
        "/studio/tasks",
    }
)

_ADMIN_STATIC_NAV_ALLOWLIST: frozenset[str] = _PARENT_STATIC_NAV_ALLOWLIST | frozenset(
    {
        "/admin",
        "/admin/books",
        "/admin/books/new",
        "/admin/metadata-quality",
        "/admin/viread-training",
        "/admin/health",
        "/admin/audit-logs",
        "/admin/parents",
        "/admin/karaoke",
        "/admin/karaoke/new",
        "/admin/tasks",
    }
)


def _is_protected_admin_path(path: str) -> bool:
    return (path == "/admin" or path.startswith("/admin/")) and path != "/admin/login"


def sanitize_scoped_path(current_path: str, role_scope: AssistantRoleScope) -> str:
    clean = sanitize_current_path(current_path)
    if role_scope != "admin" and _is_protected_admin_path(clean):
        return "/"
    return clean


def _is_href_allowed_for_scope(href: str, role_scope: AssistantRoleScope) -> bool:
    clean = sanitize_current_path(href)
    if clean != href or ".." in clean or "?" in clean or "#" in clean:
        return False
    if role_scope == "public":
        return clean in _PUBLIC_ALLOWED_HREFS
    if role_scope == "parent":
        if _is_protected_admin_path(clean):
            return False
        return clean in _PARENT_STATIC_NAV_ALLOWLIST or clean in _PUBLIC_ALLOWED_HREFS
    return clean in _ADMIN_STATIC_NAV_ALLOWLIST or clean in _PUBLIC_ALLOWED_HREFS


def is_navigation_href_allowed(href: str, role_scope: AssistantRoleScope) -> bool:
    """Strict allowlist check for interactive Yes/No navigation offers."""
    clean = sanitize_current_path(href)
    if clean != href or ".." in clean or "?" in clean or "#" in clean:
        return False
    if role_scope == "public":
        return clean in _PUBLIC_ALLOWED_HREFS
    if role_scope == "parent":
        return clean in _PARENT_STATIC_NAV_ALLOWLIST
    return clean in _ADMIN_STATIC_NAV_ALLOWLIST


def detect_disallowed_scope_request(
    message: str,
    *,
    role_scope: AssistantRoleScope,
) -> Literal["admin_area", "other_user"] | None:
    """Detect attempts to navigate into /admin/* (non-admin) or another user's private space."""
    folded = fold_vietnamese(message)
    if not folded:
        return None
    padded = f" {folded} "

    other_user_markers = (
        "nguoi dung khac",
        "tai khoan khac",
        "tai khoan nguoi khac",
        "phu huynh khac",
        "gia dinh khac",
        "ho so nguoi khac",
        "trang nguoi khac",
        "trang cua nguoi khac",
        "du lieu nguoi khac",
        "cua nguoi khac",
        "cho nguoi khac",
        "muon xem trang cua",
        "vao tai khoan cua nguoi",
        "doi sang tai khoan cua",
        "other user",
        "another user",
        "another parent",
        "another account",
        "someone else",
    )
    if any(marker in padded for marker in other_user_markers):
        return "other_user"

    if role_scope != "admin":
        admin_markers = (
            "/admin",
            "trang admin",
            "trang quan tri",
            "vao admin",
            "mo admin",
            "sang admin",
            "chuyen sang admin",
            "di den admin",
            "khu vuc quan tri",
            "bang dieu khien admin",
            "admin panel",
            "admin dashboard",
            "admin health",
            "admin tasks",
            "admin parents",
            "audit logs",
            "viread training",
            "viread-training",
        )
        if any(marker in padded or marker in folded for marker in admin_markers):
            return "admin_area"
    return None


def format_scope_boundary_reply(
    reason: Literal["admin_area", "other_user"],
    *,
    role_scope: AssistantRoleScope,
    current_path: str,
    locale: str = "vi",
) -> tuple[str, list[AssistantQuickAction], list[str]]:
    """Return a warm, clear own-scope refusal without offering disallowed routes."""
    use_en = _prefer_english(locale)
    _, _, page_prompts, page_actions = get_page_context(
        current_path, role_scope=role_scope, locale=locale
    )
    if reason == "admin_area":
        if use_en:
            reply = (
                "I'd love to help with your ViRead learning pages, but admin pages (/admin/*) are strictly "
                "restricted to authorized administrators. Everything I navigate or open stays safely inside your own user workspace."
            )
        else:
            reply = (
                "Rất tiếc, mình không thể mở hay chuyển bạn sang khu vực Quản trị (/admin) nhé! "
                "Vì an toàn tài khoản, trợ lý ViRead chỉ hỗ trợ và điều hướng trong phạm vi các trang dành riêng cho tài khoản của bạn."
            )
    else:
        if use_en:
            reply = (
                "For family privacy and security, I can never open or access another user's account, child profiles, "
                "or private reading pages. You can safely manage everything inside your own ViRead pages."
            )
        else:
            reply = (
                "Vì bảo mật và quyền riêng tư gia đình, mình không thể truy cập hay chuyển bạn sang trang, hồ sơ "
                "hoặc dữ liệu của người dùng khác nhé! Mọi thao tác đều được giữ an toàn trong phạm vi tài khoản của chính bạn."
            )
    return reply, page_actions[:3], page_prompts[:3]


@dataclass(frozen=True)
class _NavRule:
    href: str
    phrases: tuple[str, ...]
    label_vi: str
    label_en: str
    reason_vi: str
    reason_en: str


_NAV_RULES: tuple[_NavRule, ...] = (
    _NavRule(
        href="/settings",
        phrases=(
            "doi mat khau",
            "thay doi mat khau",
            "cap nhat mat khau",
            "dat mat khau",
            "change password",
            "update password",
            "cai dat",
            "thiet lap",
            "nhac doc email",
            "tuy chon email",
            "settings",
        ),
        label_vi="Đi đến trang Cài đặt đổi mật khẩu",
        label_en="Go to Password & Settings",
        reason_vi="Tại trang Cài đặt, bạn có thể đổi mật khẩu và thiết lập bảo mật cho chính tài khoản của mình.",
        reason_en="Update your own password and account settings safely.",
    ),
    _NavRule(
        href="/forgot-password",
        phrases=("quen mat khau", "khoi phuc mat khau", "dat lai mat khau", "forgot password", "reset password"),
        label_vi="Đi đến trang Quên mật khẩu",
        label_en="Go to Forgot Password",
        reason_vi="Nhập email đã đăng ký để nhận liên kết đặt lại mật khẩu an toàn.",
        reason_en="Request a secure password reset link via email.",
    ),
    _NavRule(
        href="/profile",
        phrases=("ho so ba me", "ho so phu huynh", "doi email", "so dien thoai", "parent profile"),
        label_vi="Đi đến Hồ sơ ba mẹ",
        label_en="Go to Parent Profile",
        reason_vi="Cập nhật tên hiển thị, số điện thoại và thông tin cá nhân của bạn.",
        reason_en="Manage your parent account details.",
    ),
    _NavRule(
        href="/children/new",
        phrases=("tao ho so be", "them ho so be", "them be moi", "create child", "add child"),
        label_vi="Đi đến Tạo hồ sơ bé mới",
        label_en="Go to Create Child Profile",
        reason_vi="Tạo nhanh hồ sơ đọc riêng theo tên và lớp (1–5) cho bé nhà bạn.",
        reason_en="Create a new child reading profile (Grades 1–5).",
    ),
    _NavRule(
        href="/children",
        phrases=("ho so be", "danh sach be", "sua ho so be", "child profile", "children"),
        label_vi="Đi đến trang Hồ sơ bé",
        label_en="Go to Child Profiles",
        reason_vi="Xem và chỉnh sửa hồ sơ các bé trong gia đình bạn.",
        reason_en="View and manage your child profiles.",
    ),
    _NavRule(
        href="/book-scanner",
        phrases=("quet sach", "chup trang sach", "ocr sach", "scan book", "book scanner"),
        label_vi="Đi đến Quét sách giấy AI",
        label_en="Go to AI Book Scanner",
        reason_vi="Chụp hoặc tải ảnh trang sách giấy để AI trích xuất chữ cho bé đọc.",
        reason_en="Scan printed book pages into interactive text.",
    ),
    _NavRule(
        href="/studio/tasks",
        phrases=("tac vu ai", "tien trinh ai", "tien trinh tac vu", "task center", "studio/tasks"),
        label_vi="Đi đến Trung tâm tác vụ AI",
        label_en="Go to AI Task Center",
        reason_vi="Theo dõi tiến trình quét sách, tạo ảnh minh họa và audio của bạn.",
        reason_en="Track your active background AI jobs.",
    ),
    _NavRule(
        href="/my-books",
        phrases=("sach cua toi", "tu sach gia dinh", "smart studio", "my books"),
        label_vi="Đi đến Sách của tôi",
        label_en="Go to My Books",
        reason_vi="Mở tủ sách riêng gia đình bạn đã quét hoặc tạo minh họa.",
        reason_en="Open your private scanned & illustrated books.",
    ),
    _NavRule(
        href="/books",
        phrases=("kho sach", "thu vien sach", "chon sach", "mo sach", "book catalog", "browse books"),
        label_vi="Đi đến Kho sách ViRead",
        label_en="Go to Books Library",
        reason_vi="Chọn sách tiếng Việt phù hợp độ tuổi và trình độ đọc của bé.",
        reason_en="Browse curated children's books.",
    ),
    _NavRule(
        href="/entertainment/memory-game",
        phrases=("memory game", "lat the", "the ghi nho"),
        label_vi="Đi đến Memory Game lật thẻ",
        label_en="Go to Memory Game",
        reason_vi="Chơi lật cặp thẻ giúp bé ghi nhớ từ vựng và mặt chữ vui nhộn.",
        reason_en="Play the memory card matching game.",
    ),
    _NavRule(
        href="/entertainment/sentence-shooter",
        phrases=("ghep cau", "sentence shooter"),
        label_vi="Đi đến Trò chơi Ghép câu",
        label_en="Go to Sentence Shooter",
        reason_vi="Luyện sắp xếp từ thành câu tiếng Việt hoàn chỉnh.",
        reason_en="Practice building Vietnamese sentences.",
    ),
    _NavRule(
        href="/entertainment/picture-description",
        phrases=("mo ta tranh", "picture description", "ke chuyen theo tranh"),
        label_vi="Đi đến Mô tả tranh AI",
        label_en="Go to Picture Description",
        reason_vi="Cho bé nhìn tranh kể chuyện và nhận nhận xét, gợi ý từ vựng AI.",
        reason_en="Describe pictures and receive AI feedback.",
    ),
    _NavRule(
        href="/karaoke",
        phrases=("karaoke", "hat karaoke"),
        label_vi="Đi đến Karaoke thiếu nhi",
        label_en="Go to Kids Karaoke",
        reason_vi="Hát theo lời bài hát chạy khớp nhịp để luyện phát âm.",
        reason_en="Sing along with synchronized lyrics.",
    ),
    _NavRule(
        href="/entertainment",
        phrases=("giai tri", "goc giai tri", "tro choi", "entertainment"),
        label_vi="Đi đến Góc giải trí",
        label_en="Go to Entertainment",
        reason_vi="Khám phá Karaoke, Memory Game, Ghép câu và Mô tả tranh AI.",
        reason_en="Explore language games for kids.",
    ),
    _NavRule(
        href="/reports/difficult-words",
        phrases=("tu can luyen", "tu doc sai", "tu kho", "difficult words"),
        label_vi="Đi đến Từ cần luyện",
        label_en="Go to Difficult Words",
        reason_vi="Xem danh sách các từ bé hay vấp để luyện đọc lại riêng.",
        reason_en="Review tricky words from your child's sessions.",
    ),
    _NavRule(
        href="/reports",
        phrases=("bao cao", "tien bo", "thong ke doc", "reports", "progress"),
        label_vi="Đi đến Báo cáo tiến bộ",
        label_en="Go to Progress Reports",
        reason_vi="Xem tốc độ đọc, độ chính xác và xu hướng tiến bộ của bé.",
        reason_en="Inspect fluency & accuracy analytics.",
    ),
    _NavRule(
        href="/sessions",
        phrases=("lich su doc", "lich su buoi doc", "session history"),
        label_vi="Đi đến Lịch sử buổi đọc",
        label_en="Go to Reading Sessions",
        reason_vi="Xem lại các buổi đọc đã hoàn thành hoặc đang tạm dừng.",
        reason_en="Review completed or paused sessions.",
    ),
    _NavRule(
        href="/device-permissions",
        phrases=("quyen micro", "quyen thiet bi", "kiem tra micro", "khong nhan giong", "microphone", "device permissions"),
        label_vi="Đi đến Kiểm tra quyền thiết bị",
        label_en="Go to Device Permissions",
        reason_vi="Kiểm tra nhanh quyền Micro và Camera trên trình duyệt.",
        reason_en="Check microphone & camera permissions.",
    ),
    _NavRule(
        href="/reading-management",
        phrases=("quan ly doc", "reading management"),
        label_vi="Đi đến Quản lý đọc",
        label_en="Go to Reading Management",
        reason_vi="Tổng hợp chuẩn bị đọc, phiên đọc gần đây và từ cần luyện.",
        reason_en="Open your family's reading hub.",
    ),
    _NavRule(
        href="/reading-preparation",
        phrases=("chuan bi doc", "reading preparation"),
        label_vi="Đi đến Chuẩn bị đọc",
        label_en="Go to Reading Preparation",
        reason_vi="Chọn phạm vi trang, giọng đọc mẫu và kiểm tra micro trước khi đọc.",
        reason_en="Configure page range, voice & mic before reading.",
    ),
    _NavRule(
        href="/help-support",
        phrases=("tro giup", "ho tro", "lien he", "bao loi", "gop y", "help support"),
        label_vi="Đi đến Trợ giúp & Hỗ trợ",
        label_en="Go to Help & Support",
        reason_vi="Xem hướng dẫn nhanh hoặc gửi phản hồi trực tiếp cho đội ngũ ViRead.",
        reason_en="Get support or contact the ViRead team.",
    ),
    _NavRule(
        href="/dashboard",
        phrases=("tong quan", "ban doc", "trang chu", "dashboard"),
        label_vi="Đi đến Bảng điều khiển Tổng quan",
        label_en="Go to Dashboard",
        reason_vi="Quay lại Bảng điều khiển chính để chọn bé và tiếp tục buổi đọc.",
        reason_en="Return to your main parent dashboard.",
    ),
    _NavRule(
        href="/login",
        phrases=("dang nhap", "sign in", "login"),
        label_vi="Đi đến trang Đăng nhập",
        label_en="Go to Sign In",
        reason_vi="Đăng nhập vào tài khoản ViRead của bạn.",
        reason_en="Sign in to your ViRead account.",
    ),
    _NavRule(
        href="/register",
        phrases=("dang ky", "tao tai khoan", "register", "sign up"),
        label_vi="Đi đến trang Đăng ký",
        label_en="Go to Register",
        reason_vi="Tạo tài khoản phụ huynh ViRead mới.",
        reason_en="Create a new ViRead parent account.",
    ),
)


def resolve_navigation_offer(
    message: str,
    *,
    role_scope: AssistantRoleScope,
    current_path: str,
    locale: str = "vi",
) -> AssistantNavigationOffer | None:
    """Return a single safe own-scope navigation offer when user asks how/where to navigate or act."""
    if detect_disallowed_scope_request(message, role_scope=role_scope) is not None:
        return None
    folded = fold_vietnamese(message)
    if not folded:
        return None

    clean_current = sanitize_scoped_path(current_path, role_scope)
    use_en = _prefer_english(locale)

    # Special handling: signed-out user asks to change password -> guide to /forgot-password or /login.
    if role_scope == "public" and any(
        phrase in folded for phrase in ("doi mat khau", "change password", "thay doi mat khau")
    ):
        target_href = "/forgot-password" if "quen" in folded else "/login"
        if clean_current != target_href and is_navigation_href_allowed(target_href, role_scope):
            return AssistantNavigationOffer(
                label=(
                    ("Sign in to change password" if target_href == "/login" else "Go to Password Reset")
                    if use_en
                    else (
                        "Đi đến Đăng nhập để đổi mật khẩu"
                        if target_href == "/login"
                        else "Đi đến Khôi phục mật khẩu"
                    )
                ),
                href=target_href,
                reason=(
                    "Sign in first, then open Settings (/settings) to update your password."
                    if use_en
                    else "Hãy đăng nhập tài khoản của bạn trước, sau đó vào mục Cài đặt để đổi mật khẩu an toàn."
                ),
            )
        return None

    for rule in _NAV_RULES:
        if any(phrase in folded for phrase in rule.phrases):
            if clean_current == rule.href:
                return None
            if not is_navigation_href_allowed(rule.href, role_scope):
                continue
            return AssistantNavigationOffer(
                label=rule.label_en if use_en else rule.label_vi,
                href=rule.href,
                reason=rule.reason_en if use_en else rule.reason_vi,
            )
    return None


def _route_matches(current_path: str, prefix: str) -> bool:
    if prefix == "/":
        return current_path == "/"
    return current_path == prefix or current_path.startswith(f"{prefix}/")


def get_page_context(
    current_path: str,
    *,
    role_scope: AssistantRoleScope,
    locale: str = "vi",
) -> tuple[str, str, list[str], list[AssistantQuickAction]]:
    """Return contextual (page_title, greeting, suggested_prompts, quick_actions) for a path."""
    clean_path = sanitize_scoped_path(current_path, role_scope)
    chosen: PageContextSpec | None = None
    for spec in PAGE_CONTEXT_SPECS:
        if role_scope not in spec.scopes:
            continue
        if _route_matches(clean_path, spec.prefix):
            chosen = spec
            break
    if chosen is None:
        chosen = _DEFAULT_PUBLIC_CONTEXT if role_scope == "public" else _DEFAULT_PARENT_CONTEXT

    use_en = _prefer_english(locale)
    title = chosen.title_en if use_en else chosen.title_vi
    greeting = chosen.greeting_en if use_en else chosen.greeting_vi
    prompts = list(chosen.prompts_en if use_en else chosen.prompts_vi)
    actions = [
        AssistantQuickAction(
            label=action.label_en if use_en else action.label_vi,
            href=action.href,
        )
        for action in chosen.actions
        if _is_href_allowed_for_scope(action.href, role_scope)
    ][:3]
    return title, greeting, prompts, actions


@lru_cache(maxsize=256)
def _precompute_article_index(
    article: KbArticle,
) -> tuple[tuple[str, ...], frozenset[str], frozenset[str]]:
    folded_keywords = tuple(
        folded_kw
        for kw in article.keywords
        if (folded_kw := fold_vietnamese(kw))
    )
    article_text = fold_vietnamese(
        " ".join(
            (
                article.title_vi,
                article.title_en,
                " ".join(article.keywords),
                article.short_answer_vi,
                article.short_answer_en,
                article.detailed_answer_vi,
                article.detailed_answer_en,
            )
        )
    )
    article_tokens = _tokenize_meaningful(article_text)
    return folded_keywords, frozenset(article_tokens), frozenset(_bigrams(article_tokens))


def retrieve_kb_matches(
    query: str,
    *,
    role_scope: AssistantRoleScope,
    current_path: str = "/",
    top_k: int = 3,
) -> list[KbMatch]:
    """Rank ViRead KB articles by Vietnamese/English phrase, token, bigram & coverage match.

    `score` ranks retrieval relevance for RAG grounding; `direct_score` additionally checks
    query-intent coverage so nuanced or troubleshooting questions route to Tier 1/2 LLMs
    instead of being falsely hijacked by a generic Tier 0 FAQ blurb.
    """
    clean_path = sanitize_scoped_path(current_path, role_scope)
    folded_query = fold_vietnamese(query)
    if not folded_query:
        return []
    query_tokens = _tokenize_meaningful(folded_query)
    query_token_set = set(query_tokens)
    query_bigrams = _bigrams(query_tokens)

    scored: list[KbMatch] = []
    for article in KB_ARTICLES:
        if role_scope not in article.scopes:
            continue

        folded_keywords, article_token_set, article_bigrams = _precompute_article_index(article)

        best_keyword_score = 0.0
        keyword_hits = 0
        exact_faq_hit = False
        for folded_kw in folded_keywords:
            if folded_kw == folded_query:
                best_keyword_score = 1.0
                keyword_hits += 2
                exact_faq_hit = True
            elif f" {folded_kw} " in f" {folded_query} ":
                weight = 0.88 if " " in folded_kw else 0.68
                best_keyword_score = max(best_keyword_score, weight)
                keyword_hits += 1

        matched_tokens = query_token_set & article_token_set
        token_overlap = (
            len(matched_tokens) / len(query_token_set)
            if query_token_set
            else 0.0
        )
        bigram_overlap = (
            len(query_bigrams & article_bigrams) / len(query_bigrams)
            if query_bigrams
            else 0.0
        )
        route_bonus = (
            0.08
            if any(
                prefix != "/" and _route_matches(clean_path, prefix)
                for prefix in article.route_prefixes
            )
            else 0.0
        )
        multi_hit_bonus = min(0.14, max(0, keyword_hits - 1) * 0.06)

        combined = min(
            1.0,
            max(
                best_keyword_score + multi_hit_bonus + route_bonus,
                token_overlap * 0.62 + bigram_overlap * 0.30 + route_bonus,
            ),
        )
        if exact_faq_hit:
            direct_score = 1.0
        else:
            unexplained_count = len(query_token_set - article_token_set)
            # Penalize direct Tier 0 hijacking when the user asks about specific concepts
            # not addressed in the canned article, or asks long multi-part questions.
            long_query_penalty = max(0, len(query_token_set) - 6) * 0.06
            unexplained_penalty = unexplained_count * 0.16
            coverage_factor = 0.40 + 0.60 * token_overlap
            base_direct = (
                combined * coverage_factor - unexplained_penalty - long_query_penalty
            )
            if best_keyword_score == 0.0:
                base_direct = min(base_direct, 0.55)
            direct_score = max(0.0, min(1.0, base_direct))

        if combined >= 0.22:
            scored.append(
                KbMatch(
                    article=article,
                    score=round(combined, 4),
                    direct_score=round(direct_score, 4),
                )
            )

    scored.sort(key=lambda item: (item.score, item.direct_score), reverse=True)
    return scored[: max(1, top_k)]


def format_kb_answer(
    matches: Sequence[KbMatch],
    *,
    role_scope: AssistantRoleScope,
    current_path: str,
    locale: str = "vi",
    bandwidth: BandwidthProfile = "high",
    fallback_mode: bool = False,
) -> tuple[str, list[AssistantQuickAction], list[str]]:
    """Build a crisp, bandwidth-tuned grounded answer from matched KB articles."""
    use_en = _prefer_english(locale)
    _, _, page_prompts, page_actions = get_page_context(
        current_path, role_scope=role_scope, locale=locale
    )

    if not matches:
        if use_en:
            reply = (
                "I'm the ViRead Support Assistant. I can help you with accounts, child profiles, "
                "choosing or scanning books, reading sessions & microphone checks, progress reports, "
                "difficult words, reading reminders, and entertainment games.\n"
                "Try asking a specific question (for example: how to scan a book or fix mic permissions) "
                "or open Help & Support."
            )
        else:
            reply = (
                "Tôi là Trợ lý ViRead — có thể hướng dẫn bạn về tài khoản, hồ sơ bé, chọn hoặc quét sách giấy, "
                "buổi đọc & micro/giọng đọc mẫu, báo cáo tiến bộ, từ cần luyện, nhắc đọc qua email và góc giải trí.\n"
                "Bạn hãy hỏi cụ thể hơn một chút (ví dụ: “Làm sao quét sách giấy?” hoặc “Micro không nhận giọng bé?”) "
                "hoặc chọn một gợi ý nhanh bên dưới nhé."
            )
        return reply, page_actions[:3], page_prompts[:3]

    top = matches[0].article
    if bandwidth == "low":
        body = top.short_answer_en if use_en else top.short_answer_vi
    else:
        body = top.detailed_answer_en if use_en else top.detailed_answer_vi
        if len(matches) >= 2 and matches[1].score >= 0.55 and not fallback_mode:
            second = matches[1].article
            extra_title = second.title_en if use_en else second.title_vi
            extra_short = second.short_answer_en if use_en else second.short_answer_vi
            body = f"{body}\n\n{extra_title}:\n{extra_short}"

    actions_out: list[AssistantQuickAction] = []
    seen_hrefs: set[str] = set()
    for match in matches[:2]:
        for action in match.article.actions:
            if action.href in seen_hrefs:
                continue
            if not _is_href_allowed_for_scope(action.href, role_scope):
                continue
            seen_hrefs.add(action.href)
            actions_out.append(
                AssistantQuickAction(
                    label=action.label_en if use_en else action.label_vi,
                    href=action.href,
                )
            )
            if len(actions_out) >= 3:
                break
        if len(actions_out) >= 3:
            break

    if not actions_out:
        actions_out = page_actions[:2]

    followups = list(top.followups_en if use_en else top.followups_vi) or page_prompts
    return body, actions_out[:3], followups[:3]


def build_rag_grounding_block(
    matches: Sequence[KbMatch],
    *,
    role_scope: AssistantRoleScope,
    current_path: str,
    bandwidth: BandwidthProfile,
) -> str:
    """Serialize compact grounded ViRead product facts for Cloud/Ollama system context."""
    scoped_path = sanitize_scoped_path(current_path, role_scope)
    lines: list[str] = [
        f"USER_ROLE_SCOPE: {role_scope}",
        f"CURRENT_PAGE_PATH: {scoped_path}",
        "VERIFIED_VIREAD_KNOWLEDGE:",
    ]
    if not matches:
        for article in KB_ARTICLES:
            if role_scope in article.scopes:
                lines.append(f"- {article.title_vi} ({', '.join(article.route_prefixes[:2])})")
        return "\n".join(lines)

    for match in matches:
        art = match.article
        content = art.short_answer_vi if bandwidth == "low" else art.detailed_answer_vi
        routes = ", ".join(action.href for action in art.actions) or ", ".join(art.route_prefixes)
        lines.append(f"[{art.id}] {art.title_vi} (routes: {routes})\n{content}")
    return "\n\n".join(lines)
