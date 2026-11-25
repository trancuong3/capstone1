"""Durable background worker for Parent Private Book staged page checks and temp TTL cleanup."""
from __future__ import annotations

import asyncio
import logging
import os
import socket
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import uuid4

from sqlalchemy import select

from app.models import ParentBookPageSubmission
from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.repositories.parent_private_book_repository import ParentPrivateBookRepository
from app.services.ocr_inference_job_service import (
    is_heavy_workers_disabled,
    is_remote_ocr_mode,
    run_parent_submission_post_ocr,
)
from app.services.storage_service import delete_object
from app.services.worker_telemetry import record_worker_error, record_worker_success

if TYPE_CHECKING:
    from app.services.parent_private_book_pipeline import PipelineHooks

logger = logging.getLogger(__name__)
_WORKER_KEY = "parent_book_submission"


def _poll_seconds() -> float:
    try:
        value = float(os.getenv("PARENT_BOOK_WORKER_POLL_SECONDS", "2.0"))
    except ValueError:
        return 2.0
    return max(0.25, min(30.0, value))


async def cleanup_expired_temp_submissions(*, now: datetime | None = None, limit: int = 50) -> int:
    """Lock and cancel expired temp staging rows in DB first, then delete Storage objects."""
    cutoff = now or datetime.now(timezone.utc)
    targets: list[tuple] = []
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ParentBookPageSubmission)
            .where(
                ParentBookPageSubmission.CommittedPageId.is_(None),
                ParentBookPageSubmission.WorkflowStatus.not_in(
                    ("PENDING_ADMIN", "ADDED_TO_BOOK", "CANCELLED")
                ),
                ParentBookPageSubmission.TempExpiresAt < cutoff,
            )
            .order_by(ParentBookPageSubmission.TempExpiresAt.asc(), ParentBookPageSubmission.Id.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        expired = list(result.scalars().all())
        for row in expired:
            targets.append((row.Id, row.SourceStoragePath))
            row.WorkflowStatus = "CANCELLED"
            row.WorkerId = None
            row.LeaseExpiresAt = None
            row.RetryAfter = None
            row.UpdatedAt = cutoff
        if targets:
            await db.commit()
        else:
            await db.rollback()

    cleaned = 0
    for sub_id, storage_path in targets:
        try:
            await asyncio.to_thread(
                delete_object,
                storage_path,
                bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
            )
            cleaned += 1
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_book_temp_cleanup_storage_failed",
                stage="cleanup",
                submission_id=str(sub_id),
                exception=exc,
            )
    return cleaned


async def run_once(
    worker_id: str | None = None,
    *,
    hooks: "PipelineHooks | None" = None,
) -> bool:
    """Claim and process a single queued Parent Private Book submission. Returns True if work ran.

    In `remote_worker` or `VIREAD_WEB_DISABLE_HEAVY_WORKERS` mode, runs strictly as a
    lightweight Stage 2/3 sweeper (zero torch/paddle imports): claims only CHECKING rows
    whose Stage 1 OCR already finished (`COMPLETED` or `NO_TEXT_DETECTED`) via
    `FOR UPDATE SKIP LOCKED` and dispatches `run_parent_submission_post_ocr`.
    """
    post_ocr_only = is_remote_ocr_mode() or is_heavy_workers_disabled()
    worker_name = worker_id or f"parent-book-worker-{socket.gethostname()}-{uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        repo = ParentPrivateBookRepository(db)
        claimed = await repo.claim_next_checking_submission(
            worker_name,
            only_post_ocr=post_ocr_only,
        )
        if claimed is None:
            record_worker_success(_WORKER_KEY)
            return False
        submission_id = claimed.Id

    if post_ocr_only:
        await run_parent_submission_post_ocr(submission_id)
    else:
        from app.services.parent_private_book_pipeline import process_submission_stages

        async with AsyncSessionLocal() as db:
            await process_submission_stages(
                db, submission_id, hooks=hooks, worker_id=worker_name
            )
    record_worker_success(_WORKER_KEY)
    return True


async def run_worker(
    stop_event: asyncio.Event,
    *,
    hooks: "PipelineHooks | None" = None,
) -> None:
    worker_id = f"parent-book-worker-{socket.gethostname()}-{uuid4().hex[:8]}"
    poll_seconds = _poll_seconds()
    cleanup_ticks = 0
    while not stop_event.is_set():
        did_work = False
        try:
            did_work = await run_once(worker_id, hooks=hooks)
            cleanup_ticks += 1
            if cleanup_ticks >= 300:
                cleanup_ticks = 0
                await cleanup_expired_temp_submissions()
            record_worker_success(_WORKER_KEY)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            record_worker_error(_WORKER_KEY, exc)
            log_diagnostic(
                logger,
                logging.ERROR,
                event="parent_book_worker_loop_error",
                stage="worker",
                exception=exc,
            )
        if did_work:
            continue
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=poll_seconds)
        except TimeoutError:
            pass
