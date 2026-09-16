## Mục đích

Mô tả ngắn gọn vấn đề và kết quả của thay đổi.

## Phạm vi

- Route/component/service bị ảnh hưởng:
- UI state bị ảnh hưởng:
- Ngoài phạm vi:

## Kiểm tra thực tế

- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e` nếu thay đổi route/navigation/UI behavior

Ghi kết quả hoặc lỗi thực tế:

## Giao diện

- [ ] Không thay đổi giao diện đáng kể
- [ ] Đã đính kèm ảnh desktop và mobile
- [ ] Đã kiểm tra keyboard/focus và responsive

## Bảo mật và contract

- [ ] Không có `.env`, secret, credential hoặc dữ liệu người dùng thật
- [ ] Không tự thay đổi DTO, status hoặc error code
- [ ] Không làm suy luận lỗi của bé khi evidence không hợp lệ
- [ ] ID không thuộc tài khoản vẫn dùng safe not-found

## Việc còn lại hoặc giới hạn

Liệt kê nếu có; ghi “Không có” nếu pull request đã hoàn chỉnh trong phạm vi.
