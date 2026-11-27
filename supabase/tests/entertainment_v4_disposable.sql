-- Disposable PostgreSQL integration test for ViRead Entertainment V4.0 migration.
-- DO NOT run against Supabase production. It requires the dedicated disposable CI
-- database name; the ephemeral PG16 cluster is discarded after running.
-- psql -X -v ON_ERROR_STOP=1 -d viread_entertainment_v4_ci -f supabase/tests/entertainment_v4_disposable.sql

\set ON_ERROR_STOP on

do $guard$
begin
  if current_database() <> 'viread_entertainment_v4_ci' then
    raise exception 'Refusing non-disposable database: %', current_database();
  end if;
end;
$guard$;

-- Define minimal Supabase roles & auth stubs (idempotent across cluster runs).
do $roles$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
        create role supabase_auth_admin nologin;
    end if;
end
$roles$;

create schema auth;
grant usage on schema auth to authenticated, service_role, supabase_auth_admin;

create or replace function auth.uid() returns uuid
language sql stable
as $auth_uid$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$auth_uid$;
grant execute on function auth.uid() to authenticated;

-- Event trigger matching production Supabase RLS auto-enable behavior.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $rls$
declare cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
    end if;
  end loop;
end;
$rls$;

create event trigger ensure_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.rls_auto_enable();

-- Minimal prerequisite public tables referenced by V4 FKs and RLS policies.
create table public.profiles (
  id uuid primary key,
  role text not null default 'parent',
  displayname text,
  active smallint not null default 1,
  createdat timestamptz not null default now()
);

create table public.childprofiles (
  id uuid primary key,
  parentid uuid not null references public.profiles(id) on delete cascade,
  alias text not null,
  grade smallint not null default 2,
  createdat timestamptz not null default now()
);

create table public.karaoke_songs (
  id uuid primary key default gen_random_uuid(),
  status varchar(16) not null default 'DRAFT',
  published_version_id uuid,
  revision integer not null default 1,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.karaoke_song_versions (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.karaoke_songs(id) on delete restrict,
  version_no integer not null,
  state varchar(16) not null default 'DRAFT',
  title varchar(200) not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;

-- 1. Execute exact proposed migration TWICE to verify idempotency.
\ir ../migrations/20261127000000_entertainment_v4_ecosystem.sql
\ir ../migrations/20261127000000_entertainment_v4_ecosystem.sql

-- 2. Verify all 5 tables, RLS flags, and hot FK indexes exist.
do $schema_and_indexes$
declare
  tbl text;
  idx text;
begin
  foreach tbl in array array[
    'learning_skill_evidence',
    'memory_game_sessions',
    'memory_game_attempts',
    'karaoke_practice_sessions',
    'karaoke_musical_profiles'
  ]
  loop
    if to_regclass('public.' || tbl) is null then
      raise exception 'Missing V4 table: %', tbl;
    end if;
    if not exists (
      select 1 from pg_class c
      where c.oid = ('public.' || tbl)::regclass and c.relrowsecurity
    ) then
      raise exception 'RLS not enabled on V4 table: %', tbl;
    end if;
    if has_table_privilege('anon', 'public.' || tbl, 'SELECT')
      or has_table_privilege('anon', 'public.' || tbl, 'INSERT')
      or has_table_privilege('anon', 'public.' || tbl, 'UPDATE')
      or has_table_privilege('anon', 'public.' || tbl, 'DELETE') then
      raise exception 'anon must have zero privileges on %', tbl;
    end if;
    if not has_table_privilege('authenticated', 'public.' || tbl, 'SELECT') then
      raise exception 'authenticated must have SELECT privilege on %', tbl;
    end if;
    if has_table_privilege('authenticated', 'public.' || tbl, 'INSERT')
      or has_table_privilege('authenticated', 'public.' || tbl, 'UPDATE')
      or has_table_privilege('authenticated', 'public.' || tbl, 'DELETE') then
      raise exception 'authenticated must NOT have write privileges on %', tbl;
    end if;
  end loop;

  foreach idx in array array[
    'ix_learning_skill_evidence_child_skill_created',
    'ix_learning_skill_evidence_child_module_created',
    'ix_learning_skill_evidence_parent_id',
    'uq_learning_skill_evidence_dedupe',
    'ix_memory_game_sessions_child_created',
    'ix_memory_game_sessions_parent_id',
    'ix_karaoke_practice_sessions_child_song_created',
    'ix_karaoke_practice_sessions_parent_id',
    'ix_karaoke_practice_sessions_song_id',
    'ix_karaoke_practice_sessions_song_version_id'
  ]
  loop
    if to_regclass('public.' || idx) is null then
      raise exception 'Missing expected V4 index: %', idx;
    end if;
  end loop;

  if to_regprocedure('public.is_published_karaoke_song_version(uuid)') is null then
    raise exception 'Missing SECURITY DEFINER helper public.is_published_karaoke_song_version(uuid)';
  end if;
  if has_function_privilege('anon', 'public.is_published_karaoke_song_version(uuid)', 'EXECUTE') then
    raise exception 'anon must NOT execute public.is_published_karaoke_song_version(uuid)';
  end if;
  if not exists (
    select 1 from pg_proc p
    cross join lateral unnest(coalesce(p.proconfig, array[]::text[])) as cfg
    where p.oid = 'public.is_published_karaoke_song_version(uuid)'::regprocedure
      and p.prosecdef
      and cfg in ('search_path=', 'search_path=""')
  ) then
    raise exception 'public.is_published_karaoke_song_version(uuid) must pin search_path';
  end if;
end;
$schema_and_indexes$;

-- 3. Seed multi-parent + published/hidden/draft karaoke test fixtures.
insert into public.profiles (id, role, displayname) values
  ('11111111-1111-4111-8111-111111111111', 'parent', 'Parent A'),
  ('22222222-2222-4222-8222-222222222222', 'parent', 'Parent B');

insert into public.childprofiles (id, parentid, alias, grade) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Child A', 2),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'Child B', 3);

insert into public.karaoke_songs (id, status, published_version_id) values
  ('10000000-0000-4000-8000-000000000001', 'PUBLISHED', '20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', 'HIDDEN',    '20000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003', 'DRAFT',     null);

insert into public.karaoke_song_versions (id, song_id, version_no, state, title) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 1, 'PUBLISHED', 'Published Song'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 1, 'PUBLISHED', 'Hidden Song'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 1, 'DRAFT',     'Draft Song');

set role service_role;

insert into public.learning_skill_evidence (id, child_id, parent_id, skill_key, source_module, source_record_id, score_normalized) values
  ('30000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'visual_observation', 'PICTURE_DESCRIPTION', 'rec-a', 0.9),
  ('30000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'visual_observation', 'PICTURE_DESCRIPTION', 'rec-b', 0.8);

insert into public.memory_game_sessions (id, child_id, parent_id, child_grade, theme_key, scene_seed, scene_spec) values
  ('40000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 2, 'sunny_garden', 42, '{"items":[]}'::jsonb),
  ('40000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 3, 'sunny_garden', 43, '{"items":[]}'::jsonb);

insert into public.memory_game_attempts (id, session_id, attempt_number, response_text, evaluation_payload) values
  ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 1, 'Con mèo vàng', '{}'::jsonb),
  ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 1, 'Bông hoa đỏ', '{}'::jsonb);

insert into public.karaoke_practice_sessions (id, child_id, parent_id, song_id, song_version_id, practice_mode, scoring_mode, overall_score, stars) values
  ('60000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'FULL_SONG', 'FULL_MUSICAL', 92, 3),
  ('60000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'FULL_SONG', 'FULL_MUSICAL', 88, 3);

insert into public.karaoke_musical_profiles (song_version_id, bpm, audio_type, has_beat_grid, source_method) values
  ('20000000-0000-4000-8000-000000000001', 112.0, 'VOCAL_FULL', true, 'ID3_LRC'),
  ('20000000-0000-4000-8000-000000000002', 100.0, 'VOCAL_FULL', true, 'ID3_LRC'),
  ('20000000-0000-4000-8000-000000000003', 95.0,  'VOCAL_FULL', true, 'LYRICS_TIMING');

reset role;

-- 4. Verify anon cannot read or write any of the 5 tables.
set role anon;
do $anon_blocked$
declare
  cnt integer;
begin
  begin
    select count(*) into cnt from public.learning_skill_evidence;
    raise exception 'anon read learning_skill_evidence succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into cnt from public.memory_game_sessions;
    raise exception 'anon read memory_game_sessions succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into cnt from public.memory_game_attempts;
    raise exception 'anon read memory_game_attempts succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into cnt from public.karaoke_practice_sessions;
    raise exception 'anon read karaoke_practice_sessions succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into cnt from public.karaoke_musical_profiles;
    raise exception 'anon read karaoke_musical_profiles succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$anon_blocked$;
reset role;

-- 5. Verify authenticated Parent A sees ONLY Parent A rows & published profile, and cannot write.
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
set role authenticated;
do $parent_a_rls$
declare
  cnt integer;
  found_id uuid;
begin
  select count(*), min(id::text)::uuid into cnt, found_id from public.learning_skill_evidence;
  if cnt <> 1 or found_id <> '30000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'RLS failed for learning_skill_evidence: cnt=% id=%', cnt, found_id;
  end if;

  select count(*), min(id::text)::uuid into cnt, found_id from public.memory_game_sessions;
  if cnt <> 1 or found_id <> '40000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'RLS failed for memory_game_sessions: cnt=% id=%', cnt, found_id;
  end if;

  select count(*), min(id::text)::uuid into cnt, found_id from public.memory_game_attempts;
  if cnt <> 1 or found_id <> '50000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'RLS failed for memory_game_attempts: cnt=% id=%', cnt, found_id;
  end if;

  select count(*), min(id::text)::uuid into cnt, found_id from public.karaoke_practice_sessions;
  if cnt <> 1 or found_id <> '60000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'RLS failed for karaoke_practice_sessions: cnt=% id=%', cnt, found_id;
  end if;

  select count(*), min(song_version_id::text)::uuid into cnt, found_id from public.karaoke_musical_profiles;
  if cnt <> 1 or found_id <> '20000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'RLS failed for karaoke_musical_profiles: cnt=% ver=%', cnt, found_id;
  end if;

  begin
    insert into public.learning_skill_evidence (child_id, parent_id, skill_key, source_module, score_normalized)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'visual_observation', 'KARAOKE', 1.0);
    raise exception 'authenticated must not INSERT into learning_skill_evidence';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.memory_game_sessions where id = '40000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'authenticated must not DELETE from memory_game_sessions';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.karaoke_musical_profiles set bpm = 200 where song_version_id = '20000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'authenticated must not UPDATE karaoke_musical_profiles';
  exception when insufficient_privilege then null;
  end;
end;
$parent_a_rls$;
reset role;
reset request.jwt.claim.sub;

-- Verify authenticated with missing JWT sub sees 0 parent-scoped rows.
set role authenticated;
do $no_claim_rls$
declare
  cnt integer;
begin
  select count(*) into cnt from public.learning_skill_evidence;
  if cnt <> 0 then
    raise exception 'Unauthenticated claim leaked learning_skill_evidence rows: %', cnt;
  end if;
  select count(*) into cnt from public.memory_game_sessions;
  if cnt <> 0 then
    raise exception 'Unauthenticated claim leaked memory_game_sessions rows: %', cnt;
  end if;
  select count(*) into cnt from public.memory_game_attempts;
  if cnt <> 0 then
    raise exception 'Unauthenticated claim leaked memory_game_attempts rows: %', cnt;
  end if;
  select count(*) into cnt from public.karaoke_practice_sessions;
  if cnt <> 0 then
    raise exception 'Unauthenticated claim leaked karaoke_practice_sessions rows: %', cnt;
  end if;
end;
$no_claim_rls$;
reset role;

-- 6. Execute rollback TWICE and verify all 5 V4 tables are dropped while core tables stay intact.
\ir ../rollbacks/20261127000000_entertainment_v4_ecosystem_rollback.sql
\ir ../rollbacks/20261127000000_entertainment_v4_ecosystem_rollback.sql

do $post_rollback$
declare
  tbl text;
begin
  foreach tbl in array array[
    'learning_skill_evidence',
    'memory_game_sessions',
    'memory_game_attempts',
    'karaoke_practice_sessions',
    'karaoke_musical_profiles'
  ]
  loop
    if to_regclass('public.' || tbl) is not null then
      raise exception 'Rollback left behind V4 table: %', tbl;
    end if;
  end loop;
  if to_regprocedure('public.is_published_karaoke_song_version(uuid)') is not null then
    raise exception 'Rollback left behind helper public.is_published_karaoke_song_version(uuid)';
  end if;

  foreach tbl in array array[
    'profiles',
    'childprofiles',
    'karaoke_songs',
    'karaoke_song_versions'
  ]
  loop
    if to_regclass('public.' || tbl) is null then
      raise exception 'Rollback unexpectedly dropped core table: %', tbl;
    end if;
  end loop;
end;
$post_rollback$;

-- 7. Verify forward migration re-applies cleanly after rollback.
\ir ../migrations/20261127000000_entertainment_v4_ecosystem.sql

\echo 'PASS: Entertainment V4 migration 20261127000000, hot FK indexes, RLS isolation, and rollback verified'
