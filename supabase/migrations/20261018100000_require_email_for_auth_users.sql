-- Require an email for every newly created ReadAlong Auth account.
-- Supabase Auth owns the email address in auth.users; public.profiles intentionally
-- stores only the profile ID, role, display name, and creation timestamp.

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
  if nullif(pg_catalog.btrim(coalesce(new.email, '')), '') is null then
    raise exception using
      errcode = '23514',
      message = 'readalong_email_required';
  end if;

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
