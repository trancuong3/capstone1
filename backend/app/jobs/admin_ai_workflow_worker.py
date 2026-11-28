from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select

from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.models import AdminAiWorkflow, BookPage
from app.repositories.admin_ai_workflow_repository import (
    MAX_WORKFLOW_ATTEMPTS,
    AdminAiWorkflowRepository,
)
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.services.admin_ocr_service import AdminOcrService, PreparedLocalOcrCorrection
from app.services.ai_capability_router import get_shared_ai_circuit_breaker
from app.services.book_content_quality_service import BookContentQualityService
from app.services.ocr_ai.child_safety import (
    ChildSafetyError,
    build_child_safety_orchestrator,
    content_hash,
    normalize_safety_text,
)
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError, OcrOrchestrationError
from app.services.worker_telemetry import (
    persist_worker_heartbeat_with_factory,
    record_worker_error,
    record_worker_success,
)


logger = logging.getLogger(__name__)
POLL_SECONDS = 2
LEASE_SECONDS = 1200
MAX_ATTEMPTS = 5
MAX_QUOTA_CIRCUIT_ATTEMPTS = max(6, int(MAX_WORKFLOW_ATTEMPTS))
_QUOTA_OR_CIRCUIT_ERROR_CODES = frozenset({
    "ALL_PROVIDERS_SKIPPED",
    "PROVIDER_QUOTA",
    "QUOTA_EXHAUSTED",
    "RATE_LIMIT",
})
DEFAULT_MAX_CONCURRENT_JOBS = 2
PROOFREAD_PROMPT_VERSION = "viread-ocr-proofread-v1"
CHILD_SAFETY_PROMPT_VERSION = "viread-child-safety-v2"


def _effective_max_attempts(error_code: str) -> int:
    normalized = (error_code or "").strip().upper()
    if normalized in _QUOTA_OR_CIRCUIT_ERROR_CODES:
        return max(MAX_ATTEMPTS, MAX_QUOTA_CIRCUIT_ATTEMPTS)
    return MAX_ATTEMPTS


def _compute_retry_delay_seconds(attempts: int) -> float:
    cb_cooldown = 0.0
    try:
        cb_cooldown = float(get_shared_ai_circuit_breaker().max_cloud_cooldown_seconds())
    except Exception:
        cb_cooldown = 0.0
    exp_backoff = 35.0 * (2 ** max(0, attempts - 1))
    raw_delay = max(cb_cooldown + 5.0, exp_backoff)
    return max(35.0, min(600.0, raw_delay))


def _owns_active_claim(row: AdminAiWorkflow, worker_id: str, now: datetime) -> bool:
    return bool(
        row.WorkerId == worker_id
        and row.LeaseExpiresAt is not None
        and row.LeaseExpiresAt > now
    )


def _configured_enabled() -> bool:
    return os.getenv("ADMIN_AI_WORKFLOW_WORKER_ENABLED", "true").strip().lower() not in {
        "0", "false", "no", "off",
    }


def _token_corrections(original: str, proposed: str) -> list[dict[str, object]]:
    source = list(re.finditer(r"\S+", original, flags=re.UNICODE))
    target = list(re.finditer(r"\S+", proposed, flags=re.UNICODE))
    if len(source) != len(target):
        return []
    corrections: list[dict[str, object]] = []
    for index, (left, right) in enumerate(zip(source, target, strict=True)):
        before = unicodedata.normalize("NFC", left.group(0))
        after = unicodedata.normalize("NFC", right.group(0))
        if before == after:
            continue
        corrections.append({
            "word_index": index,
            "original": before,
            "proposed": after,
            "original_start": left.start(),
            "original_end": left.end(),
            "suggested_start": right.start(),
            "suggested_end": right.end(),
            "original_excerpt": original[max(0, left.start() - 40):min(len(original), left.end() + 40)],
            "suggested_excerpt": proposed[max(0, right.start() - 40):min(len(proposed), right.end() + 40)],
            "correction_type": "OCR_OR_SPELLING",
            "explanation": "Đề xuất proofreading cần Admin đối chiếu với ảnh và ngữ cảnh.",
            "decision": "PENDING_ADMIN",
        })
    return corrections


async def _load(workflow_id: UUID) -> dict[str, object] | None:
    async with AsyncSessionLocal() as session:
        row = await session.scalar(
            select(AdminAiWorkflow).where(AdminAiWorkflow.Id == workflow_id)
        )
        if row is None:
            return None
        return {
            "id": row.Id,
            "book_id": row.BookId,
            "page_id": row.PageId,
            "revision_id": row.PageRevisionId,
            "input_text": row.InputText,
            "input_words": list(row.InputWords or []),
            "image_path": row.ImagePath,
            "stage": row.Stage,
            "total_chunks": row.TotalChunks,
            "candidate_text": row.CandidateText,
            "candidate_hash": row.CandidateHash,
            "safety_input_hash": row.SafetyInputHash,
            "safety_status": row.SafetyStatus,
            "worker_id": row.WorkerId,
            "attempts": row.Attempts,
            "provider_events": list(row.ProviderEvents or []),
            "review_events": list(row.ReviewEvents or []),
        }


async def _try_auto_publish(book_id: UUID | None) -> None:
    """Deprecated no-op: books are never auto-published without explicit Admin approval."""
    return None


async def _progress_loop(
    workflow_id: UUID,
    worker_id: str,
    queue: asyncio.Queue[tuple[int, int] | None],
) -> None:
    latest = (0, 1)
    while True:
        try:
            update = await asyncio.wait_for(queue.get(), timeout=30)
        except TimeoutError:
            update = None
        if update == (-1, -1):
            return
        if update is not None:
            latest = update
        try:
            async with AsyncSessionLocal() as session:
                updated = await AdminAiWorkflowRepository(session).update_progress(
                    workflow_id, worker_id, latest[0], latest[1], lease_seconds=LEASE_SECONDS
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="admin_ai_workflow_progress_heartbeat_failed",
                stage="heartbeat",
                workflow_id=str(workflow_id),
                error_code=type(exc).__name__.upper(),
            )
            continue
        if not updated:
            return
        # A timeout is a lease heartbeat; non-empty updates persist real chunk progress.


async def _run_proofreading(snapshot: dict[str, object], worker_id: str) -> None:
    workflow_id = snapshot["id"]
    input_text = str(snapshot["input_text"])
    words = snapshot["input_words"]
    assert isinstance(words, list)
    try:
        config = OcrCorrectionConfig.from_environment()
    except OcrConfigurationError as exc:
        raise OcrOrchestrationError("INVALID_AI_CONFIGURATION") from exc
    word_boxes = [tuple(word["bbox"]) for word in words if isinstance(word, dict)]
    if len(word_boxes) != len(words):
        raise OcrOrchestrationError("INVALID_WORKFLOW_WORDS")
    prepared = PreparedLocalOcrCorrection(
        config=config,
        draft_text=input_text,
        image_path=str(snapshot["image_path"]),
        word_boxes=tuple(word_boxes),
        total_chunks=int(snapshot["total_chunks"]),
    )
    progress_queue: asyncio.Queue[tuple[int, int] | None] = asyncio.Queue()
    progress_queue.put_nowait((0, prepared.total_chunks))
    events: list[dict[str, object]] = []
    uncertain_indices: set[int] = set()

    def on_progress(completed: int, total: int) -> None:
        progress_queue.put_nowait((completed, total))

    def on_provider_event(event: dict[str, object]) -> None:
        # Provider events contain identifiers and timings only, never OCR text or keys.
        if event.get("status") != "started":
            events.append(event)

    def on_uncertain_tokens(_chunk_id: int, indices: tuple[int, ...]) -> None:
        uncertain_indices.update(indices)

    heartbeat = asyncio.create_task(_progress_loop(workflow_id, worker_id, progress_queue))
    input_hash = content_hash(input_text)
    safety_snapshot = normalize_safety_text(input_text)
    retry_events = snapshot.get("review_events")
    latest_review_event = (
        retry_events[-1]
        if isinstance(retry_events, list) and retry_events
        else None
    )
    proofread_retry_only = bool(
        isinstance(latest_review_event, dict)
        and latest_review_event.get("event") == "WORKFLOW_STAGE_RETRY_QUEUED"
        and latest_review_event.get("stage") == "PROOFREADING"
    )

    async def scan_original_text() -> tuple[dict[str, object] | None, Exception | None]:
        safety_started_at = time.perf_counter()
        try:
            value = await build_child_safety_orchestrator().analyze(safety_snapshot)
            value["_processing_time_ms"] = max(
                0, int((time.perf_counter() - safety_started_at) * 1000)
            )
            return value, None
        except OcrConfigurationError as exc:
            return None, ChildSafetyError("INVALID_AI_CONFIGURATION", [])
        except Exception as exc:
            return None, exc

    # Safety starts from the immutable OCR snapshot in parallel with
    # proofreading. If proofreading changes the text, a hash-bound follow-up
    # safety scan is queued on the existing worker after both results persist.
    cached_safety = (
        snapshot.get("safety_input_hash") == input_hash
        and snapshot.get("safety_status") in {"PROVISIONAL", "CONFIRMED"}
    )
    safety_task = (
        None
        if cached_safety or proofread_retry_only
        else asyncio.create_task(scan_original_text())
    )
    corrected: str | None = None
    proofread_error: Exception | None = None
    safety_result: dict[str, object] | None = None
    safety_error: Exception | None = None
    proofread_started_at = time.perf_counter()
    proofread_duration_ms = 0
    try:
        try:
            corrected = normalize_safety_text(await AdminOcrService.run_prepared_ai_correction(
                prepared,
                on_progress=on_progress,
                on_provider_event=on_provider_event,
                on_uncertain_tokens=on_uncertain_tokens,
            ))
        except Exception as exc:
            proofread_error = exc
        proofread_duration_ms = max(
            0, int((time.perf_counter() - proofread_started_at) * 1000)
        )
        if safety_task is not None:
            safety_result, safety_error = await safety_task
    except asyncio.CancelledError:
        if safety_task is not None and not safety_task.done():
            safety_task.cancel()
            await asyncio.gather(safety_task, return_exceptions=True)
        raise
    finally:
        progress_queue.put_nowait((-1, -1))
        await asyncio.gather(heartbeat, return_exceptions=True)
    corrected_hash = content_hash(corrected) if corrected is not None else None
    run_metadata: dict[str, object] | None = None
    if corrected is not None:
        run_metadata = {
            "run_id": str(workflow_id),
            "input_text_hash": input_hash,
            "corrected_text_hash": corrected_hash,
            "prompt_version": PROOFREAD_PROMPT_VERSION,
            "processing_time_ms": proofread_duration_ms,
            "status": "SUCCEEDED",
        }
    async with AsyncSessionLocal() as session:
        row = await AdminAiWorkflowRepository(session).get(workflow_id, lock=True)
        now = datetime.now(timezone.utc)
        if row is None or not _owns_active_claim(row, worker_id, now):
            await session.rollback()
            return
        if corrected is not None and corrected_hash is not None and run_metadata is not None:
            row.ProofreadText = corrected
            row.ProofreadOutputHash = corrected_hash
            row.CorrectionSuggestions = _token_corrections(input_text, corrected)
            row.UncertainWordIndices = sorted(uncertain_indices)
            row.ProofreadMetadata = run_metadata
            row.CandidateText = corrected
            row.CandidateHash = corrected_hash
            row.CandidateVersion = max(1, row.CandidateVersion + 1)
            row.CandidateHistory = list(row.CandidateHistory or []) + [{
                "version": row.CandidateVersion,
                "text": corrected,
                "content_hash": corrected_hash,
                "changed_at": now.isoformat(),
                "changed_by": "AI_PROOFREADING",
            }]
        if safety_result is not None:
            chunks_total = int(safety_result.get("chunks_total") or 1)
            chunks_completed = int(safety_result.get("chunks_completed") or chunks_total)
            all_chunks_completed = bool(
                safety_result.get("all_chunks_completed", chunks_completed == chunks_total)
            )
            row.SafetyInputHash = input_hash
            row.Suitability = str(safety_result["suitability"])
            row.Findings = list(safety_result["findings"])
            row.SafetyStatus = "PROVISIONAL"
            row.SafetyMetadata = {
                "scan_id": str(uuid4()),
                "content_hash": input_hash,
                "target": "GRADE_1_TO_5",
                "prompt_version": CHILD_SAFETY_PROMPT_VERSION,
                "processing_time_ms": safety_result.get("_processing_time_ms"),
                "status": "PROVISIONAL",
                "input_version": "ORIGINAL_OCR",
                "chunks_total": chunks_total,
                "chunks_completed": chunks_completed,
                "all_chunks_completed": all_chunks_completed,
                "text_safety_status": str(safety_result.get("text_safety_status") or "PROVISIONAL"),
                "image_safety_status": str(
                    safety_result.get("image_safety_status") or "UNASSESSED_NO_VISION_MODEL"
                ),
            }
            row.ProviderEvents = list(row.ProviderEvents or []) + list(safety_result["provider_events"])
        elif safety_error is not None:
            row.SafetyStatus = "FAILED"
        row.ProviderEvents = list(row.ProviderEvents or []) + events
        row.UpdatedAt = now
        if proofread_error is not None:
            row.ProofreadMetadata = {
                **dict(row.ProofreadMetadata or {}),
                "input_text_hash": input_hash,
                "status": "FAILED",
                "error_code": getattr(proofread_error, "code", None) or type(proofread_error).__name__.upper(),
            }
            row.Stage = "PROOFREADING"
            row.Status = "PROOFREADING"
            await session.commit()
        elif safety_error is not None:
            row.Stage = "CHILD_SAFETY_SCANNING"
            row.Status = "CHILD_SAFETY_SCANNING"
            await session.commit()
        elif corrected_hash != input_hash:
            if row.SafetyInputHash or row.Findings:
                safety_history = list(row.SafetyHistory or [])
                safety_history.append({
                    "scan_id": (row.SafetyMetadata or {}).get("scan_id"),
                    "content_hash": row.SafetyInputHash,
                    "status": row.SafetyStatus,
                    "suitability": row.Suitability,
                    "findings": list(row.Findings or []),
                    "metadata": dict(row.SafetyMetadata or {}),
                    "archived_at": now.isoformat(),
                    "reason": "PROOFREADING_CHANGED_CONTENT_HASH",
                })
                row.SafetyHistory = safety_history
            row.Stage = "CHILD_SAFETY_SCANNING"
            row.Status = "QUEUED"
            row.SafetyStatus = "STALE"
            row.SafetyInputHash = None
            row.Suitability = None
            row.Findings = []
            if proofread_retry_only:
                # Retrying Proofreading does not silently invoke Child Safety.
                # The new candidate is explicitly left stale for a separate Safety retry.
                row.Stage = "READY_FOR_ADMIN_REVIEW"
                row.Status = "READY_FOR_ADMIN_REVIEW"
                row.WorkerId = None
                row.LeaseExpiresAt = None
                row.RetryAfter = None
                row.CompletedChunks = 1
                row.TotalChunks = 1
                row.Attempts = 0
                row.ErrorCode = None
                await session.commit()
                return
            row.WorkerId = None
            row.LeaseExpiresAt = None
            row.RetryAfter = None
            row.CompletedChunks = 0
            row.TotalChunks = 1
            row.Attempts = 0
            row.ErrorCode = None
            await session.commit()
            return
        else:
            row.Stage = "READY_FOR_ADMIN_REVIEW"
            row.Status = "READY_FOR_ADMIN_REVIEW"
            row.WorkerId = None
            row.LeaseExpiresAt = None
            row.RetryAfter = None
            row.CompletedChunks = 1
            row.TotalChunks = 1
            row.Attempts = 0
            row.ErrorCode = None
        await session.commit()

    if proofread_error is not None:
        error_code = getattr(proofread_error, "code", None) or type(proofread_error).__name__.upper()
        await _fail(
            workflow_id,
            worker_id,
            "PROOFREADING",
            str(error_code),
            list(getattr(proofread_error, "provider_events", []) or []),
        )
    elif safety_error is not None:
        error_code = getattr(safety_error, "code", None) or type(safety_error).__name__.upper()
        await _fail(
            workflow_id,
            worker_id,
            "CHILD_SAFETY_SCANNING",
            str(error_code),
            list(getattr(safety_error, "provider_events", []) or []),
        )


async def _run_safety(snapshot: dict[str, object], worker_id: str) -> None:
    workflow_id = snapshot["id"]
    candidate = normalize_safety_text(str(snapshot["candidate_text"] or ""))
    expected_hash = content_hash(candidate)
    started = datetime.now(timezone.utc)
    progress_queue: asyncio.Queue[tuple[int, int] | None] = asyncio.Queue()
    heartbeat = asyncio.create_task(
        _progress_loop(workflow_id, worker_id, progress_queue)
    )
    try:
        try:
            result = await build_child_safety_orchestrator().analyze(candidate)
        except OcrConfigurationError as exc:
            raise ChildSafetyError("INVALID_AI_CONFIGURATION", []) from exc
    finally:
        progress_queue.put_nowait((-1, -1))
        await asyncio.gather(heartbeat, return_exceptions=True)
    async with AsyncSessionLocal() as session:
        row = await AdminAiWorkflowRepository(session).get(workflow_id, lock=True)
        now = datetime.now(timezone.utc)
        if row is None or not _owns_active_claim(row, worker_id, now):
            await session.rollback()
            return
        if row.CandidateHash != expected_hash:
            # Candidate changed during inference. Discard this scan completely;
            # the editor update has already queued a scan for the new hash.
            row.SafetyStatus = "STALE"
            row.Status = "QUEUED"
            row.Stage = "CHILD_SAFETY_SCANNING"
            row.WorkerId = None
            row.LeaseExpiresAt = None
            row.UpdatedAt = datetime.now(timezone.utc)
            await session.commit()
            return
        now = datetime.now(timezone.utc)
        chunks_total = int(result.get("chunks_total") or 1)
        chunks_completed = int(result.get("chunks_completed") or chunks_total)
        all_chunks_completed = bool(
            result.get("all_chunks_completed", chunks_completed == chunks_total)
        )
        row.SafetyInputHash = expected_hash
        row.Suitability = result["suitability"]
        row.Findings = result["findings"]
        row.SafetyStatus = "PROVISIONAL"
        row.SafetyMetadata = {
            "scan_id": str(uuid4()),
            "content_hash": expected_hash,
            "target": "GRADE_1_TO_5",
            "prompt_version": CHILD_SAFETY_PROMPT_VERSION,
            "processing_time_ms": max(0, int((now - started).total_seconds() * 1000)),
            "status": "PROVISIONAL",
            "input_version": "PROOFREAD_CANDIDATE",
            "chunks_total": chunks_total,
            "chunks_completed": chunks_completed,
            "all_chunks_completed": all_chunks_completed,
            "text_safety_status": str(result.get("text_safety_status") or "PROVISIONAL"),
            "image_safety_status": str(
                result.get("image_safety_status") or "UNASSESSED_NO_VISION_MODEL"
            ),
        }
        row.ProviderEvents = list(row.ProviderEvents or []) + list(result["provider_events"])
        row.Status = "READY_FOR_ADMIN_REVIEW"
        row.Stage = "READY_FOR_ADMIN_REVIEW"
        row.CompletedChunks = chunks_completed
        row.TotalChunks = chunks_total
        row.Attempts = 0
        row.ErrorCode = None
        row.WorkerId = None
        row.LeaseExpiresAt = None
        row.RetryAfter = None
        row.UpdatedAt = now
        await session.commit()


async def _fail(
    workflow_id: UUID, worker_id: str, stage: str, error_code: str,
    provider_events: list[dict[str, object]] | None = None,
) -> None:
    effective_max_attempts = _effective_max_attempts(error_code)
    retry_delay_seconds: float | None = None
    async with AsyncSessionLocal() as session:
        row = await AdminAiWorkflowRepository(session).get(workflow_id, lock=True)
        now = datetime.now(timezone.utc)
        if row is None or not _owns_active_claim(row, worker_id, now):
            await session.rollback()
            return
        attempts = int(row.Attempts or 1)
        row.ProviderEvents = list(row.ProviderEvents or []) + list(provider_events or [])
        row.ReviewEvents = list(row.ReviewEvents or []) + [{
            "event": "WORKFLOW_STAGE_FAILED",
            "actor_id": "SYSTEM",
            "stage": stage,
            "error_code": error_code[:80],
            "attempt": attempts,
            "created_at": now.isoformat(),
        }]
        row.ErrorCode = error_code[:80]
        if attempts < effective_max_attempts:
            retry_delay_seconds = _compute_retry_delay_seconds(attempts)
            row.Status = "QUEUED"
            row.RetryAfter = now + timedelta(seconds=retry_delay_seconds)
        else:
            row.Status = "FAILED"
            row.RetryAfter = None
            if stage == "CHILD_SAFETY_SCANNING":
                row.SafetyStatus = "FAILED"
        row.Stage = stage
        row.WorkerId = None
        row.LeaseExpiresAt = None
        row.UpdatedAt = now
        await session.commit()
    if retry_delay_seconds is not None:
        _schedule_delayed_admin_ai_wakeup(retry_delay_seconds)
    log_diagnostic(
        logger,
        logging.ERROR,
        event="admin_ai_workflow_stage_failed",
        workflow_id=str(workflow_id),
        stage=stage,
        attempt=attempts,
        terminal=attempts >= effective_max_attempts,
        error_code=error_code,
    )


async def _process(workflow_id: UUID, worker_id: str) -> None:
    stage = "UNKNOWN"
    try:
        snapshot = await _load(workflow_id)
        if snapshot is None or snapshot.get("worker_id") != worker_id:
            return
        stage = str(snapshot["stage"])
        if stage == "PROOFREADING":
            await _run_proofreading(snapshot, worker_id)
        elif stage == "CHILD_SAFETY_SCANNING":
            await _run_safety(snapshot, worker_id)
        else:
            await _fail(workflow_id, worker_id, stage, "INVALID_WORKFLOW_STAGE")
    except asyncio.CancelledError:
        try:
            async with AsyncSessionLocal() as session:
                await AdminAiWorkflowRepository(session).release_claim(
                    workflow_id, worker_id
                )
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="admin_ai_workflow_claim_release_failed",
                workflow_id=str(workflow_id),
                stage=stage,
                error_code=type(exc).__name__.upper(),
            )
        raise
    except OcrOrchestrationError as exc:
        await _fail(workflow_id, worker_id, stage, exc.code)
    except ChildSafetyError as exc:
        await _fail(workflow_id, worker_id, stage, exc.code, exc.provider_events)
    except HTTPException as exc:
        await _fail(
            workflow_id, worker_id, stage,
            f"HTTP_{exc.status_code}",
        )
    except Exception as exc:
        if stage == "UNKNOWN":
            log_diagnostic(
                logger,
                logging.ERROR,
                event="admin_ai_workflow_load_failed",
                stage="workflow_load",
                workflow_id=str(workflow_id),
                error_code=type(exc).__name__.upper(),
            )
            try:
                async with AsyncSessionLocal() as session:
                    await AdminAiWorkflowRepository(session).release_claim(
                        workflow_id, worker_id
                    )
            except Exception as release_exc:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="admin_ai_workflow_claim_release_failed",
                    workflow_id=str(workflow_id),
                    stage=stage,
                    error_code=type(release_exc).__name__.upper(),
                )
            return
        await _fail(workflow_id, worker_id, stage, type(exc).__name__.upper())


def _reap_done_tasks(tasks: set[asyncio.Task[None]]) -> set[asyncio.Task[None]]:
    remaining: set[asyncio.Task[None]] = set()
    for task in tasks:
        if not task.done():
            remaining.add(task)
            continue
        if task.cancelled():
            continue
        exc = task.exception()
        if exc is not None:
            record_worker_error("admin_ai_workflow", exc)
            log_diagnostic(
                logger,
                logging.ERROR,
                event="admin_ai_workflow_task_failed",
                stage="worker_loop",
                task_name=task.get_name(),
                error_code=type(exc).__name__.upper(),
            )
    return remaining


_EVENT_WORKFLOW_TASKS: set[asyncio.Task[None]] = set()
_EVENT_WORKFLOW_SEMAPHORES: dict[int, asyncio.Semaphore] = {}
_DELAYED_WAKEUP_HANDLES: dict[int, tuple[float, asyncio.TimerHandle]] = {}


def _cancel_delayed_admin_ai_wakeup(loop_id: int | None = None) -> None:
    if loop_id is None:
        for key in list(_DELAYED_WAKEUP_HANDLES.keys()):
            item = _DELAYED_WAKEUP_HANDLES.pop(key, None)
            if item is not None:
                item[1].cancel()
        return
    item = _DELAYED_WAKEUP_HANDLES.pop(loop_id, None)
    if item is not None:
        item[1].cancel()


def _schedule_delayed_admin_ai_wakeup(
    delay_seconds: float,
    *,
    force: bool = False,
) -> asyncio.TimerHandle | None:
    """Arm one coalesced delayed wake-up timer so deferred workflows auto-resume after RetryAfter."""
    from app.database.config import APP_ENVIRONMENT
    from app.services.ocr_inference_job_service import is_heavy_workers_disabled

    if not force:
        app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
        if app_env == "test" or not is_heavy_workers_disabled() or not _configured_enabled():
            return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    clamped_delay = max(0.05, float(delay_seconds))
    fire_at = time.monotonic() + clamped_delay
    loop_id = id(loop)
    existing = _DELAYED_WAKEUP_HANDLES.get(loop_id)
    if existing is not None:
        existing_fire_at, existing_handle = existing
        if not existing_handle.cancelled() and existing_fire_at <= fire_at:
            return existing_handle
        existing_handle.cancel()

    def _on_timer() -> None:
        current_entry = _DELAYED_WAKEUP_HANDLES.get(loop_id)
        if current_entry is not None and current_entry[1] is handle:
            _DELAYED_WAKEUP_HANDLES.pop(loop_id, None)
        schedule_admin_ai_workflow(force=force, source="retry_wakeup")

    handle = loop.call_later(clamped_delay, _on_timer)
    _DELAYED_WAKEUP_HANDLES[loop_id] = (fire_at, handle)
    return handle


def _event_workflow_semaphore() -> asyncio.Semaphore:
    loop_id = id(asyncio.get_running_loop())
    sem = _EVENT_WORKFLOW_SEMAPHORES.get(loop_id)
    if sem is None:
        sem = asyncio.Semaphore(1)
        _EVENT_WORKFLOW_SEMAPHORES[loop_id] = sem
    return sem


async def run_once(
    *,
    worker_id: str | None = None,
    source: str = "event",
    execution_mode: str = "on_demand",
    session_factory: object | None = None,
    repository_cls: object | None = None,
    persist_heartbeat: bool = True,
) -> bool:
    """Claim and execute one queued AdminAiWorkflow stage (zero heavy ML imports)."""
    if not _configured_enabled():
        return False
    effective_worker = worker_id or f"admin-ai-event-{uuid4()}"
    eff_session_factory = session_factory or AsyncSessionLocal
    eff_repo_cls = repository_cls or AdminAiWorkflowRepository
    try:
        async with eff_session_factory() as session:  # type: ignore[operator]
            workflow_id = await eff_repo_cls(session).claim_next(  # type: ignore[operator]
                effective_worker, lease_seconds=LEASE_SECONDS
            )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        record_worker_error("admin_ai_workflow", exc)
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                eff_session_factory,
                "admin_ai_workflow",
                execution_mode=execution_mode,
                ok=False,
                items_processed=0,
                source=source,
                error_code=type(exc).__name__,
            )
        log_diagnostic(
            logger,
            logging.ERROR,
            event="admin_ai_workflow_claim_failed",
            stage="queue_claim",
            error_code=type(exc).__name__.upper(),
        )
        return False

    if workflow_id is None:
        record_worker_success("admin_ai_workflow")
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                eff_session_factory,
                "admin_ai_workflow",
                execution_mode=execution_mode,
                ok=True,
                items_processed=0,
                source=source,
            )
        return False

    try:
        await _process(workflow_id, effective_worker)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        record_worker_error("admin_ai_workflow", exc)
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                eff_session_factory,
                "admin_ai_workflow",
                execution_mode=execution_mode,
                ok=False,
                items_processed=0,
                source=source,
                error_code=type(exc).__name__,
            )
        raise

    record_worker_success("admin_ai_workflow")
    if persist_heartbeat:
        await persist_worker_heartbeat_with_factory(
            eff_session_factory,
            "admin_ai_workflow",
            execution_mode=execution_mode,
            ok=True,
            items_processed=1,
            source=source,
        )
    return True


async def _run_event_workflow_once(*, worker_id: str | None = None) -> bool:
    """Backward-compatible internal alias for `run_once()`."""
    return await run_once(worker_id=worker_id, source="event", execution_mode="on_demand")


async def _drain_scheduled_admin_ai_workflows(
    *,
    max_steps: int = 64,
    source: str = "event",
) -> None:
    await asyncio.sleep(0)
    sem = _event_workflow_semaphore()
    processed = 0
    had_error: str | None = None
    limit = max(1, int(max_steps))
    hit_step_cap = False
    async with sem:
        try:
            for step_idx in range(limit):
                did_work = await run_once(
                    source=source,
                    execution_mode="on_demand",
                    persist_heartbeat=False,
                )
                if not did_work:
                    break
                processed += 1
                if step_idx + 1 == limit:
                    hit_step_cap = True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            had_error = type(exc).__name__
            record_worker_error("admin_ai_workflow", exc)
        await persist_worker_heartbeat_with_factory(
            AsyncSessionLocal,
            "admin_ai_workflow",
            execution_mode="on_demand",
            ok=had_error is None,
            items_processed=processed,
            source=source,
            error_code=had_error,
        )
    if hit_step_cap and had_error is None:
        schedule_admin_ai_workflow(source=source)


def schedule_admin_ai_workflow(
    *,
    force: bool = False,
    source: str = "event",
) -> asyncio.Task[None] | None:
    """Trigger event-driven AdminAiWorkflow execution when heavy background workers are disabled."""
    from app.database.config import APP_ENVIRONMENT
    from app.services.ocr_inference_job_service import is_heavy_workers_disabled

    if not force:
        app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
        if app_env == "test" or not is_heavy_workers_disabled() or not _configured_enabled():
            return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    active_tasks = [t for t in list(_EVENT_WORKFLOW_TASKS) if not t.done()]
    if len(active_tasks) >= 2:
        return active_tasks[-1]
    task = loop.create_task(
        _drain_scheduled_admin_ai_workflows(source=source),
        name="admin_ai_workflow_event_drain",
    )
    _EVENT_WORKFLOW_TASKS.add(task)
    task.add_done_callback(_EVENT_WORKFLOW_TASKS.discard)
    return task


async def shutdown_scheduled_admin_ai_workflows(*, timeout_seconds: float = 5.0) -> None:
    _cancel_delayed_admin_ai_wakeup()
    if not _EVENT_WORKFLOW_TASKS:
        return
    pending = [task for task in list(_EVENT_WORKFLOW_TASKS) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=timeout_seconds)


async def run_worker(stop_event: asyncio.Event | None = None, *, poll_seconds: int = POLL_SECONDS) -> None:
    if not _configured_enabled():
        log_diagnostic(logger, logging.INFO, event="admin_ai_workflow_worker_disabled")
        return
    stop = stop_event or asyncio.Event()
    try:
        capacity = max(1, min(8, int(os.getenv(
            "ADMIN_AI_WORKFLOW_MAX_CONCURRENT_JOBS",
            str(DEFAULT_MAX_CONCURRENT_JOBS),
        ))))
    except ValueError:
        capacity = DEFAULT_MAX_CONCURRENT_JOBS
        log_diagnostic(
            logger, logging.WARNING,
            event="admin_ai_workflow_invalid_concurrency_config",
            configured_env="ADMIN_AI_WORKFLOW_MAX_CONCURRENT_JOBS",
        )
    active: set[asyncio.Task[None]] = set()
    try:
        while not stop.is_set() or active:
            active = _reap_done_tasks(active)
            if stop.is_set() or len(active) >= capacity:
                if active:
                    done, pending = await asyncio.wait(
                        active,
                        timeout=poll_seconds,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    _reap_done_tasks(set(done))
                    active = set(pending)
                continue
            workflow_id = None
            worker_id = f"admin-ai-{uuid4()}"
            try:
                async with AsyncSessionLocal() as session:
                    workflow_id = await AdminAiWorkflowRepository(session).claim_next(
                        worker_id, lease_seconds=LEASE_SECONDS
                    )
                record_worker_success("admin_ai_workflow")
            except Exception as exc:
                record_worker_error("admin_ai_workflow", exc)
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="admin_ai_workflow_claim_failed",
                    stage="queue_claim",
                    error_code=type(exc).__name__.upper(),
                )
            if workflow_id is not None:
                active.add(asyncio.create_task(
                    _process(workflow_id, worker_id),
                    name=f"admin_ai_workflow_{workflow_id}",
                ))
                continue
            if active:
                done, pending = await asyncio.wait(
                    active,
                    timeout=poll_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                _reap_done_tasks(set(done))
                active = set(pending)
            else:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
                except TimeoutError:
                    pass
    finally:
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
