# Đóng góp cho ViRead / ReadAlong Vision

Tài liệu này mô tả quy trình hiện được sử dụng trong
[trancuong3/capstone1](https://github.com/trancuong3/capstone1).
Repository **public** tại thời điểm kiểm tra 20/11/2026; xem
[README](README.md) để biết cách cài đặt. Public không có nghĩa là mã nguồn
đã được cấp một giấy phép OSS: chủ repository chưa chọn `LICENSE`.

## Chuẩn bị môi trường

- Git và tài khoản GitHub có quyền push branch / tạo PR khi cần đóng góp.
- Windows: Python 3.12 x64, Node.js >=22.13, npm 10+; xem `requirements.ps1`.
- Cấu hình `backend/.env` và `frontend/.env.local` từ các file
  `.env.example` tương ứng cho các luồng dùng API thật.
- Cần PostgreSQL/Supabase dev riêng, **không dùng credential production**.
- Frontend Next.js: `cd frontend; npm ci`.
- Backend FastAPI: `cd backend`, tạo virtualenv và cài
  `backend/requirements.txt`; entrypoint là `app.sever:app`.

## Nhánh và bảo vệ dữ liệu chưa commit

Nhánh mặc định và đích của GitHub Actions pull requests là **`main`**.
Không giả định có nhánh `develop`: kiểm tra refs hiện tại trước khi dùng.

```powershell
git status --short
git stash list
git fetch origin
git switch -c feature/ten-ngan origin/main
# Hoặc dùng fix/, docs/, chore/, test/
```

- Không reset hard, clean, stash pop, force push hoặc làm mất code local.
- Commit nhỏ, đúng phạm vi; mở PR vào `main`, không tự merge.
- Khi sửa cùng khu vực với PR còn mở, đối chiếu diff và tránh overwrite.
- PR bảo mật hoặc thay đổi cấu hình agent cần review riêng.
- Quy tắc bảo vệ nhánh cần được quản trị viên kích hoạt trong GitHub Settings;
  việc có CI không tự động ngăn direct push nếu repository chưa có Ruleset.

## Coding-agent / Graphify

Giữ nguyên: `AGENTS.md`, `backend/AGENTS.md`,
`frontend/AGENTS.md`, `.agents/`, `.agent-library/`,
`.codex/`, `skills-lock.json`, `.graphifyignore`.

Các output trong `graphify-out/` là AST/index/cache tự sinh, không phải
source-of-truth và được `.gitignore` bỏ qua. Khi thay đổi mã nguồn lớn,
người dùng Graphify tạo lại graph **ở máy của mình** theo hướng dẫn trong
`.codex/skills/graphify/SKILL.md`; không commit cache.

Không buộc xây graph cho một lookup nhỏ; dùng exact search khi biết symbol.
Khi thay đổi agent/skill/config hoặc vệ sinh repository, chạy:

```powershell
python scripts/validate_agent_config.py
```

Validator kiểm tra skill lock, các gateway, scoped AGENTS và việc không còn
file `graphify-out/` bị Git theo dõi.

## Kiểm thử trước khi mở PR

```powershell
cd frontend
npm ci
npm run verify
npm run build
npm run test:e2e
```

Backend (sau khi cài requirements và cấu hình môi trường test riêng):

```powershell
cd backend
python scripts/run_ci_tests.py
```

CI trên GitHub sử dụng PostgreSQL cô lập và kiểm tra strict real OCR bằng
`backend/scripts/run_real_ocr_gate.py`. Chạy gate OCR chỉ khi đã cài đầy đủ
runtime và các fixture; không tự tạo bằng chứng PASS khi môi trường thiếu.
Các workflow hiện có trong `.github/workflows/` là bằng chứng cụ thể của
bước test và các version đang dùng. Chạy lại các gate phù hợp sau mỗi sửa.

Không hạ assertion, cho qua lỗi bằng `continue-on-error` hoặc thêm skip
vô điều kiện để ép CI xanh. Nếu không chạy được, ghi rõ command, lỗi và phần
chưa kiểm chứng trong PR.

## Frontend / Backend invariants

- Giao diện: TypeScript, typed API services, trạng thái loading/error/empty,
  accessible focus/labels và hỗ trợ responsive.
- Đọc hướng dẫn scoped tại `backend/AGENTS.md` hoặc
  `frontend/AGENTS.md` trước khi sửa subtree tương ứng.
- Với FastAPI, bảo vệ bearer token và quyền chủ sở hữu ở backend/repository;
  không dựa riêng vào frontend route guard.
- Client không được tự đặt `role`, trạng thái xác minh, điểm số hoặc ID thuộc
  người dùng khác để thay đổi dữ liệu tin cậy.
- Không kết luận bé đọc sai khi không có bằng chứng hợp lệ.
- Không thay đổi ABI pin OCR, checkpoint production, RLS hay schema production
  trong PR chỉ sửa tài liệu.

## Bảo mật / quyền riêng tư

Không commit `.env`, private keys, Supabase secret/service-role key,
token, cookie, dữ liệu bé thật, signed URLs hoặc ảnh người dùng.
Không đưa những nội dung này vào log, screenshot hay PR description.

Nếu secret đã xuất hiện trong history: báo chủ dự án để rotate/revoke, không
lầm tưởng rằng xóa file ở commit mới sẽ xóa secret khỏi lịch sử Git.

## Nội dung Pull Request

Mỗi PR cần nêu: mục đích, file tác động, thay đổi contract (nếu có),
các test PASS/FAIL kèm CI link, giới hạn đã biết, ảnh chụp khi UI thay đổi,
rollback khi cần và xác nhận không sửa production/không xóa code local.

Giữ PR ở trạng thái Draft nếu đang điều tra, chưa review hoặc thiếu gate.
