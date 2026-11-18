# Báo cáo thiết lập Coding Agent trên Windows

Ngày kiểm tra: 2026-11-18  
Repo: `F:\c1\capstone1`  
Phạm vi: kiểm tra môi trường và skill; chưa sửa tính năng giao diện ứng dụng.

## Trạng thái công cụ

| Tên công cụ | Phiên bản | Đã cài/Chưa cài | Đã xác minh | Lỗi còn lại |
|---|---|---|---|---|
| Git | 2.55.0.windows.3 | Đã có | `git --version` thành công; Winget nhận diện `Git.Git` | Không. Không nâng cấp vì phiên bản hiện tại hoạt động. |
| Node.js | v24.19.0 | Đã có | `node --version` thành công; Winget nhận diện `OpenJS.NodeJS.LTS` | Không. Không thay Android toolchain. |
| npm | 11.17.0 | Đã có | `npm --version` thành công | Không. |
| npx | 11.17.0 | Đã có | `npx --version` thành công | Không. |
| Python | 3.12.10 (`py` launcher còn có 3.14.6) | Đã có | `python --version`, `py --version`; Python 3.12 chạy Graphify của repo | Không. |
| winget | 1.29.380 | Đã có | `winget --version` thành công | Không. |
| uv | 0.13.9 | Đã có qua Winget | `uv --version`, `uv tool list`; đường dẫn `.local\bin` và thư mục cài uv đã có trong PATH người dùng | Không. PATH của tiến trình Codex đang mở cũ; đã thêm đường dẫn vào phiên xác minh. Khởi động lại Codex/terminal để nhận môi trường mới. |
| Graphify / graphifyy | 0.9.112 | Đã có qua `uv tool` | `graphify --version`, `graphify --help`; `graphify-out/graph.json` tồn tại; truy vấn Graphify qua Python repo kết thúc exit code 0 | Không. Skill Codex hiện có nên không cài lại trùng. |
| RTK | 1.2.0 | Đã có qua Winget | `rtk --version`, `rtk gain`, `rtk init --global --codex --dry-run`, `rtk init --global --codex --show`; hook, `RTK.md` và tham chiếu global đều báo `[ok]` | Không. Cấu hình global đã tồn tại; dry-run không ghi file. Hook project chưa cài và được giữ nguyên. |
| Codex CLI | 0.169.0-alpha.11.1 | Đã có | `codex --version` thành công | Không. |
| Skills CLI | 1.9.0 | Dùng qua `npx` | `npx -y skills --help`, `npx -y skills ls -g` thành công | GitHub API bị giới hạn tốc độ một lần; CLI tự chuyển sang clone Git và hoàn tất cài đặt. |
| Ponytail | Không khóa phiên bản trong danh sách skill | Đã có global | Hiện trong `skills ls -g`; `SKILL.md` tồn tại | Không. |
| Unslop | Không khóa phiên bản trong danh sách skill | Đã có global | Hiện trong `skills ls -g`; `SKILL.md` tồn tại | Không. |
| Context Engineering | Không khóa phiên bản trong danh sách skill | Đã có global | `context-compression`, `context-optimization`, `filesystem-context` được liệt kê và có `SKILL.md` | Không. |
| Superpowers | Nhánh `main` của repo chính chủ | Đã có global qua junction | Remote là `https://github.com/obra/superpowers.git`; các skill lập kế hoạch, debugging, TDD và verification có `SKILL.md` | Không. Đã có nên không clone/cài thêm bản trùng. |
| Vercel React best practices | Skill upstream hiện hành | Đã cài global | `npx skills ls -g` và `SKILL.md` xác nhận | Không. |
| Web Design Guidelines | Skill upstream hiện hành | Đã cài global | `npx skills ls -g` và `SKILL.md` xác nhận | Không. |
| Figma design-to-code / Figma use | Figma plugin cache 20.0.0 | Đã có | Đã đọc hướng dẫn và dùng trong kiểm kê Figma desktop | Không. Codex cần làm mới skill discovery sau khi khởi động lại. |
| React Native skills | — | Chưa cài | Đã kiểm tra danh sách upstream; không chọn vì repo thực tế là Next.js web và phạm vi hiện tại loại trừ mobile | Không; bỏ qua có chủ đích. |
| GSD Core, Playwright, Agent Browser, Strix, Caveman | — | Chưa cài | Đánh giá theo điều kiện tùy chọn ở yêu cầu | Không; GSD/Playwright/Agent Browser không cần thêm cho lượt này vì đã có Superpowers và điều khiển trình duyệt CUA; Strix không cần; Caveman không cần để giữ nguyên tín hiệu lỗi. |

## Các lệnh đã chạy thành công

- Kiểm tra phiên bản: `git --version`, `node --version`, `npm --version`, `npx --version`, `python --version`, `py --version`, `uv --version`, `winget --version`, `codex --version`, `rtk --version`, `graphify --version`.
- Kiểm tra package đã có, không cài trùng: `winget list --id Git.Git -e`, `winget list --id OpenJS.NodeJS.LTS -e`, `winget list --id astral-sh.uv -e`, `winget list --id rtk-ai.rtk -e`.
- Kiểm tra Graphify: `uv tool list`, `graphify --help`, `\.venv\Scripts\python.exe -m graphify query "What are the main modules and dependencies?"`.
- Kiểm tra RTK: `rtk gain`, `rtk init --global --codex --dry-run`, `rtk init --global --codex --show`.
- Kiểm tra skills: `npx -y skills --help`, `npx -y skills ls -g`, `npx -y skills add vercel-labs/agent-skills --list`.
- Cài hai skill phù hợp web: `npx -y skills add vercel-labs/agent-skills -s vercel-react-best-practices -s web-design-guidelines -a codex -g -y` (exit code 0); sau đó liệt kê lại global và kiểm tra hai `SKILL.md`.
- Kiểm tra repo Superpowers hiện có: `git -C C:\Users\cuong\.codex\superpowers remote get-url origin`, `git -C C:\Users\cuong\.codex\superpowers status --short --branch`.

Các lệnh xác minh đều kết thúc exit code 0 sau khi thêm các thư mục cài đặt vào PATH của phiên lệnh. `uv`, `rtk`, Graphify và Codex không cần cài lại. Graphify và RTK không ghi đè cấu hình hiện có.

## Cấu hình, phê duyệt và phạm vi

- `F:\c1\capstone1\AGENTS.md` đã có hướng dẫn Graphify, RTK, đọc đúng phạm vi, sửa tối thiểu, bảo vệ dữ liệu riêng tư và không commit/push/deploy; không thêm đoạn trùng lặp.
- RTK global đã có hook và tham chiếu trong `AGENTS.md`. Lệnh dry-run cho biết không cần ghi file; không sửa `C:\Users\cuong\.codex\hooks.json`, `AGENTS.md`, `RTK.md`, cấu hình Codex hay `.codex\hooks.json` của repo. Vì không có file cấu hình nào bị sửa nên không tạo bản sao lưu cấu hình.
- Không cần thao tác quản trị, đăng nhập, cấp quyền hook hoặc phê duyệt nào trong các bước đã làm. Không đọc `.env`, `auth.json`, credential hay khóa riêng.
- Không cài dịch vụ/cloud trả phí; không chạy Strix; không cập nhật Android toolchain.
- Repo ban đầu đã có thay đổi backend và file untracked. Các thay đổi có sẵn được giữ nguyên; chưa chỉnh file tính năng frontend.

## Khởi động lại

Khởi động lại Codex để nạp danh sách skill global mới (Vercel React best practices và Web Design Guidelines) và làm mới PATH của tiến trình Codex đang mở. Không cần khởi động lại Windows.

## Nguồn chính thức đã kiểm tra

- Graphify: https://github.com/Graphify-Labs/graphify
- RTK: https://github.com/rtk-ai/rtk
- Skills CLI: https://github.com/vercel-labs/skills
- Vercel Agent Skills: https://github.com/vercel-labs/agent-skills
- Superpowers: https://github.com/obra/superpowers
