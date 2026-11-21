# TASK 08 — Tự động đọc OCR và tạo báo cáo để người dùng đối chứng

## Mục đích

Tránh yêu cầu người dùng kéo chọn từng từ trong 10 ảnh. Chạy OCR hiện tại
trên **10 ảnh gốc riêng tư**, tự tạo bản nháp **machine_proposed** cho toàn bộ
từ và hộp hợp lệ, tạo gallery HTML để người dùng **chỉ xem/đối chứng**.

Phương pháp này **không được xem là gán nhãn độc lập**. Không dùng
`machine-proposals.jsonl` làm ground truth để tính IoU nghiệm thu. Hệ thống
`load_manual_annotations` sẽ từ chối nhãn `machine_proposed`.

## Chạy một lần bằng PowerShell trên Windows

Mặc định bộ ảnh thật: `F:\c1\ocr-private-eval\pages.jsonl`.
Phải có 10 ảnh trong bộ private, mỗi ảnh có `ground_truth` đối chứng
dạng văn bản. Không dùng bộ ảnh tổng hợp của TASK 05 để tuyên bố chất lượng
trên ảnh chụp thật.

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" status --short
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/feat/ocr-private-auto-review-gallery

$py = "F:\c1\capstone1\.venv\Scripts\python.exe"
$backend = "F:\c1\capstone1-ocr-acceptance\backend"

# Tự kiểm tra mô-đun báo cáo trước khi chạy ảnh.
& $py -m unittest discover -s $backend -p "test_ocr_auto_review_gallery.py" -v
if ($LASTEXITCODE -ne 0) { throw "AUTO REVIEW TESTS FAILED" }

# Mọi đầu ra đều nằm ngoài repo trong thư mục private.
$private = "F:\c1\ocr-private-eval"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-ffff"
$out = Join-Path $private "auto-review-$stamp"
cd $backend

& $py scripts\ocr_auto_review_gallery.py `
  "$private\pages.jsonl" `
  --env-file "F:\c1\capstone1\backend\.env" `
  --min-pages 10 `
  --expected-profile FLOW1_EXTERNAL_TRDG `
  --expected-sha 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6 `
  --output-dir $out

if ($LASTEXITCODE -ne 0) { throw "AUTO REVIEW FAILED" }

# Tự mở báo cáo đối chứng toàn bộ 10 trang.
Start-Process (Join-Path $out "index.html")
```

## Có gì trong thư mục kết quả?

- `index.html` **RIÊNG TƯ**: gallery ảnh, mỗi khung OCR màu xanh, nội dung
  OCR, văn bản trong manifest, CER/WER từng trang, từ sai dấu/câu cần đối chiếu,
  số hộp bị lỗi và hộp giao nhau; rê chuột lên hộp để xem từ OCR. Mọi ảnh đều
  là dự đoán, không có nhãn do người gán.
- `previews/page_0001.png` ... `page_0010.png`: ảnh raster gốc thu nhỏ,
  không chồng chữ/hộp ngoài; overlay màu xanh được vẽ khi xem HTML.
- `machine-proposals.jsonl`: nhãn **gợi ý tự động chưa duyệt** với
  `annotation_source="machine_proposed"`, `reviewer_confirmed=false`.
  Đây là một bản snapshot **máy dự đoán**, không phải ground truth.
- `aggregate.json`: tổng hợp **không chứa ảnh, từ OCR, nội dung đối chứng
  hay đường dẫn riêng tư**. Có thể chia sẻ phần số để đánh giá tiếp.

Không gửi `index.html`, `machine-proposals.jsonl`, `previews`, ảnh gốc,
hoặc `.env` lên GitHub, chat hay bất kỳ cloud nào. Chỉ gửi `aggregate.json`
hoặc số liệu bảng tổng hợp. Người dùng có thể mô tả các trang cần sửa mà
không lộ ảnh/từ nguyên gốc.

## Ranh giới độ tin cậy

- `micro_cer` và `micro_wer` là *so sánh văn bản OCR với*
  `pages.jsonl.ground_truth`, không đo box IoU.
- Số box OCR và số token trong manifest khác nhau là dấu hiệu **cần xem**,
  không tự suy ra tất cả box sai.
- Số box giao nhau là cảnh báo hình học, không có nhãn độc lập nên không
  chứng minh một từ bị định vị sai.
- Trang không bị cảnh báo vẫn cần người dùng đối chứng trực quan.
- Không tự đánh dấu `manual_independent`, `reviewer_confirmed=true`.
  Muốn nghiệm thu IoU thật vẫn cần nhãn độc lập; có thể dùng GUI TASK 07 để
  chỉnh sửa **độc lập từ ảnh gốc**, không sao chép bộ machine-proposals.
- Không thay đổi checkpoint, engine contract, sản phẩm frontend/backend hay
  màu hỗ trợ trẻ đọc.
