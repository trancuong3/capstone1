-- DEF-005 manual rollback. DO NOT apply to production automatically.
-- Removes only the hot FK indexes created by
-- 20261125120000_security_hardening_and_hot_fk_indexes.sql.
--
-- Security posture note:
-- Per docs/security/TASK02_SUPABASE_HARDENING.md, client EXECUTE revocations
-- on SECURITY DEFINER trigger functions (sync_profile_role_to_auth_metadata,
-- handle_new_readalong_user, rls_auto_enable) and search_path locks are NOT
-- automatically reverted here because re-granting EXECUTE to anon/authenticated
-- would reopen Security Advisor privilege-escalation findings. Any emergency
-- permission grant requires explicit security/DBA approval.
--
-- Idempotent, safe on full and minimal DBs, and preserves all tables, FKs,
-- constraints, triggers, and pre-existing indexes/data.

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $rollback_hot_fk_indexes$
declare
  target record;
  idx_oid oid;
  expected_def text;
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
    idx_oid := to_regclass('public.' || target.idx_name);
    if idx_oid is null then
      continue;
    end if;

    expected_def := format(
      'CREATE INDEX %I ON public.%I USING btree (%I)',
      target.idx_name,
      target.tbl_name,
      target.col_name
    );

    -- Do not drop a constraint-backed index or an unrelated index that reused the name.
    if exists (select 1 from pg_constraint where conindid = idx_oid)
       or pg_get_indexdef(idx_oid) is distinct from expected_def then
      raise exception 'security_hardening_and_hot_fk_indexes_rollback: unexpected definition or constraint dependency for %',
        target.idx_name;
    end if;

    execute format('drop index if exists public.%I', target.idx_name);
  end loop;
end;
$rollback_hot_fk_indexes$;

commit;
