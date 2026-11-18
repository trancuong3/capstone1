# DATABASE CHANGES — Schema Migration & Dual-Store `WORD_RETRY` Persistence

> [!IMPORTANT]
> Không chạy DDL (`CREATE TABLE` / `ALTER TABLE`) trực tiếp lên Supabase production database (`port 6543`) trong phiên làm việc tự động này. File migration dưới đây được cập nhật sẵn trong mã nguồn để áp dụng qua quy trình migration có kiểm soát, đồng thời backend đã chạy ổn định ngay cả khi bảng chưa được khởi tạo nhờ fallback `readingevents`.

---

## 1. Cập nhật Migration SQL & SQLAlchemy Model

- Migration SQL: [20261118090000_difficult_word_practice.sql](file:///F:/c1/capstone1/supabase/migrations/20261118090000_difficult_word_practice.sql)
- ORM Model: [difficult_word_practice.py](file:///F:/c1/capstone1/backend/app/models/difficult_word_practice.py)

### Các cột provenance bổ sung (Idempotent `add column if not exists`)
Trên bảng `public.difficult_word_practice_attempts`:
- `bookid uuid references public.books(id) on delete set null`
- `sessionid uuid references public.readingsessions(id) on delete set null`
- `pageid uuid references public.bookpages(id) on delete set null`
- `pagerevisionid uuid references public.pagerevisions(id) on delete set null`
- `wordid uuid references public.pagerevisionwords(id) on delete set null`
- Index bổ sung:
  - `ix_difficult_word_practice_book_session on public.difficult_word_practice_attempts (bookid, sessionid) where bookid is not null or sessionid is not null`
- Model SQLAlchemy tương ứng: `BookId`, `SessionId`, `PageId`, `PageRevisionId`, `WordId`.
- Chính sách RLS (`difficult_word_practice_parent_owns_child`) và `revoke all ... from anon, authenticated` + `grant all ... to service_role` giữ nguyên bảo vệ dữ liệu trẻ em.

---

## 2. Hợp đồng Dual-Store Fallback (`public.readingevents` `Type = 'WORD_RETRY'`)

Khi `DifficultWordsRepository.is_practice_storage_ready()` kiểm tra `to_regclass('public.difficult_word_practice_attempts')` trả `false`:

1. **Ghi lượt luyện ([difficult_words_repository.py](file:///F:/c1/capstone1/backend/app/repositories/difficult_words_repository.py))**:
   - `resolve_retry_target(...)` xác định `session_id`, `page_id`, `word_id` hợp lệ thuộc quyền phụ huynh/bé (`readingsessions` + `childprofiles`), nếu từ không gắn sẵn thì chọn target mới nhất của bé.
   - `create_retry_event(...)` ghi bản ghi vào `public.readingevents` với `Type = 'WORD_RETRY'` và metadata chuẩn hóa chứa `target_word`, `normalized_word`, `display_text`, `request_id`, `completion_request_id`, `assessment_status`, `recognition_source`, `spoken_transcript`, `confidence`, `audio_duration_ms`, `book_id`, `page_id`, `page_revision_id`, `word_id`, `attempt_number`.
   - `find_retry_event_by_request(...)` đảm bảo idempotency theo `request_id` / `completion_request_id` không tạo bản ghi trùng khi retry mạng.
2. **Đọc & Hợp nhất ([difficult_words_service.py](file:///F:/c1/capstone1/backend/app/services/difficult_words_service.py))**:
   - `_load_merged_attempts(...)` đọc từ `difficult_word_practice_attempts` (khi bảng đã sẵn sàng) và `list_retry_events_for_child` (từ `readingevents`), hợp nhất lịch sử để tính `compute_word_practice_progress(...)` với ngưỡng hoàn thành `REQUIRED_CONSECUTIVE_CORRECT = 1`.
   - Payload API phản hồi bổ sung `resolved_in_session` và `persistence_backend` (trong [difficult_words.py](file:///F:/c1/capstone1/backend/app/schemas/difficult_words.py)), giúp loại bỏ lỗi `503` trên hệ thống chưa migrate.

---

## 3. Đồng bộ Báo cáo Phiên đọc (`self_corrected_word_ids`)

- Schema [reading.py](file:///F:/c1/capstone1/backend/app/schemas/reading.py): `ReadingComparisonReportRead` bổ sung `self_corrected_word_ids: list[UUID] = Field(default_factory=list)`.
- Service [reading_comparison_service.py](file:///F:/c1/capstone1/backend/app/services/reading_comparison_service.py): `list_for_session` truy vấn các sự kiện `WORD_RETRY` có trạng thái `CONFIRMED` để điền `self_corrected_word_ids`, giúp trang báo cáo đồng bộ chính xác màu xanh cho từ bé đã đọc lại đúng mà không ghi đè dữ liệu đánh giá lần đọc đầu (`first-pass assessment`).
