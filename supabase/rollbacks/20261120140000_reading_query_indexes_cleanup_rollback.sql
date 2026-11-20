-- Task 07 manual rollback. DO NOT apply to production automatically.
-- This intentionally restores the former duplicate index while removing
-- the two new reading-query indexes. Use only after reviewer approval.
-- It never drops primary keys, foreign keys, tables or data.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regclass('public.readingevents') is null
     or to_regclass('public.readingsessions') is null
     or to_regclass('public.pagerevisions') is null
     or to_regclass('public.idx_pagerevisions_page_created_id') is null then
    raise exception 'reading_index_rollback: prerequisite tables or retained index missing';
  end if;
end;
$preflight$;

create index if not exists idx_pagerevisions_page_latest
  on public.pagerevisions (pageid, createdat desc, id desc);

drop index if exists public.idx_readingevents_session_start_id;
drop index if exists public.idx_readingsessions_child_started_id;

do $postflight$
begin
  if to_regclass('public.idx_pagerevisions_page_latest') is null
     or to_regclass('public.idx_pagerevisions_page_created_id') is null
     or to_regclass('public.idx_readingevents_session_start_id') is not null
     or to_regclass('public.idx_readingsessions_child_started_id') is not null then
    raise exception 'reading_index_rollback: unexpected post-rollback state';
  end if;
end;
$postflight$;

commit;
