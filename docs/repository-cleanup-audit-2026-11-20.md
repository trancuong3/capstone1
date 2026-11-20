# TASK 08 — Repository cleanup & documentation audit

**Evidence date:** 2026-11-20. **Repository:** [trancuong3/capstone1](https://github.com/trancuong3/capstone1).
**Audited base:** `main` `1698c4a91abb0e51de6b88cb4dc42233d205f046`.
**Working branch:** `chore/repository-cleanup-docs`.
**Scope:** Repository Git objects and source/docs on GitHub, Supabase catalog metadata only. No local Windows files/stashes or production data were modified.

## 1. Tracked Graphify output — confirmed generated

GitHub Git Trees `graphify-out/cache/` under the audited `main` reports:

| Cache category | Files | Git blob content bytes |
|---|---:|---:|
| `ast/v0.9.112-s48-gd93bdf18e146/*.json` | 516 | 10,890,970 |
| `stat-index.json` | 1 | 326,445 |
| `last_query_stamp` | 1 | 17 |
| **Total** | **518** | **11,217,432 (10.70 MiB)** |

No other tracked objects were present under `graphify-out/`. Existing
`.gitignore` already contains `graphify-out/` (it never removed *already
tracked* files), and `.graphifyignore` independently excludes the same
directory. The Git history and the upstream Graphify skill both confirm that
this is local/generated AST/graph state, **not a required canonical codebase
configuration**.

**Action taken:** Stop tracking precisely those 518 blobs in a branch commit;
never delete the generated data from the old Git history, never force-push,
and do not touch any sibling agent/config tree. The next checkout of this branch
does not include this stale cache; a developer's pre-existing local copy may
need regeneration after switching branches. The GitHub repository's *current
tree* loses 10.70 MiB of tracked cache data; this **does not shrink existing
Git commit history** and does not imply the download or disk footprint of every
existing clone shrank by 10.70 MiB.

### Restore/rebuild without losing agent capabilities

- Code analysis: use exact code search when known, no Graphify build needed.
- For a fresh knowledge graph: from the project root and existing Python
  environment, use a working Graphify CLI, e.g.
  `python -m graphify update .` when repeated structural queries justify it.
- Respect `.graphifyignore` to avoid indexing agent/skill infrastructure.
- Graphify generation and query both stay *local*. Generated cache remains
  ignored by Git; do not commit with `git add -f`.
- Previously committed blobs are still retrievable from Git history or the
  backup branch; removing them from `HEAD` is not a history rewrite.
- The contract is enforced by `scripts/verify_repository_hygiene.py` and
  `scripts/validate_agent_config.py` in the new
  `.github/workflows/repository-hygiene.yml`.

**No deletions or edits** to `AGENTS.md`, `backend/AGENTS.md`,
`frontend/AGENTS.md`, `.agent-library/`, `.agents/`, `.codex/`,
`skills-lock.json`, their skill router, the `graphify` skill or
`.graphifyignore`. These remain tracked. The validator additionally checks
that generated `graphify-out/` is not tracked.

## 2. README, setup and production metadata corrections

| Previously documented | Verified source of truth | Documentation change |
|---|---|---|
| Repository `private` | GitHub repository metadata: `visibility=public` | Correct clone instructions and legal disclosure |
| Profiles/auth FK `NOT VALID` | Supabase production read-only `pg_constraint`: `profiles_id_auth_users_fkey`, `convalidated=true`, FK to `auth.users(id) ON DELETE CASCADE` | Distinguish *historical migration* from current constraint; do not advise unnecessary VALIDATE |
| Profile API not verified and frontend only mock | `backend/app/api/deps.py`, `backend/app/api/routes/profile.py`; `frontend/lib/api/profile-service.ts` uses bearer access token and `/profiles/me` | Describe actual auth and API-backed routes while retaining fixture limitations |
| Reports/sessions only mock | `frontend/lib/api/report-service.ts`, `reading-service.ts`, `session-service.ts` perform typed FastAPI calls | Replace sweeping mock claims; do not claim production acceptance without staging |
| `develop` as required integration branch | Branch search returned no `develop`; actual CI triggers PRs to `main` | Update CONTRIBUTING and README |
| Branch protected by policy text alone | GitHub metadata on audited main: `protected=false` | Distinguish team convention from enforced GitHub Ruleset |
| No live frontend reading/evidence path | Routes/services/tests exist, but device and model availability are environment-specific | Describe implemented code paths without promising every provider works |
| No license because private | No root `LICENSE` and repository **public** | Disclose that public visibility alone does not grant a reuse license |

**Supabase safety:** The FK/RLS inspection used system catalog SELECT only;
no `auth.users`, child records, secrets, or business rows were inspected or
modified. The historical migration containing `NOT VALID` is **intentionally
preserved** as migration history; it must not be rewritten to pretend it always
validated.

**Documentation updated:** `README.md`, `frontend/README.md`,
`CONTRIBUTING.md`. Existing `docs/RENDER_SUPABASE_DEPLOYMENT.md`,
`backend/.env.example` and `frontend/.env.example` supply the scoped
connection/setup details; no database credentials or runtime config were
modified. Backend entrypoint remains `app.sever:app`, Python 3.12, Node 22+,
and GitHub workflow names are taken from `.github/workflows/`.

## 3. Stale draft PRs: do not close automatically

### [PR #57 — OCR confidence calibration](https://github.com/trancuong3/capstone1/pull/57)

- As inspected: **open Draft**, created 2026-11-04; base `main`.
- Current diff comparison: **diverged: ahead 94 / behind 633**,
  with 26 changed paths; includes backend OCR reading / word-confidence logic,
  Admin UI, reading reports and tests.
- **Recommendation:** **keep as Draft for targeted review**, then update or
  extract still-useful patches into a clean branch against current `main`;
  rerun real OCR plus backend/frontend CI. This work is security/accuracy
  sensitive; never merge a diverged older branch without deduplication.
- Consider **closing only after** all needed improvements are included in
  another reviewed PR or the owner explicitly rejects the scope.

### [PR #81 — Parent responsive navigation](https://github.com/trancuong3/capstone1/pull/81)

- As inspected: **open Draft**, created 2026-11-10; base `main`.
- Current diff comparison: **diverged: ahead 58 / behind 296**,
  with 23 changed paths; Parent navigation, selected-child state,
  reports and session UI/tests.
- **Recommendation:** compare against current Parent screens and select
  only outstanding UX/ownership improvements; update/rebase or cherry-pick
  safe, relevant commits into a reviewed branch after CI + viewport tests.
  Do not merge original stale diff as-is. Recommend closing the old PR
  **only after owner approval** and/or migration of the outstanding work.

**No PR was closed, merged, rebased or edited during TASK 08.**

## 4. License decision (owner-only)

GitHub reports repository visibility `public`, and the root Git tree
contains no `LICENSE` file. Public visibility allows browsing/forking
within GitHub's applicable terms but **does not automatically grant an
open-source license** for redistribution or derivative uses.

The owner should decide the desired distribution policy after reviewing
third-party dependencies, fonts, model/checkpoint/asset licensing,
sample books/images and contributor ownership. This task **does not add
a LICENSE or choose one**.

## 5. Validation and CI

This cleanup is limited to generated Graphify state and documentation plus
a small CI guard. No FastAPI/Next.js application code, requirements,
business schema, model weights, production deployment or user data changed.

Commands in the new PR-only GitHub Actions job:

```bash
python3 -B scripts/validate_agent_config.py
python3 -B scripts/verify_repository_hygiene.py
```

The second script checks that Git tracks zero `graphify-out/` entries,
the Graphify ignore rule matches future generated files, and all critical
agent/skill rules remain tracked. It also flags a regression to outdated
README claims. Both commands are read-only.

Backend, frontend, Playwright and real OCR CI still execute as configured on
PRs into `main`; successful CI for *this exact branch head* is required
before declaring completion. The connected GitHub tool cannot run an
existing Windows workspace or inspect its uncommitted changes; this task
never attempted to mutate the user's local working copy.

## 6. Risks and rollback

1. If an agent expected a *freshly tracked* AST cache, it must regenerate
   `graphify-out/` locally; query-only tools should fall back to exact
   search in the meantime. Old cached AST was version-stamped and could be
   stale relative to the current code even before cleanup.
2. The 10.70 MiB reduction applies to the **new tracked tree**, not historical
   storage. A history rewrite would be destructive and is explicitly out of
   scope.
3. The current GitHub branch is **not yet protected** according to audited
   metadata; the repo owner must configure Rulesets to enforce required CI.
4. If any cleanup effect is unacceptable, revert the cleanup commit through
   a new PR; do not force-push or reset local changes. Restoring the tracked
   cache is not normally recommended.

**No merge, no production deployment, no local data deletion.**
