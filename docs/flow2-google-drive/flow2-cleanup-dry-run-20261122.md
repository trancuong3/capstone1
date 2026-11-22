# Flow 2 — Báo cáo Kiểm kê, Chạy thử & Làm sạch Pool Huấn luyện (2026-11-22)

> **Lưu ý bảo mật:** Báo cáo này không chứa token, mật khẩu, signed URL hoặc toàn văn sách. Danh sách ID chi tiết và script hoàn tác dữ liệu được lưu riêng cục bộ ngoài Git.

## 1. Xác nhận môi trường, Database & Google Drive

| Thành phần | Giá trị xác nhận thực tế |
|---|---|
| **Git branch** | `main` (HEAD `ac5b9af3`) |
| **Database** | Remote/Shared Supabase PostgreSQL (`hgkklatgepyzbkkmwfvp.supabase.co`, pooler `aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`) |
| **Google Drive** | `CONNECTED` (`oauth_scope = drive_desktop_sync`), tài khoản `cuongtran290605@gmail.com` |
| **Thư mục gốc Drive** | `MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified` (`G:\Drive của tôi\ViRead\OCR-Training\Flow2-Admin-Verified`) |
| **Write Provider Flow 2** | `google_drive` (`VIREAD_FLOW2_STORAGE_PROVIDER=google_drive`) |
| **Chính sách xóa vật lý** | **Không xóa vật lý** trên Supabase dùng chung hay Google Drive trong bước này; sử dụng cơ chế **Archive/Quarantine bền vững, hoàn tác 100%**. |

---

## 2. Giải thích số liệu UI trước khi dọn (`1.046 mẫu` · `Drive: 14 · Legacy: 132`)

1. **Thẻ tổng `1.046 mẫu`** được tính bởi `SELECT source_flow, split, count(DISTINCT image_sha256) FROM viread_ocr_samples GROUP BY source_flow, split`:
   - `FLOW1_VERIFIED / train`: **792** ảnh duy nhất (gồm 14 Drive Admin-verified + 122 Legacy Admin-verified + 646 Legacy `ai_auto` chưa duyệt + 10 bản snapshot lịch sử).
   - `FLOW1_VERIFIED / validation`: **16** ảnh duy nhất (10 Legacy Admin-verified pool + 6 Legacy `ai_auto` snapshot).
   - `LOCKED_TEST / locked_test`: **238** ảnh duy nhất (76 nhóm, bản `c6eb7509-fda2-4f38-954f-69ffa8fcc823`).
   - Tổng: `792 + 16 + 238 = 1.046` (tổng số dòng vật lý trong bảng là **2.353 dòng**, do nhiều snapshot lịch sử dùng chung ảnh).
2. **Dòng `Luồng 2 trên Drive: 14 · Legacy: 132`** (tổng pool đủ điều kiện = **146**):
   - Lọc theo `source_flow='FLOW1_VERIFIED' AND dataset_version_id IS NULL AND verified_by_admin='true' AND ai_review_required<>'true' AND verification_source='admin'`:
   - **Flow 2 trên Drive (`gdrive://%`)**: **14** mẫu (2 revision của sách `real`).
   - **Legacy Supabase (`NOT LIKE 'gdrive://%'`)**: **132** mẫu (122 train + 10 validation, từ 4 revision của các sách cũ).
   - **Chưa xác minh (`ai_auto`) trong pool**: **658** dòng (**646** ảnh duy nhất) trên `supabase_legacy`.
   - **Outbox (`viread_ocr_outbox`)**: **37** dòng, toàn bộ ở trạng thái `DONE` (0 `PENDING`, 0 `PROCESSING`, 0 `RETRY`, 0 `DEAD`, 0 `BLOCKED`).
   - **Flow 1 (`FLOW2_EXTERNAL`, `FLOW2_TRDG`, `FLOW2_EXTERNAL_TRDG`)**: **0** dòng mẫu trong bảng `viread_ocr_samples` (model Flow 1 đang hoạt động được kích hoạt trực tiếp qua checkpoint upload).

---

## 3. Phân loại tài sản: Loại khỏi pool vs Bảo toàn lịch sử

### A. Đã đưa ra khỏi pool train mới (`training_eligibility = 'ARCHIVED'` / `dataset_status = 'ARCHIVED'`)
- **804 dòng pool Flow 2 cũ** (`source_flow='FLOW1_VERIFIED' AND dataset_version_id IS NULL`):
  - 14 dòng trên Google Drive (2 revision).
  - 132 dòng Admin-verified trên Supabase Legacy (4 revision).
  - 658 dòng `ai_auto` chưa duyệt trên Supabase Legacy (23 revision).
- **16 phiên bản dataset lịch sử `FLOW1_VERIFIED`** (`ee455154-...`, `03533a8d-...`, `20d4de2e-...`, ..., `7ac36cbf-...`):
  - Giữ nguyên toàn bộ manifest và 1.311 dòng snapshot để bảo toàn lịch sử kiểm toán & run `86fd0cde-...`.
  - Đánh dấu `dataset_status = 'ARCHIVED'` để `admin_verified_manifest()` và `_schedule_ready_flow2()` **không bao giờ tự chọn lại làm đầu vào cho lần train mới**.

### B. Bảo toàn nguyên vẹn 100% (không sửa, không xóa)
- **Active Model (Flow 1)**: `FLOW1_EXTERNAL_TRDG`, `checkpoint_sha256 = 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6`, 2 bản ghi `viread_ocr_model_decisions`.
- **Run bước 5.000**: `86fd0cde-54f9-4fac-9146-80351ed05ec2` (`BENCHMARKED`, step `5000`, `checkpoint_storage_path = gdrive://gdesk_1545457cdf6542a0b87fc598872aef14`, 19 shard = 151,85 MB trên Drive).
- **Benchmark tương ứng**: `77fe3716-de2b-4c58-8c85-aea816c1cdd0` (`ORIGINAL_WIN`, 238 mẫu, 76 nhóm).
- **Locked Test cũ**: `c6eb7509-fda2-4f38-954f-69ffa8fcc823` (238 mẫu, 76 nhóm, 0 trùng lặp với train/val; **đã tiêu thụ bởi benchmark `77fe3716`** nên chỉ giữ cho lịch sử và **không thể tái sử dụng** cho lần đánh giá Production mới theo luật single-use trong `_locked_test_readiness()`).
- **Toàn bộ sách, ảnh sách gốc (`bookpages`), `pagerevisions`, `pagerevisionwords`, dữ liệu đọc của trẻ, file trên Google Drive và Supabase Storage.**

---

## 4. Kết quả xác minh Trước / Sau

| Chỉ số | Trước khi dọn | Sau khi dọn |
|---|---:|---:|
| Mẫu Flow 2 sẵn sàng train trên Drive (`flow2_drive_synced_samples`) | 14 | **0** |
| Mẫu Flow 2 Legacy (`flow2_legacy_samples`) | 132 | **0** |
| Tổng pool Flow 2 đủ điều kiện (`flow2_verified_total_samples`) | 146 | **0** |
| Mẫu Flow 2 chờ xác minh (`flow2_pending_verification_samples`) | 0 (ẩn trong 1.046) | **0** |
| Mẫu Flow 2 đã loại (`flow2_excluded_samples`, ảnh duy nhất) | 0 | **792** (804 dòng) |
| `admin_verified_manifest()` trả về | Snapshot cũ (146 mẫu) | **`dataset_version_id = null`, `total = 0`** |
| `dataset_ready_for_training` | `true` | **`false`** |
| Tổng dòng vật lý bảo toàn trong `viread_ocr_samples` | 2.353 | **2.353** (0 xóa vật lý) |
| Locked Test sẵn sàng cho run mới (`_locked_test_readiness`) | `NEEDS_DATA` (0/200) | **`NEEDS_DATA` (0/200, thiếu 30 nhóm)** |

---

## 5. Danh sách đề xuất xóa vật lý (CHỈ thực hiện khi chủ dự án xác nhận đích xác)

Hiện tại **chưa có file hay dòng DB nào bị xóa vật lý**. Nếu muốn giải phóng dung lượng Drive cho các tệp không được run `86fd0cde-...` tham chiếu:
- `verified-samples/`: **28 file** (14 PNG + 14 JSON của 2 revision `c923b0fa-...` và `026e015e-...` thuộc sách `real`), chỉ được tham chiếu bởi 2 snapshot chưa từng train (`ee455154-...`, `03533a8d-...`).
- `datasets/`: **8 file** thuộc 2 snapshot chưa từng train (`ee455154-...`, `03533a8d-...`).
- **Tuyệt đối giữ nguyên**: `checkpoints/` (20 file của run `86fd0cde-...`), `benchmarks/` (1 file), `locked-tests/` (239 file), `resume/` (96 file).

---

## 6. Cách hoàn tác (Rollback)

1. **Hoàn tác dữ liệu archive** (khôi phục chính xác 804 mẫu + 16 dataset về `ELIGIBLE`/`ACTIVE`): chạy file SQL sao lưu riêng `flow2_cleanup_data_rollback_20261122.sql` trong thư mục scratch của phiên làm việc.
2. **Hoàn tác schema migration** (chỉ sau khi đã hoàn tác code): chạy [`docs/flow2-google-drive/rollback-20261122100000.sql`](./rollback-20261122100000.sql).
3. **Tạm ngừng nạp/xếp job Flow 2 bất cứ lúc nào**: đặt `VIREAD_FLOW2_INGESTION_PAUSED=true` trong `backend/.env` và khởi động lại backend.
