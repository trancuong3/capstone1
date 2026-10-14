from __future__ import annotations

import logging
import time
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.router import api_router
from app.diagnostic_logging import log_diagnostic
from app.request_context import request_id_context

logger = logging.getLogger(__name__)

app = FastAPI(title="ReadAlong Vision API", version="1.0.0")


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
        path=request.url.path,
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
            path=request.url.path,
            http_status=response.status_code,
            elapsed_ms=int((time.perf_counter() - started_at) * 1000),
        )
        return response
    finally:
        request_id_context.reset(token)


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
        path=request.url.path,
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
