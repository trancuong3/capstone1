# TEST RESULTS — Kết quả kiểm thử sau nâng cấp

> [!NOTE]
> Tài liệu phân tách rõ **kiểm thử đơn vị / HTTP test double / Playwright fixture** với **cơ sở dữ liệu Supabase production**. Không có thao tác DDL hoặc ghi dữ liệu thử nghiệm nào được thực thi lên Supabase production trong suốt phiên này.

---

## 1. Backend Python Unit Tests (54 + 128 = 182 tests PASSED)

1. **Nhóm mục tiêu (`difficult-words`, `parent-reports`, `reading-assessment`)**:
   - Lệnh: `.\.venv\Scripts\python.exe -m unittest test_difficult_words test_parent_reports test_reading_assessment -v` (tại `backend/`)
   - Kết quả: **Ran 54 tests in 1.074s — OK (exit 0)**
   - Bao quát: tổng hợp từ theo sách nguồn + ngữ cảnh câu `_build_context_phrase`, kiểm soát quyền phụ huynh/bé, đọc/ghi dual-store qua `readingevents` (`WORD_RETRY`) khi chưa có bảng `difficult_word_practice_attempts` (không trả `503`), hoàn thành chỉ sau **1** lần đọc đúng rõ, không phạt `UNCERTAIN`, lọc `[tiếng đập]`, giữ phân biệt thanh điệu & `đ`/`d`, và `ReadingComparisonService` trả `self_corrected_word_ids`.
2. **Nhóm hồi quy liên quan (`comparison`, `content`, `progress`, `alignment`, `migration`)**:
   - Lệnh: `.\.venv\Scripts\python.exe -m unittest test_reading_comparison_service test_reading_comparison_repository test_reading_content_service test_reading_progress test_reading_practice_state test_alignment test_child_progress test_migration_versions -v` (tại `backend/`)
   - Kết quả: **Ran 128 tests in 1.789s — OK (exit 0)**

*Lưu ý môi trường test*: các unit test backend sử dụng mock/fake AsyncSession và SQLAlchemy repository queries được xác minh logic không gọi mạng hay Supabase thật.

---

## 2. Frontend Static Analysis & Build Gates

| Kiểm tra | Lệnh | Kết quả |
| --- | --- | --- |
| Prettier (25 file đã sửa/tạo) | `npx.cmd prettier --check ...` | **Exit 0** — *"All matched files use Prettier code style!"* |
| ESLint | `npm.cmd run lint` | **Exit 0** — **0 errors**, 9 warnings có sẵn (không phát sinh mới) |
| TypeScript | `npm.cmd run typecheck` (`tsc --noEmit`) | **Exit 0** — **0 errors** |
| Production Build | `$env:NEXT_DIST_DIR=".next-word-upgrade-build"; npm.cmd run build` | **Exit 0** — Compiled in `13.0s`, TypeScript in `33.3s`, **38/38 static pages** (đã xóa thư mục build tạm sau khi xong) |

---

## 3. Frontend Vitest Suites (`--maxWorkers=1`)

1. **12 suite liên quan trực tiếp & hồi quy (156/156 PASSED)**:
   - Lô 9 file (`Duration 31.23s`): **Test Files 9 passed (9), Tests 134 passed (134)**
     - `test/real-parent-reports-ui.test.tsx` (21 passed — gồm luồng luyện nhóm theo sách, hoàn thành sau 1 lần đọc, phục hồi lỗi lưu, đồng bộ tiến độ)
     - `test/real-parent-report-services.test.ts` (19 passed)
     - `test/reading-progress-services.test.ts` (18 passed)
     - `tests/reports/session-reading-reports.test.tsx` (6 passed — gồm `self_corrected_word_ids` tô xanh)
     - `tests/reading/reading-retry-short-word.test.tsx` (1 passed — `"Bé có một bông hoa."`: đỏ → vàng khi retry → nói `"có"` 1 lần nhỏ rõ → lưu `CONFIRMED` → xanh)
     - `tests/reading/short-word-recognition.test.ts` (16 passed — 12 case `"có"` tiếng Việt + tổng hợp sóng formant `F0=260Hz`, `F1=550Hz`, `F2=900Hz`)
     - `tests/reading/audio-quality.test.ts` (9 passed)
     - `tests/reading/recognition-evidence.test.ts` (30 passed)
     - `tests/reading/retry-word-recognition.test.ts` (14 passed)
   - Lô 3 file (`Duration 12.39s`): **Test Files 3 passed (3), Tests 22 passed (22)**
     - `tests/reports/group5-components.test.tsx` (5 passed)
     - `tests/services/mock-report-services.test.ts` (7 passed)
     - `tests/reading/retry-recognition.test.ts` (10 passed)

2. **`tests/reading/reading-screen.test.tsx` (`Duration 47.94s`) — 58 passed | 4 failed (62 tests)**:
   - Toàn bộ các test về word-retry trong file đều **PASSED**.
   - 4 test FAIL là **pre-existing** từ các thay đổi uncommitted `FIGMA_DESKTOP_COVERAGE` có sẵn trước đó trên workspace (không do nâng cấp này và không sửa đè lên nhánh UI người dùng đang làm):
     1. `keeps browser final speech page-scoped without duplicate alignment: false` (kỳ vọng `bg-green-200`, UI hiện dùng `bg-success-surface text-success-ink font-bold`)
     2. `keeps browser final speech page-scoped without duplicate alignment: true` (cùng kỳ vọng `bg-green-200`)
     3. `opens the reading controls after start without claiming the microphone is already recording` (tìm heading cũ `"Sẵn sàng đọc chưa nào?"`)
     4. `offers camera retry and safe exit without a manual page picker` (tìm nút `"Kết thúc an toàn"`)

---

## 4. Playwright Browser E2E (Chạy với `playwright.real-data.config.ts`, cổng cô lập `127.0.0.1:3106` & HTTP API + Synthetic Audio Fixture)

1. **`test/browser/difficult-words.pw.ts` (`PLAYWRIGHT_ROUTE_FILTER="/reports/difficult-words"`)**:
   - Kết quả: **4 passed (1.2m), Exit 0**
     - `[desktop] Difficult words end-to-end flow...` (`9.8s`)
     - `[desktop] Difficult words resilient states...` (`4.8s`)
     - `[mobile] Difficult words end-to-end flow...` (`9.8s`)
     - `[mobile] Difficult words resilient states...` (`4.2s`)
   - Đã kiểm tra horizontal overflow = `false` ở cả 4 kích thước `1440`, `1024`, `768`, `390`, chuyển đổi hồ sơ bé (`Bé An` ↔ `Bé Bình`), luyện 1 chạm từ `"có"` hoàn thành sau 1 lần, tải lại trang giữ nguyên `"Đã luyện đúng 1/2 từ"`, retry từ `503`, trạng thái rỗng và thông báo từ chối quyền Micro.
2. **`test/browser/real-data.pw.ts` (`PLAYWRIGHT_ROUTE_FILTER="/sessions,/reports,/reports/difficult-words"`, `--project=desktop`)**:
   - Kết quả: **3 passed (1.6m), Exit 0**
     - `Parent stored history → detail, report counts and words` (`9.7s`)
     - `Parent unavailable reports/history do not manufacture zero data and can retry` (`8.5s`)
     - `read-route matrix parent, headings, console and overflow at all requested widths` (`17.8s`)
