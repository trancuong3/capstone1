# TASK 03 — Protect main and require GitHub Actions CI

Audited: 2026-11-20, repository `trancuong3/capstone1` (public).
Base at review: `main` `ebc1bcb171f622c7d92612c26813276720a8b0e2`.

## Verified actual repository state

- `main` is the default branch. GitHub's branch metadata reported
  `protected: false` and `required_status_checks.enforcement_level: off`.
- `GET /repos/trancuong3/capstone1/rulesets` returned an empty array.
- The connected GitHub App can inspect workflow code, jobs, runs and PRs,
  but the branch-protection read endpoint returned
  `403 Resource not accessible by integration`. The connector does not offer
  a ruleset/protection mutation. **This PR does not change repository Settings.**
- GitHub Actions had successful required-candidate jobs (verified from
  *completed runs*, not guessed workflow filenames):
  - Backend Tests, run
    [44663598155](https://github.com/trancuong3/capstone1/actions/runs/44663598155):
    `Backend unit and API tests` — PASS;
    `Real OCR model quality gate` — PASS.
  - Frontend Checks, run
    [44663598271](https://github.com/trancuong3/capstone1/actions/runs/44663598271):
    `Frontend tests, typecheck, lint and build` — PASS.
  - Admin Book CRUD Verification, run
    [44666830708](https://github.com/trancuong3/capstone1/actions/runs/44666830708):
    `Frontend format, lint, typecheck, tests, build and E2E` — PASS,
    including `Run end-to-end tests` and `Check whole-repository formatting`.
  - Supabase Security Hardening, run
    [44666830912](https://github.com/trancuong3/capstone1/actions/runs/44666830912):
    `Auth trigger, definer ACL, RLS and profile privilege regression` — PASS,
    previously *path-filtered*, now unconditional on main PRs in this PR.

## Workflow findings and fixes

| Workflow | Trigger / CI contract | Action |
|---|---|---|
| `backend-tests.yml` | Main PR and push; no paths filter; both unit/API and real OCR mandatory | Keep stable two job names, protect via Ruleset |
| `frontend-tests.yml` | Main PR and push; full `npm run verify`, production build, Playwright OCR draft; no continue-on-error | Protect via Ruleset |
| `admin-book-crud-verification.yml` | Every main PR, E2E; full formatting was `continue-on-error: true` | Remove the bypass; full formatting now blocks E2E job |
| `supabase-security-hardening.yml` | PR previously path-filtered, unsuitable as a required check | Run on **every** main PR and main push |
| `admin-books-ocr-full-verification.yml` | PR only on `frontend/**`; steps use continue-on-error followed by an `always()` failure aggregator | **Optional only**, do not configure as a required check; final aggregator fails the job on any failed step |
| `format-admin-ocr.yml` | Feature branch push only; contents:write and autoformat commit to feature branch | Never target main; not a required check. Review write token if feature maintenance is retired |
| `required-ci-contract.yml` | Added: every main PR and push, stdlib-only CI policy regression | Add its job to required checks after first successful run |

The added `.github/scripts/test_required_ci_contract.py` fails if a required
workflow becomes path-filtered, stops running for main PRs or pushes, renames a
required job, gains job-level skip/needs or continue-on-error, or drops its
test/build commands. The existing backend/frontend workflows already discover
`.github/scripts/test_*.py` early, so the contract has multiple CI witnesses.

Do not require **a workflow display name** or its YAML filename; GitHub's
required check selector uses the exact **job check-run display name**.
Do not choose `Full Frontend verification` from the path-filtered optional
workflow: it may be missing on unrelated PRs.

## Owner action — GitHub repository Ruleset (not performed by the connector)

Open
[Settings → Rules → Rulesets](https://github.com/trancuong3/capstone1/settings/rules)
with the repository owner's account:

1. **New ruleset → New branch ruleset**. Name:
   `Protect main — mandatory CI`.
2. **Enforcement status: Active** (not Evaluate or Disabled).
   **Target branches**: Include default branch / `main` only.
3. **Bypass list: empty**, including administrators and automation.
   If a future emergency actor is authorized, require explicit, audited approval
   and preferably **pull-requests-only** bypass instead of always bypass.
4. Enable **Require a pull request before merging**. Choose appropriate
   required reviewers if an *independent reviewer exists*. For a solo-developer
   personal repo, requiring 1 approval can deadlock because GitHub prevents
   self-approval; 0 approvals with a mandatory PR still enables CI enforcement.
   Enable dismiss stale approvals if approvals are used.
5. Enable **Require status checks to pass**. Set **Require branches to be
   up to date before merging** (strict). Require these exact six job names:

   - `Backend unit and API tests`
   - `Real OCR model quality gate`
   - `Frontend tests, typecheck, lint and build`
   - `Frontend format, lint, typecheck, tests, build and E2E`
   - `Auth trigger, definer ACL, RLS and profile privilege regression`
   - `Required CI policy contract`

   For each check, choose **GitHub Actions** as the expected source when offered.
   The last check is new; allow it to complete once on this PR before selecting.
   Do not select the optional `Full Frontend verification` or the feature
   formatter job.
6. Enable **Block force pushes** and **Restrict deletions**; disable any
   option permitting force pushes. Do **not** enable **Restrict updates** with
   an empty bypass list — that rule can block legitimate PR merges as well as
   direct pushes. The PR + required-check rules already prevent ordinary direct
   pushes to main.
7. Save/confirm the new ruleset. Verify that it appears **Active** and covers
   `main`. Do not use a duplicate classic branch rule unless necessary.

For classic Branch Protection instead, navigate to
[Settings → Branches](https://github.com/trancuong3/capstone1/settings/branches),
add a rule for `main`, require PR/status checks with strict updates,
**include administrators** in protections, and do not allow force pushes
or deletions. Rulesets provide clearer bypass auditability.

### Proof of enforcement (do not modify production data or force push)

1. Re-read `GET /repos/trancuong3/capstone1/branches/main` to verify
   `protected: true`, and `GET /repos/trancuong3/capstone1/rulesets`
   to confirm an active main ruleset; an owner may need to verify via Settings
   because the installed GitHub App lacks administration permissions.
2. Open a test PR with one intentionally failing non-destructive assertion
   on a temporary branch. Confirm merging is blocked while a **required job**
   is FAIL, pending, or missing; then **fix the test** and rerun CI.
   Do not lower assertions or merge the test PR.
3. Confirm a direct push to `main` by a normal write user is rejected.
   Do **not** experiment with force push on main.
4. Confirm a passing PR to main only becomes mergeable after all six checks
   pass and the branch is up to date.
5. If merge queue is enabled in the future, add `merge_group` triggers to
   all required workflows before activating it; otherwise merge-queue
   status checks will be missing.

GitHub documentation:
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks

## Remaining risks

- **Not protected until the owner enables the Ruleset**. Changing CI YAML
  alone does not stop a user with write access from pushing to main.
- Repository administrators should not be placed on a bypass list by default.
- A workflow that reports a skipped *job* as success cannot be trusted as a
  mandatory check; none of the six selected jobs are conditional.
- Commit-message skip directives can prevent Actions execution; required checks
  then remain missing/pending and block merge, rather than bypass protection.
- Branch owners can edit YAML in PRs, so a real independent code review for
  changes under `.github/workflows/` is recommended in addition to CI.
- CI runs only synthetic test credentials; branch Settings changes and merge
  decisions are explicitly outside this PR.
