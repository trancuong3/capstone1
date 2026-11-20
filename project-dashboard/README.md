# ViRead Project Hub

Static, zero-cost dashboard at https://trancuong3.github.io/capstone1/ (only after GitHub Pages deployment succeeds).

## Shared roadmap (Task 11 / Phase 0)

**GitHub Issues is the source of truth for task status.** The existing 14 tasks retain stable IDs `p1`–`p14`. Their canonical GitHub Issues are #150–#163. Issue #149 is the separate Phase 0 implementation tracker; it is not one of the 14 tasks.

The dashboard reads public GitHub REST API endpoints from the browser (no credentials), parses an explicit machine-readable metadata comment in each roadmap issue, and shows a read-only list of tasks. Only an authorized coding agent/person can update a shared status by editing the GitHub Issue. A merged PR does **not** automatically mark a task done.

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

### Sync semantics

- Clicking **Đồng bộ GitHub** refreshes GitHub data immediately; automatic refresh checks every 15 minutes **while the tab is visible**.
- GitHub REST anonymous rate limits apply (usually 60 requests/hour per IP). The dashboard labels API failures and does not claim real-time sync.
- The last successful shared-roadmap snapshot is cached separately in `localStorage` under `viread-shared-roadmap-v1`. If the API fails, the UI explicitly reports that its view is stale or unverified. Cache is **not** a second writable source of truth.
- A partial/duplicate/invalid GitHub Issues response is rejected instead of silently marking tasks complete.
- The dashboard never sends GitHub tokens, private information or notes to the public API.

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
node --test project-dashboard/roadmap-core.test.cjs project-dashboard/dashboard-smoke.test.cjs
```

The PR workflow `.github/workflows/project-dashboard-pages.yml` also validates the inline script and runs the roadmap parser and UI/network smoke tests. It deploys Pages **only on main**, never on PR creation.

## Other dashboard views

- Overview and stream-level task completion, based on shared GitHub Issues.
- APK readiness checklist, grounded in task evidence; mobile/real-device testing must be verified separately.
- Public GitHub activity: recent commits, PRs, issues, Actions runs and releases.
- Personal notes are stored in this browser only.

No new database, tokens, production deployment, Supabase changes or Android APK publishing are required by this Phase 0 PR.
