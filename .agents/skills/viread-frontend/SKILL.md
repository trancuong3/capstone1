---
name: viread-frontend
description: "Use for ViRead Next.js/React/TypeScript logic changes."
---
Use project source and `frontend/AGENTS.md` first. For Next.js APIs/conventions, prefer the installed version docs in `frontend/node_modules/next/dist/docs/`; do **not** load `nextjs-app-router-patterns` by default. For version-sensitive libraries, `frontend/package.json`, installed package types, and local docs win over generic skill guidance. Current Zod major is 4, so use `.agent-library/zod-4/SKILL.md` for Zod-specific work and never load both `zod` and `zod-4`. For React Hook Form, use `react-hook-form` only for non-obvious form behavior and defer to the installed package if its version differs. Open at most one other detailed skill for the exact missing topic (React performance, TypeScript, accessibility, Vitest, or Turbopack).
