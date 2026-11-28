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


_PUBLIC_ONLY: frozenset[AssistantRoleScope] = frozenset({"public"})
_PARENT_ONLY: frozenset[AssistantRoleScope] = frozenset({"parent"})
_ADMIN_ONLY: frozenset[AssistantRoleScope] = frozenset({"admin"})


KB_ARTICLES: tuple[KbArticle, ...] = (
    # ------------------------------------------------------------------ Public-only KB (strictly isolated!)
    KbArticle(
        id="public_viread_overview",
        title_vi="Tổng quan về ViRead cho khách tìm hiểu",
        title_en="About ViRead (Guest Overview)",
        scopes=_PUBLIC_ONLY,
        route_prefixes=("/", "/login", "/register"),
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
            "viread phu hop lop may",
            "what is viread",
            "about viread",
            "getting started with viread",
            "viread overview",
            "viread features",
            "what can i do in viread",
            "what features does viread offer",
        ),
        short_answer_vi=(
            "ViRead (ReadAlong Vision) đồng hành cùng ba mẹ và bé tiểu học (lớp 1–5) luyện đọc tiếng Việt:\n"
            "• Kho sách tiếng Việt có kiểm duyệt độ đọc theo lớp, hoặc quét sách giấy gia đình bằng camera.\n"
            "• Bé đọc to theo từng từ có nhận diện giọng nói, giọng đọc mẫu (TTS), Chuyến Tàu Đọc 5 Phút và câu hỏi đọc hiểu AI Tutor.\n"
            "• Theo dõi tiến bộ, Vườn Âm Vị & Huy hiệu, nhắc đọc qua email và trò chơi ngôn ngữ.\n"
            "Đăng nhập (/login) hoặc Đăng ký (/register) để trải nghiệm đầy đủ cho gia đình bạn."
        ),
        detailed_answer_vi=(
            "ViRead (ReadAlong Vision) là nền tảng luyện đọc tiếng Việt dành cho gia đình có bé từ lớp 1 đến lớp 5:\n"
            "1. Tạo tài khoản phụ huynh tại /register và lập hồ sơ riêng cho từng bé theo lớp 1–5.\n"
            "2. Chọn sách tiếng Việt phù hợp trình độ hoặc số hóa sách giấy gia đình qua Quét sách & Family StoryWeaver.\n"
            "3. Bé đọc to tương tác từng từ (hỗ trợ cả nhận diện giọng nói ngoại tuyến trên trình duyệt, Đọc đôi cùng ba mẹ và câu hỏi đọc hiểu AI Tutor).\n"
            "4. Lưu tiến độ, chứng nhận cột mốc, Vườn Âm Vị và các trò chơi ngôn ngữ thiếu nhi.\n"
            "Bạn hãy Đăng nhập (/login) hoặc Đăng ký (/register) để mở không gian học đọc của gia đình."
        ),
        short_answer_en=(
            "ViRead (ReadAlong Vision) helps parents and Grade 1–5 children practice Vietnamese reading:\n"
            "• Curated books with grade readability badges plus paper book camera scanning.\n"
            "• Word-by-word read-aloud with speech recognition, model TTS voice, 5-Minute Reading Train, and AI Tutor quizzes.\n"
            "• Progress analytics, Phoneme Garden badges, email reminders, and language games.\n"
            "Sign in (/login) or Register (/register) to start your family workspace."
        ),
        detailed_answer_en=(
            "ViRead (ReadAlong Vision) is a Vietnamese reading companion for Grade 1–5 families:\n"
            "1. Register a parent account at /register and add separate profiles per child (Grades 1–5).\n"
            "2. Browse graded books or digitize family books via Book Scanner and Family StoryWeaver.\n"
            "3. Practice read-aloud sessions with speech recognition, model TTS voices, Duet Reading, and AI Tutor comprehension checks.\n"
            "4. Track analytics, Milestone Certificates, Phoneme Garden achievements, and kids language games.\n"
            "Sign in (/login) or create an account (/register) to begin."
        ),
        actions=(
            KbAction("Đăng nhập", "Sign in", "/login"),
            KbAction("Đăng ký tài khoản", "Register", "/register"),
        ),
        followups_vi=(
            "Cách đăng ký và xác minh email tài khoản ViRead?",
            "Quên mật khẩu thì khôi phục thế nào?",
            "3 bước bắt đầu cho ba mẹ mới gồm gì?",
        ),
        followups_en=(
            "How do I register and verify my email?",
            "How do I reset a forgotten password?",
            "How do new parents get started?",
        ),
    ),
    KbArticle(
        id="public_auth_login_register",
        title_vi="Đăng nhập, đăng ký và xác minh tài khoản ViRead",
        title_en="Sign in, register, and email verification",
        scopes=_PUBLIC_ONLY,
        route_prefixes=("/login", "/register", "/forgot-password", "/reset-password"),
        keywords=(
            "dang nhap",
            "dang ky",
            "quen mat khau",
            "dat lai mat khau",
            "khoi phuc mat khau",
            "doi mat khau",
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
            "change password",
            "verification email",
            "confirmation email",
        ),
        short_answer_vi=(
            "Hỗ trợ tài khoản ViRead:\n"
            "• Đăng ký mới (/register): nhập email + mật khẩu và mở liên kết xác minh trong email trên cùng trình duyệt (hãy kiểm tra thêm mục Thư rác).\n"
            "• Quên mật khẩu (/forgot-password): nhập email để nhận liên kết đặt lại mật khẩu trên cùng trình duyệt/thiết bị.\n"
            "• Hỗ trợ đăng nhập Google/Facebook tại /login; sau khi đăng nhập mới có thể đổi mật khẩu trong phần cài đặt."
        ),
        detailed_answer_vi=(
            "Hướng dẫn đăng nhập, đăng ký và khôi phục mật khẩu trên ViRead:\n"
            "1. Đăng ký (/register): điền email thật và mật khẩu, sau đó bấm liên kết xác minh trong email trên cùng trình duyệt vừa đăng ký (ViRead dùng chuẩn bảo mật PKCE).\n"
            "2. Không nhận được email xác nhận: kiểm tra hộp thư rác/Quảng cáo và chắc chắn email nhập đúng chính tả.\n"
            "3. Quên mật khẩu (/forgot-password): nhập email đã đăng ký để nhận liên kết đặt lại mật khẩu tại /reset-password trên cùng trình duyệt.\n"
            "4. Đổi mật khẩu: hãy đăng nhập vào tài khoản của bạn tại /login trước để truy cập mục cài đặt bảo mật."
        ),
        short_answer_en=(
            "ViRead account help:\n"
            "• Register (/register): sign up with your email & password and open the verification link in the same browser.\n"
            "• Forgot password (/forgot-password): enter your email and open the recovery link on the same browser/device.\n"
            "• Google/Facebook sign-in is available on /login; sign in first to manage password settings."
        ),
        detailed_answer_en=(
            "Sign-in, registration, and password recovery on ViRead:\n"
            "1. Register at /register with a valid email, then open the confirmation link in the same browser (ViRead uses PKCE).\n"
            "2. Missing confirmation email? Check Spam/Junk and verify spelling.\n"
            "3. Forgot password? Open /forgot-password, enter your account email, and complete reset at /reset-password in the same browser.\n"
            "4. To change an existing password, sign in at /login first."
        ),
        actions=(
            KbAction("Trang đăng nhập", "Login page", "/login"),
            KbAction("Đăng ký tài khoản", "Register", "/register"),
            KbAction("Quên mật khẩu", "Forgot password", "/forgot-password"),
        ),
        followups_vi=(
            "Không nhận được email xác nhận thì làm sao?",
            "ViRead có những chức năng gì?",
            "Cần chuẩn bị micro và camera như thế nào?",
        ),
        followups_en=(
            "I didn't receive the verification email",
            "What can I do in ViRead?",
            "How do I prepare mic and camera permissions?",
        ),
    ),
    KbArticle(
        id="public_onboarding_preview",
        title_vi="3 bước bắt đầu với ViRead sau khi đăng nhập",
        title_en="3-step ViRead overview for new families",
        scopes=_PUBLIC_ONLY,
        route_prefixes=("/", "/register", "/login"),
        keywords=(
            "ba me moi",
            "nguoi moi",
            "moi su dung",
            "3 buoc bat dau",
            "bat dau nhu the nao",
            "lan dau su dung",
            "huong dan nhanh",
            "new parent",
            "onboarding",
            "3 steps",
            "first time",
            "quickstart",
        ),
        short_answer_vi=(
            "Sau khi Đăng ký (/register) hoặc Đăng nhập (/login), ba mẹ bắt đầu chỉ với 3 bước:\n"
            "1. Tạo hồ sơ bé theo lớp (1–5) để tách biệt tiến độ từng con.\n"
            "2. Chọn sách trong thư viện hoặc quét sách giấy gia đình bằng camera.\n"
            "3. Kiểm tra micro và bắt đầu buổi đọc tương tác cùng bé."
        ),
        detailed_answer_vi=(
            "Quy trình 3 bước dành cho gia đình mới tham gia ViRead:\n"
            "1. Đăng ký tài khoản phụ huynh tại /register (hoặc đăng nhập tại /login) và tạo hồ sơ bé theo lớp 1–5.\n"
            "2. Chọn sách tiếng Việt phù hợp trình độ hoặc chụp trang sách giấy của gia đình.\n"
            "3. Kiểm tra micro, chọn giọng đọc mẫu và bắt đầu buổi đọc hoặc Chuyến Tàu Đọc 5 Phút cùng bé."
        ),
        short_answer_en=(
            "After registering (/register) or signing in (/login), families start in 3 steps:\n"
            "1. Create a child profile (Grades 1–5) to keep progress separate.\n"
            "2. Pick a library book or scan your own paper pages.\n"
            "3. Test your microphone and launch an interactive reading session."
        ),
        detailed_answer_en=(
            "3-step family quickstart after signing in:\n"
            "1. Register at /register (or sign in at /login) and create a Grade 1–5 child profile.\n"
            "2. Browse graded Vietnamese books or scan family paper books.\n"
            "3. Verify your mic, pick a model voice, and start reading or the 5-Minute Reading Train."
        ),
        actions=(
            KbAction("Đăng ký ngay", "Register now", "/register"),
            KbAction("Đăng nhập", "Sign in", "/login"),
        ),
        followups_vi=(
            "Cách xác minh email sau khi đăng ký?",
            "ViRead phù hợp cho bé lớp mấy?",
            "Khắc phục lỗi micro và camera?",
        ),
        followups_en=(
            "How do I verify my email after signing up?",
            "Which grade levels is ViRead for?",
            "How do I fix mic and camera permissions?",
        ),
    ),
    KbArticle(
        id="public_mic_camera_readiness",
        title_vi="Chuẩn bị quyền Micro và Camera trên trình duyệt",
        title_en="Browser microphone and camera readiness",
        scopes=_PUBLIC_ONLY,
        route_prefixes=("/", "/login", "/register"),
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
            "Để micro & camera hoạt động ổn định khi dùng ViRead:\n"
            "1. Truy cập qua HTTPS (hoặc localhost) và bấm biểu tượng ổ khóa trên thanh địa chỉ → chọn Cho phép (Allow) Microphone/Camera.\n"
            "2. Đóng các ứng dụng đang chiếm micro (Zoom, Meet, ghi âm) và tải lại trang.\n"
            "3. Đăng nhập (/login) để mở bước kiểm tra micro và quét sách dành riêng cho gia đình bạn."
        ),
        detailed_answer_vi=(
            "Hướng dẫn chuẩn bị thiết bị trước khi đăng nhập học đọc trên ViRead:\n"
            "1. Trên Chrome/Edge máy tính: bấm biểu tượng cài đặt bên trái thanh URL → bật Microphone & Camera → tải lại trang.\n"
            "2. Trên điện thoại (iOS Safari / Android Chrome / ứng dụng ViRead Android APK): mở Cài đặt máy → Quyền ứng dụng → bật Micro & Máy ảnh.\n"
            "3. Trình duyệt chỉ cấp quyền micro/camera trên trang HTTPS và khi không bị ứng dụng khác chiếm dụng.\n"
            "4. Hãy Đăng nhập (/login) hoặc Đăng ký (/register) để vào kiểm tra micro thực tế cho bé."
        ),
        short_answer_en=(
            "Preparing mic & camera for ViRead:\n"
            "1. Ensure you are on HTTPS (or localhost) and click the address-bar lock/settings icon → Allow Microphone & Camera.\n"
            "2. Close other apps using the mic (Zoom/Meet) and reload.\n"
            "3. Sign in (/login) to access your family mic check and book scanner."
        ),
        detailed_answer_en=(
            "Device permission readiness before signing in:\n"
            "1. Desktop Chrome/Edge: click site settings next to the URL, allow Microphone & Camera, and refresh.\n"
            "2. Mobile (iOS Safari / Android Chrome / ViRead Android APK): enable Microphone & Camera in OS app settings.\n"
            "3. Browsers require HTTPS and exclusive microphone access.\n"
            "4. Sign in (/login) or register (/register) to run the in-app mic readiness check."
        ),
        actions=(
            KbAction("Đăng nhập", "Sign in", "/login"),
            KbAction("Đăng ký", "Register", "/register"),
        ),
        followups_vi=(
            "ViRead có những chức năng gì?",
            "Cách đăng ký tài khoản ViRead?",
            "Quên mật khẩu thì làm sao?",
        ),
        followups_en=(
            "What features does ViRead offer?",
            "How do I register a ViRead account?",
            "How do I reset my password?",
        ),
    ),
    KbArticle(
        id="public_support_and_privacy",
        title_vi="Liên hệ hỗ trợ ViRead & bảo mật riêng tư tài khoản",
        title_en="Contact ViRead support & account privacy",
        scopes=_PUBLIC_ONLY,
        route_prefixes=("/", "/login", "/register", "/forgot-password"),
        keywords=(
            "bao mat",
            "rieng tu",
            "du lieu gia dinh",
            "phan quyen",
            "rls",
            "lien he ho tro",
            "lien he viread",
            "email ho tro",
            "tro giup",
            "ho tro",
            "vireadforyou",
            "privacy",
            "security",
            "contact support",
            "support email",
        ),
        short_answer_vi=(
            "Hỗ trợ & Bảo mật ViRead:\n"
            "• Email hỗ trợ chính thức: vireadforyou@gmail.com (tuyệt đối không gửi mật khẩu hay mã OTP qua email).\n"
            "• Dữ liệu mỗi gia đình được cách ly riêng tư (Supabase Auth + RLS); khách chưa đăng nhập chỉ xem được các trang công khai (/login, /register, /forgot-password)."
        ),
        detailed_answer_vi=(
            "Chính sách hỗ trợ và bảo vệ riêng tư cho gia đình trên ViRead:\n"
            "1. Liên hệ hỗ trợ khi chưa đăng nhập: gửi email tới vireadforyou@gmail.com để được hỗ trợ tài khoản hoặc lỗi kỹ thuật (không bao gồm mật khẩu/token).\n"
            "2. Cách ly dữ liệu nghiêm ngặt: chỉ phụ huynh đã đăng nhập mới truy cập được hồ sơ bé, sách riêng và báo cáo của chính mình.\n"
            "3. Trợ lý AI không bao giờ mở hay tiết lộ dữ liệu người dùng khác hoặc khu vực quản trị."
        ),
        short_answer_en=(
            "ViRead Support & Privacy:\n"
            "• Official support email: vireadforyou@gmail.com (never send passwords or OTP codes).\n"
            "• Every family account is strictly isolated (Supabase Auth + RLS); signed-out guests stay on public routes (/login, /register, /forgot-password)."
        ),
        detailed_answer_en=(
            "Support and privacy guarantees on ViRead:\n"
            "1. Contact support anytime at vireadforyou@gmail.com (never include passwords or tokens).\n"
            "2. Strict tenant isolation ensures only signed-in parents can view their own children, books, and reading reports.\n"
            "3. The assistant never exposes other users' data or admin routes."
        ),
        actions=(
            KbAction("Đăng nhập", "Sign in", "/login"),
            KbAction("Đăng ký", "Register", "/register"),
        ),
        followups_vi=(
            "Quên mật khẩu thì khôi phục thế nào?",
            "ViRead có những chức năng gì?",
            "Không nhận được email xác nhận thì làm sao?",
        ),
        followups_en=(
            "How do I reset a forgotten password?",
            "What can I do in ViRead?",
            "I didn't receive the verification email",
        ),
    ),
    KbArticle(
        id="public_assistant_tiers",
        title_vi="Cách Trợ lý ViRead hoạt động theo băng tần & ngoại tuyến",
        title_en="How ViRead Assistant adapts to bandwidth and offline mode",
        scopes=_PUBLIC_ONLY,
        route_prefixes=("/", "/login", "/register"),
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
            "tiet kiem bang tan",
            "mang cham",
            "mang yeu",
            "3g",
            "mat mang",
            "che do ngoai tuyen",
            "slow 3g",
            "low bandwidth",
            "data saver",
            "offline mode",
            "viread assistant",
            "bandwidth mode",
            "hide assistant",
        ),
        short_answer_vi=(
            "Trợ lý ViRead dùng kiến trúc phân tầng ưu tiên tốc độ:\n"
            "• Tầng 0: Kho hướng dẫn ViRead nội bộ (<15ms, siêu tiết kiệm dữ liệu 2G/3G).\n"
            "• Tầng 1 & 2: Cloud AI tốc độ cao (Gemini → Groq) và dự phòng cục bộ.\n"
            "• Bạn có thể bấm biểu tượng mắt gạch trên tiêu đề khung chat để ẩn trợ lý bất cứ lúc nào."
        ),
        detailed_answer_vi=(
            "Trợ lý ViRead tự động tối ưu theo kết nối mạng của bạn:\n"
            "1. Chế độ Tiết kiệm (Low bandwidth): trả lời cực gọn từ Tầng 0 để tiết kiệm 3G.\n"
            "2. Ngoại tuyến: khi mất mạng, trợ lý vẫn tra cứu được hướng dẫn nhanh ngay trên trình duyệt.\n"
            "3. Bấm nút Ẩn trợ lý để thu gọn thành tai nhỏ ở mép màn hình bất kỳ lúc nào."
        ),
        short_answer_en=(
            "ViRead Assistant uses a fast tiered cascade:\n"
            "• Tier 0: Local grounded guide (<15ms, ideal for slow 3G/data saver).\n"
            "• Tier 1 & 2: Fast Cloud AI failover with offline quick-guide fallback.\n"
            "• Click the Hide icon anytime to tuck the assistant away."
        ),
        detailed_answer_en=(
            "How ViRead Assistant adapts to your network:\n"
            "1. Saver mode gives ultra-concise Tier 0 answers on slow connections.\n"
            "2. Offline mode falls back smoothly to the built-in quick guide.\n"
            "3. Hide the widget anytime into a subtle edge tab."
        ),
        actions=(
            KbAction("Đăng nhập", "Sign in", "/login"),
            KbAction("Đăng ký", "Register", "/register"),
        ),
        followups_vi=(
            "ViRead có những chức năng gì?",
            "Cách đăng ký tài khoản ViRead?",
            "Liên hệ hỗ trợ ViRead ở đâu?",
        ),
        followups_en=(
            "What features does ViRead offer?",
            "How do I register for ViRead?",
            "How do I contact ViRead support?",
        ),
    ),
    # ------------------------------------------------------------------ Parent-only KB (strictly isolated!)
    KbArticle(
        id="viread_overview",
        title_vi="Tổng quan về ViRead",
        title_en="About ViRead",
        scopes=_PARENT_ONLY,
        route_prefixes=("/dashboard",),
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
            "• Chọn sách có huy hiệu độ đọc theo lớp hoặc tự tạo/quét sách gia đình tại Sách của tôi (/my-books) & Quét sách (/book-scanner).\n"
            "• Bé đọc to theo từng từ (hỗ trợ Đọc đôi cùng ba mẹ, WASM ngoại tuyến, AI Tutor đọc hiểu) hoặc luyện nhanh trên Chuyến Tàu Đọc 5 Phút (/learning-train).\n"
            "• Theo dõi Tiến bộ (/reports), Vườn Âm Vị & Huy hiệu (/achievements), Từ cần luyện, nhắc đọc qua email và Góc giải trí (/entertainment)."
        ),
        detailed_answer_vi=(
            "ViRead (ReadAlong Vision) là nền tảng luyện đọc tiếng Việt dành cho gia đình có bé từ lớp 1 đến lớp 5:\n"
            "1. Tạo hồ sơ bé (/children) theo từng lớp để lưu tủ sách, huy hiệu và tiến độ riêng.\n"
            "2. Chọn sách ở mục Sách (/books) có đánh giá độ đọc tiếng Việt, quét sách giấy (/book-scanner) hoặc sáng tác truyện Family StoryWeaver tại Sách của tôi (/my-books).\n"
            "3. Cho bé vào buổi đọc tương tác (/reading-preparation → /reading) với nhận diện giọng nói (gồm WASM ngoại tuyến), giọng đọc mẫu AI Teacher Persona, Đọc đôi (Duet Reading) và câu hỏi đọc hiểu AI Tutor.\n"
            "4. Ôn nhanh mỗi ngày qua Chuyến Tàu Đọc 5 Phút (/learning-train), xem Báo cáo Tiến bộ (/reports), Chứng nhận cột mốc, Vườn Âm Vị (/achievements) và đặt lịch email tại Quản lý đọc (/reading-management).\n"
            "5. Mở rộng vốn từ qua Góc giải trí (/entertainment): Karaoke đồng dao (/karaoke), Memory Game, Ghép câu và Mô tả tranh AI."
        ),
        short_answer_en=(
            "ViRead helps parents and Grade 1–5 children practice Vietnamese reading:\n"
            "• Pick graded books or scan/weave family stories in My Books (/my-books) & Book Scanner (/book-scanner).\n"
            "• Read aloud with speech recognition (including offline WASM), Duet Reading, 5-Minute Reading Train (/learning-train), and AI Tutor quizzes.\n"
            "• Track Progress (/reports), Phoneme Garden (/achievements), Difficult Words, email reminders, and Entertainment games (/entertainment)."
        ),
        detailed_answer_en=(
            "ViRead (ReadAlong Vision) is a family reading companion for Grade 1–5 learners:\n"
            "1. Create separate child profiles (/children) by grade.\n"
            "2. Browse graded Books (/books), scan paper pages (/book-scanner), or create custom Family StoryWeaver books in My Books (/my-books).\n"
            "3. Run guided sessions (/reading-preparation → /reading) with speech recognition (including on-device WASM), AI Teacher Voice Persona, Duet Reading, and AI Tutor comprehension checks.\n"
            "4. Practice daily with the 5-Minute Reading Train (/learning-train), review Progress Reports (/reports), Milestone Certificates, Phoneme Garden (/achievements), and Reading Management (/reading-management).\n"
            "5. Enjoy Entertainment (/entertainment): Kids Karaoke (/karaoke), Memory Game, Sentence Shooter, and Picture Description."
        ),
        actions=(
            KbAction("Về Tổng quan", "Open Dashboard", "/dashboard"),
            KbAction("Mở kho Sách", "Browse Books", "/books"),
            KbAction("Mở Trợ giúp & hỗ trợ", "Open Help & Support", "/help-support"),
        ),
        followups_vi=(
            "Làm sao tạo hồ sơ cho bé?",
            "Chuyến Tàu Đọc 5 Phút và Vườn Âm Vị là gì?",
            "Làm sao quét sách giấy hoặc dùng Family StoryWeaver?",
        ),
        followups_en=(
            "How do I create a child profile?",
            "What are 5-Minute Reading Train and Phoneme Garden?",
            "How do I scan a book or use Family StoryWeaver?",
        ),
    ),
    KbArticle(
        id="child_profiles",
        title_vi="Tạo và quản lý hồ sơ bé",
        title_en="Create and manage child profiles",
        scopes=_PARENT_ONLY,
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
        title_vi="Hồ sơ ba mẹ, cài đặt mật khẩu, mã PIN 4 số và ngôn ngữ",
        title_en="Parent profile, password, 4-digit Parent PIN, and language settings",
        scopes=_PARENT_ONLY,
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
            "ma pin",
            "pin 4 so",
            "parent pin",
            "parent profile",
            "change password",
            "account settings",
            "change language",
            "switch language",
        ),
        short_answer_vi=(
            "Quản lý tài khoản ba mẹ & giao diện:\n"
            "• Sửa tên hiển thị, số điện thoại, ảnh đại diện hoặc yêu cầu đổi email tại Hồ sơ ba mẹ (/profile).\n"
            "• Đổi mật khẩu và bật Khóa PIN Phụ huynh 4 chữ số (bảo vệ chế độ An toàn cho bé) tại Cài đặt (/settings).\n"
            "• Đổi ngôn ngữ giao diện (11 ngôn ngữ, giữ nguyên nội dung học đọc tiếng Việt) bằng nút chọn ngôn ngữ trên thanh đầu trang hoặc menu tài khoản."
        ),
        detailed_answer_vi=(
            "Các thiết lập tài khoản phụ huynh trên ViRead:\n"
            "1. Hồ sơ ba mẹ (/profile): bấm Chỉnh sửa hồ sơ để cập nhật họ tên, số điện thoại liên hệ, ảnh đại diện hoặc yêu cầu đổi email (email mới chỉ có hiệu lực sau khi xác minh).\n"
            "2. Cài đặt bảo mật (/settings): đổi mật khẩu hiện tại, gửi email đặt mật khẩu cho tài khoản Google/Facebook, và thiết lập Khóa PIN Phụ huynh 4 chữ số (tự khóa 5 phút nếu nhập sai 5 lần).\n"
            "3. Ngôn ngữ giao diện: ViRead hỗ trợ 11 ngôn ngữ (Tiếng Việt, English, Français, Deutsch, Español, 日本語, 한국어, 中文, العربية, עברית) mà vẫn giữ nguyên nội dung sách & nhận diện đọc tiếng Việt."
        ),
        short_answer_en=(
            "Parent account & interface settings:\n"
            "• Update display name, contact phone, avatar, or email in Parent Profile (/profile).\n"
            "• Change your password and configure the 4-digit Parent PIN Lock in Settings (/settings).\n"
            "• Switch between 11 UI languages via the language selector in the header or account menu (Vietnamese reading content remains intact)."
        ),
        detailed_answer_en=(
            "Managing your ViRead parent account:\n"
            "1. Parent Profile (/profile): click Edit Profile to update display name, phone number, avatar, or request an email change (requires verification).\n"
            "2. Settings (/settings): change your password, send a password setup link for Google/Facebook sign-in, or enable the 4-digit Parent PIN Lock (5-attempt / 5-minute lockout).\n"
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
            KbAction("Chuẩn bị đọc & kiểm tra micro", "Reading Prep & Mic Check", "/reading-preparation"),
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
        scopes=_PARENT_ONLY,
        route_prefixes=("/reading-preparation", "/reading", "/book-scanner", "/entertainment"),
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
            "1. Mở Chuẩn bị buổi đọc (/reading-preparation) để kiểm tra micro (nhớ chọn hồ sơ bé trước) hoặc mở Quét sách (/book-scanner) để kiểm tra camera.\n"
            "2. Bấm biểu tượng ổ khóa trên thanh địa chỉ trình duyệt → chọn Cho phép (Allow) cho Microphone/Camera rồi tải lại trang.\n"
            "3. Đảm bảo đang truy cập qua HTTPS (hoặc localhost) và không có ứng dụng khác (Zoom, Meet, ghi âm) đang chiếm micro."
        ),
        detailed_answer_vi=(
            "Hướng dẫn xử lý khi Micro hoặc Camera không hoạt động trên ViRead:\n"
            "1. Kiểm tra ngay trong bước Chuẩn bị buổi đọc (/reading-preparation) cho micro hoặc Quét sách (/book-scanner) cho camera (chọn đúng hồ sơ bé trước khi vào).\n"
            "2. Trên Chrome/Edge máy tính: bấm biểu tượng cài đặt bên trái thanh URL → bật Microphone & Camera → tải lại trang.\n"
            "3. Trên điện thoại (Safari iOS / Chrome Android / ứng dụng ViRead Android): vào Cài đặt điện thoại → Ứng dụng → chọn trình duyệt hoặc ViRead → Quyền → bật Micro & Máy ảnh.\n"
            "4. Kiểm tra kết nối: trình duyệt chỉ cấp quyền micro/camera trên trang HTTPS (hoặc localhost khi chạy nội bộ) và khi không bị ứng dụng gọi video khác chiếm dụng."
        ),
        short_answer_en=(
            "Quick Mic / Camera fixes:\n"
            "1. Test your mic inside Reading Preparation (/reading-preparation, after selecting a child profile) or test your camera inside Book Scanner (/book-scanner).\n"
            "2. Click the browser address-bar lock/settings icon → set Microphone & Camera to Allow, then reload.\n"
            "3. Confirm you are on HTTPS (or localhost) and no other app is holding the microphone."
        ),
        detailed_answer_en=(
            "Troubleshooting Microphone and Camera access in ViRead:\n"
            "1. Select a child profile first, then test microphone readiness in Reading Preparation (/reading-preparation) or camera access in Book Scanner (/book-scanner).\n"
            "2. Desktop Chrome/Edge: click the site-settings icon next to the URL, enable Microphone & Camera, and refresh.\n"
            "3. Mobile (iOS Safari / Android Chrome / ViRead Android app): open OS Settings → Apps → Browser/ViRead → Permissions → allow Microphone & Camera.\n"
            "4. Browsers require HTTPS (or localhost) and exclusive mic access (close Zoom/Meet/recording apps)."
        ),
        actions=(
            KbAction("Chuẩn bị đọc & kiểm tra micro", "Reading Prep & Mic Check", "/reading-preparation"),
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
        scopes=_PARENT_ONLY,
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
            "quet nhanh hay sach cua toi",
            "khac nhau giua quet sach",
            "quick scan vs my books",
            "book scanner",
            "my books",
            "private book",
            "scan page",
            "upload pdf",
        ),
        short_answer_vi=(
            "So sánh Quét nhanh (/book-scanner) và Sách của tôi (/my-books):\n"
            "• Quét sách (/book-scanner): chụp nhanh từng trang sách giấy bằng camera (cần chọn hồ sơ bé trước) để đọc ngay.\n"
            "• Sách của tôi (/my-books): quản lý tủ sách gia đình (tải nhiều ảnh/PDF/DOCX tối đa 30 trang, chỉnh chữ OCR, dùng Smart Studio tạo bìa & tranh minh họa AI).\n"
            "• Nếu máy chủ OCR tạm bận hoặc mất mạng, trang quét tự lưu an toàn vào Hàng chờ OCR và theo dõi tại /studio/tasks."
        ),
        detailed_answer_vi=(
            "ViRead hỗ trợ số hóa sách giấy gia đình qua hai khu vực bổ trợ nhau:\n"
            "1. Quét nhanh (/book-scanner): chọn hồ sơ bé rồi chụp trực tiếp trang sách bằng camera hoặc chọn ảnh (JPG, PNG, WebP) để trích xuất văn bản tiếng Việt nhanh và đọc ngay.\n"
            "2. Sách của tôi (/my-books) & Smart Studio: tạo cuốn sách riêng tư cho gia đình từ nhiều ảnh hoặc tệp PDF/DOCX (tối đa 30 trang/cuốn), chỉnh sửa chữ nhận diện, dùng Smart Studio tạo ảnh bìa & minh họa AI, thêm/bớt trang hoặc xóa sách riêng bất cứ lúc nào.\n"
            "3. Hàng chờ OCR ngoại tuyến (Offline OCR Queue): nếu worker OCR tạm bận hoặc mất kết nối, tác vụ được giữ an toàn trong Trung tâm tác vụ (/studio/tasks) mà không mất ảnh đã tải.\n"
            "4. Đóng góp cải thiện OCR: ba mẹ có thể chủ động gửi bản sửa chữ đã kiểm tra để giúp nâng cao độ chính xác nhận diện tiếng Việt (tùy chọn, hoàn toàn tôn trọng quyền riêng tư)."
        ),
        short_answer_en=(
            "Quick Scan (/book-scanner) vs Family Library (/my-books):\n"
            "• Book Scanner (/book-scanner): quick camera/photo page capture (select a child profile first) for immediate reading.\n"
            "• My Books (/my-books): manage your private family library (multi-page images/PDF/DOCX up to 30 pages, edit OCR text, Smart Studio AI covers & illustrations).\n"
            "• If the OCR worker is temporarily offline, pages stay safely in the Offline OCR Queue tracked in /studio/tasks."
        ),
        detailed_answer_en=(
            "Digitizing your own paper books in ViRead:\n"
            "1. Quick Scan (/book-scanner): select an active child profile, capture a page with your camera or upload JPEG/PNG/WebP images for fast Vietnamese OCR.\n"
            "2. Family Library (/my-books) & Smart Studio: create private family books from multiple images, PDF, or DOCX files (up to 30 pages), edit extracted text, and generate AI covers/illustrations.\n"
            "3. Offline OCR Queue: if the OCR server is paused or network drops, uploads wait safely in the AI Task Center (/studio/tasks) without losing progress.\n"
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
        route_prefixes=("/reading-management",),
        keywords=(
            "quan ly doc",
            "muc tieu",
            "muc tieu tuan",
            "lich doc",
            "nhac doc",
            "email nhac doc",
            "ke hoach doc",
            "sach da luu",
            "thoi quen doc",
            "thoi quen doc hang tuan",
            "reading management",
            "reading goal",
            "weekly reading habit",
            "reminder",
            "schedule",
            "email reminder",
        ),
        short_answer_vi=(
            "Xây dựng thói quen đọc hàng tuần tại Quản lý đọc (/reading-management) & Cài đặt (/settings):\n"
            "• Đặt mục tiêu số buổi/phút đọc hàng tuần cho từng bé tại /reading-management.\n"
            "• Tạo lịch nhắc đọc theo khung giờ và ngày trong tuần; bật/tắt tùy chọn email nhắc đọc trong /reading-management hoặc /settings (gửi tới email đã xác minh).\n"
            "• Lưu sẵn danh sách sách muốn bé đọc trong tuần."
        ),
        detailed_answer_vi=(
            "Duy trì thói quen đọc đều đặn cùng Quản lý đọc (/reading-management) và Cài đặt (/settings):\n"
            "1. Mục tiêu tuần (/reading-management): thiết lập mục tiêu số buổi hoặc số phút đọc mỗi tuần riêng cho từng hồ sơ bé.\n"
            "2. Lịch nhắc đọc qua email: chọn giờ nhắc, múi giờ và các ngày trong tuần tại /reading-management; có thể bật/tắt nhận email thông báo tổng thể trong Cài đặt (/settings). Email chỉ gửi đến địa chỉ đã xác minh và hiển thị trạng thái lần gửi.\n"
            "3. Tủ sách đã lưu: đánh dấu những cuốn sách ba mẹ muốn bé đọc trong tuần để mở nhanh."
        ),
        short_answer_en=(
            "Build weekly reading habits in Reading Management (/reading-management) & Settings (/settings):\n"
            "• Set weekly session/minute reading goals per child at /reading-management.\n"
            "• Schedule recurring email reminders and toggle email notification preferences in /reading-management or /settings.\n"
            "• Bookmark books ready for upcoming sessions."
        ),
        detailed_answer_en=(
            "Reading Management (/reading-management) and Settings (/settings) keep family reading consistent:\n"
            "1. Weekly Goals: define target sessions or reading minutes per child at /reading-management.\n"
            "2. Email Reminders: pick days, time, and timezone in /reading-management, and manage email delivery preferences in Settings (/settings). Reminders deliver to your verified account email.\n"
            "3. Saved Books: bookmark books you want your child to read next."
        ),
        actions=(
            KbAction("Mở Quản lý đọc", "Open Reading Management", "/reading-management"),
            KbAction("Mở Cài đặt", "Open Settings", "/settings"),
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
        scopes=_PARENT_ONLY,
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
            "be luoi doc",
            "be ngai doc",
            "be chan doc",
            "reluctant reader",
            "make reading fun",
            "entertainment",
            "language games",
        ),
        short_answer_vi=(
            "Với bé còn ngại đọc hoặc thích vừa học vừa chơi, ba mẹ chọn hồ sơ bé rồi mở Góc giải trí (/entertainment) với 4 hoạt động:\n"
            "• Karaoke thiếu nhi (/karaoke): hát theo lời chạy khớp nhịp giúp bé luyện phát âm & nhịp điệu.\n"
            "• Memory Game lật thẻ (/entertainment/memory-game): lật cặp thẻ chữ/hình tương ứng để rèn trí nhớ từ vựng và phản xạ mặt chữ.\n"
            "• Ghép câu (/entertainment/sentence-shooter): sắp xếp từ thành câu tiếng Việt hoàn chỉnh.\n"
            "• Mô tả tranh AI (/entertainment/picture-description): bé nhìn tranh, nói hoặc nhập câu kể chuyện và nhận nhận xét, gợi ý từ vựng + sao khen ngợi."
        ),
        detailed_answer_vi=(
            "Khám phá 4 hoạt động trong Góc giải trí (/entertainment) — rất phù hợp để khởi động nhẹ nhàng cho bé chưa hào hứng đọc sách (nhớ chọn hồ sơ bé trước để lưu sao & tiến độ):\n"
            "1. Karaoke (/karaoke): chọn bài hát thiếu nhi, nghe nhạc nền và đọc/hát theo từng chữ tô sáng khớp thời gian.\n"
            "2. Memory Game lật thẻ (/entertainment/memory-game): tìm và ghép các cặp thẻ tương ứng để luyện ghi nhớ mặt chữ tiếng Việt, từ vựng và sự tập trung.\n"
            "3. Ghép câu — Sentence Shooter (/entertainment/sentence-shooter): rèn cấu trúc câu và ngữ pháp tiếng Việt qua từng vòng chơi sinh động.\n"
            "4. Mô tả tranh AI (/entertainment/picture-description): chọn tranh mẫu hoặc tải ảnh tranh lên, bé quan sát và kể lại bằng lời; AI gợi ý từ vựng, chấm điểm 1–10 (tối đa 3 sao) và khuyên cách mở rộng câu hay hơn."
        ),
        short_answer_en=(
            "Great for reluctant readers! First select a child profile, then open Entertainment (/entertainment) for 4 playful activities:\n"
            "• Karaoke (/karaoke): sing along with synchronized lyrics.\n"
            "• Memory Game (/entertainment/memory-game): flip and match pairs to build vocabulary & character recall.\n"
            "• Sentence Shooter (/entertainment/sentence-shooter): build complete Vietnamese sentences.\n"
            "• Picture Description (/entertainment/picture-description): describe pictures and get AI vocabulary hints, stars, and friendly feedback."
        ),
        detailed_answer_en=(
            "Four learning games inside Entertainment (/entertainment) — ideal for warming up reluctant readers (select a child profile first so stars and progress save to the right child):\n"
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
            "tiet kiem bang tan",
            "mang cham",
            "mang yeu",
            "3g",
            "mat mang",
            "che do ngoai tuyen",
            "slow 3g",
            "low bandwidth",
            "data saver",
            "offline mode",
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
        title_vi="Quản trị kho sách, OCR (Gemini vs Qwen3-VL / VietOCR) và duyệt VERIFIED",
        title_en="Admin book catalog, OCR review (Gemini vs Qwen3-VL / VietOCR), and VERIFIED revisions",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin/books",),
        keywords=(
            "kho sach",
            "duyet ocr",
            "revision",
            "verified",
            "ai sua",
            "tao sach",
            "sua sach",
            "upload trang",
            "qwen3-vl",
            "vietocr",
            "tesseract",
            "paddleocr",
            "gemini ocr",
            "admin books",
            "ocr review",
            "needs_review",
        ),
        short_answer_vi=(
            "Quy trình quản trị sách & OCR tại /admin/books:\n"
            "1. Tạo/sửa sách (/admin/books/new, /admin/books/[bookId]/edit) và tải ảnh từng trang.\n"
            "2. Mở trang duyệt OCR (/admin/books/[bookId]/pages/[pageId]): đối chiếu kết quả giữa Gemini, Ollama Qwen3-VL và các engine VietOCR/PaddleOCR/Tesseract, chạy AI sửa tách biệt nếu cần rồi duyệt sang VERIFIED.\n"
            "3. Sách chỉ đủ điều kiện xuất bản khi mọi trang active đã có revision VERIFIED hiện hành, Proofreading và Child Safety."
        ),
        detailed_answer_vi=(
            "Hướng dẫn vận hành Kho sách & Duyệt OCR Quản trị (/admin/books):\n"
            "1. Tạo & Chỉnh sửa sách: vào /admin/books/new để tạo sách mới hoặc /admin/books/[bookId]/edit để cập nhật metadata, lớp, bản quyền và danh sách trang.\n"
            "2. Bàn duyệt OCR từng trang (/admin/books/[bookId]/pages/[pageId]): thao tác Quét OCR và nút AI sửa là hai luồng tách biệt. Admin xem lại độ tin cậy từng từ từ PaddleOCR, VietOCR, Tesseract và bản đối chiếu Gemini hoặc Ollama Qwen3-VL cục bộ, chỉnh bounding box/chữ sai rồi xác minh thành VERIFIED.\n"
            "3. Xuất bản an toàn: đảm bảo mọi trang active có revision VERIFIED hiện hành, Proofreading và đánh giá Child Safety GRADE_1_TO_5 hợp lệ."
        ),
        short_answer_en=(
            "Admin book & OCR workflow (/admin/books):\n"
            "1. Create or edit books (/admin/books/new, /admin/books/[bookId]/edit) and upload page images.\n"
            "2. Open page OCR review (/admin/books/[bookId]/pages/[pageId]) to compare Gemini, Ollama Qwen3-VL, VietOCR, PaddleOCR, and Tesseract word verdicts, run separate AI proofreading if needed, and mark VERIFIED.\n"
            "3. Publish only after OCR, proofreading, and Child Safety checks are current on all active pages."
        ),
        detailed_answer_en=(
            "Admin Book Catalog & OCR Review (/admin/books):\n"
            "1. Create books (/admin/books/new) and update metadata/rights/pages (/admin/books/[bookId]/edit).\n"
            "2. On /admin/books/[bookId]/pages/[pageId], OCR scan and AI proofreading remain separate steps; compare PaddleOCR/VietOCR/Tesseract signals with Gemini or local Ollama Qwen3-VL before verifying to VERIFIED.\n"
            "3. Book approval requires current OCR, proofreading, and GRADE_1_TO_5 Child Safety results plus rights confirmation on all active pages."
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
        route_prefixes=("/", "/settings", "/profile", "/help-support"),
        keywords=(
            "bao mat",
            "rieng tu",
            "du lieu gia dinh",
            "phan quyen",
            "rls",
            "pham vi tai khoan",
            "pham vi khach",
            "trang nguoi khac",
            "khong vao duoc admin",
            "guest scope",
            "parent scope",
            "privacy",
            "security",
            "account scope",
        ),
        short_answer_vi=(
            "Mỗi tài khoản ViRead được cách ly dữ liệu nghiêm ngặt (Supabase Auth + RLS): khách chưa đăng nhập chỉ xem trang công khai (/login, /register), còn phụ huynh chỉ truy cập được hồ sơ bé, sách riêng tư (/my-books), tác vụ AI (/studio/tasks) và cài đặt (/settings) của chính mình — tuyệt đối không xem tài khoản người khác hay /admin/*."
        ),
        detailed_answer_vi=(
            "Nguyên tắc an toàn, phân quyền & riêng tư của ViRead:\n"
            "1. Phạm vi Khách (Guest) vs Phụ huynh (Parent): khách chưa đăng nhập chỉ dùng hướng dẫn chung và các trang công khai (/login, /register, /forgot-password); phụ huynh đã đăng nhập mới truy cập không gian gia đình của chính mình.\n"
            "2. Đúng phạm vi người dùng (Own-Scope): mọi hồ sơ bé (/children), sách tự quét (/my-books), buổi đọc (/sessions), tác vụ AI (/studio/tasks) và cài đặt bảo mật (/settings) được bảo vệ theo tài khoản đang đăng nhập.\n"
            "3. Chặn rò rỉ chéo: Trợ lý AI không bao giờ điều hướng hay tiết lộ khu vực quản trị (/admin/*) hoặc dữ liệu người dùng khác."
        ),
        short_answer_en=(
            "ViRead strictly isolates every account's data: signed-out guests stay on public auth routes, and parents only access their own child profiles, private books (/my-books), AI tasks (/studio/tasks), and settings (/settings) — never another user's data or /admin/*."
        ),
        detailed_answer_en=(
            "ViRead security, guest vs parent boundaries & isolation guarantees:\n"
            "1. Guest vs Parent Scope: signed-out guests only see public auth routes (/login, /register, /forgot-password), while signed-in parents manage their own family workspace.\n"
            "2. Strict own-scope access enforced across API and Supabase RLS layers for /children, /my-books, /sessions, /studio/tasks, and /settings.\n"
            "3. The assistant strictly blocks navigation to /admin/* or another user's private pages."
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
    KbArticle(
        id="child_selection_gate_and_switching",
        title_vi="Cổng chọn hồ sơ bé & cách chuyển bé trước khi đọc/chơi",
        title_en="Child selection gate & switching profiles before reading or games",
        scopes=_PARENT_ONLY,
        route_prefixes=("/dashboard", "/children", "/reading-preparation", "/books", "/entertainment"),
        keywords=(
            "cong chon be",
            "chua chon be",
            "tai sao phai chon be",
            "bat buoc chon be",
            "chon ho so be",
            "chuyen be nhanh",
            "doi be nhanh",
            "chon be trong chatbot",
            "child selection",
            "child gate",
            "why select child",
            "select a child first",
            "switch child inline",
            "pick child",
        ),
        short_answer_vi=(
            "Tại sao ViRead yêu cầu chọn hồ sơ bé trước khi mở Sách, Quét sách, Chuẩn bị đọc, Góc giải trí hay Karaoke?\n"
            "• Mỗi bé (lớp 1–5) có lịch sử đọc, từ cần luyện, sao thưởng và báo cáo tiến bộ tách biệt để không bị lẫn dữ liệu.\n"
            "• Nếu chưa chọn bé, bạn có thể chọn hoặc chuyển bé ngay trong khung Trợ lý ViRead khi bấm mở trang, trên thanh đầu trang hoặc tại Tổng quan (/dashboard) và Hồ sơ bé (/children)."
        ),
        detailed_answer_vi=(
            "Cơ chế chọn hồ sơ bé thông minh trên ViRead giúp dữ liệu học tập của từng con luôn chính xác:\n"
            "1. Các trang gắn trực tiếp với buổi học/chơi (/books, /book-scanner, /reading-preparation, /entertainment/*, /karaoke) cần biết bé nào đang tham gia để lưu đúng kết quả, từ cần luyện và sao thưởng.\n"
            "2. Cách chọn nhanh: khi trợ lý gợi ý chuyển tới các trang trên mà bạn chưa chọn bé, bộ chọn bé ngay trong khung chat sẽ hiện ra để chọn chỉ với 1 chạm (hoặc tạo mới tại /children/new).\n"
            "3. Bạn cũng có thể chuyển bé bất kỳ lúc nào ở bộ chuyển trên thanh đầu trang, trang Tổng quan (/dashboard) hoặc Hồ sơ bé (/children)."
        ),
        short_answer_en=(
            "Why does ViRead ask you to select a child before Books, Scanner, Reading Prep, Entertainment, or Karaoke?\n"
            "• Each child profile (Grades 1–5) keeps separate reading history, difficult words, stars, and progress analytics.\n"
            "• Pick or switch a child inline inside the ViRead Assistant, from the header switcher, on Dashboard (/dashboard), or in Child Profiles (/children)."
        ),
        detailed_answer_en=(
            "Smart child-profile gating keeps every child's learning metrics accurate:\n"
            "1. Child-gated routes (/books, /book-scanner, /reading-preparation, /entertainment/*, /karaoke) require an active child so sessions, difficult words, and stars are recorded to the right child.\n"
            "2. Inline picker: when opening a child-gated route from the assistant without an active child, you can pick a child inline right inside the chat widget (or create one at /children/new).\n"
            "3. Switch anytime via the header switcher, Dashboard (/dashboard), or Child Profiles (/children)."
        ),
        actions=(
            KbAction("Mở Hồ sơ bé", "Open Child Profiles", "/children"),
            KbAction("Tạo hồ sơ bé mới", "Create Child Profile", "/children/new"),
            KbAction("Về Tổng quan", "Open Dashboard", "/dashboard"),
        ),
        followups_vi=(
            "Nhà có 2 bé học khác lớp thì chuyển đổi thế nào?",
            "Làm sao bắt đầu 3 bước đầu tiên cho ba mẹ mới?",
            "Mở kho sách để chọn truyện cho bé?",
        ),
        followups_en=(
            "How do siblings switch profiles?",
            "What are the 3 onboarding steps for new parents?",
            "How do I browse books for my child?",
        ),
    ),
    KbArticle(
        id="new_parent_onboarding",
        title_vi="Hướng dẫn 3 bước bắt đầu cho ba mẹ mới",
        title_en="3-step quickstart onboarding for new parents",
        scopes=_PARENT_ONLY,
        route_prefixes=("/", "/dashboard", "/children/new", "/register"),
        keywords=(
            "ba me moi",
            "nguoi moi",
            "moi su dung",
            "3 buoc bat dau",
            "bat dau nhu the nao",
            "lan dau su dung",
            "huong dan nhanh",
            "new parent",
            "onboarding",
            "3 steps",
            "first time",
            "quickstart",
        ),
        short_answer_vi=(
            "3 bước bắt đầu cùng ViRead chỉ mất 2 phút:\n"
            "1. Tạo hồ sơ bé (/children/new): nhập tên và chọn lớp (1–5).\n"
            "2. Chọn hoặc quét sách: mở Kho sách (/books) hoặc chụp trang sách giấy tại Quét sách (/book-scanner) / Sách của tôi (/my-books).\n"
            "3. Vào Chuẩn bị đọc (/reading-preparation): chọn phạm vi trang, giọng đọc mẫu, kiểm tra micro rồi bấm Bắt đầu đọc."
        ),
        detailed_answer_vi=(
            "Lộ trình 3 bước dành cho phụ huynh mới dùng ViRead:\n"
            "1. Tạo hồ sơ bé (/children/new): mỗi bé có hồ sơ theo lớp (1–5) để hệ thống gợi ý sách phù hợp và lưu tiến bộ riêng.\n"
            "2. Chọn nguồn sách: duyệt truyện tiếng Việt trong Kho sách (/books) hoặc số hóa sách giấy gia đình bằng Quét sách (/book-scanner) hay Sách của tôi (/my-books).\n"
            "3. Bắt đầu buổi đọc (/reading-preparation → /reading): kiểm tra micro, chọn tốc độ/giọng đọc mẫu Bắc–Trung–Nam, cùng bé đọc to và làm câu hỏi đọc hiểu AI Tutor cuối buổi."
        ),
        short_answer_en=(
            "3-step ViRead quickstart for new parents:\n"
            "1. Create a child profile (/children/new) with name and grade (1–5).\n"
            "2. Pick a book in Books (/books) or scan/upload paper pages in Book Scanner (/book-scanner) / My Books (/my-books).\n"
            "3. Open Reading Preparation (/reading-preparation) to pick pages, voice, and test mic, then start reading."
        ),
        detailed_answer_en=(
            "Getting started with ViRead in 3 easy steps:\n"
            "1. Create a child profile (/children/new) by Grade 1–5 so bookshelves and analytics stay personalized.\n"
            "2. Choose a curated book in /books or digitize your own paper books in /book-scanner or /my-books.\n"
            "3. In Reading Preparation (/reading-preparation), test the microphone, select model voice & page range, and launch an interactive reading session with post-reading AI Tutor questions."
        ),
        actions=(
            KbAction("Tạo hồ sơ bé mới", "Create Child Profile", "/children/new"),
            KbAction("Mở kho Sách", "Browse Books", "/books"),
            KbAction("Chuẩn bị buổi đọc", "Reading Preparation", "/reading-preparation"),
        ),
        followups_vi=(
            "Tại sao phải chọn hồ sơ bé trước khi đọc?",
            "Bé đọc chậm nên chỉnh tốc độ thế nào?",
            "Cách quét sách giấy bằng camera?",
        ),
        followups_en=(
            "Why do I need to select a child first?",
            "How do I slow down voice speed for a struggling reader?",
            "How do I scan a paper book?",
        ),
    ),
    KbArticle(
        id="multi_child_family_switching",
        title_vi="Gia đình có nhiều bé: chuyển đổi hồ sơ không lẫn dữ liệu",
        title_en="Multi-child families: switching between siblings cleanly",
        scopes=_PARENT_ONLY,
        route_prefixes=("/children", "/dashboard", "/reports"),
        keywords=(
            "nhieu be",
            "hai be",
            "2 be",
            "anh em",
            "chi em",
            "nhieu ho so",
            "chuyen giua cac be",
            "khong bi lan",
            "lan du lieu",
            "multi child",
            "multiple children",
            "siblings",
            "switch between children",
            "separate progress",
        ),
        short_answer_vi=(
            "Với gia đình có 2 bé trở lên:\n"
            "• Tạo hồ sơ riêng cho từng bé tại Hồ sơ bé (/children) — mỗi bé có tủ sách đã lưu, từ cần luyện, báo cáo tiến bộ và mục tiêu tuần độc lập.\n"
            "• Trước mỗi buổi đọc hoặc trò chơi, đổi nhanh giữa các bé trên thanh đầu trang, Tổng quan (/dashboard) hoặc bộ chọn bé trong khung chat để dữ liệu không bao giờ bị lẫn."
        ),
        detailed_answer_vi=(
            "Quản lý nhiều bé cùng học trên một tài khoản phụ huynh ViRead:\n"
            "1. Tạo hồ sơ riêng cho từng bé (/children/new) theo đúng lớp (1–5) của từng bạn.\n"
            "2. Chuyển đổi tức thì: dùng nút chọn bé trên thanh đầu trang, chọn thẻ bé trên Tổng quan (/dashboard), hoặc chọn bé ngay trong cửa sổ Trợ lý ViRead khi mở Sách/Giải trí.\n"
            "3. Mọi chỉ số (Tốc độ, Đọc đúng, Từ cần luyện, Lịch sử phiên đọc, Mục tiêu tuần) tự động lọc và lưu riêng theo bé đang chọn."
        ),
        short_answer_en=(
            "Managing siblings on one parent account:\n"
            "• Create a separate profile per child in Child Profiles (/children) so each sibling has independent bookshelves, difficult words, reports, and weekly goals.\n"
            "• Switch between siblings anytime via the header switcher, Dashboard (/dashboard), or the assistant's inline child picker."
        ),
        detailed_answer_en=(
            "Multi-child families on ViRead:\n"
            "1. Add each sibling (/children/new) with their own grade (Grades 1–5).\n"
            "2. Switch cleanly using the top-bar child switcher, Dashboard cards (/dashboard), or the inline assistant child selector before reading or playing games.\n"
            "3. Progress reports, difficult words, session history, and weekly goals stay strictly separated per child."
        ),
        actions=(
            KbAction("Mở Hồ sơ bé", "Open Child Profiles", "/children"),
            KbAction("Tạo thêm hồ sơ bé", "Add Another Child", "/children/new"),
            KbAction("Về Tổng quan", "Open Dashboard", "/dashboard"),
        ),
        followups_vi=(
            "Tại sao phải chọn hồ sơ bé trước khi mở sách?",
            "Xem báo cáo tiến bộ riêng của từng bé ở đâu?",
            "Đặt mục tiêu đọc riêng cho mỗi bé thế nào?",
        ),
        followups_en=(
            "Why is child selection required before books or games?",
            "Where do I view reports for each child?",
            "How do I set weekly goals per child?",
        ),
    ),
    KbArticle(
        id="slow_struggling_reader_support",
        title_vi="Hỗ trợ bé đọc chậm, hay vấp từ & luyện phát âm",
        title_en="Supporting slow or struggling readers (0.85x speed & syllable hints)",
        scopes=_PARENT_ONLY,
        route_prefixes=("/reading-preparation", "/reading", "/reports/difficult-words"),
        keywords=(
            "be doc cham",
            "doc yeu",
            "doc vap",
            "hay vap tu",
            "gap kho khan",
            "toc do 0.85x",
            "0.85x",
            "chinh toc do doc",
            "cham lai",
            "danh van",
            "tach van",
            "ho tro doc cham",
            "slow reader",
            "struggling reader",
            "reading speed",
            "0.85",
            "syllable spelling",
            "pronunciation hints",
        ),
        short_answer_vi=(
            "Mẹo đồng hành với bé đọc chậm hoặc hay vấp từ:\n"
            "• Giảm tốc độ giọng đọc mẫu xuống 0.85x trong Chuẩn bị đọc (/reading-preparation) hoặc nút điều chỉnh giọng đọc để bé nghe rõ từng tiếng.\n"
            "• Chọn phạm vi ít trang mỗi buổi (1–2 trang), tận dụng gợi ý đánh vần/tách vần AI và bấm vào từ khó để nghe lại phát âm chuẩn.\n"
            "• Sau buổi đọc, cho bé ôn lại các từ vừa vấp tại Từ cần luyện (/reports/difficult-words)."
        ),
        detailed_answer_vi=(
            "Cách tùy chỉnh ViRead cho bé mới tập đọc hoặc còn đọc chậm:\n"
            "1. Tốc độ đọc mẫu 0.85x: tại Chuẩn bị đọc (/reading-preparation) hoặc trong màn hình đọc, chọn tốc độ 0.85x để giọng đọc mẫu (TTS) chậm rãi, rõ thanh điệu cho bé nhẩm theo.\n"
            "2. Hỗ trợ đánh vần AI & thử lại nhẹ nhàng: khi bé ngập ngừng hoặc đọc nhầm, hệ thống gợi ý tách vần/đánh vần và cho bé thử lại không áp lực, sau đó tự lưu từ khó.\n"
            "3. Chia nhỏ mục tiêu: chọn khoảng 1–2 trang ở /reading-preparation để bé giữ tự tin.\n"
            "4. Ôn tập trọng tâm: mở Từ cần luyện (/reports/difficult-words) để bé nghe mẫu và luyện đọc lại đúng những từ hay vấp."
        ),
        short_answer_en=(
            "Tips for slow or struggling readers:\n"
            "• Lower the model TTS voice speed to 0.85x in Reading Preparation (/reading-preparation) or reader voice controls.\n"
            "• Pick short page ranges (1–2 pages), use gentle AI syllable-spelling hints, and tap tricky words to hear clear pronunciation.\n"
            "• Drill missed words afterward in Difficult Words (/reports/difficult-words)."
        ),
        detailed_answer_en=(
            "Adapting ViRead for slow or struggling readers:\n"
            "1. 0.85x Model Voice Speed: set TTS speed to 0.85x in Reading Preparation (/reading-preparation) or the reader toolbar so tones and syllables are crystal clear.\n"
            "2. Syllable Spelling AI & Gentle Retries: ViRead offers supportive syllable breakdowns and low-stress retries, automatically logging tricky words.\n"
            "3. Short Sessions: select 1–2 pages in /reading-preparation to build confidence.\n"
            "4. Targeted Practice: revisit missed words in Difficult Words (/reports/difficult-words)."
        ),
        actions=(
            KbAction("Chuẩn bị đọc (chỉnh tốc độ 0.85x)", "Reading Prep (0.85x speed)", "/reading-preparation"),
            KbAction("Ôn Từ cần luyện", "Open Difficult Words", "/reports/difficult-words"),
        ),
        followups_vi=(
            "Bé chưa thích đọc sách thì nên thử trò chơi nào?",
            "Làm sao xem các từ bé đọc nhầm sau buổi đọc?",
            "Tại sao không đổi được giọng đọc giữa buổi đọc?",
        ),
        followups_en=(
            "Which games help reluctant readers warm up?",
            "Where are missed words saved after reading?",
            "Why can't I switch voices mid-session?",
        ),
    ),
    KbArticle(
        id="achievements_phoneme_garden",
        title_vi="Vườn Âm Vị & Huy hiệu + Hộ chiếu Tem Đọc Sách",
        title_en="Phoneme Garden, Badges & Book Stamp Passport",
        scopes=_PARENT_ONLY,
        route_prefixes=("/achievements", "/dashboard"),
        keywords=(
            "vuon am vi",
            "huy hieu",
            "ho chieu doc sach",
            "ho chieu tem",
            "tem doc sach",
            "thanh tich",
            "chuoi ngay doc",
            "achievements",
            "phoneme garden",
            "badges",
            "passport",
            "book stamp",
        ),
        short_answer_vi=(
            "Vườn Âm Vị & Huy hiệu (/achievements — cần chọn hồ sơ bé trước):\n"
            "• Theo dõi từng âm/vần tiếng Việt bé đã làm chủ dưới dạng những bông hoa nở trong Vườn Âm Vị.\n"
            "• Mở Hộ chiếu Tem Đọc Sách để xem tem thưởng theo chuỗi ngày đọc đều đặn, mục tiêu tuần và lời nhắn động viên bằng giọng ba mẹ."
        ),
        detailed_answer_vi=(
            "Khám phá Vườn Âm Vị & Huy hiệu (/achievements) dành riêng cho từng bé (nhớ chọn hồ sơ bé trước):\n"
            "1. Vườn Âm Vị (Phoneme Garden): thống kê mức độ thuần thục các âm, vần, thanh điệu tiếng Việt qua các buổi đọc và luyện từ khó của bé.\n"
            "2. Hộ chiếu Tem Đọc Sách (Reading Passport): lưu các con dấu cột mốc đọc sách lành mạnh theo chuỗi ngày đọc & mục tiêu tuần (không gây nghiện).\n"
            "3. Huy hiệu thành tích & ghi nhận nỗ lực giúp bé hứng thú duy trì thói quen đọc mỗi ngày."
        ),
        short_answer_en=(
            "Phoneme Garden & Badges (/achievements — select a child profile first):\n"
            "• Watch your child's mastered Vietnamese phonemes bloom inside the Phoneme Garden.\n"
            "• Open the Book Stamp Passport to see healthy reading-streak stamps and milestone badges."
        ),
        detailed_answer_en=(
            "Inside Phoneme Garden & Achievements (/achievements, requires an active child profile):\n"
            "1. Phoneme Garden tracks Vietnamese sound, rhyme, and tone mastery from reading sessions.\n"
            "2. Book Stamp Passport awards intrinsic stamps for consistent reading streaks and completed weekly goals.\n"
            "3. Every garden and badge collection is tracked independently per child."
        ),
        actions=(
            KbAction("Mở Vườn Âm Vị & Huy hiệu", "Open Achievements", "/achievements"),
            KbAction("Chuyến Tàu Đọc 5 Phút", "5-Min Reading Train", "/learning-train"),
        ),
        followups_vi=(
            "Chuyến Tàu Đọc 5 Phút hoạt động thế nào?",
            "Làm sao tải Chứng nhận cột mốc cho bé?",
            "Tại sao phải chọn hồ sơ bé trước khi mở trang này?",
        ),
        followups_en=(
            "How does the 5-Minute Reading Train work?",
            "How do I download Milestone Certificates?",
            "Why must I select a child profile first?",
        ),
    ),
    KbArticle(
        id="learning_train_daily_practice",
        title_vi="Chuyến Tàu Đọc 5 Phút hàng ngày",
        title_en="Daily 5-Minute Reading Train",
        scopes=_PARENT_ONLY,
        route_prefixes=("/learning-train", "/dashboard"),
        keywords=(
            "chuyen tau doc",
            "chuyen tau 5 phut",
            "tau doc 5 phut",
            "luyen doc 5 phut",
            "luyen doc moi ngay",
            "learning train",
            "5 minute reading train",
            "five minute train",
            "daily train",
        ),
        short_answer_vi=(
            "Chuyến Tàu Đọc 5 Phút (/learning-train — cần chọn hồ sơ bé trước) là bài tập thích ứng ngắn gọn 3 toa mỗi ngày:\n"
            "• Toa 1: Khởi động âm/vần và từ bé đang cần củng cố.\n"
            "• Toa 2: Đọc nhịp điệu cụm câu ngắn có giọng Cô/Thầy AI dẫn.\n"
            "• Toa 3: Ghép từ hoàn thành câu để nhận tem & kết thúc nhẹ nhàng trong ~5 phút."
        ),
        detailed_answer_vi=(
            "Chuyến Tàu Đọc 5 Phút (/learning-train) giúp bé duy trì nhịp đọc đều đặn ngay cả những ngày bận rộn (cần chọn hồ sơ bé trước):\n"
            "1. Tự động cá nhân hóa theo trình độ và các từ bé từng vấp.\n"
            "2. Gồm 3 toa ngắn: Toa 1 (âm/vần & từ mục tiêu), Toa 2 (đọc cụm câu theo nhịp + kiểm tra micro), Toa 3 (ghép câu hoàn chỉnh).\n"
            "3. Đồng bộ giọng Cô/Thầy AI (Teacher Persona) và ghi nhận trực tiếp vào chuỗi ngày đọc & Vườn Âm Vị (/achievements)."
        ),
        short_answer_en=(
            "The 5-Minute Reading Train (/learning-train — select a child first) is a 3-car daily adaptive workout:\n"
            "• Car 1: Target sounds and tricky words.\n"
            "• Car 2: Rhythmic phrase reading with AI Teacher guidance.\n"
            "• Car 3: Sentence assembly to complete the daily streak in ~5 minutes."
        ),
        detailed_answer_en=(
            "How the 5-Minute Reading Train (/learning-train) works (requires an active child profile):\n"
            "1. Adapts automatically to your child's grade and recent difficult words.\n"
            "2. Runs through 3 focused cars: sounds/words, rhythmic phrase reading, and sentence building.\n"
            "3. Syncs with your chosen AI Teacher Voice Persona and updates streaks and Phoneme Garden (/achievements)."
        ),
        actions=(
            KbAction("Mở Chuyến Tàu Đọc 5 Phút", "Open Reading Train", "/learning-train"),
            KbAction("Vườn Âm Vị & Huy hiệu", "Phoneme Garden", "/achievements"),
        ),
        followups_vi=(
            "Vườn Âm Vị & Huy hiệu xem ở đâu?",
            "Đổi giọng Cô giáo / Thầy giáo AI ở đâu?",
            "Làm sao đặt lịch nhắc đọc hàng tuần?",
        ),
        followups_en=(
            "Where is Phoneme Garden?",
            "How do I switch AI Teacher Voice Persona?",
            "How do I schedule weekly reading reminders?",
        ),
    ),
    KbArticle(
        id="family_storyweaver_and_readability",
        title_vi="Family StoryWeaver & Huy hiệu Độ đọc Tiếng Việt (Lớp 1–5)",
        title_en="Family StoryWeaver & Vietnamese Readability Badge (Grades 1–5)",
        scopes=_PARENT_ONLY,
        route_prefixes=("/my-books", "/books"),
        keywords=(
            "storyweaver",
            "family storyweaver",
            "sang tac truyen",
            "tao truyen ai",
            "truyen cho be",
            "readability",
            "readability badge",
            "do doc",
            "huy hieu do doc",
            "phu hop lop",
            "phonics readiness",
        ),
        short_answer_vi=(
            "Family StoryWeaver & Huy hiệu Độ đọc:\n"
            "• Family StoryWeaver (trong Sách của tôi /my-books): ba mẹ nhập chủ đề, chọn lớp (1–5), chế độ đọc (như Đối thoại đọc đôi DUET_DIALOGUE) và tối đa 6 từ muốn bé luyện → AI dệt truyện 3–4 trang an toàn cho bé.\n"
            "• Huy hiệu Độ đọc Tiếng Việt (Readability Badge): hiển thị sách Phù hợp / Hơi khó / Dễ so với lớp của bé kèm điểm sẵn sàng ngữ âm."
        ),
        detailed_answer_vi=(
            "Cá nhân hóa bài đọc cho con với Family StoryWeaver và Readability Badge:\n"
            "1. Family StoryWeaver (/my-books): bấm nút tạo truyện gia đình để chọn hồ sơ bé, chủ đề (ví dụ 'khu vườn nắng sớm'), độ dài 3–4 trang, phong cách truyện hoặc đối thoại đọc đôi (DUET_DIALOGUE) và chèn các từ bé cần luyện. Truyện được kiểm tra an toàn trẻ em và lưu riêng trong Sách của tôi.\n"
            "2. Huy hiệu Độ đọc Tiếng Việt: xuất hiện trên thẻ sách thư viện (/books) và sách gia đình (/my-books), ước lượng khoảng lớp 1–5, độ dài âm tiết trung bình và trạng thái Phù hợp (MATCHED), Hơi khó (TOO_HARD) hay Dễ (TOO_EASY) so với lớp của bé."
        ),
        short_answer_en=(
            "Family StoryWeaver & Vietnamese Readability Badge:\n"
            "• Family StoryWeaver (inside My Books /my-books): enter a theme, grade (1–5), mode (such as DUET_DIALOGUE), and up to 6 practice words to generate a child-safe 3–4 page story.\n"
            "• Readability Badge: shows whether a book is Matched, Too Hard, or Too Easy for your child's grade plus a phonics readiness score."
        ),
        detailed_answer_en=(
            "Tailoring books to your child's level:\n"
            "1. Family StoryWeaver (/my-books): create custom 3–4 page family stories by theme, grade (1–5), style (e.g., Duet Dialogue), and target words, automatically screened for child safety.\n"
            "2. Vietnamese Readability Badge: displayed on Books (/books) and My Books (/my-books), estimating grade band (Grades 1–5), syllable density, and phonics readiness."
        ),
        actions=(
            KbAction("Mở Sách của tôi (StoryWeaver)", "Open My Books", "/my-books"),
            KbAction("Mở kho Sách", "Browse Books", "/books"),
        ),
        followups_vi=(
            "Đọc đôi (Duet Reading) cùng ba mẹ hoạt động thế nào?",
            "Smart Studio tạo ảnh bìa và minh họa ra sao?",
            "Làm sao bắt đầu buổi đọc cho bé?",
        ),
        followups_en=(
            "How does Duet Reading work?",
            "How does Smart Studio create covers & illustrations?",
            "How do I start a reading session?",
        ),
    ),
    KbArticle(
        id="duet_reading_wasm_countdown",
        title_vi="Đọc đôi (Duet Reading), WASM ngoại tuyến & Đếm ngược tức thì",
        title_en="Duet Reading, Offline WASM STT/TTS & Instant Countdown",
        scopes=_PARENT_ONLY,
        route_prefixes=("/reading", "/reading-preparation"),
        keywords=(
            "duet",
            "duet reading",
            "doc doi",
            "doc luan phien",
            "wasm",
            "sherpa",
            "ngoai tuyen",
            "instant countdown",
            "dem nguoc",
            "teacher persona",
            "co giao ai",
            "thay giao ai",
        ),
        short_answer_vi=(
            "Công nghệ hỗ trợ mượt mà trong buổi đọc (/reading-preparation → /reading):\n"
            "• Đọc đôi (Duet Reading): ba mẹ/AI và bé luân phiên đọc từng đoạn ngắn để bé bớt ngợp và tự tin hơn.\n"
            "• WASM STT/TTS ngoại tuyến & Đếm ngược tức thì: trong 3 giây đếm ngược vào bài, ViRead khởi động sẵn mô hình nhận diện giọng nói trên trình duyệt (sherpa-onnx WASM) và bộ đệm audio giúp phản hồi nhanh ngay cả khi mạng yếu."
        ),
        detailed_answer_vi=(
            "Trải nghiệm đọc thông minh và không độ trễ trên ViRead:\n"
            "1. Đọc đôi (Duet Reading): chia trang sách thành lượt đọc xen kẽ giữa Ba mẹ/AI và Bé, đặc biệt hiệu quả với truyện đối thoại từ Family StoryWeaver hoặc bé mới tập đọc.\n"
            "2. Nhận diện giọng nói trên thiết bị (Browser WASM STT `sherpa-onnx-zipformer-vi`): tự động kích hoạt ưu tiên trên trình duyệt để chấm từ theo thời gian thực và vẫn hoạt động khi Voice Worker ngoại tuyến.\n"
            "3. Đếm ngược tức thì (3 giây) & Đồng bộ AI Teacher Voice Persona (Cô giáo / Thầy giáo): chuẩn bị sẵn micro + TTS trong lúc đếm ngược để bé đọc ngay không phải chờ."
        ),
        short_answer_en=(
            "Smooth in-session features (/reading-preparation → /reading):\n"
            "• Duet Reading: Parent/AI and child take turns reading short segments to build confidence.\n"
            "• Offline Browser WASM STT/TTS & Instant 3s Countdown: pre-warms on-device Vietnamese speech recognition (sherpa-onnx) and cached TTS during the 3-second countdown."
        ),
        detailed_answer_en=(
            "Low-latency reading technology in ViRead:\n"
            "1. Duet Reading splits pages into alternating Parent/AI and Child turns.\n"
            "2. On-device Browser WASM Vietnamese STT (`sherpa-onnx`) runs directly in a Web Worker for low-latency word tracking and offline resilience.\n"
            "3. The 3-second Instant Countdown warms STT & TTS engines alongside your synced AI Teacher Voice Persona."
        ),
        actions=(
            KbAction("Chuẩn bị buổi đọc", "Reading Preparation", "/reading-preparation"),
            KbAction("Mở Sách của tôi", "Open My Books", "/my-books"),
        ),
        followups_vi=(
            "Tại sao không đổi được giọng đọc giữa buổi đọc?",
            "Bé đọc chậm muốn chỉnh tốc độ 0.85x ở đâu?",
            "Micro không nhận giọng bé phải làm sao?",
        ),
        followups_en=(
            "Why can't I switch voices mid-session?",
            "How do I set 0.85x speed for a slow reader?",
            "Microphone isn't picking up my child's voice?",
        ),
    ),
    KbArticle(
        id="milestone_certificates_and_parent_pin",
        title_vi="Chứng nhận cột mốc & Khóa PIN Phụ huynh 4 chữ số",
        title_en="Milestone Certificates & 4-Digit Parent PIN Lock",
        scopes=_PARENT_ONLY,
        route_prefixes=("/reports", "/sessions", "/settings"),
        keywords=(
            "chung nhan",
            "giay khen",
            "bang khen",
            "in a4",
            "milestone certificate",
            "certificate",
            "ma pin",
            "pin 4 so",
            "pin lock",
            "parent pin",
            "khoa tre em",
            "child safe mode",
        ),
        short_answer_vi=(
            "Chứng nhận cột mốc & Khóa PIN phụ huynh:\n"
            "• Chứng nhận cột mốc (/reports và /sessions/[id]/report): bấm In A4 hoặc Tải ảnh PNG chứng nhận để khen thưởng bé sau mỗi cột mốc đọc sách.\n"
            "• Khóa PIN Phụ huynh 4 chữ số (/settings): bật chế độ An toàn cho bé bằng mã PIN 4 số (tự khóa tạm 5 phút nếu nhập sai 5 lần) để bé không tự ý đổi cài đặt."
        ),
        detailed_answer_vi=(
            "Hai tính năng bảo vệ và khích lệ bé trong gia đình:\n"
            "1. Chứng nhận cột mốc (Milestone Certificates): tại trang Tiến bộ (/reports) và Báo cáo chi tiết buổi đọc (/sessions/[sessionId]/report), ba mẹ có thể bấm In chứng nhận khổ A4 hoặc tải về ảnh PNG lưu kỷ niệm cho bé.\n"
            "2. Khóa PIN Phụ huynh 4 chữ số: thiết lập trong Cài đặt (/settings) để khóa các thao tác quản trị gia đình khi đưa máy cho bé tự đọc; mã PIN được băm an toàn (PBKDF2) và giới hạn thử tối đa 5 lần."
        ),
        short_answer_en=(
            "Milestone Certificates & 4-Digit Parent PIN Lock:\n"
            "• Milestone Certificates (/reports & /sessions/[id]/report): print A4 certificates or download PNG milestone keepsakes.\n"
            "• 4-Digit Parent PIN Lock (/settings): enable Child-Safe Mode with a 4-digit PIN (5-attempt / 5-minute lockout) so kids stay safely in reading mode."
        ),
        detailed_answer_en=(
            "Encouragement & child-safe protection:\n"
            "1. Milestone Certificates: available on Progress Reports (/reports) and Session Reports (/sessions/[sessionId]/report) with A4 print and PNG download.\n"
            "2. 4-Digit Parent PIN Lock: configured in Settings (/settings) with PBKDF2 hashing and a 5-attempt lockout to prevent accidental settings changes by children."
        ),
        actions=(
            KbAction("Xem Tiến bộ & Chứng nhận", "Progress & Certificates", "/reports"),
            KbAction("Cài đặt & Khóa PIN", "Settings & Parent PIN", "/settings"),
        ),
        followups_vi=(
            "Vườn Âm Vị & Huy hiệu xem ở đâu?",
            "Làm sao xem báo cáo chi tiết buổi đọc?",
            "Cách đổi mật khẩu tài khoản ViRead?",
        ),
        followups_en=(
            "Where is Phoneme Garden?",
            "How do I view detailed session reports?",
            "How do I change my ViRead password?",
        ),
    ),
    KbArticle(
        id="android_apk_mobile_app",
        title_vi="Ứng dụng ViRead Android (APK) trên điện thoại & máy tính bảng",
        title_en="ViRead Android APK mobile app guide",
        scopes=_PARENT_ONLY,
        route_prefixes=("/dashboard", "/help-support", "/reading-preparation"),
        keywords=(
            "apk",
            "android",
            "ung dung dien thoai",
            "app viread",
            "tren dien thoai",
            "may tinh bang",
            "mobile app",
            "android app",
        ),
        short_answer_vi=(
            "Sử dụng ViRead trên Android (APK & trình duyệt di động):\n"
            "• Hỗ trợ đầy đủ tạo hồ sơ bé, chuyển nhanh hồ sơ trên thanh đầu trang, quét sách giấy bằng camera, đọc to với micro và chơi Góc giải trí.\n"
            "• Trên Android, hãy cấp quyền Micro & Máy ảnh trong Cài đặt ứng dụng để quét sách và thu âm đọc mượt mà."
        ),
        detailed_answer_vi=(
            "Hướng dẫn dùng ViRead Android APK và thiết bị di động:\n"
            "1. Quyền thiết bị: vào Cài đặt Android → Ứng dụng → ViRead → Quyền → cho phép Micro và Máy ảnh.\n"
            "2. Chuyển hồ sơ bé nhanh: dùng nút chuyển bé gọn trên thanh đầu trang trước khi vào Kho sách, Quét sách, Chuyến Tàu Đọc 5 Phút hoặc Vườn Âm Vị.\n"
            "3. Nếu mạng di động 3G/4G chậm, bật chế độ Tiết kiệm dữ liệu (Low bandwidth) trên Trợ lý ViRead để nhận hướng dẫn nhanh gọn."
        ),
        short_answer_en=(
            "Using ViRead on Android (APK & mobile):\n"
            "• Supports child switching in the compact top bar, camera book scanning, read-aloud mic sessions, and Entertainment games.\n"
            "• Enable Microphone and Camera permissions in Android App Settings for smooth scanning and speech capture."
        ),
        detailed_answer_en=(
            "ViRead Android APK tips:\n"
            "1. Open Android Settings → Apps → ViRead → Permissions and allow Microphone & Camera.\n"
            "2. Use the compact header child switcher before entering Books, Scanner, Reading Train, or Achievements.\n"
            "3. Switch the assistant to Data Saver mode when on slow mobile connections."
        ),
        actions=(
            KbAction("Chuẩn bị đọc & micro", "Reading Prep & Mic", "/reading-preparation"),
            KbAction("Trợ giúp & hỗ trợ", "Help & Support", "/help-support"),
        ),
        followups_vi=(
            "Micro hoặc camera không mở được trên điện thoại?",
            "Cách quét sách giấy bằng camera?",
            "Chế độ tiết kiệm băng tần hoạt động thế nào?",
        ),
        followups_en=(
            "Mic or camera won't open on mobile?",
            "How do I scan a paper book with camera?",
            "How does Data Saver mode work?",
        ),
    ),
    # ------------------------------------------------------------------ Additional Admin-only KB (strictly isolated!)
    KbArticle(
        id="admin_overview_workspace",
        title_vi="Tổng quan Khu vực Quản trị ViRead (/admin)",
        title_en="ViRead Admin Workspace Overview (/admin)",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin",),
        keywords=(
            "tong quan admin",
            "bang dieu khien admin",
            "trang quan tri",
            "chuc nang admin",
            "admin overview",
            "admin workspace",
            "admin dashboard",
        ),
        short_answer_vi=(
            "Bảng điều khiển Quản trị (/admin) tập trung toàn bộ công cụ vận hành ViRead:\n"
            "• Kho sách (/admin/books) & Tạo sách (/admin/books/new): tải trang, quét OCR (Gemini vs Qwen3-VL / Tesseract / VietOCR) và duyệt revision VERIFIED.\n"
            "• Chất lượng sách (/admin/metadata-quality): Child Safety GRADE_1_TO_5, bản quyền và xử lý báo lỗi từ phụ huynh.\n"
            "• Bài hát Karaoke (/admin/karaoke), Phụ huynh (/admin/parents), Tác vụ AI (/admin/tasks), Huấn luyện VietOCR (/admin/viread-training), Nhật ký (/admin/audit-logs) & Vận hành (/admin/health)."
        ),
        detailed_answer_vi=(
            "Các phân hệ trong Khu vực Quản trị ViRead (/admin):\n"
            "1. Nội dung sách: /admin/books, /admin/books/new, /admin/books/[bookId]/edit và màn hình duyệt OCR từng trang /admin/books/[bookId]/pages/[pageId].\n"
            "2. Kiểm duyệt & An toàn: /admin/metadata-quality (Child Safety GRADE_1_TO_5, Readability, bản quyền, báo cáo sách).\n"
            "3. Giải trí & Người dùng: /admin/karaoke, /admin/karaoke/new và /admin/parents.\n"
            "4. Vận hành & AI: /admin/tasks, /admin/viread-training, /admin/audit-logs và /admin/health."
        ),
        short_answer_en=(
            "ViRead Admin Workspace (/admin) centralizes operations:\n"
            "• Books (/admin/books, /admin/books/new) & per-page OCR review.\n"
            "• Book Quality (/admin/metadata-quality): Child Safety GRADE_1_TO_5, rights, and parent reports.\n"
            "• Karaoke (/admin/karaoke), Parents (/admin/parents), AI Tasks (/admin/tasks), VietOCR Training (/admin/viread-training), Audit Logs (/admin/audit-logs), and Health (/admin/health)."
        ),
        detailed_answer_en=(
            "ViRead Admin modules:\n"
            "1. Catalog & OCR: /admin/books, /admin/books/new, /admin/books/[bookId]/edit, and /admin/books/[bookId]/pages/[pageId].\n"
            "2. Safety & Moderation: /admin/metadata-quality.\n"
            "3. Karaoke & Accounts: /admin/karaoke, /admin/karaoke/new, /admin/parents.\n"
            "4. System & AI Ops: /admin/tasks, /admin/viread-training, /admin/audit-logs, /admin/health."
        ),
        actions=(
            KbAction("Kho sách Admin", "Admin Books", "/admin/books"),
            KbAction("Chất lượng sách", "Quality Hub", "/admin/metadata-quality"),
            KbAction("Vận hành hệ thống", "System Health", "/admin/health"),
        ),
        followups_vi=(
            "Quy trình duyệt OCR trang sách (Gemini vs Qwen3-VL / VietOCR)?",
            "Cách quản lý bài hát Karaoke ở /admin/karaoke?",
            "Kiểm tra sức khỏe worker ở /admin/health?",
        ),
        followups_en=(
            "How does per-page OCR review work?",
            "How do I manage Karaoke songs at /admin/karaoke?",
            "How do I check worker health at /admin/health?",
        ),
    ),
    KbArticle(
        id="admin_karaoke_and_parents",
        title_vi="Quản lý bài hát Karaoke (/admin/karaoke) & Phụ huynh (/admin/parents)",
        title_en="Admin Karaoke Library (/admin/karaoke) & Parents Directory (/admin/parents)",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin/karaoke", "/admin/parents"),
        keywords=(
            "admin karaoke",
            "tao bai hat karaoke",
            "quan ly bai hat",
            "karaoke new",
            "admin parents",
            "quan ly phu huynh",
            "danh sach phu huynh",
            "ho so phu huynh admin",
            "manage parents",
            "manage karaoke",
        ),
        short_answer_vi=(
            "Quản trị Karaoke & Tài khoản Phụ huynh:\n"
            "• Bài hát Karaoke (/admin/karaoke & /admin/karaoke/new): nhập bài hát đồng dao/thiếu nhi, đồng bộ timeline lời hát và chuyển trạng thái Bản nháp (DRAFT), Đang hiển thị (PUBLISHED) hoặc Đã ẩn (HIDDEN).\n"
            "• Phụ huynh (/admin/parents): tìm kiếm, xem chi tiết, tạo hoặc cập nhật thông tin tài khoản phụ huynh trong phạm vi quản trị."
        ),
        detailed_answer_vi=(
            "Hướng dẫn quản lý Karaoke và Phụ huynh dành cho Admin:\n"
            "1. Kho Karaoke (/admin/karaoke): lọc theo trạng thái DRAFT/PUBLISHED/HIDDEN, thêm bài mới tại /admin/karaoke/new, chỉnh sửa timeline lời bài hát tại /admin/karaoke/[songId]/edit và bật/ẩn hiển thị.\n"
            "2. Quản lý Phụ huynh (/admin/parents): tìm kiếm theo tên/email, mở hồ sơ chi tiết (/admin/parents/[parentId]), chỉnh sửa thông tin liên hệ hợp lệ hoặc xử lý vô hiệu hóa theo quy trình kiểm toán."
        ),
        short_answer_en=(
            "Admin Karaoke & Parents management:\n"
            "• Karaoke (/admin/karaoke & /admin/karaoke/new): import children's songs, sync lyric timelines, and toggle DRAFT / PUBLISHED / HIDDEN.\n"
            "• Parents (/admin/parents): search, inspect, create, or update parent account records via admin controls."
        ),
        detailed_answer_en=(
            "Admin workflows for Karaoke & Parents:\n"
            "1. Karaoke (/admin/karaoke): create songs at /admin/karaoke/new, edit synced lyric timelines at /admin/karaoke/[songId]/edit, and publish/hide entries.\n"
            "2. Parents (/admin/parents): search accounts, view /admin/parents/[parentId], and manage parent metadata within audited admin boundaries."
        ),
        actions=(
            KbAction("Bài hát Karaoke", "Admin Karaoke", "/admin/karaoke"),
            KbAction("Thêm bài Karaoke", "New Karaoke", "/admin/karaoke/new"),
            KbAction("Quản lý Phụ huynh", "Admin Parents", "/admin/parents"),
        ),
        followups_vi=(
            "Cách duyệt OCR trang sách bằng Gemini / Qwen3-VL / VietOCR?",
            "Xem nhật ký kiểm toán quản trị ở đâu?",
            "Theo dõi tác vụ AI toàn hệ thống ở /admin/tasks?",
        ),
        followups_en=(
            "How do I review page OCR with Gemini / Qwen3-VL / VietOCR?",
            "Where are admin audit logs?",
            "How do I monitor system AI tasks at /admin/tasks?",
        ),
    ),
    KbArticle(
        id="admin_assistant_and_privacy",
        title_vi="Nguyên tắc cách ly Quản trị & Trợ lý ViRead Admin",
        title_en="Admin Isolation Policy & ViRead Admin Assistant",
        scopes=_ADMIN_ONLY,
        route_prefixes=("/admin", "/admin/audit-logs"),
        keywords=(
            "cach ly admin",
            "pham vi admin",
            "nguyen tac bao mat admin",
            "chatbot admin",
            "tro ly admin",
            "admin isolation",
            "admin privacy",
            "audit logs",
        ),
        short_answer_vi=(
            "Trợ lý ViRead ở chế độ Quản trị chỉ điều hướng và giải đáp trong phạm vi /admin/* (/admin/books, /admin/metadata-quality, /admin/karaoke, /admin/parents, /admin/tasks, /admin/viread-training, /admin/audit-logs, /admin/health) — tách biệt hoàn toàn khỏi giao diện đọc/chơi của phụ huynh & bé."
        ),
        detailed_answer_vi=(
            "Chính sách bảo mật và phân tách vai trò cho Admin:\n"
            "1. Mọi lối tắt và gợi ý điều hướng chỉ nằm trong hệ thống trang /admin/*.\n"
            "2. Trợ lý không mở giao diện khách hàng (/dashboard, /books, /children, /reading/*, /entertainment, /achievements, /learning-train) hoặc trang đăng nhập khách (/login, /register).\n"
            "3. Mọi thao tác quản trị quan trọng đều được ghi nhận tại Nhật ký kiểm toán (/admin/audit-logs)."
        ),
        short_answer_en=(
            "In Admin mode, ViRead Assistant stays strictly inside /admin/* routes and never navigates into customer reading/game pages or guest auth routes."
        ),
        detailed_answer_en=(
            "Admin workspace isolation rules:\n"
            "1. Navigation offers and quick actions stay strictly inside /admin/*.\n"
            "2. Customer pages (/dashboard, /books, /children, /reading/*, /entertainment, /achievements, /learning-train) and guest auth routes are blocked.\n"
            "3. Sensitive admin actions are recorded in /admin/audit-logs."
        ),
        actions=(
            KbAction("Nhật ký kiểm toán", "Audit Logs", "/admin/audit-logs"),
            KbAction("Vận hành hệ thống", "System Health", "/admin/health"),
        ),
        followups_vi=(
            "Quy trình duyệt OCR và Child Safety?",
            "Cách quản lý mô hình VietOCR Flow 2?",
            "Xem tác vụ AI toàn hệ thống ở đâu?",
        ),
        followups_en=(
            "How do OCR review and Child Safety work?",
            "How do I manage VietOCR Flow 2 training?",
            "Where are system-wide AI tasks?",
        ),
    ),
)


PAGE_CONTEXT_SPECS: tuple[PageContextSpec, ...] = (
    PageContextSpec(
        prefix="/admin/login",
        scopes=_PUBLIC_ONLY,
        title_vi="Đăng nhập Quản trị",
        title_en="Admin Sign In",
        greeting_vi="Trang đăng nhập dành riêng cho Quản trị viên ViRead. Hãy dùng tài khoản quản trị được cấp để tiếp tục.",
        greeting_en="Sign-in page for authorized ViRead Administrators. Use your assigned admin credentials to continue.",
        prompts_vi=(
            "Tài khoản quản trị đăng nhập như thế nào?",
            "Quên mật khẩu tài khoản thì xử lý thế nào?",
            "ViRead có những tính năng gì?",
        ),
        prompts_en=(
            "How do administrators sign in?",
            "How does password recovery work?",
            "What is ViRead?",
        ),
        actions=(),
    ),
    PageContextSpec(
        prefix="/admin/books/new",
        scopes=_ADMIN_ONLY,
        title_vi="Tạo sách mới (Admin)",
        title_en="Create Catalog Book (Admin)",
        greeting_vi="Nhập metadata sách, tải ảnh bìa và các trang sách để chạy OCR & kiểm duyệt Child Safety.",
        greeting_en="Enter book metadata, upload cover & page images, and launch OCR & Child Safety checks.",
        prompts_vi=(
            "Quy trình tải trang và duyệt OCR VERIFIED?",
            "Điều kiện Child Safety GRADE_1_TO_5 gồm gì?",
            "Xem hàng đợi tác vụ AI toàn hệ thống ở đâu?",
        ),
        prompts_en=(
            "What is the OCR upload and VERIFIED review flow?",
            "What are the GRADE_1_TO_5 Child Safety rules?",
            "Where do I monitor system AI tasks?",
        ),
        actions=(
            KbAction("Kho sách Admin", "Admin Books", "/admin/books"),
            KbAction("Chất lượng sách", "Quality Hub", "/admin/metadata-quality"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/books",
        scopes=_ADMIN_ONLY,
        title_vi="Kho sách & Duyệt OCR (Admin)",
        title_en="Admin Book Catalog & OCR Review",
        greeting_vi="Quản lý sách thư viện, so sánh OCR (Gemini vs Qwen3-VL / VietOCR / Tesseract) và xác minh revision VERIFIED.",
        greeting_en="Manage catalog books, compare OCR engines (Gemini vs Qwen3-VL / VietOCR / Tesseract), and verify revisions.",
        prompts_vi=(
            "Quy trình duyệt OCR trang sách từ NEEDS_REVIEW sang VERIFIED?",
            "AI sửa (proofreading) và Quét OCR khác nhau thế nào?",
            "Kiểm tra Child Safety và bản quyền sách ở đâu?",
        ),
        prompts_en=(
            "How do I review OCR from NEEDS_REVIEW to VERIFIED?",
            "How do OCR scan and AI proofreading differ?",
            "Where do I review Child Safety and rights?",
        ),
        actions=(
            KbAction("Tạo sách mới", "Create Book", "/admin/books/new"),
            KbAction("Chất lượng sách", "Quality Hub", "/admin/metadata-quality"),
            KbAction("Tác vụ Admin", "Admin Tasks", "/admin/tasks"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/karaoke/new",
        scopes=_ADMIN_ONLY,
        title_vi="Thêm bài hát Karaoke (Admin)",
        title_en="New Karaoke Song (Admin)",
        greeting_vi="Tạo bài hát đồng dao thiếu nhi mới, tải audio/lời bài hát và kiểm tra timeline trước khi xuất bản.",
        greeting_en="Create a new children's karaoke song, attach audio/lyrics, and verify timing before publishing.",
        prompts_vi=(
            "Các trạng thái DRAFT, PUBLISHED, HIDDEN của Karaoke là gì?",
            "Quay lại danh sách bài hát Karaoke ở đâu?",
            "Theo dõi tác vụ xử lý Karaoke tại đâu?",
        ),
        prompts_en=(
            "What do DRAFT, PUBLISHED, and HIDDEN mean?",
            "Where is the Admin Karaoke library?",
            "Where do I track Karaoke processing jobs?",
        ),
        actions=(
            KbAction("Bài hát Karaoke", "Admin Karaoke", "/admin/karaoke"),
            KbAction("Tác vụ Admin", "Admin Tasks", "/admin/tasks"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/karaoke",
        scopes=_ADMIN_ONLY,
        title_vi="Quản lý Karaoke (Admin)",
        title_en="Admin Karaoke Library",
        greeting_vi="Quản lý kho bài hát đồng dao thiếu nhi, chỉnh timeline lời hát và bật/ẩn bài hát.",
        greeting_en="Manage the children's karaoke library, edit lyric timelines, and toggle visibility.",
        prompts_vi=(
            "Cách thêm bài hát Karaoke mới và chỉnh timeline?",
            "Các trạng thái hiển thị của bài hát Karaoke?",
            "Theo dõi tác vụ xử lý ở /admin/tasks?",
        ),
        prompts_en=(
            "How do I add and time a new Karaoke song?",
            "How do Karaoke visibility states work?",
            "Where do I check background jobs?",
        ),
        actions=(
            KbAction("Thêm bài Karaoke", "New Karaoke", "/admin/karaoke/new"),
            KbAction("Tác vụ Admin", "Admin Tasks", "/admin/tasks"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/parents",
        scopes=_ADMIN_ONLY,
        title_vi="Quản lý Phụ huynh (Admin)",
        title_en="Admin Parents Directory",
        greeting_vi="Tìm kiếm, kiểm tra trạng thái tài khoản phụ huynh và cập nhật thông tin quản trị hợp lệ.",
        greeting_en="Search parent accounts, review profile metadata, and perform audited admin updates.",
        prompts_vi=(
            "Quản lý tài khoản phụ huynh tại /admin/parents gồm gì?",
            "Xem nhật ký kiểm toán thao tác quản trị ở đâu?",
            "Kiểm tra sức khỏe hệ thống ở đâu?",
        ),
        prompts_en=(
            "What actions are available in Admin Parents?",
            "Where are admin audit logs recorded?",
            "Where do I check system health?",
        ),
        actions=(
            KbAction("Nhật ký kiểm toán", "Audit Logs", "/admin/audit-logs"),
            KbAction("Vận hành hệ thống", "System Health", "/admin/health"),
        ),
    ),
    PageContextSpec(
        prefix="/admin/audit-logs",
        scopes=_ADMIN_ONLY,
        title_vi="Nhật ký kiểm toán (Admin)",
        title_en="Admin Audit Logs",
        greeting_vi="Truy vết các thao tác quản trị trên sách, kiểm duyệt, tài khoản phụ huynh và cấu hình hệ thống.",
        greeting_en="Audit administrative actions across books, moderation, parent accounts, and operations.",
        prompts_vi=(
            "Nhật ký kiểm toán ghi lại những thao tác nào?",
            "Kiểm tra sức khỏe worker và AI provider ở đâu?",
            "Quay lại Kho sách Admin?",
        ),
        prompts_en=(
            "What events appear in Admin Audit Logs?",
            "Where do I check worker and AI health?",
            "How do I return to Admin Books?",
        ),
        actions=(
            KbAction("Vận hành hệ thống", "System Health", "/admin/health"),
            KbAction("Kho sách Admin", "Admin Books", "/admin/books"),
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
        prefix="/achievements",
        scopes=_PARENT_ONLY,
        title_vi="Vườn Âm Vị & Huy hiệu",
        title_en="Phoneme Garden & Achievements",
        greeting_vi="Cùng xem các bông hoa âm vị đã nở, huy hiệu và Hộ chiếu Tem Đọc Sách của bé nhé!",
        greeting_en="Explore your child's blooming Phoneme Garden, badges, and Book Stamp Passport!",
        prompts_vi=(
            "Vườn Âm Vị & Hộ chiếu Tem Đọc Sách hoạt động thế nào?",
            "Chuyến Tàu Đọc 5 Phút giúp bé luyện gì mỗi ngày?",
            "Làm sao tải Chứng nhận cột mốc cho bé?",
        ),
        prompts_en=(
            "How do Phoneme Garden & Book Stamp Passport work?",
            "How does the 5-Minute Reading Train work?",
            "How do I download Milestone Certificates?",
        ),
        actions=(
            KbAction("Chuyến Tàu Đọc 5 Phút", "5-Min Reading Train", "/learning-train"),
            KbAction("Xem Tiến bộ", "View Progress", "/reports"),
        ),
    ),
    PageContextSpec(
        prefix="/learning-train",
        scopes=_PARENT_ONLY,
        title_vi="Chuyến Tàu Đọc 5 Phút",
        title_en="5-Minute Reading Train",
        greeting_vi="Sẵn sàng lên 3 toa tàu luyện đọc 5 phút cùng Cô/Thầy AI cho bé hôm nay!",
        greeting_en="Ready for today's 3-car 5-Minute Reading Train with your AI Teacher!",
        prompts_vi=(
            "Chuyến Tàu Đọc 5 Phút gồm 3 toa luyện gì?",
            "Vườn Âm Vị & Huy hiệu lưu kết quả ở đâu?",
            "Đổi giọng Cô giáo / Thầy giáo AI ở đâu?",
        ),
        prompts_en=(
            "What are the 3 cars in the 5-Minute Reading Train?",
            "Where are Phoneme Garden & badges saved?",
            "How do I change AI Teacher Voice Persona?",
        ),
        actions=(
            KbAction("Vườn Âm Vị & Huy hiệu", "Achievements", "/achievements"),
            KbAction("Chuẩn bị buổi đọc", "Reading Prep", "/reading-preparation"),
        ),
    ),
    PageContextSpec(
        prefix="/studio/tasks",
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
            KbAction("Chuẩn bị đọc & micro", "Reading Prep & Mic", "/reading-preparation"),
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
        title_vi="Chuẩn bị buổi đọc",
        title_en="Reading Preparation",
        greeting_vi="Sẵn sàng cho buổi đọc! Cần hỗ trợ chọn bé, chọn trang, chỉnh tốc độ 0.85x hay kiểm tra micro?",
        greeting_en="Ready to read! Need help picking a child, page range, 0.85x voice speed, or testing the mic?",
        prompts_vi=(
            "Cách chọn phạm vi trang và tốc độ 0.85x cho bé đọc chậm?",
            "Kiểm tra micro trước khi bé đọc?",
            "Giọng đọc mẫu và Khóa giọng đọc theo buổi là gì?",
        ),
        prompts_en=(
            "How do I pick pages or 0.85x speed for slow readers?",
            "How do I test the mic before reading?",
            "How do model voice and Session Voice Lock work?",
        ),
        actions=(
            KbAction("Mở kho Sách", "Browse Books", "/books"),
            KbAction("Trợ giúp & hỗ trợ", "Help & Support", "/help-support"),
        ),
    ),
    PageContextSpec(
        prefix="/reading",
        scopes=_PARENT_ONLY,
        title_vi="Buổi đọc cùng bé",
        title_en="Reading Session",
        greeting_vi="Mình giữ khung thật gọn để không làm bé mất tập trung. Ba mẹ cần hỗ trợ gì?",
        greeting_en="Keeping this compact so your child stays focused. How can I help?",
        prompts_vi=(
            "Micro không nhận giọng bé phải làm sao?",
            "Cách đổi giọng đọc mẫu (TTS) hoặc tốc độ 0.85x?",
            "Từ bé đọc nhầm sẽ lưu ở đâu?",
        ),
        prompts_en=(
            "Mic isn't picking up my child's voice",
            "How do I switch model voice or 0.85x speed?",
            "Where are missed words saved?",
        ),
        actions=(
            KbAction("Chuẩn bị đọc & micro", "Reading Prep & Mic", "/reading-preparation"),
            KbAction("Từ cần luyện", "Difficult Words", "/reports/difficult-words"),
        ),
    ),
    PageContextSpec(
        prefix="/book-scanner",
        scopes=_PARENT_ONLY,
        title_vi="Quét sách giấy",
        title_en="Book Scanner",
        greeting_vi="Tôi có thể hướng dẫn chụp trang sách rõ chữ, so sánh với Sách của tôi và hàng chờ OCR.",
        greeting_en="I can share tips for sharp page scans, My Books comparison, and the OCR queue.",
        prompts_vi=(
            "Quét nhanh (/book-scanner) và Sách của tôi (/my-books) khác gì nhau?",
            "Hàng chờ OCR ngoại tuyến hoạt động thế nào?",
            "Camera không mở được thì xử lý sao?",
        ),
        prompts_en=(
            "How is Quick Scan different from My Books?",
            "How does the offline OCR queue work?",
            "Camera won't open — how to fix?",
        ),
        actions=(
            KbAction("Sách của tôi", "My Books", "/my-books"),
            KbAction("Chuẩn bị đọc & micro", "Reading Prep & Mic", "/reading-preparation"),
        ),
    ),
    PageContextSpec(
        prefix="/my-books",
        scopes=_PARENT_ONLY,
        title_vi="Sách của tôi",
        title_en="My Books",
        greeting_vi="Hỏi tôi về tải ảnh/PDF/DOCX, Smart Studio tạo bìa AI và hàng chờ OCR ngoại tuyến.",
        greeting_en="Ask me about uploading images/PDF/DOCX, Smart Studio AI covers, and offline OCR queue.",
        prompts_vi=(
            "Quét nhanh (/book-scanner) và Sách của tôi (/my-books) khác gì nhau?",
            "Smart Studio tạo ảnh bìa và minh họa thế nào?",
            "Theo dõi tác vụ AI đang chạy ở đâu?",
        ),
        prompts_en=(
            "How is Quick Scan different from My Books?",
            "How does Smart Studio create covers & art?",
            "Where can I track running AI jobs?",
        ),
        actions=(
            KbAction("Mở Quét sách", "Open Scanner", "/book-scanner"),
            KbAction("Tác vụ AI", "AI Tasks", "/studio/tasks"),
        ),
    ),
    PageContextSpec(
        prefix="/reports/difficult-words",
        scopes=_PARENT_ONLY,
        title_vi="Từ cần luyện",
        title_en="Difficult Words",
        greeting_vi="Cần hướng dẫn giúp bé ôn phát âm các từ khó bằng micro tự động?",
        greeting_en="Need tips on practicing tricky words with audio and auto-mic?",
        prompts_vi=(
            "Bé đọc chậm và hay vấp từ thì luyện thế nào?",
            "Micro không nhận giọng bé khi luyện từ?",
            "Xem báo cáo tiến bộ tổng hợp ở đâu?",
        ),
        prompts_en=(
            "How do we support a slow reader with difficult words?",
            "Mic isn't hearing my child during practice",
            "Where is the full progress report?",
        ),
        actions=(
            KbAction("Xem Tiến bộ", "View Progress", "/reports"),
            KbAction("Chuẩn bị đọc & micro", "Reading Prep & Mic", "/reading-preparation"),
        ),
    ),
    PageContextSpec(
        prefix="/reports",
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PUBLIC_ONLY,
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
        scopes=_PUBLIC_ONLY,
        title_vi="Đăng ký ViRead",
        title_en="Register for ViRead",
        greeting_vi="Tạo tài khoản phụ huynh ViRead chỉ trong 1 phút. Hỏi tôi nếu cần hỗ trợ!",
        greeting_en="Create your ViRead parent account in a minute. Ask me if you need help!",
        prompts_vi=(
            "Cách xác minh email sau khi đăng ký?",
            "3 bước bắt đầu với ViRead sau khi đăng nhập?",
            "ViRead phù hợp cho bé lớp mấy?",
        ),
        prompts_en=(
            "How do I verify my email after signing up?",
            "What are the 3 steps after signing in?",
            "Which grade levels is ViRead for?",
        ),
        actions=(
            KbAction("Đã có tài khoản? Đăng nhập", "Sign in", "/login"),
        ),
    ),
    PageContextSpec(
        prefix="/forgot-password",
        scopes=_PUBLIC_ONLY,
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
        scopes=_PUBLIC_ONLY,
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
        scopes=_PARENT_ONLY,
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
        prefix="/children/new",
        scopes=_PARENT_ONLY,
        title_vi="Tạo hồ sơ bé mới",
        title_en="Create Child Profile",
        greeting_vi="Bước 1 rất nhanh: nhập tên và chọn lớp (1–5) để tạo không gian đọc riêng cho bé!",
        greeting_en="Quick Step 1: enter a name and grade (1–5) to create your child's own reading space!",
        prompts_vi=(
            "3 bước bắt đầu cho ba mẹ mới gồm gì?",
            "Nhà có 2 bé học khác lớp thì chuyển đổi thế nào?",
            "Sau khi tạo hồ sơ bé thì chọn sách ở đâu?",
        ),
        prompts_en=(
            "What are the 3 onboarding steps for new parents?",
            "How do siblings switch profiles?",
            "Where do I pick a book after creating a profile?",
        ),
        actions=(
            KbAction("Danh sách Hồ sơ bé", "Child Profiles", "/children"),
            KbAction("Về Tổng quan", "Dashboard", "/dashboard"),
        ),
    ),
    PageContextSpec(
        prefix="/children",
        scopes=_PARENT_ONLY,
        title_vi="Hồ sơ bé",
        title_en="Child Profiles",
        greeting_vi="Quản lý hồ sơ từng bé theo lớp 1–5 để lưu riêng tủ sách, báo cáo và từ cần luyện.",
        greeting_en="Manage Grade 1–5 child profiles with separate bookshelves, reports, and difficult words.",
        prompts_vi=(
            "Làm sao tạo hồ sơ cho bé?",
            "Nhà có nhiều bé thì chuyển đổi giữa các bé thế nào?",
            "Tại sao phải chọn hồ sơ bé trước khi đọc/chơi?",
        ),
        prompts_en=(
            "How do I create a child profile?",
            "How do multi-child families switch siblings?",
            "Why is child selection required before reading/games?",
        ),
        actions=(
            KbAction("Tạo hồ sơ bé mới", "Create Child Profile", "/children/new"),
            KbAction("Về Tổng quan", "Dashboard", "/dashboard"),
        ),
    ),
    PageContextSpec(
        prefix="/profile",
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
        prefix="/help-support",
        scopes=_PARENT_ONLY,
        title_vi="Trợ giúp & hỗ trợ",
        title_en="Help & Support",
        greeting_vi="Cần hỏi nhanh về tính năng ViRead, báo lỗi sách hay gửi phản hồi cho đội ngũ?",
        greeting_en="Need quick help with ViRead features, book issue reports, or contacting support?",
        prompts_vi=(
            "Cách gửi phản hồi hoặc báo lỗi kỹ thuật?",
            "Làm sao báo lỗi chữ sai trong sách?",
            "Mạng 3G chậm hoặc ngoại tuyến thì dùng thế nào?",
        ),
        prompts_en=(
            "How do I send support feedback?",
            "How do I report a typo in a book?",
            "How does ViRead work on slow 3G or offline?",
        ),
        actions=(
            KbAction("Báo cáo sách", "Book Reports", "/book-reports"),
            KbAction("Chuẩn bị đọc & micro", "Reading Prep & Mic", "/reading-preparation"),
        ),
    ),
    PageContextSpec(
        prefix="/book-reports",
        scopes=_PARENT_ONLY,
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
        scopes=_PARENT_ONLY,
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
    scopes=_PUBLIC_ONLY,
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
    scopes=_PARENT_ONLY,
    title_vi="Trợ lý ViRead",
    title_en="ViRead Assistant",
    greeting_vi="Xin chào ba mẹ! Hỏi tôi bất kỳ thao tác nào trong ViRead nhé.",
    greeting_en="Hi! Ask me how to use any feature in ViRead.",
    prompts_vi=(
        "Cách bắt đầu buổi đọc cho bé?",
        "Chuyến Tàu Đọc 5 Phút và Vườn Âm Vị là gì?",
        "Khắc phục lỗi micro không thu tiếng?",
    ),
    prompts_en=(
        "How do I start a reading session?",
        "What are 5-Minute Reading Train and Phoneme Garden?",
        "How do I fix microphone issues?",
    ),
    actions=(
        KbAction("Về Tổng quan", "Dashboard", "/dashboard"),
        KbAction("Trợ giúp & hỗ trợ", "Help & Support", "/help-support"),
    ),
)

_DEFAULT_ADMIN_CONTEXT = PageContextSpec(
    prefix="/admin",
    scopes=_ADMIN_ONLY,
    title_vi="Trợ lý Quản trị ViRead",
    title_en="ViRead Admin Assistant",
    greeting_vi="Xin chào Quản trị viên! Hỏi tôi về kho sách, duyệt OCR, Child Safety, Karaoke hay vận hành hệ thống.",
    greeting_en="Hello Admin! Ask about catalog books, OCR review, Child Safety, Karaoke, or operations.",
    prompts_vi=(
        "Quy trình tải sách và duyệt OCR VERIFIED?",
        "Kiểm tra Child Safety và bản quyền sách?",
        "Xem trạng thái vận hành hệ thống ở đâu?",
    ),
    prompts_en=(
        "How do I upload and verify book OCR?",
        "How do Child Safety & rights checks work?",
        "Where is system health monitoring?",
    ),
    actions=(
        KbAction("Kho sách Admin", "Admin Books", "/admin/books"),
        KbAction("Chất lượng sách", "Quality Hub", "/admin/metadata-quality"),
        KbAction("Vận hành hệ thống", "System Health", "/admin/health"),
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
    {"/", "/login", "/register", "/forgot-password", "/reset-password"}
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
        "/achievements",
        "/learning-train",
        "/help-support",
        "/book-reports",
        "/studio/tasks",
    }
)

_ADMIN_STATIC_NAV_ALLOWLIST: frozenset[str] = frozenset(
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

ScopeBoundaryReason = Literal[
    "other_user",
    "admin_area",
    "customer_area",
    "guest_to_customer_area",
    "guest_area",
]


def _is_admin_path(path: str) -> bool:
    return path == "/admin" or path.startswith("/admin/")


def _is_protected_admin_path(path: str) -> bool:
    return _is_admin_path(path) and path != "/admin/login"


def sanitize_scoped_path(current_path: str, role_scope: AssistantRoleScope) -> str:
    clean = sanitize_current_path(current_path)
    if role_scope == "public":
        if clean == "/admin/login":
            return "/admin/login"
        if _is_protected_admin_path(clean) or clean not in _PUBLIC_ALLOWED_HREFS:
            return "/"
        return clean
    if role_scope == "parent":
        if _is_admin_path(clean) or clean in _PUBLIC_ALLOWED_HREFS:
            return "/dashboard"
        return clean
    if not _is_protected_admin_path(clean):
        return "/admin"
    return clean


def _is_href_allowed_for_scope(href: str, role_scope: AssistantRoleScope) -> bool:
    clean = sanitize_current_path(href)
    if clean != href or ".." in clean or "?" in clean or "#" in clean:
        return False
    if role_scope == "public":
        return clean in _PUBLIC_ALLOWED_HREFS
    if role_scope == "parent":
        return clean in _PARENT_STATIC_NAV_ALLOWLIST
    return clean in _ADMIN_STATIC_NAV_ALLOWLIST


def is_quick_action_href_allowed(href: str, role_scope: AssistantRoleScope) -> bool:
    """Strict disjoint allowlist check for assistant quick-action links."""
    return _is_href_allowed_for_scope(href, role_scope)


def is_navigation_href_allowed(href: str, role_scope: AssistantRoleScope) -> bool:
    """Strict disjoint allowlist check for interactive Yes/No navigation offers."""
    return _is_href_allowed_for_scope(href, role_scope)


_CUSTOMER_PATH_RE = re.compile(
    r"(?<!/admin)(?:^|[\s\"'(])/(?:"
    r"dashboard|my-books|book-scanner|children|reading-management|reading-preparation|"
    r"entertainment|achievements|learning-train|book-reports|studio/tasks|"
    r"reports|sessions|profile|settings|books|karaoke|reading"
    r")(?:/[a-z0-9_-]+)*(?=$|[\s\"'),.?!])"
)

_GUEST_AUTH_PATH_RE = re.compile(
    r"(?<!/admin)(?:^|[\s\"'(])/(?:login|register|forgot-password|reset-password)(?=$|[\s\"'),.?!])"
)

_ADMIN_PATH_RE = re.compile(
    r"(?:^|[\s\"'(])/admin(?:/[a-z0-9_-]+)*(?=$|[\s\"'),.?!])"
)

_OTHER_USER_PRIVATE_ACCESS_RE = re.compile(
    r"\b(?:xem|mo|sua|doi|xoa|lay|doc|truy cap|vao)\b.*\b"
    r"(?:email|tai khoan|ho so be|ho so con|lich su doc|mat khau|ma pin)\b.*\b"
    r"(?:nguoi khac|user khac|phu huynh khac|khach hang khac|ban toi|hang xom|nguoi la)\b"
)

_NAV_INTENT_MARKERS: tuple[str, ...] = (
    " mo ",
    " vao ",
    " di den ",
    " chuyen sang ",
    " chuyen toi ",
    " truy cap ",
    " cho toi xem trang ",
    " dua toi den ",
    " open ",
    " go to ",
    " navigate to ",
    " take me to ",
    " switch to ",
    " access ",
)


def detect_disallowed_scope_request(
    message: str,
    *,
    role_scope: AssistantRoleScope,
) -> ScopeBoundaryReason | None:
    """Enforce strict 4-way role & tenant boundary checks before cache or LLM calls."""
    folded = fold_vietnamese(message)
    if not folded:
        return None
    padded = f" {folded} "

    other_user_markers = (
        "nguoi dung khac",
        "tai khoan khac",
        "tai khoan nguoi khac",
        "phu huynh khac",
        "khach hang khac",
        "gia dinh khac",
        "ho so nguoi khac",
        "ho so cua nguoi khac",
        "ho so be cua nguoi khac",
        "trang nguoi khac",
        "trang cua nguoi khac",
        "du lieu nguoi khac",
        "du lieu cua nguoi khac",
        "lich su doc cua nguoi khac",
        "email cua nguoi khac",
        "email cua phu huynh khac",
        "tai khoan cua nguoi khac",
        "cua nguoi khac",
        "cho nguoi khac",
        "muon xem trang cua",
        "vao tai khoan cua nguoi",
        "doi sang tai khoan cua",
        "dang nhap vao tai khoan cua",
        "xem ho so con nha",
        "xem lich su doc cua be khac",
        "xem email cua phu huynh",
        "xem du lieu rieng cua phu huynh",
        "other user",
        "another user",
        "another parent",
        "another customer",
        "another account",
        "another family",
        "someone else",
        "other family",
    )
    if any(marker in padded for marker in other_user_markers) or _OTHER_USER_PRIVATE_ACCESS_RE.search(
        folded
    ):
        return "other_user"

    if role_scope == "parent":
        if "/admin/login" in folded or any(
            marker in padded
            for marker in (
                " trang dang nhap admin ",
                " trang dang nhap quan tri ",
                " dang nhap quan tri ",
            )
        ):
            return "guest_area"
        if _GUEST_AUTH_PATH_RE.search(folded) or (
            any(intent in padded for intent in _NAV_INTENT_MARKERS)
            and any(
                target in padded
                for target in (" trang dang nhap ", " trang dang ky ", " trang quen mat khau ")
            )
        ):
            return "guest_area"

    if role_scope == "admin":
        if _GUEST_AUTH_PATH_RE.search(folded) or (
            any(intent in padded for intent in _NAV_INTENT_MARKERS)
            and any(
                target in padded
                for target in (
                    " trang dang nhap ",
                    " trang dang ky ",
                    " trang quen mat khau ",
                    " login page ",
                    " register page ",
                    " forgot password page ",
                )
            )
        ):
            return "guest_area"

        if _CUSTOMER_PATH_RE.search(folded):
            return "customer_area"
        customer_workspace_markers = (
            " trang khach hang ",
            " trang phu huynh ",
            " giao dien phu huynh ",
            " giao dien khach hang ",
            " khong gian phu huynh ",
            " khong gian khach hang ",
            " vao doc sach cua phu huynh ",
            " vao doc sach cua be ",
            " doc sach cua phu huynh ",
            " doc sach cua be ",
            " mo trang cua be ",
            " mo trang khach ",
            " chuyen sang trang phu huynh ",
            " chuyen sang khach hang ",
            " sang trang khach ",
            " mo dashboard ",
            " vao dashboard ",
            " mo ho so be ",
            " tao ho so be ",
            " mo sach cua toi ",
            " mo quet sach ",
            " mo goc giai tri ",
            " choi game cua be ",
            " mo vuon am vi ",
            " mo chuyen tau doc ",
            " customer area ",
            " customer workspace ",
            " parent workspace ",
            " parent dashboard ",
            " open parent ",
            " switch to parent ",
            " switch to customer ",
            " go to dashboard ",
        )
        if any(marker in padded for marker in customer_workspace_markers):
            return "customer_area"

    if role_scope != "admin":
        admin_markers = (
            "/admin/books",
            "/admin/health",
            "/admin/tasks",
            "/admin/parents",
            "/admin/karaoke",
            "/admin/audit-logs",
            "/admin/metadata-quality",
            "/admin/viread-training",
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
            "admin books",
            "admin karaoke",
            "audit logs",
            "nhat ky kiem toan",
            "viread training",
            "viread-training",
            "vietocr training",
            "apps script bridge",
            "flow 2",
        )
        has_admin_path = bool(_ADMIN_PATH_RE.search(folded))
        if has_admin_path:
            if role_scope == "public" and "/admin/login" in folded and not any(
                intent in padded for intent in _NAV_INTENT_MARKERS
            ):
                pass
            else:
                return "admin_area"
        if any(marker in padded or marker in folded for marker in admin_markers):
            return "admin_area"

    if role_scope == "public":
        if _CUSTOMER_PATH_RE.search(folded):
            return "guest_to_customer_area"
        has_nav_intent = any(intent in padded for intent in _NAV_INTENT_MARKERS)
        customer_targets = (
            " tong quan ",
            " dashboard ",
            " ho so be ",
            " tao ho so be ",
            " sach cua toi ",
            " cai dat ",
            " ho so ba me ",
            " bao cao tien bo ",
            " tu can luyen ",
            " lich su doc ",
            " tac vu ai ",
            " quan ly doc ",
            " vuon am vi ",
            " chuyen tau doc ",
            " quet sach ",
            " chuan bi doc ",
            " goc giai tri ",
            " memory game ",
            " sentence shooter ",
            " picture description ",
            " karaoke ",
            " kho sach ",
            " bao cao sach ",
            " child profile ",
            " my books ",
            " book scanner ",
            " reading prep ",
            " learning train ",
            " phoneme garden ",
            " achievements ",
            " difficult words ",
            " session history ",
            " entertainment ",
        )
        if has_nav_intent and any(target in padded for target in customer_targets):
            return "guest_to_customer_area"

    return None


def format_scope_boundary_reply(
    reason: ScopeBoundaryReason,
    *,
    role_scope: AssistantRoleScope,
    current_path: str,
    locale: str = "vi",
) -> tuple[str, list[AssistantQuickAction], list[str]]:
    """Return a warm, clear role-scoped refusal without offering disallowed routes."""
    use_en = _prefer_english(locale)
    _, _, page_prompts, page_actions = get_page_context(
        current_path, role_scope=role_scope, locale=locale
    )
    if reason == "admin_area":
        if use_en:
            reply = (
                "I'd love to help with your ViRead learning pages, but admin pages (/admin/*) are strictly "
                "restricted to authorized administrators. Everything I navigate or open stays safely inside your own workspace."
            )
        else:
            reply = (
                "Rất tiếc, mình không thể mở hay hướng dẫn các công cụ Quản trị (/admin) nhé! "
                "Vì an toàn hệ thống, trợ lý ViRead chỉ hỗ trợ và điều hướng trong phạm vi các trang dành cho bạn."
            )
    elif reason == "customer_area":
        if use_en:
            reply = (
                "Admin mode is strictly isolated from parent/customer reading and game pages (/dashboard, /books, /children, /reading/*, /entertainment, /achievements, /learning-train). "
                "To manage catalog books, karaoke, parents, or tasks as Admin, please use /admin/books, /admin/karaoke, /admin/parents, or /admin/tasks."
            )
        else:
            reply = (
                "Chế độ Quản trị (/admin) được tách biệt hoàn toàn khỏi giao diện đọc sách và trò chơi của phụ huynh/bé (/dashboard, /books, /children, /reading/*, /entertainment, /achievements, /learning-train). "
                "Nếu bạn cần quản lý sách, karaoke, phụ huynh hay tác vụ hệ thống, hãy thao tác trực tiếp tại /admin/books, /admin/karaoke, /admin/parents hoặc /admin/tasks nhé."
            )
    elif reason == "guest_to_customer_area":
        if use_en:
            reply = (
                "Those family workspace pages require signing in first. "
                "Please sign in at /login or create a free parent account at /register to access your dashboard, child profiles, books, and games."
            )
        else:
            reply = (
                "Các trang học đọc và quản lý gia đình yêu cầu đăng nhập tài khoản trước nhé! "
                "Bạn hãy Đăng nhập (/login) hoặc Đăng ký tài khoản phụ huynh (/register) để mở Bảng điều khiển, Hồ sơ bé, Kho sách và Góc giải trí."
            )
        if sanitize_scoped_path(current_path, role_scope) != "/admin/login":
            page_actions = [
                AssistantQuickAction(
                    label="Sign in" if use_en else "Đăng nhập",
                    href="/login",
                ),
                AssistantQuickAction(
                    label="Register" if use_en else "Đăng ký",
                    href="/register",
                ),
            ]
    elif reason == "guest_area":
        if use_en:
            reply = (
                "You are already signed in to your active workspace, so guest login/registration routes "
                "and cross-role sign-in pages are hidden here to keep your session safe."
            )
        else:
            reply = (
                "Bạn đang đăng nhập trong không gian làm việc của mình rồi, nên mình không điều hướng sang trang đăng nhập/đăng ký của khách hay cổng đăng nhập khác vai trò nhé!"
            )
    else:
        if use_en:
            reply = (
                "For family privacy and security, I can never open or access another user's account, email, child profiles, "
                "or private reading history. Everything stays strictly inside your own authorized scope."
            )
        else:
            reply = (
                "Vì bảo mật và quyền riêng tư gia đình, mình không thể truy cập, xem hay chỉnh sửa tài khoản, email, hồ sơ bé "
                "hoặc lịch sử đọc của người dùng khác nhé! Mọi thao tác đều được cách ly nghiêm ngặt trong phạm vi của bạn."
            )
    return reply, page_actions[:3], page_prompts[:3]


_VIREAD_DOMAIN_ANCHORS: tuple[str, ...] = (
    "viread",
    "readalong",
    "read along",
    "hoc doc",
    "luyen doc",
    "tap doc",
    "buoi doc",
    "man hinh doc",
    "doc sach",
    "sach giay",
    "sach thieu nhi",
    "sach cua toi",
    "kho sach",
    "thu vien sach",
    "bao cao sach",
    "quet sach",
    "scan sach",
    "ocr",
    "vietocr",
    "qwen3-vl",
    "tesseract",
    "paddleocr",
    "ho so be",
    "ho so phu huynh",
    "ho so ba me",
    "phu huynh",
    "ba me",
    "cho be",
    "be doc",
    "tre em",
    "bai tho",
    "truyen doc",
    "micro",
    "microphone",
    "camera",
    "giong doc",
    "tts",
    "stt",
    "wasm",
    "sherpa",
    "0.85x",
    "voice lock",
    "khoa giong",
    "teacher persona",
    "co giao ai",
    "thay giao ai",
    "instant countdown",
    "vuon am vi",
    "phoneme garden",
    "chuyen tau doc",
    "learning train",
    "storyweaver",
    "smart studio",
    "duet reading",
    "doc doi",
    "readability",
    "huy hieu",
    "ho chieu",
    "chung nhan",
    "milestone certificate",
    "pin lock",
    "ma pin",
    "reading presence",
    "karaoke",
    "dong dao",
    "memory game",
    "lat the",
    "sentence shooter",
    "ghep cau",
    "picture description",
    "mo ta tranh",
    "ai tutor",
    "doc hieu",
    "tu can luyen",
    "tu kho",
    "danh van",
    "am vi",
    "studio/tasks",
    "tac vu ai",
    "reading-management",
    "reading-preparation",
    "book-scanner",
    "my-books",
    "help-support",
    "vireadforyou",
    "apk",
    "android",
    "bang tan",
    "3g",
    "tien trinh ai",
    "child safety",
    "metadata quality",
    "viread-training",
    "audit-logs",
    "apps script bridge",
    "flow 1",
    "flow 2",
    "dang nhap",
    "dang ky",
    "quen mat khau",
    "dat lai mat khau",
    "doi mat khau",
    "xac minh email",
    "email nhac doc",
    "muc tieu tuan",
    "reading session",
    "book scanner",
    "child profile",
    "phoneme",
    "certificate",
)

_GREETING_ONLY_PHRASES: frozenset[str] = frozenset(
    {
        "xin chao",
        "chao",
        "chao ban",
        "chao tro ly",
        "chao viread",
        "hello",
        "hi",
        "hey",
        "good morning",
        "good afternoon",
        "good evening",
        "cam on",
        "thanks",
        "thank you",
        "ban la ai",
        "help",
        "giup toi",
    }
)

_OFF_TOPIC_MARKERS: tuple[str, ...] = (
    # Weather
    "thoi tiet",
    "du bao thoi tiet",
    "nhiet do hom nay",
    "troi mua",
    "troi nang",
    "weather",
    "forecast",
    "temperature today",
    "will it rain",
    # Stocks / Crypto / Gold / Forex
    "gia vang",
    "vang sjc",
    "chung khoan",
    "co phieu",
    "vnindex",
    "vn-index",
    "bitcoin",
    "ethereum",
    "crypto",
    "tien ao",
    "ty gia",
    "ngoai te",
    "stock price",
    "nasdaq",
    "gold price",
    "forex",
    # Sports
    "bong da",
    "ty so",
    "ket qua tran dau",
    "lich thi dau",
    "world cup",
    "ngoai hang anh",
    "premier league",
    "champions league",
    "football score",
    "soccer score",
    "match score",
    # Cooking / Recipes
    "nau an",
    "cong thuc nau",
    "cach nau",
    "mon an",
    "pho bo",
    "bun bo",
    "recipe",
    "how to cook",
    "bake a cake",
    "ingredients for",
    # Homework: Math / Physics / Chemistry
    "giai toan",
    "tinh tich phan",
    "dao ham",
    "phuong trinh",
    "bat phuong trinh",
    "he phuong trinh",
    "hinh hoc",
    "vat ly",
    "hoa hoc",
    "phan ung hoa hoc",
    "nguyen tu khoi",
    "bang tuan hoan",
    "solve math",
    "integral",
    "derivative",
    "quadratic equation",
    "physics problem",
    "chemistry equation",
    "calculus",
    "algebra",
    # General programming outside ViRead
    "viet code",
    "lap trinh",
    "debug code",
    "python",
    "javascript",
    "typescript",
    "react",
    "nextjs",
    "next js",
    "sql query",
    "golang",
    "rust",
    "leetcode",
    "thuat toan",
    "sap xep mang",
    "binary search",
    "docker",
    "kubernetes",
    "write a python",
    "write a script",
    "write a function",
    "sort an array",
    # Politics / News
    "chinh tri",
    "bau cu",
    "tong thong",
    "thu tuong",
    "quoc hoi",
    "tin tuc the gioi",
    "politics",
    "election",
    "prime minister",
    # Travel / Flights / Hotels
    "du lich",
    "ve may bay",
    "dat ve may bay",
    "khach san",
    "dat phong",
    "tour du lich",
    "flight ticket",
    "book a hotel",
    "travel itinerary",
    # Medical / Legal / Financial advice
    "chua benh",
    "uong thuoc",
    "trieu chung benh",
    "kham benh",
    "tu van phap luat",
    "luat su",
    "vay von",
    "lai suat ngan hang",
    "the tin dung",
    "medical advice",
    "diagnose",
    "prescription",
    "legal advice",
    "tax advice",
    # Lottery / Horoscope / Movies
    "xo so",
    "vietlott",
    "tu vi",
    "boi toan",
    "cung hoang dao",
    "phim chieu rap",
    "netflix",
    "horoscope",
    "lottery",
    # General essays / trivia
    "thu do cua",
    "capital of",
    "viet bai van",
    "write an essay",
)

_ARITHMETIC_HOMEWORK_RE = re.compile(
    r"(?:tinh|bang bao nhieu|calculate|solve|what is)\s*\d+\s*[\+\-\*\/\^]\s*\d+|\b\d+\s*[\+\-\*\/]\s*\d+\s*=\s*\?"
)


def detect_off_topic_request(
    message: str,
    role_scope: AssistantRoleScope = "public",
) -> bool:
    """Deterministically detect clearly non-ViRead off-topic prompts without false-positiving on ViRead."""
    _ = role_scope
    folded = fold_vietnamese(message)
    if not folded:
        return False
    padded = f" {folded} "

    if any(anchor in padded or anchor in folded for anchor in _VIREAD_DOMAIN_ANCHORS):
        return False

    if folded in _GREETING_ONLY_PHRASES:
        return False

    if _ARITHMETIC_HOMEWORK_RE.search(folded):
        return True

    return any(f" {marker} " in padded or marker in folded for marker in _OFF_TOPIC_MARKERS)


def format_off_topic_reply(
    *,
    role_scope: AssistantRoleScope,
    current_path: str,
    locale: str = "vi",
) -> tuple[str, list[AssistantQuickAction], list[str]]:
    """Politely decline non-ViRead topics and redirect back to role-scoped ViRead help."""
    use_en = _prefer_english(locale)
    _, _, page_prompts, page_actions = get_page_context(
        current_path, role_scope=role_scope, locale=locale
    )
    if role_scope == "admin":
        if use_en:
            reply = (
                "I'm the ViRead Admin Assistant and only support ViRead administration topics "
                "(catalog books, OCR review, Child Safety, Karaoke, Parents, AI Tasks, VietOCR Training, Audit Logs, and System Health)."
            )
        else:
            reply = (
                "Mình là Trợ lý Quản trị ViRead nên chỉ hỗ trợ các nghiệp vụ vận hành trên ViRead "
                "(Kho sách, Duyệt OCR, Child Safety, Karaoke, Phụ huynh, Tác vụ AI, Huấn luyện VietOCR, Nhật ký kiểm toán và Vận hành hệ thống) nhé!"
            )
    elif role_scope == "public":
        if use_en:
            reply = (
                "I specialize exclusively in ViRead (ReadAlong Vision) — helping families explore Vietnamese reading support for Grade 1–5 learners, "
                "account sign-in/registration, and browser mic/camera readiness. Let me know how I can help with ViRead!"
            )
        else:
            reply = (
                "Mình chỉ chuyên hỗ trợ về nền tảng luyện đọc tiếng Việt ViRead (ReadAlong Vision), hướng dẫn tính năng cho bé lớp 1–5, "
                "đăng nhập/đăng ký tài khoản và chuẩn bị thiết bị micro/camera nhé! Bạn muốn tìm hiểu phần nào của ViRead?"
            )
    else:
        if use_en:
            reply = (
                "I specialize exclusively in ViRead! I can guide you on child profiles, graded books, scanning paper books, "
                "5-Minute Reading Train, Phoneme Garden, Duet Reading, progress reports, difficult words, reminders, and kids games."
            )
        else:
            reply = (
                "Mình chỉ chuyên hỗ trợ các tính năng trong ViRead thôi nhé! Ba mẹ có thể hỏi mình về hồ sơ bé, chọn hoặc quét sách, "
                "Chuyến Tàu Đọc 5 Phút, Vườn Âm Vị & Huy hiệu, Đọc đôi, báo cáo tiến bộ, từ cần luyện, nhắc đọc hay góc giải trí."
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
    requires_child_selection: bool = False
    scenario_id: str | None = None


_NAV_RULES: tuple[_NavRule, ...] = (
    # Admin-only nav rules (specific routes before /admin)
    _NavRule(
        href="/admin/books/new",
        phrases=("tao sach moi", "them sach moi", "upload sach moi", "admin/books/new", "new book"),
        label_vi="Đi đến Tạo sách mới (Admin)",
        label_en="Go to New Book (Admin)",
        reason_vi="Tạo đầu sách mới và tải ảnh trang sách lên hệ thống OCR.",
        reason_en="Create a new catalog book and upload page images.",
        requires_child_selection=False,
        scenario_id="admin_books_ocr_review",
    ),
    _NavRule(
        href="/admin/books",
        phrases=("kho sach admin", "duyet ocr", "qwen3-vl", "needs_review", "revision verified", "admin/books"),
        label_vi="Đi đến Kho sách Admin",
        label_en="Go to Admin Books",
        reason_vi="Quản lý kho sách thư viện, duyệt OCR từng trang và xác minh VERIFIED.",
        reason_en="Manage catalog books and verify page OCR revisions.",
        requires_child_selection=False,
        scenario_id="admin_books_ocr_review",
    ),
    _NavRule(
        href="/admin/metadata-quality",
        phrases=("chat luong sach", "child safety", "grade_1_to_5", "ban quyen", "metadata-quality", "metadata quality"),
        label_vi="Đi đến Chất lượng sách (Admin)",
        label_en="Go to Book Quality Hub",
        reason_vi="Rà soát Child Safety, chính tả OCR, bản quyền và báo lỗi từ phụ huynh.",
        reason_en="Review Child Safety, OCR quality, rights, and parent reports.",
        requires_child_selection=False,
        scenario_id="admin_quality_child_safety",
    ),
    _NavRule(
        href="/admin/karaoke/new",
        phrases=("them bai karaoke", "tao bai hat karaoke", "admin/karaoke/new", "new karaoke"),
        label_vi="Đi đến Thêm bài hát Karaoke (Admin)",
        label_en="Go to New Karaoke Song",
        reason_vi="Thêm bài hát thiếu nhi mới và căn timeline lời bài hát.",
        reason_en="Create a new children's karaoke song and sync lyrics.",
        requires_child_selection=False,
        scenario_id="admin_karaoke_and_parents",
    ),
    _NavRule(
        href="/admin/karaoke",
        phrases=("quan ly karaoke", "bai hat karaoke", "admin/karaoke", "admin karaoke"),
        label_vi="Đi đến Quản lý Karaoke (Admin)",
        label_en="Go to Admin Karaoke",
        reason_vi="Quản lý kho bài hát đồng dao thiếu nhi và trạng thái xuất bản.",
        reason_en="Manage children's karaoke songs and publish states.",
        requires_child_selection=False,
        scenario_id="admin_karaoke_and_parents",
    ),
    _NavRule(
        href="/admin/parents",
        phrases=("quan ly phu huynh", "danh sach phu huynh", "admin/parents", "admin parents"),
        label_vi="Đi đến Quản lý Phụ huynh (Admin)",
        label_en="Go to Admin Parents",
        reason_vi="Tra cứu và quản lý thông tin tài khoản phụ huynh trong phạm vi quản trị.",
        reason_en="Search and manage parent accounts via admin controls.",
        requires_child_selection=False,
        scenario_id="admin_karaoke_and_parents",
    ),
    _NavRule(
        href="/admin/tasks",
        phrases=("tac vu admin", "tac vu he thong", "admin/tasks", "admin tasks"),
        label_vi="Đi đến Tác vụ AI Quản trị",
        label_en="Go to Admin Tasks",
        reason_vi="Theo dõi hàng đợi xử lý OCR, sách và media toàn hệ thống.",
        reason_en="Monitor system-wide OCR and media background tasks.",
        requires_child_selection=False,
        scenario_id="admin_task_center_isolation",
    ),
    _NavRule(
        href="/admin/viread-training",
        phrases=("viread-training", "viread training", "huan luyen vietocr", "flow 2", "apps script bridge", "mo hinh doc chu"),
        label_vi="Đi đến Huấn luyện VietOCR (Admin)",
        label_en="Go to OCR Training (Admin)",
        reason_vi="Quản lý dataset Flow 1/Flow 2, Apps Script Bridge và đánh giá VietOCR.",
        reason_en="Manage Flow 1/Flow 2 datasets, Apps Script Bridge, and VietOCR runs.",
        requires_child_selection=False,
        scenario_id="admin_training_health_ops",
    ),
    _NavRule(
        href="/admin/audit-logs",
        phrases=("nhat ky kiem toan", "audit logs", "admin/audit-logs", "nhat ky quan tri"),
        label_vi="Đi đến Nhật ký kiểm toán (Admin)",
        label_en="Go to Admin Audit Logs",
        reason_vi="Truy vết các thao tác quản trị và kiểm duyệt trên hệ thống.",
        reason_en="Inspect administrative audit logs.",
        requires_child_selection=False,
        scenario_id="admin_training_health_ops",
    ),
    _NavRule(
        href="/admin/health",
        phrases=("van hanh he thong", "suc khoe worker", "worker ocr", "admin/health", "admin health"),
        label_vi="Đi đến Vận hành hệ thống (Admin)",
        label_en="Go to System Health (Admin)",
        reason_vi="Kiểm tra trạng thái Database, OCR worker, Voice worker và AI providers.",
        reason_en="Check DB, OCR, Voice, and AI provider health.",
        requires_child_selection=False,
        scenario_id="admin_training_health_ops",
    ),
    _NavRule(
        href="/admin",
        phrases=("tong quan admin", "bang dieu khien admin", "admin workspace", "admin dashboard"),
        label_vi="Đi đến Bảng điều khiển Admin",
        label_en="Go to Admin Dashboard",
        reason_vi="Quay lại trang tổng quan Khu vực Quản trị ViRead.",
        reason_en="Return to the ViRead Admin workspace.",
        requires_child_selection=False,
        scenario_id="admin_overview_workspace",
    ),
    # Parent & Public nav rules
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
            "ma pin",
            "pin 4 so",
            "parent pin",
            "settings",
        ),
        label_vi="Đi đến trang Cài đặt & Bảo mật",
        label_en="Go to Password & Settings",
        reason_vi="Đổi mật khẩu, bật Khóa PIN 4 chữ số và tùy chọn bảo mật cho tài khoản của bạn.",
        reason_en="Update your password, 4-digit Parent PIN, and account settings.",
        requires_child_selection=False,
        scenario_id="account_security_and_settings",
    ),
    _NavRule(
        href="/forgot-password",
        phrases=("quen mat khau", "khoi phuc mat khau", "dat lai mat khau", "forgot password", "reset password"),
        label_vi="Đi đến trang Quên mật khẩu",
        label_en="Go to Forgot Password",
        reason_vi="Nhập email đã đăng ký để nhận liên kết đặt lại mật khẩu an toàn.",
        reason_en="Request a secure password reset link via email.",
        requires_child_selection=False,
        scenario_id="account_security_and_settings",
    ),
    _NavRule(
        href="/profile",
        phrases=("ho so ba me", "ho so phu huynh", "doi email", "so dien thoai", "parent profile"),
        label_vi="Đi đến Hồ sơ ba mẹ",
        label_en="Go to Parent Profile",
        reason_vi="Cập nhật tên hiển thị, số điện thoại và thông tin cá nhân của bạn.",
        reason_en="Manage your parent account details.",
        requires_child_selection=False,
        scenario_id="account_security_and_settings",
    ),
    _NavRule(
        href="/children/new",
        phrases=(
            "tao ho so be",
            "them ho so be",
            "them be moi",
            "3 buoc bat dau",
            "ba me moi",
            "create child",
            "add child",
            "new parent",
        ),
        label_vi="Đi đến Tạo hồ sơ bé mới",
        label_en="Go to Create Child Profile",
        reason_vi="Tạo nhanh hồ sơ đọc riêng theo tên và lớp (1–5) cho bé nhà bạn.",
        reason_en="Create a new child reading profile (Grades 1–5).",
        requires_child_selection=False,
        scenario_id="new_parent_onboarding",
    ),
    _NavRule(
        href="/children",
        phrases=(
            "ho so be",
            "danh sach be",
            "sua ho so be",
            "doi be",
            "chuyen be",
            "chon ho so be",
            "nhieu be",
            "chuyen giua cac be",
            "tai sao phai chon be",
            "chua chon be",
            "child profile",
            "children",
            "switch child",
            "select child",
            "multi child",
        ),
        label_vi="Đi đến trang Hồ sơ bé",
        label_en="Go to Child Profiles",
        reason_vi="Xem, chuyển đổi và quản lý hồ sơ các bé trong gia đình bạn.",
        reason_en="View, switch, and manage your child profiles.",
        requires_child_selection=False,
        scenario_id="child_selection_gate_and_switching",
    ),
    _NavRule(
        href="/achievements",
        phrases=(
            "vuon am vi",
            "huy hieu",
            "ho chieu doc sach",
            "ho chieu tem",
            "tem doc sach",
            "phoneme garden",
            "achievements",
            "book stamp",
        ),
        label_vi="Đi đến Vườn Âm Vị & Huy hiệu",
        label_en="Go to Phoneme Garden & Badges",
        reason_vi="Xem các bông hoa âm vị đã nở, huy hiệu và Hộ chiếu Tem Đọc Sách của bé.",
        reason_en="Explore your child's Phoneme Garden, badges, and reading passport.",
        requires_child_selection=True,
        scenario_id="achievements_phoneme_garden",
    ),
    _NavRule(
        href="/learning-train",
        phrases=(
            "chuyen tau doc",
            "chuyen tau 5 phut",
            "tau doc 5 phut",
            "luyen doc 5 phut",
            "learning train",
            "5 minute reading train",
            "five minute train",
        ),
        label_vi="Đi đến Chuyến Tàu Đọc 5 Phút",
        label_en="Go to 5-Minute Reading Train",
        reason_vi="Hoàn thành nhanh 3 toa luyện âm, nhịp điệu và ghép câu chỉ trong 5 phút.",
        reason_en="Complete today's 3-car 5-minute adaptive reading train.",
        requires_child_selection=True,
        scenario_id="five_minute_learning_train",
    ),
    _NavRule(
        href="/book-scanner",
        phrases=("quet sach", "chup trang sach", "ocr sach", "scan book", "book scanner"),
        label_vi="Đi đến Quét sách giấy AI",
        label_en="Go to AI Book Scanner",
        reason_vi="Chụp hoặc tải ảnh trang sách giấy để AI trích xuất chữ cho bé đọc.",
        reason_en="Scan printed book pages into interactive text.",
        requires_child_selection=True,
        scenario_id="quick_scan_vs_my_books",
    ),
    _NavRule(
        href="/studio/tasks",
        phrases=("tac vu ai", "tien trinh ai", "tien trinh tac vu", "hang cho ocr", "task center", "studio/tasks"),
        label_vi="Đi đến Trung tâm tác vụ AI",
        label_en="Go to AI Task Center",
        reason_vi="Theo dõi tiến trình quét sách, tạo ảnh minh họa và audio của bạn.",
        reason_en="Track your active background AI jobs.",
        requires_child_selection=False,
        scenario_id="ai_task_center",
    ),
    _NavRule(
        href="/my-books",
        phrases=("sach cua toi", "tu sach gia dinh", "smart studio", "storyweaver", "my books"),
        label_vi="Đi đến Sách của tôi",
        label_en="Go to My Books",
        reason_vi="Mở tủ sách gia đình đã quét hoặc sáng tác truyện Family StoryWeaver.",
        reason_en="Open your private scanned books & Family StoryWeaver.",
        requires_child_selection=False,
        scenario_id="quick_scan_vs_my_books",
    ),
    _NavRule(
        href="/books",
        phrases=("kho sach", "thu vien sach", "chon sach", "mo sach", "book catalog", "browse books"),
        label_vi="Đi đến Kho sách ViRead",
        label_en="Go to Books Library",
        reason_vi="Chọn sách tiếng Việt phù hợp độ tuổi và trình độ đọc của bé.",
        reason_en="Browse curated children's books.",
        requires_child_selection=True,
        scenario_id="books_and_reading_start",
    ),
    _NavRule(
        href="/entertainment/memory-game",
        phrases=("memory game", "lat the", "the ghi nho"),
        label_vi="Đi đến Memory Game lật thẻ",
        label_en="Go to Memory Game",
        reason_vi="Chơi lật cặp thẻ giúp bé ghi nhớ từ vựng và mặt chữ vui nhộn.",
        reason_en="Play the memory card matching game.",
        requires_child_selection=True,
        scenario_id="reluctant_reader_games",
    ),
    _NavRule(
        href="/entertainment/sentence-shooter",
        phrases=("ghep cau", "sentence shooter"),
        label_vi="Đi đến Trò chơi Ghép câu",
        label_en="Go to Sentence Shooter",
        reason_vi="Luyện sắp xếp từ thành câu tiếng Việt hoàn chỉnh.",
        reason_en="Practice building Vietnamese sentences.",
        requires_child_selection=True,
        scenario_id="reluctant_reader_games",
    ),
    _NavRule(
        href="/entertainment/picture-description",
        phrases=("mo ta tranh", "picture description", "ke chuyen theo tranh"),
        label_vi="Đi đến Mô tả tranh AI",
        label_en="Go to Picture Description",
        reason_vi="Cho bé nhìn tranh kể chuyện và nhận nhận xét, gợi ý từ vựng AI.",
        reason_en="Describe pictures and receive AI feedback.",
        requires_child_selection=True,
        scenario_id="reluctant_reader_games",
    ),
    _NavRule(
        href="/karaoke",
        phrases=("karaoke", "hat karaoke", "dong dao"),
        label_vi="Đi đến Karaoke thiếu nhi",
        label_en="Go to Kids Karaoke",
        reason_vi="Hát theo lời bài hát đồng dao chạy khớp nhịp để luyện phát âm.",
        reason_en="Sing along with synchronized lyrics.",
        requires_child_selection=True,
        scenario_id="reluctant_reader_games",
    ),
    _NavRule(
        href="/entertainment",
        phrases=(
            "giai tri",
            "goc giai tri",
            "tro choi",
            "be ngai doc",
            "be luoi doc",
            "be chan doc",
            "reluctant reader",
            "entertainment",
        ),
        label_vi="Đi đến Góc giải trí",
        label_en="Go to Entertainment",
        reason_vi="Khám phá Karaoke, Memory Game, Ghép câu và Mô tả tranh AI.",
        reason_en="Explore language games for kids.",
        requires_child_selection=True,
        scenario_id="reluctant_reader_games",
    ),
    _NavRule(
        href="/book-reports",
        phrases=("bao cao sach", "bao loi sach", "book reports"),
        label_vi="Đi đến Báo cáo sách",
        label_en="Go to Book Reports",
        reason_vi="Theo dõi các báo lỗi chính tả hoặc nội dung sách bạn đã gửi.",
        reason_en="Track your submitted book content reports.",
        requires_child_selection=False,
        scenario_id="reports_and_session_history",
    ),
    _NavRule(
        href="/reports/difficult-words",
        phrases=("tu can luyen", "tu doc sai", "tu doc nham", "tu kho", "hay vap tu", "difficult words"),
        label_vi="Đi đến Từ cần luyện",
        label_en="Go to Difficult Words",
        reason_vi="Xem danh sách các từ bé hay vấp để luyện đọc lại riêng.",
        reason_en="Review tricky words from your child's sessions.",
        requires_child_selection=False,
        scenario_id="slow_struggling_reader_support",
    ),
    _NavRule(
        href="/reports",
        phrases=("bao cao", "tien bo", "thong ke doc", "chung nhan", "milestone certificate", "reports", "progress"),
        label_vi="Đi đến Báo cáo tiến bộ",
        label_en="Go to Progress Reports",
        reason_vi="Xem tốc độ đọc, xu hướng tiến bộ và tải Chứng nhận cột mốc cho bé.",
        reason_en="Inspect analytics and download Milestone Certificates.",
        requires_child_selection=False,
        scenario_id="reports_and_session_history",
    ),
    _NavRule(
        href="/sessions",
        phrases=("lich su doc", "lich su buoi doc", "lich su phien doc", "session history"),
        label_vi="Đi đến Lịch sử buổi đọc",
        label_en="Go to Reading Sessions",
        reason_vi="Xem lại các buổi đọc đã hoàn thành hoặc đang tạm dừng.",
        reason_en="Review completed or paused sessions.",
        requires_child_selection=False,
        scenario_id="reports_and_session_history",
    ),
    _NavRule(
        href="/reading-management",
        phrases=(
            "quan ly doc",
            "muc tieu tuan",
            "thoi quen doc",
            "reading presence",
            "reading management",
            "weekly reading",
        ),
        label_vi="Đi đến Quản lý đọc",
        label_en="Go to Reading Management",
        reason_vi="Đặt mục tiêu đọc hàng tuần, lịch nhắc email và sách đã lưu cho bé.",
        reason_en="Set weekly goals, email reminders, and saved books.",
        requires_child_selection=False,
        scenario_id="weekly_reading_habits_and_reminders",
    ),
    _NavRule(
        href="/reading-preparation",
        phrases=(
            "chuan bi doc",
            "reading preparation",
            "quyen micro",
            "quyen thiet bi",
            "kiem tra micro",
            "khong nhan giong",
            "khong nghe",
            "micro",
            "microphone",
            "device permissions",
            "0.85x",
            "toc do doc",
            "chinh toc do",
            "be doc cham",
            "slow reader",
            "bat dau buoi doc",
            "duet reading",
            "doc doi",
        ),
        label_vi="Đi đến Chuẩn bị buổi đọc & Kiểm tra micro",
        label_en="Go to Reading Preparation & Mic Check",
        reason_vi="Chọn phạm vi trang, Đọc đôi, tốc độ đọc mẫu (kể cả 0.85x) và kiểm tra micro trước khi đọc.",
        reason_en="Configure page range, Duet mode, voice speed (including 0.85x) & mic check before reading.",
        requires_child_selection=True,
        scenario_id="reading_prep_and_mic_check",
    ),
    _NavRule(
        href="/help-support",
        phrases=("tro giup", "ho tro", "lien he", "bao loi", "gop y", "slow 3g", "mang cham", "ngoai tuyen", "help support"),
        label_vi="Đi đến Trợ giúp & Hỗ trợ",
        label_en="Go to Help & Support",
        reason_vi="Xem hướng dẫn nhanh hoặc gửi phản hồi trực tiếp cho đội ngũ ViRead.",
        reason_en="Get support or contact the ViRead team.",
        requires_child_selection=False,
        scenario_id="troubleshooting_mic_bandwidth_offline",
    ),
    _NavRule(
        href="/dashboard",
        phrases=("tong quan", "ban doc", "trang chu", "dashboard"),
        label_vi="Đi đến Bảng điều khiển Tổng quan",
        label_en="Go to Dashboard",
        reason_vi="Quay lại Bảng điều khiển chính để chọn bé và tiếp tục buổi đọc.",
        reason_en="Return to your main parent dashboard.",
        requires_child_selection=False,
        scenario_id="child_selection_gate_and_switching",
    ),
    _NavRule(
        href="/login",
        phrases=("dang nhap", "sign in", "login"),
        label_vi="Đi đến trang Đăng nhập",
        label_en="Go to Sign In",
        reason_vi="Đăng nhập vào tài khoản ViRead của bạn.",
        reason_en="Sign in to your ViRead account.",
        requires_child_selection=False,
        scenario_id="auth_login_register",
    ),
    _NavRule(
        href="/register",
        phrases=("dang ky", "tao tai khoan", "register", "sign up"),
        label_vi="Đi đến trang Đăng ký",
        label_en="Go to Register",
        reason_vi="Tạo tài khoản phụ huynh ViRead mới.",
        reason_en="Create a new ViRead parent account.",
        requires_child_selection=False,
        scenario_id="auth_login_register",
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
    if detect_off_topic_request(message, role_scope=role_scope):
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
                requires_child_selection=False,
                scenario_id="account_security_and_settings",
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
                requires_child_selection=rule.requires_child_selection,
                scenario_id=rule.scenario_id,
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
    use_en = _prefer_english(locale)

    if role_scope == "admin" and clean_path.startswith("/admin/books/"):
        if "/pages/" in clean_path:
            return (
                "Page OCR Review (Admin)" if use_en else "Duyệt OCR Trang sách (Admin)",
                (
                    "Compare Gemini, Ollama Qwen3-VL, VietOCR, PaddleOCR, and Tesseract results before marking VERIFIED."
                    if use_en
                    else "Đối chiếu kết quả Gemini, Ollama Qwen3-VL, VietOCR, PaddleOCR và Tesseract trước khi duyệt VERIFIED."
                ),
                (
                    [
                        "How do I verify an OCR revision to VERIFIED?",
                        "How do OCR scan and AI proofreading differ?",
                        "Where do I review Child Safety findings?",
                    ]
                    if use_en
                    else [
                        "Quy trình duyệt revision OCR từ NEEDS_REVIEW sang VERIFIED?",
                        "Quét OCR và AI sửa (proofreading) khác nhau thế nào?",
                        "Kiểm tra Child Safety và bản quyền ở đâu?",
                    ]
                ),
                [
                    AssistantQuickAction(
                        label="Admin Books" if use_en else "Kho sách Admin",
                        href="/admin/books",
                    ),
                    AssistantQuickAction(
                        label="Quality Hub" if use_en else "Chất lượng sách",
                        href="/admin/metadata-quality",
                    ),
                    AssistantQuickAction(
                        label="OCR Training" if use_en else "Mô hình đọc chữ",
                        href="/admin/viread-training",
                    ),
                ],
            )
        if clean_path.endswith("/edit"):
            return (
                "Edit Book Metadata (Admin)" if use_en else "Chỉnh sửa Sách (Admin)",
                (
                    "Update grade band, rights evidence, cover, and page order before final approval."
                    if use_en
                    else "Cập nhật thông tin sách, lớp, bằng chứng bản quyền và thứ tự trang trước khi phê duyệt."
                ),
                (
                    [
                        "What is required before approving a book?",
                        "How do I review page OCR revisions?",
                        "Where is Child Safety GRADE_1_TO_5 checked?",
                    ]
                    if use_en
                    else [
                        "Điều kiện để phê duyệt xuất bản một cuốn sách?",
                        "Quy trình duyệt OCR từng trang thế nào?",
                        "Kiểm tra Child Safety GRADE_1_TO_5 ở đâu?",
                    ]
                ),
                [
                    AssistantQuickAction(
                        label="Admin Books" if use_en else "Kho sách Admin",
                        href="/admin/books",
                    ),
                    AssistantQuickAction(
                        label="Quality Hub" if use_en else "Chất lượng sách",
                        href="/admin/metadata-quality",
                    ),
                ],
            )

    chosen: PageContextSpec | None = None
    for spec in PAGE_CONTEXT_SPECS:
        if role_scope not in spec.scopes:
            continue
        if _route_matches(clean_path, spec.prefix):
            chosen = spec
            break
    if chosen is None:
        if role_scope == "public":
            chosen = _DEFAULT_PUBLIC_CONTEXT
        elif role_scope == "admin":
            chosen = _DEFAULT_ADMIN_CONTEXT
        else:
            chosen = _DEFAULT_PARENT_CONTEXT

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
        if role_scope == "admin":
            reply = (
                (
                    "I'm the ViRead Admin Operations Assistant. I can help with catalog books & OCR review (/admin/books), "
                    "Child Safety & metadata quality (/admin/metadata-quality), Karaoke (/admin/karaoke), Parents (/admin/parents), "
                    "Admin Tasks (/admin/tasks), VietOCR training (/admin/viread-training), Audit Logs (/admin/audit-logs), and System Health (/admin/health)."
                )
                if use_en
                else (
                    "Tôi là Trợ lý Quản trị ViRead — có thể hỗ trợ về Kho sách & Duyệt OCR (/admin/books), "
                    "Chất lượng & Child Safety (/admin/metadata-quality), Karaoke (/admin/karaoke), Phụ huynh (/admin/parents), "
                    "Tác vụ AI (/admin/tasks), Huấn luyện VietOCR (/admin/viread-training), Nhật ký (/admin/audit-logs) và Vận hành (/admin/health)."
                )
            )
        elif role_scope == "public":
            reply = (
                (
                    "I'm the ViRead Assistant. I can explain ViRead's Vietnamese reading features for Grade 1–5 families, "
                    "help with sign-in (/login), registration (/register), password reset (/forgot-password), and mic/camera readiness."
                )
                if use_en
                else (
                    "Tôi là Trợ lý ViRead — có thể giới thiệu các tính năng luyện đọc tiếng Việt cho bé lớp 1–5, "
                    "hỗ trợ Đăng nhập (/login), Đăng ký (/register), Quên mật khẩu (/forgot-password) và chuẩn bị micro/camera."
                )
            )
        else:
            reply = (
                (
                    "I'm the ViRead Support Assistant. I can help with child profiles, graded books & Family StoryWeaver, "
                    "Book Scanner, 5-Minute Reading Train, Phoneme Garden, Duet Reading, progress reports, difficult words, reminders, and games."
                )
                if use_en
                else (
                    "Tôi là Trợ lý ViRead — có thể hướng dẫn bạn về hồ sơ bé, chọn sách & Family StoryWeaver, quét sách giấy, "
                    "Chuyến Tàu Đọc 5 Phút, Vườn Âm Vị & Huy hiệu, Đọc đôi, báo cáo tiến bộ, từ cần luyện, nhắc đọc và góc giải trí."
                )
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
        if role_scope not in art.scopes:
            continue
        content = art.short_answer_vi if bandwidth == "low" else art.detailed_answer_vi
        safe_routes = [
            action.href
            for action in art.actions
            if _is_href_allowed_for_scope(action.href, role_scope)
        ]
        routes = ", ".join(safe_routes) or ", ".join(art.route_prefixes)
        lines.append(f"[{art.id}] {art.title_vi} (routes: {routes})\n{content}")
    return "\n\n".join(lines)
