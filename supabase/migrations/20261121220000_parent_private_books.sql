-- Parent Private Books ("Sách của tôi"):
-- 1. Explicit ownership & visibility separation on public.books (preserving all existing catalog books).
-- 2. Durable staged page-submission pipeline (OCR -> Proofreading -> Tool Check -> Ready/Admin Review).
-- 3. Dedicated Admin moderation queue ("Sách người dùng") separate from catalog content reports.
-- 4. Defense-in-depth PostgreSQL RLS and private Storage bucket isolation.

begin;

-- ---------------------------------------------------------------------------
-- 1. public.books: explicit visibility_scope, owner_parent_id, moderation_status
-- ---------------------------------------------------------------------------
alter table public.books
  add column if not exists visibility_scope text not null default 'CATALOG',
  add column if not exists owner_parent_id uuid references public.profiles(id) on delete restrict,
  add column if not exists moderation_status text not null default 'ACTIVE',
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_by uuid references public.profiles(id) on delete set null,
  add column if not exists suspended_reason text,
  add column if not exists source_declaration text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.books'::regclass
      and conname = 'books_visibility_scope_check'
  ) then
    alter table public.books
      add constraint books_visibility_scope_check
      check (visibility_scope in ('CATALOG', 'PARENT_PRIVATE'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.books'::regclass
      and conname = 'books_moderation_status_check'
  ) then
    alter table public.books
      add constraint books_moderation_status_check
      check (moderation_status in ('ACTIVE', 'SUSPENDED'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.books'::regclass
      and conname = 'books_visibility_owner_consistency_check'
  ) then
    alter table public.books
      add constraint books_visibility_owner_consistency_check
      check (
        (visibility_scope = 'CATALOG' and owner_parent_id is null)
        or (visibility_scope = 'PARENT_PRIVATE' and owner_parent_id is not null)
      );
  end if;
end
$$;

create or replace function public.prevent_private_book_catalog_promotion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.visibility_scope = 'PARENT_PRIVATE' then
    if new.visibility_scope <> 'PARENT_PRIVATE' then
      raise exception 'PARENT_PRIVATE books cannot be promoted to CATALOG';
    end if;
    if new.owner_parent_id is distinct from old.owner_parent_id then
      raise exception 'PARENT_PRIVATE book owner_parent_id is immutable';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_private_book_catalog_promotion() from public, anon, authenticated;

drop trigger if exists trg_prevent_private_book_catalog_promotion on public.books;
create trigger trg_prevent_private_book_catalog_promotion
  before update on public.books
  for each row
  execute function public.prevent_private_book_catalog_promotion();

create index if not exists ix_books_visibility_owner_created
  on public.books (visibility_scope, owner_parent_id, createdat desc);

create index if not exists ix_books_visibility_moderation
  on public.books (visibility_scope, moderation_status, createdat desc);

-- ---------------------------------------------------------------------------
-- 2. public.parent_book_page_submissions
-- ---------------------------------------------------------------------------
create table if not exists public.parent_book_page_submissions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  owner_parent_id uuid not null references public.profiles(id) on delete restrict,
  batch_id uuid not null,
  batch_total_pages integer not null default 1 check (batch_total_pages >= 1 and batch_total_pages <= 30),
  source_page_number integer not null default 1 check (source_page_number >= 1),
  target_page_number integer check (target_page_number is null or (target_page_number >= 1 and target_page_number <= 32767)),
  idempotency_key varchar(128) not null,
  source_file_name text not null,
  source_format varchar(24) not null,
  source_storage_path text not null,
  source_sha256 varchar(64) not null,
  image_width integer not null check (image_width > 0),
  image_height integer not null check (image_height > 0),
  source_type varchar(40) not null default 'OWNED_PHYSICAL_BOOK',
  source_note text,
  submission_version integer not null default 1 check (submission_version >= 1),
  optimistic_lock_version integer not null default 1 check (optimistic_lock_version >= 1),
  workflow_status varchar(40) not null default 'CHECKING',

  -- Stage 1: OCR
  ocr_status varchar(32) not null default 'PENDING',
  ocr_text text,
  ocr_words_json jsonb not null default '[]'::jsonb,
  ocr_meta_json jsonb not null default '{}'::jsonb,
  ocr_hash varchar(64),
  ocr_error_code varchar(80),
  is_image_only boolean not null default false,

  -- Stage 2: Spelling / OCR Proofreading against source image
  proofread_status varchar(32) not null default 'PENDING',
  proofread_text text,
  proofread_hash varchar(64),
  proofread_suggestions_json jsonb not null default '[]'::jsonb,
  uncertain_word_indices_json jsonb not null default '[]'::jsonb,
  proofread_provider_events_json jsonb not null default '[]'::jsonb,
  proofread_error_code varchar(80),
  spelling_accepted_at timestamptz,

  -- Candidate text snapshot (exact text verified by Tool Check / Admin / Add Page)
  candidate_text text,
  candidate_hash varchar(64),
  candidate_words_json jsonb not null default '[]'::jsonb,

  -- Stage 3: Tool Check (deterministic rules + child safety + rights basis)
  tool_check_status varchar(32) not null default 'PENDING',
  tool_check_input_hash varchar(64),
  tool_check_suitability varchar(32),
  tool_check_scope_json jsonb not null default '{}'::jsonb,
  tool_check_findings_json jsonb not null default '[]'::jsonb,
  tool_check_provider_events_json jsonb not null default '[]'::jsonb,
  tool_check_error_code varchar(80),
  tool_check_policy_blocked boolean not null default false,
  tool_check_workflow_id uuid,
  tool_check_completed_at timestamptz,

  -- Admin approval snapshot binding
  approved_snapshot_hash varchar(64),
  approved_submission_version integer,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  admin_decision varchar(32),
  admin_decision_reason text,

  -- Committed page link
  committed_page_id uuid references public.bookpages(id) on delete set null,
  committed_revision_id uuid references public.pagerevisions(id) on delete set null,
  committed_at timestamptz,

  -- Worker lease & temporary object TTL
  worker_id varchar(120),
  lease_expires_at timestamptz,
  retry_after timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  temp_expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint uq_parent_book_sub_idempotency unique (owner_parent_id, book_id, idempotency_key, source_page_number),
  constraint ck_parent_book_sub_source_type check (
    source_type in ('SELF_AUTHORED', 'OWNED_PHYSICAL_BOOK', 'PUBLIC_DOMAIN', 'LICENSED_OR_PERMISSION', 'OTHER')
  ),
  constraint ck_parent_book_sub_workflow_status check (
    workflow_status in (
      'CHECKING', 'PASSED_READY_TO_ADD', 'NEEDS_ADMIN_REVIEW', 'CHECK_FAILED',
      'PENDING_ADMIN', 'APPROVED_READY_TO_ADD', 'REJECTED', 'NEEDS_RECHECK',
      'ADDED_TO_BOOK', 'CANCELLED'
    )
  ),
  constraint ck_parent_book_sub_ocr_status check (
    ocr_status in ('PENDING', 'RUNNING', 'COMPLETED', 'NO_TEXT_DETECTED', 'FAILED')
  ),
  constraint ck_parent_book_sub_proofread_status check (
    proofread_status in ('PENDING', 'RUNNING', 'COMPLETED', 'SKIPPED', 'FAILED')
  ),
  constraint ck_parent_book_sub_tool_check_status check (
    tool_check_status in ('PENDING', 'RUNNING', 'PASSED', 'FLAGGED', 'NEEDS_MANUAL_REVIEW', 'FAILED')
  ),
  constraint ck_parent_book_sub_suitability check (
    tool_check_suitability is null
    or tool_check_suitability in ('SUITABLE', 'SUITABLE_WITH_GUIDANCE', 'REVIEW_REQUIRED', 'NOT_RECOMMENDED')
  ),
  constraint ck_parent_book_sub_admin_decision check (
    admin_decision is null
    or admin_decision in ('APPROVE', 'REQUEST_CHANGES', 'REJECT', 'SUSPEND')
  )
);

create index if not exists ix_parent_book_sub_book_created
  on public.parent_book_page_submissions (book_id, created_at desc);

create index if not exists ix_parent_book_sub_owner_status
  on public.parent_book_page_submissions (owner_parent_id, workflow_status, created_at desc);

create index if not exists ix_parent_book_sub_queue
  on public.parent_book_page_submissions (workflow_status, retry_after, lease_expires_at, created_at)
  where workflow_status = 'CHECKING';

create index if not exists ix_parent_book_sub_temp_ttl
  on public.parent_book_page_submissions (temp_expires_at)
  where committed_page_id is null and workflow_status not in ('PENDING_ADMIN', 'ADDED_TO_BOOK');

create index if not exists ix_parent_book_sub_batch
  on public.parent_book_page_submissions (book_id, batch_id, source_page_number);

-- ---------------------------------------------------------------------------
-- 3. public.parent_book_moderation_requests
-- ---------------------------------------------------------------------------
create table if not exists public.parent_book_moderation_requests (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  submission_id uuid not null references public.parent_book_page_submissions(id) on delete cascade,
  owner_parent_id uuid not null references public.profiles(id) on delete restrict,
  submission_version integer not null check (submission_version >= 1),
  snapshot_hash varchar(64) not null,
  source_sha256 varchar(64) not null,
  source_storage_path text not null,
  ocr_text_snapshot text,
  proofread_text_snapshot text,
  candidate_text_snapshot text,
  tool_check_snapshot_json jsonb not null default '{}'::jsonb,
  parent_source_type varchar(40) not null,
  parent_source_note text,
  parent_request_note text,
  status varchar(32) not null default 'PENDING_ADMIN',
  policy_blocked boolean not null default false,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decision_reason text,
  previous_status varchar(32),
  optimistic_lock_version integer not null default 1 check (optimistic_lock_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ck_parent_book_mod_req_status check (
    status in ('PENDING_ADMIN', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'SUSPENDED', 'SUPERSEDED')
  )
);

create unique index if not exists uq_parent_book_mod_req_open
  on public.parent_book_moderation_requests (submission_id)
  where status = 'PENDING_ADMIN';

create index if not exists ix_parent_book_mod_req_status_created
  on public.parent_book_moderation_requests (status, created_at desc);

create index if not exists ix_parent_book_mod_req_book_created
  on public.parent_book_moderation_requests (book_id, created_at desc);

create index if not exists ix_parent_book_mod_req_submission_created
  on public.parent_book_moderation_requests (submission_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Row-Level Security (RLS) on new & existing book tables
-- ---------------------------------------------------------------------------
alter table public.parent_book_page_submissions enable row level security;
alter table public.parent_book_moderation_requests enable row level security;

revoke all privileges on table public.parent_book_page_submissions from public, anon, authenticated;
revoke all privileges on table public.parent_book_moderation_requests from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all privileges on table public.parent_book_page_submissions to service_role';
    execute 'grant all privileges on table public.parent_book_moderation_requests to service_role';

    execute 'drop policy if exists parent_book_submissions_server_only on public.parent_book_page_submissions';
    execute 'create policy parent_book_submissions_server_only on public.parent_book_page_submissions for all to service_role using (true) with check (true)';

    execute 'drop policy if exists parent_book_moderation_requests_server_only on public.parent_book_moderation_requests';
    execute 'create policy parent_book_moderation_requests_server_only on public.parent_book_moderation_requests for all to service_role using (true) with check (true)';
  end if;
end
$$;

-- Restrictive RLS policies on public.books, public.bookpages, public.pagerevisions,
-- and public.pagerevisionwords so direct Supabase DB reads by anon or authenticated
-- clients can NEVER see another family's private books or suspended private books.
-- AS RESTRICTIVE never loosens existing server-only tables and always restricts
-- any permissive client policy if present.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated')
     and to_regprocedure('auth.uid()') is not null then

    execute 'alter table public.books enable row level security';
    execute 'alter table public.bookpages enable row level security';
    execute 'alter table public.pagerevisions enable row level security';
    execute 'alter table public.pagerevisionwords enable row level security';

    -- books
    execute 'drop policy if exists books_anon_catalog_only_restrictive on public.books';
    execute $p$
      create policy books_anon_catalog_only_restrictive
        on public.books as restrictive
        for all to anon
        using (visibility_scope = 'CATALOG')
        with check (false)
    $p$;

    execute 'drop policy if exists books_authenticated_private_isolation_restrictive on public.books';
    execute $p$
      create policy books_authenticated_private_isolation_restrictive
        on public.books as restrictive
        for all to authenticated
        using (
          visibility_scope = 'CATALOG'
          or (
            visibility_scope = 'PARENT_PRIVATE'
            and owner_parent_id = (select auth.uid())
            and moderation_status = 'ACTIVE'
          )
        )
        with check (
          visibility_scope = 'PARENT_PRIVATE'
          and owner_parent_id = (select auth.uid())
        )
    $p$;

    -- bookpages
    execute 'drop policy if exists bookpages_anon_catalog_only_restrictive on public.bookpages';
    execute $p$
      create policy bookpages_anon_catalog_only_restrictive
        on public.bookpages as restrictive
        for all to anon
        using (
          exists (
            select 1 from public.books b
            where b.id = bookpages.bookid
              and b.visibility_scope = 'CATALOG'
          )
        )
        with check (false)
    $p$;

    execute 'drop policy if exists bookpages_authenticated_private_isolation_restrictive on public.bookpages';
    execute $p$
      create policy bookpages_authenticated_private_isolation_restrictive
        on public.bookpages as restrictive
        for all to authenticated
        using (
          exists (
            select 1 from public.books b
            where b.id = bookpages.bookid
              and (
                b.visibility_scope = 'CATALOG'
                or (
                  b.visibility_scope = 'PARENT_PRIVATE'
                  and b.owner_parent_id = (select auth.uid())
                  and b.moderation_status = 'ACTIVE'
                )
              )
          )
        )
        with check (false)
    $p$;

    -- pagerevisions
    execute 'drop policy if exists pagerevisions_anon_catalog_only_restrictive on public.pagerevisions';
    execute $p$
      create policy pagerevisions_anon_catalog_only_restrictive
        on public.pagerevisions as restrictive
        for all to anon
        using (
          exists (
            select 1 from public.bookpages p
            join public.books b on b.id = p.bookid
            where p.id = pagerevisions.pageid
              and b.visibility_scope = 'CATALOG'
          )
        )
        with check (false)
    $p$;

    execute 'drop policy if exists pagerevisions_authenticated_private_isolation_restrictive on public.pagerevisions';
    execute $p$
      create policy pagerevisions_authenticated_private_isolation_restrictive
        on public.pagerevisions as restrictive
        for all to authenticated
        using (
          exists (
            select 1 from public.bookpages p
            join public.books b on b.id = p.bookid
            where p.id = pagerevisions.pageid
              and (
                b.visibility_scope = 'CATALOG'
                or (
                  b.visibility_scope = 'PARENT_PRIVATE'
                  and b.owner_parent_id = (select auth.uid())
                  and b.moderation_status = 'ACTIVE'
                )
              )
          )
        )
        with check (false)
    $p$;

    -- pagerevisionwords
    execute 'drop policy if exists pagerevisionwords_anon_catalog_only_restrictive on public.pagerevisionwords';
    execute $p$
      create policy pagerevisionwords_anon_catalog_only_restrictive
        on public.pagerevisionwords as restrictive
        for all to anon
        using (
          exists (
            select 1 from public.pagerevisions r
            join public.bookpages p on p.id = r.pageid
            join public.books b on b.id = p.bookid
            where r.id = pagerevisionwords.pagerevisionid
              and b.visibility_scope = 'CATALOG'
          )
        )
        with check (false)
    $p$;

    execute 'drop policy if exists pagerevisionwords_authenticated_private_isolation_restrictive on public.pagerevisionwords';
    execute $p$
      create policy pagerevisionwords_authenticated_private_isolation_restrictive
        on public.pagerevisionwords as restrictive
        for all to authenticated
        using (
          exists (
            select 1 from public.pagerevisions r
            join public.bookpages p on p.id = r.pageid
            join public.books b on b.id = p.bookid
            where r.id = pagerevisionwords.pagerevisionid
              and (
                b.visibility_scope = 'CATALOG'
                or (
                  b.visibility_scope = 'PARENT_PRIVATE'
                  and b.owner_parent_id = (select auth.uid())
                  and b.moderation_status = 'ACTIVE'
                )
              )
          )
        )
        with check (false)
    $p$;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Private Storage bucket & browser-denial policy (served ONLY via FastAPI)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null
     and to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'viread-private-books',
      'viread-private-books',
      false,
      52428800,
      array[
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/bmp',
        'image/tiff',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ]::text[]
    )
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'drop policy if exists parent_private_books_objects_server_only on storage.objects';
      execute $p$
        create policy parent_private_books_objects_server_only
          on storage.objects
          for all to service_role
          using (bucket_id = 'viread-private-books')
          with check (bucket_id = 'viread-private-books')
      $p$;
    end if;

    if exists (select 1 from pg_roles where rolname = 'anon')
       and exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'drop policy if exists parent_private_books_objects_browser_denied on storage.objects';
      execute $p$
        create policy parent_private_books_objects_browser_denied
          on storage.objects as restrictive
          for all to anon, authenticated
          using (
            bucket_id <> 'viread-private-books'
            and name not like 'private-books/%'
          )
          with check (
            bucket_id <> 'viread-private-books'
            and name not like 'private-books/%'
          )
      $p$;
    end if;
  end if;
end
$$;

commit;
