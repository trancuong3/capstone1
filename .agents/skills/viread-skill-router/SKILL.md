---
name: viread-skill-router
description: "Use for complex, cross-layer, or ambiguous ReadAlong Vision tasks (T2/T3), especially when more than one domain is involved. Classify the task and choose the smallest relevant skill set. Do not use for trivial T0 edits or ordinary focused T1 tasks when one obvious domain skill is enough. Optimize for minimum token/context usage."
---

# ViRead Skill Router — Token-Minimal

Use this skill only for **T2/T3** work or when the correct domain skill is unclear.

## Classification

- **T0**: tiny known edit → 0 skills, 0 Graphify.
- **T1**: one clear module/domain → at most 1 domain skill; Graphify only if file/flow is unknown.
- **T2**: several files/layers → this router + at most 3 domain skills.
- **T3**: cross-cutting architecture → this router + at most 5 necessary skills.

Never load every installed skill.

## Routing

Choose only what the task actually needs:

- FastAPI/backend → `fastapi` OR `fastapi-expert`.
- Async/concurrency → add `async-python-patterns` only if relevant.
- Supabase → `supabase`; add `supabase-postgres-best-practices` only for DB/query/schema work.
- SQLAlchemy/migrations → `sqlalchemy-alembic-expert-best-practices-code-review`.
- Auth/authorization → `auth-implementation-patterns`; add `secure-code-guardian` only for security-boundary changes.
- Next.js/frontend → `nextjs-app-router-patterns` or the most relevant React skill.
- Forms/validation → `react-hook-form`, `zod` only when present in the affected code.
- Figma/UI → `figma-design-to-code` + at most one of `frontend-design` / `ui-ux-pro-max`.
- Vietnamese OCR → prefer one project-specific OCR skill.
- Child reading/speech → `viread-reading-assessment`.
- Android/APK → `viread-android-apk` OR `viread-android-build`.
- Non-obvious bug → `systematic-debugging`.
- Tests → load only the testing skill for the affected layer.
- Completion → `viread-quality-gate` + `verification-before-completion` only at the end.

## Graphify rule

If the prompt/checkpoint already names the exact file or next action, read that file directly.

Otherwise, when architecture/file ownership is unknown and `graphify-out/graph.json` exists, run one narrow query with **600-token budget**. Increase only if necessary, never above 1500 for routine work.

Do not open `GRAPH_REPORT.md` for focused tasks.

## Resume rule

For "continue/resume/làm tiếp":
1. read `.codex/skills/graphify/PROJECT_STATE.md`;
2. inspect `git status --short`, `git diff --name-only`, `git log -3 --oneline`;
3. continue from **Next exact actions**;
4. do not Graphify or rediscover already-known work unless the checkpoint is stale/incomplete.

## Context discipline

- Read smallest source ranges.
- Summarize test/log output.
- Focused tests before full suites.
- No repeated architecture explanation.
- No duplicate overlapping skills unless evidence requires both.
- Update Graphify/checkpoint at meaningful milestones, not after every edit.

Project rules in `AGENTS.md` override generic skill advice.
