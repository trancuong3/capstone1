from __future__ import annotations

import logging
import re
import time
from uuid import uuid4

from fastapi import FastAPI, HTTPException as FastAPIHTTPException, Request
from fastapi.exception_handlers import (
    http_exception_handler as default_http_exception_handler,
    request_validation_exception_handler as default_request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.router import api_router
from app.diagnostic_logging import log_diagnostic
from app.request_context import request_id_context

logger = logging.getLogger(__name__)

app = FastAPI(title="ReadAlong Vision API", version="1.0.0")


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


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)

app.include_router(api_router)
