# ReadAlong Vision

ReadAlong Vision là dự án hỗ trợ ba mẹ đồng hành cùng bé trong quá trình đọc sách. Repository hiện chứa giao diện web responsive được xây dựng bằng Next.js và TypeScript.

> Trạng thái hiện tại: frontend demo dùng typed mock services. Dự án chưa kết nối backend, database, Supabase, camera, microphone, OCR, STT, TTS hoặc AI thật.

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
npm run dev
```

Mở http://localhost:3000 trong trình duyệt.

Tài khoản demo:

- Phụ huynh: `minhanh@example.com` / `matkhau123`
- Admin: `admin@example.com` / `matkhau123`

Đây là dữ liệu mock cục bộ, không phải tài khoản hoặc mật khẩu của hệ thống thật.

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
├── .gitattributes        # Quy tắc line ending
├── .gitignore            # File không được đưa lên Git
└── CONTRIBUTING.md       # Quy tắc làm việc nhóm
```

## Tài liệu

- [Hướng dẫn frontend chi tiết](frontend/README.md)
- [Báo cáo nghiệm thu frontend](frontend/FRONTEND_ACCEPTANCE_REPORT.md)
- [Quy tắc đóng góp](CONTRIBUTING.md)

Blueprint và Coding Handoff là tài liệu bàn giao nằm ngoài repository. Thành viên cần nhận chúng qua kênh nội bộ nếu công việc yêu cầu đối chiếu contract.

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
- Các UUID, session token, báo cáo, audit log và tài khoản hiện tại đều là fixture mock.

## Phạm vi chưa triển khai

- Backend API và xác thực phiên thật.
- Database, RLS, storage và email delivery.
- Camera/microphone processing và realtime WebSocket.
- OCR, page matching, STT, TTS, scoring và AI thật.
- Persistence giữa các lần tải lại trang.

## Quyền sử dụng

Repository chưa công bố License. Vì repository đang private, source code và tài liệu chỉ được sử dụng trong phạm vi nhóm dự án cho đến khi chủ dự án chọn giấy phép phù hợp.
