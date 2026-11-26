from __future__ import annotations

import asyncio
import inspect
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
    AsyncSessionLocal,
    DatabaseConcurrencyLimitExceeded,
    engine,
    probe_database_connection,
)
from app.diagnostic_logging import log_diagnostic
from app.request_context import request_id_context
from app.services.local_voice_worker_bootstrap import (
    arm_local_voice_worker_autostart,
    ensure_local_voice_worker_running,
)
from app.services.ocr_inference_job_service import (
    get_ocr_mode,
    is_heavy_workers_disabled,
    is_remote_ocr_mode,
    shutdown_post_ocr_tasks,
    worker_heartbeat_ttl_seconds,
)
from app.services.runtime_diagnostics import (
    collect_ocr_health,
    collect_remote_ocr_health,
    is_ocr_engine_ready_status,
)


def get_viread_app_version() -> str:
    """Return non-empty service build/version identifier for X-ViRead-Version."""
    explicit = (os.getenv("VIREAD_APP_VERSION") or "").strip()
    if explicit:
        return explicit[:64]
    git_sha = (os.getenv("RENDER_GIT_COMMIT") or os.getenv("GIT_SHA") or "").strip()
    if git_sha:
        return f"1.0.0+{git_sha[:12]}"
    return "1.0.0"


def warmup_ocr_engines():
    """Lazy wrapper so remote_worker web startup never imports torch/paddle/ocr_engine."""
    from app.services.ocr_engine import warmup_ocr_engines as _warmup_ocr_engines

    return _warmup_ocr_engines()


def run_active_viread_model_worker(stop_event: threading.Event):
    """Lazy wrapper preserving test patchability without importing ocr_engine at startup."""
    from app.services.ocr_engine import run_active_viread_model_worker as _run_worker

    return _run_worker(stop_event)
from app.services.admin_ocr_jobs import admin_ocr_correction_jobs
from app.jobs.book_quality_worker import run_worker as run_book_quality_worker
from app.jobs.admin_ai_workflow_worker import (
    run_worker as run_admin_ai_workflow_worker,
    shutdown_scheduled_admin_ai_workflows,
)
from app.services.remote_ocr_wakeup import shutdown_remote_ocr_wakeup_tasks
from app.jobs.parent_book_submission_worker import run_worker as run_parent_book_submission_worker
from app.jobs.parent_email_dispatcher_worker import run_worker as run_parent_email_dispatcher_worker
from app.jobs.viread_ocr_outbox_worker import run_worker as run_viread_ocr_outbox_worker
from app.jobs.viread_ocr_training_auto_worker import run_worker as run_viread_ocr_training_auto_worker

logger = logging.getLogger(__name__)


_WORKER_SHUTDOWN_TIMEOUT_SECONDS = 5.0


def _optional_bool_env(name: str) -> bool | None:
    """Parse an optional boolean environment override (None when unset/blank)."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return None
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


async def _prewarm_tts_public_voice_ids_nonfatal(*, timeout: float = 6.0) -> None:
    """Best-effort startup prewarm of cached public TTS voice IDs without failing boot."""
    prewarmed = False
    try:
        from app.services.tts_audio_cache_service import TtsAudioCacheService

        raw_attr = inspect.getattr_static(
            TtsAudioCacheService, "prewarm_cached_public_voice_ids", None
        )
        if raw_attr is not None:
            is_instance_method = (
                inspect.isfunction(raw_attr)
                and next(iter(inspect.signature(raw_attr).parameters), None) == "self"
            )
            if is_instance_method:
                async with AsyncSessionLocal() as prewarm_db:
                    service = TtsAudioCacheService(prewarm_db)
                    prewarm_fn = getattr(service, "prewarm_cached_public_voice_ids")
                    sig = inspect.signature(prewarm_fn)
                    accepts_timeout = "timeout" in sig.parameters or any(
                        p.kind == inspect.Parameter.VAR_KEYWORD
                        for p in sig.parameters.values()
                    )
                    if accepts_timeout:
                        await prewarm_fn(timeout=timeout)
                    else:
                        await prewarm_fn()
            else:
                prewarm_fn = getattr(TtsAudioCacheService, "prewarm_cached_public_voice_ids")
                sig = inspect.signature(prewarm_fn)
                accepts_timeout = "timeout" in sig.parameters or any(
                    p.kind == inspect.Parameter.VAR_KEYWORD
                    for p in sig.parameters.values()
                )
                if accepts_timeout:
                    await prewarm_fn(timeout=timeout)
                else:
                    await prewarm_fn()
            prewarmed = True
    except Exception as exc:
        log_diagnostic(
            logger,
            logging.WARNING,
            event="tts_cache_voice_ids_prewarm_failed",
            stage="lifespan_startup",
            database_error_type=type(exc).__name__,
        )

    if not prewarmed:
        try:
            from app.api.routes.voice_studio import refresh_cached_public_voice_ids

            await refresh_cached_public_voice_ids(timeout=timeout)
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="tts_cache_voice_ids_prewarm_failed",
                stage="lifespan_startup",
                database_error_type=type(exc).__name__,
            )


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
    startup_db_probe_task: asyncio.Task[object] | None = None
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

        async def _run_startup_db_probe() -> None:
            try:
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
                if db_probe["ok"]:
                    await _prewarm_tts_public_voice_ids_nonfatal(timeout=6.0)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="database_startup_probe_failed",
                    stage="lifespan_startup",
                    database_error_type=type(exc).__name__,
                )

        # Non-blocking startup probe so Uvicorn binds its HTTP port immediately on cold boot.
        startup_db_probe_task = asyncio.create_task(
            _run_startup_db_probe(), name="startup_db_probe"
        )

    heavy_workers_disabled = is_heavy_workers_disabled()
    remote_ocr_mode = is_remote_ocr_mode()

    lightweight_workers_override = _optional_bool_env("VIREAD_ENABLE_LIGHTWEIGHT_WORKERS")
    lightweight_workers_enabled = (
        lightweight_workers_override
        if lightweight_workers_override is not None
        else (not heavy_workers_disabled)
    )
    smart_studio_override = _optional_bool_env("VIREAD_ENABLE_SMART_STUDIO_WORKER")
    smart_studio_worker_enabled = (
        smart_studio_override
        if smart_studio_override is not None
        else (
            not heavy_workers_disabled
            and _optional_bool_env("VIREAD_SMART_STUDIO_WORKER_ENABLED") is not False
        )
    )

    warmup_enabled = (
        not remote_ocr_mode
        and not heavy_workers_disabled
        and os.getenv("VIREAD_OCR_WARMUP_ENABLED", "false").strip().lower()
        in {"1", "true", "yes", "on"}
    )
    if warmup_enabled:
        threading.Thread(
            target=warmup_ocr_engines,
            daemon=True,
            name="ocr_warmup_worker",
        ).start()

    stop_active_model_worker = threading.Event()
    active_model_worker = None
    if (
        APP_ENVIRONMENT != "test"
        and not remote_ocr_mode
        and not heavy_workers_disabled
    ):
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
    stop_parent_email_worker = asyncio.Event()
    parent_email_task = None
    worker_startup_delay = _background_worker_startup_delay_seconds()
    if APP_ENVIRONMENT != "test" and lightweight_workers_enabled and not worker_disabled:
        book_quality_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_book_quality_worker, stop_book_quality_worker, worker_startup_delay
            ),
            name="book_quality_scan_worker",
        )
    workflow_worker_enabled = os.getenv(
        "ADMIN_AI_WORKFLOW_WORKER_ENABLED", "true"
    ).strip().lower() not in {"0", "false", "no", "off"}
    if APP_ENVIRONMENT != "test" and lightweight_workers_enabled and workflow_worker_enabled:
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
    if APP_ENVIRONMENT != "test" and lightweight_workers_enabled and parent_book_worker_enabled:
        parent_book_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_parent_book_submission_worker,
                stop_parent_book_worker,
                worker_startup_delay,
            ),
            name="parent_book_submission_worker",
        )
    parent_email_worker_override = _optional_bool_env("PARENT_EMAIL_WORKER_ENABLED")
    parent_email_worker_enabled = (
        parent_email_worker_override
        if parent_email_worker_override is not None
        else lightweight_workers_enabled
    )
    if APP_ENVIRONMENT != "test" and parent_email_worker_enabled:
        parent_email_task = asyncio.create_task(
            _run_worker_with_startup_delay(
                run_parent_email_dispatcher_worker,
                stop_parent_email_worker,
                worker_startup_delay,
            ),
            name="parent_email_dispatcher_worker",
        )
    ocr_outbox_enabled = os.getenv(
        "VIREAD_OCR_OUTBOX_WORKER_ENABLED", "true"
    ).strip().lower() not in {"0", "false", "no", "off"}
    stop_viread_ocr_outbox = asyncio.Event()
    if APP_ENVIRONMENT != "test" and lightweight_workers_enabled and ocr_outbox_enabled:
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
    if APP_ENVIRONMENT != "test" and not heavy_workers_disabled and training_worker_enabled:
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
    local_training_enabled = (
        not remote_ocr_mode
        and not heavy_workers_disabled
        and os.getenv("VIREAD_LOCAL_TRAINING_ENABLED", "false").strip().lower()
        in {"1", "true", "yes", "on"}
    )
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
    if APP_ENVIRONMENT != "test" and not heavy_workers_disabled:
        arm_local_voice_worker_autostart(True)
        local_voice_bootstrap_task = asyncio.create_task(
            ensure_local_voice_worker_running(stop_event=stop_local_voice_bootstrap),
            name="local_voice_worker_bootstrap",
        )

    stop_smart_studio_worker = asyncio.Event()
    smart_studio_worker_task = None
    if APP_ENVIRONMENT != "test" and smart_studio_worker_enabled:
        async def _run_smart_studio_worker() -> None:
            if worker_startup_delay > 0:
                try:
                    await asyncio.wait_for(
                        stop_smart_studio_worker.wait(),
                        timeout=worker_startup_delay,
                    )
                    return
                except asyncio.TimeoutError:
                    pass
            from app.services.global_tasks_service import run_smart_studio_worker_loop

            await run_smart_studio_worker_loop(stop_smart_studio_worker)

        smart_studio_worker_task = asyncio.create_task(
            _run_smart_studio_worker(),
            name="smart_studio_worker",
        )

    if _app is not None:
        _app.state.background_workers = {
            "viread_ocr_outbox": viread_outbox_task,
            "viread_ocr_training": viread_training_task,
            "book_quality": book_quality_task,
            "admin_ai_workflow": admin_ai_workflow_task,
            "parent_book_submission": parent_book_task,
            "parent_email_dispatcher": parent_email_task,
            "smart_studio": smart_studio_worker_task,
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
        stop_parent_email_worker.set()
        stop_smart_studio_worker.set()
        if startup_db_probe_task is not None and not startup_db_probe_task.done():
            startup_db_probe_task.cancel()

        worker_tasks = (
            startup_db_probe_task,
            local_voice_bootstrap_task,
            smart_studio_worker_task,
            viread_outbox_task,
            viread_training_task,
            book_quality_task,
            admin_ai_workflow_task,
            parent_book_task,
            parent_email_task,
        )
        try:
            # Book quality worker releases its lease on cancellation; an interrupted
            # page is resumed from its durable per-page state on the next poll.
            await asyncio.gather(
                _shutdown_subprocess(local_trainer_process),
                shutdown_post_ocr_tasks(),
                shutdown_remote_ocr_wakeup_tasks(),
                shutdown_scheduled_admin_ai_workflows(),
                _shutdown_worker_task(
                    startup_db_probe_task,
                    asyncio.Event(),
                    timeout=1.0,
                ),
                _shutdown_worker_task(
                    local_voice_bootstrap_task,
                    stop_local_voice_bootstrap,
                    timeout=2.0,
                ),
                _shutdown_worker_task(
                    smart_studio_worker_task,
                    stop_smart_studio_worker,
                    timeout=2.0,
                ),
                _shutdown_worker_task(viread_outbox_task, stop_viread_ocr_outbox),
                _shutdown_worker_task(viread_training_task, stop_viread_training),
                _shutdown_worker_task(book_quality_task, stop_book_quality_worker),
                _shutdown_worker_task(
                    admin_ai_workflow_task, stop_admin_ai_workflow
                ),
                _shutdown_worker_task(parent_book_task, stop_parent_book_worker),
                _shutdown_worker_task(parent_email_task, stop_parent_email_worker),
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
            from app.api.routes.voice_studio import shutdown_cached_public_voice_ids_task

            await shutdown_cached_public_voice_ids_task()
        except (asyncio.CancelledError, Exception):
            pass

        try:
            from app.api.routes.voice import close_default_voice_orchestrators

            await close_default_voice_orchestrators()
        except (asyncio.CancelledError, Exception):
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
        response.headers["X-ViRead-Version"] = get_viread_app_version()
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
        headers={
            "X-Request-ID": request_id,
            "X-ViRead-Version": get_viread_app_version(),
        },
    )


def _cors_error_headers(request: Request) -> dict[str, str]:
    """Attach explicit CORS headers on unhandled 500s that bypass CORSMiddleware."""
    origin = (request.headers.get("origin") or "").strip()
    if origin and origin in CORS_ALLOWED_ORIGINS:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Expose-Headers": "X-Request-ID, X-ViRead-Version",
            "Vary": "Origin",
        }
    return {}


async def _build_unhandled_500_response(
    request: Request,
    exc: Exception,
    *,
    include_cors_headers: bool,
) -> JSONResponse:
    """Return a generic 500 error while retaining a private traceback and request ID."""
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
    headers = {
        "X-Request-ID": request_id,
        "X-ViRead-Version": get_viread_app_version(),
    }
    if include_cors_headers:
        headers.update(_cors_error_headers(request))
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
        headers=headers,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Unhandled exceptions escape CORSMiddleware via ServerErrorMiddleware; attach CORS headers."""
    return await _build_unhandled_500_response(request, exc, include_cors_headers=True)


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
        return await _build_unhandled_500_response(
            request, exc, include_cors_headers=False
        )

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
    return await _build_unhandled_500_response(
        request, exc, include_cors_headers=False
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=list(CORS_ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Request-ID",
        "X-ViRead-Version",
        "X-Resolved-Voice-Id",
        "X-Voice-Provider",
        "X-Voice-Region",
        "X-Voice-Gender",
        "X-Voice-Model-Version",
        "X-Voice-Fallback",
        "X-Voice-Fallback-Reason",
        "X-TTS-Cache",
        "X-TTS-Provider",
        "X-TTS-Scope",
        "X-TTS-Cached-Speed",
    ],
)

def _remote_ocr_health_timeout_seconds() -> float:
    raw = (os.getenv("VIREAD_HEALTH_OCR_TIMEOUT_SECONDS") or "").strip()
    if raw:
        try:
            return max(2.5, min(15.0, float(raw)))
        except ValueError:
            pass
    return 8.0


@app.get("/health", tags=["System"])
async def get_health(request: Request) -> dict[str, object]:
    """Read-only liveness/readiness check (SELECT 1 + worker states, zero secrets)."""
    workers = getattr(request.app.state, "background_workers", None) or {}
    active_model_thread = workers.get("active_model_registry")
    local_trainer = workers.get("local_trainer_process")
    worker_states = {
        "viread_ocr_outbox": _task_runtime_state(workers.get("viread_ocr_outbox")),
        "viread_ocr_training": _task_runtime_state(workers.get("viread_ocr_training")),
        "book_quality": _task_runtime_state(workers.get("book_quality")),
        "admin_ai_workflow": _task_runtime_state(workers.get("admin_ai_workflow")),
        "parent_book_submission": _task_runtime_state(workers.get("parent_book_submission")),
        "parent_email_dispatcher": _task_runtime_state(workers.get("parent_email_dispatcher")),
        "smart_studio": _task_runtime_state(workers.get("smart_studio")),
        "smart_studio_worker": _task_runtime_state(workers.get("smart_studio")),
        "local_voice_bootstrap": _task_runtime_state(workers.get("local_voice_bootstrap")),
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

    ocr_timeout = _remote_ocr_health_timeout_seconds()

    async def _probe_remote_ocr() -> dict[str, object]:
        try:
            remote_info = await asyncio.wait_for(
                collect_remote_ocr_health(), timeout=ocr_timeout
            )
            payload: dict[str, object] = {
                "mode": "remote_worker",
                "ready": bool(remote_info.get("ready", False)),
                "engines": remote_info.get("engines", {}),
                "workers": remote_info.get("workers", []),
                "queue": remote_info.get("queue", {}),
                "heartbeat_ttl_seconds": remote_info.get(
                    "heartbeat_ttl_seconds", worker_heartbeat_ttl_seconds()
                ),
            }
            if remote_info.get("probe_degraded"):
                payload["probe_degraded"] = True
            return payload
        except Exception:
            return {
                "mode": "remote_worker",
                "ready": False,
                "engines": {},
                "workers": [],
                "queue": {},
                "heartbeat_ttl_seconds": worker_heartbeat_ttl_seconds(),
                "probe_degraded": True,
            }

    async def _probe_local_ocr() -> dict[str, object]:
        try:
            ocr_items = await asyncio.wait_for(asyncio.to_thread(collect_ocr_health), timeout=2.5)
            ocr_engines = {
                item["id"]: {
                    "status": item["status"],
                    "detail_status": item["detail_status"],
                }
                for item in ocr_items
            }
            core_engines = [
                item for item in ocr_items if item["id"] in {"paddleocr", "vietocr"}
            ]
            if core_engines:
                ocr_ready = any(
                    is_ocr_engine_ready_status(item["detail_status"])
                    for item in core_engines
                )
            else:
                ocr_ready = any(
                    is_ocr_engine_ready_status(item["detail_status"])
                    for item in ocr_items
                    if item["id"] in {"paddleocr", "vietocr", "tesseract_vie"}
                )
        except Exception:
            ocr_engines = {}
            ocr_ready = False
        return {
            "mode": "local_inprocess",
            "ready": ocr_ready,
            "engines": ocr_engines,
        }

    # Run DB probe and OCR readiness probe concurrently so NullPool handshakes don't stack.
    db_probe_res, ocr_payload = await asyncio.gather(
        probe_database_connection(timeout=max(6.0, ocr_timeout)),
        _probe_remote_ocr() if is_remote_ocr_mode() else _probe_local_ocr(),
        return_exceptions=True,
    )
    if isinstance(db_probe_res, BaseException):
        db_probe: dict[str, object] = {
            "ok": False,
            "dns_resolved": False,
            "ssl_enabled": False,
            "pool_class": type(engine.pool).__name__,
            "pooler_mode": "unknown",
            "latency_ms": 0,
        }
    else:
        db_probe = db_probe_res
    if isinstance(ocr_payload, BaseException):
        ocr_payload = {
            "mode": "remote_worker" if is_remote_ocr_mode() else "local_inprocess",
            "ready": False,
            "engines": {},
            "workers": [],
            "queue": {},
            "heartbeat_ttl_seconds": worker_heartbeat_ttl_seconds(),
            "probe_degraded": True,
        }

    return {
        "status": "ok" if db_probe["ok"] else "degraded",
        "version": get_viread_app_version(),
        "ocr_mode": get_ocr_mode(),
        "database": {
            "status": "healthy" if db_probe["ok"] else "unavailable",
            "dns_resolved": db_probe["dns_resolved"],
            "ssl_enabled": db_probe["ssl_enabled"],
            "pool_class": db_probe["pool_class"],
            "pooler_mode": db_probe["pooler_mode"],
            "latency_ms": db_probe["latency_ms"],
        },
        "ocr": ocr_payload,
        "workers": worker_states,
    }


app.include_router(api_router)
