-- Phase 4 parent authentication support.
--
-- The production database already contains legacy profiles that are referenced
-- by childprofiles but do not have matching auth.users rows. The foreign key is
-- therefore intentionally NOT VALID: PostgreSQL enforces it for new and updated
-- rows without rejecting the existing legacy graph. Do not validate this
-- constraint until the legacy profiles have been migrated by the database team.

begin;

alter table public.profiles
  alter column role set default 'parent';

alter table public.profiles
  alter column role set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_role_check'
  ) then
    alter table public.profiles
      add constraint profiles_role_check
      check (role in ('parent', 'admin'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and confrelid = 'auth.users'::regclass
      and contype = 'f'
  ) then
    alter table public.profiles
      add constraint profiles_id_auth_users_fkey
      foreign key (id)
      references auth.users (id)
      on delete cascade
      not valid;
  end if;
end
$$;

create or replace function public.handle_new_readalong_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (
    id,
    role,
    displayname,
    createdat
  )
  values (
    new.id,
    'parent',
    coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      'Ba mẹ'
    ),
    now()
  );

  return new;
end;
$$;

revoke all
  on function public.handle_new_readalong_user()
  from public;

revoke all
  on function public.handle_new_readalong_user()
  from anon, authenticated;

drop trigger if exists on_auth_user_created_readalong on auth.users;

create trigger on_auth_user_created_readalong
  after insert on auth.users
  for each row
  execute function public.handle_new_readalong_user();

alter table public.profiles enable row level security;

revoke all privileges
  on table public.profiles
  from anon, authenticated;

grant select
  on table public.profiles
  to authenticated;

grant update (displayname)
  on table public.profiles
  to authenticated;

grant all privileges
  on table public.profiles
  to service_role;

drop policy if exists profiles_select_own
  on public.profiles;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = id
  );

drop policy if exists profiles_update_own
  on public.profiles;

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = id
  )
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = id
  );

commit;
