# Triển khai OCR 24/7 Chi phí 0 VNĐ trên Azure for Students (Email `.edu.vn` — Không Cần Thẻ)

Tài liệu này hướng dẫn triển khai bộ 3 engine OCR tiếng Việt của **ViRead** (**PaddleOCR 2.7.3 + VietOCR 0.3.12 `FLOW1_EXTERNAL_TRDG` + Tesseract 5 `vie`**) lên **Azure Container Apps (Consumption Plan)** bằng tài khoản **Azure for Students** (`email .edu.vn`, **0 thẻ tín dụng**, **khóa cứng 0 VNĐ**, chạy **24/7 kể cả khi tắt laptop 100%**).

---

## 1. Vì sao Kiến trúc này Đạt 0 VNĐ Tuyệt Đối & ~1,500–3,500+ Trang/Tháng?

```text
[Trẻ đọc sách / STT WASM / TTS Cache]
   │  GET /health hoặc đọc sách trên Web Vercel / Android
   ▼
[Render Free Web API (VIREAD_OCR_REMOTE_SCALE_TO_ZERO=true)]
   ├─ Khi chỉ đọc sách / gọi /health / cron 12h:
   │    → Trả về trạng thái sẵn sàng scale_to_zero trong < 1ms (0 HTTP gọi sang Azure = 0 GiB-s hao phí!)
   └─ Chỉ khi Phụ huynh / Admin thực sự tải ảnh quét sách (enqueue_job COMMIT thành công):
        → Gộp đơn luồng (_IN_FLIGHT_WAKE_URLS) gọi POST https://<fqdn>/wakeup?drain=true (timeout 240s)
        ▼
[Azure Container Apps Consumption (2.0 vCPU / 4.0 GiB RAM, minReplicas=0, maxReplicas=1)]
   ├─ Image pull miễn phí từ GitHub Container Registry: ghcr.io/trancuong3/viread-ocr-worker:latest ($0 ACR!)
   ├─ Model FLOW1_EXTERNAL_TRDG (151.8 MB) đã đóng gói & kiểm chứng SHA-256 sẵn trong image:
   │    → 0 MB băng thông tải từ Supabase Storage Free (bảo toàn 100% hạn mức 5 GB/tháng!)
   ├─ Giữ kết nối HTTP mở suốt chu kỳ rút cạn hàng đợi (drain=true) + kiểm tra trang trễ 3 giây
   └─ Sau 30 giây rỗi (cooldownPeriod=30s, logs=none): tự hạ về 0 replica = 0.00 USD/giờ!
```

### Bảo chứng Tài chính 0 VNĐ (Zero Surprise Bill)
1. **Không cần thẻ tín dụng**: Gói [Azure for Students](https://azure.microsoft.com/free/students/) xác thực qua email sinh viên `.edu.vn`, mặc định khóa chi tiêu (**Spending Limit = $0** — không thể phát sinh nợ quá hạn mức tặng kèm).
2. **Miễn phí hàng tháng của Azure Container Apps Consumption** (ngoài $100 credit sinh viên):
   - **180,000 vCPU-giây + 360,000 GiB-giây miễn phí mỗi tháng** (tương đương ~25 giờ chạy liên tục ở cấu hình 2 vCPU / 4 GiB RAM = **~1,500–3,500+ trang sách OCR/tháng** hoàn toàn trong ngưỡng Always Free trước cả khi chạm tới $100 credit!).
3. **Loại bỏ 100% chi phí ẩn**:
   - **Không dùng Azure Container Registry** (tiết kiệm ~$5/tháng): kéo trực tiếp image từ **GitHub Container Registry (`ghcr.io`)** miễn phí vĩnh viễn.
   - **Không bật Log Analytics Workspace** (`--logs-destination none`): tốn **0đ** phí lưu trữ log.
   - **Không đánh thức ngầm**: `VIREAD_OCR_REMOTE_SCALE_TO_ZERO=true` chặn toàn bộ `/health` thụ động và cron keep-warm gọi sang Azure khi không có trang sách chờ quét.

---

## 2. Triển khai Tự động bằng 1 Lệnh PowerShell (Khuyên Dùng)

### Bước 1: Kích hoạt Azure for Students & cài Azure CLI (nếu chưa có)
1. Đăng ký tại [azure.microsoft.com/free/students](https://azure.microsoft.com/free/students/) bằng email `.edu.vn` (không nhập thẻ).
2. Mở **Windows PowerShell** và cài Azure CLI (bỏ qua nếu máy đã có lệnh `az`):
   ```powershell
   winget install -e --id Microsoft.AzureCLI
   ```
   *(Sau khi cài xong, đóng và mở lại cửa sổ PowerShell mới.)*

### Bước 2: Chạy Script Triển khai Tự động
Script tương thích hoàn toàn với **Windows PowerShell 5.1**, tự động:
- Đăng nhập `az login` và đăng ký `Microsoft.App`.
- Tự động dò vùng hợp lệ (`southeastasia`, `eastasia`, `japaneast`, `koreacentral`, `australiaeast`, `westus2`, `eastus`) nếu gói sinh viên của bạn giới hạn vùng (`RequestDisallowedByPolicy`).
- Tự sinh mã bí mật `VIREAD_OCR_WORKER_TOKEN` **mới tinh 48 ký tự** vào Clipboard (tuyệt đối không dùng lại bất kỳ mã nào từng in ra màn hình trước đó).
- Tạo Container App `viread-ocr-worker` (`minReplicas=0`, `maxReplicas=1`, `cooldownPeriod=30s`, `logs=none`) và kiểm tra `GET /health`.

```powershell
Set-Location "F:\c1\capstone1-hf-ocr-zero-cost"
powershell -ExecutionPolicy Bypass -File .\scripts\azure\Deploy-ViReadAzureOcrWorker.ps1
```

> **Mẹo khi được hỏi `VIREAD_OCR_WORKER_TOKEN`**: Chỉ cần nhấn phím **Enter** (để trống) — script sẽ tự tạo mã ngẫu nhiên mật mã học 48 ký tự và chép thẳng vào **Clipboard** của bạn để dán sang Render ở Bước 3!

---

## 3. Cấu hình Biến Môi Trường trên Render (`capstone1-ssd8`)

Mở **Render Dashboard → `capstone1-ssd8` → Environment**, cập nhật các biến mà script vừa in ra ở cuối màn hình:

| Biến môi trường trên Render | Giá trị | Vai trò |
|---|---|---|
| `VIREAD_OCR_MODE` | `remote_worker` | Chuyển toàn bộ OCR sang worker độc lập |
| `VIREAD_WEB_DISABLE_HEAVY_WORKERS` | `true` | Giữ RAM Render < 512 MB & bảo vệ kết nối STT/TTS |
| `VIREAD_OCR_REMOTE_WORKER_URL` | `https://viread-ocr-worker.<...>.azurecontainerapps.io` | URL FQDN do script Azure cấp ở bước cuối |
| `VIREAD_OCR_REMOTE_SCALE_TO_ZERO` | `true` | **Bắt buộc**: tắt ping `/health` khi rỗi & bật `POST /wakeup?drain=true` |
| `VIREAD_OCR_WORKER_TOKEN` | *(Nhấn `Ctrl+V` dán từ Clipboard)* | Khớp 100% với secret `ocr-worker-token` trên Azure |
| `OCR_CLOUD_CORRECTION_ENABLED` | `true` | Bật soát lỗi chính tả & an toàn trẻ em qua AI đám mây miễn phí |
| `PRIVATE_BOOK_ALLOW_CLOUD_AI` | `true` | Cho phép luồng `/my-books` hoàn tất khi tắt Ollama trên laptop |

*(Nếu trước đó bạn từng tạo `VIREAD_HF_SPACE_TOKEN`, hãy xóa hoặc để trống biến đó để không gửi header dư thừa sang Azure.)*

---

## 4. Tùy chọn Nâng cao — Đẩy Checkpoint Flow 2 Mới lên Hugging Face Model Repo (0 VNĐ)

Image `ghcr.io/trancuong3/viread-ocr-worker:latest` **đã tích hợp sẵn** checkpoint `FLOW1_EXTERNAL_TRDG` (`200edce4...`, 151.8 MB) nên **không cần cấu hình thêm gì**.

Trong tương lai, nếu Admin promote một checkpoint VietOCR Flow 2 mới và muốn tải từ CDN miễn phí thay vì Supabase Storage, kho **Model Repo** trên Hugging Face (`type: "model"`) vẫn **miễn phí 100% không cần gói PRO**:

```powershell
$env:HF_TOKEN = "<HF_WRITE_TOKEN>"
python scripts/push_hf_model_checkpoint.py --repo-id "cuonghhhdd3/viread-ocr-models" --public
Remove-Item Env:HF_TOKEN -ErrorAction SilentlyContinue
```

Sau đó truyền thêm `-CheckpointCdnUrl "https://huggingface.co/cuonghhhdd3/viread-ocr-models/resolve/main"` khi chạy `Deploy-ViReadAzureOcrWorker.ps1`. Worker luôn kiểm tra khớp `SHA-256` tuyệt đối trước khi nạp trọng số.

---

## 5. Kiểm tra Nghiệm thu Sau Cài Đặt

1. **Kiểm tra Render không đánh thức Azure khi chỉ gọi `/health`**:
   ```powershell
   Invoke-RestMethod -Uri "https://capstone1-ssd8.onrender.com/health" | ConvertTo-Json -Depth 5
   ```
   Trường `ocr.ready` trả về `true` và `ocr.workers[0].standby_mode` là `"scale_to_zero"` trong `< 1ms` mà replica trên Azure vẫn giữ nguyên bằng `0`!
2. **Thử quét 1 trang sách khi tắt laptop**:
   - Mở `https://viread-frontend.vercel.app/book-scanner` hoặc `/my-books` trên điện thoại / trình duyệt.
   - Trang đầu tiên khi container đang ngủ ở `0` replica sẽ mất khoảng **25–45 giây** để khởi động container + nhận diện đủ 3 engine; các trang kế tiếp trong cùng đợt quét chỉ mất **~8–15 giây/trang**.
   - Sau 30 giây hoàn tất, Azure tự động đưa replica về `0` (**0 VNĐ**).
