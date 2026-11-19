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
- Make repository agents automatically select and use the smallest relevant skill set even when prompts do not name skills.

### Completed
- Added project skill `viread-skill-router`.
- Registered both `.codex/skills` and `.agents/skills` in `.agents/skills.json`.
- Added mandatory Automatic Skill Routing rules to `AGENTS.md`.
- Kept Graphify as the first discovery layer and quality-gate/verification skills as completion gates.

### Files changed
- `.agents/skills/viread-skill-router/SKILL.md`
- `.agents/skills.json`
- `AGENTS.md`
- `.codex/skills/graphify/PROJECT_STATE.md`

### Tests / verification
- Verified the router skill exists on `main`.
- Verified `.agents/skills.json` discovers both project skill roots.
- Verified `AGENTS.md` contains mandatory automatic routing rules.

### Known issues
- Skill choice is still model/agent driven; no system can guarantee perfect routing for every ambiguous prompt.
- Generic harnesses that ignore both `AGENTS.md` and repository skill discovery may not follow these rules.

### Decisions that must not be revisited without evidence
- Do not require users to name skills in normal prompts.
- Do not load all skills; select the smallest relevant set.
- Project-specific `viread-*` skills take precedence over overlapping generic skills.
- Graphify remains mandatory for codebase discovery when the graph exists.
- Do not discard or overwrite uncommitted user work.

### Next exact actions
1. On the next coding task, agent should read `AGENTS.md` and invoke `viread-skill-router` automatically.
2. Classify the prompt domain and load only relevant skill instructions.
3. Use Graphify before broad code browsing.
4. Run focused tests, then `viread-quality-gate` and `verification-before-completion`.
5. Update this checkpoint before stopping if the next task becomes long-running.

### Latest relevant commits
- `8e8de258` — add `viread-skill-router`.
- `a9cd47a7` — enable project skill auto-discovery.
- `3f53a2dc` — enforce automatic skill routing in `AGENTS.md`.
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
