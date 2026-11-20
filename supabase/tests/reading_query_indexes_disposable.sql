-- DISPOSABLE POSTGRESQL ONLY. This file must never be executed in Supabase.
-- psql -X -v ON_ERROR_STOP=1 -f supabase/tests/reading_query_indexes_disposable.sql
\set ON_ERROR_STOP on

do $database_guard$
begin
  if current_database() <> 'viread_perf_ci' then
    raise exception 'Refusing database other than viread_perf_ci: %',
      current_database();
  end if;
end;
$database_guard$;

-- Reproduce only the minimum required columns/indexes. This is NOT a copy
-- of any real user/child rows, and this CI database is destroyed after tests.
create table public.pagerevisions (
  id uuid primary key,
  pageid uuid not null,
  createdat timestamptz not null,
  verificationstatus text not null default 'VERIFIED'
);
create index idx_pagerevisions_page_latest
  on public.pagerevisions (pageid, createdat desc, id desc);
create index idx_pagerevisions_page_created_id
  on public.pagerevisions (pageid, createdat desc, id desc);

create table public.readingsessions (
  id uuid primary key,
  childid uuid not null,
  startedat timestamptz not null
);
create table public.readingevents (
  id uuid primary key,
  sessionid uuid not null references public.readingsessions(id) on delete cascade,
  startms smallint not null
);

-- 20k fake sessions, 30k fake events. The two filtered keys are selective;
-- other identifiers are deterministic generated fixtures, not user data.
insert into public.readingsessions (id, childid, startedat)
select
  ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  case when g in (100,101) then
    '33333333-3333-4333-8333-333333333333'::uuid
  else
    ('10000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid
  end,
  now() - g * interval '1 minute'
from generate_series(1, 20000) as g;

insert into public.readingevents (id, sessionid, startms)
select
  ('20000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  ('00000000-0000-4000-8000-' ||
     lpad(to_hex(((g-1) % 20000) + 1), 12, '0'))::uuid,
  (g % 1000)::smallint
from generate_series(1, 30000) as g;

analyze public.readingsessions;
analyze public.readingevents;
analyze public.pagerevisions;

create temp table performance_index_plans (
  phase text not null,
  query_name text not null,
  explain_plan jsonb not null
);

do $baseline$
declare p json;
begin
  execute 'explain (analyze, buffers, format json)
    select id from public.readingsessions
    where childid = ''33333333-3333-4333-8333-333333333333''::uuid
    order by startedat desc, id desc limit 10' into p;
  insert into performance_index_plans values ('before', 'session_history', p::jsonb);

  execute 'explain (analyze, buffers, format json)
    select id from public.readingevents
    where sessionid = ''00000000-0000-4000-8000-000000000001''::uuid
    order by startms, id' into p;
  insert into performance_index_plans values ('before', 'session_events', p::jsonb);

  if not exists (
    select 1 from performance_index_plans
    where phase = 'before' and query_name = 'session_history'
      and explain_plan::text like '%Seq Scan%'
  ) or not exists (
    select 1 from performance_index_plans
    where phase = 'before' and query_name = 'session_events'
      and explain_plan::text like '%Seq Scan%'
  ) then
    raise exception 'Fixture must demonstrate missing selective-query indexes before migration';
  end if;
end;
$baseline$;

-- Execute EXACT proposed migration, then repeat to verify idempotence.
\ir ../migrations/20261120140000_reading_query_indexes_cleanup.sql
\ir ../migrations/20261120140000_reading_query_indexes_cleanup.sql

analyze public.readingsessions;
analyze public.readingevents;

do $after$
declare p json;
begin
  execute 'explain (analyze, buffers, format json)
    select id from public.readingsessions
    where childid = ''33333333-3333-4333-8333-333333333333''::uuid
    order by startedat desc, id desc limit 10' into p;
  insert into performance_index_plans values ('after', 'session_history', p::jsonb);

  execute 'explain (analyze, buffers, format json)
    select id from public.readingevents
    where sessionid = ''00000000-0000-4000-8000-000000000001''::uuid
    order by startms, id' into p;
  insert into performance_index_plans values ('after', 'session_events', p::jsonb);

  if not exists (
    select 1 from performance_index_plans
    where phase = 'after' and query_name = 'session_history'
      and explain_plan::text like '%idx_readingsessions_child_started_id%'
  ) or not exists (
    select 1 from performance_index_plans
    where phase = 'after' and query_name = 'session_events'
      and explain_plan::text like '%idx_readingevents_session_start_id%'
  ) then
    raise exception 'Query plans failed to use targeted indexes after migration';
  end if;

  if to_regclass('public.idx_pagerevisions_page_latest') is not null
     or to_regclass('public.idx_pagerevisions_page_created_id') is null then
    raise exception 'Duplicate index cleanup failed';
  end if;
end;
$after$;

-- Synthetic timings are informational only; no absolute speed claims and no
-- assertion comparing elapsed_ms (CI hardware/load is nondeterministic).
select phase, query_name,
  round((explain_plan->0->>'Execution Time')::numeric, 3) as execution_ms,
  explain_plan->0->'Plan'->>'Node Type' as top_plan_node
from performance_index_plans
order by query_name, phase;

-- Exercise exact manual rollback and verify its catalog effects.
\ir ../rollbacks/20261120140000_reading_query_indexes_cleanup_rollback.sql

do $rollback_check$
begin
  if to_regclass('public.idx_pagerevisions_page_latest') is null
     or to_regclass('public.idx_pagerevisions_page_created_id') is null
     or to_regclass('public.idx_readingsessions_child_started_id') is not null
     or to_regclass('public.idx_readingevents_session_start_id') is not null then
    raise exception 'Exact manual rollback does not restore baseline';
  end if;
end;
$rollback_check$;

\echo 'PASS: disposable PostgreSQL query indexes, idempotence, explain plans, and rollback'
