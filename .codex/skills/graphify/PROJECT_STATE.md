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

Status: **COMMITTED_MAIN**

### Goal
- Minimize Codex token/context usage while preserving automatic skill selection and safe project continuation.

### Completed
- Added T0/T1/T2/T3 task classification.
- T0 uses 0 skills / 0 Graphify by default.
- T1 uses at most 1 domain skill and Graphify only when file/flow is unknown.
- T2 uses router + at most 3 domain skills.
- T3 uses router + at most 5 necessary skills.
- Default Graphify query budget set to 600 tokens; increase only when needed.
- Full GRAPH_REPORT.md is avoided for focused tasks.
- Graphify update moved from every edit to meaningful milestones / checkpoint / commit.
- Completion skills are loaded only at the end.
- Resume flow uses checkpoint + cheap Git state first and skips rediscovery when next action is known.

### Files changed
- `AGENTS.md`
- `.agents/skills/viread-skill-router/SKILL.md`
- `.codex/skills/graphify/PROJECT_STATE.md`
- `.codex/skills/graphify/references/continuation.md`

### Tests / verification
- Verified token-first rules are committed to `main`.
- Verified automatic skill discovery remains enabled.
- Verified continuation checkpoint exists and remains under a compact format.

### Known issues
- A model may still occasionally choose more context than necessary; project rules now explicitly constrain this.
- Local uncommitted code is never recoverable from `main` alone; Git remains the source of truth.

### Decisions that must not be revisited without evidence
- User should not need to name skills.
- User should not need to manually maintain checkpoint text.
- Do not load router for T0/T1 unless ambiguity requires it.
- Do not run Graphify when exact next file/action is already known.
- Do not update Graphify after every small edit.
- Do not load quality-gate/verification skills until completion phase.
- Never discard uncommitted user work.

### Next exact actions
1. On the next task, classify T0/T1/T2/T3 automatically.
2. Use the minimum context path defined in `AGENTS.md`.
3. If resuming, read this checkpoint and cheap Git state first.
4. Update this checkpoint automatically at meaningful milestones or before stopping.
5. When source changes are ready to commit/merge, update Graphify once and run the final quality gates.

### Latest relevant commits
- `04f46f7f` — minimize default context and skill loading.
- `279cef1b` — route by task tier to reduce token use.
- Location: `COMMITTED_MAIN`

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
