# ViRead Codex Rules — Token First

## 1. Minimal-context execution

For every task, classify it before loading skills or Graphify:

- **T0 — trivial/known edit**: exact file or tiny text/style/config change. Use **0 skills**, **0 Graphify queries** unless required by the task.
- **T1 — focused task**: one clear bug/API/component/module. Load **at most 1 domain skill**. If the prompt/checkpoint already identifies the file/flow, read it directly; otherwise use **1 Graphify query**.
- **T2 — complex feature/debugging**: spans several files/layers. Use `viread-skill-router`, then **at most 3 domain skills**. Use 1–2 narrow Graphify queries.
- **T3 — cross-cutting architecture/rewrite**: use `viread-skill-router`, then **at most 5 skills** only when each is necessary.

The user never needs to name skills. Automatically select them, but never load skills "just in case".

## 2. Token budget

- Default Graphify query budget: **600 tokens**.
- Increase only when evidence is insufficient: 600 → 1000 → max 1500.
- Do not read `graphify-out/GRAPH_REPORT.md` unless a broad architecture review truly needs it.
- Do not scan the repository when Git/checkpoint/Graphify already identifies the relevant files.
- Read only the smallest useful source ranges.
- Do not paste large logs/diffs into context; summarize them.
- Run focused tests first; full suites only near completion or when the change is cross-cutting.

## 3. Resume / token recovery

When continuing after a token/rate limit, read:
1. this file;
2. `.codex/skills/graphify/PROJECT_STATE.md`;
3. `git status --short`;
4. `git diff --name-only`;
5. `git log -3 --oneline`.

Then continue from **Next exact actions**. Do not rediscover completed work.

If the checkpoint already names the next file/action, do **not** run Graphify first. Use Graphify only when a dependency or flow is unknown.

Never reset, discard, or overwrite uncommitted user work.

## 4. Graphify

When architecture/file ownership is unknown and `graphify-out/graph.json` exists, query before broad grep/search:

```powershell
.\.venv\Scripts\python.exe -m graphify query "<specific question>" --budget 600
```

Use `graphify path` / `graphify explain` for relationships or focused concepts.

Do **not** rebuild/update Graphify after every edit. Run `graphify update .` only:
- after a meaningful milestone;
- before creating/updating a handoff checkpoint;
- before commit/merge when source changed.

## 5. Skill routing defaults

Prefer the smallest non-overlapping set:
- Backend: `fastapi` **or** `fastapi-expert` (not both unless necessary).
- Supabase/Postgres: `supabase`; add `supabase-postgres-best-practices` only for DB/query/schema work.
- Auth/security: `auth-implementation-patterns`; add security review only when trust boundaries change.
- Frontend: `nextjs-app-router-patterns` or the most relevant React skill.
- Figma/UI: usually `figma-design-to-code` + at most one visual/design skill.
- Vietnamese OCR: prefer one project-specific OCR skill, not both by default.
- Child reading/speech: `viread-reading-assessment`.
- Android/APK: `viread-android-apk` or `viread-android-build`.
- Debugging: `systematic-debugging` only for non-obvious bugs.
- Testing skills are loaded only when their layer is reached.

Before claiming source-code work complete, run the appropriate `viread-quality-gate` and `verification-before-completion`; do not load them at task start.

## 6. ViRead critical guardrails

- FastAPI entrypoint is `backend/app/sever.py` (`app.sever:app`). Never rename it to `server.py`.
- Keep locked Python ABI dependencies in `backend/requirements.txt`: `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`.
- Backend flow: `Router -> Request Schema -> Service -> Repository -> Model/ORM -> PostgreSQL -> Response Schema`.
- `bookpages.imagepath` stores relative object paths only; never persist signed URLs.
- Supabase secret/service-role keys remain backend-only and never enter `NEXT_PUBLIC_*`.
- Map provider failures to safe application codes such as `SPEECH_UNAVAILABLE`, `STT_QUOTA_EXCEEDED`, `UNSUPPORTED_AUDIO`.
- Keep OCR heavy dependencies lazy-imported / guarded in `backend/app/services/ocr_engine.py`.
