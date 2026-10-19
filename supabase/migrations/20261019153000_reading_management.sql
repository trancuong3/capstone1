-- Additive ViRead Reading Management schema. No existing reading data is dropped or rewritten.
begin;

create table if not exists public.readinggoals (
  id uuid primary key default gen_random_uuid(),
  childid uuid not null references public.childprofiles(id) on delete cascade,
  metric varchar(16) not null check (metric in ('MINUTES', 'SESSIONS')),
  targetvalue integer not null check (targetvalue > 0),
  period varchar(16) not null check (period in ('DAILY', 'WEEKLY')),
  startson date not null,
  endson date,
  timezone varchar(64) not null default 'Asia/Ho_Chi_Minh',
  status varchar(16) not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'COMPLETED', 'ENDED')),
  completedvalue integer,
  completedat timestamptz,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint ck_readinggoals_date_range check (endson is null or endson >= startson)
);
create index if not exists ix_readinggoals_child_status on public.readinggoals(childid, status);

create table if not exists public.childbookcollections (
  id uuid primary key default gen_random_uuid(),
  childid uuid not null references public.childprofiles(id) on delete cascade,
  bookid uuid not null references public.books(id) on delete restrict,
  collectiontype varchar(20) not null check (collectiontype in ('FAVORITE', 'WANT_TO_READ')),
  createdat timestamptz not null default now(),
  constraint uq_childbookcollections_child_book_type unique (childid, bookid, collectiontype)
);
create index if not exists ix_childbookcollections_child_type_created on public.childbookcollections(childid, collectiontype, createdat desc);

create table if not exists public.readingreminders (
  id uuid primary key default gen_random_uuid(),
  childid uuid not null references public.childprofiles(id) on delete cascade,
  remindat time not null,
  weekdays smallint[] not null default array[0,1,2,3,4,5,6]::smallint[],
  timezone varchar(64) not null default 'Asia/Ho_Chi_Minh',
  isactive boolean not null default true,
  deletedat timestamptz,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint ck_readingreminders_weekdays_count check (cardinality(weekdays) between 1 and 7),
  constraint ck_readingreminders_timezone_nonempty check (timezone <> '')
);
create index if not exists ix_readingreminders_child_active on public.readingreminders(childid, isactive) where deletedat is null;

create table if not exists public.readingreminderoccurrences (
  id uuid primary key default gen_random_uuid(),
  reminderid uuid not null references public.readingreminders(id) on delete cascade,
  scheduledlocaldate date not null,
  scheduledfor timestamptz not null,
  status varchar(16) not null default 'PENDING' check (status in ('PENDING', 'ACKNOWLEDGED')),
  acknowledgedat timestamptz,
  createdat timestamptz not null default now(),
  constraint uq_reminder_occurrence_local_day unique (reminderid, scheduledlocaldate)
);
create index if not exists ix_reminderoccurrences_status_scheduled on public.readingreminderoccurrences(status, scheduledfor);

alter table public.readinggoals enable row level security;
alter table public.childbookcollections enable row level security;
alter table public.readingreminders enable row level security;
alter table public.readingreminderoccurrences enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='readinggoals' and policyname='readinggoals_parent_owns_child') then
    create policy readinggoals_parent_owns_child on public.readinggoals for all to authenticated
      using (exists (select 1 from public.childprofiles c where c.id = childid and c.parentid = (select auth.uid())))
      with check (exists (select 1 from public.childprofiles c where c.id = childid and c.parentid = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='childbookcollections' and policyname='childbookcollections_parent_owns_child') then
    create policy childbookcollections_parent_owns_child on public.childbookcollections for all to authenticated
      using (exists (select 1 from public.childprofiles c where c.id = childid and c.parentid = (select auth.uid())))
      with check (exists (select 1 from public.childprofiles c where c.id = childid and c.parentid = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='readingreminders' and policyname='readingreminders_parent_owns_child') then
    create policy readingreminders_parent_owns_child on public.readingreminders for all to authenticated
      using (exists (select 1 from public.childprofiles c where c.id = childid and c.parentid = (select auth.uid())))
      with check (exists (select 1 from public.childprofiles c where c.id = childid and c.parentid = (select auth.uid())));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='readingreminderoccurrences' and policyname='readingreminderoccurrences_parent_owns_child') then
    create policy readingreminderoccurrences_parent_owns_child on public.readingreminderoccurrences for all to authenticated
      using (exists (select 1 from public.readingreminders r join public.childprofiles c on c.id = r.childid
        where r.id = reminderid and c.parentid = (select auth.uid())))
      with check (exists (select 1 from public.readingreminders r join public.childprofiles c on c.id = r.childid
        where r.id = reminderid and c.parentid = (select auth.uid())));
  end if;
end
$$;

grant all privileges on table public.readinggoals, public.childbookcollections, public.readingreminders, public.readingreminderoccurrences to service_role;

commit;
