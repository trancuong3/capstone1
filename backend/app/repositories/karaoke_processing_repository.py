"""Short processing transactions; callers own one session/commit boundary."""
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy import and_, exists, func, or_, select, text, update

from app.models.karaoke import utcnow
from app.models.karaoke_processing import KaraokeProcessingJob as Job, KaraokeProcessingOperation as Operation, OUTSTANDING
from app.models.profile import Profile
from app.repositories.karaoke_repository import KaraokeRepository

# One global admission lock, shared across songs/admins. Lock order is:
# quota advisory lock -> song -> job -> operation. Never hold across media I/O.
QUOTA_NAMESPACE = 144764
QUOTA_LOCK_KEY = 110017


def freeze(record):
    if record is None:
        return None
    return SimpleNamespace(**{column.key: deepcopy(getattr(record, column.key))
                              for column in record.__table__.columns})


class KaraokeProcessingRepository:
    def __init__(self, db):
        self.db = db
        self.songs = KaraokeRepository(db)
        self.read = self.songs.read
        self.write = self.songs.write

    async def quota_lock(self):
        await self.db.execute(text("SELECT pg_advisory_xact_lock(:namespace,:key)"),
                              {"namespace": QUOTA_NAMESPACE, "key": QUOTA_LOCK_KEY})

    async def get(self, job_id, song_id, *, lock=False):
        query = select(Job).where(Job.id == job_id, Job.song_id == song_id).execution_options(populate_existing=True)
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def intent(self, actor_id, song_id, draft_id, key):
        return await self.db.scalar(select(Job).where(
            Job.created_by == actor_id, Job.song_id == song_id,
            Job.draft_version_id == draft_id, Job.idempotency_key == key,
        ))

    async def outstanding(self, draft_id, *, lock=False):
        query = select(Job).where(Job.draft_version_id == draft_id, Job.status.in_(OUTSTANDING))
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(query)

    async def latest_summaries(self, song_ids):
        if not song_ids:
            return {}
        rows = (await self.db.scalars(select(Job).where(Job.song_id.in_(song_ids))
            .distinct(Job.song_id).order_by(Job.song_id, Job.created_at.desc(), Job.id.desc())
            .execution_options(populate_existing=True))).all()
        return {row.song_id: freeze(row) for row in rows}

    async def list(self, song_id, limit, offset):
        total = await self.db.scalar(select(func.count()).select_from(Job).where(Job.song_id == song_id))
        rows = (await self.db.scalars(select(Job).where(Job.song_id == song_id)
                .order_by(Job.created_at.desc(), Job.id.desc()).limit(limit).offset(offset))).all()
        return [freeze(row) for row in rows], total

    async def quota_available(self, actor_id, duration_ms, config, day):
        # Must be called after quota_lock(), before enqueue in the same transaction.
        active = select(func.count()).select_from(Job).where(Job.status.in_(OUTSTANDING))
        if await self.db.scalar(active) >= config.max_global:
            return False
        if await self.db.scalar(active.where(Job.created_by == actor_id)) >= config.max_per_admin:
            return False
        reserved = select(func.coalesce(func.sum(Job.reserved_audio_ms), 0)).where(
            Job.quota_day == day, Job.quota_released_at.is_(None))
        if await self.db.scalar(reserved) + duration_ms > config.reserved_minutes_global_day * 60000:
            return False
        return await self.db.scalar(reserved.where(Job.created_by == actor_id)) + duration_ms <= config.reserved_minutes_admin_day * 60000

    async def enqueue(self, values):
        job = Job(id=uuid4(), created_at=utcnow(), updated_at=utcnow(), **values)
        self.db.add(job)
        await self.db.flush()
        return job

    @staticmethod
    def stale(job):
        job.status, job.retry_policy = "STALE", "NEEDS_INPUT_CHANGE"
        job.lease_token = job.lease_expires_at = None
        job.updated_at = job.finished_at = utcnow()

    async def actor_active(self, actor_id):
        if actor_id is None:
            return False
        return await self.songs.actor(actor_id) == ("admin", 1)

    async def claim(self, config):
        # Use PostgreSQL func.now() consistently with fence() and heartbeat()
        # so worker host clock skew can never expire a freshly claimed lease.
        db_now = func.now()
        # During a rolling deployment, another worker may own the algorithm
        # version of an older/newer job. Leave it queued for that worker rather
        # than claiming it and failing it in process()'s version guard.
        query = select(Job).where(Job.status == "QUEUED",
            Job.pipeline_version == config.pipeline_version, or_(
            Job.next_attempt_at.is_(None), Job.next_attempt_at <= db_now,
        )).order_by(Job.created_at, Job.id).with_for_update(skip_locked=True).limit(1)
        job = await self.db.scalar(query)
        if job is None:
            return None
        if not await self.actor_active(job.created_by):
            job.status, job.safe_error_code, job.retry_policy = "FAILED", "ACTOR_UNAVAILABLE", "NONE"
            job.updated_at = job.finished_at = db_now
            await self.db.flush()
            return None
        job.status = "RUNNING"
        job.stage = "VALIDATING_INPUT"
        job.attempt_count += 1
        job.lease_token = uuid4()
        job.heartbeat_at = job.updated_at = db_now
        job.lease_expires_at = db_now + timedelta(seconds=config.lease_seconds)
        await self.db.flush()
        await self.db.refresh(job)
        return freeze(job)

    @staticmethod
    def fence(job_id, token):
        return and_(Job.id == job_id, Job.status == "RUNNING", Job.lease_token == token,
                    Job.lease_expires_at > func.now(), exists(select(Profile.Id).where(
                        Profile.Id == Job.created_by, Profile.Role == "admin", Profile.Active == 1,
                    )))

    async def heartbeat(self, job_id, token, lease_seconds):
        result = await self.db.execute(update(Job).where(self.fence(job_id, token)).values(
            heartbeat_at=func.now(), lease_expires_at=func.now() + timedelta(seconds=lease_seconds),
            updated_at=func.now(),
        ).returning(Job.id).execution_options(synchronize_session=False))
        return result.scalar_one_or_none() is not None

    async def progress(self, job_id, token, *, stage, **values):
        allowed = {"result_lyrics", "result_audio_path", "result_audio_sha256", "result_audio_size_bytes",
                   "result_duration_ms", "quality_report", "provenance"}
        if set(values) - allowed:
            raise ValueError("Unsupported processing update")
        result = await self.db.execute(update(Job).where(self.fence(job_id, token)).values(
            stage=stage, updated_at=func.now(), **values,
        ).returning(Job.id).execution_options(synchronize_session=False))
        return result.scalar_one_or_none() is not None

    async def operations(self, job_id, *, lock=False):
        query = select(Operation).where(Operation.job_id == job_id).order_by(Operation.started_at, Operation.id).execution_options(populate_existing=True)
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        return (await self.db.scalars(query)).all()

    async def locked_running(self, job_id, token):
        return await self.db.scalar(select(Job).where(self.fence(job_id, token))
            .with_for_update().execution_options(populate_existing=True))

    async def prepare_operation(self, job_id, token, *, stage, step_key,
                                step_input_fingerprint, provider, model_version, usage=None):
        job = await self.locked_running(job_id, token)
        if job is None:
            return None
        previous = await self.operations(job_id, lock=True)
        matching = [op for op in previous if op.step_key == step_key]
        from app.services.karaoke_processing_review import ambiguous_operations
        if ambiguous_operations(matching):
            # Never erase the ledger and pretend the first request was not sent.
            return None
        operation = Operation(
            id=uuid4(), job_id=job_id, stage=stage, step_key=step_key,
            step_input_fingerprint=step_input_fingerprint,
            attempt=1 + max((op.attempt for op in matching), default=0),
            operation_key=uuid4(), provider=provider, model_version=model_version,
            pipeline_version=job.pipeline_version, lease_token=token,
            usage=deepcopy(usage or {}),
        )
        self.db.add(operation)
        await self.db.flush()
        return freeze(operation)

    async def operation_transition(self, job_id, token, operation_id, *, state,
                                   provider_request_id=None, usage=None,
                                   artifact_paths=None, result_digest=None):
        job = await self.locked_running(job_id, token)
        if job is None:
            return False
        operation = await self.db.scalar(select(Operation).where(
            Operation.id == operation_id, Operation.job_id == job_id,
            Operation.lease_token == token,
        ).with_for_update().execution_options(populate_existing=True))
        transitions = {
            "PREPARED": {"SUBMITTED", "FAILED", "UNKNOWN"},
            "SUBMITTED": {"COMPLETED", "FAILED", "UNKNOWN"},
        }
        if operation is None or state not in transitions.get(operation.state, set()):
            return False
        operation.state, operation.updated_at = state, utcnow()
        if provider_request_id is not None:
            operation.provider_request_id = provider_request_id
        if usage is not None:
            operation.usage = deepcopy(usage)
        if artifact_paths is not None:
            # Server-owned artifacts still must be in this song's namespace.
            from app.services.karaoke_storage_service import KaraokeStorage
            for path in artifact_paths:
                KaraokeStorage.validate_path(path, job.song_id)
            operation.artifact_paths = list(artifact_paths)
        if result_digest is not None:
            operation.result_digest = result_digest
        if state in {"COMPLETED", "FAILED"}:
            operation.completed_at = utcnow()
        await self.db.flush()
        return True

    async def finish(self, job_id, token, *, status, error=None, retry_policy="NONE", result=None):
        if status not in {"READY", "NEEDS_REVIEW", "FAILED"}:
            raise ValueError("Invalid processing completion")
        job = await self.locked_running(job_id, token)
        if job is None:
            return False
        if result:
            allowed = {"result_lyrics", "result_audio_path", "result_audio_sha256",
                       "result_audio_size_bytes", "result_duration_ms", "quality_report", "provenance"}
            if set(result) - allowed:
                raise ValueError("Unsupported processing result")
            for key, value in result.items():
                setattr(job, key, deepcopy(value))
        job.status, job.safe_error_code, job.retry_policy = status, error, retry_policy
        job.stage = "COMPLETE" if status != "FAILED" else job.stage
        job.updated_at = job.finished_at = utcnow()
        job.lease_token = job.lease_expires_at = None
        await self.db.flush()
        return True

    async def recover_expired(self, config, *, limit=20):
        from app.services.karaoke_processing_review import ambiguous_operations
        jobs = (await self.db.scalars(select(Job).where(
            Job.status == "RUNNING", Job.lease_expires_at <= func.now(),
            Job.pipeline_version == config.pipeline_version,
        ).order_by(Job.created_at, Job.id).limit(limit)
            .with_for_update(skip_locked=True).execution_options(populate_existing=True))).all()
        for job in jobs:
            ledger = await self.operations(job.id, lock=True)
            if not await self.actor_active(job.created_by):
                job.status, job.safe_error_code, job.retry_policy = "FAILED", "ACTOR_UNAVAILABLE", "NONE"
            elif ambiguous_operations(ledger):
                job.status = "FAILED"
                job.safe_error_code, job.retry_policy = "PROVIDER_OUTCOME_UNKNOWN", "EXPLICIT_COST_ACK"
            elif job.attempt_count < config.max_safe_attempts:
                job.status, job.stage, job.retry_policy = "QUEUED", "QUEUED", "SAFE_RETRY"
                job.safe_error_code = None
                job.next_attempt_at = utcnow()
            else:
                job.status, job.safe_error_code, job.retry_policy = "FAILED", "PROVIDER_TIMEOUT", "SAFE_RETRY"
            job.finished_at = None if job.status == "QUEUED" else utcnow()
            job.updated_at = utcnow()
            job.lease_token = job.lease_expires_at = None
        await self.db.flush()
        return len(jobs)

    async def references(self, path):
        source = await self.db.scalar(select(Job.id).where(or_(
            Job.input_audio_path == path, Job.input_reference_path == path, Job.result_audio_path == path,
        )).limit(1))
        if source:
            return True
        return bool(await self.db.scalar(select(Operation.id).where(
            Operation.artifact_paths.contains([path])).limit(1)))
