# FINAL REPORT — Tổng kết nâng cấp hệ thống luyện đọc tiếng Việt cho trẻ em (ViRead)

## 1. Tóm tắt điều hành

Hệ thống luyện từ khó (`/reports/difficult-words`) và luồng đọc lại từ ngắn ngay trong sách (`/reading/[sessionId]`) đã được thiết kế lại và đồng bộ từ giao diện tới backend:

1. **Đọc đúng 1 lần là nhận diện được trong điều kiện âm thanh rõ**:
   - Preset `"short-word"` trong [audio-quality.ts](file:///F:/c1/capstone1/frontend/lib/reading/audio-quality.ts) + VAD âm học tại [word-practice-engine.ts](file:///F:/c1/capstone1/frontend/lib/reading/word-practice-engine.ts) chấm dứt tình trạng từ đơn âm tiết `"có"` bị nhiễu `noiseFloorRms` hay treo 3.5s–12s chờ Web Speech.
   - Độ chính xác tiếng Việt được giữ nghiêm (không xác nhận sai cho thanh điệu `cỏ`/`cá` hay phụ âm `chó`, đồng thời lọc `[tiếng đập]` và gộp token echo lặp).
2. **Loại bỏ hoàn toàn lỗi `503` khi bảng phụ chưa migrate**:
   - Backend `DifficultWordsService` + `DifficultWordsRepository` đọc/ghi dual-store qua `public.readingevents` (`Type = 'WORD_RETRY'`) khi `public.difficult_word_practice_attempts` chưa có trong schema, cùng endpoint gộp 1 roundtrip `POST /system/difficult-words/{child_id}/practice/evaluate` và `REQUIRED_CONSECUTIVE_CORRECT = 1`.
3. **Giao diện thân thiện cho trẻ lớp 1 & đồng bộ Đỏ → Vàng → Xanh**:
   - `/reports/difficult-words` nhóm theo cuốn sách (`BookCover`, thanh tiến độ `"Đã luyện đúng X/Y từ"`, chip từ chạm lớn, `<details>` phụ huynh gọn gàng, sân khấu luyện 1 chạm rảnh tay).
   - Trạng thái Đỏ → Vàng (`activeRetryWordId`) → Xanh (`self_corrected_word_ids` / `COMPLETED`) đồng bộ từ lúc bé đang đọc trang sách tới báo cáo phiên và danh sách từ cần luyện.

---

## 2. Checklist tiêu chí hoàn thành

- [x] Phân tích nguyên nhân gốc rễ đầy đủ: [ROOT_CAUSE.md](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/ROOT_CAUSE.md)
- [x] Kiến trúc core engine + dual-store persistence: [ARCHITECTURE.md](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/ARCHITECTURE.md)
- [x] Thiết kế lại `/reports/difficult-words` & UI sync Đỏ → Vàng → Xanh: [UI_UX_CHANGES.md](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/UI_UX_CHANGES.md)
- [x] Migration SQL an toàn (chưa chạy DDL lên production) & fallback `readingevents`: [DATABASE_CHANGES.md](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/DATABASE_CHANGES.md)
- [x] Ghi nhận đúng các skills đã dùng: [SKILLS_USED.md](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/SKILLS_USED.md)
- [x] Toàn bộ kết quả test trung thực, phân biệt fixture vs production: [TEST_RESULTS.md](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/TEST_RESULTS.md)
- [x] Số liệu đo thời gian & benchmark thực tế: [PERFORMANCE_RESULTS.md](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/PERFORMANCE_RESULTS.md)
- [x] Bảo toàn entrypoint `app.sever:app`, không sửa dependency pin, không ghi đè thay đổi `FIGMA_DESKTOP_COVERAGE` có sẵn.

---

## 3. Danh mục file trọng tâm đã tạo / chỉnh sửa

### Backend & Database
- [20261118090000_difficult_word_practice.sql](file:///F:/c1/capstone1/supabase/migrations/20261118090000_difficult_word_practice.sql)
- [difficult_word_practice.py](file:///F:/c1/capstone1/backend/app/models/difficult_word_practice.py)
- [difficult_words.py](file:///F:/c1/capstone1/backend/app/schemas/difficult_words.py), [system.py](file:///F:/c1/capstone1/backend/app/schemas/system.py), [reading.py](file:///F:/c1/capstone1/backend/app/schemas/reading.py)
- [difficult_words_repository.py](file:///F:/c1/capstone1/backend/app/repositories/difficult_words_repository.py)
- [difficult_words_service.py](file:///F:/c1/capstone1/backend/app/services/difficult_words_service.py), [reading_comparison_service.py](file:///F:/c1/capstone1/backend/app/services/reading_comparison_service.py)
- [system.py (routes)](file:///F:/c1/capstone1/backend/app/api/routes/system.py)
- [test_difficult_words.py](file:///F:/c1/capstone1/backend/test_difficult_words.py)

### Frontend Core, UI & Tests
- [word-practice-engine.ts](file:///F:/c1/capstone1/frontend/lib/reading/word-practice-engine.ts), [audio-quality.ts](file:///F:/c1/capstone1/frontend/lib/reading/audio-quality.ts), [retry-word-recognition.ts](file:///F:/c1/capstone1/frontend/lib/reading/retry-word-recognition.ts), [use-speech-recorder.ts](file:///F:/c1/capstone1/frontend/hooks/use-speech-recorder.ts)
- [difficult-word-service.ts](file:///F:/c1/capstone1/frontend/lib/api/difficult-word-service.ts), [comparison-service.ts](file:///F:/c1/capstone1/frontend/lib/api/comparison-service.ts), [reports.ts](file:///F:/c1/capstone1/frontend/types/reports.ts)
- [reading-screen.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-screen.tsx), [word-highlight-overlay.tsx](file:///F:/c1/capstone1/frontend/components/reading/word-highlight-overlay.tsx), [book-page-content.tsx](file:///F:/c1/capstone1/frontend/components/reading/book-page-content.tsx), [book-page-viewer.tsx](file:///F:/c1/capstone1/frontend/components/reading/book-page-viewer.tsx), [reading-layout.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-layout.tsx), [ReadingReport.tsx](file:///F:/c1/capstone1/frontend/components/reading/ReadingReport.tsx)
- [session-reading-reports.tsx](file:///F:/c1/capstone1/frontend/components/reports/session-reading-reports.tsx), [difficult-word-book-card.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-word-book-card.tsx), [difficult-words-screen.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-words-screen.tsx), [difficult-word-practice-panel.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-word-practice-panel.tsx)
- Tests & E2E: [short-word-recognition.test.ts](file:///F:/c1/capstone1/frontend/tests/reading/short-word-recognition.test.ts), [reading-retry-short-word.test.tsx](file:///F:/c1/capstone1/frontend/tests/reading/reading-retry-short-word.test.tsx), [session-reading-reports.test.tsx](file:///F:/c1/capstone1/frontend/tests/reports/session-reading-reports.test.tsx), [real-parent-report-services.test.ts](file:///F:/c1/capstone1/frontend/test/real-parent-report-services.test.ts), [real-parent-reports-ui.test.tsx](file:///F:/c1/capstone1/frontend/test/real-parent-reports-ui.test.tsx), [difficult-words.pw.ts](file:///F:/c1/capstone1/frontend/test/browser/difficult-words.pw.ts), [warm-routes.ts](file:///F:/c1/capstone1/frontend/test/browser/warm-routes.ts), [real-data.pw.ts](file:///F:/c1/capstone1/frontend/test/browser/real-data.pw.ts), [real-data-fixture.ts](file:///F:/c1/capstone1/frontend/test/browser/real-data-fixture.ts)

### Ảnh chụp màn hình kiểm chứng
- [difficult-words-list-desktop.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-list-desktop.png)
- [difficult-words-practice-desktop.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-practice-desktop.png)
- [difficult-words-list-mobile.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-list-mobile.png)
- [difficult-words-practice-mobile.png](file:///F:/c1/capstone1/docs/antigravity-word-practice-upgrade/difficult-words-practice-mobile.png)

---

## 4. Lưu ý vận hành tiếp theo cho chủ dự án

1. Khi sẵn sàng áp dụng schema provenance lên Supabase thật, chạy file migration [20261118090000_difficult_word_practice.sql](file:///F:/c1/capstone1/supabase/migrations/20261118090000_difficult_word_practice.sql) qua Supabase CLI / SQL Editor chính thức. (Trong khi chưa chạy migration, hệ thống vẫn hoạt động bình thường không lỗi `503` nhờ `WORD_RETRY` fallback).
2. Có thể commit tách biệt hoặc hoàn thiện 4 assertion UI cũ trong `tests/reading/reading-screen.test.tsx` thuộc bộ thay đổi `FIGMA_DESKTOP_COVERAGE` đang có sẵn trên nhánh làm việc.
