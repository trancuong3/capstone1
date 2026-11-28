-- Feature #8: Offline Reading Pack ("Gói Đọc Ngoại Tuyến") & Idempotent Session Outbox Sync.
-- Durable per-parent idempotency ledger (`offline_sync_events`) ensuring flaky-network
-- retries never duplicate reading sessions, word attempts, or fluency assessments, and
-- recording stale `page_revision_id` reconciliations transparently.
begin;

create table if not exists public.offline_sync_events (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles(id) on delete cascade,
  child_id uuid not null references public.childprofiles(id) on delete cascade,
  client_event_id uuid not null,
  client_session_id uuid not null,
  server_session_id uuid references public.readingsessions(id) on delete set null,
  book_id uuid not null references public.books(id) on delete cascade,
  page_id uuid not null references public.bookpages(id) on delete cascade,
  page_revision_id uuid references public.pagerevisions(id) on delete set null,
  reconciled_revision_id uuid references public.pagerevisions(id) on delete set null,
  event_kind varchar(40) not null
    check (event_kind in ('SESSION_START', 'PAGE_READ', 'WORD_ATTEMPT', 'SESSION_FINISH')),
  idempotency_key varchar(160),
  stale_revision_reconciled boolean not null default false,
  status varchar(24) not null default 'APPLIED'
    check (status in ('APPLIED', 'RECONCILED')),
  payload_hash varchar(64) not null,
  result_meta jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint uq_offline_sync_events_parent_event unique (parent_id, client_event_id)
);

create index if not exists ix_offline_sync_events_parent_child_created
  on public.offline_sync_events(parent_id, child_id, created_at desc);

create index if not exists ix_offline_sync_events_parent_client_session
  on public.offline_sync_events(parent_id, child_id, client_session_id);

create index if not exists ix_offline_sync_events_server_session
  on public.offline_sync_events(server_session_id)
  where server_session_id is not null;

alter table public.offline_sync_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'offline_sync_events'
        and policyname = 'offline_sync_events_parent_reads'
    ) then
      -- Parents may only read their own household offline sync ledger rows.
      -- All mutations are mediated by the authenticated FastAPI outbox service.
      create policy offline_sync_events_parent_reads
        on public.offline_sync_events for select to authenticated
        using (parent_id = (select auth.uid()));
    end if;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.offline_sync_events from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all privileges on table public.offline_sync_events to service_role';
  end if;
end
$$;

commit;
