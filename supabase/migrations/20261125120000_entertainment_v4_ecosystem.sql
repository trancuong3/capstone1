-- ViRead Intelligent Play & Learn V4.0 additive schema.
-- Strictly backward-compatible: adds new tables only, zero destructive edits to existing tables.
-- Stores compact learning evidence, memory game scenes/attempts, karaoke musical practice reports,
-- and optional karaoke musical profiles. Never stores raw child audio recordings.
begin;

create table if not exists public.learning_skill_evidence (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.childprofiles(id) on delete cascade,
  parent_id uuid not null references public.profiles(id) on delete cascade,
  skill_key varchar(64) not null,
  source_module varchar(32) not null,
  source_record_id varchar(64),
  evidence_type varchar(16) not null default 'OBSERVED',
  score_normalized double precision not null,
  confidence double precision not null default 0.7,
  difficulty_level smallint not null default 1,
  practice_words jsonb not null default '[]'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ck_learning_skill_evidence_module check (
    source_module in (
      'READING',
      'DIFFICULT_WORD',
      'PICTURE_DESCRIPTION',
      'SENTENCE_SHOOTER',
      'KARAOKE',
      'MEMORY_GAME'
    )
  ),
  constraint ck_learning_skill_evidence_type check (evidence_type in ('OBSERVED', 'ESTIMATED')),
  constraint ck_learning_skill_evidence_score check (score_normalized >= 0 and score_normalized <= 1),
  constraint ck_learning_skill_evidence_confidence check (confidence >= 0 and confidence <= 1),
  constraint ck_learning_skill_evidence_difficulty check (difficulty_level between 1 and 5)
);

create index if not exists ix_learning_skill_evidence_child_skill_created
  on public.learning_skill_evidence(child_id, skill_key, created_at desc);
create index if not exists ix_learning_skill_evidence_child_module_created
  on public.learning_skill_evidence(child_id, source_module, created_at desc);
create unique index if not exists uq_learning_skill_evidence_dedupe
  on public.learning_skill_evidence(child_id, source_module, source_record_id, skill_key)
  where source_record_id is not null;

create table if not exists public.memory_game_sessions (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.childprofiles(id) on delete cascade,
  parent_id uuid not null references public.profiles(id) on delete cascade,
  child_grade smallint not null,
  theme_key varchar(48) not null,
  difficulty_level smallint not null default 1,
  scene_seed integer not null,
  timer_mode varchar(16) not null default '30S',
  timer_seconds integer,
  recall_mode varchar(24) not null default 'FREE_RECALL',
  scene_spec jsonb not null,
  status varchar(16) not null default 'OBSERVING',
  hints_used smallint not null default 0,
  peek_count smallint not null default 0,
  best_factual_score smallint not null default 0,
  best_creative_score smallint not null default 0,
  stars smallint not null default 0,
  attempts_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_memory_game_sessions_grade check (child_grade between 1 and 5),
  constraint ck_memory_game_sessions_difficulty check (difficulty_level between 1 and 5),
  constraint ck_memory_game_sessions_timer_mode check (
    timer_mode in ('10S', '20S', '30S', '60S', '90S', '120S', 'UNLIMITED')
  ),
  constraint ck_memory_game_sessions_timer_seconds check (
    timer_seconds is null or timer_seconds between 10 and 120
  ),
  constraint ck_memory_game_sessions_recall_mode check (
    recall_mode in ('FREE_RECALL', 'GUIDED_RECALL')
  ),
  constraint ck_memory_game_sessions_status check (
    status in ('OBSERVING', 'RECALLING', 'CREATIVE', 'COMPLETED')
  ),
  constraint ck_memory_game_sessions_hints check (hints_used >= 0),
  constraint ck_memory_game_sessions_peeks check (peek_count >= 0),
  constraint ck_memory_game_sessions_factual check (best_factual_score between 0 and 100),
  constraint ck_memory_game_sessions_creative check (best_creative_score between 0 and 100),
  constraint ck_memory_game_sessions_stars check (stars between 0 and 3),
  constraint ck_memory_game_sessions_attempts check (attempts_count >= 0)
);

create index if not exists ix_memory_game_sessions_child_created
  on public.memory_game_sessions(child_id, created_at desc);

create table if not exists public.memory_game_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.memory_game_sessions(id) on delete cascade,
  attempt_number integer not null,
  stage varchar(24) not null default 'RECALL',
  input_mode varchar(16) not null default 'TEXT',
  response_text text not null,
  factual_score smallint not null default 0,
  creative_score smallint not null default 0,
  stars smallint not null default 0,
  evaluation_payload jsonb not null,
  ai_provider varchar(64),
  created_at timestamptz not null default now(),
  constraint ck_memory_game_attempts_number check (attempt_number >= 1),
  constraint ck_memory_game_attempts_stage check (stage in ('RECALL', 'CREATIVE')),
  constraint ck_memory_game_attempts_input_mode check (input_mode in ('VOICE', 'TEXT')),
  constraint ck_memory_game_attempts_factual check (factual_score between 0 and 100),
  constraint ck_memory_game_attempts_creative check (creative_score between 0 and 100),
  constraint ck_memory_game_attempts_stars check (stars between 0 and 3),
  constraint uq_memory_game_attempts_session_number unique (session_id, attempt_number)
);

create table if not exists public.karaoke_practice_sessions (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.childprofiles(id) on delete cascade,
  parent_id uuid not null references public.profiles(id) on delete cascade,
  song_id uuid not null references public.karaoke_songs(id) on delete cascade,
  song_version_id uuid references public.karaoke_song_versions(id) on delete set null,
  practice_mode varchar(24) not null default 'FULL_SONG',
  scoring_mode varchar(24) not null default 'INSUFFICIENT_EVIDENCE',
  playback_rate double precision not null default 1.0,
  headphone_mode boolean not null default false,
  overall_score smallint,
  rhythm_score smallint,
  pitch_score smallint,
  lyrics_score smallint,
  fluency_score smallint,
  stars smallint not null default 0,
  segment_start_ms integer,
  segment_end_ms integer,
  report_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ck_karaoke_practice_mode check (
    practice_mode in ('FULL_SONG', 'SEGMENT', 'RHYTHM_TAP', 'LINE_PRACTICE')
  ),
  constraint ck_karaoke_practice_scoring_mode check (
    scoring_mode in ('FULL_MUSICAL', 'RHYTHM_AND_LYRICS', 'LYRICS_ONLY', 'INSUFFICIENT_EVIDENCE')
  ),
  constraint ck_karaoke_practice_rate check (playback_rate >= 0.5 and playback_rate <= 1.5),
  constraint ck_karaoke_practice_overall check (overall_score is null or overall_score between 0 and 100),
  constraint ck_karaoke_practice_rhythm check (rhythm_score is null or rhythm_score between 0 and 100),
  constraint ck_karaoke_practice_pitch check (pitch_score is null or pitch_score between 0 and 100),
  constraint ck_karaoke_practice_lyrics check (lyrics_score is null or lyrics_score between 0 and 100),
  constraint ck_karaoke_practice_fluency check (fluency_score is null or fluency_score between 0 and 100),
  constraint ck_karaoke_practice_stars check (stars between 0 and 3),
  constraint ck_karaoke_practice_segment check (
    (segment_start_ms is null and segment_end_ms is null) or
    (segment_start_ms is not null and segment_end_ms is not null and segment_start_ms >= 0 and segment_end_ms > segment_start_ms)
  )
);

create index if not exists ix_karaoke_practice_sessions_child_song_created
  on public.karaoke_practice_sessions(child_id, song_id, created_at desc);

create table if not exists public.karaoke_musical_profiles (
  song_version_id uuid primary key references public.karaoke_song_versions(id) on delete cascade,
  bpm double precision,
  audio_type varchar(24) not null default 'UNKNOWN',
  has_pitch_contour boolean not null default false,
  has_beat_grid boolean not null default false,
  source_method varchar(32) not null default 'LYRICS_TIMING',
  profile_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint ck_karaoke_musical_profiles_bpm check (bpm is null or (bpm >= 30 and bpm <= 240)),
  constraint ck_karaoke_musical_profiles_audio_type check (
    audio_type in ('VOCAL_FULL', 'INSTRUMENTAL_ONLY', 'DUAL_TRACK', 'UNKNOWN')
  ),
  constraint ck_karaoke_musical_profiles_source_method check (
    source_method in ('ID3_LRC', 'AUDIO_DSP', 'WHISPER_DRAFT', 'MANUAL_TAP', 'LYRICS_TIMING')
  )
);

-- Enable Row-Level Security on all new tables.
alter table public.learning_skill_evidence enable row level security;
alter table public.memory_game_sessions enable row level security;
alter table public.memory_game_attempts enable row level security;
alter table public.karaoke_practice_sessions enable row level security;
alter table public.karaoke_musical_profiles enable row level security;

revoke all on table
  public.learning_skill_evidence,
  public.memory_game_sessions,
  public.memory_game_attempts,
  public.karaoke_practice_sessions,
  public.karaoke_musical_profiles
from anon;

grant select on table
  public.learning_skill_evidence,
  public.memory_game_sessions,
  public.memory_game_attempts,
  public.karaoke_practice_sessions,
  public.karaoke_musical_profiles
to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'learning_skill_evidence'
      and policyname = 'learning_skill_evidence_parent_reads'
  ) then
    create policy learning_skill_evidence_parent_reads
      on public.learning_skill_evidence for select to authenticated
      using (parent_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'memory_game_sessions'
      and policyname = 'memory_game_sessions_parent_reads'
  ) then
    create policy memory_game_sessions_parent_reads
      on public.memory_game_sessions for select to authenticated
      using (parent_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'memory_game_attempts'
      and policyname = 'memory_game_attempts_parent_reads'
  ) then
    create policy memory_game_attempts_parent_reads
      on public.memory_game_attempts for select to authenticated
      using (
        exists (
          select 1 from public.memory_game_sessions s
          where s.id = memory_game_attempts.session_id
            and s.parent_id = (select auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'karaoke_practice_sessions'
      and policyname = 'karaoke_practice_sessions_parent_reads'
  ) then
    create policy karaoke_practice_sessions_parent_reads
      on public.karaoke_practice_sessions for select to authenticated
      using (parent_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'karaoke_musical_profiles'
      and policyname = 'karaoke_musical_profiles_published_reads'
  ) then
    create policy karaoke_musical_profiles_published_reads
      on public.karaoke_musical_profiles for select to authenticated
      using (
        exists (
          select 1 from public.karaoke_song_versions v
          where v.id = karaoke_musical_profiles.song_version_id
            and v.state = 'PUBLISHED'
        )
      );
  end if;
end
$$;

commit;
