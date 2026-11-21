-- Additive PostgreSQL migration for:
-- 1. Admin manual Image Safety review fields on public.adminaiworkflows
-- 2. Rights / usage-permission evidence persistence & immutable history
-- 3. Expanded Parent report issue types (CHILD_SAFETY_CONCERN, COPYRIGHT_CONCERN)
--
-- Strictly additive: preserves all existing books, verified revisions, workflows,
-- and legacy approval decisions without deleting or mass-invalidating historical rows.
begin;

-- 1. Image safety separation & source-image SHA-256 binding on adminaiworkflows
alter table public.adminaiworkflows
  add column if not exists sourceimagesha256 varchar(64),
  add column if not exists imagesafetystatus varchar(40) not null default 'UNASSESSED_NO_VISION_MODEL',
  add column if not exists imagesafetyreviewedat timestamptz,
  add column if not exists imagesafetyreviewedby uuid references public.profiles(id) on delete set null,
  add column if not exists imagesafetyimagesha256 varchar(64),
  add column if not exists imagesafetyreason varchar(500);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ck_adminaiworkflows_image_safety_status'
      and conrelid = 'public.adminaiworkflows'::regclass
  ) then
    alter table public.adminaiworkflows
      add constraint ck_adminaiworkflows_image_safety_status
      check (imagesafetystatus in (
        'UNASSESSED_NO_VISION_MODEL',
        'ADMIN_CONFIRMED_SAFE',
        'ADMIN_FLAGGED_UNSAFE'
      ));
  end if;
end $$;

-- 2. Rights / content usage-permission evidence and versioned audit history
create table if not exists public.bookrightsevidences (
  id uuid primary key default gen_random_uuid(),
  bookid uuid not null references public.books(id) on delete cascade,
  pageid uuid references public.bookpages(id) on delete cascade,
  scope varchar(8) not null default 'BOOK'
    check (scope in ('BOOK', 'PAGE')),
  status varchar(32) not null default 'UNASSESSED'
    check (status in ('UNASSESSED', 'INSUFFICIENT_EVIDENCE', 'CONCERN_FLAGGED', 'RIGHTS_REVIEWED')),
  sourcedescription varchar(500),
  authororrightsholder varchar(300),
  usagebasis varchar(120),
  evidenceurlorref varchar(1000),
  notes varchar(2000),
  version integer not null default 1 check (version >= 1),
  contentfingerprint varchar(64),
  reviewedby uuid references public.profiles(id) on delete set null,
  reviewedbynamesnapshot varchar(160),
  reviewedat timestamptz,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint ck_bookrightsevidences_scope_page check (
    (scope = 'BOOK' and pageid is null) or (scope = 'PAGE' and pageid is not null)
  )
);

create unique index if not exists uq_bookrightsevidences_book_scope
  on public.bookrightsevidences(bookid)
  where scope = 'BOOK' and pageid is null;

create unique index if not exists uq_bookrightsevidences_page_scope
  on public.bookrightsevidences(bookid, pageid)
  where scope = 'PAGE' and pageid is not null;

create index if not exists ix_bookrightsevidences_book_status
  on public.bookrightsevidences(bookid, status);

create table if not exists public.bookrightsevidencehistory (
  id uuid primary key default gen_random_uuid(),
  evidenceid uuid not null references public.bookrightsevidences(id) on delete cascade,
  bookid uuid not null references public.books(id) on delete cascade,
  pageid uuid references public.bookpages(id) on delete set null,
  scope varchar(8) not null check (scope in ('BOOK', 'PAGE')),
  version integer not null check (version >= 1),
  fromstatus varchar(32),
  tostatus varchar(32) not null
    check (tostatus in ('UNASSESSED', 'INSUFFICIENT_EVIDENCE', 'CONCERN_FLAGGED', 'RIGHTS_REVIEWED')),
  sourcedescription varchar(500),
  authororrightsholder varchar(300),
  usagebasis varchar(120),
  evidenceurlorref varchar(1000),
  notes varchar(2000),
  contentfingerprint varchar(64),
  actorid uuid references public.profiles(id) on delete set null,
  actornamesnapshot varchar(160),
  createdat timestamptz not null default now()
);

create index if not exists ix_bookrightsevidencehistory_book_created
  on public.bookrightsevidencehistory(bookid, createdat desc);

create index if not exists ix_bookrightsevidencehistory_evidence_version
  on public.bookrightsevidencehistory(evidenceid, version desc);

alter table public.bookrightsevidences enable row level security;
revoke all privileges on table public.bookrightsevidences from anon, authenticated;
grant all privileges on table public.bookrightsevidences to service_role;

alter table public.bookrightsevidencehistory enable row level security;
revoke all privileges on table public.bookrightsevidencehistory from anon, authenticated;
grant all privileges on table public.bookrightsevidencehistory to service_role;

-- 3. Expand Parent book content report issue types additively
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.bookcontentreports'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%issuetype%'
  loop
    execute format('alter table public.bookcontentreports drop constraint if exists %I', constraint_name);
  end loop;
  alter table public.bookcontentreports
    add constraint ck_bookcontentreports_issue_type
    check (issuetype in (
      'BOOK_METADATA_ERROR',
      'SPELLING_ERROR',
      'MISSING_CONTENT',
      'OCR_MISMATCH',
      'IMAGE_QUALITY_ERROR',
      'DUPLICATE_PAGE',
      'PAGE_ORDER_ERROR',
      'CHILD_SAFETY_CONCERN',
      'COPYRIGHT_CONCERN',
      'OTHER'
    ));
end $$;

-- 4. Additive metadata columns on books & bookpages used by quality/page-type checks
alter table public.books
  add column if not exists expectedpagecount integer;

alter table public.bookpages
  add column if not exists contenttype varchar(32) not null default 'CONTENT';

commit;
