-- Automatic karaoke processing; additive schema, no content seed or account changes.

BEGIN;

SET LOCAL search_path = public;

ALTER TABLE public.karaoke_songs ADD COLUMN creation_request_id UUID;

ALTER TABLE public.karaoke_songs ADD COLUMN creation_request_fingerprint VARCHAR(64);

ALTER TABLE public.karaoke_song_versions ADD COLUMN requires_processing_review BOOLEAN DEFAULT false NOT NULL;

ALTER TABLE public.karaoke_song_versions ADD COLUMN origin_job_id UUID;

ALTER TABLE public.karaoke_song_versions ADD COLUMN reviewed_content_sha256 VARCHAR(64);

ALTER TABLE public.karaoke_song_versions ADD COLUMN reviewed_by UUID;

ALTER TABLE public.karaoke_song_versions ADD COLUMN reviewed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.karaoke_song_versions ADD COLUMN review_acknowledged_flag_ids JSONB DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE public.karaoke_song_versions ADD COLUMN reference_audio_path TEXT;

ALTER TABLE public.karaoke_song_versions ADD COLUMN reference_audio_sha256 VARCHAR(64);

ALTER TABLE public.karaoke_song_versions ADD COLUMN reference_audio_size_bytes INTEGER;

ALTER TABLE public.karaoke_song_versions ADD COLUMN reference_duration_ms INTEGER;

CREATE TABLE karaoke_processing_jobs (
	id UUID NOT NULL,
	song_id UUID NOT NULL,
	draft_version_id UUID NOT NULL,
	created_by UUID,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	idempotency_key UUID NOT NULL,
	request_fingerprint VARCHAR(64) NOT NULL,
	retry_of_job_id UUID,
	mode VARCHAR(40) NOT NULL,
	source_kind VARCHAR(32) NOT NULL,
	pipeline_version VARCHAR(80) NOT NULL,
	base_revision INTEGER NOT NULL,
	input_fingerprint VARCHAR(64) NOT NULL,
	base_audio_sha256 VARCHAR(64) NOT NULL,
	base_reference_sha256 VARCHAR(64),
	input_lyrics JSONB NOT NULL,
	lyrics_text_sha256 VARCHAR(64) NOT NULL,
	lyrics_snapshot_sha256 VARCHAR(64) NOT NULL,
	input_audio_path TEXT NOT NULL,
	input_audio_sha256 VARCHAR(64) NOT NULL,
	input_audio_size_bytes INTEGER NOT NULL,
	input_duration_ms INTEGER NOT NULL,
	input_reference_path TEXT,
	input_reference_sha256 VARCHAR(64),
	input_reference_size_bytes INTEGER,
	input_reference_duration_ms INTEGER,
	status VARCHAR(20) DEFAULT 'QUEUED' NOT NULL,
	stage VARCHAR(32) DEFAULT 'QUEUED' NOT NULL,
	attempt_count INTEGER DEFAULT '0' NOT NULL,
	next_attempt_at TIMESTAMP WITH TIME ZONE,
	lease_token UUID,
	lease_expires_at TIMESTAMP WITH TIME ZONE,
	heartbeat_at TIMESTAMP WITH TIME ZONE,
	cancel_requested_at TIMESTAMP WITH TIME ZONE,
	quota_day DATE NOT NULL,
	reserved_audio_ms BIGINT NOT NULL,
	quota_released_at TIMESTAMP WITH TIME ZONE,
	result_lyrics JSONB,
	result_audio_path TEXT,
	result_audio_sha256 VARCHAR(64),
	result_audio_size_bytes INTEGER,
	result_duration_ms INTEGER,
	quality_report JSONB,
	provenance JSONB,
	safe_error_code VARCHAR(64),
	retry_policy VARCHAR(24) DEFAULT 'NONE' NOT NULL,
	finished_at TIMESTAMP WITH TIME ZONE,
	applied_revision INTEGER,
	applied_at TIMESTAMP WITH TIME ZONE,
	PRIMARY KEY (id),
	CONSTRAINT karaoke_job_draft_fk FOREIGN KEY(song_id, draft_version_id) REFERENCES karaoke_song_versions (song_id, id) ON DELETE RESTRICT,
	CONSTRAINT karaoke_job_song_id_key UNIQUE (song_id, id),
	CONSTRAINT karaoke_job_intent_key UNIQUE (song_id, draft_version_id, created_by, idempotency_key),
	CONSTRAINT karaoke_job_status CHECK (status IN ('QUEUED','RUNNING','READY','NEEDS_REVIEW','FAILED','CANCELLED','STALE','APPLIED')),
	CONSTRAINT karaoke_job_stage CHECK (stage IN ('QUEUED','VALIDATING_INPUT','PREPARING_AUDIO','ALIGNING_LYRICS','VALIDATING_RESULT','COMPLETE')),
	CONSTRAINT karaoke_job_mode CHECK (mode IN ('VOCAL_TRACK','INSTRUMENTAL_WITH_REFERENCE')),
	CONSTRAINT karaoke_job_source CHECK (source_kind IN ('DRAFT_AUDIO','ORIGINAL_RECORDING')),
	CONSTRAINT karaoke_job_retry_policy CHECK (retry_policy IN ('NONE','SAFE_RETRY','NEEDS_INPUT_CHANGE','EXPLICIT_COST_ACK')),
	CONSTRAINT karaoke_job_numbers CHECK (base_revision >= 1 AND attempt_count >= 0 AND reserved_audio_ms > 0),
	CONSTRAINT karaoke_job_audio_bounds CHECK (input_audio_size_bytes BETWEEN 1 AND 20971520 AND input_duration_ms BETWEEN 1 AND 300000),
	CONSTRAINT karaoke_job_hashes CHECK (input_audio_sha256 ~ '^[0-9a-f]{64}$' AND base_audio_sha256 ~ '^[0-9a-f]{64}$' AND input_fingerprint ~ '^[0-9a-f]{64}$' AND request_fingerprint ~ '^[0-9a-f]{64}$' AND lyrics_text_sha256 ~ '^[0-9a-f]{64}$' AND lyrics_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT karaoke_job_json_bounds CHECK (octet_length(input_lyrics::text) <= 2097152 AND octet_length(COALESCE(result_lyrics::text,'')) <= 2097152 AND octet_length(COALESCE(quality_report::text,'')) <= 524288 AND octet_length(COALESCE(provenance::text,'')) <= 131072),
	CONSTRAINT karaoke_job_result_complete CHECK (status NOT IN ('READY','NEEDS_REVIEW','APPLIED') OR (num_nonnulls(result_lyrics,result_audio_path,result_audio_sha256,result_audio_size_bytes,result_duration_ms,quality_report) = 6 AND result_audio_sha256 ~ '^[0-9a-f]{64}$' AND result_audio_size_bytes BETWEEN 1 AND 20971520 AND result_duration_ms BETWEEN 1 AND 300000)),
	CONSTRAINT karaoke_job_reference_complete CHECK (num_nonnulls(input_reference_path,input_reference_sha256,input_reference_size_bytes,input_reference_duration_ms) IN (0,4) AND (input_reference_path IS NULL OR (input_reference_sha256 ~ '^[0-9a-f]{64}$' AND input_reference_size_bytes BETWEEN 1 AND 20971520 AND input_reference_duration_ms BETWEEN 1 AND 300000))),
	CONSTRAINT karaoke_job_applied_complete CHECK (status <> 'APPLIED' OR (applied_revision > base_revision AND applied_at IS NOT NULL)),
	FOREIGN KEY(song_id) REFERENCES karaoke_songs (id) ON DELETE RESTRICT,
	FOREIGN KEY(created_by) REFERENCES profiles (id) ON DELETE SET NULL,
	FOREIGN KEY(retry_of_job_id) REFERENCES karaoke_processing_jobs (id) ON DELETE RESTRICT
);

CREATE TABLE karaoke_processing_operations (
	id UUID NOT NULL,
	job_id UUID NOT NULL,
	stage VARCHAR(32) NOT NULL,
	step_key VARCHAR(80) NOT NULL,
	step_input_fingerprint VARCHAR(64) NOT NULL,
	attempt INTEGER NOT NULL,
	operation_key UUID NOT NULL,
	state VARCHAR(16) DEFAULT 'PREPARED' NOT NULL,
	provider VARCHAR(80) NOT NULL,
	model_version VARCHAR(160) NOT NULL,
	pipeline_version VARCHAR(80) NOT NULL,
	provider_request_id VARCHAR(128),
	lease_token UUID NOT NULL,
	started_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	completed_at TIMESTAMP WITH TIME ZONE,
	safe_error_code VARCHAR(64),
	usage JSONB DEFAULT '{}'::jsonb NOT NULL,
	cost_amount NUMERIC(18, 8),
	cost_currency VARCHAR(8),
	artifact_paths JSONB DEFAULT '[]'::jsonb NOT NULL,
	result_digest VARCHAR(64),
	PRIMARY KEY (id),
	CONSTRAINT karaoke_operation_step_key UNIQUE (job_id, step_key, attempt),
	CONSTRAINT karaoke_operation_intent_key UNIQUE (operation_key),
	CONSTRAINT karaoke_operation_state CHECK (state IN ('PREPARED','SUBMITTED','COMPLETED','FAILED','UNKNOWN')),
	CONSTRAINT karaoke_operation_bounds CHECK (attempt >= 1 AND octet_length(usage::text) <= 32768 AND octet_length(artifact_paths::text) <= 32768),
	CONSTRAINT karaoke_operation_input_hash CHECK (step_input_fingerprint ~ '^[0-9a-f]{64}$'),
	FOREIGN KEY(job_id) REFERENCES karaoke_processing_jobs (id) ON DELETE RESTRICT
);

ALTER TABLE karaoke_songs ADD CONSTRAINT karaoke_creation_request_pair CHECK ((creation_request_id IS NULL) = (creation_request_fingerprint IS NULL));

ALTER TABLE karaoke_song_versions ADD FOREIGN KEY(reviewed_by) REFERENCES profiles (id) ON DELETE SET NULL;

ALTER TABLE karaoke_song_versions ADD CONSTRAINT karaoke_reference_complete CHECK ((reference_audio_path IS NULL AND reference_audio_sha256 IS NULL AND reference_audio_size_bytes IS NULL AND reference_duration_ms IS NULL) OR (num_nonnulls(reference_audio_path, reference_audio_sha256, reference_audio_size_bytes, reference_duration_ms) = 4 AND reference_audio_sha256 ~ '^[0-9a-f]{64}$' AND reference_audio_size_bytes BETWEEN 1 AND 20971520 AND reference_duration_ms BETWEEN 1 AND 300000));

ALTER TABLE karaoke_song_versions ADD CONSTRAINT karaoke_review_pair CHECK ((reviewed_content_sha256 IS NULL) = (reviewed_at IS NULL));

ALTER TABLE karaoke_song_versions ADD CONSTRAINT karaoke_version_origin_job_fk FOREIGN KEY(song_id, origin_job_id) REFERENCES karaoke_processing_jobs (song_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX karaoke_creation_request_idx ON karaoke_songs (created_by, creation_request_id) WHERE creation_request_id IS NOT NULL;

CREATE INDEX karaoke_job_claim_idx ON karaoke_processing_jobs (status, next_attempt_at, created_at);

CREATE INDEX karaoke_job_history_idx ON karaoke_processing_jobs (song_id, created_at, id);

CREATE INDEX karaoke_job_quota_idx ON karaoke_processing_jobs (quota_day, created_by);

CREATE UNIQUE INDEX karaoke_one_outstanding_job_idx ON karaoke_processing_jobs (draft_version_id) WHERE status IN ('QUEUED','RUNNING','READY','NEEDS_REVIEW');

ALTER TABLE public.karaoke_processing_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.karaoke_processing_jobs FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.karaoke_processing_jobs TO service_role;

CREATE POLICY karaoke_processing_jobs_server_only ON public.karaoke_processing_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.karaoke_processing_operations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.karaoke_processing_operations FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.karaoke_processing_operations TO service_role;

CREATE POLICY karaoke_processing_operations_server_only ON public.karaoke_processing_operations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Inputs remain immutable; a ready candidate is never rewritten by a late worker.
CREATE FUNCTION public.karaoke_processing_preserve_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    IF ROW(NEW.song_id, NEW.draft_version_id, NEW.idempotency_key,
           NEW.request_fingerprint, NEW.mode, NEW.source_kind, NEW.pipeline_version,
           NEW.base_revision, NEW.input_fingerprint, NEW.base_audio_sha256,
           NEW.base_reference_sha256, NEW.input_lyrics, NEW.lyrics_text_sha256,
           NEW.lyrics_snapshot_sha256, NEW.input_audio_path, NEW.input_audio_sha256,
           NEW.input_audio_size_bytes, NEW.input_duration_ms, NEW.input_reference_path,
           NEW.input_reference_sha256, NEW.input_reference_size_bytes, NEW.input_reference_duration_ms,
           NEW.quota_day, NEW.reserved_audio_ms)
       IS DISTINCT FROM
       ROW(OLD.song_id, OLD.draft_version_id, OLD.idempotency_key,
           OLD.request_fingerprint, OLD.mode, OLD.source_kind, OLD.pipeline_version,
           OLD.base_revision, OLD.input_fingerprint, OLD.base_audio_sha256,
           OLD.base_reference_sha256, OLD.input_lyrics, OLD.lyrics_text_sha256,
           OLD.lyrics_snapshot_sha256, OLD.input_audio_path, OLD.input_audio_sha256,
           OLD.input_audio_size_bytes, OLD.input_duration_ms, OLD.input_reference_path,
           OLD.input_reference_sha256, OLD.input_reference_size_bytes, OLD.input_reference_duration_ms,
           OLD.quota_day, OLD.reserved_audio_ms) THEN
        RAISE EXCEPTION 'Karaoke job input snapshot is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('READY','NEEDS_REVIEW','APPLIED') AND
       ROW(NEW.result_lyrics, NEW.result_audio_path, NEW.result_audio_sha256,
           NEW.result_audio_size_bytes, NEW.result_duration_ms, NEW.quality_report, NEW.provenance)
       IS DISTINCT FROM
       ROW(OLD.result_lyrics, OLD.result_audio_path, OLD.result_audio_sha256,
           OLD.result_audio_size_bytes, OLD.result_duration_ms, OLD.quality_report, OLD.provenance) THEN
        RAISE EXCEPTION 'Karaoke candidate is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER karaoke_processing_preserve_snapshot
BEFORE UPDATE ON public.karaoke_processing_jobs
FOR EACH ROW EXECUTE FUNCTION public.karaoke_processing_preserve_snapshot();

COMMIT;
