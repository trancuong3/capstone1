# Security, Privacy, RLS, IDOR & Secrets Review — ViRead Play & Learn V4.0

- **Audit Date:** 2026-11-25
- **Auditor:** `qa-independent` (Fresh Independent QA Lead & Security Auditor — non-author)
- **Branch:** `feature/viread-intelligent-play-learn-v4` (baseline SHA `29e2da36`, HEAD `e5c5f376` + working tree)
- **Overall Security Verdict:** **`CONDITIONAL FAIL — FIX P0/P1 FINDINGS BEFORE MERGE`** (Strong auth/RLS/IDOR/zero-audio/secrets baseline; **1 P0 migration hazard**, **2 P0 ORM crash bugs**, and **2 P1 child-safety/prompt-security defects** identified with exact file/line reproductions)

---

## 1. Executive Audit Matrix

| Security Domain | Audited Artifacts | Status | Summary Evidence |
|---|---|---|---|
| **Parent RBAC & Anti-IDOR** | `adaptive_learning.py`, `memory_game.py`, `karaoke_practice.py`, `picture_description.py`, `sentence_shooter.py`, `deps.py`, `role_cache.py` | **PASS** | Every parent endpoint enforces verified Supabase JWT + active DB role `parent` (`require_parent_id` or `get_cached_profile_role` with `Active == 1`) and scopes child/session queries by `ChildProfile.ParentId == parent_id` (`404` on foreign IDs). |
| **Admin RBAC & Least Privilege** | `karaoke_simple_import.py`, `karaoke_simple_import_service.py` | **PASS** | Both `/admin/songs/simple-import` and `/admin/songs/{song_id}/simple-publish` enforce `require_admin_id` (active DB `Profile.Role == "admin"`) plus defense-in-depth `self.karaoke._actor(actor_id, "admin")`. |
| **PostgreSQL RLS & Additive DDL** | `supabase/migrations/20261125120000_entertainment_v4_ecosystem.sql` + rollback file | **FAIL (P0-1)** | All 5 new tables enable RLS, `REVOKE ALL FROM anon`, grant `SELECT` only to `authenticated` with `parent_id = (select auth.uid())` / `PUBLISHED` policies, and make zero breaking changes to existing tables. **HOWEVER, P0-1:** rollback SQL was placed inside `supabase/migrations/` with duplicate timestamp `20261125120000`, breaking `test_migration_versions.py` and risking `supabase db push` table deletion. |
| **Zero Raw Child Audio Storage** | `karaoke_practice.py`, `schemas/karaoke_practice.py`, `models/entertainment_v4.py`, `lib/karaoke/musical-dsp.ts` | **PASS** | `KaraokePracticeSessionCreate` uses `extra="forbid"`, recursively rejects 15 forbidden audio keys (`raw_audio`, `pcm`, `wav`, `mp3`, `audio_base64`, etc.), caps `report_payload <= 32 KiB`, and DSP runs 100% in-browser RAM with teardown on stop/background/unmount. |
| **Child-Safety Image Moderation (`UNSAFE_PICTURE`)** | `picture_description_ai.py`, `picture_description_service.py` | **PARTIAL / FAIL (P1-1)** | Explicit `PictureSafetyError` (`is_child_safe=False` or Gemini safety block) is strictly non-bypassable (`422 UNSAFE_PICTURE`, zero storage upload). **HOWEVER, P1-1:** `picture_description_service.py:706-723` fails **open** on `CUSTOM_UPLOAD` during transient AI outage/429/`AI_NOT_CONFIGURED`, uploading an unscreened arbitrary user image with synthetic `is_child_safe=True`. |
| **Prompt-Injection Fencing** | `picture_description_ai.py:2358-2363`, `memory_game_evaluator.py:749-769` | **PARTIAL / FAIL (P1-2)** | Picture Description fences `<child_description>` and `<previous_attempt>` with explicit refusal instructions (note P2-6: strip closing tags). **HOWEVER, P1-2:** `memory_game_evaluator.py:763` interpolates raw `response_text[:400]` directly into the LLM prompt without XML fencing or injection-refusal instructions (scores/facts remain protected by deterministic invariant, but child-facing coaching text can be hijacked). |
| **Admin Karaoke Compliance Gate** | `karaoke_simple_import.py`, `karaoke_simple_import_service.py:823-865`, `karaoke-simple-upload-screen.tsx:333-334, 485-486, 1460-1476` | **PASS** | Both `rights_confirmed` and `child_safe_confirmed` initialize to `false` on client and server, stay unchecked on reset/import, disable publish button client-side, and return HTTP `422` server-side in `simple_publish` if either is `false` or notes are empty. Final publish delegates to `KaraokeService.publish()`. |
| **File Upload & Media Hardening** | `karaoke_media_service.py`, `picture_description_service.py` | **PASS** | MP3 uploads enforce `<= 20 MiB`, valid MPEG Layer III, `1..300,000 ms`, SHA-256; embedded `APIC` covers run through `normalize_cover()` with Pillow `DecompressionBombWarning` error filter, `<= 4096 px`, non-animated, EXIF-stripped WebP (`<= 2 MiB`). Picture uploads enforce `<= 5 MiB`, `<= 25M px`, JPEG/PNG/WEBP, EXIF-stripped JPEG (`<= 1280 px`). |
| **Secrets, Tokens & Signed URLs Scan** | 98 V4 backend, SQL, and frontend files | **PASS (0 hits)** | Automated regex scan across all 98 V4 files detected **0** hardcoded Google/Groq/OpenAI keys, JWTs, Supabase PATs, private keys, or signed URLs. API keys read exclusively via `os.getenv`, marked `repr=False`, sent via `x-goog-api-key` / `Authorization` headers, never logged. |
| **Protected Files & Render/OCR Invariants** | `backend/requirements.txt`, `backend/requirements-web.txt`, `backend/app/sever.py`, `backend/app/services/ocr_ai/` | **PASS (0 diff)** | `git diff 29e2da36 -- backend/requirements.txt backend/requirements-web.txt backend/app/sever.py backend/app/services/ocr_ai/` returned **0 lines changed** and `git status` is clean for all 4 protected paths. |

---

## 2. Route-by-Route Auth & IDOR Verification

Every new and modified route mounted in [router.py](file:///f:/Capstone/capstone1/backend/app/api/router.py) was audited line-by-line:

| Router File & Prefix | Endpoint | Auth Dependency | Ownership / Role Enforcement | IDOR Result |
|---|---|---|---|---|
| [adaptive_learning.py](file:///f:/Capstone/capstone1/backend/app/api/routes/adaptive_learning.py) (`/learning`) | `GET /children/{child_id}/profile` | `require_parent_id` (JWT + DB `Role=='parent'` & `Active==1`) | `AdaptiveLearningRepository.get_owned_child(child_id, parent_id)` (`ChildProfile.ParentId == parent_id`, `404`) | **PASS** |
| `adaptive_learning.py` (`/learning`) | `GET /children/{child_id}/recommendations` | `require_parent_id` | Same `_require_child` | **PASS** |
| `adaptive_learning.py` (`/learning`) | `GET /children/{child_id}/parent-analytics` | `require_parent_id` | Same `_require_child` *(blocked by P0-2 runtime crash on real `GameSession` rows)* | **PASS (Auth) / FAIL (P0-2)** |
| `adaptive_learning.py` (`/learning`) | `POST /children/{child_id}/evidence` | `require_parent_id` | Validates `skill_key in VALID_SKILL_KEYS` + `_require_child` | **PASS** *(see P2-2)* |
| [memory_game.py](file:///f:/Capstone/capstone1/backend/app/api/routes/memory_game.py) (`/games/memory`) | `GET /themes` | `require_parent_id` | Static curated catalog | **PASS** |
| `memory_game.py` (`/games/memory`) | `POST /sessions` | `require_parent_id` | `MemoryGameRepository.child_owned_by(child_id, parent_id)` (`404`) *(blocked by P0-3 crash when `focus_words=[]`)* | **PASS (Auth) / FAIL (P0-3)** |
| `memory_game.py` (`/games/memory`) | `GET /sessions` | `require_parent_id` | `child_owned_by` + `list_sessions_for_child(child_id, parent_id)` | **PASS** |
| `memory_game.py` (`/games/memory`) | `GET /sessions/{session_id}` | `require_parent_id` | `get_session_for_parent(session_id, parent_id)` (`MemoryGameSession.ParentId == parent_id`, `404`) | **PASS** |
| `memory_game.py` (`/games/memory`) | `POST /sessions/{session_id}/hint` | `require_parent_id` | `get_session_for_parent` + `increment_hints(session_id, parent_id)` | **PASS** |
| `memory_game.py` (`/games/memory`) | `POST /sessions/{session_id}/peek` | `require_parent_id` | `increment_peeks(session_id, parent_id)` | **PASS** |
| `memory_game.py` (`/games/memory`) | `POST /sessions/{session_id}/attempts` | `require_parent_id` | `get_session_for_parent` + `record_attempt(..., parent_id=parent_id)` | **PASS** *(see P2-1)* |
| [karaoke_practice.py](file:///f:/Capstone/capstone1/backend/app/api/routes/karaoke_practice.py) (`/karaoke`) | `POST /practice-sessions` | `require_parent_id` | `get_child_for_parent(parent_id, child_id)` + raw-audio forbidden schema | **PASS** |
| `karaoke_practice.py` (`/karaoke`) | `GET /practice-sessions` | `require_parent_id` | `get_child_for_parent` + `ParentId == parent_id` SQL filter | **PASS** |
| `karaoke_practice.py` (`/karaoke`) | `GET /songs/{song_id}/musical-profile` | `get_current_parent_id` (verified Supabase JWT) | Strictly verifies `song.status == "PUBLISHED"` and `published is not None` (`404` on drafts/hidden). Public catalog metadata only, no child PII. | **PASS** |
| [karaoke_simple_import.py](file:///f:/Capstone/capstone1/backend/app/api/routes/karaoke_simple_import.py) (`/karaoke`) | `POST /admin/songs/simple-import` | `require_admin_id` (JWT + DB `Role=='admin'` & `Active==1`) | Double-checked via `self.karaoke._actor(actor_id, "admin")` before file/Whisper/DB writes | **PASS** |
| `karaoke_simple_import.py` (`/karaoke`) | `POST /admin/songs/{song_id}/simple-publish` | `require_admin_id` | Enforces `rights_confirmed=True` & `child_safe_confirmed=True` & non-empty notes + delegates to `KaraokeService.publish()` | **PASS** |
| [picture_description.py](file:///f:/Capstone/capstone1/backend/app/api/routes/picture_description.py) (`/games/picture-description`) | All 5 routes | `get_current_parent_id` + service `_require_parent` (`get_cached_profile_role`, `Active == 1`) | `_owned_child` / `get_owned_session_projection(session_id, actor_id)` checking both `Session.ParentId == actor_id` AND `ChildProfile.ParentId == actor_id` | **PASS (Auth) / FAIL (P1-1)** |
| [sentence_shooter.py](file:///f:/Capstone/capstone1/backend/app/api/routes/sentence_shooter.py) (`/games/sentence-shooter`) | All 7 routes | `get_current_parent_id` + service `_require_parent` / `load_shot_bundle` (`Profile.Role=='parent'`, `Profile.Active==1`) | `child_owned_by` / `session_for_parent` (`ChildProfile.ParentId == actor_id`) + `FOR UPDATE` row locks + deterministic `client_shot_id` deduplication | **PASS** |

---

## 3. Detailed Security & Privacy Findings

### [P0-1] Rollback SQL Placed Inside `supabase/migrations/` Causes Duplicate Timestamp & `supabase db push` Hazard
- **Location:** [20261125120000_entertainment_v4_ecosystem_rollback.sql](file:///f:/Capstone/capstone1/supabase/migrations/20261125120000_entertainment_v4_ecosystem_rollback.sql) colliding with [20261125120000_entertainment_v4_ecosystem.sql](file:///f:/Capstone/capstone1/supabase/migrations/20261125120000_entertainment_v4_ecosystem.sql)
- **Reproduction:** `Set-Location backend; .\.venv\Scripts\python.exe -m unittest test_migration_versions -v` fails (`AssertionError: {'20261125120000': ['20261125120000_entertainment_v4_ecosystem.sql', '20261125120000_entertainment_v4_ecosystem_rollback.sql']} != {}`).
- **Risk:** Supabase CLI treats every `*.sql` inside `supabase/migrations/` as an UP migration keyed by timestamp; this both breaks CI and risks dropping all 5 V4 tables immediately after creation.
- **Required Fix:** Move the rollback script to `supabase/rollbacks/20261125120000_entertainment_v4_ecosystem_rollback.sql` (matching existing repo convention `supabase/rollbacks/20261120140000_reading_query_indexes_cleanup_rollback.sql`).

### [P1-1] Child-Safety Screening Fails Open for `CUSTOM_UPLOAD` During Vision AI Outage / Rate-Limit
- **Location:** [picture_description_service.py](file:///f:/Capstone/capstone1/backend/app/services/picture_description_service.py#L706-L723) (and test [test_picture_description.py](file:///f:/Capstone/capstone1/backend/test_picture_description.py#L1616-L1665))
- **Risk:** In pre-V4 baseline (`29e2da36`), `CUSTOM_UPLOAD` failed **closed** if Vision AI could not inspect the uploaded image. V4.0 added `elif exc.retryable or exc.code == "AI_NOT_CONFIGURED":` covering both `BOOK_PAGE` and `CUSTOM_UPLOAD`, synthesizing `PictureGuideRead(is_child_safe=True, ...)` via `build_deterministic_picture_guide()` and then uploading the **unscreened user photo** to Supabase Storage (`L725-735`). During a Gemini/Groq `429` or outage, an arbitrary inappropriate image bypasses safety screening completely.
- **Required Fix:** Restrict deterministic guide fallback to pre-verified catalog sources (`elif source_type == "BOOK_PAGE" and (exc.retryable or exc.code == "AI_NOT_CONFIGURED"):`). For `CUSTOM_UPLOAD`, always fail closed (`raise HTTPException(status_code=exc.status_code, detail=exc.detail)`) and never store or serve unmoderated uploads.

### [P1-2] Unfenced Child Input in Memory Game AI Enrichment Prompt (Prompt Injection)
- **Location:** [memory_game_evaluator.py](file:///f:/Capstone/capstone1/backend/app/services/games/memory_game_evaluator.py#L749-L769)
- **Risk:** Line 763 embeds raw `response_text[:400]` directly into the Gemini/Groq coaching prompt without delimiter fencing or untrusted-input instructions. Although lines 739–747 guarantee deterministic scores/facts cannot be altered, adversarial input in `response_text` can hijack the AI-generated child-facing Vietnamese messages (`praise_message_vi`, `story_praise_vi`, `next_tip_vi`, `creative_followup_vi`).
- **Required Fix:** Sanitize control chars and any closing delimiter tags, fence input inside `<child_response>...</child_response>`, and add an explicit system/prompt rule instructing the model to treat `<child_response>` strictly as untrusted learner text and never follow embedded commands.

### [P2] Additional Security & Hardening Notes
- **P2-1 (Race Condition / Unhandled `IntegrityError`):** [memory_game_repository.py](file:///f:/Capstone/capstone1/backend/app/repositories/memory_game_repository.py#L335-L374) increments `AttemptsCount` without `.with_for_update()` and [memory_game.py](file:///f:/Capstone/capstone1/backend/app/api/routes/memory_game.py#L90-L97) does not catch `IntegrityError`. Also [memory_game_repository.py](file:///f:/Capstone/capstone1/backend/app/repositories/memory_game_repository.py#L183) should parameterize `to_regclass(:table_name)` instead of f-string interpolation (no SQLi currently since callers pass hardcoded constants, but defense-in-depth).
- **P2-2 (Duplicate Evidence Handling):** [adaptive_learning_service.py](file:///f:/Capstone/capstone1/backend/app/services/adaptive_learning_service.py#L858-L893) `record_evidence` does not catch `IntegrityError` on `uq_learning_skill_evidence_dedupe` or missing-table `ProgrammingError`.
- **P2-6 (XML Fence Tag Escaping):** [picture_description_ai.py](file:///f:/Capstone/capstone1/backend/app/services/picture_description_ai.py#L2325) should strip `</child_description>` and `</previous_attempt>` from untrusted text prior to wrapping in XML delimiters.

---

## 4. Database RLS & Privacy Checklist (`20261125120000_entertainment_v4_ecosystem.sql`)

- [x] `ENABLE ROW LEVEL SECURITY` on all 5 new tables (`learning_skill_evidence`, `memory_game_sessions`, `memory_game_attempts`, `karaoke_practice_sessions`, `karaoke_musical_profiles`).
- [x] `REVOKE ALL ON TABLE ... FROM anon;` executed for all 5 tables.
- [x] `GRANT SELECT ON TABLE ... TO authenticated;` only (zero direct client `INSERT`/`UPDATE`/`DELETE`; all mutations go through authenticated FastAPI backend).
- [x] Parent read policies use `(select auth.uid())` initPlan optimization (`parent_id = (select auth.uid())` or `EXISTS` parent-owned session).
- [x] `karaoke_musical_profiles` read policy strictly requires `v.state = 'PUBLISHED'`.
- [x] Zero destructive DDL (`DROP`, `RENAME`, breaking `ALTER`) on existing tables.
- [x] Zero raw audio columns or audio binary blobs in any new table.
- [ ] **BLOCKED (P0-1):** Rollback file must be moved out of `supabase/migrations/` to `supabase/rollbacks/`.

---

## 5. Secrets & Protected Files Audit Proof

- **Secrets Scan Command:** Python regex scan (`AIza...`, `gsk_...`, `sk-...`, `eyJhbGciOi...`, `supabase.co/storage/v1/object/sign`, `sbp_...`, `BEGIN ... PRIVATE KEY`) over **98 V4 files** (backend, migrations, frontend components/hooks/libs/types).
  - **Result:** **`0` matches** (exit code `0`).
- **Protected Files Check Command:** `git diff 29e2da36 -- backend/requirements.txt backend/requirements-web.txt backend/app/sever.py backend/app/services/ocr_ai/` and `git status --short -- ...`
  - **Result:** **Empty diff / 0 modifications** (Render Free 512 MiB dependency envelope and locked OCR ABI pins 100% preserved).
