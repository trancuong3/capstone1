# Đóng góp cho ReadAlong Vision

Tài liệu này thống nhất cách các thành viên cài đặt, tạo branch, kiểm tra và gửi thay đổi.

## Chuẩn bị môi trường

- Node.js `>= 22.13.0`.
- npm 10 trở lên.
- Git và tài khoản GitHub đã được mời vào repository private.

```powershell
git clone https://github.com/linhjunior205/readalong-vision.git
cd readalong-vision/frontend
npm ci
```

Không cần tạo `.env` để chạy frontend mock hiện tại.

## Quy trình branch

Không làm việc trực tiếp trên `main`.

1. Đồng bộ nhánh tích hợp:

   ```powershell
   git switch develop
   git pull origin develop
   ```

2. Tạo branch mới:

   ```powershell
   git switch -c feature/ten-ngan-gon
   ```

3. Dùng một trong các tiền tố:

   - `feature/`: chức năng hoặc màn hình.
   - `fix/`: sửa lỗi.
   - `test/`: bổ sung test.
   - `docs/`: thay đổi tài liệu.
   - `chore/`: cấu hình hoặc bảo trì.

4. Push branch và mở pull request vào `develop`.
5. Khi cần phát hành, mở pull request từ `develop` vào `main`.

## Quy ước commit

Commit nên nhỏ, tập trung và có mô tả rõ ràng. Khuyến nghị:

```text
feat: add child selector
fix: prevent duplicate reading submission
test: cover book unavailable state
docs: clarify local setup
chore: update lint configuration
```

Không đưa nhiều thay đổi không liên quan vào cùng một commit.

## Kiểm tra bắt buộc

Từ thư mục `frontend`:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Chạy thêm Playwright nếu thay đổi route, navigation hoặc hành vi UI:

```powershell
npm run test:e2e
```

Nếu có command không chạy được, ghi rõ command và lỗi thực tế trong pull request. Không đánh dấu PASS khi chưa chạy.

## Quy tắc frontend

- Dùng TypeScript nghiêm ngặt; không dùng `any` hoặc `@ts-ignore`.
- Screen gọi typed service interface; không import fixture trực tiếp vào component.
- Không đặt toàn bộ UI hoặc mock logic trong `page.tsx`.
- Tái sử dụng design token và common component hiện có.
- Dùng cùng component tree cho desktop và mobile; không tạo app mobile riêng chỉ để responsive.
- Giữ keyboard navigation, focus-visible, label, heading và dialog behavior.
- Cleanup subscription và bỏ qua kết quả async đến muộn sau unmount.

## Contract và safety

- Blueprint là nguồn contract và hành vi.
- Figma là nguồn giao diện trực quan.
- Không tự đổi DTO, status, error code hoặc authorization behavior.
- Chỉ hiển thị sách phù hợp điều kiện `ACTIVE + VERIFIED` cho phụ huynh.
- ID không thuộc tài khoản hiện tại phải trả safe not-found, không làm lộ dữ liệu.
- Recovery không được tiết lộ email có tồn tại hay không.
- Không đưa expected answer vào question payload/UI trước khi trả lời.
- Giữ nguyên invariant: **No valid evidence → no child-error inference.**

## Bảo mật

Trước khi commit, kiểm tra không có:

- `.env` hoặc credential thật.
- API key, access token, cookie hoặc private key.
- Database URL hoặc Supabase service key.
- Dữ liệu người dùng thật.
- Đường dẫn tuyệt đối chỉ đúng trên máy cá nhân.
- `node_modules`, `.next`, test result, artifact hoặc log.

Nếu một secret đã xuất hiện trong lịch sử Git, báo ngay cho chủ dự án và thu hồi/rotate secret. Chỉ xóa secret ở commit mới không loại nó khỏi lịch sử.

## Nội dung pull request

Pull request cần ghi:

- Mục đích thay đổi.
- Route/component/service bị ảnh hưởng.
- UI state đã thêm hoặc sửa.
- Ảnh chụp desktop/mobile nếu giao diện thay đổi đáng kể.
- Command kiểm tra và kết quả thực tế.
- Giới hạn hoặc việc còn lại.

Không merge khi còn lỗi lint, typecheck, test hoặc build thuộc phạm vi thay đổi.
