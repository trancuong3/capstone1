-- Additive migration for Admin AI verification gate, Content Usage Rights profiles,
-- image safety manual review tracking, missing-page diagnostics, and new Parent report issue types.
-- Preserves all existing books, pages, revisions, workflows, decisions, and parent reports.
begin;

-- 1. Optional source page count on books for honest missing-page diagnostics.
alter table public.books
  add column if not exists expectedpagecount integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_books_expected_page_count'
  ) then
    alter table public.books
      add constraint ck_books_expected_page_count
      check (expectedpagecount is null or expectedpagecount > 0);
  end if;
end $$;

-- 2. Distinguish regular text pages from cover / image-only pages.
alter table public.bookpages
  add column if not exists contenttype varchar(32) not null default 'CONTENT';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_bookpages_content_type'
  ) then
    alter table public.bookpages
      add constraint ck_bookpages_content_type
      check (contenttype in ('CONTENT', 'COVER_OR_IMAGE_ONLY'));
  end if;
end $$;

-- 3. Persistent Content Usage Rights profiles (book-level scope + optional page overrides).
create table if not exists public.bookcontentrightsprofiles (
  id uuid primary key default gen_random_uuid(),
  bookid uuid not null references public.books(id) on delete cascade,
  pageid uuid references public.bookpages(id) on delete cascade,
  scope varchar(20) not null check (scope in ('BOOK', 'PAGE_OVERRIDE')),
  status varchar(32) not null default 'NOT_ASSESSED' check (
    status in ('NOT_ASSESSED', 'MISSING_EVIDENCE', 'CONCERNS_FOUND', 'REVIEWED')
  ),
  sourcename varchar(300),
  rightsholder varchar(300),
  usagebasis varchar(80),
  evidenceurl varchar(1000),
  evidencereference varchar(500),
  notes varchar(2000),
  sourcefingerprint varchar(64),
  profileversion integer not null default 1 check (profileversion >= 1),
  referencecheckstatus varchar(32) not null default 'NOT_RUN' check (
    referencecheckstatus in ('NOT_RUN', 'NO_MATCH_IN_ALLOWED_CORPUS', 'OVERLAP_CONCERN')
  ),
  referencecheckevidence jsonb not null default '[]'::jsonb,
  reviewedby uuid references public.profiles(id) on delete set null,
  reviewedbynamesnapshot varchar(160),
  reviewedat timestamptz,
  history jsonb not null default '[]'::jsonb,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint ck_bookcontentrightsprofiles_scope_page check (
    (scope = 'BOOK' and pageid is null) or (scope = 'PAGE_OVERRIDE' and pageid is not null)
  )
);

create unique index if not exists uq_bookcontentrightsprofiles_book
  on public.bookcontentrightsprofiles(bookid)
  where pageid is null;

create unique index if not exists uq_bookcontentrightsprofiles_page
  on public.bookcontentrightsprofiles(bookid, pageid)
  where pageid is not null;

create index if not exists ix_bookcontentrightsprofiles_book_status
  on public.bookcontentrightsprofiles(bookid, status);

alter table public.bookcontentrightsprofiles enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all privileges on table public.bookcontentrightsprofiles from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all privileges on table public.bookcontentrightsprofiles from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all privileges on table public.bookcontentrightsprofiles to service_role;
  end if;
end $$;

-- 4. Bind durable AI workflows to image hash, manual image safety review, and rights profile version.
alter table public.adminaiworkflows
  add column if not exists imagehash varchar(64),
  add column if not exists imagesafetystatus varchar(32) not null default 'NOT_REVIEWED',
  add column if not exists imagesafetyreviewedby uuid references public.profiles(id) on delete set null,
  add column if not exists imagesafetyreviewedat timestamptz,
  add column if not exists imagesafetyreviewnote varchar(1000),
  add column if not exists rightsprofileid uuid references public.bookcontentrightsprofiles(id) on delete set null,
  add column if not exists rightsprofileversion integer,
  add column if not exists rightsprofilehash varchar(64);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_adminaiworkflows_image_safety_status'
  ) then
    alter table public.adminaiworkflows
      add constraint ck_adminaiworkflows_image_safety_status
      check (imagesafetystatus in ('NOT_REVIEWED', 'MANUAL_REVIEWED_SAFE', 'MANUAL_REVIEWED_CONCERN'));
  end if;
end $$;

-- 5. Expand Parent report issue types with CHILD_UNSAFE_CONTENT and COPYRIGHT_CONCERN
-- while keeping all 8 legacy issue types valid.
do $$
declare
  constraint_rec record;
begin
  for constraint_rec in
    select conname
    from pg_constraint
    where conrelid = 'public.bookcontentreports'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%issuetype%'
  loop
    execute format('alter table public.bookcontentreports drop constraint if exists %I', constraint_rec.conname);
  end loop;
end $$;

alter table public.bookcontentreports
  add constraint ck_bookcontentreports_issue_type check (
    issuetype in (
      'BOOK_METADATA_ERROR',
      'SPELLING_ERROR',
      'MISSING_CONTENT',
      'OCR_MISMATCH',
      'IMAGE_QUALITY_ERROR',
      'DUPLICATE_PAGE',
      'PAGE_ORDER_ERROR',
      'CHILD_UNSAFE_CONTENT',
      'COPYRIGHT_CONCERN',
      'OTHER'
    )
  );

commit;
