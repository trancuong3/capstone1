# TASK 13 — Gallery chỉ những từ OCR đề xuất thay (riêng tư)

## Vì sao làm TASK 13?

TASK 12 đã được người dùng kiểm tra trên 10 ảnh thực tế với checkpoint
`FLOW1_EXTERNAL_TRDG` cố định. Baseline strict **CER 34/1647 = 0.020644**,
**WER 30/364 = 0.082418**. Ưu tiên Tesseract giảm còn **24/1647 CER** và
**20/364 WER**, nhưng thay 18 từ trong đó **12 sửa đúng, 3 sửa sai, 2
thay mà vẫn sai, 1 không chấm được theo vị trí**. Chính sách đồng thuận
Tesseract line + VietOCR crop đổi 5 lượt (**3 đúng, 1 sai, 1 chưa chấm**).
Không thể bật bất kỳ chính sách nào vào production khi vẫn có regression.

Không đưa người dùng quay lại cách khoanh từng từ. Tạo một HTML riêng tư
chỉ hiển thị các **vị trí dự định đổi**, cùng ảnh chụp cắt từ trang gốc,
văn bản OCR đang chọn, cách đọc Tesseract đề xuất và bằng chứng crop nếu
có. Hai chính sách trùng một vị trí chỉ tạo **1 ảnh crop**. Từ còn nguyên
không phải xem.

## Giới hạn kết luận

- `propose_text` chỉ dùng `ocr_evidence` của engine, không nhận GT.
- Chỉ **sau khi** đã có đề xuất, bản tham chiếu `pages.jsonl` mới được
  dùng để hiển thị và gắn nhãn ưu tiên kiểm tra.
- Nhãn `corrected`/`regressed` là **so theo vị trí trong reference**
  và chỉ khi số token khớp, không có thao tác thêm/bớt từ theo
  Levenshtein. Vẫn phải đối chiếu bằng mắt để xác minh.
- Nếu số token không khớp hoặc không thể căn chỉnh an toàn, luôn báo
  `ambiguous` và không tự điền một chữ ground truth đoán theo vị trí.
- Mỗi crop dùng tọa độ normalized của OCR gốc, không phải ground truth
  bounding box do người tạo. Vì thế cũng **không đo được IoU thực tế**.
- **Tuyệt đối không cập nhật production OCR, checkpoint, API, mô hình
  đánh giá trẻ đọc, Supabase hay Vercel** theo bảng này.
- Một mẫu 10 ảnh cùng bộ nghiên cứu không thay thế held-out độc lập.

## Chạy một lần trên máy Windows

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-tesseract-private-flip-review
& "F:\c1\capstone1-ocr-acceptance\backend\scripts\run_ocr_task13_flip_review.ps1"
```

Script tự động kiểm tra ba bộ unit tests, OCR trên 10 ảnh bằng checkpoint
và profile đang dùng, tạo thư mục riêng dưới
`F:\c1\ocr-private-eval\tesseract-flip-review-<timestamp>`,
rồi mở `index.html` trong trình duyệt. Nếu có lỗi hoặc thiếu ảnh,
script báo failure và không tuyên bố nghiệm thu.

Trong thư mục sẽ có:
- `index.html` — **RIÊNG TƯ**, chứa chữ OCR, đáp án và ảnh cắt.
- `crops/` — **RIÊNG TƯ**, ảnh nguồn cắt từ hộp OCR.
- `aggregate.json` — **CHỈ SỐ ĐẾM**, không chứa nội dung ảnh, chữ,
  GT hoặc đường dẫn riêng tư.

Không tải `index.html`, `crops/`, `pages.jsonl`, `.env`, hay bất kỳ
ảnh gốc nào lên GitHub, ChatGPT hoặc cloud. Chỉ gửi `aggregate.json`
nếu cần đánh giá số lượt đổi, nhãn sơ bộ và các lỗi.

## Tiêu chí kiểm tra cuối

Báo cáo này hỗ trợ người dùng **đối chứng** các đề xuất với ảnh, không
tự ký xác nhận ground truth. Với bất kỳ phương án sửa dấu thực tế nào,
cần nghiên cứu tập dữ liệu ảnh held-out mới (không dùng trong các TASK
09–13), đo strict CER/WER, số từ đang đúng bị phá hỏng và kiểm thử
đọc đúng/sai với màu phản hồi của trẻ.
