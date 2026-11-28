# Cẩm Nang Toàn Diện Kiến Trúc & Bảo Vệ Đồ Án: ViRead (ReadAlong Vision)

> **Mục tiêu tài liệu:** Giúp người phát triển theo kiểu *vibe code* hiểu **từ gốc (first principles)** toàn bộ sản phẩm **ViRead (ReadAlong Vision)** trong `capstone1/` — từ bài toán người dùng, kiến trúc tổng thể, bảo mật/phân quyền, cơ sở dữ liệu, Frontend, Backend, AI/OCR/Voice, Mobile Android đến triển khai thực tế và hỏi - đáp bảo vệ đồ án.
>
> **Trạng thái đối chiếu mã nguồn:** Tài liệu được đối chiếu trực tiếp với nhánh Git đang checkout (`feature/android-production-overhaul`, commit `33d12e2d`) tại `f:\c1\capstone1`. Mọi tên tệp, hàm/lớp, bảng dữ liệu và API endpoint đều tồn tại thực tế trong mã nguồn. Các điểm khác biệt so với tài liệu cũ (`Agent.md`, `frontend/README.md`, `docs/PARENT_EMAIL_AUTOMATION.md`) đều được gắn cảnh báo rõ để tránh trả lời nhầm trước hội đồng.

---

## Mục Lục Nhanh

1. [Phần 1: Tổng quan sản phẩm & Bài toán](#phần-1-tổng-quan-sản-phẩm--bài-toán)
2. [Phần 2: Kiến trúc tổng thể & Bản đồ mã nguồn (`capstone1/`)](#phần-2-kiến-trúc-tổng-thể--bản-đồ-mã-nguồn-capstone1)
3. [Phần 3: Xác thực, Phân quyền (RBAC), Cơ sở dữ liệu Supabase & Lưu trữ](#phần-3-xác-thực-phân-quyền-rbac-cơ-sở-dữ-liệu-supabase--lưu-trữ)
4. [Phần 4: Frontend Web (`frontend/` — Next.js 16, React 19, TypeScript 6, Tailwind 4)](#phần-4-frontend-web-frontend--nextjs-16-react-19-typescript-6-tailwind-4)
5. [Phần 5: Backend FastAPI (`backend/` — `app.sever:app`, 21 Router + `/health`, Services & Workers)](#phần-5-backend-fastapi-backend--appseverapp-21-router--health-services--workers)
6. [Phần 6: Các luồng nghiệp vụ chính từ đầu đến cuối (End-to-End Flows)](#phần-6-các-luồng-nghiệp-vụ-chính-từ-đầu-đến-cuối-end-to-end-flows)
7. [Phần 7: Hệ thống AI, OCR, Giọng nói & Huấn luyện mô hình (`ai/` & `backend/app/services/`)](#phần-7-hệ-thống-ai-ocr-giọng-nói--huấn-luyện-mô-hình-ai--backendappservices)
8. [Phần 8: Ứng dụng Android (`android/` — Native WebView Shell & OAuth Loopback)](#phần-8-ứng-dụng-android-android--native-webview-shell--oauth-loopback)
9. [Phần 9: Triển khai (Deployment), Cron, CI/CD & Hệ thống Kiểm thử](#phần-9-triển-khai-deployment-cron-cicd--hệ-thống-kiểm-thử)
10. [Phần 10: Bộ câu hỏi & Gợi ý trả lời bảo vệ đồ án (Q&A) + Cheat Sheet 60 giây](#phần-10-bộ-câu-hỏi--gợi-ý-trả-lời-bảo-vệ-đồ-án-qa--cheat-sheet-60-giây)

---

## Phần 1: Tổng quan sản phẩm & Bài toán

### 1.1 ViRead giải quyết bài toán thực tế nào?

Ở Việt Nam, việc rèn luyện kỹ năng đọc thành tiếng cho học sinh tiểu học (**lớp 1 đến lớp 5**) thường gặp 4 rào cản lớn:
1. **Phụ huynh bận rộn hoặc không đủ thời gian kèm từng từ:** Khi trẻ đọc sách giấy ở nhà, không có người ngồi cạnh chỉ ra từ đọc sai, bỏ sót từ, hay đọc mẫu lại chuẩn tiếng Việt 3 miền / đánh vần lớp 1.
2. **Công cụ nhận diện giọng nói mặc định của trình duyệt thiếu phù hợp cho trẻ em:** `webkitSpeechRecognition` của Chrome gửi âm thanh giọng trẻ em lên máy chủ đám mây bên thứ ba, hoạt động không ổn định trong Android WebView, và không kiểm soát được tính liên tục hay quyền riêng tư giọng nói.
3. **Sách giáo khoa / sách thiếu nhi tiếng Việt rất đa dạng (có cả sách riêng của gia đình):** Nếu chỉ dùng kho sách tĩnh có sẵn thì thiếu linh hoạt; cần vừa có kho sách được kiểm duyệt chuẩn từng từ + tọa độ khung chữ (`bounding box`), vừa cho phép phụ huynh tải sách riêng lên hoặc đưa trang sách giấy vào trước camera để hệ thống tự nhận ra đúng trang đang đọc.
4. **Dữ liệu tiến độ học tập thường rời rạc:** Phụ huynh cần biết chính xác bé đọc đúng bao nhiêu từ ngay lần đầu (*first-pass*), bé tự sửa được bao nhiêu từ sau khi thử lại (*self-corrected*), từ nào lặp lỗi nhiều để ôn tập 90 ngày, chứ không chỉ một điểm số mơ hồ do AI đoán.

**ViRead (ReadAlong Vision)** là nền tảng đồng hành luyện đọc tiếng Việt ứng dụng AI và thị giác máy tính: bé đọc thành tiếng trên điện thoại/máy tính (từ kho sách chuẩn, sách riêng của gia đình hoặc quét trang sách giấy qua camera), hệ thống đối chiếu từng từ theo thời gian thực, hỗ trợ đọc mẫu/đánh vần, nhắc nhở khi vắng mặt, cung cấp trò chơi luyện câu/tả tranh/karaoke và tổng hợp báo cáo tiến độ dựa trên bằng chứng cho phụ huynh.

### 1.2 Ba vai trò chính & Kịch bản sử dụng cốt lõi

Hệ thống phân chia rõ 3 đối tượng người dùng trong mô hình dữ liệu và giao diện:

| Vai trò | Cách định danh trong DB | Kịch bản sử dụng cốt lõi |
|---|---|---|
| **Phụ huynh (`parent`)** | Bảng `profiles` (`Role = 'parent'`, `Active = 1`), đăng nhập qua Supabase Auth | Quản lý hồ sơ các bé (`childprofiles`), chọn sách từ thư viện hoặc tải **Sách của tôi** (`my-books`), thiết lập kế hoạch/mục tiêu/lịch nhắc đọc, cấu hình thông báo email tự động & cảnh báo rời khung hình, xem báo cáo tiến độ, lịch sử phiên đọc và danh sách từ khó. |
| **Bé / Học sinh tiểu học (`child`)** | Bảng `childprofiles` (gắn với `ParentId`, không có tài khoản đăng nhập riêng; phụ huynh chọn `selectedChildId` trên bàn làm việc gia đình) | Quét trang sách giấy bằng camera (`/book-scanner`), kiểm tra mic (`/reading-preparation`), đọc thành tiếng từng trang (`/reading/[sessionId]`), nghe đọc mẫu / đánh vần lớp 1, thử đọc lại từ sai (`WORD_RETRY`), trả lời câu hỏi đọc hiểu cuối buổi, luyện từ khó, chơi **Xạ thủ ghép câu**, **Kể chuyện qua tranh** và hát **Karaoke**. |
| **Quản trị viên (`admin`)** | Bảng `profiles` (`Role = 'admin'`, `Active = 1`) | Quản lý danh mục phụ huynh, tạo sách và tải lên ảnh/PDF/DOCX, chạy OCR song song (Dual-Engine), chỉnh sửa chính tả từng từ, chạy quy trình AI sửa lỗi & kiểm duyệt an toàn trẻ em (lớp 1–5), kiểm tra chất lượng/bản quyền/báo lỗi sách, kiểm duyệt sách riêng của phụ huynh, quản lý bài hát Karaoke, và vận hành vòng đời huấn luyện mô hình **ViOCR V2** (Flow 1 & Flow 2). |

---

## Phần 2: Kiến trúc tổng thể & Bản đồ mã nguồn (`capstone1/`)

### 2.1 Giải thích từ gốc cho người làm *vibe code*: Tại sao không nhét tất cả vào một chỗ?

Nếu bạn từng nhờ AI sinh nhanh một trang web chỉ có React gọi thẳng Database, có thể bạn sẽ thắc mắc: *Tại sao ViRead lại tách ra tới 5 khối: Frontend Next.js, Backend FastAPI, Supabase PostgreSQL/Storage, Local AI Workers và Android Native Shell?* Câu trả lời nằm ở **giới hạn vật lý và bảo mật**:

1. **Frontend SSR (Next.js 16) vs Trình duyệt thuần (SPA):**
   - Trong Next.js App Router, một phần mã chạy **trên máy chủ Node.js (Server Component / Proxy / Route Handler)** trước khi gửi HTML về trình duyệt, phần còn lại (`"use client"`) chạy **trong trình duyệt người dùng**.
   - Việc kiểm tra quyền (`parent` hay `admin`) ở server (`frontend/proxy.ts` và `frontend/lib/auth/server-authorization.ts`) đảm bảo người dùng không thể sửa JavaScript trong DevTools để vào trang Admin.
2. **Backend API (FastAPI - Python):**
   - Trình duyệt (JavaScript) không thể chạy trực tiếp PaddleOCR, VietOCR, OpenCV hay giữ các khóa bí mật (`SUPABASE_SECRET_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `RESEND_API_KEY`).
   - Python FastAPI đóng vai trò "bộ não nghiệp vụ trung tâm": nhận JWT từ Frontend, hỏi PostgreSQL xác nhận quyền, điều phối AI/OCR/TTS/STT, ký URL ảnh tạm thời (signed URL) và ghi dữ liệu chuẩn xác.
3. **Database & Storage (Supabase PostgreSQL + Auth + Private Storage):**
   - PostgreSQL lưu toàn bộ dữ liệu có cấu trúc (hồ sơ, sách, từng từ kèm tọa độ, phiên đọc, báo cáo đối chiếu, hàng đợi job).
   - Storage lưu tệp nhị phân nặng (ảnh trang sách, PDF/DOCX, ảnh đại diện, nhạc karaoke) trong các **bucket riêng tư (private)** — DB chỉ giữ đường dẫn tương đối.
4. **AI Workers tách tiến trình (`voice_worker.py`, `colab_worker.py`, `karaoke_processing`):**
   - Các thư viện AI rất xung đột phiên bản với nhau. Ví dụ: `PaddlePaddle 2.6.2` bắt buộc `numpy==1.26.4` và `protobuf==3.20.2`, trong khi Sherpa-ONNX / VieNeu-TTS hoặc Demucs cần môi trường Python khác. Tách thành worker riêng giao tiếp qua loopback HTTP/WebSocket (`127.0.0.1:8010`) hoặc stdin/stdout JSON giúp không bao giờ làm sập Backend OCR.
5. **Android Native WebView Shell (`android/`):**
   - Thay vì đóng gói tĩnh Frontend vào APK (làm mất SSR và phá vỡ cơ chế cookie xác thực của Next.js 16), app Android đóng vai trò "vỏ trình duyệt thông minh": bọc trang web HTTPS thật, xử lý màn hình chờ khi server miễn phí ngủ đông (cold start), mở camera native và làm cầu nối đăng nhập Google/Facebook không bị Google chặn (`403 disallowed_useragent`).

### 2.2 Sơ đồ kiến trúc tổng thể

```text
+-------------------------------------------------------------------------+
|                        NGƯỜI DÙNG (Bé / Phụ huynh / Admin)              |
+-----------------------+-----------------------------+-------------------+
                        |                             |
          Trình duyệt Web (Desktop/Mobile)   Android App (vn.viread.android)
                        |                    Native Java WebView + Loopback OAuth
                        +--------------+--------------+
                                       | HTTPS (Cookies SSR + PKCE)
                                       v
+-------------------------------------------------------------------------+
|            FRONTEND WEB (Vercel Hobby — region sin1 / Next.js 16)       |
|  - proxy.ts (refresh cookie) & server-authorization.ts (check DB role)  |
|  - App Router: Public Auth | Parent (app) | Admin (protected)           |
|  - API Client (Zod validation + Authorization: Bearer JWT)              |
|  - Cron Proxy: /api/cron/parent-emails (02:00 UTC -> Render)            |
+-----------------------+-----------------------------+-------------------+
                        |                             |
     Supabase Auth/PKCE |                             | REST & WebSocket (JSON/Audio)
                        v                             v
+---------------------------------+   +-----------------------------------+
|      SUPABASE PLATFORM          |   |   BACKEND API (Render Free / Local)|
|  - Auth (PKCE, Email, OAuth)    |<->|   FastAPI: backend/app/sever.py   |
|  - PostgreSQL + 39 SQL Migrations|   |   - 21 Router modules tại root "" |
|  - Supavisor Pooler (port 6543) |   |   - + GET /health                 |
|  - 4 Private Storage Buckets    |   |   - 6 asyncio workers + 1 thread  |
+---------------------------------+   +-----+-----------------------+-----+
                                            |                       |
                     +----------------------+                       |
                     v                                              v
+-----------------------------------------+   +-----------------------------------+
|  AI & VOICE LOCAL / ISOLATED WORKERS    |   |  CLOUD AI, EMAIL & COLAB TRAINING |
|  - OCR Engine: PaddleOCR + VietOCR +    |   |  - LLM: Gemini -> Groq -> Ollama  |
|    Tesseract fallback (lazy import)     |   |  - Voice Backup: Google Cloud     |
|  - Voice Worker (127.0.0.1:8010):       |   |  - Email: Resend HTTPS / Gmail    |
|    Sherpa-ONNX STT + VieNeu-TTS v3 Turbo|   |  - Training ViOCR V2: Colab GPU   |
|  - Ollama Local (127.0.0.1:11434)       |   |    + Apps Script / Drive Bridge   |
|  - ORB Page Matcher (OpenCV)            |   |    + GCP Vertex AI (Enterprise)   |
+-----------------------------------------+   +-----------------------------------+
```

### 2.3 Bản đồ thư mục chính của `capstone1/`

```text
f:\c1\capstone1\
├── ai/                         # Pipeline AI lõi độc lập:
│   ├── vietocr_v2/             # Huấn luyện ViOCR V2 (Flow 1 TRDG, Flow 2 Admin, colab_worker.py, quality_gate.py)
│   ├── vision/page_matcher.py  # Nhận diện trang sách qua camera bằng OpenCV ORB + RANSAC
│   ├── karaoke_processing/     # Nghiên cứu tách nhạc Demucs + căn lời CTC (mặc định tắt)
│   └── (8 thư mục giữ chỗ .gitkeep) # alignment/, comprehension/, confidence_gate/, events/, fluency/, ocr/, speech/, tutor/ — mã thực tế nằm tại backend/app/services/
├── android/                    # Ứng dụng Android Native WebView Shell (Java/Gradle, vn.viread.android)
├── backend/                    # API FastAPI chính:
│   ├── app/
│   │   ├── sever.py            # Entrypoint FastAPI (chú ý chính tả: sever.py, app.sever:app)
│   │   ├── api/                # deps.py (Auth/RBAC), router.py, routes/ (21 route modules)
│   │   ├── assets/             # 3 ảnh mẫu picture_description/*.jpg gửi kèm prompt AI
│   │   ├── core/               # karaoke_processing_config.py (cấu hình worker tách nhạc/CTC độc lập)
│   │   ├── database/           # config.py, session.py (Supavisor 6543, NullPool, Limiter), supabase_client.py
│   │   ├── jobs/               # 10 module background workers
│   │   ├── models/             # SQLAlchemy ORM models (17 model files + __init__.py = 18 files)
│   │   ├── policies/           # book_access.py, book_approval.py
│   │   ├── providers/          # Adapters: Google/Local/ElevenLabs Voice, Resend/SMTP Email, Karaoke
│   │   ├── repositories/       # Truy vấn DB qua ORM (25 repository files + .gitkeep)
│   │   ├── schemas/            # Pydantic V2 request/response schemas
│   │   └── services/           # Business logic, OCR, VoiceOrchestrator, LLM chains, Metrics
│   ├── scripts/                # run_ci_tests.py, run_real_ocr_gate.py, seed/check scripts
│   └── requirements.txt        # Khóa ABI (numpy==1.26.4, protobuf==3.20.2, opencv-headless==4.10.0.84)
├── cloud/
│   └── colab-enterprise-dispatcher/  # Cloud Run container tùy chọn gọi Vertex AI (mặc định manual)
├── docs/                       # Tài liệu kỹ thuật chuyên sâu (deployment, email, OCR, training, Android...)
├── frontend/                   # Ứng dụng Web Next.js 16 (App Router, React 19, TypeScript 6, Tailwind 4)
│   ├── app/                    # Trang Public, (app) Parent, admin/(protected), api/cron, auth/callback
│   ├── components/             # UI components, Providers, ReadingScreen, CameraPreview...
│   ├── hooks/                  # React hooks (useSpeechRecorder, useSpeechPlayer, useReadingPresence...)
│   ├── lib/                    # api/ (typed Zod clients), auth/, reading/, supabase/
│   └── scripts/                # verify-hosting-env.mjs (chặn cấu hình sai trước khi build Vercel)
├── project-dashboard/          # Hub tĩnh GitHub Pages (xây hub-snapshot.json từ GitHub Issues p1–p14, 3 test *.test.cjs)
├── scripts/                    # Công cụ vận hành: windows/voice_worker.py, lan-https-proxy.mjs,
│                               # Run-ViReadUsbE2E.mjs, google-apps-script/viread_flow2_drive_bridge.gs
├── supabase/
│   ├── migrations/             # 39 file .sql migration tuần tự (+ .gitkeep)
│   ├── rollbacks/              # 20261120140000_reading_query_indexes_cleanup_rollback.sql (rollback thủ công)
│   ├── seed/                   # Chỉ chứa .gitkeep (seed script nằm ở backend/scripts/ & scripts/windows/)
│   └── tests/                  # SQL test bảo mật & index hiệu năng (disposable DB)
├── tests/                      # Bộ fixture OCR tổng hợp (fixtures/ocr/: generate_fixtures.py + manifest.json + 14 ảnh dev/holdout) & api/apiTesting.py (legacy)
├── .github/workflows/          # 12 quy trình CI/CD tự động & Render keep-alive
└── requirements.ps1 / start-dev.ps1 / requirements.txt  # Script cài đặt & khởi chạy nhanh trên Windows
```

> **Lưu ý quan trọng:** Trong `capstone1/` **không có** thư mục `mobile/` hay dự án Expo/React Native; toàn bộ ứng dụng di động nằm tại `capstone1/android/`.

### 2.4 Chuẩn phân tầng Backend (`BACKEND_FLOW_STANDARD.md`)

Backend tuân theo kiến trúc phân lớp rõ ràng để mã nguồn dễ bảo trì và không trộn lẫn SQL với HTTP:

```text
HTTP Request
  → Router (app/api/routes/)        # Định nghĩa URL, nhận input, chọn HTTP status
  → Schema (app/schemas/)           # Kiểm tra kiểu dữ liệu đầu vào (Pydantic V2)
  → Service (app/services/)         # Quy tắc nghiệp vụ, phân quyền sở hữu, điều phối
  → Repository (app/repositories/)  # Mọi câu truy vấn ORM / CRUD / pagination
  → Model / ORM (app/models/)       # Ánh xạ bảng PostgreSQL
  → PostgreSQL (Supabase)
```

Ngoài 5 lớp chính còn có 3 lớp hỗ trợ:
- **`app/policies/`**: Luật kiểm tra quyền truy cập và điều kiện duyệt sách (`book_access.py`, `book_approval.py`).
- **`app/providers/`**: Lớp giao tiếp dịch vụ ngoài (Local Voice Worker, Google Voice, ElevenLabs legacy, Resend/SMTP Email, Supabase Auth contact).
- **`app/jobs/`**: 10 module chạy nền định kỳ (xử lý hàng đợi AI, quét chất lượng sách, gửi email phụ huynh, outbox huấn luyện OCR).

*(Ngoại lệ có chủ đích được ghi nhận trong codebase: `backend/app/api/routes/system.py` đặt một số lớp repository/service legacy như `LegacyReportRepository`, `ProgressRepository`, `ProgressService`, `AdminSystemRepository`, `AdminSystemService` ngay trong file route để phục vụ các endpoint `/system/*`.)*

### 2.5 Cảnh báo sai lệch nhánh & tài liệu cũ (Bắt buộc đọc trước khi thuyết trình)

Trong kho mã nguồn có một số tài liệu cũ viết từ nhánh khác (`tu` hoặc `origin/main`). Trên nhánh hiện tại (`feature/android-production-overhaul`, commit `33d12e2d`), bạn cần nắm **5 điểm khác biệt thực tế** sau để không trả lời sai nếu giảng viên lật lại các file cũ:

1. **Entrypoint Backend viết là `sever.py` (không phải `server.py`):** Tệp là `backend/app/sever.py` -> lệnh chạy ASGI là `app.sever:app`. Đây là quy tắc cố định được `backend/AGENTS.md` và mọi workflow giữ nguyên để không gãy import.
2. **Không có prefix `/api/v1` và không có `/internal/cron/dispatch` trên nhánh này:**
   - Tài liệu `docs/PARENT_EMAIL_AUTOMATION.md` và ghi chú trong `GEMINI.md` nhắc tới `/api/v1/...`, `/internal/cron/dispatch`, `render.yaml`, `infra/cloudflare-cron`.
   - **Thực tế trên nhánh hiện tại:** `backend/app/api/router.py` gắn toàn bộ `api_router` thẳng tại **root `""`**; route cron thực tế là **`POST /parent-notifications/cron/dispatch`** (`backend/app/api/routes/parent_notifications.py`); và các file `render.yaml`, `Procfile`, thư mục `infra/` **không tồn tại** trên nhánh này.
3. **Frontend không còn chạy dữ liệu giả (mock-only):** `frontend/README.md` (dòng 278–291) là mô tả lịch sử từ giai đoạn đầu nói rằng Backend/OCR/Voice chưa kết nối. **Thực tế hiện tại:** `AppServicesProvider` và `AdminServicesProvider` khởi tạo toàn bộ service gọi API thật tới FastAPI và xác thực dữ liệu bằng Zod. Duy nhất `frontend/lib/api/reading-socket-adapter.ts` là adapter quản lý trạng thái phía client (không mở WebSocket đọc sách riêng), vì phiên đọc thực tế giao tiếp qua các endpoint HTTP REST của `/reading/*` và `/voice/*`.
4. **Voice mặc định đã chuyển sang Local-First:** `Agent.md` (được đánh dấu *LEGACY / HISTORICAL HANDOVER*) mô tả ElevenLabs là nhà cung cấp giọng nói chính. **Thực tế hiện tại:** hệ thống dùng **`VoiceOrchestrator`** (`local_only` mặc định qua `127.0.0.1:8010` với Sherpa-ONNX + VieNeu-TTS v3 Turbo), tùy chọn dự phòng sang Google Cloud (`GoogleCloudVoiceProvider`) khi lỗi kỹ thuật; `ElevenLabsVoiceProvider` chỉ còn là lớp kế thừa `VoiceProviderError` ở dạng legacy.
5. **Sandbox & 15 báo cáo lịch sử không phải mã production:** Tệp `tests/api/apiTesting.py` (script thử nghiệm sơ khai gắn `prefix="/api"`) cùng 15 file báo cáo lưu vết các giai đoạn ở thư mục gốc (`read.md`, `CODEX_SETUP_REPORT.md`, `KARAOKE_*.md`, `READING_HISTORY_*.md`, `READING_PROGRESS_*.md`, `REAL_DATA_PHASE1_PLAN.md`–`PHASE6_REPORT.md`) là tài liệu/sandbox lịch sử, không tham gia chạy CI hay production.

---

## Phần 3: Xác thực, Phân quyền (RBAC), Cơ sở dữ liệu Supabase & Lưu trữ

### 3.1 Giải thích từ gốc: JWT, PKCE, Cookie SSR vs Bearer Token & RBAC từ DB

1. **JWT (JSON Web Token) là gì?** Giống như "thẻ ra vào có con dấu mật mã". Khi bạn đăng nhập qua Supabase Auth, Supabase cấp cho bạn một chuỗi JWT ký bằng khóa bí mật của Supabase. Backend có thể kiểm chứng thẻ này có thật hay bị giả mạo.
2. **Tại sao dùng OAuth PKCE (Proof Key for Code Exchange)?** Khi đăng nhập Google/Facebook, trình duyệt chuyển sang trang Google rồi quay về `/auth/callback?code=...`. Kẻ xấu có thể nghe lén `code` trên đường truyền, nhưng với PKCE, trình duyệt tạo một chuỗi bí mật ngẫu nhiên (`code_verifier` lưu trong cookie) từ đầu; chỉ trình duyệt nào giữ đúng `code_verifier` mới đổi được `code` lấy phiên đăng nhập thật (`exchangeCodeForSession`).
3. **Cookie SSR vs Bearer Token:**
   - **Next.js Server (SSR)** đọc phiên đăng nhập từ **HTTP Cookies** do `@supabase/ssr` quản lý để quyết định cho phép mở trang `/dashboard` hay `/admin/books` ngay trên server.
   - **API Client gọi sang FastAPI (`api-client.ts`)** lấy `access_token` (JWT) từ phiên Supabase trình duyệt và gắn vào header `Authorization: Bearer <token>`, kèm `credentials: "omit"` (không gửi cookie chéo miền) để gọi Backend trên Render.
4. **Tại sao RBAC bắt buộc tra `public.profiles` trong DB chứ không tin `user_metadata`?**
   - Trong Supabase, `user_metadata` có thể bị sửa đổi bởi một số luồng client hoặc bị lệch với trạng thái khóa tài khoản.
   - Vì thế cả Frontend (`server-authorization.ts`) lẫn Backend (`deps.py`) đều chỉ lấy **ID người dùng (`sub`)** từ JWT, rồi truy vấn thẳng bảng `public.profiles` để kiểm tra `Role` (`parent` | `admin`) và `Active == 1`. Nếu tài khoản bị vô hiệu hóa (`Active != 1`), mọi request đều bị chặn ngay lập tức.

### 3.2 Luồng xác thực & phân quyền chi tiết (Frontend + Backend)

1. **Lớp biên Next.js 16 (`frontend/proxy.ts` → `frontend/lib/supabase/proxy.ts`):**
   - Next.js 16 dùng hàm `proxy()` (thay cho `middleware.ts` cũ).
   - Mọi request trang web đi qua `proxy()`, làm mới token/cookie qua `supabase.auth.getClaims()` và đối chiếu đường dẫn qua `getProtectedRouteArea(pathname)` (`frontend/lib/auth/route-policy.ts`: `/admin/**` trừ `/admin/login` thuộc vùng `"admin"`, 17 tiền tố như `/dashboard`, `/books`, `/reading`, `/reports`, `/karaoke`... thuộc vùng `"parent"`).
   - Khi test tự động Playwright ở môi trường không phải production, `readPlaywrightAuthFixture(request.headers)` (`frontend/lib/auth/playwright-auth-fixture.ts`) chỉ chấp nhận token giả lập nếu `NODE_ENV !== "production"`, `PLAYWRIGHT_AUTH_FIXTURES === "1"` và token dài >= 32 ký tự khớp bằng so sánh hằng thời gian (*constant-time*).
2. **Bảo vệ ở Server Layout (`frontend/lib/auth/server-authorization.ts`):**
   - `getAppIdentity()` (được bọc React `cache`) gọi `supabase.auth.getClaims()` lấy `sub`, rồi truy vấn `public.profiles` (`select("role, active")`).
   - `requireAppRole("parent")` trong `app/(app)/layout.tsx` và `app/sessions/[sessionId]/report/layout.tsx`, hay `requireAppRole("admin")` trong `app/admin/(protected)/layout.tsx`: nếu chưa đăng nhập sẽ chuyển về `/login` hoặc `/admin/login`; nếu sai vai trò (ví dụ phụ huynh cố vào `/admin/...`) sẽ đẩy về trang chủ đúng vai trò (`getRoleHome(identity.role)`).
3. **Đổi mật khẩu an toàn (`frontend/lib/supabase/auth-service.ts`, triển khai interface `AuthService` từ `frontend/lib/api/auth-service.ts`):**
   - Hàm `changePassword` tạo một client cô lập không lưu phiên (`createIsolatedReauthenticationClient`) để xác minh lại mật khẩu cũ trước khi đổi, tránh làm ghi đè hoặc mất phiên đăng nhập đang mở của người dùng.
4. **Xử lý OAuth Callback (`frontend/app/auth/callback/route.ts`):**
   - Đổi `code` lấy phiên bằng `exchangeCodeForSession`, kiểm tra email hợp lệ, kiểm tra trạng thái `profiles.active` và điều hướng theo `profiles.role` (`parent` → `/dashboard`, `admin` → `/admin/books`). Nếu phát hiện tham số `app_shell=android`, chuyển hướng về deep link `viread://auth/callback`.
5. **Xác thực trên FastAPI (`backend/app/api/deps.py`):**
   - `get_current_parent_id()`: Tách Bearer token từ header `Authorization`, kiểm tra bộ nhớ đệm 45 giây theo băm SHA-256 (`0s` trong môi trường test), gọi `supabase.auth.get_user(token)` (thử lại tối đa 3 lần nếu lỗi socket tạm thời như `RemoteProtocolError`, `ConnectError`) để lấy `UUID(response.user.id)`.
   - `_require_database_role()`: Truy vấn PostgreSQL kiểm tra `Profile.Role == required_role` và `Profile.Active == 1`. Hai dependency phổ biến nhất là `require_parent_id` (`"parent"`) và `require_admin_id` (`"admin"`).

### 3.3 Supavisor Transaction Pooler cổng `6543` & Kiểm soát đồng thời DB

Đây là phần kỹ thuật quan trọng giúp Backend trên **Render Free** nói chuyện ổn định với **Supabase PostgreSQL**:

1. **Tại sao phải dùng cổng `6543` (Supavisor Transaction Pooler) thay vì Direct Connection (`5432`)?**
   - Render Free chỉ hỗ trợ kết nối ra ngoài qua **IPv4**, trong khi endpoint kết nối trực tiếp (`5432`) của Supabase mặc định phân giải ra IPv6 (hoặc dễ cạn kết nối). Cổng `6543` đi qua **Supavisor** hỗ trợ IPv4 và ghép hàng trăm request dùng chung ít kết nối Postgres thật.
   - Trong `backend/app/database/config.py`: Khi `APP_ENVIRONMENT=production`, hệ thống bắt buộc `DATABASE_POOLER_MODE=transaction`, cổng **`6543`**, `DATABASE_SSL_REQUIRED=true` và chứng chỉ CA tại `DATABASE_SSL_ROOT_CERT` (ví dụ `/etc/secrets/supabase-root.crt` trên Render).
2. **Tại sao phải tắt Prepared Statement Cache (`statement_cache_size=0`) & dùng `NullPool`?**
   - Ở chế độ *transaction pooling*, hai câu SQL liên tiếp của cùng một API có thể được Supavisor gán cho hai kết nối Postgres vật lý khác nhau. Nếu driver `asyncpg` giữ cache câu lệnh chuẩn bị sẵn (*prepared statement*) gắn trên kết nối cũ, Postgres sẽ báo lỗi không tìm thấy statement.
   - Vì thế `backend/app/database/session.py` tắt cache ở **cả hai nơi**: `prepared_statement_cache_size=0` trong URL và `statement_cache_size=0` trong `asyncpg_connect_args`.
   - Trong chế độ `test`, test runner CLI (`pytest`/`unittest`) hoặc DB loopback local, `session.py` dùng `NullPool` (không giữ pool kết nối cũ giữa các event loop); trong môi trường khác dùng `QueuePool` giới hạn nhỏ (`pool_size = max(2, min(limit, 4))`, `pool_recycle = 300`, `pool_pre_ping = True`).
3. **Cơ chế `ConcurrencyLimitedAsyncSession` & `DatabaseConcurrencyLimiter` (`backend/app/database/session.py`):**
   - Giới hạn mặc định `DATABASE_CONCURRENCY_LIMIT = 8` (thời gian chờ tối đa `5.0s`).
   - Điểm thông minh: Session chỉ **chiếm 1 slot (permit)** tại thời điểm thực thi câu SQL đầu tiên và **nhả slot ngay** khi `commit()`, `rollback()` hoặc `close()`. Nhờ vậy khi API đang bận gọi OCR, Upload Storage hay gọi LLM ngoài mạng, nó **không giữ khăng khăng kết nối DB**. Nếu quá tải, `sever.py` trả lỗi chuẩn HTTP `503` (`"Database temporarily unavailable"` kèm `request_id`).
4. **Tại sao CẤM `pg_try_advisory_lock` mức session và dùng khóa hàng nguyên tử?**
   - Advisory lock mức session gắn vào một kết nối vật lý; qua Supavisor `6543`, kết nối đó có thể bị tráo giữa các transaction khiến khóa không bao giờ được nhả hoặc bị mở nhầm.
   - Giải pháp chuẩn trong dự án: Dùng khóa nguyên tử ngay trong một transaction: **`FOR UPDATE SKIP LOCKED`** (khi worker/cron tranh nhau nhận việc ở `readingreminderoccurrences`, `readingpresencealerts`, `viread_ocr_outbox`, `viread_ocr_training_jobs`) và **`ON CONFLICT (...) DO NOTHING`** (chống gửi trùng email ở `parentemaildeliveries`).

### 3.4 Toàn cảnh Cơ sở dữ liệu PostgreSQL (Core + 39 SQL Migrations) & 4 Storage Buckets

Các bảng trong Supabase được định nghĩa qua schema lõi (`backend/app/models/*.py`) kết hợp **39 tệp `.sql` migration** (cùng 1 `.gitkeep`, tổng 40 mục) trong `supabase/migrations/`, chia thành 8 nhóm chính:

| Nhóm dữ liệu | Các bảng tiêu biểu | Vai trò trong hệ thống |
|---|---|---|
| **1. Người dùng & Hồ sơ** | `profiles`, `childprofiles`, `consentrecords`, `auditlogs` | Quản lý phụ huynh/admin (`Role`, `Active`), hồ sơ từng bé (`Alias`, `Grade`, `Settings`, `AvatarPath`), ghi nhận đồng ý và nhật ký kiểm toán hành động Admin. |
| **2. Kho sách & Số hóa OCR** | `books`, `bookpages`, `pagerevisions`, `pagerevisionwords`, `adminaiworkflows` | Lưu siêu dữ liệu sách (`MinGrade`, `MaxGrade`, `VisibilityScope`), từng trang sách (`ImagePath`, `FeaturePath`), các phiên bản văn bản (`OriginalOcrText`, `DraftText`, `VerifiedText`, `ContentHash`) và danh sách từng từ kèm tọa độ `BoundingBox` chuẩn hóa `[x, y, w, h]`. |
| **3. Phiên đọc, Đối chiếu & Tiến độ** | `readingsessions`, `readingsessionpages`, `readingevents`, `readingcomparisonreports`, `fluencyassessments`, `comprehensionquestions`, `comprehensionanswers`, `progressreports` | Lưu phiên đọc từng trang, sự kiện đọc lại/nghe mẫu (`WORD_RETRY`, `READ_EXAMPLE`), báo cáo so sánh Levenshtein (`Summary` JSON chứa `assessment_version=1` + `initial_assessment`), câu hỏi đọc hiểu. *(Lưu ý: `fluencyassessments` là bảng cũ, ngoài thực tế gần như không có dữ liệu).* |
| **4. Quản lý đọc & Tự động hóa Email** | `readinggoals`, `readingplans`, `childbookcollections`, `readingreminders`, `readingreminderoccurrences`, `readingpresencesettings`, `readingpresencealerts`, `parentemailpreferences`, `parentemaildeliveries` | Lưu mục tiêu đọc, kế hoạch tuần, bộ sưu tập sách của bé, lịch nhắc đọc & từng lần nhắc, cài đặt/cảnh báo vắng khung hình, tùy chọn email và lịch sử gửi email có khóa `UNIQUE(dedupekey)`. |
| **5. Trò chơi & Luyện từ khó** | `gamesessions`, `gamerounds`, `gameattempts` (Sentence Shooter), `picturedescriptionsessions`, `picturedescriptionattempts` (Picture Description), `difficult_word_practice_attempts` | Lưu tiến trình và kết quả chấm điểm các trò chơi ghép câu, mô tả tranh bằng AI và lịch sử luyện đọc lại các từ khó trong vòng 90 ngày. |
| **6. Karaoke** | `karaoke_songs`, `karaoke_song_versions`, `karaoke_processing_jobs`, `karaoke_processing_operations` | Quản lý bài hát, bản nháp/bản phát hành lời theo từng âm tiết và hàng đợi xử lý tách nhạc/căn lời tự động. |
| **7. Sách riêng phụ huynh & Kiểm duyệt** | `parent_book_page_submissions`, `parent_book_moderation_requests`, `parent_book_ocr_contribution_consents`, `parent_book_ocr_contribution_consent_events`, `parent_book_flow2_candidates`, `bookcontentreports`, `bookcontentreporthistory`, `bookqualityscanruns`, `bookqualitypagescans`, `bookqualityfindings`, `bookqualityreportfindings`, `bookrightsevidences`, `bookrightsevidencehistory` | Cách ly sách riêng (`VisibilityScope='PARENT_PRIVATE'`, `OwnerParentId`), hàng đợi duyệt trang ảnh, đồng thuận đóng góp dữ liệu OCR Flow 2 của phụ huynh, báo lỗi nội dung sách và rà soát bản quyền/chất lượng. |
| **8. Huấn luyện ViOCR V2** | `viread_ocr_outbox`, `viread_ocr_samples`, `viread_ocr_dataset_versions`, `viread_ocr_training_runs`, `viread_ocr_checkpoint_chunks`, `viread_ocr_benchmarks`, `viread_ocr_model_decisions`, `viread_ocr_active_model`, `viread_ocr_training_jobs`, `viread_ocr_evaluation_cohorts`, `viread_ocr_drive_connections` | Hàng đợi outbox bền vững, kho mẫu chữ đã duyệt, phiên bản dataset, log chạy huấn luyện trên Colab/GCP, mảnh checkpoint, kết quả benchmark Locked Test, quyết định duyệt/kích hoạt mô hình đang chạy (`active_model`) và kết nối Google Drive. |

**Triggers & Bảo mật DB (`supabase/migrations/20261120100000_supabase_security_hardening.sql` và các migration liên quan):**
- Các hàm DB trọng yếu: `public.handle_new_readalong_user()` (tự tạo dòng `profiles` vai trò mặc định `'parent'` khi `auth.users` có người dùng mới qua trigger `on_auth_user_created_readalong`), `public.rls_auto_enable()` *(hàm event trigger do Supabase quản lý sẵn, được siết quyền thực thi trong `20261120100000_supabase_security_hardening.sql`)*, `public.sync_profile_role_to_auth_metadata()`, `public.karaoke_processing_preserve_snapshot()`, `public.prevent_private_book_catalog_promotion()` (chặn nâng quyền sách riêng thành sách công khai sai quy trình), `public.validate_parent_ocr_consent_book()`.
- **Chống leo thang đặc quyền (`supabase_security_hardening.sql`):** Thu hồi quyền `EXECUTE` trên các hàm `SECURITY DEFINER` khỏi `public/anon/authenticated`; với bảng `public.profiles`, vai trò `authenticated` chỉ được `SELECT` và `UPDATE (displayname, contact_phone, avatar_path)` — hoàn toàn không thể tự sửa cột `role` thành `'admin'` hay sửa `active`.

**4 Private Storage Buckets (`backend/app/services/storage_service.py`):**
- `SUPABASE_STORAGE_BUCKET` (ảnh trang sách trong kho chuẩn), `viread-avatars` (ảnh đại diện phụ huynh/bé, giới hạn 5 MB), `viread-karaoke` (nhạc/ảnh bìa karaoke, giới hạn 20 MB), `viread-private-books` (ảnh trang sách riêng của phụ huynh).
- Toàn bộ 4 bucket đều ở chế độ **Private**. Database **không bao giờ lưu URL công khai vĩnh viễn** mà chỉ lưu đường dẫn tương đối (`object path`). Khi trả dữ liệu về client, Backend sinh **Signed URL có thời hạn ngắn (`SIGNED_URL_TTL_SECONDS = 3600` giây)** hoặc trả luồng byte qua endpoint xác thực Bearer JWT.

---

## Phần 4: Frontend Web (`frontend/` — Next.js 16, React 19, TypeScript 6, Tailwind 4)

### 4.1 Giải thích từ gốc: App Router, Zod Validation, Private Blob URL & Adapter Trạng Thái

- **Next.js 16 App Router (`frontend/app/`):** Thư mục con trong `app/` tự động thành URL. Các thư mục có dấu ngoặc đơn như `(auth)`, `(app)`, `(protected)` là *Route Groups* dùng để chia **Layout** (khung bảo vệ và thanh điều hướng) mà không làm đổi đường dẫn URL.
- **Server Component Layout vs Client Screen:**
  - Các file `layout.tsx` chạy trên **Server**, gọi `requireAppRole(...)` để kiểm tra danh tính trước khi render.
  - Các màn hình tương tác (`DashboardScreen`, `ReadingScreen`, `BookScannerScreen`...) dùng `"use client"` chạy ở **Browser**, gọi API thông qua `AppServicesProvider` / `AdminServicesProvider`.
- **Zod Validation (`zod 4.6.2`):** Khi Backend trả JSON về, nếu có trường bị thiếu hoặc sai kiểu, app rất dễ crash ngầm (`undefined is not a function`). Trong `frontend/lib/api/api-client.ts`, hàm `requestApi<T>(path, schema, ...)` ép mọi phản hồi đi qua `schema.safeParse()`. Ngoài ra, lỗi từ Backend đi qua danh sách cho phép `safeBackendMessages` để không bao giờ lộ lỗi SQL hay stack trace lên màn hình người dùng.
- **Tải ảnh riêng tư qua Blob URL (`fetchAuthenticatedBlobUrl`):** Ảnh sách riêng của phụ huynh (`/books/my-books/...`) không thể gắn thẳng vào `<img src="...">` vì thẻ `<img>` không tự đính kèm header `Authorization: Bearer`. `api-client.ts` dùng `fetchAuthenticatedBlobUrl(url, signal)` tải ảnh với `cache: "no-store"` và Bearer token về RAM trình duyệt, tạo `URL.createObjectURL`, lưu theo dõi trong `activePrivateBlobUrls` và xóa sạch bộ nhớ qua `clearPrivateMediaMemoryCache()` khi đăng xuất hoặc đổi tài khoản.
- **Hiểu đúng về `reading-socket-adapter.ts`:** Tuy tên tệp là `frontend/lib/api/reading-socket-adapter.ts`, thực chất `createReadingSocketAdapter()` là **adapter trạng thái cục bộ phía client** (trả về trạng thái `"LISTENING"`, `"PAUSED"`, `"FINISHED"`, `"ABORTED"`, `"recovered"`). Toàn bộ dữ liệu đọc sách thật, gửi STT, TTS, sự kiện `WORD_RETRY` và so sánh kết quả chạy qua HTTP REST API (`/reading/*`, `/voice/*`).
- **Hệ thống giao diện (`frontend/app/globals.css`, `frontend/app/layout.tsx`):** `<html lang="vi">`, font `@fontsource-variable/nunito`, bảng màu thân thiện mắt trẻ em (`--ra-color-canvas: #fffaf0`, `--ra-color-primary: #087467`, `--ra-color-ink: #233e40`, `--ra-color-sky: #d9f4eb`, `--ra-color-highlight: #ffdb70`), icon `lucide-react`.

### 4.2 Bản đồ đầy đủ các Route Frontend (`frontend/app/`)

| Nhóm | Đường dẫn (Routes) | Cơ chế bảo vệ & Chức năng |
|---|---|---|
| **Gốc & Auth Công khai** | `/`, `/login`, `/register`, `/forgot-password`, `/reset-password` | `/` tự động `redirect("/login")` (nếu đã đăng nhập, `proxy.ts` đẩy sang `/dashboard`). Nhóm `(auth)` xử lý đăng nhập email/mật khẩu, OAuth Google/Facebook, khôi phục mật khẩu (`PASSWORD_RECOVERY`). |
| **OAuth & Cron API** | `/auth/callback` (`route.ts`)<br>`/api/cron/parent-emails` (`route.ts`) | `/auth/callback` xử lý mã PKCE và handoff về Android (`viread://auth/callback`).<br>`/api/cron/parent-emails` (`maxDuration = 60`, `runtime = "nodejs"`) kiểm tra `CRON_SECRET` bằng `timingSafeEqual` và gọi `POST /parent-notifications/cron/dispatch` trên Render với cơ chế retry lỗi `502`/`504`/mạng (`35s + 20s`). |
| **Khu vực Phụ huynh & Bé (`(app)/layout.tsx`)** | `/dashboard`, `/profile`, `/children`, `/children/new`, `/children/[childId]`, `/books`, `/books/[bookId]`, `/my-books`, `/my-books/[bookId]`, `/book-reports`, `/book-scanner`, `/device-permissions`, `/reading-preparation`, `/reading/[sessionId]`, `/reading-management`, `/sessions`, `/sessions/[sessionId]`, `/reports`, `/reports/difficult-words`, `/entertainment`, `/entertainment/picture-description`, `/entertainment/sentence-shooter`, `/karaoke`, `/karaoke/[songId]`, `/settings`, `/help-support` | `ParentAppLayout` gọi `await requireAppRole("parent")`, bọc trong `AuthServiceProvider` (`mode="supabase"`), `AppServicesProvider`, `AppStoreProvider`, `AppShell`. Bao trùm toàn bộ hành trình chọn bé, quét sách, đọc sách, xem báo cáo, trò chơi, karaoke và cài đặt. |
| **Báo cáo chi tiết phiên đọc** | `/sessions/[sessionId]/report` | Có `SessionReportLayout` riêng gọi `await requireAppRole("parent")`, tách khỏi thanh điều hướng `AppShell` để hiển thị/in báo cáo tập trung (`ReadingReport` + `ReadingAssessmentSummary`). |
| **Khu vực Admin (`admin/`)** | `/admin/login` (Công khai)<br>Được bảo vệ bởi `admin/(protected)/layout.tsx`: `/admin`, `/admin/parents`, `/admin/parents/[parentId]`, `/admin/books`, `/admin/books/new`, `/admin/books/[bookId]`, `/admin/books/[bookId]/edit`, `/admin/books/[bookId]/pages/[pageId]`, `/admin/metadata-quality`, `/admin/audit-logs`, `/admin/health`, `/admin/karaoke`, `/admin/karaoke/new`, `/admin/karaoke/[songId]/edit`, `/admin/viread-training` | `ProtectedAdminLayout` gọi `await requireAppRole("admin")`, dùng `AdminServicesProvider` và `AdminStoreProvider`. Quản trị phụ huynh, sách, chỉnh sửa OCR từng từ, AI workflow, chất lượng/bản quyền, karaoke, huấn luyện ViOCR V2, nhật ký audit và sức khỏe hệ thống. |

### 4.3 Providers, Hooks & Thành phần Audio/Camera chủ chốt

- **`AppServicesProvider`** (`frontend/components/providers/app-services-provider.tsx`): Cung cấp **19** service khu vực Phụ huynh & Bé (`bookService`, `bookContentReportService`, `childProgressService`, `childService`, `comprehensionService`, `devicePermissionService`, `difficultWordService`, `pageMatchService`, `parentPrivateBookService`, `profileService`, `reportService`, `readingService`, `readingManagementService`, `readingPresenceService`, `readingSocketAdapter`, `sessionService`, `sentenceShooterService`, `pictureDescriptionService`, `tutorService`).
- **`AdminServicesProvider`** (`frontend/components/providers/admin-services-provider.tsx`): Cung cấp **11** service khu vực Admin (`auth`, `books`, `bookContentQuality`, `metadataQuality`, `pages`, `parents`, `ocr`, `revisions`, `audit`, `health`, `vireadTraining`).
- **Karaoke Providers riêng** (`frontend/components/karaoke/karaoke-services-provider.tsx`): Tách riêng **`ParentKaraokeServicesProvider`** (`useKaraokeService()`, bọc `frontend/lib/api/karaoke-service.ts`) cho phụ huynh/bé và **`KaraokeServicesProvider`** (`useAdminKaraoke()`, bọc `frontend/lib/api/admin-karaoke-service.ts`) cho Admin.
- **Thu âm & Nhận diện giọng nói (`frontend/hooks/use-speech-recorder.ts`, `frontend/lib/reading/local-segment-speech-recognition.ts`):**
  - `useSpeechRecorder` dùng `MediaRecorder` dò codec tương thích theo thứ tự `audio/webm;codecs=opus` → `audio/mp4` → `audio/ogg`, kết hợp `AudioContext`/`AnalyserNode` đo chất lượng âm lượng (`LOW_VOLUME`, `CLIPPING`, `AUDIO_TOO_SHORT`).
  - `LocalSegmentSpeechRecognition` cắt từng đoạn âm thanh gửi về `POST /voice/speech-to-text` (thay thế `webkitSpeechRecognition` của trình duyệt).
- **Phát giọng đọc mẫu & Mở khóa Audio trên Android (`frontend/hooks/use-speech-player.ts`, `frontend/lib/reading/android-audio-unlock.ts`):**
  - `installAndroidAudioUnlock()` mở khóa WebAudio/`HTMLAudioElement` ngay ở thao tác chạm đầu tiên của người dùng (vượt chính sách chặn autoplay trên Chrome/Android).
  - `use-speech-player.ts` phát âm thanh từ VieNeu-TTS v3 Turbo kèm ánh xạ thời gian từng từ (`WordHighlightOverlay`) và từng bước đánh vần (`PhonicsLessonCard`).
- **Camera Scanner (`frontend/components/reading/camera-preview.tsx` & `book-scanner-screen.tsx`):**
  - Chỉ bật camera sau (`getUserMedia`) khi người dùng chủ động bấm nút.
  - Khi bật chế độ tự quét, chụp khung hình không chồng chéo mỗi `AUTO_SCAN_COOLDOWN_MS = 1800` ms (cạnh dài tối đa `1800px`, JPEG `0.88`) gửi lên `/reading/match-page` hoặc `/reading/books/{bookId}/match-page`.
  - Lắng nghe sự kiện `visibilitychange` và sự kiện tùy biến `viread:android-background` từ Android để **ngắt camera/microphone ngay lập tức** khi app xuống nền.

---

## Phần 5: Backend FastAPI (`backend/` — `app.sever:app`, 21 Router + `/health`, Services & Workers)

### 5.1 Giải thích từ gốc: ASGI/Uvicorn, `lifespan`, Lazy Import & Startup Delay

- **ASGI & Uvicorn (`uvicorn app.sever:app`):** Khác với web Python cổ điển (WSGI) xử lý tuần tự từng request, ASGI cho phép FastAPI chạy bất đồng bộ (`async/await`), rất hợp với hệ thống gọi nhiều I/O mạng (Supabase DB, Storage, LLM, Voice Worker).
- **`lifespan` (`backend/app/sever.py`):** Hàm chạy lúc server vừa khởi động và lúc tắt:
  1. Kiểm tra kết nối DB (`probe_database_connection`).
  2. Tùy chọn làm nóng OCR nếu bật `VIREAD_OCR_WARMUP_ENABLED` (mặc định tắt để giữ RAM dưới 512 MiB trên Render Free).
  3. Khởi động 1 luồng đồng bộ theo dõi mô hình OCR đang kích hoạt (`viread_active_model_registry_worker`), khởi chạy tối đa **6 asyncio background workers** sau độ trễ `_background_worker_startup_delay_seconds()` (**12 giây** trên Render/production để request HTTP đầu tiên được ưu tiên CPU/DB, 0 giây ở local).
  4. Trên Windows local, tự kích hoạt `ensure_local_voice_worker_running` để dựng Voice Worker `127.0.0.1:8010` và tùy chọn bật `viread_ocr_local_training_worker` nếu được cấu hình.
- **Middleware & Xử lý lỗi toàn cục (`backend/app/sever.py`):**
  - `request_diagnostic_middleware` gắn mã `X-Request-ID` cho mỗi request và ghi log thời gian xử lý sạch sẽ (không ghi dữ liệu nhạy cảm/PII).
  - Các lỗi mất kết nối DB hoặc quá tải pool (`DatabaseConcurrencyLimitExceeded`, `OperationalError`, `InterfaceError`, `SQLAlchemyTimeoutError`, mã SQLSTATE `08*`, `53300`, `57P01-03`, `EMAXCONNSESSION`) được gom về JSON HTTP `503` an toàn.
  - `CORSMiddleware` chặn `*` đi cùng credentials và mở quyền đọc các header giọng nói (`X-Resolved-Voice-Id`, `X-Voice-Provider`, `X-Voice-Region`, `X-Voice-Gender`, `X-Voice-Model-Version`, `X-Voice-Fallback`, `X-Voice-Fallback-Reason`).

### 5.2 Danh mục toàn bộ 21 Route Modules (`backend/app/api/router.py`) + `/health`

Toàn bộ `api_router` được gắn tại **root `""`** trong `backend/app/sever.py`:

| # | File Router | Tiền tố URL | Nhóm Endpoint chính & Chức năng |
|---|---|---|---|
| 0 | `sever.py` (trực tiếp) | `/` | `GET /health` — Kiểm tra DB (`SELECT 1`), trạng thái các background worker và `collect_ocr_health()` (không load nặng mô hình OCR). |
| 1 | `profile.py` | `/profiles` | Quản lý bé (`/children`, `/children/{child_id}`, `/avatar`), hồ sơ cá nhân (`/me`, `/me/avatar`, `/me/contact-phone`), Admin quản lý phụ huynh (`/admin/parents*`), CRUD legacy (`/`). |
| 2 | `book.py` | `/books` | Thư viện phụ huynh (`/catalog`, `/catalog/{book_id}`, `/catalog/{book_id}/preview`), Admin sách (`/admin/catalog*`, `/admin/metadata-quality`, `/admin/pages/{page_id}/image`, `/processing`, `/revisions*`). |
| 3 | `admin_ocr.py` | `/books` | Tải trang ảnh/tài liệu PDF-DOCX (`/admin/catalog/{book_id}/pages`, `/documents`), chạy lại OCR (`/reupload-ocr`, `/reprocess`), lưu nháp/duyệt/gỡ trang (`/revisions/draft`, `/verify`, `DELETE`), AI sửa chính tả (`/ai-correct*`), AI workflow & duyệt an toàn (`/ai-workflows*`, `/safety-decision`, `/image-safety-decision`). |
| 4 | `parent_private_book.py` | `/books` | Sách riêng phụ huynh (`/my-books*`, `/pages*`, `/submissions*`, `/accept-spelling`, `/retry`, `/request-admin-review`, `/add-page`, `/image`), đồng thuận Flow 2 (`/ocr-contribution`), Admin duyệt sách người dùng (`/admin/quality/user-books*`, `/flow2-candidates*`). |
| 5 | `book_content_quality.py` | `/books` | Phụ huynh báo lỗi sách (`/catalog/{book_id}/reports`, `/reports/mine*`), Admin rà soát chất lượng/bản quyền/quét tự động (`/admin/quality/reports*`, `/admin/quality/books*`, `/rights`, `/decision`, `/scan*`, `/findings*`). |
| 6 | `admin_viread_training.py` | `/books` | Điều phối huấn luyện ViOCR V2 (`/admin/viread-training/overview`, `/drive/*`, `/datasets/*`, `/runs/*`, `/flow1-model/*`, `/benchmarks`, `/decisions`, `/jobs/{job_id}/*`) và API riêng cho Colab Worker xác thực bằng token bí mật chia sẻ ở header `X-ViRead-Training-Worker` (`VIREAD_TRAINING_WORKER_TOKEN`, so sánh hằng thời gian bằng `hmac.compare_digest` trên SHA-256) (`/worker/claim`, `/status`, `/dataset`, `/locked-test`, `/artifact-stream`, `/runs*`, `/chunks`, `/complete`, `/benchmarks`, `/heartbeat`, `/finish`, `/resume-state*`). |
| 7 | `reading.py` | `/reading` | Phiên đọc (`/sessions*`, `/page`, `/progress`, `/complete`, `/navigate`, `/finish`, `/completion-summary`), sự kiện & luyện lại (`/events`, `/practice-state`, `/fluency`), lịch sử & so sánh (`/history*`, `/compare`, `/reports*`), quét camera & OCR nhanh (`/books/{book_id}/match-page`, `/match-page`, `/scan-page-ocr`). |
| 8 | `reading_management.py` | `/reading-management` | Mục tiêu đọc (`/goals*`), kế hoạch (`/plans*`), bộ sưu tập (`/collections*`), lịch nhắc đọc & xác nhận (`/reminders*`, `/reminders/due`, `/occurrences/{occurrence_id}/acknowledge`). |
| 9 | `reading_presence.py` | `/reading-presence` | Cấu hình giám sát hiện diện (`/settings`) và vòng đời cảnh báo rời khung hình (`/alerts`, `/alerts/{alert_id}/confirm`, `/cancel`). |
| 10 | `parent_notifications.py` | `/parent-notifications` | Cài đặt email phụ huynh (`/preferences`), lịch sử gửi (`/history`), gửi email thử (`/test-email`), và endpoint kích hoạt cron từ ngoài **`POST /parent-notifications/cron/dispatch`** (xác thực `X-Cron-Secret` / `Bearer`). |
| 11 | `voice.py` | `/voice` | Trạng thái engine (`/status`), TTS (`/text-to-speech`), đánh vần lớp 1 (`/text-to-speech/phonics`), STT phân đoạn (`/speech-to-text`), STT luồng thời gian thực (`WEBSOCKET /voice/stt-stream`). |
| 12 | `voice_studio.py` | `/voice` | Danh sách 8 giọng đọc chuẩn 3 miền (`/voices`) và TTS trả kèm mốc thời gian từng từ (`/text-to-speech/timed`). |
| 13 | `comprehension.py` | `/comprehension` | Câu hỏi đọc hiểu tĩnh gắn theo trang/sách (`GET/POST /questions`, `POST /answers`). |
| 14 | `tutor_question.py` | `/tutor` | Sinh câu hỏi đọc hiểu AI dựa trên nội dung đã đọc (`/sessions/{session_id}/questions/generate`, `/next`, `/answer`). |
| 15 | `child_progress.py` | `/tutor` | Đánh giá tiến độ tổng hợp + nhận xét AI cho phụ huynh (`GET/POST /children/{child_id}/progress-assessment`). |
| 16 | `sentence_shooter.py` | `/games/sentence-shooter` | Trò chơi bắn chữ ghép câu (`GET /books`, `POST /sessions`, `/shots`, `/hints`, `/next-round`, `/result`, `/abandon`). |
| 17 | `picture_description.py` | `/games/picture-description` | Trò chơi mô tả tranh (`GET /catalog`, `GET/POST /sessions`, `GET /sessions/{session_id}`, `POST /evaluate`). |
| 18 | `karaoke.py` | `/karaoke` | Admin tạo/sửa bản nháp, tải nhạc/ảnh bìa/giọng mẫu, kiểm tra hợp lệ, xuất bản, bật/tắt hiển thị (`/admin/songs*`); Bé/Phụ huynh xem danh sách & phát bài (`/songs`, `/songs/{song_id}/playback`). |
| 19 | `karaoke_processing.py` | `/karaoke` | Kiểm tra khả năng tách nhạc/căn lời (`/admin/processing-capabilities`), chạy/theo dõi/hủy/thử lại/áp dụng job tự động (`/admin/songs/{song_id}/processing-jobs*`), xem trước & duyệt bản nháp (route đầy đủ `/karaoke/admin/songs/{song_id}/draft/reference-preview`, `/karaoke/admin/songs/{song_id}/draft/review`). |
| 20 | `system.py` | `/system` | Báo cáo tiến độ chi tiết (`/progress/{child_id}`, `/periods`), luyện từ khó 90 ngày (`/difficult-words/{child_id}*`), tài nguyên legacy (`/reports`, `/consents`, `/logs`), Admin (`/admin/audit-logs`, `/admin/health`). |
| 21 | `support.py` | `/support` | Gửi phản hồi hỗ trợ từ phụ huynh (`POST /support/feedback`). |

### 5.3 Các Background Workers (`backend/app/jobs/` — 10 modules)

1. `book_quality_worker.py` *(chạy trong lifespan)*: Quét kiểm tra chất lượng & an toàn nội dung sách tự động.
2. `admin_ai_workflow_worker.py` *(chạy trong lifespan)*: Xử lý hàng đợi sửa lỗi OCR và kiểm duyệt an toàn trẻ em hàng loạt cho Admin.
3. `parent_book_submission_worker.py` *(chạy trong lifespan)*: Thực thi pipeline số hóa & kiểm tra sách riêng của phụ huynh.
4. `parent_email_dispatcher_worker.py` *(chạy trong lifespan + được gọi qua Cron)*: Bộ điều phối thống nhất cho `reading_presence_alert_worker.py` (~10s), `reading_reminder_worker.py` (~30s) và email tổng hợp tuần / nhắc nghỉ đọc / cột mốc (~15 phút).
5. `viread_ocr_outbox_worker.py` *(chạy trong lifespan)*: Đọc bảng outbox `viread_ocr_outbox` mỗi khi Admin duyệt trang sách, cắt ảnh từng dòng để đưa vào kho huấn luyện Flow 2.
6. `viread_ocr_training_auto_worker.py` *(chạy trong lifespan)*: Tự động đóng gói dataset/job huấn luyện ViOCR V2 khi đủ ngưỡng mẫu mới hoặc kích hoạt điều phối Cloud Run Enterprise nếu được bật.
7. `viread_ocr_local_training_worker.py` *(tùy chọn riêng qua `VIREAD_LOCAL_TRAINING_ENABLED`)*: Chạy huấn luyện cục bộ trên máy có GPU khi không dùng Colab.
8. `karaoke_processing_worker.py`: Xử lý nền job tách beat và căn lời Karaoke khi `KARAOKE_PROCESSING_ENABLED=true`.
9. `reading_presence_alert_worker.py` & `reading_reminder_worker.py`: Hai module chuyên trách xử lý logic gửi cảnh báo vắng khung hình và nhắc giờ đọc (được `parent_email_dispatcher_worker.py` gọi điều phối).

---

## Phần 6: Các luồng nghiệp vụ chính từ đầu đến cuối (End-to-End Flows)

### Luồng 1: Đăng nhập, chọn hồ sơ bé & Quét trang sách bằng Camera (`/book-scanner`)

1. Phụ huynh đăng nhập tại `/login` → xác thực Supabase → vào `/dashboard` (`FamilyReadingDesk`). Khi chọn một bé, `AppStoreProvider.selectChild()` lưu `selectedChildId` trong state của tab và mọi màn hình con dùng `useValidatedSelectedChild()` đối chiếu lại với `GET /profiles/children`.
2. Trên `/book-scanner` (`BookScannerScreen` + `CameraPreview`), khi người dùng bấm bật camera:
   - Frontend chụp khung hình mỗi `1800ms` (không chồng chéo request) gửi tới `POST /reading/match-page` (tìm toàn kho sách đã duyệt) hoặc `POST /reading/books/{book_id}/match-page` (tìm trong một cuốn cụ thể).
   - Backend chạy `ViReadPageMatcher` (`ai/vision/page_matcher.py` qua `vision_page_matcher.py`): kiểm tra độ nét (Laplacian), độ sáng và mật độ cạnh (Canny), sau đó trích xuất đặc trưng **ORB (`nfeatures=1000`) + BFMatcher + RANSAC** so với `FeaturePath` của các trang sách trong DB để trả về đúng `book_id`, `page_id` và độ tin cậy.
   - Nếu người dùng chụp/chọn ảnh tĩnh để quét chữ trực tiếp, Frontend tiền xử lý ảnh (`preprocessScanImage`) và gọi `POST /reading/scan-page-ocr` (`local_ocr_scan_service.py`) kèm idempotency key để nhận văn bản ngay.

### Luồng 2: Chuẩn bị thiết bị & Bé đọc cùng AI (`/reading-preparation` → `/reading/[sessionId]`)

1. Tại `/books/[bookId]` chọn dải trang liên tục → sang `/reading-preparation` (`ReadingPreparationScreen`):
   - Kiểm tra dải trang hợp lệ (`isRangeContiguous`), bắt buộc kiểm tra mic thực tế (`DevicePermissionService.requestAccess("microphone")` mở luồng mic kiểm tra `MediaRecorder` rồi đóng track ngay lập tức).
   - Bấm bắt đầu → `POST /reading/sessions` tạo phiên đọc mới.
2. Trong màn hình đọc `/reading/[sessionId]` (`ReadingScreen` + `lib/reading/*`):
   - `installAndroidAudioUnlock()` mở khóa âm thanh; `SessionVoiceLock` khóa cố định một giọng Bắc/Trung/Nam suốt buổi đọc.
   - Bé bấm đọc: `useSpeechRecorder` thu âm theo đoạn, `AudioQualityMonitor` kiểm tra âm lượng, `LocalSegmentSpeechRecognition` gửi lên `POST /voice/speech-to-text` (Sherpa-ONNX local).
   - Văn bản nhận diện chạy qua `RealtimeAlignmentEngine` (hỗ trợ lookahead và chuẩn hóa dấu tiếng Việt) để tô màu từ đúng, đánh dấu từ sai/bỏ sót và xử lý lặp/ngập ngừng (`EchoGuard`, `SentenceReinforcementTracker`).
   - Khi bé cần trợ giúp hoặc đọc sai: Frontend gọi `POST /voice/text-to-speech` (đọc mẫu) hoặc `POST /voice/text-to-speech/phonics` (đánh vần lớp 1 từng bước, `PhonicsLessonCard`), đồng thời ghi nhận sự kiện `READ_EXAMPLE` hoặc các lần bé thử đọc lại `WORD_RETRY` (`CONFIRMED` / `FAILED` / `UNCERTAIN`) qua `POST /reading/events`.
   - Khi xong trang: gọi `POST /reading/sessions/{session_id}/compare` với `finalize=true` (`ReadingComparisonService.compare` dùng `align_text` trong `text_alignment.py`), lưu `ReadingComparisonReport` với `Summary["assessment_version"] = 1` và mảng `initial_assessment` bất biến. Cuối buổi đọc, `TutorQuestionGenerator` (`/tutor/sessions/{session_id}/questions/generate`) sinh câu hỏi đọc hiểu bám sát trang vừa đọc.

### Luồng 3: Tính điểm tiến độ thực tế & Luyện từ khó 90 ngày

> **Điểm nhấn cực kỳ quan trọng khi bảo vệ đồ án:**
> Trong dữ liệu Supabase thực tế của ViRead, bảng `fluencyassessments` **trống (không có dữ liệu sản xuất)**, còn bảng `readingevents` chủ yếu lưu sự kiện **`WORD_RETRY`** (`CONFIRMED`/`FAILED`/`UNCERTAIN`) và `READ_EXAMPLE`.
> Vì vậy, hệ thống **không** đọc từ `fluencyassessments` để tính độ chính xác hay từ khó!

Cách hệ thống tính toán thực tế minh bạch 100% ở code (`backend/app/services/reading_assessment.py` & `backend/app/services/child_progress/metrics.py` & `scoring.py`):
1. `aggregate_assessment()` duyệt các `ReadingComparisonReport` có `Summary["assessment_version"] == 1` (lấy snapshot đầu tiên theo từng cặp `(PageId, PageRevisionId)` để không bị ghi đè lịch sử) làm **kết quả lần đọc đầu tiên (*first-pass*)** gồm `CORRECT`, `MISPRONUNCIATION`, `OMISSION`, `UNCERTAIN`.
2. Kết hợp với các sự kiện `WORD_RETRY` và `READ_EXAMPLE` trong `readingevents` để phân biệt: từ bé **tự sửa được** (*self-corrected*), từ sửa được **nhờ nghe gợi ý/đánh vần** (*assisted*), và từ vẫn sai sau 3 lần thử (*skipped_after_retry_limit*).
3. Trong `ChildProgressService`, mọi con số điểm, tỷ lệ chính xác, độ phủ và danh sách từ yếu đều do Python thuần tính toán tất định (*deterministic*); LLM (`child_progress/ai.py`) chỉ nhận số liệu tổng hợp ẩn danh để viết nhận xét ấm áp và gợi ý cho phụ huynh (cache 24h), tuyệt đối không được phép tự bịa hoặc sửa điểm.
4. **`DifficultWordsService`** (`backend/app/services/difficult_words_service.py`) tổng hợp các từ hay sai trong cửa sổ mặc định 90 ngày từ `readingcomparisonreports` + `WORD_RETRY`, tạo phiên luyện tập riêng (`/system/difficult-words/{child_id}/practice/*`) và chấm lại phát âm qua `VoiceOrchestrator`.

### Luồng 4: Sách riêng của phụ huynh (`my-books`) & Đóng góp dữ liệu Flow 2

1. Phụ huynh tạo sách riêng (`/my-books`) qua `POST /books/my-books` (`VisibilityScope='PARENT_PRIVATE'`, `OwnerParentId == actor_id`). Quyền cô lập gia đình được khóa cứng trong `app/policies/book_access.py` và trigger DB `prevent_private_book_catalog_promotion()`.
2. Khi tải ảnh/PDF/DOCX lên (`POST /books/my-books/{book_id}/submissions`), `parent_private_book_pipeline.py` và `parent_book_submission_worker.py` chạy tuần tự: Rasterize → OCR cục bộ → Sửa lỗi chính tả (**mặc định chỉ chạy Ollama cục bộ**, không gửi văn bản sách gia đình lên cloud trừ khi bật `PRIVATE_BOOK_ALLOW_CLOUD_AI=true`) → Kiểm tra chất lượng ảnh/chữ (`book_quality_analyzer.py`) → Kiểm duyệt an toàn trẻ em → Nếu trang chỉ có hình hoặc bị gắn cờ nhạy cảm thì đưa vào hàng đợi Admin duyệt trực quan (`NEEDS_ADMIN_REVIEW`), ngược lại sẵn sàng thêm vào sách (`PASSED_READY_TO_ADD` → `ADDED_TO_BOOK`).
3. Phụ huynh có thể tự nguyện bật/tắt đồng ý đóng góp mẫu chữ đã duyệt (`PUT /books/my-books/{book_id}/ocr-contribution`) vào bảng `parent_book_flow2_candidates` để Admin xét duyệt đưa vào tập huấn luyện Flow 2.

### Luồng 5: Trò chơi, Karaoke, Quản lý đọc & Tự động hóa Email

- **Xạ thủ ghép câu (`/entertainment/sentence-shooter`):** Bé nghe/đọc câu mẫu, bắn chọn đúng từ ghép thành câu hoàn chỉnh theo vòng chơi (`SentenceShooterService`, bảng `gamesessions`, `gamerounds`, `gameattempts`).
- **Kể chuyện qua tranh (`/entertainment/picture-description`):** Bé xem tranh minh họa, mô tả bằng giọng nói/văn bản; `picture_description_ai.py` dùng chuỗi LLM đa phương thức (Gemini/Groq/Ollama) để gợi ý từ vựng và nhận xét lời kể của bé (`picturedescriptionsessions`, `picturedescriptionattempts`).
- **Hát vui cùng bé (`/karaoke`):** Tải bài hát & lời có mốc thời gian từng âm tiết (`SyllableLyrics`, `KaraokePlayer`, `LiveSingingScore`).
- **Quản lý đọc & Tự động hóa Email (`reading_management_service.py`, `reading_presence_service.py`, `parent_email_dispatcher_worker.py`):**
  - Phụ huynh đặt mục tiêu (`readinggoals`), kế hoạch tuần (`readingplans`), bộ sưu tập (`childbookcollections`), lịch nhắc đọc (`readingreminders`), cấu hình vắng khung hình (`readingpresencesettings`).
  - `parent_email_dispatcher_worker.py` gửi **5 kịch bản email**: (1) Bé rời khung hình > 60s, (2) Nhắc giờ đọc (tự hủy nếu hôm nay bé đã đọc rồi), (3) Báo cáo tổng kết tuần, (4) Nhắc nhẹ khi nghỉ đọc >= 5 ngày (dừng sau 2 lần không phản hồi), (5) Chúc mừng cột mốc (buổi đầu, chuỗi 7/14/30 ngày, 100% mục tiêu). Có khung giờ yên tĩnh `21:00–07:00` giờ VN và giới hạn tuần mặc định 4 email/tuần.

### Luồng 6: Quy trình vận hành của Admin (`/admin/**`)

Admin tạo sách (`/admin/books/new`) → Tải lên PDF/DOCX/ảnh (`/books/admin/catalog/{book_id}/documents` hoặc `/pages`) → Hệ thống rasterize & chạy Dual-Engine OCR tạo `pagerevisions` (`NEEDS_REVIEW`) và `pagerevisionwords` → Admin sửa từng từ trên giao diện đối chiếu cạnh ảnh gốc hoặc khởi chạy **AI Workflow** (`admin_ai_workflow_service.py`: AI sửa lỗi chính tả + đánh giá an toàn lứa tuổi lớp 1–5) → Bấm Xác minh (`POST /books/admin/pages/{page_id}/verify`) để xuất bản trang (`VERIFIED`), đồng thời kích hoạt ghi một bản ghi vào `viread_ocr_outbox` nuôi dữ liệu huấn luyện cho ViOCR V2. Ngoài ra Admin quản lý báo lỗi/bản quyền (`/admin/metadata-quality`), kiểm duyệt Karaoke (`/admin/karaoke`) và vận hành huấn luyện OCR (`/admin/viread-training`).

---

## Phần 7: Hệ thống AI, OCR, Giọng nói & Huấn luyện mô hình (`ai/` & `backend/app/services/`)

### 7.1 Document Rasterizer (`backend/app/services/document_rasterizer_service.py`)

Trước khi chạy OCR, tệp tải lên (JPEG/PNG/WEBP/BMP/TIFF/PDF/DOCX, tối đa `MAX_DOCUMENT_BYTES = 50 MB`, `MAX_DOCUMENT_PAGES = 30` trang) đi qua bộ bảo vệ chặt chẽ:
- Kiểm tra **magic bytes** thực sự của file (không tin đuôi `.pdf`/`.jpg` do người dùng đặt tên).
- Chống **DOCX Zip-Bomb & Macro**: giới hạn tổng dung lượng giải nén `MAX_DOCX_UNCOMPRESSED_BYTES = 100 MB`, tối đa `MAX_DOCX_ZIP_ENTRIES = 2000` tệp bên trong, từ chối mọi macro `.bin`.
- Render PDF bằng `pypdfium2`/`pymupdf` ở độ phân giải **220 DPI**; chuyển DOCX thành trang ảnh A4 để OCR xử lý đồng nhất.

### 7.2 Dual-Engine OCR (`backend/app/services/ocr_engine.py`)

- **Lazy Import sinh tồn trên 512 MiB RAM:** `torch`, `PaddleOCR`, `vietocr` (`Cfg`, `Predictor`) được đặt bằng `None` ở cấp module và chỉ nạp bên trong `_get_ocr_engines()` khi có request OCR đầu tiên. Điều này vừa giúp FastAPI bind cổng kịp trên Render Free 512 MiB, vừa giúp các bộ unit test CI (144 file `test_*.py` ở `backend/`, trong đó `run_ci_tests.py` chạy `unittest discover` với 141 file tại root `backend/`) không bị lỗi `ModuleNotFoundError` khi chạy ở môi trường nhẹ.
- **Quy trình nhận diện 4 bước (`extract_text_and_boxes` → `_extract_text_and_boxes_dual_engine`):**
  1. **Phát hiện vùng chữ:** PaddleOCR DBNet dò các dòng và khung chữ.
  2. **Sắp xếp & nắn thẳng dòng chữ:** `sort_reading_order_adaptive` sắp xếp thứ tự đọc tự nhiên (trái→phải, trên→dưới, xử lý nhiều cột/ảnh nghiêng) và làm phẳng dải chữ cong.
  3. **Nhận diện tiếng Việt có dấu:** VietOCR (`vgg_transformer`) đọc từng dải dòng với độ chính xác dấu thanh vượt trội.
  4. **Phân xử từng từ chọn lọc (`ocr_adjudication.py`, `ocr_evidence.py`) & Fallback:** Cắt ảnh từng từ nghi ngờ (`MAX_SELECTIVE_WORD_CROPS_PER_PAGE`) để đối chiếu lại khi điểm tin cậy hoặc dấu câu lệch nhau; nếu PaddleOCR không khả dụng hoặc không thấy chữ, tự chuyển sang `_extract_text_and_boxes_tesseract` dùng `backend/tessdata/vie.traineddata` *(tài nguyên cài đặt cục bộ khi setup, không commit trong Git)*.
- **Truy xuất nguồn gốc & Hot-Swap mô hình:** Gắn SHA-256 của mô hình vào từng instance qua `WeakKeyDictionary` (`_vietocr_verified_runtime`), có luồng nền `run_active_viread_model_worker` tự động nạp mô hình mới từ bảng `viread_ocr_active_model` mà không cần khởi động lại server.

### 7.3 Hệ thống Giọng nói Local-First (`voice_orchestrator.py` + `scripts/windows/voice_worker.py`)

- **Kiến trúc tách tiến trình (`127.0.0.1:8010`):**
  - `backend/requirements.txt` phải khóa chặt `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13` để tương thích ABI với `PaddlePaddle 2.6.2`.
  - Vì thư viện âm thanh cần phiên bản khác, `voice_worker.py` chạy trong một môi trường ảo tách biệt (`tools/voice-runtime`), giao tiếp với FastAPI qua HTTP/WebSocket loopback (`LocalVoiceProvider`).
- **Công nghệ STT & TTS cục bộ:**
  - **STT:** `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` nhận diện giọng đọc tiếng Việt có dấu ngoại tuyến, không gửi giọng bé ra ngoài.
  - **TTS:** `VieNeu-TTS v3 Turbo` (ONNX CPU, 48 kHz) với 8 giọng đọc Bắc · Trung · Nam, hỗ trợ sinh **audio đánh vần lớp 1 từng bước** (`/voice/text-to-speech/phonics`) và **TTS kèm mốc thời gian từng từ** (`/voice/text-to-speech/timed`) để bôi sáng từng chữ khi đọc mẫu.
- **Chính sách `VoiceOrchestrator` & `SessionVoiceLock`:**
  - Mặc định `local_only`. Khi bật `local_with_google_fallback` (với quyền `allow_google_stt` / `allow_google_tts` do phụ huynh chọn), hệ thống chỉ dùng `GoogleCloudVoiceProvider` (`vi-VN-Neural2-A/D`, `vi-VN-Wavenet-B/C`) khi worker local gặp **lỗi kỹ thuật** (`UNAVAILABLE`, `TIMEOUT`, `BUSY`) — **tuyệt đối không fallback chỉ vì bé đọc nhỏ, ngập ngừng hay đọc sai**.
  - Luật **"Một buổi, một giọng"** (`SessionVoiceLock`): khóa cứng giọng và nhà cung cấp suốt phiên đọc để bé không bị đổi giọng đột ngột giữa trang.

### 7.4 Chuỗi LLM An toàn & Đóng kín (Fail-Closed Chains)

Các tính năng dùng mô hình ngôn ngữ lớn đều thiết kế theo nguyên tắc **fail-closed** (nếu đầu ra sai JSON hoặc thất bại giữa chừng thì từ chối cập nhật, không lưu dữ liệu lỗi):
- **Sửa lỗi OCR (`ocr_ai/orchestrator.py`):** Cắt văn bản thành chunk kèm ảnh crop tương ứng, gọi tuần tự: **`gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → Groq `qwen/qwen3.8-27b` → Ollama cục bộ `qwen3-vl:4b-instruct-q4_K_M` (`127.0.0.1:11434`)**. Nếu một chunk thất bại trên tất cả nhà cung cấp, toàn bộ job hủy bỏ, giữ nguyên bản nháp gốc. Với **Sách riêng của phụ huynh**, `OcrCorrectionConfig.private_book_allow_cloud_ai()` mặc định `False` — chỉ dùng **Ollama cục bộ** để bảo vệ quyền riêng tư gia đình.
- **Kiểm duyệt an toàn trẻ em (`ocr_ai/child_safety.py`):** Đánh giá độ phù hợp cho lớp 1–5 (`SUITABLE`, `SUITABLE_WITH_GUIDANCE`, `REVIEW_REQUIRED`, `NOT_RECOMMENDED`), bắt buộc trích xuất chính xác đoạn văn bản bằng chứng liên tiếp (*contiguous evidence substring*) và gắn `content_hash` (`candidate_hash`) cho văn bản đầu vào/finding; còn cơ chế khóa cứng `CandidateHash == SafetyInputHash` (`hash_match`) được kiểm tra trong `backend/app/services/admin_ai_workflow_service.py` và `backend/app/jobs/admin_ai_workflow_worker.py` để không ai có thể sửa nội dung lách qua bước duyệt.
- **AI Sinh câu hỏi (`tutor_questions/generator.py`):** Thứ tự `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → Groq `qwen/qwen3.8-27b` → **bộ sinh câu hỏi điền từ theo luật (`rule_based.py`)**. Chỉ gửi văn bản sách đã xác minh, **0 thông tin PII** của bé/phụ huynh.
- **Mô tả tranh (`picture_description_ai.py`):** Dùng Gemini (`gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemma-4-26b-a4b-it`, `gemini-flash-lite-latest`) → Groq `qwen/qwen3.8-27b` → Ollama `qwen3-vl:4b-instruct-q4_K_M` (+ deterministic fallback `evaluate_description_with_guide_fallback`).
- **Nhận xét tiến độ (`child_progress/ai.py` — `ChildProgressAI`):** Chỉ dùng chuỗi `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → Groq `qwen/qwen3.8-27b` trên số liệu tổng hợp ẩn danh (không dùng `gemma-4-26b-a4b-it`, `gemini-flash-lite-latest` hay Ollama).

### 7.5 Đường ống Huấn luyện ViOCR V2 (`ai/vietocr_v2/` & `cloud/`)

Kiến trúc cải tiến mô hình đọc chữ tiếng Việt (`vgg_transformer` giữ nguyên bộ từ vựng 229 ký tự gốc, kiểm tra SHA-256 checkpoint cha) gồm 2 luồng dữ liệu:
1. **Flow 1 (`FLOW1_EXTERNAL_TRDG`):** `flow1_prepare.py` (DBNet khớp hộp chữ ảnh ngoài) + `flow1_trdg_generate.py` (sinh ảnh chữ tổng hợp TRDG) + `flow1_register.py` (500–1.000 dòng thật + 20.000–50.000 dòng tổng hợp, chia 70/15/15 theo nhóm sách).
2. **Flow 2 (`FLOW2_ADMIN_VERIFIED`):** Khi Admin xác minh một trang sách, Backend ghi sự kiện bền vững vào `viread_ocr_outbox`. Worker `viread_ocr_outbox_worker.py` cắt từng dòng ảnh đã được con người sửa chuẩn (`flow2_prepare.py`, `flow2_register.py`) đưa vào `viread_ocr_samples`.
3. **Chạy huấn luyện trên Google Colab Miễn phí (`colab_worker.py` + `viread_vietocr_v2_colab_worker.ipynb`):**
   - Khởi động bằng `verify_worker_source_lock()` kiểm tra SHA-256 của `train.py`, `requirements.txt`, `requirements-colab.txt` chống lệch mã nguồn.
   - Claim job qua `POST /books/admin/viread-training/worker/claim` (xác thực header token chia sẻ `X-ViRead-Training-Worker` bằng `hmac.compare_digest` trên SHA-256), tải shard giới hạn **`ARTIFACT_DOWNLOAD_WORKERS = 2`** và tự retry các mã lỗi Cloudflare **`520–530`** (toàn bộ `408, 429, 500–599`) để không làm nghẽn Render Free.
   - Lưu trạng thái tiếp tục (resume state) lên Google Drive (qua OAuth, Drive Desktop hoặc cầu nối Apps Script miễn phí `scripts/google-apps-script/viread_flow2_drive_bridge.gs`).
   - Huấn luyện với AdamW + cosine schedule + fp16 + đóng băng VGG 5 epoch đầu; chấm điểm trên tập kiểm thử niêm phong **Locked Test** (`MIN_LOCKED_PAIRS=200`, `MIN_LOCKED_GROUPS=30` trong `backend/app/services/viread_ocr_training_service.py`; `GatePolicy(min_pairs=200, min_groups=30)` trong `ai/vietocr_v2/quality_gate.py`). Mô hình mới chỉ lên sóng (`viread_ocr_active_model`) khi Admin bấm duyệt.
   - *(Tùy chọn mở rộng trả phí)*: `cloud/colab-enterprise-dispatcher/` là container Cloud Run xác thực HMAC-SHA256 để tự động kích hoạt Vertex AI `notebookExecutionJobs` khi bật `VIREAD_COLAB_EXECUTION_MODE="enterprise"` (mặc định là `"manual"`).

### 7.6 ORB Page Matcher & Experimental Karaoke Aligner

- **`ai/vision/page_matcher.py` (`ViReadPageMatcher`):** So khớp ảnh camera với ảnh trang sách bằng OpenCV ORB (`nfeatures=1000`) + Lowe's ratio `0.75` + Homography RANSAC inliers.
- **`ai/karaoke_processing/`:** Engine thử nghiệm (chạy trong `.cache/karaoke-ai/.venv` Python 3.13, `HF_HUB_OFFLINE=1` qua `runner.py`) kết hợp **Demucs 4.0.1 `htdemucs`** tách giọng hát/nhạc nền và **CTC forced aligner (`nguyenvulebinh/lyric-alignment`)** căn thời gian từng âm tiết. Được gắn cờ thử nghiệm và **tắt mặc định (`KARAOKE_PROCESSING_ENABLED=false`)** để không ảnh hưởng production.

---

## Phần 8: Ứng dụng Android (`android/` — Native WebView Shell & OAuth Loopback)

### 8.1 Tại sao chọn Native Java WebView thay vì Capacitor Static Export hay React Native?

1. **Next.js 16 SSR không thể export tĩnh (`output: "export"`):** Việc làm mới cookie trong `proxy.ts`, kiểm tra `public.profiles.role` trên server (`server-authorization.ts`) và đổi mã PKCE ở `/auth/callback` bắt buộc Frontend phải chạy trên máy chủ HTTPS thật. Đóng gói static HTML vào Capacitor sẽ làm mất bảo vệ SSR và lệch origin cookie.
2. **Tái sử dụng 100% UI & logic đọc sách phức tạp:** Không phải viết lại toàn bộ `ReadingScreen`, `PhonicsLessonCard`, `CameraPreview` hay `SentenceShooter` bằng React Native — mọi cải tiến trên Web tự động có mặt trên Android ngay lập tức.
3. **Kiểm soát chặt phần cứng & bảo mật cấp hệ điều hành:** Native Java (`vn.viread.android`, `minSdk 26`, `targetSdk 35`) kiểm soát triệt để SSL, FileProvider camera, AudioFocus và nút Back Android 13–16 mà một PWA thông thường hay gặp lỗi.

### 8.2 Kiến trúc các lớp chính (`android/app/src/main/java/vn/viread/android/`)

- **`TrustedNavigation.java`:** "Người gác cổng URL" (Zero-JS-Bridge). Chỉ cho phép WebView tải đúng tên miền HTTPS tin cậy (`port 443` ở bản Release; cổng tùy chỉnh chỉ mở khi test LAN Debug), chặn tuyệt đối `http:`, `file:`, `intent:`, `javascript:`, ép `shouldProceedOnSslError() => false`, và kiểm tra deep link `viread://auth/callback?...`.
- **`ServerEndpointStore.java`:** Khóa cứng `BuildConfig.FRONTEND_URL` trong bản Release (ném `SecurityException` nếu cố bật chế độ LAN ngoài Debug). Chỉ cho phép đổi IP mạng LAN RFC1918 trong bản `DEBUG && LAN_ACCEPTANCE_MODE`.
- **`MainActivity.java`:**
  - Màn hình Splash + Edge-to-edge `WindowInsets`.
  - **Xử lý Cold Start 90s của Render:** Đặt `LOAD_TIMEOUT_MS = 90_000L` và hiển thị 3 mốc gợi ý tiếng Việt thân thiện ở `0–8s`, `8s`, `20s`. Nếu gặp lỗi mạng/5xx/SSL/timeout, giấu WebView đi để **không bao giờ hiện trang lỗi thô của Chromium**, thay bằng thẻ chẩn đoán tiếng Việt có nút Thử lại / Về `/login` / Kiểm tra kết nối.
  - **Chụp ảnh & Chọn tệp (`onShowFileChooser`):** Kết hợp `ACTION_OPEN_DOCUMENT` (chọn nhiều ảnh/PDF/DOCX) và mở thẳng camera hệ thống (`MediaStore.ACTION_IMAGE_CAPTURE`) thông qua `FileProvider` riêng tư (`allowBackup="false"`, `usesCleartextTraffic="false"`).
  - **Giải phóng Mic/Camera tức thì:** Theo dõi `AudioFocusRequest`, `ACTION_AUDIO_BECOMING_NOISY` và vòng đời Activity; phát sự kiện DOM `viread:android-background` để `useSpeechRecorder` và `CameraPreview` tắt mic/camera ngay khi bé thoát app hoặc có cuộc gọi đến.
  - Ép `CookieManager.flush()` mỗi khi chuyển trang SPA (`doUpdateVisitedHistory`) để tắt mở lại app không bị mất phiên đăng nhập.

### 8.3 Cơ chế OAuth Loopback (`OAuthLoopbackServer.java`) vượt lỗi `403 disallowed_useragent`

Đây là một điểm kỹ thuật rất đắt giá khi bảo vệ đồ án:
- **Vấn đề:** Google chặn đăng nhập OAuth bên trong mọi Embedded WebView bằng lỗi `403 disallowed_useragent`. Nhưng nếu đẩy người dùng ra trình duyệt ngoài (Chrome Custom Tabs) để đăng nhập, lúc quay lại app thì cookie `code_verifier` của PKCE đang nằm trong `WebView` chứ không nằm trong Custom Tab — quá trình đăng nhập sẽ thất bại!
- **Giải pháp chuẩn RFC 8252 (`OAuthLoopbackServer.java`):**
  1. `frontend/lib/supabase/auth-service.ts` (`resolveDefaultOAuthRedirectUrl`) nhận diện User-Agent `ViReadAndroid/` nên đặt `redirectTo` là `http://127.0.0.1:3000/auth/callback?viread_nonce=<nonce>`.
  2. `MainActivity` mở **Chrome Custom Tabs** (trình duyệt Chrome thật, được Google chấp nhận) và đồng thời khởi động máy chủ TCP tạm thời `OAuthLoopbackServer` chỉ lắng nghe trên `127.0.0.1:3000` (timeout 180s).
  3. Khi Google/Supabase xác thực xong và điều hướng về `http://127.0.0.1:3000/auth/callback?code=...&viread_nonce=...`, `OAuthLoopbackServer` kiểm tra khớp `viread_nonce`, trả `302 Location: viread://oauth-callback` để đóng Custom Tab gọn gàng, rồi chuyển `?code=...` vào lại **`WebView`**.
  4. `WebView` nạp `https://<origin>/auth/callback?code=...` — lúc này `WebView` đang giữ sẵn cookie `code_verifier`, nên `exchangeCodeForSession()` thành công mỹ mãn!

### 8.4 Cổng kiểm soát chất lượng APK (`android/scripts/`)

- `verify_frontend.py` & task Gradle `verifyLiveFrontend`: Kiểm tra trang web đích trước khi đóng gói APK (phải trả 200 hoặc redirect cùng origin sang `/login`, `/login` phải chứa `/_next/` và `viread`, tránh build nhầm vào trang GitHub Pages).
- `verify_apk_quality.py`: Dùng `aapt2`/`apksigner`/`zipfile` kiểm tra trực tiếp file `.apk` đầu ra: đủ icon `160..640` dpi, `minSdk >= 26`, `targetSdk == 35`, `usesCleartextTraffic == false`, `allowBackup == false`, chữ ký hợp lệ và **không rò rỉ** secret, URL loopback hay URL giữ chỗ.

---

## Phần 9: Triển khai (Deployment), Cron, CI/CD & Hệ thống Kiểm thử

### 9.1 Kiến trúc vận hành trên gói Miễn phí (Free-Tier Engineering)

1. **Frontend trên Vercel Hobby (`frontend/vercel.json`):**
   - Đặt `"regions": ["sin1"]` (Singapore) để nằm cùng khu vực Đông Nam Á với Render và Supabase, giảm độ trễ mạng.
   - `buildCommand: "npm run build:hosting"` chạy `frontend/scripts/verify-hosting-env.mjs` trước khi build: từ chối ngay nếu thiếu `NEXT_PUBLIC_*`, dùng `http://` không an toàn, lộ `service_role` key, hay còn bật `PLAYWRIGHT_AUTH_FIXTURES`.
   - Vercel Cron chạy 1 lần/ngày lúc `0 2 * * *` (02:00 UTC = **09:00 sáng giờ Việt Nam**), gọi `/api/cron/parent-emails` (`maxDuration = 60`, retry lỗi `502`/`504` qua `35s + 20s` để vượt qua lúc Render đang ngủ dậy).
2. **Backend trên Render Free (`capstone1-ssd8.onrender.com`):**
   - Chạy `uvicorn app.sever:app --host 0.0.0.0 --port "$PORT" --workers 1`, kết nối Supabase qua Supavisor port `6543` (`NullPool`, `statement_cache_size=0`, `DATABASE_CONCURRENCY_LIMIT=8`).
   - **Giữ ấm 24/7 (Keep-Alive):** Render Free sẽ cho server ngủ sau 15 phút không có traffic. Workflow `.github/workflows/render-keepalive.yml` chạy mỗi **10 phút (`*/10 * * * *`)** gọi `GET /health` và kiêm luôn kích hoạt `POST /parent-notifications/cron/dispatch?scope=all` nếu có secret `PARENT_EMAIL_CRON_SECRET`.
   - **An toàn đa lớp Cron:** Dù Vercel Cron, GitHub Actions và worker nội bộ trong `sever.py` cùng kích hoạt song song, phụ huynh **không bao giờ nhận email trùng** nhờ ràng buộc `UNIQUE(dedupekey)` + `ON CONFLICT DO NOTHING` và `FOR UPDATE SKIP LOCKED` trên PostgreSQL.
3. **Công cụ hỗ trợ Local & LAN (`scripts/windows/`):**
   - `voice_worker.py` (`127.0.0.1:8010`): Worker STT/TTS local.
   - `lan-https-proxy.mjs` (`0.0.0.0:8443`): Reverse proxy TLS 1.2+ gom `/_viread_api/* -> 127.0.0.1:8000` và `/* -> 127.0.0.1:3000` về cùng một origin HTTPS để test điện thoại Android thật qua Wi-Fi LAN.

### 9.2 Tổng quan 12 GitHub Actions Workflows (`.github/workflows/`)

| Workflow | Vai trò chính |
|---|---|
| `backend-tests.yml` | Dựng Postgres 16 container, chạy `run_ci_tests.py` + job `real-ocr-quality` (`run_real_ocr_gate.py`). |
| `frontend-tests.yml` | Kiểm tra `verify-hosting-env.test.mjs`, Prettier, ESLint, `tsc --noEmit`, 183 Vitest, Playwright `Admin OCR draft`, `npm run build`. |
| `admin-book-crud-verification.yml` | Chạy đầy đủ Vitest + build + `playwright.real-data.config.ts` E2E. |
| `admin-books-ocr-full-verification.yml` | Kiểm tra format theo diff + toàn bộ lint/typecheck/tests/build cho module Admin OCR. |
| `android-apk.yml` | Job `android-validation` chạy unit test Robolectric + Java compile + Lint + `test_verify_frontend.py`; job `android-apk` build APK Debug nếu đã cấu hình `VIREAD_FRONTEND_URL`. |
| `render-keepalive.yml` | Ping `/health` mỗi 10 phút giữ ấm Render + tùy chọn kích hoạt gửi email phụ huynh. |
| `repository-hygiene.yml` | Chạy `validate_agent_config.py` và `verify_repository_hygiene.py`. |
| `required-ci-contract.yml` | Chạy `test_required_ci_contract.py` bảo đảm các bước kiểm tra bắt buộc không bị lén tắt. |
| `supabase-security-hardening.yml` | Dựng Postgres 17 tạm để chạy `supabase/tests/security_hardening_disposable.sql` (chống leo thang quyền `profiles`). |
| `supabase-query-index-performance.yml` | Dựng Postgres 17 tạm để chạy `supabase/tests/reading_query_indexes_disposable.sql` kiểm tra index truy vấn đọc sách. |
| `project-dashboard-pages.yml` | Kiểm tra và xuất bản `project-dashboard/` lên GitHub Pages hàng giờ. |
| `format-admin-ocr.yml` | Tự động format mã nguồn trên nhánh tính năng OCR. |

### 9.3 Ma trận Kiểm thử đa tầng & Lưu ý khi chạy trên Windows

- **Backend:** Tổng **144** file `test_*.py` (**141** file ở root `backend/` + **1** file ở `backend/test/test_vietnamese_tts_normalizer.py` + **2** file ở `backend/tests/`: `test_local_ocr_contract.py`, `test_local_ocr_inference.py`).
  - `backend/scripts/run_ci_tests.py` cấm test tự ý skip (chỉ 4 lớp test cần engine/model thật được phép bỏ qua có kiểm soát; `unittest discover` chạy 141 file tại root `backend/`).
  - `backend/tests/test_local_ocr_inference.py` kiểm tra toàn vẹn SHA-256 + ngưỡng khóa của **14 ảnh fixture OCR tổng hợp** (`7 dev` + `7 holdout`) tại `tests/fixtures/ocr/manifest.json` (tạo xác định bởi `tests/fixtures/ocr/generate_fixtures.py`), tách biệt với `backend/scripts/run_real_ocr_gate.py` (yêu cầu đúng 14 test OCR thực tế pass 0 skip).
- **Frontend:** **183** file test đơn vị Vitest (`frontend/test/`, `frontend/tests/`) + **1** Node test (`verify-hosting-env.test.mjs`) + **30** file E2E Playwright chạy trên **7 file cấu hình** (`playwright.config.ts`, `playwright.real-data.config.ts`, `playwright.reading.config.ts`, `playwright.tts.config.ts`, `playwright.parent-private-books.config.ts`, `playwright.mobile-android.config.ts`, `playwright.real-lan.config.ts`).
- **Android:** **7** bộ test Robolectric/JUnit4 + **2** bộ test Python (`test_verify_frontend.py`, `test_verify_apk_quality.py`) + **`scripts/windows/Run-ViReadUsbE2E.mjs`** (13 kịch bản kiểm thử tự động trên điện thoại Android thật qua USB ADB + WebView CDP).
- **Cloud, Dashboard & SQL:** `cloud/colab-enterprise-dispatcher/test_service.py`, 3 test `*.test.cjs` của `project-dashboard/` và 2 test SQL trên Postgres 17 (trong đó `supabase/tests/reading_query_indexes_disposable.sql` còn kiểm thử idempotent **2 lần** file rollback thủ công `supabase/rollbacks/20261120140000_reading_query_indexes_cleanup_rollback.sql`).
- **Khởi tạo & chạy local trên Windows:** Dùng `requirements.ps1` (cài Python 3.12, Node >= 22.13, Tesseract 5 + `backend/tessdata/`, Ollama `qwen3-vl:4b-instruct-q4_K_M`, `backend/.venv`, `npm ci`) và `start-dev.ps1` (khởi chạy đồng thời Voice Worker + Backend + Frontend).

> **Cảnh báo vận hành trên Windows:** Tuyệt đối chạy `pytest` (Backend) và `Vitest` (Frontend) **tuần tự**, không chạy song song cùng lúc trên Windows để tránh lỗi cạn bộ nhớ `libjpeg: Insufficient memory (case 4)` trong `test_document_rasterizer_and_upload.py`.

---

## Phần 10: Bộ câu hỏi & Gợi ý trả lời bảo vệ đồ án (Q&A) + Cheat Sheet 60 giây

### Nhóm 1: Kiến trúc & Lựa chọn công nghệ

#### Câu 1: Tại sao em tách hệ thống thành Next.js + FastAPI + Supabase thay vì viết nguyên một ứng dụng Next.js gọi thẳng Supabase?
- **Giảng viên đang kiểm tra điều gì?** Tư duy kiến trúc tách lớp, hiểu rõ giới hạn của trình duyệt/Node.js so với Python AI.
- **Trả lời ngắn gọn (20–30 giây):** Dạ vì ViRead có khối xử lý thị giác máy tính và AI rất nặng bằng Python như PaddleOCR, VietOCR, OpenCV ORB và điều phối giọng nói Sherpa-ONNX/VieNeu-TTS mà trình duyệt hay Next.js Node.js không chạy hiệu quả được. Tách FastAPI làm Backend chuyên biệt còn giúp giữ toàn bộ API key AI, khóa quản trị Supabase và logic tính điểm chuẩn hóa tập trung ở một nơi an toàn.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Frontend Next.js 16 (`frontend/`) chỉ phụ trách giao diện, SSR bảo vệ route (`proxy.ts`) và gọi API qua `api-client.ts` (có Zod kiểm tra dữ liệu). Toàn bộ xử lý nặng (`ocr_engine.py`, `document_rasterizer_service.py`, `voice_orchestrator.py`, `text_alignment.py`) nằm trong `backend/app/services/`, giao tiếp với DB qua SQLAlchemy Async (`backend/app/sever.py`).

#### Câu 2: Tại sao file entrypoint Backend lại tên là `sever.py` (thiếu chữ `r`)? Có phải lỗi chính tả quên sửa không?
- **Giảng viên đang kiểm tra điều gì?** Em có thực sự đọc hiểu mã nguồn mình nộp hay chỉ copy từ AI mà không để ý chi tiết.
- **Trả lời ngắn gọn (20–30 giây):** Dạ đó là tên tệp lịch sử từ đầu dự án (`backend/app/sever.py`) và được nhóm cố ý giữ nguyên làm chuẩn bất biến (`app.sever:app`). Vì hàng loạt test suite, script khởi chạy và tài liệu triển khai Render đều import từ `app.sever`, việc đổi tên tùy tiện sẽ làm gãy dây chuyền CI/CD.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Quy tắc giữ nguyên `backend/app/sever.py` được ghi rõ trong `backend/AGENTS.md` và `Agent.md`; lệnh chạy production là `uvicorn app.sever:app` (đối chiếu `docs/RENDER_SUPABASE_DEPLOYMENT.md`).

#### Câu 3: File `reading-socket-adapter.ts` tên là "socket" nhưng bên trong lại không mở WebSocket thật, vậy việc bé đọc bài realtime hoạt động kiểu gì?
- **Giảng viên đang kiểm tra điều gì?** Em có nắm được luồng dữ liệu thật hay bị tên file đánh lừa.
- **Trả lời ngắn gọn (20–30 giây):** Dạ `reading-socket-adapter.ts` thực chất chỉ là bộ điều phối trạng thái giao diện ở phía client (chuyển giữa các trạng thái `LISTENING`, `PAUSED`, `FINISHED`, `ABORTED`). Còn dữ liệu phiên đọc thật, gửi âm thanh nhận diện từng đoạn, đánh vần và lưu kết quả so khớp đều chạy qua các API HTTP REST và `WEBSOCKET /voice/stt-stream` của Backend.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Kiểm tra `frontend/lib/api/reading-socket-adapter.ts` (`createReadingSocketAdapter`) thấy không tạo `new WebSocket()`. Trong khi đó `ReadingScreen` (`frontend/components/reading/reading-screen.tsx`) dùng `LocalSegmentSpeechRecognition` gửi phân đoạn audio tới `POST /voice/speech-to-text`, đối chiếu từ bằng `RealtimeAlignmentEngine`, lưu sự kiện qua `POST /reading/events` và chốt báo cáo qua `POST /reading/sessions/{session_id}/compare`.

#### Câu 4: Tại sao Backend có chuẩn phân tầng `BACKEND_FLOW_STANDARD.md` nhưng trong `system.py` vẫn thấy Repository và Service nằm chung?
- **Giảng viên đang kiểm tra điều gì?** Sự trung thực về nợ kỹ thuật (technical debt) và khả năng đọc code thực tế.
- **Trả lời ngắn gọn (20–30 giây):** Dạ `BACKEND_FLOW_STANDARD.md` là chuẩn kiến trúc mục tiêu mà hầu hết 21 router mới (như sách riêng, quản lý đọc, karaoke, huấn luyện OCR) tuân thủ nghiêm ngặt: Router → Schema → Service → Repository → Model. Riêng `system.py` chứa một số module ra đời sớm (legacy reports/progress/health) vẫn giữ cấu trúc cũ để tránh xáo trộn test khi chưa tái cấu trúc.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Ngay đầu `BACKEND_FLOW_STANDARD.md` đã nêu rõ đây là tài liệu chuẩn tham chiếu và yêu cầu kiểm tra code thật. Trong `backend/app/api/routes/system.py` có `LegacyReportRepository`, `ProgressService`, `AdminSystemService`, còn các module mới như `reading_management.py`, `parent_private_book.py`, `karaoke.py` tách đủ 5 thư mục `routes/`, `schemas/`, `services/`, `repositories/`, `models/`.

---

### Nhóm 2: Xác thực, Bảo mật & Phân quyền (RBAC)

#### Câu 5: Nếu người dùng tự mở DevTools sửa `user_metadata.role` thành `"admin"`, họ có vào được trang Admin không?
- **Giảng viên đang kiểm tra điều gì?** Hiểu bản chất bảo mật JWT vs DB-backed RBAC.
- **Trả lời ngắn gọn (20–30 giây):** Dạ tuyệt đối không ạ. Vì cả Frontend SSR lẫn Backend FastAPI không bao giờ tin vai trò nằm trong JWT metadata. Hệ thống chỉ lấy ID người dùng (`sub`) từ token đã xác thực, sau đó truy vấn thẳng bảng `public.profiles` trong PostgreSQL để kiểm tra cột `role` và `active = 1`.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Ở Frontend, `frontend/lib/auth/server-authorization.ts` (`getAppIdentity()`) gọi `supabase.auth.getClaims()` lấy `sub` rồi query `public.profiles` (`select("role, active")`). Ở Backend, `backend/app/api/deps.py` (`_require_database_role()`) kiểm tra `Profile.Role` và `Profile.Active == 1`. Ngoài ra migration `20261120100000_supabase_security_hardening.sql` chỉ cấp quyền cho user `authenticated` được `UPDATE` đúng 3 cột `(displayname, contact_phone, avatar_path)` trên `profiles`, khóa hoàn toàn cột `role` và `active`.

#### Câu 6: Tại sao ảnh sách lưu trên Supabase Storage mà không lưu luôn URL công khai vào database cho nhanh?
- **Giảng viên đang kiểm tra điều gì?** Bảo mật tài nguyên đa phương tiện và bản quyền / quyền riêng tư sách gia đình.
- **Trả lời ngắn gọn (20–30 giây):** Dạ vì cả 4 bucket trên Supabase (kể cả sách riêng của phụ huynh và ảnh bé) đều là **Private Bucket**. Nếu dùng URL công khai thì bất kỳ ai có link đều xem được ảnh sách riêng của gia đình khác. DB chỉ lưu đường dẫn tương đối (`object path`), khi cần xem mới sinh **Signed URL sống ngắn 3600 giây** hoặc tải qua luồng có Bearer token.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `backend/app/services/storage_service.py` đặt `SIGNED_URL_TTL_SECONDS = 3600`. Với sách riêng phụ huynh và hàng đợi duyệt, Frontend dùng `fetchAuthenticatedBlobUrl` (`frontend/lib/api/api-client.ts`) tải ảnh bằng `Authorization: Bearer` vào RAM (`URL.createObjectURL`) và xóa ngay khi đăng xuất.

#### Câu 7: Phụ huynh tải ảnh sách riêng của nhà mình lên (`my-books`), làm sao chắc chắn phụ huynh khác không xem trộm được hoặc sách đó tự chui ra kho công khai?
- **Giảng viên đang kiểm tra điều gì?** Cô lập dữ liệu đa người dùng (multi-tenant isolation).
- **Trả lời ngắn gọn (20–30 giây):** Dạ có 3 lớp chặn: (1) ở API/Service luôn kiểm tra `VisibilityScope == 'PARENT_PRIVATE'` và `OwnerParentId == actor_id`; (2) ở Database có trigger `prevent_private_book_catalog_promotion()` chặn việc đổi trạng thái sách riêng thành sách công khai sai quy trình; (3) ảnh lưu ở bucket riêng `viread-private-books` và chỉ tải qua endpoint xác thực chính chủ.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Chính sách nằm ở `backend/app/policies/book_access.py`, `backend/app/services/parent_private_book_service.py` và trigger `public.prevent_private_book_catalog_promotion()` trong `supabase/migrations/`.

#### Câu 8: Làm sao ngăn các AI bên ngoài (như Gemini/Groq) đọc trộm sách riêng của gia đình khi sửa lỗi OCR?
- **Giảng viên đang kiểm tra điều gì?** Quyền riêng tư dữ liệu khi tích hợp Cloud LLM.
- **Trả lời ngắn gọn (20–30 giây):** Dạ hệ thống có cấu hình tách biệt cho sách riêng: mặc định `PRIVATE_BOOK_ALLOW_CLOUD_AI=false`, toàn bộ bước AI sửa lỗi OCR cho sách gia đình chỉ chạy trên mô hình **Ollama cục bộ** (`127.0.0.1:11434`), không gửi văn bản hay hình ảnh ra ngoài Internet trừ khi người vận hành chủ động cho phép.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Hàm `OcrCorrectionConfig.private_book_allow_cloud_ai()` và `local_only_copy()` trong `backend/app/services/ocr_ai/config.py`.

---

### Nhóm 3: Cơ sở dữ liệu, Supavisor & Dữ liệu tiến độ thực tế

#### Câu 9: Tại sao kết nối Supabase lại phải cấu hình cổng `6543`, tắt `statement_cache_size=0` và không dùng `pg_try_advisory_lock`?
- **Giảng viên đang kiểm tra điều gì?** Kinh nghiệm xử lý bài toán kết nối Pooler trong triển khai thực tế.
- **Trả lời ngắn gọn (20–30 giây):** Dạ vì Backend trên Render Free chỉ đi ra ngoài bằng IPv4 nên phải qua **Supavisor Transaction Pooler cổng 6543**. Ở chế độ transaction pooler, các câu lệnh có thể nhảy sang các kết nối Postgres vật lý khác nhau, nên nếu giữ prepared statement cache hay advisory lock mức session sẽ bị lỗi hoặc treo khóa. Vì vậy bọn em bắt buộc tắt cache (`statement_cache_size=0`) và dùng khóa hàng nguyên tử trong từng transaction.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `backend/app/database/config.py` ép `DATABASE_POOLER_MODE=transaction` và cổng `6543` khi `APP_ENVIRONMENT=production`. `backend/app/database/session.py` đặt `statement_cache_size=0` + `prepared_statement_cache_size=0`, dùng `NullPool` cho test/loopback, và bọc session trong `ConcurrencyLimitedAsyncSession` (giới hạn `DATABASE_CONCURRENCY_LIMIT = 8`, chỉ giữ slot trong lúc chạy SQL). Các worker dùng `FOR UPDATE SKIP LOCKED` và `ON CONFLICT DO NOTHING`.

#### Câu 10: Trong Database có bảng `fluencyassessments` nhưng sao phần tính điểm tiến độ đọc lại không lấy dữ liệu từ đó?
- **Giảng viên đang kiểm tra điều gì?** Em có nắm được cấu trúc dữ liệu thật chạy trong hệ thống không hay chỉ đọc tên bảng rồi đoán.
- **Trả lời ngắn gọn (20–30 giây):** Dạ `fluencyassessments` là bảng thiết kế từ giai đoạn đầu nhưng trong dữ liệu vận hành thực tế của Supabase không có bản ghi nào. Luồng đọc thật ghi kết quả đối chiếu từng trang vào `readingcomparisonreports` (cột JSON `Summary` có `assessment_version=1` và `initial_assessment`) và ghi các lần bé đọc lại vào `readingevents` (`Type='WORD_RETRY'`). Vì thế hệ thống tổng hợp từ 2 nguồn thật này để báo cáo chính xác.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Logic chuẩn hóa nằm tại `aggregate_assessment()` trong `backend/app/services/reading_assessment.py` và `backend/app/services/child_progress/metrics.py` (`ReportRow`, `RetryEventRow`).

#### Câu 11: Nếu dùng Gemini để nhận xét tiến độ học tập của bé, làm sao biết AI không "bịa" điểm cao hoặc thay đổi số liệu thật?
- **Giảng viên đang kiểm tra điều gì?** Kiến trúc chống ảo giác (hallucination) của LLM trong chấm điểm giáo dục.
- **Trả lời ngắn gọn (20–30 giây):** Dạ AI tuyệt đối **không chấm điểm** ạ. Toàn bộ điểm số, tỷ lệ đọc đúng, số từ bỏ sót và danh sách từ khó đều được hàm Python thuần tính toán tất định từ DB. Gemini/Groq chỉ được nhận bản tóm tắt số liệu ẩn danh để viết thành lời nhận xét dễ hiểu cho phụ huynh, và prompt khóa cứng quy tắc không được tự đổi số.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `backend/app/services/child_progress/metrics.py` ghi rõ triết lý *"Everything here is deterministic and has no I/O, so the numbers shown to parents never depend on an AI model"*; `backend/app/services/child_progress/ai.py` (`SYSTEM_PROMPT`) chỉ nhận aggregate metrics ẩn danh (không gửi tên bé/phụ huynh).

#### Câu 12: Nếu bé thoát ngang giữa buổi đọc hoặc bấm đọc lại cùng một trang nhiều lần, số liệu thống kê có bị thổi phồng không?
- **Giảng viên đang kiểm tra điều gì?** Xử lý các trường hợp biên (edge cases) của dữ liệu thời gian thực.
- **Trả lời ngắn gọn (20–30 giây):** Dạ không ạ. Hệ thống chặn cả hai tình huống này: (1) thời lượng mỗi phiên đọc bị giới hạn trần tối đa `MAX_SESSION_MINUTES = 90` phút để một phiên quên tắt không làm lệch tổng giờ đọc; (2) khi tổng hợp điểm *first-pass*, `aggregate_assessment` chỉ lấy snapshot `assessment_version=1` **đầu tiên** cho mỗi cặp `(PageId, PageRevisionId)` nên việc đọc lại không ghi đè thành tích ban đầu.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `MAX_SESSION_MINUTES = 90` tại `backend/app/services/child_progress/metrics.py:20` và vòng lặp `for report in reversed(reports): if page_key in pages: continue` tại `backend/app/services/reading_assessment.py:58-65`.

---

### Nhóm 4: AI, OCR, Giọng nói & Huấn luyện mô hình

#### Câu 13: Tại sao OCR lại kết hợp cả PaddleOCR lẫn VietOCR, và còn giữ thêm Tesseract làm gì?
- **Giảng viên đang kiểm tra điều gì?** Hiểu thế mạnh/điểm yếu của từng engine OCR với tiếng Việt.
- **Trả lời ngắn gọn (20–30 giây):** Dạ vì PaddleOCR phát hiện khung dòng chữ (DBNet) rất tốt trên ảnh chụp sách nghiêng hoặc nhiều cột, nhưng nhận diện dấu thanh tiếng Việt không bằng **VietOCR (`vgg_transformer`)**. Ngược lại VietOCR chỉ đọc được từng dải chữ đã cắt sẵn. Vì vậy ViRead dùng PaddleOCR dò khung → `sort_reading_order_adaptive` nắn thẳng dòng → VietOCR đọc chữ có dấu → và giữ **Tesseract (`backend/tessdata/vie.traineddata` khi cài runtime cục bộ, không commit trong Git)** làm phương án dự phòng nếu môi trường thiếu thư viện nặng.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Hàm `_extract_text_and_boxes_dual_engine`, `sort_reading_order_adaptive`, và `_extract_text_and_boxes_tesseract` trong `backend/app/services/ocr_engine.py`, kết hợp đối chiếu từ chọn lọc trong `ocr_adjudication.py` và `ocr_evidence.py`.

#### Câu 14: Tại sao không gọi `import torch`, `paddleocr` ngay đầu file `ocr_engine.py` cho gọn?
- **Giảng viên đang kiểm tra điều gì?** Quản lý bộ nhớ và khởi động dịch vụ trên cloud miễn phí.
- **Trả lời ngắn gọn (20–30 giây):** Dạ vì Render Free chỉ cấp **512 MiB RAM**. Nếu import `torch` và `PaddleOCR` ngay lúc khởi động FastAPI, server sẽ bị tràn RAM (OOM) trước khi kịp mở cổng HTTP. Dùng **lazy import** bên trong `_get_ocr_engines()` giúp API khởi động nhẹ nhàng, đồng thời giúp các bộ test CI không cần cài GPU/PaddleOCR vẫn chạy pass 100%.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** Ghi chú và biến module `torch = None; PaddleOCR = None; Cfg = None; Predictor = None` ngay tại `backend/app/services/ocr_engine.py:59-70`.

#### Câu 15: Tại sao hệ thống giọng nói (`voice_worker.py`) phải chạy ở tiến trình riêng trên cổng `8010` thay vì import thẳng vào FastAPI?
- **Giảng viên đang kiểm tra điều gì?** Xử lý xung đột dependency (ABI conflict) và kiến trúc Local-First.
- **Trả lời ngắn gọn (20–30 giây):** Dạ có 2 lý do: thứ nhất là **xung đột ABI** — OCR trên Backend khóa chặt `numpy==1.26.4` và `protobuf==3.20.2` cho PaddlePaddle 2.6.2, trong khi Sherpa-ONNX và VieNeu-TTS lại cần bộ thư viện khác nên phải cách ly thành venv riêng; thứ hai là giữ giọng đọc của bé **xử lý cục bộ trước (`local_only`)**, thay thế `webkitSpeechRecognition` của trình duyệt, chỉ fallback lên Google Cloud khi xảy ra lỗi kỹ thuật chứ không phải khi bé đọc sai.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `scripts/windows/voice_worker.py`, `backend/app/services/voice_orchestrator.py` (`VoiceOrchestrator`, `SessionVoiceLock` thực thi luật *"Một buổi, một giọng"*), và `frontend/lib/reading/local-segment-speech-recognition.ts`.

#### Câu 16: Quy trình tự cải tiến mô hình ViOCR V2 (Flow 1 & Flow 2) đảm bảo mô hình mới không bị "học ngu đi" và không bị lỗi mạng khi train trên Colab Free như thế nào?
- **Giảng viên đang kiểm tra điều gì?** Tính khép kín và an toàn của vòng đời MLOps trong dự án.
- **Trả lời ngắn gọn (20–30 giây):** Dạ mô hình mới không bao giờ tự động thay thế mô hình đang chạy. Colab Worker huấn luyện xong bắt buộc phải chạy qua cổng kiểm tra **Locked Test** (tối thiểu 200 cặp mẫu, 30 nhóm tách biệt không rò rỉ dữ liệu) và chờ **Admin bấm duyệt** mới cập nhật `viread_ocr_active_model`. Còn để sống sót trên Colab Free hay bị ngắt và Render Free hay lỗi Cloudflare `520–530`, `colab_worker.py` giới hạn tải song song `ARTIFACT_DOWNLOAD_WORKERS = 2`, tự retry các mã 5xx và lưu resume state lên Google Drive.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `ai/vietocr_v2/colab_worker.py` (`verify_worker_source_lock`, `ARTIFACT_DOWNLOAD_WORKERS = 2`), `backend/app/services/viread_ocr_training_service.py` (`MIN_LOCKED_PAIRS=200`, `MIN_LOCKED_GROUPS=30`), `ai/vietocr_v2/quality_gate.py` (`GatePolicy(min_pairs=200, min_groups=30)`), bảng `viread_ocr_outbox` và `viread_ocr_active_model`.

#### Câu 17: Tính năng quét trang sách giấy bằng camera (`/book-scanner`) hoạt động ra sao khi không dùng LLM tốn tiền cho từng khung hình?
- **Giảng viên đang kiểm tra điều gì?** Tối ưu chi phí và tốc độ phản hồi thời gian thực.
- **Trả lời ngắn gọn (20–30 giây):** Dạ thay vì gửi từng frame camera lên AI đọc chữ hay gọi LLM (rất chậm và tốn tiền), hệ thống dùng thuật toán thị giác máy tính cổ điển **OpenCV ORB (`nfeatures=1000`) + BFMatcher + RANSAC** so khớp điểm đặc trưng trực tiếp với `FeaturePath` của các trang sách đã lập chỉ mục sẵn, chỉ gửi frame khi ảnh đủ nét (Laplacian >= 60), đủ sáng (>= 50) và có mật độ cạnh chữ rõ ràng (>= 0.015).
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `ai/vision/page_matcher.py` (`ViReadPageMatcher`), `frontend/components/reading/camera-preview.tsx` (`AUTO_SCAN_COOLDOWN_MS = 1800`), và endpoint `POST /reading/match-page`.

---

### Nhóm 5: Android WebView & OAuth Loopback

#### Câu 18: Tại sao không dùng `output: "export"` của Next.js đóng gói thẳng vào app Android (Capacitor) cho nhanh, đỡ phụ thuộc mạng?
- **Giảng viên đang kiểm tra điều gì?** Hiểu sự gắn kết giữa Next.js SSR, Cookie Auth và môi trường Mobile.
- **Trả lời ngắn gọn (20–30 giây):** Dạ vì ViRead bảo mật phân quyền ngay ở **Server Component & Proxy của Next.js 16** (`proxy.ts`, `requireAppRole()` trong `server-authorization.ts`, đổi mã PKCE ở `/auth/callback`). Nếu export thành HTML tĩnh nhét vào app thì toàn bộ tầng bảo vệ server và cơ chế cookie theo domain sẽ mất tác dụng. Nên dùng Native Java WebView trỏ về HTTPS server giúp giữ nguyên 100% bảo mật và đồng bộ cập nhật tức thì.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `android/README.md`, `frontend/next.config.ts` (không dùng `output: "export"`), `android/app/src/main/java/vn/viread/android/TrustedNavigation.java`.

#### Câu 19: Google chặn đăng nhập OAuth trong Android WebView (`403 disallowed_useragent`), em giải quyết thế nào mà vẫn giữ được bảo mật PKCE?
- **Giảng viên đang kiểm tra điều gì?** Hiểu sâu về OAuth 2.0 PKCE và RFC 8252 trên di động.
- **Trả lời ngắn gọn (20–30 giây):** Dạ bọn em cài cơ chế **RFC 8252 Loopback Bridge**: khi app thấy User-Agent `ViReadAndroid/`, OAuth chuyển hướng qua trình duyệt **Chrome Custom Tabs** (được Google tin cậy) với `redirectTo` trỏ về `http://127.0.0.1:3000/auth/callback?viread_nonce=...`. Máy chủ tạm `OAuthLoopbackServer` trong app Android bắt `code`, kiểm tra khớp `viread_nonce`, đóng Custom Tab bằng `302 viread://oauth-callback`, rồi nạp lại `/auth/callback?code=...` vào chính `WebView` — nơi đang giữ cookie `code_verifier` của PKCE — để hoàn tất phiên đăng nhập.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `android/app/src/main/java/vn/viread/android/OAuthLoopbackServer.java`, `MainActivity.java`, và `resolveDefaultOAuthRedirectUrl()` trong `frontend/lib/supabase/auth-service.ts`.

#### Câu 20: Nếu bé đang thu âm đọc sách trên Android mà có cuộc gọi đến hoặc bấm nút Home thoát ra ngoài, micro có bị kẹt không?
- **Giảng viên đang kiểm tra điều gì?** Trải nghiệm người dùng di động và xử lý vòng đời hệ điều hành.
- **Trả lời ngắn gọn (20–30 giây):** Dạ không ạ. `MainActivity.java` lắng nghe `AudioFocusRequest`, `ACTION_AUDIO_BECOMING_NOISY` và vòng đời dừng Activity để phát sự kiện DOM `viread:android-background` vào WebView. Phía Frontend (`useSpeechRecorder`, `CameraPreview`) bắt sự kiện này để dừng `MediaRecorder` và ngắt toàn bộ track micro/camera ngay lập tức.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `android/app/src/main/java/vn/viread/android/MainActivity.java` và listener `viread:android-background` trong `frontend/components/reading/camera-preview.tsx` / `frontend/hooks/use-speech-recorder.ts`.

---

### Nhóm 6: Triển khai Free-Tier, Cron & Hiệu năng

#### Câu 21: Render Free hay bị ngủ sau 15 phút (cold start mất 30–60 giây), hệ thống làm thế nào để không bị timeout khi phụ huynh dùng app hoặc khi Cron chạy?
- **Giảng viên đang kiểm tra điều gì?** Tính thực chiến khi triển khai hệ thống trên hạ tầng miễn phí.
- **Trả lời ngắn gọn (20–30 giây):** Dạ bọn em phối hợp 4 giải pháp đồng thời: (1) GitHub Actions `render-keepalive.yml` ping `/health` mỗi **10 phút** để giữ server thức; (2) Android đặt timeout tới **90 giây** (`LOAD_TIMEOUT_MS = 90_000L`) kèm 3 mốc thông báo tiến trình tiếng Việt; (3) Route Cron trên Vercel đặt `maxDuration = 60` giây, đồng vị trí `sin1` Singapore và tự retry `502`/`504`; (4) FastAPI hoãn các background worker **12 giây** lúc mới bật để request của người dùng vào trước không bị nghẽn.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `.github/workflows/render-keepalive.yml`, `android/app/src/main/java/vn/viread/android/MainActivity.java`, `frontend/vercel.json` (`"regions": ["sin1"]`), `frontend/app/api/cron/parent-emails/route.ts`, và `_background_worker_startup_delay_seconds()` trong `backend/app/sever.py`.

#### Câu 22: Hệ thống có tới mấy nguồn kích hoạt Cron gửi email (Worker trong Render, Vercel Cron, GitHub Actions), vậy phụ huynh có bị gửi trùng 3 email giống nhau không?
- **Giảng viên đang kiểm tra điều gì?** Tư duy idempotency và xử lý đồng thời (concurrency) trong hệ thống phân tán.
- **Trả lời ngắn gọn (20–30 giây):** Dạ chắc chắn không trùng ạ. Mọi lớp kích hoạt đều gọi chung vào logic trong PostgreSQL sử dụng **khóa nguyên tử ở cấp bảng**: bảng `parentemaildeliveries` có ràng buộc `UNIQUE(dedupekey)` kèm `ON CONFLICT DO NOTHING`, còn các hàng đợi nhắc đọc và vắng khung hình dùng `FOR UPDATE SKIP LOCKED` để hai tiến trình song song không bao giờ lấy trúng cùng một việc. Ngoài ra còn có khung giờ yên tĩnh `21:00–07:00` và trần tối đa 4 email/tuần.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `backend/app/jobs/parent_email_dispatcher_worker.py`, `backend/app/services/parent_email_notification_service.py`, `backend/app/repositories/parent_email_notification_repository.py`.

---

### Nhóm 7: Hạn chế, Đánh đổi & Hướng phát triển

#### Câu 23: Hệ thống hiện tại có những hạn chế hay điểm đánh đổi nào? (Câu hỏi "thử độ trung thực" rất hay gặp!)
- **Giảng viên đang kiểm tra điều gì?** Khả năng đánh giá khách quan đồ án, không "tô hồng" sản phẩm.
- **Trả lời ngắn gọn (20–30 giây):** Dạ có 4 hạn chế thực tế bọn em nhận diện rõ trong mã nguồn: (1) Để chạy miễn phí trên Render Free 512 MiB, OCR nặng phải lazy-load và đôi khi bị trễ ở lần quét đầu tiên; (2) Worker giọng nói cục bộ (`voice_worker.py`) hiện tối ưu cho máy Windows/local (`127.0.0.1:8010`), khi chạy thuần trên cloud không có GPU thì phải bật `GoogleCloudVoiceProvider` dự phòng; (3) Module tách nhạc & căn lời Karaoke tự động (`ai/karaoke_processing/`) mới ở mức thử nghiệm nghiên cứu và đang tắt mặc định (`KARAOKE_PROCESSING_ENABLED=false`); (4) Trên nhánh hiện tại, một số tài liệu cũ như `Agent.md` hay `docs/PARENT_EMAIL_AUTOMATION.md` chưa đồng bộ hoàn toàn với router thực tế.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `ai/karaoke_processing/README.md`, `backend/app/services/ocr_engine.py:59-61`, `backend/app/services/voice_orchestrator.py`, `Agent.md:1-4`.

#### Câu 24: Trong file `backend/app/services/ocr_engine.py` và các nơi khác có sử dụng tài nguyên thử nghiệm / fixture, làm sao để biết kết quả test của đồ án là thật chứ không phải "hardcode cho qua"?
- **Giảng viên đang kiểm tra điều gì?** Độ tin cậy của quy trình kiểm thử (QA) và chống gian lận test.
- **Trả lời ngắn gọn (20–30 giây):** Dạ hệ thống kiểm thử của ViRead có cơ chế **chặn skip gian lận (`run_ci_tests.py`)** và cổng kiểm tra chất lượng **Real OCR Gate (`run_real_ocr_gate.py`)** ép 14 test OCR tổng hợp chạy thật với 0 skip. Ngoài ra bọn em có 30 file Playwright E2E (bao gồm cả cấu hình chạy trực tiếp với Backend & DB thật không mock ở `playwright.real-data.config.ts` và trên điện thoại Android thật qua USB ADB ở `Run-ViReadUsbE2E.mjs`).
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `backend/scripts/run_ci_tests.py`, `backend/scripts/run_real_ocr_gate.py`, `frontend/playwright.real-data.config.ts`, `frontend/playwright.real-lan.config.ts`, `scripts/windows/Run-ViReadUsbE2E.mjs`.

#### Câu 25: Nếu được nâng cấp dự án lên phiên bản thương mại sau đồ án, 3 việc đầu tiên em sẽ làm là gì?
- **Giảng viên đang kiểm tra điều gì?** Tầm nhìn sản phẩm và hiểu biết về production scaling.
- **Trả lời ngắn gọn (20–30 giây):** Dạ thứ nhất là tách khối OCR/Voice sang một **GPU/CPU Worker Service riêng** (hoặc nâng cấp gói Render/Cloud Run trả phí, kích hoạt `cloud/colab-enterprise-dispatcher/`) để bỏ hoàn toàn độ trễ cold start 512 MiB; thứ hai là hoàn thiện đánh giá chất lượng thực tế và bật chính thức bộ căn lời Karaoke `ai/karaoke_processing/`; thứ ba là triển khai Vercel Pro/Enterprise (vì Vercel Hobby chỉ dùng cho học thuật phi thương mại) và thu thập thêm tập mẫu giọng trẻ em tiểu học Việt Nam để tinh chỉnh Sherpa-ONNX Zipformer.
- **Giải thích chi tiết & Dẫn chứng mã nguồn:** `docs/frontend-https-hosting-plan.md` (lưu ý giới hạn học thuật của Vercel Hobby), `cloud/colab-enterprise-dispatcher/` (đường ống Vertex AI sẵn sàng khi chuyển sang trả phí), `ai/karaoke_processing/`.

---

### Bảng Tra Nhanh (Cheat Sheet) 60 Giây Trước Giờ G

| Hạng mục | Con số / Tên chính xác cần nhớ (trên nhánh hiện tại) |
|---|---|
| **Entrypoint Backend** | `backend/app/sever.py` (`uvicorn app.sever:app`), gắn **21 route modules** tại root **`""`** (KHÔNG có `/api/v1`) + `GET /health` |
| **Cron Endpoint thực tế** | `POST /parent-notifications/cron/dispatch` (Frontend gọi qua `/api/cron/parent-emails` lúc `0 2 * * *`, `maxDuration = 60`, `regions: ["sin1"]`) |
| **Supavisor DB Pooler** | Cổng **`6543`**, `DATABASE_POOLER_MODE=transaction`, `statement_cache_size=0`, `NullPool` (test/loopback), `DATABASE_CONCURRENCY_LIMIT=8`, khóa nguyên tử `FOR UPDATE SKIP LOCKED` & `ON CONFLICT DO NOTHING` (CẤM session advisory lock) |
| **RBAC & Bảo mật** | `proxy.ts` + `server-authorization.ts` (`frontend`) & `deps.py` (`backend`) luôn tra **`public.profiles` (`role`, `active=1`)**; 4 Private Buckets (`SIGNED_URL_TTL_SECONDS = 3600`) |
| **Dữ liệu tiến độ thật** | Tổng hợp từ **`readingcomparisonreports`** (`assessment_version=1` + `initial_assessment`) + **`readingevents` (`WORD_RETRY`, `READ_EXAMPLE`)** trong `reading_assessment.py` & `child_progress/metrics.py` (`fluencyassessments` trống ngoài thực tế) |
| **OCR & Rasterizer** | Lazy import (`torch`, `PaddleOCR`, `VietOCR`) + Tesseract fallback (`backend/tessdata/vie.traineddata` cài cục bộ); DOCX chống zip-bomb (100 MB / 2000 entries); PDF 220 DPI; `numpy==1.26.4`, `protobuf==3.20.2` |
| **Voice Local-First** | `VoiceOrchestrator` + `voice_worker.py` trên **`127.0.0.1:8010`** (Sherpa-ONNX Zipformer STT + VieNeu-TTS v3 Turbo 48 kHz 3 miền + Đánh vần); `SessionVoiceLock` ("Một buổi, một giọng"); Google Cloud fallback chỉ khi lỗi kỹ thuật |
| **LLM Fail-Closed Chains** | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → Groq `qwen/qwen3.8-27b` → Ollama `qwen3-vl:4b-instruct-q4_K_M` (Private book mặc định chỉ chạy Ollama local) |
| **ViOCR V2 Training** | Flow 1 (`TRDG`) & Flow 2 (`viread_ocr_outbox` + Apps Script Drive Bridge + `colab_worker.py` retry Cloudflare `520–530`, `ARTIFACT_DOWNLOAD_WORKERS = 2`, Locked Test `>=200` cặp / `>=30` nhóm) |
| **Android Native Shell** | `vn.viread.android` (`minSdk 26`, `targetSdk 35`); OAuth Loopback **`127.0.0.1:3000/auth/callback`** + `viread_nonce` + Chrome Custom Tabs + `viread://oauth-callback`; timeout **90s**; sự kiện `viread:android-background` |
| **Quy mô Kiểm thử** | **144** backend `test_*.py` (141 root + 1 `test/` + 2 `tests/`), **183** Vitest, **30** Playwright specs (7 config), **7** Robolectric + **13** USB ADB E2E, **12** GitHub Workflows, **39** Supabase `.sql` migrations (+1 `.gitkeep`) *(chạy pytest & Vitest tuần tự trên Windows)* |
