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

-- Exercise exact manual rollback TWICE and verify its catalog effects.
\ir ../rollbacks/20261120140000_reading_query_indexes_cleanup_rollback.sql
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

-- ---------------------------------------------------------------------------
-- DEF-005: Verify 20261125120000_security_hardening_and_hot_fk_indexes.sql
-- and its rollback with pre-populated representative rows, idempotence, and
-- data preservation across all 10 hot FK tables.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key,
  role text not null default 'parent'
);

create table public.childprofiles (
  id uuid primary key,
  parentid uuid not null references public.profiles(id) on delete cascade
);

create table public.books (
  id uuid primary key,
  visibility_scope text not null default 'CATALOG',
  owner_parent_id uuid references public.profiles(id) on delete cascade
);

create table public.bookpages (
  id uuid primary key,
  bookid uuid not null references public.books(id) on delete cascade,
  pagenumber smallint not null
);

alter table public.readingsessions
  add column if not exists bookid uuid references public.books(id) on delete cascade;

alter table public.readingevents
  add column if not exists pageid uuid references public.bookpages(id) on delete cascade;

create table public.readingsessionpages (
  id uuid primary key,
  sessionid uuid not null references public.readingsessions(id) on delete cascade,
  pageid uuid not null references public.bookpages(id) on delete restrict,
  constraint uq_readingsessionpages_session_page unique (sessionid, pageid)
);

create table public.progressreports (
  id uuid primary key,
  childid uuid not null references public.childprofiles(id) on delete cascade
);

create table public.comprehensionquestions (
  id uuid primary key,
  sessionid uuid not null references public.readingsessions(id) on delete cascade
);

create table public.comprehensionanswers (
  id uuid primary key,
  questionid uuid not null references public.comprehensionquestions(id) on delete cascade
);

create table public.readingplans (
  id uuid primary key,
  childid uuid not null references public.childprofiles(id) on delete cascade,
  bookid uuid references public.books(id) on delete set null
);

create table public.readingreminderemaildeliveries (
  id uuid primary key,
  occurrenceid uuid not null
);

-- Pre-populate representative rows and link existing 20k sessions / 30k events.
insert into public.profiles (id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'parent'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'parent');

insert into public.childprofiles (id, parentid) values
  ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');

insert into public.books (id, visibility_scope, owner_parent_id)
select
  ('40000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  case when g = 1 then 'PARENT_PRIVATE' else 'CATALOG' end,
  case when g = 1 then 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid else null end
from generate_series(1, 200) as g;

insert into public.bookpages (id, bookid, pagenumber)
select
  ('50000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  ('40000000-0000-4000-8000-' || lpad(to_hex(((g - 1) % 200) + 1), 12, '0'))::uuid,
  (((g - 1) % 10) + 1)::smallint
from generate_series(1, 400) as g;

update public.readingsessions
   set bookid = ('40000000-0000-4000-8000-' || lpad(to_hex((abs(hashtext(id::text)) % 200) + 1), 12, '0'))::uuid;

update public.readingevents
   set pageid = ('50000000-0000-4000-8000-' || lpad(to_hex((abs(hashtext(id::text)) % 400) + 1), 12, '0'))::uuid;

insert into public.readingsessionpages (id, sessionid, pageid) values
  ('60000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001');

insert into public.progressreports (id, childid) values
  ('70000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333');

insert into public.comprehensionquestions (id, sessionid) values
  ('80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001');

insert into public.comprehensionanswers (id, questionid) values
  ('90000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001');

insert into public.readingplans (id, childid, bookid) values
  ('a0000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', '40000000-0000-4000-8000-000000000001');

insert into public.readingreminderemaildeliveries (id, occurrenceid) values
  ('b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');

create temp table def005_row_counts as
select 'profiles' as tbl, count(*)::bigint as cnt from public.profiles
union all select 'childprofiles', count(*) from public.childprofiles
union all select 'books', count(*) from public.books
union all select 'bookpages', count(*) from public.bookpages
union all select 'readingsessions', count(*) from public.readingsessions
union all select 'readingsessionpages', count(*) from public.readingsessionpages
union all select 'readingevents', count(*) from public.readingevents
union all select 'progressreports', count(*) from public.progressreports
union all select 'comprehensionquestions', count(*) from public.comprehensionquestions
union all select 'comprehensionanswers', count(*) from public.comprehensionanswers
union all select 'readingplans', count(*) from public.readingplans
union all select 'readingreminderemaildeliveries', count(*) from public.readingreminderemaildeliveries;

-- Run DEF-005 migration TWICE to verify idempotence.
\ir ../migrations/20261125120000_security_hardening_and_hot_fk_indexes.sql
\ir ../migrations/20261125120000_security_hardening_and_hot_fk_indexes.sql

analyze public.readingsessions;
analyze public.readingevents;

do $def005_post_migration$
declare
  idx_name text;
  p json;
begin
  foreach idx_name in array array[
    'public.idx_childprofiles_parentid',
    'public.idx_readingsessions_bookid',
    'public.idx_readingsessionpages_pageid',
    'public.idx_readingevents_pageid',
    'public.idx_progressreports_childid',
    'public.idx_books_owner_parent_id',
    'public.idx_comprehensionquestions_sessionid',
    'public.idx_comprehensionanswers_questionid',
    'public.idx_readingplans_bookid',
    'public.idx_readingreminderemaildeliveries_occurrenceid'
  ] loop
    if to_regclass(idx_name) is null then
      raise exception 'DEF-005 index missing after migration: %', idx_name;
    end if;
  end loop;

  execute 'explain (analyze, format json)
    select id from public.readingsessions
    where bookid = ''40000000-0000-4000-8000-000000000001''::uuid' into p;
  if p::text not like '%idx_readingsessions_bookid%' then
    raise exception 'Expected idx_readingsessions_bookid in plan: %', p::text;
  end if;

  execute 'explain (analyze, format json)
    select id from public.readingevents
    where pageid = ''50000000-0000-4000-8000-000000000001''::uuid' into p;
  if p::text not like '%idx_readingevents_pageid%' then
    raise exception 'Expected idx_readingevents_pageid in plan: %', p::text;
  end if;
end;
$def005_post_migration$;

-- Run DEF-005 rollback TWICE to verify idempotence and data preservation.
\ir ../rollbacks/20261125120000_security_hardening_and_hot_fk_indexes_rollback.sql
\ir ../rollbacks/20261125120000_security_hardening_and_hot_fk_indexes_rollback.sql

do $def005_post_rollback$
declare
  idx_name text;
  mismatches integer;
begin
  foreach idx_name in array array[
    'public.idx_childprofiles_parentid',
    'public.idx_readingsessions_bookid',
    'public.idx_readingsessionpages_pageid',
    'public.idx_readingevents_pageid',
    'public.idx_progressreports_childid',
    'public.idx_books_owner_parent_id',
    'public.idx_comprehensionquestions_sessionid',
    'public.idx_comprehensionanswers_questionid',
    'public.idx_readingplans_bookid',
    'public.idx_readingreminderemaildeliveries_occurrenceid'
  ] loop
    if to_regclass(idx_name) is not null then
      raise exception 'DEF-005 index still present after rollback: %', idx_name;
    end if;
  end loop;

  with current_counts as (
    select 'profiles' as tbl, count(*)::bigint as cnt from public.profiles
    union all select 'childprofiles', count(*) from public.childprofiles
    union all select 'books', count(*) from public.books
    union all select 'bookpages', count(*) from public.bookpages
    union all select 'readingsessions', count(*) from public.readingsessions
    union all select 'readingsessionpages', count(*) from public.readingsessionpages
    union all select 'readingevents', count(*) from public.readingevents
    union all select 'progressreports', count(*) from public.progressreports
    union all select 'comprehensionquestions', count(*) from public.comprehensionquestions
    union all select 'comprehensionanswers', count(*) from public.comprehensionanswers
    union all select 'readingplans', count(*) from public.readingplans
    union all select 'readingreminderemaildeliveries', count(*) from public.readingreminderemaildeliveries
  )
  select count(*) into mismatches
    from def005_row_counts before_cnt
    full outer join current_counts after_cnt using (tbl)
   where before_cnt.cnt is distinct from after_cnt.cnt;

  if mismatches <> 0 then
    raise exception 'DEF-005 migration/rollback altered row counts (% mismatches)', mismatches;
  end if;
end;
$def005_post_rollback$;

\echo 'PASS: disposable PostgreSQL query indexes, DEF-005 hot FK indexes, idempotence, explain plans, and rollback'
