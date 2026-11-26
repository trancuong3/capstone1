"""Bounded service layer for internal scheduled cron sweeps.

Keeps `POST /internal/cron/dispatch` strictly within Render/Cloudflare HTTP
budgets (<25s total) while isolating failures per subsystem and preserving
backward compatibility across pre- and post-merge helper contracts.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from uuid import uuid4

from app.database.session import AsyncSessionLocal
from app.jobs import (
    admin_ai_workflow_worker,
    book_quality_worker,
    parent_book_submission_worker,
    viread_ocr_outbox_worker,
)
from app.repositories.admin_ai_workflow_repository import AdminAiWorkflowRepository
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.services import local_ocr_scan_service
from app.services.ocr_inference_job_service import (
    OcrInferenceJobService,
    reconcile_orphaned_parent_submissions,
)
from app.services.remote_ocr_wakeup import maybe_keep_warm_hf_space_from_cron

logger = logging.getLogger(__name__)

DEFAULT_CRON_TOTAL_BUDGET_SECONDS = 24.0
DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS = 5.0
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

        try:
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    return requeued, dead_lettered, heartbeats_pruned


async def _sweep_admin_ai_workflows(
    *,
    max_items: int,
    deadline: float,
) -> int:
    """Process up to `max_items` queued Admin AI workflow items within remaining budget."""
    run_once_fn = getattr(admin_ai_workflow_worker, "run_once", None)
    configured_enabled = getattr(admin_ai_workflow_worker, "_configured_enabled", None)
    if callable(configured_enabled) and not configured_enabled():
        return 0

    swept = 0
    for _ in range(max_items):
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget <= 0.25:
            break
        if callable(run_once_fn):
            did_work = await asyncio.wait_for(
                run_once_fn(worker_id=f"cron-admin-ai-{uuid4().hex[:8]}"),
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
) -> int:
    """Process up to `max_items` queued Book Quality scans within remaining budget."""
    run_once_fn = getattr(book_quality_worker, "run_once", None)
    swept = 0
    for _ in range(max_items):
        budget = _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS)
        if budget <= 0.25:
            break
        if callable(run_once_fn):
            did_work = await asyncio.wait_for(
                run_once_fn(worker_id=f"cron-book-quality-{uuid4().hex[:8]}"),
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
    temp_cleanup_runner: Callable[..., Awaitable[int]] | None = None,
    parent_post_ocr_runner: Callable[..., Awaitable[bool]] | None = None,
    total_budget_seconds: float = DEFAULT_CRON_TOTAL_BUDGET_SECONDS,
    max_items_per_sweep: int = DEFAULT_SWEEP_MAX_ITEMS,
    orphan_reconcile_limit: int = DEFAULT_ORPHAN_RECONCILE_LIMIT,
) -> dict[str, Any]:
    """Execute one idempotent, time-bounded sweep across scheduled maintenance tasks."""
    current = now or datetime.now(timezone.utc)
    deadline = time.monotonic() + max(2.0, float(total_budget_seconds))

    reminders_delivered = int(await reminders_runner(now=current))
    presence_alerts_delivered = int(await alerts_runner(now=current))

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
    sweep_errors: list[str] = []

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
            sweep_errors.append("parent_post_ocr")
            logger.warning("cron_post_ocr_sweep_skipped error=%s", type(exc).__name__)

        # 5. Admin AI workflow bounded sweep (up to 5)
        if _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS) > 0.25:
            try:
                admin_ai_workflows_swept = await _sweep_admin_ai_workflows(
                    max_items=max_items_per_sweep,
                    deadline=deadline,
                )
            except Exception as exc:
                sweep_errors.append("admin_ai_workflow")
                logger.warning(
                    "cron_admin_ai_workflow_sweep_skipped error=%s",
                    type(exc).__name__,
                )

        # 6. Book quality scan bounded sweep (up to 5)
        if _remaining_budget(deadline, DEFAULT_SUBSYSTEM_TIMEOUT_SECONDS) > 0.25:
            try:
                book_quality_scans_swept = await _sweep_book_quality_scans(
                    max_items=max_items_per_sweep,
                    deadline=deadline,
                )
            except Exception as exc:
                sweep_errors.append("book_quality")
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
            except Exception as exc:
                sweep_errors.append("viread_ocr_outbox")
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

    return {
        "ok": True,
        "dispatched_at": current.isoformat(),
        "reminders_delivered": reminders_delivered,
        "presence_alerts_delivered": presence_alerts_delivered,
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
        "sweep_errors": sweep_errors,
    }
