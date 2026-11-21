# TASK 07 — Gán nhãn bounding box độc lập trên ảnh chụp thật

**Mục tiêu:** gán nhãn *thủ công* từ và hộp trên những ảnh gốc trong
`F:\c1\ocr-private-eval\pages.jsonl`, sau đó dùng lại evaluator IoU của TASK 05.
Không thay đổi model, pipeline OCR hoặc schema production.

**QUAN TRỌNG:** Bộ ảnh `ViRead_TASK05_mau_10_anh_IoU.zip` là **ảnh tổng hợp**,
không phải ảnh sách chụp thật. Tuyệt đối không đánh dấu chúng là
`manual_independent` chỉ vì có hộp renderer-generated. Công cụ desktop chỉ
ghi nhận lời xác nhận của người gán nhãn, KHÔNG tự kiểm chứng tính độc lập
hoặc nguồn gốc ảnh.

## Chuẩn bị

Mở PowerShell, lưu/commit mọi thay đổi chưa commit nếu có trong worktree OCR
trước khi chuyển nhánh. Đừng sử dụng `git reset --hard` hoặc `git clean`.

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" status --short
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-private-photo-manual-annotator

$py = "F:\c1\capstone1\.venv\Scripts\python.exe"
$backend = "F:\c1\capstone1-ocr-acceptance\backend"
cd $backend

# Pure annotation state/CLI tests; no GPU or real photos needed.
& $py -m unittest discover -s $backend -p "test_ocr_manual_annotation_store.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_photo_manual_annotator.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_word_box_iou.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_word_box_iou_acceptance.py" -v
```

## Mở trình gán nhãn trên máy Windows

```powershell
& $py scripts\ocr_photo_manual_annotator.py "F:\c1\ocr-private-eval\pages.jsonl"
```

Trình desktop dùng **Tkinter** (Python có sẵn trên Windows) và **Pillow** đang
có trong môi trường OCR. Ảnh được mở cục bộ bằng Pillow; ứng dụng không gọi OCR,
Supabase, API, web server hoặc cloud.

Khi mở lần đầu, chương trình tạo bản nháp riêng tư:
`F:\c1\ocr-private-eval\bbox-annotations-ui-draft.jsonl`.
Mỗi lần mở sau sẽ nạp lại và lưu tiếp bản nháp đó. Nó không chỉnh sửa
`pages.jsonl`, bản benchmark hay `.env`, và không đụng vào tệp nhãn final.

Nếu muốn nạp lại bản nháp chưa gán nhãn do TASK 05 tạo (chỉ khi nó là bản
nháp của ảnh THẬT, chưa sao chép kết quả model), bạn có thể chỉ định:

```powershell
& $py scripts\ocr_photo_manual_annotator.py `
  "F:\c1\ocr-private-eval\pages.jsonl" `
  --draft "F:\c1\ocr-private-eval\bbox-annotations-draft-YYYYMMDD-HHMMSS.jsonl"
```

Thay `YYYY...` bằng tên thật. Không chọn tệp final đã xuất để tiếp tục sửa.

### Thao tác

1. Tự đọc **ảnh sách gốc** từng trang, không xem dự đoán OCR trước khi gán
   nhãn. Công cụ không hiển thị hộp dự đoán để tránh làm sai lệch nhãn.
2. Dùng chuột **kéo một hình chữ nhật quanh một từ**, bao đủ các dấu tiếng
   Việt, nhưng không thêm padding tùy ý; nhập chính xác từ nhìn thấy.
   Mỗi hộp chứa **một token**, giữ nguyên chữ hoa/thường, `đ`, dấu và dấu câu.
   Không dùng hộp renderer hoặc dự đoán OCR làm đáp án.
3. Chọn nhãn ở danh sách bên phải để sửa/xóa, dùng ↑ ↓ để giữ thứ tự đọc.
   Dùng Phóng to/Thu nhỏ để chỉnh khung thuận tiện.
4. Sau khi đã gán nhãn **tất cả** từ và soát lại từ/câu/từng trang, chọn
   **Xác nhận đã đối chiếu ảnh gốc**. Chỉ nhấn nếu thật sự xác minh từng từ.
   Nếu số từ khác số token manifest, ứng dụng cảnh báo; người dùng phải
   tự đối chiếu để quyết định trường hợp hợp lệ. Không tự thay nhãn bằng truth.
5. Lặp cho toàn bộ 10 trang. Tệp bản nháp tự lưu sau mỗi thao tác. Thao tác
   sửa/xóa/đổi thứ tự sẽ **hủy xác nhận duyệt** của trang đang thay đổi.
6. Khi mọi trang đã được xác nhận, nhấn **Xuất JSONL**. Công cụ tạo tệp
   `bbox-annotations-manual-<timestamp>.jsonl` mới, không ghi đè tệp cũ.

Nếu chương trình bị đóng bất thường, tệp `.lock` có thể còn sót lại.
Chỉ xóa `bbox-annotations-ui-draft.jsonl.lock` sau khi chắc chắn không có
cửa sổ gán nhãn nào đang chạy. Không xóa tệp `*.jsonl` đang chứa bản nháp.

### Về hệ tọa độ

Công cụ lưu `[x,y,width,height]` theo **raster ảnh gốc không xoay EXIF**,
chuẩn hóa về [0,1], phù hợp OpenCV trong OCR. Nếu ảnh chứa EXIF orientation
khác 1, chương trình cảnh báo. Hãy kiểm tra hướng ảnh trước khi gán nhãn.

Nhãn từ phải bao hình chữ nhìn thấy, kể cả dấu mũ, sắc, hỏi, ngã, nặng;
tránh đóng khung thêm khoảng trắng tùy ý, vì thí nghiệm ảnh tổng hợp TASK 06
đã cho thấy padding làm sai khác IoU đáng kể.

## Đo IoU thật sau khi tự gán nhãn

```powershell
$latest = Get-ChildItem "F:\c1\ocr-private-eval" `
  -Filter "bbox-annotations-manual-*.jsonl" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $latest) { throw "Chưa có nhãn thủ công đã duyệt cho 10 trang." }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-ffff"

& $py scripts\ocr_word_box_iou_acceptance.py `
  "F:\c1\ocr-private-eval\pages.jsonl" `
  --bbox-annotations $latest.FullName `
  --env-file "F:\c1\capstone1\backend\.env" `
  --min-pages 10 `
  --expected-profile FLOW1_EXTERNAL_TRDG `
  --expected-sha 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6 `
  --output "F:\c1\ocr-private-eval\aggregate-real-photo-iou-$stamp.json"

if ($LASTEXITCODE -ne 0) { throw "Manual IoU benchmark failed" }
```

Chỉ chia sẻ các số tổng hợp từ `aggregate-real-photo-iou-*.json`; không
chia sẻ ảnh, nhãn `bbox-annotations-*.jsonl`, dự đoán OCR có text,
`.env`, screenshot chứa trang sách hay tệp `.lock`.

**Giới hạn:** Ngay cả khi runner báo `all_runtime_checks_passed=true`,
nguồn gốc ảnh và tuyên bố gán nhãn độc lập vẫn cần kiểm toán ngoài chương
trình. IoU 0.50/0.75 chỉ đo box, không chứng minh màu xanh/vàng/đỏ khi trẻ
đọc chính xác. Kiểm thử màu và vùng tương tác là một acceptance track riêng.
