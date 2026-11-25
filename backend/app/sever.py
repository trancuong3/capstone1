from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException as FastAPIHTTPException, Request
from fastapi.exception_handlers import (
    http_exception_handler as default_http_exception_handler,
    request_validation_exception_handler as default_request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import (
    DBAPIError,
    IntegrityError,
    InterfaceError,
    OperationalError,
    TimeoutError as SQLAlchemyTimeoutError,
)
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.router import api_router
from app.database.config import (
    APP_ENVIRONMENT,
    CORS_ALLOWED_ORIGINS,
    DATABASE_CONNECT_TIMEOUT,
)
from app.database.integrity import postgres_integrity_error_metadata
from app.database.session import (
    DatabaseConcurrencyLimitExceeded,
    engine,
    probe_database_connection,
)
from app.diagnostic_logging import log_diagnostic
from app.request_context import request_id_context
from app.services.ocr_engine import run_active_viread_model_worker, warmup_ocr_engines
from app.services.local_voice_worker_bootstrap import (
    arm_local_voice_worker_autostart,
    ensure_local_voice_worker_running,
)
from app.services.runtime_diagnostics import collect_ocr_health
from app.services.admin_ocr_jobs import admin_ocr_correction_jobs
from app.jobs.book_quality_worker import run_worker as run_book_quality_worker
from app.jobs.admin_ai_workflow_worker import run_worker as run_admin_ai_workflow_worker
from app.jobs.parent_book_submission_worker import run_worker as run_parent_book_submission_worker
from app.jobs.viread_ocr_outbox_worker import run_worker as run_viread_ocr_outbox_worker
from app.jobs.viread_ocr_training_auto_worker import run_worker as run_viread_ocr_training_auto_worker

logger = logging.getLogger(__name__)


_WORKER_SHUTDOWN_TIMEOUT_SECONDS = 5.0


def _background_worker_startup_delay_seconds() -> float:
    """Defer background worker DB polling on Render/production so initial API requests win CPU/DB."""
    raw = os.getenv("BACKGROUND_WORKER_STARTUP_DELAY_SECONDS")
    if raw is not None and raw.strip() != "":
        try:
            return max(0.0, min(60.0, float(raw.strip())))
        except ValueError:
            return 0.0
    if os.getenv("RENDER") or APP_ENVIRONMENT == "production":
        return 12.0
    return 0.0


async def _run_worker_with_startup_delay(
    worker_fn,
    stop_event: asyncio.Event,
    delay_seconds: float,
) -> None:
    if delay_seconds > 0:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=delay_seconds)
            return
        except TimeoutError:
            pass
    if not stop_event.is_set():
        await worker_fn(stop_event)


def _task_runtime_state(task: asyncio.Task[object] | None) -> str:
    if task is None:
        return "disabled"
    if not task.done():
        return "running"
    if task.cancelled():
        return "cancelled"
    return "failed" if task.exception() is not None else "stopped"


async def _shutdown_worker_task(
    task: asyncio.Task[object] | None,
    stop_event: asyncio.Event,
    *,
    timeout: float | None = None,
) -> None:
    """Stop a background asyncio worker cleanly without propagating cancellation."""
    stop_event.set()
    if task is None:
        return
    effective_timeout = (
        _WORKER_SHUTDOWN_TIMEOUT_SECONDS if timeout is None else timeout
    )
    try:
        await asyncio.wait_for(task, timeout=effective_timeout)
    except (TimeoutError, asyncio.CancelledError):
        if not task.done():
            task.cancel()
        try:
            await asyncio.gather(task, return_exceptions=True)
        except asyncio.CancelledError:
            pass
    except Exception:
        logger.warning(
            "Background worker %s failed during shutdown",
            task.get_name(),
            exc_info=True,
        )


async def _shutdown_subprocess(
    process: asyncio.subprocess.Process | None,
    *,
    timeout: float | None = None,
) -> None:
    """Terminate a child worker process cleanly without propagating cancellation."""
    if process is None or process.returncode is not None:
        return
    effective_timeout = (
        _WORKER_SHUTDOWN_TIMEOUT_SECONDS if timeout is None else timeout
    )
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=effective_timeout)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                return
            try:
                await process.wait()
            except asyncio.CancelledError:
                pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Start lightweight durable workers; OCR models load only on OCR requests."""
    if APP_ENVIRONMENT != "test":
        app_diag_logger = logging.getLogger("app")
        if app_diag_logger.level == logging.NOTSET:
            app_diag_logger.setLevel(logging.INFO)
        if not app_diag_logger.handlers and not logging.getLogger().handlers:
            diag_handler = logging.StreamHandler(sys.stderr)
            diag_handler.setFormatter(
                logging.Formatter("%(levelname)s: %(name)s %(message)s")
            )
            app_diag_logger.addHandler(diag_handler)

        db_probe = await probe_database_connection(
            timeout=min(5.0, DATABASE_CONNECT_TIMEOUT)
        )
        log_diagnostic(
            logger,
            logging.INFO if db_probe["ok"] else logging.WARNING,
            event=(
                "database_startup_probe_succeeded"
                if db_probe["ok"]
                else "database_startup_probe_failed"
            ),
            stage="lifespan_startup",
            dns_resolved=db_probe["dns_resolved"],
            ssl_enabled=db_probe["ssl_enabled"],
            pool_class=db_probe["pool_class"],
            pooler_mode=db_probe["pooler_mode"],
            latency_ms=db_probe["latency_ms"],
            database_error_type=db_probe["error_type"],
        )

    warmup_enabled = os.getenv("VIREAD_OCR_WARMUP_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }
    if warmup_enabled:
        threading.Thread(
            target=warmup_ocr_engines,
            daemon=True,
            name="ocr_warmup_worker",
        ).start()

    stop_active_model_worker = threading.Event()
    active_model_worker = None
    if APP_ENVIRONMENT != "test":
        active_model_worker = threading.Thread(
            target=run_active_viread_model_worker,
            args=(stop_active_model_worker,),
            daemon=True,
            name="viread_active_model_registry_worker",
        )
        active_model_worker.start()

    worker_disabled = os.getenv(
        "BOOK_QUALITY_SCAN_WORKER_ENABLED", "true"
    ).strip().lower() in {"0", "false", "no", "off"}
    stop_book_quality_worker = asyncio.Event()
    book_quality_task = None
    viread_outbox_task = None
    viread_training_task = None
    stop_admin_ai_workflow = asyncio.Event()
    admin_ai_workflow_task = None
    stop_parent_book_worker = asyncio.Event()
    parent_book_task = None
    worker_startup_delay = _background_worker_startup_delay_seconds()
    if APP_ENVIRONMENT != "test" and not worker_disabled:
        book_quality_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_book_quality_worker, stop_book_quality_worker, worker_startup_delay
            ),
            name="book_quality_scan_worker",
        )
    workflow_worker_enabled = os.getenv(
        "ADMIN_AI_WORKFLOW_WORKER_ENABLED", "true"
    ).strip().lower() not in {"0", "false", "no", "off"}
    if APP_ENVIRONMENT != "test" and workflow_worker_enabled:
        admin_ai_workflow_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_admin_ai_workflow_worker,
                stop_admin_ai_workflow,
                worker_startup_delay,
            ),
            name="admin_ai_workflow_worker",
        )
    parent_book_worker_enabled = os.getenv(
        "PARENT_BOOK_WORKER_ENABLED", "true"
    ).strip().lower() not in {"0", "false", "no", "off"}
    if APP_ENVIRONMENT != "test" and parent_book_worker_enabled:
        parent_book_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_parent_book_submission_worker,
                stop_parent_book_worker,
                worker_startup_delay,
            ),
            name="parent_book_submission_worker",
        )
    ocr_outbox_enabled = os.getenv("VIREAD_OCR_OUTBOX_WORKER_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}
    stop_viread_ocr_outbox = asyncio.Event()
    if APP_ENVIRONMENT != "test" and ocr_outbox_enabled:
        viread_outbox_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_viread_ocr_outbox_worker,
                stop_viread_ocr_outbox,
                worker_startup_delay,
            ),
            name="viread_ocr_verified_outbox_worker",
        )
    training_worker_enabled = os.getenv(
        "VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED", "true"
    ).strip().lower() not in {"0", "false", "no", "off"}
    stop_viread_training = asyncio.Event()
    if APP_ENVIRONMENT != "test" and training_worker_enabled:
        viread_training_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_viread_ocr_training_auto_worker,
                stop_viread_training,
                worker_startup_delay,
            ),
            name="viread_ocr_flow2_auto_training_worker",
        )
    local_trainer_process = None
    # Dedicated training is opt-in. The subprocess itself defaults to disabled;
    # starting it without an explicit opt-in wastes memory and fails on Render.
    local_training_enabled = os.getenv(
        "VIREAD_LOCAL_TRAINING_ENABLED", "false"
    ).strip().lower() in {"1", "true", "yes", "on"}
    local_autostart_enabled = os.getenv(
        "VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART", "false"
    ).strip().lower() in {"1", "true", "yes", "on"}
    if APP_ENVIRONMENT != "test" and local_training_enabled and local_autostart_enabled:
        try:
            local_trainer_process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "app.jobs.viread_ocr_local_training_worker",
                cwd=str(Path(__file__).resolve().parents[1]),
                env=os.environ.copy(),
            )
        except Exception as exc:
            logger.warning("Could not start the local VietOCR worker (%s)", type(exc).__name__)

    stop_local_voice_bootstrap = asyncio.Event()
    local_voice_bootstrap_task = None
    if APP_ENVIRONMENT != "test":
        arm_local_voice_worker_autostart(True)
        local_voice_bootstrap_task = asyncio.create_task(
            ensure_local_voice_worker_running(stop_event=stop_local_voice_bootstrap),
            name="local_voice_worker_bootstrap",
        )

    if _app is not None:
        _app.state.background_workers = {
            "viread_ocr_outbox": viread_outbox_task,
            "viread_ocr_training": viread_training_task,
            "book_quality": book_quality_task,
            "admin_ai_workflow": admin_ai_workflow_task,
            "parent_book_submission": parent_book_task,
            "local_voice_bootstrap": local_voice_bootstrap_task,
            "active_model_registry": active_model_worker,
            "local_trainer_process": local_trainer_process,
        }

    try:
        yield
    except asyncio.CancelledError:
        # Suppress runner/reloader task cancellation on Ctrl+C so Starlette
        # completes ASGI lifespan shutdown cleanly instead of logging a traceback.
        pass
    finally:
        arm_local_voice_worker_autostart(False)
        stop_local_voice_bootstrap.set()
        stop_active_model_worker.set()
        stop_viread_ocr_outbox.set()
        stop_viread_training.set()
        stop_book_quality_worker.set()
        stop_admin_ai_workflow.set()
        stop_parent_book_worker.set()

        worker_tasks = (
            local_voice_bootstrap_task,
            viread_outbox_task,
            viread_training_task,
            book_quality_task,
            admin_ai_workflow_task,
            parent_book_task,
        )
        try:
            # Book quality worker releases its lease on cancellation; an interrupted
            # page is resumed from its durable per-page state on the next poll.
            await asyncio.gather(
                _shutdown_subprocess(local_trainer_process),
                _shutdown_worker_task(
                    local_voice_bootstrap_task,
                    stop_local_voice_bootstrap,
                    timeout=2.0,
                ),
                _shutdown_worker_task(viread_outbox_task, stop_viread_ocr_outbox),
                _shutdown_worker_task(viread_training_task, stop_viread_training),
                _shutdown_worker_task(book_quality_task, stop_book_quality_worker),
                _shutdown_worker_task(
                    admin_ai_workflow_task, stop_admin_ai_workflow
                ),
                _shutdown_worker_task(parent_book_task, stop_parent_book_worker),
            )
        except asyncio.CancelledError:
            for worker_task in worker_tasks:
                if worker_task is not None and not worker_task.done():
                    worker_task.cancel()
            if local_trainer_process is not None and local_trainer_process.returncode is None:
                try:
                    local_trainer_process.kill()
                except ProcessLookupError:
                    pass

        if active_model_worker is not None:
            active_model_worker.join(timeout=6)

        if _app is not None and hasattr(_app.state, "background_workers"):
            _app.state.background_workers = {}

        try:
            await admin_ocr_correction_jobs.shutdown()
        except asyncio.CancelledError:
            pass

        try:
            await engine.dispose()
        except asyncio.CancelledError:
            pass


app = FastAPI(title="ReadAlong Vision API", version="1.0.0", lifespan=lifespan)


def _route_template(request: Request) -> str:
    """Return the registered route pattern, never a URL containing resource IDs."""
    route = request.scope.get("route")
    template = getattr(route, "path", None)
    return template if isinstance(template, str) else "unmatched"


def _validation_metadata(
    exception: RequestValidationError,
) -> tuple[int, str, str]:
    """Summarize validation locations/types without logging submitted values."""
    errors = exception.errors()
    fields: set[str] = set()
    error_types: set[str] = set()

    for error in errors[:20]:
        location = error.get("loc", ())
        safe_parts: list[str] = []
        if isinstance(location, (list, tuple)):
            for part in location:
                if isinstance(part, int) and 0 <= part <= 10000:
                    safe_parts.append(str(part))
                elif isinstance(part, str) and re.fullmatch(
                    r"[A-Za-z0-9_.-]{1,64}", part
                ):
                    safe_parts.append(part)
        if safe_parts:
            fields.add(".".join(safe_parts))

        error_type = error.get("type")
        if isinstance(error_type, str) and re.fullmatch(
            r"[A-Za-z0-9_.-]{1,64}", error_type
        ):
            error_types.add(error_type)

    return (
        len(errors),
        ",".join(sorted(fields))[:512],
        ",".join(sorted(error_types))[:256],
    )


@app.middleware("http")
async def request_diagnostic_middleware(request: Request, call_next):
    """Attach one correlation ID to API logs and expose it for safe client reports."""
    request_id = uuid4().hex
    request.state.request_id = request_id
    token = request_id_context.set(request_id)
    started_at = time.perf_counter()
    log_diagnostic(
        logger,
        logging.INFO,
        event="http_request_received",
        stage="request_received",
        method=request.method,
    )
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        log_diagnostic(
            logger,
            logging.INFO if response.status_code < 500 else logging.ERROR,
            event="http_request_completed",
            stage="response_validation",
            method=request.method,
            route=_route_template(request),
            http_status=response.status_code,
            elapsed_ms=int((time.perf_counter() - started_at) * 1000),
        )
        return response
    finally:
        request_id_context.reset(token)


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
):
    """Log 422 field locations and error types, never input values or headers."""
    error_count, fields, error_types = _validation_metadata(exc)
    log_diagnostic(
        logger,
        logging.WARNING,
        event="http_request_validation_failed",
        stage="request_validation",
        exception=exc,
        method=request.method,
        route=_route_template(request),
        http_status=422,
        validation_error_count=error_count,
        validation_fields=fields,
        validation_types=error_types,
    )
    return await default_request_validation_exception_handler(request, exc)


@app.exception_handler(FastAPIHTTPException)
@app.exception_handler(StarletteHTTPException)
async def http_exception_diagnostic_handler(
    request: Request,
    exc: StarletteHTTPException,
):
    """Log rejected requests without reflecting exception details into logs."""
    safe_code = None
    if isinstance(exc.detail, dict):
        candidate = exc.detail.get("code")
        if isinstance(candidate, str) and re.fullmatch(
            r"[A-Za-z0-9_.-]{1,64}", candidate
        ):
            safe_code = candidate

    fields = {
        "method": request.method,
        "route": _route_template(request),
        "http_status": exc.status_code,
    }
    if safe_code:
        fields["error_code"] = safe_code

    log_diagnostic(
        logger,
        logging.WARNING if exc.status_code < 500 else logging.ERROR,
        event="http_request_rejected",
        stage=(
            "authorization"
            if exc.status_code in (401, 403)
            else "application_http_exception"
        ),
        exception=exc,
        **fields,
    )
    return await default_http_exception_handler(request, exc)


@app.exception_handler(DatabaseConcurrencyLimitExceeded)
@app.exception_handler(OperationalError)
@app.exception_handler(InterfaceError)
@app.exception_handler(SQLAlchemyTimeoutError)
async def database_connection_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    """Return a retryable 503 for stale connections and exhausted pool waits."""
    request_id = getattr(request.state, "request_id", uuid4().hex)
    log_diagnostic(
        logger,
        logging.ERROR,
        event="database_connection_unavailable",
        stage="database_pool",
        exception=exc,
        request_id=request_id,
        method=request.method,
        route=_route_template(request),
        database_error_type=type(exc).__name__,
    )
    return JSONResponse(
        status_code=503,
        content={
            "detail": "Database temporarily unavailable",
            "request_id": request_id,
        },
        headers={"X-Request-ID": request_id},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Return a generic error while retaining a private traceback and request ID."""
    request_id = getattr(request.state, "request_id", uuid4().hex)
    log_diagnostic(
        logger,
        logging.ERROR,
        event="http_request_unhandled_exception",
        stage="request_dispatch",
        exception=exc,
        include_traceback=True,
        request_id=request_id,
        method=request.method,
        route=_route_template(request),
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
        headers={"X-Request-ID": request_id},
    )


@app.exception_handler(DBAPIError)
async def database_api_exception_handler(
    request: Request,
    exc: DBAPIError,
) -> JSONResponse:
    """Map transient failures and safely diagnose PostgreSQL constraint errors."""
    if isinstance(exc, IntegrityError):
        request_id = getattr(request.state, "request_id", uuid4().hex)
        metadata = postgres_integrity_error_metadata(exc)
        log_diagnostic(
            logger,
            logging.ERROR,
            event="database_integrity_violation",
            stage="database_constraint",
            exception=exc,
            request_id=request_id,
            method=request.method,
            route=_route_template(request),
            **metadata,
        )
        return await unhandled_exception_handler(request, exc)

    original = exc.orig
    sqlstate = getattr(original, "sqlstate", None)
    message = str(original)
    transient = (
        exc.connection_invalidated
        or (isinstance(sqlstate, str) and (
            sqlstate.startswith("08")
            or sqlstate in {"53300", "57P01", "57P02", "57P03"}
        ))
        or "EMAXCONNSESSION" in message
    )
    if transient:
        return await database_connection_exception_handler(request, exc)
    return await unhandled_exception_handler(request, exc)


app.add_middleware(
    CORSMiddleware,
    allow_origins=list(CORS_ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Request-ID",
        "X-Resolved-Voice-Id",
        "X-Voice-Provider",
        "X-Voice-Region",
        "X-Voice-Gender",
        "X-Voice-Model-Version",
        "X-Voice-Fallback",
        "X-Voice-Fallback-Reason",
    ],
)

@app.get("/health", tags=["System"])
async def get_health(request: Request) -> dict[str, object]:
    """Read-only liveness/readiness check (SELECT 1 + worker states, zero secrets)."""
    db_probe = await probe_database_connection(timeout=4.0)
    workers = getattr(request.app.state, "background_workers", None) or {}
    active_model_thread = workers.get("active_model_registry")
    local_trainer = workers.get("local_trainer_process")
    worker_states = {
        "viread_ocr_outbox": _task_runtime_state(workers.get("viread_ocr_outbox")),
        "viread_ocr_training": _task_runtime_state(workers.get("viread_ocr_training")),
        "book_quality": _task_runtime_state(workers.get("book_quality")),
        "admin_ai_workflow": _task_runtime_state(workers.get("admin_ai_workflow")),
        "parent_book_submission": _task_runtime_state(workers.get("parent_book_submission")),
        "active_model_registry": (
            "disabled"
            if active_model_thread is None
            else ("running" if active_model_thread.is_alive() else "stopped")
        ),
        "local_trainer_process": (
            "disabled"
            if local_trainer is None
            else ("running" if local_trainer.returncode is None else "stopped")
        ),
    }
    try:
        ocr_items = await asyncio.wait_for(asyncio.to_thread(collect_ocr_health), timeout=2.5)
        ocr_engines = {
            item["id"]: {
                "status": item["status"],
                "detail_status": item["detail_status"],
            }
            for item in ocr_items
        }
        ocr_ready = any(
            item["detail_status"] in {"loaded", "installed", "healthy"}
            for item in ocr_items
            if item["id"] in {"paddleocr", "vietocr", "tesseract_vie"}
        )
    except Exception:
        ocr_engines = {}
        ocr_ready = False

    return {
        "status": "ok" if db_probe["ok"] else "degraded",
        "database": {
            "status": "healthy" if db_probe["ok"] else "unavailable",
            "dns_resolved": db_probe["dns_resolved"],
            "ssl_enabled": db_probe["ssl_enabled"],
            "pool_class": db_probe["pool_class"],
            "pooler_mode": db_probe["pooler_mode"],
            "latency_ms": db_probe["latency_ms"],
        },
        "ocr": {
            "ready": ocr_ready,
            "engines": ocr_engines,
        },
        "workers": worker_states,
    }


app.include_router(api_router)
