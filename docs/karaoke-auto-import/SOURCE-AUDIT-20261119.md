# Rà soát source local — 2026-11-19

Các snapshot100/95 file bên dưới là lịch sử. Bàn giao mới gồm thêm công cụ
reference offline, test và tài liệu; phải dùng audit mới trước khi stage/commit.
Chủ dự án hiện đã cho phép commit/push/PR nháp, không merge hoặc rollout.
Xem [RELEASE](RELEASE.md) để phân biệt quyền bàn giao với chất lượng NOT_VERIFIED.

## Snapshot bàn giao sau quyết định bỏ qua benchmark

Tập bàn giao106 paths được kiểm lại bằng cùng công cụ trước stage/commit;
bằng chứng private ở `.cache/karaoke-benchmark/source-audit-release-final-20261119.json`.
Runtime/test runtime không đổi hash so với snapshot100 đã qua full regression.
Migration chỉ bỏ khoảng trắng cuối dòng sau khi staged diff phát hiện; diff bỏ
qua whitespace rỗng, không đổi SQL. Phần thêm là công cụ/test reference và tài liệu, gồm
runbook migration-before-backend, rollback giữ review gate và kiểm kê Storage
không bỏ sót jobs/operations/reference. Kiểm lại30/30 tests liên quan đạt.

Quét không phát hiện media/weights/env thật, protected-file change, file không
đọc được hoặc mã migration trùng; chỉ có ba candidate fixture đã phân loại bên
dưới. Đây là pattern screening trên pending files, không phải chứng nhận không
có secret trong toàn bộ repository/history hoặc nghiệm thu chất lượng nhạc.

Bước chuẩn bị bàn giao, không phải tuyên bố hoàn tất Phase6 hoặc cho phép rollout.
Không thay application code, không stage/commit/push, không ghi DB/Storage.

## Snapshot mới sau các bản sửa19/11

Lượt rà soát sau cùng gồm100 pending paths, cả tracked và untracked, trên cùng
nhánh/baseline. Báo cáo private
`.cache/karaoke-benchmark/source-audit-review-final-20261119.json` ghi hash theo
nội dung lúc chụp. Không có media/weights/env thật, migration version trùng hoặc
thay đổi protected dependencies/AppShell/API-client trong tập kiểm. Ba match
vẫn là fixtures đã phân loại bên dưới; không xóa test để làm rỗng kết quả.

Full frontend mới là1.981 tests đạt và full backend1.068 tests OK/38 skipped,
không phải mốc1.962 bên dưới. Xem [VERIFICATION](VERIFICATION-20261119.md).
Audit không chứng minh tương thích origin/main mới, license bài hát, chất lượng
timing hoặc quyền rollout. Chưa stage/commit/push và không thay dữ liệu thật.
Các mục sau đây giữ snapshot95 file cũ, không phải hash của lượt cuối.

## Phạm vi đã thực sự kiểm

Đọc danh sách tracked changes so với HEAD và mọi untracked file không bị Git
ignore trên nhánh `feature/linh-karaoke-auto-import`. Snapshot95 file, cả95 đọc
được dưới dạng UTF8, không file vượt1MiB hoặc bị bỏ qua vì lỗi đọc.
Quét private-key headers, mẫu Google/GitHub/Supabase server secret, JWT,
signed URL và literal credential. Output chỉ vị trí/loại, không ghi giá trị match.

- Không có MP3/WAV/OGG/FLAC, model weights/archive hoặc `.env` thật trong snapshot.
- Không có thay đổi ở backend requirements, frontend package/lock hoặc các file
  AppShell/API-client được kiểm riêng. Paths của snapshot đều thuộc karaoke hoặc
  wiring chung cần thiết; router chỉ thêm import/include router karaoke processing,
  model registry chỉ thêm import jobs/operations.
- Không có migration version trùng khi kiểm tên tất cả file SQL trong migrations.
- `git diff --check` đạt cho tracked diff. Không reset/revert thay đổi người dùng.

## Ba kết quả đã phân loại

| Vị trí ở snapshot                                    | Quan sát không lộ giá trị                                                                     | Phân loại                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| backend/test_karaoke_postgres_integration.py:134     | Fake Storage.sign trả URL ở example.supabase.co, query token placeholder                      | Fixture, không phải URL Storage thật                   |
| backend/test_karaoke_processing.py:107               | patch.object thay hàm ký URL bằng URL example.supabase.co                                     | Fixture trong test HTTP, không phải phát hiện URL thật |
| frontend/test/karaoke-processing-services.test.ts:21 | getSession mock trả token literal9 ký tự, chỉ từ chữ thường/gạch nối, có marker fixture/token | Fixture auth, không phải JWT/provider key              |

Không sửa hoặc bỏ các test chỉ để kết quả quét trống. Không thấy match mẫu
credential thật trong tập đã quét; đây không phải bảo đảm không có secret.

## Artifact và giới hạn

Báo cáo local `D:\Project\capstone1_readalong_vesiion\.cache\karaoke-benchmark\source-audit-20261119.json`
có danh sách/hash95 file và các vị trí match. Snapshot được chụp trước tài liệu
audit này; không gọi đó là kiểm mọi thay đổi có thể xảy ra sau thời điểm chụp.
Không quét `.env`/files bị ignore hoặc toàn bộ Git history; không kiểm quyền
bản nhạc, chi phí, sức khỏe worker, cấu hình đích hoặc tài khoản thật.

Nguồn benchmark đủ quyền, lời/reference, chất lượng căn lời, nghe duyệt và live
acceptance vẫn chưa đạt như STATUS. Không bật tính năng hoặc dùng audit này để
vượt các cổng chất lượng hoặc quyền triển khai. Bộ frontend1.962 là lịch sử;
lượt runtime cuối1.981 đã ghi ở đầu tài liệu, không chạy lại chỉ vì thêm Markdown.
