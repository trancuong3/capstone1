# Continuation / Token-Recovery Protocol

Use only for unfinished work: continue/resume, token/rate-limit recovery, or a dirty tree clearly related to the current request. A new unrelated task does **not** read this protocol or `PROJECT_STATE.md`.

## Resume order

1. Read `AGENTS.md` and `PROJECT_STATE.md`.
2. Run only `git status --short`, `git diff --name-only`, and `git log -3 --oneline`.
3. Git wins over stale checkpoint data. Continue from `NEXT`.
4. Previously verified unchanged source is not reread. Changed relevant source: read only changed ranges plus direct dependencies needed for `NEXT`.
5. Reuse `ROOT`, `VERIFIED`, and `DO_NOT_REPEAT`; repeat search/Graphify/debug only when new evidence invalidates them.
6. Do not rerun a passed test unless affected source/dependency/test changed or a final integration gate requires it.
7. Do not reload the prior skill stack. After compaction/resume, load only the detailed skill required for `NEXT`.
8. If ownership/flow is still unknown, use one narrow Graphify query starting at budget 300.

## Checkpoint

Keep only facts Git cannot reconstruct cheaply:

```text
STATUS: LOCAL_UNPUSHED | COMMITTED_BRANCH:<name> | COMMITTED_MAIN
GOAL: current intent
ROOT: proven root cause, or UNKNOWN
VERIFIED: shortest reusable facts/tests/flow
NEXT: next 1–3 exact actions
DO_NOT_REPEAT: ruled-out causes / verified work
BASE: commit SHA used for invalidation
```

Update automatically when root cause is established, a meaningful milestone/test changes `NEXT`, before voluntary stop, and before commit/merge. Write from current active knowledge. Never reread source, rerun Graphify/tests, or read the full diff merely to write the checkpoint.

## Invalidation

- Unchanged since `BASE` → knowledge stays valid.
- Changed relevant file/dependency → invalidate only affected facts.
- Unrelated commits → do not invalidate the current feature.
- Checkpoint contradicts Git → Git wins.
- Context compaction alone does not invalidate recorded knowledge.

Forbidden: whole-repo rediscovery, broad rereads/test reruns, dependency reinstall, dirty-tree discard, or treating local unpushed work as if it existed on main.
