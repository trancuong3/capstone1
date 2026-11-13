from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
from contextlib import asynccontextmanager
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
from app.database.config import APP_ENVIRONMENT, CORS_ALLOWED_ORIGINS
from app.database.integrity import postgres_integrity_error_metadata
from app.database.session import DatabaseConcurrencyLimitExceeded, engine
from app.diagnostic_logging import log_diagnostic
from app.request_context import request_id_context
from app.services.ocr_engine import run_active_viread_model_worker, warmup_ocr_engines
from app.services.admin_ocr_jobs import admin_ocr_correction_jobs
from app.jobs.book_quality_worker import run_worker as run_book_quality_worker
from app.jobs.viread_ocr_outbox_worker import run_worker as run_viread_ocr_outbox_worker
from app.jobs.viread_ocr_training_auto_worker import run_worker as run_viread_ocr_training_auto_worker

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Start OCR warmup and the durable PostgreSQL book-quality worker."""
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
    if APP_ENVIRONMENT != "test" and not worker_disabled:
        book_quality_task = asyncio.create_task(
            run_book_quality_worker(stop_book_quality_worker),
            name="book_quality_scan_worker",
        )
    ocr_outbox_enabled = os.getenv("VIREAD_OCR_OUTBOX_WORKER_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}
    stop_viread_ocr_outbox = asyncio.Event()
    if APP_ENVIRONMENT != "test" and ocr_outbox_enabled:
        viread_outbox_task = asyncio.create_task(
            run_viread_ocr_outbox_worker(stop_viread_ocr_outbox),
            name="viread_ocr_verified_outbox_worker",
        )
    training_worker_enabled = os.getenv(
        "VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED", "true"
    ).strip().lower() not in {"0", "false", "no", "off"}
    stop_viread_training = asyncio.Event()
    if APP_ENVIRONMENT != "test" and training_worker_enabled:
        viread_training_task = asyncio.create_task(
            run_viread_ocr_training_auto_worker(stop_viread_training),
            name="viread_ocr_flow2_auto_training_worker",
        )

    try:
        yield
    finally:
        if active_model_worker is not None:
            stop_active_model_worker.set()
            active_model_worker.join(timeout=6)
        if viread_outbox_task is not None:
            stop_viread_ocr_outbox.set()
            try:
                await asyncio.wait_for(viread_outbox_task, timeout=10)
            except TimeoutError:
                viread_outbox_task.cancel()
                await asyncio.gather(viread_outbox_task, return_exceptions=True)
        if viread_training_task is not None:
            stop_viread_training.set()
            try:
                await asyncio.wait_for(viread_training_task, timeout=10)
            except TimeoutError:
                viread_training_task.cancel()
                await asyncio.gather(viread_training_task, return_exceptions=True)
        if book_quality_task is not None:
            stop_book_quality_worker.set()
            try:
                await asyncio.wait_for(book_quality_task, timeout=10)
            except TimeoutError:
                # The worker releases its lease on cancellation; an interrupted
                # page is resumed from its durable per-page state on the next poll.
                book_quality_task.cancel()
                await asyncio.gather(book_quality_task, return_exceptions=True)
        await admin_ocr_correction_jobs.shutdown()
        await engine.dispose()


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
    expose_headers=["X-Request-ID"],
)

app.include_router(api_router)
