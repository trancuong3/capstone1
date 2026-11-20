# TASK 02 — Supabase security hardening review

**Scope:** `trancuong3/capstone1`, Supabase project `hgkklatgepyzbkkmwfvp`, 2026-11-20.
**Production:** metadata-only read access. No production SQL writes, migrations,
auth configuration changes, secrets, test user records, or RLS changes.
**Proposed PR:** `fix/supabase-security-hardening` → `main`; manual approval
required before production deployment. Existing API-security PR #134 remains separate.

## Evidence: actual production catalog and Security Advisor

- `public.handle_new_readalong_user()`: `SECURITY DEFINER`, owner `postgres`,
  `RETURNS trigger`, `search_path = ''`. Explicit EXECUTE grants to
  `anon`, `authenticated`, `service_role`, `postgres`. Active
  `AFTER INSERT` trigger `on_auth_user_created_readalong` on `auth.users`.
  Source checks email and inserts a `parent` profile through fully qualified
  `public.profiles`. Signup must remain functional.
- `public.rls_auto_enable()`: `SECURITY DEFINER`, owner `postgres`,
  `RETURNS event_trigger`, `search_path = pg_catalog`. EXECUTE to `PUBLIC`
  and explicit `anon`, `authenticated`, `service_role`, `postgres`.
  Enabled event trigger `ensure_rls` on `ddl_command_end` for
  `CREATE TABLE`, `CREATE TABLE AS`, `SELECT INTO`.
- Advisor: 0028 (anon callable): 2 warnings; 0029 (authenticated callable):
  2 warnings; 0008 (RLS enabled/no policy): 32 informational notices.
- `public.profiles` has `profiles_select_own` and `profiles_update_own`,
  but `anon` and `authenticated` currently both hold table-level **ALL**.
  In particular, `authenticated` can update `role`, `active`, `id`,
  `createdat`, despite an owner-only row predicate. **Critical privilege
  escalation**: owner-only RLS does not constrain editable *columns*.
  The original 20260928144208 migration intended to grant only SELECT and
  `UPDATE(displayname)` to `authenticated`; grants have drifted since then.

`RETURNS trigger` / `RETURNS event_trigger` are special PostgreSQL return
types, not ordinary RPC results; an advisory warning by itself does not
demonstrate a successful remote RPC invocation. Nevertheless, client EXECUTE
on privileged functions is unnecessary and must be revoked. Do **not**
remove the trigger, change its definer owner, or make it SECURITY INVOKER.

## Proposed migration

`supabase/migrations/20261120100000_supabase_security_hardening.sql`:

1. Transactional preflight checks that both functions exist and are SECURITY
   DEFINER of the expected types, and that their active Auth/event triggers
   and existing service-role grants remain present.
2. Revoke EXECUTE from `PUBLIC`, `anon`, `authenticated` **only** for
   the two named functions. Preserve `postgres`, `service_role`,
   function definitions, search_path, and trigger bindings.
3. Revoke broad table privileges on `public.profiles` from
   `PUBLIC`, `anon`, `authenticated`. Restore `SELECT` to
   `authenticated` plus column-level UPDATE for `displayname`,
   `contact_phone` and `avatar_path` only. Preserve `service_role`.
   The existing ownership RLS policies stay enabled and unchanged.
4. Verify privileges after changes before COMMIT. Any check failure raises
   an exception and atomically rolls back the whole migration. Script is
   idempotent.

No `CREATE POLICY`, `DISABLE ROW LEVEL SECURITY`, mass `GRANT`,
`ALTER FUNCTION ... SECURITY INVOKER`, or production data migration.

### Rollback / compatibility plan

**Before deploying**, an authorized DBA should capture and review
`pg_get_functiondef`, `pg_proc.proacl`, `pg_class.relacl`, policy definitions,
trigger states and function owner. The PR's audit is a reference snapshot,
not a substitute for a current backup.

- If a deployment fails *inside the migration*, the enclosing transaction
  rolls back automatically; no manual permission restoration is needed.
- If signup or a legitimate flow fails *after deployment*, investigate
  the exact failing DB role, SQLSTATE and auth trigger, and **roll forward**
  with the minimum necessary permission for that trusted internal role.
  Re-run signup, RLS and owner tests in staging before production.
- **Do not use a blanket automatic DOWN migration that grants
  `UPDATE(role, active)` back to `authenticated`**; that would
  restore a verified privilege-escalation exposure. Restoring old client
  EXECUTE permissions on SECURITY DEFINER functions would also re-open
  the Advisor findings. Any such emergency rollback requires explicit
  security approval and is not shipped as an executable script.
- No changes were made to the privileges of `service_role`.

## 32 policy-free RLS tables — grouped by purpose

The catalog confirms all 32 tables have `relrowsecurity = true` and zero
policies. Browser roles are **default-denied for row operations**;
some tables still have overly broad table ACLs (RLS is defense in depth).
These are not automatically a public-data leak, and no policies are added
without business-level access requirements and staging verification.

| Group | Tables | Treatment |
|---|---|---|
| Child and family evidence (11) | `auditlogs`, `childprofiles`, `comprehensionanswers`, `comprehensionquestions`, `consentrecords`, `fluencyassessments`, `progressreports`, `readingcomparisonreports`, `readingevents`, `readingsessionpages`, `readingsessions` | Keep deny-by-default; backend enforces parent ownership for exposed endpoints |
| Book/OCR production and quality (10) | `books`, `bookpages`, `pagerevisions`, `pagerevisionwords`, `bookcontentreports`, `bookcontentreporthistory`, `bookqualityfindings`, `bookqualitypagescans`, `bookqualityreportfindings`, `bookqualityscanruns` | Keep backend/admin-only. Public book catalog is intentionally provided through FastAPI, not unrestricted Data API |
| Model and training control (10) | `viread_ocr_active_model`, `viread_ocr_benchmarks`, `viread_ocr_checkpoint_chunks`, `viread_ocr_dataset_versions`, `viread_ocr_evaluation_cohorts`, `viread_ocr_model_decisions`, `viread_ocr_outbox`, `viread_ocr_samples`, `viread_ocr_training_jobs`, `viread_ocr_training_runs` | Keep privileged worker-only, no public policies |
| Admin AI workflow (1) | `adminaiworkflows` | Keep internal-only |

### Existing RLS policies reviewed

`profiles` permits only own-row SELECT/UPDATE, with the column-grant flaw
addressed in this migration. `childbookcollections`, `readinggoals`,
`readingplans`, `readingreminders`, `readingreminderoccurrences`,
`readingreminderemaildeliveries`, `gamesessions`, `gamerounds`,
`gameattempts`, `picturedescriptionsessions`,
`picturedescriptionattempts`, `difficult_word_practice_attempts`
use `auth.uid()` ownership predicates (or a parent-owned child/session
subquery). The four karaoke processing tables have service_role-only RLS
policies; Storage karaoke/avatars are server-only.

**Residual compatibility risk:** Parent-owned policies often reference
`childprofiles`, whose own RLS currently has no policy. Such client-side
subqueries may return zero rows even for the owner; this is fail-closed but
could break any direct Supabase Data API screens. The current
`frontend/lib/api/profile-service.ts` uses authenticated FastAPI
`/profiles/me` routes for profile writes, so this migration does not
need to open `childprofiles` RLS. Validate other flows in staging.

**Additional ACL follow-up:** Several policy-free tables have table-level
ALL granted to `anon` / `authenticated` even though RLS blocks ordinary
row operations. Audit dangerous non-RLS operations (for example TRUNCATE)
separately before making mass permission changes.

## Security tests and CI

- `supabase/tests/security_hardening_disposable.sql` creates a synthetic
  `auth.users`, `public.profiles`, RLS policy, two actual definer function
  contracts and both triggers in a dedicated throwaway PostgreSQL database.
- The test runs the *exact migration file twice*, then checks client-denied
  EXECUTE, unchanged service_role privileges, role/active update denial,
  benign profile edits, parent A/B isolation, Auth signup trigger, event
  trigger RLS auto-enable, and policy-free table default deny.
- `.github/workflows/supabase-security-hardening.yml` starts PostgreSQL 17
  exclusively in GitHub Actions and destroys the test database.
- Production is read-only and cannot be used to validate a permission
  change that has **not** been deployed; re-read Advisor after applying in
  approved staging/production to verify the 0028/0029 findings clear.

Run only against a disposable CI database named `viread_security_ci`.
The script refuses a differently named database.

## Leaked Password Protection: Dashboard-only action

Production Security Advisor reports the feature disabled; no account
security settings were changed via SQL or API.

1. Open the project
   [Email Auth settings](https://supabase.com/dashboard/project/hgkklatgepyzbkkmwfvp/auth/providers?provider=Email)
   (Dashboard → Authentication → Providers → Email).
2. Find password security / **Leaked Password Protection** and enable
   the option, then save.
3. Return to **Security Advisor** and verify the warning disappears.
   Test signup and password reset with a safe test account in staging.

Supabase documents that leaked-password protection is available on
**Pro plans and above**; if the toggle is unavailable on the current plan,
record this blocker instead of assuming the feature was enabled.
Official reference:
https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## Approval gates

- [ ] CI disposable PostgreSQL migration/trigger/RLS test PASS
- [ ] Existing backend/frontend CI PASS on this PR head
- [ ] Stage against a *production-like schema* with no live user data
- [ ] Review profile update flows, Auth signup, admin deactivation, service-role jobs
- [ ] DBA explicitly approves production migration
- [ ] Security Advisor rechecked after actual approved deployment

This branch is intentionally not a production deployment.
