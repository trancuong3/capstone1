begin;

create table if not exists public.difficult_word_practice_attempts (
  id uuid primary key default gen_random_uuid(),
  childid uuid not null references public.childprofiles(id) on delete cascade,
  parentid uuid not null references public.profiles(id) on delete cascade,
  normalizedword varchar(120) not null,
  displaytext varchar(120) not null,
  attemptnumber integer not null check (attemptnumber >= 1),
  requestid uuid not null,
  completionrequestid uuid,
  state varchar(16) not null default 'STARTED'
    check (state in ('STARTED', 'COMPLETED')),
  assessmentstatus varchar(24)
    check (
      assessmentstatus is null
      or assessmentstatus in ('CORRECT', 'INCORRECT', 'UNCERTAIN', 'NO_CLEAR_AUDIO', 'ENGINE_ERROR')
    ),
  recognitionsource varchar(32)
    check (
      recognitionsource is null
      or recognitionsource in ('SERVER_STT', 'SERVER_STT_KEYTERM', 'BROWSER_SPEECH', 'AUDIO_QUALITY_GATE', 'ENGINE_ERROR')
    ),
  spokentranscript varchar(160),
  confidence double precision
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  audiodurationms integer
    check (audiodurationms is null or audiodurationms >= 0),
  assessmentversion smallint not null default 1,
  evidencewordids jsonb not null default '[]'::jsonb,
  bookid uuid references public.books(id) on delete set null,
  sessionid uuid references public.readingsessions(id) on delete set null,
  pageid uuid references public.bookpages(id) on delete set null,
  pagerevisionid uuid references public.pagerevisions(id) on delete set null,
  wordid uuid references public.pagerevisionwords(id) on delete set null,
  startedat timestamptz not null default now(),
  completedat timestamptz,
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now(),
  constraint uq_difficult_word_practice_start_req unique (childid, normalizedword, requestid),
  constraint uq_difficult_word_practice_complete_req unique (childid, completionrequestid)
);

alter table public.difficult_word_practice_attempts
  add column if not exists bookid uuid references public.books(id) on delete set null,
  add column if not exists sessionid uuid references public.readingsessions(id) on delete set null,
  add column if not exists pageid uuid references public.bookpages(id) on delete set null,
  add column if not exists pagerevisionid uuid references public.pagerevisions(id) on delete set null,
  add column if not exists wordid uuid references public.pagerevisionwords(id) on delete set null;

create index if not exists ix_difficult_word_practice_child_word_created
  on public.difficult_word_practice_attempts (childid, normalizedword, createdat desc);

create index if not exists ix_difficult_word_practice_child_completed
  on public.difficult_word_practice_attempts (childid, completedat desc);

create index if not exists ix_difficult_word_practice_book_session
  on public.difficult_word_practice_attempts (bookid, sessionid)
  where bookid is not null or sessionid is not null;

alter table public.difficult_word_practice_attempts enable row level security;

revoke all privileges on table public.difficult_word_practice_attempts
  from anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'difficult_word_practice_attempts'
      and policyname = 'difficult_word_practice_parent_owns_child'
  ) then
    create policy difficult_word_practice_parent_owns_child
      on public.difficult_word_practice_attempts
      for all
      to authenticated
      using (
        parentid = (select auth.uid())
        and exists (
          select 1
          from public.childprofiles child
          where child.id = childid
            and child.parentid = (select auth.uid())
        )
      )
      with check (
        parentid = (select auth.uid())
        and exists (
          select 1
          from public.childprofiles child
          where child.id = childid
            and child.parentid = (select auth.uid())
        )
      );
  end if;
end
$$;

grant all privileges on table public.difficult_word_practice_attempts to service_role;

commit;
