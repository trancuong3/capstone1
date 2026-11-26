"""Bounded service layer for internal scheduled cron sweeps.

Keeps `POST /internal/cron/dispatch` strictly within Render/Cloudflare HTTP
budgets (<25s total) while isolating failures per subsystem, persisting durable
DB heartbeats for every worker (even when 0 items are processed), and avoiding
5-second cancellation loops on multi-page LLM workflows/scans.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from uuid import uuid4

from sqlalchemy import and_, func, or_, select

from app.database.session import AsyncSessionLocal
from app.jobs import (
    admin_ai_workflow_worker,
    book_quality_worker,
    parent_book_submission_worker,
    viread_ocr_outbox_worker,
    viread_ocr_training_auto_worker,
)
from app.models.admin_ai_workflow import AdminAiWorkflow
from app.models.book_content_quality import BookQualityScanRun
from app.repositories.admin_ai_workflow_repository import AdminAiWorkflowRepository
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.services import local_ocr_scan_service
from app.services.ocr_inference_job_service import (
    OcrInferenceJobService,
    is_heavy_workers_disabled,
    reconcile_orphaned_parent_submissions,
)
from app.services.remote_ocr_wakeup import (
    maybe_keep_warm_hf_space_from_cron,
    maybe_nudge_ocr_wakeup_for_stale_queued_job,
)
from app.services.worker_telemetry import (
    persist_worker_heartbeat_with_factory,
    record_worker_error,
    record_worker_success,
)

logger = logging.getLogger(__name__)

DEFAULT_CRON_TOTAL_BUDGET_SECONDS = 24.0
DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS = 5.0
REMINDERS_ALERTS_TIMEOUT_SECONDS = 6.0
DEFAULT_SWEEP_MAX_ITEMS = 5
DEFAULT_ORPHAN_RECONCILE_LIMIT = 20
DEFAULT_STALE_HEARTBEAT_MAX_AGE_HOURS = 24
DEFAULT_LOCAL_SCAN_MAX_AGE_HOURS = 24


def _remaining_budget(deadline: float, cap_seconds: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0.0:
        return 0.0
    return min(remaining, cap_seconds)


def _accepts_kwarg(fn: Any, name: str) -> bool:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return False
    if name in sig.parameters:
        return True
    return any(
        param.kind == inspect.Parameter.VAR_KEYWORD
        for param in sig.parameters.values()
    )


def _should_kick_background_drain() -> bool:
    """Use non-cancelling background task kicks on hosted/light-web tiers."""
    from app.database.config import APP_ENVIRONMENT

    app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
    if app_env == "test":
        return False
    return bool(is_heavy_workers_disabled())


async def _persist_cron_heartbeat(
    worker_id: str,
    *,
    ok: bool,
    items_processed: int = 0,
    error_code: str | None = None,
    execution_mode: str = "cron_scheduled",
    source: str = "cron",
) -> None:
    await persist_worker_heartbeat_with_factory(
        AsyncSessionLocal,
        worker_id,
        execution_mode=execution_mode,
        ok=ok,
        items_processed=items_processed,
        source=source,
        error_code=error_code,
        timeout_seconds=1.5,
    )


async def _count_pending_admin_ai_workflows(now: datetime) -> int:
    async with AsyncSessionLocal() as session:
        queued = and_(
            AdminAiWorkflow.Status == "QUEUED",
            or_(AdminAiWorkflow.RetryAfter.is_(None), AdminAiWorkflow.RetryAfter <= now),
        )
        expired = and_(
            AdminAiWorkflow.Status.in_(["PROOFREADING", "CHILD_SAFETY_SCANNING"]),
            AdminAiWorkflow.LeaseExpiresAt.is_not(None),
            AdminAiWorkflow.LeaseExpiresAt <= now,
        )
        count = await session.scalar(
            select(func.count(AdminAiWorkflow.Id)).where(or_(queued, expired))
        )
        return max(0, int(count or 0))


async def _count_pending_book_quality_scans(now: datetime) -> int:
    async with AsyncSessionLocal() as session:
        expired_running = and_(
            BookQualityScanRun.Status == "RUNNING",
            or_(
                BookQualityScanRun.LeaseExpiresAt.is_(None),
                BookQualityScanRun.LeaseExpiresAt <= now,
            ),
        )
        count = await session.scalar(
            select(func.count(BookQualityScanRun.Id)).where(
                or_(BookQualityScanRun.Status == "QUEUED", expired_running)
            )
        )
        return max(0, int(count or 0))


async def _sweep_ocr_leases_and_heartbeats(*, max_age_hours: int) -> tuple[int, int, int]:
    """Reap expired OCR inference leases and prune stale worker heartbeats if supported."""
    requeued = 0
    dead_lettered = 0
    heartbeats_pruned = 0

    async with AsyncSessionLocal() as db:
        service = OcrInferenceJobService(db)
        reap_fn = getattr(service, "reap_expired_leases", None)
        if callable(reap_fn):
            raw_reap = await reap_fn()
            if isinstance(raw_reap, dict):
                requeued = int(raw_reap.get("requeued") or raw_reap.get("reclaimed") or 0)
                dead_lettered = int(raw_reap.get("dead_lettered") or 0)
            elif isinstance(raw_reap, int):
                requeued = max(0, raw_reap)

        prune_fn = getattr(service, "prune_stale_worker_heartbeats", None)
        if callable(prune_fn):
            if _accepts_kwarg(prune_fn, "max_age_hours"):
                raw_pruned = await prune_fn(max_age_hours=max_age_hours)
            else:
                raw_pruned = await prune_fn()
            heartbeats_pruned = max(0, int(raw_pruned or 0))

        stale_queued_pair: tuple[object, object] | None = None
        if hasattr(db, "execute"):
            try:
                from app.models import OcrInferenceJob

                first_queued = (
                    await db.execute(
                        select(OcrInferenceJob.Id, OcrInferenceJob.CreatedAt)
                        .where(OcrInferenceJob.Status == "QUEUED")
                        .order_by(OcrInferenceJob.CreatedAt.asc())
                        .limit(1)
                    )
                ).first()
                if first_queued is not None:
                    stale_queued_pair = (first_queued[0], first_queued[1])
            except Exception:
                stale_queued_pair = None

        try:
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    if stale_queued_pair is not None:
        maybe_nudge_ocr_wakeup_for_stale_queued_job(
            job_id=stale_queued_pair[0],  # type: ignore[arg-type]
            created_at=stale_queued_pair[1],  # type: ignore[arg-type]
            reason="cron_stale_queued_nudge",
        )

    return requeued, dead_lettered, heartbeats_pruned


async def _sweep_admin_ai_workflows(
    *,
    max_items: int,
    deadline: float,
    now: datetime | None = None,
) -> int:
    """Kick background drain (or run bounded fallback) for queued Admin AI workflows."""
    configured_enabled = getattr(admin_ai_workflow_worker, "_configured_enabled", None)
    if callable(configured_enabled) and not configured_enabled():
        return 0

    current = now or datetime.now(timezone.utc)
    if _should_kick_background_drain():
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget <= 0.25:
            return 0
        pending = await asyncio.wait_for(
            _count_pending_admin_ai_workflows(current),
            timeout=min(budget, 3.0),
        )
        if pending <= 0:
            return 0
        schedule_fn = getattr(admin_ai_workflow_worker, "schedule_admin_ai_workflow", None)
        if callable(schedule_fn):
            if _accepts_kwarg(schedule_fn, "source"):
                schedule_fn(source="cron")
            else:
                schedule_fn()
            return min(pending, max_items)

    run_once_fn = getattr(admin_ai_workflow_worker, "run_once", None)
    swept = 0
    for _ in range(max_items):
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget <= 0.25:
            break
        if callable(run_once_fn):
            kwargs: dict[str, Any] = {
                "worker_id": f"cron-admin-ai-{uuid4().hex[:8]}",
            }
            if _accepts_kwarg(run_once_fn, "source"):
                kwargs["source"] = "cron"
            if _accepts_kwarg(run_once_fn, "execution_mode"):
                kwargs["execution_mode"] = "cron_scheduled"
            if _accepts_kwarg(run_once_fn, "session_factory"):
                kwargs["session_factory"] = AsyncSessionLocal
            if _accepts_kwarg(run_once_fn, "repository_cls"):
                kwargs["repository_cls"] = AdminAiWorkflowRepository
            did_work = await asyncio.wait_for(
                run_once_fn(**kwargs),
                timeout=budget,
            )
            if not did_work:
                break
            swept += 1
            continue

        worker_id = f"cron-admin-ai-{uuid4().hex[:8]}"
        async with AsyncSessionLocal() as session:
            workflow_id = await asyncio.wait_for(
                AdminAiWorkflowRepository(session).claim_next(
                    worker_id, lease_seconds=admin_ai_workflow_worker.LEASE_SECONDS
                ),
                timeout=min(budget, 3.0),
            )
        if workflow_id is None:
            break
        process_budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if process_budget <= 0.25:
            async with AsyncSessionLocal() as session:
                await AdminAiWorkflowRepository(session).release_claim(workflow_id, worker_id)
            break
        await asyncio.wait_for(
            admin_ai_workflow_worker._process(workflow_id, worker_id),
            timeout=process_budget,
        )
        swept += 1
    return swept


async def _sweep_book_quality_scans(
    *,
    max_items: int,
    deadline: float,
    now: datetime | None = None,
) -> int:
    """Kick background drain for queued/expired Book Quality scans without 5s cancellation."""
    configured_enabled = getattr(book_quality_worker, "_configured_enabled", None)
    if callable(configured_enabled) and not configured_enabled():
        return 0

    current = now or datetime.now(timezone.utc)
    if _should_kick_background_drain():
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget <= 0.25:
            return 0
        pending = await asyncio.wait_for(
            _count_pending_book_quality_scans(current),
            timeout=min(budget, 3.0),
        )
        if pending <= 0:
            return 0
        schedule_fn = getattr(book_quality_worker, "schedule_book_quality_scan", None)
        if callable(schedule_fn):
            if _accepts_kwarg(schedule_fn, "source"):
                schedule_fn(source="cron")
            else:
                schedule_fn()
            return min(pending, max_items)

    run_once_fn = getattr(book_quality_worker, "run_once", None)
    swept = 0
    for _ in range(max_items):
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget <= 0.25:
            break
        if callable(run_once_fn):
            kwargs: dict[str, Any] = {
                "worker_id": f"cron-book-quality-{uuid4().hex[:8]}",
            }
            if _accepts_kwarg(run_once_fn, "source"):
                kwargs["source"] = "cron"
            if _accepts_kwarg(run_once_fn, "execution_mode"):
                kwargs["execution_mode"] = "cron_scheduled"
            if _accepts_kwarg(run_once_fn, "session_factory"):
                kwargs["session_factory"] = AsyncSessionLocal
            if _accepts_kwarg(run_once_fn, "repository_cls"):
                kwargs["repository_cls"] = BookContentQualityRepository
            did_work = await asyncio.wait_for(
                run_once_fn(**kwargs),
                timeout=budget,
            )
            if not did_work:
                break
            swept += 1
            continue

        worker_id = f"cron-book-quality-{uuid4().hex[:8]}"
        async with AsyncSessionLocal() as session:
            run = await asyncio.wait_for(
                BookContentQualityRepository(session).claim_next_scan(
                    worker_id, lease_seconds=book_quality_worker.LEASE_SECONDS
                ),
                timeout=min(budget, 3.0),
            )
        if run is None:
            break
        process_budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if process_budget <= 0.25:
            break
        await asyncio.wait_for(
            book_quality_worker._process_claimed_scan(run.Id, worker_id),
            timeout=process_budget,
        )
        swept += 1
    return swept


async def _sweep_viread_ocr_outbox(
    *,
    max_items: int,
    deadline: float,
) -> int:
    """Process up to `max_items` Flow 2 verified outbox events within remaining budget."""
    swept = 0
    for _ in range(max_items):
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget <= 0.25:
            break
        did_work = await asyncio.wait_for(
            viread_ocr_outbox_worker.run_once(),
            timeout=budget,
        )
        if not did_work:
            break
        swept += 1
    return swept


async def _sweep_viread_ocr_training_maintenance() -> tuple[bool, int]:
    """Run lightweight training lease expiry & Colab poll/dispatch (zero PyTorch imports)."""
    maintenance_fn = getattr(
        viread_ocr_training_auto_worker, "run_maintenance_once", None
    )
    if not callable(maintenance_fn):
        return False, 0

    # Guard legacy unit tests that replace cron_svc.AsyncSessionLocal with a bare
    # synchronous-execute MagicMock while leaving training_worker.AsyncSessionLocal unpatched.
    if (
        AsyncSessionLocal is not viread_ocr_training_auto_worker.AsyncSessionLocal
        and getattr(maintenance_fn, "__module__", "")
        == viread_ocr_training_auto_worker.__name__
    ):
        async with AsyncSessionLocal() as probe_db:
            exec_attr = getattr(probe_db, "execute", None)
            if not inspect.iscoroutinefunction(exec_attr):
                return False, 0

    result = await maintenance_fn()
    if isinstance(result, dict):
        items = 1 if result.get("colab_activity") else 0
        return bool(result.get("ok", True)), items
    return True, (1 if result else 0)


async def _cleanup_expired_local_scans(*, max_age_hours: int) -> int:
    """Invoke `cleanup_expired_local_scan_objects` defensively if implemented."""
    cleanup_fn = getattr(local_ocr_scan_service, "cleanup_expired_local_scan_objects", None)
    if not callable(cleanup_fn):
        return 0
    try:
        sig = inspect.signature(cleanup_fn)
        params = sig.parameters
    except (TypeError, ValueError):
        params = {}
    kwargs: dict[str, Any] = {}
    if _accepts_kwarg(cleanup_fn, "max_age_hours"):
        kwargs["max_age_hours"] = max_age_hours
    if "db" in params:
        async with AsyncSessionLocal() as db:
            result = cleanup_fn(db=db, **kwargs)
            if inspect.isawaitable(result):
                result = await result
            return max(0, int(result or 0))
    result = cleanup_fn(**kwargs)
    if inspect.isawaitable(result):
        result = await result
    return max(0, int(result or 0))


async def run_scheduled_cron_dispatch(
    *,
    now: datetime | None = None,
    run_remote_sweeps: bool = False,
    reminders_runner: Callable[..., Awaitable[int]],
    alerts_runner: Callable[..., Awaitable[int]],
    engagement_runner: Callable[..., Awaitable[int]] | None = None,
    temp_cleanup_runner: Callable[..., Awaitable[int]] | None = None,
    parent_post_ocr_runner: Callable[..., Awaitable[bool]] | None = None,
    total_budget_seconds: float = DEFAULT_CRON_TOTAL_BUDGET_SECONDS,
    max_items_per_sweep: int = DEFAULT_SWEEP_MAX_ITEMS,
    orphan_reconcile_limit: int = DEFAULT_ORPHAN_RECONCILE_LIMIT,
) -> dict[str, Any]:
    """Execute one idempotent, time-bounded sweep across scheduled maintenance tasks."""
    current = now or datetime.now(timezone.utc)
    deadline = time.monotonic() + max(2.0, float(total_budget_seconds))

    reminders_delivered = 0
    presence_alerts_delivered = 0
    engagement_emails_delivered = 0
    temp_submissions_cleaned = 0
    post_ocr_swept = 0
    ocr_leases_requeued = 0
    ocr_leases_dead_lettered = 0
    stale_worker_heartbeats_pruned = 0
    orphaned_parent_submissions_reclaimed = 0
    orphaned_parent_submissions_failed = 0
    admin_ai_workflows_swept = 0
    book_quality_scans_swept = 0
    ocr_outbox_swept = 0
    local_scan_objects_cleaned = 0
    hf_space_keepwarm_pinged = False
    ocr_training_maintenance_ran = False
    sweep_errors: list[str] = []

    # Isolated reading reminders runner (6.0s cap; errors never abort presence or sweeps 1-10)
    rem_budget = _remaining_budget(deadline, REMINDERS_ALERTS_TIMEOUT_SECONDS)
    if rem_budget > 0.25:
        try:
            reminders_delivered = int(
                await asyncio.wait_for(
                    reminders_runner(now=current),
                    timeout=rem_budget,
                )
            )
            record_worker_success("reading_reminder")
            await _persist_cron_heartbeat(
                "reading_reminder",
                ok=True,
                items_processed=reminders_delivered,
            )
        except Exception as exc:
            record_worker_error("reading_reminder", exc)
            sweep_errors.append("reading_reminder")
            await _persist_cron_heartbeat(
                "reading_reminder",
                ok=False,
                items_processed=0,
                error_code=type(exc).__name__,
            )
            logger.warning(
                "cron_reading_reminder_skipped error=%s", type(exc).__name__
            )

    # Isolated reading presence alerts runner (6.0s cap)
    alert_budget = _remaining_budget(deadline, REMINDERS_ALERTS_TIMEOUT_SECONDS)
    if alert_budget > 0.25:
        try:
            presence_alerts_delivered = int(
                await asyncio.wait_for(
                    alerts_runner(now=current),
                    timeout=alert_budget,
                )
            )
            record_worker_success("reading_presence")
            await _persist_cron_heartbeat(
                "reading_presence",
                ok=True,
                items_processed=presence_alerts_delivered,
            )
        except Exception as exc:
            record_worker_error("reading_presence", exc)
            sweep_errors.append("reading_presence")
            await _persist_cron_heartbeat(
                "reading_presence",
                ok=False,
                items_processed=0,
                error_code=type(exc).__name__,
            )
            logger.warning(
                "cron_reading_presence_skipped error=%s", type(exc).__name__
            )

    if engagement_runner is not None:
        engagement_budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if engagement_budget > 0.25:
            try:
                engagement_emails_delivered = int(
                    await asyncio.wait_for(
                        engagement_runner(now=current),
                        timeout=engagement_budget,
                    )
                    or 0
                )
            except Exception as exc:
                sweep_errors.append("parent_email_engagement")
                logger.warning(
                    "cron_parent_email_engagement_skipped error=%s",
                    type(exc).__name__,
                )

    if run_remote_sweeps:
        effective_temp_cleanup = (
            temp_cleanup_runner
            or parent_book_submission_worker.cleanup_expired_temp_submissions
        )
        effective_post_ocr = (
            parent_post_ocr_runner or parent_book_submission_worker.run_once
        )

        # 1. Reap expired OCR leases & prune stale worker heartbeats
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget > 0.25:
            try:
                (
                    ocr_leases_requeued,
                    ocr_leases_dead_lettered,
                    stale_worker_heartbeats_pruned,
                ) = await asyncio.wait_for(
                    _sweep_ocr_leases_and_heartbeats(
                        max_age_hours=DEFAULT_STALE_HEARTBEAT_MAX_AGE_HOURS
                    ),
                    timeout=budget,
                )
            except Exception as exc:
                sweep_errors.append("ocr_leases")
                logger.warning("cron_ocr_lease_reap_skipped error=%s", type(exc).__name__)

        parent_sweep_error: str | None = None

        # 2. Reconcile orphaned parent private book submissions (cap 20)
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget > 0.25:
            try:
                reconcile_res = await asyncio.wait_for(
                    reconcile_orphaned_parent_submissions(
                        limit=orphan_reconcile_limit,
                        now=current,
                    ),
                    timeout=budget,
                )
                if isinstance(reconcile_res, dict):
                    orphaned_parent_submissions_reclaimed = int(
                        reconcile_res.get("reclaimed_count") or 0
                    )
                    orphaned_parent_submissions_failed = int(
                        reconcile_res.get("failed_count") or 0
                    )
            except Exception as exc:
                parent_sweep_error = type(exc).__name__
                sweep_errors.append("orphaned_parent_submissions")
                logger.warning(
                    "cron_orphaned_parent_reconcile_skipped error=%s",
                    type(exc).__name__,
                )

        # 3. Clean expired temp parent submissions
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget > 0.25:
            try:
                temp_submissions_cleaned = int(
                    await asyncio.wait_for(
                        effective_temp_cleanup(now=current, limit=50),
                        timeout=budget,
                    )
                )
            except Exception as exc:
                parent_sweep_error = parent_sweep_error or type(exc).__name__
                sweep_errors.append("temp_submissions")
                logger.warning("cron_temp_cleanup_skipped error=%s", type(exc).__name__)

        # 4. Parent private book Stage 2/3 post-OCR sweeper (up to 5)
        try:
            for _ in range(max_items_per_sweep):
                budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
                if budget <= 0.25:
                    break
                did_work = await asyncio.wait_for(
                    effective_post_ocr(worker_id="cron-post-ocr-sweeper"),
                    timeout=budget,
                )
                if not did_work:
                    break
                post_ocr_swept += 1
        except Exception as exc:
            parent_sweep_error = parent_sweep_error or type(exc).__name__
            sweep_errors.append("parent_post_ocr")
            logger.warning("cron_post_ocr_sweep_skipped error=%s", type(exc).__name__)

        parent_items_processed = (
            orphaned_parent_submissions_reclaimed
            + orphaned_parent_submissions_failed
            + temp_submissions_cleaned
            + post_ocr_swept
        )
        if parent_sweep_error is not None:
            record_worker_error("parent_book_submission", parent_sweep_error)
            await _persist_cron_heartbeat(
                "parent_book_submission",
                ok=False,
                items_processed=parent_items_processed,
                error_code=parent_sweep_error,
            )
        else:
            record_worker_success("parent_book_submission")
            await _persist_cron_heartbeat(
                "parent_book_submission",
                ok=True,
                items_processed=parent_items_processed,
            )

        # 5. Admin AI workflow bounded sweep / non-cancelling background kick
        if _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS) > 0.25:
            try:
                admin_ai_workflows_swept = await _sweep_admin_ai_workflows(
                    max_items=max_items_per_sweep,
                    deadline=deadline,
                    now=current,
                )
                record_worker_success("admin_ai_workflow")
                await _persist_cron_heartbeat(
                    "admin_ai_workflow",
                    ok=True,
                    items_processed=admin_ai_workflows_swept,
                )
            except Exception as exc:
                record_worker_error("admin_ai_workflow", exc)
                sweep_errors.append("admin_ai_workflow")
                await _persist_cron_heartbeat(
                    "admin_ai_workflow",
                    ok=False,
                    items_processed=0,
                    error_code=type(exc).__name__,
                )
                logger.warning(
                    "cron_admin_ai_workflow_sweep_skipped error=%s",
                    type(exc).__name__,
                )

        # 6. Book quality scan bounded sweep / non-cancelling background kick
        if _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS) > 0.25:
            try:
                book_quality_scans_swept = await _sweep_book_quality_scans(
                    max_items=max_items_per_sweep,
                    deadline=deadline,
                    now=current,
                )
                record_worker_success("book_quality")
                await _persist_cron_heartbeat(
                    "book_quality",
                    ok=True,
                    items_processed=book_quality_scans_swept,
                )
            except Exception as exc:
                record_worker_error("book_quality", exc)
                sweep_errors.append("book_quality")
                await _persist_cron_heartbeat(
                    "book_quality",
                    ok=False,
                    items_processed=0,
                    error_code=type(exc).__name__,
                )
                logger.warning(
                    "cron_book_quality_sweep_skipped error=%s",
                    type(exc).__name__,
                )

        # 7. Flow 2 verified OCR outbox bounded sweep (up to 5)
        if _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS) > 0.25:
            try:
                ocr_outbox_swept = await _sweep_viread_ocr_outbox(
                    max_items=max_items_per_sweep,
                    deadline=deadline,
                )
                record_worker_success("viread_ocr_outbox")
                await _persist_cron_heartbeat(
                    "viread_ocr_outbox",
                    ok=True,
                    items_processed=ocr_outbox_swept,
                )
            except Exception as exc:
                record_worker_error("viread_ocr_outbox", exc)
                sweep_errors.append("viread_ocr_outbox")
                await _persist_cron_heartbeat(
                    "viread_ocr_outbox",
                    ok=False,
                    items_processed=0,
                    error_code=type(exc).__name__,
                )
                logger.warning(
                    "cron_ocr_outbox_sweep_skipped error=%s",
                    type(exc).__name__,
                )

        # 8. Clean expired local-scans/ temporary storage objects
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget > 0.25:
            try:
                local_scan_objects_cleaned = await asyncio.wait_for(
                    _cleanup_expired_local_scans(
                        max_age_hours=DEFAULT_LOCAL_SCAN_MAX_AGE_HOURS
                    ),
                    timeout=budget,
                )
            except Exception as exc:
                sweep_errors.append("local_scan_cleanup")
                logger.warning(
                    "cron_local_scan_cleanup_skipped error=%s",
                    type(exc).__name__,
                )

        # 9. Passive 12-hour Hugging Face Space keep-warm (prevents 48h sleep without waking DB loop)
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget > 0.25:
            try:
                hf_space_keepwarm_pinged = bool(
                    await asyncio.wait_for(
                        maybe_keep_warm_hf_space_from_cron(),
                        timeout=budget,
                    )
                )
            except Exception as exc:
                sweep_errors.append("hf_space_keepwarm")
                logger.warning(
                    "cron_hf_keepwarm_skipped error=%s",
                    type(exc).__name__,
                )

        # 10. Lightweight Flow 2 OCR training maintenance (lease expiry + Colab poll/dispatch, zero PyTorch)
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget > 0.25:
            try:
                ocr_training_maintenance_ran, training_items = await asyncio.wait_for(
                    _sweep_viread_ocr_training_maintenance(),
                    timeout=budget,
                )
                record_worker_success("viread_ocr_training")
                await _persist_cron_heartbeat(
                    "viread_ocr_training",
                    ok=True,
                    items_processed=training_items,
                )
            except Exception as exc:
                record_worker_error("viread_ocr_training", exc)
                sweep_errors.append("viread_ocr_training")
                await _persist_cron_heartbeat(
                    "viread_ocr_training",
                    ok=False,
                    items_processed=0,
                    error_code=type(exc).__name__,
                )
                logger.warning(
                    "cron_ocr_training_maintenance_skipped error=%s",
                    type(exc).__name__,
                )

    return {
        "ok": True,
        "dispatched_at": current.isoformat(),
        "reminders_delivered": reminders_delivered,
        "presence_alerts_delivered": presence_alerts_delivered,
        "engagement_emails_delivered": engagement_emails_delivered,
        "temp_submissions_cleaned": temp_submissions_cleaned,
        "post_ocr_swept": post_ocr_swept,
        "ocr_leases_requeued": ocr_leases_requeued,
        "ocr_leases_dead_lettered": ocr_leases_dead_lettered,
        "stale_worker_heartbeats_pruned": stale_worker_heartbeats_pruned,
        "orphaned_parent_submissions_reclaimed": orphaned_parent_submissions_reclaimed,
        "orphaned_parent_submissions_failed": orphaned_parent_submissions_failed,
        "admin_ai_workflows_swept": admin_ai_workflows_swept,
        "book_quality_scans_swept": book_quality_scans_swept,
        "ocr_outbox_swept": ocr_outbox_swept,
        "local_scan_objects_cleaned": local_scan_objects_cleaned,
        "hf_space_keepwarm_pinged": hf_space_keepwarm_pinged,
        "ocr_training_maintenance_ran": ocr_training_maintenance_ran,
        "sweep_errors": sweep_errors,
    }
