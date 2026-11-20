-- Disposable PostgreSQL integration test for TASK 02.
-- DO NOT run against Supabase production. It requires the dedicated CI
-- database name; GitHub Actions discards the entire disposable DB after the job.
-- psql -X -v ON_ERROR_STOP=1 -f supabase/tests/security_hardening_disposable.sql

\set ON_ERROR_STOP on

do $guard$
begin
  if current_database() <> 'viread_security_ci' then
    raise exception 'Refusing non-disposable database: %', current_database();
  end if;
end;
$guard$;

-- This CI service is plain PostgreSQL; define the same client database roles.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create role supabase_auth_admin nologin;

create schema auth;
grant usage on schema auth to authenticated, supabase_auth_admin;

-- Minimal Auth representation with the exact fields used by the real trigger.
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
grant insert on auth.users to supabase_auth_admin;

create or replace function auth.uid() returns uuid
language sql stable
as $auth_uid$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$auth_uid$;
grant execute on function auth.uid() to authenticated;

-- Reproduce the sensitive public.profiles shape and its actual RLS policies.
create table public.profiles (
  id uuid primary key,
  role text not null default 'parent',
  displayname text,
  createdat timestamptz not null default now(),
  active smallint not null default 1,
  contact_phone text,
  avatar_path text
);
alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = id);

-- Replicate the drifted production grants to prove this migration closes it.
grant all privileges on public.profiles to anon, authenticated, service_role;

-- Exact contract and relevant logic of production signup trigger.
create or replace function public.handle_new_readalong_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $signup$
declare
  resolved_display_name text;
begin
  if nullif(pg_catalog.btrim(coalesce(new.email, '')), '') is null then
    raise exception using errcode = '23514', message = 'readalong_email_required';
  end if;

  resolved_display_name := coalesce(
    nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'name'), ''),
    'Ba mẹ'
  );

  insert into public.profiles (id, role, displayname, createdat)
  values (new.id, 'parent', resolved_display_name, now());
  return new;
end;
$signup$;

create trigger on_auth_user_created_readalong
after insert on auth.users for each row
execute function public.handle_new_readalong_user();

-- Production event trigger contract. Keep its SECURITY DEFINER semantics.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $rls$
declare cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
    end if;
  end loop;
end;
$rls$;

create event trigger ensure_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.rls_auto_enable();

grant execute on function public.handle_new_readalong_user()
  to anon, authenticated, service_role;
grant execute on function public.rls_auto_enable()
  to public, anon, authenticated, service_role;

do $baseline$
begin
  if not has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
    or not has_function_privilege('anon',
      'public.handle_new_readalong_user()'::regprocedure, 'EXECUTE')
    or not has_function_privilege('anon',
      'public.rls_auto_enable()'::regprocedure, 'EXECUTE') then
    raise exception 'The fixture must represent the vulnerable production grants';
  end if;
end;
$baseline$;

-- Execute the actual proposed migration (not a duplicate implementation).
\ir ../migrations/20261120100000_supabase_security_hardening.sql

-- Idempotence: rerunning the migration must remain safe.
\ir ../migrations/20261120100000_supabase_security_hardening.sql

do $rights$
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
    raise exception 'Definer EXECUTE privilege test failed';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
    or has_column_privilege('authenticated', 'public.profiles', 'active', 'UPDATE')
    or has_column_privilege('anon', 'public.profiles', 'displayname', 'UPDATE')
    or not has_column_privilege('authenticated', 'public.profiles', 'displayname', 'UPDATE')
    or not has_column_privilege('authenticated', 'public.profiles', 'contact_phone', 'UPDATE')
    or not has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'UPDATE') then
    raise exception 'Profile privileges test failed';
  end if;
end;
$rights$;

-- Simulate Auth's real database insert role: the trigger must still execute
-- even though no client has EXECUTE on its SECURITY DEFINER function.
set role supabase_auth_admin;
insert into auth.users(id,email,raw_user_meta_data)
values('11111111-1111-4111-8111-111111111111',
       'signup@example.invalid',
       '{"display_name":"Ba mẹ thử nghiệm"}'::jsonb);
reset role;

do $signup_check$
begin
  if not exists (select 1 from public.profiles
      where id='11111111-1111-4111-8111-111111111111'::uuid
        and role='parent' and active=1
        and displayname='Ba mẹ thử nghiệm') then
    raise exception 'Auth signup trigger no longer creates a parent profile';
  end if;
end;
$signup_check$;

-- The event trigger must remain enabled and enforce RLS on newly created
-- tables. We create one extra table only inside this disposable transaction.
create table public.security_hardening_new_table (id integer primary key);
do $rls_check$
begin
  if not exists (
    select 1 from pg_class c
    where c.oid='public.security_hardening_new_table'::regclass
      and c.relrowsecurity
  ) then
    raise exception 'ensure_rls event trigger did not enable RLS';
  end if;
end;
$rls_check$;

-- The real update policies must isolate parents by ID while preserving
-- harmless edits to the logged-in parent's own profile.
insert into public.profiles(id,role,displayname)
values('22222222-2222-4222-8222-222222222222','parent','Parent B');

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
set role authenticated;

do $parent_checks$
declare
  visible_count integer;
  changed integer;
begin
  select count(*) into visible_count from public.profiles;
  if visible_count <> 1 then
    raise exception 'RLS failed: parent can see % profiles',visible_count;
  end if;

  update public.profiles set displayname='Own profile edit'
  where id='11111111-1111-4111-8111-111111111111'::uuid;
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'Expected own safe profile edit to succeed';
  end if;

  update public.profiles set displayname='ILLEGAL cross-parent edit'
  where id='22222222-2222-4222-8222-222222222222'::uuid;
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'Parent edited another parent profile';
  end if;

  begin
    update public.profiles set role='admin'
    where id='11111111-1111-4111-8111-111111111111'::uuid;
    raise exception 'Privilege escalation: role update succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    update public.profiles set active=0
    where id='11111111-1111-4111-8111-111111111111'::uuid;
    raise exception 'Privilege escalation: active update succeeded';
  exception when insufficient_privilege then
    null;
  end;
end;
$parent_checks$;

reset role;

do $final$
begin
  if not exists (select 1 from public.profiles
      where id='11111111-1111-4111-8111-111111111111'::uuid
        and role='parent' and active=1 and displayname='Own profile edit')
     or not exists (select 1 from public.profiles
      where id='22222222-2222-4222-8222-222222222222'::uuid
        and displayname='Parent B') then
    raise exception 'Profile state changed contrary to authorization rules';
  end if;
end;
$final$;

-- The dedicated CI database is destroyed by the workflow. Never use real users.
reset request.jwt.claim.sub;
\echo 'PASS: Supabase SECURITY DEFINER, Auth signup, RLS, IDOR and profile grants'
