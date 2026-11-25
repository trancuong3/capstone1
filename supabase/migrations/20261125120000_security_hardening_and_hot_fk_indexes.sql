-- DEF-005: Security hardening for SECURITY DEFINER functions and hot FK indexes.
-- Idempotent and safe on both full production/staging databases and minimal CI databases.
-- Never drops data, constraints, triggers, or pre-existing non-duplicate indexes.

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1. Hardening SECURITY DEFINER functions:
--    - Safely check to_regprocedure(...) before revoking EXECUTE from PUBLIC,
--      anon, and authenticated (when those roles exist).
--    - Lock search_path when unset or not safely pinned so object resolution
--      cannot be hijacked, without breaking triggers or service_role access.
-- ---------------------------------------------------------------------------
do $harden_definer_functions$
declare
  fn_oid regprocedure;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_authenticated boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_safe_search_path boolean;
begin
  -- 1a. public.sync_profile_role_to_auth_metadata()
  fn_oid := to_regprocedure('public.sync_profile_role_to_auth_metadata()');
  if fn_oid is not null then
    execute 'revoke execute on function public.sync_profile_role_to_auth_metadata() from public';
    if has_anon then
      execute 'revoke execute on function public.sync_profile_role_to_auth_metadata() from anon';
    end if;
    if has_authenticated then
      execute 'revoke execute on function public.sync_profile_role_to_auth_metadata() from authenticated';
    end if;

    select exists (
      select 1
      from pg_proc p
      cross join lateral unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where p.oid = fn_oid
        and cfg in (
          'search_path=',
          'search_path=""',
          'search_path=pg_catalog',
          'search_path=pg_catalog, pg_temp'
        )
    ) into has_safe_search_path;

    if not has_safe_search_path then
      execute 'alter function public.sync_profile_role_to_auth_metadata() set search_path = ''''';
    end if;
  end if;

  -- 1b. public.handle_new_readalong_user() (defensive)
  fn_oid := to_regprocedure('public.handle_new_readalong_user()');
  if fn_oid is not null then
    execute 'revoke execute on function public.handle_new_readalong_user() from public';
    if has_anon then
      execute 'revoke execute on function public.handle_new_readalong_user() from anon';
    end if;
    if has_authenticated then
      execute 'revoke execute on function public.handle_new_readalong_user() from authenticated';
    end if;

    select exists (
      select 1
      from pg_proc p
      cross join lateral unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where p.oid = fn_oid
        and cfg in (
          'search_path=',
          'search_path=""',
          'search_path=pg_catalog',
          'search_path=pg_catalog, pg_temp'
        )
    ) into has_safe_search_path;

    if not has_safe_search_path then
      execute 'alter function public.handle_new_readalong_user() set search_path = ''''';
    end if;
  end if;

  -- 1c. public.rls_auto_enable() (defensive)
  fn_oid := to_regprocedure('public.rls_auto_enable()');
  if fn_oid is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public';
    if has_anon then
      execute 'revoke execute on function public.rls_auto_enable() from anon';
    end if;
    if has_authenticated then
      execute 'revoke execute on function public.rls_auto_enable() from authenticated';
    end if;

    select exists (
      select 1
      from pg_proc p
      cross join lateral unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where p.oid = fn_oid
        and cfg in (
          'search_path=',
          'search_path=""',
          'search_path=pg_catalog',
          'search_path=pg_catalog, pg_temp'
        )
    ) into has_safe_search_path;

    if not has_safe_search_path then
      execute 'alter function public.rls_auto_enable() set search_path = pg_catalog';
    end if;
  end if;
end;
$harden_definer_functions$;

-- ---------------------------------------------------------------------------
-- 2. Hot Foreign-Key Indexes (guarded by to_regclass + column existence +
--    leading-column index check to avoid duplicates on any schema variant).
-- ---------------------------------------------------------------------------
do $hot_fk_indexes$
declare
  target record;
  tbl_oid oid;
  col_attnum smallint;
  leading_idx_exists boolean;
begin
  for target in
    select *
    from (
      values
        ('childprofiles', 'parentid', 'idx_childprofiles_parentid'),
        ('readingsessions', 'bookid', 'idx_readingsessions_bookid'),
        ('readingsessionpages', 'pageid', 'idx_readingsessionpages_pageid'),
        ('readingevents', 'pageid', 'idx_readingevents_pageid'),
        ('progressreports', 'childid', 'idx_progressreports_childid'),
        ('books', 'owner_parent_id', 'idx_books_owner_parent_id'),
        ('comprehensionquestions', 'sessionid', 'idx_comprehensionquestions_sessionid'),
        ('comprehensionanswers', 'questionid', 'idx_comprehensionanswers_questionid'),
        ('readingplans', 'bookid', 'idx_readingplans_bookid'),
        ('readingreminderemaildeliveries', 'occurrenceid', 'idx_readingreminderemaildeliveries_occurrenceid')
    ) as t(tbl_name, col_name, idx_name)
  loop
    tbl_oid := to_regclass('public.' || target.tbl_name);
    if tbl_oid is null then
      continue;
    end if;

    select a.attnum
      into col_attnum
      from pg_attribute a
     where a.attrelid = tbl_oid
       and a.attname = target.col_name
       and not a.attisdropped;

    if col_attnum is null then
      continue;
    end if;

    -- Skip if any non-partial valid index already has this FK column as its leading key.
    select exists (
      select 1
      from pg_index i
      where i.indrelid = tbl_oid
        and i.indisvalid
        and i.indpred is null
        and i.indkey[0] = col_attnum
    ) into leading_idx_exists;

    if not leading_idx_exists and to_regclass('public.' || target.idx_name) is null then
      execute format(
        'create index if not exists %I on public.%I (%I)',
        target.idx_name,
        target.tbl_name,
        target.col_name
      );
    end if;
  end loop;
end;
$hot_fk_indexes$;

commit;
