-- Rollback for ViRead Intelligent Play & Learn V4.0 additive schema (20261126130000).
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop table if exists public.karaoke_musical_profiles cascade;
drop table if exists public.karaoke_practice_sessions cascade;
drop table if exists public.memory_game_attempts cascade;
drop table if exists public.memory_game_sessions cascade;
drop table if exists public.learning_skill_evidence cascade;
drop function if exists public.is_published_karaoke_song_version(uuid);

commit;
