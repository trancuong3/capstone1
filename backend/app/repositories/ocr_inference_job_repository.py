from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import OcrInferenceJob, OcrWorkerHeartbeat

ACTIVE_JOB_STATUSES = ("QUEUED", "CLAIMED", "RUNNING", "FAILED_RETRYABLE")
CLAIMABLE_JOB_STATUSES = ("QUEUED", "FAILED_RETRYABLE")
INFLIGHT_JOB_STATUSES = ("CLAIMED", "RUNNING")


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

    async def claim_next_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int,
        now: datetime | None = None,
    ) -> OcrInferenceJob | None:
        ts = now or datetime.now(timezone.utc)
        await self.dead_letter_exhausted_expired_leases(now=ts)

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

    async def list_worker_heartbeats(self, *, limit: int = 20) -> list[OcrWorkerHeartbeat]:
        query = (
            select(OcrWorkerHeartbeat)
            .order_by(OcrWorkerHeartbeat.LastHeartbeatAt.desc(), OcrWorkerHeartbeat.WorkerId.asc())
            .limit(max(1, min(limit, 50)))
        )
        return list((await self.db.scalars(query)).all())

    async def queue_depth_counts(self, *, now: datetime | None = None) -> dict[str, Any]:
        ts = now or datetime.now(timezone.utc)
        rows = (
            await self.db.execute(
                select(OcrInferenceJob.Status, func.count(OcrInferenceJob.Id)).group_by(
                    OcrInferenceJob.Status
                )
            )
        ).all()
        counts: dict[str, Any] = {
            "queued": 0,
            "claimed": 0,
            "running": 0,
            "failed_retryable": 0,
            "dead_letter": 0,
            "succeeded": 0,
            "cancelled": 0,
            "expired_leases": 0,
        }
        for raw_status, count_val in rows:
            key = str(raw_status or "").lower()
            if key in counts:
                counts[key] = int(count_val or 0)
        expired_count = await self.db.scalar(
            select(func.count(OcrInferenceJob.Id)).where(
                OcrInferenceJob.Status.in_(INFLIGHT_JOB_STATUSES),
                OcrInferenceJob.LeaseExpiresAt.is_not(None),
                OcrInferenceJob.LeaseExpiresAt <= ts,
            )
        )
        oldest_pending_created = await self.db.scalar(
            select(func.min(OcrInferenceJob.CreatedAt)).where(
                OcrInferenceJob.Status.in_(("QUEUED", "FAILED_RETRYABLE", "CLAIMED", "RUNNING"))
            )
        )
        latest_succeeded_at = await self.db.scalar(
            select(func.max(OcrInferenceJob.CompletedAt)).where(
                OcrInferenceJob.Status == "SUCCEEDED"
            )
        )
        if oldest_pending_created is not None:
            if oldest_pending_created.tzinfo is None:
                oldest_pending_created = oldest_pending_created.replace(tzinfo=timezone.utc)
            oldest_age = round(max(0.0, (ts - oldest_pending_created).total_seconds()), 1)
        else:
            oldest_age = None
        if latest_succeeded_at is not None and latest_succeeded_at.tzinfo is None:
            latest_succeeded_at = latest_succeeded_at.replace(tzinfo=timezone.utc)
        counts["expired_leases"] = int(expired_count or 0)
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
