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

## Cập nhật trong cùng PR #187: ưu tiên lỗi và báo cáo rủi ro

Báo cáo HTML đã được người dùng chạy thực tế trên Windows: **10/10 ảnh**,
**18 vị trí** có ít nhất một đề xuất. Theo cách đếm theo vị trí của script,
chính sách Tesseract line gồm **12 sửa đúng, 3 làm sai từ đúng,
2 đổi nhưng vẫn sai, 1 chưa căn chỉnh được**. Chính sách xác nhận
Tesseract + VietOCR crop gồm **3 sửa đúng, 1 sửa sai, 1 chưa rõ**.

- Các đề xuất **regressed** (đang đúng → sai), sau đó **ambiguous**
  và **changed_other** được xếp trước các đề xuất corrected trong HTML.
  Trang có regression được hiển thị trước để người dùng xem ít hơn mà
  vẫn ưu tiên đánh giá rủi ro. Những nhãn này chỉ dựa trên văn bản
  tham chiếu, **chưa phải kết luận từ ảnh**.
- Báo cáo `aggregate.json` có thêm `risk_assessment`: số lượt phải
  kiểm tra, tỉ lệ sửa đúng và sửa sai theo **vị trí**; xuất mã lý do
  `not_independent_held_out`, `word_boxes_not_verified` cùng lý do
  có regression và căn chỉnh chưa rõ. Đây là **đánh giá an toàn nghiên
  cứu, không cấp quyền deploy**; `production_deployment_allowed=false`
  cho cả các trường hợp không thấy lỗi hồi quy trong bộ ảnh này.
- Kiểm tra `crop_artifact_count` khớp `distinct_positions` và tệp
  crop có nội dung trước khi tuyên bố báo cáo `complete=true`.
  Thiếu ảnh crop sẽ dừng script, không tự mở một gallery thiếu ảnh.
- Unit tests bổ sung kiểm tra tính toàn vẹn số đếm, dữ liệu lỗi, ảnh
  cắt bị thiếu và thứ tự ưu tiên sửa sai. **Các test mới cần chạy
  lại trên Windows**; kết quả lần chạy TASK 13 cũ không chứng minh
  các commit bổ sung mới đã pass.
- Không cần merge PR #187 để kiểm thử nhánh: Vercel Hobby đang giới hạn
  rate deployment và PR vẫn có thể được cập nhật trên cùng head branch.
  Thay đổi này chỉ là `backend/**` và không cần deploy frontend.

Sau khi `git fetch` và checkout lại nhánh PR #187 ở commit mới nhất,
chạy lệnh gốc `run_ocr_task13_flip_review.ps1`. Script in thêm phần
`POSITIONAL REVIEW RISK ASSESSMENT` trong terminal và viết bản
`aggregate.json` chỉ chứa số đếm trong thư mục private. Không gửi
HTML, ảnh crop hoặc tham chiếu riêng tư lên bất kỳ dịch vụ nào.

## Tiêu chí kiểm tra cuối

Báo cáo này hỗ trợ người dùng **đối chứng** các đề xuất với ảnh, không
tự ký xác nhận ground truth. Với bất kỳ phương án sửa dấu thực tế nào,
cần nghiên cứu tập dữ liệu ảnh held-out mới (không dùng trong các TASK
09–13), đo strict CER/WER, số từ đang đúng bị phá hỏng và kiểm thử
đọc đúng/sai với màu phản hồi của trẻ.
