# ViRead Intelligent Play & Learn V4.0 — Master Execution Plan

## Lifecycle Order
`DISCOVER -> RESEARCH -> MEASURE -> COMPARE -> DESIGN -> IMPLEMENT -> TEST -> CRITIQUE -> FIX -> REGRESSION -> REVIEW -> MERGE -> VERIFY`

## Phase Breakdown

1. **Phase 01–02: DISCOVER, RESEARCH & MEASURE (Active)**
   - Pull `origin/main` cleanly into `tu` (`29e2da36`, fast-forward, 0 conflicts) and create integration branch `feature/viread-intelligent-play-learn-v4`.
   - Parallel Swarm research & audit:
     - `researcher-edu`: Academic & Vietnamese GDPT 2018 pedagogy research + Product Comparison Matrix.
     - `auditor-backend`: Complete backend/AI/DSP/DB/zero-cost audit + baseline backend tests.
     - `auditor-frontend`: Complete frontend/game/karaoke/admin/Android audit + baseline measurements + baseline Vitest.
   - Synthesize `ARCHITECTURE_DECISION_RECORDS.md` (ADRs) comparing real feasible options before writing application code.

2. **Phase 03 & 11: DESIGN & CORE FOUNDATION (Adaptive Learning Engine + Schema)**
   - Design additive, backward-compatible schema/migration (with rollback) and Adaptive Learning Engine (`SkillProfile`, `Evidence`, `AdaptiveDifficulty`, `SpacedReview`, `CrossGameRecommendations`).
   - Unify/reuse shared AI orchestration principles without altering existing OCR production behavior.

3. **Phase 04–09: PARALLEL MODULE IMPLEMENTATION (Swarm Workers with Non-Overlapping Ownership)**
   - **Track A — Entertainment Hub + Adaptive Learning + Parent Analytics**: 4-zone child-first Hub, interactive onboarding, adaptive recommendations, integrated Parent Reports.
   - **Track B — AI Teacher V4.0**: Teaching modes (Observe, Vocab, Sentence, Story, Infer, Create), scaffolding loop, natural voice lifecycle, child safety.
   - **Track C — Sentence Shooter V4.0**: Decoupled tap-to-animation input path, learning modes (word order, fill-in, grammar/difficult words), visual polish, server reconciliation & anti-double-score.
   - **Track D — Musical Karaoke V4.0 + Admin One-File Automation**: Client/server audio DSP (rhythm onset/beat alignment + pitch F0 contour with transposition tolerance + explicit scoring modes), immersive stage + segment practice loop; Admin Simple Mode (1-MP3 upload, ID3 extraction, audio-type detection, staged pipeline, Review by Exception, preserved Advanced Editor & license gate).
   - **Track E — AI Memory & Creative Story Game ("Bé nhớ được gì?")**: Deterministic/AI-assisted verifiable scene graph + rich SVG/Canvas renderer (0 VND, unlimited fresh scenes, exact ground truth), selectable post-load timer, guided/free recall, creative extension, separate factual vs creative evaluation, reveal screen.

4. **Phase 12–16: TEST, CRITIQUE, FIX, REGRESSION & INDEPENDENT QA**
   - Spawn an **Independent QA Lead + Adversarial Reviewer** worker (separate from implementation workers) to execute 12-round critique, failure injection, controlled karaoke DSP benchmark, security/RLS audit, mobile/Android verification, full backend + frontend + E2E regression, and QG01–QG15 scoring.
   - Fix all actionable findings and re-verify.

5. **Phase 17–18: DOCUMENTATION, PR, CI & RELEASE**
   - Finalize all `docs/entertainment-v4/*.md` deliverables and evidence index.
   - Push branch, create PR to `main`, verify CI checks, merge only if all required quality gates and repository policies pass, and run post-merge verification.
