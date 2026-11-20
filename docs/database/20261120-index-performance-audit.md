# Task 07 — Supabase database query/index audit

**Observed:** 20 November 2026 (production *read-only* via connected Supabase).
**Source branch:** `perf/supabase-index-optimization`, base `1e4844ed4d89e4e4717ff52c826ba60903e5fd76`.

## Findings versus evidence

| Production finding | Evidence | Decision |
| --- | --- | --- |
| Unindexed foreign keys | Supabase Performance Advisor: **75** notices | **Do not create 75 indexes**: small tables and write overhead make generic automatic indexing unjustified |
| Unused indexes | Supabase Advisor: **16** notices | **Do not drop**: cumulative `idx_scan=0` is not proof future workloads never need them |
| Duplicate index on `public.pagerevisions` | `idx_pagerevisions_page_latest` and `idx_pagerevisions_page_created_id` have exactly identical B-tree definitions, neither unique/primary/constraint-backed | Keep `idx_pagerevisions_page_created_id` (7,675 cumulative scans), drop `idx_pagerevisions_page_latest` (43 scans, **49,152 bytes**); preflight aborts on drift |
| Parent/child reading history | `ReadingSession.ChildId` filter and `StartedAt DESC, Id DESC` sort in `reading.py`, `child_progress_repository.py` and `reading_content_repository.py` | Propose `idx_readingsessions_child_started_id(childid, startedat DESC, id DESC)` |
| Reading events by session | `ReadingEvent.SessionId` filter and `StartMs, Id` sort in `reading.py` and `reading_content_repository.py` | Propose `idx_readingevents_session_start_id(sessionid,startms,id)` |

The two proposed B-tree indexes cover **existing foreign-key leading columns** (`readingsessions_childid_fkey` and `readingevents_sessionid_fkey`) and actual ordering patterns. No RLS/foreign key/authorization logic is changed.

## Read-only production baseline

- PostgreSQL **17.6**.
- Actual row counts at inspection: `readingsessions=36`, `readingevents=190`, `pagerevisions=22`, `childprofiles=12`.
- `pg_stat_statements` aggregate for SQL mentioning session + child: **19 query signatures / 1,072 cumulative calls / 2,553.3ms total execution**. Events by session: **13 signatures / 1,300 calls / 9,462.3ms total execution**.
- These are aggregate cumulative counters, **not before/after query latency attributable to missing indexes**; they can include multiple query shapes and other overhead. There is no verified production p95 reduction from this PR.
- `pagerevisions` duplicate index occupied **49,152 bytes** at the time of inspection; actual savings after migration are not measured because production is not modified.
- Rows in production are currently few, so PostgreSQL may intentionally prefer sequential scans. New indexes increase write and maintenance costs. If synthetic measurements do not show a plan benefit on scaled data, withdraw the new indexes and retain only duplicate cleanup.

## Proposed migration (never auto-applied to production by this PR)

- `supabase/migrations/20261120140000_reading_query_indexes_cleanup.sql`
- Dedicated manual rollback: `supabase/rollbacks/20261120140000_reading_query_indexes_cleanup_rollback.sql`
- Both run in short transactions with 3-second lock timeout and 30-second statement timeout. No `DROP ... CASCADE`, no table/data removal and no changed constraints, RLS, triggers or secrets.
- Preflight verifies redundant-index equivalence and rejects definition drift; reapply is idempotent.
- Creation uses normal `CREATE INDEX` on the currently small tables rather than `CONCURRENTLY`: schedule in low traffic and abort if lock cannot be acquired. PostgreSQL `CREATE INDEX CONCURRENTLY` cannot run inside an explicit transaction.
- Review exact production catalog, dependencies, workloads and timing again immediately before any authorized rollout; run production deploy only by an explicitly approved operator in a separate task.
- The Supabase CLI is not available in the ChatGPT execution environment; the migration filename was prepared following this repository's existing timestamp ordering. Before live rollout, use the repository's installed Supabase CLI to validate `supabase migration list --local` and pending migrations.

## Disposable PostgreSQL verification

The dedicated CI workflow uses fresh **PostgreSQL 17** with database name `viread_perf_ci`. The SQL script **hard-fails if the database name differs**; it builds entirely synthetic rows, uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` **only on the disposable test DB**, verifies the plans before/after, applies the **actual migration twice** to check idempotence, executes the **actual rollback**, and validates the original catalog state. All connections are CI-internal; no production Supabase credentials are used.

Reproduce with a disposable PostgreSQL server only:

```bash
# Do not set PGHOST/PGDATABASE to production.
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=test PGPASSWORD=test PGDATABASE=viread_perf_ci \
  psql -X -v ON_ERROR_STOP=1 -f supabase/tests/reading_query_indexes_disposable.sql
```

Expected: two selective-query plans use new indexes after migration; duplicate index absent; rollback restores duplicate and removes both new indexes. Any elapsed milliseconds printed are synthetic fixture measurements, **not production promises**.

## Remaining limitations and rollback

- No production DDL, writes, ANALYZE or EXPLAIN ANALYZE performed.
- No migration has been applied to Supabase; post-deployment Advisor and `pg_stat_statements` validation remain pending approval.
- A schema-only PostgreSQL fixture does not exercise Supabase Auth, real RLS or realistic content skew. Those are intentionally unchanged.
- On poor performance after an approved rollout, apply only the reviewed rollback in a maintenance window, then compare plans again. The rollback reintroduces the former duplicate index; this is intentional recovery to the original state.
- CI needs to pass at the PR's **current HEAD** before the migration is considered review-ready.
