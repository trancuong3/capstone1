begin;

create table if not exists public.gamesessions (
  id uuid primary key default gen_random_uuid(),
  childprofileid uuid not null references public.childprofiles(id) on delete cascade,
  bookid uuid not null references public.books(id) on delete restrict,
  difficulty varchar(16) not null check (difficulty in ('easy', 'medium', 'challenge')),
  totalrounds smallint not null check (totalrounds between 1 and 5),
  completedrounds smallint not null default 0 check (completedrounds >= 0),
  correctcount integer not null default 0 check (correctcount >= 0),
  mistakecount integer not null default 0 check (mistakecount >= 0),
  hintcount integer not null default 0 check (hintcount >= 0),
  totalstars smallint not null default 0 check (totalstars >= 0),
  status varchar(16) not null default 'IN_PROGRESS'
    check (status in ('IN_PROGRESS', 'COMPLETED', 'ABANDONED')),
  startedat timestamptz not null default now(),
  completedat timestamptz,
  createdat timestamptz not null default now()
);

create index if not exists ix_gamesessions_child_started
  on public.gamesessions(childprofileid, startedat desc);
create index if not exists ix_gamesessions_book_status
  on public.gamesessions(bookid, status);

create table if not exists public.gamerounds (
  id uuid primary key default gen_random_uuid(),
  gamesessionid uuid not null references public.gamesessions(id) on delete cascade,
  roundnumber smallint not null check (roundnumber between 1 and 5),
  bookpageid uuid references public.bookpages(id) on delete set null,
  pagerevisionid uuid references public.pagerevisions(id) on delete set null,
  sentencesnapshot text not null,
  tokenssnapshot jsonb not null,
  expectedtokenids jsonb not null,
  shuffledtokenids jsonb not null,
  nextexpectedposition smallint not null default 0 check (nextexpectedposition >= 0),
  correctcount smallint not null default 0 check (correctcount >= 0),
  mistakecount smallint not null default 0 check (mistakecount >= 0),
  hintcount smallint not null default 0 check (hintcount >= 0),
  stars smallint not null default 0 check (stars between 0 and 3),
  status varchar(16) not null default 'IN_PROGRESS'
    check (status in ('IN_PROGRESS', 'COMPLETED')),
  completedat timestamptz,
  createdat timestamptz not null default now(),
  constraint uq_gamerounds_session_number unique (gamesessionid, roundnumber)
);

create index if not exists ix_gamerounds_session_status
  on public.gamerounds(gamesessionid, status, roundnumber);

create table if not exists public.gameattempts (
  id uuid primary key default gen_random_uuid(),
  gamesessionid uuid not null references public.gamesessions(id) on delete cascade,
  gameroundid uuid not null references public.gamerounds(id) on delete cascade,
  requestid uuid not null,
  tokenid uuid not null,
  iscorrect boolean not null,
  resultsnapshot jsonb not null,
  createdat timestamptz not null default now(),
  constraint uq_gameattempts_session_request unique (gamesessionid, requestid)
);

create index if not exists ix_gameattempts_round_created
  on public.gameattempts(gameroundid, createdat);

alter table public.gamesessions enable row level security;
alter table public.gamerounds enable row level security;
alter table public.gameattempts enable row level security;
revoke all privileges on table public.gamesessions, public.gamerounds, public.gameattempts
  from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'gamesessions'
      and policyname = 'gamesessions_parent_owns_child'
  ) then
    create policy gamesessions_parent_owns_child on public.gamesessions
      for all to authenticated
      using (
        exists (
          select 1 from public.childprofiles child
          where child.id = childprofileid and child.parentid = (select auth.uid())
        )
      )
      with check (
        exists (
          select 1 from public.childprofiles child
          where child.id = childprofileid and child.parentid = (select auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'gamerounds'
      and policyname = 'gamerounds_parent_owns_session'
  ) then
    create policy gamerounds_parent_owns_session on public.gamerounds
      for all to authenticated
      using (
        exists (
          select 1
          from public.gamesessions game_session
          join public.childprofiles child on child.id = game_session.childprofileid
          where game_session.id = gamesessionid and child.parentid = (select auth.uid())
        )
      )
      with check (
        exists (
          select 1
          from public.gamesessions game_session
          join public.childprofiles child on child.id = game_session.childprofileid
          where game_session.id = gamesessionid and child.parentid = (select auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'gameattempts'
      and policyname = 'gameattempts_parent_owns_session'
  ) then
    create policy gameattempts_parent_owns_session on public.gameattempts
      for all to authenticated
      using (
        exists (
          select 1
          from public.gamesessions game_session
          join public.childprofiles child on child.id = game_session.childprofileid
          where game_session.id = gamesessionid and child.parentid = (select auth.uid())
        )
      )
      with check (
        exists (
          select 1
          from public.gamesessions game_session
          join public.childprofiles child on child.id = game_session.childprofileid
          where game_session.id = gamesessionid and child.parentid = (select auth.uid())
        )
      );
  end if;
end
$$;

grant all privileges on table public.gamesessions, public.gamerounds, public.gameattempts to service_role;

commit;
