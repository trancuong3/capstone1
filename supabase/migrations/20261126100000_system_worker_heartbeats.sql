-- Persistent execution heartbeats for background, event-driven, and cron-scheduled workers.
-- Survives Render Free tier 15-minute spin-down / cold restarts so Admin Health accurately
-- reflects last execution status even when queues are idle (0 items processed).

CREATE TABLE IF NOT EXISTS public.system_worker_heartbeats (
    worker_key TEXT PRIMARY KEY,
    execution_mode TEXT NOT NULL,
    last_run_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error_at TIMESTAMPTZ,
    last_error_code TEXT,
    last_items_processed INT NOT NULL DEFAULT 0,
    last_source TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.system_worker_heartbeats ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.system_worker_heartbeats FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.system_worker_heartbeats TO service_role;

DROP POLICY IF EXISTS "system_worker_heartbeats_service_role_only" ON public.system_worker_heartbeats;
CREATE POLICY "system_worker_heartbeats_service_role_only"
    ON public.system_worker_heartbeats
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
