# ViRead Project Hub

Static, zero-cost dashboard at https://trancuong3.github.io/capstone1/ (only after GitHub Pages deployment succeeds).

## Shared roadmap (Task 11 / Phase 0)

**GitHub Issues is the source of truth for task status.** The existing 14 tasks retain stable IDs `p1`–`p14`. Their canonical GitHub Issues are #150–#163. Issue #149 is the separate Phase 0 implementation tracker; it is not one of the 14 tasks.

The dashboard reads **only a same-origin JSON snapshot** (`data/hub-snapshot.json`) published alongside GitHub Pages. **GitHub Actions** reads GitHub Issues using its ephemeral `GITHUB_TOKEN`, validates the existing 14 task IDs/statuses, projects minimal public fields and uploads the static snapshot as part of the Pages artifact. **The browser never calls `api.github.com`, receives a token, or changes Issues.** Only an authorized coding agent/person can edit shared statuses. A merged PR does **not** automatically mark a task done.

Issue body format:

```md
<!-- viread-roadmap:v1
id: p3
status: blocked
priority: P0
category: Frontend
-->
## Mô tả
Xác minh origin HTTPS...
## Acceptance criteria
- ...
## Evidence
- https://github.com/trancuong3/capstone1/...
```

Permitted `status`: `todo`, `in_progress`, `review`, `blocked`, `not_tested`, `done`.
Permitted `priority`: `P0` to `P3`. Preserve issue ID, URLs and evidence when editing.

### Snapshot generation and refresh semantics

- Workflow: `.github/workflows/project-dashboard-pages.yml`. Deploys on trusted `main` pushes that affect dashboard files, Issue open/edit/close/reopen/delete events, the hourly schedule (`17 * * * *`), or manual `workflow_dispatch`. Pull requests **validate only**, never deploy.
- The **Build public JSON snapshot** step calls GitHub REST API **inside Actions** using the ephemeral workflow token, with `issues:read`, `actions:read`, `pull-requests:read`, `contents:read` privileges. No permanent secrets, database or new paid services are needed.
- Snapshot generation fails closed if any of the 14 task IDs is missing, duplicated, or malformed; an invalid build is **not deployed**, keeping the previously deployed website. Optional activity API failures are represented as unavailable, never as a fabricated empty list.
- The generated JSON is staged in the deployment artifact **only**, not committed to `main`; the artifact includes only `index.html`, `roadmap-core.js`, and the JSON. Server-only generator and tests are not published.
- Clicking **Làm mới dữ liệu** fetches the currently published same-origin JSON. The visible tab rechecks at most once every 15 minutes. This is **not real-time**: it cannot force GitHub Actions to publish an Issue change instantly. The UI displays the actual snapshot generation timestamp and warns if more than two hours old.
- The previous `viread-shared-roadmap-v1` localStorage cache remains compatible. If JSON is unavailable, stale, or invalid, the browser clearly indicates failure and retains cached tasks and private notes. No public GitHub REST request occurs in the browser.
- This prevents **anonymous browser rate-limit exhaustion**; the Actions job still has GitHub's own API and Actions/Pages quotas and may fail during an outage. It is not an unlimited API service.

### How to verify after the PR is merged by an authorized reviewer

1. In **Actions → Deploy ViRead Project Hub**, check the `Build public JSON snapshot` step and the Pages deployment are successful.
2. Visit `https://trancuong3.github.io/capstone1/data/hub-snapshot.json`, check `schemaVersion`, `generatedAt`, 14 `roadmap` entries, and that it contains no token or private note.
3. On the Project Hub, click **Làm mới dữ liệu**. Chrome DevTools → Network must show `/capstone1/data/hub-snapshot.json` on GitHub Pages, **not** `api.github.com`.
4. DevTools → Network → Offline, click Refresh, confirm cached tasks and private notes remain; restore network and retry, confirm the snapshot reloads successfully.
5. Edit a non-sensitive test detail on a roadmap Issue (do not change status just for a test); wait for its Issue-triggered Pages run, then refresh the site and verify the result. Restore the original description afterward.
6. Verify legacy JSON export/import and notes surviving F5. **Do not mark TASK 11 DONE** until all required criteria are actually met.

### Legacy local task data

The previous `viread-project-hub-v1` localStorage object is left in place. Personal notes continue to save there. Existing task status edits and custom local tasks are **not** automatically published, discarded or applied to the shared roadmap.

- **Xuất dữ liệu cục bộ** exports legacy data, previously imported snapshots and the last shared snapshot to a local JSON file.
- **Nhập bản lưu cục bộ** saves another legacy backup in `viread-roadmap-local-imports-v1` for comparison. It does **not** overwrite the user's current browser notes or task data, and never writes to GitHub.
- The dashboard shows how many local task statuses differ from the shared Issues and how many local-only tasks remain. Reconciliation is manual to avoid overwriting unseen user changes.
- Back up browser data before clearing localStorage. Imported JSON remains on this browser only; do not publish it to public GitHub Issues.

## Development and testing

Run locally with any static server (or open `project-dashboard/index.html` in a browser). `project-dashboard/roadmap-core.js` contains the pure parser and reconciliation rules.

```bash
node --check project-dashboard/roadmap-core.js
node --check project-dashboard/build-snapshot.cjs
node --test project-dashboard/roadmap-core.test.cjs project-dashboard/dashboard-smoke.test.cjs project-dashboard/build-snapshot.test.cjs
```

The PR workflow validates the inline script, snapshot builder and all Node tests. The Pages workflow deploys only from trusted main code (never on PR events); Issue/cron triggers are post-merge.

## Other dashboard views

- Overview and stream-level task completion, based on shared GitHub Issues.
- APK readiness checklist, grounded in task evidence; mobile/real-device testing must be verified separately.
- Public GitHub activity: recent commits, PRs, issues, Actions runs and releases.
- Personal notes are stored in this browser only.

No new database, permanent token, Supabase changes or Android APK publishing are required. No Pages deployment occurs while this PR remains unmerged.
