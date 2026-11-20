# Kiểm tra tích hợp cục bộ với main, 19/11/2026

## Phạm vi và kết luận

Đã dựng bản sao riêng của `origin/main` đã fetch ở
`90f7725f37d0a48a63607fd834043a8add299ebf`, ghép 104 file đang làm từ nhánh
`feature/linh-karaoke-auto-import` dựa trên `d4402915126ffcb5f26eca710d4d381e2841de31`.
Không fetch mới trong lượt này, không đổi branch/index/worktree nguồn, không
commit, rebase, merge thật, push hoặc gọi CI. Đây là bằng chứng tích hợp hẹp,
không thay thế nghiệm thu toàn hệ thống hoặc quality gate của model.

Bản sao nằm ngoài repo ứng dụng tại workspace nghiên cứu:
`.cache/karaoke-main-compatibility-20261119/merged/`.
Chỉ lấy file tracked từ Git và thay đổi source đã kiểm; không chép `.env` thật,
model, audio riêng hoặc venv. Snapshot chỉ có `.env.example`. Dependency frontend
dùng junction tới node_modules hiện có; package-lock SHA256 ở hai nơi bằng nhau:
`35f34dfca8ccb9add3eb6ab5cc564e3a45f83aa0b188b3dd708d92784b1b4b7a`.
Không cài/nâng dependency hay thay đổi backend/OCR venv.

## Hai file giao nhau với main

- `backend/app/models/__init__.py`: three-way merge tự động giữ được import
  KaraokeProcessingJob/Operation và hai model mới của main. Không xung đột.
- `frontend/test/browser/warm-routes.ts`: xung đột ở đoạn thêm route admin.
  Main đã có đủ ba route karaoke cùng các route mới và route filter. Bản sao
  thử nghiệm giữ phiên bản main, tránh nhân đôi hoặc làm mất route của nhóm.
  Route edit dùng ID fixture111… thay vì biến book333…; cùng dynamic route.

Cách xử lý trên **chỉ nằm trong bản sao**. Khi thực hiện merge thật vẫn phải
xem diff hiện hành và xác minh lại, không dùng bản sao này ghi đè toàn repo.

## Kiểm chứng trên bản sao đã ghép đúng

| Kiểm tra                                                              | Kết quả                                             |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| Backend karaoke/schema/API/mapper/client/review và migration versions | 115 tests chạy, 0 failure/error, 7 skipped, 20.323s |
| Next route typegen                                                    | Đạt                                                 |
| Frontend toàn bộ `tsc --noEmit` theo tsconfig của bản sao             | Đạt, exit0                                          |
| Frontend nhóm karaoke liên quan                                       | 11 files, 192/192 tests đạt, 59.84s                 |
| Hash các file gốc trước/sau dựng và chạy kiểm tra                     | Không file nào trong 104 file nguồn bị thay đổi     |

Backend dùng DB URL loopback port1, Supabase example, feature/worker false và
test doubles; không chạy PostgreSQL/Supabase integration trong lượt này. Không
tính bảy skipped là đã kiểm môi trường thật. Nhóm backend gồm karaoke legacy,
syllables, processing API/contract/worker/review, alignment, evaluator, local
client, reference worksheet, transcript metric và uniqueness migration.

Frontend gồm wizard, processing/poll/status/library/services, autosave, repeat
lyrics, admin legacy, syllable player và lyrics parser. Test-only config giữ
config gốc, đặt cache Vite vào snapshot và dùng configLoader runner để không
ghi cache qua junction node_modules. Không giảm assertion hoặc nới typecheck.

Lần dựng đầu Git tìm repository cha nên bỏ qua patch tracked dù lệnh trả0;
test khi đó thiếu phần sửa đã tracked. Đã xác định đây là lỗi harness, tạo Git
root riêng, apply lại và so nội dung20 file tracked không giao nhau với nguồn
trước khi chạy lại. Hai file giao nhau kiểm riêng bằng three-way. Kết quả bảng
trên chỉ từ lượt đã sửa harness; không quy lỗi của bản sao thiếu patch cho app.

## Artifacts và giới hạn

Trong thư mục snapshot cha có `snapshot-manifest.json` (104 source hashes) và
`verified-results.json` (kết quả/giới hạn), cùng các log:

- `backend-corrected-overlay.log`: SHA256
  `440437728017c214ad1265d4565f65705ef6ebdd9eb67f46654454968795acd2`.
- `typecheck-corrected-overlay.log`: rỗng, exit0 đã quan sát; SHA256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `frontend-corrected-overlay.log`: SHA256
  `97b88888d006c6bdefe0367d88ad91f031ac1ad22210dad18ba6ef36ef61fafe`.

Chưa chạy full suites/build/browser E2E/CI trên bản ghép, chưa deploy hay áp
dụng migration đích. Full-suite trên nhánh baseline cũ vẫn là evidence riêng;
không cộng số test hoặc mô tả thành CI của main đã xanh. Gate còn thiếu là
benchmark có reference độc lập, mục tiêu chất lượng đạt, nghe duyệt, live
acceptance và bàn giao/rollout đúng quyền. Xem [STATUS.md](STATUS.md).
