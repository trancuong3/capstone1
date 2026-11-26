# ViRead Intelligent Play & Learn V4.0 — Engineering & Operations Handover

- **Date**: 2026-11-25
- **Branch**: `feature/viread-intelligent-play-learn-v4`
- **Production Targets**: Vercel (`https://viread-frontend.vercel.app/`) + Render Free 512 MiB (`https://capstone1-ssd8.onrender.com/`) + Supabase PostgreSQL

---

## 1. Key Entrypoints & Module Map

### Backend (`backend/app/`)
- **Central Router**: `backend/app/api/router.py` mounts all 16 new V4 routes:
  - `/learning/*` -> `app/api/routes/adaptive_learning.py` -> `AdaptiveLearningService` -> `AdaptiveLearningRepository`
  - `/games/memory/*` -> `app/api/routes/memory_game.py` -> `MemoryGameService` -> `memory_scene_generator.py` + `memory_game_evaluator.py` -> `MemoryGameRepository`
  - `/karaoke/practice-sessions` & `/karaoke/songs/{song_id}/musical-profile` -> `app/api/routes/karaoke_practice.py` -> `KaraokePracticeService` -> `KaraokePracticeRepository`
  - `/karaoke/admin/songs/simple-import` & `/karaoke/admin/songs/{song_id}/simple-publish` -> `app/api/routes/karaoke_simple_import.py` -> `KaraokeSimpleImportService` + `karaoke_media_service.py`
  - Enhanced `/games/picture-description/*` and `/games/sentence-shooter/*` (100% backward-compatible with V3 clients)
- **ORM Models**: `backend/app/models/entertainment_v4.py` (`LearningSkillEvidence`, `MemoryGameSession`, `MemoryGameAttempt`, `KaraokePracticeSession`, `KaraokeMusicalProfile`)
- **Database Migration**: `supabase/migrations/20261126120000_entertainment_v4_ecosystem.sql`
- **Database Rollback**: `supabase/rollbacks/20261126120000_entertainment_v4_ecosystem_rollback.sql`

### Frontend (`frontend/`)
- **Entertainment Hub V4.0**: `components/entertainment/entertainment-screen.tsx`
- **AI Memory Game ("Bé nhớ được gì?")**: `app/(app)/entertainment/memory-game/page.tsx`, `components/entertainment/memory-game/{memory-game-screen.tsx,memory-scene-canvas.tsx}`, `lib/api/memory-game-service.ts`, `types/memory-game.ts`
- **AI Teacher V4.0**: `components/entertainment/picture-description/picture-description-screen.tsx`
- **Real-Time Sentence Shooter V4.0**: `components/entertainment/sentence-shooter/{sentence-shooter-screen.tsx,shot-queue.ts,stage-layout-cache.ts,sound-engine.ts}`
- **Musical Karaoke DSP & Segment Practice**: `lib/karaoke/{musical-dsp.ts,musical-scoring.ts,musical-practice.ts}`, `hooks/{use-karaoke-scoring.ts,use-karaoke-player.ts}`, `components/karaoke/{karaoke-stage.tsx,syllable-lyrics.tsx,karaoke-player-screen.tsx}`
- **Admin Karaoke Simple Mode**: `components/admin/karaoke/{karaoke-simple-upload-screen.tsx,karaoke-workspace-screen.tsx,syllable-timing-editor.tsx}`, `lib/karaoke/audio-type-classifier.ts`, `lib/api/karaoke-simple-import-service.ts`
- **Parent Learning Analytics**: `components/reports/entertainment-learning-summary.tsx` (embedded in `progress-report-screen.tsx`)

---

## 2. Deployment & Operations Runbook

1. **Apply Additive SQL Migration** in Supabase before (or alongside) backend deploy:
   ```sql
   -- Run supabase/migrations/20261126120000_entertainment_v4_ecosystem.sql
   ```
   *(If backend deploys first, all V4 endpoints degrade safely without HTTP 500.)*
2. **Rollback Plan** (if ever needed):
   - Revert PR commit on `main`.
   - Optionally run `supabase/rollbacks/20261126120000_entertainment_v4_ecosystem_rollback.sql` (drops ONLY the 5 new additive V4 tables; zero impact on existing reading, books, profiles, or karaoke catalog tables).
3. **Optional Free-Tier AI Keys on Render**:
   - Keep `GEMINI_API_KEY` (and optional fallback model env) configured.
   - Optionally add `GROQ_API_KEY` (Free Tier) to unlock Groq LLM coaching fallback and 2–5s `whisper-large-v3-turbo` draft lyrics in Admin Karaoke Simple Mode.
   - Keep `PICTURE_DESC_HEDGED_GEMINI=false` (default) to protect Gemini Free Tier quota.

---

## 3. Recommended Post-Merge Verification Checklist

1. Confirm GitHub Actions `backend-tests.yml` and `frontend-tests.yml` pass green on the PR.
2. On a physical Android phone (`APK` / Chrome mobile):
   - Verify Entertainment Hub 4-zone touch targets (`>=48px`), `Giảm chuyển động`, and onboarding persistence.
   - Verify Sentence Shooter rapid tapping feels instant (`<100ms`) on cellular latency.
   - Verify Karaoke microphone DSP scoring in both headphone mode and speaker mode + `viread:android-background` audio/mic release when locking screen.
   - Verify `"Bé nhớ được gì?"` SVG rendering, timer start post-render, reveal spotlights, and voice recall.
3. Optional P2 backlog item (documented in `FINAL_QA_REPORT.md`):
   - Add an explicit child selector dropdown on `EntertainmentScreen` for multi-child households (currently defaults to `children[0]`) and wire hub sound/motion `localStorage` preferences into individual game sub-screens.

---

## 4. Complete Documentation Index

See `docs/entertainment-v4/EVIDENCE_INDEX.md` for links to all 27 research, architecture, benchmark, security, performance, QA, and test evidence documents.
