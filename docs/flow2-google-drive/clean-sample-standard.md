# Tiêu chuẩn Mẫu sạch Flow 2 (Admin Verified) & Quy trình Nạp

## 1. Điều kiện nguồn ảnh được phép
- Chỉ sử dụng ảnh do chủ dự án cung cấp (`owner_supplied` / `owner_authorized`), có bản quyền hợp lệ (`licensed`), hoặc phạm vi công cộng (`public_domain`, `cc_by`, `cc0`).
- **Cấm** tải bừa sách/ảnh trên mạng chưa rõ quyền hoặc tái sử dụng ảnh từ `tests/fixtures/ocr/` / `ViRead_TASK05` (đã nằm trong `LOCKED_TEST`, sẽ gây rò dữ liệu).

## 2. Tiêu chuẩn chất lượng từng mẫu dòng chữ
1. **Xác minh nhãn bắt buộc**: `verification_status = "VERIFIED"`, `verification_source = "admin"`, `ai_review_required = false`, có `verified_by` và `verified_at`. Nhãn AI/chưa đối chiếu bị chuyển tự động sang `pending_review.jsonl`, không bao giờ vào pool train.
2. **Chính tả tiếng Việt chuẩn NFC**: giữ đúng dấu thanh, chữ `đ`/`Đ`, dấu câu và thứ tự đọc; không chứa ký tự điều khiển; độ dài `1..300` ký tự.
3. **Chất lượng ảnh dòng**: đọc được dạng RGB, kích thước tối thiểu `24x12 px`, tỷ lệ khung `>= 0.5`, độ tương phản `stddev >= 8.0`, độ nét `edge_variance >= 15.0` (loại ảnh trắng, mờ không đọc được, cắt mất chữ).
4. **Chống trùng & chống rò dữ liệu**:
   - SHA-256 ảnh PNG chuẩn hóa + SHA-256 nhãn NFC; loại trùng lặp trong batch và chặn xung đột nhãn.
   - Chặn tuyệt đối mọi ảnh hoặc `source_group_id` trùng với `LOCKED_TEST`.
   - Tách `train` / `validation` / `holdout` cố định theo `source_group_id` (cùng sách/tài liệu luôn nằm chung 1 split).

## 3. Định dạng tệp đầu vào JSONL
Mỗi dòng trong tệp `samples.jsonl` có cấu trúc:
```json
{
  "image_path": "lines/book01_p01_l00.png",
  "label": "Con mèo trèo cây cau.",
  "source_group_id": "authorized-book-01",
  "source_name": "Tên nguồn ảnh được phép",
  "rights_basis": "owner_supplied",
  "verification_status": "VERIFIED",
  "verification_source": "admin",
  "verified_by": "admin-uuid-or-email",
  "verified_at": "2026-11-22T03:00:00Z",
  "line_index": 0
}
```

## 4. Cách chạy công cụ nạp chuẩn (`scripts/flow2_clean_ingest.py`)
1. **Chạy thử chỉ đọc (Dry-run)**:
   ```powershell
   .\.venv\Scripts\python.exe scripts\flow2_clean_ingest.py --manifest path\to\samples.jsonl --pending-out pending_review.jsonl --dry-run
   ```
2. **Nạp thật lên Google Drive + đăng ký DB (idempotent) + tạo manifest mới**:
   ```powershell
   .\.venv\Scripts\python.exe scripts\flow2_clean_ingest.py --manifest path\to\samples.jsonl --pending-out pending_review.jsonl --build-manifest
   ```
   Chạy lại lệnh này lần 2 trên cùng dữ liệu sẽ tạo **0 bản ghi mới** (`skipped_existing = N`).
