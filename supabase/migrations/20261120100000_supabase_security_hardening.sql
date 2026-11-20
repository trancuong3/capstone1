-- TASK 02: constrain public SECURITY DEFINER execution and mutable profile columns.
--
-- Production application is manual/reviewed only. This migration is not run
-- by this PR or by the read-only Supabase audit.
--
-- Both trigger functions retain their existing owners, bodies, search_path,
-- SECURITY DEFINER semantics and trigger bindings. The service_role grants are
-- not changed. A real Auth INSERT fires its trigger without an HTTP client's
-- EXECUTE privilege on the function.
--
-- Profile RLS already restricts reads and writes to auth.uid() = profiles.id.
-- Column-level UPDATE privileges complement (but do not replace) that policy:
-- clients may edit presentation/contact fields but cannot promote their role,
-- reactivate a deactivated account, alter IDs or creation timestamps.
--
-- No policies are added to server-owned RLS tables.

begin;

-- Abort atomically if production has unexpectedly different trigger wiring.
do $preflight$
begin
  if to_regprocedure('public.handle_new_readalong_user()') is null
      or to_regprocedure('public.rls_auto_enable()') is null
      or to_regclass('public.profiles') is null
      or to_regclass('auth.users') is null then
    raise exception 'supabase_security_hardening: expected functions/tables missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    where p.oid = 'public.handle_new_readalong_user()'::regprocedure
      and p.prosecdef
      and p.prorettype = 'trigger'::regtype
  ) or not exists (
    select 1
    from pg_proc p
    where p.oid = 'public.rls_auto_enable()'::regprocedure
      and p.prosecdef
      and p.prorettype = 'event_trigger'::regtype
  ) then
    raise exception 'supabase_security_hardening: unexpected function contracts';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    where t.tgname = 'on_auth_user_created_readalong'
      and t.tgrelid = 'auth.users'::regclass
      and t.tgfoid = 'public.handle_new_readalong_user()'::regprocedure
      and t.tgenabled in ('O','A')
  ) or not exists (
    select 1
    from pg_event_trigger e
    where e.evtname = 'ensure_rls'
      and e.evtfoid = 'public.rls_auto_enable()'::regprocedure
      and e.evtenabled in ('O','A')
  ) then
    raise exception 'supabase_security_hardening: trigger wiring differs; review manually';
  end if;

  if not has_function_privilege('service_role',
       'public.handle_new_readalong_user()'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.rls_auto_enable()'::regprocedure, 'EXECUTE') then
    raise exception 'supabase_security_hardening: unexpected service_role grants';
  end if;
end;
$preflight$;

-- Revoke direct and inherited (PUBLIC) access.  Crucially, do not revoke
-- from service_role or postgres, alter the trigger, or change search_path.
revoke execute on function public.handle_new_readalong_user()
  from public, anon, authenticated;
revoke execute on function public.rls_auto_enable()
  from public, anon, authenticated;

-- Guard against role escalation through profiles_update_own: RLS alone does
-- not stop updates to the actor's own role/active fields.
-- The previous application migration explicitly intended these narrow grants;
-- production privileges had subsequently drifted to table-level ALL.
revoke all privileges on table public.profiles
  from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (displayname, contact_phone, avatar_path)
  on table public.profiles to authenticated;

-- Verify the intended invariants before committing, rolling back on any drift.
do $postflight$
begin
  if has_function_privilege('anon',
        'public.handle_new_readalong_user()'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated',
        'public.handle_new_readalong_user()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon',
        'public.rls_auto_enable()'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated',
        'public.rls_auto_enable()'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role',
        'public.handle_new_readalong_user()'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role',
        'public.rls_auto_enable()'::regprocedure, 'EXECUTE') then
    raise exception 'supabase_security_hardening: function privileges incorrect';
  end if;

  if has_table_privilege('anon', 'public.profiles', 'SELECT')
     or has_column_privilege('anon', 'public.profiles', 'role', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'active', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'createdat', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.profiles', 'SELECT')
     or not has_column_privilege('authenticated', 'public.profiles', 'displayname', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.profiles', 'contact_phone', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'UPDATE')
     or not has_table_privilege('service_role', 'public.profiles', 'SELECT')
     or not has_table_privilege('service_role', 'public.profiles', 'UPDATE') then
    raise exception 'supabase_security_hardening: profile privileges incorrect';
  end if;
end;
$postflight$;

commit;
