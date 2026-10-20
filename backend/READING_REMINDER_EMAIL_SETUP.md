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

Theo trang giá Resend được kiểm tra ngày 20/10/2026, Free hiện liệt kê tối đa 3.000 email/tháng và 100 email/ngày. Hạn mức và yêu cầu sender có thể thay đổi; kiểm tra [Resend Pricing](https://resend.com/pricing) trước khi triển khai. Không bật gói Pro hoặc pay-as-you-go/overage. Không thể xác nhận từ source code liệu tài khoản của bạn đã có sender/domain được xác minh hay chưa.

## 3. Chạy worker thử nghiệm

Từ thư mục backend và virtual environment đã cài requirements.txt:

python -m app.jobs.send_reading_reminder_emails

Lệnh chạy một lần rồi thoát, phù hợp với cron job bên ngoài. Exit code 0 nghĩa job xử lý xong; exit code khác 0 thể hiện lỗi vận hành. Log ghi tổng số lượng, không ghi recipient, nội dung email, API key hoặc lỗi raw từ provider.

Worker dùng DATABASE_URL và Supabase Auth Admin như backend. Nếu Resend hoặc Supabase Auth Admin chưa được cấu hình, worker ném lỗi an toàn và thoát với exit code khác 0; các delivery hợp lệ đang chờ vẫn nằm trong outbox để xử lý sau khi cấu hình được sửa. Không đánh dấu SKIPPED chỉ vì thiếu cấu hình. Lỗi database cũng làm job thất bại thay vì báo gửi thành công. Email phụ huynh không tồn tại/chưa xác minh được xử lý theo policy hiện tại; lỗi lookup/provider tạm thời được retry với giới hạn.

## 4. GitHub Actions scheduler (không cần máy local)

Workflow được thêm tại `.github/workflows/reading-reminder-email.yml`:

- Schedule: `*/5 * * * *` (GitHub Actions kiểm tra theo lịch dự kiến mỗi 5 phút; thời điểm chạy có thể trễ).
- Runner: `ubuntu-latest`, Python 3.12, cài dependencies bằng `backend/requirements.txt`.
- Worker one-shot: `python -m app.jobs.send_reading_reminder_emails`; sau một lượt xử lý job kết thúc, không có polling liên tục hay worker chạy nền.
- Không dùng Render Cron Job, Windows Task Scheduler, browser timer hay Uvicorn local làm scheduler.
- `workflow_dispatch` không nhận email người nhận hoặc payload tùy ý; workflow chỉ xử lý delivery đến hạn được lưu trong database.
- `concurrency` ngăn các lượt chạy của workflow này chạy song song. Outbox PostgreSQL vẫn dùng claim/unique key để bảo vệ tính idempotent.

### Secrets cần đặt trên GitHub

Vào **Settings → Secrets and variables → Actions → New repository secret** và khai báo các giá trị thực tế:

| Secret | Mục đích |
| --- | --- |
| `DATABASE_URL` | Connection string async PostgreSQL của Supabase cloud; phải trỏ cùng database với backend local |
| `SUPABASE_URL` | URL project Supabase |
| `SUPABASE_KEY` | Publishable/anon key server-side được config backend hiện tại yêu cầu |
| `SUPABASE_SECRET_KEY` hoặc `SUPABASE_SERVICE_ROLE_KEY` | Một Supabase Auth Admin key server-side; ưu tiên `SUPABASE_SECRET_KEY` nếu project đã dùng key mới |
| `RESEND_API_KEY` | Resend API key thuộc gói miễn phí hiện có |
| `READING_REMINDER_FROM_EMAIL` | Sender đã xác minh/được phép gửi từ Resend |
| `READING_REMINDER_APP_URL` | URL ViRead mà phụ huynh có thể truy cập; không dùng `localhost` cho email thật |
| `READING_REMINDER_CATCH_UP_MINUTES` | Tùy chọn, mặc định 120; chỉ nhận giá trị 0–1440 |

Chỉ cần cấu hình một trong hai Supabase Admin key. Không đặt key trong frontend, biến `NEXT_PUBLIC_*`, workflow YAML hoặc commit. Secret chưa khai báo sẽ được truyền thành chuỗi rỗng; worker cần fail rõ ràng và không được đánh dấu các delivery đang chờ là thành công hoặc SKIPPED vì thiếu cấu hình.

### Branch, kiểm tra thủ công và kích hoạt schedule

Hiện workflow được commit trên branch `feature/reading-reminder-zero-cost-20261020` để review. **GitHub chỉ kích hoạt event `schedule` cho workflow tồn tại trên nhánh mặc định**; push feature branch không làm scheduler production hoạt động. Merge Pull Request sau khi review là bước bắt buộc để bật lịch định kỳ.

Theo quy tắc GitHub Actions, file workflow cũng phải tồn tại trên nhánh mặc định để event `workflow_dispatch` được kích hoạt. Vì vậy không thể cam kết chạy worker email qua nút Actions trên feature branch trước khi merge. Trước khi merge, có thể kiểm tra CI/unit test và review YAML; chỉ chạy email thật sau khi đã merge, khai báo secrets và xác nhận sender. Lần chạy thủ công chỉ dành cho người có quyền write phù hợp trong repository.

GitHub có thể trì hoãn lịch chạy khi hệ thống bận. Với repository public, workflow có event `schedule` cũng có thể tự động bị vô hiệu hóa nếu repository không có hoạt động trong 60 ngày; cần kiểm tra tab Actions và bật lại khi cần. Cửa sổ catch-up mặc định 120 phút chỉ xử lý các occurrence nằm trong khoảng đó nếu worker chưa từng tạo outbox record.

### Giới hạn chi phí quan trọng với repository hiện tại

Metadata GitHub hiện tại cho biết repository `trancuong3/capstone1` đang ở trạng thái **private**. GitHub-hosted standard runner miễn phí không giới hạn cho repository public; repository private sử dụng hạn mức phút miễn phí theo plan rồi có thể bị tính phí vượt hạn mức nếu billing cho phép. Với lịch 5 phút, 30 ngày tương đương khoảng 8.640 lần khởi chạy; trung bình 15 giây runner-time mỗi lần đã tương đương khoảng 2.160 phút/tháng, chưa tính phần setup/install.

Tài liệu GitHub hiện liệt kê GitHub Free với 2.000 phút runner/tháng cho repository private (hạn mức thực tế phụ thuộc plan chủ repository); xem [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) và kiểm tra trang Billing & licensing/Usage của tài khoản. Do đó không thể cam kết chi phí 0 USD/tháng cho schedule này khi vẫn private mà chưa kiểm tra hạn mức và billing của tài khoản. **Không chuyển repository sang public tự động** vì việc đó làm công khai source code và lịch sử git. Trước khi merge workflow vào nhánh mặc định, hãy chọn một trong hai điều kiện: (a) chủ repository chủ động xác nhận việc công khai toàn bộ repository là chấp nhận được; hoặc (b) kiểm tra GitHub Actions included minutes và đặt spending limit/overage ở mức không cho phép chi phí phát sinh. Điều kiện (b) có thể khiến Actions ngừng chạy khi hết quota, do đó không bảo đảm lời nhắc tiếp tục chạy suốt tháng. Không nâng cấp plan và không bật overage trong quá trình triển khai này.

Supabase Free cũng có thể tự tạm dừng project khi hoạt động database thấp trong khoảng 7 ngày. Khi đó worker không thể đọc lịch hoặc cập nhật delivery cho tới khi chủ project khôi phục project. Tham khảo [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing). Không tạo request giả chỉ để né cơ chế tạm dừng.

## 5. Kiểm tra an toàn

1. Xác minh sender/domain trong tài khoản Resend.
2. Dùng tài khoản Parent thử nghiệm với email đã xác minh.
3. Tạo lịch có email_enabled=true và giờ đến hạn gần hiện tại, trong cửa sổ catch-up.
4. Chạy worker thủ công một lần.
5. Kiểm tra log tổng kết và bảng public.readingreminderemaildeliveries. provideracceptedat và providermessageid phản ánh provider acceptance, không phải inbox delivery.
6. Để test retry, dùng môi trường thử nghiệm/provider mock; không cố tình gửi lặp đến người dùng thật.
7. Xác minh lịch email bị tắt trước khi worker claim sẽ được đánh dấu SKIPPED. Khi bật lại, EmailEnabledAt được đặt lại và không gửi các occurrence đã đến hạn trước thời điểm bật lại.
8. Email chưa xác minh sẽ không được gửi. Phụ huynh có thể vào /profile để kiểm tra/cập nhật email theo luồng hiện có.

Không có API công khai cho phép browser tự chọn người nhận hoặc kích hoạt gửi hàng loạt. Workflow không nhận recipient từ request.
