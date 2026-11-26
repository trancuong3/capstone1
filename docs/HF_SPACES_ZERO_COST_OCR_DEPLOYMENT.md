# Triển khai OCR 24/7 Chi phí 0 VNĐ (Tắt Laptop 100%, Giữ Nguyên Chất Lượng 3-Engine)

Tài liệu này hướng dẫn cấu hình hoàn chỉnh để **ViRead Web (`Vercel`)** và **ViRead Android** quét OCR trang sách (`/book-scanner`, `/admin/books`, `/my-books`) **24/7 khi tắt laptop hoàn toàn** với **0 VNĐ/tháng**, không cần thẻ tín dụng, giữ nguyên 100% chất lượng bộ 3 engine (**PaddleOCR 2.7.3 + VietOCR 0.3.12 `FLOW1_EXTERNAL_TRDG` + Tesseract 5 `vie`**), và **không gây nghẽn Render Free (512 MB / 750 giờ / NullPool) hay ảnh hưởng STT/TTS offline**.

---

## 1. Kiến trúc Chống Nghẽn & 0 VNĐ

```text
[Vercel Web / Android App]
   │  1) Tải ảnh / Quét trang (POST /reading/scan-page-ocr/jobs | /books/my-books/.../submissions)
   ▼
[Render Free Web API (512 MB, NullPool, DATABASE_CONCURRENCY_LIMIT=8)]
   │  2) Lưu job QUEUED vào Supabase -> COMMIT giải phóng DB permit ngay (<10ms)
   │  3) Hook after_commit bắn POST https://<owner>-<space>.hf.space/wakeup
   │     (Nếu đang bật laptop GPU rảnh và chỉ có 1 trang -> ưu tiên chờ GPU laptop 2.5s trước!)
   ▼
[Hugging Face Private Space (cpu-basic: 2 vCPU x86_64, 16 GB RAM — 0 VNĐ)]
   │  4) Đang ở Quiet Standby (0 request/phút tới Render) -> thức dậy trong <1s
   │  5) Tải ảnh trực tiếp qua Signed Storage URL (0 băng thông qua Render)
   │  6) Chạy đủ 3 engine (PaddleOCR + VietOCR FLOW1_EXTERNAL_TRDG + Tesseract vie)
   │  7) Gửi kết quả về /internal/ocr-jobs/{id}/complete -> sau 90s rỗi tự về Quiet Standby!
```

### Bảo vệ STT/TTS & Render NullPool
- **Quiet Standby (`0` HTTP request khi rỗi)**: Worker trên HF Spaces không poll DB 2 giây/lần khi không có người quét, giúp Render Free được nghỉ tự nhiên (an toàn dưới trần **750 giờ/tháng**) và không chiếm dụng kết nối TLS `NullPool` của `viread-tts-cache` / đọc sách.
- **Passive Health Probe (`60s` RAM cache)**: Khi người dùng mở app gọi `/health`, Render chỉ hỏi thăm thụ động `GET <space>/health` tối đa 1 lần/phút ngoài giao dịch DB — vừa giữ cho HF Space không ngủ sau 48h, vừa **không đánh thức vòng lặp poll DB** của worker.
- **Tách Signed URL ra ngoài giao dịch DB**: `claim_next_job`, `refresh_source_url` và `get_active_model_manifest` đóng giao dịch DB trước khi ký URL trên Supabase Storage và chạy trên threadpool bất đồng bộ (`0ms` chặn event loop của STT/TTS).
- **Giới hạn hậu xử lý `/my-books` trên Render 512 MB**: Mặc định `_post_ocr_concurrency_limit() == 1` khi `VIREAD_WEB_DISABLE_HEAVY_WORKERS=true` để bước soát lỗi AI & an toàn trẻ em không bao giờ làm tràn RAM 512 MB.

---

## 2. Bước 1 — Tạo & Đẩy Hugging Face Private Space (`cpu-basic`, 0 VNĐ)

### Cách A: Đẩy tự động bằng 1 lệnh từ máy của bạn (Khuyên dùng)
1. Đăng nhập [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) (tài khoản miễn phí, không cần thẻ), tạo:
   - 1 **Write Token** (`hf_...`) để đẩy code lần đầu.
   - 1 **Read Token** (`hf_...`) để điền cho Render gọi vào Private Space.
2. Tạo 1 chuỗi ngẫu nhiên dài tối thiểu 32 ký tự làm `VIREAD_OCR_WORKER_TOKEN` (dùng chung giữa Render và HF Space).
3. Chạy lệnh đẩy tự động (script tự gói bundle sạch `< 250 KB`, tạo Space ở chế độ **Private + Docker + `cpu-basic`**, gắn Secrets và đẩy code):

```powershell
$env:HF_TOKEN = "<HF_WRITE_TOKEN_CUA_BAN>"
$env:VIREAD_OCR_BACKEND_URL = "https://capstone1-ssd8.onrender.com"
$env:VIREAD_OCR_WORKER_TOKEN = "<CHUOI_BI_MAT_TOI_THIEU_32_KY_TU>"
python scripts/push_hf_space.py --space-id "<ten-user-hf>/viread-ocr-worker" --sync-secrets
```

### Cách B: Tạo thủ công trên giao diện Web Hugging Face
1. Chạy `python scripts/build_hf_space_bundle.py` để xuất thư mục chuẩn tại `.runtime/hf-ocr-space-bundle`.
2. Trên Hugging Face bấm **New Space** → chọn **Docker** (Blank) → chọn **CPU basic (Free · 2 vCPU · 16 GB)** → chọn **Private**.
3. Vào **Settings → Variables and secrets → New secret**, thêm:
   - `VIREAD_OCR_BACKEND_URL` = `https://capstone1-ssd8.onrender.com`
   - `VIREAD_OCR_WORKER_TOKEN` = `<CHUOI_BI_MAT_TOI_THIEU_32_KY_TU>`
4. Tải toàn bộ tệp trong `.runtime/hf-ocr-space-bundle` lên Space. Sau ~4–6 phút build xong, trạng thái Space chuyển sang **Running** trên cổng `7860` (`UID 1000`).

---

## 3. Bước 2 — Cấu hình Biến Môi Trường trên Render (`capstone1-ssd8`)

Mở **Render Dashboard → `capstone1-ssd8` → Environment** và đảm bảo các biến sau:

| Biến môi trường trên Render | Giá trị khuyến nghị (0 VNĐ) | Mục đích |
|---|---|---|
| `VIREAD_OCR_MODE` | `remote_worker` | Chuyển toàn bộ OCR nặng sang worker độc lập |
| `VIREAD_WEB_DISABLE_HEAVY_WORKERS` | `true` | Tắt nạp ML & giữ hậu xử lý đồng thời = 1 trên 512 MB RAM |
| `VIREAD_OCR_WORKER_TOKEN` | `<CHUOI_BI_MAT_TOI_THIEU_32_KY_TU>` | Khớp 100% với Secret trên HF Space |
| `VIREAD_OCR_REMOTE_WORKER_URL` | `https://<ten-user-hf>-viread-ocr-worker.hf.space` | URL trực tiếp của Space để Render gọi `/health` và `/wakeup` |
| `VIREAD_HF_SPACE_TOKEN` | `<HF_READ_TOKEN>` | Cho phép Render đi qua lớp bảo vệ của **Private** HF Space |
| `OCR_CLOUD_CORRECTION_ENABLED` | `true` | Bật soát chính tả & an toàn trẻ em qua AI đám mây miễn phí khi tắt laptop |
| `PRIVATE_BOOK_ALLOW_CLOUD_AI` | `true` | Cho phép luồng `/my-books` hoàn tất Bước 2 & 3 khi tắt Ollama trên laptop |
| `GEMINI_API_KEY` | `<GOOGLE_AI_STUDIO_FREE_KEY>` | Khóa miễn phí từ Google AI Studio cho Proofreading & Child Safety |
| `GROQ_API_KEY` | `<GROQ_FREE_KEY>` *(tùy chọn)* | Dự phòng miễn phí tốc độ cao khi Gemini chạm hạn mức phút |

> **Lưu ý minh bạch quyền riêng tư**: Khi bật `PRIVATE_BOOK_ALLOW_CLOUD_AI=true` + `OCR_CLOUD_CORRECTION_ENABLED=true`, giao diện **Sách của tôi (`/my-books`)** tự động hiển thị thông báo rõ ràng cho phụ huynh rằng văn bản trang sách tải lên được soát lỗi chính tả và kiểm tra an toàn trẻ em qua dịch vụ AI đám mây bảo mật, và sách vẫn chỉ hiển thị riêng tư trong gia đình.

---

## 4. Chế độ Hybrid Tự động Tăng tốc (Laptop + Cloud 0 VNĐ)

Không cần bật/tắt cấu hình thủ công:
- **Khi tắt laptop**: HF Space tự động nhận tín hiệu `/wakeup` ngay lập tức (`0ms` trễ) và xử lý 100% yêu cầu từ Web Vercel & điện thoại Android.
- **Khi bật laptop chạy GPU worker cục bộ**: Render phát hiện heartbeat `cuda_available=true` đang `IDLE`, tự động nhường **2.5 giây** cho GPU GTX 1650 trên laptop kéo trang đơn (tốc độ ~8s/trang) trong khi HF Space vẫn nằm yên ở Quiet Standby. Nếu tải tệp PDF nhiều trang cùng lúc, cả GPU laptop và HF Space cùng chia tải song song!

---

## 5. Kiểm tra Nghiệm thu Nhanh sau khi Cài đặt

```bash
# 1. Kiểm tra Render nhìn thấy HF Space sẵn sàng (kể cả khi đang ở Quiet Standby):
curl -fsS https://capstone1-ssd8.onrender.com/health

# 2. Kiểm tra STT/TTS offline & cache âm thanh vẫn hoạt động độc lập:
curl -fsS https://viread-frontend.vercel.app
```
