# Continuation / Token-Recovery Protocol

Use this protocol whenever:
- the user says "continue", "resume", "làm tiếp", "tiếp tục";
- a prior agent hit a token/rate/usage limit;
- the user says they pulled/pull `main` and wants to continue;
- the repository contains `.codex/skills/graphify/PROJECT_STATE.md`.

## Goal

Resume work with the smallest possible context load. Do **not** rediscover the whole codebase.

## Mandatory resume order

1. Read `AGENTS.md`.
2. Read `.codex/skills/graphify/PROJECT_STATE.md`.
3. Run only:
   - `git status --short`
   - `git diff --name-only`
   - `git log -3 --oneline`
4. If **Next exact actions** already names the next file/action, continue directly. Do not run Graphify first.
5. If architecture/file ownership is unknown, run one narrow Graphify query with `--budget 600`.
6. Read only changed files, checkpoint-named files, Graphify-located files, and direct dependencies needed for the next action.
7. Run the smallest relevant test first.
8. Continue implementation without repeating verified work.

If the tree is clean and the checkpoint says `COMMITTED_MAIN`, pull with fast-forward only before continuing. If the tree is dirty, preserve local changes and never reset/overwrite them.

## Forbidden resume behavior

Do not:
- rescan the repository from scratch;
- rebuild Graphify unless stale graph output is itself the problem;
- reread every file in a feature;
- reinstall dependencies that are already present;
- rerun broad tests before a focused test;
- discard a dirty tree;
- infer unpushed/local work from main;
- trust a stale checkpoint over Git.

## Checkpoint freshness

`PROJECT_STATE.md` is a cache, not the ultimate source of truth.

Git wins if they disagree.

When the latest commit SHA recorded in the checkpoint differs from the current branch:
- inspect only the commits since that SHA;
- update the checkpoint;
- do not redo old discovery.

## Mandatory checkpoint writes

Update `PROJECT_STATE.md` automatically:
- after a meaningful milestone;
- when the next action changes materially;
- before voluntarily stopping;
- before token/rate-limit exhaustion when practical;
- before commit/merge.

Do **not** update it after every tiny edit.

Keep the active checkpoint compact (target ~30–60 lines). Record only:
- Goal
- Completed
- Files changed
- Tests / verification
- Known issues
- Decisions
- Next exact actions
- latest relevant commit SHA
- location status

Never paste full diffs, logs, stack traces, or source code.

## Before committing/merging completed work

When the user allows commit/push:
1. update `PROJECT_STATE.md` in the same logical change;
2. run `graphify update .`;
3. commit the checkpoint together with the relevant state or immediately after it;
4. when merged to main, change location status to `COMMITTED_MAIN` and record the merge/head SHA on the next checkpoint update.

This makes `git pull origin main` a usable recovery mechanism.

## Minimal recovery prompt for the user

After this protocol is installed, the user can simply say:

> Pull main and continue from the Graphify project checkpoint. Do not rediscover completed work.

The agent must then follow this protocol automatically.
