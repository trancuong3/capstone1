# AGENT HANDOVER & ARCHITECTURE GUIDE (Agent.md)

> **MỤC TIÊU DÀNH CHO AI TIẾP QUẢN**:
> Tài liệu này cung cấp toàn bộ bối cảnh hệ thống, kiến trúc kỹ thuật, quy tắc bất khả xâm phạm (rules & guardrails), các luồng nghiệp vụ cốt lõi, và lịch sử các thay đổi quan trọng trên nhánh `tu`. Hãy đọc kỹ tài liệu này trước khi chỉnh sửa bất kỳ dòng code nào để **tránh gây hỏng project hoặc làm vỡ test suite**.

---

## 1. TỔNG QUAN DỰ ÁN (PROJECT OVERVIEW)

- **Tên dự án**: **ViRead / ReadAlong Vision** (Nền tảng hỗ trợ luyện đọc tiếng Việt cho trẻ em bằng AI và thị giác máy tính).
- **Mô hình hoạt động**:
  - **Frontend**: Next.js 16 (Turbopack, App Router, React 19, TypeScript, Tailwind CSS, Lucide icons, Vitest).
  - **Backend**: FastAPI (Python 3.10/3.12, Uvicorn, SQLAlchemy 2.0 Async với `asyncpg`, Pydantic V2).
  - **Cơ sở dữ liệu & Lưu trữ**: PostgreSQL (thông qua Supabase hoặc Supabase Self-hosted/PostgreSQL), Supabase Auth & Private Storage.
  - **Dịch vụ AI / Giọng nói**:
    - Dual-Engine OCR: PaddleOCR + VietOCR (nhận diện chữ tiếng Việt & bounding box), fallback tự động sang Tesseract OCR.
    - Speech-to-Text (STT) & Text-to-Speech (TTS): ElevenLabs Voice Provider với cơ chế fallback sang Browser Speech Recognition khi hết quota.
- **Git Branching Policy**:
  - Nhánh làm việc chính hiện tại: `tu` (remote `origin/tu`).
  - Nhánh gốc: `main` (remote `origin/main`).
  - **Luôn đảm bảo 100% test pass** trước khi push code lên `tu`.

---

## 2. QUY TẮC BẤT KHẢ XÂM PHẠM (CRITICAL GUARDRAILS & RULES)

### ⚠️ Quy tắc 1: Khóa chặt phiên bản thư viện Backend (Dependency Locking)
File [`backend/requirements.txt`](backend/requirements.txt) chứa các thư viện AI phụ thuộc rất nhạy cảm về ABI:
- **`numpy==1.26.4`**: **BẮT BUỘC KHÔNG NÂNG CẤP LÊN 2.x**. Nâng cấp lên NumPy 2.x sẽ làm vỡ C-API ABI của PaddlePaddle và PyTorch.
- **`protobuf==3.20.2`**: **BẮT BUỘC `< 4.0.0`** theo yêu cầu của PaddlePaddle 2.6.2.
- **`opencv-python-headless==4.10.0.84`**: Dùng bản `headless` để tránh xung đột thư viện GUI / DLL trên Windows và Linux runner.
- **`pytesseract==0.3.13`**: Bắt buộc hỗ trợ fallback OCR khi môi trường không có GPU/PaddleOCR.

### ⚠️ Quy tắc 2: Tên file Server Backend chính xác là `app.sever:app`
File entrypoint của FastAPI nằm tại:
`backend/app/sever.py` *(chú ý chính tả: `sever.py`, KHÔNG đổi thành `server.py` vì các test file, startup script, Dockerfile và workflow đều import từ `app.sever`)*.

### ⚠️ Quy tắc 3: Bảo vệ an toàn dữ liệu & Private Storage Supabase
- **Không bao giờ lưu signed URL tạm thời vào database**: Trường `bookpages.imagepath` **chỉ lưu object path tương đối** trong bucket Supabase (ví dụ: `books/{book_id}/pages/{page_id}.jpg`). Signed URL có thời hạn ngắn (15-60 phút) được sinh động khi API trả về cho Frontend.
- **Không để lộ key server-side**: `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` chỉ được đọc ở phía Backend. Không bao giờ đưa key này sang frontend hoặc commit vào git.
- **Che giấu chi tiết lỗi dịch vụ bên ngoài**: Các lỗi từ ElevenLabs hay Supabase phải được map thành mã an toàn (`SPEECH_UNAVAILABLE`, `STT_QUOTA_EXCEEDED`, `UNSUPPORTED_AUDIO`), không để lộ traceback hay payload nhạy cảm.

### ⚠️ Quy tắc 4: An toàn khi import OCR Engine
Trong [`backend/app/services/ocr_engine.py`](backend/app/services/ocr_engine.py):
- `pytesseract`, `paddleocr`, `vietocr`, `torch` phải được bọc trong khối `try...except ImportError` hoặc import lười (lazy import).
- Lý do: Tránh lỗi `ModuleNotFoundError` khi các test suite độc lập (như `test_admin_book_crud.py`) chạy trong môi trường CI rút gọn.

---

## 3. CÁC LUỒNG NGHIỆP VỤ CỐT LÕI (CORE DOMAIN WORKFLOWS)

### 1. Luồng OCR Sách của Admin (Admin Book OCR)
- **Upload**: Admin tạo sách (`/books/admin/catalog`) $\rightarrow$ upload trang ảnh (`POST /books/admin/catalog/{book_id}/pages`).
- **Engine xử lý**:
  - `DualEngineOcrService`: Sử dụng PaddleOCR để detect bounding boxes và VietOCR để nhận diện text tiếng Việt có dấu.
  - Fallback: Nếu không khả dụng, engine tự động chuyển sang `_extract_text_and_boxes_tesseract`.
  - Tọa độ bounding box: Chuẩn hóa theo tỷ lệ `[x, y, w, h]` từ `0.0` đến `1.0`.
- **Duyệt & Hiệu chỉnh**:
  - Tạo `pagerevisions` với trạng thái `NEEDS_REVIEW`.
  - Admin có thể sửa văn bản nháp (`PUT /books/admin/pages/{page_id}/revisions/{revision_id}/draft`).
  - Khi hoàn tất, admin xác minh (`POST /books/admin/pages/{page_id}/verify`) chuyển sang trạng thái `VERIFIED`.

### 2. Luồng Bé Luyện Đọc (Child Live Reading)
- **Giao diện**: [`frontend/components/reading/reading-screen.tsx`](frontend/components/reading/reading-screen.tsx) kết hợp [`book-page-viewer.tsx`](frontend/components/reading/book-page-viewer.tsx) và [`book-page-content.tsx`](frontend/components/reading/book-page-content.tsx).
- **Nhận diện giọng nói thời gian thực (Live STT)**:
  - Microphone thu âm qua `useSpeechRecorder`.
  - Callback live gửi utterance blob về API `/voice/speech-to-text`.
  - `verifySpokenWord`: So khớp từ bé vừa đọc với từ mục tiêu hiện tại (`currentWordId`).
  - Hỗ trợ **Lookahead ($+1$)** và chuẩn hóa tiếng Việt (`normalizeVietnamese`) để xử lý việc bé đọc lướt từ hoặc có từ đệm.
  - Từ đọc đúng được ghi vào `correctWordIds` và hiển thị nền xanh nhạt; từ hiện tại có ô viền vàng nổi bật.
- **Báo cáo so sánh sau khi đọc (Reading Comparison Report)**:
  - Khi kết thúc trang/bài, gọi API `/reading-management/sessions/{session_id}/pages/{page_id}/revisions/{revision_id}/comparison`.
  - Thuật toán Levenshtein (`text_alignment.py`) phân tích:
    - `MATCH`: Đọc đúng (xanh lá).
    - `SUBSTITUTE`: Đọc nhầm từ (cam).
    - `DELETE`: Bỏ sót từ (đỏ).
    - `INSERT`: Đọc thêm từ (tím).
    - `hesitations`: Ngập ngừng (dừng lâu giữa 2 từ).
    - `repeated_words`: Lặp từ.
  - Nếu ElevenLabs hết quota (`STT_QUOTA_EXCEEDED`), hệ thống tự động fallback sang `BrowserTranscriptCollector` sử dụng Web Speech API của trình duyệt để đảm bảo bé vẫn nhận được kết quả đọc.

---

## 4. CẤU TRÚC THƯ MỤC CHÍNH (DIRECTORY STRUCTURE)

```text
capstone1/
├── Agent.md                                  # File hướng dẫn này
├── backend/
│   ├── app/
│   │   ├── sever.py                          # FastAPI entrypoint (LƯU Ý: sever.py)
│   │   ├── api/
│   │   │   ├── deps.py                       # Dependencies: get_current_parent_id, DB session, etc.
│   │   │   └── routes/
│   │   │       ├── admin_ocr.py              # Endpoints quản lý sách & OCR cho Admin
│   │   │       ├── reading.py                # Endpoints phiên đọc & so sánh kết quả
│   │   │       ├── voice.py                  # Endpoints ElevenLabs STT & TTS
│   │   │       ├── books.py                  # Catalog sách công khai cho phụ huynh/bé
│   │   │       └── auth.py                   # Xác thực phụ huynh & admin
│   │   ├── models/                           # SQLAlchemy Models (reading, book, revision, comparison)
│   │   ├── providers/                        # ElevenLabsVoiceProvider
│   │   ├── repositories/                     # Data Access Layer (reading_comparison_repository, etc.)
│   │   ├── schemas/                          # Pydantic V2 Schemas
│   │   └── services/
│   │       ├── ocr_engine.py                 # Dual-Engine PaddleOCR + VietOCR + Tesseract Fallback
│   │       ├── reading_comparison_service.py # Xử lý so sánh bài đọc & lưu report
│   │       ├── storage_service.py            # Upload/Download ảnh Supabase Storage
│   │       └── text_alignment.py             # Thuật toán so khớp văn bản Levenshtein
│   ├── requirements.txt                      # Cấu hình dependency Python đã khóa chặt
│   └── test_*.py                             # Toàn bộ 280 unit tests backend
├── frontend/
│   ├── app/                                  # Next.js App Router
│   │   ├── sessions/[sessionId]/report/     # Màn hình chi tiết báo cáo đọc
│   │   └── books/                            # Thư viện sách
│   ├── components/
│   │   └── reading/
│   │       ├── reading-screen.tsx            # Container chính điều khiển phiên đọc của bé
│   │       ├── book-page-viewer.tsx          # Hiển thị trang sách & highlight từ
│   │       ├── book-page-content.tsx         # Component render từng từ với trạng thái màu
│   │       ├── ReadingReport.tsx             # Giao diện báo cáo kết quả đọc chi tiết
│   │       └── word-highlight-overlay.tsx    # Bounding box overlay
│   ├── hooks/
│   │   ├── use-speech-recorder.ts            # Quản lý MediaRecorder & Web Audio API
│   │   └── use-speech-player.ts              # Phát âm thanh mẫu
│   ├── lib/
│   │   ├── api/                              # API Client (comparison, speech, books, auth)
│   │   └── reading/
│   │       └── browser-transcript-collector.ts # Thu thập transcript từ trình duyệt khi hết quota
│   └── tests/ & test/                        # Toàn bộ 558 unit/integration tests Vitest
└── .github/workflows/
    ├── backend-tests.yml                     # CI chạy 280 tests backend + PostgreSQL service
    └── frontend-tests.yml                    # CI chạy Vitest, ESLint, TypeScript check
```

---

## 5. CÁCH CHẠY VÀ KIỂM THỬ (RUN & TEST INSTRUCTIONS)

### Khởi động Server (Local Development):
1. **Backend FastAPI** (Port 8000):
   ```powershell
   Set-Location -Path f:\Capstone\capstone1\backend
   python -m uvicorn app.sever:app --host 127.0.0.1 --port 8000 --reload
   ```
2. **Frontend Next.js** (Port 3000):
   ```powershell
   Set-Location -Path f:\Capstone\capstone1\frontend
   npm run dev
   ```

### Chạy Test Suite (BẮT BUỘC CHẠY TRƯỚC KHI COMMIT):
1. **Backend Tests** (280 tests):
   ```powershell
   Set-Location -Path f:\Capstone\capstone1\backend
   python -m unittest discover -v
   ```
   *Yêu cầu*: Phải đạt `OK` (tất cả các test phải pass, không có lỗi `_FailedTest`).

2. **Frontend Tests** (68 test files, 558 tests):
   ```powershell
   Set-Location -Path f:\Capstone\capstone1\frontend
   npm test
   ```
   *Yêu cầu*: Phải đạt `68 passed (68), 558 passed (558)`.

3. **Frontend Typecheck & Lint**:
   ```powershell
   npm --prefix frontend run typecheck
   npm --prefix frontend run lint
   ```
   *Yêu cầu*: 0 errors.

---

## 6. LỊCH SỬ CÁC THAY ĐỔI GẦN ĐÂY TRÊN NHÁNH `tu`

- **Commit `904fc64`**: Khôi phục Tesseract fallback khi Dual-Engine PaddleOCR không khả dụng trong môi trường thiếu GPU.
- **Commit `4b9dd7a`**: Khôi phục live ElevenLabs STT utterance transcription và cải thiện thuật toán `verifySpokenWord` với lookahead $+1$.
- **Commit `f775de7`**: Sửa lỗi CI `ModuleNotFoundError: pytesseract` bằng cách lazy import an toàn trong `ocr_engine.py` và cập nhật `.github/workflows/backend-tests.yml`.
- **Commit `5d02e26`**: Merge toàn bộ các tính năng mới nhất từ `origin/main` (hệ thống lưu trữ báo cáo so sánh PostgreSQL, fallback trình duyệt khi hết quota ElevenLabs, phân tách `book-page-content.tsx`), giải quyết xung đột cấu hình workflow và duplicate requirements.

---

## 7. LỜI KHUYÊN DÀNH CHO AI TIẾP THEO (TIPS & BEST PRACTICES)
- **Đừng đoán cấu hình**: Nếu cần kiểm tra kết nối Supabase, hãy xem [`backend/ADMIN_BOOKS_OCR_SETUP.md`](backend/ADMIN_BOOKS_OCR_SETUP.md) và các file cấu hình `.env`.
- **Không tự ý refactor diện rộng**: Dự án có độ phủ test rất cao (280 test BE, 558 test FE). Mọi thay đổi tên hàm, interface hoặc schema đều sẽ kéo theo hàng chục test bị ảnh hưởng. Hãy sửa tập trung đúng phạm vi được yêu cầu.
- **Giữ branch `tu` sạch sẽ**: Trước khi kết thúc phiên làm việc, hãy chạy cả 2 bộ test backend và frontend, đảm bảo working tree sạch sẽ và push lên `origin/tu`.
