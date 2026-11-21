# ViRead Admin AI Quality & Self-Healing QA — Execution Plan

- **Worktree:** `F:\c1\capstone1-admin-ai-qa`
- **Branch:** `feat/admin-ai-quality-qa-20261121` (branched from `main` `aafa3966`)
- **Policy Guardrails:** Zero changes to production/Supabase prod DB, zero merges/pushes to `main`, zero paid cloud API spend, locked ABI pins in `backend/requirements.txt` untouched, `backend/app/sever.py` untouched, strictly additive SQL migrations preserving legacy verified/published books.

## Milestones

| Milestone | Scope | Status | Commit |
| --- | --- | --- | --- |
| M1 | Full discovery, working memory docs, baseline `NameError: uuid4` fix | DONE | `dcb13f5e` |
| M2 | AI OCR proofreading hardening, cloud budget reservation, multi-chunk index fix, real local Ollama live fallback | DONE | `f745f0dd` |
| M3 | Durable workflow persistence, Child Safety chunk completeness, prompt-injection escalation, Text vs Image Safety separation + manual Admin image review | DONE | `cf54057b` |
| M4 | Additive SQL migration (`20261121120000`), Rights Evidence & version history, strict server-side verification gate, disable `AI_AUTO_VERIFIED` & `auto_publish_if_eligible`, preserve legacy v2 published books | DONE | `dd010d62` |
| M5 | Book Content Quality UI (Rights panel + Per-Page Diagnostics + unknown physical page count disclaimer), Parent Reports inbox (`CHILD_SAFETY_CONCERN`, `COPYRIGHT_CONCERN`), Parent resolution view & internal-finding redaction | DONE | `4cda9f2f` |
| M6 | Adversarial QA: Hypothesis property-based tests (350+ cases), Frontend-Backend contract parity, RBAC/IDOR matrix, prompt injection, concurrency/race, performance bounds, controlled mutation checks (5/5 killed) | DONE | `b352bda5` |
| M7 | Structured error-code translation in `api-client.ts`, backend regression fixes (`admin_ocr_service`, `test_admin_ocr_local_api`, `run_ci_tests.py`), Real Browser Playwright E2E (desktop 1440×1000 + mobile 390×844) + visual layout QA fix, full Vitest/tsc/eslint/Prettier/Next.js build, 3-perspective final review, PR creation | DONE | Final M7 commit |
