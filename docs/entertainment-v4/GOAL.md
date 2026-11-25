# ViRead Intelligent Play & Learn V4.0 — Goal Tree & Quality Gates

- **Baseline Commit SHA**: `29e2da36a3311949a0e45dc40c1e80664b9c0ec3` (`origin/main` fast-forwarded into `tu` with 0 conflicts)
- **Integration Branch**: `feature/viread-intelligent-play-learn-v4` (HEAD `e5c5f376` + verified post-fix working tree)
- **Independent QA Audit Date**: `2026-11-25` (`qa-independent` — initial adversarial audit + fresh post-fix re-verification)
- **Workflow Mechanisms Activated**:
  - Multi-agent orchestration: Antigravity native `swarm` tool (`swarm(action="title"|"add")`) + `swarm_pane` overview (`plan.json`).
  - Goal tracking: `docs/entertainment-v4/GOAL.md` (G01–G16 + QG01–QG15) + live `update_steps` checklist.
  - Phased planning: `docs/entertainment-v4/PLAN.md` (DISCOVER -> RESEARCH -> MEASURE -> COMPARE -> DESIGN -> IMPLEMENT -> TEST -> CRITIQUE -> FIX -> REGRESSION -> REVIEW -> MERGE -> VERIFY).
  - Note: Chat slash commands (`/swarm`, `/goal`, `/plan`) are user-facing UI triggers; the underlying runtime equivalents (`swarm` tool, `update_steps`, and structured `GOAL.md`/`PLAN.md`/`SWARM_TASKS.md`) are actively executed and tracked here honestly.

---

## Goal Tree (G01–G16)

| ID | Goal | Status | Acceptance Criteria | Verification Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **G01** | Research and architecture | `COMPLETE` | Complete academic/product/AI/DSP/image/admin/zero-cost research + ADRs before coding. | `docs/entertainment-v4/research/*.md` (8 docs, 31 verified edu citations, ADRs, baseline 327+32 backend & 335 frontend) |
| **G02** | Educational design | `COMPLETE` | Every game maps to Grade 1–5 Vietnamese learning goals, scaffolding, formative feedback, and anti-pressure guardrails. | `EDUCATIONAL_RESEARCH.md` + `PRODUCT_COMPARISON.md` + `EDUCATIONAL_DESIGN.md` + 16-skill GDPT 2018 taxonomy |
| **G03** | Adaptive learning engine | `VERIFIED` | Evidence-based skill profile, multi-attempt adaptive difficulty, spaced review tied to Difficult Words, cross-game recommendations without medical/IQ claims. | `test_adaptive_learning.py` (6/6 PASS incl. real `GameSession` ORM synthesis test) + `ADAPTIVE_LEARNING_ARCHITECTURE.md` (P0-2 & P2-2 closed & verified) |
| **G04** | Entertainment experience | `VERIFIED` | Mobile-first, child-friendly 4-zone Entertainment Hub with interactive onboarding, natural stopping cues, zero dark patterns, reduced-motion & contrast support. | `entertainment-screen.tsx` + `entertainment-hub-v4.test.tsx` (2/2 PASS) + 48–56px touch targets *(low-impact P2-4 backlog noted)* |
| **G05** | AI Teacher V4.0 | `VERIFIED` | Voice-interactive scaffolding modes (Observe, Vocab, Sentence, Story, Infer, Create), shared cloud-before-Ollama tiered orchestration, privacy & child-safety guardrails. | `test_picture_description.py` (29/29 PASS incl. fail-closed `CUSTOM_UPLOAD`) + `picture-description-ui.test.tsx` (10/10 PASS) + 0 sample cloud calls (P1-1 & P2-6 closed & verified) |
| **G06** | Real-time Sentence Shooter | `VERIFIED` | Immediate tap-to-visual feedback decoupled from network/DB, learning modes (word order, fill-in, context/grammar/difficult words), server-authoritative anti-double-scoring. | `test_sentence_shooter.py` (38/38 PASS) + `sentence-shooter-ui.test.tsx` (10/10 PASS: **`13.07–20.95ms`** under 500ms RTT, **`0`** tap reflows, FIFO rollback, singleton `AudioContext`) + `SENTENCE_SHOOTER_PERFORMANCE.md` |
| **G07** | Musical Karaoke scoring | `VERIFIED` | Evidence-based rhythm + pitch (when reference valid) + lyrics + duration scoring modes, capture/playback clock separation, segment practice loop, honest confidence & reports. | `KARAOKE_SCORING_BENCHMARK.json` (12/12 scenarios reproduced identically, `0` octave delta, `-72` monotone delta) + `musical-dsp.test.ts` (16/16) + `musical-scoring-benchmark.test.ts` (8/8) + `test_karaoke_practice.py` (8/8 pytest + 8/8 unittest) + `ai/karaoke_processing` (32/32) (P2-3 & P2-5 closed) |
| **G08** | Automatic Admin Karaoke | `VERIFIED` | Simple Mode one-MP3 upload with auto ID3 metadata, vocal/instrumental detection, background staged processing, Review by Exception, preserved Advanced Editor & license gate. | `ADMIN_WORKFLOW_BEFORE_AFTER.md` (6 clicks, `-54%` to `-65%` vs Wizard, `-88%` to `-95%` time) + `test_karaoke_simple_import.py` (10/10) + `karaoke-simple-admin.test.tsx` (7/7) + unchecked compliance boxes enforced client & server |
| **G09** | AI Memory & Creative Story Game | `VERIFIED` | New "Bé nhớ được gì?" game with procedural/verified ground-truth scenes, selectable timer starting post-load, free/guided recall, creative extension, separate factual vs creative scoring, reveal learning screen. | 6 themes / 42 sprites / `0%` bbox overlap / `test_memory_game.py` (12/12 PASS incl. `ReadingEvent.Type` SQL test & `<child_response>` prompt fencing) + `memory-game-ui.test.tsx` (6/6 PASS) (P0-3, P1-2 & P2-1 closed & verified) |
| **G10** | Shared voice infrastructure | `VERIFIED` | Clean mic/TTS lifecycle across games (no TTS self-capture, duplicate suppression, offline/error draft recovery, Android WebView background release). | Verified across Picture Description, Memory Game, Karaoke DSP/Player, Sentence Shooter (`viread:android-background` + `visibilitychange` + TTS/mic interlock tests PASS) |
| **G11** | Parent reports | `VERIFIED` | Integrated parent analytics showing observed vs estimated skills, difficult words practiced, game progress, karaoke segments to practice, next-step tips (no IQ/diagnostic claims). | `entertainment-learning-summary.tsx` + `progress-report-screen.tsx` + `test_parent_reports.py` PASS + real-ORM `GameSession` smoke PASS (P0-2 closed & verified) |
| **G12** | Mobile and APK | `VERIFIED (Code) / PENDING_PHYSICAL_DEVICE` | Responsive portrait/landscape, no horizontal overflow, touch targets, WebView media lifecycle, Android JVM/APK checks (and real device test if ADB connected). | `MOBILE_ACCEPTANCE.md`: automated responsive/overflow/WebView lifecycle checks **VERIFIED**; physical hardware APK test honestly **`PENDING_PHYSICAL_DEVICE`** (0 ADB devices attached; `android/gradlew.bat` absent) |
| **G13** | Security and privacy | `VERIFIED` | Auth, parent/child ownership, RLS, IDOR prevention, prompt-injection fencing, file validation, no secrets/raw audio leaks, additive backward-compatible migrations. | `SECURITY_REVIEW.md`: RBAC/IDOR/RLS/zero-audio/0-secrets (98 files)/0-protected-diff **PASS**; rollback moved to `supabase/rollbacks/` (`test_migration_versions` PASS); P0-1, P1-1, P1-2, P2-1, P2-2, P2-6 closed & verified |
| **G14** | Performance & Zero-Cost | `VERIFIED` | Measured before/after metrics, zero paid APIs, bounded queues/caches, laptop-off honest degraded mode. | `PERFORMANCE_BEFORE_AFTER.md` + `ZERO_COST_REPORT.md` + `test_web_lightweight_startup.py` (5/5 PASS) + 0 diff on `requirements-web.txt` |
| **G15** | Regression and acceptance | `VERIFIED` | Independent QA review (12 rounds), OCR/Reading/Auth/Karaoke/Books/Admin full regression PASS, QG01–QG15 evaluated honestly. | `FINAL_TEST_REPORT.md` + `FINAL_QA_REPORT.md` + `EVIDENCE_INDEX.md`: Backend 30-module `unittest` **396 run (388 pass, 8 skipped, 0 failed)**; 6 V4 `pytest` **111/111 PASS**; DSP **32/32 PASS**; Frontend **186 files / 2,659 PASS**; `tsc` 0 err; `eslint` 0 err (2 warn); Prettier & Hygiene **PASS** |
| **G16** | GitHub CI, PR and merge | `IN_PROGRESS` | Clean commits, PR to `main`, CI green, merge if ruleset/approvals allow (or honest blocker report), post-merge smoke verification. | Ready for Coordinator clean commit, push, PR to `main`, and GitHub CI verification |

---

## Quality Gates Summary (QG01–QG15 — Post-Fix Final Evaluation)

| Gate | Status | Notes |
| :--- | :--- | :--- |
| **QG01** Research & ADRs | `PASS` | 8 research reports + ADRs |
| **QG02** Pedagogy & Non-Diagnostic | `PASS` | GDPT 2018 + PEER/CROWD + `is_diagnostic=False` |
| **QG03** Adaptive Engine & Analytics | `PASS` | P0-2 & P2-2 fixed & verified (6/6 tests + real ORM smoke) |
| **QG04** Child-First Hub UX | `PASS` | 4 zones, 48–56px targets, onboarding, break cues *(low-impact P2-4 backlog)* |
| **QG05** AI Teacher V4.0 Safety | `PASS` | P1-1 (`CUSTOM_UPLOAD` fail-closed) & P2-6 fixed & verified (29/29 + 10/10) |
| **QG06** Sentence Shooter Performance | `PASS` | `13.07–20.95ms`, 0 reflows, FIFO rollback, anti-double-score (38/38 + 10/10) |
| **QG07** Musical Karaoke DSP | `PASS` | 12/12 PCM benchmark reproduced byte-for-byte; P2-3 & P2-5 closed |
| **QG08** Admin Karaoke Automation | `PASS` | 6 clicks (`>=50%` reduction), unchecked compliance boxes enforced (10/10 + 7/7) |
| **QG09** AI Memory Game | `PASS` | P0-3 (`ReadingEvent.Type`), P1-2 (prompt fencing) & P2-1 fixed & verified (12/12 + 6/6) |
| **QG10** Voice & Background Lifecycle | `PASS` | Anti-TTS-self-capture + `viread:android-background` verified |
| **QG11** Zero-Cost & 512 MiB Render | `PASS` | Strict 0 VND, 0 diff on `requirements-web.txt` |
| **QG12** Mobile & Android APK | `PARTIAL (PENDING_PHYSICAL_DEVICE)` | Automated WebView/responsive `VERIFIED`; physical device `PENDING_PHYSICAL_DEVICE` |
| **QG13** Security, RLS & Migration | `PASS` | P0-1, P1-1, P1-2, P2-1, P2-2, P2-6 closed & verified; 0 secrets across 98 files |
| **QG14** Full Regression Suite | `PASS` | 388/388 backend unittest (+8 skip) + 111/111 V4 pytest + 32/32 DSP + 2,659/2,659 frontend Vitest (+1 skip) |
| **QG15** 12-Round Independent QA | `PASS` | Initial audit + post-fix re-verification complete; **GO for PR & CI** |
