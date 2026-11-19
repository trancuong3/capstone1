---
name: viread-quality-gate
description: >-
  Use this skill before claiming any bugfix, refactor, or feature in ViRead is complete. Selects and executes scoped ESLint, TypeScript, Vitest, Python unittest/pytest, and Playwright verification commands matching changed files.
---

# ViRead Quality Gate & Scoped Verification

**Iron Rule**: Never claim a task is fixed, passing, or ready without fresh command execution and exit-code `0` evidence from the relevant checks below.

## 1. Match Verification Scope to Changed Files (Save Time & Tokens)

| Changed Scope | Minimum Required Gate | Pre-Merge / Full Gate |
| :--- | :--- | :--- |
| **Docs / Skills only** | Validate file paths, YAML frontmatter, `git status -sb` & `git diff --check` | Ensure zero unintended source edits |
| **Frontend UI / Component / Hook** | `typecheck` + `lint` + targeted `vitest run <file>` | `npm --prefix frontend run verify` (+ responsive Playwright if route/layout changed) |
| **Backend Route / Schema / Service** | Targeted `unittest` / `pytest` on touched module + import check of `app.sever:app` | Full `python -m unittest discover -v` in `backend/` |
| **OCR / Speech / Alignment** | Domain unit tests (`test_ocr_*.py`, `reading-screen.test.tsx`, `test_*reading*.py`) | Full Backend + Frontend unit suites |
| **Cross-stack / E2E flow** | Scoped Backend + Frontend unit tests + targeted Playwright spec | Full `verify` + Backend suite + Playwright config |

## 2. Exact Commands (Windows PowerShell in `F:\c1\capstone1`)

### Frontend (`frontend/`)
```powershell
Set-Location "F:\c1\capstone1\frontend"
npm.cmd run typecheck
npm.cmd run lint
# Targeted unit/component test (fast):
npx.cmd vitest run <path/to/spec.test.tsx>
# Full frontend verification (format:check + lint + typecheck + all Vitest tests):
npm.cmd run verify
```

### Playwright E2E (`frontend/`)
Protect any running `next dev` server's `.next` folder by using an isolated `NEXT_DIST_DIR` when building, or run targeted Playwright configs (`playwright.config.ts`, `playwright.reading.config.ts`, `playwright.tts.config.ts`, `playwright.real-data.config.ts`):
```powershell
Set-Location "F:\c1\capstone1\frontend"
npx.cmd playwright test <tests/e2e/target.spec.ts> --config=playwright.config.ts
```

### Backend (`backend/` — Always use project `.venv` and `app.sever:app`)
```powershell
Set-Location "F:\c1\capstone1\backend"
# Smoke-check FastAPI app import (note spelling: app.sever):
..\.venv\Scripts\python.exe -c "from app.sever import app; print(app.title)"
# Targeted backend test module:
..\.venv\Scripts\python.exe -m unittest test_<module>.py -v
# Full backend unit suite (~280+ tests):
..\.venv\Scripts\python.exe -m unittest discover -v
```

## 3. Pre-Completion Hygiene Checklist

1. Every verification command exited with `$LASTEXITCODE -eq 0`.
2. `git status -sb` and `git diff --stat` confirm no unrelated files, `.env*` secrets, or locked `backend/requirements.txt` pins (`numpy==1.26.4`, `protobuf==3.20.2`) were accidentally altered.
3. `git diff --check` reports zero whitespace or merge-marker errors.
4. **Graphify freshness is not a completion criterion.** Update a local graph only when structural relationships changed **and** that graph will be queried/reused; otherwise skip Graphify. Never update it merely to claim completion.
