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
3. Run only these cheap Git commands first:
   - `git status --short`
   - `git log -5 --oneline`
   - `git diff --stat`
   - `git diff --name-only`
4. If the checkpoint says `COMMITTED_MAIN` and the working tree is clean:
   - `git pull --ff-only origin main`
   - continue from **Next exact actions**.
5. If the checkpoint says `COMMITTED_BRANCH`:
   - fetch/switch to the named branch; do not assume main contains the work.
6. If the checkpoint says `LOCAL_UNPUSHED`:
   - preserve the dirty working tree;
   - never reset/checkout over it;
   - inspect only the changed files plus their direct dependencies.
7. If architecture context is needed, run **one narrow Graphify query** with a small token budget before any broad grep or file reading.
8. Read raw source only for:
   - files listed in **Files changed**;
   - files named by the Graphify result;
   - direct dependencies needed to complete the next exact action.
9. Run the smallest relevant test first. Do not start with the entire test suite.
10. Continue implementation. Do not repeat already verified work unless a regression or conflicting diff requires it.

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

Update `PROJECT_STATE.md`:
- after every meaningful implementation milestone;
- after a focused test becomes green;
- after changing architectural direction;
- before launching a long test/build;
- before voluntarily stopping;
- whenever remaining context/token budget looks low.

A checkpoint update should take less than ~30 lines.

Record only:
- Goal
- Completed
- Files changed
- Tests / verification
- Known issues
- Decisions
- Next exact actions
- latest relevant commit SHA
- location status: `COMMITTED_MAIN`, `COMMITTED_BRANCH:<name>`, or `LOCAL_UNPUSHED`

Never paste:
- full diffs;
- full logs;
- entire source files;
- long stack traces;
- broad architecture explanations already available in Graphify.

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
