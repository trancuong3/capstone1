# ReadAlong Vision — Project Continuation State

> Purpose: compact handoff memory for Codex/agents after token or rate-limit recovery.
> This file is intentionally short. It is NOT a changelog and must never contain large code dumps.

## Snapshot

- Repository: `trancuong3/capstone1`
- Canonical branch: `main`
- Baseline main commit when this checkpoint system was installed: `39cb2074439c467a107b994e2c6d1e787d093279`
- Source of truth for code: Git commits + working tree.
- Architecture source of truth: `graphify-out/` + `AGENTS.md`.

## Recent milestones already merged to main

Verified from Git history only:

- `39cb207` — Merge VL/Toolcheck into main.
- `3edc8af` — test: fix OCR and combined AI workflow coverage.
- `468dd68` — feat: add book-level AI approval workflow.
- `336b138` — merged local project snapshot PR #127.
- `e2af5be` — restore frontend CI checks for redesigned UI.
- `fd06118` — merged Supabase pooler egress/query-bloat optimization work.
- `418fc18` — restore DB startup probe and outbox fencing variables.
- `a63ff32` — merged Figma overnight feature work.

Do not infer implementation details or test status beyond what Git history proves. Use `git show <sha>` or a targeted Graphify query only when that detail is required.

## Active task checkpoint

Status: **NO ACTIVE CHECKPOINT RECORDED YET**

The next coding agent must replace this section once it completes the first meaningful milestone.

### Goal
- Not set.

### Completed
- Not set.

### Files changed
- Not set.

### Tests / verification
- Not set.

### Known issues
- Not set.

### Decisions that must not be revisited without evidence
- Follow `AGENTS.md`.
- Query Graphify before broad source browsing.
- Do not discard or overwrite uncommitted user work.
- Do not assume local/unpushed work exists on `main`.

### Next exact actions
1. Run `git status --short`.
2. If the tree is clean, run `git pull --ff-only origin main`.
3. If the tree is dirty, preserve local changes; do not reset or overwrite them.
4. Read this file.
5. Run `git log -5 --oneline`.
6. Continue from the active task checkpoint. If the checkpoint is missing/stale, use one narrow Graphify query before reading source files.

## Handoff update contract

After every meaningful milestone, and before stopping because of token/rate limits, update ONLY the Active task checkpoint above with:

- goal;
- completed work;
- exact modified files;
- tests/commands and pass/fail;
- remaining bugs;
- 3–7 next exact actions;
- latest relevant commit SHA;
- whether work is `COMMITTED_MAIN`, `COMMITTED_BRANCH`, or `LOCAL_UNPUSHED`.

Keep this file under ~200 lines. Summarize; never paste full diffs, logs, or source code.

## Critical truth rule

A future agent may skip rediscovery only when the checkpoint accurately labels where the work lives:

- `COMMITTED_MAIN`: available after pulling `main`.
- `COMMITTED_BRANCH`: fetch/switch to the named branch.
- `LOCAL_UNPUSHED`: only exists in the current working tree; pulling `main` alone will NOT restore it.

Never label unfinished or unpushed work as merged.
