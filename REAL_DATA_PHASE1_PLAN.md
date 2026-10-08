# Phase 1 — Nối dữ liệu thật theo mẫu Dashboard

Ngày: 2026-10-08. Repository: `D:\Project\capston1_new\capstone1`.

- Base: `main`, commit `8982d81` — Update dashboard and Supabase integration.
- Nhánh mới: `feature/linh-real-data`. Nhánh `linh` cũ được giữ nguyên vì đã chứa task Auth và có tracking `origin/linh`.
- Phạm vi: hiển thị dữ liệu thật ở các tab Parent và Admin, thay runtime mock/unavailable service bằng API đọc dữ liệu. Không làm lại UI, Auth, realtime/AI hoặc database schema.
- Phase 1 chỉ tạo tài liệu này; chưa tạo API, adapter hay sửa nghiệp vụ. Không push/commit, không dùng stash Auth cũ, không thay env thật, không truy cập Supabase/PostgreSQL live.

## 1. Mẫu thực tế trên main

Frontend Dashboard gọi `useProfileService()` và `useChildService()`, lấy dữ liệu song song, hiển thị loading/ready/error và empty khi list thực sự rỗng. `frontend/lib/api/profile-service.ts` lấy Supabase access token, gửi Bearer token tới FastAPI, `cache: no-store`, normalize DTO và `ServiceError`. Không copy các cast JSON thiếu kiểm tra vào adapter mới; adapter mới kiểm tra response theo DTO hiện có.

Backend GET `/profiles/me`:

1. `backend/app/api/router.py` đăng ký router với prefix `/profiles`.
2. `backend/app/api/routes/profile.py:get_current_profile()` nhận ID từ `get_current_parent_id`.
3. `ProfileService.get_current_profile()` gọi `ProfileRepository.get_by_id()`.
4. Repository query `Profile.Id == parent_id` qua SQLAlchemy.
5. `backend/app/models/profile.py:Profile` map bảng `profiles`.
6. Model trả qua Repository → Service → `ParentProfileResponse` → Router → JSON.

Các class Service/Repository hiện cùng nằm trong `api/routes/profile.py`; không di chuyển chúng chỉ để đổi cấu trúc folder. GET không cần body request schema; path/query vẫn phải validate. POST Child hiện trả 201, DELETE Child trả 204: giữ nguyên, không đổi về contract của bản Auth đã bỏ.

Tài liệu tham chiếu là `D:\DOWNLOADS\Flow 1.md`: Router lo HTTP, Schema lo validate/format, Service lo nghiệp vụ, Repository lo query, ORM map bảng. File tài liệu có đoạn Python bao quanh nội dung; chỉ đọc, không chạy đoạn tạo file trong đó.

### 1.1 Luồng frontend phải theo mẫu Dashboard

Luồng gọi hiện tại: `app/(app)/dashboard/page.tsx` → `AppServicesProvider` → `DashboardScreen` → `useProfileService/useChildService` → HTTP service → FastAPI. Provider cung cấp service qua context; screen sử dụng hook để lấy service, không gọi Supabase/database trực tiếp.

| Lớp                        | File mẫu thực tế                                                | Trách nhiệm và cách áp dụng cho các tab khác                                                                                                |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| App/page                   | `frontend/app/(app)/dashboard/page.tsx`                         | Ghép provider với screen; các page khác giữ metadata, route params, childId và pagination, chỉ bỏ wiring demo                               |
| Provider, thuộc components | `frontend/components/providers/app-services-provider.tsx`       | Inject implementation thật. Profile/Child đã thật; Books/Sessions/Reports/DifficultWord còn unavailable, thay từng service khi API sẵn sàng |
| Screen/component           | `frontend/components/dashboard/dashboard-screen.tsx`            | Gọi service qua hook, quản lý loading/ready/error/retry và empty từ response thật; tái sử dụng screen/UI có sẵn                             |
| Hook                       | `frontend/hooks/use-profile-service.ts`, `use-child-service.ts` | Đọc context và trả typed service; không đưa fetch hoặc mock vào hook                                                                        |
| HTTP service               | `frontend/lib/api/profile-service.ts`, `child-service.ts`       | Lấy access token, gọi FastAPI, kiểm tra/map response và lỗi an toàn                                                                         |
| Backend                    | `backend/app/api/routes/profile.py` và schemas/models liên quan | Router → Service → Repository → ORM/PostgreSQL, response qua Schema rồi trở lại frontend                                                    |

Commit main `8982d81` sửa Dashboard **page** và provider trong **components** để nối Profile thật; không sửa `dashboard-screen.tsx`. Vì vậy kế hoạch phải bao gồm app/components, nhưng không viết lại screen đã dùng service đúng. Implementation gọi FastAPI được bổ sung ngay trong file service hiện có ở `frontend/lib/api`; provider nối factory thật vào screen hiện có. Không tạo thư mục `frontend/lib/http`. Không đưa SQL, Supabase service-role key hoặc logic phân quyền backend vào component.

## 2. Hiện trạng API và nguồn dữ liệu

Các bảng bên dưới được xác định từ ORM trong source, **chưa được xác nhận bằng truy vấn database live**.

| Màn / route web                      | Interface frontend                                                                        | API hiện có                                                                   | Bảng / nguồn                                                                             | Việc còn thiếu                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard, Profile                   | ProfileService                                                                            | GET `/profiles/me`; PUT `/profiles/{profile_id}`                              | `profiles`                                                                               | Đã có HTTP adapter; giữ nguyên mẫu. PUT legacy chưa có dependency Auth, cần báo chủ API, không coi là an toàn chỉ vì UI gửi token |
| Children                             | ChildService                                                                              | GET/POST `/profiles/children`; GET/PUT/DELETE `/profiles/children/{child_id}` | `childprofiles`                                                                          | Đã có HTTP adapter và owner predicates; giữ nguyên                                                                                |
| `/books`, `/books/[bookId]`          | BookService.list/get/listPages                                                            | GET `/books/`; GET `/books/{book_id}/pages`                                   | `books`, `bookpages`, `pagerevisions`                                                    | Raw DTO PascalCase; chưa có detail endpoint, search/filter, Parent eligibility, verified preview URL hoặc auth trên router Books  |
| `/sessions`, `/sessions/[sessionId]` | SessionService.list/get                                                                   | GET `/reading/sessions`                                                       | `readingsessions`, `childprofiles`, `readingevents`, `fluencyassessments`, comprehension | API list tất cả, chưa owner-filter, cursor hoặc detail aggregate; frontend cần snake_case envelope và metrics nullable            |
| `/reports`                           | ReportService.get                                                                         | GET `/system/reports`                                                         | `progressreports.summary`, sessions/events/answers nếu cần                               | Chưa owner-filter/period query; chưa có schema cho JSON Summary tương thích ProgressReportDTO                                     |
| `/reports/difficult-words`           | DifficultWordService.list                                                                 | Chưa có endpoint tương ứng                                                    | `readingevents`, `pagerevisionwords`, sessions/revisions                                 | Chưa có query/tổng hợp được chốt; không có bảng difficult words riêng trong ORM                                                   |
| `/admin/books`, detail               | AdminBookService.list/get                                                                 | GET `/books/`; POST `/books/` legacy                                          | `books`, pages/revisions                                                                 | Thiếu Admin guard, aggregate counts, eligibility và read-detail contract                                                          |
| Admin pages / OCR review             | AdminPageService.list/getImage/reload; RevisionService.list; OcrReviewService.getRevision | GET `/books/{book_id}/pages`                                                  | `bookpages`, `pagerevisions`, `pagerevisionwords`, Storage                               | Thiếu read APIs revision/words/image/processing DTO và Admin guard; không triển khai OCR mới                                      |
| `/admin/audit-logs`                  | AuditService.list                                                                         | GET `/system/logs`                                                            | `auditlogs`                                                                              | Chưa Admin guard, query/cursor hoặc safe metadata projection; legacy schema không nhận nullable actor/resource trong ORM          |
| `/admin/health`                      | HealthService.get                                                                         | Chưa có endpoint tương ứng                                                    | Các phép kiểm tra dịch vụ thực tế                                                        | Không có bảng health; chưa có probe implementation; không gán HEALTHY từ dữ liệu mẫu                                              |

Books/Reading/System legacy routers đang query ORM trực tiếp, khác mẫu Service/Repository. Code mới đi đúng flow; không refactor toàn bộ legacy routers. Admin provider và store vẫn import `@/lib/mock/...` dù folder đó đã bị xóa. Parent provider chỉ có Profile/Child thật, các service khác là unavailable Proxy; không gọi đây là dữ liệu thật đã nối.

## 3. Response contracts giữ nguyên theo frontend

| Domain              | DTO hiện có và mapping                                                                                                                          | Không được tự giả định                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Books               | `BookListItemDTO`: Id→id, Title→title, Author→author, MinGrade/MaxGrade→min_grade/max_grade, LifecycleStatus→lifecycle_status; detail cùng kiểu | Không thêm `books.verification_status`; trạng thái VERIFIED thuộc revision. Policy eligibility phải được chốt trước Phase 3                           |
| Parent preview      | `BookPagePreviewDTO`: page_id, page_number, lifecycle_status, current_verified_revision_id, preview_url                                         | Current revision phải đúng page và VERIFIED; ImagePath không tự được coi là URL. Bucket/public/signed URL cần xác nhận                                |
| Session history     | `SessionHistoryResponseDTO` = sessions + next_cursor; summary dùng id/child_id/book_id/state/started_at/ended_at/duration_ms                    | Chỉ tính duration từ timestamps hợp lệ; ended_at thiếu thì giữ duration null. Không coi wall-clock duration là active_reading_ms                      |
| Session detail      | `ReadingSessionDetailDTO`: summary + selected/reference revision IDs, events, fluency_assessment nullable, comprehension, report_id nullable    | Không bịa revision history, assessment, answer hoặc report ID. Nguồn JSON ClientMeta/Metrics cần validate                                             |
| Reports             | `ProgressReportDTO`: period summary, difficult_words, previous_period nullable, trend_deltas nullable                                           | `Summary` JSON chưa có schema trong backend; thiếu trường không được mặc định 0 rồi gọi là dữ liệu thật. Cần đối chiếu mẫu test đã được nhóm cho phép |
| Difficult words     | `DifficultWordDTO`: text, difficulty_score, counts, session_count, last_seen_at, evidence_word_ids                                              | Chốt thuật toán difficulty/evidence và status đủ điều kiện; không đếm CANDIDATE/UNCERTAIN như lỗi CONFIRMED hoặc giả difficulty_score                 |
| Admin book list     | `AdminBookListItemUI`: book + page_count/processing_count/needs_review_count/verified_count/parent_catalog_eligible                             | Đếm từ dữ liệu query thật, thống nhất revision nào được tính, không random/hardcode                                                                   |
| Admin page/revision | AdminPageProcessingDTO/ListItemUI/RevisionDetailDTO/SummaryUI/ImageUI trong `types/admin.ts`                                                    | RevisionNo ORM là string, UI là number: chỉ parse giá trị hợp lệ. Page chưa có revision không được tạo UUID/trạng thái PROCESSING giả                 |
| Admin audit         | `AuditLogPageDTO`: items + next_cursor; actor_id/resource_id/request_id theo nullable DTO                                                       | ORM cho actor/resource null nhưng legacy response không nullable; schema API mới phải theo DTO, metadata chỉ public safe fields                       |
| Health              | `HealthSnapshotUI`: overall_status, checked_at, services; status chỉ HEALTHY/DEGRADED/UNAVAILABLE                                               | Không thêm status UNKNOWN vào DTO cũ. Chưa probe thì UI unavailable hoặc thông báo an toàn; không bịa snapshot/services đã kiểm tra                   |

Enums reading là điểm cần đối chiếu: schema backend dùng các ví dụ `IN_PROGRESS`, `MISPRONUNCIATION`, `DETECTED`; frontend định nghĩa enums khác. Ví dụ trong schema không chứng minh dữ liệu live đang có giá trị đó. Không tự remap các giá trị chưa chốt. `SourceSpan`/`Difficulty` của comprehension và `BoundingBox` của words cũng cần validate/mapping đúng kiểu, không tự lấp giá trị thiếu.

## 4. API đọc — ưu tiên router/schema hiện có

Bỏ đề xuất namespace `/parent-data`, `/admin-data` và các router riêng trong kế hoạch cũ. Tiếp tục dùng router đang được đăng ký: `/books`, `/reading`, `/system`. Không đổi URL/response của endpoint cũ nếu chưa thống nhất với người sử dụng API.

| Domain                    | Router hiện có                      | Schema hiện có                   | Cách triển khai                                                                                                                                        |
| ------------------------- | ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sách Parent               | `backend/app/api/routes/book.py`    | `backend/app/schemas/book.py`    | Kiểm tra GET `/books/`, GET `/books/{book_id}/pages`; bổ sung đọc detail/search/filter/preview và eligibility ACTIVE + revision VERIFIED               |
| Phiên đọc Parent          | `backend/app/api/routes/reading.py` | `backend/app/schemas/reading.py` | Bổ sung owner filter, pagination, đọc detail/aggregate cần cho SessionService                                                                          |
| Báo cáo Parent            | `backend/app/api/routes/system.py`  | `backend/app/schemas/system.py`  | Bổ sung child/date-window query và response schema cho báo cáo; xác nhận cấu trúc Summary trước khi mapping                                            |
| Từ khó Parent             | `backend/app/api/routes/reading.py` | `backend/app/schemas/reading.py` | Bổ sung GET đọc/tổng hợp từ events/words thật sau khi chốt thuật toán; không tạo bảng mới                                                              |
| Sách/trang/revision Admin | `backend/app/api/routes/book.py`    | `backend/app/schemas/book.py`    | Bổ sung GET Admin có role guard cho counts, pages, revision/words, ảnh và processing thật; không dùng eligibility Parent để che sách Admin cần quản lý |
| Audit/Health Admin        | `backend/app/api/routes/system.py`  | `backend/app/schemas/system.py`  | Audit filter/pagination/safe metadata; Health dùng probe thật hoặc unavailable, không dựng snapshot giả                                                |

Đây là vị trí triển khai dự kiến, không phải API đã hoàn thành. Endpoint còn thiếu phải chốt path/query/response với nhóm trước phase domain; tránh route tĩnh bị `/{book_id}` hoặc `/{session_id}` bắt nhầm. Nếu endpoint chung đang phục vụ code khác, ưu tiên thêm endpoint đọc chuyên biệt **trong cùng router** thay vì âm thầm đổi contract. Frontend service map response backend sang DTO hiện có, không tự đổi API/DTO/enums/error codes.

Tái sử dụng `backend/app/api/deps.py:get_current_parent_id` để xác minh token. Helper này hiện chỉ lấy ID, chưa kiểm tra role: bổ sung kiểm tra Profile.Role/ownership ở phần đọc mới theo mẫu Service/Repository trong file route. Không viết lại Auth. Nếu cần helper dùng chung ở `deps.py`, thống nhất với nhóm trước và không làm thay đổi hành vi dependency hiện tại.

Parent/child identity lấy từ token, không tin parent_id/role browser tự gửi. Query có owner predicate/join; Session/Report/Event đi qua ChildProfile.ParentId. Missing/foreign resource trả safe 404. Admin role kiểm tra tại backend từ bảng profiles; không chỉ dựa layout frontend hoặc lọc dữ liệu sau khi đã tải toàn bộ.

GET trả 200 khi thành công; auth/role/not-found/validation dùng cơ chế 401/403/404/422 hiện có và ServiceError codes hiện tại. List thật rỗng mới là empty; outage/invalid response phải là error. Không trả raw SQL, token, password hoặc metadata nhạy cảm. Các endpoint legacy ngoài scope vẫn phải báo người giữ API kiểm tra trước deployment; task này không chứng nhận bảo mật toàn server.

## 5. Manifest dự kiến — theo cấu trúc đã chốt

Phase 1 chỉ cập nhật `REAL_DATA_PHASE1_PLAN.md`. Các file dưới đây chưa được sửa/tạo trong lượt lập kế hoạch.

### Frontend: sửa service trong lib/api hiện có

| Phase | File sửa dự kiến                                                                                                                                           | Nội dung                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 2     | Tái sử dụng `frontend/lib/api/service-error.ts`, `frontend/lib/supabase/client.ts`, `config.ts`; không sửa nếu đủ dùng                                     | Chốt token/base URL/error/response validation theo Profile/Child; không đổi Auth/env |
| 3     | `frontend/lib/api/book-service.ts`                                                                                                                         | Giữ interface, thêm factory gọi FastAPI và kiểm tra/map DTO list/get/listPages       |
| 4     | `frontend/lib/api/session-service.ts`, `report-service.ts`, `difficult-word-service.ts`                                                                    | Giữ interfaces, thêm factory đọc dữ liệu thật/ownership errors                       |
| 5     | `frontend/lib/api/admin-book-service.ts`, `admin-page-service.ts`, `revision-service.ts`, `ocr-review-service.ts`, `audit-service.ts`, `health-service.ts` | Giữ interfaces, thêm factory đọc API Admin; method ghi chưa có API fail an toàn      |
| 3–5   | `frontend/components/providers/app-services-provider.tsx`, `admin-services-provider.tsx`, `admin-store-provider.tsx`                                       | Nối factory thật, bỏ mock runtime theo domain; không tạo provider architecture mới   |

File mới duy nhất dự kiến cho code nền tảng frontend: `frontend/lib/api/api-client.ts`, nếu cần gom request/token/error/validation cho service mới. Đây là helper **trong lib/api**, không tạo lib/http. Không refactor Profile/Child chỉ để dùng helper. Validation domain đặt cạnh implementation trong service hiện có khi phù hợp; không tạo hệ thống contracts thứ hai.

### Backend: sửa route/schema hiện có

| Phase       | File sửa dự kiến                                                                                    | Nội dung                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 2           | Chỉ đọc/tái sử dụng `backend/app/api/deps.py`, `database/session.py`, `database/supabase_client.py` | Xác nhận cách lấy token/DB session. Chỉ thêm helper quyền trong deps.py nếu nhóm thống nhất; không sửa cấu hình kết nối |
| 3           | `backend/app/api/routes/book.py`, `backend/app/schemas/book.py`                                     | GET sách Parent, detail/preview, quyền và eligibility                                                                   |
| 4           | `backend/app/api/routes/reading.py`, `system.py`; `backend/app/schemas/reading.py`, `system.py`     | GET history/detail/report/difficult words, ownership và response mapping                                                |
| 5           | `backend/app/api/routes/book.py`, `system.py`; `backend/app/schemas/book.py`, `system.py`           | GET dữ liệu Admin, role guard, nullable fields, image/revision/audit/health                                             |
| 3–5         | `backend/app/schemas/__init__.py` nếu import qua package                                            | Export schema mới; không sửa exports khác                                                                               |
| Chỉ khi cần | `backend/app/api/router.py`                                                                         | Các router hiện có đã đăng ký, nên dự kiến không cần sửa. Chỉ sửa nếu có router mới được nhóm duyệt                     |

Không tạo `parent_data.py`, `admin_data.py`, `data_deps.py` hoặc thư mục services/repositories mới. Giữ tách trách nhiệm **bằng class/hàm trong file route theo mẫu profile.py**: Router xử lý HTTP, Schema validate/format, Service xử lý nghiệp vụ/quyền, Repository query ORM. Không di chuyển class hiện có. Không thay schema database, models, migration hoặc POST/PUT/DELETE ngoài scope.

### Test files có thể thêm, không dùng làm runtime fallback

- `frontend/test/api-client.test.ts` cho Phase 2; các test domain dự kiến `frontend/tests/services/real-book-service.test.ts`, `real-session-service.test.ts`, `real-report-service.test.ts`, `real-difficult-word-service.test.ts`, `real-admin-services.test.ts`; `frontend/tests/e2e/real-data.spec.ts`.
- `backend/test_data_access.py` cho Phase 2; các test domain dự kiến `backend/tests/test_book_data.py`, `test_reading_data.py`, `test_report_data.py`, `test_admin_data.py`.
- Tái sử dụng test file hiện có khi thích hợp. Legacy tests import mock đã xóa phải migrate theo domain, không xóa chỉ để lấy PASS. Fixtures chỉ nằm trong tests.

Giữ Dashboard, Profile/Child adapters, `backend/app/api/routes/profile.py`, DTO/interfaces, Auth/session/proxy, layout/design tokens, package versions và env thật. Chỉ đổi copy mock sau khi API tương ứng thực sự nối. Không format toàn repo hoặc đổi tên/di chuyển file.

### 5.1 Manifest app → component → hook/service của Parent

Các đường dẫn page dưới đây tính từ `frontend/app/(app)/`; screen từ `frontend/components/`. Đây là danh sách dự kiến của phase sau, không phải file đã sửa trong Phase 1.

| Phase / route                  | File app cần sửa tối thiểu         | Screen tái sử dụng, chỉ sửa phần dữ liệu nếu cần | Hook → service thật                                                               | Thay đổi và UI states                                                                                                |
| ------------------------------ | ---------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 3 — `/books`                   | `books/page.tsx`                   | `books/book-library-screen.tsx`                  | `use-book-service.ts`, `use-child-service.ts` → BookService, ChildService hiện có | Bỏ parseAppMockScenario/props scenario; giữ childId, search/filter; loading, catalog empty, no-results, error/retry  |
| 3 — `/books/[bookId]`          | `books/[bookId]/page.tsx`          | `books/book-detail-screen.tsx`                   | `use-book-service.ts`, `use-child-service.ts` → BookService.get/listPages         | Giữ bookId/childId, bỏ demo; detail/preview thật, loading/error/retry/not-found/unavailable; không tạo phiên đọc giả |
| 4 — `/sessions`                | `sessions/page.tsx`                | `reports/session-history-screen.tsx`             | `use-report-services.ts` → SessionService.list, BookService, ChildService         | Bỏ parseGroup5DemoState/props scenario; giữ childId/page/cursor; loading, empty, error/retry                         |
| 4 — `/sessions/[sessionId]`    | `sessions/[sessionId]/page.tsx`    | `reports/session-detail-screen.tsx`              | `use-report-services.ts` → SessionService.get và book/child lookup                | Giữ sessionId; bỏ demo; loading/error/retry/not-found; assessment thiếu hiển thị chưa có, không gán số 0 giả         |
| 4 — `/reports`                 | `reports/page.tsx`                 | `reports/progress-report-screen.tsx`             | `use-report-services.ts` → ReportService.get, ChildService                        | Giữ childId/date window; bỏ demo; loading, chưa có dữ liệu kỳ, error/retry; chỉ vẽ metrics hợp lệ                    |
| 4 — `/reports/difficult-words` | `reports/difficult-words/page.tsx` | `reports/difficult-words-screen.tsx`             | `use-report-services.ts` → DifficultWordService.list, ChildService                | Giữ childId/date window; bỏ demo; loading/empty/error/retry; practice chưa có API không báo success                  |

Điểm nối chung Phase 3/4 là `frontend/components/providers/app-services-provider.tsx`: thay đúng book/session/report/difficultWord factory bằng HTTP implementation; giữ nguyên Profile/Child và các service ngoài phạm vi. Props demo đang được provider bỏ qua nên bỏ ở từng page trước; không xóa props/types dùng chung khi route ngoài phạm vi còn dùng.

Các screen hiện đã gọi service qua hooks. Không cam kết sửa tất cả screen: chỉ sửa khi DTO thật cần trạng thái chưa có dữ liệu, cleanup request, lỗi hoặc copy tương ứng. Giữ `book-card.tsx`, `book-cover.tsx`, `book-page-thumbnail.tsx`, `child-selector.tsx`, `metric-card.tsx`, `progress-chart.tsx`, `session-history-item.tsx`, `session-event-list.tsx`, `difficult-word-item.tsx` nếu props hiện tại đáp ứng DTO. Không fetch database trong các component trình bày này.

### 5.2 Manifest app → component → hook/service của Admin

Các đường dẫn page dưới đây tính từ `frontend/app/admin/(protected)/`; screen từ `frontend/components/admin/`. Tất cả dùng `frontend/hooks/use-admin-services.ts` và `AdminServicesProvider` hiện có.

| Route / Phase 5                        | File app cần sửa tối thiểu               | Screen tái sử dụng             | Service/API đọc cần nối                                                               | Thay đổi và UI states                                                                                           |
| -------------------------------------- | ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/admin/books`                         | `books/page.tsx`                         | `admin-books-screen.tsx`       | AdminBookService.list                                                                 | Bỏ parseAdminScenario; search/filter/counts thật; loading/empty/error/retry                                     |
| `/admin/books/[bookId]`                | `books/[bookId]/page.tsx`                | `admin-book-detail-screen.tsx` | AdminBookService.get, AdminPageService.list                                           | Giữ bookId, bỏ demo; detail/pages/counts thật, loading/error/not-found                                          |
| `/admin/books/[bookId]/pages/[pageId]` | `books/[bookId]/pages/[pageId]/page.tsx` | `admin-ocr-review-screen.tsx`  | AdminPageService image/processing, RevisionService.list, OcrReviewService.getRevision | Giữ bookId/pageId; ảnh/revision/words thật, loading/error/not-found/unavailable; sửa mô tả ảnh mock sau khi nối |
| `/admin/audit-logs`                    | `audit-logs/page.tsx`                    | `admin-audit-screen.tsx`       | AuditService.list                                                                     | Bỏ demo/copy mock; filter/cursor và safe metadata; loading/empty/error/retry                                    |
| `/admin/health`                        | `health/page.tsx`                        | `admin-health-screen.tsx`      | HealthService.get                                                                     | Bỏ demo/copy mock; snapshot từ probe thật, loading/error/retry; không tự gán HEALTHY                            |

Wiring chung sửa đúng `frontend/components/providers/admin-services-provider.tsx`: thay các mock factory, bỏ dependency mock store, dùng lại `createSupabaseAdminAuthService`. Các provider lồng trong page hiện mặc định `authMode="mock"` dù layout ngoài chọn Supabase; phải thống nhất dùng implementation Supabase hiện có, không viết lại login/role guard. `frontend/components/providers/admin-store-provider.tsx` bỏ mock storage, giữ wrapper tương thích layout nếu cần.

Hai điểm tương thích cần kiểm tra và chỉ sửa wiring khi cần: `frontend/app/admin/(protected)/books/new/page.tsx` và `frontend/app/admin/login/page.tsx`. Không triển khai chức năng tạo sách hoặc viết lại Auth trong task hiển thị dữ liệu. Nếu provider bỏ mode/scenario mock, hai page này không được tiếp tục chọn mock factory. `admin-new-book-screen.tsx`/`admin-page-uploader.tsx` chỉ sửa thông báo/trạng thái tối thiểu nếu thao tác chưa có API vẫn báo success giả; không triển khai upload/OCR hoặc API ghi mới.

Giữ nguyên `frontend/app/(app)/layout.tsx`, `frontend/app/admin/layout.tsx`, `frontend/app/admin/(protected)/layout.tsx`, AppShell/AdminLayout, design tokens và component UI chung. `frontend/components/providers/app-store-provider.tsx` đã không còn mock store: không tạo store dữ liệu thứ hai. Giữ các hooks/interfaces nếu contract không đổi; không đưa trực tiếp HTTP calls vào page/screen để bỏ qua service.

### 5.3 Trình tự sửa ít xung đột cho mỗi domain

1. Chốt API/DTO, dữ liệu và quyền; sửa đúng schema và bổ sung GET trong file route hiện có. Service/Repository theo mẫu profile.py, không tạo folder kiến trúc mới.
2. Giữ interface frontend; bổ sung factory gọi FastAPI ngay trong file `frontend/lib/api/*-service.ts` tương ứng. Test response/error/ownership trước khi nối UI.
3. Sửa đúng factory trong provider chung; bỏ demo ở page tương ứng, giữ ID/filter/pagination thật.
4. Chạy lại screen có sẵn; chỉ sửa loading/empty/error/not-found/copy cần thiết, không đổi bố cục.
5. Test domain, kiểm tra diff và thông báo file chung đã chạm cho nhóm. Không viết lại Auth/Profile/Children hoặc sửa nghiệp vụ ghi ngoài phạm vi.

Có sửa file đã tồn tại để theo mẫu của nhóm; không thể bảo đảm zero conflict. Thống nhất người giữ provider, service, route/schema trước từng domain; cập nhật main bằng workflow Git được nhóm duyệt, không push trực tiếp main. Phát sinh ngoài manifest phải báo scope trước khi làm.

## 6. Phạm vi chỉ đọc và chức năng chưa có API

Không triển khai create/updateStatus/upload/saveDraft/verify/reprocess mới, AI/OCR/STT/TTS/WebSocket hoặc DifficultWord.practice. Các method vẫn cần tồn tại để giữ interface: khi chưa có API được duyệt, trả safe unavailable, UI không báo thành công. AdminPage.reload là read processing nên có thể nối GET. Bắt đầu đọc hiện gọi ReadingService.create và đòi session_token; không tạo token/phiên mẫu để hoàn thành nút này. Nếu nhóm muốn nối các thao tác ghi, lập task/contract riêng.

Schema/UI hiện tại có vài trường bắt buộc nhưng ORM có thể thiếu (page chưa có revision, report summary không đầy đủ). Đây là điểm cần duyệt mapping hoặc thay đổi UI tối thiểu; không cam kết hiển thị đầy đủ mọi row bằng việc bịa dữ liệu hoặc âm thầm đổi DTO.

## 7. Các điểm cần xác nhận trước domain tương ứng

1. Nhóm thống nhất endpoint đọc còn thiếu trong router hiện có, query/response và các consumer đang dùng API; không tạo duplicate endpoints hoặc đổi contract cũ chưa duyệt.
2. Mẫu hiện có `frontend/lib/utils/admin-mappers.ts:summarizeAdminBook` xác định sách Parent eligible khi ACTIVE và có ít nhất một trang ACTIVE trỏ đúng revision VERIFIED. Tái sử dụng policy này, không tự đổi sang mọi trang phải VERIFIED. Còn cần xác nhận Storage bucket/preview access và data ownership.
3. Enum thực tế, ClientMeta/Metrics/Summary/source span/difficulty JSON và thuật toán difficult words.
4. Cách hiển thị page chưa có revision và dữ liệu bắt buộc nhưng chưa được tính. Không generate defaults giả.
5. Admin revision/words có dữ liệu thật để đọc; Health kiểm tra những dịch vụ nào, timeout và metadata public allowlist.
6. Người giữ provider, lib/api service và route/schema tương ứng xác nhận scope trước khi sửa. Diff nhỏ giảm conflict, không bảo đảm tuyệt đối không conflict.

Những phần chưa xác nhận không chặn việc chuẩn bị helper request trong lib/api ở Phase 2, nhưng chặn claim API/domain đó đã nối đủ dữ liệu hoặc nghiệm thu live. Khi user yêu cầu phase tiếp theo, chốt contract còn mở trong phạm vi phase đó trước khi code.

## 8. Kiểm tra thực tế Phase 1 và cảnh báo

- Git ban đầu clean trên main `8982d81`; tạo `feature/linh-real-data` từ đúng commit. `linh` cũ và stash backup Phase 1–7 Auth được giữ.
- Đọc DTO/service interfaces/models/routers/providers và trace mẫu Profile mới; không chạy request tới Supabase/PostgreSQL thật. Tài liệu không chứng minh migration/RLS/role/index/data live đã đạt.
- Chạy `frontend/node_modules/.bin/tsc.cmd --noEmit --incremental false`: exit 2, 117 diagnostics. Trong đó 49 missing mock imports, 7 missing Supabase module diagnostics, 9 so sánh mode supabase/mock, 4 stale `.next` route diagnostics; các nhóm không bao phủ toàn bộ lỗi còn lại.
- Local node_modules chưa có `@supabase/supabase-js` và `@supabase/ssr`, dù package.json yêu cầu chúng; folder lib/mock không còn. Cần npm ci theo lockfile trước baseline triển khai, xử lý cache riêng có scope khi được phép, không coi mọi lỗi hiện tại là regression mới của Phase 1.
- Chưa chạy lint/unit/Playwright/build/backend tests trong Phase 1 vì chỉ tạo tài liệu, chưa có code mới và dependency/cache còn không đồng bộ. Không đánh dấu các command đó PASS.
- `frontend/.env.example` trên main hiện dùng tên DATABASE_URL/SUPABASE_URL/SUPABASE_KEY thay vì NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/NEXT_PUBLIC_API_URL mà source đọc; có database credential đã commit. Không ghi lại giá trị trong báo cáo; báo nhóm rotate, chưa sửa env/key/SQL hoặc lịch sử Git.
- Metadata thay đổi main gồm 15 file: 3 backend, 7 frontend và 5 file venv. Không sửa venv tracked hoặc các executable theo máy người khác; đây không phải dữ liệu nghiệp vụ cần nối.
- Kế hoạch được chỉnh theo hai yêu cầu đã chốt: frontend triển khai ngay trong lib/api hiện có, backend sửa routes/schemas hiện có; giữ mapping app/components Parent/Admin ở mục 1.1, 5.1–5.3. Chỉ cập nhật Markdown; kiểm tra format tài liệu và Git riêng, không coi đó là lint/test/build ứng dụng PASS.

## 9. Các phase cập nhật và điều kiện hoàn thành

| Phase                             | Công việc frontend                                                                                       | Công việc backend                                                                | Điều kiện hoàn thành                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1 — Kế hoạch                      | Mapping app/components/lib/api và manifest từng tab                                                      | Đối chiếu routes/schemas/models hiện có                                          | Tài liệu cập nhật, không sửa application code                                                              |
| 2 — Chuẩn bị kết nối              | Helper request trong lib/api nếu cần; token/error/response validation theo Profile/Child, giữ interfaces | Tái sử dụng deps/DB session; chốt quyền và vị trí class/hàm trong route theo mẫu | Test helper; ghi rõ baseline/dependency lỗi, không nối UI khi API chưa chốt                                |
| 3 — Sách Parent                   | Sửa book-service, provider, 2 page Books; screen sửa tối thiểu                                           | Sửa book.py ở routes/schemas                                                     | List/search/filter/detail/preview thật; ACTIVE + VERIFIED đúng policy; loading/empty/error/retry/not-found |
| 4 — Lịch sử/báo cáo/từ khó Parent | Sửa 3 service, provider, 4 page Sessions/Reports; giữ UI                                                 | Sửa reading.py và system.py ở routes/schemas                                     | Owner filter, metrics/JSON mapping được duyệt; không dựng dữ liệu thiếu                                    |
| 5 — Dữ liệu Admin                 | Sửa 6 service, Admin provider/store/pages/screens trong manifest                                         | Sửa book.py và system.py ở routes/schemas                                        | Books/pages/revisions/audit/health đọc thật; backend role guard; không runtime mock                        |
| 6 — Kiểm tra/bàn giao             | Lint/typecheck/unit/Playwright/build, desktop/mobile, kiểm tra diff                                      | Backend tests, token/role/ownership/response cases                               | Báo command thực tế, giới hạn còn lại; live acceptance theo quyền nhóm                                     |

Mỗi phase 3–5 nối trọn một domain: backend route/schema → frontend lib/api → provider → app/components, không chờ đến cuối mới nối frontend. Không tạo thư mục http, không dựng hệ thống service/repository folder mới.

Test service bằng isolated fixtures/HTTP test doubles không phải fallback ứng dụng. E2E phân biệt offline HTTP integration với dữ liệu Supabase thật. API list rỗng phải được phân biệt với lỗi; không lẫn hai Parent; Parent không đọc Admin; role không lấy từ browser. Health/success chỉ hiển thị khi có kết quả thật.

Các method ghi và chức năng AI/realtime ngoài scope giữ unavailable an toàn, không xóa contract để giả vờ hết lỗi. Sau mỗi phase báo file thay đổi và kết quả kiểm tra, dừng để người dùng duyệt phase tiếp theo.

Dừng sau Phase 1. Chưa triển khai Phase 2, không commit/push hoặc sửa application code.

## 10. Tiến độ triển khai sau yêu cầu hoàn thành các phase

Yêu cầu mới cho phép triển khai lần lượt các phase còn lại; dòng dừng Phase 1 phía trên là trạng thái bàn giao kế hoạch trước khi có yêu cầu này, không phải giới hạn dừng của lượt triển khai hiện tại. Không mở rộng sang Auth/AI/database schema.

### Phase 2 — phần nền tảng đã triển khai

- Thêm `frontend/lib/api/api-client.ts`: request GET tới FastAPI, lấy Bearer token bằng Supabase client hiện có, no-store, không forward cookies, không theo redirect, Zod validation trước khi trả DTO, HTTP/network errors theo ServiceError hiện tại. Không phản chiếu SQL/token/error body vào UI.
- `apiQuery` encode filter/pagination thật; không dùng scenario hoặc mock fallback. Chưa thay service/provider domain khi endpoint chưa chốt.
- Thêm `frontend/test/api-client.test.ts`: 14 tests đạt. Test HTTP doubles chỉ ở test, không đưa vào runtime.
- Thêm `backend/test_data_access.py`: 4 tests identity đạt bằng backend .venv hiện có; patch Supabase trong tests, chỉ dùng dummy env trong process. Chưa thêm role helper hoặc sửa dependency; role/ownership phải kiểm tra ở route domain khi triển khai.
- Đặt hai test mới ngoài thư mục `tests` vì root `.gitignore` đang bỏ qua `tests/` ở mọi cấp. Không sửa `.gitignore`, không force-add/stage. Các test domain phase sau cũng cần vị trí được Git nhận hoặc nhóm duyệt exception trước bàn giao.
- `npm ci --ignore-scripts --no-audit --no-fund`: đạt, cài đúng lockfile; không đổi package.json/lockfile. Backend .venv hiện có đã đủ dependencies cần kiểm tra identity.
- Prettier check và ESLint cho hai file frontend mới: đạt. Baseline toàn dự án được ghi riêng, không coi test helper là nghiệm thu các tab.

### Baseline sau khôi phục dependencies

- Typecheck toàn dự án: lỗi còn ở Auth so sánh mode supabase/mock, imports mock cũ và generated route types. Không có sửa Auth ngoài scope.
- `npm test`: 16 test files đạt, 24 files lỗi; 108 tests đạt, 24 tests lỗi, tổng 132 tests được thu thập. Nhiều suite không collect được vì mock imports đã bị xóa. Kết quả này bao gồm helper mới ở vị trí trước khi chuyển sang frontend/test.
- `npm run build`: lỗi 8 unresolved mock imports từ Admin provider/store có sẵn trên main. Không sửa thành stub để lấy build PASS; phải nối service thật ở Phase 5.
- Chưa chạy Playwright/visual acceptance vì production build chưa đạt và domain services chưa nối. Không báo các phase 3–6 hoàn thành.

### Điểm chờ trước khi nối đủ domain

- Đường dẫn ảnh hiện là URL hay Storage path; bucket và policy public/private chưa biết. Không tạo preview URL hoặc tự public bucket.
- Chưa có JSON mẫu/contract cho ProgressReport.Summary, FluencyAssessment.Metrics, page/revision ProcessingMeta và difficulty score. Không tự lấp dữ liệu thiếu bằng số 0, remap enums hoặc đưa raw metadata nhạy cảm ra UI.
- Có dữ liệu page chưa có revision nhưng DTO processing yêu cầu revision ID: cần thống nhất biểu diễn unavailable trước khi claim hiển thị đầy đủ Admin pages.
- Endpoint đọc còn thiếu phải chốt trong router hiện có và giữ consumer legacy; không tự thay response/URL hiện tại.

Mục tiêu vẫn là hoàn thành các phase 3–6; chưa commit/push, chưa chỉnh env/database/schema, chưa thay Auth hoặc dựng API ngoài manifest.

## 11. Đối chiếu metadata database thật — gate trước Phase 3–5

Kiểm tra read-only ngày 2026-10-08 bằng backend .venv/cấu hình hiện có: transaction READ ONLY, timeout và rollback; chỉ lấy counts, enum, tên bucket và khóa JSON. Không đọc nội dung hồ sơ/tài khoản, không in credentials, không INSERT/UPDATE/DELETE hoặc sửa Storage policy. Kết nối đạt; đây là bằng chứng metadata, chưa phải nghiệm thu API/UI với phiên Parent/Admin thật.

| Nguồn thật                                                 | Kết quả xác minh                                                                                                                      | Khác với contract frontend / quyết định cần duyệt                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.buckets`                                          | Không có bucket                                                                                                                       | Chưa thể ký URL hoặc ghép public Storage URL. Cần nhóm cung cấp nơi chứa ảnh thật; không tạo/public bucket trong task này                                                                                         |
| `bookpages.imagepath`                                      | 5 bản ghi, 0 URL tuyệt đối, 5 đường dẫn tương đối                                                                                     | `preview_url` chưa có nguồn URL hợp lệ. Không coi đường dẫn tương đối là URL, không trỏ ảnh fixture hoặc đoán tên bucket                                                                                          |
| `readingsessions.state`                                    | ABORTED, COMPLETED, IN_PROGRESS, PAUSED                                                                                               | Frontend dùng FINISHED/LISTENING và các trạng thái khác. Không tự coi IN_PROGRESS là LISTENING, không đổi COMPLETED thành FINISHED khi mapping chưa được nhóm duyệt                                               |
| `readingevents.type/status`                                | LONG_PAUSE/DETECTED, MISPRONUNCIATION/FEEDBACK_GIVEN, MISPRONUNCIATION/IGNORED_BY_GATE, OMISSION/DETECTED, REPETITION/IGNORED_BY_GATE | Frontend dùng SUBSTITUTION và CANDIDATE/CONFIRMED/UNCERTAIN/DISMISSED. DETECTED hoặc FEEDBACK_GIVEN không tự chứng minh là CONFIRMED; cần chốt semantics để không đếm lỗi sai                                     |
| `pagerevisions.revisionno`                                 | 5 bản ghi, không có chuỗi thuần số                                                                                                    | Frontend yêu cầu number; cần chốt định dạng/mapping, không dùng parseInt rồi tự gán số 1 khi thất bại                                                                                                             |
| `progressreports.summary`                                  | Chỉ thấy khóa avg_fluency, total_books                                                                                                | Không có đủ ProgressReportDTO: completed_sessions, reading_duration_ms, counts/rates, difficult_words, previous_period/trends. Không chuyển total_books thành completed_sessions hoặc dựng trường bắt buộc bằng 0 |
| `fluencyassessments.metrics`                               | Chỉ thấy khóa Accuracy, WCPM                                                                                                          | Không có đủ FluencyComponentMetricsDTO; WCPM không mặc nhiên là reading_wpm. Không tạo active_reading_ms/reference_words_attempted/confirmed_error_words giả                                                      |
| `bookpages.processingmeta`, `pagerevisions.processingmeta` | Không thấy khóa JSON                                                                                                                  | Không có bằng chứng metadata processing/difficulty score. Không dựng trạng thái/phần trăm tiến trình hoặc nguồn evidence giả                                                                                      |

### Quyết định cần nhóm xác nhận

1. Giữ DTO frontend và chuẩn hóa backend theo mapping được duyệt, hoặc duyệt cập nhật DTO/UI để phản ánh contract dữ liệu thật. Kế hoạch hiện yêu cầu giữ DTO, nên không tự chuyển hướng thứ hai.
2. Nếu giữ DTO, chỉ rõ nguồn/cách tính các trường report/fluency/difficult words còn thiếu, semantics enums và revision number. Thống nhất trạng thái chưa có dữ liệu khi trường bắt buộc không có nguồn; không xem safe unavailable là hoàn thành hiển thị thật.
3. Nơi chứa ảnh thật và quyền truy cập preview. Storage hiện chưa có bucket; tạo bucket/upload hoặc sửa database là task riêng, không thuộc phạm vi đọc dữ liệu này.
4. Endpoint đọc còn thiếu trong router hiện có: path/query/response tương thích consumer cũ, không đổi contract của nhóm chưa duyệt.

Đây là gate contract có bằng chứng thật, không phải lỗi npm/network hay thiếu thời gian. Phase 2 helper/tests vẫn giữ nguyên; Phase 3–6 chưa hoàn thành. Không thay enum/DTO/schema database/Auth hoặc dựng dữ liệu thay thế để vượt gate.
