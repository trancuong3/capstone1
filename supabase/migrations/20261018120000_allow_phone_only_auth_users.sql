-- Allow phone-only Supabase Auth users while keeping the profile trigger authoritative.
-- Contact identifiers live in auth.users; public.profiles does not require an email column.

begin;

create or replace function public.handle_new_readalong_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_display_name text;
begin
  resolved_display_name := coalesce(
    nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'name'), ''),
    'Ba mẹ'
  );

  insert into public.profiles (
    id,
    role,
    displayname,
    createdat
  )
  values (
    new.id,
    'parent',
    resolved_display_name,
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

commit;
