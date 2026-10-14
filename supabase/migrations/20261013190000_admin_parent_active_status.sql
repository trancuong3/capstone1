-- Ensure Parent visibility state exists and new Auth-triggered profiles are active.
-- Existing active=0 rows remain inactive; only NULL values are backfilled.
begin;

alter table public.profiles
  add column if not exists active smallint not null default 1;

update public.profiles
set active = 1
where active is null;

alter table public.profiles
  alter column active set default 1;

alter table public.profiles
  alter column active set not null;

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
    createdat,
    active
  )
  values (
    new.id,
    'parent',
    coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      'Ba mẹ'
    ),
    now(),
    1
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

commit;
