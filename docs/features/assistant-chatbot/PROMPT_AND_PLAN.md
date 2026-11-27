# Prompt Triển Khai & Kế Hoạch Kiến Trúc — Chatbot Trợ Lý ViRead Toàn Diện

Tài liệu này gồm hai phần:
1. **Prompt chuẩn** để xây dựng tính năng Chatbot Trợ lý ViRead theo đúng yêu cầu sản phẩm.
2. **Kế hoạch kỹ thuật** đã được triển khai trực tiếp trong mã nguồn ViRead (`backend` + `frontend` + `i18n` + `tests`).

---

## Phần 1: Prompt Thực Hiện Chức Năng (Engineering & Product Prompt)

```markdown
Bạn là một kỹ sư phần mềm full-stack và nhà thiết kế sản phẩm sáng tạo đang phát triển nền tảng **ViRead (ReadAlong Vision)** — ứng dụng đồng hành cùng phụ huynh và trẻ tiểu học (lớp 1–5) luyện đọc tiếng Việt với FastAPI (Python), Next.js 16 / React 19 / TypeScript, Supabase Auth/Storage, OCR đa mô hình (PaddleOCR, VietOCR, Tesseract) và AI đa tầng.

### Mục tiêu
Xây dựng **Chatbot Trợ lý ViRead** hỗ trợ người dùng giải đáp và hướng dẫn **mọi chức năng trong sản phẩm ViRead**, xuất hiện linh hoạt trên **tất cả các trang**, giao diện **nhỏ gọn — không che khuất nội dung chính**, và cho phép người dùng **ẩn hoàn toàn nếu muốn** (vẫn dễ dàng mở lại).

### Yêu cầu kiến trúc AI phân tầng & thích ứng băng tần (Speed + Accuracy + Bandwidth-Aware)
1. **Tầng 0 — Tri thức nội bộ & Bộ nhớ đệm (Tier 0 KB + Cache, < 15 ms)**:
   - Xây dựng kho tri thức chuẩn xác bám sát 100% route và tính năng thật của ViRead (đăng nhập/đăng ký, hồ sơ ba mẹ & hồ sơ bé, chọn sách & chuẩn bị đọc, buổi đọc có micro/STT/TTS, quét sách giấy & Sách của tôi / hàng chờ OCR ngoại tuyến, báo cáo tiến bộ, lịch sử phiên, ôn luyện từ khó, AI Tutor đọc hiểu, quản lý đọc & nhắc đọc qua email, góc giải trí Karaoke / Ghép câu / Mô tả tranh, quyền thiết bị, cài đặt/ngôn ngữ/hỗ trợ, và khu vực Quản trị chỉ hiển thị cho Admin).
   - Trả lời tức thì với các câu hỏi hướng dẫn trực tiếp có độ khớp cao hoặc khi người dùng đang ở băng tần thấp (`low`), đồng thời cung cấp ngữ cảnh RAG cho các tầng AI phía sau để tuyệt đối không bịa đường dẫn/chức năng.
   - Cache kết quả theo phạm vi vai trò (`public` / `parent` / `admin`), ngôn ngữ và băng tần để câu hỏi lặp lại phản hồi dưới 5 ms.
2. **Tầng 1 — Cloud LLM API tốc độ cao (Gemini Flash-Lite → Groq LPU)**:
   - Tận dụng hạ tầng `AiCapabilityRouter` với circuit breaker theo từng provider và theo `quota_group` (`gemini_free_shared`, `groq_free_shared`).
   - Ưu tiên cấu hình tốc độ cao (`thinkingLevel: MINIMAL` cho Gemini Flash-Lite, tách luồng chuyển nhanh sang Groq khi Gemini gặp 429/timeout).
   - Tự động tái sử dụng các biến môi trường sẵn có của ViRead (`GEMINI_API_KEY`, `GROQ_API_KEY`) mà không đòi hỏi cấu hình phức tạp.
3. **Tầng 2 — Ollama cục bộ làm lớp dự phòng cuối cùng (Local Ollama Fallback)**:
   - Khi Cloud API hết hạn mức, lỗi mạng, quá hạn hoặc chưa cấu hình, tự động chuyển sang Ollama loopback (`http://127.0.0.1:11434/api/chat`, kiểm tra loopback chống SSRF, tắt `think: false` để phản hồi nhanh).
   - Tự động nhận biết môi trường Cloud/Render (`local_ollama_enabled()`) để không chờ timeout vô ích nơi không cài Ollama.
4. **Tầng 3 — Dự phòng hướng dẫn chắc chắn (Deterministic Grounded Fallback) & Ngoại tuyến**:
   - Nếu mọi tầng LLM đều tạm gián đoạn, tổng hợp câu trả lời rõ ràng kèm nút điều hướng nhanh từ Kho tri thức ViRead — không bao giờ trả lỗi 500 chết màn hình.
   - Phía trình duyệt có chế độ **ngoại tuyến (Offline Quick Guide)** khi mất mạng.
5. **Thích ứng băng tần hiện tại (`low` / `medium` / `high`)**:
   - Trình duyệt tự nhận diện mạng qua `navigator.connection` (`effectiveType`, `downlink`, `saveData`) và `navigator.onLine`, đồng thời cho phép người dùng chọn chế độ `Tự động` / `Tiết kiệm` / `Đầy đủ`.
   - Băng tần thấp (`slow-2g` / `2g` / `saveData`): ưu tiên Tier 0 KB, giảm lịch sử gửi kèm (2 lượt), giới hạn token ngắn gọn (≤ 220 tokens), siết timeout để phản hồi tức thì.
   - Băng tần trung bình (`3g`): cân bằng tốc độ & độ chi tiết (4 lượt lịch sử, ≤ 360 tokens).
   - Băng tần cao (`4g` / Wi-Fi): trả lời đầy đủ giàu ngữ cảnh (6 lượt lịch sử, ≤ 520 tokens) và có nút "Hỏi AI chi tiết hơn".

### Yêu cầu UX/UI nhỏ gọn, toàn trang & có thể ẩn
- Gắn tại `RootLayout` để xuất hiện trên **mọi trang** (Auth, Parent, Reading, Admin).
- **Không bao giờ quá to**: nút mở dạng pill/icon gọn nhẹ (`40–44px`), khung chat dạng thẻ góc nhỏ gọn (`≤ 352px × 450px` trên desktop, co gọn hợp lý trên mobile), không dùng modal che màn hình (`role="complementary"`).
- **Tránh xung đột bố cục**: tự nâng vị trí phía trên `MobileBottomNav` trên di động; trên trang đọc `/reading/*` thu gọn siêu kín đáo ở góc trên-phải để không che văn bản đọc hay thanh điều khiển đọc.
- **Ẩn hoàn toàn khi người dùng muốn**: nút **Ẩn trợ lý** lưu trạng thái vào `localStorage` (đảm bảo an toàn SSR hydration), chỉ giữ một tai nhỏ mờ ở mép màn hình (và nút mở lại trong trang Trợ giúp & Hỗ trợ) để bật lại bất cứ lúc nào.
- **Gợi ý theo ngữ cảnh trang hiện tại**: tự động hiển thị 3 câu hỏi nhanh đúng trang người dùng đang mở và các liên kết điều hướng nội bộ an toàn.
- **Đa ngôn ngữ**: hỗ trợ đầy đủ 11 ngôn ngữ hiện hành của ViRead (kể cả RTL `ar`/`he`), đạt chuẩn `npm run i18n:check`.

### Yêu cầu bảo mật & kiểm thử
- Không rò rỉ API key, JWT hay thông tin nội bộ Admin cho tài khoản Phụ huynh / khách chưa đăng nhập; xác thực vai trò từ DB phía server.
- Chống prompt injection bằng rào dữ liệu (`<user_message>`), chống XSS (không dùng `dangerouslySetInnerHTML`), chống SSRF trên Ollama URL, có sliding-window rate limit theo actor/IP.
- Viết đầy đủ unit/integration test backend (`pytest`) cho đủ 4 tầng, circuit breaker, băng tần, phân quyền, rate limit và unit/hydration test frontend (`vitest`).
```

---

## Phần 2: Kiến Trúc Triển Khai Trong ViRead

### Backend (`backend/app/`)
- `app/schemas/assistant.py`: Pydantic v2 schemas cho chat request/response, quick actions (kiểm tra đường dẫn tương đối an toàn), ngữ cảnh trang và trạng thái tầng AI.
- `app/services/assistant_kb.py`: Kho tri thức ViRead toàn diện (14 chủ đề bao phủ toàn bộ Parent/Public + 3 chủ đề quản trị Admin cách ly nghiêm ngặt theo `role_scope`, cùng bản đồ ngữ cảnh chi tiết cho đầy đủ các route kể cả `/admin/login` công khai), bộ chấm điểm song song có dấu / không dấu tiếng Việt + bigram + độ phủ ý định (`direct_score`) để tránh cướp câu hỏi phức tạp sang FAQ cứng.
- `app/services/assistant_service.py`: Bộ điều phối phân tầng 4 lớp:
  - **Tier 0**: Cache + Grounded KB Fast-Path (chỉ trả lời trực tiếp khi khớp ý định cao `direct_score >= kb_direct_threshold` theo `bandwidth_profile`).
  - **Tier 1**: Cloud API qua `AiCapabilityRouter` (`gemini_primary` `gemini-3.5-flash-lite` với `thinkingLevel: MINIMAL` → `gemini_fallback` `gemini-flash-lite-latest` → `groq_qwen`, có quota-group circuit breaker).
  - **Tier 2**: Local Ollama loopback (`/api/chat`, `think: false`, ngữ cảnh RAG rút gọn top-2 & `num_ctx=2048` để chạy gọn trong VRAM với budget thích ứng băng tần).
  - **Tier 3**: Grounded deterministic KB fallback (không bao giờ sập 500).
- `app/api/routes/assistant.py` & `app/api/router.py`: Đăng ký `/assistant/chat`, `/assistant/context`, `/assistant/status` với xác thực vai trò tuỳ chọn theo DB và rate limit theo actor/IP.

### Frontend (`frontend/`)
- `types/assistant.ts`: Định nghĩa kiểu dữ liệu chặt chẽ.
- `lib/assistant/page-guides.ts`: Bản đồ hướng dẫn theo từng trang ViRead, bộ nhận diện băng tần `navigator.connection`, và bộ trả lời ngoại tuyến (offline fallback).
- `lib/api/assistant-service.ts`: Client gọi `/assistant/chat` có Zod validation, tự gắn Supabase Bearer token nếu đã đăng nhập, timeout thích ứng băng tần, tự chuyển sang offline fallback khi mất mạng.
- `components/assistant/viread-assistant-widget.tsx`: Widget Trợ lý ViRead toàn trang, nhỏ gọn, hỗ trợ ẩn hoàn toàn + lưu `localStorage` an toàn SSR hydration, chọn chế độ băng tần, hiển thị nguồn tầng & độ trễ, hỗ trợ RTL và né `MobileBottomNav` / `/reading/*`.
- `app/layout.tsx`: Gắn `<ViReadAssistantWidget />` trong `<I18nProvider>` để hiện diện ở mọi trang.
- `components/support/help-support-screen.tsx`: Thêm nút mở nhanh Trợ lý ViRead trên trang Trợ giúp & Hỗ trợ.
- `messages/*/common.json`: Bổ sung bản dịch `common.assistant.*` đầy đủ cho cả 11 ngôn ngữ (`vi`, `en`, `ar`, `de`, `es`, `fr`, `he`, `ja`, `ko`, `zh-Hans`, `zh-Hant`).
