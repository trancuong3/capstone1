# Hướng dẫn train VietOCR V2 miễn phí bằng Colab Free

Phương án này không tạo Cloud Run dispatcher, Colab Enterprise runtime, GCS bucket hoặc tài nguyên GPU tính phí. Backend vẫn tự tạo job khi dataset của một profile đã sẵn sàng. Người dùng phải mở Colab, kết nối runtime miễn phí nếu GPU đang được cấp, và chạy cell để xử lý tối đa một job. Colab Free không được đánh thức từ backend và GPU không được bảo đảm.

## 1. Cấu hình backend một lần

Trong Environment của Web Service Render, đặt:

```text
VIREAD_COLAB_EXECUTION_MODE=manual
VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED=true
VIREAD_LOCAL_TRAINING_ENABLED=false
VIREAD_OCR_WARMUP_ENABLED=false
VIREAD_TRAINING_WORKER_TOKEN=<token ngẫu nhiên dài ít nhất 32 ký tự>
```

Giữ nguyên các biến kết nối Database, Supabase và Storage đang dùng. Không đặt `VIREAD_COLAB_DISPATCH_URL`, `VIREAD_COLAB_DISPATCH_SHARED_SECRET`, `VIREAD_COLAB_REPOSITORY_COMMIT`, `GCP_PROJECT_ID` hoặc thông tin Cloud Run cho chế độ miễn phí. Không đưa token vào Git, chat, ảnh chụp hay log.

Lưu thay đổi và chờ backend Render khởi động lại. Kiểm tra trang Admin → Huấn luyện OCR vẫn tải được, và log không báo thiếu migration hoặc OOM. Gói Render Free không phải máy train; trainer và OCR warmup phải tắt ở dịch vụ này.

## 2. Chuẩn bị dữ liệu

### Luồng 2 — Admin xác nhận

1. Upload trang sách, sửa nội dung và kiểm tra các bounding box từ OCR.
2. Xác minh từng trang để tạo revision `VERIFIED`.
3. Chờ outbox xử lý ảnh crop và nhãn từ đúng revision.
4. Mở Admin → Huấn luyện OCR. Chỉ chạy khi dataset Flow 2 có cả train và validation. Các dòng cùng trang phải ở cùng một split; nhiều dòng từ một trang không tạo ra nhiều nhóm độc lập.

### Luồng 1 — Ảnh ngoài + DBNet + TRDG

Luồng này hiện cần người quản trị chuẩn bị ảnh/annotation đã được duyệt, corpus tiếng Việt và font; chạy công cụ chuẩn bị/đăng ký hiện có. Dataset phải đạt ngưỡng cấu hình và có train/validation trước khi backend tạo job. Hiện chưa có intake tự động từ một thư mục ảnh ngoài đến đăng ký dataset.

Hai luồng giữ dataset và job riêng; mỗi job chọn một profile, nhưng đều fine-tune cùng lineage VietOCR Original để tạo candidate V2.

## 3. Lấy notebook trên Colab

Sau khi notebook thay đổi này đã được merge vào `main`:

1. Mở trực tiếp [notebook worker trên nhánh main](https://github.com/trancuong3/capstone1/blob/main/ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb).
2. Trên trang GitHub, chọn **Open in Colab**. Nếu nút không hiện, tải file `.ipynb` rồi trong Colab chọn **File → Upload notebook**.
3. Trong Colab mở **Secrets** (biểu tượng chìa khóa) và thêm:
   - `VIREAD_API_BASE`: URL HTTPS gốc của Web Service Render, ví dụ `https://<ten-service>.onrender.com`; không thêm `localhost` hoặc `/api/v1`.
   - `VIREAD_TRAINING_WORKER_TOKEN`: chính token đã cấu hình ở Render.
   - `VIREAD_REPOSITORY_REF`: `main`.
4. Bật quyền truy cập secrets cho notebook.
5. Chọn **Runtime → Change runtime type → T4 GPU** nếu lựa chọn đó đang có, rồi kết nối. Colab Free có thể không cấp GPU ở thời điểm bạn thử.

## 4. Khởi động từng job

1. Trong ViRead Admin, kiểm tra có job đang chờ Colab và đã chọn đúng profile (`FLOW1_EXTERNAL_TRDG` hoặc `FLOW2_ADMIN_VERIFIED`).
2. Trong Colab chọn **Runtime → Run all**. Cell kết nối Drive để giữ thư mục job, cài dependency đã khóa, rồi kiểm tra GPU và nhận tối đa một job đang sẵn sàng. Bạn không nhập job ID hay nhãn dữ liệu.
3. Để cell chạy đến khi kết thúc. Nó sẽ tải manifest/ảnh/checkpoint và kiểm tra SHA256, fine-tune, upload candidate, chạy benchmark nếu có Locked Test, rồi báo trạng thái về backend.
4. Nếu notebook báo không có job, chưa có training run nào bắt đầu. Quay lại Admin và kiểm tra dataset readiness hoặc trạng thái job.
5. Nếu runtime bị ngắt giữa chừng, lease của job có thể còn hiệu lực tối đa 15 phút. Kết nối runtime mới, mount lại cùng Google Drive, chờ lease hết hạn rồi chạy lại cell để tiếp tục cùng job. Không tạo job trùng hoặc xóa thư mục `MyDrive/ViRead/VietOCR-V2-worker` vì trong đó có state/checkpoint phục hồi.
6. Muốn xử lý job kế tiếp, chạy lại cell một lần nữa. Notebook không tự poll nền.

## 5. Xác nhận đã train thật

Trong Admin → Huấn luyện OCR, xác nhận job đã kết thúc bước training và có training run/candidate với checkpoint SHA256. Nếu có Locked Test, xem report và kết quả quality gate. Job `QUEUED`, `WAITING_FOR_COLAB_WORKER`, một trang VERIFIED, hoặc số mẫu dataset tự nó chưa chứng minh model đã train. Candidate không được dùng làm model hoạt động cho tới khi qua gate và Admin duyệt.

Nếu Colab báo thiếu GPU hoặc tài nguyên, dữ liệu và job vẫn được giữ; thử lại sau khi Google cấp runtime phù hợp. Không hạ ngưỡng dữ liệu, bỏ kiểm tra hash, hoặc đánh dấu job thành công bằng tay.

## Chi phí và giới hạn

Colab Free không thu phí notebook, nhưng GPU và thời lượng runtime phụ thuộc mức cấp phát, có thể bị ngắt hoặc không có sẵn. Dữ liệu trong Google Drive và Supabase vẫn chịu hạn mức lưu trữ miễn phí của tài khoản/dự án. Không thêm billing hoặc nâng cấp dịch vụ nếu mục tiêu là 0 đồng.
