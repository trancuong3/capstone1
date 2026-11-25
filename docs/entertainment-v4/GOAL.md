# ViRead Intelligent Play & Learn V4.0 — Goal Tree

- **Baseline Commit SHA**: `29e2da36a3311949a0e45dc40c1e80664b9c0ec3` (`origin/main` fast-forwarded into `tu` with 0 conflicts)
- **Integration Branch**: `feature/viread-intelligent-play-learn-v4`
- **Workflow Mechanisms Activated**:
  - Multi-agent orchestration: Antigravity native `swarm` tool (`swarm(action="title"|"add")`) + `swarm_pane` overview (`plan.json`).
  - Goal tracking: `docs/entertainment-v4/GOAL.md` (G01–G16) + live `update_steps` checklist.
  - Phased planning: `docs/entertainment-v4/PLAN.md` (DISCOVER -> RESEARCH -> MEASURE -> COMPARE -> DESIGN -> IMPLEMENT -> TEST -> CRITIQUE -> FIX -> REGRESSION -> REVIEW -> MERGE -> VERIFY).
  - Note: Chat slash commands (`/swarm`, `/goal`, `/plan`) are user-facing UI triggers; the underlying runtime equivalents (`swarm` tool, `update_steps`, and structured `GOAL.md`/`PLAN.md`/`SWARM_TASKS.md`) are actively executed and tracked here honestly.

## Goal Tree (G01–G16)

| ID | Goal | Status | Acceptance Criteria | Verification Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **G01** | Research and architecture | `COMPLETE` | Complete academic/product/AI/DSP/image/admin/zero-cost research + ADRs before coding. | `docs/entertainment-v4/research/*.md` (8 docs + 31 verified edu citations + baseline backend 327+32 pass, frontend 335 pass) |
| **G02** | Educational design | `COMPLETE` | Every game maps to Grade 1–5 Vietnamese learning goals, scaffolding, formative feedback, and anti-pressure guardrails. | `EDUCATIONAL_RESEARCH.md` + `PRODUCT_COMPARISON.md` + `ARCHITECTURE_DECISION_RECORDS.md` |
| **G03** | Adaptive learning engine | `IN_PROGRESS` | Evidence-based skill profile, multi-attempt adaptive difficulty, spaced review tied to Difficult Words, cross-game recommendations without medical/IQ claims. | Backend service + unit/integration tests + `ADAPTIVE_LEARNING_ARCHITECTURE.md` |
| **G04** | Entertainment experience | `PENDING` | Mobile-first, child-friendly 4-zone Entertainment Hub with interactive onboarding, natural stopping cues, zero dark patterns, reduced-motion & contrast support. | Component tests + Playwright/visual checks |
| **G05** | AI Teacher V4.0 | `PENDING` | Voice-interactive scaffolding modes (Observe, Vocab, Sentence, Story, Infer, Create), shared cloud-before-Ollama tiered orchestration, privacy & child-safety guardrails. | `test_picture_description.py` + `picture-description-ui.test.tsx` + OCR regression |
| **G06** | Real-time Sentence Shooter | `PENDING` | Immediate tap-to-visual feedback decoupled from network/DB, learning modes (word order, fill-in, context/grammar/difficult words), server-authoritative anti-double-scoring. | Performance benchmark + race/rapid-tap tests |
| **G07** | Musical Karaoke scoring | `PENDING` | Evidence-based rhythm + pitch (when reference valid) + lyrics + duration scoring modes, capture/playback clock separation, segment practice loop, honest confidence & reports. | Controlled DSP benchmark (`KARAOKE_SCORING_BENCHMARK.json`) + unit/component tests |
| **G08** | Automatic Admin Karaoke | `PENDING` | Simple Mode one-MP3 upload with auto ID3 metadata, vocal/instrumental detection, background staged processing, Review by Exception, preserved Advanced Editor & license gate. | `ADMIN_WORKFLOW_BEFORE_AFTER.md` (>=50% manual step reduction) + admin tests |
| **G09** | AI Memory & Creative Story Game | `PENDING` | New "Bé nhớ được gì?" game with procedural/verified ground-truth scenes, selectable timer starting post-load, free/guided recall, creative extension, separate factual vs creative scoring, reveal learning screen. | Backend + frontend unit/integration tests + `AI_MEMORY_GAME_DESIGN.md` |
| **G10** | Shared voice infrastructure | `PENDING` | Clean mic/TTS lifecycle across games (no TTS self-capture, duplicate suppression, offline/error draft recovery, Android WebView background release). | Speech lifecycle tests + voice regression |
| **G11** | Parent reports | `PENDING` | Integrated parent analytics showing observed vs estimated skills, difficult words practiced, game progress, karaoke segments to practice, next-step tips (no IQ/diagnostic claims). | Report service + UI component tests |
| **G12** | Mobile and APK | `PENDING` | Responsive portrait/landscape, no horizontal overflow, touch targets, WebView media lifecycle, Android JVM/APK checks (and real device test if ADB connected). | `MOBILE_ACCEPTANCE.md` + Android/mobile test logs |
| **G13** | Security and privacy | `PENDING` | Auth, parent/child ownership, RLS, IDOR prevention, prompt-injection fencing, file validation, no secrets/raw audio leaks, additive backward-compatible migrations. | `SECURITY_REVIEW.md` + security tests |
| **G14** | Performance & Zero-Cost | `PENDING` | Measured before/after metrics, zero paid APIs, bounded queues/caches, laptop-off honest degraded mode. | `PERFORMANCE_BEFORE_AFTER.md` + `ZERO_COST_REPORT.md` |
| **G15** | Regression and acceptance | `PENDING` | Independent QA review (12 rounds), OCR/Reading/Auth/Karaoke/Books/Admin full regression PASS, QG01–QG15 evaluated honestly. | `FINAL_TEST_REPORT.md` + `FINAL_QA_REPORT.md` |
| **G16** | GitHub CI, PR and merge | `PENDING` | Clean commits, PR to `main`, CI green, merge if ruleset/approvals allow (or honest blocker report), post-merge smoke verification. | `RELEASE_REPORT.md` + `HANDOVER.md` |
