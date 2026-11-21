-- Opt-in "reading paused: nobody in frame" parent email.
-- Stores only state/timestamps. No images, audio, transcripts or book text.
-- The recipient is never stored: it is the verified auth email of the session
-- owner, resolved server-side when the worker sends.
begin;

create table if not exists public.readingpresencesettings (
  parentid uuid primary key references public.profiles(id) on delete cascade,
  emailenabled boolean not null default false,
  updatedat timestamptz not null default now()
);

create table if not exists public.readingpresencealerts (
  id uuid primary key default gen_random_uuid(),
  sessionid uuid not null references public.readingsessions(id) on delete cascade,
  parentid uuid not null references public.profiles(id) on delete cascade,
  childid uuid not null references public.childprofiles(id) on delete cascade,
  episodeid uuid not null,
  status varchar(16) not null default 'PENDING',
  dueat timestamptz not null,
  expiresat timestamptz not null,
  lastconfirmedat timestamptz not null,
  attempts integer not null default 0,
  claimedat timestamptz,
  sentat timestamptz,
  cancelreason varchar(32),
  errorcode varchar(64),
  createdat timestamptz not null default now(),
  constraint ck_readingpresencealerts_status
    check (status in ('PENDING', 'SENDING', 'SENT', 'CANCELLED', 'EXPIRED', 'FAILED')),
  constraint uq_readingpresencealerts_session_episode unique (sessionid, episodeid),
  constraint ck_readingpresencealerts_window check (expiresat > dueat)
);
create index if not exists ix_readingpresencealerts_due
  on public.readingpresencealerts(status, dueat);
create index if not exists ix_readingpresencealerts_parent_created
  on public.readingpresencealerts(parentid, createdat);

alter table public.readingpresencesettings enable row level security;
alter table public.readingpresencealerts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'readingpresencesettings'
      and policyname = 'readingpresencesettings_parent_owns'
  ) then
    create policy readingpresencesettings_parent_owns
      on public.readingpresencesettings for all to authenticated
      using (parentid = (select auth.uid()))
      with check (parentid = (select auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'readingpresencealerts'
      and policyname = 'readingpresencealerts_parent_reads'
  ) then
    -- Parents may only read their own alerts. All writes go through the backend.
    create policy readingpresencealerts_parent_reads
      on public.readingpresencealerts for select to authenticated
      using (parentid = (select auth.uid()));
  end if;
end
$$;

commit;
