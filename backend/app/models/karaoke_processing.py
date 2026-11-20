"""Durable, server-only processing snapshots and external-operation ledger."""
from uuid import uuid4

from sqlalchemy import BigInteger, CheckConstraint, Column, Date, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, Numeric, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database.session import Base
from app.models.karaoke import utcnow

OUTSTANDING = ("QUEUED", "RUNNING", "READY", "NEEDS_REVIEW")


class KaraokeProcessingJob(Base):
    __tablename__ = "karaoke_processing_jobs"
    __table_args__ = (
        ForeignKeyConstraint(["song_id", "draft_version_id"],
                             ["karaoke_song_versions.song_id", "karaoke_song_versions.id"],
                             name="karaoke_job_draft_fk", ondelete="RESTRICT"),
        UniqueConstraint("song_id", "id", name="karaoke_job_song_id_key"),
        UniqueConstraint("song_id", "draft_version_id", "created_by", "idempotency_key", name="karaoke_job_intent_key"),
        CheckConstraint("status IN ('QUEUED','RUNNING','READY','NEEDS_REVIEW','FAILED','CANCELLED','STALE','APPLIED')", name="karaoke_job_status"),
        CheckConstraint("stage IN ('QUEUED','VALIDATING_INPUT','PREPARING_AUDIO','ALIGNING_LYRICS','VALIDATING_RESULT','COMPLETE')", name="karaoke_job_stage"),
        CheckConstraint("mode IN ('VOCAL_TRACK','INSTRUMENTAL_WITH_REFERENCE')", name="karaoke_job_mode"),
        CheckConstraint("source_kind IN ('DRAFT_AUDIO','ORIGINAL_RECORDING')", name="karaoke_job_source"),
        CheckConstraint("retry_policy IN ('NONE','SAFE_RETRY','NEEDS_INPUT_CHANGE','EXPLICIT_COST_ACK')", name="karaoke_job_retry_policy"),
        CheckConstraint("base_revision >= 1 AND attempt_count >= 0 AND reserved_audio_ms > 0", name="karaoke_job_numbers"),
        CheckConstraint("input_audio_size_bytes BETWEEN 1 AND 20971520 AND input_duration_ms BETWEEN 1 AND 300000", name="karaoke_job_audio_bounds"),
        CheckConstraint("input_audio_sha256 ~ '^[0-9a-f]{64}$' AND base_audio_sha256 ~ '^[0-9a-f]{64}$' AND input_fingerprint ~ '^[0-9a-f]{64}$' AND request_fingerprint ~ '^[0-9a-f]{64}$' AND lyrics_text_sha256 ~ '^[0-9a-f]{64}$' AND lyrics_snapshot_sha256 ~ '^[0-9a-f]{64}$'", name="karaoke_job_hashes"),
        CheckConstraint("octet_length(input_lyrics::text) <= 2097152 AND octet_length(COALESCE(result_lyrics::text,'')) <= 2097152 AND octet_length(COALESCE(quality_report::text,'')) <= 524288 AND octet_length(COALESCE(provenance::text,'')) <= 131072", name="karaoke_job_json_bounds"),
        CheckConstraint("status NOT IN ('READY','NEEDS_REVIEW','APPLIED') OR (num_nonnulls(result_lyrics,result_audio_path,result_audio_sha256,result_audio_size_bytes,result_duration_ms,quality_report) = 6 AND result_audio_sha256 ~ '^[0-9a-f]{64}$' AND result_audio_size_bytes BETWEEN 1 AND 20971520 AND result_duration_ms BETWEEN 1 AND 300000)", name="karaoke_job_result_complete"),
        CheckConstraint("num_nonnulls(input_reference_path,input_reference_sha256,input_reference_size_bytes,input_reference_duration_ms) IN (0,4) AND (input_reference_path IS NULL OR (input_reference_sha256 ~ '^[0-9a-f]{64}$' AND input_reference_size_bytes BETWEEN 1 AND 20971520 AND input_reference_duration_ms BETWEEN 1 AND 300000))", name="karaoke_job_reference_complete"),
        CheckConstraint("status <> 'APPLIED' OR (applied_revision > base_revision AND applied_at IS NOT NULL)", name="karaoke_job_applied_complete"),
        Index("karaoke_one_outstanding_job_idx", "draft_version_id", unique=True,
              postgresql_where=text("status IN ('QUEUED','RUNNING','READY','NEEDS_REVIEW')")),
        Index("karaoke_job_claim_idx", "status", "next_attempt_at", "created_at"),
        Index("karaoke_job_history_idx", "song_id", "created_at", "id"),
        Index("karaoke_job_quota_idx", "quota_day", "created_by"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    song_id = Column(UUID(as_uuid=True), ForeignKey("karaoke_songs.id", ondelete="RESTRICT"), nullable=False)
    draft_version_id = Column(UUID(as_uuid=True), nullable=False)
    created_by = Column(UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))
    idempotency_key = Column(UUID(as_uuid=True), nullable=False)
    request_fingerprint = Column(String(64), nullable=False)
    retry_of_job_id = Column(UUID(as_uuid=True), ForeignKey("karaoke_processing_jobs.id", ondelete="RESTRICT"))
    mode = Column(String(40), nullable=False)
    source_kind = Column(String(32), nullable=False)
    pipeline_version = Column(String(80), nullable=False)
    base_revision = Column(Integer, nullable=False)
    input_fingerprint = Column(String(64), nullable=False)
    base_audio_sha256 = Column(String(64), nullable=False)
    base_reference_sha256 = Column(String(64))
    input_lyrics = Column(JSONB, nullable=False)
    lyrics_text_sha256 = Column(String(64), nullable=False)
    lyrics_snapshot_sha256 = Column(String(64), nullable=False)
    input_audio_path = Column(Text, nullable=False)
    input_audio_sha256 = Column(String(64), nullable=False)
    input_audio_size_bytes = Column(Integer, nullable=False)
    input_duration_ms = Column(Integer, nullable=False)
    input_reference_path = Column(Text)
    input_reference_sha256 = Column(String(64))
    input_reference_size_bytes = Column(Integer)
    input_reference_duration_ms = Column(Integer)
    status = Column(String(20), nullable=False, default="QUEUED", server_default="QUEUED")
    stage = Column(String(32), nullable=False, default="QUEUED", server_default="QUEUED")
    attempt_count = Column(Integer, nullable=False, default=0, server_default="0")
    next_attempt_at = Column(DateTime(timezone=True))
    lease_token = Column(UUID(as_uuid=True))
    lease_expires_at = Column(DateTime(timezone=True))
    heartbeat_at = Column(DateTime(timezone=True))
    cancel_requested_at = Column(DateTime(timezone=True))
    quota_day = Column(Date, nullable=False)
    reserved_audio_ms = Column(BigInteger, nullable=False)
    quota_released_at = Column(DateTime(timezone=True))
    result_lyrics = Column(JSONB)
    result_audio_path = Column(Text)
    result_audio_sha256 = Column(String(64))
    result_audio_size_bytes = Column(Integer)
    result_duration_ms = Column(Integer)
    quality_report = Column(JSONB)
    provenance = Column(JSONB)
    safe_error_code = Column(String(64))
    retry_policy = Column(String(24), nullable=False, default="NONE", server_default="NONE")
    finished_at = Column(DateTime(timezone=True))
    applied_revision = Column(Integer)
    applied_at = Column(DateTime(timezone=True))


class KaraokeProcessingOperation(Base):
    __tablename__ = "karaoke_processing_operations"
    __table_args__ = (
        UniqueConstraint("job_id", "step_key", "attempt", name="karaoke_operation_step_key"),
        UniqueConstraint("operation_key", name="karaoke_operation_intent_key"),
        CheckConstraint("state IN ('PREPARED','SUBMITTED','COMPLETED','FAILED','UNKNOWN')", name="karaoke_operation_state"),
        CheckConstraint("attempt >= 1 AND octet_length(usage::text) <= 32768 AND octet_length(artifact_paths::text) <= 32768", name="karaoke_operation_bounds"),
        CheckConstraint("step_input_fingerprint ~ '^[0-9a-f]{64}$'", name="karaoke_operation_input_hash"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("karaoke_processing_jobs.id", ondelete="RESTRICT"), nullable=False)
    stage = Column(String(32), nullable=False)
    step_key = Column(String(80), nullable=False)
    step_input_fingerprint = Column(String(64), nullable=False)
    attempt = Column(Integer, nullable=False)
    operation_key = Column(UUID(as_uuid=True), nullable=False, default=uuid4)
    state = Column(String(16), nullable=False, default="PREPARED", server_default="PREPARED")
    provider = Column(String(80), nullable=False)
    model_version = Column(String(160), nullable=False)
    pipeline_version = Column(String(80), nullable=False)
    provider_request_id = Column(String(128))
    lease_token = Column(UUID(as_uuid=True), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))
    completed_at = Column(DateTime(timezone=True))
    safe_error_code = Column(String(64))
    usage = Column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    cost_amount = Column(Numeric(18, 8))
    cost_currency = Column(String(8))
    artifact_paths = Column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    result_digest = Column(String(64))
