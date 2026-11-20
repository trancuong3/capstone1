# BUGFIX & ZERO-DEFECT VERIFICATION REPORT — Khắc phục triệt để 5 nhóm lỗi Audit (ViRead)

> [!NOTE]
> Toàn bộ kết quả bên dưới được xác minh sau lần chỉnh sửa mã nguồn cuối cùng. Kiểm thử unit & Playwright sử dụng mock DB / HTTP + synthetic Web Audio fixture cô lập ở cổng `127.0.0.1:3106`; **không** chạy DDL hay ghi dữ liệu lên Supabase production.

---

## 1. Chi tiết nguyên nhân & cách khắc phục từng nhóm lỗi (1 → 5)

### Nhóm 1 — Xử lý 4 ca FAIL trong [reading-screen.test.tsx](file:///F:/c1/capstone1/frontend/tests/reading/reading-screen.test.tsx) (`58/62` → **`62/62 PASS`**)
1. **Hai ca `keeps browser final speech page-scoped without duplicate alignment: false/true` (dòng ~814)**:
   - *Nguyên nhân*: Giao diện [book-page-content.tsx](file:///F:/c1/capstone1/frontend/components/reading/book-page-content.tsx) đã áp dụng token Figma `"bg-success-surface text-success-ink"` cho từ đọc đúng lần đầu (dành `"bg-green-200"` riêng cho trạng thái `self-corrected`), trong khi assertion cũ vẫn kiểm tra `"bg-green-200"`.
   - *Khắc phục*: Cập nhật assertion từ đọc đúng lần đầu sang `"bg-success-surface"` và kiểm tra không có cả `"bg-green-200"` lẫn `"bg-success-surface"` ở trạng thái chưa đọc / chưa chắc chắn.
2. **Ca `opens the reading controls after start without claiming the microphone is already recording`**:
   - *Nguyên nhân*: Màn chuẩn bị [reading-ready.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-ready.tsx) (Figma desktop update) hiển thị heading chính `<h1>` là tên sách (`book.title`) cùng thông báo `"Microphone sẽ bật khi bắt đầu đọc."` thay cho tiêu đề cũ `"Sẵn sàng đọc chưa nào?"`.
   - *Khắc phục*: Xác nhận `<h1>` ngữ nghĩa tồn tại (`level: 1, name: bookFixture.title`) và thông báo không tự bật micro vẫn giữ nguyên.
3. **Ca `offers camera retry and safe exit without a manual page picker` (lỗi an toàn thật khi camera mờ)**:
   - *Nguyên nhân*: Khi cập nhật theo frame Figma `17:755` (`"Chọn trang"`), dialog lỗi camera `"Mình chưa nhìn rõ trang sách"` bị thay nút `"Kết thúc an toàn"` bằng `"Chọn trang"`, khiến trẻ mất lối thoát an toàn nhanh khi camera không nhận diện được trang.
   - *Khắc phục*: Bổ sung `tertiaryAction?: DialogAction` tại [reading-status-dialog.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-status-dialog.tsx) và giữ đủ cả 3 hành động trong [reading-screen.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-screen.tsx): `"Thử lại"` (`primary`), `"Chọn trang"` (`secondary` theo Figma `17:755`) và `"Kết thúc an toàn"` (`tertiary` mở modal xác nhận nghỉ an toàn). Cập nhật test bằng `within(dialog)` để kiểm tra đúng phạm vi hộp thoại.

---

### Nhóm 2 — Xóa toàn bộ 9 ESLint Warnings về **`0 errors, 0 warnings`**
- [admin-book-ai-batch-review.tsx](file:///F:/c1/capstone1/frontend/components/admin/admin-book-ai-batch-review.tsx): xóa import `useState` không dùng.
- [word-highlight-overlay.tsx](file:///F:/c1/capstone1/frontend/components/reading/word-highlight-overlay.tsx): xóa `ComparisonResult`, hàm `normalizeWord`, và biến `wordIndex` dư thừa.
- [reading-socket-adapter.ts](file:///F:/c1/capstone1/frontend/lib/api/reading-socket-adapter.ts): lược bỏ tham số không dùng trong `subscribe()`, `reconnect()`, `getSafetySnapshot()`.

---

### Nhóm 3 — Xóa cảnh báo DeprecationWarning Backend
- Kiểm tra FastAPI `0.121.2` / Starlette `0.49.3` trong `.venv` hỗ trợ sẵn `HTTP_422_UNPROCESSABLE_CONTENT` và `HTTP_413_CONTENT_TOO_LARGE`.
- Đổi toàn bộ 3 vị trí tại [difficult_words_service.py](file:///F:/c1/capstone1/backend/app/services/difficult_words_service.py) (dòng `1142`, `1148`, `1417`) — chạy `python -W default` xác nhận **0 DeprecationWarning** từ toàn bộ module luyện từ / chấm điểm.

---

### Nhóm 4 — Khắc phục hiển thị `<BookCover />` & Font tiêu đề tiếng Việt
1. **Bìa sách trong `DifficultWordBookCard` ([difficult-word-book-card.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-word-book-card.tsx))**:
   - Đổi từ khung vuông mặc định sang `<BookCover hero />` với tỷ lệ sách dọc `h-24! w-20! sm:h-28! sm:w-24!`, loại bỏ hoàn toàn phần chữ tiêu đề thừa bị cắt ở mép đáy bìa.
2. **Tiêu đề `.book-title` tiếng Việt ([globals.css](file:///F:/c1/capstone1/frontend/app/globals.css))**:
   - Đổi font serif từ `Georgia, "Times New Roman", serif` sang `"Cambria", "Palatino Linotype", "Book Antiqua", "Times New Roman", serif` để ký tự tổ hợp tiếng Việt như `ầ` trong `"Từ cần luyện của Bé An"` hiển thị dấu huyền + dấu mũ liền nét trên Chromium Windows.

---

### Nhóm 5 — Tái xác nhận 3 cơ chế cốt lõi không hồi quy
1. **VAD auto-stop không bị kẹt 6.5s**: `hasShortWordSpeechActivity` trong [word-practice-engine.ts](file:///F:/c1/capstone1/frontend/lib/reading/word-practice-engine.ts) tự ngắt sạch sau phát âm.
2. **Rảnh tay đa từ (`autoStart`)**: Hoàn thành từ #1 tự nhảy sang từ #2 và tự bật nghe không cần thêm tap nào.
3. **Khớp ngữ cảnh (`context_phrase`) & bảo toàn lỗi gốc**: `"bé có một bông hoa"` = `CORRECT`, `"một hai ba bốn năm"` = `UNCERTAIN`, từ `"một"` tô xanh sau 1 lần đọc lại nhưng vẫn giữ `first_pass_incorrect = 1` (`80.0%`).

---

## 2. Kết quả cổng kiểm định sau chỉnh sửa cuối

| Kiểm tra | Lệnh thực thi | Kết quả | Thời gian / Ghi chú |
| --- | --- | --- | --- |
| **Backend Tests (`-W default`)** | `..\.\.venv\Scripts\python.exe -W default -m unittest test_difficult_words test_reading_assessment test_reading_comparison_service test_parent_reports -v` | **64/64 OK (Exit 0)** | `1.876s`; **0 DeprecationWarning** ở module tính năng |
| **Prettier Format Check** | `npx.cmd prettier --check ...` (8 file chạm ở lượt fix) | **Exit 0** | *"All matched files use Prettier code style!"* |
| **ESLint (`npm run lint`)** | `npm.cmd run lint` | **0 errors, 0 warnings (Exit 0)** | Sạch 100% toàn bộ `frontend/` |
| **TypeScript (`tsc --noEmit`)** | `npm.cmd run typecheck` | **0 errors (Exit 0)** | — |
| **Vitest `--maxWorkers=1` (9 suites)** | `reading-screen.test.tsx` (`62/62`), `word-mot-qa-audit.test.tsx` (`3/3`), `short-word-recognition.test.ts` (`16/16`), `reading-retry-short-word.test.tsx` (`1/1`), `retry-word-recognition.test.ts` (`14/14`), `audio-quality.test.ts` (`9/9`), `session-reading-reports.test.tsx` (`6/6`), `real-parent-reports-ui.test.tsx` (`22/22`), `real-parent-report-services.test.ts` (`19/19`) | **9/9 file — 152/152 tests PASS (Exit 0)** | `Duration 89.45s` (`reading-screen.test.tsx`: `39.6s`) |
| **Playwright E2E (`difficult-words.pw.ts`)** | `PLAYWRIGHT_ROUTE_FILTER="/reports/difficult-words"; npx.cmd playwright test --config=playwright.real-data.config.ts test/browser/difficult-words.pw.ts` | **6/6 PASS (Exit 0)** | `1.3m`; Chromium VAD desktop `word1=2540ms / 2 từ=5844ms`, mobile `1989ms / 5318ms` |
| **Knowledge Graph** | `.\.venv\Scripts\python.exe -m graphify update .` | **Exit 0** | `17202 nodes, 37099 edges, 1004 communities` |

---

## 3. Liên kết kiểm chứng giao diện mới (sau khi chỉnh `<BookCover />` & Font Cambria)

- Desktop danh sách nhóm theo sách: [difficult-words-list-desktop.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-list-desktop.png)
- Desktop sân khấu luyện từ: [difficult-words-practice-desktop.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-practice-desktop.png)
- Mobile (`390px`) danh sách nhóm theo sách: [difficult-words-list-mobile.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-list-mobile.png)
- Mobile (`390px`) sân khấu luyện từ: [difficult-words-practice-mobile.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-practice-mobile.png)
