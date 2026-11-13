# Hướng dẫn tùy chọn: tự động train VietOCR V2 bằng Colab Enterprise

> **Có thể phát sinh phí:** Colab Enterprise không phải Colab Free. Hướng dẫn này chỉ dành cho người chủ động chọn dịch vụ Google Cloud trả theo mức sử dụng. Nếu cần phương án không mất phí, dùng [hướng dẫn Colab Free tương tác](viread-colab-free-training.md) và không tạo Cloud Run dispatcher.

## Phần A — Bạn làm một lần

### 1. Chuẩn bị phiên bản cần deploy

1. Đưa code VietOCR V2 lên GitHub và merge theo quy trình của repository.
2. Ghi lại commit SHA đủ 40 ký tự có backend, dispatcher, notebook và migration. Production cấu hình theo commit SHA, không theo tên branch.
3. Chưa deploy backend mới trước khi áp dụng migration ở bước 8.

### 2. Chọn project Google Cloud và kiểm tra chi phí

1. Dùng project Google Cloud hiện có mà bạn quản lý; hướng dẫn này không tạo project mới.
2. Kiểm tra billing account, GPU/runtime/disk, Cloud Run, Cloud Storage và Secret Manager pricing theo region.
3. Nếu tài khoản đủ điều kiện, xem điều khoản và hạn dùng trial credit. Credit không đồng nghĩa training vĩnh viễn miễn phí.
4. Đặt budget alert thấp để nhận cảnh báo. Đây không phải mức trần chi phí được bảo đảm.
5. Chọn execution timeout ngắn và kiểm tra Billing Reports sau smoke test.

### 3. Bật các API cần thiết

Trong Cloud Console của project, bật Vertex AI / Colab Enterprise (aiplatform.googleapis.com), Compute Engine (compute.googleapis.com), Cloud Storage (storage.googleapis.com), Secret Manager (secretmanager.googleapis.com), Cloud Run (run.googleapis.com), Cloud Build (cloudbuild.googleapis.com) và Artifact Registry (artifactregistry.googleapis.com). Tên API/quyền có thể khác theo region; nếu Console báo thiếu API, chỉ bật API được thông báo trong project hiện tại.

### 4. Tạo bucket riêng cho resume

Tạo Cloud Storage bucket riêng, cùng region với Colab Enterprise và Cloud Run. Dùng bucket này cho checkpoint resume theo job, không chứa secret hay ảnh sách gốc. Đặt lifecycle rule tự xóa object cũ sau khoảng thời gian khôi phục cần thiết, ví dụ 30 ngày. Ghi lại địa chỉ dạng gs://<bucket-name>.

### 5. Tạo runtime template GPU

1. Tạo Colab Enterprise runtime template trong region đã chọn.
2. Chọn GPU có tối thiểu 6 GiB VRAM; GPU T4 16 GiB là lựa chọn khởi đầu phù hợp với cấu hình hiện tại nếu project có quota.
3. Chọn phiên bản Python tương thích với requirements đã khóa trong repository, disk đủ lớn cho checkpoint và dataset, cùng timeout giới hạn.
4. Ghi lại resource đầy đủ: projects/<project-id>/locations/<region>/notebookRuntimeTemplates/<template-name>.

### 6. Tạo service accounts và quyền tối thiểu

Tạo một service account cho notebook runtime và một service account riêng cho dispatcher Cloud Run. Runtime account chỉ cần đọc đúng hai secret ở bước 7 và quyền đọc/ghi/xóa object trong bucket resume riêng. Dispatcher account cần quyền tạo/đọc Colab Enterprise Notebook Execution Jobs, sử dụng runtime template và iam.serviceAccounts.actAs trên runtime account. Cấp thêm quyền service agent theo yêu cầu chính thức của runtime template. Không cấp Owner/Editor rộng, không tạo service-account JSON key; dùng danh tính gắn trực tiếp.

### 7. Tạo Secret Manager secrets

Tạo hai secrets sau trong Secret Manager:

- viread-api-base: HTTPS URL public của backend Render đã deploy; tuyệt đối không dùng localhost.
- viread-training-worker-token: token ngẫu nhiên tối thiểu 32 ký tự, giống hệt biến VIREAD_TRAINING_WORKER_TOKEN trên Render.

Tạo một HMAC secret riêng, tối thiểu 32 ký tự, dùng ở Cloud Run và Render dưới tên VIREAD_COLAB_DISPATCH_SHARED_SECRET. HMAC secret khác worker token. Gắn HMAC vào Cloud Run dưới dạng secret environment variable. Không đưa giá trị secret vào Git, notebook, logs, chat hoặc ảnh chụp màn hình.

### 8. Áp dụng migration Supabase

Migration additive cần áp dụng là supabase/migrations/20261113051337_viread_colab_enterprise_dispatch.sql.

1. Kiểm tra migration history trước; không chạy lại migration đã áp dụng.
2. Review migration và chạy qua workflow/CLI migration hiện tại của dự án trên đúng Supabase project.
3. Không sửa schema production bằng lệnh tùy tiện và không xóa dữ liệu.
4. Chạy truy vấn chỉ đọc:

    select to_regclass('public.viread_ocr_training_jobs') as training_jobs,
           to_regclass('public.viread_ocr_dataset_versions') as datasets;

    select column_name
    from information_schema.columns
    where table_schema='public' and table_name='viread_ocr_training_jobs'
      and column_name in ('colab_execution_id','colab_execution_resource_name',
                          'colab_operation_name','colab_execution_number')
    order by column_name;

Truy vấn thứ hai phải trả về đủ bốn cột. Không deploy backend mới trước khi schema tương thích.

### 9. Deploy dispatcher Cloud Run

Deploy source cloud/colab-enterprise-dispatcher từ commit SHA đã ghi ở bước 1. Dùng dispatcher service account. Cấu hình đúng các biến mà dispatcher đọc:

- GCP_PROJECT_ID: project ID.
- GCP_REGION: region Colab Enterprise.
- COLAB_RUNTIME_TEMPLATE_RESOURCE: resource đầy đủ của template.
- COLAB_OUTPUT_GCS_URI: gs:// bucket resume riêng.
- COLAB_RUNTIME_SERVICE_ACCOUNT: email runtime service account.
- VIREAD_REPOSITORY_URL: https://github.com/trancuong3/capstone1.
- VIREAD_REPOSITORY_COMMIT: cùng commit SHA 40 ký tự đã ghi.
- VIREAD_API_BASE_SECRET_RESOURCE: projects/<project-id>/secrets/viread-api-base/versions/latest.
- VIREAD_WORKER_TOKEN_SECRET_RESOURCE: projects/<project-id>/secrets/viread-training-worker-token/versions/latest.
- COLAB_EXECUTION_TIMEOUT_SECONDS: giới hạn tối đa, mặc định code là 21600 giây.
- VIREAD_COLAB_DISPATCH_SHARED_SECRET: gắn HMAC secret dạng secret environment variable.

Ghi lại URL HTTPS Cloud Run service. Backend cần gọi được URL này; request dispatch được bảo vệ bằng HMAC. Không mở endpoint trạng thái không xác thực. Không chạy endpoint bằng một key Cloud dài hạn nhúng trong code.

### 10. Cấu hình Render backend

Trong Environment của đúng Web Service Render, giữ nguyên các biến database/Supabase hiện có và đặt:

- VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED=true
- VIREAD_LOCAL_TRAINING_ENABLED=false
- VIREAD_OCR_WARMUP_ENABLED=false
- VIREAD_COLAB_EXECUTION_MODE=enterprise
- VIREAD_COLAB_DISPATCH_URL=https://<cloud-run-service-url>
- VIREAD_COLAB_DISPATCH_SHARED_SECRET=<cùng HMAC secret với Cloud Run>
- VIREAD_COLAB_REPOSITORY_URL=https://github.com/trancuong3/capstone1
- VIREAD_COLAB_REPOSITORY_COMMIT=<cùng commit SHA>
- VIREAD_TRAINING_WORKER_TOKEN=<cùng worker token trong Secret Manager>

Không bật local trainer trên Render Free 512 MiB. Tắt OCR warmup để API không nạp model nặng trong lúc khởi động. Inference OCR vẫn có thể vượt RAM của gói Free. Không thêm biến không được backend sử dụng.

### 11. Deploy backend và kiểm tra

Sau khi migration thành công, deploy đúng commit lên Render từ branch main. Xác nhận start command lắng nghe 0.0.0.0:$PORT. Kiểm tra health/OpenAPI, Render logs không có OOM và trang Admin → Huấn luyện OCR tải được. Hãy giữ các giá trị secret ẩn khi chụp ảnh hoặc chia sẻ log.

## Phần B — Smoke test và tự động vận hành

### 12. Chạy một smoke test có kiểm soát

1. Bắt đầu với Flow 2: dùng vài trang VERIFIED có train và validation theo page group. Một trang duy nhất thường chỉ vào một split nên không thể tự cung cấp cả train lẫn validation.
2. Tạo Locked Test riêng, human-verified, không trùng với train/validation; để quality gate đủ bằng chứng cần tối thiểu 200 cặp và 30 nhóm trang.
3. Dashboard phải ghi profile FLOW2_ADMIN_VERIFIED, dataset version/hash, parent checkpoint, train/validation counts và job ID.
4. Trạng thái phải chuyển qua đã gửi/đang chạy Colab Enterprise. Trong Cloud Console kiểm tra NotebookExecutionJob resource, operation, runtime GPU và logs.
5. Sau khi kết thúc, kiểm tra training run, checkpoint SHA256, benchmark report, Locked Test manifest hash và quality gate. Candidate không trở thành model active cho tới khi quality gate cho phép và Admin duyệt.
6. Chỉ thử Flow 1 khi dataset đã có đủ 500–1.000 ảnh thật, 20.000–50.000 TRDG cùng train/validation cho từng nguồn. Không hạ ngưỡng hoặc tạo số liệu giả.

Notebook có mặt, job đã enqueue hay HTTP 200 không chứng minh model đã train. Bằng chứng train là run thật đã hoàn thành và checkpoint SHA256 được đăng ký. Bằng chứng Colab là NotebookExecutionJob cùng runtime GPU.

### 13. Sau cấu hình, hệ thống tự làm gì

- Flow 2: Admin sửa/proofread và xác nhận revision; outbox xử lý đúng revision VERIFIED; worker crop ảnh/ground truth; snapshot tách theo page; khi có train + validation, backend tự tạo job.
- Flow 1: khi dataset ảnh thật được DBNet xử lý, TRDG sinh dữ liệu và hai manifest được đăng ký, scheduler tự tạo job khi đủ ngưỡng. **Intake tự động từ bundle ảnh/annotation đến DBNet/TRDG/đăng ký hiện chưa có**; hiện vẫn cần chạy công cụ chuẩn bị/đăng ký thủ công.
- Dispatcher tự gửi từng job sẵn sàng tới Colab Enterprise; một job chạy tại một thời điểm. Worker kiểm tra hash, fine-tune đúng parent, upload checkpoint, benchmark và báo trạng thái.
- Admin duyệt candidate. Hệ thống không tự kích hoạt model mới.
- Colab Free trên trình duyệt là chế độ tương tác một job mỗi lần chạy cell; backend không thể tự đánh thức runtime. Không dùng poller nền liên tục trên runtime miễn phí.

### 14. Dừng và giảm chi phí

Đặt VIREAD_COLAB_EXECUTION_MODE=disabled trên Render để ngừng gửi job mới rồi redeploy. Hủy NotebookExecutionJob đang chạy trong Cloud Console và xác nhận trạng thái cuối ở Google lẫn ViRead. Xóa runtime, disk, resume object và artifact không cần thiết; xóa runtime không tự xóa object output. Kiểm tra Billing Reports sau smoke test. Budget alert không phải hard cap.

### Checklist xử lý lỗi

- BLOCKED_CONFIGURATION: kiểm tra Render variables, HTTPS URL, HMAC giống nhau, commit SHA, runtime template/region, IAM, secret access và migration.
- Không tạo NotebookExecutionJob: kiểm tra API đã bật, dispatcher logs, IAM, quyền actAs và GPU quota của region.
- Không đọc được secret: kiểm tra runtime service account và Secret Accessor đúng secret/version.
- Thiếu train/validation: cần nhiều page group; mọi crop của một trang phải cùng split. Flow 1 yêu cầu train/validation ở cả ảnh thật và TRDG.
- Hash ảnh/manifest/checkpoint sai: dừng job và điều tra object/lineage; không sửa hash để bỏ qua kiểm tra.
- DATASET_SAMPLE_COUNT_MISMATCH: backend dừng job trước khi gọi Colab, đánh dấu FAILED và tạo snapshot/job canonical ở vòng scheduler tiếp theo nếu nguồn VERIFIED còn hợp lệ.
- Execution kết thúc nhưng không có run: kiểm tra logs và run record trước khi retry; không tạo duplicate checkpoint/run một cách mù quáng.
- Render OOM/không bind port: giữ local trainer và warmup tắt trên gói Free; start command phải bind 0.0.0.0:$PORT. Inference OCR nặng có thể cần máy khác.
- Chưa có Locked Test: không promote candidate; tạo tập human-verified độc lập, không dùng train/validation.

## Trạng thái đã xác minh trong phiên triển khai

Chưa tạo tài nguyên Cloud, bật billing, lưu secrets, áp dụng migration production, deploy Render hoặc chạy Colab Enterprise GPU trong phiên này. Hướng dẫn và code không thay thế những bước cấu hình đó. Flow 1 intake tự động từ đầu đến cuối vẫn chưa được triển khai. Không có căn cứ để nói VietOCR V2 đã train thành công nếu chưa có run thật và checkpoint SHA256.

Nếu execution đã đăng ký một training run nhưng kết quả chưa được đồng bộ, job hiện được giữ BLOCKED. Hiện chưa có thao tác Admin an toàn để requeue loại job đó; không cập nhật trạng thái thủ công trong database.

