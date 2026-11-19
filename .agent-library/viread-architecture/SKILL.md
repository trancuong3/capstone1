---
name: viread-architecture
description: >-
  Use only for cross-layer ViRead architecture/navigation when file ownership, dependencies, or flow remain unclear after exact source search.
---

# ViRead Architecture — Source-First Compatibility Guide

The repository root `AGENTS.md` is the authoritative agent policy. Before touching `backend/**` or `frontend/**`, ensure the matching scoped `AGENTS.md` is in context.

## Discovery order

1. Known file/symbol → exact search and the smallest relevant source range.
2. Unknown ownership → search the likely subtree before widening scope.
3. If a **fresh local** Graphify graph already exists and relationships are still unclear, query it with budget 300; escalate to 600→1000 only when evidence is insufficient.
4. Build/update Graphify only for repeated or structural cross-file discovery that will actually reuse the graph; honor `.graphifyignore`.
5. Load detailed skills only for knowledge missing from source/project/version-local docs.

Never query Graphify first merely because a graph exists. Never rebuild/update a graph as a post-edit ritual.

## Stable project guardrails

Do not duplicate or override guardrails here:
- universal safety/context rules → root `AGENTS.md`
- backend entrypoint/layering/OCR/Supabase invariants → `backend/AGENTS.md`
- Next.js version-local behavior → `frontend/AGENTS.md` + installed Next docs
- actual architecture → trace imports/calls and `BACKEND_FLOW_STANDARD.md`; directory names alone are not proof

## High-level domain map

- Reading/speech: `frontend/components/reading/`, `frontend/lib/reading/`, backend reading/voice services and routes.
- OCR/admin books: frontend admin book screens; backend OCR/book routes, services, repositories.
- Data/auth/storage: backend repositories/database/Supabase helpers plus frontend auth/API adapters.
- Reports/progress: frontend reports/reading-management; backend comparison/progress services.
- Mobile packaging: project Android/PWA/TWA/Expo-related source plus the two ViRead Android lazy skills.

Project source is the final authority when this map drifts.
