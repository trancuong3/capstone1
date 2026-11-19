begin;

alter table public.pagerevisions
  add column if not exists originalocrtext text;

update public.pagerevisions
set originalocrtext = coalesce(originalocrtext, drafttext, verifiedtext, '')
where originalocrtext is null;

create table if not exists public.adminaiworkflows (
  id uuid primary key default gen_random_uuid(),
  pageid uuid not null references public.bookpages(id) on delete cascade,
  bookid uuid not null references public.books(id) on delete cascade,
  pagerevisionid uuid not null references public.pagerevisions(id) on delete cascade,
  actorid uuid references public.profiles(id) on delete set null,
  idempotencykey uuid not null,
  originaltext text not null,
  inputtext text not null,
  inputwords jsonb not null default '[]'::jsonb,
  imagepath text not null,
  originalocrhash varchar(64) not null,
  admininputhash varchar(64) not null,
  proofreadtext text,
  proofreadoutputhash varchar(64),
  candidatetext text,
  candidatehash varchar(64),
  candidateversion integer not null default 0,
  candidatehistory jsonb not null default '[]'::jsonb,
  safetyinputhash varchar(64),
  suitability varchar(32),
  safetystatus varchar(32) not null default 'PENDING',
  findings jsonb not null default '[]'::jsonb,
  correctionsuggestions jsonb not null default '[]'::jsonb,
  uncertainwordindices jsonb not null default '[]'::jsonb,
  providerevents jsonb not null default '[]'::jsonb,
  proofreadmetadata jsonb not null default '{}'::jsonb,
  safetymetadata jsonb not null default '{}'::jsonb,
  reviewevents jsonb not null default '[]'::jsonb,
  status varchar(40) not null default 'QUEUED',
  stage varchar(40) not null default 'PROOFREADING',
  completedchunks integer not null default 0,
  totalchunks integer not null default 1,
  attempts integer not null default 0,
  errorcode varchar(80),
  workerid varchar(120),
  leaseexpiresat timestamptz,
  retryafter timestamptz,
  safetyconfirmedat timestamptz,
  safetyconfirmedby uuid references public.profiles(id) on delete set null,
  ocrapprovedat timestamptz,
  ocrapprovedby uuid references public.profiles(id) on delete set null,
  finalapprovedtexthash varchar(64),
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint uq_adminaiworkflows_idempotency unique(actorid, pageid, idempotencykey),
  constraint ck_adminaiworkflows_candidate_version check (candidateversion >= 0),
  constraint ck_adminaiworkflows_progress check (
    completedchunks >= 0 and totalchunks >= 1 and completedchunks <= totalchunks
  ),
  constraint ck_adminaiworkflows_suitability check (
    suitability is null or suitability in ('SUITABLE','SUITABLE_WITH_GUIDANCE','REVIEW_REQUIRED','NOT_RECOMMENDED')
  )
);

alter table public.adminaiworkflows
  add column if not exists reviewevents jsonb not null default '[]'::jsonb;

create index if not exists ix_adminaiworkflows_input_hash
  on public.adminaiworkflows(pageid, pagerevisionid, admininputhash, createdat desc);

create index if not exists ix_adminaiworkflows_page_created
  on public.adminaiworkflows(pageid, createdat desc);
create index if not exists ix_adminaiworkflows_queue
  on public.adminaiworkflows(status, retryafter, leaseexpiresat, createdat)
  where status in ('QUEUED','PROOFREADING','CHILD_SAFETY_SCANNING');
create index if not exists ix_adminaiworkflows_candidate_hash
  on public.adminaiworkflows(pageid, candidatehash);

alter table public.adminaiworkflows enable row level security;
revoke all privileges on table public.adminaiworkflows from anon, authenticated;
grant all privileges on table public.adminaiworkflows to service_role;

commit;
