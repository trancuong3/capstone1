begin;

create table if not exists public.picturedescriptionsessions (
  id uuid primary key default gen_random_uuid(),
  childprofileid uuid not null references public.childprofiles(id) on delete cascade,
  parentid uuid not null references public.profiles(id) on delete cascade,
  bookid uuid references public.books(id) on delete set null,
  bookpageid uuid references public.bookpages(id) on delete set null,
  sourcetype varchar(24) not null
    check (sourcetype in ('BOOK_PAGE', 'CUSTOM_UPLOAD', 'SAMPLE')),
  samplekey varchar(64),
  imagepath text not null,
  imagemimetype varchar(32) not null default 'image/png',
  childgrade smallint not null check (childgrade between 1 and 5),
  scenetitle varchar(200) not null,
  promptpayload jsonb not null,
  status varchar(16) not null default 'ACTIVE'
    check (status in ('ACTIVE', 'COMPLETED')),
  beststars smallint not null default 0 check (beststars between 0 and 3),
  bestscore smallint not null default 0 check (bestscore between 0 and 10),
  attemptscount integer not null default 0 check (attemptscount >= 0),
  aimodelused varchar(64),
  createdat timestamptz not null default now(),
  updatedat timestamptz not null default now()
);

create index if not exists ix_picturedescriptionsessions_child_created
  on public.picturedescriptionsessions(childprofileid, createdat desc);
create index if not exists ix_picturedescriptionsessions_parent_created
  on public.picturedescriptionsessions(parentid, createdat desc);

create table if not exists public.picturedescriptionattempts (
  id uuid primary key default gen_random_uuid(),
  sessionid uuid not null references public.picturedescriptionsessions(id) on delete cascade,
  attemptnumber integer not null check (attemptnumber >= 1),
  inputmode varchar(16) not null check (inputmode in ('VOICE', 'TEXT')),
  transcripttext text not null,
  scoreoutof10 smallint not null check (scoreoutof10 between 0 and 10),
  stars smallint not null check (stars between 0 and 3),
  feedbackpayload jsonb not null,
  aimodelused varchar(64),
  createdat timestamptz not null default now(),
  constraint uq_picturedescriptionattempts_session_number unique (sessionid, attemptnumber)
);

create index if not exists ix_picturedescriptionattempts_session_created
  on public.picturedescriptionattempts(sessionid, createdat desc);

alter table public.picturedescriptionsessions enable row level security;
alter table public.picturedescriptionattempts enable row level security;
revoke all privileges on table public.picturedescriptionsessions, public.picturedescriptionattempts
  from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'picturedescriptionsessions'
      and policyname = 'picturedescriptionsessions_parent_owns_child'
  ) then
    create policy picturedescriptionsessions_parent_owns_child on public.picturedescriptionsessions
      for all to authenticated
      using (
        parentid = (select auth.uid())
        and exists (
          select 1 from public.childprofiles child
          where child.id = childprofileid and child.parentid = (select auth.uid())
        )
      )
      with check (
        parentid = (select auth.uid())
        and exists (
          select 1 from public.childprofiles child
          where child.id = childprofileid and child.parentid = (select auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'picturedescriptionattempts'
      and policyname = 'picturedescriptionattempts_parent_owns_session'
  ) then
    create policy picturedescriptionattempts_parent_owns_session on public.picturedescriptionattempts
      for all to authenticated
      using (
        exists (
          select 1
          from public.picturedescriptionsessions s
          join public.childprofiles child on child.id = s.childprofileid
          where s.id = sessionid
            and s.parentid = (select auth.uid())
            and child.parentid = (select auth.uid())
        )
      )
      with check (
        exists (
          select 1
          from public.picturedescriptionsessions s
          join public.childprofiles child on child.id = s.childprofileid
          where s.id = sessionid
            and s.parentid = (select auth.uid())
            and child.parentid = (select auth.uid())
        )
      );
  end if;
end
$$;

grant all privileges on table public.picturedescriptionsessions, public.picturedescriptionattempts to service_role;

commit;
