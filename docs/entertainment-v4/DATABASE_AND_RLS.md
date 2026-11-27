# ViRead Play & Learn V4.0 — Database Schema, RLS & Privacy Design

- **Migration**: `supabase/migrations/20261126130000_entertainment_v4_ecosystem.sql`
- **Rollback**: `supabase/rollbacks/20261126130000_entertainment_v4_ecosystem_rollback.sql`
- **Disposable Test**: `supabase/tests/entertainment_v4_disposable.sql`
- **ORM Models**: `backend/app/models/entertainment_v4.py`

---

## 1. Backward Compatibility & Zero-Downtime Strategy

- **Strictly additive migration**: Zero `DROP`, `RENAME`, or breaking `ALTER COLUMN` statements on any existing table (`books`, `bookpages`, `readingsessions`, `karaoke_songs`, `karaoke_song_versions`, `gamesessions`, `picturedescriptionsessions`, etc.).
- **Satellite table for musical profiles**: `karaoke_musical_profiles` references `karaoke_song_versions(id)` via `ON DELETE CASCADE` instead of adding a required column to `karaoke_song_versions`, ensuring existing `SELECT` queries never break if application code deploys before the SQL migration runs.
- **Graceful degraded reads/writes**: V4 repositories wrap queries against new tables in nested savepoints and gracefully handle `UndefinedTableError` so existing flows never return `500` on an unmigrated database.

---

## 2. New Tables & Data Minimization

| Table | Purpose | Retention & Privacy Guard |
|---|---|---|
| `public.learning_skill_evidence` | Normalized skill observations (`0..1`), confidence (`0..1`), source module, idempotent dedupe key | No raw audio, no full transcripts; compact JSON metadata only |
| `public.memory_game_sessions` | Deterministic `scene_seed`, `scene_spec` JSONB (~3 KB SVG ground truth), timer/recall settings, best scores | Zero image binary storage; 0 bytes Supabase Storage egress |
| `public.memory_game_attempts` | Child text recall/creative responses + structured matched/missed facts & dual scores | Parent-scoped via `session_id` cascade |
| `public.karaoke_practice_sessions` | Compact musical sub-scores (`rhythm`, `pitch`, `lyrics`, `fluency`), `scoring_mode`, timestamped segment report JSONB | **Strictly zero raw child audio recordings stored** |
| `public.karaoke_musical_profiles` | Compact BPM, audio type, beat grid & quantized reference contour per `song_version_id` | Public read limited to `PUBLISHED` versions only |

---

## 3. Row-Level Security (RLS) & Access Controls

1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is enabled on all 5 tables.
2. `REVOKE ALL ON TABLE ... FROM anon;` guarantees anonymous clients cannot read or write any child learning or gameplay data.
3. `authenticated` role is granted `SELECT` only (all writes go through authenticated FastAPI backend using `require_parent_id` or `require_admin_id` with database role verification):
   - `learning_skill_evidence_parent_reads`: `parent_id = (select auth.uid())`
   - `memory_game_sessions_parent_reads`: `parent_id = (select auth.uid())`
   - `memory_game_attempts_parent_reads`: `EXISTS` parent owns `memory_game_sessions`
   - `karaoke_practice_sessions_parent_reads`: `parent_id = (select auth.uid())`
   - `karaoke_musical_profiles_published_reads`: `EXISTS` version `state = 'PUBLISHED'`
4. Backend service layer additionally verifies `ChildProfile.ParentId == parent_id` on every single request (preventing IDOR even when running through backend service-role DB connection).
