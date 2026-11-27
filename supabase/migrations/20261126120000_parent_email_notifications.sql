-- Parent email notification preferences and durable idempotent delivery ledger.
-- Supports automated weekly progress digests, long-inactivity nudges, milestone
-- celebrations, and parent-initiated test emails with anti-spam guardrails.
-- Recipient email addresses are NEVER persisted here: they are resolved at send
-- time from the verified Supabase Auth identity of the parent.
begin;

create table if not exists public.parentemailpreferences (
  parentid uuid primary key references public.profiles(id) on delete cascade,
  weeklydigestenabled boolean not null default true,
  inactivityalertenabled boolean not null default true,
  inactivitydays integer not null default 5
    check (inactivitydays between 2 and 30),
  milestoneenabled boolean not null default true,
  digestweekday smallint not null default 6
    check (digestweekday between 0 and 6),
  timezone varchar(64) not null default 'Asia/Ho_Chi_Minh'
    check (timezone <> ''),
  quiethoursstart smallint not null default 21
    check (quiethoursstart between 0 and 23),
  quiethoursend smallint not null default 7
    check (quiethoursend between 0 and 23),
  maxemailsperweek smallint not null default 4
    check (maxemailsperweek between 1 and 14),
  updatedat timestamptz not null default now()
);

create table if not exists public.parentemaildeliveries (
  id uuid primary key default gen_random_uuid(),
  parentid uuid not null references public.profiles(id) on delete cascade,
  childid uuid references public.childprofiles(id) on delete set null,
  category varchar(32) not null
    check (category in ('WEEKLY_DIGEST', 'INACTIVITY_ALERT', 'MILESTONE', 'TEST_EMAIL')),
  dedupekey varchar(160) not null,
  status varchar(20) not null default 'PENDING'
    check (status in ('PENDING', 'SENDING', 'SENT', 'RETRY', 'FAILED', 'SKIPPED')),
  subject varchar(200) not null,
  attempts integer not null default 0,
  lastattemptat timestamptz,
  nextattemptat timestamptz,
  sentat timestamptz,
  errorcode varchar(64),
  metadata jsonb not null default '{}'::jsonb,
  createdat timestamptz not null default now(),
  constraint uq_parentemaildeliveries_dedupekey unique (dedupekey)
);

create index if not exists ix_parentemaildeliveries_parent_created
  on public.parentemaildeliveries(parentid, createdat desc);
create index if not exists ix_parentemaildeliveries_parent_category_sent
  on public.parentemaildeliveries(parentid, category, sentat desc);
create index if not exists ix_parentemaildeliveries_retry
  on public.parentemaildeliveries(status, nextattemptat);
create index if not exists ix_parentemaildeliveries_child
  on public.parentemaildeliveries(childid)
  where childid is not null;

alter table public.parentemailpreferences enable row level security;
alter table public.parentemaildeliveries enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'parentemailpreferences'
        and policyname = 'parentemailpreferences_parent_owns'
    ) then
      create policy parentemailpreferences_parent_owns
        on public.parentemailpreferences for all to authenticated
        using (parentid = (select auth.uid()))
        with check (parentid = (select auth.uid()));
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'parentemaildeliveries'
        and policyname = 'parentemaildeliveries_parent_reads'
    ) then
      -- Parents may only read their own delivery history. All writes go through the backend.
      create policy parentemaildeliveries_parent_reads
        on public.parentemaildeliveries for select to authenticated
        using (parentid = (select auth.uid()));
    end if;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.parentemailpreferences from anon';
    execute 'revoke all privileges on table public.parentemaildeliveries from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all privileges on table public.parentemailpreferences to service_role';
    execute 'grant all privileges on table public.parentemaildeliveries to service_role';
  end if;
end
$$;

commit;
