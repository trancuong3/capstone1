# DEPLOYMENT PROGRESS — ViRead Zero-Cost Optimal Architecture & Release Candidate

- **Target Worktree:** `F:\c1\capstone1-rc-zero-cost`
- **Branch:** `feat/viread-rc-zero-cost-20261125`
- **Remote Base (`origin/main`):** `94fffd29e3bcef81c034f4ec4db65b9120b686f2`
- **Merged Staging (`feat/viread-staging-release-20261124`):** `c42f10e3e81079bc0a53a7313cd0bdd6b6f69a01`
- **RC Baseline SHA (pre-fix merge):** `d5eee4dc907d81b737b53da08c916b1b4ba095d3`
- **Untouched Worktrees:**
  - `F:\c1\capstone1` (`cad23ac7`, 103 modified + 43 untracked local files preserved untouched)
  - `F:\c1\capstone1-staging-release` (`c42f10e3`, `docs/research/zero-cost-production-v2/` preserved untouched)
- **Live Production Snapshot (Read-Only Verified `2026-11-25`):**
  - Supabase `akjxbkakbbabpblmsktm` (`ap-south-1`, PG 17.12): DB `33.57 MB / 500 MB`, Storage `245.58 MB / 1 GB` (`887` objects across 4 private buckets), `books.deleted_at` present (`true`), `ocr_inference_jobs` absent (`false`).
  - Frontend `https://viread-frontend.vercel.app/login`: HTTP 200.
  - Backend `https://capstone1-ssd8.onrender.com/health`: timed out (>15s cold sleep / timeout).

## Phase 0 Hunk Audit Summary (`F:\c1\capstone1` dirty/untracked -> RC)
- **Already in `origin/main` (`94fffd29`):** Soft-delete catalog books (`books.is_deleted`, `deleted_at`, `deleted_by`), PR #196 voice snapshot, PR #197 flow2 snapshot.
- **Excluded from RC:** `docs/research/zero-cost-production-v2/*` in main, generated PNG screenshots (`docs/antigravity-word-practice-upgrade/*.png`, `docs/reading/evidence/*.png`), local `.env*` files, WIP/non-release browser drafts.
- **Scoped Port Targets (to be selectively ported & verified on RC):**
  - Backend: `local_voice_worker_bootstrap.py`, `test_local_voice_worker_bootstrap.py`, `parent_private_book` `/my-books/paged` pagination, `voice.py` orchestrator pooling, `local_voice_provider.py`, `voice_orchestrator.py`, `test_parent_private_book_access.py`, `test_voice_local_and_google_fallback.py`, `scripts/windows/{voice_worker.py,Start-ViReadVoiceWorker.ps1}`.
  - Frontend: `pagination-bar.tsx`, `responsive-table.tsx`, `use-reading-auto-scroll.ts`, reading/voice/private-book pagination & auto-scroll/TTS-lifecycle fixes & tests.

## Completed Milestones
1. `[2026-11-25]` Created isolated RC worktree `F:\c1\capstone1-rc-zero-cost` from `origin/main` (`94fffd29`), merged `c42f10e3` cleanly (`0` conflicts) -> SHA `d5eee4dc907d81b737b53da08c916b1b4ba095d3`.
2. `[2026-11-25]` Read-only audit of Production Supabase `akjxbkakbbabpblmsktm` completed; linked `frontend/node_modules` junction; initialized multi-agent Swarm.

## Next Steps
1. Execute parallel Swarm wave:
   - `infra-cost-architect`: 2026 zero-cost ecosystem + novel architectures + full TCO.
   - `rc-backend-worker`: worker decoupling, true health, soft-delete OCR fencing, TIFF `<pad>` fix, Dockerfile fix, security (`429`, `12 MB`, `Active==1`, dedup route), proxyless URLs & Opus/fp32 audio.
   - `rc-frontend-android`: port scoped frontend hunks, Next.js CSP/headers, `auth/callback` origin allowlist, interim STT reduction, `/admin/health` UI, Browser WASM / Android offline PoC & Gradle/Vitest gates.
   - `ai-bench-pg-sre`: ONNX OCR RAM experiment, WSL2 Linux `ocr_worker` check, JPEG q=85 & fp32/Opus A/B, 5-mode offline voice tests, PG16 full integration + `pg_dump`/restore + timed rollback drill.
   - `independent-red-team`: independent verification, security & adversarial review, strict Gate 01–12 & Section 12 scoring.
2. Live Browser acceptance (`/browser` `Model: "flash"`) on isolated local staging stack.
3. Produce `RELEASE_GATE.md` and 23 final architecture documents (`docs/research/viread-optimal-zero-cost-architecture/`).
