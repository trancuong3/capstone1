"""Durable background worker for Parent Private Book staged page checks and temp TTL cleanup."""
from __future__ import annotations

import asyncio
import logging
import os
import socket
from datetime import datetime, timezone
from uuid import uuid4

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.repositories.parent_private_book_repository import ParentPrivateBookRepository
from app.services.parent_private_book_pipeline import PipelineHooks, process_submission_stages
from app.services.storage_service import delete_object

logger = logging.getLogger(__name__)


def _poll_seconds() -> float:
    try:
        value = float(os.getenv("PARENT_BOOK_WORKER_POLL_SECONDS", "2.0"))
    except ValueError:
        return 2.0
    return max(0.25, min(30.0, value))


async def cleanup_expired_temp_submissions(*, now: datetime | None = None, limit: int = 50) -> int:
    """Delete expired temporary staging files that are NOT awaiting Admin review or committed."""
    cutoff = now or datetime.now(timezone.utc)
    cleaned = 0
    async with AsyncSessionLocal() as db:
        repo = ParentPrivateBookRepository(db)
        expired = await repo.list_expired_temp_submissions(cutoff, limit=limit)
        targets = [(row.Id, row.SourceStoragePath) for row in expired]
        await db.rollback()

    for sub_id, storage_path in targets:
        try:
            await asyncio.to_thread(
                delete_object,
                storage_path,
                bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
            )
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_book_temp_cleanup_storage_failed",
                stage="cleanup",
                submission_id=str(sub_id),
                exception=exc,
            )
            continue

        async with AsyncSessionLocal() as db:
            repo = ParentPrivateBookRepository(db)
            locked = await repo.get_submission(sub_id, lock=True)
            if (
                locked is not None
                and locked.CommittedPageId is None
                and locked.WorkflowStatus not in ("PENDING_ADMIN", "ADDED_TO_BOOK")
                and locked.TempExpiresAt < cutoff
            ):
                locked.WorkflowStatus = "CANCELLED"
                locked.UpdatedAt = cutoff
                await db.commit()
                cleaned += 1
            else:
                await db.rollback()
    return cleaned


async def run_once(
    worker_id: str | None = None,
    *,
    hooks: PipelineHooks | None = None,
) -> bool:
    """Claim and process a single queued Parent Private Book submission. Returns True if work ran."""
    worker_name = worker_id or f"parent-book-worker-{socket.gethostname()}-{uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        repo = ParentPrivateBookRepository(db)
        claimed = await repo.claim_next_checking_submission(worker_name)
        if claimed is None:
            return False
        submission_id = claimed.Id

    async with AsyncSessionLocal() as db:
        await process_submission_stages(db, submission_id, hooks=hooks, worker_id=worker_name)
    return True


async def run_worker(
    stop_event: asyncio.Event,
    *,
    hooks: PipelineHooks | None = None,
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
        except asyncio.CancelledError:
            raise
        except Exception as exc:
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
