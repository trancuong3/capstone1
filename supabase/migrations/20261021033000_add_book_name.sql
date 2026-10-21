-- Add an independent display name without renaming or overwriting books.title.
-- Existing non-blank titles seed legacy names once; blank titles become NULL so
-- legacy records remain repairable. Future writes to name and title are independent.
begin;

alter table public.books
  add column if not exists name text;

update public.books
set name = nullif(btrim(title), '')
where name is null;

comment on column public.books.name is
  'Independent book name; not synchronized with books.title after the legacy backfill.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.books'::regclass
      and conname = 'books_name_not_blank'
  ) then
    alter table public.books
      add constraint books_name_not_blank
      check (name is null or length(btrim(name)) > 0);
  end if;
end
$$;

commit;
