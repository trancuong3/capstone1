-- ViRead AI Smart Book Studio V2 additive schema.
-- Strictly backward-compatible: adds 4 satellite tables with RLS; zero mutations on existing tables.
-- Never stores base64 images or raw child PII; isolates presentation assets from Flow 1 / Flow 2 OCR training.
begin;

create table if not exists public.book_presentation_assets (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  book_page_id uuid references public.bookpages(id) on delete cascade,
  source_revision_id uuid references public.pagerevisions(id) on delete set null,
  owner_id uuid references public.profiles(id) on delete set null,
  asset_role varchar(32) not null,
  source_type varchar(32) not null,
  storage_path text not null,
  mime_type varchar(32) not null default 'image/webp',
  width integer,
  height integer,
  size_bytes integer,
  asset_hash varchar(64) not null,
  asset_version integer not null default 1,
  is_active boolean not null default true,
  text_free_verified boolean not null default false,
  moderation_status varchar(24) not null default 'PENDING',
  provider_name varchar(64),
  model_id varchar(96),
  job_id uuid,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_book_presentation_assets_role check (
    asset_role in ('COVER', 'PAGE_ILLUSTRATION', 'THUMBNAIL')
  ),
  constraint ck_book_presentation_assets_source check (
    source_type in ('USER_UPLOAD', 'ORIGINAL_CROP', 'ENHANCED_CROP', 'AI_GENERATED', 'METADATA_RENDER')
  ),
  constraint ck_book_presentation_assets_moderation check (
    moderation_status in ('PENDING', 'APPROVED', 'REJECTED', 'STALE')
  ),
  constraint ck_book_presentation_assets_version check (asset_version >= 1),
  constraint ck_book_presentation_assets_dims check (
    (width is null or width > 0) and (height is null or height > 0) and (size_bytes is null or size_bytes >= 0)
  )
);

create index if not exists ix_book_presentation_assets_book_role_active
  on public.book_presentation_assets(book_id, asset_role, is_active);
create index if not exists ix_book_presentation_assets_page_role_active
  on public.book_presentation_assets(book_page_id, asset_role, is_active)
  where book_page_id is not null;
create index if not exists ix_book_presentation_assets_owner
  on public.book_presentation_assets(owner_id, created_at desc);

create table if not exists public.book_style_bibles (
  book_id uuid primary key references public.books(id) on delete cascade,
  owner_id uuid references public.profiles(id) on delete set null,
  context_hash varchar(64) not null,
  bible_json jsonb not null default '{}'::jsonb,
  provider_name varchar(64),
  model_id varchar(96),
  updated_at timestamptz not null default now()
);

create table if not exists public.page_ocr_extractions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  book_page_id uuid not null references public.bookpages(id) on delete cascade,
  page_revision_id uuid references public.pagerevisions(id) on delete set null,
  owner_id uuid references public.profiles(id) on delete set null,
  source_hash varchar(64) not null,
  algorithm_version varchar(32) not null default 'v2.0',
  filter_mode varchar(16) not null default 'active',
  page_kind varchar(32) not null default 'TEXT_AND_IMAGE',
  geometry_transform_json jsonb not null default '{}'::jsonb,
  blocks_json jsonb not null default '[]'::jsonb,
  canonical_text text not null default '',
  stats_json jsonb not null default '{}'::jsonb,
  requires_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_page_ocr_extractions_mode check (filter_mode in ('shadow', 'active')),
  constraint ck_page_ocr_extractions_kind check (
    page_kind in (
      'TEXT_ONLY',
      'TEXT_AND_IMAGE',
      'IMAGE_PRIMARY',
      'COMIC',
      'POEM',
      'EXERCISE',
      'MULTI_COLUMN',
      'TEXT_OVER_IMAGE',
      'LOW_QUALITY'
    )
  )
);

create index if not exists ix_page_ocr_extractions_page_updated
  on public.page_ocr_extractions(book_page_id, updated_at desc);
create index if not exists ix_page_ocr_extractions_book_updated
  on public.page_ocr_extractions(book_id, updated_at desc);

create table if not exists public.smart_studio_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type varchar(40) not null,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  actor_role varchar(16) not null,
  book_id uuid references public.books(id) on delete cascade,
  book_page_id uuid references public.bookpages(id) on delete cascade,
  source_revision_id uuid references public.pagerevisions(id) on delete set null,
  input_hash varchar(64) not null,
  idempotency_key varchar(128) not null,
  stage varchar(40) not null default 'QUEUED',
  status varchar(24) not null default 'QUEUED',
  priority smallint not null default 50,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  worker_id varchar(96),
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  progress_completed integer,
  progress_total integer,
  progress_unit varchar(24),
  checkpoints_json jsonb not null default '{}'::jsonb,
  result_ref_json jsonb not null default '{}'::jsonb,
  error_code varchar(64),
  error_message_vi text,
  retry_after_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint ck_smart_studio_jobs_type check (
    job_type in (
      'OCR_EXTRACT',
      'COVER_GENERATE',
      'ILLUSTRATION_EXTRACT',
      'ILLUSTRATION_GENERATE',
      'STYLE_BIBLE',
      'BATCH_BOOK_IMPORT'
    )
  ),
  constraint ck_smart_studio_jobs_role check (actor_role in ('admin', 'parent')),
  constraint ck_smart_studio_jobs_status check (
    status in (
      'QUEUED',
      'RUNNING',
      'WAITING_FOR_WORKER',
      'WAITING_FOR_QUOTA',
      'WAITING_FOR_REVIEW',
      'RETRY_SCHEDULED',
      'PARTIAL_SUCCESS',
      'SUCCEEDED',
      'FAILED',
      'CANCEL_REQUESTED',
      'CANCELLED',
      'STALE'
    )
  ),
  constraint ck_smart_studio_jobs_attempts check (attempt_count >= 0 and max_attempts >= 1),
  constraint ck_smart_studio_jobs_progress check (
    (progress_completed is null and progress_total is null) or
    (progress_completed is not null and progress_total is not null and progress_completed >= 0 and progress_total >= progress_completed)
  ),
  constraint uq_smart_studio_jobs_actor_idem unique (actor_id, idempotency_key)
);

create index if not exists ix_smart_studio_jobs_actor_updated
  on public.smart_studio_jobs(actor_id, updated_at desc);
create index if not exists ix_smart_studio_jobs_status_priority
  on public.smart_studio_jobs(status, priority desc, created_at asc);
create index if not exists ix_smart_studio_jobs_lease
  on public.smart_studio_jobs(status, lease_expires_at)
  where status = 'RUNNING';

-- Enable Row-Level Security on all 4 new satellite tables.
alter table public.book_presentation_assets enable row level security;
alter table public.book_style_bibles enable row level security;
alter table public.page_ocr_extractions enable row level security;
alter table public.smart_studio_jobs enable row level security;

revoke all on table
  public.book_presentation_assets,
  public.book_style_bibles,
  public.page_ocr_extractions,
  public.smart_studio_jobs
from anon;

grant select on table
  public.book_presentation_assets,
  public.book_style_bibles,
  public.page_ocr_extractions,
  public.smart_studio_jobs
to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'book_presentation_assets'
      and policyname = 'book_presentation_assets_owner_or_catalog_reads'
  ) then
    create policy book_presentation_assets_owner_or_catalog_reads
      on public.book_presentation_assets for select to authenticated
      using (
        owner_id = (select auth.uid())
        or (
          owner_id is null
          and is_active = true
          and moderation_status = 'APPROVED'
          and exists (
            select 1
            from public.books b
            where b.id = book_presentation_assets.book_id
              and b.visibility_scope = 'CATALOG'
              and b.lifecyclestatus = 'ACTIVE'
              and coalesce(b.is_deleted, false) = false
          )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'book_style_bibles'
      and policyname = 'book_style_bibles_owner_reads'
  ) then
    create policy book_style_bibles_owner_reads
      on public.book_style_bibles for select to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'page_ocr_extractions'
      and policyname = 'page_ocr_extractions_owner_reads'
  ) then
    create policy page_ocr_extractions_owner_reads
      on public.page_ocr_extractions for select to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'smart_studio_jobs'
      and policyname = 'smart_studio_jobs_actor_reads'
  ) then
    create policy smart_studio_jobs_actor_reads
      on public.smart_studio_jobs for select to authenticated
      using (actor_id = (select auth.uid()));
  end if;
end
$$;

commit;
