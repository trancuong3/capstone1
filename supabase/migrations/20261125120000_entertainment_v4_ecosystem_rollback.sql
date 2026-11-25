-- Rollback for ViRead Intelligent Play & Learn V4.0 additive schema.
begin;

drop table if exists public.karaoke_musical_profiles cascade;
drop table if exists public.karaoke_practice_sessions cascade;
drop table if exists public.memory_game_attempts cascade;
drop table if exists public.memory_game_sessions cascade;
drop table if exists public.learning_skill_evidence cascade;

commit;
