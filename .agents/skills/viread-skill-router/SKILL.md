---
name: viread-skill-router
description: "Use automatically for every non-trivial ReadAlong Vision task, even when the user does not mention skills. Before research, debugging, coding, review, testing, Supabase work, OCR/speech work, UI/Figma work, Android work, or architecture changes, classify the task domains and load the smallest relevant set of repository skills. Always use Graphify first for codebase discovery when graphify-out exists. Before declaring code changes complete, use viread-quality-gate and verification-before-completion. Skip only trivial chat/formatting or when the user explicitly asks not to use skills."
---

# ViRead Automatic Skill Router

This skill is the project-level skill dispatcher for ReadAlong Vision.

## Core rule

For every non-trivial task, select and use the smallest relevant skill set even when the user does not name any skill.

Do not ask the user which skill to use when the task domain is clear.

Do not load every installed skill. Skill selection must reduce token usage, not increase it.

## Mandatory order

1. Read the task and classify its domains.
2. Read `AGENTS.md` and obey all project guardrails.
3. If `graphify-out/graph.json` exists and the task concerns the codebase, query Graphify before broad grep/search/source reads.
4. Select only the relevant repository skills.
5. Use those skills while implementing/researching.
6. Run the smallest relevant tests first.
7. Before claiming code work is complete, use:
   - `viread-quality-gate`
   - `verification-before-completion`
8. After relevant source changes, run `graphify update .`.

## Routing table

### Backend / FastAPI / Python
Prefer:
- `fastapi`
- `fastapi-expert`
- `async-python-patterns` when async/concurrency is involved
- `python-error-handling` for failure/retry behavior
- `python-performance-optimization` for performance work
- `pydantic` for request/response model work

### Supabase / PostgreSQL / quota / storage / auth
Prefer:
- `supabase`
- `supabase-postgres-best-practices`
- `postgresql-table-design` for schema/index work
- `sqlalchemy-alembic-expert-best-practices-code-review` for ORM/migrations
- `auth-implementation-patterns` for authentication/authorization
- `secure-code-guardian` and/or `owasp-top-10` when security boundaries change

### Authentication / authorization / Parent-Admin isolation
Prefer:
- `auth-implementation-patterns`
- `secure-code-guardian`
- `owasp-top-10`
- plus backend/database skills relevant to the implementation

### React / Next.js / frontend
Prefer:
- `nextjs-app-router-patterns`
- `vercel-react-best-practices`
- `typescript-advanced-types` when types are complex
- `zod` or `zod-4` for validation
- `react-hook-form` for forms
- `frontend-a11y` for accessibility

### UI / UX / Figma
Prefer:
- `figma-design-to-code` when implementing from Figma
- `frontend-design`
- `ui-ux-pro-max`
- `design-system`
- `ui-styling`
- `tailwind-design-system` / `tailwind-4-docs` when Tailwind is involved
- `web-design-guidelines` for visual quality review

### Vietnamese OCR
Prefer project-specific skills first:
- `viread-ocr-vietnamese`
- `viread-vietnamese-ocr`
Then add only what is needed:
- Python/FastAPI/performance/testing skills

### Reading assessment / child speech flow
Prefer:
- `viread-reading-assessment`
- `systematic-debugging` for recognition/state bugs
- relevant FastAPI/React/testing skills

### Android / APK / Expo
Prefer:
- `viread-android-apk`
- `viread-android-build`
- `expo-router`
- `expo-data-fetching`
- `expo-native-ui`
- `expo-design-system`
- `expo-web-to-native` only when porting web UI

### Architecture / cross-cutting refactors
Prefer:
- `viread-architecture`
- `differential-review`
- `systematic-debugging`
- `planning-with-files` or `writing-plans` only when the task genuinely needs a plan
- `dispatching-parallel-agents` / `subagent-driven-development` only when parallel work has clear value

### Debugging
Prefer:
- `systematic-debugging`
- domain-specific skill(s)
- `python-error-handling` or frontend testing skills as appropriate

### Testing
Choose by layer:
- `python-testing-patterns`
- `pytest-coverage`
- `vitest`
- `e2e-testing-patterns`
- `playwright-best-practices`
- `playwright-cli`
- `webapp-testing`

Do not load all testing skills unless the task spans all those layers.

### Code review / finishing work
Prefer:
- `differential-review`
- `requesting-code-review` / `receiving-code-review` when applicable
- `verification-before-completion`
- `viread-quality-gate`

### Git/worktree workflow
Prefer:
- `using-git-worktrees`
- `finishing-a-development-branch`

## Token-efficiency rules

- Never read all SKILL.md files "just in case".
- Match using skill name + description first.
- Load full skill instructions only for selected skills.
- Prefer one project-specific skill over several generic overlapping skills when it fully covers the task.
- Use Graphify to locate code before raw repository scans.
- Use the continuation checkpoint in `.codex/skills/graphify/PROJECT_STATE.md` for resume/continue tasks.
- When resuming after token/rate-limit recovery, do not rediscover completed work.

## Examples

User: "Sửa lỗi Parent upload sách"
Use approximately:
- graphify
- viread-skill-router
- fastapi / fastapi-expert
- auth-implementation-patterns
- nextjs-app-router-patterns
- relevant testing skill
- viread-quality-gate + verification-before-completion

User: "Tối ưu Supabase egress"
Use approximately:
- graphify
- viread-skill-router
- supabase
- supabase-postgres-best-practices
- python-performance-optimization
- systematic-debugging
- verification-before-completion

User: "Làm giao diện giống Figma"
Use approximately:
- graphify
- viread-skill-router
- figma-design-to-code
- frontend-design
- relevant React/Next.js skill
- frontend-a11y
- viread-quality-gate

User: "Sửa nhận diện đọc tiếng Việt của bé"
Use approximately:
- graphify
- viread-skill-router
- viread-reading-assessment
- systematic-debugging
- relevant backend/frontend/testing skills
- viread-quality-gate

## Conflict rule

If two skills disagree:
1. System/developer/user instructions win.
2. `AGENTS.md` project guardrails win over generic skill advice.
3. Project-specific `viread-*` skill guidance wins over generic skill guidance when both address the same project behavior.
4. Prefer the safer, narrower change.
