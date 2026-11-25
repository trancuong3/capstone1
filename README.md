# ViRead — ReadAlong Vision

ViRead là dự án đồng hành cùng bé đọc sách, gồm frontend **Next.js 16 / React 19 / TypeScript**, backend **FastAPI / SQLAlchemy / PostgreSQL**, Supabase Auth & Storage, pipeline OCR (PaddleOCR, VietOCR, Tesseract), luồng đọc, báo cáo và khu vực quản trị.

**Phạm vi của README:** mô tả mã nguồn trên nhánh `main` được kiểm tra ngày 20/11/2026; mã nguồn có route/test **không đồng nghĩa** mọi chức năng đã triển khai hoặc được nghiệm thu trên production. Các dịch vụ AI, OCR, email, STT/TTS và worker cần credential, model, phần cứng và/hoặc cấu hình riêng; môi trường demo và fixture test không phải bằng chứng production.

- **Repository:** [trancuong3/capstone1](https://github.com/trancuong3/capstone1) — **public**, nhưng chưa có `LICENSE` được chủ sở hữu công bố.
- **Auth:** Supabase Auth với route guard Parent/Admin; FastAPI kiểm tra Supabase bearer token và quyền sở hữu trên các API riêng tư. Không dùng metadata role do client tự khai.
- **Nghiệp vụ:** nhiều luồng frontend đã dùng typed service gọi FastAPI thật (hồ sơ, phiên đọc, báo cáo, đọc hiểu); vẫn tồn tại mock/fixture dùng cho test và một số UI state. Kiểm tra từng adapter trước khi coi là persisted.
- **OCR/AI:** Scan và chỉnh sửa AI là hai luồng khác nhau. Scan không tự gọi AI sửa văn bản; nút Admin “AI sửa” sử dụng provider đã cấu hình với fallback, không cam kết provider nào luôn sẵn sàng.

Xem [hướng dẫn đóng góp](CONTRIBUTING.md) và [tài liệu triển khai Render/Supabase](docs/RENDER_SUPABASE_DEPLOYMENT.md).


## Bắt đầu nhanh

### 1. Clone repository

```powershell
git clone https://github.com/trancuong3/capstone1.git
cd capstone1
```

Repository hiện **public** nên có thể clone để xem mã nguồn. Để push branch hoặc cập nhật PR vẫn cần quyền tương ứng. Chưa có LICENSE: không mặc nhiên có quyền tái sử dụng/phân phối mã nguồn.

### 2. Cài đặt công cụ và dependencies (Windows)

Cần Python 3.12 x64, Node.js 22.13 trở lên và Windows Package Manager (`winget`). Từ thư mục gốc repository, chạy một lần:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\requirements.ps1
```

Script tạo `backend/.venv`, cài toàn bộ Python packages từ `requirements.txt`, chạy `npm ci`, cài Tesseract OCR 5.x nếu máy chưa có, bổ sung dữ liệu OCR tiếng Việt đã ghim checksum, cài Ollama tương thích và tải model `qwen3-vl:4b-instruct-q4_K_M`. Lần cài đầu cần Internet và vài GB dung lượng trống; riêng bộ cài Ollama khoảng 1.6 GB, model AI khoảng 3.3 GB. Script giữ nguyên mọi file `.env` đang có và chỉ tạo từ mẫu khi chưa tồn tại.

File `requirements.txt` ở repo root là manifest Python gọn trỏ tới toàn bộ danh sách đã khóa tại `backend/requirements.txt`. Vì Ollama và Tesseract là chương trình hệ thống chứ không phải Python packages, hãy dùng `requirements.ps1` để cài đầy đủ môi trường trên Windows.

Script không thể tự cấp thông tin Supabase/Database. Thành viên cần lấy cấu hình dev từ người quản lý dự án và điền vào `backend/.env` cùng `frontend/.env.local`; không dùng key production và không commit các file này.

### 3. Chạy frontend và backend

```powershell
# Terminal 1: Backend, từ thư mục gốc repository
Set-Location .\backend
.\.venv\Scripts\Activate.ps1
python -m uvicorn app.sever:app --host 127.0.0.1 --port 8000 --reload

# Terminal 2: Frontend, từ thư mục gốc repository
Set-Location .\frontend
npm run dev -- --port 3000
```

Điền `NEXT_PUBLIC_SUPABASE_URL` và `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` vào `frontend/.env.local`. Không đưa service-role key hoặc database password vào frontend. `NEXT_PUBLIC_API_URL` mặc định trỏ đến `http://127.0.0.1:8000`.

Mở http://localhost:3000 trong trình duyệt.

Để xem riêng fixture Auth trong môi trường development, dùng `/login?state=default`. Tài khoản mock:

- Phụ huynh: `minhanh@example.com` / `matkhau123`
- Admin: `admin@example.com` / `matkhau123`

Đây là dữ liệu mock cục bộ, không phải tài khoản hoặc mật khẩu Supabase. Route `/login` không có query `state` sẽ dùng Supabase thật.

Mock Auth chỉ dùng để kiểm thử form và không tạo session cookie phía server. Vì vậy muốn mở các route Parent/Admin được bảo vệ khi chạy thủ công, cần đăng nhập bằng tài khoản Supabase thật có role phù hợp; fixture server-only cho các luồng mock chỉ được Playwright bật trong lúc test.

Trong Supabase Authentication → URL Configuration, cần cho phép URL của ứng dụng và các đường dẫn `/login`, `/reset-password`. Nếu thử trên điện thoại trong cùng Wi-Fi, thêm đúng URL LAN đang sử dụng vào Redirect URLs.

Luồng hiện dùng PKCE phía trình duyệt; hãy mở email xác nhận/khôi phục bằng cùng trình duyệt và thiết bị đã gửi yêu cầu. Production luôn bỏ qua `?state=...` để query fixture không thể bật mock Auth.

Route Parent và Admin được bảo vệ phía server. Ứng dụng xác minh session bằng `getClaims()` rồi đọc role từ `public.profiles`; không dùng role từ metadata do trình duyệt gửi lên. `/admin/login` dùng Supabase thật, còn `/admin/login?state=default` chỉ là fixture development/test.

## Chức năng có trong codebase

- **Auth & hồ sơ:** đăng ký, đăng nhập, khôi phục mật khẩu với Supabase; profile Parent/Admin, hồ sơ bé, avatar và thông tin liên hệ qua backend.
- **Thư viện và đọc:** danh mục sách, chi tiết/trang sách, phạm vi đọc, phiên đọc gắn revision trang, hỗ trợ tương tác và các endpoint về lịch sử đọc.
- **Báo cáo:** tiến bộ, lịch sử phiên, từ cần luyện và bài tập/AI Tutor theo các typed API. Số liệu không đủ evidence phải giữ trạng thái không xác định, không tự suy diễn lỗi của bé.
- **Quản trị OCR:** tạo/sửa sách, upload/trích xuất/reprocess, OCR revision, verify, audit và health; có worker/flow quản lý model/training trong code.
- **Các luồng khác:** karaoke, voice, picture description, trò chơi và worker nhắc đọc (tính khả dụng phụ thuộc cấu hình riêng).
- **Frontend responsive:** chung codebase cho desktop/tablet/mobile; mock/fixture phục vụ test vẫn tồn tại nhưng không đại diện trạng thái dữ liệu production.

**Giới hạn:** sự hiện diện của route/test không đảm bảo tất cả tích hợp thiết bị, model, provider, realtime hay luồng worker chạy được trong mọi môi trường. Xem tests/CI và cấu hình dịch vụ cho từng phần; không khẳng định đã hoàn thành AI training chỉ dựa vào tên flow.

## Cấu trúc repository

```text
capstone1/
├── AGENTS.md                 # Hướng dẫn agent gốc (giữ nguyên)
├── .agent-library/           # Skill nội bộ và skill được khóa
├── .agents/                  # Skill gateways / router
├── .codex/                   # Cấu hình và skill cho Codex/Graphify
├── skills-lock.json          # Lock các skill đồng bộ
├── backend/                  # FastAPI, SQLAlchemy, OCR, workers, API tests
│   └── AGENTS.md             # Invariants backend
├── frontend/                 # Next.js, Supabase Auth, components, tests
│   └── AGENTS.md             # Invariants frontend
├── supabase/migrations/      # Lịch sử schema/migrations; không tự áp production
├── .github/workflows/       # Backend, frontend, OCR, E2E và các gate khác
├── docs/                    # Báo cáo kỹ thuật, staging, deployment
├── scripts/validate_agent_config.py
├── .graphifyignore           # Loại trừ agent và cache khỏi Graphify indexing
└── .gitignore               # Bỏ qua graphify-out/ (trạng thái Graphify local)
```

`graphify-out/` được Graphify tạo lại theo mã nguồn hiện hành và **không được Git theo dõi**. Có thể dùng `python -m graphify update .` nếu cần xây lại knowledge graph; không commit AST cache/index. Lệnh/query, điều kiện rebuild và guard xem tại [skill Graphify](.codex/skills/graphify/SKILL.md). Điều này **không xóa hoặc thay thế** AGENTS, các gateway hay skill lock.

## Tài liệu

- [Hướng dẫn frontend chi tiết](frontend/README.md)
- [Báo cáo nghiệm thu frontend](frontend/FRONTEND_ACCEPTANCE_REPORT.md)
- [Quy tắc đóng góp](CONTRIBUTING.md)
- [Triển khai, bảo mật và benchmark AI OCR đa nhà cung cấp](docs/admin-ocr-local-deployment.md)

Blueprint và Coding Handoff là tài liệu bàn giao nằm ngoài repository. Thành viên cần nhận chúng qua kênh nội bộ nếu công việc yêu cầu đối chiếu contract.

## Supabase migrations và Auth foreign key

Migration lịch sử `supabase/migrations/20260928144208_phase4_auth_profiles.sql` **từng** thêm khóa ngoại `profiles.id → auth.users.id` với `NOT VALID` để hỗ trợ profile legacy vào thời điểm đó. Đây là bối cảnh của migration, **không phải trạng thái hiện tại**.

**Đã kiểm tra trực tiếp metadata Supabase production ngày 20/11/2026 (SELECT catalog, không truy vấn dữ liệu người dùng):** `public.profiles` có constraint `profiles_id_auth_users_fkey`, `convalidated = true`, `FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE`. Không cần chạy `VALIDATE CONSTRAINT` theo hướng dẫn README cũ; không thực hiện xóa/migrate profile production từ README.

Các bảng nghiệp vụ `books`, `childprofiles`, `readingsessions`, `progressreports` và `profiles` đang bật RLS (theo catalog). RLS enabled không tự chứng minh mọi policy/ACL đã đúng: chỉ triển khai migration sau khi review, test trên database cách ly và được phê duyệt. `supabase/migrations/` là lịch sử thay đổi, không phải lệnh áp toàn bộ thủ công lên production.

## Backend Profile API và quyền truy cập

FastAPI entrypoint là `backend/app/sever.py` (`app.sever:app`, không phải `server.py`). `backend/app/api/router.py` liên kết các router profiles, books, reading, reports/system, comprehension, AI Tutor, OCR Admin, voice và các module bổ sung.

Các endpoint hồ sơ quan trọng gồm:

- `GET /profiles/me` — hồ sơ của người đăng nhập; `PATCH /profiles/me/contact-phone`; `POST/DELETE /profiles/me/avatar`.
- `GET/POST /profiles/children`; `GET/PUT/DELETE /profiles/children/{child_id}`; upload/remove ảnh bé.
- `GET/POST /profiles`, `GET/PUT/DELETE /profiles/{profile_id}` — legacy CRUD, cần kiểm tra role/ownership khi gọi.
- `/profiles/admin/parents` — quản lý phụ huynh chỉ dành cho Admin.

Frontend `frontend/lib/api/profile-service.ts` **đang sử dụng Supabase access token** để gọi `/profiles/me` và cập nhật thông tin qua API. `frontend/lib/api/report-service.ts` cũng gọi backend `/system/progress/{child_id}`, không phải fixture đơn thuần. Không sử dụng mock Auth `?state=...` làm token/role thực.

## Kế hoạch đọc và email nhắc đọc

Kế hoạch tuần, mục tiêu đọc, lịch nhắc và trạng thái lần gửi email được lưu ở PostgreSQL. Áp dụng migration `supabase/migrations/20261104160000_reading_plans_and_email_reminders.sql` trước khi dùng các API mới.

Email được gửi bởi worker chạy riêng với FastAPI. Trong một tiến trình backend khác, từ thư mục `backend`, chạy:

```powershell
python -m app.jobs.reading_reminder_worker
```

Worker cần cùng cấu hình database/Supabase với API và các secret phía máy chủ `SMTP_USERNAME`, `SMTP_APP_PASSWORD`, cùng một Supabase Admin key (`SUPABASE_SECRET_KEY` hoặc khóa legacy `SUPABASE_SERVICE_ROLE_KEY`). Các tên biến và giá trị mẫu nằm trong `backend/.env.example`; chỉ đặt mật khẩu ứng dụng trong secret manager của môi trường chạy, không commit file `.env`.

SMTP mặc định dùng Gmail ở cổng 587 với STARTTLS. `SMTP_FROM_EMAIL` mặc định là `vireadforyou@gmail.com`; tài khoản gửi phải cho phép gửi bằng thông tin xác thực đã cấu hình. Người nhận được đọc từ Supabase Auth theo hồ sơ phụ huynh của bé và chỉ nhận email khi địa chỉ đã xác minh, không lấy email nhận từ request phía trình duyệt.

Worker kiểm tra lịch mỗi 30 giây. Mỗi lịch chỉ tạo một occurrence cho một ngày địa phương; worker dùng khóa hàng để tránh hai tiến trình cùng gửi một occurrence. Lỗi SMTP tạm thời được thử lại tối đa năm lần với thời gian chờ tăng dần. Giờ địa phương không tồn tại khi chuyển DST được bỏ qua ngày đó; giờ lặp lại khi kết thúc DST dùng lần xuất hiện đầu tiên. `Message-ID` ổn định hỗ trợ theo dõi lần gửi. SMTP không cung cấp bảo đảm exactly-once nếu tiến trình dừng sau khi máy chủ nhận email nhưng trước khi database ghi nhận thành công.

Đặt `READING_REMINDER_APP_URL` thành URL production của trang quản lý đọc để liên kết trong email mở đúng ứng dụng. Muốn xem trạng thái giao email, mở trang quản lý khi occurrence đang đến hạn; ứng dụng hiển thị trạng thái chờ gửi, đang gửi, gửi lại, thành công hoặc thất bại.

## Kiểm tra trước khi mở pull request

Từ thư mục `frontend`:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Có thể chạy toàn bộ Playwright bằng:

```powershell
npm run test:e2e
```

## Quy trình đóng góp

- `main` là nhánh mặc định; workflow GitHub Actions chạy khi PR vào `main`.
- Tạo nhánh `feature/`, `fix/`, `docs/` hoặc `chore/` từ `origin/main`, rồi mở PR vào `main`.
- Không giả định có `develop`: kiểm tra remote refs trước khi sử dụng.
- **Không push trực tiếp vào `main`** là quy ước nhóm. GitHub đã từng báo `protected=false`; chỉ Ruleset/Branch protection do chủ repo kích hoạt mới bảo đảm chặn merge/push bỏ qua CI. Không coi quy ước là cơ chế kỹ thuật đã được bật.
- Trước khi review: `python scripts/validate_agent_config.py`, backend tests/Real OCR gate thích hợp và `frontend` lint/typecheck/test/build/Playwright; kiểm tra kết quả CI trên commit PR cuối.
- Đọc [CONTRIBUTING.md](CONTRIBUTING.md) để bảo vệ code local/stash và các cấu hình agent.

## Bảo mật và dữ liệu

- Không commit `.env`, JWT, API key, cookie, service-role key, signed URL, private key hoặc dữ liệu bé thật.
- Browser chỉ nhận Supabase URL và publishable key; các khóa Admin/Storage, database password và Gemini/Groq keys là server-only.
- Quyền Parent/Admin, ownership trẻ em và API workers được kiểm tra **ở server**; kiểm tra frontend route không thể thay thế authorization.
- Fixture/test data dùng để chạy CI và demo **không phải dữ liệu production**. Không tự truy cập hoặc làm sạch database production chỉ vì có cảnh báo.
- Graphify cache khác với `.agent-library/`, `.agents/`, `.codex/`, `AGENTS.md`: chỉ cache tự sinh bị bỏ theo dõi.

## Các giới hạn / việc cần xác minh

- Tính khả dụng thực tế của các model VietOCR, provider AI và thiết bị phụ thuộc môi trường, hạn mức và kiểm thử staging; không tự gán profile đang active với checkpoint đã thực sự inference.
- Một số nội dung vẫn phục vụ demo/mock UI hoặc cần kiểm chứng với dữ liệu staging trước khi đưa vào production.
- Các worker độc lập cần được khởi chạy và cấu hình riêng, không suy ra chỉ từ việc tồn tại module Python.
- Các PR chưa merge không được xem là tính năng đã có trong `main`.
- Trạng thái CI, Supabase permissions và branch protection cần xác minh mới tại thời điểm triển khai.

## Quyền sử dụng

Repository đang **public** nhưng không có file `LICENSE` tại gốc ở thời điểm kiểm tra. Việc công khai mã nguồn trên GitHub không tự cấp giấy phép sao chép, sửa đổi hoặc phân phối theo mô hình open source. Chủ repository cần lựa chọn giấy phép phù hợp với đồ án và thành phần phụ thuộc; PR dọn dẹp tài liệu **không tự tạo hoặc chọn LICENSE**.

### Thành phần bên thứ ba (WASM STT)

- `frontend/public/wasm/sherpa/` chứa runtime `sherpa-onnx` WebAssembly (`sherpa-onnx-asr.js`, `sherpa-onnx-wasm-main-vad-asr-clean.js`, `sherpa-onnx-wasm-main-vad-asr.wasm`) thuộc dự án [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), phát hành theo giấy phép **Apache License 2.0** (chi tiết tại [frontend/public/wasm/sherpa/NOTICE.txt](frontend/public/wasm/sherpa/NOTICE.txt)). Model nhận dạng tiếng Việt `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` được trình duyệt tải theo yêu cầu và kiểm tra SHA-256 khi chạy chế độ trên thiết bị.
