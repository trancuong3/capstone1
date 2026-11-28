from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import OcrInferenceJob, OcrWorkerHeartbeat

ACTIVE_JOB_STATUSES = ("QUEUED", "CLAIMED", "RUNNING", "FAILED_RETRYABLE")
CLAIMABLE_JOB_STATUSES = ("QUEUED", "FAILED_RETRYABLE")
INFLIGHT_JOB_STATUSES = ("CLAIMED", "RUNNING")
STARVATION_BOOST_AGE_SECONDS = 300
PRIORITY_STARVATION_BOOST = 5


class OcrInferenceJobRepository:
    """PostgreSQL persistence layer for remote OCR inference jobs and worker heartbeats."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get(self, job_id: UUID, *, lock: bool = False) -> OcrInferenceJob | None:
        query = select(OcrInferenceJob).where(OcrInferenceJob.Id == job_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def get_by_idempotency(
        self,
        job_kind: str,
        owner_user_id: UUID | None,
        idempotency_key: str,
        *,
        lock: bool = False,
    ) -> OcrInferenceJob | None:
        owner_filter = (
            OcrInferenceJob.OwnerUserId.is_(None)
            if owner_user_id is None
            else OcrInferenceJob.OwnerUserId == owner_user_id
        )
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.JobKind == job_kind,
                owner_filter,
                OcrInferenceJob.IdempotencyKey == idempotency_key,
                OcrInferenceJob.Status != "CANCELLED",
            )
            .order_by(OcrInferenceJob.CreatedAt.desc(), OcrInferenceJob.Id.desc())
            .limit(1)
        )
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def find_active_duplicate_job(
        self,
        *,
        job_kind: str,
        image_sha256: str,
        owner_user_id: UUID | None = None,
        page_id: UUID | None = None,
        submission_id: UUID | None = None,
    ) -> OcrInferenceJob | None:
        """Deduplicate concurrent active jobs for the same target + image digest when no idempotency key is set."""
        filters: list[Any] = [
            OcrInferenceJob.JobKind == job_kind,
            OcrInferenceJob.ImageSha256 == image_sha256,
            OcrInferenceJob.Status.in_(ACTIVE_JOB_STATUSES),
        ]
        if submission_id is not None:
            filters.append(OcrInferenceJob.SubmissionId == submission_id)
            if owner_user_id is not None:
                filters.append(OcrInferenceJob.OwnerUserId == owner_user_id)
        elif page_id is not None:
            filters.append(OcrInferenceJob.PageId == page_id)
            if owner_user_id is not None:
                filters.append(OcrInferenceJob.OwnerUserId == owner_user_id)
        elif owner_user_id is not None:
            filters.append(OcrInferenceJob.OwnerUserId == owner_user_id)
        else:
            return None
        query = (
            select(OcrInferenceJob)
            .where(*filters)
            .order_by(OcrInferenceJob.CreatedAt.desc(), OcrInferenceJob.Id.desc())
            .limit(1)
        )
        return await self.db.scalar(query)

    async def list_active_for_page(
        self, page_id: UUID, *, lock: bool = False
    ) -> list[OcrInferenceJob]:
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.PageId == page_id,
                OcrInferenceJob.Status.in_(ACTIVE_JOB_STATUSES),
            )
            .order_by(OcrInferenceJob.CreatedAt.asc(), OcrInferenceJob.Id.asc())
        )
        if lock:
            query = query.with_for_update()
        return list((await self.db.scalars(query)).all())

    async def list_active_for_submission(
        self, submission_id: UUID, *, lock: bool = False
    ) -> list[OcrInferenceJob]:
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.SubmissionId == submission_id,
                OcrInferenceJob.Status.in_(ACTIVE_JOB_STATUSES),
            )
            .order_by(OcrInferenceJob.CreatedAt.asc(), OcrInferenceJob.Id.asc())
        )
        if lock:
            query = query.with_for_update()
        return list((await self.db.scalars(query)).all())

    async def list_active_for_book(
        self, book_id: UUID, *, lock: bool = False
    ) -> list[OcrInferenceJob]:
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.BookId == book_id,
                OcrInferenceJob.Status.in_(ACTIVE_JOB_STATUSES),
            )
            .order_by(OcrInferenceJob.CreatedAt.asc(), OcrInferenceJob.Id.asc())
        )
        if lock:
            query = query.with_for_update()
        return list((await self.db.scalars(query)).all())

    async def latest_for_submission(self, submission_id: UUID) -> OcrInferenceJob | None:
        return await self.db.scalar(
            select(OcrInferenceJob)
            .where(OcrInferenceJob.SubmissionId == submission_id)
            .order_by(OcrInferenceJob.CreatedAt.desc(), OcrInferenceJob.Id.desc())
            .limit(1)
        )

    async def latest_for_page(self, page_id: UUID) -> OcrInferenceJob | None:
        return await self.db.scalar(
            select(OcrInferenceJob)
            .where(OcrInferenceJob.PageId == page_id)
            .order_by(OcrInferenceJob.CreatedAt.desc(), OcrInferenceJob.Id.desc())
            .limit(1)
        )

    async def list_for_book(self, book_id: UUID, *, limit: int = 200) -> list[OcrInferenceJob]:
        query = (
            select(OcrInferenceJob)
            .where(OcrInferenceJob.BookId == book_id)
            .order_by(OcrInferenceJob.CreatedAt.desc(), OcrInferenceJob.Id.desc())
            .limit(max(1, min(limit, 500)))
        )
        return list((await self.db.scalars(query)).all())

    async def list_for_page(self, page_id: UUID, *, limit: int = 50) -> list[OcrInferenceJob]:
        query = (
            select(OcrInferenceJob)
            .where(OcrInferenceJob.PageId == page_id)
            .order_by(OcrInferenceJob.CreatedAt.desc(), OcrInferenceJob.Id.desc())
            .limit(max(1, min(limit, 200)))
        )
        return list((await self.db.scalars(query)).all())

    async def list_local_scans_for_owner(
        self,
        owner_user_id: UUID,
        *,
        active_only: bool = True,
        limit: int = 10,
    ) -> list[OcrInferenceJob]:
        """List owner-scoped parent quick-scan OCR jobs (active queue or recent history)."""
        filters: list[Any] = [
            OcrInferenceJob.JobKind == "LOCAL_PAGE_SCAN",
            OcrInferenceJob.OwnerUserId == owner_user_id,
        ]
        if active_only:
            filters.append(OcrInferenceJob.Status.in_(ACTIVE_JOB_STATUSES))
        else:
            filters.append(OcrInferenceJob.Status != "CANCELLED")
        query = (
            select(OcrInferenceJob)
            .where(*filters)
            .order_by(OcrInferenceJob.CreatedAt.desc(), OcrInferenceJob.Id.desc())
            .limit(max(1, min(int(limit), 50)))
        )
        return list((await self.db.scalars(query)).all())

    async def get_queue_positions(self, job_ids: list[UUID]) -> dict[UUID, int]:
        """Return 1-based queue position for claimable OCR jobs in scheduling order."""
        if not job_ids:
            return {}
        target_set = set(job_ids)
        query = (
            select(OcrInferenceJob)
            .where(OcrInferenceJob.Status.in_(CLAIMABLE_JOB_STATUSES))
            .order_by(
                OcrInferenceJob.Priority.asc(),
                OcrInferenceJob.CreatedAt.asc(),
                OcrInferenceJob.Id.asc(),
            )
            .limit(500)
        )
        rows = list((await self.db.scalars(query)).all())
        positions: dict[UUID, int] = {}
        for idx, row in enumerate(rows, start=1):
            if row.Id in target_set:
                positions[row.Id] = idx
                if len(positions) == len(target_set):
                    break
        return positions

    async def create_job(self, job: OcrInferenceJob) -> OcrInferenceJob:
        self.db.add(job)
        await self.db.flush()
        return job

    def _cancel_rows(
        self,
        rows: list[OcrInferenceJob],
        *,
        reason: str,
        exclude_job_id: UUID | None,
        now: datetime,
    ) -> int:
        cancelled = 0
        for row in rows:
            if exclude_job_id is not None and row.Id == exclude_job_id:
                continue
            row.Status = "CANCELLED"
            row.CancelledReason = reason
            row.LeaseExpiresAt = None
            row.CompletedAt = now
            row.UpdatedAt = now
            cancelled += 1
        return cancelled

    async def cancel_open_for_page(
        self,
        page_id: UUID,
        *,
        reason: str,
        exclude_job_id: UUID | None = None,
        now: datetime | None = None,
    ) -> int:
        ts = now or datetime.now(timezone.utc)
        rows = await self.list_active_for_page(page_id, lock=True)
        return self._cancel_rows(rows, reason=reason, exclude_job_id=exclude_job_id, now=ts)

    async def cancel_open_for_submission(
        self,
        submission_id: UUID,
        *,
        reason: str,
        exclude_job_id: UUID | None = None,
        now: datetime | None = None,
    ) -> int:
        ts = now or datetime.now(timezone.utc)
        rows = await self.list_active_for_submission(submission_id, lock=True)
        return self._cancel_rows(rows, reason=reason, exclude_job_id=exclude_job_id, now=ts)

    async def cancel_open_for_book(
        self,
        book_id: UUID,
        *,
        reason: str,
        now: datetime | None = None,
    ) -> int:
        ts = now or datetime.now(timezone.utc)
        rows = await self.list_active_for_book(book_id, lock=True)
        return self._cancel_rows(rows, reason=reason, exclude_job_id=None, now=ts)

    async def reclaim_expired_leases(
        self,
        *,
        now: datetime | None = None,
        retry_delay_seconds: int = 0,
    ) -> tuple[list[OcrInferenceJob], list[OcrInferenceJob]]:
        """Reclaim expired in-flight leases: requeue retryable attempts and dead-letter exhausted ones."""
        ts = now or datetime.now(timezone.utc)
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.Status.in_(INFLIGHT_JOB_STATUSES),
                OcrInferenceJob.LeaseExpiresAt.is_not(None),
                OcrInferenceJob.LeaseExpiresAt <= ts,
            )
            .with_for_update(skip_locked=True)
        )
        rows = list((await self.db.scalars(query)).all())
        reclaimed: list[OcrInferenceJob] = []
        dead_lettered: list[OcrInferenceJob] = []
        for row in rows:
            if int(row.AttemptCount or 0) >= int(row.MaxAttempts or 3):
                row.Status = "DEAD_LETTER"
                row.ErrorCode = row.ErrorCode or "LEASE_EXPIRED_MAX_ATTEMPTS"
                row.ErrorMessage = row.ErrorMessage or "Worker lease expired after maximum attempts."
                row.LeaseExpiresAt = None
                row.CompletedAt = ts
                row.UpdatedAt = ts
                dead_lettered.append(row)
            else:
                delay = max(0, int(retry_delay_seconds))
                row.Status = "FAILED_RETRYABLE"
                row.ErrorCode = row.ErrorCode or "LEASE_EXPIRED_RECLAIMED"
                row.ErrorMessage = row.ErrorMessage or "Worker lease expired; reclaimed for retry."
                row.WorkerId = None
                row.LeaseExpiresAt = None
                row.RetryDelaySeconds = delay or None
                row.NextRetryAt = ts + timedelta(seconds=delay) if delay > 0 else ts
                row.UpdatedAt = ts
                reclaimed.append(row)
        return reclaimed, dead_lettered

    async def dead_letter_exhausted_expired_leases(
        self, *, now: datetime | None = None
    ) -> list[OcrInferenceJob]:
        ts = now or datetime.now(timezone.utc)
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.Status.in_(INFLIGHT_JOB_STATUSES),
                OcrInferenceJob.LeaseExpiresAt.is_not(None),
                OcrInferenceJob.LeaseExpiresAt <= ts,
                OcrInferenceJob.AttemptCount >= OcrInferenceJob.MaxAttempts,
            )
            .with_for_update(skip_locked=True)
        )
        rows = list((await self.db.scalars(query)).all())
        for row in rows:
            row.Status = "DEAD_LETTER"
            row.ErrorCode = row.ErrorCode or "LEASE_EXPIRED_MAX_ATTEMPTS"
            row.ErrorMessage = row.ErrorMessage or "Worker lease expired after maximum attempts."
            row.LeaseExpiresAt = None
            row.CompletedAt = ts
            row.UpdatedAt = ts
        return rows

    async def boost_aged_waiting_jobs(
        self,
        *,
        now: datetime | None = None,
        starvation_age_seconds: int = STARVATION_BOOST_AGE_SECONDS,
        boosted_priority: int = PRIORITY_STARVATION_BOOST,
    ) -> int:
        """Promote jobs waiting longer than threshold so lower-priority parent submissions never starve."""
        ts = now or datetime.now(timezone.utc)
        cutoff = ts - timedelta(seconds=max(60, int(starvation_age_seconds)))
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.Status.in_(CLAIMABLE_JOB_STATUSES),
                OcrInferenceJob.Priority > boosted_priority,
                OcrInferenceJob.CreatedAt <= cutoff,
            )
            .order_by(OcrInferenceJob.CreatedAt.asc())
            .limit(20)
            .with_for_update(skip_locked=True)
        )
        rows = list((await self.db.scalars(query)).all())
        boosted = 0
        for row in rows:
            if row.Status == "FAILED_RETRYABLE" and row.NextRetryAt is not None and row.NextRetryAt > ts:
                continue
            row.Priority = boosted_priority
            row.UpdatedAt = ts
            boosted += 1
        return boosted

    async def claim_next_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int,
        now: datetime | None = None,
    ) -> OcrInferenceJob | None:
        ts = now or datetime.now(timezone.utc)
        await self.boost_aged_waiting_jobs(now=ts)

        queued_due = and_(
            OcrInferenceJob.Status == "QUEUED",
            OcrInferenceJob.AttemptCount < OcrInferenceJob.MaxAttempts,
        )
        retry_due = and_(
            OcrInferenceJob.Status == "FAILED_RETRYABLE",
            OcrInferenceJob.AttemptCount < OcrInferenceJob.MaxAttempts,
            or_(OcrInferenceJob.NextRetryAt.is_(None), OcrInferenceJob.NextRetryAt <= ts),
        )
        expired_lease = and_(
            OcrInferenceJob.Status.in_(INFLIGHT_JOB_STATUSES),
            OcrInferenceJob.LeaseExpiresAt.is_not(None),
            OcrInferenceJob.LeaseExpiresAt <= ts,
            OcrInferenceJob.AttemptCount < OcrInferenceJob.MaxAttempts,
        )

        query = (
            select(OcrInferenceJob)
            .where(or_(queued_due, retry_due, expired_lease))
            .order_by(
                OcrInferenceJob.Priority.asc(),
                OcrInferenceJob.CreatedAt.asc(),
                OcrInferenceJob.Id.asc(),
            )
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        row = await self.db.scalar(query)
        if row is None:
            return None

        row.Status = "CLAIMED"
        row.WorkerId = worker_id
        row.FencingToken = int(row.FencingToken or 0) + 1
        row.AttemptCount = int(row.AttemptCount or 0) + 1
        row.ClaimedAt = ts
        row.HeartbeatAt = ts
        row.LeaseExpiresAt = ts + timedelta(seconds=lease_seconds)
        row.NextRetryAt = None
        row.RetryDelaySeconds = None
        row.UpdatedAt = ts
        return row

    async def upsert_worker_heartbeat(
        self,
        *,
        worker_id: str,
        hostname: str | None,
        app_version: str | None,
        git_sha: str | None,
        status: str,
        active_job_id: UUID | None,
        active_job_count: int,
        concurrency_limit: int,
        model_profile: str | None,
        model_sha256: str | None,
        engines: dict[str, Any],
        system_stats: dict[str, Any],
        last_error: str | None,
        now: datetime | None = None,
    ) -> OcrWorkerHeartbeat:
        ts = now or datetime.now(timezone.utc)
        existing = await self.db.scalar(
            select(OcrWorkerHeartbeat).where(OcrWorkerHeartbeat.WorkerId == worker_id)
        )
        if existing is None:
            existing = OcrWorkerHeartbeat(
                WorkerId=worker_id,
                CreatedAt=ts,
            )
            self.db.add(existing)
        existing.Hostname = hostname
        existing.AppVersion = app_version
        existing.GitSha = git_sha
        existing.Status = status
        existing.ActiveJobId = active_job_id
        existing.ActiveJobCount = max(0, int(active_job_count))
        existing.ConcurrencyLimit = max(1, int(concurrency_limit))
        existing.ModelProfile = model_profile
        existing.ModelSha256 = model_sha256
        existing.Engines = dict(engines or {})
        existing.SystemStats = dict(system_stats or {})
        existing.LastError = last_error
        existing.LastHeartbeatAt = ts
        existing.UpdatedAt = ts
        await self.db.flush()
        return existing

    async def touch_worker_heartbeat(
        self,
        *,
        worker_id: str,
        status: str,
        active_job_id: UUID | None,
        active_job_count: int,
        now: datetime | None = None,
    ) -> OcrWorkerHeartbeat:
        """Refresh worker liveness and active-job fields without wiping engine/model metadata."""
        ts = now or datetime.now(timezone.utc)
        existing = await self.db.scalar(
            select(OcrWorkerHeartbeat).where(OcrWorkerHeartbeat.WorkerId == worker_id)
        )
        if existing is None:
            existing = OcrWorkerHeartbeat(
                WorkerId=worker_id,
                ConcurrencyLimit=1,
                Engines={},
                SystemStats={},
                CreatedAt=ts,
            )
            self.db.add(existing)
        existing.Status = status
        existing.ActiveJobId = active_job_id
        existing.ActiveJobCount = max(0, int(active_job_count))
        existing.LastHeartbeatAt = ts
        existing.UpdatedAt = ts
        await self.db.flush()
        return existing

    async def list_worker_heartbeats(
        self,
        *,
        limit: int = 20,
        max_age_hours: int | None = 24,
        now: datetime | None = None,
    ) -> list[OcrWorkerHeartbeat]:
        query = select(OcrWorkerHeartbeat)
        if max_age_hours is not None and max_age_hours > 0:
            ts = now or datetime.now(timezone.utc)
            cutoff = ts - timedelta(hours=int(max_age_hours))
            query = query.where(OcrWorkerHeartbeat.LastHeartbeatAt >= cutoff)
        query = (
            query.order_by(
                OcrWorkerHeartbeat.LastHeartbeatAt.desc(),
                OcrWorkerHeartbeat.WorkerId.asc(),
            )
            .limit(max(1, min(limit, 50)))
        )
        return list((await self.db.scalars(query)).all())

    async def prune_stale_worker_heartbeats(
        self,
        *,
        max_age_hours: int = 24,
        now: datetime | None = None,
    ) -> int:
        ts = now or datetime.now(timezone.utc)
        cutoff = ts - timedelta(hours=max(1, int(max_age_hours)))
        query = select(OcrWorkerHeartbeat).where(
            OcrWorkerHeartbeat.LastHeartbeatAt < cutoff
        )
        stale_rows = list((await self.db.scalars(query)).all())
        for row in stale_rows:
            await self.db.delete(row)
        return len(stale_rows)

    async def queue_depth_counts(self, *, now: datetime | None = None) -> dict[str, Any]:
        ts = now or datetime.now(timezone.utc)
        # Consolidate status breakdown, expired leases, oldest pending age, and
        # latest success timestamp into 1 SQL round-trip for low-latency /health.
        row = (
            await self.db.execute(
                select(
                    func.sum(case((OcrInferenceJob.Status == "QUEUED", 1), else_=0)).label("queued"),
                    func.sum(case((OcrInferenceJob.Status == "CLAIMED", 1), else_=0)).label("claimed"),
                    func.sum(case((OcrInferenceJob.Status == "RUNNING", 1), else_=0)).label("running"),
                    func.sum(
                        case((OcrInferenceJob.Status == "FAILED_RETRYABLE", 1), else_=0)
                    ).label("failed_retryable"),
                    func.sum(
                        case((OcrInferenceJob.Status == "DEAD_LETTER", 1), else_=0)
                    ).label("dead_letter"),
                    func.sum(
                        case((OcrInferenceJob.Status == "SUCCEEDED", 1), else_=0)
                    ).label("succeeded"),
                    func.sum(
                        case((OcrInferenceJob.Status == "CANCELLED", 1), else_=0)
                    ).label("cancelled"),
                    func.sum(
                        case(
                            (
                                and_(
                                    OcrInferenceJob.Status.in_(INFLIGHT_JOB_STATUSES),
                                    OcrInferenceJob.LeaseExpiresAt.is_not(None),
                                    OcrInferenceJob.LeaseExpiresAt <= ts,
                                ),
                                1,
                            ),
                            else_=0,
                        )
                    ).label("expired_leases"),
                    func.min(
                        case(
                            (
                                OcrInferenceJob.Status.in_(
                                    ("QUEUED", "FAILED_RETRYABLE", "CLAIMED", "RUNNING")
                                ),
                                OcrInferenceJob.CreatedAt,
                            ),
                            else_=None,
                        )
                    ).label("oldest_pending_created"),
                    func.max(
                        case(
                            (OcrInferenceJob.Status == "SUCCEEDED", OcrInferenceJob.CompletedAt),
                            else_=None,
                        )
                    ).label("latest_succeeded_at"),
                )
            )
        ).one()
        counts: dict[str, Any] = {
            "queued": int(row.queued or 0),
            "claimed": int(row.claimed or 0),
            "running": int(row.running or 0),
            "failed_retryable": int(row.failed_retryable or 0),
            "dead_letter": int(row.dead_letter or 0),
            "succeeded": int(row.succeeded or 0),
            "cancelled": int(row.cancelled or 0),
            "expired_leases": int(row.expired_leases or 0),
        }
        oldest_pending_created = row.oldest_pending_created
        latest_succeeded_at = row.latest_succeeded_at
        if oldest_pending_created is not None:
            if oldest_pending_created.tzinfo is None:
                oldest_pending_created = oldest_pending_created.replace(tzinfo=timezone.utc)
            oldest_age = round(max(0.0, (ts - oldest_pending_created).total_seconds()), 1)
        else:
            oldest_age = None
        if latest_succeeded_at is not None and latest_succeeded_at.tzinfo is None:
            latest_succeeded_at = latest_succeeded_at.replace(tzinfo=timezone.utc)
        counts["pending_total"] = counts["queued"] + counts["failed_retryable"]
        counts["active_total"] = counts["claimed"] + counts["running"]
        counts["oldest_pending_job_age_seconds"] = oldest_age
        counts["latest_succeeded_at"] = (
            latest_succeeded_at.isoformat() if latest_succeeded_at is not None else None
        )
        return counts

    async def get_active_model_pointer(self) -> dict[str, Any] | None:
        try:
            row = (
                await self.db.execute(
                    text(
                        "SELECT model_family, checkpoint_sha256, storage_path, profile, updated_at "
                        "FROM public.viread_ocr_active_model WHERE singleton = TRUE LIMIT 1"
                    )
                )
            ).mappings().first()
            return dict(row) if row is not None else None
        except Exception:
            return None

    async def find_completed_cached_job(
        self,
        *,
        job_kind: str,
        owner_user_id: UUID | None,
        image_sha256: str,
        active_model_profile: str | None,
        active_model_sha256: str | None,
        active_config_sha256: str | None,
        pipeline_version: str,
        admin_job_kinds: tuple[str, ...],
        user_job_kinds: tuple[str, ...],
    ) -> OcrInferenceJob | None:
        """Tenant-safe SHA-256 completed OCR cache lookup keyed by model/config/pipeline."""
        filters: list[Any] = [
            OcrInferenceJob.Status == "SUCCEEDED",
            OcrInferenceJob.ImageSha256 == image_sha256,
            OcrInferenceJob.ResultPayload.is_not(None),
        ]
        if job_kind in user_job_kinds:
            if owner_user_id is None:
                return None
            filters.append(OcrInferenceJob.OwnerUserId == owner_user_id)
            filters.append(OcrInferenceJob.JobKind.in_(user_job_kinds))
        else:
            filters.append(OcrInferenceJob.JobKind.in_(admin_job_kinds))
        if active_model_profile:
            filters.append(OcrInferenceJob.ModelProfile == active_model_profile)
        if active_model_sha256:
            filters.append(OcrInferenceJob.ModelSha256 == active_model_sha256)

        candidates = list(
            (
                await self.db.scalars(
                    select(OcrInferenceJob)
                    .where(*filters)
                    .order_by(OcrInferenceJob.CompletedAt.desc(), OcrInferenceJob.CreatedAt.desc())
                    .limit(20)
                )
            ).all()
        )
        for candidate in candidates:
            payload = candidate.ResultPayload if isinstance(candidate.ResultPayload, dict) else None
            if not payload or "words" not in payload:
                continue
            cache_meta = payload.get("cache_key") if isinstance(payload.get("cache_key"), dict) else {}
            proc_meta = candidate.ProcessingMeta if isinstance(candidate.ProcessingMeta, dict) else {}
            cand_profile = cache_meta.get("active_model_profile") or candidate.ModelProfile
            cand_sha = cache_meta.get("active_model_sha256") or candidate.ModelSha256
            cand_cfg = cache_meta.get("active_config_sha256") if "active_config_sha256" in cache_meta else proc_meta.get("active_config_sha256")
            cand_pipe = cache_meta.get("pipeline_version") or proc_meta.get("pipeline_version")
            if (
                cand_profile == active_model_profile
                and cand_sha == active_model_sha256
                and cand_cfg == active_config_sha256
                and cand_pipe == pipeline_version
            ):
                return candidate
        return None
