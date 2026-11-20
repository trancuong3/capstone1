-- Task 07: targeted, review-only reading indexes and redundant-index cleanup.
-- DO NOT apply via this PR. GitHub Actions exercises this exact file only on
-- disposable PostgreSQL; production rollout requires explicit approval.
--
-- Evidence as of 2026-11-20:
--   readingevents(sessionid, startms, id): query in reading_content_repository
--   and /reading session events endpoint; covers readingevents_sessionid_fkey.
--   readingsessions(childid, startedat DESC, id DESC): parent reading history
--   and child-progress history; covers readingsessions_childid_fkey.
--   pagerevisions: page_latest and page_created_id are definition-identical,
--   non-unique, unconstrained indexes; keep the 7,675-scan index and drop
--   the 43-scan duplicate (~49,152 index bytes at audit time).
--
-- Small tables may legitimately use Seq Scan in production. Extra indexes
-- have write/space cost; do not add the other 73 advisor-suggested FK indexes.
-- Non-concurrent index creation is intentionally constrained by lock and
-- statement timeouts. Schedule deployment during a low-traffic period.

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $preflight$
declare
  old_definition text;
  retained_definition text;
begin
  if to_regclass('public.readingevents') is null
     or to_regclass('public.readingsessions') is null
     or to_regclass('public.pagerevisions') is null then
    raise exception 'reading_index_optimization: required tables missing';
  end if;

  if to_regclass('public.idx_pagerevisions_page_latest') is not null then
    old_definition := pg_get_indexdef(
      'public.idx_pagerevisions_page_latest'::regclass
    );
    retained_definition := pg_get_indexdef(
      to_regclass('public.idx_pagerevisions_page_created_id')
    );
    if retained_definition is null
       or replace(
         old_definition,
         'INDEX idx_pagerevisions_page_latest ON',
         'INDEX idx_pagerevisions_page_created_id ON'
       ) is distinct from retained_definition
       or exists (
         select 1 from pg_constraint
         where conindid = 'public.idx_pagerevisions_page_latest'::regclass
       ) then
      raise exception 'reading_index_optimization: duplicate index drift or dependency';
    end if;
  end if;

  if to_regclass('public.idx_readingevents_session_start_id') is not null
     and pg_get_indexdef(
       'public.idx_readingevents_session_start_id'::regclass
     ) is distinct from
       'CREATE INDEX idx_readingevents_session_start_id ON public.readingevents USING btree (sessionid, startms, id)' then
    raise exception 'reading_index_optimization: readingevents index definition drift';
  end if;

  if to_regclass('public.idx_readingsessions_child_started_id') is not null
     and pg_get_indexdef(
       'public.idx_readingsessions_child_started_id'::regclass
     ) is distinct from
       'CREATE INDEX idx_readingsessions_child_started_id ON public.readingsessions USING btree (childid, startedat DESC, id DESC)' then
    raise exception 'reading_index_optimization: readingsessions index definition drift';
  end if;
end;
$preflight$;

create index if not exists idx_readingevents_session_start_id
  on public.readingevents (sessionid, startms, id);

create index if not exists idx_readingsessions_child_started_id
  on public.readingsessions (childid, startedat desc, id desc);

-- Keep idx_pagerevisions_page_created_id (the overwhelmingly used equivalent).
-- DROP INDEX cannot silently remove a constraint-backed index; preflight also
-- checks equality and ownership by the expected table.
drop index if exists public.idx_pagerevisions_page_latest;

do $postflight$
begin
  if to_regclass('public.idx_readingevents_session_start_id') is null
     or to_regclass('public.idx_readingsessions_child_started_id') is null
     or to_regclass('public.idx_pagerevisions_page_created_id') is null
     or to_regclass('public.idx_pagerevisions_page_latest') is not null then
    raise exception 'reading_index_optimization: unexpected post-migration state';
  end if;
end;
$postflight$;

commit;
