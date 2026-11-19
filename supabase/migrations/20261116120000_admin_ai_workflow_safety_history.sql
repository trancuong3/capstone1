begin;

alter table public.adminaiworkflows
  add column if not exists safetyhistory jsonb not null default '[]'::jsonb;

commit;
