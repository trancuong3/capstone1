# ViRead — Email nhắc đọc cho phụ huynh

## Kiến trúc

Frontend chỉ lưu lựa chọn email_enabled trong lịch. Backend tạo ReadingReminderOccurrence dùng chung với lời nhắc trong ứng dụng, sau đó tạo một dòng outbox trong readingreminderemaildeliveries với occurrencekey duy nhất. Worker độc lập claim delivery trong PostgreSQL, kiểm tra lại lịch và người sở hữu, truy vấn email tài khoản qua Supabase Auth Admin, và chỉ gửi khi email đã xác minh.

Trạng thái SENT có nghĩa Resend đã chấp nhận request; đây không phải xác nhận email đã tới inbox. Không có webhook delivery được bật trong phiên bản này.

## 1. Áp dụng migration

Sau khi pull branch, áp dụng migration theo thứ tự thông thường của dự án:

supabase/migrations/20261020140000_reading_reminder_email_delivery.sql

Migration chỉ thêm readingreminders.emailenabled mặc định false, readingreminders.emailenabledat để ngăn gửi occurrence xảy ra trước khi phụ huynh bật email, và bảng outbox/index/RLS. Không chạy migration tự động khi API hoặc worker khởi động. Không áp dụng vào production trước khi review và backup theo quy trình của dự án.

## 2. Cấu hình backend

Thêm các biến sau vào backend local .env hoặc Environment của backend host. Không đặt các biến này trong frontend hay tên biến NEXT_PUBLIC_*.

- RESEND_API_KEY: API key Resend, chỉ backend.
- READING_REMINDER_FROM_EMAIL: sender đã được xác minh trên Resend, ví dụ ViRead <no-reply@your-verified-domain.example>.
- READING_REMINDER_APP_URL: URL frontend tin cậy, ví dụ http://localhost:3000 cho local hoặc URL HTTPS thực tế khi deploy.
- READING_REMINDER_CATCH_UP_MINUTES: cửa sổ catch-up, mặc định 120, giới hạn 0–1440 phút.
- SUPABASE_SECRET_KEY hoặc SUPABASE_SERVICE_ROLE_KEY: server-side Supabase Auth Admin key theo cấu hình hiện có của dự án. Ưu tiên secret key mới nếu dự án đã sử dụng nó.

Để gửi email cần đồng thời có Resend API key, sender hợp lệ, URL ứng dụng, Supabase Auth Admin key, email tài khoản Parent và email_confirmed_at tương ứng. Chỉ cấu hình đủ biến môi trường không thay thế việc xác minh sender/domain ở Resend.

## 3. Chạy worker thử nghiệm

Từ thư mục backend và virtual environment đã cài requirements.txt:

python -m app.jobs.send_reading_reminder_emails

Lệnh chạy một lần rồi thoát, phù hợp với cron job bên ngoài. Exit code 0 nghĩa job xử lý xong; exit code khác 0 thể hiện lỗi vận hành. Log ghi tổng số lượng, không ghi recipient, nội dung email, API key hoặc lỗi raw từ provider.

Worker dùng DATABASE_URL và Supabase Auth Admin như backend. Nếu cấu hình provider thiếu, delivery đang chờ sẽ được đánh dấu SKIPPED với mã lỗi cấu hình, không giả lập gửi thành công. Khi thiếu email/chưa xác minh, delivery bị bỏ qua và không retry vô hạn. Cấu hình hoàn chỉnh sẽ áp dụng cho occurrence tương lai.

## 4. Render Cron Job

Tạo một Cron Job riêng cùng repository/commit và cùng môi trường backend. Đặt Root Directory là backend nếu dự án được deploy theo thư mục đó; nếu Root Directory là repository root, dùng command có cd backend hoặc cấu hình tương ứng với host. Dùng cùng phiên bản Python và cài requirements.txt.

- Command khi Root Directory là backend: python -m app.jobs.send_reading_reminder_emails
- Schedule khuyến nghị: * * * * * nếu gói/hosting hiện tại của bạn chấp nhận tần suất mỗi phút.
- Thiết lập toàn bộ biến môi trường backend cần thiết, bao gồm DATABASE_URL, SUPABASE_URL, SUPABASE_KEY, Supabase Auth Admin key và các biến Resend ở trên.

Commit worker lên GitHub không tự kích hoạt Cron Job. Phải tạo/cấu hình Cron Job trong Dashboard của host. Độ trễ gửi thực tế phụ thuộc cron schedule, thời gian khởi chạy job, thời gian xử lý và giới hạn của nhà cung cấp/hosting. Nếu host không cho chạy mỗi phút, chọn interval được host hỗ trợ và tăng/điều chỉnh catch-up window có chủ đích.

## 5. Kiểm tra an toàn

1. Xác minh sender/domain trong tài khoản Resend.
2. Dùng tài khoản Parent thử nghiệm với email đã xác minh.
3. Tạo lịch có email_enabled=true và giờ đến hạn gần hiện tại, trong cửa sổ catch-up.
4. Chạy worker thủ công một lần.
5. Kiểm tra log tổng kết và bảng public.readingreminderemaildeliveries. provideracceptedat và providermessageid phản ánh provider acceptance, không phải inbox delivery.
6. Để test retry, dùng môi trường thử nghiệm/provider mock; không cố tình gửi lặp đến người dùng thật.
7. Xác minh lịch email bị tắt trước khi worker claim sẽ được đánh dấu SKIPPED. Khi bật lại, EmailEnabledAt được đặt lại và không gửi các occurrence đã đến hạn trước thời điểm bật lại.
8. Email chưa xác minh sẽ không được gửi. Phụ huynh có thể vào /profile để kiểm tra/cập nhật email theo luồng hiện có.

Không có API công khai cho phép browser tự chọn người nhận hoặc kích hoạt gửi hàng loạt. Cron job không nhận recipient từ request.
