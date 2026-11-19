# Karaoke auto-import — bàn giao source và giới hạn triển khai

## Quyết định của chủ dự án, 2026-11-19

Cho phép bỏ qua bước benchmark/reference độc lập/nghe duyệt đang chờ để làm
phần tiếp theo; cho phép commit, push `feature/linh-karaoke-auto-import` và tạo
PR nháp. Không tự merge, triển khai Supabase, bật tính năng hay xuất bản bài.
Đây là bàn giao kỹ thuật có giới hạn, không phải hoàn tất chất lượng toàn đặc tả.
Các ghi nhận cũ yêu cầu chờ benchmark trước commit không còn là quyết định mới nhất.

- Chất lượng căn lời/tách nhạc: **NOT_VERIFIED**, không báo PASS hoặc accuracy.
- Có 8 ứng viên ELLA phi thương mại; chưa có reference người nghe/nghiệm thu.
- PhoWhisper là probe offline, không phải engine được tích hợp để thay runtime.
- Không đưa MP3, model weights, dữ liệu thật, secret hoặc cache nghiên cứu vào Git.
- Không bỏ yêu cầu nguồn/quyền sử dụng, nghe duyệt từng bài, xử lý cảnh báo hoặc
  kiểm tra revision/content fingerprint trước khi xuất bản.

## Phần code được bàn giao

Wizard tải MP3 có vocal và dán lời, autosave theo hàng đợi, xử lý job nền,
tách nhạc/căn lời thành candidate v2, kiểm tra cảnh báo và chỉnh mốc trong
editor. Có idempotency, quota, lease/fencing, cache theo version và kiểm tra
quyền/revision khi áp dụng kết quả. Candidate không tự trở thành bài xuất bản.
Luồng thủ công và bài đã xuất bản vẫn được giữ; không đổi auth/OCR/đọc sách.

Mặc định `KARAOKE_PROCESSING_ENABLED=false`,
`KARAOKE_PROCESSING_WORKER_ENABLED=false`; hạn mức mặc định không cho chạy job.
Wizard chỉ mở tự động khi API capabilities cho phép. Không bật flags chỉ để
thấy giao diện hoặc coi job chạy xong là đã nghe duyệt.

## Bằng chứng kỹ thuật và phần chưa kiểm

- Full backend: 1.068 tests, OK, 38 skipped trên DB loopback disposable.
- Full frontend: 120 file, 1.981 tests đạt; format/typecheck/build đạt,
  lint 0 errors và 13 warnings đã ghi nhận ngoài phạm vi.
- Công cụ reference/evaluator bổ sung: 18/18 tests; không sinh annotation giả.
- Kiểm lại trước commit: 30/30 tests reference/evaluator, contract flags tắt,
  review fingerprint và mã migration đạt; không kết nối Supabase thật.
- Runtime và test runtime giữ nguyên hash so với audit full regression. Migration
  chỉ bỏ khoảng trắng cuối dòng; diff bỏ qua whitespace rỗng, không đổi SQL.
  Phần thêm còn lại là tài liệu và công cụ/test reference offline.
- Snapshot ghép thử với `origin/main` tại `90f7725f37d0a48a63607fd834043a8add299ebf`
  đã qua 115 backend tests (7 skipped), 192 frontend tests và typecheck.
  Đây không phải merge trên nhánh thật, full CI hoặc bằng chứng main luôn mới nhất.
  Fetch lúc bàn giao thấy `origin/main` đã tới
  `93ec8d3de413131b107f9f817e4703b6cfea00f1`; chưa chạy lại snapshot trên base này.
- Nhánh thật chưa nhập main tại mốc snapshot; `warm-routes.ts` có xung đột trong
  lần ghép thử. Phải kiểm lại base/head và giải quyết trước merge.
- Chưa nghiệm thu live auto-import, chưa rollout, chưa xác nhận chất lượng nghe.

Không cộng số test có overlap. Log/hash chi tiết:
[VERIFICATION](VERIFICATION-20261119.md),
[MAIN-COMPATIBILITY](MAIN-COMPATIBILITY-20261119.md),
[ELLA-CALIBRATION](ELLA-CALIBRATION-20261119.md).

## Thứ tự triển khai — cần quyền riêng, chưa thực hiện

1. Duyệt PR và CI trên đúng head/base; xác nhận môi trường, backup và quyền
   triển khai với chủ project. Không dùng quyền commit/PR để ghi database.
2. Thử migration trên DB tạm, đối chiếu schema/history của đích. Áp dụng đúng
   `supabase/migrations/20261117060000_add_karaoke_processing.sql` qua quy trình
   migration của nhóm, không chạy reset hoặc toàn bộ migration cũ.
3. **Migration phải xong trước khi triển khai backend mới, kể cả flags tắt.**
   ORM/query mới đọc cột reference/review và bảng processing không phụ thuộc
   hoàn toàn vào feature flag. Tắt flag không làm backend mới tương thích schema cũ.
4. Triển khai backend có review gate, rồi frontend tương ứng, giữ cả hai flags tắt.
   Kiểm tra luồng karaoke thủ công và bài đang xuất bản trước.
5. Chuẩn bị engine riêng, đúng pinned weights/giấy phép, tài nguyên, quota và
   giám sát worker theo [README engine](../../ai/karaoke_processing/README.md).
   Chạy readiness; không coi các mục NOT_CHECKED/NOT_VERIFIED là đạt.
6. Chỉ bật thử nghiệm có kiểm soát khi được chủ dự án cho phép rõ ràng về môi
   trường và chấp nhận giới hạn chất lượng. Trước cung cấp rộng rãi phải giải
   quyết lại benchmark/nghe duyệt đã hoãn và live acceptance.
7. Với mỗi bài: xem candidate, sửa mốc/cảnh báo, nghe đúng nội dung đã lưu,
   xác nhận review rồi chủ động xuất bản. Sửa nội dung sau review cần duyệt lại.

## Dừng/rollback an toàn

Tắt nhận job mới và dừng worker qua supervisor có graceful shutdown; giữ dữ
liệu job/operation để đối soát. Không xóa bảng, sửa migration history hoặc dọn
Storage theo prefix. Giữ backend có review gate nếu đã có nháp auto-import:
backend trước tính năng này không biết cờ bắt buộc review, nên rollback code
cũ rồi tiếp tục cho admin publish có thể bỏ qua chốt duyệt mới. Nếu bắt buộc
rollback backend, phải có kế hoạch chặn publish và đối soát các nháp được duyệt
riêng trước; không tự thực hiện trong lượt bàn giao này.

Kiểm kê Storage phải gồm toàn bộ version, reference audio, input/result của
mọi job và `artifact_paths` của mọi operation, kể cả trạng thái kết thúc/UNKNOWN.
Commit/upload mơ hồ thì giữ object. Xem [KARAOKE_SETUP](../../KARAOKE_SETUP.md);
không có thao tác xóa dữ liệu được cấp quyền trong bàn giao này.
