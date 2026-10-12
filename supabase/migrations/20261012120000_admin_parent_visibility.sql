-- Persist Admin-only visibility state for Parent profiles.
-- Existing rows remain visible because the new column is nullable.
-- Hide/restore only UPDATE this column; they never delete Parent/Auth/Child/history data.

begin;

alter table public.profiles
  add column if not exists admin_hidden_at timestamptz null;

create index if not exists ix_profiles_admin_hidden_at
  on public.profiles (admin_hidden_at)
  where admin_hidden_at is not null;

comment on column public.profiles.admin_hidden_at is
  'Admin directory visibility only. NULL = visible; non-NULL = hidden. Does not disable Auth or delete related data.';

commit;
