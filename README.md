# ReadAlong Vision

ReadAlong Vision là dự án hỗ trợ ba mẹ đồng hành cùng bé trong quá trình đọc sách. Repository hiện chứa giao diện web responsive được xây dựng bằng Next.js và TypeScript.

> Trạng thái hiện tại: đăng ký, đăng nhập, khôi phục mật khẩu và phân quyền route Parent/Admin đã dùng Supabase Auth. Các khu vực dữ liệu nghiệp vụ còn lại vẫn dùng typed mock services; backend, AI và xử lý media chưa được kết nối thật.

## Bắt đầu nhanh

### 1. Clone repository

```powershell
git clone https://github.com/linhjunior205/readalong-vision.git
cd readalong-vision
```

Vì repository đang ở chế độ private, tài khoản GitHub của bạn phải được chủ repository mời làm collaborator.

### 2. Cài đặt và chạy frontend

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Điền `NEXT_PUBLIC_SUPABASE_URL` và `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` vào `.env.local`. Không đưa service-role key hoặc database password vào frontend.

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
- Responsive tại desktop, tablet và mobile bằng cùng một cây component.

## Cấu trúc repository

```text
readalong-vision/
├── .github/              # Mẫu pull request và thiết lập GitHub
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

Blueprint và Coding Handoff là tài liệu bàn giao nằm ngoài repository. Thành viên cần nhận chúng qua kênh nội bộ nếu công việc yêu cầu đối chiếu contract.

## Supabase migrations

Migration Auth phụ huynh được lưu tại `supabase/migrations/20260928144208_phase4_auth_profiles.sql`. Migration tạo signup trigger, role mặc định `parent`, quyền theo cột và RLS policy cho `profiles`.

Khóa ngoại `profiles.id → auth.users.id` đang ở trạng thái `NOT VALID` có chủ ý vì database còn các profile legacy được `childprofiles` tham chiếu nhưng chưa có bản ghi `auth.users` tương ứng. Database team phải di chuyển hoặc loại bỏ dữ liệu legacy trước khi chạy `VALIDATE CONSTRAINT`; không xóa các profile này riêng lẻ.

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

- Backend API cho dữ liệu nghiệp vụ; route guard phía server và cookie refresh proxy đã được triển khai cho luồng Auth.
- Hoàn tất di chuyển profile legacy và validate khóa ngoại Auth; storage và các bảng nghiệp vụ thật vẫn chưa được tích hợp vào frontend.
- Camera/microphone processing và realtime WebSocket.
- OCR, page matching, STT, TTS, scoring và AI thật.
- Persistence giữa các lần tải lại trang.

## Quyền sử dụng

Repository chưa công bố License. Vì repository đang private, source code và tài liệu chỉ được sử dụng trong phạm vi nhóm dự án cho đến khi chủ dự án chọn giấy phép phù hợp.
