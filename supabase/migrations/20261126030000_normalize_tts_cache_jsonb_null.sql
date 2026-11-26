-- Normalize legacy JSONB literal 'null' values in tts_audio_cache_entries.word_timings_json
-- to true SQL NULL so `word_timings_json IS NOT NULL` and `COALESCE(...)` behave accurately
-- for timed vs untimed TTS cache entries. Strictly idempotent, lock-bounded, safe on minimal schemas.

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $normalize_tts_jsonb_null$
begin
  if to_regclass('public.tts_audio_cache_entries') is not null then
    update public.tts_audio_cache_entries
       set word_timings_json = null
     where word_timings_json = 'null'::jsonb;
  end if;
end;
$normalize_tts_jsonb_null$;

commit;
