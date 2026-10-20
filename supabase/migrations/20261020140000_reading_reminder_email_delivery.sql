-- Additive email delivery outbox for Reading Management. Safe for existing reminders.
begin;

alter table public.readingreminders
  add column if not exists emailenabled boolean not null default false;
alter table public.readingreminders
  add column if not exists emailenabledat timestamptz;

create table if not exists public.readingreminderemaildeliveries (
  id uuid primary key default gen_random_uuid(),
  -- Stable logical key survives hard deletion of reminder/occurrence rows.
  occurrencekey uuid not null,
  occurrenceid uuid references public.readingreminderoccurrences(id) on delete set null,
  reminderid uuid references public.readingreminders(id) on delete set null,
  -- Snapshot the owning Parent id at queue time; never persist the email address.
  parentid uuid not null,
  status varchar(16) not null default 'PENDING'
    check (status in ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED')),
  attemptcount integer not null default 0 check (attemptcount >= 0),
  lastattemptat timestamptz,
  nextattemptat timestamptz default now(),
  provideracceptedat timestamptz,
  providermessageid varchar(255),
  lasterrorcode varchar(80),
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint uq_reminder_email_delivery_occurrence_key unique (occurrencekey),
  constraint uq_reminder_email_delivery_provider_message unique (providermessageid)
);

create index if not exists ix_reminder_email_delivery_due
  on public.readingreminderemaildeliveries(status, nextattemptat);
create index if not exists ix_reminder_email_delivery_parent_created
  on public.readingreminderemaildeliveries(parentid, createdat desc);

alter table public.readingreminderemaildeliveries enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'readingreminderemaildeliveries'
      and policyname = 'readingreminderemaildeliveries_parent_read_own'
  ) then
    create policy readingreminderemaildeliveries_parent_read_own
      on public.readingreminderemaildeliveries
      for select to authenticated
      using (parentid = (select auth.uid()));
  end if;
end
$$;

-- Parents can inspect only their rows; only trusted backend credentials may mutate deliveries.
revoke all privileges on table public.readingreminderemaildeliveries from authenticated;
grant select on table public.readingreminderemaildeliveries to authenticated;
grant all privileges on table public.readingreminderemaildeliveries to service_role;

commit;
