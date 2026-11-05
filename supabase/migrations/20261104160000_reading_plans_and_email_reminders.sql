-- Add first-class weekly reading plans and durable reminder email delivery state.
begin;

create table if not exists public.readingplans (
  id uuid primary key default gen_random_uuid(),
  childid uuid not null references public.childprofiles(id) on delete cascade,
  bookid uuid references public.books(id) on delete set null,
  title varchar(100) not null check (length(trim(title)) between 1 and 100),
  targetminutes integer not null default 20 check (targetminutes between 5 and 240),
  weekdays smallint[] not null default array[0,2,4]::smallint[]
    check (cardinality(weekdays) between 1 and 7)
    check (weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
  startson date not null,
  endson date,
  timezone varchar(64) not null default 'Asia/Ho_Chi_Minh' check (timezone <> ''),
  status varchar(16) not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'COMPLETED', 'ENDED')),
  completedat timestamptz,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint ck_readingplans_date_range check (endson is null or endson >= startson)
);
create index if not exists ix_readingplans_child_status on public.readingplans(childid, status);

alter table public.readingreminders
  add column if not exists emailenabled boolean not null default false;

alter table public.readingreminderoccurrences
  add column if not exists emailstatus varchar(20) not null default 'NOT_REQUESTED',
  add column if not exists emailattempts integer not null default 0,
  add column if not exists emaillastattemptat timestamptz,
  add column if not exists emailnextattemptat timestamptz,
  add column if not exists emailsentat timestamptz,
  add column if not exists emailerrorcode varchar(64);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ck_reminderoccurrence_email_status'
      and conrelid = 'public.readingreminderoccurrences'::regclass
  ) then
    alter table public.readingreminderoccurrences
      add constraint ck_reminderoccurrence_email_status
      check (emailstatus in ('NOT_REQUESTED', 'PENDING', 'SENDING', 'RETRY', 'SENT', 'FAILED'));
  end if;
end
$$;
create index if not exists ix_reminderoccurrences_email_delivery
  on public.readingreminderoccurrences(emailstatus, emailnextattemptat);

alter table public.readingplans enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'readingplans'
      and policyname = 'readingplans_parent_owns_child'
  ) then
    create policy readingplans_parent_owns_child on public.readingplans for all to authenticated
      using (exists (
        select 1 from public.childprofiles c
        where c.id = childid and c.parentid = (select auth.uid())
      ))
      with check (exists (
        select 1 from public.childprofiles c
        where c.id = childid and c.parentid = (select auth.uid())
      ));
  end if;
end
$$;

grant all privileges on table public.readingplans to service_role;
commit;
