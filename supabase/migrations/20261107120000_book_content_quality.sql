-- Additive PostgreSQL schema for Parent book-content reports and durable full-book scans.
-- Reports, scan runs, page snapshots and findings retain source snapshots; no existing
-- BookPage, PageRevision or PageRevisionWord rows are rewritten or deleted.
begin;

create table if not exists public.bookqualityscanruns (
  id uuid primary key default gen_random_uuid(),
  bookid uuid references public.books(id) on delete set null,
  booktitlesnapshot varchar(500) not null,
  triggertype varchar(24) not null check (triggertype in ('PARENT_REPORT', 'ADMIN_MANUAL', 'STALE_RESCAN')),
  scan_scope varchar(8) not null default 'BOOK' check (scan_scope in ('BOOK', 'PAGE')),
  targetpageid uuid references public.bookpages(id) on delete set null,
  status varchar(16) not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  totalpages integer not null default 0 check (totalpages >= 0),
  completedpages integer not null default 0 check (completedpages >= 0),
  skippedpages integer not null default 0 check (skippedpages >= 0),
  failedpages integer not null default 0 check (failedpages >= 0),
  aicompletedpages integer not null default 0 check (aicompletedpages >= 0),
  aiunavailablepages integer not null default 0 check (aiunavailablepages >= 0),
  errorsummary varchar(2000),
  attemptcount integer not null default 0 check (attemptcount >= 0),
  workerid varchar(120),
  leaseexpiresat timestamptz,
  startedat timestamptz,
  completedat timestamptz,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now()
);

create table if not exists public.bookcontentreports (
  id uuid primary key default gen_random_uuid(),
  reporterid uuid references public.profiles(id) on delete set null,
  reporternamesnapshot varchar(160),
  bookid uuid references public.books(id) on delete set null,
  booktitlesnapshot varchar(500) not null,
  pageid uuid references public.bookpages(id) on delete set null,
  pagenumbersnapshot integer,
  pagerevisionid uuid references public.pagerevisions(id) on delete set null,
  verifiedtextsnapshot text,
  contenthashsnapshot varchar(128),
  issuetype varchar(40) not null check (issuetype in (
    'BOOK_METADATA_ERROR', 'SPELLING_ERROR', 'MISSING_CONTENT', 'OCR_MISMATCH',
    'IMAGE_QUALITY_ERROR', 'DUPLICATE_PAGE', 'PAGE_ORDER_ERROR', 'OTHER'
  )),
  description varchar(4000) not null check (length(btrim(description)) between 1 and 4000),
  reportedtext varchar(1200),
  suggestedcorrection varchar(1200),
  idempotencykey uuid not null,
  scanrunid uuid references public.bookqualityscanruns(id) on delete set null,
  status varchar(20) not null default 'OPEN' check (status in ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')),
  adminresolutionnote varchar(2000),
  reviewedby uuid references public.profiles(id) on delete set null,
  reviewedbynamesnapshot varchar(160),
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  resolvedat timestamptz,
  constraint uq_bookcontentreports_reporter_idempotency unique (reporterid, idempotencykey)
);

create table if not exists public.bookqualitypagescans (
  id uuid primary key default gen_random_uuid(),
  scanrunid uuid not null references public.bookqualityscanruns(id) on delete restrict,
  bookid uuid references public.books(id) on delete set null,
  pageid uuid references public.bookpages(id) on delete set null,
  pagenumbersnapshot integer not null check (pagenumbersnapshot > 0),
  pagelifecyclesnapshot varchar(20) not null,
  pagerevisionid uuid references public.pagerevisions(id) on delete set null,
  contenthash varchar(128),
  verifiedtextsnapshot text,
  status varchar(20) not null default 'QUEUED' check (status in (
    'QUEUED', 'RUNNING', 'COMPLETED', 'NOT_SCANNABLE', 'STALE', 'FAILED'
  )),
  rulecheckstatus varchar(16) not null default 'PENDING' check (rulecheckstatus in ('PENDING', 'COMPLETED', 'FAILED', 'SKIPPED')),
  aianalysisstatus varchar(16) not null default 'PENDING' check (aianalysisstatus in ('PENDING', 'COMPLETED', 'UNAVAILABLE', 'FAILED', 'SKIPPED')),
  rejectedaifindingcount integer not null default 0 check (rejectedaifindingcount >= 0),
  attemptcount integer not null default 0 check (attemptcount >= 0),
  errorcode varchar(80),
  errorsummary varchar(1000),
  startedat timestamptz,
  completedat timestamptz,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint uq_bookqualitypagescans_run_page unique (scanrunid, pageid)
);

create table if not exists public.bookqualityfindings (
  id uuid primary key default gen_random_uuid(),
  pagescanid uuid not null references public.bookqualitypagescans(id) on delete restrict,
  bookid uuid references public.books(id) on delete set null,
  pageid uuid references public.bookpages(id) on delete set null,
  pagerevisionid uuid references public.pagerevisions(id) on delete set null,
  issuetype varchar(50) not null,
  severity varchar(10) not null check (severity in ('LOW', 'MEDIUM', 'HIGH')),
  originalexcerpt text not null,
  excerptstart integer not null check (excerptstart >= 0),
  excerptend integer not null check (excerptend >= excerptstart),
  suggestedcorrection varchar(1200),
  explanation varchar(2000) not null,
  detectionsource varchar(20) not null check (detectionsource in ('RULE', 'OLLAMA_TEXT')),
  modelname varchar(160),
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status varchar(20) not null default 'NEEDS_REVIEW' check (status in (
    'NEEDS_REVIEW', 'CONFIRMED', 'DISMISSED', 'RESOLVED', 'STALE'
  )),
  reviewedby uuid references public.profiles(id) on delete set null,
  reviewnote varchar(2000),
  reviewedat timestamptz,
  createdat timestamptz not null default now(),
  constraint uq_bookqualityfindings_scan_evidence unique (
    pagescanid, issuetype, excerptstart, excerptend, detectionsource
  )
);

create table if not exists public.bookqualityreportfindings (
  reportid uuid not null references public.bookcontentreports(id) on delete cascade,
  findingid uuid not null references public.bookqualityfindings(id) on delete cascade,
  constraint pk_bookqualityreportfindings primary key (reportid, findingid)
);

create table if not exists public.bookcontentreporthistory (
  id uuid primary key default gen_random_uuid(),
  reportid uuid not null references public.bookcontentreports(id) on delete restrict,
  actorid uuid references public.profiles(id) on delete set null,
  actornamesnapshot varchar(160),
  fromstatus varchar(20) check (fromstatus is null or fromstatus in ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')),
  tostatus varchar(20) not null check (tostatus in ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')),
  note varchar(2000),
  createdat timestamptz not null default now()
);

create index if not exists ix_bookqualityscanruns_queue
  on public.bookqualityscanruns(status, createdat);
create index if not exists ix_bookqualityscanruns_book_created
  on public.bookqualityscanruns(bookid, createdat desc);
create index if not exists ix_bookcontentreports_status_created
  on public.bookcontentreports(status, createdat desc);
create index if not exists ix_bookcontentreports_book_created
  on public.bookcontentreports(bookid, createdat desc);
create index if not exists ix_bookcontentreports_page_created
  on public.bookcontentreports(pageid, createdat desc);
create index if not exists ix_bookcontentreports_reporter_created
  on public.bookcontentreports(reporterid, createdat desc);
create index if not exists ix_bookqualitypagescans_run_status
  on public.bookqualitypagescans(scanrunid, status);
create index if not exists ix_bookqualitypagescans_page_revision
  on public.bookqualitypagescans(pageid, pagerevisionid);
create index if not exists ix_bookqualityfindings_book_status
  on public.bookqualityfindings(bookid, status);
create index if not exists ix_bookqualityfindings_page_revision
  on public.bookqualityfindings(pageid, pagerevisionid);
create index if not exists ix_bookqualityfindings_pagescan
  on public.bookqualityfindings(pagescanid);
create index if not exists ix_bookqualityreportfindings_finding
  on public.bookqualityreportfindings(findingid);
create index if not exists ix_bookcontentreporthistory_report_created
  on public.bookcontentreporthistory(reportid, createdat);

alter table public.bookqualityscanruns enable row level security;
alter table public.bookcontentreports enable row level security;
alter table public.bookqualitypagescans enable row level security;
alter table public.bookqualityfindings enable row level security;
alter table public.bookqualityreportfindings enable row level security;
alter table public.bookcontentreporthistory enable row level security;

revoke all privileges on table
  public.bookqualityscanruns,
  public.bookcontentreports,
  public.bookqualitypagescans,
  public.bookqualityfindings,
  public.bookqualityreportfindings,
  public.bookcontentreporthistory
from anon, authenticated;

grant all privileges on table
  public.bookqualityscanruns,
  public.bookcontentreports,
  public.bookqualitypagescans,
  public.bookqualityfindings,
  public.bookqualityreportfindings,
  public.bookcontentreporthistory
to service_role;

commit;
