# TASK 14 — Kiểm thử OCR sửa dấu bằng ảnh độc lập (chỉ ngoại tuyến)

## Tại sao không tiếp tục dùng 10 ảnh cũ?

Ở `index(3).html` và `index(4).html`, cùng bộ OCR hiện tại vẫn
đề xuất **18** vị trí khi ưu tiên Tesseract, gồm **13 sửa đúng theo
căn chỉnh duy nhất, 3 làm sai từ vốn đúng, 2 đổi nhưng vẫn sai**.
Chính sách `tesseract_line_vietocr_crop_agreement` đổi 5 vị trí:
**4 sửa đúng, 1 làm sai**. Các con số là **đối chiếu văn bản bằng
thuật toán**, không phải ground truth hình ảnh đã được xác minh độc lập.

Tăng số lần chạy 10 ảnh cũ không chứng minh được cải thiện OCR.
Phải giữ chính sách bất biến khi đo trên **ảnh và nội dung chưa dùng
để thiết kế chính sách**.

## Chuẩn bị dữ liệu held-out HOÀN TOÀN RIÊNG TƯ

Tạo một bộ mới dưới
`F:\c1\ocr-private-eval\heldout\pages.jsonl`, ít nhất **20 ảnh**
(ưu tiên nhiều hơn, gồm phông trẻ em, chữ nhỏ, nghiêng, thiếu sáng,
bóng, nhiễu và ảnh chụp thật từ nhiều thiết bị khác nhau). Không dùng
lại ảnh/đáp án của 10 trang gốc, không biến đổi ảnh cũ để giả làm mới.

Manifest dùng schema như benchmark đã có, mỗi dòng một object:

```json
{"image":"photos/page_new_001.jpg","ground_truth":"<NHẬP THỦ CÔNG NGUYÊN VĂN TRÊN ẢNH MỚI>","condition":"childrens_font"}
```

Đường dẫn ảnh tương đối với thư mục chứa `pages.jsonl`.
Phần `ground_truth` phải do người đọc ảnh thật tạo hoặc kiểm tra
độc lập với OCR của ViRead/Tesseract/VietOCR/PaddleOCR. Không
chấp nhận chép lại OCR đang kiểm thử để làm đáp án.

**Không gửi manifest, ảnh, chữ, crop, `.env` lên GitHub, ChatGPT,
Vercel hoặc các dịch vụ cloud.** Việc kiểm thử chỉ chạy trên máy bạn.

## Bước kiểm tra độc lập

`ocr_tesseract_holdout_audit.py` kiểm tra trước inference:

- SHA-256 byte ảnh của cả hai tập, từ chối ảnh trùng nội dung,
  kể cả khác tên file, và ảnh trùng trong tập held-out.
- SHA-256 toàn bộ `ground_truth` đã normalize (NFC/khoảng trắng),
  từ chối trang cùng văn bản giữa hai tập và giữa các ảnh mới.
- Hai manifest nằm ở **hai thư mục riêng** ngoài Git.
- Từ chối nếu thiếu trang/không đạt `--min-heldout-pages`.
- Không in, lưu hay commit SHA riêng của ảnh hoặc ground truth.
  Kết quả chỉ hiển thị số lượng, không chứa văn bản/đường dẫn.

Điều này chỉ chứng minh **không trùng byte ảnh và toàn văn**
trong những tập được cung cấp. Không phát hiện ảnh near-duplicate
như chụp lại trang cũ, crop, resize hoặc ảnh cùng sách; cũng không
xác minh nguồn ảnh thật hay quy trình chấm đáp án.

## Đánh giá bằng checkpoint và chính sách đã đóng băng

Sau preflight, `ocr_tesseract_holdout_runner.py` dùng **chính
`ocr_tone_blind_policy_runner.evaluate`** như TASK 12 (không
thay đổi inference), xác nhận:

- Profile `FLOW1_EXTERNAL_TRDG`.
- Checkpoint SHA
  `200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6`.
- Baseline strict CER/WER, cùng hai chính sách Tesseract line.
- Đếm số đề xuất sửa, số sửa đúng/sửa sai theo vị trí (cảnh báo
  các trường hợp chưa thể đối chiếu đúng vì token lệch), số trang
  WER tăng/giảm/giữ nguyên.

**Không dùng các ngưỡng CER/WER 34/1647 hay 30/364 từ ảnh cũ
để kiểm tra bộ ảnh mới**; mẫu số và độ khó của tập mới khác nhau.

Kết quả `aggregate-heldout-*.json` chỉ gồm các số, cờ kiểm tra
tính trùng lặp và mã lý do từ chối production.
`production_deployment_allowed=false` luôn luôn, ngay cả khi
không phát hiện hồi quy trên một tập nhỏ. Cần đánh giá provenance,
kiểm tra ảnh/bbox và kiểm thử đánh giá giọng đọc trẻ em riêng biệt.

## Chạy trên PowerShell (khi ĐÃ có ảnh mới)

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-tesseract-private-flip-review
& "F:\c1\capstone1-ocr-acceptance\backend\scripts\run_ocr_task14_holdout.ps1"
```

Script chạy 4 nhóm unit tests trước, rồi kiểm tra dataset mới.
**Nếu thiếu ảnh mới, script dừng với lỗi có chủ đích, không dùng
10 ảnh cũ làm bộ held-out và không in kết quả nghiệm thu giả.**

Có thể chạy riêng module test không cần ảnh:

```powershell
& "F:\c1\capstone1\.venv\Scripts\python.exe" -m unittest discover -s "F:\c1\capstone1-ocr-acceptance\backend" -p "test_ocr_tesseract_holdout_audit.py" -v
```

TASK 14 là **khuôn kiểm thử nghiên cứu**, không yêu cầu đóng/mở
PR mới. Tất cả thay đổi được cập nhật trên PR #187. Không merge,
không tự deploy và không bật chính sách sửa dấu ở production khi
còn regression hoặc chưa có kiểm chứng độc lập.
