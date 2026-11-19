## Automatic Skill Routing

For every non-trivial task, automatically use the repository skill system even when the user does not mention any skill name.

Rules:
- Start with the project skill `viread-skill-router` to classify the task domain and choose the smallest relevant skill set.
- Do not ask the user which skill to use when the task domain is clear.
- Match skills by their name/description first; read full `SKILL.md` only for selected skills.
- Never load all installed skills "just in case"; this project optimizes for low token usage.
- For codebase tasks, Graphify remains the discovery layer and must run before broad grep/search/source reads when `graphify-out/graph.json` exists.
- Prefer project-specific `viread-*` skills over overlapping generic skills when both cover the same behavior.
- Add domain skills only as needed, for example:
  - FastAPI/backend: `fastapi`, `fastapi-expert`.
  - Supabase/Postgres: `supabase`, `supabase-postgres-best-practices`.
  - Auth/security: `auth-implementation-patterns`, `secure-code-guardian`, `owasp-top-10`.
  - React/Next.js: `nextjs-app-router-patterns`, `vercel-react-best-practices`.
  - UI/Figma: `figma-design-to-code`, `frontend-design`, `ui-ux-pro-max`.
  - Vietnamese OCR: `viread-ocr-vietnamese` / `viread-vietnamese-ocr`.
  - Child reading/speech: `viread-reading-assessment`.
  - Android/APK: `viread-android-apk`, `viread-android-build`.
  - Debugging: `systematic-debugging` plus the relevant domain skill.
  - Tests: select only the testing skill(s) for the affected layer.
- Before declaring source-code work complete, use both `viread-quality-gate` and `verification-before-completion`.
- After relevant source changes, run `graphify update .`.
- When resuming after token/rate-limit recovery, use `.codex/skills/graphify/PROJECT_STATE.md` and the continuation protocol instead of rediscovering completed work.


## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. When the answer is under a Markdown heading, `graphify section "<heading>"` prints that section's text, so the .md need not be opened. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## Graphify execution on Windows
- Always run Graphify through the project Python environment.
- Use `.\.venv\Scripts\python.exe -m graphify` instead of `graphify`.
- Query the graph before reading large amounts of source code.
- Keep queries specific and use small token budgets by default.
- Rebuild the graph after relevant source changes.
- Do not disable Windows Application Control.

## ViRead Architecture & Critical Guardrails

- **FastAPI Entrypoint**: Entrypoint chính xác là `backend/app/sever.py` (`app.sever:app`). Tuyệt đối **không** đổi tên `sever.py` thành `server.py`.
- **Locked Python ABI Dependencies** (`backend/requirements.txt`): Giữ nguyên `numpy==1.26.4` (không nâng lên 2.x), `protobuf==3.20.2` (`<4.0.0`), `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`.
- **Backend Layered Flow** (`BACKEND_FLOW_STANDARD.md`): Tuân thủ `Router -> Request Schema -> Service -> Repository -> Model/ORM -> PostgreSQL -> Response Schema`. Router không gọi `AsyncSession` trực tiếp; Service không viết query SQLAlchemy trực tiếp.
- **Supabase & External Provider Security**:
  - `bookpages.imagepath` chỉ lưu object path tương đối (tuyệt đối không lưu signed URL tạm thời vào DB).
  - `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` chỉ được sử dụng ở Backend, không lộ ra frontend (`NEXT_PUBLIC_*`) hay commit `.env*`.
  - Map lỗi provider ngoài sang mã an toàn (`SPEECH_UNAVAILABLE`, `STT_QUOTA_EXCEEDED`, `UNSUPPORTED_AUDIO`).
  - Dùng lazy import / `try...except ImportError` cho `paddleocr`, `vietocr`, `torch`, `pytesseract` trong `backend/app/services/ocr_engine.py`.
- **Quality Gate**: Trước khi kết luận hoàn tất thay đổi mã nguồn, chạy kiểm tra tương ứng theo skill `viread-quality-gate`.
