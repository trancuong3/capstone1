# UI/UX CHANGES — Thiết kế lại `/reports/difficult-words` & đồng bộ Đỏ → Vàng → Xanh

Báo cáo thay đổi giao diện và trải nghiệm cho trẻ lớp 1 và phụ huynh, giữ nhất quán token màu Figma của ViRead (`#F6FAF8` nền, `#DCE8E4` viền card, `#147D87` / `#0E6D76` accent xanh ngọc, `#213C42` chữ chính, `#526970` chữ phụ, `#DDF3F5` / `#E8EFEA` surface phụ).

---

## 1. Màn hình `/reports/difficult-words` nhóm theo sách ([difficult-words-screen.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-words-screen.tsx))

### Trước đây
- Danh sách thẻ phẳng theo từng từ khó, lặp lại nhiều thông số kỹ thuật (`difficulty_score`, số lần bỏ qua/lặp từ) ngay trên mặt card, không thể hiện từ đó xuất hiện ở cuốn sách nào.
- Yêu cầu nhiều bước bấm thủ công: mở từ → ghi âm → dừng → hoàn thành → quay lại → đọc lại 2 lần liên tiếp mới xanh.

### Sau nâng cấp
- **Khối tổng quan & bộ lọc gọn cho phụ huynh**: chọn bé, khoảng thời gian (30 / 90 / 180 ngày), bộ lọc trạng thái luyện, thanh tiến độ `"X/Y từ đã đọc đúng"` và nút nhanh `"Luyện N từ cần ôn"`.
- **Thẻ nhóm theo sách ([difficult-word-book-card.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-word-book-card.tsx))**:
  - Hiển thị `<BookCover />`, badge lớp (`Lớp 1`, ...), tên sách, tác giả, thanh tiến độ `"Đã luyện đúng X/Y từ"`.
  - **Chip từ bấm trực tiếp** với độ cao chạm tối thiểu `min-h-11` và 3 màu trực quan:
    - Đỏ (`NOT_PRACTICED` / `NEEDS_MORE_PRACTICE`): `"Chưa đọc lại"` / `"Cần luyện thêm"`
    - Hổ phách (`IN_PROGRESS`): `"Đang luyện"`
    - Xanh (`COMPLETED`): `"Đã đọc đúng"` kèm icon dấu tích
  - **Thông tin kỹ thuật được gom vào `<details>` `"Chi tiết cho phụ huynh"`** (ẩn mặc định để màn hình thoáng cho bé, mở ra xem trang nguồn, câu ngữ cảnh, điểm khó và số lỗi bỏ/lặp/nhầm).
  - CTA 1 chạm `"Luyện cùng bé"` (hoặc `"Luyện lại sách này"` khi đã hoàn thành 100%).

---

## 2. Sân khấu luyện 1 chạm rảnh tay ([difficult-word-practice-panel.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-word-practice-panel.tsx))

- Hiển thị ngữ cảnh sách, số trang và câu gốc (ví dụ `"Chào ngày mới · Trang 2 · “Bé có một bông hoa.”"`).
- Chữ mục tiêu cỡ lớn (`text-5xl font-black sm:text-6xl`), nút `"Bắt đầu luyện"` duy nhất:
  - Khi âm thanh rõ, `word-practice-engine.ts` tự kích hoạt phát hiện tiếng nói VAD, tự dừng ghi âm sau khi kết thúc từ + khoảng lặng (`520ms` sau `minCaptureMs: 650ms`), gửi `evaluatePracticeWord` và chuyển thẻ từ sang xanh `"Chính xác rồi! Con giỏi lắm!"` + `"Hoàn thành từ này"` chỉ sau **1 lần đọc đúng**.
  - Cung cấp nút khôi phục `"Lưu lại kết quả"` nếu gặp lỗi mạng tạm thời, nút `"Nghe phát âm mẫu"`, `"Nghe lại giọng bé"`, và `<details>` `"Lịch sử luyện từ này"` ngay bên dưới.
  - Sửa bug lifecycle hook để cleanup micro chỉ chạy khi unmount component, tránh cancel mất phiên khi `speechRecorder` cập nhật trạng thái.

---

## 3. Đồng bộ Đỏ → Vàng → Xanh trong đọc sách & báo cáo phiên

- Trong [reading-screen.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-screen.tsx), [word-highlight-overlay.tsx](file:///F:/c1/capstone1/frontend/components/reading/word-highlight-overlay.tsx), [book-page-content.tsx](file:///F:/c1/capstone1/frontend/components/reading/book-page-content.tsx), [book-page-viewer.tsx](file:///F:/c1/capstone1/frontend/components/reading/book-page-viewer.tsx) và [reading-layout.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-layout.tsx):
  - Từ đang được chọn luyện lại nhận trạng thái `activeRetryWordId` (highlight **vàng** rõ ràng).
  - Sau khi bé đọc lại đúng 1 lần và `WORD_RETRY` `CONFIRMED` được lưu, từ ưu tiên hiển thị màu **xanh** (`selfCorrectedWordIds` / `correctWordIds` được xét trước `skippedWordIds` / `mispronouncedWordIds`).
- Trong [ReadingReport.tsx](file:///F:/c1/capstone1/frontend/components/reading/ReadingReport.tsx) và [session-reading-reports.tsx](file:///F:/c1/capstone1/frontend/components/reports/session-reading-reports.tsx): đọc `self_corrected_word_ids` từ API để tô xanh các từ `"Đã đọc lại đúng"` kèm chú giải tương ứng.

---

## 4. Ảnh chụp kiểm thử giao diện (Desktop 1440px & Mobile 390px)

- Danh sách nhóm theo sách (Desktop): [difficult-words-list-desktop.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-list-desktop.png)
- Sân khấu luyện 1 từ hoàn thành xanh (Desktop): [difficult-words-practice-desktop.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-practice-desktop.png)
- Danh sách nhóm theo sách (Mobile 390px): [difficult-words-list-mobile.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-list-mobile.png)
- Sân khấu luyện 1 từ hoàn thành xanh (Mobile 390px): [difficult-words-practice-mobile.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-practice-mobile.png)
