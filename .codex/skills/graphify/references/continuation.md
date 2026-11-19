# Continuation / Token-Recovery Protocol

Use only for unfinished work: continue/resume, token/rate-limit recovery, or a dirty tree clearly related to the current request. A new unrelated task does **not** read this protocol or `PROJECT_STATE.md`.

## Resume order

1. Read `AGENTS.md` and `PROJECT_STATE.md`.
2. Run only:
   - `git status --short`
   - `git diff --name-only`
   - `git log -3 --oneline`
3. Git wins over stale checkpoint data.
4. Continue from `NEXT`.
5. If a previously verified file is unchanged since `BASE`, do not reread it.
6. If it changed, read only the changed range plus direct dependencies needed for the next action.
7. Reuse recorded `ROOT`, `VERIFIED`, and `DO_NOT_REPEAT`. Do not repeat Graphify/search/debug work without new contradictory evidence.
8. Do not rerun a passed test unless affected source/dependency/test changed or a final integration gate requires it.
9. If ownership/flow is still unknown, use one narrow Graphify query starting at budget 300.

## Checkpoint format

Keep `PROJECT_STATE.md` compact and record only facts Git cannot reconstruct cheaply:

```text
STATUS: LOCAL_UNPUSHED | COMMITTED_BRANCH:<name> | COMMITTED_MAIN
GOAL: current intent
ROOT: proven root cause, or UNKNOWN
VERIFIED: shortest useful facts/tests/flow
NEXT: next 1–3 exact actions
DO_NOT_REPEAT: ruled-out causes / verified unchanged work
BASE: commit SHA used for invalidation
```

Update automatically when a root cause is established, a meaningful milestone changes `NEXT`, a test materially changes the plan, before voluntary stop, and before commit/merge. Do not update after every edit.

Write the checkpoint from facts already in active context. **Never reread source, rerun Graphify, reread the full diff, or rerun tests merely to write the checkpoint.**

## Invalidation

- Unchanged since `BASE` → knowledge remains valid.
- Changed relevant file/dependency → invalidate only affected facts.
- Unrelated new commits → do not invalidate the current feature.
- Checkpoint contradicts Git → Git wins.
- Context compaction alone does not invalidate source knowledge recorded in the checkpoint.

Forbidden: whole-repo rediscovery, broad rereads, broad test reruns, dependency reinstall, dirty-tree discard, or treating local unpushed work as if it existed on main.
