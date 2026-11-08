# ReadAlong Vision

ReadAlong Vision là dự án hỗ trợ ba mẹ đồng hành cùng bé trong quá trình đọc sách. Repository hiện chứa frontend responsive bằng Next.js/TypeScript và backend bước đầu bằng FastAPI.

> Trạng thái hiện tại: đăng ký, đăng nhập, khôi phục mật khẩu và phân quyền route Parent/Admin đã dùng Supabase Auth. Backend đã có Profile CRUD bước đầu, nhưng frontend vẫn dùng typed mock services cho một số dữ liệu nghiệp vụ và các endpoint chưa được bảo vệ bằng Supabase access token/quyền sở hữu. Scan OCR không gọi model AI sửa. Chỉ nút “AI sửa” mới dùng fallback tuần tự gemini-3.5-flash-lite → gemini-3.1-flash-lite → qwen/qwen3.8-27b → Ollama; cloud chỉ được gọi server-side khi được cấu hình.

## Bắt đầu nhanh

### 1. Clone repository

```powershell
git clone https://github.com/trancuong3/capstone1.git
cd capstone1
```

Vì repository đang ở chế độ private, tài khoản GitHub của bạn phải được chủ repository mời làm collaborator.

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

## Chức năng hiện có

- Đăng nhập, đăng ký và khôi phục mật khẩu.
- Quản lý hồ sơ ba mẹ và hồ sơ bé.
- Tìm kiếm, lọc và xem chi tiết sách.
- Trình diễn các trạng thái của buổi đọc tương tác.
- Lịch sử đọc, báo cáo tiến bộ và từ cần luyện.
- Quản trị sách, trang sách, OCR revision, audit log và health.
- Scan OCR chỉ dùng các engine OCR của hệ thống; AI chỉ chạy khi Admin bấm nút “AI sửa”. Nút này dùng gemini-3.5-flash-lite → gemini-3.1-flash-lite → qwen/qwen3.8-27b, Ollama chỉ là dự phòng cuối; tác vụ dài có tiến độ, có thể hủy và chỉ áp dụng sau khi Admin rà soát.
- Responsive tại desktop, tablet và mobile bằng cùng một cây component.

## Cấu trúc repository

```text
readalong-vision/
├── .github/              # Mẫu pull request và thiết lập GitHub
├── backend/              # FastAPI, SQLAlchemy models và API nghiệp vụ
├── frontend/             # Ứng dụng Next.js
│   ├── app/              # Routes và layouts
│   ├── components/       # Screens và UI components
│   ├── lib/api/          # Typed service interfaces
│   ├── lib/mock/         # Mock implementations và fixtures
│   ├── public/           # Asset tĩnh
│   └── tests/            # Unit, component và E2E tests
├── supabase/
│   └── migrations/       # Thay đổi schema Supabase được quản lý bằng Git
├── .gitattributes        # Quy tắc line ending
├── .gitignore            # File không được đưa lên Git
└── CONTRIBUTING.md       # Quy tắc làm việc nhóm
```

## Tài liệu

- [Hướng dẫn frontend chi tiết](frontend/README.md)
- [Báo cáo nghiệm thu frontend](frontend/FRONTEND_ACCEPTANCE_REPORT.md)
- [Quy tắc đóng góp](CONTRIBUTING.md)
- [Triển khai, bảo mật và benchmark AI OCR đa nhà cung cấp](docs/admin-ocr-local-deployment.md)

Blueprint và Coding Handoff là tài liệu bàn giao nằm ngoài repository. Thành viên cần nhận chúng qua kênh nội bộ nếu công việc yêu cầu đối chiếu contract.

## Supabase migrations

Migration Auth phụ huynh được lưu tại `supabase/migrations/20260928144208_phase4_auth_profiles.sql`. Migration tạo signup trigger, role mặc định `parent`, quyền theo cột và RLS policy cho `profiles`.

Khóa ngoại `profiles.id → auth.users.id` đang ở trạng thái `NOT VALID` có chủ ý vì database còn các profile legacy được `childprofiles` tham chiếu nhưng chưa có bản ghi `auth.users` tương ứng. Database team phải di chuyển hoặc loại bỏ dữ liệu legacy trước khi chạy `VALIDATE CONSTRAINT`; không xóa các profile này riêng lẻ.

## Backend Profile API

FastAPI hiện có các endpoint CRUD bước đầu cho hồ sơ phụ huynh và hồ sơ bé:

- `GET/POST /profiles`
- `GET/PUT/DELETE /profiles/{profile_id}`
- `GET/POST /profiles/children`
- `GET/PUT/DELETE /profiles/children/{child_id}`

Frontend mặc định vẫn dùng mock services cho dữ liệu Profile/Child. Khi `NEXT_PUBLIC_API_URL` được cấu hình, adapter có thể gọi các endpoint FastAPI này. Các endpoint chưa xác minh Supabase access token, role và quyền sở hữu hồ sơ, nên chưa được xem là API đã bảo vệ hoàn chỉnh.

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

## Cách làm việc nhóm

- `main`: phiên bản ổn định, không push trực tiếp.
- `develop`: nhánh tích hợp cho công việc đang phát triển.
- `feature/<ten-ngan>`: tính năng hoặc màn hình mới.
- `fix/<ten-ngan>`: sửa lỗi.
- Mỗi thay đổi được đưa vào bằng pull request và cần mô tả phạm vi cùng kết quả test.

Xem quy trình đầy đủ trong [CONTRIBUTING.md](CONTRIBUTING.md).

## Bảo mật và dữ liệu

- Không commit `.env`, access token, API key, cookie, private key hoặc dữ liệu người dùng thật.
- Không dùng tài khoản demo cho backend hoặc môi trường production.
- Không chia sẻ Figma access token, Supabase service key hoặc credential qua GitHub.
- Không commit `.env.local`; frontend chỉ dùng URL dự án và publishable key.
- Các dữ liệu sách, hồ sơ bé, báo cáo và audit log hiện vẫn là fixture mock.

## Phạm vi chưa triển khai

- Hoàn thiện, bảo vệ và kết nối backend API dữ liệu nghiệp vụ; Profile CRUD mới ở mức khởi đầu. Route guard phía server và cookie refresh proxy đã được triển khai cho luồng Auth frontend.
- Hoàn tất di chuyển profile legacy và validate khóa ngoại Auth; storage và các bảng nghiệp vụ thật vẫn chưa được tích hợp vào frontend.
- Camera/microphone processing và realtime WebSocket.
- STT, TTS, scoring, page matching hoàn chỉnh và các tính năng AI khác ngoài sửa OCR cục bộ cho Admin.
- Persistence giữa các lần tải lại trang.

## Quyền sử dụng

Repository chưa công bố License. Vì repository đang private, source code và tài liệu chỉ được sử dụng trong phạm vi nhóm dự án cho đến khi chủ dự án chọn giấy phép phù hợp.
