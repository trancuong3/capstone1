from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.services.ocr_inference_job_service import DEFAULT_LEASE_SECONDS, OcrInferenceJobService

router = APIRouter()


def require_ocr_worker_token(
    x_viread_ocr_worker_token: str | None = Header(
        default=None, alias="X-ViRead-Ocr-Worker-Token"
    ),
) -> str:
    """Verify the shared worker token in constant time without ever logging it."""
    expected = (os.getenv("VIREAD_OCR_WORKER_TOKEN") or "").strip()
    if len(expected) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Remote OCR worker token is not configured on backend.",
        )
    provided = (x_viread_ocr_worker_token or "").strip()
    if not provided:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-ViRead-Ocr-Worker-Token header.",
        )
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    provided_digest = hashlib.sha256(provided.encode("utf-8")).digest()
    if not hmac.compare_digest(expected_digest, provided_digest):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid OCR worker token.",
        )
    return "ocr_worker"


class WorkerHeartbeatRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120)
    hostname: str | None = Field(default=None, max_length=120)
    app_version: str | None = Field(default=None, max_length=64)
    git_sha: str | None = Field(default=None, max_length=64)
    status: str = Field(default="IDLE", max_length=32)
    active_job_id: UUID | None = None
    active_job_count: int = Field(default=0, ge=0, le=16)
    concurrency_limit: int = Field(default=1, ge=1, le=16)
    model_profile: str | None = Field(default=None, max_length=64)
    model_sha256: str | None = Field(default=None, max_length=64)
    engines: dict[str, Any] = Field(default_factory=dict)
    system_stats: dict[str, Any] = Field(default_factory=dict)
    last_error: str | None = Field(default=None, max_length=300)


class ClaimOcrJobRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120)
    lease_seconds: int = Field(default=DEFAULT_LEASE_SECONDS, ge=30, le=600)


class JobHeartbeatRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120)
    fencing_token: int = Field(ge=1)
    lease_seconds: int = Field(default=DEFAULT_LEASE_SECONDS, ge=30, le=600)
    phase: str | None = Field(default=None, max_length=64)


class RefreshSourceUrlRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120)
    fencing_token: int = Field(ge=1)
    expires_in: int = Field(default=300, ge=60, le=900)


class OcrWordPayload(BaseModel):
    model_config = {"extra": "allow"}

    word_index: int = Field(ge=0)
    line_index: int = Field(default=0, ge=0)
    text: str
    bbox: Any = None
    ocr_confidence: float | None = None
    ocr_review_status: str | None = None
    ocr_score_source: str | None = None


class CompleteOcrJobRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120)
    fencing_token: int = Field(ge=1)
    source_sha256: str = Field(min_length=64, max_length=64)
    full_text: str = ""
    words: list[OcrWordPayload] = Field(default_factory=list)
    ocr_meta: dict[str, Any] = Field(default_factory=dict)
    no_text_detected: bool = False
    model_profile: str | None = Field(default=None, max_length=64)
    model_sha256: str | None = Field(default=None, max_length=64)
    engine_diagnostics: dict[str, Any] = Field(default_factory=dict)
    duration_ms: int | None = Field(default=None, ge=0)


class FailOcrJobRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120)
    fencing_token: int = Field(ge=1)
    error_code: str = Field(min_length=1, max_length=72)
    error_message: str | None = Field(default=None, max_length=400)
    retryable: bool = True
    engine_diagnostics: dict[str, Any] = Field(default_factory=dict)


@router.post("/worker-heartbeat")
async def record_ocr_worker_heartbeat(
    payload: WorkerHeartbeatRequest,
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = await OcrInferenceJobService(db).record_worker_heartbeat(
        worker_id=payload.worker_id,
        hostname=payload.hostname,
        app_version=payload.app_version,
        git_sha=payload.git_sha,
        status_value=payload.status,
        active_job_id=payload.active_job_id,
        active_job_count=payload.active_job_count,
        concurrency_limit=payload.concurrency_limit,
        model_profile=payload.model_profile,
        model_sha256=payload.model_sha256,
        engines=payload.engines,
        system_stats=payload.system_stats,
        last_error=payload.last_error,
    )
    return {
        "worker_id": row.WorkerId,
        "status": row.Status,
        "last_heartbeat_at": row.LastHeartbeatAt.isoformat() if row.LastHeartbeatAt else None,
    }


@router.post("/claim")
async def claim_ocr_job(
    payload: ClaimOcrJobRequest,
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    claimed = await OcrInferenceJobService(db).claim_next_job(
        worker_id=payload.worker_id,
        lease_seconds=payload.lease_seconds,
    )
    return {"job": claimed}


@router.post("/{job_id}/heartbeat")
async def heartbeat_ocr_job(
    job_id: UUID,
    payload: JobHeartbeatRequest,
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await OcrInferenceJobService(db).heartbeat_job(
        job_id=job_id,
        worker_id=payload.worker_id,
        fencing_token=payload.fencing_token,
        lease_seconds=payload.lease_seconds,
        phase=payload.phase,
    )


@router.post("/{job_id}/refresh-source-url")
async def refresh_ocr_job_source_url(
    job_id: UUID,
    payload: RefreshSourceUrlRequest,
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await OcrInferenceJobService(db).refresh_source_url(
        job_id=job_id,
        worker_id=payload.worker_id,
        fencing_token=payload.fencing_token,
        expires_in=payload.expires_in,
    )


@router.get("/{job_id}/source")
async def download_ocr_job_source(
    job_id: UUID,
    worker_id: str = Query(min_length=1, max_length=120),
    fencing_token: int = Query(ge=1),
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    raw, mime_type = await OcrInferenceJobService(db).stream_job_source(
        job_id=job_id,
        worker_id=worker_id,
        fencing_token=fencing_token,
    )

    def _chunk_iter():
        chunk_size = 65536
        view = memoryview(raw)
        for offset in range(0, len(view), chunk_size):
            yield bytes(view[offset : offset + chunk_size])

    return StreamingResponse(
        _chunk_iter(),
        media_type=mime_type,
        headers={"Content-Length": str(len(raw))},
    )


@router.post("/{job_id}/complete")
async def complete_ocr_job(
    job_id: UUID,
    payload: CompleteOcrJobRequest,
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await OcrInferenceJobService(db).complete_job(
        job_id=job_id,
        worker_id=payload.worker_id,
        fencing_token=payload.fencing_token,
        source_sha256=payload.source_sha256,
        full_text=payload.full_text,
        words=[word.model_dump() for word in payload.words],
        ocr_meta=payload.ocr_meta,
        no_text_detected=payload.no_text_detected,
        model_profile=payload.model_profile,
        model_sha256=payload.model_sha256,
        engine_diagnostics=payload.engine_diagnostics,
        duration_ms=payload.duration_ms,
    )


@router.post("/{job_id}/fail")
async def fail_ocr_job(
    job_id: UUID,
    payload: FailOcrJobRequest,
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await OcrInferenceJobService(db).fail_job(
        job_id=job_id,
        worker_id=payload.worker_id,
        fencing_token=payload.fencing_token,
        error_code=payload.error_code,
        error_message=payload.error_message,
        retryable=payload.retryable,
        engine_diagnostics=payload.engine_diagnostics,
    )


@router.get("/active-model")
async def get_active_ocr_model_manifest(
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await OcrInferenceJobService(db).get_active_model_manifest()


@router.get("/active-model/config")
async def download_active_ocr_model_config(
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> Response:
    payload, sha = await OcrInferenceJobService(db).get_active_model_artifact_bytes(kind="config")
    return Response(
        content=payload,
        media_type="application/x-yaml",
        headers={"X-Content-Sha256": sha},
    )


@router.get("/active-model/shard/{shard_index}")
async def download_active_ocr_model_shard(
    shard_index: int,
    _: str = Depends(require_ocr_worker_token),
    db: AsyncSession = Depends(get_db),
) -> Response:
    payload, sha = await OcrInferenceJobService(db).get_active_model_artifact_bytes(
        kind="shard", shard_index=shard_index
    )
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={"X-Content-Sha256": sha},
    )
