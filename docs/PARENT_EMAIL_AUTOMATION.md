# Tự động hóa Email cho Phụ huynh (ViRead — Vercel + Render + Supabase)

## 1. Tại sao trước đây hệ thống CHƯA tự động gửi email trên Vercel/Render?

Qua kiểm tra trực tiếp mã nguồn:
1. **Frontend trên Vercel (`frontend/vercel.json`)** trước đây không có `crons` hay API route `/api/cron/...` nào.
2. **Backend trên Render (`backend/app/sever.py`)** không khởi chạy 2 worker email cũ (`reading_reminder_worker.py` và `reading_presence_alert_worker.py`) trong FastAPI lifespan — cả 2 chỉ là script CLI chạy tay (`python -m ...`), trong khi Render chỉ chạy 1 Web Service (`uvicorn app.sever:app`).
3. **Chỉ có 2 kịch bản nhỏ (đều mặc định tắt / ẩn)** và chưa có màn hình quản lý thông báo email tập trung ở `/settings`.
4. **Cấu hình mặc định chưa public**: `READING_REMINDER_APP_URL` mặc định trỏ `http://localhost:3000/...` nếu chưa đặt biến môi trường production.

---

## 2. Năm kịch bản Email phụ huynh (Hữu ích, Chống spam chặt chẽ)

| # | Kịch bản | Khi nào gửi | Cơ chế chống spam |
|---|---|---|---|
| 1 | **Cảnh báo rời khung hình trong buổi đọc** (`reading_presence_alert_worker`) | Bé rời camera > 60 giây khi đang đọc (opt-in trong Cài đặt đọc) | Grace 60s + heartbeat 30s + cooldown 30 phút/phiên + tối đa 3 email/ngày |
| 2 | **Nhắc giờ đọc theo lịch** (`reading_reminder_worker`) | Đúng ngày/giờ phụ huynh đặt tại `/reading-management` | **Tự hủy nếu bé đã đọc hôm nay rồi**; dedupe theo `(reminder, ngày)` |
| 3 | **Báo cáo tiến độ học hàng tuần** (`WEEKLY_DIGEST`) | 1 lần/tuần (mặc định sáng Chủ Nhật 09:00 giờ VN), gộp tất cả bé trong 1 email | Dedupe theo `parent + ISO week`; tối đa 1 email/tuần |
| 4 | **Nhắc nhẹ khi bé nghỉ đọc quá lâu** (`INACTIVITY_ALERT`) | Bé không có buổi đọc nào >= 5 ngày (chỉnh được 3/5/7/14 ngày), gộp tất cả bé vào 1 email | Cooldown 7 ngày; bỏ qua nếu vừa gửi Báo cáo tuần trong 24h; **tự dừng hẳn sau 2 lần nhắc liên tiếp không có buổi đọc mới** |
| 5 | **Chúc mừng cột mốc đọc sách** (`MILESTONE`) | Buổi đọc đầu tiên (trong 24h), chuỗi 7 / 14 / 30 ngày liên tiếp, hoặc đạt 100% mục tiêu đọc | Dedupe vĩnh viễn theo từng cột mốc; tối đa 1 email cột mốc/ngày |

**Rào chắn chống spam toàn cục:**
- **Khung giờ yên tĩnh (Quiet Hours)**: Mặc định **21:00 – 07:00** giờ địa phương (`Asia/Ho_Chi_Minh`) không gửi email nhắc/báo cáo/cột mốc.
- **Trần tuần cứng (`max_emails_per_week`)**: Mặc định **tối đa 4 email tự động/tuần/phụ huynh** (tùy chỉnh 1–14 tại `/settings#email-notifications`).
- **Chỉ gửi đến email đã xác minh** (`email_verified === true` trên Supabase Auth) và tài khoản đang hoạt động (`profiles.active = 1`).
- **Header `List-Unsubscribe`** và nút tùy chỉnh nhanh ở cuối mỗi email.

---

## 3. Cơ chế tự động gửi trên Vercel + Render + GitHub Actions + Cloudflare

Hệ thống hỗ trợ nhiều lớp kích hoạt đồng bộ và **an toàn khi chạy song song (không bao giờ gửi trùng)** vì mọi trạng thái gửi đều dùng khóa nguyên tử trên PostgreSQL:
- `parentemaildeliveries`: ràng buộc `UNIQUE(dedupekey)` + `ON CONFLICT DO NOTHING` (cho Báo cáo tuần, Nhắc nghỉ đọc lâu, Chúc mừng cột mốc).
- `readingreminderoccurrences`: ràng buộc `UNIQUE(reminderid, scheduledlocaldate)` + `FOR UPDATE SKIP LOCKED`.
- `readingpresencealerts`: ràng buộc `UNIQUE(sessionid, episodeid)` + `FOR UPDATE SKIP LOCKED`.
- `/internal/cron/dispatch` (trên `origin/main`): dùng PostgreSQL advisory locks để chống chạy chồng lấp.

Các lớp tự động hoạt động cùng nhau như sau:

1. **Lớp 1 — Worker nền trong FastAPI trên Render (`parent_email_dispatcher_worker`)**:
   - Chạy tự động trong `backend/app/sever.py` lifespan khi `PARENT_EMAIL_WORKER_ENABLED=true` (chỉ hoạt động khi bật worker nền trong tiến trình web).
   - Xử lý real-time: cảnh báo rời khung hình mỗi **10s**, nhắc lịch đọc mỗi **30s**, và báo cáo/nghỉ đọc/cột mốc mỗi **15 phút**.
   - Nếu chưa cấu hình Resend/SMTP (hoặc chưa chạy migration bảng mới), worker tự ở trạng thái ngủ an toàn (không làm sập server, hiển thị rõ trong `/system/admin/health`).
   - **Lưu ý về `render.yaml` trên `origin/main`**: Blueprint `render.yaml` đặt `VIREAD_ENABLE_LIGHTWEIGHT_WORKERS=false` để tối ưu RAM 512 MiB của Render Free, cho phép Render tự ngủ sau 15 phút nhàn rỗi (nằm trong hạn mức 750 giờ/tháng) và ưu tiên kích hoạt theo lịch từ bên ngoài. Khi chạy trên cấu hình tắt worker nền, các lớp Cron bên dưới (Cloudflare Cron / Vercel Cron) vẫn đảm bảo email được gửi tự động đầy đủ.
2. **Lớp 2 — Vercel Cron Jobs (`frontend/vercel.json` + `/api/cron/parent-emails`)**:
   - Production frontend tại `https://viread-frontend.vercel.app` (giữ nguyên `"regions": ["sin1"]` trong `frontend/vercel.json` để đồng vị trí APAC với Render/Supabase).
   - Chạy mỗi ngày lúc **02:00 UTC (09:00 sáng giờ Việt Nam)** — tương thích **100% gói Vercel Hobby (Free)** lẫn Pro.
   - Bảo vệ bằng `Authorization: Bearer $CRON_SECRET` và chuyển tiếp an toàn tới `POST /parent-notifications/cron/dispatch` trên Render bằng `X-Cron-Secret`.
3. **Lớp 3 — GitHub Actions Manual Dispatch (`.github/workflows/render-keepalive.yml`)**:
   - Chỉ kích hoạt thủ công qua `workflow_dispatch` (đã gỡ lịch `*/10 * * * *` để tránh giữ ấm Render 24/7 làm vượt hạn mức 750 giờ/tháng và không còn gọi trùng `/parent-notifications/cron/dispatch`).
   - Ping `GET /health` và (nếu có GitHub Secret `VIREAD_CRON_DISPATCH_TOKEN`) kích hoạt `POST /internal/cron/dispatch` để kiểm tra thủ công khi cần.
4. **Lớp 4 — Cloudflare Workers Cron trên `origin/main` (`infra/cloudflare-cron`)**:
   - Worker miễn phí gọi `POST /internal/cron/dispatch` mỗi **30 phút** (`*/30 * * * *`) với header `X-ViRead-Cron-Token` — đã tích hợp luôn `process_engagement_emails_once` cùng với nhắc lịch đọc & cảnh báo rời khung hình.
   - Có thể chạy song song với Vercel Cron (`/api/cron/parent-emails`) và Render worker mà không lo gửi trùng vì cả hai đường gọi đều đi qua cùng cơ chế claim & dedupe nguyên tử trong PostgreSQL.

---

## 4. Checklist biến môi trường để Public chạy thật

### A. Chạy migration database trên Supabase
Áp dụng file migration mới:
- `supabase/migrations/20261126120000_parent_email_notifications.sql`

> Lưu ý an toàn khi deploy trước migration: nếu backend deploy trước khi migration được chạy, `GET /parent-notifications/preferences` và `GET /parent-notifications/history` vẫn trả về cấu hình mặc định / danh sách rỗng (HTTP 200, không lỗi 500 trên `/settings`), còn `PUT /parent-notifications/preferences` và `POST /parent-notifications/test-email` trả về HTTP 503 có cấu trúc (`EMAIL_STORAGE_NOT_MIGRATED`).

### B. Trên Render (Backend Web Service `capstone1`)
Chọn **1 trong 2** nhà cung cấp gửi email (khuyên dùng **Resend** vì chạy qua HTTPS port 443, miễn phí 3.000 email/tháng, không bị chặn SMTP):

**Cách 1 (Khuyên dùng — Resend HTTPS API):**
- `EMAIL_PROVIDER=resend` (hoặc `auto`)
- `RESEND_API_KEY=re_...`
- `EMAIL_FROM_ADDRESS=noreply@your-verified-domain.com` (địa chỉ thuộc domain đã xác minh trên Resend; `EMAIL_FROM_NAME=ViRead` được tự động gắn kèm trên tất cả email phụ huynh)

**Cách 2 (Gmail SMTP App Password):**
- `EMAIL_PROVIDER=smtp`
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_USERNAME=vireadforyou@gmail.com`
- `SMTP_APP_PASSWORD=<16-ký-tự-app-password-của-Google>`
- `SMTP_FROM_EMAIL=vireadforyou@gmail.com`

**Biến bắt buộc chung trên Render:**
- `SUPABASE_SECRET_KEY=<server-only-supabase-secret-key>` (để tra cứu email đã xác minh của phụ huynh)
- `PARENT_EMAIL_APP_URL=https://viread-frontend.vercel.app` (tự động suy ra luôn `READING_REMINDER_APP_URL=https://viread-frontend.vercel.app/reading-management` nếu chưa đặt riêng)
- `PARENT_EMAIL_WORKER_ENABLED=true` (hoặc `false` nếu chỉ muốn kích hoạt hoàn toàn qua Vercel Cron / GitHub Actions / Cloudflare Cron)
- `PARENT_EMAIL_CRON_SECRET=<chuỗi-ngẫu-nhiên-tối-thiểu-32-ký-tự>`

### C. Trên Vercel (Frontend Project `https://viread-frontend.vercel.app`)
- `CRON_SECRET=<chuỗi-ngẫu-nhiên-tối-thiểu-32-ký-tự>` (Vercel tự động gửi trong header `Authorization: Bearer ...` khi chạy Cron!)
- `PARENT_EMAIL_CRON_SECRET=<giống-hệt-PARENT_EMAIL_CRON_SECRET-trên-Render>`
- `NEXT_PUBLIC_API_URL=https://capstone1-ssd8.onrender.com` (đã có sẵn)

### D. (Tuỳ chọn) Trên GitHub Repository Secrets
- `VIREAD_CRON_DISPATCH_TOKEN=<giống-hệt-trên-Render>` — chỉ cần nếu muốn chạy thủ công `workflow_dispatch` trong `render-keepalive.yml` để kích hoạt `/internal/cron/dispatch` (lịch định kỳ chính chạy qua Cloudflare Cron `infra/cloudflare-cron`).

### E. Kiểm tra sau khi deploy
1. Đăng nhập tài khoản Admin → kiểm tra Health Dashboard có mục **"Gửi email phụ huynh"** = `HEALTHY` và **"Parent email dispatcher worker"** = `HEALTHY`.
2. Đăng nhập tài khoản Phụ huynh (email đã xác minh) → mở `/settings#email-notifications` → bấm **"Gửi email thử nghiệm"** để xác nhận nhận mail thực tế!
